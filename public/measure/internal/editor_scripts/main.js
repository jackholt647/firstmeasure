/* main.js - Central Control & State */

const GOOGLE_API_KEY = String(window.FIRSTMEASURE_BROWSER_GOOGLE_API_KEY || '').trim();
const AZURE_MAPS_KEY = String(window.FIRSTMEASURE_AZURE_MAPS_KEY || '').trim();

const LAYER_STYLES = {
    1: { line: '#00FF00', dot: '#FFFF00' },
    2: { line: '#FFA500', dot: '#FF0000' },
    3: { line: '#0000FF', dot: '#800080' },
    4: { line: '#9C27B0', dot: '#FFC0CB' },
    5: { line: '#006400', dot: '#DAA520' },
    6: { line: '#000080', dot: '#FF00FF' }
};

const BASE_VIEWS = [
    { id: 'solar',  label: 'Solar Aerial' },
    { id: 'google', label: 'Google Maps' },
    { id: 'azure',  label: 'Bing Maps' },
    { id: 'apple',  label: 'Apple Maps' },
    { id: 'height', label: 'Height Map' },
];

/* main.js - Scaling & Offset Configuration */

// Configuration for aligning base layers to the Solar Heightmap
let LAYER_CONFIG = {
    'solar':  { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 },
    // 'google': { scale: 0.8, x: 9, y:-26, rot: 0, fineScale: 1.0 },
    'google': { scale: 1.0, x: 0, y:0, rot: 0, fineScale: 1.0 },
    'azure':  { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 },
    
    // 'apple':  { scale: 1.13, x: 0, y: 0, rot: 0, fineScale: 1.0 }, 
    'apple':  { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 }, 
    
    'height': { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 }
};

let _applePrefetchPromise = null;
let _applePrefetchRunId = 0;
let RADIUS_METERS = 60;

/* ============================================================
   PROJECT TYPE BADGE — Top Bar Indicator
   
   Displays "Residential", "Commercial", or "Multi-Family"
   color-coded in the top bar directly after the logo.
   
   ADD THIS to the bottom of main.js (or include as a separate file).
   ============================================================ */

const PROJECT_TYPE_STYLES = {
    residential: { label: 'Residential',  bg: '#e3f2fd', color: '#1565c0', border: '#90caf9' },
    commercial:  { label: 'Commercial',   bg: '#fff3e0', color: '#e65100', border: '#ffcc80' },
    multifamily: { label: 'Multi-Family', bg: '#e8f5e9', color: '#2e7d32', border: '#a5d6a7' },
};

/**
 * Injects the badge element into the DOM (once).
 * Tries to place it right after the logo in the top bar.
 */
function injectProjectTypeBadge() {
    if (document.getElementById('project-type-badge')) return; // already injected

    const badge = document.createElement('span');
    badge.id = 'project-type-badge';
    badge.style.cssText = `
        display: none;
        font-size: 11px;
        font-weight: 700;
        padding: 3px 10px;
        border-radius: 20px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        white-space: nowrap;
        margin-left: 10px;
        vertical-align: middle;
        border: 1.5px solid transparent;
        transition: all 0.25s ease;
    `;

    // Strategy: find the logo, insert after it.
    // Common patterns: <img> with class/id containing "logo", or an <a> wrapping the logo.
    const logo =
        document.querySelector('.app-logo') ||
        document.querySelector('#app-logo') ||
        document.querySelector('.logo') ||
        document.querySelector('#logo') ||
        document.querySelector('header img') ||
        document.querySelector('.top-bar img') ||
        document.querySelector('.header-left img');

    if (logo) {
        // Insert right after the logo (or its parent <a>)
        const anchor = (logo.parentElement && logo.parentElement.tagName === 'A')
            ? logo.parentElement
            : logo;
        anchor.parentNode.insertBefore(badge, anchor.nextSibling);
    } else {
        // Fallback: insert before the address input in the header
        const addrInput = document.getElementById('manualAddress');
        if (addrInput && addrInput.parentNode) {
            addrInput.parentNode.insertBefore(badge, addrInput);
        }
    }

    const structureBadge = document.createElement('span');
    structureBadge.id = 'structure-count-badge';
    structureBadge.style.cssText = `
        display: none;
        font-size: 11px;
        font-weight: 700;
        padding: 3px 10px;
        border-radius: 20px;
        white-space: nowrap;
        margin-left: 3px;
        vertical-align: middle;
        border: 1.5px solid #d2d6dc;
        background: #f3f4f6;
        color: #4b5563;
        transition: all 0.25s ease;
    `;

    if (badge.parentNode) {
        if (badge.nextSibling) badge.parentNode.insertBefore(structureBadge, badge.nextSibling);
        else badge.parentNode.appendChild(structureBadge);
    }
}

/**
 * Updates the badge to reflect the current project type.
 * Call this whenever a project is loaded.
 *
 * @param {string|null} projectType  'residential' | 'commercial' | 'multifamily' | null to hide
 */
window.updateProjectTypeBadge = function(projectType) {
    injectProjectTypeBadge();

    const badge = document.getElementById('project-type-badge');
    if (!badge) return;

    const key = (projectType || '').toLowerCase().trim();
    const style = PROJECT_TYPE_STYLES[key];

    if (!style) {
        badge.style.display = 'none';
        return;
    }

    badge.textContent = style.label;
    badge.style.display = 'inline-block';
    badge.style.backgroundColor = style.bg;
    badge.style.color = style.color;
    badge.style.borderColor = style.border;
};

window.updateStructureCountBadge = function(structureCount) {
    injectProjectTypeBadge();

    const badge = document.getElementById('structure-count-badge');
    if (!badge) return;

    const count = Number(structureCount);
    if (!Number.isFinite(count) || count <= 1) {
        badge.style.display = 'none';
        badge.textContent = '';
        return;
    }

    badge.textContent = `${count} STRUCTURES`;
    badge.style.display = 'inline-block';
};

// Inject on page load (hidden until a project is loaded)
window.addEventListener('load', () => {
    injectProjectTypeBadge();
});
// =====================================================
// Radius + meters-per-pixel (SOURCE OF TRUTH)
// - Persists per-project by storing in LAYER_CONFIG.__radius.scale
// =====================================================
window.getRadiusMeters = function getRadiusMeters() {
  // Prefer runtime radius. Structure mode can temporarily use a local radius
  // without changing the persisted project/global radius in layer_config.
  const v = Number(window.RADIUS_METERS);
  if (Number.isFinite(v) && v > 0) return v;

  // Next: per-project stored value (survives save/load)
  try {
    const cfgRad = (typeof LAYER_CONFIG !== 'undefined' &&
      LAYER_CONFIG && LAYER_CONFIG.__radius &&
      Number.isFinite(+LAYER_CONFIG.__radius.scale)) ? +LAYER_CONFIG.__radius.scale : NaN;

    if (Number.isFinite(cfgRad) && cfgRad > 0) return cfgRad;
  } catch (e) {}

  // Next: compile-time constant
  try {
    const base = (typeof RADIUS_METERS !== 'undefined') ? Number(RADIUS_METERS) : NaN;
    if (Number.isFinite(base) && base > 0) return base;
  } catch (e) {}

  return 20;
};

window.setRadiusMeters = function setRadiusMeters(r, options = {}) {
  const v = Number(r);
  const out = (Number.isFinite(v) && v > 0) ? v : window.getRadiusMeters();
  const persist = options && options.persist === false ? false : true;

  window.RADIUS_METERS = out;

  // Persist into layer_config (already saved/restored by your code)
  try {
    if (persist && typeof LAYER_CONFIG !== 'undefined' && LAYER_CONFIG) {
      if (!LAYER_CONFIG.__radius || typeof LAYER_CONFIG.__radius !== 'object') {
        LAYER_CONFIG.__radius = { scale: out, x: 0, y: 0, rot: 0, fineScale: 1.0 };
      }
      LAYER_CONFIG.__radius.scale = out;
    }
  } catch (e) {}

  return out;
};

window.setImageMetersPerPx = function setImageMetersPerPx(value) {
  const v = Number(value);
  window.IMAGE_METERS_PER_PX = (Number.isFinite(v) && v > 0) ? v : null;
  return window.IMAGE_METERS_PER_PX;
};

window.getImageMetersPerPx = function getImageMetersPerPx() {
  const v = Number(window.IMAGE_METERS_PER_PX);
  return (Number.isFinite(v) && v > 0) ? v : 0;
};

window.getMetersPerPx = function getMetersPerPx() {
  const explicit = window.getImageMetersPerPx ? window.getImageMetersPerPx() : Number(window.IMAGE_METERS_PER_PX);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const w = (typeof imageWidth !== 'undefined' && Number.isFinite(imageWidth) && imageWidth > 0) ? imageWidth : 0;
  if (!w) return 0;
  return (window.getRadiusMeters() * 2) / w;
};

window.getSolarPixelSizeMeters = function getSolarPixelSizeMeters(radiusMeters) {
  const radius = Number(radiusMeters);
  if (!Number.isFinite(radius) || radius <= 0) return 0.1;
  if (radius <= 100) return 0.1;
  if (radius <= 500) return 0.5;
  return Math.ceil(radius / 1000);
};

// Seed default radius (20m) for normal projects
window.setRadiusMeters((typeof RADIUS_METERS !== 'undefined') ? RADIUS_METERS : 20);
window.setImageMetersPerPx(null);


function drawScaledImage(ctx, img, targetW, targetH, scale, offX, offY, rotRad = 0, fineScale = 1.0) {
    const sw = img.width;
    const sh = img.height;

    // Combine "base scale" with "fine scale"
    const effScale = (scale || 1.0) * (fineScale || 1.0);

    // Window in source image
    const cropW = sw / effScale;
    const cropH = sh / effScale;

    // Centered crop
    let sourceX = (sw - cropW) / 2;
    let sourceY = (sh - cropH) / 2;

    // Apply offsets (same semantics you already use)
    sourceX += (offX || 0);
    sourceY += (offY || 0);

    // Draw with rotation about canvas center
    ctx.save();
    ctx.clearRect(0, 0, targetW, targetH);

    const cx = targetW / 2;
    const cy = targetH / 2;

    ctx.translate(cx, cy);
    if (rotRad) ctx.rotate(rotRad);

    // Draw crop so that it fills the target, centered on origin
    ctx.drawImage(
        img,
        sourceX, sourceY, cropW, cropH,
        -targetW / 2, -targetH / 2, targetW, targetH
    );

    ctx.restore();
}


function setHeaderAddress(addr) {
  const headerInput = document.getElementById('manualAddress');
  if (headerInput && addr) headerInput.value = addr;

  // Keep hidden input in sync too (you already rely on this in places)
  const hidden = document.getElementById('addressInput');
  if (hidden && addr) hidden.value = addr;
}


// Global State
let showFacesLayer = true; // Default to true
let showLineTypes = false;
let showCenterpoints = true;
let googleJsMap = null; // New global map object
let geocoder, autocomplete, cesiumViewer;
let currentProjectId = null;
window.currentProject3DTileManifestUrl = null;
window.currentProjectLoadedAppMetadata = {};
let mapCenterLat, mapCenterLng, segmentStats = [];
let layerData = { rgb: null, mask: null, dsm: null, flux: null, google: null };
let imageWidth = 0, imageHeight = 0;
let currentZoom = 1;
let panX = 0, panY = 0;
let viewRotation = 0; // In Radians
let showGridLayer = true; // Default On
let autoRunGemini = false;
let currentViewId = 'solar';
let selectionMode = 'POINT';
let interactState = 'IDLE';
let isPanning = false;
let dragStartX = 0, dragStartY = 0;
let isFreeMove = false;
let selectionBoxStart = { x: 0, y: 0 };
let selectedPoints = new Set();
let selectedLines = new Set();
let selectedVents = new Set(); 
let moveOriginals = new Map();
let tempPoint = null;
let snapRadius = 20;
let activeGeometry = null;
let parallelState = { signature: '', index: 0, originals: new Map() };
let flattenState = { signature: '', index: 0, originals: new Map() }; 
let flipState = { signature: '', mode: 0, center: { x: 0, y: 0 }, originals: new Map() }; // <--- ADDED
let history2D = [];
let redo2D = [];
let lastRawGeminiOutput = null;
let layerVisibility = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
let quadViewCroppedImage = null; 


// 3D Globals
let scene, camera, renderer, controls, mesh, geometry;
let geometryGroup;
let raycaster, mouse;
let markers3D = [];
let lines3D = [];
let dsmMin = 0, dsmMax = 0;

// Mask & AI State
let maskEnabled = false;
let maskColor = { r: 255, g: 255, b: 255 };
let maskTolerance = 10;
let maskImageData = null;
let geminiModel = 'gemini-3-pro-image-preview';
let cachedGeoImage = null;
let viewCanvases = {};
let thumbCanvases = {};
let aiViewCount = 0;
let viewConfigs = [];
let hasGeoImage = false;
const VISUAL_ADJUSTMENT_DEFAULTS = {
    exposure: 0,
    shadows: 0,
    highlights: 0,
    sharpness: 0,
    saturation: 0,
    contrast: 0
};
let visualAdjustments = {};
let adjustedViewCanvases = {};

// --- Solar Roof Mask (from Solar API maskUrl) ---
let roofMaskEnabled = false;      // default ON (toggle in toolbar)
let roofMaskData = null;         // Uint8Array / TypedArray length = imageWidth*imageHeight
let maskedViewCanvases = {};     // viewId -> { canvas, stamp }
let deferredProjectTiffLoadRun = 0;

let isAdjustingLocation = false;
let adjustState = { lat: 0, lng: 0, radius: 20 };

let isSplatMode = false;

function runAfterInitialEditorPaint(task) {
    const run = () => {
        Promise.resolve().then(task).catch(err => {
            console.warn('[ProjectLoad] Deferred task failed:', err);
        });
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1200 });
    } else {
        setTimeout(run, 250);
    }
}

async function fetchProjectTiffRasters(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`TIFF fetch failed (${response.status})`);
    const tiff = await GeoTIFF.fromArrayBuffer(await response.arrayBuffer());
    const image = await tiff.getImage();
    return {
        image,
        rasters: await image.readRasters(),
        metersPerPx: resolveTiffMetersPerPx(image, mapCenterLat)
    };
}

function normalizeTiffResolutionMetersPerPx(rawX, rawY, centerLat) {
    const x = Math.abs(Number(rawX));
    const y = Math.abs(Number(rawY));
    if (!Number.isFinite(x) || x <= 0) return 0;
    const yValid = Number.isFinite(y) && y > 0;

    if (x < 0.01 && (!yValid || y < 0.01)) {
        const lat = Number(centerLat);
        const metersPerLatDegree = 111132;
        const metersPerLngDegree = metersPerLatDegree * Math.cos((Number.isFinite(lat) ? lat : 0) * Math.PI / 180);
        const xMeters = x * metersPerLngDegree;
        const yMeters = yValid ? y * metersPerLatDegree : xMeters;
        return (Number.isFinite(xMeters) && xMeters > 0 && Number.isFinite(yMeters) && yMeters > 0)
            ? Math.sqrt(xMeters * yMeters)
            : 0;
    }

    return yValid ? Math.sqrt(x * y) : x;
}

function resolveTiffMetersPerPx(image, centerLat) {
    if (!image) return 0;
    try {
        if (typeof image.getResolution === 'function') {
            const resolution = image.getResolution();
            if (Array.isArray(resolution) && resolution.length >= 2) {
                const mpp = normalizeTiffResolutionMetersPerPx(resolution[0], resolution[1], centerLat);
                if (mpp) return mpp;
            }
        }
    } catch (e) {}

    try {
        const dir = (typeof image.getFileDirectory === 'function') ? image.getFileDirectory() : null;
        const scale = dir && (dir.ModelPixelScale || dir.ModelPixelScaleTag);
        if (scale && scale.length >= 2) {
            const mpp = normalizeTiffResolutionMetersPerPx(scale[0], scale[1], centerLat);
            if (mpp) return mpp;
        }
    } catch (e) {}

    return 0;
}

function getContextMetersPerPx(ctx) {
    const explicit = Number(ctx && ctx.metersPerPx);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const radius = Number(ctx && ctx.radius);
    const width = Number(ctx && ctx.width);
    return (Number.isFinite(radius) && radius > 0 && Number.isFinite(width) && width > 0)
        ? (radius * 2) / width
        : 0;
}

function getCurrentImageProjectionContext() {
    return {
        centerLat: Number(mapCenterLat),
        centerLng: Number(mapCenterLng),
        radius: window.getRadiusMeters ? Number(window.getRadiusMeters()) : Number(window.RADIUS_METERS || 20),
        width: Number(imageWidth),
        height: Number(imageHeight),
        metersPerPx: window.getMetersPerPx ? Number(window.getMetersPerPx()) : 0
    };
}

function isValidImageProjectionContext(ctx) {
    return ctx
        && Number.isFinite(ctx.centerLat)
        && Number.isFinite(ctx.centerLng)
        && Number.isFinite(ctx.radius)
        && ctx.radius > 0
        && Number.isFinite(getContextMetersPerPx(ctx))
        && getContextMetersPerPx(ctx) > 0
        && Number.isFinite(ctx.width)
        && ctx.width > 0
        && Number.isFinite(ctx.height)
        && ctx.height > 0;
}

function imagePointToLatLngForContext(pt, ctx) {
    if (!pt || !isValidImageProjectionContext(ctx)) return null;
    const mLat = 111132;
    const mLng = 111132 * Math.cos(ctx.centerLat * Math.PI / 180);
    const metersPerPx = getContextMetersPerPx(ctx);
    if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;
    return {
        lat: ctx.centerLat + (((ctx.height / 2) - Number(pt.y || 0)) * metersPerPx / mLat),
        lng: ctx.centerLng + ((Number(pt.x || 0) - (ctx.width / 2)) * metersPerPx / mLng)
    };
}

function latLngToImagePointForContext(latLng, ctx) {
    if (!latLng || !isValidImageProjectionContext(ctx)) return null;
    const mLat = 111132;
    const mLng = 111132 * Math.cos(ctx.centerLat * Math.PI / 180);
    const metersPerPx = getContextMetersPerPx(ctx);
    if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;
    return {
        x: (ctx.width / 2) + (((Number(latLng.lng) - ctx.centerLng) * mLng) / metersPerPx),
        y: (ctx.height / 2) - (((Number(latLng.lat) - ctx.centerLat) * mLat) / metersPerPx)
    };
}

function reprojectActiveGeometryForImageContext(fromCtx, toCtx) {
    if (!activeGeometry || !isValidImageProjectionContext(fromCtx) || !isValidImageProjectionContext(toCtx)) return false;
    if (
        Math.abs(fromCtx.centerLat - toCtx.centerLat) < 1e-12
        && Math.abs(fromCtx.centerLng - toCtx.centerLng) < 1e-12
        && Math.abs(fromCtx.radius - toCtx.radius) < 1e-9
        && Math.abs(getContextMetersPerPx(fromCtx) - getContextMetersPerPx(toCtx)) < 1e-12
        && Math.abs(fromCtx.width - toCtx.width) < 1e-9
        && Math.abs(fromCtx.height - toCtx.height) < 1e-9
    ) {
        return false;
    }
    const items = [
        ...(Array.isArray(activeGeometry.points) ? activeGeometry.points : []),
        ...(Array.isArray(activeGeometry.vents) ? activeGeometry.vents : [])
    ];
    items.forEach(item => {
        const latLng = imagePointToLatLngForContext(item, fromCtx);
        const next = latLngToImagePointForContext(latLng, toCtx);
        if (!next) return;
        item.x = next.x;
        item.y = next.y;
    });
    window.__geoMutStamp = (window.__geoMutStamp || 0) + 1;
    return items.length > 0;
}
window.reprojectActiveGeometryForImageContext = reprojectActiveGeometryForImageContext;
window.getCurrentImageProjectionContext = getCurrentImageProjectionContext;

function is2DWorkspaceOutOfSyncWithImageSize() {
    if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) return false;
    const canvas = document.getElementById('mainCanvas');
    const zoomLayer = document.getElementById('zoom-layer');
    const svg = document.getElementById('geoSvg');
    if (!canvas || !zoomLayer || !svg) return true;
    const layerW = parseFloat(zoomLayer.style.width || '0');
    const layerH = parseFloat(zoomLayer.style.height || '0');
    return canvas.width !== imageWidth
        || canvas.height !== imageHeight
        || Math.round(layerW) !== imageWidth
        || Math.round(layerH) !== imageHeight
        || svg.getAttribute('viewBox') !== `0 0 ${imageWidth} ${imageHeight}`;
}

function refreshAfterDeferredProjectTiffs(loaded) {
    if (layerData.mask && layerData.mask[0]) roofMaskData = layerData.mask[0];
    maskedViewCanvases = {};

    if (loaded.rgb) delete viewCanvases.solar;
    if (loaded.dsm) delete viewCanvases.height;
    const rebuilt2DWorkspace = is2DWorkspaceOutOfSyncWithImageSize();
    if (rebuilt2DWorkspace && typeof setupView === 'function') {
        setupView();
    }
    if ((loaded.rgb || loaded.dsm) && layerData.rgb && layerData.dsm && typeof init3D === 'function') {
        init3D();
    }
    if (typeof redrawThumbs === 'function') redrawThumbs();
    if (typeof currentViewId !== 'undefined' && currentViewId === 'height' && loaded.dsm && typeof selectView === 'function') {
        selectView('height');
    } else if (!rebuilt2DWorkspace && typeof redrawCanvas === 'function') {
        redrawCanvas();
    }
    if ((loaded.dsm || loaded.mask) && activeGeometry && typeof triggerLiveUpdate === 'function') {
        triggerLiveUpdate();
    }
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
}

function scheduleDeferredProjectTiffLoad(projectId, assets, options = {}) {
    const runId = ++deferredProjectTiffLoadRun;
    const tiffAssets = {
        rgb: assets && assets.rgb,
        dsm: assets && assets.dsm,
        mask: assets && assets.mask
    };
    if (!tiffAssets.rgb && !tiffAssets.dsm && !tiffAssets.mask && !options.ensureMissingMask) return;

    runAfterInitialEditorPaint(async () => {
        if (window.__structureLocalImageryActive) {
            setTimeout(() => {
                if (runId === deferredProjectTiffLoadRun) {
                    scheduleDeferredProjectTiffLoad(projectId, assets, options);
                }
            }, 1000);
            return;
        }
        const loaded = { rgb: false, dsm: false, mask: false };
        const previousImageContext = getCurrentImageProjectionContext();
        const jobs = [];
        if (tiffAssets.rgb) {
            jobs.push(fetchProjectTiffRasters(tiffAssets.rgb).then(({ image, rasters, metersPerPx }) => {
                if (runId !== deferredProjectTiffLoadRun) return;
                imageWidth = image.getWidth();
                imageHeight = image.getHeight();
                if (window.setImageMetersPerPx) {
                    window.setImageMetersPerPx(
                        metersPerPx
                        || Number(window.currentProjectLoadedAppMetadata && window.currentProjectLoadedAppMetadata.imageMetersPerPx)
                        || (window.getSolarPixelSizeMeters ? window.getSolarPixelSizeMeters(window.getRadiusMeters ? window.getRadiusMeters() : window.RADIUS_METERS) : 0)
                    );
                }
                layerData.rgb = rasters;
                loaded.rgb = true;
            }));
        }
        if (tiffAssets.dsm) {
            jobs.push(fetchProjectTiffRasters(tiffAssets.dsm).then(({ rasters }) => {
                if (runId !== deferredProjectTiffLoadRun) return;
                layerData.dsm = rasters;
                loaded.dsm = true;
            }));
        }
        if (tiffAssets.mask) {
            jobs.push(fetchProjectTiffRasters(tiffAssets.mask).then(({ rasters }) => {
                if (runId !== deferredProjectTiffLoadRun) return;
                layerData.mask = rasters;
                loaded.mask = true;
            }));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach(result => {
            if (result.status === 'rejected') console.warn('[ProjectLoad] Deferred TIFF load failed:', result.reason);
        });
        if (runId !== deferredProjectTiffLoadRun) return;
        if (options.ensureMissingMask && !layerData.mask && typeof fetchAndAttachProjectMask === 'function') {
            loaded.mask = await fetchAndAttachProjectMask(projectId);
        }
        if (loaded.rgb) {
            const nextImageContext = getCurrentImageProjectionContext();
            const reprojected = reprojectActiveGeometryForImageContext(previousImageContext, nextImageContext);
            if (reprojected && typeof window.refreshStructureMode === 'function') {
                window.refreshStructureMode();
            }
        }
        refreshAfterDeferredProjectTiffs(loaded);
    });
}

function clampVisualChannel(v) {
    return Math.max(0, Math.min(255, v));
}

function normalizeVisualAdjustmentState(raw) {
    const out = { ...VISUAL_ADJUSTMENT_DEFAULTS };
    if (raw && typeof raw === 'object') {
        Object.keys(out).forEach(key => {
            const v = Number(raw[key]);
            out[key] = Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0;
        });
    }
    return out;
}

function getVisualAdjustmentState(viewId = currentViewId) {
    const id = viewId || 'solar';
    if (!visualAdjustments[id]) {
        visualAdjustments[id] = { ...VISUAL_ADJUSTMENT_DEFAULTS };
    } else {
        visualAdjustments[id] = normalizeVisualAdjustmentState(visualAdjustments[id]);
    }
    return visualAdjustments[id];
}
window.getVisualAdjustmentState = getVisualAdjustmentState;

function hasNonDefaultVisualAdjustments(state) {
    const s = normalizeVisualAdjustmentState(state);
    return Object.keys(VISUAL_ADJUSTMENT_DEFAULTS).some(key => Math.abs(s[key]) > 0.001);
}

function getVisualAdjustmentSignature(state) {
    const s = normalizeVisualAdjustmentState(state);
    return Object.keys(VISUAL_ADJUSTMENT_DEFAULTS).map(key => `${key}:${s[key]}`).join('|');
}

function invalidateAdjustedViewCanvas(viewId = null) {
    if (!viewId) {
        adjustedViewCanvases = {};
        return;
    }
    if (adjustedViewCanvases && adjustedViewCanvases[viewId]) delete adjustedViewCanvases[viewId];
}

function getAdjustedViewCanvas(viewId) {
    const src = ensureViewCanvas(viewId);
    if (!src) return null;

    const state = getVisualAdjustmentState(viewId);
    if (!hasNonDefaultVisualAdjustments(state)) return src;

    const stamp = (typeof getCanvasStamp === 'function')
        ? getCanvasStamp(src)
        : (src.__stamp || (src.__stamp = Date.now()));
    const signature = getVisualAdjustmentSignature(state);
    const cached = adjustedViewCanvases[viewId];
    if (cached && cached.stamp === stamp && cached.signature === signature) return cached.canvas;

    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, out.width, out.height);

    const imageData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imageData.data;
    const exposureScale = Math.pow(2, state.exposure / 100);
    const contrastInput = state.contrast * 2.55;
    const contrastFactor = (259 * (contrastInput + 255)) / (255 * (259 - contrastInput));
    const saturationFactor = Math.max(0, 1 + (state.saturation / 100));

    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;

        let r = d[i] * exposureScale;
        let g = d[i + 1] * exposureScale;
        let b = d[i + 2] * exposureScale;

        const lum01 = Math.max(0, Math.min(1, ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255));
        const shadowWeight = Math.pow(1 - lum01, 2);
        const highlightWeight = Math.pow(lum01, 2);
        const tonalDelta = (state.shadows * 1.15 * shadowWeight) + (state.highlights * 1.15 * highlightWeight);
        r += tonalDelta;
        g += tonalDelta;
        b += tonalDelta;

        r = (r - 128) * contrastFactor + 128;
        g = (g - 128) * contrastFactor + 128;
        b = (b - 128) * contrastFactor + 128;

        const gray = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
        r = gray + (r - gray) * saturationFactor;
        g = gray + (g - gray) * saturationFactor;
        b = gray + (b - gray) * saturationFactor;

        d[i] = clampVisualChannel(r);
        d[i + 1] = clampVisualChannel(g);
        d[i + 2] = clampVisualChannel(b);
    }

    ctx.putImageData(imageData, 0, 0);

    if (Math.abs(state.sharpness || 0) > 0.001) {
        const sharpened = ctx.getImageData(0, 0, out.width, out.height);
        const srcData = new Uint8ClampedArray(sharpened.data);
        const dst = sharpened.data;
        const w = out.width;
        const h = out.height;
        const amount = Math.max(-100, Math.min(100, state.sharpness)) / 100;

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = (y * w + x) * 4;
                if (srcData[idx + 3] === 0) continue;
                const left = idx - 4;
                const right = idx + 4;
                const up = idx - (w * 4);
                const down = idx + (w * 4);

                for (let channel = 0; channel < 3; channel++) {
                    const center = srcData[idx + channel];
                    if (amount > 0) {
                        dst[idx + channel] = clampVisualChannel(
                            center * (1 + (4 * amount))
                            - (srcData[left + channel] + srcData[right + channel] + srcData[up + channel] + srcData[down + channel]) * amount
                        );
                    } else {
                        const soften = -amount;
                        const blur = (center + srcData[left + channel] + srcData[right + channel] + srcData[up + channel] + srcData[down + channel]) / 5;
                        dst[idx + channel] = clampVisualChannel(center * (1 - soften) + blur * soften);
                    }
                }
            }
        }

        ctx.putImageData(sharpened, 0, 0);
    }

    out.__stamp = Date.now();
    adjustedViewCanvases[viewId] = { canvas: out, stamp, signature };
    return out;
}
window.getAdjustedViewCanvas = getAdjustedViewCanvas;

