import { useCallback, useEffect, useRef, useState } from 'react'
import { Minimize2, Radio, RotateCw, X } from 'lucide-react'
import {
  HAS_JETSON_STREAM,
  JETSON_STREAM_PAGE_URL,
  JETSON_STREAM_URL,
} from '@/lib/config'

/**
 * LiveFeed — the aircraft's camera.
 *
 * The feed is an MJPEG stream (`multipart/x-mixed-replace`) served by
 * `jetson/stream.py`. An `<img>` consumes that natively: the browser paints each
 * part as it arrives, so there is no fetch loop, no blob lifecycle to manage, and
 * no CORS preflight. A `<video>` would need the stream re-muxed, so `<img>` is not
 * a shortcut — it is the correct element for this format.
 *
 * ── Two display modes, because one is not enough ────────────────────────────────
 *
 *   normal  a 320 px picture-in-picture, docked bottom-left over the map. Shown
 *           while the operator is working the map and wants the camera as a
 *           peripheral glance.
 *   full    a full-viewport view, letterboxed against black. For the moments the
 *           picture *is* the task — reading a suspicious patch of ground, or
 *           checking the detector's boxes against the imagery behind them.
 *
 * Both modes render the *same* `<img>` element in the *same* DOM position, and only
 * the container's classes change. That is deliberate: re-parenting the element would
 * remount it, which drops the MJPEG connection and re-opens a publisher slot on the
 * Jetson. Switching view size must not interrupt the stream.
 *
 * ── Why the states are this explicit ─────────────────────────────────────────────
 *
 * This panel sits over a map that is currently showing a live mission. A blank
 * rectangle there is ambiguous in the worst way: is the camera off, is the aircraft
 * out of range, is the detector down, or did the page fail to load it? An operator
 * cannot act on any of those if they cannot tell them apart. So the feed resolves to
 * a named state with its own remedy, and says which one it is.
 *
 * The distinction that matters most is between *connected* and *streaming*: the
 * pipeline can be up while the detector is stopped, in which case frames arrive but
 * carry no boxes. Telling the operator the difference between "camera offline" and
 * "camera live, detection paused" is the whole point of the status strip.
 */

type FeedState = 'idle' | 'loading' | 'live' | 'offline'

/** How the picture is presented. Not a size setting — two different jobs. */
type DisplayMode = 'normal' | 'full'

/** How long to wait for a first frame before calling it offline. */
const CONNECT_TIMEOUT_MS = 12_000

/** Retry cadence while offline. MJPEG connections can succeed the instant the
 *  publisher starts, so there is no reason to back off in minutes. */
const RETRY_MS = 15_000

