import "./style.css";
import { ACTUAL_SIZE_SCALE, fitView, panBy, toWorld, zoomAt, type View } from "./geom";
import { categoryOf, paramLabel, resolveElement, type Resolved } from "./elements";
import { buildHitIndex, hitTest, type HitIndex } from "./hit";
import { Renderer } from "./render";
import { convertFile, drawingName, extensionOf, loadRuntimeConfig, NoConverterError, type RuntimeConfig } from "./converter";
import { pageLabel, type DrawingDoc } from "./drawing-file";
import { openDocument } from "./open";
import type { Scene } from "./scene";
import type { Measure } from "./text";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>("stage");
const base = $<HTMLCanvasElement>("base");
const over = $<HTMLCanvasElement>("over");
const card = $<HTMLElement>("card");
const status = $<HTMLSpanElement>("status");
const select = $<HTMLSelectElement>("scenes");
const pageSelect = $<HTMLSelectElement>("pages");
const saveButton = $<HTMLButtonElement>("save");
const filePicker = $<HTMLInputElement>("file");
const baseCtx = base.getContext("2d")!;
const overCtx = over.getContext("2d")!;

const PICK_RADIUS_PX = 4;
const DRAG_THRESHOLD_PX = 4;

// Text metrics come from a canvas: width of the string at 100px, scaled to the requested size.
const mctx = document.createElement("canvas").getContext("2d")!;
const measure: Measure = (text, fontSize, bold) => {
  mctx.font = `${bold ? "bold " : ""}100px Arial, sans-serif`;
  return (mctx.measureText(text).width / 100) * fontSize;
};

/** Timings the page reports about itself (also read by the browser check). */
const stats = { scene: "", pages: 0, page: 0, items: 0, segments: 0, loadMs: 0, pageMs: 0, draws: 0, lastDrawMs: 0, maxDrawMs: 0, hits: 0, lastHitMs: 0, maxHitMs: 0 };
(window as unknown as { __brush: typeof stats }).__brush = stats;

const renderer = new Renderer();
let doc: DrawingDoc | null = null;
let pageIdx = 0;
let scene: Scene | null = null;
let index: HitIndex | null = null;
let view: View = { scale: 1, tx: 0, ty: 0 };
let cssW = 0;
let cssH = 0;
let dpr = 1;
let moved = false; // once the user zooms or pans, a resize no longer refits
let hoverEl: number | null = null;
let pinnedEl: number | null = null;
let baseDirty = false;
let overDirty = false;
let frame = 0;

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// ---------- drawing ----------

function schedule(base_: boolean, over_: boolean) {
  baseDirty ||= base_;
  overDirty ||= over_;
  if (!frame) frame = requestAnimationFrame(draw);
}

function resizeCanvases() {
  const r = stage.getBoundingClientRect();
  cssW = r.width;
  cssH = r.height;
  dpr = window.devicePixelRatio || 1;
  for (const c of [base, over]) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
}

function activeEl(): number | null {
  return pinnedEl ?? hoverEl;
}

// A scene this big takes longer to rasterise than a frame, so while the view is moving the canvases are only
// scaled and shifted with CSS, and the real redraw runs once the view has been still for SETTLE_MS.
const DEFER_SEGMENTS = 50_000;
const SETTLE_MS = 120;
let deferred = false;
let drawnView: View = view; // the view the canvases were last drawn with
let settleTimer = 0;

function viewChanged() {
  if (!deferred) {
    schedule(true, true);
    return;
  }
  const k = view.scale / drawnView.scale;
  const css = `translate(${view.tx - k * drawnView.tx}px, ${view.ty - k * drawnView.ty}px) scale(${k})`;
  base.style.transform = over.style.transform = css;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => schedule(true, true), SETTLE_MS);
}

function draw() {
  frame = 0;
  if (!scene || !index) return;
  if (baseDirty) {
    clearTimeout(settleTimer);
    base.style.transform = over.style.transform = "";
    drawnView = view;
    const t0 = performance.now();
    renderer.drawBase(baseCtx, view, dpr, cssW, cssH);
    stats.lastDrawMs = performance.now() - t0;
    stats.maxDrawMs = Math.max(stats.maxDrawMs, stats.lastDrawMs);
    stats.draws++;
  }
  if (baseDirty || overDirty) {
    const el = activeEl();
    renderer.drawHighlight(overCtx, drawnView, dpr, cssW, cssH, el === null ? [] : resolveElement(scene!.elements, el).highlight.flatMap((e) => index!.byElement.get(e) ?? []));
  }
  baseDirty = overDirty = false;
}

