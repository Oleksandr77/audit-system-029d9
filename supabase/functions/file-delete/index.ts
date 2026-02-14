import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/+$/g, "");

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

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim(),
  );
}

function normalizeSide(side: string) {
  const s = String(side || "").trim().toUpperCase();
  if (s === "OPERATOR") return "AUDITOR";
  return s || "FNU";
}

function isIgnorableSchemaError(message: string) {
  return /does not exist|column .* does not exist|relation .* does not exist|schema cache/i.test(message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  if (!SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !SUPABASE_URL) {
    return json(500, { ok: false, error: "missing_supabase_env" });
  }

  const runId = crypto.randomUUID();
  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    return json(401, { ok: false, error: "missing_authorization", run_id: runId });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const fileId = String(body?.file_id || "").trim();
  const fallbackFilePath = String(body?.file_path || "").trim();
  if (!isUuid(fileId)) {
    return json(400, { ok: false, error: "invalid_file_id", run_id: runId });
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const userId = userData?.user?.id || "";
  if (userErr || !userId) {
    return json(401, { ok: false, error: String(userErr?.message || "invalid_session"), run_id: runId });
  }

  const { data: profile, error: profileErr } = await adminClient
    .from("profiles")
    .select("id,role,side")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr || !profile) {
    return json(403, { ok: false, error: "profile_not_found", run_id: runId });
  }

  const { data: fileRow, error: fileErr } = await adminClient
    .from("document_files")
    .select("id,document_id,file_path,uploaded_by")
    .eq("id", fileId)
    .maybeSingle();
  if (fileErr) {
    return json(500, { ok: false, error: String(fileErr.message || "file_query_failed"), run_id: runId });
  }
  if (!fileRow?.id) {
    return json(404, { ok: false, error: "file_not_found", run_id: runId });
  }

  const { data: docRow } = await adminClient
    .from("documents")
    .select("id,section_id")
    .eq("id", String(fileRow.document_id || ""))
    .maybeSingle();
  const sectionId = String(docRow?.section_id || "").trim();

  const role = String(profile.role || "").trim();
  const side = normalizeSide(String(profile.side || ""));
  const isAdmin = role === "super_admin" || role === "lawyer_admin";
  let canDelete = isAdmin || String(fileRow.uploaded_by || "") === userId;

  if (!canDelete && side === "FNU" && sectionId) {
    const { data: appRows } = await adminClient
      .from("tw_apps")
      .select("id")
      .eq("slug", "audit")
      .limit(1);
    const appId = Array.isArray(appRows) && appRows[0]?.id ? String(appRows[0].id) : "";

    if (appId) {
      const { data: aclAnyRows } = await adminClient
        .from("tw_folder_acl")
        .select("id")
        .eq("user_id", userId)
        .eq("app_id", appId)
        .limit(1);
      const aclEnabled = Array.isArray(aclAnyRows) && aclAnyRows.length > 0;
      if (!aclEnabled) {
        canDelete = true;
      } else {
        const { data: aclRow } = await adminClient
          .from("tw_folder_acl")
          .select("can_manage")
          .eq("user_id", userId)
          .eq("app_id", appId)
          .eq("section_id", sectionId)
          .maybeSingle();
        canDelete = Boolean(aclRow?.can_manage);
      }
    }
  }

  if (!canDelete) {
    return json(403, {
      ok: false,
      error: "forbidden_delete_file",
      run_id: runId,
      file_id: fileId,
      document_id: fileRow.document_id,
      section_id: sectionId,
    });
  }

  const cleanupWarnings: string[] = [];

  const deleteAccess = await adminClient.from("document_access").delete().eq("file_id", fileId);
  if (deleteAccess.error && !isIgnorableSchemaError(String(deleteAccess.error.message || ""))) {
    cleanupWarnings.push(`document_access=${String(deleteAccess.error.message || "delete_failed")}`);
  }

  const deleteVersions = await adminClient.from("document_file_versions").delete().eq("file_id", fileId);
  if (deleteVersions.error && !isIgnorableSchemaError(String(deleteVersions.error.message || ""))) {
    cleanupWarnings.push(`document_file_versions=${String(deleteVersions.error.message || "delete_failed")}`);
  }

  const deleteFileComments = await adminClient.from("comments").delete().eq("file_id", fileId);
  if (deleteFileComments.error && !isIgnorableSchemaError(String(deleteFileComments.error.message || ""))) {
    cleanupWarnings.push(`comments_file_id=${String(deleteFileComments.error.message || "delete_failed")}`);
  }

  const deletePrefixedComments = await adminClient
    .from("comments")
    .delete()
    .eq("document_id", String(fileRow.document_id || ""))
    .ilike("content", `[file:${fileId}]%`);
  if (deletePrefixedComments.error && !isIgnorableSchemaError(String(deletePrefixedComments.error.message || ""))) {
    cleanupWarnings.push(`comments_fallback_prefix=${String(deletePrefixedComments.error.message || "delete_failed")}`);
  }

  const deleteMainRow = await adminClient.from("document_files").delete().eq("id", fileId);
  if (deleteMainRow.error) {
    return json(500, {
      ok: false,
      error: String(deleteMainRow.error.message || "document_file_delete_failed"),
      run_id: runId,
      cleanup_warnings: cleanupWarnings,
    });
  }

  const storagePath = String(fileRow.file_path || fallbackFilePath || "").trim();
  let storageError = "";
  if (storagePath) {
    const removeStorage = await adminClient.storage.from("documents").remove([storagePath]);
    if (removeStorage.error && !/not found/i.test(String(removeStorage.error.message || ""))) {
      storageError = String(removeStorage.error.message || "storage_remove_failed");
    }
  }

  return json(200, {
    ok: true,
    deleted: true,
    file_id: fileId,
    run_id: runId,
    storage_error: storageError || null,
    cleanup_warnings: cleanupWarnings,
  });
});

