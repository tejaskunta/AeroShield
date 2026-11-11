import test from 'node:test'
import assert from 'node:assert/strict'

import type { Detection, ReviewState } from '@/types'
import {
  HAZARD_THRESHOLD,
  REVIEW_THRESHOLD,
  riskOf,
  riskOfConfidence,
} from './risk'

/**
 * The risk model is the one piece of UI logic that makes a safety claim, so it
 * is tested rather than eyeballed.
 *
 * The invariant under test throughout: `cleared` is reachable ONLY by a human
 * dismissal. Nothing the model emits, at any confidence, may clear ground.
 */

function detection(confidence: number, review: ReviewState): Detection {
  return {
    id: 'D-0001',
    missionId: 'bench-jetson-1',
    class: 'landmine',
    classRaw: 'landmine',
    confidence,
    bbox: { x1: 160, y1: 90, x2: 200, y2: 130 },
    position: { lat: 17.396947, lon: 78.490706 },
    captureAltitudeM: 12,
    positionErrorM: 3,
    capturedAt: '2026-08-23T09:00:00Z',
    gridCell: 'C4',
    frameUri: '',
    gradCamUri: null,
    source: 'simulated',
    review: {
      state: review,
      reviewedAt: review === 'unreviewed' ? undefined : '2026-08-23T09:05:00Z',
    },
  }
}

test('a high-confidence unreviewed detection reads as a hazard', () => {
  assert.equal(riskOf(detection(0.94, 'unreviewed')), 'hazard')
})

test('confidence exactly at the hazard threshold is a hazard', () => {
  assert.equal(riskOf(detection(HAZARD_THRESHOLD, 'unreviewed')), 'hazard')
})

test('a low-confidence unreviewed detection is unverified, never cleared', () => {
  const level = riskOf(detection(0.05, 'unreviewed'))
  assert.equal(level, 'caution')
  assert.notEqual(level, 'cleared')
})

test('a flagged detection stays a hazard regardless of confidence', () => {
  assert.equal(riskOf(detection(0.12, 'flagged')), 'hazard')
})

test('a confirmed detection is a hazard even at low confidence', () => {
  assert.equal(riskOf(detection(0.11, 'confirmed')), 'hazard')
})

test('only a human dismissal clears a detection', () => {
  assert.equal(riskOf(detection(0.99, 'dismissed')), 'cleared')
  assert.equal(riskOf(detection(0.01, 'dismissed')), 'cleared')
})

test('no confidence value can produce cleared without a review decision', () => {
  for (let i = 0; i <= 100; i++) {
    const confidence = i / 100
    for (const state of ['unreviewed', 'confirmed', 'flagged'] as ReviewState[]) {
      assert.notEqual(
        riskOf(detection(confidence, state)),
        'cleared',
        `confidence ${confidence} in state ${state} must not clear ground`,
      )
    }
  }
})

test('a bare confidence never reads as cleared either', () => {
  for (let i = 0; i <= 100; i++) {
    assert.notEqual(riskOfConfidence(i / 100), 'cleared')
  }
})

test('a bare confidence splits only at the hazard threshold', () => {
  assert.equal(riskOfConfidence(HAZARD_THRESHOLD - 0.01), 'caution')
  assert.equal(riskOfConfidence(HAZARD_THRESHOLD), 'hazard')
})

test('the review threshold sits below the hazard threshold', () => {
  assert.ok(REVIEW_THRESHOLD < HAZARD_THRESHOLD)
})