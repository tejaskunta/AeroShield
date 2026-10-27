import { useEffect, useMemo, useRef } from 'react'
import type { MissionGrid } from '@/types'
import { cellBounds, cellId } from '@/lib/geo'
import { cellLabelIcon } from './markerGlyphs'
import { useZoomScale } from './useMapHooks'
import { useMap } from './mapContext'

/**
 * MissionGridLayer — the survey grid, with cell references.
 *
 * This is not decoration: `C4` is how a cell gets named on paper and over radio, so
 * the label on the map and the label in the detection record are the same string.
 * Cell outlines are hairline and unfilled — the grid is a reference frame, and
 * anything heavier would compete with the coverage hatch drawn over it.
 *
 * Ported from Leaflet, where each cell was one `<Rectangle>` carrying a `<Tooltip>`
 * child. Maps has no tooltip on a shape, so a cell is now two objects: an unfilled
 * rectangle for the line, and a marker carrying a text label for the reference. They
 * are created and destroyed as one array so the layer appears and disappears as a
 * unit — a partially-drawn grid would be worse than none, because a missing line
 * reads as surveyed ground.
 *
 * Both are built once per mount and never re-created. There can be hundreds of cells,
 * and churning that many overlay objects on every re-render would drop frames mid-pan.
 */
export function MissionGridLayer({ grid }: { grid: MissionGrid }) {
  const { map, maps } = useMap()
  const scale = useZoomScale()

  const cells = useMemo(() => {
    const out: { col: number; row: number; id: string }[] = []
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        out.push({ col, row, id: cellId(col, row) })
      }
    }
    return out
  }, [grid.rows, grid.cols])

  const outlinesRef = useRef<google.maps.Rectangle[]>([])
  const labelsRef = useRef<google.maps.Marker[]>([])

  useEffect(() => {
    const outlines = cells.map(({ col, row }) => {
      // `cellBounds` still speaks Leaflet's [[swLat, swLon], [neLat, neLon]] shape,
      // so the corners are lifted out by name rather than destructured positionally:
      // swapping them would place the rectangle on the far side of the globe without
      // raising an error.
      const [[south, west], [north, east]] = cellBounds(grid, col, row)
      return new maps.Rectangle({
        map,
        bounds: { south, west, north, east },
        strokeColor: '#2C3A47',
        strokeWeight: 1,
        strokeOpacity: 0.85,
        fillOpacity: 0,
        // A reference grid should never intercept a click meant for a pin.
        clickable: false,
        zIndex: 10,
      })
    })

    outlinesRef.current = outlines
    return () => {
      outlines.forEach((o) => o.setMap(null))
      outlinesRef.current = []
    }
  }, [map, maps, grid, cells])

  useEffect(() => {
    const labels = cells.map(({ col, row, id }) => {
      const [[south, west], [north, east]] = cellBounds(grid, col, row)
      return new maps.Marker({
        map,
        position: { lat: (south + north) / 2, lng: (west + east) / 2 },
        label: cellLabelIcon(id),
        clickable: false,
        // Above the hatch, below the pins: a cell reference is a reading aid, and a
        // detection marker must always win the z-order fight.
        zIndex: 20,
      })
    })

    labelsRef.current = labels
    return () => {
      labels.forEach((m) => m.setMap(null))
      labelsRef.current = []
    }
  }, [map, maps, grid, cells])

  // Zoom changes a label's apparent size, not its content, so this adjusts the
  // existing markers rather than rebuilding them.
  useEffect(() => {
    labelsRef.current.forEach((marker) => {
      const label = marker.getLabel()
      if (label && typeof label === 'object' && label.text !== undefined) {
        marker.setLabel({ ...label, text: label.text, fontSize: `${Math.round(9 * scale)}px` })
      }
    })
  }, [scale])

  return null
}
