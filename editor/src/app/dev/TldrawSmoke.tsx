/**
 * Library smoke test for tldraw 5.6.0 (spec risk table: "a smoke test per
 * library in M0"). Open /?smoke=tldraw. API per node_modules/tldraw/DOCS.md:
 * <Tldraw hideUi onMount={(editor) => ...} /> plus 'tldraw/tldraw.css'.
 */
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

declare global {
  interface Window {
    __tldrawSmoke?: { mounted: boolean; shapeCount: number }
  }
}

export default function TldrawSmoke() {
  const onMount = (editor: Editor) => {
    // StrictMode mounts twice on the same store; keep this idempotent.
    if (editor.getCurrentPageShapes().length === 0)
      editor.createShape({ type: 'geo', x: 100, y: 100, props: { w: 200, h: 120 } })
    window.__tldrawSmoke = { mounted: true, shapeCount: editor.getCurrentPageShapes().length }
  }
  return (
    <div style={{ position: 'fixed', inset: 0 }} data-testid="tldraw-smoke">
      <Tldraw hideUi onMount={onMount} />
    </div>
  )
}
