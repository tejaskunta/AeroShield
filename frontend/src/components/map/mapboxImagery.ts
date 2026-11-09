import {
  HAS_MAPBOX_TOKEN,
  MAPBOX_MAX_ZOOM,
  MAPBOX_STYLE_HYBRID,
  MAPBOX_STYLE_SATELLITE,
  MAPBOX_TILE_SIZE,
  MAPBOX_TOKEN,
} from '@/lib/config'
import type { Basemap } from './LiveMap'

/**
 * Deep-zoom imagery from Mapbox, as a Google Maps map type.
 *
 * Why this exists
 * ---------------
 * Google's built-in `satellite` and `hybrid` types stop at zoom 20 over the survey
 * block. Measured: a raster map constructed at zoom 22 settles at 20 and stays there
 * for as long as it is watched, `map.setZoom(22 | 21 | 21.5)` all land on 20, and
 * `map.maxZoom` reads 22 throughout — the clamp lives inside the imagery layer, not
 * in any option this console can set. The same fit that reaches 22 on `roadmap` gets
 * 20 on imagery, which measured 7.0 px/m against the street view's 28.1 px/m. A
 * factor of four: the satellite view was a quarter of the scale of the street view
 * beside it, and permanently below the 12 px/m legibility bar, so the guard retried
 * a fit that could not succeed until its budget ran out and then warned the operator
 * that their view was wrong.
 *
 * The imagery is not missing — direct tile fetches return real 256x256 images for
 * z19 through z22 on both `lyrs=s` and `lyrs=y`. It is the built-in map *type* that
 * declines to ask for it. So the fix is to supply the imagery through a type that
 * will: Mapbox's raster API, which serves z22 tiles at this location.
 *
 * What z22 actually contains
 * -------------------------
 * The tiles are real, but the *detail* in them is not native to z22. Correlating a
 * z22 tile against the same ground area resampled from shallower zoom levels gives
 * 0.999 at z21, 0.999 at z20, 0.997 at z19 and 0.977 at z18 — z22 is
 * indistinguishable from a 2x-to-16x magnification of z21. Past roughly z18 the
 * provider has no extra information to serve, which matches the sensor: at this
 * latitude z22 is 3.6 cm/px while the best commercial satellite resolves ~31 cm/px,
 * about zoom 19. So reaching 22 is correctness of scale relative to the street view,
 * not an increase in resolution. The instrument that shows centimetre detail here is
 * the aircraft's own camera, not any basemap.
 *
 * How it is wired
 * ---------------
 * An `ImageMapType` slots into `map.mapTypes` alongside the built-in ones, so every
 * other part of the console — the overlay tree, the follow modes, the legibility
 * guard, the click forwarding — keeps working against a normal `google.maps.Map`.
 * Nothing else in the codebase needs to know the imagery moved.
 *
 * The attribution requirement is not optional. Mapbox's terms require the words
 * "Mapbox" and "OpenStreetMap" to appear on the map, and they are rendered by the
 * caller rather than here because this module returns a map type, not UI.
 */

/** The subset of the Maps API this module needs, so it can be built before load. */
type MapsApi = typeof google.maps

/**
 * Build the map-type registry entries for the imagery basemaps.
 *
 * Kept as a function rather than module constants because `ImageMapType` needs the
 * Maps API to have loaded, and because the two types must be registered on the
 * specific map instance that will use them.
 *
 * Returns an empty map when no token is configured, which is the signal to leave the
 * built-in Google types in place — the console then behaves exactly as it did before
 * this module existed, rather than failing.
 */
export function mapboxImageryTypes(
  maps: MapsApi,
): globalThis.Map<string, google.maps.MapType> {
  const types = new globalThis.Map<string, google.maps.MapType>()
  if (!HAS_MAPBOX_TOKEN) return types

  const build = (style: string, name: string) =>
    new maps.ImageMapType({
      /**
       * Tile URL. Mapbox uses the same Web Mercator scheme as Google, so the
       * coordinates pass through unchanged — no reprojection, which is the other
       * reason this is a small module rather than a rendering layer.
       *
       * `@2x` asks Mapbox for a 512x512 bitmap of the same tile rather than 256x256.
       * It does not move the imagery one level deeper — the ground area is identical
       * — but it removes a resampling step on the way to the screen: a 256 px tile
       * occupies 256 CSS px, which on a 2x display is 512 device px, so the browser
       * was stretching every tile to double size before drawing it. At the zoom
       * ceiling, where the imagery is already magnified past its native resolution,
       * that stretch was compounding the softness the operator could see.
       */
      getTileUrl: (coord, zoom) => {
        // Mapbox will serve a zoom beyond its maximum by upscaling the deepest real
        // tile it has. That is useful near the ceiling and wrong well past it — a
        // 404 or a blank tile is worse than a slightly soft image, so the clamp is
        // deliberate and the ceiling is enforced by `ceilingZoom` upstream.
        const z = Math.min(zoom, MAPBOX_MAX_ZOOM)
        return (
          `https://api.mapbox.com/styles/v1/${style}/tiles/${MAPBOX_TILE_SIZE}` +
          `/${z}/${coord.x}/${coord.y}@2x?access_token=${MAPBOX_TOKEN}`
        )
      },
      // Must stay at the tile's geographic size, not its bitmap size. Raising this
      // to 512 to "match" the @2x image would halve the apparent scale and undo the
      // whole point of reaching zoom 22.
      tileSize: new maps.Size(MAPBOX_TILE_SIZE, MAPBOX_TILE_SIZE),
      maxZoom: MAPBOX_MAX_ZOOM,
      minZoom: 0,
      name,
    })

  types.set(
    'mapbox-satellite',
    build(MAPBOX_STYLE_SATELLITE, 'Mapbox Satellite'),
  )
  types.set('mapbox-hybrid', build(MAPBOX_STYLE_HYBRID, 'Mapbox Hybrid'))
  return types
}

/** Map type id to install for a basemap, or `null` to keep Google's own type. */
export function mapboxTypeIdFor(basemap: Basemap): string | null {
  if (!HAS_MAPBOX_TOKEN) return null
  if (basemap === 'satellite') return 'mapbox-satellite'
  if (basemap === 'hybrid') return 'mapbox-hybrid'
  // Street stays on Google: it is a vector schematic, not imagery, it already
  // reaches 22, and Mapbox's street styling would fight this console's palette.
  return null
}
