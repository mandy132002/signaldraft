import type { BulkJob, BulkItem, RunRecord, RunStatus } from "./types";
import { ensureBulkIndexes, getDb } from "./mongodb";

export { summarizeBulk, bulkElapsedMs } from "./bulk-stats";

async function bulkCollection() {
  const db = await getDb();
  await ensureBulkIndexes(db);
  return db.collection<BulkJob>("bulk_jobs");
}

function stripId(doc: BulkJob & { _id?: unknown }): BulkJob {
  const { _id: _ignored, ...job } = doc as BulkJob & { _id?: unknown };
  return job;
}

export async function listBulkJobs(userId: string): Promise<BulkJob[]> {
  const col = await bulkCollection();
  const docs = await col.find({ userId }).sort({ createdAt: -1 }).limit(40).toArray();
  return docs.map(stripId);
}

export async function getBulkJob(id: string, userId: string): Promise<BulkJob | undefined> {
  const col = await bulkCollection();
  const job = await col.findOne({ id, userId });
  return job ? stripId(job) : undefined;
}

export async function upsertBulkJob(job: BulkJob) {
  const col = await bulkCollection();
  await col.updateOne({ id: job.id }, { $set: job }, { upsert: true });
}

export async function listRunsForBulk(userId: string, bulkJobId: string): Promise<RunRecord[]> {
  const db = await getDb();
  const col = db.collection<RunRecord>("runs");
  const docs = await col.find({ userId, bulkJobId }).sort({ createdAt: 1 }).toArray();
  return docs.map((doc) => {
    const { _id: _ignored, ...run } = doc as RunRecord & { _id?: unknown };
    return run;
  });
}

function sameProspect(a: BulkItem["prospect"], b: RunRecord["prospect"]) {
  return (
    a.fullName.trim().toLowerCase() === b.fullName.trim().toLowerCase() &&
    a.company.trim().toLowerCase() === b.company.trim().toLowerCase()
  );
}

function terminalFromRun(status: RunStatus): BulkItem["status"] {
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "done";
}

/**
 * Fix stuck "running" rows after a dropped SSE / refresh, and link orphaned runs.
 * Returns whether the job document changed.
 */
export function reconcileBulkJob(job: BulkJob, runs: RunRecord[]): { job: BulkJob; changed: boolean } {
  const usedRunIds = new Set(job.items.map((i) => i.runId).filter(Boolean) as string[]);
  let changed = false;
  const stamp = new Date().toISOString();

  const items = job.items.map((item) => {
    let next = item;

    // Prefer explicit runId
    let run = item.runId ? runs.find((r) => r.id === item.runId) : undefined;

    // Orphan match by prospect if unlinked / stuck
    if (!run && (item.status === "running" || item.status === "pending" || !item.runId)) {
      run = runs.find((r) => !usedRunIds.has(r.id) && sameProspect(item.prospect, r.prospect));
    }

    if (run) {
      usedRunIds.add(run.id);
      const mapped = terminalFromRun(run.status);
      // If the run finished but the item is still running/pending, close it out
      if (run.status !== "running" && (item.status === "running" || item.status === "pending" || item.runId !== run.id)) {
        const durationMs =
          item.durationMs ??
          (item.startedAt ? Math.max(0, Date.parse(run.updatedAt) - Date.parse(item.startedAt)) : undefined) ??
          (run.stages?.reduce((acc, s) => acc + (s.durationMs || 0), 0) || undefined);
        next = {
          ...item,
          runId: run.id,
          status: mapped === "running" ? "done" : mapped,
          error: run.error,
          updatedAt: stamp,
          durationMs,
        };
        changed = true;
      } else if (!item.runId) {
        next = { ...item, runId: run.id, updatedAt: stamp };
        changed = true;
      }
    } else if (item.status === "running") {
      // Truly stuck with no finished run — re-queue for retry
      next = { ...item, status: "pending", updatedAt: stamp, startedAt: undefined };
      changed = true;
    }

    return next;
  });

  let status = job.status;
  let completedAt = job.completedAt;
  const allDone = items.every((i) => i.status === "done" || i.status === "failed" || i.status === "skipped");
  const anyPending = items.some((i) => i.status === "pending" || i.status === "running");

  if (allDone && job.status !== "completed" && job.status !== "cancelled") {
    status = "completed";
    completedAt = stamp;
    changed = true;
  } else if (anyPending && job.status === "completed") {
    status = "running";
    completedAt = undefined;
    changed = true;
  }

  if (!changed) return { job, changed: false };
  return {
    job: { ...job, items, status, completedAt, updatedAt: stamp },
    changed: true,
  };
}
