/**
 * The board: one viewport, one transformed "world" holding every sheet, and
 * all pointer / wheel / keyboard input (decision 0003: hand-written camera).
 *
 * Ink path (M1-06/07): pointer events → points converted to the start
 * sheet's coordinates → appended to the in-progress Stroke → the sheet's wet
 * <path> is rewritten in the next animation frame (latency mark taken there) →
 * on pen-up the Stroke is committed to the session (undoable, autosaved).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Point, Sheet, Stroke, StrokePoint } from '@core/types'
import { appendPoint, createStroke } from '@core/stroke'
import { getCamera, onCameraMoving, setCamera, subscribeCamera } from '../camera'
import { LiveHud } from '../brain/overlays'
import { dismissReading } from '../brain/predictEngine'
import { callEngines } from '../engine'
import { FrameMeter, pushMetric } from '../metrics'
import { recorder } from '../recording'
import { getSession, session, useSession } from '../session'
import { getDocState } from '../store'
import type { PageRenderer } from '../source'
import { eraserTouches, inkRender, pointsBBox, type InkRender } from './ink'
import {
  boardBounds,
  boardToSheet,
  fitCamera,
  panBy,
  screenToBoard,
  sheetAt,
  zoomAt,
  type Camera,
  type Placement,
} from './layout'
import { setPenDown } from './penGate'
import type { Removed } from './history'
import { cachedInk, getSheetLayers, setLiveZoom, SheetView } from './SheetView'
import { ScaleBarHud, snapMeasurePoint } from './viewAidLayers'
import { getView, view } from '../view'
import { elementAt, getInspect, inspect } from '../drawing/inspect'
import { getFilters, hiddenPredicate } from '../drawing/filters'

// ───────────── board handle (top bar zoom menu, test API) ─────────────

let viewportEl: HTMLDivElement | null = null
export const getViewportEl = () => viewportEl

/** Viewport size in CSS px. */
export function viewportSize(): { w: number; h: number } {
  const r = viewportEl?.getBoundingClientRect()
  return { w: r?.width ?? window.innerWidth, h: r?.height ?? window.innerHeight }
}

/** Board rectangle including the name labels above the sheets. */
function contentBounds(placements: readonly Placement[]) {
  const b = boardBounds(placements)
  const label = b.w * 0.02
  return { x: b.x, y: b.y - label, w: b.w, h: b.h + label }
}

export const boardView = {
  fit() {
    const { placements } = getDocState()
    const vp = viewportSize()
    setCamera(fitCamera(contentBounds(placements), vp.w, vp.h, 48, 1), { settleNow: true })
  },
  /** Zoom to z around the viewport center (or `at`, viewport px). */
  zoomTo(z: number, at?: Point, opts: { settleNow?: boolean } = {}) {
    const vp = viewportSize()
    setCamera(zoomAt(getCamera(), at ?? { x: vp.w / 2, y: vp.h / 2 }, z), opts)
  },
  zoomBy(f: number) {
    boardView.zoomTo(getCamera().z * f)
  },
  /** Fit one sheet (by page index) into the viewport. */
  focusSheet(pageIndex: number, maxZ = 4) {
    const pl = getDocState().placements.find((p) => p.pageIndex === pageIndex)
    if (!pl) return
    const vp = viewportSize()
    setCamera(fitCamera(pl, vp.w, vp.h, 64, maxZ), { settleNow: true })
  },
}

// ───────────── helpers ─────────────

const NONE: ReadonlySet<string> = new Set()
let strokeSeq = 0
const newStrokeId = () => `s${Date.now().toString(36)}${(strokeSeq++).toString(36)}`

const bboxCache = new WeakMap<Stroke, ReturnType<typeof pointsBBox>>()
const strokeBBox = (s: Stroke) => {
  let b = bboxCache.get(s)
  if (!b) bboxCache.set(s, (b = pointsBBox(s.points)))
  return b
}

function applyWet(path: SVGPathElement, r: InkRender, color: string) {
  path.setAttribute('d', r.d)
  if (r.mode === 'stroke') {
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', String(r.width))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
  } else {
    path.setAttribute('fill', color)
    path.setAttribute('stroke', 'none')
  }
}