function refreshVisualAdjustmentTargets(viewId = currentViewId) {
    invalidateAdjustedViewCanvas(viewId);
    if (maskedViewCanvases && maskedViewCanvases[viewId]) delete maskedViewCanvases[viewId];
    if (typeof refreshMaskImageData === 'function') refreshMaskImageData();
    if (typeof redrawCanvas === 'function') redrawCanvas();
    if (typeof update3DTextureForView === 'function') update3DTextureForView();
    if (typeof update3DCrop === 'function') update3DCrop();
    if (typeof redrawThumbs === 'function') redrawThumbs();
}

function setVisualAdjustmentValue(key, value, viewId = currentViewId) {
    if (!Object.prototype.hasOwnProperty.call(VISUAL_ADJUSTMENT_DEFAULTS, key)) return;
    const id = viewId || 'solar';
    const state = getVisualAdjustmentState(id);
    const next = Math.max(-100, Math.min(100, Number(value) || 0));
    state[key] = next;
    refreshVisualAdjustmentTargets(id);
}
window.setVisualAdjustmentValue = setVisualAdjustmentValue;

function resetVisualAdjustment(key, viewId = currentViewId) {
    const id = viewId || 'solar';
    const state = getVisualAdjustmentState(id);
    if (key && Object.prototype.hasOwnProperty.call(VISUAL_ADJUSTMENT_DEFAULTS, key)) {
        state[key] = VISUAL_ADJUSTMENT_DEFAULTS[key];
    } else {
        visualAdjustments[id] = { ...VISUAL_ADJUSTMENT_DEFAULTS };
    }
    refreshVisualAdjustmentTargets(id);
}
window.resetVisualAdjustment = resetVisualAdjustment;

window.KB_MAP = {
    // Clipboard
    COPY:          { key: 'c', ctrl: true },
    PASTE:         { key: 'v', ctrl: true },
    SAVE:          { key: 's', ctrl: true },
    SELECT_ALL:    { key: 'a', ctrl: true },
    UNDO:          { key: 'z', ctrl: true },
    REDO:          { key: 'y', ctrl: true },

    // Tools (Single keys)
    ROTATE:        { key: 'r' },
    QUAD:          { key: 'q', optionalAlt: true },
    FLIP:          { key: 't' },
    RESIZE:        { key: 'y' }, // Note: Distinguishes from REDO via 'ctrl: false' implicitly
    MOVE:          { key: 'm' },
    NEW_POINT:     { key: 'n', optionalAlt: true },
    UNDERWALL:     { key: 'u' },
    JERKIN_HEAD:   { key: 'j' },
    
    // Toggles
    GRID:          { key: 'g' },
    IMAGE:         { key: 'i' },
    MEASURE:       { key: 'o' },
    TYPES:         { key: 'p' },
    FACES:         { key: '[' },
    SNAP:          { key: 'f' },
    
    // Geometry Operations
CONNECT:       { key: 'c' }, // Distinguishes from COPY
    PARALLEL:      { key: 'l' },
    FACE_LOCK:     { key: 'l' },
    CREATE_FACE:   { key: 'v' }, // Distinguishes from PASTE
    SUBTRACT_FACE: { key: 'b' },
    FLATTEN:       { key: 'h' },

    // Standard Keys
    DELETE:        { key: 'Delete' },
    BACKSPACE:     { key: 'Backspace' },
    TAB:           { key: 'Tab' },
    ESC:           { key: 'Escape' },

    // Layer Modifiers (Special logic for 1-6 keys)
    LAYER_TOGGLE:  { ctrl: true } // Holding this while pressing 1-6 toggles visibility
};

/**
 * Global Helper: Checks if an event matches a shortcut definition.
 * Usage: matchesKey(e, KB_MAP.COPY)
 */
window.matchesKey = function(e, config) {
    if (!config) return false;

    // 1. Check Key Code (case-insensitive)
    // We check both e.key and config.key existence to handle modifier-only configs (like LAYER_TOGGLE)
    if (config.key && e.key.toLowerCase() !== config.key.toLowerCase()) {
        return false;
    }

    // 2. Check Modifiers (Strict Mode)
    // If config says ctrl:true, Ctrl must be held.
    // If config omits ctrl, Ctrl must NOT be held.
    const reqCtrl  = !!config.ctrl;
    const reqShift = !!config.shift;
    const reqAlt   = !!config.alt;

    const hasCtrl  = e.ctrlKey || e.metaKey; // Mac support
    const hasShift = e.shiftKey;
    const hasAlt   = e.altKey;

    if (config.optionalAlt) {
        return (reqCtrl === hasCtrl && reqShift === hasShift);
    }

    return (reqCtrl === hasCtrl && reqShift === hasShift && reqAlt === hasAlt);
};

/**
 * Dynamically generates the Help Bar HTML based on KB_MAP settings.
 * Automatically formats "Ctrl+C", "Shift+R", etc.
 */
function initDynamicHelpBar() {
    const bar = document.getElementById('help-bar');
    if (!bar) return;

    const k = window.KB_MAP;

    // Helper to format the key string for display (e.g. "Ctrl+C")
    const fmt = (conf) => {
        let parts = [];
        if (conf.ctrl) parts.push('Ctrl');
        if (conf.alt) parts.push('Alt');
        if (conf.shift) parts.push('Shift');
        if (conf.key) parts.push(conf.key.toUpperCase());
        return parts.join('+');
    };

    const makeGroup = (conf, label, title) => `
        <div class="shortcut-group" title="${title || label}">
            <span class="key-badge">${fmt(conf)}</span> ${label}
        </div>`;

    const makeCustomGroup = (keys, label, title) => `
        <div class="shortcut-group" title="${title || label}">
            <span class="key-badge">${keys}</span> ${label}
        </div>`;
    
    const makeSeparator = () => `<div class="separator"></div>`;

    let html = '';

    // General
    html += makeGroup(k.TAB, 'Mode', 'Cycle Selection Mode');
    html += makeGroup(k.SAVE, 'Save', 'Save Project');
    html += makeGroup(k.UNDO, 'Undo', 'Undo Action');
    html += makeGroup(k.REDO, 'Redo', 'Redo Action');
    html += makeGroup(k.COPY, 'Copy', 'Copy Selection');
    html += makeGroup(k.PASTE, 'Paste', 'Paste Selection');
    html += makeGroup(k.SELECT_ALL, 'Select All', 'Select All Visible Geometry');
    html += makeGroup(k.ESC, 'Cancel', 'Cancel Action');

    html += makeSeparator();

    // Toggles
    html += makeGroup(k.IMAGE, 'Images', 'Toggle Image Layer');
    html += makeGroup(k.GRID, 'Grid', 'Toggle Grid');
    html += makeGroup(k.MEASURE, 'Measure', 'Toggle Measurements');
    html += makeGroup(k.FACES, 'Faces', 'Toggle Generated Faces');
    html += makeGroup(k.TYPES, 'Types', 'Toggle Line Types');
    html += makeGroup(k.SNAP, 'Snap', 'Toggle Snapping');

    html += makeSeparator();

    // Manipulation
    html += makeGroup(k.ROTATE, 'Rotate', 'Rotate Selection');
    html += makeGroup(k.RESIZE, 'Resize', 'Resize Selection or Selected 3D Heights');
    html += makeGroup(k.MOVE, 'Move', 'Move Selection');
    html += makeGroup(k.FLIP, 'Flip', 'Flip Selection');
    html += `
        <div class="shortcut-group" title="Nudge selection">
            <span class="key-badge">Arrows</span> Nudge
        </div>`;
    html += makeCustomGroup('Shift+Arrows', 'Spin View', 'Rotate the 2D view');
    html += makeCustomGroup('Ctrl+Arrows', '3D Views', 'Snap 3D camera to preset views');

    // Geometry
    html += makeGroup(k.CREATE_FACE, 'Form Face', 'Create Face from Loop');
    html += makeGroup(k.SUBTRACT_FACE, 'Blow Thru', 'Subtract selected face / blow through faces');
    html += makeGroup(k.CONNECT, 'Connect', 'Connect Points');
    html += makeGroup(k.PARALLEL, 'Parallel', 'Make Lines Parallel');
    html += makeGroup(k.FACE_LOCK, 'Lock Face', 'Toggle selected face plane lock');
    html += makeGroup(k.FLATTEN, 'Flatten', 'Flatten Height (3D)');
    html += makeGroup(k.NEW_POINT, 'New Pt', 'New Connected Point');
    html += makeCustomGroup('Alt+Click', 'Level New Pt', 'Place a new point at the source point height');
    html += makeGroup(k.QUAD, 'Quad', 'Create Quadrilateral');
    html += makeCustomGroup('Alt+Final', 'Level Quad', 'Hold Alt on the final quad click to place new points at the source point height');
    html += makeGroup(k.UNDERWALL, 'Underwall', 'Toggle Underwall Mode');
    html += makeGroup(k.DELETE, 'Delete', 'Delete Selection');

    html += makeSeparator();

    // Layers and stickers
    html += makeCustomGroup('1-6', 'Set Layer', 'Move selection to layer');
    html += makeCustomGroup('Ctrl+1-6', 'Show Layer', 'Toggle layer visibility');
    html += makeCustomGroup('W', 'Merge Pts', 'Merge selected points at their center');
    html += makeCustomGroup('D', 'Dormer', 'Cycle two-face, three-face, and curved dormers');
    html += makeCustomGroup('S', 'Smart Face', 'Start Smart Face placement');
    html += makeGroup(k.JERKIN_HEAD, 'Jerkin', 'Start Jerkin Head placement');
    html += makeCustomGroup('R', 'Rotate Sticker', 'While placing a smart sticker, rotate 90 degrees');
    html += makeCustomGroup('Right Click', 'Sticker Size', 'While placing a smart sticker, cycle size');
    html += makeCustomGroup('Shift+Click', 'Keep Placing', 'Place another sticker after click');

    bar.innerHTML = html;
}



function toggleSplatMode() {
    isSplatMode = !isSplatMode;
    const btn = document.getElementById('btnSplat');
    if (btn) {
        btn.classList.toggle('active', isSplatMode);
        btn.style.background = isSplatMode ? '#e8f0fe' : '#fff';
    }
    // Set cursor for feedback
    document.getElementById('viewport').style.cursor = isSplatMode ? 'copy' : 'default';
}

function initAppMapViewGlobal() {
    geocoder = new google.maps.Geocoder();
    
    // Existing initialization for the hidden input (optional to keep)
    initAutocomplete(); 

    // --- NEW: Initialize the Header Address Bar Autocomplete ---
    initHeaderAutocomplete(); 

    // --- NEW: Initialize Google Maps JS API ---
    const mapEl = document.getElementById('google-js-map');
    if (mapEl) {
        googleJsMap = new google.maps.Map(mapEl, {
            center: { lat: 0, lng: 0 }, 
            zoom: 20,
            mapTypeId: 'satellite',
            mapTypeControl: false,
            streetViewControl: false,
            rotateControl: true,       
            tilt: 45,                  
            heading: 0,
            gestureHandling: 'greedy'  
        });
        window.googleJsMap = googleJsMap;
    }

    initCesium(); 
    console.log("Maps & Cesium Ready");
}

// --- NEW FUNCTION TO HANDLE TOP RIGHT ADDRESS BAR ---
function initHeaderAutocomplete() {
    const input = document.getElementById("manualAddress");
    if (!input) return;
    
    if (input.dataset.lockAddress === "1" || input.readOnly || input.disabled) return;

    const headerAutocomplete = new google.maps.places.Autocomplete(input, {
        types: ['address'], // Restrict results to actual addresses
        fields: ['formatted_address', 'geometry']
    });

    headerAutocomplete.addListener("place_changed", () => {
        const place = headerAutocomplete.getPlace();
        
        // If user hits enter without selecting a prediction, return
        if (!place.geometry) return;

        // 1. Update the input with the official formatted address
        input.value = place.formatted_address;

        // 2. Trigger the analysis logic (defined in index.php)
        // This simulates clicking the "Analyze" button
        if (typeof handleDirectAnalysis === 'function') {
            handleDirectAnalysis();
        }
    });
}

async function initCesium() {
    if (!Cesium) return console.error("Cesium not loaded");

    // Initialize Viewer
    cesiumViewer = new Cesium.Viewer('google-map-container', {
        terrainProvider: undefined, 
        imageryProvider: false,      
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        infoBox: false,
        fullscreenButton: false,
        animation: false,
        timeline: false,
        skyBox: false,
        creditContainer: document.createElement('div')
    });

    // --- FIX START: Disable the "Gray Plane" (Globe Surface) ---
    
    // 1. Hide the base earth sphere completely
    cesiumViewer.scene.globe.show = false; 
    
    // 2. Disable the atmosphere ring (which can look like a rising plane)
    cesiumViewer.scene.skyAtmosphere.show = false;
    
    // 3. Disable fog to prevent distance clipping
    cesiumViewer.scene.fog.enabled = false;

    // 4. Ensure the background is just a solid color (no skybox/stars interfering)
    cesiumViewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#202124');
    
    // --- FIX END ---

    try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(
            'https://tile.googleapis.com/v1/3dtiles/root.json?key=' + GOOGLE_API_KEY
        );
        cesiumViewer.scene.primitives.add(tileset);
    } catch (error) {
        console.error("Error loading Google 3D Tiles:", error);
    }
}

function initAutocomplete() {
    const input = document.getElementById("addressInput");
    autocomplete = new google.maps.places.Autocomplete(input);
    autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        if (!place.geometry) return alert("No details available");
        startAnalysis(place.geometry.location.lat(), place.geometry.location.lng());
    });
}

function handleManualLoad() {
    const address = document.getElementById('addressInput').value;
    geocoder.geocode({ 'address': address }, function(results, status) {
        if (status !== 'OK') return alert("Geocode Failed");
        const loc = results[0].geometry.location;
        startAnalysis(loc.lat(), loc.lng());
    });
}

function resetLayerVisibility() {
    // 1. Reset internal state
    for (let i = 1; i <= 6; i++) {
        layerVisibility[i] = true;
    }
    // 2. Re-run the control setup to refresh button colors/styles
    if (typeof setupLayerControls === 'function') {
        setupLayerControls();
    }
}

function toggleCenterpoints() {
    showCenterpoints = !showCenterpoints;
    
    const btn = document.getElementById('btnToggleCenters');
    if(btn) {
        if(showCenterpoints) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8';
            btn.style.borderColor = '#1a73e8';
        } else {
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
        }
    }
    
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
}

function injectCenterpointButton() {
    const snapBtn = document.getElementById('btnToggleSnap');
    if (!snapBtn) return;

    // Avoid duplicates
    if (document.getElementById('btnToggleCenters')) return;

    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.id = 'btnToggleCenters';
    btn.title = 'Toggle Line Centerpoints';
    // Icon representing a line with a center dot
    btn.innerHTML = '<i class="fas fa-arrows-alt-h" style="font-size: 10px;"></i><i class="fas fa-circle" style="font-size: 6px; margin-left: -8px; margin-top: -5px; color: inherit;"></i>';
    btn.style.marginLeft = "5px";
    btn.onclick = () => toggleCenterpoints();

    // Insert after Snap button
    snapBtn.parentNode.insertBefore(btn, snapBtn.nextSibling);

    // Initialize style
    toggleCenterpoints(); 
    toggleCenterpoints(); 
}


// --- UPDATE startAnalysis ---
async function startAnalysis(lat, lng) {
    resetLayerVisibility(); // <--- ADD THIS LINE
    
    if (typeof exitMeasurementMode === 'function') {
        exitMeasurementMode();
    }
    if (typeof updateProjectTypeBadge === 'function') {
        updateProjectTypeBadge(null);
    }
    if (typeof updateStructureCountBadge === 'function') {
        updateStructureCountBadge(null);
    }
    
    quadViewCroppedImage = null;

    document.getElementById('zoom-layer').innerHTML = '<div style="padding:50px; text-align:center;">Loading Data...</div>';
    activeGeometry = null;
    hasGeoImage = false;
    cachedGeoImage = null;
    history2D = [];
    redo2D = [];

    document.getElementById('btnGeo').textContent = "Generate Geometry";
    document.getElementById('btnReprocess').disabled = true;
    document.getElementById('btnReprocess').style.background = '#5f6368';
    document.getElementById('btnReprocess').style.cursor = 'not-allowed';

    try {
        // 1. Fetch Insights FIRST
        const preciseLoc = await fetchInsights(lat, lng);
        
        // 2. Update Global Map Center
        mapCenterLat = preciseLoc.latitude;
        mapCenterLng = preciseLoc.longitude;

        console.log(`Address: ${lat},${lng} -> Precise Roof: ${mapCenterLat},${mapCenterLng}`);

        if (googleJsMap) {
            googleJsMap.setCenter({ lat: mapCenterLat, lng: mapCenterLng });
            googleJsMap.setZoom(20);
            googleJsMap.setTilt(45);
            googleJsMap.setHeading(0);
        }

        // 3. Move Cesium Camera
        if (cesiumViewer) {
            // ... [Existing Cesium camera logic] ...
            const center = Cesium.Cartesian3.fromDegrees(mapCenterLng, mapCenterLat, 0);
            const offset = new Cesium.HeadingPitchRange(
                Cesium.Math.toRadians(0), 
                Cesium.Math.toRadians(-45), 
                100 
            );
            cesiumViewer.camera.lookAt(center, offset);
            cesiumViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        }

        // 4. Fetch Layers using PRECISE location (Ensures perfect alignment)
        await fetchAllLayers(mapCenterLat, mapCenterLng);
        await fetchStaticMap(mapCenterLat, mapCenterLng);
        
        setupView();
        init3D(); 
        rebuildViewConfigs();
        buildThumbGrid();
        redrawThumbs();

        if (autoRunGemini) {
            handleGenerateMeasurements();
            prefetchAppleLayerInBackground();
        } else {
            console.log("AI Preprocessing skipped. User building from scratch.");
            // Optional: Alert the user or update the UI
            document.getElementById('zoom-layer').innerHTML = ''; // Clear loading message
            redrawCanvas(); // Show the satellite image so they can draw
            prefetchAppleLayerInBackground();
            // Helpful UI Hint:
            const modeLabel = document.getElementById('modeLabel');
            if(modeLabel) modeLabel.textContent = "BUILD FROM SCRATCH: DOUBLE CLICK TO START";
            setTimeout(() => { if(modeLabel) modeLabel.textContent = "POINT MODE"; }, 5000);
        }
        
    } catch (e) {
        console.error(e);
        alert(e.message);
    }
}


async function fetchInsights(lat, lng) {
    const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.solarPotential) throw new Error("No solar data found.");
    
    segmentStats = data.solarPotential.roofSegmentStats;
    renderTable();

    // Return the precise center of the roof if available
    if (data.center) {
        return data.center;
    } else if (data.solarPotential.center) {
        // Sometimes nested depending on API version, but usually top level or in potential
        return data.solarPotential.center; // Fallback structure check
    } else {
        // Fallback to original if no center found
        return { latitude: lat, longitude: lng };
    }
}

/* main.js (DROP-IN REPLACEMENT) */
async function fetchAllLayers(lat, lng) {
  const rad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20)));
  const pixelSize = window.getSolarPixelSizeMeters ? window.getSolarPixelSizeMeters(rad) : 0.1;

  const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radius_meters=${rad}&view=FULL_LAYERS&requiredQuality=LOW&pixelSizeMeters=${pixelSize}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const fetchTiff = async (tiffUrl, layerName) => {
    const r = await fetch(tiffUrl + `&key=${GOOGLE_API_KEY}`);
    const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
    const img = await tiff.getImage();

    // ✅ Solar TIFF defines the authoritative canvas size
    imageWidth = img.getWidth();
    imageHeight = img.getHeight();
    if (layerName === 'rgb' && window.setImageMetersPerPx) {
      window.setImageMetersPerPx(resolveTiffMetersPerPx(img, lat) || pixelSize);
    }

    return await img.readRasters();
  };

  const promises = [];
  if (data.rgbUrl)  promises.push(fetchTiff(data.rgbUrl, 'rgb').then(r => layerData.rgb = r));
  if (data.dsmUrl)  promises.push(fetchTiff(data.dsmUrl, 'dsm').then(r => layerData.dsm = r));
  if (data.maskUrl) promises.push(fetchTiff(data.maskUrl, 'mask').then(r => layerData.mask = r));
  await Promise.all(promises);

  // Roof mask (Solar maskUrl)
  if (layerData.mask && layerData.mask[0]) {
    roofMaskData = layerData.mask[0];
  } else {
    roofMaskData = null;
  }

  // ✅ Persist radius into layer_config so load/save stays correct
  if (window.setRadiusMeters) window.setRadiusMeters(rad);
  else window.RADIUS_METERS = rad;

  // ✅ Clear all cached canvases (size changed)
  viewCanvases = {};
  adjustedViewCanvases = {};
  maskedViewCanvases = {};

  // ✅ If you’ve already fetched Google/Azure/Apple before, keep them,
  // but their *draw scale* must now match Solar meters/px.
  if (typeof rescaleAllProviderLayersToSolar === 'function') {
    rescaleAllProviderLayersToSolar();
  }

  // ✅ Rebuild provider canvases (if their raw images exist)
  if (typeof rebuildBaseViewCanvas === 'function') {
    if (layerData.google) rebuildBaseViewCanvas('google');
    if (layerData.azure)  rebuildBaseViewCanvas('azure');
    if (layerData.apple)  rebuildBaseViewCanvas('apple');
  }

  redrawCanvas();
}

async function fetchAllLayersWithRadius(lat, lng, radius) {
  const rad = window.setRadiusMeters ? window.setRadiusMeters(radius) : Number(radius || 20);
  const pixelSize = window.getSolarPixelSizeMeters ? window.getSolarPixelSizeMeters(rad) : 0.1;
  const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radius_meters=${rad}&view=FULL_LAYERS&requiredQuality=LOW&pixelSizeMeters=${pixelSize}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  const fetchTiff = async (tiffUrl, layerName) => {
    const r = await fetch(tiffUrl + `&key=${GOOGLE_API_KEY}`);
    const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
    const img = await tiff.getImage();
    imageWidth = img.getWidth();
    imageHeight = img.getHeight();
    if (layerName === 'rgb' && window.setImageMetersPerPx) {
      window.setImageMetersPerPx(resolveTiffMetersPerPx(img, lat) || pixelSize);
    }
    return await img.readRasters();
  };

  const promises = [];
  if (data.rgbUrl)  promises.push(fetchTiff(data.rgbUrl, 'rgb').then(r => layerData.rgb = r));
  if (data.dsmUrl)  promises.push(fetchTiff(data.dsmUrl, 'dsm').then(r => layerData.dsm = r));
  if (data.maskUrl) promises.push(fetchTiff(data.maskUrl, 'mask').then(r => layerData.mask = r));
  await Promise.all(promises);

  roofMaskData = layerData.mask && layerData.mask[0] ? layerData.mask[0] : null;
  viewCanvases = {};
  adjustedViewCanvases = {};
  maskedViewCanvases = {};
}



