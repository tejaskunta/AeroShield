import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cameraFootprint, cameraVfovDeg, footprintHalfExtents } from './footprint.ts'
import { distanceM } from './geo.ts'

const P = { lat: 17.396947, lon: 78.490706 }

test('a 62.2° HFOV on a 16:9 frame gives a ~37.5° vertical FOV', () => {
  assert.ok(Math.abs(cameraVfovDeg() - 37.5) < 0.2, String(cameraVfovDeg()))
})

/** At 10 m the CSI frame covers ~12.1 m across and ~6.8 m along. */
test('footprint size scales with altitude', () => {
  const { halfAcross, halfAlong } = footprintHalfExtents(10)
  assert.ok(Math.abs(halfAcross * 2 - 12.06) < 0.05, String(halfAcross * 2))
  assert.ok(Math.abs(halfAlong * 2 - 6.79) < 0.05, String(halfAlong * 2))
  assert.equal(footprintHalfExtents(0).halfAcross, 0)
})

test('heading north puts the long side east-west', () => {
  const [fl, fr, , bl] = cameraFootprint(P, 10, 0)
  assert.ok(Math.abs(distanceM(fl!, fr!) - 12.06) < 0.1) // across = east-west
  assert.ok(Math.abs(distanceM(fl!, bl!) - 6.79) < 0.1) // along = north-south
  assert.ok(fl!.lat > P.lat && bl!.lat < P.lat) // front is north
})

test('heading east turns the frame: front corners are east of the drone', () => {
  const [fl, fr] = cameraFootprint(P, 10, 90)
  assert.ok(fl!.lon > P.lon && fr!.lon > P.lon)
})
