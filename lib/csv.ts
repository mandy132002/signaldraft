import type { ProspectInput } from "./types";

const MAX_ROWS = 40;

const ALIASES: Record<keyof ProspectInput, string[]> = {
  fullName: ["fullname", "name", "prospect", "prospectname", "contact"],
  title: ["title", "jobtitle", "role", "position"],
  company: ["company", "companyname", "org", "organization", "account"],
  linkedinUrl: ["linkedinurl", "linkedin", "linkedinprofile", "profileurl"],
  companyWebsite: [
    "companywebsite",
    "website",
    "companyurl",
    "companysite",
    "site",
    "homepage",
    "domain",
  ],
  notes: ["notes", "note", "context", "trigger"],
  senderName: ["sendername", "sdr", "fromname", "yourname"],
  senderCompany: ["sendercompany", "sdrcompany", "fromcompany", "yourcompany"],
  senderOffer: ["senderoffer", "offer", "product", "pitch", "whatyousell"],
};

function normHeader(h: string) {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Minimal CSV parser (quoted fields, commas, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export type CsvParseResult = {
  prospects: ProspectInput[];
  errors: string[];
  matchedColumns: string[];
};

export function prospectsFromCsv(
  text: string,
  defaults: { senderName: string; senderCompany: string; senderOffer: string }
): CsvParseResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2) {
    return { prospects: [], errors: ["CSV needs a header row and at least one prospect."], matchedColumns: [] };
  }

  const headers = rows[0].map(normHeader);
  const colIndex: Partial<Record<keyof ProspectInput, number>> = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [keyof ProspectInput, string[]][]) {
    const idx = headers.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colIndex[field] = idx;
  }

  if (colIndex.fullName == null || colIndex.company == null) {
    return {
      prospects: [],
      errors: ["CSV must include fullName (or name) and company columns."],
      matchedColumns: [],
    };
  }

  const matchedColumns = (Object.keys(colIndex) as (keyof ProspectInput)[]).filter((k) => colIndex[k] != null);

  const prospects: ProspectInput[] = [];
  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    errors.push(`Only the first ${MAX_ROWS} rows will be processed (${dataRows.length} found).`);
  }

  dataRows.slice(0, MAX_ROWS).forEach((cells, i) => {
    const get = (key: keyof ProspectInput) => {
      const idx = colIndex[key];
      if (idx == null) return "";
      return (cells[idx] ?? "").trim();
    };
    const fullName = get("fullName");
    const company = get("company");
    if (!fullName || !company) {
      errors.push(`Row ${i + 2}: missing name or company — skipped.`);
      return;
    }
    prospects.push({
      fullName,
      title: get("title"),
      company,
      linkedinUrl: get("linkedinUrl") || undefined,
      companyWebsite: get("companyWebsite") || undefined,
      notes: get("notes") || undefined,
      senderName: get("senderName") || defaults.senderName,
      senderCompany: get("senderCompany") || defaults.senderCompany,
      senderOffer: get("senderOffer") || defaults.senderOffer,
    });
  });

  return { prospects, errors, matchedColumns };
}

export const CSV_TEMPLATE = `fullName,title,company,linkedinUrl,companyWebsite,notes
Jeff Bezos,Executive Chairman,Amazon,,https://www.amazon.com,
Satya Nadella,CEO,Microsoft,,https://www.microsoft.com,
`;

export const MAX_BULK_ROWS = MAX_ROWS;
