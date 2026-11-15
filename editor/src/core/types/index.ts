/**
 * core/types — shared contracts. FROZEN.
 *
 * Changing anything here needs a decision record in docs/decisions/ and
 * updates to every consumer in the same change (AGENTS.md rule 5).
 * This module depends on nothing.
 *
 * Coordinates: everything geometric is in SHEET coordinates = PDF points
 * (1/72 in), origin at the TOP-LEFT of the page, y pointing DOWN
 * (i.e. already flipped from PDF user space). Times are milliseconds.
 */

// ───────────────────────────── geometry ─────────────────────────────

export interface Point {
  x: number
  y: number
}

/** A polyline (open) or polygon (closed) in sheet points. */
export interface Path {
  points: Point[]
  closed: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ───────────────────────────── sheets & sources ─────────────────────────────

export interface Sheet {
  id: string
  number?: string // "A-201"
  name: string // "Level 2 Floor Plan"
  sizePt: { w: number; h: number } // PDF points, 1/72 in
  scale?: number // 100 for 1:100, if known
  /** 0-based index of the page in the source document. */
  pageIndex: number
}

export type ContextItemKind = 'wall' | 'opening' | 'grid' | 'label' | 'fixture' | 'unknown'

export interface ContextItem {
  id: string
  kind: ContextItemKind
  geometry: Path // in sheet points
  text?: string // for labels: "OFFICE 201"
  confidence: number // 0..1, always 1 for package origin
  hostRef?: string // element id, package origin only
  props?: Record<string, string>
}

export interface SheetContext {
  sheetId: string
  origin: 'inferred' | 'package'
  items: ContextItem[] // walls, grid lines, labels, fixtures
  /** Sheet scale if known (100 for 1:100). Duplicated from Sheet for convenience. */
  scale?: number
  /** True when the page had no usable vectors/text (scanned). */
  shapeOnly?: boolean
  // spatial queries live in core/geometry, not here
}

/**
 * Raw page content handed to core/context. Produced by the app from pdf.js
 * (operator list + text content), already converted to sheet coordinates.
 * core/context never touches pdf.js itself.
 */
export interface RawPageContent {
  sheetId: string
  sizePt: { w: number; h: number }
  paths: RawPath[]
  texts: RawText[]
  /** True if the page contains a large raster image and ~no vectors. */
  hasRasterOnly?: boolean
}

export interface RawPath {
  points: Point[]
  closed: boolean
  lineWidth: number
  /** Dash pattern in points, empty/undefined for solid. */
  dash?: number[]
  stroked: boolean
  filled: boolean
}

export interface RawText {
  text: string
  /** Baseline-left anchor in sheet points. */
  x: number
  y: number
  width: number
  height: number // font size in points
}

export interface DrawingSource {
  load(file: File | ArrayBuffer): Promise<Sheet[]>
  contextFor(sheetId: string): Promise<SheetContext>
}

// ───────────────────────────── strokes ─────────────────────────────

export interface StrokePoint {
  x: number // sheet pts
  y: number // sheet pts
  t: number // ms, relative to pen-down (first point t = 0)
  p?: number // pressure 0..1
}

export type StrokeTool = 'brush' | 'eraser'

export interface Stroke {
  id: string
  sheetId: string
  points: StrokePoint[]
  tool: StrokeTool
  size: number
  /** Ink color as CSS hex. Optional for backwards compatibility. */
  color?: string
  /** Epoch ms at pen-down, for session-history grouping. */
  startedAt?: number
}

export type PrimitiveKind = 'line' | 'polyline' | 'arc' | 'rectangle' | 'blob' | 'scribble'

export interface PrimitiveFit {
  kind: PrimitiveKind
  /** Fitted geometry in sheet points. */
  path: Path
  /** RMS residual distance from raw points to fitted geometry, in sheet points. */
  residual: number
  /** 0..1, how well this primitive explains the stroke. */
  score: number
}

export interface StrokeFeatures {
  /** Best fit first, then other candidates in descending score. */
  fits: PrimitiveFit[]
  lengthPt: number
  bbox: Rect
  /** Real-world metres; present only when sheet scale is known. */
  lengthM?: number
  bboxM?: { w: number; h: number }
  /** Distance between first and last point / length, 0 = closed. */
  closureRatio: number
  closed: boolean
  cornerCount: number
  selfIntersections: number
  durationMs: number
  meanSpeed: number // pt / ms
  speedProfile: number[] // resampled, ~16 samples
  pressureProfile: number[] // resampled, ~16 samples; empty if no pressure
  /** Direction reversals per unit length — high for scribbles. */
  reversalDensity: number
}

// ───────────────────────────── prediction ─────────────────────────────

export type DecisionKind = 'wall' | 'door' | 'furniture' | 'delete' | 'markup'

export const DECISION_KINDS: readonly DecisionKind[] = ['wall', 'door', 'furniture', 'delete', 'markup'] as const

export interface Alternative {
  kind: DecisionKind
  confidence: number
}

export interface Hypothesis {
  kind: DecisionKind
  geometry: Path // fitted and snapped, sheet points
  confidence: number // 0..1
  alternatives: Alternative[] // ranked, excludes `kind`
  stable: boolean
  /** Coarse class from refinement step 1. */
  coarse?: 'linear' | 'closed' | 'unknown'
  /** Fine type, e.g. wall type or family name, from refinement step 3. */
  type?: string
  /** Ids of context items this hypothesis targets (delete, door host wall). */
  targets?: string[]
  /** Monotonic run counter within the stroke. */
  run?: number
  /** ms since pen-down when this hypothesis was produced. */
  atMs?: number
  /** Human readable evidence lines for the Reading panel. */
  evidence?: string[]
}

export type BrushMode = 'auto' | DecisionKind

export interface BrushSettings {
  mode: BrushMode // 'auto' or a forced reading
  /** Kinds allowed when narrowing; empty/undefined = all. */
  allowedKinds?: DecisionKind[]
  snapping: boolean
  snapRadiusPt: number
  live: boolean
  commitPauseMs: number // default 400
  refreshMs: number // default 50
  switchMargin: number // default 0.15
  switchRuns: number // default 2
  chipLow: number // default 0.35
  chipHigh: number // default 0.6
  size: number
  smoothing: number // 0..1
  color: string
}

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  mode: 'auto',
  snapping: true,
  snapRadiusPt: 8,
  live: true,
  commitPauseMs: 400,
  refreshMs: 50,
  switchMargin: 0.15,
  switchRuns: 2,
  chipLow: 0.35,
  chipHigh: 0.6,
  size: 2,
  smoothing: 0.5,
  color: '#D7263D',
}

