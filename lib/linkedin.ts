import type { ProspectInput } from "./types";
import { companyAliases, distinctiveCompanyTokens, exactCompanyPhrase, wordMatch } from "./relevance";

export type LinkedInContext = {
  url: string;
  vanity?: string;
  profileHint?: string;
  headline?: string;
  about?: string;
  /** Employer / product strings parsed from public LinkedIn meta */
  employerHints: string[];
  /** Domains like cube.dev found in headline/about */
  domainHints: string[];
  /**
   * Whether LinkedIn text appears to confirm the typed prospect.company
   * (or a clear alias / domain for it). null = no LinkedIn workplace text.
   */
  employerMatchesCompany: boolean | null;
  fetched: boolean;
  note: string;
};

export function parseLinkedInUrl(raw?: string): { url: string; vanity?: string } | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, "")) && !u.hostname.endsWith(".linkedin.com")) {
      if (!u.hostname.includes("linkedin.com")) return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    let vanity: string | undefined;
    if (parts[0] === "in" && parts[1]) vanity = decodeURIComponent(parts[1]).replace(/\/$/, "");
    if (parts[0] === "company" && parts[1]) vanity = decodeURIComponent(parts[1]).replace(/\/$/, "");
    return { url: u.toString(), vanity };
  } catch {
    return null;
  }
}

/** Tokens from vanity slug useful for matching (santhosh-chandrashekar → names). */
export function linkedInHintTokens(vanity?: string): string[] {
  if (!vanity) return [];
  return vanity
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !["www", "http", "https", "com", "linkedin"].includes(t));
}

const EMPLOYER_STOP = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "the",
  "and",
  "at",
  "of",
  "for",
  "via",
  "with",
  "from",
  "linkedin",
  "profile",
  "official",
]);

function unique(xs: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

/**
 * Pull employer / brand strings from LinkedIn headline-style text.
 * Examples: "Delivery Manager at Cube" · "Colin Ross - Cube.dev" · "Engineer @ Stripe"
 */
export function extractEmployerHints(...blobs: (string | undefined)[]): string[] {
  const text = blobs.filter(Boolean).join(" · ");
  if (!text.trim()) return [];

  const hints: string[] = [];

  const atPatterns = [
    /\bat\s+([A-Z][A-Za-z0-9&.''\-\s]{1,48}?)(?:\s*[|·•,]|\s+[-–—]\s+|$)/g,
    /\b@\s*([A-Z][A-Za-z0-9&.''\-]{1,40})\b/g,
    /\b(?:currently|working)\s+(?:at|for)\s+([A-Z][A-Za-z0-9&.''\-\s]{1,48}?)(?:\s*[|·•,]|$)/gi,
  ];
  for (const re of atPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const raw = (m[1] || "").replace(/\s+/g, " ").trim();
      if (raw.length >= 2) hints.push(raw.replace(/[.,;:]+$/, ""));
    }
  }

  // "Name - Company" / "Title | Company" (last segment only if it looks like an employer)
  const tail = text.split(/\s[-–—|·•]\s/).map((p) => p.trim()).filter(Boolean);
  if (tail.length >= 2) {
    const last = tail[tail.length - 1]!;
    const cleaned = last.replace(/^(?:delivery manager|manager|engineer|director|vp|ceo|cto)\s+at\s+/i, "").trim();
    if (
      cleaned.length >= 2 &&
      cleaned.length <= 48 &&
      !/\b(linkedin|profile)\b/i.test(cleaned) &&
      !/\bat\s+/i.test(cleaned)
    ) {
      hints.push(cleaned.replace(/[.,;:]+$/, ""));
    }
  }

  return unique(hints).slice(0, 8);
}

/** Domains like cube.dev / browserstack.com appearing in LinkedIn text. */
export function extractDomainHints(...blobs: (string | undefined)[]): string[] {
  const text = blobs.filter(Boolean).join(" ");
  const out: string[] = [];
  const re = /\b([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|ai|dev|co|app|so|net|org))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[1]!.toLowerCase());
  }
  return unique(out).slice(0, 6);
}

/**
 * True when LinkedIn workplace text confirms the typed company
 * (exact alias, product domain, or same brand without a conflicting second name).
 */
