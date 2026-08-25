import { createContext, useContext } from 'react'
import type { MissionSnapshot } from '@/lib/simulation'

/**
 * The live mission, provided once by AppShell.
 *
 * Null before the first snapshot arrives. Screens should handle that rather than
 * assuming data — the real stream will have a genuine connecting state.
 */
export const MissionContext = createContext<MissionSnapshot | null>(null)

export function useMission(): MissionSnapshot | null {
  return useContext(MissionContext)
}
