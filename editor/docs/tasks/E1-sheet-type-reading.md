# E1 — Read strokes by sheet type (elevations, sections, details)

The context already types every sheet (`classifySheet`: drawing-code type field, then title words; `.drawing`
pages by their `viewType`) and decision 0006 already keeps plan geometry (walls, openings, fixtures, rooms) off
non-plan sheets. The predictor never looked at the type, so on an elevation a door drawn face on (an upright
rectangle) read as furniture or markup, a door could never be placed (no host wall), and on a detail any long
stroke read as a plan wall.

The predictor now reads the sheet type (`prepareContext(ctx).view`, from the `sheet-info` item) and picks a
reading mode:

| Sheet type | Mode | Readings |
|---|---|---|
| plan, unknown | `plan` | unchanged (walls, door ticks / swings, furniture, delete, markup) |
| elevation, section | `elevation` | door = upright outline of a door's size (closed, or open at the floor); delete; markup |
| detail, axonometric, other | `detail` | delete and markup only: the sketch stays ink |

An explicit brush mode (Wall, Door, ...) still wins on every sheet.

| ID | Requirement | Test |
|---|---|---|
| E1-01 | Elevation and section sheets switch the brush to elevation reading; plans and unknown sheets keep plan reading. | `tests/unit/predict/elevation.test.ts` |
| E1-02 | On an elevation an upright outline about 0.65–2.0 m wide and 1.85–2.8 m tall, taller than wide, closed or open at the bottom, reads as a door. | unit + `tests/e2e/e1-elevation.spec.ts` |
| E1-03 | On an elevation, wall and furniture readings are off. | unit |
| E1-04 | An elevation door is drawn face on: a closed upright rectangle at the nearest palette family's width and height, centred on the sketch, standing on its bottom edge (bottom-left, bottom-right, top-right, top-left). The overlay draws it with the dashed swing chevron. | unit + e2e (screenshot `e1-elevation-door`) |
| E1-05 | `place_door` from an elevation door takes `at`, `widthPt` and `angleRad` from the bottom edge. | unit + e2e |
| E1-06 | On detail / axonometric / other sheets, wall, door and furniture readings are off; the eraser still deletes. | unit |

## Open

- **Windows.** The vocabulary has no `window` kind (`DecisionKind` is frozen). A raised, squat rectangle on an
  elevation now stays markup instead of turning into furniture. Adding `window` needs a decision record.
- **Per-viewport type.** The mode follows the sheet type. A detail or elevation view placed on a sheet typed
  otherwise (e.g. a plan sheet with a wall-section callout) still reads as the sheet. `.drawing` files carry each
  view's `type` and region, so the mode could follow the view under the stroke.
- **Snapping on elevations.** Doors keep the drawn sill line; snapping to level lines and to existing door / window
  sills and heads (in `.drawing` contexts they are `unknown` items with `category` Doors / Windows) is next.
- **Detail vocabulary.** On details the brush could predict layers (insulation hatch, membrane, flashing / coping
  profile, dimension) instead of leaving ink.
- **Revit.** The link places doors on plan viewports only; an elevation `place_door` has no plan wall to land in
  (protocol side, `revit/`).
