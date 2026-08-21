import type { BulkJob } from "./types";

export function summarizeBulk(job: BulkJob) {
  return {
    total: job.items.length,
    done: job.items.filter((i) => i.status === "done").length,
    failed: job.items.filter((i) => i.status === "failed").length,
    pending: job.items.filter((i) => i.status === "pending").length,
    running: job.items.filter((i) => i.status === "running").length,
  };
}

export function bulkElapsedMs(job: BulkJob, nowMs = Date.now()): number | null {
  const start = job.startedAt || job.createdAt;
  if (!start) return null;
  if (job.completedAt) return Math.max(0, Date.parse(job.completedAt) - Date.parse(start));
  if (job.status === "running" || job.items.some((i) => i.status === "running" || i.status === "pending")) {
    return Math.max(0, nowMs - Date.parse(start));
  }
  const last = job.items.reduce((max, i) => Math.max(max, Date.parse(i.updatedAt || job.updatedAt)), 0);
  return last ? Math.max(0, last - Date.parse(start)) : Math.max(0, nowMs - Date.parse(start));
}
