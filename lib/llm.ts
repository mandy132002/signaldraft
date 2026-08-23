import type { LinkedInContext } from "./linkedin";
import { isSensitiveHook } from "./edge-cases";
import { mentionsCompanyExact, exactCompanyPhrase, isAmbiguousCompanyName, mentionsLinkedInWorkplace } from "./relevance";
import type { OutreachDraft, ProspectInput, Signal } from "./types";

export type HookAnalysis = {
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  sentimentWhy: string;
  businessImpact: string;
  outreachAngle: string;
  toneGuidance: string;
  riskFlags: string[];
};

export type EntityResolution = {
  matchedIds: string[];
  chosenHookId: string | null;
  note: string;
  rejected: { id: string; reason: string }[];
};

const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim() || "";
/**
 * Default + fallbacks must be IDs still listed for this key on
 * GET https://api.groq.com/openai/v1/models
 *
 * Retired (404 as of 2026-08-16 free/dev tier):
 * - llama-3.1-8b-instant
 * - llama-3.3-70b-versatile
 * - qwen/qwen3-32b
 */
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_MODEL_FALLBACKS = [
  GROQ_MODEL,
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
].filter((m, i, a) => a.indexOf(m) === i);

export function llmModelName() {
  return GROQ_MODEL;
}

export function llmModelTag() {
  return `groq:${GROQ_MODEL}`;
}

export async function llmAvailable(): Promise<boolean> {
  return Boolean(GROQ_API_KEY);
}

type GroqChatOpts = {
  maxTokens?: number;
  json?: boolean;
  reasoning?: boolean;
};

type GroqOnceResult = {
  content: string | null;
  /** Try another approach / model */
  retryable: boolean;
  /** Do not retry the same model ID (404 / decommissioned) */
  skipModel?: boolean;
  /** Brief delay before next attempt (rate limits) */
  retryAfterMs?: number;
  reason?: string;
};

function pickMessageText(message?: {
  content?: string | null;
  reasoning?: string | null;
}): string | null {
  const content = message?.content?.trim();
  if (content) return content;
  const reasoning = message?.reasoning?.trim();
  if (reasoning) {
    const extracted = extractJsonObject(reasoning);
    if (extracted) return JSON.stringify(extracted);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(res: Response, body: string): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const sec = Number(header);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(8000, Math.round(sec * 1000));
  }
  const match = body.match(/try again in ([\d.]+)s/i);
  if (match) {
    const sec = Number(match[1]);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(8000, Math.round(sec * 1000));
  }
  return 1500;
}

async function groqChatOnce(
  model: string,
  system: string,
  user: string,
  temperature: number,
  opts: GroqChatOpts = {}
): Promise<GroqOnceResult> {
  const isOss = /gpt-oss/i.test(model);
  const maxTokens = opts.maxTokens ?? (isOss ? 4096 : 1200);
  const payload: Record<string, unknown> = {
    model,
    temperature,
    max_completion_tokens: maxTokens,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (opts.json !== false) {
    payload.response_format = { type: "json_object" };
  }
  if (isOss && opts.reasoning !== false) {
    payload.reasoning_effort = "low";
    payload.include_reasoning = false;
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    const modelGone = /model_not_found|does not exist|decommissioned/i.test(text);
    const rateLimited = res.status === 429 || /rate_limit/i.test(text);
    const formatIssue = /response_format|json_object|json_validate|reasoning/i.test(text);
    console.error(`Groq error (${model})`, res.status, text);
    if (modelGone) {
      return {
        content: null,
        retryable: true,
        skipModel: true,
        reason: `model_not_found:${model}`,
      };
    }
    if (rateLimited) {
      return {
        content: null,
        retryable: true,
        retryAfterMs: parseRetryAfterMs(res, text),
        reason: "rate_limit_exceeded",
      };
    }
    return {
      content: null,
      retryable: formatIssue || res.status >= 500,
      reason: text.slice(0, 160),
    };
  }
  const json = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; reasoning?: string | null };
    }>;
  };
  const choice = json.choices?.[0];
  const content = pickMessageText(choice?.message);
  if (!content) {
    const truncated = choice?.finish_reason === "length";
    console.error(`Groq empty content (${model})`, choice?.finish_reason);
    return {
      content: null,
      retryable: true,
      reason: truncated ? "reasoning used the full token budget" : "empty model content",
    };
  }
  return { content, retryable: false };
}

async function groqChat(system: string, user: string, temperature = 0.3): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    for (const model of GROQ_MODEL_FALLBACKS) {
      const first = await groqChatOnce(model, system, user, temperature);
      if (first.content) return first.content;

      // Retired / unknown model ID — do not burn another request on the same ID
      if (first.skipModel) continue;

      if (first.retryable && first.reason === "rate_limit_exceeded") {
        await sleep(first.retryAfterMs ?? 1500);
        const afterWait = await groqChatOnce(model, system, user, temperature);
        if (afterWait.content) return afterWait.content;
        // Still limited — try the next available model
        continue;
      }

      // Empty content / JSON-mode quirks — retry same model without JSON constraint
      if (first.retryable) {
        const retry = await groqChatOnce(model, system, user, temperature, {
          json: false,
          reasoning: false,
          maxTokens: 4096,
        });
        if (retry.content) return retry.content;
        if (retry.skipModel) continue;
        if (retry.reason === "rate_limit_exceeded") {
          await sleep(retry.retryAfterMs ?? 1500);
        }
      }
    }
    return null;
  } catch (e) {
    console.error("Groq unreachable", e);
    return null;
  }
}

