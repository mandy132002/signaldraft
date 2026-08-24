import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  companyContextEquals,
  hasCompanyContext,
  mergeCompanyContext,
  sanitizeCompanyContext,
} from "./company-context";

describe("company context", () => {
  it("treats blank fields as empty", () => {
    assert.equal(hasCompanyContext({ senderName: "", senderCompany: "  ", senderOffer: "" }), false);
    assert.equal(hasCompanyContext({ senderName: "Mandar", senderCompany: "", senderOffer: "" }), true);
  });

  it("fills only blank sender fields from the saved profile", () => {
    const saved = {
      senderName: "Mandar",
      senderCompany: "BrowserStack",
      senderOffer: "agentic testing",
    };
    const merged = mergeCompanyContext(
      { senderName: "", senderCompany: "One-off Co", senderOffer: "  " },
      saved
    );
    assert.equal(merged.senderName, "Mandar");
    assert.equal(merged.senderCompany, "One-off Co");
    assert.equal(merged.senderOffer, "agentic testing");
  });

  it("leaves input alone when nothing is saved", () => {
    const input = { senderName: "", senderCompany: "Acme", senderOffer: "" };
    assert.deepEqual(mergeCompanyContext(input, null), input);
    assert.deepEqual(mergeCompanyContext(input, { senderName: "", senderCompany: "", senderOffer: "" }), input);
  });

  it("clips and trims on sanitize", () => {
    const cleaned = sanitizeCompanyContext({
      senderName: "  Jane  ",
      senderCompany: "x".repeat(250),
      senderOffer: "  we sell visibility  ",
    });
    assert.equal(cleaned.senderName, "Jane");
    assert.equal(cleaned.senderCompany.length, 200);
    assert.equal(cleaned.senderOffer, "we sell visibility");
  });

  it("compares trimmed values", () => {
    assert.equal(
      companyContextEquals(
        { senderName: "A", senderCompany: "B ", senderOffer: "C" },
        { senderName: "A", senderCompany: "B", senderOffer: "C" }
      ),
      true
    );
  });
});
