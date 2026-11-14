// Canvas drawing of a scene. Strokes are batched into Path2D objects once per scene;
// a redraw is then one stroke() call per style, whatever the number of segments.
import { toScreen, type View } from "./geom";
import type { HitIndex } from "./hit";
import type { Coords, Item, Scene } from "./scene";
import { boxCorners, type TextLayout } from "./text";

type Cmd =
  | { k: "stroke"; path: Path2D; w: number; css: string; dash: number[]; points: number }
  | { k: "fill"; path: Path2D; css: string }
  | { k: "text"; item: number }
  | { k: "image"; item: number };

export const ACCENT = "#e8590c";
const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Points per stroke batch. Chrome's GPU canvas silently draws nothing for one Path2D of millions of points. */
const BATCH_POINTS = 100_000;

function addStroke(path: Path2D, it: Item): void {
  if (it.t === "path") {
    const xy = it.xy;
    if (xy.length < 4) return;
    path.moveTo(xy[0], xy[1]);
    for (let k = 2; k < xy.length; k += 2) path.lineTo(xy[k], xy[k + 1]);
    if (it.closed) path.closePath();
  } else if (it.t === "segs") {
    const xy = it.xy;
    for (let k = 0; k < xy.length; k += 4) {
      path.moveTo(xy[k], xy[k + 1]);
      path.lineTo(xy[k + 2], xy[k + 3]);
    }
  }
}

function ringsPath(rings: Coords[]): Path2D {
  const path = new Path2D();
  for (const r of rings) {
    if (r.length < 4) continue;
    path.moveTo(r[0], r[1]);
    for (let k = 2; k < r.length; k += 2) path.lineTo(r[k], r[k + 1]);
    path.closePath();
  }
  return path;
}

export class Renderer {
  private cmds: Cmd[] = [];
  private images = new Map<number, ImageBitmap>();
  private highlightPaths = new Map<number, Path2D>();
  private scene!: Scene;
  private index!: HitIndex;
  /** Called when an image finishes decoding so the owner can redraw. */
  onImageReady: () => void = () => {};

  setScene(scene: Scene, index: HitIndex): void {
    this.scene = scene;
    this.index = index;
    this.images.clear();
    this.highlightPaths.clear();
    const cmds: Cmd[] = [];
    // Consecutive stroke items are merged per style; any other item ends the run, so draw order across kinds is kept.
    let run = new Map<string, Cmd & { k: "stroke" }>();
    const flush = () => {
      for (const c of run.values()) cmds.push(c);
      run = new Map();
    };
    scene.items.forEach((it, i) => {
      if (it.t === "path" || it.t === "segs") {
        const key = `${it.w}|${it.c.join(",")}|${it.dash.join(",")}`;
        let cmd = run.get(key);
        if (cmd && cmd.points >= BATCH_POINTS) {
          cmds.push(cmd); // same style, so drawing it ahead of the rest of the run keeps the picture
          cmd = undefined;
        }
        if (!cmd) {
          cmd = { k: "stroke", path: new Path2D(), w: it.w, css: css(it.c), dash: it.dash, points: 0 };
          run.set(key, cmd);
        }
        addStroke(cmd.path, it);
        cmd.points += it.xy.length / 2;
        return;
      }
      flush();
      if (it.t === "fill") cmds.push({ k: "fill", path: ringsPath(it.rings), css: css(it.c) });
      else if (it.t === "text") cmds.push({ k: "text", item: i });
      else {
        cmds.push({ k: "image", item: i });
        createImageBitmap(new Blob([it.png as BlobPart], { type: "image/png" })).then(
          (bmp) => {
            if (this.scene !== scene) return;
            this.images.set(i, bmp);
            this.onImageReady();
          },
          () => {},
        );
      }
    });
    flush();
    this.cmds = cmds;
  }