/** Groq chat — always asks for JSON. */
async function llmChat(system: string, user: string, temperature = 0.3): Promise<string | null> {
  return groqChat(system, user, temperature);
}

export function parseDraftConfidence(
  raw: unknown,
  why: unknown,
  fallback: "high" | "medium" | "low" = "medium"
): { confidence: "high" | "medium" | "low"; confidenceWhy?: string } {
  const value = String(raw || "").toLowerCase().trim();
  const confidence =
    value === "high" || value === "medium" || value === "low" ? value : fallback;
  const confidenceWhy = String(why || "").trim().slice(0, 220) || undefined;
  return { confidence, confidenceWhy };
}

export function capDraftConfidence(
  confidence: "high" | "medium" | "low",
  opts: { sensitive?: boolean; hold?: boolean; rewritten?: boolean }
): "high" | "medium" | "low" {
  if (opts.hold) return "low";
  if (opts.sensitive && confidence === "high") return "medium";
  if (opts.rewritten && confidence === "high") return "medium";
  return confidence;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packResearch(
  prospect: ProspectInput,
  hook: Signal,
  ranked: Signal[],
  linkedIn?: LinkedInContext | null
) {
  const companyCtx = ranked.find((s) => s.kind === "company");
  const extras = ranked.filter((s) => s.eligible && s.id !== hook.id).slice(0, 5);
  return {
    prospect: {
      name: prospect.fullName,
      title: prospect.title,
      company: prospect.company,
      notes: prospect.notes || "",
      linkedinUrl: prospect.linkedinUrl || linkedIn?.url || "",
      companyWebsite: prospect.companyWebsite || "",
    },
    linkedIn: linkedIn
      ? {
          url: linkedIn.url,
          vanity: linkedIn.vanity || "",
          profileHint: linkedIn.profileHint || "",
          headline: linkedIn.headline || "",
          about: linkedIn.about || "",
          employerHints: linkedIn.employerHints || [],
          domainHints: linkedIn.domainHints || [],
          employerMatchesCompany: linkedIn.employerMatchesCompany,
          note: linkedIn.note,
        }
      : null,
    sender: {
      name: prospect.senderName || "Alex",
      company: prospect.senderCompany || "",
      offer: prospect.senderOffer || "",
    },
    primaryHook: {
      title: hook.title,
      summary: hook.summary,
      kind: hook.kind,
      source: hook.source,
      url: hook.url,
      publishedAt: hook.publishedAt || "",
      whyKept: hook.why,
      relevance: hook.relevance,
      matchTier: hook.matchTier || "",
    },
    companySnapshot: companyCtx
      ? { title: companyCtx.title, summary: companyCtx.summary, url: companyCtx.url }
      : null,
    supportingSignals: extras.map((s) => ({
      title: s.title,
      kind: s.kind,
      summary: s.summary,
      relevance: s.relevance,
      why: s.why,
      matchTier: s.matchTier || "",
    })),
  };
}

/**
 * LLM decides which soft candidates are actually about this person/company.
 * Uses LinkedIn vanity/headline when present.
 */
export async function resolveEntities(
  prospect: ProspectInput,
  candidates: Signal[],
  linkedIn?: LinkedInContext | null
): Promise<EntityResolution | null> {
  const pool = candidates.filter((s) => s.kind !== "company").slice(0, 12);
  if (!pool.length) {
    return { matchedIds: [], chosenHookId: null, note: "No candidates to resolve.", rejected: [] };
  }

  const system = `You resolve company/person entity matches for B2B research. Return ONLY valid JSON.

CRITICAL — multi-word company names:
- Target "Cube Global" is NOT the same as "CUBE", "Cube Logic", "Cube Bikes", "Black Cube", "Hi-Cube", or Rubik's Cube.
- Require the FULL intended company name (or a clear unambiguous reference to that exact org), OR the target person clearly tied to that org.
- An all-caps brand that only shares one token (CUBE vs Cube Global) is a REJECT unless the article also says the full name.

CRITICAL — same short name / ambiguous brands (e.g. typed company is just "Cube"):
- Many unrelated orgs share names like Cube, Meta, Delta, Apex.
- LinkedIn workplace AND/OR company website domain are the source of truth for WHICH Cube.
- If LinkedIn shows employer/domain (e.g. Cube.dev, "Delivery Manager at Cube") or the SDR provided companyWebsite (e.g. https://cube.dev), KEEP only stories about that workplace/domain.
- REJECT stories about other Cubes (Cube Logistics, Rubik, crypto tickers, etc.) that do not match the LinkedIn employer or company website domain.
- If both LinkedIn and company website are missing and the company name is a single ambiguous token, prefer REJECT unless the article also names the person with that company.

Use LinkedIn vanity/headline/employerHints/domainHints and companyWebsite when provided to confirm person + workplace.
When unsure, REJECT.

PERSON vs COMPANY:
- A story about the person at a DIFFERENT employer (Jeff Bezos / Blue Origin while the target is Amazon) is a REJECT for outreach to the target company.
- Person-only items that never name the target company (or LinkedIn / website workplace alias) are REJECT.

HOOK CHOICE — you are helping an SDR sell: "${prospect.senderOffer?.trim() || "their product"}"
- chosenHookId must be a confirmed match AND the best bridge to that offer (themes, pain, timing).
- Prefer hooks where the news implies a need related to the offer over unrelated celebrity/PR fluff.
- If two hooks match equally on entity, pick the one more relevant to the offer.`;

  const user = `TARGET PERSON: ${prospect.fullName}
TARGET TITLE: ${prospect.title}
TARGET COMPANY (typed by SDR): "${prospect.company}"
${isAmbiguousCompanyName(prospect.company) ? `NOTE: "${prospect.company}" is an AMBIGUOUS short name — rely on LinkedIn workplace and/or company website domain to disambiguate.\n` : ""}COMPANY WEBSITE (SDR-provided): ${prospect.companyWebsite?.trim() || "none"}
WHAT THE SDR SELLS (use this to pick the best hook): "${prospect.senderOffer?.trim() || "unspecified product"}"
WORKPLACE CONTEXT (LinkedIn + website scrape): ${JSON.stringify(
    linkedIn
      ? {
          url: linkedIn.url,
          vanity: linkedIn.vanity,
          profileHint: linkedIn.profileHint,
          headline: linkedIn.headline,
          about: linkedIn.about,
          employerHints: linkedIn.employerHints,
          domainHints: linkedIn.domainHints,
          employerMatchesCompany: linkedIn.employerMatchesCompany,
          note: linkedIn.note,
        }
      : { url: prospect.linkedinUrl || prospect.companyWebsite || null, employerMatchesCompany: null }
  )}
SDR NOTES: ${prospect.notes || "none"}

CANDIDATE ITEMS (ids must be copied exactly):
${JSON.stringify(
  pool.map((s) => ({
    id: s.id,
    title: s.title,
    summary: (s.summary || "").slice(0, 180),
    kind: s.kind,
    matchTier: s.matchTier,
    source: s.source,
  })),
  null,
  2
)}

Return JSON:
{
  "matchedIds": ["id", "..."],
  "chosenHookId": "best single id for outreach or null",
  "note": "1 sentence on entity match AND why this hook fits the offer (mention LinkedIn / website domain if used)",
  "rejected": [{"id":"...","reason":"wrong company / unrelated person / ..."}]
}

Rules:
- matchedIds = ONLY items about THIS exact company (or LinkedIn/website-confirmed workplace alias) OR THIS person in relation to this company
- Prefer rejecting lookalikes over false positives
- chosenHookId must be in matchedIds (or null if none)
- chosenHookId should be the strongest outreach hook for selling "${prospect.senderOffer?.trim() || "the offer"}" to this person
- If nothing clearly matches "${prospect.company}" (via name, LinkedIn workplace, or company website domain), return matchedIds: [] and chosenHookId: null`;

  let raw = await llmChat(system, user, 0.1);
  if (!raw) {
    raw = await llmChat(
      `${system}\nKeep the JSON tiny: matchedIds, chosenHookId, note, rejected.`,
      user,
      0.1
    );
  }
  if (!raw) return null;
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const idSet = new Set(pool.map((s) => s.id));
  const matchedIds = Array.isArray(obj.matchedIds)
    ? obj.matchedIds.map(String).filter((id) => idSet.has(id))
    : [];
  let chosenHookId = obj.chosenHookId ? String(obj.chosenHookId) : null;
  if (chosenHookId && !matchedIds.includes(chosenHookId)) {
    chosenHookId = matchedIds[0] ?? null;
  }
  if (!chosenHookId && matchedIds.length) chosenHookId = matchedIds[0]!;

  const rejected = Array.isArray(obj.rejected)
    ? obj.rejected
        .map((r) => {
          const row = r as { id?: string; reason?: string };
          return { id: String(row.id || ""), reason: String(row.reason || "").slice(0, 160) };
        })
        .filter((r) => r.id)
        .slice(0, 12)
    : [];

  return {
    matchedIds,
    chosenHookId,
    note: String(obj.note || "LLM entity check complete.").slice(0, 400),
    rejected,
  };
}

export function applyEntityResolution(
  signals: Signal[],
  resolution: EntityResolution,
  prospect: ProspectInput,
  linkedIn?: LinkedInContext | null
): Signal[] {
  const matched = new Set(resolution.matchedIds);
  const rejectMap = new Map(resolution.rejected.map((r) => [r.id, r.reason]));
  const ambiguous = isAmbiguousCompanyName(prospect.company);

  return signals.map((s) => {
    if (s.kind === "company") {
      const ok =
        mentionsCompanyExact(s.title, prospect.company) ||
        mentionsCompanyExact(s.summary, prospect.company) ||
        mentionsLinkedInWorkplace(`${s.title} ${s.summary}`, linkedIn);
      return {
        ...s,
        eligible: false,
        why: ok
          ? "Background — company context for LLM."
          : `Background dropped — wiki/page does not clearly match "${prospect.company}".`,
      };
    }

    const text = `${s.title} ${s.summary}`;
    const hasExact = mentionsCompanyExact(text, prospect.company);
    const hasWorkplace = mentionsLinkedInWorkplace(text, linkedIn);
    const phrase = exactCompanyPhrase(prospect.company);

    // Edge cases 1+2 + same-name brands: need exact company OR LinkedIn-confirmed workplace alias
    if (matched.has(s.id) && !hasExact && !hasWorkplace) {
      return {
        ...s,
        eligible: false,
        why: `Safety net: missing exact "${phrase}"${ambiguous ? " / workplace domain" : ""} — lookalike or person/other-employer, not a sendable hook.`,
        relevance: Math.min(s.relevance, 0.15),
      };
    }

    // Ambiguous name + LinkedIn confirmed: drop matches that ignore the workplace alias
    if (
      matched.has(s.id) &&
      ambiguous &&
      linkedIn?.employerMatchesCompany === true &&
      !hasWorkplace &&
      !hasExact
    ) {
      return {
        ...s,
        eligible: false,
        why: `Safety net: ambiguous "${phrase}" without workplace/domain confirmation in the article.`,
        relevance: Math.min(s.relevance, 0.15),
      };
    }

    if (matched.has(s.id)) {
      return {
        ...s,
        eligible: true,
        why: hasWorkplace
          ? `LLM confirmed entity match (workplace / domain). ${s.why}`
          : `LLM confirmed entity match. ${s.why}`,
        relevance: Math.min(0.99, Math.max(s.relevance, hasWorkplace ? 0.62 : 0.55)),
      };
    }
    const reason = rejectMap.get(s.id);
    return {
      ...s,
      eligible: false,
      why: reason
        ? `LLM rejected: ${reason}`
        : `LLM did not confirm this is about the target company/person. (${s.matchTier || "soft"})`,
      relevance: Math.min(s.relevance, 0.2),
    };
  });
}

export async function analyzeHook(
  prospect: ProspectInput,
  hook: Signal,
  ranked: Signal[],
  linkedIn?: LinkedInContext | null
): Promise<HookAnalysis | null> {
  const pack = packResearch(prospect, hook, ranked, linkedIn);
  const system = `You are a B2B sales research analyst preparing notes for a cold email TO ${prospect.fullName} (second person: you/your).
Return ONLY valid JSON.
Hard rules:
- Use ONLY facts in the research pack about ${prospect.fullName} / ${prospect.company}.
- Never invent shared history, past jobs, meetings, or relationships between the sender and the prospect.
- Never claim the sender worked with/at the prospect's company unless the pack explicitly says so (it will not).
- Primary hook title/summary is the only news event you may reference.
- Do not bring in Amazon, Google, or other companies unless they appear in the pack for THIS prospect.
- outreachAngle and businessImpact must be usable as copy spoken TO the person — never "Colin likely oversees…" / third-person biography.`;

  const user = `Analyze this research pack for a cold email written directly TO ${prospect.fullName} (${prospect.title || "leader"} at ${prospect.company}). The sender does NOT know them personally.

RESEARCH PACK:
${JSON.stringify(pack, null, 2)}

PRIMARY HOOK (must drive the email — about ${prospect.company}):
"${hook.title}"
${hook.summary}

Return JSON:
{
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "sentimentWhy": "1 sentence on tone of the primary hook only",
  "businessImpact": "1 short sentence: what THIS hook may mean for ${prospect.company} — factual, no invented duties for ${prospect.fullName}",
  "outreachAngle": "1 sentence in SECOND PERSON (you/your) bridging THIS hook to \"${prospect.senderOffer?.trim() || "the offer"}\" — never use ${(prospect.fullName.trim().split(/\s+/)[0] || "the prospect")}'s name in third person",
  "toneGuidance": "direct, concise, peer-to-peer stranger cold email; not a dossier about the prospect",
  "riskFlags": ["e.g. third-person 'Colin likely…', wrong company, inventing their responsibilities, broken grammar"]
}`;

  const raw = await llmChat(system, user, 0.15);
  if (!raw) return null;
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const sentimentRaw = String(obj.sentiment || "neutral").toLowerCase();
  const sentiment =
    sentimentRaw === "positive" ||
    sentimentRaw === "negative" ||
    sentimentRaw === "mixed" ||
    sentimentRaw === "neutral"
      ? (sentimentRaw as HookAnalysis["sentiment"])
      : "neutral";

  const result: HookAnalysis = {
    sentiment,
    sentimentWhy: String(obj.sentimentWhy || "").slice(0, 400),
    businessImpact: String(obj.businessImpact || "").slice(0, 500),
    outreachAngle: String(obj.outreachAngle || "").slice(0, 400),
    toneGuidance: String(obj.toneGuidance || "").slice(0, 300),
    riskFlags: Array.isArray(obj.riskFlags)
      ? obj.riskFlags.map((x) => String(x).slice(0, 120)).slice(0, 5)
      : [],
  };

  if (isSensitiveHook(hook.title, hook.summary)) {
    const flags = new Set(result.riskFlags);
    flags.add("Sensitive public event — do not congratulate or treat as a win");
    result.sentiment = result.sentiment === "positive" ? "mixed" : result.sentiment;
    result.toneGuidance = result.toneGuidance
      ? `${result.toneGuidance} Stay sober; do not congratulate.`
      : "Sober and brief. Do not congratulate.";
    result.riskFlags = [...flags].slice(0, 6);
  }

  return result;
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Guarantee greeting + signature even if the model drops them. */
export function ensureGreetingAndSignature(
  body: string,
  prospect: ProspectInput
): string {
  const first = prospect.fullName.trim().split(/\s+/)[0] || prospect.fullName;
  const sender = prospect.senderName?.trim() || "Alex";
  const senderCo = prospect.senderCompany?.trim() || "";
  const greeting = `Hi ${first},`;
  const signature = senderCo ? `${sender}\n${senderCo}` : sender;

  let text = body.trim().replace(/\r\n/g, "\n");

  // Strip a broken/wrong greeting so we can re-add the canonical one
  text = text.replace(/^(hi|hello|hey|dear)\s+[^,\n]*,?\s*\n+/i, "").trim();

  // Remove trailing signature-like lines matching sender so we can re-append cleanly
  const senderEsc = escapeReg(sender);
  const coEsc = senderCo ? escapeReg(senderCo) : "";
  if (coEsc) {
    text = text.replace(new RegExp(`\\n+${senderEsc}\\s*\\n+${coEsc}\\s*$`, "i"), "").trim();
  }
  text = text.replace(new RegExp(`\\n+${senderEsc}\\s*$`, "i"), "").trim();
  text = text.replace(new RegExp(`\\n+best[,.]?\\s*\\n+${senderEsc}(?:\\s*\\n+${coEsc})?\\s*$`, "i"), "").trim();
  text = text.replace(new RegExp(`\\n+regards[,.]?\\s*\\n+${senderEsc}(?:\\s*\\n+${coEsc})?\\s*$`, "i"), "").trim();
  text = text.replace(new RegExp(`\\n+thanks[,.]?\\s*\\n+${senderEsc}(?:\\s*\\n+${coEsc})?\\s*$`, "i"), "").trim();

  return `${greeting}\n\n${text}\n\n${signature}`;
}

/** Reject hallucinated rapport / fake shared history in drafts. */
export function draftLooksHallucinated(body: string, prospect: ProspectInput): boolean {
  const first = (prospect.fullName.trim().split(/\s+/)[0] || "").toLowerCase();
  const afterHi = body
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1)
    .join(" ");
  const firstSentence = afterHi.split(/[.!?]/)[0] || "";

  if (/\b(i (used to |previously )?(work|worked|collaborat\w*) (with|alongside|for) you)\b/i.test(body)) return true;
  if (/\b(we (met|spoke|worked) (together|before))\b/i.test(body)) return true;
  if (/\b(i (built|started|began) my career)\b/i.test(body)) return true;
  if (/\b(former colleague|old friend)\b/i.test(body)) return true;
  if (/\b(when i was at your company|back when i was at)\b/i.test(body)) return true;
  if (first && new RegExp(`\\bi\\s+(?:used to\\s+)?work(?:ed)?\\s+with\\s+${escapeReg(first)}\\b`, "i").test(body)) {
    return true;
  }
  if (/\bmy career\b/i.test(firstSentence) || /\bi (?:used to )?work(?:ed)? with\b/i.test(firstSentence)) {
    return true;
  }
  return false;
}

/**
 * Reject drafts that are not a real email TO the prospect:
 * third-person bio voice, broken offer lines, "Suggest Company…" pitches.
 */
export function draftQualityFails(body: string, prospect: ProspectInput): boolean {
  const parts = prospect.fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  const content = body
    .replace(/^(hi|hello|hey|dear)\s+[^,\n]*,?\s*/i, "")
    .trim();

  // Talking ABOUT the person instead of TO them
  if (first.length >= 2) {
    if (new RegExp(`\\bAs\\s+[^,.\\n]{2,40},\\s*${escapeReg(first)}\\b`, "i").test(content)) return true;
    if (
      new RegExp(
        `\\b${escapeReg(first)}\\s+(likely|probably|oversees|manages|leads|will need|is responsible)\\b`,
        "i"
      ).test(content)
    ) {
      return true;
    }
  }
  if (last.length >= 3 && first.length >= 2) {
    if (new RegExp(`\\b${escapeReg(first)}\\s+${escapeReg(last)}\\b`, "i").test(content)) return true;
  }

  // Broken / non-email pitch patterns from the bad Cube draft
  if (/^\s*Suggest\b/im.test(content)) return true;
  if (/\bSuggest\s+[A-Z][A-Za-z0-9&.\s-]{0,40}'s\b/i.test(content)) return true;
  if (/\bWe\s+AI[- ]?enabled\b/i.test(content)) return true;
  if (/\bWe\s+[A-Z][a-z]*\s+enabled\b/i.test(content)) return true;

  // Incomplete fragment lines (e.g. "We AI enabled Agentic testing platform.")
  for (const line of content.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    if (/^We\s+[A-Z]/.test(line) && line.split(/\s+/).length <= 8 && !/\b(help|offer|build|provide|work)\b/i.test(line)) {
      return true;
    }
  }

  return false;
}

function cleanHookTokens(title: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "as", "is", "are", "this", "that", "just", "from", "about",
    "yahoo", "finance", "reuters", "bloomberg", "forbes", "techcrunch",
  ]);
  return title
    .toLowerCase()
    .replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 5 && !stop.has(t))
    .slice(0, 8);
}

