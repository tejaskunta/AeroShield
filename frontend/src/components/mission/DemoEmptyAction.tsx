import { useNavigate } from 'react-router-dom'
import { Rocket, SkipForward } from 'lucide-react'
import { DEMO_MODE } from '@/lib/config'
import { simulator } from '@/lib/simulation'

/**
 * The way out of an empty screen in demo mode: fly the sortie live from Mission
 * Control, or land a finished one instantly so review, analytics and reports have
 * data to show. Renders nothing outside demo mode.
 */
export function DemoEmptyAction() {
  const navigate = useNavigate()
  if (!DEMO_MODE) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        onClick={() => {
          simulator.launch()
          navigate('/mission')
        }}
        className="flex items-center gap-1.5 rounded-md bg-signal px-3 py-1.5 text-[0.8125rem] font-semibold text-ink hover:brightness-110"
      >
        <Rocket size={14} aria-hidden="true" /> Fly the demo mission
      </button>
      <button
        type="button"
        onClick={() => simulator.skipToEnd()}
        className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-[0.8125rem] font-medium text-paper hover:bg-white/[0.05]"
      >
        <SkipForward size={14} aria-hidden="true" /> Load a completed sortie
      </button>
    </div>
  )
}
