import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { M_PER_DEG_LAT, distanceM, mPerDegLon } from '@/lib/geo'
import {
  FIT_PADDING_PX,
  MAX_LIVE_MAP_ZOOM,
  MIN_LIVE_MAP_PX_PER_METRE,
} from '@/lib/config'
import { pixelsPerMetre, zoomToFit } from '@/lib/scale'
import type { LatLng } from '@/types'
import { useMap } from './mapContext'

/**
 * Leaflet's bounds object for an extent, optionally widened to include a point.
 *
 * Replaces the Maps `new LatLngBounds()` + repeated `extend()` idiom. `L.latLngBounds`
 * takes its two corners as a pair and normalises their order itself, which is worth
 * knowing because the south-west/north-east naming of the extent fields is a
 * convention of ours and not something the geometry enforces — a caller that swapped
 * them used to produce an inverted box with no points in it, and would now simply
 * work.
 */
function boundsOf(
  extent: { south: number; west: number; north: number; east: number } | null,
  position: LatLng | null,
): L.LatLngBounds {
  const corners: L.LatLngExpression[] = []
  if (extent) {
    corners.push([extent.south, extent.west], [extent.north, extent.east])
  }
  if (position) corners.push([position.lat, position.lon])
  // A single point still yields a valid (degenerate) bounds, which `fitBounds`
  // resolves to the map's maximum zoom rather than throwing. The Maps API needed a
  // guard for that; here it is the documented behaviour.
  return L.latLngBounds(corners)
}

/**
 * Track the map's zoom and report a marker scale factor.
 *
 * Vector markers are drawn in screen space, so a glyph that reads well at the
 * working zoom is an unreadable speck two steps out and a giant obstruction two
 * steps in. Scaling the glyphs with zoom keeps a pin's *apparent* size roughly
 * constant on the ground, which is what makes a hazard field legible at any zoom.
 *
 * The range is narrow because the map's own range is narrow: this map lives between
 * zoom 18 and zoom 22, all of them metre-scale views of the same ten-metre block.
 */
export function useZoomScale(): number {
  const { map } = useMap()
  const [scale, setScale] = useState(() => scaleForZoom(map.getZoom() ?? REFERENCE_ZOOM))

  useEffect(() => {
    const update = () => setScale(scaleForZoom(map.getZoom() ?? REFERENCE_ZOOM))
    update()
    map.on('zoomend', update)
    return () => {
      map.off('zoomend', update)
    }
  }, [map])

  return scale
}

/** The working zoom — the view the ten-metre block is designed to fill. */
const REFERENCE_ZOOM = 21

/**
 * The span of ground the live view is asked to hold, in metres.
 *
 * The survey block, edge to edge, and nothing more. The block is what the operator
 * is actually reading, so it is what the view has to render legibly; the flown track
 * is allowed to extend past it and be followed by the 'follow' mode. Quoting this as
 * a constant rather than deriving it at each call site keeps the readout, the
 * readiness check and the fit all measuring the same thing.
 */
export const VIEW_SPAN_M = 10

/**
 * Clamped at both ends. Below ~0.6 the shapes stop being distinguishable from one
 * another at the zoom levels this map actually uses; above ~1.7 the pins merge into
 * a solid mass where detections cluster, which at one-metre cells is most of them.
 */
function scaleForZoom(zoom: number): number {
  const raw = 2 ** ((zoom - REFERENCE_ZOOM) / 5)
  return Math.max(0.6, Math.min(1.7, raw))
}

/**
 * Keep the drone on screen.
 *
 * This is the fix for the map's original complaint — the aircraft was drawn, but
 * off the visible viewport. Two behaviours, chosen once and remembered, because
 * which one is right depends on the operator's job:
 *
 *   'follow'  recentre as the drone moves. For watching the flight.
 *   'fit'     zoom out far enough to hold the drone *and* the survey block. For
 *             seeing what is left to fly.
 *
 * Both are passive about the *operator's* input: neither fights a manual pan. If
 * the operator pans away, the mode keeps its setting but stops yanking the view
 * back until the drone next leaves the viewport, at which point following resumes.
 * A map that fights the hand on the mouse is worse than one that has to be nudged.
 */
export type FollowMode = 'follow' | 'fit' | 'manual'

