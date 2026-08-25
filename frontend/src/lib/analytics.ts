import type {
  ClassTally,
  ConfidenceBucket,
  Detection,
  MissionGrid,
  MissionProgress,
  RiskCell,
  TimeBucket,
} from '@/types'
import { CLASS_LABELS, DETECTION_CLASSES } from '@/types'
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

  const elapsedMin = (progress?.elapsedS ?? 0) / 60
  const lastMin = Math.max(
    elapsedMin,
    ...detections.map((d) => (Date.parse(d.capturedAt) - MISSION_EPOCH) / 60_000),
  )
  const bucketCount = Math.max(1, Math.ceil(lastMin / bucketMinutes))

  const buckets: TimeBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    minute: i * bucketMinutes,
    detections: 0,
    confirmed: 0,
    // Coverage is monotonic, so approximate its curve linearly to the current
    // value. Marked as an approximation because the simulator does not log history.
    coveragePct: Math.min(
      progress?.coveragePct ?? 0,
      (((i + 1) * bucketMinutes) / Math.max(1, elapsedMin)) * (progress?.coveragePct ?? 0),
    ),
  }))

  for (const d of detections) {
    const min = (Date.parse(d.capturedAt) - MISSION_EPOCH) / 60_000
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

export function classTallies(detections: Detection[]): ClassTally[] {
  return DETECTION_CLASSES.map((c) => ({
    class: c,
    label: CLASS_LABELS[c],
    count: detections.filter((d) => d.class === c).length,
  }))
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
