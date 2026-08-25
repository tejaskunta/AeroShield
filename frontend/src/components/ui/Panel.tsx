import type { ReactNode } from 'react'

/**
 * Panel — the dock plate every readout sits on.
 *
 * A panel is a hairlined rectangle with a tracked-out eyebrow header. No shadow,
 * no rounding beyond 2px, no gradient: it should read as sheet metal, not as a
 * floating card. `flush` drops the body padding for panels holding a map or table.
 */
export function Panel({
  title,
  aside,
  children,
  flush = false,
  className = '',
}: {
  title?: string
  /** Right-aligned slot in the header — a count, a toggle, a status dot. */
  aside?: ReactNode
  children: ReactNode
  flush?: boolean
  className?: string
}) {
  return (
    <section className={`border border-rule bg-ink-raised ${className}`}>
      {title && (
        <header className="flex h-8 items-center justify-between gap-2 border-b border-rule px-3">
          <h2 className="eyebrow truncate">{title}</h2>
          {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-3'}>{children}</div>
    </section>
  )
}