export interface FollowOptions {
  /** Where the drone is, or null before the first telemetry frame. */
  position: LatLng | null
  /** The area that must stay visible in 'fit' mode. */
  extent: { south: number; west: number; north: number; east: number } | null
  mode: FollowMode
  /**
   * Beyond this many metres of travel, recentre in 'follow' mode.
   *
   * Deliberately about a metre and a half. The whole block is ten metres across, so
   * the old twelve-metre threshold fired roughly once per lap and the aircraft spent
   * most of the flight drifting off-centre. At walking pace this is a recentre every
   * couple of ticks — frequent enough to keep the aircraft central, slow enough that
   * the imagery does not shimmer.
   */
  recentreThresholdM?: number
  /**
   * Re-run the fit on the next frame even though nothing about the extent changed.
   *
   * 'fit' is idempotent by design (see the effect), so an operator who pans or
   * zooms away has no way to ask for the framed view back — the extent has not
   * changed, so nothing re-fits. Toggling the follow control is the natural way to
   * ask, and this is what makes the toggle mean something in 'fit' mode.
   */
  forceRefit?: boolean
}

export function useFollowDrone({
  position,
  extent,
  mode,
  recentreThresholdM = 1.5,
  forceRefit = false,
}: FollowOptions): void {
  const { map } = useMap()
  const lastCentred = useRef<LatLng | null>(null)
  /** Set when the operator pans manually; cleared once we re-centre intentionally. */
  const userPanned = useRef(false)
  /**
   * The container size the current fit was computed for.
   *
   * `fitBounds` derives its zoom from the viewport in pixels, so a fit performed
   * before layout settled is permanently wrong. Recording the size it used lets the
   * effect notice the map has been resized and redo the fit.
   *
   * It is a weak guard, and it was mistaken for a fix once. It only gets consulted
   * when this effect happens to re-run, and only a handful of things re-run it — so
   * against a resize that arrives while the aircraft is not moving it can sit
   * unnoticed indefinitely. It is kept as cheap defence; the requirement itself is
   * enforced by `useViewReadiness`, which subscribes to the container and does not
   * depend on anything else happening first.
   */
  const lastFitSize = useRef<string | null>(null)

  // Detect a manual pan so 'follow' can back off instead of wrestling the operator.
  useEffect(() => {
    const onDrag = () => {
      userPanned.current = true
    }
    map.on('dragstart', onDrag)
    map.on('zoomstart', onDrag)
    return () => {
      map.off('dragstart', onDrag)
      map.off('zoomstart', onDrag)
    }
  }, [map])

  useEffect(() => {
    if (mode === 'manual' || !position) return

    if (mode === 'fit') {
      // 'fit' is idempotent — recomputing it on every telemetry frame would be a
      // visible shimmy, so it only runs when the extent changes or the drone first
      // appears outside it.
      const bounds = boundsOf(extent, position)

      const inside = !extent || isInside(extent, position)
      // Refit when the extent changes, when the drone leaves it, when the map
      // itself changed size, or when the operator explicitly asks for the framed
      // view back. `fitBounds` decides its zoom from the viewport in pixels, so a
      // fit taken before layout settled is wrong for the life of the screen — the
      // effect is idempotent by design, so nothing would ever correct it.
      const size = map.getContainer()
      const sizeKey = `${size.clientWidth}x${size.clientHeight}`
      const shouldFit =
        forceRefit || !lastCentred.current || !inside || lastFitSize.current !== sizeKey
      if (!shouldFit) return

      // Padding is deliberately tiny. The whole survey block is ten metres across,
      // and every pixel of padding here is bought directly out of the scale: each
      // zoom step doubles the metres the block covers on screen, and the integer
      // search means a few pixels can cost a whole level. The map chrome sits in
      // the corners and is allowed to overlap the block; what is being watched is
      // the aircraft in the middle.
      map.fitBounds(bounds, {
        padding: [FIT_PADDING_PX, FIT_PADDING_PX],
        animate: false,
      })

      // The fit is deliberately *not* verified here against `zoomToFit`. It was, and
      // the check was worse than useless: it ran once, on this tick, and the map is
      // often not yet sized at that moment, so it could silently no-op on exactly the
      // case it existed to catch — while reporting clean. `useViewMetrics` reports
      // the same comparison continuously instead, from the container's own size and
      // the map's own zoom, and the readout turns amber when the pane is settling for
      // less than it can afford. One instrument, and it is the one that survives
      // layout.
      lastCentred.current = position
      lastFitSize.current = sizeKey
      userPanned.current = false
      return
    }

    // 'follow'. Recentre on meaningful travel only — a walker at a metre a second
    // still moves between ticks, and re-panning every tick makes the imagery shimmer.
    const prev = lastCentred.current
    const moved = !prev || distanceM(prev, position) >= recentreThresholdM
    if (!moved) return

    // Once the operator has panned, only resume following when the drone would
    // otherwise leave the screen entirely.
    if (userPanned.current && isOnScreen(map, position)) return

    map.panTo([position.lat, position.lon], { animate: false })
    lastCentred.current = position
    userPanned.current = false
  }, [map, mode, position, extent, recentreThresholdM, forceRefit])
}

