import { useId } from 'react'
import type { BoundingBox, RiskLevel } from '@/types'
import { RISK_HEX } from '@/lib/risk'

/**
 * PlaceholderFrame — a synthetic stand-in for a captured RGB frame.
 *
 * There is no imagery pipeline yet, so rather than shipping a stock photo (which
 * would read as real sensor data) this draws a deterministic procedural ground
 * texture from the detection id. It is always stamped NO SENSOR DATA, because a
 * fake aerial photo in a landmine tool is exactly the kind of placeholder that
 * gets mistaken for the real thing.
 *
 * When the ML pipeline emits real crops, this component is replaced by an `<img>`
 * and the stamp goes away with it.
 */
export function PlaceholderFrame({
  seed,
  bbox,
  risk,
  mode = 'frame',
  className = '',
  showStamp = true,
}: {
  /** Detection id — same seed always draws the same ground. */
  seed: string
  bbox?: BoundingBox
  risk?: RiskLevel
  /** `gradcam` renders the activation heatmap variant over the same ground. */
  mode?: 'frame' | 'gradcam'
  className?: string
  showStamp?: boolean
}) {
  const uid = useId().replace(/:/g, '')
  const rnd = seededRandom(seed)
  const W = 1280
  const H = 720

  // Scattered ground features — rocks, scrub, soil variation.
  const blobs = Array.from({ length: 46 }, () => ({
    cx: rnd() * W,
    cy: rnd() * H,
    r: 8 + rnd() * 58,
    tone: GROUND_TONES[Math.floor(rnd() * GROUND_TONES.length)]!,
    o: 0.18 + rnd() * 0.4,
  }))

  const hazardHex = risk ? RISK_HEX[risk] : RISK_HEX.caution
  const box = bbox
  const boxCx = box ? (box.x1 + box.x2) / 2 : W / 2
  const boxCy = box ? (box.y1 + box.y2) / 2 : H / 2

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`block h-full w-full ${className}`}
      role="img"
      aria-label={
        mode === 'gradcam'
          ? 'Simulated Grad-CAM activation map. Not real sensor data.'
          : 'Simulated capture frame. Not real sensor data.'
      }
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        {/* Grad-CAM falloff: hot at the detection centre, cooling outward. */}
        <radialGradient id={`cam-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={hazardHex} stopOpacity="0.85" />
          <stop offset="45%" stopColor="#C9922C" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#4E9E86" stopOpacity="0" />
        </radialGradient>
        <pattern id={`grain-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <rect width="3" height="3" fill="none" />
          <circle cx="1" cy="1" r="0.4" fill="#000" opacity="0.22" />
        </pattern>
      </defs>

      {/* Ground */}
      <rect width={W} height={H} fill="#1E2529" />
      {blobs.map((b, i) => (
        <circle key={i} cx={b.cx} cy={b.cy} r={b.r} fill={b.tone} opacity={b.o} />
      ))}
      <rect width={W} height={H} fill={`url(#grain-${uid})`} />

      {/* Grad-CAM activation, centred on the detection. */}
      {mode === 'gradcam' && (
        <ellipse
          cx={boxCx}
          cy={boxCy}
          rx={box ? (box.x2 - box.x1) * 1.5 : 300}
          ry={box ? (box.y2 - box.y1) * 1.5 : 200}
          fill={`url(#cam-${uid})`}
        />
      )}

      {/* Detection box drawn as corner brackets — a survey callout, not a border. */}
      {box && mode === 'frame' && <CornerBox box={box} hex={hazardHex} />}

      {showStamp && (
        <>
          <rect x={14} y={H - 40} width={252} height={26} fill="#0E141A" opacity="0.86" />
          <text
            x={26}
            y={H - 22}
            fill="#8C97A1"
            fontFamily="IBM Plex Mono, monospace"
            fontSize={13}
            letterSpacing={1.6}
          >
            {mode === 'gradcam' ? 'SIMULATED GRAD-CAM' : 'SIMULATED · NO SENSOR DATA'}
          </text>
        </>
      )}
    </svg>
  )
}

/** Corner brackets + centre cross, the way a targeting readout marks a region. */
function CornerBox({ box, hex }: { box: BoundingBox; hex: string }) {
  const { x1, y1, x2, y2 } = box
  const arm = Math.max(14, Math.min(x2 - x1, y2 - y1) * 0.22)
  const corners = [
    [x1, y1, 1, 1],
    [x2, y1, -1, 1],
    [x1, y2, 1, -1],
    [x2, y2, -1, -1],
  ] as const

  return (
    <g stroke={hex} strokeWidth={3} fill="none">
      <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} strokeWidth={1} opacity={0.5} />
      {corners.map(([x, y, sx, sy], i) => (
        <path key={i} d={`M ${x} ${y + sy * arm} L ${x} ${y} L ${x + sx * arm} ${y}`} />
      ))}
      <path
        d={`M ${(x1 + x2) / 2 - 7} ${(y1 + y2) / 2} h 14 M ${(x1 + x2) / 2} ${(y1 + y2) / 2 - 7} v 14`}
        strokeWidth={1.5}
        opacity={0.8}
      />
    </g>
  )
}

/** Desaturated earth tones — arid ground, not a lush satellite view. */
const GROUND_TONES = ['#2C3238', '#3A3B33', '#454034', '#2A3035', '#4A4437', '#33383B']

/** FNV-1a hash → mulberry32, so a detection id always draws the same ground. */
function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let a = h >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
