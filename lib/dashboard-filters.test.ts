import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterDashboardRuns,
  runInTimeFrame,
  runMatchesConfidence,
} from "./dashboard-filters";
import type { RunRecord } from "./types";

const baseRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run_1",
  userId: "u1",
  createdAt: "2026-08-23T10:00:00.000Z",
  updatedAt: "2026-08-23T10:00:00.000Z",
  status: "needs_review",
  prospect: { fullName: "Jane", title: "VP", company: "Acme" },
  stages: [],
  signals: [],
  ...over,
});

describe("dashboard filters", () => {
  it("filters by time frame", () => {
    const now = Date.parse("2026-08-23T18:00:00.000Z");
    assert.equal(runInTimeFrame("2026-08-23T08:00:00.000Z", "today", now), true);
    assert.equal(runInTimeFrame("2026-08-22T08:00:00.000Z", "today", now), false);
    assert.equal(runInTimeFrame("2026-08-17T08:00:00.000Z", "7d", now), true);
    assert.equal(runInTimeFrame("2026-08-01T08:00:00.000Z", "30d", now), true);
    assert.equal(runInTimeFrame("2026-07-01T08:00:00.000Z", "30d", now), false);
  });

  it("filters by confidence including hold", () => {
    const high = baseRun({ draft: { subject: "Hi", body: "x", hook: "h", confidence: "high", usedSignalIds: [], model: "groq" } });
    const hold = baseRun({
      draft: {
        subject: "HOLD",
        body: "hold",
        hook: "none",
        confidence: "low",
        usedSignalIds: [],
        model: "hold",
        hold: true,
      },
    });
    assert.equal(runMatchesConfidence(high, "high"), true);
    assert.equal(runMatchesConfidence(high, "low"), false);
    assert.equal(runMatchesConfidence(hold, "hold"), true);
    assert.equal(runMatchesConfidence(hold, "high"), false);
  });

  it("combines search, time, and confidence", () => {
    const runs = [
      baseRun({
        id: "a",
        prospect: { fullName: "Colin Ross", title: "Mgr", company: "Cube" },
        draft: { subject: "Cube news", body: "x", hook: "h", confidence: "high", usedSignalIds: [], model: "groq" },
      }),
      baseRun({
        id: "b",
        createdAt: "2026-01-01T10:00:00.000Z",
        prospect: { fullName: "Old", title: "CEO", company: "Legacy" },
        draft: { subject: "Old", body: "x", hook: "h", confidence: "low", usedSignalIds: [], model: "groq" },
      }),
    ];
    const out = filterDashboardRuns(runs, {
      query: "cube",
      timeFrame: "90d",
      confidence: "high",
      nowMs: Date.parse("2026-08-23T18:00:00.000Z"),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "a");
  });
});
