/**
 * window.__brushDemo — rehearse the hackathon demo (DEMO.md) in the real app, so someone can watch it run.
 *
 * Dev builds only (installed next to window.__brush). Every step drives the app the way a person would: the Revit
 * link connects, sheets are picked in the picker, strokes are drawn with real pointer events at hand speed (with a
 * visible pen), and the inspector is hovered. A caption bar says which beat of the run of show is playing.
 *
 * It draws into the Revit model that is open: `reset()` undoes every stroke it drew, which reverts them in Revit.
 *
 *   await __brushDemo.run()              // the whole run of show, ~5 min with pauses
 *   await __brushDemo.run({ fast: true }) // the same without the talking pauses
 *   await __brushDemo.beat('loop')        // one beat
 *   await __brushDemo.reset()             // undo what it drew (walls etc. leave Revit too)
 */
import type { BrushMode, Point, Stroke } from '@core/types'
import { boardView, getViewportEl } from '../board/Board'
import { sheetToScreen } from '../board/layout'
import { getCamera, setCamera } from '../camera'
import { getSession, session } from '../session'
import { contextFor } from '../brain/contextStore'
import { inspect } from '../drawing/inspect'
import { getDocState, openDocument } from '../store'
import { importPhotoMarkup, setPhotoReplay } from '../photo/import'
import { tracePaper } from '../photo/trace'
import { revit, revitSnapshot } from '../revit/controller'
import { roundTrips, tripStats } from '../revit/roundtrip'

/** A point as fractions of the sheet (0..1 across, 0..1 down), so a script fits any sheet size. */
export type Frac = [number, number]

export interface DemoSpots {
  /** Sheet number to sketch on. */
  sheet: string
  /** The new wall: a polyline. */
  wall: Frac[]
  /** The door: a short stroke along the new wall (the opening). */
  door: [Frac, Frac]
  /** The table: a rectangle, as two opposite corners. */
  table: [Frac, Frac]
  /** The type the table is changed to from the type menu (a type name, or the start of one). */
  retypeTo: string
  /** A point on an existing wall, for the inspector. */
  inspect: Frac
  /** More sheets opened with the main one, so one element can be shown on all of them. */
  alsoOpen: string[]
  /** A Revit element drawn on the main sheet and on every `alsoOpen` sheet: selected, it lights up on all of them. */
  everywhere: { element: string; label: string }
  /** What the camera shows while sketching: the centre and how much of the sheet's width fills the view. */
  view: { center: Frac; width: number }
  /**
   * Where the demo draws, as two corners. Empty in the model as it ships, so a wall, door or piece of furniture found
   * in it was left by an earlier run, and the stage is not clean.
   */
  stage: [Frac, Frac]
}

/**
 * Where the run of show draws, on Snowdon Towers' A102 (Second Floor Plan): of the floor plans it draws the most
 * furniture (tables, banquettes, chairs), so a placed table shows up. A103's view hides most furniture families.
 * Rehearse and adjust: an empty stretch of floor with room for a wall, a door on it, and a table beside it.
 */
export const SNOWDON_SPOTS: DemoSpots = {
  sheet: 'A102',
  // the empty top half of Live/Work Unit 205, below the north wall
  view: { center: [0.522, 0.353], width: 0.14 },
  // inside Live/Work Unit 205, clear of its own walls: nothing of Snowdon's own is in here
  stage: [
    [0.492, 0.324],
    [0.556, 0.384],
  ],
  wall: [
    [0.5039, 0.32],
    [0.5039, 0.3874],
  ],
  // about 1 m of opening
  door: [
    [0.5039, 0.338],
    [0.5039, 0.352],
  ],
  // 49 x 27 pt at 1:96: a 66" x 36" table (the family is picked by the drawn size)
  table: [
    [0.525, 0.36],
    [0.5414, 0.3725],
  ],
  // a family A102's view draws (five of them on the sheet already)
  retypeTo: 'Table-Dining Round w Chairs: 60" Diameter',
  // the wall just sketched, between its top and the door: "that is a real Revit wall now"
  inspect: [0.5039, 0.329],
  // floors 3 to 5: the north facade's long exterior wall is drawn on A102, A103, A104 and A105
  alsoOpen: ['A103', 'A104', 'A105'],
  everywhere: { element: '1919205', label: 'the north facade wall' },
}

/**
 * The "no Revit license" beat: a model dropped in as a `.rvt` file, converted to a `.drawing` by the conversion server
 * (no Revit involved), and sketched on. Revit's own basic sample house; a copy is served from fixtures/demo/ in dev
 * (kept out of git), so a rehearsal can drop it without a person dragging it from the Samples folder.
 */
export interface NoLicenseSpots {
  /** URL the rehearsal fetches the file from, and the name it is dropped under. */
  file: { url: string; name: string }
  sheet: string
  view: { center: Frac; width: number }
  /** A partition between the dining table and the kitchen island. */
  wall: Frac[]
  /** The stool missing from the row along the island: its centre, and its radius as a fraction of the sheet width. */
  stool: { center: Frac; r: number }
}

export const RAC_BASIC_SPOTS: NoLicenseSpots = {
  file: { url: '/fixtures/demo/racbasicsampleproject.rvt', name: 'racbasicsampleproject.rvt' },
  // A102 Plans, room 101 Kitchen & Dining
  sheet: 'A102',
  view: { center: [0.232, 0.226], width: 0.17 },
  wall: [
    [0.2072, 0.1891],
    [0.2072, 0.245],
  ],
  // the bar chairs along the island sit 0.008 apart, with one missing between 0.2435 and 0.2595
  // ~300 mm across at 1:100: a Bar Chair (290 mm) by its size
  stool: { center: [0.2515, 0.2355], r: 0.0018 },
}

/**
 * The "colleague's sketch" beat: a photo of marker on a print of the Medium sample's N01 plan, dropped on Brush and
 * traced onto the sheet, then made into elements. The photo is copied into fixtures/demo/ (kept out of git).
 */
export interface SketchPhotoSpots {
  sample: { url: string; name: string }
  photo: { url: string; name: string }
  sheet: string
  /** Where the colleague drew, as two corners: the rest the trace picks up (dark print in the photo) is left out. */
  keep: [Frac, Frac]
  view: { center: Frac; width: number }
}

