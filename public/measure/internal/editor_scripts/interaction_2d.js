/* interaction_2d.js - 2D Interaction & SVG Rendering */
let ventPlacementCount = 0;
let faceUpdateTimer = null;
let deletedFaceSignatures = new Set(); 
let showImageLayer = true;
let showMeasurementsLayer = false;
let lastMouseX = 0, lastMouseY = 0;
let snapRingEl = null;
let selectionBoxScreenStart = { x: 0, y: 0 }; 
let quadState = null; 
let lastValidVentSnap = null
let newPointSourcePoint = null;
let geometryClipboard = null;
const GEOMETRY_CLIPBOARD_FORMAT = 'com.firstmeasure.geometry+json';
const GEOMETRY_CLIPBOARD_VERSION = 1;
try {
  const saved = localStorage.getItem('geometryClipboard');
  if (saved) geometryClipboard = normalizeGeometryClipboard(JSON.parse(saved));
} catch (e) {}
let rotationState = {
    center: { x: 0, y: 0 },
    startAngle: 0,
    originals: new Map() 
};
let resizeState = {
    center: { x: 0, y: 0 },
    startDist: 0,
    originals: new Map()
};
// ==========================================
// UNDERWALL MODE (offset-inward wall-follow)
// ==========================================
let underwallState = {
  active: false,
  startPoint: null,       // selected point
  startLayer: 1,
  startZ: 0,
  // cached perimeter edges (rake/eave only)
  perimeterConns: [],
  // owner face per conn (for inward normal choice)
  connOwnerFace: new Map(), // conn -> face
  // preview
  preview: {
    ok: false,
    d: 0,
    foot: null,     // {x,y} on boundary segment
    target: null,   // {x,y} offset point (=foot + inward*d)
    poly: [],       // offset poly points [{x,y},...]
    perp: null      // {a:{x,y}, b:{x,y}} from foot->target
  }
};
// --- Global State for Snap Guides ---
let activeSnapGuides = []; 
function triggerLiveUpdate() {
    const toggle = document.getElementById('showFacesToggle');
    const showFaces = toggle ? toggle.checked : true;
    if (faceUpdateTimer) clearTimeout(faceUpdateTimer);
    faceUpdateTimer = setTimeout(() => {
        const is3DReady = (typeof scene !== 'undefined' && scene !== null);
        // Always allow lightweight redraws
        if (is3DReady && window.renderGeometry3D) window.renderGeometry3D();
        if (window.renderGeometry2D) window.renderGeometry2D();
        // ✅ Only rerun heavy face pipeline if geometry actually changed
        // Geometry changes increment window.__geoMutStamp (see save2DState patch below)
        const mutStamp = (window.__geoMutStamp || 0);
        const lastStamp = (window.__facesLastRenderedStamp || 0);
        if (is3DReady && showFaces && window.updateVisualsOnly) {
            if (mutStamp !== lastStamp) {
                window.__facesLastRenderedStamp = mutStamp;
                window.updateVisualsOnly(); // (calls renderFinalPass(true))
            }
        }
    }, 50);
}
function setupView() {
    const container = document.getElementById('zoom-layer');
    const viewport = document.getElementById('viewport');
    
    container.innerHTML = '';
    container.style.width = imageWidth + 'px';
    container.style.height = imageHeight + 'px';
    const canvas = document.createElement('canvas');
    canvas.id = 'mainCanvas';
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    container.appendChild(canvas);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = 'geoSvg';
    svg.setAttribute('viewBox', `0 0 ${imageWidth} ${imageHeight}`);
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';
    container.appendChild(svg);
    let gridCanvas = document.getElementById('staticGridCanvas');
    if (gridCanvas) gridCanvas.remove(); 
    
    gridCanvas = document.createElement('canvas');
    gridCanvas.id = 'staticGridCanvas';
    Object.assign(gridCanvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '10' 
    });
    viewport.appendChild(gridCanvas);
    if (typeof createMarkers === 'function') createMarkers(container);
    
    const vW = viewport.clientWidth;
    const vH = viewport.clientHeight;
    const scaleX = vW / imageWidth;
    const scaleY = vH / imageHeight;
    let fitZoom = Math.min(scaleX, scaleY) * 0.95; 
    if (fitZoom < 0.1) fitZoom = 0.1;
    currentZoom = fitZoom;
    panX = (vW - (imageWidth * currentZoom)) / 2;
    panY = (vH - (imageHeight * currentZoom)) / 2;
    updateZoom();
    redrawCanvas(); 
    setup2DListeners();
}
function toggleImageDisplay() {
    showImageLayer = !showImageLayer;
    const btn = document.getElementById('btnToggleImage');
    if(btn) {
        btn.classList.toggle('active', showImageLayer);
        btn.style.background = showImageLayer ? '#e8f0fe' : '#fff';
        btn.style.color = showImageLayer ? '#1a73e8' : '#5f6368';
        btn.style.borderColor = showImageLayer ? '#1a73e8' : '#ccc';
    }
    redrawCanvas();
}
function toggleMeasurementDisplay() {
    showMeasurementsLayer = !showMeasurementsLayer;
    const btn = document.getElementById('btnToggleMeasure');
    if(btn) {
        btn.classList.toggle('active', showMeasurementsLayer);
        btn.style.background = showMeasurementsLayer ? '#e8f0fe' : '#fff';
        btn.style.color = showMeasurementsLayer ? '#1a73e8' : '#5f6368';
        btn.style.borderColor = showMeasurementsLayer ? '#1a73e8' : '#ccc';
    }
    renderGeometry2D();
}
function ensureSnapRing() {
    if (!snapRingEl) {
        snapRingEl = document.createElement('div');
        snapRingEl.id = 'snap-visual-ring';
        Object.assign(snapRingEl.style, {
            position: 'absolute', borderRadius: '50%',
            border: '1px dashed cyan', backgroundColor: 'rgba(0, 255, 255, 0.1)', 
            pointerEvents: 'none', zIndex: '1000', display: 'none',
            transform: 'translate(-50%, -50%)', boxSizing: 'border-box'
        });
        const vp = document.getElementById('viewport');
        if (vp) vp.appendChild(snapRingEl);
    }
    return snapRingEl;
}
function updateSnapRing(clientX, clientY, show = true) {
    const ring = ensureSnapRing();
    const vp = document.getElementById('viewport');
    if (!vp) return;
    
    if (show) {
        const rect = vp.getBoundingClientRect();
        const relX = clientX - rect.left;
        const relY = clientY - rect.top;
        const size = snapRadius * 2;
        ring.style.width = size + 'px';
        ring.style.height = size + 'px';
        ring.style.left = relX + 'px';
        ring.style.top = relY + 'px';
        ring.style.display = 'block';
    } else {
        ring.style.display = 'none';
    }
}
// --- QUADRILATERAL LOGIC ---
function enterQuadMode(options = {}) {
    if (!activeGeometry) return;
    const levelToSource = !!options.levelToSource;
    if (selectedPoints.size === 1) {
        const p1 = selectedPoints.values().next().value;
        quadState = {
            mode: 'SINGLE',
            phase: 1,
            origin: { x: p1.x, y: p1.y, layer: p1.layer || 1 },
            levelSourcePoint: levelToSource ? p1 : null,
            p1: p1,
            p2: { x: p1.x, y: p1.y }, 
            p3: null,
            p4: null
        };
        interactState = 'QUAD_CREATE';
        document.body.style.cursor = 'crosshair';
    } 
    else if (selectedPoints.size === 2) {
        const pts = Array.from(selectedPoints);
        quadState = {
            mode: 'DOUBLE',
            phase: 1,
            origin: null,
            levelSourcePoint: levelToSource ? pts[0] : null,
            p1: pts[0],
            p2: pts[1],
            p3: null, 
            p4: null  
        };
        interactState = 'QUAD_CREATE';
        document.body.style.cursor = 'crosshair';
    }
}
function handleQuadMove(mouseCoords) {
    if (!quadState) return;
    if (quadState.mode === 'SINGLE') {
        if (quadState.phase === 1) {
            quadState.p2 = { x: mouseCoords.x, y: mouseCoords.y };
            
            // --- MODIFIED: Respect View Rotation on First Pass ---
            const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
            
            if (Math.abs(rot) < 0.001) {
                // Standard axis aligned (Original behavior)
                quadState.p3 = { x: quadState.p1.x, y: mouseCoords.y };
                quadState.p4 = { x: mouseCoords.x, y: quadState.p1.y };
            } else {
                // Rotated axis alignment (Square to screen)
                const ang = -rot;
                const c = Math.cos(ang);
                const s = Math.sin(ang);
                
                // Vector P1 -> Mouse
                const dx = mouseCoords.x - quadState.p1.x;
                const dy = mouseCoords.y - quadState.p1.y;
                
                // Project onto Screen-X axis (which is rotated by ang in image space)
                // Axis X vector: (c, s)
                const projX = dx * c + dy * s;
                
                // Project onto Screen-Y axis
                // Axis Y vector: (-s, c)
                const projY = dx * (-s) + dy * c;
                
                // Construct P3 (P1 + projX * AxisX) - "Top Right" relative to rotation
                quadState.p3 = {
                    x: quadState.p1.x + projX * c,
                    y: quadState.p1.y + projX * s
                };
                
                // Construct P4 (P1 + projY * AxisY) - "Bottom Left" relative to rotation
                quadState.p4 = {
                    x: quadState.p1.x + projY * (-s),
                    y: quadState.p1.y + projY * c
                };
            }
        } 
        else if (quadState.phase === 2) {
            const cx = (quadState.p1.x + quadState.p2.x) / 2;
            const cy = (quadState.p1.y + quadState.p2.y) / 2;
            const radius = Math.hypot(quadState.p1.x - quadState.p2.x, quadState.p1.y - quadState.p2.y) / 2;
            
            const dx = mouseCoords.x - cx;
            const dy = mouseCoords.y - cy;
            const dist = Math.hypot(dx, dy);
            
            if (dist > 0.001) {
                const rx = (dx / dist) * radius;
                const ry = (dy / dist) * radius;
                quadState.p3 = { x: cx + rx, y: cy + ry };
                quadState.p4 = { x: cx - rx, y: cy - ry };
            }
        }
    } 
    else if (quadState.mode === 'DOUBLE') {
        const dx = quadState.p2.x - quadState.p1.x;
        const dy = quadState.p2.y - quadState.p1.y;
        
        const len = Math.hypot(dx, dy);
        if (len === 0) return;
        
        const nx = -dy / len;
        const ny = dx / len;
        
        const vx = mouseCoords.x - quadState.p1.x;
        const vy = mouseCoords.y - quadState.p1.y;
        
        const dist = vx * nx + vy * ny;
        
        quadState.p3 = { x: quadState.p1.x + nx * dist, y: quadState.p1.y + ny * dist };
        quadState.p4 = { x: quadState.p2.x + nx * dist, y: quadState.p2.y + ny * dist };
    }
    
    renderGeometry2D();
}
function handleQuadClick(e) {
    if (!quadState) return;
    save2DState();
    const layer = (quadState.p1.layer || 1);
    const isShift = e && e.shiftKey;
    const levelSourcePoint = (e && e.altKey) ? (quadState.levelSourcePoint || quadState.p1) : quadState.levelSourcePoint;
    const levelQuadPoint = (pt) => applySourceHeightToNewPoint(pt, levelSourcePoint);
    if (quadState.mode === 'SINGLE') {
        if (quadState.phase === 1) {
            quadState.phase = 2;
            return; 
        } 
        else if (quadState.phase === 2) {
            const newP2 = { x: quadState.p2.x, y: quadState.p2.y, layer: layer, z: null };
            const newP3 = { x: quadState.p3.x, y: quadState.p3.y, layer: layer, z: null };
            const newP4 = { x: quadState.p4.x, y: quadState.p4.y, layer: layer, z: null };
            levelQuadPoint(newP2);
            levelQuadPoint(newP3);
            levelQuadPoint(newP4);
            
            activeGeometry.points.push(newP2, newP3, newP4);
            
            activeGeometry.connections.push(
                { start: quadState.p1, end: newP3 },
                { start: newP3, end: newP2 },
                { start: newP2, end: newP4 },
                { start: newP4, end: quadState.p1 }
            );
            // Update Selection for Single Mode
            selectedLines.clear();
            selectedVents.clear();
            
            if (!isShift) selectedPoints.clear();
            
            selectedPoints.add(newP2);
            selectedPoints.add(newP3);
            selectedPoints.add(newP4);
            if (isShift) selectedPoints.add(quadState.p1);
        }
    } 
    else if (quadState.mode === 'DOUBLE') {
        const newP3 = { x: quadState.p3.x, y: quadState.p3.y, layer: layer, z: null };
        const newP4 = { x: quadState.p4.x, y: quadState.p4.y, layer: layer, z: null };
        levelQuadPoint(newP3);
        levelQuadPoint(newP4);
        
        activeGeometry.points.push(newP3, newP4);
        
        // Create the extension lines only (P1->P3, P3->P4, P4->P2)
        // We do NOT create the line connecting P1->P2
        activeGeometry.connections.push(
            { start: quadState.p1, end: newP3 },
            { start: newP3, end: newP4 },
            { start: newP4, end: quadState.p2 }
        );
        
        // Update Selection for Double Mode
        selectedLines.clear();
        selectedVents.clear();
        if (isShift) {
            // Shift Held: Highlight previously selected (p1, p2) AND newly created (p3, p4)
            selectedPoints.add(quadState.p1);
            selectedPoints.add(quadState.p2);
            selectedPoints.add(newP3);
            selectedPoints.add(newP4);
        } else {
            // Shift NOT Held: Highlight ONLY the two newly created points
            selectedPoints.clear();
            selectedPoints.add(newP3);
            selectedPoints.add(newP4);
        }
    }
    // Reset
    quadState = null;
    interactState = 'IDLE';
    document.body.style.cursor = 'default';
    activeSnapGuides = []; 
    
    renderGeometry2D();
    renderGeometry3D();
    checkAndTriggerMeasurementUpdate();
}
function normalizeGeometryClipboard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    const points = Array.isArray(payload.points) ? payload.points : [];
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const vents = Array.isArray(payload.vents) ? payload.vents : [];
    return {
        points: points.map(p => ({
            x: Number(p.x),
            y: Number(p.y),
            z: p.z === null || p.z === undefined || p.z === '' ? null : Number(p.z),
            layer: Number(p.layer) || 1,
            zLocked: !!p.zLocked
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
        lines: lines.map(l => ({
            startIndex: Number(l.startIndex),
            endIndex: Number(l.endIndex),
            type: l.type || undefined
        })).filter(l => Number.isInteger(l.startIndex) && Number.isInteger(l.endIndex)),
        vents: vents.map(v => ({
            x: Number(v.x),
            y: Number(v.y),
            layer: Number(v.layer) || 1
        })).filter(v => Number.isFinite(v.x) && Number.isFinite(v.y))
    };
}
function buildPortableGeometryClipboard(payload) {
    return {
        format: GEOMETRY_CLIPBOARD_FORMAT,
        version: GEOMETRY_CLIPBOARD_VERSION,
        createdAt: new Date().toISOString(),
        coordinateSpace: 'image-pixels',
        payload
    };
}
function serializePortableGeometryClipboard(payload) {
    return JSON.stringify(buildPortableGeometryClipboard(payload));
}
function parsePortableGeometryClipboardText(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.format === GEOMETRY_CLIPBOARD_FORMAT) {
            return normalizeGeometryClipboard(parsed.payload);
        }
        return normalizeGeometryClipboard(parsed);
    } catch (e) {
        return null;
    }
}
async function writeGeometryClipboardToSystem(payload) {
    if (!navigator.clipboard) return false;
    const text = serializePortableGeometryClipboard(payload);
    try {
        if (window.ClipboardItem && navigator.clipboard.write) {
            const item = new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'application/json': new Blob([text], { type: 'application/json' })
            });
            await navigator.clipboard.write([item]);
            return true;
        }
    } catch (e) {
        console.warn('[Clipboard] Rich geometry clipboard write failed; falling back to text.', e);
    }
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        console.warn('[Clipboard] Geometry clipboard write failed.', e);
        return false;
    }
}
async function readGeometryClipboardFromSystem() {
    if (!navigator.clipboard || !navigator.clipboard.readText) return null;
    try {
        return parsePortableGeometryClipboardText(await navigator.clipboard.readText());
    } catch (e) {
        console.warn('[Clipboard] Geometry clipboard read failed; using local clipboard if available.', e);
        return null;
    }
}
function persistGeometryClipboard(payload) {
    geometryClipboard = normalizeGeometryClipboard(payload);
    if (!geometryClipboard) return;
    try {
        localStorage.setItem('geometryClipboard', JSON.stringify(geometryClipboard));
    } catch (e) {}
}
async function handleCopy() {
    if (!activeGeometry) return;
    const pointsToCopy = new Set();
    const linesToCopy = new Set();
    const ventsToCopy = new Set();
    if (selectionMode === 'POINT') {
        selectedPoints.forEach(p => pointsToCopy.add(p));
        selectedVents.forEach(v => ventsToCopy.add(v));
        activeGeometry.connections.forEach(conn => {
            if (selectedPoints.has(conn.start) && selectedPoints.has(conn.end)) {
                linesToCopy.add(conn);
            }
        });
    } else if (selectionMode === 'LINE') {
        selectedLines.forEach(l => {
            linesToCopy.add(l);
            pointsToCopy.add(l.start);
            pointsToCopy.add(l.end);
        });
        selectedVents.forEach(v => ventsToCopy.add(v));
    }
    if (pointsToCopy.size === 0 && ventsToCopy.size === 0) return;
    const pArray = Array.from(pointsToCopy);
    const serializedPoints = pArray.map(p => ({
        x: p.x, y: p.y, z: p.z, layer: p.layer || 1, zLocked: !!p.zLocked
    }));
    const serializedLines = Array.from(linesToCopy).map(l => ({
        startIndex: pArray.indexOf(l.start),
        endIndex: pArray.indexOf(l.end),
        type: l.type
    }));
    const serializedVents = Array.from(ventsToCopy).map(v => ({
        x: v.x, y: v.y, layer: v.layer || 1
    }));
    const payload = {
        points: serializedPoints,
        lines: serializedLines,
        vents: serializedVents
    };
    persistGeometryClipboard(payload);
    await writeGeometryClipboardToSystem(geometryClipboard);
}
async function handlePaste() {
    if (!activeGeometry) return;
    const systemClipboard = await readGeometryClipboardFromSystem();
    if (systemClipboard) persistGeometryClipboard(systemClipboard);
    if (!geometryClipboard) return;
    save2DState(); 
    selectedPoints.clear();
    selectedLines.clear();
    selectedVents.clear();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const allItems = [...geometryClipboard.points, ...geometryClipboard.vents];
    
    if (allItems.length === 0) return;
    allItems.forEach(p => {
        if(p.x < minX) minX = p.x;
        if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y;
        if(p.y > maxY) maxY = p.y;
    });
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const mousePos = screenToImage(lastMouseX, lastMouseY);
    const dx = mousePos.x - centerX;
    const dy = mousePos.y - centerY;
    const newPoints = geometryClipboard.points.map(pData => {
        const newP = {
            x: pData.x + dx,
            y: pData.y + dy,
            z: pData.z,
            layer: pData.layer,
            zLocked: pData.zLocked
        };
        activeGeometry.points.push(newP);
        selectedPoints.add(newP); 
        return newP;
    });
    geometryClipboard.lines.forEach(lData => {
        if (newPoints[lData.startIndex] && newPoints[lData.endIndex]) {
            const newConn = {
                start: newPoints[lData.startIndex],
                end: newPoints[lData.endIndex],
                type: lData.type
            };
            activeGeometry.connections.push(newConn);
            if (selectionMode === 'LINE') selectedLines.add(newConn);
        }
    });
    if (!activeGeometry.vents) activeGeometry.vents = [];
    geometryClipboard.vents.forEach(vData => {
        const newV = {
            x: vData.x + dx,
            y: vData.y + dy,
            layer: vData.layer
        };
        activeGeometry.vents.push(newV);
        selectedVents.add(newV);
    });
    if (geometryClipboard.lines.length > 0 && selectionMode !== 'LINE') {
        selectionMode = 'POINT';
    }
    
    renderGeometry2D();
    renderGeometry3D();
    
    enterMoveMode();
}
function enterResizeMode() {
    if ((selectedPoints.size === 0 && selectedLines.size === 0 && selectedVents.size === 0) || !activeGeometry) return;
    save2DState();
    interactState = 'RESIZING';
    resizeState.originals.clear();
    const pointsToResize = new Set();
    const ventsToResize = new Set();
    // Gather all unique items to resize
    if (selectionMode === 'LINE') {
        selectedLines.forEach(l => { 
            pointsToResize.add(l.start); 
            pointsToResize.add(l.end); 
        });
        selectedVents.forEach(v => ventsToResize.add(v));
    } else {
        selectedPoints.forEach(p => pointsToResize.add(p));
        selectedVents.forEach(v => ventsToResize.add(v));
    }
    let sumX = 0, sumY = 0, count = 0;
    pointsToResize.forEach(p => { sumX += p.x; sumY += p.y; count++; });
    ventsToResize.forEach(v => { sumX += v.x; sumY += v.y; count++; });
    if (count === 0) { 
        interactState = 'IDLE'; 
        return; 
    }
    // Calculate Center
    resizeState.center = { x: sumX / count, y: sumY / count };
    // Store Originals
    pointsToResize.forEach(p => resizeState.originals.set(p, { x: p.x, y: p.y }));
    ventsToResize.forEach(v => resizeState.originals.set(v, { x: v.x, y: v.y }));
    // Calculate initial distance from mouse to center to establish scale factor 1.0
    const mousePos = screenToImage(lastMouseX, lastMouseY);
    resizeState.startDist = Math.hypot(mousePos.x - resizeState.center.x, mousePos.y - resizeState.center.y);
    
    // Prevent division by zero if mouse is exactly at center
    if (resizeState.startDist < 0.001) resizeState.startDist = 1;
    document.body.style.cursor = 'nesw-resize';
}
function handleResizeMove() {
    const mousePos = screenToImage(lastMouseX, lastMouseY);
    const currentDist = Math.hypot(mousePos.x - resizeState.center.x, mousePos.y - resizeState.center.y);
    
    // Calculate Scale Factor
    // Moving away from center scales up, moving towards scales down
    const scale = currentDist / resizeState.startDist;
    const cx = resizeState.center.x;
    const cy = resizeState.center.y;
    resizeState.originals.forEach((orig, item) => {
        // New Pos = Center + (OriginalVector * Scale)
        item.x = cx + (orig.x - cx) * scale;
        item.y = cy + (orig.y - cy) * scale;
    });
    renderGeometry2D();
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
}
// --- ROTATION LOGIC ---
function enterRotationMode() {
    if ((selectedPoints.size === 0 && selectedLines.size === 0 && selectedVents.size === 0) || !activeGeometry) return;
    save2DState();
    interactState = 'ROTATING';
    rotationState.originals.clear();
    const pointsToRot = new Set();
    const ventsToRot = new Set();
    if (selectionMode === 'LINE') {
        selectedLines.forEach(l => { pointsToRot.add(l.start); pointsToRot.add(l.end); });
        selectedVents.forEach(v => ventsToRot.add(v));
    } else {
        selectedPoints.forEach(p => pointsToRot.add(p));
        selectedVents.forEach(v => ventsToRot.add(v));
    }
    let sumX = 0, sumY = 0, count = 0;
    pointsToRot.forEach(p => { sumX += p.x; sumY += p.y; count++; });
    ventsToRot.forEach(v => { sumX += v.x; sumY += v.y; count++; });
    if (count === 0) { interactState = 'IDLE'; return; }
    rotationState.center = { x: sumX / count, y: sumY / count };
    pointsToRot.forEach(p => rotationState.originals.set(p, { x: p.x, y: p.y }));
    ventsToRot.forEach(v => rotationState.originals.set(v, { x: v.x, y: v.y }));
    const mousePos = screenToImage(lastMouseX, lastMouseY);
    rotationState.startAngle = Math.atan2(mousePos.y - rotationState.center.y, mousePos.x - rotationState.center.x);
    
    document.body.style.cursor = 'alias'; 
}
function handleRotationMove() {
    const mousePos = screenToImage(lastMouseX, lastMouseY);
    const currAngle = Math.atan2(mousePos.y - rotationState.center.y, mousePos.x - rotationState.center.x);
    
    let deltaTheta = currAngle - rotationState.startAngle;
    const step = Math.PI / 4; 
    const threshold = Math.PI / 36; 
    
    // --- FIX: Check isFreeMove before snapping ---
    if (!isFreeMove) {
        const snappedDelta = Math.round(deltaTheta / step) * step;
        if (Math.abs(deltaTheta - snappedDelta) < threshold) {
            deltaTheta = snappedDelta;
        }
    }
    const cos = Math.cos(deltaTheta);
    const sin = Math.sin(deltaTheta);
    const cx = rotationState.center.x;
    const cy = rotationState.center.y;
    rotationState.originals.forEach((orig, item) => {
        item.x = cx + (orig.x - cx) * cos - (orig.y - cy) * sin;
        item.y = cy + (orig.x - cx) * sin + (orig.y - cy) * cos;
    });
    renderGeometry2D();
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
}
function enterMoveMode() {
    interactState = 'MOVING';
    moveOriginals.clear();
    const ptsToSave = new Set();
    
    if (selectionMode === 'POINT') { 
        selectedPoints.forEach(p => ptsToSave.add(p)); 
        selectedVents.forEach(v => ptsToSave.add(v)); 
    } else { 
        selectedLines.forEach(l => { ptsToSave.add(l.start); ptsToSave.add(l.end); }); 
        selectedVents.forEach(v => ptsToSave.add(v)); 
    }
    
    ptsToSave.forEach(pt => moveOriginals.set(pt, { x: pt.x, y: pt.y }));
    
    const c = screenToImage(lastMouseX, lastMouseY);
    window.moveAnchor = { mouseX: c.x, mouseY: c.y };
}
function getClosestMidpoint(x, y, radius, excludeSet = null) {
    if (!activeGeometry) return null;
    let closestMid = null;
    let minD = radius;
    activeGeometry.connections.forEach(conn => {
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
        if (!layerVisibility[conn.start.layer || 1]) return;
        
        // If we are moving points that are part of this line, don't snap to its own center
        if (excludeSet && (excludeSet.has(conn.start) || excludeSet.has(conn.end))) return;
        const midX = (conn.start.x + conn.end.x) / 2;
        const midY = (conn.start.y + conn.end.y) / 2;
        const d = Math.hypot(midX - x, midY - y);
        if (d < minD) {
            minD = d;
            closestMid = { x: midX, y: midY, conn: conn };
        }
    });
    return closestMid;
}
function getCanvasStamp(c) {
    if (!c) return 0;
    if (!c.__stamp) c.__stamp = Date.now();
    return c.__stamp;
}
function ensureMasked2DCanvas(viewId) {
    const src = (typeof getAdjustedViewCanvas === 'function')
        ? getAdjustedViewCanvas(viewId)
        : ensureViewCanvas(viewId);
    if (!src) return null;
    if (!roofMaskEnabled || !roofMaskData || roofMaskData.length !== imageWidth * imageHeight) return src;
    const stamp = getCanvasStamp(src);
    const cached = maskedViewCanvases[viewId];
    if (cached && cached.stamp === stamp) return cached.canvas;
    const out = document.createElement('canvas');
    out.width = imageWidth;
    out.height = imageHeight;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(src, 0, 0, out.width, out.height);
    const img = octx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    // Make non-roof pixels transparent
    for (let i = 0; i < roofMaskData.length; i++) {
        if (!(roofMaskData[i] > 0)) {
            d[i * 4 + 3] = 0;
        }
    }
    octx.putImageData(img, 0, 0);
    maskedViewCanvases[viewId] = { canvas: out, stamp };
    return out;
}
function redrawCanvas() {
    const canvas = document.getElementById('mainCanvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (showImageLayer) {
        const srcCanvas = ensureMasked2DCanvas(currentViewId);
        if (srcCanvas) {
            ctx.save();
            const cx = imageWidth / 2;
            const cy = imageHeight / 2;
            ctx.translate(cx, cy);
            if (typeof viewRotation !== 'undefined') ctx.rotate(viewRotation); 
            ctx.translate(-cx, -cy);
            ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
            ctx.restore(); 
        }
    }
    drawVisualGrid();
    if (activeGeometry) {
        renderGeometry2D();
    }
}
function projectManifestPinToImage(pin) {
    if (typeof window.projectStructurePinToImage === 'function') return window.projectStructurePinToImage(pin);
    if (!pin || !Number.isFinite(Number(pin.lat)) || !Number.isFinite(Number(pin.lng))) return null;
    if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) return null;
    if (!Number.isFinite(Number(mapCenterLat)) || !Number.isFinite(Number(mapCenterLng))) return null;

    const centerLat = Number(mapCenterLat);
    const centerLng = Number(mapCenterLng);
    const mLat = 111132;
    const mLng = 111132 * Math.cos(centerLat * (Math.PI / 180));
    const rad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
    const metersPerPx = (window.getMetersPerPx ? Number(window.getMetersPerPx()) : ((rad * 2) / imageWidth));
    if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;

    const dLat = (Number(pin.lat) - centerLat) * mLat;
    const dLng = (Number(pin.lng) - centerLng) * mLng;

    return {
        rawX: (imageWidth / 2) + (dLng / metersPerPx),
        rawY: (imageHeight / 2) - (dLat / metersPerPx)
    };
}
function getOffMapPinPlacement(rawX, rawY) {
    const maxX = imageWidth;
    const maxY = imageHeight;
    const isOffImage = rawX < 0 || rawX > maxX || rawY < 0 || rawY > maxY;

    return {
        isOffImage,
        displayX: rawX,
        displayY: rawY
    };
}
function drawVisualGrid() {
    const canvas = document.getElementById('staticGridCanvas');
    const viewport = document.getElementById('viewport');
    
    if (!canvas || !viewport) return;
    if (canvas.width !== viewport.clientWidth || canvas.height !== viewport.clientHeight) {
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (typeof showGridLayer !== 'undefined' && !showGridLayer) return;
    const w = canvas.width;
    const h = canvas.height;
    const step = 50; 
    
    ctx.save();
    ctx.lineWidth = 1; 
    
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.25)'; 
    ctx.beginPath();
    const cx = w / 2;
    const cy = h / 2;
    
    const startX = cx % step;
    const startY = cy % step;
    for (let x = startX; x <= w; x += step) {
        ctx.moveTo(x + 0.5, 0); 
        ctx.lineTo(x + 0.5, h);
    }
    for (let y = startY; y <= h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.15)'; 
    ctx.beginPath();
    const offset1 = (cy - cx) % step;
    let k1 = offset1;
    while (k1 > -w) k1 -= step;
    for (; k1 < h; k1 += step) {
        ctx.moveTo(0, k1);
        ctx.lineTo(w, w + k1);
    }
    const offset2 = (cy + cx) % step;
    let k2 = offset2;
    while (k2 > 0) k2 -= step;
    for (; k2 < w + h; k2 += step) {
        ctx.moveTo(0, k2);
        ctx.lineTo(w, k2 - w);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 50, 50, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    
    ctx.stroke();
    ctx.restore();
}
/* interaction_2d.js */

/* interaction_2d.js */

/* interaction_2d.js */

window.renderGeometry2D = function() {
    const svg = document.getElementById('geoSvg');
    if(!svg) return;
    
    // 1. Manage the Rotation Group
    let rotGroup = document.getElementById('geo-rotation-group');
    
    if (!rotGroup) {
        while (svg.lastChild) svg.removeChild(svg.lastChild);
        rotGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        rotGroup.id = 'geo-rotation-group';
        svg.appendChild(rotGroup);
    } else {
        while (rotGroup.lastChild) rotGroup.removeChild(rotGroup.lastChild);
    }
    
    // 2. Apply Rotation Transform
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    const rotDeg = (typeof viewRotation !== 'undefined') ? viewRotation * (180/Math.PI) : 0;
    rotGroup.setAttribute("transform", `rotate(${rotDeg}, ${cx}, ${cy})`);
    const container = rotGroup; 
    
    const invScale = 1 / currentZoom;

    // --- SNAP GUIDES ---
    if (typeof activeSnapGuides !== 'undefined' && activeSnapGuides.length > 0) {
        const w = 50000;
        activeSnapGuides.forEach(guide => {
            let dx = guide.p2.x - guide.p1.x;
            let dy = guide.p2.y - guide.p1.y;
            const len = Math.hypot(dx, dy);
            if (len === 0) return;
            dx /= len; dy /= len;
            const startX = guide.p1.x - dx * w;
            const startY = guide.p1.y - dy * w;
            const endX   = guide.p1.x + dx * w;
            const endY   = guide.p1.y + dy * w;
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute('x1', startX);
            line.setAttribute('y1', startY);
            line.setAttribute('x2', endX);
            line.setAttribute('y2', endY);
            line.setAttribute('class', 'snap-guide-line');
            line.style.stroke = '#FFD700';
            line.style.strokeWidth = (1.5 * invScale) + 'px';
            line.style.strokeLinecap = 'round';
            line.style.opacity = '0.85';
            line.style.pointerEvents = 'none';
            line.style.strokeDasharray = 'none';
            container.appendChild(line);
        });
    }

    if (!activeGeometry || !activeGeometry.connections) return;

    // --- GEOMETRY DRAWING CONSTANTS ---
    const lineStroke = 2 * invScale;
    const lineHighlightStroke = 6 * invScale; 
    const lineSelectedStroke = 4 * invScale;
    const pointRadius = 2.5 * invScale; 
    const pointSelectedStroke = 4 * invScale; 
    const pointNormalStroke = 1 * invScale;
    const hitRadius = 8 * invScale;
    const ventSize = 12 * invScale;

    // --- 0. FACES ---
    if(window.currentFaceDataForSVG) {
         const faceData = (typeof window.getStructureFilteredFaces === 'function')
            ? window.getStructureFilteredFaces(window.currentFaceDataForSVG)
            : window.currentFaceDataForSVG;
         window.renderFaces2D(faceData, container);
    }

    // 0.5 FACET CENTERS (debug)
    if (window.__FACET_DEBUG_CENTERS__ && Array.isArray(window.__FACET_DEBUG_CENTERS__)) {
        window.__FACET_DEBUG_CENTERS__.forEach((c) => {
            if (!c) return;
            const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            dot.setAttribute("cx", c.x);
            dot.setAttribute("cy", c.y);
            dot.setAttribute("r", 6 * invScale);
            dot.setAttribute("fill", c.__manual ? "rgba(255,140,0,0.95)" : "rgba(255,255,0,0.85)");
            dot.setAttribute("stroke", "#000");
            dot.setAttribute("stroke-width", 2 * invScale);
            dot.style.pointerEvents = "none";
            container.appendChild(dot);
            
            const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
            txt.setAttribute("x", c.x + 8 * invScale);
            txt.setAttribute("y", c.y - 8 * invScale);
            txt.setAttribute("fill", "#fff");
            txt.setAttribute("font-size", 14 * invScale + "px");
            txt.setAttribute("stroke", "#000");
            txt.setAttribute("stroke-width", 3 * invScale + "px");
            txt.setAttribute("paint-order", "stroke");
            txt.textContent = String(c.id ?? "");
            txt.style.pointerEvents = "none";
            container.appendChild(txt);
        });
    }

    // --- CUSTOMER PINS ---
    // This block renders the locations ordered by the customer
    if (typeof window.showCustomerPins !== 'undefined' && window.showCustomerPins && 
        window.currentProjectManifest && window.currentProjectManifest.pins && 
        window.currentProjectManifest.pins.length > 0 &&
        typeof mapCenterLat !== 'undefined' && typeof mapCenterLng !== 'undefined' && imageWidth) {

        const totalPins = window.currentProjectManifest.pins.length;

        window.currentProjectManifest.pins.forEach((pin, idx) => {
            const projection = projectManifestPinToImage(pin);
            if (!projection) return;

            const placement = getOffMapPinPlacement(projection.rawX, projection.rawY);
            const px = placement.displayX;
            const py = placement.displayY;
            const isOffImage = placement.isOffImage;
            const activeStructure = window.structureModeState ? window.structureModeState.active : 'all';
            const isActiveStructurePin = activeStructure === (idx + 1);
            const isMutedStructurePin = Number.isInteger(activeStructure) && !isActiveStructurePin;

            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            group.style.pointerEvents = 'none'; // Pins are non-interactive reference
            group.setAttribute('data-pin-state', isOffImage ? 'off-map' : 'in-map');
            
            // Marker Visuals
            const pinRad = (isActiveStructurePin ? 9 : 6) * invScale;
            const pinColor = isOffImage ? '#f29900' : '#1a73e8';
            const pinLabel = String(pin.label || pin.name || pin.title || (totalPins > 1 ? `Structure ${idx + 1}` : 'Structure'));
            
            // Outer ring
            const circleOut = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circleOut.setAttribute('cx', px);
            circleOut.setAttribute('cy', py);
            circleOut.setAttribute('r', pinRad);
            circleOut.setAttribute('fill', pinColor);
            circleOut.setAttribute('stroke', isActiveStructurePin ? '#ffd400' : '#FFFFFF');
            circleOut.setAttribute('stroke-width', (isActiveStructurePin ? 4 : 2) * invScale);
            circleOut.setAttribute('opacity', isMutedStructurePin ? '0.35' : '1');
            group.appendChild(circleOut);

            // Center dot
            const circleIn = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circleIn.setAttribute('cx', px);
            circleIn.setAttribute('cy', py);
            circleIn.setAttribute('r', pinRad * 0.3);
            circleIn.setAttribute('fill', '#FFFFFF');
            circleIn.setAttribute('opacity', isMutedStructurePin ? '0.45' : '1');
            group.appendChild(circleIn);
            
            // Label
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute('x', px);
            text.setAttribute('y', py - (pinRad) - (3 * invScale));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('fill', pinColor);
            text.setAttribute('stroke', '#ffffff');
            text.setAttribute('stroke-width', 2 * invScale);
            text.setAttribute('paint-order', 'stroke');
            text.setAttribute('font-family', 'Arial, sans-serif');
            text.setAttribute('font-size', (11 * invScale) + 'px');
            text.setAttribute('font-weight', '900');
            text.setAttribute('opacity', isMutedStructurePin ? '0.45' : '1');
            text.textContent = pinLabel;
            group.appendChild(text);
            
            container.appendChild(group);
        });

        const additionalPins = (typeof window.firstMeasureGetAdditionalStructureRequestPins === 'function')
            ? window.firstMeasureGetAdditionalStructureRequestPins(window.currentProjectManifest)
            : [];
        if (Array.isArray(additionalPins) && additionalPins.length > 0) {
            additionalPins.forEach((pin, idx) => {
                const projection = projectManifestPinToImage(pin);
                if (!projection) return;

                const placement = getOffMapPinPlacement(projection.rawX, projection.rawY);
                const px = placement.displayX;
                const py = placement.displayY;
                const isOffImage = placement.isOffImage;

                const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
                group.style.pointerEvents = 'none';
                group.setAttribute('data-pin-state', isOffImage ? 'off-map' : 'in-map');
                group.setAttribute('data-pin-type', 'additional-structure-request');

                const pinRad = 6 * invScale;
                const pinColor = isOffImage ? '#f29900' : '#7b1fa2';
                const label = `Requested ${idx + 1}`;

                const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                halo.setAttribute('cx', px);
                halo.setAttribute('cy', py);
                halo.setAttribute('r', pinRad * 1.75);
                halo.setAttribute('fill', 'none');
                halo.setAttribute('stroke', pinColor);
                halo.setAttribute('stroke-width', 1.5 * invScale);
                halo.setAttribute('opacity', isOffImage ? '0.55' : '0.35');
                group.appendChild(halo);

                const circleOut = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                circleOut.setAttribute('cx', px);
                circleOut.setAttribute('cy', py);
                circleOut.setAttribute('r', pinRad);
                circleOut.setAttribute('fill', pinColor);
                circleOut.setAttribute('stroke', '#FFFFFF');
                circleOut.setAttribute('stroke-width', 2 * invScale);
                group.appendChild(circleOut);

                const circleIn = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                circleIn.setAttribute('cx', px);
                circleIn.setAttribute('cy', py);
                circleIn.setAttribute('r', pinRad * 0.3);
                circleIn.setAttribute('fill', '#FFFFFF');
                group.appendChild(circleIn);

                const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                text.setAttribute('x', px);
                text.setAttribute('y', py - pinRad - (3 * invScale));
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('fill', pinColor);
                text.setAttribute('stroke', '#ffffff');
                text.setAttribute('stroke-width', 2 * invScale);
                text.setAttribute('paint-order', 'stroke');
                text.setAttribute('font-family', 'Arial, sans-serif');
                text.setAttribute('font-size', (11 * invScale) + 'px');
                text.setAttribute('font-weight', '900');
                text.textContent = label;
                group.appendChild(text);

                container.appendChild(group);
            });
        }
    }

    // 1. QUAD PREVIEW
    if (interactState === 'QUAD_CREATE' && quadState && quadState.p3 && quadState.p4) {
        const previewGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        let pathD = "";
        if (quadState.mode === 'SINGLE') {
            pathD = `M ${quadState.p1.x},${quadState.p1.y} L ${quadState.p3.x},${quadState.p3.y} L ${quadState.p2.x},${quadState.p2.y} L ${quadState.p4.x},${quadState.p4.y} Z`;
        } else {
            pathD = `M ${quadState.p1.x},${quadState.p1.y} L ${quadState.p3.x},${quadState.p3.y} L ${quadState.p4.x},${quadState.p4.y} L ${quadState.p2.x},${quadState.p2.y}`;
        }
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "path");
        poly.setAttribute('d', pathD);
        poly.setAttribute('fill', 'rgba(0, 255, 0, 0.2)');
        poly.setAttribute('stroke', '#00FF00');
        poly.setAttribute('stroke-width', lineStroke);
        poly.setAttribute('stroke-dasharray', `${5*invScale},${5*invScale}`);
        previewGroup.appendChild(poly);
        [quadState.p3, quadState.p4].forEach(p => {
            const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', pointRadius);
            c.setAttribute('fill', '#00FF00');
            previewGroup.appendChild(c);
        });
        container.appendChild(previewGroup);
    }

    // --- 1. VENTS ---
    if (activeGeometry.vents) {
        activeGeometry.vents.forEach(v => {
            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(v)) return;
            const l = v.layer || 1;
            if (!layerVisibility[l]) return; 
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            const isSelected = selectedVents.has(v);
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute('x', v.x - ventSize/2);
            rect.setAttribute('y', v.y - ventSize/2);
            rect.setAttribute('width', ventSize);
            rect.setAttribute('height', ventSize);
            rect.setAttribute('fill', '#ff9800'); 
            rect.setAttribute('stroke', isSelected ? '#ffffff' : '#000000'); 
            rect.setAttribute('stroke-width', (isSelected ? 3 : 1) * invScale);
            rect.setAttribute('rx', 2 * invScale);
            
            const hitRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            const hitSize = ventSize * 1.5;
            hitRect.setAttribute('x', v.x - hitSize/2);
            hitRect.setAttribute('y', v.y - hitSize/2);
            hitRect.setAttribute('width', hitSize);
            hitRect.setAttribute('height', hitSize);
            hitRect.setAttribute('fill', 'transparent');
            hitRect.style.cursor = 'pointer';
            group.appendChild(rect);
            group.appendChild(hitRect);
            container.appendChild(group);
        });
    }

    if (interactState === 'PLACING_VENTS') {
        let coords;
        if (lastValidVentSnap) {
            coords = lastValidVentSnap;
        } else {
            coords = screenToImage(lastMouseX, lastMouseY);
        }
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute('x', coords.x - ventSize/2);
        rect.setAttribute('y', coords.y - ventSize/2);
        rect.setAttribute('width', ventSize);
        rect.setAttribute('height', ventSize);
        rect.setAttribute('fill', 'rgba(255, 152, 0, 0.5)'); 
        rect.setAttribute('stroke', '#fff'); 
        rect.setAttribute('stroke-width', 2 * invScale);
        rect.setAttribute('rx', 2 * invScale);
        group.appendChild(rect);
        container.appendChild(group);
    }

    // --- 2. LINES ---
    if (activeGeometry.connections) {
        activeGeometry.connections.forEach(conn => {
            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
            const l = conn.start.layer || 1;
            if (!layerVisibility[l]) return;
            const isSelected = (selectionMode === 'LINE' && selectedLines.has(conn));
            
            let strokeColor;
            const useTypeColor = (showLineTypes || (typeof isMeasurementMode !== 'undefined' && isMeasurementMode));
            if (conn.type && useTypeColor) {
                const typeDef = Object.values(LINE_TYPES).find(t => t.id === conn.type);
                strokeColor = typeDef ? typeDef.color : '#888';
            } else {
                const style = LAYER_STYLES[l] || LAYER_STYLES[1];
                strokeColor = style.line;
            }
            
            if (isSelected) {
                const highlight = document.createElementNS("http://www.w3.org/2000/svg", "line");
                highlight.setAttribute('x1', conn.start.x);
                highlight.setAttribute('y1', conn.start.y);
                highlight.setAttribute('x2', conn.end.x);
                highlight.setAttribute('y2', conn.end.y);
                highlight.setAttribute('class', 'geo-line geo-line-highlight');
                highlight.style.stroke = 'white';
                highlight.style.strokeWidth = lineHighlightStroke + 'px';
                highlight.style.strokeLinecap = 'round';
                container.appendChild(highlight);
            }
            
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute('x1', conn.start.x);
            line.setAttribute('y1', conn.start.y);
            line.setAttribute('x2', conn.end.x);
            line.setAttribute('y2', conn.end.y);
            line.setAttribute('class', 'geo-line');
            line.style.stroke = strokeColor;
            line.style.strokeLinecap = 'round';
            if (isSelected) {
                line.style.strokeWidth = lineSelectedStroke + 'px';
                line.classList.add('selected-line'); 
            } else {
                line.style.strokeWidth = lineStroke + 'px';
            }
            container.appendChild(line);
            
            // Centerpoint Ticks
            if (typeof showCenterpoints !== 'undefined' && showCenterpoints) {
                const midX = (conn.start.x + conn.end.x) / 2;
                const midY = (conn.start.y + conn.end.y) / 2;
                
                let dx = conn.end.x - conn.start.x;
                let dy = conn.end.y - conn.start.y;
                const len = Math.hypot(dx, dy);
                
                if (len > 0) {
                    dx /= len;
                    dy /= len;
                    const perpX = -dy;
                    const perpY = dx;
                    const tickSize = 6 * invScale; 
                    
                    const t1x = midX + perpX * tickSize;
                    const t1y = midY + perpY * tickSize;
                    const t2x = midX - perpX * tickSize;
                    const t2y = midY - perpY * tickSize;
                    
                    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
                    tick.setAttribute('x1', t1x);
                    tick.setAttribute('y1', t1y);
                    tick.setAttribute('x2', t2x);
                    tick.setAttribute('y2', t2y);
                    tick.style.stroke = '#00FFFF';
                    tick.style.strokeWidth = (2 * invScale) + 'px';
                    tick.style.opacity = '0.7';
                    tick.style.pointerEvents = 'none';
                    container.appendChild(tick);
                }
            }
            
            if (showMeasurementsLayer) {
                renderMeasurementLabel(conn, container, invScale);
            }
        });
    }

    // --- 3. TEMP LINES (Creating Point) ---
    if (interactState === 'NEW_POINT' && tempPoint) {
         selectedPoints.forEach(pt => {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute('x1', pt.x);
            line.setAttribute('y1', pt.y);
            line.setAttribute('x2', tempPoint.x);
            line.setAttribute('y2', tempPoint.y);
            line.setAttribute('class', 'geo-line');
            
            const l = pt.layer || 1;
            const style = LAYER_STYLES[l] || LAYER_STYLES[1];
            line.style.stroke = style.line;
            line.style.strokeWidth = lineStroke + 'px';
            line.style.strokeDasharray = `${5*invScale},${5*invScale}`;
            line.style.opacity = '0.7';
            container.appendChild(line);
        });
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const vis = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        vis.setAttribute('cx', tempPoint.x);
        vis.setAttribute('cy', tempPoint.y);
        vis.setAttribute('r', pointRadius);
        
        let l = 1;
        if(selectedPoints.size > 0) l = selectedPoints.values().next().value.layer || 1;
        
        const style = LAYER_STYLES[l] || LAYER_STYLES[1];
        vis.setAttribute('fill', style.dot); 
        vis.setAttribute('stroke', 'white');
        vis.setAttribute('stroke-width', pointNormalStroke + 'px');
        group.appendChild(vis);
        container.appendChild(group);
    }

    // --- 4. POINTS ---
    if (selectionMode === 'POINT' && activeGeometry.points) {
        activeGeometry.points.forEach(pt => {
            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) return;
            const l = pt.layer || 1;
            if (!layerVisibility[l]) return;
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            group.setAttribute('class', 'geo-point-group');
            if (selectedPoints.has(pt)) group.classList.add('selected');
            const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            hit.setAttribute('cx', pt.x);
            hit.setAttribute('cy', pt.y);
            hit.setAttribute('r', hitRadius);
            hit.setAttribute('class', 'geo-point-hitbox');
            group.appendChild(hit);
            const vis = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            vis.setAttribute('cx', pt.x);
            vis.setAttribute('cy', pt.y);
            vis.setAttribute('r', pointRadius);
            vis.setAttribute('class', 'geo-point-vis');
            
            const style = LAYER_STYLES[l] || LAYER_STYLES[1];
            vis.style.fill = style.dot;
            vis.style.stroke = 'white';
            vis.style.strokeWidth = (selectedPoints.has(pt) ? pointSelectedStroke : pointNormalStroke) + 'px';
            
            group.appendChild(vis);
            container.appendChild(group);
        });
    }
    
    // --- LOCATION ADJUST PREVIEW ---
    if (typeof isAdjustingLocation !== 'undefined' && isAdjustingLocation) {
        // Calculate size of preview square in current pixel coordinates
        // Current image is RADIUS_METERS * 2 wide.
        const currentMetersPerPx = (RADIUS_METERS * 2) / imageWidth;
        const previewSizePx = (adjustState.radius * 2) / currentMetersPerPx;
        
        // Convert Lat/Lng delta to Pixels relative to CURRENT center
        const mLat = 111132;
        const mLng = 111132 * Math.cos(mapCenterLat * (Math.PI/180));
        const dLat = (adjustState.lat - mapCenterLat) * mLat;
        const dLng = (adjustState.lng - mapCenterLng) * mLng;
        
        const previewCenterX = (imageWidth / 2) + (dLng / currentMetersPerPx);
        const previewCenterY = (imageHeight / 2) - (dLat / currentMetersPerPx);
        
        const previewRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        previewRect.setAttribute('x', previewCenterX - previewSizePx / 2);
        previewRect.setAttribute('y', previewCenterY - previewSizePx / 2);
        previewRect.setAttribute('width', previewSizePx);
        previewRect.setAttribute('height', previewSizePx);
        previewRect.setAttribute('fill', 'rgba(217, 48, 37, 0.1)');
        previewRect.setAttribute('stroke', '#d93025');
        previewRect.setAttribute('stroke-width', (3 * invScale) + 'px');
        previewRect.setAttribute('stroke-dasharray', `${8*invScale},${4*invScale}`);
        container.appendChild(previewRect);
        
        const crossH = document.createElementNS("http://www.w3.org/2000/svg", "line");
        const crossV = document.createElementNS("http://www.w3.org/2000/svg", "line");
        const chSize = 20 * invScale;
        
        [crossH, crossV].forEach(l => {
            l.setAttribute('stroke', '#d93025');
            l.setAttribute('stroke-width', (2*invScale) + 'px');
        });
        crossH.setAttribute('x1', previewCenterX - chSize); crossH.setAttribute('x2', previewCenterX + chSize);
        crossH.setAttribute('y1', previewCenterY);          crossH.setAttribute('y2', previewCenterY);
        crossV.setAttribute('x1', previewCenterX);          crossV.setAttribute('x2', previewCenterX);
        crossV.setAttribute('y1', previewCenterY - chSize); crossV.setAttribute('y2', previewCenterY + chSize);
        
        container.appendChild(crossH);
        container.appendChild(crossV);
    }

    // --- UNDERWALL PREVIEW ---
    if (interactState === 'UNDERWALL' && underwallState && underwallState.preview) {
        const pv = underwallState.preview;
        const inv = invScale;
        // Perpendicular preview
        if (pv.perp && pv.perp.a && pv.perp.b) {
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            l.setAttribute('x1', pv.perp.a.x); l.setAttribute('y1', pv.perp.a.y);
            l.setAttribute('x2', pv.perp.b.x); l.setAttribute('y2', pv.perp.b.y);
            l.style.stroke = 'rgba(0,255,255,0.95)';
            l.style.strokeWidth = (2.5 * inv) + 'px';
            l.style.strokeDasharray = `${8*inv},${6*inv}`;
            l.style.pointerEvents = 'none';
            container.appendChild(l);
        }
        // Start connector preview
        if (pv.startLink && pv.startLink.a && pv.startLink.b) {
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            l.setAttribute('x1', pv.startLink.a.x); l.setAttribute('y1', pv.startLink.a.y);
            l.setAttribute('x2', pv.startLink.b.x); l.setAttribute('y2', pv.startLink.b.y);
            l.style.stroke = 'rgba(0,255,255,0.95)';
            l.style.strokeWidth = (2.5 * inv) + 'px';
            l.style.strokeDasharray = `${6*inv},${6*inv}`;
            l.style.pointerEvents = 'none';
            container.appendChild(l);
        }
        // Offset polyline preview
        if (pv.ok && pv.poly && pv.poly.length >= 2) {
            let d = `M ${pv.poly[0].x} ${pv.poly[0].y} `;
            for (let i = 1; i < pv.poly.length; i++) d += `L ${pv.poly[i].x} ${pv.poly[i].y} `;
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", d);
            path.setAttribute("fill", "none");
            path.style.stroke = 'rgba(0,255,255,0.95)';
            path.style.strokeWidth = (3.0 * inv) + 'px';
            path.style.strokeDasharray = `${10*inv},${6*inv}`;
            path.style.strokeLinecap = 'round';
            path.style.strokeLinejoin = 'round';
            path.style.pointerEvents = 'none';
            container.appendChild(path);
            
            const dotR = 4.5 * inv;
            [pv.poly[0], pv.poly[pv.poly.length-1]].forEach(p => {
                const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", dotR);
                c.setAttribute("fill", "rgba(0,255,255,0.95)");
                c.style.pointerEvents = 'none';
                container.appendChild(c);
            });
        } else {
            if (pv.target) {
                const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                c.setAttribute("cx", pv.target.x); c.setAttribute("cy", pv.target.y);
                c.setAttribute("r", 6 * inv);
                c.setAttribute("fill", "rgba(217,48,37,0.95)");
                c.style.pointerEvents = 'none';
                container.appendChild(c);
            }
        }
    }
}

