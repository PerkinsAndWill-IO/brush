# 0013 Pop-up messages use Sonner

Date: 2026-11-17

## Context

The `.rvt` conversion server is not deployed. When someone opens a Revit model anyway, the editor should tell them
in a short pop-up ("toast") that this isn't available yet, rather than in the start page's red error box. Victor
asked for a Sonner-style pop-up.

## Decision

**New dependency: `sonner` 2.0.7** (pinned exactly, MIT, no dependencies besides React as a peer). One `<Toaster>`
is mounted in `App.tsx` (bottom centre, above the tool capsule). `toast()` can be called from anywhere, including
the store (`converter.ts` `toastRvtUnavailable`). Its look is restyled in `styles.css` (`.brush-toast`) to match
the capsule.

## Alternatives considered

- **A hand-written notice** like `SelectNotice` (`select/SelectLayers.tsx`): no dependency, but no stacking, swipe to
  dismiss, timers paused on hover, or screen-reader announcements without writing them ourselves.
- **Radix Toast**: unstyled and needs a provider plus local state per toast; more code for the same result.

## Consequences

- About 10 kB gzipped in the main bundle. Sonner injects its own base CSS at import.
- Other notices (`SelectNotice`, inline errors) can move to `toast()` later; this change only moves the `.rvt`
  message.
