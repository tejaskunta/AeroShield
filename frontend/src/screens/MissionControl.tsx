import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LatLng } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections } from '@/hooks/useDetections'
import { LiveMap } from '@/components/map/LiveMap'
import { DetectionCallout } from '@/components/mission/DetectionCallout'
import { LiveFeed } from '@/components/mission/LiveFeed'
import { DroneStatusPanel } from '@/components/mission/DroneStatusPanel'
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
 *
 * There is deliberately no route planner here. The aircraft has no autopilot: it is
 * walked over a ten-metre block by hand, so the system's job is to record where it
 * went and what it saw, not to propose where it should go next.
 */
export function MissionControl() {
  const navigate = useNavigate()
  const mission = useMission()
  const detections = mission?.detections ?? []

  const { selected, selectedId, select, review } = useDetections(detections)

  const onMapClick = useCallback(
    (_p: LatLng) => {
      // A click on empty map clears the selection, like deselecting on a chart.
      select(null)
    },
    [select],
  )

  // Escape closes the callout — the callout covers map, so an escape hatch matters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

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

          {/**
           * The aircraft's own camera, picture-in-picture over the map.
           *
           * It sits outside the map's React subtree on purpose: an MJPEG feed is a
           * DOM `<img>` with its own connection lifetime, and having it re-created
           * whenever the map's children re-render would tear down and re-open the
           * socket on every pan. `detectorRunning` is currently always false because
           * nothing in this app can observe the detector's state — the wording in
           * the panel's footer is driven by it, so it stays honest about the limit
           * rather than asserting the detector is up.
           */}
          <LiveFeed detectorRunning={false} />
        </div>

        {/* The dock. Fixed width beside the map, stacked below it on narrow screens. */}
        <aside className="flex shrink-0 flex-col gap-2 overflow-y-auto border-t border-rule bg-ink p-2 lg:w-dock lg:border-l lg:border-t-0">
          <DroneStatusPanel telemetry={mission?.telemetry ?? null} />
          <CoveragePanel progress={mission?.progress ?? null} />
        </aside>
      </div>

      <DetectionTicker detections={detections} selectedId={selectedId} onSelect={select} />
    </div>
  )
}
