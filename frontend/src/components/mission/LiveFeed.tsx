import { useCallback, useEffect, useRef, useState } from 'react'
import { Minimize2, Radio, RotateCw, X } from 'lucide-react'
import {
  HAS_JETSON_STREAM,
  JETSON_STREAM_PAGE_URL,
  JETSON_STREAM_URL,
} from '@/lib/config'
import { usePersistedState } from '@/hooks/usePersistedState'
import { isBoolean } from '@/lib/persistedState'

/**
 * LiveFeed — the aircraft's camera.
 *
 * The feed is an MJPEG stream (`multipart/x-mixed-replace`) served by
 * `jetson/stream.py`. An `<img>` consumes that natively: the browser paints each
 * part as it arrives, so there is no fetch loop, no blob lifecycle to manage, and
 * no CORS preflight. A `<video>` would need the stream re-muxed, so `<img>` is not
 * a shortcut — it is the correct element for this format.
 *
 * ── Three display modes, because one is not enough ─────────────────────────────
 *
 *   normal  a 320 px picture-in-picture, docked bottom-left over the map. Shown
 *           while the operator is working the map and wants the camera as a
 *           peripheral glance.
 *   docked  a full-height column beside the map, the camera as a co-equal panel.
 *           This is the resting state on Mission Control: the picture is the
 *           subject and the map is the context, not the other way round.
 *   full    a full-viewport view, letterboxed against black. For the moments the
 *           picture *is* the task — reading a suspicious patch of ground, or
 *           checking the detector's boxes against the imagery behind them.
 *
 * All three render the *same* `<img>` element in the *same* DOM position, and only
 * the container's classes change. That is deliberate: re-parenting the element would
 * remount it, which drops the MJPEG connection and re-opens a publisher slot on the
 * Jetson. Switching view size must not interrupt the stream.
 *
 * ── Why the states are this explicit ─────────────────────────────────────────────
 *
 * This panel sits over a map that is currently showing a live mission. A blank
 * rectangle there is ambiguous in the worst way: is the camera off, is the aircraf out of range, is the detector down, or did the page fail to load it? An operator
 * cannot act on any of those if they cannot tell them apart. So the feed resolves to
 * a named state with its own remedy, and says which one it is.
 *
 * The distinction that matters most is between *connected* and *streaming*: the
 * pipeline can be up while the detector is stopped, in which case frames arrive but
 * carry no boxes. Telling the operator the difference between "camera offline" and
 * "camera live, detection paused" is the whole point of the status strip.
 */

type FeedState = 'idle' | 'loading' | 'live' | 'offline'

/** How the picture is presented. Not a size setting — three different jobs. */
type DisplayMode = 'normal' | 'docked' | 'full'

