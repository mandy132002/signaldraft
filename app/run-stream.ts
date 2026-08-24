import type { RunRecord } from "@/lib/types";

/** Read an SSE stream of `{ run }` payloads (start / continue). */
export async function consumeRunStream(
  res: Response,
  onRun: (run: RunRecord) => void
): Promise<RunRecord | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buf = "";
  let last: RunRecord | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.replace(/^data:\s*/, "");
      if (!line) continue;
      try {
        const payload = JSON.parse(line) as { run?: RunRecord };
        if (payload.run) {
          last = payload.run;
          onRun(payload.run);
        }
      } catch {
        /* ignore partial JSON */
      }
    }
  }
  return last;
}
