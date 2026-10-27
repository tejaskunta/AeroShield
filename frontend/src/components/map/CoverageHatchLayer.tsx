import { useEffect, useMemo, useRef } from 'react'
import type { MissionGrid } from '@/types'
import { cellBounds, cellId, parseCellId } from '@/lib/geo'
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
 * ── Why this port is not mechanical ──────────────────────────────────────────────
 *
 * Leaflet let the hatch be a real SVG `<pattern>` referenced as a `fill` URL. Maps has
 * no pattern fill at all: a shape can be a solid colour, and that is the whole of it.
 * So the hatch is rebuilt out of the primitives Maps does have:
 *
 *   fill   one `GroundOverlay` per covered cell, carrying a tile that is generated
 *          once on a canvas and cached as a data URL. Every cell is the same ground
 *          size, so stretching the same tile into each one makes the hatch continuous
 *          across cell boundaries and the swath reads as a single field rather than as
 *          a patchwork.
 *   edge   `Polyline` icons along the frontier sides. An icon sequence with a small
 *          perpendicular tick, repeated every 12 px and offset by 6 px for the second
 *          sequence, gives alternating red and white — the stake marking — using the
 *          same technique Google's own dashed-line sample uses.
 *
 * The ground-fixed hatch period deserves a note: Leaflet's hatch was 7 CSS px, so its
 * apparent density changed with zoom. Here the period is fixed in *metres*, which is
 * what a survey hatch should be — the texture then means the same thing at every zoom
 * and matches what the coverage figure in the readout is counting.
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

const HATCH_STROKE = '#3E5060'
const HATCH_ALPHA = 0.5
const HATCH_WIDTH = 1.4

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

/** Tick length in px, measured across the line. */
const TICK = 6
/** Red tick, then a white tick half a period later — the IMAS alternation. */
const TICK_PERIOD = 12

function tickIcon(hex: string): google.maps.Symbol {
  return {
    // A short stroke perpendicular to the path. Maps orients icons along the line,
    // so this needs no rotation arithmetic.
    path: 'M 0,-1 0,1',
    strokeColor: hex,
    strokeOpacity: 1,
    strokeWeight: 2.5,
    scale: TICK,
  }
}

const TICKS_RED = '#D7262F'
const TICKS_WHITE = '#F5F3EF'

// ---------------------------------------------------------------------------

export function CoverageHatchLayer({
  grid,
  coveredCells,
}: {
  grid: MissionGrid
  coveredCells: string[]
}) {
  const { map, maps } = useMap()
  const fillsRef = useRef<google.maps.GroundOverlay[]>([])
  const edgesRef = useRef<google.maps.Polyline[]>([])

  const covered = useMemo(() => new Set(coveredCells), [coveredCells])

  const cells = useMemo(() => {
    return coveredCells
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
  }, [coveredCells, covered, grid])

  // The hatch fill.
  useEffect(() => {
    const tile = hatchTile()
    if (!tile) return

    const fills = cells.map(
      (cell) =>
        new maps.GroundOverlay(tile, cell.bounds, {
          map,
          // The tile is already drawn at final opacity; letting the overlay apply a
          // second one would make a single cell lighter than a run of them.
          opacity: 1,
          clickable: false,
        }),
    )

    fillsRef.current = fills
    return () => {
      fills.forEach((f) => f.setMap(null))
      fillsRef.current = []
    }
  }, [map, maps, cells])

  // The stake edge, drawn only on frontier sides.
  useEffect(() => {
    const edges: google.maps.Polyline[] = []

    cells.forEach((cell) => {
      if (!cell.frontier) return
      frontierSides(covered, cell.col, cell.row, grid).forEach((side) => {
        edges.push(
          new maps.Polyline({
            map,
            path: side.path,
            clickable: false,
            // The ticks are the whole mark; a solid spine underneath them would
            // read as a wall rather than as a marked boundary.
            strokeOpacity: 0,
            icons: [
              { icon: tickIcon(TICKS_RED), offset: '0', repeat: `${TICK_PERIOD}px` },
              {
                icon: tickIcon(TICKS_WHITE),
                offset: `${TICK_PERIOD / 2}px`,
                repeat: `${TICK_PERIOD}px`,
              },
            ],
            zIndex: 30,
          }),
        )
      })
    })

    edgesRef.current = edges
    return () => {
      edges.forEach((e) => e.setMap(null))
      edgesRef.current = []
    }
  }, [map, maps, cells, covered, grid])

  return null
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
): { path: google.maps.LatLngLiteral[] }[] {
  const [[south, west], [north, east]] = cellBounds(grid, col, row)
  const sw = { lat: south, lng: west }
  const se = { lat: south, lng: east }
  const ne = { lat: north, lng: east }
  const nw = { lat: north, lng: west }

  const candidates: { col: number; row: number; path: google.maps.LatLngLiteral[] }[] = [
    { col: col - 1, row, path: [nw, sw] },
    { col: col + 1, row, path: [se, ne] },
    { col, row: row - 1, path: [sw, se] },
    { col, row: row + 1, path: [ne, nw] },
  ]

  return candidates
    .filter(({ col: c, row: r }) => {
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false
      return !covered.has(cellId(c, r))
    })
    .map(({ path }) => ({ path }))
}
