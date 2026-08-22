import type { ProspectInput, Signal, SignalKind } from "./types";
import { isSensitiveHook } from "./edge-cases";
import { offerFit } from "./offer";

const DAY = 1000 * 60 * 60 * 24;
const MAX_HOOK_AGE_DAYS = 540;

/** Legal suffixes we may strip only when the remaining name is still precise enough. */
const LEGAL_SUFFIX =
  /\b(incorporated|inc\.?|llc\.?|ltd\.?|limited|corp\.?|corporation|gmbh|plc|pvt\.?|private|public)\b/gi;

const GENERIC_TOKENS = new Set([
  "the",
  "and",
  "of",
  "group",
  "global",
  "international",
  "holdings",
  "holding",
  "company",
  "companies",
  "solutions",
  "systems",
  "technologies",
  "technology",
  "tech",
  "services",
  "service",
  "digital",
  "media",
  "capital",
  "partners",
  "partner",
  "ventures",
  "labs",
  "lab",
  "ai",
  "software",
  "data",
  "cloud",
  "network",
  "networks",
  "america",
  "usa",
  "us",
  "uk",
  "co",
]);

const JUNK_TITLE =
  /\b(list of investors|funding rounds|funding round list|competitors? list|employee directory|revenue estimate|company overview|stock price|price target|analyst (upgrade|downgrade)|earnings calendar|watchlist|similarweb|owler|zoominfo|rocketreach|tracxn|crunchbase|pitchbook)\b/i;

