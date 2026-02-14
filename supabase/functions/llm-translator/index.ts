import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Language = "pl" | "uk";
type Mode = "translate" | "suggest";
type SupabaseClientLike = ReturnType<typeof createClient> | null;
const TRANSLATE_RATE_LIMIT_ENABLED =
  String(Deno.env.get("TRANSLATE_RATE_LIMIT_ENABLED") || "false").toLowerCase() === "true";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeLang(value: unknown): Language | null {
  if (value === "pl" || value === "uk") return value;
  return null;
}

function extractModelText(raw: any): string {
  if (typeof raw?.output_text === "string" && raw.output_text.trim()) {
    return raw.output_text.trim();
  }

  const outputParts = Array.isArray(raw?.output) ? raw.output : [];
  const collected: string[] = [];
  for (const block of outputParts) {
    const content = Array.isArray(block?.content) ? block.content : [];
    for (const part of content) {
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      if (text) collected.push(text);
    }
  }
  if (collected.length > 0) return collected.join("\n").trim();

  // Fallback for legacy chat-completions-like payloads
  const legacy = raw?.choices?.[0]?.message?.content;
  return typeof legacy === "string" ? legacy.trim() : "";
}

function safeTrim(input: string, max = 2000): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSuggestions(rawText: string): string[] {
  const trimmed = rawText.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => String(v).trim())
        .filter(Boolean)
        .slice(0, 3);
    }
  } catch {
    // Fallback below.
  }

  return trimmed
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getTtlCutoffIso(mode: Mode): string {
  const now = Date.now();
  const suggestTtlMinutes = Number(Deno.env.get("SUGGEST_CACHE_TTL_MINUTES") || "20");
  const translateTtlHours = Number(Deno.env.get("TRANSLATE_CACHE_TTL_HOURS") || "720");
  const ttlMs = mode === "suggest"
    ? Math.max(1, suggestTtlMinutes) * 60_000
    : Math.max(1, translateTtlHours) * 3_600_000;
  return new Date(now - ttlMs).toISOString();
}

function getSupabaseClient(req: Request): SupabaseClientLike {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !supabaseAnonKey || !authHeader?.startsWith("Bearer ")) return null;

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
}

async function getCacheHit(
  supabase: SupabaseClientLike,
  hash: string,
  mode: Mode,
): Promise<string | null> {
  if (!supabase) return null;

  const cutoff = getTtlCutoffIso(mode);
  const { data, error } = await supabase
    .from("translation_cache")
    .select("result_text, hit_count")
    .eq("hash", hash)
    .eq("mode", mode)
    .gte("updated_at", cutoff)
    .maybeSingle();

  if (error || !data?.result_text) return null;

  // Non-blocking hit counter update.
  supabase
    .from("translation_cache")
    .update({ hit_count: (data.hit_count || 0) + 1, updated_at: new Date().toISOString() })
    .eq("hash", hash)
    .then(() => undefined);

  return String(data.result_text);
}

async function putCache(
  supabase: SupabaseClientLike,
  payload: {
    hash: string;
    mode: Mode;
    source_language?: string | null;
    target_language?: string | null;
    input_text: string;
    context_text?: string | null;
    result_text: string;
  },
) {
  if (!supabase) return;
  await supabase.from("translation_cache").upsert({
    ...payload,
    updated_at: new Date().toISOString(),
  });
}

function getOpenAiModelCandidates(): string[] {
  const primary = String(Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini").trim();
  const fallbackRaw = String(Deno.env.get("OPENAI_FALLBACK_MODELS") || "gpt-4o-mini").trim();
  const fallback = fallbackRaw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return Array.from(new Set([primary, ...fallback]));
}

function isRetryableOpenAiError(message: string): boolean {
  return /status=429|status=5\d\d|timeout|timed out|network|connection/i.test(message);
}

async function callOpenAI(prompt: string, temperature = 0.1, modelOverride?: string): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = String(modelOverride || Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini").trim();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature,
      max_output_tokens: 512,
    }),
  });

  if (!response.ok) {
    const errorText = safeTrim(await response.text(), 800);
    throw new Error(`OpenAI request failed: model=${model} status=${response.status} body=${errorText}`);
  }

  const data = await response.json();
  const text = extractModelText(data);
  if (!text) throw new Error(`OpenAI returned empty response for model=${model}`);
  return text;
}

async function callOpenAIWithRetry(prompt: string, temperature = 0.1): Promise<{ text: string; model: string }> {
  const models = getOpenAiModelCandidates();
  let lastError: Error | null = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await callOpenAI(prompt, temperature, model);
        return { text, model };
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        lastError = error instanceof Error ? error : new Error(message);
        const shouldRetry = isRetryableOpenAiError(message) && attempt < 2;
        if (shouldRetry) {
          const backoffMs = 300 * Math.pow(2, attempt);
          await sleep(backoffMs);
          continue;
        }
        break;
      }
    }
  }

  throw new Error(`OpenAI retries exhausted: ${String(lastError?.message || "unknown_error")}`);
}

