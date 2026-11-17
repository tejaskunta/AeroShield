import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Detection } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_CLASSES, RISK_LABELS, formatConfidence, riskOf } from '@/lib/risk'
import { PROVENANCE_SHORT, PROVENANCE_TONE, provenanceOf } from '@/lib/provenance'
import { DetectionFrame } from '@/components/ui/DetectionFrame'

/**
 * New-detection toasts: a photo and the facts, as each detection arrives.
 *
 * Non-modal by design. The console never makes an operator acknowledge anything
 * (interruptions are how a real hazard gets missed); these stack in a corner, fade
 * on their own after a few seconds, and are a shortcut, not a gate: click one to
 * select the detection and bring its pin into view.
 *
 * Only detections that arrive while the screen is open: the ones already present
 * on mount are history, not news, and a stack of fifty toasts would be noise.
 */
const LIFE_MS = 7000
const MAX = 3

export function DetectionToasts({
  detections,
  onPick,
  bottom,
}: {
  detections: Detection[]
  onPick: (d: Detection) => void
  /** Distance from the bottom edge (clears the status strip). */
  bottom: number
}) {
  const seen = useRef<Set<string> | null>(null)
  const [toasts, setToasts] = useState<Detection[]>([])

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(detections.map((d) => d.id))
      return
    }
    const fresh = detections.filter((d) => !seen.current!.has(d.id))
    if (fresh.length === 0) return
    fresh.forEach((d) => seen.current!.add(d.id))
    setToasts((t) => [...fresh.reverse(), ...t].slice(0, MAX))
  }, [detections])

  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute right-3 z-[560] flex w-[300px] flex-col gap-2"
      style={{ bottom }}
      aria-live="polite"
      aria-label="New detections"
    >
      {toasts.map((d) => (
        <Toast
          key={d.id}
          d={d}
          onPick={() => {
            onPick(d)
            setToasts((t) => t.filter((x) => x.id !== d.id))
          }}
          onDone={() => setToasts((t) => t.filter((x) => x.id !== d.id))}
        />
      ))}
    </div>
  )
}

function Toast({ d, onPick, onDone }: { d: Detection; onPick: () => void; onDone: () => void }) {
  const [hover, setHover] = useState(false)
  // Through a ref: the parent re-renders on every telemetry tick with a new
  // `onDone`, and depending on it directly restarted the timer forever.
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (hover) return
    const t = setTimeout(() => doneRef.current(), LIFE_MS)
    return () => clearTimeout(t)
  }, [hover])
  const level = riskOf(d)
  const prov = provenanceOf(d)
  return (
    <div
      className="glass pointer-events-auto flex animate-slide-in-right items-stretch overflow-hidden"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={`w-1 shrink-0 ${RISK_CLASSES[level].bg}`} aria-hidden />
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-3 p-2.5 text-left transition-colors hover:bg-white/[0.04]">
        <span className="relative block aspect-video w-20 shrink-0 overflow-hidden rounded bg-ink-deep">
          <DetectionFrame detection={d} risk={level} showStamp={false} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] font-medium text-paper-faint">New detection</span>
          <span className="block truncate text-[0.8125rem] font-semibold text-paper">
            {CLASS_LABELS[d.class]} <span className={RISK_CLASSES[level].text}>· {RISK_LABELS[level]}</span>
          </span>
          <span className="mt-0.5 flex gap-2 font-mono text-[0.6875rem] text-paper-dim">
            {formatConfidence(d.confidence)}
            <span className={PROVENANCE_TONE[prov]}>{PROVENANCE_SHORT[prov]}</span>
          </span>
        </span>
      </button>
      <button type="button" onClick={onDone} aria-label="Dismiss" className="grid w-8 shrink-0 place-items-center text-paper-faint hover:text-paper">
        <X size={13} aria-hidden />
      </button>
    </div>
  )
}
