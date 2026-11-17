import type { ReactNode } from 'react'

/**
 * Ring — a circular progress gauge with its value in the middle.
 *
 * Coverage reads better as a ring than as a bar on a card this size: the number
 * sits where the eye lands, and the arc gives proportion without a second label.
 * `role="meter"` so the value is announced, not just drawn.
 */
export function Ring({
  value,
  size = 88,
  stroke = 7,
  color = 'var(--signal)',
  label,
  children,
}: {
  /** 0..1 */
  value: number
  size?: number
  stroke?: number
  color?: string
  label: string
  children?: ReactNode
}) {
  const v = Math.max(0, Math.min(1, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          style={{ transition: 'stroke-dasharray 600ms ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  )
}