function fit() {
  if (!scene) return;
  view = fitView({ min: scene.min, max: scene.max }, cssW, cssH);
  moved = false;
  schedule(true, true);
}

function actualSize() {
  view = zoomAt(view, cssW / 2, cssH / 2, ACTUAL_SIZE_SCALE / view.scale, 0, Infinity);
  moved = true;
  schedule(true, true);
}

// ---------- card ----------

function renderCard(r: Resolved, pinned: boolean) {
  const { id, info } = r;
  card.replaceChildren();
  card.classList.toggle("pinned", pinned);
  const head = document.createElement("header");
  const cat = document.createElement("div");
  cat.className = "cat";
  cat.textContent = categoryOf(info);
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = (r.tagLabel ? `${r.tagLabel} \u2192 ` : "") + (info?.name || `Element ${id}`);
  head.append(cat, name);
  const meta = document.createElement("div");
  meta.className = "meta";
  const row = (label: string, value: string | undefined) => {
    if (!value) return;
    const d = document.createElement("div");
    const s = document.createElement("span");
    s.textContent = `${label}: `;
    d.append(s, value);
    meta.append(d);
  };
  const famType = [info?.family, info?.type].filter(Boolean).join(" : ");
  row("Family / type", famType);
  row("Level", info?.level);
  row("Element id", String(id));
  card.append(head, meta);
  if (info?.params?.length) {
    const wrap = document.createElement("div");
    wrap.className = "params";
    const table = document.createElement("table");
    for (const p of info.params) {
      const tr = table.insertRow();
      const label = tr.insertCell();
      const nice = paramLabel(p.name);
      label.textContent = nice;
      if (nice !== p.name) {
        const raw = document.createElement("div");
        raw.className = "raw";
        raw.textContent = p.name;
        label.append(raw);
      }
      tr.insertCell().textContent = p.value;
    }
    wrap.append(table);
    card.append(wrap);
  } else if (!info) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "No metadata for this element in the scene.";
    card.append(h);
  }
  if (pinned) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "Pinned. Esc or click empty paper to close.";
    card.append(h);
  }
  card.hidden = false;
}

function placeCard(sx: number, sy: number) {
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  let x = sx + 16;
  let y = sy + 16;
  if (x + w > cssW - 4) x = Math.max(4, sx - 16 - w);
  if (y + h > cssH - 4) y = Math.max(4, cssH - 4 - h);
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
}

function showCard(el: number | null, sx: number, sy: number, pinned: boolean) {
  if (el === null || !scene) {
    card.hidden = true;
    return;
  }
  renderCard(resolveElement(scene.elements, el), pinned);
  placeCard(sx, sy);
}

// ---------- pointer ----------

function pointer(e: { clientX: number; clientY: number }): [number, number] {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function pick(sx: number, sy: number): number | null {
  if (!index) return null;
  const t0 = performance.now();
  const [wx, wy] = toWorld(view, sx, sy);
  const hit = hitTest(index, wx, wy, PICK_RADIUS_PX / view.scale);
  stats.lastHitMs = performance.now() - t0;
  stats.maxHitMs = Math.max(stats.maxHitMs, stats.lastHitMs);
  stats.hits++;
  return hit < 0 ? null : index.scene.items[hit].el;
}

let down: { id: number; x: number; y: number; lastX: number; lastY: number; dragging: boolean } | null = null;

stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const [x, y] = pointer(e);
  down = { id: e.pointerId, x, y, lastX: x, lastY: y, dragging: false };
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
  const [x, y] = pointer(e);
  if (down && down.id === e.pointerId) {
    if (!down.dragging && Math.hypot(x - down.x, y - down.y) > DRAG_THRESHOLD_PX) {
      down.dragging = true;
      stage.classList.add("panning");
      card.hidden = pinnedEl === null;
      if (pinnedEl === null && hoverEl !== null) {
        hoverEl = null;
        schedule(false, true);
      }
    }
    if (down.dragging) {
      view = panBy(view, x - down.lastX, y - down.lastY);
      moved = true;
      viewChanged();
    }
    down.lastX = x;
    down.lastY = y;
    return;
  }
  if (pinnedEl !== null) return;
  const el = pick(x, y);
  if (el !== hoverEl) {
    hoverEl = el;
    schedule(false, true);
  }
  showCard(el, x, y, false);
});

