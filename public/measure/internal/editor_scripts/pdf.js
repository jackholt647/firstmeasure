/* pdf.js - Complete PDF Generation Logic & Helpers (DROP-IN REPLACEMENT)
   - Uses a single "Roof Diagram (Labels & Pitch)" page.
   - Supports editable label positions + leader lines via state.customLabels.
   - Cover page uses manualWastePct + manualTotalFacets.
   - Layer pages allow facet overrides and previews.
   - HYBRID: Uses improved Raycast Geometry + Original Text Label display.
   - STYLE: "X-Ray" View (Gray lines for hidden/all, Black lines for visible).
*/

window.PDF_DIAGRAM_FONT_SCALE = 1.0;
window.PDF_MEASUREMENT_FONT_SCALE = 1.0;

const PDF_FALLBACK_LINE_TYPES = {
  RIDGE:        { id: 'ridge',          color: '#FF0000', label: 'Ridge' },
  HIP:          { id: 'hip',            color: '#E67300', label: 'Hip' },
  VALLEY:       { id: 'valley',         color: '#800080', label: 'Valley' },
  RAKE:         { id: 'rake',           color: '#006400', label: 'Rake' },
  EAVE:         { id: 'eave',           color: '#FFD400', label: 'Eave' },
  HEAD_WALL:    { id: 'head_wall',      color: '#A0522D', label: 'Headwall Flashing' },
  SIDE_WALL:    { id: 'side_wall',      color: '#FF00FF', label: 'Sidewall Flashing' },
  TRANSITION:   { id: 'trans',          color: '#808080', label: 'Transition' },
  PARAPET:      { id: 'parapet',        color: '#5C2E0C', label: 'Parapet Wall' },
  PROTRUSION:   { id: 'protrusion',     color: '#589BA6', label: 'Protrusion' },
  CHIMNEY_BACK: { id: 'chimney_back',   color: '#00008B', label: 'Chimney Back Pan' },
  CHIMNEY_EDGE: { id: 'chimney_edge',   color: '#007bff', label: 'Chimney Step' },
  CHIMNEY_FRONT:{ id: 'chimney_front',  color: '#ADD8E6', label: 'Chimney Apron' },
  SKYLIGHT:     { id: 'skylight',       color: '#00FFFF', label: 'Skylight' },
  UNKNOWN:      { id: 'unknown',        color: '#000000', label: 'Unknown' }
};

const PDF_GUTTER_DIRECTIONS = ['north', 'south', 'east', 'west'];
const PDF_GUTTER_DIRECTION_LABELS = {
    north: 'North',
    south: 'South',
    east: 'East',
    west: 'West'
};
const PDF_GUTTER_MITER_COLORS = {
    outside90: '#2e7d32',
    inside90: '#d93025',
    non90: '#f9ab00',
    off: '#b8bfc7'
};
const PDF_GUTTER_HEIGHT_EPSILON = 0.05;
const PDF_GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT = 25;

function getPdfLineTypes() {
    if (typeof LINE_TYPES !== 'undefined' && LINE_TYPES) return LINE_TYPES;
    if (typeof window !== 'undefined' && window.LINE_TYPES) return window.LINE_TYPES;
    return PDF_FALLBACK_LINE_TYPES;
}

function getPdfVentilationViewId(imageSettings) {
    return imageSettings && imageSettings.mainViewId === 'apple' ? 'apple' : 'solar';
}

function shouldHidePdfLineMeasurementLabel(line) {
    return String(line?.type || '').toLowerCase() === 'protrusion';
}

function firstReportLogoValue(...sources) {
    const defaultLogoPath = '/images/logo_red.png';
    for (const source of sources) {
        const record = (source && typeof source === 'object') ? source : {};
        const nestedBranding = (record.branding && typeof record.branding === 'object') ? record.branding : null;
        const candidates = [
            record.logo,
            record.logo_node_url,
            record.logo_url,
            record.logoDataUrl,
            record.logo_data_url,
            nestedBranding && nestedBranding.logo,
            nestedBranding && nestedBranding.logo_node_url,
            nestedBranding && nestedBranding.logo_url,
            nestedBranding && nestedBranding.logoDataUrl,
            nestedBranding && nestedBranding.logo_data_url
        ];
        for (const candidate of candidates) {
            const logo = String(candidate || '').trim();
            if (logo && logo !== defaultLogoPath) return logo;
        }
    }
    return '';
}

// --- Image size debugger (keep until target size is hit, then remove) ---
function _logImageSize(label, dataUrl) {
    if (!dataUrl) return;
    const b64 = dataUrl.split(',')[1] || dataUrl;
    const kb = Math.round(b64.length * 3 / 4 / 1024);
    console.log(`[IMG] ${label}: ${kb} KB`);
}

function colorizePngBase64(base64, color) {
    return new Promise((resolve, reject) => {
        const raw = String(base64 || '').trim();
        if (!raw) {
            resolve('');
            return;
        }
        const img = new Image();
        img.onload = () => {
            try {
                const cvs = document.createElement('canvas');
                cvs.width = Math.max(1, img.naturalWidth || img.width || 1);
                cvs.height = Math.max(1, img.naturalHeight || img.height || 1);
                const ctx = cvs.getContext('2d');
                ctx.clearRect(0, 0, cvs.width, cvs.height);
                ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
                ctx.globalCompositeOperation = 'source-in';
                ctx.fillStyle = `rgb(${color.r || 0}, ${color.g || 0}, ${color.b || 0})`;
                ctx.fillRect(0, 0, cvs.width, cvs.height);
                resolve(cvs.toDataURL('image/png').split(',')[1] || raw);
            } catch (error) {
                reject(error);
            }
        };
        img.onerror = () => reject(new Error('Could not colorize logo image.'));
        img.src = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    });
}


// =============================================================================
// 2. REPLACE the _downscaleCanvasToJpeg function with this version
//    (adds logging + safety clamp for retina displays)
// =============================================================================

function _downscaleCanvasToJpeg(sourceCanvas, targetWidth, quality) {
    if (!sourceCanvas || !sourceCanvas.width) return null;

    // SAFETY: Clamp absurdly large canvases (retina displays can be 4000px+)
    const MAX_ALLOWED = Math.max(targetWidth, 1200);
    const effectiveTarget = Math.min(targetWidth, MAX_ALLOWED);

    const aspect = sourceCanvas.height / sourceCanvas.width;
    if (sourceCanvas.width <= effectiveTarget) {
        const result = sourceCanvas.toDataURL('image/jpeg', quality);
        return result;
    }
    const tmp = document.createElement('canvas');
    tmp.width = effectiveTarget;
    tmp.height = Math.round(effectiveTarget * aspect);
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, tmp.width, tmp.height);
    return tmp.toDataURL('image/jpeg', quality);
}





// ==========================================
// --- 1. CORE HANDLERS & STATE CAPTURE ---
// ==========================================


function inferPdfMetersPerPxFromReport(state) {
  const lines = state && state.report && Array.isArray(state.report.lines)
    ? state.report.lines
    : [];
  const candidates = [];

  lines.forEach((line) => {
    const p1 = line?.conn?.start || line?.points?.[0];
    const p2 = line?.conn?.end || line?.points?.[1];
    const lengthFt = Number(line?.length_ft ?? line?.lengthFt ?? line?.feet ?? line?.ft ?? line?.length);
    if (!p1 || !p2 || !Number.isFinite(lengthFt) || lengthFt <= 0) return;

    const dxPx = Number(p2.x) - Number(p1.x);
    const dyPx = Number(p2.y) - Number(p1.y);
    const lengthPx = Math.hypot(dxPx, dyPx);
    if (!Number.isFinite(lengthPx) || lengthPx <= 1e-6) return;

    const z1 = Number.isFinite(Number(p1.z)) ? Number(p1.z) : 0;
    const z2 = Number.isFinite(Number(p2.z)) ? Number(p2.z) : 0;
    const lengthMeters = lengthFt / 3.28084;
    const horizontalMetersSq = (lengthMeters * lengthMeters) - ((z2 - z1) * (z2 - z1));
    if (!(horizontalMetersSq > 0)) return;

    const inferred = Math.sqrt(horizontalMetersSq) / lengthPx;
    if (Number.isFinite(inferred) && inferred > 0 && inferred < 10) candidates.push(inferred);
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  const middle = Math.floor(candidates.length / 2);
  return candidates.length % 2
    ? candidates[middle]
    : (candidates[middle - 1] + candidates[middle]) / 2;
}

function getPdfMetersPerPx(state) {
  const explicit = Number(state && state.imageMetersPerPx);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  // Snapshot v1 omitted imageMetersPerPx. Recover it from the line lengths and
  // their captured pixel coordinates before falling back to project radius.
  const inferred = inferPdfMetersPerPxFromReport(state);
  if (Number.isFinite(inferred) && inferred > 0) return inferred;

  const w = (state && state.dims && state.dims.w) ? state.dims.w : 0;
  if (!w) return (20 * 2) / 1000;

  // Prefer the captured snapshot/project radius over ambient editor globals.
  // The shared PDF runtime loads editor.php as a bootstrap page, and those
  // globals can belong to a different/default radius than the snapshot being
  // rendered. Using the saved state radius keeps PDF math deterministic.
  let rad = null;

  // 1) From captured state / snapshot
  if (rad == null && state && state.radiusMeters) {
    const r3 = Number(state.radiusMeters);
    if (Number.isFinite(r3) && r3 > 0) rad = r3;
  }

  // 2) Persisted in layer_config.__radius.scale
  try {
    const lr = (typeof LAYER_CONFIG !== 'undefined' && LAYER_CONFIG && LAYER_CONFIG.__radius)
      ? Number(LAYER_CONFIG.__radius.scale)
      : NaN;
    if (rad == null && Number.isFinite(lr) && lr > 0) rad = lr;
  } catch (e) {}

  // 3) From runtime global
  if (rad == null) {
    const r2 = Number(window.RADIUS_METERS);
    if (Number.isFinite(r2) && r2 > 0) rad = r2;
  }

  // 4) Fallback
  if (rad == null) rad = 20;

  return (rad * 2) / w;
}


// --- NEW HELPERS: Prefer planeNormal for pitch ---
// planeNormal is in mixed units: x,y in px, z in meters.
// Plane equation: nx(x-x0)+ny(y-y0)+nz(z-z0)=0  => z = -(nx/nz)x -(ny/nz)y + ...
// So: a = -(nx/nz), b = -(ny/nz)  (meters per pixel)
// realSlope (rise/run) = sqrt(a^2+b^2) * (1/metersPerPx)
function pitchRiseFromPlaneNormal(normal, metersPerPx) {
  if (!normal) return null;

  const nx = Number(normal.x), ny = Number(normal.y), nz = Number(normal.z);
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return null;
  if (Math.abs(nz) < 1e-9) return null;

  const a = -nx / nz;
  const b = -ny / nz;

  const rawSlope = Math.sqrt(a * a + b * b);          // meters per pixel
  const realSlope = rawSlope * (1 / metersPerPx);     // meters per meter (unitless)

  if (!Number.isFinite(realSlope)) return null;

  // rise per 12" run (1 ft run) == (rise/run)*12
  return realSlope * 12;
}

function getFacePitchRise12(face, metersPerPx) {
  // 1) BEST: face.planeNormal from plane-sweep
  const r1 = pitchRiseFromPlaneNormal(face?.planeNormal, metersPerPx);
  if (r1 != null) return r1;

  // 2) Also accept face.plane.normal if you ever store it that way
  const r2 = pitchRiseFromPlaneNormal(face?.plane?.normal, metersPerPx);
  if (r2 != null) return r2;

  // 3) Fallback: fit from points (requires meaningful z's)
  try {
    const plane = localFitPlane(face.points);
    const rawSlope = Math.sqrt(plane.a * plane.a + plane.b * plane.b);
    const realSlope = rawSlope * (1 / metersPerPx);
    return realSlope * 12;
  } catch (e) {
    return 0;
  }
}

// --- Helper: Downscale any canvas to a target width, return JPEG dataURL ---
function _downscaleCanvasToJpeg(sourceCanvas, targetWidth, quality) {
    if (!sourceCanvas || !sourceCanvas.width) return null;
    const aspect = sourceCanvas.height / sourceCanvas.width;
    // Skip downscale if source is already smaller
    if (sourceCanvas.width <= targetWidth) {
        return sourceCanvas.toDataURL('image/jpeg', quality);
    }
    const tmp = document.createElement('canvas');
    tmp.width = targetWidth;
    tmp.height = Math.round(targetWidth * aspect);
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, tmp.width, tmp.height);
    return tmp.toDataURL('image/jpeg', quality);
}

function getReportCanvasNonWhiteBounds(sourceCanvas) {
    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) return null;
    const w = Math.max(1, Number(sourceCanvas.width) || 1);
    const h = Math.max(1, Number(sourceCanvas.height) || 1);
    const ctx = sourceCanvas.getContext ? sourceCanvas.getContext('2d', { willReadFrequently: true }) : null;
    if (!ctx) return null;

    const step = Math.max(1, Math.floor(Math.max(w, h) / 420));
    let minX = w, minY = h, maxX = -1, maxY = -1;

    try {
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const idx = ((y * w) + x) * 4;
                const a = data[idx + 3];
                if (a < 8) continue;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                if (r > 248 && g > 248 && b > 248) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    } catch (e) {
        return null;
    }

    if (maxX < minX || maxY < minY) return null;

    const pad = step * 2;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w, maxX + pad);
    maxY = Math.min(h, maxY + pad);

    const width = maxX - minX;
    const height = maxY - minY;
    if (width < w * 0.15 || height < h * 0.15) return null;
    if (width >= w * 0.98 && height >= h * 0.98) return null;

    return { minX, minY, maxX, maxY, width, height };
}
window.getReportCanvasNonWhiteBounds = getReportCanvasNonWhiteBounds;

function calculateReportTopViewCrop(baseCrop, sourceWidth, sourceHeight, options = {}) {
    const imageW = Math.max(1, Number(sourceWidth) || 1);
    const imageH = Math.max(1, Number(sourceHeight) || 1);
    const crop = baseCrop || { minX: 0, minY: 0, width: imageW, height: imageH };
    const modelFillRatio = Math.max(0.1, Math.min(1, Number(options.modelFillRatio) || 0.5));
    const zoom = Math.max(0.25, Math.min(4, Number(options.zoom) || 1));
    const maxModelDim = Math.max(1, Number(crop.width) || 1, Number(crop.height) || 1);
    const desiredSquareSize = (maxModelDim / modelFillRatio) / zoom;
    const contentBounds = options.avoidWhiteEdges
        ? (options.contentBounds || getReportCanvasNonWhiteBounds(options.sourceCanvas))
        : null;
    const validBounds = contentBounds && Number.isFinite(contentBounds.width) && Number.isFinite(contentBounds.height)
        ? {
            minX: Math.max(0, Math.min(imageW - 1, Number(contentBounds.minX) || 0)),
            minY: Math.max(0, Math.min(imageH - 1, Number(contentBounds.minY) || 0)),
            maxX: Math.max(1, Math.min(imageW, Number(contentBounds.maxX) || imageW)),
            maxY: Math.max(1, Math.min(imageH, Number(contentBounds.maxY) || imageH))
        }
        : { minX: 0, minY: 0, maxX: imageW, maxY: imageH };
    validBounds.width = Math.max(1, validBounds.maxX - validBounds.minX);
    validBounds.height = Math.max(1, validBounds.maxY - validBounds.minY);

    const maxSquareSize = Math.max(1, Math.min(validBounds.width, validBounds.height));
    const squareSize = Math.round(Math.max(1, Math.min(desiredSquareSize, maxSquareSize)));
    const cx = (Number(crop.minX) || 0) + ((Number(crop.width) || 0) / 2);
    const cy = (Number(crop.minY) || 0) + ((Number(crop.height) || 0) / 2);
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    return {
        minX: clamp(cx - (squareSize / 2), validBounds.minX, Math.max(validBounds.minX, validBounds.maxX - squareSize)),
        minY: clamp(cy - (squareSize / 2), validBounds.minY, Math.max(validBounds.minY, validBounds.maxY - squareSize)),
        width: squareSize,
        height: squareSize,
        modelFillRatio,
        zoom,
        desiredSquareSize,
        cappedBySource: squareSize < desiredSquareSize - 0.5,
        contentBoundsApplied: !!contentBounds
    };
}
window.calculateReportTopViewCrop = calculateReportTopViewCrop;

// --- Helper: Downscale a dataURL image string ---
function _downscaleDataUrlToJpeg(dataUrl, targetWidth, quality) {
    return new Promise((resolve) => {
        if (!dataUrl) { resolve(null); return; }
        const img = new Image();
        img.onload = () => {
            const aspect = img.height / img.width;
            // Skip if already small enough
            if (img.width <= targetWidth) {
                const c = document.createElement('canvas');
                c.width = img.width;
                c.height = img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                resolve(c.toDataURL('image/jpeg', quality));
                return;
            }
            const c = document.createElement('canvas');
            c.width = targetWidth;
            c.height = Math.round(targetWidth * aspect);
            const ctx = c.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(dataUrl); // fallback to original on error
        img.src = dataUrl;
    });
}

const PDF_SNAPSHOT_VERSION = 2;

function pdfMeasurementNumbersMatch(a, b) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

function isMeasurementReportFreshForPdf() {
    const reportLines = (lastRoofReport && Array.isArray(lastRoofReport.lines)) ? lastRoofReport.lines : [];
    const resolvedFaces = Array.isArray(window.lastResolvedFacesCache) ? window.lastResolvedFacesCache : [];
    const currentMetersPerPx = (typeof window.getMetersPerPx === 'function')
        ? Number(window.getMetersPerPx())
        : NaN;

    return Array.isArray(activeGeometry.points) &&
        reportLines.length > 0 &&
        resolvedFaces.length > 0 &&
        window.__lastRoofReportGeoStamp === (window.__geoMutStamp || 0) &&
        window.__lastRoofReportPointCount === activeGeometry.points.length &&
        window.__lastRoofReportConnectionCount === activeGeometry.connections.length &&
        window.__lastRoofReportFaceCount === resolvedFaces.length &&
        Number(window.__lastRoofReportImageWidth) === Number(imageWidth) &&
        Number(window.__lastRoofReportImageHeight) === Number(imageHeight) &&
        pdfMeasurementNumbersMatch(window.__lastRoofReportMetersPerPx, currentMetersPerPx);
}

function rebuildMeasurementReportForPdf() {
    try {
        let rebuiltFaces = null;
        if (window.altFaceResolver && typeof window.altFaceResolver.rebuildForMeasurement === 'function') {
            rebuiltFaces = window.altFaceResolver.rebuildForMeasurement();
        } else {
            if (typeof window.invalidateFaceCache === 'function') window.invalidateFaceCache();
            if (typeof window.renderFinalPass === 'function') window.renderFinalPass(false);
            rebuiltFaces = window.lastResolvedFacesCache;
        }

        if (!Array.isArray(rebuiltFaces) || rebuiltFaces.length === 0) {
            console.error('[PDF] Unable to rebuild resolved faces for the current image context.');
            return false;
        }
        if (typeof recalculateMeasurementData !== 'function') {
            console.error('[PDF] recalculateMeasurementData is unavailable.');
            return false;
        }

        lastRoofReport = null;
        recalculateMeasurementData();
        return isMeasurementReportFreshForPdf();
    } catch (err) {
        console.error('[PDF] Failed to rebuild a fresh measurement snapshot.', err);
        return false;
    }
}

function ensureFreshMeasurementReportForPdf() {
    if (typeof window.withAllStructuresEnabled === 'function' && !window.__structureModeForceAll) {
        return window.withAllStructuresEnabled(() => ensureFreshMeasurementReportForPdf());
    }
    if (!activeGeometry || !activeGeometry.connections || activeGeometry.connections.length === 0) {
        return false;
    }

    if (isMeasurementReportFreshForPdf()) return true;

    console.warn('[PDF] Measurement data is stale or belongs to a different image context; rebuilding before capture.');
    return rebuildMeasurementReportForPdf();
}
window.ensureFreshMeasurementReportForPdf = ensureFreshMeasurementReportForPdf;

function getLocalFaceSignatureReportInternal(points) {
    const safePoints = Array.isArray(points) ? points : [];
    const coords = safePoints.map(p => ({
        x: Math.round((Number(p?.x) || 0) * 10),
        y: Math.round((Number(p?.y) || 0) * 10)
    }));
    coords.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    return coords.map(p => `${p.x},${p.y}`).join('|');
}

if (typeof window.getLocalFaceSignatureReport !== 'function') {
    window.getLocalFaceSignatureReport = getLocalFaceSignatureReportInternal;
}

function cloneJsonSafe(value, fallback = null) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

function getReportExcludedSignatureArray(sourceState = null) {
    const raw = [];

    if (sourceState && Array.isArray(sourceState.excludedSignatures)) {
        raw.push(...sourceState.excludedSignatures);
    }

    if (typeof window !== 'undefined' && window.reportExcludedSignatures instanceof Set) {
        raw.push(...Array.from(window.reportExcludedSignatures));
    }

    return Array.from(new Set(raw.filter(sig => typeof sig === 'string' && sig.trim() !== ''))).sort();
}

function getReportExcludedSignatureSet(sourceState = null) {
    return new Set(getReportExcludedSignatureArray(sourceState));
}

function syncReportExcludedSignatures(sourceState = null) {
    const list = getReportExcludedSignatureArray(sourceState);
    if (sourceState && typeof sourceState === 'object') {
        sourceState.excludedSignatures = list.slice();
    }
    if (typeof window !== 'undefined') {
        window.reportExcludedSignatures = new Set(list);
    }
    return list;
}

function getReportAutoExcludedFaceIndexArray(sourceState = null) {
    const raw = Array.isArray(sourceState && sourceState.autoExcludedFacetIndexes)
        ? sourceState.autoExcludedFacetIndexes
        : [];
    return Array.from(new Set(raw
        .map((idx) => Number(idx))
        .filter((idx) => Number.isInteger(idx) && idx >= 0)
    )).sort((a, b) => a - b);
}

function getReportAutoExcludedFaceIndexSet(sourceState = null) {
    return new Set(getReportAutoExcludedFaceIndexArray(sourceState));
}

window.getReportAutoExcludedFaceIndexArray = getReportAutoExcludedFaceIndexArray;
window.getReportAutoExcludedFaceIndexSet = getReportAutoExcludedFaceIndexSet;

function sumReportSquaresByPitch(materials) {
    const squares = materials && typeof materials === 'object' ? materials.squares : null;
    if (!squares || typeof squares !== 'object') return null;

    let total = 0;
    let hasNumericValue = false;
    Object.keys(squares).forEach((key) => {
        const value = Number(squares[key]);
        if (!Number.isFinite(value)) return;
        total += value;
        hasNumericValue = true;
    });

    return hasNumericValue ? total : null;
}

function normalizeReportMaterialTotals(report, reason = '') {
    if (!report || typeof report !== 'object') return report;
    if (!report.materials || typeof report.materials !== 'object') {
        report.materials = {};
    }

    const summedSquares = sumReportSquaresByPitch(report.materials);
    if (summedSquares == null) return report;

    const previousTotal = Number(report.materials.totalSquares);
    const totalsDiffer = Number.isFinite(previousTotal)
        ? Math.abs(previousTotal - summedSquares) > 0.01
        : true;

    if (totalsDiffer) {
        if (Number.isFinite(previousTotal) && typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[PDF] Normalized stale totalSquares from pitch breakdown.', {
                reason,
                previousTotalSquares: previousTotal,
                normalizedTotalSquares: summedSquares
            });
        }
        report.materials.totalSquares = summedSquares;
    }

    return report;
}

const FIRSTMEASURE_PDF_DEBUG = false;

function roundPdfDebugValue(value, digits = 4) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const factor = Math.pow(10, digits);
    return Math.round(num * factor) / factor;
}

function buildPdfPitchDebugBreakdown(squaresData) {
    const rows = [];
    const source = (squaresData && typeof squaresData === 'object') ? squaresData : {};
    Object.keys(source)
        .sort((a, b) => parseFloat(a) - parseFloat(b))
        .forEach((pitch) => {
            const squares = Number(source[pitch]);
            if (!Number.isFinite(squares)) return;
            rows.push({
                pitch,
                squares: roundPdfDebugValue(squares),
                sq_ft: roundPdfDebugValue(squares * 100, 2)
            });
        });
    return rows;
}

function getPdfLabelRise12(label) {
    if (!label || typeof label !== 'object') return null;

    // The rendered pitch diagram uses pitchText/text. Treat those as the
    // authoritative override, because pitchExact is the original detected pitch.
    const candidates = [label.pitchText, label.text, label.pitchExactText];
    for (let i = 0; i < candidates.length; i++) {
        const candidate = String(candidates[i] || '').replace(/\/12$/, '').trim();
        if (!candidate) continue;
        const parsed = parseFloat(candidate);
        if (Number.isFinite(parsed)) return parsed;
    }

    const exactNumeric = Number(label.pitchExact);
    if (Number.isFinite(exactNumeric)) return exactNumeric;

    return null;
}

function collectPdfFaceDebugRows(state, reportOverride = null) {
    const safeState = state && typeof state === 'object' ? state : {};
    const report = (reportOverride && typeof reportOverride === 'object')
        ? reportOverride
        : (safeState.report && typeof safeState.report === 'object' ? safeState.report : { lines: [] });
    const labelMap = new Map();
    if (Array.isArray(safeState.customLabels)) {
        safeState.customLabels.forEach((label) => {
            if (label && label.faceSignature) labelMap.set(label.faceSignature, label);
        });
    }

    const excluded = getReportExcludedSignatureSet(safeState);
    const autoExcluded = getReportAutoExcludedFaceIndexSet(safeState);
    const metersPerPx = getPdfMetersPerPx(safeState);
    const rows = [];

    (safeState.facesData || []).forEach((face, index) => {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
        if (isObstacleFace(face, report)) return;
        if (autoExcluded.has(index)) return;

        const signature = (typeof getLocalFaceSignatureReport === 'function')
            ? getLocalFaceSignatureReport(face.points)
            : window.getLocalFaceSignatureReport(face.points);
        if (excluded.has(signature)) return;

        const label = labelMap.get(signature) || null;
        const areaPx = Math.abs(getSignedArea(face.points));
        const areaM2 = areaPx * (metersPerPx * metersPerPx);
        const footprintSqFt = areaM2 * 10.7639;

        let rise12 = 0;
        let pitchSource = 'geometry';
        const labelPitch = getPdfLabelRise12(label);
        if (Number.isFinite(labelPitch)) {
            rise12 = labelPitch;
            pitchSource = 'label';
        } else {
            const derivedPitch = getFacePitchRise12(face, metersPerPx);
            rise12 = Number.isFinite(derivedPitch) ? Math.abs(derivedPitch) : 0;
        }

        const pitchDeg = Math.atan((rise12 || 0) / 12) * (180 / Math.PI);
        const areaSqFt = (areaM2 / Math.cos(pitchDeg * (Math.PI / 180))) * 10.7639;

        rows.push({
            face_index: index,
            signature,
            layer: face.layer || 1,
            pitch_label: `${Math.round(rise12)}/12`,
            pitch_exact: roundPdfDebugValue(rise12),
            pitch_source: pitchSource,
            sq_ft: roundPdfDebugValue(areaSqFt, 2),
            squares: roundPdfDebugValue(areaSqFt / 100),
            footprint_sq_ft: roundPdfDebugValue(footprintSqFt, 2),
            label_sq_ft: Number.isFinite(Number(label?.areaText)) ? roundPdfDebugValue(Number(label.areaText), 2) : null,
            raw_face_area: roundPdfDebugValue(face.area, 2)
        });
    });

    return rows;
}

function buildPdfDebugSummary(state, reportOverride = null, options = {}) {
    const safeState = state && typeof state === 'object' ? state : {};
    const report = (reportOverride && typeof reportOverride === 'object')
        ? reportOverride
        : (safeState.report && typeof safeState.report === 'object' ? safeState.report : {});
    const materials = (report.materials && typeof report.materials === 'object') ? report.materials : {};
    const faceRows = collectPdfFaceDebugRows(safeState, report);
    const facePitchSquares = {};

    let totalFaceSqFt = 0;
    let totalLabelSqFt = 0;
    let totalRawFaceArea = 0;
    faceRows.forEach((row) => {
        totalFaceSqFt += Number(row.sq_ft) || 0;
        totalLabelSqFt += Number(row.label_sq_ft) || 0;
        totalRawFaceArea += Number(row.raw_face_area) || 0;
        if (!facePitchSquares[row.pitch_label]) facePitchSquares[row.pitch_label] = 0;
        facePitchSquares[row.pitch_label] += (Number(row.sq_ft) || 0) / 100;
    });

    const summary = {
        folderId: safeState.folderId || null,
        address: safeState.address || null,
        radiusMeters: roundPdfDebugValue(safeState.radiusMeters, 4),
        dims: safeState.dims || null,
        metersPerPx: roundPdfDebugValue(getPdfMetersPerPx(safeState), 6),
        manualWastePct: Number.isFinite(Number(safeState.manualWastePct)) ? Number(safeState.manualWastePct) : null,
        manualTotalFacets: Number.isFinite(Number(safeState.manualTotalFacets)) ? Number(safeState.manualTotalFacets) : null,
        report_total_squares: roundPdfDebugValue(materials.totalSquares),
        report_total_sq_ft: roundPdfDebugValue((Number(materials.totalSquares) || 0) * 100, 2),
        report_footprint_sq_ft: roundPdfDebugValue(materials.totalFootprintSqFt, 2),
        report_attic_area_sq_ft: roundPdfDebugValue(materials.atticAreaSqFt, 2),
        report_pitch_breakdown: buildPdfPitchDebugBreakdown(materials.squares || {}),
        face_total_sq_ft: roundPdfDebugValue(totalFaceSqFt, 2),
        face_total_squares: roundPdfDebugValue(totalFaceSqFt / 100),
        face_pitch_breakdown: buildPdfPitchDebugBreakdown(facePitchSquares),
        label_total_sq_ft: roundPdfDebugValue(totalLabelSqFt, 2),
        raw_face_area_total: roundPdfDebugValue(totalRawFaceArea, 2),
        active_faces: faceRows.length
    };

    if (options.includeFaces) {
        summary.faces = faceRows;
    }

    return summary;
}

function emitPdfDebug(stage, payload = {}) {
    if (!FIRSTMEASURE_PDF_DEBUG || typeof console === 'undefined' || typeof console.info !== 'function') {
        return null;
    }

    const entry = {
        ts: new Date().toISOString(),
        stage,
        ...payload
    };

    if (typeof window !== 'undefined') {
        if (!Array.isArray(window.__pdfDebugHistory)) window.__pdfDebugHistory = [];
        window.__pdfDebugHistory.push(entry);
    }

    try {
        console.info(`[PDF DEBUG] ${JSON.stringify(entry)}`);
    } catch (e) {
        console.info(`[PDF DEBUG] ${stage}`);
    }

    return entry;
}

function serializePdfConfigForSave(sourceState) {
    if (!sourceState || typeof sourceState !== 'object') return null;

    const config = {
        customLabels: cloneJsonSafe(sourceState.customLabels, []),
        manualWastePct: (typeof sourceState.manualWastePct === 'number') ? sourceState.manualWastePct : undefined,
        manualTotalFacets: (typeof sourceState.manualTotalFacets === 'number') ? sourceState.manualTotalFacets : undefined,
        manualLayerFacets: cloneJsonSafe(sourceState.manualLayerFacets, {}),
        gutterSettings: cloneJsonSafe(sourceState.gutterSettings, null),
        ventSettings: cloneJsonSafe(sourceState.ventSettings, null),
        structureSettings: cloneJsonSafe(sourceState.structureSettings, null),
        elevationSettings: cloneJsonSafe(sourceState.elevationSettings, null),
        brandingOverrides: cloneJsonSafe(sourceState.brandingOverrides, null),
        imageSettings: cloneJsonSafe(sourceState.imageSettings, null),
        diagramFontScale: (typeof sourceState.diagramFontScale === 'number') ? sourceState.diagramFontScale : undefined,
        measurementFontScale: (typeof sourceState.measurementFontScale === 'number') ? sourceState.measurementFontScale : undefined,
        editorCropPadding: (typeof sourceState.editorCropPadding === 'number') ? sourceState.editorCropPadding : undefined,
        labelAutomation: cloneJsonSafe(sourceState.labelAutomation, null),
        excludedSignatures: getReportExcludedSignatureArray(sourceState),
        autoExcludedFacetIndexes: getReportAutoExcludedFaceIndexArray(sourceState),
        facetOverlapWarnings: cloneJsonSafe(sourceState.facetOverlapWarnings, [])
    };

    Object.keys(config).forEach(key => {
        if (config[key] === undefined || config[key] === null) delete config[key];
    });

    return config;
}
window.serializePdfConfigForSave = serializePdfConfigForSave;

function firstMeasurePdfQuadViewsDisabled() {
    if (typeof window.areReportQuadViewsDisabled === 'function') {
        return window.areReportQuadViewsDisabled();
    }
    if (typeof window.firstMeasureAreQuadViewsDisabled === 'function') {
        return window.firstMeasureAreQuadViewsDisabled();
    }
    const globalSettings = window.FIRSTMEASURE_REPORT_SETTINGS || window.PORTAL_CFG?.report_settings || {};
    if (
        globalSettings.disable_quad_views ||
        globalSettings.disableQuadViews ||
        globalSettings.no_quad_views ||
        globalSettings.noQuadViews
    ) {
        return true;
    }
    const general = window.projectOrganization?.report_settings?.general || {};
    return !!(
        general.disable_quad_views ||
        general.disableQuadViews ||
        general.no_quad_views ||
        general.noQuadViews
    );
}
window.firstMeasurePdfQuadViewsDisabled = firstMeasurePdfQuadViewsDisabled;

function getUniqueSortedWasteOptions(values) {
    return Array.from(new Set(values.map(v => Math.max(0, Math.round(Number(v) || 0))))).sort((a, b) => a - b);
}

function calculateReportHipLengthFt(report) {
    if (!report || typeof report !== 'object') return 0;

    const linear = report.materials && typeof report.materials === 'object' && report.materials.linear
        ? report.materials.linear
        : null;
    if (linear && Number(linear.hip) > 0) {
        return Number(linear.hip);
    }

    if (Array.isArray(report.lines)) {
        return report.lines.reduce((total, line) => {
            if (!line || typeof line !== 'object') return total;
            const type = String(line.type || line.label || line.name || '').toLowerCase();
            if (!type.includes('hip')) return total;
            const len = Number(line.length_ft ?? line.lengthFt ?? line.feet ?? line.ft ?? line.length);
            return total + (Number.isFinite(len) && len > 0 ? len : 0);
        }, 0);
    }

    return 0;
}

function calculateGafSuggestedWaste(facetCount, hipsFt = 0) {
    const facets = Math.max(0, Math.round(Number(facetCount) || 0));
    const hasHips = Number(hipsFt) > 0;
    const base = Math.floor((facets + 1) / 3) + 5;
    return Math.min(25, base + (hasHips ? 3 : 0));
}

function calculateSuggestedWasteFromFacetCount(facetCount, hipsFt = 0) {
    return calculateGafSuggestedWaste(facetCount, hipsFt);
}

function getGafSummaryWasteOptions(suggestedWaste) {
    const s = Math.max(0, Math.round(Number(suggestedWaste) || 0));
    return getUniqueSortedWasteOptions([0, s - 5, s - 2, s, s + 2, s + 5, s + 10]);
}

function getGafMaterialWasteOptions(suggestedWaste) {
    const s = Math.max(0, Math.round(Number(suggestedWaste) || 0));
    return getUniqueSortedWasteOptions([0, s - 5, s, s + 5]);
}

window.calculateReportHipLengthFt = calculateReportHipLengthFt;
window.calculateGafSuggestedWaste = calculateGafSuggestedWaste;
window.calculateSuggestedWasteFromFacetCount = calculateSuggestedWasteFromFacetCount;
window.getGafSummaryWasteOptions = getGafSummaryWasteOptions;
window.getGafMaterialWasteOptions = getGafMaterialWasteOptions;

function createStandalonePdfSnapshot(sourceState) {
    if (!sourceState || !sourceState.geometry || !sourceState.report) return null;

    const snapshotReport = cloneJsonSafe(sourceState.report, null);
    normalizeReportMaterialTotals(snapshotReport, 'createStandalonePdfSnapshot');
    const resolvedRadiusMeters = Number.isFinite(Number(sourceState.radiusMeters))
        ? Number(sourceState.radiusMeters)
        : (
            typeof window.getRadiusMeters === 'function'
                ? Number(window.getRadiusMeters())
                : (Number.isFinite(Number(window.RADIUS_METERS)) ? Number(window.RADIUS_METERS) : null)
        );
    const resolvedImageMetersPerPx = Number.isFinite(Number(sourceState.imageMetersPerPx)) && Number(sourceState.imageMetersPerPx) > 0
        ? Number(sourceState.imageMetersPerPx)
        : (
            typeof window.getMetersPerPx === 'function' && Number.isFinite(Number(window.getMetersPerPx()))
                ? Number(window.getMetersPerPx())
                : null
        );

    const snapshot = {
        snapshotVersion: PDF_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        pdfSyncRevision: sourceState.pdfSyncRevision || sourceState.pdf_sync_revision || null,
        pdfRenderDateLabel: sourceState.pdfRenderDateLabel || sourceState.pdf_render_date_label || new Date().toLocaleDateString('en-US'),
        folderId: sourceState.folderId || window.currentProjectId || null,
        address: sourceState.address || (document.getElementById('addressInput')?.value || 'Project'),
        center: cloneJsonSafe(sourceState.center, null),
        dims: cloneJsonSafe(sourceState.dims, null),
        radiusMeters: Number.isFinite(resolvedRadiusMeters) && resolvedRadiusMeters > 0
            ? resolvedRadiusMeters
            : (Number.isFinite(Number(window.currentProjectManifest?.radius_meters))
                ? Number(window.currentProjectManifest.radius_meters)
                : null),
        imageMetersPerPx: Number.isFinite(resolvedImageMetersPerPx) && resolvedImageMetersPerPx > 0
            ? resolvedImageMetersPerPx
            : null,
        geometry: cloneJsonSafe(sourceState.geometry, null),
        report: snapshotReport,
        facesData: cloneJsonSafe(sourceState.facesData, []),
        cropRegion: cloneJsonSafe(sourceState.cropRegion, null),
        displayCrop: cloneJsonSafe(sourceState.displayCrop, null),
        solarImg: sourceState.solarImg || null,
        ventImg: sourceState.ventImg || null,
        wireframes: cloneJsonSafe(sourceState.wireframes, []),
        quadImage: firstMeasurePdfQuadViewsDisabled() ? null : (sourceState.quadImage || null),
        structures: cloneJsonSafe(sourceState.structures, []),
        customLabels: cloneJsonSafe(sourceState.customLabels, []),
        manualTotalFacets: (typeof sourceState.manualTotalFacets === 'number') ? sourceState.manualTotalFacets : null,
        manualWastePct: (typeof sourceState.manualWastePct === 'number') ? sourceState.manualWastePct : null,
        manualLayerFacets: cloneJsonSafe(sourceState.manualLayerFacets, {}),
        gutterSettings: cloneJsonSafe(sourceState.gutterSettings, null),
        ventSettings: cloneJsonSafe(sourceState.ventSettings, null),
        structureSettings: cloneJsonSafe(sourceState.structureSettings, null),
        elevationSettings: firstMeasurePdfQuadViewsDisabled()
            ? { ...cloneJsonSafe(sourceState.elevationSettings, {}), include: false }
            : cloneJsonSafe(sourceState.elevationSettings, null),
        brandingOverrides: cloneJsonSafe(sourceState.brandingOverrides, null),
        imageSettings: cloneJsonSafe(sourceState.imageSettings, null),
        diagramFontScale: (typeof sourceState.diagramFontScale === 'number') ? sourceState.diagramFontScale : 1,
        measurementFontScale: (typeof sourceState.measurementFontScale === 'number') ? sourceState.measurementFontScale : 1,
        editorCropPadding: (typeof sourceState.editorCropPadding === 'number') ? sourceState.editorCropPadding : 0,
        labelAutomation: cloneJsonSafe(sourceState.labelAutomation, null),
        excludedSignatures: getReportExcludedSignatureArray(sourceState),
        autoExcludedFacetIndexes: getReportAutoExcludedFaceIndexArray(sourceState),
        facetOverlapWarnings: cloneJsonSafe(sourceState.facetOverlapWarnings, []),
        finalizeChecklist: cloneJsonSafe(sourceState.finalizeChecklist, {}),
        finalizeSources: cloneJsonSafe(sourceState.finalizeSources, null),
        finalizeSourcesConfirmed: !!sourceState.finalizeSourcesConfirmed
    };

    if (sourceState.report && sourceState.report.resident) {
        snapshot.report.resident = cloneJsonSafe(sourceState.report.resident, { name: '', email: '', phone: '' });
    }

    return snapshot;
}
window.createStandalonePdfSnapshot = createStandalonePdfSnapshot;

async function saveStandalonePdfState(sourceState = null, options = {}) {
    const {
        refreshImages = true,
        skipCaptureIfMissing = false,
        captureWireframes = false
    } = options || {};

    let state = sourceState;
    let usedLiveState = !!sourceState;
    if (!state) {
        if (window.reportConfigState) {
            state = window.reportConfigState;
            usedLiveState = true;
        } else {
            const canCapture = (typeof activeGeometry !== 'undefined' && activeGeometry) &&
                (typeof lastRoofReport !== 'undefined' && lastRoofReport);
            if (!canCapture && skipCaptureIfMissing) return false;
            state = await captureStateForPDF({ captureWireframes });
        }
    }

    if (!state) return false;

    if (refreshImages && usedLiveState && typeof window.updateStateImages === 'function') {
        await window.updateStateImages(state, { captureWireframes });
    }

    if (typeof window.syncReportDiagramLabels === 'function') {
        window.syncReportDiagramLabels(state);
    }
    syncReportExcludedSignatures(state);
    const snapshot = createStandalonePdfSnapshot(state);
    if (!snapshot) return false;

    const formData = new FormData();
    formData.append(
        'pdf_state',
        new Blob([JSON.stringify(snapshot)], { type: 'application/json' }),
        'pdf_state.json'
    );

    const resp = await fetch(
        window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(snapshot.folderId)}/editor/save`),
        { method: 'POST', body: formData }
    );
    const result = await resp.json().catch(() => ({ success: resp.ok }));
    if (!resp.ok || result.success === false) {
        throw new Error(result.error || 'Failed to save PDF snapshot.');
    }

    window.lastSavedStandalonePdfSnapshot = snapshot;
    return true;
}
window.saveStandalonePdfState = saveStandalonePdfState;

const PDF_GEOMETRY_MAX_LINE_FT = 999;
const PDF_GEOMETRY_MAX_FACE_EDGE_FT = 999;
const PDF_GEOMETRY_MAX_FACE_AREA_SQFT = 99999;

function getPdfValidationMetersPerPx() {
    const radius = (
        window.getRadiusMeters
            ? window.getRadiusMeters()
            : (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))
    );
    const width = Number(imageWidth) || 1;
    return ((Number(radius) || 20) * 2) / width;
}

function getPdfValidationSignedArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
        const p1 = points[i] || {};
        const p2 = points[(i + 1) % points.length] || {};
        area += ((Number(p1.x) || 0) * (Number(p2.y) || 0)) - ((Number(p2.x) || 0) * (Number(p1.y) || 0));
    }
    return area / 2;
}

function getPdfValidationPointDistanceFt(a, b, metersPerPx) {
    if (!a || !b) return 0;
    const dx = ((Number(b.x) || 0) - (Number(a.x) || 0)) * metersPerPx;
    const dy = ((Number(b.y) || 0) - (Number(a.y) || 0)) * metersPerPx;
    const dz = (Number(a.z) || 0) - (Number(b.z) || 0);
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) * 3.28084;
}

function getPdfValidationFaceAreaSqFt(face, metersPerPx) {
    if (!face || !Array.isArray(face.points) || face.points.length < 3) return 0;
    let areaPx = Math.abs(getPdfValidationSignedArea(face.points));
    if (Array.isArray(face.holes)) {
        face.holes.forEach((hole) => {
            areaPx -= Math.abs(getPdfValidationSignedArea(hole));
        });
    }
    areaPx = Math.max(0, areaPx);
    const areaM2Flat = areaPx * metersPerPx * metersPerPx;
    let pitchDeg = 0;
    try {
        if (typeof fitPlaneLinearInternal === 'function') {
            const plane = fitPlaneLinearInternal(face.points);
            const rawSlope = Math.sqrt((plane.a * plane.a) + (plane.b * plane.b));
            pitchDeg = Math.atan(rawSlope * (1 / metersPerPx)) * (180 / Math.PI);
        }
    } catch (e) {
        pitchDeg = 0;
    }
    const cos = Math.cos(pitchDeg * (Math.PI / 180));
    if (!Number.isFinite(cos) || Math.abs(cos) < 0.001) return Infinity;
    return (areaM2Flat / cos) * 10.7639;
}

function findUnrealisticPdfGeometry(report, facesData) {
    const metersPerPx = getPdfValidationMetersPerPx();
    const issues = [];

    (Array.isArray(report && report.lines) ? report.lines : []).forEach((line, idx) => {
        const length = Number(line && line.length);
        if (!Number.isFinite(length) || length > PDF_GEOMETRY_MAX_LINE_FT) {
            issues.push({
                type: 'line',
                index: idx + 1,
                value: length,
                limit: PDF_GEOMETRY_MAX_LINE_FT
            });
        }
    });

    (Array.isArray(facesData) ? facesData : []).forEach((face, faceIdx) => {
        const rings = [face && face.points, ...(Array.isArray(face && face.holes) ? face.holes : [])]
            .filter((ring) => Array.isArray(ring) && ring.length >= 2);
        rings.forEach((ring) => {
            for (let i = 0; i < ring.length; i += 1) {
                const edgeFt = getPdfValidationPointDistanceFt(ring[i], ring[(i + 1) % ring.length], metersPerPx);
                if (!Number.isFinite(edgeFt) || edgeFt > PDF_GEOMETRY_MAX_FACE_EDGE_FT) {
                    issues.push({
                        type: 'face_edge',
                        index: faceIdx + 1,
                        value: edgeFt,
                        limit: PDF_GEOMETRY_MAX_FACE_EDGE_FT
                    });
                    return;
                }
            }
        });

        const areaSqFt = getPdfValidationFaceAreaSqFt(face, metersPerPx);
        if (!Number.isFinite(areaSqFt) || areaSqFt > PDF_GEOMETRY_MAX_FACE_AREA_SQFT) {
            issues.push({
                type: 'face_area',
                index: faceIdx + 1,
                value: areaSqFt,
                limit: PDF_GEOMETRY_MAX_FACE_AREA_SQFT
            });
        }
    });

    return issues;
}

function blockUnrealisticPdfGeometryIfNeeded(report, facesData) {
    const issues = findUnrealisticPdfGeometry(report, facesData);
    if (!issues.length) return false;
    console.warn('[PDF Geometry Guard] Unrealistic geometry detected:', issues);
    const invalidIssues = issues.filter((issue) => !Number.isFinite(Number(issue && issue.value)));
    if (invalidIssues.length) {
        alert(
            'One of the faces has an invalid value and should be corrected before submitting.\n\n' +
            'A line, face edge, or face area could not be calculated. This is usually caused by the extreme pitch/height bug.'
        );
        return true;
    }

    const issueSummary = issues
        .slice(0, 4)
        .map((issue) => {
            const value = Math.round(Number(issue.value)).toLocaleString();
            const limit = Math.round(Number(issue.limit)).toLocaleString();
            if (issue.type === 'line') return `Line ${issue.index}: ${value} ft (limit ${limit} ft)`;
            if (issue.type === 'face_edge') return `Face ${issue.index} edge: ${value} ft (limit ${limit} ft)`;
            if (issue.type === 'face_area') return `Face ${issue.index} area: ${value} sq ft (limit ${limit} sq ft)`;
            return `Issue ${issue.index || ''}: ${value} (limit ${limit})`;
        })
        .join('\n');
    const moreText = issues.length > 4 ? `\n...and ${issues.length - 4} more.` : '';
    const confirmed = confirm(
        'One of the faces has an unusually large value.\n\n' +
        `${issueSummary}${moreText}\n\n` +
        'Please confirm that these are accurate values and that your scale is correct.\n\n' +
        'Press OK to submit anyway, or Cancel to go back and correct the geometry.'
    );
    return !confirmed;
}


async function captureStateForPDF(options = {}) {
    const captureWireframesForState = options.captureWireframes === true;
    if (typeof window.withGlobalImageContextForProjectSave === 'function'
        && window.__structureLocalImageryActive
        && !window.__pdfCaptureGlobalImageContextActive) {
        window.__pdfCaptureGlobalImageContextActive = true;
        try {
            return await window.withGlobalImageContextForProjectSave(() => captureStateForPDF(options));
        } finally {
            window.__pdfCaptureGlobalImageContextActive = false;
        }
    }
    if (typeof window.withAllStructuresEnabled === 'function' && !window.__structureModeForceAll) {
        return window.withAllStructuresEnabled(() => captureStateForPDF(options));
    }
    console.log("Capturing PDF State (v4 Square Crop)...");
    const hasFreshReport = ensureFreshMeasurementReportForPdf();
    if (!activeGeometry || !hasFreshReport || !lastRoofReport) {
        alert("Please run 'Measurements' first to generate the data required for the report.");
        return null;
    }

    // --- Configuration / Defaults ---
    const currentConfig = (window.reportConfigState) ? window.reportConfigState : (window.loadedPdfConfig || {});
    const configuredExcluded = Array.isArray(currentConfig.excludedSignatures)
        ? currentConfig.excludedSignatures
        : [];
    window.reportExcludedSignatures = new Set(configuredExcluded);
    
    // Default Image Settings
    const imgSettings = currentConfig.imageSettings || {
        mainViewId: 'solar',
        ventViewId: 'solar',
        cropPadding: 50
    };

    let mainViewId = imgSettings.mainViewId;
    let ventViewId = getPdfVentilationViewId(imgSettings);
    imgSettings.ventViewId = ventViewId;

    // --- Image Size Budget ---
    const IMG_TARGET_WIDTH = 800;
    const IMG_JPEG_QUALITY = 0.55;
    const TOP_VIEW_JPEG_QUALITY = 0.85;
    const QUAD_TARGET_WIDTH = 900;
    const QUAD_JPEG_QUALITY = 0.85;

    const btn = document.getElementById('btnPdf');
    const originalText = btn ? btn.textContent : "PDF";
    if (btn) { btn.textContent = "Capturing..."; btn.disabled = true; }

    try {
        const dims = { w: imageWidth, h: imageHeight };
        const report = lastRoofReport ? JSON.parse(JSON.stringify(lastRoofReport)) : null;
        
        // --- 1. Calculate Base Region (Geometry Bounds) ---
        let baseCrop = getGlobalCropRegion(report ? report.lines : [], dims.w, dims.h);
        
        // --- 2. Capture Top View with an auto-fit square crop ---
        let solarImg = null; 
        let mainCvs = ensureViewCanvas(mainViewId);
        const shouldFallbackToSolar =
            mainViewId !== 'solar'
            && (
                !mainCvs
                || (
                    typeof window.isReportTopViewSourceUsable === 'function'
                    && !window.isReportTopViewSourceUsable({ cropRegion: baseCrop, imageSettings: imgSettings }, mainViewId, mainCvs)
                )
            );
        if (shouldFallbackToSolar) {
            mainViewId = 'solar';
            imgSettings.mainViewId = 'solar';
            ventViewId = getPdfVentilationViewId(imgSettings);
            imgSettings.ventViewId = ventViewId;
            mainCvs = ensureViewCanvas(mainViewId);
        }
        const expandedCrop = calculateReportTopViewCrop(
            baseCrop,
            mainCvs ? mainCvs.width : dims.w,
            mainCvs ? mainCvs.height : dims.h,
            {
                modelFillRatio: 0.5,
                zoom: imgSettings.cropZoom || 1,
                sourceCanvas: mainCvs,
                avoidWhiteEdges: !!imgSettings.topViewAutoSelection || !imgSettings.topViewManualOverride
            }
        );
        
        if (mainCvs) {
            const tempCvs = document.createElement('canvas');
            tempCvs.width = expandedCrop.width;
            tempCvs.height = expandedCrop.height;
            const tCtx = tempCvs.getContext('2d');
            
            tCtx.fillStyle = '#FFFFFF';
            tCtx.fillRect(0, 0, tempCvs.width, tempCvs.height);

            tCtx.drawImage(
                mainCvs, 
                expandedCrop.minX, expandedCrop.minY, expandedCrop.width, expandedCrop.height,
                0, 0, expandedCrop.width, expandedCrop.height
            );
            
            solarImg = _downscaleCanvasToJpeg(tempCvs, IMG_TARGET_WIDTH, TOP_VIEW_JPEG_QUALITY);
            _logImageSize(`Main View (${mainViewId})`, solarImg);
        }

        // --- 4. Capture Vent View (Full Area) ---
        let ventImg = null;
        const ventCvs = ensureViewCanvas(ventViewId);
        if (ventCvs) {
            ventImg = _downscaleCanvasToJpeg(ventCvs, IMG_TARGET_WIDTH, IMG_JPEG_QUALITY);
            _logImageSize(`Vent View (${ventViewId})`, ventImg);
        }

        // --- Standard Data Capture ---
        const geometry = activeGeometry ? JSON.parse(JSON.stringify(activeGeometry)) : null;
        
        if (report && window.currentProjectManifest && window.currentProjectManifest.resident) {
            report.resident = window.currentProjectManifest.resident;
        } else if (report) {
            report.resident = { name: '', email: '', phone: '' };
        }
        normalizeReportMaterialTotals(report, 'captureStateForPDF');

        const address = document.getElementById('addressInput').value || "Project";
        const center = { lat: mapCenterLat, lng: mapCenterLng };
        
        let wireframes = [];
        if (captureWireframesForState && typeof captureWireframeViews === 'function') wireframes = await captureWireframeViews();
        if (captureWireframesForState && (!Array.isArray(wireframes) || wireframes.length !== 4)) {
            console.warn('[PDF 3D] Wireframe capture did not return all four facet views.', wireframes);
        }

        let facesData = [];
        let rawSource = null;
        if (window.lastResolvedFacesCache && Array.isArray(window.lastResolvedFacesCache)) {
            rawSource = window.lastResolvedFacesCache;
        } else if (typeof facesGroup !== 'undefined' && facesGroup) {
            rawSource = facesGroup.children
                .filter(mesh => mesh.userData && mesh.userData.faceDef)
                .map(mesh => mesh.userData.faceDef);
        }
        if (rawSource) {
            const candidates = JSON.parse(JSON.stringify(rawSource));
            facesData = candidates.filter(f => {
                if (!f.points || f.points.length < 3) return false;
                let area = 0;
                for (let i = 0; i < f.points.length; i++) {
                    const p1 = f.points[i];
                    const p2 = f.points[(i + 1) % f.points.length];
                    area += (p1.x * p2.y - p2.x * p1.y);
                }
                return Math.abs(area * 0.5) > 2.0;
            });
        }

        let structures = [];
        if (typeof detectStructures === 'function') {
            structures = detectStructures(geometry.points, geometry.connections, facesData);
        }

        const facetCount = facesData.filter(f => !isObstacleFace(f, report)).length;
        const hipLengthFt = calculateReportHipLengthFt(report);

        let manualLayerFacets = currentConfig.manualLayerFacets || {};
        let customLabels = currentConfig.customLabels || null;
        let gutterSettings = currentConfig.gutterSettings || null;
        let ventSettings = currentConfig.ventSettings || { include: true, excludedRidges: [] };
        let structureSettings = currentConfig.structureSettings || {};
        let elevationSettings = currentConfig.elevationSettings || { include: true };
        if (firstMeasurePdfQuadViewsDisabled()) {
            elevationSettings = { ...elevationSettings, include: false };
        }
        let manualTotalFacets = (typeof currentConfig.manualTotalFacets === 'number') ? currentConfig.manualTotalFacets : facetCount;
        const suggestedWaste = calculateSuggestedWasteFromFacetCount(manualTotalFacets, hipLengthFt);
        let manualWastePct = (typeof currentConfig.manualWastePct === 'number') ? currentConfig.manualWastePct : suggestedWaste;
        let brandingOverrides = currentConfig.brandingOverrides || null;

        try {
            if (!customLabels && window.buildDefaultDiagramLabels) {
                customLabels = window.buildDefaultDiagramLabels({
                    report,
                    facesData,
                    cropRegion: baseCrop,
                    dims,
                    radiusMeters: (typeof window.getRadiusMeters === 'function' && Number.isFinite(Number(window.getRadiusMeters())))
                        ? Number(window.getRadiusMeters())
                        : (
                            Number.isFinite(Number(window.RADIUS_METERS))
                                ? Number(window.RADIUS_METERS)
                                : (Number.isFinite(Number(window.currentProjectManifest?.radius_meters))
                                    ? Number(window.currentProjectManifest.radius_meters)
                                    : null)
                        ),
                    autoExcludedFacetIndexes: currentConfig.autoExcludedFacetIndexes || []
                });
            }
        } catch (e) {}

        let quadImage = null;
        if (!firstMeasurePdfQuadViewsDisabled() && window.quadViewCroppedImage) {
            quadImage = await _downscaleDataUrlToJpeg(window.quadViewCroppedImage, QUAD_TARGET_WIDTH, QUAD_JPEG_QUALITY);
        }

        const includeGutterMeasurements =
            (typeof currentConfig.includeGutterMeasurements === 'boolean')
                ? currentConfig.includeGutterMeasurements
                : (typeof window.currentProjectManifest?.include_gutter_measurements === 'boolean'
                    ? window.currentProjectManifest.include_gutter_measurements
                    : !!window.currentProjectManifest?.gutter_profile?.enabled);
        const excludedSignatures = syncReportExcludedSignatures(currentConfig);
        const capturedRadiusMeters = (
            typeof window.getRadiusMeters === 'function'
                ? Number(window.getRadiusMeters())
                : (Number.isFinite(Number(window.RADIUS_METERS)) ? Number(window.RADIUS_METERS) : Number(window.currentProjectManifest?.radius_meters))
        );

        const state = {
            folderId: window.currentProjectId,
            geometry, report, address, center, dims,
            radiusMeters: Number.isFinite(capturedRadiusMeters) && capturedRadiusMeters > 0 ? capturedRadiusMeters : null,
            imageMetersPerPx: (typeof window.getMetersPerPx === 'function' && Number.isFinite(Number(window.getMetersPerPx())))
                ? Number(window.getMetersPerPx())
                : null,
            solarImg, 
            ventImg, 
            wireframes, facesData, 
            cropRegion: baseCrop, 
            displayCrop: expandedCrop,
            quadImage,
            structures, structureSettings,
            manualTotalFacets, manualWastePct,
            manualLayerFacets, customLabels: customLabels || [],
            labelAutomation: cloneJsonSafe(currentConfig.labelAutomation, null),
            gutterSettings,
            includeGutterMeasurements,
            ventSettings,
            elevationSettings,
            brandingOverrides,
            imageSettings: imgSettings,
            editorCropPadding: (typeof currentConfig.editorCropPadding === 'number') ? currentConfig.editorCropPadding : 0,
            excludedSignatures
        };

        if (captureWireframesForState && typeof ensurePdfWireframesForState === 'function') {
            await ensurePdfWireframesForState(state);
        }

        return state;

    } catch (e) {
        console.error("State Capture Failed:", e);
        alert("Error capturing report data.");
        return null;
    } finally {
        if (btn) { btn.textContent = originalText; btn.disabled = false; }
    }
}
window.captureStateForPDF = captureStateForPDF;

function shouldIncludePdfGutters(state) {
    if (typeof state?.includeGutterMeasurements === 'boolean') {
        return state.includeGutterMeasurements;
    }
    if (typeof window.currentProjectManifest?.include_gutter_measurements === 'boolean') {
        return window.currentProjectManifest.include_gutter_measurements;
    }
    return !!window.currentProjectManifest?.gutter_profile?.enabled;
}

function isObstacleFace(face, report) {
    if (!face || !face.points || !face.points.length || !report || !report.lines) return false;
    const key = (p) => `${Number(p.x).toFixed(4)},${Number(p.y).toFixed(4)}`;
    const obstaclePointKeys = new Set();
    for (const line of report.lines) {
        const t = (line.type || '').toLowerCase();
        if (t === 'skylight' || t === 'chimney_edge' || t === 'chimney_back' || t === 'chimney_front') {
            if (line.points && line.points[0]) obstaclePointKeys.add(key(line.points[0]));
            if (line.points && line.points[1]) obstaclePointKeys.add(key(line.points[1]));
        }
    }
    return face.points.every(p => obstaclePointKeys.has(key(p)));
}

function ensurePdfGutterSettings(state) {
    if (!state || typeof state !== 'object') {
        return {
            downspoutSpacingFt: PDF_GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT,
            miterAngleToleranceDeg: 2,
            stories: { north: '', south: '', east: '', west: '' },
            lineOverrides: {},
            miterOverrides: {}
        };
    }

    if (!state.gutterSettings || typeof state.gutterSettings !== 'object') {
        state.gutterSettings = {};
    }

    const settings = state.gutterSettings;
    const spacing = Number(settings.downspoutSpacingFt);
    const tolerance = Number(settings.miterAngleToleranceDeg);

    settings.downspoutSpacingFt = Number.isFinite(spacing) && spacing > 0 ? spacing : PDF_GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT;
    settings.miterAngleToleranceDeg = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 2;

    if (!settings.stories || typeof settings.stories !== 'object') {
        settings.stories = {};
    }
    if (!settings.lineOverrides || typeof settings.lineOverrides !== 'object') {
        settings.lineOverrides = {};
    }
    if (!settings.miterOverrides || typeof settings.miterOverrides !== 'object') {
        settings.miterOverrides = {};
    }

    PDF_GUTTER_DIRECTIONS.forEach((dir) => {
        const raw = settings.stories[dir];
        settings.stories[dir] = raw == null ? '' : String(raw);
        if (settings.stories[dir] === '0') settings.stories[dir] = '';
    });

    return settings;
}

function roundPdfGutterCoord(value, factor = 10) {
    return Math.round((Number(value) || 0) * factor);
}

function getPdfGutterPointKey(point) {
    return `${roundPdfGutterCoord(point?.x)},${roundPdfGutterCoord(point?.y)}`;
}

function getPdfGutterCardinalDirection(x, y) {
    if (Math.abs(x) >= Math.abs(y)) {
        return x >= 0 ? 'east' : 'west';
    }
    return y >= 0 ? 'south' : 'north';
}

function getPdfRoofFacesForGutters(state) {
    return (state?.facesData || []).filter((face) => !isObstacleFace(face, state.report));
}

function isPointInsidePolygonPdf(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = Number(poly[i]?.x) || 0;
        const yi = Number(poly[i]?.y) || 0;
        const xj = Number(poly[j]?.x) || 0;
        const yj = Number(poly[j]?.y) || 0;
        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function isPointInsidePdfRoofFace(x, y, face) {
    if (!Array.isArray(face?.points) || face.points.length < 3) return false;
    if (!isPointInsidePolygonPdf(x, y, face.points)) return false;
    if (Array.isArray(face.holes)) {
        for (const hole of face.holes) {
            if (Array.isArray(hole) && hole.length >= 3 && isPointInsidePolygonPdf(x, y, hole)) {
                return false;
            }
        }
    }
    return true;
}

function arePdfReportPointsEqual(a, b, tolerance = 0.05) {
    return Math.abs((Number(a?.x) || 0) - (Number(b?.x) || 0)) <= tolerance &&
        Math.abs((Number(a?.y) || 0) - (Number(b?.y) || 0)) <= tolerance;
}

function findPdfOwningFaceForEave(line, faces) {
    const p1 = line?.points?.[0];
    const p2 = line?.points?.[1];
    if (!p1 || !p2) return null;

    for (const face of (faces || [])) {
        const ring = Array.isArray(face?.points) ? face.points : [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (
                (arePdfReportPointsEqual(p1, a) && arePdfReportPointsEqual(p2, b)) ||
                (arePdfReportPointsEqual(p1, b) && arePdfReportPointsEqual(p2, a))
            ) {
                return face;
            }
        }
    }

    return null;
}

function fitPdfPlaneLinear(points) {
    const valid = (points || []).filter((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z));
    const n = valid.length;
    if (!n) return null;

    let sX = 0;
    let sY = 0;
    let sZ = 0;
    let sXX = 0;
    let sYY = 0;
    let sXY = 0;
    let sXZ = 0;
    let sYZ = 0;

    for (let i = 0; i < n; i++) {
        const pt = valid[i];
        sX += pt.x;
        sY += pt.y;
        sZ += pt.z;
        sXX += pt.x * pt.x;
        sYY += pt.y * pt.y;
        sXY += pt.x * pt.y;
        sXZ += pt.x * pt.z;
        sYZ += pt.y * pt.z;
    }

    const det = n * sXX * sYY + 2 * sXY * sX * sY - sX * sX * sYY - sY * sY * sXX - n * sXY * sXY;
    if (Math.abs(det) < 1e-9) {
        return { a: 0, b: 0, c: sZ / n };
    }

    const invDet = 1 / det;
    const m00 = sXX;
    const m01 = sXY;
    const m02 = sX;
    const m10 = sXY;
    const m11 = sYY;
    const m12 = sY;
    const m20 = sX;
    const m21 = sY;
    const m22 = n;
    const r0 = sXZ;
    const r1 = sYZ;
    const r2 = sZ;

    const a = invDet * ((m11 * m22 - m12 * m21) * r0 + (m02 * m21 - m01 * m22) * r1 + (m01 * m12 - m02 * m11) * r2);
    const b = invDet * ((m12 * m20 - m10 * m22) * r0 + (m00 * m22 - m02 * m20) * r1 + (m02 * m10 - m00 * m12) * r2);
    const c = invDet * ((m10 * m21 - m11 * m20) * r0 + (m01 * m20 - m00 * m21) * r1 + (m00 * m11 - m01 * m10) * r2);
    return { a, b, c };
}

function getPdfFacePlane(face) {
    if (!face || typeof face !== 'object') return null;

    const cached = face.__pdfGutterPlaneCache;
    if (cached && Number.isFinite(cached.a) && Number.isFinite(cached.b) && Number.isFinite(cached.c)) {
        return cached;
    }

    let plane = face.plane;
    if (!(plane && Number.isFinite(plane.a) && Number.isFinite(plane.b) && Number.isFinite(plane.c))) {
        plane = fitPdfPlaneLinear(face.points);
    }

    face.__pdfGutterPlaneCache = plane && Number.isFinite(plane.a) && Number.isFinite(plane.b) && Number.isFinite(plane.c)
        ? plane
        : null;

    return face.__pdfGutterPlaneCache;
}

function getPdfFaceHeightAtPoint(face, x, y) {
    const plane = getPdfFacePlane(face);
    if (plane) return (plane.a * x) + (plane.b * y) + plane.c;

    const validZ = (Array.isArray(face?.points) ? face.points : [])
        .map((pt) => Number(pt?.z))
        .filter((value) => Number.isFinite(value));
    if (!validZ.length) return null;
    return validZ.reduce((sum, value) => sum + value, 0) / validZ.length;
}

function getPdfMaxRoofHeightAtPoint(x, y, faces) {
    let maxHeight = null;
    for (const face of (faces || [])) {
        if (!isPointInsidePdfRoofFace(x, y, face)) continue;
        const height = getPdfFaceHeightAtPoint(face, x, y);
        if (!Number.isFinite(height)) continue;
        if (maxHeight == null || height > maxHeight) {
            maxHeight = height;
        }
    }
    return maxHeight;
}

function getPdfGutterVertexHeight(vertex, items) {
    const pointHeights = (items || [])
        .map((item) => Number(item?.point?.z))
        .filter((value) => Number.isFinite(value));
    if (pointHeights.length) return Math.max(...pointHeights);

    const vertexHeight = Number(vertex?.z);
    if (Number.isFinite(vertexHeight)) return vertexHeight;

    const faceHeights = (items || [])
        .map((item) => getPdfFaceHeightAtPoint(item?.ownerFace, Number(vertex?.x) || 0, Number(vertex?.y) || 0))
        .filter((value) => Number.isFinite(value));
    if (faceHeights.length) return Math.max(...faceHeights);

    return null;
}

function isPdfPointInsideRoofAboveVertex(x, y, faces, vertexHeight) {
    const roofHeight = getPdfMaxRoofHeightAtPoint(x, y, faces);
    if (!Number.isFinite(roofHeight)) return false;
    if (!Number.isFinite(vertexHeight)) return true;
    return roofHeight >= (vertexHeight - PDF_GUTTER_HEIGHT_EPSILON);
}

function estimatePdfGutterDownspoutTotal(lengthFt, spacingFt) {
    const totalLength = Number(lengthFt) || 0;
    const spacing = Number(spacingFt) || PDF_GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT;
    if (totalLength <= 0 || spacing <= 0) return 0;

    // EagleView does not publish the exact rule; their sample reports line up much
    // more closely with nearest-whole allocation off total eave length than with
    // per-side ceiling logic.
    return Math.max(1, Math.round(totalLength / spacing));
}

function distributePdfDirectionalDownspouts(directional, totalEstimatedDownspouts) {
    const activeDirections = PDF_GUTTER_DIRECTIONS
        .map((dir) => ({
            dir,
            lengthFt: Number(directional?.[dir]?.lengthFt) || 0
        }))
        .filter((entry) => entry.lengthFt > 0);

    PDF_GUTTER_DIRECTIONS.forEach((dir) => {
        if (directional?.[dir]) directional[dir].estimatedDownspouts = 0;
    });

    if (!activeDirections.length || totalEstimatedDownspouts <= 0) return;

    const totalLengthFt = activeDirections.reduce((sum, entry) => sum + entry.lengthFt, 0);
    let assigned = 0;
    const ranked = activeDirections.map((entry) => {
        const exact = totalLengthFt > 0
            ? (entry.lengthFt / totalLengthFt) * totalEstimatedDownspouts
            : 0;
        const base = Math.floor(exact);
        assigned += base;
        directional[entry.dir].estimatedDownspouts = base;
        return {
            dir: entry.dir,
            remainder: exact - base,
            lengthFt: entry.lengthFt
        };
    });

    let remaining = totalEstimatedDownspouts - assigned;
    ranked.sort((a, b) => {
        if (b.remainder !== a.remainder) return b.remainder - a.remainder;
        if (b.lengthFt !== a.lengthFt) return b.lengthFt - a.lengthFt;
        return a.dir.localeCompare(b.dir);
    });

    for (let i = 0; i < ranked.length && remaining > 0; i += 1) {
        directional[ranked[i].dir].estimatedDownspouts += 1;
        remaining -= 1;
        if (i === ranked.length - 1 && remaining > 0) i = -1;
    }
}

function buildPdfGutterMetrics(state) {
    const settings = ensurePdfGutterSettings(state);
    const faces = getPdfRoofFacesForGutters(state);
    const lines = Array.isArray(state?.report?.lines) ? state.report.lines : [];
    const eaveLines = lines
        .filter((line) => (line?.type || '').toLowerCase() === 'eave' && Array.isArray(line.points) && line.points.length >= 2)
        .map((line, index) => {
            const start = line.points[0];
            const end = line.points[1];
            const midpoint = {
                x: ((Number(start?.x) || 0) + (Number(end?.x) || 0)) / 2,
                y: ((Number(start?.y) || 0) + (Number(end?.y) || 0)) / 2
            };
            const ownerFace = findPdfOwningFaceForEave(line, faces);
            const centroid = ownerFace
                ? {
                    x: ownerFace.points.reduce((sum, pt) => sum + (Number(pt?.x) || 0), 0) / ownerFace.points.length,
                    y: ownerFace.points.reduce((sum, pt) => sum + (Number(pt?.y) || 0), 0) / ownerFace.points.length
                }
                : midpoint;
            const dx = (Number(end?.x) || 0) - (Number(start?.x) || 0);
            const dy = (Number(end?.y) || 0) - (Number(start?.y) || 0);
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const normalA = { x: -dy / len, y: dx / len };
            const normalB = { x: dy / len, y: -dx / len };
            const toCentroid = { x: centroid.x - midpoint.x, y: centroid.y - midpoint.y };
            const dotA = normalA.x * toCentroid.x + normalA.y * toCentroid.y;
            const inward = dotA >= 0 ? normalA : normalB;
            const outward = { x: -inward.x, y: -inward.y };

            return {
                id: `gutter-eave-${index}`,
                line,
                start,
                end,
                midpoint,
                lengthFt: Number(line.length) || 0,
                direction: getPdfGutterCardinalDirection(outward.x, outward.y),
                ownerFace,
                disabled: !!settings.lineOverrides[`gutter-eave-${index}`]?.disabled
            };
        });

    const directional = {};
    PDF_GUTTER_DIRECTIONS.forEach((dir) => {
        directional[dir] = {
            lengthFt: 0,
            estimatedDownspouts: 0,
            stories: settings.stories[dir] || ''
        };
    });

    eaveLines.forEach((entry) => {
        if (entry.disabled) return;
        directional[entry.direction].lengthFt += entry.lengthFt;
    });

    const totalLengthFt = eaveLines.reduce((sum, entry) => entry.disabled ? sum : sum + entry.lengthFt, 0);
    const estimatedDownspouts = estimatePdfGutterDownspoutTotal(totalLengthFt, settings.downspoutSpacingFt);
    distributePdfDirectionalDownspouts(directional, estimatedDownspouts);

    const endpointMap = new Map();
    eaveLines.forEach((entry) => {
        [
            { point: entry.start, other: entry.end },
            { point: entry.end, other: entry.start }
        ].forEach((item) => {
            const key = getPdfGutterPointKey(item.point);
            if (!endpointMap.has(key)) endpointMap.set(key, []);
            endpointMap.get(key).push({
                point: item.point,
                other: item.other,
                ownerFace: entry.ownerFace
            });
        });
    });

    const miterCounts = { inside90: 0, outside90: 0, non90: 0 };
    const miters = [];

    endpointMap.forEach((items) => {
        if (!Array.isArray(items) || items.length !== 2) return;

        const vertex = items[0].point;
        const v1 = {
            x: (Number(items[0].other?.x) || 0) - (Number(vertex?.x) || 0),
            y: (Number(items[0].other?.y) || 0) - (Number(vertex?.y) || 0)
        };
        const v2 = {
            x: (Number(items[1].other?.x) || 0) - (Number(vertex?.x) || 0),
            y: (Number(items[1].other?.y) || 0) - (Number(vertex?.y) || 0)
        };

        const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
        const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
        if (len1 < 1e-6 || len2 < 1e-6) return;

        const u1 = { x: v1.x / len1, y: v1.y / len1 };
        const u2 = { x: v2.x / len2, y: v2.y / len2 };
        const dot = Math.max(-1, Math.min(1, (u1.x * u2.x) + (u1.y * u2.y)));
        const angleDeg = Math.acos(dot) * (180 / Math.PI);
        if (angleDeg < 10 || angleDeg > 170) return;

        let bisector = { x: u1.x + u2.x, y: u1.y + u2.y };
        const bisectorLen = Math.sqrt((bisector.x * bisector.x) + (bisector.y * bisector.y));
        if (bisectorLen < 1e-6) {
            bisector = { x: u1.y, y: -u1.x };
        } else {
            bisector.x /= bisectorLen;
            bisector.y /= bisectorLen;
        }

        const samplePoint = {
            x: (Number(vertex?.x) || 0) + (bisector.x * 6),
            y: (Number(vertex?.y) || 0) + (bisector.y * 6)
        };
        const vertexHeight = getPdfGutterVertexHeight(vertex, items);
        const smallerWedgeInsideRoof = isPdfPointInsideRoofAboveVertex(samplePoint.x, samplePoint.y, faces, vertexHeight);
        const isNear90 = Math.abs(angleDeg - 90) <= settings.miterAngleToleranceDeg;

        let autoType = 'non90';
        if (isNear90) autoType = smallerWedgeInsideRoof ? 'outside90' : 'inside90';

        const miterId = getPdfGutterPointKey(vertex);
        const overrideType = settings.miterOverrides[miterId];
        const effectiveType = overrideType || autoType;
        const isOff = effectiveType === 'off';
        const isOverridden = !!overrideType && overrideType !== autoType;

        if (!isOff) {
            if (effectiveType === 'inside90') miterCounts.inside90 += 1;
            else if (effectiveType === 'outside90') miterCounts.outside90 += 1;
            else miterCounts.non90 += 1;
        }

        miters.push({
            id: miterId,
            x: Number(vertex?.x) || 0,
            y: Number(vertex?.y) || 0,
            angleDeg,
            type: effectiveType,
            autoType,
            isOff,
            isOverridden
        });
    });

    const missingStories = PDF_GUTTER_DIRECTIONS.filter((dir) => String(settings.stories[dir] || '').trim() === '');

    return {
        settings,
        eaveLines,
        directional,
        miterCounts,
        miters,
        totalLengthFt,
        estimatedDownspouts,
        missingStories
    };
}

function formatPdfGutterRunLabel(value) {
    const num = Number(value) || 0;
    return Math.round(num).toLocaleString();
}

console.log("RUNNING UPDATED VERSION")

function countRealFacets(state, layerNum = null) {
  const excluded = getReportExcludedSignatureSet(state);
  const autoExcluded = getReportAutoExcludedFaceIndexSet(state);
  const faces = (state.facesData || []).filter((f, idx) => {
      if (!f || !Array.isArray(f.points)) return false;
      if (autoExcluded.has(idx)) return false;
      if (isObstacleFace(f, state.report)) return false;
      const sig = getLocalFaceSignatureReport(f.points);
      return !excluded.has(sig);
  });
  return layerNum == null
    ? faces.length
    : faces.filter(f => (f.layer || 1) === layerNum).length;
}

function getPdfProjectType(state) {
    const manifestType = window.currentProjectManifest?.project_type;
    if (typeof manifestType === 'string' && manifestType.trim()) {
        return manifestType.trim().toLowerCase();
    }

    const stateType = state?.projectType || state?.project_type || state?.report?.project_type;
    if (typeof stateType === 'string' && stateType.trim()) {
        return stateType.trim().toLowerCase();
    }

    return '';
}


// ==========================================
// --- 2. PDF GENERATION ---
// ===============================================================================


/* editor_scripts/pdf.js */

async function generatePDFFromState(state, mode = 'full', updateStatusCallback, runtimeOptions = {}) {
    if (!state || !state.geometry || !state.report) throw new Error("Missing measurement data.");
    const previousDiagramFontScale = window.PDF_DIAGRAM_FONT_SCALE;
    const previousMeasurementFontScale = window.PDF_MEASUREMENT_FONT_SCALE;
    window.PDF_DIAGRAM_FONT_SCALE = Number(state.diagramFontScale) || previousDiagramFontScale || 1.0;
    window.PDF_MEASUREMENT_FONT_SCALE = Number(state.measurementFontScale) || previousMeasurementFontScale || 1.0;
    syncReportExcludedSignatures(state);
    normalizeReportMaterialTotals(state.report, 'generatePDFFromState:precalc');
    emitPdfDebug('generate:start', {
        mode,
        summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
    });

    // --- CONFIGURATION ---
    const org = window.projectOrganization || {};
    const orgSettings = org.report_settings || {};
    const savedPdfConfig = (state.pdfConfig && typeof state.pdfConfig === 'object') ? state.pdfConfig : {};
    const savedFullPdfConfig = (savedPdfConfig.full && typeof savedPdfConfig.full === 'object')
        ? savedPdfConfig.full
        : savedPdfConfig;
    const savedSummaryPdfConfig = (savedPdfConfig.summary && typeof savedPdfConfig.summary === 'object')
        ? savedPdfConfig.summary
        : {};
    const pageConfigOverride = (runtimeOptions.pageConfigOverride && typeof runtimeOptions.pageConfigOverride === 'object')
        ? runtimeOptions.pageConfigOverride
        : {};
    const isCommercialReport = getPdfProjectType(state) === 'commercial';
    
    const guttersEnabled = shouldIncludePdfGutters(state);
    const defaults = {
        cover_show_customer: true,
        cover_show_squares: true,
        cover_show_waste: true,
        cover_show_breakdown: true,
        cover_show_pitch: true,
        cover_show_facets: true,
        page_top_view: true,
        page_elevations: true,
        page_3d: true,
        page_pitch: true,
        page_area: true,
        page_layers: true,
        page_summary: true,
        page_materials: true,
        page_ventilation: true,
        page_gutters: guttersEnabled,
        page_notes: true        // ← NEW: Notes / field page (summary only)
    };

    const fullSettings = (orgSettings.general && typeof orgSettings.general === 'object')
        ? orgSettings.general
        : {};

    let s = { ...defaults, ...fullSettings, ...savedFullPdfConfig };
    if (mode === 'summary') {
        const customerSettings = orgSettings.customer || orgSettings;
        const normalizedCustomerSettings = { ...(customerSettings || {}) };
        if (!Object.prototype.hasOwnProperty.call(normalizedCustomerSettings, 'page_gutters')) {
            normalizedCustomerSettings.page_gutters = false;
        }
        s = { ...defaults, ...normalizedCustomerSettings, ...savedSummaryPdfConfig };
    }
    s = { ...s, ...pageConfigOverride };
    s.page_gutters = guttersEnabled && !!s.page_gutters;
    s.page_ventilation = !isCommercialReport && !!s.page_ventilation;
    if (firstMeasurePdfQuadViewsDisabled()) {
        s.page_elevations = false;
        if (state.elevationSettings && typeof state.elevationSettings === 'object') {
            state.elevationSettings.include = false;
        }
        state.quadImage = null;
    }

    // --- STEP 1: RECALCULATE MATH ---
    const calcResult = window.recalculateReportMaterials(state);
    state.report = calcResult.updatedReport;
    normalizeReportMaterialTotals(state.report, 'generatePDFFromState:postcalc');
    emitPdfDebug('generate:postcalc', {
        mode,
        calcResult: {
            facetCount: calcResult.facetCount,
            totalSquares: roundPdfDebugValue(calcResult.totalSquares),
            totalFootprintSqFt: roundPdfDebugValue(calcResult.totalFootprintSqFt, 2),
            atticAreaSqFt: roundPdfDebugValue(calcResult.atticAreaSqFt, 2)
        },
        summary: buildPdfDebugSummary(state, state.report, { includeFaces: true })
    });

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'letter');
    const metadataAddress = String(state.address || '').replace(/\s+/g, ' ').trim();
    const metadataTitle = runtimeOptions.coverTitle
        || `${mode === 'summary' ? 'FirstMate FirstMeasure Summary' : 'FirstMate FirstMeasure Report'}${metadataAddress ? ` - ${metadataAddress}` : ''}`;
    if (typeof doc.setDocumentProperties === 'function') {
        doc.setDocumentProperties({
            title: metadataTitle,
            author: 'FirstMate',
            creator: 'FirstMate',
            subject: mode === 'summary'
                ? 'FirstMate FirstMeasure roof measurement summary'
                : 'FirstMate FirstMeasure roof measurement report',
            keywords: 'FirstMate, FirstMeasure, roof measurement, report'
        });
    }
    const deterministicSeed = `${state.pdfSyncRevision || state.pdf_sync_revision || state.savedAt || state.folderId || 'firstmeasure'}:${mode}`;
    let deterministicFileId = '';
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deterministicSeed));
        deterministicFileId = Array.from(new Uint8Array(digest)).slice(0, 16).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    } catch (e) {
        deterministicFileId = Array.from(deterministicSeed).reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 2166136261).toString(16).padStart(32, '0').slice(-32).toUpperCase();
    }
    if (typeof doc.setFileId === 'function') doc.setFileId(deterministicFileId);
    if (typeof doc.setCreationDate === 'function') {
        const requestedCreationDate = new Date(state.pdfGeneratedAt || state.savedAt || Date.now());
        const creationDate = Number.isFinite(requestedCreationDate.getTime()) ? requestedCreationDate : new Date();
        const padDatePart = (value) => String(value).padStart(2, '0');
        const pdfCreationDate = `D:${creationDate.getUTCFullYear()}${padDatePart(creationDate.getUTCMonth() + 1)}${padDatePart(creationDate.getUTCDate())}${padDatePart(creationDate.getUTCHours())}${padDatePart(creationDate.getUTCMinutes())}${padDatePart(creationDate.getUTCSeconds())}+00'00'`;
        doc.setCreationDate(pdfCreationDate);
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    // --- BRANDING LOGIC ---
    const applyBrandingToFull = !!(runtimeOptions.applyBrandingToFull || state.applyBrandingToFull);
    const hasOrgBranding = !!(org.branding);
    const hasOverrides = !!(state.brandingOverrides &&
        (state.brandingOverrides.primaryColor || state.brandingOverrides.secondaryColor || state.brandingOverrides.logoDataUrl));
    const useBranding = ((mode === 'summary') || applyBrandingToFull) && (hasOrgBranding || hasOverrides);

    const branding = hasOrgBranding ? org.branding : {};

    let primaryColor   = { r: 200, g: 40, b: 40 };
    let secondaryColor = { r: 150, g: 0, b: 0 };
    const defaultLogoUrl = '/images/logo_red.png';
    let logoUrl = defaultLogoUrl;
    let resolvedCustomerLogoUrl = '';

    if (useBranding && hasOrgBranding) {
        if (branding.colors?.primary)   primaryColor   = hexToRgbReport(branding.colors.primary);
        if (branding.colors?.secondary) secondaryColor = hexToRgbReport(branding.colors.secondary);
        resolvedCustomerLogoUrl = firstReportLogoValue(branding, org);
        logoUrl = resolvedCustomerLogoUrl || logoUrl;
    }

    const hasOverrideLogo = !!(useBranding && state.brandingOverrides && state.brandingOverrides.logoDataUrl);
    const logoColorizedFallback = !!(useBranding && !hasOverrideLogo && !resolvedCustomerLogoUrl && logoUrl === defaultLogoUrl);

    if (useBranding && state.brandingOverrides) {
        const bo = state.brandingOverrides;
        if (bo.primaryColor)   primaryColor   = hexToRgbReport(bo.primaryColor);
        if (bo.secondaryColor) secondaryColor = hexToRgbReport(bo.secondaryColor);
    }

    const brandingColors = { primary: primaryColor, secondary: secondaryColor };
    const forceDefaultBoxes = (mode === 'full') && !applyBrandingToFull;
    window.__pdfForceDefaultBoxes = forceDefaultBoxes;
    window.__pdfBrandingColorOverride = useBranding ? primaryColor : null;

    emitPdfDebug('generate:branding', {
        mode,
        branding: {
            applyBrandingToFull,
            hasOrgBranding,
            hasOverrides,
            useBranding,
            orgPrimary: branding?.colors?.primary || null,
            orgSecondary: branding?.colors?.secondary || null,
            orgLogo: branding?.logo || null,
            orgLogoNodeUrl: branding?.logo_node_url || null,
            orgLogoUrl: branding?.logo_url || null,
            overridePrimary: state?.brandingOverrides?.primaryColor || null,
            overrideSecondary: state?.brandingOverrides?.secondaryColor || null,
            overrideLogo: state?.brandingOverrides?.logoDataUrl
                ? (String(state.brandingOverrides.logoDataUrl).startsWith('data:') ? '[data-url]' : state.brandingOverrides.logoDataUrl)
                : null,
            resolvedPrimary: primaryColor,
            resolvedSecondary: secondaryColor,
            resolvedLogoUrl: logoUrl,
            logoColorizedFallback,
            forceDefaultBoxes
        }
    });


    // --- ASSETS ---
    if (updateStatusCallback) updateStatusCallback(`Loading Assets (${mode})...`);
    
    let logoDataPromise;
    if (useBranding && state.brandingOverrides && state.brandingOverrides.logoDataUrl) {
        logoDataPromise = new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const MAX_W = 400, MAX_H = 200;
                let w = img.width, h = img.height;
                if (w > MAX_W) { h = Math.round(h * (MAX_W / w)); w = MAX_W; }
                if (h > MAX_H) { w = Math.round(w * (MAX_H / h)); h = MAX_H; }
                const cvs = document.createElement('canvas');
                cvs.width = w; cvs.height = h;
                const ctx = cvs.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);
                resolve(cvs.toDataURL('image/png').split(',')[1]);
            };
            img.onerror = () => resolve(state.brandingOverrides.logoDataUrl.split(',')[1] || '');
            img.src = state.brandingOverrides.logoDataUrl;
        });
    } else {
        logoDataPromise = fetchImageAssetAsPngBase64(logoUrl)
            .catch(() => fetchImageAssetAsPngBase64(defaultLogoUrl))
            .then((logoData) => logoColorizedFallback
                ? colorizePngBase64(logoData, primaryColor).catch(() => logoData)
                : logoData);
    }

    const [fontRegular, fontBold, logoData] = await Promise.all([
        fetchAssetAsBase64('/fonts/Montserrat-Regular.ttf'),
        fetchAssetAsBase64('/fonts/Montserrat-Bold.ttf'),
        logoDataPromise
    ]);

    emitPdfDebug('generate:branding-assets', {
        mode,
        logoLoaded: !!logoData,
        logoBytesApprox: logoData ? Math.round((String(logoData).length * 3) / 4) : 0
    });

    doc.addFileToVFS("Montserrat-Regular.ttf", fontRegular);
    doc.addFont("Montserrat-Regular.ttf", "Montserrat", "normal");
    doc.addFileToVFS("Montserrat-Bold.ttf", fontBold);
    doc.addFont("Montserrat-Bold.ttf", "Montserrat", "bold");
    doc.setFont("Montserrat", "normal");

    // --- LAYOUT CONSTANTS ---
    const SIDEBAR_W = 10;
    const PADDING_X = 15;
    const marginLeft = SIDEBAR_W + PADDING_X;
    const availableW = pageWidth - marginLeft - PADDING_X;
    
    const bottomMargin = 18;
    const boxHeight = 58; 
    const boxTopY = pageHeight - bottomMargin - boxHeight;
    const imgRatio = state.cropRegion.width / state.cropRegion.height;
    if (!Number.isFinite(Number(state.manualTotalFacets))) {
        state.manualTotalFacets = countRealFacets(state);
    }
    let outlineImg = null;

    let pageCount = 0;
    const beginReportPage = (title, isCover = false) => {
        pageCount++;
        if (pageCount > 1) doc.addPage();
        drawReportTemplate(doc, pageCount, logoData, isCover, title, state.address, brandingColors, state.pdfRenderDateLabel);
    };

    // ==========================================
    // PAGE 1: COVER
    // ==========================================
    if (updateStatusCallback) updateStatusCallback(`Generating Cover (${mode})...`);

    const coverTitle = runtimeOptions.coverTitle || (mode === 'summary' ? "Roof Summary" : "Project Overview");
    beginReportPage(coverTitle, true);

    const mapTopY = 40;
    const mapBottomY = boxTopY - 10;
    const mapH = mapBottomY - mapTopY;

    drawPdfCard(doc, marginLeft, mapTopY, availableW, mapH, 3);

    const outlineCanvas = await createFacetCanvasFromState(state, 'OUTLINE');
    outlineImg = outlineCanvas.toDataURL('image/jpeg', 0.40);

    const inset = 2;
    placeImageCentered(
        doc,
        outlineImg,
        imgRatio,
        marginLeft + inset,
        mapTopY + inset,
        mapTopY + mapH - inset,
        availableW - inset * 2
    );

    drawPDFCompass(doc, marginLeft + 10, mapTopY + 12, 3);

    if (mode === 'full') {
        const boxWidth = (availableW / 2) - 3;
        const pad = 8;

        drawSummaryBox(doc, marginLeft, boxTopY, boxWidth, boxHeight, "Project Summary", {
            forceDefault: forceDefaultBoxes,
            colors: brandingColors,
            pad
        });

        let yCursor = boxTopY + 16;

        const netSquares = state.report.materials.totalSquares || 0;
        const wastePct = (typeof state.manualWastePct === 'number') ? state.manualWastePct : 10;
        const wasteSquares = netSquares * (1 + (wastePct / 100));

        let domPitch = "N/A";
        let maxArea = -1;
        const squaresData = state.report.materials.squares || {};
        Object.keys(squaresData).forEach(p => {
            const val = squaresData[p];
            if (typeof val === 'number' && val > maxArea) { maxArea = val; domPitch = p; }
        });

        emitPdfDebug('page:cover', {
            mode,
            page: pageCount,
            cover: {
                netSquares: roundPdfDebugValue(netSquares),
                netSqFt: roundPdfDebugValue(netSquares * 100, 2),
                wastePct,
                wasteSquares: roundPdfDebugValue(wasteSquares),
                wasteSqFt: roundPdfDebugValue(wasteSquares * 100, 2),
                dominantPitch: domPitch,
                totalFacets: state.manualTotalFacets
            },
            summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
        });

        doc.setFontSize(9);
        doc.setFont("Montserrat", "normal");

        const coverFacetText = `Total Facets: ${state.manualTotalFacets}`;
        const coverPitchText = `Predominant Pitch: ${domPitch}`;
        const coverNetSquaresText = `Total Squares (Net): ${Math.round(netSquares * 100) / 100}`;
        const coverWasteSquaresText = `Total Squares (${wastePct}% Waste): ${Math.round(wasteSquares * 100) / 100}`;
        emitPdfDebug('page:cover:text', {
            mode,
            page: pageCount,
            text: {
                coverFacetText,
                coverPitchText,
                coverNetSquaresText,
                coverWasteSquaresText
            }
        });

        doc.text(coverFacetText, marginLeft + pad, yCursor); yCursor += 5;
        doc.text(coverPitchText, marginLeft + pad, yCursor); yCursor += 5;
        yCursor += 5;
        doc.text(coverNetSquaresText, marginLeft + pad, yCursor); yCursor += 5;
        doc.text(coverWasteSquaresText, marginLeft + pad, yCursor);

        const box2X = marginLeft + boxWidth + 6;
        drawSummaryBox(doc, box2X, boxTopY, boxWidth, boxHeight, "Measurement Breakdown", {
            forceDefault: forceDefaultBoxes,
            colors: brandingColors,
            pad
        });

        yCursor = boxTopY + 16;

        Object.keys(state.report.materials.linear || {}).forEach(key => {
            if (key.toLowerCase() === 'unknown' || key.toLowerCase() === 'skylight back' || key.toLowerCase() === 'skylight sides') return;
            if (yCursor > boxTopY + boxHeight - 5) return;
            const label = formatLineType(key);
            const val = Math.round(state.report.materials.linear[key]);

            doc.text(`${label}:`, box2X + pad, yCursor);
            doc.text(`${val}'`, box2X + boxWidth - pad, yCursor, { align: 'right' });

            yCursor += 5;
        });
    } else {
        drawDynamicCoverPage(doc, state, s, marginLeft, boxTopY, availableW, boxHeight);
    }

    // ==========================================
    // REMAINING PAGES
    // ==========================================

    // Top View
    if (state.solarImg && s.page_top_view) {
        beginReportPage("Top View");
        const tvTopY = 35;
        const tvSize = Math.min(availableW, pageHeight - tvTopY - 30);
        const tvX = marginLeft + (availableW - tvSize) / 2;
        const tvR = 3;

        doc.setFillColor(230, 230, 230);
        doc.roundedRect(tvX + 1.5, tvTopY + 1.5, tvSize, tvSize, tvR, tvR, 'F');

        const k = tvR * 0.55228;
        doc.internal.write('q');
        const f = 72 / 25.4;
        const pH = doc.internal.pageSize.getHeight();
        const px = tvX * f, py = (pH - tvTopY) * f;
        const ps = tvSize * f, pr = tvR * f, pk = k * f;
        doc.internal.write(
            (px + pr).toFixed(2) + ' ' + py.toFixed(2) + ' m ' +
            (px + ps - pr).toFixed(2) + ' ' + py.toFixed(2) + ' l ' +
            (px + ps - pr + pk).toFixed(2) + ' ' + py.toFixed(2) + ' ' +
            (px + ps).toFixed(2) + ' ' + (py - pr + pk).toFixed(2) + ' ' +
            (px + ps).toFixed(2) + ' ' + (py - pr).toFixed(2) + ' c ' +
            (px + ps).toFixed(2) + ' ' + (py - ps + pr).toFixed(2) + ' l ' +
            (px + ps).toFixed(2) + ' ' + (py - ps + pr - pk).toFixed(2) + ' ' +
            (px + ps - pr + pk).toFixed(2) + ' ' + (py - ps).toFixed(2) + ' ' +
            (px + ps - pr).toFixed(2) + ' ' + (py - ps).toFixed(2) + ' c ' +
            (px + pr).toFixed(2) + ' ' + (py - ps).toFixed(2) + ' l ' +
            (px + pr - pk).toFixed(2) + ' ' + (py - ps).toFixed(2) + ' ' +
            px.toFixed(2) + ' ' + (py - ps + pr - pk).toFixed(2) + ' ' +
            px.toFixed(2) + ' ' + (py - ps + pr).toFixed(2) + ' c ' +
            px.toFixed(2) + ' ' + (py - pr).toFixed(2) + ' l ' +
            px.toFixed(2) + ' ' + (py - pr + pk).toFixed(2) + ' ' +
            (px + pr - pk).toFixed(2) + ' ' + py.toFixed(2) + ' ' +
            (px + pr).toFixed(2) + ' ' + py.toFixed(2) + ' c ' +
            'W n'
        );
        const bleed = 1.0;
        doc.addImage(state.solarImg, 'JPEG', tvX - bleed, tvTopY - bleed, tvSize + bleed * 2, tvSize + bleed * 2);
        doc.internal.write('Q');

        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.4);
        doc.roundedRect(tvX, tvTopY, tvSize, tvSize, tvR, tvR, 'S');
    }

    // Elevations
    const hasQuadImage = !firstMeasurePdfQuadViewsDisabled() && typeof state.quadImage === 'string' && state.quadImage.trim() !== '';
    const includeElev = hasQuadImage && !(state.elevationSettings && state.elevationSettings.include === false);
    if (s.page_elevations && includeElev) {
        beginReportPage("3D Elevations");
        const qImg = new Image(); qImg.src = state.quadImage;
        await new Promise(r => qImg.onload = r);
        const qRatio = qImg.width / qImg.height;
        const elevY = 35;
        const imgDims = placeImageOnPage(doc, state.quadImage, qRatio, availableW, 200, marginLeft, elevY);
        
        const pColor = { r: 103, g: 103, b: 103 };
        const elevImgX = marginLeft + (availableW - imgDims.w) / 2;
        const cellW = imgDims.w / 2;
        const cellH = imgDims.h / 2;
        const elevLabels = ["North View", "South View", "East View", "West View"];
        const elevOffsets = [
            { dx: -2.5, dy: -1 },
            { dx: 1.5, dy: -1 },
            { dx: -2.5, dy: 4 },
            { dx: 1.5, dy: 4 }
        ];
        const elevPositions = [
            { px: elevImgX, py: elevY },
            { px: elevImgX + cellW, py: elevY },
            { px: elevImgX, py: elevY + cellH },
            { px: elevImgX + cellW, py: elevY + cellH }
        ];
        
        doc.setFont("Montserrat", "bold");
        doc.setFontSize(10);
        
        let maxTextW = 0;
        elevLabels.forEach(label => {
            const tw = doc.getTextWidth(label);
            if (tw > maxTextW) maxTextW = tw;
        });
        const uniformPillW = (maxTextW + 6) * 3;
        const pillH = 8;
        const pillR = 2;
        
        elevPositions.forEach((pos, i) => {
            const label = elevLabels[i];
            const off = elevOffsets[i];
            const pillX = pos.px + (cellW - uniformPillW) / 2 + off.dx;
            const pillY = pos.py + 2 + off.dy - 1;
            
            doc.setFillColor(pColor.r, pColor.g, pColor.b);
            doc.roundedRect(pillX, pillY, uniformPillW, pillH, pillR, pillR, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.text(label, pillX + uniformPillW / 2, pillY + pillH / 2 + 1, { align: 'center' });
        });
        doc.setTextColor(0);
    }

    // Wireframes
    const wireframesForPage = s.page_3d && typeof ensurePdfWireframesForState === 'function'
        ? await ensurePdfWireframesForState(state)
        : state.wireframes;
    const hasWireframePage = await pdfWireframeSetHasVisibleInk(wireframesForPage);
    if (s.page_3d && hasWireframePage) {
        beginReportPage("3D Facets");
        drawQuadGridPage(doc, wireframesForPage, marginLeft, 35, availableW, pageHeight - 55, brandingColors);
    } else if (s.page_3d) {
        console.warn('[PDF 3D] Skipping the 3D facets page because the wireframe capture was unavailable.');
    }

    // Pitch Diagram
    if (s.page_pitch) {
        if (updateStatusCallback) updateStatusCallback(`Generating Labels (${mode})...`);
        beginReportPage("Pitch Diagram");
        const pitchCanvas = await createFacetCanvasFromState(state, 'PITCH');
        const pitchImg = pitchCanvas.toDataURL('image/jpeg', 0.40);
        const topY = 35;
        const tableY = 200;
        const facetCountText = `Total Facets: ${state.manualTotalFacets}`;

        doc.setFont("Montserrat", "bold");
        doc.setFontSize(9);
        doc.setTextColor(40, 40, 40);
        doc.text(facetCountText, marginLeft, topY - 5);
        doc.setTextColor(0);

        placeImageCentered(doc, pitchImg, imgRatio, marginLeft, topY, tableY - 5, availableW);
        drawPDFCompass(doc, marginLeft + 10, topY + 10, 3);
        drawPitchTable(doc, state.report.materials.squares, marginLeft, tableY, availableW, true);
    }

    // Area Diagram
    if (s.page_area) {
        beginReportPage("Area Diagram");
        emitPdfDebug('page:area-diagram', {
            mode,
            page: pageCount,
            summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
        });
        const areaCanvas = await createFacetCanvasFromState(state, 'AREA');
        const areaImg = areaCanvas.toDataURL('image/jpeg', 0.40);
        const topY = 35;
        const tableY = 200; 
        placeImageCentered(doc, areaImg, imgRatio, marginLeft, topY, tableY - 5, availableW);
        drawPDFCompass(doc, marginLeft + 10, topY + 10, 3);
        drawSummaryBox(doc, marginLeft, tableY, availableW, 55, "Area Breakdown");
        drawPitchTable(doc, state.report.materials.squares, marginLeft, tableY, availableW, false);
    }

    // Layers
    if (s.page_layers) {
        const allLayers = [1, 2, 3, 4, 5, 6].filter(n => state.report.lines.some(l => (l.points[0].layer || 1) === n));

        for (let i = 0; i < allLayers.length; i++) {
            const layerNum = allLayers[i];
            if (updateStatusCallback) updateStatusCallback(`Generating Layer ${layerNum}...`);

            beginReportPage(`Layer ${layerNum} Measurements`);

            const layerCanvas = await createLayerCanvasFromState(state, layerNum, true, false);
            const layerImg = layerCanvas.toDataURL('image/jpeg', 0.40);
            
            const topY = 45; 
            const bottomBoxY = pageHeight - 25 - 50; 
            const legendY = bottomBoxY - 20; 
            
            placeImageCentered(doc, layerImg, imgRatio, marginLeft, topY, legendY - 5, availableW);
            drawLegend(doc, state.report, marginLeft, legendY);

            const pad = 8; 

            drawSummaryBox(doc, marginLeft, bottomBoxY, availableW, 50, `Layer ${layerNum} Details`, {
                forceDefault: forceDefaultBoxes,
                colors: brandingColors,
                pad
            });
            
            const layerLines = state.report.lines.filter(l => (l.points[0].layer || 1) === layerNum);
            let layerAreaSq = 0;
            let layerFacetCount = 0;
            const autoExcludedLayerFaces = getReportAutoExcludedFaceIndexSet(state);
            const layerFaces = state.facesData.filter((f, idx) => (f.layer || 1) === layerNum && !autoExcludedLayerFaces.has(idx));

            const layerLabelMap = new Map();
            if (state.customLabels && Array.isArray(state.customLabels)) {
                state.customLabels.forEach(lbl => {
                    if (lbl.faceSignature) layerLabelMap.set(lbl.faceSignature, lbl);
                });
            }
            const mPerPx = getPdfMetersPerPx(state);

            layerFaces.forEach(f => {
                if (isObstacleFace(f, state.report)) return;
                const sig = getLocalFaceSignatureReport(f.points);
                if (getReportExcludedSignatureSet(state).has(sig)) return;

                layerFacetCount++;
                const areaPx = Math.abs(getSignedArea(f.points));
                const areaM2 = areaPx * (mPerPx * mPerPx);

                let pitchDeg = 0;
                let rise12 = 0;
                let usedOverride = false;

                const lbl = layerLabelMap.get(sig);
                if (lbl && (lbl.text !== undefined || lbl.pitchText !== undefined)) {
                    const parsed = getPdfLabelRise12(lbl);
                    if (Number.isFinite(parsed)) {
                        rise12 = parsed;
                        pitchDeg = Math.atan(rise12 / 12) * (180 / Math.PI);
                        usedOverride = true;
                    }
                }

                if (!usedOverride) {
                    const rise = getFacePitchRise12(f, mPerPx);
                    rise12 = Number.isFinite(rise) ? rise : 0;
                    if (rise12 < 0) rise12 = Math.abs(rise12);
                    pitchDeg = Math.atan((rise12 / 12)) * (180 / Math.PI);
                }

                const areaSq = (areaM2 / Math.cos(pitchDeg * (Math.PI / 180))) * 10.7639 / 100;
                layerAreaSq += areaSq;
            });

            const layerTotals = {};
            layerLines.forEach(item => {
                if (!layerTotals[item.type]) layerTotals[item.type] = 0;
                layerTotals[item.type] += item.length;
            });

            doc.setFontSize(9);
            const innerLeft  = marginLeft + pad;
            const innerRight = marginLeft + availableW - pad;

            let lyCursor = bottomBoxY + 16;
            const wasteFactor = 1 + ((typeof state.manualWastePct === 'number' ? state.manualWastePct : 10) / 100);

            doc.setFont("Montserrat", "bold");
            const c1 = innerLeft;                 
            const c2 = innerLeft + 34;            
            const c3 = innerLeft + 90;            

            doc.text(`Facets: ${layerFacetCount}`, c1, lyCursor);
            doc.text(`Squares Without Waste: ${Math.round(layerAreaSq * 10) / 10}`, c2, lyCursor);
            doc.text(`Squares With Waste: ${Math.round(layerAreaSq * wasteFactor * 10) / 10}`, c3, lyCursor);

            doc.setFont("Montserrat", "normal");
            lyCursor += 8;

            doc.setDrawColor(220);
            doc.line(innerLeft, lyCursor - 4, innerRight, lyCursor - 4);

            const itemGap = 8;
            let flowX = innerLeft;

            Object.keys(layerTotals).forEach((type) => {
                if (type === 'unknown' || type === 'skylight' || type === 'chimney_edge' || type === 'chimney_back' || type === 'chimney_front') return;
                const val = Math.round(layerTotals[type]);
                const label = `${formatLineType(type)}: ${val}'`;
                const textW = doc.getTextWidth(label);

                if (flowX + textW > innerRight && flowX > innerLeft) {
                    flowX = innerLeft;
                    lyCursor += 8;
                }

                doc.text(label, flowX, lyCursor);
                flowX += textW + itemGap;
            });
        }
    }

    // Structures
    const rawStructures = state.structures || [];
    const effectiveStructures = getEffectiveStructures(rawStructures, state.structureSettings || {});
    const forceStructurePreviewPage = !!(s.page_structures_preview === true && rawStructures.length > 1);
    const structuresForPage = (effectiveStructures && effectiveStructures.length > 1)
        ? effectiveStructures
        : (forceStructurePreviewPage ? getEffectiveStructures(rawStructures, {}) : []);
    if (structuresForPage && structuresForPage.length > 1) {
        const total = structuresForPage.length;
        const perPage = (total === 4) ? 2 : 3;
        const chunks = [];
        for (let i = 0; i < total; i += perPage) {
            chunks.push(structuresForPage.slice(i, i + perPage));
        }

        for (let ci = 0; ci < chunks.length; ci++) {
            const subtitle = chunks.length > 1
                ? `Structure Breakdown (${ci + 1} of ${chunks.length})`
                : "Structure Breakdown";
            beginReportPage(subtitle);
            await drawStructuresBatch(doc, chunks[ci], state, marginLeft, 35, availableW, pageHeight - 65);
        }
    }

    // Summary
    if (s.page_summary) {
        if (updateStatusCallback) updateStatusCallback("Generating Summary Page...");
        beginReportPage("Project Summary");
        emitPdfDebug('page:summary', {
            mode,
            page: pageCount,
            summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
        });
        const monoCanvas = await createReliableSummaryCanvasFromState(state);
        const monoImg = monoCanvas.toDataURL('image/jpeg', 0.40);
        await drawSummaryPageLayout(doc, state.report, monoImg, imgRatio, marginLeft, 30, availableW, state.manualTotalFacets, state.manualWastePct);
    }

    // ==========================================
    // MATERIALS — SPLIT BY PITCH: STEEP vs FLAT
    // ==========================================
    if (s.page_materials) {
        const pitchSplit = splitSquaresByPitch(state.report.materials.squares || {}, 2);
        const hasSteep = pitchSplit.steepTotal > 0;
        const hasFlat  = pitchSplit.flatTotal > 0;

        if (hasSteep) {
            const steepTitle = hasFlat ? "Steep-Slope Materials" : "Materials";
            beginReportPage(steepTitle);

            const matEst = estimateMaterials(state.report, hasFlat ? pitchSplit : null);

            const extraPages = drawMaterialTable(
                doc, matEst, marginLeft, 40, availableW,
                "",
                state.manualTotalFacets, state.manualWastePct,
                { logoData, pageNum: pageCount, address: state.address, brandingColors, pageTitle: steepTitle, dateLabel: state.pdfRenderDateLabel }
            );
            pageCount += extraPages;
        }

        if (hasFlat) {
            const flatTitle = hasSteep ? "Flat Roof Materials" : "Materials";
            beginReportPage(flatTitle);

            const flatEst = estimateFlatMaterials(pitchSplit.flatTotal, state.report);

            const flatExtraPages = drawFlatMaterialTable(
                doc, flatEst, marginLeft, 40, availableW,
                state.manualWastePct,
                { logoData, pageNum: pageCount, address: state.address, brandingColors, dateLabel: state.pdfRenderDateLabel }
            );
            pageCount += flatExtraPages;
        }
    }

    // Ventilation
    if (s.page_ventilation) {
        const includeVent = !(state.ventSettings && state.ventSettings.include === false);
        if (includeVent) {
            beginReportPage("Ventilation");
            const matEst = estimateMaterials(state.report);
            emitPdfDebug('page:ventilation', {
                mode,
                page: pageCount,
                ventilation: {
                    estimatedRoofSquares: roundPdfDebugValue(state.report?.materials?.totalSquares),
                    estimatedRoofSqFt: roundPdfDebugValue((Number(state.report?.materials?.totalSquares) || 0) * 100, 2),
                    estimatedFootprintSqFt: roundPdfDebugValue(state.report?.materials?.totalFootprintSqFt, 2),
                    estimatedAtticAreaSqFt: roundPdfDebugValue(state.report?.materials?.atticAreaSqFt, 2)
                },
                summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
            });
            await drawVentilationPage(doc, state.report, matEst, marginLeft, 35, availableW, state);
        }
    }

    // Gutters
    if (s.page_gutters) {
        const gutterMetrics = buildPdfGutterMetrics(state);
        if (gutterMetrics.eaveLines.length > 0) {
            if (updateStatusCallback) updateStatusCallback("Generating Gutter Page...");
            beginReportPage("Gutters");
            await drawGutterPage(doc, state, gutterMetrics, marginLeft, 35, availableW, pageHeight - 60, brandingColors);
        }
    }

    // ==========================================
    // NOTES PAGE
    // ==========================================
    if (s.page_notes) {
        if (updateStatusCallback) updateStatusCallback("Generating Notes Page...");
        beginReportPage("Notes");

        if (!outlineImg) {
            const outlineCanvas = await createFacetCanvasFromState(state, 'OUTLINE');
            outlineImg = outlineCanvas.toDataURL('image/jpeg', 0.40);
        }
        let notesDiagramImg = outlineImg;
        try {
            const notesDiagramCanvas = await createNotesFacetReferenceCanvasFromState(state);
            notesDiagramImg = notesDiagramCanvas.toDataURL('image/jpeg', 0.40);
        } catch (e) {
            console.warn('[PDF] Failed to draw notes facet reference labels; using plain outline.', e);
        }

        await drawNotesPage(doc, state, notesDiagramImg, imgRatio, marginLeft, 35, availableW, pageHeight - 50, brandingColors);
    }


    // ==========================================
    // UPLOAD / SAVE
    // ==========================================
    if (updateStatusCallback) updateStatusCallback(`Uploading ${mode}...`);
    
    const safeAddress = String(state.address || "Project")
        .replace(/,/g, '')
        .replace(/\./g, '')
        .replace(/\s+/g, ' ')
        .replace(/[/\\?%*:|"<>]/g, '-')
        .trim();

    const filename = runtimeOptions.outputFileName || ((mode === 'summary') ? `Summary - ${safeAddress}.pdf` : `Report - ${safeAddress}.pdf`);
    const pdfBlob = doc.output('blob');
    console.log(`[PDF-SIZE] TOTAL: ${Math.round(pdfBlob.size / 1024)} KB`);
    emitPdfDebug('generate:complete', {
        mode,
        filename,
        pdfSizeKb: Math.round(pdfBlob.size / 1024),
        summary: buildPdfDebugSummary(state, state.report, { includeFaces: false })
    });

    try {
        if (!runtimeOptions.skipUpload) {
            await window.firstMeasureUploadArtifact(
                state.folderId,
                pdfBlob,
                mode === 'summary' ? 'Summary.pdf' : 'Report.pdf'
            );
            
            if (mode === 'full' && !runtimeOptions.skipStatusUpdate) {
                await window.firstMeasureSetProjectStatus(state.folderId, 'awaiting_review');
            }
        }
    } catch (e) {
        console.error(`Failed to upload ${mode} report:`, e);
    }

    window.__pdfBrandingColorOverride = null;
    window.__pdfForceDefaultBoxes = false;
    window.PDF_DIAGRAM_FONT_SCALE = previousDiagramFontScale;
    window.PDF_MEASUREMENT_FONT_SCALE = previousMeasurementFontScale;

    return { blob: pdfBlob, filename };
}
window.generatePDFFromState = generatePDFFromState;



function triggerBlobDownload(blob, filename) {
    return new Promise(resolve => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            resolve();
        }, 500);
    });
}
window.triggerBlobDownload = triggerBlobDownload;

// Draws a "summary-style" card (shadow + rounded border) WITHOUT the left color strip.
function drawPdfCard(doc, x, y, w, h, radius = 3) {
    // Shadow
    doc.setFillColor(230, 230, 230);
    doc.roundedRect(x + 1.5, y + 1.5, w, h, radius, radius, 'F');

    // Card + border
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, radius, radius, 'FD');
}


// --- UPDATED: Dynamic Cover Page (Summary Only) ---
function drawDynamicCoverPage(doc, state, settings, x, y, w, h) {
    const showCustomer = settings.cover_show_customer;
    const showStats = (settings.cover_show_squares || settings.cover_show_waste || settings.cover_show_pitch || settings.cover_show_facets);
    const showLines = settings.cover_show_breakdown;

    // --- COLOR SETUP ---
    let pColor = { r: 200, g: 40, b: 40 }; 
    if (window.projectOrganization && window.projectOrganization.branding && window.projectOrganization.branding.colors) {
        const c = window.projectOrganization.branding.colors.primary;
        if (c) {
            const hex = c.replace('#','');
            pColor = {
                r: parseInt(hex.substring(0,2), 16),
                g: parseInt(hex.substring(2,4), 16),
                b: parseInt(hex.substring(4,6), 16)
            };
        }
    }
    // Override from per-report branding
    if (state.brandingOverrides && state.brandingOverrides.primaryColor) {
        pColor = hexToRgbReport(state.brandingOverrides.primaryColor);
    }

    const gap = 8;
    let leftW = 0;
    let rightW = 0;
    let rightX = x;

    if (showCustomer) {
        leftW = (w * 0.4) - (gap / 2);
        rightW = (w * 0.6) - (gap / 2);
        rightX = x + leftW + gap;
        if (!showStats && !showLines) leftW = w;
    } else {
        rightW = w;
        rightX = x;
    }

    const drawStyledBox = (bx, by, bw, bh, title) => {
        doc.setFillColor(230, 230, 230);
        doc.roundedRect(bx + 1.5, by + 1.5, bw, bh, 3, 3, 'F');

        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.3);
        doc.roundedRect(bx, by, bw, bh, 3, 3, 'FD');

        doc.setFillColor(pColor.r, pColor.g, pColor.b);
        
        const r = 3;         
        const wStrip = 2.0; 
        const k = r * 0.55228;

        doc.lines(
            [
                [-(wStrip - r), 0], 
                [-k, 0, -r, r - k, -r, r],
                [0, bh - (2 * r)],
                [0, k, r - k, r, r, r],
                [(wStrip - r), 0],
                [0, -bh]
            ], 
            bx + wStrip, by,
            [1, 1], 
            'F', 
            false 
        );

        if (title) {
            doc.setFontSize(9);
            doc.setTextColor(150); 
            doc.setFont("Montserrat", "bold");
            doc.text(title.toUpperCase(), bx + 8, by + 7);
        }
    };

    // --- LEFT BOX: Prepared For ---
    if (showCustomer) {
        drawStyledBox(x, y, leftW, h, "Prepared For");
        
        doc.setFontSize(11);
        doc.setTextColor(50);
        doc.setFont("Montserrat", "bold");
        
        const rName = (state.report && state.report.resident && state.report.resident.name) ? state.report.resident.name : "Homeowner";
        const rEmail = (state.report && state.report.resident && state.report.resident.email) ? state.report.resident.email : "";
        const rawPhone = (state.report && state.report.resident && state.report.resident.phone) ? state.report.resident.phone : "";
        const rPhone = formatPhone(rawPhone);

        let cy = y + 14; 
        const nameLines = doc.splitTextToSize(rName, leftW - 16);
        doc.text(nameLines, x + 8, cy);
        cy += (nameLines.length - 1) * 5;
        
        doc.setFont("Montserrat", "normal");
        doc.setFontSize(10);
        
        if(state.address) {
            cy += 5;
            const splitAddr = doc.splitTextToSize(state.address, leftW - 16);
            doc.text(splitAddr, x + 8, cy);
            cy += (splitAddr.length * 4);
        }

        cy += 2;
        doc.setFontSize(9);
        doc.setTextColor(80);
        
        if (rPhone) { doc.text(rPhone, x + 8, cy); cy += 5; }
        if (rEmail) { doc.text(rEmail, x + 8, cy); }
    }

    // --- RIGHT BOX: Roof Measurements ---
    if (showStats || showLines) {
        drawStyledBox(rightX, y, rightW, h, "Roof Measurements");
        
        const boxPad = 8;
        let leftColX = rightX + boxPad;
        let rightColX;
        if (showStats && showLines) {
            rightColX = rightX + (rightW * 0.62);
        } else {
            rightColX = rightX + boxPad;
        }
 
        if (showStats) {
            let cy = y + 14;
            const netSquares = state.report.materials.totalSquares || 0;
            const wastePct = (typeof state.manualWastePct === 'number') ? state.manualWastePct : 10;
            const wasteSquares = netSquares * (1 + (wastePct / 100));
            
            if (settings.cover_show_squares) {
                const val = settings.cover_show_waste ? wasteSquares : netSquares;
                doc.setFontSize(10);
                doc.setTextColor(50);
                doc.setFont("Montserrat", "bold");
                doc.text(
                    settings.cover_show_waste
                        ? `Total Squares (+${wastePct}% Waste)`
                        : "Total Squares",
                    leftColX,
                    cy
                );
                
                cy += 9;
                doc.setFontSize(28); 
                doc.setTextColor(pColor.r, pColor.g, pColor.b);
                doc.text(`${Math.round(val * 100) / 100}`, leftColX, cy);
                
                cy += 7;
            }

            doc.setFontSize(9);
            doc.setTextColor(80);
            doc.setFont("Montserrat", "normal");
            const statLineH = 4.5;

            if (settings.cover_show_pitch) {
                let domPitch = "N/A";
                let maxArea = -1;
                const squaresData = state.report.materials.squares || {};
                Object.keys(squaresData).forEach(p => {
                    const val = squaresData[p];
                    if (typeof val === 'number' && val > maxArea) { maxArea = val; domPitch = p; }
                });
                doc.text(`Pitch: ${domPitch}`, leftColX, cy); cy += statLineH;
            }
            if (settings.cover_show_waste) {
                doc.text(`Waste: ${wastePct}%`, leftColX, cy); cy += statLineH;
            }
            if (settings.cover_show_facets) {
                doc.text(`Facets: ${state.manualTotalFacets}`, leftColX, cy);
            }
        }

        if (showLines) {
            let cy = y + 14;
            const lin = state.report.materials.linear || {};

            const types = [
                { key: 'ridge',     label: 'Ridge' },
                { key: 'hip',       label: 'Hip' },
                { key: 'valley',    label: 'Valley' },
                { key: 'rake',      label: 'Rake' },
                { key: 'eave',      label: 'Eave' },
                { key: 'head_wall', label: 'Headwall' },
                { key: 'side_wall', label: 'Sidewall' },
                { key: 'trans',     label: 'Transition' },
                { key: 'parapet',   label: 'Parapet' }
            ];

            doc.setFontSize(9);
            const lineH = 5;

            types.forEach(t => {
                const matchKey = Object.keys(lin).find(k => k.toLowerCase().includes(t.key));
                const val = matchKey ? Math.round(lin[matchKey]) : 0;
                if (val > 0) {
                    doc.setTextColor(80);
                    doc.setFont("Montserrat", "normal");
                    doc.text(t.label, rightColX + 2, cy);

                    doc.setTextColor(0);
                    doc.setFont("Montserrat", "bold");
                    doc.text(`${val}'`, rightX + rightW - boxPad, cy, { align: 'right' });

                    cy += lineH;
                }
            });
        }
    }
}



window.generatePDFFromState = generatePDFFromState;



function getPdfDominantPitchLabel(squaresData) {
  if (!squaresData || typeof squaresData !== 'object') return "N/A";

  let domPitch = "N/A";
  let maxArea = -1;
  Object.keys(squaresData).forEach((pitch) => {
    const value = Number(squaresData[pitch]);
    if (!Number.isFinite(value) || value <= maxArea) return;
    maxArea = value;
    domPitch = pitch;
  });

  return domPitch;
}

function getPdfStructureFaceRowIndex(state) {
  if (state && state.__pdfStructureFaceRowIndex instanceof Map) {
    return state.__pdfStructureFaceRowIndex;
  }

  const index = new Map();
  const rows = collectPdfFaceDebugRows(state, state && state.report ? state.report : null);
  rows.forEach((row) => {
    if (!row || !row.signature) return;
    index.set(row.signature, row);
  });

  if (state && typeof state === 'object') {
    state.__pdfStructureFaceRowIndex = index;
  }

  return index;
}

function getPdfStructureMetrics(state, structure) {
  const rowIndex = getPdfStructureFaceRowIndex(state);
  const pitchSquares = {};
  let netSqFt = 0;
  let footprintSqFt = 0;
  let activeFaceCount = 0;
  const seenSignatures = new Set();

  (structure && Array.isArray(structure.faces) ? structure.faces : []).forEach((face) => {
    const signature = (typeof getLocalFaceSignatureReport === 'function')
      ? getLocalFaceSignatureReport(face.points)
      : window.getLocalFaceSignatureReport(face.points);
    if (!signature || seenSignatures.has(signature)) return;
    seenSignatures.add(signature);

    const row = rowIndex.get(signature);
    if (!row) return;

    const sqFt = Number(row.sq_ft) || 0;
    const squares = Number(row.squares) || 0;
    netSqFt += sqFt;
    footprintSqFt += Number(row.footprint_sq_ft) || 0;
    activeFaceCount++;

    if (!pitchSquares[row.pitch_label]) pitchSquares[row.pitch_label] = 0;
    pitchSquares[row.pitch_label] += squares;
  });

  return {
    activeFaceCount,
    netSqFt,
    netSquares: netSqFt / 100,
    footprintSqFt,
    pitchSquares,
    predominantPitch: getPdfDominantPitchLabel(pitchSquares)
  };
}

function getPdfLinePointPair(line) {
  if (Array.isArray(line?.points) && line.points.length >= 2) return [line.points[0], line.points[1]];
  if (line?.start && line?.end) return [line.start, line.end];
  if (line?.conn?.start && line?.conn?.end) return [line.conn.start, line.conn.end];
  return [null, null];
}

function getPdfLineEndpointKey(a, b) {
  if (!a || !b) return '';
  const pointKey = (p) => {
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
    return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  };
  const ak = pointKey(a);
  const bk = pointKey(b);
  if (!ak || !bk) return '';
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function getPdfReportLineLengthIndex(state) {
  if (state && state.__pdfReportLineLengthIndex instanceof Map) {
    return state.__pdfReportLineLengthIndex;
  }

  const index = new Map();
  const lines = Array.isArray(state?.report?.lines) ? state.report.lines : [];
  lines.forEach((line) => {
    const [start, end] = getPdfLinePointPair(line);
    const key = getPdfLineEndpointKey(start, end);
    const lengthFt = Number(line?.length_ft ?? line?.lengthFt ?? line?.feet ?? line?.ft ?? line?.length);
    if (!key || !Number.isFinite(lengthFt) || lengthFt < 0) return;

    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      type: String(line?.type || '').toLowerCase(),
      lengthFt
    });
  });

  if (state && typeof state === 'object') {
    state.__pdfReportLineLengthIndex = index;
  }

  return index;
}

function findPdfNearestReportLineMeasurement(state, line) {
  const [start, end] = getPdfLinePointPair(line);
  if (!start || !end) return null;

  const lineType = String(line?.type || '').toLowerCase();
  const structureMidX = ((Number(start.x) || 0) + (Number(end.x) || 0)) / 2;
  const structureMidY = ((Number(start.y) || 0) + (Number(end.y) || 0)) / 2;
  const structureLenPx = Math.hypot(
    (Number(end.x) || 0) - (Number(start.x) || 0),
    (Number(end.y) || 0) - (Number(start.y) || 0)
  );

  let best = null;
  const lines = Array.isArray(state?.report?.lines) ? state.report.lines : [];
  lines.forEach((reportLine) => {
    const reportType = String(reportLine?.type || '').toLowerCase();
    if (lineType && reportType && lineType !== reportType) return;

    const [reportStart, reportEnd] = getPdfLinePointPair(reportLine);
    if (!reportStart || !reportEnd) return;

    const lengthFt = Number(reportLine?.length_ft ?? reportLine?.lengthFt ?? reportLine?.feet ?? reportLine?.ft ?? reportLine?.length);
    if (!Number.isFinite(lengthFt) || lengthFt < 0) return;

    const reportMidX = ((Number(reportStart.x) || 0) + (Number(reportEnd.x) || 0)) / 2;
    const reportMidY = ((Number(reportStart.y) || 0) + (Number(reportEnd.y) || 0)) / 2;
    const reportLenPx = Math.hypot(
      (Number(reportEnd.x) || 0) - (Number(reportStart.x) || 0),
      (Number(reportEnd.y) || 0) - (Number(reportStart.y) || 0)
    );

    const midpointDelta = Math.hypot(structureMidX - reportMidX, structureMidY - reportMidY);
    const lengthDelta = Math.abs(structureLenPx - reportLenPx);
    const tolerance = Math.max(2, Math.min(20, Math.max(structureLenPx, reportLenPx) * 0.02));
    if (midpointDelta > tolerance || lengthDelta > tolerance) return;

    const score = midpointDelta + lengthDelta;
    if (!best || score < best.score) {
      best = {
        score,
        type: reportType || lineType,
        lengthFt
      };
    }
  });

  return best;
}

function getPdfStructureLineMeasurement(state, line, mPerPx) {
  const [start, end] = getPdfLinePointPair(line);
  const key = getPdfLineEndpointKey(start, end);
  const reportMatches = key ? getPdfReportLineLengthIndex(state).get(key) : null;
  if (Array.isArray(reportMatches) && reportMatches.length) {
    const lineType = String(line?.type || '').toLowerCase();
    const typeMatch = reportMatches.find((item) => item.type && lineType && item.type === lineType);
    const match = typeMatch || reportMatches[0];
    return {
      type: match.type || lineType,
      lengthFt: match.lengthFt
    };
  }

  const nearestReportLine = findPdfNearestReportLineMeasurement(state, line);
  if (nearestReportLine) {
    return {
      type: nearestReportLine.type,
      lengthFt: nearestReportLine.lengthFt
    };
  }

  const hasReportLines = Array.isArray(state?.report?.lines) && state.report.lines.length;
  const hasLinearTotals = !!(state?.report?.materials?.linear && typeof state.report.materials.linear === 'object');
  if (hasReportLines || hasLinearTotals) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[PDF] Structure line missing finalized report measurement; omitting from structure totals.', {
        type: line?.type || '',
        key
      });
    }
    return {
      type: String(line?.type || '').toLowerCase(),
      lengthFt: 0
    };
  }

  if (!start || !end) {
    return {
      type: String(line?.type || '').toLowerCase(),
      lengthFt: 0
    };
  }

  const dx = ((Number(end.x) || 0) - (Number(start.x) || 0)) * mPerPx;
  const dy = ((Number(end.y) || 0) - (Number(start.y) || 0)) * mPerPx;
  const dz = (Number(start.z) || 0) - (Number(end.z) || 0);
  return {
    type: String(line?.type || '').toLowerCase(),
    lengthFt: Math.sqrt(dx*dx + dy*dy + dz*dz) * 3.28084
  };
}

async function drawStructuresBatch(doc, structs, state, x, y, w, h) {
  const count = structs.length;
  const maxCols = Math.min(count, 3); // never more than 3 columns
  const colGap = 10;
  const colW = (w - (colGap * (maxCols - 1))) / maxCols;
  let currX = x;
  const wastePct = state.manualWastePct || 10;
  const mPerPx = getPdfMetersPerPx(state);
  
  for (let i = 0; i < count; i++) {
    const s = structs[i];
    doc.setFillColor(245, 245, 245);
    doc.rect(currX, y, colW, 8, 'F');
    doc.setDrawColor(200);
    doc.rect(currX, y, colW, h, 'S');
    
    let titleLabel = `Structure ${s.id}`;
    doc.setFontSize(9);
    doc.setFont("Montserrat", "bold");
    doc.setTextColor(50);
    doc.text(titleLabel, currX + colW/2, y + 5.5, { align: 'center' });
    
    const canvas = await createStructureCanvas(state, s);
    const imgData = canvas.toDataURL('image/jpeg', 0.40);
    const maxImgH = 65;
    const sRatio = canvas.width / canvas.height;
    let pW = colW - 6;
    let pH = pW / sRatio;
    if (pH > maxImgH) { pH = maxImgH; pW = pH * sRatio; }
    const imgY = y + 12;
    doc.addImage(imgData, 'JPEG', currX + 3 + (colW - 6 - pW)/2, imgY, pW, pH);
    
    const structureMetrics = getPdfStructureMetrics(state, s);
    const sSqFt = Math.round(structureMetrics.netSqFt || 0);
    const sSquaresWaste = Math.ceil((structureMetrics.netSquares || 0) * (1 + wastePct/100));

    const stats = { Eaves:0, Rakes:0, Ridges:0, Hips:0, Valleys:0, Trans:0 };
    let skylights = 0, chimneys = 0;
    if (s.lines) {
      s.lines.forEach(l => {
        const measurement = getPdfStructureLineMeasurement(state, l, mPerPx);
        const lenFt = measurement.lengthFt;
        const t = measurement.type;
        if (t.includes('eave')) stats.Eaves += lenFt;
        else if (t.includes('rake')) stats.Rakes += lenFt;
        else if (t.includes('ridge')) stats.Ridges += lenFt;
        else if (t.includes('hip')) stats.Hips += lenFt;
        else if (t.includes('valley')) stats.Valleys += lenFt;
        else if (t.includes('step') || t.includes('wall') || t.includes('trans')) stats.Trans += lenFt;
        else if (t.includes('skylight')) skylights += 0.25;
        else if (t.includes('chimney')) chimneys += 0.25;
      });
    }
    
    let statsY = imgY + maxImgH + 8;
    doc.setDrawColor(220);
    doc.setLineWidth(0.5);
    doc.line(currX + 3, statsY, currX + colW - 3, statsY);
    statsY += 5;
    doc.setFontSize(8);
    
    const drawRow = (lbl, val, bold=false, color="#000000") => {
      doc.setFont("Montserrat", "normal");
      doc.setTextColor(80);
      doc.text(lbl, currX + 5, statsY);
      doc.setFont("Montserrat", bold ? "bold" : "normal");
      doc.setTextColor(color);
      doc.text(val, currX + colW - 5, statsY, { align: 'right' });
      statsY += 4.5;
    };
    
    drawRow("Facets:", String(structureMetrics.activeFaceCount || 0));
    drawRow("Pitch:", structureMetrics.predominantPitch || "N/A");
    drawRow("Square Feet:", sSqFt.toLocaleString());
    drawRow(`Squares with Waste (${wastePct}%):`, sSquaresWaste.toLocaleString(), true, "#d93025");
    statsY += 2;
    if (Math.round(stats.Eaves) > 0)   drawRow("Eaves:", Math.round(stats.Eaves)+"'");
    if (Math.round(stats.Rakes) > 0)   drawRow("Rakes:", Math.round(stats.Rakes)+"'");
    if (Math.round(stats.Ridges) > 0)  drawRow("Ridges:", Math.round(stats.Ridges)+"'");
    if (Math.round(stats.Hips) > 0)    drawRow("Hips:", Math.round(stats.Hips)+"'");
    if (Math.round(stats.Valleys) > 0) drawRow("Valleys:", Math.round(stats.Valleys)+"'");
    if (Math.round(stats.Trans) > 0)   drawRow("Transitions:", Math.round(stats.Trans)+"'");
    statsY += 2;
    if (Math.round(skylights) > 0) drawRow("Skylights:", Math.round(skylights).toString());
    if (Math.round(chimneys) > 0)  drawRow("Chimneys:", Math.round(chimneys).toString());
    
    currX += colW + colGap;
  }
}


function getEffectiveStructures(rawStructs, settings) {
    if (!settings || !rawStructs || rawStructs.length === 0) return rawStructs.map(s => ({ ...s, originalIds: [s.id] }));

    // Determine which IDs are hidden or being merged away
    const hiddenIds = new Set();
    const mergeMap = new Map(); // sourceId -> targetId

    rawStructs.forEach(s => {
        const cfg = settings[s.id];
        if (!cfg) return;
        if (cfg.hidden) hiddenIds.add(s.id);
        if (cfg.mergeTarget) {
            const targetId = parseInt(cfg.mergeTarget);
            if (Number.isFinite(targetId) && targetId !== s.id) {
                mergeMap.set(s.id, targetId);
            }
        }
    });

    // Build effective list: start with non-hidden, non-merged-away structures
    const byId = new Map();
    rawStructs.forEach(s => byId.set(s.id, s));

    const effective = new Map(); // targetId -> combined structure

    rawStructs.forEach(s => {
        if (hiddenIds.has(s.id)) return;
        if (mergeMap.has(s.id)) return; // this one merges into something else

        // Clone as base
        effective.set(s.id, {
            id: s.id,
            faces: [...(s.faces || [])],
            lines: [...(s.lines || [])],
            bounds: s.bounds ? { ...s.bounds } : null,
            originalIds: [s.id]
        });
    });

    // Merge sources into their targets
    mergeMap.forEach((targetId, sourceId) => {
        if (hiddenIds.has(sourceId)) return;
        const target = effective.get(targetId);
        const source = byId.get(sourceId);
        if (!target || !source) return;

        target.originalIds.push(sourceId);
        if (source.faces) target.faces.push(...source.faces);
        if (source.lines) target.lines.push(...source.lines);

        // Expand bounds
        if (source.bounds && target.bounds) {
            const tb = target.bounds;
            const sb = source.bounds;
            const newMinX = Math.min(tb.minX, sb.minX);
            const newMinY = Math.min(tb.minY, sb.minY);
            const newMaxX = Math.max(tb.minX + tb.width, sb.minX + sb.width);
            const newMaxY = Math.max(tb.minY + tb.height, sb.minY + sb.height);
            tb.minX = newMinX;
            tb.minY = newMinY;
            tb.width = newMaxX - newMinX;
            tb.height = newMaxY - newMinY;
        } else if (source.bounds && !target.bounds) {
            target.bounds = { ...source.bounds };
        }
    });

    return Array.from(effective.values());
}
window.getEffectiveStructures = getEffectiveStructures;


// --------------------------------------------------------
// UPDATED HELPER: Fixed Resolution for Uniform Line Density
// --------------------------------------------------------
async function createStructureCanvas(state, structure) {
    const TARGET_WIDTH = 1200; 
    const padding = 20; 
    
    const b = structure.bounds;
    // Guard against empty structures
    if (!b || b.width <= 0) {
        const c = document.createElement('canvas'); c.width=100; c.height=100; return c;
    }

    const w = b.width + padding * 2;
    const h = b.height + padding * 2;
    
    const aspect = w / h;
    const canvasH = TARGET_WIDTH / aspect;
    
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    
    const scaleFactor = TARGET_WIDTH / w;
    ctx.scale(scaleFactor, scaleFactor);
    ctx.translate(-b.minX + padding, -b.minY + padding);
    
    // BG
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(b.minX - padding, b.minY - padding, w, h);
    
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Faces
    if (structure.faces) {
        structure.faces.forEach(face => {
            ctx.beginPath();
            ctx.moveTo(face.points[0].x, face.points[0].y);
            for(let i=1; i<face.points.length; i++) ctx.lineTo(face.points[i].x, face.points[i].y);
            ctx.closePath();
            const isObs = isObstacleFace(face, state.report);
            ctx.fillStyle = isObs ? '#f5f5f5' : '#eeeeee';
            ctx.fill();
        });
    }
    
    // Lines
    const VISUAL_THICKNESS = 6; 
    const worldThickness = VISUAL_THICKNESS / scaleFactor;

    if (structure.lines) {
        structure.lines.forEach(l => {
            ctx.beginPath();
            ctx.moveTo(l.start.x, l.start.y);
            ctx.lineTo(l.end.x, l.end.y);
            ctx.strokeStyle = '#000000'; // Black
            ctx.lineWidth = worldThickness; // Uniform
            ctx.stroke();
        });
    }
    
    return canvas;
}


function summarizeObstacleDims(layerLines) {
  const out = {
    skylights: new Map(),
    chimneys: new Map()
  };

  const clusterDims = (lines, fallbackLabel) => {
    const clusters = groupSkylightsCorrectly(lines);
    return clusters.map(c => {
      const lengths = c.map(l => Math.round(l.length || 0)).filter(n => n > 0);
      const unique = [...new Set(lengths)].sort((a,b)=>a-b);
      let dimStr = fallbackLabel;
      if (unique.length === 1) dimStr = `${unique[0]}'`;
      if (unique.length >= 2) dimStr = `${unique[0]}'x${unique[unique.length-1]}'`;
      return dimStr;
    });
  };

  const skylightDims = clusterDims(layerLines.filter(l => l.type === 'skylight'), 'SKY');
  skylightDims.forEach(d => out.skylights.set(d, (out.skylights.get(d) || 0) + 1));

  const chimneyDims = clusterDims(layerLines.filter(l => l.type === 'chimney_edge' || l.type === 'chimney_back' || l.type === 'chimney_front'), 'CHIM');
  chimneyDims.forEach(d => out.chimneys.set(d, (out.chimneys.get(d) || 0) + 1));

  return out;
}

// ==========================================
// --- 3. DIAGRAM CANVAS HELPERS (UPDATED) ---
// ==========================================

function getPdfDiagramScaleSetting(state = null, fallback = 1.0) {
    const fromState = Number(state && state.diagramFontScale);
    if (Number.isFinite(fromState) && fromState > 0) return fromState;
    const fromWindow = Number(window.PDF_DIAGRAM_FONT_SCALE);
    if (Number.isFinite(fromWindow) && fromWindow > 0) return fromWindow;
    return fallback;
}

function getPdfCanvasRelativeLabelScale(canvasWidth, canvasHeight, baselineWidth = 2000) {
    const w = Math.max(1, Number(canvasWidth) || baselineWidth);
    const h = Math.max(1, Number(canvasHeight) || w);
    return Math.max(1, Math.max(w, h) / Math.max(1, baselineWidth));
}


async function createFacetCanvasFromState(state, mode, layerFilter = null) {
    // mode: 'OUTLINE' | 'BASE' | 'PITCH' | 'AREA'
    const extraPadPdf = state.editorCropPadding || 0;
    const crop = {
        minX: state.cropRegion.minX - extraPadPdf,
        minY: state.cropRegion.minY - extraPadPdf,
        width: state.cropRegion.width + extraPadPdf * 2,
        height: state.cropRegion.height + extraPadPdf * 2
    };


    // --- STANDARDIZATION LOGIC (High-Res & Legible) ---
    const TARGET_WIDTH = 2000; // Increased resolution
    const scale = TARGET_WIDTH / crop.width;
    const invScale = 1 / scale;
    const targetHeight = crop.height * scale;
    const labelRelativeScale = getPdfCanvasRelativeLabelScale(TARGET_WIDTH, targetHeight, TARGET_WIDTH);

    // Definitions relative to the 2000px canvas
    // We boost these so they remain visible when downscaled to PDF
    const LINE_THICKNESS_GRAY  = 5.0 * invScale; 
    const LINE_THICKNESS_BLACK = 7.0 * invScale; 
    const LINE_THICKNESS_THIN  = 3.0 * invScale;
    
    // Font size tracks the rendered diagram/page, not the roof footprint.
    const FONT_SIZE_PX = 40 * labelRelativeScale * invScale * getPdfDiagramScaleSetting(state);

    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // Apply the scaling transform so coordinates match the geometry
    ctx.scale(scale, scale);
    ctx.translate(-crop.minX, -crop.minY);

    // 1. Draw Background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(crop.minX, crop.minY, crop.width, crop.height);

    // 2. Prepare Geometry (faces only; obstacles excluded from faces)
    const excludedFaceSignatures = getReportExcludedSignatureSet(state);
    const autoExcludedFaceIndexes = getReportAutoExcludedFaceIndexSet(state);
    let faces = (state.facesData || [])
        .filter((f, faceIndex) => {
            if (!f || !Array.isArray(f.points)) return false;
            if (autoExcludedFaceIndexes.has(faceIndex)) return false;
            if (isObstacleFace(f, state.report)) return false;
            const sig = getLocalFaceSignatureReport(f.points);
            return !excludedFaceSignatures.has(sig);
        })
        .map(f => ({
            ...f,
            points: f.points.map(p => ({ x: p.x, y: p.y, z: (p.z !== null ? p.z : 0) })),
            holes: (f.holes || []).map(h => h.map(p => ({ x: p.x, y: p.y, z: (p.z !== null ? p.z : 0) })))
        }));

    if (layerFilter !== null) {
        faces = faces.filter(f => (f.layer || 1) === layerFilter);
    }

    // --- MATH HELPERS ---
    function getPlane(pts) {
        if (pts.length < 3) return null;
        let nx = 0, ny = 0, nz = 0;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < pts.length; i++) {
            const cur = pts[i];
            const nxt = pts[(i + 1) % pts.length];
            nx += (cur.y - nxt.y) * (cur.z + nxt.z);
            ny += (cur.z - nxt.z) * (cur.x + nxt.x);
            nz += (cur.x - nxt.x) * (cur.y + nxt.y);
            cx += cur.x; cy += cur.y; cz += cur.z;
        }
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < 0.0001) return null;
        const a = nx / len, b = ny / len, c = nz / len;
        const d = -(a * (cx / pts.length) + b * (cy / pts.length) + c * (cz / pts.length));
        return { a, b, c, d };
    }

    function getZAt(plane, x, y) {
        if (!plane || Math.abs(plane.c) < 0.001) return -99999;
        return -(plane.a * x + plane.b * y + plane.d) / plane.c;
    }

    function isPointInPoly(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function distToSegSquared(px, py, vx, vy, wx, wy) {
        const l2 = (vx - wx) ** 2 + (vy - wy) ** 2;
        if (l2 === 0) return (px - vx) ** 2 + (py - vy) ** 2;
        let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
        t = Math.max(0, Math.min(1, t));
        const projX = vx + t * (wx - vx);
        const projY = vy + t * (wy - vy);
        return (px - projX) ** 2 + (py - projY) ** 2;
    }

    // Pre-calculate Planes/Bounds
    const renderList = faces.map(f => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, avgZ = 0;
        f.points.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
            avgZ += p.z;
        });
        avgZ /= f.points.length;
        return {
            face: f,
            plane: getPlane(f.points),
            bounds: { minX, maxX, minY, maxY },
            avgZ
        };
    });

    // --- PHASE 1: DRAW FILLS ---
    renderList.sort((a, b) => a.avgZ - b.avgZ);

    renderList.forEach(item => {
        const face = item.face;
        ctx.beginPath();
        ctx.moveTo(face.points[0].x, face.points[0].y);
        for (let i = 1; i < face.points.length; i++) ctx.lineTo(face.points[i].x, face.points[i].y);
        ctx.closePath();

        if (face.holes) {
            face.holes.forEach(h => {
                ctx.moveTo(h[0].x, h[0].y);
                for (let k = 1; k < h.length; k++) ctx.lineTo(h[k].x, h[k].y);
                ctx.closePath();
            });
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
    });

    // --- DRAW ALL LINES (GRAY UNDERLAY) ---
    ctx.lineWidth = LINE_THICKNESS_GRAY;
    ctx.strokeStyle = '#BBBBBB';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    renderList.forEach(item => {
        const pts = item.face.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[0].x, pts[0].y);

        if (item.face.holes) {
            item.face.holes.forEach(h => {
                ctx.moveTo(h[0].x, h[0].y);
                for (let k = 1; k < h.length; k++) ctx.lineTo(h[k].x, h[k].y);
                ctx.lineTo(h[0].x, h[0].y);
            });
        }
    });
    ctx.stroke();

    // --- PHASE 2: RAYCAST VISIBLE LINES ---
    const SEGMENT_LEN = 1.0;
    const Z_BIAS = 0.15;
    let rawSegments = [];

    renderList.forEach(item => {
        const pts = item.face.points;

        const processLoop = (loopPts) => {
            for (let i = 0; i < loopPts.length; i++) {
                const p1 = loopPts[i];
                const p2 = loopPts[(i + 1) % loopPts.length];

                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1e-6) continue;

                const ux = dx / dist;
                const uy = dy / dist;

                let currentDist = 0;
                let activeSegment = null;

                while (currentDist < dist) {
                    const nextDist = Math.min(currentDist + SEGMENT_LEN, dist);
                    const midDist = (currentDist + nextDist) / 2;

                    const sampX = p1.x + ux * midDist;
                    const sampY = p1.y + uy * midDist;
                    const t = midDist / dist;
                    const sampZ = p1.z + (p2.z - p1.z) * t;

                    let isOccluded = false;
                    for (let otherItem of renderList) {
                        if (otherItem === item) continue;
                        const b = otherItem.bounds;
                        if (sampX < b.minX || sampX > b.maxX || sampY < b.minY || sampY > b.maxY) continue;

                        if (isPointInPoly(sampX, sampY, otherItem.face.points)) {
                            const faceZ = getZAt(otherItem.plane, sampX, sampY);
                            if (faceZ > sampZ + Z_BIAS) {
                                let inHole = false;
                                if (otherItem.face.holes) {
                                    for (let h of otherItem.face.holes) {
                                        if (isPointInPoly(sampX, sampY, h)) { inHole = true; break; }
                                    }
                                }
                                if (!inHole) { isOccluded = true; break; }
                            }
                        }
                    }

                    const segStartX = p1.x + ux * currentDist;
                    const segStartY = p1.y + uy * currentDist;
                    const segEndX = p1.x + ux * nextDist;
                    const segEndY = p1.y + uy * nextDist;

                    if (!isOccluded) {
                        if (!activeSegment) {
                            activeSegment = { x1: segStartX, y1: segStartY, x2: segEndX, y2: segEndY };
                        } else {
                            activeSegment.x2 = segEndX;
                            activeSegment.y2 = segEndY;
                        }
                    } else {
                        if (activeSegment) {
                            rawSegments.push(activeSegment);
                            activeSegment = null;
                        }
                    }

                    currentDist = nextDist;
                }

                if (activeSegment) rawSegments.push(activeSegment);
            }
        };

        processLoop(pts);
        if (item.face.holes) item.face.holes.forEach(h => processLoop(h));
    });

    // --- PHASE 3: TOPOLOGY CLEANUP (Pruning) ---
    const CLEAN_MIN_LEN = 10;
    const TOUCH_TOL = 1.5 * 1.5;

    const obstacleConnectors = [];
    try {
        const lines = (state && state.report && Array.isArray(state.report.lines)) ? state.report.lines : [];
        lines.forEach(l => {
            const t = (l.type || '').toLowerCase();
            if (t !== 'skylight' && t !== 'chimney_edge' && t !== 'chimney_back' && t !== 'chimney_front') return;
            const a = l.points?.[0];
            const b = l.points?.[1];
            if (!a || !b) return;
            obstacleConnectors.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        });
    } catch (e) {}

    let activeLines = rawSegments.filter(s => {
        const lx = s.x2 - s.x1, ly = s.y2 - s.y1;
        return (lx * lx + ly * ly) > 0.01;
    });

    const forEachConnector = (cb) => {
        for (let seg of activeLines) cb(seg);
        for (let seg of obstacleConnectors) cb(seg);
    };

    for (let pass = 0; pass < 3; pass++) {
        activeLines = activeLines.filter(s => {
            const lx = s.x2 - s.x1;
            const ly = s.y2 - s.y1;
            const len = Math.sqrt(lx * lx + ly * ly);
            if (len >= CLEAN_MIN_LEN) return true;

            let startConnected = false, endConnected = false;

            forEachConnector(other => {
                if (other === s) return;
                if (!startConnected && distToSegSquared(s.x1, s.y1, other.x1, other.y1, other.x2, other.y2) < TOUCH_TOL) startConnected = true;
                if (!endConnected && distToSegSquared(s.x2, s.y2, other.x1, other.y1, other.x2, other.y2) < TOUCH_TOL) endConnected = true;
            });

            return (startConnected && endConnected);
        });
    }

    // --- PHASE 4: DRAW VISIBLE LINES (BLACK) ---
    ctx.lineWidth = (mode === 'OUTLINE' || mode === 'AREA') ? LINE_THICKNESS_THIN : LINE_THICKNESS_BLACK;
    ctx.strokeStyle = (mode === 'BASE') ? '#CCCCCC' : '#000000';
    if (mode === 'PITCH') ctx.strokeStyle = '#333333';

    ctx.beginPath();
    activeLines.forEach(l => {
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
    });
    ctx.stroke();

    // --- PHASE 4.5: DRAW OBSTACLES (SKYLIGHTS / CHIMNEYS) ON TOP ---
    (function drawObstacleOverlay() {
        if (!state || !state.report || !Array.isArray(state.report.lines)) return;

        const obs = state.report.lines.filter(l => {
            const t = (l.type || '').toLowerCase();
            if (t !== 'skylight' && t !== 'chimney_edge' && t !== 'chimney_back' && t !== 'chimney_front') return false;
            if (layerFilter !== null) {
                const lp = (l.points && l.points[0]) ? (l.points[0].layer || 1) : 1;
                if (lp !== layerFilter) return false;
            }
            return true;
        });

        if (!obs.length) return;

        const w = (mode === 'BASE') ? LINE_THICKNESS_GRAY : ((mode === 'OUTLINE') ? LINE_THICKNESS_THIN : LINE_THICKNESS_BLACK);

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        obs.forEach(l => {
            const p1 = l.points?.[0];
            const p2 = l.points?.[1];
            if (!p1 || !p2) return;

            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);

            ctx.strokeStyle = (mode === 'BASE') ? '#BBBBBB' : '#777777';
            ctx.lineWidth = w;
            ctx.stroke();
        });

        ctx.restore();
    })();

    // --- PHASE 5: DRAW LABELS ---
    if (mode === 'PITCH' || mode === 'AREA') {
        const autoExcludedLabelFaceIndexes = getReportAutoExcludedFaceIndexSet(state);
        const labels = (Array.isArray(state.customLabels) ? state.customLabels : []).filter(l => {
            if (l.excluded) return false;
            const idMatch = String(l.id || '').match(/^f_\d+_(\d+)_/);
            if (idMatch && autoExcludedLabelFaceIndexes.has(Number(idMatch[1]))) return false;
            if (layerFilter === null) return true;
            return (l.layer || 1) === layerFilter;
        });

        const LABEL_BG_COLOR = 'rgba(255, 255, 255, 0.9)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Font size applied directly scaled
        ctx.font = `bold ${FONT_SIZE_PX}px Arial`;

        labels.forEach(lbl => {
            const x = state.cropRegion.minX + (lbl.x || 0);
            const y = state.cropRegion.minY + (lbl.y || 0);

            if (lbl.lined && lbl.leader) {
                const sx = state.cropRegion.minX + (lbl.leader.startX || 0);
                const sy = state.cropRegion.minY + (lbl.leader.startY || 0);
                ctx.save();
                ctx.strokeStyle = '#555';
                ctx.lineWidth = LINE_THICKNESS_THIN;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(x, y);
                ctx.stroke();
                ctx.restore();
            }

            const text = (mode === 'AREA')
                ? String(lbl.areaText ?? '')
                : String(lbl.pitchText ?? lbl.text ?? '');

            if (!text) return;

            drawLabelBox(ctx, text, x, y, FONT_SIZE_PX, 0, LABEL_BG_COLOR);
            ctx.save();
            ctx.fillStyle = '#000';
            ctx.fillText(text, x, y);
            ctx.restore();
        });
    }

    return canvas;
}
window.createFacetCanvasFromState = createFacetCanvasFromState;

function formatPdfFacetReferenceLabel(index) {
    let n = Math.max(0, Number(index) || 0) + 1;
    let label = '';
    while (n > 0) {
        n -= 1;
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26);
    }
    return label || 'A';
}

function drawPdfCanvasLabelBox(ctx, text, x, y, fontPx, bgColor = 'rgba(255, 255, 255, 0.9)') {
    const hPad = fontPx * 0.35;
    const vPad = fontPx * 0.18;
    const metrics = ctx.measureText(text);
    const w = metrics.width + hPad * 2;
    const h = fontPx + vPad * 2;
    const r = Math.max(2, fontPx * 0.12);
    const left = x - w / 2;
    const top = y - h / 2;

    ctx.save();
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.lineTo(left + w - r, top);
    ctx.quadraticCurveTo(left + w, top, left + w, top + r);
    ctx.lineTo(left + w, top + h - r);
    ctx.quadraticCurveTo(left + w, top + h, left + w - r, top + h);
    ctx.lineTo(left + r, top + h);
    ctx.quadraticCurveTo(left, top + h, left, top + h - r);
    ctx.lineTo(left, top + r);
    ctx.quadraticCurveTo(left, top, left + r, top);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

async function createNotesFacetReferenceCanvasFromState(state) {
    const canvas = await createFacetCanvasFromState(state, 'OUTLINE');
    if (!state || !state.cropRegion) return canvas;

    const extraPadPdf = state.editorCropPadding || 0;
    const crop = {
        minX: state.cropRegion.minX - extraPadPdf,
        minY: state.cropRegion.minY - extraPadPdf,
        width: state.cropRegion.width + extraPadPdf * 2,
        height: state.cropRegion.height + extraPadPdf * 2
    };
    const scale = canvas.width / crop.width;
    const labelRelativeScale = getPdfCanvasRelativeLabelScale(canvas.width, canvas.height, 2000);
    const diagramScale = getPdfDiagramScaleSetting(state);
    const fontPx = 40 * labelRelativeScale * diagramScale;
    const leaderWidth = Math.max(2, 3 * labelRelativeScale * diagramScale);

    const labelBySignature = new Map();
    const labelByFaceIndex = new Map();
    const autoExcludedReferenceLabels = getReportAutoExcludedFaceIndexSet(state);
    (Array.isArray(state.customLabels) ? state.customLabels : []).forEach((label) => {
        if (!label || typeof label !== 'object') return;
        const idMatch = String(label.id || '').match(/^f_\d+_(\d+)_/);
        const faceIndex = idMatch ? Number(idMatch[1]) : null;
        if (faceIndex !== null && autoExcludedReferenceLabels.has(faceIndex)) return;
        if (label.faceSignature) labelBySignature.set(label.faceSignature, label);
        if (faceIndex !== null) labelByFaceIndex.set(faceIndex, label);
    });

    const rows = collectPdfFaceDebugRows(state, state.report)
        .sort((a, b) => {
            const areaDiff = (Number(b.sq_ft) || 0) - (Number(a.sq_ft) || 0);
            if (Math.abs(areaDiff) > 0.001) return areaDiff;
            return (Number(a.face_index) || 0) - (Number(b.face_index) || 0);
        });

    const ctx = canvas.getContext('2d');
    if (typeof ctx.resetTransform === 'function') ctx.resetTransform();
    else ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.font = `bold ${fontPx}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    rows.forEach((row, idx) => {
        const label = labelBySignature.get(row.signature) || labelByFaceIndex.get(row.face_index) || null;
        const face = (state.facesData || [])[row.face_index];
        const refText = formatPdfFacetReferenceLabel(idx);

        let localX;
        let localY;
        let leader = null;
        if (label) {
            localX = Number(label.x);
            localY = Number(label.y);
            if (label.lined && label.leader) leader = label.leader;
        }
        if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
            const center = face && Array.isArray(face.points) && face.points.length
                ? getPolygonCentroid(face.points)
                : { x: state.cropRegion.minX + state.cropRegion.width / 2, y: state.cropRegion.minY + state.cropRegion.height / 2 };
            localX = center.x - state.cropRegion.minX;
            localY = center.y - state.cropRegion.minY;
        }

        const x = (localX + extraPadPdf) * scale;
        const y = (localY + extraPadPdf) * scale;

        if (leader) {
            const sx = (Number(leader.startX || 0) + extraPadPdf) * scale;
            const sy = (Number(leader.startY || 0) + extraPadPdf) * scale;
            ctx.save();
            ctx.strokeStyle = '#555';
            ctx.lineWidth = leaderWidth;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.restore();
        }

        drawPdfCanvasLabelBox(ctx, refText, x, y, fontPx);
        ctx.save();
        ctx.fillStyle = '#000';
        ctx.fillText(refText, x, y);
        ctx.restore();
    });

    return canvas;
}
window.createNotesFacetReferenceCanvasFromState = createNotesFacetReferenceCanvasFromState;



window.recalculateReportMaterials = function(state) {
  const SOFFIT_FACTOR = 0.98;

  const report = JSON.parse(JSON.stringify(state.report));

  let totalSquares = 0;
  let totalFootprintSqFt = 0;
  const squaresByPitch = {};
  let activeFacetCount = 0;

  const labelMap = new Map();
  if (state.customLabels && Array.isArray(state.customLabels)) {
    state.customLabels.forEach(lbl => {
      if (lbl.faceSignature) labelMap.set(lbl.faceSignature, lbl);
    });
  }

  const metersPerPx = getPdfMetersPerPx(state);
  const autoExcludedFaceIndexes = getReportAutoExcludedFaceIndexSet(state);

  (state.facesData || []).forEach((face, faceIndex) => {
    if (isObstacleFace(face, report)) return;
    if (autoExcludedFaceIndexes.has(faceIndex)) return;

    const sig = (typeof getLocalFaceSignatureReport === 'function')
      ? getLocalFaceSignatureReport(face.points)
      : window.getLocalFaceSignatureReport(face.points);

    if (getReportExcludedSignatureSet(state).has(sig)) return;

    activeFacetCount++;

    const areaPx = Math.abs(getSignedArea(face.points));
    const areaM2 = areaPx * (metersPerPx * metersPerPx);

    // Footprint: flat projected area (no pitch correction)
    const footprintSqFt = areaM2 * 10.7639;
    totalFootprintSqFt += footprintSqFt;

    let pitchDeg = 0;
    let rise12 = 0;
    let usedOverride = false;

    const lbl = labelMap.get(sig);
    if (lbl && (lbl.text !== undefined || lbl.pitchText !== undefined)) {
      const parsed = getPdfLabelRise12(lbl);
      if (Number.isFinite(parsed)) {
        rise12 = parsed;
        pitchDeg = Math.atan(rise12 / 12) * (180 / Math.PI);
        usedOverride = true;
      }
    }

    if (!usedOverride) {
      const rise = getFacePitchRise12(face, metersPerPx);
      rise12 = Number.isFinite(rise) ? rise : 0;
      if (!Number.isFinite(rise12)) rise12 = 0;
      if (rise12 < 0) rise12 = Math.abs(rise12);
      pitchDeg = Math.atan((rise12 / 12)) * (180 / Math.PI);
    }

    const areaSqFt = (areaM2 / Math.cos(pitchDeg * (Math.PI / 180))) * 10.7639;
    const sq = areaSqFt / 100;
    const pitchBucket12 = Math.round(Math.abs(rise12));

    if (lbl && typeof lbl === 'object') {
      lbl.areaText = `${Math.round(areaSqFt)}`;
    }

    totalSquares += sq;

    const pKey = `${pitchBucket12}/12`;
    if (!squaresByPitch[pKey]) squaresByPitch[pKey] = 0;
    squaresByPitch[pKey] += sq;
  });

  const atticAreaSqFt = totalFootprintSqFt * SOFFIT_FACTOR;

  report.materials.totalSquares = totalSquares;
  report.materials.squares = squaresByPitch;
  report.materials.totalFootprintSqFt = totalFootprintSqFt;
  report.materials.atticAreaSqFt      = atticAreaSqFt;

  return {
    updatedReport: report,
    facetCount: activeFacetCount,
    totalSquares: totalSquares,
    totalFootprintSqFt: totalFootprintSqFt,
    atticAreaSqFt: atticAreaSqFt
  };
};





// ==========================================
// --- 4. LAYER CANVAS (UNCHANGED, BUT KEPT) ---
// ==========================================

async function createLayerCanvasFromState(state, layerNum, drawLabels, monochrome) {
    const extraPadPdf = state.editorCropPadding || 0;
    const crop = {
        minX: state.cropRegion.minX - extraPadPdf,
        minY: state.cropRegion.minY - extraPadPdf,
        width: state.cropRegion.width + extraPadPdf * 2,
        height: state.cropRegion.height + extraPadPdf * 2
    };
    
    // --- STANDARDIZATION LOGIC (Synced to Facet Canvas) ---
    const TARGET_WIDTH = 2000; 
    const scale = TARGET_WIDTH / crop.width; 
    const invScale = 1 / scale; 
    const targetHeight = crop.height * scale;
    const labelRelativeScale = getPdfCanvasRelativeLabelScale(TARGET_WIDTH, targetHeight, TARGET_WIDTH);

    // Constants relative to 2000px
    // Boosted for legibility on PDF
    const LINE_WIDTH_STD = (monochrome ? 6 : 5) * invScale;
    const measurementScale = Number(window.PDF_MEASUREMENT_FONT_SCALE);
    const lineMeasurementRelativeScale = Math.max(1.08, labelRelativeScale);
    const LINE_MEASUREMENT_FONT_REDUCTION = 0.7;
    const FONT_SIZE_STD  = 44 * LINE_MEASUREMENT_FONT_REDUCTION * lineMeasurementRelativeScale * invScale * (
        Number.isFinite(measurementScale) && measurementScale > 0 ? measurementScale : getPdfDiagramScaleSetting(state)
    );
    
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    ctx.scale(scale, scale);
    ctx.translate(-crop.minX, -crop.minY);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(crop.minX, crop.minY, crop.width, crop.height);

    const LABEL_BG_COLOR = 'rgba(255, 255, 255, 0.75)';

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let linesToDraw = state.report.lines;
    if (layerNum !== null) {
        linesToDraw = linesToDraw.filter(l => (l.points[0].layer || 1) === layerNum);
    }

    // Draw Standard Lines
    linesToDraw.forEach(item => {
        if (item.type === 'skylight' || item.type === 'chimney_edge' || item.type === 'chimney_back') return;
        let color = '#000000';
        if (!monochrome) {
            const t = Object.values(getPdfLineTypes()).find(x => x.id === item.type);
            if (t) color = t.color;
        }
        drawLinePath(ctx, item, LINE_WIDTH_STD, color);
    });

    // Draw Obstacles
    const skylightLines = linesToDraw.filter(l => l.type === 'skylight');
    skylightLines.forEach(item => {
        const color = monochrome ? '#000000' : '#800080';
        drawLinePath(ctx, item, LINE_WIDTH_STD, color);
    });

    const chimneyLines = linesToDraw.filter(l => l.type === 'chimney_edge' || l.type === 'chimney_back' || l.type === 'chimney_front');
    chimneyLines.forEach(item => {
        const color = monochrome ? '#000000' : '#555555';
        drawLinePath(ctx, item, LINE_WIDTH_STD, color);
    });

    if (drawLabels && !monochrome) {
        const obstacles = [];

        const labelCluster = (lines, prefix) => {
            const clusters = groupSkylightsCorrectly(lines);
            clusters.forEach(c => {
                const center = getClusterCenter(c);
                const lengths = c.map(l => Math.round(l.length));
                const unique = [...new Set(lengths)].sort((a, b) => a - b);

                let dimStr = prefix;
                if (unique.length > 0) dimStr = `${unique[0]}'x${unique[unique.length - 1]}'`;
                if (prefix === "CHIM" && unique.length === 0) dimStr = "CHIM";

                drawLabelBox(ctx, dimStr, center.x, center.y, FONT_SIZE_STD, 0, LABEL_BG_COLOR);
                ctx.fillStyle = '#000000';
                ctx.font = `bold ${FONT_SIZE_STD}px Arial`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(dimStr, center.x, center.y);
                obstacles.push(getTextBox(ctx, dimStr, center.x, center.y, FONT_SIZE_STD));
            });
        };

        labelCluster(skylightLines, "SKY");
        labelCluster(chimneyLines, "CHIM");

        const normalLines = linesToDraw.filter(l =>
            l.type !== 'skylight' && l.type !== 'chimney_edge' && l.type !== 'chimney_back' && l.type !== 'chimney_front' &&
            !shouldHidePdfLineMeasurementLabel(l)
        );
        const labels = solveLabels(ctx, normalLines, obstacles, FONT_SIZE_STD);

        labels.forEach(lbl => {
            drawLabelBox(ctx, lbl.text, lbl.x, lbl.y, FONT_SIZE_STD, lbl.angle, LABEL_BG_COLOR);
            ctx.save();
            ctx.translate(lbl.x, lbl.y);
            ctx.rotate(lbl.angle);
            ctx.fillStyle = '#000000';
            ctx.font = `bold ${FONT_SIZE_STD}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl.text, 0, 0);
            ctx.restore();
        });
    }
    return canvas;
}

function pdfCanvasHasVisibleInk(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return false;

    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const sampleCols = 16;
        const sampleRows = 16;
        const stepX = Math.max(1, Math.floor(canvas.width / sampleCols));
        const stepY = Math.max(1, Math.floor(canvas.height / sampleRows));

        for (let y = 0; y < canvas.height; y += stepY) {
            for (let x = 0; x < canvas.width; x += stepX) {
                const pixel = ctx.getImageData(x, y, 1, 1).data;
                if (pixel[3] === 0) continue;
                if (pixel[0] < 245 || pixel[1] < 245 || pixel[2] < 245) {
                    return true;
                }
            }
        }
    } catch (e) {
        console.warn('[PDF] Unable to inspect canvas contents:', e);
        return true;
    }

    return false;
}

async function createReliableSummaryCanvasFromState(state) {
    const monoCanvas = await createLayerCanvasFromState(state, null, false, true);
    if (pdfCanvasHasVisibleInk(monoCanvas)) {
        return monoCanvas;
    }

    console.warn('[PDF] Summary line canvas was blank; falling back to outline facet canvas.');
    return createFacetCanvasFromState(state, 'OUTLINE');
}


// ==========================================
// --- 5. DEFAULT LABEL BUILDER (shared logic)
// ==========================================

function buildDefaultDiagramLabelsInternal({ report, facesData, cropRegion, dims, radiusMeters, autoExcludedFacetIndexes = [] }) {
    const crop = cropRegion;
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(10, crop.width * 2);
    tmp.height = Math.max(10, crop.height * 2);
    const ctx = tmp.getContext('2d');
    const fontSize = 12;
    ctx.font = `bold ${fontSize}px Arial`;
    const labels = [];

    const autoExcluded = getReportAutoExcludedFaceIndexSet({ autoExcludedFacetIndexes });
    (facesData || []).forEach((face, idx) => {
        if (autoExcluded.has(idx)) return;
        const currentLayer = face.layer || 1;
        const p0 = face.points[0];
        const obstacleLine = report.lines.find(line =>
            (line.type === 'skylight' || line.type === 'chimney_edge' || line.type === 'chimney_back' || line.type === 'chimney_front') &&
            ((line.points[0].x === p0.x && line.points[0].y === p0.y) || (line.points[1].x === p0.x))
        );
        if (obstacleLine) return;

        const areaPx = Math.abs(getSignedArea(face.points));
        const metersPerPx = getPdfMetersPerPx({ dims, radiusMeters });
        const areaM2 = areaPx * (metersPerPx * metersPerPx);
        const plane = localFitPlane(face.points);
        const rawSlope = Math.sqrt(plane.a * plane.a + plane.b * plane.b);
        const realSlope = rawSlope * (1 / metersPerPx);
        const pitchDeg = Math.atan(realSlope) * (180 / Math.PI);
        const riseExact = Math.tan(pitchDeg * (Math.PI / 180)) * 12;
        const pitchExactText = `${(Math.round(riseExact * 10) / 10).toFixed(1)}/12`;
        const riseRounded = Math.round(riseExact);
        const text = `${riseRounded}/12`;

        let placementHoles = [...(face.holes || [])];
        (facesData || []).forEach(other => {
            if (other === face) return;
            const otherLayer = other.layer || 1;
            const isHigherLayer = otherLayer > currentLayer;
            let intersects = false;
            if (isHigherLayer) {
                if (polygonsIntersectRough(face.points, other.points)) intersects = true;
            }
            const isContained = isPolygonContained(other.points, face.points);
            if (isContained || intersects) placementHoles.push(other.points);
        });

        const pole = getPoleOfInaccessibility(face.points, placementHoles, 1.0);
        const textWidth = ctx.measureText(text).width + 10;
        const textHeight = fontSize + 10;
        const requiredRadius = Math.sqrt((textWidth / 2) ** 2 + (textHeight / 2) ** 2);

        let lx = pole.x - crop.minX;
        let ly = pole.y - crop.minY;
        let lined = false;
        let leader = null;

        if (pole.dist < requiredRadius + 2) {
            lined = true;
            let leaderStart = getPolygonCentroid(face.points);
            const distToValid = getPointToPolygonDistWithHoles(leaderStart.x, leaderStart.y, face.points, placementHoles);
            if (distToValid < 0) leaderStart = { x: pole.x, y: pole.y };
            const leaderLocal = { x: leaderStart.x - crop.minX, y: leaderStart.y - crop.minY };
            const dists = [
                { dir: 'left', val: leaderLocal.x - 0 },
                { dir: 'right', val: crop.width - leaderLocal.x },
                { dir: 'top', val: leaderLocal.y - 0 },
                { dir: 'bottom', val: crop.height - leaderLocal.y }
            ];
            dists.sort((a, b) => a.val - b.val);
            const min = dists[0];
            const pad = 18;
            lx = leaderLocal.x;
            ly = leaderLocal.y;
            if (min.dir === 'left') lx = pad;
            else if (min.dir === 'right') lx = crop.width - pad;
            else if (min.dir === 'top') ly = pad;
            else ly = crop.height - pad;
            leader = { startX: leaderLocal.x, startY: leaderLocal.y };
        }

        lx = Math.max(0, Math.min(crop.width, lx));
        ly = Math.max(0, Math.min(crop.height, ly));
        const centroid = getPolygonCentroid(face.points);

        labels.push({
            id: `f_${currentLayer}_${idx}_${Math.floor(Math.random() * 1e9)}`,
            layer: currentLayer,
            text,
            pitchExact: riseExact,
            pitchExactText,
            areaSqFt: Math.round((areaM2 / Math.cos(pitchDeg * (Math.PI / 180))) * 10.7639),
            x: lx, y: ly,
            anchorX: Math.max(0, Math.min(crop.width, centroid.x - crop.minX)),
            anchorY: Math.max(0, Math.min(crop.height, centroid.y - crop.minY)),
            lined, leader
        });
    });
    return labels;
}
if (typeof window.buildDefaultDiagramLabels !== 'function') {
    window.buildDefaultDiagramLabels = buildDefaultDiagramLabelsInternal;
}


function polygonsIntersectRough(polyA, polyB) {
    for(let i=0; i<polyA.length; i++) {
        if(isPointInPolyReport(polyA[i].x, polyA[i].y, polyB)) return true;
    }
    for(let i=0; i<polyB.length; i++) {
        if(isPointInPolyReport(polyB[i].x, polyB[i].y, polyA)) return true;
    }
    return false;
}

function isPolygonContained(innerPts, outerPts) {
    let cx = 0, cy = 0;
    innerPts.forEach(p => { cx += p.x; cy += p.y; });
    cx /= innerPts.length;
    cy /= innerPts.length;
    return isPointInPolyReport(cx, cy, outerPts);
}

function isPointInPolyReport(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function getPoleOfInaccessibility(outerRing, holes, precision = 1) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    outerRing.forEach(p => {
        if(p.x < minX) minX = p.x;
        if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y;
        if(p.y > maxY) maxY = p.y;
    });

    const width = maxX - minX;
    const height = maxY - minY;
    
    const centroid = getPolygonCentroid(outerRing);
    let bestCell = {
        x: centroid.x,
        y: centroid.y,
        dist: getPointToPolygonDistWithHoles(centroid.x, centroid.y, outerRing, holes)
    };

    if (bestCell.dist < 0) bestCell.dist = 0;

    const cellSize = Math.min(width, height) / 10;
    if (cellSize <= 0) return bestCell;

    const testPoint = (x, y) => {
        if (x < minX || x > maxX || y < minY || y > maxY) return;
        const d = getPointToPolygonDistWithHoles(x, y, outerRing, holes);
        if (d > bestCell.dist) {
            bestCell = { x, y, dist: d };
        }
    };

    for (let x = minX; x <= maxX; x += cellSize) {
        for (let y = minY; y <= maxY; y += cellSize) {
            testPoint(x, y);
        }
    }

    let step = cellSize / 2;
    while (step > precision) {
        const cx = bestCell.x;
        const cy = bestCell.y;
        testPoint(cx - step, cy - step); testPoint(cx, cy - step); testPoint(cx + step, cy - step);
        testPoint(cx - step, cy);                                  testPoint(cx + step, cy);
        testPoint(cx - step, cy + step); testPoint(cx, cy + step); testPoint(cx + step, cy + step);
        step /= 2;
    }

    return bestCell;
}

function getPointToPolygonDistWithHoles(x, y, outerRing, holes) {
    if (!isPointInPolyReport(x, y, outerRing)) return -1; 
    if (holes && holes.length > 0) {
        for (let i = 0; i < holes.length; i++) {
            if (isPointInPolyReport(x, y, holes[i])) return -1;
        }
    }
    let minDistSq = getMinDistToPolySquared(x, y, outerRing);
    if (holes && holes.length > 0) {
        for (let i = 0; i < holes.length; i++) {
            const dHoleSq = getMinDistToPolySquared(x, y, holes[i]);
            if (dHoleSq < minDistSq) minDistSq = dHoleSq;
        }
    }
    return Math.sqrt(minDistSq);
}

function getMinDistToPolySquared(x, y, poly) {
    let minSq = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        
        const dSq = getDistToSegmentSquared(x, y, xi, yi, xj, yj);
        if (dSq < minSq) minSq = dSq;
    }
    return minSq;
}

function getDistToSegmentSquared(px, py, vx, vy, wx, wy) {
    const l2 = (vx - wx)**2 + (vy - wy)**2;
    if (l2 === 0) return (px - vx)**2 + (py - vy)**2;
    let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = vx + t * (wx - vx);
    const projY = vy + t * (wy - vy);
    return (px - projX)**2 + (py - projY)**2;
}



// =============================================================================
// FIXED: createVentCanvas (Robust Live Image Retrieval)
// =============================================================================
async function createVentCanvas(report, crop, ventData, state, excludedRidges = []) {
    const TARGET_WIDTH = 1500; 
    const scale = TARGET_WIDTH / crop.width; 
    const invScale = 1 / scale; 
    const RIDGE_LINE_WIDTH = 12 * invScale;
    const BASE_LINE_WIDTH  = 3.5 * invScale;
    const BOX_SIZE         = 30 * invScale;
    
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = crop.height * scale;
    const ctx = canvas.getContext('2d');
    
    ctx.scale(scale, scale);
    ctx.translate(-crop.minX, -crop.minY);
    
    // --- 1. Background Image Logic ---
    const viewId = getPdfVentilationViewId(state.imageSettings || {});
    
    let drawDone = false;

    // A. Priority: Use Live Canvas via Helper (Best for Configurator Preview)
    // We call ensureViewCanvas because direct access to viewCanvases might fail if variables aren't global
    let liveCvs = null;
    if (typeof window !== 'undefined' && typeof window.ensureViewCanvas === 'function') {
        liveCvs = window.ensureViewCanvas(viewId);
    } else if (typeof window !== 'undefined' && window.viewCanvases) {
        liveCvs = window.viewCanvases[viewId];
    }

    if (liveCvs) {
        // Draw full size, 0,0 alignment
        ctx.drawImage(liveCvs, 0, 0, liveCvs.width, liveCvs.height);
        drawDone = true;
    }
    // B. Fallback: Use Captured Blob (For PDF generation if live main.js context is gone or state locked)
    else if (state.ventImg) {
        const img = new Image();
        img.src = state.ventImg;
        await new Promise(r => img.onload = r);
        
        // Use state dims if available, else natural
        const drawW = state.dims ? state.dims.w : img.naturalWidth;
        const drawH = state.dims ? state.dims.h : img.naturalHeight;
        ctx.drawImage(img, 0, 0, drawW, drawH);
        drawDone = true;
    } 
    // C. Last Resort: Solar Image Blob
    else if (state.solarImg) {
        const img = new Image();
        img.src = state.solarImg;
        await new Promise(r => img.onload = r);
        const drawW = state.dims ? state.dims.w : img.naturalWidth;
        const drawH = state.dims ? state.dims.h : img.naturalHeight;
        ctx.drawImage(img, 0, 0, drawW, drawH);
        drawDone = true;
    }

    if (!drawDone) {
        ctx.fillStyle = '#FFFFFF'; 
        ctx.fillRect(crop.minX, crop.minY, crop.width, crop.height);
    }
    
    // Dimming overlay
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(crop.minX, crop.minY, crop.width, crop.height);

    const ventSettings = (state && state.ventSettings && typeof state.ventSettings === 'object') ? state.ventSettings : {};
    const configuredBoxVents = Array.isArray(ventSettings.boxVents) ? ventSettings.boxVents : [];
    const configuredMode = ventSettings.mode || (ventData.systemType && ventData.systemType.includes("Box Vents Only") ? 'box' : 'ridge');
    const normalizedBoxVents = configuredBoxVents.map((vent) => {
        if (Number.isFinite(Number(vent.x)) && Number.isFinite(Number(vent.y))) return { x: Number(vent.x), y: Number(vent.y) };
        return {
            x: crop.minX + (Number(vent.nx) || 0.5) * crop.width,
            y: crop.minY + (Number(vent.ny) || 0.5) * crop.height
        };
    });

    // --- 2. Draw Existing/Configured Box Vents ---
    const allBoxVents = configuredMode === 'box' ? normalizedBoxVents : [];
    if (allBoxVents.length) {
        ctx.fillStyle = '#FF9800'; ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1 * invScale;
        allBoxVents.forEach(v => {
            ctx.beginPath();
            ctx.rect(v.x - BOX_SIZE/2, v.y - BOX_SIZE/2, BOX_SIZE, BOX_SIZE);
            ctx.fill(); ctx.stroke();
        });
    }

    // --- 3. Draw Ridge Vents ---
    if (configuredMode !== 'box' && !ventData.systemType.includes("Box Vents Only")) {
        const activeRidgeLines = report.lines.filter((l, idx) => l.type === 'ridge' && !excludedRidges.includes(idx));
        const totalRidgeFeet = activeRidgeLines.reduce((acc, l) => acc + (l.length || 0), 0);
        
        const reqExhaust = ventData.reqExhaust || 0; 
        const RIDGE_RATING = 18; 
        let percentage = 1.0;
        
        if (totalRidgeFeet > 0) {
            const neededFeet = reqExhaust / RIDGE_RATING;
            percentage = neededFeet / totalRidgeFeet;
            if (percentage > 1.0) percentage = 1.0;
        }

        report.lines.forEach((line, idx) => {
            if (line.type !== 'ridge') return;
            
            const p1 = line.points[0]; 
            const p2 = line.points[1];
            
            // Base structural line
            ctx.beginPath(); 
            ctx.moveTo(p1.x, p1.y); 
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.4)'; 
            ctx.lineWidth = BASE_LINE_WIDTH; 
            ctx.stroke();
            
            // Active Vent line
            if (!excludedRidges.includes(idx)) {
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                
                const segHalfDx = (dx / 2) * percentage;
                const segHalfDy = (dy / 2) * percentage;
                
                const startX = midX - segHalfDx;
                const startY = midY - segHalfDy;
                const endX = midX + segHalfDx;
                const endY = midY + segHalfDy;
                
                ctx.beginPath(); 
                ctx.moveTo(startX, startY); 
                ctx.lineTo(endX, endY);
                ctx.strokeStyle = '#FF0000'; 
                ctx.lineWidth = RIDGE_LINE_WIDTH; 
                ctx.lineCap = 'round'; 
                ctx.stroke();
            }
        });
    } else {
        report.lines.forEach((line) => {
            if (line.type !== 'ridge') return;
            const p1 = line.points[0]; const p2 = line.points[1];
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = BASE_LINE_WIDTH; ctx.stroke();
        });
    }
    
    return canvas;
}
window.createVentCanvas = createVentCanvas;

async function createGutterCanvas(state, metrics) {
    const extraPadPdf = state.editorCropPadding || 0;
    const crop = {
        minX: state.cropRegion.minX - extraPadPdf,
        minY: state.cropRegion.minY - extraPadPdf,
        width: state.cropRegion.width + extraPadPdf * 2,
        height: state.cropRegion.height + extraPadPdf * 2
    };

    const TARGET_WIDTH = 1600;
    const scale = TARGET_WIDTH / crop.width;
    const invScale = 1 / scale;
    const targetHeight = Math.max(1, Math.round(crop.height * scale));
    const labelRelativeScale = getPdfCanvasRelativeLabelScale(TARGET_WIDTH, targetHeight, TARGET_WIDTH);
    const BASE_LINE_WIDTH = 2.2 * invScale;
    const ACTIVE_LINE_WIDTH = 6.75 * invScale;
    const DOT_RADIUS = 19.4 * invScale;
    const DOT_STROKE = 2.5 * invScale;
    const LABEL_FONT_SIZE = 43.2 * labelRelativeScale * invScale;
    const LABEL_PAD_X = 2.4 * labelRelativeScale * invScale;
    const LABEL_PAD_Y = 1.2 * labelRelativeScale * invScale;

    const canvas = document.createElement('canvas');
    canvas.width = TARGET_WIDTH;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    ctx.scale(scale, scale);
    ctx.translate(-crop.minX, -crop.minY);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(crop.minX, crop.minY, crop.width, crop.height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const baseLines = Array.isArray(state?.report?.lines)
        ? state.report.lines.filter((line) => Array.isArray(line?.points) && line.points.length >= 2)
        : [];

    baseLines.forEach((line) => {
        const type = String(line?.type || '').toLowerCase();
        if (type === 'skylight' || type === 'chimney_edge' || type === 'chimney_back' || type === 'chimney_front') {
            return;
        }
        ctx.beginPath();
        ctx.moveTo(Number(line.points[0]?.x) || 0, Number(line.points[0]?.y) || 0);
        ctx.lineTo(Number(line.points[1]?.x) || 0, Number(line.points[1]?.y) || 0);
        ctx.strokeStyle = 'rgba(120, 132, 145, 0.45)';
        ctx.lineWidth = BASE_LINE_WIDTH;
        ctx.stroke();
    });

    metrics.eaveLines.forEach((entry) => {
        if (entry.disabled) return;
        ctx.beginPath();
        ctx.moveTo(Number(entry.start?.x) || 0, Number(entry.start?.y) || 0);
        ctx.lineTo(Number(entry.end?.x) || 0, Number(entry.end?.y) || 0);
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = ACTIVE_LINE_WIDTH;
        ctx.stroke();
    });

    metrics.eaveLines.forEach((entry) => {
        if (entry.disabled) return;

        const x1 = Number(entry.start?.x) || 0;
        const y1 = Number(entry.start?.y) || 0;
        const x2 = Number(entry.end?.x) || 0;
        const y2 = Number(entry.end?.y) || 0;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        let angle = Math.atan2(y2 - y1, x2 - x1);
        if (angle > (Math.PI / 2)) angle -= Math.PI;
        if (angle < (-Math.PI / 2)) angle += Math.PI;

        const text = formatPdfGutterRunLabel(entry.lengthFt);

        ctx.save();
        ctx.translate(midX, midY);
        ctx.rotate(angle);
        ctx.font = `700 ${LABEL_FONT_SIZE}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const textWidth = ctx.measureText(text).width;
        const boxW = textWidth + (LABEL_PAD_X * 2);
        const boxH = (LABEL_FONT_SIZE * 0.78) + (LABEL_PAD_Y * 2);

        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);

        ctx.fillStyle = '#24313d';
        ctx.fillText(text, 0, LABEL_FONT_SIZE * 0.05);
        ctx.restore();
    });

    metrics.miters.forEach((miter) => {
        if (miter.isOff) return;
        const fillColor = PDF_GUTTER_MITER_COLORS[miter.type] || PDF_GUTTER_MITER_COLORS.non90;

        ctx.beginPath();
        ctx.arc(miter.x, miter.y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = DOT_STROKE;
        ctx.stroke();
    });

    return canvas;
}
window.createGutterCanvas = createGutterCanvas;





// =============================================================================
// 2. NEW: updateStateImages (Refreshes Blobs before PDF Gen)
// =============================================================================
async function updateStateImages(state, options = {}) {
    console.log("Refreshing State Images based on Config...");
    
    const settings = state.imageSettings || { mainViewId: 'solar', ventViewId: 'solar', cropPadding: 50 };
    settings.ventViewId = getPdfVentilationViewId(settings);
    const IMG_TARGET_WIDTH = 800;
    const IMG_JPEG_QUALITY = 0.55;
    const TOP_VIEW_JPEG_QUALITY = 0.85;

    // --- 1. Refresh Top View (Square Crop) ---
    const mainCvs = ensureViewCanvas(settings.mainViewId);
    if (mainCvs) {
        const baseCrop = state.cropRegion;
        const displayCrop = calculateReportTopViewCrop(baseCrop, mainCvs.width, mainCvs.height, {
            modelFillRatio: 0.5,
            zoom: settings.cropZoom || 1,
            sourceCanvas: mainCvs,
            avoidWhiteEdges: !!settings.topViewAutoSelection || !settings.topViewManualOverride
        });

        const tempCvs = document.createElement('canvas');
        tempCvs.width = displayCrop.width;
        tempCvs.height = displayCrop.height;
        const tCtx = tempCvs.getContext('2d');
        
        tCtx.fillStyle = '#FFFFFF';
        tCtx.fillRect(0, 0, displayCrop.width, displayCrop.height);
        
        tCtx.drawImage(
            mainCvs, 
            displayCrop.minX, displayCrop.minY, displayCrop.width, displayCrop.height,
            0, 0, displayCrop.width, displayCrop.height
        );
        
        // Update State
        state.solarImg = _downscaleCanvasToJpeg(tempCvs, IMG_TARGET_WIDTH, TOP_VIEW_JPEG_QUALITY);
        state.displayCrop = displayCrop;
    }

    // --- 2. Refresh Vent View (Full) ---
    const ventCvs = ensureViewCanvas(settings.ventViewId);
    if (ventCvs) {
        state.ventImg = _downscaleCanvasToJpeg(ventCvs, IMG_TARGET_WIDTH, IMG_JPEG_QUALITY);
    }

    if (options.captureWireframes === true && typeof window.ensurePdfWireframesForState === 'function') {
        await window.ensurePdfWireframesForState(state);
    }
}
window.updateStateImages = updateStateImages;

function waitForPdfAnimationFrames(frameCount = 2) {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame !== 'function') {
            setTimeout(resolve, Math.max(16, frameCount * 16));
            return;
        }
        let remaining = Math.max(1, frameCount);
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) {
                resolve();
                return;
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
}

function isPdf3DLoaderVisible() {
    const loader = document.getElementById('three-loader');
    return !!(loader && loader.classList.contains('visible'));
}

function setPdf3DWireframeCaptureLoader(show) {
    let loader = document.getElementById('three-loader');
    if (!loader) {
        const wrapper = document.getElementById('three-view-wrapper');
        if (wrapper) {
            loader = document.createElement('div');
            loader.id = 'three-loader';
            loader.innerHTML = '<div class="slick-spinner"></div><div class="loader-text"></div>';
            wrapper.appendChild(loader);
        }
    }

    if (!loader) return;
    const textEl = loader.querySelector('.loader-text');
    if (show) {
        loader.dataset.pdfWireframeCapture = '1';
        if (textEl) textEl.textContent = 'Generating 3D facets view...';
        loader.classList.add('visible');
    } else if (loader.dataset.pdfWireframeCapture === '1') {
        delete loader.dataset.pdfWireframeCapture;
        if (textEl) textEl.textContent = 'Resolving Topology...';
        loader.classList.remove('visible');
    }
}

function countPdfWireframeRenderableObjects() {
    let count = 0;

    try {
        if (Array.isArray(window.lastResolvedFacesCache)) {
            count += window.lastResolvedFacesCache.length;
        }
    } catch (e) {}

    try {
        if (typeof facesGroup !== 'undefined' && facesGroup) {
            facesGroup.traverse((obj) => {
                if (obj && obj.isMesh && obj.visible !== false) count += 1;
            });
        }
    } catch (e) {}

    try {
        if (typeof geometryGroup !== 'undefined' && geometryGroup) {
            geometryGroup.traverse((obj) => {
                if (!obj || obj.visible === false) return;
                if (obj.userData && (obj.userData.__selected || obj.userData.__loopEdge)) return;
                if (obj.isLine || obj.isMesh) count += 1;
            });
        }
    } catch (e) {}

    return count;
}

async function waitForPdfWireframeSceneReady(timeoutMs = 2500) {
    if (typeof renderer === 'undefined' || !renderer) return false;
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            if (typeof window.sync3DViewportSize === 'function') {
                window.sync3DViewportSize();
            }
        } catch (e) {}

        const canvas = renderer && renderer.domElement;
        const hasCanvas = !!(canvas && canvas.width > 0 && canvas.height > 0);
        const renderableCount = countPdfWireframeRenderableObjects();
        if (hasCanvas && renderableCount > 0) {
            await waitForPdfAnimationFrames(2);
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return false;
}



// DROP-IN REPLACEMENT — paste over the existing captureWireframeViews function in scene_3d.js

async function captureWireframeViews(attempt = 1) {
    if (
        typeof renderer === 'undefined' || !renderer ||
        typeof scene === 'undefined' || !scene ||
        typeof camera === 'undefined' || !camera
    ) return [];
    const managesLoader = attempt === 1;
    if (managesLoader) setPdf3DWireframeCaptureLoader(true);

    // --- IMAGE SIZE BUDGET ---
    const WIREFRAME_CAPTURE_SIZE = 1000;
    const WIREFRAME_TARGET_WIDTH = 800;
    const WIREFRAME_JPEG_QUALITY = 0.60;
    const WIREFRAME_LINE_PIXEL_WIDTH = 2.2;

    const sceneReady = await waitForPdfWireframeSceneReady();
    await waitForPdfAnimationFrames(2);
    if (!sceneReady && attempt >= 2) {
        console.warn('[PDF 3D] 3D scene was not ready before wireframe capture.');
    }

    // 0) Ensure transforms are current so Box3 bounds are accurate
    try {
        scene.updateMatrixWorld(true);
        if (typeof facesGroup !== 'undefined' && facesGroup) facesGroup.updateMatrixWorld(true);
        if (typeof geometryGroup !== 'undefined' && geometryGroup) geometryGroup.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
    } catch (e) {}

    // 1) Build bounds from scene contents
    const box = new THREE.Box3();
    
    if (typeof facesGroup !== 'undefined' && facesGroup) {
        facesGroup.traverse(obj => {
            if (obj && obj.isMesh) box.expandByObject(obj);
        });
    }
    if (typeof geometryGroup !== 'undefined' && geometryGroup) {
        geometryGroup.traverse(obj => {
            if (!obj) return;
            if (obj.userData && (obj.userData.__selected || obj.userData.__loopEdge)) return; 
            if (obj.isLine || obj.isMesh || obj.isPoints) box.expandByObject(obj);
        });
    }

    if (box.isEmpty() && typeof activeGeometry !== 'undefined' && activeGeometry && Array.isArray(activeGeometry.points)) {
        activeGeometry.points.forEach(p => {
            try { box.expandByPoint(getVector3(p)); } catch (e) {}
        });
    }

    const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = (sphere && sphere.radius && sphere.radius > 0) ? sphere.radius : 30;

    // 2) Compute initial distance from bounding sphere
    camera.updateProjectionMatrix();
    const vFov = THREE.MathUtils.degToRad(camera.fov || 50);
    const canvas = renderer.domElement;
    const canvasAspect = (canvas && canvas.width && canvas.height) ? (canvas.width / canvas.height) : 1;
    const aspect = (camera.aspect && Number.isFinite(camera.aspect) && camera.aspect > 0) ? camera.aspect : canvasAspect;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const limitingFov = Math.min(vFov, hFov);
    let dist = radius / Math.sin(limitingFov / 2);
    dist *= 1.03;
    const MAX_CAPTURE_DISTANCE = Math.max(5000, radius * 20);
    dist = Math.max(dist, 20);
    dist = Math.min(dist, MAX_CAPTURE_DISTANCE);

    camera.near = Math.max(0.1, dist / 200);
    camera.far  = Math.max(2000, dist * 50);
    camera.updateProjectionMatrix();

    // 3) PREPARE UNIFORM MATERIALS
    const uniformGrayMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0, 0, 0.88),
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: 1.0,
        polygonOffsetUnits: 1.0
    });
    // Solid black material for tube lines — always renders on top
    const tubeMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        depthTest: false
    });

    // 4) Force renderer to SQUARE early so tube radius calculation has correct size
    const origCanvasW = renderer.domElement.width;
    const origCanvasH = renderer.domElement.height;
    const squareSize = WIREFRAME_CAPTURE_SIZE;
    if (!(squareSize > 0)) {
        uniformGrayMat.dispose();
        tubeMat.dispose();
        if (managesLoader) setPdf3DWireframeCaptureLoader(false);
        return [];
    }
    renderer.setSize(squareSize, squareSize, false);
    camera.aspect = 1.0;
    camera.updateProjectionMatrix();

    // Helper: compute a world-space tube radius that looks consistent
    const getTubeRadius = (pixelWidth = WIREFRAME_LINE_PIXEL_WIDTH) => {
        const d = camera.position.distanceTo(center);
        const fovRad = THREE.MathUtils.degToRad(camera.fov || 45);
        const worldPerPixel = (2 * d * Math.tan(fovRad / 2)) / squareSize;
        return Math.max(worldPerPixel * pixelWidth * 0.5, 0.001);
    };

    // 5) SAVE STATE & APPLY UNIFORM STYLE
    const originalBg = scene.background ? scene.background.clone() : null;
    scene.background = new THREE.Color(0xffffff);

    const restoreList = [];
    const tubeGroup = new THREE.Group(); // temporary tubes for thick lines
    tubeGroup.renderOrder = 999;
    scene.add(tubeGroup);
    const lineSegments = [];

    const clearTubeGroup = () => {
        while (tubeGroup.children.length > 0) {
            const child = tubeGroup.children[0];
            if (child.geometry) child.geometry.dispose();
            tubeGroup.remove(child);
        }
    };

    const rebuildTubeGroupForCurrentCamera = (pixelWidth = WIREFRAME_LINE_PIXEL_WIDTH) => {
        clearTubeGroup();
        const r = getTubeRadius(pixelWidth);
        lineSegments.forEach(segment => {
            const path = new THREE.LineCurve3(segment.start, segment.end);
            const tubeGeo = new THREE.TubeGeometry(path, 1, r, 6, false);
            const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
            tubeMesh.renderOrder = 999;
            tubeGroup.add(tubeMesh);
        });
    };

    const overrideObjectState = (obj) => {
        restoreList.push({ 
            obj: obj, 
            visible: obj.visible, 
            material: obj.material,
            renderOrder: obj.renderOrder
        });

        if (obj.userData && (obj.userData.__selected || obj.userData.__loopEdge)) {
            obj.visible = false;
            return;
        }

        // Hide original thin lines — we'll replace them with tubes
        if (obj.isLine) {
            // Extract all segments and create tubes for each
            const positions = obj.geometry?.attributes?.position;
            if (positions && positions.count >= 2) {
                obj.updateMatrixWorld();
                for (let seg = 0; seg < positions.count - 1; seg++) {
                    const p1 = new THREE.Vector3(
                        positions.getX(seg), positions.getY(seg), positions.getZ(seg)
                    );
                    const p2 = new THREE.Vector3(
                        positions.getX(seg + 1), positions.getY(seg + 1), positions.getZ(seg + 1)
                    );
                    // Apply the object's world transform
                    p1.applyMatrix4(obj.matrixWorld);
                    p2.applyMatrix4(obj.matrixWorld);
                    if (p1.distanceTo(p2) > 0.001) {
                        lineSegments.push({ start: p1, end: p2 });
                    }
                }
            }
            obj.visible = false;
        } else if (obj.isPoints) {
            obj.visible = false;
        } else if (obj.isMesh) {
            obj.visible = true;
            if (obj.userData && (obj.userData.faceDef || obj.userData.isConnection)) {
                obj.material = uniformGrayMat;
            }
        }
    };

    if (typeof facesGroup !== 'undefined' && facesGroup) {
        facesGroup.traverse(obj => { if (obj.isMesh) overrideObjectState(obj); });
    }
    if (typeof geometryGroup !== 'undefined' && geometryGroup) {
        geometryGroup.traverse(obj => { if (obj.isLine || obj.isPoints || obj.isMesh) overrideObjectState(obj); });
    }
    if (typeof mesh !== 'undefined' && mesh) {
        restoreList.push({ obj: mesh, visible: mesh.visible, material: mesh.material });
        mesh.visible = false;
    }

    // --- Helper: scan rendered pixels to find actual content bounding box ---
    // Returns { minX, maxX, minY, maxY } in pixel coords, or null if all white
    const scanContentBounds = () => {
        const gl = renderer.getContext();
        const w = squareSize;
        const h = squareSize;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // WebGL readPixels is bottom-left origin, so row 0 = bottom of image
        let minX = w, maxX = 0, minY = h, maxY = 0;
        let found = false;
        const WHITE_THRESH = 250; // pixels darker than this are "content"

        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const idx = (py * w + px) * 4;
                const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
                if (r < WHITE_THRESH || g < WHITE_THRESH || b < WHITE_THRESH) {
                    // Flip Y: WebGL row py=0 is screen bottom, so screen Y = (h-1-py)
                    const screenY = (h - 1 - py);
                    if (px < minX) minX = px;
                    if (px > maxX) maxX = px;
                    if (screenY < minY) minY = screenY;
                    if (screenY > maxY) maxY = screenY;
                    found = true;
                }
            }
        }

        return found ? { minX, maxX, minY, maxY } : null;
    };

    const exportCenteredCrop = (bounds) => {
        if (!bounds) return '';
        const rawW = Math.max(1, bounds.maxX - bounds.minX + 1);
        const rawH = Math.max(1, bounds.maxY - bounds.minY + 1);
        const paddedSpan = Math.max(rawW, rawH) * 1.16;
        const contentCX = (bounds.minX + bounds.maxX) / 2;
        const contentCY = (bounds.minY + bounds.maxY) / 2;

        const out = document.createElement('canvas');
        out.width = WIREFRAME_TARGET_WIDTH;
        out.height = WIREFRAME_TARGET_WIDTH;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const scale = out.width / Math.max(1, paddedSpan);
        const drawW = squareSize * scale;
        const drawH = squareSize * scale;
        const dx = (out.width / 2) - (contentCX * scale);
        const dy = (out.height / 2) - (contentCY * scale);
        ctx.drawImage(
            renderer.domElement,
            0, 0, squareSize, squareSize,
            dx, dy, drawW, drawH
        );
        return out.toDataURL('image/jpeg', WIREFRAME_JPEG_QUALITY);
    };

    // 6) Render the 4 views
    const images = [];
    let contentfulViews = 0;
    const captureElevationDeg = 62;
    const polarAngle = THREE.MathUtils.degToRad(90 - captureElevationDeg);
    const views = [
        { az: -Math.PI / 4,      label: "Southwest" },
        { az: Math.PI / 4,       label: "Southeast" },
        { az: -3 * Math.PI / 4,  label: "Northwest" },
        { az: 3 * Math.PI / 4,   label: "Northeast" }
    ];

    const oldTarget = (controls && controls.target) ? controls.target.clone() : new THREE.Vector3();
    const oldPos = camera.position.clone();
    const MARGIN = 0.10; // 10% margin on each side
    const EDGE_GUARD = Math.max(18, Math.round(squareSize * 0.035));
    const TARGET_SPAN = squareSize * (1 - 2 * MARGIN);
    const MAX_FIT_PASSES = 10;

    const boundsTouchesFrame = (bounds) => {
        if (!bounds) return false;
        return (
            bounds.minX <= EDGE_GUARD ||
            bounds.minY <= EDGE_GUARD ||
            bounds.maxX >= squareSize - 1 - EDGE_GUARD ||
            bounds.maxY >= squareSize - 1 - EDGE_GUARD
        );
    };

    const setCameraDistanceFromTarget = (target, nextDistance) => {
        const dir = new THREE.Vector3().subVectors(camera.position, target).normalize();
        camera.position.copy(target).addScaledVector(dir, nextDistance);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
    };

    for (let i = 0; i < 4; i++) {
        const v = views[i];
        const x = center.x + dist * Math.sin(polarAngle) * Math.sin(v.az);
        const y = center.y + dist * Math.cos(polarAngle);
        const z = center.z + dist * Math.sin(polarAngle) * Math.cos(v.az);

        let lookTarget = center.clone();
        camera.position.set(x, y, z);
        camera.lookAt(lookTarget);
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();

        // FIRST RENDER — get an initial image to scan
        let bounds = null;
        for (let fitPass = 0; fitPass < MAX_FIT_PASSES; fitPass++) {
            rebuildTubeGroupForCurrentCamera(WIREFRAME_LINE_PIXEL_WIDTH);
            renderer.render(scene, camera);
            bounds = scanContentBounds();
            if (!bounds) break;
            const initialContentW = bounds.maxX - bounds.minX;
            const initialContentH = bounds.maxY - bounds.minY;
            const initialContentSpan = Math.max(initialContentW, initialContentH);
            const initiallyClipped = boundsTouchesFrame(bounds);
            if (initiallyClipped) {
                const currentDist = camera.position.distanceTo(lookTarget);
                const zoomRatio = Math.max(initialContentSpan / TARGET_SPAN, 1.35);
                setCameraDistanceFromTarget(lookTarget, Math.max(1, Math.min(currentDist * zoomRatio, MAX_CAPTURE_DISTANCE)));
                continue;
            }
            const contentCX = (bounds.minX + bounds.maxX) / 2;
            const contentCY = (bounds.minY + bounds.maxY) / 2;
            const canvasCX = squareSize / 2;
            const canvasCY = squareSize / 2;

            // How far off-center is the content? (in NDC: -1 to 1)
            const offsetNdcX = ((contentCX - canvasCX) / squareSize) * 2;
            const offsetNdcY = -((contentCY - canvasCY) / squareSize) * 2; // flip Y for NDC

            const camRight = new THREE.Vector3();
            const camUp = new THREE.Vector3();
            const camFwd = new THREE.Vector3();
            camera.matrixWorld.extractBasis(camRight, camUp, camFwd);

            const d = camera.position.distanceTo(lookTarget);
            const fovRad = THREE.MathUtils.degToRad(camera.fov);
            const halfH = d * Math.tan(fovRad / 2);
            const halfW = halfH; // aspect is 1.0

            lookTarget.addScaledVector(camRight, offsetNdcX * halfW);
            lookTarget.addScaledVector(camUp, offsetNdcY * halfH);

            camera.lookAt(lookTarget);
            camera.updateMatrixWorld();
            camera.updateProjectionMatrix();

            // Zoom: scale distance so content fills (1 - 2*MARGIN) of the frame
            const contentW = bounds.maxX - bounds.minX;
            const contentH = bounds.maxY - bounds.minY;
            const contentSpan = Math.max(contentW, contentH);
            const clipped = boundsTouchesFrame(bounds);

            if (contentSpan > 1 && TARGET_SPAN > 1) {
                let zoomRatio = contentSpan / TARGET_SPAN;
                if (clipped) zoomRatio = Math.max(zoomRatio, 1.35);
                if (Math.abs(zoomRatio - 1) < 0.018 && !clipped) break;
                const currentDist = camera.position.distanceTo(lookTarget);
                const newDist = currentDist * zoomRatio;
                setCameraDistanceFromTarget(lookTarget, Math.max(1, Math.min(newDist, MAX_CAPTURE_DISTANCE)));
            } else if (!clipped) {
                break;
            }

            // SECOND RENDER — the final, centered and zoomed version
        }

        rebuildTubeGroupForCurrentCamera(WIREFRAME_LINE_PIXEL_WIDTH);
        renderer.render(scene, camera);
        bounds = scanContentBounds() || bounds;

        if (bounds) contentfulViews++;

        images.push({
            img: bounds ? exportCenteredCrop(bounds) : '',
            label: v.label
        });
    }

    // 7) RESTORE STATE
    // Remove temporary tube meshes and dispose geometry/material
    clearTubeGroup();
    scene.remove(tubeGroup);
    uniformGrayMat.dispose();
    tubeMat.dispose();

    scene.background = originalBg || null;
    
    restoreList.forEach(item => {
        if (item.obj) {
            item.obj.visible = item.visible;
            item.obj.material = item.material;
            item.obj.renderOrder = item.renderOrder || 0;
        }
    });

    camera.position.copy(oldPos);
    if (controls && controls.target) controls.target.copy(oldTarget);
    if (typeof window.sync3DViewportSize === 'function') {
        window.sync3DViewportSize();
    } else {
        renderer.setSize(origCanvasW, origCanvasH, false);
        camera.aspect = origCanvasW / Math.max(origCanvasH, 1);
        camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);

    if (contentfulViews < 4 && attempt < 3) {
        console.warn(`[PDF 3D] Wireframe capture attempt ${attempt} produced ${contentfulViews}/4 contentful views. Retrying...`);
        await waitForPdfWireframeSceneReady(3000);
        await waitForPdfAnimationFrames(2);
        const retryImages = await captureWireframeViews(attempt + 1);
        if (managesLoader) setPdf3DWireframeCaptureLoader(false);
        return retryImages;
    }

    if (contentfulViews === 0) {
        console.warn('[PDF 3D] Wireframe capture stayed blank after retries. Skipping 3D facet images for this run.');
        if (managesLoader) setPdf3DWireframeCaptureLoader(false);
        return [];
    }

    if (managesLoader) setPdf3DWireframeCaptureLoader(false);
    return images;
}

function downscalePdfWireframeCanvas(srcCanvas, targetWidth = 800, quality = 0.60) {
    if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return '';
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    if (srcW <= targetWidth) {
        return srcCanvas.toDataURL('image/jpeg', quality);
    }

    const ratio = srcH / srcW;
    const downCanvas = document.createElement('canvas');
    downCanvas.width = targetWidth;
    downCanvas.height = Math.max(1, Math.round(targetWidth * ratio));
    const dCtx = downCanvas.getContext('2d');
    dCtx.imageSmoothingEnabled = true;
    dCtx.imageSmoothingQuality = 'high';
    dCtx.drawImage(srcCanvas, 0, 0, downCanvas.width, downCanvas.height);
    return downCanvas.toDataURL('image/jpeg', quality);
}

function isPdfWireframeDataUrlCandidate(dataUrl) {
    return typeof dataUrl === 'string' && /^data:image\/(?:jpeg|jpg|png);base64,/i.test(dataUrl) && dataUrl.length > 256;
}

async function pdfImageDataUrlHasVisibleInk(dataUrl) {
    if (!isPdfWireframeDataUrlCandidate(dataUrl)) return false;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const probe = document.createElement('canvas');
                probe.width = Math.max(1, Math.min(96, img.naturalWidth || img.width || 96));
                probe.height = Math.max(1, Math.min(96, img.naturalHeight || img.height || 96));
                const ctx = probe.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, probe.width, probe.height);
                ctx.drawImage(img, 0, 0, probe.width, probe.height);
                resolve(pdfCanvasHasVisibleInk(probe));
            } catch (e) {
                console.warn('[PDF 3D] Unable to inspect wireframe image contents:', e);
                resolve(true);
            }
        };
        img.onerror = () => resolve(false);
        img.src = dataUrl;
    });
}

async function pdfWireframeSetHasVisibleInk(wireframes) {
    if (!Array.isArray(wireframes) || wireframes.length !== 4) return false;

    for (const item of wireframes) {
        if (!item || !(await pdfImageDataUrlHasVisibleInk(item.img))) {
            return false;
        }
    }
    return true;
}

function collectPdfWireframeFaces(state) {
    if (state && Array.isArray(state.facesData) && state.facesData.length) {
        return state.facesData.filter(face => face && Array.isArray(face.points) && face.points.length >= 3);
    }

    if (state && state.geometry && Array.isArray(state.geometry.connections) && state.geometry.connections.length) {
        return state.geometry.connections
            .map(conn => {
                const a = conn && (conn.start || (Array.isArray(conn.points) ? conn.points[0] : null));
                const b = conn && (conn.end || (Array.isArray(conn.points) ? conn.points[1] : null));
                return (a && b) ? { points: [a, b] } : null;
            })
            .filter(Boolean);
    }

    return [];
}

function getPdfWireframeRadiusMeters(state) {
    const candidates = [
        Number(state && state.radiusMeters),
        Number(window.currentProjectManifest && window.currentProjectManifest.radius_meters),
        (typeof window.getRadiusMeters === 'function') ? Number(window.getRadiusMeters()) : NaN,
        Number(window.RADIUS_METERS)
    ];
    const radius = candidates.find(value => Number.isFinite(value) && value > 0);
    return radius || 20;
}

function buildPdfWireframeProjectionContext(state, faces) {
    const dims = (state && state.dims && typeof state.dims === 'object') ? state.dims : {};
    const w = Math.max(1, Number(dims.w) || Number(dims.width) || 1);
    const h = Math.max(1, Number(dims.h) || Number(dims.height) || 1);
    const radiusMeters = getPdfWireframeRadiusMeters(state);
    const zScale = 2.0 * (20 / radiusMeters);

    const zValues = [];
    let minSceneX = Infinity;
    let maxSceneX = -Infinity;
    let minSceneZ = Infinity;
    let maxSceneZ = -Infinity;

    (faces || []).forEach(face => {
        (face.points || []).forEach(point => {
            if (!point) return;
            const px = Number(point.x);
            const py = Number(point.y);
            const pz = Number(point.z);
            if (Number.isFinite(pz)) zValues.push(pz);
            if (Number.isFinite(px) && Number.isFinite(py)) {
                const sceneX = (px / w - 0.5) * 100;
                const sceneZ = (py / h - 0.5) * 100;
                minSceneX = Math.min(minSceneX, sceneX);
                maxSceneX = Math.max(maxSceneX, sceneX);
                minSceneZ = Math.min(minSceneZ, sceneZ);
                maxSceneZ = Math.max(maxSceneZ, sceneZ);
            }
        });
    });

    const zBounds = {
        min: zValues.length ? Math.min(...zValues) : 0,
        max: zValues.length ? Math.max(...zValues) : 0
    };
    const zRange = Math.max(0, zBounds.max - zBounds.min);
    const horizontalSpan = Math.max(
        1,
        Number.isFinite(minSceneX) && Number.isFinite(maxSceneX) ? (maxSceneX - minSceneX) : 0,
        Number.isFinite(minSceneZ) && Number.isFinite(maxSceneZ) ? (maxSceneZ - minSceneZ) : 0
    );
    const rawVerticalSpan = zRange * zScale;
    const maxVerticalSpan = Math.max(12, horizontalSpan * 0.9);
    const verticalClamp = rawVerticalSpan > maxVerticalSpan && rawVerticalSpan > 0
        ? (maxVerticalSpan / rawVerticalSpan)
        : 1;

    return {
        faces,
        dims: { w, h },
        zBounds,
        radiusMeters,
        zScale,
        effectiveZScale: zScale * verticalClamp,
        verticalClamp,
        rawVerticalSpan,
        maxVerticalSpan,
        horizontalSpan,
        elevationOffset: 0.1
    };
}

function normalizePdfWireframePoint(point, projectionContext) {
    const dims = (projectionContext && projectionContext.dims) || {};
    const zBounds = (projectionContext && projectionContext.zBounds) || { min: 0, max: 0 };
    const w = Math.max(1, Number(dims && dims.w) || Number(dims && dims.width) || 1);
    const h = Math.max(1, Number(dims && dims.h) || Number(dims && dims.height) || 1);
    const x = ((Number(point.x) || 0) / w - 0.5) * 100;
    const z = ((Number(point.y) || 0) / h - 0.5) * 100;
    const rawY = Number(point.z);
    const hasHeight = Number.isFinite(rawY) && Number.isFinite(zBounds.min) && Number.isFinite(zBounds.max) && zBounds.max > zBounds.min;
    const y = hasHeight ? ((rawY - zBounds.min) * projectionContext.effectiveZScale) + projectionContext.elevationOffset : 0;
    return { x, y, z };
}

function createFallbackPdfWireframeCanvas(state, view, projectionContext = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const faces = (projectionContext && Array.isArray(projectionContext.faces))
        ? projectionContext.faces
        : collectPdfWireframeFaces(state);
    if (!faces.length) return canvas;
    const context = projectionContext || buildPdfWireframeProjectionContext(state, faces);

    const az = Number(view && view.az) || 0;
    const sin = Math.sin(az);
    const cos = Math.cos(az);
    const fallbackElevationRad = Math.PI * 62 / 180;
    const fallbackDepthScale = Math.cos(fallbackElevationRad);
    const fallbackHeightScale = Math.sin(fallbackElevationRad);
    const projectedFaces = faces.map((face, faceIndex) => {
        const points = (face.points || []).map(point => {
            const p = normalizePdfWireframePoint(point, context);
            const screenX = p.x * cos - p.z * sin;
            const depth = p.x * sin + p.z * cos;
            const screenY = depth * fallbackDepthScale - p.y * fallbackHeightScale;
            const cameraDepth = depth * fallbackDepthScale + p.y * fallbackHeightScale;
            return { x: screenX, y: screenY, depth: cameraDepth };
        });
        const avgDepth = points.reduce((sum, p) => sum + p.depth, 0) / Math.max(1, points.length);
        return { points, avgDepth, faceIndex };
    }).filter(face => face.points.length >= 2);

    if (!projectedFaces.length) return canvas;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    projectedFaces.forEach(face => {
        face.points.forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        });
    });

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((canvas.width * 0.78) / spanX, (canvas.height * 0.72) / spanY);
    const offsetX = (canvas.width - spanX * scale) / 2 - minX * scale;
    const offsetY = (canvas.height - spanY * scale) / 2 - minY * scale;

    const toCanvas = p => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY });
    projectedFaces.sort((a, b) => a.avgDepth - b.avgDepth);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    projectedFaces.forEach(face => {
        const points = face.points.map(toCanvas);
        if (points.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            ctx.closePath();
            ctx.fillStyle = '#e3e3e3';
            ctx.fill();
            ctx.strokeStyle = '#202124';
            ctx.lineWidth = 3;
            ctx.stroke();
        } else if (points.length === 2) {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
            ctx.strokeStyle = '#202124';
            ctx.lineWidth = 4;
            ctx.stroke();
        }
    });

    return canvas;
}

function createFallbackPdfWireframesFromState(state) {
    const faces = collectPdfWireframeFaces(state);
    const projectionContext = buildPdfWireframeProjectionContext(state, faces);
    console.warn('[PDF 3D] Fallback wireframe scale', {
        radiusMeters: projectionContext.radiusMeters,
        zRange: Math.round((projectionContext.zBounds.max - projectionContext.zBounds.min) * 1000) / 1000,
        zScale: Math.round(projectionContext.zScale * 1000) / 1000,
        effectiveZScale: Math.round(projectionContext.effectiveZScale * 1000) / 1000,
        verticalClamp: Math.round(projectionContext.verticalClamp * 1000) / 1000,
        rawVerticalSpan: Math.round(projectionContext.rawVerticalSpan * 1000) / 1000,
        horizontalSpan: Math.round(projectionContext.horizontalSpan * 1000) / 1000
    });

    const views = [
        { az: -Math.PI / 4,      label: 'Southwest' },
        { az: Math.PI / 4,       label: 'Southeast' },
        { az: -3 * Math.PI / 4,  label: 'Northwest' },
        { az: 3 * Math.PI / 4,   label: 'Northeast' }
    ];

    return views.map(view => {
        const canvas = createFallbackPdfWireframeCanvas(state, view, projectionContext);
        return {
            label: view.label,
            img: downscalePdfWireframeCanvas(canvas, 800, 0.72)
        };
    });
}

async function ensurePdfWireframesForState(state, options = {}) {
    if (!state || typeof state !== 'object') return [];
    if (await pdfWireframeSetHasVisibleInk(state.wireframes)) return state.wireframes;

    const allowLiveCapture = options.allowLiveCapture !== false;
    if (allowLiveCapture && typeof captureWireframeViews === 'function') {
        try {
            const liveWireframes = await captureWireframeViews();
            if (await pdfWireframeSetHasVisibleInk(liveWireframes)) {
                state.wireframes = liveWireframes;
                return state.wireframes;
            }
        } catch (e) {
            console.warn('[PDF 3D] Live wireframe recapture failed; using geometry fallback.', e);
        }
    }

    const fallbackWireframes = createFallbackPdfWireframesFromState(state);
    if (await pdfWireframeSetHasVisibleInk(fallbackWireframes)) {
        console.warn('[PDF 3D] Using geometry-derived fallback wireframes because the WebGL capture was blank or unavailable.');
        state.wireframes = fallbackWireframes;
        return state.wireframes;
    }

    state.wireframes = [];
    return state.wireframes;
}
window.ensurePdfWireframesForState = ensurePdfWireframesForState;




function drawSummaryPageLayout(doc, report, imgData, imgRatio, x, y, w, facetCount, manualWastePct) {
    const hasManualWaste = manualWastePct !== null && typeof manualWastePct !== 'undefined' && Number.isFinite(Number(manualWastePct));
    manualWastePct = hasManualWaste
        ? Math.max(0, Math.round(Number(manualWastePct)))
        : calculateSuggestedWasteFromFacetCount(facetCount, calculateReportHipLengthFt(report));

    let cursorY = y + 8; 
    const squaresData = report.materials.squares;
    let totalSq = 0;
    Object.keys(squaresData).forEach(k => { if(typeof squaresData[k]==='number') totalSq += squaresData[k]; });
    emitPdfDebug('page:summary:text-source', {
        totalSquares: roundPdfDebugValue(totalSq),
        pitchBreakdown: buildPdfPitchDebugBreakdown(squaresData)
    });
    
    const pitches = Object.keys(squaresData).sort((a,b) => parseInt(a)-parseInt(b));
    let domPitch = null; let maxArea = -1;
    pitches.forEach(p => { 
        const val = squaresData[p];
        if(typeof val === 'number' && val > maxArea){maxArea=val; domPitch=p;} 
    });

    // --- PITCH TABLE (Card Style) ---
    const colCount = pitches.length + 1; 
    const pitchTableW = Math.min(w, colCount * 25);
    const pitchTableX = x + (w - pitchTableW) / 2;
    const colW = pitchTableW / colCount;
    const pitchTableH = 27;

    // Draw card behind pitch table — sized to table, not full width
    drawPdfCard(doc, pitchTableX, cursorY - 2, pitchTableW, pitchTableH, 3);

    doc.setFontSize(9); doc.setTextColor(0);
    doc.setFont("Montserrat", "bold"); doc.text("Pitch", pitchTableX+4, cursorY+5);
    pitches.forEach((p,i)=>doc.text(p, pitchTableX+((i+1)*colW)+(colW/2), cursorY+5, {align:'center'}));
    cursorY += 8;
    
    doc.text("Area (sq ft)", pitchTableX+4, cursorY+5); doc.setFont("Montserrat", "normal");
    pitches.forEach((p,i)=>{
        if(p===domPitch) doc.setFont("Montserrat","bold"); else doc.setFont("Montserrat","normal");
        const val = squaresData[p];
        const disp = (typeof val === 'number') ? Math.round(val*100).toLocaleString() : "0";
        doc.text(disp, pitchTableX+((i+1)*colW)+(colW/2), cursorY+5, {align:'center'});
    });
    cursorY += 8;

    doc.setFont("Montserrat","bold"); doc.text("Percent", pitchTableX+4, cursorY+5); doc.setFont("Montserrat","normal");
    pitches.forEach((p,i)=>{
        if(p===domPitch) doc.setFont("Montserrat","bold"); else doc.setFont("Montserrat","normal");
        const val = squaresData[p];
        const pct = (totalSq > 0 && typeof val === 'number') ? Math.round((val/totalSq)*100) : 0;
        doc.text(pct+"%", pitchTableX+((i+1)*colW)+(colW/2), cursorY+5, {align:'center'});
    });
    cursorY += 16; 

    // --- WASTE TABLE (Card Style) ---
    let wastes = getGafSummaryWasteOptions(manualWastePct);

    const suggestedIdx = wastes.indexOf(manualWastePct);
    
    const wastePad = 6; // Left/right padding inside card
    const wasteInnerW = w - (wastePad * 2);
    const wasteColW = wasteInnerW / (wastes.length + 1);
    const wasteContentX = x + wastePad; // Content starts with padding
    const highlightX = wasteContentX + ((suggestedIdx+1)*wasteColW);
    const wasteTableH = 28;
    
    // Draw card behind waste table
    drawPdfCard(doc, x, cursorY - 2, w, wasteTableH, 3);

    // Draw subtle inner grid lines
    doc.setDrawColor(230, 230, 230); 
    doc.setLineWidth(0.1); 

    for(let i=1; i <= wastes.length; i++) {
        const lineX = wasteContentX + (i * wasteColW);
        doc.line(lineX, cursorY, lineX, cursorY + 24);
    }

    doc.line(wasteContentX, cursorY + 8, wasteContentX + wasteInnerW, cursorY + 8); 
    doc.line(wasteContentX, cursorY + 16, wasteContentX + wasteInnerW, cursorY + 16);

    // Highlight the Manual/Suggested Waste Column with primary color border
    if (suggestedIdx !== -1) {
        doc.setDrawColor(200,40,40); 
        doc.setLineWidth(0.7);
        doc.roundedRect(highlightX, cursorY - 1, wasteColW, 26, 1, 1, 'S');
    }

    doc.setFont("Montserrat","bold"); doc.setTextColor(0); doc.text("Waste", wasteContentX+2, cursorY+5);
    wastes.forEach((v,i)=>doc.text(v+"%", wasteContentX+((i+1)*wasteColW)+(wasteColW/2), cursorY+5, {align:'center'}));
    cursorY+=8;
    
    doc.text("Area (sq ft)", wasteContentX+2, cursorY+5); doc.setFont("Montserrat","normal");
    wastes.forEach((v,i)=>{
        if(i===suggestedIdx) doc.setFont("Montserrat","bold"); else doc.setFont("Montserrat","normal");
        doc.text(Math.round(totalSq*100*(1+v/100)).toLocaleString(), wasteContentX+((i+1)*wasteColW)+(wasteColW/2), cursorY+5, {align:'center'});
    });
    cursorY+=8;

    doc.setFont("Montserrat","bold"); doc.text("Squares", wasteContentX+2, cursorY+5); doc.setFont("Montserrat","normal");
    wastes.forEach((v,i)=>{
        if(i===suggestedIdx) doc.setFont("Montserrat","bold"); else doc.setFont("Montserrat","normal");
        doc.text(Math.ceil(totalSq*(1+v/100)).toString(), wasteContentX+((i+1)*wasteColW)+(wasteColW/2), cursorY+5, {align:'center'});
    });
    cursorY+=16;

    const statsW = 40;
    const imgAvail = w - statsW - 15;
    const imgDims = placeImageOnPage(doc, imgData, imgRatio, imgAvail, 130, x, cursorY);
    
    const statsX = x + imgAvail + 10;
    let statsY = cursorY + 5; 
    
    // --- UPDATED HELPER: Accepts 'showLine' parameter (defaults to true) ---
    const addStat = (l, v, showLine = true) => {
        doc.setFontSize(9); 
        doc.setFont("Montserrat","bold"); 
        doc.text(l, statsX, statsY);
        
        doc.setFont("Montserrat","normal"); 
        doc.text(v, statsX + statsW, statsY, {align:'right'});
        
        if (showLine) {
            doc.setDrawColor(230, 230, 230); 
            doc.line(statsX, statsY + 2, statsX + statsW, statsY + 2); 
        }
        statsY += 8;
    };
    
    statsY += 3;
    const lin = report.materials.linear;
    
    const skyCount = countSkylights(report);
    const chimCount = countChimneys(report);

    // Counter Flashing = sum of all chimney line types
    const counterFlashing = Math.round((lin.chimney_edge || 0) + (lin.chimney_back || 0) + (lin.chimney_front || 0));

    // --- Build dynamic stat rows (only non-zero values shown) ---
    const statRows = [];

    // Always show these
    statRows.push(["Roof Area", Math.round(totalSq * 100) + " sq ft"]);
    statRows.push(["Facets", facetCount.toString()]);
    statRows.push(["Pitch", domPitch ? domPitch.replace(/\//g, " / ") : "N/A"]);

    // Counts — only if non-zero
    if (skyCount > 0)  statRows.push(["Skylights", skyCount.toString()]);
    if (chimCount > 0) statRows.push(["Chimneys", chimCount.toString()]);

    // Line types — map id to proper label, only show non-zero
    const lineStatTypes = [
        { id: 'ridge',          label: 'Ridge' },
        { id: 'hip',            label: 'Hip' },
        { id: 'valley',         label: 'Valley' },
        { id: 'rake',           label: 'Rake' },
        { id: 'eave',           label: 'Eave' },
        { id: 'head_wall',      label: 'Headwall Flashing' },
        { id: 'side_wall',      label: 'Sidewall Flashing' },
        { id: 'trans',          label: 'Transition' },
        { id: 'parapet',        label: 'Parapet Wall' },
        { id: 'protrusion',     label: 'Protrusion' },
        { id: 'chimney_back',   label: 'Chimney Back Pan' },
        { id: 'chimney_edge',   label: 'Chimney Step' },
        { id: 'chimney_front',  label: 'Chimney Apron' }
    ];

    lineStatTypes.forEach(t => {
        const val = Math.round(lin[t.id] || 0);
        if (val > 0) statRows.push([t.label, val + " ft"]);
    });

    // Counter Flashing — only if non-zero
    if (counterFlashing > 0) statRows.push(["Counter Flashing", counterFlashing + " ft"]);

    // --- Size the card dynamically to fit rows ---
    const rowHeight = 8;
    const cardPad = 6;  // equal padding top and bottom
    const cardH = cardPad + ((statRows.length - 1) * rowHeight) + cardPad;
    const cardTopY = statsY - cardPad;

    drawPdfCard(doc, statsX - 2, cardTopY, statsW + 4, cardH, 3);

    // --- Draw all rows ---
    statRows.forEach((row, idx) => {
        const isLast = (idx === statRows.length - 1);
        addStat(row[0], row[1], !isLast);
    });


    const footer = "Measurements rounded. Waste guidance only. Installer to verify.";
    doc.setFontSize(6); doc.setTextColor(80);
    doc.text(footer, x, doc.internal.pageSize.getHeight()-28);

}


// ─────────────────────────────────────────────────────────────────────────────
// Gutter PDF Page
// ─────────────────────────────────────────────────────────────────────────────

async function drawGutterPage(doc, state, metrics, x, y, w, h, brandingColors) {
    const gap = 5;
    const summaryH = 28;
    const directionH = 28;
    const diagramH = Math.max(90, h - summaryH - directionH - (gap * 2));
    const metricW = (w - (gap * 2)) * 0.23;
    const metric2X = x + metricW + gap;
    const summaryRightX = metric2X + metricW + gap;
    const summaryRightW = w - (metricW * 2) - (gap * 2);
    const diagramY = y + summaryH + gap;
    const directionY = diagramY + diagramH + gap;
    const pColor = (brandingColors && brandingColors.primary)
        ? brandingColors.primary
        : { r: 200, g: 40, b: 40 };

    const drawMetricCard = (bx, title, value, suffix = '') => {
        drawSummaryBox(doc, bx, y, metricW, summaryH, title);
        doc.setFont("Montserrat", "bold");
        doc.setFontSize(16);
        doc.setTextColor(pColor.r, pColor.g, pColor.b);
        doc.text(`${value}${suffix}`, bx + (metricW / 2), y + 20, { align: 'center' });
    };

    drawMetricCard(x, "Active Gutter", Math.round(metrics.totalLengthFt).toLocaleString(), ' ft');
    drawMetricCard(metric2X, "Downspouts", String(metrics.estimatedDownspouts));

    drawSummaryBox(doc, summaryRightX, y, summaryRightW, summaryH, "Miter Counts");
    const miterCols = [
        { label: 'Outside 90', value: metrics.miterCounts.outside90, color: PDF_GUTTER_MITER_COLORS.outside90 },
        { label: 'Inside 90', value: metrics.miterCounts.inside90, color: PDF_GUTTER_MITER_COLORS.inside90 },
        { label: 'Non-90', value: metrics.miterCounts.non90, color: PDF_GUTTER_MITER_COLORS.non90 }
    ];
    const miterColW = summaryRightW / miterCols.length;
    miterCols.forEach((col, index) => {
        const colX = summaryRightX + (miterColW * index);
        if (index > 0) {
            doc.setDrawColor(228, 228, 228);
            doc.setLineWidth(0.25);
            doc.line(colX, y + 9, colX, y + summaryH - 3);
        }
        const rgb = hexToRgbReport(col.color);
        doc.setFillColor(rgb.r, rgb.g, rgb.b);
        doc.circle(colX + 8, y + 14, 1.8, 'F');
        doc.setFont("Montserrat", "normal");
        doc.setFontSize(7);
        doc.setTextColor(105);
        doc.text(col.label, colX + 12, y + 15);
        doc.setFont("Montserrat", "bold");
        doc.setFontSize(15);
        doc.setTextColor(rgb.r, rgb.g, rgb.b);
        doc.text(String(col.value), colX + 8, y + 23);
    });

    drawSummaryBox(doc, x, diagramY, w, diagramH, "Gutter Diagram");
    const legendY = diagramY + 11;
    const legendItems = [
        { kind: 'line', label: 'Run', color: '#1a73e8' },
        { kind: 'dot', label: 'Out 90', color: PDF_GUTTER_MITER_COLORS.outside90 },
        { kind: 'dot', label: 'In 90', color: PDF_GUTTER_MITER_COLORS.inside90 },
        { kind: 'dot', label: 'Non-90', color: PDF_GUTTER_MITER_COLORS.non90 }
    ];
    let legendX = x + 8;
    doc.setFont("Montserrat", "normal");
    doc.setFontSize(6.5);
    legendItems.forEach((item) => {
        if (item.kind === 'line') {
            const rgb = hexToRgbReport(item.color);
            doc.setDrawColor(rgb.r, rgb.g, rgb.b);
            doc.setLineWidth(1.0);
            doc.line(legendX, legendY, legendX + 8, legendY);
            legendX += 11;
        } else if (item.kind === 'dot') {
            const rgb = hexToRgbReport(item.color);
            doc.setFillColor(rgb.r, rgb.g, rgb.b);
            doc.circle(legendX + 2.5, legendY, 1.6, 'F');
            legendX += 7;
        }
        doc.setTextColor(100);
        doc.text(item.label, legendX, legendY + 1.3);
        legendX += doc.getTextWidth(item.label) + 8;
    });

    const gutterCanvas = await createGutterCanvas(state, metrics);
    const gutterImg = gutterCanvas.toDataURL('image/jpeg', 0.72);
    const gutterRatio = gutterCanvas.width / gutterCanvas.height;
    placeImageCentered(
        doc,
        gutterImg,
        gutterRatio,
        x + 3,
        diagramY + 15,
        diagramY + diagramH - 4,
        w - 6
    );
    drawPDFCompass(doc, x + 10, diagramY + 21, 3);

    drawSummaryBox(doc, x, directionY, w, directionH, "Stories By Direction");
    const dirColW = w / PDF_GUTTER_DIRECTIONS.length;
    PDF_GUTTER_DIRECTIONS.forEach((dir, index) => {
        const colX = x + (dirColW * index);
        const centerX = colX + (dirColW / 2);
        const storyText = String(metrics.directional[dir].stories || '').trim() || 'Not set';
        if (index > 0) {
            doc.setDrawColor(228, 228, 228);
            doc.setLineWidth(0.25);
            doc.line(colX, directionY + 8, colX, directionY + directionH - 5);
        }

        doc.setFont("Montserrat", "bold");
        doc.setFontSize(7.5);
        doc.setTextColor(60);
        doc.text(PDF_GUTTER_DIRECTION_LABELS[dir], centerX, directionY + 14.5, { align: 'center' });

        doc.setTextColor(storyText === 'Not set' ? 180 : pColor.r, storyText === 'Not set' ? 67 : pColor.g, storyText === 'Not set' ? 54 : pColor.b);
        if (storyText === 'Not set') {
            doc.setFont("Montserrat", "normal");
            doc.setFontSize(8);
            doc.text(storyText, centerX, directionY + 21.5, { align: 'center' });
        } else {
            doc.setFont("Montserrat", "bold");
            doc.setFontSize(14);
            doc.text(storyText, centerX, directionY + 21.5, { align: 'center' });
        }
    });

    doc.setTextColor(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN REPLACEMENT: drawVentilationPage  (in pdf.js) — v8
// ─────────────────────────────────────────────────────────────────────────────

async function drawVentilationPage(doc, report, est, x, y, w, state) {
    if (state.ventSettings && state.ventSettings.include === false) return;

    const RIDGE_VENT_RATING = 18;
    const BOX_VENT_RATING   = 50;
    const SOFFIT_FACTOR     = 0.98;

    const excluded = (state.ventSettings && state.ventSettings.excludedRidges) ? state.ventSettings.excludedRidges : [];
    
    // Fix: Force use of Company Default for ratio, ignoring editor state if needed
    const orgGen = window.projectOrganization?.report_settings?.general;
    const selectedRatio = (orgGen && orgGen.nfva_ratio) ? parseInt(orgGen.nfva_ratio) : 300;

    const roofSurfaceSqFt = (report.materials.totalSquares || 0) * 100;
    const footprintSqFt   = report.materials.totalFootprintSqFt || roofSurfaceSqFt;
    const atticArea        = report.materials.atticAreaSqFt || (footprintSqFt * SOFFIT_FACTOR);

    const activeRidgeLines = report.lines.filter((l, i) => l.type === 'ridge' && !excluded.includes(i));
    const totalRidgeFt = activeRidgeLines.reduce((acc, l) => acc + (l.length || 0), 0);

    const computeForRatio = (ratio) => {
        const totalNfvaSqIn = (atticArea / ratio) * 144;
        const reqExhaust = totalNfvaSqIn / 2;
        const reqIntake  = totalNfvaSqIn / 2;
        const ridgeCapacity = totalRidgeFt * RIDGE_VENT_RATING;
        const ridgeNeededFt = reqExhaust / RIDGE_VENT_RATING;
        const ridgeDeficit = Math.max(0, reqExhaust - ridgeCapacity);
        const supplementBoxVents = (ridgeDeficit > 0) ? Math.ceil(ridgeDeficit / BOX_VENT_RATING) : 0;
        const boxOnlyCount = Math.ceil(reqExhaust / BOX_VENT_RATING);
        const recommendRidge = (ridgeCapacity >= reqExhaust && totalRidgeFt >= 4);
        return { ratio, totalNfvaSqIn, reqExhaust, reqIntake, ridgeNeededFt,
                 ridgeCapacity, ridgeDeficit, supplementBoxVents, boxOnlyCount,
                 recommendRidge };
    };

    const data300 = computeForRatio(300);
    const data150 = computeForRatio(150);
    const selected = (selectedRatio === 150) ? data150 : data300;

    const pad = 8;
    const bClr = [200, 200, 200];
    const bW = 0.35;

    return new Promise(async resolve => {

        // ════════════════════════════════════════════════════
        // ROW 1: Attic Area + Recommended Exhaust & Intake
        // ════════════════════════════════════════════════════
        const atticBoxH = 24;
        drawSummaryBox(doc, x, y, w, atticBoxH, "Ventilation Summary");

        doc.setFontSize(8); doc.setFont("Montserrat", "normal"); doc.setTextColor(100);
        doc.text("Estimated Attic Area", x + pad, y + 13);
        doc.setFontSize(15); doc.setFont("Montserrat", "bold"); doc.setTextColor(217, 48, 37);
        doc.text(`${Math.round(atticArea).toLocaleString()} sq ft`, x + pad, y + 20);

        doc.setFontSize(6.5); doc.setFont("Montserrat", "normal"); doc.setTextColor(140);
        doc.text(`Footprint: ${Math.round(footprintSqFt).toLocaleString()} sq ft  |  Surface: ${Math.round(roofSurfaceSqFt).toLocaleString()} sq ft`, x + pad + 50, y + 20);

        // Right side: Exhaust + Intake stacked
        const rightSide = x + w - pad;

        doc.setFontSize(7); doc.setFont("Montserrat", "normal"); doc.setTextColor(100);
        doc.text("Recommended Exhaust", rightSide, y + 5, { align: 'right' });
        doc.setFontSize(12); doc.setFont("Montserrat", "bold"); doc.setTextColor(217, 48, 37);
        doc.text(`${Math.round(selected.reqExhaust)} sq in`, rightSide, y + 10, { align: 'right' });

        doc.setFontSize(7); doc.setFont("Montserrat", "normal"); doc.setTextColor(100);
        doc.text("Recommended Intake", rightSide, y + 15, { align: 'right' });
        doc.setFontSize(12); doc.setFont("Montserrat", "bold"); doc.setTextColor(217, 48, 37);
        doc.text(`${Math.round(selected.reqIntake)} sq in`, rightSide, y + 20, { align: 'right' });

        doc.setTextColor(0);

        // ════════════════════════════════════════════════════
        // ROW 2: LEFT = ratio table, RIGHT = vent options
        // ════════════════════════════════════════════════════
        let ry = y + atticBoxH + 5;
        const rowH = 32;
        const colGap = 5;
        const leftW = (w - colGap) * 0.45;
        const rightW = (w - colGap) * 0.55;
        const rightX = x + leftW + colGap;
        const titleBarH = 7;
        const contentTop = ry + titleBarH;
        const contentH = rowH - titleBarH;

        // ── Shared inset for fills so they don't overlap rounded borders ──
        const r = 2;       // corner radius
        const inset = 0.6; // fill inset from edges

        // ── Helper: draw a table box (shadow + fills first, then borders on top) ──
        const drawTableBox = (bx, by, bw, title, halfW, highlightColX, highlightFill) => {
            // 0) Shadow — offset slightly down-right, light gray
            doc.setFillColor(220, 220, 220);
            doc.roundedRect(bx + 1.5, by + 1.5, bw, rowH, r, r, 'F');

            // 1) White background fill (rounded)
            doc.setFillColor(255, 255, 255);
            doc.roundedRect(bx, by, bw, rowH, r, r, 'F');

            // 2) Title bar fill — inset so rounded corners show through
            doc.setFillColor(245, 245, 245);
            doc.rect(bx + inset, by + inset, bw - inset * 2, titleBarH - inset, 'F');

            // 3) Highlight column fill — inset from all edges it touches
            doc.setFillColor(...highlightFill);
            const isLeftCol = (highlightColX <= bx + 1);
            const isRightCol = (highlightColX + halfW >= bx + bw - 1);
            doc.rect(
                highlightColX + (isLeftCol ? inset : 0.15),
                contentTop + 0.15,
                halfW - (isLeftCol ? inset + 0.15 : 0) - (isRightCol ? inset + 0.15 : 0.15),
                contentH - inset - 0.15,
                'F'
            );

            // 4) Outer border on top (stroke only)
            doc.setDrawColor(...bClr); doc.setLineWidth(bW);
            doc.roundedRect(bx, by, bw, rowH, r, r, 'S');

            // 5) Title bar bottom line
            doc.line(bx, by + titleBarH, bx + bw, by + titleBarH);

            // 6) Vertical divider
            doc.line(bx + halfW, contentTop, bx + halfW, by + rowH);

            // 7) Title text
            doc.setFontSize(7.5); doc.setFont("Montserrat", "bold"); doc.setTextColor(80);
            doc.text(title, bx + 4, by + 4.8);
        };

        // ── LEFT TABLE: NFVA ──
        const ratioColW = leftW / 2;
        const rCol1X = x;
        const rCol2X = x + ratioColW;
        const selRColX = (selectedRatio === 300) ? rCol1X : rCol2X;

        drawTableBox(x, ry, leftW, "NFVA Requirement", ratioColW, selRColX, [235, 245, 255]);

        const drawRatioCol = (d, cx, isRec) => {
            let dy = contentTop + 6;

            // Left-aligned title
            doc.setFontSize(9); doc.setFont("Montserrat", "bold");
            doc.setTextColor(isRec ? 26 : 100, isRec ? 115 : 100, isRec ? 232 : 100);
            doc.text(`1/${d.ratio}`, cx + 3, dy);
            dy += 5;

            // Data
            doc.setFontSize(8); doc.setFont("Montserrat", "normal"); doc.setTextColor(60);
            doc.text(`NFVA: ${Math.round(d.totalNfvaSqIn)} sq in`, cx + 3, dy); dy += 3.5;
            doc.text(`Exhaust: ${Math.round(d.reqExhaust)} sq in`, cx + 3, dy); dy += 3.5;
            doc.text(`Intake: ${Math.round(d.reqIntake)} sq in`, cx + 3, dy);

            // "Recommended" at bottom, left-aligned
            if (isRec) {
                const recY = ry + rowH - 2.5;
                doc.setFontSize(7); doc.setFont("Montserrat", "bold"); doc.setTextColor(26, 115, 232);
                doc.text("Recommended", cx + 3, recY);
            }
        };

        drawRatioCol(data300, rCol1X, selectedRatio === 300);
        drawRatioCol(data150, rCol2X, selectedRatio === 150);

        // ── RIGHT TABLE: Exhaust Options ──
        const ventColW = rightW / 2;
        const vCol1X = rightX;
        const vCol2X = rightX + ventColW;
        const recVColX = selected.recommendRidge ? vCol1X : vCol2X;

        drawTableBox(rightX, ry, rightW, "Exhaust Options", ventColW, recVColX, [240, 252, 243]);

        const drawVentCol = (title, isRec, cx, lines) => {
            let dy = contentTop + 6;

            // Left-aligned title
            doc.setFontSize(9); doc.setFont("Montserrat", "bold");
            doc.setTextColor(isRec ? 52 : 80, isRec ? 168 : 80, isRec ? 83 : 80);
            doc.text(title, cx + 3, dy);
            dy += 5;

            // Data
            doc.setFontSize(8); doc.setFont("Montserrat", "normal"); doc.setTextColor(60);
            lines.forEach(l => { doc.text(l, cx + 3, dy); dy += 3.5; });

            // "Recommended" at bottom, left-aligned
            if (isRec) {
                const recY = ry + rowH - 2.5;
                doc.setFontSize(7); doc.setFont("Montserrat", "bold"); doc.setTextColor(52, 168, 83);
                doc.text("Recommended", cx + 3, recY);
            }
        };

        const ridgeLines = [];
        ridgeLines.push(`Needed: ${Math.round(selected.ridgeNeededFt)}' (@ 18"/lf)`);
        ridgeLines.push(`Available: ${Math.round(totalRidgeFt)}'`);
        if (selected.recommendRidge) {
            ridgeLines.push(`Capacity sufficient`);
        } else if (totalRidgeFt < 4) {
            ridgeLines.push(`Insufficient ridge`);
        } else {
            ridgeLines.push(`Deficit: ${Math.round(selected.ridgeDeficit)} sq in`);
        }

        const boxLines = [];
        boxLines.push(`Needed: ${selected.boxOnlyCount} vents`);
        boxLines.push(`${BOX_VENT_RATING} sq in NFA each`);
        boxLines.push(`Total: ${selected.boxOnlyCount * BOX_VENT_RATING} sq in`);

        drawVentCol("Ridge Vent", selected.recommendRidge, vCol1X, ridgeLines);
        drawVentCol("Box Vents", !selected.recommendRidge, vCol2X, boxLines);

        // ════════════════════════════════════════════════════
        // ROW 3: Intake Products Table
        // ════════════════════════════════════════════════════
        ry += rowH + 5;
        const intakeH = 40;
        drawSummaryBox(doc, x, ry, w, intakeH, "Recommended Intake Products");

        let iy = ry + 14;

        // Header row
        doc.setFillColor(245, 245, 245); doc.rect(x + 2, iy - 2, w - 4, 6, 'F');
        doc.setFontSize(8); doc.setFont("Montserrat", "bold"); doc.setTextColor(80);
        doc.text("Product", x + pad, iy + 2);
        doc.text("Rating", x + pad + 65, iy + 2);
        doc.text("Qty Needed", x + pad + 110, iy + 2);
        iy += 10;

        const drawIRow = (n, r, q) => {
            doc.setFont("Montserrat", "normal"); doc.setFontSize(8); doc.setTextColor(60);
            doc.text(n, x + pad, iy);
            doc.text(r, x + pad + 65, iy);
            doc.setFont("Montserrat", "bold");
            doc.text(q, x + pad + 110, iy);
            iy += 5.5;
        };
        const halfIn = Math.round(selected.reqIntake);
        drawIRow("Vented Drip Edge", "9 sq in/ft", `${Math.ceil(halfIn / 9)} ft`);
        drawIRow("Soffit Vent", "9 sq in/ft", `${Math.ceil(halfIn / 9)} ft`);
        drawIRow("Bird Blocks", "~3.5 sq in", `${Math.ceil(halfIn / 3.5)} ea`);

        // ════════════════════════════════════════════════════
        // ROW 4: Vent Canvas Image + Legend
        // ════════════════════════════════════════════════════
        ry += intakeH + 5;

        const ventMode = state.ventSettings && state.ventSettings.mode ? state.ventSettings.mode : (selected.recommendRidge ? 'ridge' : 'box');
        const drawRidge = ventMode !== 'box' && selected.recommendRidge;

        const ventData = {
            ratioUsed: selectedRatio,
            systemType: drawRidge ? 'Ridge Vent Sufficient' : 'Box Vents Only',
            reqExhaust: selected.reqExhaust,
            ridgeCapacity: Math.round(selected.ridgeCapacity),
            deficitSqIn: Math.round(selected.ridgeDeficit),
            boxVentsNeeded: drawRidge ? 0 : selected.boxOnlyCount,
            totalRidgeLen: totalRidgeFt
        };

        const vCvs = await createVentCanvas(report, state.cropRegion, ventData, state, excluded);
        const vImg = vCvs.toDataURL('image/jpeg', 0.40);
        const vRat = vCvs.width / vCvs.height;

        // Calculate available space between intake box and disclaimer
        const pageH = doc.internal.pageSize.getHeight();
        const disclaimerReserve = 30; // space for disclaimer at bottom
        const availH = pageH - 20 - disclaimerReserve - ry;
        const imgMaxH = Math.min(availH, 75);

        // Compute actual image dimensions to fit
        const imgR = 2; // corner radius
        const imgShadow = 1.5;
        let imgW, imgH;
        const keyContentW = 30; // fixed width for key block (swatch + text)
        const imgMaxW = w * 0.62;
        if (vRat >= (imgMaxW / imgMaxH)) {
            imgW = imgMaxW;
            imgH = imgW / vRat;
        } else {
            imgH = imgMaxH;
            imgW = imgH * vRat;
        }

        // Three equal gaps: [gap] KEY [gap] IMAGE [gap]
        const gap = (w - keyContentW - imgW) / 3;
        const keyLeftX = x + gap;
        const imgX = x + gap + keyContentW + gap;
        const imgY = ry + (availH - imgH) / 2;

        // Shadow
        doc.setFillColor(210, 210, 210);
        doc.roundedRect(imgX + imgShadow, imgY + imgShadow, imgW, imgH, imgR, imgR, 'F');

        // White background
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(imgX, imgY, imgW, imgH, imgR, imgR, 'F');

        // Clip image to rounded rect using raw PDF path operators
        const k = doc.internal.scaleFactor;
        const pH = doc.internal.pageSize.getHeight();
        const px = imgX * k;
        const py = (pH - imgY - imgH) * k;
        const pw = imgW * k;
        const ph = imgH * k;
        const pr = imgR * k;
        const kappa = 0.5522848;
        const kr = pr * kappa;
        const f2 = (n) => n.toFixed(2);

        doc.internal.write('q'); // save graphics state
        doc.internal.write(
            `${f2(px + pr)} ${f2(py)} m ` +
            `${f2(px + pw - pr)} ${f2(py)} l ` +
            `${f2(px + pw - pr + kr)} ${f2(py)} ${f2(px + pw)} ${f2(py + pr - kr)} ${f2(px + pw)} ${f2(py + pr)} c ` +
            `${f2(px + pw)} ${f2(py + ph - pr)} l ` +
            `${f2(px + pw)} ${f2(py + ph - pr + kr)} ${f2(px + pw - pr + kr)} ${f2(py + ph)} ${f2(px + pw - pr)} ${f2(py + ph)} c ` +
            `${f2(px + pr)} ${f2(py + ph)} l ` +
            `${f2(px + pr - kr)} ${f2(py + ph)} ${f2(px)} ${f2(py + ph - pr + kr)} ${f2(px)} ${f2(py + ph - pr)} c ` +
            `${f2(px)} ${f2(py + pr)} l ` +
            `${f2(px)} ${f2(py + pr - kr)} ${f2(px + pr - kr)} ${f2(py)} ${f2(px + pr)} ${f2(py)} c ` +
            'W n'
        );

        // Draw image full-bleed inside the clip
        doc.addImage(vImg, 'JPEG', imgX, imgY, imgW, imgH);

        doc.internal.write('Q'); // restore graphics state

        // Rounded border on top
        doc.setDrawColor(...bClr); doc.setLineWidth(bW);
        doc.roundedRect(imgX, imgY, imgW, imgH, imgR, imgR, 'S');

        // ── Key: always show both items ──
        const keyItemH = 8;
        const keyTotalH = 8 + keyItemH * 2;
        const keyTop = imgY + (imgH - keyTotalH) / 2;

        doc.setFontSize(8); doc.setFont("Montserrat", "bold"); doc.setTextColor(0);
        doc.text("Key", keyLeftX, keyTop);

        // Ridge Vent
        let keyY = keyTop + 7;
        doc.setDrawColor(255, 0, 0); doc.setLineWidth(1.5);
        doc.line(keyLeftX, keyY, keyLeftX + 10, keyY);
        doc.setTextColor(60); doc.setFont("Montserrat", "normal"); doc.setFontSize(7);
        doc.text("Ridge Vent", keyLeftX + 13, keyY + 1);

        // Box Vent
        keyY += keyItemH;
        doc.setFillColor(255, 152, 0);
        doc.rect(keyLeftX, keyY - 2.5, 5, 5, 'F');
        doc.setTextColor(60); doc.setFont("Montserrat", "normal"); doc.setFontSize(7);
        doc.text("Box Vent", keyLeftX + 13, keyY + 1);

        // ════════════════════════════════════════════════════
        // ROW 5: Disclaimer
        // ════════════════════════════════════════════════════
        const note = `Note: The estimated quantity of attic ventilation products in this report is based on the estimated attic floor area and is meant for estimating purposes only. It is the responsibility of the installer to verify the correct quantity and type of attic ventilation products prior to commencement of work. Installer must always review job-specific attic ventilation needs such as local code requirements, attic floor square footage, roof design, and conditioned spaces under the roof. GAF recommends a minimum of 1 square foot of attic ventilation (evenly split between intake and exhaust) for every 150\u2013300 square feet of attic floor space depending on vapor barrier status. The amount of exhaust ventilation at or near the ridge must never exceed the amount of intake ventilation at or near the soffit. See gaf.com/ventcalculator for details.`;

        doc.setFont("Montserrat", "normal"); doc.setFontSize(6); doc.setTextColor(90);
        const noteLines = doc.splitTextToSize(note, w);
        let noteY = pageH - 20 - (noteLines.length - 1) * 3.5;
        noteY = Math.max(noteY, pageH - 40);
        doc.text(noteLines, x, noteY);
        doc.setTextColor(0);

        resolve();
    });
}

// =============================================================================
// DROP-IN REPLACEMENT: drawNotesPage  (pdf.js)
// Changes from previous version:
//   1. Diagram card is now ~60% of height, notes card ~38% (was 38/58)
//   2. Removed the red left-margin accent line inside the notes card
// =============================================================================

async function drawNotesPage(doc, state, outlineImg, imgRatio, x, startY, availW, availH, brandingColors) {
    const GAP          = 5;   // gap between diagram card and notes card
    const CARD_RADIUS  = 3;
    const LINE_SPACING = 8;   // mm between ruled lines
    const SIDE_PAD     = 8;   // horizontal padding inside notes card
    const TOP_PAD      = 14;  // space for the "Notes" header inside card

    // ── Sizing: diagram gets ~60% of height, notes get the rest ──
    const diagCardH  = Math.round(availH * 0.60);
    const notesCardH = availH - diagCardH - GAP;

    // ── Primary color for accents ──
    const pColor = (brandingColors && brandingColors.primary)
        ? brandingColors.primary
        : { r: 200, g: 40, b: 40 };

    // ─────────────────────────────────────────────────────────────
    // SECTION A: Diagram Card
    // ─────────────────────────────────────────────────────────────
    const diagCardY = startY;

    // Shadow
    doc.setFillColor(230, 230, 230);
    doc.roundedRect(x + 1.5, diagCardY + 1.5, availW, diagCardH, CARD_RADIUS, CARD_RADIUS, 'F');

    // Card background
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, diagCardY, availW, diagCardH, CARD_RADIUS, CARD_RADIUS, 'FD');

    // Place the outline image centered within the card (with 3mm inset)
    const diagInset = 3;
    placeImageCentered(
        doc,
        outlineImg,
        imgRatio,
        x + diagInset,
        diagCardY + diagInset,
        diagCardY + diagCardH - diagInset,
        availW - diagInset * 2
    );

    // Small compass
    drawPDFCompass(doc, x + 10, diagCardY + 10, 3);

    // Key measurements pill — bottom-right of diagram card
    const netSquares = state.report.materials.totalSquares || 0;
    const wastePct   = (typeof state.manualWastePct === 'number') ? state.manualWastePct : 10;
    const withWaste  = Math.round(netSquares * (1 + wastePct / 100) * 100) / 100;

    let domPitch = "N/A";
    let maxArea = -1;
    const squaresData = state.report.materials.squares || {};
    Object.keys(squaresData).forEach(p => {
        const val = squaresData[p];
        if (typeof val === 'number' && val > maxArea) { maxArea = val; domPitch = p; }
    });

    const pillText = `${withWaste} sq  ·  ${domPitch}  ·  ${state.manualTotalFacets} facets`;
    doc.setFont("Montserrat", "bold");
    doc.setFontSize(7.5);

    const pillW  = doc.getTextWidth(pillText) + 10;
    const pillH  = 7;
    const pillR  = 3;
    const pillX  = x + availW - pillW - diagInset;
    const pillY  = diagCardY + diagCardH - pillH - diagInset;

    doc.setFillColor(pColor.r, pColor.g, pColor.b);
    doc.roundedRect(pillX, pillY, pillW, pillH, pillR, pillR, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(pillText, pillX + pillW / 2, pillY + pillH / 2 + 1, { align: 'center' });
    doc.setTextColor(0);

    // ─────────────────────────────────────────────────────────────
    // SECTION B: Notes Card
    // ─────────────────────────────────────────────────────────────
    const notesCardY = diagCardY + diagCardH + GAP;

    // Shadow
    doc.setFillColor(230, 230, 230);
    doc.roundedRect(x + 1.5, notesCardY + 1.5, availW, notesCardH, CARD_RADIUS, CARD_RADIUS, 'F');

    // Card background
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, notesCardY, availW, notesCardH, CARD_RADIUS, CARD_RADIUS, 'FD');

    // Left color strip (same style as drawSummaryBox)
    doc.setFillColor(pColor.r, pColor.g, pColor.b);
    const stripW = 2.0;
    const r      = CARD_RADIUS;
    const kappa  = r * 0.55228;

    doc.lines(
        [
            [(r - stripW), 0],
            [-kappa, 0, -r, (r - kappa), -r, r],
            [0, notesCardH - (r * 2)],
            [0, kappa, (r - kappa), r, r, r],
            [-(r - stripW), 0],
            [0, -notesCardH]
        ],
        x + stripW, notesCardY,
        [1, 1],
        'F',
        false
    );

    // "NOTES" header label
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.setFont("Montserrat", "bold");
    doc.text("NOTES", x + SIDE_PAD, notesCardY + 8);
    doc.setTextColor(0);

    // Thin separator under header
    doc.setDrawColor(235, 235, 235);
    doc.setLineWidth(0.25);
    doc.line(x + SIDE_PAD, notesCardY + TOP_PAD - 2, x + availW - SIDE_PAD, notesCardY + TOP_PAD - 2);

    // ── Ruled lines ──
    const ruledStartY = notesCardY + TOP_PAD + LINE_SPACING;
    const ruledEndY   = notesCardY + notesCardH - 5;
    const ruledLineX1 = x + SIDE_PAD;
    const ruledLineX2 = x + availW - SIDE_PAD;

    doc.setDrawColor(220, 228, 240);
    doc.setLineWidth(0.25);

    let ry = ruledStartY;
    while (ry <= ruledEndY) {
        doc.line(ruledLineX1, ry, ruledLineX2, ry);
        ry += LINE_SPACING;
    }

    // Reset draw state
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.setFont("Montserrat", "normal");
    doc.setTextColor(0);
}
window.drawNotesPage = drawNotesPage;



// --- UPDATED DRAW TEMPLATE: Proportional Logo Width ---
function drawReportTemplate(doc, pageNum, logoData, isFirstPage, titleText, addressVal, colors, dateLabel) {
    const height = doc.internal.pageSize.getHeight();
    const width = doc.internal.pageSize.getWidth();
    const margin = 20;

    const p = colors ? colors.primary : {r: 200, g: 40, b: 40};
    const s = colors ? colors.secondary : {r: 150, g: 0, b: 0};

    // Draw Sidebar Lines
    doc.setFillColor(p.r, p.g, p.b);
    doc.rect(0, 0, 8, height, 'F');
    doc.setFillColor(s.r, s.g, s.b);
    doc.rect(8, 0, 2, height, 'F');

    const date = dateLabel || new Date().toLocaleDateString('en-US');

    // LOGO: Register once with alias, reuse on every page
    const drawLogo = () => {
        if (!logoData) return;
        const imgData = "data:image/png;base64," + logoData;
        try {
            // Always pass image bytes; jsPDF reuses the stable alias without treating it as a URL.
            const LOGO_ALIAS = '__report_logo__';
            const targetHeight = 12;

            let props;
            try {
                // Reading properties from image bytes avoids a fetch for /__report_logo__.
                props = doc.getImageProperties(imgData);
                const aspect = props.width / props.height;
                doc.addImage(imgData, 'PNG', 20, 10, targetHeight * aspect, targetHeight, LOGO_ALIAS, undefined, 'NONE');
                return;
            } catch (e) {
                // Alias not registered yet — register it now (page 1)
            }

            props = doc.getImageProperties(imgData);
            const aspect = props.width / props.height;
            const targetWidth = targetHeight * aspect;
            // Register with alias so subsequent pages reference the same bytes
            doc.addImage(imgData, 'PNG', 20, 10, targetWidth, targetHeight, LOGO_ALIAS, undefined, 'NONE');
        } catch (e) {
            console.warn("Logo rendering failed, using fallback.", e);
            try { doc.addImage(imgData, 'PNG', 20, 10, 35, 12); } catch (e2) {}
        }
    };

    if (isFirstPage) {
        drawLogo();
        doc.setFontSize(9);
        doc.setFont("Montserrat", "normal");
        doc.setTextColor(100);
        const addrWidth = doc.getTextWidth(addressVal);
        doc.text(addressVal, width - margin - addrWidth, 15);
        const dateWidth = doc.getTextWidth(date);
        doc.text(date, width - margin - dateWidth, 20);
    } else {
        drawLogo();
        doc.setFontSize(12);
        doc.setFont("Montserrat", "bold");
        doc.setTextColor(50);
        const titleW = doc.getTextWidth(titleText);
        doc.text(titleText, width - margin - titleW, 18);
        doc.setFontSize(8);
        doc.setFont("Montserrat", "normal");
        doc.setTextColor(150);
        const footerY = height - 16;
        doc.text(`${addressVal}  |  ${date}`, 25, footerY);
        doc.text(`Page ${pageNum}`, width - margin + 5, footerY, { align: 'right' });
    }
    doc.setTextColor(0);
}


// --- UPDATED: drawQuadGridPage with front-page card styling ---
function drawQuadGridPage(doc, images, x, y, w, h, colors) {
    const gap = 10; const headerH = 8;
    const cellW = (w-gap)/2; const cellH = cellW+headerH;
    const positions = [ {px:x,py:y}, {px:x+cellW+gap,py:y}, {px:x,py:y+cellH+gap}, {px:x+cellW+gap,py:y+cellH+gap} ];
    const radius = 3;

    // Get primary color for header backgrounds
    const pColor = { r: 103, g: 103, b: 103 }; // #777777
    
    images.forEach((item,i) => {
        if(i>=4)return;
        const pos = positions[i];

        // 1) Shadow (matches front page card)
        doc.setFillColor(230, 230, 230);
        doc.roundedRect(pos.px + 1.5, pos.py + 1.5, cellW, cellH, radius, radius, 'F');

        // 2) White card background + border
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.3);
        doc.roundedRect(pos.px, pos.py, cellW, cellH, radius, radius, 'FD');

        // 3) Primary-color header bar with rounded top corners
        doc.setFillColor(pColor.r, pColor.g, pColor.b);
        const k = radius * 0.55228;
        // Start at top-left, just after the TL curve: (pos.px + radius, pos.py)
        doc.lines(
            [
                // Top edge: right across
                [cellW - (radius * 2), 0],
                // Top-right curve: down-right
                [k, 0, radius, radius - k, radius, radius],
                // Right edge: down to header bottom
                [0, headerH - radius],
                // Bottom edge: left across full width
                [-cellW, 0],
                // Left edge: up to TL curve start
                [0, -(headerH - radius)],
                // Top-left curve: up-right back to start
                [0, -k, radius - k, -radius, radius, -radius]
            ],
            pos.px + radius, pos.py,  // Start at top-left after curve
            [1, 1],
            'F',
            true  // closed path
        );

        // 4) Header text (white on primary)
        doc.setFont("Montserrat","bold"); 
        doc.setFontSize(10);
        doc.setTextColor(255, 255, 255);
        doc.text(item.label, pos.px + cellW/2, pos.py + headerH/2 + 1, {align:'center'});
        doc.setTextColor(0); // Reset

        // 5) Place image inside card body (below header)
        const imgProps = doc.getImageProperties(item.img);
        const r = imgProps.width/imgProps.height;
        const imgAreaH = cellH - headerH - 4; // 2mm padding top+bottom
        const imgAreaW = cellW - 4; // 2mm padding left+right
        let pw = imgAreaW; let ph = pw/r;
        if(ph > imgAreaH) { ph = imgAreaH; pw=ph*r; }
        const imgX = pos.px + 2 + (imgAreaW - pw) / 2;
        const imgY = pos.py + headerH + 2;
        doc.addImage(item.img, 'JPEG', imgX, imgY, pw, ph);
    });
}

function drawPitchTable(doc, squaresData, x, y, w, highlightDominant = false) {
    let totalSq = 0;
    const rows = [];
    
    Object.keys(squaresData).forEach(k => {
        if (typeof squaresData[k] === 'number') {
            totalSq += squaresData[k];
        }
    });
    
    let domPitch = null;
    if (highlightDominant) {
        let maxVal = -1;
        Object.keys(squaresData).forEach(p => {
            const val = squaresData[p];
            if (typeof val === 'number' && val > maxVal) { maxVal = val; domPitch = p; }
        });
    }
    
    Object.keys(squaresData).sort().forEach(pitch => {
        const val = squaresData[pitch];
        const sq = (typeof val === 'number') ? val : 0;
        const pct = (totalSq > 0) ? (sq / totalSq) * 100 : 0;
        rows.push({ pitch, sq, pct });
    });
    emitPdfDebug('page:pitch-table:text-source', {
        highlightDominant,
        totalSquares: roundPdfDebugValue(totalSq),
        rows: rows.map((row) => ({
            pitch: row.pitch,
            sq: roundPdfDebugValue(row.sq),
            sq_ft: roundPdfDebugValue(row.sq * 100, 2),
            pct: roundPdfDebugValue(row.pct, 2)
        }))
    });

    drawSummaryBox(doc, x, y, w, 55, "Pitch Breakdown");
    
    const sorted = rows.sort((a, b) => b.pct - a.pct).slice(0, 6);
    
    // PADDING: Match the box title indentation (8mm)
    const pad = 8;

    let cy = y + 15;
    doc.setFont("Montserrat", "bold");
    doc.setFontSize(9);
    
    // Headers (Adjusted X positions)
    doc.text("Pitch", x + pad + 10, cy, {align:'center'});
    doc.text("Area", x + w/2, cy, {align:'center'});
    doc.text("Percent", x + w - pad - 10, cy, {align:'center'});

    // Divider Line (Adjusted start/end)
    doc.line(x + pad, cy+2, x + w - pad, cy+2);
    cy += 8;

    doc.setFont("Montserrat", "normal");
    sorted.forEach(r => {
        if (highlightDominant && r.pitch === domPitch) {
            doc.setFont("Montserrat", "bold");
        } else {
            doc.setFont("Montserrat", "normal");
        }

        // Row Data (Adjusted X positions)
        doc.text(r.pitch, x + pad + 10, cy, {align:'center'}); // Centered under header
        doc.text(r.sq.toFixed(2), x + w/2, cy, {align:'center'});
        doc.text(Math.round(r.pct) + "%", x + w - pad - 10, cy, {align:'right'}); // Right-align to padding
        cy += 5;
    });
}


// =============================================================================
// DROP-IN REPLACEMENT: estimateMaterials  (pdf.js)
// Brand-aware, measurement-driven — one flagship product per brand per section.
// =============================================================================

function estimateMaterials(report, pitchSplit) {
    // If pitchSplit provided, use steep-only squares; otherwise full total
    var hasSplit = pitchSplit && Number.isFinite(pitchSplit.steepTotal);
    var sq            = hasSplit ? pitchSplit.steepTotal : (report.materials.totalSquares || 0);
    var lin           = report.materials.linear || {};

    var eaveLen       = lin['eave']          || 0;
    var rakeLen       = lin['rake']          || 0;
    var hipLen        = lin['hip']           || 0;
    var ridgeLen      = lin['ridge']         || 0;
    var valleyLen     = lin['valley']        || 0;
    var wallLen       = lin['side_wall']     || 0;
    var headwallLen   = lin['head_wall']     || 0;
    var transLen      = lin['trans']         || 0;
    var chimneyEdge   = lin['chimney_edge']  || 0;
    var chimneyFront  = lin['chimney_front'] || 0;
    var chimneyBack   = lin['chimney_back']  || 0;
    var parapetLen    = lin['parapet']       || 0;

    var perimeter       = eaveLen + rakeLen;
    var hipRidgeLen     = hipLen + ridgeLen;
    var stepFlashLen    = wallLen + transLen + chimneyEdge;
    var chimneyPerimeter= chimneyEdge + chimneyFront + chimneyBack;

    var skyLines        = report.lines.filter(function(l) { return l.type === 'skylight'; });
    var skylightCount   = Math.round(skyLines.length / 4);
    var chimLines       = report.lines.filter(function(l) {
        return l.type === 'chimney_edge' || l.type === 'chimney_back' || l.type === 'chimney_front';
    });
    var chimneyCount    = Math.round(chimLines.length / 4);

    var shingleBundlesPerSquare = 3;
    var shingles = [
        { label: 'GAF Timberline HDZ',        bps: shingleBundlesPerSquare, bundles: Math.ceil(sq * shingleBundlesPerSquare) },
        { label: 'OC TruDef Duration',         bps: shingleBundlesPerSquare, bundles: Math.ceil(sq * shingleBundlesPerSquare) },
        { label: 'CertainTeed Landmark',       bps: shingleBundlesPerSquare, bundles: Math.ceil(sq * shingleBundlesPerSquare) },
        { label: 'Malarkey Vista AR',          bps: shingleBundlesPerSquare, bundles: Math.ceil(sq * shingleBundlesPerSquare) }
    ];

    var starterLF = perimeter;
    var starter = [
        { label: 'GAF Pro-Start',              lfPer: 120, bundles: Math.ceil(starterLF / 120) },
        { label: 'OC Starter Strip',           lfPer: 105, bundles: Math.ceil(starterLF / 105) },
        { label: 'CertainTeed SwiftStart',     lfPer: 100, bundles: Math.ceil(starterLF / 100) },
        { label: 'Malarkey Starter Strip',     lfPer: 100, bundles: Math.ceil(starterLF / 100) }
    ];

    var hrLF = hipRidgeLen;
    var hipRidge = [
        { label: 'GAF Seal-A-Ridge',           lfPer: 25, bundles: Math.ceil(hrLF / 25) },
        { label: 'OC ProEdge',                 lfPer: 33, bundles: Math.ceil(hrLF / 33) },
        { label: 'CertainTeed Shadow Ridge',   lfPer: 30, bundles: Math.ceil(hrLF / 30) },
        { label: 'Malarkey EZ-Ridge',          lfPer: 25, bundles: Math.ceil(hrLF / 25) }
    ];

    var deckSqFt = sq * 100;
    var underlayment = [
        { label: 'GAF FeltBuster',             sqPerRoll: 900, rolls: Math.ceil(deckSqFt / 900) },
        { label: 'OC ProArmor',               sqPerRoll: 900, rolls: Math.ceil(deckSqFt / 900) },
        { label: 'CertainTeed RoofRunner',     sqPerRoll: 900, rolls: Math.ceil(deckSqFt / 900) },
        { label: 'Malarkey Secure Start Plus',  sqPerRoll: 900, rolls: Math.ceil(deckSqFt / 900) }
    ];

    var valleySqFt    = valleyLen * 3.0;
    var chimneySqFt   = chimneyPerimeter * 3.0;
    var skylightSqFt  = skylightCount * 20 * 3.0;
    var wallIWSqFt    = (wallLen + transLen) * 3.0;
    var fixedIWSqFt   = valleySqFt + chimneySqFt + skylightSqFt + wallIWSqFt;

    var perim36SqFt   = perimeter * 3.0;
    var perim18SqFt   = perimeter * 1.5;
    var totalIW36     = fixedIWSqFt + perim36SqFt;
    var totalIW18     = fixedIWSqFt + perim18SqFt;

    var iceWater = [
        { label: 'GAF WeatherWatch',          sqPerRoll: 200, rolls36: Math.ceil(totalIW36 / 200), rolls18: Math.ceil(totalIW18 / 200) },
        { label: 'OC WeatherLock Flex',        sqPerRoll: 225, rolls36: Math.ceil(totalIW36 / 225), rolls18: Math.ceil(totalIW18 / 225) },
        { label: 'CertainTeed WinterGuard',    sqPerRoll: 195, rolls36: Math.ceil(totalIW36 / 195), rolls18: Math.ceil(totalIW18 / 195) },
        { label: 'Malarkey Secure Start I&W',  sqPerRoll: 200, rolls36: Math.ceil(totalIW36 / 200), rolls18: Math.ceil(totalIW18 / 200) }
    ];

    var dripEdgeEave   = Math.ceil(eaveLen / 10);
    var dripEdgeRake   = Math.ceil(rakeLen / 10);
    var dripEdgeTotal  = dripEdgeEave + dripEdgeRake;
    var valleyMetal10  = Math.ceil(valleyLen / 10);
    var stepPieces     = Math.ceil(stepFlashLen * 2.14);
    var counterLF      = wallLen + chimneyPerimeter;
    var counterPieces  = Math.ceil(counterLF / 10);
    var headwallPieces = Math.ceil((headwallLen + transLen) / 10);

    var chimneyAprons     = chimneyCount;
    var chimneyCrickets   = chimneyCount;
    var chimneyStepPcs    = Math.ceil(chimneyEdge * 2.14);
    var chimneyCounterPcs = Math.ceil(chimneyPerimeter / 10);

    var ridgeVent4ft   = Math.ceil(ridgeLen / 4);

    var nailBoxes      = Math.ceil((sq * 320) / 7200);
    var capNailBoxes   = Math.ceil(sq / 50);
    var caulkTubes     = Math.ceil(sq / 20);

    return {
        totalSquares: sq,
        pitchSplit: pitchSplit || null,
        shingles: shingles, starter: starter, hipRidge: hipRidge, underlayment: underlayment,
        iceWater: iceWater,
        iwBreakdown: {
            perim36SqFt: Math.round(perim36SqFt),
            perim18SqFt: Math.round(perim18SqFt),
            valleySqFt:  Math.round(valleySqFt),
            chimneySqFt: Math.round(chimneySqFt),
            skylightSqFt:Math.round(skylightSqFt),
            wallIWSqFt:  Math.round(wallIWSqFt),
            total36:     Math.round(totalIW36),
            total18:     Math.round(totalIW18)
        },
        dripEdgeEave: dripEdgeEave, dripEdgeRake: dripEdgeRake, dripEdgeTotal: dripEdgeTotal,
        valleyMetal10: valleyMetal10, stepPieces: stepPieces, counterPieces: counterPieces, counterLF: counterLF,
        headwallPieces: headwallPieces, headwallLen: headwallLen + transLen,
        chimneyCount: chimneyCount, chimneyAprons: chimneyAprons, chimneyCrickets: chimneyCrickets,
        chimneyStepPcs: chimneyStepPcs, chimneyCounterPcs: chimneyCounterPcs,
        skylightCount: skylightCount, ridgeVent4ft: ridgeVent4ft, ridgeLen: ridgeLen,
        nailBoxes: nailBoxes, capNailBoxes: capNailBoxes, caulkTubes: caulkTubes,
        // Legacy fields
        shingleBundles:  Math.ceil(sq * 3),
        starterBundles:  Math.ceil(perimeter / 100),
        hipRidgeBundles: Math.ceil(hipRidgeLen / 20),
        starterLF: starterLF, hipRidgeLen: hipRidgeLen,
        valleyLen: valleyLen, eavesRakesLen: perimeter, stepFlashLen: stepFlashLen
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN REPLACEMENT: drawFlatMaterialTable
// Adds per-row noWaste support (fasteners/plates/etc shouldn’t scale with waste).
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN REPLACEMENT: drawFlatMaterialTable
// Fix: row backgrounds match divider line width (pad on both sides)
// Restore: Parapet Wall Heights table (also aligned to padded width)
// ─────────────────────────────────────────────────────────────────────────────
function drawFlatMaterialTable(doc, flatEst, x, y, w, manualWastePct, pageContext) {
    var pad = 8;
    var wasteFactor = 1 + (manualWastePct / 100);
    var systems = flatEst.systems;

    // Content bounds (MATCHES divider lines)
    var contentLeft  = x + pad;
    var contentRight = x + w - pad;
    var contentW     = contentRight - contentLeft;

    // ── Column layout ──
    var labelColW = contentW * 0.40;
    var unitColW  = contentW * 0.08;
    var dataStart = contentLeft + labelColW + unitColW;
    var dataW     = contentW - labelColW - unitColW;
    var sysColW   = dataW / systems.length;

    var ROW_H        = 5.5;
    var SECTION_H    = 6;
    var SECTION_GAP  = 2;
    var ROW_FONT     = 8;
    var SECTION_FONT = 8.5;
    var HEADER_FONT  = 8;

    var cursorY = y;

    // ── Area Summary ──
    doc.setFont("Montserrat", "bold");
    doc.setFontSize(9);
    doc.setTextColor(0);
    doc.text(
        "Flat Roof Area: " + flatEst.flatSqFt.toLocaleString() + " sq ft  (" + flatEst.flatSquares.toFixed(2) + " sq)  |  Waste: " + manualWastePct + "%",
        contentLeft, cursorY
    );
    cursorY += 8;

    // ── Column Headers ──
    doc.setFont("Montserrat", "bold");
    doc.setFontSize(HEADER_FONT);
    doc.setTextColor(80);

    doc.text("Material", contentLeft, cursorY);
    doc.text("Unit", contentLeft + labelColW + 2, cursorY);

    systems.forEach(function(sys, i) {
        var cx = dataStart + (i * sysColW) + (sysColW / 2);
        doc.text(sys, cx, cursorY, { align: 'center' });
    });

    cursorY += 2.5;
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.line(contentLeft, cursorY, contentRight, cursorY);
    cursorY += 3;

    // ── Rows ──
    flatEst.rows.forEach(function(row, idx) {
        if (row.section) {
            cursorY += SECTION_GAP;

            doc.setFont("Montserrat", "bold");
            doc.setFontSize(SECTION_FONT);
            doc.setTextColor(0);
            doc.text(row.section, contentLeft, cursorY);

            doc.setDrawColor(210);
            doc.line(contentLeft, cursorY + 1.5, contentRight, cursorY + 1.5);

            cursorY += SECTION_H;
            return;
        }

        // Alternating row background (NOW MATCHES CONTENT WIDTH)
        if (idx % 2 === 0) {
            doc.setFillColor(252, 252, 252);
            doc.rect(contentLeft, cursorY - 3.5, contentW, ROW_H, 'F');
        }

        doc.setFont("Montserrat", "normal");
        doc.setFontSize(ROW_FONT);
        doc.setTextColor(40);

        doc.text(row.label, contentLeft, cursorY);
        doc.setTextColor(120);
        doc.text(row.unit || '', contentLeft + labelColW + 2, cursorY);

        systems.forEach(function(sys, i) {
            var cx = dataStart + (i * sysColW) + (sysColW / 2);
            var val = row.values ? row.values[sys] : null;

            if (val === null || val === undefined) {
                doc.setFont("Montserrat", "normal");
                doc.setTextColor(180);
                doc.text("\u2014", cx, cursorY, { align: 'center' });
            } else {
                var adjusted = row.noWaste ? Math.ceil(val) : Math.ceil(val * wasteFactor);
                doc.setFont("Montserrat", "bold");
                doc.setTextColor(0);
                doc.text(adjusted.toString(), cx, cursorY, { align: 'center' });
            }
        });

        cursorY += ROW_H;
    });

    cursorY += 6;

    // ══════════════════════════════════════════════════════════════════════
    // PARAPET WALL HEIGHT LOOKUP TABLE (RESTORED)
    // ══════════════════════════════════════════════════════════════════════
    if (flatEst.parapetLen > 0 && flatEst.parapetTable && flatEst.parapetTable.length > 0) {

        doc.setFont("Montserrat", "bold");
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.text("Parapet Wall Heights", contentLeft, cursorY);
        cursorY += 5;

        doc.setFont("Montserrat", "normal");
        doc.setFontSize(8);
        doc.setTextColor(80);
        doc.text(
            "Parapet Perimeter: " + flatEst.parapetLen + "'  |  Waste: " + manualWastePct + "%  |  Measure wall height on-site.",
            contentLeft, cursorY
        );
        cursorY += 6;

        var tableX = contentLeft;
        var tableW = contentW;
        var pColW = tableW / 5;

        var cols = [
            { label: 'Wall Ht' },
            { label: 'Wall Area' },
            { label: 'Total Area' },
            { label: 'Membrane' },
            { label: "Add'l Adhesive" }
        ];

        var headerH = 6;

        // Header bg + border
        doc.setFillColor(245, 245, 245);
        doc.rect(tableX, cursorY - 1, tableW, headerH, 'F');
        doc.setDrawColor(200);
        doc.setLineWidth(0.3);
        doc.rect(tableX, cursorY - 1, tableW, headerH, 'S');

        doc.setFont("Montserrat", "bold");
        doc.setFontSize(7);
        doc.setTextColor(60);

        var colX = tableX;
        cols.forEach(function(col) {
            doc.text(col.label, colX + pColW / 2, cursorY + 2.5, { align: 'center' });
            colX += pColW;
        });

        cursorY += headerH;

        var tableBodyTop = cursorY;
        var rowH = 5;
        var lastRowBottomY = cursorY;

        flatEst.parapetTable.forEach(function(row, ridx) {
            var rowY = cursorY;

            // zebra rows
            if (ridx % 2 === 0) {
                doc.setFillColor(250, 250, 250);
                doc.rect(tableX, rowY, tableW, rowH, 'F');
            }

            colX = tableX;

            // Wall Ht
            doc.setFont("Montserrat", "bold");
            doc.setFontSize(8);
            doc.setTextColor(0);
            doc.text(row.heightLabel, colX + pColW / 2, rowY + 3, { align: 'center' });
            colX += pColW;

            // Wall Area
            doc.setFont("Montserrat", "normal");
            doc.setFontSize(8);
            doc.setTextColor(0);
            doc.text(Math.round(row.upturnSqFt * wasteFactor).toLocaleString() + " sf", colX + pColW / 2, rowY + 3, { align: 'center' });
            colX += pColW;

            // Total Area
            doc.setFont("Montserrat", "bold");
            doc.text(Math.round(row.totalSqFt * wasteFactor).toLocaleString() + " sf", colX + pColW / 2, rowY + 3, { align: 'center' });
            colX += pColW;

            // Membrane rolls
            doc.setFont("Montserrat", "normal");
            var adjRolls = Math.ceil((row.totalSqFt * wasteFactor) / flatEst.membrane.rollSqFt);
            doc.text(adjRolls.toString(), colX + pColW / 2, rowY + 3, { align: 'center' });
            colX += pColW;

            // Additional adhesive
            var adjAdhesive = Math.ceil((row.upturnSqFt * wasteFactor) / flatEst.adhesive.sqFtPerGal);
            doc.text(adjAdhesive + " gal", colX + pColW / 2, rowY + 3, { align: 'center' });

            cursorY += rowH;
            lastRowBottomY = cursorY;
        });

        // Row dividers (between rows only)
        doc.setDrawColor(230);
        doc.setLineWidth(0.2);
        for (var ri = 1; ri < flatEst.parapetTable.length; ri++) {
            var divY = tableBodyTop + (ri * rowH);
            doc.line(tableX, divY, tableX + tableW, divY);
        }

        // Outer border (flush)
        doc.setDrawColor(200);
        doc.setLineWidth(0.3);
        doc.rect(tableX, tableBodyTop - headerH - 1, tableW, lastRowBottomY - tableBodyTop + headerH + 1, 'S');

        cursorY = lastRowBottomY + 5;
    }

    // ── Footnote ──
    doc.setFont("Montserrat", "normal");
    doc.setFontSize(6);
    doc.setTextColor(130);
    doc.text(
        "Sections at 2/12 or below classified as low-slope. Quantities include " + manualWastePct + "% waste where applicable. Numbers are estimates only.",
        contentLeft, cursorY
    );

    return 0;
}



/**
 * Splits squares-by-pitch data into flat (≤ threshold/12) and steep (> threshold/12).
 */
function splitSquaresByPitch(squaresData, threshold) {
    if (threshold === undefined) threshold = 2;
    var flat = {}, steep = {};
    var flatTotal = 0, steepTotal = 0;

    Object.keys(squaresData).forEach(function(pitchKey) {
        var val = squaresData[pitchKey];
        if (typeof val !== 'number') return;
        var rise = parseInt(pitchKey, 10);
        if (!Number.isFinite(rise)) return;

        if (rise <= threshold) {
            flat[pitchKey] = val;
            flatTotal += val;
        } else {
            steep[pitchKey] = val;
            steepTotal += val;
        }
    });

    return { flat: flat, steep: steep, flatTotal: flatTotal, steepTotal: steepTotal };
}


// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN REPLACEMENT: estimateFlatMaterials
// Adds column: "TPO (MF)" and only items we can estimate well from area/perimeter.
// ─────────────────────────────────────────────────────────────────────────────
function estimateFlatMaterials(flatSquares, report) {
    // =========================
    // TUNABLES (house defaults)
    // =========================
    const SHEET_SQFT = 32; // 4'×8'

    // Generic fastener heuristic (same as your current logic)
    const FIELD_FASTENER_SQFT_PER = 6;      // 1 fastener per 6 sqft (tweak)
    const PERIM_FASTENER_PER_FT = 1;        // 1 per linear ft around perimeter (tweak)

    // TPO membrane roll size
    const TPO_ROLL_SQFT = 1000; // 10'×100'

    // Mechanically-fastened seam estimate model (derived from area only)
    // Assume the roof is roughly square to estimate seam LF.
    const SHEET_W_FT = 10;     // TPO width
    const SHEET_L_FT = 100;    // TPO length
    const SEAM_FUDGE = 1.15;   // adds patches/field variation/details (tweak)
    const MF_FASTENER_SPACING_IN = 6; // along seam (6" common; 12" sometimes)

    // Walk pads in rolls (customer list uses 34"×50')
    const WALKPAD_PCT = 0.05;      // 5% of roof area (tweak)
    const WALKPAD_MAX_SQFT = 200;  // cap (tweak)
    const WALKPAD_ROLL_W_FT = 34 / 12;
    const WALKPAD_ROLL_L_FT = 50;
    const WALKPAD_ROLL_SQFT = WALKPAD_ROLL_W_FT * WALKPAD_ROLL_L_FT; // ~141.7 sqft/roll

    // Adhesives: keep adhered column behavior as you had it
    const BONDING_ADHESIVE_SQFT_PER_GAL = 60;

    // Perimeter-based consumables (kept conservative; tweak or zero out if you dislike)
    const CUT_EDGE_SEALANT_FT_PER_EACH = 250; // one "each" per 250 ft of terminations
    const CLEANER_FT_PER_EACH = 500;          // one "each" per 500 ft (wipe downs)
    const SINGLE_PLY_SEALANT_FT_PER_TUBE = 30; // tube per 30 ft of termination/detail

    // =========================
    // INPUTS
    // =========================
    const sqFt = flatSquares * 100;
    const lin = (report && report.materials && report.materials.linear) ? report.materials.linear : {};

    const parapetLen   = lin['parapet'] || 0;
    const flatEaveLen  = lin['eave']    || 0;
    const flatRakeLen  = lin['rake']    || 0;

    const perimeterFt    = parapetLen + flatEaveLen + flatRakeLen;
    const nonParapetEdge = flatEaveLen + flatRakeLen;

    // =========================
    // SHARED BASE QUANTITIES
    // =========================
    const coverBoardSheets = Math.ceil(sqFt / SHEET_SQFT);
    const insulationSheets = Math.ceil(sqFt / SHEET_SQFT);

    const perimFasteners = Math.ceil(perimeterFt * PERIM_FASTENER_PER_FT);
    const fieldFasteners = Math.ceil(sqFt / FIELD_FASTENER_SQFT_PER);
    const totalFasteners = perimFasteners + fieldFasteners;

    const insulationPlates3in = totalFasteners;                  // 1 plate per insulation fastener
    const insulationFasteners2in_per1000 = Math.ceil(totalFasteners / 1000);

    const termBarPieces   = Math.ceil(parapetLen / 10);
    const edgeMetalPieces = Math.ceil(nonParapetEdge / 10);

    const walkPadSqFt   = Math.min(sqFt * WALKPAD_PCT, WALKPAD_MAX_SQFT);
    const walkPadRolls  = Math.ceil(walkPadSqFt / WALKPAD_ROLL_SQFT);

    // =========================
    // TPO (MF) SEAM-BASED ITEMS
    // =========================
    const estSeamLf = (() => {
        if (sqFt <= 0) return 0;

        const sideFt = Math.sqrt(sqFt);

        // number of 10' strips across one dimension
        const strips = Math.max(1, Math.ceil(sideFt / SHEET_W_FT));
        const seamsBetweenStrips = Math.max(0, strips - 1);
        const longSeamLf = seamsBetweenStrips * sideFt;

        // if the side is longer than 100', you have end laps
        const segmentsPerStrip = Math.max(1, Math.ceil(sideFt / SHEET_L_FT));
        const endLapsPerStrip = Math.max(0, segmentsPerStrip - 1);
        const endLapLf = strips * endLapsPerStrip * SHEET_W_FT;

        return Math.ceil((longSeamLf + endLapLf) * SEAM_FUDGE);
    })();

    const mfSeamFastenersEa = Math.ceil((estSeamLf * 12) / MF_FASTENER_SPACING_IN);
    const mfMembranePlates_per1000 = Math.ceil(mfSeamFastenersEa / 1000);
    const mfHdFasteners2in_per1000 = Math.ceil(mfSeamFastenersEa / 1000);

    // =========================
    // SYSTEM COLUMNS
    // =========================
    const systems = ['TPO (Adh)', 'TPO (MF)', 'EPDM', 'PVC', 'Mod Bit'];

    const rows = [];

    rows.push({ section: 'Membrane System' });

    rows.push({
        label: 'Membrane / Cap Sheet',
        unit: 'roll',
        values: {
            'TPO (Adh)': Math.ceil(sqFt / TPO_ROLL_SQFT),
            'TPO (MF)':  Math.ceil(sqFt / TPO_ROLL_SQFT),
            'EPDM':      Math.ceil(sqFt / 1000),
            'PVC':       Math.ceil(sqFt / 1000),
            'Mod Bit':   Math.ceil(sqFt / 100)
        }
    });

    // Only include bonding adhesive for adhered (your old behavior)
    rows.push({
        label: 'Bonding Adhesive',
        unit: 'gal',
        values: {
            'TPO (Adh)': Math.ceil(sqFt / BONDING_ADHESIVE_SQFT_PER_GAL),
            'TPO (MF)':  null,
            'EPDM':      Math.ceil(sqFt / BONDING_ADHESIVE_SQFT_PER_GAL),
            'PVC':       Math.ceil(sqFt / BONDING_ADHESIVE_SQFT_PER_GAL),
            'Mod Bit':   null
        }
    });

    rows.push({ section: 'Insulation & Cover Board' });

    // Customer list wants coverboard in SQ; we’ll give both rows:
    // - SQ (matches their takeoff sheet style)
    // - sheets (matches your current)
    rows.push({
        label: '1/2" 4x8 Cover Board',
        unit: 'SQ',
        values: {
            'TPO (Adh)': flatSquares,
            'TPO (MF)':  flatSquares,
            'EPDM':      flatSquares,
            'PVC':       flatSquares,
            'Mod Bit':   flatSquares
        }
    });

    rows.push({
        label: 'Cover Board (4\'×8\')',
        unit: 'sheet',
        values: {
            'TPO (Adh)': coverBoardSheets,
            'TPO (MF)':  coverBoardSheets,
            'EPDM':      coverBoardSheets,
            'PVC':       coverBoardSheets,
            'Mod Bit':   coverBoardSheets
        }
    });

    rows.push({
        label: 'Polyiso Insulation (4\'×8\')',
        unit: 'sheet',
        values: {
            'TPO (Adh)': insulationSheets,
            'TPO (MF)':  insulationSheets,
            'EPDM':      insulationSheets,
            'PVC':       insulationSheets,
            'Mod Bit':   insulationSheets
        }
    });

    // Split plates vs fasteners (customer list explicitly calls these out)
    rows.push({
        label: '3" Insulation Plates',
        unit: 'ea',
        noWaste: true,
        values: {
            'TPO (Adh)': insulationPlates3in,
            'TPO (MF)':  insulationPlates3in,
            'EPDM':      insulationPlates3in,
            'PVC':       insulationPlates3in,
            'Mod Bit':   insulationPlates3in
        }
    });

    rows.push({
        label: '2" HD Fasteners',
        unit: '1000',
        noWaste: true,
        values: {
            'TPO (Adh)': insulationFasteners2in_per1000,
            'TPO (MF)':  insulationFasteners2in_per1000,
            'EPDM':      insulationFasteners2in_per1000,
            'PVC':       insulationFasteners2in_per1000,
            'Mod Bit':   insulationFasteners2in_per1000
        }
    });

    // MF-only seam attachment items (derived from seam estimate)
    rows.push({ section: 'Mechanically-Fastened (TPO Only)' });

    rows.push({
        label: '2-3/8" Membrane Plates',
        unit: '1000',
        noWaste: true,
        values: {
            'TPO (Adh)': null,
            'TPO (MF)':  mfMembranePlates_per1000,
            'EPDM':      null,
            'PVC':       null,
            'Mod Bit':   null
        }
    });

    rows.push({
        label: 'Seam Fasteners (for membrane plates)',
        unit: '1000',
        noWaste: true,
        values: {
            'TPO (Adh)': null,
            'TPO (MF)':  mfHdFasteners2in_per1000,
            'EPDM':      null,
            'PVC':       null,
            'Mod Bit':   null
        }
    });

    // =========================
    // Edge & termination
    // =========================
    rows.push({ section: 'Edge & Termination' });

    rows.push({
        label: 'Termination Bar (10 ft)',
        unit: 'piece',
        values: {
            'TPO (Adh)': termBarPieces || null,
            'TPO (MF)':  termBarPieces || null,
            'EPDM':      termBarPieces || null,
            'PVC':       termBarPieces || null,
            'Mod Bit':   termBarPieces || null
        }
    });

    rows.push({
        label: 'Edge Metal (10 ft)',
        unit: 'piece',
        values: {
            'TPO (Adh)': edgeMetalPieces || null,
            'TPO (MF)':  edgeMetalPieces || null,
            'EPDM':      edgeMetalPieces || null,
            'PVC':       edgeMetalPieces || null,
            'Mod Bit':   edgeMetalPieces || null
        }
    });

    // =========================
    // Sealant & accessories (perimeter-driven only)
    // =========================
    rows.push({ section: 'Sealant & Accessories' });

    rows.push({
        label: 'Walk Pad (34"×50\')',
        unit: 'roll',
        values: {
            'TPO (Adh)': walkPadRolls || null,
            'TPO (MF)':  walkPadRolls || null,
            'EPDM':      walkPadRolls || null,
            'PVC':       walkPadRolls || null,
            'Mod Bit':   null
        }
    });

    rows.push({
        label: 'TPO Cut Edge Sealant',
        unit: 'each',
        noWaste: true,
        values: {
            'TPO (Adh)': Math.max(1, Math.ceil(perimeterFt / CUT_EDGE_SEALANT_FT_PER_EACH)),
            'TPO (MF)':  Math.max(1, Math.ceil(perimeterFt / CUT_EDGE_SEALANT_FT_PER_EACH)),
            'EPDM':      null,
            'PVC':       null,
            'Mod Bit':   null
        }
    });

    rows.push({
        label: 'Cleaner',
        unit: 'each',
        noWaste: true,
        values: {
            'TPO (Adh)': Math.max(1, Math.ceil(perimeterFt / CLEANER_FT_PER_EACH)),
            'TPO (MF)':  Math.max(1, Math.ceil(perimeterFt / CLEANER_FT_PER_EACH)),
            'EPDM':      null,
            'PVC':       null,
            'Mod Bit':   null
        }
    });

    rows.push({
        label: 'Universal Single Ply Sealant',
        unit: 'tube',
        noWaste: true,
        values: {
            'TPO (Adh)': Math.max(1, Math.ceil(perimeterFt / SINGLE_PLY_SEALANT_FT_PER_TUBE)),
            'TPO (MF)':  Math.max(1, Math.ceil(perimeterFt / SINGLE_PLY_SEALANT_FT_PER_TUBE)),
            'EPDM':      Math.max(1, Math.ceil(perimeterFt / SINGLE_PLY_SEALANT_FT_PER_TUBE)),
            'PVC':       Math.max(1, Math.ceil(perimeterFt / SINGLE_PLY_SEALANT_FT_PER_TUBE)),
            'Mod Bit':   null
        }
    });

    // Keep your original generic caulk row behavior (area + parapet)
    const caulkTubes = Math.ceil(parapetLen / 30) + Math.ceil(sqFt / 200);
    rows.push({
        label: 'Sealant / Caulk',
        unit: 'tube',
        values: {
            'TPO (Adh)': caulkTubes,
            'TPO (MF)':  caulkTubes,
            'EPDM':      caulkTubes,
            'PVC':       caulkTubes,
            'Mod Bit':   caulkTubes
        }
    });

    // Return object consumed by drawFlatMaterialTable + parapet height table logic (unchanged)
    const MEMBRANE_ROLL_SQFT = 1000;
    const ADHESIVE_SQFT_PER_GAL = BONDING_ADHESIVE_SQFT_PER_GAL;

    const parapetHeights = [12, 18, 24, 30, 36, 42, 48];
    const parapetTable = parapetHeights.map(function(heightIn) {
        const heightFt = heightIn / 12;
        const upturnSqFt = parapetLen * heightFt; // no hidden fudge
        const totalWithWalls = sqFt + upturnSqFt;
        return {
            heightIn: heightIn,
            heightLabel: heightIn + '"',
            upturnSqFt: Math.round(upturnSqFt),
            totalSqFt: Math.round(totalWithWalls),
            membraneRolls: Math.ceil(totalWithWalls / MEMBRANE_ROLL_SQFT),
            additionalAdhesiveGal: Math.ceil(upturnSqFt / ADHESIVE_SQFT_PER_GAL)
        };
    });

    return {
        flatSquares: flatSquares,
        flatSqFt: sqFt,
        parapetLen: Math.round(parapetLen),
        systems: systems,
        rows: rows,
        parapetTable: parapetTable,
        totalPerimeterFt: Math.round(perimeterFt),
        nonParapetEdgeFt: Math.round(nonParapetEdge),
        membrane: { rollSqFt: MEMBRANE_ROLL_SQFT },
        adhesive: { sqFtPerGal: ADHESIVE_SQFT_PER_GAL }
    };
}

// =============================================================================
// DROP-IN REPLACEMENT: drawMaterialTable  (pdf.js)
// Two-page layout: page 1 = Shingles through I&W, page 2 = Metals onward.
//
// NEW: accepts pageContext as final argument:
//   { logoData, pageNum, address, brandingColors }
// Returns the number of EXTRA pages added (1) so the caller can update pageCount.
// =============================================================================

function drawMaterialTable(doc, est, x, y, w, titleSuffix, facetCount, manualWastePct, pageContext) {
    const hasManualWaste = manualWastePct !== null && typeof manualWastePct !== 'undefined' && Number.isFinite(Number(manualWastePct));
    manualWastePct = hasManualWaste
        ? Math.max(0, Math.round(Number(manualWastePct)))
        : calculateSuggestedWasteFromFacetCount(facetCount, 0);

    // --- Waste columns ---
    let wastes = getGafMaterialWasteOptions(manualWastePct);

    const suggestedWaste = manualWastePct;
    const suggestedIdx   = wastes.indexOf(suggestedWaste);
    const pad = 8;

    const colStart  = x + (w * 0.45);
    const colTotalW = (w * 0.55) - pad;
    const colW      = colTotalW / wastes.length;
    const boxStartX = colStart + (suggestedIdx * colW);

    // --- Spacing constants (original sizes, tighter header) ---
    const ROW_H        = 6;
    const SECTION_H    = 6;
    const SECTION_GAP  = 4;
    const ROW_FONT     = 9;
    const SECTION_FONT = 9;

    // ── Shared: draw waste column header ──
    const drawWasteHeader = (startY) => {
        doc.setFontSize(10);
        doc.setFont("Montserrat", "bold");
        doc.setTextColor(0);
        doc.text("Waste", colStart - 15, startY);

        let cx = colStart + (colW / 2);
        wastes.forEach(waste => {
            doc.text(`${waste}%`, cx, startY, { align: 'center' });
            cx += colW;
        });

        const lineY = startY + 5;
        doc.setDrawColor(200);
        doc.line(x + pad, lineY, x + w - pad, lineY);
        return lineY + 5;
    };

    // ── Shared: draw a data row ──
    let cursorY = 0;
    const drawRow = (label, unit, baseVal) => {
        doc.setFont("Montserrat", "normal");
        doc.setFontSize(ROW_FONT);
        doc.setTextColor(0);
        doc.text(label, x + pad, cursorY);
        doc.text(unit, colStart - 10, cursorY, { align: 'right' });

        let cx = colStart + (colW / 2);
        wastes.forEach(waste => {
            const factor = 1 + (waste / 100);
            const val = Math.ceil(baseVal * factor);
            if (waste === suggestedWaste) doc.setFont("Montserrat", "bold");
            else doc.setFont("Montserrat", "normal");
            doc.text(val.toString(), cx, cursorY, { align: 'center' });
            cx += colW;
        });
        cursorY += ROW_H;
    };

    // ── Shared: draw section title ──
    const drawSection = (title) => {
        doc.setFont("Montserrat", "bold");
        doc.setFontSize(SECTION_FONT);
        doc.setTextColor(0);
        doc.text(title, x + pad, cursorY);
        cursorY += SECTION_H;
    };

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1: Shingles, Starter, Hip/Ridge, Underlayment, Ice & Water Shield
    // ════════════════════════════════════════════════════════════════════════
    const page1TopY = y;
    cursorY = drawWasteHeader(page1TopY);

    drawSection("Shingle Products");
    est.shingles.forEach(s => drawRow(s.label, "bundle", s.bundles));
    cursorY += SECTION_GAP;

    drawSection("Starter Strip");
    est.starter.forEach(s => drawRow(s.label, "bundle", s.bundles));
    cursorY += SECTION_GAP;

    drawSection("Hip & Ridge Cap");
    est.hipRidge.forEach(s => drawRow(s.label, "bundle", s.bundles));
    cursorY += SECTION_GAP;

    drawSection("Synthetic Underlayment");
    est.underlayment.forEach(s => drawRow(s.label, "roll", s.rolls));
    cursorY += SECTION_GAP;

    drawSection("Ice & Water Shield");

    doc.setFont("Montserrat", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`36\u201D perimeter application (${est.iwBreakdown.total36} sq ft)`, x + pad + 2, cursorY);
    cursorY += 5;
    doc.setTextColor(0);
    est.iceWater.forEach(s => drawRow(s.label, "roll", s.rolls36));
    cursorY += 2;

    doc.setFont("Montserrat", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`18\u201D perimeter application (${est.iwBreakdown.total18} sq ft)`, x + pad + 2, cursorY);
    cursorY += 5;
    doc.setTextColor(0);
    est.iceWater.forEach(s => drawRow(s.label, "roll", s.rolls18));

    // ── Page 1 highlight box ──
    doc.setDrawColor(200, 40, 40);
    doc.setLineWidth(0.8);
    doc.rect(boxStartX, page1TopY - 5, colW, (cursorY - (page1TopY - 4)));

    doc.setFont("Montserrat", "normal");
    doc.setFontSize(8);
    doc.setTextColor(0);
    doc.text(titleSuffix, x + pad, cursorY + 8);

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 2: Metals & Flashing, Ventilation, Accessories
    // ════════════════════════════════════════════════════════════════════════
    let extraPages = 0;

    if (pageContext) {
        extraPages = 1;
        doc.addPage();
        const pg = pageContext.pageNum + 1;
        // Use the same title as page 1 (e.g. "Steep-Slope Materials" or "Materials")
        const page2Title = (pageContext.pageTitle) ? pageContext.pageTitle : "Materials";
        drawReportTemplate(doc, pg, pageContext.logoData, false, page2Title, pageContext.address, pageContext.brandingColors, pageContext.dateLabel);

        const page2TopY = y;
        cursorY = drawWasteHeader(page2TopY);

        drawSection("Metals & Flashing");
        if (est.dripEdgeEave > 0)   drawRow("Eave Drip Edge (10 ft)", "piece", est.dripEdgeEave);
        if (est.dripEdgeRake > 0)   drawRow("Rake Drip Edge (10 ft)", "piece", est.dripEdgeRake);
        if (est.valleyMetal10 > 0)  drawRow("Valley Metal W (10 ft)", "piece", est.valleyMetal10);
        if (est.stepPieces > 0)     drawRow("Step Flashing (5x7)", "piece", est.stepPieces);
        if (est.counterPieces > 0)  drawRow("Counter Flashing (10 ft)", "piece", est.counterPieces);
        if (est.headwallPieces > 0) drawRow("Headwall Flashing (10 ft)", "piece", est.headwallPieces);

        if (est.chimneyCount > 0) {
            drawRow("Chimney Apron (front)", "ea", est.chimneyAprons);
            drawRow("Chimney Back Pan / Cricket", "ea", est.chimneyCrickets);
            if (est.chimneyStepPcs > 0)    drawRow("Chimney Step Flashing", "piece", est.chimneyStepPcs);
            if (est.chimneyCounterPcs > 0) drawRow("Chimney Counter Flash (10 ft)", "piece", est.chimneyCounterPcs);
        }
        if (est.skylightCount > 0) drawRow("Skylight Flashing Kit", "kit", est.skylightCount);
        cursorY += SECTION_GAP;

        drawSection("Ventilation");
        if (est.ridgeVent4ft > 0) drawRow("Ridge Vent (4 ft sections)", "piece", est.ridgeVent4ft);
        cursorY += SECTION_GAP;

        drawSection("Accessories");
        drawRow("Coil Nails (1.25 in, 50 lb)", "box", est.nailBoxes);
        drawRow("Plastic Cap Nails", "box", est.capNailBoxes);
        drawRow("Roofing Caulk (Tube)", "tube", est.caulkTubes);

        // ── Page 2 highlight box ──
        doc.setDrawColor(200, 40, 40);
        doc.setLineWidth(0.8);
        doc.rect(boxStartX, page2TopY - 5, colW, (cursorY - (page2TopY - 4)));

        doc.setFont("Montserrat", "normal");
        doc.setFontSize(8);
        doc.setTextColor(0);
        doc.text(titleSuffix, x + pad, cursorY + 8);
    }

    return extraPages;
}



function placeImageOnPage(doc, imgData, imgRatio, maxW, maxH, x, y) {
    let printW = maxW;
    let printH = printW / imgRatio;
    if (printH > maxH) {
        printH = maxH;
        printW = printH * imgRatio;
    }
    const xOffset = x + (maxW - printW) / 2;

    // Auto-detect format from data URL (safe after your find/replace)
    let fmt = 'JPEG';
    if (typeof imgData === 'string') {
        if (imgData.startsWith('data:image/png')) fmt = 'PNG';
        else if (imgData.startsWith('data:image/webp')) fmt = 'WEBP';
        else if (imgData.startsWith('data:image/jpeg') || imgData.startsWith('data:image/jpg')) fmt = 'JPEG';
    }

    doc.addImage(imgData, fmt, xOffset, y, printW, printH);
    return { w: printW, h: printH };
}

// --- DROP-IN REPLACEMENT ---
// Summary-style box used everywhere
function drawSummaryBox(doc, bx, by, bw, bh, title, opts = {}) {
    const pad = Number.isFinite(opts.pad) ? opts.pad : 8;

    const defaultRed = { r: 200, g: 40, b: 40 };

    const globalForceDefault = !!window.__pdfForceDefaultBoxes;
    const forceDefault = (opts.forceDefault !== undefined) ? !!opts.forceDefault : globalForceDefault;

    // Pick primary strip color
    let pColor = defaultRed;

    // 1) explicit override via opts.colors
    if (opts.colors && opts.colors.primary && Number.isFinite(opts.colors.primary.r)) {
        pColor = opts.colors.primary;
    }
    // 2) per-report override (from configurator) when not forced default
    else if (!forceDefault && window.__pdfBrandingColorOverride) {
        pColor = window.__pdfBrandingColorOverride;
    }
    // 3) org branding ONLY when not forced default
    else if (!forceDefault) {
        try {
            if (window.projectOrganization && window.projectOrganization.branding && window.projectOrganization.branding.colors) {
                const c = window.projectOrganization.branding.colors.primary;
                if (c) {
                    const hex = String(c).replace('#','');
                    if (hex.length === 6) {
                        pColor = {
                            r: parseInt(hex.substring(0,2), 16),
                            g: parseInt(hex.substring(2,4), 16),
                            b: parseInt(hex.substring(4,6), 16)
                        };
                    }
                }
            }
        } catch (e) {}
    }

    // 1) Shadow
    doc.setFillColor(230, 230, 230);
    doc.roundedRect(bx + 1.5, by + 1.5, bw, bh, 3, 3, 'F');

    // 2) Main Box
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.roundedRect(bx, by, bw, bh, 3, 3, 'FD');

    // 3) Left color strip (rounded corners)
    doc.setFillColor(pColor.r, pColor.g, pColor.b);

    const r = 3;
    const borderW = 2.0;
    const k = r * 0.55228;

    doc.lines(
        [
            [(r - borderW), 0],
            [-k, 0, -r, (r - k), -r, r],
            [0, bh - (r * 2)],
            [0, k, (r - k), r, r, r],
            [-(r - borderW), 0],
            [0, -bh]
        ],
        bx + borderW, by,
        [1, 1],
        'F',
        false
    );

    // 4) Title
    if (title) {
        doc.setFontSize(9);
        doc.setTextColor(150);
        doc.setFont("Montserrat", "bold");
        doc.text(String(title).toUpperCase(), bx + pad, by + 8);
    }

    // Reset
    doc.setTextColor(0);
    doc.setFont("Montserrat", "normal");
}



function drawLegend(doc, report, x, y) {
    doc.setFontSize(9); 
    doc.setTextColor(0);
    doc.setFont("Montserrat", "normal");
    
    const types = Object.values(getPdfLineTypes());
    const boxSize = 4;
    const padding = 2; // Space between box and text
    const itemGap = 15; // Space between items
    const lineHeight = 10; // Vertical spacing for new lines
    const pageWidth = doc.internal.pageSize.getWidth();
    const rightMargin = 15; // Keep 15mm away from the edge
    
    // Helper to get total length safely
    const getLen = (id) => {
        if (!report || !report.materials || !report.materials.linear) return 0;
        return report.materials.linear[id] || 0;
    };

    // 1. Prepare list of visible items
    // We filter first so we can calculate layout accurately before drawing
    const visibleItems = types.filter(t => {
        // Skip hardcoded hidden types
        if(['skylight', 'chimney_back', 'chimney_edge', 'chimney_front', 'unknown'].includes(t.id.toLowerCase())) { 
            return false; 
        }

        // Skip if total length is 0 (rounded) - logic preserved from original
        const totalLen = getLen(t.id);
        if (Math.round(totalLen) <= 0) return false;

        return true;
    });

    // 2. Pre-calculation: Check if items fit on a single line
    let isSingleLine = true;
    let testX = x;

    for (const t of visibleItems) {
        const textWidth = doc.getTextWidth(t.label);
        const itemWidth = boxSize + padding + textWidth;

        // Check boundary
        if (testX + itemWidth > pageWidth - rightMargin) {
            isSingleLine = false;
            break; // Stop checking, we know it wraps
        }
        testX += itemWidth + itemGap;
    }

    // 3. Modify starting Y if it is only one line
    if (isSingleLine && visibleItems.length > 0) {
        y += lineHeight;
    }

    // 4. Draw
    let currX = x;
    let currY = y;

    visibleItems.forEach(t => {
        // Calculate layout
        const textWidth = doc.getTextWidth(t.label);
        const itemWidth = boxSize + padding + textWidth;

        // Wrap if needed
        if (currX + itemWidth > pageWidth - rightMargin) {
            currX = x;       
            currY += lineHeight; 
        }

        const color = hexToRgbReport(t.color);
        doc.setFillColor(color.r, color.g, color.b);
        
        doc.rect(currX, currY, boxSize, boxSize, 'F');
        doc.text(t.label, currX + boxSize + padding, currY + 2.8); 

        currX += itemWidth + itemGap;
    });
}


function resolvePdfAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    if (raw.startsWith('/')) {
        const base = (typeof window !== 'undefined' && typeof window.__pdfAssetBaseUrl === 'string')
            ? window.__pdfAssetBaseUrl.trim().replace(/\/+$/, '')
            : '';
        if (base && /^\/(?:fonts|images)\//i.test(raw)) return `${base}${raw}`;
    }
    return raw;
}

function fetchAssetAsBase64(url) {
    const resolvedUrl = resolvePdfAssetUrl(url);
    return fetch(resolvedUrl)
        .then(r => {
            if (!r.ok) throw new Error(`Asset request failed (${r.status}) for ${resolvedUrl}`);
            return r.blob();
        })
        .then(b => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const fullDataUrl = reader.result;
                // Downscale large images (logos) to max 400px wide, JPEG quality 0.85
                const img = new Image();
                img.onload = () => {
                    const MAX_W = 400;
                    const MAX_H = 200;
                    let w = img.width;
                    let h = img.height;

                    // Skip compression for already-small images
                    if (w <= MAX_W && h <= MAX_H && b.size < 50000) {
                        resolve(fullDataUrl.split(',')[1]);
                        return;
                    }

                    // Scale down preserving aspect ratio
                    if (w > MAX_W) { h = Math.round(h * (MAX_W / w)); w = MAX_W; }
                    if (h > MAX_H) { w = Math.round(w * (MAX_H / h)); h = MAX_H; }

                    const cvs = document.createElement('canvas');
                    cvs.width = w;
                    cvs.height = h;
                    const ctx = cvs.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, w, h);

                    // Use PNG to preserve transparency (logos often need it)
                    const compressed = cvs.toDataURL('image/png');
                    const kb = Math.round((compressed.length * 0.75) / 1024);
                    console.log(`[LOGO] Resized ${img.naturalWidth}x${img.naturalHeight} → ${w}x${h} (${kb} KB)`);
                    resolve(compressed.split(',')[1]);
                };
                img.onerror = () => {
                    // Fallback: return original if image decode fails
                    resolve(fullDataUrl.split(',')[1]);
                };
                img.src = fullDataUrl;
            };
            reader.readAsDataURL(b);
        }));
}

function fetchImageAssetAsPngBase64(url) {
    const resolvedUrl = resolvePdfAssetUrl(url);
    return fetch(resolvedUrl)
        .then(r => {
            if (!r.ok) throw new Error(`Asset request failed (${r.status}) for ${resolvedUrl}`);
            return r.blob();
        })
        .then(b => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`Failed to read image asset ${resolvedUrl}`));
            reader.onload = () => {
                const fullDataUrl = reader.result;
                const img = new Image();
                img.onload = () => {
                    const MAX_W = 400;
                    const MAX_H = 200;
                    const naturalW = Math.max(1, img.naturalWidth || img.width || 1);
                    const naturalH = Math.max(1, img.naturalHeight || img.height || 1);
                    const isPng = typeof fullDataUrl === 'string' && /^data:image\/png;base64,/i.test(fullDataUrl);

                    // Preserve already-small PNGs byte-for-byte so local and headless PDF
                    // renders remain deterministic. Large PNGs must be normalized: jsPDF
                    // embeds decoded PNG pixels, so a highly compressed multi-megapixel logo
                    // can otherwise inflate a summary PDF by many megabytes.
                    if (isPng && naturalW <= MAX_W && naturalH <= MAX_H) {
                        resolve(fullDataUrl.split(',')[1]);
                        return;
                    }

                    let w = naturalW;
                    let h = naturalH;

                    if (w > MAX_W) { h = Math.round(h * (MAX_W / w)); w = MAX_W; }
                    if (h > MAX_H) { w = Math.round(w * (MAX_H / h)); h = MAX_H; }

                    const cvs = document.createElement('canvas');
                    cvs.width = Math.max(1, w);
                    cvs.height = Math.max(1, h);
                    const ctx = cvs.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, cvs.width, cvs.height);

                    const pngDataUrl = cvs.toDataURL('image/png');
                    const kb = Math.round((pngDataUrl.length * 0.75) / 1024);
                    console.log(`[LOGO] Normalized ${naturalW}x${naturalH} -> ${cvs.width}x${cvs.height} (${kb} KB)`);
                    resolve(pngDataUrl.split(',')[1]);
                };
                img.onerror = () => reject(new Error(`Failed to decode logo image ${resolvedUrl}`));
                img.src = fullDataUrl;
            };
            reader.readAsDataURL(b);
        }));
}

function calculateTotalLinear(report) {
    let sum = 0;
    if (report && report.materials && report.materials.linear) {
        Object.keys(report.materials.linear).forEach(key => {
            if(key !== 'unknown' && key !== 'skylight') {
                sum += report.materials.linear[key];
            }
        });
    }
    return sum;
}

function countSkylights(report) {
    const skyLines = report.lines.filter(l => l.type === 'skylight');
    return Math.round(skyLines.length / 4);
}

function countChimneys(report) {
    const chimLines = report.lines.filter(l => l.type === 'chimney_edge' || l.type === 'chimney_back' || l.type === 'chimney_front');
    return Math.round(chimLines.length / 4);
}

function formatLineType(typeId) {
    const t = Object.values(getPdfLineTypes()).find(x => x.id === typeId);
    return t ? t.label : typeId;
}

function hexToRgbReport(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 0, g: 0, b: 0 };
}

function drawLinePath(ctx, item, width, color) {
    const p1 = item.points[0];
    const p2 = item.points[1];
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
}


function getGlobalCropRegion(allLines, totalW, totalH) {
    let minX = totalW, maxX = 0, minY = totalH, maxY = 0;
    if(allLines.length === 0) return { minX:0, minY:0, width: totalW, height: totalH };

    allLines.forEach(line => {
        line.points.forEach(pt => {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        });
    });
    const padding = 20; 
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(totalW, maxX + padding);
    maxY = Math.min(totalH, maxY + padding);
    return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function drawLabelBox(ctx, text, x, y, fontSize, angle = 0, color = "rgba(255, 255, 255, 0.75)") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.font = `bold ${fontSize}px Arial`;
    const hPad = fontSize * 0.15;
    const w = ctx.measureText(text).width + hPad * 2;
    const h = fontSize * 0.75;
    ctx.fillStyle = color;
    const r = fontSize * 0.06;
    const boxX = -w/2;
    const boxY = -h/2;
    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.lineTo(boxX + w - r, boxY);
    ctx.quadraticCurveTo(boxX + w, boxY, boxX + w, boxY + r);
    ctx.lineTo(boxX + w, boxY + h - r);
    ctx.quadraticCurveTo(boxX + w, boxY + h, boxX + w - r, boxY + h);
    ctx.lineTo(boxX + r, boxY + h);
    ctx.quadraticCurveTo(boxX, boxY + h, boxX, boxY + h - r);
    ctx.lineTo(boxX, boxY + r);
    ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawPDFCompass(doc, x, y, size) {
    doc.setTextColor(68, 68, 68); 
    doc.setDrawColor(68, 68, 68);
    doc.setFillColor(68, 68, 68);
    doc.setLineWidth(0.5);

    doc.circle(x, y, size, 'S'); 

    doc.setFont("Montserrat", "bold");
    doc.setFontSize(size * 2.5); 
    doc.text("N", x, y - size - 1, { align: 'center', baseline: 'bottom' });
    
    doc.setFont("Montserrat", "normal"); 

    doc.triangle(
        x, y - size + 2,             
        x - (size / 2.5), y + (size / 2), 
        x + (size / 2.5), y + (size / 2), 
        'F' 
    );
}

function solveLabels(ctx, lines, fixedObstacles, fontSize) {
  const pad = fontSize * 0.25; // small padding so bg doesn't kiss the stroke

  return lines.map(line => {
    const p1 = line.points[0];
    const p2 = line.points[1];

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;

    // segment angle
    let a = Math.atan2(p2.y - p1.y, p2.x - p1.x);

    // keep text upright (avoid upside-down)
    if (a > Math.PI / 2) a -= Math.PI;
    if (a < -Math.PI / 2) a += Math.PI;

    return {
      text: Math.round(line.length).toString(),
      x: mx,
      y: my,
      angle: a,
      // optional: tell drawLabelBox to make background slightly larger
      _pad: pad
    };
  });
}



function groupSkylightsCorrectly(lines) {
    const clusters = [];
    const visited = new Set();
    const adj = new Map();
    lines.forEach(l => {
        if(!adj.has(l)) adj.set(l, []);
        lines.forEach(other => {
            if(l !== other) {
                const p1 = l.points;
                const p2 = other.points;
                const connected = p1.some(a => p2.some(b => Math.hypot(a.x-b.x, a.y-b.y) < 5));
                if(connected) adj.get(l).push(other);
            }
        });
    });
    lines.forEach(startNode => {
        if(visited.has(startNode)) return;
        const cluster = [];
        const queue = [startNode];
        visited.add(startNode);
        while(queue.length > 0) {
            const curr = queue.pop();
            cluster.push(curr);
            const neighbors = adj.get(curr) || [];
            neighbors.forEach(n => {
                if(!visited.has(n)) { visited.add(n); queue.push(n); }
            });
        }
        clusters.push(cluster);
    });
    return clusters;
}

function getClusterCenter(cluster) {
    let x=0, y=0, cnt = 0;
    cluster.forEach(l => { 
        x+=l.points[0].x; y+=l.points[0].y; 
        x+=l.points[1].x; y+=l.points[1].y;
        cnt+=2;
    });
    return { x: x/cnt, y: y/cnt };
}

function getTextBox(ctx, text, x, y, fontSize) { return {x,y,w:10,h:10}; }

function getPolygonCentroid(pts) {
    let x=0, y=0, area=0;
    for(let i=0; i<pts.length; i++){
        const p1 = pts[i];
        const p2 = pts[(i+1)%pts.length];
        const f = p1.x*p2.y - p2.x*p1.y;
        x += (p1.x+p2.x)*f;
        y += (p1.y+p2.y)*f;
        area += f;
    }
    const f = area*3;
    if (Math.abs(f) < 1e-6) {
        let avgX=0, avgY=0;
        pts.forEach(p=>{avgX+=p.x; avgY+=p.y;});
        return {x:avgX/pts.length, y:avgY/pts.length};
    }
    return { x: x/f, y: y/f };
}

function getSignedArea(pts) {
    let area=0;
    for(let i=0; i<pts.length; i++){
        const p1 = pts[i];
        const p2 = pts[(i+1)%pts.length];
        area += (p1.x*p2.y - p2.x*p1.y);
    }
    return area/2;
}

function localFitPlane(points) {
    if(typeof window.fitPlaneLinearInternal === 'function') {
        return window.fitPlaneLinearInternal(points);
    }
    const n = points.length;
    if(n < 3) return {a:0,b:0,c:0};
    const v1 = {x: points[1].x - points[0].x, y: points[1].y - points[0].y, z: points[1].z - points[0].z};
    const v2 = {x: points[2].x - points[0].x, y: points[2].y - points[0].y, z: points[2].z - points[0].z};
    const nx = v1.y*v2.z - v1.z*v2.y;
    const ny = v1.z*v2.x - v1.x*v2.z;
    const nz = v1.x*v2.y - v1.y*v2.x;
    if(Math.abs(nz) < 1e-6) return {a:0,b:0,c:0}; 
    return { a: -nx/nz, b: -ny/nz, c: 0 };
}

// Helper: Format string as (XXX) XXX-XXXX
function formatPhone(str) {
    const cleaned = ('' + str).replace(/\D/g, '');
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
        return '(' + match[1] + ') ' + match[2] + '-' + match[3];
    }
    return str;
}

// Helper: Draw Icon for measurement types
function drawMeasurementIcon(doc, type, x, y, size, color) {
    doc.setDrawColor(color.r, color.g, color.b);
    doc.setFillColor(color.r, color.g, color.b);
    doc.setLineWidth(0.4);
    
    const t = type.toLowerCase();
    const s = size / 2; // half size for offsets

    if (t.includes('ridge')) {
        // Inverted V
        doc.lines([[s, -s], [s, s]], x - s, y + s/2, [1, 1], 'S', true);
    } else if (t.includes('hip')) {
        // Standard V
        doc.lines([[s, s], [s, -s]], x - s, y - s/2, [1, 1], 'S', true);
    } else if (t.includes('valley')) {
        // Double V or "Y" shape simplified
        doc.lines([[s, s], [s, -s]], x - s, y - s/2, [1, 1], 'S', true);
        doc.line(x, y, x, y+s);
    } else if (t.includes('rake')) {
        // Slanted line
        doc.line(x - s, y + s, x + s, y - s);
    } else if (t.includes('eave')) {
        // Horizontal line
        doc.line(x - s, y, x + s, y);
    } else if (t.includes('flash') || t.includes('wall')) {
        // Step shape
        doc.lines([[s, 0], [0, -s], [s, 0]], x - s, y + s/2, [1, 1], 'S', true);
    } else {
        // Default Circle
        doc.circle(x, y, s * 0.6, 'F');
    }
}


/* --- NEW HELPER: Vertically & Horizontally Center Image --- */
function placeImageCentered(doc, imgData, imgRatio, x, yTop, yBottom, maxW) {
    // 1. Calculate available vertical space
    const availableH = yBottom - yTop;
    
    // 2. Determine Dimensions
    let printW = maxW;
    let printH = printW / imgRatio;

    // 3. Constrain by Height if necessary
    if (printH > availableH) {
        printH = availableH;
        printW = printH * imgRatio;
    }

    // 4. Calculate Centering Offsets
    const xOffset = x + (maxW - printW) / 2;
    const yOffset = yTop + (availableH - printH) / 2;

    // 5. Draw
    let fmt = 'JPEG';
    if (typeof imgData === 'string') {
        if (imgData.startsWith('data:image/png')) fmt = 'PNG';
        else if (imgData.startsWith('data:image/webp')) fmt = 'WEBP';
    }

    doc.addImage(imgData, fmt, xOffset, yOffset, printW, printH);

    // Return bounds so we can place the compass or legend relative to the actual image if needed
    return { x: xOffset, y: yOffset, w: printW, h: printH, bottom: yOffset + printH };
}
