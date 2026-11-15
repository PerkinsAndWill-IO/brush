/**
 * core/predict — the streaming first pass (docs/spec.md "The contextual brush", M3).
 *
 * App integration (one StrokeSession per stroke):
 *   pen down:      session = new StrokeSession(stroke, ctx, settings, { history: lastAccepted })
 *   pointer move:  const h = session.addPoint(pt)   // Hypothesis | null (throttled to settings.refreshMs of stroke time)
 *   pen up:        session.end()
 *   timer (~50ms): const d = session.tick(nowT)     // AcceptedDecision after commitPauseMs without new points
 *   chips:         chipsFor(h, settings)            // top two when chipLow <= confidence < chipHigh
 *   M4 packet:     buildContextPacket({ stroke, ctx, evidence: session.predictor.lastTrace?.evidence }, h, history)
 */
export { StreamingPredictor, createPredictor, chipsFor, PREDICTOR_NAME } from './predictor'
export type { PredictorOptions, RunTrace } from './predictor'
export { StrokeSession, shouldCommit } from './session'
export { buildContextPacket, PACKET_NEAREST, PACKET_HISTORY } from './packet'
export { groupStrokes, mergeGesture, readGesture, readGestures } from './gesture'
export { stabilityStep, initialStability } from './stability'
export type { StabilityState, StabilityStep } from './stability'
export { coarseOf, scoreKinds, kindsFor, KINDS_FOR_COARSE, KINDS_FOR_COARSE_ELEVATION, KINDS_FOR_COARSE_DETAIL, RULES } from './score'
export type { Coarse, RuleResult } from './score'
export { gatherEvidence, ASSUMED_SCALE } from './evidence'
export type { Evidence, Crossing } from './evidence'
export { prepareContext, viewModeOf } from './context-cache'
export type { ViewMode } from './context-cache'
export { defaultSequencePrior, noSequencePrior } from './history'
export type { SequencePrior } from './history'
