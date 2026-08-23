/** Decorative field for the Live home page — signal arcs + constellation. */
export function HomeBackdrop({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <div className={`home-backdrop${dimmed ? " is-dim" : ""}`} aria-hidden>
      <div className="home-orb home-orb-copper" />
      <div className="home-orb home-orb-sage" />
      <div className="home-orb home-orb-warm" />
      <svg className="home-signal-field" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="home-arc" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#c96442" stopOpacity="0" />
            <stop offset="40%" stopColor="#c96442" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#c96442" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="home-arc-soft" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#c96442" stopOpacity="0" />
            <stop offset="50%" stopColor="#e08a68" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3d7a5c" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="home-node" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c96442" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#c96442" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g className="home-arcs" fill="none" strokeLinecap="round">
          <path d="M-40 820c220-240 520-380 780-420" stroke="url(#home-arc)" strokeWidth="1.6" />
          <path d="M-20 860c260-280 600-430 900-470" stroke="url(#home-arc-soft)" strokeWidth="1.2" />
          <path d="M40 900c280-300 640-460 980-500" stroke="url(#home-arc)" strokeWidth="1" opacity="0.7" />
          <path d="M1480 80c-240 180-520 260-780 280" stroke="url(#home-arc-soft)" strokeWidth="1.2" />
          <path d="M1460 40c-280 210-600 300-900 320" stroke="url(#home-arc)" strokeWidth="1" opacity="0.55" />
        </g>

        <g className="home-ring" fill="none" stroke="#c96442" strokeOpacity="0.18">
          <circle cx="1180" cy="160" r="120" strokeWidth="1" strokeDasharray="3 10" />
          <circle cx="1180" cy="160" r="188" strokeWidth="1" strokeDasharray="2 14" />
          <circle cx="1180" cy="160" r="268" strokeWidth="0.8" strokeDasharray="1 16" opacity="0.7" />
        </g>

        <g className="home-constellation" stroke="#c96442" strokeOpacity="0.16" strokeWidth="0.9">
          <line x1="180" y1="220" x2="280" y2="160" />
          <line x1="280" y1="160" x2="360" y2="210" />
          <line x1="360" y1="210" x2="430" y2="140" />
          <line x1="280" y1="160" x2="250" y2="280" />
          <line x1="250" y1="280" x2="340" y2="330" />
          <line x1="1080" y1="620" x2="1180" y2="560" />
          <line x1="1180" y1="560" x2="1280" y2="610" />
          <line x1="1180" y1="560" x2="1220" y2="700" />
          <line x1="980" y1="680" x2="1080" y2="620" />
          <line x1="720" y1="120" x2="800" y2="80" />
          <line x1="800" y1="80" x2="870" y2="130" />
        </g>

        <g className="home-nodes" fill="#c96442">
          <circle cx="180" cy="220" r="2.4" opacity="0.45" />
          <circle cx="280" cy="160" r="3.2" opacity="0.7" />
          <circle cx="360" cy="210" r="2.2" opacity="0.4" />
          <circle cx="430" cy="140" r="2.6" opacity="0.55" />
          <circle cx="250" cy="280" r="2" opacity="0.35" />
          <circle cx="340" cy="330" r="2.4" opacity="0.45" />
          <circle cx="720" cy="120" r="2.2" opacity="0.4" />
          <circle cx="800" cy="80" r="3" opacity="0.6" />
          <circle cx="870" cy="130" r="2" opacity="0.35" />
          <circle cx="980" cy="680" r="2.2" opacity="0.4" />
          <circle cx="1080" cy="620" r="2.8" opacity="0.55" />
          <circle cx="1180" cy="560" r="3.4" opacity="0.75" />
          <circle cx="1280" cy="610" r="2.2" opacity="0.4" />
          <circle cx="1220" cy="700" r="2" opacity="0.35" />
          <circle cx="1180" cy="160" r="4" fill="url(#home-node)" />
          <circle cx="1180" cy="160" r="3.2" opacity="0.85" />
        </g>
      </svg>
    </div>
  );
}
