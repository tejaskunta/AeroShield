import L from 'leaflet'
import type { Detection, RiskLevel } from '@/types'
import { CONSOLE_HEX } from '@/lib/consoleInk'
import { RISK_HEX } from '@/lib/risk'

/**
 * Marker glyphs.
 *
 * The visual vocabulary is the point, and it is unchanged:
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
 * ── Why SVG in a `divIcon` rather than `L.circleMarker` ─────────────────────────
 *
 * A `circleMarker` can only express circles, and half this vocabulary is not a
 * circle: the diamond is the entire distinction between a confirmed hazard and a
 * candidate. Faking a diamond with CSS on a `circleMarker` means it stops being one.
 *
 * HTML also buys back something the Maps port had to give up. Maps markers are either
 * a raster image or a vector `Symbol` with no DOM to animate, so on that stack
 * selection could only be signalled by a size bump and a z-order lift — legible, but a
 * step down from the rippling ring it replaced. A `divIcon` is a real DOM node, so the
 * ripple is a CSS animation again, and it costs one `<span>` rather than the whole
 * overlay-per-detection the port note was resigned to.
 *
 * The one thing SVG-in-DOM does *not* get for free is the map's own zoom scaling:
 * `divIcon` pixels are screen pixels, fixed regardless of zoom. That is why the
 * caller passes `scale` from `useZoomScale` and the icon box is rebuilt when it
 * changes, rather than the glyph being drawn in map units.
 */

const STROKE = CONSOLE_HEX.inkDeep

/** Sizes in px. Bumped when selected so the map's own scale does not hide it. */
const SIZE_SELECTED = 26
const SIZE_NORMAL = 20

/**
 * The glyph's authored box, in SVG user units.
 *
 * Every glyph is authored inside the same 20x20 box centred on the origin and scaled
 * as a unit, so the shapes stay in proportion to each other at any size. A `viewBox`
 * of `-10 -10 20 20` puts (0,0) at the box's centre, which is what lets the anchor be
 * the true centre rather than an offset that has to be kept in step with the paths.
 */
const BOX = 20
const VIEW_BOX = `${-BOX / 2} ${-BOX / 2} ${BOX} ${BOX}`

const DIAMOND = 'M 0,-7 L 7,0 L 0,7 L -7,0 Z'

export function pinSize(selected: boolean): number {
  return selected ? SIZE_SELECTED : SIZE_NORMAL
}

/**
 * The glyph markup for a detection pin.
 *
 * Kept separate from `detectionIcon` so it can be inspected — and so the shape
 * decision can be tested without a map instance, which is what makes "a confirmed
 * hazard is a diamond" a checkable claim rather than a thing someone has to look at.
 */
export function detectionGlyphHtml(
  level: RiskLevel,
  reviewState: Detection['review']['state'],
  selected: boolean,
): string {
  const hex = RISK_HEX[level]
  let inner: string

  // Cleared ground: a small solid dot. Deliberately quiet — ruled-out cells are
  // the majority of the map and must not compete with live hazards.
  if (level === 'cleared') {
    inner = `<circle r="3.5" fill="${hex}" stroke="${STROKE}" stroke-width="1" />`
  } else if (reviewState !== 'confirmed' && reviewState !== 'flagged') {
    // Unverified candidate: a hollow ring — present, but unconfirmed.
    inner = `<circle r="6" fill="${STROKE}" fill-opacity="0.5" stroke="${hex}" stroke-width="2" />`
  } else if (reviewState === 'flagged') {
    // Flagged keeps the diamond silhouette but fills only its centre, so it reads
    // as "hazard-shaped, needs a second look" rather than as a confirmed hazard.
    inner = `<path d="${DIAMOND}" fill="${STROKE}" stroke="${hex}" stroke-width="2" />`
  } else {
    // Confirmed: a solid diamond.
    inner = `<path d="${DIAMOND}" fill="${hex}" stroke="${STROKE}" stroke-width="1.5" />`
  }

  // The ripple is only emitted for the selected pin, so an unselected map pays
  // nothing for it — no inert spans, no animation registered on 14 nodes.
  const ripple = selected ? '<span class="aeroshield-pin__ripple"></span>' : ''

  return (
    `<div class="aeroshield-pin${selected ? ' is-selected' : ''}">` +
    ripple +
    `<svg viewBox="${VIEW_BOX}" width="100%" height="100%" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>` +
    `</div>`
  )
}

/**
 * The `divIcon` for a detection pin.
 *
 * `scale` is driven by the map's zoom (see `useZoomScale`) so pins stay legible while
 * zoomed out and do not become oversized blobs while zoomed in.
 *
 * `className` is replaced rather than extended: Leaflet's default `leaflet-div-icon`
 * paints a white box with a border, which would put a white square behind every
 * hazard. The anchor is the centre because the glyph is authored centred.
 */
export function detectionIcon(
  level: RiskLevel,
  reviewState: Detection['review']['state'],
  selected: boolean,
  scale = 1,
): L.DivIcon {
  const size = pinSize(selected) * scale
  const anchor = size / 2

  return L.divIcon({
    className: 'aeroshield-pin-icon',
    html: detectionGlyphHtml(level, reviewState, selected),
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  })
}