function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_COMPANY_STOP.has(t));
}

const GENERIC_COMPANY_STOP = new Set([
  "inc", "llc", "ltd", "corp", "the", "and", "group", "company", "co", "plc",
]);

/** Well-known orgs models often paste from prior runs / prompt examples. */
const CROSS_COMPANY_GUARD = [
  "amazon",
  "microsoft",
  "google",
  "alphabet",
  "apple",
  "meta",
  "facebook",
  "netflix",
  "tesla",
  "nvidia",
  "openai",
  "salesforce",
  "oracle",
  "ibm",
  "walmart",
  "target",
  "shopify",
  "stripe",
  "uber",
  "airbnb",
  "samsung",
  "intel",
  "adobe",
  "cisco",
  "dell",
  "hp",
  "sony",
];

function openingContent(body: string): string {
  return body
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^hi\b/i.test(l) && !/^hello\b/i.test(l) && !/^dear\b/i.test(l))
    .join(" ");
}

function firstLineCitesHook(body: string, hook: Signal, prospect: ProspectInput): boolean {
  const content = openingContent(body).toLowerCase();
  if (!content) return false;

  const companyHit = companyTokens(prospect.company).some((t) => content.includes(t));
  const hookBits = cleanHookTokens(`${hook.title} ${hook.summary}`);
  const hookHits = hookBits.filter((t) => content.includes(t));

  // Must ground in this prospect's company OR at least 2 distinctive hook tokens
  if (companyHit && hookHits.length >= 1) return true;
  if (hookHits.length >= 2) return true;
  if (companyHit && /\b(noticed|saw|read|regarding|caught|coverage|news|announc|warns?|said|hire|launch|funding|ipo)\b/i.test(content)) {
    return true;
  }
  return false;
}

