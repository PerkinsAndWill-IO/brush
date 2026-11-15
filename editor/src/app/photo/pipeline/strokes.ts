// Stage 3 (stroke mode): turn an ink mask into centreline strokes.
//   distance transform -> stroke width everywhere
//   thinning           -> one-pixel skeleton
//   skeleton graph     -> paths between end points and junctions, short spurs pruned
//   junctions          -> paths that run straight through are joined, so an X is two strokes, not four
//   fitting            -> smoothed, simplified polylines, one width per stroke
// Blobs far thicker than a pen stroke (marker fills) are handed back to be traced as filled outlines.

/** 3-4 chamfer distance to the nearest background pixel, in thirds of a pixel. The mask border must be clear. */
function chamfer(m: Uint8Array, w: number, h: number): Uint16Array {
  const d = new Uint16Array(w * h);
  for (let i = 0; i < d.length; i++) if (m[i]) d[i] = 65535;
  for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
    if (!d[i]) continue;
    const v = Math.min(d[i - 1] + 3, d[i - w] + 3, d[i - w - 1] + 4, d[i - w + 1] + 4);
    if (v < d[i]) d[i] = v;
  }
  for (let y = h - 2; y > 0; y--) for (let x = w - 2, i = y * w + w - 2; x > 0; x--, i--) {
    if (!d[i]) continue;
    const v = Math.min(d[i + 1] + 3, d[i + w] + 3, d[i + w + 1] + 4, d[i + w - 1] + 4);
    if (v < d[i]) d[i] = v;
  }
  return d;
}

/** Zhang-Suen thinning in place, visiting only foreground pixels. */
function thin(m: Uint8Array, w: number): number[] {
  let list: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) list.push(i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let sub = 0; sub < 2; sub++) {
      const del: number[] = [];
      for (const p of list) {
        const p2 = m[p - w], p3 = m[p - w + 1], p4 = m[p + 1], p5 = m[p + w + 1], p6 = m[p + w], p7 = m[p + w - 1], p8 = m[p - 1], p9 = m[p - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = +(!p2 && !!p3) + +(!p3 && !!p4) + +(!p4 && !!p5) + +(!p5 && !!p6) + +(!p6 && !!p7) + +(!p7 && !!p8) + +(!p8 && !!p9) + +(!p9 && !!p2);
        if (a !== 1) continue;
        if (sub === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        del.push(p);
      }
      if (del.length) {
        changed = true;
        for (const p of del) m[p] = 0;
        list = list.filter((p) => m[p]);
      }
    }
  }
  return list;
}

type Pt = [number, number];