async function fetchStaticMap(lat, lng) {
    const gUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=600x600&maptype=satellite&key=${GOOGLE_API_KEY}`;
    return new Promise(r => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            layerData.google = img;
            ensureLayerCfg('google').__zoom = 20;
            setLayerScaleToMatchSolar('google', 20, img.width, imageWidth);
            applyStaticRoundingCorrectionToLayer('google', lat, lng, 20, 1);
            delete viewCanvases.google;
            rebuildBaseViewCanvas('google');
            r();
        };
    img.src = gUrl;
    });
}

function rebuildViewConfigs() {
    viewConfigs = [...BASE_VIEWS];
    for (let i = 1; i <= aiViewCount; i++) {
        viewConfigs.push({ id: 'crop' + i, label: 'AI Roof ' + i });
    }
    if (hasGeoImage) {
        viewConfigs.push({ id: 'ai_geo', label: 'AI Geometry Map' });
    }
}

function handleSaveRaw() {
    if (!lastRawGeminiOutput) return alert("No raw output available.");
    
    const link = document.createElement('a');
    link.download = `gemini_raw_output_${Date.now()}.png`;
    link.href = 'data:image/png;base64,' + lastRawGeminiOutput;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function handleGenerateGeometry() {
    const btn = document.getElementById('btnGeo');
    if (btn.disabled) return;

    const solarCanvas = ensureViewCanvas('solar');
    if (!solarCanvas) return;

    btn.disabled = true;
    btn.textContent = "Processing Geometry...";

    try {
        const dataUrl = solarCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        
        const geoB64 = await callGemini(base64, GEOMETRY_PROMPT);
        if (!geoB64) throw new Error("AI returned no image.");

        // --- NEW CODE START ---
        // Store the raw string immediately
        lastRawGeminiOutput = geoB64;
        
        // Enable and show the Save Raw button
        const btnSave = document.getElementById('btnSaveRaw');
        if (btnSave) {
            btnSave.disabled = false;
            btnSave.style.display = 'inline-block';
        }
        // --- NEW CODE END ---

        paintB64ToCropCanvas('ai_geo', geoB64);
        hasGeoImage = true;
        rebuildViewConfigs();
        buildThumbGrid();
        redrawThumbs();

        const img = new Image();
        img.onload = () => {
            cachedGeoImage = img;
            const reBtn = document.getElementById('btnReprocess');
            if(reBtn) {
                reBtn.disabled = false;
                reBtn.style.background = '#5f6368';
                reBtn.style.cursor = 'pointer';
            }

            runGeometryAnalysis(img);
            btn.disabled = false;
            btn.textContent = "Retry Geometry";
        };
        img.src = 'data:image/png;base64,' + geoB64;
    } catch (e) {
        console.error(e);
        alert("Geometry generation failed: " + e.message);
        btn.disabled = false;
        btn.textContent = "Retry Geometry";
    }
}


function handleReprocessGeometry() {
    if (!cachedGeoImage) return;
    console.log("Reprocessing geometry with new parameters...");
    runGeometryAnalysis(cachedGeoImage);
}

function runGeometryAnalysis(img) {
    const params = {
        blue: parseInt(document.getElementById('paramBlue').value),
        red: parseInt(document.getElementById('paramRed').value),
        erode: parseInt(document.getElementById('paramErode').value)
    };

    activeGeometry = processGeometryImage(img, imageWidth, imageHeight, params);
    save2DState(); 

    if (layerData.dsm) {
        optimizeElevationFromGeomery(activeGeometry, layerData.dsm[0], imageWidth, imageHeight);
    }

    redrawCanvas();
    renderGeometry3D();
    if (typeof window.queueFit3DViewToActiveGeometry === 'function') {
        window.queueFit3DViewToActiveGeometry();
        setTimeout(() => window.queueFit3DViewToActiveGeometry(), 120);
    }

    if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();

    console.log("Geometry Updated");
}


function calculateFlippedPoint(p, center, angle, mode) {
    // mode: 0 = Original, 1 = Vertical (Screen Y), 2 = Horizontal (Screen X)
    if (mode === 0) return { x: p.x, y: p.y };

    // 1. Translate point to local space relative to center
    const dx = p.x - center.x;
    const dy = p.y - center.y;

    // 2. Rotate to align with Screen Axes
    // FIX: screenToImage uses -angle, so World->Screen must use +angle
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    
    // Standard Rotation Formula (World -> Screen Alignment)
    let rx = dx * c - dy * s;
    let ry = dx * s + dy * c;

    // 3. Apply Flip in Screen Space
    if (mode === 1) {
        // Vertical Flip (Screen Y axis mirror)
        // Visually flips up/down relative to user's current view
        ry = -ry;
    } else if (mode === 2) {
        // Horizontal Flip (Screen X axis mirror)
        // Visually flips left/right relative to user's current view
        rx = -rx;
    }

    // 4. Rotate back to World Space
    // We rotate by -angle to undo the screen alignment
    const cInv = Math.cos(-angle);
    const sInv = Math.sin(-angle);
    
    const finalX = rx * cInv - ry * sInv;
    const finalY = rx * sInv + ry * cInv;

    // 5. Translate back to world position
    return {
        x: finalX + center.x,
        y: finalY + center.y
    };
}


function handleFlipSelection() {
    // 1. Identify items to flip
    const itemsToFlip = new Set();
    if (selectionMode === 'POINT') {
        selectedPoints.forEach(p => itemsToFlip.add(p));
        selectedVents.forEach(v => itemsToFlip.add(v));
    } else {
        selectedLines.forEach(l => { itemsToFlip.add(l.start); itemsToFlip.add(l.end); });
        selectedVents.forEach(v => itemsToFlip.add(v));
    }

    if (itemsToFlip.size === 0) return;

    // 2. Generate Signature
    const currentSignature = Array.from(itemsToFlip).map(p => {
        const idx = activeGeometry.points.indexOf(p);
        return idx > -1 ? 'p' + idx : 'v' + (activeGeometry.vents ? activeGeometry.vents.indexOf(p) : -1);
    }).sort().join(',');

    // 3. Determine Source of Truth based on State
    // If Moving/Rotating, we operate on the *originals* stored in the tool state,
    // not the live geometry (which is being overwritten by mouse events).
    let sourceMap = null;
    let isActiveTool = false;

    if (interactState === 'MOVING') {
        sourceMap = moveOriginals;
        isActiveTool = true;
    } else if (interactState === 'ROTATING') {
        sourceMap = rotationState.originals;
        isActiveTool = true;
    }

    // --- FIX START ---
    // Check if the cache is actually valid for the current objects.
    // (Fixes bug where Undo/Paste reuses indices but creates new objects)
    let isCacheValid = false;
    if (flipState.originals.size > 0 && itemsToFlip.size > 0) {
        const firstItem = itemsToFlip.values().next().value;
        if (flipState.originals.has(firstItem)) {
            isCacheValid = true;
        }
    }

    // 4. Initialize Flip State if new selection OR if cache is stale
    if (flipState.signature !== currentSignature || !isCacheValid) {
        if (!isActiveTool) save2DState(); // Only save undo if not already in a transaction

        flipState.originals = new Map();
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        itemsToFlip.forEach(p => {
            // If active tool, grab from tool's memory. If idle, grab from geometry.
            const ref = isActiveTool ? sourceMap.get(p) : { x: p.x, y: p.y };
            
            if (ref) {
                flipState.originals.set(p, { x: ref.x, y: ref.y });
                if (ref.x < minX) minX = ref.x;
                if (ref.x > maxX) maxX = ref.x;
                if (ref.y < minY) minY = ref.y;
                if (ref.y > maxY) maxY = ref.y;
            }
        });

        // Calculate center of the *original* selection
        flipState.center = {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2
        };
        flipState.signature = currentSignature;
        flipState.mode = 1; // Start with Vertical
    } else {
        // Cycle: 1 (Vert) -> 2 (Horiz) -> 0 (Original) -> 1...
        flipState.mode = (flipState.mode + 1) % 3;
    }
    // --- FIX END ---

    // 5. Apply Flip Logic
    const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;

    itemsToFlip.forEach(p => {
        const orig = flipState.originals.get(p);
        if (!orig) return;

        // Calculate where this point should be relative to the flip center
        const newPos = calculateFlippedPoint(orig, flipState.center, rot, flipState.mode);

        if (isActiveTool) {
            // Update the tool's reference map (The "Anchor" moves)
            const toolRef = sourceMap.get(p);
            if (toolRef) {
                toolRef.x = newPos.x;
                toolRef.y = newPos.y;
            }
        } else {
            // Update geometry directly
            p.x = newPos.x;
            p.y = newPos.y;
        }
    });

    // 6. Force Live Update of Tool State
    // We need to re-apply the current mouse offset to the *new* anchor positions
    if (interactState === 'MOVING') {
        // Recalculate the move delta based on current mouse position
        const coords = screenToImage(lastMouseX, lastMouseY);
        if (window.moveAnchor) {
            const deltaX = coords.x - window.moveAnchor.mouseX;
            const deltaY = coords.y - window.moveAnchor.mouseY;
            
            // Apply delta to the newly flipped originals
            itemsToFlip.forEach(p => {
                const base = moveOriginals.get(p);
                if (base) {
                    p.x = base.x + deltaX;
                    p.y = base.y + deltaY;
                }
            });
        }
    } 
    else if (interactState === 'ROTATING') {
        // Re-run rotation logic which reads from rotationState.originals
        handleRotationMove(); 
    }

    renderGeometry2D();
    renderGeometry3D();
    checkAndTriggerMeasurementUpdate();
    triggerLiveUpdate();
}





async function callGemini(base64Image, promptText) {
    if (typeof window.firstMeasureFetchJson !== 'function') throw new Error('FirstMeasure API helper is unavailable.');
    const data = await window.firstMeasureFetchJson('/ai/gemini-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: geminiModel, prompt: promptText, image_base64: base64Image })
    });
    return data && data.image_base64 ? data.image_base64 : null;
}


function ensureViewCanvas(viewId) {
  if (viewCanvases[viewId]) return viewCanvases[viewId];
  if (!imageWidth || !imageHeight) return null;

  // 1. Solar API RGB (Reference)
  if (viewId === 'solar' && layerData.rgb) {
    const c = document.createElement('canvas');
    c.width = imageWidth; c.height = imageHeight;
    const ctx = c.getContext('2d');
    ctx.putImageData(getRenderedImageData(ctx, 'rgb'), 0, 0);
    viewCanvases.solar = c;
    return c;
  }

  // 2. Google Maps Static
  if (viewId === 'google' && layerData.google) {
    const c = document.createElement('canvas');
    c.width = imageWidth; c.height = imageHeight;
    const ctx = c.getContext('2d');

    const cfg = normalizeProviderLayerScaleBeforeDraw('google', layerData.google.width || imageWidth, imageWidth) || ensureLayerCfg('google');
    drawScaledImage(
      ctx,
      layerData.google,
      imageWidth,
      imageHeight,
      cfg.scale,
      cfg.x,
      cfg.y,
      cfg.rot || 0,
      cfg.fineScale || 1.0
    );

    viewCanvases.google = c;
    return c;
  }

  // 3. Azure Maps Static (FIXED: add rot + fineScale)
  if (viewId === 'azure' && layerData.azure) {
    const c = document.createElement('canvas');
    c.width = imageWidth; c.height = imageHeight;
    const ctx = c.getContext('2d');

    const cfg = normalizeProviderLayerScaleBeforeDraw('azure', layerData.azure.width || imageWidth, imageWidth) || ensureLayerCfg('azure');
    drawScaledImage(
      ctx,
      layerData.azure,
      imageWidth,
      imageHeight,
      cfg.scale,
      cfg.x,
      cfg.y,
      cfg.rot || 0,
      cfg.fineScale || 1.0
    );

    viewCanvases.azure = c;
    return c;
  }

  // 4. Apple Maps Static (FIXED: add rot + fineScale)
  if (viewId === 'apple' && layerData.apple) {
    const c = document.createElement('canvas');
    c.width = imageWidth; c.height = imageHeight;
    const ctx = c.getContext('2d');

    const cfg = normalizeProviderLayerScaleBeforeDraw('apple', layerData.apple.width || imageWidth, imageWidth) || ensureLayerCfg('apple');
    drawScaledImage(
      ctx,
      layerData.apple,
      imageWidth,
      imageHeight,
      cfg.scale,
      cfg.x,
      cfg.y,
      cfg.rot || 0,
      cfg.fineScale || 1.0
    );

    viewCanvases.apple = c;
    return c;
  }

  // 5. Height Map (DSM) (never adjustable)
  if (viewId === 'height' && layerData.dsm) {
    const c = document.createElement('canvas');
    c.width = imageWidth; c.height = imageHeight;
    const ctx = c.getContext('2d');
    ctx.putImageData(getRenderedImageData(ctx, 'dsm'), 0, 0);
    viewCanvases.height = c;
    return c;
  }

  // 6. AI Crops or Geometry (already baked canvases)
  if (viewId.startsWith('crop') || viewId === 'ai_geo') {
    return viewCanvases[viewId] || null;
  }

  return null;
}

function isCanvasVisiblyBlankOrDark(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return true;
  const sampleW = Math.min(80, canvas.width);
  const sampleH = Math.min(80, canvas.height);
  const tmp = document.createElement('canvas');
  tmp.width = sampleW;
  tmp.height = sampleH;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0, sampleW, sampleH);

  let data;
  try {
    data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  } catch (e) {
    return false;
  }

  let opaque = 0;
  let bright = 0;
  let varied = 0;
  let minLum = 255;
  let maxLum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 8) continue;
    opaque++;
    const lum = (data[i] * 0.2126) + (data[i + 1] * 0.7152) + (data[i + 2] * 0.0722);
    if (lum > 12) bright++;
    if (lum > 30) varied++;
    minLum = Math.min(minLum, lum);
    maxLum = Math.max(maxLum, lum);
  }

  if (opaque < (sampleW * sampleH * 0.05)) return true;
  if (bright < (opaque * 0.03)) return true;
  return varied < (opaque * 0.02) && (maxLum - minLum) < 18;
}
window.isCanvasVisiblyBlankOrDark = isCanvasVisiblyBlankOrDark;

function ensureProviderCanvasIsUsable(viewId) {
  const cvs = ensureViewCanvas(viewId);
  if (!cvs) return null;
  if ((viewId === 'apple' || viewId === 'google' || viewId === 'azure') && isCanvasVisiblyBlankOrDark(cvs)) {
    console.warn(`[${viewId}] Cached image is blank/dark; clearing it so it can be fetched again.`);
    delete viewCanvases[viewId];
    delete layerData[viewId];
    return null;
  }
  return cvs;
}
window.ensureProviderCanvasIsUsable = ensureProviderCanvasIsUsable;


function getDefaultProviderZoom(layerId) {
  if (layerId === 'google') return 21;
  if (layerId === 'azure') return 20;
  if (layerId === 'apple') return 19;
  return null;
}

function normalizeProviderLayerScaleBeforeDraw(layerId, sourceW = null, targetW = null) {
  if (!layerId || layerId === 'solar' || layerId === 'height') return null;
  if (!(layerId === 'google' || layerId === 'azure' || layerId === 'apple')) return ensureLayerCfg(layerId);

  const cfg = ensureLayerCfg(layerId);
  let zoom = Number(cfg.__zoom);
  if (!Number.isFinite(zoom)) {
    if (layerId === 'google' && Math.abs((Number(cfg.fineScale) || 1) - 0.5) < 0.0001) cfg.fineScale = 1.0;
    if (layerId === 'azure' && Math.abs((Number(cfg.fineScale) || 1) - 0.33) < 0.01) cfg.fineScale = 1.0;
    zoom = getDefaultProviderZoom(layerId);
    if (Number.isFinite(zoom)) cfg.__zoom = zoom;
  }

  if (Number.isFinite(zoom) && typeof setLayerScaleToMatchSolar === 'function') {
    setLayerScaleToMatchSolar(layerId, zoom, sourceW, targetW);
  }
  return cfg;
}
window.normalizeProviderLayerScaleBeforeDraw = normalizeProviderLayerScaleBeforeDraw;









function getRenderedImageData(ctx, layerType) {
    const imgData = ctx.createImageData(imageWidth, imageHeight);
    const rasters = layerData[layerType];
    const total = imageWidth * imageHeight;

    if (layerType === 'rgb') {
        for (let i = 0; i < total; i++) {
            imgData.data[i*4]   = rasters[0][i];
            imgData.data[i*4+1] = rasters[1][i];
            imgData.data[i*4+2] = rasters[2][i];
            imgData.data[i*4+3] = 255;
        }
    } else {
        const d = rasters[0];
        let min=Infinity, max=-Infinity;
        for(let i=0; i<total; i++) if(d[i]>-9000) { min=Math.min(min,d[i]); max=Math.max(max,d[i]); }
        const range = max-min||1;
        for (let i = 0; i < total; i++) {
            const val = ((d[i]-min)/range)*255;
            imgData.data[i*4]   = val;
            imgData.data[i*4+1] = val;
            imgData.data[i*4+2] = val;
            imgData.data[i*4+3] = d[i]<-9000 ? 0 : 255;
        }
    }
    return imgData;
}

function paintB64ToCropCanvas(idOrIndex, b64) {
    const id = (typeof idOrIndex === 'number') ? ('crop' + idOrIndex) : idOrIndex;
    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas');
        c.width = imageWidth;
        c.height = imageHeight;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        viewCanvases[id] = c;
        redrawThumbs();

        if (currentViewId === id) {
            refreshMaskImageData();
            redrawCanvas();
            update3DTextureForView();
            update3DCrop();
        }
    };
    img.src = 'data:image/png;base64,' + b64;
}

function buildThumbGrid() {
    const grid = document.getElementById('thumbGrid');
    if (!grid) return;
    grid.innerHTML = '';
    viewConfigs.forEach(cfg => {
        const item = document.createElement('div');
        item.className = 'thumb-item' + (cfg.id === currentViewId ? ' active' : '');
        item.dataset.viewId = cfg.id;

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 160;
        thumbCanvas.height = 160;
        thumbCanvas.className = 'thumb-preview';
        item.appendChild(thumbCanvas);
        thumbCanvases[cfg.id] = thumbCanvas;
        
        const label = document.createElement('div');
        label.className = 'thumb-label';
        label.textContent = cfg.label;
        item.appendChild(label);
        
        item.addEventListener('click', () => selectView(cfg.id));
        grid.appendChild(item);
    });
}

function redrawThumbs() {
    viewConfigs.forEach(cfg => {
        const tCanvas = thumbCanvases[cfg.id];
        if (!tCanvas) return;
        const tctx = tCanvas.getContext('2d');
        tctx.clearRect(0,0,tCanvas.width,tCanvas.height);

        const src = (typeof getAdjustedViewCanvas === 'function')
            ? getAdjustedViewCanvas(cfg.id)
            : ensureViewCanvas(cfg.id);
        if (src) {
            tctx.drawImage(src, 0, 0, tCanvas.width, tCanvas.height);
        } else {
            tctx.fillStyle = '#e0e0e0';
            tctx.fillRect(0,0,tCanvas.width,tCanvas.height);
            tctx.fillStyle = '#777';
            tctx.font = '11px Segoe UI';
            tctx.textAlign = 'center';
            tctx.textBaseline = 'middle';
            tctx.fillText('Loading…', tCanvas.width/2, tCanvas.height/2);
        }
    });
}


async function getAppleAccessKey(opts = {}) {
  const forceRefresh = !!opts.forceRefresh;

  const persistTileVersion = (rawVersion) => {
    const parsed = Number(rawVersion);
    if (!Number.isInteger(parsed) || parsed <= 0) return;
    localStorage.setItem('apple_maps_tile_version', String(parsed));
    window.APPLE_MAPS_TILE_VERSION = parsed;
    if (typeof window.setAppleMapsTileVersion === 'function') {
      window.setAppleMapsTileVersion(parsed);
    }
  };

  persistTileVersion(localStorage.getItem('apple_maps_tile_version'));

  // prevent dogpiling if multiple callers ask at once
  if (window.__appleKeyFetchPromise && !forceRefresh) {
    try { return await window.__appleKeyFetchPromise; } catch(e) {}
  }

  const run = (async () => {
    // 1) If not forcing refresh, allow fast local return ONLY if we already have one
    //    (we still prefer server, but this avoids being totally blocked if server hiccups)
    const localKeyRaw = localStorage.getItem('apple_maps_key');
    const localKey = (localKeyRaw || '').trim();
    const localTs = (localStorage.getItem('apple_maps_key_updated_at_utc') || '').trim();

    const persistServerKey = (serverKey, serverTs) => {
      if (!serverKey) return null;
      if (serverKey !== localKey) localStorage.setItem('apple_maps_key', serverKey);
      if (serverTs && serverTs !== localTs) localStorage.setItem('apple_maps_key_updated_at_utc', serverTs);
      return serverKey;
    };

    // 2) Always try the FirstMeasure API first (or on forceRefresh)
    try {
      const data = (typeof window.firstMeasureFetchJson === 'function')
        ? await window.firstMeasureFetchJson('/apple-key', { method: 'GET' })
        : null;
      const value = data && typeof data === 'object' ? (data.value || {}) : {};
      const serverKey = value && value.key ? String(value.key).trim() : '';
      const serverTs  = value && value.updated_at_utc ? String(value.updated_at_utc).trim() : '';
      persistTileVersion(value && value.tile_version);

      if (serverKey) {
        return persistServerKey(serverKey, serverTs);
      }
    } catch (e) {
      console.warn('[AppleMaps] API key fetch failed', e);
    }

    // 3) Internal Node fallback for older embedded editor contexts.
    try {
      const firstMeasureBase = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/+$/, '');
      const v1Base = firstMeasureBase.replace(/\/firstmeasure\/?$/, '');
      const endpoint = `${v1Base}/internal/legacy-action`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_apple_key_info' })
      });
      const data = await resp.json().catch(() => null);
      const serverKey = data && data.key ? String(data.key).trim() : '';
      const serverTs = data && data.updated_at_utc ? String(data.updated_at_utc).trim() : '';
      persistTileVersion(data && data.tile_version);
      if (serverKey) {
        return persistServerKey(serverKey, serverTs);
      }
    } catch (e) {
      console.warn('[AppleMaps] Legacy key fetch failed', e);
    }

    // 4) Fallback to local (if present). If this call is a retry after
    //    ACCESS_DENIED, the caller clears localStorage before asking again.
    if (localKey) return localKey;

    // 5) Final fallback: no key is available.
    return null;
  })();

  if (!forceRefresh) window.__appleKeyFetchPromise = run;
  try {
    const out = await run;
    return out;
  } finally {
    if (!forceRefresh) window.__appleKeyFetchPromise = null;
  }
}





async function handleGoogleLayerFetch() {
  const zoomLayer = document.getElementById('zoom-layer');
  const originalContent = zoomLayer.innerHTML;
  zoomLayer.innerHTML = '<div style="padding:50px;text-align:center;color:#1a73e8;">Fetching Google Tiles...</div>';

  try {
    const tileRadius = 3; // 7x7
    const zoomCandidates = [22, 21, 20, 19];
    let result = null;
    let lastErr = null;
    for (const zoom of zoomCandidates) {
      try {
        result = await fetchStitchedGoogleTile(mapCenterLat, mapCenterLng, tileRadius, zoom, GOOGLE_API_KEY);
        result.zoom = zoom;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[GoogleTiles] zoom ${zoom} unavailable; trying lower zoom`, e);
      }
    }
    if (!result) throw lastErr || new Error("No Google tile zoom was available.");
    if (!result || !result.canvas) throw new Error("Stitching returned null.");

    const stitchedCanvas = result.canvas;
    const zoom = result.zoom || 21;

    // Save raw to server (google.png)
    if (window.currentProjectId) {
      const rawBlob = await new Promise(r => stitchedCanvas.toBlob(r, 'image/png'));
      await saveProjectArtifactBlob('google.png', rawBlob);
    }

    // Set config offsets (scale stays 1 unless you intentionally want extra zoom)
    // Compute scale to match Solar meters/px (same pattern as Apple)
    const cfg = ensureLayerCfg('google');
    cfg.x = result.offX;
    cfg.y = result.offY;
    cfg.__zoom = zoom;
    setLayerScaleToMatchSolar('google', zoom, stitchedCanvas.width, imageWidth);

    // Bake into view canvas
    const projectCanvas = document.createElement('canvas');
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext('2d');
    drawScaledImage(ctx, stitchedCanvas, imageWidth, imageHeight,
        cfg.scale, cfg.x, cfg.y, cfg.rot || 0, cfg.fineScale || 1.0);

    // Cache
    const rawImg = new Image();
    rawImg.src = stitchedCanvas.toDataURL('image/png');
    await new Promise(r => rawImg.onload = r);
    layerData.google = rawImg;
    viewCanvases.google = projectCanvas;

    zoomLayer.innerHTML = originalContent;
    setupView();
    selectView('google');
    await window.saveProjectData(true, true);

  } catch (e) {
    console.error("[GoogleTiles] Error:", e);
    zoomLayer.innerHTML = originalContent;
    setupView();
    alert("Failed to fetch Google tile layer. Check console.");
    selectView('solar');
  }
}

