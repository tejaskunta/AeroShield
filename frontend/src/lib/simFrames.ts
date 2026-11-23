import type { BoundingBox, LatLng } from '@/types'
import { footprintHalfExtents } from './footprint'
import { GROUND_PX_PER_M, getGroundCanvas, groundPx, localM } from './groundTexture'

/**
 * Capture frames for simulated detections.
 *
 * When the simulator logs a target it calls `captureSimFrame` with the aircraft's
 * pose at that instant. The frame is rendered from the same procedural ground the
 * live camera shows, so the still in the Detection Center is exactly what the
 * camera saw when the detection fired, and its box is the target's true projection
 * rather than a decoration. A Grad-CAM-style heatmap is rendered alongside it.
 *
 * Data URLs, held in memory for the session; a reset clears them.
 */

export const SIM_FRAME_W = 640
export const SIM_FRAME_H = 360

const frames = new Map<string, { frame: string; gradcam: string }>()

export interface CapturePose {
  position: LatLng
  altM: number
  headingDeg: number
}

/** Render and store the frame for one detection; returns its box in frame pixels. */
export function captureSimFrame(id: string, target: LatLng, pose: CapturePose): BoundingBox | null {
  if (typeof document === 'undefined') return null
  const ground = getGroundCanvas()
  const c = document.createElement('canvas')
  c.width = SIM_FRAME_W
  c.height = SIM_FRAME_H
  const ctx = c.getContext('2d')!
  const alt = Math.max(0.8, pose.altM)
  const fe = footprintHalfExtents(alt)
  const scale = SIM_FRAME_W / (2 * fe.halfAcross * GROUND_PX_PER_M)
  const { e, n } = localM(pose.position)
  const gp = groundPx(e, n)
  const h = (pose.headingDeg * Math.PI) / 180

  ctx.save()
  ctx.translate(SIM_FRAME_W / 2, SIM_FRAME_H / 2)
  ctx.rotate(-h)
  ctx.scale(scale, scale)
  ctx.imageSmoothingQuality = 'high'
  ctx.filter = 'contrast(1.08) saturate(1.04)'
  ctx.drawImage(ground, -gp.x, -gp.y)
  ctx.restore()
  ctx.filter = 'none'
  // Lens vignette, as the camera renders it.
  const vg = ctx.createRadialGradient(SIM_FRAME_W / 2, SIM_FRAME_H / 2, SIM_FRAME_H * 0.35, SIM_FRAME_W / 2, SIM_FRAME_H / 2, SIM_FRAME_W * 0.62)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, SIM_FRAME_W, SIM_FRAME_H)

  // Where the target lands in this frame.
  const t = localM(target)
  const de = t.e - e
  const dn = t.n - n
  const cx = de * Math.cos(h) - dn * Math.sin(h)
  const cy = de * Math.sin(h) + dn * Math.cos(h)
  const pxPerM = SIM_FRAME_W / (2 * fe.halfAcross)
  const sx = SIM_FRAME_W / 2 + cx * pxPerM
  const sy = SIM_FRAME_H / 2 - cy * pxPerM
  const half = 0.22 * pxPerM
  const bbox: BoundingBox = {
    x1: Math.round(Math.max(1, sx - half)),
    y1: Math.round(Math.max(1, sy - half)),
    x2: Math.round(Math.min(SIM_FRAME_W - 1, sx + half)),
    y2: Math.round(Math.min(SIM_FRAME_H - 1, sy + half)),
  }
  const frame = c.toDataURL('image/jpeg', 0.86)

  // Grad-CAM: the frame desaturated, with the model's attention as a jet heatmap.
  const g = document.createElement('canvas')
  g.width = SIM_FRAME_W
  g.height = SIM_FRAME_H
  const gx = g.getContext('2d')!
  gx.filter = 'grayscale(0.85) brightness(0.7)'
  gx.drawImage(c, 0, 0)
  gx.filter = 'none'
  gx.globalCompositeOperation = 'screen'
  const blob = (x: number, y: number, r: number, k: number) => {
    const rg = gx.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, `rgba(255,40,20,${0.95 * k})`)
    rg.addColorStop(0.3, `rgba(255,200,0,${0.75 * k})`)
    rg.addColorStop(0.6, `rgba(40,220,120,${0.45 * k})`)
    rg.addColorStop(1, 'rgba(20,60,255,0)')
    gx.fillStyle = rg
    gx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  blob(sx, sy, half * 2.6, 1)
  blob(sx + half * 0.8, sy - half * 0.5, half * 1.4, 0.45)
  gx.globalCompositeOperation = 'source-over'
  const gradcam = g.toDataURL('image/jpeg', 0.84)

  frames.set(id, { frame, gradcam })
  return bbox
}

export function simFrameUrl(id: string, variant: 'frame' | 'gradcam'): string | undefined {
  const f = frames.get(id)
  return f ? f[variant] : undefined
}

export function clearSimFrames(): void {
  frames.clear()
}
