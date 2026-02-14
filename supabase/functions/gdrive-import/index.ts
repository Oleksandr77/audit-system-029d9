import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Body = {
  import_type?: "folder" | "file";
  source_url?: string;
  folder_url?: string;
  file_url?: string;
  company_id?: string;
  section_id?: string;
  target_document_id?: string;
  create_subfolder?: boolean;
  subfolder_name?: string;
};

const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") || "";
const PROJECT_SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/+$/g, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function parseFolderId(input: string) {
  const raw = String(input || "").trim();
  const matchA = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (matchA?.[1]) return matchA[1];
  const matchB = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchB?.[1]) return matchB[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;
  return "";
}

function parseFileId(input: string) {
  const raw = String(input || "").trim();
  const matchA = raw.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (matchA?.[1]) return matchA[1];
  const matchB = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchB?.[1]) return matchB[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;
  return "";
}

function sanitizeName(value: string) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 140);
}

function sanitizeStorageName(value: string) {
  const base = String(value || "file")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents/diacritics
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return base || `file-${Date.now()}`;
}

function detectFileTypeFromName(fileName: string) {
  const name = String(fileName || "").trim();
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx >= name.length - 1) return "bin";
  const ext = name.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "bin";
}

function resolveProjectSupabaseUrl(reqUrl: string) {
  if (PROJECT_SUPABASE_URL) return PROJECT_SUPABASE_URL;
  const req = new URL(reqUrl);
  const host = req.hostname.toLowerCase();
  if (host.endsWith(".functions.supabase.co")) {
    const plainHost = host.replace(".functions.supabase.co", ".supabase.co");
    return `https://${plainHost}`;
  }
  return req.origin;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const norm = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
    const jsonText = atob(norm + pad);
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function toStorageObjectUrl(supabaseUrl: string, bucket: string, objectPath: string) {
  const safeBucket = encodeURIComponent(String(bucket || "").trim());
  const safePath = String(objectPath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${supabaseUrl}/storage/v1/object/${safeBucket}/${safePath}`;
}

async function uploadWithStorageRest(params: {
  supabaseUrl: string;
  bucket: string;
  objectPath: string;
  body: Blob | Uint8Array;
  contentType: string;
  bearerToken: string;
  apiKey: string;
  upsert?: boolean;
}) {
  const uploadUrl = toStorageObjectUrl(params.supabaseUrl, params.bucket, params.objectPath);
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.bearerToken}`,
      apikey: params.apiKey,
      "x-upsert": String(params.upsert ?? true),
      "Content-Type": params.contentType || "application/octet-stream",
    },
    body: params.body,
  });
  if (res.ok) {
    return { ok: true, error: "" };
  }
  const raw = await res.text().catch(() => "");
  let parsedMessage = "";
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    parsedMessage = String(parsed?.message || parsed?.error || parsed?.msg || "");
  } catch {
    parsedMessage = "";
  }
  const reason = parsedMessage || raw || `status_${res.status}`;
  return { ok: false, error: reason };
}