async function checkAndLogLlmRateLimit(supabase: SupabaseClientLike, mode: Mode) {
  if (!supabase) {
    return { allowed: true };
  }

  const { data: allowed, error: checkError } = await supabase.rpc("check_llm_rate_limit", {
    p_mode: mode,
  });

  if (checkError) {
    return { allowed: false, error: `Rate limit check failed: ${checkError.message}` };
  }

  if (!allowed) {
    return { allowed: false, error: "LLM rate limit exceeded / Ліміт LLM вичерпано" };
  }

  const { error: logError } = await supabase.rpc("log_llm_request", { p_mode: mode });
  if (logError) {
    return { allowed: false, error: `Rate limit log failed: ${logError.message}` };
  }

  return { allowed: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  try {
    const body = await req.json();
    const mode = body?.mode as Mode;
    const strict = body?.strict === true;
    const text = safeTrim(String(body?.text || ""), 2000);
    const context = safeTrim(String(body?.context || ""), 3000);

    const supabase = getSupabaseClient(req);

    if (!text) return jsonResponse(400, { error: "text is required" });
    if (mode !== "translate" && mode !== "suggest") {
      return jsonResponse(400, { error: "mode must be translate or suggest" });
    }

    if (mode === "translate") {
      const source = normalizeLang(body?.source_language);
      const target = normalizeLang(body?.target_language);
      if (!source || !target) return jsonResponse(400, { error: "source/target must be pl or uk" });
      if (source === target) return jsonResponse(200, { translated_text: text, source_language: source, target_language: target });

      const cacheHash = await sha256Hex(`translate|${source}|${target}|${text}`);
      const cached = await getCacheHit(supabase, cacheHash, "translate");
      if (cached) {
        return jsonResponse(200, {
          translated_text: cached,
          source_language: source,
          target_language: target,
          provider: "cache",
        });
      }

      if (TRANSLATE_RATE_LIMIT_ENABLED) {
        const rateResult = await checkAndLogLlmRateLimit(supabase, mode);
        if (!rateResult.allowed) {
          return jsonResponse(429, { error: rateResult.error });
        }
      }

      const prompt =
        `${strict ? "STRICT MODE. " : ""}` +
        "You are a translator only.\n" +
        `Task: translate from ${source} to ${target}.\n` +
        "Rules:\n" +
        "- Output only translated text.\n" +
        "- Do not add explanations.\n" +
        "- Keep names, dates, numbers and punctuation exact when possible.\n" +
        "- Preserve legal/business meaning exactly.\n\n" +
        `Input:\n${text}`;

      const llmResult = await callOpenAIWithRetry(prompt, 0.05);
      const translatedText = safeTrim(llmResult.text, 3000);
      await putCache(supabase, {
        hash: cacheHash,
        mode: "translate",
        source_language: source,
        target_language: target,
        input_text: text,
        result_text: translatedText || text,
      });
      return jsonResponse(200, {
        translated_text: translatedText || text,
        source_language: source,
        target_language: target,
        provider: `openai:${llmResult.model}`,
      });
    }

    const language = normalizeLang(body?.language) || "uk";
    const maxItems = Math.min(Math.max(Number(body?.max_items || 3), 1), 3);
    const cacheHash = await sha256Hex(`suggest|${language}|${text}|${context}`);
    const cachedSuggest = await getCacheHit(supabase, cacheHash, "suggest");
    if (cachedSuggest) {
      const parsed = parseSuggestions(cachedSuggest).slice(0, maxItems);
      return jsonResponse(200, {
        suggestions: parsed,
        language,
        provider: "cache",
      });
    }

    const rateResult = await checkAndLogLlmRateLimit(supabase, mode);
    if (!rateResult.allowed) {
      return jsonResponse(429, { error: rateResult.error });
    }

    const prompt =
      `${strict ? "STRICT MODE. " : ""}` +
      "You are a text-completion assistant for chat.\n" +
      `Language: ${language}.\n` +
      `Return ONLY a JSON array with ${maxItems} short continuation options.\n` +
      "No explanations, no markdown, no numbering.\n" +
      "Each option should be concise and natural.\n" +
      (context ? `Context:\n${context}\n\n` : "\n") +
      `Prefix:\n${text}`;

    const llmResult = await callOpenAIWithRetry(prompt, 0.2);
    const modelText = llmResult.text;
    const suggestions = parseSuggestions(modelText);
    await putCache(supabase, {
      hash: cacheHash,
      mode: "suggest",
      source_language: language,
      target_language: null,
      input_text: text,
      context_text: context || null,
      result_text: JSON.stringify(suggestions),
    });
    return jsonResponse(200, {
      suggestions: suggestions.slice(0, maxItems),
      language,
      provider: `openai:${llmResult.model}`,
    });
  } catch (error) {
    return jsonResponse(500, { error: String(error) });
  }
});
