import { useEffect, useRef } from 'react'
import type { Detection } from '@/types'
import { RISK_HEX, riskOf } from '@/lib/risk'
import { detectionSymbol } from './markerGlyphs'
import { useMap } from './mapContext'
import { useZoomScale } from './useMapHooks'

/**
 * DetectionPins — hazards on the map.
 *
 * Two things distinguish these from generic map markers. First, the pin shape
 * encodes review state: a confirmed hazard is a filled diamond, an unverified one a
 * hollow ring, cleared ground a small dot — so state reads at a glance without colour
 * alone carrying the load (colour-blind operators exist, and this is a safety tool).
 * Second, each pin carries a faint ring at its *position-error radius*: the detection
 * is not a point, it is an area, and drawing it as a point would invite someone to
 * walk to the centre of it.
 *
 * ── Port note ────────────────────────────────────────────────────────────────────
 *
 * Leaflet markers were `divIcon` HTML, so the pin shape was CSS and the selected
 * pin's ripple was a CSS animation. Maps markers are either a raster image or a
 * vector `Symbol`, and a Symbol is the better fit here: the geometry is real, so it
 * scales cleanly and anchors on the true centre rather than wherever the box model
 * landed.
 *
 * What the port genuinely loses is the ripple. A Maps marker has no DOM to animate,
 * so selection is now signalled by a size bump (`pinSize`) and a z-order lift. It
 * reads clearly but is a step down from a rippling ring. Restoring it means a DOM
 * overlay per detection — a real cost for one transient effect, so it is noted rather
 * than quietly dropped.
 */
export function DetectionPins({
  detections,
  selectedId,
  onSelect,
}: {
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { map, maps } = useMap()
  const scale = useZoomScale()

  // Keeps the click handler current without re-creating every marker on each render.
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

  /**
   * A signature of everything a pin's appearance depends on.
   *
   * The simulator hands out a fresh `detections` array on every tick, so keying the
   * effect on that array would tear down and rebuild all fourteen markers twice a
   * second — for a list that changes only when a detection arrives or is reviewed.
   * This string changes exactly when a pin would actually look different: a new id,
   * a moved position, a different risk level, or a new review state.
   *
   * `positionErrorM` is included because it sizes the ring; `lat`/`lon` because a
   * detection is relocated as its track firms up. Everything else on the record is
   * irrelevant to what gets drawn.
   */
  const signature = detections
    .map(
      (d) =>
        `${d.id}:${d.position.lat.toFixed(6)},${d.position.lon.toFixed(6)}:${
          d.positionErrorM
        }:${riskOf(d)}:${d.review.state}`,
    )
    .join('|')

  useEffect(() => {
    const markers: google.maps.Marker[] = []
    const rings: google.maps.Circle[] = []

    detections.forEach((d) => {
      const level = riskOf(d)
      const selected = d.id === selectedId

      // The position-error ring. Not decoration — it is the difference between
      // "there is a hazard here" and "there is a hazard within this area".
      if (level !== 'cleared') {
        rings.push(
          new maps.Circle({
            map,
            center: { lat: d.position.lat, lng: d.position.lon },
            radius: d.positionErrorM,
            strokeColor: RISK_HEX[level],
            strokeWeight: 1,
            strokeOpacity: selected ? 0.7 : 0.3,
            fillColor: RISK_HEX[level],
            fillOpacity: selected ? 0.12 : 0.05,
            clickable: false,
            zIndex: 100,
          }),
        )
      }

      const marker = new maps.Marker({
        map,
        position: { lat: d.position.lat, lng: d.position.lon },
        icon: detectionSymbol(level, d.review.state, selected, scale),
        zIndex: selected ? 800 : level === 'hazard' ? 600 : 400,
        title: `${d.id} — ${level} — cell ${d.gridCell}`,
        clickable: true,
      })

      marker.addListener('click', () => {
        selectRef.current(selectedRef.current === d.id ? null : d.id)
      })

      markers.push(marker)
    })

    return () => {
      // `clearInstanceListeners` matters here: the map outlives these markers, so
      // listeners left attached to a discarded marker keep it (and its closure over
      // the detections array) alive for the life of the page.
      markers.forEach((m) => {
        google.maps.event.clearInstanceListeners(m)
        m.setMap(null)
      })
      rings.forEach((r) => r.setMap(null))
    }
    // Rebuilding is still deliberate — a pin's entire appearance derives from its
    // selection, so patching in place would mean re-deriving the same arguments.
    // What changed is *when*: on the signature rather than on array identity, so a
    // telemetry tick no longer counts as a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maps, signature, selectedId, scale])

  return null
}