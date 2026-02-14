import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").trim();
const SUPABASE_ANON_KEY = String(Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUDIT_APP_SLUG = "audit";

const MANAGE_ROLES = new Set(["super_admin", "lawyer_admin"]);
const PROFILE_ROLES = new Set(["super_admin", "lawyer_admin", "lawyer_auditor", "user_fnu", "user_operator"]);

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function normalizeSide(value: unknown): string {
  const side = String(value || "").trim().toUpperCase();
  if (side === "OPERATOR") return "AUDITOR";
  if (side === "AUDITOR" || side === "FNU") return side;
  return "FNU";
}

function sanitizeRole(value: unknown): string {
  const role = String(value || "").trim();
  if (PROFILE_ROLES.has(role)) return role;
  return "user_fnu";
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolveCaller(origin: string, req: Request) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return { response: jsonResponse(origin, 500, { ok: false, error: "Missing Supabase env configuration" }) };
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { response: jsonResponse(origin, 401, { ok: false, error: "Missing bearer token" }) };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: userData, error: userError } = await userClient.auth.getUser();
  const callerId = userData?.user?.id || "";
  if (userError || !callerId) {
    return { response: jsonResponse(origin, 401, { ok: false, error: "Invalid auth session" }) };
  }

  const { data: callerProfile, error: profileError } = await adminClient
    .from("profiles")
    .select("id,email,role,side")
    .eq("id", callerId)
    .maybeSingle();
  if (profileError || !callerProfile) {
    return { response: jsonResponse(origin, 403, { ok: false, error: "Caller profile not found" }) };
  }
  if (!MANAGE_ROLES.has(String(callerProfile.role || ""))) {
    return { response: jsonResponse(origin, 403, { ok: false, error: "Forbidden: admin role required" }) };
  }

  return { adminClient, callerId };
}

async function getAuditAppId(adminClient: ReturnType<typeof createClient>, appSlug = AUDIT_APP_SLUG): Promise<string> {
  const { data, error } = await adminClient
    .from("tw_apps")
    .select("id,slug")
    .eq("slug", appSlug)
    .limit(1)
    .maybeSingle();
  if (error || !data?.id) throw new Error(`Audit app not found for slug=${appSlug}`);
  return String(data.id);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "*";
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return jsonResponse(origin, 405, { ok: false, error: "Method not allowed" });

  const auth = await resolveCaller(origin, req);
  if ("response" in auth) return auth.response;

  const { adminClient, callerId } = auth;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").trim();
    const appSlug = String(body?.app_slug || AUDIT_APP_SLUG).trim().toLowerCase();

    if (action === "list_users") {
      const { data, error } = await adminClient
        .from("profiles")
        .select("id,email,full_name,position,phone,company_name,role,side,is_active,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return jsonResponse(origin, 200, { ok: true, users: data || [] });
    }

    if (action === "update_profile") {
      const userId = String(body?.user_id || "").trim();
      if (!isValidUuid(userId)) return jsonResponse(origin, 400, { ok: false, error: "Invalid user_id" });

      const patch: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (body?.full_name !== undefined) patch.full_name = String(body.full_name || "").trim();
      if (body?.position !== undefined) patch.position = String(body.position || "").trim();
      if (body?.phone !== undefined) patch.phone = String(body.phone || "").trim();
      if (body?.company_name !== undefined) patch.company_name = String(body.company_name || "").trim();
      if (body?.role !== undefined) patch.role = sanitizeRole(body.role);
      if (body?.side !== undefined) patch.side = normalizeSide(body.side);
      if (body?.is_active !== undefined) patch.is_active = Boolean(body.is_active);

      const { data, error } = await adminClient
        .from("profiles")
        .update(patch)
        .eq("id", userId)
        .select("id,email,full_name,position,phone,company_name,role,side,is_active,created_at")
        .maybeSingle();
      if (error) throw error;
      return jsonResponse(origin, 200, { ok: true, user: data || null });
    }

    if (action === "list_sections") {
      const companyId = String(body?.company_id || "").trim();
      let query = adminClient
        .from("document_sections")
        .select("id,company_id,parent_section_id,code,name_pl,name_uk,order_index")
        .order("company_id", { ascending: true })
        .order("order_index", { ascending: true });
      if (companyId) query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;
      return jsonResponse(origin, 200, { ok: true, sections: data || [] });
    }

    if (action === "list_scopes") {
      const appId = await getAuditAppId(adminClient, appSlug);
      const incomingIds = Array.isArray(body?.user_ids) ? body.user_ids : [];
      const userIds = incomingIds
        .map((v: unknown) => String(v || "").trim())
        .filter((id: string) => isValidUuid(id));

      let query = adminClient
        .from("tw_folder_acl")
        .select("id,user_id,section_id,updated_at")
        .eq("app_id", appId)
        .order("updated_at", { ascending: false });
      if (userIds.length > 0) query = query.in("user_id", userIds);
      const { data, error } = await query;
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];

      const grouped = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const userId = String(row.user_id || "");
        if (!userId) continue;
        if (!grouped.has(userId)) grouped.set(userId, []);
        grouped.get(userId)?.push(row);
      }

      const resultIds = userIds.length > 0 ? userIds : Array.from(grouped.keys());
      const scopes = resultIds.map((userId) => {
        const list = grouped.get(userId) || [];
        if (list.length === 0) {
          return { user_id: userId, mode: "all", section_id: null, acl_count: 0 };
        }
        const first = list[0];
        return {
          user_id: userId,
          mode: "single",
          section_id: String(first.section_id || ""),
          acl_count: list.length,
        };
      });

      return jsonResponse(origin, 200, { ok: true, scopes });
    }

    if (action === "set_scope") {
      const appId = await getAuditAppId(adminClient, appSlug);
      const userId = String(body?.user_id || "").trim();
      const mode = String(body?.mode || "all").trim().toLowerCase();
      const sectionId = String(body?.section_id || "").trim();

      if (!isValidUuid(userId)) return jsonResponse(origin, 400, { ok: false, error: "Invalid user_id" });
      if (!["all", "single"].includes(mode)) {
        return jsonResponse(origin, 400, { ok: false, error: "mode must be all or single" });
      }
      if (mode === "single" && !isValidUuid(sectionId)) {
        return jsonResponse(origin, 400, { ok: false, error: "section_id required for mode=single" });
      }

      const { error: clearError } = await adminClient
        .from("tw_folder_acl")
        .delete()
        .eq("user_id", userId)
        .eq("app_id", appId);
      if (clearError) throw clearError;

      if (mode === "single") {
        const { error: insertError } = await adminClient
          .from("tw_folder_acl")
          .insert({
            user_id: userId,
            app_id: appId,
            section_id: sectionId,
            can_view: true,
            can_comment: true,
            can_upload: true,
            can_manage: false,
            created_by: callerId,
            updated_at: new Date().toISOString(),
          });
        if (insertError) throw insertError;
      }

      return jsonResponse(origin, 200, {
        ok: true,
        scope: { user_id: userId, mode, section_id: mode === "single" ? sectionId : null },
      });
    }

    return jsonResponse(origin, 400, { ok: false, error: "Unsupported action" });
  } catch (error) {
    return jsonResponse(origin, 500, { ok: false, error: String(error) });
  }
});
