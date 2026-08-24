import { executeRun } from "@/lib/pipeline";
import { applySavedCompanyContextToProspect } from "@/lib/company-context-db";
import { mergeClarifyAnswers, type ClarifyAnswers } from "@/lib/clarify";
import { getBulkJob, upsertBulkJob } from "@/lib/bulk-db";
import { getRun, upsertRun } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import type { RunRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;

  const { id } = await ctx.params;
  const existing = await getRun(id, gate.userId);
  if (!existing) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (existing.status !== "needs_input") {
    return new Response(JSON.stringify({ error: "This run is not waiting for a question." }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }

  const body = (await req.json().catch(() => ({}))) as ClarifyAnswers;
  const merged = mergeClarifyAnswers(existing.prospect, body);
  const prospect = await applySavedCompanyContextToProspect(gate.userId, merged);
  existing.prospect = prospect;
  if (existing.clarify) {
    existing.clarify = { ...existing.clarify, answeredAt: new Date().toISOString() };
  }
  existing.updatedAt = new Date().toISOString();
  await upsertRun(existing);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (run: RunRecord) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ run })}\n\n`));
      };
      try {
        const run = await executeRun(prospect, send, gate.userId, {
          existing,
          skipClarify: true,
          bulkJobId: existing.bulkJobId,
        });
        if (run.bulkJobId) {
          await syncBulkItem(gate.userId, run);
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

async function syncBulkItem(userId: string, run: RunRecord) {
  if (!run.bulkJobId) return;
  const job = await getBulkJob(run.bulkJobId, userId);
  if (!job) return;
  const stamp = new Date().toISOString();
  job.items = job.items.map((item) => {
    if (item.runId !== run.id) return item;
    const status =
      run.status === "failed"
        ? "failed"
        : run.status === "needs_input"
          ? "needs_input"
          : run.status === "running"
            ? "running"
            : "done";
    return {
      ...item,
      status,
      error: run.error,
      prospect: run.prospect,
      updatedAt: stamp,
    };
  });
  const pending = job.items.some((i) => i.status === "pending" || i.status === "running");
  const waiting = job.items.some((i) => i.status === "needs_input");
  if (!pending && !waiting && job.status !== "cancelled") {
    job.status = "completed";
    job.completedAt = stamp;
  }
  job.updatedAt = stamp;
  await upsertBulkJob(job);
}
