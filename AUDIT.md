# Golf-Specific Leakage Audit (2026-05-04)

Goal of canvas-level-editor: a generic 2D level editor that any browser-game project can host via a plugin.

> **Phase 3 status (v0.4.0, 2026-05-04):** declarative `formSchema` + `EditorCore.renderPropertyPanel(container)` shipped. The last hardcoded `in-maxShots` / `in-starShots` runtime reads/writes in `bindConfig`/`wireConfig` have been replaced with dotted-path resolution (`level.data.maxShots`, `level.data.starShots[0]`). Host HTML now declares only a `<div id="generated-level-settings">` mount point — the engine generates labeled inputs from the schema. Legacy hardcoded write block remains opt-in gated by `_FORM_HANDLED_IDS` for backwards compat. See CHANGELOG 0.4.0.
>
> **Deferred to v0.5:** migrate `name` / `subtitle` / `description` / `worldW` / `time` to `formSchema` (currently still hardcoded `in-name` etc. in `bindConfig`); migrate `in-court` / `in-slot` + `slot-warning` widget to a sibling `metaSchema` config; remove `LEVEL_DATA_DEFAULTS` golf-named legacy fallback once `levelDataDefaults` is treated as required when `formSchema` is supplied.
>
> **Phase 2 status (v0.3.0, 2026-05-03):** point-entity registry + per-axis padding shipped. All runtime `lvl.data.ballStart` / `lvl.data.hole` access has been replaced with `config.pointEntities` registry dispatch (hit-test, drag, mini-map, keyboard nudge, scroll-to-selection, paste-fallback, raw-data wrap detection, import validation, property-panel form binding, course-rule lock, default-scene bootstrap). See CHANGELOG 0.3.0.
>
> **Phase 1 status (v0.2.0, 2026-05-03):** ~20 of 80 references extracted via `config.leftPad`, `config.levelDataDefaults`, `config.themeDefaults`, `config.thumbnailThemes`, `config.migrationFields`. See CHANGELOG 0.2.0.

## Status

Plugin contract for **rendering** is clean — `config.draw*` callbacks, `config.typeIcons`, `config.builtinPrefabs`, etc. are golf-agnostic and host-supplied.

Plugin contract for **level schema** is leaky. `editor-core.js` directly reads/writes golf entities:

| Entity        | Refs | Location (line) | Notes |
|---------------|------|-----------------|-------|
| `ballStart`   | ~22  | 348, 424, 429, 464, 550, 806–807, 1040–1041, 1643, 1651–1656, 1695 | hard-coded `{x,y}` in default level + form input + course rule |
| `hole`        | ~12  | 348, 819, 1042, 1644, 1696 | golf hole entity |
| `maxShots`    | ~5   | 364, 552, 1624, 1637, 1684 | golf shot budget |
| `starShots`   | ~10  | 365–366, 553, 1624, 1638–1642, 1686–1692 | golf 3-star thresholds |
| `theme` defaults | ~3 | 632, 1355 | golf-flavored sky/ground/dirt fallback colors |
| `LEFT_PAD` shift | ~6 | 806, 819, 1040, 1042 | golf-specific 25px breathing offset |

## Recommended v0.2 Extraction Plan

Replace direct golf field access with a **schema descriptor** the host supplies:

```js
EditorCore.mount({
  schema: {
    defaults: () => ({ ballStart: {x:100,y:GY-30}, hole: {x:600,y:GY-12}, maxShots:5, starShots:[2,3,4] }),
    pointEntities: [
      { key: 'ballStart', label: 'Ball', radius: 18, draw: drawBall },
      { key: 'hole',      label: 'Hole', radius: 18, draw: drawHole },
    ],
    fieldset: [
      { id: 'in-maxShots',  bind: 'maxShots',  type: 'int', default: 5 },
      { id: 'in-starShots', bind: 'starShots', type: 'csv-int[3]', default: [2,3,4] },
    ],
  },
});
```

The core would then iterate `pointEntities` for hit-test/render and `fieldset` for the property panel — no golf names in core.

## Why not now

80 references across ~2.7k LOC. The golf project has no test suite for the editor, and a partial extraction risks live regressions. Tracked here so the next dedicated refactor pass can execute it in isolation.

## Files

- `editor-core.js` — main offender (80 hits)
- `editor-core.css` — clean (no golf-specific rules)
- `demo.html` — clean (uses generic plugin shape)
