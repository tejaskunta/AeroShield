import type {
  ConfidenceBucket,
  Detection,
  MissionGrid,
  MissionProgress,
  ReviewProgress,
  ReviewState,
  RiskCell,
  TimeBucket,
} from '@/types'
import { MISSION_EPOCH } from './mockData'
import { REVIEW_THRESHOLD, riskOf, riskOfConfidence } from './risk'
import { cellId, parseCellId } from './geo'

/**
 * Analytics derivations.
 *
 * All of it computed from the same detection list the map and queue read, so no
 * screen can disagree with another about a count. Kept as pure functions rather
 * than precomputed fixtures for exactly that reason — when a review decision
 * changes a detection's risk level, every chart follows.
 */

/**
 * Greatest number of buckets the timeline will allocate.
 *
 * A survey flight on this aircraft is minutes long, so four hours of one-minute
 * buckets is already far past anything real. The cap exists because the axis is
 * derived from two clocks that can disagree - the drone's `captured_at` and the
 * duration measured from its track - and a disagreement that is off by a factor
 * would otherwise allocate a million-bar chart and hang the tab. Truncating is the
 * honest failure: the chart shows what fits and the count on screen is still real.
 */
const MAX_BUCKETS = 240

/**
 * The instant the timeline's zero is measured from.
 *
 * This used to be the hard-coded fixture epoch, which was correct only while every
 * detection in the list was a fixture. A real detection carries the drone's own
 * `captured_at` - wall-clock time - so subtracting a 2026 fixture epoch from it
 * produced an offset of hundreds of thousands of minutes, and `timeline` duly
 * allocated that many one-minute buckets before drawing anything. Feeding the real
 * track in was what surfaced it; the chart was not wrong about the data, it was
 * wrong about where zero was.
 *
 * The mission's own duration is the honest anchor, because it is the only quantity
 * here measured on the same clock as `elapsedS`: the aircraft's last frame minus
 * the length of the flight is the moment it took off. With fixture data that lands
 * within seconds of `MISSION_EPOCH`, so the simulated chart is unchanged; with live
 * data it lands on the actual take-off. A detection older than that (one carried
 * in from a previous flight) clamps into the first bucket rather than widening the
 * axis.
 *
 * Falls back to the earliest detection when there is no duration to subtract, and
 * to `MISSION_EPOCH` only when there is nothing to go on at all.
 */
function missionOriginMs(detections: Detection[], elapsedS: number): number {
  const times = detections
    .map((d) => Date.parse(d.capturedAt))
    .filter((t) => Number.isFinite(t))
  if (times.length === 0) return MISSION_EPOCH
  const latest = Math.max(...times)
  if (elapsedS > 0) return latest - elapsedS * 1000
  return Math.min(...times)
}

/**
 * Detections bucketed along the mission timeline.
 *
 * The axis is minutes since mission start, not wall-clock time: an operator reads
 * "detections in the first few minutes" far more naturally than "detections at
 * 14:42Z", and it makes two missions of different dates directly comparable.
 *
 * One-minute buckets, because this survey runs ~6 minutes end to end. Coarser bins
 * would collapse the whole mission into two bars and show nothing.
 */
export function timeline(
  detections: Detection[],
  progress: MissionProgress | null,
  bucketMinutes = 1,
): TimeBucket[] {
  if (detections.length === 0) return []

  const elapsedS = progress?.elapsedS ?? 0
  const origin = missionOriginMs(detections, elapsedS)
  const elapsedMin = Math.max(0, elapsedS / 60)
  const lastMin = Math.max(
    elapsedMin,
    ...detections.map((d) => (Date.parse(d.capturedAt) - origin) / 60_000),
  )
  const bucketCount = Math.min(
    MAX_BUCKETS,
    Math.max(1, Math.ceil(lastMin / bucketMinutes) || 1),
  )

  const buckets: TimeBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    minute: i * bucketMinutes,
    detections: 0,
    confirmed: 0,
    // Coverage is monotonic, so approximate its curve linearly to the current
    // value. Marked as an approximation because neither source logs coverage
    // history - and for a live flight the coverage figures are the simulator's,
    // which is why `LiveMap` labels them rather than presenting them as measured.
    coveragePct: Math.min(
      progress?.coveragePct ?? 0,
      (((i + 1) * bucketMinutes) / Math.max(1, elapsedMin)) * (progress?.coveragePct ?? 0),
    ),
  }))

  for (const d of detections) {
    const min = (Date.parse(d.capturedAt) - origin) / 60_000
    if (!Number.isFinite(min)) continue
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(min / bucketMinutes)))
    const bucket = buckets[idx]
    if (!bucket) continue
    bucket.detections++
    if (d.review.state === 'confirmed') bucket.confirmed++
  }

  return buckets
}