async function handleAzureLayerFetch() {
  const zoomLayer = document.getElementById('zoom-layer');
  const originalContent = zoomLayer.innerHTML;
  zoomLayer.innerHTML = '<div style="padding:50px;text-align:center;color:#1a73e8;">Fetching Azure Tiles...</div>';

  try {
    const tileRadius = 3;
    const zoomCandidates = [21, 20, 19, 18];

    // Credentials are injected by editor.php from the ignored provider-key file.
    const AZURE_KEY = AZURE_MAPS_KEY;
    if (!AZURE_KEY) throw new Error("Azure Maps is not configured.");

    let result = null;
    let lastErr = null;
    for (const zoom of zoomCandidates) {
      try {
        result = await fetchStitchedAzureTile(mapCenterLat, mapCenterLng, tileRadius, zoom, AZURE_KEY);
        result.zoom = zoom;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[AzureTiles] zoom ${zoom} unavailable; trying lower zoom`, e);
      }
    }
    if (!result) throw lastErr || new Error("No Azure tile zoom was available.");
    if (!result || !result.canvas) throw new Error("Stitching returned null.");

    const stitchedCanvas = result.canvas;
    const zoom = result.zoom || 20;

    // Save raw to server (azure.png)
    if (window.currentProjectId) {
      const rawBlob = await new Promise(r => stitchedCanvas.toBlob(r, 'image/png'));
      await saveProjectArtifactBlob('azure.png', rawBlob);
    }

    const cfg = ensureLayerCfg('azure');
    cfg.x = result.offX;
    cfg.y = result.offY;
    cfg.__zoom = zoom;
    setLayerScaleToMatchSolar('azure', zoom, stitchedCanvas.width, imageWidth);

    const projectCanvas = document.createElement('canvas');
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext('2d');
    drawScaledImage(ctx, stitchedCanvas, imageWidth, imageHeight,
        cfg.scale, cfg.x, cfg.y, cfg.rot || 0, cfg.fineScale || 1.0);

    const rawImg = new Image();
    rawImg.src = stitchedCanvas.toDataURL('image/png');
    await new Promise(r => rawImg.onload = r);
    layerData.azure = rawImg;
    viewCanvases.azure = projectCanvas;

    zoomLayer.innerHTML = originalContent;
    setupView();
    selectView('azure');
    await window.saveProjectData(true, true);

  } catch (e) {
    console.error("[AzureTiles] Error:", e);
    zoomLayer.innerHTML = originalContent;
    setupView();
    alert("Failed to fetch Azure tile layer: " + (e && e.message ? e.message : "Check console."));
    selectView('solar');
  }
}





function selectView(viewId) {
  if (viewId === 'apple') {
    ensureProviderCanvasIsUsable('apple');
    if (!viewCanvases.apple && !layerData.apple) {
      if (_applePrefetchPromise) {
        // Prefetch is in progress — show spinner and wait for it
        const zoomLayer = document.getElementById('zoom-layer');
        const originalContent = zoomLayer.innerHTML;
        zoomLayer.innerHTML = '<div style="padding:50px; text-align:center; color:#1a73e8;">Loading Apple Maps Tiles...</div>';
        _applePrefetchPromise.then(() => {
          zoomLayer.innerHTML = originalContent;
          setupView();
          if (viewCanvases.apple || layerData.apple) {
            selectView('apple');
          } else {
            // Prefetch failed silently — fall back to full fetch
            handleAppleLayerFetch();
          }
        });
        return;
      }
      handleAppleLayerFetch();
      return;
    }
  }
  if (viewId === 'google') {
    if (!viewCanvases.google && !layerData.google) { handleGoogleLayerFetch(); return; }
  }
  if (viewId === 'azure') {
    if (!viewCanvases.azure && !layerData.azure) { handleAzureLayerFetch(); return; }
  }

  currentViewId = viewId;
  document.querySelectorAll('.thumb-item').forEach(el => el.classList.toggle('active', el.dataset.viewId === viewId));
  refreshMaskImageData();
  redrawCanvas();
  update3DTextureForView();
  update3DCrop();
}



function addAiAttempts() {
    if (!imageWidth || !imageHeight) return;
    const prevCount = aiViewCount;
    aiViewCount += 1;
    rebuildViewConfigs();
    buildThumbGrid();
    redrawThumbs();
    generateGeminiCropsFromSolar(1, prevCount);
}

async function generateGeminiCropsFromSolar(count, offsetIndex) {
    try {
        const solarCanvas = ensureViewCanvas('solar');
        if (!solarCanvas) return;
        const dataUrl = solarCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];

        const tasks = [];
        for (let i = 0; i < count; i++) {
            const promptEl = document.getElementById('geminiPrompt');
            const prompt = promptEl.value || "Remove background";
            tasks.push(callGemini(base64, prompt));
        }
        
        const results = await Promise.all(tasks);
        results.forEach((b64, idx) => {
            if (!b64) return;
            const cropIndex = offsetIndex + idx + 1;
            paintB64ToCropCanvas(cropIndex, b64);
        });
    } catch (err) {
        console.error('Gemini crop error', err);
    }
}

function downloadRawGeometryImage() {
    if (!cachedGeoImage) return alert("No AI geometry image generated yet.");
    const link = document.createElement('a');
    link.download = 'gemini_raw_output.png';
    link.href = cachedGeoImage.src;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function handleDownload() {
    const link = document.createElement('a');
    link.download = 'roof_inspector.png';
    const canvas = document.getElementById('mainCanvas');
    if (canvas) link.href = canvas.toDataURL();
    link.click();
}

// Utility & Event Glue
function createMarkers(container) {
  const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
    (((window.getRadiusMeters ? window.getRadiusMeters() :
      (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imageWidth));

  const mLat = 111132;
  const mLng = 111132 * Math.cos(mapCenterLat * (Math.PI/180));

  segmentStats.forEach((seg, i) => {
    const dLat = (seg.center.latitude - mapCenterLat) * mLat;
    const dLng = (seg.center.longitude - mapCenterLng) * mLng;

    const x = (imageWidth / 2) + (dLng / metersPerPx);
    const y = (imageHeight / 2) - (dLat / metersPerPx);

    const el = document.createElement('div');
    el.className = 'marker';
    el.innerText = i + 1;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    container.appendChild(el);
  });

  toggleTags();
}


function toggleTags() {
    const show = false;
    document.querySelectorAll('.marker').forEach(m => m.style.display = show ? 'flex' : 'none');
}

function renderTable() {
    const tbody = document.getElementById('tableBody');
    if(!tbody) return;
    tbody.innerHTML = '';

    segmentStats.forEach((seg, i) => {
        const rise = Math.round(Math.tan(seg.pitchDegrees*(Math.PI/180))*12);
        const tr = document.createElement('tr');
        tr.innerHTML = 
            `<td><span class="badge-id">${i+1}</span></td>` +
            `<td>${rise}/12</td>` +
            `<td>${seg.pitchDegrees.toFixed(1)}°</td>` +
            `<td>${Math.round(seg.azimuthDegrees)}°</td>`;
        tbody.appendChild(tr);
    });
}

function hexToRgb(hex) {
    const h = hex.replace('#','');
    const bigint = parseInt(h, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
}

function refreshMaskImageData() {
    const cvs = ensureViewCanvas(currentViewId);
    if (!cvs) return;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    maskImageData = ctx.getImageData(0, 0, imageWidth, imageHeight);
}

function onMaskControlsChanged() {
    const colorInput = document.getElementById('maskColor');
    const enabledInput = document.getElementById('maskEnabled');
    const tolInput = document.getElementById('maskTolerance');

    if (colorInput) {
        maskColor = hexToRgb(colorInput.value || '#ffffff');
    }
    if (enabledInput) {
        maskEnabled = enabledInput.checked;
    }
    if (tolInput) {
        maskTolerance = parseInt(tolInput.value) || 0;
    }
    refreshMaskImageData();
    update3DCrop();
}

function toggleRoofMask(forceState = null) {
    roofMaskEnabled = (forceState !== null) ? !!forceState : !roofMaskEnabled;

    const btn = document.getElementById('btnToggleRoofMask');
    if (btn) {
        if (roofMaskEnabled) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8';
            btn.style.borderColor = '#1a73e8';
        } else {
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
        }
    }

    maskedViewCanvases = {}; // invalidate 2D masked cache
    if (typeof redrawCanvas === 'function') redrawCanvas();
    if (typeof update3DCrop === 'function') update3DCrop();
    if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
}

function injectRoofMaskButton() {
    const gridBtn = document.getElementById('btnToggleGrid');
    if (!gridBtn) return;

    // avoid duplicates
    if (document.getElementById('btnToggleRoofMask')) return;

    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.id = 'btnToggleRoofMask';
    btn.title = 'Toggle Roof Mask (Solar API maskUrl)';
    btn.innerHTML = '<i class="fas fa-house"></i>';
    btn.onclick = () => toggleRoofMask();

    // insert right after grid button
    gridBtn.parentNode.insertBefore(btn, gridBtn.nextSibling);

    // initial style
    toggleRoofMask(roofMaskEnabled);
}


function isMaskedPixel(x, y) {
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return true;

    // 1) Solar roof mask: mask OUT anything that is NOT rooftop
    if (roofMaskEnabled && roofMaskData && roofMaskData.length === imageWidth * imageHeight) {
        const v = roofMaskData[y * imageWidth + x];
        // mask rasters can be 0/1 or 0/255; treat >0 as "roof"
        return !(v > 0);
    }

    // 2) Fallback: your old color-based mask (only if enabled)
    if (!maskEnabled || !maskImageData) return false;
    const idx = (y * imageWidth + x) * 4;
    const r = maskImageData.data[idx];
    const g = maskImageData.data[idx + 1];
    const b = maskImageData.data[idx + 2];
    const dr = r - maskColor.r;
    const dg = g - maskColor.g;
    const db = b - maskColor.b;
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    return dist <= maskTolerance;
}


// --- HELP BAR TOGGLE ---
function toggleHelpBar() {
    const bar = document.getElementById('help-bar');
    const btn = document.getElementById('btnToggleHelp');
    
    if (bar.style.display === 'flex') {
        bar.style.display = 'none';
        btn.classList.remove('active');
        btn.style.background = '#fff';
        btn.style.color = '#5f6368';
        btn.style.borderColor = '#ccc';
    } else {
        bar.style.display = 'flex';
        btn.classList.add('active');
        btn.style.background = '#e8f0fe';
        btn.style.color = '#1a73e8';
        btn.style.borderColor = '#1a73e8';
    }
    // Trigger resize to fix layout of Map/3D canvas
    window.dispatchEvent(new Event('resize'));
}

function toggleGridDisplay() {
    showGridLayer = !showGridLayer;
    
    const btn = document.getElementById('btnToggleGrid');
    if(btn) {
        if(showGridLayer) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8';
            btn.style.borderColor = '#1a73e8';
        } else {
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
        }
    }
    // Trigger redraw in 2D interaction
    if (typeof redrawCanvas === 'function') redrawCanvas();
}

function updateCvParamsUI() {
    document.getElementById('valBlue').textContent = document.getElementById('paramBlue').value;
    document.getElementById('valRed').textContent = document.getElementById('paramRed').value;
    document.getElementById('valErode').textContent = document.getElementById('paramErode').value;
}

// Function to trigger the config
function handleConfigureReport() {
    if (typeof openReportConfiguration === 'function') {
        openReportConfiguration();
    } else {
        alert("Report Configurator not loaded.");
    }
}


// Window Load - Initialize UI Listeners
window.addEventListener('load', () => {
    const colorInput = document.getElementById('maskColor');
    const tolInput = document.getElementById('maskTolerance');
    const modelSelect = document.getElementById('geminiModelSelect');
    
    if (colorInput)  colorInput.addEventListener('input', onMaskControlsChanged);
    if (tolInput)    tolInput.addEventListener('input', onMaskControlsChanged);

    if (modelSelect) {
        modelSelect.addEventListener('change', (e) => {
            geminiModel = e.target.value;
            console.log('Gemini model set to', geminiModel);
        });
    }

    rebuildViewConfigs();
    buildThumbGrid();
    redrawThumbs();

    // Resize listener for Cesium
    window.addEventListener('resize', () => {
        if (cesiumViewer) cesiumViewer.resize();
    });

    setupLayerControls();
    injectRoofMaskButton();
    injectCenterpointButton();
    initDynamicHelpBar();
    setupLocationAdjustmentUI();
    if (typeof window.refreshStructureMode === 'function') window.refreshStructureMode();
});



window.addEventListener('load', () => {
    const helpBtn = document.getElementById('btnToggleHelp');
    
    if (helpBtn && helpBtn.parentNode) {
        // 1. Config Report Button
        const configBtn = document.createElement('button');
        configBtn.className = 'toolbar-btn';
        configBtn.innerHTML = '<i class="fas fa-file-alt"></i> Config';
        configBtn.onclick = handleConfigureReport;
        configBtn.title = "Configure Report Data before PDF";

        // 2. Save Button
        const saveBtn = document.createElement('button');
        saveBtn.id = 'global-save-btn'; // <--- ADDED ID HERE
        saveBtn.className = 'toolbar-btn';
        saveBtn.innerHTML = '<i class="fas fa-save"></i>';
        saveBtn.title = "Save Project Data (Ctrl+S)";

        // Animated Click Handler
        saveBtn.onclick = async function() {
            const originalContent = '<i class="fas fa-save"></i>';
            
            // Loading State
            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
            this.style.width = this.offsetWidth + 'px'; 
            this.disabled = true;
            this.style.cursor = 'wait';
            this.style.opacity = '0.8';

            try {
                // Perform Save (Silent Mode)
                const success = await window.saveProjectData(true);

                if (success) {
                    // Success State
                    this.innerHTML = '<i class="fas fa-check"></i>';
                    this.style.borderColor = '#2e7d32';
                    this.style.color = '#2e7d32';
                    this.style.backgroundColor = '#e8f5e9';
                } else {
                    throw new Error("Save failed");
                }
            } catch (e) {
                // Error State
                this.innerHTML = '<i class="fas fa-times"></i>';
                this.style.borderColor = '#c62828';
                this.style.color = '#c62828';
                this.style.backgroundColor = '#ffebee';
            } finally {
                // Revert
                setTimeout(() => {
                    this.innerHTML = originalContent;
                    this.disabled = false;
                    this.style.width = '';
                    this.style.cursor = 'pointer';
                    this.style.opacity = '1';
                    this.style.borderColor = '';
                    this.style.color = '';
                    this.style.backgroundColor = '';
                }, 2000);
            }
        };

        // Insert
        helpBtn.parentNode.insertBefore(configBtn, helpBtn);
        helpBtn.parentNode.insertBefore(saveBtn, helpBtn);
    }
});

window.addEventListener('keydown', (e) => {
    // Check for Ctrl+S or Cmd+S (Mac)
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); // Stop browser from opening "Save Page As"
        
        const btn = document.getElementById('global-save-btn');
        
        // Only trigger if button exists and isn't currently saving (disabled)
        if (btn && !btn.disabled) {
            btn.click(); // Triggers the animation logic defined above
        }
    }
});

function setupLayerControls() {
    const layerContainer = document.getElementById('layer-controls-group');
    if (!layerContainer) return;
    
    layerContainer.innerHTML = '';

    // Create container for layer buttons if not exists to keep them grouped
    let layerGroup = document.getElementById('layer-controls-group');
    if (!layerGroup) {
        layerGroup = document.createElement('div');
        layerGroup.id = 'layer-controls-group';
        layerGroup.style.display = 'flex';
        layerGroup.style.gap = '5px';
        layerGroup.style.marginLeft = '10px';
        layerGroup.style.paddingLeft = '10px';
        layerGroup.style.borderLeft = '1px solid #ccc';
        bar.appendChild(layerGroup);
    }
    layerGroup.innerHTML = ''; // Reset

    Object.keys(LAYER_STYLES).forEach(layerNum => {
        const style = LAYER_STYLES[layerNum];
        const btn = document.createElement('div');
        btn.className = `layer-toggle-btn layer-${layerNum}`;
        btn.innerText = layerNum;
        btn.title = `Toggle Layer ${layerNum}`;
        
        // Base Styles
        btn.style.width = '24px';
        btn.style.height = '24px';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.borderRadius = '4px';
        btn.style.cursor = 'pointer';
        btn.style.fontWeight = 'bold';
        btn.style.fontSize = '12px';
        btn.style.userSelect = 'none';
        btn.style.transition = 'all 0.2s';
        
        // Initial State Render
        updateLayerButtonStyle(btn, layerNum, style.line);

        btn.onclick = () => {
            toggleLayerVisibility(layerNum, btn, style.line);
        };

        layerGroup.appendChild(btn);
    });
}

function updateLayerButtonStyle(btn, layer, color) {
    const isOn = layerVisibility[layer];
    if (isOn) {
        btn.style.backgroundColor = color;
        btn.style.border = `1px solid ${color}`;
        btn.style.color = '#FFFFFF';
    } else {
        btn.style.backgroundColor = '#FFFFFF';
        btn.style.border = `2px solid ${color}`;
        btn.style.color = color;
    }
}

function toggleLayerVisibility(layer, btn, color) {
    const isNowVisible = !layerVisibility[layer];
    layerVisibility[layer] = isNowVisible;
    
    updateLayerButtonStyle(btn, layer, color);
    
    // NEW: Deselect items if layer is turned OFF
    if (!isNowVisible) {
        let selectionChanged = false;

        // 1. Deselect Points
        const pointsToRemove = [];
        selectedPoints.forEach(pt => {
            if ((pt.layer || 1) == layer) pointsToRemove.push(pt);
        });
        pointsToRemove.forEach(p => selectedPoints.delete(p));
        if(pointsToRemove.length > 0) selectionChanged = true;

        // 2. Deselect Lines
        const linesToRemove = [];
        selectedLines.forEach(conn => {
            // Lines belong to a layer typically defined by their start point
            if ((conn.start.layer || 1) == layer) linesToRemove.push(conn);
        });
        linesToRemove.forEach(l => selectedLines.delete(l));
        if(linesToRemove.length > 0) selectionChanged = true;

        // 3. Deselect Vents
        const ventsToRemove = [];
        selectedVents.forEach(v => {
            if ((v.layer || 1) == layer) ventsToRemove.push(v);
        });
        ventsToRemove.forEach(v => selectedVents.delete(v));
        if(ventsToRemove.length > 0) selectionChanged = true;

        if (selectionChanged && typeof updateMeasurementUI === 'function') {
            updateMeasurementUI();
        }
    }

    // Trigger Updates
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
    if (typeof update3DLayerVisibility === 'function') update3DLayerVisibility();
}

/**
 * 1. Check if save exists
 */
async function handleCheckAndLoad() {
    const address = document.getElementById('addressInput').value;
    if (!address) return alert("Please enter an address");

    const zoomLayer = document.getElementById('zoom-layer');
    zoomLayer.innerHTML = '<div style="padding:50px; text-align:center;">Checking Server...</div>';

    try {
        if (typeof window.firstMeasureFindProjectByAddress !== 'function' || typeof window.firstMeasureFetchJson !== 'function') {
            throw new Error("FirstMeasure API helpers are unavailable.");
        }

        const data = await window.firstMeasureFindProjectByAddress(address);

        if (data.exists) {
            console.log("Project found, loading from API...");
            loadProjectFromFolder(data.folder);
        } else {
            console.log("Project not found, ordering report through API...");
            zoomLayer.innerHTML = '<div style="padding:50px; text-align:center;">Ordering Report & Fetching Data...</div>';

            const createResult = await window.firstMeasureFetchJson('/projects/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    address,
                    radius_meters: window.getRadiusMeters ? Number(window.getRadiusMeters()) : Number(window.RADIUS_METERS || 0),
                    issuer: { name: 'System User' },
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });
            
            if (createResult.success) {
                // Now load the newly created project
                loadProjectFromFolder(createResult.folder);
            } else {
                throw new Error(createResult.error || "Failed to create project");
            }
        }
    } catch (e) {
        console.error("Project lookup/create failed", e);
        zoomLayer.innerHTML = '<div style="padding:50px; text-align:center; color:red;">Error: ' + e.message + '</div>';
    }
}

/* Map Layer Switching Logic */
function switchMapLayer(layerId) {
    const cesiumContainer = document.getElementById('google-map-container');
    
    // CHANGED: Target the new DIV ID
    const googleDiv = document.getElementById('google-js-map'); 

    const tabCesium = document.getElementById('tabCesium');
    const tabGoogle = document.getElementById('tabGoogle');

    if (layerId === 'cesium') {
        if(cesiumContainer) cesiumContainer.style.display = 'block';
        if(googleDiv) googleDiv.style.display = 'none';
        
        if(tabCesium) tabCesium.classList.add('active');
        if(tabGoogle) tabGoogle.classList.remove('active');
    } else {
        if(cesiumContainer) cesiumContainer.style.display = 'none';
        if(googleDiv) googleDiv.style.display = 'block';
        
        if(tabCesium) tabCesium.classList.remove('active');
        if(tabGoogle) tabGoogle.classList.add('active');
    }
}

// DEPRECATED
async function handleSaveProject() {
    window.saveProjectData()
}

// Helper to convert Base64 to Blob (for efficient upload)
function dataURItoBlob(dataURI) {
    var byteString = atob(dataURI.split(',')[1]);
    var mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], {type: mimeString});
}

async function saveProjectArtifactBlob(fileName, blob) {
    if (!window.currentProjectId || !blob) return false;
    if (typeof window.firstMeasureUploadArtifact !== 'function') {
        throw new Error("FirstMeasure artifact upload helper is unavailable.");
    }
    await window.firstMeasureUploadArtifact(window.currentProjectId, blob, fileName, 'file');
    return true;
}

function firstMeasureReadQuadViewsDisabledFromOrg(org) {
    const general = org && org.report_settings && org.report_settings.general
        ? org.report_settings.general
        : {};
    return !!(
        general.disable_quad_views ||
        general.disableQuadViews ||
        general.no_quad_views ||
        general.noQuadViews
    );
}

function firstMeasureAreQuadViewsDisabled() {
    if (window.FIRSTMEASURE_DISABLE_QUAD_VIEWS === true) return true;
    return firstMeasureReadQuadViewsDisabledFromOrg(window.projectOrganization || null);
}
window.firstMeasureAreQuadViewsDisabled = firstMeasureAreQuadViewsDisabled;

function firstMeasureApplyQuadViewReportToggle() {
    const disabled = firstMeasureAreQuadViewsDisabled();
    const captureButton = document.getElementById('btnQuadView');
    if (captureButton) {
        captureButton.style.display = disabled ? 'none' : '';
        captureButton.hidden = disabled;
    }
    const step4 = document.getElementById('step4');
    if (step4) {
        step4.style.display = disabled ? 'none' : '';
        step4.hidden = disabled;
    }
    if (disabled) {
        window.quadViewCroppedImage = null;
    }
}
window.firstMeasureApplyQuadViewReportToggle = firstMeasureApplyQuadViewReportToggle;
window.saveProjectArtifactBlob = saveProjectArtifactBlob;

function replaceArtifactExtension(fileName, extension) {
    const base = String(fileName || 'artifact').replace(/\.[^.\/\\]+$/, '');
    return `${base}.${extension}`;
}

function canvasToBlobAsync(canvas, type = 'image/png', quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function canvasToUploadBlob(canvas, options = {}) {
    if (!canvas || typeof canvas.toBlob !== 'function') return null;

    const sourceW = Number(canvas.width) || 0;
    const sourceH = Number(canvas.height) || 0;
    const maxDimension = Math.max(1, Number(options.maxDimension) || Math.max(sourceW, sourceH, 1));
    const scale = Math.min(1, maxDimension / Math.max(sourceW, sourceH, 1));
    const type = options.type || 'image/png';
    const quality = Number.isFinite(options.quality) ? options.quality : undefined;
    let source = canvas;

    if (scale < 1) {
        const resized = document.createElement('canvas');
        resized.width = Math.max(1, Math.round(sourceW * scale));
        resized.height = Math.max(1, Math.round(sourceH * scale));
        const ctx = resized.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, resized.width, resized.height);
        source = resized;
    }

    return await canvasToBlobAsync(source, type, quality);
}

async function saveProjectCanvasArtifact(fileName, canvas, options = {}) {
    const type = options.type || 'image/png';
    const blob = await canvasToUploadBlob(canvas, options);
    if (!blob) return false;
    const uploadName = type === 'image/jpeg' ? replaceArtifactExtension(fileName, 'jpg') : fileName;
    return await saveProjectArtifactBlob(uploadName, blob);
}
window.saveProjectCanvasArtifact = saveProjectCanvasArtifact;

async function trySaveProjectCanvasArtifact(fileName, canvas, options = {}) {
    try {
        return await saveProjectCanvasArtifact(fileName, canvas, options);
    } catch (error) {
        console.warn(`[ProjectSave] Skipping cached ${fileName} upload:`, error);
        return false;
    }
}
window.trySaveProjectCanvasArtifact = trySaveProjectCanvasArtifact;

/* main.js - Updated Save/Load Logic */

window.saveProjectData = async function(isSilent = false, runInBackground = false, isQueuedSave = false) {
    if (!isQueuedSave) {
        const previousSave = window.__firstMeasureProjectSaveQueue || Promise.resolve();
        const queuedSave = previousSave
            .catch(() => false)
            .then(() => window.saveProjectData(isSilent, runInBackground, true));
        window.__firstMeasureProjectSaveQueue = queuedSave;
        return await queuedSave;
    }

    if (
        window.__structureLocalImageryActive
        && typeof window.serializeStructureModeGeometryForSave !== 'function'
        && typeof window.withGlobalImageContextForProjectSave === 'function'
        && !window.__projectSaveUsingGlobalContext
    ) {
        return await window.withGlobalImageContextForProjectSave(async () => {
            window.__projectSaveUsingGlobalContext = true;
            try {
                return await window.saveProjectData(isSilent, runInBackground, true);
            } finally {
                window.__projectSaveUsingGlobalContext = false;
            }
        });
    }
    const address = document.getElementById('addressInput').value;
    
    const btn = document.querySelector('button[onclick="handleSaveProject()"]');
    let originalText = "";
    if (btn && !isSilent) {
        originalText = btn.textContent;
        btn.textContent = "Saving...";
        btn.disabled = true;
    }

    try {
        // --- STEP 1: PREPARE METADATA ---
        const geoSnapshot = (activeGeometry && Array.isArray(activeGeometry.points)) ? activeGeometry : null;
        const geoPoints = geoSnapshot ? geoSnapshot.points : [];
        const geoConnections = (geoSnapshot && Array.isArray(geoSnapshot.connections)) ? geoSnapshot.connections : [];

        const resolvedFacesSource =
            (typeof __uwGetFacesSource === 'function')
                ? (__uwGetFacesSource() || [])
                : ((typeof lastResolvedFacesCache !== 'undefined' && Array.isArray(lastResolvedFacesCache)) ? lastResolvedFacesCache : []);

        const structureSaveSnapshot = (typeof window.serializeStructureModeGeometryForSave === 'function')
            ? window.serializeStructureModeGeometryForSave(resolvedFacesSource)
            : null;

        const geometrySimple = structureSaveSnapshot?.geometry || (geoSnapshot ? {
            points: geoPoints.map(p => ({ 
                x: p.x, y: p.y, z: p.z, layer: (p.layer || 1), zLocked: p.zLocked 
            })),
            connections: geoConnections.map(c => ({
                startIdx: geoPoints.indexOf(c.start),
                endIdx: geoPoints.indexOf(c.end),
                type: c.type, // This saves the Ridge/Eave/Rake classification
                manualType: !!c.manualType
            })).filter(c => c.startIdx >= 0 && c.endIdx >= 0),
            vents: geoSnapshot.vents || [],
            manualFaces: (geoSnapshot.manualFaces || []).map(face => ({
                layer: face.layer || 1,
                pointIndices: (face.points || []).map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0),
                holeIndices: (face.holes || []).map(holePoly => 
                    holePoly.map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0)
                )
            })).filter(face => Array.isArray(face.pointIndices) && face.pointIndices.length >= 3),
            resolvedFaces: resolvedFacesSource.map(face => ({
                layer: face.layer || 1,
                pointIndices: (face.points || []).map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0),
                holeIndices: (face.holes || []).map(holePoly =>
                    holePoly.map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0)
                )
            })).filter(face => Array.isArray(face.pointIndices) && face.pointIndices.length >= 3),
            deletedFaceSignatures: (typeof deletedFaceSignatures !== 'undefined') 
                ? Array.from(deletedFaceSignatures) 
                : []
        } : null);

        let configToSave = null;
        let pdfConfigSource = null;
        if (typeof reportConfigState !== 'undefined' && reportConfigState) {
            pdfConfigSource = reportConfigState;
        } else if (typeof window.loadedPdfConfig !== 'undefined' && window.loadedPdfConfig) {
            pdfConfigSource = window.loadedPdfConfig;
        }
        if (pdfConfigSource) {
            configToSave = (typeof window.serializePdfConfigForSave === 'function')
                ? window.serializePdfConfigForSave(pdfConfigSource)
                : pdfConfigSource;
        }

        const existingMeta =
            (window.currentProjectLoadedAppMetadata && typeof window.currentProjectLoadedAppMetadata === 'object')
                ? JSON.parse(JSON.stringify(window.currentProjectLoadedAppMetadata))
                : {};
        const tileManifestUrlToPreserve =
            (window.currentProject3DTileManifestUrl || '') ||
            ((existingMeta.google3dTiles && existingMeta.google3dTiles.manifestUrl) || '');
        const metadata = {
            ...existingMeta,
            imageWidth: structureSaveSnapshot?.imageWidth || imageWidth,
            imageHeight: structureSaveSnapshot?.imageHeight || imageHeight,
            imageMetersPerPx: structureSaveSnapshot?.imageMetersPerPx || (window.getMetersPerPx ? Number(window.getMetersPerPx()) : 0),
            viewConfigs, currentViewId,
            geminiPrompt: document.getElementById('geminiPrompt').value,
            geometry: geometrySimple,
            hasQuadCrop: !!window.quadViewCroppedImage,
            viewRotation: viewRotation || 0,
            pdfConfig: configToSave,
            layer_config: LAYER_CONFIG,
            visual_adjustments: visualAdjustments,
            
            // --- NEW: Save UI States ---
            uiState: {
                showMeasurementsLayer: (typeof showMeasurementsLayer !== 'undefined' ? showMeasurementsLayer : false),
                isMeasurementMode: (typeof isMeasurementMode !== 'undefined' ? isMeasurementMode : false),
                showFacesLayer: (typeof showFacesLayer !== 'undefined' ? showFacesLayer : true),
                showGridLayer: (typeof showGridLayer !== 'undefined' ? showGridLayer : true),
                isSplatMode: (typeof isSplatMode !== 'undefined' ? isSplatMode : false)
            }
        };
        if (tileManifestUrlToPreserve) {
            metadata.google3dTiles = {
                ...(existingMeta.google3dTiles && typeof existingMeta.google3dTiles === 'object' ? existingMeta.google3dTiles : {}),
                manifestUrl: tileManifestUrlToPreserve
            };
        }

        if (!window.currentProjectId) {
            throw new Error("Cannot save before a project is loaded.");
        }
        if (typeof window.firstMeasureBuildUrl !== 'function') {
            throw new Error("FirstMeasure API helpers are unavailable.");
        }

        const mainSaveRes = await window.firstMeasureFetchJson(
            `/projects/${encodeURIComponent(window.currentProjectId)}/editor/save`,
            {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metadata })
            }
        );

        // --- STEP 2: ATTACH IMAGES ---
        const blobPromises = [];
        const protectedLayers = ['solar', 'google', 'azure', 'apple', 'height'];

        for (const [viewId, canvas] of Object.entries(viewCanvases)) {
            if (protectedLayers.includes(viewId)) continue;

            const p = new Promise((resolve, reject) => {
                if (!canvas || typeof canvas.toBlob !== 'function') {
                    resolve();
                    return;
                }
                canvas.toBlob(async (blob) => {
                    try {
                        if (blob) await saveProjectArtifactBlob(viewId + '.png', blob);
                        resolve();
                    } catch (uploadErr) {
                        reject(uploadErr);
                    }
                }, 'image/png');
            });
            blobPromises.push(p);
        }

        if (window.quadViewCroppedImage) {
            const quadBlob = dataURItoBlob(window.quadViewCroppedImage);
            blobPromises.push(saveProjectArtifactBlob('quad_crop.png', quadBlob));
        }

        await Promise.all(blobPromises);

        if (!mainSaveRes || mainSaveRes.success === false) {
            throw new Error(mainSaveRes?.error || 'Save failed.');
        }

        if (!runInBackground && typeof window.saveStandalonePdfState === 'function') {
            try {
                await window.saveStandalonePdfState(null, { skipCaptureIfMissing: true });
            } catch (snapshotErr) {
                console.warn('[PDF Snapshot] Save skipped:', snapshotErr);
            }
        }

        const savedProjectId = mainSaveRes.folder || window.currentProjectId;
        window.currentProjectLoadedAppMetadata = JSON.parse(JSON.stringify(metadata));
        if (!isSilent) alert("Project saved! Folder: " + savedProjectId);
        console.log("✅ Project Saved. ID:", savedProjectId);
        return true;

    } catch (e) {
        console.error(e);
        if (!isSilent) alert("Error saving: " + e.message);
        return false;
    } finally {
        if (btn && !isSilent) {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }
};

function clonePlainObject(value, fallback = null) {
    try {
        return value == null ? fallback : JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

function toFiniteNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function getFirstLatLngPin(pins) {
    if (!Array.isArray(pins)) return null;
    for (const pin of pins) {
        const lat = toFiniteNumberOrNull(pin && pin.lat);
        const lng = toFiniteNumberOrNull(pin && pin.lng);
        if (lat !== null && lng !== null) return { lat, lng };
    }
    return null;
}

function resolveGeometryCenter(manifest, fallbackLat, fallbackLng) {
    const lat = toFiniteNumberOrNull(manifest && (manifest.lat ?? manifest.source_lat));
    const lng = toFiniteNumberOrNull(manifest && (manifest.lng ?? manifest.source_lng));
    if (lat !== null && lng !== null) return { lat, lng };

    const pin = getFirstLatLngPin(manifest && manifest.pins);
    if (pin) return pin;

    const fallbackLatNum = toFiniteNumberOrNull(fallbackLat);
    const fallbackLngNum = toFiniteNumberOrNull(fallbackLng);
    return fallbackLatNum !== null && fallbackLngNum !== null
        ? { lat: fallbackLatNum, lng: fallbackLngNum }
        : null;
}

function transformPreviousReportGeometry(sourceGeometry, sourceManifest, sourceMeta, targetManifest) {
    const geometry = clonePlainObject(sourceGeometry, null);
    if (!geometry || !Array.isArray(geometry.points)) return null;

    const sourceWidth = toFiniteNumberOrNull(sourceMeta && sourceMeta.imageWidth)
        || toFiniteNumberOrNull(sourceMeta && sourceMeta.source_image && sourceMeta.source_image.width)
        || imageWidth;
    const sourceHeight = toFiniteNumberOrNull(sourceMeta && sourceMeta.imageHeight)
        || toFiniteNumberOrNull(sourceMeta && sourceMeta.source_image && sourceMeta.source_image.height)
        || imageHeight;
    const targetWidth = toFiniteNumberOrNull(imageWidth) || sourceWidth;
    const targetHeight = toFiniteNumberOrNull(imageHeight) || sourceHeight;

    const sourceRadius = toFiniteNumberOrNull(sourceManifest && sourceManifest.radius_meters)
        || toFiniteNumberOrNull(sourceMeta && sourceMeta.source_radius_meters)
        || (window.getRadiusMeters ? toFiniteNumberOrNull(window.getRadiusMeters()) : null)
        || 20;
    const targetRadius = toFiniteNumberOrNull(targetManifest && targetManifest.radius_meters)
        || (window.getRadiusMeters ? toFiniteNumberOrNull(window.getRadiusMeters()) : null)
        || sourceRadius;

    const sourceCenter = resolveGeometryCenter(sourceManifest, null, null);
    const targetCenter = resolveGeometryCenter(targetManifest, mapCenterLat, mapCenterLng);
    if (!sourceCenter || !targetCenter || !sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
        return geometry;
    }

    const metersPerLat = 111132;
    const sourceMetersPerLng = 111132 * Math.cos(sourceCenter.lat * (Math.PI / 180));
    const targetMetersPerLng = 111132 * Math.cos(targetCenter.lat * (Math.PI / 180));
    const sourceMetersPerPx = toFiniteNumberOrNull(sourceMeta && sourceMeta.imageMetersPerPx)
        || (sourceRadius * 2) / sourceWidth;
    const targetMetersPerPx = (window.getMetersPerPx ? toFiniteNumberOrNull(window.getMetersPerPx()) : null)
        || (targetRadius * 2) / targetWidth;

    if (!Number.isFinite(sourceMetersPerLng) || !Number.isFinite(targetMetersPerLng) || !sourceMetersPerPx || !targetMetersPerPx) {
        return geometry;
    }

    const projectItem = (item) => {
        if (!item || typeof item !== 'object') return;
        const x = toFiniteNumberOrNull(item.x);
        const y = toFiniteNumberOrNull(item.y);
        if (x === null || y === null) return;

        const dxMeters = (x - sourceWidth / 2) * sourceMetersPerPx;
        const dyMeters = (sourceHeight / 2 - y) * sourceMetersPerPx;
        const realLat = sourceCenter.lat + (dyMeters / metersPerLat);
        const realLng = sourceCenter.lng + (dxMeters / sourceMetersPerLng);

        const targetDxMeters = (realLng - targetCenter.lng) * targetMetersPerLng;
        const targetDyMeters = (realLat - targetCenter.lat) * metersPerLat;
        item.x = (targetWidth / 2) + (targetDxMeters / targetMetersPerPx);
        item.y = (targetHeight / 2) - (targetDyMeters / targetMetersPerPx);
    };

    geometry.points.forEach(projectItem);
    if (Array.isArray(geometry.vents)) geometry.vents.forEach(projectItem);
    return geometry;
}

function showPreviousReportImportModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'background:rgba(32,33,36,0.45)',
            'z-index:100000',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'padding:20px'
        ].join(';');

        const modal = document.createElement('div');
        modal.style.cssText = [
            'width:min(460px,100%)',
            'background:#fff',
            'border-radius:8px',
            'box-shadow:0 24px 60px rgba(0,0,0,0.28)',
            'padding:22px',
            'font-family:Arial,sans-serif',
            'color:#202124'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'Previous report found';
        title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:10px;';

        const body = document.createElement('div');
        body.textContent = 'We have a previous report for this address. Would you like to load it now?';
        body.style.cssText = 'font-size:14px;line-height:1.45;color:#3c4043;margin-bottom:18px;';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

        const noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.textContent = 'No';
        noBtn.style.cssText = 'border:1px solid #dadce0;background:#fff;color:#3c4043;border-radius:6px;padding:9px 14px;font-weight:700;cursor:pointer;';

        const yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.textContent = 'Yes';
        yesBtn.style.cssText = 'border:1px solid #1a73e8;background:#1a73e8;color:#fff;border-radius:6px;padding:9px 14px;font-weight:700;cursor:pointer;';

        const finish = (value) => {
            overlay.remove();
            resolve(value);
        };

        noBtn.addEventListener('click', () => finish(false));
        yesBtn.addEventListener('click', () => finish(true));
        actions.append(noBtn, yesBtn);
        modal.append(title, body, actions);
        overlay.append(modal);
        document.body.append(overlay);
        yesBtn.focus();
    });
}

function firstMeasureParseSolarImageryDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'string') {
        const match = value.match(/(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
        if (!match) return null;
        const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3] || 1));
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === 'object') {
        const year = Number(value.year);
        const month = Number(value.month);
        const day = Number(value.day || 1);
        if (!Number.isFinite(year) || !Number.isFinite(month) || year < 1900 || month < 1 || month > 12) return null;
        const parsed = new Date(year, month - 1, Number.isFinite(day) && day > 0 ? day : 1);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
}

function firstMeasureFormatSolarImageryDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function firstMeasureSolarImageryAgeYears(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const now = new Date();
    let years = now.getFullYear() - date.getFullYear();
    const beforeAnniversary =
        now.getMonth() < date.getMonth() ||
        (now.getMonth() === date.getMonth() && now.getDate() < date.getDate());
    if (beforeAnniversary) years -= 1;
    return years;
}

function firstMeasureIsSolarImageryOverThreeYearsOld(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 3);
    return date < cutoff;
}

function firstMeasureShowOldHeightMapFootageModal(imageryDate) {
    if (!(imageryDate instanceof Date) || Number.isNaN(imageryDate.getTime())) return;
    if (document.getElementById('old-height-map-footage-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'old-height-map-footage-modal';
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'background:rgba(32,33,36,0.48)',
        'z-index:100000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:20px'
    ].join(';');

    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'oldHeightMapFootageTitle');
    modal.style.cssText = [
        'width:min(500px,100%)',
        'background:#fff',
        'border-radius:8px',
        'box-shadow:0 24px 60px rgba(0,0,0,0.28)',
        'padding:22px',
        'font-family:Arial,sans-serif',
        'color:#202124'
    ].join(';');

    const title = document.createElement('div');
    title.id = 'oldHeightMapFootageTitle';
    title.textContent = 'Height map footage is over three years old';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:10px;';

    const body = document.createElement('div');
    const formattedDate = firstMeasureFormatSolarImageryDate(imageryDate);
    const ageYears = firstMeasureSolarImageryAgeYears(imageryDate);
    body.textContent = `The Google Solar height map footage${formattedDate ? ` was taken on ${formattedDate}` : ''}${Number.isFinite(ageYears) ? `, about ${ageYears} years ago` : ''}. Be sure to check Google Earth's historical view to confirm that the property has not changed since the footage was taken.`;
    body.style.cssText = 'font-size:14px;line-height:1.5;color:#3c4043;margin-bottom:18px;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'Got it';
    okBtn.style.cssText = 'border:1px solid #1a73e8;background:#1a73e8;color:#fff;border-radius:6px;padding:9px 14px;font-weight:700;cursor:pointer;';

    const closeModal = () => overlay.remove();
    okBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal();
    });

    actions.append(okBtn);
    modal.append(title, body, actions);
    overlay.append(modal);
    document.body.append(overlay);
    okBtn.focus();
}

function firstMeasureMaybeWarnOldHeightMapFootage(manifest, insights) {
    const manifestDate = manifest && typeof manifest === 'object'
        ? firstMeasureParseSolarImageryDate(manifest.solar_imagery_date)
        : null;
    const insightsDate = insights && typeof insights === 'object'
        ? firstMeasureParseSolarImageryDate(insights.imageryDate)
        : null;
    const imageryDate = manifestDate || insightsDate;
    if (!firstMeasureIsSolarImageryOverThreeYearsOld(imageryDate)) return;

    const projectId = String(window.currentProjectId || '').trim();
    window.__firstMeasureOldHeightMapWarningsShown = window.__firstMeasureOldHeightMapWarningsShown || new Set();
    if (projectId && window.__firstMeasureOldHeightMapWarningsShown.has(projectId)) return;
    if (projectId) window.__firstMeasureOldHeightMapWarningsShown.add(projectId);

    setTimeout(() => firstMeasureShowOldHeightMapFootageModal(imageryDate), 250);
}

async function patchPreviousReportCandidateStatus(candidate, status, extra = {}) {
    if (!window.currentProjectId || !candidate || typeof candidate !== 'object') return;
    try {
        await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(window.currentProjectId)}`, {
            method: 'PATCH',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                previous_report_candidate: {
                    ...candidate,
                    ...extra,
                    status,
                    acknowledged_at: new Date().toISOString(),
                    acknowledged_by: window.FIRSTMEASURE_ACTOR || null
                }
            })
        });
    } catch (e) {
        console.warn('[Previous Report] Failed to update candidate status:', e);
    }
}

function normalizePreviousReportAddress(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9@._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPreviousReportProjectComplete(project) {
    const status = String((project && project.status) || '').trim().toLowerCase();
    const timestamps = project && project.timestamps && typeof project.timestamps === 'object' ? project.timestamps : {};
    const artifacts = project && project.artifacts && typeof project.artifacts === 'object' ? project.artifacts : {};
    return status === 'completed'
        || status === 'awaiting_review'
        || !!timestamps.completed_at
        || !!timestamps.uploaded_at
        || !!artifacts.has_report_pdf
        || !!artifacts.has_main_pdf
        || !!artifacts.has_summary_pdf
        || !!artifacts.has_model_data;
}

function parsePreviousReportTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const direct = Date.parse(raw);
    if (Number.isFinite(direct)) return direct;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    const normalizedMs = Date.parse(normalized);
    return Number.isFinite(normalizedMs) ? normalizedMs : 0;
}

async function findPreviousReportCandidateFromExistingRoutes(manifest) {
    const address = String((manifest && manifest.address) || document.getElementById('addressInput')?.value || '').trim();
    const normalizedAddress = normalizePreviousReportAddress(address);
    if (!normalizedAddress) return null;

    const data = await window.firstMeasureFetchJson('/projects/query', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            search: address,
            limit: 25,
            include_instant_only: true
        })
    });
    let projects = Array.isArray(data && data.projects) ? data.projects : [];

    if (projects.length < 2) {
        try {
            const broadData = await window.firstMeasureFetchJson('/projects/query', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    limit: 500,
                    include_instant_only: true
                })
            });
            const byId = new Map();
            [...projects, ...(Array.isArray(broadData && broadData.projects) ? broadData.projects : [])].forEach((project) => {
                const id = String(project && (project.id || project.folder || project.project_id) || '').trim();
                if (id) byId.set(id, project);
            });
            projects = Array.from(byId.values());
        } catch (e) {
            console.warn('[Previous Report] Broad candidate lookup failed:', e);
        }
    }

    window.__previousReportSourceBundleById = window.__previousReportSourceBundleById || {};
    const candidates = [];

    for (const project of projects) {
        const projectId = String(project && (project.id || project.folder || project.project_id) || '').trim();
        if (!projectId || projectId === String(window.currentProjectId || '').trim()) continue;
        if (normalizePreviousReportAddress(project && project.address) !== normalizedAddress) continue;

        let sourceBundle = null;
        try {
            sourceBundle = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/editor`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
        } catch (e) {
            console.warn('[Previous Report] Failed to inspect possible source project:', projectId, e);
            continue;
        }

        const sourceMeta = sourceBundle && sourceBundle.app_metadata && typeof sourceBundle.app_metadata === 'object'
            ? sourceBundle.app_metadata
            : {};
        const sourcePdfState = sourceBundle && sourceBundle.pdf_state && typeof sourceBundle.pdf_state === 'object'
            ? sourceBundle.pdf_state
            : {};
        const sourceGeometry =
            (sourceMeta.geometry && Array.isArray(sourceMeta.geometry.points) ? sourceMeta.geometry : null) ||
            (sourcePdfState.geometry && Array.isArray(sourcePdfState.geometry.points) ? sourcePdfState.geometry : null);
        if (!sourceGeometry || sourceGeometry.points.length < 2) continue;

        window.__previousReportSourceBundleById[projectId] = sourceBundle;
        const timestamps = project.timestamps && typeof project.timestamps === 'object' ? project.timestamps : {};
        const isComplete = isPreviousReportProjectComplete(project);
        const completedAt = timestamps.completed_at || project.completed_at || null;
        const uploadedAt = timestamps.uploaded_at || project.uploaded_at || null;
        candidates.push({
            isComplete,
            pointCount: sourceGeometry.points.length,
            sortTs: parsePreviousReportTimestamp(completedAt || uploadedAt || timestamps.updated_at || project.updated_at || timestamps.created_at || project.created_at),
            candidate: {
            status: 'pending',
            source_project_id: projectId,
            source_address: String(project.address || address),
            source_project_type: String(project.project_type || ''),
            source_created_at: timestamps.created_at || project.created_at || null,
                source_completed_at: completedAt,
                source_uploaded_at: uploadedAt,
                source_is_complete: isComplete,
            source_lat: toFiniteNumberOrNull(project.lat),
            source_lng: toFiniteNumberOrNull(project.lng),
            source_pins: Array.isArray(project.pins) ? project.pins : [],
            source_radius_meters: toFiniteNumberOrNull(project.radius_meters),
            source_image: {
                width: toFiniteNumberOrNull(sourceMeta.imageWidth),
                height: toFiniteNumberOrNull(sourceMeta.imageHeight)
            },
            geometry_point_count: sourceGeometry.points.length,
            geometry_connection_count: Array.isArray(sourceGeometry.connections) ? sourceGeometry.connections.length : 0,
            detected_at: new Date().toISOString(),
            detected_by: 'editor_fallback'
            }
        });
    }

    candidates.sort((a, b) => {
        if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
        if (a.pointCount !== b.pointCount) return b.pointCount - a.pointCount;
        return b.sortTs - a.sortTs;
    });

    return candidates[0] ? candidates[0].candidate : null;
}