function screenToImage(clientX, clientY) {
    const rect = document.getElementById('viewport').getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    
    const imgX_Screen = (vx - panX) / currentZoom;
    const imgY_Screen = (vy - panY) / currentZoom;
    if (typeof viewRotation === 'undefined' || viewRotation === 0) {
        return { x: imgX_Screen, y: imgY_Screen };
    }
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    const dx = imgX_Screen - cx;
    const dy = imgY_Screen - cy;
    const cos = Math.cos(-viewRotation); 
    const sin = Math.sin(-viewRotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: rx + cx, y: ry + cy };
}
function updateSnapRadius() {
    snapRadius = parseInt(document.getElementById('snapRadiusInput').value);
    document.getElementById('snapRadiusVal').innerText = snapRadius;
}
function getClosestPoint(x, y, radius, excludeSet = null) {
    if (!activeGeometry) return null;
    let closest = null;
    let minD = Infinity;
    const referenceLayer = (excludeSet && excludeSet.size > 0) 
        ? Array.from(excludeSet)[0].layer 
        : null;
    activeGeometry.points.forEach(p => {
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(p)) return;
        if (!layerVisibility[p.layer || 1]) return;
        if (excludeSet && excludeSet.has(p)) return;
        if (referenceLayer && p.layer !== referenceLayer) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < radius && d < minD) {
            minD = d;
            closest = p;
        }
    });
    return closest;
}
function getClosestLine(x, y, radius, excludePoints = null) {
    if (!activeGeometry) return null;
    let closestPt = null;
    let minD = Infinity;
    const referenceLayer = (excludePoints && excludePoints.size > 0) 
        ? Array.from(excludePoints)[0].layer 
        : null;
    activeGeometry.connections.forEach(conn => {
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
        if (!layerVisibility[conn.start.layer || 1]) return;
        if (referenceLayer && conn.start.layer !== referenceLayer) return;
        if (excludePoints && (excludePoints.has(conn.start) || excludePoints.has(conn.end))) return;
        const A = conn.start;
        const B = conn.end;
        const ABx = B.x - A.x;
        const ABy = B.y - A.y;
        const lenSq = ABx*ABx + ABy*ABy;
        if(lenSq === 0) return;
        const APx = x - A.x;
        const APy = y - A.y;
        let t = (APx * ABx + APy * ABy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = A.x + t * ABx;
        const projY = A.y + t * ABy;
        
        const dist = Math.hypot(x - projX, y - projY);
        if (dist < radius && dist < minD) {
            minD = dist;
            closestPt = { x: projX, y: projY };
        }
    });
    return closestPt;
}
function renderMeasurementLabel(conn, container, invScale) {
  const imgW = (typeof imageWidth !== 'undefined' && imageWidth > 0) ? imageWidth : 1000;
  // ✅ Use the live radius (supports regen + saved projects)
  const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
    (((window.getRadiusMeters ? window.getRadiusMeters() :
      (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imgW));
  const x1 = conn.start.x; const y1 = conn.start.y;
  const x2 = conn.end.x;   const y2 = conn.end.y;
  const dx = x2 - x1;      const dy = y2 - y1;
  const dist2d = Math.sqrt(dx*dx + dy*dy);
  let finalLenFeet = 0;
  if (conn.start.z !== null && conn.end.z !== null) {
    const dz = conn.start.z - conn.end.z;
    const distMeters2D = dist2d * metersPerPx;
    const distMeters3D = Math.sqrt(distMeters2D * distMeters2D + dz * dz);
    finalLenFeet = distMeters3D * 3.28084;
  } else {
    finalLenFeet = (dist2d * metersPerPx) * 3.28084;
  }
  const labelText = finalLenFeet.toFixed(1) + "'";
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const labelGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelGroup.style.pointerEvents = 'none';
  const rotDeg = (typeof viewRotation !== 'undefined') ? -viewRotation * (180/Math.PI) : 0;
  labelGroup.setAttribute("transform", `rotate(${rotDeg}, ${midX}, ${midY})`);
  const charW = 7 * invScale;
  const boxW = (labelText.length * charW) + (4 * invScale);
  const boxH = 14 * invScale;
  const textRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  textRect.setAttribute('x', midX - boxW/2);
  textRect.setAttribute('y', midY - boxH/2);
  textRect.setAttribute('width', boxW);
  textRect.setAttribute('height', boxH);
  textRect.setAttribute('rx', 3 * invScale);
  textRect.setAttribute('fill', 'rgba(255, 255, 255, 0.85)');
  textRect.setAttribute('stroke', '#333');
  textRect.setAttribute('stroke-width', 0.5 * invScale);
  const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
  textEl.setAttribute('x', midX);
  textEl.setAttribute('y', midY);
  textEl.setAttribute('text-anchor', 'middle');
  textEl.setAttribute('dominant-baseline', 'central');
  textEl.setAttribute('fill', '#000');
  textEl.setAttribute('font-family', 'Arial, sans-serif');
  textEl.setAttribute('font-size', (12 * invScale) + 'px');
  textEl.setAttribute('font-weight', 'bold');
  textEl.textContent = labelText;
  labelGroup.appendChild(textRect);
  labelGroup.appendChild(textEl);
  container.appendChild(labelGroup);
}
function mergePoints(sourcePt, targetPt) {
    if(sourcePt === targetPt) return;
    if(sourcePt.layer !== targetPt.layer) return;
    save2DState();
    activeGeometry.connections.forEach(conn => {
        if (conn.start === sourcePt) conn.start = targetPt;
        if (conn.end === sourcePt) conn.end = targetPt;
    });
    activeGeometry.points = activeGeometry.points.filter(p => p !== sourcePt);
    activeGeometry.connections = activeGeometry.connections.filter(c => c.start !== c.end);
    if (selectedPoints.has(sourcePt)) {
        selectedPoints.delete(sourcePt);
        selectedPoints.add(targetPt);
    }
    renderGeometry3D();
    triggerLiveUpdate();
    checkAndTriggerMeasurementUpdate();
}

function cleanPointRingAfterMerge(points, mergeSet, mergedPoint) {
    if (!Array.isArray(points)) return [];
    const out = [];
    points.forEach((pt) => {
        const mapped = mergeSet.has(pt) ? mergedPoint : pt;
        if (mapped && out[out.length - 1] !== mapped) out.push(mapped);
    });
    if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
}

function mergeSelectedPointsToCenter() {
    if (!activeGeometry || !selectedPoints || selectedPoints.size < 2) return false;
    const pts = Array.from(selectedPoints).filter(Boolean);
    if (pts.length < 2) return false;

    save2DState();
    try {
        if (typeof interactState !== 'undefined') interactState = 'IDLE';
        if (typeof interactState3D !== 'undefined') interactState3D = 'IDLE';
        if (typeof tempPoint !== 'undefined') tempPoint = null;
        if (typeof newPointSourcePoint !== 'undefined') newPointSourcePoint = null;
        if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
        if (typeof updateSnapGuides === 'function') updateSnapGuides(null);
        document.body.style.cursor = 'default';
    } catch (e) {}

    const mergeSet = new Set(pts);
    const center = {
        x: pts.reduce((sum, pt) => sum + (Number(pt.x) || 0), 0) / pts.length,
        y: pts.reduce((sum, pt) => sum + (Number(pt.y) || 0), 0) / pts.length,
        z: null,
        layer: pts[0].layer || 1
    };
    const zVals = pts.map(pt => Number(pt.z)).filter(Number.isFinite);
    if (zVals.length) {
        center.z = zVals.reduce((sum, z) => sum + z, 0) / zVals.length;
        center.zLocked = pts.some(pt => !!pt.zLocked);
    }
    activeGeometry.points.push(center);

    activeGeometry.connections.forEach((conn) => {
        if (mergeSet.has(conn.start)) conn.start = center;
        if (mergeSet.has(conn.end)) conn.end = center;
    });

    const seenConnections = new Set();
    activeGeometry.connections = activeGeometry.connections.filter((conn) => {
        if (!conn || !conn.start || !conn.end || conn.start === conn.end) return false;
        const aIdx = activeGeometry.points.indexOf(conn.start);
        const bIdx = activeGeometry.points.indexOf(conn.end);
        const lo = Math.min(aIdx, bIdx);
        const hi = Math.max(aIdx, bIdx);
        const key = `${lo}:${hi}:${conn.type || ''}`;
        if (seenConnections.has(key)) return false;
        seenConnections.add(key);
        return true;
    });

    if (Array.isArray(activeGeometry.manualFaces)) {
        activeGeometry.manualFaces = activeGeometry.manualFaces
            .map((face) => {
                if (!face || !Array.isArray(face.points)) return face;
                const nextPoints = cleanPointRingAfterMerge(face.points, mergeSet, center);
                const nextHoles = Array.isArray(face.holes)
                    ? face.holes
                        .map(hole => cleanPointRingAfterMerge(hole, mergeSet, center))
                        .filter(hole => hole.length >= 3)
                    : [];
                return { ...face, points: nextPoints, holes: nextHoles };
            })
            .filter(face => face && Array.isArray(face.points) && face.points.length >= 3);
    }

    activeGeometry.points = activeGeometry.points.filter(pt => !mergeSet.has(pt));
    selectedPoints.clear();
    selectedPoints.add(center);
    if (typeof selectedLines !== 'undefined') selectedLines.clear();
    if (typeof selectedVents !== 'undefined') selectedVents.clear();

    if (window.nudgeGroupTimer) clearTimeout(window.nudgeGroupTimer);
    window.nudgeGroupTimer = null;
    window.isNudgeSequenceActive = false;
    renderGeometry2D();
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
    if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
    if (typeof renderFinalPass === 'function') renderFinalPass(false);
    if (typeof updateMeasurementUI === 'function') updateMeasurementUI();
    checkAndTriggerMeasurementUpdate();
    triggerLiveUpdate();
    requestAnimationFrame(() => {
        if (typeof renderGeometry2D === 'function') renderGeometry2D();
        if (typeof renderGeometry3D === 'function') renderGeometry3D();
    });
    return true;
}

window.mergeSelectedPointsToCenter = mergeSelectedPointsToCenter;

if (!window.__mergeSelectedPointsImmediateHandlerInstalled) {
    window.__mergeSelectedPointsImmediateHandlerInstalled = true;
    window.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if ((e.key || '').toLowerCase() !== 'w') return;
        if (!selectedPoints || selectedPoints.size < 2 || !activeGeometry) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        mergeSelectedPointsToCenter();
    }, true);
}

function setSmartStickerFromShortcut(id) {
    const stickers = window.SmartStickers;
    if (!stickers || !stickers.defs || !stickers.defs.has(id) || typeof stickers.setActive !== 'function') return false;
    stickers.setActive(id);
    return true;
}

function cycleDormerShortcut() {
    const stickers = window.SmartStickers;
    if (!stickers || !stickers.defs || typeof stickers.setActive !== 'function') return false;
    const order = ['two_face_dormer', 'three_face_dormer', 'curved_dormer'].filter(id => stickers.defs.has(id));
    if (!order.length) return false;
    const currentIdx = (stickers.isPlacing && order.includes(stickers.activeId)) ? order.indexOf(stickers.activeId) : -1;
    stickers.setActive(order[(currentIdx + 1) % order.length]);
    return true;
}

function applySourceHeightToNewPoint(pt, sourcePt) {
    if (!pt || !sourcePt) return false;
    let sourceZ = (sourcePt.z === null || sourcePt.z === undefined) ? NaN : Number(sourcePt.z);
    if (!Number.isFinite(sourceZ) && typeof layerData !== 'undefined' && layerData && layerData.dsm && layerData.dsm[0]) {
        const ix = Math.max(0, Math.min(imageWidth - 1, Math.round(sourcePt.x)));
        const iy = Math.max(0, Math.min(imageHeight - 1, Math.round(sourcePt.y)));
        const sampledZ = layerData.dsm[0][iy * imageWidth + ix];
        if (sampledZ > -9000) sourceZ = sampledZ;
    }
    if (!Number.isFinite(sourceZ)) return false;
    pt.z = sourceZ;
    pt.zLocked = true;
    if (pt._lockedPlanes) delete pt._lockedPlanes;
    return true;
}
// ============================================================
// DROP-IN REPLACEMENTS — _lockedPlanes undo/redo persistence
// Replace the 4 functions below in interaction_2d.js
// ============================================================

function save2DState() {
    if (!activeGeometry) return;
    // ✅ Mark that geometry *may* have changed (used to gate heavy renders)
    window.__geoMutStamp = (window.__geoMutStamp || 0) + 1;
    
    // 1. Serialize Points (✅ now includes _lockedPlanes)
    const pts = activeGeometry.points.map(p => ({
        x: p.x, y: p.y, z: p.z, layer: p.layer || 1, zLocked: !!p.zLocked,
        _lockedPlanes: p._lockedPlanes ? p._lockedPlanes.map(pl => ({a:pl.a, b:pl.b, c:pl.c})) : undefined
    }));
    
    // 2. Serialize Connections
    const conns = activeGeometry.connections.map(c => {
        const sIdx = activeGeometry.points.indexOf(c.start);
        const eIdx = activeGeometry.points.indexOf(c.end);
        return { idx: [sIdx, eIdx], type: c.type, manualType: !!c.manualType };
    });
    // 3. Serialize Vents
    const vents = (activeGeometry.vents || []).map(v => ({ ...v }));
    
    // 4. Serialize Blocked Faces
    const blockedFaces = (typeof deletedFaceSignatures !== 'undefined') ? Array.from(deletedFaceSignatures) : [];
    // 5. Serialize Manual Faces (Updated to include holes)
    const manualFaces = (activeGeometry.manualFaces || []).map(mf => {
        return {
            p: mf.points.map(p => activeGeometry.points.indexOf(p)),
            h: (mf.holes || []).map(hole => hole.map(p => activeGeometry.points.indexOf(p))),
            l: mf.layer || 1
        };
    });
    // --- NEW: Serialize Selection State ---
    const selectionState = {
        mode: typeof selectionMode !== 'undefined' ? selectionMode : 'POINT',
        points: [],
        lines: [], // Store as index in activeGeometry.connections
        vents: []  // Store as index in activeGeometry.vents
    };
    // Map selected objects to indices
    if (typeof selectedPoints !== 'undefined') {
        selectedPoints.forEach(p => {
            const idx = activeGeometry.points.indexOf(p);
            if (idx !== -1) selectionState.points.push(idx);
        });
    }
    if (typeof selectedLines !== 'undefined') {
        selectedLines.forEach(l => {
            const idx = activeGeometry.connections.indexOf(l);
            if (idx !== -1) selectionState.lines.push(idx);
        });
    }
    if (typeof selectedVents !== 'undefined') {
        selectedVents.forEach(v => {
            const idx = activeGeometry.vents ? activeGeometry.vents.indexOf(v) : -1;
            if (idx !== -1) selectionState.vents.push(idx);
        });
    }
    // Push to history
    history2D.push({ 
        p: pts, 
        c: conns, 
        v: vents, 
        df: blockedFaces, 
        mf: manualFaces,
        sel: selectionState // Save selection
    });
    
    // --- CHANGE: Increased Undo History Limit from 20 to 500 ---
    if (history2D.length > 500) history2D.shift();
    
    redo2D = [];
}

function restore2DState(state) {
    if (!state) return;
    
    // 1. Restore Points (✅ now deep-clones _lockedPlanes)
    activeGeometry.points = state.p.map(p => {
        const pt = { ...p };
        if (pt._lockedPlanes) pt._lockedPlanes = pt._lockedPlanes.map(pl => ({a:pl.a, b:pl.b, c:pl.c}));
        return pt;
    });
    
    // 2. Restore Connections
    activeGeometry.connections = [];
    state.c.forEach(cData => {
        const idxPair = cData.idx;
        if (activeGeometry.points[idxPair[0]] && activeGeometry.points[idxPair[1]]) {
            activeGeometry.connections.push({
                start: activeGeometry.points[idxPair[0]],
                end: activeGeometry.points[idxPair[1]],
                type: cData.type,
                manualType: !!cData.manualType
            });
        }
    });
    // 3. Restore Vents
    activeGeometry.vents = (state.v || []).map(v => ({ ...v }));
    // 4. Restore Deleted Faces
    if (typeof deletedFaceSignatures !== 'undefined') {
        deletedFaceSignatures.clear();
        if (state.df && Array.isArray(state.df)) {
            state.df.forEach(sig => deletedFaceSignatures.add(sig));
        }
    }
    // 5. Restore Manual Faces
    activeGeometry.manualFaces = [];
    if (state.mf && Array.isArray(state.mf)) {
        state.mf.forEach(item => {
            if (Array.isArray(item)) {
                const facePts = item.map(idx => activeGeometry.points[idx]).filter(p => p);
                if (facePts.length >= 3) {
                    activeGeometry.manualFaces.push({
                        points: facePts,
                        holes: [],
                        layer: facePts[0].layer || 1
                    });
                }
            } else {
                const facePts = item.p.map(idx => activeGeometry.points[idx]).filter(p => p);
                if (facePts.length >= 3) {
                    const holes = (item.h || []).map(hIndices => 
                        hIndices.map(idx => activeGeometry.points[idx]).filter(p => p)
                    ).filter(h => h.length >= 3);
                    
                    activeGeometry.manualFaces.push({
                        points: facePts,
                        holes: holes,
                        layer: item.l || 1
                    });
                }
            }
        });
    }
    // 6. Restore Selection State
    selectedPoints.clear();
    selectedLines.clear();
    selectedVents.clear();
    if (typeof selectedFaceSignatures !== 'undefined') selectedFaceSignatures.clear();
    if (state.sel) {
        // Safety check: If history has FACE mode, force it to POINT mode
        if (state.sel.mode === 'FACE') {
            selectionMode = 'POINT';
        } else {
            selectionMode = state.sel.mode || 'POINT';
        }
        if (state.sel.points && Array.isArray(state.sel.points)) {
            state.sel.points.forEach(idx => {
                if (activeGeometry.points[idx]) selectedPoints.add(activeGeometry.points[idx]);
            });
        }
        if (state.sel.lines && Array.isArray(state.sel.lines)) {
            state.sel.lines.forEach(idx => {
                if (activeGeometry.connections[idx]) selectedLines.add(activeGeometry.connections[idx]);
            });
        }
        if (state.sel.vents && Array.isArray(state.sel.vents)) {
            state.sel.vents.forEach(idx => {
                if (activeGeometry.vents && activeGeometry.vents[idx]) selectedVents.add(activeGeometry.vents[idx]);
            });
        }
    }
    
    // CRITICAL ORDER:
    // 1. Render Visuals (Rebuilds facesGroup)
    renderGeometry2D();
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
    if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
    if (typeof renderFinalPass === 'function') renderFinalPass();
    // 2. Recalculate Data (Uses facesGroup)
    if (typeof recalculateMeasurementData === 'function' && typeof lastRoofReport !== 'undefined' && lastRoofReport) {
        recalculateMeasurementData();
        if (typeof isMeasurementMode !== 'undefined' && isMeasurementMode && typeof updateMeasurementUI === 'function') {
            updateMeasurementUI();
        }
    }
    
    const lbl = document.getElementById('modeLabel');
    if(lbl) {
        lbl.textContent = selectionMode + ' MODE';
        lbl.style.backgroundColor = ""; 
        lbl.style.color = "";
    }
    if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
}

function undo2D() {
    if (history2D.length === 0) return;
    // ✅ Deep-clone _lockedPlanes in current-state snapshot
    const currentPts = activeGeometry.points.map(p => {
        const copy = {...p};
        if (copy._lockedPlanes) copy._lockedPlanes = copy._lockedPlanes.map(pl => ({a:pl.a, b:pl.b, c:pl.c}));
        return copy;
    });
    const currentConns = activeGeometry.connections.map(c => ({
        idx: [activeGeometry.points.indexOf(c.start), activeGeometry.points.indexOf(c.end)],
        type: c.type,
        manualType: !!c.manualType
    }));
    const currentVents = (activeGeometry.vents || []).map(v => ({...v}));
    const currentDF = (typeof deletedFaceSignatures !== 'undefined') ? Array.from(deletedFaceSignatures) : [];
    redo2D.push({ p: currentPts, c: currentConns, v: currentVents, df: currentDF });
    const prev = history2D.pop();
    restore2DState(prev);
}

function redo2DAction() {
    if (redo2D.length === 0) return;
    // ✅ Deep-clone _lockedPlanes in current-state snapshot
    const currentPts = activeGeometry.points.map(p => {
        const copy = {...p};
        if (copy._lockedPlanes) copy._lockedPlanes = copy._lockedPlanes.map(pl => ({a:pl.a, b:pl.b, c:pl.c}));
        return copy;
    });
    const currentConns = activeGeometry.connections.map(c => ({
        idx: [activeGeometry.points.indexOf(c.start), activeGeometry.points.indexOf(c.end)],
        type: c.type,
        manualType: !!c.manualType
    }));
    const currentVents = (activeGeometry.vents || []).map(v => ({...v}));
    const currentDF = (typeof deletedFaceSignatures !== 'undefined') ? Array.from(deletedFaceSignatures) : [];
    history2D.push({ p: currentPts, c: currentConns, v: currentVents, df: currentDF });
    const next = redo2D.pop();
    restore2DState(next);
}
function handleCreateFace() {
    if (!activeGeometry) return;
    // --- Gather edges from ALL selection sources ---
    const edgeSet = new Set();
    const relevantPoints = new Set();
    // 1) Any explicitly selected lines are always included
    selectedLines.forEach(l => {
        edgeSet.add(l);
        relevantPoints.add(l.start);
        relevantPoints.add(l.end);
    });
    // 2) Any explicitly selected points contribute their mutual connections
    selectedPoints.forEach(p => relevantPoints.add(p));
    // 3) Find connections where BOTH endpoints are in the relevant set
    activeGeometry.connections.forEach(conn => {
        if (relevantPoints.has(conn.start) && relevantPoints.has(conn.end)) {
            edgeSet.add(conn);
        }
    });
    const edges = Array.from(edgeSet);
    if (edges.length < 3) {
        console.log("Create Face: Not enough connected geometry selected.");
        return;
    }
    const adj = new Map();
    edges.forEach(conn => {
        if (!adj.has(conn.start)) adj.set(conn.start, []);
        if (!adj.has(conn.end)) adj.set(conn.end, []);
        adj.get(conn.start).push({ pt: conn.end, conn: conn });
        adj.get(conn.end).push({ pt: conn.start, conn: conn });
    });
    const cycles = window.extractCyclesFromSubset(adj);
    if (cycles.length === 0) {
        console.log("Create Face: No closed loops found.");
        return;
    }
    // Sort by Area (Largest is the container)
    cycles.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outer = cycles[0];
    outer.holes = [];
    // Check smaller cycles. If they are inside the Outer, they are holes.
    for (let i = 1; i < cycles.length; i++) {
        const potentialHole = cycles[i];
        if (window.isPolyInsidePoly(potentialHole.points, outer.points)) {
            outer.holes.push(potentialHole.points);
            console.log("Detected hole inside manual face.");
        }
    }
    if (!activeGeometry.manualFaces) activeGeometry.manualFaces = [];
    const sig = getLocalFaceSignature(outer.points);
    let changed = false;
    // Unblock if previously deleted
    if (typeof deletedFaceSignatures !== 'undefined' && deletedFaceSignatures.has(sig)) {
        deletedFaceSignatures.delete(sig);
        changed = true;
        console.log("Restored blocked face.");
    }
    // Check if exists
    const alreadyManual = activeGeometry.manualFaces.some(mf => getLocalFaceSignature(mf.points) === sig);
    if (!alreadyManual) {
        activeGeometry.manualFaces.push({
            points: outer.points,
            holes: outer.holes,
            layer: outer.points[0].layer || 1
        });
        changed = true;
        console.log("Face forced manually with " + outer.holes.length + " holes.");
    }
    if (changed) {
        save2DState();
        invalidateFaceCache();
        if (typeof renderFinalPass === 'function') renderFinalPass();
        checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate();
    }
}
window.extractCyclesFromSubset = function(adj) {
    const cycles = [];
    const visitedNodes = new Set();
    for (let [startNode, neighbors] of adj) {
        if (visitedNodes.has(startNode)) continue;
        if (neighbors.length !== 2) continue;
        const path = [startNode];
        visitedNodes.add(startNode);
        
        let curr = startNode;
        let prev = null;
        let isClosed = false;
        while (true) {
            const nList = adj.get(curr);
            if (!nList || nList.length !== 2) { isClosed = false; break; }
            let nextData = nList.find(n => n.pt !== prev);
            
            if (nextData && nextData.pt === startNode) {
                isClosed = true;
                break;
            }
            if (!nextData || visitedNodes.has(nextData.pt)) {
                isClosed = false;
                break;
            }
            visitedNodes.add(nextData.pt);
            path.push(nextData.pt);
            prev = curr;
            curr = nextData.pt;
        }
        if (isClosed && path.length >= 3) {
            let area = 0;
            for(let i=0; i<path.length; i++) {
                const p1 = path[i];
                const p2 = path[(i+1)%path.length];
                area += (p1.x * p2.y - p2.x * p1.y);
            }
            cycles.push({ points: path, area: area * 0.5 });
        }
    }
    return cycles;
}
window.isPolyInsidePoly = function(inner, outer) {
    let cx = 0, cy = 0;
    for(let p of inner) { cx += p.x; cy += p.y; }
    cx /= inner.length; cy /= inner.length;
    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const xi = outer[i].x, yi = outer[i].y;
        const xj = outer[j].x, yj = outer[j].y;
        const intersect = ((yi > cy) !== (yj > cy)) && (cx < (xj - xi) * (cy - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
function getLocalFaceSignature(points) {
    const coords = points.map(p => ({x: Math.round(p.x*10), y: Math.round(p.y*10)}));
    coords.sort((a,b) => (a.x - b.x) || (a.y - b.y));
    return coords.map(p => `${p.x},${p.y}`).join('|');
}
function lineIntersectsRect(p1, p2, r1, r2) {
    const minX = Math.min(r1.x, r2.x);
    const maxX = Math.max(r1.x, r2.x);
    const minY = Math.min(r1.y, r2.y);
    const maxY = Math.max(r1.y, r2.y);
    if ((p1.x >= minX && p1.x <= maxX && p1.y >= minY && p1.y <= maxY) ||
        (p2.x >= minX && p2.x <= maxX && p2.y >= minY && p2.y <= maxY)) {
        return true;
    }
    const edges = [
        [{x:minX, y:minY}, {x:maxX, y:minY}],
        [{x:maxX, y:minY}, {x:maxX, y:maxY}],
        [{x:maxX, y:maxY}, {x:minX, y:maxY}],
        [{x:minX, y:maxY}, {x:minX, y:minY}]
    ];
    function segmentsIntersect(a, b, c, d) {
        const det = (b.x - a.x) * (d.y - c.y) - (d.x - c.x) * (b.y - a.y);
        if (det === 0) return false;
        const lambda = ((d.y - c.y) * (d.x - a.x) + (c.x - d.x) * (d.y - a.y)) / det;
        const gamma = ((a.y - b.y) * (d.x - a.x) + (b.x - a.x) * (d.y - a.y)) / det;
        return (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1);
    }
    for (let edge of edges) {
        if (segmentsIntersect(p1, p2, edge[0], edge[1])) return true;
    }
    return false;
}
function handleParallelLines() {
    if (selectedLines.size < 2) return;
    const lines = Array.from(selectedLines);
    const currentSignature = lines.map(l => activeGeometry.connections.indexOf(l)).sort().join(',');
    if (parallelState.signature !== currentSignature) {
        save2DState();
        parallelState.originals = new Map();
        
        lines.forEach(l => {
            if(!parallelState.originals.has(l.start)) parallelState.originals.set(l.start, { x: l.start.x, y: l.start.y });
            if(!parallelState.originals.has(l.end))   parallelState.originals.set(l.end,   { x: l.end.x,   y: l.end.y });
        });
        parallelState.signature = currentSignature;
        parallelState.index = 0;
        lines.sort((a, b) => {
            const lenA = Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y);
            const lenB = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y);
            return lenB - lenA; 
        });
    } else {
        parallelState.originals.forEach((val, pt) => {
            pt.x = val.x;
            pt.y = val.y;
        });
        parallelState.index = (parallelState.index + 1) % lines.length;
    }
    const driver = lines[parallelState.index % lines.length];
    const dxDriver = driver.end.x - driver.start.x;
    const dyDriver = driver.end.y - driver.start.y;
    const driverAngle = Math.atan2(dyDriver, dxDriver);
    const toProcess = new Set(lines);
    toProcess.delete(driver);
    const fixedPoints = new Set([driver.start, driver.end]);
    while (toProcess.size > 0) {
        let line = null;
        let anchor = null; 
        
        for (let candidate of toProcess) {
            if (fixedPoints.has(candidate.start)) {
                line = candidate;
                anchor = candidate.start;
                break;
            } else if (fixedPoints.has(candidate.end)) {
                line = candidate;
                anchor = candidate.end;
                break;
            }
        }
        if (line && anchor) {
            const movingPt = (line.start === anchor) ? line.end : line.start;
            
            if (fixedPoints.has(movingPt)) {
                toProcess.delete(line);
                continue;
            }
            const dx = movingPt.x - anchor.x;
            const dy = movingPt.y - anchor.y;
            const len = Math.hypot(dx, dy);
            const currentAngle = Math.atan2(dy, dx);
            let diff = currentAngle - driverAngle;
            while (diff <= -Math.PI) diff += Math.PI*2;
            while (diff > Math.PI) diff -= Math.PI*2;
            let targetAngle = driverAngle;
            if (Math.abs(diff) > Math.PI/2) {
                targetAngle += Math.PI;
            }
            movingPt.x = anchor.x + len * Math.cos(targetAngle);
            movingPt.y = anchor.y + len * Math.sin(targetAngle);
            fixedPoints.add(movingPt);
            toProcess.delete(line);
        } else {
            line = toProcess.values().next().value;
            
            const dxLine = line.end.x - line.start.x;
            const dyLine = line.end.y - line.start.y;
            
            const dot = dxDriver * dxLine + dyDriver * dyLine;
            const targetAngle = (dot < 0) ? (driverAngle + Math.PI) : driverAngle;
            
            const cx = (line.start.x + line.end.x) / 2;
            const cy = (line.start.y + line.end.y) / 2;
            const len = Math.hypot(dxLine, dyLine);
            const halfLen = len / 2;
            
            line.start.x = cx - halfLen * Math.cos(targetAngle);
            line.start.y = cy - halfLen * Math.sin(targetAngle);
            line.end.x = cx + halfLen * Math.cos(targetAngle);
            line.end.y = cy + halfLen * Math.sin(targetAngle);
            fixedPoints.add(line.start);
            fixedPoints.add(line.end);
            toProcess.delete(line);
        }
    }
    renderGeometry2D();
    renderGeometry3D();
    checkAndTriggerMeasurementUpdate();
}
let __geoRAF = 0;
window.__renderFrameAnalytics = window.__renderFrameAnalytics || {
  enabled: true,
  samples: [],
  maxSamples: 120,
  logEvery: 60,
  totalFrames: 0,
  lastSummary: null
};
window.__recordRenderFrameAnalytics = function(sample) {
  const analytics = window.__renderFrameAnalytics;
  if (!analytics || !analytics.enabled || !sample) return;
  const total = Number(sample.totalMs) || 0;
  const finalPass = Number(sample.finalPassMs) || 0;
  const row = {
    label: sample.label || 'frame',
    state: typeof interactState !== 'undefined' ? interactState : '',
    totalMs: total,
    render2DMs: Number(sample.render2DMs) || 0,
    render3DMs: Number(sample.render3DMs) || 0,
    finalPassMs: finalPass,
    finalPassPct: total > 0 ? (finalPass / total) * 100 : 0,
    at: performance.now()
  };
  analytics.samples.push(row);
  if (analytics.samples.length > analytics.maxSamples) analytics.samples.shift();
  analytics.totalFrames += 1;
  if (analytics.totalFrames % analytics.logEvery === 0) {
    window.printRenderFrameAnalytics();
  }
};
window.printRenderFrameAnalytics = function() {
  const analytics = window.__renderFrameAnalytics;
  const samples = analytics && analytics.samples ? analytics.samples : [];
  if (!samples.length) {
    console.info('[RenderAnalytics] No samples yet.');
    return null;
  }
  const sums = samples.reduce((acc, s) => {
    acc.total += s.totalMs;
    acc.render2D += s.render2DMs;
    acc.render3D += s.render3DMs;
    acc.finalPass += s.finalPassMs;
    return acc;
  }, { total: 0, render2D: 0, render3D: 0, finalPass: 0 });
  const n = samples.length;
  const summary = {
    samples: n,
    avgTotalMs: +(sums.total / n).toFixed(2),
    avg2DMs: +(sums.render2D / n).toFixed(2),
    avg3DMs: +(sums.render3D / n).toFixed(2),
    avgFinalPassMs: +(sums.finalPass / n).toFixed(2),
    finalPassPct: +(sums.total > 0 ? (sums.finalPass / sums.total) * 100 : 0).toFixed(1),
    lastFinalPassMs: +(samples[n - 1].finalPassMs).toFixed(2),
    lastFinalPassPct: +(samples[n - 1].finalPassPct).toFixed(1)
  };
  analytics.lastSummary = summary;
  console.info('[RenderAnalytics]', summary);
  return summary;
};
function requestGeoRender() {
  if (__geoRAF) return;
  __geoRAF = requestAnimationFrame(() => {
    __geoRAF = 0;
    const frameStart = performance.now();
    const render2DStart = performance.now();
    renderGeometry2D();
    const render2DMs = performance.now() - render2DStart;
    window.__recordRenderFrameAnalytics({
      label: 'requestGeoRender',
      totalMs: performance.now() - frameStart,
      render2DMs,
      render3DMs: 0,
      finalPassMs: 0
    });
  });
}
function handleFlattenPoints() {
    // --- Gather points from ALL selection sources ---
    const pointSet = new Set();
    selectedPoints.forEach(p => pointSet.add(p));
    selectedLines.forEach(l => {
        pointSet.add(l.start);
        pointSet.add(l.end);
    });
    if (pointSet.size < 2) return;
    const points = Array.from(pointSet);
    if (typeof layerData !== 'undefined' && layerData.dsm && layerData.dsm[0]) {
        const dsm = layerData.dsm[0];
        const w = (typeof imageWidth !== 'undefined') ? imageWidth : 0;
        if (w > 0) {
            points.forEach(p => {
                if(p._lockedPlanes && p._lockedPlanes.length > 0) return;
                if (p.z === null || p.z === undefined) {
                    const ix = Math.max(0, Math.min(imageWidth - 1, Math.round(p.x)));
                    const iy = Math.max(0, Math.min(imageHeight - 1, Math.round(p.y)));
                    const val = dsm[iy * imageWidth + ix];
                    if (val > -9000) {
                        p.z = val;
                    }
                }
            });
        }
    }
    const currentSignature = points.map(p => activeGeometry.points.indexOf(p)).sort().join(',');
    if (flattenState.signature !== currentSignature) {
        save2DState();
        flattenState.originals = new Map();
        points.forEach(p => flattenState.originals.set(p, p.z !== null ? p.z : 0));
        flattenState.signature = currentSignature;
        flattenState.index = 0;
        points.sort((a, b) => (b.z || 0) - (a.z || 0));
    }
    else {
        points.forEach(p => {
            if(p._lockedPlanes && p._lockedPlanes.length > 0) return;
            if (flattenState.originals.has(p)) {
                p.z = flattenState.originals.get(p);
            }
        });
        flattenState.index = (flattenState.index + 1) % points.length;
    }
    const driver = points[flattenState.index % points.length];
    const targetZ = driver.z !== null ? driver.z : 0;
    points.forEach(p => {
        if(p._lockedPlanes && p._lockedPlanes.length > 0) return;
        p.z = targetZ;
        p.zLocked = true;
    });
    renderGeometry3D();
    if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
    if (typeof renderFinalPass === 'function') renderFinalPass(false);
    triggerLiveUpdate();
    checkAndTriggerMeasurementUpdate();
}
function setLayerForSelection(layerNum) {
    if (!activeGeometry) return;
    save2DState();
    let pointsToSwitch = new Set();
    if (selectionMode === 'POINT') {
        selectedPoints.forEach(p => pointsToSwitch.add(p));
    } else {
        selectedLines.forEach(l => {
            pointsToSwitch.add(l.start);
            pointsToSwitch.add(l.end);
        });
    }
    activeGeometry.connections = activeGeometry.connections.filter(conn => {
        const sSwapping = pointsToSwitch.has(conn.start);
        const eSwapping = pointsToSwitch.has(conn.end);
        if (sSwapping && eSwapping) return true;
        if (!sSwapping && !eSwapping) return true;
        return false;
    });
    pointsToSwitch.forEach(p => p.layer = layerNum);
    renderGeometry2D();
    renderGeometry3D();
    triggerLiveUpdate();
    checkAndTriggerMeasurementUpdate();
}
function cycleSelectionMode() {
    if (interactState === 'PLACING_VENTS') return; 
    // Removed FACE mode from the cycle
    if (selectionMode === 'POINT') selectionMode = 'LINE';
    else selectionMode = 'POINT'; 
    selectedPoints.clear();
    selectedLines.clear();
    selectedVents.clear();
    if (typeof selectedFaces !== 'undefined') selectedFaces.clear(); 
    if (typeof selectedFaceSignatures !== 'undefined') selectedFaceSignatures.clear();
    
    const lbl = document.getElementById('modeLabel');
    if(lbl) {
        lbl.textContent = selectionMode + ' MODE';
        // Removed specific styling for FACE mode
        lbl.style.backgroundColor = ""; 
        lbl.style.color = "";
    }
    
    renderGeometry2D();
    if(typeof renderGeometry3D === 'function') renderGeometry3D();
    if(typeof updateVisualsOnly === 'function') updateVisualsOnly(); 
}
function getDistToSegment(p, v, w) {
    const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = v.x + t * (w.x - v.x);
    const projY = v.y + t * (w.y - v.y);
    return Math.hypot(p.x - projX, p.y - projY);
}
let are2DListenersAttached = false;
function setup2DListeners() {
    if (are2DListenersAttached) return;
    are2DListenersAttached = true;
    const viewport = document.getElementById('viewport');
    
    // --- NEW: Global var for Nudge Grouping ---
    window.nudgeGroupTimer = null;
    window.isNudgeSequenceActive = false;
    // Helper to reset nudge sequence
    const resetNudgeGroup = () => {
        if (window.nudgeGroupTimer) clearTimeout(window.nudgeGroupTimer);
        window.nudgeGroupTimer = null;
        window.isNudgeSequenceActive = false;
    };
    window.addEventListener('resize', () => {
        requestAnimationFrame(() => {
             updateTransform(); 
             redrawCanvas();    
             if (typeof renderGeometry2D === 'function') renderGeometry2D();
        });
    });
    let isRotatingView = false;
    let lastRotX = 0;
    viewport.addEventListener('contextmenu', e => e.preventDefault());
    viewport.addEventListener('dblclick', (e) => {
        resetNudgeGroup(); // Break nudge sequence on interaction
        if (window.SmartStickers?.isPlacing || (window.__SMART_STICKER_SUPPRESS_DBLCLICK_UNTIL || 0) > Date.now()) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
        if (!activeGeometry) return;
        if (interactState !== 'IDLE' && interactState !== 'SELECTING') return;
        // --- FIX: Prevent double click from creating points if in LINE mode ---
        if (selectionMode === 'LINE') return;
        const coords = screenToImage(e.clientX, e.clientY);
        const mouseTol = 10 / currentZoom;
        const existing = getClosestPoint(coords.x, coords.y, 5 / currentZoom);
        if (existing) {
            // If Shift is NOT held, clear previous selection.
            if (!e.shiftKey) {
                selectedPoints.clear(); selectedLines.clear(); selectedVents.clear();
            }
            selectedPoints.add(existing);
            renderGeometry2D();
            return; 
        }
        save2DState(); 
        const splitPt = attemptLineSplit(coords.x, coords.y, mouseTol);
        if (splitPt) {
            // If Shift is NOT held, clear previous selection.
            if (!e.shiftKey) {
                selectedPoints.clear(); selectedLines.clear(); selectedVents.clear();
            }
            selectedPoints.add(splitPt);
            checkAndTriggerMeasurementUpdate();
        } else {
            let targetLayer = 1;
            for(let i=1; i<=6; i++) {
                if(layerVisibility[i]) {
                    targetLayer = i;
                    break;
                }
            }
            
            if (!layerVisibility[targetLayer]) return;
            const newPt = { x: coords.x, y: coords.y, z: null, layer: targetLayer, zLocked: false };
            activeGeometry.points.push(newPt);
            
            // If Shift is NOT held, clear previous selection.
            if (!e.shiftKey) {
                selectedPoints.clear(); selectedLines.clear(); selectedVents.clear();
            }
            selectedPoints.add(newPt);
        }
        renderGeometry2D(); renderGeometry3D(); triggerLiveUpdate();
    });
    viewport.addEventListener('mousedown', (e) => {
        resetNudgeGroup(); // Break nudge sequence on click
        if (e.button === 2) {
            isRotatingView = true;
            lastRotX = e.clientX;
            viewport.style.cursor = 'ew-resize';
            return;
        }
        if (e.button === 1) { 
            e.preventDefault(); isPanning = true;
            dragStartX = e.clientX; dragStartY = e.clientY;
            viewport.style.cursor = 'grabbing';
            return;
        }
        if (e.button === 0) {
            if (typeof isSplatMode !== 'undefined' && isSplatMode) {
                handleSplatClick(e.clientX, e.clientY);
                return; // Don't trigger standard selection
            }
            dragStartX = e.clientX; 
            dragStartY = e.clientY;
            
            const coords = screenToImage(e.clientX, e.clientY);
            
            if (interactState === 'QUAD_CREATE') {
                handleQuadClick(e);
                return;
            }
            
            const snapInd = document.getElementById('snap-indicator');
            if(snapInd) snapInd.style.display = 'none';
            if (interactState === 'ROTATING') {
                interactState = 'IDLE';
                document.body.style.cursor = 'default';
                renderGeometry3D(); 
                checkAndTriggerMeasurementUpdate();
                return; 
            }
            if (interactState === 'RESIZING') {
                interactState = 'IDLE';
                document.body.style.cursor = 'default';
                renderGeometry3D();
                checkAndTriggerMeasurementUpdate();
                triggerLiveUpdate();
                return;
            }
            
            if (interactState === 'UNDERWALL') {
                // left click commits
                __uwCommitPreview();
                // stay in underwall mode after commit? (you can choose)
                // For now, stay active so user can draw multiple segments.
                return;
            }
            if (interactState === 'PLACING_VENTS') {
                if (ventPlacementCount > 0) {
                    save2DState();
                    if(!activeGeometry.vents) activeGeometry.vents = [];
                    
                    const finalX = lastValidVentSnap ? lastValidVentSnap.x : coords.x;
                    const finalY = lastValidVentSnap ? lastValidVentSnap.y : coords.y;
                    
                    activeGeometry.vents.push({ x: finalX, y: finalY, layer: 1 });
                    
                    lastValidVentSnap = null;
                    
                    ventPlacementCount--;
                    const modeLabel = document.getElementById('modeLabel');
                    if(modeLabel) modeLabel.textContent = `PLACE VENTS (${ventPlacementCount} LEFT)`;
                    if (typeof updateMeasurementUI === 'function') updateMeasurementUI();
                    renderGeometry2D();
                    if (ventPlacementCount === 0) {
                        setTimeout(() => {
                            if (typeof exitVentPlacementMode === 'function') exitVentPlacementMode();
                            else { interactState = 'IDLE'; if (typeof updateMeasurementUI === 'function') updateMeasurementUI(); renderGeometry2D(); }
                        }, 50);
                    }
                }
                return;
            }
            
            if (interactState === 'MOVING') {
                save2DState(); 
                finalizeMoveLogic();
                interactState = 'IDLE'; 
                renderGeometry2D(); 
                renderGeometry3D();
                checkAndTriggerMeasurementUpdate();
            }
            
            else if (interactState === 'NEW_POINT') {
                if (tempPoint) {
                    save2DState();
                    const mouseTol = 10 / currentZoom;
                    const sourceLayer = tempPoint.layer || 1; 
                    const snapTarget = getClosestPoint(tempPoint.x, tempPoint.y, snapRadius / currentZoom, selectedPoints);
                    let finalPt = null;
                    let finalPtIsNew = false;
                    if (snapTarget) {
                        if (snapTarget.layer === sourceLayer) finalPt = snapTarget;
                        else { finalPt = tempPoint; finalPt.x = snapTarget.x; finalPt.y = snapTarget.y; finalPt.layer = sourceLayer; finalPtIsNew = true; }
                    } else {
                        // Check midpoints if enabled
                        let midSnap = null;
                        if (typeof showCenterpoints !== 'undefined' && showCenterpoints) {
                             midSnap = getClosestMidpoint(tempPoint.x, tempPoint.y, snapRadius / currentZoom, selectedPoints);
                        }
                        
                        if (midSnap && midSnap.conn) {
                            // SPLIT THE LINE AT MIDPOINT
                            const targetLineLayer = midSnap.conn.start.layer || 1;
                            if (targetLineLayer === sourceLayer) {
                                finalPt = splitConnection(midSnap.conn, midSnap.x, midSnap.y, sourceLayer);
                                finalPtIsNew = true;
                            } else {
                                // Layer mismatch: just place point on top
                                finalPt = tempPoint; 
                                finalPt.x = midSnap.x; 
                                finalPt.y = midSnap.y; 
                                finalPt.layer = sourceLayer; 
                                activeGeometry.points.push(finalPt);
                                finalPtIsNew = true;
                            }
                        } else {
                            const lineHit = findClosestLine(tempPoint.x, tempPoint.y, mouseTol);
                            if (lineHit) {
                                const targetLineLayer = lineHit.conn.start.layer || 1;
                                if (targetLineLayer === sourceLayer) { finalPt = splitConnection(lineHit.conn, lineHit.x, lineHit.y, sourceLayer); finalPtIsNew = true; }
                                else { finalPt = tempPoint; finalPt.x = lineHit.x; finalPt.y = lineHit.y; finalPt.layer = sourceLayer; activeGeometry.points.push(finalPt); finalPtIsNew = true; }
                            } else { finalPt = tempPoint; activeGeometry.points.push(finalPt); finalPtIsNew = true; }
                        }
                    }
                    if (e.altKey && finalPtIsNew) applySourceHeightToNewPoint(finalPt, newPointSourcePoint);
                    selectedPoints.forEach(sel => {
                        if (sel !== finalPt && sel.layer === finalPt.layer) {
                            const exists = activeGeometry.connections.some(c => (c.start === sel && c.end === finalPt) || (c.start === finalPt && c.end === sel));
                            if (!exists) activeGeometry.connections.push({ start: sel, end: finalPt });
                        }
                    });
                    
                    // --- MODIFIED: Respect Shift key to keep selection ---
                    if (!e.shiftKey) {
                        selectedPoints.clear(); 
                    }
                    selectedPoints.add(finalPt);
                    
                    tempPoint = null; newPointSourcePoint = null; interactState = 'IDLE'; renderGeometry2D(); renderGeometry3D();
                }
            }
            else {
                interactState = 'SELECTING';
                selectionBoxStart = coords;
                parallelState.signature = ''; 
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey) { selectedPoints.clear(); selectedLines.clear(); selectedVents.clear(); }
                const box = document.getElementById('selection-box');
                box.style.display = 'block';
                
                const rect = viewport.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                const relY = e.clientY - rect.top;
                box.style.left = relX + 'px';
                box.style.top = relY + 'px';
                
                selectionBoxScreenStart = { x: relX, y: relY };
                box.style.width = '0px'; box.style.height = '0px';
            }
        }
    });
    viewport.addEventListener('mousemove', (e) => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        // --- RAF throttle (per-handler closure) ---
        // Only schedule one renderGeometry2D per animation frame.
        if (!viewport.__geoRenderRAF) viewport.__geoRenderRAF = 0;
        if (!viewport.__geoRenderPending) viewport.__geoRenderPending = false;
        const scheduleGeoRender = () => {
            if (viewport.__geoRenderPending) return;
            viewport.__geoRenderPending = true;
            viewport.__geoRenderRAF = requestAnimationFrame(() => {
                const frameStart = performance.now();
                let render2DMs = 0;
                let render3DMs = 0;
                let finalPassMs = 0;
                viewport.__geoRenderRAF = 0;
                viewport.__geoRenderPending = false;
                if (typeof renderGeometry2D === 'function') {
                    const t = performance.now();
                    renderGeometry2D();
                    render2DMs = performance.now() - t;
                }
                if (typeof renderGeometry3D === 'function' &&
                    (interactState === 'MOVING' || interactState === 'NEW_POINT')) {
                    const t3 = performance.now();
                    renderGeometry3D();
                    render3DMs = performance.now() - t3;
                    if (typeof renderFinalPass === 'function') {
                        const tf = performance.now();
                        renderFinalPass(true);
                        finalPassMs = performance.now() - tf;
                    }
                }
                if (typeof window.__recordRenderFrameAnalytics === 'function') {
                    window.__recordRenderFrameAnalytics({
                        label: 'mousemoveGeoRender',
                        totalMs: performance.now() - frameStart,
                        render2DMs,
                        render3DMs,
                        finalPassMs
                    });
                }
            });
        };
        if (isRotatingView) {
            const dx = e.clientX - lastRotX;
            lastRotX = e.clientX;
            let speed = e.shiftKey ? 0.001 : 0.01;
            viewRotation += dx * speed;
            // Keep image update immediate (same behavior as before)
            redrawCanvas();
            // Throttled SVG redraw
            scheduleGeoRender();
            return;
        }
        if (e.ctrlKey) updateSnapRing(e.clientX, e.clientY, true);
        if (isPanning) {
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            panX += dx;
            panY += dy;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            updateTransform();
            return;
        }
        if (interactState === 'ROTATING') {
            handleRotationMove(); // this calls renderGeometry2D() internally; we leave it as-is for correctness
            return;
        }
        if (interactState === 'RESIZING') {
            handleResizeMove(); // this calls renderGeometry2D() internally; we leave it as-is for correctness
            return;
        }
        const rect = viewport.getBoundingClientRect();
        if (
            interactState !== 'SELECTING' &&
            interactState !== 'MOVING' &&
            (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)
        ) return;
        const coords = screenToImage(e.clientX, e.clientY);
        const mouseXRel = e.clientX - rect.left;
        const mouseYRel = e.clientY - rect.top;
        
        if (interactState === 'UNDERWALL') {
            __uwUpdatePreviewFromCursor(coords);
            // use your throttled renderer
            if (typeof requestGeoRender === 'function') requestGeoRender();
            else if (typeof renderGeometry2D === 'function') renderGeometry2D();
            return;
        }
        if (interactState === 'SELECTING') {
            const startScreenX = selectionBoxScreenStart.x;
            const startScreenY = selectionBoxScreenStart.y;
            const minX = Math.min(startScreenX, mouseXRel);
            const minY = Math.min(startScreenY, mouseYRel);
            const w = Math.abs(startScreenX - mouseXRel);
            const h = Math.abs(startScreenY - mouseYRel);
            const box = document.getElementById('selection-box');
            box.style.left = minX + 'px';
            box.style.top = minY + 'px';
            box.style.width = w + 'px';
            box.style.height = h + 'px';
            return; // no geo render here (box is DOM)
        }
        else if (interactState === 'PLACING_VENTS') {
            let targetX = coords.x;
            let targetY = coords.y;
            activeSnapGuides = [];
            lastValidVentSnap = null;
            if (!isFreeMove) {
            const ventSnap = calculateVentSnapping(targetX, targetY, snapRadius / currentZoom);
            if (ventSnap) {
                targetX = ventSnap.x;
                targetY = ventSnap.y;
                lastValidVentSnap = { x: targetX, y: targetY };
                showSnapIndicator(ventSnap);
            } else {
                const snapInd = document.getElementById('snap-indicator');
                if (snapInd) snapInd.style.display = 'none';
            }
            } else {
            const snapInd = document.getElementById('snap-indicator');
            if (snapInd) snapInd.style.display = 'none';
            }
            // Throttled render
            scheduleGeoRender();
            return;
        }
        else if (interactState === 'MOVING' || interactState === 'NEW_POINT') {
            let targetX = coords.x;
            let targetY = coords.y;
            const snapInd = document.getElementById('snap-indicator');
            if (snapInd) snapInd.style.display = 'none';
            const movingSinglePoint =
            (interactState === 'MOVING' && selectionMode === 'POINT' && selectedPoints.size === 1);
            const isGroupMove =
            (interactState === 'MOVING' && selectionMode === 'POINT' && selectedPoints.size > 1);
            if (isGroupMove && window.moveAnchor) {
            const deltaX = coords.x - window.moveAnchor.mouseX;
            const deltaY = coords.y - window.moveAnchor.mouseY;
            selectedPoints.forEach(pt => {
                if (typeof window.isPointMultiLocked === 'function' && window.isPointMultiLocked(pt)) return;
                const orig = moveOriginals.get(pt);
                if (orig) { pt.x = orig.x + deltaX; pt.y = orig.y + deltaY; }
                // Single-locked: adjust z to stay on plane
                if (typeof window.isPointFacetLocked === 'function' && window.isPointFacetLocked(pt)) {
                    if (typeof window.adjustPointZToLockedPlane === 'function') window.adjustPointZToLockedPlane(pt);
                }
            });
            selectedVents.forEach(v => {
                const orig = moveOriginals.get(v);
                if (orig) { v.x = orig.x + deltaX; v.y = orig.y + deltaY; }
            });
            if (!isFreeMove) {
                const sRad = snapRadius / currentZoom;
                const excludeSet = selectedPoints;
                let bestSnapDelta = { x: 0, y: 0 };
                let minD = sRad;
                let snapped = false;
                for (let pt of selectedPoints) {
                const snapPt = getClosestPoint(pt.x, pt.y, sRad, excludeSet);
                if (snapPt) {
                    const d = Math.hypot(snapPt.x - pt.x, snapPt.y - pt.y);
                    if (d < minD) {
                    minD = d;
                    bestSnapDelta = { x: snapPt.x - pt.x, y: snapPt.y - pt.y };
                    snapped = true;
                    showSnapIndicator(snapPt);
                    }
                } else if (!snapped) {
                    const lineHit = findClosestLine(pt.x, pt.y, 10 / currentZoom);
                    if (lineHit) {
                    const s = lineHit.conn.start;
                    const e2 = lineHit.conn.end;
                    if (!excludeSet.has(s) && !excludeSet.has(e2)) {
                        const d = Math.hypot(lineHit.x - pt.x, lineHit.y - pt.y);
                        if (d < minD) {
                        minD = d;
                        bestSnapDelta = { x: lineHit.x - pt.x, y: lineHit.y - pt.y };
                        snapped = true;
                        }
                    }
                    }
                }
                }
                if (snapped) {
                selectedPoints.forEach(pt => { pt.x += bestSnapDelta.x; pt.y += bestSnapDelta.y; });
                selectedVents.forEach(v => { v.x += bestSnapDelta.x; v.y += bestSnapDelta.y; });
                }
            }
            } else {
            const shouldSnap = !isFreeMove && (interactState === 'NEW_POINT' || movingSinglePoint);
            if (shouldSnap) {
                const sRad = snapRadius / currentZoom;
                const excludeSet = (interactState === 'MOVING') ? selectedPoints : new Set();
                const snapPt = getClosestPoint(targetX, targetY, sRad, excludeSet);
                if (snapPt) {
                targetX = snapPt.x; targetY = snapPt.y; showSnapIndicator(snapPt);
                activeSnapGuides = [];
                } else {
                let midSnap = null;
                if (typeof showCenterpoints !== 'undefined' && showCenterpoints) {
                    midSnap = getClosestMidpoint(targetX, targetY, sRad, excludeSet);
                }
                if (midSnap) {
                    targetX = midSnap.x; targetY = midSnap.y;
                    showSnapIndicator(midSnap);
                    activeSnapGuides = [];
                } else {
                    const complexSnap = getComplexSnap(targetX, targetY, sRad, excludeSet);
                    if (complexSnap) {
                    targetX = complexSnap.x; targetY = complexSnap.y; showSnapIndicator(complexSnap);
                    } else {
                    const angularSnap = getClosestAngularSnap(targetX, targetY, sRad, excludeSet);
                    if (angularSnap) {
                        targetX = angularSnap.x; targetY = angularSnap.y; showSnapIndicator(angularSnap);
                        activeSnapGuides = [];
                    } else {
                        const snapLinePt = getClosestLine(targetX, targetY, sRad, excludeSet);
                        if (snapLinePt) {
                        targetX = snapLinePt.x; targetY = snapLinePt.y; showSnapIndicator(snapLinePt);
                        activeSnapGuides = [];
                        } else {
                        activeSnapGuides = [];
                        }
                    }
                    }
                }
                }
            }
            if (interactState === 'MOVING') {
                if (movingSinglePoint) {
                const pt = selectedPoints.values().next().value;
                if (!(typeof window.isPointMultiLocked === 'function' && window.isPointMultiLocked(pt))) {
                    pt.x = targetX; pt.y = targetY;
                    if (typeof window.isPointFacetLocked === 'function' && window.isPointFacetLocked(pt)) {
                        if (typeof window.adjustPointZToLockedPlane === 'function') window.adjustPointZToLockedPlane(pt);
                    }
                }
                } else {
                if (window.moveAnchor) {
                    const deltaX = coords.x - window.moveAnchor.mouseX;
                    const deltaY = coords.y - window.moveAnchor.mouseY;
                    if (selectionMode === 'LINE') {
                    const uniquePoints = new Set();
                    selectedLines.forEach(l => { uniquePoints.add(l.start); uniquePoints.add(l.end); });
                    uniquePoints.forEach(pt => {
                        if (typeof window.isPointMultiLocked === 'function' && window.isPointMultiLocked(pt)) return;
                        const orig = moveOriginals.get(pt);
                        if (orig) { pt.x = orig.x + deltaX; pt.y = orig.y + deltaY; }
                        if (typeof window.isPointFacetLocked === 'function' && window.isPointFacetLocked(pt)) {
                            if (typeof window.adjustPointZToLockedPlane === 'function') window.adjustPointZToLockedPlane(pt);
                        }
                    });
                    }
                    selectedVents.forEach(v => {
                    const orig = moveOriginals.get(v);
                    if (orig) { v.x = orig.x + deltaX; v.y = orig.y + deltaY; }
                    });
                }
                }
            } else if (interactState === 'NEW_POINT') {
                if (!tempPoint) tempPoint = { x: targetX, y: targetY, z: null };
                else { tempPoint.x = targetX; tempPoint.y = targetY; }
                if (e.altKey) {
                    applySourceHeightToNewPoint(tempPoint, newPointSourcePoint);
                } else if (tempPoint.zLocked && newPointSourcePoint && tempPoint.z === newPointSourcePoint.z) {
                    tempPoint.z = null;
                    tempPoint.zLocked = false;
                }
            }
            }
            // Throttled SVG render (instead of immediate)
            scheduleGeoRender();
            return;
        }
    });
    window.addEventListener('mouseup', (e) => {
        if (isRotatingView) { isRotatingView = false; viewport.style.cursor = 'default'; }
        if (isPanning) { isPanning = false; viewport.style.cursor = 'default'; }
        activeSnapGuides = [];
        const snapInd = document.getElementById('snap-indicator');
        if(snapInd) snapInd.style.display = 'none';
        if (interactState === 'MOVING') {
            save2DState(); 
            finalizeMoveLogic();
            interactState = 'IDLE'; 
            renderGeometry2D(); 
            renderGeometry3D();
            checkAndTriggerMeasurementUpdate();
        }
        if (interactState === 'SELECTING') {
            const coords = screenToImage(e.clientX, e.clientY);
            const rect = document.getElementById('viewport').getBoundingClientRect();
            const currentScreenX = e.clientX - rect.left;
            const currentScreenY = e.clientY - rect.top;
            const boxL = Math.min(selectionBoxScreenStart.x, currentScreenX);
            const boxR = Math.max(selectionBoxScreenStart.x, currentScreenX);
            const boxT = Math.min(selectionBoxScreenStart.y, currentScreenY);
            const boxB = Math.max(selectionBoxScreenStart.y, currentScreenY);
            const isClick = (Math.abs(e.clientX - dragStartX) < 3 && Math.abs(e.clientY - dragStartY) < 3);
            const hitRad = (10 / currentZoom); 
            const isDeselect = e.ctrlKey || e.metaKey;
            const handleSelection = (set, item) => { if (isDeselect) set.delete(item); else set.add(item); };
            const projectToScreen = (pt) => {
                const cx = imageWidth / 2;
                const cy = imageHeight / 2;
                const dx = pt.x - cx;
                const dy = pt.y - cy;
                const cos = Math.cos(viewRotation || 0);
                const sin = Math.sin(viewRotation || 0);
                const rx = dx * cos - dy * sin;
                const ry = dx * sin + dy * cos;
                const imgX_Rotated = rx + cx;
                const imgY_Rotated = ry + cy;
                const screenX = (imgX_Rotated * currentZoom) + panX;
                const screenY = (imgY_Rotated * currentZoom) + panY;
                return { x: screenX, y: screenY };
            };
            if (activeGeometry) {
                if (selectionMode === 'POINT') {
                    if (isClick) {
                        let foundOne = false;
                        for (let pt of activeGeometry.points) {
                            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) continue;
                            if (!layerVisibility[pt.layer || 1]) continue;
                            if (Math.hypot(pt.x - coords.x, pt.y - coords.y) < hitRad) { handleSelection(selectedPoints, pt); foundOne = true; break; }
                        }
                        if (!foundOne && activeGeometry.vents) {
                            for (let v of activeGeometry.vents) {
                                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(v)) continue;
                                if (!layerVisibility[v.layer || 1]) continue;
                                if (Math.hypot(v.x - coords.x, v.y - coords.y) < hitRad * 2.0) { handleSelection(selectedVents, v); foundOne = true; break; }
                            }
                        }
                    } else {
                        activeGeometry.points.forEach(pt => {
                            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(pt)) return;
                            if (!layerVisibility[pt.layer || 1]) return;
                            const sPt = projectToScreen(pt);
                            if (sPt.x >= boxL && sPt.x <= boxR && sPt.y >= boxT && sPt.y <= boxB) {
                                handleSelection(selectedPoints, pt);
                            }
                        });
                        if (activeGeometry.vents) {
                            activeGeometry.vents.forEach(v => {
                                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(v)) return;
                                if (!layerVisibility[v.layer || 1]) return;
                                const sV = projectToScreen(v);
                                if (sV.x >= boxL && sV.x <= boxR && sV.y >= boxT && sV.y <= boxB) {
                                    handleSelection(selectedVents, v);
                                }
                            });
                        }
                    }
                } 
                else if (selectionMode === 'LINE') {
                    // --- FIX: Handle Click to select Line ---
                    if (isClick) {
                        let foundLine = false;
                        for (let conn of activeGeometry.connections) {
                            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) continue;
                            if (!layerVisibility[conn.start.layer || 1]) continue;
                            const d = getDistToSegment(coords, conn.start, conn.end);
                            if (d < hitRad) {
                                handleSelection(selectedLines, conn);
                                foundLine = true;
                                break; 
                            }
                        }
                        if (!foundLine && activeGeometry.vents) {
                             for (let v of activeGeometry.vents) {
                                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(v)) continue;
                                if (!layerVisibility[v.layer || 1]) continue;
                                if (Math.hypot(v.x - coords.x, v.y - coords.y) < hitRad * 2.0) { handleSelection(selectedVents, v); break; }
                            }
                        }
                    } else {
                        activeGeometry.connections.forEach(conn => {
                            if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
                            if (!layerVisibility[conn.start.layer || 1]) return;
                            const s1 = projectToScreen(conn.start);
                            const s2 = projectToScreen(conn.end);
                            if (lineIntersectsRect(s1, s2, {x: boxL, y: boxT}, {x: boxR, y: boxB})) {
                                handleSelection(selectedLines, conn);
                            }
                        });
                        if (activeGeometry.vents) {
                             activeGeometry.vents.forEach(v => {
                                if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(v)) return;
                                if (!layerVisibility[v.layer || 1]) return;
                                const sV = projectToScreen(v);
                                if (sV.x >= boxL && sV.x <= boxR && sV.y >= boxT && sV.y <= boxB) {
                                    handleSelection(selectedVents, v);
                                }
                            });
                        }
                    }
                }
            }
            
            document.getElementById('selection-box').style.display = 'none';
            interactState = 'IDLE';
            renderGeometry2D();
            if(typeof updateMeasurementUI === 'function') updateMeasurementUI();
        }
        triggerLiveUpdate();
    });
    window.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
        const K = window.KB_MAP;
        const key = e.key;
        const lowerKey = key.toLowerCase();
        // --- Clipboard & History ---
        if (matchesKey(e, K.COPY))  { e.preventDefault(); handleCopy(); return; }
        if (matchesKey(e, K.PASTE)) { e.preventDefault(); handlePaste(); return; }
        if (matchesKey(e, K.UNDO))  { e.preventDefault(); undo2D(); return; }
        if (matchesKey(e, K.REDO))  { e.preventDefault(); redo2DAction(); return; }
        // --- Tools & Modes ---
        if (matchesKey(e, K.ROTATE)) { e.preventDefault(); enterRotationMode(); return; }
        if (matchesKey(e, K.QUAD))   { enterQuadMode({ levelToSource: e.altKey }); return; }
        if (matchesKey(e, K.FLIP))   { e.preventDefault(); handleFlipSelection(); return; }
        if (matchesKey(e, K.RESIZE)) { 
            e.preventDefault(); 
            
            // --- NEW: Check if hovering over 3D View ---
            if (typeof activeController3D !== 'undefined' && activeController3D) {
                if (typeof enterResizeMode3D === 'function') {
                    enterResizeMode3D();
                }
                return;
            }
            // -------------------------------------------
            enterResizeMode(); 
            return; 
        }
        // --- UNDERWALL MODE (U) ---
        if (e.key === 'u' || e.key === 'U') {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (interactState === 'UNDERWALL') {
            __uwExit();
        } else {
            __uwEnter();
        }
        return;
        }

        if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            if (lowerKey === 'w') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                mergeSelectedPointsToCenter();
                return;
            }
            if (lowerKey === 'd') {
                e.preventDefault();
                cycleDormerShortcut();
                return;
            }
            if (lowerKey === 's') {
                e.preventDefault();
                setSmartStickerFromShortcut('curved_face');
                return;
            }
            if (matchesKey(e, K.JERKIN_HEAD)) {
                e.preventDefault();
                setSmartStickerFromShortcut('jerkin_head');
                return;
            }
            if (lowerKey === 'a') {
                e.preventDefault();
                return;
            }
        }
        
        // --- Navigation / Nudge (Special Case for Arrows) ---
        // Arrows nudge selected geometry; Shift + arrows spins the 2D view.
        const isArrow = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(lowerKey);
        if (e.shiftKey && isArrow) {
            // Shift + Arrow = Rotate View
            const nudgeAmt = 0.001; 
            if (lowerKey === 'arrowleft') viewRotation -= nudgeAmt;
            if (lowerKey === 'arrowright') viewRotation += nudgeAmt;
            redrawCanvas(); renderGeometry2D(); e.preventDefault(); return;
        }
        // --- Toggles ---
        if (matchesKey(e, K.GRID))    toggleGridDisplay();
        if (matchesKey(e, K.IMAGE))   { if(typeof toggleImageDisplay === 'function') toggleImageDisplay(); }
        if (matchesKey(e, K.MEASURE)) { if(typeof toggleMeasurementDisplay === 'function') toggleMeasurementDisplay(); }
        if (matchesKey(e, K.TYPES))   { if(typeof toggleLineTypes === 'function') toggleLineTypes(); }
        if (matchesKey(e, K.FACES))   { if(typeof toggleFacesGlobal === 'function') toggleFacesGlobal(); }
        if (matchesKey(e, K.SNAP))    { if(typeof toggleSnapMode === 'function') toggleSnapMode(); }
        // --- Nudge (Move Selection) ---
        if (isArrow && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            const itemsToMove = new Set();
            if (selectionMode === 'POINT') {
                selectedPoints.forEach(p => itemsToMove.add(p));
                selectedVents.forEach(v => itemsToMove.add(v));
            }
            if (selectionMode === 'LINE') {
                selectedLines.forEach(l => { itemsToMove.add(l.start); itemsToMove.add(l.end); });
                selectedVents.forEach(v => itemsToMove.add(v));
            }
            if (itemsToMove.size > 0) {
                e.preventDefault(); 
                
                if (!window.isNudgeSequenceActive) {
                    save2DState();
                    window.isNudgeSequenceActive = true;
                }
                if (window.nudgeGroupTimer) clearTimeout(window.nudgeGroupTimer);
                window.nudgeGroupTimer = setTimeout(() => {
                    window.isNudgeSequenceActive = false;
                    window.nudgeGroupTimer = null;
                }, 1000);
                const step = 1 / currentZoom; 
                let sDx = 0, sDy = 0;
                if (key === 'ArrowUp') sDy = -step;
                if (key === 'ArrowDown') sDy = step;
                if (key === 'ArrowLeft') sDx = -step;
                if (key === 'ArrowRight') sDx = step;
                const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
                const angle = -rot; 
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const dx = sDx * cos - sDy * sin;
                const dy = sDx * sin + sDy * cos;
                itemsToMove.forEach(item => {
                    // Multi-locked points: completely immovable
                    if (typeof window.isPointMultiLocked === 'function' && window.isPointMultiLocked(item)) return;
                    item.x += dx; item.y += dy;
                    // Single-locked points: adjust z to stay on plane
                    if (typeof window.isPointFacetLocked === 'function' && window.isPointFacetLocked(item)) {
                        if (typeof window.adjustPointZToLockedPlane === 'function') window.adjustPointZToLockedPlane(item);
                    }
                });
                renderGeometry2D();
                if (typeof renderGeometry3D === 'function') renderGeometry3D();
                if (typeof renderFinalPass === 'function') renderFinalPass(true);
                checkAndTriggerMeasurementUpdate();
                return;
            }
        } else {
            // Reset nudge grouping if a non-movement key is pressed
            if (!e.ctrlKey && !e.shiftKey) resetNudgeGroup();
        }
        // --- Layer Switching (1-6) ---
        if (['1','2','3','4','5','6'].includes(key)) {
            const layerNum = parseInt(key);
            
            // Use matchesKey to check just the modifier part against the event
            // We pass a dummy 'key' property to matchesKey or just use the logic below:
            if (matchesKey(e, { ...K.LAYER_TOGGLE, key: key })) {
                // Toggle Visibility Logic
                e.preventDefault(); 
                const btn = document.querySelector(`.layer-toggle-btn.layer-${layerNum}`);
                if (btn && typeof toggleLayerVisibility === 'function' && typeof LAYER_STYLES !== 'undefined') {
                    toggleLayerVisibility(layerNum, btn, LAYER_STYLES[layerNum].line);
                }
            } else if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
                // Set Layer Logic (Strictly no modifiers)
                setLayerForSelection(layerNum);
            }
        }
        if (key === 'Control') {
            const ring = ensureSnapRing();
            ring.style.display = 'block';
        }
        // --- State Management ---
        if (matchesKey(e, K.ESC)) {
            resetNudgeGroup();
            activeSnapGuides = []; 
            if (interactState === 'ROTATING') {
                rotationState.originals.forEach((orig, item) => { item.x = orig.x; item.y = orig.y; });
                interactState = 'IDLE';
                document.body.style.cursor = 'default';
                renderGeometry2D();
                return;
            }
            if (interactState === 'RESIZING') {
                resizeState.originals.forEach((orig, item) => { item.x = orig.x; item.y = orig.y; });
                interactState = 'IDLE';
                document.body.style.cursor = 'default';
                renderGeometry2D();
                return;
            }
            if (interactState === 'MOVING') {
                const ptsToRestore = new Set();
                if(selectionMode === 'POINT') {
                    selectedPoints.forEach(p => ptsToRestore.add(p));
                    selectedVents.forEach(v => ptsToRestore.add(v));
                } else {
                    selectedLines.forEach(l => { ptsToRestore.add(l.start); ptsToRestore.add(l.end); });
                    selectedVents.forEach(v => ptsToRestore.add(v));
                }
                ptsToRestore.forEach(pt => {
                    const orig = moveOriginals.get(pt);
                    if (orig) { pt.x = orig.x; pt.y = orig.y; }
                });
            }
            if (matchesKey(e, K.ESC) && interactState === 'UNDERWALL') {
                __uwExit();
                return;
            }
            interactState = 'IDLE';
            tempPoint = null;
            newPointSourcePoint = null;
            document.getElementById('selection-box').style.display = 'none';
            renderGeometry2D();
        }
        if (matchesKey(e, K.TAB)) { e.preventDefault(); cycleSelectionMode(); }
        // --- Geometry Actions ---
        if (matchesKey(e, K.CONNECT) && selectionMode === 'POINT') {
            if (selectedPoints.size > 1 && activeGeometry) {
                save2DState();
                const arr = Array.from(selectedPoints);
                let changed = false;
                for(let i=0; i<arr.length; i++) {
                    for(let j=i+1; j<arr.length; j++) {
                        const p1 = arr[i]; const p2 = arr[j];
                        if (p1.layer !== p2.layer) continue;
                        const exists = activeGeometry.connections.some(c => (c.start === p1 && c.end === p2) || (c.start === p2 && c.end === p1));
                        if (!exists) { activeGeometry.connections.push({ start: p1, end: p2 }); changed = true; }
                    }
                }
                if (changed) { renderGeometry2D(); renderGeometry3D(); triggerLiveUpdate(); }
            }
        }
        
        if (matchesKey(e, K.PARALLEL) && selectionMode === 'LINE') { handleParallelLines(); triggerLiveUpdate(); }
        if (matchesKey(e, K.MOVE)) {
            if (typeof activeController3D !== 'undefined' && activeController3D) return;
            if (interactState === 'IDLE') {
                const hasSelection = (selectedPoints.size > 0) || (selectedLines.size > 0) || (selectedVents.size > 0);
                if (hasSelection) {
                    save2DState(); 
                    enterMoveMode(); 
                }
            }
            else if (interactState === 'ROTATING' || interactState === 'RESIZING') {
                enterMoveMode();
                document.body.style.cursor = 'move'; 
            }
        }
        if (matchesKey(e, K.CREATE_FACE)) handleCreateFace();
        if (matchesKey(e, K.SUBTRACT_FACE)) handleSubtractFace();
        
        if (matchesKey(e, K.NEW_POINT) && selectionMode === 'POINT') {
            if (interactState === 'IDLE' && selectedPoints.size > 0) {
                interactState = 'NEW_POINT';
                const first = selectedPoints.values().next().value;
                newPointSourcePoint = first;
                tempPoint = { x: first.x, y: first.y, z: null, layer: first.layer || 1 };
            }
        }
        if (matchesKey(e, K.DELETE) || matchesKey(e, K.BACKSPACE)) {
            activeSnapGuides = []; 
            if (activeController3D) deleteSelected3D(); else deleteSelected2D();
        }
        if (matchesKey(e, K.FLATTEN)) { handleFlattenPoints(); }
        if (lowerKey === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (typeof selectedFaceSignatures !== 'undefined' && selectedFaceSignatures.size > 0) {
                e.preventDefault();
                save2DState();
                if (typeof window.toggleSelectedFaceLocks === 'function') window.toggleSelectedFaceLocks();
                return;
            }
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Control') updateSnapRing(0, 0, false);
    });
    
    window.addEventListener('blur', () => {
        updateSnapRing(0, 0, false);
    });
    viewport.addEventListener('mousemove', (e) => {
        const c = screenToImage(e.clientX, e.clientY);
        if (interactState === 'QUAD_CREATE') {
            handleQuadMove(c); 
            return;
        }
        
        if (interactState === 'IDLE') { window.moveAnchor = { mouseX: c.x, mouseY: c.y }; }
    });
    
    viewport.addEventListener('wheel', onWheel2D, { passive: false });
}
function __uwSnapCursorForUnderwall(rawImgPt){
  // Returns { pt:{x,y}, mergePoint: pointObj|null, snapType: 'off'|'none'|'point'|'guide' }
  const snappingOn = (typeof isFreeMove !== 'undefined') ? (!isFreeMove) : true;
  const sRad = (typeof snapRadius !== 'undefined' ? snapRadius : 20) / (typeof currentZoom !== 'undefined' && currentZoom ? currentZoom : 1);
  // default
  let out = { pt: { x: rawImgPt.x, y: rawImgPt.y }, mergePoint: null, snapType: snappingOn ? 'none' : 'off' };
  // Always clear guides when snapping off
  if (!snappingOn) {
    if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
    return out;
  }
  // 1) POINT snap (same layer only)
  const wantLayer = underwallState?.startLayer || (underwallState?.startPoint?.layer || 1);
  if (typeof getClosestPoint === 'function') {
    const hitPt = getClosestPoint(rawImgPt.x, rawImgPt.y, sRad, null);
    if (hitPt && (hitPt.layer || 1) === wantLayer) {
      // lock to this exact point and merge on commit
      out.pt = { x: hitPt.x, y: hitPt.y };
      out.mergePoint = hitPt;
      out.snapType = 'point';
      if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
      console.log("[UnderwallSnap] point", { wantLayer, hitPt });
      return out;
    }
  }
  // 2) ORIENTATION / GUIDE snap (yellow lines)
  // Use getComplexSnap ONLY (no line snap; do not call getClosestLine / findClosestLine here)
  if (typeof getComplexSnap === 'function') {
    const g = getComplexSnap(rawImgPt.x, rawImgPt.y, sRad, null);
    if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {
      out.pt = { x: g.x, y: g.y };
      out.snapType = 'guide';
      console.log("[UnderwallSnap] guide", { x: g.x, y: g.y });
      return out;
    }
  }
  // no snap found
  if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
  return out;
}
function __uwSegIntersects(a, b, c, d, eps = 1e-6) {
  // Proper segment intersection (excluding shared endpoints / near-collinear noise)
  const ax=a.x, ay=a.y, bx=b.x, by=b.y, cx=c.x, cy=c.y, dx=d.x, dy=d.y;
  // quick reject bbox
  const minAx = Math.min(ax,bx)-eps, maxAx = Math.max(ax,bx)+eps;
  const minAy = Math.min(ay,by)-eps, maxAy = Math.max(ay,by)+eps;
  const minCx = Math.min(cx,dx)-eps, maxCx = Math.max(cx,dx)+eps;
  const minCy = Math.min(cy,dy)-eps, maxCy = Math.max(cy,dy)+eps;
  if (maxAx < minCx || maxCx < minAx || maxAy < minCy || maxCy < minAy) return false;
  const orient = (px,py,qx,qy,rx,ry) => (qx-px)*(ry-py) - (qy-py)*(rx-px);
  const o1 = orient(ax,ay,bx,by,cx,cy);
  const o2 = orient(ax,ay,bx,by,dx,dy);
  const o3 = orient(cx,cy,dx,dy,ax,ay);
  const o4 = orient(cx,cy,dx,dy,bx,by);
  // collinear or touching endpoints -> ignore as “not a crossing”
  const near0 = (v) => Math.abs(v) < 1e-6;
  if (near0(o1) || near0(o2) || near0(o3) || near0(o4)) return false;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}
