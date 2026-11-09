import type { ReactNode } from 'react'

/**
 * EmptyState — an empty screen is an invitation to act, not a shrug.
 *
 * Always says what would fill this space and what to do about it. No illustration,
 * no apology. The faint chart grid in the background is the same one used behind
 * empty charts, so "nothing here yet" looks deliberate rather than broken.
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 bg-chart-grid px-6 py-12 text-center [background-size:16px_16px]">
      <h3 className="font-display text-sm uppercase tracking-[0.1em] text-paper">{title}</h3>
      <p className="max-w-sm text-xs leading-relaxed text-paper-dim">{detail}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
