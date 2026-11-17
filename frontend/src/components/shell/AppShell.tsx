import { Outlet, useLocation } from 'react-router-dom'
import { CONNECTING_LINK } from '@/types'
import { useMissionStream } from '@/hooks/useMissionStream'
import { TopBar } from './TopBar'
import { NavRail } from './NavRail'
import { CommandLayer } from './CommandPalette'
import { MissionContext } from './missionContext'

/**
 * AppShell -- the one place the mission stream is subscribed.
 *
 * Every screen reads the mission through context rather than subscribing
 * separately, so there is a single source of truth for telemetry and detections
 * and navigating between screens never restarts the mission.
 *
 * Nothing here interrupts the operator. Hazards are already the loudest thing on
 * screen -- the red tally in the top bar, the red pins -- so no banner demands
 * acknowledgement. Interruptions are how a real hazard gets missed.
 */
export function AppShell() {
  const snapshot = useMissionStream()
  const { pathname } = useLocation()

  return (
    <MissionContext.Provider value={snapshot}>
      <div className="flex h-full flex-col overflow-hidden bg-ink">
        <TopBar
          telemetry={snapshot?.telemetry ?? null}
          detections={snapshot?.detections ?? []}
          streamState={snapshot?.streamState ?? 'connecting'}
          link={snapshot?.link ?? CONNECTING_LINK}
        />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          {/* Keyed by route: each screen fades up as it arrives. */}
          <main key={pathname} className="relative min-h-0 min-w-0 flex-1 animate-fade-in overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandLayer />
    </MissionContext.Provider>
  )
}
