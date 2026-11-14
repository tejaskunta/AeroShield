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
 * hatch, and the boundary between surveyed and unsurveyed ground is drawn as a thin
 * hazard-red line — the edge of the ground that has been imaged.
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
 * ── The frontier is a line, not the IMAS stake convention ───────────────────────
 *
 * Earlier revisions drew the demining stake convention literally: short perpendicular
 * strokes repeated every 0.25 m along the frontier, alternating red and white. That is
 * the correct marking on a paper survey diagram, and it was wrong at this map's
 * scale. A coverage cell is one metre — about 28 px at the working zoom — so 0.25 m
 * spacing puts four strokes on an edge and each one is roughly three pixels long. A
 * three-pixel perpendicular stroke is not a stake; it is a speck. Four specks per
 * edge, on every frontier edge, produced a pale near-white haze that read as bright
 * lines radiating out of the aircraft.
 *
 * The decisive argument was not the appearance but the operator's reading of it: the
 * markings were twice reported as a *rendering fault in the imagery* rather than as a
 * marking. Cartography that reads as a bug has failed no matter how correct it is.
 *
 * So the frontier is one stroked `L.polyline` per uncovered side: a thin solid
 * hazard-red line along the edge of surveyed ground. Fewer objects than the ticks by
 * a factor of four, continuous rather than speckled, and unambiguous at any zoom. The
 * red names the hazard side, which is the only part of the convention that carried
 * any meaning at this resolution.
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
// `CONSOLE_HEX.ruleBright` (`#3E5060` = rgb(62, 80, 96)) at 16 % alpha. Written as
// a literal because `CONSOLE_HEX` deliberately carries opaque tokens only, and
// inventing an alpha variant of every palette entry to serve one off-by-default
// layer is a worse trade than this comment. If a second translucent colour is ever
// needed, add a named alpha map to `consoleInk.ts` rather than another literal.
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
// The frontier line
// ---------------------------------------------------------------------------

/** Hazard red, because the frontier is the hazard side of the boundary. */
const FRONTIER_COLOR = HAZARD_HEX

/**
 * Thin and part-see-through.
 *
 * Width is in screen pixels and does not scale with zoom, so this is chosen for the
 * working zoom where the boundary is read. 1.5 px is a crisp line on a 1.75
 * device-pixel-ratio display without becoming a barrier over the imagery; and at 55 %
 * opacity the ground underneath still shows through, which is the point of drawing it
 * on a map rather than beside one.
 */
const FRONTIER_WEIGHT = 1.5
const FRONTIER_OPACITY = 0.55

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
  const edgesRef = useRef(new Map<string, L.Polyline>())

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

  // The frontier line, drawn only on sides bordering unsurveyed ground — reconciled.
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

        const line = frontierLine(side.start, side.end)
        if (line) edges.set(id, line.addTo(map))
      })
    })

    // Retire sides that are no longer frontier. This is the part that keeps the
    // marking honest: without it, a boundary drawn earlier in the flight would
    // remain across ground that has since been surveyed, so the map would keep
    // claiming an edge that no longer exists.
    edges.forEach((line, id) => {
      if (!wanted.has(id)) {
        line.remove()
        edges.delete(id)
      }
    })
  }, [map, cells, covered, grid])

  return null
}

/**
 * The boundary line along one cell edge of surveyed ground.
 *
 * One `L.polyline` rather than the old group of perpendicular ticks. A group is no
 * longer needed because there is nothing to compose — and that also means retiring a
 * frontier side is a `remove()` on a single layer instead of a walk over its ticks.
 *
 * There is no `pane` override. This is a boundary, so it belongs in the vector layer's
 * own ordering above the hatch fills, which is where Leaflet puts it by default.
 */
function frontierLine(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
): L.Polyline | null {
  // A degenerate edge draws nothing, and Leaflet would happily create an empty path
  // for it. Returning null lets the caller skip adding it at all.
  if (start.lat === end.lat && start.lon === end.lon) return null

  return L.polyline(
    [
      [start.lat, start.lon],
      [end.lat, end.lon],
    ],
    {
      color: FRONTIER_COLOR,
      weight: FRONTIER_WEIGHT,
      opacity: FRONTIER_OPACITY,
      interactive: false,
      lineCap: 'round',
      lineJoin: 'round',
    },
  )
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
