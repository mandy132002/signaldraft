"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { clearLiveSessionOnSignOut } from "./LiveSession";

export function AuthMenu() {
  const { data, status } = useSession();

  if (status === "loading") {
    return <span className="auth-chip muted">…</span>;
  }

  if (!data?.user) {
    return (
      <button type="button" className="auth-chip" onClick={() => signIn("google")}>
        Sign in
      </button>
    );
  }

  const label = data.user.name || data.user.email || "Account";

  return (
    <div className="auth-menu">
      {data.user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="auth-avatar" src={data.user.image} alt="" referrerPolicy="no-referrer" />
      ) : null}
      <span className="auth-name" title={data.user.email ?? undefined}>
        {label}
      </span>
      <button
        type="button"
        className="auth-chip"
        onClick={() => {
          clearLiveSessionOnSignOut();
          void signOut({ callbackUrl: "/login" });
        }}
      >
        Sign out
      </button>
    </div>
  );
}
