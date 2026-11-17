import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Detection } from '@/types'
import { useContainerProjection } from '@/components/map/useMapHooks'
import { DetectionCard } from './DetectionCard'

/**
 * DetectionCallout — the detection card, pinned to its pin on the 2D map.
 *
 * The card is tied to the ground by a leader line, the way a survey plate annotates
 * a point on a chart, and the line is redrawn on every pan and zoom so the tie stays
 * true. It is an overlay rather than a Leaflet popup because a popup brings bubble
 * chrome that cannot be styled into this system, and because the leader must leave
 * the card's *edge*, wherever the card landed.
 *
 * The pin's screen position comes from `useContainerProjection`, which asks the map
 * itself — computing it from raw coordinates drifts under panning and fractional zoom.
 */
export function DetectionCallout({
  detection,
  onClose,
  onReview,
  onOpenInCenter,
  onExpand,
}: {
  detection: Detection
  onClose: () => void
  onReview: (id: string, state: 'confirmed' | 'dismissed', reason?: string) => void
  onOpenInCenter: (id: string) => void
  onExpand: () => void
}) {
  const proj = useContainerProjection()
  const pin = useMemo(() => proj.toContainerPixel(detection.position), [proj, detection.position])
  // The card's real height, measured: an estimate let it run off the bottom edge.
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [cardH, setCardH] = useState(540)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCardH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [detection.id])
  if (!pin) return null

  const size = proj.size
  const cardW = 340
  // Whichever side of the pin has more room; clamped so the card never leaves the
  // map, and kept clear of the bottom status strip.
  const onLeft = pin.x > size.x / 2
  const preferredX = onLeft ? pin.x - cardW - 56 : pin.x + 56
  const cardX = Math.max(12, Math.min(size.x - cardW - 12, preferredX))
  const cardY = Math.max(64, Math.min(size.y - cardH - 12, pin.y - 120))
  const cardIsLeftOfPin = cardX + cardW / 2 < pin.x
  const anchorX = cardIsLeftOfPin ? cardX + cardW : cardX
  const anchorY = cardY + 28

  return (
    <div className="pointer-events-none absolute inset-0 z-[550]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <line x1={pin.x} y1={pin.y} x2={anchorX} y2={anchorY} stroke="var(--signal)" strokeWidth={1.25} opacity={0.75} />
        <circle cx={pin.x} cy={pin.y} r={9} fill="none" stroke="var(--signal)" strokeWidth={1.5} opacity={0.9} />
        <circle cx={anchorX} cy={anchorY} r={2.5} fill="var(--signal)" />
      </svg>
      <div ref={cardRef} className="pointer-events-auto absolute" style={{ left: cardX, top: cardY }}>
        <DetectionCard
          detection={detection}
          onClose={onClose}
          onReview={onReview}
          onOpenInCenter={onOpenInCenter}
          onExpand={onExpand}
        />
      </div>
    </div>
  )
}
