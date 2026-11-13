import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LatLng } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections } from '@/hooks/useDetections'
import { usePersistedState } from '@/hooks/usePersistedState'
import { HAS_JETSON_STREAM } from '@/lib/config'
import {
  DEFAULT_CAMERA_PX,
  clampCameraWidth,
  isCameraWidth,
  maxCameraWidth,
} from '@/lib/splitPane'
import { LiveMap } from '@/components/map/LiveMap'
import { DetectionCallout } from '@/components/mission/DetectionCallout'
import { LiveFeed } from '@/components/mission/LiveFeed'
import type { LiveFeedDisplayMode } from '@/components/mission/LiveFeed'
import { SplitHandle } from '@/components/mission/SplitHandle'
import { DroneStatusPanel } from '@/components/mission/DroneStatusPanel'
import { CoveragePanel } from '@/components/mission/CoveragePanel'

/**
 * Mission Control — the primary screen.
 *
 * The layout thesis: the map and the aircraft's camera are two views of the same
 * event, and the operator needs both at once — the map says *where* the aircraft is,
 * the camera says *what it is looking at*, and neither answers the other's question.
 * So the window is split: the map takes the flexible side, the camera a fixed
 * column beside it, and the numeric readouts dock to the far right.
 *
 * The camera was a picture-in-picture overlay over the map. That was the right shape
 * when the feed was a peripheral glance, but on a live mission the picture is a
 * co-equal subject: a 320 px box in the corner of a map cannot be read for detail,
 * and the previous "make it a tab" alternative was worse still, because a tab is the
 * one layout where the two views can never be seen together at all.
 *
 * Below `lg` the columns stack rather than compress — a 320 px-wide map is useless
 * and a stacked column is merely inconvenient. The camera column is omitted entirely
 * when no stream is configured, so the keyless simulator demo keeps exactly the
 * layout it had.
 *
 * There is deliberately no route planner here. The aircraft has no autopilot: it is
 * walked over a ten-metre block by hand, so the system's job is to record where it
 * went and what it saw, not to propose where it should go next.
 */
/*
 * How many detections the map will draw at once.
 *
 * This is a DISPLAY limit, not a retention one. Every detection is still
 * recorded and still uploaded - the aircraft writes the full set to its local
 * log and the backend keeps every row - and the Detection Centre, the reports
 * and the analytics all read the complete mission. Nothing is dropped here;
 * this one view simply stops drawing past this point.
 *
 * The number is about legibility, not performance. A survey flown at 10 m
 * altitude over a stony block produces dozens of hits a minute, and a map
 * carrying hundreds of pins stops showing where the aircraft has been: the
 * pins merge into a solid field of colour and the operator cannot point at any
 * single one. Sixty keeps the recent picture readable while the full history
 * stays one click away, and it is ordered newest-first so the cap removes the
 * oldest, least relevant marks rather than the newest.
 */
const MAX_VISIBLE_DETECTIONS = 60

