import type { ProspectInput, Signal } from "./types";
import {
  extractJsonLdOrg,
  extractLeadParagraphs,
  fetchHtml,
  metaContent,
  normalizeWebsiteUrl,
  tagText,
} from "./scrape";
import { companyAliases, distinctiveCompanyTokens, exactCompanyPhrase, wordMatch } from "./relevance";

export type CompanySiteContext = {
  url: string;
  host: string;
  domain: string;
  title?: string;
  description?: string;
  orgName?: string;
  leadText?: string;
  fetched: boolean;
  /** Whether page text/name looks like the typed company */
  matchesCompany: boolean | null;
  note: string;
};

export function parseCompanyWebsite(raw?: string) {
  return normalizeWebsiteUrl(raw);
}

function pageConfirmsCompany(company: string, parts: (string | undefined)[]): boolean {
  const blob = parts.filter(Boolean).join(" ");
  if (!blob.trim()) return false;
  const aliases = companyAliases(company);
  if (aliases.some((a) => wordMatch(blob, a))) return true;
  const tokens = distinctiveCompanyTokens(company);
  if (tokens.length === 1 && tokens[0] && wordMatch(blob, tokens[0])) return true;
  return false;
}

/**
 * Fetch public company homepage meta + JSON-LD for disambiguation and context.
 * Tries https, then www if needed.
 */
export async function loadCompanyWebsiteContext(
  prospect: ProspectInput
): Promise<CompanySiteContext | null> {
  const parsed = parseCompanyWebsite(prospect.companyWebsite);
  if (!parsed) return null;

  const base: CompanySiteContext = {
    url: parsed.url,
    host: parsed.host,
    domain: parsed.domain,
    fetched: false,
    matchesCompany: null,
    note: `Company website provided: ${parsed.host}`,
  };

  const homeCandidates = [
    parsed.url,
    `https://${parsed.host}`,
    `https://www.${parsed.host}`,
  ].filter((u, i, a) => a.indexOf(u) === i);

  let html: string | null = null;
  let usedUrl = parsed.url;
  for (const url of homeCandidates) {
    html = await fetchHtml(url, 12000);
    if (html && html.length > 200) {
      usedUrl = url;
      break;
    }
  }

  if (!html) {
    base.note = `Could not fetch ${parsed.host} (blocked or unreachable). Domain still used for news search.`;
    return base;
  }

  // Enrich thin/JS-heavy homepages from common about/product paths
  let ogTitle = metaContent(html, "og:title") || metaContent(html, "twitter:title") || tagText(html, "title");
  let ogDesc =
    metaContent(html, "og:description") ||
    metaContent(html, "twitter:description") ||
    metaContent(html, "description");
  let jsonLd = extractJsonLdOrg(html);
  let lead = extractLeadParagraphs(html, 480);

  const thin = !(ogDesc && ogDesc.length > 40) && !(lead && lead.length > 80) && !jsonLd.name;
  if (thin) {
    const origin = usedUrl.replace(/\/$/, "");
    for (const path of ["/about", "/about-us", "/company", "/product", "/products"]) {
      const extra = await fetchHtml(`${origin}${path}`, 8000);
      if (!extra || extra.length < 200) continue;
      const d =
        metaContent(extra, "og:description") ||
        metaContent(extra, "description") ||
        extractLeadParagraphs(extra, 480);
      const t = metaContent(extra, "og:title") || tagText(extra, "title");
      const ld = extractJsonLdOrg(extra);
      if (d && d.length > (ogDesc?.length || 0)) ogDesc = d;
      if (t && !ogTitle) ogTitle = t;
      if (ld.name && !jsonLd.name) jsonLd = { ...jsonLd, ...ld };
      if (d && d.length > (lead?.length || 0)) lead = d;
      if ((ogDesc && ogDesc.length > 60) || (lead && lead.length > 100)) break;
    }
  }

  base.url = usedUrl;
  base.fetched = true;
  base.title = (ogTitle || jsonLd.name || "").slice(0, 160) || undefined;
  base.description = (ogDesc || jsonLd.description || "").slice(0, 420) || undefined;
  base.orgName = jsonLd.name?.slice(0, 120);
  base.leadText = lead || undefined;
  base.matchesCompany = pageConfirmsCompany(prospect.company, [
    base.title,
    base.orgName,
    base.description,
    base.leadText,
    parsed.host,
  ]);

  if (base.matchesCompany) {
    base.note = `Fetched ${parsed.host} — page matches "${exactCompanyPhrase(prospect.company)}".`;
  } else if (base.title || base.description) {
    base.note = `Fetched ${parsed.host} — weak name match to typed company "${prospect.company}". Domain still used for search.`;
  } else {
    base.note = `Fetched ${parsed.host} but little readable text (JS-heavy site). Domain still used for search.`;
  }

  return base;
}

