import type { ProspectInput } from "./types";
import {
  type DraftMemory,
  type MemoryPack,
  memoryFromRefine,
  memoriesFromDecision,
  selectMemoryPack,
  type MemoryKind,
} from "./draft-memory";
import { ensureDraftMemoryIndexes, getDb } from "./mongodb";
import type { RunRecord } from "./types";

const COLLECTION = "draft_memory";

async function memoryCollection() {
  const db = await getDb();
  await ensureDraftMemoryIndexes(db);
  return db.collection<DraftMemory>(COLLECTION);
}

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripId(doc: DraftMemory & { _id?: unknown }): DraftMemory {
  const { _id: _ignored, ...mem } = doc as DraftMemory & { _id?: unknown };
  return mem;
}

export async function recordDraftMemories(memories: DraftMemory[]): Promise<void> {
  if (!memories.length) return;
  const col = await memoryCollection();
  for (const mem of memories) {
    await col.updateOne(
      { userId: mem.userId, runId: mem.runId, kind: mem.kind as MemoryKind },
      { $set: mem },
      { upsert: true }
    );
  }
}

export async function recordDecisionMemory(
  run: RunRecord,
  decision: "approved" | "rejected",
  reviewNote?: string
): Promise<void> {
  const stamp = new Date().toISOString();
  const rows = memoriesFromDecision(run, decision, reviewNote).map((row) => ({
    ...row,
    id: newId(),
    userId: run.userId,
    createdAt: stamp,
  }));
  await recordDraftMemories(rows);
}

export async function recordRefineMemory(run: RunRecord, prompt: string): Promise<void> {
  const row = memoryFromRefine(run, prompt);
  if (!row) return;
  await recordDraftMemories([
    {
      ...row,
      id: newId(),
      userId: run.userId,
      createdAt: new Date().toISOString(),
    },
  ]);
}

export async function retrieveDraftMemory(userId: string, prospect: ProspectInput): Promise<MemoryPack> {
  const col = await memoryCollection();
  const docs = await col.find({ userId }).sort({ createdAt: -1 }).limit(80).toArray();
  return selectMemoryPack(docs.map(stripId), prospect);
}
