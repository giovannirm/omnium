# Feature: professional UX plus Bruno/JMeter parity pass

- **Feature**: `omnium-professional-parity`
- **Branch**: `master` (explicit user request: merge directly into master)
- **Date**: 2026-10-03
- **Route**: delegated direct work; one substantial work unit.
- **User request**: improve everything in one pass: professional look and feel, better JMeter support, Bruno Git-style sync.
- **TDD mode**: disabled; verification uses `npm run check`, `npm test`, `npm run build`, and visual smoke when feasible.

## Objective

Turn the current “basic interchange + theme polish” into a more professional product slice:

1. A more coherent, professional UI/UX look and feel.
2. Bruno support that understands a Git-friendly project layout instead of only loose `.bru` files.
3. JMeter import that preserves more executable load-plan intent and extraction/config metadata.

## Scope

- **Professional UI/UX**
  - Refine light/dark themes beyond token polish: stronger shell hierarchy, professional surfaces, action hierarchy, top-bar density, active states, and readability.
  - Keep the existing product architecture and Spanish UI copy.
- **Bruno Git project support**
  - Import a Bruno project-like JSON/files shape where possible in core.
  - Export a collection as a Bruno project file set: `bruno.json`, optional folder files, and stable request `.bru` paths for Git diffs.
  - Keep loose `.bru` import/export compatibility.
- **JMeter advanced import**
  - Improve preservation of ThreadGroup/load-plan intent, CSV datasets, header/config scope, response assertions, and common post-processors/extractors as warnings or Omnium variables/extractors where model support exists.
  - Be explicit with warnings when JMeter behavior cannot run natively.

## Non-goals

- No dependency-heavy browser automation package.
- No full JMeter runtime clone.
- No full Bruno desktop clone.
- No remote execution beyond pushing the final `master` commit.

## Tasks

- [x] **T1 — UX/design pass**
  - [x] Review current light/dark UI and improve professional look-and-feel.
  - [x] Improve shell, panel, control, and active-state hierarchy.
  - [x] Preserve accessibility and theme persistence.
- [x] **T2 — Bruno Git project support**
  - [x] Add core support for Bruno project export file sets.
  - [x] Add import support for project file sets / folder metadata where feasible.
  - [x] Update UI/export dispatcher and tests.
- [x] **T3 — JMeter advanced import**
  - [x] Preserve load-plan/thread-group hints in warnings or collection metadata available to Omnium.
  - [x] Improve CSV and post-processor handling.
  - [x] Add tests for the new JMeter behaviors.
- [ ] **T4 — Verification and delivery**
  - [x] `npm run check`
  - [x] `npm test`
  - [x] `npm run build`
  - [x] Visual smoke feasibility assessed: no existing Electron visual smoke script or browser automation dependency in `package.json`; skipped to avoid adding dependency-heavy tooling.
  - [ ] Commit directly on `master` and push `origin/master`.

## Progress

- [x] User clarified the previous result was not enough: JMeter not complete, Bruno lacks Git sync, design not professional enough.
- [x] Implemented one direct work unit on `master` with professional shell styling, Bruno project file-set export/import core support, and richer JMeter metadata/extractor/assertion import.
- [x] Verification passed locally: `npm run check`, `npm test` (142 passing), `npm run build`.
- [ ] Commit and push pending.

## Notes and limits

- Bruno project export now emits `bruno.json` and stable `.bru` paths, but browser downloads are still individual files; users must preserve those names/rutas when moving them into a Git repository.
- JMeter ThreadGroup and CSV runtime behavior are preserved as structured warnings/variables, not as a native JMeter runtime clone.
- RegexExtractor is warned with target variable/regex because Omnium extractors support JSON/header paths, not arbitrary regex extraction.
