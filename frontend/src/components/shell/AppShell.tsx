import { useCallback, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import type { Detection } from '@/types'
import { useMissionStream } from '@/hooks/useMissionStream'
import { riskOf } from '@/lib/risk'
import { NavRail } from './NavRail'
import { AlertBanner, StatusRail } from './StatusRail'
import { MissionContext } from './missionContext'

/**
 * AppShell — the one place the mission stream is subscribed.
 *
 * Every screen reads the mission through context rather than subscribing
 * separately, so there is a single source of truth for telemetry and detections
 * and navigating between screens never restarts the mission.
 */
export function AppShell() {
  const navigate = useNavigate()
  const [alert, setAlert] = useState<Detection | null>(null)

  // A hazard-level arrival is the only thing that interrupts the operator.
  const onDetection = useCallback((d: Detection) => {
    if (riskOf(d) === 'hazard') setAlert(d)
  }, [])

  const snapshot = useMissionStream(onDetection)

  return (
    <MissionContext.Provider value={snapshot}>
      <div className="flex h-full flex-col overflow-hidden bg-ink">
        <StatusRail
          telemetry={snapshot?.telemetry ?? null}
          detections={snapshot?.detections ?? []}
          streamState={snapshot?.streamState ?? 'connecting'}
        />

        {alert && (
          <AlertBanner
            detection={alert}
            onDismiss={() => setAlert(null)}
            onInspect={() => {
              navigate(`/detections?focus=${alert.id}`)
              setAlert(null)
            }}
          />
        )}

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
