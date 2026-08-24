import type { CompanyContext, ProspectInput } from "./types";

export const EMPTY_COMPANY_CONTEXT: CompanyContext = {
  senderName: "",
  senderCompany: "",
  senderOffer: "",
};

const LIMITS = {
  senderName: 120,
  senderCompany: 200,
  senderOffer: 2000,
} as const;

function clip(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

export function sanitizeCompanyContext(input: Partial<CompanyContext> | null | undefined): CompanyContext {
  return {
    senderName: clip(input?.senderName, LIMITS.senderName),
    senderCompany: clip(input?.senderCompany, LIMITS.senderCompany),
    senderOffer: clip(input?.senderOffer, LIMITS.senderOffer),
  };
}

export function hasCompanyContext(ctx: CompanyContext | null | undefined): boolean {
  if (!ctx) return false;
  return Boolean(ctx.senderName.trim() || ctx.senderCompany.trim() || ctx.senderOffer.trim());
}

export function companyContextEquals(a: CompanyContext, b: CompanyContext): boolean {
  return (
    a.senderName.trim() === b.senderName.trim() &&
    a.senderCompany.trim() === b.senderCompany.trim() &&
    a.senderOffer.trim() === b.senderOffer.trim()
  );
}

/** Fill blank sender fields from the saved profile. Non-empty values win (per-run override). */
export function mergeCompanyContext<T extends Partial<CompanyContext>>(
  input: T,
  ctx: CompanyContext | null | undefined
): T {
  if (!ctx || !hasCompanyContext(ctx)) return input;
  return {
    ...input,
    senderName: (input.senderName || "").trim() || ctx.senderName,
    senderCompany: (input.senderCompany || "").trim() || ctx.senderCompany,
    senderOffer: (input.senderOffer || "").trim() || ctx.senderOffer,
  };
}

export function applyCompanyContextToProspect(
  prospect: ProspectInput,
  ctx: CompanyContext | null | undefined
): ProspectInput {
  return mergeCompanyContext(prospect, ctx);
}
