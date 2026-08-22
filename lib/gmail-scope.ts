export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export function hasGmailScope(scope: string | null | undefined) {
  if (!scope) return false;
  const parts = scope.split(/[\s,]+/).filter(Boolean);
  return parts.includes(GMAIL_SCOPE) || parts.some((p) => p.includes("gmail"));
}
