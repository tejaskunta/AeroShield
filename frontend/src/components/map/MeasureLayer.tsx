import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { CONSOLE_HEX } from '@/lib/consoleInk'
import { distanceM } from '@/lib/geo'
import { useMap } from './mapContext'

/**
 * Click-to-measure on the 2D map: each click adds a point; the line and each
 * segment's length are drawn, with the running total in a chip. Double-click or
 * Esc finishes; the measurement stays until the tool is closed.
 *
 * For the questions an operator actually asks on a survey block — how far is this
 * pin from that one, how wide is that strip — answered in metres, not guessed from
 * the grid.
 */
/** Centimetres matter on a ten-metre block; lib/geo's formatDistance rounds to metres. */
export function fmtM(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`
  if (m < 100) return `${m.toFixed(2)} m`
  return `${m.toFixed(0)} m`
}

export function MeasureLayer({ onTotal }: { onTotal: (m: number, points: number) => void }) {
  const { map } = useMap()
  const [pts, setPts] = useState<L.LatLng[]>([])
  const group = useRef<L.LayerGroup | null>(null)
  const done = useRef(false)

  useEffect(() => {
    const g = L.layerGroup().addTo(map)
    group.current = g
    map.doubleClickZoom.disable()
    map.getContainer().style.cursor = 'crosshair'
    const click = (e: L.LeafletMouseEvent) => {
      if (done.current) {
        done.current = false
        setPts([e.latlng])
        return
      }
      setPts((p) => [...p, e.latlng])
    }
    const dbl = () => {
      done.current = true
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done.current = true
    }
    map.on('click', click)
    map.on('dblclick', dbl)
    window.addEventListener('keydown', key)
    return () => {
      map.off('click', click)
      map.off('dblclick', dbl)
      window.removeEventListener('keydown', key)
      map.doubleClickZoom.enable()
      map.getContainer().style.cursor = ''
      g.remove()
      group.current = null
    }
  }, [map])

  useEffect(() => {
    const g = group.current
    if (!g) return
    g.clearLayers()
    let total = 0
    if (pts.length > 1) {
      L.polyline(pts, { color: CONSOLE_HEX.paper, weight: 2, dashArray: '6 4', interactive: false }).addTo(g)
    }
    pts.forEach((p, i) => {
      L.circleMarker(p, { radius: 4, color: CONSOLE_HEX.ink, weight: 2, fillColor: CONSOLE_HEX.paper, fillOpacity: 1, interactive: false }).addTo(g)
      if (i > 0) {
        const a = pts[i - 1]!
        const d = distanceM({ lat: a.lat, lon: a.lng }, { lat: p.lat, lon: p.lng })
        total += d
        const mid = L.latLng((a.lat + p.lat) / 2, (a.lng + p.lng) / 2)
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({ className: 'aeroshield-measure-label', html: `<span>${fmtM(d)}</span>`, iconSize: [0, 0] }),
        }).addTo(g)
      }
    })
    onTotal(total, pts.length)
  }, [pts, onTotal])

  return null
}
