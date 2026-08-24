"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { hasCompanyContext } from "@/lib/company-context";
import type { CompanyContext } from "@/lib/types";
import { useCompanyProfile } from "../CompanyProfile";
import { ClaudeSpark } from "../ClaudeSpark";
import { Shell } from "../shell";

export default function CompanyPage() {
  const { data: session } = useSession();
  const { profile, loaded, saving, save } = useCompanyProfile();
  const [form, setForm] = useState<CompanyContext>(profile);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) return;
    setForm({
      senderName: profile.senderName || session?.user?.name || "",
      senderCompany: profile.senderCompany,
      senderOffer: profile.senderOffer,
    });
  }, [loaded, profile, session?.user?.name]);

  const set =
    (key: keyof CompanyContext) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await save(form);
      setFlash("Saved. Live and Bulk will use this automatically.");
      window.setTimeout(() => setFlash(null), 2800);
    } catch {
      setError("Could not save company context.");
    }
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
          Your company
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
          Set it once. Reuse it everywhere.
        </h1>
        <p className="lede" style={{ marginBottom: 0, maxWidth: 560 }}>
          Your name, company, and what you sell go into every outreach draft. Save them here instead of
          typing them on each Live or Bulk run. You can still override a single run if you need to.
        </p>
      </div>

      <form className="card company-card" onSubmit={(e) => void onSave(e)}>
        <h2>Company context</h2>
        <label>Your name</label>
        <input
          value={form.senderName}
          onChange={set("senderName")}
          placeholder={session?.user?.name || "Your name"}
          disabled={!loaded || saving}
        />
        <label>Your company</label>
        <input
          value={form.senderCompany}
          onChange={set("senderCompany")}
          placeholder="Your company"
          disabled={!loaded || saving}
        />
        <label>What you sell (goes in the email)</label>
        <textarea
          value={form.senderOffer}
          onChange={set("senderOffer")}
          placeholder="Brief description of your product or service"
          disabled={!loaded || saving}
        />
        <button className="btn" type="submit" disabled={!loaded || saving || !hasCompanyContext(form)}>
          <span className="btn-inner">{saving ? "Saving…" : loaded && hasCompanyContext(profile) ? "Update profile" : "Save profile"}</span>
        </button>
        {flash ? <p className="hint sender-context-flash">{flash}</p> : null}
        {error ? (
          <p className="hint" style={{ color: "var(--bad)" }}>
            {error}
          </p>
        ) : null}
        <p className="hint">
          {loaded && hasCompanyContext(profile)
            ? "Live and Bulk already use this profile. Changing it here updates the default for new runs."
            : "Nothing is stored until you save. Prospect details stay on each run as usual."}
        </p>
      </form>
    </Shell>
  );
}
