/**
 * Camera store, kept outside React: the board applies it to the DOM directly
 * every frame; React components that show the zoom subscribe to it.
 * "settled" fires once the camera has been still for SETTLE_MS (M1-05 re-render).
 */
import { useSyncExternalStore } from 'react'
import type { Camera } from './board/layout'

export const SETTLE_MS = 180

let camera: Camera = { x: 0, y: 0, z: 1 }
let moving = false
let settleTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const settleListeners = new Set<(c: Camera) => void>()
const moveListeners = new Set<(moving: boolean) => void>()

export const getCamera = (): Camera => camera

export function setCamera(next: Camera, opts: { settleNow?: boolean } = {}) {
  if (next.x === camera.x && next.y === camera.y && next.z === camera.z) return
  camera = next
  listeners.forEach((l) => l())
  if (!moving) {
    moving = true
    moveListeners.forEach((l) => l(true))
  }
  if (settleTimer) clearTimeout(settleTimer)
  if (opts.settleNow) settle()
  else settleTimer = setTimeout(settle, SETTLE_MS)
}

function settle() {
  settleTimer = null
  moving = false
  moveListeners.forEach((l) => l(false))
  settleListeners.forEach((l) => l(camera))
}

export const isCameraMoving = () => moving

export function subscribeCamera(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function onCameraSettled(l: (c: Camera) => void): () => void {
  settleListeners.add(l)
  return () => settleListeners.delete(l)
}
export function onCameraMoving(l: (moving: boolean) => void): () => void {
  moveListeners.add(l)
  return () => moveListeners.delete(l)
}

export function useCameraZoom(): number {
  return useSyncExternalStore(subscribeCamera, () => camera.z)
}