async function maybeImportPreviousReportGeometry(meta, manifest, savedPdfState) {
    const qs = new URLSearchParams(window.location.search || '');
    if (qs.has('qa_embed') || qs.has('headless')) return null;

    let candidate = manifest && manifest.previous_report_candidate;
    if (!candidate || typeof candidate !== 'object' || candidate.status !== 'pending') {
        try {
            const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(window.currentProjectId)}/previous-report-candidate`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            candidate = data && data.candidate && typeof data.candidate === 'object' ? data.candidate : null;
        } catch (e) {
            console.warn('[Previous Report] Candidate lookup failed:', e);
            candidate = null;
        }
    }
    if (!candidate || typeof candidate !== 'object' || candidate.status !== 'pending') {
        try {
            candidate = await findPreviousReportCandidateFromExistingRoutes(manifest);
        } catch (e) {
            console.warn('[Previous Report] Editor fallback lookup failed:', e);
            candidate = null;
        }
    }
    if (!candidate || typeof candidate !== 'object' || candidate.status !== 'pending') return null;

    const currentGeometry = meta && meta.geometry && Array.isArray(meta.geometry.points) ? meta.geometry : null;
    const currentPdfGeometry = savedPdfState && savedPdfState.geometry && Array.isArray(savedPdfState.geometry.points) ? savedPdfState.geometry : null;
    if ((currentGeometry && currentGeometry.points.length) || (currentPdfGeometry && currentPdfGeometry.points.length)) {
        await patchPreviousReportCandidateStatus(candidate, 'skipped_existing_geometry');
        return null;
    }

    const shouldImport = await showPreviousReportImportModal();
    if (!shouldImport) {
        await patchPreviousReportCandidateStatus(candidate, 'declined');
        return null;
    }

    const sourceProjectId = String(candidate.source_project_id || '').trim();
    if (!sourceProjectId) {
        await patchPreviousReportCandidateStatus(candidate, 'failed_missing_source');
        return null;
    }

    const sourceBundle = (window.__previousReportSourceBundleById && window.__previousReportSourceBundleById[sourceProjectId])
        ? window.__previousReportSourceBundleById[sourceProjectId]
        : await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(sourceProjectId)}/editor`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
    const sourceMeta = sourceBundle && sourceBundle.app_metadata && typeof sourceBundle.app_metadata === 'object'
        ? sourceBundle.app_metadata
        : {};
    const sourcePdfState = sourceBundle && sourceBundle.pdf_state && typeof sourceBundle.pdf_state === 'object'
        ? sourceBundle.pdf_state
        : {};
    const sourceGeometry =
        (sourceMeta.geometry && Array.isArray(sourceMeta.geometry.points) ? sourceMeta.geometry : null) ||
        (sourcePdfState.geometry && Array.isArray(sourcePdfState.geometry.points) ? sourcePdfState.geometry : null);
    if (!sourceGeometry) {
        await patchPreviousReportCandidateStatus(candidate, 'failed_missing_geometry');
        return null;
    }

    const importedGeometry = transformPreviousReportGeometry(
        sourceGeometry,
        sourceBundle.manifest || candidate,
        { ...sourceMeta, source_radius_meters: candidate.source_radius_meters, source_image: candidate.source_image },
        manifest
    );
    if (!importedGeometry) {
        await patchPreviousReportCandidateStatus(candidate, 'failed_transform');
        return null;
    }

    const importMeta = {
        source_project_id: sourceProjectId,
        imported_at: new Date().toISOString(),
        imported_by: window.FIRSTMEASURE_ACTOR || null,
        geometry_point_count: Array.isArray(importedGeometry.points) ? importedGeometry.points.length : 0
    };
    meta.geometry = importedGeometry;
    meta.previousReportImport = importMeta;

    await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(window.currentProjectId)}/editor/save`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ metadata: meta })
    });
    await patchPreviousReportCandidateStatus(candidate, 'imported', importMeta);
    alert('Keep in mind this is for a different order for the same address so the pins and layout may be different.');
    return importedGeometry;
}

function projectEditorBundleHasRenderableAsset(data) {
    const assets = data && data.assets && typeof data.assets === 'object' ? data.assets : {};
    return !!(assets.rgb || assets.google || assets.azure || assets.apple);
}

function describeProjectBundleProblem(data) {
    const manifest = data && typeof data === 'object' ? data.manifest : null;
    if (!manifest || typeof manifest !== 'object') {
        return data?.message || data?.error || 'Project manifest was not returned.';
    }
    if (!projectEditorBundleHasRenderableAsset(data)) {
        return 'Project bundle did not include a renderable map asset.';
    }
    return '';
}

async function fetchProjectEditorBundleWithFallback(projectId, isTutorialProject) {
    const path = `/projects/${encodeURIComponent(projectId)}/editor`;
    const baseOptions = {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    };
    let lazyError = null;
    let lazyData = null;

    try {
        lazyData = await window.firstMeasureFetchJson(path, baseOptions);
        const lazyProblem = describeProjectBundleProblem(lazyData);
        if (!lazyProblem) return lazyData;
        lazyError = new Error(lazyProblem);
    } catch (e) {
        lazyError = e;
    }

    if (!isTutorialProject) {
        console.warn('Lazy project bundle failed or was incomplete; retrying direct project editor load.', lazyError);
        const directData = await window.firstMeasureFetchJson(path, {
            ...baseOptions,
            firstMeasureBypassEditorBundle: true
        });
        const directProblem = describeProjectBundleProblem(directData);
        if (!directProblem) return directData;
        throw new Error(`${directProblem} Lazy load fallback also failed: ${lazyError?.message || 'unknown lazy load error'}`);
    }

    throw lazyError || new Error('Project bundle did not load.');
}


async function loadProjectFromFolder(folderHash) {
    const requestedProjectId = String(folderHash || '').trim();
    const isTutorialProject = typeof window.firstMeasureIsTutorialProjectId === 'function'
        ? window.firstMeasureIsTutorialProjectId(requestedProjectId)
        : /^tutorial_[a-f0-9]{16,64}$/i.test(requestedProjectId);
    const isTutorialMode = !!(window.FIRSTMEASURE_TUTORIAL && window.FIRSTMEASURE_TUTORIAL.enabled);

    if (isTutorialProject && !isTutorialMode) {
        const message = 'Tutorial projects must be opened from tutorial mode.';
        alert(message);
        throw new Error(message);
    }
    if (isTutorialMode && !isTutorialProject) {
        const message = 'Tutorial mode can only load tutorial project instances.';
        alert(message);
        throw new Error(message);
    }

    resetLayerVisibility();
    _applePrefetchRunId += 1;
    _applePrefetchPromise = null;

    if (typeof exitMeasurementMode === 'function') {
        exitMeasurementMode();
    }
    
    window.currentProjectId = requestedProjectId;
    window.quadViewCroppedImage = null;
    window.projectOrganization = null;
    window.loadedPdfStateAsset = null;
    document.getElementById('zoom-layer').innerHTML = '<div style="padding:50px; text-align:center;">Loading Project Assets...</div>';
    
    activeGeometry = null;
    hasGeoImage = false;
    cachedGeoImage = null;
    imageWidth = 0;
    imageHeight = 0;
    history2D = []; 
    redo2D = []; 
    viewRotation = 0; 
    window.loadedPdfConfig = null;   
    
    try {
        const data = await fetchProjectEditorBundleWithFallback(requestedProjectId, isTutorialProject);
        const manifest = data && typeof data === 'object' ? data.manifest : null;
        if (!manifest || typeof manifest !== 'object') {
            throw new Error(data?.message || data?.error || "Project manifest was not returned.");
        }
        window.currentProjectManifest = manifest;
        if (typeof window.refreshStructureMode === 'function') window.refreshStructureMode();
        if (typeof window.firstMeasureRenderCustomerReworkPrompt === 'function') {
            window.firstMeasureRenderCustomerReworkPrompt(manifest);
        }
        
        // Right after: const manifest = data.manifest; (or const meta = data.app_metadata ...)
        if (typeof updateProjectTypeBadge === 'function') {
            updateProjectTypeBadge(manifest.project_type || null);
        }
        if (typeof updateStructureCountBadge === 'function') {
            updateStructureCountBadge(Array.isArray(manifest.pins) ? manifest.pins.length : 0);
        }

        if (data.organization) {
            window.projectOrganization = data.organization;
        }
        firstMeasureApplyQuadViewReportToggle();

        if ((!manifest.lat || !manifest.lng) && (manifest.address || document.getElementById('addressInput')?.value)) {
            const addrToGeo = manifest.address || document.getElementById('addressInput')?.value || '';
            if (addrToGeo && geocoder && typeof geocoder.geocode === 'function') {
                await new Promise((resolve) => {
                geocoder.geocode({ address: addrToGeo }, (results, status) => {
                    if (status === 'OK' && results && results[0] && results[0].geometry && results[0].geometry.location) {
                    const loc = results[0].geometry.location;
                    mapCenterLat = loc.lat();
                    mapCenterLng = loc.lng();
                    if (googleJsMap) {
                        googleJsMap.setCenter({ lat: mapCenterLat, lng: mapCenterLng });
                        googleJsMap.setZoom(20);
                        googleJsMap.setTilt(45);
                        googleJsMap.setHeading(0);
                    }
                    if (typeof recenterMap === 'function') recenterMap();
                    }
                    resolve();
                });
                });
            }
        }

        const assets = data.assets || {}; 
        const insights = data.insights;
        window.currentProjectAssets = assets;
        firstMeasureMaybeWarnOldHeightMapFootage(manifest, insights);

        if (manifest.address) setHeaderAddress(manifest.address);

        const meta = data.app_metadata || manifest.app_metadata || {};
        window.currentProjectLoadedAppMetadata = (meta && typeof meta === 'object')
            ? JSON.parse(JSON.stringify(meta))
            : {};
        const savedPdfState = data.pdf_state && typeof data.pdf_state === 'object' ? data.pdf_state : null;
        window.currentProject3DTileManifestUrl =
            (meta.google3dTiles && meta.google3dTiles.manifestUrl) ||
            assets['google_3d_manifest'] ||
            null;
        if (typeof window.scheduleDeferredGoogleTilePreload === 'function') {
            window.scheduleDeferredGoogleTilePreload();
        }
        window.loadedPdfStateAsset = data.pdf_state_asset || null;


        if (meta.layer_config && typeof meta.layer_config === 'object') {
            Object.keys(meta.layer_config).forEach(k => {
                const v = meta.layer_config[k];
                if (!v || typeof v !== 'object') return;
                if (!LAYER_CONFIG[k]) LAYER_CONFIG[k] = { scale: 1.0, x: 0, y: 0 };
                if (Number.isFinite(v.scale)) LAYER_CONFIG[k].scale = v.scale;
                if (Number.isFinite(v.x))     LAYER_CONFIG[k].x     = v.x;
                if (Number.isFinite(v.y))     LAYER_CONFIG[k].y     = v.y;
                if (Number.isFinite(v.rot))       LAYER_CONFIG[k].rot = v.rot;
                if (Number.isFinite(v.fineScale)) LAYER_CONFIG[k].fineScale = v.fineScale;
                if (Number.isFinite(v.__zoom))    LAYER_CONFIG[k].__zoom = v.__zoom;
            });
        }

        visualAdjustments = {};
        if (meta.visual_adjustments && typeof meta.visual_adjustments === 'object') {
            Object.keys(meta.visual_adjustments).forEach(k => {
                visualAdjustments[k] = normalizeVisualAdjustmentState(meta.visual_adjustments[k]);
            });
        }
        adjustedViewCanvases = {};

        if (typeof meta.viewRotation === 'number') viewRotation = meta.viewRotation;
        if (meta.pdfConfig) window.loadedPdfConfig = meta.pdfConfig;
        if (!firstMeasureAreQuadViewsDisabled() && assets['quad_crop']) {
            fetch(assets['quad_crop']).then(r=>r.blob()).then(blob=>{
                const reader=new FileReader(); reader.onloadend=()=>{ window.quadViewCroppedImage=reader.result; const s4=document.getElementById('step4'); if(s4) s4.classList.add('done'); }; reader.readAsDataURL(blob);
            });
        } else if (!firstMeasureAreQuadViewsDisabled() && savedPdfState && typeof savedPdfState.quadImage === 'string' && savedPdfState.quadImage) {
            window.quadViewCroppedImage = savedPdfState.quadImage;
            const s4 = document.getElementById('step4');
            if (s4) s4.classList.add('done');
        }

        // Seed radius from manifest (per-project, computed from pins on server)
        const manifestRadius = Number(manifest.radius_meters);
        if (Number.isFinite(manifestRadius) && manifestRadius > 0) {
            setRadiusMeters(manifestRadius);
        }
        if (window.setImageMetersPerPx) {
            const savedMetersPerPx = Number(meta.imageMetersPerPx);
            window.setImageMetersPerPx(
                Number.isFinite(savedMetersPerPx) && savedMetersPerPx > 0
                    ? savedMetersPerPx
                    : null
            );
        }

        const manifestLat = Number(manifest.lat);
        const manifestLng = Number(manifest.lng);
        const insightCenter = insights && insights.solarPotential && insights.solarPotential.center
            ? insights.solarPotential.center
            : null;
        const insightLat = Number(insightCenter && insightCenter.latitude);
        const insightLng = Number(insightCenter && insightCenter.longitude);

        const hasManifestCenter = Number.isFinite(manifestLat) && Number.isFinite(manifestLng);
        if (hasManifestCenter) {
            mapCenterLat = manifestLat;
            mapCenterLng = manifestLng;
        } else if (Number.isFinite(insightLat) && Number.isFinite(insightLng)) {
            mapCenterLat = insightLat;
            mapCenterLng = insightLng;
        }

        viewCanvases = {};
        adjustedViewCanvases = {};
        layerData = { rgb: null, mask: null, dsm: null, google: null, azure: null, apple: null };

        if (!assets.apple) {
            prefetchAppleLayerInBackground({ reason: 'project-load-early' });
        }

        if (!assets['rgb']) {
            const fallbackProvider = assets['google'] ? 'google' : (assets['azure'] ? 'azure' : (assets['apple'] ? 'apple' : ''));
            if (fallbackProvider) {
                await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = "Anonymous";
                    img.onload = () => {
                        imageWidth = img.width;
                        imageHeight = img.height;
                        if (fallbackProvider === 'google') layerData.google = img;
                        if (fallbackProvider === 'azure') layerData.azure = img;
                        if (fallbackProvider === 'apple') layerData.apple = img;
                        const c = document.createElement('canvas');
                        c.width = imageWidth; c.height = imageHeight;
                        const ctx = c.getContext('2d');
                        const cfg = normalizeProviderLayerScaleBeforeDraw(fallbackProvider, img.width, imageWidth) || ensureLayerCfg(fallbackProvider);
                        drawScaledImage(
                            ctx,
                            img,
                            imageWidth,
                            imageHeight,
                            cfg.scale,
                            cfg.x,
                            cfg.y,
                            cfg.rot || 0,
                            cfg.fineScale || 1.0
                        );
                        viewCanvases[fallbackProvider] = c;
                        viewCanvases['solar'] = c; 
                        resolve();
                    };
                    img.onerror = () => reject(new Error(`${fallbackProvider} map fallback failed.`));
                    img.src = assets[fallbackProvider];
                });
            } else {
                throw new Error("Project loaded, but no renderable map assets were returned.");
            }
        }

        if (insights && insights.solarPotential) {
            segmentStats = insights.solarPotential.roofSegmentStats;
            renderTable();
            if (!hasManifestCenter && insights.solarPotential.center) {
                mapCenterLat = insights.solarPotential.center.latitude;
                mapCenterLng = insights.solarPotential.center.longitude;
            }
        }

        if (meta.imageWidth && imageWidth === 0) {
            imageWidth = meta.imageWidth;
            imageHeight = meta.imageHeight;
        }

        const deferredTiffAssets = {
            rgb: assets['rgb'] || null,
            dsm: assets['dsm'] || null,
            mask: assets['mask'] || null
        };
        const ensureMissingMaskAfterPaint = (!assets['mask']) && !!(insights && insights.solarPotential);
        roofMaskData = null;

        adjustedViewCanvases = {};
        maskedViewCanvases = {};

        const imgPromises = [];
        for (const [key, url] of Object.entries(assets)) {
            if (key === 'rgb' || key === 'dsm' || key === 'quad_crop' || key === 'mask') continue; 
            if (viewCanvases[key]) continue; 

            const p = new Promise(resolve => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                img.onload = () => {
                    if(!imageWidth) { imageWidth = img.width; imageHeight = img.height; }
                    const c = document.createElement('canvas');
                    c.width = imageWidth; c.height = imageHeight;
                    const ctx = c.getContext('2d');
                    const cfg = normalizeProviderLayerScaleBeforeDraw(key, img.width, imageWidth) || ensureLayerCfg(key);
                    drawScaledImage(
                        ctx,
                        img,
                        imageWidth,
                        imageHeight,
                        cfg.scale,
                        cfg.x,
                        cfg.y,
                        cfg.rot || 0,
                        cfg.fineScale || 1.0
                    );
                    
                    if(key === 'google') layerData.google = img;
                    if(key === 'azure')  layerData.azure = img;
                    if(key === 'apple')  layerData.apple = img;

                    viewCanvases[key] = c;
                    resolve();
                };
                img.onerror = resolve; 
                img.src = url; 
            });
            imgPromises.push(p);
        }
        await Promise.all(imgPromises);
        if (!viewCanvases['solar']) {
            const fallbackSolarCanvas = viewCanvases['google'] || viewCanvases['azure'] || viewCanvases['apple'] || null;
            if (fallbackSolarCanvas) viewCanvases['solar'] = fallbackSolarCanvas;
        }

        let geometryWasRestored = false;
        const importedPreviousGeometry = await maybeImportPreviousReportGeometry(meta, manifest, savedPdfState);
        if (importedPreviousGeometry) {
            window.currentProjectLoadedAppMetadata = (meta && typeof meta === 'object')
                ? JSON.parse(JSON.stringify(meta))
                : {};
        }
        const savedGeometry =
            (importedPreviousGeometry && Array.isArray(importedPreviousGeometry.points) ? importedPreviousGeometry : null) ||
            (meta.geometry && Array.isArray(meta.geometry.points) ? meta.geometry : null) ||
            (savedPdfState && savedPdfState.geometry && Array.isArray(savedPdfState.geometry.points) ? savedPdfState.geometry : null);
        if (savedGeometry && Array.isArray(savedGeometry.points)) {
            const pts = savedGeometry.points.map(p => ({ x:p.x, y:p.y, z:p.z, layer:(p.layer||1), zLocked:!!p.zLocked, zVotes:[] }));
            const pointKey = (p) => {
                if (!p || typeof p !== 'object') return '';
                const x = Number(p.x);
                const y = Number(p.y);
                const z = Number(p.z);
                const layer = p.layer || 1;
                return `${Number.isFinite(x) ? x.toFixed(6) : ''}|${Number.isFinite(y) ? y.toFixed(6) : ''}|${Number.isFinite(z) ? z.toFixed(6) : ''}|${layer}`;
            };
            const pointIndexByKey = new Map();
            pts.forEach((p, idx) => {
                const key = pointKey(p);
                if (key && !pointIndexByKey.has(key)) pointIndexByKey.set(key, idx);
            });
            const pointIndexFromRef = (ref) => {
                if (Number.isInteger(ref)) return ref >= 0 && ref < pts.length ? ref : -1;
                const exactIdx = pointIndexByKey.get(pointKey(ref));
                if (Number.isInteger(exactIdx)) return exactIdx;
                return -1;
            };
            const pointsFromRefs = (indices, pointRefs) => {
                const source = Array.isArray(indices) ? indices : (Array.isArray(pointRefs) ? pointRefs : []);
                return source.map(ref => pts[pointIndexFromRef(ref)]).filter(Boolean);
            };
            const holesFromRefs = (indexHoles, pointHoles) => {
                const source = Array.isArray(indexHoles) ? indexHoles : (Array.isArray(pointHoles) ? pointHoles : []);
                return source.map(hole => pointsFromRefs(hole, hole)).filter(h => h.length >= 3);
            };
            const conns = Array.isArray(savedGeometry.connections)
                ? savedGeometry.connections.map(c => {
                    const startIdx = Number.isInteger(c.startIdx) ? c.startIdx : pointIndexFromRef(c.start);
                    const endIdx = Number.isInteger(c.endIdx) ? c.endIdx : pointIndexFromRef(c.end);
                    const start = pts[startIdx];
                    const end = pts[endIdx];
                    return start && end ? { start, end, type: c.type, manualType: !!c.manualType } : null;
                }).filter(Boolean)
                : [];
            let restoredManualFaces = [];
            if (Array.isArray(savedGeometry.manualFaces)) {
                restoredManualFaces = savedGeometry.manualFaces.map(mf => {
                    const facePoints = pointsFromRefs(mf.pointIndices, mf.points);
                    const holes = holesFromRefs(mf.holeIndices, mf.holes);
                    return { layer: mf.layer, points: facePoints, holes: holes };
                }).filter(face => face.points.length >= 3);
            }
            let restoredResolvedFaces = [];
            if (Array.isArray(savedGeometry.resolvedFaces)) {
                restoredResolvedFaces = savedGeometry.resolvedFaces.map(rf => {
                    const facePoints = pointsFromRefs(rf.pointIndices, rf.points);
                    const holes = holesFromRefs(rf.holeIndices, rf.holes);
                    return { layer: rf.layer, points: facePoints, holes: holes };
                }).filter(face => face.points.length >= 3);
            }
            if (typeof deletedFaceSignatures !== 'undefined') {
                deletedFaceSignatures.clear(); 
                if (savedGeometry.deletedFaceSignatures) savedGeometry.deletedFaceSignatures.forEach(sig => deletedFaceSignatures.add(sig));
            }
            activeGeometry = { points: pts, connections: conns, vents: savedGeometry.vents || [], manualFaces: restoredManualFaces };
            if (typeof window.unlockRoofFeaturePointHeights === 'function') {
                window.unlockRoofFeaturePointHeights(activeGeometry);
            }
            if (typeof lastResolvedFacesCache !== 'undefined') {
                lastResolvedFacesCache = restoredResolvedFaces.length ? restoredResolvedFaces : restoredManualFaces.slice();
            }
            if (typeof window !== 'undefined') {
                window.lastResolvedFacesCache = (typeof lastResolvedFacesCache !== 'undefined' && Array.isArray(lastResolvedFacesCache))
                    ? lastResolvedFacesCache
                    : (restoredResolvedFaces.length ? restoredResolvedFaces : restoredManualFaces.slice());
            }
            geometryWasRestored = true;
        } else {
            activeGeometry = { points: [], connections: [], vents: [] };
        }

        if (viewCanvases['ai_geo']) {
            hasGeoImage = true;
            document.getElementById('btnReprocess').disabled = false;
            if (!viewConfigs.find(c => c.id === 'ai_geo')) viewConfigs.push({ id: 'ai_geo', label: 'AI Geometry Map' });
            const geoImg = new Image();
            geoImg.onload = () => {
                cachedGeoImage = geoImg;
                if (autoRunGemini && !geometryWasRestored && (!activeGeometry || activeGeometry.points.length === 0)) {
                    runGeometryAnalysis(geoImg);
                    if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
                    if (typeof renderGeometry2D === 'function') renderGeometry2D();
                } else {
                    if (typeof renderGeometry2D === 'function') renderGeometry2D();
                }
            };
            geoImg.src = viewCanvases['ai_geo'].toDataURL();
        }

        if (!layerData.dsm && imageWidth > 0 && imageHeight > 0) {
            const totalPixels = imageWidth * imageHeight;
            layerData.dsm = [new Float32Array(totalPixels).fill(0)];
        }
        if (!layerData.rgb && viewCanvases['solar'] && imageWidth > 0 && imageHeight > 0) {
            const ctx = viewCanvases['solar'].getContext('2d');
            const iData = ctx.getImageData(0, 0, imageWidth, imageHeight);
            const d = iData.data;
            const count = imageWidth * imageHeight;
            const r = new Uint8Array(count), g = new Uint8Array(count), b = new Uint8Array(count);
            for (let i = 0; i < count; i++) { r[i]=d[i*4]; g[i]=d[i*4+1]; b[i]=d[i*4+2]; }
            layerData.rgb = [r, g, b];
        }

        setupView();        
        if (typeof window.firstMeasureRenderCustomerReworkPrompt === 'function') {
            window.firstMeasureRenderCustomerReworkPrompt(manifest);
        }
        if (layerData.rgb && layerData.dsm) init3D();           
        buildThumbGrid();   
        redrawThumbs();     
        selectView(meta.currentViewId || 'solar');
        
        if (googleJsMap) {
            const lat = parseFloat(mapCenterLat), lng = parseFloat(mapCenterLng);
            if (!isNaN(lat) && !isNaN(lng)) {
                googleJsMap.setCenter({ lat: lat, lng: lng });
                googleJsMap.setZoom(20);
            }
        }
        switchMapLayer(window.__quadIsDefault ? 'quad' : 'google'); 
        if (cesiumViewer) cesiumViewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(mapCenterLng, mapCenterLat, 200) });

        // --- NEW: RESTORE UI STATE & MEASUREMENTS ---
        
        if (activeGeometry && typeof recalculateMeasurementData === 'function') {
            recalculateMeasurementData();
        }

        if (meta.uiState) {
            restoreUIState(meta.uiState);
        }

        // --- FIX: FORCE INITIAL FACE GENERATION (SILENT) ---
        if (activeGeometry) {
            // 1. Initialize mutation tracking
            window.__geoMutStamp = Date.now();
            window.__facesLastRenderedStamp = 0;

            // 2. Immediate Lightweight Render (Lines/Points)
            if (typeof renderGeometry2D === 'function') renderGeometry2D();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();

            // 3. Trigger Face Rendering (Silent, no loader)
            // Replaced explicit processAndRenderAllLayers with triggerLiveUpdate
            if (typeof triggerLiveUpdate === 'function') {
                triggerLiveUpdate();
            }
        }
        
        if (typeof redrawCanvas === 'function') redrawCanvas();
        prefetchAppleLayerInBackground();
        scheduleDeferredProjectTiffLoad(requestedProjectId, deferredTiffAssets, {
            ensureMissingMask: ensureMissingMaskAfterPaint
        });
        if (typeof window.scheduleStructureSupplementalPreload === 'function') {
            window.scheduleStructureSupplementalPreload();
        }

        console.log("Project loaded.");

        // --- AUTO-OPEN REPORT CONFIG IN FULLSCREEN WHEN ?branding=1 ---
        const _brandingParams = new URLSearchParams(window.location.search);
        if (_brandingParams.get('branding') === '1') {
            // Small delay to let all renderers settle before opening report panel
            setTimeout(async () => {
                try {
                    if (typeof openReportConfiguration === 'function') {
                        await openReportConfiguration();
                    }
                    // Force fullscreen if not already
                    if (!isReportFullscreen && typeof toggleReportFullscreen === 'function') {
                        toggleReportFullscreen();
                    }
                } catch (e) {
                    console.warn('[Branding] Auto-open report config failed:', e);
                }
            }, 800);
        }

    } catch (e) {
        console.error(e);
        alert("Load Error: " + e.message);
    }
}

// Helper to restore UI buttons/panels
function restoreUIState(state) {
    // A. Measurement Overlay (Lengths)
    if (typeof showMeasurementsLayer !== 'undefined') {
        showMeasurementsLayer = !!state.showMeasurementsLayer;
        const btn = document.getElementById('btnToggleMeasure');
        if(btn) {
            if(showMeasurementsLayer) {
                btn.classList.add('active');
                btn.style.background = '#e8f0fe';
                btn.style.color = '#1a73e8';
                btn.style.borderColor = '#1a73e8';
            } else {
                btn.classList.remove('active');
                btn.style.background = '#fff';
                btn.style.color = '#5f6368';
                btn.style.borderColor = '#ccc';
            }
        }
    }

    // B. Measurement Sidebar (Line Types)
    if (state.isMeasurementMode) {
        if (typeof enterMeasurementMode === 'function') enterMeasurementMode();
    } else {
        // Ensure sidebar is closed if saved state was closed
        if (typeof exitMeasurementMode === 'function') exitMeasurementMode();
    }

    // C. Faces
    if (typeof showFacesLayer !== 'undefined' && typeof toggleFacesGlobal === 'function') {
        toggleFacesGlobal(!!state.showFacesLayer);
    }

    // D. Grid
    if (typeof showGridLayer !== 'undefined') {
        // Force the state
        showGridLayer = !state.showGridLayer; // Toggle flips it, so set inverse first
        if (typeof toggleGridDisplay === 'function') toggleGridDisplay(); 
    }
}






// --- REPLACE EXISTING toggleFacesGlobal FUNCTION ---

window.toggleFacesGlobal = function(forceState = null) {
    // 1. Update State
    if (forceState !== null) {
        showFacesLayer = forceState;
    } else {
        showFacesLayer = !showFacesLayer;
    }

    // 2. Update Button UI
    const btn = document.getElementById('btnToggleFaces');
    if(btn) {
        if(showFacesLayer) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8';
            btn.style.borderColor = '#1a73e8';
        } else {
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
        }
    }

    // 3. Toggle 3D Group Visibility
    if (typeof facesGroup !== 'undefined' && facesGroup) {
        facesGroup.visible = showFacesLayer;
    }

    // 4. Toggle 2D SVG Visibility
    const svgFaces = document.querySelectorAll('.generated-face');
    svgFaces.forEach(el => {
        el.style.display = showFacesLayer ? 'block' : 'none';
    });

    // 5. Trigger calculation if turning ON for the first time (and empty)
    // if (showFacesLayer && typeof facesGroup !== 'undefined' && facesGroup && facesGroup.children.length === 0 && activeGeometry) {
    //     if (typeof processAndRenderAllLayers === 'function') processAndRenderAllLayers();
    // }
}


function toggleLineTypes() {
    // Check if Measurement Mode is currently active (variable from measurements.js)
    if (typeof isMeasurementMode !== 'undefined' && isMeasurementMode) {
        // If ON, turn it OFF
        if (typeof exitMeasurementMode === 'function') {
            exitMeasurementMode();
        }
    } else {
        // If OFF, turn it ON
        // Check if we have measurement data (lastRoofReport global)
        if (typeof lastRoofReport !== 'undefined' && lastRoofReport) {
            // Data exists, just open the UI
            if (typeof enterMeasurementMode === 'function') {
                enterMeasurementMode();
            }
        } else {
            // No data yet, generate it (this will call enterMeasurementMode when done)
            if (typeof handleGenerateMeasurements === 'function') {
                handleGenerateMeasurements();
            }
        }
    }
}

function toggleSnapMode() {
    // Logic: Toggle the underlying free move variable
    isFreeMove = !isFreeMove; // If Snap is ON (false), click makes it OFF (true)

    // Update Button UI
    updateSnapButtonUI();
    
    // Hide indicator immediately if turning off snap
    const snapInd = document.getElementById('snap-indicator');
    if(snapInd && isFreeMove) snapInd.style.display = 'none';
}

function updateSnapButtonUI() {
    const btn = document.getElementById('btnToggleSnap');
    if(btn) {
        // UI Logic: If FreeMove is FALSE, Snap is ON (Active/Blue)
        if(!isFreeMove) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8';
            btn.style.borderColor = '#1a73e8';
            btn.title = "Snapping ON (Press F to toggle)";
        } else {
            // Snap is OFF (Inactive/White)
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
            btn.title = "Snapping OFF (Free Mode)";
        }
    }
}



/* main.js */

async function handleLoadNextInQueue() {
    const btn = document.getElementById('btnLoadNext');
    if(btn) btn.disabled = true;

    // 1. Get the current address currently on screen
    const currentInput = document.getElementById('addressInput');
    const currentAddr = currentInput ? currentInput.value : '';

    try {
        if (typeof window.firstMeasureClaimNextCompat !== 'function') {
            throw new Error("FirstMeasure queue helper is unavailable.");
        }
        const data = await window.firstMeasureClaimNextCompat();
        
        if (data.found) {
            console.log(`Loading next: ${data.address}`);
            
            if(currentInput) currentInput.value = data.address;
            
            // Load the new project
            loadProjectFromFolder(data.folder);
        } else {
            console.log("No new items in queue.");
            // Optional: alert only if manually clicked, not if auto-loading
            if (btn) alert("No unprocessed items in queue!");
        }
    } catch (e) {
        console.error(e);
        alert("Error checking queue: " + e.message);
    } finally {
        if(btn) btn.disabled = false;
    }
}




/* --- TESTING UTILITY --- */
/* Paste this at the bottom of main.js */

window.saveAndTestReport = async function() {
    console.log("%c🧪 STARTING TEST: FORCE DOWNLOAD MODE", "color: #ff9800; font-weight: bold;");

    // 1. Save Project Data (Soft Fail)
    // We attempt to save, but if it fails (413 Too Large), we LOG it and CONTINUE anyway.
    console.log("Step 1: Attempting to Save Project Data...");
    try {
        if (typeof window.saveProjectData === 'function') {
            const saveResult = await window.saveProjectData(true);
            if (!saveResult) {
                console.warn("⚠️ Save failed (likely 413 or Network). Ignoring and proceeding to PDF...");
            } else {
                console.log("✅ Project Saved.");
            }
        }
    } catch (e) {
        console.warn("⚠️ Exception during Save (Ignored):", e);
    }

    // 2. Capture Report State
    console.log("Step 2: Capturing Data...");
    if (typeof captureStateForPDF !== 'function') {
        console.error("❌ captureStateForPDF missing");
        return;
    }
    const state = await captureStateForPDF();
    if (!state) return;

    // 3. INTERCEPT SERVER CALLS
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        // A. BLOCK project status updates (So it stays in queue)
        if ((typeof input === 'string' && input.includes('/status')) && 
            init && init.method === 'POST') {
            
            if (true) {
                console.log("%c🛑 TEST MODE: Blocked 'set_status'.", "color: cyan; font-weight:bold;");
                return new Response(JSON.stringify({ success: true, ok: true }), { status: 200 });
            }
        }

        // B. HANDLE 413 ERRORS GRACEFULLY
        try {
            const response = await originalFetch.apply(this, arguments);
            
            // If the server says "Content Too Large", we lie to the script and say "It's OK"
            // This ensures report.js continues executing to the doc.save() line.
            if (response.status === 413) {
                console.warn("   ⚠️ Server returned 413 (Content Too Large). Fake success returned to script to force download.");
                return new Response(JSON.stringify({ success: true, warning: "Fake Success for 413" }), { 
                    status: 200, 
                    headers: { 'Content-Type': 'application/json' } 
                });
            }
            return response;
        } catch (err) {
            console.error("Fetch Network Error (Ignored):", err);
            // Return fake success on network error too
            return new Response(JSON.stringify({ success: false }), { status: 200 });
        }
    };

    // 4. Generate PDF
    console.log("Step 3: Generating PDF...");
    try {
        await generatePDFFromState(state, (status) => console.log(`   📄 PDF Status: ${status}`));
        console.log("%c✅ TEST COMPLETE. Check your downloads.", "color: #00ff00; font-weight: bold;");
    } catch (e) {
        console.error("❌ PDF Generation Error:", e);
    } finally {
        // 5. RESTORE FETCH
        window.fetch = originalFetch;
    }
};


/**
 * Recenters both the Google JS Map and the Cesium 3D viewer 
 * to the current roof coordinates.
 */
function recenterMap() {
    if (!mapCenterLat || !mapCenterLng) {
        console.warn("No coordinates found to recenter to.");
        return;
    }

    const coords = { lat: parseFloat(mapCenterLat), lng: parseFloat(mapCenterLng) };

    // 1. Recenter Google Maps JS
    if (googleJsMap) {
        googleJsMap.setCenter(coords);
        googleJsMap.setZoom(20);
        googleJsMap.setTilt(45);
        googleJsMap.setHeading(0);
    }

    // 2. Recenter Cesium Viewer
    if (cesiumViewer) {
        const center = Cesium.Cartesian3.fromDegrees(coords.lng, coords.lat, 0);
        const offset = new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(0), 
            Cesium.Math.toRadians(-45), 
            100 // Distance in meters
        );
        
        cesiumViewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(coords.lng, coords.lat, 150),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-45),
                roll: 0.0
            },
            duration: 1.5 // Smooth animation
        });
    }
}


function setupLocationAdjustmentUI() {
    const existing = document.getElementById('location-adjust-container');
    if (existing) existing.remove();
}

function resetSliderBounds() {
    const range = 0.001; // Roughly 111 meters
    const latSld = document.getElementById('adjLatSlider');
    const lngSld = document.getElementById('adjLngSlider');
    
    // CRITICAL FIX: Force parseFloat so '+' does addition instead of concatenation
    const baseLat = parseFloat(mapCenterLat);
    const baseLng = parseFloat(mapCenterLng);

    if (latSld) {
        latSld.min = (baseLat - range).toFixed(7);
        latSld.max = (baseLat + range).toFixed(7);
        latSld.value = baseLat; // Ensure thumb is centered
    }
    if (lngSld) {
        lngSld.min = (baseLng - range).toFixed(7);
        lngSld.max = (baseLng + range).toFixed(7);
        lngSld.value = baseLng; // Ensure thumb is centered
    }
}

function resetToCurrentCenter() {
    adjustState.lat = mapCenterLat;
    adjustState.lng = mapCenterLng;
    resetSliderBounds();
    updateLocationInputs();
    renderGeometry2D();
}

function updateLocationInputs() {
    const latInp = document.getElementById('adjLat');
    const latSld = document.getElementById('adjLatSlider');
    const lngInp = document.getElementById('adjLng');
    const lngSld = document.getElementById('adjLngSlider');
    const radInp = document.getElementById('adjRad');
    const radVal = document.getElementById('adjRadVal');

    if (latInp) latInp.value = adjustState.lat;
    if (latSld) latSld.value = adjustState.lat;
    if (lngInp) lngInp.value = adjustState.lng;
    if (lngSld) lngSld.value = adjustState.lng;
    if (radInp) radInp.value = adjustState.radius;
    if (radVal) radVal.innerText = adjustState.radius + 'm';
}


function updateLocationInputs() {
    document.getElementById('adjLat').value = adjustState.lat;
    document.getElementById('adjLng').value = adjustState.lng;
    document.getElementById('adjRad').value = adjustState.radius;
    document.getElementById('adjRadVal').innerText = adjustState.radius + 'm';
}


async function handleRegenerateFromNewCenter() {
  if (!activeGeometry) return;

  const btn = document.getElementById('btnReloadSolar');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading New Data...';

  try {
    // --- STEP 1: CONVERT PIXELS TO REAL WORLD (LAT/LNG) ---
    const oldLat = parseFloat(mapCenterLat);
    const oldLng = parseFloat(mapCenterLng);

    // ✅ Use the real active radius (not the const)
    const oldRad = (window.getRadiusMeters ? window.getRadiusMeters() : parseFloat(window.RADIUS_METERS || 20));

    const oldW = imageWidth;
    const oldH = imageHeight;

    const mLat = 111132;
    const mLng = 111132 * Math.cos(oldLat * (Math.PI / 180));
    const oldMetersPerPx = (oldRad * 2) / oldW;

    activeGeometry.points.forEach(pt => {
      const dxMeters = (pt.x - oldW / 2) * oldMetersPerPx;
      const dyMeters = (oldH / 2 - pt.y) * oldMetersPerPx;
      pt.realLng = oldLng + (dxMeters / mLng);
      pt.realLat = oldLat + (dyMeters / mLat);
    });

    if (activeGeometry.vents) {
      activeGeometry.vents.forEach(v => {
        const dxMeters = (v.x - oldW / 2) * oldMetersPerPx;
        const dyMeters = (oldH / 2 - v.y) * oldMetersPerPx;
        v.realLng = oldLng + (dxMeters / mLng);
        v.realLat = oldLat + (dyMeters / mLat);
      });
    }

    // --- STEP 2: UPDATE GLOBALS ---
    mapCenterLat = adjustState.lat;
    mapCenterLng = adjustState.lng;

    // ✅ This is the key: update the global radius AND persist it into layer_config
    if (window.setRadiusMeters) window.setRadiusMeters(adjustState.radius);
    else window.RADIUS_METERS = adjustState.radius;

    // --- STEP 3: FETCH NEW DATA ---
    viewCanvases = {};
    adjustedViewCanvases = {};
    const prevW = imageWidth;
    imageWidth = 0;

    await fetchAllLayersWithRadius(mapCenterLat, mapCenterLng, window.getRadiusMeters ? window.getRadiusMeters() : window.RADIUS_METERS);
    await fetchStaticMap(mapCenterLat, mapCenterLng);

    if (imageWidth === 0) imageWidth = prevW;

    // --- STEP 4: MAP LAT/LNG BACK TO NEW PIXEL SPACE ---
    const newMLng = 111132 * Math.cos(mapCenterLat * (Math.PI / 180));
    const newMetersPerPx = ((window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20)) * 2) / imageWidth;

    const projectToNewPixels = (item) => {
      const newDx = (item.realLng - mapCenterLng) * newMLng;
      const newDy = (item.realLat - mapCenterLat) * mLat;
      item.x = (imageWidth / 2) + (newDx / newMetersPerPx);
      item.y = (imageHeight / 2) - (newDy / newMetersPerPx);
      delete item.realLat;
      delete item.realLng;
    };

    activeGeometry.points.forEach(projectToNewPixels);
    if (activeGeometry.vents) activeGeometry.vents.forEach(projectToNewPixels);

    // --- STEP 5: REFRESH VIEWS ---
    setupView();
    init3D();
    rebuildViewConfigs();
    buildThumbGrid();
    redrawThumbs();

    if (layerData.dsm) {
      optimizeElevationFromGeomery(activeGeometry, layerData.dsm[0], imageWidth, imageHeight);
    }

    isAdjustingLocation = false;
    const adjustPanel = document.getElementById('location-adjust-panel');
    if (adjustPanel) adjustPanel.style.display = 'none';
    if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();

    // ✅ If measurement mode already exists, force recalculation so labels update immediately
    if (typeof recalculateMeasurementData === 'function' && typeof lastRoofReport !== 'undefined') {
      recalculateMeasurementData();
      if (typeof isMeasurementMode !== 'undefined' && isMeasurementMode && typeof updateMeasurementUI === 'function') {
        updateMeasurementUI();
      }
    }

  } catch (e) {
    console.error(e);
    alert("Regeneration failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Regenerate Views';
  }
}

/**
 * Silently prefetch Apple Maps tiles in the background.
 * Stores a promise so selectView('apple') can await it if the user
 * clicks before the fetch completes.
 */
function waitForApplePrefetchCanvasTarget(timeoutMs = 20000) {
  if (Number.isFinite(imageWidth) && imageWidth > 0 && Number.isFinite(imageHeight) && imageHeight > 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (Number.isFinite(imageWidth) && imageWidth > 0 && Number.isFinite(imageHeight) && imageHeight > 0) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function isApplePrefetchCurrent(runId, projectId) {
  return runId === _applePrefetchRunId && (!projectId || window.currentProjectId === projectId);
}

async function bakePrefetchedAppleLayer(result, tileZoom, runId, projectId) {
  if (!result || !result.canvas || !isApplePrefetchCurrent(runId, projectId)) return false;
  if (viewCanvases.apple || layerData.apple) return true;

  const hasTarget = await waitForApplePrefetchCanvasTarget();
  if (!hasTarget || !isApplePrefetchCurrent(runId, projectId)) return false;
  if (viewCanvases.apple || layerData.apple) return true;

  const stitchedCanvas = result.canvas;

  if (projectId && window.currentProjectId === projectId) {
    if (isApplePrefetchCurrent(runId, projectId)) {
      await trySaveProjectCanvasArtifact('apple.png', stitchedCanvas, {
        type: 'image/jpeg',
        quality: 0.86,
        maxDimension: 4096
      });
    }
  }

  const cfg = ensureLayerCfg('apple');
  cfg.x = result.offX;
  cfg.y = result.offY;
  cfg.__zoom = tileZoom;

  if (typeof setLayerScaleToMatchSolar === 'function') {
    setLayerScaleToMatchSolar('apple', tileZoom, stitchedCanvas.width, imageWidth);
  }

  const projectCanvas = document.createElement("canvas");
  projectCanvas.width = imageWidth;
  projectCanvas.height = imageHeight;
  const ctx = projectCanvas.getContext("2d");
  drawScaledImage(
    ctx,
    stitchedCanvas,
    imageWidth,
    imageHeight,
    cfg.scale,
    cfg.x,
    cfg.y,
    cfg.rot || 0,
    cfg.fineScale || 1.0
  );

  const rawImg = new Image();
  rawImg.src = stitchedCanvas.toDataURL("image/png");
  await new Promise((resolve, reject) => {
    rawImg.onload = resolve;
    rawImg.onerror = reject;
  });

  if (!isApplePrefetchCurrent(runId, projectId)) return false;
  layerData.apple = rawImg;
  viewCanvases.apple = projectCanvas;
  redrawThumbs();

  console.log("[AppleMaps] Background prefetch complete.");
  if (typeof window.saveProjectData === 'function') {
    window.saveProjectData(true, true);
  }
  return true;
}

function prefetchAppleLayerInBackground(_opts = {}) {
  if (viewCanvases.apple || layerData.apple || _applePrefetchPromise) return _applePrefetchPromise;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const effectiveType = connection && connection.effectiveType ? String(connection.effectiveType).toLowerCase() : '';
  if (!_opts.force && connection && (connection.saveData || effectiveType === 'slow-2g' || effectiveType === '2g')) {
    console.info('[AppleMaps] Skipping background prefetch on a constrained connection.');
    return null;
  }

  const lat0 = parseFloat(mapCenterLat);
  const lng0 = parseFloat(mapCenterLng);
  if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) return null;

  const solarRad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
  const baseSolar = 20;
  const baseTileRadius = 3;
  const factor = Math.max(1, solarRad / baseSolar);
  const tileRadius = Math.max(1, Math.round(baseTileRadius * factor));
  if (!_opts.allowLarge && tileRadius > 12) {
    console.info(`[AppleMaps] Skipping background prefetch for large radius (${solarRad}m, tile radius ${tileRadius}).`);
    return null;
  }

  const runId = _applePrefetchRunId;
  const projectId = window.currentProjectId || null;

  _applePrefetchPromise = (async () => {
    try {
      const tileZoom = 22;

      let accessKey = await getAppleAccessKey({ forceRefresh: true });
      if (!accessKey || !isApplePrefetchCurrent(runId, projectId)) return false;

      const attemptWithKey = async (key) => {
        const result = await fetchStitchedAppleTile(lat0, lng0, tileRadius, tileZoom, key);
        if (!result || !result.canvas) throw new Error("Stitching returned null.");
        return result;
      };

      let result;
      try {
        result = await attemptWithKey(accessKey);
      } catch (e) {
        if (e && e.message === "ACCESS_DENIED") {
          localStorage.removeItem("apple_maps_key");
          localStorage.removeItem("apple_maps_key_updated_at_utc");
          const freshKey = await getAppleAccessKey({ forceRefresh: true });
          if (!freshKey || !isApplePrefetchCurrent(runId, projectId)) return false;
          result = await attemptWithKey(freshKey);
          accessKey = freshKey;
        } else {
          throw e;
        }
      }

      return await bakePrefetchedAppleLayer(result, tileZoom, runId, projectId);
    } catch (e) {
      console.warn("[AppleMaps] Background prefetch failed (non-blocking):", e && e.message ? e.message : e);
      if (e && e.message === "ACCESS_DENIED") {
        localStorage.removeItem("apple_maps_key");
        localStorage.removeItem("apple_maps_key_updated_at_utc");
      }
      return false;
    } finally {
      if (isApplePrefetchCurrent(runId, projectId)) {
        _applePrefetchPromise = null;
      }
    }
  })();

  return _applePrefetchPromise;
}

/* maps.js (DROP-IN REPLACEMENT) */
async function handleAppleLayerFetch() {
  const lat0 = parseFloat(mapCenterLat);
  const lng0 = parseFloat(mapCenterLng);
  if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) {
    alert("Apple Maps: missing coordinates. Load/Analyze the address first.");
    selectView('solar');
    return;
  }

  const zoomLayer = document.getElementById('zoom-layer');
  const originalContent = zoomLayer.innerHTML;
  zoomLayer.innerHTML =
    '<div style="padding:50px; text-align:center; color:#1a73e8;">Fetching Apple Maps Tiles...</div>';

  // ✅ Scale stitch radius with Solar radius (baseline: 20m => tileRadius 3)
  const solarRad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
  const baseSolar = 20;
  const baseTileRadius = 3; // your current working value
  const factor = Math.max(1, solarRad / baseSolar);
  const tileRadius = Math.max(1, Math.round(baseTileRadius * factor)); // 60m => 9

  const tileZoom = 22;

  const attemptWithKey = async (accessKey) => {
    const result = await fetchStitchedAppleTile(lat0, lng0, tileRadius, tileZoom, accessKey);
    if (!result || !result.canvas) throw new Error("Stitching returned null.");
    return result;
  };

  try {
    let accessKey = await getAppleAccessKey({ forceRefresh: true });
    if (!accessKey) {
      zoomLayer.innerHTML = originalContent;
      setupView();
      selectView('solar');
      return;
    }

    let result;
    try {
      result = await attemptWithKey(accessKey);
    } catch (e) {
      if (e && e.message === "ACCESS_DENIED") {
        localStorage.removeItem("apple_maps_key");
        localStorage.removeItem("apple_maps_key_updated_at_utc");
        const freshKey = await getAppleAccessKey({ forceRefresh: true });
        if (!freshKey) throw e;
        result = await attemptWithKey(freshKey);
        accessKey = freshKey;
      } else {
        throw e;
      }
    }

    const stitchedCanvas = result.canvas;
    const autoOffsetX = result.offX;
    const autoOffsetY = result.offY;

    // In structure mode, keep the full local Apple capture. For the global view,
    // cache a capped image so very large all-structure stitches do not block use.
    if (window.currentProjectId) {
      const structureIdx = Number(window.__activeStructureSupplementalIndex);
      if (window.__structureLocalImageryActive && Number.isInteger(structureIdx) && structureIdx > 0) {
        const rawBlob = await new Promise((r) => stitchedCanvas.toBlob(r, "image/png"));
        await saveProjectArtifactBlob(`structure-${structureIdx}-apple.png`, rawBlob);
      } else {
        await trySaveProjectCanvasArtifact('apple.png', stitchedCanvas, {
          type: 'image/jpeg',
          quality: 0.86,
          maxDimension: 4096
        });
      }
    }

    // ✅ Preserve existing cfg fields (rot/fineScale/__zoom)
    const cfg = ensureLayerCfg('apple');
    cfg.x = autoOffsetX;
    cfg.y = autoOffsetY;
    cfg.__zoom = tileZoom;

    // ✅ Make Apple meters/px match Solar meters/px
    if (typeof setLayerScaleToMatchSolar === 'function') {
      setLayerScaleToMatchSolar('apple', tileZoom);
    }

    // Bake into current Solar-sized canvas
    const projectCanvas = document.createElement("canvas");
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext("2d");

    drawScaledImage(
      ctx,
      stitchedCanvas,
      imageWidth,
      imageHeight,
      cfg.scale,
      cfg.x,
      cfg.y,
      cfg.rot || 0,
      cfg.fineScale || 1.0
    );

    // Cache raw image + baked view
    const rawImg = new Image();
    rawImg.src = stitchedCanvas.toDataURL("image/png");
    await new Promise((r) => (rawImg.onload = r));
    layerData.apple = rawImg;
    viewCanvases["apple"] = projectCanvas;

    zoomLayer.innerHTML = originalContent;
    setupView();
    selectView("apple");

    await window.saveProjectData(true, true);
  } catch (e) {
    console.error("[AppleMaps] Error:", e);
    zoomLayer.innerHTML = originalContent;
    setupView();

    if (e && e.message === "ACCESS_DENIED") {
      localStorage.removeItem("apple_maps_key");
      localStorage.removeItem("apple_maps_key_updated_at_utc");
      alert("Apple Maps Access Denied. The key may be invalid or expired.");
      selectView("solar");
    } else {
      alert("Failed to fetch Apple Maps layer. Check console.");
      selectView("solar");
    }
  }
}


async function ensureRoofMaskLoaded() {
    if (roofMaskData && roofMaskData.length === imageWidth * imageHeight) return true;
    if (!mapCenterLat || !mapCenterLng) return false;

    try {
        if (window.currentProjectId && typeof fetchAndAttachProjectMask === 'function') {
            const attached = await fetchAndAttachProjectMask(window.currentProjectId);
            if (attached) return true;
        }

        const rad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || RADIUS_METERS || 20));
        const pixelSize = window.getSolarPixelSizeMeters ? window.getSolarPixelSizeMeters(rad) : 0.1;
        const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${mapCenterLat}&location.longitude=${mapCenterLng}&radius_meters=${rad}&view=FULL_LAYERS&requiredQuality=LOW&pixelSizeMeters=${pixelSize}&key=${GOOGLE_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.maskUrl) return false;

        const r = await fetch(data.maskUrl + `&key=${GOOGLE_API_KEY}`);
        const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
        const img = await tiff.getImage();
        const rasters = await img.readRasters();
        layerData.mask = rasters;

        roofMaskData = rasters && rasters[0] ? rasters[0] : null;
        maskedViewCanvases = {};

        console.log("[RoofMask] Re-fetched mask for loaded project:", !!roofMaskData);
        return !!roofMaskData;
    } catch (e) {
        console.warn("[RoofMask] Failed to refetch mask:", e);
        return false;
    }
}

async function fetchAndAttachProjectMask(folderHash) {
    try {
        if (typeof window.firstMeasureFetchJson !== 'function') {
            throw new Error('FirstMeasure API helper is unavailable.');
        }
        const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(folderHash)}/mask/ensure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!data || !data.success || !data.url) return false;

        const r = await fetch(data.url);
        const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
        const img = await tiff.getImage();
        const rasters = await img.readRasters();

        layerData.mask = rasters;
        roofMaskData = rasters && rasters[0] ? rasters[0] : null;
        maskedViewCanvases = {}; // invalidate cached masked canvases

        console.log('[RoofMask] Fetched+attached missing mask.tif:', !!roofMaskData);
        return !!roofMaskData;
    } catch (e) {
        console.warn('[RoofMask] fetchAndAttachProjectMask failed:', e);
        return false;
    }
}

function getCurrentProjectAddressForMaps() {
    const ids = ['manualAddressLocked', 'manualAddress', 'addressInput'];
    for (const id of ids) {
        const el = document.getElementById(id);
        const value = (el && el.value ? el.value : '').trim();
        if (value && value !== '...') return value;
    }
    return '';
}

function getAppleMapsDisplayName(address) {
    const firstLine = String(address || '').split(',')[0].trim();
    return firstLine || String(address || '').trim();
}

function openGoogleEarth() {
    // 1. Get address from manual input (visible/locked) or hidden input
    let address = getCurrentProjectAddressForMaps();

    if (!address) {
        alert("No address currently loaded.");
        return;
    }

    // 2. Construct URL based on the requested structure
    const encoded = encodeURIComponent(address);
    const url = `https://earth.google.com/web/search/${encoded}`;

    // 3. Open in new tab
    window.open(url, '_blank');
}