export function LiveFeed({
  /** Cost of mounting the feed is non-trivial on a slow link; allow it to be hidden. */
  defaultOpen = true,
  /**
   * The detector's own state, if known. Drives only the wording of the status
   * strip — the feed itself cannot tell whether boxes are being drawn, because an
   * MJPEG stream is just pixels by the time it reaches the browser.
   */
  detectorRunning = false,
}: {
  defaultOpen?: boolean
  detectorRunning?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [mode, setMode] = useState<DisplayMode>('normal')
  const [state, setState] = useState<FeedState>('idle')
  /**
   * The frame's real pixel size, read off the decoded image.
   *
   * This used to be a hardcoded `640×360`, which is right for the current CSI
   * capture but is a caption asserting a fact it has not checked. Reading it from
   * the element means the label stays true if the pipeline is ever reconfigured —
   * and shows as `—` rather than lying before the first frame lands.
   */
  const [intrinsic, setIntrinsic] = useState<{ w: number; h: number } | null>(null)
  /** Bumped to force a fresh `<img>`, which is the only way to retry an MJPEG URL. */
  const [attempt, setAttempt] = useState(0)
  const timerRef = useRef<number | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const retry = useCallback(() => {
    setState('loading')
    setAttempt((a) => a + 1)
  }, [])

  /**
   * A stream that never delivers a first frame does not fire `onError` — it just
   * hangs, because the connection succeeded. Without this watchdog the panel would
   * sit on "connecting" indefinitely, which is indistinguishable from a slow link.
   */
  useEffect(() => {
    if (!open || !HAS_JETSON_STREAM) return
    if (state !== 'loading') return

    timerRef.current = window.setTimeout(() => {
      setState((s) => (s === 'loading' ? 'offline' : s))
    }, CONNECT_TIMEOUT_MS)

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [open, state, attempt])

  /** Re-arm the connection whenever we land in `offline`. */
  useEffect(() => {
    if (!open || state !== 'offline') return
    const t = window.setTimeout(retry, RETRY_MS)
    return () => window.clearTimeout(t)
  }, [open, state, retry])

  /**
   * Release and re-request the stream on unmount or when hidden.
   *
   * Setting `src` to empty is what actually tears down the MJPEG connection —
   * clearing the element from the DOM alone can leave the socket open in some
   * browsers, and on the Jetson each open socket occupies one of a small number of
   * publisher slots.
   */
  useEffect(() => {
    return () => {
      const img = imgRef.current
      if (img) img.src = ''
    }
  }, [])

  /**
   * Escape leaves full view.
   *
   * Registered only while full, so it cannot compete with the map's own Escape
   * handling (which clears the detection selection) the rest of the time.
   */
  useEffect(() => {
    if (mode !== 'full') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('normal')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  if (!HAS_JETSON_STREAM) return null

  if (!open) {
    return (
      <div className="pointer-events-auto absolute bottom-3 left-3 z-[520]">
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            if (state !== 'live') retry()
          }}
          className="flex items-center gap-1.5 border border-rule bg-ink-deep/92 px-2 py-1.5 font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim backdrop-blur-sm hover:bg-ink-hover hover:text-paper"
          title="Show camera feed"
        >
          <Radio size={11} />
          Camera
        </button>
      </div>
    )
  }

  const full = mode === 'full'

  return (
    <div
      className={
        full
          ? // Full view is `fixed`, and deliberately has no `backdrop-blur`. A
            // backdrop filter creates a containing block, so a `fixed` descendant
            // would resolve against the blurred panel rather than the viewport —
            // the panel would then be fixed to itself and fill only the PiP box.
            // An opaque backdrop does the same job with no cascade side effect.
            'pointer-events-auto fixed inset-0 z-[900] flex flex-col bg-ink-deep animate-rise-in'
          : 'pointer-events-auto absolute bottom-3 left-3 z-[520] w-[320px] animate-rise-in border border-rule-bright bg-ink-deep/94 backdrop-blur-sm'
      }
    >
      {/* Status strip — the honest header. */}
      <div className="flex items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <StateDot state={state} />
          <span className="font-display text-[10px] uppercase tracking-[0.1em] text-paper">
            Camera
          </span>
          <span className="truncate font-mono text-[10px] text-paper-faint">
            {statusText(state, detectorRunning)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={retry}
            aria-label="Reload feed"
            title="Reload feed"
            className="text-paper-faint hover:text-paper"
          >
            <RotateCw size={11} />
          </button>
          {/*
           * Two labelled view buttons rather than one toggle icon. "Enlarge" and
           * "Shrink" describe a size; these two are not sizes, they are a glance and
           * a study, and the labels should say which is which.
           */}
          <div role="radiogroup" aria-label="Camera view" className="flex border border-rule">
            <ModeButton
              active={!full}
              label="Normal"
              title="Docked over the map, for keeping an eye on the picture"
              onClick={() => setMode('normal')}
            />
            <ModeButton
              active={full}
              label="Full"
              title="Fill the window, for reading the picture closely"
              onClick={() => setMode('full')}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setMode('normal')
              setOpen(false)
              // Release the socket immediately rather than waiting for the effect.
              const img = imgRef.current
              if (img) img.src = ''
              setState('idle')
            }}
            aria-label="Hide feed"
            title="Hide"
            className="text-paper-faint hover:text-paper"
          >
            {full ? <Minimize2 size={11} /> : <X size={11} />}
          </button>
        </div>
      </div>

      {/*
       * The feed itself. Aspect is fixed to the source in normal mode, and takes the
       * remaining height in full mode — `object-contain` letterboxes either way, so
       * the picture is never cropped or stretched to fit the panel.
       */}
      <div
        className={full ? 'relative min-h-0 flex-1 bg-black' : 'relative aspect-video bg-ink-deep'}
      >
        {state !== 'offline' && (
          <img
            /**
             * `attempt` in the query string is the retry mechanism. An MJPEG URL is
             * a perpetual connection, so React re-rendering with the same `src` does
             * nothing — the browser sees no change to act on. A changing URL forces a
             * fresh request, and `stream.py` ignores the query.
             */
            key={attempt}
            ref={imgRef}
            src={attempt === 0 ? JETSON_STREAM_URL : `${JETSON_STREAM_URL}?t=${attempt}`}
            alt="Live camera feed from the aircraft"
            className="h-full w-full object-contain"
            onLoad={(e) => {
              setState('live')
              const el = e.currentTarget
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setIntrinsic({ w: el.naturalWidth, h: el.naturalHeight })
              }
            }}
            onError={() => setState('offline')}
          />
        )}

        {state === 'offline' && <FeedOffline onRetry={retry} />}
        {state === 'loading' && (
          <div className="absolute inset-0 grid place-items-center">
            <span className="font-mono text-[10px] text-paper-faint">connecting…</span>
          </div>
        )}

        {/* Provenance. The map beside this is simulated; the picture is not. */}
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-ink-deep/90 to-transparent px-2 py-1">
          <span className="font-mono text-[9px] text-paper-faint">
            {state === 'live' ? 'LIVE' : state === 'offline' ? 'NO SIGNAL' : '—'}
          </span>
          <span className="font-mono text-[9px] text-paper-faint">
            {intrinsic ? `${intrinsic.w}×${intrinsic.h}` : '—'}
          </span>
        </div>
      </div>

      {/* Task-relevant caveat, stated once, where it is read. */}
      <p className="border-t border-rule px-2 py-1 text-[10px] leading-snug text-paper-faint">
        {detectorRunning ? (
          <>Detections on this feed are drawn on the aircraft, not here.</>
        ) : (
          <>
            Camera feed only — the detector is not running, so no boxes are drawn.
            Recorded detections on the map may be older than this picture.
          </>
        )}
      </p>
    </div>
  )
}

