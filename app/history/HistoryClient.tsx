"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isHoldDraft, signalIsSensitive } from "@/lib/edge-cases";
import {
  CONFIDENCE_FILTER_OPTIONS,
  TIME_FRAME_OPTIONS,
  filterDashboardRuns,
  hasActiveDashboardFilters,
  type ConfidenceFilter,
  type TimeFrame,
} from "@/lib/dashboard-filters";
import type { RunRecord } from "@/lib/types";
import { Shell } from "../shell";
import { ClaudeSpark } from "../ClaudeSpark";
import { GmailDraftButton } from "../GmailDraftButton";
import { RefineEmailBox } from "../RefineEmailBox";
import { SignalsCheck } from "../SignalsCheck";
import { useLiveSession } from "../LiveSession";

function formatDuration(ms?: number) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatRunWhen(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  };
}

const PAGE_SIZE = 10;

export default function HistoryClient() {
  const search = useSearchParams();
  const { applyServerDraft } = useLiveSession();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [timeFrame, setTimeFrame] = useState<TimeFrame>("all");
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);

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

  const filtered = useMemo(
    () =>
      filterDashboardRuns(runs, {
        query: q,
        timeFrame,
        confidence: confidenceFilter,
      }),
    [runs, q, timeFrame, confidenceFilter]
  );

  const filtersActive = hasActiveDashboardFilters({
    query: q,
    timeFrame,
    confidence: confidenceFilter,
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pageRuns = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  useEffect(() => {
    setPage(1);
  }, [q, timeFrame, confidenceFilter]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Deep link ?run=… → open that row and jump to its page
  useEffect(() => {
    if (!open || !filtered.length) return;
    const idx = filtered.findIndex((r) => r.id === open);
    if (idx < 0) return;
    const target = Math.floor(idx / PAGE_SIZE) + 1;
    setPage((p) => (p === target ? p : target));
  }, [open, filtered]);

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
    <Shell wide>
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

      <div className="card dashboard-filters" style={{ marginBottom: 16 }}>
        <div className="dashboard-filters-grid">
          <div className="filter-field filter-field-wide">
            <label htmlFor="dashboard-search">Search saved emails</label>
            <input
              id="dashboard-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, company, subject…"
              disabled={loading}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-timeframe">Time frame</label>
            <select
              id="dashboard-timeframe"
              value={timeFrame}
              onChange={(e) => setTimeFrame(e.target.value as TimeFrame)}
              disabled={loading}
            >
              {TIME_FRAME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-confidence">Confidence</label>
            <select
              id="dashboard-confidence"
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
              disabled={loading}
            >
              {CONFIDENCE_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filtersActive ? (
          <div className="dashboard-filters-meta">
            <p className="hint" style={{ margin: 0 }}>
              Showing {filtered.length} of {runs.length} runs
              {filtersActive ? " · filters active" : ""}
            </p>
            <button
              type="button"
              className="btn ghost dashboard-clear-filters"
              disabled={loading}
              onClick={() => {
                setQ("");
                setTimeFrame("all");
                setConfidenceFilter("all");
                setPage(1);
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}
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
            <>
              <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Prospect</th>
                    <th>Status</th>
                    <th>Confidence</th>
                    <th>Email subject</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRuns.map((r) => {
                    const when = formatRunWhen(r.createdAt);
                    return (
                    <tr
                      className={`clickable ${r.id === open ? "selected-row" : ""}`}
                      key={r.id}
                      onClick={() => setOpen(r.id === open ? null : r.id)}
                    >
                      <td>
                        <span className="run-when">
                          <span>{when.date}</span>
                          <span>{when.time}</span>
                        </span>
                      </td>
                      <td>
                        {r.prospect.fullName}
                        <div style={{ color: "var(--muted)", fontSize: 12 }}>
                          {r.prospect.title} · {r.prospect.company}
                        </div>
                      </td>
                      <td>
                        <div className="run-status">
                          <span className={`badge ${r.status}`}>{r.status.replace("_", " ")}</span>
                          {r.status === "approved" || r.status === "rejected" ? (
                            <span className="run-status-note ok">email stored</span>
                          ) : r.draft?.body ? (
                            <span className="run-status-note">awaiting decision</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        {r.draft?.hold || (r.draft && isHoldDraft(r.draft)) ? (
                          <span className="badge hold">Hold</span>
                        ) : r.draft?.confidence ? (
                          <span className={`badge confidence-${r.draft.confidence}`}>
                            {r.draft.confidence}
                          </span>
                        ) : (
                          <span className="run-status-note">—</span>
                        )}
                      </td>
                      <td>
                        <span className="run-subject" title={r.draft?.subject ?? r.error ?? undefined}>
                          {r.draft?.subject ?? r.error ?? "—"}
                        </span>
                      </td>
                    </tr>
                    );
                  })}
                  {!filtered.length ? (
                    <tr>
                      <td colSpan={5} style={{ color: "var(--muted)" }}>
                        {runs.length
                          ? filtersActive
                            ? "No runs match your filters."
                            : "No matches."
                          : "No saved runs yet. Generate a draft from Live run."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              </div>

              {filtered.length > 0 ? (
                <div className="pagination" role="navigation" aria-label="Run history pages">
                  <p className="pagination-meta">
                    Showing {(safePage - 1) * PAGE_SIZE + 1}–
                    {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                    {filtersActive ? " filtered" : q.trim() ? " matches" : " runs"}
                  </p>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="btn ghost pagination-btn"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </button>
                    <span className="pagination-pages" aria-live="polite">
                      Page {safePage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn ghost pagination-btn"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="card stored-email">
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
                <br />
                {selected.status === "approved" || selected.status === "rejected"
                  ? `Stored · ${selected.status}`
                  : selected.status === "needs_review"
                    ? "Needs review — approve or reject to store"
                    : selected.status}
              </p>
              <SignalsCheck
                key={selected.id}
                signals={selected.signals ?? []}
                chosenId={selected.chosenSignal?.id}
                entityNote={selected.entityNote}
                variant="embedded"
              />
              <label>Subject</label>
              <input
                value={editSubject}
                onChange={(e) => setEditSubject(e.target.value)}
                disabled={refining}
              />
              <label>Body</label>
              <textarea
                className="draft"
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                disabled={refining}
              />
              <RefineEmailBox
                runId={selected.id}
                subject={editSubject}
                body={editBody}
                enabled={Boolean(selected.chosenSignal && !isHoldDraft(selected.draft))}
                disabled={saving || refining}
                onRefiningChange={setRefining}
                onRefined={({ subject, body, run }) => {
                  setEditSubject(subject);
                  setEditBody(body);
                  setRuns((prev) => prev.map((r) => (r.id === run.id ? run : r)));
                  applyServerDraft(selected.id, subject, body);
                  setSaveMsg("Refined");
                  window.setTimeout(() => setSaveMsg(null), 1600);
                }}
              />
              {selected.status === "needs_review" ? (
                <div className="actions">
                  <button
                    className="btn ok"
                    type="button"
                    disabled={saving || refining}
                    onClick={() => void decide("approved")}
                  >
                    {isHoldDraft(selected.draft) ? "Store hold (do not send)" : "Approve & store"}
                  </button>
                  <button
                    className="btn bad"
                    type="button"
                    disabled={saving || refining}
                    onClick={() => void decide("rejected")}
                  >
                    Reject & store
                  </button>
                </div>
              ) : null}
              <div className="actions">
                {dirty ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={saving || refining}
                    onClick={() => void saveEdits()}
                  >
                    {saving ? "Saving…" : "Save edits"}
                  </button>
                ) : null}
                <button
                  className="btn ghost"
                  type="button"
                  disabled={refining}
                  onClick={() => void copyText("email", `Subject: ${editSubject}\n\n${editBody}`)}
                >
                  {copied === "email" ? "Copied" : "Copy email"}
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                {isHoldDraft(selected.draft) ? (
                  <p className="hint">Gmail is disabled — this hold is not an outreach email.</p>
                ) : (
                  <GmailDraftButton subject={editSubject} body={editBody} disabled={refining || !editBody.trim()} />
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
