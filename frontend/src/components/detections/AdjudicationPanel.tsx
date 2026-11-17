import { useState } from 'react'
import { Check, ExternalLink, Flag, Trash2, X } from 'lucide-react'
import type { Detection, ReviewState } from '@/types'
import { CLASS_LABELS } from '@/types'
import type { WriteOutcome } from '@/lib/api'
import { RISK_LABELS, riskOf } from '@/lib/risk'
import { formatLatLng, formatLatLngDM, formatZulu } from '@/lib/geo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfidenceBar } from '@/components/ui/ConfidenceBar'
import { EmptyState } from '@/components/ui/EmptyState'
import { GradCamWipe } from './GradCamWipe'

/**
 * AdjudicationPanel: where a detection becomes a decision.
 *
 * Dismissing and flagging require a reason. That is not friction for its own sake:
 * a dismissal removes a hazard from the map and from the safe-path planner's
 * obstacle set, so it has to be auditable. Confirming does not require one; the
 * evidence is the frame, and confirming is the conservative direction.
 *
 * THE ACKNOWLEDGEMENT FOOTER. What this panel says about whether a decision was
 * recorded has to be true, because the operator's next action depends on it — a
 * reviewer told "not saved" re-does the work, and one told "saved" when it was not
 * leaves a verdict that nobody can audit. Three cases, three different sentences:
 *
 *   persisted  the server took it, so the audit trail and the screen agree;
 *   local      a fixture or the keyless demo — real to this session, gone on
 *              reload, and stated as exactly that;
 *   rejected   a request was made and refused. Something is wrong and it says so.
 *
 * The previous text collapsed the last two into one and asserted, wrongly, that no
 * review endpoint existed.
 */
