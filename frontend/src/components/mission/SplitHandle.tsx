import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CAMERA_PX,
  HANDLE_PX,
  MIN_CAMERA_PX,
  cameraWidthAfterDrag,
  cameraWidthAfterKey,
} from '@/lib/splitPane'

/**
 * SplitHandle — the divider between the map and the camera.
 *
 * A sibling of the two panes rather than an overlay on either of them, because it
 * has to be a flex item to claim its own width: an absolutely positioned handle
 * would sit *on top of* the map's right edge, and every pixel of drag start over
 * the map is a pixel the map's own pan handler would otherwise get.
 *
 * ── Why pointer capture, not mousemove on window ──────────────────────────────
 *
 * `setPointerCapture` retargets every subsequent pointer event to this element, so
 * the drag keeps working when the pointer passes over the map, the feed, or
 * leaves the window entirely. The alternative — a window-level `mousemove` — is
 * the classic way to end up with a stuck drag: the release lands on something
 * that stopped propagation, `mouseup` never fires here, and the pane is still
 * following the pointer minutes later. It also gives touch and pen support for
 * free, which `mousedown` does not.
 *
 * ── Nothing here decides the bounds ───────────────────────────────────────────
 *
 * `maxWidth` is computed by the caller from the measured row, and the clamp itself
 * lives in `lib/splitPane.ts` where it is tested. This component converts pointer
 * positions and key names into a proposed width and reports it; it does not know
 * why 512px has to stay free for the map.
 */
export function SplitHandle({
  /** Current camera width, already clamped by the caller. */
  width,
  /** The widest the camera may be on the row as it stands. */
  maxWidth,
  /** Called with a clamped width on every drag step and key press. */
  onChange,
  /** Defaults to the map/camera divider's own wording; `aria-valuetext` follows. */
  label = 'Resize camera panel',
}: {
  width: number
  maxWidth: number
  onChange: (next: number) => void
  label?: string
}) {
  const [dragging, setDragging] = useState(false)

  /**
   * Where the drag started.
   *
   * The start width is captured at pointer-down rather than accumulated per move.
   * Accumulating drifts, and — worse — a drag that overshoots a bound loses the
   * width it came from, so pulling back would not return the pane to where the
   * operator picked it up.
   */
  const start = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only: a right-click or a middle-click on the divider is
      // not a drag, and capturing the pointer for one would swallow the menu.
      if (e.button !== 0) return

      start.current = { x: e.clientX, width }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
      // The divider is a control, not text — but a drag that starts here and
      // crosses the map would otherwise select map labels on the way past.
      e.preventDefault()
    },
    [width],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const from = start.current
      if (!from) return

      const next = cameraWidthAfterDrag(from.width, e.clientX - from.x, maxWidth)
      // A width that has not changed still reaches `onChange`, which is a no-op
      // write for the same value — cheaper than tracking the last reported width
      // in a second ref that could disagree with this one.
      if (next !== width) onChange(next)
    },
    [maxWidth, width, onChange],
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    start.current = null
    setDragging(false)

    const target = e.currentTarget
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next = cameraWidthAfterKey(width, e.key, maxWidth, e.shiftKey)
      // `null` means the key is not ours. Returning early without preventDefault
      // is what keeps `Tab` able to move focus off the divider — otherwise the
      // separator would be a keyboard trap.
      if (next === null) return

      e.preventDefault()
      if (next !== width) onChange(next)
    },
    [width, maxWidth, onChange],
  )

  /**
   * Cursor and text selection, owned by the document for the duration of a drag.
   *
   * Both are set here rather than on the element because the pointer is very often
   * not over the element mid-drag: without `col-resize` on the body the cursor
   * flickers to a text caret as it crosses the map, and without `user-select: none`
   * the drag paints a selection across every label between the two panes.
   */
  useEffect(() => {
    if (!dragging) return

    const { body } = document
    const previousCursor = body.style.cursor
    const previousSelect = body.style.userSelect

    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'

    return () => {
      body.style.cursor = previousCursor
      body.style.userSelect = previousSelect
    }
  }, [dragging])

  /**
   * Below `lg` the two panes stack and there is no divider to drag.
   *
   * `hidden` rather than `lg:flex` alone, because a zero-height flex item on a
   * stacked column would still be a 6px band between the map and the feed, and
   * because the persisted width would then be applied to a full-width feed.
   */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={MIN_CAMERA_PX}
      aria-valuemax={maxWidth}
      // Screen readers hear a bare number otherwise. The unit is the whole
      // meaning of the control.
      aria-valuetext={`${width} pixels wide`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset. Arrow keys also work."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(DEFAULT_CAMERA_PX)}
      style={{ width: HANDLE_PX }}
      className={`hidden shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center border-l border-rule bg-ink lg:flex ${
        dragging ? 'bg-ink-hover' : 'hover:bg-ink-raised'
      }`}
    >
      {/*
       * The grip. Two hairlines, not a dotted texture: chrome is colourless in
       * this palette (see the palette rule in tailwind.config.ts), so the only
       * thing this mark may do is get brighter. `rule-bright` is the strongest
       * neutral available without becoming a hazard signal.
       */}
      <div
        aria-hidden
        className={`my-2 w-px self-center transition-colors ${
          dragging ? 'h-16 bg-paper-faint' : 'h-10 bg-rule-bright'
        }`}
      />
    </div>
  )
}