const isTextInput = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox'))

type Gesture =
  | {
      kind: 'draw'
      pointerId: number
      stroke: Stroke
      sheet: Sheet
      placement: Placement
      t0: number
      pending: number[]
      raf: number
      smoothing: number
      last?: InkRender
    }
  | { kind: 'erase'; pointerId: number; last: Point; removed: Removed[]; path: Stroke | null; t0: number; start: Placement | null }
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { kind: 'pinch'; d0: number; m0: Point; cam0: Camera }
  | { kind: 'measure'; pointerId: number; placement: Placement; downX: number; downY: number; dragged: boolean }
  | { kind: 'inspect'; pointerId: number; downX: number; downY: number; lastX: number; lastY: number; dragged: boolean }
  | { kind: 'ignore'; pointerId: number }

interface BoardProps {
  /** Undefined for a package without a PDF: sheets draw blank. */
  pages?: PageRenderer
  loadId: number
  sheets: Sheet[]
  placements: Placement[]
  fileName: string
}

export function Board({ pages, loadId, sheets, placements, fileName }: BoardProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const { strokes, accepted, settings, activeSheetId, tool, hidden } = useSession()

  const bySheet = useMemo(() => {
    const m = new Map<string, Stroke[]>()
    for (const s of sheets) m.set(s.id, [])
    for (const s of strokes) if (!hidden.has(s.id)) m.get(s.sheetId)?.push(s)
    return m
  }, [strokes, sheets, hidden])

  // Per sheet, so a commit only redraws the ink of the sheet it happened on.
  const fadedBySheet = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const a of accepted) {
      if (!m.has(a.sheetId)) m.set(a.sheetId, new Set())
      m.get(a.sheetId)!.add(a.strokeId)
    }
    return m
  }, [accepted])

  const getViewport = useCallback(() => viewportSize(), [])

  // Camera → DOM, once per frame. --z (label size, outlines) only updates when the camera settles.
  useLayoutEffect(() => {
    const world = worldRef.current!
    let raf = 0
    const apply = () => {
      raf = 0
      const c = getCamera()
      world.style.transform = `translate(${c.x * c.z}px, ${c.y * c.z}px) scale(${c.z})`
      setLiveZoom(c.z)
    }
    apply()
    world.style.setProperty('--z', String(getCamera().z))
    const offCam = subscribeCamera(() => {
      if (!raf) raf = requestAnimationFrame(apply)
    })
    const meter = new FrameMeter()
    const offMove = onCameraMoving((moving) => {
      world.classList.toggle('moving', moving)
      if (moving) meter.start()
      else {
        meter.stop()
        world.style.setProperty('--z', String(getCamera().z))
      }
    })
    return () => {
      offCam()
      offMove()
      meter.stop()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // The element card belongs to the document and the Select tool (V3).
  useEffect(() => inspect.clear(), [loadId, tool])

  // Fit all sheets when a document opens.
  useLayoutEffect(() => {
    viewportEl = viewportRef.current
    view.clearMeasurements() // measurements belong to the document on screen
    boardView.fit()
    return () => {
      if (viewportEl === viewportRef.current) viewportEl = null
    }
  }, [loadId])

  // Input.
  useEffect(() => {
    const vp = viewportRef.current!
    let gesture: Gesture | null = null
    const touches = new Map<number, Point>()
    let spaceDown = false
    let rect = vp.getBoundingClientRect()
    const ro = new ResizeObserver(() => (rect = vp.getBoundingClientRect()))
    ro.observe(vp)

    const local = (e: { clientX: number; clientY: number }): Point => ({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    const placementsNow = () => getDocState().placements
    const sheetById = (id: string) => getDocState().sheets.find((s) => s.id === id)!

    // ── brush ──
    const samplePoint = (g: Extract<Gesture, { kind: 'draw' }>, e: PointerEvent): StrokePoint => {
      const sp = boardToSheet(g.placement, screenToBoard(getCamera(), local(e)))
      const pt: StrokePoint = { x: sp.x, y: sp.y, t: Math.max(0, e.timeStamp - g.t0) }
      if (e.pointerType === 'pen') pt.p = e.pressure
      return pt
    }
    const paintWet = (g: Extract<Gesture, { kind: 'draw' }>) => {
      g.raf = 0
      const layers = getSheetLayers(g.sheet.id)
      if (!layers) return
      g.last = inkRender(g.stroke.points, g.stroke.size, g.smoothing)
      applyWet(layers.wet, g.last, g.stroke.color ?? '#D7263D')
      const now = performance.now()
      for (const ts of g.pending) pushMetric('inkLatencyMs', now - ts)
      g.pending.length = 0
      callEngines('onStrokeUpdate', g.stroke, g.sheet)
    }
    const scheduleWet = (g: Extract<Gesture, { kind: 'draw' }>) => {
      if (!g.raf) g.raf = requestAnimationFrame(() => paintWet(g))
    }
    const clearWet = (g: Extract<Gesture, { kind: 'draw' }>) => {
      if (g.raf) cancelAnimationFrame(g.raf)
      g.raf = 0
      getSheetLayers(g.sheet.id)?.wet.removeAttribute('d')
    }

    const startDraw = (e: PointerEvent) => {
      const b = screenToBoard(getCamera(), local(e))
      const pl = sheetAt(placementsNow(), b)
      if (!pl) {
        gesture = { kind: 'ignore', pointerId: e.pointerId } // ink outside any sheet is discarded (M1-07)
        return
      }
      const { settings: st } = getSession()
      const sheet = sheetById(pl.sheetId)
      const stroke = createStroke(newStrokeId(), sheet.id, { tool: 'brush', size: st.size, color: st.color, startedAt: Date.now() })
      const g: Extract<Gesture, { kind: 'draw' }> = {
        kind: 'draw',
        pointerId: e.pointerId,
        stroke,
        sheet,
        placement: pl,
        t0: e.timeStamp,
        pending: [e.timeStamp],
        raf: 0,
        smoothing: st.smoothing,
      }
      appendPoint(stroke, samplePoint(g, e))
      gesture = g
      setPenDown(true)
      session.setActiveSheet(sheet.id)
      callEngines('onStrokeStart', stroke, sheet, { downTs: e.timeStamp })
      scheduleWet(g)
    }

    const endDraw = (g: Extract<Gesture, { kind: 'draw' }>, commit: boolean) => {
      const pending = g.pending.splice(0)
      if (g.raf) cancelAnimationFrame(g.raf)
      g.raf = 0
      if (commit) {
        const r = inkRender(g.stroke.points, g.stroke.size, g.smoothing)
        cachedInk(g.stroke, g.smoothing, r)
        session.addStroke(g.stroke) // React paints the committed path before the next frame
        requestAnimationFrame(() => {
          const now = performance.now()
          for (const ts of pending) pushMetric('inkLatencyMs', now - ts)
        })
        recorder.capture(g.stroke, fileName, g.sheet.pageIndex)
      }
      clearWet(g)
      setPenDown(false)
      callEngines('onStrokeEnd', g.stroke, g.sheet, { committed: commit })
    }

    // ── eraser (M1-08) ──
    const eraseAlong = (g: Extract<Gesture, { kind: 'erase' }>, to: Point, e: PointerEvent) => {
      const cam = getCamera()
      const radius = getSession().eraserSize / 2 / cam.z
      const hit = new Set<string>()
      const pls = new Map(placementsNow().map((p) => [p.sheetId, p]))
      const hiddenNow = getSession().hidden
      for (const s of getSession().strokes) {
        if (s.tool === 'eraser') continue // kept only as the source of a delete element
        if (hiddenNow.has(s.id)) continue // landed in the linked model (M6-04); the sheet draws the element now
        const pl = pls.get(s.sheetId)
        if (!pl) continue
        if (eraserTouches(s, strokeBBox(s), boardToSheet(pl, g.last), boardToSheet(pl, to), radius)) hit.add(s.id)
      }
      if (hit.size) g.removed.push(...session.eraseLive(hit))
      if (g.path && g.start) {
        const sp = boardToSheet(g.start, to)
        appendPoint(g.path, { x: sp.x, y: sp.y, t: Math.max(0, e.timeStamp - g.t0) })
      }
      g.last = to
    }
    const startErase = (e: PointerEvent) => {
      const b = screenToBoard(getCamera(), local(e))
      const start = sheetAt(placementsNow(), b)
      const path = start ? createStroke(newStrokeId(), start.sheetId, { tool: 'eraser', size: getSession().eraserSize / getCamera().z, startedAt: Date.now() }) : null
      const g: Extract<Gesture, { kind: 'erase' }> = { kind: 'erase', pointerId: e.pointerId, last: b, removed: [], path, t0: e.timeStamp, start }
      gesture = g
      eraseAlong(g, b, e)
      // An eraser pass over the drawing itself (not over ink) can be read as a delete (M3 decision vocabulary).
      if (path && start) callEngines('onStrokeStart', path, sheetById(start.sheetId), { downTs: e.timeStamp })
    }

    // ── measure (V1-02): drag from A to B, or click A then click B ──
    const measurePoint = (pl: Placement, e: PointerEvent): Point => snapMeasurePoint(pl.sheetId, boardToSheet(pl, screenToBoard(getCamera(), local(e))))
    const startMeasure = (e: PointerEvent) => {
      const draft = getView().draft
      const pls = placementsNow()
      if (draft) {
        // second click of click-click: finish on the draft's sheet
        const pl = pls.find((p) => p.sheetId === draft.sheetId)
        if (pl) view.moveMeasure(measurePoint(pl, e))
        view.commitMeasure()
        gesture = { kind: 'ignore', pointerId: e.pointerId }
        return
      }
      const pl = sheetAt(pls, screenToBoard(getCamera(), local(e)))
      if (!pl) {
        gesture = { kind: 'ignore', pointerId: e.pointerId }
        return
      }
      view.startMeasure(pl.sheetId, measurePoint(pl, e))
      gesture = { kind: 'measure', pointerId: e.pointerId, placement: pl, downX: e.clientX, downY: e.clientY, dragged: false }
    }
    // hover after the first click of click-click moves the draft's end
    const hoverMeasure = (e: PointerEvent) => {
      const draft = getView().draft
      if (!draft || gesture || getSession().tool !== 'measure') return
      const pl = placementsNow().find((p) => p.sheetId === draft.sheetId)
      if (pl) view.moveMeasure(measurePoint(pl, e))
    }

    // ── inspect (V3): Select tool hovers and clicks host elements of `.drawing` sheets; a drag pans ──
    const PICK_PX = 4
    const elementUnder = (e: { clientX: number; clientY: number }): string | null => {
      const source = getDocState().source
      if (!source?.vectorPage) return null
      const cam = getCamera()
      const b = screenToBoard(cam, local(e))
      const pl = sheetAt(placementsNow(), b)
      if (!pl) return null
      const vp = source.vectorPage(pl.sheetId)
      if (!vp) return null
      const sp = boardToSheet(pl, b)
      return elementAt(vp.page, sp.x, sp.y, PICK_PX / cam.z, hiddenPredicate({ elements: vp.elements }, getFilters()))
    }
    let hoverRaf = 0
    let hoverEv: { clientX: number; clientY: number } | null = null
    const hoverInspect = (e: PointerEvent) => {
      if (getSession().tool !== 'select' || e.pointerType === 'touch') return
      hoverEv = { clientX: e.clientX, clientY: e.clientY }
      if (hoverRaf) return
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0
        const ev = hoverEv
        if (!ev || gesture) return
        const id = elementUnder(ev)
        inspect.hover(id)
      })
    }
    const endInspect = (g: Extract<Gesture, { kind: 'inspect' }>, e: PointerEvent) => {
      if (g.dragged) vp.classList.remove('panning')
      else if (e.type === 'pointerup') {
        const id = elementUnder(e)
        if (id !== null) inspect.pin(id)
        else inspect.unpin()
      }
    }
    const onLeave = () => {
      hoverEv = null
      if (!getInspect().pinned) inspect.hover(null)
    }

    // ── pinch (two touches) ──
    const startPinch = () => {
      const [a, b] = [...touches.values()]
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: getCamera() }
    }
    const updatePinch = (g: Extract<Gesture, { kind: 'pinch' }>) => {
      const [a, b] = [...touches.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const z = g.cam0.z * (d / g.d0)
      const anchored = zoomAt(g.cam0, g.m0, z)
      setCamera(panBy(anchored, m.x - g.m0.x, m.y - g.m0.y))
    }

    const cancelGesture = () => {
      if (gesture?.kind === 'draw') endDraw(gesture, false)
      if (gesture?.kind === 'erase') {
        session.commitErase(gesture.removed)
        if (gesture.path && gesture.start) callEngines('onStrokeEnd', gesture.path, sheetById(gesture.start.sheetId), { committed: false })
      }
      gesture = null
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, local(e))
        if (touches.size === 2) {
          cancelGesture()
          startPinch()
          e.preventDefault()
          return
        }
      }
      if (gesture) return
      const { tool: t } = getSession()
      try {
        vp.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events have no active pointer to capture */
      }
      if (e.button === 1 || spaceDown || t === 'pan') {
        gesture = { kind: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
        vp.classList.add('panning')
      } else if (e.button !== 0) return
      else if (t === 'brush') startDraw(e)
      else if (t === 'eraser') startErase(e)
      else if (t === 'measure') startMeasure(e)
      else if (t === 'select') gesture = { kind: 'inspect', pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, lastX: e.clientX, lastY: e.clientY, dragged: false }
      else gesture = { kind: 'ignore', pointerId: e.pointerId }
      e.preventDefault()
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, local(e))
      const g = gesture
      if (!g) {
        hoverInspect(e)
        return hoverMeasure(e)
      }
      if (g.kind === 'pinch') {
        if (touches.size >= 2) updatePinch(g)
        return
      }
      if (g.pointerId !== e.pointerId) return
      if (g.kind === 'draw') {
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
        for (const ce of evs.length ? evs : [e]) appendPoint(g.stroke, samplePoint(g, ce))
        g.pending.push(e.timeStamp)
        scheduleWet(g)
      } else if (g.kind === 'erase') {
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
        for (const ce of evs.length ? evs : [e]) eraseAlong(g, screenToBoard(getCamera(), local(ce)), ce)
        if (g.path && g.start) callEngines('onStrokeUpdate', g.path, sheetById(g.start.sheetId))
      } else if (g.kind === 'measure') {
        if (Math.hypot(e.clientX - g.downX, e.clientY - g.downY) > 4) g.dragged = true
        view.moveMeasure(measurePoint(g.placement, e))
      } else if (g.kind === 'inspect') {
        if (!g.dragged && Math.hypot(e.clientX - g.downX, e.clientY - g.downY) > 4) {
          g.dragged = true
          vp.classList.add('panning')
        }
        if (g.dragged) {
          setCamera(panBy(getCamera(), e.clientX - g.lastX, e.clientY - g.lastY))
          g.lastX = e.clientX
          g.lastY = e.clientY
        }
      } else if (g.kind === 'pan') {
        setCamera(panBy(getCamera(), e.clientX - g.lastX, e.clientY - g.lastY))
        g.lastX = e.clientX
        g.lastY = e.clientY
      }
    }

    const onUp = (e: PointerEvent) => {
      touches.delete(e.pointerId)
      const g = gesture
      if (!g) return
      if (g.kind === 'pinch') {
        if (touches.size < 2) gesture = null
        return
      }
      if (g.pointerId !== e.pointerId) return
      if (g.kind === 'draw') {
        if (e.type === 'pointerup') {
          const p = samplePoint(g, e)
          const last = g.stroke.points[g.stroke.points.length - 1]
          if (p.x !== last.x || p.y !== last.y) {
            appendPoint(g.stroke, p)
            g.pending.push(e.timeStamp)
          }
        }
        endDraw(g, e.type === 'pointerup')
      } else if (g.kind === 'erase') {
        session.commitErase(g.removed)
        if (g.path && g.start) {
          recorder.capture(g.path, fileName, sheetById(g.start.sheetId).pageIndex)
          // erasing ink is just erasing; only a pass that removed no ink is offered to the brush engine
          callEngines('onStrokeEnd', g.path, sheetById(g.start.sheetId), { committed: g.removed.length === 0 })
        }
      } else if (g.kind === 'measure') {
        // a drag measures at once; a click leaves the draft following the pointer until the second click
        if (e.type !== 'pointerup') view.cancelMeasure()
        else if (g.dragged) {
          view.moveMeasure(measurePoint(g.placement, e))
          view.commitMeasure()
        }
      } else if (g.kind === 'inspect') endInspect(g, e)
      else if (g.kind === 'pan') vp.classList.remove('panning')
      gesture = null
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      let dx = e.deltaX * unit
      let dy = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) {
        // Ctrl-scroll and trackpad pinch (Chromium reports pinch as ctrl+wheel), centered on the pointer (M1-04).
        const k = Math.abs(dy) >= 50 ? 0.002 : 0.01
        const cam = getCamera()
        setCamera(zoomAt(cam, local(e), cam.z * Math.exp(-dy * k)))
      } else {
        if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0]
        setCamera(panBy(getCamera(), -dx, -dy)) // two-finger scroll pans
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.code === 'Space') {
        if (!spaceDown) {
          spaceDown = true
          vp.classList.add('space-pan')
        }
        e.preventDefault()
      } else if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) session.redo()
        else session.undo()
      } else if (e.key === 'Escape') {
        if (getView().draft) view.cancelMeasure()
        else if (!inspect.unpin()) dismissReading()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && getSession().tool === 'measure') {
        e.preventDefault()
        view.removeLastMeasurement()
      } else if (mod && k === 'y') {
        e.preventDefault()
        session.redo()
      } else if (!mod && !e.altKey) {
        if (k === 'v') session.setTool('select')
        else if (k === 'b') session.setTool('brush')
        else if (k === 'e') session.setTool('eraser')
        else if (k === 'h') session.setTool('pan')
        else if (k === 'm') session.setTool('measure')
        else if (k === '0' && e.shiftKey === false) boardView.fit()
        else if (k === '=' || k === '+') boardView.zoomBy(1.25)
        else if (k === '-') boardView.zoomBy(0.8)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown = false
        vp.classList.remove('space-pan')
      }
    }

    vp.addEventListener('pointerdown', onDown)
    vp.addEventListener('pointermove', onMove)
    vp.addEventListener('pointerup', onUp)
    vp.addEventListener('pointercancel', onUp)
    vp.addEventListener('pointerleave', onLeave)
    vp.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      cancelGesture()
      ro.disconnect()
      vp.removeEventListener('pointerdown', onDown)
      vp.removeEventListener('pointermove', onMove)
      vp.removeEventListener('pointerup', onUp)
      vp.removeEventListener('pointercancel', onUp)
      vp.removeEventListener('pointerleave', onLeave)
      vp.removeEventListener('wheel', onWheel)
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // Settings are read live through getSession(); fileName changes with the document.
  }, [fileName])

  return (
    <>
      <div className={`viewport tool-${tool}`} ref={viewportRef} data-testid="board" aria-label="Sheets canvas">
        <div className="world" ref={worldRef}>
          {sheets.map((s, i) => (
            <SheetView
              key={`${loadId}:${s.id}`}
              sheet={s}
              placement={placements[i]}
              pages={pages}
              loadId={loadId}
              strokes={bySheet.get(s.id) ?? []}
              faded={fadedBySheet.get(s.id) ?? NONE}
              smoothing={settings.smoothing}
              active={activeSheetId === s.id}
              viewport={getViewport}
            />
          ))}
        </div>
      </div>
      <ScaleBarHud viewport={getViewport} />
      <LiveHud />
    </>
  )
}
