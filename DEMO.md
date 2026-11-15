# Brush: the 5-minute demo

**The story:** architects think with a pen. Brush lets them sketch on a real Revit sheet, and seconds later the
sketch is real Revit model: walls, doors, furniture. The sheet comes back redrawn by Revit itself.

**The one thing the room must see:** a hand-drawn wall turning into a modelled wall, with a stopwatch on screen.

---

## Run of show

Five minutes, every beat in. The **Show more** step for each beat is in brackets; the times are what the screen needs,
measured on the dev laptop, so the talk fits around them.

| Time | Beat | On screen | Say |
|---|---|---|---|
| 0:00 | **Hook** | The start page | "Architects think with a pen. Revit makes them think in dialog boxes." |
| 0:20 | **Setup** [1 Kickoff demo] | Picker: A102–A105 ticked, Open 4 sheets, zoom into Live/Work Unit 205 (~20 s) | "Revit is open with the real model, Snowdon Towers. I take four floors." Keep talking while they arrive. |
| 0:45 | **The loop** [2 Sketch a wall, a door and a table] | Wall, door, table; the timer counts each home; the table turns round from the type menu (~20 s) | "A wall… a door… a table." Then, as it swaps: "Not that table: right-click, another type." |
| 1:15 | **It reads the building** [3 What is it?, 4 Every floor, 5 Back] | The facade wall's card with its Revit parameters; zoom out: lit up on all four floors (~5 s) | "That's a real Revit wall, with its parameters. One wall, four floors." |
| 1:45 | **Hand over the pen** (optional) | A judge draws one wall | "You've never opened Revit. Draw a wall." Skip it if the clock is tight. |
| 2:15 | **No Revit license?** [6 No Revit license?, 7 Sketch in the kitchen] | Drop `racbasicsampleproject.rvt`: 13 sheets in ~8 s; the kitchen: a wall, and the missing bar stool (~15 s) | "No Revit license? Drop the .rvt: Brush reads the model itself. And you sketch the same way." |
| 2:55 | **A colleague's sketch** [8 A colleague's sketch, 9 Make it real] | The photo drops in, the import dialog reads it (~18 s), the trace paper unrolls with the marker on it; Make elements: 6 walls and 4 doors (~1 s) | "My colleague sketched on a print with a marker. A photo is enough: Brush finds the sheet and traces the ink. Then make it real." |
| 3:40 | **Why it matters** | One slide | "Weeks become minutes, and the people who sketch can change the model directly." |
| 4:20 | **Close** | The timer's best time | "Brush. Sketch it, and it's built." |

Measured, the nine steps need about 2 minutes of screen time in all: step 1 is the long one, 15-25 s on a freshly
started Revit but a minute on one that has run all afternoon. Restart Revit before going on (see the checklist), and
press step 1 as you start the hook, so the hook is said while the floors arrive.

Twenty seconds of slack at the end. If time runs short, drop the judge's turn first, then stop clicking: every step
leaves the screen in a good state.

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
- **Inspector:** select tool, hover the new wall between its top end and the door. The card shows *Walls*, its type,
  *level L2* and its Revit parameters (base and top constraint, height, length, area, volume…).
- **One wall, four sheets:** the long exterior rainscreen wall along the north facade (Revit id `1919205`) is drawn on
  A102, A103, A104 and A105. Click it on A102 between windows (a window on top of it picks the window), then press
  **0** (fit) to zoom out to the four sheets. With the browser full screen the highlight reads from the back of the room.

Use the **Mode** buttons (Wall, Door, Furniture) to force each reading on stage, so a wobbly stroke can't be read
as something else. Set the mode back to **Auto** for the judge's turn: it's more impressive when Brush guesses.

---

## Presenting: the "Show more" button

Open the editor with **`?demo`** (`http://localhost:5173/?demo`). A terracotta **Show more** button sits in the bottom
right corner, saying what it will do next. Each click plays one step in the real app while you talk:

| # | Button says | What happens |
|---|---|---|
| 1 | Kickoff demo | Connects to Revit, ticks A102–A105 in the picker, opens them, **cleans the stage** (takes back anything an earlier run left in Live/Work Unit 205, or stops and says so), zooms into the room. |
| 2 | Sketch a wall, a door and a table | Draws all three, waits for the table to be in Revit, then right-clicks it and picks the 60" round dining table. |
| 3 | What is it? | Still zoomed in, **clicks** the north facade wall along the room: its card pins open with its Revit parameters. |
| 4 | Every floor | Zooms out: the selected wall is lit up on all four floors. |
| 5 | Back to the room | Zooms back in. |
| 6 | No Revit license? | Disconnects from Revit and drops `racbasicsampleproject.rvt` on Brush (a file chip flies in): the conversion server turns it into a `.drawing` in about 7 s, and it zooms to the kitchen. If you dragged the file in by hand, it only zooms. Clears that file's sketches from earlier runs first. |
| 7 | Sketch in the kitchen | Draws a partition wall between the dining table and the island, and the stool missing from the row along the island: it comes in as a **Bar Chair**, like its neighbours. |
| 8 | A colleague's sketch | Opens the **Medium** sample (KRO, 4 sheets) with a clean session, drops the photo of the colleague's marker sketch on sheet **0001 (N01 Accès logements)**, clicks Import in the photo dialog, then Done: the trace paper unrolls with the sketch on it. |
| 9 | Make it real | Clicks **Make elements**: the sketched walls and door swings become walls and doors (the round tables stay ink). |

