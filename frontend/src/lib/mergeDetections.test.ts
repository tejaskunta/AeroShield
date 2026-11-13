import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDetections } from './mergeDetections.ts'
import type { Detection } from '@/types'

/**
 * These tests pin one safety property: a live mission's detection list must never
 * contain invented rows. Everything else about the merge is cosmetic.
 */

function det(id: string, source: Detection['source']): Detection {
  return { id, source } as Detection
}

test('no live mission: the seeded block is shown, so the keyless demo still works', () => {
  const seeds = [det('D-0101', 'simulated'), det('D-0102', 'simulated')]
  assert.deepEqual(mergeDetections(seeds, [], false), seeds)
})

test('live mission: seeds are dropped entirely, not appended', () => {
  const seeds = [det('D-0101', 'simulated'), det('D-0102', 'simulated')]
  const real = [det('787', 'backend')]
  const out = mergeDetections(seeds, real, true)
  assert.deepEqual(out, real)
  assert.equal(
    out.some((d) => d.source === 'simulated'),
    false,
    'a live feed must never carry a simulated row',
  )
})

test('live mission that has found nothing yet shows an empty list, not seeds', () => {
  // The aircraft flying and finding nothing is a real answer. Filling it with
  // invented finds would hide the thing the operator is watching for.
  const seeds = [det('D-0101', 'simulated')]
  assert.deepEqual(mergeDetections(seeds, [], true), [])
})

test('a seeded row cannot survive alongside real rows even if ids collide', () => {
  // Fixture ids are D-0101+ and real ids are integer PKs, but the overlap is not
  // what protects us — dropping the seeds whole is.
  const seeds = [det('101', 'simulated')]
  const real = [det('101', 'backend')]
  const out = mergeDetections(seeds, real, true)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.source, 'backend')
})

test('real rows keep backend order (newest-load-first is the caller\'s job)', () => {
  const real = [det('3', 'backend'), det('1', 'backend'), det('2', 'backend')]
  assert.deepEqual(
    mergeDetections([], real, true).map((d) => d.id),
    ['3', '1', '2'],
  )
})

test('the input lists are never mutated', () => {
  const seeds = [det('D-0101', 'simulated')]
  const real = [det('787', 'backend')]
  const seedsCopy = [...seeds]
  const realCopy = [...real]
  mergeDetections(seeds, real, true)
  assert.deepEqual(seeds, seedsCopy)
  assert.deepEqual(real, realCopy)
})