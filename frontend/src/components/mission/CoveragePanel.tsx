import { Grid3x3 } from 'lucide-react'
import type { MissionProgress } from '@/types'
import { MISSION } from '@/lib/mockData'
import { Panel } from '@/components/ui/Panel'
import { Meter } from '@/components/ui/ConfidenceBar'
import { CountUp, StatReadout } from '@/components/ui/StatReadout'
import { formatArea, formatDuration } from '@/lib/geo'

/**
 * CoveragePanel — how much of the block has actually been looked at.
 *
 * The panel's job is to stop "74%" from being read as "74% safe". Coverage is
 * *imaging* progress, and the note under the meter says so plainly, because
 * conflating surveyed with cleared is the single most dangerous misreading this
 * whole console could invite.
 */
export function CoveragePanel({ progress }: { progress: MissionProgress | null }) {
  if (!progress) {
    return (
      <Panel title="Coverage" collapsible collapseId="coverage" icon={Grid3x3}>
        <div className="flex flex-col gap-1 py-1">
          <p className="text-small text-paper-dim">No coverage recorded yet.</p>
          <p className="text-tiny leading-snug text-paper-faint">
            A cell counts as surveyed once the camera footprint has passed over it. The grid
            starts filling on the first pass.
          </p>
        </div>
      </Panel>
    )
  }

  const totalCells = MISSION.grid.cols * MISSION.grid.rows
  const remaining = totalCells - progress.coveredCells.length

  return (
    <Panel title="Coverage" collapsible collapseId="coverage" icon={Grid3x3}>
      <StatReadout
        label="Surveyed"
        value={<CountUp value={progress.coveragePct} />}
        unit="%"
        size="lg"
        aside={
          <span className="font-mono text-tiny text-paper-faint">
            {progress.coveredCells.length}/{totalCells} cells
          </span>
        }
      />
      <Meter value={progress.coveragePct / 100} segments={24} className="mt-2" label="Coverage" />

      <div className="mt-2.5 grid grid-cols-2 gap-3">
        <StatReadout label="Area" value={formatArea(progress.areaSurveyedM2)} size="sm" />
        <StatReadout label="Elapsed" value={formatDuration(progress.elapsedS)} size="sm" />
      </div>

      <div className="rule-line my-2.5" />

      <p className="text-tiny leading-snug text-paper-faint">
        Surveyed means imaged from the air, <span className="text-paper-dim">not cleared</span>.
        {remaining > 0 && ` ${remaining} cells still unflown.`}
      </p>
    </Panel>
  )
}
