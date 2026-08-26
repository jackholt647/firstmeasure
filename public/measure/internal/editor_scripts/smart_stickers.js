/* smart_stickers.js
 * v8: Clean white bar with red top border, right-aligned, collapsible
 * - White background with red top border (matching top bar)
 * - No label text
 * - Right-aligned, auto-width
 * - Toggle button to show/hide
 * - Overlays 2D view in bottom-right corner
 */
(function () {
    const STICKER_INTERACT_STATE = 'PLACING_SMART_STICKER';
    // ----------------------------- 
    // Helpers
    // ----------------------------- 
    function escapeHtml(s) {
        return String(s || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }
    function dist(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function cross2(a, b) {
        return a.x * b.y - a.y * b.x;
    }
    function dot2(a, b) {
        return a.x * b.x + a.y * b.y;
    }
    function norm(v) {
        const L = Math.hypot(v.x, v.y) || 1;
        return { x: v.x / L, y: v.y / L };
    }
    // sign = -1 => right turn (CW), +1 => left turn (CCW)
    function rot90(v, sign) {
        return (sign < 0)
            ? { x: v.y, y: -v.x }
            : { x: -v.y, y: v.x };
    }
    function moveFrom(p, dirUnit, d) {
        return { x: p.x + dirUnit.x * d, y: p.y + dirUnit.y * d };
    }
    function getMetersPerPxSafe() {
        try {
            if (typeof getMetersPerPx === 'function') return +getMetersPerPx() || 0;
        } catch (e) {}
        return 0;
    }
    function inchesToPx(inches) {
        const mpp = getMetersPerPxSafe();
        if (!(mpp > 0)) return null;
        const meters = inches * 0.0254;
        return meters / mpp;
    }
    function feetToPx(feet) {
        const px = inchesToPx(feet * 12);
        return (px && px > 0) ? px : feet * 20;
    }
    function feetToMeters(feet) {
        return feet * 0.3048;
    }
    function getDSMZAtXY(x, y) {
        try {
            if (!layerData || !layerData.dsm || !layerData.dsm[0]) return null;
            const dsm = layerData.dsm[0];
            const w = imageWidth, h = imageHeight;
            if (!(w > 0 && h > 0)) return null;
            const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
            const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
            const v = dsm[iy * w + ix];
            return (Number.isFinite(v) && v > -9000) ? v : null;
        } catch (e) {
            return null;
        }
    }
    function getPointZ(p) {
        if (p && Number.isFinite(p.z)) return p.z;
        const v = getDSMZAtXY(p.x, p.y);
        return (v !== null) ? v : 0;
    }
    function ensureLineTypesAvailableOnce(ctx) {
        if (ctx.__typesReady) return;
        ctx.__typesReady = true;
        try {
            const needs = !!(activeGeometry && activeGeometry.connections &&
                activeGeometry.connections.some(c => !c.type || c.type === 'unknown'));
            if (needs && typeof generateMeasurementsSilent === 'function') {
                generateMeasurementsSilent({ forceFullFaceSolve: true, refresh2D: false, refresh3D: false });
            }
        } catch (e) {}
    }
    function hippedCorniceIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polyline points="2,20 2,14 10,6 22,6"/>
  <line x1="2" y1="20" x2="22" y2="6" stroke-dasharray="2 2"/>
</svg>`;
    }
    function unhippedCorniceIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polyline points="2,20 2,14 10,6 22,6"/>
</svg>`;
    }
    function skylightIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="8" y="4" width="8" height="16" rx="1"/>
  <line x1="8" y1="9" x2="16" y2="9"/>
  <line x1="8" y1="15" x2="16" y2="15"/>
</svg>`;
    }
    function chimneyIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="7" y="3" width="10" height="18" rx="1"/>
  <path d="M7 8h10"/>
  <path d="M7 16h10"/>
</svg>`;
    }
    function protrusionIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="5" y="5" width="14" height="14" rx="1"/>
  <path d="M5 12h14"/>
  <path d="M12 5v14"/>
</svg>`;
    }
    function twoFaceDormerIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 3 5 10v9h14v-9z"/>
  <path d="M12 3v16"/>
</svg>`;
    }
    function threeFaceDormerIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 3 5 10v9h14v-9z"/>
  <path d="M5 19 12 12l7 7"/>
  <path d="M12 3v9"/>
</svg>`;
    }
    function curvedDormerIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 3 5 10v9h14v-9z"/>
  <path d="M12 3v16"/>
  <path d="M6 18c3-4 9-4 12 0"/>
  <path d="M8 15c2-2 6-2 8 0"/>
</svg>`;
    }
    function eyebrowIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M4 18c3-7 13-7 16 0"/>
  <path d="M12 6v12"/>
  <path d="M7 16 12 10l5 6"/>
</svg>`;
    }
    function dutchGableIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M4 20 12 4l8 16"/>
  <path d="M7 14h10"/>
  <path d="M6 17h12" stroke-dasharray="2 2"/>
  <path d="M9 14 12 9l3 5"/>
</svg>`;
    }
    function jerkinHeadIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M4 20 12 4l8 16"/>
  <path d="M8 13 12 8l4 5"/>
  <path d="M8 13h8"/>
