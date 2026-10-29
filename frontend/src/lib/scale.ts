/**
 * Map scale arithmetic.
 *
 * This module exists because the live map was measured at zoom 20 while every
 * constant governing it said 21 or 22, and the difference is not cosmetic: at zoom
 * 20 a metre of ground is seven pixels wide, so a ten-metre survey block occupies
 * seventy pixels and the aircraft's entire flight is a smudge. At zoom 22 a metre is
 * twenty-eight pixels and the same block is legible.
 *
 * A zoom level on its own says nothing useful about that — it is Google's tiling
 * index, not a physical quantity. Metres per pixel is the physical quantity, and it
 * is a closed-form function of the zoom and the latitude, so both the layout code
 * and the tests can talk in the same units and disagree in English rather than in
 * pixels.
 *
 * ── The formula ──────────────────────────────────────────────────────────────────
 *
 * At zoom 0 the whole world — 360° of longitude — is one 256 px tile, and a tile's
 * edge subtends `2πR / 256` metres of ground at the equator on a spherical earth.
 * Each zoom level halves that. Latitude shrinks the east-west ground distance by
 * `cos φ` under the Mercator projection while the pixel count stays fixed, so the
 * ground distance per pixel scales by the same factor:
 *
 *     m/px = 156543.03392 · cos(φ) / 2^zoom
 *
 * The constant is `2πR / 256` with R = 6378137 m, the WGS-84 equatorial radius that
 * Web Mercator (EPSG:3857) is defined on. That is the sphere Google's projection
 * actually uses, which is why this agrees with the imagery rather than merely being
 * correct in principle. The survey origin sits at 17.4° N, where `cos φ ≈ 0.954`, so
 * a metre is about 5 % narrower on screen than it would be at the equator.
 */

/** Web Mercator's sphere. Not the mean radius — the projection is defined on this one. */
const EARTH_EQUATORIAL_RADIUS_M = 6378137

/** A zoom-0 tile covers this much ground at the equator, in metres. */
const TILE_SIZE_PX = 256

/** `2πR / 256`, the metres covered by one pixel at zoom 0 on the equator. */
export const M_PER_PIXEL_AT_EQUATOR_Z0 =
  (2 * Math.PI * EARTH_EQUATORIAL_RADIUS_M) / TILE_SIZE_PX

/**
 * Ground width of one CSS pixel at a given zoom and latitude.
 *
 * Monotonic in zoom with a factor of two per step, which matters for the bug this
 * module was written to explain: a single zoom level out is a *doubling* of the
 * scale, not a small adjustment.
 */
export function metresPerPixel(zoom: number, latDeg: number): number {
  const shrink = Math.cos((latDeg * Math.PI) / 180)
  return (M_PER_PIXEL_AT_EQUATOR_Z0 * shrink) / 2 ** zoom
}

/** The reciprocal — pixels per metre. The form the layout problem is stated in. */
export function pixelsPerMetre(zoom: number, latDeg: number): number {
  return 1 / metresPerPixel(zoom, latDeg)
}

/** How wide a span of ground projects at a given zoom and latitude, in pixels. */
export function spanToPixels(spanM: number, zoom: number, latDeg: number): number {
  return spanM * pixelsPerMetre(zoom, latDeg)
}

