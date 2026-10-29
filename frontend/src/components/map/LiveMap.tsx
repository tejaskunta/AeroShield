import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Detection, LatLng, MissionProgress, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { MAX_LIVE_MAP_ZOOM, MIN_LIVE_MAP_PX_PER_METRE } from '@/lib/config'
import { isBelowAffordableZoom } from '@/lib/scale'
import { gridBounds, gridCenter } from '@/lib/geo'
import { MapRoot } from './MapRoot'
import { MissionGridLayer } from './MissionGridLayer'
import { CoverageHatchLayer } from './CoverageHatchLayer'
import { DronePlatform } from './DronePlatform'
import { DetectionPins } from './DetectionPins'
import { TrackLayer } from './TrackLayer'
import { LayerToggles, type LayerState, DEFAULT_LAYERS } from './LayerToggles'
import { MapLegend } from './MapLegend'
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
 * Basemaps are a `mapTypeId` now rather than a tile-URL swap: `hybrid` is imagery
 * with place labels, `roadmap` is the dark street canvas, `satellite` is imagery
 * alone. Imagery is the default because it is what the drone actually sees; the
 * street canvas is the fallback for when imagery is unavailable or too busy to read
 * hazard colour against.
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
export type Basemap = 'satellite' | 'hybrid' | 'roadmap'

const BASEMAP_LABELS: Record<Basemap, string> = {
  satellite: 'Satellite',
  hybrid: 'Hybrid',
  roadmap: 'Street',
}

/**
 * A metre of ground, in pixels, at the reference zoom.
 *
 * Google's imagery over Hyderabad is native to about zoom 21 — roughly 7 cm per
 * pixel at this latitude. Zoom 22 is the practical ceiling: one step of upsampling,
 * still readable. Past that it is interpolation, which would look like a broken map
 * rather than a closer one. Declared in `lib/config` because the readiness check has
 * to know about the ceiling too — see `MAX_LIVE_MAP_ZOOM`.
 */
const MAX_ZOOM = MAX_LIVE_MAP_ZOOM

/**
 * The view the block is designed for.
 *
 * At this latitude zoom 22 is about 28 px per metre of ground, so the ten-metre
 * block covers roughly 280 px and each one-metre cell is a legible square rather
 * than a smudge. That is the whole point: the aircraft only ever travels metres, and
 * a scale that renders a metre as seven pixels makes a real flight look like a jitter.
 *
 * `fit` takes over from here once telemetry arrives, but the first frame is already
 * at the mission's scale — arriving at a regional view and then snapping in reads as
 * a bug even when it is intentional.
 */
const INITIAL_ZOOM = 22

/**
 * And the floor. Below this the whole block is under 70 px and the metre cells
 * disappear, so it is not a view anyone would choose; but an operator who has panned
 * out and lost the aircraft needs to be able to find their way back, so the map is
 * not locked to the block either.
 */
const MIN_ZOOM = 18

