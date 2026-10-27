import { useEffect, useMemo, useRef, useState } from 'react'
import { distanceM } from '@/lib/geo'
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
}

export function useFollowDrone({
  position,
  extent,
  mode,
  recentreThresholdM = 1.5,
}: FollowOptions): void {
  const { map } = useMap()
  const lastCentred = useRef<LatLng | null>(null)
  /** Set when the operator pans manually; cleared once we re-centre intentionally. */
  const userPanned = useRef(false)

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
      const shouldFit = !lastCentred.current || !inside
      if (!shouldFit) return

      map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 })
      lastCentred.current = position
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
  }, [map, mode, position, extent, recentreThresholdM])
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