export const KRO_SKETCH_SPOTS: SketchPhotoSpots = {
  sample: { url: '/samples/kro/kro-sample.drawing', name: 'kro-sample.drawing' },
  photo: { url: '/fixtures/demo/colleague-sketch.jpg', name: 'colleague-sketch.jpg' },
  // 0001 KRO-APD-ARC-PLN-A1A-N01-0001, N01 ACCÈS LOGEMENTS 1:100
  sheet: '0001',
  keep: [
    [0.19, 0.43],
    [0.315, 0.665],
  ],
  // the whole sketch, both rows of rooms, with a little of the plan around it
  view: { center: [0.253, 0.565], width: 0.32 },
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

async function until<T>(get: () => T | undefined | false | null, timeoutMs: number, what: string): Promise<T> {
  const end = performance.now() + timeoutMs
  for (;;) {
    const v = get()
    if (v) return v
    if (performance.now() > end) throw new Error(`demo: timed out waiting for ${what}`)
    await sleep(50)
  }
}

// ─────────────── on-screen caption and pen ───────────────

let ui: { caption: HTMLDivElement; beat: HTMLSpanElement; text: HTMLSpanElement; pen: HTMLDivElement } | null = null

function ensureUi() {
  if (ui) return ui
  const style = document.createElement('style')
  style.textContent = `
    .demo-caption { position: fixed; left: 50%; bottom: 168px; transform: translateX(-50%); z-index: 1000; max-width: min(760px, calc(100vw - 32px));
      display: flex; gap: 12px; align-items: baseline; padding: 12px 18px; border-radius: 16px; background: rgba(18, 22, 32, 0.84);
      color: #fff; font: 500 16px/1.4 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.25); pointer-events: none;
      backdrop-filter: blur(12px); transition: opacity 200ms ease-out, transform 200ms ease-out; }
    .demo-caption[data-hidden='true'] { opacity: 0; transform: translateX(-50%) translateY(8px); }
    .demo-caption .demo-beat { flex: none; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #9cc3ff; }
    .demo-pen { position: fixed; z-index: 1001; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; pointer-events: none;
      background: rgba(194, 75, 54, .25); border: 2px solid #c24b36; box-shadow: 0 2px 8px rgba(0,0,0,.2); opacity: 0; transition: opacity 150ms; }
    .demo-pen[data-on='true'] { opacity: 1; }
    .demo-pen[data-down='true'] { background: #c24b36; transform: scale(.7); }
  `
  document.head.appendChild(style)
  const caption = document.createElement('div')
  caption.className = 'demo-caption'
  caption.dataset.hidden = 'true'
  caption.dataset.testid = 'demo-caption'
  const beat = document.createElement('span')
  beat.className = 'demo-beat'
  const text = document.createElement('span')
  caption.append(beat, text)
  const pen = document.createElement('div')
  pen.className = 'demo-pen'
  document.body.append(caption, pen)
  ui = { caption, beat, text, pen }
  return ui
}

/** Presenting live: the presenter talks, so no captions. */
let quiet = false

/** Show a caption: the beat's name and what is being said or done. Empty text hides it. */
export function caption(beat: string, text = '') {
  if (quiet && (beat || text)) return
  const u = ensureUi()
  u.beat.textContent = beat
  u.text.textContent = text
  u.caption.dataset.hidden = String(!text && !beat)
}

function penAt(x: number, y: number, down: boolean) {
  const u = ensureUi()
  u.pen.style.left = `${x}px`
  u.pen.style.top = `${y}px`
  u.pen.dataset.on = 'true'
  u.pen.dataset.down = String(down)
}
const penOff = () => ensureUi().pen.setAttribute('data-on', 'false')

/** Move the pen to a screen point over `ms`, without drawing (a person reaching for the spot). */
async function glide(to: { x: number; y: number }, ms: number) {
  const u = ensureUi()
  const from = u.pen.dataset.on === 'true' ? { x: parseFloat(u.pen.style.left), y: parseFloat(u.pen.style.top) } : { x: to.x, y: to.y + 60 }
  const t0 = performance.now()
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms)
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    penAt(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, false)
    if (k >= 1) return
    await frame()
  }
}

// ─────────────── driving the app ───────────────

function sheetByNumber(number: string) {
  const s = revitSnapshot().sheets.find((x) => x.number?.toLowerCase() === number.toLowerCase())
  if (!s) throw new Error(`demo: Revit has no sheet ${number}`)
  return s
}

function placement(sheetId: string) {
  const doc = getDocState()
  const sheet = doc.sheets.find((s) => s.id === sheetId)
  const pl = doc.placements.find((p) => p.sheetId === sheetId)
  if (!sheet || !pl) throw new Error(`demo: sheet ${sheetId} is not on the board`)
  return { sheet, pl }
}

const toSheet = (sheetId: string, f: Frac): Point => {
  const { sheet } = placement(sheetId)
  return { x: f[0] * sheet.sizePt.w, y: f[1] * sheet.sizePt.h }
}

function toScreen(sheetId: string, p: Point) {
  const vp = getViewportEl()
  if (!vp) throw new Error('demo: no board on screen')
  const r = vp.getBoundingClientRect()
  const s = sheetToScreen(getCamera(), placement(sheetId).pl, p)
  return { x: r.left + s.x, y: r.top + s.y }
}

/** Points along a polyline, `step` sheet points apart, with a little hand wobble. */
function sample(path: Point[], step: number, wobble: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]
    const b = path[i + 1]
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n
      const w = k === 0 || k === n ? 0 : Math.sin(t * Math.PI * 3 + i) * wobble
      const nx = -(b.y - a.y)
      const ny = b.x - a.x
      const len = Math.hypot(nx, ny) || 1
      out.push({ x: a.x + (b.x - a.x) * t + (nx / len) * w, y: a.y + (b.y - a.y) * t + (ny / len) * w })
    }
  }
  return out
}

/** Draw a stroke on a sheet with real pointer events at hand speed, the pen visible. */
async function stroke(sheetId: string, path: Point[], ms: number, wobble = true) {
  const vp = getViewportEl()
  if (!vp) throw new Error('demo: no board on screen')
  const { sheet } = placement(sheetId)
  const pts = sample(path, Math.max(sheet.sizePt.w, sheet.sizePt.h) / 600, wobble ? Math.max(sheet.sizePt.w, sheet.sizePt.h) / 3000 : 0)
  const prevTool = getSession().tool
  session.setTool('brush')
  await frame()
  await glide(toScreen(sheetId, pts[0]), 450)
  const fire = (type: string, p: Point) => {
    const s = toScreen(sheetId, p)
    const down = type !== 'pointerup'
    penAt(s.x, s.y, down)
    vp.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 9,
        pointerType: 'pen',
        isPrimary: true,
        clientX: s.x,
        clientY: s.y,
        button: type === 'pointermove' ? -1 : 0,
        buttons: down ? 1 : 0,
        pressure: down ? 0.55 : 0,
      }),
    )
  }
  const t0 = performance.now()
  for (let i = 0; i < pts.length; i++) {
    const due = t0 + (ms * i) / (pts.length - 1)
    while (performance.now() < due) await frame()
    fire(i === 0 ? 'pointerdown' : 'pointermove', pts[i])
  }
  fire('pointerup', pts[pts.length - 1])
  await frame()
  session.setTool(prevTool)
}

