import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noHookDraft } from "./draft";
import { isHoldDraft, isSensitiveHook } from "./edge-cases";
import { capDraftConfidence, draftQualityFails, parseDraftConfidence } from "./llm";
import { applyEntityResolution } from "./llm";
import {
  isPersonCompanySplit,
  looksLikeWrongCompany,
  mentionsCompanyExact,
  mentionsPerson,
  pickHook,
  type RankedSignal,
} from "./relevance";
import type { ProspectInput } from "./types";

const cube: ProspectInput = {
  fullName: "Santhosh Chandrashekar",
  title: "CEO",
  company: "Cube Global",
  senderName: "Mandar",
  senderCompany: "Acme",
  senderOffer: "supply-chain visibility",
};

const bezos: ProspectInput = {
  fullName: "Jeff Bezos",
  title: "Executive Chairman",
  company: "Amazon",
  senderName: "Mandar",
  senderCompany: "Acme",
  senderOffer: "supply-chain visibility",
};

function signal(partial: Partial<RankedSignal> & Pick<RankedSignal, "id" | "title">): RankedSignal {
  return {
    kind: "news",
    summary: "",
    source: "test",
    url: "https://example.com",
    relevance: 0.7,
    why: "test",
    eligible: true,
    matchTier: "exact",
    ...partial,
  };
}

describe("edge case 1 — lookalike companies", () => {
  it("does not treat CUBE or Cube Logic as Cube Global", () => {
    assert.equal(looksLikeWrongCompany("CUBE acquires logistics startup", "Cube Global"), true);
    assert.equal(looksLikeWrongCompany("Cube Logic raises Series B", "Cube Global"), true);
    assert.equal(looksLikeWrongCompany("Cube Global opens a Singapore office", "Cube Global"), false);
    assert.equal(mentionsCompanyExact("CUBE acquires logistics startup", "Cube Global"), false);
    assert.equal(mentionsCompanyExact("Cube Global opens a Singapore office", "Cube Global"), true);
  });

  it("safety-net drops an LLM-kept lookalike", () => {
    const lookalike = signal({
      id: "cube-logic",
      title: "Cube Logic raises Series B",
      matchTier: "soft",
    });
    const resolved = applyEntityResolution(
      [lookalike],
      { matchedIds: ["cube-logic"], chosenHookId: "cube-logic", note: "kept", rejected: [] },
      cube
    );
    assert.equal(resolved[0]?.eligible, false);
    assert.match(resolved[0]?.why || "", /Safety net/);
  });
});

describe("edge case 2 — person–company split", () => {
  it("flags Bezos/Blue Origin when the target is Amazon", () => {
    assert.equal(
      isPersonCompanySplit("Jeff Bezos unveils a new Blue Origin rocket", bezos),
      true
    );
    assert.equal(
      isPersonCompanySplit("Jeff Bezos: Amazon to invest more in logistics", bezos),
      false
    );
  });

  it("requires first and last name near each other", () => {
    const far = `Jeff spoke at a conference.${" padding".repeat(40)} Later Smith disagreed.`;
    assert.equal(mentionsPerson(far, "Jeff Smith"), false);
    assert.equal(mentionsPerson("Jeff Smith named CEO of Amazon", "Jeff Smith"), true);
  });

  it("will not pick a person-only other-employer story as the hook", () => {
    const blueOrigin = signal({
      id: "bo",
      title: "Jeff Bezos unveils a new Blue Origin rocket",
      matchTier: "person",
    });
    const amazon = signal({
      id: "amzn",
      title: "Amazon reports strong AWS growth",
      kind: "news",
      matchTier: "exact",
    });
    assert.equal(pickHook([blueOrigin, amazon], bezos)?.id, "amzn");
    assert.equal(pickHook([blueOrigin], bezos), undefined);
  });
});

describe("edge case 3 — no confirmed hook", () => {
  it("writes an internal hold, not a sendable email", () => {
    const draft = noHookDraft(cube);
    assert.equal(draft.hold, true);
    assert.equal(isHoldDraft(draft), true);
    assert.match(draft.subject, /^HOLD/);
    assert.match(draft.body, /do not send/i);
    assert.equal(draft.usedSignalIds.length, 0);
  });
});

describe("draft quality — direct email to prospect", () => {
  const colin = {
    fullName: "Colin Ross",
    title: "Delivery Manager",
    company: "Cube",
    senderName: "Mandar",
    senderCompany: "BrowserStack",
    senderOffer: "AI-enabled agentic testing platform",
  };

  it("rejects third-person Colin bio voice and broken offer lines", () => {
    const bad = `Hi Colin,

Noticed the Cube news ("Cube: Wrapping Benchmarks Once, Unlocking Agentic AI for Everyone") — The announcement signals Cube is positioning its platform as a foundational layer for agentic AI.

As Delivery Manager, Colin likely oversees delivery of these new capabilities.

Suggest BrowserStack's AI-enabled Agentic testing platform can help Cube automatically verify reliability.

We AI enabled Agentic testing platform.

Open to a 15-minute chat this week?

Mandar
BrowserStack`;
    assert.equal(draftQualityFails(bad, colin), true);
  });

  it("accepts a second-person sendable note", () => {
    const good = `Hi Colin,

Noticed Cube's update on wrapping benchmarks and unlocking agentic AI — useful timing if your team is shipping those capabilities.

At BrowserStack, we offer an AI-enabled agentic testing platform to help you validate reliability before release.

Open to a 15-minute chat this week?

Mandar
BrowserStack`;
    assert.equal(draftQualityFails(good, colin), false);
  });
});

describe("draft confidence", () => {
  it("parses Groq high/medium/low and ignores junk", () => {
    assert.equal(parseDraftConfidence("high", "exact Amazon hook").confidence, "high");
    assert.equal(parseDraftConfidence("LOW", "thin").confidence, "low");
    assert.equal(parseDraftConfidence("pretty sure", "", "medium").confidence, "medium");
    assert.match(parseDraftConfidence("high", "exact Amazon hook").confidenceWhy || "", /Amazon/);
  });

  it("caps high on sensitive or rewritten drafts", () => {
    assert.equal(capDraftConfidence("high", { sensitive: true }), "medium");
    assert.equal(capDraftConfidence("high", { rewritten: true }), "medium");
    assert.equal(capDraftConfidence("high", { hold: true }), "low");
    assert.equal(capDraftConfidence("medium", { sensitive: true }), "medium");
  });
});

describe("edge case 4 — sensitive news", () => {
  it("detects layoffs and lawsuits", () => {
    assert.equal(isSensitiveHook("Amazon announces 10,000 layoffs"), true);
    assert.equal(isSensitiveHook("Amazon faces lawsuit over warehouse safety"), true);
    assert.equal(isSensitiveHook("Amazon opens a new fulfillment center"), false);
  });

  it("prefers a non-sensitive exact-company hook", () => {
    const layoff = signal({
      id: "layoff",
      title: "Amazon announces 10,000 layoffs",
      sensitive: true,
      relevance: 0.9,
    });
    const launch = signal({
      id: "launch",
      title: "Amazon launches a new logistics hub",
      kind: "product",
      relevance: 0.6,
    });
    assert.equal(pickHook([layoff, launch], bezos)?.id, "launch");
  });
});
