import { ObjectId } from "mongodb";
import { getDb } from "./mongodb";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export type GoogleTokenBundle = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
};

type GoogleAccount = GoogleTokenBundle & {
  userId: unknown;
  provider?: string;
};

export function hasGmailScope(scope: string | null | undefined) {
  if (!scope) return false;
  const parts = scope.split(/[\s,]+/).filter(Boolean);
  return parts.includes(GMAIL_SCOPE) || parts.some((p) => p.includes("gmail"));
}

function userIdClauses(userId: string): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [{ userId }, { userId: String(userId) }];
  if (ObjectId.isValid(userId)) {
    clauses.push({ userId: new ObjectId(userId) });
  }
  return clauses;
}

async function accountsCollection() {
  const db = await getDb();
  return db.collection<GoogleAccount>("accounts");
}

export async function findGoogleAccount(userId: string): Promise<GoogleAccount | null> {
  const col = await accountsCollection();
  return col.findOne({ provider: "google", $or: userIdClauses(userId) });
}

/** Auth.js JWT mode does not refresh account tokens on re-login — we write them ourselves. */
export async function upsertGoogleOAuthTokens(userId: string, account: GoogleTokenBundle) {
  if (!account.access_token && !account.refresh_token && !account.scope) return;

  const col = await accountsCollection();
  const set: Record<string, unknown> = {};
  if (account.access_token) set.access_token = account.access_token;
  if (typeof account.expires_at === "number") set.expires_at = account.expires_at;
  if (account.scope) set.scope = account.scope;
  if (account.refresh_token) set.refresh_token = account.refresh_token;

  if (Object.keys(set).length === 0) return;

  await col.updateOne(
    { provider: "google", $or: userIdClauses(userId) },
    { $set: set }
  );
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_at: number;
  refresh_token?: string;
  scope?: string;
} | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("Google token refresh failed", await res.text());
    return null;
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  if (!json.access_token) return null;
  return {
    access_token: json.access_token,
    expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
    refresh_token: json.refresh_token,
    scope: json.scope,
  };
}

/**
 * Resolve a usable Google access token.
 * Prefer fresh JWT tokens (from latest OAuth consent), then MongoDB account row.
 */
export async function getGoogleAccessToken(
  userId: string,
  jwtTokens?: GoogleTokenBundle | null
): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; code: "NO_ACCOUNT" | "NEEDS_GMAIL_SCOPE" | "REFRESH_FAILED" }
> {
  const account = await findGoogleAccount(userId);

  const scope = jwtTokens?.scope || account?.scope;
  const accessToken = jwtTokens?.access_token || account?.access_token;
  const refreshToken = jwtTokens?.refresh_token || account?.refresh_token;
  const expiresAt = jwtTokens?.expires_at ?? account?.expires_at ?? 0;

  if (!account && !jwtTokens?.access_token && !jwtTokens?.refresh_token) {
    return { ok: false, code: "NO_ACCOUNT" };
  }

  if (!hasGmailScope(scope)) {
    return { ok: false, code: "NEEDS_GMAIL_SCOPE" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (accessToken && expiresAt > now + 60) {
    return { ok: true, accessToken };
  }

  if (!refreshToken) return { ok: false, code: "NEEDS_GMAIL_SCOPE" };

  const refreshed = await refreshAccessToken(refreshToken);
  if (!refreshed) return { ok: false, code: "REFRESH_FAILED" };

  await upsertGoogleOAuthTokens(userId, {
    access_token: refreshed.access_token,
    expires_at: refreshed.expires_at,
    refresh_token: refreshed.refresh_token,
    scope: refreshed.scope || scope,
  });

  return { ok: true, accessToken: refreshed.access_token };
}

function toBase64Url(raw: string) {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeHeaderValue(value: string) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildGmailRawMessage(input: {
  to?: string;
  subject: string;
  body: string;
}) {
  const to = (input.to || "").trim();
  const subject = encodeHeaderValue((input.subject || "").replace(/[\r\n]+/g, " ").trim() || "(no subject)");
  const body = (input.body || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");

  const lines = [
    ...(to ? [`To: ${to}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  ];
  return toBase64Url(lines.join("\r\n"));
}

export async function createGmailDraft(input: {
  userId: string;
  subject: string;
  body: string;
  to?: string;
  jwtTokens?: GoogleTokenBundle | null;
}): Promise<
  | { ok: true; draftId: string; messageId?: string }
  | { ok: false; code: string; error: string; activationUrl?: string }
> {
  const token = await getGoogleAccessToken(input.userId, input.jwtTokens);
  if (!token.ok) {
    const messages: Record<string, string> = {
      NO_ACCOUNT: "Google account not linked. Sign in with Google again.",
      NEEDS_GMAIL_SCOPE:
        "Gmail draft permission is missing. Click Allow Gmail access, approve the prompt, then try again.",
      REFRESH_FAILED: "Could not refresh Google access. Sign out and sign in again.",
    };
    return { ok: false, code: token.code, error: messages[token.code] || "Unauthorized" };
  }

  const raw = buildGmailRawMessage({
    to: input.to,
    subject: input.subject,
    body: input.body,
  });

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Gmail draft create failed", res.status, text);

    let googleMessage = "";
    let activationUrl = "";
    try {
      const parsed = JSON.parse(text) as {
        error?: {
          message?: string;
          details?: Array<{
            reason?: string;
            metadata?: { activationUrl?: string };
            links?: Array<{ url?: string }>;
          }>;
        };
      };
      googleMessage = parsed.error?.message || "";
      for (const d of parsed.error?.details || []) {
        if (d.metadata?.activationUrl) activationUrl = d.metadata.activationUrl;
        if (d.links?.[0]?.url && !activationUrl) activationUrl = d.links[0].url;
      }
    } catch {
      /* ignore parse errors */
    }

    const apiDisabled =
      /Gmail API has not been used|SERVICE_DISABLED|accessNotConfigured|disabled/i.test(
        googleMessage || text
      );

    if (apiDisabled) {
      return {
        ok: false,
        code: "GMAIL_API_DISABLED",
        error:
          "Gmail API is disabled on your Google Cloud project. Enable it, wait ~1 minute, then try again.",
        activationUrl:
          activationUrl ||
          "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview",
      };
    }

    if (res.status === 403 || res.status === 401) {
      return {
        ok: false,
        code: "NEEDS_GMAIL_SCOPE",
        error: googleMessage
          ? `Gmail error: ${googleMessage}`
          : "Gmail rejected the request. Click Allow Gmail access and approve again.",
      };
    }
    return {
      ok: false,
      code: "GMAIL_ERROR",
      error: googleMessage || "Failed to create Gmail draft.",
    };
  }

  const json = (await res.json()) as { id?: string; message?: { id?: string } };
  return {
    ok: true,
    draftId: String(json.id || ""),
    messageId: json.message?.id,
  };
}
