import { useEffect, useRef, useState } from 'react'

/**
 * Sparkline — a value's recent trend, with a hover readout.
 *
 * One neutral line (colour is reserved for hazard state; the value next to it
 * carries any warning), a soft fill under it, and a crosshair + value on hover so
 * the trend can be read, not just seen. Flat data draws flat, never stretched into
 * fake movement: the y range has a minimum span.
 */
export function Sparkline({
  values,
  width: maxWidth = 96,
  height = 22,
  minSpan = 1,
  format = (v) => v.toFixed(1),
  label,
}: {
  values: number[]
  width?: number
  height?: number
  /** Smallest y range drawn, so jitter on a steady value is not magnified. */
  minSpan?: number
  format?: (v: number) => string
  label: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // Fits its container (up to `maxWidth`), so a narrow card in split layout never
  // overflows; measured rather than CSS-stretched so markers stay round.
  const box = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(maxWidth)
  useEffect(() => {
    const el = box.current?.parentElement
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(Math.max(24, Math.min(maxWidth, el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxWidth])
  if (values.length < 2) {
    return <div ref={box} style={{ width, height }} className="rounded-sm bg-white/[0.02]" aria-hidden />
  }
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2
    lo = mid - minSpan / 2
    hi = mid + minSpan / 2
  }
  const pad = 2
  const x = (i: number) => (i / (values.length - 1)) * width
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = `${d}L${width},${height}L0,${height}Z`
  const hi_ = hover !== null ? values[hover]! : null

  return (
    <div ref={box} className="relative" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        className="overflow-visible"
        role="img"
        aria-label={`${label}: last ${values.length} readings, now ${format(values[values.length - 1]!)}`}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const i = Math.round(((e.clientX - r.left) / r.width) * (values.length - 1))
          setHover(Math.max(0, Math.min(values.length - 1, i)))
        }}
        onMouseLeave={() => setHover(null)}
      >
        <path d={area} fill="rgba(233,237,241,0.06)" />
        <path d={d} fill="none" stroke="rgba(233,237,241,0.55)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r={2} fill="var(--paper)" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke="rgba(233,237,241,0.35)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(values[hover]!)} r={2.5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {hi_ !== null && (
        <span className="pointer-events-none absolute -top-6 right-0 whitespace-nowrap rounded border border-white/10 bg-ink-raised px-1.5 py-0.5 font-mono text-[0.625rem] text-paper">
          {format(hi_)} · {values.length - 1 - hover!}s ago
        </span>
      )}
    </div>
  )
}

/**
 * The last `n` samples of a value, appended whenever `key` changes (one telemetry
 * frame = one sample, ~1 Hz). Reset when the mission source changes is unnecessary:
 * the window is short enough to roll over on its own.
 */
export function useHistory(value: number | null | undefined, key: unknown, n = 120): number[] {
  const buf = useRef<number[]>([])
  const [, force] = useState(0)
  useEffect(() => {
    if (value === null || value === undefined || !Number.isFinite(value)) return
    buf.current = [...buf.current, value].slice(-n)
    force((x) => x + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return buf.current
}
