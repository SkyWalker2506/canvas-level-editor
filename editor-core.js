// canvas-level-editor — Generic 2D level editor engine
// Usage: window.CanvasLevelEditor.create(config)
// All game-specific logic (rendering, schema, courses) is injected via config.
// No external dependencies — pure vanilla JS.

window.CanvasLevelEditor = (() => {
  'use strict';

  // ---------- create(config) ----------
  // The single public entry point. Call once after DOM is ready.
  //
  // Required config fields:
  //   schema           — { [typeName]: { fields, defaults } }
  //   courses          — { [id]: { name, slotCount, gameKey, theme, allowed, rules? } }
  //   typeColors       — { [typeName]: '#rrggbb' }
  //   assetTooltips    — { [typeName]: 'description' }
  //   builtinPrefabs   — array of { id, name, desc, course?, obstacles[] }
  //   courseNames      — { [id]: 'Name' }
  //   groundY          — number (pixels from top where ground sits)
  //   canvasHeight     — number
  //
  // Optional storage key overrides (all have sensible defaults):
  //   storageKey, syncKey, publishHistoryKey, settingsKey, prefabsKey
  //
  // Rendering hooks (all receive a canvas 2D context):
  //   drawObstacle(ctx, o, selected, zoom, lvlData)
  //   drawBall(ctx, pos, zoom)       — optional, core draws a white circle
  //   drawHole(ctx, pos, zoom)       — optional, core draws a red-flag hole
  //   drawSky(ctx, W, H, time)       — optional
  //   drawGround(ctx, W, groundY, zoom, theme) — optional
  //
  // Validation:
  //   validateLevel(level, courseObj) — returns [{ level, msg, obstacleIdx? }]
  //
  // Data loading:
  //   onLoadFromGame(callback)       — called when user clicks "Reload from data.js"
  //                                    callback(importedLevels) or throws
  //
  // Course UI:
  //   courseNames                    — shown in sync panel chips

  // ---------- Config validation ----------
  const validateConfig = (config) => {
    if (!config.schema || Object.keys(config.schema).length === 0)
      console.warn('[CanvasLevelEditor] config.schema is missing or empty — no obstacle types will be available');
    if (!config.courses)
      console.warn('[CanvasLevelEditor] config.courses is missing — course features will not work');
    if (!config.drawObstacle)
      console.warn('[CanvasLevelEditor] config.drawObstacle is missing — obstacles will not render');
  };

  const create = (config) => {
    validateConfig(config);

    // ---------- Config with defaults ----------
    const STORAGE_KEY        = config.storageKey        || 'canvas_editor_v1';
    const SYNC_KEY           = config.syncKey           || 'canvas_editor_sync';
    const PREVIEW_KEY        = config.previewKey        || 'canvas_editor_preview';
    const PUBLISH_HISTORY_KEY= config.publishHistoryKey || 'canvas_editor_publish_history';
    const SETTINGS_KEY       = config.settingsKey       || 'canvas_editor_settings';
    const PREFABS_KEY        = config.prefabsKey        || 'canvas_editor_prefabs';
    const BACKUP_KEY         = config.backupKey         || 'canvas_editor_backup_v1';
    const GY                 = config.groundY           ?? 380;
    const CANVAS_H           = config.canvasHeight      ?? 540;
    const SCHEMA             = config.schema            || {};
    const COURSES            = config.courses           || {};
    const TYPE_COLORS        = config.typeColors        || {};
    const ASSET_TOOLTIPS     = config.assetTooltips     || {};
    const TYPE_ICONS         = config.typeIcons         || {};
    const COURSE_NAMES       = config.courseNames       || {};
    const BUILTIN_PREFABS    = config.builtinPrefabs    || [];

    const TYPES = Object.keys(SCHEMA);
    const HISTORY_MAX = 50;

    // ---------- Feature 3: Configurable CSS theme variables ----------
    if (config.theme && typeof config.theme === 'object') {
      const cssVars = Object.entries(config.theme)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join('\n');
      const styleTag = document.createElement('style');
      styleTag.id = 'canvas-editor-theme';
      styleTag.textContent = `:root {\n${cssVars}\n}`;
      document.head.appendChild(styleTag);
    }
    const PUBLISH_HISTORY_MAX = 20;
    const LEFT_PAD = 25;
    const GRID = 20; // default grid size (5–100 valid range)

    // ---------- Dirty flag ----------
    let _isDirty = false;

    // ---------- DOM refs ----------
    const $ = (id) => document.getElementById(id);
    const canvas = $('editor-canvas');
    const ctx = canvas.getContext('2d');

    // ---------- State ----------
    const state = {
      levels: [],
      currentIdx: -1,
      selectedObs: -1,
      selectedObsList: [],
      selectedKind: null,
      marquee: null,
      tool: 'select',
      zoom: 1,
      showGrid: true,
      showRuler: false,
      showOverlaps: false,
      snap: true,
      snapToObstacles: true,
      drag: null,
      sync: { enabled: false, updatedAt: null, courses: {} },
      history: [],
      future: [],
      publishHistory: [],
      suppressHistory: false,
      recentTypes: [],
      userPrefabs: [],
      smartGuideX: null,
      snapGuideLines: null, // { x1, y1, x2, y2 } for obstacle snap guides
      _gameWin: null,
      hiddenTypes: new Set(),
      sortMode: 'none',
      lockedObs: new Set(),
      gridSize: config.gridSize || GRID,
      _worldResizeHover: false,
      _worldResizeDrag: null,
      _obsResizeHover: null,
      _obsResizeDrag: null,
      pasteOffset: config.pasteOffset ?? 20,
      _pasteCount: 0,
      _lastClipboardKey: null,
      _savedSnapshot: null,
      pendingPrefab: null,
      pendingPrefabX: 0,
      commands: [],
      showValidationBadges: true,
      _validationBadges: [] // cached per render: {idx, level, msg, cx, cy, r}
    };

    // ---------- Event system ----------
    const _listeners = {};
    const emit = (event, data) => {
      (_listeners[event] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } });
    };

    // ---------- Utilities ----------
    const toast = (msg, ms = 2000) => {
      const t = $('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => t.classList.remove('show'), ms);
    };
    const cloneDeep = (o) => JSON.parse(JSON.stringify(o));
    const _flashObsCount = (direction) => {
      const el = $('obstacle-count'); if (!el) return;
      el.classList.remove('obs-count-add', 'obs-count-remove');
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add(direction === 'add' ? 'obs-count-add' : 'obs-count-remove');
      clearTimeout(_flashObsCount._t);
      _flashObsCount._t = setTimeout(() => {
        el.classList.remove('obs-count-add', 'obs-count-remove');
      }, 600);
    };
    const snap = (v) => state.snap ? Math.round(v / state.gridSize) * state.gridSize : Math.round(v);

    // ---------- rAF-batched render ----------
    let _rafPending = false;
    const scheduleRender = () => {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => { _rafPending = false; render(); });
    };

    // ---------- Storage ----------
    const isQuotaError = (e) => {
      if (!e) return false;
      return e.code === 22 || e.code === 1014 ||
        e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        /quota/i.test(e.message || '');
    };
    const safeSetItem = (key, value, label = 'data') => {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        if (isQuotaError(e)) {
          toast(`Storage full — ${label} not saved. Clear publish history or prefabs.`, 4000);
        } else {
          toast('Save failed: ' + (e.message || e), 3000);
        }
        return false;
      }
    };

    // ---------- Auto-save ----------
    let _autosaveTimer = null;
    const markDirty = () => {
      _isDirty = true;
      // Auto-clear diff overlay on edit
      const _diffEl = document.getElementById('level-diff-overlay');
      if (_diffEl) _diffEl.remove();
      clearTimeout(_autosaveTimer);
      _autosaveTimer = setTimeout(() => {
        try {
          if (safeSetItem(STORAGE_KEY, JSON.stringify(state.levels), 'levels')) {
            const lvl = state.levels[state.currentIdx];
            if (state._gameWin && !state._gameWin.closed && lvl) {
              writePreview(lvl);
              if (state.sync.enabled) publishSync({ announce: false });
            }
            const el = $('autosave-dot');
            if (el) {
              el.classList.add('saved');
              el.textContent = 'saved ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              setTimeout(() => { el.classList.remove('saved'); el.textContent = ''; }, 2500);
            }
            const sv = $('status-save');
            if (sv) {
              sv.style.display = '';
              clearTimeout(markDirty._flash);
              markDirty._flash = setTimeout(() => { sv.style.display = 'none'; }, 1800);
            }
          }
        } catch (_) {}
        _isDirty = false;
        if (config.onChange) {
          try { config.onChange(cloneDeep(state.levels[state.currentIdx])); } catch (_) {}
        }
      }, 800);
    };

    // ---------- Undo / Redo ----------
    const takeSnapshot = () => ({
      levels: cloneDeep(state.levels),
      currentIdx: state.currentIdx,
      selectedObs: state.selectedObs,
      selectedObsList: state.selectedObsList.slice(),
      selectedKind: state.selectedKind
    });
    const applySnapshot = (s) => {
      state.suppressHistory = true;
      state.levels = cloneDeep(s.levels);
      state.currentIdx = s.currentIdx;
      state.selectedObs = s.selectedObs;
      state.selectedObsList = (s.selectedObsList || (s.selectedObs >= 0 ? [s.selectedObs] : [])).slice();
      state.selectedKind = s.selectedKind;
      state.suppressHistory = false;
    };
    let _lastHistoryTs = 0;
    const pushHistory = (force = false, label = '') => {
      if (state.suppressHistory) return;
      const now = Date.now();
      if (!force && now - _lastHistoryTs < 150) return;
      _lastHistoryTs = now;
      const snap = takeSnapshot();
      snap.label = label;
      state.history.push(snap);
      if (state.history.length > HISTORY_MAX) state.history.shift();
      state.future.length = 0;
      updateHistoryUI();
      markDirty();
      emit('historyPush', { label, historyLength: state.history.length });
    };
    const undo = () => {
      if (!state.history.length) return;
      const label = state.history[state.history.length - 1]?.label || 'change';
      state.future.push(takeSnapshot());
      applySnapshot(state.history.pop());
      render();
      toast('Undo: ' + label);
      emit('undo', { label });
    };
    const redo = () => {
      if (!state.future.length) return;
      const label = state.future[state.future.length - 1]?.label || 'change';
      state.history.push(takeSnapshot());
      applySnapshot(state.future.pop());
      render();
      toast('Redo');
      emit('redo', { label });
    };
    const updateHistoryUI = () => {
      const u = $('btn-undo'); const r = $('btn-redo');
      if (u) {
        u.disabled = !state.history.length;
        // Feature 5: tooltip listing last 5 undo labels
        const undoLabels = state.history.slice(-5).reverse().map((s, i) => `${i + 1}. ${s.label || 'change'}`);
        u.title = undoLabels.length ? 'Undo:\n' + undoLabels.join('\n') : 'Nothing to undo';
      }
      if (r) {
        r.disabled = !state.future.length;
        // Feature 5: tooltip listing next 5 redo labels
        const redoLabels = state.future.slice(-5).reverse().map((s, i) => `${i + 1}. ${s.label || 'change'}`);
        r.title = redoLabels.length ? 'Redo:\n' + redoLabels.join('\n') : 'Nothing to redo';
      }
    };

    // ---------- Storage: load/save ----------
    const save = () => {
      if (!safeSetItem(STORAGE_KEY, JSON.stringify(state.levels), 'levels')) return;
      _isDirty = false;
      state._savedSnapshot = cloneDeep(state.levels);
      publishSync({ announce: false });
      toast(state.sync.enabled ? 'Saved + synced to game' : 'Saved');
      if (config.onSave) { try { config.onSave(cloneDeep(state.levels)); } catch (_) {} }
    };
    // ---------- Session auto-backup (Feature 5) ----------
    const sessionBackup = () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) localStorage.setItem(BACKUP_KEY, raw);
      } catch (_) {}
    };
    const restoreBackup = () => {
      try {
        const raw = localStorage.getItem(BACKUP_KEY);
        if (!raw) { toast('No backup found'); return; }
        if (!confirm('Restore from session backup? Current work will be replaced.')) return;
        pushHistory(true, 'Restore backup');
        state.levels = JSON.parse(raw);
        state.currentIdx = Math.max(0, Math.min(state.currentIdx, state.levels.length - 1));
        render();
        toast('Backup restored');
      } catch (e) { toast('Restore failed: ' + e.message); }
    };

    const load = () => {
      // Save existing data as backup BEFORE overwriting
      sessionBackup();
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          state.levels = Array.isArray(parsed) ? parsed : [];

          // --- Migration / normalization ---
          // Older editor builds (or external tools) may store levels as plain level-data objects
          // or use different keys (courseId vs courtId). Normalize in-place so UI doesn't show
          // "undefined" and sync payloads stay valid.
          state.levels = state.levels
            .map((lvl) => {
              if (!lvl) return null;
              // If this looks like a raw level data blob, wrap it.
              if (!lvl.data && (lvl.worldW || lvl.ballStart || lvl.hole || lvl.obstacles)) {
                lvl = { courtId: null, slot: null, data: lvl };
              }
              if (!lvl.data || typeof lvl.data !== 'object') return null;
              if (lvl.courtId == null) {
                const cid = (lvl.courseId ?? lvl.course ?? null);
                if (cid != null && cid !== 'null') {
                  const n = parseInt(cid, 10);
                  if (!isNaN(n)) lvl.courtId = n;
                }
              }
              if (lvl.slot != null && typeof lvl.slot !== 'number') {
                const n = parseInt(lvl.slot, 10);
                lvl.slot = isNaN(n) ? null : n;
              }
              if (!Array.isArray(lvl.data.obstacles)) lvl.data.obstacles = [];
              if (typeof lvl.data.maxShots !== 'number') lvl.data.maxShots = 5;
              if (!Array.isArray(lvl.data.starShots) || lvl.data.starShots.length < 3) {
                lvl.data.starShots = [2, 3, 4];
              }
              return lvl;
            })
            .filter(Boolean);
          state._savedSnapshot = cloneDeep(state.levels);
        }
      } catch (e) { console.warn(e); }
      try {
        const rawSync = localStorage.getItem(SYNC_KEY);
        if (rawSync) {
          const s = JSON.parse(rawSync);
          state.sync.enabled = !!s.enabled;
          state.sync.updatedAt = s.updatedAt || null;
        }
      } catch (e) { console.warn(e); }
    };

    // ---------- Prefabs ----------
    const loadPrefabs = () => {
      try {
        const raw = localStorage.getItem(PREFABS_KEY);
        state.userPrefabs = raw ? (JSON.parse(raw) || []) : [];
      } catch (_) { state.userPrefabs = []; }
    };
    const savePrefabsToStorage = () => {
      safeSetItem(PREFABS_KEY, JSON.stringify(state.userPrefabs), 'prefabs');
    };
    const saveCurrentAsPrefab = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (state.selectedKind !== 'obs' || !state.selectedObsList.length) {
        toast('Select one or more obstacles first');
        return;
      }
      const name = prompt('Prefab name:', '');
      if (!name) return;
      if (state.userPrefabs.some(p => p.name === name)) {
        toast('A prefab named "' + name + '" already exists. Use a different name.');
        return;
      }
      // Filter out stale indices that no longer exist in the obstacles array
      const validIndices = state.selectedObsList.filter(i => i >= 0 && i < lvl.data.obstacles.length);
      if (!validIndices.length) { toast('No valid obstacles selected'); return; }
      const src = validIndices.map(i => cloneDeep(lvl.data.obstacles[i]));
      const minX = Math.min(...src.map(o => o.x ?? o.x1 ?? 0));
      src.forEach(o => {
        if ('x1' in o) { o.x1 -= minX; o.x2 -= minX; if (o.crocX != null) o.crocX -= minX; }
        else if ('x' in o) o.x -= minX;
      });
      const prefab = { id: 'user-' + Date.now(), name, desc: '', obstacles: src, user: true };
      state.userPrefabs.push(prefab);
      savePrefabsToStorage();
      renderPrefabs();
      toast('Saved prefab "' + name + '"');
    };
    const insertPrefab = (prefab, insertX) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (insertX == null) {
        // Insert at viewport center (like paste), falling back to ballStart + 150
        const w = document.getElementById('canvas-wrap');
        if (w && state.zoom) {
          insertX = Math.round(w.scrollLeft / state.zoom - LEFT_PAD + (w.clientWidth / state.zoom / 2));
        } else {
          insertX = lvl.data.ballStart.x + 150;
        }
        // Clamp to world bounds
        insertX = Math.max(0, Math.min(lvl.data.worldW - 50, insertX));
      }
      pushHistory(true);
      const newIds = [];
      prefab.obstacles.forEach(src => {
        const o = cloneDeep(src);
        if ('x1' in o) { o.x1 = snap(o.x1 + insertX); o.x2 = snap(o.x2 + insertX); if (o.crocX != null) o.crocX = snap(o.crocX + insertX); }
        else if ('x' in o) o.x = snap(o.x + insertX);
        lvl.data.obstacles.push(o);
        newIds.push(lvl.data.obstacles.length - 1);
      });
      state.selectedKind = 'obs';
      state.selectedObsList = newIds;
      state.selectedObs = newIds[newIds.length - 1];
      render();
      toast('Inserted ' + prefab.name);
    };
    const cancelPrefabPlace = () => {
      state.pendingPrefab = null;
      canvas.style.cursor = '';
      const bar = document.getElementById('prefab-place-bar');
      if (bar) bar.style.display = 'none';
      scheduleRender();
    };

    const startPrefabPlace = (prefab) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) { toast('Select a level first'); return; }
      state.pendingPrefab = prefab;
      // Default X to viewport center until mouse moves
      const w = document.getElementById('canvas-wrap');
      state.pendingPrefabX = w && state.zoom
        ? Math.round(w.scrollLeft / state.zoom - LEFT_PAD + w.clientWidth / state.zoom / 2)
        : lvl.data.ballStart.x + 150;
      canvas.style.cursor = 'crosshair';
      // Show cancel bar
      let bar = document.getElementById('prefab-place-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'prefab-place-bar';
        bar.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:#1a2a40;color:#fff;padding:8px 16px;border-radius:8px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.5);font-size:13px;';
        bar.innerHTML = `<span>Placing: <strong id="prefab-place-name"></strong> — click canvas to place</span><button id="prefab-place-cancel" style="background:#c0392b;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;">Cancel</button>`;
        document.body.appendChild(bar);
        document.getElementById('prefab-place-cancel').addEventListener('click', cancelPrefabPlace);
      }
      document.getElementById('prefab-place-name').textContent = prefab.name;
      bar.style.display = 'flex';
      scheduleRender();
    };

    const deletePrefab = (id) => {
      state.userPrefabs = state.userPrefabs.filter(p => p.id !== id);
      savePrefabsToStorage();
      renderPrefabs();
    };
    const renderPrefabs = () => {
      const wrap = $('prefabs-list');
      if (!wrap) return;
      const course = currentCourse();
      const builtin = BUILTIN_PREFABS.filter(p => !course || p.course === course.id || !p.course);
      const all = [...builtin, ...state.userPrefabs];
      wrap.innerHTML = '';
      if (!all.length) { wrap.innerHTML = '<div class="empty-state">No prefabs.</div>'; return; }
      all.forEach(p => {
        if (!p || !Array.isArray(p.obstacles)) return; // skip malformed prefabs
        const card = document.createElement('div');
        card.className = 'prefab-card' + (p.user ? ' prefab-user' : '');
        card.innerHTML = `
          <div class="prefab-name">${p.name}</div>
          ${p.desc ? `<div class="prefab-desc">${p.desc}</div>` : ''}
          <div class="prefab-meta">${p.obstacles.length} obj${p.user ? ' · user' : ''}</div>`;
        card.title = 'Click to place on canvas';
        card.addEventListener('click', () => startPrefabPlace(p));
        if (p.user) {
          const del = document.createElement('button');
          del.className = 'prefab-delete';
          del.textContent = 'x';
          del.title = 'Delete prefab';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete prefab "' + p.name + '"?')) deletePrefab(p.id);
          });
          card.appendChild(del);
        }
        wrap.appendChild(card);
      });
    };

    // ---------- Course helpers ----------
    const currentCourse = () => {
      const lvl = state.levels[state.currentIdx];
      if (lvl && lvl.courtId != null) return COURSES[lvl.courtId];
      const sel = $('filter-court')?.value;
      if (sel && sel !== 'all' && sel !== 'null') {
        const id = parseInt(sel, 10);
        if (COURSES[id]) return COURSES[id];
      }
      return null;
    };

    // ---------- Level factory ----------
    const newLevel = () => {
      let courtId = null;
      const sel = $('filter-court')?.value;
      if (sel && sel !== 'all' && sel !== 'null') {
        const id = parseInt(sel, 10);
        if (COURSES[id]) courtId = id;
      }
      const course = courtId != null ? COURSES[courtId] : null;
      const def = course?.defaultLevel ? cloneDeep(course.defaultLevel) : {};
      return {
        courtId,
        slot: null,
        data: Object.assign({
          name: 'New Level',
          subtitle: '',
          description: '',
          worldW: 800,
          time: 0.3,
          ballStart: { x: 100, y: GY - 30 },
          hole: { x: 700, y: GY },
          maxShots: 5,
          starShots: [2, 3, 4],
          obstacles: []
        }, def)
      };
    };

    // ---------- Load from game ----------
    const loadFromGame = async () => {
      if (config.onLoadFromGame) {
        if (state.levels.length && !confirm(
          `Replace the ${state.levels.length} level(s) currently in the editor with the game's data?`
        )) return;
        try {
          const imported = await config.onLoadFromGame();
          if (!imported || !imported.length) throw new Error('no levels found');
          const keepIdx = (state.currentIdx >= 0 && state.currentIdx < imported.length)
            ? state.currentIdx : 0;
          state.levels = imported;
          state.currentIdx = keepIdx;
          state.selectedObs = -1;
          state.selectedObsList = [];
          state.selectedKind = null;
          saveSettings();
          render();
          toast(`Loaded ${imported.length} levels from game`);
        } catch (e) {
          toast('Load failed: ' + e.message);
        }
      }
    };

    // ---------- Canvas rendering ----------
    const fitCanvas = () => {
      const wrapEl = $('canvas-wrap');
      const lvl = state.levels[state.currentIdx];
      const worldW = lvl ? lvl.data.worldW + LEFT_PAD * 2 : 1000;
      const maxW = wrapEl.clientWidth - 32;
      const maxH = wrapEl.clientHeight - 32;
      const fit = Math.min(maxW / worldW, maxH / CANVAS_H);
      state.zoom = Math.max(0.2, Math.min(2, fit));
      resizeCanvas();
    };
    const resizeCanvas = () => {
      const lvl = state.levels[state.currentIdx];
      const worldW = lvl ? lvl.data.worldW + LEFT_PAD * 2 : 1000;
      canvas.width = Math.floor(worldW * state.zoom);
      canvas.height = Math.floor(CANVAS_H * state.zoom);
      ctx.setTransform(state.zoom, 0, 0, state.zoom, 0, 0);
      const zl = $('zoom-label');
      if (zl) zl.textContent = Math.round(state.zoom * 100) + '%';
    };

    const highlightRect = (x, y, w, h) => {
      ctx.save();
      ctx.strokeStyle = '#ff5733';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.restore();
    };

    const renderCanvas = () => {
      const lvl = state.levels[state.currentIdx];
      if (!lvl) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#eee7d4';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No level selected', canvas.width / 2, canvas.height / 2);
        ctx.restore();
        return;
      }
      const L = lvl.data;
      const W = L.worldW + LEFT_PAD * 2;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const course = currentCourse();
      const theme = course ? course.theme : { sky1: '#c9e3ef', sky2: '#eaf4da', ground: '#9cc26d', dirt: '#7a5a38' };

      // Sky — plugin can override via drawSky
      if (config.drawSky) {
        config.drawSky(ctx, W, CANVAS_H, lvl.data.time);
      } else {
        const sky = ctx.createLinearGradient(0, 0, 0, GY);
        sky.addColorStop(0, theme.sky1 || '#87ceeb');
        sky.addColorStop(1, theme.sky2 || '#e0f0ff');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, GY);
      }

      // Ground — plugin can override via drawGround
      if (config.drawGround) {
        config.drawGround(ctx, W, GY, state.zoom, theme);
      } else {
        if (theme.ground) {
          ctx.fillStyle = theme.ground;
          ctx.fillRect(LEFT_PAD, GY, W - LEFT_PAD, CANVAS_H - GY);
        }
      }

      // Grid
      if (state.showGrid) {
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        for (let gx = 0; gx <= W; gx += GRID) {
          ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, CANVAS_H); ctx.stroke();
        }
        for (let gy = 0; gy <= CANVAS_H; gy += GRID) {
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath(); ctx.moveTo(0, GY); ctx.lineTo(W, GY); ctx.stroke();
      }

      // Obstacles — sort by _z for draw order (ascending = back to front)
      const obsDrawOrder = L.obstacles.map((o, i) => ({ o, i }))
        .sort((a, b) => ((a.o._z || 0) - (b.o._z || 0)));
      obsDrawOrder.forEach(({ o, i }) => {
        if (state.hiddenTypes.has(o.type)) return;
        const inSet = state.selectedKind === 'obs' &&
          (state.selectedObsList.length ? state.selectedObsList.includes(i) : i === state.selectedObs);
        if (config.drawObstacle) {
          ctx.save();
          try {
            const bbox = config.drawObstacle(ctx, o, inSet, state.zoom, L, LEFT_PAD, GY, CANVAS_H);
            if (inSet && bbox) highlightRect(bbox[0], bbox[1], bbox[2], bbox[3]);
            // Cache bbox from plugin return value OR from o._bbox set by plugin
            if (bbox) o._bbox = bbox;
          } catch (err) {
            console.warn('[CanvasLevelEditor] drawObstacle error on obstacle', i, err);
            const ex = (o.x ?? o.x1 ?? 0) + LEFT_PAD;
            const ey = o.y ?? GY - 20;
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(ex - 10, ey - 10, 20, 20);
          }
          // Draw lock indicator for locked obstacles
          if (state.lockedObs.has(i)) {
            const lx = (o.x ?? o.x1 ?? 0) + LEFT_PAD;
            const ly = o.y ?? GY - 20;
            ctx.save();
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = '#333';
            ctx.fillRect(lx - 6, ly - 8, 12, 10);
            ctx.fillRect(lx - 4, ly - 13, 8, 6);
            ctx.globalAlpha = 1;
            ctx.restore();
          }
          ctx.restore();
        }
      });

      // Obstacle resize handles (plugin-driven)
      if (config.getResizeHandles && state.selectedKind === 'obs' && state.selectedObs >= 0 && state.selectedObsList.length <= 1) {
        const o = L.obstacles[state.selectedObs];
        if (o) {
          let hs = [];
          try {
            hs = config.getResizeHandles(o, lvl, {
              leftPad: LEFT_PAD,
              groundY: GY,
              canvasH: CANVAS_H,
              zoom: state.zoom,
              snap,
            }) || [];
          } catch (_) { hs = []; }
          if (Array.isArray(hs) && hs.length) {
            const drawKnob = (h) => {
              const x = h.x ?? 0;
              const y = h.y ?? 0;
              const r = h.radius ?? 7;
              ctx.save();
              ctx.shadowColor = 'rgba(0,0,0,0.25)';
              ctx.shadowBlur = 4;
              ctx.fillStyle = h.fill || '#fff';
              ctx.strokeStyle = h.stroke || 'rgba(0,0,0,0.65)';
              ctx.lineWidth = h.lineWidth ?? 2;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
              ctx.restore();
            };
            hs.forEach(drawKnob);
          }
        }
      }

      // Feature 1: Draw dashed group outlines
      renderGroupOutlines(lvl);

      // Run 3 Feature 1: Overlap preview
      if (state.showOverlaps) {
        renderOverlaps(lvl);
      }

      // Feature 2: Draw yellow note indicator dots for obstacles with _note
      L.obstacles.forEach((o, i) => {
        if (!o._note) return;
        if (state.hiddenTypes.has(o.type)) return;
        const nx = (o.x ?? (o.x1 != null ? (o.x1 + o.x2) / 2 : 0)) + LEFT_PAD;
        const ny = (o.y ?? GY) - 20;
        ctx.save();
        ctx.fillStyle = '#f1c40f';
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(nx + 14, ny - 6, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });

      // ---------- Live validation badges ----------
      state._validationBadges = [];
      if (state.showValidationBadges && config.validateLevel) {
        let issues = [];
        try {
          const course = lvl.courtId != null ? COURSES[lvl.courtId] : null;
          issues = config.validateLevel(lvl, course) || [];
        } catch (_) {}
        issues.forEach(iss => {
          if (iss.obstacleIdx == null) return;
          const o = L.obstacles[iss.obstacleIdx];
          if (!o || !o._bbox || state.hiddenTypes.has(o.type)) return;
          const b = o._bbox;
          const cx = b[0] + b[2] - 2;
          const cy = b[1] + 2;
          const r = 7;
          const fill = iss.level === 'error' ? '#d83d3d' : '#e8a454';
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.4)';
          ctx.shadowBlur = 3;
          ctx.fillStyle = fill;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', cx, cy + 0.5);
          ctx.restore();
          state._validationBadges.push({ idx: iss.obstacleIdx, level: iss.level, msg: iss.msg, cx, cy, r });
        });
      }

      // Ball start
      const bx = L.ballStart.x + LEFT_PAD;
      const by = L.ballStart.y;
      if (config.drawBall) {
        config.drawBall(ctx, { x: bx, y: by }, state.zoom);
      } else {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bx, by, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (state.selectedKind === 'ball') highlightRect(bx - 16, by - 16, 32, 32);

      // Hole
      const hx = L.hole.x + LEFT_PAD;
      const hy = L.hole.y;
      if (config.drawHole) {
        config.drawHole(ctx, { x: hx, y: hy }, state.zoom);
      } else {
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.ellipse(hx, hy, 18, 6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d83d3d';
        ctx.fillRect(hx - 1, hy - 40, 2, 40);
        ctx.beginPath(); ctx.moveTo(hx + 1, hy - 40); ctx.lineTo(hx + 20, hy - 32); ctx.lineTo(hx + 1, hy - 24); ctx.fill();
      }
      if (state.selectedKind === 'hole') highlightRect(hx - 20, hy - 42, 40, 48);

      // Smart-guide vertical line
      if (state.smartGuideX != null && state.drag) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#ff6ecf';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(state.smartGuideX + LEFT_PAD, 0);
        ctx.lineTo(state.smartGuideX + LEFT_PAD, CANVAS_H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Feature 3: Snap-to-obstacle guide line
      if (state.snapGuideLines && state.drag) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#00bfff';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        state.snapGuideLines.forEach(g => {
          ctx.beginPath();
          ctx.moveTo(g.x1, g.y1);
          ctx.lineTo(g.x2, g.y2);
          ctx.stroke();
        });
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Marquee rectangle
      if (state.marquee) {
        const m = state.marquee;
        const x1 = Math.min(m.startX, m.endX);
        const y1 = Math.min(m.startY, m.endY);
        const w = Math.abs(m.endX - m.startX);
        const h = Math.abs(m.endY - m.startY);
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = 'rgba(80,140,255,0.15)';
        ctx.strokeStyle = '#4080ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(x1, y1, w, h);
        ctx.strokeRect(x1, y1, w, h);
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Prefab ghost preview
      if (state.pendingPrefab && config.drawObstacle) {
        const pf = state.pendingPrefab;
        const minX = pf.obstacles.reduce((m, o) => {
          const ox = 'x1' in o ? o.x1 : (o.x ?? 0);
          return Math.min(m, ox);
        }, Infinity);
        const dx = state.pendingPrefabX - (isFinite(minX) ? minX : 0);
        ctx.save();
        ctx.globalAlpha = 0.45;
        pf.obstacles.forEach(src => {
          const o = cloneDeep(src);
          if ('x1' in o) { o.x1 += dx; o.x2 += dx; if (o.crocX != null) o.crocX += dx; }
          else if ('x' in o) o.x += dx;
          try { config.drawObstacle(ctx, o, false, state.zoom, L, LEFT_PAD, GY, CANVAS_H); } catch (_) {}
        });
        ctx.restore();
        // Vertical guide line at placement X
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(255,200,0,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(state.pendingPrefabX + LEFT_PAD, 0);
        ctx.lineTo(state.pendingPrefabX + LEFT_PAD, CANVAS_H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // World width resize handle — orange strip at right edge of world
      {
        const hx = L.worldW + LEFT_PAD;
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = state._worldResizeHover ? 'rgba(255,180,0,0.7)' : 'rgba(255,140,0,0.35)';
        ctx.fillRect(hx - 4, 0, 8, CANVAS_H);
        ctx.strokeStyle = state._worldResizeHover ? '#ff8c00' : 'rgba(255,140,0,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, CANVAS_H); ctx.stroke();
        // Arrows hint
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('↔', hx, CANVAS_H / 2);
        ctx.restore();
      }

      // Ruler overlay — tick marks along top and left edges
      if (state.showRuler) {
        const RULER_W = 20; // ruler strip width in world px
        ctx.save();
        ctx.shadowColor = 'transparent';
        const worldW = L.worldW + LEFT_PAD * 2;

        // Top ruler background
        ctx.fillStyle = 'rgba(20,20,20,0.65)';
        ctx.fillRect(0, 0, worldW, RULER_W);

        // Left ruler background
        ctx.fillStyle = 'rgba(20,20,20,0.65)';
        ctx.fillRect(0, 0, RULER_W, CANVAS_H);

        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.lineWidth = 1;

        // Top ruler ticks — every 50 world px
        for (let wx = 0; wx <= L.worldW; wx += 50) {
          const cx = wx + LEFT_PAD; // canvas x
          const isMajor = wx % 100 === 0;
          const tickH = isMajor ? RULER_W - 4 : RULER_W / 2;
          ctx.beginPath();
          ctx.moveTo(cx, RULER_W - tickH);
          ctx.lineTo(cx, RULER_W);
          ctx.stroke();
          if (isMajor && wx > 0) {
            ctx.fillText(String(wx), cx + 2, RULER_W - 2);
          }
        }

        // Left ruler ticks — every 50 world px vertically
        ctx.textAlign = 'right';
        for (let wy = 0; wy <= CANVAS_H; wy += 50) {
          const isMajor = wy % 100 === 0;
          const tickW = isMajor ? RULER_W - 4 : RULER_W / 2;
          ctx.beginPath();
          ctx.moveTo(RULER_W - tickW, wy);
          ctx.lineTo(RULER_W, wy);
          ctx.stroke();
          if (isMajor && wy > 0) {
            ctx.save();
            ctx.translate(RULER_W - 2, wy - 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(String(wy), 0, 0);
            ctx.restore();
          }
        }
        ctx.restore();
      }
    };

    // ---------- Spatial index (uniform grid bucket) ----------
    const SPATIAL_CELL = 100;
    const _spatial = { cells: new Map(), levelRef: null, count: 0 };
    const _spatialKey = (cx, cy) => cx + ',' + cy;
    const rebuildSpatialIndex = () => {
      _spatial.cells.clear();
      const lvl = state.levels[state.currentIdx];
      _spatial.levelRef = lvl || null;
      _spatial.count = 0;
      if (!lvl) return;
      lvl.data.obstacles.forEach((o, i) => {
        const b = o._bbox; if (!b) return;
        const x0 = Math.floor(b[0] / SPATIAL_CELL);
        const y0 = Math.floor(b[1] / SPATIAL_CELL);
        const x1 = Math.floor((b[0] + b[2]) / SPATIAL_CELL);
        const y1 = Math.floor((b[1] + b[3]) / SPATIAL_CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const k = _spatialKey(cx, cy);
            let arr = _spatial.cells.get(k);
            if (!arr) { arr = []; _spatial.cells.set(k, arr); }
            arr.push(i);
          }
        }
        _spatial.count++;
      });
    };
    const queryPoint = (x, y) => {
      const cx = Math.floor(x / SPATIAL_CELL);
      const cy = Math.floor(y / SPATIAL_CELL);
      return _spatial.cells.get(_spatialKey(cx, cy)) || [];
    };
    const queryRect = (x1, y1, x2, y2) => {
      const cx0 = Math.floor(Math.min(x1, x2) / SPATIAL_CELL);
      const cy0 = Math.floor(Math.min(y1, y2) / SPATIAL_CELL);
      const cx1 = Math.floor(Math.max(x1, x2) / SPATIAL_CELL);
      const cy1 = Math.floor(Math.max(y1, y2) / SPATIAL_CELL);
      const seen = new Set();
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = _spatial.cells.get(_spatialKey(cx, cy));
          if (arr) arr.forEach(i => seen.add(i));
        }
      }
      return Array.from(seen);
    };

    // ---------- Hit test ----------
    const hitTest = (x, y) => {
      const lvl = state.levels[state.currentIdx];
      if (!lvl) return null;
      const L = lvl.data;
      const bx = L.ballStart.x + LEFT_PAD;
      if (Math.hypot(x - bx, y - L.ballStart.y) < 18) return { kind: 'ball' };
      const hx = L.hole.x + LEFT_PAD;
      if (x > hx - 20 && x < hx + 20 && y > L.hole.y - 42 && y < L.hole.y + 8) return { kind: 'hole' };
      // Use spatial index when populated; fall back to linear scan for safety
      if (_spatial.count > 0 && _spatial.levelRef === lvl) {
        const candidates = queryPoint(x, y);
        if (candidates.length) {
          // Iterate descending to honor draw order (later = on top)
          candidates.sort((a, b) => b - a);
          for (const i of candidates) {
            if (state.lockedObs.has(i)) continue;
            const b = L.obstacles[i]?._bbox;
            if (!b) continue;
            if (x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) return { kind: 'obs', index: i };
          }
          return null;
        }
      }
      for (let i = L.obstacles.length - 1; i >= 0; i--) {
        if (state.lockedObs.has(i)) continue;
        const b = L.obstacles[i]._bbox;
        if (!b) continue;
        if (x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) return { kind: 'obs', index: i };
      }
      return null;
    };

    // ---------- Game sync ----------
    const buildSyncPayload = () => {
      const byCourse = {};
      const warnings = [];
      state.levels.forEach((lvl) => {
        if (lvl.courtId == null || lvl.slot == null) return;
        const cid = String(lvl.courtId);
        (byCourse[cid] ||= []).push(lvl);
      });
      const courses = {};
      for (const cid of Object.keys(byCourse)) {
        const arr = byCourse[cid].slice().sort((a, b) => a.slot - b.slot);
        const slots = arr.map(l => l.slot);
        const dupe = slots.find((s, i) => slots.indexOf(s) !== i);
        if (dupe != null) {
          warnings.push(`Course ${cid}: duplicate slot ${dupe} — kept first, dropped rest`);
          const seen = new Set();
          for (let i = arr.length - 1; i >= 0; i--) {
            if (seen.has(arr[i].slot)) arr.splice(i, 1);
            else seen.add(arr[i].slot);
          }
        }
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].slot !== i + 1) {
            warnings.push(`Course ${cid}: expected slot ${i + 1}, got ${arr[i].slot} — course skipped`);
            arr.length = 0;
            break;
          }
        }
        if (arr.length) courses[cid] = arr.map(l => cloneDeep(l.data));
      }
      const unassigned = state.levels.filter(l => l.courtId == null || l.slot == null).length;
      if (unassigned) warnings.push(`${unassigned} level(s) unassigned — not published`);
      return { courses, warnings };
    };

    const publishSync = ({ announce = true } = {}) => {
      const { courses, warnings } = buildSyncPayload();
      state.sync.courses = courses;
      state.sync.updatedAt = Date.now();
      try {
        localStorage.setItem(SYNC_KEY, JSON.stringify({
          enabled: state.sync.enabled,
          updatedAt: state.sync.updatedAt,
          courses
        }));
      } catch (e) {
        if (announce) toast('Sync write failed: ' + e.message);
        return { warnings };
      }
      renderSyncStatus(warnings);
      if (announce) recordPublish(courses, warnings);
      if (announce) {
        const total = Object.values(courses).reduce((n, arr) => n + arr.length, 0);
        toast(state.sync.enabled
          ? `Synced ${total} level(s) to game`
          : `Prepared ${total} level(s) (sync is OFF)`);
      }
      return { warnings };
    };

    const clearSync = () => {
      try { localStorage.removeItem(SYNC_KEY); } catch (_) {}
      state.sync.enabled = false;
      state.sync.updatedAt = null;
      state.sync.courses = {};
      renderSyncStatus([]);
      toast('Game reverted to baked data');
    };

    const toggleSync = () => {
      state.sync.enabled = !state.sync.enabled;
      publishSync({ announce: false });
      renderSyncStatus([]);
      toast(state.sync.enabled ? 'Sync ON — game now uses editor levels' : 'Sync OFF — game uses baked levels');
    };

    const relTime = (ts) => {
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 5) return 'just now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return new Date(ts).toLocaleString();
    };

    const renderSyncStatus = (warnings) => {
      const dot = $('sync-dot');
      const lbl = $('sync-label');
      const sum = $('sync-summary');
      const warnEl = $('sync-warnings');
      const toggleBtn = $('btn-sync-toggle');
      if (!dot) return;
      dot.className = 'sync-dot ' + (state.sync.enabled ? 'on' : 'off');
      lbl.textContent = state.sync.enabled ? 'Sync ON — game uses editor levels' : 'Sync OFF — game uses baked data';
      toggleBtn.textContent = 'Sync: ' + (state.sync.enabled ? 'ON' : 'OFF');
      toggleBtn.classList.toggle('btn-success', state.sync.enabled);
      const entries = Object.entries(state.sync.courses || {}).sort((a, b) => a[0].localeCompare(b[0]));
      if (entries.length) {
        sum.innerHTML = entries.map(([cid, arr]) =>
          `<span class="sync-chip c${cid}">C${cid}·${arr.length}<small>${COURSE_NAMES[cid] || ''}</small></span>`
        ).join('');
      } else {
        sum.innerHTML = '<span class="muted">No courses assembled yet — assign Course + Slot to levels.</span>';
      }
      warnEl.innerHTML = (warnings || []).map(w => `<div class="sync-warn">${w}</div>`).join('');
      if (state.sync.updatedAt) {
        sum.insertAdjacentHTML('beforeend', `<span class="sync-time">${relTime(state.sync.updatedAt)}</span>`);
      }
    };

    // ---------- Publish history ----------
    const loadPublishHistory = () => {
      try {
        const raw = localStorage.getItem(PUBLISH_HISTORY_KEY);
        if (raw) state.publishHistory = JSON.parse(raw) || [];
      } catch (e) { state.publishHistory = []; }
    };
    const savePublishHistory = () => {
      if (!safeSetItem(PUBLISH_HISTORY_KEY, JSON.stringify(state.publishHistory), 'publish history')) {
        state.publishHistory.splice(0, Math.max(1, Math.floor(state.publishHistory.length / 2)));
        try { localStorage.setItem(PUBLISH_HISTORY_KEY, JSON.stringify(state.publishHistory)); } catch (_) {}
      }
    };
    const recordPublish = (courses, warnings) => {
      const total = Object.values(courses).reduce((n, arr) => n + arr.length, 0);
      if (!total) return;
      const last = state.publishHistory[state.publishHistory.length - 1];
      const payloadKey = JSON.stringify(courses);
      if (last && JSON.stringify(last.courses) === payloadKey) return;
      const entry = {
        ts: Date.now(),
        label: new Date().toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' }),
        total,
        warnings: warnings || [],
        courses: cloneDeep(courses),
        levels: cloneDeep(state.levels),
        obstacleCount: Object.values(courses).flat().reduce((n, l) => n + (l.obstacles?.length || 0), 0)
      };
      state.publishHistory.push(entry);
      if (state.publishHistory.length > PUBLISH_HISTORY_MAX) state.publishHistory.shift();
      savePublishHistory();
      renderPublishHistory();
    };
    const revertPublish = (index) => {
      const entry = state.publishHistory[index];
      if (!entry) return;
      if (!confirm(`Revert to publish from ${entry.label}? (${entry.total} level${entry.total === 1 ? '' : 's'})`)) return;
      pushHistory(true, 'Revert publish');
      state.levels = cloneDeep(entry.levels);
      if (!state.levels.length) state.currentIdx = -1;
      else state.currentIdx = Math.max(0, Math.min(state.currentIdx, state.levels.length - 1));
      if (typeof saveSettings === 'function') saveSettings();
      state.selectedObs = -1;
      state.selectedObsList = [];
      state.selectedKind = null;
      publishSync({ announce: false });
      render();
      toast(`Reverted to publish from ${entry.label}`);
    };
    const renderPublishHistory = () => {
      const ul = $('publish-history-list');
      if (!ul) return;
      ul.innerHTML = '';
      if (!state.publishHistory.length) {
        ul.innerHTML = '<li class="empty-state">No publishes yet.</li>';
        return;
      }
      state.publishHistory.slice().reverse().forEach((entry, revIdx) => {
        const realIdx = state.publishHistory.length - 1 - revIdx;
        const li = document.createElement('li');
        li.className = 'publish-entry';
        const warnBadge = entry.warnings.length ? `<span class="warn-badge" title="${entry.warnings.join(' | ')}">!</span>` : '';
        li.innerHTML = `
          <div class="pub-head">
            <strong>${entry.label}</strong>
            ${warnBadge}
            <span class="pub-count">${entry.total} lvl · ${entry.obstacleCount || 0} obs</span>
          </div>
          <div class="pub-actions">
            <button class="btn btn-mini" data-revert="${realIdx}">Revert</button>
          </div>`;
        li.querySelector('[data-revert]').addEventListener('click', () => revertPublish(realIdx));
        ul.appendChild(li);
      });
    };

    // ---------- UI: Level list ----------
    const renderLevelList = () => {
      const ul = $('level-list');
      const filter = $('filter-court').value;
      const searchVal = $('level-search')?.value?.toLowerCase() || '';
      ul.innerHTML = '';
      // Build index-aware list for sorting
      let entries = state.levels.map((lvl, idx) => ({ lvl, idx }));
      // Filter by court
      if (filter !== 'all') {
        const want = filter === 'null' ? null : parseInt(filter, 10);
        entries = entries.filter(e => (e.lvl.courtId ?? null) === want);
      }
      // Filter by search
      if (searchVal) {
        entries = entries.filter(e => (e.lvl.data.name || '').toLowerCase().includes(searchVal));
      }
      // Sort
      if (state.sortMode === 'name') {
        entries = entries.slice().sort((a, b) => (a.lvl.data.name || '').localeCompare(b.lvl.data.name || ''));
      } else if (state.sortMode === 'course') {
        entries = entries.slice().sort((a, b) => (a.lvl.courtId ?? 9999) - (b.lvl.courtId ?? 9999));
      } else if (state.sortMode === 'slot') {
        entries = entries.slice().sort((a, b) => (a.lvl.slot ?? 9999) - (b.lvl.slot ?? 9999));
      }
      // Drag-and-drop state for level reorder
      let _dragSrcIdx = null;

      entries.forEach(({ lvl, idx }) => {
        const li = document.createElement('li');
        const isActive = idx === state.currentIdx;
        li.className = 'level-item' + (isActive ? ' active' : '');
        li.draggable = true;
        li.dataset.levelIdx = idx;
        li.addEventListener('dragstart', (e) => {
          _dragSrcIdx = idx;
          li.classList.add('level-drag-source');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        });
        li.addEventListener('dragend', () => {
          li.classList.remove('level-drag-source');
          ul.querySelectorAll('.level-drop-indicator').forEach(el => el.remove());
          ul.querySelectorAll('.level-drag-over').forEach(el => el.classList.remove('level-drag-over'));
        });
        li.addEventListener('dragover', (e) => {
          if (_dragSrcIdx == null || _dragSrcIdx === idx) return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          ul.querySelectorAll('.level-drop-indicator').forEach(el => el.remove());
          ul.querySelectorAll('.level-drag-over').forEach(el => el.classList.remove('level-drag-over'));
          li.classList.add('level-drag-over');
          const indicator = document.createElement('div');
          indicator.className = 'level-drop-indicator';
          const rect = li.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) li.parentElement.insertBefore(indicator, li);
          else li.parentElement.insertBefore(indicator, li.nextSibling);
        });
        li.addEventListener('dragleave', () => {
          li.classList.remove('level-drag-over');
        });
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          if (_dragSrcIdx == null || _dragSrcIdx === idx) return;
          const from = _dragSrcIdx;
          // Determine insert position: before or after target
          const rect = li.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          let to = idx;
          if (e.clientY >= midY && to < state.levels.length - 1) to = idx + (from < idx ? 0 : 1);
          else if (e.clientY < midY) to = idx + (from < idx ? -1 : 0);
          to = Math.max(0, Math.min(state.levels.length - 1, to));
          if (from === to) return;
          pushHistory(true, 'Reorder levels');
          const moved = state.levels.splice(from, 1)[0];
          state.levels.splice(to, 0, moved);
          // Follow the current level
          if (state.currentIdx === from) state.currentIdx = to;
          else if (state.currentIdx > from && state.currentIdx <= to) state.currentIdx--;
          else if (state.currentIdx < from && state.currentIdx >= to) state.currentIdx++;
          saveSettings();
          render();
        });
        if (isActive) {
          setTimeout(() => li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
        }
        const chipCls = lvl.courtId ? 'court-chip c' + lvl.courtId : 'court-chip unassigned';
        const courtTag = lvl.courtId ? `C${lvl.courtId}${lvl.slot ? '·' + lvl.slot : ''}` : '—';
        const name = lvl.data.name || '(unnamed)';
        const canPlay = lvl.courtId != null && lvl.slot != null;
        const playBtn = canPlay
          ? `<button class="play-btn" data-idx="${idx}" title="Play in game">&#9654;</button>`
          : '';
        const thumb = document.createElement('canvas');
        thumb.width = 16; thumb.height = 10;
        thumb.style.cssText = 'vertical-align:middle;margin-right:4px;border-radius:2px;';
        try {
          const tc = thumb.getContext('2d');
          tc.fillStyle = (lvl.data.theme === 'night' ? '#1a1a2e' : '#87CEEB');
          tc.fillRect(0, 0, 16, 5);
          tc.fillStyle = (lvl.data.theme === 'desert' ? '#c8a96e' : '#4a7c3f');
          tc.fillRect(0, 5, 16, 5);
          const worldW = lvl.data.worldW || 800;
          (lvl.data.obstacles || []).forEach(o => {
            const cx = o.x != null ? o.x : (o.x1 != null ? (o.x1 + o.x2) / 2 : null);
            const cy = o.y != null ? o.y : null;
            if (cx == null) return;
            const px = Math.round((cx / worldW) * 16);
            const py = cy != null ? Math.round((cy / CANVAS_H) * 10) : 6;
            tc.fillStyle = TYPE_COLORS[o.type] || '#fff';
            tc.fillRect(Math.max(0, Math.min(15, px)), Math.max(0, Math.min(9, py)), 2, 2);
          });
        } catch (_) {}
        const obsCount = (lvl.data.obstacles || []).length;
        li.innerHTML = `<span class="${chipCls}">${courtTag}</span><span class="name">${name}</span>${playBtn}<span class="level-stats">${obsCount} obstacle${obsCount === 1 ? '' : 's'}</span>`;
        li.insertBefore(thumb, li.firstChild);
        li.title = name;
        li.addEventListener('click', (e) => {
          if (e.target.classList.contains('play-btn')) return;
          selectLevel(idx);
        });
        // Inline name edit on double-click
        const nameSpan = li.querySelector('.name');
        if (nameSpan) {
          nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.value = lvl.data.name || '';
            input.className = 'name-edit-input';
            nameSpan.replaceWith(input);
            input.focus(); input.select();
            const commit = () => {
              pushHistory(true, 'Rename');
              lvl.data.name = input.value;
              render();
            };
            const cancel = () => { render(); };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); input.removeEventListener('blur', commit); commit(); }
              if (ev.key === 'Escape') { ev.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
            });
          });
        }
        const pb = li.querySelector('.play-btn');
        if (pb) pb.addEventListener('click', (e) => {
          e.stopPropagation();
          playInGame(idx);
        });
        ul.appendChild(li);
      });
      const lc = $('level-count');
      if (lc) lc.textContent = state.levels.length;
    };

    // ---------- UI: Slot grid ----------
    const renderSlotGrid = () => {
      const wrap = $('slot-grid-wrap');
      const grid = $('slot-grid');
      const title = $('slot-grid-title');
      const stats = $('slot-grid-stats');
      if (!wrap || !grid) return;
      const filter = $('filter-court').value;
      const courtId = (filter === 'all' || filter === 'null') ? null : parseInt(filter, 10);
      const course = courtId != null ? COURSES[courtId] : null;
      if (!course) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      title.textContent = course.name;
      const bySlot = new Map();
      state.levels.forEach((lvl, idx) => {
        if (lvl.courtId === courtId && lvl.slot != null) {
          if (!bySlot.has(lvl.slot)) bySlot.set(lvl.slot, idx);
        }
      });
      const filled = bySlot.size;
      stats.textContent = `${filled}/${course.slotCount}`;
      grid.innerHTML = '';
      for (let s = 1; s <= course.slotCount; s++) {
        const cell = document.createElement('button');
        cell.className = 'slot-cell';
        const idx = bySlot.get(s);
        if (idx != null) {
          const lvl = state.levels[idx];
          cell.classList.add('filled');
          if (idx === state.currentIdx) cell.classList.add('active');
          cell.innerHTML = `<span class="slot-num">${s}</span><span class="slot-name">${lvl.data.name || ''}</span>`;
          cell.title = lvl.data.name || '';
          cell.addEventListener('click', () => selectLevel(idx));
        } else {
          cell.classList.add('empty');
          cell.innerHTML = `<span class="slot-num">${s}</span><span class="slot-plus">+</span>`;
          cell.title = `Create new level at slot ${s}`;
          cell.addEventListener('click', () => {
            pushHistory(true);
            const lvl = newLevel();
            lvl.courtId = courtId;
            lvl.slot = s;
            lvl.data.name = `${course.name} L${s}`;
            state.levels.push(lvl);
            state.currentIdx = state.levels.length - 1;
            render();
          });
        }
        grid.appendChild(cell);
      }
    };

    // ---------- UI: Validation ----------
    const renderValidation = () => {
      const ul = $('validation-list');
      if (!ul) return;
      const lvl = state.levels[state.currentIdx];
      let issues = [];
      if (config.validateLevel && lvl) {
        const course = lvl.courtId != null ? COURSES[lvl.courtId] : null;
        issues = config.validateLevel(lvl, course) || [];
      }
      // Complexity from plugin if available
      let header = '';
      if (config.complexityScore && lvl) {
        const score = config.complexityScore(lvl);
        const band = score < 8 ? 'low' : score > 35 ? 'high' : 'ok';
        const bandLabel = band === 'low' ? 'feels thin' : band === 'high' ? 'may overwhelm' : 'playable';
        header = `<li class="v-meta"><span class="v-score v-${band}">Complexity ${score}</span> <span class="muted">(${bandLabel})</span></li>`;
      }
      // Feature 4: Obstacle summary section
      let summary = '';
      if (lvl) {
        const counts = {};
        lvl.data.obstacles.forEach(o => { counts[o.type] = (counts[o.type] || 0) + 1; });
        const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
        if (entries.length) {
          const summaryItems = entries.map(([t, n]) => `${t}: ${n}`).join(', ');
          summary = `<li class="v-meta v-summary"><strong>Obstacles:</strong> ${summaryItems}</li>`;
        }
      }
      const badgeToggle = `<li class="v-meta v-toggle">
        <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:11px">
          <input type="checkbox" id="opt-validation-badges"${state.showValidationBadges ? ' checked' : ''}>
          Show badges on canvas
        </label>
      </li>`;
      if (!issues.length) {
        ul.innerHTML = header + badgeToggle + '<li class="empty-state">No issues.</li>' + summary;
      } else {
        ul.innerHTML = header + badgeToggle + issues.map((i, idx) => {
          const clickable = i.obstacleIdx != null;
          return `<li class="v-item v-${i.level}${clickable ? ' v-click' : ''}" data-issue="${idx}"><span class="v-dot"></span>${i.msg}</li>`;
        }).join('') + summary;
        ul.querySelectorAll('.v-click').forEach(el => {
          el.addEventListener('click', () => {
            const issue = issues[parseInt(el.dataset.issue, 10)];
            if (issue && issue.obstacleIdx != null) {
              state.selectedKind = 'obs';
              state.selectedObs = issue.obstacleIdx;
              state.selectedObsList = [issue.obstacleIdx];
              scrollToSelection();
              render();
            }
          });
        });
      }
      const _bToggle = $('opt-validation-badges');
      if (_bToggle) _bToggle.addEventListener('change', (e) => {
        state.showValidationBadges = !!e.target.checked;
        render();
      });
    };

    // ---------- UI: Asset palette ----------
    const makeAssetButton = (type, extraCls = '') => {
      const b = document.createElement('button');
      b.className = 'asset-btn' + (extraCls ? ' ' + extraCls : '');
      b.dataset.type = type;
      b.title = ASSET_TOOLTIPS[type] || type;
      const icon = TYPE_ICONS[type];
      let iconHtml;
      if (icon && typeof icon === 'object' && icon.sprite) {
        iconHtml = `<img src="${icon.sprite}" class="asset-icon-img" alt="">`;
      } else if (icon) {
        iconHtml = `<span class="asset-icon">${icon}</span>`;
      } else {
        iconHtml = `<span class="asset-swatch" style="background:${TYPE_COLORS[type] || '#888'}"></span>`;
      }
      b.innerHTML = `${iconHtml}<span>${type}</span>`;
      b.addEventListener('click', () => {
        state.tool = type;
        document.querySelectorAll('.asset-btn, .tool-btn').forEach(el => el.classList.remove('active'));
        b.classList.add('active');
        canvas.style.cursor = 'cell';
      });
      return b;
    };
    const renderPalette = () => {
      const grid = $('asset-palette');
      if (!grid) return;
      grid.innerHTML = '';
      const course = currentCourse();
      const list = course ? course.allowed : TYPES;
      const courseLabel = $('palette-course-label');
      if (courseLabel) {
        courseLabel.textContent = course
          ? `${course.name} — ${list.length} asset${list.length === 1 ? '' : 's'}`
          : 'All assets (no course assigned)';
      }
      // Palette filter — ensure filter input exists
      let filterWrap = $('palette-filter-wrap');
      if (!filterWrap) {
        filterWrap = document.createElement('div');
        filterWrap.id = 'palette-filter-wrap';
        filterWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
        const inp = document.createElement('input');
        inp.id = 'palette-filter';
        inp.type = 'search';
        inp.placeholder = 'Filter assets…';
        inp.style.cssText = 'flex:1;min-width:0;font-size:11px;padding:2px 4px;';
        filterWrap.appendChild(inp);
        const clrBtn = document.createElement('button');
        clrBtn.textContent = '×';
        clrBtn.className = 'btn btn-mini';
        clrBtn.title = 'Clear filter';
        clrBtn.style.cssText = 'padding:1px 5px;line-height:1;';
        clrBtn.addEventListener('click', () => { inp.value = ''; renderPalette(); });
        filterWrap.appendChild(clrBtn);
        inp.addEventListener('input', () => renderPalette());
        // Insert before grid
        grid.parentElement.insertBefore(filterWrap, grid);
      }
      const filterVal = ($('palette-filter')?.value || '').toLowerCase();
      const recentWrap = $('asset-recent');
      if (recentWrap) {
        recentWrap.innerHTML = '';
        const recent = state.recentTypes.filter(t => list.includes(t) && SCHEMA[t]).slice(0, 8);
        if (recent.length) {
          recentWrap.style.display = '';
          const label = document.createElement('div');
          label.className = 'recent-label';
          label.textContent = 'Recent';
          recentWrap.appendChild(label);
          recent.forEach(type => recentWrap.appendChild(makeAssetButton(type, 'asset-btn-small')));
        } else {
          recentWrap.style.display = 'none';
        }
      }
      const currentObstacles = state.levels[state.currentIdx]?.data?.obstacles || [];
      list.forEach(type => {
        if (!SCHEMA[type]) return;
        if (filterVal && !type.toLowerCase().includes(filterVal)) return;
        const btn = makeAssetButton(type);
        const count = currentObstacles.filter(o => o.type === type).length;
        if (count > 0) {
          const badge = document.createElement('span');
          badge.className = 'asset-count';
          badge.textContent = count;
          btn.appendChild(badge);
        }
        grid.appendChild(btn);
      });
    };

    // ---------- UI: Config form ----------
    const bindConfig = () => {
      const lvl = state.levels[state.currentIdx];
      const set = (id, v) => {
        const el = $(id);
        if (el && el !== document.activeElement) el.value = v ?? '';
      };
      if (!lvl) {
        ['in-name','in-subtitle','in-description','in-worldW','in-time','in-maxShots','in-starShots','in-starShots-0','in-starShots-1','in-starShots-2','in-ballX','in-holeX','in-slot'].forEach(id => set(id, ''));
        const ic = $('in-court');
        if (ic && ic !== document.activeElement) ic.value = 'null';
        const cn = $('current-level-name');
        if (cn) cn.textContent = '—';
        return;
      }
      const L = lvl.data;
      set('in-name', L.name);
      set('in-subtitle', L.subtitle);
      set('in-description', L.description || '');
      set('in-worldW', L.worldW);
      set('in-time', L.time);
      set('in-maxShots', L.maxShots);
      set('in-starShots', (L.starShots || []).join(','));
      const _ss = L.starShots || [];
      set('in-starShots-0', _ss[0] ?? '');
      set('in-starShots-1', _ss[1] ?? '');
      set('in-starShots-2', _ss[2] ?? '');
      set('in-ballX', L.ballStart.x);
      set('in-holeX', L.hole.x);
      const ic = $('in-court');
      if (ic && ic !== document.activeElement) ic.value = lvl.courtId == null ? 'null' : String(lvl.courtId);
      set('in-slot', lvl.slot);
      const course = currentCourse();
      const ballX = $('in-ballX');
      if (ballX) {
        if (course && course.rules && course.rules.ballStartX != null) {
          if (L.ballStart.x !== course.rules.ballStartX) {
            L.ballStart.x = course.rules.ballStartX;
            set('in-ballX', L.ballStart.x);
          }
          ballX.readOnly = true;
          ballX.title = `${course.name} rule: ballStart.x locked at ${course.rules.ballStartX}`;
          ballX.style.opacity = '0.5';
        } else {
          ballX.readOnly = false;
          ballX.title = '';
          ballX.style.opacity = '';
        }
      }
      const cn = $('current-level-name');
      if (cn) cn.textContent = L.name || '(unnamed)';
      const wwd = $('world-width-display');
      if (wwd) wwd.textContent = L.worldW;
      const oc = $('obstacle-count');
      if (oc) oc.textContent = L.obstacles.length;
    };

    const wireConfig = () => {
      const upd = () => {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        pushHistory();
        const L = lvl.data;
        L.name = $('in-name').value;
        L.subtitle = $('in-subtitle').value;
        L.description = $('in-description')?.value || '';
        L.worldW = Math.max(400, Math.min(8000, parseInt($('in-worldW').value) || 800));
        if (L.worldW > 3000) toast('⚠ World width ' + L.worldW + 'px is large — may cause slow rendering', 3000);
        L.time = parseFloat($('in-time').value) || 0;
        L.maxShots = parseInt($('in-maxShots').value) || 4;
        {
          const sEl = $('in-starShots');
          const sSplit = ['in-starShots-0','in-starShots-1','in-starShots-2'].map(id => $(id));
          if (sSplit.every(el => el)) {
            L.starShots = sSplit.map(el => parseInt(el.value)).filter(n => !isNaN(n));
            if (sEl) sEl.value = L.starShots.join(',');
          } else if (sEl) {
            L.starShots = sEl.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
          }
        }
        L.ballStart.x = parseInt($('in-ballX').value) || 100;
        L.hole.x = parseInt($('in-holeX').value) || 700;
        const c = $('in-court').value;
        lvl.courtId = c === 'null' ? null : parseInt(c, 10);
        const s = parseInt($('in-slot').value);
        lvl.slot = isNaN(s) ? null : s;
        slotWarning();
        render();
      };
      ['in-name','in-subtitle','in-description','in-worldW','in-time','in-maxShots','in-starShots','in-starShots-0','in-starShots-1','in-starShots-2','in-ballX','in-holeX','in-court','in-slot']
        .forEach(id => { const el = $(id); if (el) el.addEventListener('input', upd); });
    };

    const slotWarning = () => {
      const lvl = state.levels[state.currentIdx];
      const w = $('slot-warning');
      if (!w) return;
      if (!lvl || lvl.courtId == null) { w.textContent = ''; return; }
      const clash = state.levels.find((L, i) => i !== state.currentIdx && L.courtId === lvl.courtId && L.slot === lvl.slot && lvl.slot != null);
      w.textContent = clash ? `Slot ${lvl.slot} already used by "${clash.data.name}"` : '';
    };

    // ---------- UI: Properties panel ----------
    const snapToGround = (o) => {
      if (config.snapToGround) { config.snapToGround(o, GY); return; }
      // Generic fallback: set y to GY for any object with a y field
      if ('y' in o) o.y = GY;
    };

    const FLIPPABLE_DIR   = new Set(['ramp', 'boostPad']);
    const FLIPPABLE_FORCE = new Set(['wind', 'fan', 'boostPad']);
    const mirrorX = (o, worldW) => {
      if ('x1' in o) {
        const nx1 = worldW - o.x2;
        const nx2 = worldW - o.x1;
        o.x1 = nx1; o.x2 = nx2;
        if (Number.isFinite(o.crocX)) o.crocX = worldW - o.crocX;
      } else if ('x' in o) {
        const w = Number.isFinite(o.w) ? o.w : 0;
        o.x = worldW - o.x - w;
      }
      if (FLIPPABLE_DIR.has(o.type)   && Number.isFinite(o.dir))   o.dir   = -o.dir;
      if (FLIPPABLE_FORCE.has(o.type) && Number.isFinite(o.force)) o.force = -o.force;
    };
    // Mirror entire selection across world center on X axis.
    const mirrorSelected = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.length ? state.selectedObsList : (state.selectedObs >= 0 ? [state.selectedObs] : []);
      const valid = ids.filter(i => i >= 0 && i < lvl.data.obstacles.length);
      if (!valid.length) { toast('Nothing selected to mirror'); return; }
      pushHistory(true, 'Mirror selection');
      const W = lvl.data.worldW;
      valid.forEach(i => mirrorX(lvl.data.obstacles[i], W));
      render();
      toast(`Mirrored ${valid.length}`);
    };

    const bulkAlign = (axis) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.filter(i => i >= 0);
      if (ids.length < 2) return;
      pushHistory(true);
      const primary = lvl.data.obstacles[state.selectedObs];
      if (axis === 'x') {
        const refX = primary.x ?? (primary.x1 + (primary.x2 - primary.x1) / 2);
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if ('x1' in o) { const w = o.x2 - o.x1; o.x1 = refX - w / 2; o.x2 = o.x1 + w; }
          else if ('x' in o) o.x = refX;
        });
      } else if (axis === 'y') {
        const refY = primary.y ?? GY;
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if ('y' in o) o.y = refY;
        });
      } else if (axis === 'ground') {
        ids.forEach(i => snapToGround(lvl.data.obstacles[i]));
      }
      render();
      toast(`Aligned ${ids.length}`);
    };

    const bulkDistribute = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.filter(i => i >= 0);
      if (ids.length < 3) return;
      pushHistory(true);
      const sorted = ids.slice().sort((a, b) => {
        const ax = lvl.data.obstacles[a].x ?? lvl.data.obstacles[a].x1 ?? 0;
        const bx = lvl.data.obstacles[b].x ?? lvl.data.obstacles[b].x1 ?? 0;
        return ax - bx;
      });
      const first = lvl.data.obstacles[sorted[0]];
      const last = lvl.data.obstacles[sorted[sorted.length - 1]];
      const firstX = first.x ?? (first.x1 + (first.x2 - first.x1) / 2);
      const lastX = last.x ?? (last.x1 + (last.x2 - last.x1) / 2);
      const step = (lastX - firstX) / (sorted.length - 1);
      sorted.forEach((idx, i) => {
        if (i === 0 || i === sorted.length - 1) return;
        const o = lvl.data.obstacles[idx];
        const target = firstX + step * i;
        if ('x1' in o) { const w = o.x2 - o.x1; o.x1 = target - w / 2; o.x2 = o.x1 + w; }
        else if ('x' in o) o.x = target;
      });
      render();
      toast(`Distributed ${sorted.length}`);
    };

    // ---------- Alignment helpers ----------
    const _getObsLeft  = (o) => o.x1 != null ? o.x1 : (o.x != null ? o.x : 0);
    const _getObsRight = (o) => o.x2 != null ? o.x2 : (o.x != null ? o.x : 0);
    const _getObsTop   = (o) => o.y != null ? o.y - (o.h != null ? o.h / 2 : 0) : GY;
    const _getObsBottom= (o) => o.y != null ? o.y + (o.h != null ? o.h / 2 : 0) : GY;
    const _getObsCenterH = (o) => o.x1 != null ? (o.x1 + o.x2) / 2 : (o.x != null ? o.x : 0);
    const _getObsCenterV = (o) => o.y != null ? o.y : GY;

    const alignSelected = (mode) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.filter(i => i >= 0 && i < lvl.data.obstacles.length);
      if (ids.length < 2) { toast('Select 2+ obstacles to align'); return; }
      pushHistory(true, 'Align ' + mode);
      const obs = ids.map(i => lvl.data.obstacles[i]);
      if (mode === 'left') {
        const minL = Math.min(...obs.map(_getObsLeft));
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.x1 != null) { const w = o.x2 - o.x1; o.x1 = minL; o.x2 = minL + w; }
          else if (o.x != null) o.x = minL;
        });
      } else if (mode === 'right') {
        const maxR = Math.max(...obs.map(_getObsRight));
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.x1 != null) { const w = o.x2 - o.x1; o.x2 = maxR; o.x1 = maxR - w; }
          else if (o.x != null) o.x = maxR;
        });
      } else if (mode === 'top') {
        const minT = Math.min(...obs.map(_getObsTop));
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.y != null) { const h = o.h != null ? o.h : 0; o.y = minT + h / 2; }
        });
      } else if (mode === 'bottom') {
        const maxB = Math.max(...obs.map(_getObsBottom));
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.y != null) { const h = o.h != null ? o.h : 0; o.y = maxB - h / 2; }
        });
      } else if (mode === 'centerH') {
        const avgC = obs.reduce((s, o) => s + _getObsCenterH(o), 0) / obs.length;
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.x1 != null) { const w = o.x2 - o.x1; o.x1 = avgC - w / 2; o.x2 = avgC + w / 2; }
          else if (o.x != null) o.x = avgC;
        });
      } else if (mode === 'centerV') {
        const avgC = obs.reduce((s, o) => s + _getObsCenterV(o), 0) / obs.length;
        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if (o.y != null) o.y = avgC;
        });
      }
      render();
      toast(`Aligned ${ids.length} (${mode})`);
    };

    const renderProps = () => {
      const body = $('props-body');
      const info = $('selected-info');
      const lvl = state.levels[state.currentIdx];
      if (!lvl || state.selectedObs < 0 || state.selectedKind !== 'obs') {
        if (info) info.textContent = 'No selection';
        if (body && lvl) {
          // Show level statistics
          const counts = {};
          lvl.data.obstacles.forEach(o => { counts[o.type] = (counts[o.type] || 0) + 1; });
          const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
            .map(([t, n]) => `<div class="stat-row"><span class="stat-type">${t}</span><span class="stat-count">${n}</span></div>`).join('');
          body.innerHTML = `<div class="empty-state level-stats"><strong>Obstacle count by type:</strong>${rows}<div class="stat-total">Total: ${lvl.data.obstacles.length} obstacles</div><div class="stat-world">World width: ${lvl.data.worldW}px</div></div>`;
        } else if (body) {
          body.innerHTML = '<div class="empty-state">Select an obstacle to edit properties.</div>';
        }
        return;
      }
      if (state.selectedObsList.length > 1) {
        if (info) info.textContent = `${state.selectedObsList.length} obstacles selected`;

        // --- Batch Edit: compute common fields (intersection of all selected obstacle schemas) ---
        const selObs = state.selectedObsList.filter(i => i >= 0 && i < lvl.data.obstacles.length)
          .map(i => lvl.data.obstacles[i]);
        const allTypes = [...new Set(selObs.map(o => o.type))];
        let commonFields = [];
        if (allTypes.every(t => SCHEMA[t])) {
          // Start with the first type's fields then intersect
          commonFields = SCHEMA[allTypes[0]].fields.filter(f =>
            allTypes.every(t => SCHEMA[t].fields.includes(f))
          );
        }

        // Build batch edit HTML
        let batchHtml = '';
        if (commonFields.length) {
          batchHtml += `<div class="form-row" style="margin-top:8px"><strong style="font-size:11px">Batch Edit (common fields)</strong></div>`;
          const numericFields = config.numericFields || ['x','y','w','h','r','x1','x2','amp','period','strength','force','gap'];
          commonFields.forEach(f => {
            // Check if all values are the same
            const vals = selObs.map(o => o[f]);
            const allSame = vals.every(v => v === vals[0]);
            const displayVal = allSame ? (vals[0] ?? '') : '';
            const placeholder = allSame ? '' : 'mixed';
            const isNum = typeof vals.find(v => v !== undefined) === 'number' || numericFields.includes(f);
            if (isNum) {
              batchHtml += `<div class="form-row"><label>${f}</label><input type="number" step="any" class="batch-field" data-bfield="${f}" value="${displayVal}" placeholder="${placeholder}"></div>`;
            } else {
              batchHtml += `<div class="form-row"><label>${f}</label><input type="text" class="batch-field" data-bfield="${f}" value="${displayVal}" placeholder="${placeholder}"></div>`;
            }
          });
        }

        if (body) body.innerHTML = `
          <div class="multi-bar">
            <div class="multi-title">${state.selectedObsList.length} selected</div>
            <div class="action-row">
              <button class="btn btn-mini" id="bulk-align-x" title="Align X to primary">Align X</button>
              <button class="btn btn-mini" id="bulk-align-y" title="Align Y to primary">Align Y</button>
              <button class="btn btn-mini" id="bulk-snap-ground" title="Snap each to its ground position">Snap Ground</button>
              <button class="btn btn-mini" id="bulk-distribute" ${state.selectedObsList.length < 3 ? 'disabled' : ''} title="Distribute evenly between endpoints">Distribute</button>
              <button class="btn btn-mini" id="bulk-duplicate" title="Duplicate group">Duplicate</button>
              <button class="btn btn-mini" id="bulk-save-prefab" title="Save this group as a reusable prefab">Save Prefab</button>
              <button class="btn btn-mini btn-danger" id="bulk-delete" title="Delete all">Delete</button>
            </div>
            <div class="hint">Primary (last-clicked) is the alignment anchor. Shift+click to toggle items.</div>
            <div class="form-row"><label>Change type</label><select id="bulk-type-change"><option value="">— select —</option>${TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
            ${batchHtml}
          </div>`;
        $('bulk-align-x').addEventListener('click', () => bulkAlign('x'));
        $('bulk-align-y').addEventListener('click', () => bulkAlign('y'));
        $('bulk-snap-ground').addEventListener('click', () => bulkAlign('ground'));
        $('bulk-distribute').addEventListener('click', bulkDistribute);
        $('bulk-duplicate').addEventListener('click', () => { copySelection(); pasteClipboard(); });
        $('bulk-save-prefab').addEventListener('click', saveCurrentAsPrefab);
        $('bulk-delete').addEventListener('click', deleteSelected);
        const btcEl = $('bulk-type-change');
        if (btcEl) {
          btcEl.addEventListener('change', () => {
            const newType = btcEl.value; if (!newType) return;
            const count = state.selectedObsList.length;
            if (!confirm(`Change ${count} obstacles to ${newType}?`)) { btcEl.value = ''; return; }
            const ids = state.selectedObsList.filter(i => i >= 0);
            pushHistory(true, 'Type change');
            ids.forEach(i => { lvl.data.obstacles[i].type = newType; });
            render();
          });
        }
        // Batch field change handlers
        body.querySelectorAll('.batch-field').forEach(inp => {
          inp.addEventListener('change', () => {
            const f = inp.dataset.bfield;
            const raw = inp.value; if (raw === '') return;
            const ids = state.selectedObsList.filter(i => i >= 0);
            pushHistory(true, 'batch edit ' + f);
            const numVal = parseFloat(raw);
            const useNum = !isNaN(numVal) && inp.type === 'number';
            ids.forEach(i => { lvl.data.obstacles[i][f] = useNum ? numVal : raw; });
            render();
            toast(`Set ${f} on ${ids.length} obstacles`);
          });
        });
        return;
      }
      const o = lvl.data.obstacles[state.selectedObs];
      const sch = SCHEMA[o.type];
      if (!sch) { if (body) body.innerHTML = '<div class="empty-state">Unknown type: ' + o.type + '</div>'; return; }
      if (info) info.textContent = `${o.type} #${state.selectedObs + 1}`;
      let html = `<div class="props-header"><strong>${o.type}</strong><button class="btn btn-mini btn-danger" id="prop-delete">Delete</button></div>`;
      html += `<div class="form-row"><label>array pos</label><span>${state.selectedObs + 1} / ${lvl.data.obstacles.length}</span></div>`;
      html += `<div class="form-row"><label>Z-order</label><input type="number" id="prop-z" step="1" value="${o._z || 0}" title="Draw order (higher = drawn on top)"></div>`;
      html += `<div class="action-row">
        <button class="btn btn-mini" id="act-snap-ground" title="Align to ground">Snap Ground</button>
        <button class="btn btn-mini" id="act-mirror" title="Mirror horizontally">Mirror</button>
        <button class="btn btn-mini" id="act-duplicate" title="Duplicate">Duplicate</button>
      </div>`;
      const ENUMS = config.fieldEnums || {
        character: ['sleepy', 'bouncy', 'breezy'],
        variant:   ['pine', 'cherry'],
        dir:       [{ v: 1, label: '+1 (right/up)' }, { v: -1, label: '-1 (left/down)' }],
        pair:      null
      };
      const numericFields = config.numericFields || ['x','y','w','h','r','x1','x2','amp','period','crocX','strength','force','gap','dissolveMs','duty','stickMs','angle','restitution'];
      sch.fields.forEach(f => {
        const v = o[f];
        const isBool = typeof v === 'boolean' || f === 'hasCroc';
        if (isBool) {
          html += `<div class="form-row"><label>${f}</label><input type="checkbox" data-field="${f}" ${v ? 'checked' : ''}></div>`;
        } else if (ENUMS[f]) {
          const opts = ENUMS[f].map(opt => {
            const val = typeof opt === 'object' ? opt.v : opt;
            const label = typeof opt === 'object' ? opt.label : opt;
            const sel = String(v) === String(val) ? 'selected' : '';
            return `<option value="${val}" ${sel}>${label}</option>`;
          }).join('');
          html += `<div class="form-row"><label>${f}</label><select data-field="${f}" data-numeric="${typeof ENUMS[f][0] === 'object'}">${opts}</select></div>`;
        } else if (typeof v === 'number' || numericFields.includes(f)) {
          const rangeHint = config.fieldRanges && config.fieldRanges[f];
          const rangeAttrs = rangeHint ? ` min="${rangeHint[0]}" max="${rangeHint[1]}" title="${f}: ${rangeHint[0]}–${rangeHint[1]}"` : '';
          html += `<div class="form-row"><label>${f}</label><input type="number" step="any" data-field="${f}" value="${v ?? ''}"${rangeAttrs}></div>`;
        } else {
          html += `<div class="form-row"><label>${f}</label><input type="text" data-field="${f}" value="${v ?? ''}"></div>`;
        }
      });
      // Feature 2: Note textarea
      html += `<div class="form-row" style="flex-direction:column;align-items:flex-start;gap:3px"><label style="margin-bottom:2px">Note</label><textarea id="prop-note" style="width:100%;box-sizing:border-box;min-height:52px;font-size:11px;resize:vertical" placeholder="Optional note…">${o._note || ''}</textarea></div>`;
      if (body) {
        body.innerHTML = html;
        body.querySelectorAll('[data-field]').forEach(inp => {
          inp.addEventListener('input', () => {
            pushHistory();
            const f = inp.dataset.field;
            if (inp.type === 'checkbox') o[f] = inp.checked;
            else if (inp.tagName === 'SELECT' && inp.dataset.numeric === 'true') o[f] = parseFloat(inp.value);
            else if (inp.type === 'number') o[f] = parseFloat(inp.value);
            else o[f] = inp.value;
            render();
          });
        });
        // Feature 2: Note textarea handler
        const noteEl = $('prop-note');
        if (noteEl) {
          noteEl.addEventListener('input', () => {
            const val = noteEl.value;
            if (val) o._note = val;
            else delete o._note;
            scheduleRender();
          });
        }
        $('prop-delete').addEventListener('click', deleteSelected);
        const propZEl = $('prop-z');
        if (propZEl) {
          propZEl.addEventListener('change', () => {
            const zv = parseInt(propZEl.value);
            pushHistory(true, 'Z-order');
            o._z = isNaN(zv) ? 0 : zv;
            render();
          });
        }
        $('act-snap-ground').addEventListener('click', () => {
          pushHistory(true); snapToGround(o); render(); toast('Snapped to ground');
        });
        $('act-mirror').addEventListener('click', () => {
          pushHistory(true); mirrorX(o, lvl.data.worldW); render(); toast('Mirrored');
        });
        $('act-duplicate').addEventListener('click', () => { copySelection(); pasteClipboard(); });
      }
    };

    // ---------- Actions ----------
    const selectLevel = (idx) => {
      state.currentIdx = idx;
      state.selectedObs = -1;
      state.selectedObsList = [];
      state.selectedKind = null;
      if (config.autoFitOnSelect) fitCanvas();
      saveSettings();
      try {
        if (state._gameWin && !state._gameWin.closed) {
          const lvl = state.levels[idx];
          if (lvl) {
            if (lvl.courtId != null && lvl.slot != null) {
              publishSync({ announce: false });
              state._gameWin.location.href = `./?course=${lvl.courtId}&level=${lvl.slot}&editorSync=1&ts=${Date.now()}`;
            } else {
              writePreview(lvl);
              state._gameWin.location.href = `./?preview=1&ts=${Date.now()}`;
            }
          }
        }
      } catch (_) {}
      emit('levelChange', state.levels[state.currentIdx]);
      render();
    };

    const placeObstacle = (type, x, y) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      pushHistory(true, 'Place ' + type);
      state.recentTypes = [type, ...state.recentTypes.filter(t => t !== type)].slice(0, 8);
      saveSettings();
      const o = { type, ...cloneDeep(SCHEMA[type].defaults) };
      // Let plugin customize placement defaults via config.snapObstaclePlacement
      if (config.snapObstaclePlacement) {
        config.snapObstaclePlacement(o, x, y, snap, LEFT_PAD, GY);
      } else {
        if ('x' in o && !('x1' in o)) o.x = snap(x - LEFT_PAD);
        if ('y' in o && o.y > 0) o.y = snap(y);
        if ('x1' in o) {
          const sx = snap(x - LEFT_PAD);
          const w = (o.x2 - o.x1);
          o.x1 = sx; o.x2 = sx + w;
        }
      }
      lvl.data.obstacles.push(o);
      _flashObsCount('add');
      if (config.onObstaclePlace) { try { config.onObstaclePlace(cloneDeep(o), lvl); } catch(_){} }
      if (lvl.data.obstacles.length > 50) {
        toast('⚠ Level has ' + lvl.data.obstacles.length + ' obstacles — may impact performance', 4000);
      }
      state.selectedObs = lvl.data.obstacles.length - 1;
      state.selectedObsList = [state.selectedObs];
      state.selectedKind = 'obs';
      render();
    };

    const deleteSelected = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (state.selectedKind !== 'obs') return;
      const ids = (state.selectedObsList.length ? state.selectedObsList : [state.selectedObs])
        .filter(i => i >= 0)
        .sort((a, b) => b - a);
      if (!ids.length) return;
      const deleted = ids.map(i => cloneDeep(lvl.data.obstacles[i]));
      pushHistory(true, 'Delete');
      ids.forEach(i => lvl.data.obstacles.splice(i, 1));
      _flashObsCount('remove');
      if (config.onObstacleDelete) { try { config.onObstacleDelete(deleted, lvl); } catch(_){} }
      state.selectedObs = -1;
      state.selectedObsList = [];
      state.selectedKind = null;
      render();
      toast(ids.length === 1 ? 'Deleted' : `Deleted ${ids.length}`);
    };

    // ---------- Feature 1: Obstacle groups ----------
    const groupSelected = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.filter(i => i >= 0 && i < lvl.data.obstacles.length);
      if (ids.length < 2) { toast('Select 2+ obstacles to group'); return; }
      pushHistory(true, 'Group');
      const groupId = 'group-' + Date.now();
      ids.forEach(i => { lvl.data.obstacles[i]._group = groupId; });
      render();
      toast(`Grouped ${ids.length} obstacles`);
    };
    const ungroupSelected = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const ids = state.selectedObsList.filter(i => i >= 0 && i < lvl.data.obstacles.length);
      if (!ids.length) { toast('Select grouped obstacles to ungroup'); return; }
      pushHistory(true, 'Ungroup');
      ids.forEach(i => { delete lvl.data.obstacles[i]._group; });
      render();
      toast(`Ungrouped ${ids.length} obstacles`);
    };
    // When clicking a grouped obstacle in select mode, expand selection to entire group
    const expandGroupSelection = (clickedIdx) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const o = lvl.data.obstacles[clickedIdx];
      if (!o || !o._group) return;
      const groupId = o._group;
      const groupIds = lvl.data.obstacles.map((ob, i) => ob._group === groupId ? i : -1).filter(i => i >= 0);
      if (groupIds.length > 1) {
        state.selectedObsList = groupIds;
        state.selectedObs = clickedIdx;
        state.selectedKind = 'obs';
      }
    };
    // Draw dashed bounding boxes around groups
    const renderGroupOutlines = (lvl) => {
      if (!lvl) return;
      const groups = {};
      lvl.data.obstacles.forEach((o, i) => {
        if (!o._group || !o._bbox) return;
        if (!groups[o._group]) groups[o._group] = [];
        groups[o._group].push(o._bbox);
      });
      Object.values(groups).forEach(bboxes => {
        if (bboxes.length < 2) return;
        const x1 = Math.min(...bboxes.map(b => b[0])) - 4;
        const y1 = Math.min(...bboxes.map(b => b[1])) - 4;
        const x2 = Math.max(...bboxes.map(b => b[0] + b[2])) + 4;
        const y2 = Math.max(...bboxes.map(b => b[1] + b[3])) + 4;
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(120,200,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
        ctx.restore();
      });
    };

    // ---------- Run 3 Feature 2: Level diff ----------
    const showLevelDiff = () => {
      const lvl = state.levels[state.currentIdx];
      if (!lvl) { toast('No level open'); return; }
      if (!state._savedSnapshot) { toast('No saved snapshot — save first'); return; }
      const savedLvl = state._savedSnapshot[state.currentIdx];
      if (!savedLvl) { toast('This level has no saved state'); return; }
      const cur = lvl.data;
      const sav = savedLvl.data;
      const curObs = cur.obstacles || [];
      const savObs = sav.obstacles || [];
      const added   = curObs.length - savObs.length > 0 ? curObs.length - savObs.length : 0;
      const removed = savObs.length - curObs.length > 0 ? savObs.length - curObs.length : 0;
      // Properties changed (top-level scalar fields)
      const propFields = ['name','subtitle','worldW','time','maxShots','description'];
      const changedProps = propFields.filter(f => String(cur[f] ?? '') !== String(sav[f] ?? ''));
      // Also check starShots array equality
      if (JSON.stringify(cur.starShots) !== JSON.stringify(sav.starShots)) changedProps.push('starShots');
      if (!added && !removed && !changedProps.length) {
        // Remove any existing diff overlay
        const existing = document.getElementById('level-diff-overlay');
        if (existing) existing.remove();
        toast('No changes since last save');
        return;
      }
      // Remove old overlay
      const old = document.getElementById('level-diff-overlay');
      if (old) old.remove();
      const div = document.createElement('div');
      div.id = 'level-diff-overlay';
      div.style.cssText = `
        position:fixed;bottom:52px;right:20px;z-index:9999;
        background:rgba(20,20,30,0.95);color:#fff;
        padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.6;
        box-shadow:0 4px 18px rgba(0,0,0,0.55);max-width:300px;
        border:1px solid rgba(255,255,255,0.12);
      `;
      let html = '<strong style="font-size:14px">Level Changes</strong><br>';
      if (added)   html += `<span style="color:#4ecb71">+ ${added} obstacle${added===1?'':'s'} added</span><br>`;
      if (removed) html += `<span style="color:#e55">− ${removed} obstacle${removed===1?'':'s'} removed</span><br>`;
      if (changedProps.length) html += `<span style="color:#f0c060">~ ${changedProps.join(', ')} changed</span><br>`;
      html += '<button id="diff-close" style="margin-top:8px;padding:2px 10px;cursor:pointer;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:4px;font-size:12px;">Close</button>';
      div.innerHTML = html;
      document.body.appendChild(div);
      document.getElementById('diff-close')?.addEventListener('click', () => div.remove());
    };

    // ---------- Run 3 Feature 1: Overlap detection ----------
    const detectOverlaps = (lvl) => {
      if (!lvl) return { count: 0, pairs: [] };
      const obs = lvl.data.obstacles;
      const pairs = [];
      for (let i = 0; i < obs.length; i++) {
        const a = obs[i]._bbox; if (!a) continue;
        for (let j = i + 1; j < obs.length; j++) {
          const b = obs[j]._bbox; if (!b) continue;
          // AABB intersection
          if (a[0] < b[0] + b[2] && a[0] + a[2] > b[0] &&
              a[1] < b[1] + b[3] && a[1] + a[3] > b[1]) {
            pairs.push({ i, j,
              ix: Math.max(a[0], b[0]),
              iy: Math.max(a[1], b[1]),
              iw: Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
              ih: Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]),
            });
          }
        }
      }
      return { count: pairs.length, pairs };
    };
    const renderOverlaps = (lvl) => {
      const { count, pairs } = detectOverlaps(lvl);
      if (!pairs.length) return;
      ctx.save();
      ctx.fillStyle = 'rgba(255,30,30,0.32)';
      ctx.strokeStyle = 'rgba(255,50,50,0.75)';
      ctx.lineWidth = 1.5;
      pairs.forEach(({ ix, iy, iw, ih }) => {
        ctx.fillRect(ix, iy, iw, ih);
        ctx.strokeRect(ix, iy, iw, ih);
      });
      ctx.restore();
      emit('overlapsDetected', { count, pairs });
    };

    // ---------- Play in game ----------
    const writePreview = (lvl) => {
      try {
        localStorage.setItem(PREVIEW_KEY, JSON.stringify({
          ...lvl.data,
          _courtId: lvl.courtId != null ? lvl.courtId : null
        }));
        return true;
      } catch (e) { return false; }
    };

    const playInGame = (idx) => {
      const lvl = state.levels[idx != null ? idx : state.currentIdx];
      if (!lvl) { toast('No level selected'); return; }
      state.sync.enabled = true;
      publishSync({ announce: false });
      let url;
      const courseArr = state.sync.courses[String(lvl.courtId)];
      const hasProperSlot = lvl.courtId != null && lvl.slot != null &&
        courseArr && courseArr[lvl.slot - 1];
      if (hasProperSlot) {
        url = `./?course=${lvl.courtId}&level=${lvl.slot}&editorSync=1&ts=${Date.now()}`;
      } else {
        if (!writePreview(lvl)) { toast('Preview save failed (storage?)'); return; }
        url = `./?preview=1&ts=${Date.now()}`;
      }
      if (state._gameWin && !state._gameWin.closed) {
        state._gameWin.location.href = url;
        try { state._gameWin.focus(); } catch (_) {}
      } else {
        state._gameWin = window.open(url, 'level-editor-test');
      }
    };

    // ---------- Mouse ----------
    const canvasPt = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / state.zoom,
        y: (e.clientY - rect.top) / state.zoom
      };
    };

    // pan state (space+drag)
    const panState = { spaceDown: false, dragging: false, startX: 0, startY: 0, scrollL: 0, scrollT: 0 };
    const wrapEl = () => document.getElementById('canvas-wrap');

    // Helper: is point near world-resize handle?
    const nearWorldResizeHandle = (p) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return false;
      const hx = lvl.data.worldW + LEFT_PAD;
      return Math.abs(p.x - hx) <= 6;
    };

    const getSelectedObstacle = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return null;
      if (state.selectedKind !== 'obs' || state.selectedObs < 0) return null;
      const o = lvl.data.obstacles[state.selectedObs]; if (!o) return null;
      return { lvl, o, index: state.selectedObs };
    };

    const obsResizeHandleAt = (p) => {
      if (!config.getResizeHandles) return null;
      const sel = getSelectedObstacle(); if (!sel) return null;
      if (state.selectedObsList && state.selectedObsList.length > 1) return null;
      let hs = [];
      try {
        hs = config.getResizeHandles(sel.o, sel.lvl, {
          leftPad: LEFT_PAD,
          groundY: GY,
          canvasH: CANVAS_H,
          zoom: state.zoom,
          snap,
        }) || [];
      } catch (_) { hs = []; }
      if (!Array.isArray(hs) || !hs.length) return null;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        const r = h.hitRadius ?? 12;
        const hx = h.x ?? 0;
        const hy = h.y ?? 0;
        if (Math.hypot(p.x - hx, p.y - hy) <= r) return { handle: h };
      }
      return null;
    };

    canvas.addEventListener('mousemove', (e) => {
      if (state._obsResizeDrag) {
        const p = canvasPt(e);
        const sel = getSelectedObstacle();
        if (sel && sel.index === state._obsResizeDrag.index && config.applyResizeDrag) {
          try {
            config.applyResizeDrag(sel.o, sel.lvl, state._obsResizeDrag.handle, {
              canvasX: p.x,
              canvasY: p.y,
              x: snap(p.x - LEFT_PAD),
              y: snap(p.y),
              leftPad: LEFT_PAD,
              groundY: GY,
              canvasH: CANVAS_H,
              zoom: state.zoom,
              snap,
            });
          } catch (_) {}
        }
        scheduleRender();
        e.stopPropagation();
        return;
      }
      if (state._worldResizeDrag) {
        const p = canvasPt(e);
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const newW = Math.max(400, Math.min(8000, Math.round(p.x - LEFT_PAD)));
        lvl.data.worldW = newW;
        const ww = $('in-worldW'); if (ww) ww.value = newW;
        const wwd = $('world-width-display'); if (wwd) wwd.textContent = newW;
        resizeCanvas(); scheduleRender();
        e.stopPropagation(); return;
      }
      const p = canvasPt(e);
      const hover = nearWorldResizeHandle(p);
      const oh = obsResizeHandleAt(p);
      const wantCursor = hover ? 'ew-resize' : (oh?.handle?.cursor || (oh ? 'ew-resize' : ''));
      const cursorChanged = canvas.style.cursor !== wantCursor;
      const hoverChanged = (hover !== state._worldResizeHover) || ((!!oh) !== (!!state._obsResizeHover));
      state._worldResizeHover = hover;
      state._obsResizeHover = oh ? oh.handle : null;
      if (cursorChanged) canvas.style.cursor = wantCursor;
      if (hoverChanged) scheduleRender();
    }, true); // capture phase so it runs before the regular mousemove

    canvas.addEventListener('mousedown', (e) => {
      const p = canvasPt(e);
      if (panState.spaceDown) return;
      // Prefab placement mode — click to place
      if (state.pendingPrefab) {
        insertPrefab(state.pendingPrefab, state.pendingPrefabX);
        cancelPrefabPlace();
        e.preventDefault(); e.stopPropagation(); return;
      }
      // World resize handle
      if (nearWorldResizeHandle(p) && state.levels[state.currentIdx]) {
        const lvl = state.levels[state.currentIdx];
        pushHistory(true, 'Resize world');
        state._worldResizeDrag = { origW: lvl.data.worldW };
        canvas.style.cursor = 'ew-resize';
        e.preventDefault(); e.stopPropagation(); return;
      }
      // Obstacle resize handle (config-driven)
      const oh = obsResizeHandleAt(p);
      if (oh && state.levels[state.currentIdx]) {
        const idx = state.selectedObs;
        if (idx >= 0) {
          pushHistory(true, config.resizeHistoryLabel || 'Resize');
          state._obsResizeDrag = { index: idx, handle: oh.handle };
          canvas.style.cursor = oh.handle.cursor || 'ew-resize';
          e.preventDefault(); e.stopPropagation(); return;
        }
      }
      if (state.tool === 'eraser') {
        const h = hitTest(p.x, p.y);
        if (h && h.kind === 'obs') {
          const lvl = state.levels[state.currentIdx];
          pushHistory(true);
          lvl.data.obstacles.splice(h.index, 1);
          if (state.selectedObs === h.index) { state.selectedKind = null; state.selectedObs = -1; }
          render();
          toast('Erased');
        }
        return;
      }
      if (state.tool !== 'select' && state.tool !== 'ballStart' && state.tool !== 'hole') {
        placeObstacle(state.tool, p.x, p.y);
        return;
      }
      if (state.tool === 'ballStart') {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        pushHistory(true);
        lvl.data.ballStart.x = snap(p.x - LEFT_PAD);
        lvl.data.ballStart.y = snap(p.y);
        render(); return;
      }
      if (state.tool === 'hole') {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        pushHistory(true);
        lvl.data.hole.x = snap(p.x - LEFT_PAD);
        render(); return;
      }
      const h = hitTest(p.x, p.y);
      if (!h) {
        if (!e.shiftKey) { state.selectedKind = null; state.selectedObs = -1; state.selectedObsList = []; }
        state.marquee = { startX: p.x, startY: p.y, endX: p.x, endY: p.y, additive: e.shiftKey };
        render();
        return;
      }
      state.selectedKind = h.kind;
      state.selectedObs = h.index ?? -1;
      if (h.kind === 'obs') {
        if (e.shiftKey) {
          const i = state.selectedObsList.indexOf(h.index);
          if (i >= 0) state.selectedObsList.splice(i, 1);
          else state.selectedObsList.push(h.index);
        } else if (!state.selectedObsList.includes(h.index)) {
          state.selectedObsList = [h.index];
          // Feature 1: expand to whole group if obstacle belongs to one
          if (state.tool === 'select') expandGroupSelection(h.index);
        }
      } else {
        state.selectedObsList = [];
      }
      const lvl = state.levels[state.currentIdx];
      let origX, origY;
      if (h.kind === 'ball') { origX = lvl.data.ballStart.x; origY = lvl.data.ballStart.y; }
      else if (h.kind === 'hole') { origX = lvl.data.hole.x; origY = lvl.data.hole.y; }
      else {
        const o = lvl.data.obstacles[h.index];
        origX = o.x ?? o.x1 ?? 0;
        origY = o.y ?? 0;
      }
      pushHistory(true);
      state.drag = { kind: h.kind, index: h.index, startX: p.x, startY: p.y, origX, origY };
      render();
    });

    canvas.addEventListener('mousemove', (e) => {
      const p = canvasPt(e);
      const cp = $('cursor-pos');
      if (cp) {
        const snapIndicator = state.snap ? ' [snap]' : '';
        cp.textContent = `x: ${Math.round(p.x - LEFT_PAD)}  y: ${Math.round(p.y)}${snapIndicator}`;
      }
      // Validation badge hover tooltip
      let hovered = null;
      if (state.showValidationBadges && state._validationBadges?.length) {
        for (const bd of state._validationBadges) {
          if (Math.hypot(p.x - bd.cx, p.y - bd.cy) <= bd.r + 2) { hovered = bd; break; }
        }
      }
      let tipEl = $('validation-tooltip');
      if (hovered) {
        if (!tipEl) {
          tipEl = document.createElement('div');
          tipEl.id = 'validation-tooltip';
          document.body.appendChild(tipEl);
        }
        tipEl.textContent = hovered.msg;
        tipEl.className = 'v-tip v-tip-' + hovered.level;
        tipEl.style.left = (e.clientX + 12) + 'px';
        tipEl.style.top  = (e.clientY + 12) + 'px';
        tipEl.style.display = '';
      } else if (tipEl) {
        tipEl.style.display = 'none';
      }
      if (state.pendingPrefab) { state.pendingPrefabX = Math.round(p.x - LEFT_PAD); scheduleRender(); return; }
      if (state.marquee) { state.marquee.endX = p.x; state.marquee.endY = p.y; scheduleRender(); return; }
      if (!state.drag) return;
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      let dx = p.x - state.drag.startX;
      let dy = p.y - state.drag.startY;
      // Shift+drag: axis lock
      if (e.shiftKey && state.drag.kind === 'obs') {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (state.drag.kind === 'ball') {
        lvl.data.ballStart.x = snap(state.drag.origX + dx);
        lvl.data.ballStart.y = snap(state.drag.origY + dy);
      } else if (state.drag.kind === 'hole') {
        lvl.data.hole.x = snap(state.drag.origX + dx);
      } else if (state.drag.kind === 'obs') {
        const ids = state.selectedObsList.length ? state.selectedObsList : [state.drag.index];
        const primary = lvl.data.obstacles[state.drag.index];
        state.smartGuideX = null;
        state.snapGuideLines = null;
        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        let pointerWorldX = clamp(Math.round(p.x - LEFT_PAD), 0, lvl.data.worldW || 0);
        let pointerY = clamp(Math.round(p.y), 0, CANVAS_H);
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) pointerY = primary.y ?? pointerY;
          else pointerWorldX = primary.x1 != null ? Math.round((primary.x1 + primary.x2) / 2) : (primary.x ?? pointerWorldX);
        }
        let deltaX = 0;
        let deltaY = 0;
        if ('x1' in primary) {
          const w = primary.x2 - primary.x1;
          const newPrimaryX = clamp(pointerWorldX - w / 2, 0, Math.max(0, (lvl.data.worldW || 0) - w));
          deltaX = newPrimaryX - primary.x1;
        } else {
          const newPrimaryX = pointerWorldX;
          deltaX = newPrimaryX - primary.x;
        }
        const yLocked = config.yLockedTypes || new Set(['hill','movingHill','trampoline','spring','portal']);
        if ('y' in primary && primary.type !== 'magnet' && !yLocked.has(primary.type)) {
          deltaY = pointerY - primary.y;
        }

        ids.forEach(i => {
          const o = lvl.data.obstacles[i];
          if ('x1' in o) { o.x1 += deltaX; o.x2 += deltaX; }
          else if ('x' in o) { o.x += deltaX; }
          if ('y' in o && o.type !== 'magnet' && !yLocked.has(o.type)) {
            o.y += deltaY;
          }
        });
      }
      scheduleRender();
    });

    window.addEventListener('mouseup', () => {
      if (state._worldResizeDrag) {
        state._worldResizeDrag = null;
        canvas.style.cursor = '';
        markDirty();
      }
      if (state._obsResizeDrag) { state._obsResizeDrag = null; canvas.style.cursor = ''; markDirty(); render(); }
      if (state.drag) { state.smartGuideX = null; state.snapGuideLines = null; }
      state.drag = null;
      if (state.marquee) {
        const m = state.marquee; state.marquee = null;
        const x1 = Math.min(m.startX, m.endX), x2 = Math.max(m.startX, m.endX);
        const y1 = Math.min(m.startY, m.endY), y2 = Math.max(m.startY, m.endY);
        if (x2 - x1 < 4 && y2 - y1 < 4) { render(); return; }
        const lvl = state.levels[state.currentIdx];
        if (!lvl) { render(); return; }
        const picks = [];
        const candidates = (_spatial.count > 0 && _spatial.levelRef === lvl)
          ? queryRect(x1, y1, x2, y2)
          : lvl.data.obstacles.map((_, i) => i);
        candidates.forEach(i => {
          const o = lvl.data.obstacles[i]; if (!o) return;
          const b = o._bbox; if (!b) return;
          if (b[0] + b[2] >= x1 && b[0] <= x2 && b[1] + b[3] >= y1 && b[1] <= y2) picks.push(i);
        });
        if (m.additive) {
          picks.forEach(i => { if (!state.selectedObsList.includes(i)) state.selectedObsList.push(i); });
        } else {
          state.selectedObsList = picks;
        }
        if (state.selectedObsList.length) {
          state.selectedKind = 'obs';
          state.selectedObs = state.selectedObsList[state.selectedObsList.length - 1];
          toast(`${state.selectedObsList.length} selected`);
        }
        render();
      }
    });

    // ---------- Context menu ----------
    const showContextMenu = (clientX, clientY, items) => {
      const el = $('context-menu');
      if (!el) return;
      el.innerHTML = '';
      items.forEach(it => {
        if (it.sep) { const s = document.createElement('div'); s.className = 'cm-sep'; el.appendChild(s); return; }
        const b = document.createElement('button');
        b.className = 'cm-item';
        b.textContent = it.label;
        if (it.danger) b.classList.add('danger');
        if (it.disabled) b.disabled = true;
        b.addEventListener('click', () => {
          hideContextMenu();
          try { it.run(); } catch (e) { console.error(e); }
        });
        el.appendChild(b);
      });
      el.style.display = '';
      el.style.left = '0px'; el.style.top = '0px';
      const rect = el.getBoundingClientRect();
      const x = Math.min(clientX, window.innerWidth - rect.width - 6);
      const y = Math.min(clientY, window.innerHeight - rect.height - 6);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    };
    const hideContextMenu = () => {
      const el = $('context-menu'); if (el) el.style.display = 'none';
    };
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = canvasPt(e);
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const h = hitTest(p.x, p.y);
      const items = [];
      if (h && h.kind === 'obs') {
        state.selectedKind = 'obs'; state.selectedObs = h.index; render();
        const o = lvl.data.obstacles[h.index];
        items.push(
          { label: `Duplicate ${o.type}`, run: () => { copySelection(); pasteClipboard(); } },
          { label: 'Duplicate in place', run: () => duplicateInPlace() },
          { label: 'Mirror', run: () => { pushHistory(true); mirrorX(o, lvl.data.worldW); render(); } },
          { label: 'Snap to ground', run: () => { pushHistory(true); snapToGround(o); render(); } },
          { label: 'Bring to front', run: () => {
              pushHistory(true);
              const [item] = lvl.data.obstacles.splice(h.index, 1);
              lvl.data.obstacles.push(item);
              state.selectedObs = lvl.data.obstacles.length - 1;
              render();
            } },
          { label: 'Send to back', run: () => {
              pushHistory(true);
              const [item] = lvl.data.obstacles.splice(h.index, 1);
              lvl.data.obstacles.unshift(item);
              state.selectedObs = 0;
              render();
            } },
          { label: 'Bring Forward (_z+1)', run: () => {
              pushHistory(true, 'Bring Forward');
              const obs = lvl.data.obstacles[h.index];
              obs._z = (obs._z || 0) + 1;
              render();
            } },
          { label: 'Send Backward (_z-1)', run: () => {
              pushHistory(true, 'Send Backward');
              const obs = lvl.data.obstacles[h.index];
              obs._z = (obs._z || 0) - 1;
              render();
            } },
          { label: state.lockedObs.has(h.index) ? 'Unlock' : 'Lock', run: () => {
              if (state.lockedObs.has(h.index)) { state.lockedObs.delete(h.index); toast('Unlocked'); }
              else { state.lockedObs.add(h.index); toast('Locked'); }
              render();
            } }
        );
        if (Array.isArray(config.contextMenuItems)) {
          config.contextMenuItems.forEach(ci => {
            items.push({ label: ci.label, run: () => { try { ci.run(o, lvl.data); } catch(_){} } });
          });
        }
        if (state.selectedObsList.length >= 2) {
          const lvlObs = lvl.data.obstacles;
          const selGroups = [...new Set(state.selectedObsList.map(i => lvlObs[i]?._group).filter(Boolean))];
          const allSameGroup = selGroups.length === 1 && state.selectedObsList.every(i => lvlObs[i]?._group === selGroups[0]);
          if (allSameGroup) {
            items.push({ sep: true }, { label: 'Ungroup', run: ungroupSelected });
          } else {
            items.push({ sep: true }, { label: 'Group', run: groupSelected });
          }
          items.push(
            { sep: true },
            { label: 'Align Left',     run: () => alignSelected('left') },
            { label: 'Align Right',    run: () => alignSelected('right') },
            { label: 'Align Top',      run: () => alignSelected('top') },
            { label: 'Align Bottom',   run: () => alignSelected('bottom') },
            { label: 'Center Horiz',   run: () => alignSelected('centerH') },
            { label: 'Center Vert',    run: () => alignSelected('centerV') }
          );
        }
        // Copy to level option — only when obstacles are selected
        if (state.selectedObsList.length >= 1 && state.levels.length > 1) {
          items.push(
            { sep: true },
            { label: 'Copy to level…', run: () => {
                const names = state.levels.map((l, i) => `${i}: ${l.data.name || '(unnamed)'}`).join('\n');
                const input = prompt(`Copy selected obstacle(s) to level (0-based index):\n${names}`, '');
                if (input == null) return;
                const targetIdx = parseInt(input, 10);
                if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= state.levels.length) {
                  toast('Invalid level index'); return;
                }
                if (targetIdx === state.currentIdx) { toast('Already in this level'); return; }
                const target = state.levels[targetIdx];
                const ids = state.selectedObsList.length ? state.selectedObsList : [state.selectedObs];
                const copies = ids.filter(i => i >= 0).map(i => cloneDeep(lvl.data.obstacles[i]));
                if (!copies.length) return;
                // Push history for target level by temporarily switching and back
                const prevIdx = state.currentIdx;
                state.currentIdx = targetIdx;
                pushHistory(true, 'Copy from level ' + prevIdx);
                state.currentIdx = prevIdx;
                copies.forEach(o => target.data.obstacles.push(o));
                markDirty();
                toast(`Copied ${copies.length} obstacle(s) to "${target.data.name || '(unnamed)'}"`, 3000);
              }
            }
          );
        }
        items.push(
          { sep: true },
          { label: 'Delete', danger: true, run: deleteSelected }
        );
      } else if (h && h.kind === 'ball') {
        items.push({ label: 'Scroll to ball', run: () => scrollTo(lvl.data.ballStart.x, lvl.data.ballStart.y) });
      } else if (h && h.kind === 'hole') {
        items.push({ label: 'Scroll to hole', run: () => scrollTo(lvl.data.hole.x, lvl.data.hole.y) });
      } else {
        items.push(
          { label: clipboard ? `Paste ${clipboard[0]?.type || ''}` : 'Nothing to paste', disabled: !clipboard,
            run: () => { if (clipboard) { pasteClipboard(); } } },
          { label: 'Fit to window', run: () => { fitCanvas(); render(); } },
          { label: 'Play this level', run: () => playInGame() }
        );
      }
      // Feature 3: Export current level — always visible when a level is loaded
      items.push(
        { sep: true },
        { label: 'Export this level…', run: () => {
            const lvl = state.levels[state.currentIdx]; if (!lvl) return;
            const safeName = (lvl.data.name || 'level').replace(/[^a-z0-9_\-]/gi, '_');
            const blob = new Blob([JSON.stringify(lvl.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = safeName + '.json'; a.click();
            URL.revokeObjectURL(url);
            toast('Exported ' + safeName + '.json');
          }
        }
      );
      showContextMenu(e.clientX, e.clientY, items);
    });
    window.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) hideContextMenu();
    });
    window.addEventListener('scroll', hideContextMenu, true);

    // ---------- Clipboard ----------
    let clipboard = null;
    const copySelection = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (state.selectedKind !== 'obs') return;
      const ids = state.selectedObsList.length ? state.selectedObsList : [state.selectedObs];
      const items = ids.filter(i => i >= 0).map(i => cloneDeep(lvl.data.obstacles[i]));
      if (!items.length) return;
      clipboard = items;
      // Feature 5: reset paste counter on new copy
      const key = JSON.stringify(items.map(o => o.type + (o.x ?? o.x1 ?? 0)));
      if (key !== state._lastClipboardKey) { state._pasteCount = 0; state._lastClipboardKey = key; }
      toast(items.length === 1 ? 'Copied ' + items[0].type : `Copied ${items.length} obstacles`);
    };
    const pasteAtCenter = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl || !clipboard || !clipboard.length) return;
      pushHistory(true, 'Paste');
      const w = wrapEl();
      const centerX = w ? w.scrollLeft / state.zoom - LEFT_PAD + (w.clientWidth / state.zoom / 2) : 400;
      const centerY = w ? w.scrollTop / state.zoom + (w.clientHeight / state.zoom / 2) : GY;
      // Calculate clipboard centroid
      let sumX = 0, count = 0;
      clipboard.forEach(src => {
        const cx = src.x ?? (src.x1 != null ? (src.x1 + src.x2) / 2 : 0);
        sumX += cx; count++;
      });
      const clipCenterX = count ? sumX / count : 0;
      const offX = centerX - clipCenterX;
      const newIds = [];
      clipboard.forEach(src => {
        const o = cloneDeep(src);
        if ('x' in o && !('x1' in o)) o.x = snap((o.x || 0) + offX);
        if ('x1' in o) { o.x1 = snap(o.x1 + offX); o.x2 = snap(o.x2 + offX); }
        lvl.data.obstacles.push(o);
        newIds.push(lvl.data.obstacles.length - 1);
      });
      state.selectedObsList = newIds;
      state.selectedObs = newIds[newIds.length - 1];
      state.selectedKind = 'obs';
      render();
      toast(clipboard.length === 1 ? 'Pasted at center' : `Pasted ${clipboard.length} at center`);
    };
    const pasteClipboard = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl || !clipboard || !clipboard.length) return;
      pushHistory(true, 'Paste');
      // Feature 5: incremental paste offset
      state._pasteCount++;
      const off = state._pasteCount * state.pasteOffset;
      const newIds = [];
      clipboard.forEach(src => {
        const o = cloneDeep(src);
        if ('x' in o && !('x1' in o)) o.x = snap((o.x || 0) + off);
        if ('x1' in o) { o.x1 = snap(o.x1 + off); o.x2 = snap(o.x2 + off); }
        lvl.data.obstacles.push(o);
        newIds.push(lvl.data.obstacles.length - 1);
      });
      state.selectedObsList = newIds;
      state.selectedObs = newIds[newIds.length - 1];
      state.selectedKind = 'obs';
      render();
      const msg = clipboard.length === 1 ? 'Pasted' : `Pasted ${clipboard.length}`;
      toast(`${msg} at +${off}px offset`);
    };

    const pasteBelow = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl || !clipboard || !clipboard.length) return;
      pushHistory(true, 'Paste below');
      const off = state.gridSize;
      const newIds = [];
      clipboard.forEach(src => {
        const o = cloneDeep(src);
        if ('y' in o) o.y = snap((o.y || 0) + off);
        lvl.data.obstacles.push(o);
        newIds.push(lvl.data.obstacles.length - 1);
      });
      state.selectedObsList = newIds;
      state.selectedObs = newIds[newIds.length - 1];
      state.selectedKind = 'obs';
      render();
      toast(clipboard.length === 1 ? 'Pasted below' : `Pasted ${clipboard.length} below`);
    };

    // ---------- Run 3 Feature 3: Duplicate in place ----------
    const duplicateInPlace = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (state.selectedKind !== 'obs') { toast('Select obstacles first'); return; }
      const ids = state.selectedObsList.length ? state.selectedObsList : (state.selectedObs >= 0 ? [state.selectedObs] : []);
      if (!ids.length) { toast('Select obstacles first'); return; }
      pushHistory(true, 'duplicate in place');
      const OFF = 20;
      const newIds = [];
      ids.filter(i => i >= 0 && i < lvl.data.obstacles.length).forEach(i => {
        const o = cloneDeep(lvl.data.obstacles[i]);
        if ('x1' in o) { o.x1 += OFF; o.x2 += OFF; }
        else if ('x' in o) o.x += OFF;
        if ('y' in o) o.y += OFF;
        lvl.data.obstacles.push(o);
        newIds.push(lvl.data.obstacles.length - 1);
      });
      state.selectedObsList = newIds;
      state.selectedObs = newIds[newIds.length - 1];
      state.selectedKind = 'obs';
      render();
      toast(`Duplicated ${newIds.length} in place`);
    };

    // ---------- Keyboard nudge ----------
    const nudge = (dx, dy) => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (!state.selectedKind) return;
      pushHistory();
      if (state.selectedKind === 'ball') {
        lvl.data.ballStart.x += dx; lvl.data.ballStart.y += dy;
      } else if (state.selectedKind === 'hole') {
        lvl.data.hole.x += dx;
      } else if (state.selectedKind === 'obs') {
        const ids = state.selectedObsList.length ? state.selectedObsList : [state.selectedObs];
        const yLocked = config.yLockedTypes || new Set(['hill','movingHill','trampoline','spring','portal']);
        ids.filter(i => i >= 0).forEach(i => {
          const o = lvl.data.obstacles[i];
          if ('x1' in o) { o.x1 += dx; o.x2 += dx; }
          else if ('x' in o) { o.x += dx; }
          if ('y' in o && !yLocked.has(o.type)) { o.y += dy; }
        });
      }
      render();
    };

    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = e.target.matches('input, textarea, select');
      if (!inField && mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
      if (!inField && mod && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (!inField && mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySelection(); return; }
      if (!inField && mod && e.shiftKey && (e.key === 'V')) { e.preventDefault(); pasteAtCenter(); return; }
      if (!inField && mod && !e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteClipboard(); return; }
      if (!inField && mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); copySelection(); deleteSelected(); return; }
      if (!inField && mod && e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); showLevelDiff(); return; }
      if (!inField && mod && !e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateInPlace(); return; }
      if (!inField && mod && !e.shiftKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); groupSelected(); return; }
      if (!inField && mod && e.shiftKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); ungroupSelected(); return; }
      if (!inField && mod && e.shiftKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); mirrorSelected(); return; }
      if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        const h = $('help-overlay'); if (h) { h.style.display = ''; $('help-close')?.focus(); }
        return;
      }
      if (e.key === 'Escape') {
        if (state.pendingPrefab) { cancelPrefabPlace(); e.preventDefault(); return; }
        const h = $('help-overlay');
        if (h && h.style.display !== 'none') { h.style.display = 'none'; e.preventDefault(); return; }
      }
      if (!inField && e.key === 'Tab' && state.tool === 'select') {
        const lvl = state.levels[state.currentIdx];
        if (lvl && lvl.data.obstacles.length) {
          e.preventDefault();
          const n = lvl.data.obstacles.length;
          let next;
          if (state.selectedKind === 'obs' && state.selectedObs >= 0) {
            next = e.shiftKey ? (state.selectedObs - 1 + n) % n : (state.selectedObs + 1) % n;
          } else {
            next = e.shiftKey ? n - 1 : 0;
          }
          // Skip locked obstacles
          let tries = 0;
          while (state.lockedObs.has(next) && tries < n) {
            next = e.shiftKey ? (next - 1 + n) % n : (next + 1) % n;
            tries++;
          }
          state.selectedKind = 'obs';
          state.selectedObs = next;
          state.selectedObsList = [next];
          scrollToSelection();
          render();
        }
      }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('btn-zoom-in')?.click(); return; }
      if (mod && e.key === '-') { e.preventDefault(); $('btn-zoom-out')?.click(); return; }
      if (mod && e.key === '0') { e.preventDefault(); state.zoom = 1; resizeCanvas(); render(); saveSettings(); toast('Zoom 100%'); return; }
      if (!inField && mod && e.key === 'Home') { e.preventDefault(); selectLevel(0); return; }
      if (!inField && mod && e.key === 'End') { e.preventDefault(); selectLevel(state.levels.length - 1); return; }
      if (!inField && mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); $('btn-new-level')?.click(); return; }
      if (!inField && mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const lvl = state.levels[state.currentIdx];
        if (lvl && lvl.data.obstacles.length) {
          state.selectedKind = 'obs';
          state.selectedObsList = lvl.data.obstacles.map((_, i) => i);
          state.selectedObs = state.selectedObsList[state.selectedObsList.length - 1];
          render();
          toast(`Selected all (${state.selectedObsList.length})`);
        }
        return;
      }
      // Tool shortcuts (before inField guard)
      if (!inField && e.key === '1') { e.preventDefault(); state.tool = 'select'; document.querySelectorAll('.asset-btn, .tool-btn').forEach(el => { el.classList.remove('active'); if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false'); }); document.querySelector('.tool-btn[data-tool="select"]')?.classList.add('active'); canvas.style.cursor = ''; saveSettings(); render(); return; }
      if (!inField && e.key === '2') { e.preventDefault(); state.tool = 'eraser'; document.querySelectorAll('.asset-btn, .tool-btn').forEach(el => { el.classList.remove('active'); if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false'); }); document.querySelector('.tool-btn[data-tool="eraser"]')?.classList.add('active'); canvas.style.cursor = 'crosshair'; saveSettings(); render(); return; }
      if (!inField && e.key === '3' && SCHEMA['ballStart']) { e.preventDefault(); state.tool = 'ballStart'; saveSettings(); render(); return; }
      if (!inField && e.key === '4') { e.preventDefault(); state.tool = 'hole'; saveSettings(); render(); return; }
      if (!inField && (e.key === 'g' || e.key === 'G') && !mod) { e.preventDefault(); state.showGrid = !state.showGrid; const og = $('opt-grid'); if (og) og.checked = state.showGrid; saveSettings(); render(); return; }
      // Level reorder Alt+Arrow
      if (!inField && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.currentIdx >= 0) {
        e.preventDefault();
        const ci = state.currentIdx;
        const target = e.key === 'ArrowUp' ? ci - 1 : ci + 1;
        if (target >= 0 && target < state.levels.length) {
          pushHistory(true, 'Reorder');
          [state.levels[ci], state.levels[target]] = [state.levels[target], state.levels[ci]];
          state.currentIdx = target;
          render(); saveSettings();
        }
        return;
      }
      if (!inField && e.key === '[') { e.preventDefault(); state.gridSize = Math.max(5, state.gridSize - 5); toast('Grid: ' + state.gridSize + 'px'); saveSettings(); return; }
      if (!inField && e.key === ']') { e.preventDefault(); state.gridSize = Math.min(100, state.gridSize + 5); toast('Grid: ' + state.gridSize + 'px'); saveSettings(); return; }
      if (inField) return;
      const step = e.shiftKey ? 1 : GRID;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); nudge(-step, 0); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); nudge(0, -step); return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); nudge(0, step); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
      if (e.key === 'Escape') { state.selectedKind = null; state.selectedObs = -1; state.selectedObsList = []; state.tool = 'select'; render(); }
      const lvl = state.levels[state.currentIdx];
      if (lvl && e.key === 'Home') { e.preventDefault(); scrollTo(lvl.data.ballStart.x, lvl.data.ballStart.y); }
      if (lvl && e.key === 'End')  { e.preventDefault(); scrollTo(lvl.data.hole.x, lvl.data.hole.y); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitCanvas(); render(); toast('Fit to window'); }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); playInGame(); }
      // NOTE: ruler has no keyboard shortcut in this embed.
      if ((e.key === 'h' || e.key === 'H') && !mod) {
        const lvl = state.levels[state.currentIdx];
        if (lvl && state.selectedKind === 'obs' && state.selectedObs >= 0) {
          const o = lvl.data.obstacles[state.selectedObs];
          if (o) {
            if (state.hiddenTypes.has(o.type)) state.hiddenTypes.delete(o.type);
            else state.hiddenTypes.add(o.type);
            toast(state.hiddenTypes.has(o.type) ? `Hidden: ${o.type}` : `Visible: ${o.type}`);
            render();
          }
        }
      }
      if ((e.key === 'l' || e.key === 'L') && !mod) {
        const lvl = state.levels[state.currentIdx];
        if (lvl && state.selectedKind === 'obs') {
          const ids = state.selectedObsList.length ? state.selectedObsList : (state.selectedObs >= 0 ? [state.selectedObs] : []);
          if (ids.length) {
            const willLock = !state.lockedObs.has(ids[0]);
            ids.forEach(i => { if (willLock) state.lockedObs.add(i); else state.lockedObs.delete(i); });
            toast(willLock ? `Locked ${ids.length}` : `Unlocked ${ids.length}`);
            render();
          }
        }
      }
      if ((e.key === 'z' || e.key === 'Z') && !mod) {
        e.preventDefault();
        document.body.classList.toggle('is-zen');
        fitCanvas(); render();
        toast(document.body.classList.contains('is-zen') ? 'Zen mode' : 'Zen off');
      }
    });

    // ---------- Feature 4: Level templates ----------
    const LEVEL_TEMPLATES = Array.isArray(config.levelTemplates) ? config.levelTemplates : [];
    const newLevelFromTemplate = (tmpl) => {
      const base = newLevel();
      if (tmpl && tmpl.data) {
        Object.assign(base.data, cloneDeep(tmpl.data));
        if (!base.data.name) base.data.name = tmpl.name || 'New Level';
        if (!Array.isArray(base.data.obstacles)) base.data.obstacles = [];
        if (!base.data.ballStart) base.data.ballStart = { x: 100, y: GY - 30 };
        if (!base.data.hole) base.data.hole = { x: 700, y: GY };
      }
      return base;
    };

    const showTemplateMenu = (btn) => {
      const rect = btn.getBoundingClientRect();
      const items = [
        { label: '+ Blank level', run: () => {
            pushHistory(true);
            state.levels.push(newLevel());
            state.currentIdx = state.levels.length - 1;
            saveSettings(); render();
          }
        },
        { sep: true },
        ...LEVEL_TEMPLATES.map(tmpl => ({
          label: tmpl.name || 'Template',
          run: () => {
            pushHistory(true);
            state.levels.push(newLevelFromTemplate(tmpl));
            state.currentIdx = state.levels.length - 1;
            saveSettings(); render();
            toast('Created from template: ' + (tmpl.name || ''));
          }
        }))
      ];
      showContextMenu(rect.left, rect.bottom + 4, items);
    };

    // ---------- Topbar wiring ----------
    $('btn-new-level').addEventListener('click', (e) => {
      if (LEVEL_TEMPLATES.length > 0) {
        e.stopPropagation();
        showTemplateMenu(e.currentTarget);
        return;
      }
      pushHistory(true);
      state.levels.push(newLevel());
      state.currentIdx = state.levels.length - 1;
      saveSettings();
      render();
    });
    $('btn-duplicate-level').addEventListener('click', () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const defaultName = (lvl.data.name || 'level') + ' Copy';
      const newName = prompt('New level name:', defaultName);
      if (newName === null) return; // cancelled
      pushHistory(true);
      const copy = cloneDeep(lvl);
      copy.data.name = newName || defaultName;
      copy.slot = null;
      state.levels.push(copy);
      state.currentIdx = state.levels.length - 1;
      saveSettings();
      render();
    });
    $('btn-delete-level').addEventListener('click', () => {
      if (state.currentIdx < 0) return;
      if (!confirm('Delete this level?')) return;
      pushHistory(true);
      state.levels.splice(state.currentIdx, 1);
      state.currentIdx = Math.max(0, Math.min(state.currentIdx, state.levels.length - 1));
      saveSettings();
      render();
    });
    $('btn-undo')?.addEventListener('click', undo);
    $('btn-redo')?.addEventListener('click', redo);
    $('btn-save').addEventListener('click', save);
    $('btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.levels, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'levels.json'; a.click();
      URL.revokeObjectURL(url);
    });
    $('btn-import').addEventListener('click', () => $('file-import').click());
    // Feature 5: Restore backup button — inject programmatically near btn-import
    (() => {
      const importBtn = $('btn-import');
      if (!importBtn) return;
      const btn = document.createElement('button');
      btn.id = 'btn-restore-backup';
      btn.className = 'btn';
      btn.title = 'Restore session backup (data from before last page load)';
      btn.textContent = 'Restore Backup';
      btn.addEventListener('click', restoreBackup);
      importBtn.parentElement.insertBefore(btn, importBtn.nextSibling);
    })();
    $('btn-import-merge')?.addEventListener('click', () => $('file-import-merge')?.click());
    const _importLevels = (arr, mergeMode = false) => {
      if (!Array.isArray(arr)) throw new Error('not an array');
      const valid = arr.filter(item => {
        try {
          return Array.isArray(item.data?.obstacles) &&
            typeof item.data?.name === 'string' &&
            typeof item.data?.ballStart?.x === 'number' &&
            typeof item.data?.ballStart?.y === 'number' &&
            typeof item.data?.hole?.x === 'number' &&
            typeof item.data?.hole?.y === 'number';
        } catch (_) { return false; }
      });
      const skipped = arr.length - valid.length;
      // Clamp obstacle coordinates to reasonable bounds
      valid.forEach(item => {
        const worldW = item.data.worldW || 800;
        (item.data.obstacles || []).forEach(o => {
          const clampX = (v) => Math.max(-100, Math.min(worldW + 100, v));
          const clampY = (v) => Math.max(-100, Math.min(CANVAS_H + 100, v));
          if ('x' in o) o.x = clampX(o.x);
          if ('x1' in o) { o.x1 = clampX(o.x1); o.x2 = clampX(o.x2); }
          if ('y' in o) o.y = clampY(o.y);
        });
      });
      pushHistory(true, mergeMode ? 'Import merge' : 'Import');
      if (mergeMode) {
        state.levels = state.levels.concat(valid);
        state.currentIdx = state.levels.length - valid.length;
      } else {
        state.levels = valid;
        state.currentIdx = 0;
      }
      render();
      toast(`Imported ${valid.length} levels${skipped ? ` (${skipped} skipped as invalid)` : ''}${mergeMode ? ' (merged)' : ''}`);
    };
    $('file-import').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const txt = await f.text();
        _importLevels(JSON.parse(txt));
      } catch (err) { toast('Import failed: ' + err.message); }
      e.target.value = '';
    });
    const _fileImportMergeEl = $('file-import-merge');
    if (_fileImportMergeEl) {
      _fileImportMergeEl.addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const txt = await f.text();
          _importLevels(JSON.parse(txt), true);
        } catch (err) { toast('Merge import failed: ' + err.message); }
        e.target.value = '';
      });
    }
    // Drag-and-drop JSON import
    document.body.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    document.body.addEventListener('drop', async (e) => {
      const f = Array.from(e.dataTransfer?.files || []).find(f => f.name.endsWith('.json'));
      if (!f) return;
      e.preventDefault();
      try {
        const txt = await f.text();
        _importLevels(JSON.parse(txt));
      } catch (err) { toast('Drop import failed: ' + err.message); }
    });
    $('btn-load-game').addEventListener('click', loadFromGame);
    $('btn-sync-toggle').addEventListener('click', toggleSync);
    $('btn-play-current').addEventListener('click', () => playInGame());
    $('btn-play-canvas')?.addEventListener('click', () => playInGame());
    $('btn-reset-canvas')?.addEventListener('click', () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      const course = lvl.courtId != null ? COURSES[lvl.courtId] : null;
      if (!course?.defaultLevel) { toast('No default scene for this course'); return; }
      if (!confirm('Reset scene to default? Current obstacles will be lost.')) return;
      pushHistory(true);
      const def = cloneDeep(course.defaultLevel);
      // Reset should keep the scene empty (no obstacles), even if the course
      // template includes example obstacles.
      if (def && typeof def === 'object') delete def.obstacles;
      Object.assign(lvl.data, def, { obstacles: [] });
      // Reset is expected to be a "clean slate" visually.
      state.showRuler = false;
      const or = $('opt-ruler'); if (or) or.checked = state.showRuler;
      saveSettings();
      save(); render(); toast('Scene reset to default');
    });
    document.getElementById('canvas-wrap')?.addEventListener('scroll', () => { renderMinimap(); });
    $('btn-sync-publish').addEventListener('click', () => publishSync({ announce: true }));
    $('btn-sync-clear').addEventListener('click', () => {
      if (!confirm('Clear sync? The game will revert to baked levels.')) return;
      clearSync();
    });
    $('filter-court').addEventListener('change', () => {
      renderLevelList(); renderSlotGrid(); renderPalette(); saveSettings();
      const sel = $('filter-court').value;
      if (sel && sel !== 'all' && sel !== 'null') {
        const courseId = parseInt(sel, 10);
        // Find first level (smallest slot) for this course
        let firstIdx = -1, minSlot = Infinity;
        state.levels.forEach((l, i) => {
          if (l.courtId === courseId) {
            const s = l.slot ?? Infinity;
            if (s < minSlot) { minSlot = s; firstIdx = i; }
          }
        });
        if (firstIdx >= 0) {
          selectLevel(firstIdx);
        } else {
          // No levels — create from defaultLevel template if available
          const course = COURSES[courseId];
          if (course && course.defaultLevel) {
            const def = cloneDeep(course.defaultLevel);
            const lvl = {
              courtId: courseId,
              slot: null,
              data: Object.assign({
                name: course.name + ' — Starter',
                subtitle: '',
                worldW: 800,
                time: 0.3,
                ballStart: { x: 100, y: GY - 30 },
                hole: { x: 700, y: GY },
                maxShots: 4,
                starShots: [2, 3, 4],
                obstacles: []
              }, def)
            };
            state.levels.push(lvl);
            save();
            renderLevelList();
            selectLevel(state.levels.length - 1);
            toast('Default scene created for ' + course.name);
          }
        }
      }
    });
    $('level-search')?.addEventListener('input', () => renderLevelList());
    // Course-specific export
    $('btn-export-course')?.addEventListener('click', () => {
      const filter = $('filter-court')?.value || 'all';
      if (filter === 'all' || filter === 'null') {
        const blob = new Blob([JSON.stringify(state.levels, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = 'levels.json'; a.click(); URL.revokeObjectURL(url);
        return;
      }
      const courseId = parseInt(filter, 10);
      const filtered = state.levels.filter(l => l.courtId === courseId);
      const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `levels-course-${courseId}.json`; a.click(); URL.revokeObjectURL(url);
      toast(`Exported ${filtered.length} levels for course ${courseId}`);
    });
    // Fullscreen toggle
    $('btn-fullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
        const b = $('btn-fullscreen'); if (b) b.textContent = 'Exit';
      } else {
        document.exitFullscreen?.();
        const b = $('btn-fullscreen'); if (b) b.textContent = 'Full';
      }
    });
    // Level sort cycle
    $('btn-sort-levels')?.addEventListener('click', () => {
      const modes = ['none', 'name', 'course', 'slot'];
      const next = modes[(modes.indexOf(state.sortMode) + 1) % modes.length];
      state.sortMode = next;
      const b = $('btn-sort-levels'); if (b) b.textContent = 'Sort: ' + next;
      renderLevelList();
    });
    $('opt-grid').addEventListener('change', (e) => { state.showGrid = e.target.checked; saveSettings(); render(); });
    $('opt-ruler')?.addEventListener('change', (e) => { state.showRuler = e.target.checked; saveSettings(); render(); });
    $('opt-snap').addEventListener('change', (e) => { state.snap = e.target.checked; saveSettings(); });
    $('opt-snap-obstacles')?.addEventListener('change', (e) => { state.snapToObstacles = e.target.checked; saveSettings(); });
    $('opt-overlaps')?.addEventListener('change', (e) => { state.showOverlaps = e.target.checked; render(); });
    $('btn-show-diff')?.addEventListener('click', () => showLevelDiff());
    $('btn-zoom-in').addEventListener('click', () => { state.zoom = Math.min(2, state.zoom * 1.2); resizeCanvas(); render(); saveSettings(); });
    $('btn-zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.2, state.zoom / 1.2); resizeCanvas(); render(); saveSettings(); });
    $('btn-zoom-fit').addEventListener('click', () => { fitCanvas(); render(); saveSettings(); });
    document.querySelectorAll('.tool-btn').forEach(b => {
      b.addEventListener('click', () => {
        state.tool = b.dataset.tool;
        document.querySelectorAll('.asset-btn, .tool-btn').forEach(el => {
          el.classList.remove('active');
          if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('active');
        if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'true');
        canvas.style.cursor = state.tool === 'eraser' ? 'crosshair' : (state.tool === 'select' ? '' : 'cell');
      });
    });

    // ---------- Feature 2: Zoom label click: show zoom preset menu ----------
    $('zoom-label')?.addEventListener('click', (e) => {
      const presets = [50, 75, 100, 150, 200];
      const items = presets.map(pct => ({
        label: (Math.round(state.zoom * 100) === pct ? '✓ ' : '  ') + pct + '%',
        run: () => { state.zoom = pct / 100; resizeCanvas(); render(); saveSettings(); toast('Zoom ' + pct + '%'); }
      }));
      items.push({ sep: true });
      items.push({ label: 'Fit to window', run: () => { fitCanvas(); render(); saveSettings(); toast('Fit to window'); } });
      showContextMenu(e.clientX, e.clientY, items);
    });

    // ---------- Delete-all-unassigned button ----------
    $('btn-delete-all-unassigned')?.addEventListener('click', () => {
      const unassigned = state.levels.filter(l => l.courtId == null || l.slot == null);
      const n = unassigned.length;
      if (!n) { toast('No unassigned levels'); return; }
      if (!confirm(`Delete ${n} unassigned level${n === 1 ? '' : 's'}?`)) return;
      pushHistory(true, 'Delete unassigned');
      state.levels = state.levels.filter(l => l.courtId != null && l.slot != null);
      state.currentIdx = Math.max(0, Math.min(state.currentIdx, state.levels.length - 1));
      render();
      toast(`Deleted ${n} level${n === 1 ? '' : 's'}`);
    });

    // ---------- Share level as URL ----------
    $('btn-share-level')?.addEventListener('click', () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) { toast('No level selected'); return; }
      try {
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(lvl))));
        const url = location.origin + location.pathname + '?level=' + encoded;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(() => toast('Level URL copied to clipboard!'));
        } else {
          prompt('Copy this URL:', url);
        }
      } catch (e) { toast('Share failed: ' + e.message); }
    });

    // ---------- Configurable grid size ----------
    $('btn-grid-size')?.addEventListener('click', () => {
      const cur = state.gridSize;
      const val = prompt('Grid size (5–100):', String(cur));
      if (val == null) return;
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 5 || n > 100) { toast('Invalid grid size — enter 5 to 100'); return; }
      state.gridSize = n;
      saveSettings();
      toast('Grid size set to ' + n);
    });

    // ---------- Navigation: pan, jump, minimap ----------
    const scrollTo = (worldX, worldY = GY) => {
      const w = wrapEl(); if (!w) return;
      const targetX = (worldX + LEFT_PAD) * state.zoom - w.clientWidth / 2;
      const targetY = worldY * state.zoom - w.clientHeight / 2;
      w.scrollTo({ left: Math.max(0, targetX), top: Math.max(0, targetY), behavior: 'smooth' });
    };
    const scrollToSelection = () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      if (state.selectedKind === 'ball') scrollTo(lvl.data.ballStart.x, lvl.data.ballStart.y);
      else if (state.selectedKind === 'hole') scrollTo(lvl.data.hole.x, lvl.data.hole.y);
      else if (state.selectedKind === 'obs' && state.selectedObs >= 0) {
        const o = lvl.data.obstacles[state.selectedObs];
        scrollTo(o.x ?? (o.x1 + (o.x2 - o.x1) / 2), o.y ?? GY);
      }
    };

    // Space+drag pan
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.target.matches('input, textarea, select')) {
        panState.spaceDown = true;
        canvas.style.cursor = 'grab';
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { panState.spaceDown = false; canvas.style.cursor = ''; }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!panState.spaceDown) return;
      panState.dragging = true;
      panState.startX = e.clientX; panState.startY = e.clientY;
      const w = wrapEl();
      panState.scrollL = w.scrollLeft; panState.scrollT = w.scrollTop;
      canvas.style.cursor = 'grabbing';
      e.stopPropagation();
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!panState.dragging) return;
      const w = wrapEl();
      w.scrollLeft = panState.scrollL - (e.clientX - panState.startX);
      w.scrollTop  = panState.scrollT - (e.clientY - panState.startY);
    });
    window.addEventListener('mouseup', () => {
      if (panState.dragging) {
        panState.dragging = false;
        canvas.style.cursor = panState.spaceDown ? 'grab' : '';
      }
    });

    // ---------- Scroll wheel zoom ----------
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      state.zoom = Math.min(2, Math.max(0.2, state.zoom * factor));
      resizeCanvas(); render(); saveSettings();
    }, { passive: false });

    // ---------- Touch support ----------
    const synthMouse = (type, touch) => {
      const me = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: touch.clientX, clientY: touch.clientY, button: 0 });
      return me;
    };
    canvas.addEventListener('touchstart', (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      canvas.dispatchEvent(synthMouse('mousedown', e.touches[0]));
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      canvas.dispatchEvent(synthMouse('mousemove', e.touches[0]));
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      if (e.target !== canvas) return;
      const t = e.changedTouches[0];
      canvas.dispatchEvent(synthMouse('mouseup', t));
    });

    // ---------- Minimap ----------
    const renderMinimap = () => {
      const mm = $('minimap'); if (!mm) return;
      const mmWrap = mm.parentElement;
      const lvl = state.levels[state.currentIdx];
      const mmCtx = mm.getContext('2d');
      if (!lvl) { if (mmWrap) mmWrap.style.display = 'none'; return; }
      const L = lvl.data;
      const worldW = L.worldW + LEFT_PAD * 2;
      const canvasWrap = document.getElementById('canvas-wrap');
      const visibleW = canvasWrap ? canvasWrap.clientWidth : 1200;
      const neededW = worldW * state.zoom;
      if (neededW <= visibleW + 4) {
        if (mmWrap) mmWrap.style.display = 'none';
        return;
      }
      if (mmWrap) mmWrap.style.display = '';
      const overflow = neededW / visibleW;
      const widthPct = Math.min(100, 40 + (overflow - 1) * 60);
      mm.style.width = widthPct + '%';
      const targetPx = Math.max(200, Math.round((mm.parentElement?.clientWidth || 1200) * widthPct / 100));
      if (mm.width !== targetPx) mm.width = targetPx;
      const W = mm.width, H = mm.height;
      mmCtx.clearRect(0, 0, W, H);
      const sx = W / worldW;
      const sy = H / CANVAS_H;
      const course = currentCourse();
      const theme = course ? course.theme : { sky1: '#c9e3ef', sky2: '#eaf4da', ground: '#9cc26d' };
      mmCtx.fillStyle = theme.sky1 || '#c9e3ef';
      mmCtx.fillRect(0, 0, W, GY * sy);
      if (theme.ground) {
        mmCtx.fillStyle = theme.ground;
        mmCtx.fillRect(0, GY * sy, W, (CANVAS_H - GY) * sy);
      }
      L.obstacles.forEach(o => {
        const col = TYPE_COLORS[o.type] || '#888';
        mmCtx.fillStyle = col;
        if ('x1' in o) {
          mmCtx.fillRect((o.x1 + LEFT_PAD) * sx, 0, (o.x2 - o.x1) * sx, H);
        } else if (o._bbox) {
          mmCtx.fillRect(o._bbox[0] * sx, o._bbox[1] * sy, o._bbox[2] * sx, o._bbox[3] * sy);
        } else {
          const xw = 10 * sx, yw = 10 * sy;
          const cx = (o.x + LEFT_PAD) * sx;
          const cy = (o.y ?? GY) * sy;
          mmCtx.fillRect(cx - xw / 2, cy - yw / 2, xw, yw);
        }
      });
      // Feature 1: Ball position — white dot
      const ballMX = (L.ballStart.x + LEFT_PAD) * sx;
      const ballMY = L.ballStart.y * sy;
      mmCtx.save();
      mmCtx.fillStyle = '#ffffff';
      mmCtx.strokeStyle = 'rgba(0,0,0,0.5)';
      mmCtx.lineWidth = 1;
      mmCtx.beginPath();
      mmCtx.arc(ballMX, ballMY, 3, 0, Math.PI * 2);
      mmCtx.fill(); mmCtx.stroke();
      mmCtx.restore();

      // Feature 1: Hole position — red dot
      const holeMX = (L.hole.x + LEFT_PAD) * sx;
      const holeMY = L.hole.y * sy;
      mmCtx.save();
      mmCtx.fillStyle = '#d83d3d';
      mmCtx.strokeStyle = 'rgba(0,0,0,0.5)';
      mmCtx.lineWidth = 1;
      mmCtx.beginPath();
      mmCtx.arc(holeMX, holeMY, 3, 0, Math.PI * 2);
      mmCtx.fill(); mmCtx.stroke();
      mmCtx.restore();

      // Feature 1: Viewport indicator — yellow rect
      const w = wrapEl();
      if (w) {
        const vx = (w.scrollLeft / state.zoom) * sx;
        const vy = (w.scrollTop / state.zoom) * sy;
        const vw = (w.clientWidth / state.zoom) * sx;
        const vh = (w.clientHeight / state.zoom) * sy;
        mmCtx.save();
        mmCtx.strokeStyle = '#f1c40f';
        mmCtx.lineWidth = 1.5;
        mmCtx.setLineDash([3, 2]);
        mmCtx.strokeRect(vx, vy, Math.min(vw, W - vx), Math.min(vh, H - vy));
        mmCtx.setLineDash([]);
        mmCtx.restore();
      }
    };

    const mmEl = $('minimap');
    if (mmEl) {
      let mmDragging = false;
      const mmClick = (e) => {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const rect = mmEl.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const worldW = lvl.data.worldW + LEFT_PAD * 2;
        scrollTo(px * worldW - LEFT_PAD, py * CANVAS_H);
      };
      mmEl.addEventListener('mousedown', (e) => { mmDragging = true; mmClick(e); });
      mmEl.addEventListener('mousemove', (e) => { if (mmDragging) mmClick(e); });
      window.addEventListener('mouseup', () => { mmDragging = false; });
      mmEl.addEventListener('dblclick', () => { fitCanvas(); render(); });
    }

    // ---------- Status strip + scoring HUD ----------
    const renderStatusStrip = () => {
      const lvl = state.levels[state.currentIdx];
      const nameEl = $('status-level');
      if (nameEl) {
        if (!lvl) nameEl.textContent = 'No level';
        else {
          const name = lvl.data.name || '(unnamed)';
          const slotLbl = lvl.courtId && lvl.slot ? ` C${lvl.courtId} S${lvl.slot}` : '';
          let obsLbl = '';
          if (state.selectedKind === 'obs') {
            if (state.selectedObsList.length > 1) {
              obsLbl = ` | ${state.selectedObsList.length} selected`;
            } else if (state.selectedObs >= 0) {
              obsLbl = ` | obs #${state.selectedObs + 1}/${lvl.data.obstacles.length}`;
            }
          }
          nameEl.textContent = `Editing: ${name}${slotLbl}${obsLbl}`;
        }
      }
      let issues = [];
      if (config.validateLevel && lvl) {
        const course = lvl.courtId != null ? COURSES[lvl.courtId] : null;
        issues = config.validateLevel(lvl, course) || [];
      }
      const errs = issues.filter(i => i.level === 'error').length;
      const warns = issues.filter(i => i.level === 'warn').length;
      const iWrap = $('status-issues');
      const iText = $('status-issues-text');
      if (iWrap && iText) {
        if (errs + warns === 0) iWrap.style.display = 'none';
        else {
          iWrap.style.display = '';
          iText.textContent = errs
            ? `${errs} error${errs === 1 ? '' : 's'}${warns ? ` · ${warns} warn` : ''}`
            : `${warns} warning${warns === 1 ? '' : 's'}`;
          iWrap.classList.toggle('is-error', errs > 0);
        }
      }
      const gWrap = $('status-game');
      if (gWrap) gWrap.style.display = (state._gameWin && !state._gameWin.closed) ? '' : 'none';
    };

    const bindScoringHudOnce = () => {
      const el = $('scoring-hud'); if (!el) return;
      el.addEventListener('click', () => {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const L = lvl.data;
        const ss = (L.starShots || []).join('/');
        const cur = `${L.maxShots}|${ss}`;
        const input = prompt('Edit scoring as "maxShots|star1,star2,star3" (e.g. 4|1,2,3):', cur);
        if (input == null) return;
        pushHistory(true);
        const parts = input.split('|');
        const stars = (parts[1] || parts[0]).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (parts[1] !== undefined) L.maxShots = parseInt(parts[0]) || L.maxShots;
        if (stars.length) L.starShots = stars;
        render();
      });
    };

    const renderScoringHud = () => {
      const el = $('scoring-hud');
      const lvl = state.levels[state.currentIdx];
      if (!el) return;
      if (!lvl) { el.textContent = ''; return; }
      const L = lvl.data;
      const ss = (L.starShots || []).join('/');
      el.innerHTML = `Max: <strong>${L.maxShots ?? '—'}</strong> · * <strong>${ss || '—'}</strong>`;
    };

    // ---------- Main render ----------
    const render = () => {
      emit('obstacleSelect', { obs: state.selectedObs, kind: state.selectedKind });
      resizeCanvas();
      renderCanvas();
      // Rebuild spatial index now that obstacle _bbox values are fresh from drawObstacle
      rebuildSpatialIndex();
      renderLevelList();
      renderSlotGrid();
      renderValidation();
      renderPalette();
      renderPrefabs();
      bindConfig();
      renderProps();
      renderMinimap();
      renderScoringHud();
      renderStatusStrip();
      const { courses, warnings } = buildSyncPayload();
      state.sync.courses = courses;
      renderSyncStatus(warnings);
    };

    // ---------- Collapsible panels ----------
    const initResizeHandles = () => {
      const root = document.documentElement;
      try {
        const raw = localStorage.getItem('canvas_editor_sidebar_w');
        if (raw) {
          const s = JSON.parse(raw);
          if (s.left  && s.left  > 160 && s.left  < 500) root.style.setProperty('--sidebar-left-w',  s.left  + 'px');
          if (s.right && s.right > 160 && s.right < 500) root.style.setProperty('--sidebar-right-w', s.right + 'px');
        }
      } catch (_) {}
      const persist = () => {
        const left  = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-left-w')) || 260;
        const right = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-right-w')) || 280;
        try { localStorage.setItem('canvas_editor_sidebar_w', JSON.stringify({ left, right })); } catch (_) {}
      };
      const addHandle = (parent, side) => {
        const h = document.createElement('div');
        h.className = 'resize-handle rh-' + side;
        parent.appendChild(h);
        const pointerX = (ev) => ev.touches ? ev.touches[0].clientX : ev.clientX;
        const begin = (e) => {
          e.preventDefault();
          h.classList.add('is-dragging');
          const startX = pointerX(e);
          const rect = parent.getBoundingClientRect();
          const startW = rect.width;
          const onMove = (ev) => {
            const delta = pointerX(ev) - startX;
            let w = side === 'left' ? startW + delta : startW - delta;
            w = Math.max(180, Math.min(480, w));
            root.style.setProperty(side === 'left' ? '--sidebar-left-w' : '--sidebar-right-w', w + 'px');
            if (ev.touches) ev.preventDefault();
          };
          const onUp = () => {
            h.classList.remove('is-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            persist();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend', onUp);
        };
        h.addEventListener('mousedown', begin);
        h.addEventListener('touchstart', begin, { passive: false });
      };
      const L = document.getElementById('left-panel');
      const R = document.getElementById('right-panel');
      if (L) addHandle(L, 'left');
      if (R) addHandle(R, 'right');
    };

    const initCollapsiblePanels = () => {
      const raw = localStorage.getItem('canvas_editor_panel_collapsed') || '{}';
      let collapsed = {};
      try { collapsed = JSON.parse(raw) || {}; } catch (_) { collapsed = {}; }
      document.querySelectorAll('.panel > h3').forEach(h => {
        const panel = h.parentElement;
        const key = panel.id || h.textContent.trim();
        if (!panel.querySelector('.panel-body')) {
          const body = document.createElement('div');
          body.className = 'panel-body';
          while (h.nextSibling) body.appendChild(h.nextSibling);
          panel.appendChild(body);
        }
        if (collapsed[key]) panel.classList.add('is-collapsed');
        h.classList.add('panel-toggle');
        h.setAttribute('role', 'button');
        h.setAttribute('tabindex', '0');
        h.setAttribute('aria-expanded', !collapsed[key]);
        const toggle = () => {
          panel.classList.toggle('is-collapsed');
          const isCol = panel.classList.contains('is-collapsed');
          h.setAttribute('aria-expanded', !isCol);
          collapsed[key] = isCol;
          try { localStorage.setItem('canvas_editor_panel_collapsed', JSON.stringify(collapsed)); } catch (_) {}
        };
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });
    };

    // ---------- Settings persistence ----------
    const saveSettings = () => {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          showGrid: state.showGrid,
          showRuler: state.showRuler,
          snap: state.snap,
          snapToObstacles: state.snapToObstacles,
          zoom: state.zoom,
          filter: $('filter-court')?.value || 'all',
          recentTypes: state.recentTypes,
          currentIdx: state.currentIdx,
          gridSize: state.gridSize
        }));
      } catch (_) {}
    };
    const loadSettings = () => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (typeof s.showGrid === 'boolean') state.showGrid = s.showGrid;
        if (typeof s.showRuler === 'boolean') state.showRuler = s.showRuler;
        if (typeof s.snap === 'boolean') state.snap = s.snap;
        if (typeof s.snapToObstacles === 'boolean') {
          state.snapToObstacles = s.snapToObstacles;
          const soEl = $('opt-snap-obstacles');
          if (soEl) soEl.checked = state.snapToObstacles;
        }
        if (typeof s.zoom === 'number') state.zoom = s.zoom;
        if (Array.isArray(s.recentTypes)) state.recentTypes = s.recentTypes.filter(t => SCHEMA[t]);
        if (typeof s.currentIdx === 'number' && s.currentIdx >= 0) state.currentIdx = s.currentIdx;
        if (typeof s.gridSize === 'number' && s.gridSize >= 5 && s.gridSize <= 100) state.gridSize = s.gridSize;
        if ($('opt-grid')) $('opt-grid').checked = state.showGrid;
        if ($('opt-snap')) $('opt-snap').checked = state.snap;
        if ($('opt-ruler')) $('opt-ruler').checked = state.showRuler;
        if (s.filter && $('filter-court')) $('filter-court').value = s.filter;
      } catch (_) {}
    };

    // ---------- Init ----------
    load();
    loadPublishHistory();
    renderPublishHistory();
    loadPrefabs();
    loadSettings();
    initCollapsiblePanels();
    bindScoringHudOnce();
    initResizeHandles();
    $('btn-save-prefab')?.addEventListener('click', saveCurrentAsPrefab);
    $('btn-help')?.addEventListener('click', () => { const h = $('help-overlay'); if (h) h.style.display = ''; });
    $('help-close')?.addEventListener('click', () => { const h = $('help-overlay'); if (h) h.style.display = 'none'; });
    $('help-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'help-overlay') { const h = $('help-overlay'); if (h) h.style.display = 'none'; }
    });
    renderPalette();
    wireConfig();

    // ---------- Feature 2 (Run 2): Find & Replace obstacle positions ----------
    const wireFindReplace = () => {
      const applyBtn = $('fr-apply');
      if (!applyBtn) return;
      applyBtn.addEventListener('click', () => {
        const lvl = state.levels[state.currentIdx]; if (!lvl) { toast('No level open'); return; }
        const typeVal = $('fr-type')?.value || '';
        const shiftX  = parseFloat($('fr-shift-x')?.value) || 0;
        const shiftY  = parseFloat($('fr-shift-y')?.value) || 0;
        const scaleX  = parseFloat($('fr-scale-x')?.value) || 1;
        if (!typeVal) { toast('Select an obstacle type'); return; }
        const targets = lvl.data.obstacles.filter(o => o.type === typeVal);
        if (!targets.length) { toast(`No obstacles of type "${typeVal}"`, 2000); return; }
        pushHistory(true, 'shift ' + typeVal);
        targets.forEach(o => {
          if ('x1' in o) {
            o.x1 = Math.round(o.x1 * scaleX + shiftX);
            o.x2 = Math.round(o.x2 * scaleX + shiftX);
          } else if ('x' in o) {
            o.x = Math.round(o.x * scaleX + shiftX);
          }
          if ('y' in o) o.y = Math.round(o.y + shiftY);
        });
        render();
        toast(`Shifted ${targets.length} "${typeVal}" obstacle${targets.length === 1 ? '' : 's'}`);
      });
    };
    wireFindReplace();

    // Populate help shortcut list
    const SHORTCUTS = [
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+C', 'Copy'],
      ['Ctrl+V', 'Paste'], ['Ctrl+Shift+V', 'Paste at center'],
      ['Ctrl+X', 'Cut'], ['Ctrl+D', 'Duplicate in place'], ['Ctrl+Shift+D', 'Show level diff'],
      ['Ctrl+A', 'Select all obstacles'], ['Escape', 'Deselect all'],
      ['Ctrl+N', 'New level'], ['Ctrl+S', 'Save'],
      ['Delete/Backspace', 'Delete selected'],
      ['Arrow keys', 'Nudge (grid size)'], ['Shift+Arrow', 'Nudge (1px)'],
      ['Alt+↑/↓', 'Reorder level'],
      ['Tab/Shift+Tab', 'Cycle obstacles'],
      ['Space+drag', 'Pan canvas'],
      ['1', 'Select tool'], ['2', 'Eraser'], ['3', 'Ball tool'],
      ['4', 'Hole tool'],
      ['G', 'Toggle grid'], ['R', 'Toggle ruler'],
      ['H', 'Toggle hide selected type'], ['L', 'Lock/unlock selected'],
      ['[/]', 'Grid size -/+5'],
      ['Ctrl+G', 'Group selected'], ['Ctrl+Shift+G', 'Ungroup selected'],
      ['Ctrl+=/-', 'Zoom in/out'], ['Ctrl+0', 'Reset zoom to 100%'],
      ['F', 'Fit zoom to canvas'],
      ['Ctrl+Home/End', 'First/last level'],
      ['P', 'Play level'],
      ['Z', 'Zen mode'], ['?', 'Help'],
      ['Home', 'Scroll to ball'], ['End', 'Scroll to hole'],
    ];
    const helpEl = $('help-shortcuts');
    const helpBox = $('help-box');
    if (helpEl) {
      helpEl.innerHTML = SHORTCUTS.map(([k, v]) =>
        `<li><kbd>${k}</kbd> <span>${v}</span></li>`
      ).join('');
    }
    // Feature 5: Search + copy shortcuts in help overlay
    if (helpBox && helpEl) {
      // Search input
      const searchWrap = document.createElement('div');
      searchWrap.style.cssText = 'margin:6px 0 8px;display:flex;gap:6px;align-items:center;';
      const searchInp = document.createElement('input');
      searchInp.type = 'search';
      searchInp.placeholder = 'Search shortcuts…';
      searchInp.id = 'help-search';
      searchInp.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:inherit;';
      searchInp.addEventListener('input', () => {
        const q = searchInp.value.toLowerCase();
        helpEl.querySelectorAll('li').forEach(li => {
          li.style.display = (!q || li.textContent.toLowerCase().includes(q)) ? '' : 'none';
        });
      });
      // Copy all button
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy all';
      copyBtn.className = 'btn btn-mini';
      copyBtn.style.cssText = 'font-size:11px;';
      copyBtn.addEventListener('click', () => {
        const text = SHORTCUTS.map(([k, v]) => `${k}: ${v}`).join('\n');
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(() => toast('Shortcuts copied!'));
        } else {
          prompt('Copy shortcuts:', text);
        }
      });
      searchWrap.appendChild(searchInp);
      searchWrap.appendChild(copyBtn);
      // Insert before the list
      helpBox.insertBefore(searchWrap, helpEl);
    }

    // URL params: ?level=<base64-json> headless mode, ?zen=1
    const __autoParams = new URLSearchParams(location.search);
    const __levelParam = __autoParams.get('level');
    if (__levelParam) {
      try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(__levelParam))));
        const data = decoded.data || decoded;
        const courtId = decoded.courtId != null ? decoded.courtId : null;
        state.levels = [{ courtId, slot: null, data: cloneDeep(data) }];
        state.currentIdx = 0;
        if (__autoParams.get('zen') === '1' || __autoParams.get('headless') === '1') {
          document.body.classList.add('is-zen', 'is-headless');
        }
        const f = $('filter-court');
        if (f) f.value = courtId != null ? String(courtId) : 'all';
      } catch (e) { console.warn('level param decode failed', e); }
    } else if (__autoParams.get('zen') === '1') {
      document.body.classList.add('is-zen');
    }

    // First-open: auto-import from game
    if (state.levels.length === 0) {
      loadFromGame().catch(() => {
        if (state.levels.length === 0) state.levels.push(newLevel());
        state.currentIdx = 0;
        render();
      });
    }
    if (state.currentIdx < 0 || state.currentIdx >= state.levels.length) {
      state.currentIdx = 0;
    }
    updateHistoryUI();

    // Editor deep-link back from game: ?editor_course=X&editor_slot=Y
    try {
      const _ec = __autoParams.get('editor_course');
      const _es = __autoParams.get('editor_slot');
      if (_ec && _es) {
        const ec = parseInt(_ec, 10);
        const es = parseInt(_es, 10);
        const found = state.levels.findIndex(l => l.courtId === ec && l.slot === es);
        if (found >= 0) state.currentIdx = found;
      }
    } catch (_) {}

    // First-visit welcome toast
    try {
      if (!localStorage.getItem('canvas_editor_welcomed')) {
        toast('Welcome! Press ? for keyboard shortcuts, Space+drag to pan.', 5000);
        localStorage.setItem('canvas_editor_welcomed', '1');
      }
    } catch (_) {}

    // ---------- Command Palette (Cmd+K / Ctrl+K) ----------
    const registerCommand = (cmd) => {
      if (!cmd || !cmd.label || typeof cmd.run !== 'function') return;
      state.commands.push({ category: cmd.category || 'Actions', label: cmd.label, hint: cmd.hint || '', run: cmd.run });
    };
    const _builtInCommands = () => {
      const cmds = [
        { category: 'Actions', label: 'New Level',           hint: 'Ctrl+N',       run: () => $('btn-new-level')?.click() },
        { category: 'Actions', label: 'Duplicate Level',                            run: () => $('btn-duplicate-level')?.click() },
        { category: 'Actions', label: 'Delete Level',                               run: () => $('btn-delete-level')?.click() },
        { category: 'Actions', label: 'Undo',                hint: 'Ctrl+Z',       run: () => $('btn-undo')?.click() },
        { category: 'Actions', label: 'Redo',                hint: 'Ctrl+Y',       run: () => $('btn-redo')?.click() },
        { category: 'Actions', label: 'Save',                hint: 'Ctrl+S',       run: () => $('btn-save')?.click() },
        { category: 'Actions', label: 'Export Levels (JSON)',                      run: () => $('btn-export')?.click() },
        { category: 'Actions', label: 'Import Levels (JSON)',                      run: () => $('btn-import')?.click() },
        { category: 'Actions', label: 'Export PNG Image',                          run: () => exportPNG() },
        { category: 'Actions', label: 'Share Link',                                run: () => shareLink() },
        { category: 'Actions', label: 'Zoom In',             hint: 'Ctrl++',       run: () => $('btn-zoom-in')?.click() },
        { category: 'Actions', label: 'Zoom Out',            hint: 'Ctrl+-',       run: () => $('btn-zoom-out')?.click() },
        { category: 'Actions', label: 'Zoom Fit',            hint: 'F',            run: () => $('btn-zoom-fit')?.click() },
        { category: 'Actions', label: 'Play Level',          hint: 'P',            run: () => playInGame() },
        { category: 'Actions', label: 'Show Help',           hint: '?',            run: () => { const h = $('help-overlay'); if (h) h.style.display = ''; } },
        { category: 'Actions', label: 'Toggle Grid',         hint: 'G',            run: () => { state.showGrid = !state.showGrid; const og = $('opt-grid'); if (og) og.checked = state.showGrid; saveSettings(); render(); } },
        { category: 'Actions', label: 'Toggle Ruler',                              run: () => { state.showRuler = !state.showRuler; const or = $('opt-ruler'); if (or) or.checked = state.showRuler; saveSettings(); render(); } },
        { category: 'Actions', label: 'Select All Obstacles', hint: 'Ctrl+A',      run: () => { const lvl = state.levels[state.currentIdx]; if (!lvl?.data.obstacles.length) return; state.selectedKind = 'obs'; state.selectedObsList = lvl.data.obstacles.map((_, i) => i); state.selectedObs = state.selectedObsList[state.selectedObsList.length - 1]; render(); } },
        { category: 'Actions', label: 'Align Left',          hint: 'Ctrl+Shift+L', run: () => alignSelected('left') },
        { category: 'Actions', label: 'Align Right',                               run: () => alignSelected('right') },
        { category: 'Actions', label: 'Align Top',                                 run: () => alignSelected('top') },
        { category: 'Actions', label: 'Align Bottom',                              run: () => alignSelected('bottom') },
        { category: 'Actions', label: 'Center Horizontally',                       run: () => alignSelected('centerH') },
        { category: 'Actions', label: 'Center Vertically',                         run: () => alignSelected('centerV') },
        { category: 'Actions', label: 'Distribute Horizontally',                   run: () => bulkDistribute() },
        { category: 'Actions', label: 'Mirror Selection (X)',  hint: 'Ctrl+Shift+M', run: () => mirrorSelected() },
        { category: 'Actions', label: 'Group Selection',       hint: 'Ctrl+G',       run: () => groupSelected() },
        { category: 'Actions', label: 'Ungroup Selection',     hint: 'Ctrl+Shift+G', run: () => ungroupSelected() },
        { category: 'Actions', label: 'Show Tutorial',                              run: () => startOnboarding(true) },
        { category: 'Actions', label: 'Toggle Validation Badges',                   run: () => { state.showValidationBadges = !state.showValidationBadges; render(); toast('Badges ' + (state.showValidationBadges ? 'on' : 'off')); } }
      ];
      // Prefabs
      const allPrefabs = [...BUILTIN_PREFABS, ...state.userPrefabs];
      allPrefabs.forEach(p => {
        cmds.push({ category: 'Prefabs', label: p.name, hint: p.desc || '', run: () => insertPrefab(p) });
      });
      // Courses — jump to course filter
      Object.keys(COURSES).forEach(cid => {
        const c = COURSES[cid];
        cmds.push({
          category: 'Courses',
          label: 'Jump to course: ' + (c.name || COURSE_NAMES[cid] || ('Course ' + cid)),
          run: () => {
            const f = $('filter-court');
            if (f) { f.value = String(cid); f.dispatchEvent(new Event('change')); }
          }
        });
      });
      // Levels — jump to level
      state.levels.forEach((lvl, idx) => {
        const name = lvl.data?.name || ('Level ' + (idx + 1));
        const slot = lvl.courtId && lvl.slot ? ` (C${lvl.courtId} S${lvl.slot})` : '';
        cmds.push({ category: 'Levels', label: 'Open: ' + name + slot, run: () => selectLevel(idx) });
      });
      return cmds;
    };
    let _cmdPaletteEl = null;
    let _cmdPaletteIndex = 0;
    let _cmdPaletteFiltered = [];
    const _renderCmdPaletteList = (q) => {
      if (!_cmdPaletteEl) return;
      const all = [..._builtInCommands(), ...state.commands];
      const ql = (q || '').toLowerCase().trim();
      _cmdPaletteFiltered = ql
        ? all.filter(c => (c.label + ' ' + c.category + ' ' + (c.hint || '')).toLowerCase().includes(ql))
        : all;
      const listEl = _cmdPaletteEl.querySelector('.cmd-palette-list');
      if (!listEl) return;
      // Group by category
      const groups = {};
      _cmdPaletteFiltered.forEach((c, i) => {
        (groups[c.category] = groups[c.category] || []).push({ c, i });
      });
      let html = '';
      const order = ['Actions', 'Prefabs', 'Courses', 'Levels'];
      const cats = [...order.filter(o => groups[o]), ...Object.keys(groups).filter(k => !order.includes(k))];
      cats.forEach(cat => {
        html += `<div class="cmd-palette-cat">${cat}</div>`;
        groups[cat].forEach(({ c, i }) => {
          const sel = i === _cmdPaletteIndex ? ' is-selected' : '';
          html += `<div class="cmd-palette-item${sel}" data-idx="${i}"><span class="cmd-palette-label">${c.label.replace(/</g, '&lt;')}</span>${c.hint ? `<span class="cmd-palette-hint">${c.hint}</span>` : ''}</div>`;
        });
      });
      if (!_cmdPaletteFiltered.length) html = '<div class="cmd-palette-empty">No matches</div>';
      listEl.innerHTML = html;
      const selEl = listEl.querySelector('.is-selected');
      if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    };
    const _runCmdPaletteSelected = () => {
      const cmd = _cmdPaletteFiltered[_cmdPaletteIndex];
      if (!cmd) return;
      closeCommandPalette();
      try { cmd.run(); } catch (e) { console.error('[cmd-palette]', e); }
    };
    const closeCommandPalette = () => {
      if (_cmdPaletteEl) { _cmdPaletteEl.remove(); _cmdPaletteEl = null; }
    };
    const openCommandPalette = () => {
      if (_cmdPaletteEl) return;
      _cmdPaletteIndex = 0;
      const overlay = document.createElement('div');
      overlay.id = 'cmd-palette-overlay';
      overlay.innerHTML =
        '<div class="cmd-palette">' +
          '<input class="cmd-palette-input" type="text" placeholder="Type a command, prefab, course, or level…" autocomplete="off">' +
          '<div class="cmd-palette-list"></div>' +
        '</div>';
      document.body.appendChild(overlay);
      _cmdPaletteEl = overlay;
      const inp = overlay.querySelector('.cmd-palette-input');
      const listEl = overlay.querySelector('.cmd-palette-list');
      _renderCmdPaletteList('');
      inp.focus();
      inp.addEventListener('input', () => { _cmdPaletteIndex = 0; _renderCmdPaletteList(inp.value); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); _cmdPaletteIndex = Math.min(_cmdPaletteFiltered.length - 1, _cmdPaletteIndex + 1); _renderCmdPaletteList(inp.value); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); _cmdPaletteIndex = Math.max(0, _cmdPaletteIndex - 1); _renderCmdPaletteList(inp.value); }
        else if (e.key === 'Enter') { e.preventDefault(); _runCmdPaletteSelected(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
      });
      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.cmd-palette-item');
        if (!item) return;
        _cmdPaletteIndex = parseInt(item.getAttribute('data-idx'), 10) || 0;
        _runCmdPaletteSelected();
      });
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeCommandPalette();
      });
    };
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (_cmdPaletteEl) closeCommandPalette(); else openCommandPalette();
      }
    });
    $('btn-cmd-palette')?.addEventListener('click', openCommandPalette);

    // ---------- PNG Image Export ----------
    const exportPNG = () => {
      const lvl = state.levels[state.currentIdx];
      if (!lvl) { toast('No level to export'); return; }
      const L = lvl.data;
      const W = L.worldW + LEFT_PAD * 2;
      const H = CANVAS_H;
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const offCtx = off.getContext('2d');
      // Save state to suppress UI overlays
      const _grid = state.showGrid, _ruler = state.showRuler, _ovl = state.showOverlaps;
      const _selKind = state.selectedKind, _selObs = state.selectedObs, _selList = state.selectedObsList.slice();
      const _drag = state.drag, _marquee = state.marquee, _smartG = state.smartGuideX, _snapG = state.snapGuideLines;
      const _zoom = state.zoom, _w = canvas.width, _h = canvas.height;
      try {
        state.showGrid = false; state.showRuler = false; state.showOverlaps = false;
        state.selectedKind = null; state.selectedObs = -1; state.selectedObsList = [];
        state.drag = null; state.marquee = null; state.smartGuideX = null; state.snapGuideLines = null;
        state.zoom = 1;
        canvas.width = W; canvas.height = H;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        renderCanvas();
        offCtx.drawImage(canvas, 0, 0);
      } finally {
        state.showGrid = _grid; state.showRuler = _ruler; state.showOverlaps = _ovl;
        state.selectedKind = _selKind; state.selectedObs = _selObs; state.selectedObsList = _selList;
        state.drag = _drag; state.marquee = _marquee; state.smartGuideX = _smartG; state.snapGuideLines = _snapG;
        state.zoom = _zoom; canvas.width = _w; canvas.height = _h;
        resizeCanvas(); renderCanvas();
      }
      off.toBlob((blob) => {
        if (!blob) { toast('PNG export failed'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url; a.download = `level-${state.currentIdx}-${ts}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('PNG exported');
      }, 'image/png');
    };
    $('btn-export-png')?.addEventListener('click', exportPNG);

    // ---------- Shareable URL ----------
    const shareLink = () => {
      const lvl = state.levels[state.currentIdx];
      if (!lvl) { toast('No level to share'); return; }
      try {
        const json = JSON.stringify({ courtId: lvl.courtId, slot: lvl.slot, data: lvl.data });
        // base64 encode (UTF-8 safe via TextEncoder)
        const bytes = new TextEncoder().encode(json);
        let bin = '';
        bytes.forEach(b => bin += String.fromCharCode(b));
        const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const url = `${location.origin}${location.pathname}#level=${b64}`;
        history.replaceState(null, '', '#level=' + b64);
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(
            () => toast('Share link copied to clipboard'),
            () => toast('Link set in URL — copy manually')
          );
        } else {
          toast('Link set in URL — copy manually');
        }
      } catch (e) {
        toast('Share failed: ' + e.message);
      }
    };
    $('btn-share-link')?.addEventListener('click', shareLink);

    // Decode #level=<base64> from hash on load
    (() => {
      try {
        const h = (location.hash || '').replace(/^#/, '');
        if (!h) return;
        const params = new URLSearchParams(h);
        const lvlB64 = params.get('level');
        if (!lvlB64) return;
        const b64 = lvlB64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
        const bin = atob(b64 + pad);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const json = new TextDecoder().decode(bytes);
        const decoded = JSON.parse(json);
        const data = decoded.data || decoded;
        const courtId = decoded.courtId != null ? decoded.courtId : null;
        if (!data || !Array.isArray(data.obstacles)) return;
        const proceed = (state.levels.length === 0) ||
          confirm('Import shared level from URL? This will be added to your level list.');
        if (!proceed) return;
        pushHistory(true, 'Import shared link');
        state.levels.push({ courtId, slot: null, data: cloneDeep(data) });
        state.currentIdx = state.levels.length - 1;
        toast('Imported level from link');
        render();
      } catch (e) { console.warn('[share-link] decode failed', e); }
    })();

    // ---------- Align/Distribute toolbar (renderProps hook via mutation observer) ----------
    const _alignToolbarHTML = () =>
      '<div class="align-toolbar" id="align-toolbar" style="display:flex;flex-wrap:wrap;gap:3px;margin:6px 0;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--panel-alt)">' +
        '<strong style="width:100%;font-size:11px;margin-bottom:2px">Align / Distribute / Group</strong>' +
        '<button class="btn btn-mini" data-align="left"   title="Align left (Ctrl+Shift+L)">⇤</button>' +
        '<button class="btn btn-mini" data-align="centerH" title="Center horizontally">↔</button>' +
        '<button class="btn btn-mini" data-align="right"  title="Align right">⇥</button>' +
        '<button class="btn btn-mini" data-align="top"    title="Align top">⇡</button>' +
        '<button class="btn btn-mini" data-align="centerV" title="Center vertically">↕</button>' +
        '<button class="btn btn-mini" data-align="bottom" title="Align bottom">⇣</button>' +
        '<button class="btn btn-mini" data-distribute="x"  title="Distribute horizontally">⇿</button>' +
        '<button class="btn btn-mini" data-mirror="x"      title="Mirror selection X (Ctrl+Shift+M)">⇋ Mirror</button>' +
        '<button class="btn btn-mini" data-group="group"   title="Group (Ctrl+G)">⊞ Group</button>' +
        '<button class="btn btn-mini" data-group="ungroup" title="Ungroup (Ctrl+Shift+G)">⊟ Ungroup</button>' +
      '</div>';
    const _injectAlignToolbar = () => {
      const body = $('props-body'); if (!body) return;
      if (state.selectedKind !== 'obs' || state.selectedObsList.length < 2) {
        body.querySelector('#align-toolbar')?.remove();
        return;
      }
      if (body.querySelector('#align-toolbar')) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = _alignToolbarHTML();
      body.insertBefore(wrap.firstChild, body.firstChild);
      body.querySelectorAll('#align-toolbar [data-align]').forEach(btn => {
        btn.addEventListener('click', () => alignSelected(btn.getAttribute('data-align')));
      });
      body.querySelectorAll('#align-toolbar [data-distribute]').forEach(btn => {
        btn.addEventListener('click', () => bulkDistribute());
      });
      body.querySelectorAll('#align-toolbar [data-mirror]').forEach(btn => {
        btn.addEventListener('click', () => mirrorSelected());
      });
      body.querySelectorAll('#align-toolbar [data-group]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.getAttribute('data-group') === 'group') groupSelected();
          else ungroupSelected();
        });
      });
    };
    // Observe props-body for re-render
    const _propsBody = $('props-body');
    if (_propsBody) {
      const mo = new MutationObserver(() => _injectAlignToolbar());
      mo.observe(_propsBody, { childList: true });
      _injectAlignToolbar();
    }
    // Keyboard shortcut: Ctrl+Shift+L = align left
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = e.target.matches('input, textarea, select');
      if (!inField && mod && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (state.selectedObsList.length >= 2) alignSelected('left');
      }
    });

    // ---------- Onboarding tour ----------
    const ONBOARDING_KEY = 'canvas_editor_onboarded';
    const ONBOARDING_STEPS = [
      { sel: '#editor-canvas',     title: 'Welcome',          msg: 'This is your level. Drag obstacles to position, scroll to pan, Cmd/Ctrl+wheel to zoom.' },
      { sel: '#asset-palette',     title: 'Add obstacles',    msg: 'Pick a type from the palette, then click on the canvas to place it.' },
      { sel: '#btn-cmd-palette',   title: 'Command palette',  msg: 'Cmd/Ctrl+K opens a fuzzy command palette — fastest way to do anything.' },
      { sel: '#panel-prefabs',     title: 'Prefabs',          msg: 'Save selections as prefabs and re-use them across levels with one click.' },
      { sel: '#btn-save',          title: 'Save your work',   msg: 'Cmd/Ctrl+S saves levels and (if Sync is on) pushes them to the running game.' }
    ];
    let _onboardEl = null;
    let _onboardStep = 0;
    const _renderOnboardStep = () => {
      if (!_onboardEl) return;
      const step = ONBOARDING_STEPS[_onboardStep];
      const target = step ? document.querySelector(step.sel) : null;
      const spot = _onboardEl.querySelector('.onboard-spot');
      const card = _onboardEl.querySelector('.onboard-card');
      if (target && spot && card) {
        const r = target.getBoundingClientRect();
        const pad = 6;
        spot.style.left   = (r.left   - pad) + 'px';
        spot.style.top    = (r.top    - pad) + 'px';
        spot.style.width  = (r.width  + pad * 2) + 'px';
        spot.style.height = (r.height + pad * 2) + 'px';
        const cardX = Math.min(window.innerWidth - 320, Math.max(12, r.left));
        const cardY = Math.min(window.innerHeight - 180, r.bottom + 12);
        card.style.left = cardX + 'px';
        card.style.top  = cardY + 'px';
      }
      const titleEl = _onboardEl.querySelector('.onboard-title');
      const msgEl   = _onboardEl.querySelector('.onboard-msg');
      const counter = _onboardEl.querySelector('.onboard-counter');
      const next    = _onboardEl.querySelector('.onboard-next');
      if (titleEl) titleEl.textContent = step.title;
      if (msgEl)   msgEl.textContent   = step.msg;
      if (counter) counter.textContent = (_onboardStep + 1) + ' / ' + ONBOARDING_STEPS.length;
      if (next)    next.textContent    = (_onboardStep === ONBOARDING_STEPS.length - 1) ? 'Done' : 'Next';
    };
    const _closeOnboarding = () => {
      try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch (_) {}
      if (_onboardEl) { _onboardEl.remove(); _onboardEl = null; }
    };
    const startOnboarding = (force = false) => {
      if (_onboardEl) return;
      try { if (!force && localStorage.getItem(ONBOARDING_KEY)) return; } catch (_) {}
      _onboardStep = 0;
      const overlay = document.createElement('div');
      overlay.id = 'onboarding-overlay';
      overlay.innerHTML =
        '<div class="onboard-spot"></div>' +
        '<div class="onboard-card">' +
          '<div class="onboard-counter"></div>' +
          '<div class="onboard-title"></div>' +
          '<div class="onboard-msg"></div>' +
          '<div class="onboard-actions">' +
            '<button class="btn btn-mini onboard-skip">Skip</button>' +
            '<button class="btn btn-mini btn-success onboard-next">Next</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      _onboardEl = overlay;
      overlay.querySelector('.onboard-skip').addEventListener('click', _closeOnboarding);
      overlay.querySelector('.onboard-next').addEventListener('click', () => {
        if (_onboardStep < ONBOARDING_STEPS.length - 1) { _onboardStep++; _renderOnboardStep(); }
        else _closeOnboarding();
      });
      _renderOnboardStep();
    };
    $('btn-show-tutorial')?.addEventListener('click', () => startOnboarding(true));
    setTimeout(() => startOnboarding(false), 600);
    canvas.addEventListener('mouseleave', () => {
      const tipEl = $('validation-tooltip');
      if (tipEl) tipEl.style.display = 'none';
      if (state._obsResizeDrag) { state._obsResizeDrag = null; canvas.style.cursor = ''; markDirty(); render(); }
    });

    // ---------- Beforeunload dirty guard ----------
    window.addEventListener('beforeunload', (e) => {
      if (_isDirty) { e.preventDefault(); e.returnValue = ''; }
    });

    window.addEventListener('resize', () => { fitCanvas(); render(); });
    fitCanvas();
    render();
    window.__LEVEL_EDITOR_READY = true;

    // Public automation API
    return {
      setLevel(levelData, courtId = null) {
        state.levels = [{ courtId, slot: null, data: cloneDeep(levelData) }];
        state.currentIdx = 0;
        state.selectedObs = -1;
        state.selectedObsList = [];
        state.selectedKind = null;
        fitCanvas(); render();
      },
      addObstacle(o) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return -1;
        lvl.data.obstacles.push(cloneDeep(o));
        render();
        return lvl.data.obstacles.length - 1;
      },
      exportLevel() {
        const lvl = state.levels[state.currentIdx];
        return lvl ? cloneDeep(lvl.data) : null;
      },
      getCanvas() { return canvas; },
      zen(on = true) { document.body.classList.toggle('is-zen', on); fitCanvas(); render(); },
      getState() { return state; },
      render,
      getLevels() { return cloneDeep(state.levels); },
      setLevels(arr) {
        if (!Array.isArray(arr)) return;
        pushHistory(true, 'setLevels');
        state.levels = cloneDeep(arr);
        state.currentIdx = Math.max(0, Math.min(state.currentIdx, state.levels.length - 1));
        render();
      },
      on(event, cb) {
        (_listeners[event] = _listeners[event] || []).push(cb);
      },
      off(event, cb) {
        if (!_listeners[event]) return;
        _listeners[event] = _listeners[event].filter(f => f !== cb);
      },
      toggleTypeVisibility(type) {
        if (state.hiddenTypes.has(type)) state.hiddenTypes.delete(type);
        else state.hiddenTypes.add(type);
        render();
      },
      lockObstacle(idx) { state.lockedObs.add(idx); render(); },
      unlockObstacle(idx) { state.lockedObs.delete(idx); render(); },
      getLockedObstacles() { return Array.from(state.lockedObs); },
      snapshot() { return cloneDeep({ levels: state.levels, currentIdx: state.currentIdx }); },
      restore(snap) {
        if (!snap || !Array.isArray(snap.levels)) return;
        pushHistory(true, 'Restore snapshot');
        state.levels = cloneDeep(snap.levels);
        state.currentIdx = Math.max(0, Math.min(snap.currentIdx || 0, state.levels.length - 1));
        render();
      },
      removeObstacle(index) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return false;
        if (index < 0 || index >= lvl.data.obstacles.length) return false;
        pushHistory(true, 'Remove obstacle');
        lvl.data.obstacles.splice(index, 1);
        render(); return true;
      },
      updateObstacle(index, fields) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return false;
        if (index < 0 || index >= lvl.data.obstacles.length) return false;
        pushHistory(true, 'Update obstacle');
        Object.assign(lvl.data.obstacles[index], fields);
        render(); return true;
      },
      alignLeft()    { alignSelected('left'); },
      alignRight()   { alignSelected('right'); },
      alignTop()     { alignSelected('top'); },
      alignBottom()  { alignSelected('bottom'); },
      alignCenterH() { alignSelected('centerH'); },
      alignCenterV() { alignSelected('centerV'); },
      groupSelected,
      ungroupSelected,
      mirrorSelected,
      startOnboarding,
      rebuildSpatialIndex,
      setSnapToObstacles(v) { state.snapToObstacles = !!v; },
      // Z-order public API
      bringForward(idx) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const o = lvl.data.obstacles[idx]; if (!o) return;
        pushHistory(true, 'Bring Forward'); o._z = (o._z || 0) + 1; render();
      },
      sendBackward(idx) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const o = lvl.data.obstacles[idx]; if (!o) return;
        pushHistory(true, 'Send Backward'); o._z = (o._z || 0) - 1; render();
      },
      bringToFront(idx) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const o = lvl.data.obstacles[idx]; if (!o) return;
        pushHistory(true, 'Bring To Front');
        const maxZ = Math.max(0, ...lvl.data.obstacles.map(x => x._z || 0));
        o._z = maxZ + 1; render();
      },
      sendToBack(idx) {
        const lvl = state.levels[state.currentIdx]; if (!lvl) return;
        const o = lvl.data.obstacles[idx]; if (!o) return;
        pushHistory(true, 'Send To Back');
        const minZ = Math.min(0, ...lvl.data.obstacles.map(x => x._z || 0));
        o._z = minZ - 1; render();
      },
      restoreBackup,
      registerCommand,
      openCommandPalette,
      exportPNG,
      shareLink
    };
  }; // end create()

  return { create };
})();
