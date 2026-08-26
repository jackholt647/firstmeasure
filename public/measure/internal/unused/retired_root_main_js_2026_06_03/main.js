/* main.js - Central Control & State */

const GOOGLE_API_KEY = 'REMOVED_CREDENTIAL';
const GEMINI_API_KEY = 'REMOVED_CREDENTIAL';
const RADIUS_METERS = 20;
const GEOMETRY_PROMPT = `
    Remove the background and surrounding trees etc, leaving just the roof of the house against a white background. 
    Draw thin red lines on the eaves, rakes, valleys, hips, and ridges. Leave the different facets white. 
    Make sure to use the same line thickness for every line, regardless of whether it is an eave, valley, hip, ridge, skylight etc, and never use double lines for anything. 
    Outline skylights and chimneys with points on their corners but don't bother marking any other roof details like pipes etc. 
    Put very small blue dots on all of the corners, and joins. If there are parts of the house obscured by tree cover, use your best guess to fill in underneath.
`;

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

function firstMeasureApiBaseUrl() {
    const fromGlobal = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/+$/, '');
    if (fromGlobal) return fromGlobal;
    const fromPortal = String(window.PORTAL_CFG?.endpoints?.firstmeasure || '').replace(/\/+$/, '');
    if (fromPortal) return fromPortal;
    return 'http://127.0.0.1:3111/v1/firstmeasure';
}

function firstMeasureActorPayload() {
    const appUser = window.__APP?.user || {};
    const portalUser = window.PORTAL_CFG?.user || {};
    const actor = window.FIRSTMEASURE_ACTOR || {};
    return {
        email: String(actor.email || appUser.email || portalUser.email || sessionStorage.getItem('userEmail') || ''),
        name: String(actor.name || appUser.name || portalUser.name || ''),
        role: String(actor.role || appUser.role || portalUser.role || '')
    };
}

async function firstMeasureFetchJson(path, options = {}) {
    const res = await fetch(`${firstMeasureApiBaseUrl()}${path}`, options);
    const text = await res.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch (e) {
        throw new Error(`FirstMeasure API returned invalid JSON (${res.status}).`);
    }
    if (!res.ok || data.success === false || data.ok === false) {
        throw new Error(data.message || data.error || `FirstMeasure API request failed (${res.status}).`);
    }
    return data;
}

async function firstMeasureEnsureProjectForLegacyForm(formData) {
    const folder = String(formData.get('folder') || window.currentProjectId || '').trim();
    if (folder) return folder;

    const address = String(formData.get('address') || document.getElementById('addressInput')?.value || '').trim();
    if (!address) throw new Error('A project address is required.');

    const created = await firstMeasureFetchJson('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            address,
            issuer: { name: String(formData.get('issuerName') || firstMeasureActorPayload().name || 'System User') }
        })
    });
    const projectId = String(created.project?.manifest?.id || '').trim();
    if (!projectId) throw new Error('Project was created, but no project id was returned.');
    window.currentProjectId = projectId;
    return projectId;
}