/** One of the two camera views. `aria-checked` rather than `aria-pressed` — the two
 *  are mutually exclusive, not independently toggled. */
function ModeButton({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      title={title}
      className={`px-1.5 py-0.5 font-display text-[9px] uppercase tracking-[0.1em] transition-colors ${
        active ? 'bg-ink-hover text-paper' : 'text-paper-faint hover:text-paper'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * The offline state, with a remedy.
 *
 * A missing camera and a stopped detector look identical in a blank panel, so this
 * spells out the likely causes in the order worth checking, and offers the one
 * non-obvious escape hatch (a plain page load, which works when the `<img>`
 * integration does not).
 */
function FeedOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="font-display text-[10px] uppercase tracking-[0.14em] text-caution">
        No signal
      </span>
      <p className="max-w-[34ch] text-[10px] leading-relaxed text-paper-dim">
        Nothing is publishing on the camera port. Either the aircraft's capture
        pipeline is stopped, or this machine cannot reach it.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="border border-rule px-2 py-0.5 font-display text-[10px] uppercase tracking-[0.1em] text-paper hover:bg-ink-hover"
        >
          Retry
        </button>
        <a
          href={JETSON_STREAM_PAGE_URL}
          target="_blank"
          rel="noreferrer"
          className="border border-rule px-2 py-0.5 font-display text-[10px] uppercase tracking-[0.1em] text-paper-dim hover:bg-ink-hover hover:text-paper"
        >
          Open direct ↗
        </a>
      </div>
    </div>
  )
}

/** Connection state as a colour. Amber for "trying", not green — nothing is proven
 *  until a frame lands. */
function StateDot({ state }: { state: FeedState }) {
  const colour =
    state === 'live'
      ? 'bg-cleared'
      : state === 'offline'
        ? 'bg-hazard'
        : state === 'loading'
          ? 'bg-caution animate-pulse'
          : 'bg-paper-faint'
  return <span className={`h-1.5 w-1.5 shrink-0 ${colour}`} aria-hidden />
}

function statusText(state: FeedState, detectorRunning: boolean): string {
  switch (state) {
    case 'live':
      return detectorRunning ? 'streaming · detecting' : 'streaming · no detector'
    case 'loading':
      return 'connecting'
    case 'offline':
      return 'no signal'
    case 'idle':
      return 'hidden'
  }
}