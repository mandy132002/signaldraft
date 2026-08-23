import { Suspense } from "react";
import HistoryPage from "./HistoryClient";
import { Shell } from "../shell";
import { ClaudeSpark } from "../ClaudeSpark";

function DashboardFallback() {
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
      </div>
      <div className="kpis" aria-busy>
        {["Runs", "Emails stored", "Needs review", "Approved"].map((label) => (
          <div className="kpi kpi-loading" key={label}>
            <b>
              <span className="kpi-skeleton" aria-hidden />
            </b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="dashboard-loading" aria-live="polite">
          <ClaudeSpark size={22} />
          <p>Loading dashboard…</p>
        </div>
      </div>
    </Shell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <HistoryPage />
    </Suspense>
  );
}