stage.addEventListener("pointerup", (e) => {
  if (!down || down.id !== e.pointerId) return;
  const wasDrag = down.dragging;
  down = null;
  stage.classList.remove("panning");
  if (wasDrag) return;
  const [x, y] = pointer(e);
  const el = pick(x, y);
  if (el === null) {
    unpin();
    return;
  }
  pinnedEl = el;
  hoverEl = el;
  showCard(el, x, y, true);
  schedule(false, true);
});

stage.addEventListener("pointercancel", () => {
  down = null;
  stage.classList.remove("panning");
});

stage.addEventListener("pointerleave", () => {
  if (pinnedEl === null && !down) {
    hoverEl = null;
    card.hidden = true;
    schedule(false, true);
  }
});

function unpin() {
  const had = pinnedEl !== null;
  pinnedEl = null;
  hoverEl = null;
  card.hidden = true;
  card.classList.remove("pinned");
  if (had) schedule(false, true);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") unpin();
  else if ((e.key === "PageUp" || e.key === "PageDown") && doc && doc.pages.length > 1) {
    e.preventDefault(); // also keeps a focused page switcher from moving on its own
    showPage(pageIdx + (e.key === "PageDown" ? 1 : -1));
  }
});

stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
    const [x, y] = pointer(e);
    const fitScale = scene ? fitView({ min: scene.min, max: scene.max }, cssW, cssH).scale : 1;
    view = zoomAt(view, x, y, factor, fitScale * 0.2, ACTUAL_SIZE_SCALE * 20);
    moved = true;
    if (pinnedEl === null) {
      hoverEl = null;
      card.hidden = true;
    }
    viewChanged();
  },
  { passive: false },
);

new ResizeObserver(() => {
  resizeCanvases();
  if (!moved) fit();
  else schedule(true, true);
}).observe(stage);

$("fit").addEventListener("click", fit);
$("actual").addEventListener("click", actualSize);
renderer.onImageReady = () => schedule(true, false);

// ---------- loading ----------

/** Shows one page of the open document. */
function showPage(i: number, parseMs?: number) {
  if (!doc) return;
  i = Math.max(0, Math.min(doc.pages.length - 1, i));
  const t0 = performance.now();
  const page = doc.pages[i];
  const parsed = page.scene;
  const idx = buildHitIndex(parsed, measure);
  let segments = 0;
  for (const it of parsed.items) segments += it.t === "segs" ? it.xy.length / 4 : it.t === "path" ? Math.max(0, it.xy.length / 2 - 1) : 0;
  renderer.setScene(parsed, idx);
  deferred = segments > DEFER_SEGMENTS;
  pageIdx = i;
  scene = parsed;
  index = idx;
  hoverEl = pinnedEl = null;
  card.hidden = true;
  pageSelect.value = String(i);
  resizeCanvases();
  fit();
  stats.page = i;
  stats.items = parsed.items.length;
  stats.segments = segments;
  stats.pageMs = performance.now() - t0;
  stats.maxDrawMs = stats.maxHitMs = 0;
  const label = pageLabel(page);
  document.title = `${label} - Brush`;
  const pageNote = doc.pages.length > 1 ? ` | page ${i + 1} of ${doc.pages.length}` : "";
  setStatus(`${label} | ${parsed.items.length.toLocaleString()} items, ${segments.toLocaleString()} segments${pageNote} | ${parseMs === undefined ? "page ready" : "loaded"} in ${(((parseMs ?? 0) + stats.pageMs) / 1000).toFixed(2)} s`);
}

