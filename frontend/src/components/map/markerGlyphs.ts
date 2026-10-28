import type { Detection, RiskLevel } from '@/types'
import { RISK_HEX } from '@/lib/risk'

/**
 * Marker glyphs.
 *
 * Leaflet markers could be arbitrary HTML, so the pin shapes here used to be
 * `divIcon` markup — a rotated `<span>`, a ring, a dot. The Maps API markers are
 * either a raster image or a vector `Symbol` built from a path, and of the two the
 * Symbol is the right choice: it is resolution-independent, it inherits the map's
 * own drawing, and its geometry is described in real numbers rather than in CSS
 * with a transform bolted on.
 *
 * The visual vocabulary is unchanged, because the vocabulary is the point:
 *
 *   confirmed  -> filled diamond    staked, verified hazard
 *   flagged    -> diamond w/ dot    needs a second look
 *   unverified -> hollow ring       a candidate
 *   cleared    -> small solid dot   ruled out
 *
 * Shape carries review state; colour carries risk. Neither alone is sufficient —
 * shape is what survives a colour-blind operator or a washed-out screen, which is
 * why "red means hazard" is never the only channel.
 *
 * The marker size tracks selection so the selected pin reads as selected at a
 * glance without a separate highlight.
 *
 * The aircraft is deliberately *not* here. It is a raster PNG rather than a path, and
 * a raster `Marker` icon cannot be rotated — so the drone is a DOM `OverlayView` with
 * a CSS rotation instead. See `DroneOverlay.ts`.
 */

const STROKE = '#0E141A'

/** Sizes in px. Bumped when selected so the map's own scale does not hide it. */
const SIZE_SELECTED = 26
const SIZE_NORMAL = 20

export function pinSize(selected: boolean): number {
  return selected ? SIZE_SELECTED : SIZE_NORMAL
}

/**
 * The Symbol for a detection pin.
 *
 * `scale` is driven by the map's zoom (see `useZoomScale`) so symbols stay legible
 * while zoomed out and don't become oversized blobs while zoomed in. Symbol scale
 * is relative to `SIZE_NORMAL`, so the caller passes a plain multiplier.
 */
export function detectionSymbol(
  level: RiskLevel,
  reviewState: Detection['review']['state'],
  selected: boolean,
  scale = 1,
): google.maps.Symbol {
  const hex = RISK_HEX[level]
  const px = (pinSize(selected) / SIZE_NORMAL) * scale

  // Every glyph is authored inside the same 20x20 box and scaled as a unit, so
  // the shapes stay in proportion to each other at any zoom.
  const base = { scale: px }

  // Cleared ground: a small solid dot. Deliberately quiet — ruled-out cells are
  // the majority of the map and must not compete with live hazards.
  if (level === 'cleared') {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      ...base,
      fillColor: hex,
      fillOpacity: 1,
      strokeColor: STROKE,
      strokeOpacity: 1,
      strokeWeight: 1,
      scale: 3.5 * px,
    }
  }

  // Unverified candidate: a hollow ring — present, but unconfirmed.
  if (reviewState !== 'confirmed' && reviewState !== 'flagged') {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      ...base,
      fillColor: STROKE,
      fillOpacity: 0.5,
      strokeColor: hex,
      strokeOpacity: 1,
      strokeWeight: 2,
      scale: 6 * px,
    }
  }

  // A diamond is a square rotated 45°. Authored as an explicit path so the
  // rotation is real geometry rather than a CSS transform the map cannot see —
  // which is what lets the anchor and the tooltip sit on the actual centre.
  const diamond = 'M 0,-7 L 7,0 L 0,7 L -7,0 Z'

  if (reviewState === 'flagged') {
    // Flagged keeps the diamond silhouette but fills only its centre, so it reads
    // as "hazard-shaped, needs a second look" rather than as a confirmed hazard.
    return {
      path: diamond,
      ...base,
      fillColor: STROKE,
      fillOpacity: 1,
      strokeColor: hex,
      strokeOpacity: 1,
      strokeWeight: 2,
      scale: px,
    }
  }

  // Confirmed: a solid diamond.
  return {
    path: diamond,
    ...base,
    fillColor: hex,
    fillOpacity: 1,
    strokeColor: STROKE,
    strokeOpacity: 1,
    strokeWeight: 1.5,
    scale: px,
  }
}

/**
 * Endpoint glyph for the safe-route planner.
 *
 * Drawn as a ring with a dark core, matching the console's other "you put this
 * here" marks. Distinct from a detection pin because an endpoint is not evidence —
 * it is an intention.
 */
export function endpointSymbol(): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 5,
    fillColor: '#0E141A',
    fillOpacity: 1,
    strokeColor: '#E8E4DA',
    strokeOpacity: 1,
    strokeWeight: 2,
  }
}

/** Numbered waypoint glyph for intermediate route nodes. */
export function waypointSymbol(hex: string, scale = 1): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 3 * scale,
    fillColor: hex,
    fillOpacity: 1,
    strokeColor: '#0E141A',
    strokeOpacity: 1,
    strokeWeight: 1.5,
  }
}