import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Radio, X } from 'lucide-react'
import type { Detection, Telemetry } from '@/types'
import { ALL_DETECTIONS } from '@/lib/mockData'
import { footprintHalfExtents } from '@/lib/footprint'
import { GROUND_PX_PER_M, getGroundCanvas, groundPx, localM } from '@/lib/groundTexture'
import { PoseBuffer } from '@/lib/poseInterp'
import { RISK_HEX, riskOfConfidence } from '@/lib/risk'
import type { SimPhase } from '@/lib/simulation'
import { usePersistedState } from '@/hooks/usePersistedState'

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

/** Internal render size: 16:9, crisp at the docked width. */
const FW = 960
const FH = 540
/** Detector latency shown in the HUD, ms — the TensorRT engine's measured range. */
const INFER_MS = [17, 23]

/**
 * SimFeed — the synthetic camera, for the fully simulated demonstration.
 *
 * Stands in for the Jetson's MJPEG stream. It looks straight down from the
 * aircraft's interpolated pose onto the same procedural ground the 3D view uses,
 * so every target it boxes is the object under the drone on the map. Boxes are
 * drawn for every target in frame, the way the onboard detector overlays its
 * output; a target is *logged* (pinned on the map, toasted, counted) when the
 * aircraft passes over it, and the box then carries its detection id.
 */
