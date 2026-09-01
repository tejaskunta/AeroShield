import { NavLink } from 'react-router-dom'
import { BarChart3, FileText, ScanSearch, ShieldQuestion } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * NavRail — 56px icon rail, the five screens.
 *
 * Icon-only at rest with the label revealed on hover/focus, because the map wants
 * every pixel of width. The active screen is marked by a paper-coloured left edge
 * rather than a filled background: a filled nav item would be the brightest thing
 * on screen and pull attention away from the map, which is where it belongs.
 */
interface Screen {
  to: string
  label: string
  short: string
  icon: LucideIcon
}

export const SCREENS: Screen[] = [
  { to: '/detections', label: 'Detection Center', short: 'DET', icon: ScanSearch },
  { to: '/analytics', label: 'Analytics', short: 'ANL', icon: BarChart3 },
  { to: '/copilot', label: 'Safety Copilot', short: 'SFY', icon: ShieldQuestion },
  { to: '/reports', label: 'Mission Reports', short: 'RPT', icon: FileText },
]

export function NavRail() {
  return (
    <nav
      aria-label="Screens"
      className="z-30 flex w-rail shrink-0 flex-col border-r border-rule bg-ink-deep"
    >
      {SCREENS.map(({ to, label, short, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `group relative flex h-14 flex-col items-center justify-center gap-1 border-b border-rule/60 transition-colors ${isActive ? 'bg-ink-raised text-paper' : 'text-paper-faint hover:bg-ink-raised hover:text-paper-dim'
            }`
          }
        >
          {({ isActive }) => (
            <>
              {/* Active marker: a survey tick on the leading edge. */}
              <span
                className={`absolute left-0 top-0 h-full w-[2px] ${isActive ? 'bg-paper' : 'bg-transparent'}`}
                aria-hidden
              />
              <Icon size={17} strokeWidth={1.75} aria-hidden />
              <span className="font-mono text-[9px] tracking-[0.1em]">{short}</span>

              {/* Full label on hover/focus, as a map-style plate. */}
              <span className="pointer-events-none absolute left-full top-1/2 z-40 ml-1 -translate-y-1/2 whitespace-nowrap border border-rule bg-ink-deep px-2 py-1 font-display text-[11px] uppercase tracking-[0.1em] text-paper opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
