import { useState } from 'react'
import { ChevronDown, Radio, Satellite } from 'lucide-react'
import type { Detection, MissionProgress, Telemetry } from '@/types'
import { CLASS_LABELS } from '@/types'
import { MISSION } from '@/lib/mockData'
import { RISK_CLASSES, RISK_LABELS, formatConfidence, riskOf } from '@/lib/risk'
import { compassPoint, formatArea, formatDuration, formatLatLng, formatZulu } from '@/lib/geo'
import { countByRisk } from '@/hooks/useDetections'
import { Meter } from '@/components/ui/ConfidenceBar'
import { CountUp } from '@/components/ui/StatReadout'
import { Ring } from '@/components/ui/Ring'
import { Sparkline, useHistory } from '@/components/ui/Sparkline'

/**
 * StatusStrip — the mission's numbers, as glass cards along the bottom of the map.
 *
 * Replaces the right-hand dock. A dock takes a fixed slice of width from the map on
 * every screen size; floating cards over the map's lower edge give the map the whole
 * window and keep the numbers where the eye drops to read them. Three cards, three
 * questions: how much is done (Mission), is the aircraft healthy (Aircraft), and
 * what has it found (Detections).
 *
 * The honesty lines carry over unchanged: "surveyed means imaged, not cleared", the
 * sub-3D-fix warning, and "not reported" instead of an invented battery voltage.
 *
 * Collapsible to a single row so the operator can take the whole map when needed.
 */
export function StatusStrip({
  telemetry,
  progress,
  detections,
  onPick,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  /** A detection chosen from the list: select it and bring it into view. */
  onPick: (d: Detection) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="pointer-events-auto flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="glass flex items-center gap-1.5 px-2.5 py-1 text-[0.6875rem] font-medium text-paper-faint transition-colors hover:text-paper"
      >
        <ChevronDown size={13} className={`transition-transform ${open ? '' : 'rotate-180'}`} aria-hidden />
        {open ? 'Hide status' : 'Show status'}
      </button>
      {open && (
        <div className="grid w-full animate-rise-in grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1.15fr)]">
          <MissionCard progress={progress} />
          <AircraftCard telemetry={telemetry} />
          <DetectionsCard detections={detections} onPick={onPick} />
        </div>
      )}
    </div>
  )
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="glass min-w-0 px-4 py-3.5">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-paper-faint">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Kv({ k, v, unit }: { k: string; v: React.ReactNode; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[0.75rem] text-paper-faint">{k}</span>
      <span className="font-mono text-[0.8125rem] tabular-nums text-paper">
        {v}
        {unit && <span className="ml-1 text-[0.6875rem] text-paper-faint">{unit}</span>}
      </span>
    </div>
  )
}

function MissionCard({ progress }: { progress: MissionProgress | null }) {
  const total = MISSION.grid.cols * MISSION.grid.rows
  if (!progress) {
    return (
      <Card title="Mission">
        <p className="text-[0.8125rem] text-paper-dim">No coverage recorded yet.</p>
        <p className="mt-1 text-[0.75rem] leading-snug text-paper-faint">
          A cell counts as surveyed once the camera footprint has passed over it.
        </p>
      </Card>
    )
  }
  const remaining = total - progress.coveredCells.length
  return (
    <Card title="Mission">
      <div className="flex items-center gap-4">
        <Ring value={progress.coveragePct / 100} label="Block surveyed" size={80} stroke={6}>
          <div>
            <div className="readout text-[1.5rem] leading-none">
              <CountUp value={progress.coveragePct} />
              <span className="text-[0.75rem] text-paper-faint">%</span>
            </div>
            <div className="mt-1 text-[0.625rem] text-paper-faint">surveyed</div>
          </div>
        </Ring>
        <div className="min-w-0 flex-1">
          <Kv k="Cells" v={`${progress.coveredCells.length}/${total}`} />
          <Kv k="Area" v={formatArea(progress.areaSurveyedM2)} />
          <Kv k="Elapsed" v={formatDuration(progress.elapsedS)} />
        </div>
      </div>
      <p className="mt-3 text-[0.6875rem] leading-snug text-paper-faint">
        Surveyed means imaged from the air, <span className="text-paper-dim">not cleared</span>.
        {remaining > 0 && ` ${remaining} cells unflown.`}
      </p>
    </Card>
  )
}

