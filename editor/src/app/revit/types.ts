/**
 * S1-07: asking the connected model for the types an element can take (`list_types`). The socket stays in RevitLink;
 * these work on the two calls they need from it, so they are tested without one.
 */
import type { ClientMessage, LinkTypeInfo, ServerMessage } from './protocol'

export interface TypesLink {
  send(m: ClientMessage): string | null
  onMessage(l: (m: ServerMessage) => void): () => void
}

export interface RevitTypes {
  current: LinkTypeInfo | null
  types: LinkTypeInfo[]
}

/** How long the menu waits for Revit's list before it keeps the document's. */
export const LIST_TYPES_TIMEOUT_MS = 5000

/**
 * The element's types from Revit. Null when the link is off, the plugin is older (`unknown_type`), it answers an error,
 * or it does not answer within the timeout: the menu then keeps the document's types.
 */
export function requestTypes(link: TypesLink, elementId: string, opts: { timeoutMs?: number } = {}): Promise<RevitTypes | null> {
  return new Promise((resolve) => {
    let requestId: string | null = null
    let done = false
    const finish = (v: RevitTypes | null) => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      resolve(v)
    }
    const off = link.onMessage((m) => {
      if (!requestId || !('requestId' in m) || m.requestId !== requestId) return
      if (m.type === 'error') return finish(null)
      if (m.type === 'types') finish({ current: m.current, types: m.types })
    })
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? LIST_TYPES_TIMEOUT_MS)
    requestId = link.send({ type: 'list_types', elementId })
    if (!requestId) finish(null)
  })
}

/**
 * requestTypes, but only for an element on a page the connected model has: an element of another model could share
 * an id with an unrelated element of the open one, whose types Revit would refuse for it.
 */
export function requestTypesFor(link: TypesLink, linkedPages: ReadonlySet<string>, pageId: string, elementId: string, opts?: { timeoutMs?: number }): Promise<RevitTypes | null> {
  return linkedPages.has(pageId) ? requestTypes(link, elementId, opts) : Promise.resolve(null)
}
