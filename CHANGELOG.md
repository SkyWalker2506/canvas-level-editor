# Changelog

## Unreleased

### Added
- `AUDIT.md` — first formal audit of golf-specific code in `editor-core.js`. Lists ~80 hard-coded references to golf entities (`ballStart`, `hole`, `maxShots`, `starShots`, theme defaults) and the proposed plugin-layer extraction plan.

### Notes
This release is documentation-only — no behavioral changes. The audit unblocks an upcoming v0.2 refactor to push golf-specific entities behind a plugin contract (`config.entities`, `config.fieldset`).

## 0.1.x — 2026-04-29

- Snap obstacle dragging to grid.
- Make obstacle dragging follow pointer.
- Stop obstacle resize drag on mouseup.
- Config-driven obstacle resize handles.
- Cursor-hover fix for water resize handles.

## 0.1.0 — 2026-04-28

- Initial extract from golf-paper-craft. Core: storage/UI/prefab system. Golf-specific layer (typeIcons, builtinPrefabs, draw renderers) lives in the host plugin.