/** What this rehearsal drew: its commands, newest last, for `reset()`. */
const drawn: { commandId: string; strokeId: string; sheetId: string }[] = []

/**
 * The Revit elements the rehearsal made, kept in localStorage so `reset()` can remove them even after a reload (when
 * the strokes that made them are gone and there is nothing left to undo).
 */
const ELEMENTS_KEY = 'brush.demo.elements'
type Made = { sheetId: string; ids: string[] }
function readMade(): Made[] {
  try {
    return JSON.parse(localStorage.getItem(ELEMENTS_KEY) ?? '[]') as Made[]
  } catch {
    return []
  }
}
function writeMade(m: Made[]) {
  try {
    if (m.length) localStorage.setItem(ELEMENTS_KEY, JSON.stringify(m))
    else localStorage.removeItem(ELEMENTS_KEY)
  } catch {
    /* private mode: reset only works within this page load */
  }
}
/** Record the elements Revit made for the rehearsal's commands. */
function remember() {
  const results = revitSnapshot().results
  const made = readMade()
  for (const d of drawn) {
    const ids = results.find((r) => r.id === d.commandId)?.elementIds ?? []
    for (const id of ids) {
      let m = made.find((x) => x.sheetId === d.sheetId)
      if (!m) made.push((m = { sheetId: d.sheetId, ids: [] }))
      if (!m.ids.includes(id)) m.ids.push(id)
    }
  }
  writeMade(made)
}

/**
 * Draw one element: the brush is set to `kind` (so the reading is the one rehearsed, not a guess), the stroke is drawn,
 * and the call resolves when its command exists. Returns the command id.
 */
async function draw(kind: BrushMode, sheetId: string, path: Point[], ms: number): Promise<string> {
  const before = new Set(getSession().commands.map((c) => c.id))
  session.setSetting('mode', kind)
  // walls and doors dead straight: zoomed in close, a hand's wobble reads as corners and splits a wall in three
  await stroke(sheetId, path, ms, kind !== 'wall' && kind !== 'door')
  const cmd = await until(() => getSession().commands.find((c) => !before.has(c.id)), 5000, `the ${kind} to commit`)
  drawn.push({ commandId: cmd.id, strokeId: cmd.strokeId, sheetId })
  return cmd.id
}

/** Resolves when every timed trip has landed (or failed); returns the newest trip's total, ms. */
async function waitLanded(timeoutMs = 60000): Promise<number | undefined> {
  await until(() => roundTrips.get().trips.every((t) => t.landed !== undefined || t.failed), timeoutMs, 'Revit to send the sheet back')
  remember()
  const trips = roundTrips.get().trips
  const t = trips[trips.length - 1]
  return t?.landed !== undefined ? t.landed - t.start : undefined
}

/** Glide the camera so `center` (sheet fractions) is mid-screen and `width` of the sheet fills the view. */
async function look(sheetId: string, center: Frac, width: number, ms = 900) {
  const vp = getViewportEl()
  if (!vp) return
  const { sheet, pl } = placement(sheetId)
  const r = vp.getBoundingClientRect()
  const z1 = r.width / (width * sheet.sizePt.w)
  const bx = pl.x + center[0] * sheet.sizePt.w
  const by = pl.y + center[1] * sheet.sizePt.h
  const from = getCamera()
  // the board point now in the middle of the view, so the glide pans and zooms together
  const fx = r.width / 2 / from.z - from.x
  const fy = r.height / 2 / from.z - from.y
  const t0 = performance.now()
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms)
    const e = 1 - (1 - k) ** 3
    const z = from.z * (z1 / from.z) ** e
    const mx = fx + (bx - fx) * e
    const my = fy + (by - fy) * e
    setCamera({ x: r.width / 2 / z - mx, y: r.height / 2 / z - my, z }, { settleNow: k >= 1 })
    if (k >= 1) return
    await frame()
  }
}

/**
 * Change a placed element's type the way a person does: right-click it (the type menu opens and asks Revit for every
 * type it allows), then pick the type. Resolves with the type picked.
 */
async function retype(sheetId: string, f: Frac, typeName: string): Promise<string> {
  const vp = getViewportEl()
  if (!vp) throw new Error('demo: no board on screen')
  session.setTool('select')
  await glide(toScreen(sheetId, toSheet(sheetId, f)), 800)
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="type-menu"] button[data-type]')]
  const pickRow = () => rows().find((b) => b.dataset.type === typeName) ?? rows().find((b) => b.dataset.type!.startsWith(typeName))
  // Right after the sheet lands the board may still pick what was under the table (the room): when the menu is for
  // something else, close it and right-click again. Revit's own list arrives a moment after the menu opens.
  let row: HTMLButtonElement | undefined
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const at = toScreen(sheetId, toSheet(sheetId, f))
    penAt(at.x, at.y, true)
    vp.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2, buttons: 2 }))
    await sleep(150)
    penAt(at.x, at.y, false)
    // the menu is for the table once its type list shows a furniture type; then only Revit's full list is awaited
    // (asking again would queue another request in Revit)
    const forTable = await until(() => rows().some((b) => /table|banquette|chair|bed|shelving/i.test(b.dataset.type ?? '')), 2500, 'the menu').then(
      () => true,
      () => false,
    )
    row = forTable ? await until(pickRow, 20000, 'the type').catch(() => undefined) : undefined
    if (!row) {
      document.querySelector<HTMLElement>('[data-testid="type-menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(800)
    }
  }
  if (!row) throw new Error(`demo: "${typeName}" never showed in the type menu`)
  row.scrollIntoView({ block: 'center' })
  await sleep(250)
  const r = row.getBoundingClientRect()
  await glide({ x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }, 700)
  penAt(r.left + Math.min(r.width / 2, 120), r.top + r.height / 2, true)
  await sleep(120)
  row.click()
  penOff()
  return row.dataset.type!
}

/** The host element the inspector is showing now (hovered or pinned), if any. */
/** The host element highlighted on the sheets now: the one under the pointer (the card opens only on a click). */
const inspected = () => document.querySelector<HTMLElement>('[data-testid="inspect-highlight"]')?.dataset.element || undefined