- **Keys:** **PageDown**, **→** or **N** advance (what presentation clickers send). **H** hides the button for a clean
  screen, and brings it back.
- **Pace:** a step returns as soon as its own action is done, so you keep talking while Revit works and the timer counts.
  Steps that need Revit's result wait for it (5 waits for the table).
- **Out of time:** just stop clicking. Nothing is left half done.
- **A step fails:** the button says why and turns into **Try again**; the next click retries that step.
- **After the last step:** "That's the demo ✦" and **Start over**, which takes everything back out of Revit (like
  `reset()`) and goes back to step 1.
- **What is played back:** the photo import (step 8). The real import of that photo takes 60–110 s (finding the sheet
  among four, then registering the photo to it), so it is recorded once on the presenting machine and played back
  through the same dialog in 7 s: the strokes are exactly what the import traced, minus the dark print around the
  sketch it also picked up. Everything else is live. Without a recording, step 8 runs the real import.
- No captions in this mode: you are the voice. (`__brushDemo.run()` still plays the captioned rehearsal.)

## Setup checklist (30 minutes before)

1. **Brush Link built from this branch:** it sends each element's Revit parameters (the inspector shows them).
   After deploying, click *Reload the plugin* in Revit (Add-Ins → Brush) or restart Revit.
2. **Start Revit fresh** shortly before the demo. After an afternoon of rehearsals, reloads and undos, the same sheet
   took 14–27 s to export instead of 3–7 s, and the type change took nearly a minute.
3. **Don't refresh the other floors during the demo:** in `%APPDATA%\Brush\revit-link.json` set
   `"otherSheetsAfterEditMs": 60000`. Everything is drawn on L2, so A103–A105 never change, but by default each is
   re-exported 3 s after every edit, and an export already started can't be interrupted (one took 27 s and held
   up the type change). Read at Revit start (or *Reload the plugin*).
4. **Revit 2026** open with *Snowdon Towers Sample Architectural* (`C:\Program Files\Autodesk\Revit 2026\Samples`).
   Brush Link on: Add-Ins → Brush → Brush Link. The pill in Brush's top bar should go green.
5. **No-license beat:** the conversion server running (`editor/CLAUDE.md`), and a copy of
   `racbasicsampleproject.rvt` in `editor/fixtures/demo/` for step 6 to drop (kept out of git). Drop it once before
   going on stage so the server has it cached.
   **Colleague's sketch:** the photo in `editor/fixtures/demo/colleague-sketch.jpg` (kept out of git), and once, in the
   browser you will present from, in the console: `await __brushDemo.recordSketch()` (about a minute; it runs the
   real import and keeps what it traced for step 8 to play back).
6. **Editor:** `pnpm --dir editor dev` and open `http://localhost:5173/?demo` (the Show more button; it turns the
   timer on at step 1).
   `?timer` turns the round-trip timer on (it's also a switch in the Revit panel, and it's remembered).
7. **Warm up:** open A102, draw and undo one wall. The first export after Revit opens a model is the slow one.
8. **Close everything else** that talks to Revit (a second browser tab on the editor, PW Tools sessions).
9. **Screen:** 1920×1080, browser zoom 100%, Brush full screen (F11). Hide the right sidebar if it crowds the sheet.
10. **Back-up video:** record one clean run (`Win+Alt+R`) and keep it on the desktop.
11. **Start clean:** after the last rehearsal press **Start over** (or `await __brushDemo.ensureClean()`). Step 1 also
   checks the stage and cleans it, but cleaning a whole earlier run takes about a minute you don't want on stage.

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
- Doors take the nearest width, preferring an ordinary door: a ~1 m opening becomes
  `Door-Passage-Single-Flush: 36" x 80"`. (Before, it picked the double-acting 42" door, whose plan symbol shows
  the leaf half open both ways and looks like a door at an angle.)
- Round trips vary run to run with how busy Revit is: 3–9 s typically on A102, one rehearsal had 13 s. Keep
  talking through it; never redraw while the timer runs.
