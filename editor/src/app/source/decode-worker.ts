/**
 * Decodes page frames of a zstd `.drawing` off the main thread, in the order they are posted, and analyses each page
 * (its sheet context and scales) while it is here. Posts each page back with its coordinate buffers transferred (no
 * copy). A frame that fails to decode is posted back without a page: the main thread decodes it itself on first read
 * and gets the same error there. Several of these run side by side, each on its own frames.
 */
import { analysePage, type PageAnalysis } from '@core/context/drawing'
import { decodeElementsFrame, decodeLazyFrame, type DrawingElement, type DrawingPage, type LazyFrame } from '@core/drawing'

/** First message: the compressed elements table, which the analysis reads. */
export type ElementsToDecode = { elements: Uint8Array }
export type FrameToDecode = { index: number; frame: Uint8Array } & Pick<LazyFrame, 'header' | 'name'>
export type DecodedPage = { index: number; page?: Pick<DrawingPage, 'items' | 'boxes' | 'views'>; analysis?: PageAnalysis }

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
    self.postMessage({ index } satisfies DecodedPage)
    return
  }
  let analysis: PageAnalysis | undefined
  try {
    if (elements) analysis = analysePage(elements, page)
  } catch {
    // analysed (and failing) on the main thread instead
  }
  const buffers = new Set<ArrayBufferLike>()
  for (const it of page.items) {
    if ('xy' in it) buffers.add(it.xy.buffer)
    if ('rings' in it) for (const r of it.rings) buffers.add(r.buffer)
    if ('png' in it) buffers.add(it.png.buffer)
  }
  const reply: DecodedPage = { index, page: { items: page.items, boxes: page.boxes, views: page.views }, analysis }
  self.postMessage(reply, { transfer: [...buffers] as ArrayBuffer[] })
}
