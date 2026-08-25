import { useEffect, useRef, useState } from 'react'
import { Plug, Upload } from 'lucide-react'
import { ApiError, checkHealth, detectUpload } from '@/lib/api'
import { Button } from '@/components/ui/Button'

/**
 * BackendCheck — exercise the one endpoint that actually exists.
 *
 * `POST /api/detect` is real today, so this lets you push an image at the live
 * FastAPI service and see exactly what comes back. It is deliberately walled off
 * from the mission data: the result is shown as a raw response, never merged into
 * the map or the queue, because mixing a real detection into a simulated mission
 * would make the whole screen's provenance unreadable.
 *
 * Think of it as a wiring test between this UI and the backend, not a feature.
 */
export function BackendCheck() {
  const [open, setOpen] = useState(false)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Poll health only while the panel is open — no point pinging otherwise.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void checkHealth().then((ok) => {
      if (!cancelled) setHealthy(ok)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const onFile = async (file: File) => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await detectUpload(file)
      setResult(JSON.stringify(res, null, 2))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed for an unknown reason.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 border border-rule px-2 py-1 font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim hover:border-rule-bright hover:text-paper"
      >
        <Plug size={11} aria-hidden />
        Backend check
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[320px] animate-rise-in border border-rule-bright bg-ink-raised p-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.5)]">
          <p className="eyebrow mb-1.5">FastAPI connection</p>

          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 ${
                healthy === null ? 'bg-paper-faint' : healthy ? 'bg-cleared' : 'bg-hazard'
              }`}
              aria-hidden
            />
            <span className="font-mono text-[11px] text-paper">
              {healthy === null ? 'Checking /health…' : healthy ? 'Backend up' : 'Backend unreachable'}
            </span>
          </div>

          {healthy === false && (
            <p className="mt-1.5 text-[10px] leading-snug text-paper-dim">
              Start it from the repo root:
              <code className="mt-1 block bg-ink px-1.5 py-1 font-mono text-[10px] text-paper">
                uvicorn app.main:app --reload --app-dir ./backend
              </code>
            </p>
          )}

          <div className="rule-line my-2.5" />

          <p className="eyebrow mb-1.5">POST /api/detect</p>
          <p className="mb-2 text-[10px] leading-snug text-paper-faint">
            Sends one image to the live detector and prints the raw response. The result
            is not added to the mission — this only tests the wiring.
          </p>

          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
            }}
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            icon={<Upload size={12} aria-hidden />}
            className="w-full"
          >
            {busy ? 'Sending…' : 'Choose an image'}
          </Button>

          {error && (
            <p className="mt-2 border-l-2 border-hazard pl-2 text-[10px] leading-snug text-hazard">
              {error}
            </p>
          )}

          {result && (
            <pre className="mt-2 max-h-40 overflow-auto border border-rule bg-ink p-2 font-mono text-[10px] leading-relaxed text-paper">
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
