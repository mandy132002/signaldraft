"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Shell } from "../../shell";
import { ClaudeSpark } from "../../ClaudeSpark";
import { GmailDraftButton } from "../../GmailDraftButton";
import { bulkElapsedMs, summarizeBulk } from "@/lib/bulk-stats";
import type { BulkJob, BulkItem, RunRecord } from "@/lib/types";

type Summary = { total: number; done: number; failed: number; pending: number; running: number };

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function matchRun(item: BulkItem, runs: RunRecord[]): RunRecord | undefined {
  if (item.runId) {
    const byId = runs.find((r) => r.id === item.runId);
    if (byId) return byId;
  }
  return runs.find(
    (r) =>
      r.prospect.fullName.trim().toLowerCase() === item.prospect.fullName.trim().toLowerCase() &&
      r.prospect.company.trim().toLowerCase() === item.prospect.company.trim().toLowerCase()
  );
}

function queueLabel(item: BulkItem, run?: RunRecord): string {
  if (run?.status) return run.status.replace("_", " ");
  return item.status;
}

export default function BulkJobPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [job, setJob] = useState<BulkJob | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [processing, setProcessing] = useState(false);
  const [liveLabel, setLiveLabel] = useState("Loading…");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/bulk/${id}`, { cache: "no-store" });
    if (!res.ok) {
      setError("Bulk job not found");
      return null;
    }
    const json = await res.json();
    setJob(json.job);
    setRuns(json.runs ?? []);
    setSummary(json.summary ?? summarizeBulk(json.job));
    return json.job as BulkJob;
  }, [id]);

  const processBatch = useCallback(async (): Promise<boolean> => {
    const res = await fetch(`/api/bulk/${id}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    if (!res.ok || !res.body) {
      setError("Processing failed to start");
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let more = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.replace(/^data:\s*/, "");
        if (!line) continue;
        try {
          const payload = JSON.parse(line) as {
            type: string;
            job?: BulkJob;
            run?: RunRecord;
            summary?: Summary;
            more?: boolean;
            prospect?: { fullName: string; company: string };
            error?: string;
          };
          if (payload.job) {
            setJob(payload.job);
            setSummary(payload.summary ?? summarizeBulk(payload.job));
          } else if (payload.summary) {
            setSummary(payload.summary);
          }
          if (payload.type === "item_start" && payload.prospect) {
            setLiveLabel(`Researching ${payload.prospect.fullName} · ${payload.prospect.company}`);
          }
          if ((payload.type === "run_update" || payload.type === "item_done") && payload.run) {
            setRuns((prev) => {
              const idx = prev.findIndex((r) => r.id === payload.run!.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = payload.run!;
                return next;
              }
              return [...prev, payload.run!];
            });
          }
          if (payload.type === "done") {
            more = Boolean(payload.more);
          }
          if (payload.type === "error") {
            setError(payload.error || "Bulk processing error");
          }
        } catch {
          /* ignore */
        }
      }
    }
    await refresh();
    return more;
  }, [id, refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const j = await refresh();
      if (cancelled || !j) return;

      const needsWork = j.items.some((i) => i.status === "pending" || i.status === "running");
      if (!needsWork) {
        setLiveLabel(j.status === "completed" ? "All prospects processed" : "Ready to review");
        return;
      }

      setProcessing(true);
      setLiveLabel("Starting bulk research…");
      try {
        let more = true;
        let guard = 0;
        while (more && !cancelled && guard < 80) {
          more = await processBatch();
          guard += 1;
        }
        if (!cancelled) {
          const latest = await refresh();
          const still = latest?.items.some((i) => i.status === "pending");
          setLiveLabel(
            still
              ? "Paused — click Resume to continue"
              : "All prospects processed — review drafts below"
          );
        }
      } finally {
        if (!cancelled) setProcessing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live clock while job is in progress
  useEffect(() => {
    if (!job) return;
    const active =
      processing ||
      job.status === "running" ||
      job.items.some((i) => i.status === "pending" || i.status === "running");
    if (!active && job.completedAt) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [job, processing]);

  const reviewRuns = useMemo(() => {
    // One run per queue item (prefer linked), avoid double-counting orphans
    const linked = new Set<string>();
    const out: RunRecord[] = [];
    for (const item of job?.items || []) {
      const run = matchRun(item, runs);
      if (run?.draft && (run.status === "needs_review" || run.status === "approved" || run.status === "rejected")) {
        linked.add(run.id);
        out.push(run);
      }
    }
    for (const run of runs) {
      if (linked.has(run.id)) continue;
      if (run.draft && (run.status === "needs_review" || run.status === "approved" || run.status === "rejected")) {
        out.push(run);
      }
    }
    return out;
  }, [job?.items, runs]);

  const toReviewCount = useMemo(
    () => reviewRuns.filter((r) => r.status === "needs_review").length,
    [reviewRuns]
  );

  const selected =
    reviewRuns.find((r) => r.id === selectedRunId) ||
    reviewRuns.find((r) => r.status === "needs_review") ||
    reviewRuns[0];

  useEffect(() => {
    if (selected && selected.id !== selectedRunId) setSelectedRunId(selected.id);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected?.draft) {
      setSubject("");
      setBody("");
      return;
    }
    setSubject(selected.draft.subject);
    setBody(selected.draft.body);
    setNote(selected.reviewNote || "");
  }, [selected?.id]);

  const progressPct = summary
    ? Math.round(((summary.done + summary.failed) / Math.max(summary.total, 1)) * 100)
    : 0;

  const totalMs = job ? bulkElapsedMs(job, nowMs) : null;
  const canResume =
    !processing && Boolean(job?.items.some((i) => i.status === "pending" || i.status === "running"));

  async function resume() {
    if (processing || !job) return;
    setProcessing(true);
    setError(null);
    setLiveLabel("Resuming bulk research…");
    try {
      let more = true;
      let guard = 0;
      while (more && guard < 80) {
        more = await processBatch();
        guard += 1;
      }
      const latest = await refresh();
      const still = latest?.items.some((i) => i.status === "pending");
      setLiveLabel(
        still ? "Paused — click Resume to continue" : "All prospects processed — review drafts below"
      );
    } finally {
      setProcessing(false);
    }
  }

  async function decide(status: "approved" | "rejected") {
    if (!selected || acting) return;
    setActing(true);
    try {
      const res = await fetch(`/api/runs/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, subject, emailBody: body, reviewNote: note }),
      });
      const json = await res.json();
      if (res.ok && json.run) {
        setRuns((prev) => prev.map((r) => (r.id === json.run.id ? json.run : r)));
        const next = reviewRuns.find((r) => r.id !== selected.id && r.status === "needs_review");
        if (next) setSelectedRunId(next.id);
      }
    } finally {
      setActing(false);
    }
  }

  if (error && !job) {
    return (
      <Shell>
        <div className="card">
          <h2>Bulk job</h2>
          <p>{error}</p>
          <Link href="/bulk">← Back to Bulk</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="bulk-job-header">
        <div>
          <p className="hint" style={{ margin: 0 }}>
            <Link href="/bulk">Bulk</Link> / {job?.fileName || "…"}
          </p>
          <h1 className="bulk-job-title">Bulk review</h1>
          <p
            className="lede"
            style={{ marginBottom: 0, fontFamily: "var(--mono)", fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            {processing ? <ClaudeSpark size={16} /> : null}
            {liveLabel}
            {totalMs != null ? (
              <span style={{ color: "var(--copper-2)" }}>· {formatDuration(totalMs)} total</span>
            ) : null}
          </p>
          {canResume ? (
            <button className="btn" type="button" style={{ width: "auto", marginTop: 10 }} onClick={() => void resume()}>
              Resume remaining
            </button>
          ) : null}
          {error ? (
            <p className="hint" style={{ color: "var(--bad)" }}>
              {error}
            </p>
          ) : null}
        </div>
        {summary ? (
          <div className="bulk-kpis">
            <div className="kpi">
              <b>{summary.done}</b>
              <span>Drafted</span>
            </div>
            <div className="kpi">
              <b>{toReviewCount}</b>
              <span>To review</span>
            </div>
            <div className="kpi">
              <b>{summary.failed}</b>
              <span>Failed</span>
            </div>
            <div className="kpi">
              <b>{summary.pending + summary.running}</b>
              <span>Queued</span>
            </div>
            <div className="kpi">
              <b>{formatDuration(totalMs)}</b>
              <span>Time</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="bulk-progress" aria-hidden>
        <div className="bulk-progress-bar" style={{ width: `${progressPct}%` }} />
      </div>
      <p className="hint">
        {progressPct}% complete
        {summary ? ` · ${summary.done + summary.failed} of ${summary.total}` : ""}
        {totalMs != null ? ` · ${formatDuration(totalMs)} elapsed` : ""}
      </p>

      <div className="bulk-review-grid">
        <aside className="card bulk-queue">
          <h2>Queue</h2>
          <ul className="bulk-queue-list">
            {(job?.items || []).map((item) => {
              const run = matchRun(item, runs);
              const active = run && selected && run.id === selected.id;
              const label = queueLabel(item, run);
              const itemMs =
                item.durationMs ??
                (item.status === "running" && item.startedAt
                  ? Math.max(0, nowMs - Date.parse(item.startedAt))
                  : null);
              return (
                <li key={item.index}>
                  <button
                    type="button"
                    className={`bulk-queue-item ${active ? "active" : ""} ${item.status}`}
                    disabled={!run?.draft}
                    onClick={() => run && setSelectedRunId(run.id)}
                  >
                    <span className="bulk-q-name">
                      {item.prospect.fullName}
                      <small>
                        {item.prospect.company}
                        {itemMs != null ? ` · ${formatDuration(itemMs)}` : ""}
                      </small>
                    </span>
                    <span className={`badge ${run?.status || item.status}`}>{label}</span>
                  </button>
                  {item.error ? <p className="bulk-q-error">{item.error}</p> : null}
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="card bulk-editor">
          {selected?.draft ? (
            <>
              <div className="stages-header">
                <h2 style={{ margin: 0 }}>
                  {selected.prospect.fullName}{" "}
                  <span className={`badge ${selected.status}`}>{selected.status.replace("_", " ")}</span>
                </h2>
                {(() => {
                  const item = job?.items.find((i) => i.runId === selected.id || matchRun(i, [selected]));
                  const ms = item?.durationMs;
                  return ms != null ? (
                    <span className="hint" style={{ margin: 0, fontFamily: "var(--mono)" }}>
                      {formatDuration(ms)}
                    </span>
                  ) : null;
                })()}
              </div>
              <p className="hint" style={{ marginTop: 0 }}>
                {selected.prospect.title ? `${selected.prospect.title} · ` : ""}
                {selected.prospect.company}
                {selected.chosenSignal ? ` · Hook: ${selected.chosenSignal.title}` : ""}
              </p>
              <label>Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={selected.status !== "needs_review" || acting}
              />
              <label>Body</label>
              <textarea
                className="draft"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={selected.status !== "needs_review" || acting}
              />
              <label>Reviewer note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional"
                disabled={selected.status !== "needs_review" || acting}
              />
              {selected.status === "needs_review" ? (
                <div className="actions">
                  <button className="btn ok" type="button" disabled={acting} onClick={() => void decide("approved")}>
                    Approve & store
                  </button>
                  <button className="btn bad" type="button" disabled={acting} onClick={() => void decide("rejected")}>
                    Reject & store
                  </button>
                </div>
              ) : (
                <p className="hint">Already {selected.status}. Pick another prospect in the queue.</p>
              )}
              <div style={{ marginTop: 10 }}>
                <GmailDraftButton subject={subject} body={body} disabled={acting || !body.trim()} />
              </div>
            </>
          ) : (
            <div className="bulk-empty">
              <h2>Waiting for drafts</h2>
              <p className="hint">
                {processing
                  ? "Emails appear here as each prospect finishes research."
                  : canResume
                    ? "Some prospects are still queued — hit Resume remaining."
                    : "No drafts in this job yet — or all items failed."}
              </p>
              {processing ? <ClaudeSpark size={28} /> : null}
              {canResume ? (
                <button className="btn" type="button" style={{ width: "auto" }} onClick={() => void resume()}>
                  Resume remaining
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