/**
 * What the map is currently showing, in units that can be argued with.
 *
 * The map's own zoom, its container's pixel size, and the scale that follows from
 * the two — plus, crucially, the zoom the *layout* can afford. Reporting those
 * together is the point: a live zoom on its own cannot distinguish "the fit chose a
 * conservative zoom" from "this pane is too short to hold the block at a usable
 * scale", and those two have entirely different fixes.
 *
 * `pixelsPerMetre` is derived from `zoom` and the map's own latitude rather than
 * measured off the imagery, so it is an independent check on the map rather than a
 * restatement of it.
 */
export interface ViewMetrics {
  /** The map's current zoom, as reported by the Maps API. */
  zoom: number
  /** Container size in CSS pixels. */
  width: number
  height: number
  /** Ground scale at the current zoom, in pixels per metre. */
  pixelsPerMetre: number
  /** The span of ground the view is being asked to hold, in metres. */
  spanM: number
  /** Width of that span on screen at the current zoom — the number that is too small. */
  spanPx: number
  /**
   * The span the map is actually showing, measured off its own viewport.
   *
   * Distinct from `spanM` above, and the distinction is the whole instrument:
   * `spanM` is what the view was *asked* to hold, this is what it *does* hold. A map
   * that ignores its instructions shows up here and nowhere else — the first version
   * of this hook only reported the request and so confidently described a
   * ten-metre view of a forty-metre one.
   */
  viewportSpanM: number
  /**
   * The zoom this container can afford for that span.
   *
   * Equal to `zoom` when the fit did its job; greater when the map has settled for
   * less than the pane can give. Compared against `zoom` it is the whole diagnosis.
   */
  affordableZoom: number
  /**
   * How deep the current basemap's imagery actually goes — not the map's zoom limit.
   *
   * Reported so the readout can name the real floor on detail rather than the
   * console's own limit. On Esri World Imagery these differ by three levels (19
   * against 22), which is a factor of eight in ground scale — far too large a gap
   * for a diagnostic to paper over.
   *
   * Deliberately *not* called `maxZoom`, and not called `ceiling` either. Under those
   * names this number was passed to Leaflet's map `maxZoom` as well as to the readout,
   * which clamped the operator at 19 and switched the tile layers off above it. See
   * `BASEMAP_NATIVE_DEPTH` in `LiveMap` and `ESRI_MAX_NATIVE_ZOOM` in `lib/config`.
   */
  imageryDepth: number
  /**
   * Which axis is starving the fit.
   *
   * `fitBounds` has to satisfy the width and the height, so one of them runs out
   * first; on a wide, short pane it is always the height. Widening such a pane buys
   * nothing, which is why a fit can be insensitive to changes that look like they
   * should matter. Named for the axis, so a width-bound pane is the unexpected case
   * and the one worth reading the readout for.
   */
  binding: 'width' | 'height'
}

