import { useState } from 'react'
import type { Detection, RiskLevel } from '@/types'
import { DetectionFrame } from '@/components/ui/DetectionFrame'

/**
 * GradCamWipe — compare the frame against its activation map by wiping across it.
 *
 * A wipe rather than a side-by-side: the question an operator is asking is "is the
 * model looking at the object, or at a shadow next to it?", and that is a question
 * about *registration*. Two images placed apart force you to hold one in memory and
 * eyeball the alignment; one image revealed under a moving edge answers it directly.
 *
 * The control is a real range input, kept transparent over the frame, so pointer
 * drag, keyboard arrows, and screen-reader semantics all come for free rather than
 * being rebuilt on mousemove.
 */
export function GradCamWipe({
  detection,
  risk,
  available,
}: {
  /** The detection itself, not its parts: the base image and the map are two
   *  fetches keyed by its id, so the component that draws them needs the id. */
  detection: Detection
  risk: RiskLevel
  /** False when the pipeline has not produced a Grad-CAM for this detection. */
  available: boolean
}) {
  const [pct, setPct] = useState(55)

  if (!available) {
    return (
      <div className="relative aspect-video w-full border border-rule bg-ink-deep">
        <DetectionFrame detection={detection} risk={risk} />
        <p className="absolute inset-x-0 bottom-0 border-t border-rule bg-ink-deep/95 px-2 py-1 text-tiny text-paper-dim">
          No activation map for this detection. Grad-CAM runs on the Jetson after
          capture; this frame has not been processed.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="relative aspect-video w-full select-none overflow-hidden border border-rule bg-ink-deep">
        {/* Base: the capture. */}
        <DetectionFrame detection={detection} risk={risk} />

        {/* Overlay: the activation map, clipped to the wipe position. */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
          aria-hidden
        >
          <DetectionFrame detection={detection} risk={risk} variant="gradcam" />
        </div>

        {/* The wipe edge, with a grip. */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-paper"
          style={{ left: `${pct}%` }}
          aria-hidden
        >
          <span className="absolute left-1/2 top-1/2 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center border border-paper bg-ink-deep">
            <span className="h-2.5 w-px bg-paper" />
            <span className="ml-0.5 h-2.5 w-px bg-paper" />
          </span>
        </div>

        {/* Corner labels tell you which side is which. */}
        <span className="pointer-events-none absolute left-2 top-2 border border-rule bg-ink-deep/85 px-1.5 py-px font-mono text-tiny uppercase tracking-[0.1em] text-paper-dim">
          Activation
        </span>
        <span className="pointer-events-none absolute right-2 top-2 border border-rule bg-ink-deep/85 px-1.5 py-px font-mono text-tiny uppercase tracking-[0.1em] text-paper-dim">
          Capture
        </span>

        {/* The control itself — invisible, but the thing that actually has focus. */}
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          aria-label="Wipe between activation map and capture"
          className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>

      <p className="text-tiny leading-snug text-paper-faint">
        Drag to wipe. The activation should sit on the object, not beside it. A hot
        region offset from the box is a sign the model keyed on something else.
      </p>
    </div>
  )
}