  /** Draws the paper and every item. `dpr` maps CSS pixels to device pixels. */
  drawBase(ctx: CanvasRenderingContext2D, view: View, dpr: number, cssW: number, cssH: number): void {
    const { scene } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.worldTransform(ctx, view, dpr);
    ctx.fillStyle = "#fff";
    ctx.fillRect(scene.min[0], scene.min[1], scene.max[0] - scene.min[0], scene.max[1] - scene.min[1]);

    const devPx = 1 / (dpr * view.scale); // one device pixel in paper feet
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";
    for (const c of this.cmds) {
      if (c.k === "stroke") {
        ctx.lineWidth = Math.max(c.w, devPx);
        ctx.strokeStyle = c.css;
        ctx.setLineDash(c.dash);
        ctx.stroke(c.path);
        ctx.setLineDash([]);
      } else if (c.k === "fill") {
        ctx.fillStyle = c.css;
        ctx.fill(c.path, "evenodd");
      } else if (c.k === "image") {
        const bmp = this.images.get(c.item);
        const it = scene.items[c.item];
        if (bmp && it.t === "image") {
          ctx.save();
          ctx.translate(it.min[0], it.max[1]);
          ctx.scale(1, -1);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(bmp, 0, 0, it.max[0] - it.min[0], it.max[1] - it.min[1]);
          ctx.restore();
        }
      } else {
        this.drawText(ctx, view, dpr, cssW, cssH, c.item, null);
        this.worldTransform(ctx, view, dpr);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Draws every item of the given element in the accent colour. */
  drawHighlight(ctx: CanvasRenderingContext2D, view: View, dpr: number, cssW: number, cssH: number, itemIdx: number[]): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (itemIdx.length === 0) return;
    const px = 1 / view.scale; // one CSS pixel in paper feet
    ctx.lineJoin = "round";
    for (const i of itemIdx) {
      const it = this.scene.items[i];
      this.worldTransform(ctx, view, dpr);
      if (it.t === "path" || it.t === "segs") {
        let path = this.highlightPaths.get(i);
        if (!path) {
          path = new Path2D();
          addStroke(path, it);
          this.highlightPaths.set(i, path);
        }
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = Math.max(it.w * 1.5, 3 * px);
        ctx.setLineDash([]);
        ctx.stroke(path);
      } else if (it.t === "fill") {
        let path = this.highlightPaths.get(i);
        if (!path) {
          path = ringsPath(it.rings);
          this.highlightPaths.set(i, path);
        }
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = ACCENT;
        ctx.fill(path, "evenodd");
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2 * px;
        ctx.stroke(path);
      } else if (it.t === "text") {
        const layout = this.index.layouts[i]!;
        const c = boxCorners(layout);
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        for (let k = 2; k < 8; k += 2) ctx.lineTo(c[k], c[k + 1]);
        ctx.closePath();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = ACCENT;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
        this.drawText(ctx, view, dpr, cssW, cssH, i, ACCENT);
      } else {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 3 * px;
        ctx.strokeRect(it.min[0], it.min[1], it.max[0] - it.min[0], it.max[1] - it.min[1]);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private worldTransform(ctx: CanvasRenderingContext2D, view: View, dpr: number): void {
    ctx.setTransform(dpr * view.scale, 0, 0, -dpr * view.scale, dpr * view.tx, dpr * view.ty);
  }

  /** Text is drawn in screen space (so glyphs are not mirrored by the y-up world transform) and rotated by its baseline. */
  private drawText(ctx: CanvasRenderingContext2D, view: View, dpr: number, cssW: number, cssH: number, i: number, colour: string | null): void {
    const it = this.scene.items[i];
    if (it.t !== "text") return;
    const l: TextLayout = this.index.layouts[i]!;
    const fontPx = l.fontSize * view.scale;
    if (fontPx < 2) return;
    const [sx, sy] = toScreen(view, l.origin[0], l.origin[1]);
    const reach = (l.width + l.height) * view.scale;
    if (sx < -reach || sy < -reach || sx > cssW + reach || sy > cssH + reach) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(sx, sy);
    ctx.rotate(-Math.atan2(l.dir[1], l.dir[0]));
    ctx.font = `${it.bold ? "bold " : ""}${fontPx}px Arial, sans-serif`;
    ctx.fillStyle = colour ?? css(it.c);
    ctx.textBaseline = "alphabetic";
    const h = it.anchor[0];
    ctx.textAlign = h === "l" ? "left" : h === "r" ? "right" : "center";
    const x = h === "l" ? 0 : h === "r" ? l.width * view.scale : (l.width * view.scale) / 2;
    const lineH = l.lineHeight * view.scale;
    const cap = it.size * view.scale;
    l.lines.forEach((line, n) => ctx.fillText(line, x, n * lineH + lineH / 2 + cap / 2));
  }
}
