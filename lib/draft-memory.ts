import { looksLikeWrongCompany, wordMatch } from "./relevance";
import type { ProspectInput, RunRecord, Signal, SignalKind } from "./types";

export type MemoryKind = "approved_hook" | "rejected_collision" | "rejected_hook" | "tone";

export type DraftMemory = {
  id: string;
  userId: string;
  kind: MemoryKind;
  createdAt: string;
  runId: string;
  prospectCompany: string;
  prospectTitle?: string;
  senderCompany?: string;
  senderOffer?: string;
  hookKind?: SignalKind;
  hookTitle?: string;
  collisionNames?: string[];
  refinePrompt?: string;
  angleSnippet?: string;
  reviewNote?: string;
};

export type MemoryPack = {
  approved: DraftMemory[];
  collisions: DraftMemory[];
  rejectedHooks: DraftMemory[];
  tones: DraftMemory[];
};

const CLIP = {
  title: 160,
  angle: 200,
  prompt: 240,
  note: 200,
  company: 80,
};

function clip(value: string | undefined, max: number): string {
  return (value || "").trim().slice(0, max);
}

function tokenize(value: string | undefined): string[] {
  return (value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export function tokenOverlap(a: string | undefined, b: string | undefined): number {
  const as = new Set(tokenize(a));
  const bs = tokenize(b);
  if (!as.size || !bs.length) return 0;
  let hits = 0;
  for (const t of bs) if (as.has(t)) hits += 1;
  return hits / Math.max(as.size, bs.length, 1);
}

const COLLISION_NOTE =
  /wrong company|lookalike|not (the )?right (org|company|one)|different (company|org|employer)|collision|not this \w+|mixed up/i;

export function reviewLooksLikeCollision(reviewNote?: string): boolean {
  return Boolean(reviewNote && COLLISION_NOTE.test(reviewNote));
}

/** Pull lookalike org names from a rejected hook (Cube Logic when the target was Cube Global). */
export function extractCollisionNames(text: string, targetCompany: string): string[] {
  const out: string[] = [];
  const phrase = targetCompany.trim();
  if (!phrase) return out;
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  const distinctive = tokens.filter((t) => t.length >= 3);
  const lower = text.toLowerCase();

  for (const token of distinctive) {
    const re = new RegExp(`(?:^|[^a-z0-9])(${token}\\s+[a-z0-9][a-z0-9&'’.-]{1,24})`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = (m[1] || "").replace(/[.,;:!?]+$/, "").trim();
      const next = name.split(/\s+/)[1]?.toLowerCase();
      if (!name || !next || tokens.includes(next)) continue;
      if (name.toLowerCase() === phrase.toLowerCase()) continue;
      out.push(name);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

export function isCollisionReject(run: Pick<RunRecord, "prospect" | "chosenSignal" | "draft" | "entityNote">, reviewNote?: string): boolean {
  if (reviewLooksLikeCollision(reviewNote)) return true;
  const hook = run.chosenSignal;
  if (!hook) return false;
  const blob = `${hook.title} ${hook.summary}`;
  if (looksLikeWrongCompany(blob, run.prospect.company)) return true;
  if (hook.matchTier === "suspect") return true;
  if (/lookalike|wrong company|safety net/i.test(run.entityNote || "")) return true;
  return false;
}

export function memoriesFromDecision(
  run: RunRecord,
  decision: "approved" | "rejected",
  reviewNote?: string
): Omit<DraftMemory, "id" | "userId" | "createdAt">[] {
  if (run.draft?.hold) return [];
  const hook = run.chosenSignal;
  const base = {
    runId: run.id,
    prospectCompany: clip(run.prospect.company, CLIP.company),
    prospectTitle: clip(run.prospect.title, 80) || undefined,
    senderCompany: clip(run.prospect.senderCompany, CLIP.company) || undefined,
    senderOffer: clip(run.prospect.senderOffer, 160) || undefined,
    hookKind: hook?.kind,
    hookTitle: clip(hook?.title || run.draft?.hook, CLIP.title) || undefined,
    angleSnippet: clip(run.analysis?.outreachAngle || run.draft?.hook, CLIP.angle) || undefined,
    reviewNote: clip(reviewNote || run.reviewNote, CLIP.note) || undefined,
  };

  if (decision === "approved") {
    const rows: Omit<DraftMemory, "id" | "userId" | "createdAt">[] = [{ ...base, kind: "approved_hook" }];
    const tone = clip(run.lastRefinePrompt, CLIP.prompt);
    if (tone) rows.push({ ...base, kind: "tone", refinePrompt: tone, hookTitle: undefined });
    return rows;
  }

  if (isCollisionReject(run, reviewNote)) {
    const blob = `${hook?.title || ""} ${hook?.summary || ""} ${reviewNote || ""}`;
    return [
      {
        ...base,
        kind: "rejected_collision",
        collisionNames: extractCollisionNames(blob, run.prospect.company),
      },
    ];
  }

  return [{ ...base, kind: "rejected_hook" }];
}

export function memoryFromRefine(run: RunRecord, prompt: string): Omit<DraftMemory, "id" | "userId" | "createdAt"> | null {
  const refinePrompt = clip(prompt, CLIP.prompt);
  if (!refinePrompt || run.draft?.hold) return null;
  return {
    kind: "tone",
    runId: run.id,
    prospectCompany: clip(run.prospect.company, CLIP.company),
    prospectTitle: clip(run.prospect.title, 80) || undefined,
    senderCompany: clip(run.prospect.senderCompany, CLIP.company) || undefined,
    senderOffer: clip(run.prospect.senderOffer, 160) || undefined,
    refinePrompt,
  };
}

export function scoreMemory(mem: DraftMemory, prospect: ProspectInput, nowMs = Date.now()): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(mem.createdAt)) / 86_400_000);
  const recency = Math.max(0, 1 - ageDays / 180);
  let score = recency * 0.4;
  score += tokenOverlap(mem.senderOffer, prospect.senderOffer) * 1.4;
  score += tokenOverlap(mem.senderCompany, prospect.senderCompany) * 0.8;
  score += tokenOverlap(mem.prospectCompany, prospect.company) * 1.1;
  score += tokenOverlap(mem.prospectTitle, prospect.title) * 0.5;
  if (mem.kind === "rejected_collision") {
    const names = (mem.collisionNames || []).join(" ");
    const family = Math.max(
      tokenOverlap(mem.prospectCompany, prospect.company),
      tokenOverlap(names, prospect.company),
      tokenOverlap(mem.hookTitle, prospect.company)
    );
    if (family < 0.12) return recency * 0.05;
    score += family * 1.6;
  }
  return score;
}

export function selectMemoryPack(memories: DraftMemory[], prospect: ProspectInput, nowMs = Date.now()): MemoryPack {
  const ranked = memories
    .map((m) => ({ m, score: scoreMemory(m, prospect, nowMs) }))
    .sort((a, b) => b.score - a.score);

  const take = (kind: MemoryKind, n: number) =>
    ranked.filter((x) => x.m.kind === kind && x.score > 0.05).slice(0, n).map((x) => x.m);

  const tones = ranked.filter((x) => x.m.kind === "tone").slice(0, 3).map((x) => x.m);

  return {
    approved: take("approved_hook", 4),
    collisions: take("rejected_collision", 4),
    rejectedHooks: take("rejected_hook", 3),
    tones,
  };
}

export function memoryPackHasItems(pack: MemoryPack): boolean {
  return Boolean(pack.approved.length || pack.collisions.length || pack.rejectedHooks.length || pack.tones.length);
}

export function formatMemoryForPrompt(pack: MemoryPack): string {
  if (!memoryPackHasItems(pack)) return "";
  const lines: string[] = [
    "SDR REVIEW MEMORY (from this user's past decisions — follow preferences; do NOT copy old news onto this new prospect):",
  ];
  if (pack.collisions.length) {
    lines.push("Avoid these lookalikes / wrong companies the SDR already rejected:");
    for (const m of pack.collisions) {
      const names = (m.collisionNames || []).join(", ");
      lines.push(
        `- vs "${m.prospectCompany}": ${names || m.hookTitle || "lookalike hook"}${m.reviewNote ? ` (${m.reviewNote})` : ""}`
      );
    }
  }
  if (pack.rejectedHooks.length) {
    lines.push("Hooks the SDR rejected (do not repeat this angle unless the new public hook is clearly different):");
    for (const m of pack.rejectedHooks) {
      lines.push(`- ${m.hookTitle || "untitled"}${m.reviewNote ? ` — ${m.reviewNote}` : ""}`);
    }
  }
  if (pack.approved.length) {
    lines.push("Hooks/angles the SDR approved (reuse the *style* of bridge, not the old facts):");
    for (const m of pack.approved) {
      lines.push(
        `- ${m.hookKind || "hook"} for ${m.prospectTitle || "a prospect"} at ${m.prospectCompany}: ${m.angleSnippet || m.hookTitle}`
      );
    }
  }
  if (pack.tones.length) {
    lines.push("Tone the SDR keeps after refine:");
    for (const m of pack.tones) {
      if (m.refinePrompt) lines.push(`- ${m.refinePrompt}`);
    }
  }
  return lines.join("\n").slice(0, 1600);
}

export function signalHitsCollision(signal: Pick<Signal, "title" | "summary">, pack: MemoryPack): boolean {
  const blob = `${signal.title} ${signal.summary}`;
  for (const m of pack.collisions) {
    for (const name of m.collisionNames || []) {
      if (name.length >= 4 && wordMatch(blob, name)) return true;
    }
    if (m.hookTitle && tokenOverlap(m.hookTitle, signal.title) >= 0.5) return true;
  }
  return false;
}

export function summarizeMemoryUse(pack: MemoryPack): string {
  const bits: string[] = [];
  if (pack.approved.length) bits.push(`${pack.approved.length} approved`);
  if (pack.collisions.length) bits.push(`${pack.collisions.length} collision`);
  if (pack.tones.length) bits.push(`${pack.tones.length} tone`);
  if (!bits.length) return "";
  return `Used your review memory (${bits.join(", ")}).`;
}
