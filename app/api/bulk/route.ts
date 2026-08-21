import { NextResponse } from "next/server";
import { listBulkJobs, upsertBulkJob } from "@/lib/bulk-db";
import { prospectsFromCsv, MAX_BULK_ROWS } from "@/lib/csv";
import { requireUserId } from "@/lib/session";
import type { BulkJob, BulkItem } from "@/lib/types";

export const dynamic = "force-dynamic";

function newBulkId() {
  return `bulk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function GET() {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const jobs = await listBulkJobs(gate.userId);
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;

  const body = (await req.json()) as {
    csvText?: string;
    fileName?: string;
    senderName?: string;
    senderCompany?: string;
    senderOffer?: string;
  };

  const defaults = {
    senderName: (body.senderName || "").trim() || "Alex",
    senderCompany: (body.senderCompany || "").trim(),
    senderOffer: (body.senderOffer || "").trim() || "our product",
  };

  const csvText = body.csvText || "";
  if (!csvText.trim()) {
    return NextResponse.json({ error: "Paste or upload a CSV first." }, { status: 400 });
  }

  const parsed = prospectsFromCsv(csvText, defaults);
  if (!parsed.prospects.length) {
    return NextResponse.json(
      { error: parsed.errors[0] || "No valid prospects found.", errors: parsed.errors },
      { status: 400 }
    );
  }

  const stamp = new Date().toISOString();
  const items: BulkItem[] = parsed.prospects.map((prospect, index) => ({
    index,
    prospect,
    status: "pending" as const,
    updatedAt: stamp,
  }));

  const job: BulkJob = {
    id: newBulkId(),
    userId: gate.userId,
    createdAt: stamp,
    updatedAt: stamp,
    status: "queued",
    fileName: (body.fileName || "prospects.csv").slice(0, 120),
    defaults,
    items,
  };

  await upsertBulkJob(job);

  return NextResponse.json({
    job,
    warnings: parsed.errors,
    matchedColumns: parsed.matchedColumns,
    maxRows: MAX_BULK_ROWS,
  });
}
