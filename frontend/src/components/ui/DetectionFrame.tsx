import type { Detection, RiskLevel } from '@/types'
import { useDetectionImage } from '@/lib/detectionFrames'
import { PlaceholderFrame } from '@/components/ui/PlaceholderFrame'

/**
 * DetectionFrame — the one place a captured frame is drawn.
 *
 * There are four surfaces that show a detection's imagery: the contact sheet, the
 * map callout, the Grad-CAM wipe and the adjudication panel. All four ask the same
 * question and all four must answer it the same way, so they share this module
 * rather than each deciding privately whether it has an image yet.
 *
 * Three states, and the difference between the last two matters:
 *
 * - `undefined` — nobody has asked the backend yet. Drawing the placeholder here is
 *   not a lie, it is a "not yet", and the fetch is already in flight.
 * - `string` — a real JPEG, fetched with the API key and turned into an object URL.
 *   It is drawn object-cover inside the caller's own box, so the frame fills the
 *   same aspect ratio the placeholder used and the layout does not jump when the
 *   bytes arrive.
 * - `null` — asked, and there is no image. The placeholder is stamped, because at
 *   that point the synthetic texture is all that exists and saying so is the whole
 *   point of the stamp.
 *
 * The `bbox` overlay is drawn from the frame's own pixel dimensions, not from a
 * guessed aspect ratio. A real 512x288 frame annotated as though it were 1280x720
 * would put the box in the wrong place, and a box in the wrong place is worse than
 * no box — it is a confident claim about where the object is not.
 */
export function DetectionFrame({
  detection,
  risk,
  showStamp = true,
  variant = 'frame',
  className = '',
}: {
  detection: Detection
  risk: RiskLevel
  showStamp?: boolean
  /**
   * `gradcam` asks for the activation map instead of the capture. It is a separate
   * route returning different bytes, so it is a separate cache entry; when the
   * pipeline has not produced one the synthetic map stands in.
   */
  variant?: 'frame' | 'gradcam'
  className?: string
}) {
  const url = useDetectionImage(detection, variant)

  if (url === undefined || url === null) {
    return (
      <PlaceholderFrame
        seed={detection.id}
        bbox={detection.bbox}
        risk={risk}
        mode={variant === 'gradcam' ? 'gradcam' : 'frame'}
        showStamp={showStamp}
        className={className}
      />
    )
  }

  const { bbox, frameWidth, frameHeight } = detection
  // A real frame always reports its size; an older row may not. Without it the box
  // cannot be scaled, and a box drawn in the wrong coordinate space is a confident
  // claim about where the object is not — so it is omitted rather than guessed.
  const w = frameWidth ?? 0
  const h = frameHeight ?? 0
  const canBox = w > 0 && h > 0 && bbox.x2 > bbox.x1 && bbox.y2 > bbox.y1

  return (
    <div className={`relative overflow-hidden bg-ink-deep ${className}`}>
      <img src={url} alt={`Captured frame ${detection.id}`} className="block h-full w-full object-cover" />
      {canBox && (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          <rect
            x={bbox.x1}
            y={bbox.y1}
            width={bbox.x2 - bbox.x1}
            height={bbox.y2 - bbox.y1}
            fill="none"
            strokeWidth={3}
            className={risk === 'hazard' ? 'stroke-hazard' : risk === 'caution' ? 'stroke-caution' : 'stroke-cleared'}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </div>
  )
}