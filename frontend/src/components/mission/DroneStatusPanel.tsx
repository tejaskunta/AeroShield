import { Radio, Satellite, Plane } from 'lucide-react'
import type { Telemetry } from '@/types'
import { Panel } from '@/components/ui/Panel'
import { Badge } from '@/components/ui/Badge'
import { Meter } from '@/components/ui/ConfidenceBar'
import { CountUp, StatReadout } from '@/components/ui/StatReadout'
import { compassPoint, formatLatLng } from '@/lib/geo'

/**
 * DroneStatusPanel — the aircraft's vitals.
 *
 * Ordered by what ends a mission soonest: battery, then link, then GPS quality,
 * then the flight numbers. That ordering is the panel's argument — an operator
 * scanning top-to-bottom hits the things that force a return-to-launch first.
 *
 * GPS fix gets a warning treatment below 3D because geotagging accuracy collapses
 * without it, which makes every detection position on the map suspect. That is a
 * data-integrity problem, not just a flight problem, so it is called out here.
 */
export function DroneStatusPanel({ telemetry }: { telemetry: Telemetry | null }) {
  if (!telemetry) {
    return (
      <Panel title="Drone status" collapsible collapseId="drone-status" icon={Plane}>
        <div className="flex flex-col gap-1 py-1">
          <p className="text-small text-paper-dim">Waiting for the first telemetry frame.</p>
          <p className="text-tiny leading-snug text-paper-faint">
            The panel fills in as soon as the aircraft reports a position. If it stays empty,
            check the stream state in the status bar above.
          </p>
        </div>
      </Panel>
    )
  }

  const {
    batteryPct,
    batteryVolts,
    linkPct,
    satellites,
    gpsFix,
    altitudeM,
    groundSpeedMs,
    headingDeg,
    mode,
    armed,
    position,
  } = telemetry

  /*
   * Battery and link are `null` when the aircraft never sent those frames — the
   * normal state on this airframe, which flies with no MAVLink link, so the only
   * telemetry it can report is GPS.
   *
   * That distinction has to survive into the rendering. Grading a null against
   * the 20%/60% thresholds picks the "bad" branch every time, so an aircraft that
   * simply has nothing to say about its battery was drawn in hazard red at 0 V —
   * indistinguishable from a flat pack about to force an RTL. "Not reported" is
   * the honest reading and it is what a missing link actually means.
   */
  const batteryTone =
    batteryPct === null ? 'normal' : batteryPct <= 20 ? 'bad' : batteryPct <= 35 ? 'warn' : 'normal'
  const linkTone =
    linkPct === null ? 'normal' : linkPct < 60 ? 'bad' : linkPct < 80 ? 'warn' : 'normal'
  const fixOk = gpsFix === '3d' || gpsFix === 'rtk'

  return (
    <Panel
      title="Drone status"
      collapsible
      collapseId="drone-status"
      icon={Plane}
      aside={
        <div className="flex items-center gap-1.5">
          <Badge>{mode}</Badge>
          <Badge risk={armed ? 'hazard' : undefined}>{armed ? 'Armed' : 'Disarmed'}</Badge>
        </div>
      }
    >
      {/* Battery — the clock on the whole mission. */}
      <div className="mb-2.5">
        <StatReadout
          label="Battery"
          value={batteryPct === null ? '--' : <CountUp value={batteryPct} />}
          unit={batteryPct === null ? undefined : '%'}
          tone={batteryTone}
          aside={
            <span className="font-mono text-tiny text-paper-faint">
              {batteryVolts === null ? 'not reported' : `${batteryVolts} V`}
            </span>
          }
        />
        <Meter
          value={batteryPct === null ? 0 : batteryPct / 100}
          tone={batteryTone === 'bad' ? 'hazard' : batteryTone === 'warn' ? 'caution' : 'paper'}
          className="mt-1.5"
          label="Battery remaining"
        />
      </div>

      <div className="rule-line" />

      {/* Link and GPS — the two things that make the data trustworthy. */}
      <div className="grid grid-cols-2 gap-3 py-2.5">
        <StatReadout
          label="Link"
          value={linkPct === null ? '--' : linkPct}
          unit={linkPct === null ? undefined : '%'}
          tone={linkTone}
          size="sm"
          aside={<Radio size={10} className="text-paper-faint" aria-hidden />}
        />
        <StatReadout
          label="GPS fix"
          value={gpsFix.toUpperCase()}
          tone={fixOk ? 'normal' : 'bad'}
          size="sm"
          aside={<Satellite size={10} className="text-paper-faint" aria-hidden />}
        />
      </div>

      {!fixOk && (
        <p className="mb-2 border border-hazard/50 bg-hazard/10 px-2 py-1 text-tiny leading-snug text-hazard-lit">
          GPS fix below 3D. Detection positions recorded now will not be reliable.
        </p>
      )}

      <div className="rule-line" />

      {/* Flight numbers. */}
      <div className="grid grid-cols-3 gap-2 py-2.5">
        <StatReadout label="Alt" value={altitudeM.toFixed(1)} unit="m" size="sm" />
        <StatReadout label="Speed" value={groundSpeedMs.toFixed(1)} unit="m/s" size="sm" />
        <StatReadout
          label="Heading"
          value={String(headingDeg).padStart(3, '0')}
          unit={compassPoint(headingDeg)}
          size="sm"
        />
      </div>

      <div className="rule-line" />

      {/* Position — monospaced, because it gets copied into Mission Planner. */}
      <div className="flex items-center justify-between gap-2 pt-2">
        <span className="eyebrow">Position</span>
        <span className="font-mono text-small tabular text-paper">{formatLatLng(position)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="eyebrow">Satellites</span>
        <span className="font-mono text-small tabular text-paper">{satellites}</span>
      </div>
    </Panel>
  )
}
