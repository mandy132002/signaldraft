"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isHoldDraft, signalIsSensitive } from "@/lib/edge-cases";
import type { RunRecord } from "@/lib/types";
import { Shell } from "../shell";
import { ClaudeSpark } from "../ClaudeSpark";
import { GmailDraftButton } from "../GmailDraftButton";
import { useLiveSession } from "../LiveSession";

function formatDuration(ms?: number) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function HistoryClient() {
  const search = useSearchParams();
  const { applyServerDraft } = useLiveSession();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function load(opts?: { initial?: boolean }) {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const json = await res.json();
      setRuns(json.runs ?? []);
    } finally {
      if (opts?.initial) setLoading(false);
    }
  }

  useEffect(() => {
    void load({ initial: true });
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const id = search.get("run");
    if (id) setOpen(id);
  }, [search]);

  const selected = runs.find((r) => r.id === open);

  useEffect(() => {
    if (!selected?.draft) {
      setEditSubject("");
      setEditBody("");
      return;
    }
    // Load from server when switching runs only (avoid wiping edits on poll refresh)
    setEditSubject(selected.draft.subject);
    setEditBody(selected.draft.body);
    setSaveMsg(null);
  }, [selected?.id]);

  const dirty = Boolean(
    selected?.draft &&
      (editSubject !== selected.draft.subject || editBody !== selected.draft.body)
  );

  const kpis = useMemo(() => {
    const withEmail = runs.filter((r) => r.status === "approved" || r.status === "rejected").length;
    const review = runs.filter((r) => r.status === "needs_review").length;
    const approved = runs.filter((r) => r.status === "approved").length;
    return { total: runs.length, withEmail, review, approved };
  }, [runs]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((r) => {
      const hay = [
        r.prospect.fullName,
        r.prospect.company,
        r.prospect.title,
        r.draft?.subject,
        r.draft?.body,
        r.draft?.hook,
        r.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [runs, q]);

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied("failed");
    }
  }

  async function saveEdits() {
    if (!selected?.draft || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/runs/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          saveEdits: true,
          subject: editSubject,
          emailBody: editBody,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveMsg(json.error || "Save failed");
        return;
      }
      setRuns((prev) => prev.map((r) => (r.id === json.run.id ? json.run : r)));
      applyServerDraft(selected.id, editSubject, editBody);
      setSaveMsg("Saved");
      window.setTimeout(() => setSaveMsg(null), 1600);
    } finally {
      setSaving(false);
    }
  }

  async function decide(status: "approved" | "rejected") {
    if (!selected?.draft) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/runs/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          subject: editSubject,
          emailBody: editBody,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveMsg(json.error || "Failed");
        return;
      }
      setRuns((prev) => prev.map((r) => (r.id === json.run.id ? json.run : r)));
      applyServerDraft(selected.id, editSubject, editBody);
      setSaveMsg(status === "approved" ? "Approved & stored" : "Rejected & stored");
      window.setTimeout(() => setSaveMsg(null), 1800);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <div style={{ marginBottom: 24 }}>
        <p
          style={{
            margin: "0 0 8px",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--copper)",
            letterSpacing: "0.04em",
          }}
        >
          Dashboard
        </p>
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: "clamp(28px, 4vw, 36px)",
            fontWeight: 650,
            letterSpacing: "-0.035em",
            margin: "0 0 10px",
            lineHeight: 1.15,
          }}
        >
          Saved outreach
        </h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Open a run to review its email. Approve or reject items still in review. Edit and save anytime.
        </p>
      </div>
      <div className="kpis" aria-busy={loading}>
        {(
          [
            ["Runs", kpis.total],
            ["Emails stored", kpis.withEmail],
            ["Needs review", kpis.review],
            ["Approved", kpis.approved],
          ] as const
        ).map(([label, value]) => (
          <div className={`kpi ${loading ? "kpi-loading" : ""}`} key={label}>
            <b>{loading ? <span className="kpi-skeleton" aria-hidden /> : value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <label>Search saved emails</label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Prospect, company, subject, hook…"
          disabled={loading}
        />
      </div>

      <div className="history-layout">
        <div className="card">
          <h2>
            Run history{" "}
            {loading ? (
              <span style={{ marginLeft: 8, verticalAlign: "middle" }}>
                <ClaudeSpark size={16} />
              </span>
            ) : null}
          </h2>
          {loading ? (
            <div className="dashboard-loading" aria-live="polite">
              <ClaudeSpark size={22} />
              <p>Loading saved runs…</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Prospect</th>
                  <th>Status</th>
                  <th>Email subject</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    className={`clickable ${r.id === open ? "selected-row" : ""}`}
                    key={r.id}
                    onClick={() => setOpen(r.id === open ? null : r.id)}
                  >
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      {r.prospect.fullName}
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        {r.prospect.title} · {r.prospect.company}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${r.status}`}>{r.status.replace("_", " ")}</span>
                      {r.status === "approved" || r.status === "rejected" ? (
                        <div style={{ fontSize: 11, color: "var(--ok)", marginTop: 4 }}>email stored</div>
                      ) : r.draft?.body ? (
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>awaiting decision</div>
                      ) : null}
                    </td>
                    <td>{r.draft?.subject ?? r.error ?? "—"}</td>
                  </tr>
                ))}
                {!filtered.length ? (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--muted)" }}>
                      {runs.length ? "No matches." : "No saved runs yet. Generate a draft from Live run."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>
            Stored email {saveMsg ? <span className="badge needs_review">{saveMsg}</span> : null}
          </h2>
          {loading ? (
            <div className="dashboard-loading" aria-live="polite">
              <ClaudeSpark size={22} />
              <p>Loading email…</p>
            </div>
          ) : !selected ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Select a run on the left. Approve or reject on Live run to store the final email.
            </p>
          ) : !selected.draft ? (
            <p className="hint" style={{ marginTop: 0 }}>
              This run has no email draft (likely no confirmed hook).
            </p>
          ) : (
            <>
              {isHoldDraft(selected.draft) ? (
                <div className="callout hold">
                  <strong>Hold — do not send.</strong> No confirmed public hook for {selected.prospect.fullName} at{" "}
                  {selected.prospect.company}.
                </div>
              ) : selected.draft.sensitiveHook ||
                (selected.chosenSignal && signalIsSensitive(selected.chosenSignal)) ? (
                <div className="callout sensitive">
                  <strong>Sensitive public event.</strong> Review tone before you copy this to your mailbox.
                </div>
              ) : null}
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)" }}>
                To {selected.prospect.fullName} · {selected.prospect.company}
                <br />
                Hook: {selected.draft.hook}
                <br />
                {selected.draft.model}{" "}
                <span className={`badge confidence-${selected.draft.confidence}`}>
                  Confidence {selected.draft.confidence}
                </span>
                {selected.draft.hold ? " · hold" : ""}
                {selected.reviewNote ? ` · note: ${selected.reviewNote}` : ""}
                {selected.draft.confidenceWhy ? (
                  <>
                    <br />
                    {selected.draft.confidenceWhy}
                  </>
                ) : null}
                <br />
                {selected.status === "approved" || selected.status === "rejected"
                  ? `Stored · ${selected.status}`
                  : selected.status === "needs_review"
                    ? "Needs review — approve or reject to store"
                    : selected.status}
              </p>
              <label>Subject</label>
              <input value={editSubject} onChange={(e) => setEditSubject(e.target.value)} />
              <label>Body</label>
              <textarea className="draft" value={editBody} onChange={(e) => setEditBody(e.target.value)} />
              {selected.status === "needs_review" ? (
                <div className="actions">
                  <button className="btn ok" type="button" disabled={saving} onClick={() => void decide("approved")}>
                    {isHoldDraft(selected.draft) ? "Store hold (do not send)" : "Approve & store"}
                  </button>
                  <button className="btn bad" type="button" disabled={saving} onClick={() => void decide("rejected")}>
                    Reject & store
                  </button>
                </div>
              ) : null}
              <div className="actions">
                {dirty ? (
                  <button className="btn ghost" type="button" disabled={saving} onClick={() => void saveEdits()}>
                    {saving ? "Saving…" : "Save edits"}
                  </button>
                ) : null}
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => void copyText("email", `Subject: ${editSubject}\n\n${editBody}`)}
                >
                  {copied === "email" ? "Copied" : "Copy email"}
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                {isHoldDraft(selected.draft) ? (
                  <p className="hint">Gmail is disabled — this hold is not an outreach email.</p>
                ) : (
                  <GmailDraftButton subject={editSubject} body={editBody} disabled={!editBody.trim()} />
                )}
              </div>
              {selected.analysis ? (
                <p className="hint">
                  Sentiment: {selected.analysis.sentiment} — {selected.analysis.businessImpact}
                </p>
              ) : null}
              {selected.stages?.length ? (
                <div style={{ marginTop: 14 }}>
                  <div className="section-title" style={{ fontSize: 14 }}>
                    Stage timings
                  </div>
                  <ul className="stages" style={{ marginTop: 8 }}>
                    {selected.stages.map((s) => (
                      <li key={s.id}>
                        <div className="stage-icon">
                          <div className={`dot ${s.status}`} />
                        </div>
                        <div>
                          <div className="stage-label">{s.label}</div>
                        </div>
                        <div className="stage-time">{formatDuration(s.durationMs)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
