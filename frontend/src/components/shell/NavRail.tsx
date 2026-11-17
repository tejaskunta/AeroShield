import { NavLink } from 'react-router-dom'
import { BarChart3, FileText, Map, ScanSearch, ShieldQuestion } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * NavRail — the screens, as a narrow icon rail on the left.
 *
 * Brought back from the original layout at the operator's request: it keeps the
 * top bar for status only and gives navigation a fixed, glanceable place. Each item
 * carries a short readable word under its icon (not a three-letter code), and the
 * active screen is marked by an accent bar on the leading edge.
 */
interface Screen {
  to: string
  label: string
  short: string
  icon: LucideIcon
}

export const SCREENS: Screen[] = [
  { to: '/mission', label: 'Mission control', short: 'Mission', icon: Map },
  { to: '/detections', label: 'Detections', short: 'Detect', icon: ScanSearch },
  { to: '/analytics', label: 'Analytics', short: 'Stats', icon: BarChart3 },
  { to: '/copilot', label: 'Safety copilot', short: 'Copilot', icon: ShieldQuestion },
  { to: '/reports', label: 'Mission reports', short: 'Reports', icon: FileText },
]

export function NavRail() {
  return (
    <nav aria-label="Screens" className="z-30 flex w-[60px] shrink-0 flex-col gap-1 border-r border-white/[0.06] bg-ink-deep py-2">
      {SCREENS.map(({ to, label, short, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            `group relative mx-1.5 flex h-[52px] flex-col items-center justify-center gap-1 rounded-md transition-colors ${isActive ? 'bg-white/[0.06] text-paper' : 'text-paper-faint hover:bg-white/[0.04] hover:text-paper-dim'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={`absolute -left-1.5 top-2.5 h-8 w-[2px] rounded-r ${isActive ? 'bg-signal' : 'bg-transparent'}`}
                aria-hidden
              />
              <Icon size={18} strokeWidth={1.75} aria-hidden />
              <span className="text-[0.625rem] font-medium leading-none">{short}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
