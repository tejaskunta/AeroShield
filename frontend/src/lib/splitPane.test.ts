import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BIG_STEP_PX,
  DEFAULT_CAMERA_PX,
  DOCK_FALLBACK_PX,
  HANDLE_PX,
  MAP_MIN_PX,
  MAX_CAMERA_PX,
  MIN_CAMERA_PX,
  STEP_PX,
  cameraWidthAfterDrag,
  cameraWidthAfterKey,
  clampCameraWidth,
  isCameraWidth,
  maxCameraWidth,
} from './splitPane.ts'

/**
 * The divider's arithmetic, pinned.
 *
 * A resizer looks like presentation and is not: its bounds are what stop the map
 * being pushed under its legibility floor, and `main` is `overflow-hidden`, so
 * overshooting does not scroll — it clips the dock off the right edge where the
 * operator cannot reach the panels at all. These are layout-correctness tests.
 */

test('the camera cannot get narrower than its floor', () => {
  assert.equal(clampCameraWidth(10, 600), MIN_CAMERA_PX)
  assert.equal(clampCameraWidth(-400, 600), MIN_CAMERA_PX)
  assert.equal(clampCameraWidth(0, 600), MIN_CAMERA_PX)
})

test('the camera cannot get wider than the computed ceiling', () => {
  assert.equal(clampCameraWidth(5000, 460), 460)
  assert.equal(clampCameraWidth(461, 460), 460)
})

test('a ceiling below the floor still yields the floor', () => {
  // A row too narrow for both panes. The camera gets its minimum rather than a
  // negative or inverted range, and the layout stays recoverable.
  assert.equal(clampCameraWidth(400, 100), MIN_CAMERA_PX)
  assert.equal(maxCameraWidth(900, 320), MIN_CAMERA_PX)
})

test('widths are rounded, so no sub-pixel seam opens between map and feed', () => {
  assert.equal(clampCameraWidth(400.4, 600), 400)
  assert.equal(clampCameraWidth(400.6, 600), 401)
  assert.equal(cameraWidthAfterDrag(400, 1.4, 600), 399)
})

test('the ceiling leaves the map its floor — the arithmetic of the row', () => {
  // 1440 row, 320 dock, 6 handle: 1114 remains, minus a 512 map = 602 for the
  // camera, which is under MAX so it is taken as-is rather than clamped to it.
  assert.equal(maxCameraWidth(1440, 320), 1440 - 320 - HANDLE_PX - MAP_MIN_PX)
  assert.equal(maxCameraWidth(1440, 320), 602)
})

test('a very wide row is capped at the camera maximum, not infinity', () => {
  // 3840 − 320 − 6 − 512 = 3002 available, but a camera wider than 720 is not a
  // co-equal panel any more — the map would be the minority view.
  assert.equal(maxCameraWidth(3840, 320), MAX_CAMERA_PX)
})

test('an unmeasured row reports the maximum rather than the minimum', () => {
  // Zero width is "ResizeObserver has not fired yet". Answering with the floor
  // would render the default 384px column as a sliver on every load.
  assert.equal(maxCameraWidth(0, 320), MAX_CAMERA_PX)
  assert.equal(maxCameraWidth(Number.NaN, 320), MAX_CAMERA_PX)
  assert.equal(maxCameraWidth(-100, 320), MAX_CAMERA_PX)
})

test('an unmeasured dock falls back to the token width', () => {
  // Otherwise a dock measuring 0 before layout settles would hand the camera the
  // dock's 320px as spare room and overflow the row.
  assert.equal(maxCameraWidth(1440, 0), 1440 - DOCK_FALLBACK_PX - HANDLE_PX - MAP_MIN_PX)
  assert.equal(maxCameraWidth(1440, Number.NaN), 1440 - DOCK_FALLBACK_PX - HANDLE_PX - MAP_MIN_PX)
})

test('dragging right shrinks the camera; dragging left grows it', () => {
  // The sign convention, pinned. This is the classic inverted-resizer bug.
  assert.equal(cameraWidthAfterDrag(400, 60, 600), 340)
  assert.equal(cameraWidthAfterDrag(400, -60, 600), 460)
  assert.equal(cameraWidthAfterDrag(400, 0, 600), 400)
})

