import type { OutreachDraft, ProspectInput, Signal } from "./types";

/**
 * Four SDR edge cases from the original problem:
 * 1. Lookalike companies (Cube Global ≠ CUBE / Cube Logic)
 * 2. Person–company split (Bezos + Amazon ≠ Blue Origin news)
 * 3. No confirmed public hook (refuse to invent; do not send)
 * 4. Sensitive / negative news (do not congratulate; prefer a safer hook)
 *
 * This module is client-safe (no Node / Groq / Mongo imports).
 */

const SENSITIVE_HOOK =
  /\b(layoffs?|laid off?|job cuts?|workforce reduction|redundanc(?:y|ies)|lawsuit|sued|suing|class[- ]action|dies?|died|dead|death|fatalit(?:y|ies)|killed|murder|suicide|investigation into|fraud|embezzl|scandal|arrest(ed)?|indicted|sexual harassment|bankrupt(cy)?|chapter 11|insolvent|product recall|data breach|hacked|ransomware|mass shooting)\b/i;

export function isSensitiveHook(title: string, summary = ""): boolean {
  return SENSITIVE_HOOK.test(`${title} ${summary}`);
}

export function signalIsSensitive(signal: Pick<Signal, "title" | "summary">): boolean {
  return isSensitiveHook(signal.title, signal.summary);
}

export function isHoldDraft(
  draft?: Pick<OutreachDraft, "hold" | "usedSignalIds" | "hook" | "subject"> | null
): boolean {
  if (!draft) return false;
  if (draft.hold) return true;
  if (draft.hook === "No confirmed entity match") return true;
  if (/^HOLD\s+[—-]/i.test(draft.subject || "")) return true;
  return false;
}

export function holdDraftBodyLooksInternal(body: string): boolean {
  return /^HOLD\s+[—-]\s*do not send/i.test(body.trim());
}

export function prospectLabel(prospect: Pick<ProspectInput, "fullName" | "company">): string {
  return `${prospect.fullName} at ${prospect.company}`;
}