export type { DisplayMode as LiveFeedDisplayMode }

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
  /**
   * Fill the parent as a column instead of floating over the map.
   *
   * The caller owns the column's width and height (it is a flex/grid child); this
   * component only decides how the picture is laid out inside whatever box it is
   * given. It starts in `docked` rather than `normal`, because a caller that has
   * set aside a column for the camera is not asking for a picture-in-picture.
   */
  docked = false,
  /**
   * Override the docked column's width, in pixels.
   *
   * Omitted means the `w-camera` clamp decides, which is the resting layout. The
   * value comes from the drag divider (`SplitHandle`), which is why it is a pixel
   * count rather than a class: the operator chose that measurement and it must
   * survive a re-render unchanged, not be re-derived from a viewport percentage.
   *
   * Applied as a custom property, not `style={{ width }}` — the docked root is
   * `w-full` below `lg`, where the panes stack and there is no column to size.
   * A plain inline width would override that and leave a 384px-wide feed sitting
   * in a full-width stack on a phone.
   */
  widthPx,
  /**
   * Reports which view the operator has selected.
   *
   * Mission Control needs this: the drag divider may only be rendered while the
   * feed is actually a column beside the map. In `Pip` the feed is absolutely
   * positioned and the map owns the full row, so a divider would be a 6px band
   * with nothing on its right that resizes nothing when dragged.
   */
  onDisplayModeChange,
}: {
  defaultOpen?: boolean
  detectorRunning?: boolean
  docked?: boolean
  widthPx?: number
  onDisplayModeChange?: (mode: DisplayMode) => void
}) {
  // Remembered across reloads: an operator who hid the camera to clear the map
  // should not have it reappear every time the console is refreshed.
  const [open, setOpen] = usePersistedState('camera-open', defaultOpen, isBoolean)
  const [mode, setMode] = useState<DisplayMode>(docked ? 'docked' : 'normal')
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
   * handling (which clears the detection selection) the rest of the time. It
   * returns to whichever view the panel was given, not always to the PiP.
   */
  useEffect(() => {
    if (mode !== 'full') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode(docked ? 'docked' : 'normal')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, docked])

  /**
   * Tell the caller which view is selected, so it can place the drag divider.
   *
   * Reported rather than lifted: the mode is the feed's own business — it is the
   * thing whose DOM changes — and asking the parent to hold it would mean the
   * parent re-rendering the map whenever the operator toggles the camera, which
   * is the kind of coupling the comment above is about avoiding.
   */
  useEffect(() => {
    onDisplayModeChange?.(mode)
  }, [mode, onDisplayModeChange])

  /**
   * The column width, as a custom property plus a class that reads it.
   *
   * Only one of the two is ever emitted. `var(--feed-width)` with nothing set is
   * invalid at computed-value time, and `width` is not inherited, so it would
   * resolve to `auto` — a docked column that silently collapses instead of
   * falling back to the clamp. Selecting the class by the same condition as the
   * property is what keeps that impossible.
   */
  const widthStyle =
    widthPx === undefined
      ? undefined
      : ({ '--feed-width': `${widthPx}px` } as React.CSSProperties)
  const dockedWidthClass =
    widthPx === undefined ? 'lg:w-camera' : 'lg:[width:var(--feed-width)]'

  if (!HAS_JETSON_STREAM) return null

  if (!open) {
    /*
     * Hidden. In docked form the chip fills the column the feed owns rather than
     * floating over the map — otherwise "hidden" would leave an empty column and a
     * stray button in the corner of the map, which is worse than either state.
     */
    return (
      <div
        style={widthStyle}
        className={
          docked
            ? `flex min-h-[260px] w-full shrink-0 items-center justify-center border-t border-rule bg-ink-deep/92 lg:min-h-0 lg:border-l lg:border-t-0 ${dockedWidthClass}`
            : 'pointer-events-auto absolute bottom-3 left-3 z-[520]'
        }
      >
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            if (state !== 'live') retry()
          }}
          className="flex items-center gap-1.5 border border-rule bg-ink-deep/92 px-2 py-1.5 font-display text-tiny uppercase tracking-[0.1em] text-paper-dim backdrop-blur-sm hover:bg-ink-hover hover:text-paper"
          title="Show camera feed"
        >
          <Radio size={11} />
          Camera
        </button>
      </div>
    )
  }

  const full = mode === 'full'
  const isDocked = docked && mode === 'docked'

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
          : isDocked
            ? // The column, owned by the feed itself.
              //
              // This used to be a wrapper in `MissionControl` — a `shrink-0` flex
              // child holding the feed. That arrangement could not be unmounted
              // when the operator switched to PiP without also unmounting the feed
              // (and dropping the MJPEG socket with it), so the column had to stay
              // and became an empty bordered plate where the picture used to be.
              //
              // Sizing the root here instead means one element swaps between a
              // column and a floating box. Nothing is left behind, and the `<img>`
              // is never re-parented, so the stream survives the switch.
              //
              // The width is `w-camera` — a clamp, not a percentage. See the token:
              // a percentage here resolved against the whole flex row (dock
              // included) and left the map 50px wider than the camera. It is
              // replaced by an explicit pixel width when the operator has dragged
              // the divider, which is the only case where the column should not
              // simply take what the clamp would give it.
              `flex min-h-[260px] w-full shrink-0 flex-col border-t border-rule bg-ink-deep lg:min-h-0 lg:border-l lg:border-t-0 ${dockedWidthClass}`
            : 'pointer-events-auto absolute bottom-3 left-3 z-[520] w-[320px] animate-rise-in border border-rule-bright bg-ink-deep/94 backdrop-blur-sm'
      }
      style={widthStyle}
    >
      {/* Status strip — the honest header. */}
      <div className="flex items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <StateDot state={state} />
          <span className="font-display text-tiny uppercase tracking-[0.1em] text-paper">
            Camera
          </span>
          <span className="truncate font-mono text-tiny text-paper-faint">
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
            {docked && (
              <ModeButton
                active={isDocked}
                label="Panel"
                title="Beside the map, at full height"
                onClick={() => setMode('docked')}
              />
            )}
            <ModeButton
              active={!full && !isDocked}
              label="Pip"
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
              setMode(docked ? 'docked' : 'normal')
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
       * The feed itself.
       *
       * Sizing is per mode because the failure is different in each one.
       *
       *   full    the picture takes the window and is letterboxed against black.
       *   docked  a tall, narrow column holding a 16:9 picture. Taking the full
       *           height there and letterboxing inside it produced a 587×834 black
       *           slab of which ~330 px was image — the rest read as a dead feed,
       *           not a letterbox. So a live picture is fitted to the column's
       *           *width* and the column simply ends where the picture does; the
       *           leftover height is chrome, not a black rectangle. Before a frame
       *           lands there is no aspect to fit to, so the box takes the height
       *           and the message centres in it.
       *   normal  a fixed `aspect-video` tile, but only once there is a picture.
       *
       * The `<img>` element itself never moves in the tree, only its classes change.
       */}
      <div
        className={
          full
            ? 'relative min-h-0 flex-1 bg-black'
            : isDocked
              ? state === 'live'
                ? 'relative shrink-0 bg-black'
                : 'relative grid min-h-0 flex-1 place-items-center bg-black'
              : state === 'live'
                ? // PiP with a picture: a fixed tile, so the map behind never
                  // reflows as frames arrive.
                  'relative aspect-video bg-ink-deep'
                : // PiP without one: no tile at all.
                  //
                  // Reserving an `aspect-video` plate for a stream that has not
                  // delivered a frame drew a 320×180 bordered black rectangle in
                  // the corner of the map with a 10 px "connecting..." inside it —
                  // a dead box that could be mistaken for a hole in the layout. The
                  // panel shrink-wraps the message instead, so the footprint
                  // matches what is actually on screen.
                  'relative bg-ink-deep'
        }
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
            /*
             * `object-contain` throughout: the picture is evidence, so it is never
             * cropped to fill a box. In the docked column the image is allowed to
             * size from its own aspect (`w-full`, height auto) and is capped rather
             * than stretched, which is what keeps the black down to nothing.
             */
            className={
              isDocked ? 'max-h-full w-full object-contain' : 'h-full w-full object-contain'
            }
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

        {state === 'offline' &&
          (full || isDocked ? (
            <FeedOffline onRetry={retry} />
          ) : (
            /*
             * PiP with no picture.
             *
             * This state gets its own compact treatment instead of the full
             * `FeedOffline` card, because the card is `absolute inset-0` and needs
             * a box to fill — and the whole point of this branch is that there is
             * no box. A 320 px tile with a paragraph in it was itself the clutter.
             * So: one line of what happened, and the retry.
             */
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="min-w-0 truncate font-mono text-tiny text-paper-dim">
                No signal from the aircraft
              </span>
              <button
                type="button"
                onClick={retry}
                className="shrink-0 border border-rule px-1.5 py-0.5 font-display text-tiny uppercase tracking-[0.1em] text-paper hover:bg-ink-hover"
              >
                Retry
              </button>
            </div>
          ))}
        {state === 'loading' && (
          <div
            className={
              full || isDocked
                ? 'absolute inset-0 grid place-items-center'
                : 'px-2 py-1.5'
            }
          >
            <span className="font-mono text-tiny text-paper-faint">connecting...</span>
          </div>
        )}

        {/*
         * Provenance. The map beside this is simulated; the picture is not.
         *
         * Only drawn over an actual picture. On a PiP with no frame there is no
         * `bottom` to sit on and the labels would stack onto the message above.
         */}
        {(state === 'live' || full || isDocked) && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-ink-deep/90 to-transparent px-2 py-1">
            <span className="font-mono text-tiny text-paper-faint">
              {state === 'live' ? 'LIVE' : state === 'offline' ? 'NO SIGNAL' : '--'}
            </span>
            <span className="font-mono text-tiny text-paper-faint">
              {intrinsic ? `${intrinsic.w}×${intrinsic.h}` : '--'}
            </span>
          </div>
        )}
      </div>

      {/* Task-relevant caveat, stated once, where it is read. */}
      <p className="border-t border-rule px-2 py-1 text-tiny leading-snug text-paper-faint">
        {detectorRunning ? (
          <>Detections on this feed are drawn on the aircraft, not here.</>
        ) : (
          <>
            Camera feed only. The detector is not running, so no boxes are drawn.
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
      className={`px-2 py-0.5 font-display text-tiny uppercase tracking-[0.1em] transition-colors ${
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
      <span className="font-display text-tiny uppercase tracking-[0.14em] text-caution">
        No signal
      </span>
      <p className="max-w-[34ch] text-tiny leading-relaxed text-paper-dim">
        Nothing is publishing on the camera port. Either the aircraft's capture
        pipeline is stopped, or this machine cannot reach it.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="border border-rule px-2 py-0.5 font-display text-tiny uppercase tracking-[0.1em] text-paper hover:bg-ink-hover"
        >
          Retry
        </button>
        <a
          href={JETSON_STREAM_PAGE_URL}
          target="_blank"
          rel="noreferrer"
          className="border border-rule px-2 py-0.5 font-display text-tiny uppercase tracking-[0.1em] text-paper-dim hover:bg-ink-hover hover:text-paper"
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