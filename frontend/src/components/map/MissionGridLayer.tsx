import { useEffect, useMemo } from 'react'
import type { MissionGrid } from '@/types'
import { gridBounds } from '@/lib/geo'
import { useMap } from './mapContext'

/**
 * MissionGridLayer — the survey grid, as vector lines.
 *
 * The grid is a reference frame, not data. Its job is to let an operator say "the
 * hazard is in C4" and have everyone else find C4 immediately. That means the lines
 * need to be present at every zoom without ever competing with the things that *are*
 * data — detections and coverage.
 *
 * ── Why lines rather than one rectangle per cell ────────────────────────────────
 *
 * Every internal grid line is shared by the two cells either side of it, so drawing
 * each cell as its own closed rectangle draws each shared edge twice. On a 10x10 grid
 * that is 100 rectangles and 400 edges to express 40 unique segments. The waste is
 * not the real problem: adjacent rectangles stroke the same line twice at 85%
 * opacity, so shared edges render darker than the boundary and the grid appears to
 * have a heavier internal lattice than frame.
 *
 * As lines, every segment has exactly one owner — 11 horizontal and 11 vertical
 * polylines, one per boundary including the far edge, which is why there is one more
 * line than there are rows or columns. Stroke weight is then uniform by construction
 * rather than by tuning opacity, and the whole grid is 22 overlay objects instead of
 * 100, which also makes panning cheaper.
 *
 * ── Why there are no cell labels on the map ──────────────────────────────
 *
 * Cells used to carry an `A1..J10` text marker each. At the working zoom a 1 m cell
 * is roughly 14 px across and a 9 px label does not fit inside it — 100 of them
 * overlap into an illegible smear that reads as map noise and buries the detections
 * it is meant to help locate.
 *
 * The cell reference still matters, so nothing is lost: it appears everywhere it has
 * room — the detection callout, the detection table and the reports all carry the
 * cell id. The map shows geometry; the console shows nomenclature.
 */
export function MissionGridLayer({ grid }: { grid: MissionGrid }) {
  const { map, maps } = useMap()

  /**
   * The grid's lines, in domain coordinates.
   *
   * Boundaries are derived from `gridBounds` rather than from per-cell
   * `cellBounds` calls so that every line shares one origin and one longitude
   * scale. `cellBounds` recomputes metres-per-degree from each cell's own corner,
   * which makes the east edges of cells in different rows differ in the last
   * decimal — enough to leave column lines a hair off true vertical and row lines
   * unevenly long. Starting from the grid's own bounds makes both families exactly
   * axis-aligned.
   */
  const lines = useMemo(() => {
    const [[south, west], [north, east]] = gridBounds(grid)
    const out: google.maps.LatLngLiteral[][] = []

    // Row boundaries: `rows + 1` horizontal lines, south to north.
    for (let row = 0; row <= grid.rows; row++) {
      const lat = south + ((north - south) * row) / grid.rows
      out.push([
        { lat, lng: west },
        { lat, lng: east },
      ])
    }

    // Column boundaries: `cols + 1` vertical lines, west to east.
    for (let col = 0; col <= grid.cols; col++) {
      const lng = west + ((east - west) * col) / grid.cols
      out.push([
        { lat: south, lng },
        { lat: north, lng },
      ])
    }

    return out
  }, [grid])

  useEffect(() => {
    const polylines = lines.map(
      (path) =>
        new maps.Polyline({
          map,
          path,
          strokeColor: '#2C3A47',
          strokeWeight: 1,
          strokeOpacity: 0.85,
          // A reference grid should never intercept a click meant for a pin.
          clickable: false,
          // Above the coverage fill, below the pins: a cell boundary is a reading
          // aid, and a detection marker must always win the z-order fight.
          zIndex: 10,
        }),
    )

    return () => {
      polylines.forEach((line) => line.setMap(null))
    }
  }, [map, maps, lines])

  return null
}
