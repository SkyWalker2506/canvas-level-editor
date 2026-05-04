# Changelog

## 0.3.0 — 2026-05-03 — point-entity registry + per-axis padding (phase 2)

### Added
- `config.pointEntities` — declarative array of singleton entities stored at `level.data[id]` as `{x,y}`. Each entry: `{ id, label, toolKey, selectedKind, defaults, hitTest, highlight, miniMap, draw, dragAxis, formField, courseRule }`. Replaces hardcoded `ballStart` / `hole` field access throughout the engine (hit-test, drag, keyboard nudge, mini-map, property-panel form binding, course-rule lookup, scroll-to-selection, paste-fallback insert X, raw-data wrap detection, import validation, default-scene bootstrap).
- `config.padding` — `{ top, right, bottom, left }` per-axis canvas padding. Replaces single `leftPad`. Backwards-compat: when `padding` is omitted, `leftPad` is used as `padding.left`; remaining axes default to `0`.

### Changed
- Render loop now iterates `POINT_ENTITIES` and dispatches per-entity `draw` (or falls through to legacy `config.drawBall` / `config.drawHole`).
- `hitTest()` walks `POINT_ENTITIES` in registration order using each entity's `hitTest` function — no hardcoded ball/hole bbox math.
- Drag origin/move + arrow-key nudge dispatch via `PE_BY_ID` / `PE_BY_KIND` lookup; entity-id is captured on the drag state so unknown host entities work.
- Numeric tool shortcuts (`3`, `4`) now bind to the first / second registered point entity's `toolKey` instead of hardcoded `'ballStart'` / `'hole'` strings.
- `Home` / `End` keyboard shortcuts scroll to first / last registered point entity.
- Mini-map markers iterate the registry and use each entity's `miniMap.color` + `miniMap.radius`.
- Property panel `bindConfig` / `wireConfig` now read/write the entity X coordinate via `entity.formField.x` (input id) instead of hardcoded `in-ballX` / `in-holeX`.
- Course-rule locking generalized: any entity declaring `courseRule: 'someKey'` is locked when `course.rules[someKey]` is a number.
- Import validation enforces `{x,y}` numeric coords on every registered entity (was hardcoded ballStart+hole).
- Default-scene bootstrap (course-create with `defaultLevel`) now seeds via `LEVEL_DATA_DEFAULTS()` + `peEnsure()` rather than literal `ballStart`/`hole` fields.

### Backwards compatibility
- All v0.3 options are optional. When `pointEntities` is omitted, an internal default registry mirrors the historic golf shape (`ballStart` + `hole`) so existing hosts (golf-paper-craft) keep working unchanged with no plugin changes required.
- `leftPad` is still honored as a deprecated alias for `padding.left`.

### Deferred to v0.4
- Property-panel HTML fieldset is still author-supplied (the host's `editor.html` declares `<input id="in-ballX">` etc.). Schema-driven form generation (declarative `fieldset` config that builds inputs at runtime) deferred to v0.4 — the registry now describes the binding, but the inputs themselves still live in host HTML. See AUDIT.md.
- `maxShots` / `starShots` are still golf-named in the property panel HTML and `wireConfig` write block; generic `numericField` schema deferred to v0.4.

### Result
Pre: ~60 golf-named hardcoded references in `editor-core.js` (post-v0.2 baseline).
Post: ~12 (mostly: schema fallback comments, internal default-registry definition, and `LEVEL_DATA_DEFAULTS` legacy block — none of these are runtime field access). All runtime `lvl.data.ballStart` / `lvl.data.hole` reads/writes have been replaced with registry-driven dispatch.

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
