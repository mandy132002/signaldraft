"use client";

import { useState } from "react";
import { signalIsSensitive } from "@/lib/edge-cases";
import type { Signal } from "@/lib/types";

export function SignalsCheck({
  signals,
  chosenId,
  entityNote,
  variant = "card",
}: {
  signals: Signal[];
  chosenId?: string;
  entityNote?: string;
  variant?: "card" | "embedded";
}) {
  const [open, setOpen] = useState(false);
  if (!signals.length) return null;

  const kept = signals.filter((s) => s.eligible).length;
  const inner = (
    <>
      <button
        type="button"
        className="collapse-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <h2 style={{ margin: 0 }}>
          Signals found{" "}
          <span className="badge" style={{ textTransform: "none", letterSpacing: 0 }}>
            {signals.length}
          </span>
        </h2>
        <span className="collapse-chevron">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="signals" style={{ marginTop: 14 }}>
          {signals.slice(0, 8).map((sig) => (
            <article className={`signal ${sig.id === chosenId ? "chosen" : ""}`} key={sig.id}>
              <div className="signal-meta">
                <span className="kind">
                  {sig.kind} · {sig.source}
                  {sig.matchTier ? ` · ${sig.matchTier}` : ""}
                  {sig.eligible ? " · kept" : " · out"}
                  {sig.sensitive || signalIsSensitive(sig) ? " · sensitive" : ""}
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
          {signals.length > 8 ? <p className="hint">Showing 8 of {signals.length}</p> : null}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          {kept} kept for outreach
          {chosenId ? " · top hook selected" : ""}
        </p>
      )}
      {entityNote && variant === "embedded" ? (
        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          Entity check: {entityNote}
        </p>
      ) : null}
    </>
  );

  if (variant === "embedded") {
    return <div className="signals-check">{inner}</div>;
  }

  return <div className="card" style={{ marginBottom: 16 }}>{inner}</div>;
}
