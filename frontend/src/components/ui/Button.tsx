import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Button — outlined, never filled with a hazard colour.
 *
 * There is no "primary blue" or brand accent in this system, so emphasis is
 * carried by border weight and text brightness instead of fill. A red button
 * would claim severity it doesn't have; `danger` therefore only tints the *text*
 * and border, and is reserved for actions that genuinely destroy or dismiss.
 */
type Variant = 'default' | 'quiet' | 'danger' | 'primary'

const VARIANTS: Record<Variant, string> = {
  default:
    'border-white/10 bg-white/[0.04] text-paper hover:border-white/20 hover:bg-white/[0.08]',
  quiet:
    'border-transparent text-paper-dim hover:bg-white/[0.06] hover:text-paper',
  danger:
    'border-hazard/30 bg-hazard/[0.06] text-hazard-lit hover:border-hazard/60 hover:bg-hazard/15',
  // The one emphasised action on a surface. Accent, because it is interaction.
  primary:
    'border-signal/40 bg-signal/15 text-signal hover:border-signal/70 hover:bg-signal/25',
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
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.8125rem] font-medium transition-[colors,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-transparent disabled:text-paper-faint ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
