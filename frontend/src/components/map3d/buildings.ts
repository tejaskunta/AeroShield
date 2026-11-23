import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { LatLng } from '@/types'

/**
 * 3D buildings around the survey site, from OpenStreetMap.
 *
 * Footprints come from the Overpass API (keyless, the same OSM data the previous
 * MapLibre view extruded from OpenFreeMap). Heights use `height`, then
 * `building:levels` × 3.2 m, then a 7 m campus default. The result is cached per
 * site in localStorage so a reload — or a demo with a weak connection — does not
 * have to ask again.
 */

export interface Footprint {
  ring: LatLng[]
  height: number
  minHeight: number
}

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const RADIUS_M = 320
const CACHE_PREFIX = 'aeroshield:buildings:v1:'

function parseHeight(tags: Record<string, string>): { height: number; minHeight: number } {
  const num = (v: string | undefined) => {
    const n = v ? parseFloat(v) : NaN
    return Number.isFinite(n) ? n : NaN
  }
  let h = num(tags.height)
  if (!Number.isFinite(h)) {
    const lv = num(tags['building:levels'])
    h = Number.isFinite(lv) ? lv * 3.2 + 1 : 7
  }
  let min = num(tags.min_height)
  if (!Number.isFinite(min)) {
    const ml = num(tags['building:min_level'])
    min = Number.isFinite(ml) ? ml * 3.2 : 0
  }
  return { height: Math.max(2.5, Math.min(120, h)), minHeight: Math.max(0, min) }
}

export async function loadFootprints(center: LatLng, signal?: AbortSignal): Promise<Footprint[]> {
  const key = `${CACHE_PREFIX}${center.lat.toFixed(5)},${center.lon.toFixed(5)}`
  try {
    const hit = localStorage.getItem(key)
    if (hit) return JSON.parse(hit) as Footprint[]
  } catch {
    /* no storage: fetch */
  }
  const q = `[out:json][timeout:20];way["building"](around:${RADIUS_M},${center.lat},${center.lon});out geom tags;`
  const r = await fetch(OVERPASS, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal })
  if (!r.ok) throw new Error(`Overpass ${r.status}`)
  const json = (await r.json()) as { elements: Array<{ type: string; geometry?: Array<{ lat: number; lon: number }>; tags?: Record<string, string> }> }
  const out: Footprint[] = []
  for (const el of json.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue
    const { height, minHeight } = parseHeight(el.tags ?? {})
    out.push({ ring: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })), height, minHeight })
  }
  try {
    localStorage.setItem(key, JSON.stringify(out))
  } catch {
    /* quota: fine, just not cached */
  }
  return out
}

/**
 * One merged mesh for every building, plus crisp roof/wall edges.
 * `toLocal` maps lat/lon to scene metres (x east, z south).
 */
export function buildBuildingMeshes(fps: Footprint[], toLocal: (p: LatLng) => THREE.Vector3): THREE.Group | null {
  const geos: THREE.BufferGeometry[] = []
  for (const fp of fps) {
    const pts = fp.ring.map((p) => {
      const v = toLocal(p)
      // Shape space: x east, y north.
      return new THREE.Vector2(v.x, -v.z)
    })
    if (pts.length > 1 && pts[0]!.distanceTo(pts[pts.length - 1]!) < 0.01) pts.pop()
    if (pts.length < 3) continue
    const shape = new THREE.Shape(pts)
    const depth = Math.max(1, fp.height - fp.minHeight)
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false })
    // Extrusion is along +z; stand it up so it rises along +y and north is -z.
    g.rotateX(-Math.PI / 2)
    g.translate(0, fp.minHeight, 0)
    geos.push(g.toNonIndexed())
    g.dispose()
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  if (!merged) return null
  merged.computeVertexNormals()

  const group = new THREE.Group()
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ color: 0xc3ccd6, roughness: 0.82, metalness: 0.05, transparent: true, opacity: 0.88 }),
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(merged, 30),
    new THREE.LineBasicMaterial({ color: 0x5f6c79, transparent: true, opacity: 0.55 }),
  )
  group.add(edges)
  return group
}
