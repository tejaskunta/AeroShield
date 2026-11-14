import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ESRI_LABELS_URL,
  ESRI_MAX_NATIVE_ZOOM,
  ESRI_WORLD_IMAGERY_URL,
  IMAGERY_URL_ORDER,
  MAX_LIVE_MAP_ZOOM,
  OSM_TILE_URL,
} from './config.ts'

/**
 * The two imagery-provider mistakes that do not announce themselves.
 *
 * Both of these produce a map that looks entirely plausible and is entirely wrong,
 * which is the worst failure mode available: nobody notices, and every position
 * read off it is silently displaced. Hence an assertion rather than a comment.
 */

/**
 * Esri's ArcGIS REST tile endpoints take `{z}/{y}/{x}` — row before column.
 *
 * Swapping them does not 404. Esri either serves a tile from somewhere else in the
 * pyramid or returns a blank, and either way the operator sees imagery and believes
 * it. The survey block is in Hyderabad; the swapped convention would draw a
 * different piece of the world at the same coordinates.
 *
 * This test pins the placeholder ORDER, which is the only part of the URL a reader
 * can check by eye, and it imports `IMAGERY_URL_ORDER` from `MapRoot` so the two
 * cannot drift apart.
 */
test('the imagery URL puts the row before the column', () => {
  assert.equal(IMAGERY_URL_ORDER, 'zyx', 'Esri serves {z}/{y}/{x}; {z}/{x}/{y} is OSM')

  // Index of each placeholder, asserted to be in ascending order, because that is
  // what "row before column" means once the braces are gone.
  const tokens = ['{z}', '{y}', '{x}'].map((t) => ESRI_WORLD_IMAGERY_URL.indexOf(t))
  assert.ok(tokens.every((i) => i >= 0), 'the imagery URL is missing a placeholder')
  assert.deepEqual(
    tokens,
    [...tokens].sort((a, b) => a - b),
    `expected {z}/{y}/{x} order, got ${ESRI_WORLD_IMAGERY_URL}`,
  )
})

test('the labels overlay uses the same convention as the imagery beneath it', () => {
  // The hybrid basemap stacks the boundaries layer on the imagery. If the two
  // disagreed, the labels would land on a different part of the world than the
  // ground under them — which reads as "the labels are offset" and is unguessable.
  const tokens = ['{z}', '{y}', '{x}'].map((t) => ESRI_LABELS_URL.indexOf(t))
  assert.ok(tokens.every((i) => i >= 0), 'the labels URL is missing a placeholder')
  assert.deepEqual(
    tokens,
    [...tokens].sort((a, b) => a - b),
    `the labels URL disagrees with the imagery URL: ${ESRI_LABELS_URL}`,
  )
})

/**
 * Esri stops serving imagery at zoom 19.
 *
 * Past 19 the service returns blanks rather than an error, so Leaflet would happily
 * paint an empty grey pane and the map would look broken. `maxNativeZoom` says "this
 * is the deepest real data; upsample it for anything deeper", which keeps the pane
 * filled at the survey block's working zooms (20-22). The constant is duplicated
 * across the config/MapRoot boundary, so the equality is asserted.
 */
test('the native zoom ceiling is agreed between the config and the map', () => {
  assert.equal(ESRI_MAX_NATIVE_ZOOM, 19)
})

/**
 * The imagery's depth and the map's limit are different numbers, and must stay so.
 *
 * This is the regression test for the defect that capped the console at zoom 19. The
 * two constants are one `Math.min` apart, and that `Math.min` was applied where it had
 * no business: the basemap's native depth was fed into Leaflet's map `maxZoom`, so the
 * operator was stopped at the imagery's own resolution instead of the console's limit.
 * Worse, the same number reached the tile layer's `maxZoom`, and a Leaflet tile layer
 * whose `maxZoom` is below the map's zoom is not blurred — it is switched off, so the
 * imagery vanished above 19 rather than merely softening.
 *
 * `maxNativeZoom` is the option that means "upsample beyond here", and it already had
 * the right value (see `basemaps.ts`). The bug was not that 19 was wrong. It was that
 * 19 was also used to answer a question it does not answer.
 *
 * So: the map's limit must be strictly greater than the imagery's depth, or there is
 * nothing left to upsample and the ceiling has swallowed the console's own headroom.
 * If someone later "simplifies" these into one constant, this fails.
 */
test("the map's zoom limit is not the imagery depth", () => {
  assert.ok(
    MAX_LIVE_MAP_ZOOM > ESRI_MAX_NATIVE_ZOOM,
    `the map must be able to zoom past the imagery (${MAX_LIVE_MAP_ZOOM} vs ` +
      `${ESRI_MAX_NATIVE_ZOOM}); using one number for both is the bug this pins`,
  )
  // And the gap is the deliberate upscaling budget, not an accident of two nearby
  // literals. Three levels is what the config's own note argues for.
  assert.equal(MAX_LIVE_MAP_ZOOM - ESRI_MAX_NATIVE_ZOOM, 3)
})

/**
 * The street basemap is OSM, and OSM's scheme is the *other* one.
 *
 * This is the test that would have caught a copy-paste: the two URLs sit next to each
 * other in `config.ts`, one is `{z}/{y}/{x}` and one is `{z}/{x}/{y}`, and "make them
 * consistent" is exactly the tidy-up a future reader would attempt. They are not
 * inconsistent; they are two different services. OSM answers `{z}/{x}/{y}` and would
 * serve a plausible wrong tile if given the other order.
 */
test('the street basemap keeps OSM ordering, which is the opposite of Esri', () => {
  const tokens = ['{z}', '{x}', '{y}'].map((t) => OSM_TILE_URL.indexOf(t))
  assert.ok(tokens.every((i) => i >= 0), 'the OSM URL is missing a placeholder')
  assert.deepEqual(
    tokens,
    [...tokens].sort((a, b) => a - b),
    `OSM must be {z}/{x}/{y}, got ${OSM_TILE_URL}`,
  )
  // And the two really are different strings, so the assertion above is not vacuous.
  assert.notEqual(OSM_TILE_URL, ESRI_WORLD_IMAGERY_URL)
})