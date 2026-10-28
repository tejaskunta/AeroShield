import type { LatLng } from '@/types'

/**
 * DroneOverlay — the aircraft mark, drawn as a DOM element so it can carry a raster
 * image and still rotate.
 *
 * ── Why this is a DOM overlay and not a Marker ──────────────────────────────────
 *
 * A `google.maps.Marker` icon is either a raster image or a vector `Symbol`. A
 * `Symbol` supports `rotation`, and a raster `Marker` icon does not — the API has no
 * rotation field on `Icon`. Since the aircraft is a PNG (a photograph of a model, not
 * a shape we can express as a path), rotation has to come from CSS on a DOM element,
 * which means an `OverlayView`. That is the whole reason this file exists.
 *
 * ── Why the class is built lazily ──────────────────────────────────────────────
 *
 * The Maps JavaScript API is fetched asynchronously, so at the moment this module is
 * evaluated `google` does not exist yet. Writing `class X extends google.maps.OverlayView`
 * at module scope evaluates the superclass expression during module evaluation and
 * throws `google is not defined` before any component ever renders — the page never
 * gets as far as showing a map. The class is therefore derived on first use and
 * cached, so a remount reuses it rather than re-deriving the prototype chain.
 *
 * This mirrors `projectionProbeClass()` in `useMapHooks.ts`. Both must stay lazy.
 *
 * ── Positioning, and the two transforms ────────────────────────────────────────
 *
 * Centreing and rotation are deliberately on *separate* elements. Rotation applied to
 * a centred element still rotates about its own centre, but composing
 * `translate(-50%, -50%) rotate(θ)` in one transform list makes the rotation depend on
 * the order the two are written, and getting that order wrong shifts the drone off its
 * own coordinate by up to half its width. Instead the outer element is centred with
 * `translate(-50%, -50%)` and never rotates; the inner element only ever rotates. The
 * anchor stays correct at every heading by construction rather than by arithmetic.
 */

/** Rendered size of the aircraft glyph, in CSS pixels. */
const DRONE_PX = 40

/** Vite serves `public/` at the site root, so this is a root-relative URL. */
const DRONE_IMAGE = '/assets/drone.png'

const HEADING_ORIGIN = 'translate(-50%, -50%)'

/**
 * The public face of the overlay.
 *
 * Callers never see the class — only this. That keeps the `extends` behind a factory
 * and means nothing outside this module can accidentally hold a reference to a
 * half-constructed overlay.
 */
export interface DroneOverlayHandle {
  /** Attach to a map, or detach with `null`. Idempotent. */
  setMap(map: google.maps.Map | null): void
  /** Move the aircraft. Repaints immediately rather than waiting for a map event. */
  setPosition(position: LatLng): void
  /** Point the aircraft, in compass degrees clockwise from north. */
  setHeading(deg: number): void
}

let CachedClass: (new () => DroneOverlayHandle) | null = null

function droneOverlayClass(): new () => DroneOverlayHandle {
  if (CachedClass) return CachedClass

  class DroneOverlay extends google.maps.OverlayView implements DroneOverlayHandle {
    private position: LatLng = { lat: 0, lon: 0 }
    private headingDeg = 0

    /** Outer element: centred, never rotated. Holds the grid position. */
    private anchor: HTMLDivElement | null = null
    /** Inner element: only ever rotated. Holds the image. */
    private rotator: HTMLDivElement | null = null

    /** True once the PNG has failed, so a retry does not fire on every repaint. */
    private imageFailed = false

    onAdd(): void {
      const anchor = document.createElement('div')
      anchor.style.position = 'absolute'
      anchor.style.transform = HEADING_ORIGIN
      anchor.style.width = `${DRONE_PX}px`
      anchor.style.height = `${DRONE_PX}px`
      // The drone is an indicator, never a target: a click or drag that lands on it
      // must reach the map underneath, or the aircraft becomes a dead spot to pan
      // over at exactly the position the operator is most likely to be looking.
      anchor.style.pointerEvents = 'none'
      anchor.style.zIndex = '1000'
      anchor.setAttribute('aria-hidden', 'true')

      const rotator = document.createElement('div')
      rotator.style.width = '100%'
      rotator.style.height = '100%'
      rotator.style.transformOrigin = 'center center'
      // Rotate with the compositor. A repositioning overlay is already doing layout
      // work on every map move; making the rotation cheap keeps it off the main
      // thread's critical path during a pan.
      rotator.style.willChange = 'transform'

      const image = document.createElement('img')
      image.src = DRONE_IMAGE
      image.alt = ''
      image.draggable = false
      image.width = DRONE_PX
      image.height = DRONE_PX
      image.style.width = '100%'
      image.style.height = '100%'
      image.style.objectFit = 'contain'
      image.style.display = 'block'

      // A missing asset must degrade to something still readable as "the aircraft is
      // here", not to an invisible drone. The clip-path is the same notched dart the
      // vector symbol drew, so the silhouette survives the fallback.
      const fallback = document.createElement('div')
      fallback.style.position = 'absolute'
      fallback.style.inset = '0'
      fallback.style.display = 'none'
      fallback.style.background = '#E8E4DA'
      fallback.style.clipPath = 'polygon(50% 4%, 96% 96%, 50% 70%, 4% 96%)'

      image.addEventListener('error', () => {
        if (this.imageFailed) return
        this.imageFailed = true
        image.style.display = 'none'
        fallback.style.display = 'block'
      })

      rotator.appendChild(image)
      rotator.appendChild(fallback)
      anchor.appendChild(rotator)

      this.anchor = anchor
      this.rotator = rotator

      // `floatPane` is the topmost pane, above `markerLayer`. The aircraft must never
      // be hidden behind the pin it is investigating, so the detection markers being
      // in a lower pane is exactly the ordering wanted here.
      const panes = this.getPanes()
      panes?.floatPane.appendChild(anchor)

      this.applyHeading()
    }

    draw(): void {
      const anchor = this.anchor
      if (!anchor) return

      const projection = this.getProjection()
      // `draw` can fire before the projection is ready — most reliably on the very
      // first paint after `setMap`. There is nothing to position against yet.
      if (!projection) return

      const point = projection.fromLatLngToContainerPixel({
        lat: this.position.lat,
        lng: this.position.lon,
      })
      if (!point) return

      anchor.style.left = `${point.x}px`
      anchor.style.top = `${point.y}px`
    }

    onRemove(): void {
      this.anchor?.parentNode?.removeChild(this.anchor)
      this.anchor = null
      this.rotator = null
    }

    setPosition(position: LatLng): void {
      this.position = position
      // Repaint now rather than waiting for the next map event: telemetry updates
      // arrive independently of panning, and a hover would otherwise never redraw.
      this.draw()
    }

    setHeading(deg: number): void {
      this.headingDeg = deg
      this.applyHeading()
    }

    private applyHeading(): void {
      if (!this.rotator) return
      // CSS `rotate` is clockwise, and a compass heading is clockwise from north, so
      // the heading is the rotation with no offset. The PNG is authored nose-up for
      // the same reason: one less constant to get wrong.
      this.rotator.style.transform = `rotate(${this.headingDeg}deg)`
    }
  }

  CachedClass = DroneOverlay as unknown as new () => DroneOverlayHandle
  return CachedClass
}

/**
 * Build an aircraft overlay. The caller owns the handle and must `setMap(null)` to
 * detach — the same contract `google.maps.Marker` has, so it drops into the existing
 * effect lifecycle without a special case.
 */
export function createDroneOverlay(): DroneOverlayHandle {
  return new (droneOverlayClass())()
}