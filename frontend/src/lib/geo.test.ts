import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  M_PER_DEG_LAT,
  bearingDeg,
  cellAt,
  cellId,
  distanceM,
  gridBounds,
  gridCenter,
  mPerDegLon,
  offsetM,
  toLatLngLiteral,
} from './geo.ts'
import { MISSION } from './mockData.ts'
import { positionAtDistance, TOTAL_WALK_M } from './simulation.ts'

/**
 * GPS accuracy at survey scale.
 *
 * The question these tests answer is not "is the geodesy correct in general" — over a
 * ten-metre block a spherical earth and a flat earth agree to well under a millimetre.
 * It is "can this console resolve the aircraft moving across ground the size of a
 * basketball court", because that is the smallest thing an operator here is asked to
 * read. Every assertion is therefore framed as a tolerance in metres against real GPS
 * literals, not as a comparison of two implementations of the same formula.
 *
 * The positions used are genuine WGS-84 decimals around the KMIT survey origin, at the
 * same precision a u-blox receiver reports — seven decimal places, which is about
 * 1.1 cm of latitude. Anything coarser would make the sub-metre tests vacuous.
 */

/** The survey origin, as declared in `mockData.ts`. Everything is measured from here. */
const ORIGIN = MISSION.grid.origin

/**
 * Tolerance for a single metre-scale measurement, in metres.
 *
 * 1 mm. The flat-earth approximation's own error over ten metres is around four
 * orders of magnitude below this, so the budget is entirely for floating-point
 * representation of the decimal literals themselves — not for the model.
 */
const MM = 1e-3

/** A basketball court, FIBA. The size the operator has to be able to read motion at. */
const COURT_LENGTH_M = 28
const COURT_WIDTH_M = 15

test('one metre of northing is one metre of northing', () => {
  const p = offsetM(ORIGIN, 0, 1)
  assert.ok(
    Math.abs(distanceM(ORIGIN, p) - 1) < MM,
    `expected 1 m, measured ${distanceM(ORIGIN, p)} m`,
  )
  // Due north, so the bearing is exactly zero.
  assert.ok(Math.abs(bearingDeg(ORIGIN, p) - 0) < MM)
})

test('one metre of easting is one metre of easting', () => {
  const p = offsetM(ORIGIN, 1, 0)
  assert.ok(
    Math.abs(distanceM(ORIGIN, p) - 1) < MM,
    `expected 1 m, measured ${distanceM(ORIGIN, p)} m`,
  )
  // Due east, so the bearing is exactly ninety.
  assert.ok(
    Math.abs(bearingDeg(ORIGIN, p) - 90) < MM,
    `expected 90 degrees, measured ${bearingDeg(ORIGIN, p)}`,
  )
})

test('a degree of longitude is not a degree of latitude', () => {
  // At 17.4 degrees north the ratio is about 0.954. If this ever comes back as 1.0 the
  // longitude scaling has been dropped somewhere, and every detection east of the
  // origin is silently stretched off its true ground position.
  const ratio = mPerDegLon(ORIGIN.lat) / M_PER_DEG_LAT
  assert.ok(Math.abs(ratio - Math.cos((ORIGIN.lat * Math.PI) / 180)) < 1e-12)
  assert.ok(ratio > 0.95 && ratio < 0.96, `unexpected longitude ratio ${ratio}`)
})

test('sub-metre offsets survive the round trip', () => {
  // Half a metre is the resolution the operator is trusting when they look at two
  // pins and decide they are the same object. It must not quantise to zero.
  for (const d of [0.1, 0.25, 0.5, 0.75]) {
    const east = offsetM(ORIGIN, d, 0)
    const north = offsetM(ORIGIN, 0, d)
    assert.ok(Math.abs(distanceM(ORIGIN, east) - d) < MM, `east ${d} m drifted`)
    assert.ok(Math.abs(distanceM(ORIGIN, north) - d) < MM, `north ${d} m drifted`)
  }
})

