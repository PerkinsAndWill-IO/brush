/** S1 select and change type (docs/tasks/S1-select-and-retype.md): the pure parts and the one-step history. */
import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Command, Stroke } from '@core/types'
import type { DrawingElement } from '@core/drawing'
import { DEFAULT_PALETTE, ptPerMetre } from '@core/context'
import { StrokeHistory } from '../../src/app/board/history'
import { documentTypes, drawnAt, mergeOptions, paletteOptions, sheetElementType, typeLabel, withType } from '../../src/app/select/types'
import { parseCommandFile } from '../../src/app/source/command-file'

const dec = (strokeId: string, kind: AcceptedDecision['kind'], points: { x: number; y: number }[], closed = false, type?: string): AcceptedDecision => ({
  strokeId,
  sheetId: 'A',
  kind,
  geometry: { points, closed },
  confidence: 0.8,
  committedAt: 0,
  ...(type ? { type } : {}),
})
const stroke = (id: string, points: { x: number; y: number }[], tool: Stroke['tool'] = 'brush'): Stroke => ({ id, sheetId: 'A', points: points.map((p, i) => ({ ...p, t: i })), tool, size: 2 })
const wallCmd = (id: string, strokeId: string): Command => ({ op: 'create_wall', id, sheetId: 'A', path: { points: [], closed: false }, strokeId })

describe('S1 type options', () => {
  const elements: Record<string, DrawingElement> = {
    w1: { category: 'Walls', type: 'Generic - 200mm' },
    w2: { category: 'Walls', type: 'Exterior - 300mm' },
    w3: { category: 'Walls', type: 'Generic - 200mm' },
    d1: { category: 'Doors', family: 'Single-Flush', type: '0900 x 2100mm' },
    d2: { category: 'Doors', family: 'Single-Flush', type: 'Single-Flush 0800 x 2100mm' },
    tag: { category: 'Walls', type: 'Tag type', tagged: 1 },
  }

  it('S1-03: a category offers every type its elements use in the document, once each, sorted', () => {
    expect(documentTypes([elements, elements], 'Walls').map((o) => o.label)).toEqual(['Exterior - 300mm', 'Generic - 200mm'])
  })

  it('S1-03: door types are named "Family Type" as the palette names them, unless the type already says the family', () => {
    expect(documentTypes([elements], 'Doors')).toEqual([
      { label: 'Single-Flush 0800 x 2100mm', typeName: 'Single-Flush 0800 x 2100mm', family: 'Single-Flush' },
      { label: 'Single-Flush 0900 x 2100mm', typeName: '0900 x 2100mm', family: 'Single-Flush' },
    ])
    expect(typeLabel(undefined, 'A')).toBe('A')
  })

  it('S1-03: a pending set_type is the element type now', () => {
    const cmds: Command[] = [{ op: 'set_type', id: 'cmd-0001', sheetId: 'A', targets: ['w1'], typeName: 'Exterior - 300mm', strokeId: 'type:w1' }]
    expect(sheetElementType('w1', elements.w1, cmds)?.label).toBe('Exterior - 300mm')
    expect(sheetElementType('w3', elements.w3, cmds)?.label).toBe('Generic - 200mm')
  })

  it('S1-02: drawn elements are offered the palette types of their kind; merged lists keep one row per label', () => {
    expect(paletteOptions(DEFAULT_PALETTE, 'wall').map((o) => o.label)).toEqual(DEFAULT_PALETTE.walls.map((w) => w.name))
    expect(paletteOptions(DEFAULT_PALETTE, 'markup')).toEqual([])
    expect(mergeOptions([{ label: 'a', typeName: 'a' }], [{ label: 'a', typeName: 'x' }, { label: 'b', typeName: 'b' }])).toEqual([
      { label: 'a', typeName: 'a' },
      { label: 'b', typeName: 'b' },
    ])
  })

  it('S1-04: set_type is a known op of the command file', () => {
    const text = JSON.stringify({ schemaVersion: 1, kind: 'brush-commands', source: { name: 'x', kind: 'package' }, sheets: [], commands: [{ op: 'set_type', id: 'c', sheetId: 'A', targets: ['1'], typeName: 'T', strokeId: 'type:1' }] })
    expect(parseCommandFile(text).commands[0].op).toBe('set_type')
  })
})

