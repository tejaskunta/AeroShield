import { useEffect, useRef, useState } from 'react'
import type { Detection } from '@/types'
import { simulator, type MissionSnapshot } from '@/lib/simulation'

/**
 * Subscribe to the live mission.
 *
 * This hook is the swap point named in the plan: today it reads the in-process
 * `MissionSimulator`; when Socket.IO arrives, only this file changes — it starts
 * emitting the same `MissionSnapshot` shape from a socket, and every consumer
 * keeps working.
 *
 * `onDetection` fires once per newly-arrived detection, separate from the snapshot
 * stream, so a component can trigger a one-shot effect (ping ripple, ticker push)
 * without diffing detection arrays on every tick.
 */
export function useMissionStream(onDetection?: (d: Detection) => void): MissionSnapshot | null {
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null)
  const cb = useRef(onDetection)
  cb.current = onDetection

  useEffect(() => {
    const unsub = simulator.subscribe(setSnapshot)
    const unsubDet = simulator.onDetection((d) => cb.current?.(d))
    simulator.start()
    return () => {
      unsub()
      unsubDet()
      // The simulator is a shared singleton; leave it running so navigating
      // between screens doesn't reset the mission. It is stopped only on unload.
    }
  }, [])

  return snapshot
}
