import { useEffect, useMemo } from 'react'
import { Polygon, useMap } from 'react-leaflet'
import type { MissionGrid } from '@/types'
import { cellBounds, cellId, parseCellId } from '@/lib/geo'

/**
 * CoverageHatchLayer — the signature element.
 *
 * As the drone flies its grid, the imaged swath fills in with a fine 45° survey
 * hatch, and the boundary between covered and uncovered ground is drawn with
 * alternating red/white stake ticks — the IMAS marking convention (red on the
 * hazard side, white on the cleared side) rendered as a map layer.
 *
 * This is the one piece of the map that isn't showing a measurement. It answers a
 * question an operator genuinely has and no readout can express: *what have we
 * actually looked at?* Coverage is the discipline of demining — every square metre
 * is accounted for — so it gets the map's most distinctive treatment.
 *
 * Leaflet has no hatch fill, so the pattern is injected once as an SVG <pattern>
 * into the overlay pane's defs and referenced by fill URL.
 */

const PATTERN_ID = 'aeroshield-survey-hatch'
const EDGE_PATTERN_ID = 'aeroshield-stake-edge'

export function CoverageHatchLayer({
  grid,
  coveredCells,
}: {
  grid: MissionGrid
  coveredCells: string[]
}) {
  useSvgPatterns()

  const covered = useMemo(() => new Set(coveredCells), [coveredCells])

  const polygons = useMemo(() => {
    return coveredCells
      .map((id) => {
        const parsed = parseCellId(id)
        if (!parsed) return null
        const [[swLat, swLon], [neLat, neLon]] = cellBounds(grid, parsed.col, parsed.row)
        return {
          id,
          ring: [
            [swLat, swLon],
            [swLat, neLon],
            [neLat, neLon],
            [neLat, swLon],
          ] as [number, number][],
          /** Whether this cell borders unsurveyed ground — those get stake ticks. */
          frontier: isOnFrontier(covered, parsed.col, parsed.row, grid),
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
  }, [coveredCells, covered, grid])

  return (
    <>
      {polygons.map(({ id, ring, frontier }) => (
        <Polygon
          key={id}
          positions={ring}
          pathOptions={{
            // The hatch itself. `fillColor` is overridden by the pattern URL, which
            // Leaflet passes straight through to the SVG path's fill attribute.
            fillColor: `url(#${PATTERN_ID})`,
            fillOpacity: 1,
            // Interior cell edges get no stroke; only the frontier is marked.
            color: frontier ? `url(#${EDGE_PATTERN_ID})` : 'transparent',
            weight: frontier ? 2.5 : 0,
            opacity: 1,
            interactive: false,
          }}
        />
      ))}
    </>
  )
}

/** True when this cell touches uncovered ground — i.e. it is on the survey frontier. */
function isOnFrontier(
  covered: Set<string>,
  col: number,
  row: number,
  grid: MissionGrid,
): boolean {
  const neighbours: Array<[number, number]> = [
    [col + 1, row],
    [col - 1, row],
    [col, row + 1],
    [col, row - 1],
  ]
  return neighbours.some(([c, r]) => {
    // The grid boundary is not a frontier — beyond it isn't "uncovered", it's
    // outside the mission. Only interior gaps count.
    if (c === undefined || r === undefined) return false
    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false
    return !covered.has(cellId(c, r))
  })
}

/**
 * Inject the hatch and stake-edge patterns into the map's SVG defs, once.
 *
 * Leaflet renders vector overlays into a single <svg> in the overlay pane, so the
 * patterns must live in that document to be referenceable by `url(#id)`.
 */
function useSvgPatterns() {
  const map = useMap()

  useEffect(() => {
    const pane = map.getPane('overlayPane')
    if (!pane) return

    // The <svg> is created lazily by Leaflet's SVG renderer; wait for it.
    const install = () => {
      const svg = pane.querySelector('svg')
      if (!svg) return false
      if (svg.querySelector(`#${PATTERN_ID}`)) return true

      const NS = 'http://www.w3.org/2000/svg'
      let defs = svg.querySelector('defs')
      if (!defs) {
        defs = document.createElementNS(NS, 'defs')
        svg.insertBefore(defs, svg.firstChild)
      }

      // 45° survey hatch — fine enough to read as texture, not as stripes.
      const hatch = document.createElementNS(NS, 'pattern')
      hatch.setAttribute('id', PATTERN_ID)
      hatch.setAttribute('patternUnits', 'userSpaceOnUse')
      hatch.setAttribute('width', '7')
      hatch.setAttribute('height', '7')
      hatch.setAttribute('patternTransform', 'rotate(45)')
      const line = document.createElementNS(NS, 'line')
      line.setAttribute('x1', '0')
      line.setAttribute('y1', '0')
      line.setAttribute('x2', '0')
      line.setAttribute('y2', '7')
      line.setAttribute('stroke', '#3E5060')
      line.setAttribute('stroke-width', '1.4')
      line.setAttribute('opacity', '0.5')
      hatch.appendChild(line)
      defs.appendChild(hatch)

      // Stake edge: alternating red and white segments, per IMAS marking.
      const edge = document.createElementNS(NS, 'pattern')
      edge.setAttribute('id', EDGE_PATTERN_ID)
      edge.setAttribute('patternUnits', 'userSpaceOnUse')
      edge.setAttribute('width', '12')
      edge.setAttribute('height', '12')
      const red = document.createElementNS(NS, 'rect')
      red.setAttribute('width', '6')
      red.setAttribute('height', '12')
      red.setAttribute('fill', '#D7262F')
      const white = document.createElementNS(NS, 'rect')
      white.setAttribute('x', '6')
      white.setAttribute('width', '6')
      white.setAttribute('height', '12')
      white.setAttribute('fill', '#F5F3EF')
      edge.appendChild(red)
      edge.appendChild(white)
      defs.appendChild(edge)

      return true
    }

    if (install()) return
    // Retry on the next frame if Leaflet hasn't built the SVG yet.
    const raf = requestAnimationFrame(() => void install())
    return () => cancelAnimationFrame(raf)
  }, [map])
}
