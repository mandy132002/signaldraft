import { isSensitiveHook } from "./edge-cases";
import {
  analyzeHook,
  applyEntityResolution,
  draftEmail,
  llmAvailable,
  llmModelName,
  resolveEntities,
  type HookAnalysis,
} from "./llm";
import type { LinkedInContext } from "./linkedin";
import { offerFit } from "./offer";
import { mentionsCompanyExact, pickHook, type RankedSignal } from "./relevance";
import type { OutreachDraft, ProspectInput, Signal } from "./types";

export type { HookAnalysis };

function firstName(full: string) {
  return full.trim().split(/\s+/)[0] ?? full;
}

function cleanHeadline(title: string) {
  return title
    .replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortHook(title: string, max = 90) {
  const t = cleanHeadline(title);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function subjectFromHook(prospect: ProspectInput, hook: Signal): string {
  const headline = cleanHeadline(hook.title);
  if (hook.kind === "funding" && /\bipo\b/i.test(headline)) return `${prospect.company} IPO`;
  if (hook.kind === "funding") return `${prospect.company} funding`;
  if (hook.kind === "hiring") return `${prospect.company} hiring`;
  if (hook.kind === "leadership") return `${prospect.company} leadership`;
  if (/\bstock sale|sell .+ (shares|stock)|filed to sell\b/i.test(headline)) {
    return `${firstName(prospect.fullName)} / ${prospect.company}`;
  }
  if (hook.kind === "product") {
    const short = headline.split(/\s+/).slice(0, 5).join(" ");
    return short || prospect.company;
  }
  return `Quick note — ${prospect.company}`;
}

function isSafeSendableHook(signal: Signal, prospect: ProspectInput): boolean {
  if (!signal.eligible || signal.kind === "company") return false;
  return mentionsCompanyExact(`${signal.title} ${signal.summary}`, prospect.company);
}

/** Merge LLM entity choice with offer-aware ranking. */
function selectHook(
  signals: Signal[],
  prospect: ProspectInput,
  preferredId?: string | null
): Signal | undefined {
  const ranked = signals as RankedSignal[];
  const preferred = preferredId
    ? ranked.find((s) => s.id === preferredId && isSafeSendableHook(s, prospect))
    : undefined;
  const best = pickHook(ranked, prospect);
  if (!preferred) return best;
  if (!best || preferred.id === best.id) return preferred;

  const prefFit = offerFit(`${preferred.title} ${preferred.summary}`, prospect.senderOffer).points;
  const bestFit = offerFit(`${best.title} ${best.summary}`, prospect.senderOffer).points;

  if (bestFit >= prefFit + 0.1 || best.relevance >= preferred.relevance + 0.12) {
    return best;
  }
  return preferred;
}

export function noHookDraft(prospect: ProspectInput): OutreachDraft {
  const sender = prospect.senderName?.trim() || "Alex";
  return {
    subject: "HOLD — no confirmed hook",
    body: `HOLD — do not send.

No public signal could be confirmed as being about ${prospect.fullName} at ${prospect.company}. Better to hold than invent a hook or email a lookalike company.

If you have a source, add a LinkedIn URL or a note and run again.

— ${sender} (internal)`,
    hook: "No confirmed entity match",
    confidence: "low",
    confidenceWhy: "No confirmed person+company hook — this is a hold, not a sendable email.",
    usedSignalIds: [],
    model: "hold",
    hold: true,
    holdReason: `No exact public match for ${prospect.fullName} at ${prospect.company}.`,
  };
}

function heuristicDraft(prospect: ProspectInput, hook: Signal, analysis?: HookAnalysis | null): OutreachDraft {
  const sender = prospect.senderName?.trim() || "Alex";
  const senderCo = prospect.senderCompany?.trim() || "";
  const offer = prospect.senderOffer?.trim();
  const fromLine = senderCo ? `${sender}\n${senderCo}` : sender;
  const name = firstName(prospect.fullName);
  const bit = shortHook(hook.title, 100);

  const sensitive = Boolean(hook.sensitive) || isSensitiveHook(hook.title, hook.summary);
  const sentiment = sensitive
    ? analysis?.sentiment === "negative"
      ? "negative"
      : "mixed"
    : analysis?.sentiment ?? "neutral";
  const lead =
    sentiment === "negative" || sentiment === "mixed"
      ? `Hi ${name},\n\nSaw the recent coverage on ${prospect.company} ("${bit}") — ${analysis?.businessImpact || "wanted to be thoughtful about timing"}.`
      : sentiment === "positive"
        ? `Hi ${name},\n\nNoticed the ${prospect.company} news ("${bit}") — ${analysis?.businessImpact || "looks like a meaningful moment"}.`
        : `Hi ${name},\n\nRe: ${prospect.company} — "${bit}". ${analysis?.businessImpact || ""}`.trim();

  const angle =
    analysis?.outreachAngle ||
    (offer
      ? `Given that, ${offer} may be relevant for you as ${prospect.title || "a leader"} there.`
      : `Thought it was worth a short note given your role.`);

  const offerLine =
    offer && !angle.toLowerCase().includes(offer.toLowerCase().slice(0, 20)) ? `We ${offer}.` : "";

  const body = `${lead}

${angle}${offerLine ? `\n${offerLine}` : ""}

Open to a 15-minute chat this week?

${fromLine}`;

  const baseConfidence = hook.relevance >= 0.75 ? "high" : hook.relevance >= 0.55 ? "medium" : "low";

  return {
    subject: subjectFromHook(prospect, hook),
    body,
    hook: hook.title,
    confidence: sensitive && baseConfidence === "high" ? "medium" : baseConfidence,
    confidenceWhy: sensitive
      ? "Heuristic draft on a sensitive hook — review tone before sending."
      : "Groq draft unavailable; confidence is from hook strength, not a model self-rating.",
    usedSignalIds: [hook.id],
    model: analysis ? "heuristic+analysis" : "heuristic-grounded",
    sensitiveHook: sensitive,
  };
}

/** Soft candidates → LLM entity resolve → analysis. */
export async function resolveAndAnalyze(
  prospect: ProspectInput,
  ranked: Signal[],
  linkedIn?: LinkedInContext | null
): Promise<{
  signals: Signal[];
  hook: Signal | undefined;
  analysis: HookAnalysis | null;
  llm: boolean;
  entityNote: string;
}> {
  const up = await llmAvailable();
  let signals = ranked;
  let entityNote = "No LLM entity check.";
  let preferredHookId: string | null = null;

  if (up) {
    const resolution = await resolveEntities(prospect, ranked, linkedIn);
    if (resolution) {
      signals = applyEntityResolution(ranked, resolution, prospect);
      entityNote = resolution.note;
      preferredHookId = resolution.chosenHookId;
      if (resolution.chosenHookId) {
        const chosen = signals.find((s) => s.id === resolution.chosenHookId && s.eligible);
        if (!chosen) {
          entityNote = `${resolution.note} (chosen hook cleared by exact-name safety net.)`;
          preferredHookId = null;
        } else {
          signals = signals.map((s) =>
            s.id === chosen.id
              ? {
                  ...s,
                  relevance: Math.min(0.99, (s.relevance || 0) + 0.08),
                  why: `${s.why} · LLM preferred for outreach.`,
                }
              : s
          );
        }
      }
    } else {
      entityNote =
        "Groq entity check failed — using exact-tier heuristic only. The key is set; the model returned no usable JSON. Soft/suspect hits were not auto-kept.";
      signals = ranked.map((s) => {
        if (s.kind === "company") return { ...s, eligible: false };
        const ok = s.matchTier === "exact" || s.matchTier === "person";
        return {
          ...s,
          eligible: ok,
          why: ok ? s.why : `Held for LLM (unavailable). Soft/suspect not auto-kept. ${s.why}`,
        };
      });
    }
  } else {
    entityNote = "Groq unavailable — keeping exact/person matches only.";
    signals = ranked.map((s) => {
      if (s.kind === "company") return { ...s, eligible: false };
      const ok = s.matchTier === "exact" || s.matchTier === "person";
      return {
        ...s,
        eligible: !!ok && !!s.eligible,
        why: ok ? s.why : `Groq offline; soft match not confirmed. ${s.why}`,
      };
    });
  }

  const hook = selectHook(signals, prospect, preferredHookId);
  if (hook && preferredHookId && hook.id !== preferredHookId) {
    entityNote = `${entityNote} · Hook switched to offer-aligned signal.`;
  }
  if (!hook) return { signals, hook: undefined, analysis: null, llm: up, entityNote };

  if (!up) return { signals, hook, analysis: null, llm: false, entityNote };

  const analysis = await analyzeHook(prospect, hook, signals, linkedIn);
  return { signals, hook, analysis, llm: true, entityNote };
}

export async function writeDraft(
  prospect: ProspectInput,
  ranked: Signal[],
  analysis?: HookAnalysis | null,
  linkedIn?: LinkedInContext | null
): Promise<OutreachDraft> {
  const hook = pickHook(ranked as RankedSignal[], prospect);
  if (!hook) {
    return noHookDraft(prospect);
  }

  if (analysis && (await llmAvailable())) {
    const drafted = await draftEmail(prospect, hook, ranked, analysis, linkedIn);
    if (drafted) return drafted;
  }

  if (!analysis && (await llmAvailable())) {
    const a = await analyzeHook(prospect, hook, ranked, linkedIn);
    if (a) {
      const drafted = await draftEmail(prospect, hook, ranked, a, linkedIn);
      if (drafted) return drafted;
      return heuristicDraft(prospect, hook, a);
    }
  }

  return heuristicDraft(prospect, hook, analysis);
}

export { llmModelName, llmAvailable };
