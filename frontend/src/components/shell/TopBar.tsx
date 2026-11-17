import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { FlaskConical, Radio } from 'lucide-react'
import type { Detection, LinkStatus, StreamState, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { HAS_LIVE_MISSION, MISSION_NAME } from '@/lib/config'
import { formatZulu } from '@/lib/geo'
import { countByRisk } from '@/hooks/useDetections'

/**
 * TopBar — the console's single piece of persistent chrome.
 *
 * Replaces the 44 px status rail and the 56 px icon rail. The icon rail spent the
 * whole left edge on five cryptic three-letter codes (MSN, DET, ANL...); the screens
 * now sit as named tabs in the centre of one 52 px bar, which gives the map back its
 * full width and makes the navigation readable at a glance.
 *
 * What it must still answer, and does, unchanged: "what am I looking at, and is it
 * real?" Three verdicts stay separate on purpose — provenance (flown vs simulated),
 * stream currency (`StreamState`) and transport health (`LinkStatus`). A single
 * combined light would hide exactly the combination an operator needs: a live
 * picture arriving over a degraded pipe.
 *
 * PROVENANCE IS DERIVED, NEVER ASSERTED: `link.source` flips to `backend` the first
 * time the API answers, the same signal the rest of the app trusts.
 */
export const SCREENS = [
  { to: '/mission', label: 'Mission' },
  { to: '/detections', label: 'Detections' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/copilot', label: 'Copilot' },
  { to: '/reports', label: 'Reports' },
] as const

export function TopBar({
  telemetry,
  detections,
  streamState,
  link,
}: {
  telemetry: Telemetry | null
  detections: Detection[]
  streamState: StreamState
  link: LinkStatus
}) {
  const counts = countByRisk(detections)
  const flown = link.source === 'backend'
  const callsign = HAS_LIVE_MISSION ? MISSION_NAME : MISSION.name

  return (
    <header className="relative z-40 flex h-topbar shrink-0 items-center gap-4 border-b border-white/[0.06] bg-ink-deep/95 px-4 backdrop-blur">
      {/* Identity */}
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <Mark />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[0.8125rem] font-semibold tracking-[0.04em] text-paper">
            AeroShield
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-paper-faint">
            {callsign}
            {/* The fixture's campus is only named for the simulator: the backend never
                reports a site, and printing one beside a real call-sign would name a
                place the aircraft may not be over. */}
            {!flown && <span className="hidden font-body lg:inline"> · {MISSION.site}</span>}
          </span>
        </div>
      </div>

      {/* Screens — centred tabs */}
      <nav aria-label="Screens" className="mx-auto flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] p-1">
        {SCREENS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `rounded px-3 py-1.5 text-[0.8125rem] font-medium transition-colors ${isActive
                ? 'bg-white/[0.08] text-paper shadow-[inset_0_-2px_0_0_var(--signal)]'
                : 'text-paper-faint hover:bg-white/[0.04] hover:text-paper-dim'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Verdicts */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="hidden items-center gap-1.5 xl:flex">
          {counts.hazard > 0 && <Tally tone="hazard" n={counts.hazard} label="hazard" />}
          {counts.caution > 0 && <Tally tone="caution" n={counts.caution} label="unverified" />}
        </div>
        <StreamIndicator state={streamState} link={link} />
        <ProvenanceMarker flown={flown} detections={detections} />
        <Clock iso={telemetry?.timestamp ?? null} />
      </div>
    </header>
  )
}

/** A rotor-cross mark: four arms and a hub. Plain geometry, no brand colour. */
function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="25" height="25" rx="7" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.10)" />
      <g stroke="var(--paper)" strokeWidth="1.6" strokeLinecap="round">
        <line x1="8" y1="8" x2="18" y2="18" />
        <line x1="18" y1="8" x2="8" y2="18" />
      </g>
      <g fill="none" stroke="var(--signal)" strokeWidth="1.4">
        <circle cx="8" cy="8" r="2.6" />
        <circle cx="18" cy="8" r="2.6" />
        <circle cx="8" cy="18" r="2.6" />
        <circle cx="18" cy="18" r="2.6" />
      </g>
      <circle cx="13" cy="13" r="1.8" fill="var(--paper)" />
    </svg>
  )
}

function Tally({ tone, n, label }: { tone: 'hazard' | 'caution'; n: number; label: string }) {
  const cls =
    tone === 'hazard'
      ? 'border-hazard/40 bg-hazard/10 text-hazard-lit'
      : 'border-caution/40 bg-caution/10 text-caution'
  return (
    <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium ${cls}`}>
      <span className="font-mono tabular-nums">{n}</span>
      {label}
    </span>
  )
}

/** Pill shell shared by the status chips. */
function Pill({ className = '', title, children }: { className?: string; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium leading-none ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * Provenance — the one chip that says whether the pins mean anything. The alarm is
 * on *simulated* on purpose: a simulated marker is a hazard that does not exist.
 */
function ProvenanceMarker({ flown, detections }: { flown: boolean; detections: Detection[] }) {
  const real = detections.filter((d) => d.source === 'backend').length
  if (flown) {
    return (
      <Pill
        className="border-cleared/40 bg-cleared/10 text-cleared"
        title={
          real > 0
            ? `Position and ${real} detection${real === 1 ? '' : 's'} came from the aircraft. Any row marked simulated is an invented fixture and must not be read as a find.`
            : 'Position is coming from the aircraft. No detection has been reported yet, so the queue is empty rather than simulated.'
        }
      >
        <Radio size={12} strokeWidth={2} aria-hidden />
        Flown
      </Pill>
    )
  }
  return (
    <Pill
      className="border-caution/40 bg-caution/10 text-caution"
      title="Every value on screen comes from a client-side simulator. No real sensor or model output is present, and no detection listed here corresponds to buried metal."
    >
      <FlaskConical size={12} strokeWidth={2} aria-hidden />
      Simulated
    </Pill>
  )
}

/**
 * Stream health, distinct from the radio link. The fallback is announced: a socket
 * that gave up and left polling to carry the mission is still *live*, so the dot
 * stays green, but the operator has lost sub-second updates — `Polling` says so.
 */
function StreamIndicator({ state, link }: { state: StreamState; link: LinkStatus }) {
  const config: Record<StreamState, { label: string; dot: string; cls: string }> = {
    live: { label: 'Stream live', dot: 'bg-cleared', cls: 'border-white/[0.08] text-paper-dim' },
    connecting: { label: 'Connecting', dot: 'bg-caution animate-pulse', cls: 'border-caution/30 text-caution' },
    stalled: { label: 'Aircraft silent', dot: 'bg-caution', cls: 'border-caution/30 text-caution' },
    unreachable: { label: 'Backend unreachable', dot: 'bg-hazard', cls: 'border-hazard/40 text-hazard-lit' },
  }
  const { label, dot, cls } = config[state]
  const transportNote =
    link.source === 'simulator'
      ? null
      : link.socketAttempts > 0
        ? `Link ${link.socketAttempts}/5`
        : link.transport === 'polling'
          ? 'Polling'
          : null

  return (
    <Pill
      className={cls}
      title={
        transportNote !== null && state === 'live'
          ? `${label}. The mission socket is unavailable, so position is listed once a second instead of pushed.`
          : label
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="hidden lg:inline">{label}</span>
      {transportNote !== null && (
        <span className="hidden border-l border-white/10 pl-1.5 text-paper-faint xl:inline">{transportNote}</span>
      )}
    </Pill>
  )
}

/** Mission time in Zulu — what flight logs record and what gets read out on radio. */
function Clock({ iso }: { iso: string | null }) {
  const [now, setNow] = useState(() => new Date().toISOString())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <time className="shrink-0 pl-1 font-mono text-[0.75rem] tabular-nums text-paper-dim" dateTime={iso ?? now}>
      {formatZulu(iso ?? now)}
    </time>
  )
}
