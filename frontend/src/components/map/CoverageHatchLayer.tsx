import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import type { MissionGrid } from '@/types'
import { cellBounds, cellId, parseCellId } from '@/lib/geo'
import { CONSOLE_HEX, HAZARD_HEX } from '@/lib/consoleInk'
import { useMap } from './mapContext'

/**
 * CoverageHatchLayer — the signature element.
 *
 * As the drone flies its grid, the imaged swath fills in with a fine 45° survey
 * hatch, and the boundary between covered and uncovered ground is drawn with
 * alternating red/white stake ticks — the IMAS marking convention (red on the hazard
 * side, white on the cleared side) rendered as a map layer.
 *
 * This is the one piece of the map that isn't showing a measurement. It answers a
 * question an operator genuinely has and no readout can express: *what have we
 * actually looked at?* Coverage is the discipline of demining — every square metre is
 * accounted for — so it gets the map's most distinctive treatment.
 *
 * ── The fill stays a rasterised tile, and that is deliberate ─────────────────────
 *
 * Leaflet *can* fill a shape with an SVG `<pattern>`, and the original Leaflet layer
 * did. The 45° hatch then had a period of 7 CSS px, so its apparent density changed
 * with every zoom step — the texture was a screen artefact rather than a statement
 * about the ground, and it disagreed with the coverage figure in the readout.
 *
 * The tile here has its period fixed in the tile's own *ground* dimensions, which is
 * what a survey hatch should be: the texture means the same thing at every zoom and
 * matches what the readout is counting. `L.imageOverlay` stretches one tile into each
 * cell, so every cell is the same ground size and the hatch runs continuously across
 * cell boundaries — the swath reads as a single field rather than as a patchwork.
 *
 * ── The stake edge had to change technique, not just API ────────────────────────
 *
 * On Maps the ticks were an icon sequence: a short perpendicular stroke repeated along
 * the path, which the API rotates along the line for you. Leaflet has no icon
 * sequences — it has `dashArray`, and a dash is a gap *along* the line, not a bar
 * *across* it. A dashed polyline would therefore give a dashed boundary, which is a
 * different convention and not the one this layer exists to draw.
 *
 * So the ticks are real geometry: perpendicular segments generated at a fixed spacing
 * in metres, alternating red and white by index. Fixing the spacing in metres rather
 * than in pixels means the stakes stay put on the ground as the operator zooms, which
 * is the same reasoning as the hatch period.
 */

// ---------------------------------------------------------------------------
// The hatch tile
// ---------------------------------------------------------------------------

/**
 * Tile size in px. Chosen as 5 periods, so a covered cell shows five hatch lines —
 * enough to read as texture, few enough not to turn the map into stripes.
 */
const TILE = 99

/**
 * Period along the tile diagonal. A 45° line family tiles seamlessly with period
 * `p` only when the tile size is a whole multiple of `p * sqrt(2)`, which is what
 * these two constants encode. Getting this wrong produces a visible seam at every
 * cell boundary, which is exactly the artefact that would make the swath look
 * hand-drawn.
 */
const DIAGONAL_PERIOD = (TILE / 5) * Math.SQRT2

const HATCH_STROKE = CONSOLE_HEX.ruleBright
const HATCH_ALPHA = 0.5
const HATCH_WIDTH = 1.4

/**
 * The wash under the hatch: surveyed ground reads as *filled* first and hatched
 * second, so the covered area is legible at a glance from any distance without
 * the operator having to resolve the individual hatch lines.
 *
 * It lives inside the tile rather than in a separate `Rectangle` per cell for a
 * reason that matters to this layer's cost: a per-cell fill would double the object
 * count for a decoration that is uniform anyway. A uniform wash is also the one
 * thing that tiles across cell boundaries with no seam at all — which is precisely
 * why the texture around it had to be built so carefully.
 */
const WASH = 'rgba(62, 80, 96, 0.16)'

/**
 * Built lazily and kept for the session. Rasterising a hatch is deterministic and
 * identical for every cell and every mission, so doing it once per page is both
 * cheaper and *more* correct — separate Sid canvases could differ by a fraction of a
 * pixel and the seams would show.
 */
let hatchCached: string | null = null

function hatchTile(): string {
  if (hatchCached) return hatchCached

  const canvas = document.createElement('canvas')
  canvas.width = TILE
  canvas.height = TILE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // No 2D context means no hatch. Returning an empty tile degrades the layer to
    // "coverage not shown", which is honest; throwing here would take out the map.
    hatchCached = ''
    return hatchCached
  }

  ctx.clearRect(0, 0, TILE, TILE)

  // The wash goes down first and covers the whole tile, so it is seamless across
  // cell edges by construction — there is no edge to mismatch on.
  ctx.fillStyle = WASH
  ctx.fillRect(0, 0, TILE, TILE)

  ctx.strokeStyle = HATCH_STROKE
  ctx.globalAlpha = HATCH_ALPHA
  ctx.lineWidth = HATCH_WIDTH
  ctx.lineCap = 'butt'

  // Lines of the family x + y = c, drawn from the top edge to the left edge. `c`
  // runs past 2*TILE so the wrapped copies that make the tile seamless are included.
  for (let c = 0; c <= 2 * TILE; c += DIAGONAL_PERIOD) {
    ctx.beginPath()
    ctx.moveTo(c, 0)
    ctx.lineTo(0, c)
    ctx.stroke()
  }

  hatchCached = canvas.toDataURL('image/png')
  return hatchCached
}

