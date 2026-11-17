import { test } from 'node:test'
import assert from 'node:assert/strict'

import { provenanceOf } from './provenance.ts'

test('a backend row from the aircraft is flown', () => {
  assert.equal(provenanceOf({ source: 'backend', origin: 'jetson-trt' }), 'flown')
  assert.equal(provenanceOf({ source: 'backend' }), 'flown')
})

/** The test panel uses the real ingest path, so `source` alone would say flown. */
test('a test injection is never reported as flown', () => {
  assert.equal(provenanceOf({ source: 'backend', origin: 'manual-test' }), 'test')
})

test('a browser-simulated row is simulated whatever its origin says', () => {
  assert.equal(provenanceOf({ source: 'simulated', origin: 'jetson-trt' }), 'simulated')
})
