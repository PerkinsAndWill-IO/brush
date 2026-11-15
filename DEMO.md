# Brush: the 5-minute demo

**The story:** architects think with a pen. Brush lets them sketch on a real Revit sheet, and seconds later the
sketch is real Revit model: walls, doors, furniture. The sheet comes back redrawn by Revit itself.

**The one thing the room must see:** a hand-drawn wall turning into a modelled wall, with a stopwatch on screen.

---

## Run of show

| Time | Beat | On screen | Say |
|---|---|---|---|
| 0:00 | **Hook** | The napkin photo (or the start page) | "Every building starts as a sketch. Then it takes weeks of clicking to become *this*." |
| 0:30 | **Setup** | Start page, Revit linked: the sheet picker. Pick **A102**, Open. | "Revit is open with the real model, Snowdon Towers. Brush lists its sheets. I pick one." |
| 1:00 | **The loop** | Sketch a **wall**, a **door** in it, a **table** beside it. The timer counts each one home. | "A wall… a door… a table." Then stop talking and let the room watch the timer. |
| 2:15 | **Change your mind** | Select tool, **right-click the table**: the type menu lists every type Revit has. Pick **Table-Dining Round w Chairs: 60" Diameter**. The timer counts the swap. | "Not the table I wanted. Right-click, pick another type: Revit swaps it and redraws the sheet." |
| 2:45 | **Hand over the pen** | A judge draws one wall. | "You've never opened Revit. Draw a wall." |
| 3:15 | **It reads the building** | Select tool, hover the wall just drawn: the inspector shows its Revit type and level. | "That's not ink any more. It's a real Revit wall, with its type and its level." |
| 3:45 | **Why it matters** | One slide | "Weeks become minutes, and the people who sketch can change the model directly." |
| 4:30 | **Close** | Show the timer's best time. | "Brush. Sketch it, and it's built." |

Rehearsed timings (Snowdon Towers, **A102**, dev laptop, five rehearsals): each element comes back modelled in
**3–9 s** on A102, and the type change in about 5 s. A sheet with less on it is faster (A103: 2–4 s), but A102 is the one that draws furniture, so
the table shows. The first edit after opening a sheet is the slowest; draw one throwaway wall before going on stage
(then undo it). With the timer running, the wait reads as a feature rather than lag.

## Why A102

Brush opened and counted the floor plans. A102 *Second Floor Plan* draws 61 furniture pieces in its view: rectangular
tables, round dining tables, banquettes, chairs. A103 draws only shelving, so a table placed there exists in Revit
but never shows on the sheet. A101 (dining tables and chairs) is the back-up.

## Where to draw on A102

Live/Work Unit **205**, the empty top half of the room, below the north wall:

- **Wall:** one vertical stroke from the north wall down about 5 m, a little left of the room tag.
- **Door:** a short stroke *along* the new wall, about a metre long, near the top. (A door stroke is the opening, not
  the swing.)
- **Table:** a small rectangle to the right of the wall, under the room tag, about 66" × 36" at the sheet's 1:96.
  Furniture is chosen by the size you draw: a rectangle that size becomes `Table-Rectangular: 66" x 36"`; a big one
  becomes a bed or a banquette.
- **Type change:** select tool, right-click the middle of the table once it's drawn by Revit (not while it's still
  ink), and pick `Table-Dining Round w Chairs: 60" Diameter` from the menu. The menu fills in Revit's full list a
  moment after it opens. A dashed mark with "→ new type" shows until Revit has redrawn it.
- **Inspector:** select tool, hover the new wall between its top end and the door. The card shows *Walls*, its type
  and *level L2*.

Use the **Mode** buttons (Wall, Door, Furniture) to force each reading on stage, so a wobbly stroke can't be read
as something else. Set the mode back to **Auto** for the judge's turn: it's more impressive when Brush guesses.

---

## Setup checklist (30 minutes before)

1. **Revit 2026** open with *Snowdon Towers Sample Architectural* (`C:\Program Files\Autodesk\Revit 2026\Samples`).
   Brush Link on: Add-Ins → Brush → Brush Link. The pill in Brush's top bar should go green.