</svg>`;
    }
    function curvedFaceIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M4 18h16"/>
  <path d="M5 14c4-2 10-2 14 0"/>
  <path d="M6 10c3-2 9-2 12 0"/>
  <path d="M7 6c3-1 7-1 10 0"/>
</svg>`;
    }
    function turretConeIconSVG() {
        return `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="12" cy="12" r="2"/>
  <path d="M12 12 12 3"/>
  <path d="M12 12 20 7"/>
  <path d="M12 12 20 17"/>
  <path d="M12 12 12 21"/>
  <path d="M12 12 4 17"/>
  <path d="M12 12 4 7"/>
</svg>`;
    }
    // ----------------------------- 
    // Preview overlay hook
    // ----------------------------- 
    function installRenderOverlayHookOnce() {
        if (window.__smartStickerRenderHooked) return;
        window.__smartStickerRenderHooked = true;
        const clear3DPreview = () => {
            const group = window.__SMART_STICKER_3D_PREVIEW_GROUP__;
            if (!group) return;
            while (group.children.length > 0) {
                const child = group.children[0];
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m && m.dispose && m.dispose());
                    else if (child.material.dispose) child.material.dispose();
                }
                group.remove(child);
            }
        };
        const colorFromPreview = (value, fallback) => {
            try {
                if (typeof THREE === 'undefined') return fallback;
                const raw = value || fallback || '#ffc107';
                if (String(raw).startsWith('rgba')) {
                    const nums = String(raw).match(/[\d.]+/g) || [];
                    return new THREE.Color(
                        Math.min(1, (parseFloat(nums[0]) || 255) / 255),
                        Math.min(1, (parseFloat(nums[1]) || 193) / 255),
                        Math.min(1, (parseFloat(nums[2]) || 7) / 255)
                    );
                }
                return new THREE.Color(raw);
            } catch (e) {
                return new THREE.Color(fallback || '#ffc107');
            }
        };
        const ensure3DPreviewGroup = () => {
            if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return null;
            let group = window.__SMART_STICKER_3D_PREVIEW_GROUP__;
            if (!group) {
                group = new THREE.Group();
                group.name = 'SmartSticker3DPreview';
                group.renderOrder = 10000;
                window.__SMART_STICKER_3D_PREVIEW_GROUP__ = group;
            }
            if (!group.parent) scene.add(group);
            return group;
        };
        const tryHook2D = () => {
            if (typeof renderGeometry2D !== 'function') return false;
            if (renderGeometry2D.__smartStickerWrapped) return true;
            const orig = renderGeometry2D;
            function drawPreview() {
                const pv = window.__SMART_STICKER_PREVIEW__;
                const rotGroup = document.getElementById('geo-rotation-group');
                if (!rotGroup) return;
                rotGroup.querySelectorAll('.ss-preview').forEach(el => el.remove());
                if (!pv || !pv.enabled) return;
                const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
                const invScale = 1 / cz;
                const dash = `${8 * invScale},${6 * invScale}`;
                (pv.lines || []).forEach((ln) => {
                    const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
                    el.setAttribute('x1', ln.a.x);
                    el.setAttribute('y1', ln.a.y);
                    el.setAttribute('x2', ln.b.x);
                    el.setAttribute('y2', ln.b.y);
                    el.setAttribute('class', 'ss-preview');
                    el.style.stroke = ln.color || 'rgba(0,255,255,0.95)';
                    el.style.strokeWidth = ((ln.w || 2.5) * invScale) + 'px';
                    el.style.strokeLinecap = 'round';
                    el.style.strokeDasharray = ln.dash ? dash : 'none';
                    el.style.opacity = (ln.opacity != null) ? ln.opacity : 1;
                    el.style.pointerEvents = 'none';
                    rotGroup.appendChild(el);
                });
                (pv.points || []).forEach((p) => {
                    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                    c.setAttribute('cx', p.x);
                    c.setAttribute('cy', p.y);
                    c.setAttribute('r', (p.r || 4.5) * invScale);
                    c.setAttribute('class', 'ss-preview');
                    c.style.fill = p.fill || 'rgba(0,255,255,0.95)';
                    c.style.stroke = p.stroke || '#000';
                    c.style.strokeWidth = (2 * invScale) + 'px';
                    c.style.pointerEvents = 'none';
                    rotGroup.appendChild(c);
                });
            }
            window.renderGeometry2D = function () {
                const r = orig.apply(this, arguments);
                try { drawPreview(); } catch (e) {}
                return r;
            };
            window.renderGeometry2D.__smartStickerWrapped = true;
            return true;
        };
        const tryHook3D = () => {
            if (typeof renderGeometry3D !== 'function') return false;
            if (renderGeometry3D.__smartStickerWrapped) return true;
            const orig = renderGeometry3D;
            function drawPreview3D() {
                clear3DPreview();
                const pv = window.__SMART_STICKER_PREVIEW__;
                if (!pv || !pv.enabled) return;
                if (typeof THREE === 'undefined' || typeof getVector3 !== 'function') return;
                const group = ensure3DPreviewGroup();
                if (!group) return;
                const lineMatCache = new Map();
                const getLineMat = (ln) => {
                    const key = `${ln.color || ''}|${ln.dash ? 1 : 0}`;
                    if (lineMatCache.has(key)) return lineMatCache.get(key);
                    const mat = new THREE.LineBasicMaterial({
                        color: colorFromPreview(ln.color, ln.dash ? '#ffffff' : '#ffc107'),
                        transparent: true,
                        opacity: ln.opacity != null ? ln.opacity : 0.95,
                        depthTest: false
                    });
                    lineMatCache.set(key, mat);
                    return mat;
                };
                (pv.lines || []).forEach(ln => {
                    if (!ln?.a || !ln?.b) return;
                    const geo = new THREE.BufferGeometry().setFromPoints([getVector3(ln.a), getVector3(ln.b)]);
                    const line = new THREE.Line(geo, getLineMat(ln));
                    line.renderOrder = 10001;
                    group.add(line);
                });
                const pts = [];
                (pv.points || []).forEach(p => {
                    if (!p) return;
                    const v = getVector3(p);
                    pts.push(v.x, v.y, v.z);
                });
                if (pts.length) {
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
                    const mat = new THREE.PointsMaterial({
                        color: colorFromPreview(pv.points?.[0]?.fill, '#ffc107'),
                        size: 11,
                        sizeAttenuation: false,
                        transparent: true,
                        opacity: 0.98,
                        depthTest: false
                    });
                    const mesh = new THREE.Points(geo, mat);
                    mesh.renderOrder = 10002;
                    group.add(mesh);
                }
            }
            window.renderGeometry3D = function () {
                const r = orig.apply(this, arguments);
                try { drawPreview3D(); } catch (e) {}
                return r;
            };
            window.renderGeometry3D.__smartStickerWrapped = true;
            return true;
        };
        tryHook2D();
        tryHook3D();
        window.addEventListener('load', () => {
            tryHook2D();
            tryHook3D();
        });
    }
    function request2DRender() {
        if (typeof requestGeoRender === 'function') {
            requestGeoRender();
            return;
        }
        if (typeof renderGeometry2D === 'function') renderGeometry2D();
    }
    function request3DRender() {
        if (typeof window !== 'undefined' && !window.enable3D) return;
        if (typeof renderGeometry3D === 'function') renderGeometry3D();
    }
    // ----------------------------- 
    // SmartStickers core
    // ----------------------------- 
    const SmartStickers = {
        defs: new Map(),
        activeId: null,
        isPlacing: false,
        hover: null,
        __hoverRAF: 0,
        __pendingHoverEvt: null,
        __lastHoverEvt: null,
        __typesReady: false,
        collapsed: false,
        register(def) {
            if (!def || !def.id) return;
            this.defs.set(def.id, def);
            if (document.getElementById('smart-sticker-bar')) this._rebuildBar();
        },
        getActiveDef() {
            return this.activeId ? this.defs.get(this.activeId) : null;
        },
        setActive(id) {
            if (!id || !this.defs.has(id)) return;
            if (this.activeId === id && this.isPlacing) {
                this.exitPlacement();
                return;
            }
            this.activeId = id;
            this.enterPlacement();
        },
        enterPlacement() {
            const def = this.getActiveDef();
            if (!def) return;
            try {
                if (typeof interactState !== 'undefined') interactState = STICKER_INTERACT_STATE;
            } catch (e) {}
            this.isPlacing = true;
            this.hover = null;
            this.__typesReady = false;
            this._syncUI();
            this._showGhost(!def.hideGhost);
            this._setPreview({ enabled: false });
            installRenderOverlayHookOnce();
            if (typeof def.onEnter === 'function') def.onEnter(this);
            this._refreshPreviewFromLastHover(def);
        },
        exitPlacement() {
            const def = this.getActiveDef();
            if (def && typeof def.onExit === 'function') def.onExit(this);
            this.isPlacing = false;
            this.hover = null;
            this.__typesReady = false;
            try {
                if (typeof interactState !== 'undefined' && interactState === STICKER_INTERACT_STATE)
                    interactState = 'IDLE';
            } catch (e) {}
            this._syncUI();
            this._showGhost(false);
            this._setPreview({ enabled: false });
            request2DRender();
        },
        toggleCollapse() {
            this.collapsed = !this.collapsed;
            this._updateCollapseState();
        },
        _updateCollapseState() {
            const strip = document.getElementById('ss-strip');
            const toggleBtn = document.getElementById('ss-toggle-btn');
            if (!strip || !toggleBtn) return;
            
            if (this.collapsed) {
                strip.style.display = 'none';
                toggleBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
                toggleBtn.title = 'Show Smart Stickers';
            } else {
                strip.style.display = 'flex';
                toggleBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
                toggleBtn.title = 'Hide Smart Stickers';
            }
        },
        _syncUI() {
            const bar = document.getElementById('smart-sticker-bar');
            if (bar) {
                bar.querySelectorAll('.ss-tile').forEach((el) => {
                    const id = el.dataset.id;
                    el.classList.toggle('active', (id === this.activeId) && this.isPlacing);
                });
            }
            const lbl = document.getElementById('modeLabel');
            if (lbl) {
                if (this.isPlacing) {
                    lbl.textContent = 'STICKER';
                    lbl.style.backgroundColor = '';
                    lbl.style.color = 'var(--primary)';
                    lbl.style.padding = '';
                    lbl.style.borderRadius = '';
                } else {
                    const sm = (typeof selectionMode !== 'undefined' && selectionMode) ? selectionMode : 'POINT';
                    lbl.textContent = `${sm} MODE`;
                    lbl.style.backgroundColor = '';
                    lbl.style.color = '';
                    lbl.style.padding = '';
                    lbl.style.borderRadius = '';
                }
            }
            const vp = document.getElementById('viewport');
            if (vp) vp.style.cursor = (this.isPlacing ? 'crosshair' : 'default');
        },
        _showGhost(on) {
            const ghost = document.getElementById('smart-sticker-ghost');
            if (ghost) ghost.style.display = on ? 'block' : 'none';
        },
        _moveGhost(clientX, clientY) {
            const ghost = document.getElementById('smart-sticker-ghost');
            const vp = document.getElementById('viewport');
            if (!ghost || !vp) return;
            const r = vp.getBoundingClientRect();
            ghost.style.left = (clientX - r.left) + 'px';
            ghost.style.top = (clientY - r.top) + 'px';
        },
        _setPreview(pv) {
            window.__SMART_STICKER_PREVIEW__ = pv || { enabled: false };
            request2DRender();
            request3DRender();
        },
        _scheduleHover(def, evt) {
            this.__pendingHoverEvt = evt;
            this.__lastHoverEvt = evt;
            if (this.__hoverRAF) return;
            this.__hoverRAF = requestAnimationFrame(() => {
                this.__hoverRAF = 0;
                if (!this.isPlacing) return;
                const e = this.__pendingHoverEvt;
                this.__pendingHoverEvt = null;
                if (!e) return;
                if (def && typeof def.onHover === 'function') def.onHover(this, e);
            });
        },
        _refreshPreviewFromLastHover(def = this.getActiveDef()) {
            const evt = this.__lastHoverEvt;
            if (!this.isPlacing || !evt || !def || typeof def.onHover !== 'function') return false;
            requestAnimationFrame(() => {
                if (!this.isPlacing || this.getActiveDef() !== def) return;
                def.onHover(this, evt);
            });
            return true;
        },
        _installStrictInputCapture() {
            if (window.__smartStickerCaptureInstalled) return;
            window.__smartStickerCaptureInstalled = true;
            const vp = document.getElementById('viewport');
            if (!vp) return;
            window.addEventListener('keydown', (e) => {
                if (!this.isPlacing) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.exitPlacement();
                    return;
                }
                if ((e.key || '').toLowerCase() === 'r') {
                    const def = this.getActiveDef();
                    if (def && typeof def.onRotate === 'function') {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        def.onRotate(this, e);
                    }
                }
            }, true);
            vp.addEventListener('dblclick', (e) => {
                if (!this.isPlacing) return;
                window.__SMART_STICKER_SUPPRESS_DBLCLICK_UNTIL = Date.now() + 700;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const def = this.getActiveDef();
                if (def && typeof def.onDoubleClick === 'function') def.onDoubleClick(this, e);
            }, true);
            vp.addEventListener('mousemove', (e) => {
                if (!this.isPlacing) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this._moveGhost(e.clientX, e.clientY);
                const def = this.getActiveDef();
                this._scheduleHover(def, e);
            }, true);
            vp.addEventListener('mousedown', (e) => {
                if (!this.isPlacing) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const def = this.getActiveDef();
                if (e.button === 2) {
                    if (def && typeof def.onRightClick === 'function') def.onRightClick(this, e);
                    return;
                }
                if (e.button !== 0) return;
                if ((e.detail || 0) >= 2) {
                    window.__SMART_STICKER_SUPPRESS_DBLCLICK_UNTIL = Date.now() + 700;
                }
                if (def && typeof def.onClick === 'function') def.onClick(this, e);
            }, true);
            vp.addEventListener('mouseup', (e) => {
                if (!this.isPlacing) return;
                if (e.button !== 0 && e.button !== 2) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, true);
            vp.addEventListener('contextmenu', (e) => {
                if (!this.isPlacing) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, true);
        },
        _rebuildBar() {
            const strip = document.getElementById('ss-strip');
            if (!strip) return;
            strip.innerHTML = '';
            Array.from(this.defs.values()).forEach((def) => {
                const tile = document.createElement('div');
                tile.className = 'ss-tile';
                tile.dataset.id = def.id;
                tile.title = def.tooltip || def.label || def.id;
                tile.innerHTML = `${def.icon || ''}<div class="ss-name">${escapeHtml(def.shortLabel || def.label || def.id)}</div>`;
                tile.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                tile.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.setActive(def.id);
                });
                strip.appendChild(tile);
            });
            this._syncUI();
        },
        _ensureUI() {
            if (document.getElementById('smart-sticker-bar')) return;
            const vp = document.getElementById('viewport');
            const tab = document.getElementById('tab-view2d');
            const host = tab || vp || document.body;
            if (!host) return;
            if (tab && getComputedStyle(tab).position === 'static') tab.style.position = 'relative';
            if (vp && getComputedStyle(vp).position === 'static') vp.style.position = 'relative';
            if (!document.getElementById('smart-stickers-style')) {
                const st = document.createElement('style');
                st.id = 'smart-stickers-style';
                st.textContent = `
#smart-sticker-bar {
    position: absolute;
    right: 0;
    bottom: 0;
    height: 60px;
    z-index: 2600;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    box-sizing: border-box;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.1);
    width: auto;
}

#smart-sticker-bar .ss-strip {
    display: flex;
    align-items: center;
    gap: 8px;
}

.ss-tile {
    width: 52px;
    height: 44px;
    flex: 0 0 auto;
    border-radius: 4px;
    border: 1px solid #ddd;
    background: white;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: all 0.15s ease;
    user-select: none;
}

.ss-tile:hover {
    background: #f8f9fa;
    border-color: #ccc;
    transform: translateY(-1px);
}

.ss-tile.active {
    border-color: var(--primary);
    background: #fff5f5;
}

.ss-tile .ss-name {
    font-size: 9px;
    font-weight: 700;
    color: #5f6368;
    text-align: center;
    max-width: 50px;
    line-height: 1.1;
}

.ss-tile svg {
    width: 20px;
    height: 20px;
    color: #5f6368;
}

.ss-tile.active svg {
    color: var(--primary);
}

#ss-toggle-btn {
    width: 36px;
    height: 44px;
    border: 1px solid #ddd;
    background: white;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: #5f6368;
    transition: all 0.15s ease;
    flex-shrink: 0;
}

#ss-toggle-btn:hover {
    background: #f8f9fa;
    border-color: var(--primary);
    color: var(--primary);
}

#smart-sticker-ghost {
    position: absolute;
    z-index: 2550;
    pointer-events: none;
    width: 42px;
    height: 42px;
    transform: translate(-50%, -50%);
    display: none;
}

#smart-sticker-ghost .ring {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    border: 2px solid rgba(0, 255, 255, 0.95);
    box-shadow: 0 0 0 6px rgba(0, 255, 255, 0.10);
}

#smart-sticker-ghost .dot {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 6px;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
}
`;
                document.head.appendChild(st);
            }
            const bar = document.createElement('div');
            bar.id = 'smart-sticker-bar';
            bar.innerHTML = `
<div class="ss-strip" id="ss-strip"></div>
<button id="ss-toggle-btn" onclick="SmartStickers.toggleCollapse()" title="Hide Smart Stickers">
    <i class="fas fa-chevron-right"></i>
</button>`;
            host.appendChild(bar);
            if (!document.getElementById('smart-sticker-ghost')) {
                const ghost = document.createElement('div');
                ghost.id = 'smart-sticker-ghost';
                ghost.innerHTML = `<div class="ring"></div><div class="dot"></div>`;
                (vp || host).appendChild(ghost);
            }
            this._installStrictInputCapture();
            this._rebuildBar();
            this._syncUI();
            installRenderOverlayHookOnce();
        }
    };
    window.SmartStickers = SmartStickers;
    // ----------------------------- 
    // Junction types enum
    // ----------------------------- 
    const JunctionType = {
        EAVE_RAKE: 'eave_rake',
        RAKE_VALLEY: 'rake_valley',
        RAKE_VALLEY_EAVE: 'rake_valley_eave'
    };
    // ----------------------------- 
    // Find junction at cursor (supports all three types)
    // ----------------------------- 
    function findJunctionAtCursor(clientX, clientY) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return null;
        if (typeof screenToImage !== 'function') return null;
        const img = screenToImage(clientX, clientY);
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const sRad = sr / cz;
        let best = null;
        let bestD = sRad;
        const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
        for (const p of activeGeometry.points) {
            const l = p.layer || 1;
            if (vis[l] === false) continue;
            const d = Math.hypot(p.x - img.x, p.y - img.y);
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }
        if (!best) return null;
        const layer = best.layer || 1;
        const conns = activeGeometry.connections.filter(c => {
            if (!c || !c.start || !c.end) return false;
            const l = c.start.layer || 1;
            if (l !== layer) return false;
            if (vis[l] === false) return false;
            return (c.start === best || c.end === best);
        });
        // Find connections by type
        let eaveConn = null;
        let rakeConn = null;
        let valleyConn = null;
        for (const c of conns) {
            if (c.type === 'eave' && !eaveConn) eaveConn = c;
            if (c.type === 'rake' && !rakeConn) rakeConn = c;
            if (c.type === 'valley' && !valleyConn) valleyConn = c;
        }
        // Determine junction type and return appropriate info
        const getOther = (conn, corner) => (conn.start === corner) ? conn.end : conn.start;
        // Priority 1: Eave + Rake (original behavior)
        if (eaveConn && rakeConn && !valleyConn) {
            return {
                type: JunctionType.EAVE_RAKE,
                corner: best,
                eaveConn,
                rakeConn,
                valleyConn: null,
                eOther: getOther(eaveConn, best),
                rOther: getOther(rakeConn, best),
                vOther: null
            };
        }
        // Priority 2: Rake + Valley + Eave
        if (rakeConn && valleyConn && eaveConn) {
            return {
                type: JunctionType.RAKE_VALLEY_EAVE,
                corner: best,
                eaveConn,
                rakeConn,
                valleyConn,
                eOther: getOther(eaveConn, best),
                rOther: getOther(rakeConn, best),
                vOther: getOther(valleyConn, best)
            };
        }
        // Priority 3: Rake + Valley (no eave)
        if (rakeConn && valleyConn && !eaveConn) {
            return {
                type: JunctionType.RAKE_VALLEY,
                corner: best,
                eaveConn: null,
                rakeConn,
                valleyConn,
                eOther: null,
                rOther: getOther(rakeConn, best),
                vOther: getOther(valleyConn, best)
            };
        }
        return null;
    }
    // ----------------------------- 
    // Corner dependency checks
    // ----------------------------- 
    function cornerHasNonEaveRakeConn(corner, eaveConn, rakeConn, valleyConn) {
        if (!activeGeometry || !activeGeometry.connections) return true;
        for (const c of activeGeometry.connections) {
            if (!c || !c.start || !c.end) continue;
            if (c === eaveConn || c === rakeConn || c === valleyConn) continue;
            if (c.start === corner || c.end === corner) return true;
        }
        return false;
    }
    function cornerUsedInManualFaces(corner) {
        const mf = activeGeometry?.manualFaces;
        if (!mf || !Array.isArray(mf) || !mf.length) return false;
        for (const face of mf) {
            if (!face) continue;
            if (Array.isArray(face.points) && face.points.includes(corner)) return true;
            if (Array.isArray(face.holes)) {
                for (const h of face.holes) {
                    if (Array.isArray(h) && h.includes(corner)) return true;
                }
            }
        }
        return false;
    }
    // ----------------------------- 
    // Geometry builder for all junction types
    // ----------------------------- 
    function corniceBasisFromHit(hit) {
        const { corner, rOther, vOther, eOther, type: junctionType } = hit;
        const rDir = norm({ x: rOther.x - corner.x, y: rOther.y - corner.y });
        const downRDir = { x: -rDir.x, y: -rDir.y };
        let eDirOut = null;
        let eDirToward = null;
        if (junctionType === JunctionType.EAVE_RAKE) {
            eDirToward = norm({ x: eOther.x - corner.x, y: eOther.y - corner.y });
            eDirOut = { x: -eDirToward.x, y: -eDirToward.y };
        } else if (junctionType === JunctionType.RAKE_VALLEY || junctionType === JunctionType.RAKE_VALLEY_EAVE) {
            const valleyDir = norm({ x: vOther.x - corner.x, y: vOther.y - corner.y });
            const perpA = rot90(rDir, 1);
            const perpB = rot90(rDir, -1);
            eDirOut = (dot2(perpA, valleyDir) < 0) ? perpA : perpB;
            eDirToward = { x: -eDirOut.x, y: -eDirOut.y };
        }
        return { rDir, downRDir, eDirOut, eDirToward };
    }

    function computeCorniceUnderlayerGeometry(hit, style) {
        let px12 = inchesToPx(12);
        let px24 = inchesToPx(24);
        if (!(px12 > 0)) px12 = 20;
        if (!(px24 > 0)) px24 = 45;
        const { corner, rOther, type: junctionType } = hit;
        const basis = corniceBasisFromHit(hit);
        if (!basis || !basis.rDir || !basis.eDirToward) return null;
        const frontLen = Math.min(px24, Math.max(1, dist(corner, rOther) * 0.65));
        if (!(frontLen > 1)) return null;
        const perpA = rot90(basis.rDir, 1);
        const perpB = rot90(basis.rDir, -1);
        const insetDir = dot2(perpA, basis.eDirToward) >= dot2(perpB, basis.eDirToward) ? perpA : perpB;
        const P1 = moveFrom(corner, basis.rDir, frontLen);
        const P2 = moveFrom(P1, insetDir, px12);
        const P3 = moveFrom(P2, basis.downRDir, px12);
        const returnPath = [corner, P1, P2, P3, corner];
        return {
            style,
            variant: 'underlayer',
            junctionType,
            useR: 0,
            useE: 0,
            P_e_ext: corner,
            P_r_pb: corner,
            P1,
            P2,
            P3,
            returnPath,
            underlayerFrontPoint: P1,
            underlayerInsetPoint: P2,
            underlayerBackPoint: P3,
            underlayerFrontLen: frontLen,
            underlayerBackLen: px12,
            underlayerInsetDir: insetDir,
            underlayerDownDir: basis.downRDir,
            diagonalHip: { a: P3, b: corner },
            extraHip: (style === 'hipped') ? { a: P3, b: P1 } : null,
            syntheticEaveBase: null
        };
    }

    function computeCorniceGeometry(hit, style, variant = 'standard') {
        if (variant === 'underlayer') return computeCorniceUnderlayerGeometry(hit, style);
        // Required distances:
        // eave extension = 6"
        // rake pullback = 12"
        // leg3 = 18" (12 + 6)
        // leg4 = 12" (soffit) (hipped only)
        let px6 = inchesToPx(6);
        let px12 = inchesToPx(12);
        let px18 = inchesToPx(18);
        let px24 = inchesToPx(24);
        let px36 = inchesToPx(36);
        // fallbacks if meters/px not available
        if (!(px6 > 0)) px6 = 10;
        if (!(px12 > 0)) px12 = 20;
        if (!(px18 > 0)) px18 = 30;
        if (!(px24 > 0)) px24 = 45;
        if (!(px36 > 0)) px36 = 60;
        const { corner, rOther, vOther, eOther, type: junctionType } = hit;
        // Rake direction (points from corner toward rOther, i.e., up the rake toward peak)
        const rDir = norm({ x: rOther.x - corner.x, y: rOther.y - corner.y });
        // Down-rake direction (opposite, toward where an eave would be)
        const downRDir = { x: -rDir.x, y: -rDir.y };
        let P_e_ext;      // The "eave extension" point where cornice starts
        let eDirOut;      // Direction from corner outward along eave (or synthetic eave direction)
        let turnSign;     // For determining rotation direction
        if (junctionType === JunctionType.EAVE_RAKE) {
            // Original behavior: eave + rake junction
            const eDirToward = norm({ x: eOther.x - corner.x, y: eOther.y - corner.y });
            eDirOut = { x: -eDirToward.x, y: -eDirToward.y };
            const eLen = dist(corner, eOther);
            const useE = Math.min(px6, eLen * 0.45);
            if (!(useE > 1)) return null;
            P_e_ext = moveFrom(corner, eDirOut, useE); // 6" past eave
            turnSign = (cross2(eDirOut, rDir) < 0) ? -1 : +1;
        } else if (junctionType === JunctionType.RAKE_VALLEY || junctionType === JunctionType.RAKE_VALLEY_EAVE) {
            // New behavior: rake + valley (with or without eave)
            // 1. Extend rake downward 12" in XY plane
            // 2. Then 6" perpendicular away from valley
            const valleyDir = norm({ x: vOther.x - corner.x, y: vOther.y - corner.y });
            // Point where rake extended downward 12" (in XY)
            const P_rake_extended = moveFrom(corner, downRDir, px12);
            // Two possible perpendiculars to the rake
            const perpA = rot90(rDir, 1);
            const perpB = rot90(rDir, -1);
            // Choose the one pointing away from valley (negative dot product with valleyDir)
            const dotA = dot2(perpA, valleyDir);
            const perpAway = (dotA < 0) ? perpA : perpB;
            // Synthetic eave point: 12" down rake, then 6" perpendicular away from valley
            P_e_ext = moveFrom(P_rake_extended, perpAway, px6);
            // For the cornice algorithm, eDirOut should be perpendicular away from valley
            eDirOut = perpAway;
            // Turn sign: determine based on the relationship between eDirOut and rDir
            turnSign = (cross2(eDirOut, rDir) < 0) ? -1 : +1;
        } else {
            return null;
        }
        // Determine the endpoint for the cornice path
        let P_r_pb;   // The point where the cornice path ends (connects back to rake area)
        let useR = 0;
        const rLen = dist(corner, rOther);
        if (junctionType === JunctionType.EAVE_RAKE) {
            // Original behavior: pull back the rake point 12"
            useR = Math.min(px12, rLen * 0.45);
            if (!(useR > 1)) return null;
            P_r_pb = moveFrom(corner, rDir, useR);
        } else {
            // Rake+Valley variants: DO NOT move rake point
            // The cornice path ends at the original corner point
            P_r_pb = { x: corner.x, y: corner.y };  // Use corner as endpoint
            useR = 0;  // No pullback
        }
        // Build the cornice path
        // Path: P_e_ext -> (perpendicular 24") -> (parallel 12") -> (perpendicular 12" for hipped) -> endpoint
        const dir1 = rot90(eDirOut, turnSign);
        const P1 = moveFrom(P_e_ext, dir1, px24);
        const dir2 = rot90(dir1, turnSign);
        const P2 = moveFrom(P1, dir2, px12);
        let returnPath;
        if (style === 'hipped') {
            const dir3 = rot90(dir2, turnSign);
            const P3 = moveFrom(P2, dir3, px12);
            returnPath = [P_e_ext, P1, P2, P3, P_r_pb];
        } else {
            returnPath = [P_e_ext, P1, P2, P_r_pb];
        }
        // Hips:
        // - For EAVE_RAKE: diagonal hip from P_e_ext to P_r_pb, plus extra hip (P1 to P_r_pb) for hipped style
        // - For valley variants: NO diagonal hip (valley makes it unnecessary), but keep extra hip for hipped style
        const diagonalHip = (junctionType === JunctionType.EAVE_RAKE) ? { a: P_e_ext, b: P_r_pb } : null;
        const extraHip = (style === 'hipped') ? { a: P1, b: P_r_pb } : null;
        return {
            style,
            junctionType,
            useR,
            useE: (junctionType === JunctionType.EAVE_RAKE) ? Math.min(px6, dist(corner, eOther) * 0.45) : px6,
            P_e_ext,
            P_r_pb,
            P1,
            P2,
            P3: (style === 'hipped') ? returnPath[3] : null,
            returnPath,
            diagonalHip,
            extraHip,
            // For rake+valley junctions, store the synthetic eave base point
            syntheticEaveBase: (junctionType !== JunctionType.EAVE_RAKE) ? moveFrom(corner, downRDir, px12) : null
        };
    }
    function cornicePreviewZResolver(hit, geo) {
        const keyOf = (p) => `${Math.round((p?.x || 0) * 1000)}|${Math.round((p?.y || 0) * 1000)}`;
        const zByKey = new Map();
        const setZ = (pt, z) => {
            if (!pt || !Number.isFinite(Number(z))) return;
            zByKey.set(keyOf(pt), Number(z));
        };
        const Ze = getPointZ(hit.corner);
        const ZrOther = getPointZ(hit.rOther);
        const rakeLen = dist(hit.corner, hit.rOther) || 1;
        setZ(hit.corner, Ze);
        setZ(hit.rOther, ZrOther);
        if (hit.eOther) setZ(hit.eOther, getPointZ(hit.eOther));
        if (hit.vOther) setZ(hit.vOther, getPointZ(hit.vOther));

        if (geo?.variant === 'underlayer') {
            const rDir = norm({ x: hit.rOther.x - hit.corner.x, y: hit.rOther.y - hit.corner.y });
            const run = dot2({ x: geo.P3.x - hit.corner.x, y: geo.P3.y - hit.corner.y }, rDir);
            const raisedRun = Math.max(0, Math.min(rakeLen, run));
            const raisedZ = Ze + (ZrOther - Ze) * (raisedRun / rakeLen);
            setZ(geo.P1, Ze);
            setZ(geo.P2, geo.style === 'unhipped' ? raisedZ : Ze);
            setZ(geo.P3, raisedZ);
        } else {
            let effectiveEaveZ = Ze;
            let effectiveRakeZ = Ze;
            if (geo.junctionType === JunctionType.EAVE_RAKE) {
                const pulledLen = Math.min((geo.useR ?? rakeLen), rakeLen);
                effectiveRakeZ = Ze + (ZrOther - Ze) * (pulledLen / rakeLen);
            } else {
                const vOther = hit.vOther;
                const ZvOther = getPointZ(vOther);
                const valleyLen = dist(hit.corner, vOther) || 1;
                const valleyDir = norm({ x: vOther.x - hit.corner.x, y: vOther.y - hit.corner.y });
                const rDir = norm({ x: hit.rOther.x - hit.corner.x, y: hit.rOther.y - hit.corner.y });
                const crossVal = Math.abs(cross2(valleyDir, rDir));
                const px6 = inchesToPx(6) || 10;
                if (crossVal > 0.001) {
                    const s = -px6 / crossVal;
                    effectiveEaveZ = Ze + (s / valleyLen) * (ZvOther - Ze);
                } else {
                    const px12 = inchesToPx(12) || 20;
                    const slopePerPx = (ZrOther - Ze) / rakeLen;
                    effectiveEaveZ = Ze - slopePerPx * px12;
                }
                effectiveRakeZ = Ze;
            }
            setZ(geo.P_e_ext, effectiveEaveZ);
            setZ(geo.P_r_pb, effectiveRakeZ);
            const pathPts = geo.returnPath || [];
            const lastInteriorIdx = pathPts.length - 2;
            for (let i = 1; i < pathPts.length - 1; i++) {
                let z;
                if (geo.style === 'hipped') z = (i === lastInteriorIdx) ? effectiveRakeZ : effectiveEaveZ;
                else z = (i === lastInteriorIdx) ? (effectiveEaveZ + 2 * (effectiveRakeZ - effectiveEaveZ)) : effectiveEaveZ;
                setZ(pathPts[i], z);
            }
            if (geo.syntheticEaveBase) setZ(geo.syntheticEaveBase, effectiveEaveZ);
        }
        return (pt) => {
            if (!pt) return pt;
            const z = zByKey.has(keyOf(pt)) ? zByKey.get(keyOf(pt)) : getPointZ(pt);
            return { x: pt.x, y: pt.y, z };
        };
    }

    function buildPreview(hit, geo) {
        const previewPoint = cornicePreviewZResolver(hit, geo);
        const lines = [];
        const points = [
            { ...previewPoint(hit.corner), r: 4.5 },
            { ...previewPoint(geo.P_e_ext), r: 4.5 },
        ];
        if (geo.variant === 'underlayer') {
            if (geo.P1) points.push({ ...previewPoint(geo.P1), r: 4.5 });
            if (geo.P2) points.push({ ...previewPoint(geo.P2), r: 4.5 });
            if (geo.P3) points.push({ ...previewPoint(geo.P3), r: 4.5 });
        }
        // Only add P_r_pb as a separate point if it's different from corner (eave+rake case)
        if (geo.useR > 0) {
            points.push({ ...previewPoint(geo.P_r_pb), r: 4.5 });
        }
        // Main hip diagonal (solid) - only for eave+rake junctions
        if (geo.diagonalHip) {
            lines.push({ a: previewPoint(geo.diagonalHip.a), b: previewPoint(geo.diagonalHip.b), w: 3.0, dash: false });
        }
        // Extra hip (hipped only)
        if (geo.extraHip) {
            lines.push({ a: previewPoint(geo.extraHip.a), b: previewPoint(geo.extraHip.b), w: 3.0, dash: false, opacity: 0.95 });
            points.push({ ...previewPoint(geo.P1), r: 4.5 });
        }
        // Return path (dashed)
        for (let i = 0; i < geo.returnPath.length - 1; i++) {
            lines.push({
                a: previewPoint(geo.returnPath[i]),
                b: previewPoint(geo.returnPath[i + 1]),
                w: 2.5,
                dash: true,
                opacity: 0.95
            });
        }
        // Faint hints on originals
        if (hit.eOther) {
            lines.push({
                a: previewPoint(hit.corner),
                b: previewPoint(hit.eOther),
                w: 2.0,
                dash: true,
                opacity: 0.22
            });
        }
        lines.push({
            a: previewPoint(hit.corner),
            b: previewPoint(hit.rOther),
            w: 2.0,
            dash: true,
            opacity: 0.22
        });
        if (hit.vOther) {
            lines.push({
                a: previewPoint(hit.corner),
                b: previewPoint(hit.vOther),
                w: 2.0,
                dash: true,
                opacity: 0.22,
                color: 'rgba(255,165,0,0.5)'  // Orange tint for valley
            });
        }
        // Show synthetic eave line for rake+valley junctions
        if (geo.syntheticEaveBase) {
            lines.push({
                a: previewPoint(geo.syntheticEaveBase),
                b: previewPoint(geo.P_e_ext),
                w: 2.0,
                dash: true,
                opacity: 0.6,
                color: 'rgba(0,255,128,0.8)'  // Green for synthetic eave direction
            });
            points.push({ ...previewPoint(geo.syntheticEaveBase), r: 3.5, fill: 'rgba(0,255,128,0.8)' });
        }
        return { enabled: true, lines, points };
    }
    // ----------------------------- 
    // Cleanup collinear floating points along a line
    // ----------------------------- 
    function cleanupCollinearFloatingPoints(startPoint, startConn) {
        if (!activeGeometry || !activeGeometry.connections || !activeGeometry.points) return;
        
        // Collect ALL points along the eave chain in BOTH directions, including startPoint
        const pointsToCheck = [];
        const visited = new Set();
        const maxWalk = 50; // Safety limit
        
        // Helper: walk a chain from a point in a given direction (following a specific connection)
        function walkChain(fromPoint, viaConn) {
            let currentConn = viaConn;
            let currentPoint = (viaConn.start === fromPoint) ? viaConn.end : viaConn.start;
            let walkCount = 0;
            
            while (currentPoint && walkCount < maxWalk) {
                if (visited.has(currentPoint)) break;
                visited.add(currentPoint);
                pointsToCheck.push(currentPoint);
                
                // Find all connections at currentPoint
                const connsAtPoint = activeGeometry.connections.filter(c => 
                    c && (c.start === currentPoint || c.end === currentPoint)
                );
                
                // If more than 2 connections, this is a real junction - stop walking this direction
                if (connsAtPoint.length !== 2) break;
                
                // Find the other connection (not the one we came from)
                const otherConn = connsAtPoint.find(c => c !== currentConn);
                if (!otherConn) break;
                
                // Get the next point
                const nextPoint = (otherConn.start === currentPoint) ? otherConn.end : otherConn.start;
                if (!nextPoint) break;
                
                currentConn = otherConn;
                currentPoint = nextPoint;
                walkCount++;
            }
        }
        
        // Add startPoint itself to the check list
        visited.add(startPoint);
        pointsToCheck.push(startPoint);
        
        // Walk along the eave connection (the direction we know about)
        walkChain(startPoint, startConn);
        
        // Also walk in ANY other direction from startPoint (in case there are other collinear connections)
        const connsAtStart = activeGeometry.connections.filter(c => 
            c && (c.start === startPoint || c.end === startPoint)
        );
        for (const conn of connsAtStart) {
            if (conn === startConn) continue; // Already walked this direction
            const otherEnd = (conn.start === startPoint) ? conn.end : conn.start;
            if (!visited.has(otherEnd)) {
                walkChain(startPoint, conn);
            }
        }
        
        // Now iteratively check each collected point to see if it's floating
        // A point is floating if it has exactly 2 connections that are collinear with each other
        let mergeCount = 0;
        let madeChange = true;
        
        while (madeChange && mergeCount < maxWalk) {
            madeChange = false;
            
            for (let i = 0; i < pointsToCheck.length; i++) {
                const pt = pointsToCheck[i];
                if (!pt) continue;
                
                // Check if this point still exists in geometry
                if (!activeGeometry.points.includes(pt)) {
                    pointsToCheck[i] = null;
                    continue;
                }
                
                // Find all connections at this point
                const connsAtPt = activeGeometry.connections.filter(c => 
                    c && (c.start === pt || c.end === pt)
                );
                
                // If not exactly 2 connections, not a floating point
                if (connsAtPt.length !== 2) continue;
                
                const conn1 = connsAtPt[0];
                const conn2 = connsAtPt[1];
                
                // Get the other endpoints
                const other1 = (conn1.start === pt) ? conn1.end : conn1.start;
                const other2 = (conn2.start === pt) ? conn2.end : conn2.start;
                
                if (!other1 || !other2 || other1 === other2) continue;
                
                // Check if the two directions are collinear
                const dir1 = norm({ x: other1.x - pt.x, y: other1.y - pt.y });
                const dir2 = norm({ x: other2.x - pt.x, y: other2.y - pt.y });
                
                // For collinearity, directions should be opposite (dot product ~ -1)
                // because one goes toward other1 and one goes toward other2
                const dotProduct = dot2(dir1, dir2);
                
                // If not collinear (dot product should be ~-1 for opposite directions on same line)
                if (dotProduct > -0.9999) continue;
                
                // This point is floating - remove it
                // Update conn1 to connect other1 directly to other2
                if (conn1.start === pt) {
                    conn1.start = other2;
                } else {
                    conn1.end = other2;
                }
                
                // Remove conn2
                const conn2Idx = activeGeometry.connections.indexOf(conn2);
                if (conn2Idx >= 0) {
                    activeGeometry.connections.splice(conn2Idx, 1);
                }
                
                // Remove the floating point
                const ptIdx = activeGeometry.points.indexOf(pt);
                if (ptIdx >= 0) {
                    activeGeometry.points.splice(ptIdx, 1);
                }
                
                // Also remove from selectedPoints if present
                try {
                    if (typeof selectedPoints !== 'undefined' && selectedPoints.has(pt)) {
                        selectedPoints.delete(pt);
                    }
                } catch (e) {}
                
                pointsToCheck[i] = null;
                mergeCount++;
                madeChange = true;
            }
        }
        
        return mergeCount;
    }
    // ----------------------------- 
    // Commit (handles all junction types)
    // ----------------------------- 
    function commitCorniceUnderlayer(hit, geo) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return false;
        const { corner, rakeConn, rOther } = hit;
        if (!corner || !rOther || !geo?.P1 || !geo?.P2 || !geo?.P3) return false;
        if (typeof save2DState === 'function') save2DState();
        const layer = corner.layer || 1;
        const Ze = getPointZ(corner);
        const ZrOther = getPointZ(rOther);
        const rakeLen = dist(corner, rOther) || 1;
        const projectAlongRake = (pt) => {
            const rDir = norm({ x: rOther.x - corner.x, y: rOther.y - corner.y });
            return dot2({ x: pt.x - corner.x, y: pt.y - corner.y }, rDir);
        };
        const raisedRun = Math.max(0, Math.min(rakeLen, projectAlongRake(geo.P3)));
        const raisedZ = Ze + (ZrOther - Ze) * (raisedRun / rakeLen);
        const baseZ = Ze;
        const p1Z = baseZ;
        const p2Z = geo.style === 'unhipped' ? raisedZ : baseZ;
        const p3Z = raisedZ;
        const mkPoint = (pt, z) => ({ x: pt.x, y: pt.y, z, layer, zLocked: true });
        const p1 = mkPoint(geo.P1, p1Z);
        const p2 = mkPoint(geo.P2, p2Z);
        const p3 = mkPoint(geo.P3, p3Z);
        activeGeometry.points.push(p1, p2, p3);
        if (rakeConn) rakeConn.type = 'rake';
        const addConnIfValid = (a, b, type) => {
            if (!a || !b || a === b) return;
            activeGeometry.connections.push({ start: a, end: b, type: type || null });
        };
        addConnIfValid(corner, p1, null);
        addConnIfValid(p1, p2, null);
        addConnIfValid(p2, p3, null);
        addConnIfValid(p3, corner, 'hip');
        if (geo.style === 'hipped') addConnIfValid(p3, p1, 'hip');
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                [corner, p1, p2, p3].forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }

    function commitCornice(hit, geo) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return false;
        if (geo?.variant === 'underlayer') return commitCorniceUnderlayer(hit, geo);
        const { corner, eaveConn, rakeConn, valleyConn, rOther, type: junctionType } = hit;
        const layer = corner.layer || 1;
        if (!geo || !Array.isArray(geo.returnPath) || geo.returnPath.length < 2) {
            console.warn("[Cornice] geo.returnPath missing/too short");
            return false;
        }
        if (!geo.P_e_ext || !geo.P_r_pb) {
            console.warn("[Cornice] geo.P_e_ext / geo.P_r_pb missing");
            return false;
        }
        if (typeof save2DState === 'function') save2DState();
        // ---------- Height setup ----------
        const Ze = getPointZ(corner);
        const ZrOther = getPointZ(rOther);
        const rakeLen = dist(corner, rOther) || 1;
        // Calculate effective heights based on junction type
        // For eave+rake: eave height = Ze, rake height = interpolated along rake
        // For valley variants: eave height = calculated by extending valley line to 6" past rake
        let effectiveEaveZ;   // Height for synthetic eave point and early path points
        let effectiveRakeZ;   // Height for endpoint and late path points
        if (junctionType === JunctionType.EAVE_RAKE) {
            effectiveEaveZ = Ze;
            const pulledLen = Math.min((geo.useR ?? rakeLen), rakeLen);
            const t = pulledLen / rakeLen;
            effectiveRakeZ = Ze + (ZrOther - Ze) * t;  // Interpolated along rake
        } else {
            // Valley variants: calculate height by extending valley line
            // Find the point on the extended valley where perpendicular distance to rake = 6"
            // Then use the valley's slope to get Z at that point
            
            const vOther = hit.vOther;
            const ZvOther = getPointZ(vOther);
            const valleyLen = dist(corner, vOther) || 1;
            
            const valleyDir = norm({ x: vOther.x - corner.x, y: vOther.y - corner.y });
            const rDir = norm({ x: rOther.x - corner.x, y: rOther.y - corner.y });
            
            // Cross product gives perpendicular distance per unit length along valley
            const crossVal = Math.abs(cross2(valleyDir, rDir));
            
            const px6 = inchesToPx(6) || 10;
            
            if (crossVal > 0.001) {
                // Distance along valley (from corner) where perpendicular distance to rake = 6"
                // Negative because we're extending opposite to vOther (toward where eave would be)
                const s = -px6 / crossVal;
                
                // Z at that point on the extended valley line
                // Valley slope: (ZvOther - Ze) per valleyLen pixels
                effectiveEaveZ = Ze + (s / valleyLen) * (ZvOther - Ze);
            } else {
                // Valley and rake are nearly parallel - fall back to simple slope extension
                const px12 = inchesToPx(12) || 20;
                const slopePerPx = (ZrOther - Ze) / rakeLen;
                effectiveEaveZ = Ze - slopePerPx * px12;
            }
            
            effectiveRakeZ = Ze;  // Corner height (endpoint)
        }
        const effectiveDZ = effectiveRakeZ - effectiveEaveZ;
        const mkPoint = (pt, z) => ({ x: pt.x, y: pt.y, z, layer, zLocked: true });
        const keyOf = (p) => `${Math.round(p.x * 1000)}|${Math.round(p.y * 1000)}`;
        let pEext = null;
        if (junctionType === JunctionType.EAVE_RAKE) {
            // ---------- Original behavior: Decide whether to MOVE corner to P_e_ext ----------
            const hasOtherConn = cornerHasNonEaveRakeConn(corner, eaveConn, rakeConn, null);
            const usedByManual = cornerUsedInManualFaces(corner);
            if (!hasOtherConn && !usedByManual) {
                corner.x = geo.P_e_ext.x;
                corner.y = geo.P_e_ext.y;
                corner.z = effectiveEaveZ;
                corner.zLocked = true;
                pEext = corner;
            } else {
                pEext = { x: geo.P_e_ext.x, y: geo.P_e_ext.y, z: effectiveEaveZ, layer, zLocked: true };
                activeGeometry.points.push(pEext);
                if (eaveConn.start === corner) eaveConn.start = pEext;
                else if (eaveConn.end === corner) eaveConn.end = pEext;
            }
        } else if (junctionType === JunctionType.RAKE_VALLEY) {
            // ---------- Rake + Valley (no eave): Don't move corner, create synthetic eave point ----------
            // Corner stays unmoved, still connected to rake and valley
            pEext = { x: geo.P_e_ext.x, y: geo.P_e_ext.y, z: effectiveEaveZ, layer, zLocked: true };
            activeGeometry.points.push(pEext);
            // Corner stays unmoved - no rake pullback, no eave to reroute
        } else if (junctionType === JunctionType.RAKE_VALLEY_EAVE) {
            // ---------- Rake + Valley + Eave: Same as rake+valley, but also reroute eave ----------
            // Corner stays unmoved (still connected to rake and valley)
            pEext = { x: geo.P_e_ext.x, y: geo.P_e_ext.y, z: effectiveEaveZ, layer, zLocked: true };
            activeGeometry.points.push(pEext);
            // Reroute the eave connection to the new synthetic point
            if (eaveConn) {
                if (eaveConn.start === corner) eaveConn.start = pEext;
                else if (eaveConn.end === corner) eaveConn.end = pEext;
                eaveConn.type = 'eave';
            }
            
            // Corner stays unmoved - no rake pullback
        }
        // ---------- Handle rake connection based on junction type ----------
        let pRpb;  // The endpoint of the cornice path
        
        if (junctionType === JunctionType.EAVE_RAKE) {
            // Original behavior: Create pulled-back rake point and reroute rakeConn
            pRpb = { x: geo.P_r_pb.x, y: geo.P_r_pb.y, z: effectiveRakeZ, layer, zLocked: true };
            activeGeometry.points.push(pRpb);
            if (rakeConn.start === corner) rakeConn.start = pRpb;
            else if (rakeConn.end === corner) rakeConn.end = pRpb;
        } else {
            // Valley variants: endpoint is the original corner, no rake modification
            pRpb = corner;
        }
        if (eaveConn) eaveConn.type = 'eave';
        rakeConn.type = 'rake';
        // ---------- Materialize EXACT returnPath ----------
        const pathPts = geo.returnPath;
        const n = pathPts.length;
        const objs = new Array(n);
        objs[0] = pEext;
        objs[n - 1] = pRpb;
        const style = geo.style || 'hipped';
        const lastInteriorIdx = n - 2;
        for (let i = 1; i < n - 1; i++) {
            let z;
            if (style === 'hipped') {
                // HIPPED: early points at eave height, last interior point at rake height
                z = (i === lastInteriorIdx) ? effectiveRakeZ : effectiveEaveZ;
            } else {
                // UNHIPPED: early points at eave height, last interior at peak (2x delta above eave)
                z = (i === lastInteriorIdx) ? (effectiveEaveZ + 2 * effectiveDZ) : effectiveEaveZ;
            }
            const np = mkPoint(pathPts[i], z);
            activeGeometry.points.push(np);
            objs[i] = np;
        }
        // ---------- Coord->Obj map for hips ----------
        const objByKey = new Map();
        for (let i = 0; i < n; i++) objByKey.set(keyOf(objs[i]), objs[i]);
        objByKey.set(keyOf(geo.P_e_ext), pEext);
        objByKey.set(keyOf(geo.P_r_pb), pRpb);
        const getObjForCoord = (pt) => objByKey.get(keyOf(pt)) || null;
        // ---------- Add hips exactly as computeCorniceGeometry defines ----------
        const addConnIfValid = (a, b, type) => {
            if (!a || !b || a === b) return;
            activeGeometry.connections.push({ start: a, end: b, type: type || null });
        };
        if (geo.diagonalHip?.a && geo.diagonalHip?.b) {
            addConnIfValid(getObjForCoord(geo.diagonalHip.a), getObjForCoord(geo.diagonalHip.b), 'hip');
        }
        if (geo.extraHip?.a && geo.extraHip?.b) {
            addConnIfValid(getObjForCoord(geo.extraHip.a), getObjForCoord(geo.extraHip.b), 'hip');
        }
        // ---------- Add the path segments ----------
        for (let i = 0; i < n - 1; i++) addConnIfValid(objs[i], objs[i + 1], null);
        // ---------- Cleanup collinear floating points for RAKE_VALLEY_EAVE ----------
        // After creating the cornice, check if the rerouted eave is collinear with
        // subsequent eave segments. If intermediate points only serve to connect
        // collinear segments, remove them and merge into one line.
        if (junctionType === JunctionType.RAKE_VALLEY_EAVE && eaveConn) {
            cleanupCollinearFloatingPoints(pEext, eaveConn);
        }
        // ---------- Selection ----------
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                objs.forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        // ---------- Refresh ----------
        try {
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    // -----------------------------
    // Roof-face feature stickers (skylights, chimneys, protrusions)
    // -----------------------------
    function pointInPolyLocal(x, y, poly) {
        if (typeof isPointInPolyMeasurement === 'function') return isPointInPolyMeasurement(x, y, poly);
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }
    function pointOnSegment2D(p, a, b, eps = 0.01) {
        const abx = b.x - a.x, aby = b.y - a.y;
        const apx = p.x - a.x, apy = p.y - a.y;
        const len2 = abx * abx + aby * aby;
        if (len2 < eps * eps) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;
        const t = (apx * abx + apy * aby) / len2;
        if (t < -eps || t > 1 + eps) return false;
        const qx = a.x + abx * t, qy = a.y + aby * t;
        return Math.hypot(p.x - qx, p.y - qy) <= eps;
    }
    function pointOnPolygonBoundary2D(p, poly, eps = 0.01) {
        for (let i = 0; i < poly.length; i++) {
            if (pointOnSegment2D(p, poly[i], poly[(i + 1) % poly.length], eps)) return true;
        }
        return false;
    }
    function pointStrictlyInsidePoly2D(p, poly) {
        return pointInPolyLocal(p.x, p.y, poly) && !pointOnPolygonBoundary2D(p, poly, 0.05);
    }
    function pointInsideOrOnPoly2D(p, poly) {
        return pointInPolyLocal(p.x, p.y, poly) || pointOnPolygonBoundary2D(p, poly, 0.05);
    }
    function projectPointToSegment2D(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) return { x: a.x, y: a.y, t: 0, d: Math.hypot(p.x - a.x, p.y - a.y) };
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const x = a.x + dx * t;
        const y = a.y + dy * t;
        return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
    }
    function faceContainsXY(face, x, y) {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
        const pt = { x, y };
        if (!pointInPolyLocal(x, y, face.points) && !pointOnPolygonBoundary2D(pt, face.points, 0.05)) return false;
        if (Array.isArray(face.holes)) {
            for (const hole of face.holes) {
                if (
                    Array.isArray(hole) &&
                    hole.length >= 3 &&
                    pointInPolyLocal(x, y, hole) &&
                    !pointOnPolygonBoundary2D(pt, hole, 0.05)
                ) return false;
            }
        }
        return true;
    }
    function getStickerFaces() {
        let faces = [];
        try {
            if (Array.isArray(window.lastResolvedFacesCache) && window.lastResolvedFacesCache.length) {
                faces = window.lastResolvedFacesCache;
            }
        } catch (e) {}
        if (!faces.length && typeof renderFinalPass === 'function') {
            try { renderFinalPass(false); } catch (e) {}
            try {
                if (Array.isArray(window.lastResolvedFacesCache) && window.lastResolvedFacesCache.length) {
                    faces = window.lastResolvedFacesCache;
                }
            } catch (e) {}
        }
        if (!faces.length && typeof facesGroup !== 'undefined' && facesGroup && facesGroup.children) {
            faces = facesGroup.children
                .filter(m => m && m.userData && m.userData.faceDef)
                .map(m => m.userData.faceDef);
        }
        return faces || [];
    }
    function getFacePlaneSafe(face) {
        if (!face) return null;
        if (face.plane && Number.isFinite(face.plane.a) && Number.isFinite(face.plane.b) && Number.isFinite(face.plane.c)) {
            return face.plane;
        }
        try {
            if (typeof calculatePlaneFromVertices === 'function') {
                face.plane = calculatePlaneFromVertices(face.points || face);
                return face.plane;
            }
        } catch (e) {}
        return null;
    }
    function topFaceHitAtXY(x, y, faces) {
        const hits = [];
        for (const face of (faces || [])) {
            if (!faceContainsXY(face, x, y)) continue;
            const plane = getFacePlaneSafe(face);
            if (!plane) continue;
            const z = plane.a * x + plane.b * y + plane.c;
            if (!Number.isFinite(z)) continue;
            hits.push({ face, plane, z });
        }
        if (!hits.length) return null;
        hits.sort((a, b) => b.z - a.z);
        return hits[0];
    }
    function faceHitFromFaceAtXY(face, x, y) {
        const plane = getFacePlaneSafe(face);
        if (!face || !plane) return null;
        const z = plane.a * x + plane.b * y + plane.c;
        return Number.isFinite(z) ? { face, plane, z } : null;
    }
    function getDormerPeakHit(peakXY, faces, peakSnap, fallbackFace = null) {
        if (fallbackFace) {
            const hit = faceHitFromFaceAtXY(fallbackFace, peakXY.x, peakXY.y);
            if (hit) return hit;
        }
        const raw = peakSnap?.rawXY || null;
        if (raw) {
            const rawHit = topFaceHitAtXY(raw.x, raw.y, faces);
            if (rawHit) return faceHitFromFaceAtXY(rawHit.face, peakXY.x, peakXY.y) || rawHit;
            const dx = raw.x - peakXY.x;
            const dy = raw.y - peakXY.y;
            const len = Math.hypot(dx, dy);
            if (len > 1e-6) {
                const sample = { x: peakXY.x + dx / len * 1.5, y: peakXY.y + dy / len * 1.5 };
                const sampleHit = topFaceHitAtXY(sample.x, sample.y, faces);
                if (sampleHit) return faceHitFromFaceAtXY(sampleHit.face, peakXY.x, peakXY.y) || sampleHit;
            }
        }
        return topFaceHitAtXY(peakXY.x, peakXY.y, faces);
    }
    function getDormerPeakSnap(clientX, clientY) {
        const raw = screenToImage(clientX, clientY);
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        if (!snappingOn || !activeGeometry || !Array.isArray(activeGeometry.connections)) {
            if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
            return { xy: raw, snap: null };
        }
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const sRad = sr / cz;
        const exclude = new Set();
        if (typeof getClosestPoint === 'function') {
            const pt = getClosestPoint(raw.x, raw.y, sRad, exclude);
            if (pt) {
                if (typeof showSnapIndicator === 'function') showSnapIndicator(pt);
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
                return { xy: { x: pt.x, y: pt.y }, snap: { kind: 'point', point: pt, rawXY: raw } };
            }
        }
        if (typeof showCenterpoints !== 'undefined' && showCenterpoints && typeof getClosestMidpoint === 'function') {
            const mid = getClosestMidpoint(raw.x, raw.y, sRad, exclude);
            if (mid) {
                if (typeof showSnapIndicator === 'function') showSnapIndicator(mid);
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
                return { xy: { x: mid.x, y: mid.y }, snap: { kind: 'line', conn: mid.conn, t: 0.5, rawXY: raw } };
            }
        }
        if (typeof getComplexSnap === 'function') {
            const guide = getComplexSnap(raw.x, raw.y, sRad, exclude);
            if (guide) {
                if (typeof showSnapIndicator === 'function') showSnapIndicator(guide);
                return { xy: { x: guide.x, y: guide.y }, snap: { kind: 'guide', rawXY: raw } };
            }
        }
        let best = null;
        let bestD = sRad;
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            if (typeof layerVisibility !== 'undefined' && layerVisibility[conn.start.layer || 1] === false) return;
            const proj = projectPointToSegment2D(raw, conn.start, conn.end);
            if (proj.t <= 0.03 || proj.t >= 0.97) return;
            if (proj.d < bestD) {
                bestD = proj.d;
                best = { x: proj.x, y: proj.y, conn, t: proj.t };
            }
        });
        if (best) {
            if (typeof showSnapIndicator === 'function') showSnapIndicator(best);
            if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
            return { xy: { x: best.x, y: best.y }, snap: { kind: 'line', conn: best.conn, t: best.t, rawXY: raw } };
        }
        if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
        const snapInd = document.getElementById('snap-indicator');
        if (snapInd) snapInd.style.display = 'none';
        return { xy: raw, snap: null };
    }
    function getFeatureUpDir(face, plane) {
        if (plane) {
            const slope = Math.hypot(plane.a || 0, plane.b || 0);
            const mpp = getMetersPerPxSafe();
            const pitch = (mpp > 0)
                ? 12 * Math.tan(Math.atan(slope / mpp))
                : slope;
            if (pitch >= 0.3) return { x: plane.a / slope, y: plane.b / slope };
        }
        if (face && Array.isArray(face.points) && face.points.length >= 2) {
            let best = null, bestLen = 0;
            for (let i = 0; i < face.points.length; i++) {
                const a = face.points[i], b = face.points[(i + 1) % face.points.length];
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                if (len > bestLen) {
                    bestLen = len;
                    best = { x: b.x - a.x, y: b.y - a.y };
                }
            }
            if (best && bestLen > 0) return norm(rot90(norm(best), 1));
        }
        return { x: 0, y: -1 };
    }
    function getFeatureEdgeTypes(kind) {
        if (kind === 'chimney') {
            return ['chimney_back', 'chimney_edge', 'chimney_front', 'chimney_edge'];
        }
        if (kind === 'protrusion') return ['protrusion', 'protrusion', 'protrusion', 'protrusion'];
        return ['skylight', 'skylight', 'skylight', 'skylight'];
    }
    const ROOF_FEATURE_LINE_TYPES = new Set(['skylight', 'protrusion', 'chimney_back', 'chimney_edge', 'chimney_front']);
    function unlockRoofFeaturePointHeight(point) {
        if (!point) return false;
        let changed = false;
        if (point.zLocked) {
            point.zLocked = false;
            changed = true;
        }
        if (point._lockedPlanes) {
            delete point._lockedPlanes;
            changed = true;
        }
        return changed;
    }
    function unlockRoofFeaturePointHeights(geometry) {
        const geo = geometry || activeGeometry;
        if (!geo || !Array.isArray(geo.connections)) return 0;
        let changed = 0;
        geo.connections.forEach(conn => {
            const type = String(conn?.type || '').toLowerCase();
            if (!ROOF_FEATURE_LINE_TYPES.has(type)) return;
            if (unlockRoofFeaturePointHeight(conn.start)) changed++;
            if (unlockRoofFeaturePointHeight(conn.end)) changed++;
        });
        return changed;
    }
    window.unlockRoofFeaturePointHeights = unlockRoofFeaturePointHeights;
    function getVisibleEdgeLengths(featureEdgeRanges) {
        const lengths = [0, 0, 0, 0];
        (featureEdgeRanges || []).forEach(seg => {
            if (!seg || !Number.isInteger(seg.edgeIdx)) return;
            lengths[seg.edgeIdx] += Math.max(0, Math.min(1, seg.t1) - Math.max(0, seg.t0));
        });
        return lengths;
    }
    function assignChimneyEdgeTypes(featureEdgeRanges, rectCorners = null, roofUp = null, faces = null) {
        const edgeTypes = ['chimney_edge', 'chimney_edge', 'chimney_edge', 'chimney_edge'];
        const up = roofUp ? norm(roofUp) : null;
        const center = rectCorners && rectCorners.length
            ? rectCorners.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
            : null;
        if (center && rectCorners.length) {
            center.x /= rectCorners.length;
            center.y /= rectCorners.length;
        }
        const classifyFlatSeg = (seg) => {
            if (!center || !seg?.a || !seg?.b) return 'chimney_edge';
            let localUp = up;
            const plane = seg.plane || seg.face?.plane || null;
            const slope = plane ? Math.hypot(plane.a || 0, plane.b || 0) : 0;
            if (slope > 1e-8) localUp = { x: (plane.a || 0) / slope, y: (plane.b || 0) / slope };
            if (!localUp) return 'chimney_edge';
            const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
            const awayFromHole = norm({ x: mid.x - center.x, y: mid.y - center.y });
            const outsideIsUpslope = dot2(awayFromHole, localUp) > 0.02;
            if (!outsideIsUpslope) return 'chimney_front';
            const sampleDist = Math.max(1.5, getUserSnapTolerancePx() * 0.35);
            const outsideSample = {
                x: mid.x + awayFromHole.x * sampleDist,
                y: mid.y + awayFromHole.y * sampleDist
            };
            const outsideHit = topFaceHitAtXY(outsideSample.x, outsideSample.y, faces || getStickerFaces());
            const hasUpslopeRoofBehind = !!outsideHit?.face && outsideHit.face !== seg.face;
            return hasUpslopeRoofBehind || outsideHit?.face === seg.face
                ? 'chimney_back'
                : 'chimney_front';
        };
        for (let edgeIdx = 0; edgeIdx < 4; edgeIdx++) {
            const segs = featureEdgeRanges.filter(seg => seg && seg.edgeIdx === edgeIdx);
            if (!segs.length) continue;
            const flatVotes = { chimney_back: 0, chimney_front: 0, chimney_edge: 0 };
            let hasSloped = false;
            const mpp = getMetersPerPxSafe() || 1;
            segs.forEach(seg => {
                const len = dist(seg.a, seg.b);
                const dz = Math.abs((Number.isFinite(seg.a?.z) ? seg.a.z : 0) - (Number.isFinite(seg.b?.z) ? seg.b.z : 0));
                const isSloped = len > 0.05 && Math.atan2(dz, Math.max(1e-9, len * mpp)) * (180 / Math.PI) >= 10;
                if (isSloped) {
                    hasSloped = true;
                    return;
                }
                const t = classifyFlatSeg(seg);
                flatVotes[t] = (flatVotes[t] || 0) + Math.max(0.001, len);
            });
            if (hasSloped) {
                edgeTypes[edgeIdx] = 'chimney_edge';
            } else {
                edgeTypes[edgeIdx] = flatVotes.chimney_back >= flatVotes.chimney_front
                    ? 'chimney_back'
                    : 'chimney_front';
            }
        }
        featureEdgeRanges.forEach(seg => {
            const len = dist(seg.a, seg.b);
            const dz = Math.abs((Number.isFinite(seg.a?.z) ? seg.a.z : 0) - (Number.isFinite(seg.b?.z) ? seg.b.z : 0));
            const mpp = getMetersPerPxSafe() || 1;
            const isSloped = len > 0.05 && Math.atan2(dz, Math.max(1e-9, len * mpp)) * (180 / Math.PI) >= 10;
            seg.type = isSloped ? 'chimney_edge' : classifyFlatSeg(seg);
        });
        return edgeTypes;
    }
    function getFeatureColor(kind) {
        if (kind === 'chimney') return 'rgba(0,123,255,0.98)';
        if (kind === 'protrusion') return 'rgba(88,155,166,0.98)';
        return 'rgba(0,255,255,0.98)';
    }
    function getRoofFeatureSize(spec) {
        const options = Array.isArray(spec.sizeOptions) && spec.sizeOptions.length
            ? spec.sizeOptions
            : [{ widthFt: spec.widthFt, heightFt: spec.heightFt }];
        const idx = Number.isInteger(spec.sizeIndex) ? spec.sizeIndex : 0;
        return options[((idx % options.length) + options.length) % options.length] || options[0];
    }
    function getSurfaceLengthPx(feet, plane, dirUnit) {
        const mpp = getMetersPerPxSafe();
        if (!(mpp > 0)) return feetToPx(feet);
        const dzPerPx = plane
            ? ((plane.a || 0) * (dirUnit.x || 0) + (plane.b || 0) * (dirUnit.y || 0))
            : 0;
        const metersPerPxOnSurface = Math.hypot(mpp, dzPerPx);
        if (!(metersPerPxOnSurface > 0)) return feetToPx(feet);
        return feetToMeters(feet) / metersPerPxOnSurface;
    }
    function getFeatureDimensionPx(spec, feet, plane, dirUnit) {
        if (spec && spec.sizeMode === 'world') return feetToPx(feet);
        return getSurfaceLengthPx(feet, plane, dirUnit);
    }
    function formatFeatureSize(size) {
        const fmt = (v) => Number.isInteger(v) ? String(v) : String(v).replace(/\.0+$/, '');
        if (size && size.label) return size.label;
        return `${fmt(size.widthFt)}x${fmt(size.heightFt)}`;
    }
    function clonePlane(plane) {
        if (!plane || !Number.isFinite(plane.a) || !Number.isFinite(plane.b) || !Number.isFinite(plane.c)) return null;
        return { a: plane.a, b: plane.b, c: plane.c };
    }
    function lockPointToPlane(point, plane) {
        const p = clonePlane(plane);
        if (!point || !p) return;
        point._lockedPlanes = point._lockedPlanes || [];
        const key = `${p.a.toFixed(8)}|${p.b.toFixed(8)}|${p.c.toFixed(5)}`;
        const exists = point._lockedPlanes.some(lp =>
            `${(+lp.a).toFixed(8)}|${(+lp.b).toFixed(8)}|${(+lp.c).toFixed(5)}` === key
        );
        if (!exists) point._lockedPlanes.push(p);
    }
    function polyAreaAbs(poly) {
        if (!Array.isArray(poly) || poly.length < 3) return 0;
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i], q = poly[(i + 1) % poly.length];
            a += p.x * q.y - q.x * p.y;
        }
        return Math.abs(a) / 2;
    }
    function coordKey(p) {
        return `${Math.round(p.x * 1000)}|${Math.round(p.y * 1000)}`;
    }
    function getPolygonRings(face) {
        const rings = [];
        if (face && Array.isArray(face.points) && face.points.length >= 3) rings.push(face.points);
        if (face && Array.isArray(face.holes)) {
            face.holes.forEach(h => {
                if (Array.isArray(h) && h.length >= 3) rings.push(h);
            });
        }
        return rings;
    }
    function pointOnRectEdge(rectCorners, edgeIdx, t) {
        const a = rectCorners[edgeIdx];
        const b = rectCorners[(edgeIdx + 1) % rectCorners.length];
        return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t
        };
    }
    function dedupeSortedParams(params) {
        const sorted = params
            .filter(v => Number.isFinite(v))
            .map(v => Math.max(0, Math.min(1, v)))
            .sort((a, b) => a - b);
        const out = [];
        sorted.forEach(v => {
            if (!out.length || Math.abs(v - out[out.length - 1]) > 1e-5) out.push(v);
        });
        return out;
    }
    function getEdgeBoundaryParams(rectCorners, edgeIdx, faces) {
        const params = [0, 1];
        const a = rectCorners[edgeIdx];
        const b = rectCorners[(edgeIdx + 1) % rectCorners.length];
        (faces || []).forEach(face => {
            getPolygonRings(face).forEach(ring => {
                for (let i = 0; i < ring.length; i++) {
                    const hit = segmentIntersectionParam(a, b, ring[i], ring[(i + 1) % ring.length]);
                    if (hit) params.push(hit.t);
                }
            });
        });
        return dedupeSortedParams(params);
    }
    function computeRoofFeatureGeometry(clientX, clientY, spec) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return null;
        if (typeof screenToImage !== 'function') return null;
        const center = screenToImage(clientX, clientY);
        const faces = getStickerFaces();
        const centerHit = topFaceHitAtXY(center.x, center.y, faces);
        if (!centerHit) return null;
        const up = getFeatureUpDir(centerHit.face, centerHit.plane);
        const right = norm(rot90(up, -1));
        const size = getRoofFeatureSize(spec);
        const isRotated = !!(Number(spec.rotationQuarter || 0) % 2);
        const widthDir = isRotated ? up : right;
        const heightDir = isRotated ? right : up;
        const widthPx = getFeatureDimensionPx(spec, size.widthFt, centerHit.plane, widthDir);
        const heightPx = getFeatureDimensionPx(spec, size.heightFt, centerHit.plane, heightDir);
        const rawCorners = [
            {
                x: center.x + heightDir.x * heightPx / 2 - widthDir.x * widthPx / 2,
                y: center.y + heightDir.y * heightPx / 2 - widthDir.y * widthPx / 2
            },
            {
                x: center.x + heightDir.x * heightPx / 2 + widthDir.x * widthPx / 2,
                y: center.y + heightDir.y * heightPx / 2 + widthDir.y * widthPx / 2
            },
            {
                x: center.x - heightDir.x * heightPx / 2 + widthDir.x * widthPx / 2,
                y: center.y - heightDir.y * heightPx / 2 + widthDir.y * widthPx / 2
            },
            {
                x: center.x - heightDir.x * heightPx / 2 - widthDir.x * widthPx / 2,
                y: center.y - heightDir.y * heightPx / 2 - widthDir.y * widthPx / 2
            }
        ];
        const layer = parseInt(centerHit.face.layer || 1, 10);
        const featurePoints = [];
        const featurePointByKey = new Map();
        const featureEdgeRanges = [];
        const involvedLayers = new Set([layer]);
        const edgeTypes = getFeatureEdgeTypes(spec.kind);
        const getFeaturePoint = (edgeIdx, t, fallbackHit = null) => {
            const xy = pointOnRectEdge(rawCorners, edgeIdx, t);
            const hit = topFaceHitAtXY(xy.x, xy.y, faces) || fallbackHit;
            if (!hit) return null;
            const z = Number.isFinite(hit.z) ? hit.z : (hit.plane.a * xy.x + hit.plane.b * xy.y + hit.plane.c);
            const ptLayer = parseInt(hit.face.layer || layer, 10);
            const key = `${Math.round(xy.x * 1000)}|${Math.round(xy.y * 1000)}|${ptLayer}`;
            if (featurePointByKey.has(key)) return featurePointByKey.get(key);
            const point = { x: xy.x, y: xy.y, z, layer: ptLayer, zLocked: false };
            featurePointByKey.set(key, point);
            featurePoints.push(point);
            involvedLayers.add(ptLayer);
            return point;
        };
        for (let edgeIdx = 0; edgeIdx < 4; edgeIdx++) {
            const params = getEdgeBoundaryParams(rawCorners, edgeIdx, faces);
            for (let i = 0; i < params.length - 1; i++) {
                const t0 = params[i], t1 = params[i + 1];
                if (Math.abs(t1 - t0) < 1e-5) continue;
                const mid = pointOnRectEdge(rawCorners, edgeIdx, (t0 + t1) / 2);
                const midHit = topFaceHitAtXY(mid.x, mid.y, faces);
                if (!midHit) continue;
                const a = getFeaturePoint(edgeIdx, t0, midHit);
                const b = getFeaturePoint(edgeIdx, t1, midHit);
                if (!a || !b || a === b || Math.hypot(a.x - b.x, a.y - b.y) < 0.05) continue;
                involvedLayers.add(parseInt(midHit.face.layer || layer, 10));
                featureEdgeRanges.push({ edgeIdx, t0, t1, a, b, type: edgeTypes[edgeIdx], face: midHit.face || null, plane: midHit.plane || midHit.face?.plane || null });
            }
        }
        if (!featureEdgeRanges.length) return null;
        const finalEdgeTypes = spec.kind === 'chimney'
            ? assignChimneyEdgeTypes(featureEdgeRanges, rawCorners, up, faces)
            : edgeTypes;
        return {
            spec,
            size,
            center,
            centerHit,
            rectCorners: rawCorners,
            faces,
            featurePoints,
            featureEdgeRanges,
            edgeTypes: finalEdgeTypes,
            layer,
            involvedLayers,
            up: heightDir,
            right: widthDir,
            roofUp: up,
            roofRight: right,
            rotated: isRotated
        };
    }
    function buildRoofFeaturePreview(geo) {
        const color = getFeatureColor(geo.spec.kind);
        const lines = [];
        geo.featureEdgeRanges.forEach((seg) => {
            lines.push({
                a: seg.a,
                b: seg.b,
                w: 3,
                dash: false,
                color,
                opacity: 0.98
            });
        });
        lines.push({
            a: {
                x: geo.center.x - geo.up.x * feetToPx(0.4),
                y: geo.center.y - geo.up.y * feetToPx(0.4)
            },
            b: {
                x: geo.center.x + geo.up.x * feetToPx(0.4),
                y: geo.center.y + geo.up.y * feetToPx(0.4)
            },
            w: 2,
            dash: true,
            color: 'rgba(255,255,255,0.9)',
            opacity: 0.7
        });
        return {
            enabled: true,
            lines,
            points: [{ x: geo.center.x, y: geo.center.y, r: 3.5, fill: color, stroke: '#fff' }]
        };
    }
    function segmentIntersectionParam(a, b, c, d) {
        const r = { x: b.x - a.x, y: b.y - a.y };
        const s = { x: d.x - c.x, y: d.y - c.y };
        const denom = cross2(r, s);
        if (Math.abs(denom) < 1e-9) return null;
        const ca = { x: c.x - a.x, y: c.y - a.y };
        const t = cross2(ca, s) / denom;
        const u = cross2(ca, r) / denom;
        const eps = 1e-6;
        if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
        const tc = Math.max(0, Math.min(1, t));
        const uc = Math.max(0, Math.min(1, u));
        return {
            t: tc,
            u: uc,
            x: a.x + r.x * tc,
            y: a.y + r.y * tc
        };
    }
    function interpolateConnZ(conn, t) {
        const z1 = getPointZ(conn.start);
        const z2 = getPointZ(conn.end);
        return z1 + (z2 - z1) * t;
    }
    function makeEdgeBuckets(geo) {
        const buckets = [[], [], [], []];
        geo.featureEdgeRanges.forEach(seg => {
            buckets[seg.edgeIdx].push({ t: seg.t0, point: seg.a });
            buckets[seg.edgeIdx].push({ t: seg.t1, point: seg.b });
        });
        return buckets;
    }
    function addPointToEdgeBucket(bucket, t, point) {
        const eps = 1e-5;
        for (const entry of bucket) {
            if (Math.abs(entry.t - t) < eps || Math.hypot(entry.point.x - point.x, entry.point.y - point.y) < 0.05) {
                return entry.point;
            }
        }
        bucket.push({ t, point });
        return point;
    }
    function splitExistingLinesForFeature(geo, edgeBuckets) {
        const poly = geo.rectCorners;
        const originalConns = activeGeometry.connections.slice();
        const additions = [];
        const removals = new Set();
        const newPoints = [];
        const splitRecords = [];
        const paramOnConn = (pt, conn) => {
            const dx = conn.end.x - conn.start.x;
            const dy = conn.end.y - conn.start.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) return 0;
            return ((pt.x - conn.start.x) * dx + (pt.y - conn.start.y) * dy) / len2;
        };
        const segmentClearlyInsideFeature = (conn, t0, t1) => {
            const lo = Math.min(t0, t1);
            const hi = Math.max(t0, t1);
            if (hi - lo < 1e-5) return false;
            const samples = [0.25, 0.5, 0.75];
            return samples.every(frac => {
                const t = lo + (hi - lo) * frac;
                const p = {
                    x: conn.start.x + (conn.end.x - conn.start.x) * t,
                    y: conn.start.y + (conn.end.y - conn.start.y) * t
                };
                return pointStrictlyInsidePoly2D(p, poly);
            });
        };
        const ensurePointForParam = (conn, t, hit, rectEdgeIdx, rectU) => {
            if (t <= 1e-5) {
                if (geo.involvedLayers.has(parseInt(conn.start.layer || 1, 10))) addPointToEdgeBucket(edgeBuckets[rectEdgeIdx], rectU, conn.start);
                return conn.start;
            }
            if (t >= 1 - 1e-5) {
                if (geo.involvedLayers.has(parseInt(conn.end.layer || 1, 10))) addPointToEdgeBucket(edgeBuckets[rectEdgeIdx], rectU, conn.end);
                return conn.end;
            }
            const connLayer = parseInt(conn.start.layer || conn.end.layer || geo.layer, 10);
            const sharedWithSticker = geo.involvedLayers.has(connLayer);
            const point = {
                x: hit.x,
                y: hit.y,
                z: interpolateConnZ(conn, t),
                layer: connLayer,
                zLocked: false
            };
            if (sharedWithSticker) {
                const bucketPoint = addPointToEdgeBucket(edgeBuckets[rectEdgeIdx], rectU, point);
                splitRecords.push({ start: conn.start, end: conn.end, point: bucketPoint, t });
                if (bucketPoint !== point) return bucketPoint;
            }
            newPoints.push(point);
            splitRecords.push({ start: conn.start, end: conn.end, point, t });
            return point;
        };
        for (const conn of originalConns) {
            if (!conn || !conn.start || !conn.end) continue;
            const connLayer = parseInt(conn.start.layer || conn.end.layer || geo.layer, 10);
            if (!geo.involvedLayers.has(connLayer) && connLayer !== geo.layer) continue;
            const hits = [];
            for (let i = 0; i < 4; i++) {
                const hit = segmentIntersectionParam(conn.start, conn.end, poly[i], poly[(i + 1) % 4]);
                if (!hit) continue;
                if (hits.some(h => Math.abs(h.t - hit.t) < 1e-5)) continue;
                hits.push({ ...hit, rectEdgeIdx: i, rectU: hit.u });
            }
            for (let i = 0; i < 4; i++) {
                if (!pointOnSegment2D(poly[i], conn.start, conn.end, 0.05)) continue;
                const t = paramOnConn(poly[i], conn);
                if (t < -1e-5 || t > 1 + 1e-5) continue;
                if (hits.some(h => Math.abs(h.t - t) < 1e-5)) continue;
                hits.push({ t: Math.max(0, Math.min(1, t)), u: 0, x: poly[i].x, y: poly[i].y, rectEdgeIdx: i, rectU: 0 });
            }
            const startInside = pointInsideOrOnPoly2D(conn.start, poly);
            const endInside = pointInsideOrOnPoly2D(conn.end, poly);
            if (!hits.length) {
                const mid = { x: (conn.start.x + conn.end.x) / 2, y: (conn.start.y + conn.end.y) / 2 };
                if (startInside || endInside || pointInsideOrOnPoly2D(mid, poly)) removals.add(conn);
                continue;
            }
            hits.sort((a, b) => a.t - b.t);
            const params = [{ t: 0, point: conn.start }, ...hits.map(h => ({
                t: h.t,
                point: ensurePointForParam(conn, h.t, h, h.rectEdgeIdx, h.rectU)
            })), { t: 1, point: conn.end }];
            let changed = false;
            for (let i = 0; i < params.length - 1; i++) {
                const a = params[i], b = params[i + 1];
                if (Math.abs(b.t - a.t) < 1e-5 || a.point === b.point) continue;
                if (segmentClearlyInsideFeature(conn, a.t, b.t)) {
                    changed = true;
                    continue;
                }
                additions.push({ start: a.point, end: b.point, type: conn.type || null });
            }
            if (changed || params.length > 2) removals.add(conn);
        }
        if (newPoints.length) activeGeometry.points.push(...newPoints);
        if (removals.size) activeGeometry.connections = activeGeometry.connections.filter(c => !removals.has(c));
        additions.forEach(c => {
            if (c.start && c.end && c.start !== c.end) activeGeometry.connections.push(c);
        });
        geo._splitRecords = splitRecords;
    }
    function isFeatureEdgeIntervalVisible(geo, edgeIdx, t0, t1) {
        const mid = (t0 + t1) / 2;
        return geo.featureEdgeRanges.some(seg =>
            seg.edgeIdx === edgeIdx &&
            mid >= Math.min(seg.t0, seg.t1) - 1e-5 &&
            mid <= Math.max(seg.t0, seg.t1) + 1e-5
        );
    }
    function addFeatureLoopConnections(geo, edgeBuckets) {
        const chimneyTypeForInterval = (edgeIdx, t0, t1) => {
            const mid = (t0 + t1) / 2;
            const seg = (geo.featureEdgeRanges || []).find(r =>
                r && r.edgeIdx === edgeIdx &&
                mid >= Math.min(r.t0, r.t1) - 1e-5 &&
                mid <= Math.max(r.t0, r.t1) + 1e-5
            );
            return seg?.type || geo.edgeTypes?.[edgeIdx] || 'chimney_edge';
        };
        for (let i = 0; i < 4; i++) {
            const entries = edgeBuckets[i].slice().sort((a, b) => a.t - b.t);
            for (let j = 0; j < entries.length - 1; j++) {
                if (!isFeatureEdgeIntervalVisible(geo, i, entries[j].t, entries[j + 1].t)) continue;
                const a = entries[j].point;
                const b = entries[j + 1].point;
                if (!a || !b || a === b || Math.hypot(a.x - b.x, a.y - b.y) < 0.05) continue;
                const type = (geo.spec && geo.spec.kind === 'chimney')
                    ? chimneyTypeForInterval(i, entries[j].t, entries[j + 1].t)
                    : (geo.edgeTypes[i] || null);
                activeGeometry.connections.push({ start: a, end: b, type });
            }
        }
    }
    function insertSplitPointsIntoRing(ring, splitRecords) {
        if (!Array.isArray(ring) || ring.length < 2 || !Array.isArray(splitRecords) || !splitRecords.length) return ring;
        const out = [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            out.push(a);
            const inserts = splitRecords
                .filter(r =>
                    r && r.point &&
                    ((r.start === a && r.end === b) || (r.start === b && r.end === a)) &&
                    !ring.includes(r.point)
                )
                .map(r => ({
                    point: r.point,
                    t: (r.start === a && r.end === b) ? r.t : 1 - r.t
                }))
                .filter(r => r.t > 1e-5 && r.t < 1 - 1e-5)
                .sort((p, q) => p.t - q.t);
            inserts.forEach(item => {
                if (!out.includes(item.point)) out.push(item.point);
            });
        }
        return out;
    }
    function polygonIntersectionApprox(subjectPoly, clipPoly) {
        if (
            Array.isArray(subjectPoly) &&
            subjectPoly.length >= 3 &&
            subjectPoly.every(p => pointInsideOrOnPoly2D(p, clipPoly))
        ) {
            return subjectPoly.map(p => ({ x: p.x, y: p.y }));
        }
        const points = [];
        const add = (p) => {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
            if (points.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.05)) return;
            points.push({ x: p.x, y: p.y });
        };
        subjectPoly.forEach(p => { if (pointInsideOrOnPoly2D(p, clipPoly)) add(p); });
        clipPoly.forEach(p => { if (pointInsideOrOnPoly2D(p, subjectPoly)) add(p); });
        for (let i = 0; i < subjectPoly.length; i++) {
            const a = subjectPoly[i], b = subjectPoly[(i + 1) % subjectPoly.length];
            for (let j = 0; j < clipPoly.length; j++) {
                const c = clipPoly[j], d = clipPoly[(j + 1) % clipPoly.length];
                const hit = segmentIntersectionParam(a, b, c, d);
                if (hit) add(hit);
            }
        }
        if (points.length < 3) return [];
        let cx = 0, cy = 0;
        points.forEach(p => { cx += p.x; cy += p.y; });
        cx /= points.length;
        cy /= points.length;
        points.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
        return polyAreaAbs(points) > 0.5 ? points : [];
    }
    function findExistingPointNear(xy, layer) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points)) return null;
        let best = null;
        let bestD = 0.08;
        for (const p of activeGeometry.points) {
            if (!p) continue;
            if (layer && parseInt(p.layer || 1, 10) !== parseInt(layer, 10)) continue;
            const d = Math.hypot(p.x - xy.x, p.y - xy.y);
            if (d < bestD) {
                best = p;
                bestD = d;
            }
        }
        return best;
    }
    function materializeHolePoint(xy, face) {
        const layer = parseInt(face.layer || 1, 10);
        const existing = findExistingPointNear(xy, layer);
        if (existing) return existing;
        const plane = getFacePlaneSafe(face);
        const z = plane ? (plane.a * xy.x + plane.b * xy.y + plane.c) : getPointZ(xy);
        const p = { x: xy.x, y: xy.y, z, layer, zLocked: false };
        activeGeometry.points.push(p);
        return p;
    }
    function holeSignature(poly) {
        return poly.map(coordKey).sort().join('|');
    }
    function syncManualFacesForFeature(geo) {
        const manualFaces = activeGeometry && Array.isArray(activeGeometry.manualFaces) ? activeGeometry.manualFaces : [];
        if (!manualFaces.length) return;
        const splitRecords = geo._splitRecords || [];
        const rect = geo.rectCorners || [];
        manualFaces.forEach(mf => {
            if (!mf || !Array.isArray(mf.points) || mf.points.length < 3) return;
            mf.points = insertSplitPointsIntoRing(mf.points, splitRecords);
            if (Array.isArray(mf.holes)) {
                mf.holes = mf.holes.map(h => insertSplitPointsIntoRing(h, splitRecords));
            } else {
                mf.holes = [];
            }
            const holeXY = polygonIntersectionApprox(rect, mf.points);
            if (holeXY.length < 3) return;
            const faceArea = polyAreaAbs(mf.points);
            const holeArea = polyAreaAbs(holeXY);
            if (!(holeArea > 0.5) || (faceArea > 0 && holeArea > faceArea * 0.98)) return;
            const holePts = holeXY.map(p => materializeHolePoint(p, mf));
            const sig = holeSignature(holePts);
            const exists = mf.holes.some(h => holeSignature(h) === sig);
            if (!exists) mf.holes.push(holePts);
        });
    }
    function cleanupOrphanPointsInsideFeature(geo) {
        const protectedPoints = new Set(geo.featurePoints);
        if (activeGeometry && Array.isArray(activeGeometry.manualFaces)) {
            activeGeometry.manualFaces.forEach(mf => {
                if (Array.isArray(mf.points)) mf.points.forEach(p => protectedPoints.add(p));
                if (Array.isArray(mf.holes)) {
                    mf.holes.forEach(h => {
                        if (Array.isArray(h)) h.forEach(p => protectedPoints.add(p));
                    });
                }
            });
        }
        const connected = new Set();
        activeGeometry.connections.forEach(c => {
            if (c && c.start) connected.add(c.start);
            if (c && c.end) connected.add(c.end);
        });
        const removed = [];
        activeGeometry.points = activeGeometry.points.filter(p => {
            if (!p || protectedPoints.has(p) || connected.has(p)) return true;
            if (!pointStrictlyInsidePoly2D(p, geo.rectCorners)) return true;
            removed.push(p);
            return false;
        });
        if (removed.length && typeof selectedPoints !== 'undefined') {
            removed.forEach(p => selectedPoints.delete(p));
        }
    }
    function removeOldPointsInsideFeature(geo) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points)) return;
        const protectedPoints = new Set(geo.featurePoints || []);
        const shouldRemove = (p) => {
            if (!p || protectedPoints.has(p)) return false;
            return pointStrictlyInsidePoly2D(p, geo.rectCorners);
        };
        const pruneRing = (ring) => {
            if (!Array.isArray(ring)) return [];
            return ring.filter(p => !shouldRemove(p));
        };
        if (Array.isArray(activeGeometry.manualFaces)) {
            activeGeometry.manualFaces = activeGeometry.manualFaces
                .map(mf => {
                    if (!mf || !Array.isArray(mf.points)) return mf;
                    mf.points = pruneRing(mf.points);
                    mf.holes = Array.isArray(mf.holes)
                        ? mf.holes.map(pruneRing).filter(h => h.length >= 3)
                        : [];
                    return mf;
                })
                .filter(mf => mf && Array.isArray(mf.points) && mf.points.length >= 3);
        }
        if (Array.isArray(activeGeometry.connections)) {
            activeGeometry.connections = activeGeometry.connections.filter(c => {
                if (!c || !c.start || !c.end) return false;
                return !shouldRemove(c.start) && !shouldRemove(c.end);
            });
        }
        const removed = [];
        activeGeometry.points = activeGeometry.points.filter(p => {
            if (!shouldRemove(p)) return true;
            removed.push(p);
            return false;
        });
        if (removed.length) {
            try {
                if (typeof selectedPoints !== 'undefined') removed.forEach(p => selectedPoints.delete(p));
                if (typeof selectedLines !== 'undefined') {
                    for (const line of Array.from(selectedLines)) {
                        if (!line || removed.includes(line.start) || removed.includes(line.end)) selectedLines.delete(line);
                    }
                }
            } catch (e) {}
        }
    }
    function getPointOnFace(xy, hit, layerOverride = null) {
        const layer = parseInt(layerOverride || hit?.face?.layer || 1, 10);
        const plane = hit?.plane || getFacePlaneSafe(hit?.face);
        const z = plane ? (plane.a * xy.x + plane.b * xy.y + plane.c) : getPointZ(xy);
        const p = { x: xy.x, y: xy.y, z, layer, zLocked: true };
        if (plane) lockPointToPlane(p, plane);
        return p;
    }
    function getUserSnapTolerancePx() {
        const sr = (typeof snapRadius !== 'undefined' && Number.isFinite(snapRadius)) ? snapRadius : 20;
        const zoom = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        return Math.max(0.75, sr / zoom);
    }
    function getDormerPlacedShoulderPoint(geo) {
        if (!geo || !geo.points) return null;
        return (geo.sideSign || 1) >= 0 ? geo.points.rightShoulder : geo.points.leftShoulder;
    }
    function getDormerSnapPoints(geo) {
        if (!geo?.points) return [];
        return [geo.points.leftShoulder, geo.points.rightShoulder].filter(Boolean);
    }
    function getDormerCutCornerSnapTolerance(geo, corner) {
        if (!geo || !corner) return 0.05;
        if (getDormerSnapPoints(geo).includes(corner)) return getUserSnapTolerancePx();
        if (geo.openCut && (corner === geo.points?.cutLeftFront || corner === geo.points?.cutRightFront)) return getUserSnapTolerancePx();
        return 0.05;
    }
    function splitExistingLinesForCutPolygon(geoOrPoly, faces) {
        const geo = geoOrPoly && Array.isArray(geoOrPoly.cutPoly) ? geoOrPoly : null;
        const poly = geo ? geo.cutPoly : geoOrPoly;
        const originalConns = activeGeometry.connections.slice();
        const additions = [];
        const removals = new Set();
        const newPoints = [];
        const splitRecords = [];
        const snapTolerance = getUserSnapTolerancePx();
        const paramOnConn = (pt, conn) => {
            const dx = conn.end.x - conn.start.x;
            const dy = conn.end.y - conn.start.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) return 0;
            return ((pt.x - conn.start.x) * dx + (pt.y - conn.start.y) * dy) / len2;
        };
        const mkSplitPoint = (conn, hit) => {
            const connLayer = parseInt(conn.start.layer || conn.end.layer || 1, 10);
            const faceHit = topFaceHitAtXY(hit.x, hit.y, faces || getStickerFaces());
            const plane = faceHit?.plane || null;
            const point = {
                x: hit.x,
                y: hit.y,
                z: plane ? (plane.a * hit.x + plane.b * hit.y + plane.c) : interpolateConnZ(conn, hit.t),
                layer: connLayer,
                zLocked: true
            };
            if (plane) lockPointToPlane(point, plane);
            newPoints.push(point);
            splitRecords.push({ start: conn.start, end: conn.end, point, t: hit.t });
            return point;
        };
        const pointForHit = (conn, hit) => {
            if (hit.point) {
                if (!splitRecords.some(r => r.point === hit.point)) {
                    splitRecords.push({ start: conn.start, end: conn.end, point: hit.point, t: hit.t });
                }
                return hit.point;
            }
            return mkSplitPoint(conn, hit);
        };
        const addHit = (hits, hit, conn) => {
            const near = hits.find(h => Math.hypot((h.x || 0) - hit.x, (h.y || 0) - hit.y) <= snapTolerance);
            if (near) {
                if (hit.point && !near.point) {
                    near.point = hit.point;
                    near.x = hit.point.x;
                    near.y = hit.point.y;
                    near.t = paramOnConn(hit.point, conn);
                }
                return false;
            }
            hits.push(hit);
            return true;
        };
        for (const conn of originalConns) {
            if (!conn || !conn.start || !conn.end) continue;
            const hits = [];
            for (let i = 0; i < poly.length; i++) {
                const hit = segmentIntersectionParam(conn.start, conn.end, poly[i], poly[(i + 1) % poly.length]);
                if (!hit) continue;
                addHit(hits, hit, conn);
            }
            for (const corner of poly) {
                const cornerTolerance = getDormerCutCornerSnapTolerance(geo, corner);
                if (!pointOnSegment2D(corner, conn.start, conn.end, cornerTolerance)) continue;
                const t = paramOnConn(corner, conn);
                if (t < -1e-5 || t > 1 + 1e-5) continue;
                addHit(hits, { t: Math.max(0, Math.min(1, t)), x: corner.x, y: corner.y, point: corner }, conn);
            }
            if (!hits.length) {
                const mid = { x: (conn.start.x + conn.end.x) / 2, y: (conn.start.y + conn.end.y) / 2 };
                if (pointInsideOrOnPoly2D(conn.start, poly) || pointInsideOrOnPoly2D(conn.end, poly) || pointInsideOrOnPoly2D(mid, poly)) {
                    removals.add(conn);
                }
                continue;
            }
            hits.sort((a, b) => a.t - b.t);
            const params = [{ t: 0, point: conn.start }, ...hits.map(h => ({ t: h.t, point: (h.t <= 1e-5 ? conn.start : (h.t >= 1 - 1e-5 ? conn.end : pointForHit(conn, h))) })), { t: 1, point: conn.end }];
            let changed = false;
            for (let i = 0; i < params.length - 1; i++) {
                const a = params[i], b = params[i + 1];
                if (Math.abs(b.t - a.t) < 1e-5 || a.point === b.point) continue;
                const tm = (a.t + b.t) / 2;
                const mid = {
                    x: conn.start.x + (conn.end.x - conn.start.x) * tm,
                    y: conn.start.y + (conn.end.y - conn.start.y) * tm
                };
                if (pointInsideOrOnPoly2D(mid, poly)) {
                    changed = true;
                    continue;
                }
                additions.push({ start: a.point, end: b.point, type: conn.type || null });
            }
            if (changed || params.length > 2) removals.add(conn);
        }
        if (newPoints.length) activeGeometry.points.push(...newPoints);
        if (removals.size) activeGeometry.connections = activeGeometry.connections.filter(c => !removals.has(c));
        additions.forEach(c => {
            if (c.start && c.end && c.start !== c.end) activeGeometry.connections.push(c);
        });
        return splitRecords;
    }
    function syncManualFacesForCutPolygon(cutPoly, splitRecords, sourceFaces = []) {
        if (!activeGeometry) return;
        if (!Array.isArray(activeGeometry.manualFaces)) activeGeometry.manualFaces = [];
        const manualFaces = activeGeometry.manualFaces;
        const addHoleToFace = (mf) => {
            if (!mf || !Array.isArray(mf.points) || mf.points.length < 3) return false;
            const holeXY = polygonIntersectionApprox(cutPoly, mf.points);
            if (holeXY.length < 3) return false;
            const faceArea = polyAreaAbs(mf.points);
            const holeArea = polyAreaAbs(holeXY);
            if (!(holeArea > 0.5) || (faceArea > 0 && holeArea > faceArea * 0.98)) return false;
            const holePts = holeXY.map(p => materializeHolePoint(p, mf));
            const sig = holeSignature(holePts);
            if (mf.holes.some(h => holeSignature(h) === sig)) return false;
            mf.holes.push(holePts);
            return true;
        };
        const sigOf = (pts) => {
            if (typeof getLocalFaceSignature === 'function') return getLocalFaceSignature(pts);
            return pts.map(coordKey).sort().join('|');
        };
        manualFaces.forEach(mf => {
            if (!mf || !Array.isArray(mf.points) || mf.points.length < 3) return;
            mf.points = insertSplitPointsIntoRing(mf.points, splitRecords || []);
            mf.holes = Array.isArray(mf.holes) ? mf.holes.map(h => insertSplitPointsIntoRing(h, splitRecords || [])) : [];
        });
        (sourceFaces || []).forEach(face => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
            const facePoints = insertSplitPointsIntoRing(face.points, splitRecords || []);
            const sig = sigOf(facePoints);
            let mf = manualFaces.find(item => item && Array.isArray(item.points) && sigOf(item.points) === sig);
            if (!mf) {
                mf = {
                    points: facePoints,
                    holes: Array.isArray(face.holes) ? face.holes.map(h => insertSplitPointsIntoRing(h, splitRecords || [])) : [],
                    layer: parseInt(face.layer || facePoints[0]?.layer || 1, 10)
                };
                mf.holes = Array.isArray(mf.holes) ? mf.holes : [];
                if (addHoleToFace(mf)) manualFaces.push(mf);
                return;
            }
            mf.holes = Array.isArray(mf.holes) ? mf.holes : [];
            addHoleToFace(mf);
        });
    }
    function findStructureExitOnSegment(a, b, faces) {
        const dir = norm({ x: b.x - a.x, y: b.y - a.y });
        const candidates = [];
        (faces || []).forEach(face => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
            const ring = face.points;
            for (let i = 0; i < ring.length; i++) {
                const hit = segmentIntersectionParam(a, b, ring[i], ring[(i + 1) % ring.length]);
                if (!hit || hit.t <= 1e-5 || hit.t >= 1 - 1e-5) continue;
                const sample = { x: hit.x + dir.x * 0.5, y: hit.y + dir.y * 0.5 };
                if (topFaceHitAtXY(sample.x, sample.y, faces)) continue;
                candidates.push(hit);
            }
        });
        if (!candidates.length) return null;
        candidates.sort((p, q) => p.t - q.t);
        return candidates[0];
    }
    function getDormerOpenCutXY(xy, faces) {
        const leftOff = !topFaceHitAtXY(xy.cutLeftFront.x, xy.cutLeftFront.y, faces);
        const rightOff = !topFaceHitAtXY(xy.cutRightFront.x, xy.cutRightFront.y, faces);
        if (!leftOff && !rightOff) return null;
        const leftExit = findStructureExitOnSegment(xy.cutLeftShoulder, xy.cutLeftFront, faces);
        const rightExit = findStructureExitOnSegment(xy.cutRightShoulder, xy.cutRightFront, faces);
        if (!leftExit || !rightExit) return null;
        if (Math.hypot(leftExit.x - rightExit.x, leftExit.y - rightExit.y) < 0.1) return null;
        return {
            left: { x: leftExit.x, y: leftExit.y },
            right: { x: rightExit.x, y: rightExit.y }
        };
    }
    function replaceRingPathWithNotch(ring, cutPoly, leftExit, rightExit, notchPath) {
        if (!Array.isArray(ring) || ring.length < 3) return ring;
        const nearIdx = (target) => ring.findIndex(p => p === target || Math.hypot(p.x - target.x, p.y - target.y) < 0.08);
        const iL = nearIdx(leftExit);
        const iR = nearIdx(rightExit);
        if (iL < 0 || iR < 0 || iL === iR) return ring;
        const pathForward = (from, to) => {
            const out = [];
            let i = from;
            while (true) {
                out.push(ring[i]);
                if (i === to) break;
                i = (i + 1) % ring.length;
                if (out.length > ring.length + 1) break;
            }
            return out;
        };
        const scorePath = (path) => {
            let score = 0;
            for (let i = 0; i < path.length - 1; i++) {
                const mid = { x: (path[i].x + path[i + 1].x) / 2, y: (path[i].y + path[i + 1].y) / 2 };
                if (pointInsideOrOnPoly2D(mid, cutPoly)) score++;
            }
            return score;
        };
        const lToR = pathForward(iL, iR);
        const rToL = pathForward(iR, iL);
        const replaceLToR = scorePath(lToR) >= scorePath(rToL);
        const keepPath = replaceLToR ? pathForward(iR, iL) : pathForward(iL, iR);
        const notch = replaceLToR ? notchPath : notchPath.slice().reverse();
        const rebuilt = [notch[0], ...notch.slice(1, -1), notch[notch.length - 1], ...keepPath.slice(1, -1)];
        const out = [];
        rebuilt.forEach(p => {
            if (!p) return;
            const prev = out[out.length - 1];
            if (!prev || prev !== p) out.push(p);
        });
        if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
        return out.length >= 3 ? out : ring;
    }
    function syncManualFaceForOpenDormerCut(geo, splitRecords) {
        if (!activeGeometry || !Array.isArray(activeGeometry.manualFaces) || !geo?.hit?.face || !geo.openCut) return;
        const sigOf = (pts) => {
            if (typeof getLocalFaceSignature === 'function') return getLocalFaceSignature(pts);
            return pts.map(coordKey).sort().join('|');
        };
        const targetSig = sigOf(insertSplitPointsIntoRing(geo.hit.face.points, splitRecords || []));
        const mf = activeGeometry.manualFaces.find(item => item && Array.isArray(item.points) && sigOf(insertSplitPointsIntoRing(item.points, splitRecords || [])) === targetSig);
        if (!mf) return;
        mf.points = insertSplitPointsIntoRing(mf.points, splitRecords || []);
        mf.holes = Array.isArray(mf.holes) ? mf.holes.map(h => insertSplitPointsIntoRing(h, splitRecords || [])) : [];
        const notch = [
            geo.points.cutLeftFront,
            geo.points.cutLeftShoulder,
            geo.points.leftShoulder,
            geo.points.peak,
            geo.points.rightShoulder,
            geo.points.cutRightShoulder,
            geo.points.cutRightFront
        ];
        mf.points = replaceRingPathWithNotch(mf.points, geo.cutPoly, geo.points.cutLeftFront, geo.points.cutRightFront, notch);
    }
    function removeOldPointsInsidePolygon(poly, protectedPoints) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points)) return;
        const keep = protectedPoints || new Set();
        const shouldRemove = p => p && !keep.has(p) && pointStrictlyInsidePoly2D(p, poly);
        if (Array.isArray(activeGeometry.connections)) {
            activeGeometry.connections = activeGeometry.connections.filter(c => c && c.start && c.end && !shouldRemove(c.start) && !shouldRemove(c.end));
        }
        activeGeometry.points = activeGeometry.points.filter(p => !shouldRemove(p));
    }
    function dormerEdgeMatchesAny(edges, a, b) {
        return (edges || []).some(edge => edge && connectionMatchesDormerEdge({ start: a, end: b }, edge.a, edge.b));
    }
    function getDormerPeakShoulderEdges(geo) {
        if (!geo?.points?.peak) return [];
        return getDormerSnapPoints(geo).map(shoulder => ({ a: geo.points.peak, b: shoulder }));
    }
    function getOmittableDormerSharedEdges(geo) {
        if (!geo || !Array.isArray(geo.lines)) return [];
        return geo.lines
            .filter(ln => isDormerPeakShoulderLine(geo, ln) && shouldOmitDormerSharedEdge(geo, ln))
            .map(ln => ({ a: ln.a, b: ln.b }));
    }
    function dormerCutBoundaryHasOmittedEdge(geo) {
        if (!geo || !Array.isArray(geo.cutPoly)) return false;
        const omittedEdges = [
            ...(Array.isArray(geo._omittedSharedEdges) ? geo._omittedSharedEdges : []),
            ...(Array.isArray(geo._omittedSplitEdges) ? geo._omittedSplitEdges : [])
        ];
        if (!omittedEdges.length) return false;
        const poly = geo.cutPoly;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            if (dormerEdgeMatchesAny(omittedEdges, a, b)) return true;
        }
        return false;
    }
    function dormerCutBoundaryIsClosed(geo) {
        if (!geo || !Array.isArray(geo.cutPoly) || geo.cutPoly.length < 3) return false;
        for (let i = 0; i < geo.cutPoly.length; i++) {
            const a = geo.cutPoly[i];
            const b = geo.cutPoly[(i + 1) % geo.cutPoly.length];
            if (!a || !b || a === b) return false;
            const exists = activeGeometry?.connections?.some(conn => connectionMatchesDormerEdge(conn, a, b));
            if (!exists) return false;
        }
        return true;
    }
    function splitExistingLinesAtDormerPoints(geo, omitEdges) {
        const points = geo?.points ? getDormerSnapPoints(geo) : geo;
        if (!activeGeometry || !Array.isArray(activeGeometry.connections) || !Array.isArray(points) || !points.length) return [];
        const originalConns = activeGeometry.connections.slice();
        const removals = new Set();
        const additions = [];
        const splitRecords = [];
        const omittedSplitEdges = [];
        const pointSet = new Set(points.filter(Boolean));
        const tolerance = getUserSnapTolerancePx();
        const tOnConn = (p, conn) => {
            const dx = conn.end.x - conn.start.x;
            const dy = conn.end.y - conn.start.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) return null;
            return ((p.x - conn.start.x) * dx + (p.y - conn.start.y) * dy) / len2;
        };
        const projectionOnConn = (p, conn) => {
            const t = tOnConn(p, conn);
            if (t === null) return null;
            const tc = Math.max(0, Math.min(1, t));
            const x = conn.start.x + (conn.end.x - conn.start.x) * tc;
            const y = conn.start.y + (conn.end.y - conn.start.y) * tc;
            return { t: tc, x, y, d: Math.hypot(p.x - x, p.y - y) };
        };
        originalConns.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            const hits = [];
            pointSet.forEach(point => {
                if (!point || point === conn.start || point === conn.end) return;
                if (parseInt(point.layer || 1, 10) !== parseInt(conn.start.layer || conn.end.layer || 1, 10)) return;
                const proj = projectionOnConn(point, conn);
                if (!proj || proj.t <= 1e-5 || proj.t >= 1 - 1e-5 || proj.d > tolerance) return;
                const t = proj.t;
                point.x = proj.x;
                point.y = proj.y;
                point.z = interpolateConnZ(conn, t);
                point.zLocked = true;
                if (point._lockedPlanes) delete point._lockedPlanes;
                const nearHit = hits.find(h => h.point === point || Math.hypot((h.point.x || 0) - point.x, (h.point.y || 0) - point.y) <= tolerance);
                if (nearHit) {
                    if (nearHit.point !== point && geo?.points) replaceDormerGeoPoint(geo, point, nearHit.point);
                    return;
                }
                hits.push({ point, t });
            });
            if (!hits.length) return;
            hits.sort((a, b) => a.t - b.t);
            const chain = [{ point: conn.start, t: 0 }, ...hits, { point: conn.end, t: 1 }];
            for (let i = 0; i < chain.length - 1; i++) {
                const a = chain[i].point;
                const b = chain[i + 1].point;
                if (a && b && a !== b && Math.hypot(a.x - b.x, a.y - b.y) > 0.05) {
                    if (dormerEdgeMatchesAny(omitEdges, a, b)) {
                        omittedSplitEdges.push({ a, b });
                        continue;
                    }
                    additions.push({ start: a, end: b, type: conn.type || null });
                }
            }
            hits.forEach(h => splitRecords.push({ start: conn.start, end: conn.end, point: h.point, t: h.t }));
            removals.add(conn);
        });
        if (removals.size) activeGeometry.connections = activeGeometry.connections.filter(c => !removals.has(c));
        additions.forEach(c => activeGeometry.connections.push(c));
        splitRecords.omittedDormerEdges = omittedSplitEdges;
        return splitRecords;
    }
    function getExistingConnectionBetween(a, b) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return null;
        return activeGeometry.connections.find(c => c && ((c.start === a && c.end === b) || (c.start === b && c.end === a))) || null;
    }
    function sameDormerEdgePoint(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.layer && b.layer && parseInt(a.layer || 1, 10) !== parseInt(b.layer || 1, 10)) return false;
        return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0)) <= getUserSnapTolerancePx();
    }
    function connectionMatchesDormerEdge(conn, a, b) {
        if (!conn || !conn.start || !conn.end || !a || !b) return false;
        return (sameDormerEdgePoint(conn.start, a) && sameDormerEdgePoint(conn.end, b)) ||
            (sameDormerEdgePoint(conn.start, b) && sameDormerEdgePoint(conn.end, a));
    }
    function removeDormerEdgeConnections(a, b) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return;
        activeGeometry.connections = activeGeometry.connections.filter(conn => !connectionMatchesDormerEdge(conn, a, b));
    }
    function isDormerPeakShoulderLine(geo, ln) {
        const p = geo?.points || {};
        const uses = (a, b) => (ln.a === a && ln.b === b) || (ln.a === b && ln.b === a);
        if (uses(p.peak, p.leftShoulder)) return 'left';
        if (uses(p.peak, p.rightShoulder)) return 'right';
        return null;
    }
    function getDormerPlaneForLine(geo, ln) {
        if (!geo || !ln || typeof calculatePlaneFromVertices !== 'function') return null;
        const p = geo.points || {};
        const side = isDormerPeakShoulderLine(geo, ln);
        try {
            if (geo.spec?.triangle) {
                if (side === 'left') return calculatePlaneFromVertices([p.peak, p.leftShoulder, p.leftFront, p.frontPeak]);
                if (side === 'right') return calculatePlaneFromVertices([p.peak, p.frontPeak, p.rightFront, p.rightShoulder]);
            } else {
                if (side === 'left') return calculatePlaneFromVertices([p.peak, p.leftShoulder, p.leftFront, p.frontMid]);
                if (side === 'right') return calculatePlaneFromVertices([p.peak, p.frontMid, p.rightFront, p.rightShoulder]);
            }
        } catch (e) {}
        return null;
    }
    function planesClose(a, b) {
        if (!a || !b) return false;
        return Math.abs((a.a || 0) - (b.a || 0)) < 0.015 &&
            Math.abs((a.b || 0) - (b.b || 0)) < 0.015 &&
            Math.abs((a.c || 0) - (b.c || 0)) < 1.0;
    }
    function collectFaceHitsNearLine(a, b, third, faces) {
        if (!a || !b || !third) return [];
        const mx = ((a.x || 0) + (b.x || 0)) / 2;
        const my = ((a.y || 0) + (b.y || 0)) / 2;
        const vx = (third.x || 0) - mx;
        const vy = (third.y || 0) - my;
        const len = Math.hypot(vx, vy);
        if (len < 1e-6) return [];
        const nx = vx / len;
        const ny = vy / len;
        const hits = [];
        const seen = new Set();
        const snapTol = getUserSnapTolerancePx();
        const distances = Array.from(new Set([1.5, 3, 6, 12, 24, snapTol * 0.5, snapTol, snapTol * 1.5]
            .filter(d => Number.isFinite(d) && d > 0)
            .map(d => Math.round(d * 100) / 100)));
        distances.forEach(dist => {
            [-1, 1].forEach(sign => {
                const hit = topFaceHitAtXY(mx + nx * dist * sign, my + ny * dist * sign, faces || getStickerFaces());
                if (!hit || !hit.face) return;
                const sig = typeof getLocalFaceSignature === 'function'
                    ? getLocalFaceSignature(hit.face.points || [])
                    : (hit.face.points || []).map(coordKey).sort().join('|');
                if (seen.has(sig)) return;
                seen.add(sig);
                hits.push(hit);
            });
        });
        return hits;
    }
    function dormerLineMatchesAdjacentRoofPlane(geo, ln, plane) {
        if (!geo || !ln || !plane) return false;
        if (!isDormerPeakShoulderLine(geo, ln)) return false;
        const third = (() => {
            const p = geo.points || {};
            const uses = (a, b) => (ln.a === a && ln.b === b) || (ln.a === b && ln.b === a);
            if (uses(p.peak, p.leftShoulder)) return p.leftFront;
            if (uses(p.peak, p.rightShoulder)) return p.rightFront;
            return null;
        })();
        if (!third) return false;
        return collectFaceHitsNearLine(ln.a, ln.b, third, geo.faces || getStickerFaces())
            .some(hit => hit && planesClose(plane, hit.plane) && faceOverlapsDormerEdge(hit.face, ln.a, ln.b));
    }
    function faceOverlapsDormerEdge(face, a, b) {
        if (!face || !Array.isArray(face.points) || face.points.length < 3 || !a || !b) return false;
        const len = Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
        if (len < 1e-6) return false;
        const samples = [0.2, 0.35, 0.5, 0.65, 0.8];
        let hits = 0;
        for (const t of samples) {
            const p = {
                x: (a.x || 0) + ((b.x || 0) - (a.x || 0)) * t,
                y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * t
            };
            if (pointInsideOrOnPoly2D(p, face.points)) hits++;
        }
        return hits >= 2;
    }
    function shouldOmitDormerSharedEdge(geo, ln) {
        const dormerPlane = getDormerPlaneForLine(geo, ln);
        return !!dormerLineMatchesAdjacentRoofPlane(geo, ln, dormerPlane);
    }
    function addDormerLineIfNeeded(geo, ln) {
        if (!ln || !ln.a || !ln.b || ln.a === ln.b) return;
        if (dormerEdgeMatchesAny(geo?._omittedSplitEdges, ln.a, ln.b)) {
            removeDormerEdgeConnections(ln.a, ln.b);
            return;
        }
        const existing = getExistingConnectionBetween(ln.a, ln.b);
        if (shouldOmitDormerSharedEdge(geo, ln)) {
            removeDormerEdgeConnections(ln.a, ln.b);
            return;
        }
        if (existing) {
            return;
        }
        activeGeometry.connections.push({ start: ln.a, end: ln.b, type: ln.type || null });
    }
    function removeOmittedDormerSharedEdges(geo) {
        if (!geo || !Array.isArray(geo.lines)) return;
        geo.lines.forEach(ln => {
            if (!isDormerPeakShoulderLine(geo, ln)) return;
            if (shouldOmitDormerSharedEdge(geo, ln)) removeDormerEdgeConnections(ln.a, ln.b);
        });
    }
    function areSegmentsCollinearThroughPoint(center, a, b) {
        if (!center || !a || !b || a === b) return false;
        const ax = (a.x || 0) - (center.x || 0);
        const ay = (a.y || 0) - (center.y || 0);
        const az = getPointZ(a) - getPointZ(center);
        const bx = (b.x || 0) - (center.x || 0);
        const by = (b.y || 0) - (center.y || 0);
        const bz = getPointZ(b) - getPointZ(center);
        const al = Math.hypot(ax, ay, az);
        const bl = Math.hypot(bx, by, bz);
        if (al < 1e-6 || bl < 1e-6) return false;
        const dot = (ax * bx + ay * by + az * bz) / (al * bl);
        return dot <= Math.cos(Math.PI - (12 * Math.PI / 180));
    }
    function mergeDormerOriginIfRedundant(geo) {
        if (!geo || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return;
        const peak = geo.points?.peak;
        const ridgeTarget = geo.spec?.triangle ? geo.points?.frontPeak : geo.points?.frontMid;
        if (!peak || !ridgeTarget) return;
        const peakConns = activeGeometry.connections.filter(conn => conn && (conn.start === peak || conn.end === peak));
        if (peakConns.length !== 2) return;
        const dormerRidgeConn = peakConns.find(conn =>
            (conn.start === peak && conn.end === ridgeTarget) ||
            (conn.end === peak && conn.start === ridgeTarget)
        );
        if (!dormerRidgeConn) return;
        const otherConn = peakConns.find(conn => conn !== dormerRidgeConn);
        if (!otherConn) return;
        const otherPoint = otherConn.start === peak ? otherConn.end : otherConn.start;
        if (!otherPoint || otherPoint === ridgeTarget) return;
        if (!areSegmentsCollinearThroughPoint(peak, ridgeTarget, otherPoint)) return;
        const mergedType = dormerRidgeConn.type || otherConn.type || 'ridge';
        activeGeometry.connections = activeGeometry.connections.filter(conn => conn !== dormerRidgeConn && conn !== otherConn);
        if (!getExistingConnectionBetween(otherPoint, ridgeTarget)) {
            activeGeometry.connections.push({ start: otherPoint, end: ridgeTarget, type: mergedType });
        }
        activeGeometry.points = activeGeometry.points.filter(p => p !== peak);
        if (geo._replacedDormerPoints) geo._replacedDormerPoints.add(peak);
        geo._removedDormerOrigin = peak;
    }
    function replaceDormerGeoPoint(geo, from, to) {
        if (!geo || !from || !to || from === to) return;
        if (!geo._replacedDormerPoints) geo._replacedDormerPoints = new Set();
        geo._replacedDormerPoints.add(from);
        Object.keys(geo.points || {}).forEach(k => {
            if (geo.points[k] === from) geo.points[k] = to;
        });
        ['allPoints', 'outline', 'cutPoly'].forEach(k => {
            if (Array.isArray(geo[k])) geo[k] = geo[k].map(p => p === from ? to : p);
        });
        (geo.lines || []).forEach(ln => {
            if (ln.a === from) ln.a = to;
            if (ln.b === from) ln.b = to;
        });
    }
    function cleanupReplacedDormerPoints(geo) {
        if (!geo || !geo._replacedDormerPoints || !activeGeometry || !Array.isArray(activeGeometry.points)) return;
        const liveDormerPoints = new Set((geo.allPoints || []).filter(Boolean));
        const connected = new Set();
        (activeGeometry.connections || []).forEach(conn => {
            if (!conn) return;
            if (conn.start) connected.add(conn.start);
            if (conn.end) connected.add(conn.end);
        });
        const removed = [];
        activeGeometry.points = activeGeometry.points.filter(p => {
            if (!geo._replacedDormerPoints.has(p)) return true;
            if (liveDormerPoints.has(p) || connected.has(p)) return true;
            removed.push(p);
            return false;
        });
        if (removed.length && typeof selectedPoints !== 'undefined') {
            removed.forEach(p => selectedPoints.delete(p));
        }
    }
    function mergeDormerPointsWithExistingPoints(geo) {
        if (!geo || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(geo.allPoints)) return;
        const tolerance = getUserSnapTolerancePx();
        const dormerPointSet = new Set(geo.allPoints.filter(Boolean));
        const existingPoints = activeGeometry.points.filter(p => p && !dormerPointSet.has(p));
        getDormerSnapPoints(geo).slice().forEach(point => {
            if (!point) return;
            let best = null;
            let bestDist = Infinity;
            existingPoints.forEach(existing => {
                if (!existing) return;
                if (parseInt(existing.layer || 1, 10) !== parseInt(point.layer || 1, 10)) return;
                const d = Math.hypot((existing.x || 0) - (point.x || 0), (existing.y || 0) - (point.y || 0));
                if (d > tolerance || d >= bestDist) return;
                const dz = Math.abs(getPointZ(existing) - getPointZ(point));
                if (dz > 1.0) return;
                best = existing;
                bestDist = d;
            });
            if (!best) return;
            replaceDormerGeoPoint(geo, point, best);
            [geo.points.frontMid, geo.points.frontPeak].forEach(p => {
                if (!p) return;
                if (p === point) replaceDormerGeoPoint(geo, p, best);
            });
        });
    }
    function resolveDormerPeakSnap(geo) {
        const snap = geo?.peakSnap;
        if (!snap) return;
        if (snap.kind === 'point' && snap.point) {
            const oldPeak = geo.points.peak;
            replaceDormerGeoPoint(geo, oldPeak, snap.point);
            const z = getPointZ(snap.point);
            [geo.points.frontMid, geo.points.frontPeak].forEach(p => {
                if (!p) return;
                p.z = z;
                p.zLocked = true;
            });
            return;
        }
        if (snap.kind !== 'line' || !snap.conn || !activeGeometry.connections.includes(snap.conn)) return;
        const conn = snap.conn;
        const peak = geo.points.peak;
        peak.layer = parseInt(conn.start.layer || conn.end.layer || peak.layer || 1, 10);
        peak.z = interpolateConnZ(conn, snap.t);
        peak.zLocked = true;
        const idx = activeGeometry.connections.indexOf(conn);
        if (idx >= 0) activeGeometry.connections.splice(idx, 1);
        activeGeometry.connections.push({ start: conn.start, end: peak, type: conn.type || null });
        activeGeometry.connections.push({ start: peak, end: conn.end, type: conn.type || null });
        [geo.points.frontMid, geo.points.frontPeak].forEach(p => {
            if (!p) return;
            p.z = peak.z;
            p.zLocked = true;
        });
    }
    function computeDormerGeometry(clientX, clientY, spec, placement = null) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return null;
        if (typeof screenToImage !== 'function') return null;
        const cursorXY = screenToImage(clientX, clientY);
        const peakSnap = placement?.peakXY ? null : getDormerPeakSnap(clientX, clientY);
        const peakXY = placement?.peakXY || peakSnap.xy || cursorXY;
        const faces = getStickerFaces();
        let preferredFace = placement?.hitFace || null;
        if (placement?.step === 1) {
            const cursorHit = topFaceHitAtXY(cursorXY.x, cursorXY.y, faces);
            if (cursorHit?.face) preferredFace = cursorHit.face;
        }
        const hit = getDormerPeakHit(peakXY, faces, placement?.peakSnap || peakSnap?.snap || null, preferredFace);
        if (!hit) return null;
        const up = getFeatureUpDir(hit.face, hit.plane);
        const down = { x: -up.x, y: -up.y };
        const right = norm(rot90(up, -1));
        const layer = parseInt(hit.face.layer || 1, 10);
        const defaultHipRun = getSurfaceLengthPx(spec.hipRunFt || 3, hit.plane, up);
        const defaultSideRun = getSurfaceLengthPx(spec.sideRunFt || 5, hit.plane, up);
        const minRun = getSurfaceLengthPx(0.5, hit.plane, up);
        const diagLeft = norm({ x: down.x - right.x, y: down.y - right.y });
        const diagRight = norm({ x: down.x + right.x, y: down.y + right.y });
        let sideSign = placement?.sideSign || 1;
        let hipRun = placement?.hipRun || defaultHipRun;
        let sideRun = placement?.sideRun || defaultSideRun;
        if (placement?.step === 1) {
            const v = { x: cursorXY.x - peakXY.x, y: cursorXY.y - peakXY.y };
            const leftProj = dot2(v, diagLeft);
            const rightProj = dot2(v, diagRight);
            sideSign = rightProj >= leftProj ? 1 : -1;
            hipRun = Math.max(minRun, Math.abs(Math.max(leftProj, rightProj)) / Math.SQRT2);
        } else if (placement?.step >= 2) {
            sideSign = placement.sideSign || 1;
            hipRun = Math.max(minRun, placement.hipRun || defaultHipRun);
            const shoulderXY = {
                x: peakXY.x + down.x * hipRun + right.x * hipRun * sideSign,
                y: peakXY.y + down.y * hipRun + right.y * hipRun * sideSign
            };
            if (placement.step === 2) {
                const v = { x: cursorXY.x - shoulderXY.x, y: cursorXY.y - shoulderXY.y };
                sideRun = Math.max(minRun, dot2(v, down));
            }
        }
        const overhang = getSurfaceLengthPx(spec.overhangFt || 1.5, hit.plane, right);
        const xy = {
            peak: peakXY,
            leftShoulder: { x: peakXY.x + down.x * hipRun - right.x * hipRun, y: peakXY.y + down.y * hipRun - right.y * hipRun },
            rightShoulder: { x: peakXY.x + down.x * hipRun + right.x * hipRun, y: peakXY.y + down.y * hipRun + right.y * hipRun }
        };
        xy.leftFront = { x: xy.leftShoulder.x + down.x * sideRun, y: xy.leftShoulder.y + down.y * sideRun };
        xy.rightFront = { x: xy.rightShoulder.x + down.x * sideRun, y: xy.rightShoulder.y + down.y * sideRun };
        xy.frontMid = { x: (xy.leftFront.x + xy.rightFront.x) / 2, y: (xy.leftFront.y + xy.rightFront.y) / 2 };
        xy.frontPeak = { x: xy.frontMid.x + up.x * hipRun, y: xy.frontMid.y + up.y * hipRun };
        xy.cutLeftShoulder = { x: xy.leftShoulder.x + right.x * overhang, y: xy.leftShoulder.y + right.y * overhang };
        xy.cutRightShoulder = { x: xy.rightShoulder.x - right.x * overhang, y: xy.rightShoulder.y - right.y * overhang };
        xy.cutLeftFront = {
            x: xy.leftFront.x + right.x * overhang + up.x * overhang,
            y: xy.leftFront.y + right.y * overhang + up.y * overhang
        };
        xy.cutRightFront = {
            x: xy.rightFront.x - right.x * overhang + up.x * overhang,
            y: xy.rightFront.y - right.y * overhang + up.y * overhang
        };
        const openCut = getDormerOpenCutXY(xy, faces);
        if (openCut) {
            xy.cutLeftFront = openCut.left;
            xy.cutRightFront = openCut.right;
        }
        const make = p => getPointOnFace(p, hit, layer);
        const points = {
            peak: make(xy.peak),
            leftShoulder: make(xy.leftShoulder),
            rightShoulder: make(xy.rightShoulder),
            leftFront: make(xy.leftFront),
            rightFront: make(xy.rightFront),
            frontMid: make(xy.frontMid),
            frontPeak: make(xy.frontPeak),
            cutLeftShoulder: make(xy.cutLeftShoulder),
            cutRightShoulder: make(xy.cutRightShoulder),
            cutLeftFront: make(xy.cutLeftFront),
            cutRightFront: make(xy.cutRightFront)
        };
        const setDormerTopZ = (p, z) => {
            if (!p) return;
            p.z = z;
            p.zLocked = true;
            delete p._lockedPlanes;
        };
        const ridgeZ = points.peak.z;
        const lowerTopZ = (points.leftShoulder.z + points.rightShoulder.z) / 2;
        [points.peak, points.frontMid, points.frontPeak].forEach(p => setDormerTopZ(p, ridgeZ));
        [
            points.leftShoulder,
            points.rightShoulder,
            points.leftFront,
            points.rightFront,
            points.cutLeftShoulder,
            points.cutRightShoulder
        ].forEach(p => setDormerTopZ(p, lowerTopZ));
        const cutPoly = [
            points.peak,
            points.leftShoulder,
            points.cutLeftShoulder,
            points.cutLeftFront,
            points.cutRightFront,
            points.cutRightShoulder,
            points.rightShoulder
        ];
        const outline = [points.peak, points.leftShoulder, points.leftFront, points.rightFront, points.rightShoulder];
        const allPoints = spec.triangle
            ? [points.peak, points.leftShoulder, points.rightShoulder, points.leftFront, points.rightFront, points.frontPeak, points.cutLeftShoulder, points.cutRightShoulder, points.cutLeftFront, points.cutRightFront]
            : [points.peak, points.leftShoulder, points.rightShoulder, points.leftFront, points.rightFront, points.frontMid, points.cutLeftShoulder, points.cutRightShoulder, points.cutLeftFront, points.cutRightFront];
        const lines = [
            { a: points.peak, b: points.leftShoulder, type: 'valley' },
            { a: points.peak, b: points.rightShoulder, type: 'valley' },
            { a: points.leftShoulder, b: points.leftFront, type: null },
            { a: points.rightShoulder, b: points.rightFront, type: null },
            { a: points.leftShoulder, b: points.cutLeftShoulder, type: null },
            { a: points.rightShoulder, b: points.cutRightShoulder, type: null },
            { a: points.cutLeftShoulder, b: points.cutLeftFront, type: null },
            { a: points.cutRightFront, b: points.cutRightShoulder, type: null }
        ];
        if (!openCut) lines.push({ a: points.cutLeftFront, b: points.cutRightFront, type: null });
        if (spec.triangle) {
            lines.push({ a: points.leftFront, b: points.rightFront, type: 'eave' });
            lines.push({ a: points.leftFront, b: points.frontPeak, type: 'hip' });
            lines.push({ a: points.rightFront, b: points.frontPeak, type: 'hip' });
            lines.push({ a: points.peak, b: points.frontPeak, type: 'ridge' });
        } else {
            lines.push({ a: points.leftFront, b: points.frontMid, type: 'eave' });
            lines.push({ a: points.frontMid, b: points.rightFront, type: 'eave' });
            lines.push({ a: points.peak, b: points.frontMid, type: 'ridge' });
        }
        const geo = { spec, hit, faces, points, allPoints, outline, cutPoly, lines, up, right, center: peakXY, sideSign, hipRun, sideRun, peakSnap: placement?.peakSnap || peakSnap?.snap || null, openCut };
        if (spec.curved && !spec.triangle) addCurvedDormerSplits(geo);
        return geo;
    }
    function addCurvedDormerSplits(geo) {
        if (!geo?.points || !Array.isArray(geo.lines)) return;
        const p = geo.points;
        const sideSteps = Math.max(2, Math.round((geo.spec.sections || 4) / 2));
        const isFrontEave = ln =>
            ln && (
                (ln.a === p.leftFront && ln.b === p.frontMid) ||
                (ln.a === p.frontMid && ln.b === p.leftFront) ||
                (ln.a === p.frontMid && ln.b === p.rightFront) ||
                (ln.a === p.rightFront && ln.b === p.frontMid)
            );
        geo.lines = geo.lines.filter(ln => !isFrontEave(ln));
        const isPeakShoulder = ln =>
            ln && (
                (ln.a === p.peak && ln.b === p.leftShoulder) ||
                (ln.a === p.leftShoulder && ln.b === p.peak) ||
                (ln.a === p.peak && ln.b === p.rightShoulder) ||
                (ln.a === p.rightShoulder && ln.b === p.peak)
            );
        geo.lines = geo.lines.filter(ln => !isPeakShoulder(ln));
        const ridgeDir = norm({ x: p.peak.x - p.frontMid.x, y: p.peak.y - p.frontMid.y });
        const lowerZ = (getPointZ(p.leftFront) + getPointZ(p.rightFront)) / 2;
        const ridgeZ = getPointZ(p.frontMid);
        const targetFace = geo.hit?.face || null;
        const targetPlane = getFacePlaneSafe(targetFace) || geo.hit?.plane || null;
        const zOnFace = xy => {
            const plane = targetPlane || topFaceHitAtXY(xy.x, xy.y, geo.faces || getStickerFaces())?.plane || null;
            if (!plane) return lowerZ;
            const z = plane.a * xy.x + plane.b * xy.y + plane.c;
            return Number.isFinite(z) ? z : lowerZ;
        };
        const make = (xy, z) => ({
            x: xy.x,
            y: xy.y,
            z,
            layer: parseInt(p.frontMid.layer || p.peak.layer || 1, 10),
            zLocked: true
        });
        const curveLift = t => Math.sin(t * Math.PI) * Math.max(0.12, Math.abs(ridgeZ - lowerZ) * 0.18);
        const runIsOnTargetFace = (frontXY, run) => {
            if (!targetFace) return true;
            const xy = { x: frontXY.x + ridgeDir.x * run, y: frontXY.y + ridgeDir.y * run };
            return faceContainsXY(targetFace, xy.x, xy.y);
        };
        const firstTargetFaceEntryRun = (frontXY) => {
            if (!targetFace || !Array.isArray(targetFace.points) || targetFace.points.length < 3) return null;
            if (faceContainsXY(targetFace, frontXY.x, frontXY.y)) return 0;
            const xs = targetFace.points.map(pt => pt.x).filter(Number.isFinite);
            const ys = targetFace.points.map(pt => pt.y).filter(Number.isFinite);
            const minX = xs.length ? Math.min(...xs) : frontXY.x;
            const maxX = xs.length ? Math.max(...xs) : frontXY.x;
            const minY = ys.length ? Math.min(...ys) : frontXY.y;
            const maxY = ys.length ? Math.max(...ys) : frontXY.y;
            const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            const faceDiag = Math.hypot(maxX - minX, maxY - minY);
            const lookahead = Math.max(
                geo.sideRun * 12,
                getUserSnapTolerancePx() * 8,
                faceDiag + Math.hypot(center.x - frontXY.x, center.y - frontXY.y) + 20
            );
            const far = {
                x: frontXY.x + ridgeDir.x * lookahead,
                y: frontXY.y + ridgeDir.y * lookahead
            };
            const hits = [];
            const ring = targetFace.points;
            for (let i = 0; i < ring.length; i++) {
                const hit = segmentIntersectionParam(frontXY, far, ring[i], ring[(i + 1) % ring.length]);
                if (!hit || hit.t < -1e-6 || hit.t > 1 + 1e-6) continue;
                const run = Math.hypot(hit.x - frontXY.x, hit.y - frontXY.y);
                if (run < 1e-5) continue;
                const probe = {
                    x: hit.x + ridgeDir.x * 0.5,
                    y: hit.y + ridgeDir.y * 0.5
                };
                if (faceContainsXY(targetFace, probe.x, probe.y)) hits.push(run);
            }
            if (!hits.length) return null;
            hits.sort((a, b) => a - b);
            return hits[0];
        };
        const findLevelBackPoint = (frontXY, frontZ, t, wing) => {
            const zAtFront = zOnFace(frontXY);
            const slopeBack = targetPlane
                ? ((targetPlane.a || 0) * ridgeDir.x + (targetPlane.b || 0) * ridgeDir.y)
                : 0;
            const entryRun = firstTargetFaceEntryRun(frontXY);
            let run = Math.max(entryRun || 0, geo.sideRun * Math.max(0.25, 1 - t));
            if (Math.abs(slopeBack) > 1e-9) {
                const solved = (frontZ - zAtFront) / slopeBack;
                if (Number.isFinite(solved) && solved > 0 && runIsOnTargetFace(frontXY, solved)) {
                    run = solved;
                } else if (Number.isFinite(solved) && solved > 0 && entryRun !== null) {
                    run = Math.max(solved, entryRun);
                }
            }
            if (entryRun !== null) run = Math.max(run, entryRun);
            if (geo.openCut && wing) {
                const boundary = wing === p.leftFront ? p.cutLeftFront : p.cutRightFront;
                const projected = dot2({ x: boundary.x - frontXY.x, y: boundary.y - frontXY.y }, ridgeDir);
                if (Number.isFinite(projected) && projected > run) run = projected;
            }
            run = Math.max(0.5, run);
            return {
                x: frontXY.x + ridgeDir.x * run,
                y: frontXY.y + ridgeDir.y * run
            };
        };
        const addSide = (wing, sideKey) => {
            let prevFront = p.frontMid;
            const frontPts = [];
            const backPts = [];
            for (let i = 1; i <= sideSteps; i++) {
                const t = i / sideSteps;
                const frontXY = {
                    x: p.frontMid.x + (wing.x - p.frontMid.x) * t,
                    y: p.frontMid.y + (wing.y - p.frontMid.y) * t
                };
                const baseZ = lowerZ + (ridgeZ - lowerZ) * (1 - t);
                const frontPt = (i === sideSteps) ? wing : make(frontXY, baseZ + curveLift(t));
                frontPts.push(frontPt);
                if (frontPt !== wing) geo.allPoints.push(frontPt);
                geo.lines.push({ a: prevFront, b: frontPt, type: 'hip' });
                prevFront = frontPt;
                if (i < sideSteps) {
                    const backXY = findLevelBackPoint(frontXY, frontPt.z, t, wing);
                    const backPt = make(backXY, frontPt.z);
                    backPts.push(backPt);
                    geo.allPoints.push(backPt);
                    geo.lines.push({ a: frontPt, b: backPt, type: 'ridge' });
                }
            }
            const shoulder = sideKey === 'Left' ? p.leftShoulder : p.rightShoulder;
            let prevBack = p.peak;
            backPts.forEach(backPt => {
                geo.lines.push({ a: prevBack, b: backPt, type: null });
                prevBack = backPt;
            });
            geo.lines.push({ a: prevBack, b: shoulder, type: null });
            geo[`curvedDormer${sideKey}`] = { frontPts, backPts };
        };
        addSide(p.leftFront, 'Left');
        addSide(p.rightFront, 'Right');
    }
    function buildDormerPreview(geo) {
        const points = [{ x: geo.points.peak.x, y: geo.points.peak.y, r: 3.5, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' }];
        if (geo.spec?._placement?.step >= 1) {
            points.push({ x: geo.points.leftShoulder.x, y: geo.points.leftShoulder.y, r: 3.2, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' });
            points.push({ x: geo.points.rightShoulder.x, y: geo.points.rightShoulder.y, r: 3.2, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' });
        }
        if (geo.spec?.curved && Array.isArray(geo.allPoints)) {
            const base = new Set(Object.values(geo.points || {}).filter(Boolean));
            geo.allPoints.forEach(p => {
                if (!p || base.has(p)) return;
                points.push({ x: p.x, y: p.y, r: 2.8, fill: 'rgba(255,193,7,0.82)', stroke: '#fff' });
            });
        }
        return {
            enabled: true,
            lines: geo.lines.filter(ln => !shouldOmitDormerSharedEdge(geo, ln)).map(ln => ({
                a: ln.a,
                b: ln.b,
                w: 2.7,
                dash: !ln.type,
                color: ln.a === geo.points.cutLeftShoulder || ln.a === geo.points.cutLeftFront || ln.a === geo.points.cutRightFront
                    ? 'rgba(255,255,255,0.75)'
                    : 'rgba(255,193,7,0.98)'
            })),
            points
        };
    }
    function commitDormer(geo) {
        if (!geo || !activeGeometry || !activeGeometry.points || !activeGeometry.connections) return false;
        if (typeof save2DState === 'function') save2DState();
        resolveDormerPeakSnap(geo);
        mergeDormerPointsWithExistingPoints(geo);
        geo.allPoints.forEach(p => {
            if (p && !activeGeometry.points.includes(p)) activeGeometry.points.push(p);
        });
        const splitRecords = splitExistingLinesForCutPolygon(geo, geo.faces);
        mergeDormerPointsWithExistingPoints(geo);
        const protectedPoints = new Set(geo.allPoints);
        geo._omittedSharedEdges = getOmittableDormerSharedEdges(geo);
        const pointSplitRecords = splitExistingLinesAtDormerPoints(geo, getDormerPeakShoulderEdges(geo));
        geo._omittedSplitEdges = pointSplitRecords.omittedDormerEdges || [];
        const allSplitRecords = [...splitRecords, ...pointSplitRecords];
        removeOldPointsInsidePolygon(geo.cutPoly, protectedPoints);
        geo.lines.forEach(ln => addDormerLineIfNeeded(geo, ln));
        removeOmittedDormerSharedEdges(geo);
        mergeDormerOriginIfRedundant(geo);
        cleanupReplacedDormerPoints(geo);
        if (!dormerCutBoundaryHasOmittedEdge(geo)) {
            if (geo.openCut) syncManualFaceForOpenDormerCut(geo, allSplitRecords);
            else if (dormerCutBoundaryIsClosed(geo)) syncManualFacesForCutPolygon(geo.cutPoly, allSplitRecords, [geo.hit.face]);
        }
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                geo.allPoints.forEach(p => {
                    if (p && p !== geo._removedDormerOrigin && activeGeometry.points.includes(p)) selectedPoints.add(p);
                });
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        try {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    try {
                        if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
                        if (typeof renderFinalPass === 'function') renderFinalPass(false);
                        if (typeof renderGeometry3D === 'function') renderGeometry3D();
                        request2DRender();
                    } catch (e) {}
                });
            }
        } catch (e) {}
        request2DRender();
        return true;
    }
    function computeEyebrowGeometry(clientX, clientY, spec, placement = null) {
        if (!activeGeometry || !activeGeometry.points || !activeGeometry.connections) return null;
        if (typeof screenToImage !== 'function') return null;
        const cursorXY = screenToImage(clientX, clientY);
        const originSnap = placement?.originXY ? null : getDormerPeakSnap(clientX, clientY);
        const originXY = placement?.originXY || originSnap?.xy || cursorXY;
        const faces = getStickerFaces();
        const hit = getDormerPeakHit(originXY, faces, placement?.originSnap || originSnap?.snap || null);
        if (!hit) return null;
        const layer = parseInt(hit.face.layer || 1, 10);
        const originZ = hit.plane ? hit.plane.a * originXY.x + hit.plane.b * originXY.y + hit.plane.c : getPointZ(originXY);
        let dir = getFeatureUpDir(hit.face, hit.plane);
        if (!placement && hit.face && Array.isArray(hit.face.points) && hit.face.points.length) {
            const faceCenter = hit.face.points.reduce((acc, p) => ({ x: acc.x + (p.x || 0), y: acc.y + (p.y || 0) }), { x: 0, y: 0 });
            faceCenter.x /= hit.face.points.length;
            faceCenter.y /= hit.face.points.length;
            if (dot2(dir, { x: originXY.x - faceCenter.x, y: originXY.y - faceCenter.y }) > 0) {
                dir = { x: -dir.x, y: -dir.y };
            }
        }
        let depth = getSurfaceLengthPx(spec.depthFt || 4, hit.plane, dir);
        let halfWidth = getSurfaceLengthPx((spec.widthFt || 6) / 2, hit.plane, rot90(dir, 1));
        if (placement?.step >= 2 && placement.dir && Number.isFinite(placement.depth)) {
            dir = placement.dir;
            depth = placement.depth;
        } else if (placement?.step >= 1) {
            const v = { x: cursorXY.x - originXY.x, y: cursorXY.y - originXY.y };
            const projected = dot2(v, dir);
            if (projected < 0) dir = { x: -dir.x, y: -dir.y };
            depth = Math.max(getSurfaceLengthPx(0.75, hit.plane, dir), Math.abs(projected));
        }
        const right = norm(rot90(dir, -1));
        const frontXY = { x: originXY.x + dir.x * depth, y: originXY.y + dir.y * depth };
        if (placement?.step >= 2) {
            const v = { x: cursorXY.x - frontXY.x, y: cursorXY.y - frontXY.y };
            halfWidth = Math.max(getSurfaceLengthPx(0.75, hit.plane, right), Math.abs(dot2(v, right)));
        } else if (placement?.step === 1) {
            halfWidth = depth;
        }
        const sections = spec.sections || 2;
        const backMode = spec.backMode || 'level';
        const sideSteps = Math.max(1, Math.round(sections / 2));
        const zOnFace = xy => {
            const z = hit.plane ? hit.plane.a * xy.x + hit.plane.b * xy.y + hit.plane.c : getPointZ(xy);
            return Number.isFinite(z) ? z : originZ;
        };
        const make = (xy, z = zOnFace(xy)) => ({ x: xy.x, y: xy.y, z, layer, zLocked: true });
        const origin = placement?.originSnap?.kind === 'point' && placement.originSnap.point
            ? placement.originSnap.point
            : make(originXY, originZ);
        const frontSupportZ = zOnFace(frontXY);
        const frontRidgeZ = originZ;
        const frontRidge = make(frontXY, frontRidgeZ);
        const points = { origin, frontRidge, left: [], right: [], leftBack: [], rightBack: [] };
        const lines = [{ a: origin, b: frontRidge, type: 'ridge' }];
        const allPoints = [origin, frontRidge];
        const curveLift = i => {
            if (sideSteps <= 1) return 0;
            const t = i / sideSteps;
            return Math.sin(t * Math.PI) * Math.max(0.15, (frontRidgeZ - frontSupportZ) * 0.18);
        };
        const findLevelBackPoint = (frontXYi, frontZ, t) => {
            const zAtFrontOnFace = zOnFace(frontXYi);
            const slopeBack = hit.plane
                ? -((hit.plane.a || 0) * dir.x + (hit.plane.b || 0) * dir.y)
                : 0;
            let run = depth * Math.max(0.15, t);
            if (Math.abs(slopeBack) > 1e-9) {
                const solved = (frontZ - zAtFrontOnFace) / slopeBack;
                if (Number.isFinite(solved) && solved > 0) run = solved;
            }
            run = Math.max(0.5, Math.min(depth * 1.5, run));
            return {
                xy: {
                    x: frontXYi.x - dir.x * run,
                    y: frontXYi.y - dir.y * run
                },
                z: frontZ
            };
        };
        const makeSide = (sideSign) => {
            const frontPts = [];
            const backPts = [];
            const wingXY = {
                x: frontXY.x + right.x * halfWidth * sideSign,
                y: frontXY.y + right.y * halfWidth * sideSign
            };
            for (let i = 1; i <= sideSteps; i++) {
                const t = i / sideSteps;
                const frontXYi = {
                    x: frontXY.x + right.x * halfWidth * sideSign * t,
                    y: frontXY.y + right.y * halfWidth * sideSign * t
                };
                const frontSideZ = zOnFace(frontXYi) + (frontRidgeZ - zOnFace(frontXYi)) * (1 - t) + curveLift(i);
                const frontPt = make(frontXYi, frontSideZ);
                const levelBack = findLevelBackPoint(frontXYi, frontSideZ, t);
                const backPt = i === sideSteps
                    ? frontPt
                    : (backMode === 'origin' ? origin : make(levelBack.xy, levelBack.z));
                frontPts.push(frontPt);
                backPts.push(backPt);
                allPoints.push(frontPt);
                if (backPt !== frontPt && backPt !== origin) allPoints.push(backPt);
            }
            return { frontPts, backPts };
        };
        const leftSide = makeSide(-1);
        const rightSide = makeSide(1);
        points.left = leftSide.frontPts;
        points.right = rightSide.frontPts;
        points.leftBack = leftSide.backPts;
        points.rightBack = rightSide.backPts;
        const addSideLines = (frontPts, backPts) => {
            let prevFront = frontRidge;
            frontPts.forEach((frontPt, idx) => {
                const backPt = backPts[idx];
                lines.push({ a: prevFront, b: frontPt, type: 'hip' });
                lines.push({ a: frontPt, b: backPt, type: 'ridge' });
                if (backPt === origin) {
                    // The rib itself already returns to the original point.
                } else if (idx === 0) {
                    lines.push({ a: origin, b: backPt, type: null });
                } else {
                    lines.push({ a: backPts[idx - 1], b: backPt, type: null });
                }
                prevFront = frontPt;
            });
        };
        addSideLines(leftSide.frontPts, leftSide.backPts);
        addSideLines(rightSide.frontPts, rightSide.backPts);
        if (leftSide.backPts.length && rightSide.backPts.length) {
            const leftBackEnd = leftSide.backPts[leftSide.backPts.length - 1];
            const rightBackEnd = rightSide.backPts[rightSide.backPts.length - 1];
            if (leftBackEnd && rightBackEnd && leftBackEnd !== rightBackEnd) {
                lines.push({ a: leftBackEnd, b: rightBackEnd, type: null });
            }
        }
        return {
            spec,
            hit,
            faces,
            points,
            allPoints,
            lines,
            center: originXY,
            originSnap: placement?.originSnap || originSnap?.snap || null,
            dir,
            depth,
            halfWidth,
            sections,
            backMode
        };
    }
    function buildEyebrowPreview(geo) {
        return {
            enabled: true,
            lines: geo.lines.map(ln => ({
                a: ln.a,
                b: ln.b,
                w: ln.type ? 2.8 : 2.4,
                dash: !ln.type,
                color: ln.type ? 'rgba(255,193,7,0.98)' : 'rgba(255,255,255,0.78)'
            })),
            points: [
                { x: geo.points.origin.x, y: geo.points.origin.y, r: 4.2, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' },
                { x: geo.points.frontRidge.x, y: geo.points.frontRidge.y, r: 4.2, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' },
                ...geo.points.left.concat(geo.points.right).map(p => ({ x: p.x, y: p.y, r: 3.3, fill: 'rgba(255,193,7,0.88)', stroke: '#fff' }))
            ]
        };
    }
    function commitEyebrow(geo) {
        if (!geo || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return false;
        if (typeof save2DState === 'function') save2DState();
        geo.allPoints.forEach(p => {
            if (p && !activeGeometry.points.includes(p)) activeGeometry.points.push(p);
        });
        geo.lines.forEach(ln => {
            if (!ln || !ln.a || !ln.b || ln.a === ln.b || getExistingConnectionBetween(ln.a, ln.b)) return;
            activeGeometry.connections.push({ start: ln.a, end: ln.b, type: ln.type || null });
        });
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                geo.allPoints.forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    function splitExistingLinesAtPointsPreserveZ(points) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections) || !Array.isArray(points) || !points.length) return [];
        const originalConns = activeGeometry.connections.slice();
        const removals = new Set();
        const additions = [];
        const splitRecords = [];
        const pointSet = new Set(points.filter(Boolean));
        const tolerance = getUserSnapTolerancePx();
        const projectionOnConn = (p, conn) => {
            const dx = conn.end.x - conn.start.x;
            const dy = conn.end.y - conn.start.y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) return null;
            const t = ((p.x - conn.start.x) * dx + (p.y - conn.start.y) * dy) / len2;
            const tc = Math.max(0, Math.min(1, t));
            const x = conn.start.x + dx * tc;
            const y = conn.start.y + dy * tc;
            return { t: tc, x, y, d: Math.hypot(p.x - x, p.y - y) };
        };
        originalConns.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            const hits = [];
            pointSet.forEach(point => {
                if (!point || point === conn.start || point === conn.end) return;
                if (parseInt(point.layer || 1, 10) !== parseInt(conn.start.layer || conn.end.layer || 1, 10)) return;
                const proj = projectionOnConn(point, conn);
                if (!proj || proj.t <= 1e-5 || proj.t >= 1 - 1e-5 || proj.d > tolerance) return;
                point.x = proj.x;
                point.y = proj.y;
                const nearHit = hits.find(h => h.point === point || Math.hypot((h.point.x || 0) - point.x, (h.point.y || 0) - point.y) <= tolerance);
                if (nearHit) return;
                hits.push({ point, t: proj.t });
            });
            if (!hits.length) return;
            hits.sort((a, b) => a.t - b.t);
            const chain = [{ point: conn.start, t: 0 }, ...hits, { point: conn.end, t: 1 }];
            for (let i = 0; i < chain.length - 1; i++) {
                const a = chain[i].point;
                const b = chain[i + 1].point;
                if (a && b && a !== b && Math.hypot(a.x - b.x, a.y - b.y) > 0.05) {
                    additions.push({ start: a, end: b, type: conn.type || null });
                }
            }
            hits.forEach(h => splitRecords.push({ start: conn.start, end: conn.end, point: h.point, t: h.t }));
            removals.add(conn);
        });
        if (removals.size) activeGeometry.connections = activeGeometry.connections.filter(c => !removals.has(c));
        additions.forEach(c => activeGeometry.connections.push(c));
        return splitRecords;
    }
    function mergeNearbyExistingPointsIntoCreatedPoints(createdPoints) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(createdPoints) || !createdPoints.length) return;
        const createdSet = new Set(createdPoints.filter(Boolean));
        const tol = getUserSnapTolerancePx();
        createdPoints.forEach(created => {
            if (!created) return;
            const layer = parseInt(created.layer || 1, 10);
            const matches = activeGeometry.points.filter(existing =>
                existing &&
                existing !== created &&
                !createdSet.has(existing) &&
                parseInt(existing.layer || 1, 10) === layer &&
                Math.hypot((existing.x || 0) - created.x, (existing.y || 0) - created.y) <= tol
            );
            matches.forEach(existing => {
                activeGeometry.connections.forEach(conn => {
                    if (conn.start === existing) conn.start = created;
                    if (conn.end === existing) conn.end = created;
                });
                if (Array.isArray(activeGeometry.manualFaces)) {
                    activeGeometry.manualFaces.forEach(face => {
                        if (Array.isArray(face.points)) face.points = face.points.map(p => p === existing ? created : p);
                        if (Array.isArray(face.holes)) {
                            face.holes = face.holes.map(hole => Array.isArray(hole) ? hole.map(p => p === existing ? created : p) : hole);
                        }
                    });
                }
                if (typeof selectedPoints !== 'undefined' && selectedPoints.has(existing)) {
                    selectedPoints.delete(existing);
                    selectedPoints.add(created);
                }
            });
            if (matches.length) {
                activeGeometry.points = activeGeometry.points.filter(p => !matches.includes(p));
                activeGeometry.connections = activeGeometry.connections.filter(c => c && c.start && c.end && c.start !== c.end);
            }
        });
    }
    function sampleLevelZForLine(a, b, faces) {
        const samples = [];
        const count = 9;
        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1);
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            const dsmZ = getDSMZAtXY(x, y);
            if (Number.isFinite(dsmZ)) {
                samples.push(dsmZ);
                continue;
            }
            const hit = topFaceHitAtXY(x, y, faces || getStickerFaces());
            if (hit && Number.isFinite(hit.z)) samples.push(hit.z);
        }
        if (!samples.length) return (getPointZ(a) + getPointZ(b)) / 2;
        samples.sort((x, y) => x - y);
        return samples[Math.floor(samples.length / 2)];
    }
    function sampleLevelZAtCursor(cursor, fallbackA, fallbackB, faces) {
        if (cursor) {
            const dsmZ = getDSMZAtXY(cursor.x, cursor.y);
            if (Number.isFinite(dsmZ)) return dsmZ;
            const hit = topFaceHitAtXY(cursor.x, cursor.y, faces || getStickerFaces());
            if (hit && Number.isFinite(hit.z)) return hit.z;
        }
        if (fallbackA && fallbackB) return (getPointZ(fallbackA) + getPointZ(fallbackB)) / 2;
        if (fallbackA) return getPointZ(fallbackA);
        return 0;
    }
    function faceHasBoundaryLine(face, a, b) {
        if (!face || !a || !b || !Array.isArray(face.points) || face.points.length < 3) return false;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return pointOnPolygonBoundary2D(a, face.points, 0.2) &&
            pointOnPolygonBoundary2D(b, face.points, 0.2) &&
            pointOnPolygonBoundary2D(mid, face.points, 0.2);
    }
    function getCurvedFaceSplitTarget(cursor, baseA, baseB, faces) {
        const hit = topFaceHitAtXY(cursor.x, cursor.y, faces);
        if (!hit?.face || !faceHasBoundaryLine(hit.face, baseA, baseB)) return null;
        return hit;
    }
    function getSmartFaceLayerFaces(faces, layer) {
        const targetLayer = parseInt(layer || 1, 10);
        return (faces || []).filter(face => parseInt(face?.layer || 1, 10) === targetLayer);
    }
    function clipLineAcrossFace(face, center, dir, cursor) {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return null;
        const xs = face.points.map(p => p.x).filter(Number.isFinite);
        const ys = face.points.map(p => p.y).filter(Number.isFinite);
        if (!xs.length || !ys.length) return null;
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const span = Math.max(20, Math.hypot(maxX - minX, maxY - minY) * 2 + 20);
        const a = { x: center.x - dir.x * span, y: center.y - dir.y * span };
        const b = { x: center.x + dir.x * span, y: center.y + dir.y * span };
        const hits = [];
        const addHit = hit => {
            if (!hit) return;
            const t = dot2({ x: hit.x - center.x, y: hit.y - center.y }, dir);
            if (hits.some(h => Math.abs(h.t - t) < 0.05 || Math.hypot(h.x - hit.x, h.y - hit.y) < 0.05)) return;
            hits.push({ x: hit.x, y: hit.y, t });
        };
        const addRingHits = ring => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            for (let i = 0; i < ring.length; i++) {
                addHit(segmentIntersectionParam(a, b, ring[i], ring[(i + 1) % ring.length]));
            }
        };
        addRingHits(face.points);
        if (Array.isArray(face.holes)) face.holes.forEach(addRingHits);
        hits.sort((p, q) => p.t - q.t);
        if (hits.length < 2) return null;
        const cursorT = dot2({ x: cursor.x - center.x, y: cursor.y - center.y }, dir);
        const intervals = [];
        for (let i = 0; i < hits.length - 1; i++) {
            const h0 = hits[i], h1 = hits[i + 1];
            if (Math.abs(h1.t - h0.t) < 0.05) continue;
            const midT = (h0.t + h1.t) / 2;
            const mid = { x: center.x + dir.x * midT, y: center.y + dir.y * midT };
            if (!faceContainsXY(face, mid.x, mid.y)) continue;
            intervals.push({ a: h0, b: h1, contains: cursorT >= h0.t - 0.05 && cursorT <= h1.t + 0.05, dist: Math.abs(cursorT - midT), len: h1.t - h0.t });
        }
        if (!intervals.length) return null;
        intervals.sort((p, q) => {
            if (p.contains !== q.contains) return p.contains ? -1 : 1;
            if (Math.abs(p.dist - q.dist) > 0.05) return p.dist - q.dist;
            return q.len - p.len;
        });
        return intervals[0];
    }
    function getSmartFaceStationOffset(line, originMid, normal) {
        if (!line?.a || !line?.b || !originMid || !normal) return 0;
        const mid = { x: (line.a.x + line.b.x) / 2, y: (line.a.y + line.b.y) / 2 };
        return dot2({ x: mid.x - originMid.x, y: mid.y - originMid.y }, normal);
    }
    function getSmartFaceStationNeighbors(placement, newLine, normal) {
        const originLine = placement?.originLine || placement?.currentLine || null;
        if (!originLine?.a || !originLine?.b || !newLine?.a || !newLine?.b || !normal) return { stations: [], offset: 0, lower: null, upper: null };
        const originMid = { x: (originLine.a.x + originLine.b.x) / 2, y: (originLine.a.y + originLine.b.y) / 2 };
        const sourceStations = Array.isArray(placement.stationLines) && placement.stationLines.length
            ? placement.stationLines
            : [{ line: originLine, conn: placement.currentConn || null }];
        const stations = sourceStations
            .filter(st => st?.line?.a && st?.line?.b)
            .map(st => ({ ...st, offset: getSmartFaceStationOffset(st.line, originMid, normal) }))
            .sort((a, b) => a.offset - b.offset);
        const offset = getSmartFaceStationOffset(newLine, originMid, normal);
        let lower = null;
        let upper = null;
        stations.forEach(st => {
            if (st.offset < offset - 0.05) lower = st;
            else if (!upper && st.offset > offset + 0.05) upper = st;
        });
        return { stations, offset, lower, upper };
    }
    function smartFacePlaneFromQuad(quad) {
        if (!Array.isArray(quad) || quad.length < 3 || typeof calculatePlaneFromVertices !== 'function') return null;
        try {
            return calculatePlaneFromVertices(quad);
        } catch (e) {
            return null;
        }
    }
    function smartFaceLinePolygonIntervals(origin, dir, rings, containsFn) {
        const hits = [];
        const addHit = (hit) => {
            if (!hit) return;
            const t = dot2({ x: hit.x - origin.x, y: hit.y - origin.y }, dir);
            if (hits.some(h => Math.abs(h.t - t) < 0.05 || Math.hypot(h.x - hit.x, h.y - hit.y) < 0.05)) return;
            hits.push({ x: hit.x, y: hit.y, t });
        };
        const addRing = ring => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            const span = 100000;
            const a = { x: origin.x - dir.x * span, y: origin.y - dir.y * span };
            const b = { x: origin.x + dir.x * span, y: origin.y + dir.y * span };
            for (let i = 0; i < ring.length; i++) {
                addHit(segmentIntersectionParam(a, b, ring[i], ring[(i + 1) % ring.length]));
            }
        };
        (rings || []).forEach(addRing);
        hits.sort((a, b) => a.t - b.t);
        const intervals = [];
        for (let i = 0; i < hits.length - 1; i++) {
            const h0 = hits[i], h1 = hits[i + 1];
            if (Math.abs(h1.t - h0.t) < 0.05) continue;
            const midT = (h0.t + h1.t) / 2;
            const mid = { x: origin.x + dir.x * midT, y: origin.y + dir.y * midT };
            if (containsFn(mid)) intervals.push({ t0: h0.t, t1: h1.t });
        }
        return intervals;
    }
    function smartFaceIntervalOverlap(a, b) {
        const t0 = Math.max(a.t0, b.t0);
        const t1 = Math.min(a.t1, b.t1);
        return (t1 - t0 > 0.1) ? { t0, t1 } : null;
    }
    function smartFacePointOnPlane(origin, dir, t, plane, layer) {
        const x = origin.x + dir.x * t;
        const y = origin.y + dir.y * t;
        const z = plane.a * x + plane.b * y + plane.c;
        return { x, y, z, layer, zLocked: true };
    }
    function smartFaceMergeCandidatePoint(points, candidate, tol) {
        const match = points.find(p => p && Math.hypot((p.x || 0) - candidate.x, (p.y || 0) - candidate.y) <= tol);
        if (match) return match;
        points.push(candidate);
        return candidate;
    }
    function smartFaceSnapIntersectionPoint(candidate, face, pointPool, layer, tol) {
        if (!candidate || !face || !Array.isArray(face.points)) return candidate;
        let bestPoint = null;
        let bestPointD = tol;
        face.points.forEach(p => {
            if (!p) return;
            const d = Math.hypot((p.x || 0) - candidate.x, (p.y || 0) - candidate.y);
            if (d <= bestPointD) {
                bestPoint = p;
                bestPointD = d;
            }
        });
        if (bestPoint) return bestPoint;
        let bestEdge = null;
        let bestEdgeProj = null;
        let bestEdgeD = tol;
        const inspectRing = ring => {
            if (!Array.isArray(ring) || ring.length < 2) return;
            for (let i = 0; i < ring.length; i++) {
                const a = ring[i];
                const b = ring[(i + 1) % ring.length];
                if (!a || !b) continue;
                const proj = projectPointToSegment2D(candidate, a, b);
                if (proj.t <= 1e-5 || proj.t >= 1 - 1e-5 || proj.d > bestEdgeD) continue;
                const edgeZ = getPointZ(a) + (getPointZ(b) - getPointZ(a)) * proj.t;
                if (Math.abs(edgeZ - candidate.z) > 1.5) continue;
                bestEdge = { a, b, z: edgeZ };
                bestEdgeProj = proj;
                bestEdgeD = proj.d;
            }
        };
        inspectRing(face.points);
        if (Array.isArray(face.holes)) face.holes.forEach(inspectRing);
        if (!bestEdge || !bestEdgeProj) return candidate;
        const edgePoint = {
            x: bestEdgeProj.x,
            y: bestEdgeProj.y,
            z: bestEdge.z,
            layer: parseInt(bestEdge.a.layer || bestEdge.b.layer || layer || 1, 10),
            zLocked: true
        };
        return smartFaceMergeCandidatePoint(pointPool, edgePoint, tol);
    }
    function addSmartFacePlaneIntersections(geo, faces) {
        if (!geo || geo.mode === 'splitFace' || !geo.stationPlan || !Array.isArray(geo.lines)) return;
        const layer = parseInt(geo.nextA?.layer || geo.nextB?.layer || 1, 10);
        const stationPairs = [];
        if (geo.stationPlan.lower?.line) stationPairs.push({ a0: geo.stationPlan.lower.line.a, b0: geo.stationPlan.lower.line.b, a1: geo.nextA, b1: geo.nextB });
        if (geo.stationPlan.upper?.line) stationPairs.push({ a0: geo.nextA, b0: geo.nextB, a1: geo.stationPlan.upper.line.a, b1: geo.stationPlan.upper.line.b });
        if (!stationPairs.length) return;
        const tol = Math.max(0.25, getUserSnapTolerancePx() * 0.35);
        const pointPool = [...(geo.allPoints || [])];
        const intersectionLines = [];
        stationPairs.forEach(pair => {
            const quad = [pair.a0, pair.b0, pair.b1, pair.a1];
            const plane = smartFacePlaneFromQuad(quad);
            if (!plane) return;
            (faces || []).forEach(face => {
                if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
                const otherPlane = getFacePlaneSafe(face);
                if (!otherPlane || planesClose(plane, otherPlane)) return;
                const A = (plane.a || 0) - (otherPlane.a || 0);
                const B = (plane.b || 0) - (otherPlane.b || 0);
                const C = (plane.c || 0) - (otherPlane.c || 0);
                const denom = A * A + B * B;
                if (denom < 1e-12) return;
                const origin = { x: -A * C / denom, y: -B * C / denom };
                const dir = norm({ x: -B, y: A });
                const newIntervals = smartFaceLinePolygonIntervals(origin, dir, [quad], p => pointInsideOrOnPoly2D(p, quad));
                if (!newIntervals.length) return;
                const otherRings = [face.points, ...(Array.isArray(face.holes) ? face.holes : [])];
                const otherIntervals = smartFaceLinePolygonIntervals(origin, dir, otherRings, p => faceContainsXY(face, p.x, p.y));
                if (!otherIntervals.length) return;
                newIntervals.forEach(ni => {
                    otherIntervals.forEach(oi => {
                        const overlap = smartFaceIntervalOverlap(ni, oi);
                        if (!overlap) return;
                        const raw0 = smartFacePointOnPlane(origin, dir, overlap.t0, plane, layer);
                        const raw1 = smartFacePointOnPlane(origin, dir, overlap.t1, plane, layer);
                        const snapped0 = smartFaceSnapIntersectionPoint(raw0, face, pointPool, layer, tol);
                        const snapped1 = smartFaceSnapIntersectionPoint(raw1, face, pointPool, layer, tol);
                        const p0 = smartFaceMergeCandidatePoint(pointPool, snapped0, tol);
                        const p1 = smartFaceMergeCandidatePoint(pointPool, snapped1, tol);
                        if (p0 && p1 && p0 !== p1 && Math.hypot(p0.x - p1.x, p0.y - p1.y) > 0.1) {
                            intersectionLines.push({ a: p0, b: p1, type: null, smartIntersection: true, smartIntersectionFace: face, smartIntersectionQuad: quad, smartIntersectionPlane: plane });
                        }
                    });
                });
            });
        });
        if (!intersectionLines.length) return;
        geo.intersectionLines = intersectionLines;
        geo.lines.push(...intersectionLines);
        geo.allPoints = pointPool;
    }
    function splitSmartFaceGeoLinesAtPoints(geo) {
        if (!geo || !Array.isArray(geo.lines) || !Array.isArray(geo.allPoints) || !geo.allPoints.length) return;
        const splitters = geo.allPoints;
        const splitLine = (ln) => {
            if (!ln || !ln.a || !ln.b || ln.smartIntersection) return [ln];
            const hits = [];
            splitters.forEach(p => {
                if (!p || p === ln.a || p === ln.b) return;
                const proj = projectPointToSegment2D(p, ln.a, ln.b);
                if (proj.t <= 1e-5 || proj.t >= 1 - 1e-5 || proj.d > 0.2) return;
                p.x = proj.x;
                p.y = proj.y;
                hits.push({ point: p, t: proj.t });
            });
            if (!hits.length) return [ln];
            hits.sort((a, b) => a.t - b.t);
            const chain = [ln.a, ...hits.map(h => h.point), ln.b];
            const out = [];
            for (let i = 0; i < chain.length - 1; i++) {
                if (chain[i] && chain[i + 1] && chain[i] !== chain[i + 1]) {
                    out.push({ a: chain[i], b: chain[i + 1], type: ln.type || null });
                }
            }
            return out;
        };
        geo.lines = geo.lines.flatMap(splitLine);
    }
    function smartFacePointEquals(a, b, tol = 0.2) {
        return !!(a && b && (a === b || Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0)) <= tol));
    }
    function smartFaceInsertPointIntoRing(ring, point, tol = 0.2) {
        if (!Array.isArray(ring) || !point) return { ring: ring || [], index: -1 };
        const existingIdx = ring.findIndex(p => smartFacePointEquals(p, point, tol));
        if (existingIdx >= 0) return { ring: ring.slice(), index: existingIdx };
        let bestIdx = -1;
        let bestProj = null;
        let bestD = tol;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const proj = projectPointToSegment2D(point, a, b);
            if (proj.t <= 1e-5 || proj.t >= 1 - 1e-5 || proj.d > bestD) continue;
            bestIdx = i;
            bestProj = proj;
            bestD = proj.d;
        }
        if (bestIdx < 0) return { ring: ring.slice(), index: -1 };
        point.x = bestProj.x;
        point.y = bestProj.y;
        const out = ring.slice();
        out.splice(bestIdx + 1, 0, point);
        return { ring: out, index: bestIdx + 1 };
    }
    function smartFaceRingPath(ring, fromIdx, toIdx) {
        const out = [];
        let i = fromIdx;
        let guard = 0;
        while (guard++ < ring.length + 2) {
            out.push(ring[i]);
            if (i === toIdx) break;
            i = (i + 1) % ring.length;
        }
        return out;
    }
    function smartFaceValidRemainingLoop(path, referencePlane) {
        if (!Array.isArray(path) || path.length < 3 || polyAreaAbs(path) < 0.5) return false;
        const plane = smartFacePlaneFromQuad(path);
        if (!plane || !referencePlane) return !!plane;
        return path.every(p => {
            const z = plane.a * p.x + plane.b * p.y + plane.c;
            const rz = referencePlane.a * p.x + referencePlane.b * p.y + referencePlane.c;
            return Number.isFinite(z) && Number.isFinite(rz) && Math.abs(z - rz) < 1.0;
        });
    }
    function smartFaceTrimIntersectedFaces(geo) {
        if (!geo || geo.mode === 'splitFace' || !Array.isArray(geo.intersectionLines) || !geo.intersectionLines.length) return;
        const pointsToDelete = new Set();
        const faceUpdates = [];
        geo.intersectionLines.forEach(ln => {
            const face = ln.smartIntersectionFace;
            const quad = ln.smartIntersectionQuad;
            const plane = ln.smartIntersectionPlane;
            if (!face || !Array.isArray(face.points) || face.points.length < 3 || !quad || !plane) return;
            let inserted = smartFaceInsertPointIntoRing(face.points, ln.a);
            if (inserted.index < 0) return;
            inserted = smartFaceInsertPointIntoRing(inserted.ring, ln.b);
            if (inserted.index < 0) return;
            const ring = inserted.ring;
            const iA = ring.findIndex(p => smartFacePointEquals(p, ln.a));
            const iB = ring.findIndex(p => smartFacePointEquals(p, ln.b));
            if (iA < 0 || iB < 0 || iA === iB) return;
            const pathAB = smartFaceRingPath(ring, iA, iB);
            const pathBA = smartFaceRingPath(ring, iB, iA);
            const coveredScore = path => path.reduce((score, p) => {
                if (p === ln.a || p === ln.b) return score;
                const under = pointInsideOrOnPoly2D(p, quad) && getPointZ(p) <= (plane.a * p.x + plane.b * p.y + plane.c) + 0.5;
                return score + (under ? 1 : 0);
            }, 0);
            const scoreAB = coveredScore(pathAB);
            const scoreBA = coveredScore(pathBA);
            if (scoreAB <= 0 && scoreBA <= 0) return;
            const coveredPath = scoreAB >= scoreBA ? pathAB : pathBA;
            const remainingPath = scoreAB >= scoreBA ? pathBA : pathAB;
            const facePlane = getFacePlaneSafe(face);
            if (!smartFaceValidRemainingLoop(remainingPath, facePlane)) return;
            const originalFacePoints = new Set(face.points || []);
            const candidates = [];
            coveredPath.forEach(p => {
                if (p === ln.a || p === ln.b || !originalFacePoints.has(p)) return;
                const newFaceZ = plane.a * p.x + plane.b * p.y + plane.c;
                const under = pointInsideOrOnPoly2D(p, quad) && Number.isFinite(newFaceZ) && getPointZ(p) < newFaceZ - 0.05;
                if (under) candidates.push(p);
            });
            if (!candidates.length) return;
            candidates.forEach(p => pointsToDelete.add(p));
            faceUpdates.push({ face, remainingPath: remainingPath.slice() });
        });
        if (pointsToDelete.size) {
            activeGeometry.connections = activeGeometry.connections.filter(conn => !pointsToDelete.has(conn.start) && !pointsToDelete.has(conn.end));
            activeGeometry.points = activeGeometry.points.filter(p => !pointsToDelete.has(p));
            if (typeof selectedPoints !== 'undefined') pointsToDelete.forEach(p => selectedPoints.delete(p));
        }
        if (faceUpdates.length && Array.isArray(activeGeometry.manualFaces)) {
            faceUpdates.forEach(update => {
                const sigOf = pts => (typeof getLocalFaceSignature === 'function') ? getLocalFaceSignature(pts) : pts.map(coordKey).sort().join('|');
                const faceSig = sigOf(update.face.points || []);
                const mf = activeGeometry.manualFaces.find(item => item && Array.isArray(item.points) && sigOf(item.points) === faceSig);
                if (mf) mf.points = update.remainingPath;
            });
        }
    }
    function smartFaceLineKey(a, b) {
        const ka = coordKey(a);
        const kb = coordKey(b);
        return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    }
    function smartFaceAnchorLineForLoop(geo) {
        const candidates = [geo.stationPlan?.lower, geo.stationPlan?.upper]
            .filter(st => st?.line?.a && st?.line?.b && Number.isFinite(st.offset));
        if (!candidates.length) return (geo?.originLine?.a && geo?.originLine?.b) ? geo.originLine : null;
        const targetOffset = Number.isFinite(geo.stationPlan?.offset) ? geo.stationPlan.offset : 0;
        candidates.sort((a, b) => Math.abs(a.offset - targetOffset) - Math.abs(b.offset - targetOffset));
        return candidates[0].line;
    }
    function smartFaceAnchorLinesForLoops(geo) {
        const anchors = [];
        const add = line => {
            if (!line?.a || !line?.b || line.a === line.b) return;
            if (anchors.some(existing => smartFaceLineKey(existing.a, existing.b) === smartFaceLineKey(line.a, line.b))) return;
            anchors.push(line);
        };
        (geo.stationPlan?.stations || []).forEach(st => add(st.line));
        add(geo.stationPlan?.lower?.line);
        add(geo.stationPlan?.upper?.line);
        add(geo.originLine);
        return anchors;
    }
    function smartFaceCycleArea(nodes) {
        let area = 0;
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i].point;
            const b = nodes[(i + 1) % nodes.length].point;
            area += (a.x * b.y - b.x * a.y);
        }
        return area / 2;
    }
    function findSmartFaceLoops(lines) {
        const nodeMap = new Map();
        const nodeFor = p => {
            const key = coordKey(p);
            if (!nodeMap.has(key)) nodeMap.set(key, { key, point: p, adj: [] });
            return nodeMap.get(key);
        };
        const edgeByDir = new Map();
        (lines || []).forEach((ln, idx) => {
            if (!ln?.a || !ln?.b || ln.a === ln.b) return;
            const a = nodeFor(ln.a);
            const b = nodeFor(ln.b);
            if (a.key === b.key) return;
            a.adj.push(b);
            b.adj.push(a);
            edgeByDir.set(`${a.key}>${b.key}`, { line: ln, idx });
            edgeByDir.set(`${b.key}>${a.key}`, { line: ln, idx });
        });
        nodeMap.forEach(node => {
            const seen = new Set();
            node.adj = node.adj
                .filter(n => {
                    if (seen.has(n.key)) return false;
                    seen.add(n.key);
                    return true;
                })
                .sort((a, b) =>
                    Math.atan2(a.point.y - node.point.y, a.point.x - node.point.x) -
                    Math.atan2(b.point.y - node.point.y, b.point.x - node.point.x)
                );
        });
        const visited = new Set();
        const loops = [];
        nodeMap.forEach(start => {
            start.adj.forEach(nextStart => {
                const startDir = `${start.key}>${nextStart.key}`;
                if (visited.has(startDir)) return;
                const nodes = [];
                const edgeIdxs = [];
                let prev = start;
                let curr = nextStart;
                let guard = 0;
                while (prev && curr && guard++ < 500) {
                    const dirKey = `${prev.key}>${curr.key}`;
                    if (visited.has(dirKey) && dirKey !== startDir) break;
                    visited.add(dirKey);
                    nodes.push(prev);
                    const edge = edgeByDir.get(dirKey);
                    if (edge) edgeIdxs.push(edge.idx);
                    const adj = curr.adj || [];
                    const backIdx = adj.findIndex(n => n.key === prev.key);
                    if (backIdx < 0 || !adj.length) break;
                    const nextIdx = (backIdx - 1 + adj.length) % adj.length;
                    const next = adj[nextIdx];
                    prev = curr;
                    curr = next;
                    if (prev.key === start.key && curr.key === nextStart.key) {
                        const area = smartFaceCycleArea(nodes);
                        if (Math.abs(area) > 0.5) loops.push({ nodes: nodes.slice(), edgeIdxs: edgeIdxs.slice(), area });
                        break;
                    }
                }
            });
        });
        return loops;
    }
    function pruneSmartFaceToClosestClosedLoop(geo) {
        if (!geo || geo.mode === 'splitFace' || !Array.isArray(geo.intersectionLines) || !geo.intersectionLines.length) return;
        const anchors = smartFaceAnchorLinesForLoops(geo);
        if (!anchors.length) return;
        const anchorLines = anchors.map(anchor => ({ a: anchor.a, b: anchor.b, type: null, smartAnchor: true }));
        const tempLines = [...anchorLines, ...(geo.lines || [])];
        const loops = findSmartFaceLoops(tempLines);
        if (!loops.length) return;
        const anchorKeys = new Set(anchors.map(anchor => smartFaceLineKey(anchor.a, anchor.b)));
        const currentKey = geo.currentLine?.a && geo.currentLine?.b ? smartFaceLineKey(geo.currentLine.a, geo.currentLine.b) : null;
        const loopScore = loop => {
            let anchorHits = 0;
            let currentHits = 0;
            let intersectionHits = 0;
            for (let i = 0; i < loop.nodes.length; i++) {
                const a = loop.nodes[i].point;
                const b = loop.nodes[(i + 1) % loop.nodes.length].point;
                const key = smartFaceLineKey(a, b);
                if (anchorKeys.has(key)) anchorHits++;
                if (currentKey && key === currentKey) currentHits++;
            }
            (loop.edgeIdxs || []).forEach(idx => {
                if (tempLines[idx]?.smartIntersection) intersectionHits++;
            });
            return { anchorHits, currentHits, intersectionHits, area: Math.abs(loop.area) };
        };
        const anchorLoops = loops
            .map(loop => ({ loop, score: loopScore(loop) }))
            .filter(item => item.score.anchorHits > 0)
            .sort((a, b) => a.score.area - b.score.area);
        const insertedBetweenStations = !!(geo.stationPlan?.lower?.line && geo.stationPlan?.upper?.line);
        const intersectionOnlyLoops = anchorLoops.filter(item => item.score.currentHits === 0 && item.score.intersectionHits > 0);
        const qualifying = !insertedBetweenStations && intersectionOnlyLoops.length
            ? intersectionOnlyLoops
            : anchorLoops;
        if (!qualifying.length) return;
        const keepIdxs = new Set();
        qualifying.forEach(item => item.loop.edgeIdxs.forEach(idx => keepIdxs.add(idx)));
        const anchorCount = anchorLines.length;
        geo.lines = geo.lines.filter((ln, idx) => keepIdxs.has(idx + anchorCount));
        geo.intersectionLines = geo.intersectionLines.filter(ln => geo.lines.includes(ln));
        const used = new Set();
        geo.lines.forEach(ln => {
            if (ln?.a) used.add(ln.a);
            if (ln?.b) used.add(ln.b);
        });
        geo.allPoints = (geo.allPoints || []).filter(p => used.has(p) || p === geo.nextA || p === geo.nextB);
    }
    function computeCurvedFaceGeometry(clientX, clientY, spec) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return null;
        if (typeof screenToImage !== 'function') return null;
        const placement = spec._placement || null;
        const lineHit = getDutchGableLineHit(clientX, clientY);
        if (!placement || !placement.currentLine) {
            if (!lineHit) return null;
            return {
                phase: 'select',
                lineHit,
                lines: [{ a: lineHit.conn.start, b: lineHit.conn.end, type: lineHit.conn.type || null }],
                points: [{ x: lineHit.point.x, y: lineHit.point.y, r: 4.5 }]
            };
        }
        const cursor = screenToImage(clientX, clientY);
        const originLine = placement.originLine || placement.currentLine;
        const baseA = originLine.a;
        const baseB = originLine.b;
        if (!baseA || !baseB || baseA === baseB) return null;
        const dir = norm({ x: baseB.x - baseA.x, y: baseB.y - baseA.y });
        let normal = placement.normal || rot90(dir, 1);
        const mid = { x: (baseA.x + baseB.x) / 2, y: (baseA.y + baseB.y) / 2 };
        let offset = dot2({ x: cursor.x - mid.x, y: cursor.y - mid.y }, normal);
        if (Math.abs(offset) < 0.5) offset = offset < 0 ? -0.5 : 0.5;
        if (!placement.normal && offset < 0) {
            normal = { x: -normal.x, y: -normal.y };
            offset = Math.abs(offset);
        }
        const nextAxy = { x: baseA.x + normal.x * offset, y: baseA.y + normal.y * offset };
        const nextBxy = { x: baseB.x + normal.x * offset, y: baseB.y + normal.y * offset };
        const sourceLayer = parseInt(placement.layer || baseA.layer || baseB.layer || 1, 10);
        const faces = getSmartFaceLayerFaces(getStickerFaces(), sourceLayer);
        const hasCreatedStations = Array.isArray(placement.stationLines) && placement.stationLines.length > 1;
        const allowSplitTarget = placement.mode !== 'newFace' && !hasCreatedStations;
        const splitTarget = placement.splitFace || (allowSplitTarget ? getCurvedFaceSplitTarget(cursor, baseA, baseB, faces) : null);
        if (splitTarget?.face) {
            const center = { x: (nextAxy.x + nextBxy.x) / 2, y: (nextAxy.y + nextBxy.y) / 2 };
            const clipped = clipLineAcrossFace(splitTarget.face, center, dir, cursor);
            if (clipped) {
                const levelZ = sampleLevelZAtCursor(cursor, baseA, baseB, faces);
                const layer = parseInt(splitTarget.face.layer || baseA.layer || baseB.layer || 1, 10);
                const nextA = { x: clipped.a.x, y: clipped.a.y, z: levelZ, layer, zLocked: true };
                const nextB = { x: clipped.b.x, y: clipped.b.y, z: levelZ, layer, zLocked: true };
                const line = { a: nextA, b: nextB, type: null };
                return {
                    phase: 'place',
                    mode: 'splitFace',
                    splitFace: splitTarget,
                    lineHit,
                    baseA,
                    baseB,
                    nextA,
                    nextB,
                    normal,
                    lines: [line],
                    allPoints: [nextA, nextB],
                    currentLine: { a: nextA, b: nextB }
                };
            }
        }
        const z = sampleLevelZAtCursor(cursor, baseA, baseB, faces);
        const layer = parseInt(baseA.layer || baseB.layer || 1, 10);
        const nextA = { x: nextAxy.x, y: nextAxy.y, z, layer, zLocked: true };
        const nextB = { x: nextBxy.x, y: nextBxy.y, z, layer, zLocked: true };
        const currentLine = { a: nextA, b: nextB };
        const stationPlan = getSmartFaceStationNeighbors(placement, currentLine, normal);
        const lines = [];
        if (stationPlan.lower?.line) {
            lines.push({ a: stationPlan.lower.line.a, b: nextA, type: null });
            lines.push({ a: stationPlan.lower.line.b, b: nextB, type: null });
        }
        if (stationPlan.upper?.line) {
            lines.push({ a: nextA, b: stationPlan.upper.line.a, type: null });
            lines.push({ a: nextB, b: stationPlan.upper.line.b, type: null });
        }
        lines.push({ a: nextA, b: nextB, type: null });
        const geo = {
            phase: 'place',
            lineHit,
            baseA,
            baseB,
            nextA,
            nextB,
            normal,
            originLine,
            lines,
            allPoints: [nextA, nextB],
            currentLine,
            stationPlan
        };
        addSmartFacePlaneIntersections(geo, faces);
        splitSmartFaceGeoLinesAtPoints(geo);
        pruneSmartFaceToClosestClosedLoop(geo);
        return geo;
    }
    function buildCurvedFacePreview(geo) {
        if (!geo) return { enabled: false };
        return {
            enabled: true,
            lines: (geo.lines || []).map(ln => ({
                a: ln.a,
                b: ln.b,
                w: ln.smartIntersection ? 2.3 : 2.7,
                dash: ln.smartIntersection || !ln.type,
                color: geo.phase === 'select'
                    ? 'rgba(255,193,7,0.9)'
                    : (ln.smartIntersection ? 'rgba(0,255,255,0.95)' : (geo.mode === 'splitFace' ? 'rgba(255,193,7,0.98)' : 'rgba(255,255,255,0.82)'))
            })),
            points: (geo.points || geo.allPoints || []).map(p => ({
                x: p.x,
                y: p.y,
                r: p.r || 3.5,
                fill: 'rgba(255,193,7,0.9)',
                stroke: '#fff'
            }))
        };
    }
    function commitCurvedFaceSegment(geo) {
        if (!geo || geo.phase !== 'place' || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return false;
        if (typeof save2DState === 'function') save2DState();
        geo.allPoints.forEach(p => {
            if (p && !activeGeometry.points.includes(p)) activeGeometry.points.push(p);
        });
        if (geo.mode === 'splitFace') {
            splitExistingLinesAtPointsPreserveZ(geo.allPoints);
            mergeNearbyExistingPointsIntoCreatedPoints(geo.allPoints);
        } else if (Array.isArray(geo.intersectionLines) && geo.intersectionLines.length) {
            const intersectionPoints = [];
            geo.intersectionLines.forEach(ln => {
                if (ln?.a) intersectionPoints.push(ln.a);
                if (ln?.b) intersectionPoints.push(ln.b);
            });
            splitExistingLinesAtPointsPreserveZ(intersectionPoints);
            smartFaceTrimIntersectedFaces(geo);
        }
        if (geo.mode !== 'splitFace' && geo.stationPlan?.lower?.line && geo.stationPlan?.upper?.line) {
            const lower = geo.stationPlan.lower.line;
            const upper = geo.stationPlan.upper.line;
            activeGeometry.connections = activeGeometry.connections.filter(conn =>
                !connectionMatchesDormerEdge(conn, lower.a, upper.a) &&
                !connectionMatchesDormerEdge(conn, lower.b, upper.b)
            );
        }
        geo.lines.forEach(ln => {
            if (!ln || !ln.a || !ln.b || ln.a === ln.b || getExistingConnectionBetween(ln.a, ln.b)) return;
            activeGeometry.connections.push({ start: ln.a, end: ln.b, type: ln.type || null });
        });
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                geo.allPoints.forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    function getDutchGablePointHit(clientX, clientY) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return null;
        if (typeof screenToImage !== 'function') return null;
        const img = screenToImage(clientX, clientY);
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const sRad = sr / cz;
        const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
        let point = null;
        let bestD = sRad;
        activeGeometry.points.forEach(p => {
            if (!p) return;
            const layer = p.layer || 1;
            if (vis[layer] === false) return;
            const d = Math.hypot((p.x || 0) - img.x, (p.y || 0) - img.y);
            if (d < bestD) {
                bestD = d;
                point = p;
            }
        });
        if (!point) return null;
        const layer = point.layer || 1;
        const conns = activeGeometry.connections.filter(conn => {
            if (!conn || !conn.start || !conn.end) return false;
            if (vis[conn.start.layer || 1] === false) return false;
            if ((conn.start.layer || 1) !== layer && (conn.end.layer || 1) !== layer) return false;
            return conn.start === point || conn.end === point;
        });
        if (conns.length < 2) return null;
        const items = conns
            .map(conn => ({ conn, other: conn.start === point ? conn.end : conn.start }))
            .filter(item => item.other && item.other !== point);
        if (items.length < 2) return null;
        return { point, conns: items.map(item => item.conn), items };
    }
    function getDutchGableLineHit(clientX, clientY) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return null;
        if (typeof screenToImage !== 'function') return null;
        const img = screenToImage(clientX, clientY);
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const sRad = sr / cz;
        const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
        let best = null;
        let bestD = sRad;
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            if (vis[conn.start.layer || 1] === false) return;
            const proj = projectPointToSegment2D(img, conn.start, conn.end);
            if (!proj || proj.t <= 0.02 || proj.t >= 0.98 || proj.d >= bestD) return;
            bestD = proj.d;
            best = { conn, point: { x: proj.x, y: proj.y }, t: proj.t };
        });
        return best;
    }
    function chooseDutchGableLinePair(point, items, cursor) {
        if (!point || !Array.isArray(items) || items.length < 2 || !cursor) return null;
        const cursorVec = { x: cursor.x - point.x, y: cursor.y - point.y };
        const cursorLen = Math.hypot(cursorVec.x, cursorVec.y);
        if (!(cursorLen > 1e-6)) return null;
        const cDir = { x: cursorVec.x / cursorLen, y: cursorVec.y / cursorLen };
        const enriched = items.map(item => ({
            ...item,
            dir: norm({ x: item.other.x - point.x, y: item.other.y - point.y })
        }));
        if (enriched.length === 2) return { items: enriched, score: 0 };
        const tau = Math.PI * 2;
        const angleOf = dir => {
            const a = Math.atan2(dir.y, dir.x);
            return a < 0 ? a + tau : a;
        };
        const sorted = enriched
            .map(item => ({ ...item, angle: angleOf(item.dir) }))
            .sort((a, b) => a.angle - b.angle);
        const cAngle = angleOf(cDir);
        for (let i = 0; i < sorted.length; i++) {
            const a = sorted[i];
            const b = sorted[(i + 1) % sorted.length];
            const start = a.angle;
            const end = (i === sorted.length - 1) ? b.angle + tau : b.angle;
            const cursorAngle = cAngle < start ? cAngle + tau : cAngle;
            if (cursorAngle >= start - 1e-9 && cursorAngle <= end + 1e-9) {
                return { items: [a, b], score: Math.min(cursorAngle - start, end - cursorAngle) };
            }
        }
        return null;
    }
    function intersectInfiniteLines2D(p, r, q, s) {
        const denom = cross2(r, s);
        if (Math.abs(denom) < 1e-9) return null;
        const qp = { x: q.x - p.x, y: q.y - p.y };
        const t = cross2(qp, s) / denom;
        const u = cross2(qp, r) / denom;
        return {
            t,
            u,
            x: p.x + r.x * t,
            y: p.y + r.y * t
        };
    }
    function computeDutchGableFromLineGeometry(clientX, clientY, placement) {
        if (!placement || !placement.lineConn || !activeGeometry.connections.includes(placement.lineConn)) return null;
        if (typeof screenToImage !== 'function') return null;
        const conn = placement.lineConn;
        const a = conn.start;
        const b = conn.end;
        if (!a || !b || a === b) return null;
        const cursor = screenToImage(clientX, clientY);
        const baseDir = norm({ x: b.x - a.x, y: b.y - a.y });
        let normal = rot90(baseDir, 1);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const signedDist = dot2({ x: cursor.x - mid.x, y: cursor.y - mid.y }, normal);
        if (signedDist < 0) normal = { x: -normal.x, y: -normal.y };
        const baseLen = dist(a, b);
        const minDepth = Math.max(1, baseLen * 0.05);
        const maxDepth = Math.max(minDepth, baseLen * 0.48);
        const rawDepth = Math.max(minDepth, Math.min(maxDepth, Math.abs(signedDist)));
        
        if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
        
        let snappedDepth = rawDepth;
        let bestSnapDist = Infinity;
        let snapGuideToRender = null;
        
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        
        if (snappingOn && typeof activeGeometry !== 'undefined' && activeGeometry && Array.isArray(activeGeometry.points)) {
            const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
            const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
            const snapTol = sr / cz;
            const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
            
            const exclude = new Set([a, b]);
            const vLeft = { x: baseDir.x + normal.x, y: baseDir.y + normal.y };
            const vRight = { x: -baseDir.x + normal.x, y: -baseDir.y + normal.y };

            const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
            const cx = (typeof imageWidth !== 'undefined') ? imageWidth / 2 : 0;
            const cy = (typeof imageHeight !== 'undefined') ? imageHeight / 2 : 0;
            const cos = Math.cos(rot);
            const sin = Math.sin(rot);

            const toRotated = (p) => {
                const dx = p.x - cx;
                const dy = p.y - cy;
                return {
                    x: dx * cos - dy * sin + cx,
                    y: dx * sin + dy * cos + cy
                };
            };

            const toRotatedVector = (v) => {
                return {
                    x: v.x * cos - v.y * sin,
                    y: v.x * sin + v.y * cos
                };
            };

            const aRot = toRotated(a);
            const bRot = toRotated(b);
            const vLeftRot = toRotatedVector(vLeft);
            const vRightRot = toRotatedVector(vRight);
            
            activeGeometry.points.forEach(otherPt => {
                if (!otherPt || exclude.has(otherPt)) return;
                const otherLayer = otherPt.layer || 1;
                if (vis[otherLayer] === false) return;
                
                const otherRot = toRotated(otherPt);

                // Align frontLeft (along vLeft):
                // Vertically (same X): frontLeftRot.x = otherPtRot.x
                if (Math.abs(vLeftRot.x) > 1e-5) {
                    const d = (otherRot.x - aRot.x) / vLeftRot.x;
                    if (d >= minDepth && d <= maxDepth) {
                        const unsnappedFrontLeftX = a.x + vLeft.x * rawDepth;
                        const unsnappedFrontLeftY = a.y + vLeft.y * rawDepth;
                        const snappedFrontLeftX = a.x + vLeft.x * d;
                        const snappedFrontLeftY = a.y + vLeft.y * d;
                        const distMoved = Math.hypot(snappedFrontLeftX - unsnappedFrontLeftX, snappedFrontLeftY - unsnappedFrontLeftY);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            snappedDepth = d;
                            snapGuideToRender = { p1: otherPt, p2: { x: snappedFrontLeftX, y: snappedFrontLeftY } };
                        }
                    }
                }
                // Horizontally (same Y): frontLeftRot.y = otherPtRot.y
                if (Math.abs(vLeftRot.y) > 1e-5) {
                    const d = (otherRot.y - aRot.y) / vLeftRot.y;
                    if (d >= minDepth && d <= maxDepth) {
                        const unsnappedFrontLeftX = a.x + vLeft.x * rawDepth;
                        const unsnappedFrontLeftY = a.y + vLeft.y * rawDepth;
                        const snappedFrontLeftX = a.x + vLeft.x * d;
                        const snappedFrontLeftY = a.y + vLeft.y * d;
                        const distMoved = Math.hypot(snappedFrontLeftX - unsnappedFrontLeftX, snappedFrontLeftY - unsnappedFrontLeftY);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            snappedDepth = d;
                            snapGuideToRender = { p1: otherPt, p2: { x: snappedFrontLeftX, y: snappedFrontLeftY } };
                        }
                    }
                }
                
                // Align frontRight (along vRight):
                // Vertically (same X): frontRightRot.x = otherPtRot.x
                if (Math.abs(vRightRot.x) > 1e-5) {
                    const d = (otherRot.x - bRot.x) / vRightRot.x;
                    if (d >= minDepth && d <= maxDepth) {
                        const unsnappedFrontRightX = b.x + vRight.x * rawDepth;
                        const unsnappedFrontRightY = b.y + vRight.y * rawDepth;
                        const snappedFrontRightX = b.x + vRight.x * d;
                        const snappedFrontRightY = b.y + vRight.y * d;
                        const distMoved = Math.hypot(snappedFrontRightX - unsnappedFrontRightX, snappedFrontRightY - unsnappedFrontRightY);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            snappedDepth = d;
                            snapGuideToRender = { p1: otherPt, p2: { x: snappedFrontRightX, y: snappedFrontRightY } };
                        }
                    }
                }
                // Horizontally (same Y): frontRightRot.y = otherPtRot.y
                if (Math.abs(vRightRot.y) > 1e-5) {
                    const d = (otherRot.y - bRot.y) / vRightRot.y;
                    if (d >= minDepth && d <= maxDepth) {
                        const unsnappedFrontRightX = b.x + vRight.x * rawDepth;
                        const unsnappedFrontRightY = b.y + vRight.y * rawDepth;
                        const snappedFrontRightX = b.x + vRight.x * d;
                        const snappedFrontRightY = b.y + vRight.y * d;
                        const distMoved = Math.hypot(snappedFrontRightX - unsnappedFrontRightX, snappedFrontRightY - unsnappedFrontRightY);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            snappedDepth = d;
                            snapGuideToRender = { p1: otherPt, p2: { x: snappedFrontRightX, y: snappedFrontRightY } };
                        }
                    }
                }
            });
        }
        
        if (snapGuideToRender && typeof activeSnapGuides !== 'undefined') {
            activeSnapGuides.push(snapGuideToRender);
        }
        
        const depth = snappedDepth;
        const layer = parseInt(a.layer || b.layer || 1, 10);
        const zaRaw = getPointZ(a);
        const zbRaw = getPointZ(b);
        const levelTolerance = 0.15;
        const shouldLevelBase = Math.abs(zaRaw - zbRaw) > levelTolerance;
        const baseAZ = shouldLevelBase ? Math.min(zaRaw, zbRaw) : zaRaw;
        const baseBZ = shouldLevelBase ? Math.min(zaRaw, zbRaw) : zbRaw;
        const frontLeftXY = {
            x: a.x + baseDir.x * depth + normal.x * depth,
            y: a.y + baseDir.y * depth + normal.y * depth
        };
        const frontRightXY = {
            x: b.x - baseDir.x * depth + normal.x * depth,
            y: b.y - baseDir.y * depth + normal.y * depth
        };
        const centerXY = {
            x: (frontLeftXY.x + frontRightXY.x) / 2,
            y: (frontLeftXY.y + frontRightXY.y) / 2
        };
        const backOffset = inchesToPx(placement.recessInches || 18) || ((placement.recessInches || 18) * 1.67);
        const diagRun = backOffset / Math.SQRT1_2;
        const leftDiag = norm({ x: frontLeftXY.x - a.x, y: frontLeftXY.y - a.y });
        const rightDiag = norm({ x: frontRightXY.x - b.x, y: frontRightXY.y - b.y });
        const backLeftXY = {
            x: frontLeftXY.x + leftDiag.x * diagRun,
            y: frontLeftXY.y + leftDiag.y * diagRun
        };
        const backRightXY = {
            x: frontRightXY.x + rightDiag.x * diagRun,
            y: frontRightXY.y + rightDiag.y * diagRun
        };
        const faces = getStickerFaces();
        const supportQuad = [
            { x: a.x, y: a.y, z: baseAZ },
            { x: b.x, y: b.y, z: baseBZ },
            { x: frontRightXY.x, y: frontRightXY.y },
            { x: frontLeftXY.x, y: frontLeftXY.y }
        ];
        const fitPlaneFromSamples = (samples) => {
            if (!Array.isArray(samples) || samples.length < 3) return null;
            let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
            samples.forEach(p => {
                sx += p.x; sy += p.y; sz += p.z;
                sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
                sxz += p.x * p.z; syz += p.y * p.z;
            });
            const n = samples.length;
            const det =
                sxx * (syy * n - sy * sy) -
                sxy * (sxy * n - sy * sx) +
                sx * (sxy * sy - syy * sx);
            if (Math.abs(det) < 1e-9) return null;
            const detA =
                sxz * (syy * n - sy * sy) -
                sxy * (syz * n - sy * sz) +
                sx * (syz * sy - syy * sz);
            const detB =
                sxx * (syz * n - sy * sz) -
                sxz * (sxy * n - sy * sx) +
                sx * (sxy * sz - syz * sx);
            const detC =
                sxx * (syy * sz - syz * sy) -
                sxy * (sxy * sz - syz * sx) +
                sxz * (sxy * sy - syy * sx);
            const plane = { a: detA / det, b: detB / det, c: detC / det };
            return [plane.a, plane.b, plane.c].every(Number.isFinite) ? plane : null;
        };
        const zSampleAt = (x, y) => {
            const dsmZ = getDSMZAtXY(x, y);
            if (Number.isFinite(dsmZ)) return dsmZ;
            const hit = topFaceHitAtXY(x, y, faces);
            return hit && Number.isFinite(hit.z) ? hit.z : null;
        };
        const samples = [
            { x: a.x, y: a.y, z: baseAZ },
            { x: b.x, y: b.y, z: baseBZ }
        ];
        const xs = supportQuad.map(p => p.x);
        const ys = supportQuad.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const grid = 5;
        for (let ix = 0; ix < grid; ix++) {
            for (let iy = 0; iy < grid; iy++) {
                const x = minX + (maxX - minX) * ((ix + 0.5) / grid);
                const y = minY + (maxY - minY) * ((iy + 0.5) / grid);
                if (!pointInsideOrOnPoly2D({ x, y }, supportQuad)) continue;
                const z = zSampleAt(x, y);
                if (Number.isFinite(z)) samples.push({ x, y, z });
            }
        }
        const plane =
            fitPlaneFromSamples(samples) ||
            (topFaceHitAtXY(centerXY.x, centerXY.y, faces)?.plane || null);
        const zOnSupport = (xy, fallback) => {
            if (plane) {
                const z = plane.a * xy.x + plane.b * xy.y + plane.c;
                if (Number.isFinite(z)) return z;
            }
            const hit = topFaceHitAtXY(xy.x, xy.y, faces);
            if (hit && Number.isFinite(hit.z)) return hit.z;
            return fallback;
        };
        const defaultFrontLeftZ = zOnSupport(frontLeftXY, (baseAZ + baseBZ) / 2);
        const defaultFrontRightZ = zOnSupport(frontRightXY, (baseAZ + baseBZ) / 2);
        const defaultCenterSupportZ = zOnSupport(centerXY, (defaultFrontLeftZ + defaultFrontRightZ) / 2);
        const defaultBackLeftZ = zOnSupport(backLeftXY, defaultFrontLeftZ);
        const defaultBackRightZ = zOnSupport(backRightXY, defaultFrontRightZ);
        
        const theoreticalPeakXY = intersectInfiniteLines2D(a, leftDiag, b, rightDiag) || centerXY;
        const leftHipLen = dist(a, frontLeftXY) || 1;
        const rightHipLen = dist(b, frontRightXY) || 1;
        
        const defaultSlopeLeft = (defaultFrontLeftZ - baseAZ) / leftHipLen;
        const defaultSlopeRight = (defaultFrontRightZ - baseBZ) / rightHipLen;
        let S = (defaultSlopeLeft + defaultSlopeRight) / 2;
        
        let frontLeftZ = baseAZ + S * leftHipLen;
        let frontRightZ = baseBZ + S * rightHipLen;
        let leftPeakZ = baseAZ + S * dist(a, theoreticalPeakXY);
        let rightPeakZ = baseBZ + S * dist(b, theoreticalPeakXY);
        const theoreticalPeakZ = (leftPeakZ + rightPeakZ) / 2;
        const backLeftZ = baseAZ + S * (leftHipLen + diagRun);
        const backRightZ = baseBZ + S * (rightHipLen + diagRun);
        const frontLeft = {
            x: frontLeftXY.x,
            y: frontLeftXY.y,
            z: frontLeftZ,
            layer,
            zLocked: true
        };
        const frontRight = {
            x: frontRightXY.x,
            y: frontRightXY.y,
            z: frontRightZ,
            layer,
            zLocked: true
        };
        const peak = {
            x: centerXY.x,
            y: centerXY.y,
            z: theoreticalPeakZ,
            layer,
            zLocked: true
        };
        const backLeft = {
            x: backLeftXY.x,
            y: backLeftXY.y,
            z: backLeftZ,
            layer,
            zLocked: true
        };
        const backRight = {
            x: backRightXY.x,
            y: backRightXY.y,
            z: backRightZ,
            layer,
            zLocked: true
        };
        const lines = [
            { a, b, type: conn.type || null },
            { a, b: frontLeft, type: 'hip' },
            { a: b, b: frontRight, type: 'hip' },
            { a: frontLeft, b: peak, type: 'hip' },
            { a: peak, b: frontRight, type: 'hip' },
            { a: frontLeft, b: backLeft, type: null },
            { a: frontRight, b: backRight, type: null },
            { a: backLeft, b: backRight, type: null }
        ];
        return {
            phase: 'line_place',
            lineConn: conn,
            baseA: a,
            baseB: b,
            frontLeft,
            frontRight,
            peak,
            backLeft,
            backRight,
            allPoints: [frontLeft, frontRight, peak, backLeft, backRight],
            lines,
            baseLevel: { a, b, zA: baseAZ, zB: baseBZ, changed: shouldLevelBase }
        };
    }
    function computeDutchGableGeometry(clientX, clientY, spec) {
        const placement = spec?._placement || null;
        if (placement?.lineConn) return computeDutchGableFromLineGeometry(clientX, clientY, placement);
        if (!placement || !placement.point) {
            const hit = getDutchGablePointHit(clientX, clientY);
            if (!hit) {
                const lineHit = getDutchGableLineHit(clientX, clientY);
                if (!lineHit) return null;
                return {
                    phase: 'line_select',
                    hit: lineHit,
                    lines: [{ a: lineHit.conn.start, b: lineHit.conn.end, type: lineHit.conn.type || null }],
                    points: [{ x: lineHit.point.x, y: lineHit.point.y }]
                };
            }
            return {
                phase: 'select',
                hit,
                lines: hit.conns.map(conn => ({ a: conn.start, b: conn.end, type: conn.type || null })),
                points: [hit.point]
            };
        }
        const origin = placement.point;
        const cursor = screenToImage(clientX, clientY);
        const pair = chooseDutchGableLinePair(origin, placement.items, cursor);
        if (!pair || !pair.items || pair.items.length !== 2) return null;
        const lineConns = pair.items.map(item => item.conn);
        const others = pair.items.map(item => item.other);
        if (!activeGeometry.connections.includes(lineConns[0]) || !activeGeometry.connections.includes(lineConns[1])) return null;
        if (!others[0] || !others[1]) return null;
        const dirA = norm({ x: others[0].x - origin.x, y: others[0].y - origin.y });
        const dirB = norm({ x: others[1].x - origin.x, y: others[1].y - origin.y });
        let bisector = norm({ x: dirA.x + dirB.x, y: dirA.y + dirB.y });
        if (Math.hypot(bisector.x, bisector.y) < 0.5 || Math.abs(cross2(dirA, dirB)) < 1e-6) return null;
        if (dot2({ x: cursor.x - origin.x, y: cursor.y - origin.y }, bisector) < 0) {
            bisector = { x: -bisector.x, y: -bisector.y };
        }
        const across = rot90(bisector, 1);
        const lenA = dist(origin, others[0]);
        const lenB = dist(origin, others[1]);
        const minDepth = Math.max(1, Math.min(lenA, lenB) * 0.03);
        const maxDepth = Math.max(minDepth, Math.min(lenA, lenB) * 0.94);
        let depth = dot2({ x: cursor.x - origin.x, y: cursor.y - origin.y }, bisector);
        depth = Math.max(minDepth, Math.min(maxDepth, depth));
        let guidePoint = { x: origin.x + bisector.x * depth, y: origin.y + bisector.y * depth };
        let hitA = intersectInfiniteLines2D(origin, dirA, guidePoint, across);
        let hitB = intersectInfiniteLines2D(origin, dirB, guidePoint, across);
        if (!hitA || !hitB) return null;
        
        if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
        
        const cosTheta = dot2(dirA, bisector);
        const tUnsnapped = Math.max(minDepth, Math.min(Math.min(lenA * 0.97, lenB * 0.97), depth / cosTheta));
        
        let tSnapped = tUnsnapped;
        let bestSnapDist = Infinity;
        let snapGuideToRender = null;
        
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        
        if (snappingOn && typeof activeGeometry !== 'undefined' && activeGeometry && Array.isArray(activeGeometry.points)) {
            const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
            const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
            const snapTol = sr / cz;
            const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
            
            const exclude = new Set([origin, others[0], others[1]]);
            const minT = minDepth;
            const maxT = Math.min(lenA * 0.97, lenB * 0.97);

            const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
            const cx = (typeof imageWidth !== 'undefined') ? imageWidth / 2 : 0;
            const cy = (typeof imageHeight !== 'undefined') ? imageHeight / 2 : 0;
            const cos = Math.cos(rot);
            const sin = Math.sin(rot);

            const toRotated = (p) => {
                const dx = p.x - cx;
                const dy = p.y - cy;
                return {
                    x: dx * cos - dy * sin + cx,
                    y: dx * sin + dy * cos + cy
                };
            };

            const toRotatedVector = (v) => {
                return {
                    x: v.x * cos - v.y * sin,
                    y: v.x * sin + v.y * cos
                };
            };

            const originRot = toRotated(origin);
            const dirARot = toRotatedVector(dirA);
            const dirBRot = toRotatedVector(dirB);
            
            activeGeometry.points.forEach(otherPt => {
                if (!otherPt || exclude.has(otherPt)) return;
                const otherLayer = otherPt.layer || 1;
                if (vis[otherLayer] === false) return;
                
                const otherRot = toRotated(otherPt);

                // Align splitA (along dirA):
                // Vertically (same X): splitARot.x = otherPtRot.x
                if (Math.abs(dirARot.x) > 1e-5) {
                    const t = (otherRot.x - originRot.x) / dirARot.x;
                    if (t >= minT && t <= maxT) {
                        const distMoved = Math.abs(t - tUnsnapped);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            tSnapped = t;
                            snapGuideToRender = { p1: otherPt, p2: { x: origin.x + dirA.x * t, y: origin.y + dirA.y * t } };
                        }
                    }
                }
                // Horizontally (same Y): splitARot.y = otherPtRot.y
                if (Math.abs(dirARot.y) > 1e-5) {
                    const t = (otherRot.y - originRot.y) / dirARot.y;
                    if (t >= minT && t <= maxT) {
                        const distMoved = Math.abs(t - tUnsnapped);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            tSnapped = t;
                            snapGuideToRender = { p1: otherPt, p2: { x: origin.x + dirA.x * t, y: origin.y + dirA.y * t } };
                        }
                    }
                }
                
                // Align splitB (along dirB):
                // Vertically (same X): splitBRot.x = otherPtRot.x
                if (Math.abs(dirBRot.x) > 1e-5) {
                    const t = (otherRot.x - originRot.x) / dirBRot.x;
                    if (t >= minT && t <= maxT) {
                        const distMoved = Math.abs(t - tUnsnapped);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            tSnapped = t;
                            snapGuideToRender = { p1: otherPt, p2: { x: origin.x + dirB.x * t, y: origin.y + dirB.y * t } };
                        }
                    }
                }
                // Horizontally (same Y): splitBRot.y = otherPtRot.y
                if (Math.abs(dirBRot.y) > 1e-5) {
                    const t = (otherRot.y - originRot.y) / dirBRot.y;
                    if (t >= minT && t <= maxT) {
                        const distMoved = Math.abs(t - tUnsnapped);
                        if (distMoved <= snapTol && distMoved < bestSnapDist) {
                            bestSnapDist = distMoved;
                            tSnapped = t;
                            snapGuideToRender = { p1: otherPt, p2: { x: origin.x + dirB.x * t, y: origin.y + dirB.y * t } };
                        }
                    }
                }
            });
        }
        
        if (snapGuideToRender && typeof activeSnapGuides !== 'undefined') {
            activeSnapGuides.push(snapGuideToRender);
        }
        
        hitA = { t: tSnapped, x: origin.x + dirA.x * tSnapped, y: origin.y + dirA.y * tSnapped };
        hitB = { t: tSnapped, x: origin.x + dirB.x * tSnapped, y: origin.y + dirB.y * tSnapped };
        const splitXYA = { x: hitA.x, y: hitA.y };
        const splitXYB = { x: hitB.x, y: hitB.y };
        const peakXY = {
            x: (splitXYA.x + splitXYB.x) / 2,
            y: (splitXYA.y + splitXYB.y) / 2
        };
        let lineNormal = norm(rot90(norm({ x: splitXYB.x - splitXYA.x, y: splitXYB.y - splitXYA.y }), 1));
        if (dot2(lineNormal, { x: peakXY.x - origin.x, y: peakXY.y - origin.y }) < 0) {
            lineNormal = { x: -lineNormal.x, y: -lineNormal.y };
        }
        const backOffset = inchesToPx(placement.recessInches || 18) || ((placement.recessInches || 18) * 1.67);
        const originZ = getPointZ(origin);
        const defaultSlopeA = (getPointZ(others[0]) - originZ) / lenA;
        const defaultSlopeB = (getPointZ(others[1]) - originZ) / lenB;
        const S = (defaultSlopeA + defaultSlopeB) / 2;
        const peakZ = originZ;

        const backPointFor = (split, dir, len, hitT, conn) => {
            const denom = Math.abs(dot2(dir, lineNormal));
            const run = backOffset / Math.max(0.05, denom);
            const tDist = hitT - run;
            return {
                x: origin.x + dir.x * tDist,
                y: origin.y + dir.y * tDist,
                z: originZ + S * tDist,
                tDist
            };
        };
        const layer = parseInt(origin.layer || others[0].layer || others[1].layer || 1, 10);
        const splitA = {
            x: splitXYA.x,
            y: splitXYA.y,
            z: originZ + S * hitA.t,
            layer,
            zLocked: true
        };
        const splitB = {
            x: splitXYB.x,
            y: splitXYB.y,
            z: originZ + S * hitB.t,
            layer,
            zLocked: true
        };
        const backA = { ...backPointFor(splitA, dirA, lenA, hitA.t, lineConns[0]), layer, zLocked: true };
        const backB = { ...backPointFor(splitB, dirB, lenB, hitB.t, lineConns[1]), layer, zLocked: true };
        const peak = {
            x: peakXY.x,
            y: peakXY.y,
            z: peakZ,
            layer,
            zLocked: true
        };
        const allPoints = [splitA, splitB, backA, backB, peak];
        const typeA = lineConns[0].type || null;
        const typeB = lineConns[1].type || null;
        const lines = [
            { a: others[0], b: splitA, type: typeA },
            { a: others[1], b: splitB, type: typeB },
            { a: splitA, b: peak, type: typeA },
            { a: splitB, b: peak, type: typeB },
            { a: splitA, b: backA, type: null },
            { a: splitB, b: backB, type: null },
            { a: backA, b: backB, type: null }
        ];
        return { phase: 'place', origin, lineConns, others, splitA, splitB, backA, backB, peak, allPoints, lines };
    }
    function buildDutchGablePreview(geo) {
        if (!geo) return { enabled: false };
        if (geo.phase === 'select' || geo.phase === 'line_select') {
            return {
                enabled: true,
                lines: (geo.lines || []).map(ln => ({ a: ln.a, b: ln.b, w: 3, color: 'rgba(255,193,7,0.85)' })),
                points: [{ x: geo.hit.point.x, y: geo.hit.point.y, r: 5, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' }]
            };
        }
        if (geo.phase === 'line_place') {
            return {
                enabled: true,
                lines: geo.lines.map((ln, idx) => ({
                    a: ln.a,
                    b: ln.b,
                    w: !ln.type ? 2.6 : 3,
                    dash: !ln.type || idx === 0,
                    color: !ln.type || idx === 0 ? 'rgba(255,255,255,0.82)' : 'rgba(255,193,7,0.98)'
                })),
                points: [
                    { x: geo.peak.x, y: geo.peak.y, r: 4.8, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' },
                    { x: geo.frontLeft.x, y: geo.frontLeft.y, r: 3.6, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' },
                    { x: geo.frontRight.x, y: geo.frontRight.y, r: 3.6, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' },
                    { x: geo.backLeft.x, y: geo.backLeft.y, r: 3.2, fill: 'rgba(255,255,255,0.85)', stroke: '#111' },
                    { x: geo.backRight.x, y: geo.backRight.y, r: 3.2, fill: 'rgba(255,255,255,0.85)', stroke: '#111' }
                ]
            };
        }
        return {
            enabled: true,
            lines: geo.lines.map(ln => ({
                a: ln.a,
                b: ln.b,
                w: ln.type ? 3 : 2.6,
                dash: !ln.type,
                color: ln.type ? 'rgba(255,193,7,0.98)' : 'rgba(255,255,255,0.82)'
            })),
            points: [
                { x: geo.peak.x, y: geo.peak.y, r: 4.8, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' },
                { x: geo.splitA.x, y: geo.splitA.y, r: 3.6, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' },
                { x: geo.splitB.x, y: geo.splitB.y, r: 3.6, fill: 'rgba(255,193,7,0.9)', stroke: '#fff' },
                { x: geo.backA.x, y: geo.backA.y, r: 3.2, fill: 'rgba(255,255,255,0.85)', stroke: '#111' },
                { x: geo.backB.x, y: geo.backB.y, r: 3.2, fill: 'rgba(255,255,255,0.85)', stroke: '#111' }
            ]
        };
    }

    function getJerkinPointHit(clientX, clientY) {
        const hit = getDutchGablePointHit(clientX, clientY);
        if (!hit || !Array.isArray(hit.items) || hit.items.length < 3) return null;
        return hit;
    }
    function lineItemDir(origin, item) {
        return norm({ x: item.other.x - origin.x, y: item.other.y - origin.y });
    }
    function chooseJerkinItemFromCursor(origin, items, cursor, excluded = new Set()) {
        if (!origin || !Array.isArray(items) || !items.length || !cursor) return null;
        const v = { x: cursor.x - origin.x, y: cursor.y - origin.y };
        const len = Math.hypot(v.x, v.y);
        if (!(len > 1e-6)) return null;
        const cursorDir = { x: v.x / len, y: v.y / len };
        let best = null;
        items.forEach(item => {
            if (!item || excluded.has(item.conn)) return;
            const dir = lineItemDir(origin, item);
            const along = dot2(v, dir);
            if (along <= 0) return;
            const score = dot2(cursorDir, dir);
            if (!best || score > best.score) best = { ...item, dir, score, along };
        });
        return best;
    }
    function pointOnConnFromOrigin(origin, item, alongPx) {
        if (!origin || !item || !(alongPx > 0)) return null;
        const dir = item.dir || lineItemDir(origin, item);
        const total = dist(origin, item.other);
        const d = Math.max(0, Math.min(total, alongPx));
        if (!(d > 0.05) || !(total > 0.05)) return null;
        const t = d / total;
        return {
            x: origin.x + dir.x * d,
            y: origin.y + dir.y * d,
            z: interpolateConnZ(item.conn, (item.conn.start === origin) ? t : 1 - t),
            layer: origin.layer || item.other.layer || 1,
            zLocked: true,
            tOnConn: (item.conn.start === origin) ? t : 1 - t
        };
    }
    function chooseMirroredJerkinSide(origin, centerItem, sideItem, items) {
        const centerDir = centerItem.dir || lineItemDir(origin, centerItem);
        const sideDir = sideItem.dir || lineItemDir(origin, sideItem);
        const projection = dot2(sideDir, centerDir);
        const mirror = norm({
            x: 2 * projection * centerDir.x - sideDir.x,
            y: 2 * projection * centerDir.y - sideDir.y
        });
        let best = null;
        items.forEach(item => {
            if (!item || item.conn === centerItem.conn || item.conn === sideItem.conn) return;
            const dir = lineItemDir(origin, item);
            const score = dot2(dir, mirror);
            if (!best || score > best.score) best = { ...item, dir, score };
        });
        return best;
    }
    function isJerkinHipLine(conn) {
        return String(conn?.type || '').toLowerCase() === 'hip';
    }
    function getPointConnectionsForJerkin(point) {
        if (!point || !activeGeometry || !Array.isArray(activeGeometry.connections)) return [];
        return activeGeometry.connections.filter(conn => conn && (conn.start === point || conn.end === point));
    }
    function otherConnPoint(conn, point) {
        if (!conn || !point) return null;
        if (conn.start === point) return conn.end || null;
        if (conn.end === point) return conn.start || null;
        return null;
    }
    function pointLineDistanceJerkin(p, a, dir) {
        if (!p || !a || !dir) return Infinity;
        return Math.abs(cross2({ x: p.x - a.x, y: p.y - a.y }, dir));
    }
    function chooseJerkinOuterConn(sidePoint, centerConn, crossbar) {
        const conns = getPointConnectionsForJerkin(sidePoint)
            .filter(conn => conn && conn !== centerConn && conn !== crossbar);
        if (!conns.length) return null;
        const center = otherConnPoint(centerConn, sidePoint);
        if (!center) return conns.find(conn => !isJerkinHipLine(conn)) || conns[0];
        let best = null;
        conns.forEach(conn => {
            const other = otherConnPoint(conn, sidePoint);
            if (!other) return;
            const awayScore = dot2(
                norm({ x: other.x - sidePoint.x, y: other.y - sidePoint.y }),
                norm({ x: sidePoint.x - center.x, y: sidePoint.y - center.y })
            );
            const typePenalty = isJerkinHipLine(conn) ? 0.25 : 0;
            const score = awayScore - typePenalty;
            if (!best || score > best.score) best = { conn, score };
        });
        return best?.conn || null;
    }
    function getJerkinLengthAnchorsOnRidge(origin, ridgeDir, maxLineDist) {
        if (!origin || !ridgeDir || !activeGeometry || !Array.isArray(activeGeometry.points)) return [];
        const anchors = [];
        const seen = new Set();
        activeGeometry.points.forEach(center => {
            if (!center || center === origin) return;
            const centerConns = getPointConnectionsForJerkin(center);
            if (centerConns.length < 2) return;
            for (let i = 0; i < centerConns.length - 1; i++) {
                for (let j = i + 1; j < centerConns.length; j++) {
                    const connA = centerConns[i];
                    const connB = centerConns[j];
                    const sideA = otherConnPoint(connA, center);
                    const sideB = otherConnPoint(connB, center);
                    if (!sideA || !sideB || sideA === sideB) continue;
                    const crossbar = getExistingConnectionBetween(sideA, sideB);
                    if (!crossbar) continue;
                    const sideAOut = chooseJerkinOuterConn(sideA, connA, crossbar);
                    const sideBOut = chooseJerkinOuterConn(sideB, connB, crossbar);
                    const sideAOther = otherConnPoint(sideAOut, sideA);
                    const sideBOther = otherConnPoint(sideBOut, sideB);
                    if (!sideAOther || !sideBOther) continue;
                    const tipHit = intersectInfiniteLines2D(
                        sideA,
                        { x: sideAOther.x - sideA.x, y: sideAOther.y - sideA.y },
                        sideB,
                        { x: sideBOther.x - sideB.x, y: sideBOther.y - sideB.y }
                    );
                    if (!tipHit) continue;
                    const tip = { x: tipHit.x, y: tipHit.y };
                    const axis = norm({ x: center.x - tip.x, y: center.y - tip.y });
                    if (Math.hypot(axis.x, axis.y) < 0.5) continue;
                    if (Math.abs(dot2(axis, ridgeDir)) < 0.9) continue;
                    const crossHit = intersectInfiniteLines2D(
                        tip,
                        axis,
                        sideA,
                        { x: sideB.x - sideA.x, y: sideB.y - sideA.y }
                    );
                    if (!crossHit) continue;
                    const length = Math.hypot(crossHit.x - tip.x, crossHit.y - tip.y);
                    if (!(length > 0.05) || !Number.isFinite(length)) continue;
                    const key = `${Math.round(tip.x * 100)}:${Math.round(tip.y * 100)}:${Math.round(length * 100)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    anchors.push({
                        length,
                        tip,
                        cross: { x: crossHit.x, y: crossHit.y },
                        center
                    });
                }
            }
        });
        return anchors;
    }
    function snapJerkinAlongToVisiblePoints(origin, item, rawAlong, minAlong, maxAlong, exclude = new Set()) {
        if (!origin || !item || !(rawAlong > 0)) return null;
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        if (!snappingOn || !activeGeometry || !Array.isArray(activeGeometry.points)) return null;
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const snapTol = sr / cz;
        const dir = item.dir || lineItemDir(origin, item);
        const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
        const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
        const cx = (typeof imageWidth !== 'undefined') ? imageWidth / 2 : 0;
        const cy = (typeof imageHeight !== 'undefined') ? imageHeight / 2 : 0;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const toRotated = (p) => {
            const dx = p.x - cx;
            const dy = p.y - cy;
            return {
                x: dx * cos - dy * sin + cx,
                y: dx * sin + dy * cos + cy
            };
        };
        const toRotatedVector = (v) => ({
            x: v.x * cos - v.y * sin,
            y: v.x * sin + v.y * cos
        });
        const originRot = toRotated(origin);
        const dirRot = toRotatedVector(dir);
        let best = null;
        const consider = (along, guidePoint) => {
            if (!(along >= minAlong && along <= maxAlong)) return;
            const distMoved = Math.abs(along - rawAlong);
            if (distMoved > snapTol) return;
            if (!best || distMoved < best.distMoved) {
                best = {
                    along,
                    distMoved,
                    guide: guidePoint ? {
                        p1: guidePoint,
                        p2: { x: origin.x + dir.x * along, y: origin.y + dir.y * along }
                    } : null
                };
            }
        };
        activeGeometry.points.forEach(otherPt => {
            if (!otherPt || exclude.has(otherPt)) return;
            const otherLayer = otherPt.layer || 1;
            if (vis[otherLayer] === false) return;
            const otherRot = toRotated(otherPt);
            if (Math.abs(dirRot.x) > 1e-5) consider((otherRot.x - originRot.x) / dirRot.x, otherPt);
            if (Math.abs(dirRot.y) > 1e-5) consider((otherRot.y - originRot.y) / dirRot.y, otherPt);
        });
        return best;
    }
    function getJerkinPerpendicularEaveAnchorsFromOppositeRidgeEnd(origin, centerItem, maxDepth = 2) {
        if (!origin || !centerItem || !activeGeometry || !Array.isArray(activeGeometry.connections)) return [];
        const ridgeEnd = centerItem.other;
        const ridgeDir = centerItem.dir || lineItemDir(origin, centerItem);
        if (!ridgeEnd || Math.hypot(ridgeDir.x, ridgeDir.y) < 0.5) return [];
        const queue = [{ point: ridgeEnd, depth: 0 }];
        const visited = new Set([ridgeEnd]);
        const seenConns = new Set([centerItem.conn]);
        const anchors = [];
        const minPast = 0.05;
        for (let q = 0; q < queue.length; q++) {
            const node = queue[q];
            const conns = getPointConnectionsForJerkin(node.point);
            conns.forEach(conn => {
                if (!conn || conn === centerItem.conn) return;
                const other = otherConnPoint(conn, node.point);
                if (!other) return;
                if (!seenConns.has(conn)) {
                    seenConns.add(conn);
                    const lineDir = norm({ x: conn.end.x - conn.start.x, y: conn.end.y - conn.start.y });
                    const perpendicular = Math.abs(dot2(lineDir, ridgeDir)) <= 0.18;
                    if (perpendicular) {
                        const projA = dot2({ x: conn.start.x - ridgeEnd.x, y: conn.start.y - ridgeEnd.y }, ridgeDir);
                        const projB = dot2({ x: conn.end.x - ridgeEnd.x, y: conn.end.y - ridgeEnd.y }, ridgeDir);
                        const projection = (projA + projB) / 2;
                        const skew = Math.abs(projA - projB);
                        if (projection > minPast && skew <= Math.max(3, Math.abs(projection) * 0.2)) {
                            anchors.push({
                                length: projection,
                                ridgeEnd,
                                cross: {
                                    x: (conn.start.x + conn.end.x) / 2,
                                    y: (conn.start.y + conn.end.y) / 2
                                },
                                conn,
                                depth: node.depth
                            });
                        }
                    }
                }
                if (node.depth < maxDepth && !visited.has(other)) {
                    visited.add(other);
                    queue.push({ point: other, depth: node.depth + 1 });
                }
            });
        }
        return anchors;
    }
    function snapJerkinCenterAlong(origin, centerItem, rawAlong) {
        if (!origin || !centerItem || !(rawAlong > 0)) return { along: rawAlong, snap: null };
        const dir = centerItem.dir || lineItemDir(origin, centerItem);
        const maxAlong = Math.max(0, dist(origin, centerItem.other));
        const minAlong = Math.max(0.5, maxAlong * 0.02);
        const exclude = new Set([origin, centerItem.other]);
        let best = snapJerkinAlongToVisiblePoints(origin, centerItem, rawAlong, minAlong, maxAlong, exclude);
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        if (snappingOn) {
            const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
            const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
            const snapTol = sr / cz;
            const eaveAnchors = getJerkinPerpendicularEaveAnchorsFromOppositeRidgeEnd(origin, centerItem, 2);
            eaveAnchors.forEach(anchor => {
                if (!(anchor.length >= minAlong && anchor.length <= maxAlong)) return;
                const distMoved = Math.abs(anchor.length - rawAlong);
                if (distMoved > snapTol) return;
                if (!best || distMoved < best.distMoved) {
                    best = {
                        along: anchor.length,
                        distMoved,
                        guide: {
                            p1: anchor.cross,
                            p2: { x: origin.x + dir.x * anchor.length, y: origin.y + dir.y * anchor.length }
                        },
                        source: 'perpendicular-eave'
                    };
                }
            });
            const anchors = getJerkinLengthAnchorsOnRidge(origin, dir, Math.max(3, snapTol * 1.5));
            anchors.forEach(anchor => {
                if (!(anchor.length >= minAlong && anchor.length <= maxAlong)) return;
                const distMoved = Math.abs(anchor.length - rawAlong);
                if (distMoved > snapTol) return;
                if (!best || distMoved < best.distMoved) {
                    best = {
                        along: anchor.length,
                        distMoved,
                        guide: {
                            p1: anchor.cross,
                            p2: { x: origin.x + dir.x * anchor.length, y: origin.y + dir.y * anchor.length }
                        },
                        source: 'jerkin-length'
                    };
                }
            });
        }
        return best ? { along: best.along, snap: best } : { along: rawAlong, snap: null };
    }
    function snapJerkinSideAlongToMatchingCrossbarLength(origin, centerItem, sideItem, rawSideAlong, minSideAlong, maxSideAlong, existingBest = null) {
        if (!origin || !centerItem || !sideItem || !(rawSideAlong > 0)) return existingBest;
        const snappingOn = (typeof isFreeMove === 'undefined') ? true : !isFreeMove;
        if (!snappingOn) return existingBest;
        const centerDir = centerItem.dir || lineItemDir(origin, centerItem);
        const sideDir = sideItem.dir || lineItemDir(origin, sideItem);
        const projection = Math.abs(dot2(sideDir, centerDir));
        if (!(projection > 0.05)) return existingBest;
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const snapTol = sr / cz;
        const anchors = getJerkinLengthAnchorsOnRidge(origin, centerDir, Math.max(3, snapTol * 1.5));
        let best = existingBest || null;
        anchors.forEach(anchor => {
            const sideAlong = anchor.length / projection;
            if (!(sideAlong >= minSideAlong && sideAlong <= maxSideAlong)) return;
            const distMoved = Math.abs(sideAlong - rawSideAlong);
            if (distMoved > snapTol) return;
            if (!best || distMoved < best.distMoved) {
                best = {
                    along: sideAlong,
                    distMoved,
                    guide: {
                        p1: anchor.cross,
                        p2: {
                            x: origin.x + sideDir.x * sideAlong,
                            y: origin.y + sideDir.y * sideAlong
                        }
                    },
                    source: 'jerkin-crossbar-length'
                };
            }
        });
        return best;
    }
    function computeJerkinHeadGeometry(clientX, clientY, spec) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections) || typeof screenToImage !== 'function') return null;
        if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
        const cursor = screenToImage(clientX, clientY);
        const placement = spec?._placement || null;
        if (!placement) {
            const hit = getJerkinPointHit(clientX, clientY);
            if (!hit) return null;
            return {
                phase: 'select',
                hit,
                lines: hit.items.map(item => ({ a: hit.point, b: item.other, type: item.conn.type || null }))
            };
        }
        const origin = placement.origin;
        const items = (placement.items || [])
            .filter(item => item && item.conn && activeGeometry.connections.includes(item.conn))
            .map(item => ({ ...item, other: item.conn.start === origin ? item.conn.end : item.conn.start }));
        if (!origin || items.length < 3) return null;
        if (placement.step === 1) {
            const centerItem = chooseJerkinItemFromCursor(origin, items, cursor);
            if (!centerItem) return null;
            const centerSnap = snapJerkinCenterAlong(origin, centerItem, centerItem.along);
            centerItem.along = centerSnap.along;
            if (centerSnap.snap?.guide && typeof activeSnapGuides !== 'undefined') {
                activeSnapGuides = [centerSnap.snap.guide];
            }
            const centerPoint = pointOnConnFromOrigin(origin, centerItem, centerItem.along);
            if (!centerPoint) return null;
            return {
                phase: 'length',
                origin,
                items,
                centerItem,
                centerPoint,
                lines: [
                    { a: origin, b: centerPoint, type: centerItem.conn.type || null },
                    { a: centerPoint, b: centerItem.other, type: centerItem.conn.type || null }
                ],
                allPoints: [centerPoint]
            };
        }
        if (placement.step === 2) {
            const centerItem = placement.centerItem;
            if (!centerItem || !activeGeometry.connections.includes(centerItem.conn)) return null;
            centerItem.other = centerItem.conn.start === origin ? centerItem.conn.end : centerItem.conn.start;
            centerItem.dir = lineItemDir(origin, centerItem);
            const centerPoint = pointOnConnFromOrigin(origin, centerItem, placement.centerAlong);
            if (!centerPoint) return null;
            const sideItem = chooseJerkinItemFromCursor(origin, items, cursor, new Set([centerItem.conn]));
            if (!sideItem) return null;
            const oppositeItem = chooseMirroredJerkinSide(origin, centerItem, sideItem, items);
            if (!oppositeItem) return null;
            const maxSideAlong = Math.min(dist(origin, sideItem.other), dist(origin, oppositeItem.other));
            const minSideAlong = Math.max(0.5, maxSideAlong * 0.02);
            let sideSnap = snapJerkinAlongToVisiblePoints(
                origin,
                sideItem,
                sideItem.along,
                minSideAlong,
                maxSideAlong,
                new Set([origin, sideItem.other, oppositeItem.other, centerItem.other])
            );
            sideSnap = snapJerkinSideAlongToMatchingCrossbarLength(
                origin,
                centerItem,
                sideItem,
                sideItem.along,
                minSideAlong,
                maxSideAlong,
                sideSnap
            );
            if (sideSnap) {
                sideItem.along = sideSnap.along;
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [sideSnap.guide].filter(Boolean);
            }
            const sidePoint = pointOnConnFromOrigin(origin, sideItem, sideItem.along);
            const oppositePoint = pointOnConnFromOrigin(origin, oppositeItem, sideItem.along);
            if (!sidePoint || !oppositePoint) return null;
            const lines = [
                { a: centerPoint, b: centerItem.other, type: centerItem.conn.type || null },
                { a: sidePoint, b: sideItem.other, type: sideItem.conn.type || null },
                { a: oppositePoint, b: oppositeItem.other, type: oppositeItem.conn.type || null },
                { a: sidePoint, b: centerPoint, type: 'hip' },
                { a: centerPoint, b: oppositePoint, type: 'hip' },
                { a: sidePoint, b: oppositePoint, type: null }
            ];
            return {
                phase: 'width',
                origin,
                centerItem,
                sideItem,
                oppositeItem,
                centerPoint,
                sidePoint,
                oppositePoint,
                lines,
                allPoints: [centerPoint, sidePoint, oppositePoint]
            };
        }
        return null;
    }
    function splitJerkinConn(conn, point) {
        if (!conn || !point || !activeGeometry || !Array.isArray(activeGeometry.connections)) return null;
        if (!activeGeometry.points.includes(point)) activeGeometry.points.push(point);
        activeGeometry.connections = activeGeometry.connections.filter(c => c !== conn);
        const add = (a, b) => {
            if (!a || !b || a === b || getExistingConnectionBetween(a, b)) return;
            activeGeometry.connections.push({ start: a, end: b, type: conn.type || null });
        };
        add(conn.start, point);
        add(point, conn.end);
        return point;
    }
    function commitJerkinHead(geo) {
        if (!geo || geo.phase !== 'width' || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return false;
        if (typeof save2DState === 'function') save2DState();
        const origin = geo.origin;
        const centerPoint = splitJerkinConn(geo.centerItem.conn, geo.centerPoint);
        const sidePoint = splitJerkinConn(geo.sideItem.conn, geo.sidePoint);
        const oppositePoint = splitJerkinConn(geo.oppositeItem.conn, geo.oppositePoint);
        if (origin) {
            activeGeometry.connections = activeGeometry.connections.filter(conn => conn && conn.start !== origin && conn.end !== origin);
            activeGeometry.points = activeGeometry.points.filter(p => p !== origin);
            if (Array.isArray(activeGeometry.manualFaces)) {
                activeGeometry.manualFaces = activeGeometry.manualFaces
                    .map(face => {
                        if (!face || !Array.isArray(face.points)) return face;
                        const holes = Array.isArray(face.holes)
                            ? face.holes.filter(hole => Array.isArray(hole) && !hole.includes(origin))
                            : [];
                        return { ...face, holes };
                    })
                    .filter(face => face && Array.isArray(face.points) && !face.points.includes(origin));
            }
        }
        const add = (a, b, type) => {
            if (!a || !b || a === b || getExistingConnectionBetween(a, b)) return;
            activeGeometry.connections.push({ start: a, end: b, type: type || null });
        };
        add(sidePoint, centerPoint, 'hip');
        add(centerPoint, oppositePoint, 'hip');
        add(sidePoint, oppositePoint, null);
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                [centerPoint, sidePoint, oppositePoint].forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    function buildJerkinHeadPreview(geo) {
        if (!geo) return { enabled: false };
        const isSelect = geo.phase === 'select';
        return {
            enabled: true,
            lines: (geo.lines || []).map(ln => ({
                a: ln.a,
                b: ln.b,
                w: ln.type === 'hip' ? 3 : 2.4,
                dash: ln.type !== 'hip' && !isSelect,
                color: ln.type === 'hip' ? 'rgba(255,193,7,0.98)' : 'rgba(255,255,255,0.82)'
            })),
            points: isSelect
                ? [{ x: geo.hit.point.x, y: geo.hit.point.y, r: 5, fill: 'rgba(255,193,7,0.98)', stroke: '#fff' }]
                : (geo.allPoints || []).map((p, idx) => ({
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    r: idx === 0 ? 4.8 : 3.8,
                    fill: 'rgba(255,193,7,0.95)',
                    stroke: '#fff'
                }))
        };
    }

    function isPointCollinear2D(center, a, b, tolerance = 0.035) {
        if (!center || !a || !b) return false;
        const ax = (a.x || 0) - (center.x || 0);
        const ay = (a.y || 0) - (center.y || 0);
        const bx = (b.x || 0) - (center.x || 0);
        const by = (b.y || 0) - (center.y || 0);
        const al = Math.hypot(ax, ay);
        const bl = Math.hypot(bx, by);
        if (al < 1e-6 || bl < 1e-6) return false;
        return Math.abs((ax * by - ay * bx) / (al * bl)) <= tolerance;
    }
    function commitDutchGable(geo) {
        if (!geo || (geo.phase !== 'place' && geo.phase !== 'line_place') || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return false;
        if (typeof save2DState === 'function') save2DState();
        if (geo.phase === 'line_place') {
            if (geo.baseLevel?.changed) {
                if (geo.baseLevel.a && Number.isFinite(geo.baseLevel.zA)) {
                    geo.baseLevel.a.z = geo.baseLevel.zA;
                    geo.baseLevel.a.zLocked = true;
                    if (geo.baseLevel.a._lockedPlanes) delete geo.baseLevel.a._lockedPlanes;
                }
                if (geo.baseLevel.b && Number.isFinite(geo.baseLevel.zB)) {
                    geo.baseLevel.b.z = geo.baseLevel.zB;
                    geo.baseLevel.b.zLocked = true;
                    if (geo.baseLevel.b._lockedPlanes) delete geo.baseLevel.b._lockedPlanes;
                }
            }
            const makePoint = p => ({
                x: p.x,
                y: p.y,
                z: p.z,
                layer: p.layer,
                zLocked: true
            });
            const frontLeft = makePoint(geo.frontLeft);
            const frontRight = makePoint(geo.frontRight);
            const peakPoint = makePoint(geo.peak);
            const backLeft = makePoint(geo.backLeft);
            const backRight = makePoint(geo.backRight);
            [frontLeft, frontRight, peakPoint, backLeft, backRight].forEach(p => {
                if (p && !activeGeometry.points.includes(p)) activeGeometry.points.push(p);
            });
            const add = (a, b, type) => {
                if (!a || !b || a === b || getExistingConnectionBetween(a, b)) return;
                activeGeometry.connections.push({ start: a, end: b, type: type || null });
            };
            add(geo.baseA, frontLeft, 'hip');
            add(geo.baseB, frontRight, 'hip');
            add(frontLeft, peakPoint, 'hip');
            add(peakPoint, frontRight, 'hip');
            add(frontLeft, backLeft, null);
            add(frontRight, backRight, null);
            add(backLeft, backRight, null);
            try {
                if (typeof selectedPoints !== 'undefined') {
                    selectedPoints.clear();
                    [frontLeft, frontRight, peakPoint, backLeft, backRight].forEach(p => selectedPoints.add(p));
                }
                if (typeof selectedLines !== 'undefined') selectedLines.clear();
                if (typeof selectedVents !== 'undefined') selectedVents.clear();
            } catch (e) {}
            try {
                if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
                if (typeof renderGeometry3D === 'function') renderGeometry3D();
                if (typeof renderFinalPass === 'function') renderFinalPass(false);
                if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
                if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
            } catch (e) {}
            request2DRender();
            return true;
        }
        const origin = geo.origin;
        const oldLineConns = new Set(geo.lineConns);
        const peakZ = Number.isFinite(geo.peak?.z) ? geo.peak.z : getPointZ(origin);
        const originConns = activeGeometry.connections.filter(conn => conn && (conn.start === origin || conn.end === origin));
        const nonSelectedConns = originConns.filter(conn => !oldLineConns.has(conn));
        const collinearContinuation = nonSelectedConns.length === 1
            ? nonSelectedConns[0]
            : null;
        const continuationOther = collinearContinuation
            ? (collinearContinuation.start === origin ? collinearContinuation.end : collinearContinuation.start)
            : null;
        const shouldCollapseOriginToPeak =
            originConns.length === oldLineConns.size + 1 &&
            !!continuationOther &&
            isPointCollinear2D(origin, geo.peak, continuationOther);
        let peakPoint;
        if (shouldCollapseOriginToPeak) {
            origin.x = geo.peak.x;
            origin.y = geo.peak.y;
            origin.z = peakZ;
            origin.zLocked = true;
            if (origin._lockedPlanes) delete origin._lockedPlanes;
            peakPoint = origin;
        } else {
            peakPoint = {
                x: geo.peak.x,
                y: geo.peak.y,
                z: peakZ,
                layer: geo.peak.layer,
                zLocked: true
            };
        }
        [geo.splitA, geo.splitB, geo.backA, geo.backB, peakPoint].forEach(p => {
            if (p && !activeGeometry.points.includes(p)) activeGeometry.points.push(p);
        });
        activeGeometry.connections = activeGeometry.connections.filter(conn => !oldLineConns.has(conn));
        const add = (a, b, type) => {
            if (!a || !b || a === b || getExistingConnectionBetween(a, b)) return;
            activeGeometry.connections.push({ start: a, end: b, type: type || null });
        };
        const typeA = geo.lineConns[0].type || null;
        const typeB = geo.lineConns[1].type || null;
        add(geo.others[0], geo.splitA, typeA);
        add(geo.splitA, peakPoint, typeA);
        add(geo.others[1], geo.splitB, typeB);
        add(geo.splitB, peakPoint, typeB);
        if (peakPoint !== origin) add(origin, peakPoint, null);
        add(geo.splitA, geo.backA, null);
        add(geo.splitB, geo.backB, null);
        add(geo.backA, geo.backB, null);
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                [peakPoint, geo.splitA, geo.splitB, geo.backA, geo.backB].forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    function makeDutchGableSticker() {
        const spec = {
            id: 'dutch_gable',
            label: 'Dutch Gable',
            shortLabel: 'Dutch Gable',
            icon: dutchGableIconSVG(),
            recessOptions: [6, 18],
            recessIndex: 1,
            _placement: null
        };
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel,
            icon: spec.icon,
            hideGhost: true,
            tooltip: 'Dutch Gable: click a connected point or line, then move out and click to place. Right-click cycles 6-inch/18-inch recess.',
            onEnter() {
                spec._placement = null;
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
            },
            onExit() {
                spec._placement = null;
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
            },
            onHover(ctx, e) {
                ensureLineTypesAvailableOnce(ctx);
                const geo = computeDutchGableGeometry(e.clientX, e.clientY, spec);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildDutchGablePreview(geo));
            },
            onRightClick(ctx, e) {
                const options = spec.recessOptions || [6, 18];
                spec.recessIndex = ((Number.isInteger(spec.recessIndex) ? spec.recessIndex : 0) + 1) % options.length;
                if (spec._placement) spec._placement.recessInches = options[spec.recessIndex] || 18;
                ctx.hover = null;
                const geo = computeDutchGableGeometry(e.clientX, e.clientY, spec);
                if (geo) {
                    ctx.hover = { geo };
                    ctx._setPreview(buildDutchGablePreview(geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onClick(ctx, e) {
                let geo = computeDutchGableGeometry(e.clientX, e.clientY, spec);
                if (!geo) return;
                if (!spec._placement) {
                    if (geo.phase === 'line_select') {
                        spec._placement = {
                            lineConn: geo.hit.conn,
                            recessInches: (spec.recessOptions || [6, 18])[spec.recessIndex] || 18
                        };
                        ctx.hover = null;
                        const nextGeo = computeDutchGableGeometry(e.clientX, e.clientY, spec);
                        if (nextGeo) {
                            ctx.hover = { geo: nextGeo };
                            ctx._setPreview(buildDutchGablePreview(nextGeo));
                        }
                        return;
                    }
                    if (geo.phase !== 'select') return;
                    spec._placement = {
                        point: geo.hit.point,
                        items: geo.hit.items.slice(),
                        recessInches: (spec.recessOptions || [6, 18])[spec.recessIndex] || 18
                    };
                    ctx.hover = null;
                    const nextGeo = computeDutchGableGeometry(e.clientX, e.clientY, spec);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildDutchGablePreview(nextGeo));
                    }
                    return;
                }
                if (geo.phase !== 'place' && geo.phase !== 'line_place') return;
                spec._placement = null;
                if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
                if (!commitDutchGable(geo)) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    function makeJerkinHeadSticker() {
        const spec = {
            id: 'jerkin_head',
            label: 'Jerkin Head',
            shortLabel: 'Jerkin',
            icon: jerkinHeadIconSVG(),
            _placement: null
        };
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel,
            icon: spec.icon,
            hideGhost: true,
            tooltip: 'Jerkin Head: click a point with at least three connected lines, click along the center line for length, then click along a side line for width.',
            onEnter() {
                spec._placement = null;
            },
            onExit() {
                spec._placement = null;
            },
            onHover(ctx, e) {
                const geo = computeJerkinHeadGeometry(e.clientX, e.clientY, spec);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildJerkinHeadPreview(geo));
            },
            onClick(ctx, e) {
                let placement = spec._placement || null;
                let geo = computeJerkinHeadGeometry(e.clientX, e.clientY, spec);
                if (!geo) return;
                if (!placement) {
                    if (geo.phase !== 'select') return;
                    spec._placement = {
                        step: 1,
                        origin: geo.hit.point,
                        items: geo.hit.items.slice()
                    };
                    ctx.hover = null;
                    const nextGeo = computeJerkinHeadGeometry(e.clientX, e.clientY, spec);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildJerkinHeadPreview(nextGeo));
                    }
                    return;
                }
                if (placement.step === 1) {
                    if (geo.phase !== 'length') return;
                    spec._placement = {
                        ...placement,
                        step: 2,
                        centerItem: geo.centerItem,
                        centerAlong: geo.centerItem.along
                    };
                    ctx.hover = null;
                    const nextGeo = computeJerkinHeadGeometry(e.clientX, e.clientY, spec);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildJerkinHeadPreview(nextGeo));
                    }
                    return;
                }
                if (geo.phase !== 'width') return;
                spec._placement = null;
                if (!commitJerkinHead(geo)) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    function makeEyebrowSticker() {
        const spec = {
            id: 'eyebrow',
            label: 'Eyebrow',
            shortLabel: 'Eyebrow',
            icon: eyebrowIconSVG(),
            variants: [
                { sections: 2, backMode: 'level', label: '2-face' },
                { sections: 4, backMode: 'level', label: '4-level' },
                { sections: 6, backMode: 'level', label: '6-level' },
                { sections: 4, backMode: 'origin', label: '4-origin' },
                { sections: 6, backMode: 'origin', label: '6-origin' }
            ],
            sectionIndex: 0,
            sections: 2,
            backMode: 'level',
            depthFt: 4,
            widthFt: 6,
            _placement: null
        };
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel,
            icon: spec.icon,
            hideGhost: true,
            tooltip: 'Eyebrow: click origin, click ridge depth, click front width. Right-click cycles 2-face, 4/6 level, 4/6 origin.',
            onEnter() {
                spec._placement = null;
            },
            onExit() {
                spec._placement = null;
            },
            onHover(ctx, e) {
                const variant = (spec.variants || [])[spec.sectionIndex || 0] || spec.variants[0];
                spec.sections = variant.sections || 2;
                spec.backMode = variant.backMode || 'level';
                const geo = computeEyebrowGeometry(e.clientX, e.clientY, spec, spec._placement || null);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildEyebrowPreview(geo));
            },
            onRightClick(ctx, e) {
                const options = spec.variants || [];
                spec.sectionIndex = ((Number.isInteger(spec.sectionIndex) ? spec.sectionIndex : 0) + 1) % options.length;
                const variant = options[spec.sectionIndex] || options[0] || { sections: 2, backMode: 'level' };
                spec.sections = variant.sections || 2;
                spec.backMode = variant.backMode || 'level';
                ctx.hover = null;
                const geo = computeEyebrowGeometry(e.clientX, e.clientY, spec, spec._placement || null);
                if (geo) {
                    ctx.hover = { geo };
                    ctx._setPreview(buildEyebrowPreview(geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onClick(ctx, e) {
                const variant = (spec.variants || [])[spec.sectionIndex || 0] || spec.variants[0];
                spec.sections = variant.sections || 2;
                spec.backMode = variant.backMode || 'level';
                let placement = spec._placement || null;
                let geo = computeEyebrowGeometry(e.clientX, e.clientY, spec, placement);
                if (!geo) return;
                if (!placement) {
                    spec._placement = { step: 1, originXY: geo.center, originSnap: geo.originSnap || null };
                    ctx.hover = null;
                    const nextGeo = computeEyebrowGeometry(e.clientX, e.clientY, spec, spec._placement);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildEyebrowPreview(nextGeo));
                    }
                    return;
                }
                if (placement.step === 1) {
                    spec._placement = {
                        ...placement,
                        step: 2,
                        dir: geo.dir,
                        depth: geo.depth
                    };
                    ctx.hover = null;
                    const nextGeo = computeEyebrowGeometry(e.clientX, e.clientY, spec, spec._placement);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildEyebrowPreview(nextGeo));
                    }
                    return;
                }
                spec._placement = null;
                if (!commitEyebrow(geo)) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    function makeCurvedFaceSticker() {
        const spec = {
            id: 'curved_face',
            label: 'Smart Face',
            shortLabel: 'Smart Face',
            icon: curvedFaceIconSVG(),
            _placement: null,
            _pendingCommit: null
        };
        const clearPending = () => {
            if (spec._pendingCommit?.timer) clearTimeout(spec._pendingCommit.timer);
            spec._pendingCommit = null;
        };
        const commitSegmentAndAdvance = (ctx, geo) => {
            if (!commitCurvedFaceSegment(geo)) return false;
            const newConn = activeGeometry.connections[activeGeometry.connections.length - 1] || null;
            spec._placement.currentLine = geo.currentLine;
            spec._placement.currentConn = newConn;
            spec._placement.normal = geo.normal;
            spec._placement.mode = geo.mode === 'splitFace' ? 'splitFace' : 'newFace';
            spec._placement.splitFace = geo.mode === 'splitFace' ? geo.splitFace : null;
            if (geo.mode !== 'splitFace') {
                const existing = Array.isArray(spec._placement.stationLines) ? spec._placement.stationLines : [];
                spec._placement.stationLines = [
                    ...existing,
                    { line: geo.currentLine, conn: newConn }
                ];
            }
            ctx.hover = null;
            const e = ctx.__lastHoverEvt || null;
            const nextGeo = e ? computeCurvedFaceGeometry(e.clientX, e.clientY, spec) : null;
            if (nextGeo) {
                ctx.hover = { geo: nextGeo };
                ctx._setPreview(buildCurvedFacePreview(nextGeo));
            } else {
                ctx._setPreview({ enabled: false });
            }
            return true;
        };
        const finish = (ctx) => {
            clearPending();
            spec._placement = null;
            ctx.hover = null;
            ctx._setPreview({ enabled: false });
            ctx.exitPlacement();
        };
        const commitFinalAndFinish = (ctx, geo) => {
            clearPending();
            if (geo && geo.phase === 'place') commitCurvedFaceSegment(geo);
            finish(ctx);
        };
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel,
            icon: spec.icon,
            hideGhost: true,
            tooltip: 'Smart Face: click a line to start, then click station lines. Hover an adjacent face to split it; double-click to finish.',
            onEnter() {
                clearPending();
                spec._placement = null;
            },
            onExit() {
                clearPending();
                spec._placement = null;
            },
            onHover(ctx, e) {
                const geo = computeCurvedFaceGeometry(e.clientX, e.clientY, spec);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildCurvedFacePreview(geo));
            },
            onClick(ctx, e) {
                if (spec._placement && (e.detail || 0) >= 2) {
                    window.__SMART_STICKER_SUPPRESS_DBLCLICK_UNTIL = Date.now() + 700;
                    const geo = computeCurvedFaceGeometry(e.clientX, e.clientY, spec);
                    commitFinalAndFinish(ctx, geo);
                    return;
                }
                const geo = computeCurvedFaceGeometry(e.clientX, e.clientY, spec);
                if (!geo) return;
                if (!spec._placement) {
                    if (geo.phase !== 'select' || !geo.lineHit?.conn) return;
                    spec._placement = {
                        originLine: { a: geo.lineHit.conn.start, b: geo.lineHit.conn.end },
                        currentLine: { a: geo.lineHit.conn.start, b: geo.lineHit.conn.end },
                        currentConn: geo.lineHit.conn,
                        layer: parseInt(geo.lineHit.conn.start.layer || geo.lineHit.conn.end.layer || 1, 10),
                        normal: null,
                        stationLines: [{ line: { a: geo.lineHit.conn.start, b: geo.lineHit.conn.end }, conn: geo.lineHit.conn }]
                    };
                    ctx.hover = null;
                    const nextGeo = computeCurvedFaceGeometry(e.clientX, e.clientY, spec);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildCurvedFacePreview(nextGeo));
                    }
                    return;
                }
                const finishHit = getDutchGableLineHit(e.clientX, e.clientY);
                if (finishHit?.conn && finishHit.conn !== spec._placement.currentConn) {
                    finish(ctx);
                    return;
                }
                clearPending();
                spec._pendingCommit = {
                    geo,
                    timer: setTimeout(() => {
                        const pending = spec._pendingCommit;
                        spec._pendingCommit = null;
                        if (!pending || !spec._placement) return;
                        commitSegmentAndAdvance(ctx, pending.geo);
                    }, 220)
                };
            },
            onDoubleClick(ctx, e) {
                window.__SMART_STICKER_SUPPRESS_DBLCLICK_UNTIL = Date.now() + 700;
                const geo = e && spec._placement ? computeCurvedFaceGeometry(e.clientX, e.clientY, spec) : null;
                if (spec._placement) commitFinalAndFinish(ctx, geo);
            }
        };
    }

    function normalizeAngleRad(angle) {
        const twoPi = Math.PI * 2;
        return ((angle % twoPi) + twoPi) % twoPi;
    }

    function signedAngleDeltaRad(a, b) {
        return Math.atan2(Math.sin(a - b), Math.cos(a - b));
    }

    function findPointAtCursor(clientX, clientY) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || typeof screenToImage !== 'function') return null;
        const img = screenToImage(clientX, clientY);
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const sRad = sr / cz;
        const vis = (typeof layerVisibility !== 'undefined' && layerVisibility) ? layerVisibility : {};
        let best = null;
        let bestD = sRad;
        activeGeometry.points.forEach(point => {
            const layer = point.layer || 1;
            if (vis[layer] === false) return;
            const d = Math.hypot(point.x - img.x, point.y - img.y);
            if (d < bestD) {
                bestD = d;
                best = point;
            }
        });
        return best;
    }

    function getIncidentRayAngles(center) {
        if (!center || !activeGeometry || !Array.isArray(activeGeometry.connections)) return [];
        const angles = [];
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            let other = null;
            if (conn.start === center) other = conn.end;
            else if (conn.end === center) other = conn.start;
            if (!other) return;
            const len = Math.hypot(other.x - center.x, other.y - center.y);
            if (len < 0.001) return;
            angles.push(normalizeAngleRad(Math.atan2(other.y - center.y, other.x - center.x)));
        });
        angles.sort((a, b) => a - b);
        const unique = [];
        angles.forEach(angle => {
            if (!unique.some(prev => Math.abs(normalizeAngleRad(angle - prev)) < 0.001 || Math.abs(normalizeAngleRad(prev - angle)) < 0.001)) {
                unique.push(angle);
            }
        });
        return unique;
    }

    function turretRotationFromGuides(center, count, cursorAngle) {
        const n = Math.max(1, Math.min(10, parseInt(count, 10) || 4));
        const twoPi = Math.PI * 2;
        const step = twoPi / n;
        const guides = getIncidentRayAngles(center);
        let best = { rotation: cursorAngle, guide: null, mode: 'free', delta: Infinity };
        guides.forEach(guide => {
            for (let idx = 0; idx < n; idx++) {
                const spokeRotation = normalizeAngleRad(guide - idx * step);
                const spokeDelta = Math.abs(signedAngleDeltaRad(spokeRotation, cursorAngle));
                if (spokeDelta < best.delta) best = { rotation: spokeRotation, guide, mode: 'on-line', delta: spokeDelta };
                const betweenRotation = normalizeAngleRad(guide - (idx + 0.5) * step);
                const betweenDelta = Math.abs(signedAngleDeltaRad(betweenRotation, cursorAngle));
                if (betweenDelta < best.delta) best = { rotation: betweenRotation, guide, mode: 'between-lines', delta: betweenDelta };
            }
        });
        const snapTol = 8 * Math.PI / 180;
        if (best.guide !== null && best.delta <= snapTol) return best;
        if (!guides.length) {
            const viewAxis = -((typeof viewRotation !== 'undefined' && Number.isFinite(viewRotation)) ? viewRotation : 0);
            [viewAxis, viewAxis + Math.PI / 2, viewAxis + Math.PI, viewAxis + Math.PI * 1.5].forEach(axis => {
                for (let idx = 0; idx < n; idx++) {
                    const axisRotation = normalizeAngleRad(axis - idx * step);
                    const axisDelta = Math.abs(signedAngleDeltaRad(axisRotation, cursorAngle));
                    if (axisDelta < best.delta) best = { rotation: axisRotation, guide: axis, mode: 'world-axis-spoke', delta: axisDelta };
                    const edgeRotation = normalizeAngleRad(axis + Math.PI / 2 - (idx + 0.5) * step);
                    const edgeDelta = Math.abs(signedAngleDeltaRad(edgeRotation, cursorAngle));
                    if (edgeDelta < best.delta) best = { rotation: edgeRotation, guide: axis, mode: 'world-axis-edge', delta: edgeDelta };
                }
            });
            if ((best.mode === 'world-axis-spoke' || best.mode === 'world-axis-edge') && best.delta <= snapTol) return best;
        }
        return { rotation: cursorAngle, guide: null, mode: 'free', delta: 0 };
    }

    function turretAngles(center, count, cursorAngle) {
        const n = Math.max(1, Math.min(10, parseInt(count, 10) || 4));
        const twoPi = Math.PI * 2;
        const snap = turretRotationFromGuides(center, n, cursorAngle);
        return {
            angles: Array.from({ length: n }, (_, idx) => normalizeAngleRad(snap.rotation + idx * twoPi / n)),
            snap
        };
    }

    function computeTurretConeGeometry(clientX, clientY, spec, placement = null) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || typeof screenToImage !== 'function') return null;
        const cursor = screenToImage(clientX, clientY);
        const center = placement?.center || findPointAtCursor(clientX, clientY);
        if (!center) return null;
        const count = Math.max(1, Math.min(10, parseInt(spec.sectionCount || 4, 10) || 4));
        const radius = Math.max(6, dist(center, cursor));
        const cursorAngle = normalizeAngleRad(Math.atan2(cursor.y - center.y, cursor.x - center.x));
        const angleResult = turretAngles(center, count, cursorAngle);
        const newAngles = angleResult.angles || [];
        const z = getDSMZAtXY(cursor.x, cursor.y);
        const outerZ = Number.isFinite(z) ? z : getPointZ(cursor);
        const layer = center.layer || 1;
        const newPoints = newAngles.map((angle, idx) => ({
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
            z: outerZ,
            layer,
            zLocked: true,
            angle,
            previewIndex: idx + 1
        }));
        const lines = newPoints.map(point => ({
            a: { x: center.x, y: center.y, z: getPointZ(center) },
            b: point,
            type: null,
            w: 2.8,
            dash: false,
            color: 'rgba(255,193,7,0.98)'
        }));
        for (let i = 0; i < newPoints.length; i++) {
            lines.push({
                a: newPoints[i],
                b: newPoints[(i + 1) % newPoints.length],
                type: null,
                w: 2.3,
                dash: false,
                color: 'rgba(0,255,255,0.88)'
            });
        }
        getIncidentRayAngles(center).forEach(angle => {
            lines.push({
                a: { x: center.x, y: center.y, z: getPointZ(center) },
                b: {
                    x: center.x + Math.cos(angle) * radius,
                    y: center.y + Math.sin(angle) * radius,
                    z: getPointZ(center)
                },
                w: 2,
                dash: true,
                opacity: 0.28,
                color: 'rgba(255,255,255,0.85)'
            });
        });
        return {
            spec,
            center,
            cursor,
            radius,
            count,
            outerZ,
            newAngles,
            rotationSnap: angleResult.snap,
            newPoints,
            lines,
            points: [
                { x: center.x, y: center.y, z: getPointZ(center), r: 5.5, fill: 'rgba(255,193,7,0.98)' },
                ...newPoints.map(point => ({ ...point, r: 4.5, fill: 'rgba(0,255,255,0.95)' }))
            ]
        };
    }

    function buildTurretConePreview(geo) {
        if (!geo) return { enabled: false };
        return { enabled: true, lines: geo.lines || [], points: geo.points || [] };
    }

    function resolveTurretPointOnExistingLine(point, center, fallbackZ) {
        if (!point || !activeGeometry || !Array.isArray(activeGeometry.connections)) return null;
        const pointLayer = center.layer || 1;
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const snapTol = Math.max(2, sr / cz);
        let best = null;
        activeGeometry.connections.forEach((conn, idx) => {
            if (!conn || !conn.start || !conn.end) return;
            const startLayer = conn.start.layer || 1;
            const endLayer = conn.end.layer || startLayer;
            if (typeof layerVisibility !== 'undefined' && (layerVisibility[startLayer] === false || layerVisibility[endLayer] === false)) return;
            const proj = projectPointToSegment2D(point, conn.start, conn.end);
            if (proj.t < 0.001 || proj.t > 0.999) return;
            if (proj.d > snapTol) return;
            if (!best || proj.d < best.d) best = { conn, connIndex: idx, ...proj };
        });
        if (!best) return null;
        const splitPoint = {
            x: best.x,
            y: best.y,
            z: fallbackZ,
            layer: pointLayer,
            zLocked: true
        };
        const original = best.conn;
        const idx = activeGeometry.connections.indexOf(original);
        if (idx < 0) return null;
        activeGeometry.points.push(splitPoint);
        const first = { ...original, start: original.start, end: splitPoint };
        const second = { ...original, start: splitPoint, end: original.end };
        activeGeometry.connections.splice(idx, 1, first, second);
        return splitPoint;
    }

    function commitTurretCone(geo) {
        if (!geo || !activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return false;
        if (typeof save2DState === 'function') save2DState();
        const hasConnection = (a, b) => activeGeometry.connections.some(conn =>
            conn && ((conn.start === a && conn.end === b) || (conn.start === b && conn.end === a))
        );
        const created = geo.newPoints.map(point => {
            const snapped = resolveTurretPointOnExistingLine(point, geo.center, geo.outerZ);
            if (snapped) {
                snapped.z = geo.outerZ;
                snapped.zLocked = true;
                return snapped;
            }
            const createdPoint = {
                x: point.x,
                y: point.y,
                z: geo.outerZ,
                layer: geo.center.layer || 1,
                zLocked: true
            };
            activeGeometry.points.push(createdPoint);
            return createdPoint;
        });
        created.forEach(point => {
            if (!hasConnection(geo.center, point)) {
                activeGeometry.connections.push({ start: geo.center, end: point, type: null });
            }
        });
        for (let i = 0; i < created.length; i++) {
            const a = created[i];
            const b = created[(i + 1) % created.length];
            if (a && b && a !== b && !hasConnection(a, b)) activeGeometry.connections.push({ start: a, end: b, type: null });
        }
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                selectedPoints.add(geo.center);
                created.forEach(point => selectedPoints.add(point));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }

    function makeTurretConeSticker() {
        const spec = {
            id: 'turret_cone',
            label: 'Turret / Cone',
            shortLabel: 'Turret',
            icon: turretConeIconSVG(),
            sectionCount: 8,
            _placement: null
        };
        return {
            ...spec,
            hideGhost: true,
            tooltip: 'Turret/Cone: click center point, move to set radius and height, click to place. Right-click cycles 3-10 new radial points.',
            onEnter() {
                this._placement = null;
                this.sectionCount = 8;
            },
            onExit() {
                this._placement = null;
            },
            onHover(ctx, e) {
                const geo = computeTurretConeGeometry(e.clientX, e.clientY, this, this._placement);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildTurretConePreview(geo));
            },
            onRightClick(ctx, e) {
                const current = Math.max(3, Math.min(10, Number(this.sectionCount || 4)));
                this.sectionCount = current >= 10 ? 3 : current + 1;
                ctx.hover = null;
                const geo = computeTurretConeGeometry(e.clientX, e.clientY, this, this._placement);
                if (geo) {
                    ctx.hover = { geo };
                    ctx._setPreview(buildTurretConePreview(geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onClick(ctx, e) {
                const geo = computeTurretConeGeometry(e.clientX, e.clientY, this, this._placement);
                if (!geo) return;
                if (!this._placement) {
                    this._placement = { center: geo.center };
                    ctx.hover = null;
                    const nextGeo = computeTurretConeGeometry(e.clientX, e.clientY, this, this._placement);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildTurretConePreview(nextGeo));
                    }
                    return;
                }
                if (!commitTurretCone(geo)) return;
                this._placement = null;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    function makeDormerSticker(spec) {
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel || spec.label,
            icon: spec.icon,
            hideGhost: true,
            tooltip: spec.curved
                ? `${spec.label}: click peak, click 45-degree shoulder length, click dormer depth. Right-click cycles 4/6 curve sections.`
                : `${spec.label}: click peak, click 45-degree shoulder length, click dormer depth.`,
            onEnter() {
                spec._placement = null;
            },
            onExit() {
                spec._placement = null;
            },
            onHover(ctx, e) {
                const geo = computeDormerGeometry(e.clientX, e.clientY, spec, spec._placement || null);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                ctx.hover = { geo };
                ctx._setPreview(buildDormerPreview(geo));
            },
            onRightClick(ctx, e) {
                if (!spec.curved) return;
                const options = spec.sectionOptions || [4, 6];
                const idx = Number.isInteger(spec.sectionIndex) ? spec.sectionIndex : 0;
                spec.sectionIndex = (idx + 1) % options.length;
                spec.sections = options[spec.sectionIndex] || 4;
                ctx.hover = null;
                const geo = computeDormerGeometry(e.clientX, e.clientY, spec, spec._placement || null);
                if (geo) {
                    ctx.hover = { geo };
                    ctx._setPreview(buildDormerPreview(geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onClick(ctx, e) {
                let placement = spec._placement || null;
                let geo = computeDormerGeometry(e.clientX, e.clientY, spec, placement);
                if (!geo) return;
                if (!placement) {
                    spec._placement = { step: 1, peakXY: geo.center, peakSnap: geo.peakSnap || null, hitFace: null };
                    ctx.hover = null;
                    const nextGeo = computeDormerGeometry(e.clientX, e.clientY, spec, spec._placement);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildDormerPreview(nextGeo));
                    }
                    return;
                }
                if (placement.step === 1) {
                    spec._placement = {
                        ...placement,
                        step: 2,
                        sideSign: geo.sideSign,
                        hipRun: geo.hipRun,
                        hitFace: geo.hit?.face || placement.hitFace || null
                    };
                    ctx.hover = null;
                    const nextGeo = computeDormerGeometry(e.clientX, e.clientY, spec, spec._placement);
                    if (nextGeo) {
                        ctx.hover = { geo: nextGeo };
                        ctx._setPreview(buildDormerPreview(nextGeo));
                    }
                    return;
                }
                spec._placement = null;
                if (!commitDormer(geo)) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    function commitRoofFeature(geo) {
        if (!geo || !activeGeometry || !activeGeometry.points || !activeGeometry.connections) return false;
        if (typeof save2DState === 'function') save2DState();
        activeGeometry.points.push(...geo.featurePoints);
        const edgeBuckets = makeEdgeBuckets(geo);
        splitExistingLinesForFeature(geo, edgeBuckets);
        addFeatureLoopConnections(geo, edgeBuckets);
        cleanupOrphanPointsInsideFeature(geo);
        syncManualFacesForFeature(geo);
        removeOldPointsInsideFeature(geo);
        unlockRoofFeaturePointHeights(activeGeometry);
        try {
            if (typeof selectedPoints !== 'undefined') {
                selectedPoints.clear();
                geo.featurePoints.forEach(p => selectedPoints.add(p));
            }
            if (typeof selectedLines !== 'undefined') selectedLines.clear();
            if (typeof selectedVents !== 'undefined') selectedVents.clear();
        } catch (e) {}
        try {
            if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
        } catch (e) {}
        request2DRender();
        return true;
    }
    function makeRoofFeatureSticker(spec) {
        return {
            id: spec.id,
            label: spec.label,
            shortLabel: spec.shortLabel || spec.label,
            icon: spec.icon,
            hideGhost: true,
            tooltip: `${spec.label}: click a roof face to place. Right-click cycles sizes. R rotates 90 degrees. Shift keeps placing.`,
            onEnter() {
                spec.rotationQuarter = 0;
            },
            onHover(ctx, e) {
                const geo = computeRoofFeatureGeometry(e.clientX, e.clientY, spec);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                const prev = ctx.hover?.geo;
                if (
                    prev &&
                    prev.spec.id === spec.id &&
                    formatFeatureSize(prev.size || getRoofFeatureSize(spec)) === formatFeatureSize(geo.size) &&
                    Math.hypot(prev.center.x - geo.center.x, prev.center.y - geo.center.y) < 0.5
                ) return;
                ctx.hover = { geo };
                ctx._setPreview(buildRoofFeaturePreview(geo));
            },
            onRightClick(ctx, e) {
                const options = Array.isArray(spec.sizeOptions) && spec.sizeOptions.length ? spec.sizeOptions : null;
                if (!options || options.length < 2) return;
                spec.sizeIndex = ((Number.isInteger(spec.sizeIndex) ? spec.sizeIndex : 0) + 1) % options.length;
                ctx.hover = null;
                const geo = computeRoofFeatureGeometry(e.clientX, e.clientY, spec);
                if (geo) {
                    ctx.hover = { geo };
                    ctx._setPreview(buildRoofFeaturePreview(geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onRotate(ctx) {
                spec.rotationQuarter = ((Number(spec.rotationQuarter || 0) + 1) % 2);
                ctx.hover = null;
                const e = ctx.__lastHoverEvt;
                if (e) {
                    const geo = computeRoofFeatureGeometry(e.clientX, e.clientY, spec);
                    if (geo) {
                        ctx.hover = { geo };
                        ctx._setPreview(buildRoofFeaturePreview(geo));
                        return;
                    }
                }
                ctx._setPreview({ enabled: false });
            },
            onClick(ctx, e) {
                let geo = ctx.hover?.geo;
                if (!geo || geo.spec.id !== spec.id) geo = computeRoofFeatureGeometry(e.clientX, e.clientY, spec);
                if (!geo) return;
                const ok = commitRoofFeature(geo);
                if (!ok) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    // ----------------------------- 
    // Sticker factory
    // ----------------------------- 
    function makeCorniceSticker() {
        const modes = [
            { style: 'hipped', variant: 'standard', label: 'Hipped Cornice' },
            { style: 'unhipped', variant: 'standard', label: 'Unhipped Cornice' },
            { style: 'hipped', variant: 'underlayer', label: 'Hipped Cornice Underlayer' },
            { style: 'unhipped', variant: 'underlayer', label: 'Unhipped Cornice Underlayer' }
        ];
        const currentMode = (def) => modes[def.modeIndex || 0] || modes[0];
        return {
            id: 'cornice',
            label: 'Cornice',
            shortLabel: 'Cornice',
            icon: hippedCorniceIconSVG(),
            tooltip: 'Place on eave+rake, rake+valley, or rake+valley+eave corner. Right-click cycles hipped, unhipped, hipped underlayer, unhipped underlayer. Click commits. Shift keeps placing.',
            modeIndex: 0,
            onHover(ctx, e) {
                ensureLineTypesAvailableOnce(ctx);
                const mode = currentMode(this);
                const hit = findJunctionAtCursor(e.clientX, e.clientY);
                if (!hit) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                const geo = computeCorniceGeometry(hit, mode.style, mode.variant);
                if (!geo) {
                    if (ctx.hover !== null) {
                        ctx.hover = null;
                        ctx._setPreview({ enabled: false });
                    }
                    return;
                }
                const prevCorner = ctx.hover?.hit?.corner || null;
                const prevStyle = ctx.hover?.geo?.style || null;
                const prevVariant = ctx.hover?.geo?.variant || 'standard';
                if (prevCorner === hit.corner && prevStyle === mode.style && prevVariant === mode.variant) return;
                ctx.hover = { hit, geo };
                ctx._setPreview(buildPreview(hit, geo));
            },
            onRightClick(ctx, e) {
                this.modeIndex = ((Number.isInteger(this.modeIndex) ? this.modeIndex : 0) + 1) % modes.length;
                const mode = currentMode(this);
                ctx.hover = null;
                const hit = findJunctionAtCursor(e.clientX, e.clientY);
                const geo = hit ? computeCorniceGeometry(hit, mode.style, mode.variant) : null;
                if (hit && geo) {
                    ctx.hover = { hit, geo };
                    ctx._setPreview(buildPreview(hit, geo));
                } else {
                    ctx._setPreview({ enabled: false });
                }
            },
            onClick(ctx, e) {
                const h = ctx.hover;
                if (!h || !h.hit || !h.geo) return;
                const ok = commitCornice(h.hit, h.geo);
                if (!ok) return;
                ctx.hover = null;
                ctx._setPreview({ enabled: false });
                if (!e.shiftKey) ctx.exitPlacement();
                else {
                    const def = ctx.getActiveDef();
                    ctx._scheduleHover(def, e);
                }
            }
        };
    }
    // ----------------------------- 
    // Register cornice sticker
    // ----------------------------- 
    SmartStickers.register(makeCorniceSticker());
    SmartStickers.register(makeRoofFeatureSticker({
        id: 'skylight',
        kind: 'skylight',
        label: 'Skylight',
        shortLabel: 'Skylight',
        widthFt: 2,
        heightFt: 3,
        sizeOptions: [
            { widthFt: 2, heightFt: 3 },
            { widthFt: 2, heightFt: 2 },
            { widthFt: 2, heightFt: 4 },
            { widthFt: 3, heightFt: 3 },
            { widthFt: 4, heightFt: 4, label: '4x4' }
        ],
        sizeIndex: 0,
        icon: skylightIconSVG()
    }));
    SmartStickers.register(makeRoofFeatureSticker({
        id: 'chimney',
        kind: 'chimney',
        label: 'Chimney',
        shortLabel: 'Chimney',
        widthFt: 2,
        heightFt: 2,
        sizeMode: 'world',
        sizeOptions: [
            { widthFt: 2, heightFt: 2, label: '2x2' },
            { widthFt: 3, heightFt: 2, label: '2x3' },
            { widthFt: 4, heightFt: 2, label: '2x4' },
            { widthFt: 5, heightFt: 2, label: '2x5' },
            { widthFt: 3, heightFt: 3, label: '3x3' },
            { widthFt: 4, heightFt: 3, label: '3x4' },
            { widthFt: 5, heightFt: 3, label: '3x5' }
        ],
        sizeIndex: 6,
        icon: chimneyIconSVG()
    }));
    SmartStickers.register(makeRoofFeatureSticker({
        id: 'protrusion',
        kind: 'protrusion',
        label: 'Protrusion',
        shortLabel: 'Protr.',
        widthFt: 1,
        heightFt: 1,
        sizeOptions: [
            { widthFt: 1, heightFt: 1, label: '1x1' },
            { widthFt: 2, heightFt: 2, label: '2x2' }
        ],
        sizeIndex: 0,
        icon: protrusionIconSVG()
    }));
    SmartStickers.register(makeDutchGableSticker());
    SmartStickers.register(makeJerkinHeadSticker());
    SmartStickers.register(makeTurretConeSticker());
    SmartStickers.register(makeDormerSticker({
        id: 'two_face_dormer',
        label: 'Two-Face Dormer',
        shortLabel: '2-Face Dormer',
        triangle: false,
        hipRunFt: 3,
        sideRunFt: 5,
        overhangFt: 1.5,
        icon: twoFaceDormerIconSVG()
    }));
    SmartStickers.register(makeDormerSticker({
        id: 'curved_dormer',
        label: 'Curved Dormer',
        shortLabel: 'Curved Dormer',
        triangle: false,
        curved: true,
        sections: 4,
        sectionOptions: [4, 6],
        sectionIndex: 0,
        hipRunFt: 3,
        sideRunFt: 5,
        overhangFt: 1.5,
        icon: curvedDormerIconSVG()
    }));
    SmartStickers.register(makeDormerSticker({
        id: 'three_face_dormer',
        label: 'Three-Face Dormer',
        shortLabel: '3-Face Dormer',
        triangle: true,
        hipRunFt: 3,
        sideRunFt: 5,
        overhangFt: 1.5,
        icon: threeFaceDormerIconSVG()
    }));
    SmartStickers.register(makeEyebrowSticker());
    SmartStickers.register(makeCurvedFaceSticker());
    // ----------------------------- 
    // Boot
    // ----------------------------- 
    function boot() {
        SmartStickers._ensureUI();
        SmartStickers._rebuildBar();
        try {
            unlockRoofFeaturePointHeights(activeGeometry);
        } catch (e) {}
    }
    window.explainJerkinLengthSnaps = function explainJerkinLengthSnaps() {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return [];
        const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
        const sr = (typeof snapRadius !== 'undefined' && snapRadius) ? snapRadius : 20;
        const maxLineDist = Math.max(3, (sr / cz) * 1.5);
        const selected = (typeof selectedPoints !== 'undefined' && selectedPoints && selectedPoints.size)
            ? Array.from(selectedPoints)
            : activeGeometry.points;
        const rows = [];
        selected.forEach(origin => {
            getPointConnectionsForJerkin(origin).forEach(conn => {
                const other = otherConnPoint(conn, origin);
                if (!other) return;
                const dir = norm({ x: other.x - origin.x, y: other.y - origin.y });
                getJerkinPerpendicularEaveAnchorsFromOppositeRidgeEnd(
                    origin,
                    { conn, other, dir },
                    2
                ).forEach(anchor => {
                    rows.push({
                        source: 'perpendicular-eave',
                        origin: activeGeometry.points.indexOf(origin),
                        toward: activeGeometry.points.indexOf(other),
                        length: Number(anchor.length.toFixed(2)),
                        crossX: Number(anchor.cross.x.toFixed(2)),
                        crossY: Number(anchor.cross.y.toFixed(2)),
                        depth: anchor.depth
                    });
                });
                getJerkinLengthAnchorsOnRidge(origin, dir, maxLineDist).forEach(anchor => {
                    rows.push({
                        source: 'reconstructed-jerkin',
                        origin: activeGeometry.points.indexOf(origin),
                        toward: activeGeometry.points.indexOf(other),
                        length: Number(anchor.length.toFixed(2)),
                        tipX: Number(anchor.tip.x.toFixed(2)),
                        tipY: Number(anchor.tip.y.toFixed(2)),
                        crossX: Number(anchor.cross.x.toFixed(2)),
                        crossY: Number(anchor.cross.y.toFixed(2)),
                        center: activeGeometry.points.indexOf(anchor.center)
                    });
                });
            });
        });
        try {
            console.table(rows);
        } catch (e) {
            console.log(rows);
        }
        return rows;
    };
    window.addEventListener('load', boot);
})();
