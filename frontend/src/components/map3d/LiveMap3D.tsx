import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { MapControls as OrbitMapControls } from 'three/examples/jsm/controls/MapControls.js'
import type { Detection, LatLng, MissionProgress, RiskLevel, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { ESRI_WORLD_IMAGERY_URL } from '@/lib/config'
import { M_PER_DEG_LAT, gridCenter, mPerDegLon, parseCellId, validCoordinate } from '@/lib/geo'
import { RISK_HEX, formatConfidence, riskOf } from '@/lib/risk'
import { footprintHalfExtents } from '@/lib/footprint'
import { GROUND_EXTENT_M, getGroundCanvas } from '@/lib/groundTexture'
import { HOME } from '@/lib/simulation'
import { pinTooltipHtml } from '@/components/map/pinTooltip'
import { buildBuildingMeshes, loadFootprints } from './buildings'
import type { Basemap } from '@/components/map/basemaps'
import type { LayerState } from '@/components/map/LayerToggles'
import type { FollowMode } from '@/components/map/useMapHooks'
import type { DroneOverlayMeta } from '@/components/map/DroneImageryLayer'
import type { MapControls, MapViewState } from '@/components/map/viewTypes'

/**
 * LiveMap3D — the mission as a real-time 3D scene.
 *
 * A standalone three.js renderer, not a map engine with a model bolted on. The
 * previous MapLibre version drew a 10 m block at zoom 22 over z19 imagery — a
 * blurred smear — fought the map's own repaint loop to animate the drone, and
 * hopped the aircraft once per telemetry packet. Here the whole scene is ours:
 *
 *   ground     Esri imagery for the surroundings, a centimetre-scale ground pad for
 *              the block (the same canvas the simulated camera samples)
 *   aircraft   a detailed quadcopter, interpolated between telemetry packets on a
 *              fixed delay so it moves at constant speed with no hops, banking into
 *              its motion, rotors spinning while armed
 *   hazards    beacons at each detection — ground ring, light column, floating
 *              marker — coloured by risk, animated on arrival, clickable
 *   camera     map-style controls (drag pan, right-drag orbit, wheel zoom) with
 *              damping, follow and fit modes, and tweened fly-to
 *
 * Coordinates are local metres around the block centre: x east, y up, z south.
 */

/** The airframe is drawn this many times real size, so it reads at survey scale. */
export const DRONE_SCALE = 3

/** Render this far behind the newest telemetry, so there is always a sample ahead to move toward. */
const INTERP_DELAY_MS = 620
/** A jump bigger than this between packets is a reset, not motion: snap. */
const SNAP_M = 12

const CENTER = gridCenter(MISSION.grid)
const M_LON = mPerDegLon(CENTER.lat)

function toLocal(p: LatLng): THREE.Vector3 {
  return new THREE.Vector3((p.lon - CENTER.lon) * M_LON, 0, -(p.lat - CENTER.lat) * M_PER_DEG_LAT)
}
function toLatLng(v: THREE.Vector3): LatLng {
  return { lat: CENTER.lat - v.z / M_PER_DEG_LAT, lon: CENTER.lon + v.x / M_LON }
}

const BLOCK_W = MISSION.grid.cols * MISSION.grid.cellSizeM
const BLOCK_H = MISSION.grid.rows * MISSION.grid.cellSizeM

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Vertical fade, opaque at the bottom: light columns. */
function beamTexture(): THREE.CanvasTexture {
  return canvasTexture(4, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 128, 0, 0)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 128)
  })
}

/** Soft round glow, for LEDs and ground pulses. */
function glowTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.6)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  })
}

/** Square falloff mask, so the ground pad melts into the imagery around it. */
function padAlphaTexture(): THREE.CanvasTexture {
  const t = canvasTexture(256, 256, (ctx) => {
    const img = ctx.createImageData(256, 256)
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const dx = Math.abs(x - 127.5) / 127.5
        const dy = Math.abs(y - 127.5) / 127.5
        const d = Math.max(dx, dy)
        const a = d < 0.62 ? 1 : Math.max(0, 1 - (d - 0.62) / 0.38)
        const v = Math.round(a * a * (3 - 2 * a) * 255)
        const i = (y * 256 + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  })
  t.colorSpace = THREE.NoColorSpace
  return t
}

function helipadTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256)
    ctx.fillStyle = 'rgba(14,20,27,0.88)'
    ctx.beginPath()
    ctx.arc(128, 128, 124, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#f2c14e'
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.arc(128, 128, 104, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#e9edf1'
    ctx.font = '700 120px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('H', 128, 136)
  })
}

// ---------------------------------------------------------------------------
// Satellite surroundings
// ---------------------------------------------------------------------------

const TILE_Z = 19
const TILE_SPAN = 4 // tiles each side of the centre tile: 9×9 ≈ 650 m

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}
function tileXToLon(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180
}
function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

function tileUrl(basemap: Basemap, x: number, y: number): string {
  if (basemap === 'roadmap') return `https://${'abc'[(x + y) % 3]}.tile.openstreetmap.org/${TILE_Z}/${x}/${y}.png`
  return ESRI_WORLD_IMAGERY_URL.replace('{z}', String(TILE_Z)).replace('{y}', String(y)).replace('{x}', String(x))
}