export function MissionControl() {
  const navigate = useNavigate()
  const mission = useMission()
  const detections = mission?.detections ?? []

  const { selected, selectedId, select, review } = useDetections(detections)

  /*
   * `detections` is oldest-first, so the newest are at the END. Take the last
   * sixty and then hand the map the same oldest-first order it already expects.
   *
   * `selected` is looked up from the FULL list by `useDetections`, so a callout
   * stays open even if its detection has aged out of the drawn set - the
   * operator should not lose the panel they are reading because the map moved
   * on. Only the marks themselves are capped.
   */
  const visibleDetections =
    detections.length > MAX_VISIBLE_DETECTIONS
      ? detections.slice(detections.length - MAX_VISIBLE_DETECTIONS)
      : detections

  /*
   * Proof the detector is alive, without a heartbeat channel.
   *
   * A detection whose `source` is `backend` could only have come from the aircraft
   * running a model over its own frames — the seeded simulator rows are all
   * `simulated`. So one such row is enough to say so, and the footer stops short of
   * claiming a detector until one exists.
   */
  const detectorRunning = detections.some((d) => d.source === 'backend')

  const onMapClick = useCallback(
    (_p: LatLng) => {
      // A click on empty map clears the selection, like deselecting on a chart.
      select(null)
    },
    [select],
  )

  /*
   * The map / camera split.
   *
   * The camera used to be a fixed clamp and the map took the rest, which meant the
   * one ratio was decided by a CSS expression that could not see the map. That is
   * wrong when the two views trade places in importance: reading a suspicious patch
   * of ground wants a wide picture and a small map, and walking the aircraft between
   * two pins wants the opposite. So the ratio is the operator's, and it persists
   * because re-dragging it on every reload would be a chore rather than a control.
   *
   * `usePersistedState` is the right home for it — its documented scope is exactly
   * "UI layout state only", and this is the width of a column.
   */
  const [cameraWidth, setCameraWidth] = usePersistedState(
    'camera-width',
    DEFAULT_CAMERA_PX,
    isCameraWidth,
  )
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [dockWidth, setDockWidth] = useState(0)

  /*
   * Measure the row and the dock, rather than deriving them from the viewport.
   *
   * `maxCameraWidth` has to know what the map can actually spare, and the honest
   * inputs are the two element widths either side of the divider. `window.innerWidth`
   * would have to subtract a nav rail width that lives in another component and in
   * CSS — a number that would drift out of step the first time the shell changes.
   *
   * `ResizeObserver` fires once on observe with the current size, so this settles on
   * mount without a separate initial `getBoundingClientRect`.
   */
  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        // `borderBoxSize` includes the dock's padding, which is what the flex row
        // actually lays out; `contentRect` would under-report it by 16px.
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? target.offsetWidth
        if (target === row) setRowWidth(width)
        else setDockWidth(width)
      }
    })

    observer.observe(row)
    // The dock is optional in the tree only in principle — it is always rendered —
    // but it is queried rather than held in a ref so the observer cannot be wired
    // to a stale node if the panel list ever changes.
    const dock = row.querySelector('aside')
    if (dock) observer.observe(dock)

    return () => observer.disconnect()
  }, [])

  const maxWidth = maxCameraWidth(rowWidth, dockWidth)
  // Clamped on read, not just on write: the persisted value may predate a window
  // resize, and a stale 700px column on a now-narrow row would push the map under
  // its floor without the operator having touched anything.
  const appliedCameraWidth = clampCameraWidth(cameraWidth, maxWidth)

  /**
   * Whether the feed is currently a column beside the map.
   *
   * Tracked because the divider only means something in `docked` mode: in `Pip` the
   * feed floats and the map already owns the whole row, so a 6px handle would have
   * nothing on its right that resizing affects.
   */
  const [feedMode, setFeedMode] = useState<LiveFeedDisplayMode>('docked')
  const showDivider = HAS_JETSON_STREAM && feedMode === 'docked'

  const onCameraWidthChange = useCallback(
    (next: number) => setCameraWidth(next),
    [setCameraWidth],
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
      {/*
       * `relative` is what the camera's PiP anchors to. The feed is one element
       * whose own classes decide whether it occupies a column, floats over this
       * area, or fills the window — so this container is the one thing its
       * `absolute` variant can resolve against.
       */}
      <div ref={rowRef} className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        {/*
         * The canvas.
         *
         * `xl:min-w-canvas` is a guarantee, not a preference, and the `xl:` is
         * load-bearing: at 1024-1150px a 512px floor plus the camera clamp plus the
         * 320px dock exceeds the row, and `main` is `overflow-hidden` — so the dock
         * was being clipped off-screen rather than scrolling. The floor now only
         * applies from 1280px up, where the arithmetic is guaranteed to fit.
         *
         * Below that the clamp on the camera still does the real work; the floor is
         * belt-and-braces for the wide case.
         */}
        <div className="relative min-h-[320px] flex-1 lg:min-h-0 xl:min-w-canvas">
          <LiveMap
            telemetry={mission?.telemetry ?? null}
            progress={mission?.progress ?? null}
            /* Capped for legibility only - see MAX_VISIBLE_DETECTIONS. */
            detections={visibleDetections}
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
        </div>

        {/*
         * The divider.
         *
         * A real flex sibling, not an overlay: it has to own its width for the
         * drag to have a stable origin, and a handle sitting on top of the map's
         * right edge would take the map's own pan gestures away by 6px.
         *
         * Rendered only when the feed is a column. In PiP the map already spans
         * the row, so the handle would resize nothing.
         */}
        {showDivider && (
          <SplitHandle
            width={appliedCameraWidth}
            maxWidth={maxWidth}
            onChange={onCameraWidthChange}
          />
        )}

        {/**
         * The aircraft's own camera.
         *
         * It sits outside the map's React subtree on purpose: an MJPEG feed is a
         * DOM `<img>` with its own connection lifetime, and having it re-created
         * whenever the map's children re-render would tear down and re-open the
         * socket on every pan.
         *
         * `detectorRunning` is inferred from the detections rather than passed in
         * as a flag, because there is no channel that reports the detector's own
         * state — but a detection carrying `source: 'backend'` is proof it ran and
         * found something, which is stronger evidence than a heartbeat would be.
         * It stays `false` until the first real find lands, so the footer never
         * claims a detector is up before it has produced anything, and it reads
         * correctly in the keyless simulator demo where every row is `simulated`.
         *
         * The feed renders its own column, rather than being wrapped in one here.
         * That is the fix for the leftover box: a wrapper large enough to hold a
         * full-height picture cannot be removed when the operator switches to the
         * floating PiP without also removing the feed, so the wrapper stayed and
         * sat empty exactly where the camera had been. One element that changes
         * its own sizing has nothing to leave behind.
         *
         * `widthPx` is only the operator's dragged width. Passing it while the feed
         * is in PiP or full view would be ignored by the feed's own sizing, but the
         * divider is hidden then too, so the column and the handle can never
         * disagree about how wide the right-hand side is.
         *
         * Render only when a stream URL is configured. `LiveFeed` returns null
         * without one, which would leave an empty column eating a third of the
         * screen in the simulator demo.
         */}
        {HAS_JETSON_STREAM && (
          <LiveFeed
            docked
            detectorRunning={detectorRunning}
            widthPx={appliedCameraWidth}
            onDisplayModeChange={setFeedMode}
          />
        )}

        {/* The dock. Fixed width beside the map, stacked below it on narrow screens. */}
        {/*
          * `dock` carries the rail behaviour (see the "Dock rail" rule in
          * index.css). When every panel inside is folded, the column narrows to
          * an icon rail instead of staying 320 px wide around a 32 px icon.
          */}
        <aside className="dock flex shrink-0 flex-col gap-2 overflow-y-auto border-t border-rule bg-ink p-2 lg:w-dock lg:border-l lg:border-t-0">
          <DroneStatusPanel telemetry={mission?.telemetry ?? null} />
          <CoveragePanel progress={mission?.progress ?? null} />
        </aside>
      </div>
    </div>
  )
}
