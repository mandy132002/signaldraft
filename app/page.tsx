"use client";

import { useEffect, useMemo, useState } from "react";
import { isHoldDraft, signalIsSensitive } from "@/lib/edge-cases";
import type { StageEvent } from "@/lib/types";
import { ClaudeSpark } from "./ClaudeSpark";
import { ClarifyPanel } from "./ClarifyPanel";
import { GmailDraftButton } from "./GmailDraftButton";
import { RefineEmailBox } from "./RefineEmailBox";
import { SenderContextFields } from "./SenderContext";
import { SignalsCheck } from "./SignalsCheck";
import { useLiveSession } from "./LiveSession";
import { consumeRunStream } from "./run-stream";
import { Shell } from "./shell";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function stageElapsedMs(stage: StageEvent, nowMs: number): number | null {
  if (typeof stage.durationMs === "number") return stage.durationMs;
  if (stage.status === "running" && stage.startedAt) {
    return Math.max(0, nowMs - Date.parse(stage.startedAt));
  }
  return null;
}

/** Sum of pipeline stage times only — ignores idle time after the run finished. */
function pipelineTotalMs(
  stages: StageEvent[] | undefined,
  nowMs: number,
  busy: boolean,
  clientStartedAt: number | null
): number | null {
  if (!stages?.length) {
    if (busy && clientStartedAt) return Math.max(0, nowMs - clientStartedAt);
    return null;
  }
  let total = 0;
  let any = false;
  for (const s of stages) {
    const ms = stageElapsedMs(s, nowMs);
    if (ms != null) {
      total += ms;
      any = true;
    }
  }
  if (any) return total;
  if (busy && clientStartedAt) return Math.max(0, nowMs - clientStartedAt);
  return null;
}

