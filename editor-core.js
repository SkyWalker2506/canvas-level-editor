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
    const PUBLISH_HISTORY_KEY= config.publishHistoryKey || 'canvas_editor_publish_history';
    const SETTINGS_KEY       = config.settingsKey       || 'canvas_editor_settings';
    const PREFABS_KEY        = config.prefabsKey        || 'canvas_editor_prefabs';
    const GY                 = config.groundY           ?? 380;
    const CANVAS_H           = config.canvasHeight      ?? 540;
    const SCHEMA             = config.schema            || {};
    const COURSES            = config.courses           || {};
    const TYPE_COLORS        = config.typeColors        || {};
    const ASSET_TOOLTIPS     = config.assetTooltips     || {};
    const COURSE_NAMES       = config.courseNames       || {};
    const BUILTIN_PREFABS    = config.builtinPrefabs    || [];

    const TYPES = Object.keys(SCHEMA);
    const HISTORY_MAX = 50;
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
      snap: true,
      drag: null,
      sync: { enabled: false, updatedAt: null, courses: {} },
      history: [],
      future: [],
      publishHistory: [],
      suppressHistory: false,
      recentTypes: [],
      userPrefabs: [],
      smartGuideX: null,
      _gameWin: null,
      hiddenTypes: new Set(),
      sortMode: 'none',
      lockedObs: new Set(),
      gridSize: config.gridSize || GRID
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
      if (u) u.disabled = !state.history.length;
      if (r) r.disabled = !state.future.length;
    };

    // ---------- Storage: load/save ----------
    const save = () => {
      if (!safeSetItem(STORAGE_KEY, JSON.stringify(state.levels), 'levels')) return;
      _isDirty = false;
      publishSync({ announce: false });
      toast(state.sync.enabled ? 'Saved + synced to game' : 'Saved');
      if (config.onSave) { try { config.onSave(cloneDeep(state.levels)); } catch (_) {} }
    };
    const load = () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state.levels = JSON.parse(raw);
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
      const src = state.selectedObsList.map(i => cloneDeep(lvl.data.obstacles[i]));
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
      if (insertX == null) insertX = lvl.data.ballStart.x + 150;
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
        const card = document.createElement('div');
        card.className = 'prefab-card' + (p.user ? ' prefab-user' : '');
        card.innerHTML = `
          <div class="prefab-name">${p.name}</div>
          ${p.desc ? `<div class="prefab-desc">${p.desc}</div>` : ''}
          <div class="prefab-meta">${p.obstacles.length} obj${p.user ? ' · user' : ''}</div>`;
        card.title = 'Click to insert at ball start + 150';
        card.addEventListener('click', () => insertPrefab(p));
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
      return {
        courtId,
        slot: null,
        data: {
          name: 'New Level',
          subtitle: '',
          worldW: 800,
          time: 0.3,
          ballStart: { x: 100, y: GY - 30 },
          hole: { x: 700, y: GY },
          maxShots: 4,
          starShots: [2, 3, 4],
          obstacles: []
        }
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

      // Obstacles — delegate entirely to plugin
      L.obstacles.forEach((o, i) => {
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

      // Ruler overlay
      if (state.showRuler) {
        ctx.save();
        const ranges = [325, 400, 485, 570];
        const tierLabels = ['T1', 'T2', 'T3', 'T4'];
        ctx.strokeStyle = 'rgba(255,87,51,0.45)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ranges.forEach((r, i) => {
          ctx.beginPath();
          ctx.arc(bx, by, r, -Math.PI, 0);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,87,51,0.85)';
          ctx.font = '11px sans-serif';
          ctx.fillText(tierLabels[i], bx + r - 16, by - 6);
        });
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ff5733';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(hx, hy); ctx.stroke();
        const dist = Math.round(Math.hypot(hx - bx, hy - by));
        ctx.fillStyle = '#ff5733';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(`${dist}px`, (bx + hx) / 2, (by + hy) / 2 - 10);
        ctx.restore();
      }
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
      entries.forEach(({ lvl, idx }) => {
        const li = document.createElement('li');
        const isActive = idx === state.currentIdx;
        li.className = 'level-item' + (isActive ? ' active' : '');
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
        li.innerHTML = `<span class="${chipCls}">${courtTag}</span><span class="name">${name}</span>${playBtn}`;
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
      if (!issues.length) {
        ul.innerHTML = header + '<li class="empty-state">No issues.</li>';
        return;
      }
      ul.innerHTML = header + issues.map((i, idx) => {
        const clickable = i.obstacleIdx != null;
        return `<li class="v-item v-${i.level}${clickable ? ' v-click' : ''}" data-issue="${idx}"><span class="v-dot"></span>${i.msg}</li>`;
      }).join('');
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
    };

    // ---------- UI: Asset palette ----------
    const makeAssetButton = (type, extraCls = '') => {
      const b = document.createElement('button');
      b.className = 'asset-btn' + (extraCls ? ' ' + extraCls : '');
      b.dataset.type = type;
      b.title = ASSET_TOOLTIPS[type] || type;
      b.innerHTML = `<span class="asset-swatch" style="background:${TYPE_COLORS[type] || '#888'}"></span><span>${type}</span>`;
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
        ['in-name','in-subtitle','in-worldW','in-time','in-maxShots','in-starShots','in-ballX','in-holeX','in-slot'].forEach(id => set(id, ''));
        const ic = $('in-court');
        if (ic && ic !== document.activeElement) ic.value = 'null';
        const cn = $('current-level-name');
        if (cn) cn.textContent = '—';
        return;
      }
      const L = lvl.data;
      set('in-name', L.name);
      set('in-subtitle', L.subtitle);
      set('in-worldW', L.worldW);
      set('in-time', L.time);
      set('in-maxShots', L.maxShots);
      set('in-starShots', (L.starShots || []).join(','));
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
        L.worldW = Math.max(400, Math.min(8000, parseInt($('in-worldW').value) || 800));
        if (L.worldW > 3000) toast('⚠ World width ' + L.worldW + 'px is large — may cause slow rendering', 3000);
        L.time = parseFloat($('in-time').value) || 0;
        L.maxShots = parseInt($('in-maxShots').value) || 4;
        L.starShots = $('in-starShots').value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        L.ballStart.x = parseInt($('in-ballX').value) || 100;
        L.hole.x = parseInt($('in-holeX').value) || 700;
        const c = $('in-court').value;
        lvl.courtId = c === 'null' ? null : parseInt(c, 10);
        const s = parseInt($('in-slot').value);
        lvl.slot = isNaN(s) ? null : s;
        slotWarning();
        render();
      };
      ['in-name','in-subtitle','in-worldW','in-time','in-maxShots','in-starShots','in-ballX','in-holeX','in-court','in-slot']
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
        o.x = worldW - o.x;
      }
      if (FLIPPABLE_DIR.has(o.type)   && Number.isFinite(o.dir))   o.dir   = -o.dir;
      if (FLIPPABLE_FORCE.has(o.type) && Number.isFinite(o.force)) o.force = -o.force;
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
        return;
      }
      const o = lvl.data.obstacles[state.selectedObs];
      const sch = SCHEMA[o.type];
      if (!sch) { if (body) body.innerHTML = '<div class="empty-state">Unknown type: ' + o.type + '</div>'; return; }
      if (info) info.textContent = `${o.type} #${state.selectedObs + 1}`;
      let html = `<div class="props-header"><strong>${o.type}</strong><button class="btn btn-mini btn-danger" id="prop-delete">Delete</button></div>`;
      html += `<div class="form-row"><label>z-order</label><span>${state.selectedObs + 1} / ${lvl.data.obstacles.length}</span></div>`;
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
        $('prop-delete').addEventListener('click', deleteSelected);
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
              state._gameWin.location.href = `./?course=${lvl.courtId}&level=${lvl.slot}&ts=${Date.now()}`;
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
      if (config.onObstacleDelete) { try { config.onObstacleDelete(deleted, lvl); } catch(_){} }
      state.selectedObs = -1;
      state.selectedObsList = [];
      state.selectedKind = null;
      render();
      toast(ids.length === 1 ? 'Deleted' : `Deleted ${ids.length}`);
    };

    // ---------- Play in game ----------
    const writePreview = (lvl) => {
      try {
        localStorage.setItem('canvas_editor_preview', JSON.stringify({
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
        url = `./?course=${lvl.courtId}&level=${lvl.slot}&ts=${Date.now()}`;
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

    canvas.addEventListener('mousedown', (e) => {
      const p = canvasPt(e);
      if (panState.spaceDown) return;
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
        const ALIGN_PX = 8;
        const wantAlign = !e.altKey;
        const ids = state.selectedObsList.length ? state.selectedObsList : [state.drag.index];
        const primary = lvl.data.obstacles[state.drag.index];
        const neighborXs = lvl.data.obstacles
          .filter((ob, i) => !ids.includes(i))
          .flatMap(ob => {
            const pts = [];
            if (ob.x1 != null) { pts.push(ob.x1, ob.x2, (ob.x1 + ob.x2) / 2); }
            else if (ob.x != null) pts.push(ob.x);
            return pts;
          })
          .filter(x => x != null);
        state.smartGuideX = null;
        const snapToNeighbor = (val) => {
          if (!wantAlign) return val;
          for (const nx of neighborXs) if (Math.abs(val - nx) <= ALIGN_PX) { state.smartGuideX = nx; return nx; }
          const ballX = lvl.data.ballStart?.x;
          if (ballX != null && Math.abs(val - ballX) <= ALIGN_PX) { state.smartGuideX = ballX; return ballX; }
          const holeX = lvl.data.hole?.x;
          if (holeX != null && Math.abs(val - holeX) <= ALIGN_PX) { state.smartGuideX = holeX; return holeX; }
          return val;
        };
        let newPrimaryX;
        let deltaX;
        if ('x1' in primary) {
          const w = primary.x2 - primary.x1;
          const sx = snap(state.drag.origX + dx);
          const centered = sx + w / 2;
          newPrimaryX = snapToNeighbor(centered) - w / 2;
          deltaX = newPrimaryX - primary.x1;
        } else {
          newPrimaryX = snapToNeighbor(snap(state.drag.origX + dx));
          deltaX = newPrimaryX - primary.x;
        }
        const deltaY = snap(state.drag.origY + dy) - state.drag.origY;
        const yLocked = config.yLockedTypes || new Set(['hill','movingHill','trampoline','spring','portal']);
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
      if (state.drag) { state.smartGuideX = null; }
      state.drag = null;
      if (state.marquee) {
        const m = state.marquee; state.marquee = null;
        const x1 = Math.min(m.startX, m.endX), x2 = Math.max(m.startX, m.endX);
        const y1 = Math.min(m.startY, m.endY), y2 = Math.max(m.startY, m.endY);
        if (x2 - x1 < 4 && y2 - y1 < 4) { render(); return; }
        const lvl = state.levels[state.currentIdx];
        if (!lvl) { render(); return; }
        const picks = [];
        lvl.data.obstacles.forEach((o, i) => {
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
      const off = 40;
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
      toast(clipboard.length === 1 ? 'Pasted' : `Pasted ${clipboard.length}`);
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
      if (!inField && mod && e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); copySelection(); pasteBelow(); return; }
      if (!inField && mod && !e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); copySelection(); pasteClipboard(); return; }
      if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        const h = $('help-overlay'); if (h) { h.style.display = ''; $('help-close')?.focus(); }
        return;
      }
      if (e.key === 'Escape') {
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
      if (mod && e.key === '0') { e.preventDefault(); fitCanvas(); render(); return; }
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
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); scrollToSelection(); }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); playInGame(); }
      if ((e.key === 'z' || e.key === 'Z') && !mod) {
        e.preventDefault();
        document.body.classList.toggle('is-zen');
        fitCanvas(); render();
        toast(document.body.classList.contains('is-zen') ? 'Zen mode' : 'Zen off');
      }
    });

    // ---------- Topbar wiring ----------
    $('btn-new-level').addEventListener('click', () => {
      pushHistory(true);
      state.levels.push(newLevel());
      state.currentIdx = state.levels.length - 1;
      saveSettings();
      render();
    });
    $('btn-duplicate-level').addEventListener('click', () => {
      const lvl = state.levels[state.currentIdx]; if (!lvl) return;
      pushHistory(true);
      const copy = cloneDeep(lvl);
      copy.data.name = (copy.data.name || 'level') + ' (copy)';
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
    document.getElementById('canvas-wrap')?.addEventListener('scroll', () => { renderMinimap(); });
    $('btn-sync-publish').addEventListener('click', () => publishSync({ announce: true }));
    $('btn-sync-clear').addEventListener('click', () => {
      if (!confirm('Clear sync? The game will revert to baked levels.')) return;
      clearSync();
    });
    $('filter-court').addEventListener('change', () => { renderLevelList(); renderSlotGrid(); saveSettings(); });
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

    // ---------- Zoom label click: reset to 100% ----------
    $('zoom-label')?.addEventListener('click', () => {
      state.zoom = 1; resizeCanvas(); render(); saveSettings();
      toast('Zoom reset to 100%');
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
      mmCtx.fillStyle = '#fff';
      mmCtx.fillRect((L.ballStart.x + LEFT_PAD) * sx - 2, L.ballStart.y * sy - 2, 4, 4);
      mmCtx.fillStyle = '#d83d3d';
      mmCtx.fillRect((L.hole.x + LEFT_PAD) * sx - 2, L.hole.y * sy - 6, 4, 6);
      const w = wrapEl();
      if (w) {
        const vx = (w.scrollLeft / state.zoom) * sx;
        const vy = (w.scrollTop / state.zoom) * sy;
        const vw = (w.clientWidth / state.zoom) * sx;
        const vh = (w.clientHeight / state.zoom) * sy;
        mmCtx.strokeStyle = '#ff5733';
        mmCtx.lineWidth = 2;
        mmCtx.strokeRect(vx, vy, Math.min(vw, W), Math.min(vh, H));
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

    // Populate help shortcut list
    const SHORTCUTS = [
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+C', 'Copy'],
      ['Ctrl+V', 'Paste'], ['Ctrl+Shift+V', 'Paste at center'],
      ['Ctrl+X', 'Cut'], ['Ctrl+D', 'Duplicate'], ['Ctrl+Shift+D', 'Duplicate below'],
      ['Ctrl+A', 'Select all'], ['Ctrl+N', 'New level'], ['Ctrl+S', 'Save'],
      ['Delete/Backspace', 'Delete selected'],
      ['Arrow keys', 'Nudge (grid)'], ['Shift+Arrow', 'Nudge (1px)'],
      ['Alt+↑/↓', 'Reorder level'],
      ['Tab/Shift+Tab', 'Cycle obstacles'],
      ['Space+drag', 'Pan canvas'],
      ['1', 'Select tool'], ['2', 'Eraser'], ['3', 'Ball tool'],
      ['4', 'Hole tool'], ['G', 'Toggle grid'],
      ['[/]', 'Grid size -/+5'],
      ['Ctrl+=/-', 'Zoom in/out'], ['Ctrl+0', 'Fit to window'],
      ['Ctrl+Home/End', 'First/last level'],
      ['P', 'Play level'], ['F', 'Focus selection'],
      ['Z', 'Zen mode'], ['?', 'Help'],
      ['Home', 'Scroll to ball'], ['End', 'Scroll to hole'],
    ];
    const helpEl = $('help-shortcuts');
    if (helpEl) {
      helpEl.innerHTML = SHORTCUTS.map(([k, v]) =>
        `<li><kbd>${k}</kbd> <span>${v}</span></li>`
      ).join('');
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

    // First-visit welcome toast
    try {
      if (!localStorage.getItem('canvas_editor_welcomed')) {
        toast('Welcome! Press ? for keyboard shortcuts, Space+drag to pan.', 5000);
        localStorage.setItem('canvas_editor_welcomed', '1');
      }
    } catch (_) {}

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
      }
    };
  }; // end create()

  return { create };
})();
