import { useState } from 'react'
import { Check, ExternalLink, Flag, X } from 'lucide-react'
import type { Detection, ReviewState } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_LABELS, riskOf } from '@/lib/risk'
import { formatLatLng, formatLatLngDM, formatZulu } from '@/lib/geo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfidenceBar } from '@/components/ui/ConfidenceBar'
import { EmptyState } from '@/components/ui/EmptyState'
import { GradCamWipe } from './GradCamWipe'

/**
 * AdjudicationPanel — where a detection becomes a decision.
 *
 * Dismissing and flagging require a reason. That is not friction for its own sake:
 * a dismissal removes a hazard from the map and from the safe-path planner's
 * obstacle set, so it has to be auditable. Confirming does not require one — the
 * evidence is the frame, and confirming is the conservative direction.
 */
export function AdjudicationPanel({
  detection,
  onReview,
  onShowOnMap,
  persisted,
}: {
  detection: Detection | null
  onReview: (id: string, state: ReviewState, reason?: string) => void
  onShowOnMap: (id: string) => void
  /** Whether the last write reached a server. False today — the stub says so. */
  persisted: boolean
}) {
  const [pendingAction, setPendingAction] = useState<'dismissed' | 'flagged' | null>(null)
  const [reason, setReason] = useState('')

  if (!detection) {
    return (
      <div className="flex w-full flex-col border-l border-rule bg-ink lg:w-[380px]">
        <div className="p-3">
          <EmptyState
            title="No detection selected"
            detail="Pick a frame from the contact sheet to review it. Use J and K to walk the queue, C to confirm, X to dismiss."
          />
        </div>
      </div>
    )
  }

  const level = riskOf(detection)
  const reviewed = detection.review.state !== 'unreviewed'

  const submit = (state: 'dismissed' | 'flagged') => {
    if (!reason.trim()) return
    onReview(detection.id, state, reason.trim())
    setPendingAction(null)
    setReason('')
  }

  return (
    <div className="flex w-full min-w-0 flex-col border-l border-rule bg-ink lg:w-[380px]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[13px] tracking-[0.04em] text-paper">
            {detection.id}
          </span>
          <Badge risk={level}>{RISK_LABELS[level]}</Badge>
        </div>
        <button
          type="button"
          onClick={() => onShowOnMap(detection.id)}
          className="flex shrink-0 items-center gap-1 font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim hover:text-paper"
        >
          <ExternalLink size={11} aria-hidden />
          On map
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <GradCamWipe
          seed={detection.id}
          bbox={detection.bbox}
          risk={level}
          available={detection.gradCamUri !== null}
        />

        {/* Model output */}
        <div className="mt-3">
          <p className="eyebrow mb-1.5">Model output</p>
          <Row label="Class" value={CLASS_LABELS[detection.class]} />
          <div className="flex items-center gap-2 py-0.5">
            <span className="eyebrow w-[70px] shrink-0">Confidence</span>
            <ConfidenceBar confidence={detection.confidence} level={level} className="flex-1" />
          </div>
          <Row
            label="Box"
            value={`${detection.bbox.x2 - detection.bbox.x1} × ${detection.bbox.y2 - detection.bbox.y1} px`}
          />
        </div>

        <div className="rule-line my-3" />

        {/* Geotag — with the error stated, because a bare coordinate overstates it. */}
        <div>
          <p className="eyebrow mb-1.5">Geotag</p>
          <Row label="Position" value={formatLatLng(detection.position)} />
          <Row label="Deg/min" value={formatLatLngDM(detection.position)} />
          <Row label="± Error" value={`${detection.positionErrorM} m horizontal`} />
          <Row label="Cell" value={detection.gridCell} />
          <Row label="Alt at capture" value={`${detection.captureAltitudeM.toFixed(1)} m AGL`} />
          <Row label="Captured" value={formatZulu(detection.capturedAt)} />
          <p className="mt-1.5 text-[10px] leading-snug text-paper-faint">
            Position is projected from drone pose, not measured on the ground. Treat the
            error radius as the search area, not the coordinate as the object.
          </p>
        </div>

        <div className="rule-line my-3" />

        {/* Current review state, if any. */}
        {reviewed && (
          <div className="mb-3 border border-rule bg-ink-raised p-2">
            <p className="eyebrow mb-1">Review</p>
            <p className="font-display text-[13px] uppercase tracking-[0.08em] text-paper">
              {detection.review.state}
            </p>
            {detection.review.reason && (
              <p className="mt-1 text-[11px] leading-relaxed text-paper-dim">
                {detection.review.reason}
              </p>
            )}
            <p className="mt-1 font-mono text-[10px] text-paper-faint">
              {detection.review.reviewedBy} ·{' '}
              {detection.review.reviewedAt ? formatZulu(detection.review.reviewedAt) : '—'}
            </p>
            {!persisted && (
              <p className="mt-1.5 border-l-2 border-caution pl-2 font-mono text-[10px] leading-snug text-caution">
                Held in this session only. There is no review endpoint yet, so this
                decision is lost on reload.
              </p>
            )}
          </div>
        )}

        {/* Reason capture for the two actions that need one. */}
        {pendingAction && (
          <div className="mb-3 border border-rule-bright bg-ink-raised p-2">
            <p className="eyebrow mb-1.5">
              Reason for {pendingAction === 'dismissed' ? 'dismissal' : 'flag'}
            </p>
            <div className="mb-2 flex flex-wrap gap-1">
              {(pendingAction === 'dismissed' ? DISMISS_REASONS : FLAG_REASONS).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`border px-1.5 py-px text-[10px] transition-colors ${
                    reason === r
                      ? 'border-paper text-paper'
                      : 'border-rule text-paper-dim hover:border-rule-bright hover:text-paper'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Or write it out…"
              className="w-full resize-none border border-rule bg-ink px-2 py-1 text-[11px] text-paper placeholder:text-paper-faint focus:border-rule-bright focus:outline-none"
            />
            <div className="mt-1.5 flex gap-1.5">
              <Button
                onClick={() => submit(pendingAction)}
                disabled={!reason.trim()}
                className="flex-1"
              >
                Record {pendingAction === 'dismissed' ? 'dismissal' : 'flag'}
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setPendingAction(null)
                  setReason('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Actions pinned to the bottom — always reachable in a long scroll. */}
      <footer className="shrink-0 border-t border-rule p-2">
        <div className="flex gap-1.5">
          <Button
            onClick={() => onReview(detection.id, 'confirmed')}
            icon={<Check size={12} aria-hidden />}
            className="flex-1"
          >
            Confirm
          </Button>
          <Button
            onClick={() => {
              setPendingAction('flagged')
              setReason('')
            }}
            icon={<Flag size={12} aria-hidden />}
          >
            Flag
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setPendingAction('dismissed')
              setReason('')
            }}
            icon={<X size={12} aria-hidden />}
          >
            Dismiss
          </Button>
        </div>
        <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-paper-faint">
          C confirm · X dismiss · F flag · J/K move
        </p>
      </footer>
    </div>
  )
}

/** Canned reasons, from what an actual reviewer would write most often. */
const DISMISS_REASONS = ['Rock or debris', 'Vegetation', 'Shadow artifact', 'Duplicate of earlier hit', 'Scrap metal']
const FLAG_REASONS = ['Needs EOD opinion', 'Ambiguous shape', 'Poor image quality', 'Cluster — survey again']

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="eyebrow w-[70px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-[11px] tabular text-paper">{value}</span>
    </div>
  )
}