/** True if the draft names another big company that isn't this prospect / this hook. */
export function draftCrossContaminated(body: string, prospect: ProspectInput, hook: Signal): boolean {
  const text = body.toLowerCase();
  const allowed = new Set<string>([
    ...companyTokens(prospect.company),
    ...companyTokens(prospect.senderCompany || ""),
    ...cleanHookTokens(`${hook.title} ${hook.summary}`),
  ]);
  const prospectCo = prospect.company.toLowerCase();
  const hookBlob = `${hook.title} ${hook.summary}`.toLowerCase();

  for (const name of CROSS_COMPANY_GUARD) {
    if (prospectCo.includes(name)) continue;
    if (hookBlob.includes(name)) continue;
    if (allowed.has(name)) continue;
    if (new RegExp(`\\b${escapeReg(name)}\\b`, "i").test(text)) return true;
  }

  // Classic bleed from our old Amazon few-shot
  if (
    !prospectCo.includes("amazon") &&
    !hookBlob.includes("amazon") &&
    /\bamazon'?s?\b/i.test(body)
  ) {
    return true;
  }
  if (
    !prospectCo.includes("amazon") &&
    /\bnext growth pillar\b/i.test(body)
  ) {
    return true;
  }

  // Body should mention the prospect company at least once (grounding)
  if (!mentionsCompanyExact(body, prospect.company) && !companyTokens(prospect.company).some((t) => text.includes(t))) {
    return true;
  }

  return false;
}

