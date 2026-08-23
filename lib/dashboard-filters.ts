import { isHoldDraft } from "./edge-cases";
import type { RunRecord } from "./types";

export type TimeFrame = "all" | "today" | "7d" | "30d" | "90d";
export type ConfidenceFilter = "all" | "high" | "medium" | "low" | "hold";

export const TIME_FRAME_OPTIONS: { value: TimeFrame; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export const CONFIDENCE_FILTER_OPTIONS: { value: ConfidenceFilter; label: string }[] = [
  { value: "all", label: "All confidence" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "hold", label: "Hold / no hook" },
];

export function runInTimeFrame(createdAt: string, frame: TimeFrame, nowMs = Date.now()): boolean {
  if (frame === "all") return true;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;

  if (frame === "today") {
    const now = new Date(nowMs);
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return t >= start;
  }

  const days = frame === "7d" ? 7 : frame === "30d" ? 30 : 90;
  return nowMs - t <= days * 24 * 60 * 60 * 1000;
}

export function runMatchesConfidence(run: RunRecord, filter: ConfidenceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "hold") {
    return Boolean(run.draft && (run.draft.hold || isHoldDraft(run.draft)));
  }
  return run.draft?.confidence === filter;
}

export function filterDashboardRuns(
  runs: RunRecord[],
  opts: {
    query?: string;
    timeFrame?: TimeFrame;
    confidence?: ConfidenceFilter;
    nowMs?: number;
  }
): RunRecord[] {
  const needle = (opts.query || "").trim().toLowerCase();
  const timeFrame = opts.timeFrame ?? "all";
  const confidence = opts.confidence ?? "all";
  const nowMs = opts.nowMs ?? Date.now();

  return runs.filter((r) => {
    if (!runInTimeFrame(r.createdAt, timeFrame, nowMs)) return false;
    if (!runMatchesConfidence(r, confidence)) return false;
    if (!needle) return true;

    const hay = [
      r.prospect.fullName,
      r.prospect.company,
      r.prospect.title,
      r.draft?.subject,
      r.draft?.body,
      r.draft?.hook,
      r.draft?.confidence,
      r.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });
}

export function hasActiveDashboardFilters(opts: {
  query?: string;
  timeFrame?: TimeFrame;
  confidence?: ConfidenceFilter;
}): boolean {
  return (
    Boolean(opts.query?.trim()) ||
    (opts.timeFrame ?? "all") !== "all" ||
    (opts.confidence ?? "all") !== "all"
  );
}
