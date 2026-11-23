import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Crosshair, MapPin, X } from 'lucide-react'
import { CONFIGURED_SURVEY_ORIGIN, SURVEY_ORIGIN, SURVEY_ORIGIN_OVERRIDDEN, setSurveyOrigin } from '@/lib/config'

/**
 * Move the survey block: the latitude and longitude of its south-west corner,
 * which is where the pilot stands. Applying reloads the console at the new site.
 */
export function SiteDialog({ onClose }: { onClose: () => void }) {
  const [lat, setLat] = useState(SURVEY_ORIGIN.lat.toFixed(6))
  const [lon, setLon] = useState(SURVEY_ORIGIN.lon.toFixed(6))
  const [note, setNote] = useState<string | null>(null)

  const latN = Number(lat)
  const lonN = Number(lon)
  const valid = lat.trim() !== '' && lon.trim() !== '' && Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 85 && Math.abs(lonN) <= 180

  const pasted = (text: string) => {
    // Accept "17.39, 78.49" pasted into either box, as copied from a map app.
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
    if (!m) return false
    setLat(m[1]!)
    setLon(m[2]!)
    return true
  }

  const locate = () => {
    if (!navigator.geolocation) {
      setNote('This browser has no location service.')
      return
    }
    setNote('Finding your location…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6))
        setLon(pos.coords.longitude.toFixed(6))
        setNote(`Located to ±${Math.round(pos.coords.accuracy)} m.`)
      },
      (err) => setNote(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Could not get a location fix.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  return createPortal(
    <div className="pointer-events-auto fixed inset-0 z-[950] grid place-items-center bg-ink-deep/60 backdrop-blur-[2px] animate-fade-in" onClick={onClose}>
      <div className="w-[min(420px,calc(100%-2rem))] animate-rise-in rounded-xl border border-white/10 bg-ink-raised shadow-glass" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <MapPin size={16} className="text-signal" />
            <span className="text-[0.9375rem] font-semibold text-paper">Survey site</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-md text-paper-faint hover:bg-white/[0.06] hover:text-paper">
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-[0.8125rem] leading-relaxed text-paper-dim">
            The south-west corner of the 10 × 10 m block, where the pilot stands. Imagery, buildings and the survey grid move with it.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['Latitude', lat, setLat],
                ['Longitude', lon, setLon],
              ] as const
            ).map(([label, value, set]) => (
              <label key={label} className="flex flex-col gap-1">
                <span className="text-[0.6875rem] text-paper-faint">{label}</span>
                <input
                  value={value}
                  inputMode="decimal"
                  onChange={(e) => set(e.target.value)}
                  onPaste={(e) => {
                    if (pasted(e.clipboardData.getData('text'))) e.preventDefault()
                  }}
                  className="rounded-md border border-white/10 bg-ink px-2.5 py-1.5 font-mono text-[0.8125rem] text-paper focus:border-signal/60 focus:outline-none"
                />
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={locate} className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-[0.75rem] font-medium text-paper hover:bg-white/[0.05]">
              <Crosshair size={13} /> Use my location
            </button>
            <span className="min-w-0 truncate text-[0.6875rem] text-paper-faint">{note ?? 'Tip: paste "lat, lon" from any map app.'}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            disabled={!SURVEY_ORIGIN_OVERRIDDEN}
            onClick={() => setSurveyOrigin(null)}
            title={`Back to ${CONFIGURED_SURVEY_ORIGIN.lat.toFixed(5)}, ${CONFIGURED_SURVEY_ORIGIN.lon.toFixed(5)}`}
            className="rounded-md px-2.5 py-1.5 text-[0.75rem] font-medium text-paper-dim hover:bg-white/[0.05] hover:text-paper disabled:pointer-events-none disabled:opacity-35"
          >
            Reset to configured site
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => setSurveyOrigin({ lat: latN, lon: lonN })}
            className="rounded-md bg-signal px-3.5 py-1.5 text-[0.8125rem] font-semibold text-ink hover:brightness-110 disabled:opacity-40"
          >
            Move survey here
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