function openStreetView() {
    // 1. Get address
    let address = getCurrentProjectAddressForMaps();

    // 2. Prioritize Coordinates if available (Global vars from main.js) for exact positioning
    if (typeof mapCenterLat !== 'undefined' && typeof mapCenterLng !== 'undefined' && mapCenterLat && mapCenterLng) {
        // Opens Street View triggering looking at the specific coordinate
        const url = `https://www.google.com/maps?layer=c&cbll=${mapCenterLat},${mapCenterLng}`;
        window.open(url, '_blank');
    } 
    else if (address) {
        // Fallback to address search if no coordinates loaded yet
        const encoded = encodeURIComponent(address);
        // layer=c triggers street view overlay availability
        const url = `https://www.google.com/maps/search/?api=1&query=${encoded}&layer=c`;
        window.open(url, '_blank');
    } else {
        alert("No address or location loaded.");
    }
}

function openAppleStreetView() {
    const address = getCurrentProjectAddressForMaps();
    const params = new URLSearchParams();
    if (address) {
        params.set('address', address);
        params.set('name', getAppleMapsDisplayName(address));
    }
    if (typeof mapCenterLat !== 'undefined' && typeof mapCenterLng !== 'undefined' && mapCenterLat && mapCenterLng) {
        params.set('coordinate', `${mapCenterLat},${mapCenterLng}`);
    }

    if (params.has('address') || params.has('coordinate')) {
        window.open(`https://maps.apple.com/look-around?${params.toString()}`, '_blank');
    } else if (address) {
        const encoded = encodeURIComponent(address);
        const url = `https://maps.apple.com/look-around?address=${encoded}`;
        window.open(url, '_blank');
    } else {
        alert("No address or location loaded.");
    }
}