async function firstMeasureLegacyProjectRequest(formData) {
    const action = String(formData.get('action') || '').trim();

    if (action === 'get_apple_key_info') {
        const data = await firstMeasureFetchJson('/apple-key', { method: 'GET' });
        return { success: true, ...(data.value || {}) };
    }

    if (action === 'check') {
        const data = await firstMeasureFetchJson('/projects/find-by-address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: String(formData.get('address') || '') })
        });
        return { success: true, exists: !!data.exists, folder: data.folder, manifest: data.manifest };
    }

    if (action === 'create') {
        const created = await firstMeasureFetchJson('/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                address: String(formData.get('address') || ''),
                issuer: { name: String(formData.get('issuerName') || firstMeasureActorPayload().name || 'System User') }
            })
        });
        const folder = String(created.project?.manifest?.id || '').trim();
        if (folder) window.currentProjectId = folder;
        return { success: true, folder, project: created.project };
    }

    if (action === 'load') {
        const folder = String(formData.get('folder') || '').trim();
        if (!folder) throw new Error('Missing project id.');
        return await firstMeasureFetchJson(`/projects/${encodeURIComponent(folder)}/editor`, { method: 'GET' });
    }

    if (action === 'save') {
        const projectId = await firstMeasureEnsureProjectForLegacyForm(formData);
        const upload = new FormData();
        const metadata = formData.get('metadata');
        if (metadata != null) upload.append('metadata', metadata);
        for (const [key, value] of formData.entries()) {
            if (value instanceof Blob && key !== 'image_file') {
                upload.append(key, value, value.name || `${key}.png`);
            }
        }
        await firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/editor/save`, {
            method: 'POST',
            body: upload
        });
        return { success: true, folder: projectId };
    }

    if (action === 'save_image') {
        const projectId = await firstMeasureEnsureProjectForLegacyForm(formData);
        const image = formData.get('image_file');
        if (!(image instanceof Blob)) throw new Error('Missing image file.');
        const filename = String(formData.get('filename') || image.name || 'image').replace(/\.(png|jpg|jpeg|webp)$/i, '');
        const upload = new FormData();
        upload.append('file', image, `${filename}.png`);
        await firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/artifacts`, {
            method: 'POST',
            body: upload
        });
        return { success: true, folder: projectId };
    }

    if (action === 'fetch_mask') {
        const projectId = String(formData.get('folder') || window.currentProjectId || '').trim();
        if (!projectId) throw new Error('Missing project id.');
        const data = await firstMeasureFetchJson(`/projects/${encodeURIComponent(projectId)}/mask/ensure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        return { success: true, url: data.url, already: data.already };
    }

    if (action === 'next_queue') {
        const actor = firstMeasureActorPayload();
        const data = await firstMeasureFetchJson('/queue/claim-next/compat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actor, actor_email: actor.email, exclude: String(formData.get('exclude') || '') })
        });
        return { success: true, found: !!data.found, folder: data.folder, address: data.address, source: data.source };
    }

    throw new Error(`Unsupported FirstMeasure action: ${action}`);
}

async function firstMeasureLegacyProjectResponse(formData) {
    return new Response(JSON.stringify(await firstMeasureLegacyProjectRequest(formData)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

/* main.js - Scaling & Offset Configuration */

// Configuration for aligning base layers to the Solar Heightmap
const LAYER_CONFIG = {
    'solar':  { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 },
    // 'google': { scale: 0.8, x: 9, y:-26, rot: 0, fineScale: 1.0 },
    'google': { scale: 0.8, x: 0, y:0, rot: 0, fineScale: 1.0 },
    'azure':  { scale: 2.0, x: 0, y: 0, rot: 0, fineScale: 1.0 },
    
    'apple':  { scale: 1.13, x: 0, y: 0, rot: 0, fineScale: 1.0 }, 
    
    'height': { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 }
};

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

// --- Solar Roof Mask (from Solar API maskUrl) ---
let roofMaskEnabled = false;      // default ON (toggle in toolbar)
let roofMaskData = null;         // Uint8Array / TypedArray length = imageWidth*imageHeight
let maskedViewCanvases = {};     // viewId -> { canvas, stamp }

let isAdjustingLocation = false;
let adjustState = { lat: 0, lng: 0, radius: 20 };

let isSplatMode = false;

window.KB_MAP = {
    // Clipboard
    COPY:          { key: 'c', ctrl: true },
    PASTE:         { key: 'v', ctrl: true },
    UNDO:          { key: 'z', ctrl: true },
    REDO:          { key: 'y', ctrl: true },

    // Tools (Single keys)
    ROTATE:        { key: 'r' },
    QUAD:          { key: 'q', optionalAlt: true },
    FLIP:          { key: 't' },
    RESIZE:        { key: 'y' }, // Note: Distinguishes from REDO via 'ctrl: false' implicitly
    MOVE:          { key: 'm' },
    NEW_POINT:     { key: 'n', optionalAlt: true },
    
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
    
    const makeSeparator = () => `<div class="separator"></div>`;

    let html = '';

    // General
    html += makeGroup(k.TAB, 'Mode', 'Cycle Selection Mode');
    html += makeGroup(k.UNDO, 'Undo', 'Undo Action');
    html += makeGroup(k.REDO, 'Redo', 'Redo Action');
    html += makeGroup(k.COPY, 'Copy', 'Copy Selection');
    html += makeGroup(k.PASTE, 'Paste', 'Paste Selection');
    html += makeGroup(k.ESC, 'Cancel', 'Cancel Action');

    html += makeSeparator();

    // Toggles
    html += makeGroup(k.IMAGE, 'Images', 'Toggle Image Layer');
    html += makeGroup(k.MEASURE, 'Measure', 'Toggle Measurements');
    html += makeGroup(k.FACES, 'Faces', 'Toggle Generated Faces');
    html += makeGroup(k.TYPES, 'Types', 'Toggle Line Types');
    html += makeGroup(k.SNAP, 'Snap', 'Toggle Snapping');

    html += makeSeparator();

    // Manipulation
    html += makeGroup(k.ROTATE, 'Rotate', 'Rotate Selection');
    html += makeGroup(k.MOVE, 'Move', 'Move Selection');
    html += makeGroup(k.FLIP, 'Flip', 'Flip Selection');
    html += `
        <div class="shortcut-group" title="Nudge selection">
            <span class="key-badge">WASD</span> Nudge
        </div>`; // WASD is handled specially in logic, keeping hardcoded display

    // Geometry
    html += makeGroup(k.CREATE_FACE, 'Form Face', 'Create Face from Loop');
    html += makeGroup(k.CONNECT, 'Connect', 'Connect Points');
    html += makeGroup(k.PARALLEL, 'Parallel', 'Make Lines Parallel');
    html += makeGroup(k.FLATTEN, 'Flatten', 'Flatten Height (3D)');
    html += makeGroup(k.NEW_POINT, 'New Pt', 'New Connected Point');
    html += makeGroup(k.QUAD, 'Quad', 'Create Quadrilateral');
    html += makeCustomGroup('Alt+Final', 'Level Quad', 'Hold Alt on the final quad click to place new points at the source point height');
    html += makeGroup(k.DELETE, 'Delete', 'Delete Selection');

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
    }

    initCesium(); 
    console.log("Maps & Cesium Ready");
}

// --- NEW FUNCTION TO HANDLE TOP RIGHT ADDRESS BAR ---
function initHeaderAutocomplete() {
    const input = document.getElementById("manualAddress");
    if (!input) return;

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
        } else {
            console.log("AI Preprocessing skipped. User building from scratch.");
            // Optional: Alert the user or update the UI
            document.getElementById('zoom-layer').innerHTML = ''; // Clear loading message
            redrawCanvas(); // Show the satellite image so they can draw
            
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
    const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=HIGH&key=${GOOGLE_API_KEY}`;
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

async function fetchAllLayers(lat, lng) {
    const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radius_meters=${RADIUS_METERS}&view=FULL_LAYERS&requiredQuality=HIGH&key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const fetchTiff = async (url) => {
        const r = await fetch(url + `&key=${GOOGLE_API_KEY}`);
        const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
        const img = await tiff.getImage();
        if (imageWidth === 0) {
            imageWidth = img.getWidth();
            imageHeight = img.getHeight();
        }
        return await img.readRasters();
    };

    const promises = [];
    if (data.rgbUrl)  promises.push(fetchTiff(data.rgbUrl).then(r => layerData.rgb = r));
    if (data.dsmUrl)  promises.push(fetchTiff(data.dsmUrl).then(r => layerData.dsm = r));
    if (data.maskUrl) promises.push(fetchTiff(data.maskUrl).then(r => layerData.mask = r)); // <-- NEW
    await Promise.all(promises);

    // Restore roof mask data (for 2D masking + isMaskedPixel)
    if (layerData.mask && layerData.mask[0]) {
        roofMaskData = layerData.mask[0];
        console.log("[RoofMask] Restored roof mask from saved project:", roofMaskData.length, "px");
    } else {
        roofMaskData = null;
        console.warn("[RoofMask] No saved mask raster found/loaded.");
    }

    // invalidate masked cache so redraw uses the mask immediately
    maskedViewCanvases = {};
    redrawCanvas();
}


async function fetchStaticMap(lat, lng) {
    const gUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=600x600&maptype=satellite&key=${GOOGLE_API_KEY}`;
    return new Promise(r => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = r;
        img.src = gUrl;
        layerData.google = img;
        applyStaticRoundingCorrectionToLayer('google', lat, lng, 20, 1);
        delete viewCanvases.google;
        rebuildBaseViewCanvas('google');
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    const body = {
        contents: [{
            parts: [
                { text: promptText },
                { inline_data: { mime_type: "image/png", data: base64Image } }
            ]
        }]
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        console.error('Gemini call failed', await res.text());
        return null;
    }
    const data = await res.json();
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) return null;

    const parts = data.candidates[0].content.parts || [];
    for (const part of parts) {
        const inline = part.inlineData || part.inline_data;
        if (inline && inline.data) return inline.data;
    }
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

    const cfg = ensureLayerCfg('google');
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

    const cfg = ensureLayerCfg('azure');
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

    const cfg = ensureLayerCfg('apple');
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

        const src = ensureViewCanvas(cfg.id);
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


/* main.js */

async function getAppleAccessKey() {
    // 1) local cache
    let key = localStorage.getItem('apple_maps_key');
    if (key) return key;

    // 2) server
    try {
        const fd = new FormData();
        fd.append('action', 'get_apple_key_info'); // <-- IMPORTANT

        const data = await firstMeasureLegacyProjectRequest(fd);

        if (data && data.success && data.key) {
            localStorage.setItem('apple_maps_key', data.key);
            // optional: cache timestamp too
            if (data.updated_at_utc) localStorage.setItem('apple_maps_key_updated_at_utc', data.updated_at_utc);
            return data.key;
        }
    } catch (e) {
        console.warn('[AppleMaps] Server key fetch failed', e);
    }

    // 3) fallback prompt
    key = prompt("Apple Maps key not found on server. Enter manually:");
    if (key) {
        localStorage.setItem('apple_maps_key', key);
        return key;
    }
    return null;
}


async function handleAppleLayerFetch() {
  // 1. Get Access Key (Check LocalStorage first)
  const accessKey = await getAppleAccessKey();

  // If user hits "Cancel" on the prompt, accessKey is null.
  if (!accessKey) {
    selectView('solar');
    return;
  }

  // --- NEW: Ensure we have a valid center before calling tile stitcher ---
  const hasCenter =
    Number.isFinite(parseFloat(mapCenterLat)) &&
    Number.isFinite(parseFloat(mapCenterLng));

  if (!hasCenter) {
    // Try to recover from address (manifest might not have lat/lng yet)
    const addr =
      (document.getElementById('manualAddress')?.value || '').trim() ||
      (document.getElementById('addressInput')?.value || '').trim();

    if (addr && geocoder && typeof geocoder.geocode === 'function') {
      await new Promise((resolve) => {
        geocoder.geocode({ address: addr }, (results, status) => {
          if (status === 'OK' && results?.[0]?.geometry?.location) {
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

  // Final hard stop if still missing
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
    '<div style="padding:50px; text-align:center; color: #1a73e8;">Fetching Apple Maps Tiles...</div>';

  try {
    // 2. Call the fetcher from maps.js
    const result = await fetchStitchedAppleTile(lat0, lng0, 3, 22, accessKey);
    if (!result || !result.canvas) throw new Error("Stitching returned null.");

    const stitchedCanvas = result.canvas;
    const autoOffsetX = result.offX;
    const autoOffsetY = result.offY;

    // 3. Save Raw to Server
    if (window.currentProjectId) {
      console.log("[AppleMaps] Uploading raw asset to server...");
      const rawBlob = await new Promise((r) => stitchedCanvas.toBlob(r, "image/png"));
      const fd = new FormData();
      fd.append("action", "save_image");
      fd.append("folder", window.currentProjectId);
      fd.append("filename", "apple");
      fd.append("image_file", rawBlob, "apple.png");

      await firstMeasureLegacyProjectRequest(fd).catch(() => {
        console.warn("Failed to save raw apple map to server");
      });
    }

    // 4. Update Layer Config
    const currentScale =
      (LAYER_CONFIG["apple"] && LAYER_CONFIG["apple"].scale)
        ? LAYER_CONFIG["apple"].scale
        : 1.15;

    LAYER_CONFIG["apple"] = {
      scale: currentScale,
      x: autoOffsetX,
      y: autoOffsetY
    };

    // 5. Process for Local View
    const projectCanvas = document.createElement("canvas");
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext("2d");

    const cfg = LAYER_CONFIG["apple"];
    drawScaledImage(ctx, stitchedCanvas, imageWidth, imageHeight, cfg.scale, cfg.x, cfg.y);

    // 6. Cache in Memory
    const rawImg = new Image();
    rawImg.src = stitchedCanvas.toDataURL("image/png");
    await new Promise((r) => (rawImg.onload = r));
    layerData.apple = rawImg;

    viewCanvases["apple"] = projectCanvas;

    // 7. Restore View & Select
    zoomLayer.innerHTML = originalContent;
    setupView();
    selectView("apple");

    // 8. Save Project Metadata
    await window.saveProjectData(true, true);
  } catch (e) {
    console.error("[AppleMaps] Error:", e);
    zoomLayer.innerHTML = originalContent;
    setupView();

    if (e.message === "ACCESS_DENIED") {
      localStorage.removeItem("apple_maps_key");
      alert("Apple Maps Access Denied. The key may be invalid or expired.");
      selectView("solar");
    } else {
      alert("Failed to fetch Apple Maps layer. Check console.");
      selectView("solar");
    }
  }
}


async function handleGoogleLayerFetch() {
  const zoomLayer = document.getElementById('zoom-layer');
  const originalContent = zoomLayer.innerHTML;
  zoomLayer.innerHTML = '<div style="padding:50px;text-align:center;color:#1a73e8;">Fetching Google Tiles...</div>';

  try {
    // Tune these
    const tileRadius = 3; // 7x7
    const zoom = 21;      // match your static zoom intent

    const result = await fetchStitchedGoogleTile(mapCenterLat, mapCenterLng, tileRadius, zoom, GOOGLE_API_KEY);
    if (!result || !result.canvas) throw new Error("Stitching returned null.");

    const stitchedCanvas = result.canvas;

    // Save raw to server (google.png)
    if (window.currentProjectId) {
      const rawBlob = await new Promise(r => stitchedCanvas.toBlob(r, 'image/png'));
      const fd = new FormData();
      fd.append('action', 'save_image');
      fd.append('folder', window.currentProjectId);
      fd.append('filename', 'google'); // saves as google.png
      fd.append('image_file', rawBlob, 'google.png');
      await firstMeasureLegacyProjectRequest(fd);
    }

    // Set config offsets (scale stays 1 unless you intentionally want extra zoom)
    const currentScale = (LAYER_CONFIG.google && LAYER_CONFIG.google.scale) ? LAYER_CONFIG.google.scale : 1.0;
    LAYER_CONFIG.google = { scale: currentScale, x: result.offX, y: result.offY };

    // Bake into view canvas
    const projectCanvas = document.createElement('canvas');
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext('2d');
    drawScaledImage(ctx, stitchedCanvas, imageWidth, imageHeight, LAYER_CONFIG.google.scale, LAYER_CONFIG.google.x, LAYER_CONFIG.google.y);

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
    const zoom = 20;

    // your existing azure key
    const AZURE_KEY = String(window.FIRSTMEASURE_AZURE_MAPS_KEY || '').trim();
    if (!AZURE_KEY) throw new Error("Azure Maps is not configured.");

    const result = await fetchStitchedAzureTile(mapCenterLat, mapCenterLng, tileRadius, zoom, AZURE_KEY);
    if (!result || !result.canvas) throw new Error("Stitching returned null.");

    const stitchedCanvas = result.canvas;

    // Save raw to server (azure.png)
    if (window.currentProjectId) {
      const rawBlob = await new Promise(r => stitchedCanvas.toBlob(r, 'image/png'));
      const fd = new FormData();
      fd.append('action', 'save_image');
      fd.append('folder', window.currentProjectId);
      fd.append('filename', 'azure');
      fd.append('image_file', rawBlob, 'azure.png');
      await firstMeasureLegacyProjectRequest(fd);
    }

    const currentScale = (LAYER_CONFIG.azure && LAYER_CONFIG.azure.scale) ? LAYER_CONFIG.azure.scale : 1.0;
    LAYER_CONFIG.azure = { scale: currentScale, x: result.offX, y: result.offY };

    const projectCanvas = document.createElement('canvas');
    projectCanvas.width = imageWidth;
    projectCanvas.height = imageHeight;
    const ctx = projectCanvas.getContext('2d');
    drawScaledImage(ctx, stitchedCanvas, imageWidth, imageHeight, LAYER_CONFIG.azure.scale, LAYER_CONFIG.azure.x, LAYER_CONFIG.azure.y);

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
    alert("Failed to fetch Azure tile layer. Check console.");
    selectView('solar');
  }
}





function selectView(viewId) {
  if (viewId === 'apple') {
    if (!viewCanvases.apple && !layerData.apple) { handleAppleLayerFetch(); return; }
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
    const mPerPx = (RADIUS_METERS * 2) / imageWidth;
    const mLat = 111132;
    const mLng = 111132 * Math.cos(mapCenterLat * (Math.PI/180));

    segmentStats.forEach((seg, i) => {
        const dLat = (seg.center.latitude - mapCenterLat) * mLat;
        const dLng = (seg.center.longitude - mapCenterLng) * mLng;
        
        const x = (imageWidth/2) + (dLng/mPerPx);
        const y = (imageHeight/2) - (dLat/mPerPx);
        
        const el = document.createElement('div');
        el.className = 'marker';
        el.innerText = i+1;
        el.style.left = x+'px';
        el.style.top = y+'px';
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
});



window.addEventListener('load', () => {
    const helpBtn = document.getElementById('btnToggleHelp');
    
    if (helpBtn && helpBtn.parentNode) {
        // 1. Config Report Button
        const configBtn = document.createElement('button');
        configBtn.className = 'toolbar-btn';
        configBtn.innerHTML = '<i class="fas fa-file-alt"></i> Config Report';
        configBtn.onclick = handleConfigureReport;
        configBtn.title = "Configure Report Data before PDF";

        // 2. Save Button
        const saveBtn = document.createElement('button');
        saveBtn.id = 'global-save-btn'; // <--- ADDED ID HERE
        saveBtn.className = 'toolbar-btn';
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save';
        saveBtn.title = "Save Project Data (Ctrl+S)";
        saveBtn.style.marginRight = "10px";

        // Animated Click Handler
        saveBtn.onclick = async function() {
            const originalContent = '<i class="fas fa-save"></i> Save';
            
            // Loading State
            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...';
            this.style.width = this.offsetWidth + 'px'; 
            this.disabled = true;
            this.style.cursor = 'wait';
            this.style.opacity = '0.8';

            try {
                // Perform Save (Silent Mode)
                const success = await window.saveProjectData(true);

                if (success) {
                    // Success State
                    this.innerHTML = '<i class="fas fa-check"></i> Saved!';
                    this.style.borderColor = '#2e7d32';
                    this.style.color = '#2e7d32';
                    this.style.backgroundColor = '#e8f5e9';
                } else {
                    throw new Error("Save failed");
                }
            } catch (e) {
                // Error State
                this.innerHTML = '<i class="fas fa-times"></i> Error';
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
        const formData = new FormData();
        formData.append('action', 'check');
        formData.append('address', address);

        const data = await firstMeasureLegacyProjectRequest(formData);

        if (data.exists) {
            console.log("Project found, loading from server...");
            loadProjectFromFolder(data.folder);
        } else {
            console.log("Project not found, ordering report (creating on server)...");
            zoomLayer.innerHTML = '<div style="padding:50px; text-align:center;">Ordering Report & Fetching Data...</div>';
            
            // Trigger Creation
            const createData = new FormData();
            createData.append('action', 'create');
            createData.append('address', address);
            // Add dummy or user input issuer data here if available in UI
            createData.append('issuerName', 'System User'); 
            
            const createResult = await firstMeasureLegacyProjectRequest(createData);
            
            if (createResult.success) {
                // Now load the newly created project
                loadProjectFromFolder(createResult.folder);
            } else {
                throw new Error(createResult.error || "Failed to create project");
            }
        }
    } catch (e) {
        console.error("Server operation failed", e);
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

window.saveProjectData = async function(isSilent = false, runInBackground = false) {
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

        const geometrySimple = geoSnapshot ? {
            points: geoPoints.map(p => ({ 
                x: p.x, y: p.y, z: p.z, layer: (p.layer || 1), zLocked: p.zLocked 
            })),
            connections: geoConnections.map(c => ({
                startIdx: geoPoints.indexOf(c.start),
                endIdx: geoPoints.indexOf(c.end),
                type: c.type 
            })).filter(c => c.startIdx >= 0 && c.endIdx >= 0),
            vents: geoSnapshot.vents || [],
            manualFaces: (geoSnapshot.manualFaces || []).map(face => ({
                layer: face.layer || 1,
                pointIndices: (face.points || []).map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0),
                holeIndices: (face.holes || []).map(holePoly => 
                    holePoly.map(pt => geoPoints.indexOf(pt)).filter(idx => idx >= 0)
                )
            })).filter(face => Array.isArray(face.pointIndices) && face.pointIndices.length >= 3),
            deletedFaceSignatures: (typeof deletedFaceSignatures !== 'undefined') 
                ? Array.from(deletedFaceSignatures) 
                : []
        } : null;

        let configToSave = null;
        if (typeof reportConfigState !== 'undefined' && reportConfigState) {
            configToSave = {
                customLabels: reportConfigState.customLabels,
                manualWastePct: reportConfigState.manualWastePct,
                manualTotalFacets: reportConfigState.manualTotalFacets,
                manualLayerFacets: reportConfigState.manualLayerFacets,
                ventSettings: reportConfigState.ventSettings,
                structureSettings: reportConfigState.structureSettings
            };
        } else if (typeof window.loadedPdfConfig !== 'undefined' && window.loadedPdfConfig) {
            configToSave = window.loadedPdfConfig;
        }

        const metadata = {
            imageWidth, imageHeight,
            viewConfigs, currentViewId,
            geminiPrompt: document.getElementById('geminiPrompt').value,
            geometry: geometrySimple,
            hasQuadCrop: !!window.quadViewCroppedImage,
            viewRotation: viewRotation || 0,
            pdfConfig: configToSave,
            layer_config: LAYER_CONFIG
        };

        const formData = new FormData();
        formData.append('action', 'save');
        formData.append('address', address);
        if (window.currentProjectId) formData.append('folder', window.currentProjectId);
        formData.append('metadata', JSON.stringify(metadata));

        // --- STEP 2: ATTACH IMAGES ---
        const blobPromises = [];
        
        // LIST OF LAYERS TO *NOT* OVERWRITE ON SERVER
        // We want the server to keep the raw, unscaled versions of these.
        const protectedLayers = ['solar', 'google', 'azure', 'apple', 'height'];

        for (const [viewId, canvas] of Object.entries(viewCanvases)) {
            // SKIP protected layers so we don't bake in the zoom/offset
            if (protectedLayers.includes(viewId)) continue;

            const p = new Promise(resolve => {
                canvas.toBlob((blob) => {
                    if (blob) formData.append(viewId, blob, viewId + '.png');
                    resolve();
                }, 'image/png');
            });
            blobPromises.push(p);
        }
        await Promise.all(blobPromises);

        const mainSaveRes = await firstMeasureLegacyProjectRequest(formData);
        
        if (!mainSaveRes.success) throw new Error(mainSaveRes.error || "Save failed");

        if (window.quadViewCroppedImage) {
            const quadFormData = new FormData();
            quadFormData.append('action', 'save_image'); 
            quadFormData.append('address', address);
            if (window.currentProjectId) quadFormData.append('folder', window.currentProjectId);
            quadFormData.append('filename', 'quad_crop'); 
            const quadBlob = dataURItoBlob(window.quadViewCroppedImage);
            quadFormData.append('image_file', quadBlob, 'quad_crop.png');
            await firstMeasureLegacyProjectRequest(quadFormData);
        }

        if (!isSilent) alert("Project saved! Folder: " + mainSaveRes.folder);
        console.log("✅ Project Saved. ID:", mainSaveRes.folder);
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


async function loadProjectFromFolder(folderHash) {
    resetLayerVisibility();

    if (typeof exitMeasurementMode === 'function') {
        exitMeasurementMode();
    }
    
    window.currentProjectId = folderHash;
    window.quadViewCroppedImage = null;
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
        // --- 2. FETCH PROJECT DATA ---
        const formData = new FormData();
        formData.append('action', 'load');
        formData.append('folder', folderHash);

        const data = await firstMeasureLegacyProjectRequest(formData);
        const manifest = data.manifest;

        // --- FIX: New projects may have no manifest.lat/lng yet (server geocode happens after response) ---
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


        const assets = data.assets; 
        const insights = data.insights;

        console.log("Loaded Data:", data);

        if (manifest.address) setHeaderAddress(manifest.address);

        const meta = manifest.app_metadata || {};

        // ✅ RESTORE saved layer alignment config (Apple offsets, etc.)
        if (meta.layer_config && typeof meta.layer_config === 'object') {
            // merge keys safely so you keep defaults for anything missing
            Object.keys(meta.layer_config).forEach(k => {
                const v = meta.layer_config[k];
                if (!v || typeof v !== 'object') return;
                if (!LAYER_CONFIG[k]) LAYER_CONFIG[k] = { scale: 1.0, x: 0, y: 0 };

                // only accept finite numbers
                if (Number.isFinite(v.scale)) LAYER_CONFIG[k].scale = v.scale;
                if (Number.isFinite(v.x))     LAYER_CONFIG[k].x     = v.x;
                if (Number.isFinite(v.y))     LAYER_CONFIG[k].y     = v.y;

                if (Number.isFinite(v.rot))       LAYER_CONFIG[k].rot = v.rot;
                if (Number.isFinite(v.fineScale)) LAYER_CONFIG[k].fineScale = v.fineScale;

            });

            console.log("[LayerConfig] Restored from project metadata:", JSON.parse(JSON.stringify(LAYER_CONFIG)));
        }


        if (typeof meta.viewRotation === 'number') viewRotation = meta.viewRotation;
        if (meta.pdfConfig) window.loadedPdfConfig = meta.pdfConfig;
        if (assets['quad_crop']) {
            fetch(assets['quad_crop']).then(r=>r.blob()).then(blob=>{
                const reader=new FileReader(); reader.onloadend=()=>{ window.quadViewCroppedImage=reader.result; const s4=document.getElementById('step4'); if(s4) s4.classList.add('done'); }; reader.readAsDataURL(blob);
            });
        }

        mapCenterLat = manifest.lat;
        mapCenterLng = manifest.lng;
        
        // --- 5. HANDLE ASSETS ---
        viewCanvases = {};
        layerData = { rgb: null, mask: null, dsm: null, google: null, azure: null, apple: null };

        // Fallback for missing RGB
        if (!assets['rgb']) {
            if (assets['google']) {
                await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = "Anonymous";
                    img.onload = () => {
                        imageWidth = img.width;
                        imageHeight = img.height;
                        layerData.google = img;
                        const c = document.createElement('canvas');
                        c.width = imageWidth; c.height = imageHeight;
                        const ctx = c.getContext('2d');
                        
                        // Always apply config scale
                        const cfg = LAYER_CONFIG['google'] || { scale: 1.0, x: 0, y: 0 };
                        drawScaledImage(ctx, img, imageWidth, imageHeight, cfg.scale, cfg.x, cfg.y);
                        
                        viewCanvases['google'] = c;
                        viewCanvases['solar'] = c; 
                        resolve();
                    };
                    img.onerror = () => reject(new Error("Static map fallback failed."));
                    img.src = assets['google'] + '?t=' + Date.now();
                });
            } else {
                document.getElementById('zoom-layer').innerHTML = '<div style="padding:50px;">Processing incomplete.</div>';
                return;
            }
        }

        if (insights && insights.solarPotential) {
            segmentStats = insights.solarPotential.roofSegmentStats;
            renderTable();
            if(insights.solarPotential.center) {
                mapCenterLat = insights.solarPotential.center.latitude;
                mapCenterLng = insights.solarPotential.center.longitude;
            }
        }

        if (meta.imageWidth && imageWidth === 0) {
            imageWidth = meta.imageWidth;
            imageHeight = meta.imageHeight;
        }

        // --- 6. LOAD LAYERS (TIFFs) ---
        const tiffPromises = [];
        if (assets['rgb']) tiffPromises.push(fetch(assets['rgb']).then(r=>r.arrayBuffer()).then(b=>GeoTIFF.fromArrayBuffer(b)).then(t=>t.getImage()).then(img=>{imageWidth=img.getWidth();imageHeight=img.getHeight();return img.readRasters();}).then(r=>layerData.rgb=r));
        if (assets['dsm']) tiffPromises.push(fetch(assets['dsm']).then(r=>r.arrayBuffer()).then(b=>GeoTIFF.fromArrayBuffer(b)).then(t=>t.getImage()).then(i=>i.readRasters()).then(r=>layerData.dsm=r));
        if (assets['mask']) tiffPromises.push(fetch(assets['mask']).then(r=>r.arrayBuffer()).then(b=>GeoTIFF.fromArrayBuffer(b)).then(t=>t.getImage()).then(img=>img.readRasters()).then(r=>{layerData.mask=r;}));
        await Promise.all(tiffPromises);

        if ((!assets['mask']) && (insights && insights.solarPotential)) await fetchAndAttachProjectMask(folderHash);
        if (layerData.mask && layerData.mask[0]) roofMaskData = layerData.mask[0]; else roofMaskData = null;

        maskedViewCanvases = {};

        // --- 7. LOAD VIEW CANVASES (PNGs) ---
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
                    
                    // ALWAYS SCALE. The server holds raw assets now.
                    let cfg = LAYER_CONFIG[key] || { scale: 1.0, x: 0, y: 0 };
                    drawScaledImage(ctx, img, imageWidth, imageHeight, cfg.scale, cfg.x, cfg.y);
                    
                    if(key === 'google') layerData.google = img;
                    if(key === 'azure')  layerData.azure = img;
                    if(key === 'apple')  layerData.apple = img;

                    viewCanvases[key] = c;
                    resolve();
                };
                img.onerror = resolve; 
                img.src = url + '?t=' + Date.now(); 
            });
            imgPromises.push(p);
        }
        await Promise.all(imgPromises);

        // --- 8. RESTORE GEOMETRY ---
        let geometryWasRestored = false;
        if (meta.geometry && Array.isArray(meta.geometry.points)) {
            const pts = meta.geometry.points.map(p => ({ x:p.x, y:p.y, z:p.z, layer:(p.layer||1), zLocked:!!p.zLocked, zVotes:[] }));
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
            const conns = Array.isArray(meta.geometry.connections)
                ? meta.geometry.connections.map(c => {
                    const startIdx = Number.isInteger(c.startIdx) ? c.startIdx : pointIndexFromRef(c.start);
                    const endIdx = Number.isInteger(c.endIdx) ? c.endIdx : pointIndexFromRef(c.end);
                    const start = pts[startIdx];
                    const end = pts[endIdx];
                    return start && end ? { start, end, type: c.type } : null;
                }).filter(Boolean)
                : [];
            let restoredManualFaces = [];
            if (Array.isArray(meta.geometry.manualFaces)) {
                restoredManualFaces = meta.geometry.manualFaces.map(mf => {
                    const facePoints = pointsFromRefs(mf.pointIndices, mf.points);
                    const holes = holesFromRefs(mf.holeIndices, mf.holes);
                    if (holes.length) return { layer: mf.layer, points: facePoints, holes };
                    return { layer: mf.layer, points: facePoints };
                }).filter(face => face.points.length >= 3);
            }
            if (typeof deletedFaceSignatures !== 'undefined') {
                deletedFaceSignatures.clear(); 
                if (meta.geometry.deletedFaceSignatures) meta.geometry.deletedFaceSignatures.forEach(sig => deletedFaceSignatures.add(sig));
            }
            activeGeometry = { points: pts, connections: conns, vents: meta.geometry.vents || [], manualFaces: restoredManualFaces };
            geometryWasRestored = true;
        } else {
            activeGeometry = { points: [], connections: [], vents: [] };
        }

        // --- 9. HANDLE AI GEOMETRY LAYER ---
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

        // --- 10. SYNTHESIZE MISSING DATA ---
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

        // --- 11. INITIALIZE VIEWS ---
        setupView();        
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
        switchMapLayer('google'); 
        if (cesiumViewer) cesiumViewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(mapCenterLng, mapCenterLat, 200) });

        if (activeGeometry) {
            if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
            if (typeof renderGeometry2D === 'function') renderGeometry2D();
        }
        if (typeof redrawCanvas === 'function') redrawCanvas();
        if (typeof renderGeometry2D === 'function') renderGeometry2D();
        
        console.log("Project loaded.");

    } catch (e) {
        console.error(e);
        alert("Load Error: " + e.message);
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
    if (showFacesLayer && typeof facesGroup !== 'undefined' && facesGroup && facesGroup.children.length === 0 && activeGeometry) {
        if (typeof processAndRenderAllLayers === 'function') processAndRenderAllLayers();
    }
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
        const formData = new FormData();
        formData.append('action', 'next_queue');
        
        // 2. Tell server to exclude this address from search
        if (currentAddr) {
            formData.append('exclude', currentAddr);
        }
        
        const data = await firstMeasureLegacyProjectRequest(formData);
        
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
        // A. BLOCK 'set_status' (So it stays in queue)
        if ((typeof input === 'string' && input.includes('/v1/firstmeasure/projects/') && input.includes('/status')) && 
            init && init.method === 'POST' && init.body instanceof FormData) {
            
            if (init.body.get('action') === 'set_status') {
                console.log("%c🛑 TEST MODE: Blocked 'set_status'.", "color: cyan; font-weight:bold;");
                return new Response(JSON.stringify({ success: true }), { status: 200 });
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
    const saveBtn = document.getElementById('global-save-btn');
    if (!saveBtn) return;

    const container = document.createElement('div');
    container.id = 'location-adjust-container';
    container.style.cssText = `display:inline-flex; align-items:center; position:relative; margin-right:10px;`;

    const triggerBtn = document.createElement('button');
    triggerBtn.className = 'toolbar-btn';
    triggerBtn.innerHTML = '<i class="fas fa-crosshairs"></i> Adjust View';
    triggerBtn.onclick = () => {
        const panel = document.getElementById('location-adjust-panel');
        const isOpen = panel.style.display === 'block';
        panel.style.display = isOpen ? 'none' : 'block';
        isAdjustingLocation = !isOpen;
        if (isAdjustingLocation) {
            adjustState.lat = mapCenterLat;
            adjustState.lng = mapCenterLng;
            adjustState.radius = RADIUS_METERS;
            // Set slider bounds relative to where we are now
            resetSliderBounds();
            updateLocationInputs();
        }
        renderGeometry2D();
    };

    const panel = document.createElement('div');
    panel.id = 'location-adjust-panel';
    panel.style.cssText = `
        position: absolute; top: 100%; left: 0; width: 260px; 
        background: white; border: 1px solid #ccc; border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2); padding: 12px; z-index: 3000;
        display: none; margin-top: 5px;
    `;

    panel.innerHTML = `
        <div style="font-size:11px; font-weight:bold; margin-bottom:12px; color:#d93025; display:flex; justify-content:space-between;">
            <span>RE-CENTER & ZOOM</span>
            <i class="fas fa-undo" title="Reset to Center" style="cursor:pointer; color:#888;" onclick="resetToCurrentCenter()"></i>
        </div>
        
        <!-- Latitude Control -->
        <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:10px; color:#666;">Latitude</label>
                <input type="number" id="adjLat" step="0.0000001" style="width:100px; font-size:11px; border:1px solid #ddd; border-radius:3px;">
            </div>
            <input type="range" id="adjLatSlider" step="0.000001" style="width:100%;">
        </div>

        <!-- Longitude Control -->
        <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:10px; color:#666;">Longitude</label>
                <input type="number" id="adjLng" step="0.0000001" style="width:100px; font-size:11px; border:1px solid #ddd; border-radius:3px;">
            </div>
            <input type="range" id="adjLngSlider" step="0.000001" style="width:100%;">
        </div>

        <!-- Zoom/Radius Control -->
        <div style="margin-bottom:15px; border-top:1px solid #eee; padding-top:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label style="font-size:10px; color:#666;">Fetch Radius (Zoom)</label>
                <span id="adjRadVal" style="font-size:10px; font-weight:bold; color:#1a73e8;">20m</span>
            </div>
            <input type="range" id="adjRad" min="10" max="50" step="1" style="width:100%;">
        </div>

        <button id="btnReloadSolar" class="toolbar-btn primary" style="width:100%; justify-content:center; padding:10px;">
            Regenerate Views
        </button>
    `;

    container.appendChild(triggerBtn);
    container.appendChild(panel);
    saveBtn.parentNode.insertBefore(container, saveBtn);

    // Grab elements
    const latInp = panel.querySelector('#adjLat');
    const latSld = panel.querySelector('#adjLatSlider');
    const lngInp = panel.querySelector('#adjLng');
    const lngSld = panel.querySelector('#adjLngSlider');
    const radInp = panel.querySelector('#adjRad');
    const radVal = panel.querySelector('#adjRadVal');

    // Sync Logic
    const onCoordChange = (source) => {
        if (source === 'latInp') latSld.value = latInp.value;
        if (source === 'latSld') latInp.value = latSld.value;
        if (source === 'lngInp') lngSld.value = lngInp.value;
        if (source === 'lngSld') lngInp.value = lngSld.value;

        adjustState.lat = parseFloat(latInp.value);
        adjustState.lng = parseFloat(lngInp.value);
        adjustState.radius = parseInt(radInp.value);
        radVal.innerText = adjustState.radius + 'm';
        renderGeometry2D();
    };

    latInp.oninput = () => onCoordChange('latInp');
    latSld.oninput = () => onCoordChange('latSld');
    lngInp.oninput = () => onCoordChange('lngInp');
    lngSld.oninput = () => onCoordChange('lngSld');
    radInp.oninput = () => onCoordChange();

    panel.querySelector('#btnReloadSolar').onclick = handleRegenerateFromNewCenter;
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
        // We do this while the OLD center and OLD imageWidth are still active
        const oldLat = parseFloat(mapCenterLat);
        const oldLng = parseFloat(mapCenterLng);
        const oldRad = parseFloat(window.RADIUS_METERS || 20);
        const oldW = imageWidth;
        const oldH = imageHeight;

        const mLat = 111132;
        const mLng = 111132 * Math.cos(oldLat * (Math.PI / 180));
        const oldMetersPerPx = (oldRad * 2) / oldW;

        // Temporarily store the geographical location on every point
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
        window.RADIUS_METERS = adjustState.radius;

        // --- STEP 3: FETCH NEW DATA ---
        // This will update the global 'imageWidth' and 'imageHeight' to the NEW TIFF sizes
        viewCanvases = {};
        // Reset imageWidth so the fetchTiff logic is forced to set it from the new file
        const prevW = imageWidth; 
        imageWidth = 0; 

        await fetchAllLayersWithRadius(mapCenterLat, mapCenterLng, window.RADIUS_METERS);
        await fetchStaticMap(mapCenterLat, mapCenterLng);

        // Ensure we actually got a width from the new TIFF
        if (imageWidth === 0) imageWidth = prevW; 

        // --- STEP 4: MAP LAT/LNG BACK TO NEW PIXEL SPACE ---
        // Now that imageWidth is definitively the NEW width
        const newMLng = 111132 * Math.cos(mapCenterLat * (Math.PI / 180));
        const newMetersPerPx = (window.RADIUS_METERS * 2) / imageWidth;

        const projectToNewPixels = (item) => {
            const newDx = (item.realLng - mapCenterLng) * newMLng;
            const newDy = (item.realLat - mapCenterLat) * mLat;
            item.x = (imageWidth / 2) + (newDx / newMetersPerPx);
            item.y = (imageHeight / 2) - (newDy / newMetersPerPx);
            // Clean up temp properties
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

        // Drop points onto new heightmap
        if (layerData.dsm) {
            optimizeElevationFromGeomery(activeGeometry, layerData.dsm[0], imageWidth, imageHeight);
        }

        isAdjustingLocation = false;
        document.getElementById('location-adjust-panel').style.display = 'none';
        if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();

    } catch (e) {
        console.error(e);
        alert("Regeneration failed: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Regenerate Views';
    }
}



// Custom version of fetchAllLayers that accepts radius
async function fetchAllLayersWithRadius(lat, lng, radius) {
    const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radius_meters=${radius}&view=FULL_LAYERS&requiredQuality=HIGH&key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const fetchTiff = async (url) => {
        const r = await fetch(url + `&key=${GOOGLE_API_KEY}`);
        const tiff = await GeoTIFF.fromArrayBuffer(await r.arrayBuffer());
        const img = await tiff.getImage();
        imageWidth = img.getWidth();
        imageHeight = img.getHeight();
        return await img.readRasters();
    };

    if (data.rgbUrl)  layerData.rgb  = await fetchTiff(data.rgbUrl);
    if (data.dsmUrl)  layerData.dsm  = await fetchTiff(data.dsmUrl);
    if (data.maskUrl) layerData.mask = await fetchTiff(data.maskUrl);

    if (layerData.mask && layerData.mask[0]) {
        roofMaskData = layerData.mask[0];
        console.log("[RoofMask] Loaded roof mask:", roofMaskData.length, "px");
    } else {
        roofMaskData = null;
        console.warn("[RoofMask] No maskUrl / mask raster returned.");
    }

    maskedViewCanvases = {};
}

async function ensureRoofMaskLoaded() {
    if (roofMaskData && roofMaskData.length === imageWidth * imageHeight) return true;
    if (!mapCenterLat || !mapCenterLng) return false;

    try {
        const rad = (window.RADIUS_METERS || RADIUS_METERS || 20);
        const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${mapCenterLat}&location.longitude=${mapCenterLng}&radius_meters=${rad}&view=FULL_LAYERS&requiredQuality=HIGH&key=${GOOGLE_API_KEY}`;
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
        const fd = new FormData();
        fd.append('action', 'fetch_mask');
        fd.append('folder', folderHash);

        const data = await firstMeasureLegacyProjectRequest(fd);
        if (!data || !data.success || !data.url) return false;

        const r = await fetch(data.url + '?t=' + Date.now());
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

function openGoogleEarth() {
    // 1. Get address from manual input (visible) or hidden input
    let address = document.getElementById('manualAddress') ? document.getElementById('manualAddress').value : '';
    if (!address) {
        address = document.getElementById('addressInput') ? document.getElementById('addressInput').value : '';
    }

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
    let address = document.getElementById('manualAddress') ? document.getElementById('manualAddress').value : '';
    if (!address) {
        address = document.getElementById('addressInput') ? document.getElementById('addressInput').value : '';
    }

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


function injectLayerAlignUI() {
  // prevent duplicates
  if (document.getElementById('layer-align-wrap')) return;

  // Find a good insertion point: right of the layer controls group
  const toolbarHost = document.getElementById('global-toolbar').querySelectorAll('.controls-group')[6]

  // Wrapper so button + panel stay together
  const wrap = document.createElement('div');
  wrap.id = 'layer-align-wrap';
  wrap.style.cssText = `
    display:inline-flex; align-items:center; position:relative; margin-left:8px;
  `;

  // Toggle button (top bar, right of layer controls)
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'btnToggleAlignUI';
  toggleBtn.className = 'toolbar-btn';
  toggleBtn.title = 'Toggle layer alignment controls (active view layer)';
  toggleBtn.innerHTML = '<i class="fas fa-sliders-h"></i> Align';

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

  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);

  toolbarHost.appendChild(wrap);

  const $ = (sel) => panel.querySelector(sel);

  const activeLbl = $('#alignActiveLayerLabel');
  const moveStepEl = $('#alignMoveStep');
  const rotStepEl  = $('#alignRotStep');
  const sclStepEl  = $('#alignScaleStep');
  const rotValEl   = $('#alignRotVal');
  const sclValEl   = $('#alignScaleVal');

  const setBtnStyle = (on) => {
    toggleBtn.classList.toggle('active', on);
    toggleBtn.style.background = on ? '#e8f0fe' : '#fff';
    toggleBtn.style.color = on ? '#1a73e8' : '#5f6368';
    toggleBtn.style.borderColor = on ? '#1a73e8' : '#ccc';
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

  const setOpen = (open) => {
    panel.style.display = open ? 'block' : 'none';
    setBtnStyle(open);
    if (open) refreshFieldsFromCfg();
  };

  // Toggle button
  toggleBtn.onclick = () => {
    const isOpen = panel.style.display === 'block';
    setOpen(!isOpen);
  };

  // Close on-bar
  $('#alignCloseBtn').onclick = () => setOpen(false);

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

  // Expose refresh hook
  window.__alignUIRefresh = () => {
    if (panel.style.display === 'block') refreshFieldsFromCfg();
  };

  // If user clicks outside, close
  document.addEventListener('mousedown', (e) => {
    if (panel.style.display !== 'block') return;
    if (!wrap.contains(e.target)) setOpen(false);
  });

  // Initial button style
  setBtnStyle(false);
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
        
        // Meters per pixel based on the fetched radius
        const metersPerPx = (window.RADIUS_METERS * 2) / imageWidth;

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
