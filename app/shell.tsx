"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthMenu } from "./AuthMenu";
import { BrandMark } from "./BrandMark";
import { ClaudeSpark } from "./ClaudeSpark";

export function Shell({
  children,
  bare = false,
  wide = false,
}: {
  children: React.ReactNode;
  bare?: boolean;
  wide?: boolean;
}) {
  const path = usePathname();
  return (
    <div className={`app-shell${wide ? " is-wide" : ""}`}>
      <header className="topbar">
        <Link href={bare ? "/login" : "/"} className="brand" aria-label="SignalDraft home">
          <BrandMark size={26} />
          Signal<span>Draft</span>
        </Link>
        {bare ? (
          <div className="nav" aria-hidden />
        ) : (
          <div className="topbar-right">
            <nav className="nav" aria-label="Primary">
              <Link className={path === "/" ? "active" : ""} href="/">
                Live
              </Link>
              <Link className={path.startsWith("/bulk") ? "active" : ""} href="/bulk">
                Bulk
              </Link>
              <Link className={path === "/history" ? "active" : ""} href="/history">
                Dashboard
              </Link>
            </nav>
            <AuthMenu />
          </div>
        )}
      </header>
      {children}
    </div>
  );
}

export function PageIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-intro" style={{ marginBottom: 28 }}>
      {eyebrow ? (
        <p
          style={{
            margin: "0 0 8px",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--copper)",
            letterSpacing: "0.04em",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ClaudeSpark size={14} />
          {eyebrow}
        </p>
      ) : null}
      {title ? (
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
          {title}
        </h1>
      ) : null}
      {children}
    </div>
  );
}
