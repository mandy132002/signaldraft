import { XMLParser } from "fast-xml-parser";
import {
  companyWebsiteAsSignal,
  companyWebsiteSearchPhrases,
  loadCompanyWebsiteContext,
  mergeWorkplaceContext,
} from "./company-site";
import { linkedInHintTokens, linkedInCompanySearchPhrases, loadLinkedInContext, parseLinkedInUrl } from "./linkedin";
import { offerKeywords, offerNewsQueryClause } from "./offer";
import {
  distinctiveCompanyTokens,
  exactCompanyPhrase,
  isAmbiguousCompanyName,
  isSoftCandidate,
  kindFromTitle,
  pickHook,
  rankSignals,
  wikiMatchesCompany,
  type RankedSignal,
} from "./relevance";
import type { ProspectInput, Signal } from "./types";

const UA =
  "Mozilla/5.0 (compatible; SignalDraft/1.0; +https://localhost research bot for demo)";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/html, application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeHtml(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function idFrom(prefix: string, value: string) {
  const hash = Array.from(value).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
  return `${prefix}-${hash.toString(16)}`;
}

type RssItem = {
  title?: string;
  link?: string | { href?: string };
  pubDate?: string;
  published?: string;
  description?: string;
  summary?: string;
  source?: string | { url?: string };
};

function itemsFromRss(xml: string): RssItem[] {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.feed;
  const raw = channel?.item ?? channel?.entry ?? [];
  return Array.isArray(raw) ? raw : [raw];
}

function linkOf(item: RssItem): string {
  if (typeof item.link === "string") return item.link;
  if (item.link?.href) return item.link.href;
  return "";
}

function quoted(phrase: string) {
  return `"${phrase.replace(/"/g, "")}"`;
}

export async function wikipediaCompany(company: string): Promise<Signal | null> {
  const phrase = exactCompanyPhrase(company);
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    `"${phrase}"`
  )}&utf8=&format=json&origin=*`;
  const searchJson = JSON.parse(await fetchText(searchUrl));
  const hits = (searchJson?.query?.search ?? []) as { title: string }[];
  let hit = hits.find((h) => wikiMatchesCompany(h.title, h.title, company));

  if (!hit) {
    const looseUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      phrase
    )}&utf8=&format=json&origin=*`;
    const loose = JSON.parse(await fetchText(looseUrl));
    const looseHits = (loose?.query?.search ?? []) as { title: string }[];
    hit = looseHits.find((h) => wikiMatchesCompany(h.title, h.title, company));
  }
  if (!hit?.title) return null;
  return loadWikiSummary(hit.title, company);
}