/** A plane carrying stitched basemap tiles, placed at their true ground extent. */
function makeImagery(basemap: Basemap, onReady: () => void): THREE.Mesh {
  const cx = Math.floor(lonToTileX(CENTER.lon, TILE_Z))
  const cy = Math.floor(latToTileY(CENTER.lat, TILE_Z))
  const x0 = cx - TILE_SPAN
  const y0 = cy - TILE_SPAN
  const n = TILE_SPAN * 2 + 1
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n * 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#1a2018'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8

  const nw = toLocal({ lat: tileYToLat(y0, TILE_Z), lon: tileXToLon(x0, TILE_Z) })
  const se = toLocal({ lat: tileYToLat(y0 + n, TILE_Z), lon: tileXToLon(x0 + n, TILE_Z) })
  const w = se.x - nw.x
  const h = se.z - nw.z
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: basemap === 'roadmap' ? 0x8a929b : 0xc8c8c8 })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(nw.x + w / 2, -0.02, nw.z + h / 2)
  mesh.receiveShadow = true

  let queued = false
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        ctx.filter = basemap === 'roadmap' ? 'saturate(0.35) brightness(0.62)' : 'contrast(1.12) saturate(1.12)'
        ctx.drawImage(img, tx * 256, ty * 256)
        ctx.filter = 'none'
        // Re-upload at most once per frame however many tiles land together.
        if (!queued) {
          queued = true
          requestAnimationFrame(() => {
            queued = false
            tex.needsUpdate = true
            onReady()
          })
        }
      }
      img.src = tileUrl(basemap, x0 + tx, y0 + ty)
    }
  }
  return mesh
}

// ---------------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------------

interface DroneModel {
  root: THREE.Group
  yaw: THREE.Group
  tilt: THREE.Group
  props: THREE.Group[]
  discs: THREE.Mesh[]
  strobe: THREE.Sprite
  tether: THREE.Line
  ring: THREE.Mesh
  frustum: THREE.Group
  footprint: THREE.LineLoop
  footFill: THREE.Mesh
}

function makeDrone(glow: THREE.Texture): DroneModel {
  const root = new THREE.Group()
  const yaw = new THREE.Group()
  const tilt = new THREE.Group()
  root.add(yaw)
  yaw.add(tilt)
  const model = new THREE.Group()
  model.scale.setScalar(DRONE_SCALE)
  tilt.add(model)

  const shell = new THREE.MeshStandardMaterial({ color: 0xe6eaee, roughness: 0.35, metalness: 0.15 })
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1c2229, roughness: 0.55, metalness: 0.35 })
  const metal = new THREE.MeshStandardMaterial({ color: 0x8b96a3, roughness: 0.3, metalness: 0.8 })
  const accent = new THREE.MeshStandardMaterial({ color: 0x5cc8f5, emissive: 0x5cc8f5, emissiveIntensity: 1.2 })
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.05, metalness: 0.9 })

  const add = (m: THREE.Mesh) => {
    m.castShadow = true
    model.add(m)
    return m
  }

  // Fuselage: a rounded capsule body with a canopy and battery bay.
  const body = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.12, 6, 16), shell))
  body.rotation.x = Math.PI / 2
  body.scale.set(1.25, 1, 0.62)
  const canopy = add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), carbon))
  canopy.scale.set(1.1, 0.55, 1.6)
  canopy.position.set(0, 0.028, 0.01)
  const stripe = add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.16), accent))
  stripe.position.set(0, 0.04, 0.0)

  // Gimbal camera under the nose.
  const gimbal = add(new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), carbon))
  gimbal.position.set(0, -0.04, -0.07)
  const lens = add(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.012, 16), glass))
  lens.position.set(0, -0.055, -0.08)

  // Arms, motors, propellers.
  const props: THREE.Group[] = []
  const discs: THREE.Mesh[] = []
  const discMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.5 })
  const armLen = 0.2
  for (const [sx, sz] of [[1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
    const ang = Math.atan2(sz, sx)
    const arm = add(new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.016, 0.022), carbon))
    arm.position.set(Math.cos(ang) * armLen * 0.5, 0, Math.sin(ang) * armLen * 0.5)
    arm.rotation.y = -ang
    const tip = new THREE.Vector3(Math.cos(ang) * armLen, 0, Math.sin(ang) * armLen)
    const motor = add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.03, 18), metal))
    motor.position.set(tip.x, 0.012, tip.z)
    const cap = add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 10), sz < 0 ? accent : shell))
    cap.position.set(tip.x, 0.032, tip.z)
    const prop = new THREE.Group()
    prop.position.set(tip.x, 0.034, tip.z)
    for (const k of [0, 1]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.003, 0.018), bladeMat)
      blade.rotation.y = k * Math.PI
      blade.position.x = k === 0 ? 0.045 : -0.045
      blade.rotation.x = k === 0 ? 0.18 : -0.18
      prop.add(blade)
    }
    model.add(prop)
    props.push(prop)
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.1, 32), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.set(tip.x, 0.036, tip.z)
    model.add(disc)
    discs.push(disc)
    // Landing legs under each motor.
    const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), carbon))
    leg.position.set(tip.x * 0.7, -0.04, tip.z * 0.7)
    // Navigation lights: red port, green starboard at the front; white strobe rear.
    if (sz < 0) {
      const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: sx > 0 ? 0x3dff7a : 0xff3b3b, blending: THREE.AdditiveBlending, depthWrite: false }))
      led.scale.setScalar(0.07)
      led.position.set(tip.x, -0.005, tip.z)
      model.add(led)
    }
  }
  const strobe = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false }))
  strobe.scale.setScalar(0.12)
  strobe.position.set(0, 0.02, 0.1)
  model.add(strobe)

  // Altitude tether and the ground ring under the aircraft (real metres, unscaled).
  const tether = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]),
    new THREE.LineDashedMaterial({ color: 0x5cc8f5, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.85 }),
  )
  tether.computeLineDistances()
  root.add(tether)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.4, 48),
    new THREE.MeshBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  root.add(ring)

  // Camera frustum (unit pyramid, scaled per frame) and the footprint on the ground.
  const frustum = new THREE.Group()
  const fGeo = new THREE.BufferGeometry()
  const v = [0, 0, 0, -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1]
  fGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  fGeo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1])
  frustum.add(
    new THREE.Mesh(
      fGeo,
      new THREE.MeshBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    ),
  )
  const edges = new THREE.BufferGeometry().setFromPoints(
    [1, 2, 3, 4].flatMap((i) => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!)]),
  )
  frustum.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.45 })))
  yaw.add(frustum)
  const footprint = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, -1), new THREE.Vector3(1, 0, 1), new THREE.Vector3(-1, 0, 1)]),
    new THREE.LineBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.9 }),
  )
  yaw.add(footprint)
  const footFill = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  footFill.rotation.x = -Math.PI / 2
  yaw.add(footFill)

  return { root, yaw, tilt, props, discs, strobe, tether, ring, frustum, footprint, footFill }
}

