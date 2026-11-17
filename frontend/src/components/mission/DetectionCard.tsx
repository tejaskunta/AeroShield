import { useState } from 'react'
import { Check, Copy, ExternalLink, Flag, Maximize2, X } from 'lucide-react'
import type { Detection } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_LABELS, riskOf } from '@/lib/risk'
import { formatLatLng, formatZulu } from '@/lib/geo'
import { PROVENANCE_LABEL, PROVENANCE_TONE, provenanceOf } from '@/lib/provenance'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfidenceBar } from '@/components/ui/ConfidenceBar'
import { DetectionFrame } from '@/components/ui/DetectionFrame'

/**
 * DetectionCard — what the operator sees on clicking a pin.
 *
 * The photo leads, because the photo is the evidence: the model's box drawn on the
 * frame the aircraft actually captured. Clicking it opens the full-screen viewer
 * (zoom, pan, the Grad-CAM heatmap of what the model looked at). Facts sit below in
 * a two-column grid, and the review actions last.
 *
 * Provenance is read off the detection, never assumed. The previous callout printed
 * "Simulated detection" on every card — including the ones the aircraft flew — which
 * on a demining console is the wrong lie in the alarming direction.
 *
 * Presentational only: where it sits (anchored to the pin in 2D, docked in 3D) is
 * the caller's job.
 */
export function DetectionCard({
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
  const level = riskOf(detection)
  const prov = provenanceOf(detection)
  const [copied, setCopied] = useState(false)

  const copyPosition = () => {
    navigator.clipboard?.writeText(formatLatLng(detection.position)).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }

  return (
    <article className="glass w-[340px] max-w-[calc(100vw-2rem)] animate-rise-in overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[0.9375rem] font-semibold text-paper">{CLASS_LABELS[detection.class]}</h3>
          <Badge risk={level}>{RISK_LABELS[level]}</Badge>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detection"
          title="Close (Esc)"
          className="-mr-1.5 grid size-7 place-items-center rounded-md text-paper-faint transition-colors hover:bg-white/[0.06] hover:text-paper"
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      {/* The evidence. Click for the full-screen viewer. */}
      <button
        type="button"
        onClick={onExpand}
        className="group relative mx-4 block aspect-video w-[calc(100%-2rem)] overflow-hidden rounded-md bg-ink-deep ring-1 ring-white/[0.06]"
        aria-label="Open photo full screen"
      >
        <DetectionFrame detection={detection} risk={level} />
        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/35">
          <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[0.6875rem] font-medium text-paper opacity-0 transition-opacity group-hover:opacity-100">
            <Maximize2 size={12} aria-hidden />
            View full size
          </span>
        </span>
      </button>

      <div className="px-4 pt-3">
        <div className="flex items-center gap-3">
          <span className="w-[4.5rem] shrink-0 text-[0.75rem] text-paper-faint">Confidence</span>
          <ConfidenceBar confidence={detection.confidence} level={level} className="flex-1" />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Fact k="Captured" v={formatZulu(detection.capturedAt)} />
          <Fact k="Grid cell" v={detection.gridCell || '—'} />
          <Fact k="Altitude" v={`${detection.captureAltitudeM.toFixed(1)} m`} />
          <Fact k="Position error" v={`± ${detection.positionErrorM} m`} />
          <div className="col-span-2">
            <dt className="text-[0.6875rem] text-paper-faint">Position</dt>
            <dd className="mt-0.5 flex items-center justify-between gap-2">
              <span className="font-mono text-[0.8125rem] tabular-nums text-paper">{formatLatLng(detection.position)}</span>
              <button
                type="button"
                onClick={copyPosition}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-paper-faint transition-colors hover:bg-white/[0.06] hover:text-paper"
              >
                <Copy size={11} aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-3.5 border-t border-white/[0.06] px-4 py-3">
        {detection.review.state === 'unreviewed' ? (
          <div className="flex gap-2">
            <Button onClick={() => onReview(detection.id, 'confirmed')} icon={<Check size={13} aria-hidden />} className="flex-1">
              Confirm hazard
            </Button>
            <Button
              variant="quiet"
              onClick={() => onReview(detection.id, 'dismissed', 'Dismissed from map')}
              icon={<X size={13} aria-hidden />}
              className="flex-1"
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[0.75rem] capitalize text-paper-dim">
              {detection.review.state === 'flagged' && <Flag size={12} className="text-caution" aria-hidden />}
              {detection.review.state}
              {detection.review.reviewedBy && <span className="text-paper-faint normal-case"> · {detection.review.reviewedBy}</span>}
            </span>
          </div>
        )}
        <div className="mt-2.5 flex items-center justify-between">
          <span className={`text-[0.6875rem] ${PROVENANCE_TONE[prov]}`}>{PROVENANCE_LABEL[prov]}</span>
          <button
            type="button"
            onClick={() => onOpenInCenter(detection.id)}
            className="flex items-center gap-1 text-[0.75rem] text-paper-dim transition-colors hover:text-signal"
          >
            Open in Detections
            <ExternalLink size={11} aria-hidden />
          </button>
        </div>
      </div>
    </article>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] text-paper-faint">{k}</dt>
      <dd className="mt-0.5 truncate font-mono text-[0.8125rem] tabular-nums text-paper">{v}</dd>
    </div>
  )
}