export function useViewMetrics(spanM: number, imageryDepth: number = MAX_LIVE_MAP_ZOOM): ViewMetrics | null {
  const { map } = useMap()
  const [view, setView] = useState<ViewMetrics | null>(null)

  useEffect(() => {
    const measure = () => {
      const div = map.getContainer()
      const zoom = map.getZoom()
      const bounds = map.getBounds()
      if (zoom === undefined || !bounds) return
      const width = div.clientWidth
      const height = div.clientHeight
      const center = map.getCenter()
      const lat = center ? center.lat : 0
      const pxPerM = pixelsPerMetre(zoom, lat)
      const affordable = zoomToFit(spanM, width, height, FIT_PADDING_PX, lat)

      // The span the map is *actually* showing, measured off its own viewport
      // rectangle rather than reported back as the span that was asked for. The
      // two disagreeing is the whole bug, so an instrument that only echoes the
      // request can never see it — the first version of this hook did exactly that
      // and confidently reported a ten-metre view of a forty-metre one.
      const ne = bounds.getNorthEast()
      const sw = bounds.getSouthWest()
      const viewportSpanM = Math.max(
        (ne.lat - sw.lat) * M_PER_DEG_LAT,
        (ne.lng - sw.lng) * mPerDegLon(lat),
      )

      // Only on a real change. `bounds_changed` fires continuously — every frame of
      // a pan, and on any setOptions — so publishing unconditionally would re-render
      // the map's parents several times a second to report the same numbers.
      const nearest = (v: number) => Math.round(v * 10) / 10
      setView((prev) =>
        prev &&
        prev.zoom === zoom &&
        prev.width === width &&
        prev.height === height &&
        prev.imageryDepth === imageryDepth &&
        prev.viewportSpanM === nearest(viewportSpanM)
          ? prev
          : {
              zoom,
              width,
              height,
              pixelsPerMetre: pxPerM,
              // The block as measured on screen: a known span multiplied by the
              // live scale. Not an assumption about the view — it moves with the
              // zoom, which is why it reads 281 px at zoom 22 and 70 px at zoom 20.
              spanM,
              spanPx: spanM * pxPerM,
              viewportSpanM: nearest(viewportSpanM),
              affordableZoom: affordable,
              imageryDepth,
              // `zoomToFit` spends whichever axis runs out first, so on a wide, short
              // pane the height is what limits it — the readout is asking "what is
              // stopping this pane from going further", and the answer is the smaller
              // axis.
              binding: height <= width ? 'height' : 'width',
            },
      )
    }

    measure()
    // `zoomend`/`moveend` rather than the Maps `*_changed` events: Leaflet fires
    // `zoom`/`move` continuously during a gesture, and publishing metrics on every
    // frame of a pan would re-render the map's parents several times a second to
    // report the same numbers. The `end` variants fire once when the view settles,
    // which is the granularity this instrument is read at.
    map.on('zoomend', measure)
    map.on('moveend', measure)
    const observer = new ResizeObserver(measure)
    observer.observe(map.getContainer())

    return () => {
      map.off('zoomend', measure)
      map.off('moveend', measure)
      observer.disconnect()
    }
  }, [map, spanM, imageryDepth])

  return view
}

/**
 * Is the map zoomed in far enough to be worth looking at?
 *
 * The console has one hard requirement of its map: that the aircraft can be seen to
 * move across a survey block the size of a basketball court. That is a statement
 * about ground scale in pixels per metre, and it is decidable without looking at the
 * screen — so the map asks the question directly instead of inferring it from
 * pixels, which do not know what they are measuring.
 *
 * The check runs after every view change rather than once. A fit that lands short
 * can be nudged back, an operator's zoom-out can be recognised for what it is, and a
 * container that shrinks under the map — a window resize, a dock opening, the live
 * feed taking a strip of the column — gets noticed even though the map itself was
 * never told anything. In every one of those cases the maps' own answer is
 * authoritative: this calls `fitBounds` and lets the API choose, rather than
 * computing a zoom and assuming it is reachable under whatever `minZoom`, `maxZoom`
 * and restriction are in force. The arithmetic in `lib/scale.ts` predicts the
 * outcome; it does not decide it.
 *
 * Bounded to three attempts, and subordinate to the operator. Re-running a fit inside
 * the callback that observes zoom changes is one step from an infinite loop, and an
 * operator who has zoomed out on purpose — to find their way back to a block they
 * have lost — must not have the map yank itself in again the moment they stop. That
 * was not a hypothetical: it was measured, twenty-five wheel scrolls out leaving the
 * zoom pinned at 22. So a zoom the operator pulled out ends the guard's interest in
 * this pane size entirely, and the three-attempt budget is a bound on the guard's own
 * correction attempts rather than a licence to keep trying. If three fits have not
 * produced a legible scale the container cannot provide one at this span, and the
 * answer is a layout change, not a fourth fit.
 *
 * Returns whether the map is currently legible, so a caller can say so.
 *
 * Takes no ceiling. It used to: the basemap's imagery depth was threaded in so the
 * guard could decline to re-fit a view that was already as deep as its tiles go. That
 * was the wrong instrument for this question, and using it is what left the operator
 * capped at 19 — the guard stopped correcting at the imagery's depth instead of the
 * map's limit. The map answers this itself now, via `getMaxZoom` below. The imagery
 * depth remains a real fact, reported by `useViewMetrics` for the readout; it is just
 * not a bound on fitting.
 */
