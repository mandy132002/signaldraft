import { NextResponse } from "next/server";
import { getBulkJob, listRunsForBulk, reconcileBulkJob, summarizeBulk, upsertBulkJob } from "@/lib/bulk-db";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const { id } = await ctx.params;
  let job = await getBulkJob(id, gate.userId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const runs = await listRunsForBulk(gate.userId, id);
  const healed = reconcileBulkJob(job, runs);
  if (healed.changed) {
    job = healed.job;
    await upsertBulkJob(job);
  }

  return NextResponse.json({
    job,
    runs,
    summary: summarizeBulk(job),
  });
}
