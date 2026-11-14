/**
 * core/rescore — the M4 second pass, pure parts (docs/spec.md "Second pass (M4)").
 *
 * App integration (the adapters that do network live in src/app/rescore):
 *   const runner = new RescoreRunner({ rescorer: createRescorer(rs), settings: rs, now: () => performance.now(), onResult })
 *   on pen up (or any run):  runner.consider({ strokeId, run: h.run, packet: buildContextPacket(...), candidates: [h] })  // sync, never awaited
 *   onResult(r):             const a = resolveAnswer(r, { strokeId: live.id, run: live.h.run, committed: decisionOf(r.strokeId) }, rs)
 *                            'apply' -> replace the live hypothesis; 'suggest' -> show a chip on the committed stroke; 'drop' -> nothing
 */
export * from './vocab'
export * from './packet-view'
export * from './codecs'
export * from './fusion'
export * from './policy'
export * from './cassette'
export * from './rescore'
export * from './runner'
export * from './synthetic'
