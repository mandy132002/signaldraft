import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractCollisionNames,
  formatMemoryForPrompt,
  isCollisionReject,
  memoriesFromDecision,
  memoryFromRefine,
  reviewLooksLikeCollision,
  scoreMemory,
  selectMemoryPack,
  signalHitsCollision,
  tokenOverlap,
  type DraftMemory,
} from "./draft-memory";
import type { RunRecord } from "./types";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run_1",
  userId: "u1",
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
  status: "needs_review",
  prospect: {
    fullName: "Santhosh",
    title: "Delivery Manager",
    company: "Cube Global",
    senderOffer: "agentic testing",
    senderCompany: "BrowserStack",
  },
  stages: [],
  signals: [],
  chosenSignal: {
    id: "hook1",
    kind: "news",
    title: "Cube Logic raises Series B",
    summary: "Supply-chain software vendor Cube Logic closed funding.",
    source: "news",
    url: "https://example.com",
    relevance: 0.8,
    why: "soft",
    matchTier: "suspect",
  },
  draft: {
    subject: "Cube news",
    body: "Hi Santhosh,\n\nHello.\n\nMandar",
    hook: "Cube Logic raises Series B",
    confidence: "medium",
    usedSignalIds: ["hook1"],
    model: "groq",
  },
  ...over,
});

describe("draft memory", () => {
  it("extracts lookalike company names from a rejected hook", () => {
    const names = extractCollisionNames("Cube Logic raises Series B", "Cube Global");
    assert.ok(names.some((n) => /cube logic/i.test(n)));
  });

  it("treats wrong-company review notes and suspect hooks as collisions", () => {
    assert.equal(reviewLooksLikeCollision("wrong company — this is Cube Logistics"), true);
    assert.equal(isCollisionReject(run(), "lookalike"), true);
    assert.equal(
      isCollisionReject(
        run({
          chosenSignal: {
            id: "ok",
            kind: "news",
            title: "Cube Global launches analytics",
            summary: "Cube Global shipped a warehouse product.",
            source: "news",
            url: "https://x",
            relevance: 0.9,
            why: "exact",
            matchTier: "exact",
          },
        }),
        "too salesy"
      ),
      false
    );
  });

  it("records an approved hook plus refine tone, and skips holds", () => {
    const approved = memoriesFromDecision(
      run({
        lastRefinePrompt: "shorter, softer CTA",
        chosenSignal: {
          id: "ok",
          kind: "funding",
          title: "Cube Global launches analytics",
          summary: "Cube Global shipped a product.",
          source: "news",
          url: "https://x",
          relevance: 0.9,
          why: "exact",
          matchTier: "exact",
        },
      }),
      "approved"
    );
    assert.equal(approved.some((m) => m.kind === "approved_hook"), true);
    assert.equal(approved.some((m) => m.kind === "tone" && m.refinePrompt === "shorter, softer CTA"), true);

    const hold = memoriesFromDecision(
      run({ draft: { ...run().draft!, hold: true, subject: "HOLD", body: "HOLD — do not send" } }),
      "approved"
    );
    assert.equal(hold.length, 0);
  });

  it("stores refine instructions as tone memory", () => {
    const mem = memoryFromRefine(run(), "more formal, no exclamation marks");
    assert.equal(mem?.kind, "tone");
    assert.match(mem?.refinePrompt || "", /more formal/);
  });

  it("retrieves Cube collisions for Cube Global and not for an unrelated company", () => {
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const collision: DraftMemory = {
      id: "m1",
      userId: "u1",
      kind: "rejected_collision",
      createdAt: "2026-08-24T00:00:00.000Z",
      runId: "run_1",
      prospectCompany: "Cube Global",
      collisionNames: ["Cube Logic"],
      hookTitle: "Cube Logic raises Series B",
    };
    const packCube = selectMemoryPack([collision], run().prospect, now);
    assert.equal(packCube.collisions.length, 1);
    const packAmazon = selectMemoryPack(
      [collision],
      { fullName: "Jeff", title: "CEO", company: "Amazon", senderOffer: "cloud" },
      now
    );
    assert.equal(packAmazon.collisions.length, 0);
  });

  it("scores offer overlap higher than unrelated memories", () => {
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const match: DraftMemory = {
      id: "a",
      userId: "u1",
      kind: "approved_hook",
      createdAt: "2026-08-24T00:00:00.000Z",
      runId: "r1",
      prospectCompany: "Acme",
      senderOffer: "agentic testing platform",
      hookTitle: "Acme launches QA",
    };
    const miss: DraftMemory = {
      ...match,
      id: "b",
      senderOffer: "payroll software",
      hookTitle: "Acme payroll",
    };
    const prospect = run().prospect;
    assert.ok(scoreMemory(match, prospect, now) > scoreMemory(miss, prospect, now));
  });

  it("flags a new signal that repeats a rejected lookalike", () => {
    const pack = selectMemoryPack(
      [
        {
          id: "m1",
          userId: "u1",
          kind: "rejected_collision",
          createdAt: "2026-08-24T00:00:00.000Z",
          runId: "run_1",
          prospectCompany: "Cube Global",
          collisionNames: ["Cube Logic"],
          hookTitle: "Cube Logic raises Series B",
        },
      ],
      run().prospect,
      Date.parse("2026-08-25T00:00:00.000Z")
    );
    assert.equal(
      signalHitsCollision({ title: "Cube Logic hires a CRO", summary: "The vendor expanded sales." }, pack),
      true
    );
    assert.equal(tokenOverlap("agentic testing", "agentic testing platform") > 0, true);
  });

  it("formats a compact prompt block", () => {
    const text = formatMemoryForPrompt({
      approved: [],
      collisions: [
        {
          id: "m1",
          userId: "u1",
          kind: "rejected_collision",
          createdAt: "",
          runId: "r",
          prospectCompany: "Cube Global",
          collisionNames: ["Cube Logic"],
        },
      ],
      rejectedHooks: [],
      tones: [
        {
          id: "t",
          userId: "u1",
          kind: "tone",
          createdAt: "",
          runId: "r",
          prospectCompany: "Cube Global",
          refinePrompt: "shorter, softer CTA",
        },
      ],
    });
    assert.match(text, /Cube Logic/);
    assert.match(text, /softer CTA/);
  });
});
