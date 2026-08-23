"use client";

import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  r: number;
  s: number;
  a: number;
  tint: "copper" | "cyan" | "white";
};

export function HomeBackdrop({ dimmed = false }: { dimmed?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const stars: Star[] = Array.from({ length: 110 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.35 + 0.25,
      s: Math.random() * 0.18 + 0.04,
      a: Math.random() * 0.55 + 0.12,
      tint: Math.random() < 0.2 ? "copper" : Math.random() < 0.14 ? "cyan" : "white",
    }));

    let raf = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const draw = (t: number) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      for (const star of stars) {
        if (!reduce) {
          star.y -= star.s / 1600;
          if (star.y < -0.02) star.y = 1.02;
        }
        const tw = reduce ? star.a : star.a * (0.62 + 0.38 * Math.sin(t / 680 + star.x * 14));
        ctx.beginPath();
        ctx.fillStyle =
          star.tint === "copper"
            ? `rgba(232, 140, 98, ${tw})`
            : star.tint === "cyan"
              ? `rgba(110, 220, 228, ${tw})`
              : `rgba(255, 246, 236, ${tw})`;
        ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const onMove = (e: MouseEvent) => {
      root.style.setProperty("--px", `${(e.clientX / window.innerWidth - 0.5) * 28}px`);
      root.style.setProperty("--py", `${(e.clientY / window.innerHeight - 0.5) * 18}px`);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div ref={rootRef} className={`home-backdrop${dimmed ? " is-dim" : ""}`} aria-hidden>
      <canvas ref={canvasRef} className="home-stars" />
      <div className="home-glow home-glow-copper" />
      <div className="home-glow home-glow-cyan" />
      <div className="home-glow home-glow-magenta" />
      <div className="home-sculpture">
        <svg viewBox="0 0 640 640" className="home-sculpture-svg">
          <defs>
            <radialGradient id="core" cx="50%" cy="42%" r="38%">
              <stop offset="0%" stopColor="#fff6ea" stopOpacity="0.95" />
              <stop offset="28%" stopColor="#f3b59a" stopOpacity="0.55" />
              <stop offset="62%" stopColor="#c96442" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#c96442" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="facet" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#7ee0e6" stopOpacity="0.35" />
              <stop offset="50%" stopColor="#c96442" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#d45aa0" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          <g className="home-chroma" opacity="0.45">
            <circle cx="318" cy="248" r="86" fill="#5ad4dc" opacity="0.18" />
            <circle cx="326" cy="252" r="86" fill="#e25a8c" opacity="0.14" />
          </g>
          <circle cx="322" cy="250" r="92" fill="url(#core)" />
          <g fill="url(#facet)" stroke="#f3b59a" strokeOpacity="0.22" strokeWidth="0.8">
            <rect x="286" y="368" width="54" height="54" transform="rotate(45 313 395)" />
            <rect x="338" y="392" width="40" height="40" transform="rotate(45 358 412)" />
            <rect x="248" y="390" width="36" height="36" transform="rotate(45 266 408)" />
            <rect x="300" y="436" width="46" height="46" transform="rotate(45 323 459)" />
            <rect x="360" y="430" width="30" height="30" transform="rotate(45 375 445)" />
            <rect x="268" y="448" width="28" height="28" transform="rotate(45 282 462)" />
          </g>
        </svg>
      </div>
      <div className="home-scanlines" />
    </div>
  );
}
