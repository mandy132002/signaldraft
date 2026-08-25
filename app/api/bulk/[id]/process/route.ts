import { getBulkJob, listRunsForBulk, reconcileBulkJob, summarizeBulk, upsertBulkJob } from "@/lib/bulk-db";
import { executeRun } from "@/lib/pipeline";
import { requireUserId } from "@/lib/session";
import type { RunRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const { id } = await ctx.params;
  let job = await getBulkJob(id, gate.userId);
  if (!job) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = Math.min(Math.max(body.limit ?? 1, 1), 3);

  // Heal stuck rows before taking work
  const existingRuns = await listRunsForBulk(gate.userId, id);
  const healed = reconcileBulkJob(job, existingRuns);
  if (healed.changed) {
    job = healed.job;
    await upsertBulkJob(job);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        if (job!.status === "cancelled") {
          send({ type: "done", job, summary: summarizeBulk(job!), more: false });
          return;
        }

        if (!job!.startedAt) {
          job!.startedAt = new Date().toISOString();
        }
        job!.status = "running";
        job!.updatedAt = new Date().toISOString();
        await upsertBulkJob(job!);
        send({ type: "job", job, summary: summarizeBulk(job!) });

        let processed = 0;
        for (const item of job!.items) {
          if (processed >= limit) break;
          if (item.status !== "pending") continue;

          const startedAt = new Date().toISOString();
          item.status = "running";
          item.startedAt = startedAt;
          item.updatedAt = startedAt;
          job!.updatedAt = startedAt;
          await upsertBulkJob(job!);
          send({
            type: "item_start",
            index: item.index,
            prospect: item.prospect,
            job,
            summary: summarizeBulk(job!),
          });

          try {
            const run = await executeRun(
              item.prospect,
              (partial: RunRecord) => {
                send({ type: "run_update", index: item.index, run: partial });
              },
              gate.userId,
              { bulkJobId: job!.id }
            );
            const finishedAt = new Date().toISOString();
            if (run.status === "needs_input") {
              item.status = "needs_input";
              item.runId = run.id;
              item.error = undefined;
              item.updatedAt = finishedAt;
              item.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
              job!.updatedAt = finishedAt;
              await upsertBulkJob(job!);
              send({
                type: "item_needs_input",
                index: item.index,
                run,
                job,
                summary: summarizeBulk(job!),
              });
            } else {
              item.status = run.status === "failed" ? "failed" : "done";
              item.runId = run.id;
              item.error = run.error;
              item.updatedAt = finishedAt;
              item.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
              job!.updatedAt = finishedAt;
              await upsertBulkJob(job!);
              send({
                type: "item_done",
                index: item.index,
                run,
                job,
                summary: summarizeBulk(job!),
              });
            }
          } catch (e) {
            const finishedAt = new Date().toISOString();
            item.status = "failed";
            item.error = e instanceof Error ? e.message : String(e);
            item.updatedAt = finishedAt;
            item.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
            job!.updatedAt = finishedAt;
            await upsertBulkJob(job!);
            send({
              type: "item_done",
              index: item.index,
              error: item.error,
              job,
              summary: summarizeBulk(job!),
            });
          }
          processed += 1;
        }

        const left = job!.items.some((i) => i.status === "pending");
        if (!left) {
          job!.status = "completed";
          job!.completedAt = job!.completedAt || new Date().toISOString();
          job!.updatedAt = job!.completedAt;
          await upsertBulkJob(job!);
        }
        send({ type: "done", job, summary: summarizeBulk(job!), more: left });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
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