/** Host elements selected on the sheets now (the selection outline every sheet draws). */
const selectedOnSheets = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-testid="selected-sheet"]')].flatMap((g) => (g.dataset.items ?? '').split(',').filter(Boolean))

/**
 * Open a side panel the way a person does, by its icon on the rail (src/app/ui/SidePanels.tsx): 'element' (the
 * selected element's card), 'tool', 'reading', 'session', 'filters'. Already open: nothing to do.
 */
async function openPanel(id: string) {
  const btn = await until(() => document.querySelector<HTMLButtonElement>(`[data-testid="rail-${id}"]`), 5000, `the ${id} panel's icon`)
  if (btn.getAttribute('aria-pressed') === 'true') return
  await press(btn)
  await frame()
}

/** Close a side panel by its icon, if it is open. */
async function closePanel(id: string) {
  const btn = document.querySelector<HTMLButtonElement>(`[data-testid="rail-${id}"]`)
  if (btn?.getAttribute('aria-pressed') === 'true') await press(btn)
}

/** A pointer event on the board at a screen point. */
function pointer(type: string, at: { x: number; y: number }, buttons = 0) {
  getViewportEl()?.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons }),
  )
}

/**
 * Select host element `elementId` on a sheet with a click, the way a person does: bring a stretch of it into view, find
 * a point on it that picks it (not a window or a tag on top of it), and click there.
 */
async function selectElement(sheetId: string, elementId: string, near?: Frac) {
  const ctx = await contextFor(sheetId)
  const item = ctx?.items.find((i) => i.hostRef === elementId)
  if (!item) throw new Error(`demo: element ${elementId} is not on sheet ${sheetId}`)
  const pts = item.geometry.points
  const { sheet } = placement(sheetId)
  const along = (t: number) => {
    // a point at fraction t of the polyline's length
    const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y))
    let d = t * segs.reduce((a, b) => a + b, 0)
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const k = segs[i] ? Math.min(1, d / segs[i]) : 0
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k }
      }
      d -= segs[i]
    }
    return pts[0]
  }
  session.setTool('select')
  // where along it to click: next to `near` (the view stays where it is), else its middle, closed in on. A grid line
  // can run along a wall (Snowdon's grid E on the north facade), and the pick tolerance is in screen pixels, so the
  // closer the view the further apart they are
  let t0 = 0.5
  if (near) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    const n = { x: near[0] * sheet.sizePt.w, y: near[1] * sheet.sizePt.h }
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1
    t0 = Math.min(0.98, Math.max(0.02, ((n.x - a.x) * (b.x - a.x) + (n.y - a.y) * (b.y - a.y)) / len2))
  } else {
    const mid = along(0.5)
    await look(sheetId, [mid.x / sheet.sizePt.w, mid.y / sheet.sizePt.h], 0.12, 1100)
  }
  // on the centreline, then a little to either side of it (still on the wall's thickness)
  const normal = (() => {
    const a = pts[0]
    const b = pts[pts.length - 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
  })()
  const tries: Point[] = []
  for (const off of [0, 2.5, -2.5, 4, -4])
    for (const t of near ? [t0, t0 - 0.01, t0 + 0.01, t0 - 0.02, t0 + 0.02] : [0.5, 0.42, 0.58, 0.34, 0.66]) {
      const c = along(t)
      tries.push({ x: c.x + normal.x * off, y: c.y + normal.y * off })
    }
  for (const p of tries) {
    // a pinned element owns the highlight: release it so the hover shows what is under the pointer
    inspect.unpin()
    const at = toScreen(sheetId, p)
    await glide(at, 120)
    pointer('pointermove', at)
    await frame()
    await frame()
    if (inspected() !== elementId) continue
    // the card opening widens the sidebar, and the board re-centres a moment later: let it settle, aim again, and
    // click only if the wall is still what is under the pointer
    await sleep(350)
    const again = toScreen(sheetId, p)
    penAt(again.x, again.y, true)
    pointer('pointermove', again)
    await frame()
    await frame()
    if (inspected() !== elementId) continue
    pointer('pointerdown', again, 1)
    pointer('pointerup', again)
    await frame()
    await frame()
    penAt(again.x, again.y, false)
    // a click can pick what runs alongside (a grid line) where a hover found the wall: check what got selected
    if (selectedOnSheets().includes(elementId)) return
  }
  throw new Error(`demo: no point on element ${elementId} picks it`)
}

/** Glide the camera to show every sheet on the board. */
async function fitAll(ms = 1200) {
  const from = getCamera()
  boardView.fit()
  const to = getCamera()
  setCamera(from, { settleNow: true })
  const vp = getViewportEl()
  if (!vp) return
  const r = vp.getBoundingClientRect()
  const fx = r.width / 2 / from.z - from.x
  const fy = r.height / 2 / from.z - from.y
  const tx = r.width / 2 / to.z - to.x
  const ty = r.height / 2 / to.z - to.y
  const t0 = performance.now()
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms)
    const e = 1 - (1 - k) ** 3
    const z = from.z * (to.z / from.z) ** e
    const mx = fx + (tx - fx) * e
    const my = fy + (ty - fy) * e
    setCamera({ x: r.width / 2 / z - mx, y: r.height / 2 / z - my, z }, { settleNow: k >= 1 })
    if (k >= 1) return
    await frame()
  }
}

// ─────────────── the colleague's sketch ───────────────

/**
 * The real import takes about a minute on the photo (finding the sheet among four, then registering it), which the
 * stage does not have. `recordSketch()` runs it once on the presenting machine and keeps what it traced in the sketch
 * area; dropping the same photo then plays that back through the import dialog in a few seconds.
 */
const REPLAY_KEY = 'brush.demo.sketchReplay'
interface SketchRecording {
  sheetNumber: string
  photoSize: number
  lines: string[]
  strokes: { size: number; color?: string; tool: string; points: { x: number; y: number; t: number }[] }[]
}
const REPLAY_MS = 7000

function readRecording(): SketchRecording | null {
  try {
    return JSON.parse(localStorage.getItem(REPLAY_KEY) ?? 'null') as SketchRecording | null
  } catch {
    return null
  }
}

/** Play the recording back for that photo (known by its size), on the sheet it was recorded on. */
function installReplay() {
  setPhotoReplay((photo) => {
    const rec = readRecording()
    if (!rec || photo.size !== rec.photoSize) return null
    const sheet = getDocState().sheets.find((s) => s.number === rec.sheetNumber)
    if (!sheet) return null
    const strokes = rec.strokes.map((st) => ({ ...st, id: '', sheetId: sheet.id, startedAt: 0 })) as unknown as Stroke[]
    return { sheetId: sheet.id, strokes, lines: rec.lines, ms: REPLAY_MS }
  })
}
installReplay()

