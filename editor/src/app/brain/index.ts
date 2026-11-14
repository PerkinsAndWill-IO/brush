/**
 * Wires M2 (context, snapping) and M3 (streaming prediction) into the board:
 * the BrushEngine and the per-sheet overlays, bottom to top.
 */
import { registerSheetOverlay } from '../board/SheetView'
import { ContextOverlay, ElementsOverlay, LiveOverlay } from './overlays'
import { installPredictEngine } from './predictEngine'

let done = false
export function installBrain() {
  if (done) return
  done = true
  registerSheetOverlay(ContextOverlay)
  registerSheetOverlay(ElementsOverlay)
  registerSheetOverlay(LiveOverlay)
  installPredictEngine()
}