export function useViewReadiness(
  position: LatLng | null,
  extent: { south: number; west: number; north: number; east: number } | null,
): boolean {
  const { map } = useMap()
  /**
   * Optimistic until measured.
   *
   * Starting at `false` would flash a "the map is too coarse to read" warning on the
   * first paint of every page load, before a single zoom has been read. Illegibility
   * here is only ever asserted *from a measurement* — the same rule the zoom bug was
   * finally fixed by, and the opposite of the assumption that started it.
   */
  const [ready, setReady] = useState(true)
  const attempts = useRef(0)
  /**
   * The operator has taken this pane, so the guard stands down until it is resized.
   *
   * This is the fix for a measured bug, and why it is a flag rather than arithmetic
   * is worth recording, because the arithmetic looked correct and was not. The guard
   * used to reset its attempt budget on every successful fit. That defeats its own
   * "bounded to three attempts" rule — fit, measure legible, reset to zero, fresh
   * budget — and because it listens to `zoom_changed`, an operator zooming out was
   * answered with a refit, which reset the budget, which permitted another refit.
   * Twenty-five wheel scrolls out on the live map left the zoom pinned at 22: the
   * guard could not merely be slow to yield, it could never yield at all.
   *
   * The first attempt at a fix inferred intent from the change itself — a zoom that
   * decreased, caused by someone other than this guard — on the reasoning that the
   * app never zooms out on its own. It does, though. `useFollowDrone` fits as soon as
   * telemetry arrives, and when that lands before layout settles the fit resolves
   * against a short pane and comes out at zoom 20. That is a decrease this guard did
   * not cause, so it was read as the operator, and the legibility guard stood down
   * and left the map at 20 on three reloads out of three. Inferring intent from the
   * shape of a change means correctly classifying every other fit in the app, and
   * being wrong about any one of them disables the guard.
   *
   * So intent is not inferred. It is observed directly: human input on the map's own
   * container. A wheel, a touch, or a pointer press inside the map div is the
   * operator, unambiguously, and no programmatic `fitBounds` can produce one. This is
   * the same signal `useFollowDrone` uses to back off after a manual pan.
   *
   * Standing down on any interaction rather than only on zoom-out is deliberate, and
   * the reason is that the two mistakes are not symmetric. Standing down too readily
   * leaves the operator looking at their own chosen view — the view they asked for.
   * Not standing down is the bug above: the map fighting the wheel. Interaction
   * means the human has taken the pane, and after that the honest thing is to report
   * the scale and let them read it.
   */
  const operatorTook = useRef(false)
  /**
   * The container size the attempt budget was last spent against.
   *
   * Without this the budget is the bug. `fitBounds` chooses its zoom from the
   * viewport in pixels, so a fit taken while the pane is still 120 px tall picks
   * the zoom for a window that is about to stop existing — and at that height the
   * arithmetic says zoom 20, which is exactly the illegible view this guard was
   * written to eliminate. The three attempts are then spent *before layout
   * settles*, and once they are gone a perfectly healthy 320 px pane is left
   * showing zoom 20 forever. Whether that happens at all depends on whether
   * telemetry arrives before the browser finishes the first layout — which is why
   * the same reload measured zoom 22 one time and zoom 20 the next.
   *
   * A resize is not the operator zooming out; it is the map being handed a new
   * viewport and owing a fresh fit for it. So the budget is re-armed whenever the
   * container's size changes, and the guard can always correct a stale fit.
   *
   * The budget is the *only* thing a resize touches. It deliberately does not clear
   * `operatorTook`, and that separation is the fix for the last measured defect: the
   * operator wheeled out from 22 to 19.1 and then the page's own layout shifted — the
   * map pane going from 880 to 848 px tall as a banner settled — and because the
   * resize branch used to re-arm the operator flag too, the guard treated that
   * incidental layout change as a fresh start and yanked the view back to 22
   * mid-gesture. A pane that changes height while the operator is turning the wheel
   * is this app's normal behaviour, not a special case, so it must not be able to
   * revoke a gesture. Only a genuine new interaction gives the pane back to the
   * guard — via the gesture it already listens for, in the code below.
   */
  const attemptSize = useRef<string | null>(null)

  useEffect(() => {
    const check = () => {
      const zoom = map.getZoom()
      if (zoom === undefined) return

      const div = map.getContainer()
      const sizeKey = `${div.clientWidth}x${div.clientHeight}`
      if (attemptSize.current !== sizeKey) {
        attemptSize.current = sizeKey
        attempts.current = 0
      }

      const center = map.getCenter()
      const lat = center ? center.lat : 0
      const legible = pixelsPerMetre(zoom, lat) >= MIN_LIVE_MAP_PX_PER_METRE

      /**
       * Whether the fit already applied is the best this pane can do.
       *
       * The guard used to fire whenever the view was short of the bar, up to three
       * times, on the theory that a fit might not have happened yet. That theory is
       * false in a way that never resolves when the map has already been driven as far
       * as it will go: the fit is issued, the map grants its own maximum instead, the
       * measurement is short, and another identical fit is issued — three times, every
       * time — until the budget runs out and the shortfall is reported as though the
       * operator had caused it. A permanent red warning, for no reason they could act
       * on. So when the shortfall is the map's limit rather than an unfinished fit, the
       * guard declines to spend an attempt. `setReady` above has already run, so the
       * scale is still reported honestly; what stops is the pretence that a fourth fit
       * would move anything.
       *
       * Asked of the map, not of a number threaded in. This test was previously given
       * the basemap's *imagery depth* (Esri's native 19) and treated it as the map's
       * limit, which is how the two got conflated in the first place. The consequence
       * was concrete: a pane that could afford zoom 21 would stop being re-fitted the
       * moment it reached 19, because 19 had been declared the end of the road. The
       * question here is "can the map go further", and `getMaxZoom` is the only thing
       * that actually knows. The imagery's depth is a different fact, reported by
       * `useViewMetrics` for the readout and used nowhere else.
       *
       * Attempts are therefore reserved for the case they were written for: a fit that
       * landed short of a zoom the map *could* have reached, which is the
       * stale-viewport case and the one where re-fitting actually moves the map.
       */
      const atCeiling = zoom >= (map.getMaxZoom() ?? Infinity) - 1e-6

      setReady(legible)

      if (legible || !position) {
        // A view that satisfies the requirement retires the allowance, so a later
        // layout change gets its own three attempts rather than inheriting a spent
        // budget from the last one.
        //
        // This renewal is necessary and it is also exactly what made the guard
        // unyielding, so the two facts belong together. Necessary: it is what lets the
        // map reach the working zoom at all. Removed, three consecutive loads settled
        // at zoom 20 rather than 22, because the startup fits — this one and
        // `useFollowDrone`'s — both spend attempts against a pane that layout has not
        // finished, and once three have gone nothing corrects the last bad one.
        // Measured both ways.
        //
        // And with it in place the guard cannot be escaped by zooming out: yank back
        // to 22, measure legible, renew, and the budget is fresh for the next yank.
        // That is why the operator's gesture has to end the guard's interest rather
        // than the budget having to run down — see `operatorTook`. The renewal is only
        // safe because a gesture now stops the fit that the renewal would have funded.
        if (legible) attempts.current = 0
        return
      }
      if (operatorTook.current) return
      if (attempts.current >= 3) return
      // The pane and the basemap have between them given all they have. Another fit
      // would be identical — see `atCeiling` above.
      if (atCeiling) return

      const bounds = boundsOf(extent, position)

      attempts.current += 1
      map.fitBounds(bounds, {
        padding: [FIT_PADDING_PX, FIT_PADDING_PX],
        animate: false,
      })
    }

    /**
     * Any human gesture on the map hands the pane over.
     *
     * Passive, because these only observe: the map's own handlers must receive the
     * events unaltered, and calling `preventDefault` here would break panning and
     * zooming outright.
     */
    const onUserGesture = () => {
      operatorTook.current = true
    }
    const div = map.getContainer()
    div.addEventListener('wheel', onUserGesture, { passive: true })
    div.addEventListener('touchstart', onUserGesture, { passive: true })
    div.addEventListener('pointerdown', onUserGesture, { passive: true })

    check()
    map.on('zoomend', check)
    map.on('moveend', check)
    const observer = new ResizeObserver(check)
    observer.observe(div)

    return () => {
      map.off('zoomend', check)
      map.off('moveend', check)
      observer.disconnect()
      div.removeEventListener('wheel', onUserGesture)
      div.removeEventListener('touchstart', onUserGesture)
      div.removeEventListener('pointerdown', onUserGesture)
    }
  }, [map, position, extent])

  return ready
}

