# Changelog

## 0.2.0 — 2026-05-03 — schema-descriptor migration (phase 1)

### Added
- `config.leftPad` — number, canvas left margin (was hardcoded `LEFT_PAD = 25`).
- `config.levelDataDefaults` — `() => object`, returns the initial `level.data` shape used when the host clicks "New Level". Hosts can now declare their entity defaults (e.g. golf supplies `{ ballStart, hole, maxShots, starShots, ... }`) instead of inheriting golf-flavored hardcodes from core.
- `config.themeDefaults` — `{ sky1, sky2, ground, dirt }`, fallback palette when a course has no `theme` block. Used by sky-gradient and ground-fill renderers.
- `config.thumbnailThemes` — `{ [themeName]: { sky, ground } }`, used by the level-list mini-preview swatches. Replaces the previously hardcoded `night`/`desert` golf-flavored color pairs.
- `config.migrationFields` — `{ [field]: { type:'number'|'array3', default } }`, declarative legacy-data normalization. Replaces hardcoded `maxShots`/`starShots` migration logic with a generic loop.

### Changed
- Default-level construction (`createDefaultLevel`) now calls `LEVEL_DATA_DEFAULTS()` instead of inlining golf-named keys.
- Level-list thumbnail color logic now reads from `config.thumbnailThemes` + `THEME_DEFAULTS` instead of hardcoded `'night'`/`'desert'` strings.
- Sky-gradient inline fallback now prefers `THEME_DEFAULTS.sky1/sky2` before the legacy `'#87ceeb'`/`'#e0f0ff'` literals.

### Backwards compatibility
- All v0.2 options are optional. When omitted, core falls back to the previous golf-flavored defaults so existing hosts (golf-paper-craft, demo.html) keep working unchanged.

### Deferred to a later v0.x
- Direct `ballStart` / `hole` field access for hit-test, drag, keyboard tools, property-panel inputs, course-rule enforcement, and context menu (~40+ remaining sites). These require a `pointEntities` registry (declared in `AUDIT.md`) plus a parallel rewrite of the property-panel `fieldset`. Tracked as the v0.3 milestone.
- `LEFT_PAD` is now configurable but still globally applied; per-axis padding (top/bottom) remains hardcoded.

### Result
Pre: 80 golf-named hardcoded references in `editor-core.js`.
Post: ~60 (reduction of ~20). Specifically removed: theme-default literals (3), thumbnail-theme literals (2), level-data-default block (8), migration block (5), `LEFT_PAD` constant (1), inline sky-fallback literals (2). All `ballStart` / `hole` runtime field access remains and is the v0.3 target.

## 0.1.x — 2026-04-29

## 0.1.x — 2026-04-29

- Snap obstacle dragging to grid.
- Make obstacle dragging follow pointer.
- Stop obstacle resize drag on mouseup.
- Config-driven obstacle resize handles.
- Cursor-hover fix for water resize handles.

## 0.1.0 — 2026-04-28

- Initial extract from golf-paper-craft. Core: storage/UI/prefab system. Golf-specific layer (typeIcons, builtinPrefabs, draw renderers) lives in the host plugin.
