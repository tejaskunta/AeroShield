/**
 * The map / camera divider — the pure half.
 *
 * Same split as everywhere else in `lib/`: the arithmetic lives here, where the
 * Node test runner can reach it, and the pointer events and refs stay in the
 * component. That matters more than usual for a drag handler, because the *only*
 * interesting question is "how wide may the camera be?", and getting it wrong has
 * a visible failure mode — the map is pushed under its legibility floor and
 * `main` is `overflow-hidden`, so the dock on the far right is clipped off-screen
 * rather than scrolled to.
 *
 * ── Why the bounds are computed, not clamped to a magic number ─────────────────
 *
 * The camera column used to be `clamp(18rem, 26vw, 24rem)` — a CSS expression that
 * knows nothing about the map beside it. Free-dragging needs the opposite
 * property: the camera may take whatever space the map can spare, and not one
 * pixel more. So the ceiling is derived from the measured row, the measured dock
 * and the map's own floor, and `MAX_CAMERA_PX` is only there to stop a very wide
 * row handing the camera more than it can usefully show.
 *
 * ── Sign conventions ──────────────────────────────────────────────────────────
 *
 * The divider sits between the map (left) and the camera (right). Everything here
 * is expressed in that frame: dragging the handle *right* shrinks the camera, and
 * `ArrowLeft` grows it. Getting this inverted is the classic resizer bug, so the
 * conversion happens in exactly one place — `cameraWidthAfterDrag` — rather than
 * at each call site.
 */

/** The `camera` token's floor: below this the picture is a thumbnail, not a panel. */
export const MIN_CAMERA_PX = 288

/** Above this the camera stops being a co-equal panel and becomes the whole view. */
export const MAX_CAMERA_PX = 720

/**
 * Where a double-click on the handle returns to.
 *
 * `24rem` — the camera token's own ceiling, which is what the column already
 * rendered at on any row wide enough to run the clamp out. So the default the
 * operator gets without ever touching the divider is the layout they had before
 * it existed.
 */
export const DEFAULT_CAMERA_PX = 384

/** The map's floor, matching the `canvas` token (`32rem`). Not a preference. */
export const MAP_MIN_PX = 512

/** The `dock` token. Only used before the real dock has been measured. */
export const DOCK_FALLBACK_PX = 320

/** Width of the divider itself, which also comes out of the map's share. */
export const HANDLE_PX = 6

/** One arrow key. */
export const STEP_PX = 16

/** `Shift` + arrow key — for crossing the range without holding the key down. */
export const BIG_STEP_PX = 64

/**
 * Type predicate for the persisted width.
 *
 * Without this, `usePersistedState` would hand back whatever a previous build
 * happened to write. `JSON.parse('null')` succeeds and returns `null`, and
 * `clampCameraWidth(null, …)` would then arithmetic its way to `NaN` from a
 * `Number.isFinite` check that never ran. The guard rejects it at the boundary so
 * no downstream code has to wonder.
 */
export function isCameraWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The widest the camera may be on this row.
 *
 * Read as: take the row, give the dock its width, take the handle, and leave the
 * map its floor; whatever is left is the camera's. The result is never below
 * `MIN_CAMERA_PX` — a row too narrow for both gets the minimum rather than a
 * negative width, because a squeezed layout that still shows both panes is
 * recoverable by the operator and a `width: -40px` is not.
 *
 * An unmeasured row (zero, `NaN`, before the first `ResizeObserver` callback)
 * returns `MAX_CAMERA_PX`. That is the honest answer to "I do not know yet": the
 * alternative — returning the minimum — would render the default camera width as
 * a sliver for one frame on every load.
 */
export function maxCameraWidth(rowWidth: number, dockWidth: number): number {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return MAX_CAMERA_PX

  const dock = Number.isFinite(dockWidth) && dockWidth > 0 ? dockWidth : DOCK_FALLBACK_PX
  const room = rowWidth - dock - HANDLE_PX - MAP_MIN_PX

  return Math.min(MAX_CAMERA_PX, Math.max(MIN_CAMERA_PX, Math.round(room)))
}

/**
 * Clamp a camera width into `[MIN_CAMERA_PX, max]`.
 *
 * Rounding happens here rather than at the call site because a fractional width
 * reaches an inline style and produces sub-pixel seams between the map and the
 * feed — the divider would appear to have a hairline of map showing through it at
 * some pointer positions and not others.
 */
export function clampCameraWidth(px: number, max: number): number {
  const ceiling = Math.max(MIN_CAMERA_PX, Math.round(max))
  // A non-finite width means the stored value or the measurement was unusable,
  // and the default is a better answer than either bound.
  if (!Number.isFinite(px)) return Math.min(DEFAULT_CAMERA_PX, ceiling)

  return Math.min(ceiling, Math.max(MIN_CAMERA_PX, Math.round(px)))
}

/**
 * The width after a pointer drag.
 *
 * `dx` is how far the pointer moved **to the right**, so it is subtracted: pulling
 * the divider right gives the map more and the camera less. `startWidth` is
 * captured at pointer-down, not read fresh each move — accumulating deltas
 * drifts, and a drag that outruns the clamp would otherwise never recover its
 * original width when dragged back.
 */
export function cameraWidthAfterDrag(startWidth: number, dx: number, max: number): number {
  const applied = Number.isFinite(dx) ? dx : 0
  return clampCameraWidth(startWidth - applied, max)
}

/**
 * The width after a key press, or `null` if the key is not ours.
 *
 * Returning `null` rather than the unchanged width is deliberate: the caller must
 * be able to tell "this key did nothing because it was already at the bound" from
 * "this key is not a resize key at all". Only the second may skip
 * `preventDefault`, so the first cannot silently swallow `Tab` or `Escape`.
 */
export function cameraWidthAfterKey(
  width: number,
  key: string,
  max: number,
  big: boolean = false,
): number | null {
  const step = big ? BIG_STEP_PX : STEP_PX

  switch (key) {
    // Left grows the camera — see the sign convention at the top of the file.
    case 'ArrowLeft':
      return clampCameraWidth(width + step, max)
    case 'ArrowRight':
      return clampCameraWidth(width - step, max)
    case 'Home':
      return clampCameraWidth(MIN_CAMERA_PX, max)
    case 'End':
      return clampCameraWidth(max, max)
    default:
      return null
  }
}