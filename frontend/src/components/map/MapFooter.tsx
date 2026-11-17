import { useEffect, useState } from 'react'
import { formatLatLng, metresPerPixelAt } from './mapFooterMath'
import { useMap } from './mapContext'

/**
 * Bottom-left map footer: a scale bar and the cursor's coordinates.
 *
 * The scale bar is the one thing on screen that says how big a hazard or a gap
 * actually is, so it is always drawn; its length snaps to a round distance
 * (1, 2, 5, 10 ... m). Cursor coordinates are what an operator reads out over the
 * radio, in the same format as the detection card.
 */
const NICE = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]

export function MapFooter({ extra }: { extra?: React.ReactNode }) {
  const { map } = useMap()
  const [scale, setScale] = useState<{ px: number; m: number } | null>(null)
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null)

  useEffect(() => {
    const update = () => {
      const mpp = metresPerPixelAt(map.getCenter().lat, map.getZoom())
      const maxM = mpp * 110
      const m = [...NICE].reverse().find((n) => n <= maxM) ?? NICE[0]!
      setScale({ px: m / mpp, m })
    }
    const move = (e: L.LeafletMouseEvent) => setCursor({ lat: e.latlng.lat, lon: e.latlng.lng })
    const out = () => setCursor(null)
    update()
    map.on('zoomend moveend resize', update)
    map.on('mousemove', move)
    map.on('mouseout', out)
    return () => {
      map.off('zoomend moveend resize', update)
      map.off('mousemove', move)
      map.off('mouseout', out)
    }
  }, [map])

  return (
    <div className="pointer-events-none absolute bottom-[4px] left-3 z-[600] flex items-center gap-3 font-mono text-[0.625rem] text-paper-dim">
      {scale && (
        <span className="flex items-center gap-1.5">
          <span
            className="block h-[5px] border-x border-b border-paper/80"
            style={{ width: Math.round(scale.px) }}
            aria-hidden
          />
          <span>{scale.m < 1 ? `${scale.m * 100} cm` : `${scale.m} m`}</span>
        </span>
      )}
      <span className="tabular-nums text-paper-faint">{cursor ? formatLatLng({ lat: cursor.lat, lon: cursor.lon }) : ' '}</span>
      {extra}
    </div>
  )
}
