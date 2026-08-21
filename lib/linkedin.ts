import type { ProspectInput } from "./types";

export type LinkedInContext = {
  url: string;
  vanity?: string;
  profileHint?: string;
  headline?: string;
  about?: string;
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
      // still allow linkedin.com paths
      if (!u.hostname.includes("linkedin.com")) return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    // /in/vanity or /company/slug
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
    base.note = "Pulled public meta from LinkedIn URL.";
  } else {
    base.note = "LinkedIn HTML returned but no useful meta — vanity slug still used.";
  }
  return base;
}
