/**
 * Brush Link protocol, version 1: the messages between the editor and the Revit add-in (or its DevHost).
 * Spec: revit/docs/protocol.md. Shapes mirror revit/src/Brush.Link.Core/Protocol/Messages.cs.
 */
import type { Command } from '@core/types'

export const LINK_PROTOCOL = 1
export const DEFAULT_LINK_PORT = 47821
export const DEFAULT_LINK_URL = `ws://127.0.0.1:${DEFAULT_LINK_PORT}/link`

export interface LinkDocument {
  title: string
  path?: string
  project?: string
}

export interface LinkSheetSummary {
  /** Revit element id of the sheet (stable across renumbering). */
  id: string
  number?: string
  name: string
}

export interface CommandResult {
  id: string
  status: 'applied' | 'skipped' | 'failed'
  elementIds?: string[]
  notes?: string[]
  message?: string
}

// ─────────────── editor → plugin ───────────────

export type ClientMessage =
  | { type: 'hello'; protocol: number; client?: string; requestId?: string }
  | { type: 'list_sheets'; requestId?: string }
  | { type: 'open_sheet'; sheetId: string; requestId?: string }
  | { type: 'close_sheet'; sheetId: string; requestId?: string }
  | { type: 'apply'; sheetId: string; baseVersion?: number; commands: Command[]; requestId?: string }
  | { type: 'revert'; sheetId: string; commandIds: string[]; requestId?: string }
  | { type: 'ping'; requestId?: string }

// ─────────────── plugin → editor ───────────────

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  server: { name: string; version: string; host: string; epoch: string }
  document: LinkDocument
  sheets: LinkSheetSummary[]
}

export interface SheetsMessage {
  type: 'sheets'
  requestId?: string
  document: LinkDocument
  sheets: LinkSheetSummary[]
}

export type SheetReason = 'open' | 'apply' | 'revert' | 'model_changed'

export interface SheetMessage {
  type: 'sheet'
  requestId?: string
  sheetId: string
  version: number
  reason: SheetReason
  /** A complete one-sheet `.drawing` JSON envelope (manifest + base64 PDF). */
  package: unknown
}

export interface AppliedMessage {
  type: 'applied'
  requestId?: string
  sheetId: string
  baseVersion?: number
  stale: boolean
  results: CommandResult[]
}

export interface RevertedMessage {
  type: 'reverted'
  requestId?: string
  sheetId: string
  results: CommandResult[]
}

export interface ErrorMessage {
  type: 'error'
  requestId?: string
  code: string
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | SheetsMessage
  | SheetMessage
  | AppliedMessage
  | RevertedMessage
  | ErrorMessage
  | { type: 'pong'; requestId?: string }

const SERVER_TYPES = new Set(['welcome', 'sheets', 'sheet', 'applied', 'reverted', 'error', 'pong'])

/** Parse one text frame; null for anything that is not a known server message. */
export function parseServerMessage(text: string): ServerMessage | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const t = (v as { type?: unknown }).type
  return typeof t === 'string' && SERVER_TYPES.has(t) ? (v as ServerMessage) : null
}

/** The health URL next to a link URL (`ws://host:port/link` → `http://host:port/health`). */
export function healthUrlFor(linkUrl: string): string {
  const u = new URL(linkUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = '/health'
  return u.href
}

/** Display label of a sheet: "A102 · Plans". */
export const sheetLabel = (s: Pick<LinkSheetSummary, 'number' | 'name'>) => (s.number ? `${s.number} · ${s.name}` : s.name)