function hookSnippet(hook: Signal, maxWords = 10): string {
  const cleaned = hook.title
    .replace(/\s+[-–|]\s+[^-–|]{2,60}$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).slice(0, maxWords);
  return words.join(" ");
}

export async function draftEmail(
  prospect: ProspectInput,
  hook: Signal,
  ranked: Signal[],
  analysis: HookAnalysis,
  linkedIn?: LinkedInContext | null
): Promise<OutreachDraft | null> {
  const first = prospect.fullName.trim().split(/\s+/)[0] || prospect.fullName;
  const sender = prospect.senderName?.trim() || "Alex";
  const senderCo = prospect.senderCompany?.trim() || "";
  const offer = prospect.senderOffer?.trim() || "our product";
  const snippet = hookSnippet(hook, 12);

  const system = `You write cold B2B emails that will be sent FROM an SDR TO one named person.
Return ONLY valid JSON.

RECIPIENT (the email is written TO this person — use you/your, never third person):
- Name: ${prospect.fullName}
- Title: ${prospect.title || "leader"}
- Company: ${prospect.company}

SENDER:
- Name: ${sender}${senderCo ? `\n- Company: ${senderCo}` : ""}
- What they sell (use as a grammatical product description, do not paste broken fragments): ${offer}

REQUIRED BODY SHAPE (real newlines in the JSON string):
1) First line exactly: Hi ${first},
2) One short hook sentence in second person about ${prospect.company} + the public hook below
3) One short sentence connecting that hook to what ${senderCo || sender} sells — second person ("you" / "your team")
4) One soft ask for a 15-minute chat
5) Signature exactly:
${sender}${senderCo ? `\n${senderCo}` : ""}

VOICE RULES (non-negotiable):
- Write TO ${first}, not ABOUT ${first}. Forbidden: "${first} likely…", "As ${prospect.title || "Delivery Manager"}, ${first}…", dossiers, analyst memos.
- Never invent ${first}'s responsibilities, org chart, or what they "will need".
- Never invent personal history with ${first}.
- Do not invent news facts beyond the primary hook.
- Do not name other employers/brands unless they appear in the primary hook or are ${prospect.company} / ${senderCo || "the sender company"}.
- Every sentence must be complete English. Forbidden: "Suggest BrowserStack's…", "We AI enabled…", truncated product lines.
- If stating the offer, write a full sentence such as "At ${senderCo || sender}, we offer ${offer}." — never "We " + a noun phrase that is not a verb phrase.`;

  const user = `Write the sendable cold email TO ${prospect.fullName} at ${prospect.company}.

PRIMARY PUBLIC HOOK (paraphrase; do not dump the full headline in quotes unless short):
Title: ${hook.title}
Summary: ${hook.summary}
Kind: ${hook.kind}

ANALYSIS (hints only — rewrite into second-person email copy; discard any third-person "likely oversees" language):
${JSON.stringify(analysis, null, 2)}

LinkedIn / website: ${linkedIn?.headline || linkedIn?.vanity || prospect.linkedinUrl || prospect.companyWebsite || "none"}

BAD (never produce this style):
"Hi Colin,

Noticed the Cube news ("…") — The announcement signals Cube is positioning…
As Delivery Manager, Colin likely oversees…
Suggest BrowserStack's AI-enabled…
We AI enabled Agentic testing platform.

Mandar
BrowserStack"

GOOD (match this shape for ${first} / ${prospect.company}):
"Hi ${first},

Noticed ${prospect.company}'s update on ${snippet} — [one sober implication for your team, second person].

At ${senderCo || sender}, we offer ${offer} — happy to show how that could help you validate reliability as those capabilities roll out.

Open to a 15-minute chat this week?

${sender}${senderCo ? `\n${senderCo}` : ""}"

More rules:
- subject: ≤6 words, natural, about ${prospect.company} (not a pasted headline)
- body ≤90 words including greeting + signature
- If sentiment is negative/mixed or the hook is sensitive: do not congratulate
- No emojis; no "I came across your profile"; no "hope this finds you well"

Return JSON only:
{"subject":"...","body":"...","confidence":"high|medium|low","confidenceWhy":"one sentence on how sure you are this email is accurate and sendable to ${first}"}

Confidence:
- high: clear company hook + natural second-person offer bridge
- medium: solid company match but thin hook or inferred bridge
- low: weak/sensitive hook or unsure entity`

  const attempt = async (extra?: string) => {
    const raw = await llmChat(system, extra ? `${user}\n\nFIX PREVIOUS OUTPUT: ${extra}` : user, 0.15);
    if (!raw) return null;
    const obj = extractJsonObject(raw);
    if (!obj?.subject || !obj?.body) return null;
    return {
      subject: String(obj.subject).slice(0, 80),
      body: ensureGreetingAndSignature(String(obj.body).trim().replace(/\\n/g, "\n"), prospect),
      ...parseDraftConfidence(obj.confidence, obj.confidenceWhy, "medium"),
    };
  };

  const needsRewrite = (body: string) =>
    draftLooksHallucinated(body, prospect) ||
    draftCrossContaminated(body, prospect, hook) ||
    draftQualityFails(body, prospect) ||
    !firstLineCitesHook(body, hook, prospect);

  let parsed = await attempt();
  if (!parsed) return null;

  let rewritten = false;
  if (needsRewrite(parsed.body)) {
    rewritten = true;
    parsed = await attempt(
      `Rewrite as a direct email TO ${first} at ${prospect.company}. Use you/your. Do NOT write "${first} likely…" or "As ${prospect.title || "their title"}, ${first}…". Opening must cite the hook (${snippet}). Offer sentence must be complete English (e.g. "At ${senderCo || sender}, we offer ${offer}."). Start with "Hi ${first}," and end with the signature.`
    );
    if (!parsed) return null;
    if (needsRewrite(parsed.body)) {
      parsed = await attempt(
        `STRICT second-person only. Forbidden phrases: "Suggest ${senderCo || "our"}", "We AI enabled", "${first} likely", "As Delivery Manager". First content sentence must include "${prospect.company}" and the hook theme.`
      );
      if (!parsed || needsRewrite(parsed.body)) return null;
    }
  }

  const sensitive = Boolean(hook.sensitive) || isSensitiveHook(hook.title, hook.summary);
  const confidence = capDraftConfidence(parsed.confidence, { sensitive, rewritten });

  return {
    subject: parsed.subject,
    body: parsed.body,
    hook: hook.title,
    confidence,
    confidenceWhy:
      parsed.confidenceWhy ||
      (sensitive
        ? "Sensitive public event — confidence capped so you review tone."
        : "Groq rated this draft against the confirmed hook."),
    usedSignalIds: [
      hook.id,
      ...ranked.filter((s) => s.eligible && s.id !== hook.id).slice(0, 2).map((s) => s.id),
    ],
    model: llmModelTag(),
    sensitiveHook: sensitive,
  };
}