export default function HomePage() {
  const {
    form,
    setForm,
    run,
    setRun,
    subject,
    setSubject,
    body,
    setBody,
    note,
    setNote,
    busy,
    setBusy,
    clientStartedAt,
    setClientStartedAt,
    ready,
    refreshRun,
    resetSession,
  } = useLiveSession();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refining, setRefining] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // Live tick while any stage is running
  useEffect(() => {
    if (!busy && !run?.stages?.some((s) => s.status === "running")) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [busy, run?.stages]);

  // When returning from Dashboard, refresh this run from the server
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshRun();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void refreshRun();
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshRun]);

  async function startRun() {
    setBusy(true);
    setRun(null);
    setSubject("");
    setBody("");
    const started = Date.now();
    setClientStartedAt(started);
    setNowMs(started);
    try {
      const res = await fetch("/api/runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      await consumeRunStream(res, (next) => {
        setRun(next);
        setNowMs(Date.now());
        if (next.draft) {
          setSubject(next.draft.subject);
          setBody(next.draft.body);
        }
        if (next.prospect) {
          setForm((f) => ({ ...f, ...next.prospect }));
        }
      });
    } finally {
      setBusy(false);
    }
  }

  async function review(status: "approved" | "rejected") {
    if (!run) return;
    const res = await fetch(`/api/runs/${run.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        reviewNote: note,
        subject,
        emailBody: body,
      }),
    });
    const json = await res.json();
    setRun(json.run);
  }

  const chosenId = run?.chosenSignal?.id;
  const displayStages = run?.stages ?? defaultStages;

  const totalMs = useMemo(
    () => pipelineTotalMs(run?.stages, nowMs, busy, clientStartedAt),
    [run?.stages, busy, nowMs, clientStartedAt]
  );

  const liveLabel = useMemo(() => {
    if (!ready) return "Restoring last session…";
    if (busy) return "Researching live…";
    if (run?.status === "needs_input") return "Paused — confirm the workplace, then we continue";
    if (run?.draft && isHoldDraft(run.draft)) return "Hold — no confirmed hook to send";
    if (run?.status === "needs_review" && (run.draft?.sensitiveHook || (run.chosenSignal && signalIsSensitive(run.chosenSignal))))
      return "Draft ready — sensitive hook, review carefully";
    if (run?.status === "needs_review") return "Outreach draft ready — review before you send";
    if (run?.status === "approved") return "Approved — ready for you to send from your mailbox";
    if (run?.status === "rejected") return "Rejected — will not use this draft";
    if (run?.status === "failed") return "Run failed";
    if (run) return "Last run restored — edit or run again";
    return "Enter a prospect — we research, you review the email";
  }, [busy, run, ready]);

  // Intake = form only; after submit (or restored run) form shifts left and pipeline opens
  const workspaceActive = busy || !!run || !!subject || !!body;

  return (
    <Shell>
      {!workspaceActive ? (
        <div className="lede-intake" style={{ marginBottom: 28 }}>
          <p
            style={{
              margin: "0 0 10px",
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--copper)",
              letterSpacing: "0.04em",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <ClaudeSpark size={14} />
            Live research
          </p>
          <h1
            style={{
              fontFamily: "var(--serif)",
              fontSize: "clamp(30px, 4.5vw, 40px)",
              fontWeight: 650,
              letterSpacing: "-0.04em",
              margin: "0 0 12px",
              lineHeight: 1.1,
              color: "var(--ink)",
            }}
          >
            Who are you writing to?
          </h1>
          <p className="lede" style={{ marginBottom: 0, marginLeft: "auto", marginRight: "auto" }}>
            Enter the person and their exact company. We find a real public hook, then draft the outreach
            email you would actually send.
          </p>
        </div>
      ) : (
        <p
          className="lede"
          style={{
            marginTop: 0,
            marginBottom: 22,
            fontFamily: "var(--mono)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {busy ? <ClaudeSpark size={16} /> : null}
          {liveLabel}
          {totalMs != null && (busy || run) ? (
            <span style={{ color: "var(--copper)" }}>· {formatDuration(totalMs)} total</span>
          ) : null}
        </p>
      )}
      <div className={`live-workspace ${workspaceActive ? "is-active" : "is-intake"}`}>
        <form
          className="card live-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startRun();
          }}
        >
          <h2>{workspaceActive ? "Who are you writing to?" : "Prospect details"}</h2>
          <label>Prospect full name</label>
          <input value={form.fullName} onChange={set("fullName")} required placeholder="Full name" />
          <div className="row2">
            <div>
              <label>Their title</label>
              <input value={form.title} onChange={set("title")} placeholder="Job title" />
            </div>
            <div>
              <label>Exact company name</label>
              <input value={form.company} onChange={set("company")} required placeholder="Company name" />
            </div>
          </div>
          <label>LinkedIn URL {form.company.trim().split(/\s+/).length <= 1 ? "(recommended)" : "(optional)"}</label>
          <input
            value={form.linkedinUrl}
            onChange={set("linkedinUrl")}
            placeholder="https://linkedin.com/in/username"
          />
          <label>Company website {form.company.trim().split(/\s+/).length <= 1 ? "(recommended)" : "(optional)"}</label>
          <input
            value={form.companyWebsite || ""}
            onChange={set("companyWebsite")}
            placeholder="https://company.com"
          />
          <SenderContextFields
            value={{
              senderName: form.senderName || "",
              senderCompany: form.senderCompany || "",
              senderOffer: form.senderOffer || "",
            }}
            onChange={(next) => setForm((f) => ({ ...f, ...next }))}
            compactAction="Override this run"
          />
          <label>Notes (optional)</label>
          <textarea value={form.notes} onChange={set("notes")} placeholder="Optional context for research" />
          <button className="btn" disabled={busy} type="submit">
            <span className="btn-inner">
              {busy ? <ClaudeSpark size={18} className="dark" /> : null}
              {busy ? "Researching…" : run ? "Run again" : "Research & draft email"}
            </span>
          </button>
          {run || subject || body ? (
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              style={{ marginTop: 8 }}
              onClick={() => {
                if (busy) return;
                if (window.confirm("Reset Live run? This clears the current prospect, stages, and draft from this page.")) {
                  resetSession();
                }
              }}
            >
              Reset
            </button>
          ) : null}
          <p className="hint">
            {workspaceActive
              ? "Your last Live run stays here when you switch to Dashboard and back. Stage times are the sum of each pipeline step (not idle time after finishing). Use Reset to clear, or Run again for a new research pass."
              : "Submit to start research — the live pipeline opens beside this form."}
          </p>
        </form>

        <div className="live-pipeline" aria-hidden={!workspaceActive}>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="stages-header">
              <h2>Live stages</h2>
              <div className="stages-total">
                {busy ? <ClaudeSpark size={18} /> : null}
                {totalMs != null && (busy || run) ? <span>{formatDuration(totalMs)}</span> : null}
              </div>
            </div>
            <ul className="stages">
              {displayStages.map((s) => {
                const elapsed = stageElapsedMs(s, nowMs);
                return (
                  <li key={s.id}>
                    <div className="stage-icon">
                      {s.status === "running" ? (
                        <ClaudeSpark size={18} />
                      ) : (
                        <div className={`dot ${s.status}`} />
                      )}
                    </div>
                    <div>
                      <div className="stage-label">{s.label}</div>
                      <div className="stage-detail">{s.detail}</div>
                    </div>
                    <div className={`stage-time ${s.status === "running" ? "live" : ""}`}>
                      {elapsed != null ? formatDuration(elapsed) : "—"}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {run?.status === "needs_input" ? (
            <ClarifyPanel
              run={run}
              disabled={busy}
              onBusy={setBusy}
              onRun={(next) => {
                setRun(next);
                setNowMs(Date.now());
                if (next.draft) {
                  setSubject(next.draft.subject);
                  setBody(next.draft.body);
                }
              }}
              onProspect={(prospect) => setForm((f) => ({ ...f, ...prospect }))}
            />
          ) : null}

          {run?.signals?.length ? (
            <SignalsCheck key={run.id} signals={run.signals} chosenId={chosenId} />
          ) : null}

          {run?.entityNote ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Groq entity check</h2>
              <p style={{ margin: 0, fontSize: 14 }}>{run.entityNote}</p>
            </div>
          ) : null}

          {run?.analysis ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Groq analysis</h2>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                <span className="badge">{run.analysis.sentiment}</span>{" "}
                <span style={{ color: "var(--muted)" }}>{run.analysis.sentimentWhy}</span>
              </p>
              <p style={{ margin: "0 0 8px", fontSize: 14 }}>
                <strong>Business impact:</strong> {run.analysis.businessImpact}
              </p>
              <p style={{ margin: "0 0 8px", fontSize: 14 }}>
                <strong>Outreach angle:</strong> {run.analysis.outreachAngle}
              </p>
              <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
                Tone: {run.analysis.toneGuidance}
                {run.analysis.riskFlags?.length ? ` · Watch: ${run.analysis.riskFlags.join("; ")}` : ""}
              </p>
            </div>
          ) : null}

          {run?.draft || subject || body ? (
            <div className="card">
              <h2>
                {run?.draft && isHoldDraft(run.draft) ? "Hold note " : "Outreach email "}
                {run ? <span className={`badge ${run.status}`}>{run.status.replace("_", " ")}</span> : null}
                {run?.draft && isHoldDraft(run.draft) ? (
                  <span className="badge hold" style={{ marginLeft: 6 }}>
                    do not send
                  </span>
                ) : null}
                {run?.draft?.sensitiveHook || (run?.chosenSignal && signalIsSensitive(run.chosenSignal)) ? (
                  <span className="badge sensitive" style={{ marginLeft: 6 }}>
                    sensitive
                  </span>
                ) : null}
                {run?.draft?.confidence ? (
                  <span className={`badge confidence-${run.draft.confidence}`} style={{ marginLeft: 6 }}>
                    Confidence {run.draft.confidence}
                  </span>
                ) : null}
                {refining ? (
                  <span style={{ marginLeft: 8, verticalAlign: "middle" }}>
                    <ClaudeSpark size={16} />
                  </span>
                ) : null}
              </h2>
              {run?.draft && isHoldDraft(run.draft) ? (
                <div className="callout hold">
                  <strong>No confirmed public hook</strong> for {run.prospect.fullName} at {run.prospect.company}.
                  This is an internal hold, not an email. Add a LinkedIn URL, company website, or a source note and run
                  again — do not send this text.
                </div>
              ) : run?.draft?.sensitiveHook || (run?.chosenSignal && signalIsSensitive(run.chosenSignal)) ? (
                <div className="callout sensitive">
                  <strong>Sensitive public event.</strong> Do not congratulate or treat this as a win. Review tone
                  before you copy it to your mailbox.
                </div>
              ) : null}
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={refining} />
              <label>{run?.draft && isHoldDraft(run.draft) ? "Internal note" : "Body (edit before you send)"}</label>
              <textarea
                className="draft"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={refining}
              />
              <label>Reviewer note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note for your team"
                disabled={refining}
              />

              {run?.chosenSignal && !(run.draft && isHoldDraft(run.draft)) ? (
                <RefineEmailBox
                  runId={run.id}
                  subject={subject}
                  body={body}
                  enabled
                  disabled={busy}
                  onRefiningChange={setRefining}
                  onRefined={({ subject: s, body: b, run: updated }) => {
                    setRun(updated);
                    setSubject(s);
                    setBody(b);
                  }}
                />
              ) : null}

              {run ? (
                <>
                  <div className="actions">
                    <button
                      className="btn ok"
                      type="button"
                      disabled={refining}
                      onClick={() => void review("approved")}
                    >
                      {run.draft && isHoldDraft(run.draft) ? "Store hold (do not send)" : "Approve & store"}
                    </button>
                    <button
                      className="btn bad"
                      type="button"
                      disabled={refining}
                      onClick={() => void review("rejected")}
                    >
                      Reject & store
                    </button>
                  </div>
                  {run.draft && !isHoldDraft(run.draft) ? (
                    <p className="hint">
                      Approve or reject is remembered for the next run — winning hooks, lookalikes you flagged, and
                      refine tone.
                    </p>
                  ) : null}
                  {run.draft && isHoldDraft(run.draft) ? (
                    <p className="hint">Gmail is disabled — this hold is not an outreach email.</p>
                  ) : (
                    <div style={{ marginTop: 10 }}>
                      <GmailDraftButton subject={subject} body={body} disabled={refining || !body.trim()} />
                    </div>
                  )}
                  <p className="hint">
                    Approving or rejecting saves this result (with your edits) to the dashboard.{" "}
                    <a
                      href={`/history?run=${run.id}`}
                      style={{ color: "var(--copper-2)", textDecoration: "underline" }}
                    >
                      Open in dashboard
                    </a>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          {run?.error ? (
            <div className="card">
              <h2>Error</h2>
              <p>{run.error}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

const defaultStages: StageEvent[] = [
  { id: "intake", label: "Intake prospect", detail: "Waiting", status: "pending", at: "" },
  { id: "company", label: "Company + LinkedIn / website", detail: "Waiting", status: "pending", at: "" },
  { id: "news", label: "Public news & funding", detail: "Waiting", status: "pending", at: "" },
  { id: "hiring", label: "Person + company signals", detail: "Waiting", status: "pending", at: "" },
  { id: "rank", label: "Soft-rank candidates", detail: "Waiting", status: "pending", at: "" },
  { id: "resolve", label: "Groq entity match", detail: "Waiting", status: "pending", at: "" },
  { id: "analyze", label: "Groq analysis", detail: "Waiting", status: "pending", at: "" },
  { id: "draft", label: "Draft outreach email", detail: "Waiting", status: "pending", at: "" },
  { id: "review", label: "SDR review (not sent)", detail: "Waiting", status: "pending", at: "" },
];
