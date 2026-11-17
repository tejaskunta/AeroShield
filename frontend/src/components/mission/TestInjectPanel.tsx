import { useEffect, useState } from 'react'
import { Crosshair, FlaskConical, ImageUp, Send, X } from 'lucide-react'
import type { LatLng } from '@/types'
import { HAS_LIVE_MISSION, MISSION_NAME } from '@/lib/config'
import { MISSION } from '@/lib/mockData'
import { gridCenter } from '@/lib/geo'
import { injectTestDetection } from '@/lib/api'
import { Button } from '@/components/ui/Button'

/**
 * TestInjectPanel — place a landmine image at a point, through the real pipeline.
 *
 * The rehearsal for "does a detection actually reach this screen": pick an image,
 * click the map (or type coordinates), send. It goes to the backend's test-inject
 * route, which runs the same steps as the drone's upload — row, stored frame, live
 * socket broadcast — so a pin appearing proves backend, database, socket and map in
 * one go. The row is stamped `manual-test`, and every surface labels it "Test
 * injection"; it is never shown as flown.
 *
 * The box defaults to the centre fifth of the frame, since a hand-picked photo has
 * no model box; it is drawn so the photo viewer has something to show.
 */
export function TestInjectPanel({
  point,
  picking,
  onPickToggle,
  onClose,
}: {
  /** Last point clicked on the map while picking. */
  point: LatLng | null
  picking: boolean
  onPickToggle: () => void
  onClose: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  // Start at the survey block's centre, so a first test needs only an image.
  const [lat, setLat] = useState(() => gridCenter(MISSION.grid).lat.toFixed(7))
  const [lon, setLon] = useState(() => gridCenter(MISSION.grid).lon.toFixed(7))
  const [conf, setConf] = useState(0.82)
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' })

  useEffect(() => {
    if (!point) return
    setLat(point.lat.toFixed(7))
    setLon(point.lon.toFixed(7))
  }, [point])

  useEffect(() => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    const img = new Image()
    img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  const latN = Number(lat)
  const lonN = Number(lon)
  const coordsOk = lat !== '' && lon !== '' && Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180
  const ready = Boolean(file && dims && coordsOk && HAS_LIVE_MISSION) && state.kind !== 'sending'

  const send = async () => {
    if (!file || !dims || !coordsOk) return
    setState({ kind: 'sending' })
    const bw = dims.w * 0.2
    const bh = dims.h * 0.2
    const r = await injectTestDetection({
      image: file,
      lat: latN,
      lon: lonN,
      missionName: MISSION_NAME,
      confidence: conf,
      frameWidth: dims.w,
      frameHeight: dims.h,
      bbox: { x1: dims.w / 2 - bw / 2, y1: dims.h / 2 - bh / 2, x2: dims.w / 2 + bw / 2, y2: dims.h / 2 + bh / 2 },
    })
    setState(r.ok ? { kind: 'ok', msg: `Sent as D-${String(r.id).padStart(4, '0')}. Watch the map.` } : { kind: 'error', msg: r.error })
  }

  return (
    <section className="glass w-[320px] animate-rise-in p-4" aria-label="Test detection">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[0.875rem] font-semibold text-paper">
          <FlaskConical size={14} className="text-signal" aria-hidden />
          Test detection
        </h2>
        <button type="button" onClick={onClose} aria-label="Close test panel" className="grid size-7 place-items-center rounded text-paper-faint hover:bg-white/[0.06] hover:text-paper">
          <X size={15} aria-hidden />
        </button>
      </header>

      {!HAS_LIVE_MISSION && (
        <p className="mb-3 rounded border border-caution/40 bg-caution/10 px-2.5 py-1.5 text-[0.75rem] text-caution">
          Set VITE_MISSION_NAME in frontend/.env.local: a test needs a backend mission to land in.
        </p>
      )}

      <label className="block cursor-pointer">
        <span className="mb-1 block text-[0.75rem] text-paper-faint">Image</span>
        <span className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-md border border-dashed border-white/15 bg-ink-deep text-paper-faint hover:border-signal/50">
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-1.5 text-[0.75rem]">
              <ImageUp size={18} aria-hidden />
              Choose a landmine photo
            </span>
          )}
        </span>
        <input type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div className="mt-3 flex items-end gap-2">
        <Coord label="Latitude" value={lat} onChange={setLat} />
        <Coord label="Longitude" value={lon} onChange={setLon} />
        <button
          type="button"
          onClick={onPickToggle}
          aria-pressed={picking}
          title="Click the map to set the position"
          className={`grid size-9 shrink-0 place-items-center rounded-md border transition-colors ${picking ? 'border-signal/60 bg-signal/15 text-signal' : 'border-white/10 text-paper-dim hover:text-paper'}`}
        >
          <Crosshair size={15} aria-hidden />
        </button>
      </div>
      {picking && <p className="mt-1.5 text-[0.6875rem] text-signal">Click the map where the mine should be.</p>}

      <label className="mt-3 block">
        <span className="flex justify-between text-[0.75rem] text-paper-faint">
          Confidence <span className="font-mono text-paper">{conf.toFixed(2)}</span>
        </span>
        <input type="range" min={0.05} max={0.99} step={0.01} value={conf} onChange={(e) => setConf(Number(e.target.value))} className="mt-1 w-full accent-[var(--signal)]" />
      </label>

      <Button variant="primary" className="mt-4 w-full" disabled={!ready} onClick={() => void send()} icon={<Send size={13} aria-hidden />}>
        {state.kind === 'sending' ? 'Sending…' : 'Send through the pipeline'}
      </Button>
      {state.kind === 'ok' && <p className="mt-2 text-[0.75rem] text-cleared">{state.msg}</p>}
      {state.kind === 'error' && <p className="mt-2 text-[0.75rem] text-hazard-lit">{state.msg}</p>}
      <p className="mt-3 text-[0.6875rem] leading-snug text-paper-faint">
        Labelled "Test injection" everywhere. It is never counted as a flown find.
      </p>
    </section>
  )
}

function Coord({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="min-w-0 flex-1">
      <span className="mb-1 block text-[0.75rem] text-paper-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="h-9 w-full rounded-md border border-white/10 bg-ink-deep px-2 font-mono text-[0.75rem] text-paper focus:border-signal/50 focus:outline-none"
      />
    </label>
  )
}