/** Open the sample (unless it is open) with no sketches from an earlier run on it. */
async function openSample(spots: SketchPhotoSpots) {
  const base = spots.sample.name.replace(/\.[^.]+$/, '').toLowerCase()
  const isIt = () => getDocState().status === 'ready' && (getDocState().fileName ?? '').toLowerCase().startsWith(base) && getDocState().sheets.length > 0
  if (!isIt()) {
    if (revitSnapshot().state !== 'off') revit.disconnect()
    await openDocument(spots.sample.url, spots.sample.name)
    await until(isIt, 60000, `${spots.sample.name} to open`)
  }
  // a clean stage: Brush keeps each file's sketches; these exist only here, so clearing them touches no model.
  // The trace paper of an earlier import goes too.
  if (getSession().strokes.length) session.clear()
  for (const sh of getDocState().sheets) tracePaper.rollUp(sh.id)
}

/** Run the real import once and keep what it traced in the sketch area, for the stage (about a minute). */
async function recordSketch(spots: SketchPhotoSpots = KRO_SKETCH_SPOTS) {
  await openSample(spots)
  const res = await fetch(spots.photo.url)
  if (!res.ok) throw new Error(`demo: ${spots.photo.url} is not there (copy the photo into editor/fixtures/demo/)`)
  const photo = await res.blob()
  const lines: string[] = []
  setPhotoReplay(null)
  const t0 = performance.now()
  let summary
  try {
    summary = await importPhotoMarkup(photo, { onProgress: (l) => lines.push(l), keepCamera: true })
  } finally {
    installReplay()
  }
  const sheet = docSheet(spots.sheet)
  const [[x0, y0], [x1, y1]] = spots.keep
  const kept = getSession()
    .strokes.filter((st) => st.id.startsWith(summary.groupId))
    .filter((st) => {
      const xs = st.points.map((p) => p.x / sheet.sizePt.w)
      const ys = st.points.map((p) => p.y / sheet.sizePt.h)
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
    })
  const rec: SketchRecording = {
    sheetNumber: spots.sheet,
    photoSize: photo.size,
    // the lines say how many strokes the trace found: say how many are shown
    lines: lines.map((l) => l.replace(/, \d+ strokes/, `, ${kept.length} strokes`)),
    strokes: kept.map((st) => ({ size: st.size, color: st.color, tool: st.tool, points: st.points.map((p) => ({ x: p.x, y: p.y, t: p.t })) })),
  }
  localStorage.setItem(REPLAY_KEY, JSON.stringify(rec))
  session.clear()
  return { seconds: Math.round((performance.now() - t0) / 100) / 10, traced: summary.strokes, kept: kept.length }
}

/** Click a button the way a person does: the pen glides to it, then presses. */
async function press(button: HTMLElement) {
  const r = button.getBoundingClientRect()
  await glide({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, 600)
  penAt(r.left + r.width / 2, r.top + r.height / 2, true)
  await sleep(120)
  button.click()
  penOff()
}

/** Open the sample, drop the photo, import it through the dialog, and show the trace paper. */
async function sketchFromPhoto(spots: SketchPhotoSpots = KRO_SKETCH_SPOTS) {
  await openSample(spots)
  const s = docSheet(spots.sheet)
  boardView.focusSheet(s.pageIndex, 1.6)
  await sleep(400)
  await dropFile(spots.photo.url, spots.photo.name)
  const run = await until(() => document.querySelector<HTMLButtonElement>('[data-testid="photo-run"]:not(:disabled)'), 10000, 'the photo import dialog')
  await sleep(600)
  await press(run)
  const done = await until(() => document.querySelector<HTMLButtonElement>('[data-testid="photo-done"]'), 120000, 'the photo to be traced')
  await sleep(900)
  await press(done)
  // the trace paper unrolls over the sheet; then close in on the sketch
  await sleep(1800)
  await look(s.id, spots.view.center, spots.view.width, 1200)
}

/** Make elements of the imported sketch: walls, doors and furniture, read as the brush reads a stroke. */
async function makeSketchReal() {
  // the import's row, with Make elements, is in the session panel
  await openPanel('session')
  const btn = await until(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Make elements'), 10000, 'Make elements')
  await press(btn)
  // reading: done when the button stops saying so (strokes it does not read as an element stay ink)
  const reading = () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reading…')
  await until(reading, 3000, 'the reading to start').catch(() => undefined)
  await until(() => !reading(), 120000, 'the sketch to become elements')
}

/** The open document's sheet with this number (any source, not only Revit's). */
function docSheet(number: string) {
  const s = getDocState().sheets.find((x) => x.number?.toLowerCase() === number.toLowerCase())
  if (!s) throw new Error(`demo: the open file has no sheet ${number}`)
  return s
}

/**
 * Drop a file on Brush the way a person drags one in from Explorer: a file chip glides onto the page, the page lights
 * up for the drop, and the app's own drop handler opens it.
 */
async function dropFile(url: string, name: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`demo: ${url} is not there (copy ${name} into editor/fixtures/demo/)`)
  const file = new File([await res.blob()], name)
  const app = document.querySelector<HTMLElement>('.app')
  if (!app) throw new Error('demo: no app on screen')
  const chip = document.createElement('div')
  chip.textContent = `📄 ${name}`
  chip.style.cssText =
    'position:fixed;z-index:1002;left:-260px;top:62%;padding:10px 14px;border-radius:10px;background:#fff;color:#1b1d21;font:600 14px system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25);transition:left 900ms cubic-bezier(.2,.8,.2,1),top 900ms cubic-bezier(.2,.8,.2,1),opacity 250ms ease-out;pointer-events:none'
  document.body.appendChild(chip)
  await frame()
  chip.style.left = 'calc(50% - 120px)'
  chip.style.top = '48%'
  const dt = new DataTransfer()
  dt.items.add(file)
  await sleep(500)
  app.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  await sleep(600)
  app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  chip.style.opacity = '0'
  setTimeout(() => chip.remove(), 400)
}

/** No Revit: drop the model's `.rvt`, wait for its sheets, and zoom to where the beat sketches. */
async function openWithoutRevit(spots: NoLicenseSpots = RAC_BASIC_SPOTS) {
  // the point of the beat: no live link
  if (revitSnapshot().state !== 'off') revit.disconnect()
  // dragged in by hand already? (the converted document is named after the model, without the .rvt)
  const base = spots.file.name.replace(/\.[^.]+$/, '').toLowerCase()
  const isIt = () => getDocState().status === 'ready' && (getDocState().fileName ?? '').toLowerCase().startsWith(base) && getDocState().sheets.length > 0
  if (!isIt()) {
    const before = getDocState().source
    await dropFile(spots.file.url, spots.file.name)
    await until(() => getDocState().source !== before && isIt(), 120000, `${spots.file.name} to open`)
  }
  // a clean stage: Brush keeps each file's sketches, so an earlier rehearsal's wall and stool would come back with it.
  // They exist only here (no Revit), so clearing them touches no model.
  if (getSession().strokes.length) session.clear()
  const s = docSheet(spots.sheet)
  await until(() => document.querySelector(`[data-testid="sheet"][data-sheet-id="${CSS.escape(s.id)}"]`), 30000, 'the sheet on the board')
  boardView.focusSheet(s.pageIndex, 1.6)
  await sleep(600)
  await look(s.id, spots.view.center, spots.view.width, 1400)
}

/** Sketch in the kitchen: a partition wall, then the stool missing from the row along the island. */
async function sketchKitchen(spots: NoLicenseSpots = RAC_BASIC_SPOTS) {
  const s = docSheet(spots.sheet)
  const at = (f: Frac) => toSheet(s.id, f)
  await draw('wall', s.id, spots.wall.map(at), 1000)
  const c = at(spots.stool.center)
  const r = spots.stool.r * s.sizePt.w
  // a small hand-drawn circle; next to the bar chairs it reads as one more of them
  const ring = Array.from({ length: 19 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2 - Math.PI / 2
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }
  })
  await draw('furniture', s.id, ring, 700)
  session.setSetting('mode', 'auto')
  penOff()
}

