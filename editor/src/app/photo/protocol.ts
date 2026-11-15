import type { MarkupOptions, MarkupResult, Probe } from './pipeline'

/** A canvas raster (`ImageData`): RGBA, transferred. */
export interface RasterMessage {
  rgba: ArrayBuffer
  w: number
  h: number
}

export type PhotoRequest =
  /** Decode the photo (EXIF orientation applied) and keep it for the calls that follow. */
  | { id: number; type: 'decode'; blob: Blob }
  /**
   * Is the photo of this sheet? `ref` is a low-resolution render at `refDpi`. With `firstOnly`, only the first step
   * of the match (SheetProbe.first): the worker keeps the rest under `key` for a 'probe-rest'.
   */
  | { id: number; type: 'probe'; ref: RasterMessage; refDpi: number; key?: number; firstOnly?: boolean }
  /** Finish a match started with `firstOnly`. */
  | { id: number; type: 'probe-rest'; key: number }
  /** Trace the markup against `ref`, the sheet rendered at `dpi`. */
  | { id: number; type: 'run'; ref: RasterMessage; dpi: number; options: Omit<MarkupOptions, 'log'> }

export type PhotoResponse =
  | { id: number; ok: true; type: 'decode'; w: number; h: number }
  /** `final`: the match is complete (always, unless `firstOnly` and the first step was not conclusive). */
  | { id: number; ok: true; type: 'probe'; probe: Probe | null; final: boolean }
  | { id: number; ok: true; type: 'probe-rest'; probe: Probe | null }
  | { id: number; ok: true; type: 'run'; result: MarkupResult }
  | { id: number; ok: false; error: string }
  /** Progress line while a request runs. */
  | { id: number; type: 'log'; line: string }
