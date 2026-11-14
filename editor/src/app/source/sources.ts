/**
 * DrawingSource: two sources, one shape (spec "Inputs and document model").
 * The canvas asks a source for sheets (display) and per-sheet context; it never cares which kind it has.
 * pdf.js and the context worker are imported lazily so this module (and its tests) load in Node.
 */
import { DEFAULT_PALETTE, contextFromPackage, paletteFromPackage, sheetsFromPackage, type DrawingManifest, type TypePalette } from '@core/context'
import type { Sheet, SheetContext } from '@core/types'
import type { LoadedPdf, PdfSource as PdfInput } from '../pdf/pdfjs'
import { PackageError, parsePackage, sniffBytes, type PackagePdfRef } from './package-file'

export interface LoadedSource {
  sheets: Sheet[]
  /** pdf.js document for rendering; null when a package has no PDF (sheets draw blank). */
  pdf: LoadedPdf | null
}

export interface DrawingSource {
  readonly kind: 'pdf' | 'package'
  /** Display / sidecar name (file name). */
  readonly name: string
  readonly project?: string
  readonly palette: TypePalette
  /** Load pages for display. Idempotent: a second call returns the same result. */
  load(): Promise<LoadedSource>
  /** Context of one sheet (cached). Package: origin 'package', confidence 1, hostRef set. PDF: inferred. */
  contextFor(sheetId: string): Promise<SheetContext>
  close(): Promise<void>
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
    this.loaded ??= loadPdfLazy(this.input).then((pdf) => ({ sheets: pdf.sheets, pdf }))
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
      if (!input) return { sheets, pdf: null }
      const pdf = await loadPdfLazy(input)
      // The manifest is the truth for sheet identity; pdf.js only validates the pages exist.
      if (pdf.doc.numPages < sheets.length) throw new SourceError(`package lists ${sheets.length} sheets but its PDF has ${pdf.doc.numPages} pages`)
      return { sheets, pdf }
    })()
    return this.loaded
  }

  async contextFor(sheetId: string): Promise<SheetContext> {
    return contextFromPackage(this.manifest, sheetId)
  }

  async close(): Promise<void> {
    const l = await this.loaded?.catch(() => undefined)
    await l?.pdf?.destroy()
    this.loaded = undefined
  }
}

/** Only plain relative paths: no scheme, no absolute path, no `..` segments, no backslashes. */
export function isSafeRelativeHref(href: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.includes('\\')) return false
  return !href.split(/[/?#]/).some((seg) => seg === '..')
}

export type SourceInput = string | File | { name: string; bytes: ArrayBuffer | Uint8Array }

/**
 * Open a file, a dropped/dialog OpenedFile (`{name, bytes}`) or a URL; sniffs PDF vs package by content.
 * A URL ending in `.pdf` is handed to pdf.js as a URL (range requests); anything else is fetched and sniffed.
 */
export async function openSource(input: SourceInput, opts: PackageDrawingSourceOptions = {}): Promise<DrawingSource> {
  let name: string
  let bytes: Uint8Array
  if (typeof input === 'string') {
    name = decodeURIComponent(input.split(/[?#]/)[0].split('/').pop() || 'drawing')
    if (/\.pdf$/i.test(name)) return new PdfDrawingSource(name, input)
    const res = await fetch(input)
    if (!res.ok) throw new SourceError(`could not fetch ${input}: ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
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
