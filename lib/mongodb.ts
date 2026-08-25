import { MongoClient, type Db } from "mongodb";

declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _runsIndexesReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var _bulkIndexesReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var _companyContextIndexesReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var _draftMemoryIndexesReady: boolean | undefined;
}

function requireUri() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "Missing MONGODB_URI. Copy .env.example to .env.local and add your Atlas connection string."
    );
  }
  return uri;
}

/** Singleton client (connect on first use). Passed to Auth.js MongoDB adapter. */
export default function getMongoClient() {
  if (!global._mongoClient) {
    global._mongoClient = new MongoClient(requireUri());
  }
  return global._mongoClient;
}

export async function getDb(): Promise<Db> {
  const client = getMongoClient();
  await client.connect();
  return client.db(process.env.MONGODB_DB || "signaldraft");
}

export async function ensureRunIndexes(db: Db) {
  if (global._runsIndexesReady) return;
  const col = db.collection("runs");
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ userId: 1, createdAt: -1 });
  await col.createIndex({ userId: 1, bulkJobId: 1 });
  global._runsIndexesReady = true;
}

export async function ensureBulkIndexes(db: Db) {
  if (global._bulkIndexesReady) return;
  const col = db.collection("bulk_jobs");
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ userId: 1, createdAt: -1 });
  global._bulkIndexesReady = true;
}

export async function ensureCompanyContextIndexes(db: Db) {
  if (global._companyContextIndexesReady) return;
  const col = db.collection("company_context");
  await col.createIndex({ userId: 1 }, { unique: true });
  global._companyContextIndexesReady = true;
}

export async function ensureDraftMemoryIndexes(db: Db) {
  if (global._draftMemoryIndexesReady) return;
  const col = db.collection("draft_memory");
  await col.createIndex({ userId: 1, createdAt: -1 });
  await col.createIndex({ userId: 1, runId: 1, kind: 1 }, { unique: true });
  global._draftMemoryIndexesReady = true;
}
