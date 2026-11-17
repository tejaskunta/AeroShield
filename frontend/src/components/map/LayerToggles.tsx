import { useState } from 'react'
import type { ReactNode } from 'react'
import { Layers } from 'lucide-react'
import { Toggle } from '@/components/ui/Toggle'
import { CAUTION_HEX, CONSOLE_HEX, HAZARD_HEX, SIGNAL_HEX } from '@/lib/consoleInk'

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
  /** The georeferenced drone photo of the block, when one has been made. */
  drone: boolean
  /** The ground the camera sees right now. */
  footprint: boolean
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
  // On whenever a photo exists: it is the only imagery with real detail at z21-23.
  drone: true,
  // On: it is what tells the operator what the camera is looking at this second.
  footprint: true,
}

const ROWS: Array<{ key: keyof LayerState; label: string; swatch: ReactNode }> = [
  { key: 'detections', label: 'Detections', swatch: <Dot /> },
  { key: 'footprint', label: 'Camera footprint', swatch: <Line color={SIGNAL_HEX} /> },
  { key: 'coverage', label: 'Coverage', swatch: <HatchSwatch /> },
  { key: 'track', label: 'Flown track', swatch: <Line color={CONSOLE_HEX.paper} /> },
  { key: 'grid', label: 'Survey grid', swatch: <GridSwatch /> },
]

export function LayerToggles({
  value,
  onChange,
  droneLabel = null,
  defaultOpen = false,
}: {
  /** Start expanded — when the list is itself inside a popover the caller opened. */
  defaultOpen?: boolean
  value: LayerState
  onChange: (next: LayerState) => void
  /**
   * The drone photo row's label, carrying its capture time ("Drone photo · 18 Nov
   * 10:42"), or null when no photo exists. Imagery is labelled with when it was
   * taken so a photo from this morning is never read as a live picture.
   */
  droneLabel?: string | null
}) {
  const [open, setOpen] = useState(defaultOpen)
  const rows = droneLabel
    ? [{ key: 'drone' as const, label: droneLabel, swatch: <PhotoSwatch /> }, ...ROWS]
    : ROWS
  const hiddenCount = rows.filter(({ key }) => !value[key]).length

  return (
    <div className="glass min-w-[12rem] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-[0.8125rem] font-medium text-paper-dim transition-colors hover:text-paper"
      >
        <Layers size={15} strokeWidth={1.75} aria-hidden />
        Layers
        {/* Say when the map is not showing everything — a hidden layer is a
            silent omission otherwise. */}
        {hiddenCount > 0 && (
          <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 text-[0.6875rem] text-paper-faint">{hiddenCount} off</span>
        )}
      </button>

      {open && (
        <div className="border-t border-white/[0.06] px-3 py-2">
          {rows.map(({ key, label, swatch }) => (
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
      <circle cx="4" cy="4" r="3" fill="none" stroke={CAUTION_HEX} strokeWidth="1.5" />
      <rect x="9" y="1.5" width="5" height="5" fill={HAZARD_HEX} transform="rotate(45 11.5 4)" />
    </svg>
  )
}

function HatchSwatch() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <defs>
        <pattern id="lt-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke={CONSOLE_HEX.ruleBright} strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect width="14" height="8" fill="url(#lt-hatch)" />
    </svg>
  )
}

function PhotoSwatch() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="13" height="7" fill={CONSOLE_HEX.rule} stroke={CONSOLE_HEX.paper} strokeWidth="1" />
      <path d="M2 7 L6 3.5 L9 6 L11 4.5 L13 7 Z" fill={CONSOLE_HEX.paper} />
    </svg>
  )
}

function GridSwatch() {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="13" height="7" fill="none" stroke={CONSOLE_HEX.rule} strokeWidth="1" />
      <line x1="7" y1="0" x2="7" y2="8" stroke={CONSOLE_HEX.rule} strokeWidth="1" />
    </svg>
  )
}