async function uploadToDocumentsBucket(params: {
  adminClient: ReturnType<typeof createClient>;
  userClient: ReturnType<typeof createClient> | null;
  runtimeSupabaseUrl: string;
  storagePath: string;
  fileBody: Blob | Uint8Array;
  contentType: string;
  accessToken: string;
  pushTrace: (msg: string) => void;
}) {
  const attempts: string[] = [];
  const ensureBucket = await params.adminClient.storage.createBucket("documents", { public: false });
  if (ensureBucket.error && !/already exists/i.test(String(ensureBucket.error.message || ""))) {
    attempts.push(`bucket_ensure=${String(ensureBucket.error.message || "bucket_create_failed")}`);
    params.pushTrace(`upload_warn=bucket_ensure err=${String(ensureBucket.error.message || "bucket_create_failed")}`);
  }

  const signed = await params.adminClient.storage.from("documents").createSignedUploadUrl(params.storagePath, { upsert: true });
  if (!signed.error && signed.data?.token) {
    const signedUpload = await params.adminClient.storage
      .from("documents")
      .uploadToSignedUrl(params.storagePath, signed.data.token, params.fileBody, {
        contentType: params.contentType,
        upsert: true,
      });
    if (!signedUpload.error) {
      params.pushTrace(`upload_ok=signed_service_role path=${params.storagePath}`);
      return { ok: true, error: "", strategy: "signed_service_role" };
    }
    attempts.push(`signed_service_role=${String(signedUpload.error.message || "upload_failed")}`);
    params.pushTrace(`upload_fail=signed_service_role path=${params.storagePath} err=${String(signedUpload.error.message || "upload_failed")}`);
  } else {
    attempts.push(`signed_service_role_token=${String(signed.error?.message || "token_create_failed")}`);
    params.pushTrace(`upload_fail=signed_service_role_token path=${params.storagePath} err=${String(signed.error?.message || "token_create_failed")}`);
  }

  const adminSdk = await params.adminClient.storage.from("documents").upload(params.storagePath, params.fileBody, {
    contentType: params.contentType,
    upsert: true,
  });
  if (!adminSdk.error) {
    params.pushTrace(`upload_ok=sdk_service_role path=${params.storagePath}`);
    return { ok: true, error: "", strategy: "sdk_service_role" };
  }
  attempts.push(`sdk_service_role=${String(adminSdk.error.message || "upload_failed")}`);
  params.pushTrace(`upload_fail=sdk_service_role path=${params.storagePath} err=${String(adminSdk.error.message || "upload_failed")}`);

  if (params.userClient) {
    const userSdk = await params.userClient.storage.from("documents").upload(params.storagePath, params.fileBody, {
      contentType: params.contentType,
      upsert: true,
    });
    if (!userSdk.error) {
      params.pushTrace(`upload_ok=sdk_user path=${params.storagePath}`);
      return { ok: true, error: "", strategy: "sdk_user" };
    }
    attempts.push(`sdk_user=${String(userSdk.error.message || "upload_failed")}`);
    params.pushTrace(`upload_fail=sdk_user path=${params.storagePath} err=${String(userSdk.error.message || "upload_failed")}`);
  } else {
    attempts.push("sdk_user=disabled_missing_anon_key");
    params.pushTrace("upload_skip=sdk_user missing SUPABASE_ANON_KEY");
  }

  const adminRest = await uploadWithStorageRest({
    supabaseUrl: params.runtimeSupabaseUrl,
    bucket: "documents",
    objectPath: params.storagePath,
    body: params.fileBody,
    contentType: params.contentType,
    bearerToken: SERVICE_ROLE_KEY,
    apiKey: SERVICE_ROLE_KEY,
    upsert: true,
  });
  if (adminRest.ok) {
    params.pushTrace(`upload_ok=rest_service_role path=${params.storagePath}`);
    return { ok: true, error: "", strategy: "rest_service_role" };
  }
  attempts.push(`rest_service_role=${adminRest.error || "upload_failed"}`);
  params.pushTrace(`upload_fail=rest_service_role path=${params.storagePath} err=${adminRest.error || "upload_failed"}`);

  if (SUPABASE_ANON_KEY) {
    const userRest = await uploadWithStorageRest({
      supabaseUrl: params.runtimeSupabaseUrl,
      bucket: "documents",
      objectPath: params.storagePath,
      body: params.fileBody,
      contentType: params.contentType,
      bearerToken: params.accessToken,
      apiKey: SUPABASE_ANON_KEY,
      upsert: true,
    });
    if (userRest.ok) {
      params.pushTrace(`upload_ok=rest_user path=${params.storagePath}`);
      return { ok: true, error: "", strategy: "rest_user" };
    }
    attempts.push(`rest_user=${userRest.error || "upload_failed"}`);
    params.pushTrace(`upload_fail=rest_user path=${params.storagePath} err=${userRest.error || "upload_failed"}`);
  } else {
    attempts.push("rest_user=disabled_missing_anon_key");
    params.pushTrace("upload_skip=rest_user missing SUPABASE_ANON_KEY");
  }

  return { ok: false, error: attempts.join(" ; "), strategy: "none" };
}

