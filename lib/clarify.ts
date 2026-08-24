import type { CompanySiteContext } from "./company-site";
import type { LinkedInContext } from "./linkedin";
import { isAmbiguousCompanyName, exactCompanyPhrase } from "./relevance";
import type { ClarifyQuestion, ClarifyRequest, ProspectInput } from "./types";

export type ClarifyAnswers = {
  linkedinUrl?: string;
  companyWebsite?: string;
  company?: string;
  notes?: string;
  skip?: boolean;
};

const MAX_CLARIFY_ROUNDS = 1;

/** Short brand tokens that collide (Cube, Meta) — including the first word of "Cube Global". */
export function companyNeedsDisambiguation(company: string): boolean {
  if (isAmbiguousCompanyName(company)) return true;
  const tokens = exactCompanyPhrase(company)
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.some((t) => t.length >= 3 && t.length <= 6);
}

export function workplaceLooksConfirmed(
  linkedIn: LinkedInContext | null | undefined,
  site: CompanySiteContext | null | undefined
): boolean {
  if (linkedIn?.employerMatchesCompany === true) return true;
  if (site?.matchesCompany === true) return true;
  if (site?.fetched && site.domain) return true;
  return false;
}

function uniqueSuggestions(values: (string | undefined)[], typed: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = (v || "").trim();
    if (!s || s.toLowerCase() === typed.trim().toLowerCase()) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 5);
}

/**
 * Decide whether to pause before news/LLM. One round per run.
 * Skip is always allowed — we then continue and may still hold.
 */
export function buildClarifyRequest(
  prospect: ProspectInput,
  linkedIn: LinkedInContext | null | undefined,
  site: CompanySiteContext | null | undefined,
  round: number
): ClarifyRequest | null {
  if (round >= MAX_CLARIFY_ROUNDS) return null;
  if (workplaceLooksConfirmed(linkedIn, site)) return null;

  const company = prospect.company.trim();
  const questions: ClarifyQuestion[] = [];
  const reasons: string[] = [];
  const hasWebsite = Boolean(prospect.companyWebsite?.trim() || site?.url);
  const hasLinkedInUrl = Boolean(prospect.linkedinUrl?.trim() || linkedIn?.url);
  const linkedInUnreadable =
    hasLinkedInUrl &&
    Boolean(linkedIn) &&
    !linkedIn!.fetched &&
    !linkedIn!.employerHints.length &&
    !linkedIn!.domainHints.length;
  const linkedInConflict = linkedIn?.employerMatchesCompany === false;
  const needsName = companyNeedsDisambiguation(company);

  if (linkedInConflict) {
    const hints = [...(linkedIn?.employerHints || []), ...(linkedIn?.domainHints || [])];
    const hintLabel = hints.slice(0, 3).join(", ") || "a different employer";
    reasons.push(
      `LinkedIn looks like ${hintLabel}, but you typed "${company}". Confirm which workplace to research.`
    );
    questions.push({
      id: "company",
      field: "company",
      prompt: `Which company should we research for ${prospect.fullName}?`,
      placeholder: company,
      suggestions: uniqueSuggestions([...hints, company], ""),
    });
    questions.push({
      id: "website",
      field: "companyWebsite",
      prompt: "Company website (best way to tell lookalikes apart)",
      placeholder: "https://company.com",
      suggestions: uniqueSuggestions(
        (linkedIn?.domainHints || []).map((d) => (d.includes("://") ? d : `https://${d}`)),
        prospect.companyWebsite || ""
      ),
    });
  } else if (linkedInUnreadable && !hasWebsite) {
    reasons.push(
      `We couldn't read that LinkedIn page (common). Add a company website so we don't mix up "${company}" with a lookalike.`
    );
    questions.push({
      id: "website",
      field: "companyWebsite",
      prompt: `What's the company website for ${company}?`,
      placeholder: "https://company.com",
    });
    questions.push({
      id: "notes",
      field: "notes",
      prompt: "Anything else that identifies this org (legal name, product, city)",
      placeholder: "e.g. cube.dev — analytics warehouse, not Cube Logistics",
    });
  } else if (needsName && !hasWebsite) {
    reasons.push(
      `"${company}" is a short or collision-prone name. Is this cube.dev, Cube Logistics, or something else? A website (or a more specific company name) keeps the draft on the right org.`
    );
    questions.push({
      id: "website",
      field: "companyWebsite",
      prompt: `Company website for ${company}`,
      placeholder: "https://cube.dev",
    });
    questions.push({
      id: "company",
      field: "company",
      prompt: "More specific company name (optional)",
      placeholder: company,
    });
    if (!hasLinkedInUrl) {
      questions.push({
        id: "linkedin",
        field: "linkedinUrl",
        prompt: "LinkedIn URL (optional, but helps confirm the person)",
        placeholder: "https://linkedin.com/in/username",
      });
    }
  }

  if (!questions.length) return null;

  return {
    reason: reasons[0] || `Need a bit more workplace context for ${company}.`,
    questions,
    askedAt: new Date().toISOString(),
    round: round + 1,
  };
}

export function mergeClarifyAnswers(prospect: ProspectInput, answers: ClarifyAnswers): ProspectInput {
  const next: ProspectInput = { ...prospect };
  const linkedinUrl = (answers.linkedinUrl ?? "").trim();
  const companyWebsite = (answers.companyWebsite ?? "").trim();
  const company = (answers.company ?? "").trim();
  const extraNotes = (answers.notes ?? "").trim();

  if (linkedinUrl) next.linkedinUrl = linkedinUrl;
  if (companyWebsite) next.companyWebsite = companyWebsite;
  if (company) next.company = company;
  if (extraNotes) {
    next.notes = [prospect.notes?.trim(), extraNotes].filter(Boolean).join("\n");
  }
  return next;
}
