import type { ContextPacket, Hypothesis } from '../types'
import type { RescoreCodec } from './codecs'
import { firstPassProbs, fuse, rescoreEvidence, toHypotheses } from './fusion'

/**
 * The shared tail of every adapter: parse the reply, fuse with the first-pass
 * candidates in the packet, return re-ranked hypotheses (best first).
 * Throws RescoreParseError on an unreadable reply.
 */
export function finishRescore(codec: RescoreCodec, raw: unknown, packet: ContextPacket, candidates: readonly Hypothesis[], weight: number): Hypothesis[] {
  const model = codec.parseResponse(raw)
  const fused = fuse(firstPassProbs(packet.candidates), model, weight)
  return toHypotheses(fused, candidates, rescoreEvidence(codec.adapter, model, weight))
}
