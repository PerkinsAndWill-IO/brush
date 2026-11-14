// Writes scene JSON files that follow the contract in README.md.
//   node scripts/gen-scenes.mjs fixture                       -> public/scenes/fixture.json (committed)
//   node scripts/gen-scenes.mjs synthetic [--segs 300000]     -> public/scenes/synthetic-300k.json (git-ignored)
//   either command takes --out <file> to write somewhere else
import { writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args[0] ?? "fixture";
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const r5 = (n) => Math.round(n * 1e5) / 1e5;

/** A small grey checkerboard PNG, so the image item type is exercised. */
function checkerPng(n = 8) {
  const raw = Buffer.alloc((n + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n + 1)] = 0;
    for (let x = 0; x < n; x++) raw[y * (n + 1) + 1 + x] = (x + y) % 2 ? 210 : 120;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function fixture() {
  const V = 678;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const black = [0, 0, 0];
  const wall = (el, ...segs) => ({ t: "segs", segs: segs.flat(), w: 0.002, c: black, dash: [], el, view: V });
  const items = [
    { t: "path", pts: rect(0.05, 0.05, 2.71, 1.9), closed: true, w: 0.004, c: black, dash: [], el: null, view: null },
    { t: "path", pts: rect(0.12, 0.12, 2.64, 1.83), closed: true, w: 0.0008, c: black, dash: [], el: null, view: null },
    { t: "text", text: "A102 - Plans", at: [2.6, 0.08], size: 0.03, anchor: "rb", dir: [1, 0], maxWidth: null, c: black, bold: true, el: null, view: null },
    { t: "image", min: [0.15, 0.14], max: [0.23, 0.22], png: checkerPng(), el: null, view: null },
    // rooms: Kitchen, and Living Room with a 0.3 x 0.3 courtyard hole
    { t: "fill", rings: [rect(0.3, 0.4, 1.25, 1.4)], c: [236, 224, 200], el: 2001, view: V },
    { t: "fill", rings: [rect(1.25, 0.4, 2.4, 1.4), rect(1.7, 0.7, 2.0, 1.0)], c: [200, 222, 236], el: 2002, view: V },
    // walls, one element each
    wall(3001, [0.3, 0.4, 0.3, 1.4]),
    wall(3002, [0.3, 0.4, 1.25, 0.4], [1.25, 0.4, 2.4, 0.4]),
    wall(3003, [2.4, 0.4, 2.4, 1.4]),
    wall(3004, [0.3, 1.4, 1.25, 1.4], [1.25, 1.4, 2.4, 1.4]),
    wall(3005, [1.25, 0.4, 1.25, 0.8], [1.25, 1.0, 1.25, 1.4]),
    // a diagonal wall segment and the courtyard edge
    wall(3006, [1.7, 0.7, 2.0, 1.0]),
    { t: "path", pts: rect(1.7, 0.7, 2.0, 1.0), closed: true, w: 0.0012, c: [90, 90, 90], dash: [], el: 3007, view: V },
    // grid line, dashed
    { t: "path", pts: [[0.2, 0.9], [2.5, 0.9]], closed: false, w: 0.0008, c: [200, 0, 0], dash: [0.02, 0.008, 0.002, 0.008], el: 4001, view: V },
    // room names
    { t: "text", text: "Kitchen", at: [0.775, 0.9], size: 0.02, anchor: "cm", dir: [1, 0], maxWidth: null, c: black, bold: false, el: 2001, view: V },
    { t: "text", text: "Living Room\nLevel 1", at: [1.825, 1.2], size: 0.02, anchor: "cm", dir: [1, 0], maxWidth: null, c: black, bold: false, el: 2002, view: V },
    { t: "text", text: "A long note that wraps at word breaks inside the given width", at: [0.32, 1.35], size: 0.012, anchor: "lt", dir: [1, 0], maxWidth: 0.4, c: [60, 60, 60], bold: false, el: 6001, view: V },
    // rotated text
    { t: "text", text: "Section A", at: [2.45, 1.0], size: 0.015, anchor: "lb", dir: [0.7071068, 0.7071068], maxWidth: null, c: [0, 90, 160], bold: true, el: 5001, view: V },
    { t: "text", text: "FLOOR PLAN  1:100", at: [0.3, 0.3], size: 0.025, anchor: "lb", dir: [1, 0], maxWidth: null, c: black, bold: true, el: null, view: V },
  ];
  const room = (name, number, area, level = "Level 1") => ({
    class: "Room", category: "Rooms", name, family: "", type: "", level,
    params: [{ name: "Number", value: number }, { name: "Area", value: area }, { name: "Level", value: level }, { name: "Department", value: "Residential" }],
  });
  const wallEl = (name, len) => ({
    class: "Wall", category: "Walls", name, family: "Basic Wall", type: "Generic - 200mm", level: "Level 1",
    params: [{ name: "Length", value: len }, { name: "Width", value: "200 mm" }, { name: "Structural", value: "No" }, { name: "Fire Rating", value: "60 min" }],
  });
  const elements = {
    2001: room("Kitchen", "101", "12.6 m²"),
    2002: room("Living Room", "102", "27.4 m²"),
    3001: wallEl("Exterior West", "10.0 m"),
    3002: wallEl("Exterior South", "21.0 m"),
    3003: wallEl("Exterior East", "10.0 m"),
    3004: wallEl("Exterior North", "21.0 m"),
    3005: wallEl("Partition", "6.0 m"),
    3006: wallEl("Courtyard Diagonal", "4.2 m"),
    3007: { class: "Column", category: "Structural Columns", name: "Courtyard Frame", family: "M_Concrete-Rectangular", type: "300 x 300", level: "Level 1", params: Array.from({ length: 30 }, (_, i) => ({ name: `Parameter ${i + 1}`, value: `Value ${i + 1}` })) },
    4001: { class: "Grid", category: "Grids", name: "Grid B", family: "Grid", type: "6.5mm Bubble", level: "", params: [{ name: "Name", value: "B" }] },
    5001: { class: "ElevationMarker", category: "Views", name: "Section A", family: "Section Head", type: "Section Head", level: "Level 1", params: [{ name: "View Scale", value: "1 : 100" }] },
    6001: { class: "TextNote", category: "Text Notes", name: "General note", family: "Text", type: "3.0 mm Arial", level: "Level 1", params: [] },
  };
  return { format: 1, sheet: { id: 382617, number: "A102", name: "Plans" }, min: [0, 0], max: [2.76, 1.95], items, elements };
}

function synthetic(targetSegs) {
  let s = 12345;
  const rnd = () => ((s = (s + 0x6d2b79f5) | 0), (((t) => ((t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296))(s)));
  const W = 2.76, H = 1.95;
  const widths = [0.0006, 0.0012, 0.0024];
  const cats = ["Walls", "Doors", "Windows", "Furniture", "Floors", "Lines"];
  const items = [{ t: "path", pts: [[0.05, 0.05], [2.71, 0.05], [2.71, 1.9], [0.05, 1.9]], closed: true, w: 0.004, c: [0, 0, 0], dash: [], el: null, view: null }];
  const elements = {};
  let el = 10000;
  let segs = 0;
  const perItem = 100;
  while (segs < targetSegs) {
    const cx = 0.1 + rnd() * (W - 0.4), cy = 0.1 + rnd() * (H - 0.4);
    const n = Math.min(perItem, targetSegs - segs);
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x = cx + rnd() * 0.25, y = cy + rnd() * 0.25, a = rnd() * Math.PI, l = 0.004 + rnd() * 0.03;
      arr.push(r5(x), r5(y), r5(x + Math.cos(a) * l), r5(y + Math.sin(a) * l));
    }
    segs += n;
    el++;
    items.push({ t: "segs", segs: arr, w: widths[el % 3], c: [0, 0, 0], dash: el % 17 === 0 ? [0.01, 0.005] : [], el, view: 1 });
    elements[el] = { class: "Element", category: cats[el % cats.length], name: `Synthetic ${el}`, family: "Family", type: "Type", level: "Level 1", params: [{ name: "Index", value: String(el) }] };
    if (el % 5 === 0) {
      const x = cx + 0.1, y = cy + 0.1;
      items.push({ t: "fill", rings: [[[x, y], [x + 0.06, y], [x + 0.06, y + 0.04], [x, y + 0.04]]], c: [220 - (el % 5) * 3, 225, 230], el, view: 1 });
      items.push({ t: "text", text: `R${el}`, at: [x + 0.03, y + 0.02], size: 0.006, anchor: "cm", dir: [1, 0], maxWidth: null, c: [0, 0, 0], bold: false, el, view: 1 });
    }
  }
  return { format: 1, sheet: { id: 1, number: "S300", name: `Synthetic ${targetSegs} segments` }, min: [0, 0], max: [W, H], items, elements };
}

if (mode === "fixture") {
  const out = opt("out", join(root, "public/scenes/fixture.json"));
  writeFileSync(out, JSON.stringify(fixture(), null, 1) + "\n");
  console.log(`wrote ${out}`);
} else if (mode === "synthetic") {
  const n = Number(opt("segs", "300000"));
  const out = opt("out", join(root, "public/scenes/synthetic-300k.json"));
  writeFileSync(out, JSON.stringify(synthetic(n)));
  console.log(`wrote ${out} (${n} segments)`);
} else {
  console.error("usage: node scripts/gen-scenes.mjs fixture|synthetic [--segs N] [--out file]");
  process.exit(1);
}