describe('S1 a drawn element given another type', () => {
  const ptPerM = ptPerMetre(100)

  it('S1-02: a furniture box takes the new family size about its centre, keeping its orientation', () => {
    const d = dec('s1', 'furniture', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }], true, 'Desk 1600x800')
    const r = withType(d, 'Chair 500x500', DEFAULT_PALETTE, ptPerM)
    const side = 0.5 * ptPerM
    expect(r.type).toBe('Chair 500x500')
    expect(r.geometry.points[0].x).toBeCloseTo(20 - side / 2)
    expect(r.geometry.points[1].x - r.geometry.points[0].x).toBeCloseTo(side)
    expect(r.geometry.points[2].y - r.geometry.points[1].y).toBeCloseTo(side)
    expect(d.geometry.points[1].x).toBe(40) // the decision itself is not changed
  })

  it('S1-02: a door takes the new width about its middle; a wall keeps its centre line; no scale, no resize', () => {
    const door = withType(dec('s2', 'door', [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'Double-Flush 1800x2100', DEFAULT_PALETTE, ptPerM)
    expect(door.geometry.points[1].x - door.geometry.points[0].x).toBeCloseTo(1.8 * ptPerM)
    expect((door.geometry.points[0].x + door.geometry.points[1].x) / 2).toBeCloseTo(5)
    const wall = dec('s3', 'wall', [{ x: 0, y: 0 }, { x: 100, y: 0 }], false, 'Generic - 200mm')
    expect(withType(wall, 'Exterior - 300mm', DEFAULT_PALETTE, ptPerM).geometry).toEqual(wall.geometry)
    expect(withType(dec('s4', 'door', [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'Double-Flush 1800x2100', DEFAULT_PALETTE).geometry.points[1].x).toBe(10)
  })
})

describe('S1 hit test for drawn elements', () => {
  const accepted = [
    dec('wall', 'wall', [{ x: 0, y: 100 }, { x: 200, y: 100 }]),
    dec('desk', 'furniture', [{ x: 300, y: 300 }, { x: 340, y: 300 }, { x: 340, y: 320 }, { x: 300, y: 320 }], true),
    dec('del', 'delete', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], true),
  ]
  const strokes = [
    stroke('wall', [{ x: 0, y: 103 }, { x: 200, y: 103 }]),
    stroke('desk', [{ x: 300, y: 300 }, { x: 340, y: 320 }]),
    stroke('note', [{ x: 500, y: 500 }, { x: 520, y: 520 }]),
    stroke('del', [{ x: 10, y: 10 }, { x: 40, y: 40 }], 'eraser'),
  ]
  const input = { sheetId: 'A', accepted, strokes, hidden: new Set<string>(), wallHalf: () => 3 }

  it('S1-01: picks a wall by its body, furniture inside its box, plain markup by its ink', () => {
    expect(drawnAt({ x: 80, y: 104 }, 1, input)).toBe('wall')
    expect(drawnAt({ x: 335, y: 302 }, 1, input)).toBe('desk')
    expect(drawnAt({ x: 510, y: 510 }, 1, input)).toBe('note')
    expect(drawnAt({ x: 800, y: 800 }, 1, input)).toBeNull()
  })

  it('S1-01: deletes, eraser passes, other sheets and strokes landed in the model are not selectable', () => {
    expect(drawnAt({ x: 25, y: 25 }, 2, input)).toBeNull()
    expect(drawnAt({ x: 80, y: 104 }, 1, { ...input, sheetId: 'B' })).toBeNull()
    expect(drawnAt({ x: 80, y: 104 }, 1, { ...input, hidden: new Set(['wall']) })).toBeNull()
  })
})

describe('S1 history: replace is one undo step', () => {
  it('S1-05: replace swaps decisions and commands; undo puts them back where they were; redo again', () => {
    const a = dec('a', 'wall', [{ x: 0, y: 0 }, { x: 1, y: 0 }])
    const b = dec('b', 'wall', [{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const ca = wallCmd('cmd-0001', 'a')
    const cb = wallCmd('cmd-0002', 'b')
    const h = new StrokeHistory([], [a, b], [ca, cb])
    const a2 = { ...a, kind: 'door' as const }
    const ca2: Command = { op: 'place_door', id: 'cmd-0003', sheetId: 'A', at: { x: 0, y: 0 }, widthPt: 1, angleRad: 0, strokeId: 'a' }
    const st: Command = { op: 'set_type', id: 'cmd-0004', sheetId: 'A', targets: ['9'], typeName: 'T', strokeId: 'type:9' }
    h.replace([
      { before: { decision: a, command: ca }, after: { decision: a2, command: ca2 } },
      { before: {}, after: { command: st } },
    ])
    expect(h.accepted()).toEqual([b, a2])
    expect(h.commands()).toEqual([cb, ca2, st])
    expect(h.undo()).toBe(true)
    expect(h.accepted()).toEqual([a, b])
    expect(h.commands()).toEqual([ca, cb])
    expect(h.redo()).toBe(true)
    expect(h.commands()).toEqual([cb, ca2, st])
  })

  it('S1-02: back to markup drops the element and its command; nothing to change records no step', () => {
    const a = dec('a', 'wall', [{ x: 0, y: 0 }, { x: 1, y: 0 }])
    const ca = wallCmd('cmd-0001', 'a')
    const h = new StrokeHistory([], [a], [ca])
    h.replace([{ before: {}, after: {} }])
    expect(h.canUndo()).toBe(false)
    h.replace([{ before: { decision: a, command: ca }, after: {} }])
    expect(h.accepted()).toEqual([])
    expect(h.commands()).toEqual([])
    h.undo()
    expect(h.accepted()).toEqual([a])
  })
})
