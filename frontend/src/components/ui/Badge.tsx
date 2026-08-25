import type { ReactNode } from 'react'
import type { RiskLevel } from '@/types'
import { RISK_CLASSES } from '@/lib/risk'

/**
 * Badge — a small state chip.
 *
 * `risk` is the only variant that gets colour, and it gets it from `risk.ts`.
 * Everything else is outlined in `rule`. That is the palette rule made structural:
 * a component literally cannot render a coloured badge for a non-hazard reason.
 */
export function Badge({
  children,
  risk,
  className = '',
}: {
  children: ReactNode
  risk?: RiskLevel
  className?: string
}) {
  const tone = risk
    ? `${RISK_CLASSES[risk].text} ${RISK_CLASSES[risk].border}`
    : 'text-paper-dim border-rule'

  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-1.5 py-px font-mono text-[10px] uppercase leading-4 tracking-[0.08em] ${tone} ${className}`}
    >
      {risk && <span className={`h-1.5 w-1.5 ${RISK_CLASSES[risk].bg}`} aria-hidden />}
      {children}
    </span>
  )
}
