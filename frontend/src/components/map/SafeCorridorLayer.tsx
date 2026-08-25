import { CircleMarker, Polyline, Tooltip } from 'react-leaflet'
import type { LatLng, PathPlan } from '@/types'
import { RISK_HEX } from '@/lib/risk'
import { toTuple } from '@/lib/geo'

/**
 * SafeCorridorLayer — the planned route through the hazard field.
 *
 * The corridor is drawn as a solid spine with the required-clearance width shown
 * as a translucent casing, so the route reads as a *lane* with margin, not a
 * hairline an operator might try to toe. Waypoints are numbered and the endpoints
 * labelled START / GOAL, matching the planner panel's list exactly — the map and
 * the panel describe one route in one vocabulary.
 */
export function SafeCorridorLayer({
  plan,
  endpoints,
}: {
  plan: PathPlan | null
  endpoints: { from: LatLng | null; to: LatLng | null }
}) {
  // Endpoints are shown even before a route is computed, so the operator can see
  // what they've picked.
  return (
    <>
      {endpoints.from && (
        <EndpointMarker position={endpoints.from} label="START" />
      )}
      {endpoints.to && <EndpointMarker position={endpoints.to} label="GOAL" />}

      {plan?.feasible && plan.waypoints.length > 1 && (
        <>
          {/* Clearance casing — the lane's safe width. */}
          <Polyline
            positions={plan.waypoints.map((w) => toTuple(w.position))}
            pathOptions={{
              color: RISK_HEX[plan.riskLevel],
              weight: 14,
              opacity: 0.14,
              lineCap: 'round',
              lineJoin: 'round',
              interactive: false,
            }}
          />
          {/* Route spine. */}
          <Polyline
            positions={plan.waypoints.map((w) => toTuple(w.position))}
            pathOptions={{
              color: RISK_HEX[plan.riskLevel],
              weight: 2.5,
              opacity: 0.95,
              lineCap: 'round',
              lineJoin: 'round',
              interactive: false,
            }}
          />
          {/* Intermediate waypoints, numbered to match the planner list. */}
          {plan.waypoints.slice(1, -1).map((w, i) => (
            <CircleMarker
              key={i}
              center={toTuple(w.position)}
              radius={3}
              pathOptions={{
                color: '#0E141A',
                weight: 1.5,
                fillColor: RISK_HEX[plan.riskLevel],
                fillOpacity: 1,
              }}
            >
              <Tooltip direction="top" offset={[0, -4]}>
                <span className="font-mono text-[10px]">
                  {w.label} · clr {w.clearanceM} m
                </span>
              </Tooltip>
            </CircleMarker>
          ))}
        </>
      )}
    </>
  )
}

function EndpointMarker({ position, label }: { position: LatLng; label: string }) {
  return (
    <CircleMarker
      center={toTuple(position)}
      radius={5}
      pathOptions={{
        color: '#E8E4DA',
        weight: 2,
        fillColor: '#0E141A',
        fillOpacity: 1,
      }}
    >
      <Tooltip direction="top" offset={[0, -6]} permanent>
        <span className="font-mono text-[10px] tracking-[0.08em]">{label}</span>
      </Tooltip>
    </CircleMarker>
  )
}