/** Is a lat/lon inside a bounding box? */
function isInside(
  b: { south: number; west: number; north: number; east: number },
  p: LatLng,
): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east
}

/** Is a point within the map's current viewport, with a small margin? */
function isOnScreen(map: L.Map, p: LatLng): boolean {
  const bounds = map.getBounds()
  if (!bounds) return true
  return bounds.contains([p.lat, p.lon])
}

/**
 * Screen-space projection for DOM-anchored chrome.
 *
 * The detection callout and the live-feed frame are absolutely-positioned DOM
 * elements sitting over the map, so they need ground coordinates expressed as
 * pixels. `revision` is the invalidation signal: the map has no "the view moved,
 * repaint your DOM" callback, so a consumer re-reads pixel positions whenever the
 * number changes.
 *
 * This used to need an invisible `OverlayView` subclass — the Maps API has no direct
 * ground-to-container-pixel call, and it has to be derived from a live overlay
 * because the `google` namespace does not exist at module evaluation. Leaflet has
 * the call on the map itself (`latLngToContainerPoint`), which is the same projection
 * the tile pane uses, so it stays correct under any pan, any zoom and fractional
 * zoom without an intermediate object to keep alive.
 */
export function useContainerProjection(): {
  /** Ground position -> pixel offset within the map container, or null if unprojectable. */
  toContainerPixel: (p: LatLng) => { x: number; y: number } | null
  /** Container size in CSS pixels. */
  size: { x: number; y: number }
  /** Increments on every pan/zoom/resize. */
  revision: number
} {
  const { map } = useMap()
  const [revision, setRevision] = useState(0)
  const [size, setSize] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const bump = () => setRevision((r) => r + 1)
    // `move` and `zoom` — the continuous variants, not the `end` ones — because a
    // DOM overlay has to track the ground *during* a pan, not snap into place when
    // it finishes. This is the one hook that wants every frame.
    map.on('move', bump)
    map.on('zoom', bump)
    map.on('resize', bump)

    const measure = () => {
      const div = map.getContainer()
      setSize({ x: div.clientWidth, y: div.clientHeight })
      bump()
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(map.getContainer())

    return () => {
      map.off('move', bump)
      map.off('zoom', bump)
      map.off('resize', bump)
      observer.disconnect()
    }
  }, [map])

  return useMemo(
    () => ({
      toContainerPixel: (p: LatLng) => {
        const point = map.latLngToContainerPoint([p.lat, p.lon])
        return Number.isFinite(point.x) && Number.isFinite(point.y)
          ? { x: point.x, y: point.y }
          : null
      },
      size,
      revision,
    }),
    [map, size, revision],
  )
}

/**
 * Run `draw` at most once per animation frame, keyed off a `revision` counter.
 *
 * Panning fires `move` many times per frame. An overlay that repositions
 * dozens of DOM nodes on each one does that work many times over to produce one
 * visible result. Coalescing to a frame is the difference between a smooth pan and
 * a visibly stuttering one.
 */
export function useThrottledDraw(revision: number, draw: () => void): void {
  const drawRef = useRef(draw)
  drawRef.current = draw

  useEffect(() => {
    const handle = requestAnimationFrame(() => drawRef.current())
    return () => cancelAnimationFrame(handle)
  }, [revision])
}