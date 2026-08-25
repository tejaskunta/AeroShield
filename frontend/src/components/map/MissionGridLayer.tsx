import { Rectangle, Tooltip } from 'react-leaflet'
import type { MissionGrid } from '@/types'
import { cellBounds, cellId } from '@/lib/geo'

/**
 * MissionGridLayer — the survey grid, with cell references.
 *
 * This is not decoration: `C4` is how a cell gets named on paper and over radio,
 * so the label on the map and the label in the detection record are the same
 * string. Cell outlines are hairline and unfilled — the grid is a reference frame,
 * and anything heavier would compete with the coverage hatch drawn on top of it.
 */
export function MissionGridLayer({ grid }: { grid: MissionGrid }) {
  const cells = []
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      cells.push({ col, row, id: cellId(col, row) })
    }
  }

  return (
    <>
      {cells.map(({ col, row, id }) => (
        <Rectangle
          key={id}
          bounds={cellBounds(grid, col, row)}
          pathOptions={{
            color: '#2C3A47',
            weight: 1,
            opacity: 0.85,
            fill: false,
            // A reference grid should never intercept a click meant for a pin.
            interactive: false,
          }}
        >
          <Tooltip direction="center" permanent className="!border-0 !bg-transparent">
            <span className="font-mono text-[9px] tracking-[0.1em] text-paper-faint">{id}</span>
          </Tooltip>
        </Rectangle>
      ))}
    </>
  )
}
