import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Detection, LatLng, MissionProgress, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { gridBounds, gridCenter } from '@/lib/geo'
import { MapRoot } from './MapRoot'
import { MissionGridLayer } from './MissionGridLayer'
import { CoverageHatchLayer } from './CoverageHatchLayer'
import { DronePlatform } from './DronePlatform'
import { DetectionPins } from './DetectionPins'
import { TrackLayer } from './TrackLayer'
import { LayerToggles, type LayerState, DEFAULT_LAYERS } from './LayerToggles'
import { MapLegend } from './MapLegend'
import { useFollowDrone, type FollowMode } from './useMapHooks'

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
 * rather than a closer one.
 */
const MAX_ZOOM = 22

/**
 * The view the block is designed for: 10 m across a 1200 px map, so one cell of the
 * grid is a comfortable square rather than a smudge.
 *
 * `fit` takes over from here once telemetry arrives, but the first frame is already
 * at the mission's scale — arriving at a regional view and then snapping in reads as
 * a bug even when it is intentional.
 */
const INITIAL_ZOOM = 21

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
        restrictTo={padBounds(extent, 2)}
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
        />

        {children}
      </MapRoot>

      {/* Map chrome, above every overlay the map draws. */}
      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute right-2 top-2 flex flex-col items-end gap-2">
          <BasemapSwitcher value={basemap} onChange={setBasemap} />
          <FollowSwitcher value={follow} onChange={setFollow} />
          <LayerToggles value={layers} onChange={setLayers} />
        </div>
        <div className="pointer-events-auto absolute bottom-6 right-2">
          <MapLegend detections={detections} />
        </div>
      </div>
    </div>
  )
}

/** Bridges the follow mode to the map instance — must live inside `MapRoot`. */
function FollowController({
  position,
  extent,
  mode,
}: {
  position: LatLng | null
  extent: { south: number; west: number; north: number; east: number }
  mode: FollowMode
}) {
  useFollowDrone({ position, extent, mode })
  return null
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