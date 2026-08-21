"use client";

import { useEffect, useMemo, useState } from "react";
import { ClaudeSpark } from "./ClaudeSpark";
import { GmailDraftButton } from "./GmailDraftButton";
import { useLiveSession } from "./LiveSession";
import { Shell } from "./shell";
import type { StageEvent } from "@/lib/types";

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
  const [showRefine, setShowRefine] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(false);

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
    setSignalsOpen(false);
    setSubject("");
    setBody("");
    const started = Date.now();
    setClientStartedAt(started);
    setNowMs(started);
    const res = await fetch("/api/runs/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const reader = res.body?.getReader();
    if (!reader) {
      setBusy(false);
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
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
          const payload = JSON.parse(line) as { run?: import("@/lib/types").RunRecord };
          if (payload.run) {
            setRun(payload.run);
            setNowMs(Date.now());
            if (payload.run.draft) {
              setSubject(payload.run.draft.subject);
              setBody(payload.run.draft.body);
            }
          }
        } catch {
          /* ignore partial JSON */
        }
      }
    }
    setBusy(false);
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

  async function refineEmail() {
    if (!run || !refinePrompt.trim() || refining) return;
    setRefining(true);
    setRefineError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: refinePrompt.trim(),
          subject,
          emailBody: body,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setRefineError(json.error || "Refine failed");
        return;
      }
      setRun(json.run);
      if (json.run?.draft) {
        setSubject(json.run.draft.subject);
        setBody(json.run.draft.body);
      }
      setShowRefine(false);
      setRefinePrompt("");
    } catch (e) {
      setRefineError(e instanceof Error ? e.message : "Refine failed");
    } finally {
      setRefining(false);
    }
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
          <input value={form.fullName} onChange={set("fullName")} required placeholder="Jeff Bezos" />
          <div className="row2">
            <div>
              <label>Their title</label>
              <input value={form.title} onChange={set("title")} placeholder="CEO" />
            </div>
            <div>
              <label>Exact company name</label>
              <input value={form.company} onChange={set("company")} required placeholder="Amazon" />
            </div>
          </div>
          <label>LinkedIn URL (optional)</label>
          <input value={form.linkedinUrl} onChange={set("linkedinUrl")} placeholder="https://linkedin.com/in/…" />
          <label>You (SDR) — name / your company</label>
          <div className="row2">
            <input value={form.senderName} onChange={set("senderName")} placeholder="Your name" />
            <input value={form.senderCompany} onChange={set("senderCompany")} placeholder="Your company" />
          </div>
          <label>What you sell (goes in the email)</label>
          <textarea
            value={form.senderOffer}
            onChange={set("senderOffer")}
            placeholder="One line: the product/service you are pitching them"
          />
          <label>Notes (optional)</label>
          <textarea value={form.notes} onChange={set("notes")} placeholder="CSV row, known trigger, or extra context" />
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

          {run?.signals?.length ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className="collapse-toggle"
                onClick={() => setSignalsOpen((o) => !o)}
                aria-expanded={signalsOpen}
              >
                <h2 style={{ margin: 0 }}>
                  Signals found{" "}
                  <span className="badge" style={{ textTransform: "none", letterSpacing: 0 }}>
                    {run.signals.length}
                  </span>
                </h2>
                <span className="collapse-chevron">{signalsOpen ? "Hide" : "Show"}</span>
              </button>
              {signalsOpen ? (
                <div className="signals" style={{ marginTop: 14 }}>
                  {run.signals.slice(0, 8).map((sig) => (
                    <article className={`signal ${sig.id === chosenId ? "chosen" : ""}`} key={sig.id}>
                      <div className="signal-meta">
                        <span className="kind">
                          {sig.kind} · {sig.source}
                          {sig.matchTier ? ` · ${sig.matchTier}` : ""}
                          {sig.eligible ? " · kept" : " · out"}
                        </span>
                        <span>{Math.round(sig.relevance * 100)}</span>
                      </div>
                      <h3>{sig.title}</h3>
                      <p>{sig.summary}</p>
                      {sig.why ? <p style={{ marginTop: 6 }}>{sig.why}</p> : null}
                      {sig.url ? (
                        <p style={{ marginTop: 6 }}>
                          <a href={sig.url} target="_blank" rel="noreferrer">
                            Source
                          </a>
                          {sig.id === chosenId ? " · chosen hook" : ""}
                        </p>
                      ) : null}
                    </article>
                  ))}
                  {run.signals.length > 8 ? (
                    <p className="hint">Showing 8 of {run.signals.length}</p>
                  ) : null}
                </div>
              ) : (
                <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                  {run.signals.filter((s) => s.eligible).length} kept for outreach
                  {run.chosenSignal ? ` · top hook selected` : ""}
                </p>
              )}
            </div>
          ) : null}

          {run?.entityNote ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>LLM entity check</h2>
              <p style={{ margin: 0, fontSize: 14 }}>{run.entityNote}</p>
            </div>
          ) : null}

          {run?.analysis ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Local LLM analysis</h2>
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
                Outreach email{" "}
                {run ? <span className={`badge ${run.status}`}>{run.status.replace("_", " ")}</span> : null}
                {refining ? (
                  <span style={{ marginLeft: 8, verticalAlign: "middle" }}>
                    <ClaudeSpark size={16} />
                  </span>
                ) : null}
              </h2>
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={refining} />
              <label>Body (edit before you send)</label>
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
                placeholder="Why approve or reject"
                disabled={refining}
              />

              {run?.chosenSignal ? (
                <div className="refine-box">
                  {!showRefine ? (
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy || refining}
                      style={{ marginTop: 12 }}
                      onClick={() => {
                        setShowRefine(true);
                        setRefineError(null);
                      }}
                    >
                      Refine
                    </button>
                  ) : (
                    <>
                      <label>Refinement prompt</label>
                      <textarea
                        value={refinePrompt}
                        onChange={(e) => setRefinePrompt(e.target.value)}
                        disabled={refining}
                        placeholder="e.g. Make it shorter and more formal. Emphasize cost savings for retail ops. Soft CTA — ask if next Tuesday works."
                        style={{ minHeight: 88 }}
                      />
                      <div className="actions">
                        <button
                          className="btn ok"
                          type="button"
                          disabled={refining || !refinePrompt.trim()}
                          onClick={() => void refineEmail()}
                        >
                          <span className="btn-inner">
                            {refining ? <ClaudeSpark size={16} className="dark" /> : null}
                            {refining ? "Refining…" : "Generate refined email"}
                          </span>
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={refining}
                          onClick={() => {
                            setShowRefine(false);
                            setRefinePrompt("");
                            setRefineError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      {refineError ? (
                        <p className="hint" style={{ color: "var(--bad)" }}>
                          {refineError}
                        </p>
                      ) : (
                        <p className="hint">
                          AI rewrites the email using your instructions plus the research hook and analysis.
                          Does not invent personal history.
                        </p>
                      )}
                    </>
                  )}
                </div>
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
                      Approve & store
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
                  <div style={{ marginTop: 10 }}>
                    <GmailDraftButton subject={subject} body={body} disabled={refining || !body.trim()} />
                  </div>
                  <p className="hint">
                    Approving or rejecting saves this email (with your edits) to the dashboard.{" "}
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
  { id: "company", label: "Company + LinkedIn context", detail: "Waiting", status: "pending", at: "" },
  { id: "news", label: "Public news & funding", detail: "Waiting", status: "pending", at: "" },
  { id: "hiring", label: "Person + company signals", detail: "Waiting", status: "pending", at: "" },
  { id: "rank", label: "Soft-rank candidates", detail: "Waiting", status: "pending", at: "" },
  { id: "resolve", label: "LLM entity match", detail: "Waiting", status: "pending", at: "" },
  { id: "analyze", label: "Local LLM analysis", detail: "Waiting", status: "pending", at: "" },
  { id: "draft", label: "Draft outreach email", detail: "Waiting", status: "pending", at: "" },
  { id: "review", label: "SDR review (not sent)", detail: "Waiting", status: "pending", at: "" },
];
