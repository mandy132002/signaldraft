import { executeRun } from "@/lib/pipeline";
import { requireUserId } from "@/lib/session";
import type { ProspectInput, RunRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const gate = await requireUserId();
  if ("error" in gate) return gate.error;

  const prospect = (await req.json()) as ProspectInput;
  const encoder = new TextEncoder();
  const { userId } = gate;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (run: RunRecord) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ run })}\n\n`));
      };
      try {
        await executeRun(prospect, send, userId);
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
