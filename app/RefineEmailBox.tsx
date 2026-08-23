"use client";

import { useState } from "react";
import type { RunRecord } from "@/lib/types";
import { ClaudeSpark } from "./ClaudeSpark";

export function RefineEmailBox({
  runId,
  subject,
  body,
  enabled,
  disabled = false,
  onRefiningChange,
  onRefined,
}: {
  runId: string;
  subject: string;
  body: string;
  enabled: boolean;
  disabled?: boolean;
  onRefiningChange?: (refining: boolean) => void;
  onRefined: (result: { subject: string; body: string; run: RunRecord }) => void;
}) {
  const [showRefine, setShowRefine] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  if (!enabled) return null;

  async function refineEmail() {
    if (!refinePrompt.trim() || refining) return;
    setRefining(true);
    onRefiningChange?.(true);
    setRefineError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/refine`, {
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
      if (json.run?.draft) {
        onRefined({
          subject: json.run.draft.subject,
          body: json.run.draft.body,
          run: json.run as RunRecord,
        });
      }
      setShowRefine(false);
      setRefinePrompt("");
    } catch (e) {
      setRefineError(e instanceof Error ? e.message : "Refine failed");
    } finally {
      setRefining(false);
      onRefiningChange?.(false);
    }
  }

  return (
    <div className="refine-box">
      {!showRefine ? (
        <button
          className="btn ghost"
          type="button"
          disabled={disabled || refining}
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
            disabled={refining || disabled}
            placeholder="e.g. Make it shorter and more formal. Emphasize cost savings for retail ops. Soft CTA — ask if next Tuesday works."
            style={{ minHeight: 88 }}
          />
          <div className="actions">
            <button
              className="btn ok"
              type="button"
              disabled={refining || disabled || !refinePrompt.trim()}
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
              AI rewrites the email using your instructions plus the research hook and analysis. Does not invent
              personal history.
            </p>
          )}
        </>
      )}
    </div>
  );
}
