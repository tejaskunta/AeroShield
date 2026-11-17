import type { Detection } from '@/types'

/**
 * Where a detection came from, as one of three honest answers.
 *
 *   flown      the aircraft's model found it (backend row, any non-test origin)
 *   test       placed by hand through the console's test panel (`manual-test`);
 *              it travelled the real backend path, which is the point of it, but
 *              it is not a find
 *   simulated  invented in the browser by the simulator
 *
 * One function so the card, the viewer and the top bar can never disagree.
 */
export type Provenance = 'flown' | 'test' | 'simulated'

export const TEST_INJECT_ORIGIN = 'manual-test'

export function provenanceOf(d: Pick<Detection, 'source' | 'origin'>): Provenance {
  if (d.source !== 'backend') return 'simulated'
  return d.origin === TEST_INJECT_ORIGIN ? 'test' : 'flown'
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  flown: 'Flown · captured by the aircraft',
  test: 'Test injection · placed by hand, not a find',
  simulated: 'Simulated · not a real find',
}

export const PROVENANCE_SHORT: Record<Provenance, string> = {
  flown: 'Flown',
  test: 'Test',
  simulated: 'Simulated',
}

/** Text colour class: flown is the normal case, the other two are cautions. */
export const PROVENANCE_TONE: Record<Provenance, string> = {
  flown: 'text-cleared',
  test: 'text-signal',
  simulated: 'text-caution',
}