async function loadWikiSummary(pageTitle: string, company: string): Promise<Signal | null> {
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
  const summary = JSON.parse(await fetchText(summaryUrl));
  const extract = summary?.extract as string | undefined;
  if (!extract) return null;
  if (!wikiMatchesCompany(summary.title ?? pageTitle, extract, company)) return null;
  return {
    id: idFrom("wiki", pageTitle),
    kind: "company",
    title: `${summary.title ?? pageTitle} — company snapshot`,
    summary: extract.slice(0, 420),
    source: "Wikipedia",
    url: summary?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`,
    relevance: 0.35,
    why: "Background — company context for LLM.",
    matchTier: "context",
  };
}

export async function googleNewsSignals(
  query: string,
  kindHint: string,
  company: string,
  fullName: string,
  linkedInTokens: string[],
  limit = 16,
  extraSoftTokens: string[] = []
): Promise<Signal[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(url);
  const softTokens = [...linkedInTokens, ...extraSoftTokens];
  return itemsFromRss(xml)
    .slice(0, limit)
    .map((item) => {
      const title = decodeHtml(String(item.title ?? ""));
      const summary = decodeHtml(String(item.description ?? item.summary ?? title));
      return {
        id: idFrom("news", title + linkOf(item)),
        kind: kindFromTitle(title, kindHint),
        title,
        summary: summary.slice(0, 360),
        source: "Google News",
        url: linkOf(item),
        publishedAt: item.pubDate ?? item.published,
        relevance: 0,
        why: "",
      } satisfies Signal;
    })
    .filter((s) => {
      const blob = `${s.title} ${s.summary}`;
      if (isSoftCandidate(blob, company, fullName, softTokens)) return true;
      return extraSoftTokens.some((t) => t.length >= 3 && blob.toLowerCase().includes(t.toLowerCase()));
    });
}

export async function hnMentions(
  company: string,
  fullName: string,
  linkedInTokens: string[],
  offer?: string
): Promise<Signal[]> {
  const phrase = exactCompanyPhrase(company);
  const tokens = distinctiveCompanyTokens(company);
  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 540;
  // Quoted full name first. Never search a lone first token of a multi-word company
  // ("cube" for Cube Global → Cube Logic / CUBE collisions).
  const queries = [phrase];
  if (tokens.length === 1 && tokens[0] && tokens[0].toLowerCase() !== phrase.toLowerCase()) {
    queries.push(tokens[0]);
  }
  const offerTok = offerKeywords(offer)[0];
  if (offerTok) queries.push(`${phrase} ${offerTok}`);

  const out: Signal[] = [];
  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
      q
    )}&tags=story&hitsPerPage=12&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;
    try {
      const json = JSON.parse(await fetchText(url));
      const hits = Array.isArray(json?.hits) ? json.hits : [];
      for (const h of hits) {
        if (!h.title || !isSoftCandidate(h.title, company, fullName, linkedInTokens)) continue;
        out.push({
          id: idFrom("hn", String(h.objectID)),
          kind: kindFromTitle(h.title, "product"),
          title: h.title,
          summary: `Hacker News discussion${h.points ? ` (${h.points} points)` : ""}.`,
          source: "Hacker News",
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          publishedAt: h.created_at,
          relevance: 0,
          why: "",
        });
      }
    } catch {
      /* ignore one HN query failure */
    }
  }
  return out;
}

export { pickHook };

export async function researchProspect(
  input: ProspectInput,
  preloaded?: {
    linkedIn?: Awaited<ReturnType<typeof loadLinkedInContext>>;
    companySite?: Awaited<ReturnType<typeof loadCompanyWebsiteContext>>;
  }
): Promise<{
  signals: RankedSignal[];
  notes: string[];
  kept: number;
  dropped: number;
  linkedIn: Awaited<ReturnType<typeof loadLinkedInContext>>;
  companySite: Awaited<ReturnType<typeof loadCompanyWebsiteContext>>;
}> {
  const notes: string[] = [];
  const phrase = exactCompanyPhrase(input.company);
  const qCompany = quoted(phrase);
  const personQuoted = quoted(input.fullName.trim());
  const linkedIn =
    preloaded && "linkedIn" in preloaded ? preloaded.linkedIn ?? null : await loadLinkedInContext(input);
  const companySite =
    preloaded && "companySite" in preloaded
      ? preloaded.companySite ?? null
      : await loadCompanyWebsiteContext(input);
  const workplace = mergeWorkplaceContext(linkedIn, companySite);
  const liTokens = linkedInHintTokens(linkedIn?.vanity || parseLinkedInUrl(input.linkedinUrl)?.vanity);
  const workplacePhrases = [
    ...linkedInCompanySearchPhrases(input.company, linkedIn),
    ...companyWebsiteSearchPhrases(companySite),
  ].filter((p, i, a) => a.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i);
  const softToken = distinctiveCompanyTokens(input.company)[0];
  const offerClause = offerNewsQueryClause(input.senderOffer);
  const offerKws = offerKeywords(input.senderOffer);

  notes.push(`Company phrase: ${qCompany} (soft recall + LLM entity check)`);
  if (offerKws.length) {
    notes.push(`Offer themes for research: ${offerKws.slice(0, 8).join(", ")}`);
  }
  if (linkedIn) {
    notes.push(`LinkedIn: ${linkedIn.url} · ${linkedIn.note}`);
    if (linkedIn.employerHints.length) {
      notes.push(`LinkedIn employer hints: ${linkedIn.employerHints.join(", ")}`);
    }
    if (linkedIn.domainHints.length) {
      notes.push(`LinkedIn domains: ${linkedIn.domainHints.join(", ")}`);
    }
  } else {
    notes.push("No LinkedIn URL provided.");
  }
  if (companySite) {
    notes.push(`Company website: ${companySite.url} · ${companySite.note}`);
    if (companySite.orgName) notes.push(`Website org name: ${companySite.orgName}`);
  } else {
    notes.push("No company website provided.");
  }
  if (isAmbiguousCompanyName(input.company) && workplace?.employerMatchesCompany !== true) {
    notes.push(
      `Ambiguous company name "${input.company}" — add LinkedIn and/or company website (e.g. cube.dev) to pick the right org.`
    );
  }

  const tasks: Promise<Signal[]>[] = [
    wikipediaCompany(input.company).then((s) => {
      notes.push(s ? "Wikipedia: candidate page found." : "Wikipedia: no page.");
      return s ? [s] : [];
    }),
    googleNewsSignals(`${qCompany} when:6m`, "news", input.company, input.fullName, liTokens, 18).then((s) => {
      notes.push(`Quoted company news (6m): ${s.length}`);
      return s;
    }),
    googleNewsSignals(
      `${qCompany} (earnings OR revenue OR results OR guidance OR outlook) when:1y`,
      "news",
      input.company,
      input.fullName,
      liTokens,
      12
    ).then((s) => {
      notes.push(`Earnings/outlook: ${s.length}`);
      return s;
    }),
    googleNewsSignals(
      `${qCompany} (raises OR raised OR funding OR IPO OR acquires OR acquisition OR partnership OR launch OR launches) when:2y`,
      "funding",
      input.company,
      input.fullName,
      liTokens,
      14
    ).then((s) => {
      notes.push(`Funding/M&A/launch: ${s.length}`);
      return s;
    }),
    googleNewsSignals(`${personQuoted} ${qCompany} when:3y`, "person", input.company, input.fullName, liTokens, 14).then(
      (s) => {
        notes.push(`Person + company: ${s.length}`);
        return s;
      }
    ),
    googleNewsSignals(`${personQuoted} when:2y`, "person", input.company, input.fullName, liTokens, 12).then((s) => {
      notes.push(`Person-only news: ${s.length}`);
      return s;
    }),
  ];

  if (softToken) {
    tasks.push(
      googleNewsSignals(
        `${softToken} ${input.company.split(/\s+/).slice(1).join(" ")} when:2y`.trim(),
        "news",
        input.company,
        input.fullName,
        liTokens,
        12
      ).then((s) => {
        notes.push(`Soft-token news: ${s.length}`);
        return s;
      })
    );
  }

  if (offerClause) {
    tasks.push(
      googleNewsSignals(
        `${qCompany} (${offerClause}) when:2y`,
        "product",
        input.company,
        input.fullName,
        liTokens,
        18
      ).then((s) => {
        notes.push(`Offer-themed company news: ${s.length}`);
        return s;
      }),
      googleNewsSignals(
        `${personQuoted} (${offerClause}) when:3y`,
        "person",
        input.company,
        input.fullName,
        liTokens,
        12
      ).then((s) => {
        notes.push(`Offer-themed person news: ${s.length}`);
        return s;
      })
    );
  }

  if (liTokens.length) {
    tasks.push(
      googleNewsSignals(
        `${quoted(liTokens.slice(0, 2).join(" "))} ${qCompany} when:3y`,
        "person",
        input.company,
        input.fullName,
        liTokens,
        10
      ).then((s) => {
        notes.push(`LinkedIn-slug news: ${s.length}`);
        return s;
      })
    );
  }

  // Same-name companies: search LinkedIn / website workplace aliases / domains (cube.dev, etc.)
  for (const phraseExtra of workplacePhrases.slice(0, 5)) {
    const qExtra = quoted(phraseExtra);
    tasks.push(
      googleNewsSignals(
        `${qExtra} when:2y`,
        "product",
        input.company,
        input.fullName,
        liTokens,
        12,
        workplacePhrases
      ).then((s) => {
        notes.push(`Workplace/domain news (${phraseExtra}): ${s.length}`);
        return s;
      }),
      googleNewsSignals(
        `${personQuoted} ${qExtra} when:3y`,
        "person",
        input.company,
        input.fullName,
        liTokens,
        10,
        workplacePhrases
      ).then((s) => {
        notes.push(`Person + workplace/domain (${phraseExtra}): ${s.length}`);
        return s;
      })
    );
  }

  tasks.push(
    hnMentions(input.company, input.fullName, liTokens, input.senderOffer).then((s) => {
      notes.push(`Hacker News: ${s.length}`);
      return s;
    })
  );

  const settled = await Promise.allSettled(tasks);
  const all: Signal[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
    else notes.push(`Source failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  }

  if (companySite) {
    all.push(companyWebsiteAsSignal(companySite, input.company));
  }

  const dedup = new Map<string, Signal>();
  for (const s of all) {
    const key = s.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 90);
    const prev = dedup.get(key);
    if (!prev) dedup.set(key, s);
    else if ((s.publishedAt ?? "") > (prev.publishedAt ?? "")) dedup.set(key, s);
  }

  const ranked = rankSignals([...dedup.values()], input, workplace);
  const kept = ranked.filter((s) => s.eligible).length;
  const dropped = ranked.filter((s) => !s.eligible && s.kind !== "company").length;
  const offerAligned = ranked.filter((s) => s.eligible && /offer fit:/i.test(s.why || "")).length;
  notes.push(
    `Soft-ranked ${ranked.length} → ${kept} candidates for LLM entity check (${offerAligned} offer-aligned), ${dropped} weak.`
  );
  return { signals: ranked, notes, kept, dropped, linkedIn, companySite };
}
