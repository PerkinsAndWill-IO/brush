/**
 * Decodes the later pages of a zstd `.drawing` off the main thread, in order, and posts each one back with its
 * coordinate buffers transferred (no copy). A page that fails to decode is posted without its content: the main thread
 * decodes it itself on first read and gets the same error there.
 */
import { parseDrawingPayload, type DrawingPage } from '@core/drawing'

export type DecodedPage = { index: number; page?: Pick<DrawingPage, 'items' | 'boxes' | 'views'> }

self.onmessage = (e: MessageEvent<Uint8Array>) => {
  const doc = parseDrawingPayload(e.data, { lazy: true })
  for (let index = 1; index < doc.pages.length; index++) {
    let page: NonNullable<DecodedPage['page']>
    try {
      const p = doc.pages[index]
      page = { items: p.items, boxes: p.boxes, views: p.views }
    } catch {
      self.postMessage({ index } satisfies DecodedPage)
      continue
    }
    const buffers = new Set<ArrayBufferLike>()
    for (const it of page.items) {
      if ('xy' in it) buffers.add(it.xy.buffer)
      if ('rings' in it) for (const r of it.rings) buffers.add(r.buffer)
      if ('png' in it) buffers.add(it.png.buffer)
    }
    self.postMessage({ index, page } satisfies DecodedPage, { transfer: [...buffers] as ArrayBuffer[] })
  }
  self.close()
}