/** Domain / host phrases for news search & workplace matching. */
export function companyWebsiteSearchPhrases(site?: CompanySiteContext | null): string[] {
  if (!site) return [];
  const out: string[] = [site.host, site.domain];
  const host = site.host.replace(/^www\./, "");
  const root = host.split(".")[0];
  if (root && root.length >= 3) out.push(root);
  if (site.orgName && site.orgName.length >= 2) out.push(site.orgName);
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))].slice(0, 5);
}

export function companyWebsiteAsSignal(site: CompanySiteContext, company: string): Signal {
  const summary = [site.description, site.leadText].filter(Boolean).join(" ").slice(0, 420);
  return {
    id: `site-${site.host.replace(/[^a-z0-9]+/gi, "-")}`,
    kind: "company",
    title: `${site.orgName || site.title || site.host} — company website`,
    summary: summary || `Public homepage for ${company} (${site.host}).`,
    source: "Company website",
    url: site.url,
    relevance: 0.4,
    why: site.note,
    matchTier: "context",
    eligible: false,
  };
}

/**
 * Merge LinkedIn + company-website hints so ranking / entity safety nets
 * treat domains like cube.dev the same whether they came from LinkedIn or the site field.
 */
export function mergeWorkplaceContext(
  linkedIn: {
    url?: string;
    vanity?: string;
    profileHint?: string;
    headline?: string;
    about?: string;
    employerHints?: string[];
    domainHints?: string[];
    employerMatchesCompany?: boolean | null;
    fetched?: boolean;
    note?: string;
  } | null,
  site: CompanySiteContext | null
): {
  url: string;
  vanity?: string;
  profileHint?: string;
  headline?: string;
  about?: string;
  employerHints: string[];
  domainHints: string[];
  employerMatchesCompany: boolean | null;
  fetched: boolean;
  note: string;
} | null {
  if (!linkedIn && !site) return null;

  const siteDomains = companyWebsiteSearchPhrases(site).filter((p) => p.includes("."));
  const siteNames: string[] = [];
  if (site?.orgName) siteNames.push(site.orgName);
  if (site?.matchesCompany && site.title) {
    const short = site.title.split(/[|·•\-–—]/)[0]?.trim();
    if (short && short.length >= 2 && short.length <= 60) siteNames.push(short);
  }

  const seen = new Set<string>();
  const uniq = (xs: string[]) => {
    const out: string[] = [];
    for (const x of xs) {
      const k = x.toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(x.trim());
    }
    return out;
  };

  const employerHints = uniq([...(linkedIn?.employerHints || []), ...siteNames]);
  const domainHints = uniq([
    ...(linkedIn?.domainHints || []),
    ...siteDomains,
    ...(site ? [site.host] : []),
  ]);

  const li = linkedIn?.employerMatchesCompany;
  const si = site?.matchesCompany ?? null;
  let employerMatchesCompany: boolean | null = null;
  if (li === true || si === true) {
    // Explicit LinkedIn or page-text confirmation
    employerMatchesCompany = true;
  } else if (site && si == null) {
    // SDR typed the website — treat domain as confirmed even if scrape was blocked
    employerMatchesCompany = true;
  } else if (li == null && si == null) {
    employerMatchesCompany = null;
  } else if (li === false || si === false) {
    employerMatchesCompany = false;
  }

  const notes = [linkedIn?.note, site?.note].filter(Boolean).join(" · ");

  return {
    url: linkedIn?.url || site!.url,
    vanity: linkedIn?.vanity,
    profileHint: linkedIn?.profileHint,
    headline: linkedIn?.headline || site?.title,
    about: linkedIn?.about || [site?.description, site?.leadText].filter(Boolean).join(" ").slice(0, 400),
    employerHints,
    domainHints,
    employerMatchesCompany,
    fetched: Boolean(linkedIn?.fetched || site?.fetched),
    note: notes || "Workplace context from LinkedIn / company website.",
  };
}
