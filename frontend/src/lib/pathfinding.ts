import type { Detection, LatLng, MissionGrid, PathPlan, Waypoint } from '@/types'
import { M_PER_DEG_LAT, distanceM, formatDistance, mPerDegLon, offsetM } from './geo'
import { riskOf, riskOfScore } from './risk'

/**
 * Deterministic safe-route planner.
 *
 * A* over a fine grid laid across the mission area, where each node's traversal
 * cost rises sharply as it nears a hazard. The route it returns is the cheapest
 * *safe* path, not the shortest path — those are different answers, and conflating
 * them is how someone gets hurt.
 *
 * Determinism is a requirement, not an accident: an operator will re-run this and
 * must get the same corridor. No randomness, and ties broken by a fixed rule.
 */

/** Planner resolution. 5 m nodes over a 320 m block ≈ 64×48 — cheap to solve. */
const NODE_SIZE_M = 5

/**
 * Required clearance from a hazard. Inside this radius a node is impassable.
 * Chosen to absorb the system's own position error, which runs a few metres —
 * routing to within touching distance of an estimated position would be false
 * precision.
 */
export const HARD_CLEARANCE_M = 20

/** Beyond this distance a hazard no longer influences cost at all. */
const INFLUENCE_M = 55

interface Node {
  col: number
  row: number
}

interface HazardPoint {
  position: LatLng
  /** 0..1 weight — confirmed hazards dominate unverified ones. */
  weight: number
}

/**
 * Extract the hazard field the planner must avoid.
 *
 * `cleared` detections are excluded: a dismissed detection or ruled-out debris is
 * not an obstacle. Everything else contributes, weighted by confidence, with
 * confirmed hazards pinned to full weight regardless of the model's number —
 * a human confirmation outranks a model score.
 */
export function hazardField(detections: Detection[]): HazardPoint[] {
  const field: HazardPoint[] = []
  for (const d of detections) {
    const level = riskOf(d)
    if (level === 'cleared') continue
    field.push({
      position: d.position,
      weight: d.review.state === 'confirmed' ? 1 : Math.max(0.35, d.confidence),
    })
  }
  return field
}

/** Distance to the nearest hazard, and the risk that implies at a point. */
function hazardAt(p: LatLng, field: HazardPoint[]): { nearestM: number; risk: number } {
  let nearestM = Infinity
  let risk = 0
  for (const h of field) {
    const d = distanceM(p, h.position)
    if (d < nearestM) nearestM = d
    if (d < INFLUENCE_M) {
      // Linear falloff from the hard clearance ring out to the influence radius.
      const proximity = 1 - Math.max(0, d - HARD_CLEARANCE_M) / (INFLUENCE_M - HARD_CLEARANCE_M)
      risk = Math.max(risk, h.weight * Math.min(1, Math.max(0, proximity)))
    }
  }
  return { nearestM, risk }
}

/**
 * Plan a safe route from `from` to `to`, avoiding the hazard field.
 *
 * Returns `feasible: false` with a note when no corridor exists at the required
 * clearance, rather than quietly returning a route that clips a hazard. Refusing
 * to answer is the correct behaviour here.
 */