test('a half-metre move is distinguishable from a one-metre move', () => {
  // The real risk at this scale is not error, it is *quantisation*: if two positions
  // half a metre apart collapse to the same pixel, the drone looks stationary while it
  // is in fact walking. Guard the separation, not just the accuracy.
  const half = offsetM(ORIGIN, 0, 0.5)
  const full = offsetM(ORIGIN, 0, 1)
  const dHalf = distanceM(ORIGIN, half)
  const dFull = distanceM(ORIGIN, full)
  assert.ok(dFull > dHalf, 'one metre must read further than half a metre')
  assert.ok(dFull - dHalf > 0.499, `separation collapsed to ${dFull - dHalf} m`)
})

test('the four corners of the survey block are exact', () => {
  const { cols, rows, cellSizeM } = MISSION.grid
  const width = cols * cellSizeM
  const depth = rows * cellSizeM

  const cases: [string, number, number][] = [
    ['south-west', 0, 0],
    ['south-east', width, 0],
    ['north-west', 0, depth],
    ['north-east', width, depth],
  ]

  for (const [name, east, north] of cases) {
    const corner = offsetM(ORIGIN, east, north)
    // The diagonal of the block, checked independently of the two legs that produced it.
    const expected = Math.hypot(east, north)
    assert.ok(
      Math.abs(distanceM(ORIGIN, corner) - expected) < MM,
      `${name} corner off by ${distanceM(ORIGIN, corner) - expected} m`,
    )
  }
})

test('the block fits inside a basketball court, so court-scale motion is what is shown', () => {
  const { cols, rows, cellSizeM } = MISSION.grid
  const width = cols * cellSizeM
  const depth = rows * cellSizeM
  assert.ok(width <= COURT_LENGTH_M, `block ${width} m is longer than a court`)
  assert.ok(depth <= COURT_WIDTH_M, `block ${depth} m is wider than a court`)
})

test('a court-sized traverse stays on the ground to the millimetre', () => {
  // Walk the long axis of a court in one-metre steps and check every step accumulates
  // exactly. This is the scale the operator asked to see motion at.
  let travelled = 0
  let previous = ORIGIN
  for (let i = 1; i <= COURT_LENGTH_M; i++) {
    const here = offsetM(ORIGIN, i, 0)
    const step = distanceM(previous, here)
    assert.ok(Math.abs(step - 1) < MM, `step ${i} measured ${step} m`)
    travelled += step
    previous = here
  }
  assert.ok(Math.abs(travelled - COURT_LENGTH_M) < MM, `total ${travelled} m`)
  // And the end point is still where offsetM says it should be, not where the sum
  // drifted to — accumulation must not be how position is derived.
  assert.ok(Math.abs(distanceM(ORIGIN, previous) - COURT_LENGTH_M) < MM)
})

test('bearing is stable across the quadrants', () => {
  const cases: [number, number, number][] = [
    [0, 1, 0],
    [1, 0, 90],
    [0, -1, 180],
    [-1, 0, 270],
  ]
  for (const [east, north, expected] of cases) {
    const p = offsetM(ORIGIN, east, north)
    assert.ok(
      Math.abs(bearingDeg(ORIGIN, p) - expected) < MM,
      `east ${east} north ${north}: expected ${expected}, got ${bearingDeg(ORIGIN, p)}`,
    )
  }
})

test('every grid cell is reachable and one metre across', () => {
  const { cols, rows, cellSizeM } = MISSION.grid
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      // Centre of the cell.
      const centre = offsetM(ORIGIN, (col + 0.5) * cellSizeM, (row + 0.5) * cellSizeM)
      const cell = cellAt(MISSION.grid, centre)
      assert.ok(cell, `cell (${col},${row}) centre fell outside the grid`)
      assert.equal(cellId(cell.col, cell.row), cellId(col, row))

      // And the cell's far corner is still inside it.
      const inside = offsetM(ORIGIN, (col + 0.99) * cellSizeM, (row + 0.99) * cellSizeM)
      const edge = cellAt(MISSION.grid, inside)
      assert.equal(edge && cellId(edge.col, edge.row), cellId(col, row))
    }
  }
})