/**
 * Confidence histogram in 0.1 bins.
 *
 * Bars are coloured by the risk band their bin falls in, which is the whole point
 * of the chart: it shows how the queue distributes across the thresholds that
 * govern it. A single-colour histogram would hide that.
 */
export function confidenceHistogram(detections: Detection[]): ConfidenceBucket[] {
  const bins: ConfidenceBucket[] = Array.from({ length: 10 }, (_, i) => ({
    binStart: i / 10,
    count: 0,
    level: riskOfConfidence(i / 10 + 0.05),
  }))
  for (const d of detections) {
    const idx = Math.min(9, Math.max(0, Math.floor(d.confidence * 10)))
    const bin = bins[idx]
    if (bin) bin.count++
  }
  return bins
}

/**
 * How far the human review of this mission has got.
 *
 * This replaces the class-breakdown chart, which had nothing real to plot once the
 * model turned out to have a single class. Review state is the genuinely
 * multi-valued thing the dashboard knows about, and it answers the question an
 * operator actually has at the end of a flight: how much of this have I ruled on,
 * and how much is still sitting there unexamined?
 *
 * Ordered by decision rather than by enum, so the bar reads left to right as
 * "needs a person", then the two ways a person can finish, then the flag that
 * reopens work. Percentages are of the total, and `remaining` is what keeps the
 * number honest: an indispensable companion to a review meter is the count of
 * what has *not* been reviewed.
 */
export function reviewProgress(detections: Detection[]): ReviewProgress {
  const counts: Record<ReviewState, number> = {
    unreviewed: 0,
    confirmed: 0,
    dismissed: 0,
    flagged: 0,
  }
  for (const d of detections) counts[d.review.state]++

  const total = detections.length
  const decided = counts.confirmed + counts.dismissed
  return {
    counts,
    total,
    decided,
    remaining: counts.unreviewed + counts.flagged,
    pctDecided: total > 0 ? Math.round((decided / total) * 100) : 0,
  }
}

/**
 * Risk density per grid cell.
 *
 * Density weights each detection by confidence and caps at 1, so a cell with three
 * high-confidence hits reads hotter than one with a single marginal hit. Cleared
 * detections contribute nothing — a ruled-out hit should not leave a warm spot on
 * the map implying residual danger.
 */
export function riskCells(detections: Detection[], grid: MissionGrid): RiskCell[] {
  const map = new Map<string, { density: number; detections: number }>()

  for (const d of detections) {
    if (riskOf(d) === 'cleared') continue
    const entry = map.get(d.gridCell) ?? { density: 0, detections: 0 }
    entry.density += d.review.state === 'confirmed' ? 1 : d.confidence
    entry.detections++
    map.set(d.gridCell, entry)
  }

  const cells: RiskCell[] = []
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const id = cellId(col, row)
      const entry = map.get(id)
      cells.push({
        cellId: id,
        col,
        row,
        density: entry ? Math.min(1, entry.density / 2) : 0,
        detections: entry?.detections ?? 0,
      })
    }
  }
  return cells
}

/** Headline numbers for the stat tiles. */
export function summaryStats(detections: Detection[], progress: MissionProgress | null) {
  const hazards = detections.filter((d) => riskOf(d) === 'hazard').length
  const unreviewed = detections.filter((d) => d.review.state === 'unreviewed').length
  const belowThreshold = detections.filter((d) => d.confidence < REVIEW_THRESHOLD).length
  const meanConfidence =
    detections.length === 0
      ? 0
      : detections.reduce((s, d) => s + d.confidence, 0) / detections.length

  // Detections per hectare surveyed — the density figure that lets one mission's
  // result be compared against another's regardless of block size.
  const hectares = (progress?.areaSurveyedM2 ?? 0) / 10_000
  const perHectare = hectares > 0 ? detections.length / hectares : 0

  return { hazards, unreviewed, belowThreshold, meanConfidence, perHectare, hectares }
}

/** Cell ids that have a detection but were never marked covered — a data gap. */
export function uncoveredWithDetections(
  detections: Detection[],
  progress: MissionProgress | null,
): string[] {
  if (!progress) return []
  const covered = new Set(progress.coveredCells)
  const gaps = new Set<string>()
  for (const d of detections) {
    if (!covered.has(d.gridCell) && parseCellId(d.gridCell)) gaps.add(d.gridCell)
  }
  return [...gaps].sort()
}
