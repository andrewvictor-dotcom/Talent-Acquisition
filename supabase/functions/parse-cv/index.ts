// Supabase Edge Function: parse-cv
// Reads one CV and returns a structured candidate profile, so HR does not type it by hand.
// Accepts the CV's extracted text, or the PDF itself (scanned CVs have no text layer).
//
// Same resilience as screen-cvs: busy errors (429/5xx) retry with backoff, then fall over
// to GEMINI_FALLBACK_MODEL or another "flash" model this key can use.
// Sensitive attributes (age, gender, religion, marital status, nationality, photo) are never extracted.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-1.5-flash";
const FALLBACK_SECRET = (Deno.env.get("GEMINI_FALLBACK_MODEL") ?? "").trim();
const API = "https://generativelanguage.googleapis.com/v1beta";
const RETRIES = 3;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_CHARS = 20000;
const MAX_FILE_B64 = 11_000_000; // ~8 MB file

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = {
  type: "OBJECT",
  properties: {
    fullName: { type: "STRING" },
    email: { type: "STRING" },
    phone: { type: "STRING" },
    city: { type: "STRING" },
    country: { type: "STRING" },
    currentTitle: { type: "STRING" },
    currentEmployer: { type: "STRING" },
    yearsExperience: { type: "NUMBER" },
    linkedin: { type: "STRING" },
    skills: { type: "ARRAY", items: { type: "STRING" } },
    languages: { type: "ARRAY", items: { type: "STRING" } },
    education: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { school: { type: "STRING" }, degree: { type: "STRING" }, field: { type: "STRING" }, year: { type: "STRING" } },
      },
    },
    experience: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { company: { type: "STRING" }, title: { type: "STRING" }, start: { type: "STRING" }, end: { type: "STRING" } },
      },
    },
    uncertain: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["fullName"],
};

const PROMPT = [
  "Extract the candidate's details from this CV for a recruiter's form.",
  "Rules:",
  "- Copy values exactly as written in the CV (names, emails, phone numbers, company names). Never invent a value; leave a field out if the CV does not state it.",
  "- phone: one number, digits with an optional leading +, no spaces.",
  "- currentTitle / currentEmployer: the most recent role (the one marked present, or the latest dates).",
  "- yearsExperience: total professional experience in years, from the dates of the roles. Leave it out if dates are missing.",
  "- linkedin: the full LinkedIn profile URL if present.",
  "- skills: at most 15, the most relevant first. languages: spoken languages with level if stated.",
  "- uncertain: names of any fields you filled but are not sure about.",
  "- Never extract or infer age, date of birth, gender, religion, marital status, nationality or photo.",
].join("\n");

class GeminiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function callModel(model: string, parts: unknown[]) {
  const res = await fetch(`${API}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new GeminiError(res.status, `gemini ${res.status} (${model}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
}

let fallbackPromise: Promise<string | null> | null = null;
function fallbackModel(): Promise<string | null> {
  if (FALLBACK_SECRET) return Promise.resolve(FALLBACK_SECRET === MODEL ? null : FALLBACK_SECRET);
  if (!fallbackPromise) {
    fallbackPromise = (async () => {
      try {
        const res = await fetch(`${API}/models?pageSize=200&key=${GEMINI_KEY}`);
        if (!res.ok) return null;
        const { models = [] } = await res.json();
        const skip = /(image|tts|audio|live|embed|vision|exp|thinking|learnlm|gemma|aqa|native)/i;
        const names: string[] = models
          .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
          .filter((n: string) => /flash/i.test(n) && !skip.test(n) && n !== MODEL);
        const ver = (n: string) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? "0");
        names.sort((a, b) =>
          (Number(/preview/i.test(a)) - Number(/preview/i.test(b))) || (ver(b) - ver(a)) ||
          (Number(/lite/i.test(a)) - Number(/lite/i.test(b))));
        return names[0] ?? null;
      } catch {
        return null;
      }
    })();
  }
  return fallbackPromise;
}

async function extract(parts: unknown[]): Promise<{ profile: any; model: string }> {
  let last: unknown = null;
  const models = [MODEL];
  for (let mi = 0; mi < 2; mi++) {
    if (mi === 1) {
      const fb = await fallbackModel();
      if (!fb) break;
      models.push(fb);
    }
    const model = models[mi];
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        return { profile: await callModel(model, parts), model };
      } catch (e) {
        last = e;
        const status = e instanceof GeminiError ? e.status : 0;
        if (status === 404) break;
        if (e instanceof GeminiError && !RETRYABLE.has(status)) throw e;
        if (attempt < RETRIES - 1) await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 400));
      }
    }
  }
  throw last ?? new Error("gemini: no model available");
}

// Tidy what the model returns so the form only ever receives plain, plausible values.
function clean(p: any) {
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, max) : []);
  const email = str(p.email, 120).toLowerCase();
  const phone = str(p.phone, 30).replace(/[^\d+]/g, "");
  let linkedin = str(p.linkedin, 200);
  if (linkedin && !/linkedin\.com/i.test(linkedin)) linkedin = "";
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = "https://" + linkedin.replace(/^\/+/, "");
  const years = Number(p.yearsExperience);
  return {
    fullName: str(p.fullName, 120),
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "",
    phone: phone.replace(/\D/g, "").length >= 7 ? phone : "",
    city: str(p.city, 80),
    country: str(p.country, 80),
    currentTitle: str(p.currentTitle, 120),
    currentEmployer: str(p.currentEmployer, 120),
    yearsExperience: Number.isFinite(years) && years > 0 && years <= 50 ? Math.round(years * 10) / 10 : null,
    linkedin,
    skills: list(p.skills, 15),
    languages: list(p.languages, 8),
    education: (Array.isArray(p.education) ? p.education : []).slice(0, 4).map((e: any) => ({
      school: str(e?.school, 120), degree: str(e?.degree, 80), field: str(e?.field, 80), year: str(e?.year, 10),
    })),
    experience: (Array.isArray(p.experience) ? p.experience : []).slice(0, 8).map((e: any) => ({
      company: str(e?.company, 120), title: str(e?.title, 120), start: str(e?.start, 20), end: str(e?.end, 20),
    })),
    uncertain: list(p.uncertain, 20),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_KEY) return json({ error: "GEMINI_API_KEY is not set on the function" }, 500);

  // Signed-in users only (verified here, as in screen-cvs).
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in required" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Sign in required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const text = String(body?.text ?? "").trim().slice(0, MAX_CHARS);
  const fileB64 = typeof body?.fileBase64 === "string" ? body.fileBase64 : "";
  const mime = body?.mimeType === "application/pdf" ? "application/pdf" : "";
  if (!text && !(fileB64 && mime)) return json({ error: "Send the CV text or the PDF file" }, 400);
  if (fileB64.length > MAX_FILE_B64) return json({ error: "File too large" }, 413);

  const parts: unknown[] = [{ text: PROMPT }];
  if (fileB64 && mime) parts.push({ inline_data: { mime_type: mime, data: fileB64 } });
  if (text) parts.push({ text: "CV TEXT:\n" + text });

  try {
    const { profile, model } = await extract(parts);
    return json({ ok: true, model, profile: clean(profile ?? {}) });
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 300) }, 502);
  }
});
