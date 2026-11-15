# 0010 Editor chrome on shadcn/ui (Tailwind CSS 4, Radix)

Date: 2026-11-15

## Context

The editor's controls (buttons, menus, popovers, the photo-import dialog, switches, sliders, segmented controls,
checkboxes, selects) were hand-written, each with its own CSS in `styles.css`. They looked slightly different from
one another, and every new panel copied another one's markup. Menus and popovers closed on outside pointer-down
only, had no keyboard navigation and no focus handling.

## Decision

1. **shadcn/ui components, set up with the shadcn CLI** (`pnpm dlx shadcn@4.23.0 init` / `add`, style `radix-nova`).
   The component source is copied into `src/app/components/ui/` and is ours to change; `components.json` records the
   setup so `pnpm dlx shadcn@4.23.0 add <name>` adds more. The CLI is not a dependency.
2. **Keep the colour theme.** `styles.css` maps shadcn's tokens onto the existing palette: `--primary` is the navy
   (`--brand`), `--accent` the blush selection colour, `--card`/`--popover` the capsule surface, `--destructive`
   the error red, rings in the light blue. Inter stays the font; `text-sm` is 12.5 px to keep the 12 px type scale.
   The editor's own colour variables `--accent*` and `--muted` are renamed `--brand*` and `--text-muted`, since
   shadcn uses those names.
3. **The board stays as it was.** Sheets, overlays, the capsule frame, the inspect table and the hand-drawn tool
   icons keep their CSS, now inside `@layer components` so a utility class on a component always wins.
4. **Local changes to generated components**, kept small: `Button` sizes `touch` / `icon-touch` (the design's
   44 px targets), `Slider` takes `thumbLabel` (accessible name of the thumb), the destructive alert keeps the old pink tint, the dialog overlay uses the old dim
   colour without a backdrop blur (blurring over large canvases is slow). `shadcn.css` vendors the data-attribute
   variants from `shadcn/tailwind.css`.

New dependencies (exact versions): `tailwindcss` 4.3.5, `@tailwindcss/vite` 4.3.5, `tw-animate-css` 1.4.0 (dev);
`radix-ui` 1.8.1, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 1.72.0.

## Alternatives considered

- **Keep hand-written controls and unify their CSS.** No dependencies, but we would re-implement focus management,
  keyboard navigation, collision-aware positioning and dialog semantics that Radix already gets right.
- **A packaged component library (MUI, Mantine, Chakra).** Brings its own design language and theming system, and
  the components cannot be edited. shadcn copies plain source we own, styled with the same tokens as our CSS.
- **shadcn's Base UI flavour** instead of Radix. Radix's ToggleGroup and Switch give the radio / pressed / checked
  ARIA states the e2e tests already read.

## Consequences

- Tests that drove native inputs now drive the components: sliders by keyboard (`setSlider` in `m1.spec.ts`),
  filter checkboxes by `[data-category]` (a `button role=checkbox`), the Live switch's state by `aria-checked`.
- Menus, the colour picker and the Revit panel render in a portal at the end of `<body>`.
- Radix components cost more to render than the old buttons (the left sidebar went from ~2.5 to ~13 ms per render
  in dev), and re-rendering it on every stroke doubled ink latency. Panels that only show settings read
  `useSessionField('settings' | 'tool' | ...)` instead of `useSession()`, so they no longer re-render while the pen
  draws. Ink latency and first hypothesis are back to their earlier values.
- Tailwind's preflight is on. `.world img, .world canvas, .world svg` opt out of its `max-width: 100%`.
