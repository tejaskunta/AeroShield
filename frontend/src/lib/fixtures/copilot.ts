import type { Citation, CopilotMessage } from '@/types'
import { isoAt } from './mission'

/**
 * A tiny fixed corpus keyed to the suggested questions. This is NOT retrieval and
 * NOT an LLM — it is canned Q&A so the screen's structure (answer + citations
 * rail + grounding) can be designed. The UI says as much.
 *
 * The answers are written to hold up as safety advice even though the mechanism
 * behind them is a string match. If the corpus is ever replaced with real retrieval,
 * the wording should survive the swap.
 */
export interface CorpusEntry {
  match: string[]
  answer: string
  citations: Citation[]
}

export const SUGGESTED_QUERIES = [
  'What standoff distance for a suspected mine?',
  'Can I trust a detection at 0.5 confidence?',
  'How should I mark a confirmed hazard for the ground team?',
  'What does the detector actually detect?',
]

export const COPILOT_CORPUS: CorpusEntry[] = [
  {
    match: ['standoff', 'distance', 'suspected', 'radius'],
    answer:
      'Treat the detection position as the centre of a hazard area, not a point. For a suspected anti-personnel mine, hold the ground team outside a 25 m radius until the area is verified, and approach only along a lane cleared from a known-safe start. AeroShield gives you a position estimate with a few metres of error, so the standoff must absorb that error. Never walk to the pin.',
    citations: [
      { id: 'c1', document: 'IMAS 09.10', clause: '7.2 Marking of hazards', page: 14, excerpt: 'A hazardous area shall be treated as extending beyond the located item to account for positional uncertainty and the possibility of additional items.', relevance: 0.91 },
      { id: 'c2', document: 'IMAS 10.20', clause: '5.4 Safety distances', page: 9, excerpt: 'Minimum safety distances shall be established on the basis of the greatest credible threat and maintained until the area is confirmed clear.', relevance: 0.78 },
    ],
  },
  {
    match: ['trust', '0.5', 'confidence', 'low'],
    answer:
      'No. A 0.5-confidence detection is not a clearance decision either way. AeroShield treats anything below 0.75 as unverified: it is filed and shown, but it does not confirm a hazard, and it certainly does not clear the ground. A low-confidence hit is a reason for a human to look at the frame and the Grad-CAM, not a reason to dismiss it. Confidence is a triage signal, not a verdict.',
    citations: [
      { id: 'c3', document: 'AeroShield Ops Note', clause: '3.1 Confidence bands', page: 3, excerpt: 'Detections below the review threshold are retained for human adjudication and never auto-dismissed; the model reports likelihood, not ground truth.', relevance: 0.86 },
    ],
  },
  {
    match: ['mark', 'confirmed', 'hazard', 'ground team', 'ground'],
    answer:
      'Mark it to the recognised convention so anyone arriving reads it the same way: red marker on the hazard side, white on the cleared side, with the hazard boundary defined generously around the confirmed position. Record the grid reference and the confirmed coordinate in the mission log, and hand the ground team the coordinate plus the standoff, not just a pin on a screen.',
    citations: [
      { id: 'c4', document: 'IMAS 08.40', clause: '6.1 Marking systems', page: 11, excerpt: 'Marking shall use red to indicate the hazardous side and white the safe side, and shall be intelligible to all personnel who may enter the area.', relevance: 0.94 },
      { id: 'c5', document: 'IMAS 09.10', clause: '7.2 Marking of hazards', page: 14, excerpt: 'The marking of a hazardous area shall be recorded and reported through the information management system.', relevance: 0.72 },
    ],
  },
  {
    match: ['detect', 'detector', 'class', 'classes', 'model', 'cased', 'plastic', 'metal'],
    answer:
      'One thing: whether the frame contains at least one landmine, reported as a confidence between 0 and 1. The model has a single class, so it cannot tell you the casing, the metal content, the pattern, or the variant, and it does not estimate depth or blast radius. Those are an EOD assessment from the frame and the ground, not a model output. Treat every detection as an unidentified suspect that needs human adjudication.',
    citations: [
      { id: 'c6', document: 'AeroShield Ops Note', clause: '2.4 Single-class output', page: 2, excerpt: 'The detector emits one class, landmine, with a confidence score. Case type and threat classification are outside the model scope and remain the responsibility of the EOD operator.', relevance: 0.93 },
    ],
  },
]

/** Answer shown when nothing in the corpus matches — grounded: false. */
export const UNGROUNDED_REPLY =
  'I don\'t have a sourced answer for that in the loaded standards set. Rather than guess, which is dangerous in this domain, treat this as unanswered and consult your technical field manual or EOD lead. (This copilot is a foundation running on a small fixed corpus, not live retrieval.)'

export const COPILOT_INTRO: CopilotMessage = {
  id: 'intro',
  role: 'copilot',
  text: 'Safety copilot ready. I answer from the loaded demining standards and cite every source. I support decisions. I do not authorise clearance. Ask a field question, or pick one below.',
  at: isoAt(0),
  grounded: true,
}
