/**
 * asset-properties-panel.js — v0.1.0
 * Reusable Asset Properties panel (Pivot / Collider / Variants / Anchor tabs).
 *
 * Public API:
 *   mountAssetPropertiesPanel(hostEl, opts) → { refresh, destroy }
 *
 * opts:
 *   editor          {object}  canvas-level-editor instance (getState, on, render)
 *   schema          {object}  SCHEMA map  { [typeId]: ... }
 *   typeIcons       {object}  TYPE_ICONS  { [typeId]: { sprite } | string }
 *   assetBrowserBase {string} base URL for "Edit pixels" link
 *                             default: 'https://asset-browser-golf-paper-craft.vercel.app'
 *   markDirty       {function} optional — called whenever a property is committed
 *
 * The panel is inserted into hostEl as a <section class="panel"> element.
 * If a panel with id="asset-properties-panel" already exists in hostEl, the
 * call is a no-op (idempotent).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.AssetPropertiesPanel = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ASSET_OVERRIDES_KEY = 'gpc_asset_overrides';

  const readOverrides = () => {
    try {
      const raw = localStorage.getItem(ASSET_OVERRIDES_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  };

  const writeOverrides = (obj) => {
    try {
      localStorage.setItem(ASSET_OVERRIDES_KEY, JSON.stringify(obj));
      localStorage.setItem('gpc_asset_overrides_updated_at', String(Date.now()));
    } catch (_) {}
  };

  const setTypeOverride = (typeId, patch) => {
    const all = readOverrides();
    all[typeId] = { ...(all[typeId] || {}), ...patch };
    writeOverrides(all);
  };

  const clampPv = (v) => {
    const n = Number(v);
    return Math.max(0, Math.min(1, isNaN(n) ? 0.5 : n));
  };

  const TYPE_LABELS = {
    pit: 'Pit', hill: 'Hill', tree: 'Tree', rock: 'Rock', water: 'Water',
    bridge: 'Bridge', mud: 'Mud', trampoline: 'Trampoline', spring: 'Spring',
    fence: 'Fence', wind: 'Wind', magnet: 'Magnet', portal: 'Portal',
    cloudPlatform: 'Cloud Platform', stormCloud: 'Storm Cloud', fan: 'Fan',
    voidZone: 'Void Zone', windRiver: 'Wind River', lavaGeyser: 'Lava Geyser',
    crystalRefractor: 'Crystal', icePool: 'Ice Pool', stalactite: 'Stalactite',
    boostPad: 'Boost Pad', firewall: 'Firewall', ramp: 'Ramp',
    gravityFlip: 'Gravity Flip', laserGate: 'Laser Gate',
    gummyTrap: 'Gummy Trap', candyBouncer: 'Candy Bouncer',
    candyWall: 'Candy Wall', syrupRiver: 'Syrup River', wall: 'Wall'
  };

  /**
   * Mount the Asset Properties panel into hostEl.
   * @param {HTMLElement} hostEl  — container (typically #right-panel)
   * @param {object}      opts
   * @returns {{ refresh: function, destroy: function }}
   */
  function mountAssetPropertiesPanel(hostEl, opts) {
    if (!hostEl) return { refresh: () => {}, destroy: () => {} };
    if (document.getElementById('asset-properties-panel')) {
      return { refresh: () => {}, destroy: () => {} };
    }

    const editor              = opts.editor              || {};
    const schema              = opts.schema              || {};
    const typeIcons           = opts.typeIcons            || {};
    const browserBase         = (opts.assetBrowserBase || 'https://asset-browser-golf-paper-craft.vercel.app').replace(/\/$/, '');
    const markDirty           = typeof opts.markDirty          === 'function' ? opts.markDirty          : () => {};
    const resolveCustomType   = typeof opts.resolveCustomType  === 'function' ? opts.resolveCustomType  : () => null;
    const resolveCustomLabel  = typeof opts.resolveCustomLabel === 'function' ? opts.resolveCustomLabel : () => null;

    // Local wrapper that also fires markDirty after every override write
    const setTypeOverrideDirty = (typeId, patch) => {
      setTypeOverride(typeId, patch);
      markDirty();
    };

    // ------------------------------------------------------------------ DOM
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = 'asset-properties-panel';
    panel.innerHTML = `
      <h3>📐 Asset Properties</h3>
      <div id="ap-empty" class="empty-state" style="font-size:12px">
        Click an asset in the palette (left), or select a placed obstacle, to edit its Pivot, Collider, and Variants.
      </div>
      <div id="ap-body" style="display:none">
        <div id="ap-target" class="hint" style="font-weight:600;margin-bottom:6px"></div>
        <a id="ap-open-browser" target="_blank" rel="noopener"
           style="display:flex;align-items:center;justify-content:center;gap:6px;
                  padding:8px 10px;margin-bottom:8px;
                  background:linear-gradient(180deg,#5fa9ff 0%,#3a7fcc 100%);
                  border:1px solid #2a5d99;border-radius:8px;
                  color:#0a1c2e;font:700 12px Fredoka,sans-serif;
                  text-decoration:none;letter-spacing:0.2px;">
          🌐 Edit pixels in Asset Browser →
        </a>
        <div class="tool-row" role="tablist" aria-label="Asset metadata tabs"
             style="display:flex;gap:4px;margin-bottom:8px">
          <button type="button" class="btn btn-mini ap-tab active" data-ap-tab="pivot" role="tab" aria-selected="true">Pivot</button>
          <button type="button" class="btn btn-mini ap-tab" data-ap-tab="collider" role="tab" aria-selected="false">Collider</button>
          <button type="button" class="btn btn-mini ap-tab" data-ap-tab="variants" role="tab" aria-selected="false">Variants</button>
          <button type="button" class="btn btn-mini ap-tab" data-ap-tab="anchor" role="tab" aria-selected="false">Anchor</button>
        </div>
        <div class="ap-pane" data-ap-pane="pivot">
          <div class="hint" style="font-size:11px;margin-bottom:6px">Pivot offset relative to (0,0). Affects placement anchor.</div>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            <label style="flex:1;display:flex;align-items:center;gap:4px;font-size:12px">
              <span style="min-width:14px">x</span>
              <input type="number" id="ap-pivot-x" step="0.05" min="0" max="1" style="flex:1;min-width:60px"/>
            </label>
            <label style="flex:1;display:flex;align-items:center;gap:4px;font-size:12px">
              <span style="min-width:14px">y</span>
              <input type="number" id="ap-pivot-y" step="0.05" min="0" max="1" style="flex:1;min-width:60px"/>
            </label>
            <button type="button" class="btn btn-mini" id="ap-pivot-reset" title="Reset pivot to (0.5, 1.0)">↺</button>
          </div>
          <div id="ap-pivot-thumb-wrap"
               style="position:relative;width:100%;aspect-ratio:1/1;max-height:160px;background:rgba(0,0,0,0.05);border:1px dashed rgba(0,0,0,0.18);border-radius:6px;overflow:hidden;cursor:crosshair;user-select:none">
            <img id="ap-pivot-thumb" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none"/>
            <div id="ap-pivot-handle"
                 style="position:absolute;width:14px;height:14px;border-radius:50%;background:#5aaee8;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);transform:translate(-50%,-50%);pointer-events:none"></div>
          </div>
        </div>
        <div class="ap-pane" data-ap-pane="collider" style="display:none">
          <div class="hint" style="font-size:11px">Collider editing has its own panel below. The selected obstacle's colliders appear in <strong>🧱 Colliders</strong>.</div>
          <button type="button" class="btn btn-mini" id="ap-jump-collider" style="margin-top:6px">Jump to Colliders ↓</button>
        </div>
        <div class="ap-pane" data-ap-pane="variants" style="display:none">
          <div class="hint" style="font-size:11px;margin-bottom:6px">Variants inherit from the base asset and override specific props. Place an obstacle and pick a variant on the instance to use it.</div>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <button type="button" class="btn btn-mini" id="ap-variant-add">+ Add Variant</button>
            <button type="button" class="btn btn-mini" id="ap-variant-reset" title="Re-seed base from asset defaults">↺ Reset base</button>
          </div>
          <div id="ap-variant-host"></div>
          <div id="ap-variant-missing" class="hint" style="display:none;font-size:11px;color:#b04">Variant system not loaded.</div>
        </div>
        <div class="ap-pane" data-ap-pane="anchor" style="display:none">
          <div class="hint" style="font-size:11px;margin-bottom:8px">Anchor pins determine which corners of the sprite stay fixed when the canvas or world is resized.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="ap-anchor-tl" />
              <span>Top-Left</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="ap-anchor-tr" />
              <span>Top-Right</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="ap-anchor-bl" />
              <span>Bottom-Left</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="ap-anchor-br" />
              <span>Bottom-Right</span>
            </label>
          </div>
          <div class="hint" style="font-size:11px;color:rgba(255,255,255,0.45)">Stored in asset overrides as <code>anchors:[tl,tr,bl,br]</code>.</div>
        </div>
      </div>
    `;

    // Insert before collider-panel if present, else before props-panel, else append.
    const colPanel   = document.getElementById('collider-panel');
    const propsPanel = document.getElementById('props-panel');
    if (colPanel && colPanel.parentNode === hostEl) {
      hostEl.insertBefore(panel, colPanel);
    } else if (propsPanel && propsPanel.parentNode === hostEl) {
      hostEl.insertBefore(panel, propsPanel);
    } else {
      hostEl.appendChild(panel);
    }

    // ---------------------------------------------------------------- State
    let activeTab        = 'pivot';
    let _activeType      = null;
    let _variantMountedFor = null;

    // -------------------------------------------------------------- Helpers
    const computeActiveType = () => {
      const st = editor.getState ? editor.getState() : null;
      // Allow host to resolve custom asset types first
      const custom = resolveCustomType(st);
      if (custom) return custom;
      if (st && st.selectedKind === 'obs' && st.selectedObs >= 0) {
        const lvl = st.levels && st.levels[st.currentIdx];
        const o = lvl && lvl.data && lvl.data.obstacles && lvl.data.obstacles[st.selectedObs];
        if (o && o.type && schema[o.type]) return o.type;
        // Also return custom-typed obstacles even if not in schema
        if (o && o.type && o.type.startsWith('custom:')) return o.type;
      }
      const tool = st && st.tool;
      if (tool && schema[tool]) return tool;
      return null;
    };

    const buildBaseProps = (typeId) => {
      const icon   = typeIcons[typeId];
      const sprite = (icon && typeof icon === 'object' && icon.sprite) ? './' + icon.sprite : '';
      return { sprite, scale: 1, tint: '', rotation: 0, flipH: false, flipV: false, filter: '' };
    };

    const propsSchemaFor = () => ({
      sprite:   { type: 'string' },
      scale:    { type: 'number', min: 0.1, max: 4, step: 0.05 },
      tint:     { type: 'string' },
      rotation: { type: 'number', min: -360, max: 360, step: 1 },
      flipH:    { type: 'boolean' },
      flipV:    { type: 'boolean' },
      filter:   { type: 'string' }
    });

    const ensureVariantBase = (typeId) => {
      if (!window.VariantSystem) return;
      try { window.VariantSystem.defineBase(typeId, buildBaseProps(typeId)); } catch (_) {}
    };

    const refreshPivotThumb = () => {
      const a      = _activeType;
      const img    = document.getElementById('ap-pivot-thumb');
      const handle = document.getElementById('ap-pivot-handle');
      if (!img || !handle) return;
      const icon   = a ? typeIcons[a] : null;
      const sprite = (icon && typeof icon === 'object' && icon.sprite) ? './' + icon.sprite : '';
      img.src           = sprite || '';
      img.style.opacity = sprite ? '1' : '0.3';
      const ovr  = a ? (readOverrides()[a] || {}) : {};
      const piv  = ovr.pivot || { x: 0.5, y: 1.0 };
      const wrap = document.getElementById('ap-pivot-thumb-wrap');
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const cx   = clampPv(piv.x) * rect.width;
      const cy   = clampPv(piv.y) * rect.height;
      handle.style.left = cx + 'px';
      handle.style.top  = cy + 'px';
    };

    // ---------------------------------------------------------------- Refresh
    const refresh = () => {
      const ty = computeActiveType();
      _activeType = ty;
      const empty  = document.getElementById('ap-empty');
      const body   = document.getElementById('ap-body');
      const target = document.getElementById('ap-target');
      if (!empty || !body || !target) return;
      if (!ty) {
        empty.style.display = '';
        body.style.display  = 'none';
        return;
      }
      empty.style.display = 'none';
      body.style.display  = '';
      const customLbl = resolveCustomLabel(ty);
      if (customLbl) {
        target.textContent = customLbl.label + '  ·  ' + customLbl.sub;
      } else {
        target.textContent = (TYPE_LABELS[ty] || ty) + '  ·  ' + ty;
      }

      const browserLink = document.getElementById('ap-open-browser');
      if (browserLink) {
        browserLink.href = browserBase + '/?asset=' + encodeURIComponent(ty);
      }

      // Pivot
      const ovr = readOverrides()[ty] || {};
      const piv = ovr.pivot || { x: 0.5, y: 1.0 };
      const px  = document.getElementById('ap-pivot-x');
      const py  = document.getElementById('ap-pivot-y');
      if (px && document.activeElement !== px) px.value = Number(piv.x != null ? piv.x : 0.5).toFixed(2);
      if (py && document.activeElement !== py) py.value = Number(piv.y != null ? piv.y : 1.0).toFixed(2);
      refreshPivotThumb();

      // Anchor
      const anchors   = ovr.anchors || [false, false, false, false];
      const anchorIds = ['ap-anchor-tl', 'ap-anchor-tr', 'ap-anchor-bl', 'ap-anchor-br'];
      anchorIds.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!(anchors[i]);
      });

      // Variants (lazy)
      if (activeTab === 'variants' && window.VariantSystem) {
        if (_variantMountedFor !== ty) {
          ensureVariantBase(ty);
          const host = document.getElementById('ap-variant-host');
          if (host) {
            host.innerHTML = '';
            try {
              window.VariantSystem.mountEditor({
                container:   host,
                typeId:      ty,
                propsSchema: propsSchemaFor(),
                renderThumb: function (el, variantId, props) {
                  const sp = props && props.sprite;
                  if (sp) {
                    el.style.background           = 'transparent';
                    el.style.backgroundImage      = "url('" + sp + "')";
                    el.style.backgroundSize       = 'contain';
                    el.style.backgroundRepeat     = 'no-repeat';
                    el.style.backgroundPosition   = 'center';
                    el.textContent = '';
                  } else {
                    el.textContent = (TYPE_LABELS[ty] || ty).charAt(0);
                  }
                }
              });
              _variantMountedFor = ty;
            } catch (e) { console.error('[asset-properties] variants mount', e); }
          }
        }
      }
      const missingMsg = document.getElementById('ap-variant-missing');
      if (missingMsg) missingMsg.style.display = window.VariantSystem ? 'none' : '';
    };

    // ----------------------------------------------------------- Tab switching
    panel.addEventListener('click', (ev) => {
      const tab = ev.target.closest('[data-ap-tab]');
      if (tab) {
        ev.preventDefault();
        activeTab = tab.dataset.apTab;
        panel.querySelectorAll('.ap-tab').forEach((b) => {
          const on = b.dataset.apTab === activeTab;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panel.querySelectorAll('.ap-pane').forEach((p) => {
          p.style.display = (p.dataset.apPane === activeTab) ? '' : 'none';
        });
        if (activeTab === 'variants') { _variantMountedFor = null; refresh(); }
        if (activeTab === 'pivot')    refreshPivotThumb();
        return;
      }
      const jump = ev.target.closest('#ap-jump-collider');
      if (jump) {
        ev.preventDefault();
        const cp = document.getElementById('collider-panel');
        if (cp) cp.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    });

    // ----------------------------------------------------------- Pivot inputs
    const onPivotInput = () => {
      if (!_activeType) return;
      const px = document.getElementById('ap-pivot-x');
      const py = document.getElementById('ap-pivot-y');
      const nx = clampPv(px && px.value);
      const ny = clampPv(py && py.value);
      setTypeOverrideDirty(_activeType, { pivot: { x: nx, y: ny } });
      markDirty();
      refreshPivotThumb();
      if (editor.render) editor.render();
    };
    panel.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.id === 'ap-pivot-x' || t.id === 'ap-pivot-y') onPivotInput();
    });

    // ----------------------------------------------------------- Anchor checkboxes
    panel.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement)) return;
      const anchorIds = ['ap-anchor-tl', 'ap-anchor-tr', 'ap-anchor-bl', 'ap-anchor-br'];
      if (!anchorIds.includes(t.id)) return;
      if (!_activeType) return;
      const anchors = anchorIds.map((id) => {
        const el = document.getElementById(id);
        return el ? el.checked : false;
      });
      setTypeOverrideDirty(_activeType, { anchors });
      markDirty();
    });

    // ----------------------------------------------------------- Pivot reset
    panel.addEventListener('click', (ev) => {
      const reset = ev.target.closest('#ap-pivot-reset');
      if (!reset || !_activeType) return;
      ev.preventDefault();
      setTypeOverrideDirty(_activeType, { pivot: { x: 0.5, y: 1.0 } });
      markDirty();
      refresh();
      if (editor.render) editor.render();
    });

    // ----------------------------------------------------------- Drag pivot handle
    const wrap = document.getElementById('ap-pivot-thumb-wrap');
    if (wrap) {
      let dragging = false;
      const setFromEvent = (e) => {
        if (!_activeType) return;
        const rect = wrap.getBoundingClientRect();
        const x = (e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX)) - rect.left;
        const y = (e.clientY != null ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY)) - rect.top;
        const px = clampPv(Math.round((x / rect.width) * 20) / 20);
        const py = clampPv(Math.round((y / rect.height) * 20) / 20);
        setTypeOverrideDirty(_activeType, { pivot: { x: px, y: py } });
        markDirty();
        const xi = document.getElementById('ap-pivot-x');
        const yi = document.getElementById('ap-pivot-y');
        if (xi) xi.value = px.toFixed(2);
        if (yi) yi.value = py.toFixed(2);
        refreshPivotThumb();
        if (editor.render) editor.render();
      };
      wrap.addEventListener('pointerdown', (e) => {
        if (!_activeType) return;
        dragging = true;
        wrap.setPointerCapture(e.pointerId);
        setFromEvent(e);
      });
      wrap.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
      wrap.addEventListener('pointerup', (e) => {
        dragging = false;
        try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
      });
    }

    // ----------------------------------------------------------- Variants add/reset
    panel.addEventListener('click', (ev) => {
      if (ev.target.closest('#ap-variant-add')) {
        ev.preventDefault();
        if (!_activeType) return;
        if (!window.VariantSystem) { alert('Variant system not loaded'); return; }
        const name = prompt('Variant name (e.g. "Pine", "Tall", "Red"):');
        if (!name) return;
        const id = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || ('v' + Date.now());
        ensureVariantBase(_activeType);
        try {
          window.VariantSystem.registerVariant(_activeType, id, name, {});
          _variantMountedFor = null;
          markDirty();
          refresh();
        } catch (e) { alert('Failed: ' + e.message); }
        return;
      }
      if (ev.target.closest('#ap-variant-reset')) {
        ev.preventDefault();
        if (!_activeType || !window.VariantSystem) return;
        if (!confirm('Reset base props for "' + (TYPE_LABELS[_activeType] || _activeType) + '" to asset defaults? Variants keep their overrides.')) return;
        const defaults = buildBaseProps(_activeType);
        Object.keys(defaults).forEach((k) => window.VariantSystem.setBase(_activeType, k, defaults[k]));
        markDirty();
        return;
      }
    });

    // ----------------------------------------------------------- Editor events
    if (editor.on) {
      editor.on('obstacleSelect', () => requestAnimationFrame(refresh));
      editor.on('levelChange',    () => requestAnimationFrame(refresh));
    }
    document.addEventListener('click', _paletteTileListener);
    function _paletteTileListener(ev) {
      const tile = ev.target.closest('#asset-palette .asset-btn, #asset-recent .asset-btn, #custom-asset-palette .asset-btn');
      if (tile) requestAnimationFrame(refresh);
    }
    if (window.VariantSystem && typeof window.VariantSystem.on === 'function') {
      window.VariantSystem.on('change', () => {
        // listVariants UI re-renders itself; nothing needed here.
      });
    }

    refresh();

    // ---------------------------------------------------------------- Public API
    const destroy = () => {
      document.removeEventListener('click', _paletteTileListener);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    };

    return { refresh, destroy };
  }

  return { mountAssetPropertiesPanel };
});
