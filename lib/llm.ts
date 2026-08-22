import type { LinkedInContext } from "./linkedin";
import { isSensitiveHook } from "./edge-cases";
import { mentionsCompanyExact, exactCompanyPhrase } from "./relevance";
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
/** llama-3.1-8b-instant was retired on Groq 2026-08-16 → use gpt-oss-20b */
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_MODEL_FALLBACKS = [
  GROQ_MODEL,
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
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

async function groqChatOnce(
  model: string,
  system: string,
  user: string,
  temperature: number
): Promise<{ content: string | null; retryable: boolean }> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    const modelGone = /model_not_found|does not exist|decommissioned/i.test(text);
    console.error(`Groq error (${model})`, res.status, text);
    return { content: null, retryable: modelGone };
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return { content: json.choices?.[0]?.message?.content ?? null, retryable: false };
}

async function groqChat(system: string, user: string, temperature = 0.3): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    for (const model of GROQ_MODEL_FALLBACKS) {
      const { content, retryable } = await groqChatOnce(model, system, user, temperature);
      if (content) return content;
      if (!retryable) break;
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
    },
    linkedIn: linkedIn
      ? {
          url: linkedIn.url,
          vanity: linkedIn.vanity || "",
          profileHint: linkedIn.profileHint || "",
          headline: linkedIn.headline || "",
          about: linkedIn.about || "",
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
  const pool = candidates.filter((s) => s.kind !== "company").slice(0, 18);
  if (!pool.length) {
    return { matchedIds: [], chosenHookId: null, note: "No candidates to resolve.", rejected: [] };
  }

  const system = `You resolve company/person entity matches for B2B research. Return ONLY valid JSON.

CRITICAL — multi-word company names:
- Target "Cube Global" is NOT the same as "CUBE", "Cube Logic", "Cube Bikes", "Black Cube", "Hi-Cube", or Rubik's Cube.
- Require the FULL intended company name (or a clear unambiguous reference to that exact org), OR the target person clearly tied to that org.
- An all-caps brand that only shares one token (CUBE vs Cube Global) is a REJECT unless the article also says the full name.

Use LinkedIn vanity/headline when provided to confirm the person identity.
When unsure, REJECT.

PERSON vs COMPANY:
- A story about the person at a DIFFERENT employer (Jeff Bezos / Blue Origin while the target is Amazon) is a REJECT for outreach to the target company.
- Person-only items that never name the target company are REJECT.

HOOK CHOICE — you are helping an SDR sell: "${prospect.senderOffer?.trim() || "their product"}"
- chosenHookId must be a confirmed match AND the best bridge to that offer (themes, pain, timing).
- Prefer hooks where the news implies a need related to the offer over unrelated celebrity/PR fluff.
- If two hooks match equally on entity, pick the one more relevant to the offer.`;

  const user = `TARGET PERSON: ${prospect.fullName}
TARGET TITLE: ${prospect.title}
TARGET COMPANY (intended, exact): "${prospect.company}"
WHAT THE SDR SELLS (use this to pick the best hook): "${prospect.senderOffer?.trim() || "unspecified product"}"
LINKEDIN: ${JSON.stringify(
    linkedIn
      ? {
          url: linkedIn.url,
          vanity: linkedIn.vanity,
          profileHint: linkedIn.profileHint,
          headline: linkedIn.headline,
          about: linkedIn.about,
        }
      : { url: prospect.linkedinUrl || null }
  )}
SDR NOTES: ${prospect.notes || "none"}

CANDIDATE ITEMS (ids must be copied exactly):
${JSON.stringify(
  pool.map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    kind: s.kind,
    matchTier: s.matchTier,
    source: s.source,
    relevance: s.relevance,
  })),
  null,
  2
)}

Return JSON:
{
  "matchedIds": ["id", "..."],
  "chosenHookId": "best single id for outreach or null",
  "note": "1 sentence on entity match AND why this hook fits the offer",
  "rejected": [{"id":"...","reason":"wrong company / unrelated person / ..."}]
}

Rules:
- matchedIds = ONLY items about THIS exact company OR THIS person in relation to this company
- Prefer rejecting lookalikes over false positives
- chosenHookId must be in matchedIds (or null if none)
- chosenHookId should be the strongest outreach hook for selling "${prospect.senderOffer?.trim() || "the offer"}" to this person
- If nothing clearly matches "${prospect.company}", return matchedIds: [] and chosenHookId: null`;

  const raw = await llmChat(system, user, 0.1);
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
  prospect: ProspectInput
): Signal[] {
  const matched = new Set(resolution.matchedIds);
  const rejectMap = new Map(resolution.rejected.map((r) => [r.id, r.reason]));

  return signals.map((s) => {
    if (s.kind === "company") {
      const ok =
        mentionsCompanyExact(s.title, prospect.company) ||
        mentionsCompanyExact(s.summary, prospect.company);
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
    const phrase = exactCompanyPhrase(prospect.company);

    // Edge cases 1+2: a sendable hook must name this exact company.
    // Person-only (other employer) and token lookalikes stay out of the draft.
    if (matched.has(s.id) && !hasExact) {
      return {
        ...s,
        eligible: false,
        why: `Safety net: missing exact "${phrase}" — lookalike or person/other-employer, not a sendable hook.`,
        relevance: Math.min(s.relevance, 0.15),
      };
    }

    if (matched.has(s.id)) {
      return {
        ...s,
        eligible: true,
        why: `LLM confirmed entity match. ${s.why}`,
        relevance: Math.min(0.99, Math.max(s.relevance, 0.55)),
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
  const system = `You are a B2B sales research analyst for cold outreach.
Return ONLY valid JSON.
Hard rules:
- Use ONLY facts in the research pack about ${prospect.fullName} / ${prospect.company}.
- Never invent shared history, past jobs, meetings, or relationships between the sender and the prospect.
- Never claim the sender worked with/at the prospect's company unless the pack explicitly says so (it will not).
- Primary hook title/summary is the only news event you may reference.
- Do not bring in Amazon, Google, or other companies unless they appear in the pack for THIS prospect.`;

  const user = `Analyze this research pack for a cold email to ${prospect.fullName} at ${prospect.company} (sender does NOT know the prospect personally).

RESEARCH PACK:
${JSON.stringify(pack, null, 2)}

PRIMARY HOOK (must drive the email — about ${prospect.company}):
"${hook.title}"
${hook.summary}

Return JSON:
{
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "sentimentWhy": "1 sentence on tone of the primary hook only",
  "businessImpact": "1-2 sentences: likely implication of THIS hook for ${prospect.company} / role — no invented history",
  "outreachAngle": "1 sentence: concrete bridge from THIS hook to selling \"${prospect.senderOffer?.trim() || "the offer"}\" — must sound natural for a stranger",
  "toneGuidance": "tone for a stranger sending cold email (e.g. respectful, pragmatic, not congratulatory if negative)",
  "riskFlags": ["things to avoid in the email, e.g. fake personal connection, wrong company"]
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

  const system = `You write cold B2B outreach emails for an SDR who does NOT know the prospect.
Return ONLY valid JSON.
THIS EMAIL IS ONLY ABOUT: ${prospect.fullName} at ${prospect.company}.
You may name ${prospect.company} and ${senderCo || "the sender's company"}. Do NOT name any other employer or brand unless it appears in the PRIMARY HOOK below.
REQUIRED IN EVERY BODY (non-negotiable):
1) First line MUST be exactly: Hi ${first},
2) Last lines MUST be the signature:
${sender}${senderCo ? `\n${senderCo}` : ""}
ABSOLUTE PROHIBITIONS:
- Never invent that the sender worked with, met, knew, or shared history with the prospect.
- Never invent past employment at the prospect's company.
- Never write "I worked with {prospect}" or "built my career on…".
- Never flatter with fake personal anecdotes.
- Never reuse examples about Amazon, Google, or any other company from training/memory.
- The sender is a stranger. The ONLY personalization is the public hook about ${prospect.company}.
- Do not invent news facts beyond the primary hook.
- Never omit the greeting or the signature.`;

  const user = `Write a cold email from ${sender}${senderCo ? ` at ${senderCo}` : ""} to ${prospect.fullName} (${prospect.title || "leader"} at ${prospect.company}).

PROSPECT COMPANY (only company to cite in the hook sentence): ${prospect.company}
WHAT WE SELL: ${offer}

PRIMARY PUBLIC HOOK — ground the opening in THIS story only (paraphrase; do not paste the full headline):
Title: ${hook.title}
Summary: ${hook.summary}
Kind: ${hook.kind}

ANALYSIS (implication + tone only — still about ${prospect.company}, never invent history):
${JSON.stringify(analysis, null, 2)}

LinkedIn (identity only): ${linkedIn?.headline || linkedIn?.vanity || prospect.linkedinUrl || "none"}

EXACT STRUCTURE for body (real newlines in the JSON string):
Hi ${first},

<ONE sentence starting with Saw/Noticed/Read/Re: that mentions ${prospect.company} and this hook ("${snippet}…"). NEVER mention a different company.>

<ONE sentence: how ${offer} could matter for their role at ${prospect.company} given THAT hook.>

<ONE soft ask for a 15-minute chat.>

${sender}${senderCo ? `\n${senderCo}` : ""}

More rules:
- subject: ≤6 words, natural, about ${prospect.company} — not a news headline dump
- body ≤90 words (greeting + signature still required)
- ALWAYS start with "Hi ${first}," and ALWAYS end with the signature above
- If sentiment is negative/mixed OR the hook is a layoff/lawsuit/death/investigation: do not congratulate, do not treat it as a win, keep the note brief and respectful
- No emojis; no "I came across your profile"; no "hope this finds you well"
- FORBIDDEN opening: anything about Amazon's "growth pillar" unless the prospect company is Amazon and the hook is about that

BAD (forbidden):
"I worked with Jeff Bezos at Amazon…"
"Noticed your comments on Amazon's next growth pillar…" (when writing to anyone not at Amazon)

GOOD shape (use ${prospect.company} + THIS hook — do not copy other brands):
"Hi ${first},

Noticed ${prospect.company}'s recent ${hook.kind} coverage around ${snippet} — [one sober implication].

[how ${offer} could help in that context.]

Open to a 15-minute chat this week?

${sender}${senderCo ? `\n${senderCo}` : ""}"

Return JSON only: {"subject":"...","body":"..."}`;

  const attempt = async (extra?: string) => {
    const raw = await llmChat(system, extra ? `${user}\n\nFIX PREVIOUS OUTPUT: ${extra}` : user, 0.15);
    if (!raw) return null;
    const obj = extractJsonObject(raw);
    if (!obj?.subject || !obj?.body) return null;
    return {
      subject: String(obj.subject).slice(0, 80),
      body: ensureGreetingAndSignature(String(obj.body).trim().replace(/\\n/g, "\n"), prospect),
    };
  };

  const needsRewrite = (body: string) =>
    draftLooksHallucinated(body, prospect) ||
    draftCrossContaminated(body, prospect, hook) ||
    !firstLineCitesHook(body, hook, prospect);

  let parsed = await attempt();
  if (!parsed) return null;

  if (needsRewrite(parsed.body)) {
    parsed = await attempt(
      `Wrong company or ignored hook. Rewrite ONLY about ${prospect.fullName} at ${prospect.company}. Opening MUST cite this hook: "${snippet}". Do NOT mention Amazon or any other company unless it is ${prospect.company} or appears in the hook. MUST start with "Hi ${first}," and end with the signature.`
    );
    if (!parsed) return null;
    if (needsRewrite(parsed.body)) {
      // Second hard retry
      parsed = await attempt(
        `STRICT: First content sentence must include the word "${prospect.company}" and reference the hook theme. Zero other employer names.`
      );
      if (!parsed || needsRewrite(parsed.body)) return null;
    }
  }

  const sensitive = Boolean(hook.sensitive) || isSensitiveHook(hook.title, hook.summary);
  const baseConfidence = hook.relevance >= 0.75 ? "high" : hook.relevance >= 0.55 ? "medium" : "low";

  return {
    subject: parsed.subject,
    body: parsed.body,
    hook: hook.title,
    confidence: sensitive && baseConfidence === "high" ? "medium" : baseConfidence,
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

  const system = `You refine cold B2B outreach emails for an SDR.
Return ONLY valid JSON with keys subject and body.
THIS EMAIL IS ONLY ABOUT: ${prospect.fullName} at ${prospect.company}.
Do NOT introduce Amazon, Google, or any other employer unless it is ${prospect.company} or appears in the public hook.
REQUIRED IN EVERY BODY (non-negotiable):
1) First line MUST be exactly: Hi ${first},
2) Last lines MUST be the signature:
${sender}${senderCo ? `\n${senderCo}` : ""}
Keep it a cold email from a stranger — never invent personal history with the prospect.
Apply the SDR's refinement instructions carefully while staying grounded in the public hook.
Do not invent news facts beyond the hook.
Never omit the greeting or the signature.`;

  const user = `Refine this outreach email.

TO: ${prospect.fullName}, ${prospect.title} at ${prospect.company}
FROM: ${sender}${senderCo ? ` at ${senderCo}` : ""}
OFFER: ${offer}

PUBLIC HOOK (must still be reflected in the opening — about ${prospect.company}):
${hook.title}
${hook.summary}

ANALYSIS (optional context):
${analysis ? JSON.stringify(analysis, null, 2) : "none"}

CURRENT EMAIL:
Subject: ${currentSubject}

${currentBody}

SDR REFINEMENT INSTRUCTIONS (follow these — this is the priority change request):
${instruction}

Rules:
- subject ≤6 words; body ≤90 words; real newlines
- ALWAYS start body with exactly "Hi ${first},"
- ALWAYS end body with signature:
${sender}${senderCo ? `\n${senderCo}` : ""}
- First content sentence should still reference the public hook AND ${prospect.company}
- Incorporate the refinement (tone, angle, CTA, length, emphasis, etc.)
- No fake "I worked with…" / career autobiography
- No other-company bleed (no Amazon growth pillar unless this prospect is Amazon)
- No emojis; no "I came across your profile"

Return JSON: {"subject":"...","body":"..."}`;

  const raw = await llmChat(system, user, 0.2);
  if (!raw) return null;
  const obj = extractJsonObject(raw);
  if (!obj?.subject || !obj?.body) return null;

  let subject = String(obj.subject).slice(0, 80);
  let body = ensureGreetingAndSignature(String(obj.body).trim().replace(/\\n/g, "\n"), prospect);

  const bad = (b: string) =>
    draftLooksHallucinated(b, prospect) || draftCrossContaminated(b, prospect, hook);

  if (bad(body)) {
    const retry = await llmChat(
      system,
      `${user}\n\nFIX: Remove invented history and any wrong company names. Keep only ${prospect.company} + the public hook. Keep "Hi ${first}," and the signature.`,
      0.15
    );
    if (!retry) return null;
    const obj2 = extractJsonObject(retry);
    if (!obj2?.subject || !obj2?.body) return null;
    subject = String(obj2.subject).slice(0, 80);
    body = ensureGreetingAndSignature(String(obj2.body).trim().replace(/\\n/g, "\n"), prospect);
    if (bad(body)) return null;
  }

  return {
    subject,
    body,
    hook: hook.title,
    confidence: hook.relevance >= 0.75 ? "high" : "medium",
    usedSignalIds: [hook.id],
    model: `${llmModelTag()}+refine`,
  };
}

