import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LatLng, PathPlan } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections } from '@/hooks/useDetections'
import { MISSION } from '@/lib/mockData'
import { planSafePath } from '@/lib/pathfinding'
import { offsetM } from '@/lib/geo'
import { LiveMap } from '@/components/map/LiveMap'
import { DetectionCallout } from '@/components/mission/DetectionCallout'
import { DroneStatusPanel } from '@/components/mission/DroneStatusPanel'
import { SafePathPlanner, type PickTarget } from '@/components/mission/SafePathPlanner'
import { CoveragePanel } from '@/components/mission/CoveragePanel'
import { DetectionTicker } from '@/components/mission/DetectionTicker'

/**
 * Mission Control — the primary screen.
 *
 * The layout thesis: the map is the canvas, not a card in a grid. Everything else
 * docks to it — status readouts in a fixed right rail, the detection callout
 * floating over the map tied to its pin, the arrival feed along the bottom. On a
 * running mission the operator's eyes live on the map, so the map gets the space
 * and every other element is sized to stay out of its way.
 *
 * Below `lg` the dock moves under the map rather than compressing it, because a
 * 320px-wide map is useless and a stacked dock is merely inconvenient.
 */
export function MissionControl() {
  const navigate = useNavigate()
  const mission = useMission()
  const detections = mission?.detections ?? []

  const { selected, selectedId, select, review } = useDetections(detections)

  // --- safe path planner state -------------------------------------------
  //
  // Seeded with the launch point as START so the endpoint marker is visible
  // immediately, and a destination across the block so the corridor demonstrates
  // itself on first paint. Both are operator-editable by clicking the map.
  const [from, setFrom] = useState<LatLng | null>(MISSION.plannedPath[0] ?? null)
  const [to, setTo] = useState<LatLng | null>(() =>
    offsetM(MISSION.grid.origin, MISSION.grid.cols * MISSION.grid.cellSizeM * 0.82, MISSION.grid.rows * MISSION.grid.cellSizeM * 0.78),
  )
  const [plan, setPlan] = useState<PathPlan | null>(null)
  const [picking, setPicking] = useState<PickTarget>(null)

  const runPlan = useCallback(() => {
    if (!from || !to) return
    setPlan(planSafePath(MISSION.grid, from, to, detections))
  }, [from, to, detections])

  // Plot the seeded route once, as soon as there are detections to avoid.
  const autoPlanned = useRef(false)
  useEffect(() => {
    if (autoPlanned.current || detections.length === 0 || !from || !to) return
    autoPlanned.current = true
    setPlan(planSafePath(MISSION.grid, from, to, detections))
  }, [detections, from, to])

  const onMapClick = useCallback(
    (p: LatLng) => {
      if (picking === 'from') {
        setFrom(p)
        setPicking(null)
        // A moved endpoint invalidates the route — don't leave a stale corridor
        // on screen implying it still applies.
        setPlan(null)
      } else if (picking === 'to') {
        setTo(p)
        setPicking(null)
        setPlan(null)
      } else {
        // A click on empty map clears the selection, like deselecting on a chart.
        select(null)
      }
    },
    [picking, select],
  )

  const clearPlan = useCallback(() => {
    setPlan(null)
    setFrom(null)
    setTo(null)
    setPicking(null)
  }, [])

  // Escape closes the callout — the callout covers map, so an escape hatch matters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (picking) setPicking(null)
        else select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, select])

  const endpoints = useMemo(() => ({ from, to }), [from, to])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The canvas. */}
        <div className="relative min-h-[320px] flex-1 lg:min-h-0">
          <LiveMap
            telemetry={mission?.telemetry ?? null}
            progress={mission?.progress ?? null}
            detections={detections}
            selectedId={selectedId}
            onSelect={select}
            plan={plan}
            planEndpoints={endpoints}
            onMapClick={onMapClick}
          >
            {selected && (
              <DetectionCallout
                detection={selected}
                onClose={() => select(null)}
                onReview={review}
                onOpenInCenter={(id) => navigate(`/detections?focus=${id}`)}
              />
            )}
          </LiveMap>

          {/* Arming the picker changes what a map click means, so say so. */}
          {picking && (
            <div className="pointer-events-none absolute left-1/2 top-2 z-[600] -translate-x-1/2 border border-paper/60 bg-ink-deep/95 px-2.5 py-1">
              <p className="font-display text-[11px] uppercase tracking-[0.1em] text-paper">
                Click the map to set {picking === 'from' ? 'start' : 'destination'}
                <span className="ml-2 font-mono text-[10px] text-paper-dim">Esc to cancel</span>
              </p>
            </div>
          )}
        </div>

        {/* The dock. Fixed width beside the map, stacked below it on narrow screens. */}
        <aside className="flex shrink-0 flex-col gap-2 overflow-y-auto border-t border-rule bg-ink p-2 lg:w-dock lg:border-l lg:border-t-0">
          <DroneStatusPanel telemetry={mission?.telemetry ?? null} />
          <SafePathPlanner
            from={from}
            to={to}
            plan={plan}
            picking={picking}
            onPick={setPicking}
            onPlan={runPlan}
            onClear={clearPlan}
          />
          <CoveragePanel progress={mission?.progress ?? null} />
        </aside>
      </div>

      <DetectionTicker detections={detections} selectedId={selectedId} onSelect={select} />
    </div>
  )
}