export function LiveMap({
  telemetry,
  progress,
  detections,
  selectedId,
  onSelect,
  onMapClick,
  children,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMapClick?: (p: LatLng) => void
  /** Rendered inside the map context, above every layer — how the callout and the
   *  live feed reach `useMap()`. */
  children?: ReactNode
}) {
  const [basemap, setBasemap] = useState<Basemap>('hybrid')
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS)
  const [follow, setFollow] = useState<FollowMode>('fit')
  /**
   * Bumped by choosing a follow mode again, to ask for the framed view back.
   *
   * 'fit' is deliberately idempotent, so an operator who has panned away has no
   * other way to ask for it — the extent has not changed, so nothing re-fits and the
   * control looks broken. Keyed by an integer rather than a boolean so repeated
   * requests each produce a distinct value.
   */
  const [refitKey, setRefitKey] = useState(0)
  const [view, setView] = useState<ViewMetrics | null>(null)
  const [legible, setLegible] = useState(true)

  const center = useMemo(() => gridCenter(MISSION.grid), [])

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
        zoom={INITIAL_ZOOM}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        mapTypeId={basemap}
        // Panning is bounded to the mission area, but generously. The padding is a
        // *multiple of the block*, so at 10 m across it has to be a large fraction
        // or the allowed area would be smaller than the viewport and the map would
        // simply refuse to move at all.
        //
        // Eight block-widths, not two, for that reason alone. An earlier comment
        // here also credited the pad with capping zoom — that was wrong, and worth
        // recording so it is not re-derived: at zoom 22 this viewport spans roughly
        // 45 m across, so even the old 2x pad (a 50 m box) was already larger than
        // the viewport. The restriction was never what held the zoom out.
        restrictTo={padBounds(extent, 8)}
        onMapClick={onMapClick}
      >
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

        {/* Holds the map to a legible ground scale, and reports it. Both live here
            rather than in the chrome because both need the map instance, and the map
            is only in context inside `MapRoot`. */}
        <ViewReporter
          spanM={VIEW_SPAN_M}
          position={telemetry?.position ?? null}
          extent={extent}
          onView={setView}
          onLegible={setLegible}
        />

        {children}
      </MapRoot>

      {/* Map chrome, above every overlay the map draws. */}
      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute right-2 top-2 flex flex-col items-end gap-2">
          <BasemapSwitcher value={basemap} onChange={setBasemap} />
          <FollowSwitcher
            value={follow}
            onChange={(m) => {
              setFollow(m)
              // Choosing 'fit' again is a request for the framed view back.
              if (m === 'fit') setRefitKey((k) => k + 1)
            }}
          />
          <LayerToggles value={layers} onChange={setLayers} />
        </div>
        <div className="pointer-events-auto absolute bottom-6 right-2">
          <MapLegend detections={detections} />
        </div>
        {import.meta.env.DEV && view && <ScaleReadout view={view} />}
        {!legible && <ScaleWarning />}
      </div>
    </div>
  )
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
}: {
  spanM: number
  position: LatLng | null
  extent: { south: number; west: number; north: number; east: number }
  onView: (v: ViewMetrics | null) => void
  onLegible: (b: boolean) => void
}) {
  const view = useViewMetrics(spanM)
  // Holds the map to a legible ground scale, and it is *not* yet known to work.
  // It was thought to be the fix on the strength of one run with it removed, which
  // settled at zoom 20; turning it back on and measuring again reproduced zoom 20
  // immediately, so that run proved nothing and the same reload gives 20 or 22
  // depending on timing. What that non-determinism means is still unresolved, and
  // the readout beside the map is what is being used to find out.
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
  // zoom 23 for a ten-metre span, while the map is held at 22 by the imagery itself,
  // so a bare `affordableZoom > zoom` lights the readout amber at the one moment
  // everything is working — an instrument that cries wolf is worse than no
  // instrument, because it teaches the reader to ignore it. `isBelowAffordableZoom`
  // clamps to what is actually reachable, so amber reports a real shortfall.
  const short = isBelowAffordableZoom(view.zoom, view.affordableZoom, MAX_LIVE_MAP_ZOOM)
  return (
    <div
      className={`pointer-events-none absolute bottom-6 left-2 border bg-ink-deep/90 px-2 py-1 font-mono text-[10px] backdrop-blur-sm ${
        short ? 'border-hazard text-hazard' : 'border-rule text-paper-dim'
      }`}
    >
      zoom {view.zoom} · {view.width}x{view.height} · {view.binding}-bound ·{' '}
      {view.pixelsPerMetre.toFixed(1)} px/m · block {Math.round(view.spanPx)} px ·{' '}
      holds {view.viewportSpanM} m · affords z{view.affordableZoom}
      {view.affordableZoom > MAX_LIVE_MAP_ZOOM ? ` (capped z${MAX_LIVE_MAP_ZOOM})` : ''}
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
    <div className="pointer-events-none absolute left-2 top-2 border border-hazard bg-ink-deep/90 px-2 py-1 font-mono text-[10px] text-hazard backdrop-blur-sm">
      Map is below {MIN_LIVE_MAP_PX_PER_METRE} px/m — check the view is showing the
      survey block
    </div>
  )
}

/**
 * Basemap switcher. Three states now: imagery with labels, imagery alone, and a
 * street canvas for when imagery is unusable.
 */
function BasemapSwitcher({
  value,
  onChange,
}: {
  value: Basemap
  onChange: (b: Basemap) => void
}) {
  const options: Basemap[] = ['hybrid', 'satellite', 'roadmap']
  return (
    <div
      role="radiogroup"
      aria-label="Basemap"
      className="flex border border-rule bg-ink-deep/90 backdrop-blur-sm"
    >
      {options.map((b) => (
        <button
          key={b}
          type="button"
          role="radio"
          aria-checked={value === b}
          onClick={() => onChange(b)}
          className={`px-2 py-1 font-display text-[10px] uppercase tracking-[0.1em] transition-colors ${
            value === b ? 'bg-ink-hover text-paper' : 'text-paper-faint hover:text-paper-dim'
          }`}
        >
          {BASEMAP_LABELS[b]}
        </button>
      ))}
    </div>
  )
}

/**
 * How the view tracks the aircraft. Three states, and the labels say what each one
 * *does to the map* rather than naming a setting — "Fit" is meaningless, "Fit
 * block + drone" is not.
 */
function FollowSwitcher({
  value,
  onChange,
}: {
  value: FollowMode
  onChange: (m: FollowMode) => void
}) {
  const options: { mode: FollowMode; label: string; title: string }[] = [
    { mode: 'follow', label: 'Follow', title: 'Keep the drone centred as it flies' },
    { mode: 'fit', label: 'Fit', title: 'Keep the drone and the whole survey block in view' },
    { mode: 'manual', label: 'Manual', title: 'Never move the map on its own' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Map tracking"
      className="flex border border-rule bg-ink-deep/90 backdrop-blur-sm"
    >
      {options.map((o) => (
        <button
          key={o.mode}
          type="button"
          role="radio"
          aria-checked={value === o.mode}
          onClick={() => onChange(o.mode)}
          title={o.title}
          className={`px-2 py-1 font-display text-[10px] uppercase tracking-[0.1em] transition-colors ${
            value === o.mode ? 'bg-ink-hover text-paper' : 'text-paper-faint hover:text-paper-dim'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Grow a bound by a fraction of its own span.
 *
 * Used to give the panning restriction some slack around the survey block, so the
 * operator can look at the ground just outside the area the drone is working without
 * the map refusing to move.
 */
function padBounds(
  b: { south: number; west: number; north: number; east: number },
  fraction: number,
): { south: number; west: number; north: number; east: number } {
  const latPad = (b.north - b.south) * fraction
  const lonPad = (b.east - b.west) * fraction
  return {
    south: b.south - latPad,
    north: b.north + latPad,
    west: b.west - lonPad,
    east: b.east + lonPad,
  }
}