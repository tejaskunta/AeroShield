import { useState } from 'react'
import type { ReactNode } from 'react'
import { Layers } from 'lucide-react'
import { Toggle } from '@/components/ui/Toggle'

/**
 * LayerToggles — the map's layer checklist.
 *
 * Collapsed to a single button by default so the map keeps its width; the operator
 * opens it when they need to strip the map back. Each row carries the layer's own
 * mark as a swatch, so this list doubles as a key for the line styles (dashed =
 * planned, solid = flown) that the legend doesn't cover.
 */
export interface LayerState {
  grid: boolean
  coverage: boolean
  plannedPath: boolean
  track: boolean
  detections: boolean
  corridor: boolean
}

export const DEFAULT_LAYERS: LayerState = {
  grid: true,
  coverage: true,
  plannedPath: true,
  track: true,
  detections: true,
  corridor: true,
}

const ROWS: Array<{ key: keyof LayerState; label: string; swatch: ReactNode }> = [
  { key: 'detections', label: 'Detections', swatch: <Dot /> },
  { key: 'coverage', label: 'Coverage', swatch: <HatchSwatch /> },
  { key: 'corridor', label: 'Safe route', swatch: <Line color="#4E9E86" /> },
  { key: 'track', label: 'Flown track', swatch: <Line color="#E8E4DA" /> },
  { key: 'plannedPath', label: 'Planned path', swatch: <Line color="#3E5060" dashed /> },
  { key: 'grid', label: 'Survey grid', swatch: <GridSwatch /> },
]

export function LayerToggles({
  value,
  onChange,
}: {
  value: LayerState
  onChange: (next: LayerState) => void
}) {
  const [open, setOpen] = useState(false)
  const hiddenCount = Object.values(value).filter((v) => !v).length

  return (
    <div className="border border-rule bg-ink-deep/90 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim hover:text-paper"
      >
        <Layers size={12} strokeWidth={1.75} aria-hidden />
        Layers
        {/* Say when the map is not showing everything — a hidden layer is a
            silent omission otherwise. */}
        {hiddenCount > 0 && (
          <span className="font-mono text-[9px] text-caution">{hiddenCount} off</span>
        )}
      </button>

      {open && (
        <div className="border-t border-rule px-2 py-1.5">
          {ROWS.map(({ key, label, swatch }) => (
            <Toggle
              key={key}
              checked={value[key]}
              onChange={(next) => onChange({ ...value, [key]: next })}
              label={label}
              swatch={swatch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Line({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <svg width="14" height="6" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="3"
        x2="14"
        y2="3"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray={dashed ? '3 3' : undefined}
      />
    </svg>
  )
}

function Dot() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <circle cx="4" cy="4" r="3" fill="none" stroke="#C9922C" strokeWidth="1.5" />
      <rect x="9" y="1.5" width="5" height="5" fill="#D7262F" transform="rotate(45 11.5 4)" />
    </svg>
  )
}

function HatchSwatch() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <defs>
        <pattern id="lt-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="#3E5060" strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect width="14" height="8" fill="url(#lt-hatch)" />
    </svg>
  )
}

function GridSwatch() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="13" height="7" fill="none" stroke="#2C3A47" strokeWidth="1" />
      <line x1="7" y1="0" x2="7" y2="8" stroke="#2C3A47" strokeWidth="1" />
    </svg>
  )
}
