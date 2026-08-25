import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClarifyRequest,
  companyNeedsDisambiguation,
  mergeClarifyAnswers,
  workplaceLooksConfirmed,
} from "./clarify";
import type { LinkedInContext } from "./linkedin";

const li = (over: Partial<LinkedInContext>): LinkedInContext => ({
  url: "https://linkedin.com/in/jane",
  employerHints: [],
  domainHints: [],
  employerMatchesCompany: null,
  fetched: false,
  note: "",
  ...over,
});

describe("clarify — mid-run questions", () => {
  it("flags short and collision-prone company names", () => {
    assert.equal(companyNeedsDisambiguation("Cube"), true);
    assert.equal(companyNeedsDisambiguation("Meta"), true);
    assert.equal(companyNeedsDisambiguation("Cube Global"), true);
    assert.equal(companyNeedsDisambiguation("BrowserStack"), false);
    assert.equal(companyNeedsDisambiguation("Cube Logistics Inc"), true);
  });

  it("does not pause when LinkedIn or the website already confirms the org", () => {
    const prospect = { fullName: "Jane Doe", title: "", company: "Cube" };
    assert.equal(
      buildClarifyRequest(
        prospect,
        li({ fetched: true, employerMatchesCompany: true, employerHints: ["Cube.dev"] }),
        null,
        0
      ),
      null
    );
    assert.equal(
      workplaceLooksConfirmed(null, {
        url: "https://cube.dev",
        host: "cube.dev",
        domain: "cube.dev",
        fetched: true,
        matchesCompany: true,
        note: "ok",
      }),
      true
    );
  });

  it("asks which workplace when LinkedIn conflicts with the typed company", () => {
    const req = buildClarifyRequest(
      { fullName: "Santhosh", title: "", company: "Cube Global" },
      li({
        fetched: true,
        employerMatchesCompany: false,
        employerHints: ["Cube Logistics"],
        domainHints: ["cubelogistics.com"],
      }),
      null,
      0
    );
    assert.ok(req);
    assert.match(req!.reason, /LinkedIn looks like/i);
    assert.ok(req!.questions.some((q) => q.field === "company"));
    assert.ok(req!.questions.some((q) => q.field === "companyWebsite"));
    assert.ok(req!.questions.find((q) => q.field === "company")?.suggestions?.includes("Cube Logistics"));
  });

  it("asks for a website when LinkedIn was given but could not be read", () => {
    const req = buildClarifyRequest(
      { fullName: "Jane", title: "", company: "Cube", linkedinUrl: "https://linkedin.com/in/jane" },
      li({ fetched: false, note: "blocked" }),
      null,
      0
    );
    assert.ok(req);
    assert.match(req!.reason, /couldn't read that LinkedIn/i);
    assert.ok(req!.questions.some((q) => q.field === "companyWebsite"));
  });

  it("asks to disambiguate Cube Global when there is no website or LinkedIn", () => {
    const req = buildClarifyRequest(
      { fullName: "Santhosh", title: "", company: "Cube Global" },
      null,
      null,
      0
    );
    assert.ok(req);
    assert.match(req!.reason, /collision|unrelated orgs/i);
    assert.ok(req!.questions.some((q) => q.field === "companyWebsite"));
  });

  it("uses generic placeholders, not Cube-specific examples", () => {
    const meta = buildClarifyRequest({ fullName: "Jane", title: "", company: "Meta" }, null, null, 0);
    assert.ok(meta);
    const website = meta!.questions.find((q) => q.field === "companyWebsite");
    assert.equal(website?.placeholder, "https://company.com");
    assert.doesNotMatch(meta!.reason, /cube\.dev|Cube Logistics/i);
    for (const q of meta!.questions) {
      assert.doesNotMatch(q.placeholder || "", /cube\.dev|Cube Logistics/i);
    }

    const unread = buildClarifyRequest(
      { fullName: "Jane", title: "", company: "Apex", linkedinUrl: "https://linkedin.com/in/jane" },
      li({ fetched: false, note: "blocked" }),
      null,
      0
    );
    const notes = unread?.questions.find((q) => q.field === "notes");
    assert.match(notes?.placeholder || "", /Apex/);
    assert.doesNotMatch(notes?.placeholder || "", /cube\.dev/i);
  });

  it("does not ask again after the first round", () => {
    const req = buildClarifyRequest(
      { fullName: "Jane", title: "", company: "Cube" },
      null,
      null,
      1
    );
    assert.equal(req, null);
  });

  it("merges answers onto the prospect without dropping existing notes", () => {
    const next = mergeClarifyAnswers(
      { fullName: "Jane", title: "VP", company: "Cube", notes: "Met at a meetup" },
      { companyWebsite: "https://cube.dev", company: "Cube.dev", notes: "analytics warehouse" }
    );
    assert.equal(next.company, "Cube.dev");
    assert.equal(next.companyWebsite, "https://cube.dev");
    assert.match(next.notes || "", /meetup/);
    assert.match(next.notes || "", /analytics warehouse/);
  });
});