test('the grid bounds bracket the whole block', () => {
  // `gridBounds` returns `[[swLat, swLon], [neLat, neLon]]` tuples rather than `LatLng`
  // objects, so it is unpacked by index here. Worth asserting explicitly: a reader who
  // assumes the object shape gets `undefined` for every field and an assertion that
  // passes for the wrong reason.
  const [[swLat, swLon], [neLat, neLon]] = gridBounds(MISSION.grid)
  const { cols, rows, cellSizeM } = MISSION.grid
  const expected = offsetM(ORIGIN, cols * cellSizeM, rows * cellSizeM)

  assert.ok(Math.abs(swLat - ORIGIN.lat) < 1e-12, 'south-west latitude is not the origin')
  assert.ok(Math.abs(swLon - ORIGIN.lon) < 1e-12, 'south-west longitude is not the origin')
  assert.ok(
    distanceM({ lat: neLat, lon: neLon }, expected) < MM,
    'north-east bound is not the block corner',
  )

  // The centre is the diagonal midpoint, so it sits half a block from each corner.
  const centre = gridCenter(MISSION.grid)
  assert.ok(
    Math.abs(distanceM(ORIGIN, centre) - (Math.hypot(cols, rows) * cellSizeM) / 2) < MM,
    `centre is ${distanceM(ORIGIN, centre)} m from the origin`,
  )
})

test('the lat/lng spelling crossing is lossless', () => {
  // The domain type spells longitude `lon`; the Maps API spells it `lng`. This is the
  // single crossing point, and a transposition here would put the drone in the sea
  // while every other test in this file still passed.
  const p = offsetM(ORIGIN, 3, 4)
  const literal = toLatLngLiteral(p)
  assert.equal(literal.lat, p.lat)
  assert.equal(literal.lng, p.lon)
  assert.equal(distanceM(p, { lat: literal.lat, lon: literal.lng }), 0)
})

test('the simulated walk wraps instead of ending', () => {
  // Regression guard for the freeze: the walk used to clamp at TOTAL_WALK_M, and since
  // the mission seeds at 70 m of an 88 m walk the aircraft stopped roughly eighteen
  // seconds after load and never moved again.
  const start = positionAtDistance(0)
  const end = positionAtDistance(TOTAL_WALK_M)
  assert.ok(
    distanceM(start, end) < MM,
    `the walk is open by ${distanceM(start, end)} m — it will freeze at the end`,
  )
  // And a point beyond the end keeps moving rather than sticking.
  const past = positionAtDistance(TOTAL_WALK_M + 2)
  const justAfter = positionAtDistance(2)
  assert.ok(distanceM(past, justAfter) < MM, 'wrapping past the end lost the origin')
})

test('consecutive ticks move the aircraft by roughly one metre', () => {
  // 1.0 m/s at 2 Hz, sampled around the whole loop rather than only its first stretch.
  // The earlier version of this test stopped at 80 m and would have walked straight
  // past the stall it was written to catch: the freeze happened at the *end* of the
  // walk, where a clamped position stops changing. Sweeping the full loop means a
  // stall anywhere — including the far end — fails here.
  let worst = Infinity
  let worstAt = 0
  for (let d = 0; d < TOTAL_WALK_M; d += 0.5) {
    const step = distanceM(positionAtDistance(d), positionAtDistance(d + 0.5))
    if (step < worst) {
      worst = step
      worstAt = d
    }
    assert.ok(step > 0.3 && step < 0.7, `at ${d} m a tick moved ${step} m`)
  }
  assert.ok(worst > 0.3, `the aircraft stalled at ${worstAt} m (moved only ${worst} m)`)
})

test('the aircraft never leaves the survey block', () => {
  // The drift terms add a few centimetres of wander on a derived lane position. That is
  // deliberate — but it must never wander off the block, or coverage accounting and the
  // on-screen trace would disagree with the grid.
  const { cols, rows, cellSizeM } = MISSION.grid
  for (let d = 0; d < TOTAL_WALK_M; d += 0.1) {
    const p = positionAtDistance(d)
    const east = (p.lon - ORIGIN.lon) * mPerDegLon(ORIGIN.lat)
    const north = (p.lat - ORIGIN.lat) * M_PER_DEG_LAT
    assert.ok(
      east > -0.5 && east < cols * cellSizeM + 0.5,
      `at ${d} m the aircraft was ${east} m east`,
    )
    assert.ok(
      north > -0.5 && north < rows * cellSizeM + 0.5,
      `at ${d} m the aircraft was ${north} m north`,
    )
  }
})