export function planSafePath(
  grid: MissionGrid,
  from: LatLng,
  to: LatLng,
  detections: Detection[],
): PathPlan {
  const field = hazardField(detections)
  const cols = Math.ceil((grid.cols * grid.cellSizeM) / NODE_SIZE_M)
  const rows = Math.ceil((grid.rows * grid.cellSizeM) / NODE_SIZE_M)

  const toNode = (p: LatLng): Node => {
    const north = (p.lat - grid.origin.lat) * M_PER_DEG_LAT
    const east = (p.lon - grid.origin.lon) * mPerDegLon(grid.origin.lat)
    return {
      col: clamp(Math.round(east / NODE_SIZE_M), 0, cols - 1),
      row: clamp(Math.round(north / NODE_SIZE_M), 0, rows - 1),
    }
  }
  const toLatLng = (n: Node): LatLng =>
    offsetM(grid.origin, n.col * NODE_SIZE_M, n.row * NODE_SIZE_M)

  const start = toNode(from)
  const goal = toNode(to)
  const key = (n: Node) => n.row * cols + n.col

  // Precompute per-node risk and passability once — the planner reads it many times.
  const risk = new Float32Array(cols * rows)
  const nearest = new Float32Array(cols * rows)
  const blocked = new Uint8Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      const h = hazardAt(toLatLng({ col, row }), field)
      risk[i] = h.risk
      nearest[i] = h.nearestM
      blocked[i] = h.nearestM < HARD_CLEARANCE_M ? 1 : 0
    }
  }
  // Endpoints are where the operator stands; never refuse on their account.
  blocked[key(start)] = 0
  blocked[key(goal)] = 0

  const cameFrom = new Int32Array(cols * rows).fill(-1)
  const gScore = new Float32Array(cols * rows).fill(Infinity)
  const fScore = new Float32Array(cols * rows).fill(Infinity)
  const open = new Set<number>([key(start)])

  const heuristic = (n: Node) =>
    Math.hypot(n.col - goal.col, n.row - goal.row) * NODE_SIZE_M

  gScore[key(start)] = 0
  fScore[key(start)] = heuristic(start)

  let reached = false
  while (open.size) {
    // Lowest f, ties broken by lowest index — deterministic, no heap needed at
    // this grid size.
    let current = -1
    let best = Infinity
    for (const i of open) {
      const f = fScore[i]!
      if (f < best) {
        best = f
        current = i
      }
    }
    if (current === goal.row * cols + goal.col) {
      reached = true
      break
    }
    open.delete(current)

    const cCol = current % cols
    const cRow = Math.floor(current / cols)
    for (const [dc, dr] of NEIGHBOURS) {
      const nCol = cCol + dc
      const nRow = cRow + dr
      if (nCol < 0 || nRow < 0 || nCol >= cols || nRow >= rows) continue
      const ni = nRow * cols + nCol
      if (blocked[ni]) continue

      const stepM = Math.hypot(dc, dr) * NODE_SIZE_M
      // Risk multiplies effective distance: a route through 0.5 risk "costs" as
      // much as a detour six times longer, which is what buys wide berths.
      const cost = stepM * (1 + risk[ni]! * 12)
      const tentative = gScore[current]! + cost
      if (tentative < gScore[ni]!) {
        cameFrom[ni] = current
        gScore[ni] = tentative
        fScore[ni] = tentative + heuristic({ col: nCol, row: nRow })
        open.add(ni)
      }
    }
  }

  const computedAt = new Date().toISOString()

  if (!reached) {
    return {
      from,
      to,
      waypoints: [],
      distanceM: 0,
      routeRisk: 1,
      riskLevel: 'hazard',
      minClearanceM: 0,
      computedAt,
      feasible: false,
      note: `No corridor with ${HARD_CLEARANCE_M} m clearance exists between these points. Reduce the required clearance only with EOD approval, or pick a different approach.`,
    }
  }

  // Walk the parent chain back to the start.
  const nodePath: Node[] = []
  for (let i = goal.row * cols + goal.col; i !== -1; i = cameFrom[i]!) {
    nodePath.push({ col: i % cols, row: Math.floor(i / cols) })
    if (i === key(start)) break
  }
  nodePath.reverse()

  const simplified = simplify(nodePath)
  const waypoints: Waypoint[] = simplified.map((n, i) => {
    const position = toLatLng(n)
    const idx = n.row * cols + n.col
    return {
      position,
      label: i === 0 ? 'START' : i === simplified.length - 1 ? 'GOAL' : `WP${i}`,
      clearanceM: Number(Math.min(999, nearest[idx] ?? 999).toFixed(1)),
    }
  })

  let total = 0
  for (let i = 1; i < waypoints.length; i++) {
    total += distanceM(waypoints[i - 1]!.position, waypoints[i]!.position)
  }

  // Route risk is the mean over the traversed nodes, not the max — the mean
  // describes the route overall, while the tightest pinch is reported separately
  // as minClearance.
  const meanRisk =
    nodePath.reduce((sum, n) => sum + (risk[n.row * cols + n.col] ?? 0), 0) /
    Math.max(1, nodePath.length)

  /**
   * Tightest clearance over EVERY traversed node, not just the waypoints.
   *
   * Waypoints are only the turn points, so a pinch in the middle of a straight
   * segment would be invisible to a min over waypoints — and this is the number the
   * planner panel presents as deciding whether the route is walkable. It has to
   * describe the whole corridor.
   */
  const minClearance = nodePath.reduce((lowest, n) => {
    const here = Math.min(999, nearest[n.row * cols + n.col] ?? 999)
    return Math.min(lowest, here)
  }, 999)

  return {
    from,
    to,
    waypoints,
    distanceM: total,
    routeRisk: Number(meanRisk.toFixed(3)),
    riskLevel: riskOfScore(meanRisk),
    minClearanceM: Number(minClearance.toFixed(1)),
    computedAt,
    feasible: true,
    note:
      minClearance < HARD_CLEARANCE_M * 1.5
        ? `Tightest clearance is ${formatDistance(minClearance)} — brief the team on the pinch point before moving.`
        : undefined,
  }
}

/** 8-connected, in a fixed order so the search is reproducible. */
const NEIGHBOURS: Array<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
]

/**
 * Collapse collinear runs into waypoints. A route the operator can read as
 * "go here, turn, go there" — not 60 breadcrumbs.
 */
function simplify(path: Node[]): Node[] {
  if (path.length <= 2) return path
  const out: Node[] = [path[0]!]
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1]!
    const cur = path[i]!
    const next = path[i + 1]!
    const turned =
      Math.sign(cur.col - prev.col) !== Math.sign(next.col - cur.col) ||
      Math.sign(cur.row - prev.row) !== Math.sign(next.row - cur.row)
    if (turned) out.push(cur)
  }
  out.push(path[path.length - 1]!)
  return out
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
