/* scene_3d.js — Unified 3D Scene (merged core + enhancements)
 * ─────────────────────────────────────────────────────────
 * Single file containing:
 *   - All 3D globals & configuration
 *   - UI construction (control panel, axis gizmo, pitch labels)
 *   - Core Three.js init, interaction, rendering
 *   - Face detection / plane sweep / hole cutting
 *   - Chimney/skylight pass, orphan recovery
 *   - Iso/Tri toggle, Blender-style axis gizmo
 *   - Select-All, keyboard shortcuts
 *   - Loop-step debugger, wireframe resolver
 *
 * Load AFTER geometry_core.js and interaction_2d.js.
 * ─────────────────────────────────────────────────────────
 */
// =========================================================
// §0  GLOBALS & STATE
// =========================================================
window.enable3D = true;
let selectBox3DStart = null;
let isSelecting3D = false;
let facesGroup = null;
let snapGuidesGroup = null;
let interactState3D = 'IDLE'; // IDLE, SELECTING, MOVING, RESIZING_Z
let moveStartY_3D = 0;
let activeController3D = false;
let ELEVATION_OFFSET = 0.1;
const MAX_3D_TILE_PROJECT_DISTANCE_METERS = 250;
const GOOGLE_TILE_Y_OFFSET_MIN = -15;
const GOOGLE_TILE_Y_OFFSET_MAX = 15;
const GOOGLE_TILE_Y_OFFSET_STEP = 0.02;
const GOOGLE_TILE_IMAGE_OVERRIDE_MAX_SIDE = 96;
const GOOGLE_TILE_IMAGE_OVERRIDE_LIFT = 0.06;
const GOOGLE_TILE_BACKGROUND_PRELOAD_DELAY_MS = 3000;
const GOOGLE_TILE_BACKGROUND_TILE_DELAY_MS = 35;
const GOOGLE_TILE_BACKGROUND_RAYCAST_CHUNK_SIZE = 1;
const GOOGLE_TILE_BACKGROUND_RAYCAST_SLICE_DELAY_MS = 40;
let googleTileGeospatialRoot = null;
let googleTileCalibrationRoot = null;
let googleTileContentGroup = null;
let googleTileImageOverrideGroup = null;
let googleTileGltfLoader = null;
let googleTileDracoLoader = null;
let googleTileProjectionTexture = null;
let googleTileProjectionMaterials = new Set();
let surfaceHemiLight = null;
let surfaceDirLight = null;
let surfaceAmbientLight = null;
let googleTileState = {
    mode: 'height',
    pendingMode: null,
    surfaceVisible: true,
    manifestUrl: null,
    manifest: null,
    ready: false,
    loading: false,
    preloadQueued: false,
    autoYOffsetReady: false,
    autoYOffsetPending: false,
    autoYOffsetPromise: null,
    loadPromise: null,
    loadToken: 0,
    error: null,
    imageOverrideEnabled: false,
    imageOverrideReady: false,
    imageOverridePromise: null,
    manualYOffset: 0,
    capturePromise: null
};
// Selection & Deletion State
let selectedFaceSignatures = new Set();
// Facet locking: planes stored on points as pt._lockedPlanes = [{a, b, c}, ...]
// A face is "locked" when ALL its points share a common locked plane.
let zMoveOriginals = new Map();
let last3DMouseClientY = 0;
let zResizeState = {
    active: false,
    anchorZ: 0,
    startMouseY: 0,
    originals: new Map()
};
let lastResolvedFacesCache = null;
if (typeof window !== 'undefined') window.lastResolvedFacesCache = null;
let lastFullRenderTime = 0;
const FULL_RENDER_THROTTLE_MS = 0.2;
// Incremental face-cache state
let _incPointSnap = new Map();
let _incLoopCache = new Map();
let _incStructKey = '';
window.invalidateFaceCache = function () {
    _incPointSnap.clear();
    _incLoopCache.clear();
    _incStructKey = '';
    lastResolvedFacesCache = null;
    if (typeof window !== 'undefined') {
        window.lastResolvedFacesCache = null;
        window.currentFaceDataForSVG = null;
    }
    if (typeof window.refreshStructureMode === 'function') window.refreshStructureMode();
};
window.toggle3DSystem = function (isEnabled) {
    window.enable3D = isEnabled;
    const wrapper = document.getElementById('three-view-wrapper');
    if (wrapper) wrapper.style.opacity = isEnabled ? '1' : '0.3';
    if (isEnabled) {
        renderGeometry3D();
        if (typeof processAndRenderAllLayers === 'function') processAndRenderAllLayers();
    }
};
// Enhancement state
let _enh = {
    isOrthographic: false,
    orthoCam: null,
    showPitchLabels: false,
    pitchOverlayContainer: null,
    axisRenderer: null,
    axisScene: null,
    axisCamera: null,
    axisContainer: null,
    axisLabelEls: {},
    axisSize: 120,
    controlsBuilt: false,
    axisBuilt: false,
    animLoopStarted: false,
    lastPresetAxis: null,
    lastPresetFlipped: false
};
// Deferred geometry rebuild state (for constant-screen-size tubes)
let _geomDirty3D = false;
let _lastGeomRebuild = 0;
const GEOM_REBUILD_INTERVAL_MS = 150;
let threeContainerResizeObserver = null;
let threeViewportResizeRAF = 0;

function getThreeViewportMetrics() {
    const container = document.getElementById('three-container');
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || container.clientWidth || 0));
    const height = Math.max(1, Math.round(rect.height || container.clientHeight || 0));
    return { container, width, height };
}

function sync3DViewportSize() {
    if (typeof renderer === 'undefined' || !renderer || typeof camera === 'undefined' || !camera) return false;
    const metrics = getThreeViewportMetrics();
    if (!metrics) return false;
    const { width, height } = metrics;
    const canvas = renderer.domElement;
    if (canvas) {
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    return true;
}

function queue3DViewportSync() {
    if (threeViewportResizeRAF) return;
    threeViewportResizeRAF = requestAnimationFrame(() => {
        threeViewportResizeRAF = 0;
        sync3DViewportSize();
    });
}

function observeThreeViewportSize() {
    const metrics = getThreeViewportMetrics();
    if (!metrics || typeof ResizeObserver === 'undefined') return;
    if (threeContainerResizeObserver) {
        threeContainerResizeObserver.disconnect();
    }
    threeContainerResizeObserver = new ResizeObserver(() => {
        queue3DViewportSync();
    });
    threeContainerResizeObserver.observe(metrics.container);
}

function handle3DWindowResize() {
    queue3DViewportSync();
}

function handle3DWrapperMouseEnter() {
    activeController3D = true;
}

function handle3DWrapperMouseLeave() {
    activeController3D = false;
}

window.sync3DViewportSize = sync3DViewportSize;
// =========================================================
// §0b  INJECTED STYLES (enhancements)
// =========================================================
(function injectEnhancementStyles() {
    const s = document.createElement('style');
    s.textContent = `
    /* Toggle switch */
    .enh-toggle-track{position:relative;width:62px;height:24px;background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.25);border-radius:12px;cursor:pointer;display:flex;align-items:center;user-select:none;overflow:hidden;flex-shrink:0}
    .enh-toggle-track:hover{border-color:rgba(255,255,255,0.45)}
    .enh-toggle-label{position:absolute;top:50%;transform:translateY(-50%);font-size:9px;font-weight:700;font-family:Arial,sans-serif;pointer-events:none;transition:opacity .15s}
    .enh-toggle-label-left{left:7px}.enh-toggle-label-right{right:7px}
    .enh-toggle-thumb{position:absolute;top:2px;width:28px;height:20px;background:rgba(255,255,255,0.9);border-radius:9px;transition:left .18s ease;pointer-events:none}
    .enh-toggle-track[data-state="left"] .enh-toggle-thumb{left:2px}
    .enh-toggle-track[data-state="right"] .enh-toggle-thumb{left:32px}
    .enh-toggle-track[data-state="left"] .enh-toggle-label-left{color:#222;opacity:1;z-index:1}
    .enh-toggle-track[data-state="left"] .enh-toggle-label-right{color:rgba(255,255,255,0.6);opacity:1}
    .enh-toggle-track[data-state="right"] .enh-toggle-label-right{color:#222;opacity:1;z-index:1}
    .enh-toggle-track[data-state="right"] .enh-toggle-label-left{color:rgba(255,255,255,0.6);opacity:1}
    .enh-surface-toggle{width:74px}
    .enh-surface-toggle .enh-toggle-thumb{width:36px}
    .enh-surface-toggle[data-state="left"] .enh-toggle-thumb{left:2px}
    .enh-surface-toggle[data-state="right"] .enh-toggle-thumb{left:36px}
    .enh-surface-toggle .enh-toggle-label-left{left:8px}
    .enh-surface-toggle .enh-toggle-label-right{right:8px}
    .enh-surface-toggle.loading{border-color:rgba(251,188,4,0.8);box-shadow:0 0 0 1px rgba(251,188,4,0.12) inset}
    .enh-surface-toggle.loading::after{content:"";position:absolute;top:4px;right:5px;width:5px;height:5px;border-radius:50%;background:#fbbc04;opacity:0.9;animation:surface-toggle-pulse 1.1s ease-in-out infinite}
    .enh-surface-toggle.pending .enh-toggle-thumb{box-shadow:0 0 0 1px rgba(251,188,4,0.2),0 0 10px rgba(251,188,4,0.22)}
    .enh-surface-toggle.disabled{cursor:not-allowed;opacity:0.55;filter:saturate(0.7)}
    .enh-surface-toggle.disabled:hover{border-color:rgba(251,188,4,0.8)}
    .enh-surface-toggle.disabled .enh-toggle-label-left,
    .enh-surface-toggle.disabled .enh-toggle-label-right{color:rgba(255,255,255,0.5)}
    @keyframes surface-toggle-pulse{0%,100%{transform:scale(0.85);opacity:0.45}50%{transform:scale(1);opacity:1}}
    /* Axis labels */
    .axis-label-el{position:absolute;font-weight:700;font-family:Arial,sans-serif;text-shadow:0 0 4px rgba(0,0,0,0.9),0 0 8px rgba(0,0,0,0.5);transform:translate(-50%,-50%);cursor:pointer;pointer-events:auto;transition:transform .12s,text-shadow .12s;border-radius:3px;padding:1px 3px;line-height:1}
    .axis-label-el:hover{transform:translate(-50%,-50%) scale(1.35);text-shadow:0 0 8px rgba(255,255,255,0.6),0 0 4px rgba(0,0,0,0.9);background:rgba(255,255,255,0.12)}
    .axis-label-el.positive{font-size:13px}.axis-label-el.negative{font-size:10px;opacity:0.5}
    .axis-label-el.negative:hover{opacity:0.85}
    .axis-view-name{position:absolute;bottom:3px;left:50%;transform:translateX(-50%);font-size:9px;font-family:Arial,sans-serif;color:rgba(255,255,255,0.4);pointer-events:none;white-space:nowrap;transition:color .4s}
    /* Control panel */
    .enh-control-panel{position:absolute;top:8px;left:8px;display:flex;flex-direction:row;align-items:center;gap:8px;z-index:90;pointer-events:auto;background:rgba(0,0,0,0.45);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px}
    .enh-control-panel .enh-separator{width:1px;height:20px;background:rgba(255,255,255,0.15);flex-shrink:0}
    .enh-btn{padding:4px 8px;font-size:10px;font-weight:600;font-family:Arial,sans-serif;border:1px solid rgba(255,255,255,0.3);border-radius:4px;background:rgba(0,0,0,0.4);color:#fff;cursor:pointer;white-space:nowrap;line-height:1.3;transition:background .15s,border-color .15s;flex-shrink:0}
    .enh-btn:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.5)}
    .enh-btn.active{background:rgb(0 93 255/40%);color:rgb(60 145 255);border-color:rgb(60 145 255)}
    .enh-crop-group{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .enh-crop-group span{color:#ccc;font-size:10px;font-family:Arial,sans-serif;white-space:nowrap}
    .enh-crop-group input[type=range]{width:70px;accent-color:#4488ff}
    /* 3D Loader overlay */
    #three-loader{position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(32,33,36,0.6);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;opacity:0;pointer-events:none;transition:opacity .2s ease-in-out}
    #three-loader.visible{opacity:1;pointer-events:auto}
    .slick-spinner{width:40px;height:40px;border:4px solid rgba(255,255,255,0.3);border-top:4px solid #fff;border-radius:50%;animation:slick-spin .8s linear infinite;margin-bottom:10px}
    @keyframes slick-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    .loader-text{color:#fff;font-family:'Segoe UI',sans-serif;font-size:13px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
    `;
    document.head.appendChild(s);
})();
// =========================================================
// §1  Z-SCALE HELPER
// =========================================================
function getZScale() {
    const r = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
    const rr = (Number.isFinite(+r) && +r > 0) ? +r : 20;
    return 2.0 * (20 / rr);
}
function getHorizontalSceneUnitsPerMeter() {
    const r = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
    const rr = (Number.isFinite(+r) && +r > 0) ? +r : 20;
    return 50 / rr;
}
function getScenePlaneSize() {
    const w = Number(imageWidth);
    const h = Number(imageHeight);
    const metersPerPx = window.getMetersPerPx ? Number(window.getMetersPerPx()) : Number(window.IMAGE_METERS_PER_PX || 0);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 && Number.isFinite(metersPerPx) && metersPerPx > 0) {
        const unitsPerMeter = getHorizontalSceneUnitsPerMeter();
        return {
            width: w * metersPerPx * unitsPerMeter,
            height: h * metersPerPx * unitsPerMeter
        };
    }
    const aspect = (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) ? h / w : 1;
    return { width: 100, height: 100 * aspect };
}
function imagePointToSceneXZ(x, y) {
    const size = getScenePlaneSize();
    return {
        x: (Number(x) / imageWidth - 0.5) * size.width,
        z: (Number(y) / imageHeight - 0.5) * size.height
    };
}
function getGoogleTileMaxAnisotropy() {
    if (!renderer || !renderer.capabilities || typeof renderer.capabilities.getMaxAnisotropy !== 'function') return 1;
    try {
        return Math.max(1, renderer.capabilities.getMaxAnisotropy() || 1);
    } catch (error) {
        return 1;
    }
}
function canGenerateMipmapsForTexture(texture) {
    if (!texture || !texture.image) return false;
    const image = texture.image;
    const width = Number(image.width || image.videoWidth || 0);
    const height = Number(image.height || image.videoHeight || 0);
    if (!(width > 0 && height > 0)) return false;
    if (renderer && renderer.capabilities && renderer.capabilities.isWebGL2) return true;
    return THREE.MathUtils && typeof THREE.MathUtils.isPowerOfTwo === 'function'
        ? (THREE.MathUtils.isPowerOfTwo(width) && THREE.MathUtils.isPowerOfTwo(height))
        : false;
}
function tuneGoogleTileTexture(texture) {
    if (!texture) return texture;
    const textureUserData = texture.userData || (texture.userData = {});
    if (textureUserData.__googleTileTextureTuned) return texture;

    if (typeof THREE.sRGBEncoding !== 'undefined' && 'encoding' in texture) texture.encoding = THREE.sRGBEncoding;
    if (typeof THREE.SRGBColorSpace !== 'undefined' && 'colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
    if ('anisotropy' in texture) texture.anisotropy = getGoogleTileMaxAnisotropy();
    if ('magFilter' in texture && typeof THREE.LinearFilter !== 'undefined') texture.magFilter = THREE.LinearFilter;
    if ('minFilter' in texture) {
        const allowMipmaps = canGenerateMipmapsForTexture(texture);
        if ('generateMipmaps' in texture) texture.generateMipmaps = allowMipmaps;
        if (allowMipmaps && typeof THREE.LinearMipmapLinearFilter !== 'undefined') {
            texture.minFilter = THREE.LinearMipmapLinearFilter;
        } else if (typeof THREE.LinearFilter !== 'undefined') {
            texture.minFilter = THREE.LinearFilter;
        }
    }
    textureUserData.__googleTileTextureTuned = true;
    texture.needsUpdate = true;
    return texture;
}
function disposeGoogleTileProjectionTexture() {
    if (googleTileProjectionTexture && typeof googleTileProjectionTexture.dispose === 'function') {
        googleTileProjectionTexture.dispose();
    }
    googleTileProjectionTexture = null;
}
function updateGoogleTileProjectionUniforms(material) {
    if (!material || !material.userData) return;
    const shader = material.userData.__googleTileProjectionShader;
    if (!shader || !shader.uniforms) return;
    const planeSize = getScenePlaneSize();
    shader.uniforms.uGoogleProjectionEnabled.value = googleTileState.imageOverrideEnabled ? 1 : 0;
    shader.uniforms.uGoogleProjectionMap.value = googleTileProjectionTexture;
    shader.uniforms.uGoogleProjectionMinY.value = 0.72;
    shader.uniforms.uGoogleProjectionSceneWidth.value = planeSize.width;
    shader.uniforms.uGoogleProjectionSceneHeight.value = planeSize.height;
}
function attachGoogleTileProjectionShader(material) {
    if (!material || material.userData?.__googleTileProjectionAttached) return material;
    material.userData = {
        ...(material.userData || {}),
        __googleTileProjectionAttached: true
    };
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uGoogleProjectionEnabled = { value: googleTileState.imageOverrideEnabled ? 1 : 0 };
        shader.uniforms.uGoogleProjectionMap = { value: googleTileProjectionTexture };
        shader.uniforms.uGoogleProjectionMinY = { value: 0.72 };
        const planeSize = getScenePlaneSize();
        shader.uniforms.uGoogleProjectionSceneWidth = { value: planeSize.width };
        shader.uniforms.uGoogleProjectionSceneHeight = { value: planeSize.height };
        shader.vertexShader = `
varying vec3 vGoogleWorldPos;
varying vec3 vGoogleWorldNormal;
` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
mat3 googleWorldNormalMatrix = mat3(transpose(inverse(modelMatrix)));
vGoogleWorldNormal = normalize(googleWorldNormalMatrix * normal);
vec4 googleWorldPosition = modelMatrix * vec4(transformed, 1.0);
vGoogleWorldPos = googleWorldPosition.xyz;`
        );
        shader.fragmentShader = `
uniform float uGoogleProjectionEnabled;
uniform sampler2D uGoogleProjectionMap;
uniform float uGoogleProjectionMinY;
uniform float uGoogleProjectionSceneWidth;
uniform float uGoogleProjectionSceneHeight;
varying vec3 vGoogleWorldPos;
varying vec3 vGoogleWorldNormal;
` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
if (uGoogleProjectionEnabled > 0.5) {
    vec3 googleProjectionNormal = normalize(vGoogleWorldNormal);
    float googleProjectionBlend = smoothstep(uGoogleProjectionMinY, 1.0, googleProjectionNormal.y);
    vec2 googleProjectionUv = vec2(vGoogleWorldPos.x / uGoogleProjectionSceneWidth + 0.5, 0.5 - vGoogleWorldPos.z / uGoogleProjectionSceneHeight);
    if (googleProjectionBlend > 0.0
        && googleProjectionUv.x >= 0.0 && googleProjectionUv.x <= 1.0
        && googleProjectionUv.y >= 0.0 && googleProjectionUv.y <= 1.0) {
        vec4 googleProjectionColor = texture2D(uGoogleProjectionMap, googleProjectionUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, googleProjectionColor.rgb, googleProjectionBlend);
    }
}`
        );
        material.userData.__googleTileProjectionShader = shader;
        updateGoogleTileProjectionUniforms(material);
    };
    material.customProgramCacheKey = function() {
        return 'google-tile-projection-v2';
    };
    googleTileProjectionMaterials.add(material);
    return material;
}
function markTextureSRGB(texture) {
    return tuneGoogleTileTexture(texture);
}
function createGoogleTileDisplayMaterial(material) {
    if (!material) return material;
    if (material.userData?.__googleTileDisplayMaterial) return material;

    const displayMaterial = new THREE.MeshBasicMaterial({
        color: material.color ? material.color.clone().multiplyScalar(1.12) : new THREE.Color(0xffffff),
        map: material.map ? markTextureSRGB(material.map) : null,
        transparent: !!material.transparent,
        opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
        alphaTest: Number.isFinite(material.alphaTest) ? material.alphaTest : 0,
        side: material.side,
        depthWrite: material.depthWrite !== false,
        fog: false
    });

    if ('name' in material && material.name) displayMaterial.name = material.name;
    displayMaterial.polygonOffset = true;
    displayMaterial.polygonOffsetFactor = 1;
    displayMaterial.polygonOffsetUnits = 1;
    displayMaterial.userData = {
        ...(material.userData || {}),
        __googleTileDisplayMaterial: true
    };
    attachGoogleTileProjectionShader(displayMaterial);
    updateGoogleTileProjectionUniforms(displayMaterial);
    displayMaterial.needsUpdate = true;
    return displayMaterial;
}
function tuneGoogleTileMaterial(material) {
    if (!material) return;
    return createGoogleTileDisplayMaterial(material);
}
function resolveFirstMeasureApiUrl(url) {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return '';
    if (/^[a-z]+:\/\//i.test(rawUrl) || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) {
        return rawUrl;
    }
    const apiBase = (window.FIRSTMEASURE_API_BASE || '').trim();
    if (!apiBase) return rawUrl;
    const apiOrigin = apiBase.replace(/\/v1\/firstmeasure\/?$/i, '');
    if (rawUrl.startsWith('/v1/firstmeasure/')) {
        return `${apiOrigin}${rawUrl}`;
    }
    return rawUrl;
}
function getCurrent3DImageCanvas() {
    if (typeof ensureViewCanvas === 'function' && typeof currentViewId !== 'undefined' && currentViewId) {
        const activeCanvas = ensureViewCanvas(currentViewId);
        if (activeCanvas) return activeCanvas;
    }
    return (typeof ensureViewCanvas === 'function') ? ensureViewCanvas('solar') : null;
}
function get3DTileManifestUrl() {
    const projectUrl = (window.currentProject3DTileManifestUrl || '').trim();
    return resolveFirstMeasureApiUrl(projectUrl) || '';
}
function isUsingDefault3DTileManifest() {
    return !((window.currentProject3DTileManifestUrl || '').trim());
}
async function requestProjectGoogleTileCapture(force = false) {
    if (googleTileState.capturePromise) return googleTileState.capturePromise;
    if (!window.currentProjectId) {
        throw new Error('Save or load the project before generating Google 3D tiles.');
    }
    if (!Number.isFinite(mapCenterLat) || !Number.isFinite(mapCenterLng)) {
        throw new Error('Project coordinates are missing for Google 3D tile generation.');
    }

    googleTileState.capturePromise = (async () => {
        if (typeof window.firstMeasureFetchJson !== 'function') {
            throw new Error('FirstMeasure API helper is unavailable.');
        }
        const payload = await window.firstMeasureFetchJson(
            `/projects/${encodeURIComponent(window.currentProjectId)}/google-3d/capture`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lat: Number(mapCenterLat),
                    lng: Number(mapCenterLng),
                    address: (document.getElementById('addressInput')?.value || '').trim(),
                    radius_meters: window.getRadiusMeters ? Number(window.getRadiusMeters()) : Number(window.RADIUS_METERS || 0),
                    force: !!force
                })
            }
        );
        if (!payload || !payload.success || !payload.manifest_url) {
            throw new Error(payload && payload.error ? payload.error : 'Google 3D capture request failed.');
        }

        window.currentProject3DTileManifestUrl = resolveFirstMeasureApiUrl(payload.manifest_url);
        if (!window.currentProjectLoadedAppMetadata || typeof window.currentProjectLoadedAppMetadata !== 'object') {
            window.currentProjectLoadedAppMetadata = {};
        }
        window.currentProjectLoadedAppMetadata.google3dTiles = {
            ...((window.currentProjectLoadedAppMetadata && window.currentProjectLoadedAppMetadata.google3dTiles) || {}),
            manifestUrl: payload.manifest_url
        };
        googleTileState.manifest = null;
        googleTileState.manifestUrl = null;
        googleTileState.ready = false;
        clearGoogleTileSurface();
        return payload;
    })().finally(() => {
        googleTileState.capturePromise = null;
    });

    return googleTileState.capturePromise;
}
function geodeticToECEF(latDeg, lonDeg, heightMeters = 0) {
    const a = 6378137.0;
    const e2 = 6.69437999014e-3;
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    return new THREE.Vector3(
        (n + heightMeters) * cosLat * cosLon,
        (n + heightMeters) * cosLat * sinLon,
        (n * (1 - e2) + heightMeters) * sinLat
    );
}
function makeECEFToEUSMatrix(latDeg, lonDeg, anchorECEF) {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
    const up = new THREE.Vector3(
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat)
    );
    const south = new THREE.Vector3(
        Math.sin(lat) * Math.cos(lon),
        Math.sin(lat) * Math.sin(lon),
        -Math.cos(lat)
    );
    return new THREE.Matrix4().set(
        east.x, east.y, east.z, -east.dot(anchorECEF),
        up.x, up.y, up.z, -up.dot(anchorECEF),
        south.x, south.y, south.z, -south.dot(anchorECEF),
        0, 0, 0, 1
    );
}
function haversineMeters(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function disposeObject3D(object) {
    if (!object) return;
    object.traverse(child => {
        if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
        if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(mat => {
                if (!mat) return;
                ['map', 'alphaMap', 'emissiveMap', 'aoMap', 'lightMap', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap']
                    .forEach(key => {
                        if (mat[key] && typeof mat[key].dispose === 'function') mat[key].dispose();
                    });
                if (typeof mat.dispose === 'function') mat.dispose();
            });
        }
    });
}
function ensureGoogleTileSceneRoots() {
    if (!scene || googleTileGeospatialRoot) return;
    googleTileGeospatialRoot = new THREE.Group();
    googleTileGeospatialRoot.matrixAutoUpdate = false;
    googleTileGeospatialRoot.visible = false;
    scene.add(googleTileGeospatialRoot);

    googleTileCalibrationRoot = new THREE.Group();
    googleTileCalibrationRoot.rotation.x = Math.PI / 2;
    googleTileCalibrationRoot.updateMatrix();
    googleTileGeospatialRoot.add(googleTileCalibrationRoot);

    googleTileContentGroup = new THREE.Group();
    googleTileCalibrationRoot.add(googleTileContentGroup);

    googleTileImageOverrideGroup = new THREE.Group();
    googleTileImageOverrideGroup.visible = false;
    googleTileCalibrationRoot.add(googleTileImageOverrideGroup);
}
function clearGoogleTileImageOverrideSurface() {
    if (!googleTileImageOverrideGroup) return;
    while (googleTileImageOverrideGroup.children.length > 0) {
        const child = googleTileImageOverrideGroup.children[0];
        googleTileImageOverrideGroup.remove(child);
        disposeObject3D(child);
    }
    googleTileState.imageOverrideReady = false;
    googleTileState.imageOverridePromise = null;
}
function clearGoogleTileSurface() {
    if (!googleTileContentGroup) return;
    googleTileContentGroup.position.set(0, 0, 0);
    while (googleTileContentGroup.children.length > 0) {
        const child = googleTileContentGroup.children[0];
        googleTileContentGroup.remove(child);
        disposeObject3D(child);
    }
    clearGoogleTileImageOverrideSurface();
    disposeGoogleTileProjectionTexture();
    googleTileProjectionMaterials.clear();
    googleTileState.ready = false;
}
function getQuantile(values, q) {
    if (!values || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[idx];
}
function getDSMSceneHeightAtPixel(ix, iy) {
    if (!layerData.dsm || !layerData.dsm[0]) return null;
    if (ix < 0 || iy < 0 || ix >= imageWidth || iy >= imageHeight) return null;
    const dsm = layerData.dsm[0];
    const val = dsm[iy * imageWidth + ix];
    if (!Number.isFinite(val) || val <= -9000 || Math.abs(val) < 1e-6) return null;
    return ((val - dsmMin) * getZScale()) + ELEVATION_OFFSET;
}
function sceneXZToImagePixel(sceneX, sceneZ) {
    const size = getScenePlaneSize();
    const ix = Math.round(((sceneX / size.width) + 0.5) * imageWidth);
    const iy = Math.round(((sceneZ / size.height) + 0.5) * imageHeight);
    return { ix, iy };
}
function collectGoogleTileTopDeltas(maxSamples = 7000) {
    if (!googleTileContentGroup || !imageWidth || !imageHeight) return [];
    const bucketSize = 3;
    const samplesByBucket = new Map();
    const temp = new THREE.Vector3();
    googleTileGeospatialRoot.updateMatrixWorld(true);
    googleTileContentGroup.traverse(obj => {
        if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes || !obj.geometry.attributes.position) return;
        const positions = obj.geometry.attributes.position;
        const vertexCount = positions.count || 0;
        if (!vertexCount) return;
        const step = Math.max(1, Math.floor(vertexCount / 450));
        for (let i = 0; i < vertexCount; i += step) {
            temp.fromBufferAttribute(positions, i).applyMatrix4(obj.matrixWorld);
            if (!Number.isFinite(temp.x) || !Number.isFinite(temp.y) || !Number.isFinite(temp.z)) continue;
            const pixel = sceneXZToImagePixel(temp.x, temp.z);
            if (pixel.ix < 0 || pixel.iy < 0 || pixel.ix >= imageWidth || pixel.iy >= imageHeight) continue;
            if (typeof isMaskedPixel === 'function' && isMaskedPixel(pixel.ix, pixel.iy)) continue;
            const bx = Math.floor(pixel.ix / bucketSize);
            const by = Math.floor(pixel.iy / bucketSize);
            const key = `${bx},${by}`;
            let bucket = samplesByBucket.get(key);
            if (!bucket) {
                bucket = { ixSum: 0, iySum: 0, count: 0, heights: [] };
                samplesByBucket.set(key, bucket);
            }
            bucket.ixSum += pixel.ix;
            bucket.iySum += pixel.iy;
            bucket.count += 1;
            bucket.heights.push(temp.y);
            if (samplesByBucket.size >= maxSamples) return;
        }
    });
    const deltas = [];
    for (const bucket of samplesByBucket.values()) {
        if (!bucket.heights.length) continue;
        const representativeIx = Math.round(bucket.ixSum / bucket.count);
        const representativeIy = Math.round(bucket.iySum / bucket.count);
        const dsmY = getDSMSceneHeightAtPixel(representativeIx, representativeIy);
        if (!Number.isFinite(dsmY)) continue;
        const tileSurfaceY = getQuantile(bucket.heights, 0.8);
        if (!Number.isFinite(tileSurfaceY)) continue;
        deltas.push(dsmY - tileSurfaceY);
    }
    return deltas;
}
function collectGoogleTileWorldHeights(maxSamples = 5000) {
    if (!googleTileContentGroup) return [];
    const heights = [];
    const temp = new THREE.Vector3();
    googleTileGeospatialRoot.updateMatrixWorld(true);
    googleTileContentGroup.traverse(obj => {
        if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes || !obj.geometry.attributes.position) return;
        const positions = obj.geometry.attributes.position;
        const vertexCount = positions.count || 0;
        if (!vertexCount) return;
        const step = Math.max(1, Math.floor(vertexCount / 350));
        for (let i = 0; i < vertexCount; i += step) {
            temp.fromBufferAttribute(positions, i).applyMatrix4(obj.matrixWorld);
            if (Number.isFinite(temp.y)) heights.push(temp.y);
            if (heights.length >= maxSamples) return;
        }
    });
    return heights;
}
function autoAlignGoogleTileSurfaceToHeightMap() {
    if (googleTileContentGroup) googleTileContentGroup.position.set(0, 0, 0);
    if (googleTileCalibrationRoot) googleTileCalibrationRoot.position.set(0, 0, 0);
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.updateMatrixWorld(true);
}
function updateGoogleTileRootTransform(manifest) {
    ensureGoogleTileSceneRoots();
    if (!googleTileGeospatialRoot || !manifest || !manifest.anchor) return;

    const lat = Number.isFinite(mapCenterLat) ? mapCenterLat : manifest.anchor.lat;
    const lon = Number.isFinite(mapCenterLng) ? mapCenterLng : manifest.anchor.lon;
    const anchorECEF = geodeticToECEF(lat, lon, 0);
    const ecefToLocal = makeECEFToEUSMatrix(lat, lon, anchorECEF);
    const horizontalScale = getHorizontalSceneUnitsPerMeter();
    const verticalScale = getZScale();
    const dsmFloor = Number.isFinite(dsmMin) ? dsmMin : 0;
    const manualYOffset = Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0;

    const scaleMatrix = new THREE.Matrix4().makeScale(horizontalScale, verticalScale, horizontalScale);
    const translateMatrix = new THREE.Matrix4().makeTranslation(0, (-dsmFloor * verticalScale) + ELEVATION_OFFSET + manualYOffset, 0);
    const scaledMatrix = new THREE.Matrix4().multiplyMatrices(scaleMatrix, ecefToLocal);
    const finalMatrix = new THREE.Matrix4().multiplyMatrices(translateMatrix, scaledMatrix);

    googleTileGeospatialRoot.matrix.copy(finalMatrix);
    googleTileGeospatialRoot.matrixWorldNeedsUpdate = true;
    if (googleTileContentGroup) {
        googleTileContentGroup.position.set(0, 0, 0);
    }
    if (googleTileCalibrationRoot) {
        googleTileCalibrationRoot.position.set(0, 0, 0);
    }
}
function apply3DSurfaceVisibility() {
    const showHeight = googleTileState.surfaceVisible && googleTileState.mode === 'height';
    const showTiles = googleTileState.surfaceVisible && googleTileState.mode === 'tiles' && googleTileState.ready;

    if (mesh) mesh.visible = showHeight;
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = showTiles;
    if (googleTileImageOverrideGroup) googleTileImageOverrideGroup.visible = false;
    if (scene) scene.background = new THREE.Color(googleTileState.surfaceVisible ? 0x202124 : 0x111111);
    if (renderer && typeof THREE.sRGBEncoding !== 'undefined' && 'outputEncoding' in renderer && typeof THREE.LinearEncoding !== 'undefined') {
        renderer.outputEncoding = showTiles ? THREE.sRGBEncoding : THREE.LinearEncoding;
    }
    googleTileProjectionMaterials.forEach(updateGoogleTileProjectionUniforms);
    if (surfaceHemiLight) surfaceHemiLight.intensity = showTiles ? 1.85 : 1.0;
    if (surfaceDirLight) surfaceDirLight.intensity = showTiles ? 1.3 : 0.6;
    if (surfaceAmbientLight) surfaceAmbientLight.intensity = showTiles ? 0.42 : 0.0;

    const cropSlider = document.getElementById('cropRange');
    if (cropSlider) {
        cropSlider.disabled = (googleTileState.mode === 'tiles');
        cropSlider.style.opacity = (googleTileState.mode === 'tiles') ? '0.45' : '1';
    }
}
function update3DSurfaceButtons() {
    const imgBtn = document.getElementById('btnToggleImage3D');
    if (imgBtn) {
        if (googleTileState.surfaceVisible) {
            imgBtn.classList.add('active');
            imgBtn.style.background = 'rgb(0 93 255 / 40%)';
            imgBtn.style.color = 'rgb(60 145 255)';
            imgBtn.style.borderColor = 'rgb(60 145 255)';
        } else {
            imgBtn.classList.remove('active');
            imgBtn.style.background = 'rgba(0,0,0,0.5)';
            imgBtn.style.color = '#fff';
            imgBtn.style.borderColor = 'rgba(255,255,255,0.3)';
        }
    }

    const surfaceBtn = document.getElementById('btnToggleSurface3D');
    if (surfaceBtn) {
        const pendingTiles = googleTileState.pendingMode === 'tiles' && googleTileState.mode !== 'tiles';
        const isPreparingTiles = isGoogleTileSurfacePreparing();
        const trackState = (googleTileState.mode === 'tiles' || pendingTiles) ? 'right' : 'left';
        surfaceBtn.setAttribute('data-state', trackState);
        surfaceBtn.classList.toggle('loading', isPreparingTiles);
        surfaceBtn.classList.toggle('pending', pendingTiles);
        surfaceBtn.classList.toggle('disabled', isPreparingTiles);
        surfaceBtn.setAttribute('aria-busy', (isPreparingTiles || pendingTiles) ? 'true' : 'false');
        surfaceBtn.setAttribute('aria-disabled', isPreparingTiles ? 'true' : 'false');
        surfaceBtn.style.pointerEvents = isPreparingTiles ? 'none' : '';
        if (pendingTiles && (googleTileState.loading || isPreparingTiles || !googleTileState.ready)) {
            surfaceBtn.title = 'Google 3D tiles are still loading. The view will switch automatically once they are ready.';
        } else if (isPreparingTiles) {
            surfaceBtn.title = 'Preparing Google 3D tiles in the background, including height alignment. The TILE side will become instant once prep finishes.';
        } else {
            surfaceBtn.title = (googleTileState.mode === 'tiles')
                ? 'Switch back to the DSM height surface'
                : 'Switch from the DSM height surface to Google 3D tiles';
        }
        if (googleTileState.error && googleTileState.mode !== 'tiles') {
            surfaceBtn.title = `${surfaceBtn.title}. Last tile error: ${googleTileState.error}`;
        }
    }

}
function isGoogleTileSurfacePreparing() {
    const isAwaitingHeightAlignment = !!googleTileState.ready && !!googleTileState.manifest && !googleTileState.autoYOffsetReady;
    return !!googleTileState.preloadQueued ||
        (!!googleTileState.loading && !googleTileState.ready) ||
        isAwaitingHeightAlignment;
}
function updateGoogleTileYOffsetUI() {
    const slider = document.getElementById('tileYOffsetRange');
    const valueEl = document.getElementById('tileYOffsetVal');
    if (slider) slider.value = String(Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0);
    if (valueEl) valueEl.textContent = (Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0).toFixed(2);
}
function yieldGoogleTileWorkToBrowser() {
    return new Promise(resolve => {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
            return;
        }
        setTimeout(resolve, 0);
    });
}
function waitForGoogleTileBackgroundSlot(minDelayMs = 0) {
    return new Promise(resolve => {
        const continueWhenIdle = () => {
            if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(() => resolve(), { timeout: 1000 });
                return;
            }
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
                return;
            }
            setTimeout(resolve, 0);
        };
        if (minDelayMs > 0) {
            window.setTimeout(continueWhenIdle, minDelayMs);
            return;
        }
        continueWhenIdle();
    });
}
async function computeGoogleTileYOffsetByRaycastAsync(chunkSize = 4) {
    if (!scene || !mesh || !googleTileContentGroup || !googleTileState.manifest) return null;

    const roofSamples = buildRoofSamplePoints();
    if (!roofSamples.length) return null;

    const tempBox = new THREE.Box3();
    const meshWasVisible = mesh.visible;
    const tilesWereVisible = googleTileGeospatialRoot ? googleTileGeospatialRoot.visible : false;
    mesh.visible = true;
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = true;
    scene.updateMatrixWorld(true);

    const meshBox = tempBox.setFromObject(mesh).clone();
    const tileBox = new THREE.Box3().setFromObject(googleTileContentGroup);
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = tilesWereVisible;
    mesh.visible = meshWasVisible;

    if (meshBox.isEmpty() || tileBox.isEmpty()) return null;

    const sourceY = Math.max(meshBox.max.y, tileBox.max.y) + 20;
    const minY = Math.min(meshBox.min.y, tileBox.min.y) - 20;
    const rayLength = Math.max(50, sourceY - minY + 10);
    const raycasterLocal = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);
    const deltas = [];
    const safeChunkSize = Math.max(1, Math.floor(chunkSize || 1));

    let sampleIndex = 0;
    while (sampleIndex < roofSamples.length) {
        const oldMeshVisible = mesh.visible;
        const oldTilesVisible = googleTileGeospatialRoot ? googleTileGeospatialRoot.visible : false;
        mesh.visible = true;
        if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = true;
        scene.updateMatrixWorld(true);

        const stopIndex = Math.min(sampleIndex + safeChunkSize, roofSamples.length);
        for (; sampleIndex < stopIndex; sampleIndex += 1) {
            const sample = roofSamples[sampleIndex];
            origin.set(sample.sceneX, sourceY, sample.sceneZ);
            raycasterLocal.set(origin, direction);
            raycasterLocal.far = rayLength;

            const tileHits = raycasterLocal.intersectObject(googleTileContentGroup, true);
            if (!tileHits.length) continue;
            const meshHits = raycasterLocal.intersectObject(mesh, true);
            if (!meshHits.length) continue;

            const tileY = tileHits[0].point.y;
            const heightY = meshHits[0].point.y;
            if (Number.isFinite(tileY) && Number.isFinite(heightY)) {
                deltas.push(heightY - tileY);
            }
        }

        mesh.visible = oldMeshVisible;
        if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = oldTilesVisible;

        if (sampleIndex < roofSamples.length) {
            await waitForGoogleTileBackgroundSlot(GOOGLE_TILE_BACKGROUND_RAYCAST_SLICE_DELAY_MS);
        }
    }

    if (deltas.length < 12) return null;
    const median = getQuantile(deltas, 0.5);
    const low = getQuantile(deltas, 0.2);
    const high = getQuantile(deltas, 0.8);
    const trimmed = deltas.filter(v => v >= low && v <= high);
    const solved = trimmed.length
        ? (trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length)
        : median;
    return Number.isFinite(solved) ? solved : null;
}
function scheduleGoogleTileAutoYOffsetSolve() {
    if (!googleTileState.ready || !googleTileState.manifest || googleTileState.autoYOffsetReady) {
        return googleTileState.autoYOffsetPromise;
    }
    if (googleTileState.autoYOffsetPending && googleTileState.autoYOffsetPromise) {
        return googleTileState.autoYOffsetPromise;
    }
    const scheduledToken = googleTileState.loadToken;
    googleTileState.autoYOffsetPending = true;
    update3DSurfaceButtons();
    googleTileState.autoYOffsetPromise = (async () => {
        try {
            await waitForGoogleTileBackgroundSlot(0);
            if (scheduledToken !== googleTileState.loadToken || !googleTileState.ready || !googleTileState.manifest) return;
            const solvedOffset = await computeGoogleTileYOffsetByRaycastAsync(GOOGLE_TILE_BACKGROUND_RAYCAST_CHUNK_SIZE);
            if (scheduledToken !== googleTileState.loadToken || !googleTileState.manifest) return;
            if (Number.isFinite(solvedOffset)) {
                googleTileState.manualYOffset = (Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0) + solvedOffset;
                updateGoogleTileYOffsetUI();
                updateGoogleTileRootTransform(googleTileState.manifest);
                if (googleTileState.mode === 'tiles') {
                    apply3DSurfaceVisibility();
                }
            }
            googleTileState.autoYOffsetReady = true;
        } finally {
            if (scheduledToken === googleTileState.loadToken) {
                googleTileState.autoYOffsetPending = false;
                googleTileState.autoYOffsetPromise = null;
                update3DSurfaceButtons();
            }
        }
    })();
    return googleTileState.autoYOffsetPromise;
}
function scheduleDeferredGoogleTilePreload() {
    if (googleTileState.ready || googleTileState.loading || googleTileState.loadPromise || googleTileState.preloadQueued) return;
    const hasManifestUrl = !!get3DTileManifestUrl();
    if (!hasManifestUrl && !window.currentProjectId) return;
    const scheduledProjectId = window.currentProjectId;
    const scheduledToken = googleTileState.loadToken;
    const runPreload = async () => {
        if (window.currentProjectId !== scheduledProjectId || googleTileState.loadToken !== scheduledToken) {
            googleTileState.preloadQueued = false;
            update3DSurfaceButtons();
            return;
        }
        googleTileState.preloadQueued = false;
        update3DSurfaceButtons();
        try {
            await ensureGoogleTileSurfaceLoaded({
                allowGenerate: !hasManifestUrl,
                background: true,
                workerCount: 2,
                backgroundTileDelayMs: GOOGLE_TILE_BACKGROUND_TILE_DELAY_MS
            });
        } catch (error) {
            console.warn('[3D Tiles preload]', error);
        }
    };
    googleTileState.preloadQueued = true;
    update3DSurfaceButtons();
    const scheduleIdle = () => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => { void runPreload(); }, { timeout: 1500 });
            return;
        }
        window.setTimeout(() => { void runPreload(); }, 0);
    };
    window.setTimeout(scheduleIdle, GOOGLE_TILE_BACKGROUND_PRELOAD_DELAY_MS);
}
window.scheduleDeferredGoogleTilePreload = scheduleDeferredGoogleTilePreload;
function buildRoofSamplePoints(maxSamples = 60, maxAttempts = 5000) {
    if (!imageWidth || !imageHeight) return [];
    const samples = [];
    const seen = new Set();
    const margin = Math.max(3, Math.floor(Math.min(imageWidth, imageHeight) / 100));
    let attempts = 0;

    while (samples.length < maxSamples && attempts < maxAttempts) {
        attempts += 1;
        const x = Math.floor(margin + Math.random() * Math.max(1, imageWidth - margin * 2));
        const y = Math.floor(margin + Math.random() * Math.max(1, imageHeight - margin * 2));
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (typeof isMaskedPixel === 'function' && isMaskedPixel(x, y)) continue;
        if (!Number.isFinite(getDSMSceneHeightAtPixel(x, y))) continue;

        const scenePt = imagePointToSceneXZ(x, y);
        samples.push({ x, y, sceneX: scenePt.x, sceneZ: scenePt.z });
    }

    return samples;
}
function computeGoogleTileYOffsetByRaycast() {
    if (!scene || !mesh || !googleTileContentGroup || !googleTileState.manifest) return null;

    const roofSamples = buildRoofSamplePoints();
    if (!roofSamples.length) return null;

    const tempBox = new THREE.Box3();
    const meshWasVisible = mesh.visible;
    const tilesWereVisible = googleTileGeospatialRoot ? googleTileGeospatialRoot.visible : false;
    mesh.visible = true;
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = true;
    scene.updateMatrixWorld(true);

    const meshBox = tempBox.setFromObject(mesh).clone();
    const tileBox = new THREE.Box3().setFromObject(googleTileContentGroup);
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = tilesWereVisible;
    mesh.visible = meshWasVisible;

    if (meshBox.isEmpty() || tileBox.isEmpty()) return null;

    const sourceY = Math.max(meshBox.max.y, tileBox.max.y) + 20;
    const minY = Math.min(meshBox.min.y, tileBox.min.y) - 20;
    const rayLength = Math.max(50, sourceY - minY + 10);
    const raycasterLocal = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);
    const deltas = [];

    const oldMeshVisible = mesh.visible;
    const oldTilesVisible = googleTileGeospatialRoot ? googleTileGeospatialRoot.visible : false;
    mesh.visible = true;
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = true;
    scene.updateMatrixWorld(true);

    for (const sample of roofSamples) {
        origin.set(sample.sceneX, sourceY, sample.sceneZ);
        raycasterLocal.set(origin, direction);
        raycasterLocal.far = rayLength;

        const tileHits = raycasterLocal.intersectObject(googleTileContentGroup, true);
        if (!tileHits.length) continue;
        const meshHits = raycasterLocal.intersectObject(mesh, true);
        if (!meshHits.length) continue;

        const tileY = tileHits[0].point.y;
        const heightY = meshHits[0].point.y;
        if (Number.isFinite(tileY) && Number.isFinite(heightY)) {
            deltas.push(heightY - tileY);
        }
    }

    mesh.visible = oldMeshVisible;
    if (googleTileGeospatialRoot) googleTileGeospatialRoot.visible = oldTilesVisible;

    if (deltas.length < 12) return null;
    const median = getQuantile(deltas, 0.5);
    const low = getQuantile(deltas, 0.2);
    const high = getQuantile(deltas, 0.8);
    const trimmed = deltas.filter(v => v >= low && v <= high);
    const solved = trimmed.length
        ? (trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length)
        : median;
    return Number.isFinite(solved) ? solved : null;
}
window.fitGoogleTileVerticalOffsetByRaycast = function() {
    const solvedOffset = computeGoogleTileYOffsetByRaycast();
    if (!Number.isFinite(solvedOffset)) return null;
    const nextOffset = (Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0) + solvedOffset;
    window.setGoogleTileVerticalOffset(nextOffset);
    return nextOffset;
};
window.setGoogleTileVerticalOffset = function(offsetValue) {
    const parsed = Number(offsetValue);
    const safeOffset = Number.isFinite(parsed) ? parsed : 0;
    googleTileState.manualYOffset = Math.min(GOOGLE_TILE_Y_OFFSET_MAX, Math.max(GOOGLE_TILE_Y_OFFSET_MIN, safeOffset));
    updateGoogleTileYOffsetUI();
    if (googleTileState.manifest) {
        updateGoogleTileRootTransform(googleTileState.manifest);
        apply3DSurfaceVisibility();
    }
};
function ensureGoogleTileLoaders() {
    if (googleTileGltfLoader) return googleTileGltfLoader;
    if (!THREE.GLTFLoader || !THREE.DRACOLoader) {
        throw new Error('GLTF loader scripts are not available for Google 3D tile loading.');
    }
    googleTileDracoLoader = new THREE.DRACOLoader();
    googleTileDracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    googleTileGltfLoader = new THREE.GLTFLoader();
    googleTileGltfLoader.setDRACOLoader(googleTileDracoLoader);
    return googleTileGltfLoader;
}
function loadGltfScene(url, loader) {
    return new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
    });
}
async function getGoogleTileManifest(forceReload = false) {
    const manifestUrl = get3DTileManifestUrl();
    if (!manifestUrl) {
        throw new Error('This project does not have a saved Google 3D tile capture.');
    }
    if (!forceReload && googleTileState.manifest && googleTileState.manifestUrl === manifestUrl) {
        return googleTileState.manifest;
    }
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`3D tile manifest failed to load (${response.status}).`);
    }
    const manifest = await response.json();
    googleTileState.manifestUrl = manifestUrl;
    googleTileState.manifest = manifest;
    return manifest;
}
function updateGoogleTileImageOverrideTexture() {
    const sourceCanvas = getCurrent3DImageCanvas();
    if (!sourceCanvas) return;
    disposeGoogleTileProjectionTexture();
    googleTileProjectionTexture = tuneGoogleTileTexture(new THREE.CanvasTexture(sourceCanvas));
    googleTileProjectionMaterials.forEach(material => {
        updateGoogleTileProjectionUniforms(material);
        material.needsUpdate = true;
    });
}
async function ensureGoogleTileImageOverrideReady(forceRebuild = false) {
    if (!googleTileState.ready || !googleTileState.manifest || !googleTileContentGroup) return false;
    if (!forceRebuild && googleTileState.imageOverrideReady && googleTileProjectionTexture) {
        updateGoogleTileImageOverrideTexture();
        return true;
    }
    updateGoogleTileImageOverrideTexture();
    googleTileState.imageOverrideReady = !!googleTileProjectionTexture;
    googleTileProjectionMaterials.forEach(material => {
        updateGoogleTileProjectionUniforms(material);
        material.needsUpdate = true;
    });
    return googleTileState.imageOverrideReady;
}
function validateManifestForProject(manifest) {
    if (!manifest || !manifest.anchor) {
        throw new Error('3D tile manifest is missing its anchor definition.');
    }
    if (!Number.isFinite(mapCenterLat) || !Number.isFinite(mapCenterLng)) return true;
    const distance = haversineMeters(mapCenterLat, mapCenterLng, manifest.anchor.lat, manifest.anchor.lon);
    const allowance = Math.max(MAX_3D_TILE_PROJECT_DISTANCE_METERS, (manifest.anchor.radiusMeters || 100) * 2);
    if (distance > allowance) {
        return false;
    }
    return true;
}
async function ensureGoogleTileSurfaceLoaded(options = {}) {
    const allowGenerate = !!options.allowGenerate;
    const isBackgroundLoad = !!options.background;
    const requestedWorkerCount = Number(options.workerCount);
    const requestedBackgroundTileDelayMs = Number(options.backgroundTileDelayMs);
    const backgroundTileDelayMs = Number.isFinite(requestedBackgroundTileDelayMs) && requestedBackgroundTileDelayMs >= 0
        ? requestedBackgroundTileDelayMs
        : GOOGLE_TILE_BACKGROUND_TILE_DELAY_MS;
    const workerCount = Number.isFinite(requestedWorkerCount) && requestedWorkerCount > 0
        ? Math.max(1, Math.floor(requestedWorkerCount))
        : (isBackgroundLoad ? 1 : 4);
    ensureGoogleTileSceneRoots();
    if (googleTileState.ready) {
        updateGoogleTileRootTransform(googleTileState.manifest);
        return true;
    }
    if (googleTileState.loadPromise) return googleTileState.loadPromise;

    const token = ++googleTileState.loadToken;
    googleTileState.preloadQueued = false;
    googleTileState.loading = true;
    googleTileState.error = null;
    update3DSurfaceButtons();

    googleTileState.loadPromise = (async () => {
        const loader = ensureGoogleTileLoaders();
        let initialManifestUrl = get3DTileManifestUrl();
        if (!initialManifestUrl && allowGenerate) {
            await requestProjectGoogleTileCapture(true);
            initialManifestUrl = get3DTileManifestUrl();
        }
        if (!initialManifestUrl) {
            googleTileState.ready = false;
            googleTileState.error = 'No local Google 3D tile capture has been prepared for this property yet.';
            clearGoogleTileSurface();
            return false;
        }
        let manifest = await getGoogleTileManifest();
        let manifestMatchesProject = validateManifestForProject(manifest);
        if (!manifestMatchesProject && allowGenerate) {
            await requestProjectGoogleTileCapture(true);
            manifest = await getGoogleTileManifest(true);
            manifestMatchesProject = validateManifestForProject(manifest);
        }
        if (!manifestMatchesProject) {
            googleTileState.ready = false;
            googleTileState.error = isUsingDefault3DTileManifest()
                ? 'No local Google 3D tile capture has been prepared for this property yet.'
                : 'The configured Google 3D tile capture does not match this property.';
            clearGoogleTileSurface();
            return false;
        }
        updateGoogleTileRootTransform(manifest);
        clearGoogleTileSurface();

        const manifestUrl = new URL(googleTileState.manifestUrl, window.location.href);
        const tileBaseUrl = new URL('./tiles/', manifestUrl).href;
        const tiles = Array.isArray(manifest.tiles) ? manifest.tiles.slice() : [];
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(workerCount, Math.max(tiles.length, 1)) }, async () => {
            while (true) {
                if (isBackgroundLoad) {
                    await waitForGoogleTileBackgroundSlot(backgroundTileDelayMs);
                }
                if (token !== googleTileState.loadToken) return;
                const tileIndex = nextIndex++;
                if (tileIndex >= tiles.length) return;
                const tile = tiles[tileIndex];
                if (!tile || !tile.file) continue;
                const gltf = await loadGltfScene(tileBaseUrl + tile.file, loader);
                if (token !== googleTileState.loadToken) return;
                gltf.scene.traverse(obj => {
                    if (!obj.isMesh) return;
                    obj.castShadow = false;
                    obj.receiveShadow = true;
                    obj.material = Array.isArray(obj.material)
                        ? obj.material.map(material => tuneGoogleTileMaterial(material))
                        : tuneGoogleTileMaterial(obj.material);
                });
                googleTileContentGroup.add(gltf.scene);
                if (isBackgroundLoad) {
                    await yieldGoogleTileWorkToBrowser();
                }
            }
        });

        await Promise.all(workers);
        if (token !== googleTileState.loadToken) return;
        googleTileState.ready = true;
        googleTileState.manifest = manifest;
        googleTileState.autoYOffsetReady = false;
        googleTileState.autoYOffsetPending = false;
        googleTileState.autoYOffsetPromise = null;
        const autoYOffsetPromise = scheduleGoogleTileAutoYOffsetSolve();
        if (autoYOffsetPromise) {
            try {
                await autoYOffsetPromise;
            } catch (autoYOffsetError) {
                console.warn('[3D Tiles] Background height alignment failed', autoYOffsetError);
            }
        }
        return true;
    })().catch(error => {
        googleTileState.error = error && error.message ? error.message : 'Unknown Google 3D tile error.';
        clearGoogleTileSurface();
        throw error;
    }).finally(() => {
        if (token === googleTileState.loadToken) {
            googleTileState.loading = false;
            googleTileState.loadPromise = null;
            apply3DSurfaceVisibility();
            update3DSurfaceButtons();
        }
    });

    return googleTileState.loadPromise;
}
// =========================================================
// §2  UI BUILDERS  (all 3D-panel UI created from JS)
// =========================================================
function build3DControlPanel() {
    const container = document.getElementById('three-container');
    if (!container || _enh.controlsBuilt) return;
    _enh.controlsBuilt = true;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const wrapper = document.getElementById('three-view-wrapper');
    if (wrapper) {
        wrapper.querySelectorAll('.controls-3d-overlay, .controls-3d-actions').forEach(el => el.remove());
    }
    const panel = document.createElement('div');
    panel.className = 'enh-control-panel';
    // (A) Crop slider
    const cropGroup = document.createElement('div');
    cropGroup.className = 'enh-crop-group';
    const cropLabel = document.createElement('span');
    cropLabel.textContent = 'Crop';
    cropLabel.title = 'Ctrl + Scroll to adjust';
    let cropSlider = document.getElementById('cropRange');
    if (!cropSlider) {
        cropSlider = document.createElement('input');
        cropSlider.type = 'range'; cropSlider.id = 'cropRange';
        cropSlider.min = '0'; cropSlider.max = '100'; cropSlider.value = '0';
    } else if (cropSlider.parentElement) { cropSlider.parentElement.removeChild(cropSlider); }
    cropSlider.style.display = '';
    cropSlider.addEventListener('input', () => { if (typeof update3DCrop === 'function') update3DCrop(); });
    cropGroup.appendChild(cropLabel); cropGroup.appendChild(cropSlider);
    panel.appendChild(cropGroup);
    panel.appendChild(_sep());
    // (B) Image toggle
    const imgBtn = document.createElement('button');
    imgBtn.id = 'btnToggleImage3D'; imgBtn.className = 'enh-btn active';
    imgBtn.textContent = 'IMG'; imgBtn.title = 'Toggle 3D Image Layer';
    imgBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof toggle3DImage === 'function') toggle3DImage();
    });
    panel.appendChild(imgBtn);
    panel.appendChild(_sep());
    // (C) Surface toggle (DSM / Google 3D Tiles)
    const surfaceBtn = document.createElement('div');
    surfaceBtn.id = 'btnToggleSurface3D';
    surfaceBtn.className = 'enh-toggle-track enh-surface-toggle';
    surfaceBtn.title = 'Switch from the DSM height surface to Google 3D tiles';
    surfaceBtn.setAttribute('data-state', 'left');
    surfaceBtn.setAttribute('role', 'button');
    surfaceBtn.setAttribute('tabindex', '0');
    surfaceBtn.setAttribute('aria-label', 'Toggle between DSM and Google 3D tiles');
    surfaceBtn.innerHTML = '<span class="enh-toggle-label enh-toggle-label-left">MAP</span><span class="enh-toggle-label enh-toggle-label-right">TILE</span><div class="enh-toggle-thumb"></div>';
    surfaceBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (typeof window.toggle3DSurfaceMode === 'function') await window.toggle3DSurfaceMode();
    });
    surfaceBtn.addEventListener('keydown', async e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof window.toggle3DSurfaceMode === 'function') await window.toggle3DSurfaceMode();
    });
    panel.appendChild(surfaceBtn);
    panel.appendChild(_sep());
    // (D) Tile Y offset
    const tileYGroup = document.createElement('div');
    tileYGroup.className = 'enh-crop-group';
    const tileYLabel = document.createElement('span');
    tileYLabel.textContent = 'Tile Y';
    tileYLabel.title = 'Raise or lower Google 3D tiles without affecting X/Z alignment';
    const tileYSlider = document.createElement('input');
    tileYSlider.type = 'range';
    tileYSlider.id = 'tileYOffsetRange';
    tileYSlider.min = String(GOOGLE_TILE_Y_OFFSET_MIN);
    tileYSlider.max = String(GOOGLE_TILE_Y_OFFSET_MAX);
    tileYSlider.step = String(GOOGLE_TILE_Y_OFFSET_STEP);
    tileYSlider.value = String(Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0);
    tileYSlider.addEventListener('input', () => window.setGoogleTileVerticalOffset(tileYSlider.value));
    const tileYValue = document.createElement('span');
    tileYValue.id = 'tileYOffsetVal';
    tileYValue.textContent = (Number.isFinite(googleTileState.manualYOffset) ? googleTileState.manualYOffset : 0).toFixed(2);
    tileYGroup.appendChild(tileYLabel);
    tileYGroup.appendChild(tileYSlider);
    tileYGroup.appendChild(tileYValue);
    const tileYFitBtn = document.createElement('button');
    tileYFitBtn.className = 'enh-btn';
    tileYFitBtn.textContent = 'FIT Y';
    tileYFitBtn.title = 'Sample both surfaces with vertical raycasts and estimate a good tile Y offset';
    tileYFitBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof window.fitGoogleTileVerticalOffsetByRaycast === 'function') {
            window.fitGoogleTileVerticalOffsetByRaycast();
        }
    });
    tileYGroup.appendChild(tileYFitBtn);
    panel.appendChild(tileYGroup);
    panel.appendChild(_sep());
    // (E) Projection toggle (TRI / ISO)
    const projToggle = document.createElement('div');
    projToggle.className = 'enh-toggle-track'; projToggle.id = 'projectionToggle';
    projToggle.title = 'Switch Trimetric / Isometric';
    projToggle.setAttribute('data-state', _enh.isOrthographic ? 'right' : 'left');
    projToggle.innerHTML = '<span class="enh-toggle-label enh-toggle-label-left">ISO</span><span class="enh-toggle-label enh-toggle-label-right">TRI</span><div class="enh-toggle-thumb"></div>';
    projToggle.addEventListener('click', e => { e.stopPropagation(); window.toggleProjection(); });
    panel.appendChild(projToggle);
    panel.appendChild(_sep());
    // (F) Pitch toggle
    const pitchBtn = document.createElement('button');
    pitchBtn.id = 'btnTogglePitch';
    pitchBtn.className = 'enh-btn' + (_enh.showPitchLabels ? ' active' : '');
    pitchBtn.textContent = 'PITCH'; pitchBtn.title = 'Toggle pitch labels on faces';
    pitchBtn.addEventListener('click', e => { e.stopPropagation(); window.togglePitchLabels(); });
    panel.appendChild(pitchBtn);
    container.appendChild(panel);
    update3DSurfaceButtons();
    updateGoogleTileYOffsetUI();
    // Selection box for 3D
    if (!document.getElementById('selection-box-3d')) {
        const selBox = document.createElement('div');
        selBox.id = 'selection-box-3d';
        (wrapper || container).appendChild(selBox);
    }
}
function _sep() {
    const d = document.createElement('div'); d.className = 'enh-separator'; return d;
}
function buildAxisWidget() {
    const container = document.getElementById('three-container');
    if (!container || _enh.axisBuilt) return;
    if (typeof THREE === 'undefined') return;
    _enh.axisBuilt = true;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const SIZE = _enh.axisSize;
    _enh.axisContainer = document.createElement('div');
    _enh.axisContainer.id = 'axis-gizmo-container';
    Object.assign(_enh.axisContainer.style, {
        position:'absolute',top:'8px',right:'8px',width:SIZE+'px',height:SIZE+'px',
        zIndex:'100',borderRadius:'6px',background:'rgba(0,0,0,0.35)',
        border:'1px solid rgba(255,255,255,0.15)'
    });
    container.appendChild(_enh.axisContainer);
    _enh.axisRenderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    _enh.axisRenderer.setSize(SIZE, SIZE);
    _enh.axisRenderer.setPixelRatio(window.devicePixelRatio || 1);
    _enh.axisRenderer.setClearColor(0x000000, 0);
    _enh.axisContainer.appendChild(_enh.axisRenderer.domElement);
    _enh.axisScene = new THREE.Scene();
    const d = 3;
    _enh.axisCamera = new THREE.OrthographicCamera(-d, d, d, -d, 0.1, 100);
    _enh.axisCamera.position.set(2, 2, 2);
    _enh.axisCamera.lookAt(0, 0, 0);
    const axisDefs = [
        { dir:[1,0,0], color:0xff4444, label:'X' },
        { dir:[0,1,0], color:0x44cc44, label:'Y' },
        { dir:[0,0,1], color:0x4488ff, label:'Z' }
    ];
    const axisLen = 1.6;
    axisDefs.forEach(def => {
        const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0),
            new THREE.Vector3(def.dir[0]*axisLen, def.dir[1]*axisLen, def.dir[2]*axisLen)
        ]);
        _enh.axisScene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({color:def.color,linewidth:2})));
        const sGeo = new THREE.SphereGeometry(0.2,12,12);
        const sphere = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({color:def.color}));
        sphere.position.set(def.dir[0]*axisLen, def.dir[1]*axisLen, def.dir[2]*axisLen);
        _enh.axisScene.add(sphere);
    });
    _enh.axisScene.add(new THREE.Mesh(new THREE.SphereGeometry(0.15,12,12), new THREE.MeshBasicMaterial({color:0x888888})));
    _enh.axisScene.add(new THREE.AmbientLight(0xffffff,1));
    // Clickable labels
    const labelDefs = [
        {label:'X',display:'X',color:'#ff6666',positive:true,view:'Right'},
        {label:'Y',display:'Y',color:'#66dd66',positive:true,view:'Top'},
        {label:'Z',display:'Z',color:'#66aaff',positive:true,view:'Front'},
        {label:'-X',display:'−X',color:'#ff6666',positive:false,view:'Left'},
        {label:'-Y',display:'−Y',color:'#66dd66',positive:false,view:'Bottom'},
        {label:'-Z',display:'−Z',color:'#66aaff',positive:false,view:'Back'}
    ];
    labelDefs.forEach(def => {
        const el = document.createElement('div');
        el.textContent = def.display;
        el.className = 'axis-label-el ' + (def.positive ? 'positive' : 'negative');
        el.style.color = def.color; el.style.display = 'none'; el.title = def.view + ' view';
        el.addEventListener('click', e => { e.stopPropagation(); setCameraPresetView(def.label); _flashViewName(def.view); });
        _enh.axisContainer.appendChild(el);
        _enh.axisLabelEls[def.label] = el;
    });
    const viewName = document.createElement('div');
    viewName.className = 'axis-view-name'; viewName.id = 'axis-view-name';
    _enh.axisContainer.appendChild(viewName);
    _enh.axisRenderer.render(_enh.axisScene, _enh.axisCamera);
    _updateAxisLabels();
}
function _flashViewName(name) {
    const el = document.getElementById('axis-view-name');
    if (!el) return;
    el.textContent = name; el.style.color = 'rgba(255,255,255,0.7)';
    setTimeout(() => { el.style.color = 'rgba(255,255,255,0.4)'; }, 800);
    setTimeout(() => { el.textContent = ''; }, 2000);
}
function _updateAxisLabels() {
    if (!_enh.axisCamera || !_enh.axisLabelEls['X']) return;
    const SIZE = _enh.axisSize;
    const positions = [
        {label:'X',pos:[1.92,0,0]},{label:'Y',pos:[0,1.92,0]},{label:'Z',pos:[0,0,1.92]},
        {label:'-X',pos:[-0.48,0,0]},{label:'-Y',pos:[0,-0.48,0]},{label:'-Z',pos:[0,0,-0.48]}
    ];
    positions.forEach(def => {
        const v = new THREE.Vector3(def.pos[0],def.pos[1],def.pos[2]);
        v.project(_enh.axisCamera);
        const x = (v.x*0.5+0.5)*SIZE, y = (-(v.y*0.5)+0.5)*SIZE;
        const el = _enh.axisLabelEls[def.label];
        if (el) { el.style.left = x+'px'; el.style.top = y+'px'; el.style.display = (v.z<1)?'block':'none'; }
    });
}
function _updateAxisWidget() {
    if (!_enh.axisRenderer || !_enh.axisCamera || typeof camera === 'undefined' || !camera) return;
    _enh.axisCamera.position.copy(camera.position).normalize().multiplyScalar(5);
    _enh.axisCamera.lookAt(0,0,0);
    _enh.axisCamera.up.copy(camera.up);
    _enh.axisRenderer.render(_enh.axisScene, _enh.axisCamera);
    _updateAxisLabels();
}
function ensure3DLoadingOverlay() {
    const wrapper = document.getElementById('three-view-wrapper');
    if (!wrapper || document.getElementById('three-loader')) return;
    const overlay = document.createElement('div');
    overlay.id = 'three-loader';
    overlay.innerHTML = '<div class="slick-spinner"></div><div class="loader-text">Resolving Topology...</div>';
    wrapper.appendChild(overlay);
}
function toggle3DLoader(show) {
    ensure3DLoadingOverlay();
    const loader = document.getElementById('three-loader');
    if (loader) loader.classList.toggle('visible', !!show);
}
// =========================================================
// §3  INIT 3D  (core setup + UI build)
// =========================================================
function init3D() {
    if (!layerData.dsm || !layerData.rgb) return;
    const container = document.getElementById('three-container');
    const wrapper = document.getElementById('three-view-wrapper');
    if (!container || !wrapper) return;
    container.innerHTML = '';
    markers3D = []; lines3D = [];
    const metrics = getThreeViewportMetrics();
    const w = (metrics && metrics.width) || 600;
    const h = (metrics && metrics.height) || 400;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202124);
    camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 2000);
    camera.position.set(0, 80, 100);
    renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true, powerPreference:'high-performance' });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h, false);
    if ('toneMapping' in renderer && typeof THREE.NoToneMapping !== 'undefined') {
        renderer.toneMapping = THREE.NoToneMapping;
    }
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);
    raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 1.0;
    mouse = new THREE.Vector2();
    wrapper.removeEventListener('pointerdown', onMouseDown3D, true);
    wrapper.removeEventListener('pointermove', onMouseMove3D, false);
    window.removeEventListener('pointerup', onMouseUp3D, false);
    wrapper.removeEventListener('mouseenter', handle3DWrapperMouseEnter);
    wrapper.removeEventListener('mouseleave', handle3DWrapperMouseLeave);
    wrapper.addEventListener('pointerdown', onMouseDown3D, true);
    wrapper.addEventListener('pointermove', onMouseMove3D, false);
    window.addEventListener('pointerup', onMouseUp3D, false);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI/2; controls.minDistance = 0.1;
    controls.mouseButtons = { LEFT:null, MIDDLE:THREE.MOUSE.ROTATE, RIGHT:THREE.MOUSE.PAN };
    controls.addEventListener('change', () => {
        if (selectedLines.size > 0 || selectedPoints.size > 0) _geomDirty3D = true;
        if (_enh.showPitchLabels) renderPitchLabels();
    });
    surfaceHemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(surfaceHemiLight);
    surfaceDirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    surfaceDirLight.position.set(50, 100, 50);
    scene.add(surfaceDirLight);
    surfaceAmbientLight = new THREE.AmbientLight(0xffffff, 0.0);
    scene.add(surfaceAmbientLight);
    const planeSize = getScenePlaneSize();
    geometry = new THREE.PlaneGeometry(planeSize.width, planeSize.height, imageWidth-1, imageHeight-1);
    const dsm = layerData.dsm[0];
    dsmMin = Infinity; dsmMax = -Infinity;
    for (let i = 0; i < dsm.length; i++) {
        if (dsm[i] > -9000) { dsmMin = Math.min(dsmMin, dsm[i]); dsmMax = Math.max(dsmMax, dsm[i]); }
    }
    const solarCanvas = ensureViewCanvas('solar');
    const texture = solarCanvas ? new THREE.CanvasTexture(solarCanvas) : null;
    const material = new THREE.MeshStandardMaterial({ map:texture, side:THREE.DoubleSide, roughness:0.8, metalness:0.2 });
    mesh = new THREE.Mesh(geometry, material);
    mesh.userData = {
        ...(mesh.userData || {}),
        imageWidth,
        imageHeight,
        sceneWidth: planeSize.width,
        sceneHeight: planeSize.height,
        radiusMeters: window.getRadiusMeters ? Number(window.getRadiusMeters()) : Number(window.RADIUS_METERS || 0)
    };
    mesh.rotation.x = -Math.PI/2;
    scene.add(mesh);
    googleTileState.loadToken += 1;
    googleTileState.loading = false;
    googleTileState.preloadQueued = false;
    googleTileState.autoYOffsetReady = false;
    googleTileState.autoYOffsetPending = false;
    googleTileState.autoYOffsetPromise = null;
    googleTileState.loadPromise = null;
    googleTileState.ready = false;
    googleTileState.error = null;
    googleTileState.imageOverrideReady = false;
    googleTileState.imageOverridePromise = null;
    googleTileState.capturePromise = null;
    googleTileGeospatialRoot = null;
    googleTileCalibrationRoot = null;
    googleTileContentGroup = null;
    googleTileImageOverrideGroup = null;
    ensureGoogleTileSceneRoots();
    geometryGroup = new THREE.Group(); scene.add(geometryGroup);
    facesGroup = new THREE.Group(); scene.add(facesGroup);
    snapGuidesGroup = new THREE.Group(); scene.add(snapGuidesGroup);
    refreshMaskImageData(); update3DCrop();
    apply3DSurfaceVisibility();
    update3DSurfaceButtons();
    if (activeGeometry) renderGeometry3D();
    scheduleDeferredGoogleTilePreload();
    // Ctrl+Scroll on 3D -> adjust crop
    renderer.domElement.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault(); e.stopPropagation();
        const slider = document.getElementById('cropRange');
        if (!slider) return;
        const step = 2, delta = e.deltaY < 0 ? step : -step;
        let val = parseFloat(slider.value) + delta;
        val = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), val));
        if (val !== parseFloat(slider.value)) { slider.value = val; update3DCrop(); }
    }, { capture:true, passive:false });
    window.removeEventListener('resize', handle3DWindowResize);
    window.addEventListener('resize', handle3DWindowResize);
    observeThreeViewportSize();
    // Build all enhancement UI
    _enh.controlsBuilt = false; _enh.axisBuilt = false; _enh.pitchOverlayContainer = null;
    build3DControlPanel(); buildAxisWidget();
    sync3DViewportSize();
    if (activeGeometry && activeGeometry.points && activeGeometry.points.length) {
        window.queueFit3DViewToActiveGeometry();
        setTimeout(() => window.queueFit3DViewToActiveGeometry(), 120);
    }
    // Start unified animation loop (only once)
    if (!_enh.animLoopStarted) { _enh.animLoopStarted = true; _animate3D(); }
    // Mouse enter/leave for keyboard scope
    wrapper.addEventListener('mouseenter', handle3DWrapperMouseEnter);
    wrapper.addEventListener('mouseleave', handle3DWrapperMouseLeave);
}
// =========================================================
// §4  ENSURE POINTS HAVE Z
// =========================================================
window.ensureAllPointsHaveZ = function () {
    if (!activeGeometry || !activeGeometry.points) return;
    const dsm = (layerData && layerData.dsm) ? layerData.dsm[0] : null;
    if (!dsm) return;
    const w = imageWidth, h = imageHeight;
    activeGeometry.points.forEach(p => {
        if (p.z === null || p.z === undefined) {
            const ix = Math.max(0, Math.min(w-1, Math.round(p.x)));
            const iy = Math.max(0, Math.min(h-1, Math.round(p.y)));
            const val = dsm[iy*w+ix];
            p.z = (val > -9000) ? val : 0;
        }
    });
};
// =========================================================
// §5  INTERACTION HANDLERS
// =========================================================
function onMouseDown3D(event) {
    if (event.button !== 0) return;
    // Guard both old-style and new-style control containers
    if (event.target.closest('.enh-control-panel') || event.target.closest('#axis-gizmo-container') ||
        event.target.closest('.controls-3d-actions') || event.target.closest('.controls-3d-overlay')) return;
    // Guard pitch label clicks (lock toggle) — don't start 3D selection
    if (event.target.closest('#pitch-label-overlay')) return;
    const altDebugGroup = window.__altDebug3DGroup;
    if (typeof window.__inspectAltDebugFaceObject === 'function' && altDebugGroup && altDebugGroup.children && altDebugGroup.children.length) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const debugHit = raycaster.intersectObjects(altDebugGroup.children, true)
            .find(hit => hit.object?.userData?.altFaceDebugFace);
        if (debugHit) {
            const data = debugHit.object.userData;
            window.__inspectAltDebugFaceObject(data.altFaceDebugFace, data.altFaceDebugLabel || '3D debug face', event);
            return;
        }
    }
    if (interactState3D === 'RESIZING_Z') {
        interactState3D = 'IDLE'; zResizeState.active = false; zResizeState.originals.clear();
        document.body.style.cursor = 'default';
        if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate(); return;
    }
    if (interactState3D === 'MOVING') {
        interactState3D = 'IDLE'; updateSnapGuides(null);
        if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate(); return;
    }
    isSelecting3D = true;
    const rect = renderer.domElement.getBoundingClientRect();
    selectBox3DStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
        selectedPoints.clear(); selectedLines.clear(); selectedFaceSignatures.clear();
        renderGeometry2D(); renderGeometry3D(); updateFaceSelectionVisualsOnly3D();
    }
    const box = document.getElementById('selection-box-3d');
    if (box) {
        box.style.display = 'block';
        box.style.left = selectBox3DStart.x+'px'; box.style.top = selectBox3DStart.y+'px';
        box.style.width = '0px'; box.style.height = '0px';
    }
    event.stopPropagation();
    if (event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId);
}
function onMouseMove3D(event) {
    last3DMouseClientY = event.clientY;
    const rect = renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left, mouseY = event.clientY - rect.top;
    // Z-RESIZING
    if (interactState3D === 'RESIZING_Z' && zResizeState.active) {
        const deltaPixels = zResizeState.startMouseY - event.clientY;
        let scale = 1.0 + (deltaPixels * 0.005);
        if (scale < 0.01) scale = 0.01;
        const anchor = zResizeState.anchorZ;
        selectedPoints.forEach(pt => {
            if (isPointFacetLocked(pt)) return; // Skip locked-face points
            const originalZ = zResizeState.originals.get(pt);
            if (originalZ !== undefined) { pt.z = anchor + (originalZ - anchor) * scale; pt.zLocked = true; }
        });
        renderGeometry3D(); renderFinalPass(true); return;
    }
    // Box Drawing
    if (isSelecting3D) {
        const box = document.getElementById('selection-box-3d');
        if (box) {
            box.style.width = Math.abs(mouseX - selectBox3DStart.x)+'px';
            box.style.height = Math.abs(mouseY - selectBox3DStart.y)+'px';
            box.style.left = Math.min(mouseX, selectBox3DStart.x)+'px';
            box.style.top = Math.min(mouseY, selectBox3DStart.y)+'px';
        }
    }
    // Vertical Movement
    if (interactState3D === 'MOVING' && selectedPoints.size > 0) {
        if (moveStartY_3D === -9999) { moveStartY_3D = mouseY; return; }
        if (typeof flattenState !== 'undefined') flattenState.signature = '';
        const deltaPixels = mouseY - moveStartY_3D;
        const deltaZ = -deltaPixels * 0.02;
        selectedPoints.forEach(pt => {
            let origZ = zMoveOriginals.get(pt);
            if (origZ === undefined || origZ === null) {
                if (layerData.dsm && layerData.dsm[0]) {
                    const dsm = layerData.dsm[0];
                    const ix = Math.max(0, Math.min(imageWidth-1, Math.round(pt.x)));
                    const iy = Math.max(0, Math.min(imageHeight-1, Math.round(pt.y)));
                    const val = dsm[iy*imageWidth+ix];
                    origZ = (val > -9000) ? val : 0;
                } else { origZ = 0; }
                zMoveOriginals.set(pt, origZ);
            }
            if (isPointFacetLocked(pt)) return; // Skip locked-face points in 3D
            let rawNewZ = origZ + deltaZ;
            if (!isFreeMove && selectedPoints.size === 1) {
                const snap = calculate3DSnap(pt, rawNewZ);
                if (snap) { pt.z = snap.z; updateSnapGuides(snap.guide); }
                else { pt.z = rawNewZ; updateSnapGuides(null); }
            } else { pt.z = rawNewZ; updateSnapGuides(null); }
            pt.zLocked = true;
        });
        renderGeometry3D();
        if (selectedFaceSignatures.size === 0) renderFinalPass(true);
    }
}
function onMouseUp3D(event) {
    if (event.target.releasePointerCapture && event.pointerId) {
        try { event.target.releasePointerCapture(event.pointerId); } catch(e) {}
    }
    if (interactState3D === 'MOVING') {
        updateSnapGuides(null);
        if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate();
    }
    if (interactState3D === 'RESIZING_Z') {
        interactState3D = 'IDLE'; zResizeState.active = false; zResizeState.originals.clear();
        document.body.style.cursor = 'default';
        if (typeof checkAndTriggerMeasurementUpdate === 'function') checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate(); return;
    }
    if (!isSelecting3D) return;
    isSelecting3D = false;
    const selBox = document.getElementById('selection-box-3d');
    if (selBox) selBox.style.display = 'none';
    const rect = renderer.domElement.getBoundingClientRect();
    const endX = event.clientX - rect.left, endY = event.clientY - rect.top;
    const dist = Math.hypot(endX - selectBox3DStart.x, endY - selectBox3DStart.y);
    const isDeselect = event.ctrlKey || event.metaKey;
    const handleSelection = (set, item) => { if (isDeselect) set.delete(item); else set.add(item); };
    const toScreenXY = (vec3) => {
        const v = vec3.clone(); v.project(camera);
        return { x: (v.x*0.5+0.5)*rect.width, y: (-(v.y*0.5)+0.5)*rect.height, z: v.z };
    };
    const distToSegSq = (p, v, w) => {
        const l2 = (v.x-w.x)**2 + (v.y-w.y)**2;
        if (l2===0) return (p.x-v.x)**2 + (p.y-v.y)**2;
        let t = ((p.x-v.x)*(w.x-v.x) + (p.y-v.y)*(w.y-v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        const px = v.x+t*(w.x-v.x), py = v.y+t*(w.y-v.y);
        return (p.x-px)**2 + (p.y-py)**2;
    };
    const pointSelectable3D = (pt) => {
        if (!pt) return false;
        const layer = pt.layer || 1;
        if (typeof layerVisibility !== 'undefined' && layerVisibility[layer] === false) return false;
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) return false;
        return true;
    };
    const lineSelectable3D = (conn) => {
        if (!conn || !conn.start || !conn.end) return false;
        if (!pointSelectable3D(conn.start) || !pointSelectable3D(conn.end)) return false;
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return false;
        return true;
    };
    const faceSelectable3D = (mesh, face) => {
        if (!mesh || !face) return false;
        const layer = parseInt(mesh.userData?.layer || face.layer || face.points?.[0]?.layer || 1, 10);
        if (typeof layerVisibility !== 'undefined' && layerVisibility[layer] === false) return false;
        if (mesh.visible === false) return false;
        if (Array.isArray(face.points) && face.points.some(pt => !pointSelectable3D(pt))) return false;
        return true;
    };
    // CLICK selection
    if (dist < 5) {
        const HIT = 12; let found = false;
        // Points
        let closestPt = null, minPtD = Infinity;
        activeGeometry.points.forEach(pt => {
            if (!pointSelectable3D(pt)) return;
            const s = toScreenXY(getVector3(pt)); if (s.z > 1) return;
            const d = Math.hypot(endX-s.x, endY-s.y);
            if (d < HIT && d < minPtD) { minPtD = d; closestPt = pt; }
        });
        if (closestPt) { handleSelection(selectedPoints, closestPt); found = true; }
        // Lines
        if (!found) {
            let closestL = null, minLD = Infinity;
            activeGeometry.connections.forEach(conn => {
                if (!lineSelectable3D(conn)) return;
                const s3 = toScreenXY(getVector3(conn.start)), e3 = toScreenXY(getVector3(conn.end));
                if (s3.z > 1 && e3.z > 1) return;
                const d = Math.sqrt(distToSegSq({x:endX,y:endY}, s3, e3));
                if (d < HIT && d < minLD) { minLD = d; closestL = conn; }
            });
            if (closestL) { handleSelection(selectedLines, closestL); found = true; }
        }
        // Faces (raycast)
        if (!found) {
            mouse.x = ((event.clientX-rect.left)/rect.width)*2-1;
            mouse.y = -((event.clientY-rect.top)/rect.height)*2+1;
            raycaster.setFromCamera(mouse, camera);
            const faceHit = raycaster.intersectObjects(facesGroup.children, false).find(i => {
                const face = i.object?.userData?.faceDef;
                return faceSelectable3D(i.object, face);
            });
            if (faceHit) {
                const face = faceHit.object.userData.faceDef;
                const sig = getLocalFaceSignature(face.points);
                if (isDeselect) { selectedFaceSignatures.delete(sig); face.points.forEach(p => selectedPoints.delete(p)); }
                else { selectedFaceSignatures.add(sig); face.points.forEach(p => selectedPoints.add(p)); }
            }
        }
    }
    // DRAG box selection
    else {
        const minX = Math.min(selectBox3DStart.x, endX), maxX = Math.max(selectBox3DStart.x, endX);
        const minY = Math.min(selectBox3DStart.y, endY), maxY = Math.max(selectBox3DStart.y, endY);
        activeGeometry.points.forEach(pt => {
            if (!pointSelectable3D(pt)) return;
            const vec = getVector3(pt); vec.project(camera);
            const sx = (vec.x*0.5+0.5)*rect.width, sy = (-(vec.y*0.5)+0.5)*rect.height;
            if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) handleSelection(selectedPoints, pt);
        });
    }
    renderGeometry3D(); updateFaceSelectionVisualsOnly3D(); renderGeometry2D();
    selectBox3DStart = null;
}
// =========================================================
// §6  3D SNAPPING
// =========================================================
function calculate3DSnap(movingPt, rawZ) {
    if (!activeGeometry) return null;
    const SNAP_THRESH = 0.2, COLLINEAR_TOL = 0.5;
    let bestSnap = null, minDiff = SNAP_THRESH;
    const neighbors = [];
    activeGeometry.connections.forEach(conn => {
        if (conn.start === movingPt) neighbors.push(conn.end);
        else if (conn.end === movingPt) neighbors.push(conn.start);
    });
    // Slope Snap
    for (let i = 0; i < neighbors.length; i++) {
        for (let j = i+1; j < neighbors.length; j++) {
            const A = neighbors[i], B = neighbors[j];
            const distAB = Math.hypot(A.x-B.x, A.y-B.y);
            const distAP = Math.hypot(A.x-movingPt.x, A.y-movingPt.y);
            const distPB = Math.hypot(movingPt.x-B.x, movingPt.y-B.y);
            if (Math.abs((distAP+distPB)-distAB) < COLLINEAR_TOL) {
                const t = distAP/distAB;
                const zA = (A.z !== null) ? A.z : 0, zB = (B.z !== null) ? B.z : 0;
                const idealZ = zA + (zB-zA)*t;
                const diff = Math.abs(rawZ - idealZ);
                if (diff < minDiff) { minDiff = diff; bestSnap = {z:idealZ, guide:{type:'slope',p1:A,p2:B}}; }
            }
        }
    }
    if (bestSnap) return bestSnap;
    // Height Snap
    for (let neighbor of neighbors) {
        if (neighbor.z === null) continue;
        const diff = Math.abs(rawZ - neighbor.z);
        if (diff < minDiff) { minDiff = diff; bestSnap = {z:neighbor.z, guide:{type:'flat',p1:movingPt,p2:neighbor,targetZ:neighbor.z}}; }
    }
    return bestSnap;
}
function updateSnapGuides(guideDef) {
    if (!snapGuidesGroup) return;
    while (snapGuidesGroup.children.length > 0) snapGuidesGroup.remove(snapGuidesGroup.children[0]);
    if (!guideDef) return;
    const mat = new THREE.LineBasicMaterial({color:0xffff00,linewidth:2,opacity:0.8,transparent:true,depthTest:false});
    let start, end;
    if (guideDef.type === 'slope') {
        const v1 = getVector3(guideDef.p1), v2 = getVector3(guideDef.p2);
        const dir = new THREE.Vector3().subVectors(v2,v1).normalize();
        start = v1.clone().addScaledVector(dir,-1000); end = v2.clone().addScaledVector(dir,1000);
    } else if (guideDef.type === 'flat') {
        const vM = getVector3(guideDef.p1), vT = getVector3(guideDef.p2);
        const fixedZ = (guideDef.targetZ-dsmMin)*getZScale()+0.5;
        vM.y = fixedZ; vT.y = fixedZ;
        const dir = new THREE.Vector3().subVectors(vM,vT).normalize();
        start = vT.clone().addScaledVector(dir,-1000); end = vT.clone().addScaledVector(dir,1000);
    }
    if (start && end) {
        const geo = new THREE.BufferGeometry().setFromPoints([start,end]);
        const line = new THREE.Line(geo,mat); line.renderOrder = 9999;
        snapGuidesGroup.add(line);
    }
}
// =========================================================
// §7  DELETION
// =========================================================
window.deleteSelected3D = function () {
    if (!activeGeometry) return;
    updateSnapGuides(null); save2DState();
    if (selectedFaceSignatures.size > 0) {
        selectedFaceSignatures.forEach(sig => {
            deletedFaceSignatures.add(sig);
            if (activeGeometry.manualFaces) {
                activeGeometry.manualFaces = activeGeometry.manualFaces.filter(mf => getFaceSignature(mf) !== sig);
            }
        });
        selectedFaceSignatures.clear();
    } else {
        if (selectedLines.size > 0) {
            if (typeof window.cleanupManualFacesAfterDeletedGeometry === 'function') {
                window.cleanupManualFacesAfterDeletedGeometry(selectedLines, selectedPoints);
            }
            activeGeometry.connections = activeGeometry.connections.filter(conn => !selectedLines.has(conn));
            selectedLines.clear();
        }
        if (selectedPoints.size > 0) {
            activeGeometry.connections = activeGeometry.connections.filter(conn => !selectedPoints.has(conn.start) && !selectedPoints.has(conn.end));
            if (typeof window.cleanupManualFacesAfterDeletedGeometry === 'function') {
                window.cleanupManualFacesAfterDeletedGeometry(new Set(), selectedPoints);
            } else if (activeGeometry.manualFaces) {
                activeGeometry.manualFaces = activeGeometry.manualFaces.filter(face => !face.points.some(p => selectedPoints.has(p)));
            }
            activeGeometry.points = activeGeometry.points.filter(pt => !selectedPoints.has(pt));
            selectedPoints.clear();
        }
    }
    if (typeof window.cleanupInvalidManualFaces === 'function') {
        window.cleanupInvalidManualFaces();
    }
    if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
    renderGeometry3D();
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
    if (typeof renderFinalPass === 'function') renderFinalPass();
    triggerLiveUpdate();
};
window.enterResizeMode3D = function () {
    if (!activeGeometry || selectedPoints.size === 0) return;
    if (typeof save2DState === 'function') save2DState();
    zResizeState.active = true; zResizeState.originals.clear();
    zResizeState.startMouseY = last3DMouseClientY;
    let minZ = Infinity;
    selectedPoints.forEach(pt => {
        let currentZ = pt.z;
        if (currentZ === null || currentZ === undefined) {
            if (layerData.dsm && layerData.dsm[0]) {
                const ix = Math.max(0, Math.min(imageWidth-1, Math.round(pt.x)));
                const iy = Math.max(0, Math.min(imageHeight-1, Math.round(pt.y)));
                currentZ = layerData.dsm[0][iy*imageWidth+ix];
            }
            if (!currentZ || currentZ <= -9000) currentZ = 0;
            pt.z = currentZ;
        }
        if (currentZ < minZ) minZ = currentZ;
        zResizeState.originals.set(pt, currentZ);
    });
    if (minZ === Infinity) minZ = 0;
    zResizeState.anchorZ = minZ;
    interactState3D = 'RESIZING_Z';
    document.body.style.cursor = 'ns-resize';
};
function getFaceSignature(face) {
    const coords = face.points.map(p => ({x:Math.round(p.x*10),y:Math.round(p.y*10)}));
    coords.sort((a,b) => (a.x-b.x)||(a.y-b.y));
    return coords.map(p => `${p.x},${p.y}`).join('|');
}
// =========================================================
// §8  GEOMETRY RENDERING (3D lines & points)
// =========================================================
function renderGeometry3D() {
    if (!window.enable3D) return;
    if (!scene || !geometryGroup || !activeGeometry || !layerData.dsm) return;
    while (geometryGroup.children.length > 0) {
        const child = geometryGroup.children[0];
        if (child.geometry) child.geometry.dispose();
        if (child.material) { if (Array.isArray(child.material)) child.material.forEach(m => m && m.dispose && m.dispose()); else if (child.material.dispose) child.material.dispose(); }
        geometryGroup.remove(child);
    }
    const getConstantScreenRadius = (position, basePixelSize = 3) => {
        if (!camera) return 1;
        const distance = camera.position.distanceTo(position);
        const vFOV = camera.fov * Math.PI / 180;
        const height = 2 * Math.tan(vFOV/2) * distance;
        return (height / renderer.domElement.clientHeight) * basePixelSize;
    };
    const DBG = window.__LOOP_STEP_DBG__;
    const loopDebugOn = !!(DBG && DBG.enabled);
    const dimOthers = loopDebugOn && (DBG.dimOthers !== false);
    // Lines
    activeGeometry.connections.forEach(conn => {
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
        const l = conn.start.layer || 1;
        const isLayerVisible = (layerVisibility[l] !== false);
        const style = LAYER_STYLES[l] || LAYER_STYLES[1];
        const isSelected = selectedLines.has(conn);
        const pStart = getVector3(conn.start), pEnd = getVector3(conn.end);
        const isLoopEdge = loopDebugOn && DBG.highlightConns && DBG.highlightConns.has(conn);
        if (isLoopEdge) {
            const path = new THREE.LineCurve3(pStart, pEnd);
            const mid = new THREE.Vector3().lerpVectors(pStart, pEnd, 0.5);
            const r = getConstantScreenRadius(mid, DBG.highlightTubeRadius ? DBG.highlightTubeRadius*15 : 2);
            const m = new THREE.Mesh(new THREE.TubeGeometry(path,1,r,10,false), new THREE.MeshBasicMaterial({color:(DBG.highlightColor||0x00ffff),depthTest:false,transparent:true,opacity:(DBG.highlightOpacity??1.0)}));
            m.userData = {isConnection:true,connection:conn,__loopEdge:true};
            m.renderOrder = 2000; m.visible = isLayerVisible;
            geometryGroup.add(m); return;
        }
        if (isSelected) {
            const path = new THREE.LineCurve3(pStart, pEnd);
            const mid = new THREE.Vector3().lerpVectors(pStart, pEnd, 0.5);
            const r = getConstantScreenRadius(mid, 2);
            const m = new THREE.Mesh(new THREE.TubeGeometry(path,1,r,8,false), new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false,transparent:true,opacity:1.0}));
            m.userData = {isConnection:true,connection:conn,__selected:true};
            m.renderOrder = 999; m.visible = isLayerVisible;
            geometryGroup.add(m);
        }
        // Use type-based color (matching 2D behavior) when line types are shown
        let lineColor = style.line;
        const useTypeColor = ((typeof showLineTypes !== 'undefined' && showLineTypes) || (typeof isMeasurementMode !== 'undefined' && isMeasurementMode));
        if (conn.type && useTypeColor && typeof LINE_TYPES !== 'undefined') {
            const typeDef = Object.values(LINE_TYPES).find(t => t.id === conn.type);
            if (typeDef) lineColor = typeDef.color;
        }
        const lineMat = new THREE.LineBasicMaterial({color:new THREE.Color(lineColor),linewidth:3,depthTest:false,transparent:true,opacity:(dimOthers&&!isSelected)?(DBG.dimOpacity??0.10):0.8});
        
        const geo = new THREE.BufferGeometry().setFromPoints([pStart,pEnd]);
        const line = new THREE.Line(geo,lineMat);
        line.userData = {isConnection:true,connection:conn,__standard:true};
        line.visible = isLayerVisible;
        geometryGroup.add(line);
    });
    // Points
    const pointsByLayer = {}, selectedVerts = [];
    activeGeometry.points.forEach(pt => {
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) return;
        const l = pt.layer||1, v = getVector3(pt);
        if (!pointsByLayer[l]) pointsByLayer[l] = [];
        pointsByLayer[l].push(v.x,v.y,v.z);
        if (selectedPoints.has(pt)) selectedVerts.push(v.x,v.y,v.z);
    });
    Object.keys(pointsByLayer).forEach(layerNum => {
        const style = LAYER_STYLES[layerNum] || LAYER_STYLES[1];
        const verts = pointsByLayer[layerNum];
        if (!verts.length) return;
        const dotGeo = new THREE.BufferGeometry();
        dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
        const opacity = dimOthers ? 0.25 : 1.0;
        const pts = new THREE.Points(dotGeo, new THREE.PointsMaterial({color:new THREE.Color(style.dot),size:8,sizeAttenuation:false,transparent:opacity<1.0,opacity}));
        pts.userData = {layer:layerNum,isPoint:true};
        pts.visible = (layerVisibility[layerNum] !== false);
        geometryGroup.add(pts);
    });
    if (selectedVerts.length > 0) {
        const selGeo = new THREE.BufferGeometry();
        selGeo.setAttribute('position', new THREE.Float32BufferAttribute(selectedVerts,3));
        const selMesh = new THREE.Points(selGeo, new THREE.PointsMaterial({color:0xffffff,size:16,sizeAttenuation:false,depthTest:false}));
        selMesh.userData = {__selected:true}; selMesh.renderOrder = 999;
        geometryGroup.add(selMesh);
    }
}
window.deleteFaceRenderings = function () {
    if (facesGroup) {
        while (facesGroup.children.length > 0) {
            const child = facesGroup.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
            facesGroup.remove(child);
        }
    }
    const svg = document.getElementById('geoSvg');
    if (svg) svg.querySelectorAll('.generated-face').forEach(el => el.remove());
    if (typeof window !== 'undefined') window.currentFaceDataForSVG = null;
};
// =========================================================
// §9  FACE PLANE SWEEP CONFIG
// =========================================================
const PLANE_CFG = {
    ANGLE_STEP_DEG: 0.1, MIN_POINTS_ON_FACE: 3,
    BASE_TOLERANCE: 0.2, DIST_FACTOR: 0.00025,
    PEAK_WINDOW: 10, FORCE_DSM_FALLBACK: true
};
// =========================================================
// §10  renderFinalPass  (with integrated pitch-label update)
// =========================================================
window.renderFinalPassLegacy = function (fastRender = false, structureScoped = false) {
    if (!structureScoped && typeof window.withStructureModeScope === 'function' && !window.__structureScopeApplying && !window.__structureModeForceAll) {
        return window.withStructureModeScope(() => window.renderFinalPassLegacy(fastRender, true));
    }
    if (!activeGeometry || !activeGeometry.connections) return;
    const globalOn = (typeof showFacesLayer !== 'undefined') ? showFacesLayer : true;
    if (!globalOn) return;
    if (typeof window.deleteFaceRenderings === 'function') window.deleteFaceRenderings();
    const dsm = (layerData && layerData.dsm) ? layerData.dsm[0] : null;
    const w = imageWidth, h = imageHeight;
    const now = performance.now();
    const timeSinceLast = now - lastFullRenderTime;
    const shouldRunFullCalc = !lastResolvedFacesCache || (fastRender === false) || (timeSinceLast > FULL_RENDER_THROTTLE_MS);
    let facesToRender = [];
    if (shouldRunFullCalc) {
        lastFullRenderTime = now;
        if (typeof window.ensureAllPointsHaveZ === 'function') window.ensureAllPointsHaveZ();
        const calcPoints = activeGeometry.points.map((p, idx) => {
            let z = p.z;
            if ((z === null || z === undefined) && dsm && PLANE_CFG.FORCE_DSM_FALLBACK) {
                const ix = Math.max(0, Math.min(w-1, Math.round(p.x)));
                const iy = Math.max(0, Math.min(h-1, Math.round(p.y)));
                const val = dsm[iy*w+ix]; z = (val > -9000) ? val : 0;
            }
            return { id:idx, x:p.x, y:p.y, z:z||0, originalRef:p };
        });
        const calcLines = activeGeometry.connections.map(c => {
            const si = activeGeometry.points.indexOf(c.start);
            const ei = activeGeometry.points.indexOf(c.end);
            return { start:calcPoints[si], end:calcPoints[ei], edgeId: `${Math.min(si,ei)}-${Math.max(si,ei)}`, originalRef:c };
        });
        const calcPointAdj = new Map();
        calcPoints.forEach(cp => calcPointAdj.set(cp, []));
        calcLines.forEach(cl => { calcPointAdj.get(cl.start).push(cl.end); calcPointAdj.get(cl.end).push(cl.start); });
        const origToCalc = new Map();
        calcPoints.forEach(cp => origToCalc.set(cp.originalRef, cp));
        const structKey = `${activeGeometry.points.length}:${activeGeometry.connections.length}`;
        const structChanged = (structKey !== _incStructKey);
        let dirtyEdgeIds, noChanges = false;
        if (structChanged || _incLoopCache.size === 0) {
            dirtyEdgeIds = new Set(calcLines.map(cl => cl.edgeId));
            _incLoopCache.clear();
        } else {
            const changedOrig = new Set();
            activeGeometry.points.forEach(p => {
                const s = _incPointSnap.get(p);
                if (!s || s.x !== p.x || s.y !== p.y || s.z !== p.z || s.layer !== (p.layer||1)) changedOrig.add(p);
            });
            if (changedOrig.size === 0 && lastResolvedFacesCache) { facesToRender = lastResolvedFacesCache; noChanges = true; }
            else {
                dirtyEdgeIds = new Set();
                calcLines.forEach(cl => {
                    if (changedOrig.has(cl.start.originalRef) || changedOrig.has(cl.end.originalRef)) { dirtyEdgeIds.add(cl.edgeId); return; }
                    const sA = calcPointAdj.get(cl.start) || [];
                    for (const n of sA) { if (changedOrig.has(n.originalRef)) { dirtyEdgeIds.add(cl.edgeId); break; } }
                    if (dirtyEdgeIds.has(cl.edgeId)) return;
                    const eA = calcPointAdj.get(cl.end) || [];
                    for (const n of eA) { if (changedOrig.has(n.originalRef)) { dirtyEdgeIds.add(cl.edgeId); break; } }
                });
            }
        }
        if (!noChanges) {
            const calcLineByEdgeId = new Map();
            calcLines.forEach(cl => calcLineByEdgeId.set(cl.edgeId, cl));
            dirtyEdgeIds.forEach(edgeId => {
                const line = calcLineByEdgeId.get(edgeId);
                if (!line) { _incLoopCache.delete(edgeId); return; }
                const basis = getRotationBasis(line);
                if (!basis) { _incLoopCache.set(edgeId, []); return; }
                const peaks = findPlanePeaksFromNeighbors(line, basis, calcPoints, calcPointAdj);
                const lineLoops = [];
                peaks.forEach(peak => {
                    if (peak.score < PLANE_CFG.MIN_POINTS_ON_FACE) return;
                    const pointsOnPlane = calcPoints.filter(p => isPointOnPlaneVariableTol(line.start, peak.normal, p));
                    const loop = traceClosedLoopOnPlane(line, pointsOnPlane, calcLines, peak.normal);
                    if (loop && loop.length >= 3) lineLoops.push({origPoints:loop.map(cp => cp.originalRef)});
                });
                _incLoopCache.set(edgeId, lineLoops);
            });
            // Clean stale
            const currentEdgeIds = new Set(calcLines.map(cl => cl.edgeId));
            for (const key of _incLoopCache.keys()) { if (!currentEdgeIds.has(key)) _incLoopCache.delete(key); }
            // Rebuild candidates
            let rawCandidates = [];
            _incLoopCache.forEach(loops => { loops.forEach(loopData => { const c = buildCandidateFromLoop(loopData.origPoints, origToCalc); if (c) rawCandidates.push(c); }); });
            // Dedup Phase A: calcPoint ID set
            const uniqueSigMap = new Map();
            rawCandidates.forEach(face => { const sig = getCanonicalSignature(face.calcPoints); if (!uniqueSigMap.has(sig)) uniqueSigMap.set(sig, face); });
            let distinctFaces = Array.from(uniqueSigMap.values());
            // Dedup Phase B: original-point object identity
            { const kept=[],seenSets=[]; for(const face of distinctFaces){const ptSet=new Set(face.points);let dup=false;for(const prev of seenSets){if(prev.size!==ptSet.size)continue;let all=true;for(const p of ptSet){if(!prev.has(p)){all=false;break;}}if(all){dup=true;break;}}if(!dup){kept.push(face);seenSets.push(ptSet);}} distinctFaces=kept; }
            // Dedup Phase C: rounded coordinate signature
            { const coordSigMap=new Map(),kept=[]; for(const face of distinctFaces){const sig=getLocalFaceSignature(face.points);if(!coordSigMap.has(sig)){coordSigMap.set(sig,true);kept.push(face);}} distinctFaces=kept; }
            distinctFaces.sort((a,b) => b.area - a.area);
            // Hole cutting — uses centroid-based isPolygonInside (v1 behavior)
            const keptFaces = [];
            for (let i = 0; i < distinctFaces.length; i++) {
                const candidate = distinctFaces[i];
                let isRedundant = false;
                let bestKeeper = null;
                for (let j = 0; j < keptFaces.length; j++) {
                    const keeper = keptFaces[j];
                    if (candidate.edgeSet.size < keeper.edgeSet.size) {
                        let allIn = true;
                        for (let e of candidate.edgeSet) { if (!keeper.edgeSet.has(e)) { allIn=false; break; } }
                        if (allIn) { isRedundant=true; break; }
                    }
                    if (!isRedundant) {
                        if (areLoopPlanesCoplanar(candidate, keeper, 1.5)) {
                            if (isPolygonInside(candidate.calcPoints, keeper.calcPoints)) {
                                // Check if candidate shares any boundary/edge or vertices with keeper (indicates subdivision rather than a hole)
                                let sharesBdy = sharesBoundary(candidate, keeper);
                                if (!sharesBdy) {
                                    const keeperPoints = new Set(keeper.points);
                                    for (let p of candidate.points) {
                                        if (keeperPoints.has(p)) {
                                            sharesBdy = true;
                                            break;
                                        }
                                    }
                                }
                                if (!sharesBdy) {
                                    if (!bestKeeper || keeper.area < bestKeeper.area) {
                                        bestKeeper = keeper;
                                    }
                                }
                            }
                        }
                    }
                }
                if (bestKeeper) {
                    bestKeeper.holes.push(candidate.points);
                    isRedundant = true;
                }
                if (!isRedundant) keptFaces.push(candidate);
            }

            // Cleanup composite faces that are fully subdivided/tiled by smaller kept faces
            const finalKept = [];
            for (let i = 0; i < keptFaces.length; i++) {
                const face = keptFaces[i];
                let subFacesArea = 0;
                for (let j = 0; j < keptFaces.length; j++) {
                    if (i === j) continue;
                    const other = keptFaces[j];
                    if (areLoopPlanesCoplanar(other, face, 1.5)) {
                        if (isPolygonInside(other.calcPoints, face.calcPoints)) {
                            let sharesBdy = sharesBoundary(other, face);
                            if (!sharesBdy) {
                                const facePoints = new Set(face.points);
                                for (let p of other.points) {
                                    if (facePoints.has(p)) {
                                        sharesBdy = true;
                                        break;
                                    }
                                }
                            }
                            if (sharesBdy) {
                                subFacesArea += other.area;
                            }
                        }
                    }
                }
                if (subFacesArea > 0.95 * face.area) {
                    continue; // Discard this composite parent face
                }
                finalKept.push(face);
            }
            const afterCull = cullOccludedBottomFaces(finalKept);
            const processedSigs = new Set();
            afterCull.forEach(face => {
                const sig = getLocalFaceSignature(face.points);
                if (typeof deletedFaceSignatures !== 'undefined' && deletedFaceSignatures.has(sig)) return;
                if (!processedSigs.has(sig)) { facesToRender.push(face); processedSigs.add(sig); }
            });
            if (activeGeometry.manualFaces) {
                activeGeometry.manualFaces.forEach(mf => {
                    const sig = getLocalFaceSignature(mf.points);
                    if (typeof deletedFaceSignatures !== 'undefined' && deletedFaceSignatures.has(sig)) return;
                    if (processedSigs.has(sig)) { const idx=facesToRender.findIndex(f=>getLocalFaceSignature(f.points)===sig); if(idx!==-1)facesToRender[idx]=mf; }
                    else { facesToRender.push(mf); processedSigs.add(sig); }
                });
            }
            lastResolvedFacesCache = facesToRender;
            if (typeof window !== 'undefined') window.lastResolvedFacesCache = facesToRender;
            _incPointSnap.clear();
            activeGeometry.points.forEach(p => _incPointSnap.set(p, {x:p.x,y:p.y,z:p.z,layer:p.layer||1}));
            _incStructKey = structKey;
        }
    } else { facesToRender = lastResolvedFacesCache; }
    // VISUAL RENDERING
    const dataFor2D = [];
    facesToRender.forEach((face, idx) => {
        const finalPlane = calculatePlaneFromVertices(face.points);
        face.plane = finalPlane;
        { const nx=-finalPlane.a,ny=-finalPlane.b,nz=1; const len=Math.hypot(nx,ny,nz); face.planeNormal=(len>1e-9)?{x:nx/len,y:ny/len,z:nz/len}:{x:0,y:0,z:1}; }
        const layerNum = parseInt(face.layer||1,10);
        const m = createFaceMesh(face, finalPlane, layerNum, idx, []);
        m.visible = globalOn && (layerVisibility[layerNum] !== false);
        const isSel = (typeof selectedFaceSignatures !== 'undefined' && selectedFaceSignatures.has(getLocalFaceSignature(face.points)));
        updateFaceMeshVisuals(m, layerNum, idx, isSel);
        if (facesGroup) facesGroup.add(m);
        const baseHue = getLayerHue(layerNum);
        dataFor2D.push({ points:face.points, holes:face.holes||[], color:`hsl(${baseHue}, 100%, ${48+(idx*8)%12}%)`, layer:layerNum });
    });
    if (typeof renderFaces2D === 'function') renderFaces2D(dataFor2D);
    if (typeof window.refreshStructureStatusesFromFaces === 'function') window.refreshStructureStatusesFromFaces(facesToRender);
    if (_enh.showPitchLabels) requestAnimationFrame(renderPitchLabels);
};
window.renderFinalPass = function (fastRender = false) {
    return window.renderFinalPassLegacy(fastRender);
};

// =========================================================
// Alternate face resolver debugger (plane-pair + cell fill)
// =========================================================
(function bootstrapAlternateFaceResolver() {
    const STEP_LABELS = ['1 Plane Candidates', '2 Plane Preview', '3 Flood Cells', '4 Deduped Faces', '5 Reconstructed Loops'];
    const SHOW_ALT_FACE_RESOLVER_UI = false;
    let altResolverConfig = {
        planeDotTol: 0.99999,
        planeDTol: 0.03,
        pointPlaneTol: 0.45,
        usePlaneDedupeForFlood: true,
        occlusionCoverage: 0.8,
        holePlaneDotTol: 0.995,
        holePlaneDTol: 0.45,
        holePointPlaneTol: 0.1,
        rasterTargetCells: 22000,
        rasterHardMaxCells: 90000,
        debugShowOccludedFaces: true,
        debugShowVisibleFaces: true,
        debugLabelMode: 'id'
    };
    const MAX_DEBUG_MESHES = 260;
    let debug3DGroup = null;
    let state = { step: 1, candidates: [], planes: [], cells: [], faces: [] };
    let altFloodCellCache = new Map();
    let altFloodEdgeSetCache = new Map();
    let altFloodComponentCache = new Map();
    let selectedAltDebugFace = null;
    window.__finalPassAnalytics = window.__finalPassAnalytics || {
        enabled: true,
        samples: [],
        maxSamples: 80,
        logEvery: 20,
        totalPasses: 0,
        lastSummary: null,
        lastSample: null
    };
    function nowAlt() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }
    function msAlt(value) {
        return +((Number(value) || 0).toFixed(2));
    }
    function roundedCoordKeyAlt(v) {
        return String(Math.round((Number(v) || 0) * 1000));
    }
    function calcPointStableKeyAlt(cp) {
        return `${cp.id}:${roundedCoordKeyAlt(cp.x)},${roundedCoordKeyAlt(cp.y)},${roundedCoordKeyAlt(cp.z)},${cp.layer || 1}`;
    }
    function connectionStableKeyAlt(conn) {
        if (!conn || !conn.start || !conn.end || !activeGeometry || !Array.isArray(activeGeometry.points)) return 'bad-conn';
        const a = activeGeometry.points.indexOf(conn.start);
        const b = activeGeometry.points.indexOf(conn.end);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return `${lo}-${hi}:${conn.start.layer || conn.end.layer || 1}:${conn.type || ''}:${conn.manualType ? 1 : 0}`;
    }
    function geometryTopologyKeyAlt() {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return 'no-topology';
        return activeGeometry.connections.map(connectionStableKeyAlt).sort().join(';');
    }
    function planeStableKeyAlt(plane) {
        if (!plane || !plane.normal) return 'no-plane';
        return [
            roundedCoordKeyAlt(plane.normal.x),
            roundedCoordKeyAlt(plane.normal.y),
            roundedCoordKeyAlt(plane.normal.z),
            roundedCoordKeyAlt(plane.d)
        ].join(',');
    }
    function recordFinalPassAnalyticsAlt(sample) {
        const analytics = window.__finalPassAnalytics;
        if (!analytics || !analytics.enabled || !sample) return;
        const row = { ...sample, at: nowAlt() };
        analytics.samples.push(row);
        if (analytics.samples.length > analytics.maxSamples) analytics.samples.shift();
        analytics.totalPasses += 1;
        analytics.lastSample = row;
        if (analytics.totalPasses % analytics.logEvery === 0) {
            window.printFinalPassAnalytics();
        }
    }
    window.printFinalPassAnalytics = function() {
        const analytics = window.__finalPassAnalytics;
        const samples = analytics && analytics.samples ? analytics.samples : [];
        if (!samples.length) {
            console.info('[FinalPassAnalytics] No samples yet.');
            return null;
        }
        const fields = [
            'totalMs', 'totalBuildMs', 'deleteRenderingsMs', 'calcPointsMs', 'candidateMs', 'planeDedupeMs',
            'floodPlanePrepMs', 'floodMs', 'triangleMs', 'cellDedupeMs', 'holeMs', 'occlusionMs', 'uiStatusMs',
            'manualDeletedMs', 'renderFacePrepMs', 'meshMs', 'renderFaces2DMs'
        ];
        const sums = {};
        fields.forEach(field => { sums[field] = 0; });
        samples.forEach(sample => {
            fields.forEach(field => { sums[field] += Number(sample[field]) || 0; });
        });
        const n = samples.length;
        const avg = {};
        fields.forEach(field => { avg[field] = msAlt(sums[field] / n); });
        const total = sums.totalMs || 0;
        const pct = {};
        fields.forEach(field => {
            if (field !== 'totalMs') pct[field.replace('Ms', 'Pct')] = msAlt(total > 0 ? (sums[field] / total) * 100 : 0);
        });
        const summary = {
            samples: n,
            avg,
            pct,
            last: analytics.lastSample
        };
        analytics.lastSummary = summary;
        console.info('[FinalPassAnalytics]', summary);
        return summary;
    };

    const FACE_PROFILE_TIME_FIELDS_ALT = [
        'totalMs', 'totalBuildMs', 'deleteRenderingsMs', 'resolveTotalMs', 'calcPointsMs', 'candidateMs',
        'planeDedupeMs', 'floodPlanePrepMs', 'floodMs', 'triangleMs', 'cellDedupeMs', 'holeMs',
        'occlusionMs', 'uiStatusMs', 'manualDeletedMs', 'renderFacePrepMs', 'meshMs', 'renderFaces2DMs'
    ];
    const FACE_PROFILE_COUNT_FIELDS_ALT = [
        'points', 'connections', 'candidates', 'planes', 'floodPlanes', 'cells', 'faces', 'holes',
        'occluded', 'triangleCells', 'floodCacheHits', 'floodCacheMisses', 'edgeComponents',
        'graphFastPath', 'rasterComponents', 'rasterCellsScanned', 'edgeSetCacheHits', 'edgeSetCacheMisses',
        'componentCacheHits', 'componentCacheMisses', 'rasterBudgetUpscaledComponents'
    ];

    function percentileAlt(values, pct) {
        const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (!nums.length) return 0;
        const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((pct / 100) * nums.length) - 1));
        return nums[idx];
    }

    function summarizeProfileSamplesAlt(samples, fields) {
        return fields
            .map(field => {
                const values = samples.map(sample => Number(sample[field])).filter(Number.isFinite);
                if (!values.length) return null;
                const sum = values.reduce((acc, value) => acc + value, 0);
                const avg = sum / values.length;
                return {
                    field,
                    avg: msAlt(avg),
                    min: msAlt(Math.min(...values)),
                    p50: msAlt(percentileAlt(values, 50)),
                    p95: msAlt(percentileAlt(values, 95)),
                    max: msAlt(Math.max(...values)),
                    last: msAlt(values[values.length - 1])
                };
            })
            .filter(Boolean);
    }

    function printFaceResolverProfileAlt(samples, options = {}) {
        const timeRows = summarizeProfileSamplesAlt(samples, FACE_PROFILE_TIME_FIELDS_ALT)
            .filter(row => row.avg || row.max)
            .sort((a, b) => b.avg - a.avg);
        const totalAvg = (timeRows.find(row => row.field === 'totalMs') || timeRows.find(row => row.field === 'totalBuildMs') || {}).avg || 0;
        timeRows.forEach(row => {
            row.pct = msAlt(totalAvg > 0 && row.field !== 'totalMs' ? (row.avg / totalAvg) * 100 : (row.field === 'totalMs' ? 100 : 0));
        });
        const countRows = summarizeProfileSamplesAlt(samples, FACE_PROFILE_COUNT_FIELDS_ALT)
            .filter(row => row.avg || row.max);
        const summary = {
            mode: options.render ? 'build+render' : 'build-only',
            runs: samples.length,
            force: options.force !== false,
            totalAvgMs: totalAvg,
            last: samples[samples.length - 1] || null,
            timeRows,
            countRows,
            samples
        };
        console.groupCollapsed(`[AltFaceResolverProfile] ${summary.mode}, runs=${summary.runs}, force=${summary.force}, avg=${summary.totalAvgMs}ms`);
        console.table(timeRows);
        console.table(countRows);
        console.info('summary', summary);
        console.groupEnd();
        window.__lastAltFaceResolverProfile = summary;
        return summary;
    }
    const clampAlt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let altPointIndexMap = new Map();
    const rebuildAltPointIndexMap = () => {
        altPointIndexMap = new Map();
        (activeGeometry?.points || []).forEach((point, idx) => altPointIndexMap.set(point, idx));
    };
    const pointId = (points, p) => altPointIndexMap.has(p) ? altPointIndexMap.get(p) : points.indexOf(p);
    const edgeKeyAlt = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const dirKeyAlt = (a, b) => `${a}>${b}`;
    const MIN_GRAPH_FACE_AREA_ALT = 0.25;
    const signedAreaAlt = (pts) => {
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            area += a.x * b.y - b.x * a.y;
        }
        return area * 0.5;
    };
    const faceCoordSigAlt = (pts) => pts.map(p => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`).sort().join('|');
    const faceLayerAlt = (face) => parseInt(face?.layer || face?.points?.[0]?.layer || 1, 10);
    const sameFaceLayerAlt = (a, b) => faceLayerAlt(a) === faceLayerAlt(b);

    function clearAltFaceDebug() {
        const svg = document.getElementById('geoSvg');
        if (svg) svg.querySelectorAll('.alt-face-debug, .alt-face-inspect-highlight').forEach(el => el.remove());
        if (debug3DGroup) {
            while (debug3DGroup.children.length) {
                const child = debug3DGroup.children[0];
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
                debug3DGroup.remove(child);
            }
        }
    }

    function invalidateAltResolverCaches() {
        altFloodCellCache.clear();
        altFloodEdgeSetCache.clear();
        altFloodComponentCache.clear();
    }

    function ensureAltFace3DGroup() {
        if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene) return null;
        if (!debug3DGroup) {
            debug3DGroup = new THREE.Group();
            debug3DGroup.name = 'alternateFaceResolverDebug';
            scene.add(debug3DGroup);
        }
        window.__altDebug3DGroup = debug3DGroup;
        return debug3DGroup;
    }

    function ensureAltFaceSvgLayer() {
        const svg = document.getElementById('geoSvg');
        if (!svg) return null;
        const target = document.getElementById('geo-rotation-group') || svg;
        let layer = target.querySelector('#altFaceDebugLayer');
        if (!layer) {
            layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            layer.id = 'altFaceDebugLayer';
            layer.setAttribute('class', 'alt-face-debug');
            layer.style.pointerEvents = 'auto';
            target.appendChild(layer);
        }
        return layer;
    }

    function getCalcPointDataAlt() {
        const dsm = (typeof layerData !== 'undefined' && layerData && layerData.dsm) ? layerData.dsm[0] : null;
        const w = typeof imageWidth !== 'undefined' ? imageWidth : 0;
        const h = typeof imageHeight !== 'undefined' ? imageHeight : 0;
        return (activeGeometry.points || []).map((p, id) => {
            let z = p.z;
            if ((z === null || z === undefined || !Number.isFinite(z)) && dsm && w && h) {
                const ix = clampAlt(Math.round(p.x), 0, w - 1);
                const iy = clampAlt(Math.round(p.y), 0, h - 1);
                const val = dsm[iy * w + ix];
                z = (val > -9000 && Number.isFinite(val)) ? val : 0;
            }
            return { id, ref: p, x: p.x, y: p.y, z: Number.isFinite(z) ? z : 0, layer: p.layer || 1 };
        });
    }

    function planeFromThreePointsAlt(a, b, c) {
        const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
        let n = crossProduct(u, v);
        const len = Math.hypot(n.x, n.y, n.z);
        if (len < 1e-9) return null;
        n = { x: n.x / len, y: n.y / len, z: n.z / len };
        if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
        return { normal: n, d: n.x * a.x + n.y * a.y + n.z * a.z };
    }

    function planeToSlopeAlt(plane) {
        if (!plane || !plane.normal || Math.abs(plane.normal.z) < 1e-6) return null;
        return { a: -plane.normal.x / plane.normal.z, b: -plane.normal.y / plane.normal.z, c: plane.d / plane.normal.z };
    }

    function slopeToPlaneAlt(slope) {
        if (!slope) return null;
        let normal = { x: -slope.a, y: -slope.b, z: 1 };
        const len = Math.hypot(normal.x, normal.y, normal.z);
        if (len < 1e-9) return null;
        normal = { x: normal.x / len, y: normal.y / len, z: normal.z / len };
        const d = slope.c / len;
        return { normal, d };
    }

    function planeFromGeometryLoopAlt(points) {
        if (!points || points.length < 3) return null;
        const slope = calculatePlaneFromVertices(points);
        return slopeToPlaneAlt(slope);
    }

    function distanceToPlaneAlt(plane, p) {
        return Math.abs(plane.normal.x * p.x + plane.normal.y * p.y + plane.normal.z * p.z - plane.d);
    }

    function collectPlaneCandidatesAlt(calcPoints) {
        if (!activeGeometry || !activeGeometry.connections) return [];
        const incident = new Map();
        calcPoints.forEach(cp => incident.set(cp.ref, []));
        activeGeometry.connections.forEach((conn, connId) => {
            if (!conn || !conn.start || !conn.end) return;
            const s = calcPoints[pointId(activeGeometry.points, conn.start)];
            const e = calcPoints[pointId(activeGeometry.points, conn.end)];
            if (!s || !e || s.layer !== e.layer) return;
            incident.get(conn.start)?.push({ connId, other: conn.end });
            incident.get(conn.end)?.push({ connId, other: conn.start });
        });
        const out = [];
        const seen = new Set();
        incident.forEach((items, sharedRef) => {
            if (!items || items.length < 2) return;
            const shared = calcPoints[pointId(activeGeometry.points, sharedRef)];
            if (!shared) return;
            for (let i = 0; i < items.length; i++) {
                for (let j = i + 1; j < items.length; j++) {
                    const pA = calcPoints[pointId(activeGeometry.points, items[i].other)];
                    const pB = calcPoints[pointId(activeGeometry.points, items[j].other)];
                    if (!pA || !pB || pA.ref === pB.ref) continue;
                    if (pA.layer !== shared.layer || pB.layer !== shared.layer) continue;
                    const ids = [shared.id, pA.id, pB.id].sort((a, b) => a - b);
                    const sig = ids.join('|');
                    if (seen.has(sig)) continue;
                    seen.add(sig);
                    const plane = planeFromThreePointsAlt(shared, pA, pB);
                    if (!plane) continue;
                    const stableKey = [shared, pA, pB]
                        .slice()
                        .sort((a, b) => a.id - b.id)
                        .map(calcPointStableKeyAlt)
                        .join('|');
                    out.push({ points: [shared.ref, pA.ref, pB.ref], calcPoints: [shared, pA, pB], pointIds: ids, layer: shared.layer, plane, stableKey });
                }
            }
        });
        return out;
    }

    function dedupePlanesAlt(candidates) {
        const groups = [];
        candidates.forEach(candidate => {
            let group = null;
            for (const existing of groups) {
                if (existing.layer !== candidate.layer) continue;
                const dot = dotProduct(existing.plane.normal, candidate.plane.normal);
                if (Math.abs(dot) >= altResolverConfig.planeDotTol && Math.abs(existing.plane.d - candidate.plane.d) <= altResolverConfig.planeDTol) {
                    group = existing;
                    break;
                }
            }
            if (!group) {
                group = { id: groups.length + 1, layer: candidate.layer, plane: { normal: { ...candidate.plane.normal }, d: candidate.plane.d }, candidates: [], pointIds: new Set() };
                groups.push(group);
            }
            group.candidates.push(candidate);
            candidate.pointIds.forEach(id => group.pointIds.add(id));
            const n = group.candidates.length;
            group.plane.normal.x = ((group.plane.normal.x * (n - 1)) + candidate.plane.normal.x) / n;
            group.plane.normal.y = ((group.plane.normal.y * (n - 1)) + candidate.plane.normal.y) / n;
            group.plane.normal.z = ((group.plane.normal.z * (n - 1)) + candidate.plane.normal.z) / n;
            const len = Math.hypot(group.plane.normal.x, group.plane.normal.y, group.plane.normal.z) || 1;
            group.plane.normal.x /= len;
            group.plane.normal.y /= len;
            group.plane.normal.z /= len;
            if (group.plane.normal.z < 0) {
                group.plane.normal.x *= -1;
                group.plane.normal.y *= -1;
                group.plane.normal.z *= -1;
            }
            group.plane.d = ((group.plane.d * (n - 1)) + candidate.plane.d) / n;
            group.stableKey = `${group.layer}|${planeStableKeyAlt(group.plane)}|${group.candidates.map(c => c.stableKey || c.pointIds.join('|')).sort().join('~')}`;
        });
        return groups;
    }

    function touchesViewportBoundaryAlt(points) {
        const w = typeof imageWidth !== 'undefined' ? imageWidth : 0;
        const h = typeof imageHeight !== 'undefined' ? imageHeight : 0;
        if (!w || !h) return false;
        return points.some(p => p.x <= 1 || p.y <= 1 || p.x >= w - 2 || p.y >= h - 2);
    }

    function simplifyPolygonRdpAlt(points, epsilon = 1.2, maxPoints = 140) {
        if (!points || points.length <= 3) return points || [];
        const sqDistToSeg = (p, a, b) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq <= 1e-9) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
            const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
            const x = a.x + t * dx, y = a.y + t * dy;
            return (p.x - x) ** 2 + (p.y - y) ** 2;
        };
        const rdp = (arr, epsSq) => {
            if (arr.length <= 2) return arr;
            let maxD = -1, idx = -1;
            for (let i = 1; i < arr.length - 1; i++) {
                const d = sqDistToSeg(arr[i], arr[0], arr[arr.length - 1]);
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (maxD <= epsSq) return [arr[0], arr[arr.length - 1]];
            const left = rdp(arr.slice(0, idx + 1), epsSq);
            const right = rdp(arr.slice(idx), epsSq);
            return left.slice(0, -1).concat(right);
        };
        let eps = epsilon;
        let simplified = points;
        while (simplified.length > maxPoints && eps < 12) {
            simplified = rdp(points.concat([points[0]]), eps * eps).slice(0, -1);
            eps *= 1.4;
        }
        if (simplified === points) simplified = rdp(points.concat([points[0]]), eps * eps).slice(0, -1);
        return simplified.length >= 3 ? simplified : points.slice(0, maxPoints);
    }

    function polygonFromFloodComponentAlt(component, width, height, minX, minY, step) {
        const filled = new Set(component);
        const edges = [];
        const add = (ax, ay, bx, by) => edges.push({ a: `${ax},${ay}`, b: `${bx},${by}`, ax, ay, bx, by });
        const hasCell = (x, y) => filled.has(y * width + x);
        component.forEach(cell => {
            const x = cell % width;
            const y = Math.floor(cell / width);
            if (!hasCell(x, y - 1)) add(x, y, x + 1, y);
            if (!hasCell(x + 1, y)) add(x + 1, y, x + 1, y + 1);
            if (!hasCell(x, y + 1)) add(x + 1, y + 1, x, y + 1);
            if (!hasCell(x - 1, y)) add(x, y + 1, x, y);
        });
        const byStart = new Map();
        edges.forEach(edge => {
            if (!byStart.has(edge.a)) byStart.set(edge.a, []);
            byStart.get(edge.a).push(edge);
        });
        const used = new Set();
        const loops = [];
        edges.forEach(first => {
            const firstKey = `${first.a}>${first.b}`;
            if (used.has(firstKey)) return;
            const loop = [];
            let edge = first;
            let guard = 0;
            while (edge && guard++ < edges.length + 5) {
                const key = `${edge.a}>${edge.b}`;
                if (used.has(key)) break;
                used.add(key);
                loop.push({ x: minX + edge.ax * step, y: minY + edge.ay * step });
                if (edge.b === first.a) break;
                const nextList = byStart.get(edge.b) || [];
                edge = nextList.find(next => !used.has(`${next.a}>${next.b}`)) || null;
            }
            if (loop.length >= 3) loops.push(loop);
        });
        if (!loops.length) return null;
        loops.sort((a, b) => Math.abs(signedAreaAlt(b)) - Math.abs(signedAreaAlt(a)));
        const best = simplifyPolygonRdpAlt(loops[0]);
        return best.length >= 3 ? best : null;
    }

    function pruneBoundaryEdgesAlt(boundaryEdges) {
        if (!boundaryEdges || boundaryEdges.length < 3) return null;
        const adj = new Map();
        const addNeighbor = (a, b) => {
            if (!adj.has(a)) adj.set(a, []);
            if (!adj.get(a).includes(b)) adj.get(a).push(b);
        };
        boundaryEdges.forEach(({ a, b }) => {
            addNeighbor(a, b);
            addNeighbor(b, a);
        });

        let changed = true;
        while (changed) {
            changed = false;
            Array.from(adj.keys()).forEach(id => {
                const neighbors = adj.get(id) || [];
                if (neighbors.length >= 2) return;
                adj.delete(id);
                neighbors.forEach(n => {
                    if (!adj.has(n)) return;
                    adj.set(n, adj.get(n).filter(x => x !== id));
                });
                changed = true;
            });
        }
        const nodes = new Set(adj.keys());
        const prunedEdges = boundaryEdges.filter(edge => nodes.has(edge.a) && nodes.has(edge.b));
        return { edges: prunedEdges, adj };
    }

    function loopsFromBoundaryEdgesAlt(boundaryEdges, calcPoints, targetArea = null) {
        const pruned = pruneBoundaryEdgesAlt(boundaryEdges);
        if (!pruned || !pruned.edges || pruned.edges.length < 3) return [];
        const adj = pruned.adj;
        const nodes = Array.from(adj.keys());
        const cycles = [];
        const addCycle = (ids) => {
            const unique = [];
            ids.forEach(id => { if (!unique.includes(id)) unique.push(id); });
            if (unique.length < 3) return;
            const pts = unique.map(id => calcPoints[id].ref);
            const area = Math.abs(signedAreaAlt(pts));
            if (area <= MIN_GRAPH_FACE_AREA_ALT) return;
            const key = unique.slice().sort((a, b) => a - b).join('|');
            if (cycles.some(c => c.key === key)) return;
            cycles.push({ ids: unique, pts, area, key });
        };
        const angleTo = (from, to) => Math.atan2(calcPoints[to].y - calcPoints[from].y, calcPoints[to].x - calcPoints[from].x);
        const neighborsByAngle = new Map();
        nodes.forEach(id => {
            neighborsByAngle.set(id, (adj.get(id) || []).slice().sort((a, b) => angleTo(id, a) - angleTo(id, b)));
        });
        const walkDirected = (start, nextStart, turnDir) => {
            const path = [start];
            let prev = start;
            let curr = nextStart;
            const seenDirected = new Set();
            for (let guard = 0; guard < nodes.length * 3; guard++) {
                const dKey = `${prev}>${curr}`;
                if (seenDirected.has(dKey)) return null;
                seenDirected.add(dKey);
                if (curr === start) {
                    if (path.length >= 3) return path;
                    return null;
                }
                if (path.includes(curr)) return null;
                path.push(curr);
                const list = neighborsByAngle.get(curr) || [];
                const reverseIdx = list.indexOf(prev);
                if (reverseIdx < 0 || list.length < 2) return null;
                const nextIdx = turnDir < 0
                    ? (reverseIdx - 1 + list.length) % list.length
                    : (reverseIdx + 1) % list.length;
                const next = list[nextIdx];
                prev = curr;
                curr = next;
            }
            return null;
        };
        const seenCycles = new Set();
        nodes.forEach(a => {
            (neighborsByAngle.get(a) || []).forEach(b => {
                [-1, 1].forEach(turnDir => {
                    const ids = walkDirected(a, b, turnDir);
                    if (!ids) return;
                    const key = ids.slice().sort((x, y) => x - y).join('|');
                    if (seenCycles.has(key)) return;
                    seenCycles.add(key);
                    addCycle(ids);
                });
            });
        });

        if (!cycles.length) return [];
        cycles.sort((a, b) => {
            if (Number.isFinite(targetArea) && targetArea > 0) {
                return Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea);
            }
            return b.area - a.area;
        });
        return cycles;
    }

    function loopFromBoundaryEdgesAlt(boundaryEdges, calcPoints, targetArea = null) {
        const cycles = loopsFromBoundaryEdgesAlt(boundaryEdges, calcPoints, targetArea);
        return cycles.length ? cycles[0].pts : null;
    }

    function splitPlaneEdgesIntoComponentsAlt(edges) {
        const nodeEdges = new Map();
        edges.forEach(edge => {
            if (!nodeEdges.has(edge.a)) nodeEdges.set(edge.a, []);
            if (!nodeEdges.has(edge.b)) nodeEdges.set(edge.b, []);
            nodeEdges.get(edge.a).push(edge);
            nodeEdges.get(edge.b).push(edge);
        });
        const visited = new Set();
        const components = [];
        edges.forEach(edge => {
            if (visited.has(edge.key)) return;
            const stack = [edge];
            const component = [];
            visited.add(edge.key);
            while (stack.length) {
                const cur = stack.pop();
                component.push(cur);
                [cur.a, cur.b].forEach(node => {
                    (nodeEdges.get(node) || []).forEach(next => {
                        if (visited.has(next.key)) return;
                        visited.add(next.key);
                        stack.push(next);
                    });
                });
            }
            components.push(component);
        });
        return components;
    }

    function componentEdgeStatsAlt(componentEdges, calcPoints) {
        let minLen = Infinity;
        let totalLen = 0;
        let branchCount = 0;
        const degree = new Map();
        (componentEdges || []).forEach(edge => {
            const pa = calcPoints[edge.a], pb = calcPoints[edge.b];
            if (pa && pb) {
                const len = Math.hypot(pa.x - pb.x, pa.y - pb.y);
                if (Number.isFinite(len) && len > 0) {
                    minLen = Math.min(minLen, len);
                    totalLen += len;
                }
            }
            degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
            degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
        });
        degree.forEach(count => {
            if (count > 2) branchCount += 1;
        });
        return {
            minLen: Number.isFinite(minLen) ? minLen : 0,
            totalLen,
            branchCount,
            nodeCount: degree.size,
            hasSplitter: branchCount > 0
        };
    }

    function cellFromGraphLoopAlt(edges, calcPoints, planeGroup) {
        if (!edges || edges.length < 3) return null;
        const degree = new Map();
        edges.forEach(edge => {
            degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
            degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
        });
        for (const count of degree.values()) {
            if (count !== 2) return null;
        }
        const loopPts = loopFromBoundaryEdgesAlt(edges, calcPoints);
        if (!loopPts || loopPts.length < 3 || touchesViewportBoundaryAlt(loopPts)) return null;
        const area = Math.abs(signedAreaAlt(loopPts));
        if (area <= MIN_GRAPH_FACE_AREA_ALT) return null;
        const geometryPlane = planeFromGeometryLoopAlt(loopPts);
        return {
            points: loopPts,
            rasterPoints: loopPts,
            boundaryEdges: edges,
            prunedBoundaryEdges: edges,
            prunedBoundarySource: 'graph',
            floodEdges: edges,
            prunedFloodEdges: edges,
            calcPoints: loopPts.map(pt => calcPoints[pointId(activeGeometry.points, pt)]).filter(Boolean),
            area,
            planeGroup,
            plane: geometryPlane || planeGroup.plane,
            floodPlane: planeGroup.plane,
            sourceCandidate: planeGroup.sourceCandidate || null,
            sourceCalcPoints: calcPoints,
            layer: planeGroup.layer,
            usedRasterFallback: false,
            usedGraphFastPath: true
        };
    }

    function componentStableKeyAlt(componentEdges, calcPoints) {
        return (componentEdges || [])
            .map(edge => `${edge.key}:${calcPointStableKeyAlt(calcPoints[edge.a])}:${calcPointStableKeyAlt(calcPoints[edge.b])}`)
            .sort()
            .join('|');
    }

    function cloneFloodCellForPlaneGroupAlt(cell, planeGroup) {
        if (!cell) return null;
        const next = {
            ...cell,
            planeGroup,
            floodPlane: planeGroup.plane,
            sourceCandidate: planeGroup.sourceCandidate || null
        };
        if (!next.plane || next.usedRasterFallback) next.plane = planeGroup.plane;
        return next;
    }

    function floodCellsForPlaneAlt(planeGroup, calcPoints) {
        const floodStats = state.currentFloodStats || null;
        const onPlaneIds = new Set(calcPoints.filter(p => p.layer === planeGroup.layer && distanceToPlaneAlt(planeGroup.plane, p) <= altResolverConfig.pointPlaneTol).map(p => p.id));
        const edges = [];
        const uniqueEdges = new Set();
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            const a = pointId(activeGeometry.points, conn.start);
            const b = pointId(activeGeometry.points, conn.end);
            if (a < 0 || b < 0 || !onPlaneIds.has(a) || !onPlaneIds.has(b)) return;
            const pa = calcPoints[a], pb = calcPoints[b];
            if (!pa || !pb || pa.layer !== planeGroup.layer || pb.layer !== planeGroup.layer) return;
            const key = edgeKeyAlt(a, b);
            if (uniqueEdges.has(key)) return;
            uniqueEdges.add(key);
            edges.push({ a, b, key });
        });
        if (edges.length < 3) return [];
        const edgeSetKey = edges
            .map(edge => `${edge.key}:${calcPointStableKeyAlt(calcPoints[edge.a])}:${calcPointStableKeyAlt(calcPoints[edge.b])}`)
            .sort()
            .join('|');
        if (altFloodEdgeSetCache.size > 600) altFloodEdgeSetCache.clear();
        const cachedByEdges = altFloodEdgeSetCache.get(edgeSetKey);
        if (cachedByEdges) {
            if (floodStats) floodStats.edgeSetCacheHits += 1;
            return cachedByEdges;
        }
        if (floodStats) floodStats.edgeSetCacheMisses += 1;

        const rasterFloodEdgeSet = (componentEdges) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            componentEdges.forEach(({ a, b }) => {
                const pa = calcPoints[a], pb = calcPoints[b];
                minX = Math.min(minX, pa.x, pb.x);
                minY = Math.min(minY, pa.y, pb.y);
                maxX = Math.max(maxX, pa.x, pb.x);
                maxY = Math.max(maxY, pa.y, pb.y);
            });
            const pad = 8;
            const imgW = typeof imageWidth !== 'undefined' ? imageWidth : maxX + pad;
            const imgH = typeof imageHeight !== 'undefined' ? imageHeight : maxY + pad;
            minX = Math.max(0, Math.floor(minX - pad));
            minY = Math.max(0, Math.floor(minY - pad));
            maxX = Math.min(imgW - 1, Math.ceil(maxX + pad));
            maxY = Math.min(imgH - 1, Math.ceil(maxY + pad));
            const spanX = maxX - minX;
            const spanY = maxY - minY;
            const minSpan = Math.min(spanX, spanY);
            const maxSpan = Math.max(spanX, spanY);
            const edgeStats = componentEdgeStatsAlt(componentEdges, calcPoints);
            let step = 1;
            if (minSpan < 28 || maxSpan < 96 || edgeStats.minLen < 18 || edgeStats.hasSplitter) step = 0.5;
            if (minSpan < 18 || maxSpan < 64 || edgeStats.minLen < 10 || (edgeStats.hasSplitter && minSpan < 48)) step = 0.25;
            if (minSpan < 8 || edgeStats.minLen < 5) step = 0.2;
            const rawAreaCells = Math.max(1, spanX * spanY);
            const targetCells = Math.max(2000, Number(altResolverConfig.rasterTargetCells) || 22000);
            const hardMaxCells = Math.max(targetCells, Number(altResolverConfig.rasterHardMaxCells) || 90000);
            const budgetStep = Math.sqrt(rawAreaCells / targetCells);
            const hardStep = Math.sqrt(rawAreaCells / hardMaxCells);
            const minAllowedStep = Math.max(0.2, hardStep);
            const detailStep = step;
            step = Math.max(detailStep, minAllowedStep, budgetStep);
            step = Math.max(0.2, Math.round(step * 100) / 100);
            const width = Math.max(3, Math.ceil((maxX - minX) / step) + 1);
            const height = Math.max(3, Math.ceil((maxY - minY) / step) + 1);
            if (width * height > hardMaxCells * 1.25) return [];
            if (floodStats) {
                floodStats.rasterComponents += 1;
                floodStats.rasterCellsScanned += width * height;
                if (step > detailStep + 1e-6) floodStats.rasterBudgetUpscaledComponents = (floodStats.rasterBudgetUpscaledComponents || 0) + 1;
            }
            const wall = new Uint8Array(width * height);
            const wallOwners = new Map();
            const visited = new Uint8Array(width * height);
            const regionGrid = new Int32Array(width * height);
            const idxOf = (x, y) => y * width + x;
            const addWallOwner = (idx, edgeIndex) => {
                let owners = wallOwners.get(idx);
                if (!owners) {
                    owners = new Set();
                    wallOwners.set(idx, owners);
                }
                owners.add(edgeIndex);
            };
            const markWall = (x, y, edgeIndex) => {
                const wallRadius = step <= 0.5 ? 1 : 1;
                for (let dy = -wallRadius; dy <= wallRadius; dy++) {
                    for (let dx = -wallRadius; dx <= wallRadius; dx++) {
                        const xx = x + dx, yy = y + dy;
                        if (xx >= 0 && yy >= 0 && xx < width && yy < height) {
                            const idx = idxOf(xx, yy);
                            wall[idx] = 1;
                            addWallOwner(idx, edgeIndex);
                        }
                    }
                }
            };
            componentEdges.forEach(({ a, b }, edgeIndex) => {
                const pa = calcPoints[a], pb = calcPoints[b];
                const ax = Math.round((pa.x - minX) / step), ay = Math.round((pa.y - minY) / step);
                const bx = Math.round((pb.x - minX) / step), by = Math.round((pb.y - minY) / step);
                const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
                for (let i = 0; i <= n; i++) {
                    const t = i / n;
                    markWall(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), edgeIndex);
                }
            });
            const components = [];
            let nextRegionId = 1;
            const neighborOffsets = [1, -1, width, -width];
            for (let sy = 0; sy < height; sy++) {
                for (let sx = 0; sx < width; sx++) {
                    const startIdx = idxOf(sx, sy);
                    if (visited[startIdx] || wall[startIdx]) continue;
                    const queue = [startIdx];
                    const component = [];
                    const boundaryEdgeIds = new Set();
                    let touchesEdge = false;
                    const regionId = nextRegionId++;
                    visited[startIdx] = 1;
                    regionGrid[startIdx] = regionId;
                    for (let qi = 0; qi < queue.length; qi++) {
                        const cellIdx = queue[qi];
                        const x = cellIdx % width;
                        const y = Math.floor(cellIdx / width);
                        component.push(cellIdx);
                        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
                        for (let oi = 0; oi < neighborOffsets.length; oi++) {
                            const nx = x + (oi === 0 ? 1 : oi === 1 ? -1 : 0);
                            const ny = y + (oi === 2 ? 1 : oi === 3 ? -1 : 0);
                            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                            const ni = cellIdx + neighborOffsets[oi];
                            if (wall[ni]) {
                                const owners = wallOwners.get(ni);
                                if (owners) owners.forEach(edgeIndex => boundaryEdgeIds.add(edgeIndex));
                                continue;
                            }
                            if (visited[ni]) continue;
                            visited[ni] = 1;
                            regionGrid[ni] = regionId;
                            queue.push(ni);
                        }
                    }
                    components.push({ id: regionId, component, touchesEdge, boundaryEdgeIds });
                }
            }
            const regionAt = (x, y) => {
                const xx = Math.round(x), yy = Math.round(y);
                if (xx < 0 || yy < 0 || xx >= width || yy >= height) return -1;
                return regionGrid[idxOf(xx, yy)];
            };
            const boundaryEdgesForRegion = (regionId) => {
                const out = [];
                componentEdges.forEach(edge => {
                    const pa = calcPoints[edge.a], pb = calcPoints[edge.b];
                    const ax = (pa.x - minX) / step, ay = (pa.y - minY) / step;
                    const bx = (pb.x - minX) / step, by = (pb.y - minY) / step;
                    const dx = bx - ax, dy = by - ay;
                    const len = Math.hypot(dx, dy);
                    if (len < 0.001) return;
                    const nx = -dy / len, ny = dx / len;
                    let plus = false, minus = false;
                    const samples = Math.max(5, Math.ceil(len / 4));
                    for (let i = 1; i < samples; i++) {
                        const t = i / samples;
                        const x = ax + dx * t, y = ay + dy * t;
                        if (regionAt(x + nx * 3, y + ny * 3) === regionId) plus = true;
                        if (regionAt(x - nx * 3, y - ny * 3) === regionId) minus = true;
                    }
                    if (plus !== minus) out.push(edge);
                });
                return out;
            };
            const cells = [];
            components.forEach(({ id, component, touchesEdge, boundaryEdgeIds }) => {
                if (touchesEdge || component.length < 4) return;
                const rasterPts = polygonFromFloodComponentAlt(component, width, height, minX, minY, step);
                if (!rasterPts || rasterPts.length < 3 || touchesViewportBoundaryAlt(rasterPts)) return;
                const boundaryEdges = Array.from(boundaryEdgeIds || []).map(edgeIndex => componentEdges[edgeIndex]).filter(Boolean);
                const inferredEdges = boundaryEdgesForRegion(id);
                inferredEdges.forEach(edge => {
                    if (!boundaryEdges.some(existing => existing.key === edge.key)) boundaryEdges.push(edge);
                });
                const rasterArea = Math.abs(signedAreaAlt(rasterPts));
                const boundaryPruned = pruneBoundaryEdgesAlt(boundaryEdges);
                const floodPruned = pruneBoundaryEdgesAlt(componentEdges);
                const boundaryPrunedEdges = boundaryPruned && boundaryPruned.edges ? boundaryPruned.edges : [];
                const floodPrunedEdges = floodPruned && floodPruned.edges ? floodPruned.edges : [];
                const prunedBoundaryEdges = boundaryPrunedEdges.length >= 3 ? boundaryPrunedEdges : floodPrunedEdges;
                const prunedBoundarySource = boundaryPrunedEdges.length >= 3 ? 'boundary' : 'flood';
                const loopPts = loopFromBoundaryEdgesAlt(prunedBoundaryEdges, calcPoints, rasterArea);
                const pts = loopPts || rasterPts;
                const area = Math.abs(signedAreaAlt(pts));
                if (area <= MIN_GRAPH_FACE_AREA_ALT) return;
                const geometryPlane = loopPts ? planeFromGeometryLoopAlt(loopPts) : null;
                cells.push({
                    points: pts,
                    rasterPoints: rasterPts,
                    boundaryEdges,
                    prunedBoundaryEdges,
                    prunedBoundarySource,
                    floodEdges: componentEdges,
                    prunedFloodEdges: floodPrunedEdges,
                    calcPoints: loopPts ? loopPts.map(pt => calcPoints[pointId(activeGeometry.points, pt)]).filter(Boolean) : [],
                    area,
                    planeGroup,
                    plane: geometryPlane || planeGroup.plane,
                    floodPlane: planeGroup.plane,
                    sourceCandidate: planeGroup.sourceCandidate || null,
                    sourceCalcPoints: calcPoints,
                    layer: planeGroup.layer,
                    usedRasterFallback: !loopPts
                });
            });
            return cells;
        };

        const cells = [];
        const edgeComponents = splitPlaneEdgesIntoComponentsAlt(edges);
        if (floodStats) floodStats.edgeComponents += edgeComponents.length;
        edgeComponents.forEach(componentEdges => {
            const componentKey = componentStableKeyAlt(componentEdges, calcPoints);
            const cachedComponentCells = altFloodComponentCache.get(componentKey);
            if (cachedComponentCells) {
                if (floodStats) floodStats.componentCacheHits += 1;
                cachedComponentCells.forEach(cell => {
                    const cloned = cloneFloodCellForPlaneGroupAlt(cell, planeGroup);
                    if (cloned) cells.push(cloned);
                });
                return;
            }
            if (floodStats) floodStats.componentCacheMisses += 1;
            const graphCell = cellFromGraphLoopAlt(componentEdges, calcPoints, planeGroup);
            let componentCells = [];
            if (graphCell) {
                if (floodStats) floodStats.graphFastPath += 1;
                componentCells = [graphCell];
            } else {
                componentCells = rasterFloodEdgeSet(componentEdges);
            }
            altFloodComponentCache.set(componentKey, componentCells);
            componentCells.forEach(cell => cells.push(cell));
        });
        altFloodEdgeSetCache.set(edgeSetKey, cells);
        return cells;
    }

    function dedupeCellsAlt(cells) {
        const bySig = new Map();
        cells.forEach(cell => {
            const sig = Array.isArray(cell.boundaryEdges) && cell.boundaryEdges.length
                ? cell.boundaryEdges.map(edge => edge.key).sort().join('|')
                : `${faceLayerAlt(cell)}|${faceCoordSigAlt(cell.points)}`;
            const prev = bySig.get(sig);
            if (!prev || cell.area < prev.area) bySig.set(sig, cell);
        });
        const byCoordSig = new Map();
        Array.from(bySig.values()).forEach(cell => {
            const sig = `${faceLayerAlt(cell)}|${faceCoordSigAlt(cell.points || [])}`;
            const prev = byCoordSig.get(sig);
            if (!prev || (cell.usedRasterFallback ? 1 : 0) < (prev.usedRasterFallback ? 1 : 0) || (cell.area || 0) < (prev.area || 0)) {
                byCoordSig.set(sig, cell);
            }
        });
        return Array.from(byCoordSig.values()).sort((a, b) => b.area - a.area);
    }

    function collectTriangleCellsAlt(calcPoints) {
        if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return [];
        const adj = new Map();
        const edgeByKey = new Map();
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            const a = pointId(activeGeometry.points, conn.start);
            const b = pointId(activeGeometry.points, conn.end);
            if (a < 0 || b < 0) return;
            const pa = calcPoints[a], pb = calcPoints[b];
            if (!pa || !pb || pa.layer !== pb.layer) return;
            const key = edgeKeyAlt(a, b);
            edgeByKey.set(key, { a, b, key });
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        });

        const triangles = [];
        const seen = new Set();
        Array.from(adj.keys()).forEach(a => {
            const neighbors = Array.from(adj.get(a) || []).sort((x, y) => x - y);
            for (let i = 0; i < neighbors.length; i++) {
                const b = neighbors[i];
                if (b <= a) continue;
                for (let j = i + 1; j < neighbors.length; j++) {
                    const c = neighbors[j];
                    if (c <= b) continue;
                    if (!adj.get(b)?.has(c)) continue;
                    const pa = calcPoints[a], pb = calcPoints[b], pc = calcPoints[c];
                    if (!pa || !pb || !pc || pa.layer !== pb.layer || pa.layer !== pc.layer) continue;
                    const sig = [a, b, c].sort((x, y) => x - y).join('|');
                    if (seen.has(sig)) continue;
                    seen.add(sig);
                    const pts = [pa.ref, pb.ref, pc.ref];
                    const area = Math.abs(signedAreaAlt(pts));
                    if (area <= MIN_GRAPH_FACE_AREA_ALT) continue;
                    const plane = planeFromThreePointsAlt(pa, pb, pc) || planeFromGeometryLoopAlt(pts);
                    if (!plane) continue;
                    const boundaryEdges = [
                        edgeByKey.get(edgeKeyAlt(a, b)),
                        edgeByKey.get(edgeKeyAlt(b, c)),
                        edgeByKey.get(edgeKeyAlt(a, c))
                    ].filter(Boolean);
                    triangles.push({
                        points: pts,
                        rasterPoints: pts,
                        boundaryEdges,
                        prunedBoundaryEdges: boundaryEdges,
                        prunedBoundarySource: 'triangle',
                        floodEdges: boundaryEdges,
                        prunedFloodEdges: boundaryEdges,
                        calcPoints: [pa, pb, pc],
                        area,
                        planeGroup: null,
                        plane,
                        floodPlane: plane,
                        sourceCandidate: null,
                        sourceCalcPoints: calcPoints,
                        layer: pa.layer,
                        usedRasterFallback: false,
                        usedTriangleFastPath: true
                    });
                }
            }
        });
        return triangles;
    }

    function getPlaneZAtAlt(face, x, y) {
        const slope = planeToSlopeAlt(face.plane);
        if (!slope) return null;
        return slope.a * x + slope.b * y + slope.c;
    }

    function slopeForDebugFaceAlt(face) {
        if (!face) return null;
        if (face.plane?.normal) return planeToSlopeAlt(face.plane);
        if (Number.isFinite(face.plane?.a) && Number.isFinite(face.plane?.b) && Number.isFinite(face.plane?.c)) return face.plane;
        if (face.floodPlane?.normal) return planeToSlopeAlt(face.floodPlane);
        if (Number.isFinite(face.floodPlane?.a) && Number.isFinite(face.floodPlane?.b) && Number.isFinite(face.floodPlane?.c)) return face.floodPlane;
        return null;
    }

    function pixelsPerMeterAlt() {
        const metersPerPx = (window.getMetersPerPx
            ? window.getMetersPerPx()
            : (((window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20)) * 2) / imageWidth));
        return metersPerPx > 0 ? 1 / metersPerPx : 1;
    }

    function metricNormalFromSlopeAlt(slope) {
        if (!slope || !Number.isFinite(slope.a) || !Number.isFinite(slope.b)) return null;
        const ppm = pixelsPerMeterAlt();
        let normal = { x: -(slope.a || 0) * ppm, y: -(slope.b || 0) * ppm, z: 1 };
        const len = Math.hypot(normal.x, normal.y, normal.z);
        if (len < 1e-9) return null;
        normal = { x: normal.x / len, y: normal.y / len, z: normal.z / len };
        if (normal.z < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
        return normal;
    }

    function metricNormalForDebugFaceAlt(face) {
        return metricNormalFromSlopeAlt(slopeForDebugFaceAlt(face));
    }

    function debugFaceAngleLabelAlt(face) {
        const slope = slopeForDebugFaceAlt(face);
        if (!slope) return '?';
        let deg = null;
        if (typeof getPlanePitchDegrees === 'function') {
            deg = getPlanePitchDegrees(slope);
        } else {
            deg = Math.atan(Math.hypot(slope.a || 0, slope.b || 0)) * 180 / Math.PI;
        }
        return Number.isFinite(deg) ? `${deg.toFixed(1)}°` : '?';
    }

    function debugFaceLabelAlt(face, idLabel) {
        return altResolverConfig.debugLabelMode === 'angle'
            ? debugFaceAngleLabelAlt(face)
            : idLabel;
    }

    function faceBoundaryCoordEdgeKeysAlt(face) {
        const pts = face?.points || [];
        const keys = [];
        if (pts.length < 3) return keys;
        const coordKey = (p) => `${Math.round((p.x || 0) * 10)},${Math.round((p.y || 0) * 10)}`;
        for (let i = 0; i < pts.length; i++) {
            const a = coordKey(pts[i]);
            const b = coordKey(pts[(i + 1) % pts.length]);
            keys.push(a < b ? `${a}|${b}` : `${b}|${a}`);
        }
        return keys;
    }

    function markOccludedFacesAlt(faces) {
        if (!Array.isArray(faces) || faces.length < 2) return faces || [];
        const edgeUseByLayer = new Map();
        faces.forEach(face => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
            const layer = faceLayerAlt(face);
            if (!edgeUseByLayer.has(layer)) edgeUseByLayer.set(layer, new Map());
            const edgeUse = edgeUseByLayer.get(layer);
            faceBoundaryCoordEdgeKeysAlt(face).forEach(key => {
                edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
            });
        });
        faces.forEach(face => {
            face.isOccluded = false;
            face.occlusionRatio = 0;
            face.occludingFaceCount = 0;
            face.occlusionAllEdgesShared = false;
            face.occlusionUniqueEdgeCount = 0;
            face.occlusionRejectedReason = null;
        });
        const zGap = 0.05;
        faces.forEach(face => {
            const pts = face.points || [];
            if (pts.length < 3) return;
            const edgeUse = edgeUseByLayer.get(faceLayerAlt(face)) || new Map();
            const edgeKeys = faceBoundaryCoordEdgeKeysAlt(face);
            const uniqueEdgeCount = edgeKeys.filter(key => (edgeUse.get(key) || 0) < 2).length;
            const allEdgesShared = edgeKeys.length > 0 && uniqueEdgeCount === 0;
            face.occlusionAllEdgesShared = allEdgesShared;
            face.occlusionUniqueEdgeCount = uniqueEdgeCount;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            pts.forEach(p => {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y);
            });
            const width = maxX - minX;
            const height = maxY - minY;
            if (width <= 0 || height <= 0) return;
            const sampleStep = Math.max(4, Math.min(18, Math.max(width, height) / 24));
            let total = 0;
            let covered = 0;
            const coverers = new Set();
            for (let y = minY + sampleStep * 0.5; y <= maxY; y += sampleStep) {
                for (let x = minX + sampleStep * 0.5; x <= maxX; x += sampleStep) {
                    if (!isPointInPoly(x, y, pts)) continue;
                    total++;
                    const ownZ = getPlaneZAtAlt(face, x, y);
                    if (!Number.isFinite(ownZ)) continue;
                    for (let i = 0; i < faces.length; i++) {
                        const other = faces[i];
                        if (other === face || !other.points || other.points.length < 3) continue;
                        if (!sameFaceLayerAlt(face, other)) continue;
                        if (!isPointInPoly(x, y, other.points)) continue;
                        const otherZ = getPlaneZAtAlt(other, x, y);
                        if (!Number.isFinite(otherZ)) continue;
                        if (otherZ > ownZ + zGap) {
                            covered++;
                            coverers.add(other);
                            break;
                        }
                    }
                }
            }
            face.occlusionRatio = total ? covered / total : 0;
            face.occludingFaceCount = coverers.size;
            const coveragePass = face.occlusionRatio >= altResolverConfig.occlusionCoverage;
            face.isOccluded = coveragePass && allEdgesShared;
            if (coveragePass && !allEdgesShared) {
                face.occlusionRejectedReason = 'has-exposed-boundary-edge';
            }
        });
        return faces;
    }

    function calcPointForRefAlt(pt) {
        if (!pt) return null;
        let z = pt.z;
        if ((z === null || z === undefined || !Number.isFinite(z)) && typeof layerData !== 'undefined' && layerData && layerData.dsm && layerData.dsm[0]) {
            const w = typeof imageWidth !== 'undefined' ? imageWidth : 0;
            const h = typeof imageHeight !== 'undefined' ? imageHeight : 0;
            if (w && h) {
                const ix = clampAlt(Math.round(pt.x), 0, w - 1);
                const iy = clampAlt(Math.round(pt.y), 0, h - 1);
                const val = layerData.dsm[0][iy * w + ix];
                z = (val > -9000 && Number.isFinite(val)) ? val : 0;
            }
        }
        return { x: pt.x, y: pt.y, z: Number.isFinite(z) ? z : 0, layer: pt.layer || 1, ref: pt };
    }

    function localFacePlaneDistanceSummaryAlt(sourceFace, targetPlane) {
        const pts = Array.isArray(sourceFace?.points) ? sourceFace.points : [];
        if (!pts.length || !targetPlane) return { count: 0, max: Infinity, avg: Infinity };
        let max = 0;
        let sum = 0;
        let count = 0;
        pts.forEach(pt => {
            const cp = calcPointForRefAlt(pt);
            if (!cp) return;
            const dist = distanceToPlaneAlt(targetPlane, cp);
            if (!Number.isFinite(dist)) return;
            max = Math.max(max, dist);
            sum += dist;
            count++;
        });
        return {
            count,
            max: count ? max : Infinity,
            avg: count ? sum / count : Infinity
        };
    }

    function compareAltFacePlanes(faceA, faceB) {
        if (!faceA || !faceB || !faceA.plane || !faceB.plane || !faceA.plane.normal || !faceB.plane.normal) {
            return { coplanar: false, dot: 0, rawDot: 0, dDiff: Infinity };
        }
        const lenA = Math.hypot(faceA.plane.normal.x || 0, faceA.plane.normal.y || 0, faceA.plane.normal.z || 0);
        const lenB = Math.hypot(faceB.plane.normal.x || 0, faceB.plane.normal.y || 0, faceB.plane.normal.z || 0);
        if (lenA < 1e-9 || lenB < 1e-9) return { coplanar: false, dot: 0, rawDot: 0, dDiff: Infinity };
        const rawDot = dotProduct(faceA.plane.normal, faceB.plane.normal);
        const dot = rawDot / (lenA * lenB);
        const dDiff = dot >= 0
            ? Math.abs(faceA.plane.d - faceB.plane.d)
            : Math.abs(faceA.plane.d + faceB.plane.d);
        const metricNormalA = metricNormalForDebugFaceAlt(faceA);
        const metricNormalB = metricNormalForDebugFaceAlt(faceB);
        const metricDotRaw = (metricNormalA && metricNormalB) ? dotProduct(metricNormalA, metricNormalB) : dot;
        const metricDot = Math.max(-1, Math.min(1, metricDotRaw));
        const metricAngleDiffDeg = Math.acos(Math.min(1, Math.abs(metricDot))) * 180 / Math.PI;
        const pointTol = Number.isFinite(Number(altResolverConfig.holePointPlaneTol))
            ? Math.max(0.05, Number(altResolverConfig.holePointPlaneTol))
            : 1.0;
        const localAOnB = localFacePlaneDistanceSummaryAlt(faceA, faceB.plane);
        const localBOnA = localFacePlaneDistanceSummaryAlt(faceB, faceA.plane);
        const anglePass = Math.abs(metricDot) >= altResolverConfig.holePlaneDotTol;
        const dPass = dDiff <= altResolverConfig.holePlaneDTol;
        const localPass = localAOnB.count > 0 && localAOnB.max <= pointTol;
        return {
            coplanar: anglePass && (dPass || localPass),
            dot: metricDot,
            rawDot: metricDotRaw,
            pixelDot: dot,
            pixelRawDot: rawDot,
            dDiff,
            metricAngleDiffDeg,
            anglePass,
            dPass,
            localPass,
            reverseLocalPass: localBOnA.count > 0 && localBOnA.max <= pointTol,
            localAOnB,
            localBOnA,
            pointTol,
            lenA,
            lenB
        };
    }

    function areAltFacesCoplanar(faceA, faceB) {
        return compareAltFacePlanes(faceA, faceB).coplanar;
    }

    function pointOnSegmentAlt(p, a, b, eps = 0.75) {
        const abx = b.x - a.x, aby = b.y - a.y;
        const apx = p.x - a.x, apy = p.y - a.y;
        const len2 = abx * abx + aby * aby;
        if (len2 < eps * eps) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;
        const t = (apx * abx + apy * aby) / len2;
        if (t < -eps || t > 1 + eps) return false;
        const qx = a.x + abx * t, qy = a.y + aby * t;
        return Math.hypot(p.x - qx, p.y - qy) <= eps;
    }

    function pointOnPolygonBoundaryAlt(p, poly, eps = 0.75) {
        if (!Array.isArray(poly) || poly.length < 2) return false;
        for (let i = 0; i < poly.length; i++) {
            if (pointOnSegmentAlt(p, poly[i], poly[(i + 1) % poly.length], eps)) return true;
        }
        return false;
    }

    function pointInsideOrOnPolygonAlt(p, poly, eps = 0.75) {
        if (!p || !Array.isArray(poly) || poly.length < 3) return false;
        return isPointInPoly(p.x, p.y, poly) || pointOnPolygonBoundaryAlt(p, poly, eps);
    }

    function classifyAndRemoveHoleFacesAlt(faces) {
        if (!Array.isArray(faces) || faces.length < 2) return { faces: faces || [], holes: [] };
        const holes = [];
        const keep = [];
        const sampleDistances = [0.5, 1, 2, 5, 10];
        faces.forEach(face => { face.holes = []; });
        faces.forEach(face => {
            face.isHole = false;
            face.holeEdgePassCount = 0;
            face.holeDebug = null;
            const pts = face.points || [];
            if (pts.length < 3 || face.usedRasterFallback) {
                keep.push(face);
                return;
            }
            const centroid = pts.reduce((acc, p) => {
                acc.x += p.x;
                acc.y += p.y;
                return acc;
            }, { x: 0, y: 0 });
            centroid.x /= pts.length;
            centroid.y /= pts.length;

            let allEdgesPass = true;
            let passCount = 0;
            const edgeNeighbors = new Set();
            const edgeNeighborCounts = new Map();
            const faceArea = Math.abs(signedAreaAlt(pts));
            const faceSig = faceCoordSigAlt(pts);
            const qualifiedHoleParent = (other) => {
                if (!other || other === face || other.isHole || !other.points || other.points.length < 3) return false;
                if (!sameFaceLayerAlt(face, other)) return false;
                if (faceCoordSigAlt(other.points) === faceSig) return false;
                const otherArea = Math.abs(signedAreaAlt(other.points || []));
                if (!(otherArea > faceArea * 1.25)) return false;
                return pointInsideOrOnPolygonAlt(centroid, other.points);
            };
            const holeDebug = {
                centroid: { ...centroid },
                area: faceArea,
                pointCount: pts.length,
                usedRasterFallback: !!face.usedRasterFallback,
                plane: face.plane,
                edges: []
            };
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                const edgeDebug = {
                    index: i,
                    a,
                    b,
                    len,
                    mode: null,
                    neighborIndex: -1,
                    planeCompare: null,
                    sample: null,
                    samples: []
                };
                holeDebug.edges.push(edgeDebug);
                if (len < 0.001) {
                    edgeDebug.mode = 'degenerate-edge';
                    allEdgesPass = false;
                    break;
                }
                const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
                let nx = -dy / len, ny = dx / len;
                const towardCentroid = (centroid.x - mid.x) * nx + (centroid.y - mid.y) * ny;
                if (towardCentroid > 0) {
                    nx *= -1;
                    ny *= -1;
                }
                let edgeHasCoplanarNeighbor = false;
                for (const dist of sampleDistances) {
                    const sx = mid.x + nx * dist;
                    const sy = mid.y + ny * dist;
                    const sampleDebug = { dist, x: sx, y: sy, rejected: [] };
                    edgeDebug.samples.push(sampleDebug);
                    const neighbor = faces.find((other, otherIdx) => {
                        if (!qualifiedHoleParent(other)) return false;
                        const planeCompare = compareAltFacePlanes(face, other);
                        const contains = pointInsideOrOnPolygonAlt({ x: sx, y: sy }, other.points);
                        if (!planeCompare.coplanar || !contains) {
                            if (sampleDebug.rejected.length < 6) {
                                sampleDebug.rejected.push({
                                    index: otherIdx,
                                    dot: planeCompare.dot,
                                    rawDot: planeCompare.rawDot,
                                    dDiff: planeCompare.dDiff,
                                    coplanar: planeCompare.coplanar,
                                    contains
                                });
                            }
                            return false;
                        }
                        sampleDebug.match = {
                            index: otherIdx,
                            dot: planeCompare.dot,
                            rawDot: planeCompare.rawDot,
                            dDiff: planeCompare.dDiff,
                            contains
                        };
                        return true;
                    });
                    if (neighbor) {
                        edgeHasCoplanarNeighbor = true;
                        edgeDebug.mode = 'sample';
                        edgeDebug.sample = sampleDebug;
                        edgeDebug.neighborIndex = faces.indexOf(neighbor);
                        edgeDebug.planeCompare = sampleDebug.match || null;
                        edgeNeighbors.add(neighbor);
                        edgeNeighborCounts.set(neighbor, (edgeNeighborCounts.get(neighbor) || 0) + 1);
                        break;
                    }
                }
                if (!edgeHasCoplanarNeighbor) {
                    edgeDebug.boundaryRejected = faces
                        .map((other, otherIdx) => {
                            if (!qualifiedHoleParent(other)) return null;
                            const planeCompare = compareAltFacePlanes(face, other);
                            const centroidInside = pointInsideOrOnPolygonAlt(centroid, other.points);
                            const otherArea = Math.abs(signedAreaAlt(other.points || []));
                            const boundaryPass = pointOnPolygonBoundaryAlt(a, other.points) &&
                                pointOnPolygonBoundaryAlt(mid, other.points) &&
                                pointOnPolygonBoundaryAlt(b, other.points);
                            return (planeCompare.coplanar && centroidInside && boundaryPass)
                                ? { index: otherIdx, planeCompare, centroidInside, boundaryPass, faceArea, otherArea }
                                : null;
                        })
                        .filter(Boolean);
                    const boundaryNeighbor = edgeDebug.boundaryRejected[0];
                    if (boundaryNeighbor) {
                        const neighbor = faces[boundaryNeighbor.index];
                        edgeHasCoplanarNeighbor = true;
                        edgeDebug.mode = 'boundary';
                        edgeDebug.neighborIndex = boundaryNeighbor.index;
                        edgeDebug.planeCompare = boundaryNeighbor.planeCompare;
                        edgeDebug.boundary = boundaryNeighbor;
                        edgeNeighbors.add(neighbor);
                        edgeNeighborCounts.set(neighbor, (edgeNeighborCounts.get(neighbor) || 0) + 1);
                    }
                }
                if (!edgeHasCoplanarNeighbor) {
                    edgeDebug.mode = edgeDebug.mode || 'failed';
                    allEdgesPass = false;
                    break;
                }
                passCount++;
            }
            face.holeEdgePassCount = passCount;
            const commonParent = Array.from(edgeNeighborCounts.entries())
                .filter(([, count]) => count === pts.length)
                .map(([neighbor]) => neighbor)
                .sort((a, b) => Math.abs(signedAreaAlt(a.points || [])) - Math.abs(signedAreaAlt(b.points || [])))[0] || null;
            if (allEdgesPass && passCount === pts.length && commonParent) {
                face.isHole = true;
                face.holeDebug = holeDebug;
                const parent = commonParent;
                if (parent) {
                    if (!Array.isArray(parent.holes)) parent.holes = [];
                    parent.holes.push(pts);
                    face.holeParent = parent;
                    holeDebug.parentIndex = faces.indexOf(parent);
                }
                holeDebug.edgeNeighborIndices = Array.from(edgeNeighbors).map(neighbor => faces.indexOf(neighbor));
                holeDebug.edgeNeighborCounts = Array.from(edgeNeighborCounts.entries()).map(([neighbor, count]) => ({
                    index: faces.indexOf(neighbor),
                    count,
                    area: Math.abs(signedAreaAlt(neighbor.points || []))
                }));
                holes.push(face);
            } else {
                if (allEdgesPass && passCount === pts.length && !commonParent) {
                    holeDebug.rejectedReason = 'no-common-larger-parent';
                    face.holeDebug = holeDebug;
                }
                keep.push(face);
            }
        });
        if (!keep.length && holes.length) {
            holes.forEach(face => {
                face.isHole = false;
                if (face.holeParent && Array.isArray(face.holeParent.holes)) {
                    face.holeParent.holes = face.holeParent.holes.filter(hole => hole !== face.points);
                }
                face.holeParent = null;
                if (face.holeDebug) face.holeDebug.rejectedReason = 'kept-to-avoid-empty-face-set';
            });
            return { faces: holes, holes: [] };
        }
        return { faces: keep, holes };
    }

    function buildAltResolverState(options = {}) {
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections)) return;
        if (options && options.force) invalidateAltResolverCaches();
        const buildStart = nowAlt();
        const timings = {};
        rebuildAltPointIndexMap();
        let t = nowAlt();
        const calcPoints = getCalcPointDataAlt();
        timings.calcPointsMs = nowAlt() - t;

        t = nowAlt();
        const candidates = collectPlaneCandidatesAlt(calcPoints);
        timings.candidateMs = nowAlt() - t;

        t = nowAlt();
        const planes = dedupePlanesAlt(candidates);
        timings.planeDedupeMs = nowAlt() - t;

        t = nowAlt();
        const floodPlanes = altResolverConfig.usePlaneDedupeForFlood
            ? planes
            : candidates.map((candidate, idx) => ({
                id: idx + 1,
                layer: candidate.layer,
                plane: candidate.plane,
                candidates: [candidate],
                pointIds: new Set(candidate.pointIds),
                sourceCandidate: candidate,
                stableKey: `${candidate.layer}|${planeStableKeyAlt(candidate.plane)}|${candidate.stableKey || candidate.pointIds.join('|')}`
            }));
        timings.floodPlanePrepMs = nowAlt() - t;

        t = nowAlt();
        const cells = [];
        let floodCacheHits = 0;
        let floodCacheMisses = 0;
        const nextFloodCellCache = new Map();
        const topologyKey = geometryTopologyKeyAlt();
        state.currentFloodStats = {
            edgeComponents: 0,
            graphFastPath: 0,
            rasterComponents: 0,
            rasterCellsScanned: 0,
            rasterBudgetUpscaledComponents: 0,
            edgeSetCacheHits: 0,
            edgeSetCacheMisses: 0,
            componentCacheHits: 0,
            componentCacheMisses: 0
        };
        floodPlanes.forEach(group => {
            const key = `${topologyKey}::${group.stableKey || `${group.layer}|${planeStableKeyAlt(group.plane)}`}`;
            const cached = altFloodCellCache.get(key);
            if (cached) {
                floodCacheHits += 1;
                nextFloodCellCache.set(key, cached);
                cells.push(...cached);
                return;
            }
            floodCacheMisses += 1;
            const groupCells = floodCellsForPlaneAlt(group, calcPoints);
            nextFloodCellCache.set(key, groupCells);
            cells.push(...groupCells);
        });
        altFloodCellCache = nextFloodCellCache;
        timings.floodMs = nowAlt() - t;
        timings.floodCacheHits = floodCacheHits;
        timings.floodCacheMisses = floodCacheMisses;
        timings.edgeComponents = state.currentFloodStats.edgeComponents;
        timings.graphFastPath = state.currentFloodStats.graphFastPath;
        timings.rasterComponents = state.currentFloodStats.rasterComponents;
        timings.rasterCellsScanned = state.currentFloodStats.rasterCellsScanned;
        timings.rasterBudgetUpscaledComponents = state.currentFloodStats.rasterBudgetUpscaledComponents;
        timings.edgeSetCacheHits = state.currentFloodStats.edgeSetCacheHits;
        timings.edgeSetCacheMisses = state.currentFloodStats.edgeSetCacheMisses;
        timings.componentCacheHits = state.currentFloodStats.componentCacheHits;
        timings.componentCacheMisses = state.currentFloodStats.componentCacheMisses;
        state.currentFloodStats = null;

        t = nowAlt();
        const triangleCells = collectTriangleCellsAlt(calcPoints);
        timings.triangleMs = nowAlt() - t;
        timings.triangleCells = triangleCells.length;
        cells.push(...triangleCells);

        state.candidates = candidates;
        state.planes = planes;
        state.floodPlanes = floodPlanes;
        state.cells = cells;

        t = nowAlt();
        const dedupedFaces = dedupeCellsAlt(cells);
        timings.cellDedupeMs = nowAlt() - t;

        t = nowAlt();
        const holeResult = classifyAndRemoveHoleFacesAlt(dedupedFaces);
        timings.holeMs = nowAlt() - t;
        state.holeFaces = holeResult.holes;

        t = nowAlt();
        state.faces = markOccludedFacesAlt(holeResult.faces);
        if (state.faces.length && state.faces.every(face => face.isOccluded)) {
            state.faces.forEach(face => {
                face.isOccluded = false;
                face.occlusionRejectedReason = 'kept-to-avoid-empty-face-set';
            });
        }
        timings.occlusionMs = nowAlt() - t;

        t = nowAlt();
        updateAltFaceUiStatus();
        timings.uiStatusMs = nowAlt() - t;
        timings.totalBuildMs = nowAlt() - buildStart;
        state.lastBuildTimings = timings;
    }

    function colorForAlt(idx, alpha = 1) {
        const hue = (idx * 137.508) % 360;
        const sat = 82 + ((idx % 3) * 7);
        const light = [44, 58, 36, 68][idx % 4];
        return `hsla(${hue.toFixed(1)}, ${sat}%, ${light}%, ${alpha})`;
    }
    function color3DForAlt(idx) {
        const hue = (idx * 137.508) % 360;
        const sat = 82 + ((idx % 3) * 7);
        const light = [44, 58, 36, 68][idx % 4];
        return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
    }

    function pointGlobalIdAlt(point) {
        if (!point) return -1;
        const ref = point.ref || point;
        if (altPointIndexMap.has(ref)) return altPointIndexMap.get(ref);
        return (activeGeometry?.points || []).indexOf(ref);
    }

    function pointDebugRowAlt(point, idx = 0) {
        if (!point) return null;
        return {
            facePointIndex: idx,
            pointId: pointGlobalIdAlt(point),
            x: +(Number(point.x) || 0).toFixed(3),
            y: +(Number(point.y) || 0).toFixed(3),
            z: Number.isFinite(Number(point.z)) ? +Number(point.z).toFixed(3) : null,
            layer: point.layer || point.ref?.layer || 1,
            hasGeometryRef: !!point.ref || (activeGeometry?.points || []).includes(point)
        };
    }

    function connectionDebugRowAlt(conn, idx) {
        if (!conn) return null;
        return {
            connectionIndex: idx,
            startPointId: pointGlobalIdAlt(conn.start),
            endPointId: pointGlobalIdAlt(conn.end),
            type: conn.type || '',
            manualType: !!conn.manualType,
            layer: conn.start?.layer || conn.end?.layer || 1
        };
    }

    function faceConnectionRowsAlt(face) {
        const pts = face?.points || [];
        const connections = activeGeometry?.connections || [];
        if (pts.length < 2 || !connections.length) return [];
        const rows = [];
        for (let i = 0; i < pts.length; i++) {
            const aId = pointGlobalIdAlt(pts[i]);
            const bId = pointGlobalIdAlt(pts[(i + 1) % pts.length]);
            const matchIdx = connections.findIndex(conn => {
                const ca = pointGlobalIdAlt(conn.start);
                const cb = pointGlobalIdAlt(conn.end);
                return (ca === aId && cb === bId) || (ca === bId && cb === aId);
            });
            rows.push({
                faceEdgeIndex: i,
                startPointId: aId,
                endPointId: bId,
                connection: matchIdx >= 0 ? connectionDebugRowAlt(connections[matchIdx], matchIdx) : null
            });
        }
        return rows;
    }

    function calcEdgeRowsAlt(edges, calcPoints) {
        if (!Array.isArray(edges) || !Array.isArray(calcPoints)) return [];
        return edges.map((edge, idx) => {
            const a = calcPoints[edge.a];
            const b = calcPoints[edge.b];
            return {
                edgeIndex: idx,
                a: edge.a,
                b: edge.b,
                aPoint: pointDebugRowAlt(a, edge.a),
                bPoint: pointDebugRowAlt(b, edge.b),
                mode: edge.mode || edge.source || ''
            };
        });
    }

    function summarizePlaneAlt(plane) {
        if (!plane || !plane.normal) return null;
        return {
            normal: {
                x: +Number(plane.normal.x || 0).toFixed(6),
                y: +Number(plane.normal.y || 0).toFixed(6),
                z: +Number(plane.normal.z || 0).toFixed(6)
            },
            d: +Number(plane.d || 0).toFixed(6)
        };
    }

    function clearAltInspectionHighlight() {
        const svg = document.getElementById('geoSvg');
        if (svg) svg.querySelectorAll('.alt-face-inspect-highlight').forEach(el => el.remove());
        if (debug3DGroup) {
            [...debug3DGroup.children].forEach(child => {
                if (!child.userData?.altFaceInspectHighlight) return;
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
                debug3DGroup.remove(child);
            });
        }
    }

    function addInspectionSvgLine(layer, a, b, color, width = 1, dash = '') {
        if (!layer || !a || !b) return null;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.y);
        line.setAttribute('class', 'alt-face-inspect-highlight');
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', String(width));
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-linejoin', 'round');
        line.setAttribute('stroke-opacity', '0.98');
        if (dash) line.setAttribute('stroke-dasharray', dash);
        line.style.pointerEvents = 'none';
        layer.appendChild(line);
        return line;
    }

    function addInspectionSvgText(layer, x, y, text, color = '#ffffff', size = 3) {
        if (!layer || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', x);
        label.setAttribute('y', y);
        label.setAttribute('class', 'alt-face-inspect-highlight');
        label.setAttribute('fill', color);
        label.setAttribute('stroke', '#000000');
        label.setAttribute('stroke-width', '0.7');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('font-size', String(size));
        label.setAttribute('font-weight', '800');
        label.textContent = text;
        label.style.pointerEvents = 'none';
        layer.appendChild(label);
        return label;
    }

    function addInspection3DLine(a, b, color = '#ffea00', yLift = 1.4) {
        const group = ensureAltFace3DGroup();
        if (!group || typeof THREE === 'undefined' || !a || !b) return;
        const va = getVector3(a);
        const vb = getVector3(b);
        va.y += yLift;
        vb.y += yLift;
        const geometry = new THREE.BufferGeometry().setFromPoints([va, vb]);
        const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(color),
            depthTest: false,
            transparent: true,
            opacity: 1
        });
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 1500;
        line.userData.altFaceInspectHighlight = true;
        group.add(line);
    }

    function drawAltInspectionHighlight(face, label, payload) {
        clearAltInspectionHighlight();
        const layer = ensureAltFaceSvgLayer();
        const pts = face?.points || [];
        if (!layer || pts.length < 2) return;

        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            addInspectionSvgLine(layer, a, b, '#000000', 3);
            addInspectionSvgLine(layer, a, b, '#ffea00', 1.8);
            addInspectionSvgLine(layer, a, b, '#ff2bd6', 0.8);
            addInspection3DLine(a, b);
            const edge = payload?.faceEdges?.[i];
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;
            const conn = edge?.connection;
            const connText = conn ? `E${i} C${conn.connectionIndex} ${conn.type || ''}` : `E${i} no line`;
            addInspectionSvgText(layer, midX, midY, connText.trim(), conn ? '#9dff00' : '#ff4040', 2.8);
        }

        pts.forEach((point, idx) => {
            const pointId = pointGlobalIdAlt(point);
            const outer = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            outer.setAttribute('cx', point.x);
            outer.setAttribute('cy', point.y);
            outer.setAttribute('r', '2.6');
            outer.setAttribute('class', 'alt-face-inspect-highlight');
            outer.setAttribute('fill', '#ff2bd6');
            outer.setAttribute('stroke', '#000000');
            outer.setAttribute('stroke-width', '0.8');
            outer.style.pointerEvents = 'none';
            layer.appendChild(outer);
            const inner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            inner.setAttribute('cx', point.x);
            inner.setAttribute('cy', point.y);
            inner.setAttribute('r', '1.1');
            inner.setAttribute('class', 'alt-face-inspect-highlight');
            inner.setAttribute('fill', '#ffea00');
            inner.setAttribute('stroke', '#000000');
            inner.setAttribute('stroke-width', '0.4');
            inner.style.pointerEvents = 'none';
            layer.appendChild(inner);
            addInspectionSvgText(layer, point.x, point.y - 5, `P${idx} id:${pointId}`, '#ffffff', 2.8);
        });

        const raster = face?.rasterPoints || [];
        if (raster.length >= 3 && raster !== pts) {
            for (let i = 0; i < raster.length; i++) {
                addInspectionSvgLine(layer, raster[i], raster[(i + 1) % raster.length], '#00e5ff', 0.9, '3 2');
            }
            const rx = raster.reduce((sum, p) => sum + p.x, 0) / raster.length;
            const ry = raster.reduce((sum, p) => sum + p.y, 0) / raster.length;
            addInspectionSvgText(layer, rx, ry, 'raster fallback outline', '#00e5ff', 3);
        }

        const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
        addInspectionSvgText(layer, cx, cy - 8, `${label} inspected`, '#ffea00', 3.4);
    }

    function inspectAltDebugFace(face, label = 'face', event = null) {
        if (!face) return;
        selectedAltDebugFace = face;
        const points = (face.points || []).map(pointDebugRowAlt).filter(Boolean);
        const rasterPoints = (face.rasterPoints || []).map(pointDebugRowAlt).filter(Boolean);
        const edgeRows = faceConnectionRowsAlt(face);
        const boundaryRows = calcEdgeRowsAlt(face.boundaryEdges, face.sourceCalcPoints || face.calcPoints || []);
        const prunedRows = calcEdgeRowsAlt(face.prunedBoundaryEdges, face.sourceCalcPoints || face.calcPoints || []);
        const floodRows = calcEdgeRowsAlt(face.floodEdges, face.sourceCalcPoints || face.calcPoints || []);
        const payload = {
            label,
            step: state.step,
            faceIndex: (state.faces || []).indexOf(face),
            holeIndex: (state.holeFaces || []).indexOf(face),
            layer: faceLayerAlt(face),
            isHole: !!face.isHole,
            isOccluded: !!face.isOccluded,
            area: Number.isFinite(Number(face.area)) ? +Number(face.area).toFixed(3) : Math.abs(signedAreaAlt(face.points || [])),
            pointCount: points.length,
            rasterPointCount: rasterPoints.length,
            usedRasterFallback: !!face.usedRasterFallback,
            prunedBoundarySource: face.prunedBoundarySource || '',
            plane: summarizePlaneAlt(face.plane),
            floodPlane: summarizePlaneAlt(face.floodPlane),
            occlusion: {
                ratio: Number.isFinite(Number(face.occlusionRatio)) ? +Number(face.occlusionRatio).toFixed(4) : 0,
                occludingFaceCount: face.occludingFaceCount || 0,
                allEdgesShared: !!face.occlusionAllEdgesShared,
                uniqueEdgeCount: face.occlusionUniqueEdgeCount || 0,
                rejectedReason: face.occlusionRejectedReason || null
            },
            holes: (face.holes || []).map((hole, idx) => ({
                holeIndex: idx,
                points: (hole || []).map(pointDebugRowAlt).filter(Boolean)
            })),
            points,
            rasterPoints,
            faceEdges: edgeRows,
            boundaryEdges: boundaryRows,
            prunedBoundaryEdges: prunedRows,
            floodEdges: floodRows,
            rawFace: face
        };
        console.groupCollapsed(`[AltFaceResolver] Inspect ${label}`);
        console.info(payload);
        console.table(points);
        if (edgeRows.length) console.table(edgeRows.map(row => ({
            faceEdgeIndex: row.faceEdgeIndex,
            startPointId: row.startPointId,
            endPointId: row.endPointId,
            connectionIndex: row.connection?.connectionIndex ?? null,
            type: row.connection?.type ?? '',
            manualType: row.connection?.manualType ?? false
        })));
        if (prunedRows.length) console.table(prunedRows.map(row => ({
            edgeIndex: row.edgeIndex,
            a: row.a,
            b: row.b,
            aPointId: row.aPoint?.pointId ?? null,
            bPointId: row.bPoint?.pointId ?? null,
            mode: row.mode
        })));
        console.groupEnd();
        drawAltInspectionHighlight(face, label, payload);
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        return payload;
    }

    function makeAltFaceInspectable(el, face, label) {
        if (!el || !face) return el;
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'help';
        el.setAttribute('data-alt-face-label', label || 'face');
        const handler = event => {
            if (event?.stopImmediatePropagation) event.stopImmediatePropagation();
            inspectAltDebugFace(face, label || 'face', event);
        };
        el.addEventListener('pointerdown', handler, true);
        el.addEventListener('mousedown', handler, true);
        el.addEventListener('click', handler, true);
        return el;
    }

    function draw2DPolygonAlt(points, attrs = {}) {
        const layer = ensureAltFaceSvgLayer();
        if (!layer || !points || points.length < 2) return null;
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        let d = `M ${points[0].x} ${points[0].y}`;
        for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
        if (attrs.closed !== false) d += ' Z';
        const holes = Array.isArray(attrs.holes) ? attrs.holes : [];
        holes.forEach(hole => {
            if (!Array.isArray(hole) || hole.length < 3) return;
            d += ` M ${hole[0].x} ${hole[0].y}`;
            for (let i = 1; i < hole.length; i++) d += ` L ${hole[i].x} ${hole[i].y}`;
            d += ' Z';
        });
        el.setAttribute('d', d);
        el.setAttribute('class', 'alt-face-debug');
        el.setAttribute('fill', attrs.fill || 'none');
        el.setAttribute('fill-opacity', attrs.fillOpacity ?? '0.18');
        if (holes.length) el.setAttribute('fill-rule', 'evenodd');
        el.setAttribute('stroke', attrs.stroke || '#fff');
        el.setAttribute('stroke-width', attrs.strokeWidth || '2');
        el.style.pointerEvents = 'none';
        layer.appendChild(el);
        if (attrs.inspectFace) makeAltFaceInspectable(el, attrs.inspectFace, attrs.inspectLabel);
        return el;
    }

    function draw2DLoopVerticesAlt(points, color) {
        const layer = ensureAltFaceSvgLayer();
        if (!layer || !points) return;
        points.forEach((point, idx) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', point.x);
            circle.setAttribute('cy', point.y);
            circle.setAttribute('r', idx === 0 ? '4.5' : '3.2');
            circle.setAttribute('class', 'alt-face-debug');
            circle.setAttribute('fill', idx === 0 ? '#fff' : color);
            circle.setAttribute('stroke', '#111');
            circle.setAttribute('stroke-width', '1.2');
            circle.style.pointerEvents = 'none';
            layer.appendChild(circle);
        });
    }

    function draw2DBoundaryEdgesAlt(boundaryEdges, calcPoints, color, width = 5, dash = '') {
        const layer = ensureAltFaceSvgLayer();
        if (!layer || !Array.isArray(boundaryEdges)) return;
        boundaryEdges.forEach(edge => {
            const a = calcPoints[edge.a];
            const b = calcPoints[edge.b];
            if (!a || !b) return;
            const halo = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            halo.setAttribute('x1', a.x);
            halo.setAttribute('y1', a.y);
            halo.setAttribute('x2', b.x);
            halo.setAttribute('y2', b.y);
            halo.setAttribute('class', 'alt-face-debug');
            halo.setAttribute('stroke', '#111');
            halo.setAttribute('stroke-width', String(width + 3));
            halo.setAttribute('stroke-opacity', '0.9');
            halo.setAttribute('stroke-linecap', 'round');
            if (dash) halo.setAttribute('stroke-dasharray', dash);
            halo.style.pointerEvents = 'none';
            layer.appendChild(halo);
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', a.x);
            line.setAttribute('y1', a.y);
            line.setAttribute('x2', b.x);
            line.setAttribute('y2', b.y);
            line.setAttribute('class', 'alt-face-debug');
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', String(width));
            line.setAttribute('stroke-opacity', '0.95');
            line.setAttribute('stroke-linecap', 'round');
            if (dash) line.setAttribute('stroke-dasharray', dash);
            line.style.pointerEvents = 'none';
            layer.appendChild(line);
        });
    }

    function draw2DFallbackLabelAlt(face, text) {
        const layer = ensureAltFaceSvgLayer();
        const pts = face.rasterPoints || face.points;
        if (!layer || !pts || !pts.length) return;
        const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', cx);
        label.setAttribute('y', cy);
        label.setAttribute('class', 'alt-face-debug');
        label.setAttribute('fill', '#fff');
        label.setAttribute('stroke', '#111');
        label.setAttribute('stroke-width', '0.8');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('font-size', '3');
        label.setAttribute('font-weight', '700');
        label.textContent = text;
        label.style.pointerEvents = 'none';
        layer.appendChild(label);
    }

    function draw2DFaceIdLabelAlt(face, text, color = '#ffffff') {
        const layer = ensureAltFaceSvgLayer();
        const pts = face?.rasterPoints || face?.points || [];
        if (!layer || !pts.length) return;
        const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const isOcc = /\bOCC\b/.test(String(text || ''));
        label.setAttribute('x', cx);
        label.setAttribute('y', cy);
        label.setAttribute('class', 'alt-face-debug');
        label.setAttribute('fill', '#ffffff');
        label.setAttribute('stroke', '#111111');
        label.setAttribute('stroke-width', '0.8');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('font-size', isOcc ? '3.2' : '2.8');
        label.setAttribute('font-weight', '800');
        label.textContent = text;
        label.style.pointerEvents = 'none';
        layer.appendChild(label);
        makeAltFaceInspectable(label, face, text);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', cy);
        dot.setAttribute('r', isOcc ? '2.4' : '1.8');
        dot.setAttribute('class', 'alt-face-debug');
        dot.setAttribute('fill', color);
        dot.setAttribute('fill-opacity', isOcc ? '0.96' : '0.85');
        dot.setAttribute('stroke', '#111');
        dot.setAttribute('stroke-width', '0.5');
        dot.style.pointerEvents = 'none';
        makeAltFaceInspectable(dot, face, text);
        layer.insertBefore(dot, label);

        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hit.setAttribute('cx', cx);
        hit.setAttribute('cy', cy);
        hit.setAttribute('r', '10');
        hit.setAttribute('class', 'alt-face-debug');
        hit.setAttribute('fill', '#ffffff');
        hit.setAttribute('fill-opacity', '0.01');
        hit.setAttribute('stroke', 'none');
        makeAltFaceInspectable(hit, face, text);
        layer.appendChild(hit);
    }

    function addDebugMeshAlt(points, plane, color, opacity = 0.35) {
        const group = ensureAltFace3DGroup();
        if (!group || group.children.length >= MAX_DEBUG_MESHES || points.length < 3) return;
        const slope = planeToSlopeAlt(plane);
        if (!slope) return;
        const debugFace = { points, holes: [], layer: points[0].layer || 1, plane };
        const mesh = createFaceMesh(debugFace, slope, debugFace.layer, group.children.length, []);
        mesh.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            emissive: new THREE.Color(color),
            emissiveIntensity: 0.25,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        mesh.userData.altFaceDebug = true;
        mesh.userData.altFaceDebugFace = debugFace;
        mesh.userData.altFaceDebugLabel = 'debug face';
        group.add(mesh);
    }

    function addDebugFaceMeshAlt(face, color, opacity = 0.35) {
        const group = ensureAltFace3DGroup();
        if (!group || !face || !face.points || face.points.length < 3 || group.children.length >= MAX_DEBUG_MESHES) return;
        const slope = planeToSlopeAlt(face.plane);
        if (!slope) return;
        const mesh = createFaceMesh({ points: face.points, holes: face.holes || [], layer: face.layer || 1 }, slope, face.layer || 1, group.children.length, []);
        mesh.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            emissive: new THREE.Color(color),
            emissiveIntensity: 0.25,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        mesh.userData.altFaceDebug = true;
        group.add(mesh);
    }

    function addDebug3DEdgesAlt(boundaryEdges, calcPoints, color, yLift = 0.85) {
        const group = ensureAltFace3DGroup();
        if (!group || !Array.isArray(boundaryEdges) || !Array.isArray(calcPoints)) return 0;
        let drawn = 0;
        boundaryEdges.forEach(edge => {
            const a = calcPoints[edge.a];
            const b = calcPoints[edge.b];
            if (!a || !b) return;
            const va = getVector3(a);
            const vb = getVector3(b);
            va.y += yLift;
            vb.y += yLift;
            const geometry = new THREE.BufferGeometry().setFromPoints([va, vb]);
            const material = new THREE.LineBasicMaterial({
                color: new THREE.Color(color),
                linewidth: 4,
                depthTest: false,
                transparent: true,
                opacity: 1
            });
            const line = new THREE.Line(geometry, material);
            line.renderOrder = 999;
            line.userData.altFaceDebug = true;
            group.add(line);
            drawn++;
        });
        return drawn;
    }

    function addDebug3DLabelAlt(face, text, color = '#ffffff') {
        const group = ensureAltFace3DGroup();
        if (!group || typeof THREE === 'undefined') return;
        const pts = face.rasterPoints || face.points || [];
        if (!pts.length) return;
        const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
        const slope = planeToSlopeAlt(face.plane || face.floodPlane);
        const z = slope ? (slope.a * cx + slope.b * cy + slope.c) : null;
        const pos = getVector3({ x: cx, y: cy, z });
        pos.y += 0.9;

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = 5;
        ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 34px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(material);
        sprite.position.copy(pos);
        sprite.scale.set(1.8, 0.68, 1);
        sprite.renderOrder = 1000;
        sprite.userData.altFaceDebug = true;
        sprite.userData.altFaceDebugFace = face;
        sprite.userData.altFaceDebugLabel = text || 'debug label';
        group.add(sprite);
    }

    function renderAltStep(step = state.step) {
        state.step = clampAlt(step, 1, STEP_LABELS.length);
        if (!state.candidates.length && !state.planes.length) buildAltResolverState();
        clearAltFaceDebug();
        if (state.step === 1) {
            state.candidates.forEach((candidate, idx) => {
                const color = colorForAlt(idx, 0.95);
                draw2DPolygonAlt(candidate.points, { fill: color, fillOpacity: 0.10, stroke: color, strokeWidth: 1.5 });
                addDebugMeshAlt(candidate.points, candidate.plane, color3DForAlt(idx), 0.18);
            });
        } else if (state.step === 2) {
            state.planes.forEach((plane, idx) => {
                const color = colorForAlt(idx, 0.95);
                plane.candidates.slice(0, 20).forEach(candidate => {
                    draw2DPolygonAlt(candidate.points, { fill: 'none', stroke: color, strokeWidth: 2 });
                    addDebugMeshAlt(candidate.points, plane.plane, color3DForAlt(idx), 0.16);
                });
            });
        } else if (state.step === 3) {
            state.cells.forEach((cell, idx) => {
                const color = colorForAlt(idx, 0.95);
                draw2DPolygonAlt(cell.points, { fill: color, fillOpacity: 0.18, stroke: color, strokeWidth: 2 });
                addDebugMeshAlt(cell.points, cell.plane, color3DForAlt(idx), 0.30);
            });
        } else if (state.step === 4) {
            state.faces.forEach((face, idx) => {
                const color = colorForAlt(idx, 0.95);
                if (face.isOccluded) {
                    if (!altResolverConfig.debugShowOccludedFaces) return;
                    const occColor = colorForAlt(idx + 23, 0.98);
                    const occ3DColor = color3DForAlt(idx + 23);
                    draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: occColor, fillOpacity: 0.44, stroke: '#ffffff', strokeWidth: 2, inspectFace: face, inspectLabel: `F${idx} OCC` });
                    draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: 'none', stroke: occColor, strokeWidth: 1, inspectFace: face, inspectLabel: `F${idx} OCC outline` });
                    addDebugFaceMeshAlt(face, occ3DColor, 0.68);
                    draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `F${idx} OCC`), occColor);
                } else {
                    if (!altResolverConfig.debugShowVisibleFaces) return;
                    draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: color, fillOpacity: 0.22, stroke: color, strokeWidth: 1, inspectFace: face, inspectLabel: `F${idx}` });
                    addDebugFaceMeshAlt(face, color3DForAlt(idx), 0.42);
                    draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `F${idx}`), color);
                }
            });
            (state.holeFaces || []).forEach((face, idx) => {
                draw2DPolygonAlt(face.points, { fill: 'rgba(255, 255, 255, 0.05)', fillOpacity: 0.08, stroke: '#00e5ff', strokeWidth: 1, inspectFace: face, inspectLabel: `H${idx}` });
                addDebugMeshAlt(face.points, face.plane, '#00e5ff', 0.12);
                draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `H${idx}`), '#00e5ff');
                addDebug3DLabelAlt(face, 'HOLE', '#00e5ff');
            });
        } else if (state.step === 5) {
            state.faces.forEach((face, idx) => {
                const color = colorForAlt(idx, 0.95);
                if (face.isOccluded) {
                    if (!altResolverConfig.debugShowOccludedFaces) return;
                    const occColor = colorForAlt(idx + 23, 0.98);
                    const occ3DColor = color3DForAlt(idx + 23);
                    draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: occColor, fillOpacity: 0.46, stroke: '#ffffff', strokeWidth: 7, inspectFace: face, inspectLabel: `F${idx} OCC` });
                    if (face.usedRasterFallback) {
                        draw2DPolygonAlt(face.rasterPoints || face.points, { fill: 'none', stroke: occColor, strokeWidth: 3, inspectFace: face, inspectLabel: `F${idx} OCC raster` });
                        const boundaryCount = Array.isArray(face.boundaryEdges) ? face.boundaryEdges.length : 0;
                        const prunedCount = Array.isArray(face.prunedBoundaryEdges) ? face.prunedBoundaryEdges.length : 0;
                        const floodCount = Array.isArray(face.floodEdges) ? face.floodEdges.length : 0;
                        draw2DFallbackLabelAlt(face, `OCC B:${boundaryCount} P:${prunedCount} F:${floodCount}`);
                    } else {
                        draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: 'none', stroke: occColor, strokeWidth: 3, inspectFace: face, inspectLabel: `F${idx} OCC outline` });
                    }
                    addDebugFaceMeshAlt(face, occ3DColor, 0.72);
                    draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `F${idx} OCC`), occColor);
                    addDebug3DLabelAlt(face, `F${idx} OCC ${(face.occlusionRatio * 100).toFixed(0)}%`, occ3DColor);
                } else if (face.usedRasterFallback) {
                    if (!altResolverConfig.debugShowVisibleFaces) return;
                    draw2DPolygonAlt(face.points, { fill: 'rgba(255, 64, 64, 0.35)', fillOpacity: 0.28, stroke: '#ff4040', strokeWidth: 3, inspectFace: face, inspectLabel: `F${idx} FB` });
                    draw2DPolygonAlt(face.rasterPoints || face.points, { fill: 'none', stroke: '#ffffff', strokeWidth: 1.5, inspectFace: face, inspectLabel: `F${idx} FB raster` });
                    const boundaryCount = Array.isArray(face.boundaryEdges) ? face.boundaryEdges.length : 0;
                    const prunedCount = Array.isArray(face.prunedBoundaryEdges) ? face.prunedBoundaryEdges.length : 0;
                    const floodCount = Array.isArray(face.floodEdges) ? face.floodEdges.length : 0;
                    console.warn(`[AltFaceResolver] Fallback face ${idx}: boundaryEdges=${boundaryCount}, prunedBoundaryEdges=${prunedCount}, floodEdges=${floodCount}, source=${face.prunedBoundarySource || 'none'}`, face);
                    if (prunedCount > 0) {
                        draw2DBoundaryEdgesAlt(face.prunedBoundaryEdges, face.sourceCalcPoints || [], '#ffea00', 6);
                        addDebug3DEdgesAlt(face.prunedBoundaryEdges, face.sourceCalcPoints || [], '#ffea00', 0.18);
                    } else {
                        draw2DBoundaryEdgesAlt(face.floodEdges || [], face.sourceCalcPoints || [], '#b56cff', 3, '8 5');
                        addDebug3DEdgesAlt(face.floodEdges || [], face.sourceCalcPoints || [], '#b56cff', 0.18);
                    }
                    draw2DFallbackLabelAlt(face, `B:${boundaryCount} P:${prunedCount} F:${floodCount} ${face.prunedBoundarySource || ''}`);
                    draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `F${idx} FB`), '#ff4040');
                    addDebug3DLabelAlt(face, `B:${boundaryCount} P:${prunedCount} F:${floodCount}`, prunedCount > 0 ? '#ffea00' : '#b56cff');
                    addDebugFaceMeshAlt(face, '#ff4040', 0.24);
                } else {
                    if (!altResolverConfig.debugShowVisibleFaces) return;
                    draw2DPolygonAlt(face.points, { holes: face.holes || [], fill: color, fillOpacity: 0.12, stroke: '#ffffff', strokeWidth: 3, inspectFace: face, inspectLabel: `F${idx}` });
                    draw2DLoopVerticesAlt(face.points, color);
                    draw2DFaceIdLabelAlt(face, debugFaceLabelAlt(face, `F${idx}`), color);
                    addDebugFaceMeshAlt(face, color3DForAlt(idx), 0.50);
                }
            });
        }
        updateAltFaceUiStatus();
    }

    function selectAltResolverStep(step, event = null) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        }
        const nextStep = clampAlt(step, 1, STEP_LABELS.length);
        renderAltStep(nextStep);
        requestAnimationFrame(() => {
            if (state.step !== nextStep) state.step = nextStep;
            renderAltStep(nextStep);
        });
    }

    function ensureAltFaceUi() {
        if (!SHOW_ALT_FACE_RESOLVER_UI) {
            const existing = document.getElementById('altFaceResolverPanel');
            if (existing) existing.remove();
            return;
        }
        const viewport = document.getElementById('viewport');
        if (!viewport || document.getElementById('altFaceResolverPanel')) return;
        const panel = document.createElement('div');
        panel.id = 'altFaceResolverPanel';
        Object.assign(panel.style, {
            position: 'absolute',
            left: '10px',
            top: '10px',
            zIndex: 1200,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '8px',
            background: 'rgba(18, 24, 32, 0.88)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: '6px',
            font: '12px Segoe UI, sans-serif',
            pointerEvents: 'auto',
            maxWidth: '230px'
        });
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'].forEach(type => {
            panel.addEventListener(type, event => {
                event.stopPropagation();
            });
        });
        const title = document.createElement('div');
        title.textContent = 'Alt Face Resolver';
        title.style.fontWeight = '700';
        panel.appendChild(title);
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '4px', flexWrap: 'wrap' });
        STEP_LABELS.forEach((label, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = String(idx + 1);
            btn.title = label;
            btn.dataset.altFaceStep = String(idx + 1);
            Object.assign(btn.style, {
                width: '28px',
                height: '24px',
                border: '1px solid rgba(255,255,255,0.35)',
                background: '#263342',
                color: '#fff',
                borderRadius: '4px',
                cursor: 'pointer'
            });
            btn.onpointerdown = (event) => selectAltResolverStep(idx + 1, event);
            btn.onmousedown = (event) => selectAltResolverStep(idx + 1, event);
            btn.onclick = (event) => selectAltResolverStep(idx + 1, event);
            row.appendChild(btn);
        });
        panel.appendChild(row);
        const tools = document.createElement('div');
        Object.assign(tools.style, { display: 'flex', gap: '4px' });
        const rebuild = document.createElement('button');
        rebuild.type = 'button';
        rebuild.textContent = 'Rebuild';
        rebuild.onclick = () => {
            if (typeof window.invalidateFaceCache === 'function') window.invalidateFaceCache();
            invalidateAltResolverCaches();
            if (typeof window.deleteFaceRenderings === 'function') window.deleteFaceRenderings();
            buildAltResolverState({ force: true });
            if (typeof renderGeometry2D === 'function') renderGeometry2D();
            if (typeof window.renderFinalPass === 'function') window.renderFinalPass(false);
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
            renderAltStep(state.step);
        };
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Clear';
        clear.onclick = clearAltFaceDebug;
        [rebuild, clear].forEach(btn => {
            Object.assign(btn.style, {
                border: '1px solid rgba(255,255,255,0.35)',
                background: '#263342',
                color: '#fff',
                borderRadius: '4px',
                cursor: 'pointer',
                padding: '4px 7px'
            });
            tools.appendChild(btn);
        });
        panel.appendChild(tools);
        const settings = document.createElement('div');
        Object.assign(settings.style, { display: 'grid', gridTemplateColumns: '1fr 58px', gap: '4px 6px', alignItems: 'center' });
        const addSetting = (labelText, key, value, step) => {
            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.color = 'rgba(255,255,255,0.82)';
            const input = document.createElement('input');
            input.type = 'number';
            input.step = String(step);
            input.value = String(value);
            input.dataset.altResolverSetting = key;
            Object.assign(input.style, {
                width: '58px',
                boxSizing: 'border-box',
                background: '#111923',
                border: '1px solid rgba(255,255,255,0.3)',
                color: '#fff',
                borderRadius: '4px',
                padding: '3px'
            });
            input.onchange = () => {
                const next = Number(input.value);
                if (Number.isFinite(next)) altResolverConfig[key] = next;
                buildAltResolverState({ force: true });
                renderAltStep(state.step);
            };
            settings.appendChild(label);
            settings.appendChild(input);
        };
        addSetting('Plane dot', 'planeDotTol', altResolverConfig.planeDotTol, 0.001);
        addSetting('Plane D', 'planeDTol', altResolverConfig.planeDTol, 0.05);
        addSetting('Point tol', 'pointPlaneTol', altResolverConfig.pointPlaneTol, 0.05);
        addSetting('Occ ratio', 'occlusionCoverage', altResolverConfig.occlusionCoverage, 0.05);
        addSetting('Hole dot', 'holePlaneDotTol', altResolverConfig.holePlaneDotTol, 0.001);
        addSetting('Hole D', 'holePlaneDTol', altResolverConfig.holePlaneDTol, 0.02);
        addSetting('Hole pt tol', 'holePointPlaneTol', altResolverConfig.holePointPlaneTol, 0.05);
        addSetting('Raster cells', 'rasterTargetCells', altResolverConfig.rasterTargetCells, 1000);
        const useDedupeLabel = document.createElement('label');
        useDedupeLabel.textContent = 'Flood deduped';
        useDedupeLabel.style.color = 'rgba(255,255,255,0.82)';
        const useDedupe = document.createElement('input');
        useDedupe.type = 'checkbox';
        useDedupe.checked = !!altResolverConfig.usePlaneDedupeForFlood;
        useDedupe.onchange = () => {
            altResolverConfig.usePlaneDedupeForFlood = !!useDedupe.checked;
            buildAltResolverState({ force: true });
            renderAltStep(state.step);
        };
        settings.appendChild(useDedupeLabel);
        settings.appendChild(useDedupe);
        const addDebugToggle = (labelText, key) => {
            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.color = 'rgba(255,255,255,0.82)';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!altResolverConfig[key];
            input.onchange = () => {
                altResolverConfig[key] = !!input.checked;
                renderAltStep(state.step);
            };
            settings.appendChild(label);
            settings.appendChild(input);
        };
        addDebugToggle('Show visible', 'debugShowVisibleFaces');
        addDebugToggle('Show occluded', 'debugShowOccludedFaces');
        const labelModeLabel = document.createElement('label');
        labelModeLabel.textContent = 'Angle labels';
        labelModeLabel.style.color = 'rgba(255,255,255,0.82)';
        const labelModeToggle = document.createElement('input');
        labelModeToggle.type = 'checkbox';
        labelModeToggle.checked = altResolverConfig.debugLabelMode === 'angle';
        labelModeToggle.onchange = () => {
            altResolverConfig.debugLabelMode = labelModeToggle.checked ? 'angle' : 'id';
            renderAltStep(state.step);
        };
        settings.appendChild(labelModeLabel);
        settings.appendChild(labelModeToggle);
        panel.appendChild(settings);
        const profiler = document.createElement('div');
        Object.assign(profiler.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 58px',
            gap: '4px 6px',
            alignItems: 'center',
            borderTop: '1px solid rgba(255,255,255,0.18)',
            paddingTop: '6px'
        });
        const runsLabel = document.createElement('label');
        runsLabel.textContent = 'Profile runs';
        runsLabel.style.color = 'rgba(255,255,255,0.82)';
        const runsInput = document.createElement('input');
        runsInput.type = 'number';
        runsInput.min = '1';
        runsInput.max = '200';
        runsInput.step = '1';
        runsInput.value = '10';
        Object.assign(runsInput.style, {
            width: '58px',
            boxSizing: 'border-box',
            background: '#111923',
            border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff',
            borderRadius: '4px',
            padding: '3px'
        });
        profiler.appendChild(runsLabel);
        profiler.appendChild(runsInput);
        const profileButtons = document.createElement('div');
        Object.assign(profileButtons.style, {
            gridColumn: '1 / -1',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr',
            gap: '4px'
        });
        const profileStatus = document.createElement('div');
        profileStatus.id = 'altFaceResolverProfileStatus';
        Object.assign(profileStatus.style, {
            gridColumn: '1 / -1',
            color: 'rgba(255,255,255,0.78)',
            lineHeight: '1.25',
            fontSize: '11px',
            minHeight: '28px'
        });
        const formatProfileForCopy = (summary) => {
            if (!summary) return 'No Alt Face Resolver profile data.';
            const timeRows = (summary.timeRows || [])
                .map(row => `${row.field}: avg ${row.avg}ms, p95 ${row.p95}ms, max ${row.max}ms, ${row.pct || 0}%`)
                .join('\n');
            const countRows = (summary.countRows || [])
                .map(row => `${row.field}: avg ${row.avg}, last ${row.last}, max ${row.max}`)
                .join('\n');
            return [
                `Alt Face Resolver Profile`,
                `mode: ${summary.mode}`,
                `runs: ${summary.runs}`,
                `force: ${summary.force}`,
                `totalAvgMs: ${summary.totalAvgMs}`,
                '',
                'Timings:',
                timeRows || 'none',
                '',
                'Counts:',
                countRows || 'none'
            ].join('\n');
        };
        const summarizeProfileForUi = (summary) => {
            if (!summary || !summary.timeRows) return 'No profile data.';
            const total = Number(summary.totalAvgMs) || 0;
            const top = (summary.timeRows || [])
                .filter(row => row.field !== 'totalMs' && row.field !== 'totalBuildMs')
                .slice(0, 3)
                .map(row => `${row.field.replace(/Ms$/, '')} ${row.avg}ms`)
                .join(', ');
            const last = summary.last || {};
            return `${summary.mode}: avg ${msAlt(total)}ms over ${summary.runs} runs | ${top || 'no timed stages'} | faces ${last.faces || 0}, cells ${last.cells || 0}`;
        };
        const setProfileBusy = (busy) => {
            profileButtons.querySelectorAll('button').forEach(btn => { btn.disabled = busy; });
            runsInput.disabled = busy;
        };
        const runProfileFromUi = async (profileOptions) => {
            const runs = Math.max(1, Math.min(200, parseInt(runsInput.value || '10', 10) || 10));
            setProfileBusy(true);
            profileStatus.textContent = `Profiling ${runs} run${runs === 1 ? '' : 's'}...`;
            try {
                const summary = await profileAltFaceResolver({ runs, quiet: true, ...profileOptions });
                profileStatus.textContent = summarizeProfileForUi(summary);
            } catch (err) {
                console.error('[AltFaceResolverProfile] UI profile failed', err);
                profileStatus.textContent = `Profile failed: ${err?.message || err}`;
            } finally {
                setProfileBusy(false);
                renderAltStep(state.step);
            }
        };
        [
            { text: 'Build', title: 'Profile resolver build from scratch', options: { render: false, force: true } },
            { text: 'Cached', title: 'Profile resolver build with caches allowed', options: { render: false, force: false } },
            { text: 'Render', title: 'Profile full resolver plus render handoff', options: { render: true, force: true } },
            { text: 'Copy', title: 'Copy latest profile summary to clipboard', copy: true }
        ].forEach(def => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = def.text;
            btn.title = def.title;
            Object.assign(btn.style, {
                border: '1px solid rgba(255,255,255,0.35)',
                background: '#263342',
                color: '#fff',
                borderRadius: '4px',
                cursor: 'pointer',
                padding: '4px 5px',
                fontSize: '11px'
            });
            btn.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (def.copy) {
                    const text = formatProfileForCopy(window.__lastAltFaceResolverProfile);
                    const fallbackCopy = () => {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        ta.style.position = 'fixed';
                        ta.style.left = '-9999px';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        try {
                            document.execCommand('copy');
                            profileStatus.textContent = 'Copied latest profile summary.';
                        } catch (err) {
                            profileStatus.textContent = 'Copy failed; see console for profile summary.';
                            console.info('[AltFaceResolverProfile copy text]', text);
                        }
                        ta.remove();
                    };
                    if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(text)
                            .then(() => { profileStatus.textContent = 'Copied latest profile summary.'; })
                            .catch(() => fallbackCopy());
                    } else {
                        fallbackCopy();
                    }
                    return;
                }
                runProfileFromUi(def.options);
            };
            profileButtons.appendChild(btn);
        });
        profiler.appendChild(profileButtons);
        profiler.appendChild(profileStatus);
        panel.appendChild(profiler);
        const status = document.createElement('div');
        status.id = 'altFaceResolverStatus';
        status.style.color = 'rgba(255,255,255,0.78)';
        status.style.lineHeight = '1.3';
        panel.appendChild(status);
        viewport.appendChild(panel);
        updateAltFaceUiStatus();
    }

    function scheduleAltFaceUiMount(attempt = 0) {
        if (!SHOW_ALT_FACE_RESOLVER_UI) return;
        ensureAltFaceUi();
        if (!document.getElementById('altFaceResolverPanel') && attempt < 30) {
            setTimeout(() => scheduleAltFaceUiMount(attempt + 1), 150);
        }
    }

    function updateAltFaceUiStatus() {
        const el = document.getElementById('altFaceResolverStatus');
        if (el) {
            const floodCount = state.floodPlanes ? state.floodPlanes.length : 0;
            const reconstructed = state.cells.filter(cell => !cell.usedRasterFallback).length;
            const fallback = state.faces.filter(face => face.usedRasterFallback).length;
            const occluded = state.faces.filter(face => face.isOccluded).length;
            const visible = state.faces.filter(face => !face.isOccluded).length;
            const holes = Array.isArray(state.holeFaces) ? state.holeFaces.length : 0;
            const labelText = altResolverConfig.debugLabelMode === 'angle' ? 'angle' : 'id';
            const filterText = `show visible ${altResolverConfig.debugShowVisibleFaces ? 'on' : 'off'}, occluded ${altResolverConfig.debugShowOccludedFaces ? 'on' : 'off'}, labels ${labelText}`;
            el.textContent = `${STEP_LABELS[state.step - 1]} | candidates ${state.candidates.length}, preview planes ${state.planes.length}, flood planes ${floodCount}, cells ${state.cells.length}, reconstructed ${reconstructed}, faces ${state.faces.length} (${visible} visible/${occluded} occ), holes ${holes}, fallback ${fallback} | ${filterText}`;
        }
        document.querySelectorAll('[data-alt-face-step]').forEach(btn => {
            btn.style.background = Number(btn.dataset.altFaceStep) === state.step ? '#1a73e8' : '#263342';
        });
    }

    function explainAltHoles() {
        buildAltResolverState();
        const holes = state.holeFaces || [];
        if (!holes.length) {
            console.info('[AltFaceResolver] No hole faces in current state.');
            return [];
        }
        const summary = holes.map((face, idx) => {
            const debug = face.holeDebug || {};
            return {
                hole: idx,
                points: debug.pointCount || (face.points || []).length,
                area: msAlt(debug.area || Math.abs(signedAreaAlt(face.points || []))),
                passedEdges: face.holeEdgePassCount,
                parentIndex: debug.parentIndex,
                edgeNeighborIndices: (debug.edgeNeighborIndices || []).join(','),
                modes: (debug.edges || []).map(edge => edge.mode || '?').join(',')
            };
        });
        console.table(summary);
        holes.forEach((face, idx) => {
            const debug = face.holeDebug || {};
            console.groupCollapsed(`[AltFaceResolver] HOLE ${idx}`, face);
            console.log('face', face);
            console.log('holeDebug', debug);
            console.table((debug.edges || []).map(edge => ({
                edge: edge.index,
                mode: edge.mode,
                neighborIndex: edge.neighborIndex,
                dot: edge.planeCompare ? msAlt(edge.planeCompare.dot) : null,
                rawDot: edge.planeCompare ? msAlt(edge.planeCompare.rawDot) : null,
                angleDiff: edge.planeCompare ? msAlt(edge.planeCompare.metricAngleDiffDeg) : null,
                pixelDot: edge.planeCompare ? msAlt(edge.planeCompare.pixelDot) : null,
                dDiff: edge.planeCompare ? msAlt(edge.planeCompare.dDiff) : null,
                sampleDist: edge.sample ? edge.sample.dist : null,
                sampleX: edge.sample ? msAlt(edge.sample.x) : null,
                sampleY: edge.sample ? msAlt(edge.sample.y) : null,
                len: msAlt(edge.len)
            })));
            console.groupEnd();
        });
        return holes.map(face => face.holeDebug || null);
    }

    function getAltResolverRenderFaces(force = false) {
        buildAltResolverState({ force: !!force });
        const allNonHoleFaces = (state.faces || []).filter(face => !face.isHole);
        let visibleFaces = allNonHoleFaces.filter(face => !face.isOccluded);
        if (!visibleFaces.length && allNonHoleFaces.length) {
            console.warn('[AltFaceResolver] Primary render fallback: all non-hole faces were marked occluded, so rendering non-hole faces instead of blanking the model.', {
                nonHoleFaces: allNonHoleFaces.length,
                occluded: allNonHoleFaces.filter(face => face.isOccluded).length
            });
            visibleFaces = allNonHoleFaces;
        }
        const renderedFaces = applyManualAndDeletedFacesAlt(visibleFaces);
        if (!renderedFaces.length && visibleFaces.length) {
            console.warn('[AltFaceResolver] Primary render fallback: deleted/manual filters removed every resolver face, so rendering resolver faces instead of blanking the model.', {
                visibleFaces: visibleFaces.length,
                deletedSignatures: (typeof deletedFaceSignatures !== 'undefined' && deletedFaceSignatures) ? deletedFaceSignatures.size : 0,
                manualFaces: Array.isArray(activeGeometry?.manualFaces) ? activeGeometry.manualFaces.length : 0
            });
            return visibleFaces;
        }
        return renderedFaces;
    }

    function prepareAltResolverRenderFaces(resolvedFaces) {
        return resolvedFaces.map((face) => {
            const slope = calculatePlaneFromVertices(face) || planeToSlopeAlt(face.plane);
            const renderFace = {
                ...face,
                plane: slope,
                holes: face.holes || [],
                layer: parseInt(face.layer || 1, 10)
            };
            const nx = -slope.a, ny = -slope.b, nz = 1;
            const len = Math.hypot(nx, ny, nz);
            renderFace.planeNormal = (len > 1e-9)
                ? { x: nx / len, y: ny / len, z: nz / len }
                : { x: 0, y: 0, z: 1 };
            return renderFace;
        });
    }

    function rebuildAltResolverFacesForMeasurement() {
        const resolvedFaces = getAltResolverRenderFaces(true);
        const renderFaces = prepareAltResolverRenderFaces(resolvedFaces);
        lastResolvedFacesCache = renderFaces;
        if (typeof window !== 'undefined') window.lastResolvedFacesCache = renderFaces;
        return renderFaces;
    }

    function applyManualAndDeletedFacesAlt(autoFaces) {
        const tStart = nowAlt();
        const facesToRender = [];
        const processedSigs = new Set();
        const isDeleted = (sig) => (
            typeof deletedFaceSignatures !== 'undefined' &&
            deletedFaceSignatures &&
            deletedFaceSignatures.has(sig)
        );

        (autoFaces || []).forEach(face => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
            const sig = getLocalFaceSignature(face.points);
            if (isDeleted(sig)) return;
            if (!processedSigs.has(sig)) {
                facesToRender.push(face);
                processedSigs.add(sig);
            }
        });

        if (typeof window.cleanupInvalidManualFaces === 'function') {
            window.cleanupInvalidManualFaces();
        }

        if (activeGeometry && Array.isArray(activeGeometry.manualFaces)) {
            activeGeometry.manualFaces.forEach(mf => {
                if (!mf || !Array.isArray(mf.points) || mf.points.length < 3) return;
                const sig = getLocalFaceSignature(mf.points);
                if (isDeleted(sig)) return;
                if (processedSigs.has(sig)) {
                    const idx = facesToRender.findIndex(face => getLocalFaceSignature(face.points) === sig);
                    if (idx !== -1) facesToRender[idx] = mf;
                } else {
                    facesToRender.push(mf);
                    processedSigs.add(sig);
                }
            });
        }

        state.lastManualDeletedMs = nowAlt() - tStart;
        return facesToRender;
    }

    function renderAltResolverPrimary(fastRender = false, structureScoped = false) {
        if (!structureScoped && typeof window.withStructureModeScope === 'function' && !window.__structureScopeApplying && !window.__structureModeForceAll) {
            return window.withStructureModeScope(() => renderAltResolverPrimary(fastRender, true));
        }
        const __finalPassStart = nowAlt();
        const passTimings = {};
        if (!activeGeometry || !activeGeometry.connections) return;
        const globalOn = (typeof showFacesLayer !== 'undefined') ? showFacesLayer : true;
        if (!globalOn) return;
        let t = nowAlt();
        if (typeof window.deleteFaceRenderings === 'function') window.deleteFaceRenderings();
        passTimings.deleteRenderingsMs = nowAlt() - t;

        t = nowAlt();
        const facesToRender = getAltResolverRenderFaces(fastRender === false);
        const buildTimings = state.lastBuildTimings || {};
        passTimings.manualDeletedMs = state.lastManualDeletedMs || 0;
        passTimings.resolveTotalMs = nowAlt() - t;
        if (!facesToRender.length && state.faces && state.faces.length) {
            console.warn('[AltFaceResolver] Primary renderer has no faces to render after resolver handoff.', {
                resolverFaces: state.faces.length,
                holes: (state.holeFaces || []).length,
                occluded: state.faces.filter(face => face.isOccluded).length,
                nonHole: state.faces.filter(face => !face.isHole).length
            });
        }

        const dataFor2D = [];
        t = nowAlt();
        const renderFaces = prepareAltResolverRenderFaces(facesToRender);
        passTimings.renderFacePrepMs = nowAlt() - t;
        lastResolvedFacesCache = renderFaces;
        if (typeof window !== 'undefined') window.lastResolvedFacesCache = renderFaces;

        t = nowAlt();
        renderFaces.forEach((renderFace, idx) => {
            const slope = renderFace.plane;
            const layerNum = renderFace.layer;
            const mesh = createFaceMesh(renderFace, slope, layerNum, idx, []);
            mesh.visible = globalOn && (layerVisibility[layerNum] !== false);
            const isSel = (typeof selectedFaceSignatures !== 'undefined' && selectedFaceSignatures.has(getLocalFaceSignature(renderFace.points)));
            updateFaceMeshVisuals(mesh, layerNum, idx, isSel);
            if (facesGroup) facesGroup.add(mesh);
            const baseHue = getLayerHue(layerNum);
            dataFor2D.push({
                points: renderFace.points,
                holes: renderFace.holes || [],
                color: `hsl(${baseHue}, 100%, ${48 + (idx * 8) % 12}%)`,
                layer: layerNum
            });
        });
        passTimings.meshMs = nowAlt() - t;

        t = nowAlt();
        if (typeof renderFaces2D === 'function') renderFaces2D(dataFor2D);
        passTimings.renderFaces2DMs = nowAlt() - t;
        if (typeof window.refreshStructureStatusesFromFaces === 'function') window.refreshStructureStatusesFromFaces(renderFaces);
        if (_enh.showPitchLabels) requestAnimationFrame(renderPitchLabels);
        if (typeof window !== 'undefined' && __finalPassStart) {
            const totalMs = nowAlt() - __finalPassStart;
            window.__lastRenderFinalPassMs = totalMs;
            window.__lastRenderFinalPassFaceCount = renderFaces.length;
            recordFinalPassAnalyticsAlt({
                totalMs: msAlt(totalMs),
                totalBuildMs: msAlt(buildTimings.totalBuildMs),
                deleteRenderingsMs: msAlt(passTimings.deleteRenderingsMs),
                resolveTotalMs: msAlt(passTimings.resolveTotalMs),
                calcPointsMs: msAlt(buildTimings.calcPointsMs),
                candidateMs: msAlt(buildTimings.candidateMs),
                planeDedupeMs: msAlt(buildTimings.planeDedupeMs),
                floodPlanePrepMs: msAlt(buildTimings.floodPlanePrepMs),
                floodMs: msAlt(buildTimings.floodMs),
                triangleMs: msAlt(buildTimings.triangleMs),
                cellDedupeMs: msAlt(buildTimings.cellDedupeMs),
                holeMs: msAlt(buildTimings.holeMs),
                occlusionMs: msAlt(buildTimings.occlusionMs),
                uiStatusMs: msAlt(buildTimings.uiStatusMs),
                manualDeletedMs: msAlt(passTimings.manualDeletedMs),
                renderFacePrepMs: msAlt(passTimings.renderFacePrepMs),
                meshMs: msAlt(passTimings.meshMs),
                renderFaces2DMs: msAlt(passTimings.renderFaces2DMs),
                points: activeGeometry?.points?.length || 0,
                connections: activeGeometry?.connections?.length || 0,
                faces: renderFaces.length,
                candidates: state.candidates ? state.candidates.length : 0,
                planes: state.planes ? state.planes.length : 0,
                floodPlanes: state.floodPlanes ? state.floodPlanes.length : 0,
                floodCacheHits: buildTimings.floodCacheHits || 0,
                floodCacheMisses: buildTimings.floodCacheMisses || 0,
                edgeComponents: buildTimings.edgeComponents || 0,
                graphFastPath: buildTimings.graphFastPath || 0,
                rasterComponents: buildTimings.rasterComponents || 0,
                rasterCellsScanned: buildTimings.rasterCellsScanned || 0,
                rasterBudgetUpscaledComponents: buildTimings.rasterBudgetUpscaledComponents || 0,
                edgeSetCacheHits: buildTimings.edgeSetCacheHits || 0,
                edgeSetCacheMisses: buildTimings.edgeSetCacheMisses || 0,
                componentCacheHits: buildTimings.componentCacheHits || 0,
                componentCacheMisses: buildTimings.componentCacheMisses || 0,
                triangleCells: buildTimings.triangleCells || 0,
                cells: state.cells ? state.cells.length : 0,
                holes: state.holeFaces ? state.holeFaces.length : 0,
                occluded: state.faces ? state.faces.filter(face => face.isOccluded).length : 0
            });
        }
    }

    async function profileAltFaceResolver(options = {}) {
        const runs = Math.max(1, Math.min(200, parseInt(options.runs || options.count || 10, 10) || 10));
        const render = !!options.render;
        const force = options.force !== false;
        const quiet = !!options.quiet;
        const waitFrame = options.waitFrame !== false;
        const samples = [];
        for (let i = 0; i < runs; i++) {
            if (render) {
                const beforePasses = window.__finalPassAnalytics ? window.__finalPassAnalytics.totalPasses : 0;
                renderAltResolverPrimary(!force);
                const sample = window.__finalPassAnalytics?.lastSample || {};
                samples.push({
                    ...sample,
                    run: i + 1,
                    analyticsPass: window.__finalPassAnalytics ? window.__finalPassAnalytics.totalPasses : beforePasses
                });
            } else {
                const t0 = nowAlt();
                buildAltResolverState({ force });
                const timings = state.lastBuildTimings || {};
                samples.push({
                    run: i + 1,
                    totalMs: msAlt(nowAlt() - t0),
                    totalBuildMs: msAlt(timings.totalBuildMs),
                    calcPointsMs: msAlt(timings.calcPointsMs),
                    candidateMs: msAlt(timings.candidateMs),
                    planeDedupeMs: msAlt(timings.planeDedupeMs),
                    floodPlanePrepMs: msAlt(timings.floodPlanePrepMs),
                    floodMs: msAlt(timings.floodMs),
                    triangleMs: msAlt(timings.triangleMs),
                    cellDedupeMs: msAlt(timings.cellDedupeMs),
                    holeMs: msAlt(timings.holeMs),
                    occlusionMs: msAlt(timings.occlusionMs),
                    uiStatusMs: msAlt(timings.uiStatusMs),
                    points: activeGeometry?.points?.length || 0,
                    connections: activeGeometry?.connections?.length || 0,
                    candidates: state.candidates ? state.candidates.length : 0,
                    planes: state.planes ? state.planes.length : 0,
                    floodPlanes: state.floodPlanes ? state.floodPlanes.length : 0,
                    floodCacheHits: timings.floodCacheHits || 0,
                    floodCacheMisses: timings.floodCacheMisses || 0,
                    edgeComponents: timings.edgeComponents || 0,
                    graphFastPath: timings.graphFastPath || 0,
                    rasterComponents: timings.rasterComponents || 0,
                    rasterCellsScanned: timings.rasterCellsScanned || 0,
                    rasterBudgetUpscaledComponents: timings.rasterBudgetUpscaledComponents || 0,
                    edgeSetCacheHits: timings.edgeSetCacheHits || 0,
                    edgeSetCacheMisses: timings.edgeSetCacheMisses || 0,
                    componentCacheHits: timings.componentCacheHits || 0,
                    componentCacheMisses: timings.componentCacheMisses || 0,
                    triangleCells: timings.triangleCells || 0,
                    cells: state.cells ? state.cells.length : 0,
                    faces: state.faces ? state.faces.length : 0,
                    holes: state.holeFaces ? state.holeFaces.length : 0,
                    occluded: state.faces ? state.faces.filter(face => face.isOccluded).length : 0
                });
            }
            if (waitFrame && i < runs - 1) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
        const summary = printFaceResolverProfileAlt(samples, { render, force });
        if (!quiet) {
            console.info('[AltFaceResolverProfile] Try cached algorithm timing with altFaceResolver.profile({ runs: 20, force: false, render: false }) or full render timing with altFaceResolver.profile({ runs: 10, render: true }).');
        }
        return summary;
    }

    window.altFaceResolver = {
        rebuild: (options = {}) => buildAltResolverState({ ...(options || {}), force: true }),
        rebuildForMeasurement: rebuildAltResolverFacesForMeasurement,
        renderStep: renderAltStep,
        clear: clearAltFaceDebug,
        clearInspection: clearAltInspectionHighlight,
        getState: () => state,
        getRenderFaces: getAltResolverRenderFaces,
        renderPrimary: renderAltResolverPrimary,
        showUi: ensureAltFaceUi,
        getConfig: () => ({ ...altResolverConfig }),
        explainHoles: explainAltHoles,
        inspectFace: (idx) => {
            if (!(state.faces || []).length) buildAltResolverState();
            return inspectAltDebugFace((state.faces || [])[idx], `F${idx}`);
        },
        inspectHole: (idx) => {
            if (!(state.holeFaces || []).length) buildAltResolverState();
            return inspectAltDebugFace((state.holeFaces || [])[idx], `H${idx}`);
        },
        profile: profileAltFaceResolver,
        getSelectedFace: () => selectedAltDebugFace,
        setConfig: (patch = {}) => { altResolverConfig = { ...altResolverConfig, ...patch }; buildAltResolverState({ force: true }); renderAltStep(state.step); }
    };
    window.profileAltFaceResolver = profileAltFaceResolver;
    window.__inspectAltDebugFaceObject = inspectAltDebugFace;
    window.renderFinalPass = renderAltResolverPrimary;
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => scheduleAltFaceUiMount(), { once: true });
    } else {
        scheduleAltFaceUiMount();
    }
})();
// =========================================================
// §11  FACE MESH CREATION & VISUALS
// =========================================================
function createFaceMesh(face, plane, layerNum, index, errors) {
    const meshPlane = calculatePlaneFromVertices(face);
    if (meshPlane && Number.isFinite(meshPlane.a) && Number.isFinite(meshPlane.b) && Number.isFinite(meshPlane.c)) {
        plane = meshPlane;
        face.plane = meshPlane;
    }
    const shape = new THREE.Shape();
    const startV = getVector3(face.points[0]);
    shape.moveTo(startV.x, -startV.z);
    for (let i = 1; i < face.points.length; i++) { const v = getVector3(face.points[i]); shape.lineTo(v.x, -v.z); }
    if (face.holes) {
        face.holes.forEach(holePts => {
            const hp = new THREE.Path();
            const hs = getVector3(holePts[0]); hp.moveTo(hs.x, -hs.z);
            for (let k = 1; k < holePts.length; k++) { const hv = getVector3(holePts[k]); hp.lineTo(hv.x, -hv.z); }
            shape.holes.push(hp);
        });
    }
    const shapeGeo = new THREE.ShapeGeometry(shape);
    const posAttr = shapeGeo.attributes.position;
    const zScale = getZScale();
    for (let i = 0; i < posAttr.count; i++) {
        const lx = posAttr.getX(i), ly = posAttr.getY(i);
        const imgPt = sceneXZToImagePixel(lx, -ly);
        const imgX = imgPt.ix, imgY = imgPt.iy;
        let geoZ = plane.a*imgX + plane.b*imgY + plane.c;
        if (!Number.isFinite(geoZ)) geoZ = dsmMin;
        geoZ = Math.max(dsmMin, Math.min(dsmMax, geoZ));
        posAttr.setZ(i, (geoZ-dsmMin)*zScale + ELEVATION_OFFSET);
    }
    shapeGeo.computeVertexNormals();
    const m = new THREE.Mesh(shapeGeo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI/2;
    m.userData = {faceDef:face, layer:layerNum, index:index, errors:errors};
    return m;
}
function updateFaceMeshVisuals(mesh, layerNum, idx, isSelected) {
    let color, emissive, opacity;
    const isLocked = mesh.userData.faceDef && isFaceLocked(mesh.userData.faceDef.points);

    if (isSelected) {
        if (isLocked) {
            // Selected + Locked: darker gold
            color = new THREE.Color(0xab7405);
            emissive = new THREE.Color(0x442200);
            opacity = 0.9;
        } else {
            // Selected + Unlocked: bright orange-yellow
            color = new THREE.Color(0xffaa00);
            emissive = new THREE.Color(0x331100);
            opacity = 0.8;
        }
    }
    else if (isLocked) {
        const baseHue = getLayerHue(layerNum);
        color = new THREE.Color(`hsl(${baseHue}, 80%, ${30+(idx*8)%10}%)`);
        emissive = new THREE.Color(`hsl(${baseHue}, 60%, 15%)`);
        opacity = 0.6;
    }
    else {
        const baseHue = getLayerHue(layerNum);
        color = new THREE.Color(`hsl(${baseHue}, 100%, ${48+(idx*8)%12}%)`);
        emissive = new THREE.Color(`hsl(${baseHue}, 100%, 25%)`);
        opacity = 0.35;
        if (mesh.userData.isManual) {
            emissive = new THREE.Color(`hsl(${baseHue}, 100%, 30%)`);
            opacity = 0.45;
        }
    }

    if (mesh.material) {
        mesh.material.color = color;
        mesh.material.opacity = opacity;
        mesh.material.emissive = emissive;
        mesh.material.transparent = true;
    }
}
function updateFaceSelectionVisualsOnly3D() {
    if (!facesGroup || !facesGroup.children) return;
    const globalOn = (typeof showFacesLayer !== 'undefined') ? showFacesLayer : true;
    facesGroup.children.forEach(m => {
        if (!m || !m.userData) return;
        const face = m.userData.faceDef; if (!face) return;
        const layer = parseInt(face.layer||m.userData.layer||1,10);
        const idx = (m.userData.index!=null)?m.userData.index:0;
        m.visible = globalOn && (layerVisibility[layer]!==false);
        const sig = getLocalFaceSignature(face.points);
        if (sig && layerVisibility[layer] === false && typeof selectedFaceSignatures !== 'undefined') {
            selectedFaceSignatures.delete(sig);
        }
        const isSel = (sig && typeof selectedFaceSignatures !== 'undefined') ? selectedFaceSignatures.has(sig) : false;
        updateFaceMeshVisuals(m, layer, idx, isSel);
        m.visible = globalOn && (layerVisibility[layer]!==false);
    });
}
// =========================================================
// §12  POLYGON / POINT-IN-POLY HELPERS
// =========================================================
function getCanonicalSignature(calcPoints) {
    return Array.from(new Set(calcPoints.map(p => p.id))).sort((a,b) => a-b).join('|');
}
function getLocalFaceSignature(points) {
    return points.map(p => `${Math.round(p.x*10)},${Math.round(p.y*10)}`).sort().join('|');
}

// ─── Facet Locking Helpers (multi-plane, point-based) ────
// Each point stores pt._lockedPlanes = [{a, b, c}, ...] (array of plane equations).
// A face is "locked" when ALL its points carry at least one plane matching the face.
// Shared edge points can belong to multiple locked faces without conflict.

let _faceLockIdCounter = 0;

function isPointFacetLocked(pt) {
    return !!(pt && pt._lockedPlanes && pt._lockedPlanes.length > 0);
}

function _planeKey(plane) {
    return plane.a.toFixed(8) + '|' + plane.b.toFixed(8) + '|' + plane.c.toFixed(8);
}

function _hasPlaneLike(pt, plane) {
    if (!pt._lockedPlanes) return false;
    const key = _planeKey(plane);
    return pt._lockedPlanes.some(p => _planeKey(p) === key);
}

function isFaceLocked(facePoints) {
    if (!facePoints || facePoints.length === 0) return false;
    // A face is locked if ALL points have at least one locked plane AND they share a common plane.
    if (!facePoints.every(pt => pt._lockedPlanes && pt._lockedPlanes.length > 0)) return false;
    // Check that there's at least one plane common to all points
    const firstPlanes = facePoints[0]._lockedPlanes;
    return firstPlanes.some(plane => {
        const key = _planeKey(plane);
        return facePoints.every(pt => pt._lockedPlanes.some(p => _planeKey(p) === key));
    });
}

function isPointMultiLocked(pt) {
    return !!(pt && pt._lockedPlanes && pt._lockedPlanes.length > 1);
}

function adjustPointZToLockedPlane(pt) {
    if (!pt || !pt._lockedPlanes || pt._lockedPlanes.length === 0) return;
    // Single plane: project Z onto the plane at current x,y
    const plane = pt._lockedPlanes[0];
    pt.z = plane.a * pt.x + plane.b * pt.y + plane.c;
    pt.zLocked = true;
}

function toggleFaceLock(facePoints, plane) {
    if (!facePoints || facePoints.length === 0 || !plane) return;
    const locked = isFaceLockedToPlane(facePoints, plane);
    if (locked) {
        // Unlock: remove this specific plane from each point
        const key = _planeKey(plane);
        facePoints.forEach(pt => {
            if (pt._lockedPlanes) {
                pt._lockedPlanes = pt._lockedPlanes.filter(p => _planeKey(p) !== key);
                if (pt._lockedPlanes.length === 0) delete pt._lockedPlanes;
            }
        });
    } else {
        // Lock: add this plane to each point
        facePoints.forEach(pt => {
            if (!pt._lockedPlanes) pt._lockedPlanes = [];
            // Don't add duplicate
            const key = _planeKey(plane);
            if (!pt._lockedPlanes.some(p => _planeKey(p) === key)) {
                pt._lockedPlanes.push({ a: plane.a, b: plane.b, c: plane.c });
            }
        });
    }
    // Immediately update face mesh visuals (locked gray tint) and pitch labels
    if (typeof updateFaceSelectionVisualsOnly3D === 'function') updateFaceSelectionVisualsOnly3D();
    if (typeof renderPitchLabels === 'function') renderPitchLabels();
}

function isFaceLockedToPlane(facePoints, plane) {
    if (!facePoints || facePoints.length === 0) return false;
    const key = _planeKey(plane);
    return facePoints.every(pt => pt._lockedPlanes && pt._lockedPlanes.some(p => _planeKey(p) === key));
}

window.toggleSelectedFaceLocks = function () {
    if (typeof selectedFaceSignatures === 'undefined' || selectedFaceSignatures.size === 0) return;
    if (typeof facesGroup === 'undefined' || !facesGroup) return;
    if (typeof save2DState === 'function') save2DState();
    facesGroup.children.forEach(m => {
        if (!m.userData || !m.userData.faceDef) return;
        const face = m.userData.faceDef;
        if (!face.points || face.points.length < 3) return;
        const sig = getLocalFaceSignature(face.points);
        if (!selectedFaceSignatures.has(sig)) return;
        const plane = face.plane || (typeof calculatePlaneFromVertices === 'function' ? calculatePlaneFromVertices(face.points) : null);
        if (plane) toggleFaceLock(face.points, plane);
    });
};

// Expose for external use (interaction_2d.js)
window.toggleFaceLock = toggleFaceLock;
window.isPointFacetLocked = isPointFacetLocked;
window.isPointMultiLocked = isPointMultiLocked;
window.adjustPointZToLockedPlane = adjustPointZToLockedPlane;
// ─────────────────────────────────────────────────────────

/** Strict polygon-inside check: bounding box + every point of A inside B. */
function isPolygonInsideStrict(polyA, polyB) {
    let minAx=Infinity,maxAx=-Infinity,minAy=Infinity,maxAy=-Infinity;
    let minBx=Infinity,maxBx=-Infinity,minBy=Infinity,maxBy=-Infinity;
    for(let p of polyA){minAx=Math.min(minAx,p.x);maxAx=Math.max(maxAx,p.x);minAy=Math.min(minAy,p.y);maxAy=Math.max(maxAy,p.y);}
    for(let p of polyB){minBx=Math.min(minBx,p.x);maxBx=Math.max(maxBx,p.x);minBy=Math.min(minBy,p.y);maxBy=Math.max(maxBy,p.y);}
    if(minAx<minBx||maxAx>maxBx||minAy<minBy||maxAy>maxBy) return false;
    for(let p of polyA){if(!isPointInPoly(p.x,p.y,polyB)) return false;}
    return true;
}
/** Centroid-based polygon-inside check (matches v1 active behavior). Used by hole-cutting. */
function isPolygonInside(inner, outer) {
    let cx=0,cy=0;
    for(let p of inner){cx+=p.x;cy+=p.y;}
    cx/=inner.length; cy/=inner.length;
    return isPointInPoly(cx,cy,outer);
}
function isPointInPoly(x, y, poly) {
    let inside = false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
        const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
        if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
}
function isPointInPolyStrict(pt, poly) {
    let inside = false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
        const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
        const onEdge = (pt.y===yi&&pt.y===yj&&pt.x>=Math.min(xi,xj)&&pt.x<=Math.max(xi,xj)) ||
            (Math.abs((yj-yi)*pt.x-(xj-xi)*pt.y+xj*yi-yj*xi)<0.001);
        if(onEdge) return false;
        if(((yi>pt.y)!==(yj>pt.y))&&(pt.x<(xj-xi)*(pt.y-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
}

function sharesBoundary(candidate, keeper) {
    // 1. Check if they share any edge in their edgeSet (exact ID match)
    if (candidate.edgeSet && keeper.edgeSet) {
        for (let e of candidate.edgeSet) {
            if (keeper.edgeSet.has(e)) {
                return true;
            }
        }
    }

    // 2. Check if they share any vertex object
    if (candidate.points && keeper.points) {
        const keeperPoints = new Set(keeper.points);
        for (let p of candidate.points) {
            if (keeperPoints.has(p)) {
                return true;
            }
        }
    }

    const cPoints = candidate.calcPoints || [];
    const kPoints = keeper.calcPoints || [];
    if (cPoints.length < 3 || kPoints.length < 3) return false;

    // 3. Check if they share any vertex by coordinate proximity in 2D (1.0 pixel threshold)
    for (let cp of cPoints) {
        for (let kp of kPoints) {
            if (Math.hypot(cp.x - kp.x, cp.y - kp.y) < 1.0) {
                return true;
            }
        }
    }

    // 4. Check for overlapping 2D segments (collinear and overlapping)
    for (let i = 0; i < cPoints.length; i++) {
        const c1 = cPoints[i];
        const c2 = cPoints[(i + 1) % cPoints.length];
        for (let j = 0; j < kPoints.length; j++) {
            const k1 = kPoints[j];
            const k2 = kPoints[(j + 1) % kPoints.length];
            if (segmentsOverlap(c1, c2, k1, k2)) {
                return true;
            }
        }
    }

    return false;
}

function segmentsOverlap(p1, p2, q1, q2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return false;
    const len = Math.sqrt(lenSq);

    // Perpendicular distance from q1 and q2 to the line p1-p2
    const dist1 = Math.abs(dx * (q1.y - p1.y) - dy * (q1.x - p1.x)) / len;
    const dist2 = Math.abs(dx * (q2.y - p1.y) - dy * (q2.x - p1.x)) / len;

    const tol = 1.5; // pixel tolerance
    if (dist1 > tol || dist2 > tol) return false;

    // Project q1 and q2 onto p1-p2
    const u1 = ((q1.x - p1.x) * dx + (q1.y - p1.y) * dy) / len;
    const u2 = ((q2.x - p1.x) * dx + (q2.y - p1.y) * dy) / len;

    const minQ = Math.min(u1, u2);
    const maxQ = Math.max(u1, u2);

    const overlapStart = Math.max(0, minQ);
    const overlapEnd = Math.min(len, maxQ);

    // Must overlap by at least 1.0 pixels
    return (overlapEnd - overlapStart) > 1.0;
}
// =========================================================
// §12b  RESTORED UTILITY FUNCTIONS (from v1)
// =========================================================
function getEdgesFromFace(faceDef) {
    const pts = faceDef.points, edges = [];
    for(let i=0;i<pts.length;i++){ edges.push({p1:pts[i],p2:pts[(i+1)%pts.length]}); }
    return edges;
}
function areEdgesSame(e1, e2) {
    return (e1.p1===e2.p1&&e1.p2===e2.p2)||(e1.p1===e2.p2&&e1.p2===e2.p1);
}
function getEdgeAngleDegrees(edge) {
    const dx=edge.p2.x-edge.p1.x, dy=edge.p2.y-edge.p1.y;
    let rad=Math.atan2(dy,dx); if(rad<0) rad+=Math.PI;
    return rad*(180/Math.PI);
}
function getMaxVertexDeviation(points) {
    const validPts = points.filter(p => p.z!==null&&p.z!==undefined);
    if(validPts.length<4) return 0;
    const plane = fitPlaneLinear(validPts);
    let maxDev = 0;
    validPts.forEach(p => { maxDev = Math.max(maxDev, Math.abs(plane.a*p.x+plane.b*p.y-p.z+plane.c)/Math.sqrt(plane.a*plane.a+plane.b*plane.b+1)); });
    return maxDev;
}
function checkMeshIntersection(meshA, meshB) {
    const boxA = new THREE.Box3().setFromObject(meshA);
    const boxB = new THREE.Box3().setFromObject(meshB);
    if(!boxA.intersectsBox(boxB)) return false;
    const countA = meshA.userData.faceDef.points.length;
    const getVec = (geom,i) => new THREE.Vector3(geom.getX(i),geom.getY(i),geom.getZ(i));
    for(let i=0;i<countA;i++){
        const start = getVec(meshA.geometry.attributes.position,i);
        const end = getVec(meshA.geometry.attributes.position,(i+1)%countA);
        const dir = new THREE.Vector3().subVectors(end,start);
        const len = dir.length(); dir.normalize();
        const rc = new THREE.Raycaster(start,dir,0,len);
        const intersects = rc.intersectObject(meshB);
        for(let hit of intersects){ if(hit.distance>0.05&&hit.distance<len-0.05) return true; }
    }
    return false;
}
function findScorePeaks(scores) {
    const peaks=[], n=scores.length, win=PLANE_CFG.PEAK_WINDOW;
    for(let i=0;i<n;i++){
        const currentScore=scores[i].score; let isPeak=true;
        for(let j=1;j<=win;j++){
            const prevIdx=(i-j+n)%n, nextIdx=(i+j)%n;
            if(scores[prevIdx].score>currentScore||scores[nextIdx].score>currentScore){isPeak=false;break;}
        }
        if(isPeak) peaks.push(scores[i]);
    }
    return peaks;
}
// =========================================================
// §13  PLANE SWEEP HELPERS
// =========================================================
function getRotationBasis(line) {
    const p1=line.start,p2=line.end;
    const axis={x:p2.x-p1.x,y:p2.y-p1.y,z:p2.z-p1.z};
    const len=Math.sqrt(axis.x**2+axis.y**2+axis.z**2);
    if(len<0.001) return null;
    axis.x/=len;axis.y/=len;axis.z/=len;
    let arb=(Math.abs(axis.z)<0.9)?{x:0,y:0,z:1}:{x:1,y:0,z:0};
    const v1=crossProduct(axis,arb); normalizeVector(v1);
    const v2=crossProduct(axis,v1);
    return {v1,v2,axis};
}
function isPointOnPlaneVariableTol(origin, normal, p) {
    const distToPlane=Math.abs(normal.x*(p.x-origin.x)+normal.y*(p.y-origin.y)+normal.z*(p.z-origin.z));
    const distToOrigin=Math.sqrt((p.x-origin.x)**2+(p.y-origin.y)**2+(p.z-origin.z)**2);
    return distToPlane < PLANE_CFG.BASE_TOLERANCE + (distToOrigin*PLANE_CFG.DIST_FACTOR);
}
function countPointsOnPlaneVariableTol(origin, normal, points) {
    let count=0; for(let i=0;i<points.length;i++){if(isPointOnPlaneVariableTol(origin,normal,points[i]))count++;} return count;
}
function calculateRotatedNormal(v1, v2, angle) {
    const c=Math.cos(angle),s=Math.sin(angle);
    return {x:c*v1.x+s*v2.x, y:c*v1.y+s*v2.y, z:c*v1.z+s*v2.z};
}
function crossProduct(a,b) { return {x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x}; }
function dotProduct(a,b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
function areLoopPlanesCoplanar(faceA, faceB, tolerance = 1.5) {
    if (!faceA || !faceB || !faceA.planeNormal || !faceB.planeNormal) return false;
    const dot = dotProduct(faceA.planeNormal, faceB.planeNormal);
    if (Math.abs(dot) <= 0.9) return false;
    const planeDiff = dot >= 0
        ? Math.abs(faceA.planeD - faceB.planeD)
        : Math.abs(faceA.planeD + faceB.planeD);
    return planeDiff < tolerance;
}
function normalizeVector(v) { const len=Math.sqrt(v.x**2+v.y**2+v.z**2); if(len>0){v.x/=len;v.y/=len;v.z/=len;} }
function getLayerHue(layerNum) { return {1:120,2:30,3:210,4:180,5:280,6:330}[layerNum]||0; }
// =========================================================
// §14  NEIGHBOR-CONSTRAINED PLANE FINDER
// =========================================================
function findPlanePeaksFromNeighbors(line, basis, calcPoints, calcPointAdj) {
    const {v1,v2}=basis; const origin=line.start;
    const radStep=PLANE_CFG.ANGLE_STEP_DEG*(Math.PI/180);
    const neighbors=new Set();
    const sA=calcPointAdj.get(line.start),eA=calcPointAdj.get(line.end);
    if(sA) for(let i=0;i<sA.length;i++){if(sA[i]!==line.end) neighbors.add(sA[i]);}
    if(eA) for(let i=0;i<eA.length;i++){if(eA[i]!==line.start) neighbors.add(eA[i]);}
    const peaks=[],seenBins=new Set();
    for(const neighbor of neighbors){
        const dx=neighbor.x-origin.x,dy=neighbor.y-origin.y,dz=neighbor.z-origin.z;
        const A=v1.x*dx+v1.y*dy+v1.z*dz, B=v2.x*dx+v2.y*dy+v2.z*dz;
        if(Math.sqrt(A*A+B*B)<1e-9) continue;
        const theta=Math.atan2(-A,B);
        for(let k=0;k<2;k++){
            let t=theta+k*Math.PI; t=((t%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
            const bin=Math.round(t/radStep);
            if(seenBins.has(bin)) continue; seenBins.add(bin);
            const normal=calculateRotatedNormal(v1,v2,t);
            const score=countPointsOnPlaneVariableTol(origin,normal,calcPoints);
            if(score>=PLANE_CFG.MIN_POINTS_ON_FACE) peaks.push({angle:t,score,normal});
        }
    }
    return peaks;
}
// =========================================================
// §15  LOOP TRACING (DFS with backtracking)
// =========================================================
function traceClosedLoopOnPlane(seedLine, planePoints, allLines, planeNormal) {
    const planePointSet=new Set(planePoints);
    const validEdges=allLines.filter(l=>planePointSet.has(l.start)&&planePointSet.has(l.end));
    const adj=new Map();
    validEdges.forEach(l=>{if(!adj.has(l.start))adj.set(l.start,[]);if(!adj.has(l.end))adj.set(l.end,[]);adj.get(l.start).push(l.end);adj.get(l.end).push(l.start);});
    const axisZ=planeNormal;
    let arb=(Math.abs(axisZ.z)<0.9)?{x:0,y:0,z:1}:{x:1,y:0,z:0};
    const axisX=crossProduct(arb,axisZ);normalizeVector(axisX);
    const axisY=crossProduct(axisZ,axisX);
    const getAngle=(origin,target)=>{
        const dx=target.x-origin.x,dy=target.y-origin.y,dz=target.z-origin.z;
        return Math.atan2(dx*axisY.x+dy*axisY.y+dz*axisY.z, dx*axisX.x+dy*axisX.y+dz*axisX.z);
    };
    const MAX_DEPTH=40;
    function solve(curr,prev,path,visited){
        if(curr===seedLine.start&&path.length>2) return path;
        if(path.length>MAX_DEPTH) return null;
        const neighbors=adj.get(curr); if(!neighbors||neighbors.length===0) return null;
        const angleIn=getAngle(prev,curr);
        const reverseAngle=Math.atan2(Math.sin(angleIn+Math.PI),Math.cos(angleIn+Math.PI));
        const candidates=neighbors.map(next=>{
            if(next===prev&&neighbors.length>1) return null;
            if(visited.has(next)&&next!==seedLine.start) return null;
            let diff=getAngle(curr,next)-reverseAngle; if(diff<0) diff+=Math.PI*2;
            return {pt:next,score:diff};
        }).filter(n=>n!==null);
        candidates.sort((a,b)=>a.score-b.score);
        for(let cand of candidates){
            visited.add(cand.pt);
            const res=solve(cand.pt,curr,[...path,cand.pt],visited);
            if(res) return res;
            visited.delete(cand.pt);
        }
        return null;
    }
    return solve(seedLine.end,seedLine.start,[seedLine.start,seedLine.end],new Set([seedLine.end]));
}
// =========================================================
// §16  CANDIDATE BUILDER & BOTTOM-FACE CULLER
// =========================================================
function buildCandidateFromLoop(origPoints, origToCalc) {
    const cps=origPoints.map(p=>origToCalc.get(p)).filter(Boolean);
    if(cps.length<3) return null;
    const layerCounts={};
    origPoints.forEach(p=>{const l=p.layer||1;layerCounts[l]=(layerCounts[l]||0)+1;});
    const layerNum=parseInt(Object.keys(layerCounts).reduce((a,b)=>layerCounts[a]>layerCounts[b]?a:b));
    const edgeSet=new Set();
    for(let i=0;i<cps.length;i++){const p1=cps[i],p2=cps[(i+1)%cps.length];edgeSet.add(`${Math.min(p1.id,p2.id)}-${Math.max(p1.id,p2.id)}`);}
    let area=0;
    for(let i=0;i<cps.length;i++){const p1=cps[i],p2=cps[(i+1)%cps.length];area+=(p1.x*p2.y-p2.x*p1.y);}
    area=Math.abs(area*0.5);
    const a=cps[0],b=cps[1],c=cps[2];
    const e1={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}, e2={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
    const normal=crossProduct(e1,e2); normalizeVector(normal);
    return {points:origPoints,calcPoints:cps,holes:[],layer:layerNum,edgeSet,area,planeNormal:normal,planeD:normal.x*a.x+normal.y*a.y+normal.z*a.z};
}
function cullOccludedBottomFaces(faces) {
    if(faces.length<2) return faces;
    faces.forEach(face=>{
        const pts=face.calcPoints||face.points||[];
        let sumZ=0,n=0; pts.forEach(p=>{sumZ+=((p.z!==null&&p.z!==undefined)?p.z:0);n++;});
        face._cullAvgZ=n>0?sumZ/n:0;
    });
    const MIN_Z_GAP=0.3,COVERAGE=0.80,STEPS=20,MAX_ITER=1000;
    const toRemove=new Set();
    for(let i=0;i<faces.length;i++){
        const cand=faces[i]; if(toRemove.has(cand)) continue;
        const cPts=cand.calcPoints||cand.points; if(!cPts||cPts.length<3) continue;
        const aboveFaces=faces.filter((f,j)=>j!==i&&!toRemove.has(f)&&(f._cullAvgZ||0)>(cand._cullAvgZ||0)+MIN_Z_GAP);
        if(aboveFaces.length===0) continue;
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        cPts.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
        const stepX=Math.max((maxX-minX)/STEPS,1.0),stepY=Math.max((maxY-minY)/STEPS,1.0);
        let totalInside=0,coveredCount=0,safeY=0;
        for(let sy=minY+stepY*0.5;sy<=maxY&&safeY<MAX_ITER;sy+=stepY,safeY++){
            let safeX=0;
            for(let sx=minX+stepX*0.5;sx<=maxX&&safeX<MAX_ITER;sx+=stepX,safeX++){
                if(!isPointInPoly(sx,sy,cPts)) continue;
                totalInside++;
                for(let k=0;k<aboveFaces.length;k++){
                    if(isPointInPoly(sx,sy,aboveFaces[k].calcPoints||aboveFaces[k].points)){coveredCount++;break;}
                }
            }
        }
        if(totalInside>0&&coveredCount/totalInside>=COVERAGE) toRemove.add(cand);
    }
    return faces.filter(f=>!toRemove.has(f));
}
// =========================================================
// §17  ANIMATION LOOP (unified)
// =========================================================
function _animate3D() {
    if(!window.enable3D) return;
    requestAnimationFrame(_animate3D);
    if(typeof controls!=='undefined'&&controls) controls.update();
    if(_geomDirty3D){const now=performance.now();if(now-_lastGeomRebuild>GEOM_REBUILD_INTERVAL_MS){_geomDirty3D=false;_lastGeomRebuild=now;renderGeometry3D();}}
    if(typeof renderer!=='undefined'&&renderer&&typeof scene!=='undefined'&&scene&&typeof camera!=='undefined'&&camera) renderer.render(scene,camera);
    _updateAxisWidget();
}
// =========================================================
// §18  CROP, TEXTURE, IMAGE TOGGLE
// =========================================================
function isHeightMeshContextCurrent() {
    if (!mesh || !geometry || !geometry.attributes || !geometry.attributes.position) return false;
    const expectedVertices = Number(imageWidth) * Number(imageHeight);
    const positionCount = geometry.attributes.position.count;
    const planeSize = getScenePlaneSize();
    return Number.isFinite(expectedVertices)
        && expectedVertices > 0
        && positionCount === expectedVertices
        && Number(mesh.userData && mesh.userData.imageWidth) === Number(imageWidth)
        && Number(mesh.userData && mesh.userData.imageHeight) === Number(imageHeight)
        && Math.abs(Number(mesh.userData && mesh.userData.sceneWidth) - planeSize.width) < 1e-6
        && Math.abs(Number(mesh.userData && mesh.userData.sceneHeight) - planeSize.height) < 1e-6;
}

function update3DCrop() {
    if(!mesh||!geometry||!layerData.dsm) return;
    if (!isHeightMeshContextCurrent()) {
        if (typeof init3D === 'function') init3D();
        return;
    }
    const cropPercent=parseInt((document.getElementById('cropRange')||{}).value||'0');
    const cropRatio=cropPercent/100;
    const positions=geometry.attributes.position.array;
    const dsm=layerData.dsm[0];
    const w=imageWidth,h=imageHeight;
    const centerX=w/2,centerY=h/2;
    const maxDistX=centerX*(1-cropRatio),maxDistY=centerY*(1-cropRatio);
    const zScale=getZScale();
    for(let i=0,j=0;i<positions.length;i+=3,j++){
        const x=j%w,y=Math.floor(j/w);
        if(Math.abs(x-centerX)>maxDistX||Math.abs(y-centerY)>maxDistY||isMaskedPixel(x,y)){positions[i+2]=0;}
        else{const val=dsm[j]; positions[i+2]=(val>-9000)?(val-dsmMin)*zScale:0;}
    }
    geometry.attributes.position.needsUpdate=true; geometry.computeVertexNormals();
}
function update3DTextureForView() {
    if(!mesh) return;
    const srcCanvas=getCurrent3DImageCanvas();
    if(!srcCanvas) return;
    mesh.material.map=new THREE.CanvasTexture(srcCanvas);
    mesh.material.needsUpdate=true;
}
window.toggle3DSurfaceMode = async function(forceMode=null) {
    const targetMode = forceMode || (googleTileState.mode === 'tiles' ? 'height' : 'tiles');
    if (targetMode === 'tiles' && isGoogleTileSurfacePreparing()) {
        update3DSurfaceButtons();
        return;
    }
    if (targetMode === googleTileState.mode && !(targetMode === 'tiles' && !googleTileState.ready)) {
        googleTileState.pendingMode = null;
        apply3DSurfaceVisibility();
        update3DSurfaceButtons();
        return;
    }
    if (targetMode === 'tiles') {
        googleTileState.pendingMode = 'tiles';
        update3DSurfaceButtons();
        try {
            const loaded = (googleTileState.loading && googleTileState.loadPromise)
                ? await googleTileState.loadPromise
                : await ensureGoogleTileSurfaceLoaded({ allowGenerate: true });
            if (loaded !== false && googleTileState.ready && !googleTileState.autoYOffsetReady) {
                const autoYOffsetPromise = googleTileState.autoYOffsetPromise || scheduleGoogleTileAutoYOffsetSolve();
                if (autoYOffsetPromise) {
                    await autoYOffsetPromise;
                }
            }
            googleTileState.mode = (loaded === false || !googleTileState.ready) ? 'height' : 'tiles';
        } catch (error) {
            console.warn('[3D Tiles]', error);
            googleTileState.mode = 'height';
        } finally {
            googleTileState.pendingMode = null;
        }
    } else {
        googleTileState.pendingMode = null;
        googleTileState.mode = 'height';
    }
    apply3DSurfaceVisibility();
    update3DSurfaceButtons();
};
window.toggle3DImage = function(forceState=null) {
    googleTileState.surfaceVisible = (forceState!==null) ? !!forceState : !googleTileState.surfaceVisible;
    apply3DSurfaceVisibility();
    update3DSurfaceButtons();
};
// =========================================================
// §19  PROJECTION TOGGLE (Iso / Tri)
// =========================================================
window.toggleProjection = function() {
    if(typeof scene==='undefined'||!scene||typeof camera==='undefined'||!camera) return;
    _enh.isOrthographic=!_enh.isOrthographic;
    if(_enh.isOrthographic){
        const container=document.getElementById('three-container');
        const aspect=container?container.clientWidth/container.clientHeight:1.5;
        const dist=camera.position.length();
        const halfH=dist*Math.tan((camera.fov*Math.PI/180)/2);
        const oc=new THREE.OrthographicCamera(-halfH*aspect,halfH*aspect,halfH,-halfH,0.01,2000);
        oc.position.copy(camera.position);oc.quaternion.copy(camera.quaternion);oc.zoom=1;oc.updateProjectionMatrix();
        if(controls){controls.object=oc;controls.update();} camera=oc; _enh.orthoCam=oc;
    } else {
        const pc=new THREE.PerspectiveCamera(45,1,0.01,2000);
        const container=document.getElementById('three-container');
        if(container) pc.aspect=container.clientWidth/container.clientHeight;
        pc.position.copy(camera.position);pc.quaternion.copy(camera.quaternion);pc.updateProjectionMatrix();
        if(controls){controls.object=pc;controls.update();} camera=pc;
    }
    const track=document.getElementById('projectionToggle');
    if(track) track.setAttribute('data-state',_enh.isOrthographic?'right':'left');
};
// =========================================================
// §20  CAMERA PRESETS
// =========================================================
function getGeometryCenter3D() {
    if(!activeGeometry||!activeGeometry.points) return null;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity,count=0;
    activeGeometry.points.forEach(pt=>{
        const v=getVector3(pt);
        minX=Math.min(minX,v.x);maxX=Math.max(maxX,v.x);
        minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);
        minZ=Math.min(minZ,v.z);maxZ=Math.max(maxZ,v.z);count++;
    });
    return count===0?null:new THREE.Vector3((minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2);
}
function getGeometryBounds3D() {
    if (!activeGeometry || !Array.isArray(activeGeometry.points) || !activeGeometry.points.length) return null;
    const box = new THREE.Box3();
    let hasPoint = false;
    activeGeometry.points.forEach(pt => {
        const v = getVector3(pt);
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;
        box.expandByPoint(v);
        hasPoint = true;
    });
    if (!hasPoint || box.isEmpty()) return null;
    return { box, sphere: box.getBoundingSphere(new THREE.Sphere()) };
}
function fitCameraToActiveGeometry(options = {}) {
    if (typeof THREE === 'undefined' || typeof camera === 'undefined' || !camera || typeof controls === 'undefined' || !controls) return false;
    const bounds = getGeometryBounds3D();
    if (!bounds || !bounds.sphere || !Number.isFinite(bounds.sphere.radius)) return false;

    const { sphere } = bounds;
    const padding = Number.isFinite(options.padding) ? options.padding : 1.04;
    const radius = Math.max(sphere.radius, 4);
    const container = document.getElementById('three-container');
    const aspect = container && container.clientHeight > 0
        ? (container.clientWidth / container.clientHeight)
        : (camera.aspect || 1.5);

    let direction = camera.position.clone().sub(controls.target || new THREE.Vector3());
    if (direction.lengthSq() < 1e-6) {
        direction = new THREE.Vector3(0, 0.62, 0.78);
    }
    direction.normalize();

    if (camera.isOrthographicCamera) {
        const halfV = radius * padding;
        const halfH = halfV * aspect;
        camera.left = -halfH;
        camera.right = halfH;
        camera.top = halfV;
        camera.bottom = -halfV;
        camera.near = 0.01;
        camera.far = Math.max(2000, radius * 20);
        camera.position.copy(sphere.center.clone().add(direction.multiplyScalar(Math.max(radius * 2.5, 40))));
        controls.target.copy(sphere.center);
        camera.updateProjectionMatrix();
        controls.update();
        return true;
    }

    const verticalFov = THREE.MathUtils.degToRad(camera.fov || 45);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(aspect, 1e-3));
    const limitingFov = Math.min(verticalFov, horizontalFov);
    const distance = Math.max((radius * padding) / Math.tan(limitingFov / 2), radius + 10);

    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center.clone().add(direction.multiplyScalar(distance)));
    camera.near = Math.max(0.01, distance - radius * 4);
    camera.far = Math.max(distance + radius * 6, 2000);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
    return true;
}
let queuedGeometryFitFrame = 0;
window.queueFit3DViewToActiveGeometry = function(options = {}) {
    if (queuedGeometryFitFrame) return;
    queuedGeometryFitFrame = requestAnimationFrame(() => {
        queuedGeometryFitFrame = 0;
        fitCameraToActiveGeometry(options);
    });
};
window.fit3DViewToActiveGeometry = fitCameraToActiveGeometry;
function setCameraPresetView(label) {
    if(typeof camera==='undefined'||!camera||typeof controls==='undefined'||!controls) return;
    const bounds = getGeometryBounds3D();
    const geoCenter = bounds ? bounds.sphere.center.clone() : getGeometryCenter3D();
    const target=geoCenter||controls.target.clone();
    let dist=camera.position.distanceTo(controls.target);
    if(bounds && bounds.sphere && Number.isFinite(bounds.sphere.radius)){
        const radius = Math.max(bounds.sphere.radius, 4);
        const aspect = camera.aspect || 1.5;
        if (camera.isPerspectiveCamera) {
            const verticalFov = THREE.MathUtils.degToRad(camera.fov || 45);
            const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(aspect, 1e-3));
            const limitingFov = Math.min(verticalFov, horizontalFov);
            dist = Math.max((radius * 1.04) / Math.tan(limitingFov / 2), radius + 10);
        } else {
            dist = Math.max(radius * 2.5, 40);
        }
    }
    if(dist<1)dist=80;
    const rot=(typeof viewRotation!=='undefined')?viewRotation:0;
    const cosR=Math.cos(rot),sinR=Math.sin(rot);
    let rawOffset;
    switch(label){
        case'Y':rawOffset=new THREE.Vector3(0,dist,0.001);break;
        case'-Y':rawOffset=new THREE.Vector3(0,-dist,0.001);break;
        case'X':rawOffset=new THREE.Vector3(dist,0,0);break;
        case'-X':rawOffset=new THREE.Vector3(-dist,0,0);break;
        case'Z':rawOffset=new THREE.Vector3(0,0,dist);break;
        case'-Z':rawOffset=new THREE.Vector3(0,0,-dist);break;
        default:return;
    }
    if(label!=='Y'&&label!=='-Y'&&Math.abs(rot)>0.001){
        const rx=rawOffset.x*cosR-rawOffset.z*sinR, rz=rawOffset.x*sinR+rawOffset.z*cosR;
        rawOffset.x=rx;rawOffset.z=rz;
    }
    const startPos=camera.position.clone(),startTarget=controls.target.clone();
    const endPos=target.clone().add(rawOffset),endTarget=target.clone();
    const startTime=performance.now(),duration=350;
    (function animateView(){
        const t=Math.min(1,(performance.now()-startTime)/duration);
        const ease=1-Math.pow(1-t,3);
        camera.position.lerpVectors(startPos,endPos,ease);
        controls.target.lerpVectors(startTarget,endTarget,ease);
        camera.lookAt(controls.target); controls.update();
        if(t<1) requestAnimationFrame(animateView);
    })();
}
window.setCameraPresetView = setCameraPresetView;
// =========================================================
// §21  PITCH LABELS
// =========================================================
window.togglePitchLabels = function(){
    _enh.showPitchLabels=!_enh.showPitchLabels;
    const btn=document.getElementById('btnTogglePitch');
    if(btn) btn.classList.toggle('active',_enh.showPitchLabels);
    renderPitchLabels();
};

// §21b  SMART PITCH-LABEL PLACEMENT HELPERS
// ---------------------------------------------------------
function _distToSeg2D(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Find the best 2D (image-space) position for a pitch label on a face.
 * Picks the point that is:
 *   (a) inside the face polygon (and not inside any hole)
 *   (b) NOT underneath any higher face
 *   (c) as far as possible from all nearby edges (face edges, hole edges,
 *       and edges of intruding higher faces)
 * Returns {x, y} in image-pixel coords, or null if no valid spot found.
 */
function _findBestLabelPoint(face, allFaceDefs) {
    const pts = face.points;
    if (!pts || pts.length < 3) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(p => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });

    const faceAvgZ = pts.reduce((s, p) => s + ((p.z !== null && p.z !== undefined) ? p.z : 0), 0) / pts.length;

    // Collect faces that sit above this one and whose bbox overlaps
    const higherFaces = [];
    const faceLayer = parseInt(face.layer || face.points?.[0]?.layer || 1, 10);
    allFaceDefs.forEach(f => {
        if (f === face) return;
        const otherLayer = parseInt(f.layer || f.points?.[0]?.layer || 1, 10);
        if (otherLayer !== faceLayer) return;
        const oAvgZ = f.points.reduce((s, p) => s + ((p.z !== null && p.z !== undefined) ? p.z : 0), 0) / f.points.length;
        if (oAvgZ <= faceAvgZ + 0.05) return;
        let oMinX = Infinity, oMaxX = -Infinity, oMinY = Infinity, oMaxY = -Infinity;
        f.points.forEach(p => {
            oMinX = Math.min(oMinX, p.x); oMaxX = Math.max(oMaxX, p.x);
            oMinY = Math.min(oMinY, p.y); oMaxY = Math.max(oMaxY, p.y);
        });
        if (oMaxX < minX || oMinX > maxX || oMaxY < minY || oMinY > maxY) return;
        higherFaces.push(f);
    });

    const STEPS = 14;
    const stepX = (maxX - minX) / STEPS, stepY = (maxY - minY) / STEPS;
    if (stepX < 0.5 || stepY < 0.5) return null;

    let bestPt = null, bestDist = -1;

    for (let gy = 1; gy < STEPS; gy++) {
        for (let gx = 1; gx < STEPS; gx++) {
            const sx = minX + gx * stepX;
            const sy = minY + gy * stepY;

            if (!isPointInPoly(sx, sy, pts)) continue;

            // Must not be inside any hole
            if (face.holes) {
                let inHole = false;
                for (const hole of face.holes) {
                    if (isPointInPoly(sx, sy, hole)) { inHole = true; break; }
                }
                if (inHole) continue;
            }

            // Must not be underneath a higher face
            let underHigher = false;
            for (const hf of higherFaces) {
                if (isPointInPoly(sx, sy, hf.points)) { underHigher = true; break; }
            }
            if (underHigher) continue;

            // Maximize minimum distance to all relevant edges
            let minEdgeDist = Infinity;

            // Face boundary edges
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                minEdgeDist = Math.min(minEdgeDist,
                    _distToSeg2D(sx, sy, pts[j].x, pts[j].y, pts[i].x, pts[i].y));
            }

            // Hole edges
            if (face.holes) {
                for (const hole of face.holes) {
                    for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) {
                        minEdgeDist = Math.min(minEdgeDist,
                            _distToSeg2D(sx, sy, hole[j].x, hole[j].y, hole[i].x, hole[i].y));
                    }
                }
            }

            // Edges of overlapping higher faces (pushes label away from dormer boundaries)
            for (const hf of higherFaces) {
                for (let i = 0, j = hf.points.length - 1; i < hf.points.length; j = i++) {
                    minEdgeDist = Math.min(minEdgeDist,
                        _distToSeg2D(sx, sy, hf.points[j].x, hf.points[j].y, hf.points[i].x, hf.points[i].y));
                }
            }

            if (minEdgeDist > bestDist) {
                bestDist = minEdgeDist;
                bestPt = { x: sx, y: sy };
            }
        }
    }

    return bestPt;
}
function renderPitchLabels() {
    if(!_enh.pitchOverlayContainer){
        const container=document.getElementById('three-container'); if(!container) return;
        _enh.pitchOverlayContainer=document.createElement('div');
        _enh.pitchOverlayContainer.id='pitch-label-overlay';
        Object.assign(_enh.pitchOverlayContainer.style,{position:'absolute',top:'0',left:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'50',overflow:'hidden'});
        container.appendChild(_enh.pitchOverlayContainer);
    }
    const overlay=_enh.pitchOverlayContainer; overlay.innerHTML='';
    if(!_enh.showPitchLabels) return;
    if(!facesGroup||typeof camera==='undefined'||!camera||typeof renderer==='undefined'||!renderer) return;
    const container=document.getElementById('three-container'); if(!container) return;
    const rect=container.getBoundingClientRect();
    const w=rect.width,h=rect.height;

    // Collect all visible face definitions for higher-face occlusion checks
    const allVisibleFaces = [];
    facesGroup.children.forEach(child => {
        if (!child.userData || !child.userData.faceDef) return;
        const face = child.userData.faceDef;
        if (!face.points || face.points.length < 3) return;
        const layerNum = parseInt(face.layer || 1, 10);
        if (typeof layerVisibility !== 'undefined' && layerVisibility[layerNum] === false) return;
        allVisibleFaces.push(face);
    });

    facesGroup.children.forEach(child=>{
        if(!child.userData||!child.userData.faceDef) return;
        const face=child.userData.faceDef;
        if(!face.points||face.points.length<3) return;
        const layerNum=parseInt(face.layer||1,10);
        if(typeof layerVisibility!=='undefined'&&layerVisibility[layerNum]===false) return;
        const verts=face.points.map(pt=>getVector3(pt)); if(verts.length<3) return;
        let totalArea=0;
        for(let ti=1;ti<verts.length-1;ti++){
            const e1={x:verts[ti].x-verts[0].x,y:verts[ti].y-verts[0].y,z:verts[ti].z-verts[0].z};
            const e2={x:verts[ti+1].x-verts[0].x,y:verts[ti+1].y-verts[0].y,z:verts[ti+1].z-verts[0].z};
            const cx2=e1.y*e2.z-e1.z*e2.y,cy2=e1.z*e2.x-e1.x*e2.z,cz2=e1.x*e2.y-e1.y*e2.x;
            totalArea+=Math.sqrt(cx2*cx2+cy2*cy2+cz2*cz2)*0.5;
        }
        if(totalArea<0.01) return;
        let plane=face.plane;
        if(!plane&&typeof calculatePlaneFromVertices==='function') plane=calculatePlaneFromVertices(face.points);
        if(!plane) return;
        const pitchDeg=(typeof getPlanePitchDegrees==='function')?getPlanePitchDegrees(plane):0;
        const pitchVal=12*Math.tan(pitchDeg*Math.PI/180);

        // --- Smart label placement: avoid higher faces, maximize distance from edges ---
        const bestPt2D = _findBestLabelPoint(face, allVisibleFaces);
        let cx, cy, cz;
        if (bestPt2D) {
            // Convert the 2D image-space winner into 3D coords using the face plane
            const labelPlane = plane;
            const bestZ = labelPlane ? (labelPlane.a * bestPt2D.x + labelPlane.b * bestPt2D.y + labelPlane.c) : null;
            const zScale = getZScale();
            const scenePt = imagePointToSceneXZ(bestPt2D.x, bestPt2D.y);
            cx = scenePt.x;
            cz = scenePt.z;
            const dsmVal = (bestZ !== null && bestZ > -9000) ? bestZ : dsmMin;
            cy = (dsmVal - dsmMin) * zScale + ELEVATION_OFFSET;
        } else {
            // Fallback: centroid (original behavior)
            cx = 0; cy = 0; cz = 0;
            verts.forEach(v => { cx += v.x; cy += v.y; cz += v.z; });
            cx /= verts.length; cy /= verts.length; cz /= verts.length;
        }

        const pos3=new THREE.Vector3(cx,cy,cz);
        pos3.project(camera); if(pos3.z>1) return;
        const sx=(pos3.x*0.5+0.5)*w,sy=(-(pos3.y*0.5)+0.5)*h;
        if(sx<-20||sx>w+20||sy<-20||sy>h+20) return;
        const isLocked=isFaceLocked(face.points);
        const label=document.createElement('div');
        const lockIcon=isLocked?'\u{1F512}':'\u{1F513}';
        label.innerHTML=pitchVal.toFixed(1)+' <span style="font-size:10px;opacity:'+(isLocked?'1.0':'0.35')+';">'+lockIcon+'</span>';
        Object.assign(label.style,{position:'absolute',left:sx+'px',top:sy+'px',transform:'translate(-50%,-50%)',background:isLocked?'rgba(40,80,160,0.85)':'rgba(0,0,0,0.7)',color:'#fff',fontSize:'11px',fontWeight:'700',fontFamily:'Arial,sans-serif',padding:'2px 6px',borderRadius:'3px',border:isLocked?'1px solid rgba(100,160,255,0.6)':'1px solid rgba(255,255,255,0.25)',whiteSpace:'nowrap',pointerEvents:'auto',cursor:'pointer',lineHeight:'1.2',userSelect:'none'});
        label.addEventListener('click',function(ev){
            ev.stopPropagation(); ev.preventDefault();
            const currentPlane=plane||(typeof calculatePlaneFromVertices==='function'?calculatePlaneFromVertices(face.points):null);
            if(currentPlane) {
                if(typeof save2DState==='function') save2DState();
                toggleFaceLock(face.points,currentPlane);
            }
        });

        overlay.appendChild(label);
    });
}
// =========================================================
// §22  KEYBOARD HANDLERS (unified)
// =========================================================
window.addEventListener('keydown', function(e) {
    if(document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA') return;
    const isMod=e.ctrlKey||e.metaKey;
    if (isMod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault(); 
        e.stopPropagation(); 
        e.stopImmediatePropagation();
        let firstTarget, secondTarget;
        if (e.key === 'ArrowLeft') { 
            firstTarget = '-X'; secondTarget = 'X'; 
        }
        else if (e.key === 'ArrowRight') { 
            firstTarget = 'X'; secondTarget = '-X'; 
        }
        else if (e.key === 'ArrowUp') { 
            firstTarget = 'Y'; secondTarget = '-Y'; 
        }
        else if (e.key === 'ArrowDown') { 
            // First tap: Front View (Z) | Second tap: Back View (-Z)
            firstTarget = 'Z'; secondTarget = '-Z'; 
        }
        // Toggle logic: if the same key is pressed again, flip the view
        if (_enh.lastPresetAxis === e.key) { 
            _enh.lastPresetFlipped = !_enh.lastPresetFlipped; 
        }
        else { 
            _enh.lastPresetAxis = e.key; 
            _enh.lastPresetFlipped = false; 
        }
        const target = _enh.lastPresetFlipped ? secondTarget : firstTarget;
        setCameraPresetView(target);
        const names = { 
            'X': 'Right', '-X': 'Left', 
            'Y': 'Top', '-Y': 'Bottom', 
            'Z': 'Front', '-Z': 'Back' 
        };
        _flashViewName(names[target] || target);
        return;
    }
    // Ctrl+A: select all
    if(isMod&&e.key.toLowerCase()==='a'){
        e.preventDefault();
        if(typeof activeGeometry==='undefined'||!activeGeometry) return;
        if(typeof selectionMode!=='undefined'&&selectionMode==='LINE'){
            if(activeGeometry.connections) activeGeometry.connections.forEach(conn=>{
                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
                const l=conn.start.layer||1;
                if(typeof layerVisibility!=='undefined'&&layerVisibility[l]===false) return;
                selectedLines.add(conn);
            });
        } else {
            if(activeGeometry.points) activeGeometry.points.forEach(pt=>{
                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) return;
                const l=pt.layer||1;
                if(typeof layerVisibility!=='undefined'&&layerVisibility[l]===false) return;
                selectedPoints.add(pt);
            });
        }
        if(typeof renderGeometry2D==='function') renderGeometry2D();
        renderGeometry3D(); updateFaceSelectionVisualsOnly3D();
    }
    // M: toggle vertical move
    if((e.key==='m'||e.key==='M')&&activeController3D&&selectedPoints.size>0){
        e.preventDefault();
        if(interactState3D==='IDLE'){
            if(typeof save2DState==='function') save2DState();
            zMoveOriginals.clear();
            selectedPoints.forEach(pt=>{
                if(pt.z===null||pt.z===undefined){
                    if(layerData.dsm&&layerData.dsm[0]){const dsm=layerData.dsm[0];const ix=Math.max(0,Math.min(imageWidth-1,Math.round(pt.x)));const iy=Math.max(0,Math.min(imageHeight-1,Math.round(pt.y)));const val=dsm[iy*imageWidth+ix];pt.z=(val>-9000)?val:0;}else{pt.z=0;}
                }
                zMoveOriginals.set(pt,pt.z);
            });
            interactState3D='MOVING'; moveStartY_3D=-9999; document.body.style.cursor='ns-resize';
        } else { interactState3D='IDLE'; updateSnapGuides(null); zMoveOriginals.clear(); document.body.style.cursor='default'; triggerLiveUpdate(); }
    }
    // Escape: cancel move or resize
    if(e.key==='Escape'&&interactState3D==='MOVING'){
        selectedPoints.forEach(pt=>{if(zMoveOriginals.has(pt))pt.z=zMoveOriginals.get(pt);});
        if(typeof history2D!=='undefined'&&history2D.length>0) history2D.pop();
        interactState3D='IDLE'; updateSnapGuides(null); zMoveOriginals.clear(); document.body.style.cursor='default'; renderGeometry3D();
    }
    if(e.key==='Escape'&&interactState3D==='RESIZING_Z'){
        selectedPoints.forEach(pt=>{const orig=zResizeState.originals.get(pt);if(orig!==undefined)pt.z=orig;});
        interactState3D='IDLE'; zResizeState.active=false; document.body.style.cursor='default'; renderGeometry3D(); renderFinalPass(true);
    }
},{capture:true});
// =========================================================
// §23  getVector3
// =========================================================
function getVector3(pointObj) {
    if(!layerData.dsm) return new THREE.Vector3(0,0,0);
    const dsm=layerData.dsm[0];
    const scenePt = imagePointToSceneXZ(pointObj.x, pointObj.y);
    const planeX = scenePt.x;
    const planeZ = scenePt.z;
    let dsmVal=pointObj.z;
    if(dsmVal===null||dsmVal===undefined){
        const ix=Math.max(0,Math.min(imageWidth-1,Math.round(pointObj.x)));
        const iy=Math.max(0,Math.min(imageHeight-1,Math.round(pointObj.y)));
        dsmVal=dsm[iy*imageWidth+ix];
    }
    const zScale=getZScale();
    const height=(dsmVal>-9000)?(dsmVal-dsmMin)*zScale+ELEVATION_OFFSET:0;
    return new THREE.Vector3(planeX,height,planeZ);
}
// =========================================================
// §24  PROCESS ALL LAYERS (main entry point for 3D resolve)
// =========================================================
window.processAndRenderAllLayers = function() {
    let restoreStructureScope = null;
    if (typeof window.getStructureScopedGeometry === 'function' && !window.__structureScopeApplying && !window.__structureModeForceAll) {
        const scopedGeometry = window.getStructureScopedGeometry();
        if (scopedGeometry) {
            const originalGeometry = activeGeometry;
            window.__structureScopeApplying = true;
            activeGeometry = scopedGeometry;
            restoreStructureScope = () => {
                activeGeometry = originalGeometry;
                window.__structureScopeApplying = false;
            };
        }
    }
    if(!window.enable3D) { if (restoreStructureScope) restoreStructureScope(); return; }
    if(!activeGeometry||!activeGeometry.points) { if (restoreStructureScope) restoreStructureScope(); return; }
    toggle3DLoader(true);
    setTimeout(()=>{
        try{
            if(window.__LOOP_STEP_DBG__&&window.__LOOP_STEP_DBG__.enabled){
                renderGeometry3D();if(typeof renderGeometry2D==='function')renderGeometry2D(); return;
            }
            activeGeometry.points.forEach(p=>{if(p.__autoFacet)return;if(p._lockedPlanes&&p._lockedPlanes.length>0)return;p.zLocked=false;p.z=null;});
            const dsm=layerData.dsm?layerData.dsm[0]:null;
            const w=imageWidth,h=imageHeight;
            let allFinalFaces=[],allOrphans=[],allHoles=[];
            for(let i=1;i<=6;i++){
                let cycles=findAtomicCycles(i);
                if(cycles.length===0) continue;
                console.log(`Layer ${i}: ${cycles.length} cycles`);
                let candidates=solveFaceHierarchy(cycles);
                console.log(`Layer ${i}: ${candidates.length} after solveFaceHierarchy`);
                const higherLayerShapes=getHigherLayerPolygons(i);
                console.log(`Layer ${i}: ${higherLayerShapes.length} higher layer shapes`);
                if(dsm){
                    candidates.forEach(face=>{
                        let sumZ=0,count=0,stride=10;
                        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
                        face.points.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
                        minX=Math.floor(Math.max(0,minX));maxX=Math.ceil(Math.min(w-1,maxX));
                        minY=Math.floor(Math.max(0,minY));maxY=Math.ceil(Math.min(h-1,maxY));
                        for(let y=minY;y<=maxY;y+=stride){for(let x=minX;x<=maxX;x+=stride){
                            if(isPointInPoly(x,y,face.points)){const val=dsm[y*w+x];if(val>-9000){sumZ+=val;count++;}}
                        }}
                        face._avgZ=count>0?(sumZ/count):-Infinity;
                    });
                    candidates.sort((a,b)=>b._avgZ-a._avgZ);
                } else { candidates.sort((a,b)=>b.area-a.area); }
                if(dsm){
                    const result=resolveConflictingFaceGroups(candidates,dsm,w,h,higherLayerShapes);
                    console.log(`Layer ${i}: ${result.validFaces.length} after resolveConflicts (from ${candidates.length})`);
                    candidates=result.validFaces;
                    allOrphans.push(...result.orphanedPoints);
                    allHoles.push(...result.holes);
                }
                console.log(`Layer ${i}: ${candidates.length} candidates entering forEach`);
                const processedInLayer=[];
                candidates.forEach((face,idx)=>{
                    const occList=[...higherLayerShapes,...processedInLayer];
                    const stats=getFaceOcclusionStats(face.points,w,h,occList);
                    if(stats.ratio<0.05) return;
                    const dsmPts=sampleHeightPoints(face.points,dsm,w,h,occList);
                    if(dsmPts.length<10) return;
                    let plane=fitPlaneRANSAC(dsmPts,150,0.5,face.points,dsm,w);
                    face.plane=plane;
                    face.points.forEach(pt=>{
                        if(pt._lockedPlanes&&pt._lockedPlanes.length>0) return;
                        if(pt.zLocked) return;
                        const idealZ=plane.a*pt.x+plane.b*pt.y+plane.c;
                        let minZ=idealZ;
                        if(dsm){const ix=Math.max(0,Math.min(w-1,Math.round(pt.x)));const iy=Math.max(0,Math.min(h-1,Math.round(pt.y)));const dsmVal=dsm[iy*w+ix];if(dsmVal>-9000)minZ=Math.max(idealZ,dsmVal);}
                        pt.z=minZ; pt.zLocked=true;
                    });
                    face.layer=parseInt(i,10);
                    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
                    face.points.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
                    processedInLayer.push({points:face.points,bounds:{minX,maxX,minY,maxY}});
                    allFinalFaces.push(face);
                });
            }
            allOrphans.forEach(pt => {
                const hits = [];
                allFinalFaces.forEach(face => {
                    if (isPointInPoly(pt.x, pt.y, face.points)) {
                        hits.push({ face, z: face.plane.a * pt.x + face.plane.b * pt.y + face.plane.c });
                    }
                });
                if (hits.length === 0) return;
                hits.sort((a, b) => b.z - a.z);
                if(!(pt._lockedPlanes&&pt._lockedPlanes.length>0)){
                    pt.z = hits.length > 1 ? hits[1].z : hits[0].z;
                    pt.zLocked = true;
                }
            });
            // 3. Run special passes
            recoverOrphanedLoops(allFinalFaces, dsm, w, h);
            chimneySkylightPass(allFinalFaces);
            // 4. LAST STEP: Flatten ridges and eaves 
            // Moving this here prevents it from messing up the Plane Fitting math
            if (typeof flattenHorizontalChains === 'function') {
                flattenHorizontalChains(); 
            }
            if (typeof window.renderFinalPass === 'function') {
                window.renderFinalPass(false);
            }
        }catch(e){console.error('3D Process Error:',e);}
        finally{toggle3DLoader(false); if (restoreStructureScope) restoreStructureScope();}
    },50);
};
// =========================================================
// §25  CONFLICT RESOLUTION, OVERLAP CHECKS
// =========================================================
function resolveConflictingFaceGroups(faces,dsm,w,h,higherLayerShapes) {
    if(!faces||faces.length===0) return {validFaces:[],orphanedPoints:[],holes:[]};
    console.groupCollapsed("?? [Face Resolver] Analyzing "+faces.length+" candidates...");
    const n=faces.length, PRECISION=10;
    const adj=Array.from({length:n},()=>[]);
    const overlaps=Array.from({length:n},()=>new Set());
    const getEdgeKey=(p1,p2)=>{
        const x1=Math.round(p1.x*PRECISION),y1=Math.round(p1.y*PRECISION);
        const x2=Math.round(p2.x*PRECISION),y2=Math.round(p2.y*PRECISION);
//         return(x1<x2||(x1===x2&&y1<y2))`${x1},${y1}|${x2},${y2}${x2},${y2}|${x1},${y1}`;
        return(x1<x2||(x1===x2&&y1<y2))?`${x1},${y1}|${x2},${y2}`:`${x2},${y2}|${x1},${y1}`;
    };
    const faceEdges=faces.map(face=>{
        const keys=new Set(),pts=face.points;
        for(let i=0;i<pts.length;i++) keys.add(getEdgeKey(pts[i],pts[(i+1)%pts.length]));
        return keys;
    });
    for(let i=0;i<n;i++){for(let j=i+1;j<n;j++){
        if(polygonsOverlap(faces[i].points,faces[j].points)){overlaps[i].add(j);overlaps[j].add(i);continue;}
        for(let k of faceEdges[i]){if(faceEdges[j].has(k)){adj[i].push(j);adj[j].push(i);break;}}
    }}
    const validGroupKeys=new Set(),allGroups=[];
    const findGroups=(currentIndices)=>{
        currentIndices.sort((a,b)=>a-b);
        const key=currentIndices.join(',');
        if(validGroupKeys.has(key)) return;
        validGroupKeys.add(key); allGroups.push([...currentIndices]);
        const candidates=new Set();
        currentIndices.forEach(idx=>adj[idx].forEach(neighbor=>candidates.add(neighbor)));
        candidateLoop: for(let cand of candidates){
            if(currentIndices.includes(cand)) continue;
            for(let existing of currentIndices){if(overlaps[existing].has(cand)) continue candidateLoop;}
            findGroups([...currentIndices,cand]);
        }
    };
    for(let i=0;i<n;i++) findGroups([i]);
    const footprintMap=new Map();
    allGroups.forEach(indices=>{
        const edgeCounts=new Map();
        indices.forEach(idx=>{for(let k of faceEdges[idx]) edgeCounts.set(k,(edgeCounts.get(k)||0)+1);});
        const boundaryPoints=new Set();
        for(const[key,count]of edgeCounts.entries()){if(count===1){const parts=key.split('|');boundaryPoints.add(parts[0]);boundaryPoints.add(parts[1]);}}
        const sig=Array.from(boundaryPoints).sort((a,b)=>{const[ax,ay]=a.split(',').map(Number);const[bx,by]=b.split(',').map(Number);return(ax!==bx)?ax-bx:ay-by;}).join(';');
        if(!footprintMap.has(sig)) footprintMap.set(sig,[]);
        footprintMap.get(sig).push(indices);
    });
    const requiredByWinner=new Set(),discardedByLoser=new Set();
    const detectedHoles=[],discardGroups=[];
    footprintMap.forEach((groupList,sig)=>{
        if(groupList.length===1){groupList[0].forEach(idx=>requiredByWinner.add(idx));return;}
        console.warn(`⚔️ Conflict detected! (${groupList.length} contenders)`);
        let bestGroup=null,bestScore=Infinity;
        groupList.forEach(groupIndices=>{
            let totalSqErr=0,totalPts=0;
            groupIndices.forEach(idx=>{
                const face=faces[idx];
                const pts=sampleHeightPoints(face.points,dsm,w,h,higherLayerShapes);
                if(pts.length<5){totalSqErr+=1000;return;}
                const plane=fitPlaneRANSAC(pts,100,0.5);
                pts.forEach(p=>{totalSqErr+=Math.pow(p.z-(plane.a*p.x+plane.b*p.y+plane.c),2);});
                totalPts+=pts.length;
            });
            const rmse=totalPts>0?Math.sqrt(totalSqErr/totalPts):Infinity;
            if(rmse<bestScore){bestScore=rmse;bestGroup=groupIndices;}
        });
        if(bestGroup){
            bestGroup.forEach(idx=>requiredByWinner.add(idx));
            groupList.forEach(g=>{
                if(g!==bestGroup){
                    g.forEach(idx=>discardedByLoser.add(idx));
                    discardGroups.push(g);
                    if(g.length===2){
                        const f1=faces[g[0]],f2=faces[g[1]];
                        const z1=f1._avgZ||-Infinity,z2=f2._avgZ||-Infinity;
                        console.log(`??️ Dormer Hole Detected (Z: ${Math.max(z1,z2).toFixed(2)})`);
                        detectedHoles.push(z1>z2?f1:f2);
                    }
                }
            });
        }
    });
    const keptPoints=new Set(),finalFaces=[];
    for(let i=0;i<n;i++){
        if(requiredByWinner.has(i)||!discardedByLoser.has(i)){finalFaces.push(faces[i]);faces[i].points.forEach(p=>keptPoints.add(p));}
    }
    const orphanedPoints=new Set();
    discardGroups.forEach(grp=>grp.forEach(idx=>faces[idx].points.forEach(p=>{if(!keptPoints.has(p))orphanedPoints.add(p);})));
    console.log(`Resolution: ${n} -> ${finalFaces.length} faces. Orphans: ${orphanedPoints.size}`);
    console.groupEnd();
    return {validFaces:finalFaces,orphanedPoints:Array.from(orphanedPoints),holes:detectedHoles};
}
function polygonsOverlap(polyA,polyB) {
    for(let p of polyA) if(isPointInPolyStrict(p,polyB)) return true;
    for(let p of polyB) if(isPointInPolyStrict(p,polyA)) return true;
    let cx=0,cy=0; polyA.forEach(p=>{cx+=p.x;cy+=p.y;}); cx/=polyA.length;cy/=polyA.length;
    return isPointInPolyStrict({x:cx,y:cy},polyB);
}
// =========================================================
// §26  ORPHAN RECOVERY
// =========================================================
function recoverOrphanedLoops(existingFaces,dsm,w,h) {
    console.groupCollapsed("?? recoverOrphanedLoops Debug");
    if(!activeGeometry||!activeGeometry.connections){console.log("No active geometry.");console.groupEnd();return;}
    const usedPoints=new Set();
    existingFaces.forEach(face=>face.points.forEach(p=>usedPoints.add(p)));
    const allPoints=activeGeometry.points;
    const orphanPoints=allPoints.filter(p=>!usedPoints.has(p));
    console.log(`Stats: ${allPoints.length} Total, ${usedPoints.size} Used, ${orphanPoints.length} Orphans`);
    if(orphanPoints.length===0){console.log("No orphans.");console.groupEnd();return;}
    const adj=new Map();
    allPoints.forEach(p=>adj.set(p,[]));
    activeGeometry.connections.forEach(c=>{if(adj.has(c.start))adj.get(c.start).push(c.end);if(adj.has(c.end))adj.get(c.end).push(c.start);});
    const foundCycles=[],processedCycleSigs=new Set();
    const MAX_DEPTH=8;
    const getSig=arr=>arr.map(p=>allPoints.indexOf(p)).sort((a,b)=>a-b).join('|');
    const findLoop=(curr,start,path,visited)=>{
        const neighbors=adj.get(curr); if(!neighbors) return;
        for(let next of neighbors){
            if(path.length>=2&&next===path[path.length-2]) continue;
            if(next===start&&path.length>2){const sig=getSig(path);if(!processedCycleSigs.has(sig)){processedCycleSigs.add(sig);foundCycles.push([...path]);}return;}
            if(!visited.has(next)&&path.length<MAX_DEPTH){
                visited.add(next);path.push(next);
                findLoop(next,start,path,visited);
                path.pop();visited.delete(next);
            }
        }
    };
    orphanPoints.forEach(op=>findLoop(op,op,[op],new Set([op])));
    console.log(`Found ${foundCycles.length} candidate loops.`);
    const PLANARITY_TOL=0.20;
    let snappedCount=0;
    foundCycles.forEach((loop,idx)=>{
        const anchors=loop.filter(p=>usedPoints.has(p));
        const orphans=loop.filter(p=>!usedPoints.has(p));
        if(anchors.length<3) return;
        const anchorData=anchors.map(p=>({x:p.x,y:p.y,z:(p.z!==null&&p.z!==undefined)?p.z:0}));
        const plane=fitPlaneLinear(anchorData);
        let errSum=0;
        anchorData.forEach(p=>errSum+=Math.pow(p.z-(plane.a*p.x+plane.b*p.y+plane.c),2));
        const rmse=Math.sqrt(errSum/anchorData.length);
        if(rmse<PLANARITY_TOL){
            orphans.forEach(op=>{if(op._lockedPlanes&&op._lockedPlanes.length>0)return;op.z=plane.a*op.x+plane.b*op.y+plane.c;op.zLocked=true;snappedCount++;});
        }
    });
    console.log(`Recovery Complete. Snapped ${snappedCount} point(s).`);
    console.groupEnd();
}
// =========================================================
// §27  CHIMNEY / SKYLIGHT PASS
// =========================================================
function chimneySkylightPass(allFinalFaces) {
    if(!activeGeometry||!activeGeometry.points||!activeGeometry.connections) return;
    const metersPerPx=(window.getMetersPerPx?window.getMetersPerPx():(((window.getRadiusMeters?window.getRadiusMeters():(window.RADIUS_METERS||20))*2)/imageWidth));
    const sqFtPerSqPx=(metersPerPx*3.28084)**2;
    const MAX_AREA=32,ANGLE_TOL=25;
    const ptAdj=new Map();
    activeGeometry.points.forEach(p=>ptAdj.set(p,new Set()));
    activeGeometry.connections.forEach(c=>{ptAdj.get(c.start).add(c.end);ptAdj.get(c.end).add(c.start);});
    const visited=new Set(),chimneyLoops=[];
    activeGeometry.points.forEach(startPt=>{
        if(visited.has(startPt)) return;
        const component=[],queue=[startPt]; visited.add(startPt);
        while(queue.length>0){const cur=queue.shift();component.push(cur);if(component.length>6)return;for(const n of ptAdj.get(cur)){if(!visited.has(n)){visited.add(n);queue.push(n);}}}
        if(component.length!==4) return;
        const compSet=new Set(component);
        for(const pt of component){let internal=0;for(const n of ptAdj.get(pt)){if(compSet.has(n))internal++;}if(internal!==2||ptAdj.get(pt).size!==2) return;}
        const ring=[component[0]]; let prev=null,curr=component[0];
        for(let step=0;step<3;step++){let next=null;for(const n of ptAdj.get(curr)){if(compSet.has(n)&&n!==prev){next=n;break;}}if(!next)return;ring.push(next);prev=curr;curr=next;}
        let areaPx=0;
        for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];areaPx+=(a.x*b.y-b.x*a.y);}
        if(Math.abs(areaPx)*0.5*sqFtPerSqPx>MAX_AREA) return;
        let ok=true;
        for(let i=0;i<4;i++){
            const pP=ring[(i+3)%4],pC=ring[i],pN=ring[(i+1)%4];
            const dx1=pP.x-pC.x,dy1=pP.y-pC.y,dx2=pN.x-pC.x,dy2=pN.y-pC.y;
            const mag1=Math.hypot(dx1,dy1),mag2=Math.hypot(dx2,dy2);
            if(mag1<0.001||mag2<0.001){ok=false;break;}
            const ang=Math.acos(Math.max(-1,Math.min(1,(dx1*dx2+dy1*dy2)/(mag1*mag2))))*(180/Math.PI);
            if(Math.abs(ang-90)>ANGLE_TOL){ok=false;break;}
        }
        if(!ok) return;
        const cx=ring.reduce((s,p)=>s+p.x,0)/4,cy=ring.reduce((s,p)=>s+p.y,0)/4;
        let parentFace=null;
        for(const face of allFinalFaces){
            if(isPointInPoly(cx,cy,face.points)){if(ring.every(p=>new Set(face.points).has(p)))continue;parentFace=face;break;}
        }
        if(!parentFace) return;
        chimneyLoops.push({ring,parentFace,areaSqFt:Math.abs(areaPx)*0.5*sqFtPerSqPx});
    });
    if(chimneyLoops.length===0) return;
    console.log(`?? Chimney/Skylight Pass: found ${chimneyLoops.length} feature(s)`);
    chimneyLoops.forEach(({ring,parentFace,areaSqFt})=>{
        const sig=getLocalFaceSignature(ring);
        if(typeof deletedFaceSignatures!=='undefined') deletedFaceSignatures.add(sig);
        const fIdx=allFinalFaces.findIndex(f=>getLocalFaceSignature(f.points)===sig);
        if(fIdx!==-1) allFinalFaces.splice(fIdx,1);
        const plane=parentFace.plane||calculatePlaneFromVertices(parentFace.points);
        ring.forEach(pt=>{if(pt._lockedPlanes&&pt._lockedPlanes.length>0)return;pt.z=plane.a*pt.x+plane.b*pt.y+plane.c;pt.zLocked=true;});
    });
}
// =========================================================
// §28  ATOMIC CYCLE FINDER & FACE HIERARCHY
// =========================================================
function findAtomicCycles(layerNum) {
    const MAX_TIME=3000,deadline=performance.now()+MAX_TIME;
    const rawLines=activeGeometry.connections.filter(c=>(c.start.layer||1)===layerNum&&(c.end.layer||1)===layerNum);
    if(rawLines.length<3) return [];
    const uniqueKeys=new Set(),layerLines=[];
    rawLines.forEach(c=>{
        const p1=`${c.start.x.toFixed(2)},${c.start.y.toFixed(2)}`,p2=`${c.end.x.toFixed(2)},${c.end.y.toFixed(2)}`;
        if(p1===p2)return;
        const key=p1<p2?`${p1}|${p2}`:`${p2}|${p1}`;
        if(!uniqueKeys.has(key)){uniqueKeys.add(key);layerLines.push(c);}
    });
    if(layerLines.length<3) return [];
    const adj=new Map(),connToIndex=new Map();
    layerLines.forEach((conn,idx)=>{
        connToIndex.set(conn,idx);
        if(!adj.has(conn.start))adj.set(conn.start,[]);if(!adj.has(conn.end))adj.set(conn.end,[]);
        adj.get(conn.start).push({pt:conn.end,conn,ang:Math.atan2(conn.end.y-conn.start.y,conn.end.x-conn.start.x)});
        adj.get(conn.end).push({pt:conn.start,conn,ang:Math.atan2(conn.start.y-conn.end.y,conn.start.x-conn.end.x)});
    });
    adj.forEach(neighbors=>neighbors.sort((a,b)=>b.ang-a.ang));
    const crossingMap=(layerLines.length<200)?getCrossingMap(layerLines):{};
    const cycles=[],uniqueSigs=new Set();
    try{
        layerLines.forEach((startConn,startIdx)=>{
            if(performance.now()>deadline) throw new Error('TIMEOUT');
            [{curr:startConn.end,prev:startConn.start},{curr:startConn.start,prev:startConn.end}].forEach(startDir=>{
                const visitedEdges=new Set([startIdx]);
                const visitedPoints=new Set([startDir.prev,startDir.curr]);
                const path=[startDir.prev,startDir.curr];
                const initialBanned=new Set(crossingMap[startIdx]||[]);
                const result=solveRecursiveCycle(startDir.curr,startDir.prev,startDir.prev,path,visitedPoints,visitedEdges,initialBanned,adj,connToIndex,crossingMap,deadline);
                if(result){
                    let area=0;for(let i=0;i<result.length;i++){const p1=result[i],p2=result[(i+1)%result.length];area+=(p1.x*p2.y-p2.x*p1.y);}area*=0.5;
                    if(area>1){const sig=result.map(p=>`${Math.round(p.x)},${Math.round(p.y)}`).sort().join('|');if(!uniqueSigs.has(sig)){uniqueSigs.add(sig);cycles.push({points:result,area,holes:[]});}}
                }
            });
        });
    }catch(err){if(err.message!=='TIMEOUT')console.error(err);}
    return cycles;
}
function solveRecursiveCycle(curr,prev,target,path,visitedPoints,visitedEdges,bannedIndices,adj,connToIndex,crossingMap,deadline) {
    if(performance.now()>deadline) throw new Error('TIMEOUT');
    if(path.length>50) return null;
    const neighbors=adj.get(curr); if(!neighbors) return null;
    let prevIdx=-1;
    for(let k=0;k<neighbors.length;k++){if(neighbors[k].pt===prev){prevIdx=k;break;}}
    if(prevIdx===-1) return null;
    for(let i=1;i<neighbors.length;i++){
        const idx=(prevIdx+i)%neighbors.length;
        const candidate=neighbors[idx],nextPt=candidate.pt;
        const connIdx=connToIndex.get(candidate.conn);
        if(nextPt===target){if(bannedIndices.has(connIdx))continue;return[...path];}
        if(bannedIndices.has(connIdx)||visitedEdges.has(connIdx)||visitedPoints.has(nextPt))continue;
        const conflicts=crossingMap[connIdx];
        let selfIntersect=false;
        if(conflicts){for(let cId of conflicts){if(visitedEdges.has(cId)){selfIntersect=true;break;}}}
        if(selfIntersect)continue;
        visitedEdges.add(connIdx);visitedPoints.add(nextPt);path.push(nextPt);
        const addedBanned=[];
        if(conflicts){for(let cId of conflicts){if(!bannedIndices.has(cId)){bannedIndices.add(cId);addedBanned.push(cId);}}}
        const result=solveRecursiveCycle(nextPt,curr,target,path,visitedPoints,visitedEdges,bannedIndices,adj,connToIndex,crossingMap,deadline);
        if(result) return result;
        for(let cId of addedBanned) bannedIndices.delete(cId);
        path.pop();visitedPoints.delete(nextPt);visitedEdges.delete(connIdx);
    }
    return null;
}
function getCrossingMap(lines) {
    const map={},len=lines.length;
    const intersects=(p0,p1,p2,p3)=>{
        const s1x=p1.x-p0.x,s1y=p1.y-p0.y,s2x=p3.x-p2.x,s2y=p3.y-p2.y;
        const d=-s2x*s1y+s1x*s2y; if(d===0) return false;
        const s=(-s1y*(p0.x-p2.x)+s1x*(p0.y-p2.y))/d;
        const t=(s2x*(p0.y-p2.y)-s2y*(p0.x-p2.x))/d;
        return(s>0&&s<1&&t>0&&t<1);
    };
    for(let i=0;i<len;i++) map[i]=[];
    for(let i=0;i<len;i++){for(let j=i+1;j<len;j++){
        const l1=lines[i],l2=lines[j];
        if(l1.start===l2.start||l1.start===l2.end||l1.end===l2.start||l1.end===l2.end) continue;
        if(intersects(l1.start,l1.end,l2.start,l2.end)){map[i].push(j);map[j].push(i);}
    }}
    return map;
}
function solveFaceHierarchy(allCycles) {
    allCycles.sort((a,b)=>b.area-a.area);
    return allCycles;
}
// =========================================================
// §29  PLANE FITTING & SAMPLING
// =========================================================
function fitPlaneRANSAC(points,iterations=150,distanceThreshold=0.3,faceVertices=null,dsm=null,imgW=0) {
    iterations=150;distanceThreshold=0.6;
    const n=points.length; if(n<3) return {a:0,b:0,c:0};
    let bestPlane=null,bestScore=-Infinity,bestInlierPts=[];
    const getPlane=(p1,p2,p3)=>{
        const a=(p2.y-p1.y)*(p3.z-p1.z)-(p2.z-p1.z)*(p3.y-p1.y);
        const b=(p2.z-p1.z)*(p3.x-p1.x)-(p2.x-p1.x)*(p3.z-p1.z);
        const c=(p2.x-p1.x)*(p3.y-p1.y)-(p2.y-p1.y)*(p3.x-p1.x);
        const d=-a*p1.x-b*p1.y-c*p1.z;
        if(Math.abs(c)<1e-6) return null;
        return {a:-a/c,b:-b/c,c:-d/c};
    };
    const vertexDsmZ=[];
    if(faceVertices&&dsm&&imgW>0){
        faceVertices.forEach(pt=>{
            const ix=Math.max(0,Math.min(imgW-1,Math.round(pt.x)));
            const iy=Math.max(0,Math.min((dsm.length/imgW)-1,Math.round(pt.y)));
            const val=dsm[iy*imgW+ix]; if(val>-9000) vertexDsmZ.push({x:pt.x,y:pt.y,dsmZ:val});
        });
    }
    for(let i=0;i<iterations;i++){
        const i1=Math.floor(Math.random()*n);
        let i2=Math.floor(Math.random()*n),i3=Math.floor(Math.random()*n);
        while(i2===i1) i2=Math.floor(Math.random()*n);
        while(i3===i1||i3===i2) i3=Math.floor(Math.random()*n);
        const plane=getPlane(points[i1],points[i2],points[i3]); if(!plane) continue;
        let inliers=0,inlierPts=[];
        for(let j=0;j<n;j++){const p=points[j];if(Math.abs((plane.a*p.x+plane.b*p.y+plane.c)-p.z)<distanceThreshold){inliers++;inlierPts.push(p);}}
        let penalty=0;
        for(let k=0;k<vertexDsmZ.length;k++){const v=vertexDsmZ[k];const pz=plane.a*v.x+plane.b*v.y+plane.c;if(pz<v.dsmZ)penalty+=(v.dsmZ-pz);}
        const score=inliers-(penalty*10);
        if(score>bestScore){bestScore=score;bestPlane=plane;bestInlierPts=inlierPts;}
    }
    return(bestInlierPts.length>3)?fitPlaneLinear(bestInlierPts):(bestPlane||{a:0,b:0,c:0});
}
function fitPlaneLinear(points) {
    let sX=0,sY=0,sZ=0,sXX=0,sYY=0,sXY=0,sXZ=0,sYZ=0;
    const n=points.length;
    for(let i=0;i<n;i++){const p=points[i];sX+=p.x;sY+=p.y;sZ+=p.z;sXX+=p.x*p.x;sYY+=p.y*p.y;sXY+=p.x*p.y;sXZ+=p.x*p.z;sYZ+=p.y*p.z;}
    const det=n*sXX*sYY+2*sXY*sX*sY-sX*sX*sYY-sY*sY*sXX-n*sXY*sXY;
    if(Math.abs(det)<1e-9) return {a:0,b:0,c:0};
    const invDet=1/det;
    const m00=sXX,m01=sXY,m02=sX,m10=sXY,m11=sYY,m12=sY,m20=sX,m21=sY,m22=n;
    const r0=sXZ,r1=sYZ,r2=sZ;
    const a=invDet*((m11*m22-m12*m21)*r0+(m02*m21-m01*m22)*r1+(m01*m12-m02*m11)*r2);
    const b=invDet*((m12*m20-m10*m22)*r0+(m00*m22-m02*m20)*r1+(m02*m10-m00*m12)*r2);
    const c=invDet*((m10*m21-m11*m20)*r0+(m01*m20-m00*m21)*r1+(m00*m11-m01*m10)*r2);
    return {a,b,c};
}
function sampleHeightPoints(polyPoints,dsm,w,h,exclusionPolys=[]) {
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    polyPoints.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
    minX=Math.floor(Math.max(0,minX));maxX=Math.ceil(Math.min(w-1,maxX));
    minY=Math.floor(Math.max(0,minY));maxY=Math.ceil(Math.min(h-1,maxY));
    const bboxDiag=Math.hypot(maxX-minX,maxY-minY), padDist=bboxDiag*0.05;
    const distToSeg=(px,py,ax,ay,bx,by)=>{
        const dx=bx-ax,dy=by-ay,lenSq=dx*dx+dy*dy;
        if(lenSq===0)return Math.hypot(px-ax,py-ay);
        let t=((px-ax)*dx+(py-ay)*dy)/lenSq;t=Math.max(0,Math.min(1,t));
        return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
    };
    const tooClose=(px,py)=>{
        for(let i=0,j=polyPoints.length-1;i<polyPoints.length;j=i++){if(distToSeg(px,py,polyPoints[j].x,polyPoints[j].y,polyPoints[i].x,polyPoints[i].y)<padDist) return true;}
        return false;
    };
    const samples=[],stride=1;
    for(let y=minY;y<=maxY;y+=stride){for(let x=minX;x<=maxX;x+=stride){
        if(!isPointInPoly(x,y,polyPoints)) continue;
        if(tooClose(x,y)) continue;
        let occ=false;
        for(let k=0;k<exclusionPolys.length;k++){const ex=exclusionPolys[k];if(x>=ex.bounds.minX&&x<=ex.bounds.maxX&&y>=ex.bounds.minY&&y<=ex.bounds.maxY){if(isPointInPoly(x,y,ex.points)){occ=true;break;}}}
        if(!occ){const z=dsm[y*w+x];if(z>-9000) samples.push({x,y,z});}
    }}
    return samples;
}
function getHigherLayerPolygons(currentLayer) {
    const polys=[];
    for(let l=currentLayer+1;l<=6;l++){
        findAtomicCycles(l).forEach(c=>{
            let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
            c.points.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
            polys.push({points:c.points,bounds:{minX,maxX,minY,maxY}});
        });
    }
    return polys;
}
function getFaceOcclusionStats(facePoints,w,h,exclusionPolys) {
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    facePoints.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
    minX=Math.floor(Math.max(0,minX));maxX=Math.ceil(Math.min(w-1,maxX));
    minY=Math.floor(Math.max(0,minY));maxY=Math.ceil(Math.min(h-1,maxY));
    let total=0,visible=0;
    for(let y=minY;y<=maxY;y+=5){for(let x=minX;x<=maxX;x+=5){
        if(!isPointInPoly(x,y,facePoints)) continue; total++;
        let occ=false;
        for(let k=0;k<exclusionPolys.length;k++){const ex=exclusionPolys[k];if(x>=ex.bounds.minX&&x<=ex.bounds.maxX&&y>=ex.bounds.minY&&y<=ex.bounds.maxY){if(isPointInPoly(x,y,ex.points)){occ=true;break;}}}
        if(!occ) visible++;
    }}
    return {total,visible,ratio:total>0?visible/total:0};
}
function calculatePlaneFromVertices(faceOrPoints) {
    const points=Array.isArray(faceOrPoints)?faceOrPoints:(faceOrPoints?.points||[]);
    const holes=(!Array.isArray(faceOrPoints)&&faceOrPoints?.holes)?faceOrPoints.holes:[];
    const allPlanePts = points.concat(...holes);
    const validPts=allPlanePts.filter(p=>p&&Number.isFinite(p.z));
    if(validPts.length>=3) return fitPlaneLinear(validPts);
    if(layerData?.dsm?.[0]&&imageWidth>0&&imageHeight>0&&points.length>=3){
        try{
            const samples=sampleHeightPoints(allPlanePts.length>=3?allPlanePts:points,layerData.dsm[0],imageWidth,imageHeight,[]);
            if(samples&&samples.length>=10) return fitPlaneRANSAC(samples,120,0.5);
            if(samples&&samples.length>=3) return fitPlaneLinear(samples);
        }catch(e){console.warn("[PlaneFallback] DSM sampling failed",e);}
    }
    return {a:0,b:0,c:dsmMin};
}
function getPlanePitchDegrees(plane) {
    const metersPerPx=(window.getMetersPerPx?window.getMetersPerPx():(((window.getRadiusMeters?window.getRadiusMeters():(window.RADIUS_METERS||20))*2)/imageWidth));
    const rawSlope=Math.sqrt(plane.a**2+plane.b**2);
    const pixelsPerMeter=1/metersPerPx;
    return Math.atan(rawSlope*pixelsPerMeter)*(180/Math.PI);
}
// =========================================================
// §30  FLATTEN HORIZONTAL CHAINS
// =========================================================
window.flattenHorizontalChains = function() {
    if (!activeGeometry || !activeGeometry.connections) return;
    // REDUCED THRESHOLD: 10 degrees is too much (it catches sloped facets). 
    // 3 degrees is safer for ridges/eaves.
    const FLAT_THRESHOLD_DEG = 3.0; 
    const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
        (((window.getRadiusMeters ? window.getRadiusMeters() :
        (window.RADIUS_METERS || 20)) * 2) / imageWidth));
    // Only look for lines that are nearly horizontal
    const flatConnections = activeGeometry.connections.filter(conn => {
        if (conn.start.z === null || conn.end.z === null) return false;
        const dz = Math.abs(conn.start.z - conn.end.z);
        const dxy = Math.hypot(conn.start.x - conn.end.x, conn.start.y - conn.end.y);
        const distM = dxy * metersPerPx;
        if (distM < 0.1) return true; // Very short lines are flat by default
        const deg = Math.atan(dz / distM) * (180 / Math.PI);
        return deg <= FLAT_THRESHOLD_DEG;
    });
    if (flatConnections.length === 0) return;
    const adj = new Map();
    flatConnections.forEach(c => {
        if (!adj.has(c.start)) adj.set(c.start, []);
        if (!adj.has(c.end)) adj.set(c.end, []);
        adj.get(c.start).push(c.end);
        adj.get(c.end).push(c.start);
    });
    const visited = new Set();
    for (let [pt] of adj) {
        if (visited.has(pt)) continue;
        const group = [];
        const queue = [pt];
        visited.add(pt);
        while (queue.length > 0) {
            const cur = queue.pop();
            group.push(cur);
            (adj.get(cur) || []).forEach(n => {
                if (!visited.has(n)) {
                    visited.add(n);
                    queue.push(n);
                }
            });
        }
        // Only flatten if the group is small or strictly linear (ridges/eaves)
        // This prevents "Roof melting" where an entire facet gets flattened.
        if (group.length > 1 && group.length < 10) {
            let sumZ = 0;
            group.forEach(p => sumZ += p.z);
            const avgZ = sumZ / group.length;
            
            group.forEach(p => { 
                if(p._lockedPlanes&&p._lockedPlanes.length>0) return;
                // Only overwrite if the change is significant but not massive
                if (Math.abs(p.z - avgZ) < 0.5) {
                    p.z = avgZ; 
                    p.zLocked = true; 
                }
            });
        }
    }
};
// =========================================================
// §31  MISC EXPORTS & UTILITIES
// =========================================================
window.highlightLayerFaces = function(layerNum=1) {
    if(!activeGeometry) return;
    window.deleteFaceRenderings();
    let cycles=findAtomicCycles(layerNum);
    if(cycles.length===0) return;
    const faces=solveFaceHierarchy(cycles);
    renderFaces3D(faces); renderFaces2D(faces);
};
window.optimizeFaceSlopes = function() {};
window.updateVisualsOnly = function() { renderFinalPass(true); };
window.update3DLayerVisibility = updateFaceSelectionVisualsOnly3D;
function renderFaces3D(faces) {
    if(!facesGroup) return;
    faces.forEach((face,idx)=>{
        const shape=new THREE.Shape();
        const sv=getVector3(face.points[0]); shape.moveTo(sv.x,-sv.z);
        for(let i=1;i<face.points.length;i++){const v=getVector3(face.points[i]);shape.lineTo(v.x,-v.z);}
        face.holes.forEach(holePts=>{
            const hp=new THREE.Path();
            const hs=getVector3(holePts[0]);hp.moveTo(hs.x,-hs.z);
            for(let k=1;k<holePts.length;k++){const hv=getVector3(holePts[k]);hp.lineTo(hv.x,-hv.z);}
            shape.holes.push(hp);
        });
        const shapeGeo=new THREE.ShapeGeometry(shape);
        const hue=(idx*137.5)%360;
        const mat = new THREE.MeshStandardMaterial({color:new THREE.Color(`hsl(${hue},70%,50%)`),side:THREE.DoubleSide,transparent:true,opacity:0.7,roughness:0.5});
        const m=new THREE.Mesh(shapeGeo,mat);
        m.rotation.x=-Math.PI/2;
        let avgY=0;face.points.forEach(p=>avgY+=getVector3(p).y);
        m.position.y=(avgY/face.points.length)+0.1;
        m.userData.faceDef=face;
        facesGroup.add(m);
    });
}
// =========================================================
// §32  LOOP STEP DEBUGGER
// =========================================================
(function(){
    const DBG={enabled:false,loops:[],i:0,dimOthers:true,highlightColor:0x00ffff,dimOpacity:0.10,highlightOpacity:1.0,highlightTubeRadius:0.18,highlightConns:new Set()};
    window.__LOOP_STEP_DBG__=DBG;
    function ensurePointIds(){let pid=1;(activeGeometry?.points||[]).forEach(p=>{if(!p.__pid)p.__pid=(pid++);});}
    function findConnByEndpoints(p1,p2){const conns=activeGeometry?.connections||[];for(let k=0;k<conns.length;k++){const c=conns[k];if((c.start===p1&&c.end===p2)||(c.start===p2&&c.end===p1))return c;}return null;}
    function buildHighlightSet(loopPts){DBG.highlightConns.clear();if(!loopPts||loopPts.length<2)return;for(let i=0;i<loopPts.length;i++){const c=findConnByEndpoints(loopPts[i],loopPts[(i+1)%loopPts.length]);if(c)DBG.highlightConns.add(c);}}
    function logLoop(loopRec){
        const{layer,cycle,idx}=loopRec;const pts=cycle.points||[];
        console.groupCollapsed(`%c[LoopStep] Layer ${layer} | #${idx+1}/${DBG.loops.length} | verts=${pts.length} | area=${(cycle.area||0).toFixed(2)}`,"color:#00ffff;font-weight:700;");
        console.log("points:",pts.map(p=>({x:+p.x.toFixed(2),y:+p.y.toFixed(2)})));
        console.log("raw cycle:",cycle); console.groupEnd();
    }
    function renderCurrent(){const rec=DBG.loops[DBG.i];if(!rec)return;buildHighlightSet(rec.cycle.points);logLoop(rec);if(typeof renderGeometry3D==='function')renderGeometry3D();if(typeof renderGeometry2D==='function')renderGeometry2D();}
    window.startLoopStepDebug=function(opts={}){
        if(!window.enable3D)window.enable3D=true;
        if(!activeGeometry?.connections?.length){console.warn("[LoopStep] No activeGeometry/connections.");return;}
        ensurePointIds(); DBG.enabled=true;
        DBG.dimOthers=(opts.dimOthers!==undefined)?!!opts.dimOthers:true;
        DBG.i=0;DBG.loops=[];
        const layers=opts.layers||[1,2,3,4,5,6];
        console.groupCollapsed("%c[LoopStep] Building loop list…","color:#00ffff;font-weight:700;");
        layers.forEach(layer=>{const cycles=findAtomicCycles(layer)||[];cycles.forEach((c,idx)=>DBG.loops.push({layer,cycle:c,idx:DBG.loops.length}));console.log(`layer ${layer}: ${cycles.length} cycles`);});
        console.log("total cycles:",DBG.loops.length); console.groupEnd();
        if(DBG.loops.length===0){console.warn("[LoopStep] No cycles found.");DBG.enabled=false;return;}
        renderCurrent();
    };
    window.loopStepNext=function(){if(!DBG.enabled)return;DBG.i++;if(DBG.i>=DBG.loops.length){console.log("[LoopStep] done.");DBG.i=DBG.loops.length-1;return;}renderCurrent();};
    window.loopStepPrev=function(){if(!DBG.enabled)return;DBG.i=Math.max(0,DBG.i-1);renderCurrent();};
    window.stopLoopStepDebug=function(){DBG.enabled=false;DBG.loops=[];DBG.i=0;DBG.highlightConns.clear();if(typeof renderGeometry3D==='function')renderGeometry3D();if(typeof renderGeometry2D==='function')renderGeometry2D();console.log("[LoopStep] stopped.");};
})();
// =========================================================
// §33  WIREFRAME RESOLUTION DEBUG
// =========================================================
(function(){
    const CFG={enabled:false,debugPause:true,rounds:3,thresholdM:0.35,samplesPerLine:24,alpha:0.85,onlyVisibleLayers:true,minValidSamples:6};
    const STATE={running:false,round:0,lastSummary:null,originalZ:new Map(),originalLocked:new Map()};
    window.WIREFRAME_CFG=CFG;
    window.__WIRE_STATE__=STATE;
    function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
    function getDSMZ(x,y){
        const dsm=layerData?.dsm?.[0]; if(!dsm) return null;
        const ix=clamp(Math.round(x),0,imageWidth-1),iy=clamp(Math.round(y),0,imageHeight-1);
        const v=dsm[iy*imageWidth+ix]; return(v>-9000&&Number.isFinite(v))?v:null;
    }
    function initAllFromDSM(){
        STATE.originalZ.clear();STATE.originalLocked.clear();
        activeGeometry.points.forEach(pt=>{
            STATE.originalZ.set(pt,pt.z);STATE.originalLocked.set(pt,!!pt.zLocked);
            const z=getDSMZ(pt.x,pt.y);
            if(!(pt._lockedPlanes&&pt._lockedPlanes.length>0)){ pt.z=(z!==null)?z:(pt.z??0); pt.zLocked=true; }
        });
    }
    function scoreLine(conn){
        const z0=conn.start.z??getDSMZ(conn.start.x,conn.start.y)??0;
        const z1=conn.end.z??getDSMZ(conn.end.x,conn.end.y)??0;
        const N=Math.max(6,CFG.samplesPerLine|0);
        let valid=0,good=0,sq=0;
        for(let i=0;i<N;i++){
            const t=(i+0.5)/N;
            const dz=getDSMZ(conn.start.x+(conn.end.x-conn.start.x)*t,conn.start.y+(conn.end.y-conn.start.y)*t);
            if(dz===null) continue;
            const wZ=z0*(1-t)+z1*t, err=Math.abs(wZ-dz);
            valid++; sq+=err*err;
            if(err<=CFG.thresholdM) good++;
        }
        return{valid,good,rmse:valid>0?Math.sqrt(sq/valid):Infinity,ratio:valid>0?good/valid:0};
    }
    function runOneRound(){
        const conns=activeGeometry.connections;
        const ptNeighConns=new Map();
        conns.forEach(c=>{
            if(!ptNeighConns.has(c.start))ptNeighConns.set(c.start,[]);
            if(!ptNeighConns.has(c.end))ptNeighConns.set(c.end,[]);
            ptNeighConns.get(c.start).push(c);
            ptNeighConns.get(c.end).push(c);
        });
        const scored=conns.map(c=>({conn:c,...scoreLine(c)}));
        const ptScores=new Map();
        activeGeometry.points.forEach(pt=>{
            const edges=ptNeighConns.get(pt)||[];
            if(edges.length===0) return;
            let worstRmse=0;
            edges.forEach(c=>{const s=scored.find(x=>x.conn===c);if(s&&s.rmse>worstRmse) worstRmse=s.rmse;});
            if(worstRmse>CFG.thresholdM) ptScores.set(pt,worstRmse);
        });
        let moved=0;
        for(const[pt,badRmse]of ptScores){
            const edges=ptNeighConns.get(pt)||[];
            const neighborZs=edges.map(c=>{
                const other=(c.start===pt)?c.end:c.start;
                return other.z??getDSMZ(other.x,other.y)??0;
            });
            const avgNeighborZ=neighborZs.reduce((a,b)=>a+b,0)/neighborZs.length;
            const dsmZ=getDSMZ(pt.x,pt.y);
            const target=(dsmZ!==null)?(dsmZ+avgNeighborZ)/2:avgNeighborZ;
            const oldZ=pt.z;
            if(pt._lockedPlanes&&pt._lockedPlanes.length>0) continue;
            pt.z=oldZ*(1-CFG.alpha)+target*CFG.alpha;
            pt.zLocked=true;
            if(Math.abs(pt.z-oldZ)>0.001) moved++;
        }
        return{moved,checked:ptScores.size,totalConns:conns.length};
    }
    window.resolveWireframe=function(opts={}){
        if(!activeGeometry||!activeGeometry.points.length){console.warn("[Wire] No geometry.");return;}
        Object.assign(CFG,opts);
        console.groupCollapsed(`%c[Wire] Starting wireframe resolve (${CFG.rounds} rounds)`,"color:#ff0;font-weight:700;");
        initAllFromDSM();
        STATE.running=true;STATE.round=0;
        for(let r=0;r<CFG.rounds;r++){
            STATE.round=r+1;
            const result=runOneRound();
            console.log(`Round ${r+1}: moved ${result.moved}/${result.checked} pts`);
            if(result.moved===0){console.log("Converged early.");break;}
        }
        STATE.running=false;
        console.groupEnd();
        if(typeof renderGeometry3D==='function') renderGeometry3D();
        if(typeof renderFinalPass==='function') renderFinalPass(false);
    };
    window.undoWireframe=function(){
        if(STATE.originalZ.size===0){console.warn("[Wire] Nothing to undo.");return;}
        activeGeometry.points.forEach(pt=>{
            if(pt._lockedPlanes&&pt._lockedPlanes.length>0) return;
            if(STATE.originalZ.has(pt)){pt.z=STATE.originalZ.get(pt);pt.zLocked=STATE.originalLocked.get(pt)||false;}
        });
        STATE.originalZ.clear();STATE.originalLocked.clear();
        if(typeof renderGeometry3D==='function') renderGeometry3D();
        if(typeof renderFinalPass==='function') renderFinalPass(false);
        console.log("[Wire] Undone.");
    };
})();