export interface AcceptedDecision {
  strokeId: string
  sheetId: string
  kind: DecisionKind
  geometry: Path
  confidence: number
  type?: string
  targets?: string[]
  committedAt: number // epoch ms
}

/** Stateful per-stroke first pass. Must be pure/deterministic given the same call sequence. */
export interface Predictor {
  update(stroke: Stroke, ctx: SheetContext, settings: BrushSettings): Hypothesis
}

export interface ContextPacket {
  features: StrokeFeatures
  nearest: ContextItem[] // nearest context items, max ~8
  roomLabel?: string
  scale?: number
  history: AcceptedDecision[] // last three accepted decisions
  candidates: Alternative[]
}

export interface Rescorer {
  readonly name: string
  rescore(packet: ContextPacket, candidates: Hypothesis[]): Promise<Hypothesis[]>
}

// ───────────────────────────── commands ─────────────────────────────

export type Command =
  | {
      op: 'create_wall'
      id: string
      sheetId: string
      path: Path
      wallType?: string
      strokeId: string
      hostRef?: string
    }
  | {
      op: 'place_door'
      id: string
      sheetId: string
      at: Point
      widthPt: number
      angleRad: number
      hostWallRef?: string // context item id or package hostRef
      familyType?: string
      strokeId: string
    }
  | {
      op: 'place_instance'
      id: string
      sheetId: string
      at: Point
      bbox: Rect
      angleRad: number
      family?: string
      strokeId: string
    }
  | {
      op: 'delete'
      id: string
      sheetId: string
      targets: string[] // context item ids / hostRefs / command ids
      strokeId: string
    }
  | {
      /**
       * Change the type of host elements already on the sheet (decision 0011). Made from the board's type menu,
       * not from a stroke: `strokeId` is `type:<element id>`, one command per element.
       */
      op: 'set_type'
      id: string
      sheetId: string
      targets: string[] // host element ids (`.drawing` element keys / Revit element ids)
      /** The new type name, as the element's `type` reads in the drawing. */
      typeName: string
      /** The new type's family, when the host has families (Revit). */
      family?: string
      strokeId: string
    }

export type CommandOp = Command['op']

// ───────────────────────────── recordings & session ─────────────────────────────

export interface StrokeRecording {
  pdf: string // fixture file name, e.g. "office-6-sheets.pdf"
  sheet: number // 0-based page index
  label: { kind: DecisionKind; note?: string }
  points: StrokePoint[]
  tool?: StrokeTool // default 'brush'
  author?: string
  /** Expected command op for M5, derived from label if absent. */
  expectedOp?: CommandOp | null
  /** Corpus split. Held-out recordings are never used for tuning. */
  split?: 'train' | 'heldout'
}

export const SESSION_SCHEMA_VERSION = 1

export interface SessionFile {
  schemaVersion: number
  pdf: { name: string; size: number; sha256?: string }
  strokes: Stroke[]
  accepted: AcceptedDecision[]
  commands: Command[]
  savedAt: number
}

// ───────────────────────────── test API ─────────────────────────────

export interface Metrics {
  inkLatencyMs: number[]
  firstHypothesisMs: number[]
  fps: number[]
}

export interface BrushTestApi {
  loadPdf(url: string): Promise<void>
  /** Open by URL as the sample picker does; resolves once the first sheet is drawn. */
  loadUrl(url: string): Promise<void>
  sheets(): Sheet[]
  replayStroke(recording: StrokeRecording, opts?: { realtime?: boolean }): Promise<void>
  strokes(): Stroke[]
  hypotheses(): Hypothesis[] // history for the current/last stroke, M3+
  commands(): Command[] // the log, M5
  metrics(): Metrics
  setSetting(key: string, value: unknown): void
  /** Extra introspection used by tests. */
  camera(): { x: number; y: number; z: number }
  contextFor(sheetId: string): Promise<SheetContext | null>
  undo(): void
  redo(): void
  setTool(tool: 'select' | 'brush' | 'eraser' | 'pan'): void
}