// ---------------------------------------------------------------------------
// The stake edge
// ---------------------------------------------------------------------------

/**
 * Spacing between stake ticks, in metres.
 *
 * Ground-fixed, not pixel-fixed. At the working zoom one metre is roughly 56 px, so
 * 0.25 m puts a tick every 14 px — close to the 12 px the Maps version used, but now
 * arrived at by measuring the ground rather than the screen.
 */
const TICK_SPACING_M = 0.25

/** How far a tick reaches to either side of the boundary, in metres. */
const TICK_HALF_M = 0.06

/** Metres per degree of latitude. Mirrors `geo.ts` without the import. */
const M_PER_DEG_LAT = 111320

const TICKS_RED = HAZARD_HEX
const TICKS_WHITE = CONSOLE_HEX.tickWhite

// ---------------------------------------------------------------------------

export function CoverageHatchLayer({
  grid,
  coveredCells,
}: {
  grid: MissionGrid
  coveredCells: string[]
}) {
  const { map } = useMap()

  /**
   * Live overlays, keyed by the thing they represent rather than by array position.
   *
   * The whole point of this layer's shape: coverage only ever grows, so on a tick
   * almost every cell is one we already drew. Diffing by key means a tick costs one
   * `GroundOverlay` for the cell just imaged, instead of a hundred.
   */
  const fillsRef = useRef(new Map<string, L.ImageOverlay>())
  const edgesRef = useRef(new Map<string, L.LayerGroup>())

  /**
   * Cell geometry, memoised on the *content* of the coverage list.
   *
   * The simulator hands us a fresh array every tick (`coveredCells: [...]`), so
   * depending on `coveredCells` by identity would rebuild this on every single tick
   * for an unchanged result. Joining the ids gives a primitive that only changes
   * when the surveyed set actually changes — which is roughly once per several
   * ticks as the aircraft crosses cell boundaries.
   */
  const key = useMemo(() => [...coveredCells].sort().join('|'), [coveredCells])

  const covered = useMemo(() => new Set(key ? key.split('|') : []), [key])

  const cells = useMemo(() => {
    return (key ? key.split('|') : [])
      .map((id) => {
        const parsed = parseCellId(id)
        if (!parsed) return null
        const [[south, west], [north, east]] = cellBounds(grid, parsed.col, parsed.row)
        return {
          id,
          col: parsed.col,
          row: parsed.row,
          bounds: { south, west, north, east },
          /** Cell borders unsurveyed ground, so it carries stake ticks. */
          frontier: isOnFrontier(covered, parsed.col, parsed.row, grid),
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
    // `key` is the identity of `covered` in every way that matters here.
  }, [key, covered, grid])

  // The hatch fill — reconciled, not rebuilt.
  useEffect(() => {
    const tile = hatchTile()
    const fills = fillsRef.current

    if (!tile) {
      // No 2D context: degrade to "coverage not shown" rather than throwing.
      fills.forEach((f) => f.remove())
      fills.clear()
      return
    }

    const wanted = new Set(cells.map((c) => c.id))

    // Anything no longer covered. In a forward-only survey this is empty, but a
    // mission reset would otherwise leave stale hatch painted on the ground.
    fills.forEach((overlay, id) => {
      if (!wanted.has(id)) {
        overlay.remove()
        fills.delete(id)
      }
    })

    cells.forEach((cell) => {
      if (fills.has(cell.id)) return
      const bounds = L.latLngBounds(
        [cell.bounds.south, cell.bounds.west],
        [cell.bounds.north, cell.bounds.east],
      )
      fills.set(
        cell.id,
        L.imageOverlay(tile, bounds, {
          // The tile is already drawn at final opacity; letting the overlay apply a
          // second one would make a single cell lighter than a run of them.
          opacity: 1,
          interactive: false,
        }).addTo(map),
      )
    })
  }, [map, cells])

  // Tear down only on unmount or a map swap — not on every coverage change.
  useEffect(() => {
    const fills = fillsRef.current
    const edges = edgesRef.current
    return () => {
      fills.forEach((f) => f.remove())
      fills.clear()
      edges.forEach((e) => e.remove())
      edges.clear()
    }
  }, [map])

  // The stake edge, drawn only on frontier sides — also reconciled.
  useEffect(() => {
    const edges = edgesRef.current
    const wanted = new Set<string>()

    cells.forEach((cell) => {
      if (!cell.frontier) return
      frontierSides(covered, cell.col, cell.row, grid).forEach((side) => {
        // The frontier moves as cells fill in: a side staked last tick may be
        // interior now, so the key has to name the side itself, not its position
        // in the filtered list — position 0 is west on one tick and south on the
        // next, which would silently leave the wrong stake on the ground.
        const id = `${cell.id}:${side.side}`
        wanted.add(id)
        if (edges.has(id)) return

        edges.set(id, stakeGroup(side.start, side.end).addTo(map))
      })
    })

    // Retire sides that are no longer frontier. This is the part that keeps the
    // marking honest: without it, ticks staked earlier in the flight would remain
    // drawn across ground that has since been surveyed, so the map would keep
    // claiming an edge that no longer exists.
    edges.forEach((group, id) => {
      if (!wanted.has(id)) {
        group.remove()
        edges.delete(id)
      }
    })
  }, [map, cells, covered, grid])

  return null
}

/**
 * The alternating red/white stake ticks along one cell edge.
 *
 * Built as one `LayerGroup` so a frontier side can be added and removed as a unit —
 * retiring it is then a single call rather than a bookkeeping pass over its ticks.
 *
 * The ticks are perpendicular segments offset from the edge, alternating colour by
 * index. This replaces the Maps icon-sequence technique; see the header for why a
 * `dashArray` could not stand in for it.
 */
function stakeGroup(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
): L.LayerGroup {
  const group = L.layerGroup()

  // Work in metres so the spacing is ground-fixed. A cell edge is ~1 m, so a flat
  // approximation is exact for this purpose.
  const dLat = end.lat - start.lat
  const dLon = end.lon - start.lon
  const lengthDeg = Math.hypot(dLat, dLon)
  if (!Number.isFinite(lengthDeg) || lengthDeg === 0) return group

  // Unit vector along the edge, in degrees, and its perpendicular.
  const alongLat = dLat / lengthDeg
  const alongLon = dLon / lengthDeg
  const perpLat = -alongLon
  const perpLon = alongLat

  // One degree of longitude is shorter than one of latitude away from the equator,
  // so the perpendicular has to be rescaled before it is used as a metre length or
  // the ticks would lean. Derived from the cell's own latitude to keep it local.
  const latRad = ((start.lat + end.lat) / 2) * (Math.PI / 180)
  const lonScale = Math.max(1e-9, Math.cos(latRad))

  const stepDeg = TICK_SPACING_M / M_PER_DEG_LAT
  const count = Math.max(1, Math.round(lengthDeg / stepDeg))

  for (let i = 0; i < count; i++) {
    // Centred on the segment, so the ticks sit symmetric about the cell corner
    // rather than piling up against one end of it.
    const t = (i + 0.5) / count
    const midLat = start.lat + dLat * t
    const midLon = start.lon + dLon * t

    const halfLat = perpLat * TICK_HALF_M
    const halfLon = (perpLon * TICK_HALF_M) / lonScale

    L.polyline(
      [
        [midLat - halfLat, midLon - halfLon],
        [midLat + halfLat, midLon + halfLon],
      ],
      {
        color: i % 2 === 0 ? TICKS_RED : TICKS_WHITE,
        weight: 2.5,
        opacity: 1,
        interactive: false,
        lineCap: 'butt',
        pane: 'overlayPane',
      },
    ).addTo(group)
  }

  return group
}

/** True when this cell touches uncovered ground — i.e. it is on the survey frontier. */
function isOnFrontier(
  covered: Set<string>,
  col: number,
  row: number,
  grid: MissionGrid,
): boolean {
  return frontierSides(covered, col, row, grid).length > 0
}

/**
 * The sides of a covered cell that border unsurveyed ground *inside the grid*.
 *
 * The grid boundary is deliberately not a frontier: beyond it isn't "uncovered", it's
 * outside the mission. Marking it would stake a line that means nothing on the ground
 * and would make every finished survey look half-finished.
 */
function frontierSides(
  covered: Set<string>,
  col: number,
  row: number,
  grid: MissionGrid,
): {
  side: string
  start: { lat: number; lon: number }
  end: { lat: number; lon: number }
}[] {
  const [[south, west], [north, east]] = cellBounds(grid, col, row)
  const sw = { lat: south, lon: west }
  const se = { lat: south, lon: east }
  const ne = { lat: north, lon: east }
  const nw = { lat: north, lon: west }

  const candidates: {
    side: string
    col: number
    row: number
    start: { lat: number; lon: number }
    end: { lat: number; lon: number }
  }[] = [
    { side: 'w', col: col - 1, row, start: nw, end: sw },
    { side: 'e', col: col + 1, row, start: se, end: ne },
    { side: 's', col, row: row - 1, start: sw, end: se },
    { side: 'n', col, row: row + 1, start: ne, end: nw },
  ]

  return candidates
    .filter(({ col: c, row: r }) => {
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false
      return !covered.has(cellId(c, r))
    })
    .map(({ side, start, end }) => ({ side, start, end }))
}
