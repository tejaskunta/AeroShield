import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  M_PER_PIXEL_AT_EQUATOR_Z0,
  isBelowAffordableZoom,
  metresPerPixel,
  pixelsPerMetre,
  spanToPixels,
  zoomToFit,
} from './scale.ts'

/**
 * The scale the map is supposed to run at, pinned.
 *
 * These tests exist to stop a specific regression: the live map measured `z=20`
 * while `INITIAL_ZOOM` and `MAX_ZOOM` both said 22, and at zoom 20 the ten-metre
 * block covers seventy pixels, which is the difference between "the aircraft is
 * flying a survey" and "the aircraft is jittering in place". Nothing in the codebase
 * *asserted* what 22 meant in metres, so nothing noticed.
 *
 * Everything is anchored to the survey origin's latitude. The block is ten metres
 * across and the operator has to read motion within it, so the tolerances below are
 * in metres and pixels — the units the complaint was actually made in.
 */

/** The survey origin's latitude, from `config.ts`. */
const LAT = 17.396947

/** The survey block, edge to edge, in metres. One-metre cells, ten of them. */
const BLOCK_M = 10

/**
 * A tenth of a pixel.
 *
 * `156543.03392` carries more precision than the classification of the Earth's
 * radius in EPSG:3857 justifies, but the arithmetic here is exact — floating point
 * accumulation over three operations is around 1e-13 relative — so the budget is for
 * the decimal literal, not the model.
 */
const PX = 0.1

test('the zoom-0 tile constant is the Web Mercator sphere', () => {
  // 2π·6378137 / 256 = 156543.03392804097
  assert.ok(
    Math.abs(M_PER_PIXEL_AT_EQUATOR_Z0 - 156543.03392804097) < 1e-6,
    `expected 156543.03392, got ${M_PER_PIXEL_AT_EQUATOR_Z0}`,
  )
})

test('a metre is 28 px at zoom 22 over the survey block', () => {
  const ppm = pixelsPerMetre(22, LAT)
  assert.ok(Math.abs(ppm - 28.08) < PX, `expected ~28.08 px/m at z22, got ${ppm}`)
  // And the consequence the whole exercise is about.
  assert.ok(
    Math.abs(spanToPixels(BLOCK_M, 22, LAT) - 281) < 1,
    `a 10 m block should be ~281 px at z22, got ${spanToPixels(BLOCK_M, 22, LAT)}`,
  )
})

test('a metre is 7 px at zoom 20 — the reading the live map returned', () => {
  const ppm = pixelsPerMetre(20, LAT)
  assert.ok(Math.abs(ppm - 7.02) < PX, `expected ~7.02 px/m at z20, got ${ppm}`)
  assert.ok(
    Math.abs(spanToPixels(BLOCK_M, 20, LAT) - 70) < 1,
    `a 10 m block is only ~70 px at z20, got ${spanToPixels(BLOCK_M, 20, LAT)}`,
  )
})

test('each zoom step doubles the scale', () => {
  // The reason a single level of difference is not a rounding error. A map one
  // zoom out is showing half the detail, and three padding tweaks that fail to
  // cross that threshold change nothing visible at all.
  for (const z of [18, 19, 20, 21]) {
    const ratio = pixelsPerMetre(z + 1, LAT) / pixelsPerMetre(z, LAT)
    assert.ok(Math.abs(ratio - 2) < 1e-9, `z${z} -> z${z + 1} should double, got ${ratio}`)
  }
})

test('the scale narrows towards the poles', () => {
  // Mercator stretches east-west ground distance as latitude rises, so a pixel
  // covers *less* ground — the same imagery fits more metres. A formula that
  // dropped the cosine term would place the India origin about 5 % wrong.
  assert.ok(pixelsPerMetre(22, 0) < pixelsPerMetre(22, LAT))
  assert.ok(pixelsPerMetre(22, 60) > pixelsPerMetre(22, LAT))
})

test('metresPerPixel and pixelsPerMetre are reciprocals', () => {
  for (const z of [18, 20, 21, 22]) {
    assert.ok(
      Math.abs(metresPerPixel(z, LAT) * pixelsPerMetre(z, LAT) - 1) < 1e-12,
      `z${z} is not self-consistent`,
    )
  }
})

