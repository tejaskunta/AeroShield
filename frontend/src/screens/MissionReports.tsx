import { useEffect, useMemo, useState } from 'react'
import type { Detection, MissionReport } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { generateReport, listReports } from '@/lib/api'
import { MISSION } from '@/lib/mockData'
import { countByReview } from '@/hooks/useDetections'
import { ReportList, ExportBar } from '@/components/reports/ReportList'
import { ReportPreview } from '@/components/reports/ReportPreview'
import { EmptyState } from '@/components/ui/EmptyState'
import { DEMO_MODE } from '@/lib/config'
import { formatDuration } from '@/lib/geo'
import { riskOf } from '@/lib/risk'

/**
 * Mission Reports — the document view.
 *
 * A report is an artifact that leaves this system: it gets printed, signed, filed,
 * and handed to a clearance organisation. So the screen is a list plus a real
 * document preview, and the preview is rendered as paper rather than as more
 * dashboard — you should be able to see what you're about to hand over.
 *
 * The report's tallies are recomputed from the live detection set rather than read
 * from the fixture, so a review decision made minutes ago in Detection Center is
 * reflected here. A report that disagreed with the console would be worse than no
 * report.
 */
export function MissionReports() {
  const mission = useMission()
  const detections = mission?.detections ?? []

  const [reports, setReports] = useState<MissionReport[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listReports().then((rs) => {
      if (cancelled) return
      setReports(rs)
      setSelectedId((cur) => cur ?? rs[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selected = reports.find((r) => r.id === selectedId) ?? null

  /**
   * Reconcile the stored report against current review state.
   *
   * The register is the detections the report covers; the tallies and coverage are
   * taken from live data so the sheet can't drift from the console.
   */
  const reconciled = useMemo((): { report: MissionReport; register: Detection[] } | null => {
    if (!selected) return null

    const inRegister = new Set(selected.detectionIds)
    const register = detections.filter((d) => inRegister.has(d.id))
    // Fall back to every detection when the fixture's id list doesn't match the
    // simulated run — better a complete register than an empty table.
    const effective = register.length > 0 ? register : detections
    const tallies = countByReview(effective)

    // The live sortie's report writes itself from what was flown and decided.
    const sim = mission?.sim
    const live = DEMO_MODE && selected.missionId === MISSION.id && sim
    const remaining = tallies.unreviewed + tallies.flagged
    const hazards = effective.filter((d) => riskOf(d) === 'hazard').length
    const n = effective.length
    const liveFields: Partial<MissionReport> =
      live && sim
        ? {
            status: sim.phase === 'complete' && remaining === 0 && n > 0 ? 'final' : 'draft',
            generatedAt: sim.landedAt ?? new Date().toISOString(),
            generatedBy: MISSION.operator,
            summary:
              sim.phase === 'standby'
                ? 'No sortie flown yet. Launch the mission from Mission Control to populate this report.'
                : [
                    `${sim.phase === 'complete' ? 'Survey' : 'Interim report: survey in progress'} of the 10 × 10 m block at ${MISSION.site}.`,
                    `${formatDuration(mission?.progress?.elapsedS ?? 0)} flown, ${mission?.progress?.coveragePct ?? 0}% of the block imaged from the air.`,
                    `${n} detection${n === 1 ? '' : 's'} logged, ${hazards} rated hazard.`,
                    `${tallies.confirmed} confirmed and ${tallies.dismissed} dismissed by the operator${tallies.flagged ? `, ${tallies.flagged} flagged for a second pass` : ''};`,
                    remaining === 0 ? 'every detection has a decision.' : `${remaining} still await review.`,
                    'All positions are pending ground verification. None released.',
                  ].join(' '),
          }
        : {}

    return {
      report: {
        ...selected,
        ...liveFields,
        coveragePct: mission?.progress?.coveragePct ?? selected.coveragePct,
        areaSurveyedM2: mission?.progress?.areaSurveyedM2 ?? selected.areaSurveyedM2,
        flightTimeS: Math.round(mission?.progress?.elapsedS ?? selected.flightTimeS),
        tallies: {
          total: effective.length,
          confirmed: tallies.confirmed,
          dismissed: tallies.dismissed,
          flagged: tallies.flagged,
          unreviewed: tallies.unreviewed,
        },
      },
      register: effective,
    }
  }, [selected, detections, mission])

  const regenerate = async () => {
    if (!selected) return
    setRegenerating(true)
    try {
      const fresh = await generateReport(selected.missionId)
      setReports((prev) => prev.map((r) => (r.id === fresh.id ? fresh : r)))
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="flex h-full min-w-0">
      <ReportList reports={reports} selectedId={selectedId} onSelect={setSelectedId} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 pt-5">
          <h1 className="text-[1.25rem] font-semibold tracking-tight text-paper">
            Mission Reports
          </h1>
          {reconciled && (
            <p className="text-[0.8125rem] text-paper-faint">
              {reconciled.register.length} detections in register
            </p>
          )}
        </header>

        {reconciled ? (
          <>
            <ExportBar
              report={reconciled.report}
              mission={MISSION}
              detections={reconciled.register}
              onRegenerate={() => void regenerate()}
              regenerating={regenerating}
            />
            <div className="min-h-0 flex-1 overflow-y-auto bg-ink-deep p-4">
              <ReportPreview
                report={reconciled.report}
                mission={MISSION}
                detections={reconciled.register}
              />
              <p className="mx-auto mt-3 max-w-[820px] text-tiny leading-snug text-paper-faint">
                Preview only. Server-side generation (WeasyPrint) is a backend task that
                does not exist yet. Print / PDF hands off to the browser's own dialogue,
                and CSV and GeoJSON are built in the browser from the live detection set.
              </p>
            </div>
          </>
        ) : (
          <div className="p-4">
            <EmptyState
              title="No report selected"
              detail="Pick a mission from the list to preview its report. Reports are generated per mission once a survey has produced detections."
            />
          </div>
        )}
      </div>
    </div>
  )
}