// --- WebMercator global pixel coords at given zoom ---
function latLngToGlobalPx(lat, lng, zoom, tileSize = 256) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const n = Math.pow(2, zoom);

  const x = ((lng + 180) / 360) * n * tileSize;

  // clamp to prevent infinity at poles
  const y =
    (0.5 -
      Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) *
    n *
    tileSize;

  return { x, y };
}

/**
 * Returns the pixel shift introduced by "centering to integer pixel".
 * Positive dx means the returned image's true center is to the RIGHT of your requested center,
 * so to align to your requested center you want to shift the image LEFT by dx.
 */
function staticMapRoundingOffsetPx(lat, lng, zoom, scale = 1) {
  const { x, y } = latLngToGlobalPx(lat, lng, zoom, 256);

  // Most likely behavior: integer pixel snapping
  const rx = Math.round(x);
  const ry = Math.round(y);

  // convert to output pixel space (scale=2 doubles pixels)
  return {
    dx: (rx - x) * scale,
    dy: (ry - y) * scale
  };
}

/**
 * Apply rounding correction to your layer config.
 * We add this to cfg.x/cfg.y because your drawScaledImage uses sourceX/sourceY offsets.
 */
function applyStaticRoundingCorrectionToLayer(layerId, lat, lng, zoom, scale = 1) {
  const off = staticMapRoundingOffsetPx(lat, lng, zoom, scale);

  if (!LAYER_CONFIG[layerId]) LAYER_CONFIG[layerId] = { scale: 1.0, x: 0, y: 0 };

  // IMPORTANT SIGN:
  // drawScaledImage adds offX/offY to source crop origin.
  // If the returned image center is shifted +dx (right), you need to sample source more to the right
  // to pull the image LEFT visually. That means ADD dx to sourceX => ADD to cfg.x.
  LAYER_CONFIG[layerId].x += off.dx;
  LAYER_CONFIG[layerId].y += off.dy;

  console.log(`[${layerId}] Applied Static rounding correction dx=${off.dx.toFixed(2)} dy=${off.dy.toFixed(2)}`);
}



function invalidateViewCanvas(viewId) {
  if (viewCanvases && viewCanvases[viewId]) delete viewCanvases[viewId];
  if (adjustedViewCanvases && adjustedViewCanvases[viewId]) delete adjustedViewCanvases[viewId];
  if (maskedViewCanvases && maskedViewCanvases[viewId]) delete maskedViewCanvases[viewId];
}

function rebuildBaseViewCanvas(viewId) {
  invalidateViewCanvas(viewId);
  ensureViewCanvas(viewId);

  redrawThumbs();

  if (currentViewId === viewId) {
    refreshMaskImageData();
    redrawCanvas();
    if (typeof update3DTextureForView === 'function') update3DTextureForView();
    if (typeof update3DCrop === 'function') update3DCrop();
  }
}

function getAdjustableLayersList() {
  // "height" is ground-truth -> never adjustable
  // "solar" is ground-truth reference -> never adjustable
  const base = ['google', 'azure', 'apple'];

  // include extra canvases (ai_geo, crop1..n, etc.), but never solar/height
  const extras = Object.keys(viewCanvases || {})
    .filter(k => k && !base.includes(k) && k !== 'solar' && k !== 'height');

  // also include any known layerData-backed base layers that might not be in viewCanvases yet
  const possibles = [];
  if (layerData?.google) possibles.push('google');
  if (layerData?.azure)  possibles.push('azure');
  if (layerData?.apple)  possibles.push('apple');

  const out = [...new Set([...base, ...possibles, ...extras])]
    .filter(k => k !== 'solar' && k !== 'height');

  return out;
}

function ensureLayerCfg(id) {
  if (!id) id = 'google';

  // hard block
  if (id === 'solar' || id === 'height') {
    // return a harmless object but never let callers write into LAYER_CONFIG for these
    return { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0, __locked: true };
  }

  if (!LAYER_CONFIG[id]) LAYER_CONFIG[id] = { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 };
  const c = LAYER_CONFIG[id];

  if (!Number.isFinite(c.scale)) c.scale = 1.0;
  if (!Number.isFinite(c.x)) c.x = 0;
  if (!Number.isFinite(c.y)) c.y = 0;
  if (!Number.isFinite(c.rot)) c.rot = 0;
  if (!Number.isFinite(c.fineScale)) c.fineScale = 1.0;

  return c;
}

// Always align the ACTIVE 2D view layer (never solar/height)
function getActiveAdjustLayerId() {
  const id = (typeof currentViewId !== 'undefined' && currentViewId) ? currentViewId : 'google';
  const adjustable = new Set(getAdjustableLayersList());

  // If the active view is not adjustable (solar/height/ai_geo/etc), fallback to last or google
  if (!adjustable.has(id)) {
    const last = window.__lastAdjustLayerId;
    if (last && adjustable.has(last)) return last;
    return adjustable.has('google') ? 'google' : (Array.from(adjustable)[0] || 'google');
  }

  window.__lastAdjustLayerId = id;
  return id;
}

/* ============================================================
   REJECT PROJECT — Drop-in addition for main.js
   ============================================================ */

function injectRejectButton(disabled=true) {
    const helpBtn = document.getElementById('btnToggleHelp');
    if (!helpBtn || document.getElementById('btnRejectProject')) return;

    const btn = document.createElement('button');
    btn.id = 'btnRejectProject';
    btn.className = 'toolbar-btn';
    btn.title = 'Reject Project';
    btn.innerHTML = '<i class="fas fa-times-circle"></i>';
    btn.style.cssText = disabled ? 'color:#999; border-color:#ddd; opacity:0.45; cursor:not-allowed;' : 'color:#d93025; border-color:#d93025;';
    btn.disabled = disabled;
    btn.onclick = openRejectModal;

    helpBtn.parentNode.insertBefore(btn, helpBtn.nextSibling);
}

function openRejectModal() {
    if (document.getElementById('reject-modal-overlay')) return;

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    const rejectionReasons = Array.isArray(window.FIRSTMEASURE_REJECTION_REASONS)
        ? window.FIRSTMEASURE_REJECTION_REASONS.filter(reason => reason && reason.id && reason.label)
        : [];
    if (rejectionReasons.length === 0) {
        alert('Rejection reasons are unavailable. Please reload and try again.');
        return;
    }
    const reasonsHtml = rejectionReasons.map((reason) => {
        const id = escapeHtml(reason.id);
        const label = escapeHtml(reason.label);
        const icon = escapeHtml(reason.icon || 'fas fa-circle-exclamation');
        return `
            <button class="reject-reason-btn" data-reason="${id}" data-label="${label}"
                style="padding:10px 14px; border:2px solid #ddd; border-radius:8px; background:#fff;
                       cursor:pointer; font-size:13px; font-weight:600; text-align:left; transition:all 0.15s;">
                <i class="${icon}" style="width:20px; color:#888;"></i> ${label}
            </button>
        `;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'reject-modal-overlay';
    overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100%; height:100%;
        background:rgba(0,0,0,0.5); z-index:10000;
        display:flex; align-items:center; justify-content:center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background:#fff; border-radius:12px; padding:28px 32px;
        width:420px; max-width:90vw; box-shadow:0 8px 30px rgba(0,0,0,0.25);
        font-family:'Segoe UI',Roboto,sans-serif;
    `;

    modal.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">
            <h3 style="margin:0; color:#d93025; font-size:18px;">
                <i class="fas fa-exclamation-triangle" style="margin-right:8px;"></i>Reject Project
            </h3>
            <button id="rejectModalClose" style="background:none; border:none; font-size:20px; cursor:pointer; color:#888; padding:4px 8px;">
                <i class="fas fa-times"></i>
            </button>
        </div>

        <p style="font-size:13px; color:#555; margin:0 0 16px;">Select a reason for rejection:</p>

        <div id="reject-reasons" style="display:flex; flex-direction:column; gap:8px; margin-bottom:18px;">
            ${reasonsHtml}
        </div>

        <div id="rejectStructureType" style="display:none; margin:-6px 0 18px; padding:12px; border:1px solid #ffcc80; border-radius:8px; background:#fff8e1;">
            <div style="font-size:11px; font-weight:800; color:#666; text-transform:uppercase; letter-spacing:.4px; margin-bottom:8px;">
                Correct structure type
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button type="button" class="reject-type-btn" data-correct-type="commercial"
                    style="padding:9px 12px; border:1px solid #ddd; border-radius:8px; background:#fff; cursor:pointer; font-size:12px; font-weight:800;">
                    <i class="fas fa-building" style="margin-right:6px;"></i>Commercial
                </button>
                <button type="button" class="reject-type-btn" data-correct-type="multifamily"
                    style="padding:9px 12px; border:1px solid #ddd; border-radius:8px; background:#fff; cursor:pointer; font-size:12px; font-weight:800;">
                    <i class="fas fa-house-chimney-window" style="margin-right:6px;"></i>Multi-family
                </button>
            </div>
        </div>

        <div style="margin-bottom:18px;">
            <label style="font-size:11px; font-weight:700; color:#666; display:block; margin-bottom:6px;">
                Additional notes:
            </label>
            <textarea id="rejectNotes" placeholder="Optional details…"
                style="width:100%; height:60px; border:1px solid #ddd; border-radius:8px;
                       padding:10px; font-size:13px; resize:vertical; box-sizing:border-box;
                       font-family:inherit; outline:none;"
            ></textarea>
        </div>

        <div style="display:flex; gap:10px; justify-content:flex-end;">
            <button id="rejectCancelBtn"
                style="padding:10px 20px; border:1px solid #ccc; border-radius:8px; background:#fff;
                       cursor:pointer; font-weight:600; font-size:13px;">
                Cancel
            </button>
            <button id="rejectConfirmBtn" disabled
                style="padding:10px 20px; border:none; border-radius:8px; background:#ccc;
                       color:#fff; cursor:not-allowed; font-weight:700; font-size:13px; transition:all 0.2s;">
                <i class="fas fa-times-circle"></i> Reject Project
            </button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Wiring ---
    const selectedReasons = new Set();
    let selectedCorrectType = '';
    const confirmBtn = modal.querySelector('#rejectConfirmBtn');
    const notesEl = modal.querySelector('#rejectNotes');
    const reasonBtns = modal.querySelectorAll('.reject-reason-btn');
    const typeBox = modal.querySelector('#rejectStructureType');
    const typeBtns = modal.querySelectorAll('.reject-type-btn');

    const updateConfirmState = () => {
        const hasReason = selectedReasons.size > 0;
        const selectedReason = Array.from(selectedReasons)[0] || '';
        const needsType = selectedReason === 'incorrect_structure_type';
        const canSubmit = hasReason && (!needsType || !!selectedCorrectType);
        confirmBtn.disabled = !canSubmit;
        confirmBtn.style.background = canSubmit ? '#d93025' : '#ccc';
        confirmBtn.style.cursor = canSubmit ? 'pointer' : 'not-allowed';
        if (typeBox) typeBox.style.display = needsType ? 'block' : 'none';
    };

    reasonBtns.forEach(btn => {
        btn.onmouseenter = () => { if (!selectedReasons.has(btn.dataset.reason)) btn.style.borderColor = '#aaa'; };
        btn.onmouseleave = () => { if (!selectedReasons.has(btn.dataset.reason)) btn.style.borderColor = '#ddd'; };
        btn.onclick = () => {
            const reason = btn.dataset.reason;
            selectedCorrectType = '';
            typeBtns.forEach(typeBtn => {
                typeBtn.style.borderColor = '#ddd';
                typeBtn.style.background = '#fff';
                typeBtn.style.color = '#333';
            });
            if (selectedReasons.has(reason)) {
                // Deselect
                selectedReasons.delete(reason);
                btn.style.borderColor = '#ddd';
                btn.style.background = '#fff';
                btn.style.color = '#333';
                btn.querySelector('i').style.color = '#888';
            } else {
                // Select (additive — no clearing others)
                selectedReasons.clear();
                reasonBtns.forEach(otherBtn => {
                    otherBtn.style.borderColor = '#ddd';
                    otherBtn.style.background = '#fff';
                    otherBtn.style.color = '#333';
                    otherBtn.querySelector('i').style.color = '#888';
                });
                selectedReasons.add(reason);
                btn.style.borderColor = '#d93025';
                btn.style.background = '#fff5f5';
                btn.style.color = '#d93025';
                btn.querySelector('i').style.color = '#d93025';
            }
            updateConfirmState();
        };
    });
    typeBtns.forEach(btn => {
        btn.onclick = () => {
            selectedCorrectType = btn.dataset.correctType || '';
            typeBtns.forEach(typeBtn => {
                typeBtn.style.borderColor = '#ddd';
                typeBtn.style.background = '#fff';
                typeBtn.style.color = '#333';
            });
            btn.style.borderColor = '#d93025';
            btn.style.background = '#fff5f5';
            btn.style.color = '#d93025';
            updateConfirmState();
        };
    });

    notesEl.oninput = updateConfirmState;

    const closeModal = () => overlay.remove();

    modal.querySelector('#rejectModalClose').onclick = closeModal;
    modal.querySelector('#rejectCancelBtn').onclick = closeModal;
    let mouseDownOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = (e.target === overlay); });
    overlay.addEventListener('mouseup', (e) => {
        if (mouseDownOnOverlay && e.target === overlay) closeModal();
        mouseDownOnOverlay = false;
    });

    confirmBtn.onclick = async () => {
        const reasons = Array.from(selectedReasons);
        const notes = notesEl.value.trim();
        if (reasons.length === 0) return;
        if (reasons[0] === 'incorrect_structure_type' && !selectedCorrectType) return;

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';

        try {
            if (!window.currentProjectId || typeof window.firstMeasureFetchJson !== 'function') {
                throw new Error('FirstMeasure API helper is unavailable.');
            }

            const data = await window.firstMeasureFetchJson(
                `/projects/${encodeURIComponent(window.currentProjectId)}/coverage/reject`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        rejection_reason: reasons[0],
                        rejection_reasons: reasons,
                        correct_project_type: selectedCorrectType,
                        note: notes,
                        actor: window.FIRSTMEASURE_ACTOR || {}
                    })
                }
            );

            if (data.success) {
                closeModal();
                const btn = document.getElementById('btnRejectProject');
                if (btn) {
                    btn.style.background = '#ff9800';
                    btn.style.color = '#fff';
                    btn.innerHTML = '<i class="fas fa-clock"></i> Pending Review';
                }
                // Navigate back to index after a moment
                setTimeout(() => {
                    window.location.href = './';
                }, 1500);
            } else {
                throw new Error(data.error || 'Request failed');
            }
        } catch (e) {
            console.error('Rejection request error:', e);
            alert('Failed to submit rejection: ' + e.message);
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fas fa-times-circle"></i> Reject Project';
        }
    };

}

// --- Hook into page load ---
window.addEventListener('load', injectRejectButton);

// Global State for Pins
window.showCustomerPins = true;

window.toggleCustomerPins = function(forceState = null) {
    window.showCustomerPins = (forceState !== null) ? !!forceState : !window.showCustomerPins;
    
    const btn = document.getElementById('btnTogglePins');
    if (btn) {
        if (window.showCustomerPins) {
            btn.classList.add('active');
            btn.style.background = '#e8f0fe';
            btn.style.color = '#1a73e8'; // Standard Blue
            btn.style.borderColor = '#1a73e8';
        } else {
            btn.classList.remove('active');
            btn.style.background = '#fff';
            btn.style.color = '#5f6368';
            btn.style.borderColor = '#ccc';
        }
    }
    
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
}

function injectPinButton() {
    // Prevent duplicate injection
    if (document.getElementById('btnTogglePins')) return;

    // Find the main toolbar container using a known button
    const referenceBtn = document.getElementById('btnToggleGrid') || document.getElementById('btnToggleSnap');
    if (!referenceBtn || !referenceBtn.parentNode) return;

    const toolbarGroup = referenceBtn.parentNode;

    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.id = 'btnTogglePins';
    btn.title = 'Toggle Customer Pins';
    btn.innerHTML = '<i class="fas fa-map-marker-alt"></i>'; 
    btn.style.marginLeft = "5px";
    btn.onclick = () => window.toggleCustomerPins();

    // Append to the end of the toolbar group
    toolbarGroup.appendChild(btn);

    // Initialize visual state
    window.toggleCustomerPins(window.showCustomerPins);
}

// Hook into the existing window load to ensure button appears
window.addEventListener('load', () => {
    setTimeout(injectPinButton, 100); 
});

// Hook into the existing window load to ensure button appears
window.addEventListener('load', () => {
    setTimeout(injectPinButton, 100); // Slight delay to ensure toolbar exists
});
function injectLayerAlignUI() {
  // prevent duplicates
  if (document.getElementById('layer-align-wrap')) return;

  // Find a good insertion point: right of the layer controls group
  const toolbar = document.getElementById('global-toolbar');
  const secondaryGroups = toolbar ? toolbar.querySelectorAll('.toolbar-row-secondary .toolbar-section-left .controls-group') : [];
  const toolbarHost = secondaryGroups[1] || document.getElementById('toolbar-action-group') || toolbar;
  if (!toolbarHost) return;

  // Wrapper so button + panel stay together
  const wrap = document.createElement('div');
  wrap.id = 'layer-align-wrap';
  wrap.style.cssText = `
    display:inline-flex; align-items:center; position:relative; margin-left:8px;
  `;

  const buttonGroup = document.createElement('div');
  buttonGroup.id = 'layer-adjust-button-group';
  buttonGroup.style.cssText = 'display:flex;border:1px solid #ccc;border-radius:4px;overflow:hidden;background:#fff;';

  // Toggle button (top bar, right of layer controls)
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'btnToggleAlignUI';
  toggleBtn.className = 'toolbar-btn';
  toggleBtn.title = 'Toggle layer alignment controls';
  toggleBtn.textContent = 'Align';
  toggleBtn.style.cssText = 'border:none;border-radius:0;padding:6px 10px;font-size:10px;min-height:32px;';

  const visualBtn = document.createElement('button');
  visualBtn.id = 'btnToggleVisualAdjustUI';
  visualBtn.className = 'toolbar-btn';
  visualBtn.title = 'Visual adjustments for the active image';
  visualBtn.innerHTML = '<i class="fas fa-sun"></i>';
  visualBtn.style.cssText = 'border:none;border-left:1px solid #eee;border-radius:0;padding:6px 10px;font-size:10px;min-height:32px;';

  buttonGroup.appendChild(toggleBtn);
  buttonGroup.appendChild(visualBtn);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'layer-align-ui';
  panel.style.cssText = `
    position:absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 5000;
    display:none;
    background:#fff;
    border:1px solid #ddd;
    border-radius:12px;
    padding:10px;
    box-shadow:0 6px 18px rgba(0,0,0,0.18);
    font-family: Segoe UI, Roboto, sans-serif;
    min-width: 420px;
  `;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-weight:900;font-size:12px;color:#444;">
        ALIGN ACTIVE LAYER: <span id="alignActiveLayerLabel" style="color:#1a73e8;"></span>
      </div>
      <button class="toolbar-btn" id="alignCloseBtn" title="Close align controls" style="padding:6px 10px;">
        <i class="fas fa-times"></i>
      </button>
    </div>

    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">

      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="font-size:10px; font-weight:900; color:#666;">MOVE (px)</div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span style="font-size:10px; font-weight:900; color:#666;">Step</span>
          <input id="alignMoveStep" type="number" value="1" min="1" step="1"
                 style="width:64px;padding:6px;border:1px solid #ccc;border-radius:8px;font-weight:800;font-size:12px;" />
        </div>
        <div style="display:flex; gap:6px;">
          <button class="toolbar-btn" id="alignLeft">←</button>
          <button class="toolbar-btn" id="alignRight">→</button>
          <button class="toolbar-btn" id="alignUp">↑</button>
          <button class="toolbar-btn" id="alignDown">↓</button>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="font-size:10px; font-weight:900; color:#666;">ROTATION (deg)</div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span style="font-size:10px; font-weight:900; color:#666;">Step</span>
          <input id="alignRotStep" type="number" value="0.1" step="0.1"
                 style="width:64px;padding:6px;border:1px solid #ccc;border-radius:8px;font-weight:800;font-size:12px;" />
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="toolbar-btn" id="alignRotDown" title="Rotate -" style="padding:6px 10px;">-</button>
          <button class="toolbar-btn" id="alignRotUp" title="Rotate +" style="padding:6px 10px;">+</button>
          <input id="alignRotVal" type="number" value="0" step="0.1"
                 style="width:92px;padding:6px;border:1px solid #ccc;border-radius:8px;font-weight:900;font-size:12px;" />
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="font-size:10px; font-weight:900; color:#666;">SCALE (fine)</div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span style="font-size:10px; font-weight:900; color:#666;">Step</span>
          <input id="alignScaleStep" type="number" value="0.01" step="0.01"
                 style="width:76px;padding:6px;border:1px solid #ccc;border-radius:8px;font-weight:800;font-size:12px;" />
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="toolbar-btn" id="alignScaleDown" title="Scale -" style="padding:6px 10px;">-</button>
          <button class="toolbar-btn" id="alignScaleUp" title="Scale +" style="padding:6px 10px;">+</button>
          <input id="alignScaleVal" type="number" value="1" step="0.001"
                 style="width:92px;padding:6px;border:1px solid #ccc;border-radius:8px;font-weight:900;font-size:12px;" />
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px; margin-left:auto;">
        <div style="font-size:10px; font-weight:900; color:#666;">ACTIONS</div>
        <div style="display:flex; gap:6px;">
          <button class="toolbar-btn" id="alignReset">Reset</button>
          <button class="toolbar-btn" id="alignSave">Save</button>
        </div>
      </div>

    </div>
  `;

  const visualPanel = document.createElement('div');
  visualPanel.id = 'visual-adjust-ui';
  visualPanel.style.cssText = `
    position:absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 5000;
    display:none;
    background:#fff;
    border:1px solid #ddd;
    border-radius:12px;
    padding:10px;
    box-shadow:0 6px 18px rgba(0,0,0,0.18);
    font-family: Segoe UI, Roboto, sans-serif;
    min-width: 390px;
  `;

  const makeVisualRow = ([key, label]) => `
    <div style="display:grid;grid-template-columns:82px 1fr 44px 58px;align-items:center;gap:8px;margin:8px 0;">
      <label for="visual-${key}" style="font-size:11px;font-weight:800;color:#555;">${label}</label>
      <input id="visual-${key}" data-visual-key="${key}" type="range" min="-100" max="100" step="1" value="0" style="width:100%;accent-color:#1a73e8;">
      <span id="visual-${key}-value" style="font-size:11px;font-weight:800;color:#444;text-align:right;">0</span>
      <button class="toolbar-btn" data-visual-reset="${key}" title="Reset ${label}" style="padding:5px 8px;font-size:10px;min-height:28px;">Reset</button>
    </div>
  `;

  const visualRows = [
    ['exposure', 'Exposure'],
    ['shadows', 'Shadows'],
    ['highlights', 'Highlights'],
    ['sharpness', 'Sharpness']
  ].map(makeVisualRow).join('')
    + '<div style="height:1px;background:#e5e7eb;margin:10px 0;"></div>'
    + [
      ['saturation', 'Saturation'],
      ['contrast', 'Contrast']
    ].map(makeVisualRow).join('');

  visualPanel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-weight:900;font-size:12px;color:#444;">
        VISUAL ADJUSTMENTS: <span id="visualActiveLayerLabel" style="color:#1a73e8;"></span>
      </div>
      <button class="toolbar-btn" id="visualCloseBtn" title="Close visual adjustments" style="padding:6px 10px;">
        <i class="fas fa-times"></i>
      </button>
    </div>
    ${visualRows}
    <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;border-top:1px solid #eee;padding-top:10px;">
      <button class="toolbar-btn" id="visualResetAll">Reset All</button>
      <button class="toolbar-btn" id="visualSave">Save</button>
    </div>
  `;

  wrap.appendChild(buttonGroup);
  wrap.appendChild(panel);
  wrap.appendChild(visualPanel);

  toolbarHost.appendChild(wrap);

  const $ = (sel) => panel.querySelector(sel);
  const v$ = (sel) => visualPanel.querySelector(sel);
  const v$$ = (sel) => visualPanel.querySelectorAll(sel);

  const activeLbl = $('#alignActiveLayerLabel');
  const moveStepEl = $('#alignMoveStep');
  const rotStepEl  = $('#alignRotStep');
  const sclStepEl  = $('#alignScaleStep');
  const rotValEl   = $('#alignRotVal');
  const sclValEl   = $('#alignScaleVal');
  const visualActiveLbl = v$('#visualActiveLayerLabel');
  const visualKeys = ['exposure', 'shadows', 'highlights', 'sharpness', 'saturation', 'contrast'];

  const setBtnStyle = (on) => {
    toggleBtn.classList.toggle('active', on);
    toggleBtn.style.background = on ? '#e8f0fe' : '#fff';
    toggleBtn.style.color = on ? '#1a73e8' : '#5f6368';
  };

  const setVisualBtnStyle = (on) => {
    visualBtn.classList.toggle('active', on);
    visualBtn.style.background = on ? '#e8f0fe' : '#fff';
    visualBtn.style.color = on ? '#1a73e8' : '#5f6368';
  };

  const refreshFieldsFromCfg = () => {
    const id = getActiveAdjustLayerId();
    activeLbl.textContent = id;

    // If someone is viewing height/solar, we still show a safe fallback layer,
    // but we DO NOT touch height/solar config ever.
    const cfg = ensureLayerCfg(id);
    const rotDeg = (cfg.rot || 0) * 180 / Math.PI;
    rotValEl.value = (+rotDeg.toFixed(4));
    sclValEl.value = (+((cfg.fineScale || 1.0).toFixed(6)));
  };

  const refreshVisualFields = () => {
    const id = currentViewId || 'solar';
    visualActiveLbl.textContent = id;
    const state = getVisualAdjustmentState(id);
    visualKeys.forEach(key => {
      const slider = v$(`#visual-${key}`);
      const value = v$(`#visual-${key}-value`);
      if (slider) slider.value = state[key] || 0;
      if (value) value.textContent = String(state[key] || 0);
    });
  };

  const safeRebuild = (id) => {
    if (!id || id === 'solar' || id === 'height') return;

    // If user is currently viewing solar/height/etc, jump to the layer being adjusted
    if (typeof currentViewId !== 'undefined' && currentViewId !== id) {
        if (typeof selectView === 'function') selectView(id);
        else currentViewId = id;
    }

    rebuildBaseViewCanvas(id);
  };


  const nudgeOffset = (dx, dy) => {
    const id = getActiveAdjustLayerId();
    if (id === 'solar' || id === 'height') return;

    const cfg = ensureLayerCfg(id);
    const step = parseFloat(moveStepEl.value) || 1;

    cfg.x += dx * step;
    cfg.y += dy * step;

    safeRebuild(id);
    refreshFieldsFromCfg();
  };

  const applyRotVal = (deg) => {
    const id = getActiveAdjustLayerId();
    if (id === 'solar' || id === 'height') return;

    const cfg = ensureLayerCfg(id);
    cfg.rot = (parseFloat(deg) || 0) * Math.PI / 180;

    safeRebuild(id);
    refreshFieldsFromCfg();
  };

  const applyScaleVal = (s) => {
    const id = getActiveAdjustLayerId();
    if (id === 'solar' || id === 'height') return;

    const cfg = ensureLayerCfg(id);
    const v = parseFloat(s);
    cfg.fineScale = (Number.isFinite(v) && v > 0.000001) ? v : 1.0;

    safeRebuild(id);
    refreshFieldsFromCfg();
  };

  const nudgeRot = (dir) => {
    const cur = parseFloat(rotValEl.value) || 0;
    const step = parseFloat(rotStepEl.value) || 0.1;
    const next = cur + dir * step;
    rotValEl.value = next;
    applyRotVal(next);
  };

  const nudgeScale = (dir) => {
    const cur = parseFloat(sclValEl.value) || 1;
    const step = parseFloat(sclStepEl.value) || 0.001;
    const next = Math.max(0.000001, cur + dir * step);
    sclValEl.value = next;
    applyScaleVal(next);
  };

  const setOpen = (open, target = 'align') => {
    const openAlign = open && target === 'align';
    const openVisual = open && target === 'visual';
    panel.style.display = openAlign ? 'block' : 'none';
    visualPanel.style.display = openVisual ? 'block' : 'none';
    setBtnStyle(openAlign);
    setVisualBtnStyle(openVisual);
    if (openAlign) refreshFieldsFromCfg();
    if (openVisual) refreshVisualFields();
  };

  // Toggle button
  toggleBtn.onclick = () => {
    const isOpen = panel.style.display === 'block';
    setOpen(!isOpen, 'align');
  };

  visualBtn.onclick = () => {
    const isOpen = visualPanel.style.display === 'block';
    setOpen(!isOpen, 'visual');
  };

  // Close on-bar
  $('#alignCloseBtn').onclick = () => setOpen(false);
  v$('#visualCloseBtn').onclick = () => setOpen(false);

  // Move nudges
  $('#alignLeft').onclick  = () => nudgeOffset(-1, 0);
  $('#alignRight').onclick = () => nudgeOffset( 1, 0);
  $('#alignUp').onclick    = () => nudgeOffset( 0,-1);
  $('#alignDown').onclick  = () => nudgeOffset( 0, 1);

  // Rotation nudges
  $('#alignRotDown').onclick = () => nudgeRot(-1);
  $('#alignRotUp').onclick   = () => nudgeRot( 1);

  // Scale nudges
  $('#alignScaleDown').onclick = () => nudgeScale(-1);
  $('#alignScaleUp').onclick   = () => nudgeScale( 1);

  // Direct edit (still instant, no Apply)
  rotValEl.oninput = () => applyRotVal(rotValEl.value);
  sclValEl.oninput = () => applyScaleVal(sclValEl.value);

  v$$('[data-visual-key]').forEach(slider => {
    slider.oninput = () => {
      const key = slider.dataset.visualKey;
      setVisualAdjustmentValue(key, slider.value, currentViewId || 'solar');
      refreshVisualFields();
    };
  });

  v$$('[data-visual-reset]').forEach(btn => {
    btn.onclick = () => {
      resetVisualAdjustment(btn.dataset.visualReset, currentViewId || 'solar');
      refreshVisualFields();
    };
  });

  v$('#visualResetAll').onclick = () => {
    resetVisualAdjustment(null, currentViewId || 'solar');
    refreshVisualFields();
  };

  // Reset (active layer only)
  $('#alignReset').onclick = () => {
    const id = getActiveAdjustLayerId();
    if (id === 'solar' || id === 'height') return;

    const cfg = ensureLayerCfg(id);
    cfg.x = 0;
    cfg.y = 0;
    cfg.rot = 0;
    cfg.fineScale = 1.0;

    safeRebuild(id);
    refreshFieldsFromCfg();
  };

  // Save
  $('#alignSave').onclick = async () => {
    if (typeof window.saveProjectData === 'function') {
      await window.saveProjectData(true);
      console.log('[Align] Saved layer_config');
    }
  };

  v$('#visualSave').onclick = async () => {
    if (typeof window.saveProjectData === 'function') {
      await window.saveProjectData(true);
      console.log('[VisualAdjust] Saved visual adjustments');
    }
  };

  // Expose refresh hook
  window.__alignUIRefresh = () => {
    if (panel.style.display === 'block') refreshFieldsFromCfg();
    if (visualPanel.style.display === 'block') refreshVisualFields();
  };

  // If user clicks outside, close
  document.addEventListener('mousedown', (e) => {
    if (panel.style.display !== 'block' && visualPanel.style.display !== 'block') return;
    if (!wrap.contains(e.target)) setOpen(false);
  });

  // Initial button style
  setBtnStyle(false);
  setVisualBtnStyle(false);
}

