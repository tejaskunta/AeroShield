import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useReducedMotion } from '@/hooks/useReducedMotion'

/**
 * StatReadout — one labelled telemetry value.
 *
 * The label is small and tracked-out; the value is condensed display type at
 * readout size with tabular numerals so digits don't jitter as telemetry ticks.
 * The unit is set separately and dimmer, because the operator is reading the
 * number — the unit is just there to disambiguate it.
 */
export function StatReadout({
  label,
  value,
  unit,
  tone = 'normal',
  aside,
  size = 'md',
}: {
  label: string
  /** Accepts a node so `<CountUp />` can be dropped in as the value. */
  value: ReactNode
  unit?: string
  /** `warn` dims nothing but marks a value that needs attention via text colour. */
  tone?: 'normal' | 'warn' | 'bad' | 'good'
  aside?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const toneClass = {
    normal: 'text-paper',
    good: 'text-cleared',
    warn: 'text-caution',
    bad: 'text-hazard',
  }[tone]

  const sizeClass = {
    sm: 'text-[15px]',
    md: 'text-readout',
    lg: 'text-readout-lg',
  }[size]

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span className="eyebrow">{label}</span>
        {aside}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`font-display tabular ${sizeClass} ${toneClass}`}>{value}</span>
        {unit && <span className="font-mono text-[10px] text-paper-dim">{unit}</span>}
      </div>
    </div>
  )
}

/**
 * CountUp — spins a numeric readout up from zero once, on mount.
 *
 * This is the "instruments powering on" moment, and it fires exactly once per
 * mount, never on subsequent value changes: a value that re-animated every tick
 * would be unreadable. Skipped entirely under reduced motion, which lands on the
 * final value immediately.
 */
export function CountUp({
  value,
  durationMs = 700,
  decimals = 0,
}: {
  value: number
  durationMs?: number
  decimals?: number
}) {
  const reduced = useReducedMotion()
  const [display, setDisplay] = useState(reduced ? value : 0)
  const [spunUp, setSpunUp] = useState(reduced)
  /** Live target, read inside the rAF loop so a tick mid-spin-up isn't lost. */
  const target = useRef(value)
  target.current = value

  // The one-shot spin-up. Runs on mount only.
  useEffect(() => {
    if (reduced) {
      setDisplay(target.current)
      setSpunUp(true)
      return
    }
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      // Ease-out cubic — fast rise, gentle settle, like a needle finding its mark.
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(target.current * eased)
      if (t < 1) frame = requestAnimationFrame(step)
      else setSpunUp(true)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [reduced, durationMs])

  // After the spin-up, track live telemetry directly — never re-animate.
  useEffect(() => {
    if (spunUp) setDisplay(value)
  }, [spunUp, value])

  return <>{display.toFixed(decimals)}</>
}
