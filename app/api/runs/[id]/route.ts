import { NextResponse } from "next/server";
import { recordDecisionMemory } from "@/lib/draft-memory-db";
import { getRun, upsertRun } from "@/lib/db";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const { id } = await ctx.params;
  const run = await getRun(id, gate.userId);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ run });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;
  const { id } = await ctx.params;
  const run = await getRun(id, gate.userId);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json()) as {
    status?: "approved" | "rejected";
    reviewNote?: string;
    subject?: string;
    emailBody?: string;
    saveEdits?: boolean;
  };

  const deciding = body.status === "approved" || body.status === "rejected";
  const editing = body.saveEdits === true || body.subject !== undefined || body.emailBody !== undefined;

  if (!deciding && !editing) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  if (!deciding && body.saveEdits) {
    if (!run.draft) {
      return NextResponse.json({ error: "No draft to edit" }, { status: 400 });
    }
    if (body.subject !== undefined) run.draft.subject = body.subject;
    if (body.emailBody !== undefined) run.draft.body = body.emailBody;
    run.updatedAt = new Date().toISOString();
    await upsertRun(run);
    return NextResponse.json({ run });
  }

  if (!deciding) {
    return NextResponse.json({ error: "status must be approved or rejected to store the email" }, { status: 400 });
  }

  if (run.status === "needs_input") {
    return NextResponse.json(
      { error: "Answer the workplace question before storing this run." },
      { status: 409 }
    );
  }

  if (!run.draft) {
    run.draft = {
      subject: body.subject ?? "",
      body: body.emailBody ?? "",
      hook: run.chosenSignal?.title ?? "Stored draft",
      confidence: "medium",
      usedSignalIds: run.chosenSignal ? [run.chosenSignal.id] : [],
      model: "manual-store",
    };
  }

  if (body.subject !== undefined) run.draft.subject = body.subject;
  if (body.emailBody !== undefined) run.draft.body = body.emailBody;
  if (body.reviewNote !== undefined) run.reviewNote = body.reviewNote;
  run.status = body.status!;
  run.updatedAt = new Date().toISOString();
  await upsertRun(run);
  try {
    await recordDecisionMemory(run, body.status!, body.reviewNote);
  } catch (err) {
    console.error("recordDecisionMemory failed", err);
  }
  return NextResponse.json({ run });
}
