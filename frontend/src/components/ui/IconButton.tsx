import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * IconButton — a square glass control for the map.
 *
 * Always carries an accessible name: an icon alone is not a label. `active` marks
 * a toggled state in the accent colour, which is interaction, not hazard.
 */
export function IconButton({
  label,
  active = false,
  children,
  className = '',
  bare = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  /** No glass of its own — for buttons stacked inside a shared glass column. */
  bare?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={`grid size-9 place-items-center rounded-md transition-colors ${bare ? '' : 'glass'} ${active ? 'text-signal' : 'text-paper-dim hover:bg-white/[0.07] hover:text-paper'
        } ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
