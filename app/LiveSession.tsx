"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import type { ProspectInput, RunRecord } from "@/lib/types";

const STORAGE_KEY = "signaldraft.liveSession.v1";
const USER_KEY = "signaldraft.liveUserId.v1";

export const defaultProspect: ProspectInput = {
  fullName: "Jeff Bezos",
  title: "Executive Chairman",
  company: "Amazon",
  linkedinUrl: "",
  notes: "",
  senderName: "Mandar",
  senderCompany: "Acme",
  senderOffer: "supply-chain visibility software for large retailers",
};

type LiveSessionValue = {
  form: ProspectInput;
  setForm: React.Dispatch<React.SetStateAction<ProspectInput>>;
  run: RunRecord | null;
  setRun: React.Dispatch<React.SetStateAction<RunRecord | null>>;
  subject: string;
  setSubject: React.Dispatch<React.SetStateAction<string>>;
  body: string;
  setBody: React.Dispatch<React.SetStateAction<string>>;
  note: string;
  setNote: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  clientStartedAt: number | null;
  setClientStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
  ready: boolean;
  refreshRun: () => Promise<void>;
  applyServerDraft: (runId: string, subject: string, body: string) => void;
  resetSession: () => void;
};

const LiveSessionContext = createContext<LiveSessionValue | null>(null);

type Stored = {
  form: ProspectInput;
  runId: string | null;
  subject: string;
  body: string;
  note: string;
};

function storageKeyFor(userId: string) {
  return `${STORAGE_KEY}:${userId}`;
}

function readStored(userId: string): Stored | null {
  try {
    const raw = sessionStorage.getItem(storageKeyFor(userId));
    if (!raw) return null;
    return JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
}

function writeStored(userId: string, data: Stored) {
  try {
    sessionStorage.setItem(storageKeyFor(userId), JSON.stringify(data));
  } catch {
    /* ignore quota */
  }
}

function clearStored(userId?: string | null) {
  try {
    if (userId) sessionStorage.removeItem(storageKeyFor(userId));
    // legacy unscoped key from before auth
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function LiveSessionProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;

  const [form, setForm] = useState<ProspectInput>(defaultProspect);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [clientStartedAt, setClientStartedAt] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const wipeLive = useCallback(() => {
    setForm(defaultProspect);
    setRun(null);
    setSubject("");
    setBody("");
    setNote("");
    setBusy(false);
    setClientStartedAt(null);
  }, []);

  // Hydrate (or clear) when auth state is known
  useEffect(() => {
    if (status === "loading") return;

    let cancelled = false;

    (async () => {
      if (status === "unauthenticated" || !userId) {
        wipeLive();
        clearStored(null);
        try {
          sessionStorage.removeItem(USER_KEY);
        } catch {
          /* ignore */
        }
        if (!cancelled) setReady(true);
        return;
      }

      let lastUser: string | null = null;
      try {
        lastUser = sessionStorage.getItem(USER_KEY);
      } catch {
        lastUser = null;
      }

      // Fresh login or account switch → empty Live board (no previous email)
      if (!lastUser || lastUser !== userId) {
        wipeLive();
        if (lastUser && lastUser !== userId) clearStored(lastUser);
        clearStored(userId);
        try {
          sessionStorage.setItem(USER_KEY, userId);
        } catch {
          /* ignore */
        }
        if (!cancelled) setReady(true);
        return;
      }

      // Same signed-in browser session (e.g. Live ↔ Dashboard) → restore in-progress work
      const stored = readStored(userId);
      if (stored?.form) setForm({ ...defaultProspect, ...stored.form });

      const runId = stored?.runId;
      if (runId) {
        try {
          const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
          if (res.ok) {
            const json = await res.json();
            if (!cancelled && json.run) {
              const loaded = json.run as RunRecord;
              setRun(loaded);
              setSubject(stored.subject || loaded.draft?.subject || "");
              setBody(stored.body || loaded.draft?.body || "");
              setNote(stored.note || "");
            }
          } else {
            // Stale / other-user run — don't keep orphan draft text
            if (!cancelled) {
              setRun(null);
              setSubject("");
              setBody("");
              setNote(stored.note || "");
              if (stored.form) setForm({ ...defaultProspect, ...stored.form });
            }
          }
        } catch {
          /* ignore */
        }
      } else if (!cancelled) {
        // No run tied to this session — never show a leftover email alone
        setRun(null);
        setSubject("");
        setBody("");
        setNote(stored?.note || "");
      }

      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [status, userId, wipeLive]);

  // Persist for this user after hydrate (same login session only)
  useEffect(() => {
    if (!ready || !userId || status !== "authenticated") return;
    writeStored(userId, {
      form,
      runId: run?.id ?? null,
      subject,
      body,
      note,
    });
  }, [ready, userId, status, form, run?.id, subject, body, note]);

  const refreshRun = useCallback(async () => {
    if (!run?.id || busy) return;
    try {
      const res = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      if (json.run) setRun(json.run as RunRecord);
    } catch {
      /* ignore */
    }
  }, [run?.id, busy]);

  const applyServerDraft = useCallback((runId: string, nextSubject: string, nextBody: string) => {
    setRun((prev) => {
      if (!prev || prev.id !== runId || !prev.draft) return prev;
      return {
        ...prev,
        draft: { ...prev.draft, subject: nextSubject, body: nextBody },
      };
    });
    setSubject(nextSubject);
    setBody(nextBody);
  }, []);

  const resetSession = useCallback(() => {
    wipeLive();
    clearStored(userId);
  }, [wipeLive, userId]);

  const value = useMemo(
    () => ({
      form,
      setForm,
      run,
      setRun,
      subject,
      setSubject,
      body,
      setBody,
      note,
      setNote,
      busy,
      setBusy,
      clientStartedAt,
      setClientStartedAt,
      ready,
      refreshRun,
      applyServerDraft,
      resetSession,
    }),
    [form, run, subject, body, note, busy, clientStartedAt, ready, refreshRun, applyServerDraft, resetSession]
  );

  return <LiveSessionContext.Provider value={value}>{children}</LiveSessionContext.Provider>;
}

export function useLiveSession() {
  const ctx = useContext(LiveSessionContext);
  if (!ctx) throw new Error("useLiveSession must be used within LiveSessionProvider");
  return ctx;
}

/** Call on sign-out so the next login starts with a clean Live board. */
export function clearLiveSessionOnSignOut() {
  try {
    const lastUser = sessionStorage.getItem(USER_KEY);
    clearStored(lastUser);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