test('a drag past the ceiling stops at it and recovers on the way back', () => {
  // Deltas are applied against the pointer-down width, not accumulated, so an
  // overshoot does not lose the width the operator started from.
  assert.equal(cameraWidthAfterDrag(400, -900, 600), 600)
  assert.equal(cameraWidthAfterDrag(400, -900 + 900, 600), 400)
})

test('a drag past the floor stops at it', () => {
  assert.equal(cameraWidthAfterDrag(300, 900, 600), MIN_CAMERA_PX)
})

test('a non-finite drag delta is treated as no movement', () => {
  assert.equal(cameraWidthAfterDrag(400, Number.NaN, 600), 400)
  assert.equal(cameraWidthAfterDrag(400, Number.POSITIVE_INFINITY, 600), 400)
})

test('arrow keys move by one step, shift by the big step', () => {
  // Left grows the camera, because the divider moving left gives the camera room.
  assert.equal(cameraWidthAfterKey(400, 'ArrowLeft', 600), 400 + STEP_PX)
  assert.equal(cameraWidthAfterKey(400, 'ArrowRight', 600), 400 - STEP_PX)
  assert.equal(cameraWidthAfterKey(400, 'ArrowLeft', 600, true), 400 + BIG_STEP_PX)
  assert.equal(cameraWidthAfterKey(400, 'ArrowRight', 600, true), 400 - BIG_STEP_PX)
})

test('Home and End go to the bounds', () => {
  assert.equal(cameraWidthAfterKey(400, 'Home', 600), MIN_CAMERA_PX)
  assert.equal(cameraWidthAfterKey(400, 'End', 600), 600)
})

test('an unrelated key reports null so the caller can let it through', () => {
  // The distinction that keeps the handle from swallowing Tab and Escape. If this
  // returned the unchanged width, every keypress on the separator would be
  // preventDefault'd and the operator could not tab away from it.
  assert.equal(cameraWidthAfterKey(400, 'Tab', 600), null)
  assert.equal(cameraWidthAfterKey(400, 'Escape', 600), null)
  assert.equal(cameraWidthAfterKey(400, 'a', 600), null)
  assert.equal(cameraWidthAfterKey(400, 'ArrowUp', 600), null)
})

test('keys respect the bounds instead of stepping past them', () => {
  assert.equal(cameraWidthAfterKey(MAX_CAMERA_PX, 'ArrowLeft', 600), 600)
  assert.equal(cameraWidthAfterKey(MIN_CAMERA_PX, 'ArrowRight', 600), MIN_CAMERA_PX)
})

test('the persisted guard accepts only a usable number', () => {
  assert.equal(isCameraWidth(384), true)
  assert.equal(isCameraWidth(0), true)
  assert.equal(isCameraWidth(-1), true) // in range of the type; clamped on read
  assert.equal(isCameraWidth(null), false)
  assert.equal(isCameraWidth('384'), false)
  assert.equal(isCameraWidth(Number.NaN), false)
  assert.equal(isCameraWidth(Number.POSITIVE_INFINITY), false)
  assert.equal(isCameraWidth(undefined), false)
})

test('a corrupt stored width resolves to the default, not NaN', () => {
  // The failure the guard exists to prevent: JSON.parse('null') succeeds, so an
  // unguarded read hands `null` to the arithmetic below.
  const stored: unknown = null
  const width = isCameraWidth(stored) ? stored : DEFAULT_CAMERA_PX
  assert.equal(clampCameraWidth(width, 600), DEFAULT_CAMERA_PX)
  assert.equal(clampCameraWidth(Number.NaN, 600), DEFAULT_CAMERA_PX)
})

test('the default is inside the range on every realistic row', () => {
  // The default must be reachable: on a 1280px row, 1280 − 320 − 6 − 512 = 442,
  // so 384 survives. On the narrowest lg row the ceiling wins, which is correct.
  assert.equal(clampCameraWidth(DEFAULT_CAMERA_PX, maxCameraWidth(1280, 320)), DEFAULT_CAMERA_PX)
  assert.ok(clampCameraWidth(DEFAULT_CAMERA_PX, maxCameraWidth(1024, 320)) <= DEFAULT_CAMERA_PX)
})