// ---------------------------------------------------------------------------
// Hazard beacons
// ---------------------------------------------------------------------------

interface Beacon {
  id: string
  group: THREE.Group
  ring: THREE.Mesh
  halo: THREE.Mesh
  beam: THREE.Mesh
  head: THREE.Mesh
  shock: THREE.Mesh
  hit: THREE.Mesh
  risk: RiskLevel
  reviewState: string
  born: number
  seed: number
}

const BEAM_H = 2.1

function makeBeacon(d: Detection, beamTex: THREE.Texture, born: number): Beacon {
  const color = new THREE.Color(RISK_HEX[riskOf(d)])
  const group = new THREE.Group()
  const p = toLocal(d.position)
  group.position.copy(p)

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(0.2, d.positionErrorM), 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, depthWrite: false }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.y = 0.03
  group.add(halo)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.24, 0.32, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.04
  group.add(ring)

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.11, BEAM_H, 20, 1, true),
    new THREE.MeshBasicMaterial({ color, map: beamTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  beam.position.y = BEAM_H / 2
  group.add(beam)
  // A solid core inside the glow, so the column reads from across the block.
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, BEAM_H, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }))
  core.userData.core = true
  beam.add(core)

  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.17, 0),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.2, flatShading: true }),
  )
  head.position.y = BEAM_H + 0.25
  head.scale.set(1, 1.35, 1)

  group.add(head)

  const shock = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  )
  shock.rotation.x = -Math.PI / 2
  shock.position.y = 0.05
  group.add(shock)

  // Generous invisible hit target: the whole column, so a beacon is easy to click.
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, BEAM_H + 0.6, 8), new THREE.MeshBasicMaterial({ visible: false }))
  hit.position.y = (BEAM_H + 0.6) / 2
  hit.userData.detectionId = d.id
  group.add(hit)

  return { id: d.id, group, ring, halo, beam, head, shock, hit, risk: riskOf(d), reviewState: d.review.state, born, seed: Math.random() * 10 }
}

