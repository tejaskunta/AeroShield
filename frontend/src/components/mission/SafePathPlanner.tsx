import { Crosshair, RouteOff, Route as RouteIcon } from 'lucide-react'
import type { LatLng, PathPlan } from '@/types'
import { Panel } from '@/components/ui/Panel'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { RISK_LABELS } from '@/lib/risk'
import { formatDistance, formatLatLng } from '@/lib/geo'
import { HARD_CLEARANCE_M } from '@/lib/pathfinding'

/**
 * SafePathPlanner — plot a route to a point without walking into a hazard.
 *
 * The panel leads with the number that decides whether the route is usable:
 * tightest clearance. Distance is secondary — a shorter route that pinches to 8 m
 * is worse than a longer one that holds 30 m, and the layout says so by giving
 * clearance the large readout and distance a small one.
 *
 * When no corridor exists, the planner refuses and says why rather than returning
 * a best-effort route. A route that clips a hazard is worse than no route.
 */
export type PickTarget = 'from' | 'to' | null

export function SafePathPlanner({
  from,
  to,
  plan,
  picking,
  onPick,
  onPlan,
  onClear,
}: {
  from: LatLng | null
  to: LatLng | null
  plan: PathPlan | null
  picking: PickTarget
  onPick: (target: PickTarget) => void
  onPlan: () => void
  onClear: () => void
}) {
  const ready = from !== null && to !== null

  return (
    <Panel
      title="Safe path"
      aside={
        plan?.feasible ? (
          <Badge risk={plan.riskLevel}>{RISK_LABELS[plan.riskLevel]} route</Badge>
        ) : undefined
      }
    >
      {/* Endpoint pickers. Clicking arms the map; the map click sets the point. */}
      <div className="space-y-1">
        <EndpointRow
          label="From"
          point={from}
          armed={picking === 'from'}
          onArm={() => onPick(picking === 'from' ? null : 'from')}
        />
        <EndpointRow
          label="To"
          point={to}
          armed={picking === 'to'}
          onArm={() => onPick(picking === 'to' ? null : 'to')}
        />
      </div>

      <div className="mt-2.5 flex gap-1.5">
        <Button onClick={onPlan} disabled={!ready} icon={<RouteIcon size={12} aria-hidden />}>
          Plot route
        </Button>
        {(from || to || plan) && (
          <Button variant="quiet" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>

      {!ready && !plan && (
        <p className="mt-2 text-[10px] leading-snug text-paper-faint">
          Pick a start and a destination on the map. Routes hold {HARD_CLEARANCE_M} m from
          every known hazard.
        </p>
      )}

      {plan && !plan.feasible && (
        <div className="mt-2.5 border border-hazard/50 bg-hazard/10 p-2">
          <p className="flex items-center gap-1.5 font-display text-[11px] uppercase tracking-[0.1em] text-hazard">
            <RouteOff size={12} aria-hidden />
            No safe corridor
          </p>
          <p className="mt-1 text-[10px] leading-snug text-paper-dim">{plan.note}</p>
        </div>
      )}

      {plan?.feasible && (
        <>
          <div className="rule-line my-2.5" />

          {/* Clearance leads — it is the number that decides usability. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="eyebrow">Tightest clearance</span>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span
                  className={`font-display text-readout tabular ${
                    plan.minClearanceM < HARD_CLEARANCE_M * 1.5 ? 'text-caution' : 'text-paper'
                  }`}
                >
                  {plan.minClearanceM.toFixed(0)}
                </span>
                <span className="font-mono text-[10px] text-paper-dim">m</span>
              </div>
            </div>
            <div className="space-y-1 pt-1">
              <Row label="Distance" value={formatDistance(plan.distanceM)} />
              <Row label="Waypoints" value={String(plan.waypoints.length)} />
              <Row label="Route risk" value={plan.routeRisk.toFixed(2)} />
            </div>
          </div>

          {plan.note && (
            <p className="mt-2 border-l-2 border-caution pl-2 text-[10px] leading-snug text-caution">
              {plan.note}
            </p>
          )}

          {/* Waypoint list — labels match the map exactly. */}
          <div className="mt-2.5 max-h-32 overflow-y-auto border border-rule">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-ink-deep">
                <tr>
                  <th className="eyebrow px-2 py-1 text-left font-normal">WP</th>
                  <th className="eyebrow px-2 py-1 text-left font-normal">Position</th>
                  <th className="eyebrow px-2 py-1 text-right font-normal">Clr</th>
                </tr>
              </thead>
              <tbody>
                {plan.waypoints.map((w) => (
                  <tr key={w.label} className="border-t border-rule/60">
                    <td className="px-2 py-1 font-mono text-[10px] text-paper-dim">{w.label}</td>
                    <td className="px-2 py-1 font-mono text-[10px] tabular text-paper">
                      {formatLatLng(w.position)}
                    </td>
                    <td
                      className={`px-2 py-1 text-right font-mono text-[10px] tabular ${
                        w.clearanceM < HARD_CLEARANCE_M * 1.5 ? 'text-caution' : 'text-paper-dim'
                      }`}
                    >
                      {w.clearanceM.toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-[10px] leading-snug text-paper-faint">
            Planned against known detections only. Unsurveyed ground is not cleared ground.
          </p>
        </>
      )}
    </Panel>
  )
}

function EndpointRow({
  label,
  point,
  armed,
  onArm,
}: {
  label: string
  point: LatLng | null
  armed: boolean
  onArm: () => void
}) {
  return (
    <button
      type="button"
      onClick={onArm}
      className={`flex w-full items-center gap-2 border px-2 py-1 text-left transition-colors ${
        armed
          ? 'border-paper bg-ink-hover'
          : 'border-rule hover:border-rule-bright hover:bg-ink-hover'
      }`}
    >
      <Crosshair
        size={11}
        className={armed ? 'text-paper' : 'text-paper-faint'}
        aria-hidden
      />
      <span className="eyebrow w-8 shrink-0">{label}</span>
      <span className="flex-1 truncate font-mono text-[10px] tabular text-paper">
        {point ? formatLatLng(point) : armed ? 'Click the map…' : '—'}
      </span>
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[11px] tabular text-paper">{value}</span>
    </div>
  )
}