// ─────────────── beats ───────────────

export interface RunOptions {
  /** Skip the talking pauses. */
  fast?: boolean
  spots?: DemoSpots
}

const SAY = {
  hook: 'Architects think with a pen. Revit makes them think in dialog boxes.',
  setup: 'Revit is open with the real model. Brush lists its sheets: pick four floors.',
  opening: 'Revit sends each sheet as it is now: the PDF plus every element on it.',
  everywhere: 'Zoom out: Brush lights the selected wall up on every sheet it is on.',
  wall: 'Sketch a wall…',
  door: '…a door in it…',
  table: '…and a table.',
  back: 'Each one is now a real Revit element, and the sheet came back drawn by Revit.',
  retype: 'Not the table I wanted. Right-click it and pick another type: Revit lists every one it has.',
  retyped: 'Swapped in Revit, and redrawn.',
  inspect: 'Click a wall of the room: the north facade, a real Revit wall with all its parameters.',
  noLicense: 'No Revit licence? Drop the .rvt on Brush: it reads the model itself, no Revit needed.',
  kitchen: 'And you sketch on it the same way: a wall, and the stool missing from the kitchen island.',
  photo: 'A colleague sketched on a print with a marker. Take a photo, drop it on Brush: it finds the sheet and traces the ink.',
  real: 'Then make it real: the traced ink becomes walls, doors and furniture.',
  close: 'Brush. Sketch it, and it is built.',
}

type Beat = 'hook' | 'setup' | 'loop' | 'retype' | 'inspect' | 'nolicense' | 'photo' | 'close'
export const BEATS: readonly Beat[] = ['hook', 'setup', 'loop', 'retype', 'inspect', 'nolicense', 'photo', 'close']

async function beat(name: Beat, opts: RunOptions = {}) {
  const spots = opts.spots ?? SNOWDON_SPOTS
  const talk = (ms: number) => sleep(opts.fast ? Math.min(ms, 400) : ms)
  switch (name) {
    case 'hook': {
      caption('0:00 · Hook', SAY.hook)
      await talk(5000)
      return
    }
    case 'setup': {
      caption('0:30 · Setup', SAY.setup)
      roundTrips.setEnabled(true)
      if (revitSnapshot().state !== 'on') {
        revit.connect()
        await until(() => revitSnapshot().state === 'on', 20000, 'Revit to connect')
      }
      const s = sheetByNumber(spots.sheet)
      const all = [s, ...spots.alsoOpen.map(sheetByNumber)]
      const missing = all.filter((x) => !revitSnapshot().open.some((o) => o.id === x.id))
      if (missing.length) {
        // pick them in the picker the way a person would, when the picker is on screen
        const rowOf = (id: string) => document.querySelector<HTMLButtonElement>(`li[data-sheet-id="${CSS.escape(id)}"] [data-testid="revit-pick-sheet"]`)
        if (rowOf(missing[0].id)) {
          for (const m of missing) {
            const row = rowOf(m.id)
            if (!row) continue
            row.scrollIntoView({ block: 'center' })
            await frame()
            const r = row.getBoundingClientRect()
            await glide({ x: r.left + 20, y: r.top + r.height / 2 }, 500)
            if (row.getAttribute('aria-checked') !== 'true') row.click()
            await talk(350)
          }
          const open = document.querySelector<HTMLButtonElement>('[data-testid="revit-open-selected"]')
          if (open && !open.disabled) {
            const o = open.getBoundingClientRect()
            await glide({ x: o.left + o.width / 2, y: o.top + o.height / 2 }, 600)
            open.click()
          } else revit.openSheets(missing.map((m) => m.id))
        } else revit.openSheets(missing.map((m) => m.id))
        penOff()
        // all of them before drawing: a sheet arriving moves the board under the pen
        caption('0:30 · Setup', SAY.opening)
        await until(() => all.every((x) => revitSnapshot().open.some((o) => o.id === x.id)), 240000, 'the sheets to open')
        await until(() => document.querySelector(`[data-testid="sheet"][data-sheet-id="${CSS.escape(s.id)}"][data-rendered="true"]`), 30000, 'the sheet to draw')
        caption('0:30 · Setup', SAY.setup)
      }
      // never draw on top of an earlier run: take back what it left, or stop here
      await ensureClean(spots)
      const { sheet } = placement(s.id)
      boardView.focusSheet(sheet.pageIndex, 1.6)
      await talk(1500)
      await look(s.id, spots.view.center, spots.view.width, 1400)
      await talk(1000)
      return
    }
    case 'loop': {
      const s = sheetByNumber(spots.sheet)
      const at = (f: Frac) => toSheet(s.id, f)
      caption('1:00 · The loop', SAY.wall)
      await draw('wall', s.id, spots.wall.map(at), 1100)
      await talk(600)
      caption('1:00 · The loop', SAY.door)
      await draw('door', s.id, spots.door.map(at), 450)
      await talk(600)
      caption('1:00 · The loop', SAY.table)
      const [a, b] = spots.table.map(at)
      await draw('furniture', s.id, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a], 1300)
      penOff()
      session.setSetting('mode', 'auto')
      const ms = await waitLanded()
      const stats = tripStats(roundTrips.get().trips)
      caption('1:00 · The loop', `${SAY.back}${ms !== undefined ? ` Last one: ${(ms / 1000).toFixed(1)} s.` : ''}${stats.best !== undefined ? ` Best: ${(stats.best / 1000).toFixed(1)} s.` : ''}`)
      await talk(6000)
      return
    }
    case 'retype': {
      const s = sheetByNumber(spots.sheet)
      caption('2:15 · Change your mind', SAY.retype)
      const [a, b] = spots.table
      const picked = await retype(s.id, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], spots.retypeTo)
      caption('2:15 · Change your mind', `${picked}…`)
      const ms = await waitLanded()
      caption('2:15 · Change your mind', `${SAY.retyped}${ms !== undefined ? ` ${(ms / 1000).toFixed(1)} s.` : ''}`)
      await talk(5000)
      session.setTool('brush')
      return
    }
    case 'inspect': {
      const s = sheetByNumber(spots.sheet)
      caption('3:15 · It reads the building', SAY.inspect)
      // select (not just hover) the facade wall along the room, still zoomed in, and open its card
      await selectElement(s.id, spots.everywhere.element, spots.view.center)
      await openPanel('element')
      penOff()
      await talk(6000)
      if (spots.alsoOpen.length && revitSnapshot().open.length > 1) {
        caption('3:15 · It reads the building', SAY.everywhere)
        await fitAll()
        caption('3:15 · It reads the building', `One wall, ${revitSnapshot().open.filter((o) => document.querySelector(`[data-sheet-id="${CSS.escape(o.id)}"] [data-testid="selected-sheet"]`)).length || spots.alsoOpen.length + 1} sheets: ${spots.everywhere.label} on every floor it is on.`)
        await talk(6000)
        // back to where the demo was
        await look(s.id, spots.view.center, spots.view.width, 1200)
      }
      penOff()
      session.setTool('brush')
      return
    }
    case 'nolicense': {
      caption('4:00 · No Revit licence?', SAY.noLicense)
      await openWithoutRevit()
      await talk(2500)
      caption('4:00 · No Revit licence?', SAY.kitchen)
      await sketchKitchen()
      await talk(5000)
      return
    }
    case 'photo': {
      caption("4:15 · A colleague's sketch", SAY.photo)
      await sketchFromPhoto()
      await talk(3000)
      caption("4:15 · A colleague's sketch", SAY.real)
      await makeSketchReal()
      await talk(4000)
      return
    }
    case 'close': {
      caption('4:30 · Close', SAY.close)
      await talk(5000)
      caption('', '')
      return
    }
  }
}

