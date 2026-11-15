/**
 * Decodes page frames of a zstd `.drawing` off the main thread, in the order they are posted, and analyses each page
 * (its sheet context and scales) while it is here. Several of these run side by side, each on its own frames.
 *
 * A page goes back in chunks of CHUNK items (its draw items, then its context items), coordinate buffers transferred,
 * and then a last message with the rest: receiving a 40 000-item page in one message would stall the main thread for
 * the whole deserialization. A frame that fails to decode gets only the last message, without a page: the main thread
 * decodes it itself on first read and gets the same error there.
 */
import { analysePage, type PageAnalysis } from '@core/context/drawing'
import { decodeElementsFrame, decodeLazyFrame, type DrawingElement, type DrawingPage, type DrawItem, type LazyFrame } from '@core/drawing'
import type { ContextItem } from '@core/types'

/** First message: the compressed elements table, which the analysis reads. */
export type ElementsToDecode = { elements: Uint8Array }
export type FrameToDecode = { index: number; frame: Uint8Array } & Pick<LazyFrame, 'header' | 'name'>
/** Part of a page: some of its draw items or of its context items, in order. */
export type PageChunk = { index: number; items?: DrawItem[]; ctxItems?: ContextItem[] }
/** The end of a page: the rest of it, and of its analysis, without the items sent in chunks. */
export type PageEnd = { index: number; done: true; page?: Pick<DrawingPage, 'boxes' | 'views'>; analysis?: PageAnalysis }

/** Items per message: each message is deserialized in one go on the main thread, so it must stay short. */
const CHUNK = 2000

let elements: Record<string, DrawingElement> | undefined

self.onmessage = (e: MessageEvent<ElementsToDecode | FrameToDecode>) => {
  if ('elements' in e.data) {
    try {
      elements = decodeElementsFrame(e.data.elements)
    } catch {
      elements = undefined // the main thread reports a broken elements table; pages are analysed there then
    }
    return
  }
  const { index, frame } = e.data
  let page: DrawingPage
  try {
    page = decodeLazyFrame(frame, e.data)
  } catch {
    self.postMessage({ index, done: true } satisfies PageEnd)
    return
  }
  let analysis: PageAnalysis | undefined
  try {
    if (elements) analysis = analysePage(elements, page)
  } catch {
    // analysed (and failing) on the main thread instead
  }
  for (let k = 0; k < page.items.length; k += CHUNK) {
    const items = page.items.slice(k, k + CHUNK)
    // each item has its own coordinate arrays; an image's bytes view the frame, which is copied rather than moved
    const buffers = new Set<ArrayBuffer>()
    for (const it of items) {
      if ('xy' in it) buffers.add(it.xy.buffer as ArrayBuffer)
      if ('rings' in it) for (const r of it.rings) buffers.add(r.buffer as ArrayBuffer)
    }
    self.postMessage({ index, items } satisfies PageChunk, { transfer: [...buffers] })
  }
  const ctxItems = analysis?.ctx.items ?? []
  for (let k = 0; k < ctxItems.length; k += CHUNK) self.postMessage({ index, ctxItems: ctxItems.slice(k, k + CHUNK) } satisfies PageChunk)
  const end: PageEnd = {
    index,
    done: true,
    page: { boxes: page.boxes, views: page.views },
    analysis: analysis && { ...analysis, ctx: { ...analysis.ctx, items: [] } },
  }
  self.postMessage(end)
}
