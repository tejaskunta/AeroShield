import test from 'node:test'
import assert from 'node:assert/strict'

import type { Detection } from '@/types'
import { ReviewOverrides } from './reviewOverrides'

/**
 * The override store exists because a review decision could be accepted, shown in
 * the rail, and then silently reverted on the next simulator tick. That is the
 * failure mode under test here.
 */

function detection(id: string, state: Detection['review']['state'] = 'unreviewed'): Detection {
  return {
    id,
    missionId: 'bench-jetson-1',
    class: 'landmine',
    classRaw: 'landmine',
    confidence: 0.82,
    bbox: { x1: 160, y1: 90, x2: 200, y2: 130 },
    position: { lat: 17.396947, lon: 78.490706 },
    captureAltitudeM: 12,
    positionErrorM: 3,
    capturedAt: '2026-08-23T09:00:00Z',
    gridCell: 'C4',
    frameUri: '',
    gradCamUri: null,
    source: 'backend',
    review: { state },
  }
}

const confirmed: Detection['review'] = {
  state: 'confirmed',
  reviewedAt: '2026-08-23T09:05:00Z',
  reviewedBy: 'operator',
}

test('a recorded decision survives the next frame from the source', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)

  // The backend re-sends the row on every reconnect, still unreviewed, because
  // this store is not the source of truth for the write -- the server is.
  const frame = [detection('7')]
  assert.equal(store.apply(frame)[0]!.review.state, 'confirmed')
})

test('a decision applies to a real row the simulator never held', () => {
  // The original bug: `simulator.reviewDetection` searched a list of seeds, found
  // nothing for a backend primary key, and emitted nothing.
  const store = new ReviewOverrides()
  store.record('412', confirmed)
  assert.equal(store.apply([detection('412')])[0]!.review.state, 'confirmed')
})

test('an untouched row keeps its own review state', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)
  const rows = [detection('7'), detection('8', 'flagged')]
  const out = store.apply(rows)
  assert.equal(out[1]!.review.state, 'flagged')
  assert.equal(out[1]!.review.reviewedBy, undefined)
})

test('the original list is never mutated', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)
  const rows = [detection('7')]
  store.apply(rows)
  // The list may be the simulator's own array; overlaying must not edit it.
  assert.equal(rows[0]!.review.state, 'unreviewed')
})

test('a no-op overlay returns the same reference, so ticks stay cheap', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)
  const rows = [detection('8'), detection('9')]
  // compose runs twice a second; a fresh array each time would re-render every
  // consumer for no change.
  assert.equal(store.apply(rows), rows)
})

test('an empty store is always a pass-through', () => {
  const store = new ReviewOverrides()
  const rows = [detection('7')]
  assert.equal(store.apply(rows), rows)
  assert.equal(store.size, 0)
})

test('a later decision replaces an earlier one', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)
  store.record('7', { state: 'dismissed', reviewedBy: 'operator' })
  assert.equal(store.apply([detection('7')])[0]!.review.state, 'dismissed')
})

test('decisions are keyed by id, not by position in the list', () => {
  const store = new ReviewOverrides()
  store.record('7', confirmed)
  // Order in the merged list is seeds-then-real, so index is not identity.
  const out = store.apply([detection('9'), detection('7'), detection('3')])
  assert.deepEqual(
    out.map((d) => d.review.state),
    ['unreviewed', 'confirmed', 'unreviewed'],
  )
})