/** The whole run of show. Resolves with each beat's wall-clock seconds and the round trips measured. */
async function run(opts: RunOptions = {}) {
  const times: Record<string, number> = {}
  for (const b of BEATS) {
    const t0 = performance.now()
    await beat(b, opts)
    times[b] = Math.round((performance.now() - t0) / 100) / 10
  }
  return { seconds: times, trips: tripStats(roundTrips.get().trips) }
}

/** Walls, doors and furniture on the stage (anything there was left by an earlier run): Revit ids. */
async function leftovers(spots: DemoSpots): Promise<string[]> {
  const s = sheetByNumber(spots.sheet)
  const ctx = await contextFor(s.id)
  const { sheet } = placement(s.id)
  const [[x0, y0], [x1, y1]] = spots.stage
  const inside = (x: number, y: number) => {
    const fx = x / sheet.sizePt.w
    const fy = y / sheet.sizePt.h
    return fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1
  }
  // along the whole outline, not only its corners: a wall can cross the stage with both ends outside it
  const crosses = (pts: readonly Point[]) =>
    pts.some((p, i) => {
      const q = pts[i + 1] ?? p
      for (let k = 0; k <= 20; k++) if (inside(p.x + ((q.x - p.x) * k) / 20, p.y + ((q.y - p.y) * k) / 20)) return true
      return false
    })
  const ids = (ctx?.items ?? []).filter((i) => i.hostRef && ['Walls', 'Doors', 'Windows', 'Furniture', 'Casework'].includes(i.props?.category ?? '') && crosses(i.geometry.points)).map((i) => i.hostRef!)
  return [...new Set(ids)]
}

/**
 * Make sure the stage is clean before a rehearsal: open the sheet, take back what the last run left (its strokes, and
 * the elements on record), then delete whatever is still on the stage. Throws, drawing nothing, when it stays dirty.
 */
async function ensureClean(spots: DemoSpots = SNOWDON_SPOTS): Promise<{ removed: number }> {
  if (revitSnapshot().state !== 'on') {
    revit.connect()
    await until(() => revitSnapshot().state === 'on', 20000, 'Revit to connect')
  }
  const s = sheetByNumber(spots.sheet)
  await ensureOpen(s.id)
  let removed = (await reset()).deleted
  for (let pass = 0; pass < 3; pass++) {
    // the sheet comes back from Revit after each change: read it again
    await until(() => revitSnapshot().inFlight === 0, 30000, 'Revit to settle').catch(() => undefined)
    const left = await leftovers(spots)
    if (!left.length) return { removed }
    const versionOf = () => revitSnapshot().open.find((o) => o.id === s.id)?.version ?? 0
    const version = versionOf()
    for (const id of left) if (await revit.deleteElements(s.id, [id])) removed++
    // wait for the sheet's new version, which no longer draws them
    await until(() => versionOf() > version, 30000, 'the cleaned sheet').catch(() => undefined)
  }
  const still = await leftovers(spots)
  if (still.length) throw new Error(`demo: the stage is not clean: elements ${still.join(', ')} are still in Live/Work Unit 205`)
  return { removed }
}

/** Connect to Revit and open a sheet (by Revit id) if it is not on screen yet. */
async function ensureOpen(sheetId: string) {
  if (revitSnapshot().state !== 'on') {
    revit.connect()
    await until(() => revitSnapshot().state === 'on', 20000, 'Revit to connect')
  }
  if (revitSnapshot().open.some((o) => o.id === sheetId)) return
  revit.openSheet(sheetId)
  await until(() => revitSnapshot().open.some((o) => o.id === sheetId), 120000, 'the sheet to open')
}

