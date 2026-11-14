/**
 * RevitSource: the document on screen while linked to Revit. It holds one part per opened Revit sheet. Each part is
 * the one-sheet `.drawing` package the plugin sent for that sheet's latest version.
 *
 * A new version replaces only its own part (a "sheet partial"). `load()` returns the same Sheet object for every
 * part that did not change, and `pages` is one stable renderer that delegates to the current part. So the board
 * re-renders only the replaced sheet, and camera, strokes and the other sheets stay as they were.
 */
import { DEFAULT_PALETTE, type FurnitureSymbol, type TypePalette, type WallStyle } from '@core/context'
import type { Sheet, SheetContext } from '@core/types'
import { openSource, type DrawingSource, type LoadedSource, type PageRenderer, type VectorPage } from '../source'
import type { LinkSheetSummary } from './protocol'

interface Part {
  source: DrawingSource
  loaded: LoadedSource
  version: number
  /** The package's own sheet, re-keyed to the Revit id (its pageIndex is the page in the part's PDF). */
  sheet: Sheet
  /** The sheet id inside the package (normally the same Revit id). */
  innerId: string
  /** The sheet as placed in this document (pageIndex = position); kept while position and part are unchanged. */
  placed?: Sheet
}

/** How long a replaced part's PDF stays open, so a render that already started on it can finish. */
const CLOSE_DELAY_MS = 5000

export class RevitSource implements DrawingSource {
  readonly kind = 'package' as const
  private readonly parts = new Map<string, Part>()
  private order: string[] = []
  private project_?: string
  private palette_: TypePalette = DEFAULT_PALETTE

  constructor(
    readonly name: string,
    /** Server epoch the versions belong to. */
    readonly epoch: string,
  ) {}

  get project(): string | undefined {
    return this.project_
  }
  get palette(): TypePalette {
    return this.palette_
  }

  sheetIds(): string[] {
    return this.order.slice()
  }

  has(sheetId: string): boolean {
    return this.parts.has(sheetId)
  }

  versionOf(sheetId: string): number {
    return this.parts.get(sheetId)?.version ?? 0
  }

  /**
   * Add or replace a sheet from a `sheet` message. Returns false (and changes nothing) when `version` is not newer
   * than the one shown. Throws when the package cannot be read.
   */
  async setSheet(sheetId: string, version: number, pkg: unknown, summary?: LinkSheetSummary): Promise<boolean> {
    const before = this.parts.get(sheetId)
    if (before && version <= before.version) return false
    const label = summary?.number ?? sheetId
    const bytes = new TextEncoder().encode(typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
    const source = await openSource({ name: `${label}.drawing`, bytes })
    let loaded: LoadedSource
    try {
      loaded = await source.load()
    } catch (e) {
      void source.close()
      throw e
    }
    const sheet = loaded.sheets.find((s) => s.id === sheetId) ?? loaded.sheets[0]
    if (!sheet) {
      void source.close()
      throw new Error(`the package for sheet ${label} has no sheet`)
    }
    // a newer version may have landed while this one was parsing
    const now = this.parts.get(sheetId)
    if (now && version <= now.version) {
      void source.close()
      return false
    }
    // Identity is the Revit id the editor asked for: commands carry it back.
    this.parts.set(sheetId, { source, loaded, version, sheet: { ...sheet, id: sheetId }, innerId: sheet.id })
    if (!this.order.includes(sheetId)) this.order.push(sheetId)
    this.project_ ??= source.project
    if (this.order[0] === sheetId) this.palette_ = source.palette
    if (now) setTimeout(() => void now.source.close(), CLOSE_DELAY_MS)
    return true
  }

  /** The plugin restarted (new epoch): its versions count from 1 again, so the next one of each sheet wins. */
  resetVersions(): void {
    for (const p of this.parts.values()) p.version = 0
  }

  removeSheet(sheetId: string): boolean {
    const p = this.parts.get(sheetId)
    if (!p) return false
    this.parts.delete(sheetId)
    this.order = this.order.filter((id) => id !== sheetId)
    for (const part of this.parts.values()) part.placed = undefined
    void p.source.close()
    return true
  }

  /** One renderer for the whole document; page i is part `order[i]`, page `sheet.pageIndex` of its own PDF. */
  readonly pages: PageRenderer = {
    render: async (i, canvas, pxPerPt, signal, gate) => {
      const part = this.parts.get(this.order[i])
      if (!part) throw new Error(`no sheet at page ${i}`)
      if (part.loaded.pages) return part.loaded.pages.render(part.sheet.pageIndex, canvas, pxPerPt, signal, gate)
      // a package without a PDF: blank paper of the right size
      canvas.width = Math.max(1, Math.round(part.sheet.sizePt.w * pxPerPt))
      canvas.height = Math.max(1, Math.round(part.sheet.sizePt.h * pxPerPt))
    },
    renderRegion: async (i, canvas, pxPerPt, region, signal, gate) => {
      const part = this.parts.get(this.order[i])
      if (!part) throw new Error(`no sheet at page ${i}`)
      if (part.loaded.pages) {
        return part.loaded.pages.renderRegion(part.sheet.pageIndex, canvas, pxPerPt, region, signal, gate)
      }
      // a package without a PDF: blank paper covering the region
      canvas.width = Math.max(1, Math.round(region.w * pxPerPt))
      canvas.height = Math.max(1, Math.round(region.h * pxPerPt))
    },
  }

  async load(): Promise<LoadedSource> {
    const sheets = this.order.map((id, i) => {
      const p = this.parts.get(id)!
      if (!p.placed || p.placed.pageIndex !== i) p.placed = { ...p.sheet, pageIndex: i }
      return p.placed
    })
    return { sheets, pdf: null, pages: this.pages }
  }

  async contextFor(sheetId: string): Promise<SheetContext> {
    const p = this.parts.get(sheetId)
    if (!p) throw new Error(`sheet ${sheetId} is not open`)
    const ctx = await p.source.contextFor(p.innerId)
    return { ...ctx, sheetId }
  }

  /** Each part is its own `.drawing`; Revit element ids are shared, so an element is found on every sheet. */
  vectorPage(sheetId: string): VectorPage | null {
    const p = this.parts.get(sheetId)
    return p?.source.vectorPage?.(p.innerId) ?? null
  }

  /** Symbols of every open sheet's package; the first sheet that draws a type wins. */
  furnitureSymbols(): ReadonlyMap<string, FurnitureSymbol> {
    const out = new Map<string, FurnitureSymbol>()
    for (const id of this.order) {
      const syms = this.parts.get(id)?.source.furnitureSymbols?.()
      if (syms) for (const [k, v] of syms) if (!out.has(k)) out.set(k, v)
    }
    return out
  }

  /** Wall styles of every open sheet's package; the first sheet that draws a type wins. */
  wallStyles(): ReadonlyMap<string, WallStyle> {
    const out = new Map<string, WallStyle>()
    for (const id of this.order) {
      const styles = this.parts.get(id)?.source.wallStyles?.()
      if (styles) for (const [k, v] of styles) if (!out.has(k)) out.set(k, v)
    }
    return out
  }

  async close(): Promise<void> {
    const parts = [...this.parts.values()]
    this.parts.clear()
    this.order = []
    await Promise.all(parts.map((p) => p.source.close()))
  }
}
