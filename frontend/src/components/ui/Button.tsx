import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Button — outlined, never filled with a hazard colour.
 *
 * There is no "primary blue" or brand accent in this system, so emphasis is
 * carried by border weight and text brightness instead of fill. A red button
 * would claim severity it doesn't have; `danger` therefore only tints the *text*
 * and border, and is reserved for actions that genuinely destroy or dismiss.
 */
type Variant = 'default' | 'quiet' | 'danger'

const VARIANTS: Record<Variant, string> = {
  default:
    'border-rule-bright text-paper hover:border-paper-dim hover:bg-ink-hover',
  quiet:
    'border-transparent text-paper-dim hover:border-rule hover:text-paper hover:bg-ink-hover',
  danger:
    'border-rule text-hazard hover:border-hazard hover:bg-hazard/10',
}

export function Button({
  children,
  variant = 'default',
  icon,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  icon?: ReactNode
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 border px-2.5 py-1 font-display text-[11px] uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed disabled:border-rule disabled:text-paper-faint disabled:hover:bg-transparent ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