function AircraftCard({ telemetry }: { telemetry: Telemetry | null }) {
  // Recent history, one sample per telemetry frame (~2 min). Above the early
  // return so the hook order never changes.
  const key = telemetry?.timestamp
  const altH = useHistory(telemetry?.altitudeM, key)
  const spdH = useHistory(telemetry?.groundSpeedMs, key)
  const linkH = useHistory(telemetry?.linkPct, key)
  const batH = useHistory(telemetry?.batteryPct, key)
  if (!telemetry) {
    return (
      <Card title="Aircraft">
        <p className="text-[0.8125rem] text-paper-dim">Waiting for the first telemetry frame.</p>
        <p className="mt-1 text-[0.75rem] leading-snug text-paper-faint">
          Fills in when the aircraft reports a position. If it stays empty, check the stream
          state in the top bar.
        </p>
      </Card>
    )
  }
  const { batteryPct, batteryVolts, linkPct, satellites, gpsFix, altitudeM, groundSpeedMs, headingDeg, mode, armed, position } =
    telemetry
  const batteryTone = batteryPct === null ? 'paper' : batteryPct <= 20 ? 'hazard' : batteryPct <= 35 ? 'caution' : 'paper'
  const fixOk = gpsFix === '3d' || gpsFix === 'rtk'
  const linkBad = linkPct !== null && linkPct < 60

  return (
    <Card
      title="Aircraft"
      aside={
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-paper-dim">
            {mode}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide ${armed ? 'border-hazard/40 text-hazard-lit' : 'border-white/10 text-paper-faint'}`}
          >
            {armed ? 'Armed' : 'Disarmed'}
          </span>
        </div>
      }
    >
      <div className="flex items-start gap-4">
        <HeadingDial deg={headingDeg} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[0.75rem] text-paper-faint">Battery</span>
            <span className="text-[0.6875rem] text-paper-faint">
              {batteryVolts === null ? 'voltage not reported' : `${batteryVolts} V`}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className={`readout text-[1.5rem] leading-none ${batteryTone === 'hazard' ? 'text-hazard-lit' : batteryTone === 'caution' ? 'text-caution' : ''}`}>
              {batteryPct === null ? '--' : <CountUp value={batteryPct} />}
            </span>
            {batteryPct !== null && <span className="text-[0.75rem] text-paper-faint">%</span>}
            <span className="ml-auto block w-[88px] self-center">
              <Sparkline values={batH} width={88} height={18} minSpan={5} format={(v) => `${v.toFixed(0)}%`} label="Battery" />
            </span>
          </div>
          <Meter value={batteryPct === null ? 0 : batteryPct / 100} tone={batteryTone} segments={20} className="mt-2" label="Battery remaining" />
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Mini k="Alt" v={altitudeM.toFixed(1)} u="m" spark={altH} fmt={(v) => `${v.toFixed(1)} m`} span={1} />
            <Mini k="Speed" v={groundSpeedMs.toFixed(1)} u="m/s" spark={spdH} fmt={(v) => `${v.toFixed(1)} m/s`} span={1} />
            <Mini k="Link" v={linkPct === null ? '--' : String(linkPct)} u={linkPct === null ? '' : '%'} bad={linkBad} icon={<Radio size={10} aria-hidden />} spark={linkH} fmt={(v) => `${v.toFixed(0)}%`} span={10} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
        <span className={`flex items-center gap-1.5 text-[0.75rem] ${fixOk ? 'text-paper-dim' : 'text-hazard-lit'}`}>
          <Satellite size={12} aria-hidden />
          GPS {gpsFix.toUpperCase()} · {satellites} sats
        </span>
        <span className="font-mono text-[0.6875rem] tabular-nums text-paper-faint">{formatLatLng(position)}</span>
      </div>
      {!fixOk && (
        <p className="mt-2 rounded-md border border-hazard/40 bg-hazard/10 px-2 py-1 text-[0.6875rem] leading-snug text-hazard-lit">
          GPS fix below 3D. Positions recorded now will not be reliable.
        </p>
      )}
    </Card>
  )
}

function Mini({
  k, v, u, bad = false, icon, spark, fmt, span = 1,
}: {
  k: string; v: string; u: string; bad?: boolean; icon?: React.ReactNode
  spark?: number[]; fmt?: (v: number) => string; span?: number
}) {
  return (
    <div className="min-w-0 rounded-md bg-white/[0.03] px-2 py-1.5 transition-colors hover:bg-white/[0.05]">
      <div className="flex items-center gap-1 text-[0.625rem] text-paper-faint">
        {icon}
        {k}
      </div>
      <div className={`mt-0.5 font-mono text-[0.875rem] tabular-nums ${bad ? 'text-hazard-lit' : 'text-paper'}`}>
        {v}
        <span className="ml-0.5 text-[0.625rem] text-paper-faint">{u}</span>
      </div>
      {spark && (
        <div className="mt-1">
          <Sparkline values={spark} width={84} height={16} minSpan={span} format={fmt} label={k} />
        </div>
      )}
    </div>
  )
}

/** Heading as a compass dial: the needle is the aircraft's nose. */
function HeadingDial({ deg }: { deg: number }) {
  const size = 76
  const c = size / 2
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Heading ${deg} degrees`}>
        <circle cx={c} cy={c} r={c - 2} fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.08)" />
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i * 10 * Math.PI) / 180
          const major = i % 9 === 0
          const r1 = c - 4
          const r2 = major ? c - 11 : c - 7
          return (
            <line
              key={i}
              x1={c + r1 * Math.sin(a)}
              y1={c - r1 * Math.cos(a)}
              x2={c + r2 * Math.sin(a)}
              y2={c - r2 * Math.cos(a)}
              stroke={major ? 'rgba(233,237,241,0.55)' : 'rgba(233,237,241,0.18)'}
              strokeWidth={major ? 1.4 : 1}
            />
          )
        })}
        {(['N', 'E', 'S', 'W'] as const).map((l, i) => {
          const a = (i * 90 * Math.PI) / 180
          const r = c - 19
          return (
            <text
              key={l}
              x={c + r * Math.sin(a)}
              y={c - r * Math.cos(a) + 3.5}
              textAnchor="middle"
              fontSize="9"
              fontWeight={600}
              fill={l === 'N' ? 'var(--signal)' : 'rgba(233,237,241,0.55)'}
            >
              {l}
            </text>
          )
        })}
        {/* CSS transform with an explicit origin: a transition on the SVG `transform`
            attribute interpolates about (0,0), swinging the needle off the dial. */}
        <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: `${c}px ${c}px`, transition: 'transform 400ms ease-out' }}>
          <path d={`M ${c} ${c - 22} L ${c + 6} ${c + 8} L ${c} ${c + 3} L ${c - 6} ${c + 8} Z`} fill="var(--signal)" />
        </g>
        <circle cx={c} cy={c} r={2} fill="var(--paper)" />
      </svg>
      <span className="font-mono text-[0.75rem] tabular-nums text-paper">
        {String(deg).padStart(3, '0')}° <span className="text-paper-faint">{compassPoint(deg)}</span>
      </span>
    </div>
  )
}

