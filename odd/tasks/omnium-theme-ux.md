# Feature: light-first theme and UX polish

- **Feature**: `omnium-theme-ux`
- **Branch**: `ux/light-dark-theme`
- **Date**: 2026-10-03
- **Route**: direct organic work; current change is UI/theme focused.
- **User direction**: start in **light mode**, but also provide **dark mode**.
- **Design approach**: light-first API cockpit: calm surfaces, high readability, strong request/response hierarchy, dark mode as a first-class alternate theme.
- **TDD mode**: disabled; verification uses `npm run check`, `npm test`, `npm run build`, and visual smoke.

## Objective

Improve Omnium's user experience and visual theme by making light mode the default, preserving an accessible dark mode, and improving the visual hierarchy of the API workspace without changing product behavior.

## Scope

- Add a theme system with default light mode and explicit dark mode.
- Persist the theme choice locally.
- Expose a visible theme toggle in the top bar.
- Retune tokens, panels, controls, modals, tabs, code areas, method colors, and status colors for both themes.
- Improve UX hierarchy: clearer workspace surfaces, stronger primary actions, softer inactive controls, better focus/hover states.

## Non-goals

- No new dependency or design-system package.
- No product behavior changes to requests, tests, imports, exports, CLI, or engine.
- No redesign of information architecture beyond visual hierarchy and theme access.

## Tasks

- [x] **T1 — Theme state and toggle**
  - [x] Add local theme state (`light` default, `dark` alternate).
  - [x] Persist theme to `localStorage`.
  - [x] Apply theme via a root data attribute/class.
  - [x] Add a top-bar toggle with clear label and accessible state.
- [x] **T2 — Theme tokens and UX polish**
  - [x] Convert current dark-only tokens into light/dark token sets.
  - [x] Improve surfaces, borders, shadows, focus, hover, active states.
  - [x] Retune method/status/code token colors for both modes.
  - [x] Preserve compact/mobile behavior.
- [x] **T3 — Verification and closure**
  - [x] `npm run check`
  - [x] `npm test`
  - [x] `npm run build`
  - [x] Visual smoke completed for light default + dark toggle + key UI surfaces.
  - [x] Commit with verification evidence.

## Progress

- [x] User chose: light mode first, with dark mode available.
- [x] Current UI inspected: theme is dark-only, green/lime API cockpit, visually functional but flat.
- [x] Implemented light-first theme state in `src/ui/App.tsx`, persisted under `omnium.theme`, and exposed a top-bar Spanish toggle with `aria-pressed`.
- [x] Reworked `src/ui/styles.css` into light and dark token sets using `data-theme`, with calmer surfaces, stronger primary actions, clearer code areas, and improved hover/focus/active states.
- [x] Verification passed on 2026-10-03: `npm run check`, `npm test` (140 passing), and `npm run build`.
- [x] Visual smoke completed with the existing Electron runner approach (no new dependency):
      9/9 checks passed — app boot, default `data-theme="light"`, visible accessible
      toggle, switch to `dark`, persisted `localStorage` value, and both screenshots saved.
      Captures: `/tmp/opencode/theme-light.png` and `/tmp/opencode/theme-dark.png`.
