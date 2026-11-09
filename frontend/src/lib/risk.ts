import type { Detection, RiskLevel } from '@/types'

/**
 * Risk semantics — the single source of truth for hazard colour and level.
 *
 * Every component asks this module; nothing decides "is this red?" on its own.
 * That is what makes the palette rule enforceable: red on screen always means
 * hazard, because only this file can say so.
 */

/**
 * At or above this confidence, an unreviewed landmine detection is treated as a
 * hazard and raises an alert.
 */
export const HAZARD_THRESHOLD = 0.75

/**
 * Below this confidence a detection is still filed and still visible, but it does
 * not raise an alert. It is not discarded — a quiet low-confidence hit is exactly
 * the thing a human should look at, so it stays in the review queue.
 */
export const REVIEW_THRESHOLD = 0.4

/**
 * Resolve a detection to a risk level.
 *
 * The conservative rule that matters: an *unreviewed* landmine detection is never
 * `cleared`, no matter how low the confidence. Only a human dismissal or a
 * `debris_negative` classification clears something. Letting a 0.12-confidence
 * mine detection render in the same green as verified-safe ground would be a
 * dangerous lie, and it is the kind of lie a naive confidence-to-colour ramp
 * makes by default.
 */
export function riskOf(detection: Detection): RiskLevel {
  const { review, class: cls, confidence } = detection

  if (review.state === 'confirmed') return 'hazard'
  if (review.state === 'dismissed') return 'cleared'
  if (cls === 'debris_negative') return 'cleared'

  return confidence >= HAZARD_THRESHOLD ? 'hazard' : 'caution'
}

/** Risk level for a bare confidence value, used by the histogram and legends. */
export function riskOfConfidence(confidence: number): RiskLevel {
  if (confidence >= HAZARD_THRESHOLD) return 'hazard'
  if (confidence >= REVIEW_THRESHOLD) return 'caution'
  return 'cleared'
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

/** Raw hex, for SVG attributes, Leaflet paths, and Recharts props. */
export const RISK_HEX: Record<RiskLevel, string> = {
  hazard: '#D7262F',
  caution: '#C9922C',
  cleared: '#4E9E86',
}

/** Tailwind class sets, so components never hand-write a hazard colour. */
export const RISK_CLASSES: Record<RiskLevel, { text: string; bg: string; border: string }> = {
  hazard: { text: 'text-hazard', bg: 'bg-hazard', border: 'border-hazard' },
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
