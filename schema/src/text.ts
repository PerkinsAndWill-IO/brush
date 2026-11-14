// Text layout and oriented text boxes. No DOM: the caller injects a width measurer.

/** Width in paper feet of `text` set at the given font size (paper feet). */
export type Measure = (text: string, fontSize: number, bold: boolean) => number;

export interface TextSpec {
  text: string;
  at: [number, number];
  size: number; // capital height, paper feet
  anchor: string; // [lcr][tmb]
  dir: [number, number]; // unit baseline direction, y up
  maxWidth: number | null;
  bold: boolean;
}

export interface TextLayout {
  lines: string[];
  fontSize: number; // em size, paper feet
  lineHeight: number;
  width: number;
  height: number;
  /** Top-left corner of the box in world coordinates; the box spans u in [0,width] along dir, v in [-height,0] along up. */
  origin: [number, number];
  dir: [number, number];
  up: [number, number];
}

/** Arial cap height is 0.716 em. */
export const CAP_HEIGHT_EM = 0.716;
export const LINE_HEIGHT_EM = 1.2;

export function wrapLines(text: string, maxWidth: number | null, fontSize: number, bold: boolean, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (maxWidth === null) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(candidate, fontSize, bold) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

export function layoutText(t: TextSpec, measure: Measure): TextLayout {
  const fontSize = t.size / CAP_HEIGHT_EM;
  const lineHeight = fontSize * LINE_HEIGHT_EM;
  const lines = wrapLines(t.text, t.maxWidth, fontSize, t.bold, measure);
  const width = Math.max(0, ...lines.map((l) => measure(l, fontSize, t.bold)));
  const height = lines.length * lineHeight;
  const fx = t.anchor[0] === "l" ? 0 : t.anchor[0] === "r" ? 1 : 0.5;
  const fy = t.anchor[1] === "t" ? 0 : t.anchor[1] === "b" ? 1 : 0.5;
  const dir = t.dir;
  const up: [number, number] = [-dir[1], dir[0]];
  const u0 = -width * fx;
  const vTop = height * fy;
  const origin: [number, number] = [t.at[0] + u0 * dir[0] + vTop * up[0], t.at[1] + u0 * dir[1] + vTop * up[1]];
  return { lines, fontSize, lineHeight, width, height, origin, dir, up };
}

/** World-space corners of the box, counter-clockwise starting at the top-left: x0,y0,... (8 numbers). */
export function boxCorners(l: TextLayout): number[] {
  const [ox, oy] = l.origin;
  const { dir, up, width: w, height: h } = l;
  return [
    ox, oy,
    ox + w * dir[0], oy + w * dir[1],
    ox + w * dir[0] - h * up[0], oy + w * dir[1] - h * up[1],
    ox - h * up[0], oy - h * up[1],
  ];
}

export function pointInTextBox(l: TextLayout, px: number, py: number, pad = 0): boolean {
  const dx = px - l.origin[0];
  const dy = py - l.origin[1];
  const u = dx * l.dir[0] + dy * l.dir[1];
  const v = dx * l.up[0] + dy * l.up[1];
  return u >= -pad && u <= l.width + pad && v <= pad && v >= -l.height - pad;
}
