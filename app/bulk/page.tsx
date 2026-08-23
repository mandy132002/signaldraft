"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Shell } from "../shell";
import { ClaudeSpark } from "../ClaudeSpark";
import { CSV_TEMPLATE, MAX_BULK_ROWS, prospectsFromCsv } from "@/lib/csv";
import { bulkElapsedMs } from "@/lib/bulk-stats";
import type { BulkJob } from "@/lib/types";

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function BulkPage() {
  const router = useRouter();
  const [fileName, setFileName] = useState("prospects.csv");
  const [csvText, setCsvText] = useState("");
  const [senderName, setSenderName] = useState("Mandar");
  const [senderCompany, setSenderCompany] = useState("Acme");
  const [senderOffer, setSenderOffer] = useState(
    "supply-chain visibility software for large retailers"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BulkJob[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const preview = useMemo(() => {
    if (!csvText.trim()) return null;
    return prospectsFromCsv(csvText, { senderName, senderCompany, senderOffer });
  }, [csvText, senderName, senderCompany, senderOffer]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/bulk", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setJobs(json.jobs ?? []);
    })();
  }, []);

  async function onFile(file: File) {
    setError(null);
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
  }

  async function startBulk() {
    if (!csvText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csvText,
          fileName,
          senderName,
          senderCompany,
          senderOffer,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Could not start bulk job");
        return;
      }
      router.push(`/bulk/${json.job.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "signaldraft-prospects.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <div style={{ marginBottom: 28 }}>
        <p
          style={{
            margin: "0 0 8px",
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
          Bulk outreach
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
          Upload prospects. Review drafts.
        </h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Research runs one prospect at a time. You approve or reject each email — nothing is sent.
        </p>
      </div>

      <div className="bulk-layout">
        <section className="card bulk-upload">
          <h2>1. Upload CSV</h2>
          <div
            className={`bulk-drop ${dragOver ? "over" : ""} ${csvText ? "has-file" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void onFile(f);
            }}
          >
            <p className="bulk-drop-title">{csvText ? fileName : "Drop CSV here"}</p>
            <p className="hint" style={{ margin: "6px 0 14px" }}>
              Required columns: <code>fullName</code> (or name), <code>company</code>. Optional: title,
              linkedinUrl, companyWebsite, notes. Max {MAX_BULK_ROWS} rows.
            </p>
            <div className="bulk-drop-actions">
              <label className="btn ghost bulk-file-btn">
                Choose file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
              </label>
              <button type="button" className="btn ghost" onClick={downloadTemplate}>
                Download template
              </button>
            </div>
          </div>

          <label>Or paste CSV</label>
          <textarea
            className="bulk-paste"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={"fullName,title,company\nJane Doe,VP Ops,Acme Corp"}
          />
        </section>

        <section className="card">
          <h2>2. Your sender defaults</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Applied to every row unless the CSV has senderName / senderCompany / senderOffer columns.
          </p>
          <label>Your name</label>
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} />
          <label>Your company</label>
          <input value={senderCompany} onChange={(e) => setSenderCompany(e.target.value)} />
          <label>What you sell</label>
          <textarea
            value={senderOffer}
            onChange={(e) => setSenderOffer(e.target.value)}
            placeholder="One line product/offer"
          />

          <button className="btn" type="button" disabled={busy || !preview?.prospects.length} onClick={() => void startBulk()}>
            <span className="btn-inner">
              {busy ? <ClaudeSpark size={18} className="dark" /> : null}
              {busy
                ? "Starting…"
                : preview?.prospects.length
                  ? `Research ${preview.prospects.length} prospect${preview.prospects.length === 1 ? "" : "s"}`
                  : "Add a CSV to continue"}
            </span>
          </button>
          {error ? (
            <p className="hint" style={{ color: "var(--bad)" }}>
              {error}
            </p>
          ) : null}
        </section>
      </div>

      {preview ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="stages-header">
            <h2 style={{ margin: 0 }}>Preview</h2>
            <span className="badge">{preview.prospects.length} ready</span>
          </div>
          {preview.errors.length ? (
            <ul className="bulk-warnings">
              {preview.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">Columns matched: {preview.matchedColumns.join(", ") || "—"}</p>
          )}
          <div className="bulk-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Company</th>
                  <th>LinkedIn</th>
                  <th>Website</th>
                </tr>
              </thead>
              <tbody>
                {preview.prospects.map((p, i) => (
                  <tr key={`${p.fullName}-${p.company}-${i}`}>
                    <td>{i + 1}</td>
                    <td>{p.fullName}</td>
                    <td>{p.title || "—"}</td>
                    <td>{p.company}</td>
                    <td>{p.linkedinUrl ? "Yes" : "—"}</td>
                    <td>{p.companyWebsite ? "Yes" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {jobs.length ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Recent bulk jobs</h2>
          <ul className="bulk-job-list">
            {jobs.slice(0, 8).map((j) => {
              const done = j.items.filter((i) => i.status === "done").length;
              const failed = j.items.filter((i) => i.status === "failed").length;
              const elapsed = formatDuration(bulkElapsedMs(j));
              return (
                <li key={j.id}>
                  <Link href={`/bulk/${j.id}`}>
                    <strong>{j.fileName}</strong>
                    <span>
                      {done}/{j.items.length} drafted
                      {failed ? ` · ${failed} failed` : ""}
                      {elapsed ? ` · ${elapsed}` : ""} · {j.status}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}
