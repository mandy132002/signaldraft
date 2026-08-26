"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { companyContextEquals, hasCompanyContext } from "@/lib/company-context";
import type { CompanyContext } from "@/lib/types";
import { useCompanyProfile } from "./CompanyProfile";

export function SenderContextFields({
  value,
  onChange,
  compactAction,
}: {
  value: CompanyContext;
  onChange: (next: CompanyContext) => void;
  compactAction: string;
}) {
  const { profile, loaded, saving, hasProfile, save } = useCompanyProfile();
  const [override, setOverride] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasProfile) setOverride(false);
  }, [hasProfile]);

  const dirtyVsProfile = !companyContextEquals(value, profile);
  const canSave = hasCompanyContext(value);
  const nameOnlyProfile = Boolean(profile.senderName.trim()) && !profile.senderCompany.trim();
  const savedTitle = nameOnlyProfile ? "Your profile" : "Your company";

  if (!loaded) {
    return (
      <div className="sender-context">
        <p className="sender-context-title">Your company</p>
        <p className="hint" style={{ margin: "8px 0 0" }}>
          Loading company profile…
        </p>
      </div>
    );
  }

  const showFields = !hasProfile || override;

  async function saveProfile() {
    setError(null);
    try {
      await save(value);
      setOverride(false);
      setFlash("Saved to your company profile");
      window.setTimeout(() => setFlash(null), 2200);
    } catch {
      setError("Could not save company profile.");
    }
  }

  function useSaved() {
    onChange({ ...profile });
    setOverride(false);
    setError(null);
  }

  return (
    <div className="sender-context">
      <div className="sender-context-head">
        <p className="sender-context-title">{hasProfile && !override ? savedTitle : "You (SDR)"}</p>
        {hasProfile && !override ? (
          <div className="sender-context-links">
            <Link href="/company">Edit profile</Link>
            <button type="button" className="text-btn" onClick={() => setOverride(true)}>
              {compactAction}
            </button>
          </div>
        ) : (
          <div className="sender-context-links">
            <Link href="/company">Company profile</Link>
          </div>
        )}
      </div>

      {showFields ? (
        <>
          <p className="hint" style={{ margin: "4px 0 8px" }}>
            {hasProfile
              ? "Overrides these defaults only unless you save them to your company profile."
              : "Save this once so Live and Bulk can reuse it."}
          </p>
          <div className="row2">
            <div>
              <label>Your name</label>
              <input
                value={value.senderName}
                onChange={(e) => onChange({ ...value, senderName: e.target.value })}
                placeholder="Your name"
              />
            </div>
            <div>
              <label>Your company</label>
              <input
                value={value.senderCompany}
                onChange={(e) => onChange({ ...value, senderCompany: e.target.value })}
                placeholder="Your company"
              />
            </div>
          </div>
          <label>What you sell (goes in the email)</label>
          <textarea
            value={value.senderOffer}
            onChange={(e) => onChange({ ...value, senderOffer: e.target.value })}
            placeholder="Brief description of your product or service"
          />
          <div className="sender-context-actions">
            {hasProfile ? (
              <button type="button" className="text-btn" onClick={useSaved}>
                Use saved profile
              </button>
            ) : null}
            <button
              type="button"
              className="text-btn strong"
              disabled={saving || !canSave || (hasProfile && !dirtyVsProfile)}
              onClick={() => void saveProfile()}
            >
              {saving ? "Saving…" : "Save to company profile"}
            </button>
          </div>
        </>
      ) : (
        <div className="sender-summary">
          <p className="sender-summary-who">
            {profile.senderName || "You"}
            {profile.senderCompany ? ` · ${profile.senderCompany}` : ""}
          </p>
          {profile.senderOffer ? <p className="sender-summary-offer">{profile.senderOffer}</p> : null}
        </div>
      )}

      {flash ? <p className="hint sender-context-flash">{flash}</p> : null}
      {error ? (
        <p className="hint" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
