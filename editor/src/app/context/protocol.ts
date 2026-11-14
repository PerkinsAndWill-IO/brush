import type { SheetContext } from '@core/types'

export type ContextRequest =
  | { id: number; type: 'open'; source: string | Uint8Array }
  | { id: number; type: 'context'; sheetId: string }
  | { id: number; type: 'close' }

export type ContextResponse =
  | { id: number; ok: true; type: 'open'; pages: number }
  | { id: number; ok: true; type: 'context'; context: SheetContext; buildMs: number }
  | { id: number; ok: true; type: 'close' }
  | { id: number; ok: false; error: string }