2. **Editor:** `pnpm --dir editor dev` and open `http://localhost:5173/?timer`.
   `?timer` turns the round-trip timer on (it's also a switch in the Revit panel, and it's remembered).
3. **Warm up:** open A102, draw and undo one wall. The first export after Revit opens a model is the slow one.
4. **Close everything else** that talks to Revit (a second browser tab on the editor, PW Tools sessions).
5. **Screen:** 1920×1080, browser zoom 100%, Brush full screen (F11). Hide the right sidebar if it crowds the sheet.
6. **Back-up video:** record one clean run (`Win+Alt+R`) and keep it on the desktop.
7. **Reset the model** after rehearsing (see below), so the stage run starts in an empty room.

## The round-trip timer

The pill at the top of the board times each sketched element, from the pen leaving the screen to the sheet coming
back from Revit with the element drawn in:

- **Sketched:** Brush read the stroke and committed it (about 0.4 s, the commit pause).
- **In Revit:** Revit made the element.
- **On the sheet:** Revit re-exported the sheet and Brush shows it. The stroke disappears because the real element is
  now drawn there.

While a trip is on its way the time counts up and the stopwatch hand turns. When it lands, the pill turns green and a
"Modelled in 2.4 s" chip appears by the ink for a few seconds. The pill also keeps the **best** time.

## Rehearsing with the script

In a dev build, the browser console has `__brushDemo`, which plays the run of show in the real app: captions say
which beat is playing, a visible pen draws at hand speed, and the strokes really go to Revit.

```js
await __brushDemo.run()              // whole run of show, with talking pauses (~45 s of script)
await __brushDemo.run({ fast: true }) // same, no pauses
await __brushDemo.beat('loop')        // one beat: 'hook' | 'setup' | 'loop' | 'retype' | 'inspect' | 'close'
await __brushDemo.reset()             // take everything it drew back out of Revit
__brushDemo.spots                     // where it draws (sheet fractions); edit SNOWDON_SPOTS in editor/src/app/demo/rehearse.ts
__brushDemo.furniture()               // the model's furniture families, for sizing the table
```

`run()` resolves with each beat's duration and the round-trip stats, for example
`{ seconds: { hook: 5, setup: 9, loop: 15.9, retype: 12.5, inspect: 7, close: 5 }, trips: { best: 3330, median: 5281, … } }`.

**Always `reset()` after a rehearsal.** It undoes the strokes (Revit reverts them) and deletes, by element id, anything
an earlier page load made. Those ids are kept in `localStorage` (`brush.demo.elements`), so a reload doesn't strand
them; after a reload `reset()` connects and opens the sheet itself. Don't edit the editor's code between `run()` and
`reset()`: a hot reload drops the strokes (the ids still get it cleaned up, by delete instead of undo).

## If something goes wrong on stage

| Symptom | Do this |
|---|---|
| Pill stays grey / "Connecting…" | Revit's Brush Link is off or another tab holds it. Say "let me show you the recording" and play the video. |
| A stroke is read as the wrong thing | Undo (Ctrl+Z), pick the Mode button, draw again. Undo is part of the story: it reverts in Revit too. |
| The timer passes 10 s | Keep talking through the inspector beat; the sheet will land. Don't redraw. |
| "Revit could not apply this" chip | The stroke is off the room or crosses another element. Undo and draw it again inside the room. |
| Furniture lands but isn't drawn | That family is hidden in the sheet's view. Stay on A102, or draw a table-sized rectangle. |
| The type menu has only a few types | Revit's full list is still on its way: wait a second, or close and right-click again. |
| Inspector shows the room, not the wall | Move the pointer a hair: the card opening shifts the board under a still pointer. |

## Known rough edges

- The Revit link sends furniture families without sizes. Brush now reads the size from the type name
  (`Table-Rectangular: 72" x 30"`), so a drawn rectangle picks the nearest real table. Families with no size in
  their name (`Banquette - Double`) are only picked when nothing else fits.
- On A103 most furniture families are hidden in the view: a table lands in Revit but not on the sheet. Use A102.
- Opening the inspector card widens the left sidebar and moves the board a little.
- Walls take the type nearest the stroke's thickness: a thick stroke gives an exterior rainscreen wall.