/**
 * The fit, and the shape of pane that starves it.
 *
 * This is the diagnosis in test form. `fitBounds` must satisfy both axes, so the
 * shorter one decides — and a `flex-1` map column in a row layout is wide and short,
 * which hands the decision to the height.
 */
test('a 10 m block fits a 724x320 pane at zoom 22', () => {
  // The dimensions an earlier measurement recorded for this map. If the pane really
  // is this size, zoom 22 is available and the live z=20 is not a layout problem.
  assert.equal(zoomToFit(BLOCK_M, 724, 320, 8, LAT), 22)
})

test('a short pane costs zoom, in whole levels at a time', () => {
  // Zoom 22 needs 281 px of height for the block alone, plus 16 px of padding, so
  // anything under ~297 px cannot hold it. A 160 px pane has 144 px usable after
  // padding: too little for z22, just enough for z21's 140 px.
  assert.equal(zoomToFit(BLOCK_M, 724, 160, 8, LAT), 21)

  // The shape that reproduces the live reading: wide, and only ~12 cells deep.
  assert.equal(zoomToFit(BLOCK_M, 724, 120, 8, LAT), 20)
})

test('a letterbox pane costs zoom that widening cannot buy back', () => {
  // This is the layout diagnosis in one assertion. The map column here is
  // `flex-1` inside a row, which grants it *width* and lets the row's stretch
  // decide its height — exactly the wide, short pane above.
  assert.equal(zoomToFit(BLOCK_M, 724, 120, 8, LAT), 20)
  // Making the pane five times wider changes nothing at all...
  assert.equal(zoomToFit(BLOCK_M, 4000, 120, 8, LAT), 20)
  // ...because at zoom 22 this block fits across a 724 px pane nearly three times
  // over. Only the height buys scale.
  assert.ok(spanToPixels(BLOCK_M, 22, LAT) * 2 < 724)
  // Give that same width the height and the zoom follows immediately.
  assert.equal(zoomToFit(BLOCK_M, 724, 320, 8, LAT), 22)
})

test('padding costs whole zoom levels, not fractions', () => {
  // 8 px of padding was intentionally chosen over 48 px. The integral search is
  // why that matters: the cost is not 40 px of view, it is a level of scale.
  assert.equal(zoomToFit(BLOCK_M, 724, 320, 8, LAT), 22)
  assert.equal(zoomToFit(BLOCK_M, 724, 320, 48, LAT), 21)
})

test('the width never decides on a wide pane', () => {
  // The load-bearing assumption behind the layout diagnosis: widening a pane that
  // already holds the block across its width is free, and only height buys zoom.
  assert.equal(zoomToFit(BLOCK_M, 724, 320, 8, LAT), zoomToFit(BLOCK_M, 4000, 320, 8, LAT))
  assert.ok(
    zoomToFit(BLOCK_M, 4000, 120, 8, LAT) < zoomToFit(BLOCK_M, 4000, 320, 8, LAT),
    'shorter should always cost zoom',
  )
})

test('a pane smaller than its own padding has no room', () => {
  // Guards the log of a non-positive ratio rather than returning a NaN that would
  // silently become `undefined` in a `setZoom` call.
  assert.equal(zoomToFit(BLOCK_M, 10, 10, 8, LAT), 0)
  assert.equal(zoomToFit(0, 724, 320, 8, LAT), 0)
})

test('the ceiling is not reported as a shortfall', () => {
  // The readout lit amber on a healthy map: a 904x744 pane affords zoom 23 for the
  // block, the imagery caps the map at 22, and a bare `affordable > zoom` called
  // that one level short. Reproduced live before the fix — the instrument's own
  // correct reading, reported as a fault.
  const affordable = zoomToFit(BLOCK_M, 904, 744, 8, LAT)
  assert.equal(affordable, 23)
  assert.equal(isBelowAffordableZoom(22, affordable, 22), false)
})

test('a genuine shortfall is still reported', () => {
  // The other half, and the one that matters more: clearing the false amber must
  // not blind the diagnostic. This is the shape of the real bug — the map left
  // sitting at zoom 20 by a fit taken while the pane was short, while the pane it
  // now has affords the full 22. That is a shortfall and must read as one.
  assert.equal(zoomToFit(BLOCK_M, 724, 156, 8, LAT), 20)
  assert.equal(isBelowAffordableZoom(20, 22, 22), true)
})
