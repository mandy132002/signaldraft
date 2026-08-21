import type { RunRecord } from "./types";
import { ensureRunIndexes, getDb } from "./mongodb";

const COLLECTION = "runs";

async function runsCollection() {
  const db = await getDb();
  await ensureRunIndexes(db);
  return db.collection<RunRecord>(COLLECTION);
}

export async function listRuns(userId: string): Promise<RunRecord[]> {
  const col = await runsCollection();
  const docs = await col.find({ userId }).sort({ createdAt: -1 }).toArray();
  return docs.map(stripMongoId);
}

export async function getRun(id: string, userId: string): Promise<RunRecord | undefined> {
  const col = await runsCollection();
  const run = await col.findOne({ id, userId });
  return run ? stripMongoId(run) : undefined;
}

export async function upsertRun(run: RunRecord) {
  if (!run.userId) {
    throw new Error("upsertRun requires run.userId");
  }
  const col = await runsCollection();
  await col.updateOne({ id: run.id }, { $set: run }, { upsert: true });
}

function stripMongoId(doc: RunRecord & { _id?: unknown }): RunRecord {
  const { _id: _ignored, ...run } = doc as RunRecord & { _id?: unknown };
  return run;
}