export function AdjudicationPanel({
  detection,
  onReview,
  onShowOnMap,
  outcome,
  onDelete,
}: {
  detection: Detection | null
  onReview: (id: string, state: ReviewState, reason?: string) => void
  onShowOnMap: (id: string) => void
  /**
   * How the last write for the *selected* row went, or null if none was attempted
   * since it was selected. Keyed to the row rather than left as a bare flag: an
   * outcome from a different detection would be a claim about the wrong evidence.
   */
  outcome: WriteOutcome | null
  /** Resolves to a message when the delete was refused, so the panel can say why. */
  onDelete: (id: string) => Promise<string | undefined>
}) {
  const [pendingAction, setPendingAction] = useState<'dismissed' | 'flagged' | null>(null)
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (!detection) {
    return (
      <div className="flex w-full flex-col border-l border-white/[0.06] bg-ink lg:w-[380px]">
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
    <div className="flex w-full min-w-0 flex-col border-l border-white/[0.06] bg-ink lg:w-[380px]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-compact tracking-[0.04em] text-paper">
            {detection.id}
          </span>
          <Badge risk={level}>{RISK_LABELS[level]}</Badge>
        </div>
        <button
          type="button"
          onClick={() => onShowOnMap(detection.id)}
          className="flex shrink-0 items-center gap-1 text-[0.75rem] font-medium text-paper-dim hover:text-paper"
        >
          <ExternalLink size={11} aria-hidden />
          On map
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <GradCamWipe
          detection={detection}
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

        {/* Geotag, with the error stated, because a bare coordinate overstates it. */}
        <div>
          <p className="eyebrow mb-1.5">Geotag</p>
          <Row label="Position" value={formatLatLng(detection.position)} />
          <Row label="Deg/min" value={formatLatLngDM(detection.position)} />
          <Row label="± Error" value={`${detection.positionErrorM} m horizontal`} />
          <Row label="Cell" value={detection.gridCell} />
          <Row label="Alt at capture" value={`${detection.captureAltitudeM.toFixed(1)} m AGL`} />
          <Row label="Captured" value={formatZulu(detection.capturedAt)} />
          <p className="mt-1.5 text-tiny leading-snug text-paper-faint">
            Position is projected from drone pose, not measured on the ground. Treat the
            error radius as the search area, not the coordinate as the object.
          </p>
        </div>

        <div className="rule-line my-3" />

        {/* Current review state, if any. */}
        {reviewed && (
          <div className="mb-3 rounded-lg border border-white/[0.06] bg-ink-raised p-2">
            <p className="eyebrow mb-1">Review</p>
            <p className="font-display text-compact uppercase tracking-[0.08em] text-paper">
              {detection.review.state}
            </p>
            {detection.review.reason && (
              <p className="mt-1 text-small leading-relaxed text-paper-dim">
                {detection.review.reason}
              </p>
            )}
            <p className="mt-1 font-mono text-tiny text-paper-faint">
              {detection.review.reviewedBy} ·{' '}
              {detection.review.reviewedAt ? formatZulu(detection.review.reviewedAt) : '--'}
            </p>
            <WriteNotice outcome={outcome} source={detection.source} />
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
                  className={`border px-1.5 py-px text-tiny transition-colors ${
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
              className="w-full resize-none border border-rule bg-ink px-2 py-1 text-small text-paper placeholder:text-paper-faint focus:border-rule-bright focus:outline-none"
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

      {/* Actions pinned to the bottom, always reachable in a long scroll. */}
      <footer className="shrink-0 border-t border-white/[0.06] p-2">
        {confirmingDelete ? (
          /*
           * A confirm step, because this is the one irreversible action here. The
           * wording states what is being destroyed and where it goes, and the
           * second button is the safe one so a stray Enter does not delete.
           */
          <div className="border border-hazard/60 bg-hazard/10 p-2">
            <p className="text-[0.75rem] font-medium text-hazard-lit">
              Delete {detection.id}?
            </p>
            <p className="mt-1 text-tiny leading-snug text-paper-dim">
              {detection.source === 'backend'
                ? 'This removes the row and its stored image from the server. It cannot be undone.'
                : 'This row is simulated and exists only on screen. Removing it cannot be undone either.'}
            </p>
            {deleteError && (
              <p className="mt-1.5 border-l-2 border-caution pl-2 font-mono text-tiny leading-snug text-caution">
                {deleteError}
              </p>
            )}
            <div className="mt-1.5 flex gap-1.5">
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirmingDelete(false)
                  setDeleteError(null)
                }}
                className="flex-1"
              >
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void onDelete(detection.id).then((message) => {
                    // Undefined means it went through, which unmounts this panel.
                    // A message means the server refused and the row is still
                    // there, so the confirm stays open with the reason shown.
                    if (message) setDeleteError(message)
                    else {
                      setConfirmingDelete(false)
                      setDeleteError(null)
                    }
                  })
                }}
                className="flex-1"
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <>
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
              {/* Delete is separated by a gap and has no icon label competing
                  with the verdict buttons: it is a different kind of action. */}
              <span className="w-px shrink-0 self-stretch bg-rule" aria-hidden />
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirmingDelete(true)
                  setDeleteError(null)
                }}
                icon={<Trash2 size={12} aria-hidden />}
                aria-label={`Delete ${detection.id}`}
                title="Delete this detection"
              />
            </div>
            <p className="mt-1.5 text-[0.6875rem] font-medium text-paper-faint">
              C confirm · X dismiss · F flag · J/K move
            </p>
          </>
        )}
      </footer>
    </div>
  )
}

/**
 * What to say about the last write. One component so the three cases cannot drift
 * apart across the two places a review is reported.
 *
 * `outcome === null` prints nothing: no write has been attempted since this row was
 * selected, so there is nothing to report and inventing a status would be the same
 * mistake the old copy made.
 */
function WriteNotice({
  outcome,
  source,
}: {
  outcome: WriteOutcome | null
  source: Detection['source']
}) {
  if (outcome === null) return null

  if (outcome === 'rejected') {
    return (
      <p className="mt-1.5 border-l-2 border-hazard pl-2 font-mono text-tiny leading-snug text-hazard-lit">
        The server refused this decision, so only this screen has it. Retry, or check
        that the API key is valid.
      </p>
    )
  }

  if (outcome === 'local') {
    return (
      <p className="mt-1.5 border-l-2 border-caution pl-2 font-mono text-tiny leading-snug text-caution">
        {source === 'simulated'
          ? 'Simulated row: there is no server record to update, so this decision lives in this session and resets on reload.'
          : 'No API key configured, so this decision lives in this session and resets on reload.'}
      </p>
    )
  }

  return (
    <p className="mt-1.5 border-l-2 border-rule-bright pl-2 font-mono text-tiny leading-snug text-paper-faint">
      Saved to the server. The audit trail records this decision.
    </p>
  )
}

/** Canned reasons, from what an actual reviewer would write most often. */
const DISMISS_REASONS = ['Rock or debris', 'Vegetation', 'Shadow artifact', 'Duplicate of earlier hit', 'Scrap metal']
const FLAG_REASONS = ['Needs EOD opinion', 'Ambiguous shape', 'Poor image quality', 'Cluster, survey again']

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="eyebrow w-[70px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-small tabular text-paper">{value}</span>
    </div>
  )
}
