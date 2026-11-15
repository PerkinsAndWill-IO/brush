import { describe, expect, it } from 'vitest'
import type { ClientMessage, ServerMessage } from '../../../src/app/revit/protocol'
import { requestTypes, requestTypesFor } from '../../../src/app/revit/types'
import { revitOptions } from '../../../src/app/select/types'

/** The two calls requestTypes needs from RevitLink, answering like the plugin would. */
function fakeLink(answer: (m: ClientMessage & { requestId: string }) => ServerMessage | null, on = true) {
  const listeners = new Set<(m: ServerMessage) => void>()
  const sent: ClientMessage[] = []
  return {
    sent,
    send(m: ClientMessage) {
      if (!on) return null
      const msg = { ...m, requestId: 'r1' }
      sent.push(msg)
      const a = answer(msg)
      if (a) queueMicrotask(() => listeners.forEach((l) => l(a)))
      return 'r1'
    },
    onMessage(l: (m: ServerMessage) => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

const types = (requestId: string): ServerMessage => ({
  type: 'types', requestId, elementId: '42',
  current: { family: 'Basic Wall', typeName: 'B', typeId: '2' },
  types: [{ family: 'Basic Wall', typeName: 'A', typeId: '1' }, { family: 'Basic Wall', typeName: 'B', typeId: '2' }],
})

describe('S1-07 types from Revit', () => {
  it('S1-07: list_types is answered with the types Revit allows for the element', async () => {
    const link = fakeLink((m) => types(m.requestId))
    const t = await requestTypes(link, '42')
    expect(link.sent[0]).toMatchObject({ type: 'list_types', elementId: '42' })
    expect(t?.types.map((x) => x.typeName)).toEqual(['A', 'B'])
  })

  it('S1-07: unknown_type (older plugin), an error, a timeout or a link that is off give null', async () => {
    expect(await requestTypes(fakeLink((m) => ({ type: 'error', requestId: m.requestId, code: 'unknown_type', message: 'x' })), '42')).toBeNull()
    expect(await requestTypes(fakeLink((m) => ({ type: 'error', requestId: m.requestId, code: 'unknown_element', message: 'x' })), '42')).toBeNull()
    expect(await requestTypes(fakeLink(() => null), '42', { timeoutMs: 10 })).toBeNull()
    expect(await requestTypes(fakeLink(() => null, false), '42')).toBeNull()
  })

  it('S1-07: an element on a page the connected model does not have is never asked about', async () => {
    const link = fakeLink((m) => types(m.requestId))
    expect(await requestTypesFor(link, new Set(['382617']), '960621', '42')).toBeNull()
    expect(link.sent).toEqual([])
    expect(await requestTypesFor(link, new Set(['382617']), '382617', '42')).not.toBeNull()
  })

  it('S1-07: Revit types the document names keep the document option; others get a "Family Type" label', () => {
    const doc = [{ label: 'MUR_Ext 25.0 cm', typeName: 'MUR_Ext 25.0 cm' }, { label: 'Single-Flush 0915 x 2134mm', typeName: '0915 x 2134mm', family: 'Single-Flush' }]
    const out = revitOptions(doc, [
      { family: 'Basic Wall', typeName: 'MUR_Ext 25.0 cm' },
      { family: 'Basic Wall', typeName: 'MUR_Int 15.0 cm' },
      { family: 'Single-Flush', typeName: '0915 x 2134mm' },
    ])
    expect(out).toEqual([
      doc[0],
      { label: 'Basic Wall MUR_Int 15.0 cm', typeName: 'MUR_Int 15.0 cm', family: 'Basic Wall' },
      doc[1],
    ])
  })
})
