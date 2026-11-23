import type { LatLng } from '@/types'
import { ALL_DETECTIONS, MISSION } from './mockData'
import { M_PER_DEG_LAT, gridCenter, mPerDegLon } from './geo'
import { mulberry32 } from './rng'

/**
 * A procedural, centimetre-scale picture of the survey ground.
 *
 * Satellite imagery stops at ~30 cm/px here, which makes a 30 cm object a single
 * smudged pixel. For the simulated demonstration the 3D scene and the synthetic
 * camera need a ground they can both look at closely, so this paints one: soil,
 * grass, stones, the survey stakes at the block corners, and every seeded target
 * as a physical object at its true position. Because both views sample the same
 * canvas, what the camera "sees" is exactly what sits under the drone on the map.
 *
 * Simulated, like everything else in demo mode.
 */

/** Side of the painted square, metres, centred on the block. */
export const GROUND_EXTENT_M = 20
/** Canvas resolution. 2048 px over 20 m ≈ 1 cm/px. */
export const GROUND_PX = 2048
const PX_PER_M = GROUND_PX / GROUND_EXTENT_M

const CENTER = gridCenter(MISSION.grid)

/** Local metres (east, north) of a position, relative to the block centre. */
export function localM(p: LatLng): { e: number; n: number } {
  return {
    e: (p.lon - CENTER.lon) * mPerDegLon(CENTER.lat),
    n: (p.lat - CENTER.lat) * M_PER_DEG_LAT,
  }
}

/** Canvas pixel for local metres. North is up the canvas. */
export function groundPx(e: number, n: number): { x: number; y: number } {
  return { x: GROUND_PX / 2 + e * PX_PER_M, y: GROUND_PX / 2 - n * PX_PER_M }
}

export const GROUND_PX_PER_M = PX_PER_M

let cached: HTMLCanvasElement | null = null

export function getGroundCanvas(): HTMLCanvasElement {
  if (cached) return cached
  const c = document.createElement('canvas')
  c.width = GROUND_PX
  c.height = GROUND_PX
  const ctx = c.getContext('2d')!
  paint(ctx)
  cached = c
  return c
}

function paint(ctx: CanvasRenderingContext2D): void {
  const rnd = mulberry32(0x5eed_9a11)
  const S = GROUND_PX

  // Base: dry, sandy soil.
  ctx.fillStyle = '#6f6047'
  ctx.fillRect(0, 0, S, S)

  // Large-scale variation: grass patches and bare earth, soft-edged.
  const patch = (x: number, y: number, r: number, color: string, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, hexA(color, a))
    g.addColorStop(1, hexA(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  for (let i = 0; i < 260; i++) {
    const tone = rnd()
    const color = tone < 0.5 ? '#56693a' : tone < 0.8 ? '#7b7a4c' : '#5c4c36'
    patch(rnd() * S, rnd() * S, 80 + rnd() * 260, color, 0.35 + rnd() * 0.35)
  }
  // Fine mottling.
  for (let i = 0; i < 5000; i++) {
    const tone = rnd()
    const color = tone < 0.4 ? '#4b5e31' : tone < 0.7 ? '#837b56' : tone < 0.85 ? '#594834' : '#8d8467'
    patch(rnd() * S, rnd() * S, 6 + rnd() * 26, color, 0.25 + rnd() * 0.3)
  }

  // Grass blades: short strokes, denser in the green patches by chance alone.
  ctx.lineCap = 'round'
  for (let i = 0; i < 70000; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const len = 3 + rnd() * 9
    const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.6
    const g = 70 + Math.floor(rnd() * 70)
    ctx.strokeStyle = `rgba(${g - 20},${g + 18},${Math.floor(g * 0.45)},${0.35 + rnd() * 0.4})`
    ctx.lineWidth = 0.8 + rnd() * 1.1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
    ctx.stroke()
  }

  // Stones and pebbles, each with a little shadow so they sit on the ground.
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 1.2 + Math.pow(rnd(), 3) * 9
    const l = 120 + Math.floor(rnd() * 70)
    ctx.fillStyle = 'rgba(20,16,10,0.35)'
    ctx.beginPath()
    ctx.ellipse(x + r * 0.35, y + r * 0.35, r, r * 0.8, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = `rgb(${l},${l - 8},${l - 22})`
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * (0.6 + rnd() * 0.35), rnd() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }

  // Survey stakes at the block corners, with orange tape.
  const g = MISSION.grid
  const W = g.cols * g.cellSizeM
  const H = g.rows * g.cellSizeM
  const corners: Array<[number, number]> = [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, H / 2],
    [-W / 2, H / 2],
  ]
  for (const [e, n] of corners) {
    const p = groundPx(e, n)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.beginPath()
    ctx.arc(p.x + 4, p.y + 4, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e8792b'
    ctx.beginPath()
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f6c08a'
    ctx.beginPath()
    ctx.arc(p.x - 2, p.y - 2, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  // The targets themselves. High-confidence seeds are mines; the weak returns are
  // the things a detector confuses with mines — a can, a twisted strip of scrap.
  for (const d of ALL_DETECTIONS) {
    const { e, n } = localM(d.position)
    const p = groundPx(e, n)
    if (d.confidence >= 0.6) drawMine(ctx, p.x, p.y, rnd)
    else drawScrap(ctx, p.x, p.y, rnd)
  }
}

function drawMine(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number): void {
  const r = PX_PER_M * (0.13 + rnd() * 0.04)
  // Disturbed earth around a buried object.
  const halo = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2)
  halo.addColorStop(0, 'rgba(84,66,44,0.85)')
  halo.addColorStop(1, 'rgba(84,66,44,0)')
  ctx.fillStyle = halo
  ctx.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8)
  // Shadow, body, rim, pressure plate.
  ctx.fillStyle = 'rgba(15,12,8,0.55)'
  ctx.beginPath()
  ctx.arc(x + r * 0.18, y + r * 0.2, r * 1.04, 0, Math.PI * 2)
  ctx.fill()
  const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r)
  body.addColorStop(0, '#6d7450')
  body.addColorStop(1, '#3a3f2a')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(20,22,14,0.8)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, r * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#4a5036'
  ctx.beginPath()
  ctx.arc(x, y, r * 0.36, 0, Math.PI * 2)
  ctx.fill()
  // Soil partly covering it.
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2
    const d = r * (0.5 + rnd() * 0.7)
    ctx.fillStyle = `rgba(${100 + rnd() * 30},${82 + rnd() * 20},${58},0.85)`
    ctx.beginPath()
    ctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.18 + rnd() * 0.22), r * 0.14, a, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawScrap(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number): void {
  const s = PX_PER_M * 0.12
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rnd() * Math.PI)
  ctx.fillStyle = 'rgba(15,12,8,0.5)'
  ctx.fillRect(-s + 3, -s * 0.35 + 3, s * 2, s * 0.7)
  const g = ctx.createLinearGradient(-s, 0, s, 0)
  g.addColorStop(0, '#7d7468')
  g.addColorStop(0.5, '#b3aa98')
  g.addColorStop(1, '#6a5d4c')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(-s, -s * 0.3)
  ctx.lineTo(s * 0.4, -s * 0.38)
  ctx.lineTo(s, -s * 0.1)
  ctx.lineTo(s * 0.8, s * 0.32)
  ctx.lineTo(-s * 0.6, s * 0.28)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = 'rgba(120,60,30,0.6)' // rust
  ctx.beginPath()
  ctx.arc(s * 0.2, 0, s * 0.18, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
