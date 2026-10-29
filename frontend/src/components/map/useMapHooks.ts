import { useEffect, useMemo, useRef, useState } from 'react'
import { M_PER_DEG_LAT, distanceM, mPerDegLon } from '@/lib/geo'
import { FIT_PADDING_PX, MIN_LIVE_MAP_PX_PER_METRE } from '@/lib/config'
import { pixelsPerMetre, zoomToFit } from '@/lib/scale'
import type { LatLng } from '@/types'
import { useMap } from './mapContext'

/**
 * Track the map's zoom and report a marker scale factor.
 *
 * Vector markers (`google.maps.Symbol`) are drawn in screen space, so a glyph that
 * reads well at the working zoom is an unreadable speck two steps out and a giant
 * obstruction two steps in. Leaflet's PNG markers had the same problem, solved by
 * luck of the size chosen. Scaling the symbols with zoom keeps a pin's *apparent*
 * size roughly constant on the ground, which is what makes a hazard field legible
 * at any zoom.
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
    const listener = map.addListener('zoom_changed', update)
    return () => listener.remove()
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
    const drag = map.addListener('dragstart', onDrag)
    const zoom = map.addListener('zoom_changed', onDrag)
    return () => {
      drag.remove()
      zoom.remove()
    }
  }, [map])

  useEffect(() => {
    if (mode === 'manual' || !position) return

    if (mode === 'fit') {
      // 'fit' is idempotent — recomputing it on every telemetry frame would be a
      // visible shimmy, so it only runs when the extent changes or the drone first
      // appears outside it.
      const bounds = new google.maps.LatLngBounds()
      if (extent) {
        bounds.extend({ lat: extent.south, lng: extent.west })
        bounds.extend({ lat: extent.north, lng: extent.east })
      }
      bounds.extend({ lat: position.lat, lng: position.lon })

      const inside = !extent || isInside(extent, position)
      // Refit when the extent changes, when the drone leaves it, when the map
      // itself changed size, or when the operator explicitly asks for the framed
      // view back. `fitBounds` decides its zoom from the viewport in pixels, so a
      // fit taken before layout settled is wrong for the life of the screen — the
      // effect is idempotent by design, so nothing would ever correct it.
      const size = map.getDiv()
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
        top: FIT_PADDING_PX,
        right: FIT_PADDING_PX,
        bottom: FIT_PADDING_PX,
        left: FIT_PADDING_PX,
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

    map.panTo({ lat: position.lat, lng: position.lon })
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

export function useViewMetrics(spanM: number): ViewMetrics | null {
  const { map } = useMap()
  const [view, setView] = useState<ViewMetrics | null>(null)

  useEffect(() => {
    const measure = () => {
      const div = map.getDiv()
      const zoom = map.getZoom()
      const bounds = map.getBounds()
      if (zoom === undefined || !bounds) return
      const width = div.clientWidth
      const height = div.clientHeight
      const lat = map.getCenter()?.lat() ?? 0
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
        (ne.lat() - sw.lat()) * M_PER_DEG_LAT,
        (ne.lng() - sw.lng()) * mPerDegLon(lat),
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
              // `zoomToFit` spends whichever axis runs out first, so on a wide, short
              // pane the height is what limits it — the readout is asking "what is
              // stopping this pane from going further", and the answer is the smaller
              // axis.
              binding: height <= width ? 'height' : 'width',
            },
      )
    }

    measure()
    const listeners = [
      map.addListener('zoom_changed', measure),
      map.addListener('bounds_changed', measure),
    ]
    const observer = new ResizeObserver(measure)
    observer.observe(map.getDiv())

    return () => {
      listeners.forEach((l) => l.remove())
      observer.disconnect()
    }
  }, [map, spanM])

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
 * Bounded to three attempts. Re-running a fit inside the callback that observes
 * zoom changes is one step from an infinite loop, and an operator who has zoomed
 * out on purpose — to find their way back to a block they have lost — must not have
 * the map yank itself in again the moment they stop. If three fits have not produced
 * a legible scale, the container cannot provide one at this span and the answer is a
 * layout change, not a fourth fit.
 *
 * Returns whether the map is currently legible, so a caller can say so.
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
   */
  const attemptSize = useRef<string | null>(null)

  useEffect(() => {
    const check = () => {
      const zoom = map.getZoom()
      if (zoom === undefined) return

      const div = map.getDiv()
      const sizeKey = `${div.clientWidth}x${div.clientHeight}`
      if (attemptSize.current !== sizeKey) {
        attemptSize.current = sizeKey
        attempts.current = 0
      }

      const lat = map.getCenter()?.lat() ?? 0
      const legible = pixelsPerMetre(zoom, lat) >= MIN_LIVE_MAP_PX_PER_METRE
      setReady(legible)

      if (legible || !position) {
        // A view that satisfies the requirement retires the allowance, so a later
        // layout change gets its own three attempts rather than inheriting a spent
        // budget from the last one.
        if (legible) attempts.current = 0
        return
      }
      if (attempts.current >= 3) return

      const bounds = new google.maps.LatLngBounds()
      if (extent) {
        bounds.extend({ lat: extent.south, lng: extent.west })
        bounds.extend({ lat: extent.north, lng: extent.east })
      }
      bounds.extend({ lat: position.lat, lng: position.lon })

      attempts.current += 1
      map.fitBounds(bounds, {
        top: FIT_PADDING_PX,
        right: FIT_PADDING_PX,
        bottom: FIT_PADDING_PX,
        left: FIT_PADDING_PX,
      })
    }

    check()
    const listeners = [
      map.addListener('zoom_changed', check),
      map.addListener('bounds_changed', check),
    ]
    const observer = new ResizeObserver(check)
    observer.observe(map.getDiv())

    return () => {
      listeners.forEach((l) => l.remove())
      observer.disconnect()
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
function isOnScreen(map: google.maps.Map, p: LatLng): boolean {
  const bounds = map.getBounds()
  if (!bounds) return true
  return bounds.contains({ lat: p.lat, lng: p.lon })
}

/**
 * An invisible `OverlayView` whose only purpose is to expose
 * `fromLatLngToContainerPixel`.
 *
 * This is the supported way to convert a ground position to a pixel offset inside
 * the map's own container. Doing it by hand from `getProjection()` and world
 * coordinates works for the common case but accumulates drift as the map is panned,
 * and breaks outright at fractional zoom — `OverlayView` is handed the map's actual
 * pixel projection, so it stays correct under any pan and any zoom.
 *
 * The subclass is built here, on first use, rather than declared with `class X
 * extends google.maps.OverlayView` at module scope. The Maps JavaScript API is
 * fetched asynchronously, so at the moment this module is evaluated `google` does
 * not exist yet — an `extends` clause evaluates its superclass expression during
 * module evaluation and would throw `google is not defined` before any component
 * ever renders. Deferring to first use also means the class is derived from the
 * same `google` namespace the live map came from. Cached so a pan does not
 * re-derive it.
 */
let ProjectionProbeClass: (new () => google.maps.OverlayView) | null = null

function projectionProbeClass(): new () => google.maps.OverlayView {
  if (ProjectionProbeClass) return ProjectionProbeClass

  ProjectionProbeClass = class extends google.maps.OverlayView {
    onAdd(): void {
      /* Nothing to attach — this overlay exists only for its projection. */
    }

    draw(): void {
      /* Nothing to draw. */
    }

    onRemove(): void {
      /* Nothing to detach. */
    }
  }
  return ProjectionProbeClass
}

/**
 * Screen-space projection for DOM-anchored chrome.
 *
 * The detection callout and the live-feed frame are absolutely-positioned DOM
 * elements sitting over the map, so they need ground coordinates expressed as
 * pixels. `revision` is the invalidation signal: the map has no "the view moved,
 * repaint your DOM" callback, so a consumer re-reads pixel positions whenever the
 * number changes.
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
  const probeRef = useRef<google.maps.OverlayView | null>(null)
  const [revision, setRevision] = useState(0)
  const [size, setSize] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const probe = new (projectionProbeClass())()
    probeRef.current = probe
    probe.setMap(map)

    const bump = () => setRevision((r) => r + 1)
    const listeners = [
      map.addListener('bounds_changed', bump),
      map.addListener('zoom_changed', bump),
      map.addListener('drag', bump),
      map.addListener('resize', bump),
    ]

    const measure = () => {
      const div = map.getDiv()
      setSize({ x: div.clientWidth, y: div.clientHeight })
      bump()
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(map.getDiv())

    return () => {
      listeners.forEach((l) => l.remove())
      observer.disconnect()
      probe.setMap(null)
      probeRef.current = null
    }
  }, [map])

  return useMemo(
    () => ({
      toContainerPixel: (p: LatLng) => {
        const projection = probeRef.current?.getProjection()
        if (!projection) return null
        const point = projection.fromLatLngToContainerPixel({
          lat: p.lat,
          lng: p.lon,
        })
        return point ? { x: point.x, y: point.y } : null
      },
      size,
      revision,
    }),
    [size, revision],
  )
}

/**
 * Run `draw` at most once per animation frame, keyed off a `revision` counter.
 *
 * Panning fires `bounds_changed` many times per frame. An overlay that repositions
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