function DetectionsCard({ detections, onPick }: { detections: Detection[]; onPick: (d: Detection) => void }) {
  const counts = countByRisk(detections)
  const latest = detections.slice(-3).reverse()
  const rows: Array<{ k: 'hazard' | 'caution' | 'cleared'; n: number }> = [
    { k: 'hazard', n: counts.hazard },
    { k: 'caution', n: counts.caution },
    { k: 'cleared', n: counts.cleared },
  ]
  return (
    <Card title="Detections" aside={<span className="font-mono text-[0.75rem] tabular-nums text-paper-faint">{detections.length} total</span>}>
      <div className="grid grid-cols-3 gap-2">
        {rows.map(({ k, n }) => (
          <div key={k} className="rounded-md bg-white/[0.03] px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[0.6875rem] text-paper-faint">
              <span className={`size-1.5 rounded-full ${RISK_CLASSES[k].bg}`} aria-hidden />
              {RISK_LABELS[k]}
            </div>
            <div className={`readout mt-0.5 text-[1.375rem] leading-none ${n > 0 ? RISK_CLASSES[k].text : 'text-paper-faint'}`}>{n}</div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        {latest.length === 0 ? (
          <p className="text-[0.75rem] text-paper-faint">Nothing found yet. Detections appear here as the aircraft flies.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {latest.map((d) => {
              const r = riskOf(d)
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onPick(d)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <span className={`size-2 shrink-0 rounded-full ${RISK_CLASSES[r].bg}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-paper">
                      {CLASS_LABELS[d.class]}
                      <span className="ml-1.5 text-[0.6875rem] text-paper-faint">{d.gridCell}</span>
                    </span>
                    <span className={`font-mono text-[0.75rem] tabular-nums ${RISK_CLASSES[r].text}`}>{formatConfidence(d.confidence)}</span>
                    <span className="font-mono text-[0.6875rem] tabular-nums text-paper-faint">{formatZulu(d.capturedAt).slice(0, 8)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <p className="mt-2 text-[0.6875rem] text-paper-faint">Rings on the map show how far a position could be out.</p>
    </Card>
  )
}
