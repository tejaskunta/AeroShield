import type { Detection } from '@/types'
import { CLASS_LABELS } from '@/types'
import { RISK_HEX, RISK_LABELS, formatConfidence, riskOf } from '@/lib/risk'
import { formatZulu } from '@/lib/geo'
import { PROVENANCE_SHORT, provenanceOf } from '@/lib/provenance'

/**
 * The hover preview for a detection pin, as HTML (Leaflet tooltips and MapLibre
 * markers both take markup). What an operator needs to decide whether to click:
 * risk, confidence, when, and whether it is real. Values are numbers and fixed
 * labels from our own data, never free text, so no escaping is needed.
 */
export function pinTooltipHtml(d: Detection): string {
  const level = riskOf(d)
  return (
    `<div class="aeroshield-tip">` +
    `<div class="aeroshield-tip__head"><span class="aeroshield-tip__dot" style="background:${RISK_HEX[level]}"></span>` +
    `${CLASS_LABELS[d.class]} · ${RISK_LABELS[level]}</div>` +
    `<div class="aeroshield-tip__row"><span>${formatConfidence(d.confidence)}</span><span>${formatZulu(d.capturedAt)}</span>` +
    `<span>${PROVENANCE_SHORT[provenanceOf(d)]}</span></div>` +
    `<div class="aeroshield-tip__hint">Click for the photo</div>` +
    `</div>`
  )
}
