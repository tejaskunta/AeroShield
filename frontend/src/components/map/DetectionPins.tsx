import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { Detection } from '@/types'
import { RISK_HEX, riskOf } from '@/lib/risk'
import { detectionIcon } from './markerGlyphs'
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
 * On Google Maps these were vector `Symbol`s, because a Maps marker is either a
 * raster image or a symbol and there is no DOM to speak of — so the pin geometry had
 * to be real path data, and selection had no way to ripple: it was signalled by a
 * size bump and a z-order lift, which read clearly but was a step down.
 *
 * Back on Leaflet the glyph is SVG inside a `divIcon`, which is a real DOM node. The
 * ripple is a CSS animation again and costs one `<span>` on the selected pin only.
 * See `markerGlyphs.ts`.
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
  const { map } = useMap()
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
    const markers: L.Marker[] = []
    const rings: L.Circle[] = []

    detections.forEach((d) => {
      const level = riskOf(d)
      const selected = d.id === selectedId

      // The position-error ring. Not decoration — it is the difference between
      // "there is a hazard here" and "there is a hazard within this area".
      if (level !== 'cleared') {
        rings.push(
          L.circle([d.position.lat, d.position.lon], {
            radius: d.positionErrorM,
            color: RISK_HEX[level],
            weight: 1,
            opacity: selected ? 0.7 : 0.3,
            fillColor: RISK_HEX[level],
            fillOpacity: selected ? 0.12 : 0.05,
            interactive: false,
            // Under the pins: the ring is context, the pin is the thing.
            pane: 'overlayPane',
          }).addTo(map),
        )
      }

      const marker = L.marker([d.position.lat, d.position.lon], {
        icon: detectionIcon(level, d.review.state, selected, scale),
        // Leaflet uses `zIndexOffset` to break ties within the marker pane. The
        // three tiers are kept from the Maps version so the stacking intent
        // survives the port: the selected pin is never buried, a live hazard
        // outranks cleared ground, and everything outranks the track.
        zIndexOffset: selected ? 800 : level === 'hazard' ? 600 : 400,
        title: `${d.id} · ${level} · cell ${d.gridCell}`,
        // Keyboard-reachable, because an operator reviewing a hazard field should
        // not be forced onto a mouse. Leaflet sets `tabindex` from `keyboard`.
        keyboard: true,
        alt: `${d.id}, ${level} hazard, cell ${d.gridCell}`,
      }).addTo(map)

      // `on` rather than `addEventListener`: Leaflet's own listener registry is
      // what `marker.remove()` unwinds, so nothing is left attached to a marker the
      // map has outlived.
      marker.on('click', () => {
        selectRef.current(selectedRef.current === d.id ? null : d.id)
      })

      markers.push(marker)
    })

    return () => {
      markers.forEach((m) => m.remove())
      rings.forEach((r) => r.remove())
    }
    // Rebuilding is still deliberate — a pin's entire appearance derives from its
    // selection, so patching in place would mean re-deriving the same arguments.
    // What changed is *when*: on the signature rather than on array identity, so a
    // telemetry tick no longer counts as a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, signature, selectedId, scale])

  return null
}