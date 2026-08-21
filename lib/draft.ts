import {
  analyzeWithOllama,
  applyEntityResolution,
  draftWithOllama,
  ollamaAvailable,
  ollamaModelName,
  resolveEntitiesWithOllama,
  type HookAnalysis,
} from "./ollama";
import type { LinkedInContext } from "./linkedin";
import { offerFit } from "./offer";
import { pickHook, type RankedSignal } from "./relevance";
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

/** Merge LLM entity choice with offer-aware ranking. */
function selectHook(
  signals: Signal[],
  prospect: ProspectInput,
  preferredId?: string | null
): Signal | undefined {
  const ranked = signals as RankedSignal[];
  const preferred = preferredId
    ? ranked.find((s) => s.id === preferredId && s.eligible && s.kind !== "company")
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

function heuristicDraft(prospect: ProspectInput, hook: Signal, analysis?: HookAnalysis | null): OutreachDraft {
  const sender = prospect.senderName?.trim() || "Alex";
  const senderCo = prospect.senderCompany?.trim() || "";
  const offer = prospect.senderOffer?.trim();
  const fromLine = senderCo ? `${sender}\n${senderCo}` : sender;
  const name = firstName(prospect.fullName);
  const bit = shortHook(hook.title, 100);

  const sentiment = analysis?.sentiment ?? "neutral";
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

  return {
    subject: subjectFromHook(prospect, hook),
    body,
    hook: hook.title,
    confidence: hook.relevance >= 0.75 ? "high" : hook.relevance >= 0.55 ? "medium" : "low",
    usedSignalIds: [hook.id],
    model: analysis ? "heuristic+analysis" : "heuristic-grounded",
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
  ollama: boolean;
  entityNote: string;
}> {
  const up = await ollamaAvailable();
  let signals = ranked;
  let entityNote = "No LLM entity check.";
  let preferredHookId: string | null = null;

  if (up) {
    const resolution = await resolveEntitiesWithOllama(prospect, ranked, linkedIn);
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
      entityNote = "LLM entity check failed — using exact-tier heuristic only.";
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
    entityNote = "LLM offline — keeping exact/person matches only.";
    signals = ranked.map((s) => {
      if (s.kind === "company") return { ...s, eligible: false };
      const ok = s.matchTier === "exact" || s.matchTier === "person";
      return {
        ...s,
        eligible: !!ok && !!s.eligible,
        why: ok ? s.why : `LLM offline; soft match not confirmed. ${s.why}`,
      };
    });
  }

  const hook = selectHook(signals, prospect, preferredHookId);
  if (hook && preferredHookId && hook.id !== preferredHookId) {
    entityNote = `${entityNote} · Hook switched to offer-aligned signal.`;
  }
  if (!hook) return { signals, hook: undefined, analysis: null, ollama: up, entityNote };

  if (!up) return { signals, hook, analysis: null, ollama: false, entityNote };

  const analysis = await analyzeWithOllama(prospect, hook, signals, linkedIn);
  return { signals, hook, analysis, ollama: true, entityNote };
}

export async function writeDraft(
  prospect: ProspectInput,
  ranked: Signal[],
  analysis?: HookAnalysis | null,
  linkedIn?: LinkedInContext | null
): Promise<OutreachDraft> {
  const hook = pickHook(ranked as RankedSignal[], prospect);
  if (!hook) {
    const sender = prospect.senderName?.trim() || "Alex";
    return {
      subject: `${prospect.company}`,
      body: `Hi ${firstName(prospect.fullName)},

I looked for a public signal I could confidently tie to you at ${prospect.company}, and didn't find one solid enough to cite. Better to hold than send a generic note.

${sender}`,
      hook: "No confirmed entity match",
      confidence: "low",
      usedSignalIds: [],
      model: "heuristic-grounded",
    };
  }

  if (analysis && (await ollamaAvailable())) {
    const drafted = await draftWithOllama(prospect, hook, ranked, analysis, linkedIn);
    if (drafted) return drafted;
  }

  if (!analysis && (await ollamaAvailable())) {
    const a = await analyzeWithOllama(prospect, hook, ranked, linkedIn);
    if (a) {
      const drafted = await draftWithOllama(prospect, hook, ranked, a, linkedIn);
      if (drafted) return drafted;
      return heuristicDraft(prospect, hook, a);
    }
  }

  return heuristicDraft(prospect, hook, analysis);
}

export { ollamaModelName, ollamaAvailable };
