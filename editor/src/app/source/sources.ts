/**
 * DrawingSource: two sources, one shape (spec "Inputs and document model").
 * The canvas asks a source for sheets (display) and per-sheet context; it never cares which kind it has.
 * pdf.js and the context worker are imported lazily so this module (and its tests) load in Node.
 */
import {
  DEFAULT_PALETTE,
  contextFromDrawing,
  contextFromPackage,
  furnitureSymbolsFromDrawing,
  wallStylesFromDrawing,
  paletteFromDrawing,
  paletteFromPackage,
  sheetsFromDrawing,
  sheetsFromPackage,
  vectorPageFromPackage,
  type DrawingManifest,
  type FurnitureSymbol,
  type TypePalette,
  type WallStyle,
} from '@core/context'
import { DrawingFormatError, type DrawingDocument, type DrawingElement, type DrawingPage } from '@core/drawing'
import type { Sheet, SheetContext } from '@core/types'
import type { LoadedPdf, PdfSource as PdfInput } from '../pdf/pdfjs'
import { openDrawingUrl, pageAvailable, pageDecoded, parseDrawingFile } from './drawing-file'
import { PackageError, parsePackage, sniffBytes, type PackagePdfRef } from './package-file'

/** Paints one page of a source into a canvas (pdf.js for PDFs, the vector renderer for `.drawing`). */
export interface PageRenderer {
  /**
   * Render page `pageIndex` (0-based) into `canvas` at `pxPerPt` device pixels per sheet point; sets the backing
   * size only. `gate` returns a promise while rendering must pause (pen down). `offscreen`: a one-off render that is
   * never shown (the photo import's): it resolves with the whole page, never a preview, and leaves the board's own
   * renders of that page alone.
   */
  render(pageIndex: number, canvas: HTMLCanvasElement, pxPerPt: number, signal?: AbortSignal, gate?: () => Promise<void> | null, opts?: { offscreen?: boolean }): Promise<void>
  /**
   * Render only `region` (sheet points) of page `pageIndex` at `pxPerPt`; the canvas covers exactly that region.
   * Used for the sharp detail layer when zoomed in past what a whole-page raster can hold.
   */
  renderRegion(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    pxPerPt: number,
    region: { x: number; y: number; w: number; h: number },
    signal?: AbortSignal,
    gate?: () => Promise<void> | null,
  ): Promise<void>
}

function pdfRenderer(pdf: LoadedPdf): PageRenderer {
  return {
    render: async (i, canvas, pxPerPt, signal, gate, opts) => {
      const m = await import('../pdf/pdfjs')
      return opts?.offscreen ? m.renderPageOffscreen(pdf.doc, i, canvas, pxPerPt, signal) : m.renderPageAt(pdf.doc, i, canvas, pxPerPt, signal, gate)
    },
    renderRegion: async (i, canvas, pxPerPt, region, signal, gate) => {
      const m = await import('../pdf/pdfjs')
      return m.renderPageRegion(pdf.doc, i, canvas, pxPerPt, region, signal, gate)
    },
  }
}

export interface LoadedSource {
  sheets: Sheet[]
  /** pdf.js document; null for a `.drawing` or a manifest package without a PDF. */
  pdf: LoadedPdf | null
  /** Draws the pages; null when there is nothing to draw (manifest package without a PDF: blank sheets). */
  pages: PageRenderer | null
}

export interface DrawingSource {
  /** 'package' for anything that carries host-model context (`.drawing`, manifest packages); 'pdf' otherwise. */
  readonly kind: 'pdf' | 'package'
  /** Display / sidecar name (file name). */
  readonly name: string
  readonly project?: string
  readonly palette: TypePalette
  /** Load pages for display. Idempotent: a second call returns the same result. */
  load(): Promise<LoadedSource>
  /** Context of one sheet (cached). Package: origin 'package', confidence 1, hostRef set. PDF: inferred. */
  contextFor(sheetId: string): Promise<SheetContext>
  /**
   * The vector page and element metadata behind a sheet, for inspecting elements (V3). Only sources whose sheets are
   * host vectors (`.drawing`, Revit) have it; undefined or null otherwise.
   */
  vectorPage?(sheetId: string): VectorPage | null
  /** How each furniture type is drawn on plan (by type name), when the source knows. Built lazily, then cached. */
  furnitureSymbols?(): ReadonlyMap<string, FurnitureSymbol>
  /** How each wall type is drawn on plan (by type name): faces, layer lines and fills across it. Lazy, then cached. */
  wallStyles?(): ReadonlyMap<string, WallStyle>
  close(): Promise<void>
}

