import { Fragment } from 'react'
import { Circle, Marker } from 'react-leaflet'
import L from 'leaflet'
import type { Detection, RiskLevel } from '@/types'
import { RISK_HEX, riskOf } from '@/lib/risk'
import { toTuple } from '@/lib/geo'

/**
 * DetectionPins — hazards on the map.
 *
 * Two things distinguish these from generic map markers. First, the pin shape
 * encodes review state: a confirmed hazard is a filled diamond, an unverified one
 * a hollow ring, cleared ground a small dot — so state reads at a glance without
 * colour alone carrying the load (colour-blind operators exist, and this is a
 * safety tool). Second, each pin carries a faint ring at its *position-error
 * radius*: the detection is not a point, it is an area, and drawing it as a point
 * would invite someone to walk to the centre of it.
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
  return (
    <>
      {detections.map((d) => {
        const level = riskOf(d)
        const selected = d.id === selectedId
        return (
          // Fragment, not a div: react-leaflet children must be map layers, and a
          // real DOM element here would render outside the map panes.
          <Fragment key={d.id}>
            {/* Position-error ring — the hazard is anywhere in here. */}
            {level !== 'cleared' && (
              <Circle
                center={toTuple(d.position)}
                radius={d.positionErrorM}
                pathOptions={{
                  color: RISK_HEX[level],
                  weight: 1,
                  opacity: selected ? 0.7 : 0.3,
                  fillColor: RISK_HEX[level],
                  fillOpacity: selected ? 0.12 : 0.05,
                  interactive: false,
                }}
              />
            )}
            <Marker
              position={toTuple(d.position)}
              icon={pinIcon(level, d.review.state, selected)}
              zIndexOffset={selected ? 800 : level === 'hazard' ? 600 : 400}
              eventHandlers={{
                click: () => onSelect(selected ? null : d.id),
              }}
              keyboard
              title={`${d.id} — ${level} — cell ${d.gridCell}`}
            />
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * Pin as a divIcon. Shape by review state, colour by risk level, plus a one-shot
 * ping ripple on the selected pin (suppressed under reduced motion).
 */
function pinIcon(
  level: RiskLevel,
  reviewState: Detection['review']['state'],
  selected: boolean,
): L.DivIcon {
  const hex = RISK_HEX[level]
  const size = selected ? 26 : 20
  const shape = shapeFor(reviewState, level, hex)
  const ping = selected
    ? `<span class="motion-safe:animate-ping" style="position:absolute;inset:0;border:1.5px solid ${hex};border-radius:${level === 'hazard' ? '2px' : '50%'};"></span>`
    : ''

  return L.divIcon({
    html: `<div style="position:relative;width:${size}px;height:${size}px;display:grid;place-items:center;">
      ${ping}
      ${shape}
    </div>`,
    className: 'aeroshield-pin',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

/**
 * Shape encodes review state independent of colour:
 *   confirmed → filled diamond (a staked, verified hazard)
 *   flagged   → diamond with a dot (needs a second look)
 *   unverified→ hollow ring (a candidate)
 *   cleared   → small solid dot (ruled out)
 */
function shapeFor(
  reviewState: Detection['review']['state'],
  level: RiskLevel,
  hex: string,
): string {
  const stroke = '#0E141A'
  if (level === 'cleared') {
    return `<span style="width:7px;height:7px;border-radius:50%;background:${hex};box-shadow:0 0 0 1px ${stroke};"></span>`
  }
  if (reviewState === 'confirmed') {
    return `<span style="width:12px;height:12px;background:${hex};transform:rotate(45deg);box-shadow:0 0 0 1.5px ${stroke};"></span>`
  }
  if (reviewState === 'flagged') {
    return `<span style="width:14px;height:14px;border:2px solid ${hex};transform:rotate(45deg);box-shadow:0 0 0 1px ${stroke};display:grid;place-items:center;">
      <span style="width:4px;height:4px;background:${hex};transform:rotate(-45deg);"></span></span>`
  }
  // unverified — hollow ring
  return `<span style="width:12px;height:12px;border:2px solid ${hex};border-radius:50%;box-shadow:0 0 0 1px ${stroke};background:rgba(14,20,26,0.5);"></span>`
}
