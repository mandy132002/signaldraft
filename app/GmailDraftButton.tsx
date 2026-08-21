"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

type Props = {
  subject: string;
  body: string;
  /** Optional recipient email if you have one */
  to?: string;
  disabled?: boolean;
  className?: string;
};

function reconnectGoogleForGmail() {
  const callbackUrl = typeof window !== "undefined" ? window.location.href : "/";
  // Force a full consent so Auth.js receives a fresh account.scope + tokens
  // (JWT mode does not otherwise update MongoDB account rows).
  return signIn(
    "google",
    { callbackUrl },
    {
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        GMAIL_COMPOSE_SCOPE,
      ].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    }
  );
}

export function GmailDraftButton({ subject, body, to, disabled, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [activationUrl, setActivationUrl] = useState<string | null>(null);

  async function saveDraft() {
    if (busy || disabled || !body.trim()) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    setNeedsReconnect(false);
    setActivationUrl(null);
    try {
      const res = await fetch("/api/gmail/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          emailBody: body,
          to: to || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "GMAIL_API_DISABLED") {
          setErr(json.error || "Gmail API is disabled in Google Cloud");
          setActivationUrl(
            json.activationUrl ||
              "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=973413319659"
          );
          return;
        }
        if (json.code === "NEEDS_GMAIL_SCOPE" || json.code === "NO_ACCOUNT" || json.code === "REFRESH_FAILED") {
          setNeedsReconnect(true);
          setErr(json.error || "Gmail permission needed");
          return;
        }
        setErr(json.error || "Could not create Gmail draft");
        return;
      }
      setMsg("Saved to Gmail Drafts");
      window.setTimeout(() => setMsg(null), 4000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create Gmail draft");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className} style={{ width: "100%" }}>
      <button
        type="button"
        className="btn ghost gmail-draft-btn"
        disabled={disabled || busy || !body.trim()}
        onClick={() => void saveDraft()}
        style={{ width: "100%", marginTop: 0 }}
      >
        <span className="btn-inner">
          <GmailIcon />
          {busy ? "Saving to Gmail…" : "Add to Gmail drafts"}
        </span>
      </button>
      {msg ? (
        <p className="hint" style={{ color: "var(--ok)", marginTop: 8 }}>
          {msg}{" "}
          <a
            href="https://mail.google.com/mail/#drafts"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--copper-2)", textDecoration: "underline" }}
          >
            Open Drafts
          </a>
        </p>
      ) : null}
      {err ? (
        <p className="hint" style={{ color: "var(--bad)", marginTop: 8 }}>
          {err}{" "}
          {activationUrl ? (
            <a
              href={activationUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--copper-2)", textDecoration: "underline" }}
            >
              Enable Gmail API
            </a>
          ) : null}
          {needsReconnect ? (
            <button
              type="button"
              className="linkish"
              onClick={() => void reconnectGoogleForGmail()}
              style={{
                background: "none",
                border: 0,
                padding: 0,
                color: "var(--copper-2)",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Allow Gmail access
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function GmailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64 5.455 11.73v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.31-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
      />
      <path fill="#4285F4" d="M0 5.457v1.91l8.727 6.545L0 19.366z" opacity=".2" />
      <path fill="#34A853" d="M24 5.457v1.91l-8.727 6.545L24 19.366z" opacity=".2" />
    </svg>
  );
}
