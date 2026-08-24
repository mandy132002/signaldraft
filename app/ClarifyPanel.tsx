"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClarifyAnswers } from "@/lib/clarify";
import type { ClarifyField, ProspectInput, RunRecord } from "@/lib/types";
import { ClaudeSpark } from "./ClaudeSpark";
import { consumeRunStream } from "./run-stream";

const EMPTY: Record<ClarifyField, string> = {
  linkedinUrl: "",
  companyWebsite: "",
  company: "",
  notes: "",
};

export function ClarifyPanel({
  run,
  disabled,
  onBusy,
  onRun,
  onProspect,
}: {
  run: RunRecord;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onRun: (run: RunRecord) => void;
  onProspect?: (prospect: ProspectInput) => void;
}) {
  const clarify = run.clarify;
  const [values, setValues] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!clarify) return;
    setValues({
      linkedinUrl: run.prospect.linkedinUrl || "",
      companyWebsite: run.prospect.companyWebsite || "",
      company: run.prospect.company || "",
      notes: "",
    });
    setError(null);
  }, [run.id, clarify?.askedAt, run.prospect.linkedinUrl, run.prospect.companyWebsite, run.prospect.company]);

  const fields = useMemo(() => clarify?.questions ?? [], [clarify]);

  if (run.status !== "needs_input" || !clarify) return null;

  function setField(field: ClarifyField, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
  }

  async function submit(skip: boolean) {
    if (submitting || disabled) return;
    setSubmitting(true);
    onBusy?.(true);
    setError(null);
    const answers: ClarifyAnswers = skip
      ? { skip: true }
      : {
          linkedinUrl: values.linkedinUrl,
          companyWebsite: values.companyWebsite,
          company: values.company,
          notes: values.notes,
        };
    try {
      const res = await fetch(`/api/runs/${run.id}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Could not continue this run");
      }
      const last = await consumeRunStream(res, (next) => {
        onRun(next);
        onProspect?.(next.prospect);
        if (next.draft) {
          /* parent may read draft from run */
        }
      });
      if (last) {
        onRun(last);
        onProspect?.(last.prospect);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not continue");
    } finally {
      setSubmitting(false);
      onBusy?.(false);
    }
  }

  return (
    <div className="card clarify-card">
      <h2>Need a quick check</h2>
      <div className="callout clarify">
        <strong>Paused before drafting.</strong> {clarify.reason}
      </div>
      {fields.map((q) => (
        <div key={q.id} className="clarify-field">
          <label>{q.prompt}</label>
          {q.suggestions?.length ? (
            <div className="clarify-suggestions">
              {q.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`clarify-chip ${values[q.field] === s ? "active" : ""}`}
                  disabled={submitting || disabled}
                  onClick={() => setField(q.field, s)}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          {q.field === "notes" ? (
            <textarea
              value={values[q.field]}
              onChange={(e) => setField(q.field, e.target.value)}
              placeholder={q.placeholder}
              disabled={submitting || disabled}
            />
          ) : (
            <input
              value={values[q.field]}
              onChange={(e) => setField(q.field, e.target.value)}
              placeholder={q.placeholder}
              disabled={submitting || disabled}
            />
          )}
        </div>
      ))}
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn" type="button" disabled={submitting || disabled} onClick={() => void submit(false)}>
          <span className="btn-inner">
            {submitting ? <ClaudeSpark size={18} className="dark" /> : null}
            {submitting ? "Continuing…" : "Continue research"}
          </span>
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={submitting || disabled}
          onClick={() => void submit(true)}
        >
          Continue anyway
        </button>
      </div>
      {error ? (
        <p className="hint" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      ) : (
        <p className="hint">
          Continue anyway skips this check. We may still hold if the public hook is not confirmed — nothing is sent.
        </p>
      )}
    </div>
  );
}
