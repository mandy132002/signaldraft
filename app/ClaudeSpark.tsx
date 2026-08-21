/** Claude-style blooming asterisk / spark loader */
export function ClaudeSpark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`claude-spark ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
      role="presentation"
    >
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <g className="claude-spark-rays">
          <path
            className="claude-spark-arm a1"
            d="M16 3.2c.7 0 1.2.4 1.4 1l2.2 7.4c.1.4.4.7.8.8l7.4 2.2c.6.2 1 1 1 1.6s-.4 1.2-1 1.4l-7.4 2.2c-.4.1-.7.4-.8.8L17.4 28c-.2.6-1 1-1.6 1s-1.2-.4-1.4-1l-2.2-7.4c-.1-.4-.4-.7-.8-.8L4.2 17.6c-.6-.2-1-1-1-1.6s.4-1.2 1-1.4l7.4-2.2c.4-.1.7-.4.8-.8L14.6 4.2c.2-.6 1-1 1.4-1z"
          />
        </g>
      </svg>
    </span>
  );
}
