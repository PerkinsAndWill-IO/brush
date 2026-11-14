// View transform and 2D geometry helpers. No DOM.
// World = paper feet, y up. Screen = CSS pixels, y down.
// screen.x = world.x * scale + tx ; screen.y = ty - world.y * scale

export interface View {
  scale: number; // CSS px per paper foot
  tx: number;
  ty: number;
}

export interface Bounds {
  min: [number, number];
  max: [number, number];
}

/** A CSS inch is 96 px and a paper foot is 12 inches, so 1:1 is 1152 px per foot. */
export const ACTUAL_SIZE_SCALE = 96 * 12;

export function toWorld(v: View, sx: number, sy: number): [number, number] {
  return [(sx - v.tx) / v.scale, (v.ty - sy) / v.scale];
}

export function toScreen(v: View, wx: number, wy: number): [number, number] {
  return [wx * v.scale + v.tx, v.ty - wy * v.scale];
}

/** Largest view that shows the whole rectangle, centred in a viewW x viewH box with a margin in px. */
export function fitView(b: Bounds, viewW: number, viewH: number, margin = 24): View {
  const w = b.max[0] - b.min[0];
  const h = b.max[1] - b.min[1];
  const scale = Math.max(1e-6, Math.min((viewW - 2 * margin) / w, (viewH - 2 * margin) / h));
  const tx = (viewW - w * scale) / 2 - b.min[0] * scale;
  const ty = (viewH + h * scale) / 2 + b.min[1] * scale;
  return { scale, tx, ty };
}

/** Multiplies the scale by factor while keeping the world point under (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number, minScale = 1, maxScale = 1e6): View {
  const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
  const k = scale / v.scale;
  return { scale, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { scale: v.scale, tx: v.tx + dx, ty: v.ty + dy };
}

/** Squared distance from point p to segment a-b. */
export function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Even-odd containment over any number of rings (flat x,y arrays, implicitly closed). */
export function pointInRingsEvenOdd(px: number, py: number, rings: ArrayLike<number>[]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i], yi = ring[2 * i + 1];
      const xj = ring[2 * j], yj = ring[2 * j + 1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
