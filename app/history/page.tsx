import { Suspense } from "react";
import HistoryPage from "./HistoryClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="app-shell">Loading saved emails…</div>}>
      <HistoryPage />
    </Suspense>
  );
}