function __uwCountPerimeterCrossings(segA, segB, excludeConn = null) {
  let count = 0;
  const per = underwallState.perimeterConns || [];
  for (let i = 0; i < per.length; i++) {
    const c = per[i];
    if (!c || c === excludeConn) continue;
    // Ignore intersections that happen *at* shared endpoints (same vertex)
    const a = c.start, b = c.end;
    // If segment shares a point with this perimeter edge, skip (not a “crossing”)
    const shares =
      (Math.hypot(segA.x-a.x, segA.y-a.y) < 1e-4) ||
      (Math.hypot(segA.x-b.x, segA.y-b.y) < 1e-4) ||
      (Math.hypot(segB.x-a.x, segB.y-a.y) < 1e-4) ||
      (Math.hypot(segB.x-b.x, segB.y-b.y) < 1e-4);
    if (shares) continue;
    if (__uwSegIntersects(segA, segB, a, b)) count++;
  }
  return count;
}
function __uwClamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function __uwDistToSegSq(p, a, b){
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const l2 = vx*vx + vy*vy;
  if (l2 === 0) return { d2: wx*wx + wy*wy, t: 0, x: a.x, y: a.y };
  let t = (wx*vx + wy*vy) / l2;
  t = __uwClamp(t, 0, 1);
  const x = a.x + t*vx;
  const y = a.y + t*vy;
  const dx = p.x - x, dy = p.y - y;
  return { d2: dx*dx + dy*dy, t, x, y };
}
function __uwLineIntersection(p1,p2,p3,p4){
  // infinite lines intersection
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const den = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(den) < 1e-9) return null;
  const px = ((x1*y2 - y1*x2)*(x3-x4) - (x1-x2)*(x3*y4 - y3*x4)) / den;
  const py = ((x1*y2 - y1*x2)*(y3-y4) - (y1-y2)*(x3*y4 - y3*x4)) / den;
  return { x:px, y:py };
}
function __uwGetFacesSource(){
  // Prefer lastResolvedFacesCache (your “source of truth”)
  if (window.lastResolvedFacesCache && Array.isArray(window.lastResolvedFacesCache)) return window.lastResolvedFacesCache;
  if (typeof facesGroup !== 'undefined' && facesGroup && facesGroup.children) {
    return facesGroup.children
      .filter(m => m.userData && m.userData.faceDef)
      .map(m => m.userData.faceDef);
  }
  return [];
}
function __uwEnsureTypes(){
  if (!activeGeometry || !activeGeometry.connections) return false;
  // If *any* conn missing type or unknown, re-run silently
  const needs = activeGeometry.connections.some(c => !c.type || c.type === 'unknown');
  if (needs) {
    if (typeof window.generateMeasurementsSilent === 'function') {
      window.generateMeasurementsSilent({ forceFullFaceSolve: true, refresh2D: false, refresh3D: false });
    } else {
      console.warn("[Underwall] generateMeasurementsSilent missing.");
    }
  }
  return true;
}
function __uwIsPerimeterType(t){
  return (t === 'eave' || t === 'rake');
}
function __uwBuildPerimeterConnList(){
  underwallState.perimeterConns = [];
  if (!activeGeometry || !activeGeometry.connections) return;
  activeGeometry.connections.forEach(c => {
    if (!c || !c.start || !c.end) return;
    if (!__uwIsPerimeterType(c.type)) return;
    const l = c.start.layer || 1;
    if (!layerVisibility[l]) return;
    underwallState.perimeterConns.push(c);
  });
}
function __uwBuildConnOwnerMap(){
  underwallState.connOwnerFace = new Map();
  const faces = __uwGetFacesSource();
  if (!faces.length) return;
  // If mapConnectionsToFaces exists globally (it does in your measurements.js), use it.
  if (typeof mapConnectionsToFaces === 'function') {
    const m = mapConnectionsToFaces(faces);
    // m is Map(conn -> [faces])
    m.forEach((owners, conn) => {
      if (!owners || !owners.length) return;
      // pick first owner (perimeter has exactly 1)
      underwallState.connOwnerFace.set(conn, owners[0]);
    });
  } else {
    // fallback: nothing (we’ll use centroid heuristic)
  }
}
function __uwPickInwardNormalForConn(conn, ax, ay, bx, by){
  // returns: { x, y, ambiguous, reason }
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx1 = -dy / len, ny1 = dx / len;   // left
  const nx2 = -nx1,      ny2 = -ny1;       // right
  const owner = underwallState.connOwnerFace.get(conn);
  const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
  // Best case: we can test inside-of-owner-face
  if (owner && owner.points && typeof isPointInPolyMeasurement === 'function') {
    const eps = 2.0; // px
    const p1in = isPointInPolyMeasurement(mx + nx1*eps, my + ny1*eps, owner.points);
    const p2in = isPointInPolyMeasurement(mx + nx2*eps, my + ny2*eps, owner.points);
    if (p1in && !p2in) return { x:nx1, y:ny1, ambiguous:false, reason:"ownerFace:insideLeft" };
    if (p2in && !p1in) return { x:nx2, y:ny2, ambiguous:false, reason:"ownerFace:insideRight" };
    // ambiguous even with owner (rare): fall through as ambiguous
    return { x:nx1, y:ny1, ambiguous:true, reason:"ownerFace:bothOrNeither" };
  }
  // No owner => ambiguous by definition
  return { x:nx1, y:ny1, ambiguous:true, reason:"noOwnerFace" };
}
function __uwNearestPerimeterConnToPoint(pt){
  let best = null;
  let bestD2 = Infinity;
  for (const conn of underwallState.perimeterConns) {
    const a = conn.start, b = conn.end;
    const proj = __uwDistToSegSq(pt, a, b);
    if (proj.d2 < bestD2) {
      bestD2 = proj.d2;
      best = { conn, proj };
    }
  }
  return best;
}
function __uwBfsPath(startPt, goalPt, allowedConnSet){
  // nodes are point objects; edges are conn.start<->conn.end
  const q = [startPt];
  const prev = new Map(); // pt -> {pt:prevPt, conn:viaConn}
  prev.set(startPt, null);
  while (q.length) {
    const cur = q.shift();
    if (cur === goalPt) break;
    for (const conn of allowedConnSet) {
      let nxt = null;
      if (conn.start === cur) nxt = conn.end;
      else if (conn.end === cur) nxt = conn.start;
      else continue;
      if (!prev.has(nxt)) {
        prev.set(nxt, { pt: cur, conn });
        q.push(nxt);
      }
    }
  }
  if (!prev.has(goalPt)) return null;
  // rebuild
  const pts = [];
  const conns = [];
  let cur = goalPt;
  while (cur) {
    pts.push(cur);
    const step = prev.get(cur);
    if (step && step.conn) conns.push(step.conn);
    cur = step ? step.pt : null;
  }
  pts.reverse();
  conns.reverse(); // aligns with segments between pts
  return { pts, conns };
}
function __uwBuildOffsetPolyline(pathPts, pathConns, endFoot, endConn){
  const d = underwallState.preview.d;
  if (!(d > 0)) return null;
  // -----------------------------
  // Helpers (local)
  // -----------------------------
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const dist = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function segSegIntersect(a,b,c,d){
    // Proper segment intersection, excluding endpoint-touch within EPS
    const EPS = 1e-6;
    const ax=b.x-a.x, ay=b.y-a.y;
    const cx=d.x-c.x, cy=d.y-c.y;
    const denom = ax*cy - ay*cx;
    if (Math.abs(denom) < 1e-12) return null; // parallel
    const sx = c.x - a.x, sy = c.y - a.y;
    const t = (sx*cy - sy*cx) / denom;
    const u = (sx*ay - sy*ax) / denom;
    if (t <= EPS || t >= 1-EPS || u <= EPS || u >= 1-EPS) return null;
    return { x: a.x + t*ax, y: a.y + t*ay, t, u };
  }
  function polyLen(poly){
    let L=0;
    for(let i=0;i<poly.length-1;i++) L += dist(poly[i], poly[i+1]);
    return L;
  }
  function countCrossings(poly){
    // count intersections between offset poly segments and ANY eave/rake conn
    // ignore near-adjacent/near-touch
    const per = underwallState.perimeterConns || [];
    let crosses = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i], b = poly[i+1];
      for (let k = 0; k < per.length; k++) {
        const c0 = per[k].start, d0 = per[k].end;
        const c = {x:c0.x,y:c0.y}, d = {x:d0.x,y:d0.y};
        // quick reject if sharing endpoints very near
        if (dist(a,c) < 1e-3 || dist(a,d) < 1e-3 || dist(b,c) < 1e-3 || dist(b,d) < 1e-3) continue;
        const hit = segSegIntersect(a,b,c,d);
        if (hit) crosses++;
      }
    }
    return crosses;
  }
  function buildBasePolyline(){
    const base = [];
    for (let i = 0; i < pathPts.length; i++) base.push({ x: pathPts[i].x, y: pathPts[i].y });
    // append endFoot if needed
    const last = base[base.length - 1];
    if (endFoot && (Math.hypot(endFoot.x - last.x, endFoot.y - last.y) > 1e-6)) {
      base.push({ x:endFoot.x, y:endFoot.y });
    }
    return base;
  }
  function buildShiftedWithNormalChoices(base, normalChoices){
    // normalChoices[i] is {x,y} for segment i
    const shifted = [];
    for (let i = 0; i < base.length - 1; i++) {
      const a = base[i], b = base[i+1];
      const n = normalChoices[i];
      shifted.push({
        a: { x: a.x + n.x*d, y: a.y + n.y*d },
        b: { x: b.x + n.x*d, y: b.y + n.y*d }
      });
    }
    // Join with miter clamp (same as your prior fix)
    const out = [];
    out.push(shifted[0].a);
    const MITER_MAX = Math.max(40, d * 6);
    for (let i = 0; i < shifted.length - 1; i++) {
      const s1 = shifted[i];
      const s2 = shifted[i+1];
      const inter = __uwLineIntersection(s1.a, s1.b, s2.a, s2.b);
      if (inter) {
        const miterLen = Math.hypot(inter.x - s1.b.x, inter.y - s1.b.y);
        if (miterLen <= MITER_MAX) out.push(inter);
        else out.push(s1.b); // bevel fallback
      } else {
        out.push(s1.b);
      }
    }
    out.push(shifted[shifted.length - 1].b);
    return out;
  }
  function unitNormalFromAB_left(a,b){
    const dx=b.x-a.x, dy=b.y-a.y;
    const len=Math.hypot(dx,dy)||1;
    return { x:-dy/len, y:dx/len };
  }
  // -----------------------------
  // Build base & per-segment “normal options”
  // -----------------------------
  const base = buildBasePolyline();
  if (!base || base.length < 2) return null;
  // Build per-segment conn list (final segment must use endConn)
  const segConns = [];
  for (let i = 0; i < base.length - 1; i++) {
    let conn = (i < pathConns.length) ? pathConns[i] : null;
    if (endConn && i === base.length - 2) conn = endConn;
    segConns.push(conn);
  }
  // For each segment, define either:
  // - fixed normal (unambiguous), or
  // - two normals (ambiguous): left/right
  const fixedNormals = new Array(segConns.length).fill(null);
  const ambiguousIdx = [];
  for (let i = 0; i < segConns.length; i++) {
    const a = base[i], b = base[i+1];
    const conn = segConns[i];
    if (conn) {
      const pick = __uwPickInwardNormalForConn(conn, a.x, a.y, b.x, b.y);
      // build both options from segment geometry
      const left = unitNormalFromAB_left(a,b);
      const right = { x:-left.x, y:-left.y };
      if (!pick.ambiguous) {
        fixedNormals[i] = { x: pick.x, y: pick.y };
      } else {
        ambiguousIdx.push(i);
        // store default as left for now; brute-force will replace
        fixedNormals[i] = { x:left.x, y:left.y };
      }
    } else {
      // no conn at all: ambiguous
      const left = unitNormalFromAB_left(a,b);
      fixedNormals[i] = { x:left.x, y:left.y };
      ambiguousIdx.push(i);
    }
  }
  // -----------------------------
  // If no ambiguity, just build once
  // -----------------------------
  if (ambiguousIdx.length === 0) {
    return buildShiftedWithNormalChoices(base, fixedNormals);
  }
  // -----------------------------
  // Brute force combinations for ambiguous segments (capped)
  // -----------------------------
  const MAX_AMBIG = 6; // cap to avoid explosion
  const usedAmbig = ambiguousIdx.slice(0, MAX_AMBIG);
  const total = 1 << usedAmbig.length;
  let bestPoly = null;
  let bestCross = Infinity;
  let bestLen = Infinity;
  let bestMask = 0;
  console.groupCollapsed(
    `%c[Underwall] Ambiguous inward normals: ${ambiguousIdx.length} (testing ${total} combos, cap=${MAX_AMBIG})`,
    "color:#00ffff;font-weight:800;"
  );
  if (ambiguousIdx.length > MAX_AMBIG) {
    console.warn("[Underwall] Too many ambiguous segments; only using first", MAX_AMBIG, ":", usedAmbig);
  }
  for (let mask = 0; mask < total; mask++) {
    const normals = fixedNormals.map(n => ({x:n.x, y:n.y}));
    for (let bit = 0; bit < usedAmbig.length; bit++) {
      const segI = usedAmbig[bit];
      const a = base[segI], b = base[segI+1];
      const left = unitNormalFromAB_left(a,b);
      const right = { x:-left.x, y:-left.y };
      // bit=0 => left, bit=1 => right
      const useRight = ((mask >> bit) & 1) === 1;
      normals[segI] = useRight ? right : left;
    }
    const poly = buildShiftedWithNormalChoices(base, normals);
    if (!poly || poly.length < 2) continue;
    const crosses = countCrossings(poly);
    const L = polyLen(poly);
    if (crosses < bestCross || (crosses === bestCross && L < bestLen)) {
      bestCross = crosses;
      bestLen = L;
      bestPoly = poly;
      bestMask = mask;
    }
  }
  console.log("[Underwall] chosen mask:", bestMask, "crossings:", bestCross, "len:", bestLen.toFixed(2));
  console.groupEnd();
  return bestPoly;
}
function __uwStartFromSelection(){
  if (!activeGeometry) return false;
  if (selectedPoints.size !== 1) return false;
  __uwEnsureTypes();
  __uwBuildPerimeterConnList();
  __uwBuildConnOwnerMap();
  const p = selectedPoints.values().next().value;
  // Ensure start z exists
  let z = p.z;
  if (z === null || z === undefined) {
    if (layerData?.dsm?.[0]) {
      const dsm = layerData.dsm[0];
      const ix = __uwClamp(Math.round(p.x), 0, imageWidth-1);
      const iy = __uwClamp(Math.round(p.y), 0, imageHeight-1);
      const v = dsm[iy*imageWidth + ix];
      z = (v > -9000) ? v : 0;
      p.z = z;
    } else z = 0;
  }
  // base state
  underwallState.startPoint = p;
  underwallState.startLayer = p.layer || 1;
  underwallState.startZ = z;
  underwallState.startMode = null;          // 'perimeter' | 'interior'
  underwallState.startGraphNode = null;     // point object used for BFS on perimeter graph
  underwallState.startAnchorConn = null;    // perimeter conn used as anchor in interior mode
  underwallState.interiorFoot = null;       // projection of startPt onto anchor conn
  underwallState.interiorD = null;          // fixed offset distance in interior mode
  // --- Case A: start point touches an eave/rake (original) ---
  const touching = activeGeometry.connections.filter(c =>
    (c.start === p || c.end === p) && __uwIsPerimeterType(c.type)
  );
  if (touching.length) {
    underwallState.startMode = 'perimeter';
    underwallState.startGraphNode = p;
    underwallState.startAnchorConn = touching[0];
    console.log("[Underwall] start=PERIMETER", { layer: underwallState.startLayer, z: underwallState.startZ });
    underwallState.preview = { ok:false, d:0, foot:null, target:null, poly:[], perp:null };
    return true;
  }
  // --- Case B: interior start: find parent face containing it ---
  const faces = __uwGetFacesSource();
  if (!faces || !faces.length || typeof isPointInPolyMeasurement !== 'function') {
    console.warn("[Underwall] start=INTERIOR failed: no faces to determine parent.");
    return false;
  }
  const containing = faces.filter(f => f?.points?.length >= 3 && isPointInPolyMeasurement(p.x, p.y, f.points));
  if (!containing.length) {
    console.warn("[Underwall] start=INTERIOR failed: point not inside any face.");
    return false;
  }
  // Prefer same-layer face if possible
  const parent = containing.find(f => (f.layer || 1) === (p.layer || 1)) || containing[0];
  // perimeter conns owned by this face
  const owned = underwallState.perimeterConns.filter(c => underwallState.connOwnerFace.get(c) === parent);
  if (!owned.length) {
    console.warn("[Underwall] start=INTERIOR failed: parent face has no mapped eave/rake edges.", { parentLayer: parent.layer || 1 });
    return false;
  }
  // choose nearest owned eave/rake edge to start point
  let best = null, bestD2 = Infinity;
  for (const c of owned) {
    const proj = __uwDistToSegSq({x:p.x,y:p.y}, c.start, c.end);
    if (proj.d2 < bestD2) { bestD2 = proj.d2; best = { conn:c, proj }; }
  }
  if (!best) return false;
  const foot = { x: best.proj.x, y: best.proj.y };
  const dSel = Math.sqrt(bestD2);
  // choose which endpoint becomes BFS node (closer to foot)
  const dA = Math.hypot(foot.x - best.conn.start.x, foot.y - best.conn.start.y);
  const dB = Math.hypot(foot.x - best.conn.end.x,   foot.y - best.conn.end.y);
  const startNode = (dA <= dB) ? best.conn.start : best.conn.end;
  underwallState.startMode = 'interior';
  underwallState.startAnchorConn = best.conn;
  underwallState.startGraphNode = startNode;
  underwallState.interiorFoot = foot;
  underwallState.interiorD = dSel;
  console.log("[Underwall] start=INTERIOR", {
    selectedLayer: underwallState.startLayer,
    parentLayer: parent.layer || 1,
    anchorConn: best.conn,
    interiorFoot: foot,
    interiorD: +dSel.toFixed(3),
    startGraphNode: startNode
  });
  underwallState.preview = { ok:false, d:0, foot:null, target:null, poly:[], perp:null };
  return true;
}
function __uwUpdatePreviewFromCursor(imgPt){
  if (!underwallState.active || !underwallState.startPoint) return;
  const startPt = underwallState.startPoint;
  const startNode = underwallState.startGraphNode || startPt;
  // ✅ snap ONLY the cursor endpoint (if snapping ON)
  const snap = __uwSnapCursorForUnderwall(imgPt);
  const cursorPt = snap.pt;
  underwallState.preview.endMergePoint = snap.mergePoint || null;
  underwallState.preview.endSnapType = snap.snapType;
  // Hit perimeter conn for the (snapped) cursor point
  const hit = __uwNearestPerimeterConnToPoint(cursorPt);
  if (!hit) { underwallState.preview.ok = false; return; }
  const hitConn = hit.conn;
  const cursorFoot = { x: hit.proj.x, y: hit.proj.y };
  // Distance rule:
  // - interior start: fixed by startPt -> anchor wall
  // - perimeter start: driven by cursor -> wall
  const d = (underwallState.startMode === 'interior' && Number.isFinite(underwallState.interiorD))
    ? underwallState.interiorD
    : Math.sqrt(hit.proj.d2);
  // Perp preview on the target wall (foot -> offset target)
  const pickHit = __uwPickInwardNormalForConn(hitConn, hitConn.start.x, hitConn.start.y, hitConn.end.x, hitConn.end.y);
  const nHit = pickHit.ambiguous
    ? (() => {
        const dx = hitConn.end.x - hitConn.start.x, dy = hitConn.end.y - hitConn.start.y;
        const len = Math.hypot(dx,dy)||1;
        return { x:-dy/len, y:dx/len };
      })()
    : { x: pickHit.x, y: pickHit.y };
  const cursorTarget = { x: cursorFoot.x + nHit.x * d, y: cursorFoot.y + nHit.y * d };
  underwallState.preview.d = d;
  underwallState.preview.foot = cursorFoot;
  underwallState.preview.target = cursorTarget;
  underwallState.preview.perp = { a: cursorFoot, b: cursorTarget };
  // Clear optional helpers
  underwallState.preview.startLink = null;      // start cut-in preview (wall->offset)
  underwallState.preview.startLinkType = null;  // 'perimeter-cut' | 'interior-join'
  const allowed = new Set(underwallState.perimeterConns);
  // BFS to both endpoints of the hit segment, pick best
  const tryPath = (goalNode) => {
    const pth = __uwBfsPath(startNode, goalNode, allowed);
    if (!pth) return null;
    const hops = pth.pts.length;
    const tailDist = Math.hypot(goalNode.x - cursorFoot.x, goalNode.y - cursorFoot.y);
    const cost = hops * 1000 + tailDist;
    return { path: pth, cost, goalNode };
  };
  const candA = tryPath(hitConn.start);
  const candB = tryPath(hitConn.end);
  const best = (!candA && !candB) ? null
            : (!candB) ? candA
            : (!candA) ? candB
            : (candA.cost <= candB.cost ? candA : candB);
  if (!best) {
    underwallState.preview.ok = false;
    underwallState.preview.poly = [];
    console.warn("[Underwall] no path", { startMode: underwallState.startMode, startNode, hitConn });
    return;
  }
  // Build full offset poly along the perimeter path to cursorFoot
  const offsetFull = __uwBuildOffsetPolyline(best.path.pts, best.path.conns, cursorFoot, hitConn);
  if (!offsetFull || offsetFull.length < 2) {
    underwallState.preview.ok = false;
    underwallState.preview.poly = [];
    console.warn("[Underwall] offset build failed");
    return;
  }
  // ============================================================
  // ✅ PERIMETER START: poly should START on offset, NOT startPt
  // ============================================================
  if (underwallState.startMode === 'perimeter') {
    // Show the cut-in segment from the selected wall point to the first offset point
    underwallState.preview.startLink = { a: {x:startPt.x,y:startPt.y}, b: offsetFull[0] };
    underwallState.preview.startLinkType = 'perimeter-cut';
    underwallState.preview.ok = true;
    underwallState.preview.poly = offsetFull;
    console.log("[Underwall] preview PERIMETER", {
      dUsed: +d.toFixed(3),
      endSnap: underwallState.preview.endSnapType,
      cutIn: +Math.hypot(offsetFull[0].x-startPt.x, offsetFull[0].y-startPt.y).toFixed(2)
    });
    return;
  }
  // ============================================================
  // ✅ INTERIOR START: splice so poly begins at selected point
  // ============================================================
  if (underwallState.startMode === 'interior' && underwallState.startAnchorConn && underwallState.interiorFoot) {
    const a0 = underwallState.startAnchorConn.start;
    const b0 = underwallState.startAnchorConn.end;
    const pickA = __uwPickInwardNormalForConn(underwallState.startAnchorConn, a0.x,a0.y,b0.x,b0.y);
    const nA = pickA.ambiguous
      ? (() => {
          const dx = b0.x - a0.x, dy = b0.y - a0.y;
          const len = Math.hypot(dx,dy)||1;
          return { x:-dy/len, y:dx/len };
        })()
      : { x: pickA.x, y: pickA.y };
    // Anchor offset segment endpoints
    const Aoff = { x: a0.x + nA.x * d, y: a0.y + nA.y * d };
    const Boff = { x: b0.x + nA.x * d, y: b0.y + nA.y * d };
    // Join point: projection of selected point onto offset segment
    const proj = __uwDistToSegSq({x:startPt.x, y:startPt.y}, Aoff, Boff);
    const join = { x: proj.x, y: proj.y };
    // Trim offsetFull to start at nearest point to join
    let bestI = 0, bestD2 = Infinity, bestP = offsetFull[0];
    for (let i = 0; i < offsetFull.length - 1; i++) {
      const pr = __uwDistToSegSq(join, offsetFull[i], offsetFull[i+1]);
      if (pr.d2 < bestD2) { bestD2 = pr.d2; bestI = i; bestP = {x:pr.x,y:pr.y}; }
    }
    const trimmed = [ bestP, ...offsetFull.slice(bestI + 1) ];
    const needJoin = (Math.hypot(join.x - trimmed[0].x, join.y - trimmed[0].y) > 1e-3);
    const poly = [
      { x:startPt.x, y:startPt.y },
      ...(needJoin ? [join] : []),
      ...trimmed
    ];
    underwallState.preview.startLink = { a: {x:startPt.x,y:startPt.y}, b: (needJoin ? join : trimmed[0]) };
    underwallState.preview.startLinkType = 'interior-join';
    underwallState.preview.ok = true;
    underwallState.preview.poly = poly;
    console.log("[Underwall] preview INTERIOR", {
      dUsed: +d.toFixed(3),
      endSnap: underwallState.preview.endSnapType,
      join,
      trimAtSeg: bestI
    });
    return;
  }
  // Fallback
  underwallState.preview.ok = true;
  underwallState.preview.poly = offsetFull;
}
// ===============================
// DROP-IN REPLACEMENT: __uwCommitPreview
// Adds: collinear merge / poly simplify before committing
// ===============================
function __uwCommitPreview(){
  const pv = underwallState.preview;
  if (!pv || !pv.ok || !pv.poly || pv.poly.length < 2) return false;
  // --- helper: simplify polyline by removing collinear middle points ---
  function __uwSimplifyCollinear(poly, opts = {}) {
    const angleTolDeg = Number.isFinite(opts.angleTolDeg) ? opts.angleTolDeg : 1.25; // tighten/loosen
    const distTol     = Number.isFinite(opts.distTol)     ? opts.distTol     : 0.75; // px distance of mid to line
    const keepFirst   = (opts.keepFirst !== false);
    const keepLast    = (opts.keepLast !== false);
    const angTol = (angleTolDeg * Math.PI) / 180;
    const hypot = Math.hypot;
    const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
    function pointLineDist(p, a, b){
      const vx = b.x - a.x, vy = b.y - a.y;
      const wx = p.x - a.x, wy = p.y - a.y;
      const l2 = vx*vx + vy*vy;
      if (l2 < 1e-12) return hypot(wx, wy);
      let t = (wx*vx + wy*vy) / l2;
      t = clamp(t, 0, 1);
      const px = a.x + t*vx, py = a.y + t*vy;
      return hypot(p.x - px, p.y - py);
    }
    function angleBetween(a, b, c){
      // angle between vectors BA and BC
      const v1x = a.x - b.x, v1y = a.y - b.y;
      const v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = hypot(v1x, v1y), l2 = hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) return 0;
      let dot = (v1x*v2x + v1y*v2y) / (l1*l2);
      dot = clamp(dot, -1, 1);
      return Math.acos(dot);
    }
    if (!Array.isArray(poly) || poly.length < 3) return poly;
    // work on a copy
    const out = poly.map(p => ({ x: p.x, y: p.y }));
    // iterative pass (handles cascaded collinear runs)
    let changed = true;
    while (changed && out.length >= 3) {
      changed = false;
      // preserve endpoints
      const startIdx = keepFirst ? 1 : 0;
      const endIdx   = keepLast  ? out.length - 2 : out.length - 1;
      for (let i = startIdx; i <= endIdx; i++) {
        const a = out[i - 1];
        const b = out[i];
        const c = out[i + 1];
        // near-straight if angle at b is close to 180° (or 0°)
        const ang = angleBetween(a, b, c);
        const straightness = Math.min(ang, Math.abs(Math.PI - ang)); // distance to 0 or pi
        if (straightness > angTol) continue;
        // also require b to lie near segment a-c
        const d = pointLineDist(b, a, c);
        if (d > distTol) continue;
        // remove b
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
    return out;
  }
  save2DState();
  const layer = underwallState.startLayer || 1;
  const startPt = underwallState.startPoint;
  if (!startPt) return false;
  let z = underwallState.startZ;
  if (z === null || z === undefined) z = (startPt.z ?? 0);
  const mergeEnd = pv.endMergePoint && ((pv.endMergePoint.layer || 1) === layer) ? pv.endMergePoint : null;
  // ------------------------------------------------------------
  // ✅ Simplify the polyline FIRST (merge collinear continuations)
  // - Keep endpoints so we don't break cut-in / mergeEnd behavior
  // ------------------------------------------------------------
  // Note: for interior mode, pv.poly[0] is startPt coords (but not the object).
  // We still keep endpoints; we’ll reattach to startPt object below.
  const simplifiedPoly = __uwSimplifyCollinear(pv.poly, {
    angleTolDeg: 1.25,
    distTol: 0.75,
    keepFirst: true,
    keepLast: true
  });
  // guard
  if (!simplifiedPoly || simplifiedPoly.length < 2) return false;
  // ------------------------------------------------------------
  // PERIMETER START: poly is offset-only. Add cut-in startPt->poly[0]
  // ------------------------------------------------------------
  if (underwallState.startMode === 'perimeter') {
    const createdPts = [];
    for (let i = 0; i < simplifiedPoly.length; i++) {
      const isLast = (i === simplifiedPoly.length - 1);
      if (isLast && mergeEnd) { createdPts.push(mergeEnd); continue; }
      const p = simplifiedPoly[i];
      const np = { x:p.x, y:p.y, z:z, layer:layer, zLocked:true };
      activeGeometry.points.push(np);
      createdPts.push(np);
    }
    // Cut-in segment: startPt -> first offset
    activeGeometry.connections.push({ start: startPt, end: createdPts[0], type: null });
    // Poly segments (already simplified)
    for (let i = 0; i < createdPts.length - 1; i++) {
      if (createdPts[i] === createdPts[i+1]) continue;
      activeGeometry.connections.push({ start: createdPts[i], end: createdPts[i+1], type: null });
    }
    selectedPoints.clear(); selectedLines.clear(); selectedVents.clear();
    selectedPoints.add(startPt);
    createdPts.forEach(p => selectedPoints.add(p));
    if (typeof renderGeometry3D === 'function') renderGeometry3D();
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
    triggerLiveUpdate();
    __uwExit();
    return true;
  }
  // ------------------------------------------------------------
  // INTERIOR START: poly already begins at startPt (existing object)
  // ------------------------------------------------------------
  const committedPts = [startPt];
  // start from index 1 (since index 0 is the start point location)
  for (let i = 1; i < simplifiedPoly.length; i++) {
    const isLast = (i === simplifiedPoly.length - 1);
    if (isLast && mergeEnd) { committedPts.push(mergeEnd); continue; }
    const p = simplifiedPoly[i];
    const np = { x:p.x, y:p.y, z:z, layer:layer, zLocked:true };
    activeGeometry.points.push(np);
    committedPts.push(np);
  }
  for (let i = 0; i < committedPts.length - 1; i++) {
    if (committedPts[i] === committedPts[i+1]) continue;
    activeGeometry.connections.push({ start: committedPts[i], end: committedPts[i+1], type: null });
  }
  selectedPoints.clear(); selectedLines.clear(); selectedVents.clear();
  committedPts.forEach(p => selectedPoints.add(p));
  if (typeof renderGeometry3D === 'function') renderGeometry3D();
  if (typeof renderGeometry2D === 'function') renderGeometry2D();
  triggerLiveUpdate();
  __uwExit();
  return true;
}
function __uwEnter(){
  // must start from a selected point
  if (!__uwStartFromSelection()) return false;
  underwallState.active = true;
  interactState = 'UNDERWALL';
  document.body.style.cursor = 'crosshair';
  // ensure preview shows immediately
  const imgPt = screenToImage(lastMouseX, lastMouseY);
  __uwUpdatePreviewFromCursor(imgPt);
  if (typeof renderGeometry2D === 'function') renderGeometry2D();
  return true;
}
function __uwExit(){
  underwallState.active = false;
  underwallState.startPoint = null;
  underwallState.preview = { ok:false, d:0, foot:null, target:null, poly:[], perp:null };
  if (interactState === 'UNDERWALL') interactState = 'IDLE';
  document.body.style.cursor = 'default';
  if (typeof renderGeometry2D === 'function') renderGeometry2D();
  if (typeof activeSnapGuides !== 'undefined') activeSnapGuides = [];
}
 
function showSnapIndicator(pt) {
    const ind = document.getElementById('snap-indicator');
    
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    
    const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
    
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const rotX = rx + cx;
    const rotY = ry + cy;
    const screenX = (rotX * currentZoom) + panX;
    const screenY = (rotY * currentZoom) + panY;
    ind.style.display = 'block';
    ind.style.left = screenX + 'px';
    ind.style.top = screenY + 'px';
}
function handleSubtractFace() {
    if (!activeGeometry) return;
    // --- Gather edges from ALL selection sources (matches handleCreateFace) ---
    const edgeSet = new Set();
    const relevantPoints = new Set();
    selectedLines.forEach(l => {
        edgeSet.add(l);
        relevantPoints.add(l.start);
        relevantPoints.add(l.end);
    });
    selectedPoints.forEach(p => relevantPoints.add(p));
    activeGeometry.connections.forEach(conn => {
        if (relevantPoints.has(conn.start) && relevantPoints.has(conn.end)) {
            edgeSet.add(conn);
        }
    });
    const edges = Array.from(edgeSet);
    if (edges.length < 3) {
        console.log("Subtract Face: Not enough connected geometry selected.");
        return;
    }
    const adj = new Map();
    edges.forEach(conn => {
        if (!adj.has(conn.start)) adj.set(conn.start, []);
        if (!adj.has(conn.end)) adj.set(conn.end, []);
        adj.get(conn.start).push({ pt: conn.end, conn: conn });
        adj.get(conn.end).push({ pt: conn.start, conn: conn });
    });
    const cycles = window.extractCyclesFromSubset(adj);
    if (cycles.length === 0) {
        console.log("Subtract Face: No closed loops found.");
        return;
    }
    cycles.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const holePoly = cycles[0].points;
    
    const pointOnSegmentForSubtract = (p, a, b, eps = 1.0) => {
        const abx = b.x - a.x, aby = b.y - a.y;
        const apx = p.x - a.x, apy = p.y - a.y;
        const len2 = abx * abx + aby * aby;
        if (len2 < eps * eps) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;
        const t = (apx * abx + apy * aby) / len2;
        if (t < -eps || t > 1 + eps) return false;
        const qx = a.x + abx * t, qy = a.y + aby * t;
        return Math.hypot(p.x - qx, p.y - qy) <= eps;
    };
    const pointOnFaceBoundaryForSubtract = (p, face, eps = 1.0) => {
        if (!Array.isArray(face) || face.length < 2) return false;
        for (let i = 0; i < face.length; i++) {
            if (pointOnSegmentForSubtract(p, face[i], face[(i + 1) % face.length], eps)) return true;
        }
        return false;
    };
    const pointInsideOrOnFaceForSubtract = (p, face) => {
        return isPointInPoly(p.x, p.y, face) || pointOnFaceBoundaryForSubtract(p, face);
    };
    // All vertices must be inside the face, but points sitting directly on
    // the face edge are valid so holes can be bored right up to that edge.
    const isFullyInside = (hole, face) => {
        for (let i = 0; i < hole.length; i++) {
            if (!pointInsideOrOnFaceForSubtract(hole[i], face)) return false;
        }
        return true;
    };
    let modified = false;
    // 1. Check Manual Faces
    if (activeGeometry.manualFaces) {
        activeGeometry.manualFaces.forEach(mf => {
            if (isFullyInside(holePoly, mf.points)) {
                if (!mf.holes) mf.holes = [];
                const sig = getLocalFaceSignature(holePoly);
                const exists = mf.holes.some(h => getLocalFaceSignature(h) === sig);
                if (!exists) {
                    mf.holes.push(holePoly);
                    modified = true;
                }
            }
        });
    }
    // 2. Check Auto Faces (rendered currently)
    if (window.currentFaceDataForSVG) {
        window.currentFaceDataForSVG.forEach(faceData => {
            const sig = getLocalFaceSignature(faceData.points);
            const isManual = activeGeometry.manualFaces && activeGeometry.manualFaces.some(mf => getLocalFaceSignature(mf.points) === sig);
            
            if (!isManual) {
                if (isFullyInside(holePoly, faceData.points)) {
                    // Convert to Manual
                    if (!activeGeometry.manualFaces) activeGeometry.manualFaces = [];
                    activeGeometry.manualFaces.push({
                        points: faceData.points,
                        holes: [holePoly],
                        layer: faceData.layer || 1
                    });
                    modified = true;
                }
            }
        });
    }
    if (modified) {
        save2DState();
        
        invalidateFaceCache();
        if (typeof renderFinalPass === 'function') renderFinalPass();
        
        checkAndTriggerMeasurementUpdate();
        triggerLiveUpdate();
        console.log("Face subtraction applied.");
    }
}
function getManualCleanupPointKey(pt) {
    if (!pt) return 'null';
    const idx = activeGeometry && Array.isArray(activeGeometry.points) ? activeGeometry.points.indexOf(pt) : -1;
    if (idx !== -1) return `i:${idx}`;
    return `c:${Math.round((pt.x || 0) * 1000)},${Math.round((pt.y || 0) * 1000)},${Math.round(((pt.z !== undefined && pt.z !== null) ? pt.z : 0) * 1000)},${pt.layer || 1}`;
}
function getManualCleanupEdgeKey(a, b) {
    const ka = getManualCleanupPointKey(a);
    const kb = getManualCleanupPointKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
function ringUsesDeletedGeometry(ring, deletedPoints, deletedEdgeKeys) {
    if (!Array.isArray(ring) || ring.length < 3) return true;
    for (let i = 0; i < ring.length; i++) {
        if (deletedPoints && deletedPoints.has(ring[i])) return true;
        const next = ring[(i + 1) % ring.length];
        if (deletedEdgeKeys && deletedEdgeKeys.has(getManualCleanupEdgeKey(ring[i], next))) return true;
    }
    return false;
}
function ringExistsInCurrentGeometry(ring, currentPointSet, currentEdgeKeys) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    for (let i = 0; i < ring.length; i++) {
        const pt = ring[i];
        if (!currentPointSet.has(pt)) return false;
        const next = ring[(i + 1) % ring.length];
        if (!currentPointSet.has(next)) return false;
        if (!currentEdgeKeys.has(getManualCleanupEdgeKey(pt, next))) return false;
    }
    return true;
}
window.cleanupInvalidManualFaces = function() {
    if (!activeGeometry || !Array.isArray(activeGeometry.manualFaces)) return;
    const currentPointSet = new Set(activeGeometry.points || []);
    const currentEdgeKeys = new Set();
    (activeGeometry.connections || []).forEach(conn => {
        if (conn && conn.start && conn.end) currentEdgeKeys.add(getManualCleanupEdgeKey(conn.start, conn.end));
    });

    activeGeometry.manualFaces = activeGeometry.manualFaces
        .map(face => {
            if (!face || !ringExistsInCurrentGeometry(face.points, currentPointSet, currentEdgeKeys)) return null;
            const holes = Array.isArray(face.holes) ? face.holes : [];
            return {
                ...face,
                holes: holes.filter(hole => ringExistsInCurrentGeometry(hole, currentPointSet, currentEdgeKeys))
            };
        })
        .filter(Boolean);
};
window.cleanupManualFacesAfterDeletedGeometry = function(deletedLines, deletedPoints) {
    if (!activeGeometry || !Array.isArray(activeGeometry.manualFaces)) return;
    const pointSet = deletedPoints instanceof Set ? deletedPoints : new Set(deletedPoints || []);
    const edgeKeys = new Set();
    if (deletedLines && typeof deletedLines.forEach === 'function') {
        deletedLines.forEach(conn => {
            if (conn && conn.start && conn.end) edgeKeys.add(getManualCleanupEdgeKey(conn.start, conn.end));
        });
    }
    if (pointSet.size === 0 && edgeKeys.size === 0) return;

    activeGeometry.manualFaces = activeGeometry.manualFaces
        .map(face => {
            if (!face || !Array.isArray(face.points)) return null;
            if (ringUsesDeletedGeometry(face.points, pointSet, edgeKeys)) return null;
            const holes = Array.isArray(face.holes) ? face.holes : [];
            return {
                ...face,
                holes: holes.filter(hole => !ringUsesDeletedGeometry(hole, pointSet, edgeKeys))
            };
        })
        .filter(face => face && Array.isArray(face.points) && face.points.length >= 3);
};
function deleteSelected2D() {
    if (!activeGeometry) return;
    save2DState();
    // PRIORITY 1: FACE DELETION
    if (typeof selectedFaceSignatures !== 'undefined' && selectedFaceSignatures.size > 0) {
        selectedFaceSignatures.forEach(sig => {
            deletedFaceSignatures.add(sig);
            if (activeGeometry.manualFaces) {
                activeGeometry.manualFaces = activeGeometry.manualFaces.filter(mf => getFaceSignature(mf) !== sig);
            }
        });
        selectedFaceSignatures.clear();
    } 
    // PRIORITY 2: GEOMETRY DELETION
    else {
        if (selectedLines.size > 0) {
            if (typeof window.cleanupManualFacesAfterDeletedGeometry === 'function') {
                window.cleanupManualFacesAfterDeletedGeometry(selectedLines, selectedPoints);
            }
            activeGeometry.connections = activeGeometry.connections.filter(conn => !selectedLines.has(conn));
            selectedLines.clear();
        }
        if (selectedPoints.size > 0) {
            activeGeometry.connections = activeGeometry.connections.filter(conn => 
                !selectedPoints.has(conn.start) && !selectedPoints.has(conn.end)
            );
            
            if (activeGeometry.manualFaces) {
                window.cleanupManualFacesAfterDeletedGeometry(new Set(), selectedPoints);
            }
            activeGeometry.points = activeGeometry.points.filter(pt => !selectedPoints.has(pt));
            selectedPoints.clear();
        }
        if (selectedVents.size > 0 && activeGeometry.vents) {
            activeGeometry.vents = activeGeometry.vents.filter(v => !selectedVents.has(v));
            selectedVents.clear();
        }
    }
    if (typeof window.cleanupInvalidManualFaces === 'function') {
        window.cleanupInvalidManualFaces();
    }
    
    // Render Visuals
    if (typeof invalidateFaceCache === 'function') invalidateFaceCache();
    renderGeometry2D();
    if(typeof renderGeometry3D === 'function') renderGeometry3D();
    if (typeof renderFinalPass === 'function') renderFinalPass();
    // Automatic recalculation removed.
    
    triggerLiveUpdate();
}
function updateZoom() {
    const slider = document.getElementById('zoomRange');
    if(slider) {
        // --- CHANGE: Dynamically expand slider range if wheel zooms past it ---
        const currentMax = parseFloat(slider.max);
        if (currentZoom > currentMax) {
            slider.max = Math.ceil(currentZoom + 10);
        }
        slider.value = currentZoom.toFixed(1);
    }
    
    updateTransform();
    
    redrawCanvas(); 
    renderGeometry2D(); 
}
function updateZoomViaSlider() {
    const slider = document.getElementById('zoomRange');
    const oldZoom = currentZoom;
    const newZoom = parseFloat(slider.value);
    // Ensure the slider max in HTML matches the JS logic, or clamp here if needed
    // Assuming HTML is updated or we just process value:
    
    const rect = document.getElementById('viewport').getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const imgX = (centerX - panX) / oldZoom;
    const imgY = (centerY - panY) / oldZoom;
    currentZoom = newZoom;
    panX = centerX - (imgX * currentZoom);
    panY = centerY - (imgY * currentZoom);
    
    updateTransform();
    
    redrawCanvas();
    renderGeometry2D();
}
function onWheel2D(e) {
    e.preventDefault();
    if (e.ctrlKey) {
        const step = 1;
        const delta = e.deltaY < 0 ? step : -step;
        
        let newRad = snapRadius + delta;
        newRad = Math.max(1, Math.min(40, newRad));
        
        if (newRad !== snapRadius) {
            snapRadius = newRad;
            
            const input = document.getElementById('snapRadiusInput');
            const label = document.getElementById('snapRadiusVal');
            if (input) input.value = snapRadius;
            if (label) label.innerText = snapRadius;
            
            updateSnapRing(e.clientX, e.clientY, true);
        }
        return; 
    }
    const rect = document.getElementById('viewport').getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    // 1. Calculate World Position (Image Coordinates) under mouse BEFORE zoom
    const imgX = (mouseX - panX) / currentZoom;
    const imgY = (mouseY - panY) / currentZoom;
    // 2. Calculate New Zoom (Multiplicative)
    // Using a multiplier ensures the zoom rate feels constant at any scale.
    // 1.15 = 15% change per tick.
    const zoomFactor = 1.15; 
    let newZoom = currentZoom;
    if (e.deltaY < 0) {
        // Zoom In
        newZoom = currentZoom * zoomFactor;
    } else {
        // Zoom Out
        newZoom = currentZoom / zoomFactor;
    }
    // 3. Clamp (Allow high granularity zooming up to 50x)
    newZoom = Math.max(0.1, Math.min(100, newZoom));
    // optimization: skip if change is negligible
    if (Math.abs(newZoom - currentZoom) < 0.0001) return;
    currentZoom = newZoom;
    // 4. Calculate New Pan to keep the World Position under the mouse stationary
    // mouseX = newPanX + (imgX * newZoom)
    // newPanX = mouseX - (imgX * newZoom)
    panX = mouseX - (imgX * newZoom);
    panY = mouseY - (imgY * newZoom);
    
    updateZoom();
}
function updateTransform() {
    const zoomLayer = document.getElementById('zoom-layer');
    if (zoomLayer) {
        zoomLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
    }
}
function updatePointScales() {
    const invScale = 1 / currentZoom;
    document.querySelectorAll('.geo-line').forEach(el => {
        if (el.classList.contains('geo-line-highlight')) {
            el.style.strokeWidth = (6 * invScale) + 'px';
        } else if (el.classList.contains('selected-line')) {
            el.style.strokeWidth = (3 * invScale) + 'px';
        } else {
            el.style.strokeWidth = (2 * invScale) + 'px';
        }
        if (el.style.strokeDasharray) {
            el.style.strokeDasharray = `${5*invScale},${5*invScale}`;
        }
    });
    const visRadius = 2.5 * invScale;
    const hitRadius = 8 * invScale;
    document.querySelectorAll('.geo-point-vis').forEach(el => {
        el.setAttribute('r', visRadius);
        const isSelected = el.parentElement.classList.contains('selected');
        el.style.strokeWidth = (isSelected ? 2 : 1) * invScale + 'px';
    });
    document.querySelectorAll('.geo-point-hitbox').forEach(el => {
        el.setAttribute('r', hitRadius);
    });
    const ind = document.getElementById('snap-indicator');
    if(ind) ind.style.transform = `translate(-50%, -50%) scale(${invScale})`;
}
// ==========================================
// NEW COMPLEX SNAPPING LOGIC (Dual Guide)
// ==========================================
function getComplexSnap(x, y, radius, excludeSet = null) {
    if (!activeGeometry) return null;
    activeSnapGuides = []; // Reset
    const anchors = [];
    if (interactState === 'NEW_POINT' && tempPoint) {
        selectedPoints.forEach(pt => anchors.push(pt)); 
    } else if (interactState === 'MOVING') {
        // Find neighbors of the moving point(s)
        activeGeometry.connections.forEach(conn => {
            if (!layerVisibility[conn.start.layer || 1]) return;
            const sSel = selectedPoints.has(conn.start);
            const eSel = selectedPoints.has(conn.end);
            if (sSel && !eSel) anchors.push(conn.end);
            if (!sSel && eSel) anchors.push(conn.start);
        });
    }
    // --- UPDATED: Pass anchors to get nearby guides including Global Axis ---
    const nearbyGuides = getAllNearbyGuides(x, y, radius * 3, excludeSet, anchors); 
    
    const angularRays = getAngularRays(anchors);
    const candidates = [];
    // 1. Intersection: Guide vs Guide (Yellow + Yellow)
    for (let i = 0; i < nearbyGuides.length; i++) {
        for (let j = i + 1; j < nearbyGuides.length; j++) {
            const g1 = nearbyGuides[i];
            const g2 = nearbyGuides[j];
            
            // Intersect
            const pt = getLineIntersection(g1.p1, g1.p2, g2.p1, g2.p2);
            if (pt) {
                const d = Math.hypot(pt.x - x, pt.y - y);
                if (d < radius) {
                    candidates.push({
                        x: pt.x, y: pt.y, dist: d * 0.8, // Priority
                        guides: [g1, g2]
                    });
                }
            }
        }
    }
    // 2. Intersection: Guide vs Angular Ray (Yellow + Self Angle)
    for (let g of nearbyGuides) {
        for (let ray of angularRays) {
            // Ray defined by origin + vector
            const rayEnd = { x: ray.origin.x + Math.cos(ray.angle) * 1000, y: ray.origin.y + Math.sin(ray.angle) * 1000 };
            const pt = getLineIntersection(g.p1, g.p2, ray.origin, rayEnd);
            if (pt) {
                const d = Math.hypot(pt.x - x, pt.y - y);
                if (d < radius) {
                    candidates.push({
                        x: pt.x, y: pt.y, dist: d * 0.9, // Priority
                        guides: [g] 
                    });
                }
            }
        }
    }
    // 3. Fallback: Single Guide Snap (Slide along line)
    // If no intersection is close enough, check proximity to lines themselves
    if (candidates.length === 0) {
        for (let g of nearbyGuides) {
            // Project x,y onto g
            const dx = g.p2.x - g.p1.x;
            const dy = g.p2.y - g.p1.y;
            const len2 = dx*dx + dy*dy;
            if (len2 === 0) continue;
            
            // Project point onto line
            const t = ((x - g.p1.x) * dx + (y - g.p1.y) * dy) / len2;
            const projX = g.p1.x + t * dx;
            const projY = g.p1.y + t * dy;
            
            const d = Math.hypot(x - projX, y - projY);
            if (d < radius) {
                candidates.push({
                    x: projX, y: projY, dist: d,
                    guides: [g]
                });
            }
        }
    }
    // Select Best
    candidates.sort((a,b) => a.dist - b.dist);
    
    if (candidates.length > 0) {
        const best = candidates[0];
        if (best.guides) {
            best.guides.forEach(g => {
                activeSnapGuides.push({ p1: g.p1, p2: g.p2 });
            });
        }
        return { x: best.x, y: best.y };
    }
    return null;
}
function getAllNearbyGuides(x, y, searchRadius, excludeSet, extraAnchors = []) {
    const guides = [];
    if (!activeGeometry) return guides;
    // Get current view rotation to calculate screen-relative axes
    const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
    
    // Constant for 45 degree calculations (cos(45) and sin(45))
    const SQRT2_INV = 0.70710678; 
    activeGeometry.connections.forEach(conn => {
        if (!layerVisibility[conn.start.layer || 1]) return;
        if (excludeSet && (excludeSet.has(conn.start) || excludeSet.has(conn.end))) return;
        const p1 = conn.start;
        const p2 = conn.end;
        
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) return;
        
        // Normalized Tangent (Direction of line)
        const tangentX = dx / len;
        const tangentY = dy / len;
        // Normalized Normal (Perpendicular 90 deg)
        const normalX = -dy / len;
        const normalY = dx / len;
        
        // 1. Parallel Guide (0 / 180 degrees relative to line)
        // Distance from point (x,y) to infinite line defined by p1 -> p2
        const distPara = Math.abs((x - p1.x) * normalX + (y - p1.y) * normalY);
        if (distPara < searchRadius) {
            guides.push({ p1: p1, p2: p2, type: 'parallel' });
        }
        // 2. Perpendicular Guides (90 degrees relative to line, at endpoints)
        // Check distance to line projecting from P1
        const distP1 = Math.abs((x - p1.x) * tangentX + (y - p1.y) * tangentY);
        if (distP1 < searchRadius) {
            const p1PerpEnd = { x: p1.x + normalX * 100, y: p1.y + normalY * 100 };
            guides.push({ p1: p1, p2: p1PerpEnd, type: 'perp' });
        }
        // Check distance to line projecting from P2
        const distP2 = Math.abs((x - p2.x) * tangentX + (y - p2.y) * tangentY);
        if (distP2 < searchRadius) {
            const p2PerpEnd = { x: p2.x + normalX * 100, y: p2.y + normalY * 100 };
            guides.push({ p1: p2, p2: p2PerpEnd, type: 'perp' });
        }
        // 3. 45 Degree Guides (Relative to line segment)
        // We calculate vectors rotated +45 and -45 (covering 45, 135, 225, 315) relative to the line.
        
        // Vector A (+45 deg): x' = x*cos - y*sin, y' = x*sin + y*cos
        const v45x = tangentX * SQRT2_INV - tangentY * SQRT2_INV;
        const v45y = tangentX * SQRT2_INV + tangentY * SQRT2_INV;
        // Normal to Vector A (for distance calc)
        const n45x = -v45y;
        const n45y = v45x;
        // Vector B (-45 deg / 135 deg)
        const v135x = tangentX * SQRT2_INV + tangentY * SQRT2_INV;
        const v135y = -tangentX * SQRT2_INV + tangentY * SQRT2_INV;
        // Normal to Vector B
        const n135x = -v135y;
        const n135y = v135x;
        // --- Check 45s from P1 ---
        const distP1_45 = Math.abs((x - p1.x) * n45x + (y - p1.y) * n45y);
        if (distP1_45 < searchRadius) {
             guides.push({
                 p1: p1,
                 p2: { x: p1.x + v45x * 100, y: p1.y + v45y * 100 },
                 type: 'angle-45'
             });
        }
        const distP1_135 = Math.abs((x - p1.x) * n135x + (y - p1.y) * n135y);
        if (distP1_135 < searchRadius) {
             guides.push({
                 p1: p1,
                 p2: { x: p1.x + v135x * 100, y: p1.y + v135y * 100 },
                 type: 'angle-135'
             });
        }
        // --- Check 45s from P2 ---
        const distP2_45 = Math.abs((x - p2.x) * n45x + (y - p2.y) * n45y);
        if (distP2_45 < searchRadius) {
             guides.push({
                 p1: p2,
                 p2: { x: p2.x + v45x * 100, y: p2.y + v45y * 100 },
                 type: 'angle-45'
             });
        }
        const distP2_135 = Math.abs((x - p2.x) * n135x + (y - p2.y) * n135y);
        if (distP2_135 < searchRadius) {
             guides.push({
                 p1: p2,
                 p2: { x: p2.x + v135x * 100, y: p2.y + v135y * 100 },
                 type: 'angle-135'
             });
        }
    });
    // --- UPDATED: Global Axis Guides relative to SCREEN grid ---
    if (extraAnchors && extraAnchors.length > 0) {
        extraAnchors.forEach(anchor => {
             // Screen Horizontal (matches universal grid)
             guides.push({ 
                 p1: anchor, 
                 p2: { x: anchor.x + Math.cos(-rot), y: anchor.y + Math.sin(-rot) }, 
                 type: 'global-screen-x' 
             });
             // Screen Vertical (matches universal grid)
             guides.push({ 
                 p1: anchor, 
                 p2: { x: anchor.x + Math.cos(-rot + Math.PI/2), y: anchor.y + Math.sin(-rot + Math.PI/2) }, 
                 type: 'global-screen-y' 
             });
        });
    }
    return guides;
}
function getAngularRays(anchors) {
    const rays = [];
    if (!anchors) return rays;
    
    const rot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
    for (let anchor of anchors) {
        // --- UPDATED: Base angles are now relative to screen orientation ---
        let baseAngles = [
            -rot,              // Screen Right
            -rot + Math.PI/2,  // Screen Down
            -rot + Math.PI,    // Screen Left
            -rot - Math.PI/2   // Screen Up
        ]; 
        
        activeGeometry.connections.forEach(conn => {
            if (!layerVisibility[conn.start.layer || 1]) return;
            if (conn.start === anchor || conn.end === anchor) {
                const other = (conn.start === anchor) ? conn.end : conn.start;
                baseAngles.push(Math.atan2(other.y - anchor.y, other.x - anchor.x));
            }
        });
        for (let base of baseAngles) {
            for (let i = -4; i <= 4; i++) { 
                const ang = base + (i * Math.PI / 4);
                rays.push({ origin: anchor, angle: ang });
            }
        }
    }
    return rays;
}
// Replaces the old function with simplified logic or just kept for fallback
function getClosestAngularSnap(x, y, radius, excludePoints = null) {
    if (!activeGeometry) return null;
    let bestPt = null;
    let minD = radius;
    const anchors = [];
    if (interactState === 'NEW_POINT') {
        selectedPoints.forEach(pt => anchors.push(pt));
    } else if (interactState === 'MOVING') {
        activeGeometry.connections.forEach(conn => {
            if (!layerVisibility[conn.start.layer || 1]) return; 
            const sSel = selectedPoints.has(conn.start);
            const eSel = selectedPoints.has(conn.end);
            if (sSel && !eSel) anchors.push(conn.end);
            if (!sSel && eSel) anchors.push(conn.start);
        });
    }
    for (let anchor of anchors) {
        let baseAngles = [0, Math.PI/2, Math.PI, -Math.PI/2]; 
        activeGeometry.connections.forEach(conn => {
            if (!layerVisibility[conn.start.layer || 1]) return;
            if (conn.start === anchor || conn.end === anchor) {
                const other = (conn.start === anchor) ? conn.end : conn.start;
                if (excludePoints && excludePoints.has(other)) return;
                baseAngles.push(Math.atan2(other.y - anchor.y, other.x - anchor.x));
            }
        });
        const dx = x - anchor.x;
        const dy = y - anchor.y;
        for (let base of baseAngles) {
            for (let i = -4; i <= 4; i++) {
                const ang = base + (i * Math.PI / 4);
                const ux = Math.cos(ang);
                const uy = Math.sin(ang);
                const distAlong = dx * ux + dy * uy;
                if (distAlong < 0) continue; 
                
                const projX = anchor.x + distAlong * ux;
                const projY = anchor.y + distAlong * uy;
                
                const d = Math.hypot(x - projX, y - projY);
                if (d < minD) {
                    minD = d;
                    bestPt = { x: projX, y: projY };
                }
            }
        }
    }
    return bestPt;
}
function getRaySegmentIntersection(rayOrigin, rayAngle, segStart, segEnd) {
    const dx = Math.cos(rayAngle);
    const dy = Math.sin(rayAngle);
    const x1 = rayOrigin.x, y1 = rayOrigin.y;
    const x2 = x1 + dx, y2 = y1 + dy;
    const x3 = segStart.x, y3 = segStart.y;
    const x4 = segEnd.x, y4 = segEnd.y;
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (den === 0) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
    if (u >= 0 && u <= 1) return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
    return null;
}
function getProjectedPoint(p, v, w) {
    const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
    if (l2 === 0) return { x: v.x, y: v.y, t: 0 };
    
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    
    return {
        x: v.x + t * (w.x - v.x),
        y: v.y + t * (w.y - v.y),
        t: t
    };
}