/**
 * Rewrite an existing draft using SDR refinement instructions + original research context.
 */
export async function refineDraft(input: {
  prospect: ProspectInput;
  hook: Signal;
  analysis: HookAnalysis | null | undefined;
  currentSubject: string;
  currentBody: string;
  refinePrompt: string;
}): Promise<OutreachDraft | null> {
  const { prospect, hook, analysis, currentSubject, currentBody, refinePrompt } = input;
  const first = prospect.fullName.trim().split(/\s+/)[0] || prospect.fullName;
  const sender = prospect.senderName?.trim() || "Alex";
  const senderCo = prospect.senderCompany?.trim() || "";
  const offer = prospect.senderOffer?.trim() || "our product";
  const instruction = refinePrompt.trim();
  if (!instruction) return null;

  const system = `You refine cold B2B emails written TO ${prospect.fullName} (second person: you/your).
Return ONLY valid JSON with keys subject, body, confidence, confidenceWhy.
Do NOT introduce other employers unless they are ${prospect.company} or appear in the public hook.
REQUIRED:
1) First line exactly: Hi ${first},
2) Signature:
${sender}${senderCo ? `\n${senderCo}` : ""}
Write TO ${first}, never ABOUT ${first} in third person ("${first} likely…").
Keep complete grammatical sentences. Never "Suggest X's…" or "We AI enabled…".
Never invent personal history. Stay grounded in the public hook.
Apply the SDR's refinement instructions carefully.`;

  const user = `Refine this outreach email so it remains a sendable note TO ${prospect.fullName}.

TO: ${prospect.fullName}, ${prospect.title} at ${prospect.company}
FROM: ${sender}${senderCo ? ` at ${senderCo}` : ""}
OFFER (use in a full grammatical sentence): ${offer}

PUBLIC HOOK (opening must still reflect this — about ${prospect.company}):
${hook.title}
${hook.summary}

ANALYSIS (optional; convert any third-person notes into you/your):
${analysis ? JSON.stringify(analysis, null, 2) : "none"}

CURRENT EMAIL:
Subject: ${currentSubject}

${currentBody}

SDR REFINEMENT INSTRUCTIONS (priority):
${instruction}

Rules:
- subject ≤6 words; body ≤90 words; real newlines
- ALWAYS start with "Hi ${first}," and end with the signature
- Second person only after the greeting
- No fake history; no broken product fragments

Return JSON:
{"subject":"...","body":"...","confidence":"high|medium|low","confidenceWhy":"one sentence"}`;

  const raw = await llmChat(system, user, 0.2);
  if (!raw) return null;
  const obj = extractJsonObject(raw);
  if (!obj?.subject || !obj?.body) return null;

  let subject = String(obj.subject).slice(0, 80);
  let body = ensureGreetingAndSignature(String(obj.body).trim().replace(/\\n/g, "\n"), prospect);

  const bad = (b: string) =>
    draftLooksHallucinated(b, prospect) ||
    draftCrossContaminated(b, prospect, hook) ||
    draftQualityFails(b, prospect);

  if (bad(body)) {
    const retry = await llmChat(
      system,
      `${user}\n\nFIX: Second person only (you/your). Remove "${first} likely…", "Suggest…", and broken "We …" fragments. Keep "Hi ${first}," and the signature.`,
      0.15
    );
    if (!retry) return null;
    const obj2 = extractJsonObject(retry);
    if (!obj2?.subject || !obj2?.body) return null;
    subject = String(obj2.subject).slice(0, 80);
    body = ensureGreetingAndSignature(String(obj2.body).trim().replace(/\\n/g, "\n"), prospect);
    if (bad(body)) return null;
  }

  const rated = parseDraftConfidence(obj.confidence, obj.confidenceWhy, hook.relevance >= 0.75 ? "high" : "medium");
  const sensitive = Boolean(hook.sensitive) || isSensitiveHook(hook.title, hook.summary);

  return {
    subject,
    body,
    hook: hook.title,
    confidence: capDraftConfidence(rated.confidence, { sensitive }),
    confidenceWhy: rated.confidenceWhy || "Groq re-rated this draft after your refinement.",
    usedSignalIds: [hook.id],
    model: `${llmModelTag()}+refine`,
    sensitiveHook: sensitive,
  };
}

