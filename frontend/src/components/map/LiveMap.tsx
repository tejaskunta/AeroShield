import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Detection, LatLng, MissionProgress, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { MAX_LIVE_MAP_ZOOM, MIN_LIVE_MAP_PX_PER_METRE } from '@/lib/config'
import { isBelowAffordableZoom } from '@/lib/scale'
import { gridBounds, gridCenter, M_PER_DEG_LAT, mPerDegLon } from '@/lib/geo'
import { basemapNativeDepth, type Basemap } from './basemaps'
import { DroneImageryLayer, type DroneOverlayMeta } from './DroneImageryLayer'
import type { MapControls, MapViewState } from './viewTypes'
import { useMap } from './mapContext'
import { MapRoot } from './MapRoot'
import { MissionGridLayer } from './MissionGridLayer'
import { CoverageHatchLayer } from './CoverageHatchLayer'
import { DronePlatform } from './DronePlatform'
import { DetectionPins } from './DetectionPins'
import { TrackLayer } from './TrackLayer'
import type { LayerState } from './LayerToggles'
import {
  VIEW_SPAN_M,
  useFollowDrone,
  useViewMetrics,
  useViewReadiness,
  type FollowMode,
  type ViewMetrics,
} from './useMapHooks'

/**
 * LiveMap — the canvas everything else docks to.
 *
 * Basemaps are raster tile layers now, in three flavours: `hybrid` is Esri World
 * Imagery with their boundaries-and-places reference layer over it, `roadmap` is the
 * OpenStreetMap street canvas, `satellite` is Esri imagery alone. Imagery is the
 * default because it is what the drone actually sees; the street canvas is the
 * fallback for when imagery is unavailable or too busy to read hazard colour against.
 *
 * The basemap type and its labels live in `basemaps.ts`, alongside the tile-URL
 * construction, and are re-exported here so the two cannot drift.
 *
 * ── The scale of this map is metres ──────────────────────────────────────────────
 *
 * The survey block is 10 m × 10 m — the area the aircraft can actually be walked
 * over by hand. Everything about the view follows from that: the zoom is a street
 * zoom, not a regional one; the grid is drawn at one-metre cells so the individual
 * squares are legible; and the padding that keeps the map pannable has to be
 * generous in relative terms (metres) without being absurd in absolute ones.
 *
 * The original view framed a 320 × 240 m fixture block at zoom 17 — a correct view
 * of an eight-hectare field, and a useless one for a ten-metre square, where the
 * aircraft, the mines, and the grid were all a few pixels across.
 *
 * ── The drone-visibility fix still applies ───────────────────────────────────────
 *
 * An early version framed the block once on mount and then never moved, with panning
 * bounded to the block and a fixed zoom. The aircraft was drawn — correctly, at its
 * real GPS position — somewhere outside the viewport, and the only honest conclusion
 * available to an operator was that the drone was missing. The replacement is
 * `useFollowDrone`, with three modes the operator chooses between:
 *
 *   Follow   recentre as the drone moves              — for watching the flight
 *   Fit      hold the drone *and* the block in view   — for seeing ground left to fly
 *   Manual   never move on its own                    — for reading the map
 *
 * All three are passive about manual input. None of them fights the mouse, which is
 * the failure mode that makes automatic map-following infuriating.
 */
export type { Basemap }

