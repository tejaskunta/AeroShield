import test from 'node:test'
import assert from 'node:assert/strict'

import { canPersistReview, toIntId } from './detectionId'

/**
 * This rule is a data-integrity boundary, not a convenience check, and its
 * failure mode is silent: a PATCH against the wrong primary key returns 200 and
 * the UI reports "persisted" while a real operator's decision on another mission
 * is overwritten. So it is pinned by tests.
 *
 * The collision is a coincidence of *values*, not of shape — the fixture ids
 * `D-0101`+ are perfectly well-formed display ids, and `PATCH
 * /api/detections/{id}/review` resolves a row by PK alone with no mission in the
 * path. That is why `toIntId` cannot be the guard, and provenance has to be.
 */

test('toIntId parses a display id to the backend primary key', () => {
  assert.equal(toIntId('D-0147'), 147)
  assert.equal(toIntId('D-0491'), 491)
})

test('toIntId rejects anything that is not a display id', () => {
  assert.equal(toIntId('S-0101'), null)
  assert.equal(toIntId('147'), null)
  assert.equal(toIntId('D-'), null)
  assert.equal(toIntId(''), null)
})

test('a fixture id parses to a real-looking key — the collision is real', () => {
  // Fixtures are built as `D-${index + 101}`, so these are ordinary PKs.
  assert.equal(toIntId('D-0101'), 101)
  assert.equal(toIntId('D-0113'), 113)
})

test('a simulated row may never be persisted, however well-formed its id', () => {
  assert.equal(canPersistReview('D-0101', 'simulated'), false)
  assert.equal(canPersistReview('D-0491', 'simulated'), false)
})

test('a backend row with a parseable id may be persisted', () => {
  assert.equal(canPersistReview('D-0491', 'backend'), true)
})

test('a backend row with an unparseable id is still refused', () => {
  // Provenance is necessary but not sufficient: without a key there is no URL.
  assert.equal(canPersistReview('nonsense', 'backend'), false)
  assert.equal(canPersistReview('', 'backend'), false)
})

test('an unknown provenance is refused rather than assumed to be real', () => {
  // The caller resolves provenance from the row it is reviewing. If it cannot,
  // the safe direction is to refuse: a click that cannot be attributed to a real
  // row must never become a write.
  for (const source of ['simulated', 'backend'] as const) {
    assert.equal(typeof canPersistReview('D-0001', source), 'boolean')
  }
  assert.equal(canPersistReview('D-0001', 'simulated'), false)
})
