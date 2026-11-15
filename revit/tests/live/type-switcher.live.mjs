// S1-06, S1-07: list_types and set_type inside Revit, over the link socket. Runs only with BRUSH_LIVE=1.
//
//   BRUSH_LIVE=1 node revit/tests/live/type-switcher.live.mjs [sheetNumber]
//
// Touches only what it creates: one short wall on a plan sheet, deleted again at the end (also when a step fails).
// Steps: create the wall → list_types → set_type → list_types shows it → revert → current is back →
// delete the wall → list_types says unknown_element.
// Do not sync the model with central while it runs.

if (process.env.BRUSH_LIVE !== '1') {
  console.log('skipped: set BRUSH_LIVE=1 to run against the Revit open on this machine')
  process.exit(0)
}

const URL = process.env.BRUSH_LINK_URL ?? 'ws://127.0.0.1:47821/link'
const SHEET_NUMBER = process.argv[2] ?? '0013'
const TIMEOUT_MS = 180_000

const ws = new WebSocket(URL)
const inbox = []
let waiter = null
ws.onmessage = (e) => {
  inbox.push(JSON.parse(e.data))
  waiter?.()
}
await new Promise((ok, fail) => {
  ws.onopen = ok
  ws.onerror = () => fail(new Error(`cannot reach ${URL}`))
})

let seq = 0
const send = (m) => {
  const requestId = `live-${++seq}`
  ws.send(JSON.stringify({ ...m, requestId }))
  return requestId
}
/** Next message of `type` (answering `requestId`, when given); an `error` for that request rejects. */
async function expect(type, requestId) {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const i = inbox.findIndex((m) => (m.type === type || (requestId && m.type === 'error')) && (!requestId || m.requestId === requestId))
    if (i >= 0) {
      const m = inbox.splice(i, 1)[0]
      if (m.type === 'error' && type !== 'error') throw new Error(`${m.code}: ${m.message}`)
      return m
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`)
    await new Promise((r) => {
      waiter = r
      setTimeout(r, 500)
    })
  }
}

const steps = []
const ok = (name, detail = '') => {
  steps.push(name)
  console.log(`  ok  ${name}${detail ? `: ${detail}` : ''}`)
}
const check = (cond, what) => {
  if (!cond) throw new Error(`check failed: ${what}`)
}

send({ type: 'hello', protocol: 1, client: 'type-switcher.live' })
const welcome = await expect('welcome')
console.log(`Revit: ${welcome.server.host}, model "${welcome.document.title}", ${welcome.sheets.length} sheets`)
const sheet = welcome.sheets.find((s) => s.number === SHEET_NUMBER) ?? welcome.sheets.find((s) => /PLN/.test(s.name))
check(sheet, `a plan sheet (${SHEET_NUMBER})`)

// where to draw: next to an existing wall on that sheet (inside its plan viewport); then stop the sheet pushes
let r = send({ type: 'open_sheet', sheetId: sheet.id })
const opened = await expect('sheet', r)
send({ type: 'close_sheet', sheetId: sheet.id })
const walls = opened.package.sheets[0].elements.filter((e) => e.category === 'Walls' && e.footprint?.length)
check(walls.length, 'the sheet shows walls')
const p = walls[Math.floor(walls.length / 2)].footprint[0]
const a = { x: p.x + 20, y: p.y + 20 }
const b = { x: a.x + 30, y: a.y }
ok('picked a spot', `sheet points (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`)

let wallId = null
try {
  r = send({ type: 'apply', sheetId: sheet.id, commands: [{ op: 'create_wall', id: 'live-wall-1', sheetId: sheet.id, strokeId: 'live', path: { points: [a, b], closed: false } }] })
  const made = await expect('applied', r)
  check(made.results[0].status === 'applied', `wall created (${made.results[0].message ?? made.results[0].status})`)
  wallId = made.results[0].elementIds[0]
  ok('created the test wall', wallId)

  r = send({ type: 'list_types', elementId: wallId })
  const t0 = await expect('types', r)
  check(t0.current && t0.types.length >= 2, 'at least two types')
  const other = t0.types.find((t) => t.typeId !== t0.current.typeId && t.family === t0.current.family) ?? t0.types.find((t) => t.typeId !== t0.current.typeId)
  ok('list_types', `${t0.types.length} types, current "${t0.current.family}: ${t0.current.typeName}", switching to "${other.typeName}"`)

  r = send({ type: 'apply', sheetId: sheet.id, commands: [{ op: 'set_type', id: 'live-ct-1', sheetId: sheet.id, targets: [wallId], typeName: other.typeName, family: other.family ?? undefined, strokeId: `type:${wallId}` }] })
  const c1 = await expect('applied', r)
  check(c1.results[0].status === 'applied', `set_type applied (${c1.results[0].message ?? ''})`)
  r = send({ type: 'list_types', elementId: wallId })
  check((await expect('types', r)).current.typeId === other.typeId, 'current is the new type')
  ok('set_type on the plan sheet')

  r = send({ type: 'revert', sheetId: sheet.id, commandIds: ['live-ct-1'] })
  const rv1 = await expect('reverted', r)
  check(rv1.results[0].status === 'applied', `revert applied (${JSON.stringify(rv1.results[0])})`)
  r = send({ type: 'list_types', elementId: wallId })
  check((await expect('types', r)).current.typeId === t0.current.typeId, 'current is the old type again')
  ok('revert restores the previous type')
} catch (e) {
  console.log(`  FAIL ${e.message}`)
  process.exitCode = 1
} finally {
  if (wallId) {
    const rr = send({ type: 'revert', sheetId: sheet.id, commandIds: ['live-wall-1'] })
    const gone = await expect('reverted', rr)
    const rl = send({ type: 'list_types', elementId: wallId })
    const after = await expect('error', rl).catch(() => null)
    const deleted = gone.results[0].status === 'applied' && after?.code === 'unknown_element'
    console.log(`  ${deleted ? 'ok ' : 'FAIL'} test wall ${wallId} deleted`)
    if (!deleted) process.exitCode = 1
  }
  ws.close()
}
console.log(process.exitCode ? 'type switcher live run: FAILED' : `type switcher live run: all ${steps.length + 1} steps ok`)
