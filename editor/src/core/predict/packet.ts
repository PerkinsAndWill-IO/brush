import type { AcceptedDecision, Alternative, ContextPacket, Hypothesis, SheetContext, Stroke } from '../types'
import { roomAt } from '../context'
import { gatherEvidence, type Evidence } from './evidence'

export const PACKET_NEAREST = 8
export const PACKET_HISTORY = 3

/**
 * The compact packet the M4 rescorer receives (docs/spec.md "Second pass"):
 * stroke features, nearest 8 context items, room label, scale, last 3 accepted
 * decisions and the candidate list. Pass the evidence from the predictor's last
 * run (`predictor.lastTrace.evidence`) to avoid recomputing features.
 */
export function buildContextPacket(
  input: { stroke: Stroke; ctx: SheetContext; evidence?: Evidence },
  hypothesis: Hypothesis,
  history: readonly AcceptedDecision[] = [],
): ContextPacket {
  const ev = input.evidence ?? gatherEvidence(input.stroke, input.ctx)
  const b = ev.f.bbox
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const nearest = ev.pc.all.nearest(c, PACKET_NEAREST).map((h) => h.item)
  const room = ev.room.label !== undefined ? ev.room : roomAt(input.ctx, c)
  const candidates: Alternative[] = [{ kind: hypothesis.kind, confidence: hypothesis.confidence }, ...hypothesis.alternatives]
  const packet: ContextPacket = {
    features: ev.f,
    nearest,
    history: history.slice(-PACKET_HISTORY),
    candidates,
  }
  if (room.label !== undefined) packet.roomLabel = room.label
  if (input.ctx.scale !== undefined) packet.scale = input.ctx.scale
  return packet
}