function recolorBeacon(b: Beacon, d: Detection) {
  const color = new THREE.Color(RISK_HEX[riskOf(d)])
  for (const m of [b.ring, b.halo, b.beam, b.head, b.shock, b.beam.children[0] as THREE.Mesh]) {
    const mat = m.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial
    mat.color.copy(color)
    if ('emissive' in mat) mat.emissive.copy(color)
  }
  b.risk = riskOf(d)
  b.reviewState = d.review.state
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else mat?.dispose()
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Sample {
  t: number
  pos: THREE.Vector3
  alt: number
  heading: number
  armed: boolean
}

interface Tween {
  from: { target: THREE.Vector3; offset: THREE.Vector3 }
  to: { target: THREE.Vector3; offset: THREE.Vector3 }
  start: number
  dur: number
}

/**
 * Where the default framing looks: a little south-west of the block centre, so the
 * home pad is in shot and the block sits above the status panels.
 */
const FIT_TARGET = new THREE.Vector3(-0.8, 0, 2.6)

/** Default framing: the block from the south-south-west, looking down ~50°. */
function homeOffset(dist = 21): THREE.Vector3 {
  const polar = (52 * Math.PI) / 180
  const az = (-22 * Math.PI) / 180
  return new THREE.Vector3(Math.sin(polar) * Math.sin(az) * dist, Math.cos(polar) * dist, Math.sin(polar) * Math.cos(az) * dist)
}

export default function LiveMap3D({
  telemetry,
  progress,
  detections,
  selectedId,
  onSelect,
  onMapClick,
  basemap,
  layers,
  follow,
  refitKey,
  droneOverlay,
  initialView,
  onControls,
  onBearing,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMapClick?: (p: LatLng) => void
  basemap: Basemap
  layers: LayerState
  follow: FollowMode
  refitKey: number
  droneOverlay: DroneOverlayMeta | null
  initialView?: MapViewState | null
  onControls?: (c: MapControls | null) => void
  onBearing?: (deg: number) => void
}) {
  const holder = useRef<HTMLDivElement | null>(null)
  const droneLabelRef = useRef<HTMLDivElement | null>(null)
  const selLabelRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  // Everything the render loop reads lives in one mutable bag, so React renders
  // never rebuild the scene; they only update this and the loop picks it up.
  const st = useRef({
    samples: [] as Sample[],
    detections: [] as Detection[],
    selectedId: null as string | null,
    layers,
    follow,
    progress: null as MissionProgress | null,
    tween: null as Tween | null,
    dirtyTrack: true,
    dirtyCoverage: true,
  })
  st.current.layers = layers
  st.current.follow = follow
  st.current.selectedId = selectedId

  const api = useRef<{
    setBasemap: (b: Basemap) => void
    syncBeacons: () => void
    fit: (animate: boolean) => void
    setOverlay: (m: DroneOverlayMeta | null, on: boolean) => void
  } | null>(null)
  const cb = useRef({ onSelect, onMapClick, onBearing })
  cb.current = { onSelect, onMapClick, onBearing }

  // ---- build the scene once ----
  useEffect(() => {
    const host = holder.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.outline = 'none'
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const fogColor = new THREE.Color('#0b141d')
    scene.fog = new THREE.Fog(fogColor, 70, 260)
    scene.background = fogColor

    // Sky dome: a vertical gradient, deep navy overhead to a lit horizon.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { top: { value: new THREE.Color('#040a12') }, mid: { value: new THREE.Color('#0f2234') }, bottom: { value: fogColor } },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.55, h)) : mix(mid, bottom, smoothstep(0.0, 0.08, -h)); gl_FragColor = vec4(c, 1.0); }',
      }),
    )
    scene.add(sky)

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000)
    const controls = new OrbitMapControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.09
    controls.screenSpacePanning = false
    controls.minDistance = 2.5
    controls.maxDistance = 220
    controls.maxPolarAngle = (84 * Math.PI) / 180
    controls.zoomSpeed = 0.9
    controls.rotateSpeed = 0.6
    // Wheel zoom toward the cursor, like the 2D map.
    ;(controls as unknown as { zoomToCursor: boolean }).zoomToCursor = true

    if (initialView && Number.isFinite(initialView.lat)) {
      const t = toLocal({ lat: initialView.lat, lon: initialView.lon })
      const dist = Math.max(4, Math.min(160, 21 * 2 ** (21.3 - initialView.zoom)))
      controls.target.copy(t)
      camera.position.copy(t).add(homeOffset(dist))
    } else {
      controls.target.copy(FIT_TARGET)
      camera.position.copy(FIT_TARGET).add(homeOffset(23))
    }
    controls.update()

    // Lights.
    scene.add(new THREE.HemisphereLight(0xc6dcff, 0x3a3222, 1.1))
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
    sun.position.set(-14, 26, 9)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -14
    sun.shadow.camera.right = 14
    sun.shadow.camera.top = 14
    sun.shadow.camera.bottom = -14
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 80
    sun.shadow.bias = -0.0004
    sun.shadow.radius = 4
    scene.add(sun)

    const glow = glowTexture()
    const beamTex = beamTexture()

    // Far ground so the world never ends in a void, under the imagery.
    const far = new THREE.Mesh(new THREE.CircleGeometry(1500, 48), new THREE.MeshStandardMaterial({ color: 0x18201a, roughness: 1 }))
    far.rotation.x = -Math.PI / 2
    far.position.y = -0.05
    scene.add(far)

    let imagery: THREE.Mesh | null = null
    const setBasemap = (b: Basemap) => {
      if (imagery) {
        scene.remove(imagery)
        ;(imagery.material as THREE.MeshStandardMaterial).map?.dispose()
        disposeObject(imagery)
      }
      imagery = makeImagery(b, () => {})
      scene.add(imagery)
    }

    // The ground pad: centimetre detail over the block, fading into the imagery.
    const padTex = new THREE.CanvasTexture(getGroundCanvas())
    padTex.colorSpace = THREE.SRGBColorSpace
    padTex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    padTex.generateMipmaps = true
    padTex.minFilter = THREE.LinearMipmapLinearFilter
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_EXTENT_M, GROUND_EXTENT_M),
      new THREE.MeshStandardMaterial({ map: padTex, alphaMap: padAlphaTexture(), transparent: true, roughness: 0.95, depthWrite: false }),
    )
    pad.rotation.x = -Math.PI / 2
    pad.position.y = 0.0
    pad.receiveShadow = true
    pad.renderOrder = 1
    scene.add(pad)

    // 3D buildings from OpenStreetMap, as the previous view had them.
    const buildingsAbort = new AbortController()
    let buildings: THREE.Group | null = null
    loadFootprints(CENTER, buildingsAbort.signal)
      .then((fps) => {
        if (buildingsAbort.signal.aborted) return
        buildings = buildBuildingMeshes(fps, toLocal)
        if (buildings) scene.add(buildings)
      })
      .catch(() => {
        /* offline or rate-limited: the scene is complete without them */
      })

    // Optional georeferenced drone photo of the block.
    let overlay: THREE.Mesh | null = null
    const setOverlay = (m: DroneOverlayMeta | null, on: boolean) => {
      if (overlay) {
        scene.remove(overlay)
        disposeObject(overlay)
        overlay = null
      }
      if (!m || !on) return
      const [[s, w], [n, e]] = m.bounds
      const sw = toLocal({ lat: s, lon: w })
      const ne = toLocal({ lat: n, lon: e })
      const tex = new THREE.TextureLoader().load(`/overlay/${m.image}?v=${encodeURIComponent(m.capturedAt)}`)
      tex.colorSpace = THREE.SRGBColorSpace
      overlay = new THREE.Mesh(
        new THREE.PlaneGeometry(ne.x - sw.x, sw.z - ne.z),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 1, transparent: true, depthWrite: false }),
      )
      overlay.rotation.x = -Math.PI / 2
      overlay.position.set((sw.x + ne.x) / 2, 0.006, (sw.z + ne.z) / 2)
      overlay.renderOrder = 2
      overlay.receiveShadow = true
      scene.add(overlay)
    }

    // Survey grid: hairlines plus a lit boundary frame.
    const gridGroup = new THREE.Group()
    const pts: THREE.Vector3[] = []
    const g = MISSION.grid
    for (let c = 0; c <= g.cols; c++) {
      const x = -BLOCK_W / 2 + c * g.cellSizeM
      pts.push(new THREE.Vector3(x, 0, -BLOCK_H / 2), new THREE.Vector3(x, 0, BLOCK_H / 2))
    }
    for (let r = 0; r <= g.rows; r++) {
      const z = BLOCK_H / 2 - r * g.cellSizeM
      pts.push(new THREE.Vector3(-BLOCK_W / 2, 0, z), new THREE.Vector3(BLOCK_W / 2, 0, z))
    }
    const gridLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xe9edf1, transparent: true, opacity: 0.32, depthWrite: false }),
    )
    gridLines.position.y = 0.02
    gridLines.renderOrder = 3
    gridGroup.add(gridLines)
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.9 })
    for (const [w, d, x, z] of [
      [BLOCK_W + 0.08, 0.06, 0, -BLOCK_H / 2],
      [BLOCK_W + 0.08, 0.06, 0, BLOCK_H / 2],
      [0.06, BLOCK_H + 0.08, -BLOCK_W / 2, 0],
      [0.06, BLOCK_H + 0.08, BLOCK_W / 2, 0],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), frameMat)
      bar.position.set(x, 0.02, z)
      gridGroup.add(bar)
    }
    // Corner posts.
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 10), new THREE.MeshStandardMaterial({ color: 0xe8792b, roughness: 0.6 }))
      post.position.set((x * BLOCK_W) / 2, 0.3, (z * BLOCK_H) / 2)
      post.castShadow = true
      gridGroup.add(post)
    }
    scene.add(gridGroup)

    // Coverage: one instanced tile per cell, faded in as each is imaged.
    const cellCount = g.cols * g.rows
    const coverage = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(g.cellSizeM * 0.94, g.cellSizeM * 0.94),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
      cellCount,
    )
    const cellFade = new Float32Array(cellCount)
    const cellTarget = new Float32Array(cellCount)
    {
      const m = new THREE.Matrix4()
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          const i = r * g.cols + c
          m.compose(new THREE.Vector3(-BLOCK_W / 2 + (c + 0.5) * g.cellSizeM, 0.012, BLOCK_H / 2 - (r + 0.5) * g.cellSizeM), q, new THREE.Vector3(1, 1, 1))
          coverage.setMatrixAt(i, m)
          coverage.setColorAt(i, new THREE.Color(0, 0, 0))
        }
      }
    }
    coverage.renderOrder = 2
    scene.add(coverage)
    const covColor = new THREE.Color(0x5cc8f5)

    // Ground track: a glowing tube along the flown path.
    let trackMesh: THREE.Mesh | null = null
    const trackMat = new THREE.MeshBasicMaterial({ color: 0x5cc8f5, transparent: true, opacity: 0.85, depthWrite: false })
    const rebuildTrack = () => {
      if (trackMesh) {
        scene.remove(trackMesh)
        trackMesh.geometry.dispose()
        trackMesh = null
      }
      const track = (st.current.progress?.track ?? []).filter(validCoordinate)
      if (!st.current.layers.track || track.length < 2) return
      const pts3 = track.map((p) => toLocal(p).setY(0.05))
      const curve = new THREE.CatmullRomCurve3(pts3, false, 'centripetal')
      trackMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(1200, pts3.length * 3), 0.035, 6, false), trackMat)
      trackMesh.renderOrder = 4
      scene.add(trackMesh)
    }

    // Air trail: the last few seconds of flight at altitude, fading out.
    const TRAIL_N = 90
    const trailPos = new Float32Array(TRAIL_N * 3)
    const trailCol = new Float32Array(TRAIL_N * 3)
    const trailGeo = new THREE.BufferGeometry()
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3))
    trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3))
    trailGeo.setDrawRange(0, 0)
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
    trail.frustumCulled = false
    scene.add(trail)
    const trailPts: THREE.Vector3[] = []

    // Home pad.
    const homePad = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 48),
      new THREE.MeshStandardMaterial({ map: helipadTexture(), transparent: true, roughness: 0.8, depthWrite: false }),
    )
    homePad.rotation.x = -Math.PI / 2
    homePad.position.copy(toLocal(HOME)).setY(0.025)
    homePad.receiveShadow = true
    homePad.renderOrder = 3
    scene.add(homePad)

    // Aircraft.
    const drone = makeDrone(glow)
    drone.root.visible = false
    scene.add(drone.root)

    // Beacons.
    const beacons = new Map<string, Beacon>()
    let mountedAt = performance.now()
    const syncBeacons = () => {
      const want = st.current.layers.detections ? st.current.detections.filter((d) => validCoordinate(d.position)) : []
      const ids = new Set(want.map((d) => d.id))
      for (const [id, b] of beacons) {
        if (!ids.has(id)) {
          scene.remove(b.group)
          disposeObject(b.group)
          beacons.delete(id)
        }
      }
      const now = performance.now()
      for (const d of want) {
        const b = beacons.get(d.id)
        if (!b) {
          // Only animate arrivals after the first second; the initial set just appears.
          const nb = makeBeacon(d, beamTex, now - mountedAt < 1000 ? -1e9 : now)
          beacons.set(d.id, nb)
          scene.add(nb.group)
        } else if (b.risk !== riskOf(d) || b.reviewState !== d.review.state) {
          recolorBeacon(b, d)
        }
      }
    }

    // ---- camera helpers ----
    const offsetNow = () => camera.position.clone().sub(controls.target)
    const tweenTo = (target: THREE.Vector3, offset: THREE.Vector3, dur = 750) => {
      st.current.tween = {
        from: { target: controls.target.clone(), offset: offsetNow() },
        to: { target: target.clone(), offset: offset.clone() },
        start: performance.now(),
        dur,
      }
    }
    const fit = (animate: boolean) => {
      const target = FIT_TARGET.clone()
      const aspect = camera.aspect || 1.6
      const dist = aspect < 1 ? 32 : 23
      if (animate) tweenTo(target, homeOffset(dist))
      else {
        controls.target.copy(target)
        camera.position.copy(target).add(homeOffset(dist))
      }
    }

    api.current = { setBasemap, syncBeacons, fit, setOverlay }

    onControls?.({
      zoomIn: () => tweenTo(controls.target, offsetNow().multiplyScalar(0.62), 380),
      zoomOut: () => tweenTo(controls.target, offsetNow().multiplyScalar(1.6), 380),
      flyTo: (lat, lon) => {
        const off = offsetNow()
        const len = off.length()
        if (len > 14) off.multiplyScalar(14 / len)
        tweenTo(toLocal({ lat, lon }), off, 800)
      },
      resetNorth: () => {
        const len = offsetNow().length()
        const polar = (30 * Math.PI) / 180
        tweenTo(controls.target, new THREE.Vector3(0, Math.cos(polar) * len, Math.sin(polar) * len), 600)
      },
      getView: () => {
        const ll = toLatLng(controls.target)
        const dist = offsetNow().length()
        return { lat: ll.lat, lon: ll.lon, zoom: 21.3 - Math.log2(dist / 21) }
      },
    })

    // ---- pointer: click to select, hover for the tooltip ----
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    let down: { x: number; y: number } | null = null
    let hoverId: string | null = null
    let lastMove: PointerEvent | null = null

    const pickAt = (ev: PointerEvent | MouseEvent): { id: string | null; ground: THREE.Vector3 | null } => {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects([...beacons.values()].map((b) => b.hit), false)
      const id = (hits[0]?.object.userData.detectionId as string | undefined) ?? null
      const ground = new THREE.Vector3()
      return { id, ground: raycaster.ray.intersectPlane(groundPlane, ground) ? ground : null }
    }
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 5) return
      const { id, ground } = pickAt(e)
      if (id) cb.current.onSelect(id)
      else if (ground) cb.current.onMapClick?.(toLatLng(ground))
    }
    const onMove = (e: PointerEvent) => {
      lastMove = e
    }
    const onLeave = () => {
      lastMove = null
      hoverId = null
      if (tipRef.current) tipRef.current.style.display = 'none'
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)

    // ---- sizing ----
    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = `${w}px`
      renderer.domElement.style.height = `${h}px`
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    // ---- the loop ----
    const shown = { pos: new THREE.Vector3(), alt: 0, heading: 0, armed: false, ok: false }
    const vel = new THREE.Vector3()
    const prevPos = new THREE.Vector3()
    let propSpeed = 0
    let last = performance.now()
    let raf = 0
    let lastBearing = NaN
    let lastTrackLen = -1
    const projected = new THREE.Vector3()

    const placeLabel = (el: HTMLDivElement | null, world: THREE.Vector3 | null) => {
      if (!el) return
      if (!world) {
        el.style.display = 'none'
        return
      }
      projected.copy(world).project(camera)
      if (projected.z > 1) {
        el.style.display = 'none'
        return
      }
      const x = (projected.x * 0.5 + 0.5) * host.clientWidth
      const y = (-projected.y * 0.5 + 0.5) * host.clientHeight
      el.style.display = 'block'
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    }

    const interpolate = (now: number) => {
      const s = st.current.samples
      if (!s.length) {
        shown.ok = false
        return
      }
      const t = now - INTERP_DELAY_MS
      let a = s[0]!
      let b = s[0]!
      if (t <= s[0]!.t) {
        a = b = s[0]!
      } else if (t >= s[s.length - 1]!.t) {
        a = b = s[s.length - 1]!
      } else {
        for (let i = 1; i < s.length; i++) {
          if (s[i]!.t >= t) {
            a = s[i - 1]!
            b = s[i]!
            break
          }
        }
      }
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      shown.pos.lerpVectors(a.pos, b.pos, k)
      shown.alt = a.alt + (b.alt - a.alt) * k
      const dh = ((((b.heading - a.heading) % 360) + 540) % 360) - 180
      shown.heading = (a.heading + dh * k + 360) % 360
      shown.armed = b.armed
      shown.ok = true
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const S = st.current
      const L = S.layers

      // Camera tween (fit / fly-to / zoom buttons).
      if (S.tween) {
        const tw = S.tween
        const u = Math.min(1, (now - tw.start) / tw.dur)
        const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
        controls.target.lerpVectors(tw.from.target, tw.to.target, e)
        const off = new THREE.Vector3().lerpVectors(tw.from.offset, tw.to.offset, e)
        camera.position.copy(controls.target).add(off)
        if (u >= 1) S.tween = null
      }

      // Aircraft.
      interpolate(now)
      if (shown.ok) {
        drone.root.visible = true
        drone.root.position.set(shown.pos.x, Math.max(0.09 * DRONE_SCALE, shown.alt + 0.09 * DRONE_SCALE), shown.pos.z)
        const alt = drone.root.position.y
        drone.yaw.rotation.y = (-shown.heading * Math.PI) / 180
        // Velocity → bank into the motion.
        if (prevPos.lengthSq() > 0 && dt > 0) {
          const v = new THREE.Vector3().subVectors(shown.pos, prevPos).divideScalar(dt)
          if (v.length() < 30) vel.lerp(v, Math.min(1, dt * 4))
        }
        prevPos.copy(shown.pos)
        const h = (shown.heading * Math.PI) / 180
        const fwd = vel.x * Math.sin(h) + -vel.z * Math.cos(h)
        const right = vel.x * Math.cos(h) + vel.z * Math.sin(h)
        drone.tilt.rotation.x += (-Math.max(-0.35, Math.min(0.35, fwd * 0.12)) - drone.tilt.rotation.x) * Math.min(1, dt * 5)
        drone.tilt.rotation.z += (-Math.max(-0.3, Math.min(0.3, right * 0.12)) - drone.tilt.rotation.z) * Math.min(1, dt * 5)
        // Hover bob while airborne.
        if (shown.alt > 0.3) drone.tilt.position.y = Math.sin(now / 520) * 0.03
        // Rotors spool up and down smoothly.
        propSpeed += ((shown.armed ? 1 : 0) - propSpeed) * Math.min(1, dt * 2.2)
        for (const p of drone.props) p.rotation.y += propSpeed * dt * 60
        for (const d of drone.discs) (d.material as THREE.MeshBasicMaterial).opacity = propSpeed * 0.16
        for (const p of drone.props) p.visible = propSpeed < 0.85
        ;(drone.strobe.material as THREE.SpriteMaterial).opacity = shown.armed && now % 1200 < 90 ? 1 : 0
        // Tether, ground ring, frustum and footprint.
        const groundAlt = Math.max(0.01, alt - 0.02)
        drone.tether.scale.set(1, groundAlt, 1)
        drone.tether.visible = shown.alt > 0.25
        drone.ring.position.y = -alt + 0.035
        const pulse = 1 + 0.12 * Math.sin(now / 300)
        drone.ring.scale.set(pulse, pulse, pulse)
        const showFoot = L.footprint && shown.alt > 0.4
        const fe = footprintHalfExtents(Math.max(0.1, shown.alt))
        drone.frustum.visible = showFoot
        drone.footprint.visible = showFoot
        drone.footFill.visible = showFoot
        if (showFoot) {
          drone.frustum.position.y = -0.05
          drone.frustum.scale.set(fe.halfAcross, alt - 0.05, fe.halfAlong)
          drone.footprint.position.y = -alt + 0.05
          drone.footprint.scale.set(fe.halfAcross, 1, fe.halfAlong)
          drone.footFill.position.y = -alt + 0.045
          drone.footFill.scale.set(fe.halfAcross, fe.halfAlong, 1)
        }

        // Air trail.
        const tip = drone.root.position
        const lastPt = trailPts[trailPts.length - 1]
        if (!lastPt || lastPt.distanceTo(tip) > 0.12) {
          trailPts.push(tip.clone())
          if (trailPts.length > TRAIL_N) trailPts.shift()
        }
        for (let i = 0; i < trailPts.length; i++) {
          const p = trailPts[i]!
          trailPos.set([p.x, p.y, p.z], i * 3)
          const f = (i / trailPts.length) ** 1.6
          trailCol.set([0.36 * f, 0.78 * f, 0.96 * f], i * 3)
        }
        trailGeo.setDrawRange(0, trailPts.length)
        trailGeo.attributes.position!.needsUpdate = true
        trailGeo.attributes.color!.needsUpdate = true
        trail.visible = L.track && shown.alt > 0.3

        // Follow: carry the camera with the aircraft, keeping the operator's angle.
        if (S.follow === 'follow' && !S.tween) {
          // Aim between the ground and the aircraft, so both stay in shot when close.
          const goal = new THREE.Vector3(shown.pos.x, Math.max(0, shown.alt) * 0.6, shown.pos.z)
          const delta = goal.sub(controls.target).multiplyScalar(Math.min(1, dt * 3))
          controls.target.add(delta)
          camera.position.add(delta)
        }
      } else {
        drone.root.visible = false
      }

      // Coverage fade.
      if (S.dirtyCoverage) {
        S.dirtyCoverage = false
        cellTarget.fill(0)
        if (L.coverage) {
          for (const id of S.progress?.coveredCells ?? []) {
            const c = parseCellId(id)
            if (c && c.col < g.cols && c.row < g.rows) cellTarget[c.row * g.cols + c.col] = 1
          }
        }
      }
      let covChanged = false
      const tmpC = new THREE.Color()
      for (let i = 0; i < cellCount; i++) {
        if (cellFade[i] === cellTarget[i]) continue
        const dir = cellTarget[i]! > cellFade[i]! ? 1 : -1
        cellFade[i] = Math.max(0, Math.min(1, cellFade[i]! + dir * dt * 2.2))
        if (Math.abs(cellFade[i]! - cellTarget[i]!) < 0.01) cellFade[i] = cellTarget[i]!
        tmpC.copy(covColor).multiplyScalar(cellFade[i]! * 0.055)
        coverage.setColorAt(i, tmpC)
        covChanged = true
      }
      if (covChanged && coverage.instanceColor) coverage.instanceColor.needsUpdate = true

      // Track rebuild only when it grew.
      const tl = S.progress?.track.length ?? 0
      if (S.dirtyTrack || tl !== lastTrackLen) {
        S.dirtyTrack = false
        lastTrackLen = tl
        rebuildTrack()
      }
      gridGroup.visible = L.grid

      // Beacons.
      const tsec = now / 1000
      for (const b of beacons.values()) {
        const sel = b.id === S.selectedId
        const age = (now - b.born) / 1000
        const grow = Math.min(1, Math.max(0, age / 0.9))
        const ease = 1 - Math.pow(1 - grow, 3)
        const dim = b.reviewState === 'dismissed' ? 0.45 : 1
        b.beam.scale.set(1, Math.max(0.001, ease), 1)
        b.beam.position.y = (BEAM_H * ease) / 2
        ;(b.beam.material as THREE.MeshBasicMaterial).opacity = (sel ? 1 : 0.85) * dim
        b.head.position.y = BEAM_H * ease + 0.25 + Math.sin(tsec * 1.6 + b.seed) * 0.06
        b.head.rotation.y = tsec * 0.9 + b.seed
        const hs = (sel ? 1.55 : 1) * (0.4 + 0.6 * ease) * (b.reviewState === 'dismissed' ? 0.7 : 1)
        b.head.scale.set(hs, hs * 1.35, hs)
        const rp = 1 + (sel ? 0.25 : 0.1) * Math.sin(tsec * (sel ? 5 : 2.4) + b.seed)
        b.ring.scale.set(rp * (sel ? 1.4 : 1), rp * (sel ? 1.4 : 1), 1)
        ;(b.halo.material as THREE.MeshBasicMaterial).opacity = (sel ? 0.18 : 0.08) * dim
        // Arrival shockwave, then a slow idle ripple for unreviewed hazards.
        const shockMat = b.shock.material as THREE.MeshBasicMaterial
        if (age < 1.6) {
          const u = age / 1.6
          b.shock.scale.setScalar(0.2 + u * 2.6)
          shockMat.opacity = (1 - u) * 0.9
        } else if (b.risk === 'hazard' && b.reviewState === 'unreviewed') {
          const u = ((tsec + b.seed) % 2.4) / 2.4
          b.shock.scale.setScalar(0.25 + u * 0.8)
          shockMat.opacity = (1 - u) * 0.45
        } else shockMat.opacity = 0
      }

      // Hover tooltip (one raycast per frame at most, only while the mouse moves).
      if (lastMove) {
        const ev = lastMove
        lastMove = null
        const { id } = pickAt(ev)
        if (id !== hoverId) {
          hoverId = id
          const d = id ? S.detections.find((x) => x.id === id) : null
          if (tipRef.current) {
            if (d) {
              tipRef.current.innerHTML = pinTooltipHtml(d)
              tipRef.current.style.display = 'block'
            } else tipRef.current.style.display = 'none'
          }
          renderer.domElement.style.cursor = id ? 'pointer' : ''
        }
        if (hoverId && tipRef.current) {
          const r = host.getBoundingClientRect()
          tipRef.current.style.transform = `translate3d(${ev.clientX - r.left + 14}px, ${ev.clientY - r.top + 14}px, 0)`
        }
      }

      controls.update()

      // Screen labels.
      placeLabel(droneLabelRef.current, shown.ok ? drone.root.position.clone().add(new THREE.Vector3(0, 0.55, 0)) : null)
      if (droneLabelRef.current && shown.ok) {
        droneLabelRef.current.textContent = shown.alt > 0.25 ? `Drone · ${shown.alt.toFixed(1)} m` : 'Drone · on pad'
      }
      const selB = S.selectedId ? beacons.get(S.selectedId) : undefined
      const selD = S.selectedId ? S.detections.find((d) => d.id === S.selectedId) : undefined
      placeLabel(selLabelRef.current, selB ? selB.group.position.clone().setY(BEAM_H + 0.7) : null)
      if (selLabelRef.current && selD) selLabelRef.current.textContent = `${selD.id} · ${selD.gridCell} · ${formatConfidence(selD.confidence)}`

      // Compass bearing: where the camera is looking, degrees clockwise from north.
      const dir = controls.target.clone().sub(camera.position)
      const bearing = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI
      if (!(Math.abs(bearing - lastBearing) < 0.5)) {
        lastBearing = bearing
        cb.current.onBearing?.(bearing)
      }

      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(frame)
    mountedAt = performance.now()

    return () => {
      cancelAnimationFrame(raf)
      buildingsAbort.abort()
      ro.disconnect()
      onControls?.(null)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
        for (const x of mats) {
          for (const v of Object.values(x)) if (v instanceof THREE.Texture) v.dispose()
          x.dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
      api.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- data → scene ----

  useEffect(() => {
    api.current?.setBasemap(basemap)
  }, [basemap])

  useEffect(() => {
    api.current?.setOverlay(droneOverlay, layers.drone)
  }, [droneOverlay, layers.drone])

  useEffect(() => {
    st.current.detections = detections
    api.current?.syncBeacons()
  }, [detections, layers.detections])

  useEffect(() => {
    st.current.progress = progress
    st.current.dirtyCoverage = true
  }, [progress, layers.coverage])

  useEffect(() => {
    st.current.dirtyTrack = true
  }, [layers.track])

  useEffect(() => {
    if (!telemetry || !validCoordinate(telemetry.position)) return
    const s = st.current.samples
    const pos = toLocal(telemetry.position)
    const now = performance.now()
    const lastS = s[s.length - 1]
    if (lastS && lastS.pos.distanceTo(pos) > SNAP_M) s.length = 0
    s.push({ t: now, pos, alt: telemetry.altitudeM, heading: telemetry.headingDeg, armed: telemetry.armed })
    // The first packet is duplicated into the past so the drone appears at once.
    if (s.length === 1) s.unshift({ ...s[0]!, t: now - INTERP_DELAY_MS - 1 })
    while (s.length > 2 && s[1]!.t < now - INTERP_DELAY_MS - 2000) s.shift()
  }, [telemetry])

  useEffect(() => {
    if (follow !== 'fit') return
    if (refitKey === 0 && initialView) return
    api.current?.fit(refitKey !== 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refitKey, follow])

  return (
    <div className="absolute inset-0 overflow-hidden bg-ink-deep">
      <div ref={holder} className="absolute inset-0" aria-label="3D mission view" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={droneLabelRef}
          className="absolute left-0 top-0 hidden whitespace-nowrap rounded-md border border-signal/40 bg-ink-deep/85 px-2 py-0.5 font-mono text-[0.6875rem] font-medium text-signal shadow-glass"
        />
        <div
          ref={selLabelRef}
          className="absolute left-0 top-0 hidden whitespace-nowrap rounded-md border border-white/15 bg-ink-deep/90 px-2 py-0.5 font-mono text-[0.6875rem] font-medium text-paper shadow-glass"
        />
        <div
          ref={tipRef}
          className="absolute left-0 top-0 hidden rounded-lg border border-white/10 bg-ink-raised/95 px-2.5 py-2 text-paper shadow-glass"
        />
      </div>
    </div>
  )
}
