import type { ProspectInput } from "./types";

const STOP = new Set([
  "with", "from", "that", "this", "have", "will", "about", "after", "into", "over", "than",
  "them", "they", "what", "when", "your", "could", "would", "should", "their", "there",
  "software", "platform", "solution", "solutions", "product", "service", "services",
  "help", "helps", "using", "based", "make", "made", "large", "small", "modern",
]);

const THEME_MAP: [RegExp, string[]][] = [
  [
    /supply[\s-]?chain|logistics|inventory|warehouse|fulfillment|procurement|freight/,
    ["supply chain", "logistics", "inventory", "warehouse", "fulfillment", "shipping", "procurement"],
  ],
  [/visibility|track(ing)?|traceab|observab/, ["visibility", "tracking", "traceability", "observability"]],
  [/retail|e-?commerce|merchant|storefront|stores?\b/, ["retail", "e-commerce", "stores", "merchants"]],
  [
    /\bai\b|artificial intelligence|machine learning|\bllm\b|generative/,
    ["AI", "artificial intelligence", "machine learning", "generative AI"],
  ],
  [/cloud|saas|\bdevops\b|infrastructure/, ["cloud", "SaaS", "infrastructure", "DevOps"]],
  [/cyber|security|secure|identity|fraud/, ["security", "cybersecurity", "identity", "fraud"]],
  [/payment|fintech|billing|invoice|treasury/, ["payments", "fintech", "billing", "treasury"]],
  [/talent|recruit|workforce|hr\b|people ops/, ["hiring", "talent", "workforce", "recruiting"]],
  [/sales|crm|gtm|pipeline|revenue/, ["sales", "CRM", "go-to-market", "revenue"]],
  [/data|analytics|insight|bi\b|warehouse/, ["data", "analytics", "insights"]],
  [/sustainab|energy|carbon|climate|emissions/, ["sustainability", "energy", "climate", "emissions"]],
  [/health|hospital|patient|pharma|life science/, ["healthcare", "hospital", "pharma"]],
  [/manufactur|factory|industrial|iot\b/, ["manufacturing", "industrial", "IoT"]],
  [/customer support|cx\b|contact center|helpdesk/, ["customer support", "CX", "contact center"]],
];

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

/** Expand the SDR offer into searchable / scorable themes + tokens. */
export function offerKeywords(offer: string | undefined | null): string[] {
  const raw = (offer || "").trim().toLowerCase();
  if (!raw) return [];

  const themes: string[] = [];
  for (const [re, words] of THEME_MAP) {
    if (re.test(raw)) themes.push(...words);
  }

  const tokens = raw
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));

  return unique([...themes, ...tokens]).slice(0, 18);
}

/** Google News OR-clause from offer themes (quoted multi-word phrases). */
export function offerNewsQueryClause(offer: string | undefined | null): string {
  const kws = offerKeywords(offer).slice(0, 8);
  if (!kws.length) return "";
  return kws.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(" OR ");
}

export function offerFit(
  text: string,
  offer: string | undefined | null
): { points: number; hits: string[] } {
  const kws = offerKeywords(offer);
  if (!kws.length) return { points: 0, hits: [] };
  const lower = text.toLowerCase();
  const hits = kws.filter((k) => lower.includes(k.toLowerCase()));
  if (!hits.length) return { points: 0, hits: [] };
  // Thematic overlap is a strong signal for which hook to pitch against
  const points = Math.min(0.32, 0.1 + hits.length * 0.045);
  return { points, hits: hits.slice(0, 6) };
}

export function offerLabel(prospect: ProspectInput): string {
  return (prospect.senderOffer || "").trim() || "our product";
}