async function getUserViaAuthApi(params: {
  supabaseUrl: string;
  accessToken: string;
  apiKey: string;
}) {
  const res = await fetch(`${params.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      apikey: params.apiKey,
    },
  });
  const raw = await res.text().catch(() => "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg = String(parsed?.msg || parsed?.message || parsed?.error || raw || `status_${res.status}`);
    return { ok: false, error: msg, user: null };
  }
  return { ok: true, error: "", user: parsed };
}

Deno.serve(async (req) => {
  const runId = crypto.randomUUID();
  const trace: string[] = [];
  const pushTrace = (msg: string) => {
    trace.push(`${new Date().toISOString()} | ${msg}`);
    if (trace.length > 80) trace.shift();
  };
  pushTrace("start");
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const requestOrigin = new URL(req.url).origin;
    const runtimeSupabaseUrl = resolveProjectSupabaseUrl(req.url);
    pushTrace(`request_origin=${requestOrigin}`);
    pushTrace(`project_url=${runtimeSupabaseUrl}`);
    if (!runtimeSupabaseUrl || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Function env is not configured", run_id: runId, trace });
    }
    if (!GOOGLE_API_KEY) {
      return json(400, { ok: false, error: "GOOGLE_API_KEY is not configured", run_id: runId, trace });
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json(401, { ok: false, error: "Missing bearer token", run_id: runId, trace });
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!accessToken || accessToken.split(".").length !== 3) {
      return json(401, { ok: false, error: "Invalid JWT format", run_id: runId, trace });
    }
    pushTrace("jwt_parsed");

    const runtimeRef = new URL(runtimeSupabaseUrl).hostname.split(".")[0] || "";
    const isLikelyJwt = SERVICE_ROLE_KEY.split(".").length === 3;
    if (isLikelyJwt) {
      const servicePayload = decodeJwtPayload(SERVICE_ROLE_KEY);
      const serviceRef = String(servicePayload?.ref || "");
      const serviceRole = String(servicePayload?.role || "");
      if (serviceRole && serviceRole !== "service_role") {
        return json(500, { ok: false, error: "Configured secret is not a service role key", run_id: runId, trace });
      }
      if (serviceRef && runtimeRef && serviceRef !== runtimeRef) {
        return json(500, {
          ok: false,
          error: `Service role key project mismatch: key ref=${serviceRef}, runtime ref=${runtimeRef}`,
          run_id: runId,
          trace,
        });
      }
    }

    const inboundApiKey = String(req.headers.get("apikey") || "").trim();
    const anonApiKey = SUPABASE_ANON_KEY || inboundApiKey;

    const adminClient = createClient(runtimeSupabaseUrl, SERVICE_ROLE_KEY);
    const userClient = anonApiKey
      ? createClient(runtimeSupabaseUrl, anonApiKey, {
          global: { headers: { Authorization: `Bearer ${accessToken}` } },
        })
      : null;
    const probe = await adminClient.from("profiles").select("id").limit(1);
    if (probe.error) {
      return json(500, {
        ok: false,
        error: `Invalid service role secret for this project: ${probe.error.message}`,
        run_id: runId,
        trace,
      });
    }
    pushTrace("service_role_db_probe_ok");

    const { data: callerUserData, error: callerErr } = await adminClient.auth.getUser(accessToken);
    let caller = callerUserData?.user || null;
    if (callerErr || !caller) {
      pushTrace(`caller_lookup_admin_failed=${String(callerErr?.message || "unknown_error")}`);
      if (!inboundApiKey && !SUPABASE_ANON_KEY) {
        return json(401, { ok: false, error: callerErr?.message || "Unauthorized", run_id: runId, trace });
      }
      const fallbackApiKey = inboundApiKey || SUPABASE_ANON_KEY;
      const fallback = await getUserViaAuthApi({
        supabaseUrl: runtimeSupabaseUrl,
        accessToken,
        apiKey: fallbackApiKey,
      });
      if (!fallback.ok) {
        return json(401, { ok: false, error: fallback.error || callerErr?.message || "Unauthorized", run_id: runId, trace });
      }
      const fallbackUser = (fallback.user || {}) as Record<string, unknown>;
      const fallbackId = String(fallbackUser.id || "");
      if (!fallbackId) {
        return json(401, { ok: false, error: "Unauthorized", run_id: runId, trace });
      }
      caller = {
        id: fallbackId,
        email: String(fallbackUser.email || ""),
      } as { id: string; email?: string };
      pushTrace("caller_lookup_fallback_auth_api_ok");
    }
    pushTrace(`caller_ok=${caller.id}`);

    const adminProbe = await adminClient.auth.admin.getUserById(caller.id);
    if (adminProbe.error) {
      return json(500, {
        ok: false,
        error: `SERVICE_ROLE_KEY is invalid for admin operations: ${adminProbe.error.message}`,
        run_id: runId,
        trace,
      });
    }

    const { data: profile } = await adminClient
      .from("profiles")
      .select("id,role,side,is_active")
      .eq("id", caller.id)
      .single();
    if (!profile?.is_active) return json(403, { ok: false, error: "Inactive profile", run_id: runId, trace });
    pushTrace(`profile_ok role=${String(profile.role || "")} side=${String(profile.side || "")}`);

    let { data: buckets, error: bucketErr } = await adminClient.storage.listBuckets();
    if (bucketErr) return json(500, { ok: false, error: `Storage buckets read failed: ${bucketErr.message}`, run_id: runId, trace });
    let hasDocumentsBucket = Array.isArray(buckets) && buckets.some((b) => String((b as Record<string, unknown>)?.id || "") === "documents");
    if (!hasDocumentsBucket) {
      const createBucket = await adminClient.storage.createBucket("documents", { public: false });
      const createErr = String(createBucket.error?.message || "");
      if (createBucket.error && !/already exists/i.test(createErr)) {
        return json(500, { ok: false, error: `Storage bucket 'documents' create failed: ${createErr}`, run_id: runId, trace });
      }
      const listedAgain = await adminClient.storage.listBuckets();
      buckets = listedAgain.data || buckets;
      hasDocumentsBucket =
        Array.isArray(buckets) && buckets.some((b) => String((b as Record<string, unknown>)?.id || "") === "documents");
    }
    if (!hasDocumentsBucket) {
      return json(500, { ok: false, error: "Storage bucket 'documents' not found after recovery attempt", run_id: runId, trace });
    }
    pushTrace("bucket_documents_found");

    // NOTE: no global preflight upload here.
    // Storage RLS in this project may restrict allowed object key prefixes.
    // We validate write access on real import paths per-file below.

    const body = (await req.json().catch(() => ({}))) as Body;
    const importTypeRaw = String(body.import_type || "").trim().toLowerCase();
    const sourceUrlRaw = String(body.source_url || body.folder_url || body.file_url || "").trim();
    const folderId = parseFolderId(sourceUrlRaw);
    const fileId = parseFileId(sourceUrlRaw);
    const importType: "folder" | "file" =
      importTypeRaw === "file" ? "file" : importTypeRaw === "folder" ? "folder" : sourceUrlRaw.includes("/file/") ? "file" : "folder";
    let companyId = String(body.company_id || "").trim();
    const sectionId = String(body.section_id || "").trim();
    const targetDocumentId = String(body.target_document_id || "").trim();
    const createSubfolder = Boolean(body.create_subfolder);
    const subfolderName = sanitizeName(String(body.subfolder_name || ""));

    const missing: string[] = [];
    if (!sourceUrlRaw) missing.push("source_url");
    if (!sectionId) missing.push("section_id");
    if (missing.length) {
      return json(400, { ok: false, error: `${missing.join(", ")} are required`, run_id: runId, trace });
    }
    if (importType === "folder" && !folderId) {
      return json(400, { ok: false, error: "Invalid folder URL/ID. Provide Google Drive folder link (drive/folders/...) or folder ID.", run_id: runId, trace });
    }
    if (importType === "file" && !fileId) {
      return json(400, { ok: false, error: "Invalid file URL/ID. Provide Google Drive file link (file/d/...) or file ID.", run_id: runId, trace });
    }
    if (createSubfolder && !subfolderName) {
      return json(400, { ok: false, error: "subfolder_name is required when create_subfolder=true", run_id: runId, trace });
    }
    if (targetDocumentId && createSubfolder) {
      return json(400, { ok: false, error: "target_document_id cannot be used with create_subfolder=true", run_id: runId, trace });
    }
    pushTrace(`input_ok import_type=${importType} section_id=${sectionId}`);

    // Resolve company from section if company_id is not provided by client.
    if (!companyId && sectionId) {
      const { data: secForCompany } = await adminClient
        .from("document_sections")
        .select("company_id")
        .eq("id", sectionId)
        .single();
      companyId = String(secForCompany?.company_id || "").trim();
    }
    if (!companyId) {
      return json(400, { ok: false, error: "company_id is required (or resolvable from section_id)", run_id: runId, trace });
    }
    pushTrace(`company_ok=${companyId}`);

    let targetSectionId = sectionId;
    if (targetDocumentId) {
      const { data: existingDoc, error: existingDocErr } = await adminClient
        .from("documents")
        .select("id,section_id")
        .eq("id", targetDocumentId)
        .single();
      if (existingDocErr || !existingDoc?.id) {
        return json(400, { ok: false, error: "target_document_id not found", run_id: runId, trace });
      }
      if (String(existingDoc.section_id || "") !== sectionId) {
        return json(400, { ok: false, error: "target_document_id does not belong to section_id", run_id: runId, trace });
      }
      targetSectionId = String(existingDoc.section_id);
      pushTrace(`target_document_ok=${targetDocumentId}`);
    }
    if (createSubfolder) {
      const { data: parentSection } = await adminClient
        .from("document_sections")
        .select("id,company_id,order_index")
        .eq("id", sectionId)
        .single();
      if (!parentSection || parentSection.company_id !== companyId) {
        return json(400, { ok: false, error: "Invalid parent section", run_id: runId, trace });
      }
      const code = `GD-${Date.now().toString().slice(-5)}`;
      const { data: newSection, error: sectionErr } = await adminClient
        .from("document_sections")
        .insert({
          company_id: companyId,
          parent_section_id: sectionId,
          code,
          name_pl: subfolderName,
          name_uk: subfolderName,
          order_index: Number(parentSection.order_index || 0) + 1,
          created_by: caller.id,
        })
        .select("id")
        .single();
      if (sectionErr || !newSection?.id) {
        return json(500, { ok: false, error: sectionErr?.message || "Failed to create subfolder", run_id: runId, trace });
      }
      targetSectionId = newSection.id;
      pushTrace(`subfolder_created=${targetSectionId}`);
    }

    let allowed: Array<Record<string, unknown>> = [];
    if (importType === "folder") {
      const listUrl = `https://www.googleapis.com/drive/v3/files?q='${encodeURIComponent(folderId)}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=1000&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
      const listRes = await fetch(listUrl);
      const listJson = await listRes.json().catch(() => ({}));
      if (!listRes.ok) {
        return json(400, { ok: false, error: listJson?.error?.message || "Failed to list Google Drive folder", run_id: runId, trace });
      }
      const files = Array.isArray(listJson.files) ? listJson.files : [];
      allowed = files.filter((f: Record<string, unknown>) => String(f.mimeType || "") !== "application/vnd.google-apps.folder");
    } else {
      const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
      const metaRes = await fetch(metaUrl);
      const metaJson = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok) {
        return json(400, { ok: false, error: metaJson?.error?.message || "Failed to read Google Drive file", run_id: runId, trace });
      }
      if (String(metaJson?.mimeType || "") === "application/vnd.google-apps.folder") {
        return json(400, { ok: false, error: "Provided URL points to a folder. Choose import type 'folder'.", run_id: runId, trace });
      }
      allowed = [metaJson];
    }
    pushTrace(`allowed_files=${allowed.length}`);
    const scanned = allowed.length;
    let imported = 0;
    let skipped = 0;
    const skippedSamples: Array<{ id: string; name: string; reason: string }> = [];

    for (const f of allowed) {
      const fileId = String(f.id || "");
      const fileName = sanitizeName(String(f.name || "file")) || `file-${Date.now()}`;
      const storageFileName = sanitizeStorageName(fileName);
      if (!fileId) {
        skipped += 1;
        if (skippedSamples.length < 20) skippedSamples.push({ id: "", name: fileName, reason: "missing_file_id" });
        continue;
      }

      const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`);
      if (!fileRes.ok) {
        const errJson = await fileRes.json().catch(() => ({}));
        skipped += 1;
        if (skippedSamples.length < 20) {
          skippedSamples.push({
            id: fileId,
            name: fileName,
            reason: `google_download_failed: ${String(errJson?.error?.message || `status_${fileRes.status}`)}`,
          });
        }
        continue;
      }
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      const contentType = fileRes.headers.get("content-type") || "application/octet-stream";
      const fileSize = Number(bytes.byteLength || bytes.length || 0);
      const fileType = detectFileTypeFromName(fileName);

      const usesExistingDocument = Boolean(targetDocumentId);
      const docId = usesExistingDocument ? targetDocumentId : crypto.randomUUID();
      if (!usesExistingDocument) {
        const docCode = `GD-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 8)}`;
        const { error: docInsertErr } = await adminClient
          .from("documents")
          .insert({
            id: docId,
            section_id: targetSectionId,
            code: docCode,
            name_pl: fileName,
            name_uk: fileName,
            status: "pending",
            order_index: imported + 1,
            created_by: caller.id,
          });
        if (docInsertErr) {
          skipped += 1;
          if (skippedSamples.length < 20) {
            skippedSamples.push({
              id: fileId,
              name: fileName,
              reason: `document_insert_failed: ${String(docInsertErr.message || "insert_failed")} | section_id=${targetSectionId}`,
            });
          }
          continue;
        }
      }
      // Keep the same storage key shape as the working in-app uploader:
      // `${document.id}/${safeFileName}`
      const storagePath = `${docId}/${storageFileName}`;

      const uploadResult = await uploadToDocumentsBucket({
        adminClient,
        userClient,
        runtimeSupabaseUrl,
        storagePath,
        fileBody: bytes,
        contentType,
        accessToken,
        pushTrace,
      });
      if (!uploadResult.ok) {
        if (!usesExistingDocument) {
          await adminClient.from("documents").delete().eq("id", docId);
        }
        skipped += 1;
        if (skippedSamples.length < 20) {
          skippedSamples.push({
            id: fileId,
            name: fileName,
            reason: `storage_upload_failed: ${String(uploadResult.error || "upload_failed")} | bucket=documents | path=${storagePath}`,
          });
        }
        continue;
      }
      pushTrace(`storage_uploaded strategy=${uploadResult.strategy} path=${storagePath}`);

      const { error: fileRowErr } = await adminClient.from("document_files").insert({
        document_id: docId,
        file_name: fileName,
        file_path: storagePath,
        file_size: fileSize,
        file_type: fileType,
        mime_type: contentType,
        uploaded_by: caller.id,
      });
      if (fileRowErr) {
        await adminClient.storage.from("documents").remove([storagePath]);
        if (!usesExistingDocument) {
          await adminClient.from("documents").delete().eq("id", docId);
        }
        skipped += 1;
        if (skippedSamples.length < 20) {
          skippedSamples.push({
            id: fileId,
            name: fileName,
            reason: `document_file_insert_failed: ${String(fileRowErr.message || "document_file_create_failed")} | path=${storagePath}`,
          });
        }
        continue;
      }
      imported += 1;
    }

    await adminClient.from("audit_log").insert({
      user_id: caller.id,
      action: "gdrive_import",
      entity_type: "section",
      entity_id: targetSectionId,
      details: {
        import_type: importType,
        source_url: sourceUrlRaw,
        folder_id: importType === "folder" ? folderId : null,
        file_id: importType === "file" ? fileId : null,
        scanned,
        imported,
        skipped,
        skipped_samples: skippedSamples,
        target_document_id: targetDocumentId || null,
        create_subfolder: createSubfolder,
        subfolder_name: subfolderName || null,
      },
    });

    return json(200, {
      ok: true,
      run_id: runId,
      trace,
      import_type: importType,
      scanned,
      imported,
      skipped,
      skipped_samples: skippedSamples,
      target_section_id: targetSectionId,
      target_document_id: targetDocumentId || null,
    });
  } catch (e) {
    pushTrace(`fatal_error=${String(e?.message || e)}`);
    return json(500, { ok: false, error: String(e?.message || e), run_id: runId, trace });
  }
});
