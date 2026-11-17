import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Flame, Minus, Plus, RotateCcw, X } from 'lucide-react'
import type { Detection } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_LABELS, formatConfidence, riskOf } from '@/lib/risk'
import { formatLatLng, formatZulu } from '@/lib/geo'
import { PROVENANCE_SHORT, PROVENANCE_TONE, provenanceOf } from '@/lib/provenance'
import { Badge } from '@/components/ui/Badge'
import { DetectionFrame } from '@/components/ui/DetectionFrame'
import { GradCamWipe } from '@/components/detections/GradCamWipe'

/**
 * Lightbox — a detection photo, full screen.
 *
 * Wheel or the +/- buttons zoom, drag pans, double-click resets. The heatmap toggle
 * swaps in the Grad-CAM wipe — what the model attended to — and is only offered
 * when the pipeline produced one; a synthetic stand-in is never presented as the
 * model's own attention. ← → step through the list it was opened from, Esc closes.
 *
 * Portalled to <body>: it must escape every transformed or blurred ancestor, or
 * `fixed` resolves against the wrong box and the viewer fills only a card.
 */
export function Lightbox({
  detections,
  index,
  onIndex,
  onClose,
}: {
  detections: Detection[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const d = detections[index]
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [heat, setHeat] = useState(false)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  const reset = useCallback(() => {
    setScale(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // A new photo starts unzoomed.
  useEffect(() => {
    reset()
    setHeat(false)
  }, [index, reset])

  const step = useCallback(
    (dir: 1 | -1) => {
      if (detections.length < 2) return
      onIndex((index + dir + detections.length) % detections.length)
    },
    [detections.length, index, onIndex],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === '+' || e.key === '=') setScale((s) => Math.min(6, s * 1.25))
      else if (e.key === '-') setScale((s) => Math.max(1, s / 1.25))
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step, reset])

  if (!d) return null
  const level = riskOf(d)
  const hasHeat = d.gradCamUri !== null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${CLASS_LABELS[d.class]} photo`}
      className="fixed inset-0 z-[1000] flex flex-col bg-black/90 backdrop-blur-sm animate-rise-in"
    >
      <header className="flex items-center justify-between gap-4 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-[0.9375rem] font-semibold text-paper">{CLASS_LABELS[d.class]}</h2>
          <Badge risk={level}>{RISK_LABELS[level]}</Badge>
          <span className="font-mono text-[0.75rem] tabular-nums text-paper-dim">{formatConfidence(d.confidence)}</span>
          <span className="hidden font-mono text-[0.75rem] text-paper-faint md:inline">
            {formatZulu(d.capturedAt)} · {formatLatLng(d.position)} · ± {d.positionErrorM} m
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {hasHeat && (
            <button
              type="button"
              onClick={() => setHeat((h) => !h)}
              aria-pressed={heat}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[0.75rem] font-medium transition-colors ${heat ? 'border-signal/50 bg-signal/15 text-signal' : 'border-white/10 text-paper-dim hover:text-paper'}`}
            >
              <Flame size={13} aria-hidden />
              Model heatmap
            </button>
          )}
          <Tool label="Zoom out" onClick={() => setScale((s) => Math.max(1, s / 1.25))}>
            <Minus size={15} />
          </Tool>
          <span className="w-12 text-center font-mono text-[0.75rem] tabular-nums text-paper-dim">{Math.round(scale * 100)}%</span>
          <Tool label="Zoom in" onClick={() => setScale((s) => Math.min(6, s * 1.25))}>
            <Plus size={15} />
          </Tool>
          <Tool label="Reset view" onClick={reset}>
            <RotateCcw size={14} />
          </Tool>
          <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />
          <Tool label="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </Tool>
        </div>
      </header>

      <div
        className="relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden"
        onWheel={(e) => {
          const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
          setScale((s) => Math.max(1, Math.min(6, s * f)))
        }}
        onPointerDown={(e) => {
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        }}
        onPointerMove={(e) => {
          const g = drag.current
          if (!g || scale === 1) return
          setPan({ x: g.px + (e.clientX - g.x), y: g.py + (e.clientY - g.y) })
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={reset}
        style={{ cursor: scale > 1 ? 'grab' : 'zoom-in' }}
      >
        <div
          className="aspect-video w-[min(92vw,calc((100vh-9rem)*16/9))] overflow-hidden rounded-lg ring-1 ring-white/10"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: drag.current ? 'none' : 'transform 120ms ease-out' }}
        >
          {heat && hasHeat ? (
            <GradCamWipe detection={d} risk={level} available />
          ) : (
            <DetectionFrame detection={d} risk={level} />
          )}
        </div>

        {detections.length > 1 && (
          <>
            <NavArrow side="left" label="Previous detection (←)" onClick={() => step(-1)} />
            <NavArrow side="right" label="Next detection (→)" onClick={() => step(1)} />
          </>
        )}
      </div>

      <footer className="flex items-center justify-center gap-4 px-5 py-2.5 text-[0.6875rem] text-paper-faint">
        <span>
          {index + 1} / {detections.length}
        </span>
        <span>Scroll to zoom · drag to pan · double-click to reset · ← → to step</span>
        <span className={PROVENANCE_TONE[provenanceOf(d)]}>{PROVENANCE_SHORT[provenanceOf(d)]}</span>
      </footer>
    </div>,
    document.body,
  )
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-md text-paper-dim transition-colors hover:bg-white/[0.08] hover:text-paper"
    >
      {children}
    </button>
  )
}

function NavArrow({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={label}
      title={label}
      className={`glass absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center text-paper-dim transition-colors hover:text-paper ${side === 'left' ? 'left-5' : 'right-5'}`}
    >
      {side === 'left' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  )
}
