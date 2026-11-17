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
    : 'text-paper-dim border-white/10 bg-white/[0.03]'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium leading-4 ${tone} ${className}`}
    >
      {risk && <span className={`h-1.5 w-1.5 rounded-full ${RISK_CLASSES[risk].bg}`} aria-hidden />}
      {children}
    </span>
  )
}