export function linkedInConfirmsCompany(
  company: string,
  hints: string[],
  domains: string[] = []
): boolean {
  if (!company.trim()) return false;
  const aliases = companyAliases(company).map((a) => a.toLowerCase());
  const companyPhrase = exactCompanyPhrase(company).toLowerCase();
  const tokens = distinctiveCompanyTokens(company);

  for (const domain of domains) {
    const host = (domain.split(".")[0] || "").toLowerCase();
    if (!host) continue;
    if (host === companyPhrase.replace(/[^a-z0-9]+/g, "")) return true;
    if (tokens.includes(host)) return true;
    if (aliases.some((a) => host === a.replace(/[^a-z0-9]+/g, ""))) return true;
  }

  for (const hint of hints) {
    const h = hint.toLowerCase().trim();
    if (!h) continue;
    if (aliases.some((a) => h === a || wordMatch(hint, a))) {
      // "Cube Logistics" vs typed "Cube" — extra distinctive word ⇒ different org
      if (isConflictingEmployerHint(hint, company)) continue;
      return true;
    }
    // Cube.dev / Cube AI (generic second token) vs Cube
    if (h.startsWith(`${companyPhrase}.`) || h === `${companyPhrase}.dev`) return true;
    if (tokens.some((t) => h === t || h.startsWith(`${t}.`))) return true;
  }

  return false;
}

/** "Cube Logistics" does not confirm typed company "Cube". */
function isConflictingEmployerHint(hint: string, company: string): boolean {
  const phrase = exactCompanyPhrase(company);
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return false;
  const brand = tokens[0]!;
  const lower = hint.toLowerCase().trim();
  if (lower === brand) return false;
  if (lower.startsWith(`${brand}.`)) return false; // cube.dev
  const m = lower.match(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([a-z0-9][a-z0-9&'-]*)`));
  if (!m) return false;
  const next = m[1]!;
  if (["dev", "io", "ai", "hq", "inc", "llc", "ltd", "corp", "co"].includes(next)) return false;
  return true; // Cube Logistics, Cube Bikes, …
}

/** Extra search / match phrases from LinkedIn (domains + employer strings). */
export function linkedInCompanySearchPhrases(
  company: string,
  linkedIn?: Pick<LinkedInContext, "employerHints" | "domainHints" | "employerMatchesCompany"> | null
): string[] {
  if (!linkedIn?.employerMatchesCompany) return [];
  const out: string[] = [];
  for (const d of linkedIn.domainHints || []) out.push(d);
  for (const h of linkedIn.employerHints || []) {
    if (h.toLowerCase() === company.trim().toLowerCase()) continue;
    if (h.length >= 3 && h.length <= 48) out.push(h);
  }
  return unique(out).slice(0, 4);
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function metaContent(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m = html.match(re);
  return (m?.[1] || m?.[2] || "").replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Best-effort public LinkedIn context. LinkedIn often blocks scrapers —
 * we still always return vanity + URL for the LLM to use.
 */
export async function loadLinkedInContext(prospect: ProspectInput): Promise<LinkedInContext | null> {
  const parsed = parseLinkedInUrl(prospect.linkedinUrl);
  if (!parsed) return null;

  const base: LinkedInContext = {
    url: parsed.url,
    vanity: parsed.vanity,
    profileHint: parsed.vanity?.replace(/-/g, " "),
    employerHints: [],
    domainHints: [],
    employerMatchesCompany: null,
    fetched: false,
    note: "LinkedIn URL provided — using vanity/slug as identity hint.",
  };

  const html = await fetchText(parsed.url);
  if (!html) {
    base.note = "LinkedIn page not fetchable (common). Vanity slug still used for matching.";
    return base;
  }

  const title = metaContent(html, "og:title") || metaContent(html, "twitter:title");
  const desc = metaContent(html, "og:description") || metaContent(html, "description");
  if (title || desc) {
    base.fetched = true;
    base.headline = title?.slice(0, 200);
    base.about = desc?.slice(0, 400);
    base.employerHints = extractEmployerHints(title, desc).filter(
      (h) => !EMPLOYER_STOP.has(h.toLowerCase())
    );
    base.domainHints = extractDomainHints(title, desc, parsed.vanity);
    if (base.employerHints.length || base.domainHints.length) {
      base.employerMatchesCompany = linkedInConfirmsCompany(
        prospect.company,
        base.employerHints,
        base.domainHints
      );
      base.note = base.employerMatchesCompany
        ? `LinkedIn workplace confirms "${prospect.company}" (${[...base.employerHints, ...base.domainHints]
            .slice(0, 3)
            .join(", ")}).`
        : `LinkedIn workplace text found (${[...base.employerHints, ...base.domainHints]
            .slice(0, 3)
            .join(", ")}) — does not clearly match typed company "${prospect.company}".`;
    } else {
      base.note = "Pulled public meta from LinkedIn URL (no clear employer string).";
    }
  } else {
    base.note = "LinkedIn HTML returned but no useful meta — vanity slug still used.";
  }
  return base;
}