/**
 * Take the rehearsal back out of Revit. Strokes still on screen are undone (the link reverts their elements); elements
 * made in an earlier page load are deleted by id. Resolves with how many elements were deleted that way.
 */
async function reset() {
  caption('Reset', 'Taking the rehearsal back out of Revit.')
  // elements of strokes still on screen: the undo below reverts them, so they are not deleted by id as well
  const onScreen = new Set(getSession().strokes.map((s) => s.id))
  const results = revitSnapshot().results
  const reverted = new Set(drawn.filter((d) => onScreen.has(d.strokeId)).flatMap((d) => results.find((r) => r.id === d.commandId)?.elementIds ?? []))
  let guard = 50
  while (drawn.length && guard-- > 0) {
    const live = new Set(getSession().strokes.map((s) => s.id))
    const last = drawn[drawn.length - 1]
    if (!live.has(last.strokeId)) {
      drawn.pop()
      continue
    }
    session.undo()
    await frame()
    if (!new Set(getSession().strokes.map((s) => s.id)).has(last.strokeId)) drawn.pop()
  }
  revit.flush()
  await until(() => revitSnapshot().inFlight === 0, 30000, 'Revit to revert the strokes').catch(() => undefined)
  // one at a time: an element already gone (deleted in Revit by hand) must not stop the others
  // deleting by id needs the link and the sheet open: after a reload, connect and open it first. A sheet that cannot be
  // reached keeps its ids for the next reset.
  let deleted = 0
  const keep: Made[] = []
  for (const m of readMade()) {
    const ids = m.ids.filter((id) => !reverted.has(id))
    if (!ids.length) continue
    const reached = await ensureOpen(m.sheetId).then(
      () => true,
      () => false,
    )
    if (!reached) {
      keep.push({ sheetId: m.sheetId, ids })
      continue
    }
    // one at a time: an element already gone (a door taken with its wall, or deleted by hand) must not stop the others
    for (const id of ids) if (await revit.deleteElements(m.sheetId, [id])) deleted++
  }
  writeMade(keep)
  await sleep(600)
  penOff()
  caption('', '')
  return { deleted }
}

// ─────────────── presenting live ───────────────

/** One click of the presenter's "Show more" button. */
export interface Step {
  id: string
  /** What the button says it will do next. */
  label: string
  run(): Promise<void>
}

/**
 * The demo as small steps for a presenter to click through at their own pace (no captions, no scripted pauses).
 * Each step waits for what it needs (the table to be in Revit before its type changes) and returns as soon as its own
 * action is done, so the talk goes on while Revit works and the timer counts.
 */
export function presenterSteps(spots: DemoSpots = SNOWDON_SPOTS): Step[] {
  const sheet = () => sheetByNumber(spots.sheet)
  const at = (f: Frac) => toSheet(sheet().id, f)
  const settle = () => waitLanded(120000).catch(() => undefined)
  const quietly = async (f: () => Promise<unknown>) => {
    quiet = true
    try {
      await f()
    } finally {
      penOff()
    }
  }
  return [
    { id: 'floors', label: 'Kickoff demo', run: () => quietly(() => beat('setup', { spots, fast: true })) },
    {
      id: 'sketch',
      label: 'Sketch a wall, a door and a table',
      run: () => quietly(async () => {
        // one stroke after the other, as a person would; Revit models each while the next is drawn
        await draw('wall', sheet().id, spots.wall.map(at), 1100)
        await draw('door', sheet().id, spots.door.map(at), 450)
        const [a, b] = spots.table.map(at)
        await draw('furniture', sheet().id, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a], 1300)
        session.setSetting('mode', 'auto')
        penOff()
        // then change the table's type: it must be a Revit element (drawn by Revit) first
        await settle()
        const [ta, tb] = spots.table
        await retype(sheet().id, [(ta[0] + tb[0]) / 2, (ta[1] + tb[1]) / 2], spots.retypeTo)
        session.setTool('brush')
      }),
    },
    {
      id: 'inspect',
      label: 'What is it?',
      run: () => quietly(async () => {
        await settle()
        // still zoomed into the room: click the facade wall along its north side; the card pins open with its
        // Revit parameters, and the selection is what lights up on the other floors next
        await look(sheet().id, spots.view.center, spots.view.width, 600)
        await selectElement(sheet().id, spots.everywhere.element, spots.view.center)
        // and open its card: the element panel, from the rail on the left
        await openPanel('element')
      }),
    },
    {
      id: 'everywhere',
      label: 'Every floor',
      run: () => quietly(() => fitAll()),
    },
    {
      id: 'back',
      label: 'Back to the room',
      run: () => quietly(async () => {
        await closePanel('element')
        await look(sheet().id, spots.view.center, spots.view.width, 1200)
        session.setTool('brush')
      }),
    },
    // if the presenter dragged the .rvt in by hand, this only zooms to the kitchen
    { id: 'nolicense', label: 'No Revit license?', run: () => quietly(() => openWithoutRevit()) },
    { id: 'kitchen', label: 'Sketch in the kitchen', run: () => quietly(() => sketchKitchen()) },
    { id: 'photo', label: "A colleague's sketch", run: () => quietly(() => sketchFromPhoto()) },
    { id: 'real', label: 'Make it real', run: () => quietly(() => makeSketchReal()) },
  ]
}

/** Leave presenting: captions come back for rehearsals. */
export function endPresenting() {
  quiet = false
  penOff()
}

/** `reset()` for the presenter's Start over. */
export const resetRehearsal = () => ensureClean()

export function createRehearsal() {
  return {
    run,
    beat,
    reset,
    /** Take back what earlier runs left and check the stage is empty (setup does this first). */
    ensureClean,
    leftovers: () => leftovers(SNOWDON_SPOTS),
    /** The no-licence beat on its own: drop the .rvt, then sketch in its kitchen. */
    openWithoutRevit,
    sketchKitchen,
    /** The colleague's-sketch beat: record the real import once (about a minute), then play it back on stage. */
    recordSketch,
    sketchFromPhoto,
    makeSketchReal,
    hasSketchRecording: () => !!readRecording(),
    caption,
    look,
    spots: SNOWDON_SPOTS,
    waitLanded,
    sheetId: (n: string) => sheetByNumber(n).id,
    /** The model's furniture families and sizes: a drawn rectangle becomes the one nearest its size. */
    furniture: () => getDocState().source?.palette?.furniture ?? [],
    /** The model's door types and widths: a drawn opening becomes the one nearest its width. */
    doors: () => getDocState().source?.palette?.doors ?? [],
  }
}

declare global {
  interface Window {
    __brushDemo?: ReturnType<typeof createRehearsal>
  }
}
