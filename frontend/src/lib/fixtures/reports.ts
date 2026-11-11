import type { MissionReport } from '@/types'
import { ALL_DETECTIONS } from './detections'
import { BLOCK_H_M, BLOCK_W_M, ELAPSED_AT_LOAD_S, MISSION, isoAt } from './mission'

/**
 * One in-flight report and one completed one.
 *
 * Both are kept because the Reports screen has two quite different states to show:
 * a draft whose figures the screen recomputes live, and a closed sheet whose figures
 * are frozen. Without the second, the "final" styling would never be exercised.
 */
export const REPORTS: MissionReport[] = [
  {
    id: 'RPT-KMT-01',
    missionId: MISSION.id,
    missionName: MISSION.name,
    site: MISSION.site,
    status: 'draft',
    generatedAt: isoAt(0),
    generatedBy: MISSION.operator,
    // Deliberately states no coverage or tally figures. The Reports screen
    // recomputes those from live mission state, so a number written here would
    // drift out of step with the sheet it sits on within seconds.
    summary:
      'Interim report, KMIT campus block survey in progress. Detections to date are listed in the register below with their review state at time of generation. The near lanes have been walked; the far lanes are still to fly. Two detections confirmed and one flagged for a second pass. None released, all pending ground verification.',
    areaSurveyedM2: BLOCK_W_M * BLOCK_H_M * 0.62,
    coveragePct: 62,
    flightTimeS: ELAPSED_AT_LOAD_S,
    tallies: { total: 10, confirmed: 2, dismissed: 1, flagged: 1, unreviewed: 6 },
    detectionIds: ALL_DETECTIONS.map((d) => d.id),
  },
  {
    id: 'RPT-KMT-00',
    missionId: 'MSN-KMT-00',
    missionName: 'KMIT-00',
    site: 'KMIT campus, Narayanaguda, Hyderabad',
    status: 'final',
    generatedAt: isoAt(-86_400),
    generatedBy: 'A. RAO',
    summary:
      'Complete survey of the KMIT campus block. 9 detections filed, 3 confirmed hazards handed to the ground team and marked to IMAS convention. No outstanding lanes. Survey only, no land released.',
    areaSurveyedM2: BLOCK_W_M * BLOCK_H_M,
    coveragePct: 100,
    flightTimeS: 124,
    tallies: { total: 9, confirmed: 3, dismissed: 4, flagged: 0, unreviewed: 2 },
    detectionIds: [],
  },
]