function setDoc(next: DrawingDoc, label: string, t0: number) {
  doc = next;
  pageSelect.replaceChildren(...next.pages.map((p, i) => new Option(pageLabel(p), String(i))));
  pageSelect.hidden = next.pages.length < 2;
  stats.scene = label;
  stats.pages = next.pages.length;
  const parseMs = performance.now() - t0; // reading and parsing the file; the first page's index comes on top
  showPage(0, parseMs);
  stats.loadMs = parseMs + stats.pageMs;
}

/** The converted .drawing the user can save, if the open document came from a converter. */
let converted: { name: string; bytes: Uint8Array } | null = null;

function offerSave(next: typeof converted) {
  converted = next;
  saveButton.hidden = next === null;
}

saveButton.addEventListener("click", () => {
  if (!converted) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([converted.bytes as BlobPart], { type: "application/octet-stream" }));
  a.download = converted.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

async function openBytes(bytes: Uint8Array, label: string, t0: number) {
  setDoc(await openDocument(bytes), label, t0);
}

async function loadUrl(url: string) {
  const t0 = performance.now();
  setStatus(`Loading ${url} ...`);
  offerSave(null);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    await openBytes(new Uint8Array(await res.arrayBuffer()), url, t0);
  } catch (err) {
    setStatus(`Could not load ${url}: ${(err as Error).message}`, true);
  }
}

async function loadFile(file: File) {
  const t0 = performance.now();
  setStatus(`Reading ${file.name} ...`);
  offerSave(null);
  try {
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, t0);
  } catch (err) {
    setStatus(`Could not open ${file.name}: ${(err as Error).message}`, true);
  }
}

const configReady: Promise<RuntimeConfig> = loadRuntimeConfig(`${import.meta.env.BASE_URL}config.json`, import.meta.env.VITE_CONVERTER_URL).then((config) => {
  // With a converter any file may be offered to it, so the picker stops filtering by extension.
  if (config.converter) filePicker.removeAttribute("accept");
  return config;
});

async function convertAndOpen(file: File) {
  const t0 = performance.now();
  const started = new Date();
  let message = `Converting ${file.name} ...`;
  const tick = window.setInterval(() => setStatus(`${message} (${Math.round((Date.now() - started.getTime()) / 1000)} s)`), 500);
  setStatus(message);
  offerSave(null);
  try {
    const config = await configReady;
    const bytes = await convertFile(file, config, {
      onProgress: (m) => {
        message = m;
        setStatus(m);
      },
    });
    window.clearInterval(tick);
    const name = drawingName(file.name);
    await openBytes(bytes, name, t0);
    offerSave({ name, bytes });
  } catch (err) {
    window.clearInterval(tick);
    setStatus(err instanceof NoConverterError ? err.message : `Could not convert ${file.name}: ${(err as Error).message}`, true);
  }
}

/** .drawing and .json are read here; any other file goes to the configured converter. */
function openFile(file: File) {
  const ext = extensionOf(file.name);
  return ext === ".drawing" || ext === ".json" ? loadFile(file) : convertAndOpen(file);
}

filePicker.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) void openFile(f);
  input.value = ""; // choosing the same file again must fire change again
});

let dragDepth = 0;
const drop = $("drop");
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) drop.hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f) void openFile(f);
});

pageSelect.addEventListener("change", () => showPage(Number(pageSelect.value)));

select.addEventListener("change", () => {
  const url = `${import.meta.env.BASE_URL}scenes/${select.value}`;
  history.replaceState(null, "", `?file=${encodeURIComponent(url)}`);
  void loadUrl(url);
});

async function start() {
  resizeCanvases();
  let list: { file: string; title: string }[] = [];
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}scenes/index.json`);
    if (res.ok) list = await res.json();
  } catch {
    /* no index: the picker and ?file= still work */
  }
  for (const s of list) select.add(new Option(s.title, s.file));
  const params = new URLSearchParams(location.search);
  const wanted = params.get("file") ?? params.get("scene"); // ?scene= is the old name of ?file=
  if (wanted) {
    const match = list.findIndex((s) => wanted.endsWith(`scenes/${s.file}`));
    select.selectedIndex = match;
    await loadUrl(wanted);
  } else if (list.length > 0) {
    await loadUrl(`${import.meta.env.BASE_URL}scenes/${list[0].file}`);
  }
}

void start();
