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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-full border border-white/[0.08] bg-white/[0.03]" aria-hidden>
        <span className="size-2 rounded-full bg-paper-faint/60" />
      </span>
      <h3 className="text-[0.9375rem] font-medium text-paper">{title}</h3>
      <p className="max-w-sm text-[0.8125rem] leading-relaxed text-paper-faint">{detail}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
