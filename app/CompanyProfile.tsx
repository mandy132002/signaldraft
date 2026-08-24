"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  EMPTY_COMPANY_CONTEXT,
  hasCompanyContext,
  sanitizeCompanyContext,
} from "@/lib/company-context";
import type { CompanyContext } from "@/lib/types";

type CompanyProfileValue = {
  profile: CompanyContext;
  loaded: boolean;
  saving: boolean;
  hasProfile: boolean;
  save: (next: CompanyContext) => Promise<CompanyContext>;
};

const CompanyProfileContext = createContext<CompanyProfileValue | null>(null);

export function CompanyProfileProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const [profile, setProfile] = useState<CompanyContext>(EMPTY_COMPANY_CONTEXT);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status === "loading") return;

    if (status !== "authenticated" || !userId) {
      setProfile(EMPTY_COMPANY_CONTEXT);
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setProfile(EMPTY_COMPANY_CONTEXT);
    setLoaded(false);

    (async () => {
      try {
        const res = await fetch("/api/company-context", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as CompanyContext;
        if (!cancelled) setProfile(sanitizeCompanyContext(json));
      } catch {
        /* keep empty */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, userId]);

  const save = useCallback(async (next: CompanyContext) => {
    setSaving(true);
    try {
      const res = await fetch("/api/company-context", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sanitizeCompanyContext(next)),
      });
      if (!res.ok) {
        throw new Error("Could not save company context");
      }
      const json = sanitizeCompanyContext((await res.json()) as CompanyContext);
      setProfile(json);
      return json;
    } finally {
      setSaving(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      profile,
      loaded,
      saving,
      hasProfile: hasCompanyContext(profile),
      save,
    }),
    [profile, loaded, saving, save]
  );

  return <CompanyProfileContext.Provider value={value}>{children}</CompanyProfileContext.Provider>;
}

export function useCompanyProfile() {
  const ctx = useContext(CompanyProfileContext);
  if (!ctx) throw new Error("useCompanyProfile must be used within CompanyProfileProvider");
  return ctx;
}
