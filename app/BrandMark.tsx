/** SignalDraft mark — signal arcs + draft tip */
export function BrandMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
    >
      <rect width="32" height="32" rx="8" fill="currentColor" className="brand-mark-bg" />
      <path
        d="M9 21.5c3.6-3.8 10.4-3.8 14 0"
        stroke="var(--copper, #c96442)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M11.2 17c2.6-2.6 7-2.6 9.6 0"
        stroke="var(--copper, #c96442)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M13.4 12.6c1.4-1.4 3.8-1.4 5.2 0"
        stroke="#f3b59a"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="24.2" r="2.1" fill="var(--copper, #c96442)" />
    </svg>
  );
}