// OPTIONAL BUT RECOMMENDED: keep align UI synced when view changes
(function hookAlignIntoSelectViewOnce() {
  if (window.__alignSelectHooked) return;
  window.__alignSelectHooked = true;

  // selectView is declared as a function in main.js; it should be in scope here
  const orig = (typeof selectView === 'function') ? selectView : null;
  if (!orig) return;

  // Replace global reference
  window.selectView = function(viewId) {
    const r = orig(viewId);
    if (window.__alignUIRefresh) window.__alignUIRefresh();
    return r;
  };
})();

// call after UI exists
window.addEventListener('load', () => {
  injectLayerAlignUI();
});



// --- DEBUG HELPER ---
Object.defineProperty(window, 'geoDebug', {
    get: function() {
        if (!mapCenterLat || !mapCenterLng || !imageWidth) {
            return "Map data not loaded yet.";
        }

        // 1. Get Viewport Dimensions
        const vp = document.getElementById('viewport');
        const rect = vp.getBoundingClientRect();
        
        // 2. Calculate Center of Viewport in Screen Coordinates
        const centerX = rect.left + (rect.width / 2);
        const centerY = rect.top + (rect.height / 2);

        // 3. Convert Screen Coordinates to Image Coordinates (Pixels)
        // We use your existing helper from interaction_2d.js
        const imgPt = typeof screenToImage === 'function' 
            ? screenToImage(centerX, centerY) 
            : { x: imageWidth/2, y: imageHeight/2 };

        // 4. Convert Image Pixels to Lat/Lng
        // Constants for meters per degree
        const mLat = 111132;
        const mLng = 111132 * Math.cos(mapCenterLat * (Math.PI / 180));
        
        const metersPerPx = window.getMetersPerPx
            ? Number(window.getMetersPerPx())
            : ((window.RADIUS_METERS * 2) / imageWidth);

        // Calculate delta from the image center (which is mapCenterLat/Lng)
        // Note: Y axis in pixels increases downwards, Latitude increases upwards.
        const deltaPxX = imgPt.x - (imageWidth / 2);
        const deltaPxY = (imageHeight / 2) - imgPt.y; 

        const deltaMetersX = deltaPxX * metersPerPx;
        const deltaMetersY = deltaPxY * metersPerPx;

        return {
            // The fixed center of the downloaded satellite image
            tileCenter: {
                lat: mapCenterLat,
                lng: mapCenterLng
            },
            // The geographic coordinate currently in the center of your screen
            currentViewCenter: {
                lat: mapCenterLat + (deltaMetersY / mLat),
                lng: mapCenterLng + (deltaMetersX / mLng)
            },
            // Current State
            zoom: currentZoom,
            radius: window.RADIUS_METERS,
            rotationRad: viewRotation
        };
    }
});

console.log("Debug loaded. Type 'geoDebug' in console to view coordinates.");


// Initialize the UI setup
window.addEventListener('load', setupLocationAdjustmentUI);


/* quad_view_patch.js — Override: Quad View as a Map Tab (not a toggle)
   =====================================================================
   Include this AFTER main.js. It replaces:
     1. switchMapLayer() — adds 'quad' as a third tab option
     2. The quad-map IIFE      — removes N/S/E/W badges, wires into tab system
   ===================================================================== */

// ── 1. Replace switchMapLayer to support 'quad' tab ──────────

window.switchMapLayer = function switchMapLayer(layerId) {
    if (layerId === 'quad' && window.__quadTiltAvailable !== true) {
        layerId = 'google';
    }

    const cesiumContainer = document.getElementById('google-map-container');
    const googleDiv = document.getElementById('google-js-map');
    const tabCesium = document.getElementById('tabCesium');
    const tabGoogle = document.getElementById('tabGoogle');
    const tabQuad   = document.getElementById('tabQuad');

    // Reset all
    if (cesiumContainer) cesiumContainer.style.display = 'none';
    if (googleDiv)       googleDiv.style.display = 'none';
    if (tabCesium) tabCesium.classList.remove('active');
    if (tabGoogle) tabGoogle.classList.remove('active');
    if (tabQuad)   tabQuad.classList.remove('active');

    // Leave quad mode when switching away
    if (layerId !== 'quad' && typeof window._setQuadMode === 'function') {
        window._setQuadMode(false);
    }

    if (layerId === 'cesium') {
        if (cesiumContainer) cesiumContainer.style.display = 'block';
        if (tabCesium) tabCesium.classList.add('active');
    } else if (layerId === 'quad') {
        // Quad reuses the Google Maps div but overlays the 2×2 grid
        if (googleDiv) googleDiv.style.display = 'block';
        if (tabQuad) tabQuad.classList.add('active');
        if (typeof window._setQuadMode === 'function') window._setQuadMode(true);
    } else {
        // Default: single Google map
        if (googleDiv) googleDiv.style.display = 'block';
        if (tabGoogle) tabGoogle.classList.add('active');
    }
};


// ── 2. Quad Map View — reimplemented as a selectable tab ─────

(function () {
    'use strict';

    window.__quadIsDefault = true;
    window.__quadTiltAvailable = null;

    let isQuadMode    = false;
    let quadMaps      = [];
    let quadContainer = null;
    let syncPaused    = false;
    let mapsInitialised = false;
    let availabilityProbeId = 0;
    let lastAvailabilityKey = null;
    let probeMap = null;
    let shouldAutoOpenQuadAfterProbe = false;

    const HEADINGS = [
        { label: 'N', heading: 0   },
        { label: 'E', heading: 90  },
        { label: 'S', heading: 180 },
        { label: 'W', heading: 270 },
    ];
    const QUAD_UNAVAILABLE_TITLE = 'Quad view unavailable here: Google did not return all four oblique angles.';
    const QUAD_CHECKING_TITLE = 'Checking quad view availability...';

    // ── Helpers ──────────────────────────────────────────────

    function getCenter() {
        if (window.__structureLocalImageryActive && typeof window.getStructureModeGlobalCenter === 'function') {
            const globalCenter = window.getStructureModeGlobalCenter();
            if (globalCenter && Number.isFinite(Number(globalCenter.lat)) && Number.isFinite(Number(globalCenter.lng))) {
                return { lat: Number(globalCenter.lat), lng: Number(globalCenter.lng) };
            }
        }
        const lat = parseFloat(mapCenterLat);
        const lng = parseFloat(mapCenterLng);
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001)) {
            return { lat, lng };
        }
        if (window.googleJsMap) {
            try {
                const c = window.googleJsMap.getCenter();
                if (c && (Math.abs(c.lat()) > 0.0001 || Math.abs(c.lng()) > 0.0001)) {
                    return { lat: c.lat(), lng: c.lng() };
                }
            } catch (e) {}
        }
        return null;
    }

    // ── Build the 2×2 grid (no badges) ──────────────────────

    function getCenterKey(center) {
        if (!center) return null;
        return Number(center.lat).toFixed(5) + ',' + Number(center.lng).toFixed(5);
    }

    function setDisabledStyle(el, disabled, disabledTitle, enabledTitle) {
        if (!el) return;
        el.disabled = !!disabled;
        el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        if (disabled) {
            if (!el.dataset.originalTitle) el.dataset.originalTitle = el.title || '';
            el.title = disabledTitle;
        } else {
            el.title = enabledTitle || el.dataset.originalTitle || el.title || '';
            el.removeAttribute('aria-disabled');
        }
    }

    function applyQuadAvailabilityUI() {
        const pending = window.__quadTiltAvailable !== true && window.__quadTiltAvailable !== false;
        const unavailable = window.__quadTiltAvailable === false;
        const disabled = pending || unavailable;
        const disabledTitle = pending ? QUAD_CHECKING_TITLE : QUAD_UNAVAILABLE_TITLE;

        setDisabledStyle(document.getElementById('tabQuad'), disabled, disabledTitle, 'Open Quad View Tool');
        setDisabledStyle(document.getElementById('btnQuadView'), disabled, disabledTitle, 'Open Quad View Tool');

        const step4 = document.getElementById('step4');
        if (step4) {
            step4.style.opacity = disabled ? '0.45' : '';
            step4.style.cursor = disabled ? 'not-allowed' : '';
            step4.title = disabled ? disabledTitle : '';
        }
    }

    function setQuadAvailability(available, centerKey) {
        window.__quadTiltAvailable = available;
        if (centerKey) lastAvailabilityKey = centerKey;
        applyQuadAvailabilityUI();

        if (available === true && shouldAutoOpenQuadAfterProbe && window.__quadIsDefault) {
            shouldAutoOpenQuadAfterProbe = false;
            switchMapLayer('quad');
        }

        if (available === false) {
            shouldAutoOpenQuadAfterProbe = false;
            window.quadViewCroppedImage = null;
            const step4 = document.getElementById('step4');
            if (step4) step4.classList.remove('done');
        }

        if (available === false && isQuadMode) {
            console.warn('[QuadView] Tilt imagery unavailable; falling back to Google map.');
            switchMapLayer('google');
        }
    }

    window.resetQuadTiltAvailability = function () {
        window.__quadTiltAvailable = null;
        lastAvailabilityKey = null;
        applyQuadAvailabilityUI();
    };

    function resetAvailabilityIfLocationChanged(center) {
        const centerKey = getCenterKey(center);
        if (centerKey && centerKey !== lastAvailabilityKey) {
            window.__quadTiltAvailable = null;
            lastAvailabilityKey = centerKey;
            applyQuadAvailabilityUI();
        }
        return centerKey;
    }

    function waitForMapIdle(map, timeoutMs) {
        return new Promise(function (resolve) {
            let done = false;
            const finish = function () {
                if (done) return;
                done = true;
                resolve();
            };
            google.maps.event.addListenerOnce(map, 'idle', finish);
            setTimeout(finish, timeoutMs || 1800);
        });
    }

    function ensureProbeMap(center) {
        if (probeMap) return probeMap;
        if (typeof google === 'undefined' || !google.maps) return null;

        const probeDiv = document.createElement('div');
        probeDiv.id = 'quad-availability-probe';
        probeDiv.style.cssText = [
            'position:absolute',
            'left:-10000px',
            'top:-10000px',
            'width:256px',
            'height:256px',
            'pointer-events:none',
            'opacity:0',
            'overflow:hidden'
        ].join(';');
        document.body.appendChild(probeDiv);

        probeMap = new google.maps.Map(probeDiv, {
            center: center,
            zoom: 20,
            mapTypeId: 'satellite',
            tilt: 45,
            heading: 0,
            disableDefaultUI: true,
            gestureHandling: 'none',
        });
        return probeMap;
    }

    function headingDistance(a, b) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
        return Math.abs((((a - b) % 360) + 540) % 360 - 180);
    }

    async function probeHeading(probe, center, requestedHeading) {
        probe.setCenter(center);
        probe.setZoom(20);
        probe.setTilt(45);
        probe.setHeading(requestedHeading);

        await waitForMapIdle(probe, 2200);
        await new Promise(function (resolve) { setTimeout(resolve, 250); });

        const actualTilt = typeof probe.getTilt === 'function' ? Number(probe.getTilt()) : 0;
        const actualHeading = typeof probe.getHeading === 'function' ? Number(probe.getHeading()) : NaN;
        const hasTilt = Number.isFinite(actualTilt) && actualTilt >= 40;
        const hasHeading = headingDistance(actualHeading, requestedHeading) <= 15;

        return { requestedHeading, actualTilt, actualHeading, hasTilt, hasHeading };
    }

    async function probeQuadTiltAvailability(center) {
        if (!center) return;

        const centerKey = resetAvailabilityIfLocationChanged(center);
        const probeId = ++availabilityProbeId;
        const probe = ensureProbeMap(center);
        if (!probe) return;

        try {
            const results = [];
            for (const h of HEADINGS) {
                results.push(await probeHeading(probe, center, h.heading));
                if (probeId !== availabilityProbeId) return;
            }

            const hasAllAngles = results.every(function (result) {
                return result.hasTilt && result.hasHeading;
            });
            console.log('[QuadView] Tilt probe', { center: centerKey, results, hasAllAngles });
            setQuadAvailability(hasAllAngles, centerKey);
        } catch (err) {
            console.warn('[QuadView] Tilt probe failed; leaving Quad disabled.', err);
            setQuadAvailability(false, centerKey);
        }
    }

    function requestDefaultQuadIfAvailable() {
        const center = getCenter();
        if (!center) {
            switchMapLayer('google');
            return;
        }

        shouldAutoOpenQuadAfterProbe = true;
        resetAvailabilityIfLocationChanged(center);
        if (window.__quadTiltAvailable === true) {
            shouldAutoOpenQuadAfterProbe = false;
            switchMapLayer('quad');
            return;
        }

        switchMapLayer('google');
        probeQuadTiltAvailability(center);
    }

    function ensureQuadContainer() {
        if (quadContainer) return quadContainer;

        const parent = document.getElementById('google-js-map');
        if (!parent) return null;

        quadContainer = document.createElement('div');
        quadContainer.id = 'quad-map-grid';
        quadContainer.style.cssText =
            'display:none; position:absolute; inset:0; z-index:2;' +
            'grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr;' +
            'gap:2px; background:#202124;';

        HEADINGS.forEach(function (h) {
            const cell = document.createElement('div');
            cell.id = 'quad-cell-' + h.label;
            cell.style.cssText = 'position:relative; overflow:hidden;';

            const mapDiv = document.createElement('div');
            mapDiv.id = 'quad-map-' + h.label;
            mapDiv.style.cssText = 'width:100%; height:100%;';
            cell.appendChild(mapDiv);

            // No badge — removed per request

            quadContainer.appendChild(cell);
        });

        parent.style.position = 'relative';
        parent.appendChild(quadContainer);
        return quadContainer;
    }

    // ── Create the four map instances ────────────────────────

    function initQuadMaps(center) {
        if (mapsInitialised) return;
        if (!center) return;

        quadMaps = [];

        HEADINGS.forEach(function (h, i) {
            var el = document.getElementById('quad-map-' + h.label);
            if (!el) return;

            var map = new google.maps.Map(el, {
                center: center,
                zoom: 20,
                mapTypeId: 'satellite',
                tilt: 45,
                heading: h.heading,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: false,
                zoomControl: false,
                rotateControl: false,
                gestureHandling: 'greedy',
            });

            (function (idx) {
                map.addListener('center_changed', function () {
                    if (syncPaused) return;
                    syncPaused = true;
                    var nc = map.getCenter();
                    quadMaps.forEach(function (m, j) {
                        if (j !== idx && m) m.setCenter(nc);
                    });
                    if (window.googleJsMap) window.googleJsMap.setCenter(nc);
                    syncPaused = false;
                });

                map.addListener('zoom_changed', function () {
                    if (syncPaused) return;
                    syncPaused = true;
                    var z = map.getZoom();
                    quadMaps.forEach(function (m, j) {
                        if (j !== idx && m) m.setZoom(z);
                    });
                    if (window.googleJsMap) window.googleJsMap.setZoom(z);
                    syncPaused = false;
                });
            })(i);

            quadMaps.push(map);
        });

        mapsInitialised = true;
        console.log('[QuadView] Maps initialised at', center);
        probeQuadTiltAvailability(center);
    }

    // ── Sync to current project location ─────────────────────

    function syncQuadMapsToProject() {
        var center = getCenter();
        if (!center || quadMaps.length === 0) return;
        var centerKey = resetAvailabilityIfLocationChanged(center);

        var zoom = window.googleJsMap ? window.googleJsMap.getZoom() : 20;

        syncPaused = true;
        quadMaps.forEach(function (m, i) {
            m.setCenter(center);
            m.setZoom(zoom);
            m.setTilt(45);
            m.setHeading(HEADINGS[i].heading);
        });
        syncPaused = false;

        if (window.__quadTiltAvailable === null && centerKey) {
            probeQuadTiltAvailability(center);
        }
    }

    // ── Core: activate / deactivate quad mode ────────────────
    //    Called by switchMapLayer via window._setQuadMode

    window._setQuadMode = function (on) {
        isQuadMode = on;

        var grid = ensureQuadContainer();
        if (!grid) return;

        var singleMap = document.getElementById('google-js-map');

        if (on) {
            if (window.__quadTiltAvailable !== true) {
                probeQuadTiltAvailability(getCenter());
                switchMapLayer('google');
                return;
            }

            var center = getCenter();
            if (!center) {
                // Can't activate without coordinates — fall back to google tab
                switchMapLayer('google');
                return;
            }

            // Hide the single-map canvas, show 2×2 grid
            Array.from(singleMap.children).forEach(function (ch) {
                if (ch !== quadContainer) ch.style.visibility = 'hidden';
            });
            grid.style.display = 'grid';

            if (!mapsInitialised) initQuadMaps(center);

            syncQuadMapsToProject();

            setTimeout(function () {
                quadMaps.forEach(function (m) { google.maps.event.trigger(m, 'resize'); });
                syncQuadMapsToProject();
            }, 250);

        } else {
            grid.style.display = 'none';
            Array.from(singleMap.children).forEach(function (ch) {
                if (ch !== quadContainer) ch.style.visibility = 'visible';
            });

            // Sync single map back from quad
            if (quadMaps.length && window.googleJsMap) {
                var c = quadMaps[0].getCenter();
                if (c) {
                    window.googleJsMap.setCenter(c);
                    window.googleJsMap.setZoom(quadMaps[0].getZoom());
                }
            }
        }
    };

    // Exposed for external callers
    window.syncQuadMaps = function () {
        if (!isQuadMode || !mapsInitialised) return;
        syncQuadMapsToProject();
        setTimeout(function () {
            quadMaps.forEach(function (m) { google.maps.event.trigger(m, 'resize'); });
        }, 100);
    };

    // ── Inject "Quad" tab next to Cesium / Google tabs ───────

    function injectQuadTab() {
        var tabGoogle = document.getElementById('tabGoogle');
        if (!tabGoogle || document.getElementById('tabQuad')) return;

        // Remove any old toggle button from the previous implementation
        var oldBtn = document.getElementById('btnQuadMapView');
        if (oldBtn) oldBtn.remove();

        // Create a tab that matches the style of tabCesium / tabGoogle
        var tab = document.createElement('button');
        tab.id = 'tabQuad';
        // Copy classes from an existing tab so it matches
        tab.className = tabGoogle.className;
        tab.textContent = 'Quad';
        tab.style.marginLeft = '2px';
        tab.onclick = function () {
            if (window.__quadTiltAvailable !== true) return;
            switchMapLayer('quad');
        };

        tabGoogle.parentNode.insertBefore(tab, tabGoogle.nextSibling);
        applyQuadAvailabilityUI();
    }

    // ── Lifecycle patches (keep quad in sync) ────────────────

    var _origRecenter = window.recenterMap;
    window.recenterMap = function () {
        if (typeof _origRecenter === 'function') _origRecenter.apply(this, arguments);
        resetAvailabilityIfLocationChanged(getCenter());
        if (isQuadMode && mapsInitialised) {
            setTimeout(syncQuadMapsToProject, 150);
        }
    };

    // Patch switchMapLayer for resize after tab switch
    var _baseSwitchMapLayer = window.switchMapLayer;
    window.switchMapLayer = function (layerId) {
        if (layerId === 'quad' && window.__quadTiltAvailable !== true) {
            layerId = 'google';
        }
        _baseSwitchMapLayer.call(this, layerId);
        if (layerId === 'quad' && isQuadMode && mapsInitialised) {
            setTimeout(function () {
                quadMaps.forEach(function (m) { google.maps.event.trigger(m, 'resize'); });
                syncQuadMapsToProject();
            }, 250);
        }
    };

    // loadProjectFromFolder and startAnalysis are patched below (default + sync combined)

    // ── Init ─────────────────────────────────────────────────
    window.addEventListener('load', function () {
        setTimeout(function () {
            injectQuadTab();
            if (window.__quadIsDefault && typeof window.switchMapLayer === 'function') {
                requestDefaultQuadIfAvailable();
            }
        }, 300);
    });

    // Patch loadProjectFromFolder to default to quad and keep sync
    var _patchedLoad = window.loadProjectFromFolder;
    if (typeof _patchedLoad === 'function') {
        window.loadProjectFromFolder = async function () {
            var result = await _patchedLoad.apply(this, arguments);
            if (typeof window.resetQuadTiltAvailability === 'function') {
                window.resetQuadTiltAvailability();
            }
            if (window.__quadIsDefault) {
                requestDefaultQuadIfAvailable();
            }
            if (isQuadMode && mapsInitialised) {
                setTimeout(function () {
                    syncQuadMapsToProject();
                    quadMaps.forEach(function (m) { google.maps.event.trigger(m, 'resize'); });
                }, 600);
            }
            return result;
        };
    }

    // Patch startAnalysis to default to quad and keep sync
    var _patchedStart = window.startAnalysis;
    if (typeof _patchedStart === 'function') {
        window.startAnalysis = async function () {
            var result = await _patchedStart.apply(this, arguments);
            if (typeof window.resetQuadTiltAvailability === 'function') {
                window.resetQuadTiltAvailability();
            }
            if (window.__quadIsDefault) {
                requestDefaultQuadIfAvailable();
            }
            if (isQuadMode && mapsInitialised) {
                setTimeout(function () {
                    syncQuadMapsToProject();
                    quadMaps.forEach(function (m) { google.maps.event.trigger(m, 'resize'); });
                }, 600);
            }
            return result;
        };
    }

})();
