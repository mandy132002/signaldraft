/**
 * Shared HTML fetch + meta extraction for LinkedIn / company websites.
 * Sites often block scrapers — we still best-effort pull public meta/JSON-LD.
 */

export async function fetchHtml(url: string, timeoutMs = 10000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (ctype && !/html|xml|text/i.test(ctype)) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function metaContent(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m = html.match(re);
  const val = decodeEntities((m?.[1] || m?.[2] || "").replace(/\s+/g, " ").trim());
  return val || undefined;
}

export function tagText(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  if (!m?.[1]) return undefined;
  const t = stripTags(m[1]).slice(0, 300);
  return t || undefined;
}

/** Pull Organization / WebSite name + description from JSON-LD blocks. */
export function extractJsonLdOrg(html: string): { name?: string; description?: string; url?: string } {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "").trim();
    try {
      const parsed = JSON.parse(raw) as unknown;
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const hit = findOrgNode(node);
        if (hit) return hit;
      }
    } catch {
      /* ignore bad JSON-LD */
    }
  }
  return {};
}

function findOrgNode(node: unknown): { name?: string; description?: string; url?: string } | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    for (const child of obj["@graph"]) {
      const hit = findOrgNode(child);
      if (hit) return hit;
    }
  }
  const typ = String(obj["@type"] || "").toLowerCase();
  if (typ.includes("organization") || typ.includes("corporation") || typ.includes("website")) {
    return {
      name: typeof obj.name === "string" ? obj.name.slice(0, 120) : undefined,
      description: typeof obj.description === "string" ? obj.description.slice(0, 400) : undefined,
      url: typeof obj.url === "string" ? obj.url : undefined,
    };
  }
  return null;
}

/** First meaningful paragraphs from body text. */
export function extractLeadParagraphs(html: string, maxChars = 500): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || html;
  const cleaned = body
    .replace(/<(nav|footer|header|aside|form|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const paras = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1] || ""))
    .filter((p) => p.length >= 40 && !/cookie|subscribe|sign up|privacy policy/i.test(p));
  if (paras.length) return paras.slice(0, 2).join(" ").slice(0, maxChars);
  return stripTags(cleaned).slice(0, maxChars);
}

export function normalizeWebsiteUrl(raw?: string): { url: string; host: string; domain: string } | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    if (!u.hostname || u.hostname === "localhost") return null;
    if (!/\./.test(u.hostname)) return null;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    return {
      url: `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/$/, ""),
      host,
      domain: host,
    };
  } catch {
    return null;
  }
}
