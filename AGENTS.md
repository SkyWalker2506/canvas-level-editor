# AGENTS.md — canvas-level-editor rules

**Bu paket oyunlara embed edilen generic 2D level editor engine'idir. Oyun-spesifik kod YAZILMAZ buraya.**

## Separation of concerns

| Package (engine, github.com/SkyWalker2506/canvas-level-editor) | Game/project side |
|----------------------------------------------------------------|-------------------|
| `editor-core.js` — canvas render, drag/drop, selection, tools UI | `schema` — oyun obje tipleri + alanlar |
| `editor-core.css` — editor UI stili                            | `courses` — level listesi + kurallar |
| Generic API: `CanvasLevelEditor.create(config)`                 | `typeColors`, `assetTooltips`, `builtinPrefabs` |
| Rendering hooks, input handling                                 | Export/save format, engine-side runtime |

## Kurallar

- **Generic fix** (engine bug, render issue, UX) → pakete git → `contribute.sh` ile geri al → push
- **Game-specific code** (bir oyunun level rules'ı, custom obje tipi) → `tools/canvas-level-editor/` DIŞINA yaz; config olarak inject et
- `editor-core.js` içinde oyun-spesifik sabit (örn: bir obje tipi adı, rule) göremezsin. Olursa PR reddet.

## Workflow

```bash
# Install
./install.sh /path/to/Game

# Update (paket güncellendiğinde)
./update.sh /path/to/Game

# Contribute (projede fix ettin → pakete yolla)
./contribute.sh /path/to/Game
```

## API contract

```js
CanvasLevelEditor.create({
  schema,           // { typeName: { fields, defaults } }
  courses,          // { id: { name, slotCount, gameKey, theme, allowed, rules? } }
  typeColors,       // { typeName: '#rrggbb' }
  assetTooltips,    // { typeName: 'description' }
  builtinPrefabs,   // [{ id, name, desc, course?, obstacles[] }]
  courseNames,      // { id: 'Name' }
  groundY,          // px from top
  canvasHeight,     // px
});
```

Engine knows NOTHING about specific games. Injection is the only contract.
