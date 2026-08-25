import { useEffect, useState } from 'react'
import { useMap } from 'react-leaflet'
import { Check, Flag, X } from 'lucide-react'
import type { Detection } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_LABELS, riskOf } from '@/lib/risk'
import { formatLatLng, formatZulu, toTuple } from '@/lib/geo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfidenceBar } from '@/components/ui/ConfidenceBar'
import { PlaceholderFrame } from '@/components/ui/PlaceholderFrame'

/**
 * DetectionCallout — the selected detection, as a cartographic callout.
 *
 * The micro-signature of Mission Control: the card doesn't float free like a modal,
 * it is pinned to its detection by a hairline leader line, the way a survey plate
 * annotates a point on a chart. The card is positioned in screen space over the
 * map, and the leader is redrawn on every pan/zoom so the tie to the ground stays
 * true as the operator moves the map.
 *
 * It's an overlay, not a Leaflet popup, because Leaflet popups bring their own
 * bubble chrome and can't be styled into this system cleanly — and because the
 * leader line needs to originate from the card edge, which a popup won't give us.
 */
export function DetectionCallout({
  detection,
  onClose,
  onReview,
  onOpenInCenter,
}: {
  detection: Detection
  onClose: () => void
  onReview: (id: string, state: 'confirmed' | 'dismissed', reason?: string) => void
  onOpenInCenter: (id: string) => void
}) {
  const map = useMap()
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null)

  // Track the detection's screen position across pan/zoom so the leader stays tied.
  useEffect(() => {
    const update = () => {
      const p = map.latLngToContainerPoint(toTuple(detection.position))
      setPin({ x: p.x, y: p.y })
    }
    update()
    map.on('move zoom zoomanim viewreset resize', update)
    return () => {
      map.off('move zoom zoomanim viewreset resize', update)
    }
  }, [map, detection.position])

  if (!pin) return null

  const level = riskOf(detection)
  const size = map.getSize()

  // Place the card on whichever side of the pin has more room, so it never runs
  // off-screen and the leader never crosses the whole map. Clamped at both ends —
  // on a phone-width map the "more room" side can still be narrower than the card.
  const cardW = 260
  const onLeft = pin.x > size.x / 2
  const preferredX = onLeft ? pin.x - cardW - 48 : pin.x + 48
  const cardX = Math.max(8, Math.min(size.x - cardW - 8, preferredX))
  const cardY = Math.max(8, Math.min(size.y - 260, pin.y - 90))

  // Leader line: from the pin to the near edge of the card. Which edge is "near"
  // is decided by where the card actually landed, not where we wanted it.
  const cardIsLeftOfPin = cardX + cardW / 2 < pin.x
  const anchorX = cardIsLeftOfPin ? cardX + cardW : cardX
  const anchorY = cardY + 24

  return (
    <div className="pointer-events-none absolute inset-0 z-[550]">
      {/* Leader line + a tick at the pin. */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <line
          x1={pin.x}
          y1={pin.y}
          x2={anchorX}
          y2={anchorY}
          stroke="#E8E4DA"
          strokeWidth={1}
          strokeDasharray="1 2"
          opacity={0.8}
        />
        <circle cx={pin.x} cy={pin.y} r={2.5} fill="#E8E4DA" />
        <circle cx={anchorX} cy={anchorY} r={1.5} fill="#E8E4DA" />
      </svg>

      <article
        className="pointer-events-auto absolute w-[260px] animate-rise-in border border-rule-bright bg-ink-raised shadow-[0_8px_28px_rgba(0,0,0,0.5)]"
        style={{ left: cardX, top: cardY }}
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-2 border-b border-rule px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] tracking-[0.06em] text-paper">{detection.id}</span>
            <Badge risk={level}>{RISK_LABELS[level]}</Badge>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detection"
            className="text-paper-faint hover:text-paper"
          >
            <X size={13} />
          </button>
        </header>

        {/* Frame with bbox */}
        <div className="relative aspect-video border-b border-rule bg-ink-deep">
          <PlaceholderFrame seed={detection.id} bbox={detection.bbox} risk={level} />
        </div>

        {/* Facts — all monospaced, all copyable. */}
        <div className="space-y-1 px-2.5 py-2">
          <Fact label="Class" value={CLASS_LABELS[detection.class]} />
          <div className="flex items-center gap-2">
            <span className="eyebrow w-16 shrink-0">Conf</span>
            <ConfidenceBar
              confidence={detection.confidence}
              level={level}
              className="flex-1"
            />
          </div>
          <Fact label="Cell" value={detection.gridCell} />
          <Fact label="Position" value={formatLatLng(detection.position)} />
          <Fact label="± Error" value={`${detection.positionErrorM} m`} />
          <Fact label="Captured" value={formatZulu(detection.capturedAt)} />
        </div>

        {/* Review state or actions */}
        {detection.review.state === 'unreviewed' ? (
          <div className="flex gap-1.5 border-t border-rule px-2.5 py-2">
            <Button
              onClick={() => onReview(detection.id, 'confirmed')}
              icon={<Check size={12} aria-hidden />}
              className="flex-1"
            >
              Confirm
            </Button>
            <Button
              variant="danger"
              onClick={() => onReview(detection.id, 'dismissed', 'Dismissed from map')}
              icon={<X size={12} aria-hidden />}
              className="flex-1"
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 border-t border-rule px-2.5 py-2">
            <span className="flex items-center gap-1.5 text-[10px] text-paper-dim">
              {detection.review.state === 'flagged' && (
                <Flag size={11} className="text-caution" aria-hidden />
              )}
              <span className="uppercase tracking-[0.08em]">
                {detection.review.state} · {detection.review.reviewedBy}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onOpenInCenter(detection.id)}
              className="font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim hover:text-paper"
            >
              Open →
            </button>
          </div>
        )}

        {/* Provenance — this is simulated, and the card says so. */}
        <p className="border-t border-rule px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-caution/80">
          Simulated detection
        </p>
      </article>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="eyebrow w-16 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular text-paper">
        {value}
      </span>
    </div>
  )
}