const INVESTOR_NOISE =
  /\b(shares|stock|price target|should you|buy the dip|market lesson|underwriters'? pricing|market value|market cap|chase the surge|post-ipo struggles)\b/i;

const ADVISOR_NOISE = /\b(advises on|advised on|represented .+ in|law firm)\b/i;

const COMPETITOR_FRAME =
  /\b(alternative to|open-?source .+|vs\.?|versus|competitor to|clone of|like a .+ for)\b/i;

const HOOK_VERBS =
  /\b(raises?|raised|series [a-f]\b|funds|funding|acquires?|acquired|launches?|launched|unveils?|hires?|hired|appoints?|appointed|joins? as|ipo|reports?|beats|misses|expands?|opens? .+ (office|market)|partners? with|wins?)\b/i;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(xs: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function normalizeSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Canonical phrases that count as "this exact company".
 * Never collapses a multi-word name down to a single ambiguous token
 * (e.g. "Cube Global" must NOT become just "Cube").
 */
export function companyAliases(company: string): string[] {
  const raw = normalizeSpaces(company);
  if (!raw) return [];

  const noLegal = normalizeSpaces(raw.replace(LEGAL_SUFFIX, " "));
  const noThe = normalizeSpaces(noLegal.replace(/^the\s+/i, ""));

  const aliases = [raw, noLegal, noThe].filter((s) => s.length >= 2);

  // Single-token brands (Amazon, Figma, Stripe) are allowed as-is.
  // Multi-word brands keep the full phrase only — no first-word alias.
  return unique(aliases);
}

/** Primary exact phrase used in search queries (always quoted). */
export function exactCompanyPhrase(company: string): string {
  return companyAliases(company)[0] ?? company.trim();
}

export function wordMatch(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  const escaped = needle
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * True only when the full company phrase appears as a contiguous token sequence.
 * "Cube Global" matches "Cube Global raises…" — not "Cube Logic" or "A Cube".
 */
export function mentionsCompanyExact(text: string, company: string): boolean {
  return companyAliases(company).some((alias) => wordMatch(text, alias));
}

/**
 * Detect near-misses: title uses the distinctive first token of a multi-word
 * company but pairs it with a different second word (Cube Logic ≠ Cube Global).
 */
export function looksLikeWrongCompany(text: string, company: string): boolean {
  const phrase = exactCompanyPhrase(company);
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;

  const distinctive = tokens.filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
  if (!distinctive.length) return false;

  // Already an exact full-name match → not a wrong company.
  if (mentionsCompanyExact(text, company)) return false;

  const lower = text.toLowerCase();
  for (const token of distinctive) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(token)}\\s+([a-z0-9&'’.-]+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const next = m[2]!.replace(/[.,;:!?]+$/, "");
      // e.g. "Cube Logic" when we wanted "Cube Global"
      if (next && !tokens.includes(next) && !GENERIC_TOKENS.has(next)) {
        return true;
      }
    }
    // Lone first token without the rest of the legal name
    if (wordMatch(text, token) && !mentionsCompanyExact(text, company)) {
      // Only flag if the distinctive token appears without the full phrase
      return true;
    }
  }
  return false;
}

export function mentionsPerson(text: string, fullName: string): boolean {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (wordMatch(text, fullName)) return true;
  if (parts.length >= 2) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    if (first.length >= 2 && last.length >= 3) {
      const near = new RegExp(
        `(${escapeRe(first)}[\\s\\S]{0,40}${escapeRe(last)})|(${escapeRe(last)}[,\\s]{0,24}${escapeRe(first)})`,
        "i"
      );
      if (near.test(text)) return true;
    }
  }
  return false;
}

/**
 * Person is named but the target company is not — unsafe as a sendable hook
 * (e.g. Jeff Bezos / Blue Origin news while researching Amazon).
 */
export function isPersonCompanySplit(text: string, prospect: ProspectInput): boolean {
  return mentionsPerson(text, prospect.fullName) && !mentionsCompanyExact(text, prospect.company);
}

/**
 * Prefer hooks that tie the person to the company in the same item.
 * Person-only is OK only if company is also present (or vice versa for company news).
 */
export function personCompanyLinked(text: string, prospect: ProspectInput): boolean {
  const hasPerson = mentionsPerson(text, prospect.fullName);
  const hasCompany = mentionsCompanyExact(text, prospect.company);
  return hasPerson && hasCompany;
}

export function ageDays(publishedAt?: string): number | null {
  if (!publishedAt) return null;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / DAY;
}

export function kindFromTitle(title: string, queryHint = ""): SignalKind {
  const t = `${title} ${queryHint}`.toLowerCase();
  if (
    /\b(appoints?|appointed|names|named|hires?|hired|joins? as|promoted to)\b/.test(t) &&
    /\b(ceo|cfo|cto|chief|president|vp|director|head of)\b/.test(t)
  )
    return "leadership";
  if (/\b(series [a-f]|raises?|raised|funding|venture round|seed round|valuation|ipo)\b/.test(t)) return "funding";
  if (/\b(hiring|is hiring|open roles?|we're hiring|we are hiring|headcount|recruit|job openings?)\b/.test(t))
    return "hiring";
  if (/\b(launch|launches|launched|product|platform|release|unveils|announces)\b/.test(t)) return "product";
  return "news";
}

function startsWithCompany(title: string, company: string): boolean {
  const aliases = companyAliases(company).sort((a, b) => b.length - a.length);
  const head = title.trim();
  return aliases.some(
    (alias) =>
      new RegExp(`^${escapeRe(alias)}\\b`, "i").test(head) ||
      new RegExp(`^${escapeRe(alias)}['’]s\\b`, "i").test(head)
  );
}

function companyIndex(title: string, company: string): number {
  const aliases = companyAliases(company).sort((a, b) => b.length - a.length);
  let best = -1;
  for (const alias of aliases) {
    const m = title.search(new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}([^a-z0-9]|$)`, "i"));
    if (m >= 0 && (best < 0 || m < best)) best = m;
  }
  return best;
}

export function companyIsFocal(title: string, company: string, fullName: string): boolean {
  if (mentionsPerson(title, fullName) && mentionsCompanyExact(title, company)) return true;
  if (startsWithCompany(title, company)) return true;
  if (/^(i|we)\b/i.test(title.trim())) return false;
  const idx = companyIndex(title, company);
  if (idx < 0) return false;
  if (idx > Math.max(28, title.length * 0.45)) return false;
  const before = title.slice(0, idx).toLowerCase();
  if (/\b(than|versus|vs\.?|instead of|more than)\b/.test(before)) return false;
  return true;
}

export type RankedSignal = Signal & { eligible: boolean };

export function junkReason(signal: Pick<Signal, "title" | "summary" | "url" | "source">): string | null {
  const blob = `${signal.title} ${signal.summary} ${signal.url} ${signal.source}`;
  if (JUNK_TITLE.test(blob)) return "Directory / database page, not a real news hook.";
  if (/\b(watch .+ jumps? as)\b/i.test(signal.title)) return "Market-watch headline, weak for personalized outreach.";
  return null;
}

function roleFit(kind: SignalKind, title: string): { points: number; label: string } {
  const t = title.toLowerCase();
  const sales = /\b(sales|revenue|growth|sdr|ae\b|gtm|commercial|cro)\b/.test(t);
  const eng = /\b(engineer|engineering|cto|technical|product|head of eng)\b/.test(t);
  const people = /\b(people|talent|hr|recruit|chief people)\b/.test(t);
  const exec = /\b(ceo|founder|chief|vp\b|vice president|director|head of|president)\b/.test(t);

  if (kind === "funding" && (exec || sales)) return { points: 0.18, label: "funding fits exec/GTM" };
  if (kind === "hiring" && (sales || people || exec)) return { points: 0.16, label: "hiring fits GTM/people/exec" };
  if (kind === "product" && eng) return { points: 0.16, label: "product fits product/eng" };
  if (kind === "leadership") return { points: 0.14, label: "leadership change" };
  if (kind === "funding") return { points: 0.06, label: "funding" };
  if (kind === "hiring") return { points: 0.04, label: "hiring" };
  if (kind === "product") return { points: 0.04, label: "product" };
  return { points: 0.02, label: "general news" };
}

export function rankSignals(signals: Signal[], prospect: ProspectInput): RankedSignal[] {
  const notes = (prospect.notes ?? "").toLowerCase();
  const ranked = signals
    .map((raw) => evaluate(raw, prospect, notes))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.relevance - a.relevance;
    });
  return collapseSameEvent(ranked, prospect.company).sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.relevance - a.relevance;
  });
}

function evaluate(raw: Signal, prospect: ProspectInput, notes: string): RankedSignal {
  if (raw.kind === "company") {
    return {
      ...raw,
      eligible: false,
      matchTier: "context",
      relevance: 0.35,
      why: "Background only — not used as the outreach hook.",
    };
  }

  const text = `${raw.title} ${raw.summary}`;
  const junk = junkReason(raw);
  if (junk) {
    return { ...raw, eligible: false, matchTier: "suspect", relevance: 0.05, why: junk };
  }

  const hasExactCompany = mentionsCompanyExact(text, prospect.company);
  const hasPerson = mentionsPerson(text, prospect.fullName);
  const soft = isSoftCandidate(text, prospect.company, prospect.fullName);
  const suspect = looksLikeWrongCompany(text, prospect.company);

  // Soft recall: keep soft/person matches for LLM entity check. Do not hard-drop collisions.
  if (!hasExactCompany && !hasPerson && !soft) {
    return {
      ...raw,
      eligible: false,
      matchTier: "suspect",
      relevance: 0.05,
      why: `Dropped — no name overlap with ${prospect.company} / ${prospect.fullName}.`,
    };
  }

  const age = ageDays(raw.publishedAt);
  if (age != null && age > MAX_HOOK_AGE_DAYS) {
    return {
      ...raw,
      eligible: false,
      matchTier: hasExactCompany ? "exact" : "soft",
      relevance: 0.1,
      why: `Dropped — ${Math.round(age / 30)} months old.`,
    };
  }

  if (ADVISOR_NOISE.test(raw.title)) {
    return {
      ...raw,
      eligible: false,
      matchTier: "suspect",
      relevance: 0.1,
      why: "Dropped — advisor/law-firm headline.",
    };
  }

  const reasons: string[] = [];
  let score = 0.18;
  let matchTier: RankedSignal["matchTier"] = "soft";
  const sensitive = isSensitiveHook(raw.title, raw.summary);

  if (hasExactCompany) {
    score += 0.16;
    matchTier = "exact";
    reasons.push(`exact company: ${exactCompanyPhrase(prospect.company)}`);
  } else if (suspect) {
    score += 0.04;
    matchTier = "suspect";
    reasons.push("possible name collision — LLM must confirm entity");
  } else if (soft) {
    score += 0.08;
    matchTier = "soft";
    reasons.push("soft company token overlap — LLM must confirm entity");
  }

  if (hasPerson) {
    score += 0.2;
    if (matchTier !== "exact") matchTier = "person";
    reasons.push("mentions the prospect");
  }

  if (personCompanyLinked(text, prospect)) {
    score += 0.12;
    reasons.push("person + company together");
  } else if (hasPerson && !hasExactCompany) {
    score -= 0.1;
    reasons.push("person named without target company (possible other employer)");
  }

  if (startsWithCompany(raw.title, prospect.company)) {
    score += 0.08;
    reasons.push("company is the subject");
  } else if (COMPETITOR_FRAME.test(raw.title)) {
    score -= 0.06;
    reasons.push("competitor framing");
  }

  if (age == null) {
    score += 0.02;
  } else if (age <= 30) {
    score += 0.22;
    reasons.push("last 30 days");
  } else if (age <= 90) {
    score += 0.12;
    reasons.push("last 90 days");
  } else if (age <= 180) {
    score += 0.06;
    reasons.push("last 6 months");
  } else {
    score += 0.02;
    reasons.push("older than 6 months");
  }

  if (HOOK_VERBS.test(raw.title)) {
    score += 0.1;
    reasons.push("operating event");
  }

  const fit = roleFit(raw.kind, prospect.title);
  score += fit.points;
  reasons.push(fit.label);

  const pitch = offerFit(`${raw.title} ${raw.summary}`, prospect.senderOffer);
  if (pitch.points > 0) {
    score += pitch.points;
    reasons.push(`offer fit: ${pitch.hits.slice(0, 3).join(", ")}`);
  }

  if (
    INVESTOR_NOISE.test(raw.title) &&
    !hasPerson &&
    !/\b(files for ipo|will ipo|ipo on)\b/i.test(raw.title)
  ) {
    score -= 0.08;
    reasons.push("investor noise");
  }

  if (notes && notes.split(/\W+/).some((w) => w.length > 4 && raw.title.toLowerCase().includes(w))) {
    score += 0.08;
    reasons.push("overlaps SDR notes");
  }

  if (sensitive) {
    score -= 0.06;
    reasons.push("sensitive event — do not congratulate");
  }

  // Prefer keeping offer-aligned soft matches in the LLM pool
  const eligible = score >= 0.28 || hasExactCompany || hasPerson || pitch.points >= 0.14;
  return {
    ...raw,
    eligible,
    matchTier,
    sensitive,
    relevance: Math.min(0.99, Number(Math.max(0, score).toFixed(2))),
    why: eligible ? `Candidate (${matchTier}): ${reasons.join("; ")}.` : `Too weak: ${reasons.join("; ")}.`,
  };
}

export function collapseSameEvent(ranked: RankedSignal[], company: string): RankedSignal[] {
  const seen = new Set<string>();
  return ranked.map((s) => {
    if (!s.eligible || s.kind === "company") return s;
    const fp = eventFingerprint(s.title, company);
    if (seen.has(fp)) {
      return {
        ...s,
        eligible: false,
        relevance: Math.min(s.relevance, 0.16),
        why: "Dropped — same event as a stronger item already kept.",
      };
    }
    seen.add(fp);
    return s;
  });
}

const STOP = new Set([
  "with",
  "from",
  "that",
  "this",
  "have",
  "will",
  "about",
  "after",
  "into",
  "over",
  "than",
  "them",
  "they",
  "what",
  "when",
  "your",
  "could",
  "would",
  "should",
]);

function eventFingerprint(title: string, company: string): string {
  let t = title.toLowerCase().replace(/\s+[-–|:]\s+[^-]+$/, " ");
  for (const alias of companyAliases(company)) {
    t = t.replace(new RegExp(escapeRe(alias.toLowerCase()), "g"), " ");
  }
  if (/\bipo\b/.test(t)) return "ipo";
  if (/\b(series [a-f]|raises?|raised|funding)\b/.test(t)) return "funding";
  if (/\b(hiring|hires|hired|headcount)\b/.test(t)) return "hiring";
  if (/\b(stock sale|sell .+ stock|filed to sell|shares)\b/.test(t)) return "stock-sale";
  const words = t
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 5)
    .sort();
  return words.join("|") || t.trim().slice(0, 48);
}

/**
 * Distinctive tokens from a company name (drops legal + generic words).
 * Used for soft recall — LLM decides if a hit is the right entity.
 */
export function distinctiveCompanyTokens(company: string): string[] {
  const phrase = exactCompanyPhrase(company);
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

/**
 * Soft recall: keep items that might be about this company/person.
 * False positives (Cube Logic vs Cube Global) are OK here — LLM decides later.
 */
export function isSoftCandidate(
  text: string,
  company: string,
  fullName: string,
  linkedInTokens: string[] = []
): boolean {
  if (mentionsCompanyExact(text, company)) return true;
  if (mentionsPerson(text, fullName)) return true;
  for (const t of linkedInTokens) {
    if (t.length >= 4 && wordMatch(text, t)) return true;
  }
  return distinctiveCompanyTokens(company).some((t) => wordMatch(text, t));
}

/**
 * Prefer hooks that are (1) about this person+company, (2) relevant to what we sell, (3) high score.
 * Never pick a lookalike or person-only-other-employer item as the sendable hook.
 */
export function pickHook(ranked: RankedSignal[], prospect?: ProspectInput): RankedSignal | undefined {
  const eligible = ranked.filter((s) => s.eligible && s.kind !== "company");
  if (!eligible.length) return undefined;

  const companyTied = prospect
    ? eligible.filter((s) => mentionsCompanyExact(`${s.title} ${s.summary}`, prospect.company))
    : eligible;

  // Edge cases 1+2: lookalikes and person/org-split items cannot be the primary hook.
  const pool = companyTied.length ? companyTied : [];
  if (!pool.length) return undefined;

  const nonSensitive = pool.filter((s) => !s.sensitive && !isSensitiveHook(s.title, s.summary));
  const hookPool = nonSensitive.length ? nonSensitive : pool;

  const scored = hookPool.map((s) => {
    let score = s.relevance;
    if (prospect) {
      const text = `${s.title} ${s.summary}`;
      if (personCompanyLinked(text, prospect)) score += 0.14;
      else if (mentionsPerson(text, prospect.fullName) && mentionsCompanyExact(text, prospect.company)) {
        score += 0.1;
      }
      const pitch = offerFit(text, prospect.senderOffer);
      score += pitch.points;
      if (s.matchTier === "exact") score += 0.06;
      if (s.matchTier === "person") score += 0.05;
      if (s.matchTier === "suspect") score -= 0.08;
      if (s.sensitive) score -= 0.12;
    }
    return { s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.s;
}

export function wikiMatchesCompany(title: string, extract: string, company: string): boolean {
  if (mentionsCompanyExact(title, company) || mentionsCompanyExact(extract.slice(0, 200), company)) return true;
  // Single-token brands (Amazon) may match on the token alone; multi-word need the full phrase
  if (exactCompanyPhrase(company).split(/\s+/).length === 1) {
    return distinctiveCompanyTokens(company).some((t) => wordMatch(title, t) || wordMatch(extract.slice(0, 200), t));
  }
  return false;
}
