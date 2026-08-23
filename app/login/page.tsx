"use client";

import { useEffect } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Shell } from "../shell";
import { BrandMark } from "../BrandMark";

export default function LoginPage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  return (
    <Shell bare>
      <div className="login-screen">
        <div className="login-panel">
          <div className="login-mark" aria-hidden>
            <BrandMark size={52} />
          </div>
          <h1 className="login-title">
            Signal<span>Draft</span>
          </h1>
          <p className="login-copy">
            Research prospects. Draft outreach. Review before you send — private to your Google account.
          </p>
          <button
            type="button"
            className="btn google-btn"
            disabled={status === "loading" || status === "authenticated"}
            onClick={() => signIn("google", { callbackUrl: "/" })}
          >
            <span className="btn-inner">
              <GoogleMark />
              {status === "authenticated" ? "Redirecting…" : "Continue with Google"}
            </span>
          </button>
          <p className="hint">Human review only. Nothing is sent automatically.</p>
        </div>
      </div>
    </Shell>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16.1 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.6 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l.1.1 6.2 5.2C39.2 36.3 44 31 44 24c0-1.3-.1-2.5-.4-3.5z"
      />
    </svg>
  );
}
