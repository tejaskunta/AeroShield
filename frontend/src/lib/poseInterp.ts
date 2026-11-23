import type { Telemetry } from '@/types'

/**
 * Smooth aircraft pose between telemetry packets.
 *
 * Packets arrive a few times a second. Drawing each as it lands makes the aircraft
 * hop; easing toward the newest one makes it lag and overshoot corners. This renders
 * a fixed delay behind the newest packet instead, so there is always a real sample
 * on either side to interpolate between and motion is at constant speed.
 */
export interface Pose {
  lat: number
  lon: number
  alt: number
  heading: number
  armed: boolean
}

interface Sample extends Pose {
  t: number
}

export class PoseBuffer {
  private s: Sample[] = []
  constructor(private delayMs = 620) {}

  push(tel: Telemetry): void {
    const now = performance.now()
    const p: Sample = {
      t: now,
      lat: tel.position.lat,
      lon: tel.position.lon,
      alt: tel.altitudeM,
      heading: tel.headingDeg,
      armed: tel.armed,
    }
    const last = this.s[this.s.length - 1]
    // A big jump is a reset (new sortie), not motion.
    if (last && (Math.abs(last.lat - p.lat) > 1e-4 || Math.abs(last.lon - p.lon) > 1e-4)) this.s = []
    this.s.push(p)
    if (this.s.length === 1) this.s.unshift({ ...p, t: now - this.delayMs - 1 })
    while (this.s.length > 2 && this.s[1]!.t < now - this.delayMs - 2000) this.s.shift()
  }

  sample(now = performance.now()): Pose | null {
    const s = this.s
    if (!s.length) return null
    const t = now - this.delayMs
    if (t <= s[0]!.t) return s[0]!
    const last = s[s.length - 1]!
    if (t >= last.t) return last
    for (let i = 1; i < s.length; i++) {
      const b = s[i]!
      if (b.t >= t) {
        const a = s[i - 1]!
        const k = (t - a.t) / Math.max(1, b.t - a.t)
        const dh = ((((b.heading - a.heading) % 360) + 540) % 360) - 180
        return {
          lat: a.lat + (b.lat - a.lat) * k,
          lon: a.lon + (b.lon - a.lon) * k,
          alt: a.alt + (b.alt - a.alt) * k,
          heading: (a.heading + dh * k + 360) % 360,
          armed: b.armed,
        }
      }
    }
    return last
  }
}