function getKnownPointZ(pt) {
    if (pt && Number.isFinite(Number(pt.z))) return Number(pt.z);
    try {
        if (pt && typeof layerData !== 'undefined' && layerData?.dsm?.[0] && imageWidth > 0 && imageHeight > 0) {
            const ix = Math.max(0, Math.min(imageWidth - 1, Math.round(pt.x)));
            const iy = Math.max(0, Math.min(imageHeight - 1, Math.round(pt.y)));
            const z = layerData.dsm[0][iy * imageWidth + ix];
            if (Number.isFinite(z) && z > -9000) return z;
        }
    } catch (e) {}
    return null;
}

function interpolateKnownLineZ(conn, t, x, y) {
    if (!conn || !conn.start || !conn.end) return null;
    const za = getKnownPointZ(conn.start);
    const zb = getKnownPointZ(conn.end);
    if (Number.isFinite(za) && Number.isFinite(zb)) return za + (zb - za) * Math.max(0, Math.min(1, t || 0));
    if (Number.isFinite(za)) return za;
    if (Number.isFinite(zb)) return zb;
    return getKnownPointZ({ x, y });
}

function attemptLineSplit(x, y, tolerance) {
    for (let i = activeGeometry.connections.length - 1; i >= 0; i--) {
        const conn = activeGeometry.connections[i];
        
        if (!layerVisibility[conn.start.layer || 1]) continue;
        const proj = getProjectedPoint({x,y}, conn.start, conn.end);
        const dist = Math.hypot(x - proj.x, y - proj.y);
        
        if (dist < tolerance) {
            // Prevent splitting too close to the existing endpoints
            const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
            const distStart = Math.hypot(proj.x - conn.start.x, proj.y - conn.start.y);
            const distEnd = Math.hypot(proj.x - conn.end.x, proj.y - conn.end.y);
            const lineLen = Math.hypot(conn.start.x - conn.end.x, conn.start.y - conn.end.y);
            const limit = Math.min(lineLen * 0.1, 5 / cz);
            if (distStart < limit || distEnd < limit) continue;
            
            const targetLayer = conn.start.layer || 1;
            
            let finalX = proj.x;
            let finalY = proj.y;
            // 1. Check if Snapping is enabled (!isFreeMove)
            // 2. Check if Centerpoints are toggled ON (showCenterpoints)
            if ((typeof isFreeMove === 'undefined' || !isFreeMove) && 
                (typeof showCenterpoints !== 'undefined' && showCenterpoints)) {
                
                const midX = (conn.start.x + conn.end.x) / 2;
                const midY = (conn.start.y + conn.end.y) / 2;
                
                // Calculate distance from the projected split point to the line's midpoint
                const distToMid = Math.hypot(finalX - midX, finalY - midY);
                
                // Convert global snapRadius (screen pixels) to image coordinate space
                const sRad = (typeof snapRadius !== 'undefined' ? snapRadius : 20) / currentZoom;
                
                if (distToMid < sRad) {
                    finalX = midX;
                    finalY = midY;
                }
            }
            const finalProj = getProjectedPoint({ x: finalX, y: finalY }, conn.start, conn.end);
            const finalZ = interpolateKnownLineZ(conn, finalProj.t, finalX, finalY);
            const newPt = {
                x: finalX,
                y: finalY,
                z: Number.isFinite(finalZ) ? finalZ : null,
                layer: targetLayer,
                zLocked: Number.isFinite(finalZ)
            };
            
            activeGeometry.points.push(newPt);
            activeGeometry.connections.splice(i, 1);
            activeGeometry.connections.push({ start: conn.start, end: newPt });
            activeGeometry.connections.push({ start: newPt, end: conn.end });
            return newPt;
        }
    }
    return null;
}
window.renderFaces2D = function(facesData, containerArg) {
    const svg = document.getElementById('geoSvg');
    if (!svg) return;
    let target = containerArg || document.getElementById('geo-rotation-group') || svg;
    const isVisible = (typeof showFacesLayer !== 'undefined') ? showFacesLayer : true; 
    const existing = target.querySelectorAll('.generated-face');
    existing.forEach(el => el.remove());
    window.currentFaceDataForSVG = facesData;
    facesData.forEach((data, idx) => {
        if (data.layer && !layerVisibility[data.layer]) return; 
        const points = data.points || data; 
        const holes = data.holes || [];
        
        let fillColor;
        if (data.color) {
            fillColor = data.color;
        } else {
            const hue = (idx * 137.5) % 360;
            fillColor = `hsl(${hue}, 70%, 50%)`;
        }
        let d = `M ${points[0].x} ${points[0].y} `;
        for(let i=1; i<points.length; i++) d += `L ${points[i].x} ${points[i].y} `;
        d += "Z "; 
        holes.forEach(holePts => {
            d += `M ${holePts[0].x} ${holePts[0].y} `;
            for(let k=1; k<holePts.length; k++) d += `L ${holePts[k].x} ${holePts[k].y} `;
            d += "Z "; 
        });
        const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathEl.setAttribute("d", d);
        pathEl.setAttribute("fill", fillColor);
        pathEl.setAttribute("fill-opacity", "0.2"); 
        pathEl.setAttribute("fill-rule", "evenodd");
        pathEl.setAttribute("stroke", "none");
        pathEl.setAttribute("class", "generated-face");
        pathEl.style.pointerEvents = "none"; 
        pathEl.style.display = isVisible ? 'block' : 'none';
        if (target.firstChild) target.insertBefore(pathEl, target.firstChild);
        else target.appendChild(pathEl);
    });
}
function findClosestLine(x, y, tolerance) {
    let best = null;
    let minD = tolerance;
    for (let i = 0; i < activeGeometry.connections.length; i++) {
        const conn = activeGeometry.connections[i];
        
        if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) continue;
        if (!layerVisibility[conn.start.layer || 1]) continue;
        const proj = getProjectedPoint({x,y}, conn.start, conn.end);
        const dist = Math.hypot(x - proj.x, y - proj.y);
        if (dist < minD) {
            const cz = (typeof currentZoom !== 'undefined' && currentZoom) ? currentZoom : 1;
            const distStart = Math.hypot(proj.x - conn.start.x, proj.y - conn.start.y);
            const distEnd = Math.hypot(proj.x - conn.end.x, proj.y - conn.end.y);
            const lineLen = Math.hypot(conn.start.x - conn.end.x, conn.start.y - conn.end.y);
            const limit = Math.min(lineLen * 0.1, 5 / cz);
            if (distStart >= limit && distEnd >= limit) {
                minD = dist;
                best = { conn: conn, x: proj.x, y: proj.y, index: i };
            }
        }
    }
    return best;
}
function splitConnection(conn, x, y, layer) {
    const proj = getProjectedPoint({ x, y }, conn.start, conn.end);
    const lineZ = interpolateKnownLineZ(conn, proj.t, x, y);
    const newPt = {
        x: x, y: y, z: Number.isFinite(lineZ) ? lineZ : null,
        layer: layer, zLocked: Number.isFinite(lineZ)
    };
    
    activeGeometry.points.push(newPt);
    const idx = activeGeometry.connections.indexOf(conn);
    if (idx > -1) activeGeometry.connections.splice(idx, 1);
    activeGeometry.connections.push({ start: conn.start, end: newPt });
    activeGeometry.connections.push({ start: newPt, end: conn.end });
    return newPt;
}
function enterVentPlacementMode(count) {
    if (!activeGeometry.vents) {
        activeGeometry.vents = [];
    }
    
    ventPlacementCount = count;
    interactState = 'PLACING_VENTS'; 
    selectionMode = 'POINT'; 
    
    const modeLabel = document.getElementById('modeLabel');
    if(modeLabel) {
        modeLabel.textContent = `PLACE VENTS`;
        modeLabel.style.backgroundColor = "#ff9800"; 
        modeLabel.style.color = "white";
    }
    
    renderGeometry2D();
}
function exitVentPlacementMode() {
    interactState = 'IDLE';
    ventPlacementCount = 0;
    
    const modeLabel = document.getElementById('modeLabel');
    if(modeLabel) {
        modeLabel.textContent = (typeof selectionMode !== 'undefined' ? selectionMode : 'POINT') + " MODE";
        modeLabel.style.backgroundColor = "";
        modeLabel.style.color = "";
    }
    
    renderGeometry2D();
}
function checkAndTriggerMeasurementUpdate() {
    if (typeof window.ensureAllPointsHaveZ === 'function') window.ensureAllPointsHaveZ();
}
// --- HELPER: Math for Infinite Intersection ---
function getLineIntersection(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (denom === 0) return null; // Parallel
    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    
    return {
        x: x1 + ua * (x2 - x1),
        y: y1 + ua * (y2 - y1)
    };
}
function calculateVentSnapping(mouseX, mouseY, radius) {
    if (!activeGeometry || !activeGeometry.vents) return null;
    if (activeGeometry.vents.length < 2) return null;
    const vents = activeGeometry.vents;
    // 1. EQUIDISTANT PATTERN SNAP (High Priority)
    for (let i = 0; i < vents.length; i++) {
        for (let j = 0; j < vents.length; j++) {
            if (i === j) continue;
            
            const vA = vents[i];
            const vB = vents[j];
            
            const dx = vB.x - vA.x;
            const dy = vB.y - vA.y;
            
            const predX = vB.x + dx;
            const predY = vB.y + dy;
            
            const dist = Math.hypot(mouseX - predX, mouseY - predY);
            
            if (dist < radius) {
                activeSnapGuides.push({ p1: vA, p2: {x: predX, y: predY} });
                return { x: predX, y: predY };
            }
        }
    }
    // 2. LINE ALIGNMENT SNAP (Medium Priority)
    for (let i = 0; i < vents.length; i++) {
        for (let j = i + 1; j < vents.length; j++) {
            const vA = vents[i];
            const vB = vents[j];
            
            const val = getProjectedPoint({x: mouseX, y: mouseY}, vA, vB);
            const distToLine = Math.hypot(mouseX - val.x, mouseY - val.y);
            
            if (distToLine < radius) {
                activeSnapGuides.push({ p1: vA, p2: vB });
                return { x: val.x, y: val.y };
            }
        }
    }
    return null;
}
// --- NEW FUNCTION: Shared Finalize Logic ---
function finalizeMoveLogic() {
    if (selectionMode === 'POINT') {
        const sRad = snapRadius / currentZoom;
        const excludeSet = selectedPoints; 
        
        // We collect all necessary actions first, then execute them
        const mergesToPerform = [];
        const splitsToPerform = [];
        selectedPoints.forEach(pt => {
            // 1. Check for Point-to-Point Snap (Merge)
            const snapTarget = getClosestPoint(pt.x, pt.y, sRad, excludeSet);
            
            if (snapTarget) {
                const alreadyTargeted = mergesToPerform.some(m => m.source === pt);
                if (!alreadyTargeted && pt.layer === snapTarget.layer) {
                    mergesToPerform.push({ source: pt, target: snapTarget });
                }
            } 
            else {
                // 2. Check for Midpoint Snap (Split)
                // We check this with a tight tolerance because the point should have been snapped 
                // exactly to the midpoint during mousemove if that was the intent.
                let midSnap = null;
                if (typeof showCenterpoints !== 'undefined' && showCenterpoints) {
                    // Use a small epsilon since pt is already moved to exact coords
                    midSnap = getClosestMidpoint(pt.x, pt.y, 1e-4, excludeSet);
                }
                if (midSnap && midSnap.conn) {
                     const targetLayer = midSnap.conn.start.layer || 1;
                     // Only split if layers match, otherwise just place on top
                     if (pt.layer === targetLayer) {
                         splitsToPerform.push({ source: pt, targetLine: { conn: midSnap.conn } });
                     }
                } else {
                    // 3. Check for Line Split (General Projection)
                    const lineHit = findClosestLine(pt.x, pt.y, 10 / currentZoom);
                    if (lineHit) {
                         const s = lineHit.conn.start; 
                         const e = lineHit.conn.end;
                         
                         if (!excludeSet.has(s) && !excludeSet.has(e)) {
                             const targetLayer = s.layer || 1;
                             if (pt.layer === targetLayer) {
                                 splitsToPerform.push({ source: pt, targetLine: lineHit });
                             }
                         }
                    }
                }
            }
        });
        // Execute Merges
        const processedSources = new Set();
        mergesToPerform.forEach(m => {
            if (!processedSources.has(m.source)) {
                mergePoints(m.source, m.target);
                processedSources.add(m.source);
            }
        });
        // Execute Splits
        splitsToPerform.forEach(op => {
            if (!processedSources.has(op.source)) {
                const hit = op.targetLine;
                const source = op.source;
                const conn = hit.conn;
                
                // Verify connection still exists
                if (activeGeometry.connections.includes(conn)) {
                    activeGeometry.connections = activeGeometry.connections.filter(c => c !== conn);
                    activeGeometry.connections.push({ start: conn.start, end: source });
                    activeGeometry.connections.push({ start: source, end: conn.end });
                }
            }
        });
    }
}
// Paste into console, then call:
//   straightenViewToDominant90Frame()
// or:
//   straightenViewToDominant90Frame({ tolDeg: 6, minLenPx: 12, debug: true })
//
// This finds the dominant 90°-equivalence "frame" across visible geometry lines
// (weighted by total line length), uses the biggest line in that frame as the
// anchor, then adjusts *viewRotation* so that frame becomes axis-aligned.
//
// Effect: same as "rotating the entire frame" (your viewRotation pipeline).
window.straightenViewToDominant90Frame = function straightenViewToDominant90Frame(opts = {}) {
  const deg = (r) => r * 180 / Math.PI;
  const rad = (d) => d * Math.PI / 180;
  const tolDeg   = Number.isFinite(opts.tolDeg) ? opts.tolDeg : 6;
  const minLenPx = Number.isFinite(opts.minLenPx) ? opts.minLenPx : 12;
  const requireVisibleLayers = (opts.requireVisibleLayers !== false); // default true
  const debug = !!opts.debug;
  const wrapPi = (a) => {
    while (a < -Math.PI) a += Math.PI * 2;
    while (a >= Math.PI) a -= Math.PI * 2;
    return a;
  };
  const wrapHalfPi = (a) => {
    while (a < -Math.PI / 2) a += Math.PI;
    while (a >= Math.PI / 2) a -= Math.PI;
    return a;
  };
  // "frame residual" in [-45°, +45°] relative to nearest 90°
  const residualToNearest90 = (angleRad) => {
    let a = wrapPi(angleRad);
    const k = Math.round(a / (Math.PI / 2));
    a = a - k * (Math.PI / 2);
    a = wrapHalfPi(a);
    if (a >  Math.PI/4) a -= Math.PI/2;
    if (a <= -Math.PI/4) a += Math.PI/2;
    return a; // [-pi/4, +pi/4]
  };
  if (!window.activeGeometry || !activeGeometry.connections) {
    console.warn("[straightenView] No activeGeometry.connections");
    return null;
  }
  const samples = [];
  for (let i = 0; i < activeGeometry.connections.length; i++) {
    const c = activeGeometry.connections[i];
    if (!c || !c.start || !c.end) continue;
    const layer = c.start.layer || 1;
    if (requireVisibleLayers && window.layerVisibility && !layerVisibility[layer]) continue;
    const dx = c.end.x - c.start.x;
    const dy = c.end.y - c.start.y;
    const L = Math.hypot(dx, dy);
    if (!(L > minLenPx)) continue;
    const aWorld = Math.atan2(dy, dx);         // in image/world coords
    const frameResidual = residualToNearest90(aWorld);
    samples.push({ idx: i, len: L, aWorld, frameResidual });
  }
  if (!samples.length) {
    console.warn("[straightenView] No eligible lines (too short / hidden layers?)");
    return null;
  }
  // --- bucket residuals so "slightly off" lines still count ---
  const tol = rad(tolDeg);
  const buckets = []; // {center, totalLen, members[], maxLen, maxMember}
  const add = (s) => {
    for (const b of buckets) {
      // residuals are within +/-45 so simple diff with wrapHalfPi is fine
      if (Math.abs(wrapHalfPi(s.frameResidual - b.center)) <= tol) {
        b.totalLen += s.len;
        b.members.push(s);
        if (s.len > b.maxLen) { b.maxLen = s.len; b.maxMember = s; }
        // keep center stable-ish (weighted avg in bounded range)
        const wOld = b.totalLen - s.len;
        b.center = (b.center * wOld + s.frameResidual * s.len) / (b.totalLen || 1e-9);
        b.center = residualToNearest90(b.center);
        return;
      }
    }
    buckets.push({
      center: s.frameResidual,
      totalLen: s.len,
      members: [s],
      maxLen: s.len,
      maxMember: s
    });
  };
  for (const s of samples) add(s);
  buckets.sort((a, b) => b.totalLen - a.totalLen);
  const dom = buckets[0];
  // "use the biggest line in that frame to define it"
  const anchor = dom.maxMember || dom.members[0];
  // On screen, angles become: aScreen = aWorld + viewRotation
  // We want anchor's residual-to-nearest-90 in SCREEN space to be 0.
  // residual(aWorld + viewRotation) = 0  => adjust viewRotation by -residual(currentScreenAngle)
  const currentViewRot = (typeof viewRotation !== 'undefined') ? viewRotation : 0;
  const anchorScreenAngle = anchor.aWorld + currentViewRot;
  const anchorResidualScreen = residualToNearest90(anchorScreenAngle);
  // apply delta (guaranteed <= 45° because it's a residual)
  const delta = -anchorResidualScreen;
  // update global viewRotation (this is the "rotate whole frame" behavior)
  viewRotation = wrapPi(currentViewRot + delta);
  // redraw
  if (typeof redrawCanvas === 'function') redrawCanvas();
  if (typeof renderGeometry2D === 'function') renderGeometry2D();
  if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
  const out = {
    appliedDeltaDeg: deg(delta),
    newViewRotationDeg: deg(viewRotation),
    dominantBucket: {
      totalLen: dom.totalLen,
      count: dom.members.length,
      anchorLineIdx: anchor.idx,
      anchorLen: anchor.len,
      anchorWorldAngleDeg: deg(anchor.aWorld),
      anchorResidualScreenDeg: deg(anchorResidualScreen)
    },
    buckets: buckets.map(b => ({
      totalLen: b.totalLen,
      centerDeg: deg(b.center),
      count: b.members.length,
      maxLen: b.maxLen
    }))
  };
  if (debug) {
    console.groupCollapsed(
      `%c[straightenView] Δ=${out.appliedDeltaDeg.toFixed(3)}°  viewRotation=${out.newViewRotationDeg.toFixed(3)}°`,
      "color:#1a73e8;font-weight:900;"
    );
    console.log("dominantBucket", out.dominantBucket);
    console.table(out.buckets);
    console.groupEnd();
  }
  return out;
};
// convenience alias
window.straightenView = () => window.straightenViewToDominant90Frame({ debug: true });
function handleSplatClick(clientX, clientY) {
    console.warn(
        "[Splat] Deprecated for this test. Use console pipeline:\n" +
        "  roofFacesReset(); roofFacesNext(); ... roofFacesNext(); (up to pass 5)\n" +
        "  roofFacesStatus(); roofFacesPrev(); roofFacesGoto(n)\n"
    );
}
window.addEventListener('storage', (e) => {
  if (e.key === 'geometryClipboard' && e.newValue) {
    try {
      geometryClipboard = normalizeGeometryClipboard(JSON.parse(e.newValue));
    } catch (err) {}
  }
});
