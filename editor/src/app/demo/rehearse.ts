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
import type { BrushMode, Point } from '@core/types'
import { boardView, getViewportEl } from '../board/Board'
import { sheetToScreen } from '../board/layout'
import { getCamera, setCamera } from '../camera'
import { getSession, session } from '../session'
import { contextFor } from '../brain/contextStore'
import { getDocState } from '../store'
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

/** Show a caption: the beat's name and what is being said or done. Empty text hides it. */
export function caption(beat: string, text = '') {
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
async function stroke(sheetId: string, path: Point[], ms: number) {
  const vp = getViewportEl()
  if (!vp) throw new Error('demo: no board on screen')
  const { sheet } = placement(sheetId)
  const pts = sample(path, Math.max(sheet.sizePt.w, sheet.sizePt.h) / 600, Math.max(sheet.sizePt.w, sheet.sizePt.h) / 3000)
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
  await stroke(sheetId, path, ms)
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

/** Hover a point with the select tool, so the inspector shows what is under it. */
async function hover(sheetId: string, f: Frac, ms = 900) {
  const vp = getViewportEl()
  if (!vp) return
  session.setTool('select')
  await glide(toScreen(sheetId, toSheet(sheetId, f)), ms)
  // the inspector opening reflows the page and moves the board under a still pointer: aim again until it holds
  for (let i = 0; i < 4; i++) {
    const to = toScreen(sheetId, toSheet(sheetId, f))
    penAt(to.x, to.y, false)
    vp.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: to.x, clientY: to.y, pointerType: 'mouse', pointerId: 1, isPrimary: true }))
    await frame()
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
const inspected = () => document.querySelector<HTMLElement>('[data-testid="inspect-panel"]')?.dataset.element || undefined

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
async function selectElement(sheetId: string, elementId: string) {
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
  const mid = along(0.5)
  await look(sheetId, [mid.x / sheet.sizePt.w, mid.y / sheet.sizePt.h], 0.3, 1100)
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
    const p = along(t)
    const at = toScreen(sheetId, p)
    await glide(at, 250)
    pointer('pointermove', at)
    await frame()
    await frame()
    if (inspected() !== elementId) continue
    // the card opening may move the board: aim again, then click
    const again = toScreen(sheetId, p)
    penAt(again.x, again.y, true)
    pointer('pointermove', again)
    await frame()
    pointer('pointerdown', again, 1)
    pointer('pointerup', again)
    await frame()
    penAt(again.x, again.y, false)
    return
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
  everywhere: 'Select a wall of the building on one floor: Brush lights it up on every sheet it is on.',
  wall: 'Sketch a wall…',
  door: '…a door in it…',
  table: '…and a table.',
  back: 'Each one is now a real Revit element, and the sheet came back drawn by Revit.',
  retype: 'Not the table I wanted. Right-click it and pick another type: Revit lists every one it has.',
  retyped: 'Swapped in Revit, and redrawn.',
  inspect: 'Hover the wall you just sketched: it is a real Revit wall now, with its type and level.',
  close: 'Brush. Sketch it, and it is built.',
}

type Beat = 'hook' | 'setup' | 'loop' | 'retype' | 'inspect' | 'close'
export const BEATS: readonly Beat[] = ['hook', 'setup', 'loop', 'retype', 'inspect', 'close']

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
      await hover(s.id, spots.inspect)
      await talk(6000)
      if (spots.alsoOpen.length && revitSnapshot().open.length > 1) {
        caption('3:15 · It reads the building', SAY.everywhere)
        await selectElement(s.id, spots.everywhere.element)
        penOff()
        await talk(1200)
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

export function createRehearsal() {
  return {
    run,
    beat,
    reset,
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