/** A sheet's host vectors: the page (sheet points) and the elements its items refer to. */
export interface VectorPage {
  page: DrawingPage
  elements: Record<string, DrawingElement>
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceError'
  }
}

async function loadPdfLazy(src: PdfInput): Promise<LoadedPdf> {
  const m = await import('../pdf/pdfjs')
  return m.loadPdf(src)
}

/** Plain PDF: sheets from pdf.js, context inferred in the worker. */
export class PdfDrawingSource implements DrawingSource {
  readonly kind = 'pdf' as const
  readonly palette = DEFAULT_PALETTE
  private loaded?: Promise<LoadedSource>
  private client?: Promise<import('../context/client').ContextClient>

  constructor(
    readonly name: string,
    private input: PdfInput,
  ) {}

  load(): Promise<LoadedSource> {
    this.loaded ??= loadPdfLazy(this.input).then((pdf) => ({ sheets: pdf.sheets, pdf, pages: pdfRenderer(pdf) }))
    return this.loaded
  }

  contextFor(sheetId: string): Promise<SheetContext> {
    this.client ??= import('../context/client').then(async (m) => {
      const c = m.createContextClient()
      await c.open(this.input)
      return c
    })
    return this.client.then((c) => c.getContext(sheetId))
  }

  async close(): Promise<void> {
    const client = await this.client?.catch(() => undefined)
    client?.close()
    const l = await this.loaded?.catch(() => undefined)
    await l?.pdf?.destroy()
    this.client = undefined
    this.loaded = undefined
  }
}

export interface PackageDrawingSourceOptions {
  /** Resolves a linked (`href`) PDF to something pdf.js can open. Default: the href as given. */
  resolveHref?: (href: string) => PdfInput
}

/** `.drawing` package: sheets and context come from the manifest; the PDF is only for display. */
export class PackageDrawingSource implements DrawingSource {
  readonly kind = 'package' as const
  readonly palette: TypePalette
  readonly project?: string
  private loaded?: Promise<LoadedSource>

  constructor(
    readonly name: string,
    readonly manifest: DrawingManifest,
    private pdfRef: PackagePdfRef | null = null,
    private opts: PackageDrawingSourceOptions = {},
  ) {
    this.palette = paletteFromPackage(manifest)
    this.project = manifest.project
  }

  /** The embedded or linked PDF used for display, if any. */
  get pdfInput(): PdfInput | null {
    const r = this.pdfRef
    if (!r) return null
    if (r.bytes) return r.bytes
    // A package from a File/bytes has no base: never follow its href (it could point anywhere).
    if (r.href && this.opts.resolveHref && isSafeRelativeHref(r.href)) return this.opts.resolveHref(r.href)
    return null
  }

  load(): Promise<LoadedSource> {
    this.loaded ??= (async () => {
      const sheets = sheetsFromPackage(this.manifest)
      const input = this.pdfInput
      if (!input) return { sheets, pdf: null, pages: null }
      const pdf = await loadPdfLazy(input)
      // The manifest is the truth for sheet identity; pdf.js only validates the pages exist.
      if (pdf.doc.numPages < sheets.length) throw new SourceError(`package lists ${sheets.length} sheets but its PDF has ${pdf.doc.numPages} pages`)
      return { sheets, pdf, pages: pdfRenderer(pdf) }
    })()
    return this.loaded
  }

  async contextFor(sheetId: string): Promise<SheetContext> {
    return contextFromPackage(this.manifest, sheetId)
  }

