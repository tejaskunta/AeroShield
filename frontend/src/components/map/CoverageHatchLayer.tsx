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

  /**
   * Live overlays, keyed by the thing they represent rather than by array position.
   *
   * The whole point of this layer's shape: coverage only ever grows, so on a tick
   * almost every cell is one we already drew. Diffing by key means a tick costs one
   * `GroundOverlay` for the cell just imaged, instead of a hundred.
   */
  const fillsRef = useRef(new Map<string, google.maps.GroundOverlay>())
  const edgesRef = useRef(new Map<string, google.maps.Polyline>())

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
      fills.forEach((f) => f.setMap(null))
      fills.clear()
      return
    }

    const wanted = new Set(cells.map((c) => c.id))

    // Anything no longer covered. In a forward-only survey this is empty, but a
    // mission reset would otherwise leave stale hatch painted on the ground.
    fills.forEach((overlay, id) => {
      if (!wanted.has(id)) {
        overlay.setMap(null)
        fills.delete(id)
      }
    })

    cells.forEach((cell) => {
      if (fills.has(cell.id)) return
      fills.set(
        cell.id,
        new maps.GroundOverlay(tile, cell.bounds, {
          map,
          // The tile is already drawn at final opacity; letting the overlay apply a
          // second one would make a single cell lighter than a run of them.
          opacity: 1,
          clickable: false,
        }),
      )
    })
  }, [map, maps, cells])

  // Tear down only on unmount or a map swap — not on every coverage change.
  useEffect(() => {
    const fills = fillsRef.current
    const edges = edgesRef.current
    return () => {
      fills.forEach((f) => f.setMap(null))
      fills.clear()
      edges.forEach((e) => e.setMap(null))
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

        edges.set(
          id,
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

    // Retire sides that are no longer frontier. This is the part that keeps the
    // marking honest: without it, ticks staked earlier in the flight would remain
    // drawn across ground that has since been surveyed, so the map would keep
    // claiming an edge that no longer exists.
    edges.forEach((line, id) => {
      if (!wanted.has(id)) {
        line.setMap(null)
        edges.delete(id)
      }
    })
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
): { side: string; path: google.maps.LatLngLiteral[] }[] {
  const [[south, west], [north, east]] = cellBounds(grid, col, row)
  const sw = { lat: south, lng: west }
  const se = { lat: south, lng: east }
  const ne = { lat: north, lng: east }
  const nw = { lat: north, lng: west }

  const candidates: {
    side: string
    col: number
    row: number
    path: google.maps.LatLngLiteral[]
  }[] = [
    { side: 'w', col: col - 1, row, path: [nw, sw] },
    { side: 'e', col: col + 1, row, path: [se, ne] },
    { side: 's', col, row: row - 1, path: [sw, se] },
    { side: 'n', col, row: row + 1, path: [ne, nw] },
  ]

  return candidates
    .filter(({ col: c, row: r }) => {
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false
      return !covered.has(cellId(c, r))
    })
    .map(({ side, path }) => ({ side, path }))
}
