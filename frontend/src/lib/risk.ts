import type { Detection, RiskLevel } from '@/types'

/**
 * Risk semantics -- the single source of truth for hazard colour and level.
 *
 * Every component asks this module; nothing decides "is this red?" on its own.
 * That is what makes the palette rule enforceable: red on screen always means
 * hazard, because only this file can say so.
 *
 * WHAT A LEVEL MEANS. The model has one class and reports a confidence, so there
 * is no detector-side taxonomy to render. A level here is therefore a projection
 * of exactly two things: how sure the model was, and whether a human has looked
 * at it yet. It is an *urgency of attention*, not a classification of the ground.
 * That distinction is the whole reason this file exists separately -- a component
 * that reached for `confidence > 0.7 ? red : green` on its own would be making a
 * safety claim, and this one is only making a triage claim.
 */

/**
 * At or above this confidence, an unreviewed landmine detection is treated as a
 * hazard and reads as the most urgent thing in the queue.
 */
export const HAZARD_THRESHOLD = 0.75

/**
 * Below this confidence a detection is still filed and still visible, but it does
 * not read as urgent. It is not discarded -- a quiet low-confidence hit is exactly
 * the thing a human should look at, so it stays in the review queue.
 */
export const REVIEW_THRESHOLD = 0.4

/**
 * Resolve a detection to a risk level.
 *
 * The conservative rule that matters: an *unreviewed* detection is never
 * `cleared`, no matter how low the confidence. Only a human dismissal clears
 * something. Letting a 0.12-confidence mine detection render in the same green as
 * verified-safe ground would be a dangerous lie, and it is the kind of lie a naive
 * confidence-to-colour ramp makes by default.
 *
 * This used to have a second automatic path: a `debris_negative` class cleared a
 * detection without a human. The model has no such class -- it was inherited from
 * the three-class dataset design and never predicted by the engine that flies --
 * so the branch was removed rather than kept as a fiction. The consequence is
 * deliberate: `cleared` is now reachable ONLY by a person deciding, which is
 * stricter than before and true to what the system can actually know.
 */
export function riskOf(detection: Detection): RiskLevel {
  const { review, confidence } = detection

  if (review.state === 'confirmed') return 'hazard'

  /*
   * `flagged` is a human escalation, so it outranks the model's own score. A
   * reviewer who reopens a 0.12-confidence frame has looked at something the
   * number cannot see -- an ambiguous shape, a poor image, a cluster -- and
   * said it needs a second pass. Rendering that as a quiet `caution` because
   * the confidence stayed low would let a person's judgement be overruled by
   * the least informed signal in the system.
   */
  if (review.state === 'flagged') return 'hazard'

  if (review.state === 'dismissed') return 'cleared'

  return confidence >= HAZARD_THRESHOLD ? 'hazard' : 'caution'
}

/**
 * Risk level for a bare confidence value, used by the histogram and legends.
 *
 * There is no `cleared` branch here, and that is the point. A raw confidence
 * carries no information about whether a human has adjudicated the frame, and
 * this module's rule is that nothing is cleared without a person deciding. An
 * earlier version returned `cleared` below REVIEW_THRESHOLD, which painted the
 * lowest-confidence bars of the histogram patient-instrument green. That reads
 * as "this ground is safe" when it actually means "the model was unsure", and a
 * mine detector should never say the first thing on the second evidence.
 *
 * So: at or above the hazard threshold is `hazard`, anything else is `caution`.
 * Both are states that ask for attention, differing only in how loudly.
 */
export function riskOfConfidence(confidence: number): RiskLevel {
  return confidence >= HAZARD_THRESHOLD ? 'hazard' : 'caution'
}

/** Risk level for an aggregate 0..1 route or cell risk score. */
export function riskOfScore(score: number): RiskLevel {
  if (score >= 0.5) return 'hazard'
  if (score >= 0.2) return 'caution'
  return 'cleared'
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  hazard: 'Hazard',
  caution: 'Unverified',
  cleared: 'Cleared',
}

/**
 * Raw hex, for SVG attributes, Leaflet paths, and Recharts props.
 *
 * These are the FILL/STROKE values, never text colours — everything here is a
 * mark on a map or a chart, where the threshold is 3:1. Hazard text uses
 * `text-hazard-lit` (see `RISK_CLASSES`), which is a lighter tint of the same
 * hue because 3:1 is not enough for type.
 *
 * Must stay in step with `theme.extend.colors` in `tailwind.config.ts`.
 */
export const RISK_HEX: Record<RiskLevel, string> = {
  hazard: '#DC3840',
  caution: '#C9922C',
  cleared: '#51A48B',
}

/**
 * The recessed hazard fill, matching `hazard.soft` in `tailwind.config.ts`.
 *
 * Used where a hazard needs to be present but subordinate: a flagged badge on a
 * dark panel, a segment inside a stacked meter. Keeps a second red from competing
 * with the primary semantic accent at full strength.
 */
export const HAZARD_SOFT_HEX = '#3A1418'

/** Tailwind class sets, so components never hand-write a hazard colour. */
export const RISK_CLASSES: Record<RiskLevel, { text: string; bg: string; border: string }> = {
  // `text-hazard-lit`, not `text-hazard`: the fill red is a 3:1 graphics colour
  // and reads at 2.7:1 as type on a hovered panel. The fill and the border are
  // correct as-is.
  hazard: { text: 'text-hazard-lit', bg: 'bg-hazard', border: 'border-hazard' },
  caution: { text: 'text-caution', bg: 'bg-caution', border: 'border-caution' },
  cleared: { text: 'text-cleared', bg: 'bg-cleared', border: 'border-cleared' },
}

/**
 * Confidence as a fixed two-decimal string.
 *
 * Always two decimals, never a percentage: `0.94` is what the model emits and
 * what appears in logs, so showing `94%` would force the operator to translate
 * between the UI and every other artifact.
 */
export function formatConfidence(confidence: number): string {
  return confidence.toFixed(2)
}
