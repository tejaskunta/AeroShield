import { useState } from 'react'
import type { ReactNode } from 'react'
import { Layers } from 'lucide-react'
import { Toggle } from '@/components/ui/Toggle'

/**
 * LayerToggles — the map's layer checklist.
 *
 * Collapsed to a single button by default so the map keeps its width; the operator
 * opens it when they need to strip the map back. Each row carries the layer's own
 * mark as a swatch, so the list doubles as a key for the marks the legend doesn't
 * cover — the hatched fill, the grid, and the flown track.
 *
 * There is no planned-path row and no safe-route row. The aircraft is flown by hand
 * over the block, so a route is not something the system knows enough to draw.
 */
export interface LayerState {
  grid: boolean
  coverage: boolean
  track: boolean
  detections: boolean
}

/**
 * The map opens with the hazard field alone: detection pins and the aircraft.
 *
 * The survey grid, the coverage hatch and the flown track are all *reference*
 * marks — they describe the ground and where the aircraft has been, not where the
 * danger is. With them on by default the hazard pins sit inside a lattice of
 * metre-square lines and read as part of that texture instead of as separate
 * objects on it. They are one click away in this menu, which is where a reference
 * layer belongs: available, not competing.
 */
export const DEFAULT_LAYERS: LayerState = {
  grid: false,
  coverage: false,
  track: false,
  detections: true,
}

const ROWS: Array<{ key: keyof LayerState; label: string; swatch: ReactNode }> = [
  { key: 'detections', label: 'Detections', swatch: <Dot /> },
  { key: 'coverage', label: 'Coverage', swatch: <HatchSwatch /> },
  { key: 'track', label: 'Flown track', swatch: <Line color="#E8E4DA" /> },
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

function Line({ color }: { color: string }) {
  return (
    <svg width="14" height="6" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="3"
        x2="14"
        y2="3"
        stroke={color}
        strokeWidth="1.5"
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