  private vectors?: Map<string, VectorPage>
  /**
   * The manifest's elements as a pickable page (the package has no vector items of its own): what makes the
   * inspector, selection and hover work on a Revit link sheet. Built once for all sheets; the same object every call,
   * as the hit index and overlays are keyed by page. Like a `.drawing`, every sheet shares one element map (of all
   * sheets), so an element is found whichever sheet it is looked up on.
   */
  vectorPage(sheetId: string): VectorPage | null {
    if (!this.vectors) {
      const built = this.manifest.sheets.map((s) => vectorPageFromPackage(s))
      const elements: Record<string, DrawingElement> = {}
      for (const b of built) for (const [id, el] of Object.entries(b.elements)) elements[id] ??= el
      this.vectors = new Map(this.manifest.sheets.map((s, i) => [s.id, { page: built[i].page, elements }]))
    }
    return this.vectors.get(sheetId) ?? null
  }

  async close(): Promise<void> {
    const l = await this.loaded?.catch(() => undefined)
    await l?.pdf?.destroy()
    this.loaded = undefined
  }
}

/**
 * Binary `.drawing` (decision 0008): sheets, vector pages and context all come from the file. Context is built from
 * the host elements (origin 'package', confidence 1, hostRef = element id); the palette lists the model's own types.
 */
export class DrawingFileSource implements DrawingSource {
  readonly kind = 'package' as const
  readonly project?: string
  private renderer?: PageRenderer

  constructor(
    readonly name: string,
    readonly doc: DrawingDocument,
  ) {
    if (doc.source.file) this.project = doc.source.file.replace(/\.[^.]+$/, '')
  }

  /** The document with only the pages that can be read now (all but those still downloading), and whether that is all. */
  private readable(): { doc: DrawingDocument; all: boolean } {
    const pages = this.doc.pages.filter((_, i) => pageAvailable(this.doc, i))
    return pages.length === this.doc.pages.length ? { doc: this.doc, all: true } : { doc: { ...this.doc, pages }, all: false }
  }

  /** Built from what can be read, and kept once every page can. */
  private whole<T>(make: (doc: DrawingDocument) => T, keep: (v: T) => void): T {
    const { doc, all } = this.readable()
    const v = make(doc)
    if (all) keep(v)
    return v
  }

  private palette_?: TypePalette
  /** Measured on every page, so built when first asked: opening a file reads only its first page. */
  get palette(): TypePalette {
    return this.palette_ ?? this.whole(paletteFromDrawing, (v) => (this.palette_ = v))
  }

  async load(): Promise<LoadedSource> {
    await Promise.all(this.doc.pages.map((_, i) => pageDecoded(this.doc, i)))
    return { sheets: sheetsFromDrawing(this.doc), pdf: null, pages: (this.renderer ??= this.pageRenderer()) }
  }

  /**
   * Like `load`, but reads only the first page: later sheets carry just a scale their page states. Lets the first sheet
   * paint before the other pages are decoded; `load` again once their contexts are built has every scale.
   */
  loadFirst(): LoadedSource {
    return { sheets: sheetsFromDrawing(this.doc, 1), pdf: null, pages: (this.renderer ??= this.pageRenderer()) }
  }

  private pageRenderer(): PageRenderer {
    const pages = this.doc.pages
    return {
      render: async (i, canvas, pxPerPt, signal, gate) => {
        const [m, f] = await Promise.all([import('../drawing/render'), import('../drawing/filters'), pageDecoded(this.doc, i)])
        const fs = f.getFilters()
        return m.renderDrawingPage(pages[i], canvas, pxPerPt, signal, gate, { key: fs.version, hide: f.hiddenPredicate(this.doc, fs) })
      },
      renderRegion: async (i, canvas, pxPerPt, region, signal, gate) => {
        const [m, f] = await Promise.all([import('../drawing/render'), import('../drawing/filters'), pageDecoded(this.doc, i)])
        const fs = f.getFilters()
        return m.renderDrawingPage(pages[i], canvas, pxPerPt, signal, gate, { key: fs.version, hide: f.hiddenPredicate(this.doc, fs) }, region)
      },
    }
  }

  async contextFor(sheetId: string): Promise<SheetContext> {
    const i = this.doc.pages.findIndex((p) => p.id === sheetId)
    await pageDecoded(this.doc, i)
    const ctx = contextFromDrawing(this.doc, sheetId)
    // count the page for the filter list now, one page per idle slot, rather than every page at once later
    if (i >= 0) (await import('../drawing/filters')).pageCategories(this.doc, this.doc.pages[i])
    return ctx
  }