function smoothPath(pts: Pt[], sigma: number, closed: boolean): Pt[] {
  const n = pts.length;
  if (n < 5 || sigma <= 0) return pts;
  const rad = Math.ceil(sigma * 3), k: number[] = [];
  for (let i = 0; i <= rad; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array<Pt>(n);
  for (let i = 0; i < n; i++) {
    const r = closed ? Math.min(rad, (n - 1) >> 1) : Math.min(rad, i, n - 1 - i); // open paths: ends stay put
    let x = 0, y = 0, s = 0;
    for (let j = -r; j <= r; j++) { const q = pts[(i + j + n) % n], wv = k[Math.abs(j)]; x += q[0] * wv; y += q[1] * wv; s += wv; }
    out[i] = [x / s, y / s];
  }
  return out;
}

function simplify(pts: Pt[], eps: number, closed: boolean): Pt[] {
  const n = pts.length;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  const stack: [number, number][] = [];
  if (closed) {
    let far = 1, fd = -1;
    for (let i = 1; i < n; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
    keep[0] = keep[far] = keep[n - 1] = 1;
    stack.push([0, far], [far, n - 1]);
  } else { keep[0] = keep[n - 1] = 1; stack.push([0, n - 1]); }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, len = Math.hypot(dx, dy) || 1e-9;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) { const d = len < 1e-6 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len; if (d > worst) { worst = d; wi = i; } }
    if (worst > eps) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

interface SkelPath { px: number[]; a: number; b: number; dot?: boolean; loop?: boolean; dead?: boolean }

/** One pen stroke: its centreline and pen width, in output units (sheet points). */
export interface TracedStroke {
  /** Smoothed, simplified centreline. A closed stroke does not repeat its first point. */
  points: Pt[]
  width: number
  closed: boolean
}

/**
 * @param mask ink mask (0/1), w x h
 * @param pxToPt output units per pixel
 * @param opts.maxStrokePx blobs thicker than this are fills, not strokes
 * @returns the strokes, and the mask of what was too thick to be a stroke (null if nothing was)
 */
export function centrelines(maskIn: Uint8Array, w: number, h: number, pxToPt: number, { scale = 1, maxStrokePx = Math.max(w, h) * 0.01 }: { scale?: number; maxStrokePx?: number } = {}): { strokes: TracedStroke[]; fillMask: Uint8Array | null } {
  const N = w * h, m = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) if (maskIn[i]) m[i] = 1;
  const dist = chamfer(m, w, h);

  // split off blobs that are too thick to be a stroke
  let fillMask: Uint8Array | null = null;
  {
    const seen = new Uint8Array(N), stack: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!m[s0] || seen[s0]) continue;
      const comp: number[] = [];
      let maxD = 0;
      stack.push(s0); seen[s0] = 1;
      while (stack.length) {
        const p = stack.pop()!; comp.push(p); if (dist[p] > maxD) maxD = dist[p];
        for (const o of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) { const q = p + o; if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      }
      if ((maxD * 2) / 3 > maxStrokePx) { fillMask ??= new Uint8Array(N); for (const p of comp) { fillMask[p] = 1; m[p] = 0; } }
    }
  }

  const skel = thin(m, w);
  // skeleton adjacency: 4-neighbours, plus a diagonal only where no 4-connected route makes it redundant
  const DIAG = [[-w + 1, -w, 1], [w + 1, 1, w], [w - 1, w, -1], [-w - 1, -1, -w]];
  const nb = (p: number, out: Int32Array): number => {
    let n = 0;
    if (m[p - w]) out[n++] = p - w; if (m[p + 1]) out[n++] = p + 1; if (m[p + w]) out[n++] = p + w; if (m[p - 1]) out[n++] = p - 1;
    for (const [o, a, b] of DIAG) if (m[p + o] && !m[p + a] && !m[p + b]) out[n++] = p + o;
    return n;
  };
  const deg = new Uint8Array(N), buf = new Int32Array(8), tmp = new Int32Array(8);
  for (const p of skel) deg[p] = nb(p, buf) || 9; // 9 = isolated pixel
  // nodes: end points, isolated pixels, and clusters of adjacent junction pixels
  const nodeOf = new Map<number, number>(), nodeDeg: number[] = [];
  for (const p of skel) {
    if (deg[p] === 2 || nodeOf.has(p)) continue;
    const id = nodeDeg.length; nodeDeg.push(0); nodeOf.set(p, id);
    if (deg[p] < 3 || deg[p] === 9) continue;
    const st = [p];
    while (st.length) { const q = st.pop()!, n = nb(q, tmp); for (let k = 0; k < n; k++) { const r = tmp[k]; if (deg[r] >= 3 && deg[r] !== 9 && !nodeOf.has(r)) { nodeOf.set(r, id); st.push(r); } } }
  }
  // paths
  const visited = new Uint8Array(N), paths: SkelPath[] = [];
  for (const [p, id] of nodeOf) {
    if (deg[p] === 9) { paths.push({ px: [p], a: id, b: id, dot: true }); continue; }
    const n = nb(p, buf), first = Array.from(buf.subarray(0, n));
    for (const q0 of first) {
      if (deg[q0] !== 2) { const j = nodeOf.get(q0)!; if (j !== id && p < q0) paths.push({ px: [p, q0], a: id, b: j }); continue; }
      if (visited[q0]) continue;
      const px = [p, q0];
      let prev = p, cur = q0;
      while (deg[cur] === 2) { visited[cur] = 1; nb(cur, tmp); const next = tmp[0] === prev ? tmp[1] : tmp[0]; px.push(next); prev = cur; cur = next; }
      paths.push({ px, a: id, b: nodeOf.get(cur)! });
    }
  }
  for (const p of skel) { // closed loops with no node on them
    if (deg[p] !== 2 || visited[p]) continue;
    const px = [p];
    let prev = -1, cur = p;
    do { visited[cur] = 1; nb(cur, tmp); const next = tmp[0] === prev || visited[tmp[0]] ? tmp[1] : tmp[0]; prev = cur; cur = next; if (cur !== p && !visited[cur]) px.push(cur); } while (cur !== p && !visited[cur]);
    paths.push({ px, a: -1, b: -1, loop: true });
  }
  for (const pt of paths) if (!pt.loop && !pt.dot) { nodeDeg[pt.a]++; nodeDeg[pt.b]++; }
  const widthOf = (px: number[]): number => { const v = px.map((p) => dist[p]).sort((a, b) => a - b); return Math.max(1, (2 * v[v.length >> 1]) / 3); };
  // prune spurs: short side branches left by thinning at corners and bumps
  for (const pt of paths) {
    if (pt.loop || pt.dot || pt.a === pt.b) continue;
    const endA = nodeDeg[pt.a] === 1, endB = nodeDeg[pt.b] === 1;
    if (endA === endB) continue;
    const jp = endA ? pt.px[pt.px.length - 1] : pt.px[0];
    if (pt.px.length < Math.max(4, ((2 * dist[jp]) / 3) * 1.3)) { pt.dead = true; nodeDeg[pt.a]--; nodeDeg[pt.b]--; }
  }
  const live = paths.filter((p) => !p.dead);

  // join paths that run straight through a junction
  const X = (p: number): number => p % w, Y = (p: number): number => (p - (p % w)) / w;
  const ends = new Map<number, { i: number; side: number; dx: number; dy: number }[]>(); // node id -> [{path index, side, dx, dy}]
  live.forEach((pt, i) => {
    if (pt.loop || pt.dot) return;
    const L = Math.min(pt.px.length - 1, Math.max(5, Math.round(widthOf(pt.px) * 1.5)));
    for (const side of [0, 1]) {
      const e = side ? pt.px[pt.px.length - 1] : pt.px[0], inner = side ? pt.px[pt.px.length - 1 - L] : pt.px[L];
      const dx = X(inner) - X(e), dy = Y(inner) - Y(e), dl = Math.hypot(dx, dy) || 1, id = side ? pt.b : pt.a;
      if (!ends.has(id)) ends.set(id, []);
      ends.get(id)!.push({ i, side, dx: dx / dl, dy: dy / dl });
    }
  });
  const link = new Int32Array(live.length * 2).fill(-1);
  for (const list of ends.values()) {
    if (list.length < 2) continue;
    const cand: [number, number, number][] = [];
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      if (list[a].i === list[b].i) continue;
      const dot = -(list[a].dx * list[b].dx + list[a].dy * list[b].dy); // 1 = perfectly straight through
      cand.push([Math.acos(Math.max(-1, Math.min(1, dot))) * 57.2958, a, b]);
    }
    cand.sort((p, q) => p[0] - q[0]);
    const used = new Uint8Array(list.length);
    for (const [ang, a, b] of cand) {
      if (used[a] || used[b] || (ang > 40 && list.length !== 2)) continue;
      used[a] = used[b] = 1;
      const ea = list[a].i * 2 + list[a].side, eb = list[b].i * 2 + list[b].side;
      link[ea] = eb; link[eb] = ea;
    }
  }
  const done = new Uint8Array(live.length), strokes: TracedStroke[] = [];
  const sm = 1.5 * scale, eps = 0.6 * scale;
  for (let i = 0; i < live.length; i++) {
    if (done[i]) continue;
    done[i] = 1;
    let chain = live[i].px.slice(), closed = !!live[i].loop;
    if (!live[i].loop && !live[i].dot) {
      let e = i * 2 + 1; // grow from the far end
      while (link[e] >= 0) {
        const ne = link[e], j = ne >> 1;
        if (j === i) { closed = true; break; }
        if (done[j]) break;
        done[j] = 1;
        chain = chain.concat(ne & 1 ? live[j].px.slice().reverse() : live[j].px);
        e = ne ^ 1;
      }
      if (!closed) {
        e = i * 2; // and from the near end
        while (link[e] >= 0) {
          const ne = link[e], j = ne >> 1;
          if (done[j]) break;
          done[j] = 1;
          chain = (ne & 1 ? live[j].px : live[j].px.slice().reverse()).concat(chain);
          e = ne ^ 1;
        }
      }
    }
    const width = widthOf(chain);
    let pts = chain.map((p): Pt => [X(p) + 0.5, Y(p) + 0.5]).filter((p, k, arr) => k === 0 || p[0] !== arr[k - 1][0] || p[1] !== arr[k - 1][1]);
    if (closed && pts.length < 8) closed = false;
    pts = simplify(smoothPath(pts, sm, closed), eps, closed);
    strokes.push({ points: pts.map(([x, y]): Pt => [x * pxToPt, y * pxToPt]), width: width * pxToPt, closed });
  }
  return { strokes, fillMask };
}
