import { FileDown, FileText, Printer, RefreshCw } from 'lucide-react'
import type { Detection, Mission, MissionReport } from '@/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { formatZulu } from '@/lib/geo'
import {
  detectionsToCsv,
  detectionsToGeoJson,
  downloadText,
  exportStem,
} from '@/lib/export'

/**
 * ReportList — missions that have a report.
 *
 * Sorted newest first and marked by status, because the operator's question is
 * almost always "where's the one from today". Draft vs final is the only state that
 * changes what you can do with it, so it is the only thing badged.
 */
export function ReportList({
  reports,
  selectedId,
  onSelect,
}: {
  reports: MissionReport[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-rule bg-ink-deep lg:flex">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-rule px-3">
        <h2 className="eyebrow">Reports</h2>
        <span className="font-mono text-[10px] text-paper-faint">{reports.length}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {reports.map((r) => {
          const selected = r.id === selectedId
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.id)}
              aria-current={selected}
              className={`flex w-full flex-col gap-1 border-b border-rule/60 px-3 py-2 text-left transition-colors ${
                selected ? 'bg-ink-hover' : 'hover:bg-ink-raised'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] tracking-[0.04em] text-paper">
                  {r.missionName}
                </span>
                <Badge risk={r.status === 'final' ? undefined : 'caution'}>{r.status}</Badge>
              </div>
              <span className="truncate text-[10px] text-paper-dim">{r.site}</span>
              <div className="flex items-center gap-2 font-mono text-[10px] text-paper-faint">
                <span>{r.id}</span>
                <span>·</span>
                <span>{r.tallies.confirmed} confirmed</span>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

/**
 * ExportBar — what you can actually take away from here.
 *
 * PDF is the format people ask for and the one that isn't real yet, so the button
 * for it hands off to the browser's own print dialogue rather than pretending a
 * generator exists. CSV and GeoJSON are produced properly, in-browser, from the
 * live detection set.
 */
export function ExportBar({
  report,
  mission,
  detections,
  onRegenerate,
  regenerating,
}: {
  report: MissionReport
  mission: Mission
  detections: Detection[]
  onRegenerate: () => void
  regenerating: boolean
}) {
  const stem = exportStem(report)

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-rule bg-ink px-3 py-2">
      <span className="mr-1 font-mono text-[11px] text-paper-dim">
        {report.id}
        <span className="ml-2 text-paper-faint">
          generated {formatZulu(report.generatedAt)}
        </span>
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          variant="quiet"
          onClick={onRegenerate}
          disabled={regenerating}
          icon={<RefreshCw size={12} aria-hidden />}
        >
          {regenerating ? 'Regenerating…' : 'Regenerate'}
        </Button>
        <Button
          onClick={() =>
            downloadText(`${stem}-register.csv`, 'text/csv', detectionsToCsv(detections, mission))
          }
          icon={<FileText size={12} aria-hidden />}
        >
          CSV register
        </Button>
        <Button
          onClick={() =>
            downloadText(
              `${stem}.geojson`,
              'application/geo+json',
              detectionsToGeoJson(detections, mission),
            )
          }
          icon={<FileDown size={12} aria-hidden />}
        >
          GeoJSON
        </Button>
        <Button
          onClick={() => window.print()}
          icon={<Printer size={12} aria-hidden />}
          title="Uses the browser's print dialogue — server-side PDF generation is not built yet"
        >
          Print / PDF
        </Button>
      </div>
    </div>
  )
}