/**
 * How deep each basemap's imagery actually goes — where the tiles stop being *real*.
 *
 * This is not the zoom limit, and treating it as one cost the operator every level
 * from 19 to 22. The two questions are separate and Leaflet asks them separately:
 *
 *   - How far may the operator zoom?    -> the map's `maxZoom`      -> 22, always
 *   - Where do the tiles stop being real? -> the layer's `maxNativeZoom` -> this
 *
 * Past the native depth Leaflet scales the deepest tile up. The ground stays
 * geographically correct and merely softens, so the operator keeps a usable view of
 * the survey block instead of losing the map at the exact moment they zoomed in to
 * read it. That upscaling is `maxNativeZoom`, which `basemaps.ts` sets from
 * `NATIVE_TILE_ZOOM`; nothing here needs to arrange it.
 *
 * Esri World Imagery is native to 19 over most of the world. It does not *error* past
 * that — it absently serves blank or placeholder tiles — which is why the number is
 * worth recording even though it no longer gates the map: it is what the readout
 * names, and what the live imagery test pins.
 *
 * The old version of this table fed 19 into the map's `maxZoom` for `satellite` and
 * `hybrid`. A tile layer whose `maxZoom` sits below the map's current zoom is not
 * merely soft in Leaflet, it is switched off entirely (`GridLayer._setView`), so the
 * imagery did not degrade past 19 — it disappeared, and the console reported zoom 19
 * as the ceiling. Also removed by that conflation: the guard's `atCeiling` test read
 * 19 as "this pane has given all it has" and stopped re-fitting while a perfectly
 * reachable 22 sat two levels away.
 *
 * Street is different only in that OpenStreetMap serves native tiles all the way to
 * the configured limit, so its native depth and its zoom limit coincide. Recording it
 * as a value rather than special-casing it keeps the readout the same shape on every
 * basemap.
 */
// The table itself now lives in `basemapNativeDepth` (basemaps.ts), because the
// answer depends on the provider as well as the basemap: Google is real to z20,
// Esri to z19, and OSM's street tiles to z19. Over the drone photo the answer is
// the map's own ceiling, which `LiveMap` applies below.

/**
 * How far the operator may zoom, on every basemap.
 *
 * One number for all three, because the limit is the console's and not the imagery's.
 * The imagery's limit is `basemapNativeDepth` (basemaps.ts), enforced by `maxNativeZoom`.
 *
 * `MAX_LIVE_MAP_ZOOM` is 23 (about 1.8 cm per pixel here), so a drone-sized object
 * on the field is a recognisable shape. Real detail at 21-23 comes from the drone
 * photo overlay; over the satellite base alone those levels are a magnifier, and the
 * readout says `capped zN` with the provider's true depth. Automatic fits stop at
 * `FIT_MAX_ZOOM` (22) so the framed view the console opens on is unchanged.
 */
const MAX_ZOOM = MAX_LIVE_MAP_ZOOM

/**
 * The view the block is designed for.
 *
 * At this latitude zoom 20 is about 56 px per metre of ground, so the ten-metre
 * block covers roughly 560 px: still comfortably filling a viewport, and one level
 * past Esri's native 19, which is the closest a view can sit to the imagery without
 * visibly interpolating it.
 *
 * It used to be 22 to make a metre a larger square, but that traded honesty for
 * apparent scale. Twenty-two is four levels past the imagery's native depth, so every
 * frame opened on upscaled imagery — four times magnified, blurry, and reading as a
 * bad map rather than a close one. The block is legible at 20, and an operator who
 * still wants 22 can zoom in; `MAX_ZOOM` is unchanged so that stays possible.
 *
 * `fit` takes over from here once telemetry arrives, but the first frame is already
 * at the mission's scale — arriving at a regional view and then snapping in reads as
 * a bug even when it is intentional.
 */
const INITIAL_ZOOM = 20

/**
 * And the floor.
 *
 * This is a *working* floor, not a limit on how far out the operator may go. It used
 * to be 18, which was a mistake: at 18 the viewport still spans only about 30 m of
 * ground, so "zoom out to see where this block sits in the site" was impossible — an
 * operator who lost the aircraft had no way to widen the search, which is the exact
 * opposite of what the comment here always claimed the low end was for.
 *
 * Fifteen puts roughly 190 m across the pane at this latitude, which is a
 * neighbourhood view: the block is small but findable, and the streets around the
 * site give the position context that the mission view alone cannot. Below that the
 * block is a speck and there is nothing further to learn by going out — the imagery
 * ceiling is the interesting limit, not the ground one.
 *
 * The *legibility* requirement has not moved. It is still `MIN_LIVE_MAP_PX_PER_METRE`
 * = 12, which is what the guard holds the initial view to and what the readout turns
 * amber against. Lowering this constant does not lower that bar; it only stops the
 * floor from being the thing that silently enforces it, which is how "zoom out to see
 * everything" came to be impossible in the first place.
 */
const MIN_ZOOM = 15

