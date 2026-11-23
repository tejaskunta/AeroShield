import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  Crosshair,
  FastForward,
  FileText,
  Home,
  Loader2,
  MapPin,
  Pause,
  Play,
  Route,
  RotateCcw,
  Rocket,
  ScanSearch,
  Settings2,
  SkipForward,
} from 'lucide-react'
import type { Detection, MissionProgress } from '@/types'
import { PHASE_LABELS, SIM_PHASES, simulator, type SimState } from '@/lib/simulation'
import { riskOf } from '@/lib/risk'
import { formatDuration } from '@/lib/geo'
import { SURVEY_ORIGIN } from '@/lib/config'
import { SiteDialog } from './SiteDialog'

const SPEEDS = [1, 2, 4, 8]

/** Map-click modes the demo panel can arm: fly the aircraft there, or move the whole site there. */
export type DemoPickMode = 'fly' | 'site' | null
const STEPS = SIM_PHASES.filter((p) => p !== 'standby')

/**
 * The demonstration's flight director: where the sortie is, and the controls to
 * drive it. Sits top-centre over the map in demo mode.
 */
export function DemoControl({ sim, pickMode = null, onPickMode }: { sim: SimState; pickMode?: DemoPickMode; onPickMode?: (m: Exclude<DemoPickMode, null>) => void }) {
  const flyPicking = pickMode === 'fly'
  const idx = STEPS.indexOf(sim.phase as (typeof STEPS)[number])
  const flying = sim.phase !== 'standby' && sim.phase !== 'complete'
  const [siteOpen, setSiteOpen] = useState(false)

  return (
    <div className="glass pointer-events-auto w-full max-w-[620px] animate-rise-in overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="rounded bg-signal/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-signal">
                Sim
              </span>
              <span className="text-[0.8125rem] font-semibold text-paper">
                {sim.phase === 'standby' ? 'Ready on pad' : PHASE_LABELS[sim.phase]}
                {sim.guided && (
                  <span className="ml-1.5 text-signal">· {sim.guided === 'holding' ? 'holding at point' : 'flying to point'}</span>
                )}
                {sim.paused && <span className="ml-1.5 text-caution">· paused</span>}
              </span>
            </div>
            <span className="font-mono text-[0.6875rem] text-paper-dim">
              {sim.targetsFound}/{sim.targetsTotal} targets
            </span>
          </div>
          {/* Phase timeline. */}
          <div className="flex items-center gap-1">
            {STEPS.map((p, i) => {
              const done = idx > i || sim.phase === 'complete'
              const active = idx === i && sim.phase !== 'complete'
              return (
                <div key={p} className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ease-out ${done ? 'bg-signal' : active ? 'bg-signal' : ''}`}
                      style={{ width: done ? '100%' : active ? `${Math.round(sim.phaseProgress * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className={`truncate text-[0.625rem] ${active ? 'font-semibold text-paper' : done ? 'text-paper-dim' : 'text-paper-faint'}`}>
                    {PHASE_LABELS[p]}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-l border-white/[0.06] pl-3">
          {sim.phase === 'standby' || sim.phase === 'complete' ? (
            <button
              type="button"
              onClick={() => simulator.launch()}
              className="flex items-center gap-1.5 rounded-md bg-signal px-3 py-1.5 text-[0.8125rem] font-semibold text-ink shadow-glow transition-transform hover:brightness-110 active:scale-[0.97]"
            >
              <Rocket size={14} aria-hidden="true" />
              {sim.phase === 'complete' ? 'Fly again' : 'Launch mission'}
            </button>
          ) : (
            <>
              <CtlButton label={sim.paused ? 'Resume' : 'Pause'} onClick={() => simulator.togglePause()}>
                {sim.paused ? <Play size={14} /> : <Pause size={14} />}
              </CtlButton>
              <button
                type="button"
                onClick={() => simulator.setSpeed(SPEEDS[(SPEEDS.indexOf(sim.speed) + 1) % SPEEDS.length] ?? 1)}
                title="Simulation speed"
                className="flex h-8 min-w-[2.75rem] items-center justify-center gap-1 rounded-md px-1.5 font-mono text-[0.75rem] font-semibold text-paper-dim transition-colors hover:bg-white/[0.06] hover:text-paper"
              >
                <FastForward size={12} aria-hidden="true" />
                {sim.speed}×
              </button>
              <CtlButton label="Return to home" onClick={() => simulator.returnHome()} disabled={sim.phase !== 'survey'}>
                <Home size={14} />
              </CtlButton>
              <CtlButton label="Skip to landing" onClick={() => simulator.skipToEnd()}>
                <SkipForward size={14} />
              </CtlButton>
            </>
          )}
          {onPickMode && sim.phase !== 'landing' && (
            <button
              type="button"
              onClick={() => onPickMode('fly')}
              aria-pressed={flyPicking}
              title={flyPicking ? 'Stop placing (Esc)' : 'Fly to a point: click anywhere on the map'}
              className={`flex h-8 items-center gap-1 rounded-md px-2 text-[0.75rem] font-semibold transition-colors ${flyPicking ? 'bg-signal/20 text-signal ring-1 ring-signal/50' : 'text-paper-dim hover:bg-white/[0.06] hover:text-paper'}`}
            >
              <Crosshair size={14} aria-hidden="true" />
              Fly to
            </button>
          )}
          {sim.guided && sim.phase === 'survey' && (
            <CtlButton label="Resume survey route" onClick={() => simulator.resumeSurvey()}>
              <Route size={14} />
            </CtlButton>
          )}
          {!flying && onPickMode && (
            <button
              type="button"
              onClick={() => onPickMode('site')}
              aria-pressed={pickMode === 'site'}
              title={pickMode === 'site' ? 'Stop placing (Esc)' : 'Move the survey site: click where the mission should happen'}
              className={`flex h-8 items-center gap-1 rounded-md px-2 text-[0.75rem] font-semibold transition-colors ${pickMode === 'site' ? 'bg-signal/20 text-signal ring-1 ring-signal/50' : 'text-paper-dim hover:bg-white/[0.06] hover:text-paper'}`}
            >
              <MapPin size={14} aria-hidden="true" />
              Move site
            </button>
          )}
          {!flying && (
            <CtlButton label={`Site coordinates: ${SURVEY_ORIGIN.lat.toFixed(5)}, ${SURVEY_ORIGIN.lon.toFixed(5)}`} onClick={() => setSiteOpen(true)}>
              <Settings2 size={14} />
            </CtlButton>
          )}
          {sim.phase !== 'standby' && (
            <CtlButton label="Reset to pad" onClick={() => simulator.reset()}>
              <RotateCcw size={14} />
            </CtlButton>
          )}
        </div>
      </div>
      {/* Whole-sortie progress, a hairline under the panel. */}
      <div className="h-[2px] bg-white/[0.04]">
        <div className="h-full bg-gradient-to-r from-signal-dim to-signal transition-[width] duration-500" style={{ width: `${sim.missionProgress * 100}%` }} />
      </div>
      {sim.phase === 'preflight' && <PreflightList sim={sim} />}
      {pickMode === 'site' && (
        <div className="border-t border-white/[0.05] px-3 py-1.5 text-[0.6875rem] text-signal">
          Click an open patch of ground: the 10 × 10 m survey block, launch pad and targets move there (the page reloads). Esc to cancel.
        </div>
      )}
      {flyPicking && (
        <div className="border-t border-white/[0.05] px-3 py-1.5 text-[0.6875rem] text-signal">
          Click the map to send the aircraft there{sim.phase === 'standby' || sim.phase === 'complete' ? ' (it will launch first)' : ''}. Click again to re-target · Esc to stop.
        </div>
      )}
      {siteOpen && <SiteDialog onClose={() => setSiteOpen(false)} />}
      {flying && sim.phase !== 'preflight' && sim.speed > 1 && (
        <div className="border-t border-white/[0.05] px-3 py-1 text-[0.625rem] text-paper-faint">Running at {sim.speed}× real time</div>
      )}
    </div>
  )
}

function CtlButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-paper-dim transition-colors hover:bg-white/[0.06] hover:text-paper disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function PreflightList({ sim }: { sim: SimState }) {
  const firstPending = sim.checks.findIndex((c) => !c.done)
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-white/[0.05] px-3 py-2.5">
      {sim.checks.map((c, i) => (
        <div key={c.id} className="flex items-center gap-2 animate-fade-in">
          <span
            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${c.done ? 'bg-cleared/20 text-cleared' : i === firstPending ? 'text-signal' : 'text-paper-faint'}`}
          >
            {c.done ? <Check size={10} strokeWidth={3} /> : i === firstPending ? <Loader2 size={11} className="animate-spin" /> : <span className="h-1 w-1 rounded-full bg-current" />}
          </span>
          <span className={`text-[0.75rem] ${c.done ? 'text-paper' : 'text-paper-faint'}`}>{c.label}</span>
          <span className="ml-auto truncate font-mono text-[0.625rem] text-paper-faint">{c.done ? c.detail : ''}</span>
        </div>
      ))}
    </div>
  )
}

/** Survives remounts: leaving Mission Control and coming back must not re-open it. */
let debriefDismissedFor: string | null = null

/**
 * The debrief that appears once the aircraft is down: what was flown, what was
 * found, and where to go next. Dismissable; it does not come back for the same sortie.
 */
export function MissionDebrief({ sim, progress, detections }: { sim: SimState; progress: MissionProgress | null; detections: Detection[] }) {
  const navigate = useNavigate()
  const [dismissedFor, setDismissedState] = useState<string | null>(debriefDismissedFor)
  const setDismissedFor = (k: string) => {
    debriefDismissedFor = k
    setDismissedState(k)
  }
  const [visible, setVisible] = useState(false)
  const key = sim.landedAt
  useEffect(() => {
    if (sim.phase !== 'complete') {
      setVisible(false)
      return
    }
    // A beat after touchdown, so the landing itself is seen.
    const t = window.setTimeout(() => setVisible(true), 900)
    return () => window.clearTimeout(t)
  }, [sim.phase])
  if (!visible || !key || dismissedFor === key) return null

  const hazards = detections.filter((d) => riskOf(d) === 'hazard').length
  const caution = detections.filter((d) => riskOf(d) === 'caution').length
  const cleared = detections.filter((d) => riskOf(d) === 'cleared').length
  const flight = sim.launchedAt && sim.landedAt ? (Date.parse(sim.landedAt) - Date.parse(sim.launchedAt)) / 1000 : progress?.elapsedS ?? 0

  return (
    <div className="pointer-events-auto absolute inset-0 z-[800] grid place-items-center bg-ink-deep/55 backdrop-blur-[2px] animate-fade-in">
      <div className="w-[min(480px,calc(100%-2rem))] animate-rise-in rounded-xl border border-white/10 bg-ink-raised/95 shadow-glass">
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-cleared/15 text-cleared">
            <Check size={18} strokeWidth={2.5} />
          </span>
          <div>
            <div className="text-[0.9375rem] font-semibold text-paper">Mission complete</div>
            <div className="text-[0.75rem] text-paper-dim">Aircraft landed and disarmed. Detections are ready for review.</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-px bg-white/[0.05]">
          <Stat label="Flight time" value={formatDuration(flight)} />
          <Stat label="Coverage" value={`${progress?.coveragePct ?? 0}%`} />
          <Stat label="Detections" value={String(detections.length)} />
        </div>
        <div className="flex items-center gap-4 px-5 py-3 text-[0.75rem]">
          <Dot className="bg-hazard" label={`${hazards} hazard`} />
          <Dot className="bg-caution" label={`${caution} unverified`} />
          <Dot className="bg-cleared" label={`${cleared} cleared`} />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            onClick={() => setDismissedFor(key)}
            className="rounded-md px-3 py-1.5 text-[0.8125rem] font-medium text-paper-dim hover:bg-white/[0.05] hover:text-paper"
          >
            Stay on map
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissedFor(key)
              navigate('/reports')
            }}
            className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-[0.8125rem] font-medium text-paper hover:bg-white/[0.05]"
          >
            <FileText size={14} /> Report
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissedFor(key)
              navigate('/detections')
            }}
            className="flex items-center gap-1.5 rounded-md bg-signal px-3 py-1.5 text-[0.8125rem] font-semibold text-ink hover:brightness-110"
          >
            <ScanSearch size={14} /> Review detections
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-raised px-5 py-3">
      <div className="text-[0.6875rem] text-paper-faint">{label}</div>
      <div className="mt-1 font-mono text-[1.25rem] font-semibold text-paper">{value}</div>
    </div>
  )
}

function Dot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-paper-dim">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  )
}
