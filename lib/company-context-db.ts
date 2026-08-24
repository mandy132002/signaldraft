import type { CompanyContext, ProspectInput } from "./types";
import { mergeCompanyContext, sanitizeCompanyContext, EMPTY_COMPANY_CONTEXT } from "./company-context";
import { ensureCompanyContextIndexes, getDb } from "./mongodb";

const COLLECTION = "company_context";

type CompanyContextDoc = CompanyContext & {
  userId: string;
  updatedAt: string;
};

async function contextCollection() {
  const db = await getDb();
  await ensureCompanyContextIndexes(db);
  return db.collection<CompanyContextDoc>(COLLECTION);
}

export async function getCompanyContext(userId: string): Promise<CompanyContext> {
  const col = await contextCollection();
  const doc = await col.findOne({ userId });
  if (!doc) return { ...EMPTY_COMPANY_CONTEXT };
  return sanitizeCompanyContext(doc);
}

export async function saveCompanyContext(userId: string, input: Partial<CompanyContext>): Promise<CompanyContext> {
  const next = sanitizeCompanyContext(input);
  const col = await contextCollection();
  const updatedAt = new Date().toISOString();
  await col.updateOne(
    { userId },
    { $set: { userId, ...next, updatedAt } },
    { upsert: true }
  );
  return next;
}

export async function applySavedCompanyContext<T extends Partial<CompanyContext>>(
  userId: string,
  input: T
): Promise<T> {
  const saved = await getCompanyContext(userId);
  return mergeCompanyContext(input, saved);
}

export async function applySavedCompanyContextToProspect(
  userId: string,
  prospect: ProspectInput
): Promise<ProspectInput> {
  return applySavedCompanyContext(userId, prospect);
}
