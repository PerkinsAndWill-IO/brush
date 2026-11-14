/**
 * In-app performance marks (spec: "Latency is measured inside the app with
 * performance.now() marks around the real code path").
 *  - inkLatencyMs: pointer event timeStamp → the animation frame in which the
 *    ink for that event is written to the DOM (painted in that frame).
 *  - fps: one sample per camera gesture (pan/zoom), frames / elapsed seconds.
 */
import type { Metrics } from '@core/types'

const MAX = 5000
export const metrics: Metrics = { inkLatencyMs: [], firstHypothesisMs: [], fps: [] }

export function pushMetric(key: keyof Metrics, v: number) {
  const arr = metrics[key]
  arr.push(v)
  if (arr.length > MAX) arr.splice(0, arr.length - MAX)
}

export function resetMetrics() {
  metrics.inkLatencyMs.length = 0
  metrics.firstHypothesisMs.length = 0
  metrics.fps.length = 0
}

/** Counts frames while the camera moves; records one fps sample per gesture (>= 10 frames). */
export class FrameMeter {
  private raf = 0
  private frames = 0
  private t0 = 0
  private last = 0

  start() {
    if (this.raf) return
    this.frames = 0
    this.t0 = 0
    const tick = (t: number) => {
      if (this.t0 === 0) this.t0 = t
      else this.frames++
      this.last = t
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop() {
    if (!this.raf) return
    cancelAnimationFrame(this.raf)
    this.raf = 0
    const secs = (this.last - this.t0) / 1000
    if (this.frames >= 10 && secs > 0) pushMetric('fps', this.frames / secs)
  }
}
