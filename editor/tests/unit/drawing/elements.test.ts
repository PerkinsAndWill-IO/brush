/**
 * What the element card shows: the picked element, a tag's target, readable labels.
 */
import { describe, expect, it } from 'vitest'
import { categoryOf, classLabel, paramLabel, resolveElement, type DrawingElement } from '@core/drawing'

const elements: Record<string, DrawingElement> = {
  '100': { class: 'Wall', category: 'Walls', name: 'Interior - Partition', type: 'Interior - Partition', level: 'Level 1', params: [{ name: 'Length', value: '4200' }] },
  '200': { class: 'RoomTag', category: 'Room Tags', tagged: 300 },
  '300': { class: 'Room', category: 'Rooms', name: 'Kitchen' },
  '400': { class: 'IndependentTag', tagged: 999 },
}

describe('element card', () => {
  it('an element resolves to itself', () => {
    expect(resolveElement(elements, '100')).toEqual({ id: '100', info: elements['100'], tagLabel: null, highlight: ['100'] })
  })

  it('a tag shows the element it labels and highlights both', () => {
    expect(resolveElement(elements, '200')).toEqual({ id: '300', info: elements['300'], tagLabel: 'Room tag', highlight: ['200', '300'] })
  })

  it('a tag of an element the table does not have, and an unknown id, stay themselves', () => {
    expect(resolveElement(elements, '400')).toEqual({ id: '400', info: elements['400'], tagLabel: null, highlight: ['400'] })
    expect(resolveElement(elements, '777')).toEqual({ id: '777', info: undefined, tagLabel: null, highlight: ['777'] })
  })

  it('the category line is the category, else the class in words, else "Element"', () => {
    expect(categoryOf(elements['100'])).toBe('Walls')
    expect(categoryOf({ class: 'LinearDimString' })).toBe('Linear dim string')
    expect(categoryOf(undefined)).toBe('Element')
  })

  it('class and parameter names read as words', () => {
    expect(classLabel('RoomTag')).toBe('Room tag')
    expect(paramLabel('WALL_ATTR_WIDTH_PARAM')).toBe('Wall attr width param')
    expect(paramLabel('Unconnected Height')).toBe('Unconnected Height')
  })
})