/**
 * The largest zoom at which `spanM` still fits inside a viewport, given padding.
 *
 * This reproduces what `fitBounds` decides, and it is deliberately written down
 * because that decision is the one the map got wrong and the one that failed to
 * respond to three rounds of padding changes. Two things about it are worth stating
 * plainly, because both are counter-intuitive and both are load-bearing:
 *
 *  1. **It is a function of the shorter axis.** `fitBounds` must satisfy both the
 *     width and the height, so the binding constraint is whichever runs out first.
 *     On a wide, short map pane — a letterbox — the height decides the zoom and the
 *     area's width is free. Widening the pane changes nothing at all; only its
 *     height does. That is exactly the shape a `flex-1` column in a row layout
 *     tends to produce, and exactly why the zoom refused to move.
 *
 *  2. **It returns an integer**, because Google picks a whole zoom level and
 *     fractional zoom is off by default. So the result is a floor, and the *usable*
 *     area is usually noticeably smaller than the pane: a span needing 1.9× the
 *     current zoom costs a whole level. Padding is therefore not a gentle nudge —
 *     eight pixels of it can cost an entire zoom step, which doubles the ground
 *     scrolled off the edge.
 *
 * `paddingPx` is taken off both dimensions, matching the four-sided padding Google
 * requires. A viewport already smaller than the padding has no room, so the result
 * floors at zero rather than going negative.
 */
export function zoomToFit(
  spanM: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
  paddingPx: number,
  latDeg: number,
): number {
  const usableWidth = viewportWidthPx - 2 * paddingPx
  const usableHeight = viewportHeightPx - 2 * paddingPx
  if (usableWidth <= 0 || usableHeight <= 0 || spanM <= 0) return 0

  // The shorter axis decides, so solve for the axis with the fewer pixels available.
  const usable = Math.min(usableWidth, usableHeight)
  const pixelBudgetPerMetre = usable / spanM
  const metresPerPixelNeeded = 1 / pixelBudgetPerMetre

  // Invert m/px = C / 2^z  =>  2^z = C / (m/px)  =>  z = log2(C / mPerPx).
  const zoom = Math.log2(metresPerPixel(0, latDeg) / metresPerPixelNeeded)
  return Math.floor(zoom)
}

/**
 * Whether a view has fallen short of the scale its own pane could reach.
 *
 * The comparison has to be against the *reachable* zoom, not the affordable one.
 * `zoomToFit` answers a pure geometry question and knows nothing about the map's
 * ceiling, so on a tall pane over this survey block it happily reports zoom 23 while
 * the imagery caps the map at 22. Comparing the two directly therefore flags a
 * perfectly healthy view as short by exactly one level — and a diagnostic that fires
 * when nothing is wrong trains its reader to ignore it, which costs more than the
 * diagnostic is worth.
 *
 * Clamping the target to `maxZoom` fixes that without making the check toothless: a
 * pane that genuinely cannot reach a legible scale still reports short, because its
 * truth lies below the ceiling rather than above it.
 *
 * Pure, and here rather than in the component, so the off-by-one that produced a
 * false amber can be pinned by a test.
 */
export function isBelowAffordableZoom(
  zoom: number,
  affordableZoom: number,
  maxZoom: number,
): boolean {
  return zoom < Math.min(affordableZoom, maxZoom)
}

/**
 * Whether a pane of this size can hold `spanM` legibly under a given ceiling.
 *
 * This is the question the map's legibility guard asks, stated as arithmetic so it
 * can be decided without attempting a fit. It exists because the guard's previous
 * method — fit, measure, retry if short, give up after three — cannot tell "the fit
 * has not happened yet" apart from "no fit exists", and it spends its whole budget
 * proving the second one on every raster basemap. See `RASTER_MAX_ZOOM`.
 *
 * Pass the ceiling the *current basemap* can reach, not the configured maximum: the
 * difference between the two is exactly what made imagery look broken.
 *
 * `minPxPerMetre` is the legibility requirement, and it is compared against the scale
 * at the best zoom reachable inside this pane. If the best is not good enough then no
 * fit will be, and the honest response is to say so once — not to refit.
 */
export function paneHoldsSpanLegibly(
  spanM: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
  paddingPx: number,
  latDeg: number,
  ceilingZoom: number,
  minPxPerMetre: number,
): boolean {
  const affordable = zoomToFit(spanM, viewportWidthPx, viewportHeightPx, paddingPx, latDeg)
  const reachable = Math.min(affordable, ceilingZoom)
  return pixelsPerMetre(reachable, latDeg) >= minPxPerMetre
}
