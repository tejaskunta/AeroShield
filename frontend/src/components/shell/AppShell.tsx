import { Outlet } from 'react-router-dom'
import { CONNECTING_LINK } from '@/types'
import { useMissionStream } from '@/hooks/useMissionStream'
import { NavRail } from './NavRail'
import { StatusRail } from './StatusRail'
import { MissionContext } from './missionContext'

/**
 * AppShell -- the one place the mission stream is subscribed.
 *
 * Every screen reads the mission through context rather than subscribing
 * separately, so there is a single source of truth for telemetry and detections
 * and navigating between screens never restarts the mission.
 *
 * Nothing here interrupts the operator. A new hazard used to raise a banner above
 * the workspace demanding acknowledgement, which meant a person in the middle of
 * reviewing one detection had their attention pulled to another by a dialog they
 * had to clear before continuing. Hazards are already the loudest thing on screen
 * -- the red tally in this rail, the red pins, the hazard stat tile -- so the
 * banner added no information, only an interruption and a click. Interruptions are
 * how a real hazard gets missed.
 */
export function AppShell() {
  const snapshot = useMissionStream()

  return (
    <MissionContext.Provider value={snapshot}>
      <div className="flex h-full flex-col overflow-hidden bg-ink">
        <StatusRail
          telemetry={snapshot?.telemetry ?? null}
          detections={snapshot?.detections ?? []}
          streamState={snapshot?.streamState ?? 'connecting'}
          link={snapshot?.link ?? CONNECTING_LINK}
        />

        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
    </MissionContext.Provider>
  )
}
