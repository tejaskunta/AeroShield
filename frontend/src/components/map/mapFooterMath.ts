export { formatLatLng } from '@/lib/geo'

/** Ground metres per CSS pixel at a latitude and Web Mercator zoom. */
export function metresPerPixelAt(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}