export function SimFeed({
  telemetry,
  detections,
  phase,
  docked = false,
  floatClassName = 'right-[4.25rem] top-3 w-[min(400px,34vw)]',
}: {
  telemetry: Telemetry | null
  detections: Detection[]
  phase: SimPhase | null
  docked?: boolean
  floatClassName?: string
}) {
  const [open, setOpen] = usePersistedState('camera-open', true, isBoolean)
  const [full, setFull] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pose = useRef(new PoseBuffer())
  const live = useRef({ detections, phase, telemetry })
  live.current = { detections, phase, telemetry }
  const flashAt = useRef(0)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (telemetry) pose.current.push(telemetry)
  }, [telemetry])

  // Flash the frame when a new detection is logged.
  useEffect(() => {
    const ids = new Set(detections.map((d) => d.id))
    if (seen.current) {
      for (const id of ids) if (!seen.current.has(id)) flashAt.current = performance.now()
    }
    seen.current = ids
  }, [detections])

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  useEffect(() => {
    if (!open) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const ground = getGroundCanvas()
    const grain = makeGrain()
    let raf = 0
    let lastDraw = 0
    let frameNo = 0
    let fps = 30
    let infer = 19

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden || now - lastDraw < 32) return
      fps = fps * 0.9 + (1000 / Math.max(1, now - lastDraw)) * 0.1
      lastDraw = now
      frameNo++
      const p = pose.current.sample(now)
      const { detections: dets, phase: ph, telemetry: tel } = live.current

      ctx.save()
      ctx.fillStyle = '#0c0f0b'
      ctx.fillRect(0, 0, FW, FH)
      if (p) {
        // Looking straight down; the frame's top edge points along the heading.
        const alt = Math.max(0.6, p.alt + 0.25)
        const fe = footprintHalfExtents(alt)
        const scale = FW / (2 * fe.halfAcross * GROUND_PX_PER_M)
        const { e, n } = localM({ lat: p.lat, lon: p.lon })
        const gp = groundPx(e, n)
        // A little hand-held shake while airborne.
        const shake = p.alt > 0.3 ? 1 : 0
        const jx = Math.sin(now / 97) * 1.2 * shake
        const jy = Math.cos(now / 131) * 1.2 * shake
        ctx.translate(FW / 2 + jx, FH / 2 + jy)
        ctx.rotate((-p.heading * Math.PI) / 180)
        ctx.scale(scale, scale)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.filter = 'contrast(1.08) saturate(1.05)'
        ctx.drawImage(ground, -gp.x, -gp.y)
        ctx.filter = 'none'
        ctx.restore()
        ctx.save()

        // Project every target into the frame and box what the camera sees.
        const logged = new Map(dets.map((d) => [d.id, d]))
        const hRad = (p.heading * Math.PI) / 180
        const pxPerM = FW / (2 * fe.halfAcross)
        const airborne = p.alt > 0.5 && ph !== 'landing'
        ctx.lineWidth = 2
        ctx.font = '600 18px "JetBrains Mono Variable", ui-monospace, monospace'
        for (const t of ALL_DETECTIONS) {
          const tl = localM(t.position)
          const de = tl.e - e
          const dn = tl.n - n
          // Rotate into camera axes: x right, y forward.
          const cx = de * Math.cos(hRad) - dn * Math.sin(hRad)
          const cy = de * Math.sin(hRad) + dn * Math.cos(hRad)
          const sx = FW / 2 + cx * pxPerM
          const sy = FH / 2 - cy * pxPerM
          const half = 0.24 * pxPerM
          if (sx < half || sx > FW - half || sy < half || sy > FH - half) continue
          const d = logged.get(t.id)
          if (!d && !airborne) continue
          // The model is surer as the target nears nadir; logged ones show their logged score.
          const centred = 1 - Math.min(1, Math.hypot(cx, cy) / (fe.halfAcross * 1.1))
          const conf = d ? d.confidence : Math.max(0.2, t.confidence * (0.72 + 0.28 * centred))
          if (!d && conf < 0.3) continue
          const color = RISK_HEX[riskOfConfidence(conf)]
          const wob = d ? 0 : Math.sin(now / 70 + t.confidence * 40) * 1.5
          drawBox(ctx, sx - half + wob, sy - half, half * 2, half * 2, color)
          const label = d ? `${d.id}  landmine ${conf.toFixed(2)}` : `landmine ${conf.toFixed(2)}`
          const tw = ctx.measureText(label).width + 12
          const ly = sy - half - 28 < 4 ? sy + half + 4 : sy - half - 28
          ctx.fillStyle = color
          ctx.fillRect(sx - half, ly, tw, 25)
          ctx.fillStyle = '#0a0e13'
          ctx.fillText(label, sx - half + 6, ly + 19)
        }
      }
      ctx.restore()

      // Lens: vignette and sensor grain.
      const vg = ctx.createRadialGradient(FW / 2, FH / 2, FH * 0.35, FW / 2, FH / 2, FW * 0.62)
      vg.addColorStop(0, 'rgba(0,0,0,0)')
      vg.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, FW, FH)
      ctx.globalAlpha = 0.07
      ctx.drawImage(grain, -((frameNo * 37) % 128), -((frameNo * 53) % 128))
      ctx.globalAlpha = 1

      // Detection flash.
      const since = now - flashAt.current
      if (since < 900) {
        ctx.strokeStyle = `rgba(230,114,119,${(1 - since / 900) * 0.9})`
        ctx.lineWidth = 10
        ctx.strokeRect(5, 5, FW - 10, FH - 10)
      }

      // HUD.
      if (frameNo % 15 === 0) infer = INFER_MS[0]! + Math.random() * (INFER_MS[1]! - INFER_MS[0]!)
      hud(ctx, { tel, alt: p?.alt ?? 0, heading: p?.heading ?? 0, fps, infer, phase: ph, armed: p?.armed ?? false, recording: (now % 1000) < 600 })
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [open])

  if (!open) {
    return (
      <div className={docked ? 'flex w-full shrink-0 items-center justify-center border-l border-rule bg-ink-deep lg:w-camera' : `pointer-events-auto absolute z-[520] ${floatClassName.replace(/\bw-\S+/g, '')}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="glass flex items-center gap-1.5 px-3 py-2 text-[0.8125rem] font-medium text-paper-dim hover:text-paper"
        >
          <Radio size={12} aria-hidden="true" />
          Camera
        </button>
      </div>
    )
  }

  const status = phase === 'standby' ? 'Idle on pad' : phase === 'complete' ? 'Landed · detector stopped' : 'Detector running'

  return (
    <div
      className={
        full
          ? 'pointer-events-auto fixed inset-0 z-[900] flex flex-col bg-ink-deep animate-rise-in'
          : docked
            ? 'flex w-full shrink-0 flex-col border-l border-rule bg-ink-deep lg:w-camera'
            : `glass pointer-events-auto absolute z-[520] overflow-hidden animate-rise-in ${floatClassName}`
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full rounded-full ${phase === 'standby' || phase === 'complete' ? 'bg-paper-faint' : 'animate-ping bg-hazard/70'}`} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${phase === 'standby' || phase === 'complete' ? 'bg-paper-faint' : 'bg-hazard'}`} />
          </span>
          <span className="text-[0.8125rem] font-medium text-paper">Camera</span>
          <span className="truncate text-[0.6875rem] text-paper-faint">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setFull((f) => !f)}
            aria-label={full ? 'Exit full view' : 'Full view'}
            title={full ? 'Exit full view (Esc)' : 'Full view'}
            className="flex h-7 w-7 items-center justify-center rounded-md text-paper-faint transition-colors hover:bg-white/[0.06] hover:text-paper"
          >
            {full ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setFull(false)
              setOpen(false)
            }}
            aria-label="Hide camera"
            title="Hide"
            className="flex h-7 w-7 items-center justify-center rounded-md text-paper-faint transition-colors hover:bg-white/[0.06] hover:text-paper"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={full ? 'relative grid min-h-0 flex-1 place-items-center bg-black' : 'relative bg-black'}>
        <canvas
          ref={canvasRef}
          width={FW}
          height={FH}
          className={full ? 'max-h-full max-w-full object-contain' : 'block aspect-video w-full'}
          aria-label="Simulated downward camera with detector boxes"
        />
      </div>
      <p className="border-t border-rule px-3 py-1.5 text-[0.6875rem] leading-snug text-paper-faint">
        Simulated nadir camera. Boxes are the onboard detector; a target is logged as the aircraft passes over it.
      </p>
    </div>
  )
}

function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)
  // Corner ticks, heavier, the way detector overlays mark a box.
  const k = Math.min(w, h) * 0.28
  ctx.lineWidth = 4
  ctx.beginPath()
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ] as const) {
    ctx.moveTo(cx + dx * k, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + dy * k)
  }
  ctx.stroke()
}

function hud(
  ctx: CanvasRenderingContext2D,
  o: { tel: Telemetry | null; alt: number; heading: number; fps: number; infer: number; phase: SimPhase | null; armed: boolean; recording: boolean },
) {
  ctx.save()
  ctx.font = '600 21px "JetBrains Mono Variable", ui-monospace, monospace'
  ctx.textBaseline = 'top'
  const shadow = (t: string, x: number, y: number, color = 'rgba(233,237,241,0.92)', align: CanvasTextAlign = 'left') => {
    ctx.textAlign = align
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(t, x + 1, y + 1)
    ctx.fillStyle = color
    ctx.fillText(t, x, y)
  }
  shadow(`CAM0  1280×720  ${Math.round(o.fps)} FPS`, 16, 14)
  shadow(`YOLOv8-TRT  ${o.infer.toFixed(0)} ms`, 16, 42, 'rgba(92,200,245,0.95)')
  if (o.phase !== 'standby' && o.phase !== 'complete') {
    ctx.fillStyle = o.recording ? '#dc3840' : 'rgba(220,56,64,0.35)'
    ctx.beginPath()
    ctx.arc(FW - 82, 26, 8, 0, Math.PI * 2)
    ctx.fill()
    shadow('REC', FW - 16, 14, 'rgba(233,237,241,0.92)', 'right')
  } else {
    shadow(o.phase === 'complete' ? 'LANDED' : 'STANDBY', FW - 16, 14, 'rgba(201,146,44,0.95)', 'right')
  }
  shadow(o.armed ? 'ARMED' : 'DISARMED', FW - 16, 42, o.armed ? 'rgba(230,114,119,0.95)' : 'rgba(154,166,178,0.9)', 'right')

  ctx.textBaseline = 'alphabetic'
  shadow(`ALT ${o.alt.toFixed(1)} m`, 16, FH - 18)
  shadow(`HDG ${String(Math.round(o.heading)).padStart(3, '0')}°`, 190, FH - 18)
  if (o.tel) {
    shadow(`GS ${o.tel.groundSpeedMs.toFixed(1)} m/s`, 360, FH - 18)
    shadow(`${o.tel.position.lat.toFixed(6)}N ${o.tel.position.lon.toFixed(6)}E`, FW - 16, FH - 18, 'rgba(233,237,241,0.92)', 'right')
  }

  // Centre reticle.
  ctx.strokeStyle = 'rgba(233,237,241,0.55)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(FW / 2 - 22, FH / 2)
  ctx.lineTo(FW / 2 - 8, FH / 2)
  ctx.moveTo(FW / 2 + 8, FH / 2)
  ctx.lineTo(FW / 2 + 22, FH / 2)
  ctx.moveTo(FW / 2, FH / 2 - 22)
  ctx.lineTo(FW / 2, FH / 2 - 8)
  ctx.moveTo(FW / 2, FH / 2 + 8)
  ctx.lineTo(FW / 2, FH / 2 + 22)
  ctx.stroke()
  ctx.restore()
}

function makeGrain(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = FW + 128
  c.height = FH + 128
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(c.width, c.height)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}
