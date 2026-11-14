# Synthetic stroke corpus

SYNTHETIC: produced by `scripts/fixtures/gen-strokes.mjs` (seeded PRNG, fully deterministic) because no human
recordings exist yet. Human recordings are to be added through the M1-12 recording toggle, alongside these
(use a distinct author name, never `synth-*`).

Layout: `<kind>/<kind>-NNN.json`, kind in wall | door | furniture | delete | markup (50 each = 250 total);
`index.json` lists id, author, split, ambiguous flag, point count and duration.

Each file is a `StrokeRecording` (src/core/types):

    { pdf: "office-6-sheets.pdf",      // bare fixture file name
      sheet: 0,                        // 0-based page index
      label: { kind, note },           // note: description; "ambiguous: ..." prefix on ~14% of strokes;
                                       // delete strokes carry "target:<truth id>" (furniture or wall id)
      points: [{ x, y, t, p }],        // sheet pts (top-left origin, y down), t ms from 0, ~120 Hz, p pressure 0..1
      tool: "brush" | "eraser",        // eraser only on some delete strokes
      author: "synth-a|b|c",           // a: neat/medium, b: slow/jittery, c: fast/sloppy (overshoot, hooks)
      expectedOp: "create_wall" | "place_door" | "place_instance" | "delete" | null,
      split: "train" | "heldout" }     // exactly 20% heldout per kind (index % 5 == 4); never tune on heldout

Velocity follows a bell-shaped profile with corner slow-downs; hand tremor, bow, end overshoot/hook and a
pressure ramp are simulated. Geometry is derived from `fixtures/pdfs/*.truth.json`. Regenerate:
`node scripts/fixtures/gen-pdfs.mjs && node scripts/fixtures/gen-strokes.mjs`.