/**
 * How far from the survey block the map may be panned, in metres.
 *
 * This number and `MIN_ZOOM` are bound together and must be read together, because
 * getting the relationship wrong is exactly the bug this replaced. Google will not
 * let a restricted map zoom out past the point where the permitted bounds still fill
 * the viewport — so the permitted box quietly becomes a *zoom ceiling*. The old box
 * was eight block-widths, about 160 m, and it capped this pane at zoom 19 no matter
 * what `minZoom` said.
 *
 * The box is therefore sized from the floor zoom, not from the block. At this
 * latitude zoom 15 is about 4.6 m per pixel, so an 850 px pane spans roughly 3.9 km
 * of ground; a 4 km radius gives an 8 km box, comfortably larger than any plausible
 * pane at the floor. That inverts the old relationship: where the box used to be
 * smaller than the viewport, it is now several times larger, so it can never again be
 * what stops the operator zooming out.
 *
 * It is still a real bound — it keeps the map in the district rather than letting a
 * stray drag throw it to another continent — and `Fit` remains the one-click way back
 * to the aircraft. What it is no longer is a limit on how much ground can be seen.
 */
const RESTRICTION_RADIUS_M = 4000

export function LiveMap({
  telemetry,
  progress,
  detections,
  selectedId,
  onSelect,
  onMapClick,
  basemap,
  layers,
  follow,
  refitKey,
  droneOverlay,
  initialView,
  onControls,
  children,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMapClick?: (p: LatLng) => void
  /*
   * Controlled view state. The glass chrome in Mission Control owns these so one set
   * of controls drives both the 2D and the 3D view.
   */
  basemap: Basemap
  layers: LayerState
  follow: FollowMode
  /** Bumped to ask for the framed view back ('fit' is otherwise idempotent). */
  refitKey: number
  droneOverlay: DroneOverlayMeta | null
  /** Where to open, when switching back from 3D; otherwise the block's framing. */
  initialView?: MapViewState | null
  /** Hands the chrome its zoom buttons and a way to read the camera. */
  onControls?: (c: MapControls | null) => void
  /** Rendered inside the map context, above every layer — how the callout and the
   *  live feed reach `useMap()`. */
  children?: ReactNode
}) {
  const [view, setView] = useState<ViewMetrics | null>(null)
  const [legible, setLegible] = useState(true)

  const center = useMemo(
    () => (initialView ? { lat: initialView.lat, lon: initialView.lon } : gridCenter(MISSION.grid)),
    // Read once: the map is created once, and later moves are the operator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /**
   * What the current basemap's imagery actually contains — see `basemapNativeDepth` in basemaps.ts.
   *
   * This is *not* handed to `MapRoot` any more. It used to be, as a `ceilingZoom` prop
   * that clamped the map's maximum zoom, which is how zoom 19 became a wall. The map's
   * limit is `MAX_ZOOM` and no longer varies by basemap.
   *
   * It is still the right number for the two places that ask how deep the *imagery*
   * goes rather than how far the *map* may go: the readiness guard, which declines to
   * re-fit a pane that is already as good as its basemap allows, and the scale readout,
   * which names the real limit beside the configured one. Those are honest questions
   * about the picture; the clamp was not.
   */
  const showDrone = Boolean(droneOverlay) && layers.drone

  // Over the drone photo the imagery is real to the map's own ceiling; otherwise it
  // is the provider's measured depth.
  const imageryDepth = showDrone ? MAX_ZOOM : basemapNativeDepth(basemap)

  /**
   * The area that must stay visible. Covers the grid *and* the flown track, because
   * the track is where the aircraft has actually been and a manual pass can wander
   * outside the block it is meant to be covering.
   *
   * Keyed on `track.length`, not on `track`: the simulator appends in place and
   * returns the same array reference each tick, so an identity dependency would
   * compute this once and then hold panning to the bounds the track had at mount
   * while the aircraft flew somewhere else entirely.
   */
  const trackLength = progress?.track.length ?? 0
  const extent = useMemo(() => {
    const g = gridBounds(MISSION.grid)
    const [[south, west], [north, east]] = g
    const box = { south, west, north, east }

    progress?.track.forEach((p) => {
      box.south = Math.min(box.south, p.lat)
      box.north = Math.max(box.north, p.lat)
      box.west = Math.min(box.west, p.lon)
      box.east = Math.max(box.east, p.lon)
    })

    return box
    // See above: `trackLength` is the observable change, and `progress` is read only
    // for its track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackLength])

  return (
    <div className="relative h-full w-full bg-ink-deep">
      <MapRoot
        center={center}
        zoom={initialView?.zoom ?? INITIAL_ZOOM}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        mapTypeId={basemap}
        // Panning is bounded to the mission area, but it must never bound *zoom*.
        //
        // This is the correction of a measured bug. The pad used to be a multiple of
        // the block — eight block-widths, roughly a 160 m box — and the comment here
        // insisted that it "was never what held the zoom out". That was simply wrong,
        // and it is why the fix was not found earlier: `restriction.latLngBounds` is
        // a zoom constraint as much as a pan constraint, because Google refuses to
        // zoom out past the point where those bounds would fit the viewport. Asking
        // a 824×848 pane for zoom 10 under that box returns 19. Measured, not
        // reasoned.
        //
        // So the bound is now stated in metres and sized from the *floor zoom* rather
        // than from the block: it has to contain what the pane can show at MIN_ZOOM,
        // or the minimum zoom it permits is whatever those bounds happen to afford.
        // See RESTRICTION_RADIUS_M.
        restrictTo={padBoundsM(extent, RESTRICTION_RADIUS_M)}
        onMapClick={onMapClick}
      >
        {showDrone && droneOverlay && <DroneImageryLayer meta={droneOverlay} />}
        {layers.grid && <MissionGridLayer grid={MISSION.grid} />}
        {layers.coverage && progress && (
          <CoverageHatchLayer grid={MISSION.grid} coveredCells={progress.coveredCells} />
        )}

        {/* Flown track, solid — this is what actually happened, and the only path
            there is. The aircraft is flown by hand, so there is no planned route to
            draw against it. */}
        {layers.track && progress && progress.track.length > 1 && (
          <TrackLayer points={progress.track} />
        )}

        {/* The two layers that are on from the start: the hazards, and the aircraft
            that found them. Everything above is reference geometry, off by default
            (see DEFAULT_LAYERS) so these read as objects rather than as texture. */}
        {layers.detections && (
          <DetectionPins detections={detections} selectedId={selectedId} onSelect={onSelect} />
        )}

        {telemetry && <DronePlatform telemetry={telemetry} />}

        <FollowController
          position={telemetry?.position ?? null}
          extent={extent}
          mode={follow}
          refitKey={refitKey}
        />

        <ControlsBridge onControls={onControls} />

        {/* Holds the map to a legible ground scale, and reports it. Both live here
            rather than in the chrome because both need the map instance, and the map
            is only in context inside `MapRoot`. */}
        <ViewReporter
          spanM={VIEW_SPAN_M}
          position={telemetry?.position ?? null}
          extent={extent}
          imageryDepth={imageryDepth}
          onView={setView}
          onLegible={setLegible}
        />

        {children}
      </MapRoot>

      {/* The map's own diagnostics. Every control lives in the shared glass chrome. */}
      <div className="pointer-events-none absolute inset-0 z-[500]">
        {import.meta.env.DEV && view && <ScaleReadout view={view} />}
        {!legible && <ScaleWarning />}
      </div>
    </div>
  )
}

/**
 * Hands the chrome its controls. Render-nothing, inside MapRoot, because it needs
 * the Leaflet instance; the same `MapControls` shape the 3D view provides.
 */
function ControlsBridge({ onControls }: { onControls?: (c: MapControls | null) => void }) {
  const { map } = useMap()
  useEffect(() => {
    if (!onControls) return
    onControls({
      zoomIn: () => map.zoomIn(0.5),
      zoomOut: () => map.zoomOut(0.5),
      flyTo: (lat, lon) => map.panTo([lat, lon], { animate: true, duration: 0.5 }),
      getView: () => {
        const c = map.getCenter()
        return { lat: c.lat, lon: c.lng, zoom: map.getZoom() }
      },
    })
    return () => onControls(null)
  }, [map, onControls])
  return null
}

/**
 * Bridges the follow mode to the map instance — must live inside `MapRoot`.
 *
 * `refitKey` is passed straight through rather than being read from state here: it
 * is a trigger, not a value, so anything that changed the effect's dependency on it
 * would break the one thing it does.
 */
function FollowController({
  position,
  extent,
  mode,
  refitKey,
}: {
  position: LatLng | null
  extent: { south: number; west: number; north: number; east: number }
  mode: FollowMode
  refitKey: number
}) {
  useFollowDrone({ position, extent, mode, forceRefit: refitKey > 0 })
  return null
}

/**
 * Reads the live view back out of the map for the caller to render.
 *
 * A render-nothing component rather than a hook in `LiveMap` itself, because
 * `MapContext` is provided *inside* `MapRoot`: `LiveMap` owns `MapRoot` and so is
 * above the provider, where `useMap` would throw.
 */
function ViewReporter({
  spanM,
  position,
  extent,
  onView,
  onLegible,
  imageryDepth,
}: {
  spanM: number
  position: LatLng | null
  extent: { south: number; west: number; north: number; east: number }
  imageryDepth: number
  onView: (v: ViewMetrics | null) => void
  onLegible: (b: boolean) => void
}) {
  const view = useViewMetrics(spanM, imageryDepth)
  // Holds the map to a legible ground scale, and it is *not* yet known to work.
  // It was thought to be the fix on the strength of one run with it removed, which
  // settled at zoom 20; turning it back on and measuring again reproduced zoom 20
  // immediately, so that run proved nothing and the same reload gives 20 or 22
  // depending on timing. What that non-determinism means is still unresolved, and
  // the readout beside the map is what is being used to find out.
  //
  // Resolved, and the resolution is worth keeping because the earlier note here
  // attributed the whole of it to timing. There were two faults. A fit taken before
  // layout settled really did leave zoom 20 sometimes, which the attempt budget and
  // its resize renewal address. The other was that 20 and 22 were never the same
  // number: the map's limit was being taken from the basemap's *imagery depth*, so on
  // satellite and hybrid the limit *was* 19 while the reachable zoom *was* 22. "20 or
  // 22" read as non-determinism but was two different ceilings, and the map spent its
  // life below the one it could have had. Both numbers are real; only the clamp was
  // wrong. See `basemapNativeDepth` in basemaps.ts.
  //
  // Note the guard takes no ceiling at all now. It asks the map, which is the only
  // thing that knows how far the map may go — the imagery depth was the wrong number
  // for that question and reading it here is what held the view down.
  const legible = useViewReadiness(position, extent)

  useEffect(() => {
    onView(view)
  }, [view, onView])

  useEffect(() => {
    onLegible(legible)
  }, [legible, onLegible])

  return null
}

/**
 * The scale, in the units the requirement is written in.
 *
 * Development only. This is the instrument the zoom bug was diagnosed with, and it
 * is kept because "what is a metre worth on screen right now" is the one question
 * this console cannot afford to guess at: everything else on the screen is drawn at
 * the wrong size if the answer is wrong, and nothing else reports it. Rendered as
 * text rather than an overlay precisely so it can be read out of the page.
 */
function ScaleReadout({ view }: { view: ViewMetrics }) {
  // Below what the pane can afford, *and* below the ceiling that caps the search.
  //
  // The second half is not redundant. On a tall pane the pure arithmetic affords
  // zoom 23 for a ten-metre span, while the map is held at 22 by the console itself,
  // so a bare `affordableZoom > zoom` lights the readout amber at the one moment
  // everything is working — an instrument that cries wolf is worse than no
  // instrument, because it teaches the reader to ignore it. `isBelowAffordableZoom`
  // clamps to what is actually reachable, so amber reports a real shortfall.
  //
  // `view.imageryDepth` is the *imagery's* depth, not the map's limit, and the
  // distinction is why this readout survived a bug that the map itself did not. On
  // raster imagery the picture runs out at 19 while the map may still be driven to
  // 22 by upscaling those 19s — so the same number was simultaneously the honest
  // answer here and a wrong answer at the clamp. `capped` names the real limit,
  // which is a thing the operator is entitled to know; it does not, and must not,
  // stop them going past it.
  const short = isBelowAffordableZoom(view.zoom, view.affordableZoom, view.imageryDepth)
  const capped = view.affordableZoom > view.imageryDepth
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 whitespace-nowrap rounded-md border bg-ink-deep/80 px-2 py-1 font-mono text-[0.625rem] backdrop-blur-sm ${
        short ? 'border-hazard/60 text-hazard-lit' : 'border-white/[0.06] text-paper-faint'
      }`}
    >
      zoom {view.zoom} · {view.width}x{view.height} · {view.binding}-bound ·{' '}
      {view.pixelsPerMetre.toFixed(1)} px/m · block {Math.round(view.spanPx)} px ·{' '}
      holds {view.viewportSpanM} m · affords z{view.affordableZoom}
      {capped ? ` (capped z${view.imageryDepth})` : ''}
    </div>
  )
}

/**
 * Said in the interface, not just the console.
 *
 * If the map cannot reach a legible scale for the block, the operator is reading a
 * view that cannot show what it claims to — sub-metre movement becomes noise. That
 * is worth stating plainly, because the alternative is an operator concluding the
 * aircraft is not moving.
 */
function ScaleWarning() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-hazard/50 bg-ink-deep/85 px-3 py-1.5 text-[0.75rem] text-hazard-lit backdrop-blur">
      Map is below {MIN_LIVE_MAP_PX_PER_METRE} px/m. Check the view is showing the
      survey block
    </div>
  )
}

/**
 * Imagery credit, keyed on the basemap rather than on a build-time token.
 *
 * Required, not decorative. Esri's terms oblige anything drawing their World Imagery
 * to credit Esri and its data providers; OpenStreetMap's oblige attribution for the
 * street canvas. The obligation is on the page as well as the tile, which is why this
 * is rendered explicitly rather than left to Leaflet's attribution control alone —
 * that control is small, dimmed and easy to miss, and on a projected screen it may as
 * well not exist.
 *
 * The `ImageryUnconfigured` notice this replaces is gone with the token that gated it.
 * It existed because the deep-zoom imagery was a build-time secret, so a fresh clone
 * silently served a coarser map. Esri's tiles need no key, so there is no longer a
 * configuration state in which the imagery is quietly worse — the failure mode it
 * reported cannot occur.
 */
export function ImageryAttribution({ basemap }: { basemap: Basemap }) {
  return (
    <div className="flex items-center gap-1 text-[0.625rem] text-paper-faint">
      {basemap === 'roadmap' ? (
        <>
          ©{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            className="pointer-events-auto underline transition-colors hover:text-paper-dim"
          >
            OpenStreetMap
          </a>{' '}
          contributors
        </>
      ) : (
        <>
          Imagery ©{' '}
          <a
            href="https://www.esri.com/"
            target="_blank"
            rel="noreferrer"
            className="pointer-events-auto underline transition-colors hover:text-paper-dim"
          >
            Esri
          </a>
          , Maxar, Earthstar Geographics
        </>
      )}
    </div>
  )
}



/**
 * Grow a bound by a distance in *metres* on every side.
 *
 * The predecessor of this padded by a fraction of the block's own span, which made
 * the permitted area a multiple of the thing being surveyed. That reads naturally
 * but it is the wrong unit: the restriction has to be compared against the viewport,
 * and the viewport is a fixed number of pixels at a given zoom, not a multiple of the
 * block. Stating the pad in metres lets it be reasoned about and sized directly.
 *
 * The bounds are at least the block, even when the radius were somehow smaller, so a
 * future tidy-up of the constant cannot collapse the box onto the block and lock the
 * map. Longitude is scaled by latitude because a degree of longitude is shorter away
 * from the equator, so a naive `+ radius` in degrees would be a skinnier box
 * north-south than east-west.
 */
function padBoundsM(
  b: { south: number; west: number; north: number; east: number },
  radiusM: number,
): { south: number; west: number; north: number; east: number } {
  const latPad = radiusM / M_PER_DEG_LAT
  const midLat = (b.north + b.south) / 2
  const lonPad = radiusM / Math.max(1, mPerDegLon(midLat))
  return {
    south: Math.min(b.south, b.south - latPad),
    north: Math.max(b.north, b.north + latPad),
    west: Math.min(b.west, b.west - lonPad),
    east: Math.max(b.east, b.east + lonPad),
  }
}