  vectorPage(sheetId: string): VectorPage | null {
    const i = this.doc.pages.findIndex((p) => p.id === sheetId)
    // a page still downloading has nothing to pick yet
    return i >= 0 && pageAvailable(this.doc, i) ? { page: this.doc.pages[i], elements: this.doc.elements } : null
  }

  private symbols?: Map<string, FurnitureSymbol>
  furnitureSymbols(): ReadonlyMap<string, FurnitureSymbol> {
    return this.symbols ?? this.whole(furnitureSymbolsFromDrawing, (v) => (this.symbols = v))
  }

  private walls?: Map<string, WallStyle>
  wallStyles(): ReadonlyMap<string, WallStyle> {
    return this.walls ?? this.whole(wallStylesFromDrawing, (v) => (this.walls = v))
  }

  async close(): Promise<void> {}
}

/** Only plain relative paths: no scheme, no absolute path, no `..` segments, no backslashes. */
export function isSafeRelativeHref(href: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.includes('\\')) return false
  return !href.split(/[/?#]/).some((seg) => seg === '..')
}

export type SourceInput = string | File | { name: string; bytes: ArrayBuffer | Uint8Array }

/**
 * Open a file, a dropped/dialog OpenedFile (`{name, bytes}`) or a URL; sniffs PDF vs package by content.
 * A URL ending in `.pdf` is handed to pdf.js as a URL (range requests); a zstd `.drawing` is read by range requests when
 * the server has them (`openDrawingUrl`); anything else is fetched and sniffed. `onBytes` reports the download.
 */
export async function openSource(input: SourceInput, opts: PackageDrawingSourceOptions = {}, onBytes?: (n: number) => void): Promise<DrawingSource> {
  let name: string
  let bytes: Uint8Array
  if (typeof input === 'string') {
    name = decodeURIComponent(input.split(/[?#]/)[0].split('/').pop() || 'drawing')
    if (/\.pdf$/i.test(name)) return new PdfDrawingSource(name, input)
    // a zstd .drawing on a server with range requests opens from its first sheet; anything else comes whole
    let got: Awaited<ReturnType<typeof openDrawingUrl>>
    try {
      got = await openDrawingUrl(input, onBytes)
    } catch (e) {
      if (e instanceof DrawingFormatError) throw new SourceError(`${name}: ${e.message}`)
      throw e
    }
    if ('status' in got) throw new SourceError(`could not fetch ${input}: ${got.status}`)
    if ('doc' in got) return new DrawingFileSource(name, got.doc)
    bytes = got.bytes
    const base = input.slice(0, input.split(/[?#]/)[0].lastIndexOf('/') + 1)
    const baseUrl = new URL(base, globalThis.location?.href ?? 'http://localhost/')
    opts = {
      resolveHref: (h) => {
        const u = new URL(h, baseUrl)
        // Must stay on the package's origin and under its directory.
        if (u.origin !== baseUrl.origin || !u.pathname.startsWith(baseUrl.pathname)) throw new SourceError(`package PDF href escapes the package folder: ${h}`)
        return u.href
      },
      ...opts,
    }
  } else if (typeof File !== 'undefined' && input instanceof File) {
    name = input.name
    bytes = new Uint8Array(await input.arrayBuffer())
  } else {
    const f = input as { name: string; bytes: ArrayBuffer | Uint8Array }
    name = f.name
    bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes)
  }
  switch (sniffBytes(bytes, name)) {
    case 'pdf':
      return new PdfDrawingSource(name, bytes)
    case 'drawing':
      try {
        return new DrawingFileSource(name, await parseDrawingFile(bytes))
      } catch (e) {
        if (e instanceof DrawingFormatError) throw new SourceError(`${name}: ${e.message}`)
        throw e
      }
    case 'package-json':
    case 'package-zip': {
      try {
        const p = await parsePackage(bytes)
        return new PackageDrawingSource(name, p.manifest, p.pdf, opts)
      } catch (e) {
        if (e instanceof PackageError) throw new SourceError(`${name}: ${e.message}`)
        throw e
      }
    }
    default:
      throw new SourceError(`${name}: not a PDF or a drawing package`)
  }
}
