import { NextResponse } from "next/server";
import { getRun, upsertRun } from "@/lib/db";
import { recordRefineMemory, retrieveDraftMemory } from "@/lib/draft-memory-db";
import { llmAvailable, refineDraft } from "@/lib/llm";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;

  const { id } = await ctx.params;
  const run = await getRun(id, gate.userId);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json()) as {
    prompt?: string;
    subject?: string;
    emailBody?: string;
  };

  const prompt = (body.prompt || "").trim();
  if (!prompt) {
    return NextResponse.json({ error: "Refinement prompt is required" }, { status: 400 });
  }

  const hook = run.chosenSignal;
  if (!hook || run.draft?.hold) {
    return NextResponse.json({ error: "No confirmed hook to refine against" }, { status: 400 });
  }

  if (!(await llmAvailable())) {
    return NextResponse.json(
      { error: "Groq is not configured. Set GROQ_API_KEY in your environment." },
      { status: 503 }
    );
  }

  const currentSubject = body.subject ?? run.draft?.subject ?? "";
  const currentBody = body.emailBody ?? run.draft?.body ?? "";
  if (!currentBody.trim()) {
    return NextResponse.json({ error: "No current email body to refine" }, { status: 400 });
  }

  const memory = await retrieveDraftMemory(gate.userId, run.prospect).catch(() => undefined);
  const refined = await refineDraft({
    prospect: run.prospect,
    hook,
    analysis: run.analysis,
    currentSubject,
    currentBody,
    refinePrompt: prompt,
    memory,
  });

  if (!refined) {
    return NextResponse.json(
      { error: "Refinement failed — try a clearer prompt or check Groq." },
      { status: 502 }
    );
  }

  run.draft = {
    ...refined,
    hook: run.draft?.hook ?? refined.hook,
  };
  run.lastRefinePrompt = prompt;
  if (run.status === "approved" || run.status === "rejected") {
    run.status = "needs_review";
  } else if (run.status !== "failed") {
    run.status = "needs_review";
  }
  run.updatedAt = new Date().toISOString();
  await upsertRun(run);
  try {
    await recordRefineMemory(run, prompt);
  } catch (err) {
    console.error("recordRefineMemory failed", err);
  }

  return NextResponse.json({ run, refinementPrompt: prompt });
}
