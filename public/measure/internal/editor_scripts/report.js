/* report.js - DROP-IN REPLACEMENT
   - Adds bottom toggle: Editor / Pitch Preview / Area Preview
   - Pitch + Area labels share the same geometry (same x/y + leader)
   - Cover preview uses raw outline (no labels, no areas)
   - Layer preview matches report output
   - UPDATED: Zoomable/pannable labels editor with constant-size labels
   - UPDATED: Adjustable crop padding for edge room
   - UPDATED: Fullscreen fills available width
*/

let reportConfigState = null;
let currentConfigPage = 1;
let totalConfigPages = 1;
let isReportFullscreen = false;

let _reportLayers = [];
let _pagePlan = [];
let _labelsOverlayCleanup = null;
let _pdfPreviewUrl = null;
let _reportAutomationPromise = null;
let _reportTopViewRerollPromise = null;
let _reportTopViewUnavailableReason = '';
let _reportTopViewUnavailableLogged = false;
const REPORT_AUTO_TOP_VIEW_MAX_ZOOM = 0.75;

function areReportQuadViewsDisabled() {
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
window.areReportQuadViewsDisabled = areReportQuadViewsDisabled;

function firstReportLogoValue(...sources) {
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
            if (logo) return logo;
        }
    }
    return '';
}

function syncEditorLayoutAfterReportChange() {
    const run = () => {
        if (typeof window.sync3DViewportSize === 'function') {
            window.sync3DViewportSize();
        }
        window.dispatchEvent(new Event('resize'));
    };
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
        setTimeout(run, 0);
    }
}

function clearReportPdfPreviewUrl() {
    if (_pdfPreviewUrl) {
        try { URL.revokeObjectURL(_pdfPreviewUrl); } catch (e) {}
        _pdfPreviewUrl = null;
    }
}


const FINALIZE_CATEGORIES = [
    {
        key: 'structures',
        title: 'Structures & Features',
        items: [
            { text: 'No missing structures', tooltip: 'Verify every building, garage, shed, and detached structure on the property is modeled.' },
            { text: 'No missing small faces on the walls of the house', tooltip: 'Check for small wall sections, gable ends, and knee walls that may have been overlooked.' },
            { text: 'No missing chimneys', tooltip: 'Cross-reference aerial imagery to confirm all chimneys are present in the model.' },
            { text: 'No missing skylights', tooltip: 'Ensure every skylight visible in the imagery has been drawn and properly cut through roof layers.' }
        ]
    },
    {
        key: 'geometry',
        title: 'Geometry & Angles',
        items: [
            { text: 'Check all Satelite Images', tooltip: 'Verify that the structure is consistent with all of the different satellite footage and that there are no items in additional satellite views that were not visible in the primary one.' },
            { text: 'Neat geometry and angles — no jagged or misaligned edges', tooltip: 'Make sure lines meet cleanly without overshoots or gaps.' },
            { text: 'All chimneys, skylights, dormers, etc. have holes blown through the layers beneath', tooltip: 'Confirm for each penetration that the underlying roof layer has a cutout so area calculations are correct.' }
        ]
    },
    {
        key: 'linework',
        title: 'Line Work & Layers',
        items: [
            { text: 'Correct layer assignment for all geometry', tooltip: "Confirm that independent geometry statements that don't share lines are sorted into layers based on their heights." },
            { text: 'All transitions / roof-to-wall drawn correctly', tooltip: 'Verify that every roof-to-wall transition, step flashing, and headwall line is drawn where the roof plane meets vertical surfaces.' },
            { text: 'Line types correctly labeled', tooltip: 'Spot-check ridges, hips, valleys, rakes, eaves, etc.' }
        ]
    },
    {
        key: 'model3d',
        title: '3D Model Alignment',
        items: [
            { text: 'All faces in 3D model are lined up correctly', tooltip: "Disable the height-map overlay, rotate the 3D view, and look for face edges that don't meet or overlap incorrectly." },
            { text: 'All faces are accurate to height map', tooltip: 'With the height map visible, grab all vertices and shift the model vertically — faces should slice through the height map at consistent heights.' }
        ]
    },
    {
        key: 'reportLabels',
        title: 'Report Labels & Pitches',
        items: [
            { text: 'All pitches shown on report logically make sense..', tooltip: 'Compare adjacent face pitches — a 4/12 next to a 12/12 on the same plane is usually an error. Override in the Labels editor if needed.' },
            { text: 'All labels on report are easily readable', tooltip: 'Check that no labels overlap each other or sit outside the visible diagram area. Re-drag or toggle leaders as needed.' }
        ]
    },
    {
        key: 'ventilation',
        title: 'Ventilation',
        items: [
            { text: 'Box vents placed neatly (if applicable)', tooltip: 'If the roof uses box vents, confirm they are evenly spaced and placed in logical positions away from penetrations.' },
            { text: 'Ridge vents placed appropriately (if applicable)', tooltip: 'Ensure ridge vent lines run along true ridges and are not placed on short unusable ridge segments.' }
        ]
    }
];


// Add this at the top of report.js
if (typeof window.reportExcludedSignatures === 'undefined') {
    window.reportExcludedSignatures = new Set();
}

function cloneReportJson(value, fallback = null) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

function isCommercialProjectReportConfig(state = null) {
    const projectType = window.currentProjectManifest?.project_type
        || state?.projectType
        || state?.project_type
        || state?.report?.project_type;
    return typeof projectType === 'string' && projectType.trim().toLowerCase() === 'commercial';
}

function mergeReportConfigStateIntoLatestState(targetState, sourceState) {
    if (!targetState || !sourceState) return targetState;

    const fieldsToRestore = [
        'customLabels',
        'manualWastePct',
        'manualTotalFacets',
        'manualLayerFacets',
        'gutterSettings',
        'ventSettings',
        'structureSettings',
        'elevationSettings',
        'brandingOverrides',
        'imageSettings',
        'editorCropPadding',
        'diagramFontScale',
        'labelAutomation',
        'finalizeChecklist',
        'finalizeSources',
        'finalizeSourcesConfirmed',
        'autoExcludedFacetIndexes',
        'facetOverlapWarnings'
    ];

    fieldsToRestore.forEach((key) => {
        if (typeof sourceState[key] !== 'undefined') {
            targetState[key] = cloneReportJson(sourceState[key], sourceState[key]);
        }
    });

    if (Array.isArray(sourceState.excludedSignatures)) {
        targetState.excludedSignatures = sourceState.excludedSignatures.slice();
        window.reportExcludedSignatures = new Set(sourceState.excludedSignatures);
    }

    if (typeof sourceState.includeGutterMeasurements === 'boolean') {
        targetState.includeGutterMeasurements = sourceState.includeGutterMeasurements;
    }

    if (areReportQuadViewsDisabled()) {
        targetState.quadImage = null;
        if (targetState.elevationSettings && typeof targetState.elevationSettings === 'object') {
            targetState.elevationSettings.include = false;
        }
    } else if (!targetState.quadImage && sourceState.quadImage) {
        targetState.quadImage = sourceState.quadImage;
    }

    return targetState;
}

async function captureFreshPdfStateForSubmission(existingState = null) {
    const latestState = await captureStateForPDF();
    if (!latestState) return existingState;
    const configState = existingState || window.reportConfigState || window.loadedPdfConfig || null;
    const mergedState = mergeReportConfigStateIntoLatestState(latestState, configState);
    applyReportFacetOverlapGuards(mergedState);
    syncReportDiagramLabels(mergedState);
    startReportConfigurationAutomations(mergedState);
    await waitForReportConfigurationAutomations(mergedState);
    if (typeof window.updateStateImages === 'function') {
        await window.updateStateImages(mergedState);
    }
    applyReportFacetOverlapGuards(mergedState);
    syncReportDiagramLabels(mergedState);
    return mergedState;
}

async function loadSavedPdfSnapshotForEditor() {
    window.__loadedPdfSnapshotHasTopViewSelection = false;
    if (!window.loadedPdfStateAsset) return null;
    try {
        const sep = window.loadedPdfStateAsset.includes('?') ? '&' : '?';
        const resp = await fetch(`${window.loadedPdfStateAsset}${sep}t=${Date.now()}`);
        if (!resp.ok) return null;
        const snapshot = await resp.json();
        window.__loadedPdfSnapshotHasTopViewSelection = !!(
            snapshot &&
            snapshot.imageSettings &&
            typeof snapshot.imageSettings === 'object' &&
            String(snapshot.imageSettings.mainViewId || '').trim()
        );
        return snapshot;
    } catch (e) {
        window.__loadedPdfSnapshotHasTopViewSelection = false;
        console.warn('[Report Config] Failed to load saved PDF snapshot:', e);
        return null;
    }
}

function mergeSavedReportState(targetState, savedState) {
    return mergeReportConfigStateIntoLatestState(targetState, savedState);
}

function getReportFinalizePageNumber() {
    const idx = _pagePlan.findIndex(p => p.key === 'finalize');
    return idx >= 0 ? idx + 1 : 1;
}

async function openReportConfiguration() {
    const state = await captureStateForPDF({ captureWireframes: false });
    if (!state) return;

    const savedSnapshot = await loadSavedPdfSnapshotForEditor();
    if (savedSnapshot) {
        mergeSavedReportState(state, savedSnapshot);
    }

    reportConfigState = state;
    window.reportConfigState = reportConfigState;
    applyReportFacetOverlapGuards(reportConfigState);
    reportConfigState.manualTotalFacets = countRealFacets(reportConfigState);
    const labelSyncResult = syncReportDiagramLabels(reportConfigState);
    const needsInitialAutoLabels = !!labelSyncResult.createdInitial;

    _reportLayers = getLayersFromState(reportConfigState);
    _pagePlan = buildPagePlan(_reportLayers, reportConfigState);
    totalConfigPages = _pagePlan.length;
    currentConfigPage = needsInitialAutoLabels ? getReportFinalizePageNumber() : 1;
    await maybeRunManualReportTopViewChooser(reportConfigState);
    startReportConfigurationAutomations(reportConfigState);

    let panel = document.getElementById('report-config-panel');
    if (!panel) {
        createReportPanel();
        panel = document.getElementById('report-config-panel');
    }

    panel.style.display = 'flex';
    document.body.classList.add('report-mode-active');

    renderConfigPage();
    syncEditorLayoutAfterReportChange();
}
window.openReportConfiguration = openReportConfiguration;

// -----------------------------
// PANEL UI
// -----------------------------

function getLocalFaceSignatureReport(points) {
    const coords = points.map(p => ({x: Math.round(p.x*10), y: Math.round(p.y*10)}));
    coords.sort((a,b) => (a.x - b.x) || (a.y - b.y));
    return coords.map(p => `${p.x},${p.y}`).join('|');
}
window.getLocalFaceSignatureReport = getLocalFaceSignatureReport;

function getReportLabelFaceIndex(label) {
    const idMatch = String(label?.id || '').match(/^f_\d+_(\d+)_/);
    if (!idMatch) return null;
    const index = Number(idMatch[1]);
    return Number.isInteger(index) && index >= 0 ? index : null;
}

const REPORT_LABEL_AUTOMATION_VERSION = 1;

function getReportLabelSignature(label) {
    const sig = typeof label?.faceSignature === 'string' ? label.faceSignature.trim() : '';
    return sig || null;
}

function getReportLabelIdentity(label) {
    const sig = getReportLabelSignature(label);
    if (sig) return `sig:${sig}`;
    const faceIndex = getReportLabelFaceIndex(label);
    return faceIndex !== null ? `idx:${faceIndex}` : null;
}

function getReportActiveLabelFaces(state) {
    if (!state || !Array.isArray(state.facesData)) return [];

    const autoExcluded = (typeof getReportAutoExcludedFaceIndexSet === 'function')
        ? getReportAutoExcludedFaceIndexSet(state)
        : new Set();

    return state.facesData
        .map((face, index) => ({ face, index }))
        .filter(({ face, index }) => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
            if (autoExcluded.has(index)) return false;
            if (typeof isObstacleFace === 'function') return !isObstacleFace(face, state.report);
            return true;
        })
        .map(({ face, index }) => {
            let signature = null;
            try {
                signature = getLocalFaceSignatureReport(face.points);
            } catch (e) {}
            return {
                face,
                index,
                signature,
                identity: signature ? `sig:${signature}` : `idx:${index}`
            };
        });
}

function markReportLabelsAutoGenerated(state) {
    if (!state || typeof state !== 'object') return;
    const labels = Array.isArray(state.customLabels) ? state.customLabels : [];
    state.labelAutomation = {
        version: REPORT_LABEL_AUTOMATION_VERSION,
        manual: false,
        updatedAt: new Date().toISOString(),
        faceSignatures: labels
            .map(getReportLabelSignature)
            .filter(Boolean)
            .sort()
    };
}

function markReportLabelsManual(state) {
    if (!state || typeof state !== 'object') return;
    const labels = Array.isArray(state.customLabels) ? state.customLabels : [];
    const signatures = labels
        .map(getReportLabelSignature)
        .filter(Boolean)
        .sort();

    state.labelAutomation = {
        ...(state.labelAutomation && typeof state.labelAutomation === 'object' ? state.labelAutomation : {}),
        version: REPORT_LABEL_AUTOMATION_VERSION,
        manual: true,
        manualUpdatedAt: new Date().toISOString(),
        manualFaceSignatures: signatures
    };
}

function syncReportDiagramLabels(state) {
    if (!state || typeof state !== 'object') return { changed: false, createdInitial: false, added: 0, removed: 0 };
    if (typeof syncReportExcludedSignatures === 'function') {
        syncReportExcludedSignatures(state);
    }

    const hadLabels = Array.isArray(state.customLabels) && state.customLabels.length > 0;
    const automation = state.labelAutomation && typeof state.labelAutomation === 'object'
        ? state.labelAutomation
        : null;
    const hasManualUpdates = !!(automation && automation.manual === true);

    let autoLabels = null;
    const buildAutoLabels = () => {
        if (!autoLabels) autoLabels = buildDefaultDiagramLabels(state);
        return Array.isArray(autoLabels) ? autoLabels : [];
    };

    if (!hasManualUpdates) {
        state.customLabels = buildAutoLabels();
        markReportLabelsAutoGenerated(state);
        return {
            changed: true,
            createdInitial: !hadLabels,
            added: state.customLabels.length,
            removed: hadLabels ? 0 : 0
        };
    }

    const activeFaces = getReportActiveLabelFaces(state);
    const activeSignatures = new Set(activeFaces.map((item) => item.signature).filter(Boolean));
    const activeFallbackIndexes = new Set(activeFaces.map((item) => item.index));
    const originalLabels = Array.isArray(state.customLabels) ? state.customLabels : [];
    const keptLabels = originalLabels.filter((label) => {
        const sig = getReportLabelSignature(label);
        if (sig) return activeSignatures.has(sig);
        const idx = getReportLabelFaceIndex(label);
        return idx !== null && activeFallbackIndexes.has(idx);
    });

    const existingIdentities = new Set(keptLabels.map(getReportLabelIdentity).filter(Boolean));
    const labelsToAdd = buildAutoLabels().filter((label) => {
        const identity = getReportLabelIdentity(label);
        return identity && !existingIdentities.has(identity);
    });

    if (keptLabels.length !== originalLabels.length || labelsToAdd.length > 0) {
        state.customLabels = keptLabels.concat(labelsToAdd);
        state.labelAutomation = {
            ...automation,
            version: REPORT_LABEL_AUTOMATION_VERSION,
            manual: true,
            updatedAt: new Date().toISOString(),
            faceSignatures: state.customLabels
                .map(getReportLabelSignature)
                .filter(Boolean)
                .sort()
        };
        return {
            changed: true,
            createdInitial: false,
            added: labelsToAdd.length,
            removed: originalLabels.length - keptLabels.length
        };
    }

    return { changed: false, createdInitial: false, added: 0, removed: 0 };
}

window.syncReportDiagramLabels = syncReportDiagramLabels;
window.markReportLabelsManual = markReportLabelsManual;

function getReportFacetPointKey(point) {
    return `${Math.round((Number(point?.x) || 0) * 10)},${Math.round((Number(point?.y) || 0) * 10)}`;
}

function doReportFacesSharePoint(faceA, faceB) {
    const keys = new Set((faceA?.points || []).map(getReportFacetPointKey));
    return (faceB?.points || []).some((point) => keys.has(getReportFacetPointKey(point)));
}

function getReportFaceBounds(face) {
    const pts = Array.isArray(face?.points) ? face.points : [];
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    pts.forEach((pt) => {
        const x = Number(pt?.x);
        const y = Number(pt?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
    });
    return bounds;
}

function doReportBoundsOverlap(boundsA, boundsB) {
    if (!Number.isFinite(boundsA.minX) || !Number.isFinite(boundsB.minX)) return false;
    const overlapW = Math.min(boundsA.maxX, boundsB.maxX) - Math.max(boundsA.minX, boundsB.minX);
    const overlapH = Math.min(boundsA.maxY, boundsB.maxY) - Math.max(boundsA.minY, boundsB.minY);
    return overlapW > 0.5 && overlapH > 0.5;
}

function getReportFaceProjectedArea(face) {
    if (typeof getSignedArea === 'function') return Math.abs(getSignedArea(face.points));
    const pts = Array.isArray(face?.points) ? face.points : [];
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        area += ((Number(p1?.x) || 0) * (Number(p2?.y) || 0)) - ((Number(p2?.x) || 0) * (Number(p1?.y) || 0));
    }
    return Math.abs(area / 2);
}

function getReportPolygonSignedArea(points) {
    const pts = Array.isArray(points) ? points : [];
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        area += ((Number(p1?.x) || 0) * (Number(p2?.y) || 0)) - ((Number(p2?.x) || 0) * (Number(p1?.y) || 0));
    }
    return area / 2;
}

function getReportPolygonOverlapPolygon(subjectPoints, clipPoints) {
    let output = (Array.isArray(subjectPoints) ? subjectPoints : [])
        .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const clip = (Array.isArray(clipPoints) ? clipPoints : [])
        .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (output.length < 3 || clip.length < 3) return [];

    const clipArea = getReportPolygonSignedArea(clip);
    const isInside = (point, a, b) => {
        const cross = ((b.x - a.x) * (point.y - a.y)) - ((b.y - a.y) * (point.x - a.x));
        return clipArea >= 0 ? cross >= -1e-6 : cross <= 1e-6;
    };
    const intersect = (s, e, a, b) => {
        const dx1 = e.x - s.x;
        const dy1 = e.y - s.y;
        const dx2 = b.x - a.x;
        const dy2 = b.y - a.y;
        const denom = (dx1 * dy2) - (dy1 * dx2);
        if (Math.abs(denom) < 1e-9) return e;
        const t = (((a.x - s.x) * dy2) - ((a.y - s.y) * dx2)) / denom;
        return { x: s.x + t * dx1, y: s.y + t * dy1 };
    };

    for (let i = 0; i < clip.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = output;
        output = [];
        if (!input.length) break;
        let s = input[input.length - 1];
        input.forEach((e) => {
            const eInside = isInside(e, a, b);
            const sInside = isInside(s, a, b);
            if (eInside) {
                if (!sInside) output.push(intersect(s, e, a, b));
                output.push(e);
            } else if (sInside) {
                output.push(intersect(s, e, a, b));
            }
            s = e;
        });
    }

    const overlapArea = Math.abs(getReportPolygonSignedArea(output));
    return overlapArea > 1e-4 ? output : [];
}

function getReportPolygonOverlapArea(subjectPoints, clipPoints) {
    return Math.abs(getReportPolygonSignedArea(getReportPolygonOverlapPolygon(subjectPoints, clipPoints)));
}

function getReportFaceAverageZ(face) {
    const zValues = (face?.points || [])
        .map((point) => Number(point?.z))
        .filter((value) => Number.isFinite(value));
    if (!zValues.length) return null;
    return zValues.reduce((sum, value) => sum + value, 0) / zValues.length;
}

function getReportFaceRise12ForOverlap(face, metersPerPx) {
    if (!face || !Array.isArray(face.points)) return 0;
    if (typeof getFacePitchRise12 === 'function') {
        const rise = getFacePitchRise12(face, metersPerPx);
        if (Number.isFinite(rise)) return Math.abs(rise);
    }
    const plane = typeof getReportFacePlane === 'function' ? getReportFacePlane(face) : null;
    if (plane && Number.isFinite(plane.a) && Number.isFinite(plane.b)) {
        return Math.sqrt(plane.a * plane.a + plane.b * plane.b) * (1 / metersPerPx) * 12;
    }
    return 0;
}

function areReportFacesNearlySamePlane(faceA, faceB, metersPerPx) {
    if ((faceA?.layer || 1) !== (faceB?.layer || 1)) return false;
    const planeA = typeof getReportFacePlane === 'function' ? getReportFacePlane(faceA) : null;
    const planeB = typeof getReportFacePlane === 'function' ? getReportFacePlane(faceB) : null;
    if (planeA && planeB) {
        const riseScale = (1 / Math.max(1e-9, metersPerPx)) * 12;
        const axRiseDelta = Math.abs((planeA.a - planeB.a) * riseScale);
        const byRiseDelta = Math.abs((planeA.b - planeB.b) * riseScale);
        if (axRiseDelta > 0.75 || byRiseDelta > 0.75) return false;

        const overlapPoly = getReportPolygonOverlapPolygon(faceA.points, faceB.points);
        if (overlapPoly.length >= 3) {
            const samples = overlapPoly.slice(0, 5);
            const centroid = getReportFaceCentroid({ points: overlapPoly });
            samples.push(centroid);
            const maxZDelta = samples.reduce((maxDelta, point) => {
                const zA = (planeA.a * point.x) + (planeA.b * point.y) + planeA.c;
                const zB = (planeB.a * point.x) + (planeB.b * point.y) + planeB.c;
                return Math.max(maxDelta, Math.abs(zA - zB));
            }, 0);
            if (maxZDelta > 0.35) return false;
        }
    }

    const riseA = getReportFaceRise12ForOverlap(faceA, metersPerPx);
    const riseB = getReportFaceRise12ForOverlap(faceB, metersPerPx);
    if (Math.abs(riseA - riseB) > 1.0) return false;

    const zA = getReportFaceAverageZ(faceA);
    const zB = getReportFaceAverageZ(faceB);
    if (Number.isFinite(zA) && Number.isFinite(zB) && Math.abs(zA - zB) > 0.75) return false;

    return true;
}

function estimateReportFacetOverlapRatio(faceA, faceB) {
    const areaA = getReportFaceProjectedArea(faceA);
    const areaB = getReportFaceProjectedArea(faceB);
    if (!Number.isFinite(areaA) || !Number.isFinite(areaB) || areaA <= 0 || areaB <= 0) return 0;

    const small = areaA <= areaB ? faceA : faceB;
    const large = small === faceA ? faceB : faceA;
    const overlapArea = getReportPolygonOverlapArea(small.points, large.points);
    if (!Number.isFinite(overlapArea) || overlapArea <= 0) return 0;
    return overlapArea / Math.min(areaA, areaB);
}

function applyReportFacetOverlapGuards(state) {
    if (!state || !Array.isArray(state.facesData)) return { autoExcludedCount: 0, warnings: [] };

    const autoExcluded = new Set();
    const warnings = [];
    const faces = state.facesData || [];
    const report = state.report || { lines: [] };
    const signatures = new Map();
    const excludedSignatures = (typeof getReportExcludedSignatureSet === 'function')
        ? getReportExcludedSignatureSet(state)
        : new Set();
    const metersPerPx = (typeof getPdfMetersPerPx === 'function') ? getPdfMetersPerPx(state) : ((20 * 2) / (state.dims?.w || 1000));

    faces.forEach((face, faceIndex) => {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
        if (isObstacleFace(face, report)) return;
        const signature = getLocalFaceSignatureReport(face.points);
        if (!signature) return;
        if (excludedSignatures.has(signature)) return;
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push(faceIndex);
    });

    signatures.forEach((indexes) => {
        if (indexes.length < 2) return;
        const duplicateGroup = [];
        indexes.forEach((faceIndex) => {
            const face = faces[faceIndex];
            const matchingBase = duplicateGroup.find((baseIndex) => {
                const baseFace = faces[baseIndex];
                return areReportFacesNearlySamePlane(baseFace, face, metersPerPx) &&
                    estimateReportFacetOverlapRatio(baseFace, face) >= 0.95;
            });
            if (typeof matchingBase === 'number') {
                autoExcluded.add(faceIndex);
            } else {
                duplicateGroup.push(faceIndex);
            }
        });
        const excluded = indexes.filter((faceIndex) => autoExcluded.has(faceIndex));
        if (excluded.length) {
            warnings.push({
                type: 'duplicate',
                severity: 'auto_excluded',
                faceIndexes: indexes.slice(),
                message: `Duplicate facets detected: ${indexes.map((idx) => idx + 1).join(', ')}. Matching overlapping duplicates were hidden from report labels and totals.`
            });
        }
    });

    const activeIndexes = faces
        .map((face, faceIndex) => ({ face, faceIndex }))
        .filter(({ face, faceIndex }) => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
            if (autoExcluded.has(faceIndex)) return false;
            return !isObstacleFace(face, report);
        })
        .filter(({ face }) => {
            const signature = getLocalFaceSignatureReport(face.points);
            return !signature || !excludedSignatures.has(signature);
        });

    for (let a = 0; a < activeIndexes.length; a++) {
        for (let b = a + 1; b < activeIndexes.length; b++) {
            const first = activeIndexes[a];
            const second = activeIndexes[b];
            if (!doReportFacesSharePoint(first.face, second.face)) continue;
            if (!doReportBoundsOverlap(getReportFaceBounds(first.face), getReportFaceBounds(second.face))) continue;
            if (!areReportFacesNearlySamePlane(first.face, second.face, metersPerPx)) continue;

            const overlapRatio = estimateReportFacetOverlapRatio(first.face, second.face);
            if (overlapRatio < 0.05) continue;

            warnings.push({
                type: 'overlap',
                severity: 'warning',
                faceIndexes: [first.faceIndex, second.faceIndex],
                overlapRatio,
                message: `Possible overlapping facets detected: ${first.faceIndex + 1} and ${second.faceIndex + 1}. Review geometry before final submission.`
            });
        }
    }

    state.autoExcludedFacetIndexes = Array.from(autoExcluded).sort((a, b) => a - b);
    state.facetOverlapWarnings = warnings;
    return { autoExcludedCount: state.autoExcludedFacetIndexes.length, warnings };
}
window.applyReportFacetOverlapGuards = applyReportFacetOverlapGuards;

function createReportPanel() {
    const workspace = document.getElementById('workspace');

    const existing = document.getElementById('report-config-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'report-config-panel';
    panel.className = 'report-column';

    panel.innerHTML = `
        <div class="report-header">
            <span>Report Configuration</span>
            <div style="display:flex; gap:5px;">
                <div class="advanced-settings-wrap">
                    <button type="button" id="advancedSettingsBtn" title="Advanced Settings"><i class="fas fa-cog"></i></button>
                    <div class="advanced-settings-menu" id="advancedSettingsMenu"></div>
                </div>
                <button onclick="refreshReportConfiguration()" title="Refresh Data from Workspace"><i class="fas fa-sync-alt"></i></button>
                <button onclick="toggleReportFullscreen()" title="Toggle Fullscreen"><i class="fas fa-expand"></i></button>
                <button onclick="closeReportConfig()" title="Close"><i class="fas fa-times"></i></button>
            </div>
        </div>

        <div class="report-preview-container" id="reportPreviewContent"></div>

        <div class="report-footer">
            <button onclick="changeConfigPage(-1)" id="btnPrevPage"><i class="fas fa-chevron-left"></i></button>
            <div id="pageList" class="pagination-list"></div>
            <button onclick="changeConfigPage(1)" id="btnNextPage"><i class="fas fa-chevron-right"></i></button>
            <div style="flex:1"></div>
            <button class="btn-create-pdf" onclick="goToFinalizePage()">PDF <i class="fas fa-arrow-right" style="margin-left:4px;"></i></button>
        </div>
    `;

    const style = document.createElement('style');
    style.innerHTML = `
        .report-column { width: 40%; background:#f0f2f5; border-left:1px solid #ccc; display:none; flex-direction:column; z-index:50; transition:width .3s ease; }
        .report-column.fullscreen { width:100% !important; position:absolute; top:0; left:0; height:100%; }
        .report-header { height:40px; background:#fff; border-bottom:1px solid #ddd; display:flex; justify-content:space-between; align-items:center; padding:0 10px; font-weight:bold; font-size:13px; }
        .report-header button { background:none; border:none; cursor:pointer; color:#555; }
        .advanced-settings-wrap { position:relative; display:flex; align-items:center; }
        .advanced-settings-menu {
            display:none; position:absolute; top:28px; right:0; min-width:220px; background:#fff;
            border:1px solid #d8dee6; border-radius:6px; box-shadow:0 10px 28px rgba(0,0,0,.16);
            z-index:120; overflow:hidden; padding:4px;
        }
        .advanced-settings-menu.open { display:block; }
        .advanced-settings-menu button {
            width:100%; border:none; background:#fff; color:#394150; display:flex; align-items:center;
            justify-content:space-between; gap:10px; padding:8px 9px; border-radius:4px; font-size:12px;
            font-weight:700; text-align:left;
        }
        .advanced-settings-menu button:hover { background:#f3f6fb; color:#1a73e8; }
        .advanced-settings-menu button.active { background:#e8f0fe; color:#1a73e8; }

        .report-preview-container { flex:1; min-height:0; overflow-y:auto; padding:0; display:flex; align-items:stretch; justify-content:stretch; background:#e0e0e0; }
        .preview-page { width:100%; max-width:none; min-height:100%; background:#fff; box-shadow:none; padding:16px; box-sizing:border-box; position:relative; display:flex; flex-direction:column; }
        .preview-page.labels-page { max-width:none !important; aspect-ratio:unset !important; }
        .report-column.fullscreen .preview-page { max-width:none !important; }

        .report-footer { height:50px; background:#fff; border-top:1px solid #ddd; display:flex; align-items:center; gap: 10px; padding:0 15px; }
        .report-footer button { padding:6px 12px; border:1px solid #ccc; background:#fff; cursor:pointer; border-radius:4px; }
        .btn-create-pdf { background:#d93025 !important; color:#fff !important; border-color:#d93025 !important; font-weight:bold; margin-left: auto; }

        .pagination-list { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }

        .page-num-btn {
            width: auto; min-width: 28px; height: 28px; padding: 0 8px;
            display: flex; align-items: center; justify-content: center;
            font-size: 11px; font-weight: bold;
            border: 1px solid #ddd; border-radius: 4px;
            background: #fff; color: #555; cursor: pointer;
            flex-shrink: 0; white-space: nowrap;
        }
        .page-num-btn:hover { background: #f0f0f0; }
        .page-num-btn.active { background: #e8f0fe; color: #1a73e8; border-color: #1a73e8; }

        body.report-mode-active .left-column { width:30%; }
        body.report-mode-active .right-column { width:30%; }
        body.report-mode-active .report-column { display:flex; width:35%; }
        body.report-mode-active.report-fullscreen .left-column,
        body.report-mode-active.report-fullscreen .right-column { display:none; }

        .labels-editor-wrap { position:relative; width:100%; flex:1; min-height:200px; border:1px solid #ddd; background:#fff; border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
        .labels-editor-stage { position:relative; flex:1; background:#f7f7f7; overflow:hidden; cursor:default; }
        .labels-editor-stage.panning { cursor:grab; }
        .labels-editor-stage.panning:active { cursor:grabbing; }
        .labels-editor-img, .labels-editor-svg { position:absolute; inset:0; width:100%; height:100%; display:block; }
        .labels-editor-svg { pointer-events:none; }
        .labels-overlay { position:absolute; inset:0; pointer-events:none; }
        .lbl-node { position:absolute; pointer-events:auto; cursor:grab; user-select:none; font-family:Arial,sans-serif; transform-origin:center center; }
        .lbl-node:active { cursor:grabbing; }

        .lbl-card { background:rgba(255,255,255,.90); border:1px solid rgba(0,0,0,.25); border-radius:5px; padding:3px 5px; display:flex; align-items:center; gap:4px; box-shadow:0 2px 8px rgba(0,0,0,.10); white-space:nowrap; }
        .lbl-input { width:32px; font-size:11px; font-weight:800; border:1px solid #cfcfcf; border-radius:4px; padding:1px 4px; outline:none; background:rgba(255,255,255,.96); }
        .lbl-exact { font-size:10px; color:#666; font-weight:700; }

        .lbl-toggle { width:18px; height:18px; border-radius:4px; border:1px solid #cfcfcf; background:rgba(255,255,255,.96); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; line-height:1; user-select:none; }
        .lbl-toggle.active { border-color:#1a73e8; background:rgba(26,115,232,.08); color:#1a73e8; }
        .lbl-toggle i { font-size:10px; }

        .lbl-delete { width:18px; height:18px; border-radius:4px; border:1px solid #d93025; background:rgba(255,255,255,.96); color:#d93025; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; line-height:1; user-select:none; margin-left:2px; }
        .lbl-delete:hover { background:#d93025; color:#fff; }
        .lbl-delete i { font-size:10px; }

        .lbl-anchor { position:absolute; width:12px; height:12px; border-radius:50%; background:rgba(26,115,232,.95); border:2px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,.25); pointer-events:auto; cursor:grab; transform-origin:center center; }
        .lbl-anchor:active { cursor:grabbing; }

        .labels-toolbar { display:flex; gap:10px; align-items:center; justify-content:space-between; margin:10px 0 10px 0; flex-wrap:wrap; }
        .labels-toolbar .mini { font-size:11px; color:#555; line-height:1.2; max-width:70%; }
        .labels-toolbar button { border:1px solid #ccc; background:#fff; border-radius:6px; padding:6px 10px; cursor:pointer; font-weight:700; font-size:12px; }
        .labels-toolbar button.primary { border-color:#1a73e8; color:#1a73e8; background:rgba(26,115,232,.08); }
        .labels-toolbar button.danger { border-color:#d93025; color:#d93025; background:rgba(217,48,37,.06); }

        .labels-zoom-bar { display:flex; gap:6px; align-items:center; padding:6px 10px; background:#f0f0f0; border-top:1px solid #ddd; justify-content:space-between; flex-wrap:wrap; }
        .zoom-controls { display:flex; gap:4px; align-items:center; }
        .zoom-btn { width:26px; height:26px; border-radius:50%; border:1px solid #ccc; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:bold; color:#555; }
        .zoom-btn:hover { background:#e8f0fe; border-color:#1a73e8; color:#1a73e8; }
        .zoom-badge { background:#333; color:#fff; padding:3px 8px; border-radius:999px; font-size:11px; font-weight:800; min-width:40px; text-align:center; }
        .pad-control { display:flex; gap:6px; align-items:center; }
        .pad-control label { font-size:11px; color:#666; font-weight:600; }
        .pad-control input[type=range] { width:80px; }
        .pad-control span { font-size:11px; font-weight:700; color:#333; min-width:30px; }

        .bottom-toggle { display:flex; gap:8px; justify-content:center; margin-top:10px; }
        .bottom-toggle button { border:1px solid #ccc; background:#fff; border-radius:999px; padding:6px 12px; cursor:pointer; font-weight:800; font-size:12px; }
        .bottom-toggle button.active { border-color:#1a73e8; color:#1a73e8; background:rgba(26,115,232,.08); }

        /* ── Finalize Page ── */
        .fin-wrap { display:flex; flex-direction:column; height:100%; min-height:0; }
        .fin-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
        .fin-head h2 { color:#d93025; margin:0; font-size:15px; border-bottom:2px solid #d93025; padding-bottom:3px; flex:1; }
        .fin-dots { display:flex; gap:3px; align-items:center; margin-left:12px; }
        .fin-dot { width:16px; height:5px; border-radius:3px; background:#ddd; transition:background .25s; }
        .fin-dot.done { background:#34a853; }

        .fin-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 10px; margin-bottom:8px; }

        .fin-card {
            display:flex; align-items:stretch; border:1.5px solid #e0e0e0; border-radius:8px;
            background:#fff; cursor:pointer; user-select:none;
            transition:border-color .2s, background .2s, box-shadow .2s;
        }
        .fin-card:hover { border-color:#bbb; box-shadow:0 1px 6px rgba(0,0,0,.06); z-index:10; position:relative; }
        .fin-card.checked { border-color:#34a853; background:#f8fdf9; }
        .fin-card-body { flex:1; padding:7px 9px; display:flex; flex-direction:column; justify-content:flex-start; min-width:0; }
        .fin-card-title { font-weight:700; font-size:12px; color:#222; margin-bottom:2px; display:flex; align-items:center; gap:5px; }
        .fin-card-num {
            display:inline-flex; align-items:center; justify-content:center;
            width:17px; height:17px; border-radius:4px; font-size:10px; font-weight:800;
            color:#fff; background:#d93025; flex-shrink:0;
            transition:background .2s;
        }
        .fin-card.checked .fin-card-num { background:#34a853; }
        .fin-card-items { display:flex; flex-direction:column; justify-content: center; flex: 1; gap:8px; margin-top:8px; margin-bottom:8px; }
        .fin-card-item {
            font-size:11px; color:#666; line-height:1.35;
            padding:4px 6px; border-radius:4px; cursor:default;
            position:relative; transition:background .15s, color .15s;
        }
        .fin-card-item:hover {
            background:rgba(26,115,232,.07); color:#1a73e8;
        }
        .fin-card-item[data-tip]:hover::after {
          content: attr(data-tip);
          position:absolute; left:0; top:100%; margin-top:4px;
          background:#333; color:#fff; font-size:12px; font-weight:400;
          padding:5px 8px; border-radius:5px; white-space:normal;
          width:220px; max-width:260px; line-height:1.35;
          z-index:100; pointer-events:none;
          box-shadow:0 3px 10px rgba(0,0,0,.25);
          animation:finTipIn .12s ease-out;
        }

        @keyframes finTipIn { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:translateY(0); } }

        .fin-card-check {
            width:44px; display:flex; align-items:center; justify-content:center; flex-shrink:0;
            border-left:1px solid #eee; transition:background .2s;
            border-radius:0 7px 7px 0;
        }
        .fin-card.checked .fin-card-check { background:#f0faf2; border-left-color:#c8e6c9; }
        .fin-card-check-icon {
            width:28px; height:28px; border-radius:50%;
            border:2px solid #ccc; display:flex; align-items:center; justify-content:center;
            transition:all .2s; color:transparent;
        }
        .fin-card.checked .fin-card-check-icon {
            border-color:#34a853; background:#34a853; color:#fff;
        }
        .fin-card-check-icon i { font-size:14px; transition:color .2s; }

        /* ── Sources Section ── */
        .fin-src {
            display:flex; align-items:stretch; border:1.5px solid #e0e0e0; border-radius:8px;
            background:#fff; overflow:hidden; transition:border-color .2s, background .2s;
        }
        .fin-src.checked { border-color:#34a853; background:#f8fdf9; }
        .fin-src-body { flex:1; padding:8px 10px; display:flex; flex-direction:column; gap:5px; }
        .fin-src-label { font-weight:700; font-size:12px; color:#222; display:flex; align-items:center; gap:6px; }
        .fin-src-label i { color:#1a73e8; }
        .fin-src-hint { font-size:10px; color:#999; font-weight:400; }

        .fin-src-row { display:flex; gap:6px; align-items:stretch; }
        .fin-src-upload {
            width:64px; min-height:44px; border:1.5px dashed #ccc; border-radius:6px;
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            cursor:pointer; color:#aaa; font-size:9px; text-align:center; gap:1px;
            transition:border-color .15s, background .15s; flex-shrink:0;
        }
        .fin-src-upload:hover { border-color:#1a73e8; background:#f5f9ff; color:#1a73e8; }
        .fin-src-upload i { font-size:15px; }
        .fin-src-notes {
            flex:1; border:1px solid #ddd; border-radius:6px; padding:5px 7px;
            font-size:11px; font-family:inherit; resize:none; outline:none;
            min-height:44px; box-sizing:border-box;
        }
        .fin-src-notes:focus { border-color:#1a73e8; }
        .fin-src-thumbs { display:flex; gap:4px; flex-wrap:wrap; }
        .fin-src-thumb {
            width:38px; height:38px; border-radius:5px; border:1px solid #ddd;
            background-size:cover; background-position:center; position:relative; flex-shrink:0;
        }
        .fin-src-thumb-rm {
            position:absolute; top:-5px; right:-5px; width:15px; height:15px;
            border-radius:50%; background:#d93025; color:#fff; border:1.5px solid #fff;
            display:flex; align-items:center; justify-content:center; cursor:pointer;
            font-size:9px; font-weight:bold; line-height:1;
        }
        .fin-src-thumb-rm:hover { background:#b71c1c; }

        .qa-src-review {
            border:1px solid #d9dde5; border-radius:10px; background:#fff;
            padding:9px 10px; display:flex; flex-direction:column; gap:8px; flex:0 0 auto;
            box-shadow:0 1px 5px rgba(0,0,0,.05);
        }
        .qa-src-review-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .qa-src-review-title { display:flex; align-items:center; gap:7px; font-size:12px; font-weight:900; color:#202124; }
        .qa-src-review-title i { color:#1a73e8; }
        .qa-src-review-meta { color:#667085; font-size:10px; font-weight:800; white-space:nowrap; }
        .qa-src-review-body { display:flex; align-items:stretch; gap:8px; min-width:0; }
        .qa-src-review-notes-btn {
            flex:0 0 auto; width:82px; min-height:48px; border:1px solid #d2e3fc; border-radius:8px;
            background:#f5f9ff; color:#1a73e8; display:flex; flex-direction:column; align-items:center;
            justify-content:center; gap:4px; font-size:10px; font-weight:900; cursor:pointer;
        }
        .qa-src-review-notes-btn:hover { border-color:#1a73e8; background:#e8f0fe; }
        .qa-src-review-thumbs { display:flex; gap:6px; overflow-x:auto; min-width:0; flex:1 1 auto; padding-bottom:2px; }
        .qa-src-review-thumb {
            flex:0 0 auto; width:58px; height:48px; border:1px solid #d9dde5; border-radius:8px;
            padding:0; overflow:hidden; background:#f1f3f4; cursor:pointer; position:relative;
        }
        .qa-src-review-thumb:hover { border-color:#1a73e8; box-shadow:0 2px 8px rgba(26,115,232,.14); }
        .qa-src-review-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
        .qa-src-review-thumb span {
            position:absolute; right:3px; bottom:3px; min-width:15px; height:15px; padding:0 3px;
            border-radius:4px; background:rgba(0,0,0,.7); color:#fff; font-size:9px; font-weight:900; line-height:15px;
        }
        .qa-src-review-empty { color:#777; font-size:11px; font-weight:750; padding:4px 0; }
        .qa-src-modal {
            position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.86); display:none;
            align-items:center; justify-content:center; padding:28px; box-sizing:border-box;
        }
        .qa-src-modal.show { display:flex; }
        .qa-src-modal-shell { position:relative; z-index:2147483001; width:min(980px,100%); height:min(720px,100%); display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:12px; }
        .qa-src-modal-main { min-width:0; min-height:0; display:flex; flex-direction:column; gap:8px; }
        .qa-src-modal-stage { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; position:relative; }
        .qa-src-modal-img { max-width:100%; max-height:100%; object-fit:contain; border-radius:8px; box-shadow:0 10px 34px rgba(0,0,0,.36); }
        .qa-src-modal-img.empty { display:none; }
        .qa-src-modal-nav {
            position:absolute; z-index:2147483002; top:50%; transform:translateY(-50%); width:38px; height:48px; border:1px solid rgba(255,255,255,.24);
            border-radius:9px; background:rgba(0,0,0,.44); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
        }
        .qa-src-modal-nav.prev { left:0; }
        .qa-src-modal-nav.next { right:0; }
        .qa-src-modal-nav:disabled { opacity:.25; cursor:default; }
        .qa-src-modal-rail { flex:0 0 auto; display:flex; gap:6px; overflow-x:auto; }
        .qa-src-modal-thumb { flex:0 0 auto; width:58px; height:46px; border:2px solid transparent; border-radius:7px; padding:0; overflow:hidden; background:#202124; cursor:pointer; }
        .qa-src-modal-thumb.active { border-color:#8ab4f8; }
        .qa-src-modal-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
        .qa-src-modal-info { min-width:0; min-height:0; display:flex; flex-direction:column; gap:9px; color:#fff; background:rgba(255,255,255,.09); border:1px solid rgba(255,255,255,.16); border-radius:12px; padding:13px; }
        .qa-src-modal-title { font-size:13px; font-weight:950; display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .qa-src-modal-count { color:rgba(255,255,255,.62); font-size:11px; font-weight:850; }
        .qa-src-modal-notes { flex:1; min-height:0; overflow:auto; white-space:pre-wrap; font-size:13px; line-height:1.48; color:rgba(255,255,255,.9); background:rgba(0,0,0,.2); border:1px solid rgba(255,255,255,.1); border-radius:9px; padding:10px; }
        .qa-src-modal-notes.empty { color:rgba(255,255,255,.52); font-style:italic; }
        .qa-src-modal-close {
            position:absolute; z-index:2147483003; top:14px; right:14px; width:38px; height:38px; border-radius:50%; border:0;
            background:rgba(255,255,255,.12); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
        }

        .fin-src-check {
            width:44px; display:flex; align-items:center; justify-content:center; flex-shrink:0;
            border-left:1px solid #eee; cursor:pointer; transition:background .2s;
        }
        .fin-src.checked .fin-src-check { background:#f0faf2; border-left-color:#c8e6c9; }
        .fin-src-check-icon {
            width:28px; height:28px; border-radius:50%;
            border:2px solid #ccc; display:flex; align-items:center; justify-content:center;
            transition:all .2s; color:transparent;
        }
        .fin-src.checked .fin-src-check-icon {
            border-color:#34a853; background:#34a853; color:#fff;
        }
        .fin-src-check-icon i { font-size:14px; transition:color .2s; }

        /* ── Submit ── */
        .pdf-preview-shell {
            display:flex; flex-direction:column; gap:10px; min-height:0; height:100%; overflow:hidden;
        }
        .pdf-preview-card {
            background:#fff; border:1px solid #d9dde5; border-radius:10px;
            overflow:hidden; flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
            box-shadow:0 1px 5px rgba(0,0,0,.07);
        }
        .pdf-preview-toolbar {
            display:flex; align-items:center; justify-content:space-between; gap:10px;
            padding:9px 11px; border-bottom:1px solid #e6e9ef; background:#f8f9fb;
        }
        .pdf-preview-title { font-size:13px; font-weight:900; color:#202124; display:flex; align-items:center; gap:7px; }
        .pdf-preview-title i { color:#d93025; }
        .pdf-preview-status { font-size:11px; color:#667085; font-weight:700; margin-left:auto; text-align:right; }
        .pdf-preview-refresh {
            border:1px solid #ccd3dd; background:#fff; color:#344054; border-radius:7px;
            padding:6px 9px; font-size:11px; font-weight:800; cursor:pointer;
            display:flex; align-items:center; gap:6px; white-space:nowrap;
        }
        .pdf-preview-refresh:hover { border-color:#1a73e8; color:#1a73e8; background:#f5f9ff; }
        .pdf-preview-refresh:disabled { opacity:.6; cursor:wait; }
        .pdf-preview-frame-wrap {
            position:relative; flex:1 1 auto; min-height:0; background:#4b5563;
        }
        .pdf-preview-frame {
            position:absolute; inset:0; width:100%; height:100%; border:0; background:#fff;
        }
        .pdf-preview-placeholder {
            position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
            color:#fff; gap:10px; text-align:center; padding:24px; font-size:12px; font-weight:700;
        }
        .pdf-preview-placeholder i { font-size:30px; opacity:.85; }
        .pdf-preview-error {
            color:#b3261e; background:#fff5f5; border:1px solid #f2c6c2;
            border-radius:8px; padding:9px 11px; font-size:12px; font-weight:700;
        }

        .pdf-preview-shell .fin-src,
        .pdf-preview-shell .fin-submit-area,
        .pdf-preview-shell #finGutterStoriesReq { flex:0 0 auto; }

        .fin-submit-area { margin-top:auto; padding-top:8px; }
        .fin-submit-btn {
            width:100%; padding:11px; border:none; border-radius:8px; font-size:14px;
            font-weight:800; cursor:pointer; transition:background .2s, opacity .2s;
            display:flex; align-items:center; justify-content:center; gap:7px;
        }
        .fin-submit-btn.enabled { background:#d93025; color:#fff; opacity:1; }
        .fin-submit-btn.disabled { background:#ddd; color:#999; opacity:.8; cursor:not-allowed; }
        .fin-submit-hint { font-size:10px; color:#aaa; text-align:center; margin-top:3px; }

        .qa-pdf-review-panel {
            border:1px solid #e0e4ec; border-radius:10px; background:#fff; padding:9px 10px;
            display:flex; flex-direction:column; gap:8px; flex:0 0 auto;
        }
        .qa-pdf-review-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px; }
        .qa-pdf-check {
            border:1px solid #dde3eb; border-radius:8px; padding:8px; background:#fafbfc;
            display:flex; flex-direction:column; gap:7px; min-width:0;
        }
        .qa-pdf-check.pass { border-color:#b7dfc2; background:#f7fcf8; }
        .qa-pdf-check.fail { border-color:#f2b8b5; background:#fff7f7; }
        .qa-pdf-check-label { font-size:12px; font-weight:900; color:#202124; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .qa-pdf-check-actions { display:flex; gap:6px; }
        .qa-pdf-mark {
            flex:1; height:30px; border-radius:7px; border:1px solid #d0d5dd; background:#fff;
            display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px;
        }
        .qa-pdf-mark.pass { color:#188038; }
        .qa-pdf-mark.fail { color:#d93025; }
        .qa-pdf-mark.active.pass { background:#188038; border-color:#188038; color:#fff; }
        .qa-pdf-mark.active.fail { background:#d93025; border-color:#d93025; color:#fff; }
        .qa-pdf-comment {
            display:none; width:100%; min-height:42px; resize:vertical; border:1px solid #f2b8b5;
            border-radius:7px; padding:6px 7px; font-size:11px; font-family:inherit; outline:none; box-sizing:border-box;
        }
        .qa-pdf-check.fail .qa-pdf-comment { display:block; }
        .qa-pdf-review-actions { display:flex; gap:8px; align-items:center; }
        .qa-pdf-review-actions .fin-submit-btn { flex:1; }
        .qa-pdf-review-actions .qa-sendback.enabled { background:#d93025; color:#fff; opacity:1; }
        .qa-pdf-review-actions .qa-approve.enabled { background:#188038; color:#fff; opacity:1; }
        .qa-pdf-review-actions .qa-correct.enabled { background:#1a73e8; color:#fff; opacity:1; }
        .qa-pdf-review-actions .hidden-action { display:none; }
        @media (max-width: 900px) {
            .qa-pdf-review-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        }
    `;
    document.head.appendChild(style);

    workspace.appendChild(panel);
}




function closeReportConfig() {
    if (_labelsOverlayCleanup) {
        try { _labelsOverlayCleanup(); } catch (e) {}
        _labelsOverlayCleanup = null;
    }
    clearReportPdfPreviewUrl();
    const panel = document.getElementById('report-config-panel');
    if (panel) panel.style.display = 'none';
    document.body.classList.remove('report-mode-active');
    document.body.classList.remove('report-fullscreen');
    isReportFullscreen = false;
    window.reportConfigState = reportConfigState;
    syncEditorLayoutAfterReportChange();
}
window.closeReportConfig = closeReportConfig;

async function refreshReportConfiguration() {
    const btn = document.querySelector('button[onclick="refreshReportConfiguration()"] i');
    if (btn) btn.classList.add('fa-spin');

    try {
        const newState = await captureStateForPDF({ captureWireframes: false });
        if (!newState) return;
        mergeReportConfigStateIntoLatestState(newState, reportConfigState);

        reportConfigState = newState;
        window.reportConfigState = reportConfigState;
        applyReportFacetOverlapGuards(reportConfigState);
        syncReportDiagramLabels(reportConfigState);
        
        _reportLayers = getLayersFromState(reportConfigState);
        _pagePlan = buildPagePlan(_reportLayers, reportConfigState);
        totalConfigPages = _pagePlan.length;
        startReportConfigurationAutomations(reportConfigState);

        if (currentConfigPage > totalConfigPages) currentConfigPage = totalConfigPages;

        await renderConfigPage();
        
        console.log("Report Data Refreshed.");
    } catch (e) {
        console.error("Refresh failed:", e);
    } finally {
        setTimeout(() => {
            if (btn) btn.classList.remove('fa-spin');
        }, 500);
    }
}
window.refreshReportConfiguration = refreshReportConfiguration;


function toggleReportFullscreen() {
    isReportFullscreen = !isReportFullscreen;
    const panel = document.getElementById('report-config-panel');
    if (!panel) return;
    if (isReportFullscreen) {
        panel.classList.add('fullscreen');
        document.body.classList.add('report-fullscreen');
    } else {
        panel.classList.remove('fullscreen');
        document.body.classList.remove('report-fullscreen');
    }
    syncEditorLayoutAfterReportChange();
}
window.toggleReportFullscreen = toggleReportFullscreen;

function changeConfigPage(dir) {
    const visibleIndexes = _pagePlan
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => !isAdvancedConfigPage(item))
        .map(({ idx }) => idx);
    const currentVisibleIndex = visibleIndexes.indexOf(currentConfigPage - 1);
    if (currentVisibleIndex < 0) return;
    const nextVisibleIndex = currentVisibleIndex + dir;
    if (nextVisibleIndex >= 0 && nextVisibleIndex < visibleIndexes.length) {
        currentConfigPage = visibleIndexes[nextVisibleIndex] + 1;
        renderConfigPage();
    }
}
window.changeConfigPage = changeConfigPage;

// -----------------------------
// PAGE PLAN
// -----------------------------
function getLayersFromState(state) {
    const layers = new Set();
    (state.report?.lines || []).forEach(l => layers.add((l.points?.[0]?.layer || 1)));
    (state.facesData || []).forEach(f => layers.add((f.layer || 1)));
    return Array.from(layers).filter(n => n >= 1 && n <= 6).sort((a, b) => a - b);
}

function shouldIncludeGutters(state) {
    if (typeof state?.includeGutterMeasurements === 'boolean') {
        return state.includeGutterMeasurements;
    }
    const manifest = window.currentProjectManifest || {};
    if (typeof manifest.include_gutter_measurements === 'boolean') {
        return manifest.include_gutter_measurements;
    }
    return !!manifest?.gutter_profile?.enabled;
}

function buildPagePlan(layers, state) {
    const plan = [];
    plan.push({ key: 'labels' });
    if (shouldIncludeGutters(state)) {
        plan.push({ key: 'gutters' });
    }
    if (state.structures && state.structures.length > 1) {
        plan.push({ key: 'structures' });
    }
    plan.push({ key: 'images', advanced: true });
    layers.forEach(l => plan.push({ key: 'layer', layer: l, advanced: true }));
    if (!areReportQuadViewsDisabled()) {
        plan.push({ key: 'elev', advanced: true });
    }
    if (!isCommercialProjectReportConfig(state)) {
        plan.push({ key: 'vent', advanced: true });
    }
    plan.push({ key: 'finalize' });   // ← NEW: always last
    return plan;
}

function isAdvancedConfigPage(item) {
    return !!(item && item.advanced);
}

function getConfigPageNavMeta(item, fallbackIndex = 0) {
    let label = String(fallbackIndex || '');
    let tooltip = `Page ${fallbackIndex}`;

    if (!item) return { label, tooltip };
    if (item.key === 'cover')       { label = "Cover";      tooltip = "Project Overview"; }
    else if (item.key === 'images') { label = "Images";     tooltip = "Map & Crop Settings"; }
    else if (item.key === 'labels') { label = "Labels";     tooltip = "Diagram Editor"; }
    else if (item.key === 'gutters') { label = "Gutters";   tooltip = "Gutter Configuration"; }
    else if (item.key === 'layer')  { label = "L" + item.layer; tooltip = "Layer " + item.layer; }
    else if (item.key === 'structures') { label = "Structures"; tooltip = "Structure Breakdown"; }
    else if (item.key === 'elev')   { label = "Quad View";  tooltip = "3D Elevations / Four Direction Views"; }
    else if (item.key === 'vent')   { label = "Vent";       tooltip = "Ventilation"; }
    else if (item.key === 'finalize') { label = "PDF";      tooltip = "PDF Preview & Submission"; }

    return { label, tooltip };
}

function renderAdvancedSettingsMenu() {
    const menu = document.getElementById('advancedSettingsMenu');
    const btn = document.getElementById('advancedSettingsBtn');
    if (!menu || !btn) return;

    const advancedEntries = _pagePlan
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => isAdvancedConfigPage(item));

    menu.innerHTML = '';
    advancedEntries.forEach(({ item, idx }) => {
        const meta = getConfigPageNavMeta(item, idx + 1);
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = idx + 1 === currentConfigPage ? 'active' : '';
        entry.title = meta.tooltip;
        entry.innerHTML = `<span>${meta.label}</span><i class="fas fa-chevron-right" style="font-size:10px;"></i>`;
        entry.onclick = (event) => {
            event.stopPropagation();
            menu.classList.remove('open');
            goToConfigPage(idx + 1);
        };
        menu.appendChild(entry);
    });

    if (!advancedEntries.length) {
        const empty = document.createElement('button');
        empty.type = 'button';
        empty.disabled = true;
        empty.innerText = 'No advanced pages';
        menu.appendChild(empty);
    }

    if (!btn.dataset.boundAdvancedMenu) {
        btn.dataset.boundAdvancedMenu = '1';
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            menu.classList.toggle('open');
        });
        document.addEventListener('click', (event) => {
            if (!menu.classList.contains('open')) return;
            const wrap = btn.closest('.advanced-settings-wrap');
            if (wrap && wrap.contains(event.target)) return;
            menu.classList.remove('open');
        });
    }
}



async function renderStructuresPreview(container, state) {
    if (!state.structureSettings) state.structureSettings = {};

    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Structure Breakdown</h2>
        <div style="font-size:12px; color:#666; margin-bottom:15px;">
            Configure how structures appear in the report. You can hide structures or merge small/split parts into a main structure.<br>
            <strong>Note:</strong> Pagination will automatically handle more than 3 structures.
        </div>
        <div id="structConfigWrapper" style="display:flex; flex-wrap:wrap; gap:15px; justify-content:center;">
        </div>
    `;

    const wrapper = container.querySelector('#structConfigWrapper');
    const rawStructs = state.structures || [];

    const effectiveMap = new Map();
    const effectiveList = getEffectiveStructures(rawStructs, state.structureSettings);
    effectiveList.forEach(eff => {
        eff.originalIds.forEach(oid => effectiveMap.set(oid, eff));
    });

    for (const s of rawStructs) {
        const id = s.id;
        const settings = state.structureSettings[id] || { hidden: false, mergeTarget: "" };
        
        const isHidden = settings.hidden;
        const mergeTarget = settings.mergeTarget ? parseInt(settings.mergeTarget) : null;
        
        const card = document.createElement('div');
        card.style.cssText = `
            border: 1px solid #ccc; background: #fff; width: 200px; padding: 10px; 
            border-radius: 6px; display: flex; flex-direction: column; gap: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: opacity 0.2s;
            ${isHidden ? 'opacity: 0.6; background: #f9f9f9;' : ''}
        `;

        let headerHtml = `<div style="font-weight:bold; color:#333; display:flex; justify-content:space-between;">
            <span>Structure ${id}</span>
            <label style="font-weight:normal; font-size:11px; cursor:pointer;">
                <input type="checkbox" class="cb-hide" ${!isHidden ? 'checked' : ''}> Include
            </label>
        </div>`;

        let imgHtml = '';
        if (mergeTarget) {
            imgHtml = `<div style="height:120px; background:#eee; color:#777; display:flex; align-items:center; justify-content:center; font-size:11px; font-style:italic; border:1px dashed #ccc;">
                Merged into Struct ${mergeTarget}
            </div>`;
        } else {
            const effStruct = effectiveMap.get(id);
            if (effStruct) {
                const cvs = await createStructureCanvas(state, effStruct);
                imgHtml = `<div style="height:120px; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #eee;">
                    <img src="${cvs.toDataURL()}" style="max-width:100%; max-height:100%;">
                </div>`;
            } else {
                imgHtml = `<div style="height:120px; background:#eee;"></div>`;
            }
        }

        let options = `<option value="">Do not merge</option>`;
        rawStructs.forEach(other => {
            if (other.id !== id) {
                const sel = (mergeTarget === other.id) ? 'selected' : '';
                options += `<option value="${other.id}" ${sel}>Merge into Struct ${other.id}</option>`;
            }
        });

        const controlsHtml = `
            <div>
                <label style="font-size:11px; color:#666; display:block; margin-bottom:2px;">Merge Action:</label>
                <select class="sel-merge" style="width:100%; padding:4px; font-size:12px; border:1px solid #ccc; border-radius:4px;" ${isHidden ? 'disabled' : ''}>
                    ${options}
                </select>
            </div>
            <div style="font-size:10px; color:#888;">
                Facets: ${s.faces.length}, Lines: ${s.lines.length}
            </div>
        `;

        card.innerHTML = headerHtml + imgHtml + controlsHtml;
        
        const cbHide = card.querySelector('.cb-hide');
        cbHide.onchange = () => {
            if (!state.structureSettings[id]) state.structureSettings[id] = {};
            state.structureSettings[id].hidden = !cbHide.checked;
            renderConfigPage();
        };

        const selMerge = card.querySelector('.sel-merge');
        selMerge.onchange = () => {
            if (!state.structureSettings[id]) state.structureSettings[id] = {};
            state.structureSettings[id].mergeTarget = selMerge.value;
            renderConfigPage();
        };

        wrapper.appendChild(card);
    }
}


// Compute effective crop region (base + editor padding)
function getEffectiveCrop(state) {
    const base = state.cropRegion;
    const pad = state.editorCropPadding || 0;
    return {
        minX: base.minX - pad,
        minY: base.minY - pad,
        width: base.width + pad * 2,
        height: base.height + pad * 2
    };
}

function getRecommendedAutoLabelPadding(state, outsideLabelCount = 0) {
    const crop = state?.cropRegion || {};
    const minDim = Math.max(1, Math.min(Number(crop.width) || 1, Number(crop.height) || 1));
    const countPad = 10 + Math.max(0, outsideLabelCount) * 1.5;
    return Math.round(Math.min(42, Math.max(14, Math.min(minDim * 0.055, countPad))));
}

function normalizeAutoLabelPadding(state, outsideLabelCount = 0) {
    if (!state || !state.cropRegion) return 0;
    const current = Math.max(0, Number(state.editorCropPadding) || 0);
    if (state._editorCropPaddingManual === true) return current;

    const recommended = getRecommendedAutoLabelPadding(state, outsideLabelCount);
    if (current > recommended || (outsideLabelCount > 0 && current < recommended)) {
        state.editorCropPadding = recommended;
        state._editorCropPaddingAuto = true;
        return recommended;
    }
    return current;
}

const GUTTER_DIRECTIONS = ['north', 'south', 'east', 'west'];
const GUTTER_DIRECTION_LABELS = {
    north: 'North',
    south: 'South',
    east: 'East',
    west: 'West'
};
const GUTTER_MITER_COLORS = {
    outside90: '#2e7d32',
    inside90: '#d93025',
    non90: '#f9ab00',
    off: '#b8bfc7'
};
const GUTTER_HEIGHT_EPSILON = 0.05;
const GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT = 25;

function ensureGutterSettings(state) {
    if (!state || typeof state !== 'object') {
        return {
            downspoutSpacingFt: GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT,
            miterAngleToleranceDeg: 2,
            stories: { north: '', south: '', east: '', west: '' }
        };
    }

    if (!state.gutterSettings || typeof state.gutterSettings !== 'object') {
        state.gutterSettings = {};
    }

    const settings = state.gutterSettings;
    const spacing = Number(settings.downspoutSpacingFt);
    const tolerance = Number(settings.miterAngleToleranceDeg);

    settings.downspoutSpacingFt = Number.isFinite(spacing) && spacing > 0 ? spacing : GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT;
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

    GUTTER_DIRECTIONS.forEach((dir) => {
        const raw = settings.stories[dir];
        settings.stories[dir] = raw == null ? '' : String(raw);
        if (settings.stories[dir] === '0') settings.stories[dir] = '';
    });

    return settings;
}

function roundGutterCoord(value, factor = 10) {
    return Math.round((Number(value) || 0) * factor);
}

function getGutterPointKey(point) {
    return `${roundGutterCoord(point?.x)},${roundGutterCoord(point?.y)}`;
}

function getGutterCardinalDirection(x, y) {
    if (Math.abs(x) >= Math.abs(y)) {
        return x >= 0 ? 'east' : 'west';
    }
    return y >= 0 ? 'south' : 'north';
}

function getRoofFacesForGutters(state) {
    return (state?.facesData || []).filter((face) => !isObstacleFace(face, state.report));
}

function isPointInsidePolygonReport(x, y, poly) {
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

function isPointInsideRoofFaceAtPoint(x, y, face) {
    if (!Array.isArray(face?.points) || face.points.length < 3) return false;
    if (!isPointInsidePolygonReport(x, y, face.points)) return false;

    if (Array.isArray(face.holes)) {
        for (const hole of face.holes) {
            if (Array.isArray(hole) && hole.length >= 3 && isPointInsidePolygonReport(x, y, hole)) {
                return false;
            }
        }
    }

    return true;
}

function fitReportPlaneLinear(points) {
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

function getReportFacePlane(face) {
    if (!face || typeof face !== 'object') return null;

    const cached = face.__gutterPlaneCache;
    if (cached && Number.isFinite(cached.a) && Number.isFinite(cached.b) && Number.isFinite(cached.c)) {
        return cached;
    }

    let plane = face.plane;
    if (!(plane && Number.isFinite(plane.a) && Number.isFinite(plane.b) && Number.isFinite(plane.c))) {
        if (typeof calculatePlaneFromVertices === 'function') {
            try {
                plane = calculatePlaneFromVertices(face);
            } catch (e) {
                plane = null;
            }
        }
    }

    if (!(plane && Number.isFinite(plane.a) && Number.isFinite(plane.b) && Number.isFinite(plane.c))) {
        plane = fitReportPlaneLinear(face.points);
    }

    face.__gutterPlaneCache = plane && Number.isFinite(plane.a) && Number.isFinite(plane.b) && Number.isFinite(plane.c)
        ? plane
        : null;
    return face.__gutterPlaneCache;
}

function getReportFaceHeightAtPoint(face, x, y) {
    const plane = getReportFacePlane(face);
    if (plane) return (plane.a * x) + (plane.b * y) + plane.c;

    const pts = Array.isArray(face?.points) ? face.points : [];
    const validZ = pts
        .map((pt) => Number(pt?.z))
        .filter((z) => Number.isFinite(z));
    if (!validZ.length) return null;
    return validZ.reduce((sum, z) => sum + z, 0) / validZ.length;
}

function getMaxRoofHeightAtPoint(x, y, faces) {
    let maxHeight = null;
    for (const face of (faces || [])) {
        if (!isPointInsideRoofFaceAtPoint(x, y, face)) continue;
        const height = getReportFaceHeightAtPoint(face, x, y);
        if (!Number.isFinite(height)) continue;
        if (maxHeight == null || height > maxHeight) {
            maxHeight = height;
        }
    }
    return maxHeight;
}

function getGutterVertexHeight(vertex, items) {
    const directPointHeights = (items || [])
        .map((item) => Number(item?.point?.z))
        .filter((value) => Number.isFinite(value));
    if (directPointHeights.length) {
        return Math.max(...directPointHeights);
    }

    const vertexHeight = Number(vertex?.z);
    if (Number.isFinite(vertexHeight)) return vertexHeight;

    const fallbackHeights = (items || [])
        .map((item) => getReportFaceHeightAtPoint(item?.ownerFace, Number(vertex?.x) || 0, Number(vertex?.y) || 0))
        .filter((value) => Number.isFinite(value));
    if (fallbackHeights.length) {
        return Math.max(...fallbackHeights);
    }

    return null;
}

function isPointInsideRoofFacesAboveVertex(x, y, faces, vertexHeight) {
    const roofHeight = getMaxRoofHeightAtPoint(x, y, faces);
    if (!Number.isFinite(roofHeight)) return false;
    if (!Number.isFinite(vertexHeight)) return true;
    return roofHeight >= (vertexHeight - GUTTER_HEIGHT_EPSILON);
}

function findContainingRoofFaceAtPoint(x, y, faces) {
    for (const face of (faces || [])) {
        if (isPointInsideRoofFaceAtPoint(x, y, face)) {
            return face;
        }
    }
    return null;
}

function isPointInsideRoofFaces(x, y, faces) {
    return !!findContainingRoofFaceAtPoint(x, y, faces);
}

function getReportFaceCentroid(face) {
    const pts = Array.isArray(face?.points) ? face.points : [];
    if (!pts.length) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    pts.forEach((pt) => {
        x += Number(pt?.x) || 0;
        y += Number(pt?.y) || 0;
    });
    return { x: x / pts.length, y: y / pts.length };
}

function areReportPointsEqual(a, b, tolerance = 0.05) {
    return Math.abs((Number(a?.x) || 0) - (Number(b?.x) || 0)) <= tolerance &&
        Math.abs((Number(a?.y) || 0) - (Number(b?.y) || 0)) <= tolerance;
}

function findOwningFaceForEave(line, faces) {
    const p1 = line?.points?.[0];
    const p2 = line?.points?.[1];
    if (!p1 || !p2) return null;

    for (const face of (faces || [])) {
        const ring = Array.isArray(face?.points) ? face.points : [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (
                (areReportPointsEqual(p1, a) && areReportPointsEqual(p2, b)) ||
                (areReportPointsEqual(p1, b) && areReportPointsEqual(p2, a))
            ) {
                return face;
            }
        }
    }

    return null;
}

function estimateGutterDownspoutTotal(lengthFt, spacingFt) {
    const totalLength = Number(lengthFt) || 0;
    const spacing = Number(spacingFt) || GUTTER_DEFAULT_DOWNSPOUT_SPACING_FT;
    if (totalLength <= 0 || spacing <= 0) return 0;

    // EagleView does not publish the exact rule; their sample reports line up much
    // more closely with nearest-whole allocation off total eave length than with
    // per-side ceiling logic.
    return Math.max(1, Math.round(totalLength / spacing));
}

function distributeDirectionalDownspouts(directional, totalEstimatedDownspouts) {
    const activeDirections = GUTTER_DIRECTIONS
        .map((dir) => ({
            dir,
            lengthFt: Number(directional?.[dir]?.lengthFt) || 0
        }))
        .filter((entry) => entry.lengthFt > 0);

    GUTTER_DIRECTIONS.forEach((dir) => {
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

function buildGutterMetrics(state) {
    const settings = ensureGutterSettings(state);
    const faces = getRoofFacesForGutters(state);
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

            const ownerFace = findOwningFaceForEave(line, faces);
            const centroid = ownerFace ? getReportFaceCentroid(ownerFace) : midpoint;
            const dx = (Number(end?.x) || 0) - (Number(start?.x) || 0);
            const dy = (Number(end?.y) || 0) - (Number(start?.y) || 0);
            const len = Math.sqrt(dx * dx + dy * dy) || 1;

            const normalA = { x: -dy / len, y: dx / len };
            const normalB = { x: dy / len, y: -dx / len };
            const toCentroid = { x: centroid.x - midpoint.x, y: centroid.y - midpoint.y };
            const dotA = normalA.x * toCentroid.x + normalA.y * toCentroid.y;
            const inward = dotA >= 0 ? normalA : normalB;
            const outward = { x: -inward.x, y: -inward.y };
            const direction = getGutterCardinalDirection(outward.x, outward.y);

            return {
                id: `gutter-eave-${index}`,
                line,
                start,
                end,
                midpoint,
                lengthFt: Number(line.length) || 0,
                direction,
                ownerFace,
                ownerLayer: Number(ownerFace?.layer) || 1,
                disabled: !!settings.lineOverrides[`gutter-eave-${index}`]?.disabled
            };
        });

    const directional = {};
    GUTTER_DIRECTIONS.forEach((dir) => {
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
    const estimatedDownspouts = estimateGutterDownspoutTotal(totalLengthFt, settings.downspoutSpacingFt);
    distributeDirectionalDownspouts(directional, estimatedDownspouts);

    const endpointMap = new Map();
    eaveLines.forEach((entry) => {
        [
            { point: entry.start, other: entry.end },
            { point: entry.end, other: entry.start }
        ].forEach((item) => {
            const key = getGutterPointKey(item.point);
            if (!endpointMap.has(key)) endpointMap.set(key, []);
            endpointMap.get(key).push({
                point: item.point,
                other: item.other,
                ownerFace: entry.ownerFace,
                ownerLayer: entry.ownerLayer
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
        const dot = clamp((u1.x * u2.x) + (u1.y * u2.y), -1, 1);
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

        const vertexHeight = getGutterVertexHeight(vertex, items);
        const smallerWedgeInsideRoof = isPointInsideRoofFacesAboveVertex(
            samplePoint.x,
            samplePoint.y,
            faces,
            vertexHeight
        );
        const isNear90 = Math.abs(angleDeg - 90) <= settings.miterAngleToleranceDeg;

        let autoType = 'non90';
        if (isNear90) autoType = smallerWedgeInsideRoof ? 'outside90' : 'inside90';

        const miterId = getGutterPointKey(vertex);
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

    const missingStories = GUTTER_DIRECTIONS.filter((dir) => {
        return String(settings.stories[dir] || '').trim() === '';
    });

    return {
        settings,
        eaveLines,
        directional,
        totalLengthFt,
        estimatedDownspouts,
        miterCounts,
        miters,
        missingStories
    };
}

function formatGutterFeet(value) {
    const num = Number(value) || 0;
    return `${num.toLocaleString(undefined, {
        minimumFractionDigits: Number.isInteger(num) ? 0 : 1,
        maximumFractionDigits: 1
    })} ft`;
}

function formatGutterRunLabel(value) {
    const num = Number(value) || 0;
    const rounded = Math.abs(num - Math.round(num)) < 0.05 ? Math.round(num) : Math.round(num * 10) / 10;
    return `${rounded.toLocaleString(undefined, {
        minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
        maximumFractionDigits: 1
    })}'`;
}

function ensureGutterViewerState(settings) {
    if (!settings.viewer || typeof settings.viewer !== 'object') {
        settings.viewer = {};
    }
    const viewer = settings.viewer;
    const zoom = Number(viewer.zoom);
    viewer.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    viewer.centerX = Number.isFinite(Number(viewer.centerX)) ? Number(viewer.centerX) : null;
    viewer.centerY = Number.isFinite(Number(viewer.centerY)) ? Number(viewer.centerY) : null;
    return viewer;
}

function getGutterBaseViewSize(crop, stageWidth, stageHeight) {
    const safeWidth = Math.max(1, stageWidth || 1);
    const safeHeight = Math.max(1, stageHeight || 1);
    const stageAspect = safeWidth / safeHeight;
    const cropAspect = crop.width / crop.height;

    if (stageAspect >= cropAspect) {
        return {
            width: crop.height * stageAspect,
            height: crop.height
        };
    }

    return {
        width: crop.width,
        height: crop.width / stageAspect
    };
}

function clampGutterViewToCrop(crop, viewer, visibleWidth, visibleHeight, baseSize) {
    const cropCenterX = crop.minX + (crop.width / 2);
    const cropCenterY = crop.minY + (crop.height / 2);
    const padX = baseSize.width * 0.08;
    const padY = baseSize.height * 0.08;

    const minCenterX = crop.minX - padX + (visibleWidth / 2);
    const maxCenterX = crop.minX + crop.width + padX - (visibleWidth / 2);
    const minCenterY = crop.minY - padY + (visibleHeight / 2);
    const maxCenterY = crop.minY + crop.height + padY - (visibleHeight / 2);

    if (!Number.isFinite(viewer.centerX)) viewer.centerX = cropCenterX;
    if (!Number.isFinite(viewer.centerY)) viewer.centerY = cropCenterY;

    if (minCenterX > maxCenterX) viewer.centerX = cropCenterX;
    else viewer.centerX = clamp(viewer.centerX, minCenterX, maxCenterX);

    if (minCenterY > maxCenterY) viewer.centerY = cropCenterY;
    else viewer.centerY = clamp(viewer.centerY, minCenterY, maxCenterY);
}

function mountGutterDiagramViewer({
    stageEl,
    svgEl,
    popupEl,
    outlineImg,
    state,
    metrics,
    settings,
    zoomBadgeEl,
    onToggleLine,
    onSetMiterOverride
}) {
    const crop = getEffectiveCrop(state);
    const viewer = ensureGutterViewerState(settings);
    const ZOOM_MIN = 1;
    const ZOOM_MAX = 20;
    const BASE_LINE_WIDTH = 2.8;
    const BASE_DOT_RADIUS = 2.25;
    const BASE_DOT_STROKE = 0.85;
    const OVERRIDE_RING_RADIUS = 3.65;
    const OVERRIDE_RING_WIDTH = 1.0;
    let popupMiterId = null;

    stageEl.style.touchAction = 'none';

    const getMiterById = (miterId) => metrics.miters.find((miter) => miter.id === miterId) || null;

    const hidePopup = () => {
        popupMiterId = null;
        if (popupEl) popupEl.style.display = 'none';
    };

    const updatePopupPosition = () => {
        if (!popupEl || !popupMiterId || popupEl.style.display === 'none') return;
        const rect = stageEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        const miter = getMiterById(popupMiterId);
        if (!miter) {
            hidePopup();
            return;
        }

        const viewBox = svgEl.viewBox.baseVal;
        const localX = ((miter.x - viewBox.x) / viewBox.width) * rect.width;
        const localY = ((miter.y - viewBox.y) / viewBox.height) * rect.height;
        const popupWidth = popupEl.offsetWidth || 190;
        const popupHeight = popupEl.offsetHeight || 170;
        const margin = 12;

        let left = localX + margin;
        let top = localY - (popupHeight / 2);

        if (left + popupWidth > rect.width - margin) {
            left = localX - popupWidth - margin;
        }
        if (left < margin) {
            left = Math.min(Math.max(margin, localX + margin), rect.width - popupWidth - margin);
        }
        top = clamp(top, margin, rect.height - popupHeight - margin);

        popupEl.style.left = `${left}px`;
        popupEl.style.top = `${top}px`;
    };

    const showPopupForMiter = (miterId) => {
        if (!popupEl) return;
        const miter = getMiterById(miterId);
        if (!miter) return;

        popupMiterId = miterId;
        const buttons = [
            { key: 'outside90', label: 'Outside 90', color: GUTTER_MITER_COLORS.outside90 },
            { key: 'inside90', label: 'Inside 90', color: GUTTER_MITER_COLORS.inside90 },
            { key: 'non90', label: 'Non-90', color: GUTTER_MITER_COLORS.non90 },
            { key: 'off', label: 'Turn Off', color: GUTTER_MITER_COLORS.off }
        ];

        popupEl.innerHTML = `
            <div style="font-size:12px; font-weight:800; color:#222; margin-bottom:8px;">Miter Override</div>
            <div style="font-size:11px; color:#666; line-height:1.35; margin-bottom:8px;">
                Auto: <b>${miter.autoType === 'outside90' ? 'Outside 90' : (miter.autoType === 'inside90' ? 'Inside 90' : 'Non-90')}</b><br>
                Angle: ${miter.angleDeg.toFixed(1)} deg
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
                ${buttons.map((btn) => `
                    <button type="button" data-miter-option="${btn.key}" style="display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; border:1px solid ${btn.key === miter.autoType ? '#1a73e8' : '#d0d7de'}; border-radius:8px; background:${btn.key === miter.autoType ? '#edf4ff' : '#fff'}; cursor:pointer; padding:7px 9px; font-size:11px; text-align:left;">
                        <span style="display:flex; align-items:center; gap:8px; min-width:0;">
                        <span style="width:10px; height:10px; border-radius:50%; background:${btn.color}; display:inline-block; flex:0 0 auto;"></span>
                        <span>${btn.label}</span>
                        </span>
                        ${btn.key === miter.autoType ? '<span style="font-size:10px; font-weight:800; color:#1a73e8; text-transform:uppercase; letter-spacing:0.02em;">Auto</span>' : ''}
                    </button>
                `).join('')}
            </div>
        `;
        popupEl.style.display = 'block';
        popupEl.querySelectorAll('[data-miter-option]').forEach((buttonEl) => {
            buttonEl.onclick = (event) => {
                event.stopPropagation();
                const option = buttonEl.getAttribute('data-miter-option');
                onSetMiterOverride(miterId, option, miter.autoType);
            };
        });
        updatePopupPosition();
    };

    const renderSvg = () => {
        const rect = stageEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        const baseSize = getGutterBaseViewSize(crop, rect.width, rect.height);
        viewer.zoom = clamp(viewer.zoom, ZOOM_MIN, ZOOM_MAX);

        const visibleWidth = baseSize.width / viewer.zoom;
        const visibleHeight = baseSize.height / viewer.zoom;
        clampGutterViewToCrop(crop, viewer, visibleWidth, visibleHeight, baseSize);

        const viewBoxX = viewer.centerX - (visibleWidth / 2);
        const viewBoxY = viewer.centerY - (visibleHeight / 2);
        const scaledLineWidth = BASE_LINE_WIDTH / viewer.zoom;
        const scaledDotRadius = BASE_DOT_RADIUS / viewer.zoom;
        const scaledDotStroke = BASE_DOT_STROKE / viewer.zoom;
        const scaledOverrideRadius = OVERRIDE_RING_RADIUS / viewer.zoom;
        const scaledOverrideStroke = OVERRIDE_RING_WIDTH / viewer.zoom;
        const scaledLabelFont = 4.875 / viewer.zoom;
        const scaledLabelPadX = 2.75 / viewer.zoom;
        const scaledLabelPadY = 1.4 / viewer.zoom;

        const lineMarkup = metrics.eaveLines.map((entry) => {
            const p1 = entry.start;
            const p2 = entry.end;
            const lineColor = entry.disabled ? GUTTER_MITER_COLORS.off : '#1a73e8';
            return `<line data-gutter-line="${entry.id}" x1="${Number(p1?.x) || 0}" y1="${Number(p1?.y) || 0}" x2="${Number(p2?.x) || 0}" y2="${Number(p2?.y) || 0}" stroke="${lineColor}" stroke-width="${scaledLineWidth}" stroke-linecap="round" opacity="0.96" style="cursor:pointer;"></line>`;
        }).join('');

        const labelMarkup = metrics.eaveLines.map((entry) => {
            const p1 = entry.start;
            const p2 = entry.end;
            const midX = (((Number(p1?.x) || 0) + (Number(p2?.x) || 0)) / 2);
            const midY = (((Number(p1?.y) || 0) + (Number(p2?.y) || 0)) / 2);
            let angle = Math.atan2((Number(p2?.y) || 0) - (Number(p1?.y) || 0), (Number(p2?.x) || 0) - (Number(p1?.x) || 0)) * (180 / Math.PI);
            if (angle > 90) angle -= 180;
            if (angle < -90) angle += 180;
            const text = formatGutterRunLabel(entry.lengthFt);
            const textWidth = Math.max((text.length * scaledLabelFont * 0.58) + (scaledLabelPadX * 2), scaledLabelFont * 2.8);
            const textHeight = scaledLabelFont + (scaledLabelPadY * 2);
            const textColor = entry.disabled ? '#7b8590' : '#1f2933';
            return `
                <g transform="translate(${midX} ${midY}) rotate(${angle})" style="pointer-events:none;">
                    <rect x="${-textWidth / 2}" y="${-textHeight / 2}" width="${textWidth}" height="${textHeight}" rx="${1.4 / viewer.zoom}" ry="${1.4 / viewer.zoom}" fill="rgba(255,255,255,0.9)" stroke="rgba(102,112,122,0.28)" stroke-width="${0.3 / viewer.zoom}"></rect>
                    <text x="0" y="${scaledLabelFont * 0.33}" text-anchor="middle" font-size="${scaledLabelFont}" font-weight="700" fill="${textColor}" font-family="Arial, sans-serif">${text}</text>
                </g>
            `;
        }).join('');

        const dotMarkup = metrics.miters.map((miter) => {
            const color = GUTTER_MITER_COLORS[miter.type] || GUTTER_MITER_COLORS.non90;
            const label = miter.type === 'outside90'
                ? 'Outside 90 deg miter'
                : (miter.type === 'inside90' ? 'Inside 90 deg miter' : (miter.type === 'off' ? 'Turned off miter' : 'Non-90 deg miter'));
            const overrideRing = miter.isOverridden
                ? `<circle cx="${miter.x}" cy="${miter.y}" r="${scaledOverrideRadius}" fill="none" stroke="${GUTTER_MITER_COLORS.off}" stroke-width="${scaledOverrideStroke}"></circle>`
                : '';
            return `
                <g data-gutter-miter="${miter.id}" style="cursor:pointer;">
                    ${overrideRing}
                    <circle cx="${miter.x}" cy="${miter.y}" r="${scaledDotRadius}" fill="${color}" stroke="#ffffff" stroke-width="${scaledDotStroke}">
                        <title>${label} - ${miter.angleDeg.toFixed(1)} deg${miter.isOverridden ? ' - manual override' : ''}</title>
                    </circle>
                </g>
            `;
        }).join('');

        svgEl.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${visibleWidth} ${visibleHeight}`);
        svgEl.innerHTML = `
            <image href="${outlineImg}" x="${crop.minX}" y="${crop.minY}" width="${crop.width}" height="${crop.height}" preserveAspectRatio="none"></image>
            ${lineMarkup}
            ${labelMarkup}
            ${dotMarkup}
        `;

        if (zoomBadgeEl) {
            zoomBadgeEl.textContent = `${Math.round(viewer.zoom * 100)}%`;
        }
        updatePopupPosition();
    };

    const zoomAroundPoint = (factor, clientX = null, clientY = null) => {
        const rect = stageEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        const prevZoom = viewer.zoom;
        const nextZoom = clamp(prevZoom * factor, ZOOM_MIN, ZOOM_MAX);
        if (Math.abs(nextZoom - prevZoom) < 1e-6) return;

        const baseSize = getGutterBaseViewSize(crop, rect.width, rect.height);
        const prevVisibleWidth = baseSize.width / prevZoom;
        const prevVisibleHeight = baseSize.height / prevZoom;
        clampGutterViewToCrop(crop, viewer, prevVisibleWidth, prevVisibleHeight, baseSize);

        const relX = clientX == null ? 0.5 : clamp((clientX - rect.left) / rect.width, 0, 1);
        const relY = clientY == null ? 0.5 : clamp((clientY - rect.top) / rect.height, 0, 1);
        const prevViewBoxX = viewer.centerX - (prevVisibleWidth / 2);
        const prevViewBoxY = viewer.centerY - (prevVisibleHeight / 2);
        const worldX = prevViewBoxX + (relX * prevVisibleWidth);
        const worldY = prevViewBoxY + (relY * prevVisibleHeight);

        viewer.zoom = nextZoom;
        const nextVisibleWidth = baseSize.width / nextZoom;
        const nextVisibleHeight = baseSize.height / nextZoom;
        viewer.centerX = worldX - (relX * nextVisibleWidth) + (nextVisibleWidth / 2);
        viewer.centerY = worldY - (relY * nextVisibleHeight) + (nextVisibleHeight / 2);
        renderSvg();
    };

    const resetView = () => {
        viewer.zoom = 1;
        viewer.centerX = crop.minX + (crop.width / 2);
        viewer.centerY = crop.minY + (crop.height / 2);
        renderSvg();
    };

    const handleWheel = (event) => {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 0.88 : 1.14;
        zoomAroundPoint(factor, event.clientX, event.clientY);
    };

    let isPanning = false;
    let lastClientX = 0;
    let lastClientY = 0;

    const handlePointerDown = (event) => {
        if (event.button !== 0) return;
        if (popupEl && popupEl.contains(event.target)) return;
        if (event.target?.closest?.('[data-gutter-line], [data-gutter-miter]')) return;
        isPanning = true;
        lastClientX = event.clientX;
        lastClientY = event.clientY;
        stageEl.style.cursor = 'grabbing';
        stageEl.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event) => {
        if (!isPanning) return;
        const rect = stageEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        const baseSize = getGutterBaseViewSize(crop, rect.width, rect.height);
        const visibleWidth = baseSize.width / viewer.zoom;
        const visibleHeight = baseSize.height / viewer.zoom;

        const deltaX = event.clientX - lastClientX;
        const deltaY = event.clientY - lastClientY;
        lastClientX = event.clientX;
        lastClientY = event.clientY;

        viewer.centerX -= (deltaX / rect.width) * visibleWidth;
        viewer.centerY -= (deltaY / rect.height) * visibleHeight;
        renderSvg();
    };

    const handlePointerUp = (event) => {
        if (!isPanning) return;
        isPanning = false;
        stageEl.style.cursor = 'grab';
        try { stageEl.releasePointerCapture(event.pointerId); } catch (e) {}
    };

    const handleResize = () => renderSvg();
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(stageEl);
    }

    stageEl.style.cursor = 'grab';
    stageEl.addEventListener('wheel', handleWheel, { passive: false });
    stageEl.addEventListener('pointerdown', handlePointerDown);
    stageEl.addEventListener('pointermove', handlePointerMove);
    stageEl.addEventListener('pointerup', handlePointerUp);
    stageEl.addEventListener('pointerleave', handlePointerUp);
    stageEl.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('resize', handleResize);
    svgEl.addEventListener('click', (event) => {
        const lineEl = event.target?.closest?.('[data-gutter-line]');
        if (lineEl) {
            event.stopPropagation();
            hidePopup();
            onToggleLine(lineEl.getAttribute('data-gutter-line'));
            return;
        }

        const miterEl = event.target?.closest?.('[data-gutter-miter]');
        if (miterEl) {
            event.stopPropagation();
            showPopupForMiter(miterEl.getAttribute('data-gutter-miter'));
            return;
        }

        hidePopup();
    });
    stageEl.addEventListener('click', (event) => {
        if (popupEl && popupEl.contains(event.target)) return;
        if (!event.target?.closest?.('[data-gutter-line], [data-gutter-miter]')) hidePopup();
    });

    if (!Number.isFinite(viewer.centerX) || !Number.isFinite(viewer.centerY)) {
        resetView();
    } else {
        renderSvg();
    }

    return {
        zoomIn: () => zoomAroundPoint(1.2),
        zoomOut: () => zoomAroundPoint(0.84),
        resetView,
        cleanup: () => {
            hidePopup();
            stageEl.removeEventListener('wheel', handleWheel);
            stageEl.removeEventListener('pointerdown', handlePointerDown);
            stageEl.removeEventListener('pointermove', handlePointerMove);
            stageEl.removeEventListener('pointerup', handlePointerUp);
            stageEl.removeEventListener('pointerleave', handlePointerUp);
            stageEl.removeEventListener('pointercancel', handlePointerUp);
            window.removeEventListener('resize', handleResize);
            if (resizeObserver) resizeObserver.disconnect();
        }
    };
}

async function renderGuttersPage(container) {
    const state = reportConfigState;
    if (!state) return;

    const settings = ensureGutterSettings(state);
    const outlineCanvas = await createFacetCanvasFromState(state, 'OUTLINE');
    const outlineImg = outlineCanvas.toDataURL('image/png');
    let gutterViewerCleanup = null;

    const renderPage = () => {
        if (gutterViewerCleanup) {
            gutterViewerCleanup();
            gutterViewerCleanup = null;
        }
        const metrics = buildGutterMetrics(state);
        const storiesMissingText = metrics.missingStories.length
            ? `${metrics.missingStories.length} required ${metrics.missingStories.length === 1 ? 'field is' : 'fields are'} still blank`
            : 'All directional story fields are filled in';

        const directionCards = GUTTER_DIRECTIONS.map((dir) => {
            const row = metrics.directional[dir];
            const rawStory = settings.stories[dir] || '';
            const invalidStyle = rawStory === ''
                ? 'border-color:#d93025; background:#fff5f5;'
                : 'border-color:#c5d8c9; background:#f7fbf8;';
            const dividerStyle = dir === GUTTER_DIRECTIONS[0]
                ? ''
                : 'border-left:1px solid #e3e6ea;';
            return `
                <div style="padding:0 10px; display:flex; flex-direction:column; gap:8px; min-width:0; ${dividerStyle}">
                    <div style="display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding-bottom:8px; border-bottom:1px solid #e7eaee;">
                        <div style="font-size:13px; font-weight:800; color:#222; white-space:nowrap;">${GUTTER_DIRECTION_LABELS[dir]}</div>
                        <div style="font-size:14px; font-weight:800; color:#333; text-align:right; white-space:nowrap;">${formatGutterFeet(row.lengthFt)}</div>
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                        <label style="font-size:11px; color:#666; font-weight:700; white-space:nowrap;">Stories</label>
                        <input
                            type="number"
                            min="1"
                            max="9"
                            step="1"
                            inputmode="numeric"
                            data-gutter-story="${dir}"
                            value="${escapeHtml(rawStory)}"
                            placeholder="Required"
                            style="width:68px; min-width:0; padding:6px 8px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-size:12px; text-align:center; ${invalidStyle}"
                        >
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Gutters</h2>
            <div style="font-size:12px; color:#666; margin-bottom:14px; line-height:1.45;">
                Eaves are treated as gutter runs here. This page highlights every eave, marks miters by type, and lets the team set required story counts for each cardinal side before we wire the PDF page.
            </div>

            <div style="display:flex; flex-direction:column; gap:14px;">
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                        <div style="font-size:12px; font-weight:700; color:#444;">Roof Diagram</div>
                        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                            <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:#555;">
                                <span style="display:flex; align-items:center; gap:6px;"><span style="width:10px; height:10px; border-radius:50%; background:${GUTTER_MITER_COLORS.outside90}; display:inline-block;"></span> Outside 90 deg</span>
                                <span style="display:flex; align-items:center; gap:6px;"><span style="width:10px; height:10px; border-radius:50%; background:${GUTTER_MITER_COLORS.inside90}; display:inline-block;"></span> Inside 90 deg</span>
                                <span style="display:flex; align-items:center; gap:6px;"><span style="width:10px; height:10px; border-radius:50%; background:${GUTTER_MITER_COLORS.non90}; display:inline-block;"></span> Non-90 deg</span>
                                <span style="display:flex; align-items:center; gap:6px;"><span style="width:14px; height:0; border-top:2px solid #9099a2; display:inline-block;"></span> Gray line = manually excluded</span>
                                <span style="display:flex; align-items:center; gap:6px;"><span style="width:12px; height:12px; border-radius:50%; border:2px solid #b8bfc7; display:inline-block; box-sizing:border-box;"></span> Gray ring = manual override</span>
                            </div>
                            <div style="display:flex; gap:6px; align-items:center;">
                                <button id="gutterZoomOutBtn" type="button" style="width:28px; height:28px; border:1px solid #ccc; border-radius:50%; background:#fff; cursor:pointer; font-size:16px; line-height:1;">-</button>
                                <span id="gutterZoomBadge" style="min-width:52px; text-align:center; background:#333; color:#fff; padding:4px 8px; border-radius:999px; font-size:11px; font-weight:800;">100%</span>
                                <button id="gutterZoomInBtn" type="button" style="width:28px; height:28px; border:1px solid #ccc; border-radius:50%; background:#fff; cursor:pointer; font-size:16px; line-height:1;">+</button>
                                <button id="gutterZoomFitBtn" type="button" style="height:28px; border:1px solid #ccc; border-radius:6px; background:#fff; cursor:pointer; padding:0 10px; font-size:11px; font-weight:700;">Fit</button>
                            </div>
                        </div>
                    </div>
                    <div style="font-size:11px; color:#666; margin-top:-2px;">
                        Scroll to zoom and drag to pan. Click a gutter line to toggle it on or off. Click a miter dot to manually reclassify it or turn it off. Line and miter marker sizes stay visually stable while you zoom in.
                    </div>
                    <div style="background:#fff; border:1px solid #ddd; border-radius:12px; padding:12px;">
                        <div id="gutterDiagramStage" style="position:relative; width:100%; min-height:480px; height:58vh; max-height:760px; background:#f7f7f7; border-radius:8px; overflow:hidden;">
                            <svg id="gutterDiagramSvg" preserveAspectRatio="xMidYMid meet" style="position:absolute; inset:0; width:100%; height:100%; display:block;"></svg>
                            <div id="gutterDiagramPopup" style="display:none; position:absolute; z-index:5; width:190px; background:#fff; border:1px solid #d0d7de; border-radius:10px; box-shadow:0 8px 20px rgba(0,0,0,0.18); padding:10px;"></div>
                        </div>
                    </div>
                </div>

                <div style="display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:10px;">
                    <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px 12px;">
                        <div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:700;">Total Gutters</div>
                        <div style="font-size:22px; font-weight:800; color:#222; margin-top:6px;">${formatGutterFeet(metrics.totalLengthFt)}</div>
                    </div>
                    <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px 12px;">
                        <div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:700;">Est. Downspouts</div>
                        <div style="font-size:22px; font-weight:800; color:#222; margin-top:6px;">${metrics.estimatedDownspouts}</div>
                    </div>
                    <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px 12px;">
                        <div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:700;">Outside 90 deg</div>
                        <div style="font-size:22px; font-weight:800; color:${GUTTER_MITER_COLORS.outside90}; margin-top:6px;">${metrics.miterCounts.outside90}</div>
                    </div>
                    <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px 12px;">
                        <div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:700;">Inside 90 deg</div>
                        <div style="font-size:22px; font-weight:800; color:${GUTTER_MITER_COLORS.inside90}; margin-top:6px;">${metrics.miterCounts.inside90}</div>
                    </div>
                    <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px 12px;">
                        <div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:700;">Non-90 deg</div>
                        <div style="font-size:22px; font-weight:800; color:${GUTTER_MITER_COLORS.non90}; margin-top:6px;">${metrics.miterCounts.non90}</div>
                    </div>
                </div>

                <div style="background:#fff; border:1px solid #ddd; border-radius:10px; padding:12px;">
                    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap;">
                        <div style="font-size:12px; font-weight:700; color:#333;">Stories By Direction</div>
                        <div id="gutterStoriesStatus" style="font-size:11px; color:${metrics.missingStories.length ? '#d93025' : '#188038'}; font-weight:700; text-align:right;">${storiesMissingText}</div>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:0; align-items:start;">
                        ${directionCards}
                    </div>
                </div>
            </div>
        `;

        const diagramStage = container.querySelector('#gutterDiagramStage');
        const diagramSvg = container.querySelector('#gutterDiagramSvg');
        const diagramPopup = container.querySelector('#gutterDiagramPopup');
        const zoomBadge = container.querySelector('#gutterZoomBadge');
        const viewerApi = mountGutterDiagramViewer({
            stageEl: diagramStage,
            svgEl: diagramSvg,
            popupEl: diagramPopup,
            outlineImg,
            state,
            metrics,
            settings,
            zoomBadgeEl: zoomBadge,
            onToggleLine: (lineId) => {
                const current = !!settings.lineOverrides[lineId]?.disabled;
                if (current) delete settings.lineOverrides[lineId];
                else settings.lineOverrides[lineId] = { disabled: true };
                renderPage();
            },
            onSetMiterOverride: (miterId, selectedType, autoType) => {
                if (selectedType === autoType) delete settings.miterOverrides[miterId];
                else settings.miterOverrides[miterId] = selectedType;
                renderPage();
            }
        });
        gutterViewerCleanup = viewerApi.cleanup;
        _labelsOverlayCleanup = () => {
            if (gutterViewerCleanup) {
                gutterViewerCleanup();
                gutterViewerCleanup = null;
            }
        };

        const zoomInBtn = container.querySelector('#gutterZoomInBtn');
        const zoomOutBtn = container.querySelector('#gutterZoomOutBtn');
        const zoomFitBtn = container.querySelector('#gutterZoomFitBtn');
        const storiesStatusEl = container.querySelector('#gutterStoriesStatus');
        if (zoomInBtn) zoomInBtn.onclick = () => viewerApi.zoomIn();
        if (zoomOutBtn) zoomOutBtn.onclick = () => viewerApi.zoomOut();
        if (zoomFitBtn) zoomFitBtn.onclick = () => viewerApi.resetView();

        const updateStoriesStatus = () => {
            if (!storiesStatusEl) return;
            const missingCount = GUTTER_DIRECTIONS.filter((dir) => {
                return String(settings.stories[dir] || '').trim() === '';
            }).length;
            storiesStatusEl.textContent = missingCount
                ? `${missingCount} required ${missingCount === 1 ? 'field is' : 'fields are'} still blank`
                : 'All directional story fields are filled in';
            storiesStatusEl.style.color = missingCount ? '#d93025' : '#188038';
        };

        container.querySelectorAll('[data-gutter-story]').forEach((inputEl) => {
            inputEl.addEventListener('input', () => {
                const dir = inputEl.getAttribute('data-gutter-story');
                const clean = String(inputEl.value || '').replace(/[^\d]/g, '');
                inputEl.value = clean;
                settings.stories[dir] = clean;
                inputEl.style.borderColor = clean ? '#c5d8c9' : '#d93025';
                inputEl.style.background = clean ? '#f7fbf8' : '#fff5f5';
                updateStoriesStatus();
            });
            inputEl.addEventListener('change', () => {
                const dir = inputEl.getAttribute('data-gutter-story');
                const raw = String(inputEl.value || '').trim();
                const numeric = raw === '' ? '' : String(clampNumber(parseInt(raw, 10), 1, 9, 1));
                settings.stories[dir] = numeric;
                inputEl.value = numeric;
                inputEl.style.borderColor = numeric ? '#c5d8c9' : '#d93025';
                inputEl.style.background = numeric ? '#f7fbf8' : '#fff5f5';
                updateStoriesStatus();
            });
        });
    };

    renderPage();
}


// -----------------------------
// MAIN RENDER
// -----------------------------

async function renderConfigPage() {
    const container = document.getElementById('reportPreviewContent');
    const pageList = document.getElementById('pageList');
    const prevBtn = document.getElementById('btnPrevPage');
    const nextBtn = document.getElementById('btnNextPage');

    if (!container || !pageList) return;

    if (_labelsOverlayCleanup) {
        try { _labelsOverlayCleanup(); } catch (e) {}
        _labelsOverlayCleanup = null;
    }

    const planItem = _pagePlan[currentConfigPage - 1];
    renderAdvancedSettingsMenu();

    pageList.innerHTML = '';
    const visibleEntries = _pagePlan
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => !isAdvancedConfigPage(item));
    visibleEntries.forEach(({ item, idx }) => {
        const i = idx + 1;
        const { label, tooltip } = getConfigPageNavMeta(item, i);
        const btn = document.createElement('button');
        btn.className = 'page-num-btn';
        if (i === currentConfigPage) btn.classList.add('active');
        btn.innerText = label;
        btn.title = tooltip;
        btn.onclick = () => {
            goToConfigPage(i);
            btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        };
        pageList.appendChild(btn);
    });

    const visibleIndex = visibleEntries.findIndex(({ idx }) => idx + 1 === currentConfigPage);
    if (prevBtn) prevBtn.disabled = (visibleIndex <= 0);
    if (nextBtn) nextBtn.disabled = (visibleIndex < 0 || visibleIndex >= visibleEntries.length - 1);

    container.innerHTML = '<div style="margin:auto;">Loading Preview...</div>';

    const pageDiv = document.createElement('div');
    pageDiv.className = 'preview-page';
    if (planItem.key === 'labels') pageDiv.classList.add('labels-page');

    try {
        if (planItem.key === 'cover')           await renderCoverPage(pageDiv);
        else if (planItem.key === 'images')     await renderImagesPage(pageDiv);
        else if (planItem.key === 'labels')     await renderLabelsPitchPage(pageDiv);
        else if (planItem.key === 'gutters')    await renderGuttersPage(pageDiv);
        else if (planItem.key === 'layer')      await renderLayerPage(pageDiv, planItem.layer);
        else if (planItem.key === 'structures') await renderStructuresPreview(pageDiv, reportConfigState);
        else if (planItem.key === 'elev')       await renderElevationsPage(pageDiv);
        else if (planItem.key === 'vent')       await renderVentPage(pageDiv);
        else if (planItem.key === 'finalize')   await renderFinalizePage(pageDiv);

        container.innerHTML = '';
        container.appendChild(pageDiv);
    } catch (e) {
        console.error(e);
        container.innerHTML = '<div style="color:red">Error rendering preview.</div>';
    }
}

function goToFinalizePage() {
    const pageNumber = getReportFinalizePageNumber();
    if (pageNumber >= 1) {
        currentConfigPage = pageNumber;
        renderConfigPage();
        // Scroll the pagination button into view
        setTimeout(() => {
            const btn = document.querySelector('#pageList .page-num-btn.active');
            if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }, 50);
    }
}
window.goToFinalizePage = goToFinalizePage;

function getVentilationViewIdForTopView(imageSettings) {
    return imageSettings?.mainViewId === 'apple' ? 'apple' : 'solar';
}
window.getVentilationViewIdForTopView = getVentilationViewIdForTopView;

function syncVentilationViewToTopView(imageSettings) {
    if (!imageSettings) return 'solar';
    const ventViewId = getVentilationViewIdForTopView(imageSettings);
    imageSettings.ventViewId = ventViewId;
    return ventViewId;
}
window.syncVentilationViewToTopView = syncVentilationViewToTopView;

function firstMeasureManualTopViewEnabled() {
    const truthy = (value) => value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true' || String(value || '').trim().toLowerCase() === '1' || String(value || '').trim().toLowerCase() === 'yes';
    const globalSettings = window.FIRSTMEASURE_REPORT_SETTINGS || window.PORTAL_CFG?.report_settings || {};
    const orgSettings = window.projectOrganization?.report_settings || {};
    const candidates = [
        globalSettings.manual_top_view,
        globalSettings.manualTopView,
        globalSettings.enable_manual_top_view,
        globalSettings.enableManualTopView,
        orgSettings.manual_top_view,
        orgSettings.manualTopView,
        orgSettings.general?.manual_top_view,
        orgSettings.general?.manualTopView
    ];
    return candidates.some(truthy);
}
window.firstMeasureManualTopViewEnabled = firstMeasureManualTopViewEnabled;

function ensureReportImageSettings(state) {
    if (!state.imageSettings) {
        state.imageSettings = {
            mainViewId: 'solar',
            ventViewId: 'solar',
            cropPadding: 50,
            cropZoom: REPORT_AUTO_TOP_VIEW_MAX_ZOOM
        };
    }
    const settings = state.imageSettings;
    if (!Number.isFinite(Number(settings.cropZoom)) || Number(settings.cropZoom) <= 0) {
        settings.cropZoom = REPORT_AUTO_TOP_VIEW_MAX_ZOOM;
    } else if (settings.topViewAutoSelection && Number(settings.cropZoom) > REPORT_AUTO_TOP_VIEW_MAX_ZOOM) {
        settings.cropZoom = REPORT_AUTO_TOP_VIEW_MAX_ZOOM;
    }
    if (typeof settings.topViewManualOverride !== 'boolean') {
        settings.topViewManualOverride = !settings.topViewAutoSelection && !!settings.mainViewId && settings.mainViewId !== 'solar';
    }
    syncVentilationViewToTopView(settings);
    return settings;
}

function getReportTopViewAvailableViews() {
    return [
        { id: 'solar', label: 'Solar' },
        { id: 'google', label: 'Google' },
        { id: 'azure', label: 'Bing' },
        { id: 'apple', label: 'Apple' }
    ];
}

function getReportTopViewSourceCanvas(viewId) {
    if (window.ensureProviderCanvasIsUsable) {
        return window.ensureProviderCanvasIsUsable(viewId);
    }
    let sourceCvs = (window.viewCanvases && window.viewCanvases[viewId]) ? window.viewCanvases[viewId] : null;
    if (!sourceCvs && window.ensureViewCanvas) {
        sourceCvs = window.ensureViewCanvas(viewId);
    }
    return sourceCvs;
}

function getReportTopViewSourceStatus(state, viewId, sourceCvs = null) {
    if (!viewId) return { usable: false, reason: 'missing_view' };
    const cvs = sourceCvs || getReportTopViewSourceCanvas(viewId);
    if (!cvs) return { usable: false, reason: 'not_loaded' };
    if (viewId !== 'google' && viewId !== 'azure') return { usable: true, reason: 'not_provider_limited' };
    if (!state || !state.cropRegion || !window.calculateReportTopViewCrop) return { usable: true, reason: 'no_crop_context' };

    const settings = ensureReportImageSettings(state);
    const contentBounds = window.getReportCanvasNonWhiteBounds
        ? window.getReportCanvasNonWhiteBounds(cvs)
        : null;
    const bounds = contentBounds || { minX: 0, minY: 0, maxX: cvs.width, maxY: cvs.height };
    const geometryMaxX = Number(state.cropRegion.minX || 0) + Number(state.cropRegion.width || 0);
    const geometryMaxY = Number(state.cropRegion.minY || 0) + Number(state.cropRegion.height || 0);
    const tolerance = 2;
    const geometryInsideBounds =
        Number(state.cropRegion.minX || 0) >= Number(bounds.minX || 0) - tolerance
        && Number(state.cropRegion.minY || 0) >= Number(bounds.minY || 0) - tolerance
        && geometryMaxX <= Number(bounds.maxX || cvs.width) + tolerance
        && geometryMaxY <= Number(bounds.maxY || cvs.height) + tolerance;
    if (!geometryInsideBounds) {
        return { usable: false, reason: 'geometry_outside_mosaic', contentBounds };
    }

    const crop = window.calculateReportTopViewCrop(state.cropRegion, cvs.width, cvs.height, {
        modelFillRatio: 0.5,
        zoom: settings.cropZoom || REPORT_AUTO_TOP_VIEW_MAX_ZOOM,
        sourceCanvas: cvs,
        contentBounds,
        avoidWhiteEdges: true
    });
    if (!crop) return { usable: false, reason: 'no_crop' };
    if (!crop.cappedBySource) return { usable: true, reason: 'covered', crop };

    return {
        usable: false,
        reason: 'insufficient_mosaic',
        crop
    };
}

function isReportTopViewSourceUsable(state, viewId, sourceCvs = null) {
    return !!getReportTopViewSourceStatus(state, viewId, sourceCvs).usable;
}
window.getReportTopViewSourceStatus = getReportTopViewSourceStatus;
window.isReportTopViewSourceUsable = isReportTopViewSourceUsable;

function getReportTopViewAutoCrop(state, sourceCvs) {
    const settings = ensureReportImageSettings(state);
    if (!sourceCvs || !state.cropRegion || !window.calculateReportTopViewCrop) return null;
    return window.calculateReportTopViewCrop(state.cropRegion, sourceCvs.width, sourceCvs.height, {
        modelFillRatio: 0.5,
        zoom: settings.cropZoom || REPORT_AUTO_TOP_VIEW_MAX_ZOOM,
        sourceCanvas: sourceCvs,
        avoidWhiteEdges: !!settings.topViewAutoSelection || !settings.topViewManualOverride
    });
}

function makeReportTopViewCandidateImage(state, sourceCvs, targetSize = 512) {
    const crop = getReportTopViewAutoCrop(state, sourceCvs);
    if (!crop) return null;
    const c = document.createElement('canvas');
    c.width = targetSize;
    c.height = targetSize;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, targetSize, targetSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
        sourceCvs,
        crop.minX, crop.minY, crop.width, crop.height,
        0, 0, targetSize, targetSize
    );
    return c.toDataURL('image/jpeg', 0.72);
}

function collectLoadedReportTopViewCandidates(state) {
    const candidates = [];
    getReportTopViewAvailableViews().forEach((view) => {
        const sourceCvs = getReportTopViewSourceCanvas(view.id);
        if (!sourceCvs) return;
        if (!isReportTopViewSourceUsable(state, view.id, sourceCvs)) return;
        const image = makeReportTopViewCandidateImage(state, sourceCvs);
        if (!image) return;
        candidates.push({ id: view.id, label: view.label, image });
    });
    return candidates;
}

function collectManualReportTopViewChoices(state) {
    return getReportTopViewAvailableViews().map((view) => {
        const sourceCvs = getReportTopViewSourceCanvas(view.id);
        const usable = !!(sourceCvs && isReportTopViewSourceUsable(state, view.id, sourceCvs));
        const image = usable ? makeReportTopViewCandidateImage(state, sourceCvs, 640) : null;
        return {
            id: view.id,
            label: view.label,
            image,
            usable
        };
    });
}

function applyReportTopViewSelection(state, viewId, meta = {}) {
    if (!state || !viewId) return;
    const settings = ensureReportImageSettings(state);
    settings.mainViewId = viewId;
    settings.cropZoom = REPORT_AUTO_TOP_VIEW_MAX_ZOOM;
    syncVentilationViewToTopView(settings);
    settings.topViewManualOverride = !!meta.manual;
    settings.topViewAutoSelection = {
        at: new Date().toISOString(),
        viewId,
        ventViewId: settings.ventViewId,
        model: meta.model || '',
        reason: meta.reason || '',
        choice: meta.choice || ''
    };
    window.dispatchEvent(new CustomEvent('firstmeasure:topViewChanged', {
        detail: {
            mainViewId: settings.mainViewId || 'solar',
            ventViewId: settings.ventViewId || 'solar'
        }
    }));
}

function showManualReportTopViewChooser(state) {
    if (window.__manualReportTopViewChooserPromise) {
        return window.__manualReportTopViewChooserPromise;
    }
    const choices = collectManualReportTopViewChoices(state);
    const selectableChoices = choices.filter(choice => choice.usable && choice.image);
    if (!selectableChoices.length) return Promise.resolve({ skipped: true, reason: 'no_loaded_sources' });

    window.__manualReportTopViewChooserPromise = new Promise((resolve) => {
        const finish = (result) => {
            window.__manualReportTopViewChooserPromise = null;
            resolve(result);
        };
        const overlay = document.createElement('div');
        overlay.id = 'manual-top-view-chooser';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:100001',
            'background:rgba(17,24,39,0.78)',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'padding:26px',
            'box-sizing:border-box'
        ].join(';');

        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'manualTopViewTitle');
        modal.style.cssText = [
            'width:min(1180px,96vw)',
            'height:min(860px,92vh)',
            'background:#fff',
            'border-radius:8px',
            'box-shadow:0 28px 80px rgba(0,0,0,0.38)',
            'display:flex',
            'flex-direction:column',
            'font-family:Arial,sans-serif',
            'overflow:hidden',
            'color:#202124'
        ].join(';');

        modal.innerHTML = `
            <div style="padding:20px 24px 14px; border-bottom:1px solid #e5e7eb;">
                <h2 id="manualTopViewTitle" style="margin:0; font-size:22px; color:#202124;">Choose the best top view</h2>
                <div style="margin-top:6px; font-size:13px; line-height:1.45; color:#5f6368;">
                    Which of these images is the best quality footage of the property?
                </div>
            </div>
            <div id="manualTopViewGrid" style="flex:1; min-height:0; padding:18px 24px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); gap:14px; background:#f6f8fb;"></div>
            <div style="padding:14px 24px; border-top:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between; gap:12px;">
                <div id="manualTopViewStatus" style="font-size:12px; font-weight:700; color:#6b7280;">Select one image to continue.</div>
                <button type="button" id="manualTopViewConfirm" disabled style="border:1px solid #c8d2dc; background:#eef2f7; color:#7b8490; border-radius:6px; padding:10px 16px; font-size:13px; font-weight:800; cursor:not-allowed;">Confirm selected image</button>
            </div>
        `;

        const grid = modal.querySelector('#manualTopViewGrid');
        const status = modal.querySelector('#manualTopViewStatus');
        const confirmBtn = modal.querySelector('#manualTopViewConfirm');
        let selectedId = '';

        const setSelected = (choice) => {
            if (!choice.usable || !choice.image) return;
            selectedId = choice.id;
            grid.querySelectorAll('[data-top-view-choice]').forEach((card) => {
                const selected = card.getAttribute('data-top-view-choice') === selectedId;
                card.style.borderColor = selected ? '#1a73e8' : '#d0d7de';
                card.style.boxShadow = selected ? '0 0 0 3px rgba(26,115,232,0.18)' : 'none';
                card.style.background = selected ? '#eef5ff' : '#fff';
            });
            if (status) status.textContent = `${choice.label} selected. Confirm that this is the best image.`;
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.style.background = '#1a73e8';
                confirmBtn.style.borderColor = '#1a73e8';
                confirmBtn.style.color = '#fff';
                confirmBtn.style.cursor = 'pointer';
            }
        };

        choices.forEach((choice) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.setAttribute('data-top-view-choice', choice.id);
            card.disabled = !choice.usable || !choice.image;
            card.style.cssText = [
                'border:2px solid #d0d7de',
                'border-radius:8px',
                'background:#fff',
                'padding:0',
                'overflow:hidden',
                'display:flex',
                'flex-direction:column',
                'min-width:0',
                'min-height:0',
                `cursor:${choice.usable && choice.image ? 'pointer' : 'not-allowed'}`,
                'text-align:left'
            ].join(';');

            card.innerHTML = `
                <div style="height:34px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0 12px; border-bottom:1px solid #e5e7eb;">
                    <span style="font-size:13px; font-weight:800; color:#202124;">${choice.label}</span>
                    <span style="font-size:10px; font-weight:800; color:${choice.usable ? '#188038' : '#9aa0a6'};">${choice.usable ? 'READY' : 'UNAVAILABLE'}</span>
                </div>
                <div style="flex:1; min-height:0; background:#e5e7eb; display:flex; align-items:center; justify-content:center;">
                    ${choice.image
                        ? `<img alt="${choice.label} top view" src="${choice.image}" style="width:100%; height:100%; object-fit:cover; display:block;">`
                        : '<div style="padding:20px; font-size:12px; font-weight:700; color:#777; text-align:center;">Image source is not loaded or does not cover the property.</div>'}
                </div>
            `;

            card.addEventListener('click', () => setSelected(choice));
            grid.appendChild(card);
        });

        confirmBtn.addEventListener('click', async () => {
            if (!selectedId) return;
            const selected = choices.find(choice => choice.id === selectedId);
            applyReportTopViewSelection(state, selectedId, {
                manual: true,
                model: 'manual',
                reason: 'Selected manually by drafter.',
                choice: selected ? selected.label : selectedId
            });
            state.imageSettings.manualTopViewSelection = {
                at: new Date().toISOString(),
                viewId: selectedId,
                label: selected ? selected.label : selectedId
            };
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Saving selection...';
                confirmBtn.style.cursor = 'wait';
            }
            if (status) status.textContent = 'Saving top view selection...';
            try {
                if (typeof window.updateStateImages === 'function') {
                    await window.updateStateImages(state, { captureWireframes: false });
                }
                if (typeof window.serializePdfConfigForSave === 'function') {
                    window.loadedPdfConfig = window.serializePdfConfigForSave(state);
                }
                if (typeof window.saveStandalonePdfState === 'function') {
                    await window.saveStandalonePdfState(state, { refreshImages: false });
                }
            } catch (e) {
                console.warn('[Report Config] Top view selection save skipped:', e);
            }
            overlay.remove();
            finish({ success: true, view_id: selectedId });
        });

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    });
    return window.__manualReportTopViewChooserPromise;
}

async function maybeRunManualReportTopViewChooser(state) {
    if (!firstMeasureManualTopViewEnabled() || !state) return { skipped: true, reason: 'manual_mode_off' };
    const settings = ensureReportImageSettings(state);
    const savedConfigViewId = String(window.loadedPdfConfig?.imageSettings?.mainViewId || '').trim();
    const savedSnapshotViewId = window.__loadedPdfSnapshotHasTopViewSelection ? String(settings.mainViewId || '').trim() : '';
    const existingSelectedViewId =
        settings.manualTopViewSelection?.viewId ||
        settings.topViewAutoSelection?.viewId ||
        savedSnapshotViewId ||
        savedConfigViewId ||
        (settings.topViewManualOverride && settings.mainViewId ? settings.mainViewId : '');
    if (existingSelectedViewId) {
        return { skipped: true, reason: 'already_selected', view_id: existingSelectedViewId };
    }
    return showManualReportTopViewChooser(state);
}

function normalizeReportVentManualOverride(state) {
    if (!state || !state.ventSettings) return false;
    if (typeof state.ventSettings.manualOverride === 'boolean') return state.ventSettings.manualOverride;
    const hasAutomation = !!state.ventSettings.automationResult || !!state.ventSettings.shortRidgesAutoExcluded;
    const hasManualLookingState = state.ventSettings.include === false ||
        (Array.isArray(state.ventSettings.excludedRidges) && state.ventSettings.excludedRidges.length > 0) ||
        (Array.isArray(state.ventSettings.boxVents) && state.ventSettings.boxVents.length > 0);
    state.ventSettings.manualOverride = !hasAutomation && hasManualLookingState;
    return state.ventSettings.manualOverride;
}

async function rerollReportTopViewSelection(state, options = {}) {
    if (!state) return null;
    if (_reportTopViewUnavailableReason) {
        return { skipped: true, reason: 'service_unavailable', error: _reportTopViewUnavailableReason };
    }
    if (_reportTopViewRerollPromise) return _reportTopViewRerollPromise;

    _reportTopViewRerollPromise = rerollReportTopViewSelectionOnce(state, options);
    try {
        return await _reportTopViewRerollPromise;
    } finally {
        _reportTopViewRerollPromise = null;
    }
}

async function rerollReportTopViewSelectionOnce(state, options = {}) {
    const settings = ensureReportImageSettings(state);
    const force = !!options.force;
    if (settings.topViewManualOverride && !force) return { skipped: true, reason: 'manual_override' };
    const existingAutoViewId = settings.topViewAutoSelection && typeof settings.topViewAutoSelection === 'object'
        ? settings.topViewAutoSelection.viewId
        : null;
    if (existingAutoViewId && !force) {
        settings.mainViewId = existingAutoViewId;
        settings.cropZoom = REPORT_AUTO_TOP_VIEW_MAX_ZOOM;
        syncVentilationViewToTopView(settings);
        return { skipped: true, reason: 'existing_auto_selection', view_id: existingAutoViewId };
    }

    const candidates = collectLoadedReportTopViewCandidates(state);
    if (!candidates.length) return { skipped: true, reason: 'no_loaded_sources' };

    if (candidates.length === 1) {
        applyReportTopViewSelection(state, candidates[0].id, {
            model: 'none',
            reason: 'Only one loaded image was available.',
            choice: 'A',
            manual: false
        });
        return { success: true, view_id: candidates[0].id, reason: 'Only one loaded image was available.' };
    }

    const resp = await fetch('top_view_reroll_proxy.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: candidates })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.success) {
        const errorMessage = String(data && data.error || '').trim();
        if (/missing\s+openai_api_key|openai_api_key.*missing/i.test(errorMessage)) {
            _reportTopViewUnavailableReason = errorMessage;
            if (!_reportTopViewUnavailableLogged) {
                _reportTopViewUnavailableLogged = true;
                console.info('[Top View Auto] Disabled for this page because the optional API key is not configured.');
            }
            return { skipped: true, reason: 'missing_api_key', error: errorMessage };
        }
        if (data) console.warn('[Top View Auto] Proxy response:', data);
        const upstream = data && data.upstream_error ? `: ${data.upstream_error}` : '';
        const transport = data && data.transport_error ? ` [transport: ${data.transport_error}]` : '';
        const raw = data && data.raw_choice_preview ? ` Returned: ${data.raw_choice_preview}` : '';
        const statusValue = data && Object.prototype.hasOwnProperty.call(data, 'status') ? data.status : resp.status;
        throw new Error((data && data.error) ? `${data.error} (${statusValue})${upstream}${transport}${raw}` : `Top view re-roll failed (${statusValue})`);
    }
    const selected = candidates.find(candidate => candidate.id === data.view_id);
    if (!selected) throw new Error('Top view re-roll returned an unavailable image source.');
    if (settings.topViewManualOverride && !force) return { skipped: true, reason: 'manual_override' };
    applyReportTopViewSelection(state, selected.id, { ...data, manual: false });
    return data;
}

async function runReportVentilationAutomationInBackground(state) {
    if (!state || isCommercialProjectReportConfig(state)) return;
    if (!state.ventSettings) state.ventSettings = {};
    if (normalizeReportVentManualOverride(state)) return;
    state.ventSettings.shortRidgesAutoExcluded = false;
    reportConfigState = state;
    window.reportConfigState = state;
    const scratch = document.createElement('div');
    scratch.style.cssText = 'position:absolute; left:-10000px; top:-10000px; width:1px; height:1px; overflow:hidden;';
    document.body.appendChild(scratch);
    try {
        await renderVentPage(scratch);
    } finally {
        scratch.remove();
    }
}

function startReportConfigurationAutomations(state) {
    if (!state) return null;
    _reportAutomationPromise = (async () => {
        if (!firstMeasureManualTopViewEnabled()) {
            try {
                await rerollReportTopViewSelection(state);
            } catch (e) {
                console.warn('[Report Config] Top view automation skipped:', e);
            }
        }
        try {
            await runReportVentilationAutomationInBackground(state);
        } catch (e) {
            console.warn('[Report Config] Ventilation automation skipped:', e);
        }
        if (typeof window.updateStateImages === 'function') {
            try {
                await window.updateStateImages(state, { captureWireframes: false });
            } catch (e) {
                console.warn('[Report Config] Image refresh skipped:', e);
            }
        }
        return state;
    })();
    return _reportAutomationPromise;
}

async function waitForReportConfigurationAutomations(state) {
    if (!_reportAutomationPromise && state) startReportConfigurationAutomations(state);
    if (!_reportAutomationPromise) return state;
    try {
        await _reportAutomationPromise;
    } catch (e) {
        console.warn('[Report Config] Background automation failed:', e);
    }
    return state;
}


async function renderImagesPage(container) {
    const state = reportConfigState;
    const settings = ensureReportImageSettings(state);
    const availableViews = getReportTopViewAvailableViews();

    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Top View Configuration</h2>
        <div style="display:flex; flex-direction:column; gap:15px; height:100%;">
            
            <div style="background:#f9f9f9; padding:10px; border:1px solid #ddd; border-radius:6px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px;">
                    <div style="font-weight:bold; font-size:12px; color:#333;">Top View Source</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div id="autoCropStatus" style="font-size:10px; color:#666; text-align:right;">Auto-fit crop</div>
                        <button type="button" id="topViewRerollBtn" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:6px; padding:5px 8px; font-size:11px; font-weight:800; cursor:pointer;">
                            Re-roll
                        </button>
                    </div>
                </div>
                <div class="view-toggle-group" id="topViewToggles" style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px;"></div>
                <div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                    <label style="font-size:11px; font-weight:bold; color:#555;">Zoom:</label>
                    <input type="range" id="cropZoomInput" min="0.25" max="2.5" step="0.05" value="${settings.cropZoom}" style="flex:1;">
                    <span id="cropZoomVal" style="font-size:11px; width:44px; text-align:right;">${Math.round(settings.cropZoom * 100)}%</span>
                </div>
            </div>

            <div style="flex:1; display:flex; flex-direction:column; gap:5px;">
                <div style="font-size:11px; font-weight:bold; color:#777;">Top View Crop Preview (Square):</div>
                <div style="flex:1; background:#333; border-radius:4px; overflow:hidden; position:relative; display:flex; align-items:center; justify-content:center;">
                    <canvas id="imgConfigPreview" style="max-width:100%; max-height:100%;"></canvas>
                </div>
            </div>
        </div>
    `;

    const previewCanvas = container.querySelector('#imgConfigPreview');
    const pCtx = previewCanvas.getContext('2d');
    const statusEl = container.querySelector('#autoCropStatus');
    const rerollBtn = container.querySelector('#topViewRerollBtn');
    const manualTopViewMode = firstMeasureManualTopViewEnabled();
    if (rerollBtn && manualTopViewMode) {
        rerollBtn.style.display = 'none';
    }

    const getSourceCanvas = getReportTopViewSourceCanvas;

    const getVisibleTopViewViews = () => {
        return availableViews.filter((view) => {
            const sourceCvs = getSourceCanvas(view.id);
            if (!sourceCvs) return true;
            return isReportTopViewSourceUsable(state, view.id, sourceCvs);
        });
    };

    const ensureSelectedTopViewSourceUsable = () => {
        const selectedCvs = getSourceCanvas(settings.mainViewId);
        if (!selectedCvs || isReportTopViewSourceUsable(state, settings.mainViewId, selectedCvs)) return;
        settings.mainViewId = 'solar';
        settings.topViewManualOverride = false;
        syncVentilationViewToTopView(settings);
    };

    const getAutoCrop = (sourceCvs) => {
        return getReportTopViewAutoCrop(state, sourceCvs);
    };

    const drawCropPreview = (targetCanvas, sourceCvs, targetSize = 220) => {
        const crop = getAutoCrop(sourceCvs);
        if (!crop) return null;

        targetCanvas.width = targetSize;
        targetCanvas.height = targetSize;
        const ctx = targetCanvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, targetSize, targetSize);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
            sourceCvs,
            crop.minX, crop.minY, crop.width, crop.height,
            0, 0, targetSize, targetSize
        );
        return crop;
    };

    const makeTopViewCandidateImage = (sourceCvs, targetSize = 512) => {
        const crop = getAutoCrop(sourceCvs);
        if (!crop) return null;
        return makeReportTopViewCandidateImage(state, sourceCvs, targetSize);
    };

    const collectLoadedTopViewCandidates = () => {
        const candidates = [];
        availableViews.forEach((view) => {
            const sourceCvs = getSourceCanvas(view.id);
            if (!sourceCvs) return;
            if (!isReportTopViewSourceUsable(state, view.id, sourceCvs)) return;
            const image = makeTopViewCandidateImage(sourceCvs);
            if (!image) return;
            candidates.push({ id: view.id, label: view.label, image });
        });
        return candidates;
    };

    const renderPreview = () => {
        ensureSelectedTopViewSourceUsable();
        const viewId = settings.mainViewId;
        let sourceCvs = getSourceCanvas(viewId);

        if (!sourceCvs) {
            pCtx.clearRect(0,0, previewCanvas.width, previewCanvas.height);
            if(previewCanvas.width < 100) { previewCanvas.width = 300; previewCanvas.height=200; }
            pCtx.fillStyle = '#eee';
            pCtx.fillRect(0,0, previewCanvas.width, previewCanvas.height);
            pCtx.fillStyle = '#d93025';
            pCtx.font = "bold 12px sans-serif";
            pCtx.textAlign = "center";
            pCtx.fillText("Image Source Not Loaded", previewCanvas.width/2, previewCanvas.height/2 - 10);
            if (statusEl) statusEl.textContent = 'Source not loaded';
            return;
        }

        const crop = getAutoCrop(sourceCvs);
        if (!crop) return;

        previewCanvas.width = crop.width;
        previewCanvas.height = crop.height;
        pCtx.fillStyle = '#ffffff';
        pCtx.fillRect(0, 0, crop.width, crop.height);

        pCtx.drawImage(
            sourceCvs,
            crop.minX, crop.minY, crop.width, crop.height,
            0, 0, crop.width, crop.height
        );
        
        pCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
        pCtx.lineWidth = Math.max(2, crop.width * 0.006);
        pCtx.strokeRect(state.cropRegion.minX - crop.minX, state.cropRegion.minY - crop.minY, state.cropRegion.width, state.cropRegion.height);

        const fillPct = Math.round((Math.max(state.cropRegion.width, state.cropRegion.height) / crop.width) * 100);
        if (statusEl) {
            statusEl.textContent = crop.cappedBySource
                ? `Auto-fit: ${fillPct}% model width (limited by source)`
                : `Auto-fit: ${fillPct}% model width`;
        }
    };

    const notifyTopViewChanged = () => {
        syncVentilationViewToTopView(settings);
        window.dispatchEvent(new CustomEvent('firstmeasure:topViewChanged', {
            detail: {
                mainViewId: settings.mainViewId || 'solar',
                ventViewId: settings.ventViewId || 'solar'
            }
        }));
    };

    const applyTopViewSelection = (viewId, meta = {}) => {
        if (!viewId) return;
        settings.mainViewId = viewId;
        settings.cropZoom = REPORT_AUTO_TOP_VIEW_MAX_ZOOM;
        syncVentilationViewToTopView(settings);
        settings.topViewManualOverride = false;
        state.imageSettings.topViewAutoSelection = {
            at: new Date().toISOString(),
            viewId,
            ventViewId: settings.ventViewId,
            model: meta.model || '',
            reason: meta.reason || '',
            choice: meta.choice || ''
        };
        if (zoomSlider) zoomSlider.value = String(settings.cropZoom);
        if (zoomVal) zoomVal.innerText = Math.round(settings.cropZoom * 100) + '%';
        notifyTopViewChanged();
        renderButtons();
        renderPreview();
    };

    const rerollTopViewSelection = async () => {
        const candidates = collectLoadedTopViewCandidates();
        if (!candidates.length) {
            alert('No loaded image sources are available for top view re-roll.');
            return;
        }
        if (candidates.length === 1) {
            applyTopViewSelection(candidates[0].id, {
                model: 'none',
                reason: 'Only one loaded image was available.',
                choice: 'A'
            });
            if (statusEl) statusEl.textContent = `Auto-selected ${candidates[0].label}: only loaded source`;
            return;
        }

        const resp = await fetch('top_view_reroll_proxy.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: candidates })
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data || !data.success) {
            if (data) {
                console.warn('[Top View Re-roll] Proxy response:', data);
            }
            const upstream = data && data.upstream_error ? `: ${data.upstream_error}` : '';
            const transport = data && data.transport_error ? ` [transport: ${data.transport_error}]` : '';
            const raw = data && data.raw_choice_preview ? ` Returned: ${data.raw_choice_preview}` : '';
            const statusValue = data && Object.prototype.hasOwnProperty.call(data, 'status') ? data.status : resp.status;
            const status = ` (${statusValue})`;
            throw new Error((data && data.error) ? `${data.error}${status}${upstream}${transport}${raw}` : `Top view re-roll failed${status}`);
        }
        const selected = candidates.find(candidate => candidate.id === data.view_id);
        if (!selected) throw new Error('Top view re-roll returned an unavailable image source.');
        applyTopViewSelection(selected.id, data);
        if (statusEl) {
            statusEl.textContent = `Auto-selected ${selected.label}${data.reason ? ': ' + data.reason : ''}`;
        }
    };

    const renderButtons = () => {
        ensureSelectedTopViewSourceUsable();
        const wrap = container.querySelector('#topViewToggles');
        wrap.innerHTML = '';
        getVisibleTopViewViews().forEach(v => {
            const btn = document.createElement('button');
            const sourceCvs = getSourceCanvas(v.id);
            const selected = settings.mainViewId === v.id;
            btn.className = 'toggle-btn image-source-card';
            btn.style.cssText = `
                padding:0; font-size:11px; border:1px solid ${selected ? '#1a73e8' : '#ccd1d6'}; background:${selected ? '#e8f0fe' : '#fff'}; cursor:pointer; border-radius:6px;
                color:${selected ? '#1a73e8' : '#555'}; overflow:hidden; display:flex; flex-direction:column; min-width:0; text-align:left;
                box-shadow:${selected ? '0 0 0 2px rgba(26,115,232,0.15)' : 'none'};
            `;
            btn.innerHTML = `
                <div style="aspect-ratio:1 / 1; width:100%; background:#e5e7eb; display:flex; align-items:center; justify-content:center; position:relative;">
                    ${sourceCvs ? '<canvas class="source-thumb" width="180" height="180" style="width:100%; height:100%; display:block;"></canvas>' : '<span style="font-size:10px; color:#777;">Not loaded</span>'}
                </div>
                <div style="padding:6px 7px; display:flex; align-items:center; justify-content:space-between; gap:6px;">
                    <span style="font-weight:${selected ? '800' : '700'}; overflow:hidden; text-overflow:ellipsis;">${v.label}</span>
                    <span style="font-size:9px; color:${sourceCvs ? '#2e7d32' : '#999'};">${sourceCvs ? 'Ready' : 'Load'}</span>
                </div>
            `;

            const thumb = btn.querySelector('.source-thumb');
            if (thumb && sourceCvs) {
                drawCropPreview(thumb, sourceCvs, 180);
            }
            
            btn.onclick = async () => {
                settings.mainViewId = v.id;
                settings.topViewManualOverride = true;
                notifyTopViewChanged();
                renderButtons();
                
                const isLoaded = getSourceCanvas(v.id);
                
                if (!isLoaded) {
                    try {
                        if(v.id === 'google' && window.handleGoogleLayerFetch) await window.handleGoogleLayerFetch();
                        else if(v.id === 'apple' && window.handleAppleLayerFetch) await window.handleAppleLayerFetch();
                        else if(v.id === 'azure' && window.handleAzureLayerFetch) await window.handleAzureLayerFetch();
                    } catch(e) { 
                        alert("Failed to load " + v.label);
                    }
                }
                renderButtons();
                renderPreview();
                notifyTopViewChanged();
            };
            wrap.appendChild(btn);
        });
    };

    renderButtons();
    const zoomSlider = container.querySelector('#cropZoomInput');
    const zoomVal = container.querySelector('#cropZoomVal');
    if (zoomSlider) {
        zoomSlider.oninput = () => {
            settings.cropZoom = parseFloat(zoomSlider.value) || 1;
            settings.topViewManualOverride = true;
            if (zoomVal) zoomVal.innerText = Math.round(settings.cropZoom * 100) + '%';
            renderButtons();
            renderPreview();
        };
    }
    if (rerollBtn) {
        rerollBtn.onclick = async () => {
            if (manualTopViewMode) return;
            const originalText = rerollBtn.textContent;
            rerollBtn.disabled = true;
            rerollBtn.textContent = 'Checking...';
            if (statusEl) statusEl.textContent = 'Comparing loaded image sources...';
            try {
                await rerollTopViewSelection();
            } catch (e) {
                console.error('[Top View Re-roll]', e);
                alert(e && e.message ? e.message : 'Top view re-roll failed.');
                renderPreview();
            } finally {
                rerollBtn.disabled = false;
                rerollBtn.textContent = originalText || 'Re-roll';
            }
        };
    }
    renderPreview();
}



function goToConfigPage(pageNum) {
    if (pageNum >= 1 && pageNum <= totalConfigPages) {
        currentConfigPage = pageNum;
        renderConfigPage();
    }
}

window.goToConfigPage = goToConfigPage;

// =============================================================================
// DROP-IN REPLACEMENT: renderCoverPage  (report.js)
// — Branding section: colors stacked left, large logo right, open by default
// — Gated by ?branding=1
// — No company name/phone/email/website fields
// =============================================================================

async function renderCoverPage(container) {
    const state = reportConfigState;
    if (!state) return;

    if (typeof state.manualTotalFacets !== 'number') state.manualTotalFacets = (state.facesData || []).length;
    if (typeof state.manualWastePct !== 'number') {
        const hipsFt = (typeof window.calculateReportHipLengthFt === 'function')
            ? window.calculateReportHipLengthFt(state.report)
            : 0;
        state.manualWastePct = (typeof window.calculateSuggestedWasteFromFacetCount === 'function')
            ? window.calculateSuggestedWasteFromFacetCount(state.manualTotalFacets, hipsFt)
            : 10;
    }

    if (!state.report.resident) state.report.resident = {};

    let quadWarningHtml = '';
    if (!areReportQuadViewsDisabled() && !state.quadImage) {
        quadWarningHtml = `
            <div style="
                color: #d93025; 
                font-weight: bold; 
                margin-bottom: 15px; 
                padding: 8px; 
                border: 2px dashed #d93025; 
                background-color: #fff0f0; 
                text-align: center; 
                border-radius: 6px;
                font-size: 11px;
                text-transform: uppercase;
            ">
                <i class="fas fa-exclamation-triangle"></i> No Quad View Uploaded
            </div>
        `;
    }

    const outlineCvs = await createFacetCanvasFromState(state, 'OUTLINE');
    const outlineImg = outlineCvs.toDataURL('image/png');

    // --- Branding gate ---
    const urlParams = new URLSearchParams(window.location.search);
    const showBranding = (urlParams.get('branding') === '1');

    // --- Initialize branding overrides (always, so PDF gen can read them) ---
    if (!state.brandingOverrides) {
        const org = window.projectOrganization || {};
        const br  = org.branding || {};
        state.brandingOverrides = {
            primaryColor:   (br.colors && br.colors.primary)   || '',
            secondaryColor: (br.colors && br.colors.secondary) || '',
            logoDataUrl:    null
        };
    }
    const bo = state.brandingOverrides;

    const logoPreviewSrc = () => {
        if (bo.logoDataUrl) return bo.logoDataUrl;
        const br = (window.projectOrganization || {}).branding;
        return firstReportLogoValue(br, window.projectOrganization) || '/images/logo_red.png';
    };

    // --- Build branding HTML only when enabled ---
    let brandingHtml = '';
    if (showBranding) {
        brandingHtml = `
        <details id="brandingDetails" open style="margin-bottom:10px; border:1px solid #ddd; border-radius:6px; background:#fff;">
            <summary style="padding:8px 12px; cursor:pointer; font-weight:bold; font-size:12px; color:#555; user-select:none;">
                <i class="fas fa-palette" style="margin-right:4px;"></i> Company Branding
            </summary>
            <div style="padding:12px; display:flex; gap:16px; align-items:stretch;">

                <!-- LEFT: Colors stacked -->
                <div style="display:flex; flex-direction:column; gap:10px; min-width:130px;">
                    <div>
                        <label style="font-size:11px; color:#666; font-weight:bold; display:block; margin-bottom:3px;">Primary Color</label>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input id="brandPrimary" type="color" value="${escapeHtml(bo.primaryColor || '#c82828')}"
                                style="width:36px; height:30px; border:1px solid #ccc; border-radius:4px; padding:1px; cursor:pointer;">
                            <input id="brandPrimaryHex" type="text" value="${escapeHtml(bo.primaryColor || '#c82828')}"
                                style="width:72px; padding:5px; border:1px solid #ccc; border-radius:4px; font-size:11px; font-family:monospace;">
                        </div>
                    </div>
                    <div>
                        <label style="font-size:11px; color:#666; font-weight:bold; display:block; margin-bottom:3px;">Secondary Color</label>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input id="brandSecondary" type="color" value="${escapeHtml(bo.secondaryColor || '#960000')}"
                                style="width:36px; height:30px; border:1px solid #ccc; border-radius:4px; padding:1px; cursor:pointer;">
                            <input id="brandSecondaryHex" type="text" value="${escapeHtml(bo.secondaryColor || '#960000')}"
                                style="width:72px; padding:5px; border:1px solid #ccc; border-radius:4px; font-size:11px; font-family:monospace;">
                        </div>
                    </div>
                </div>

                <!-- RIGHT: Large logo preview -->
                <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:8px;">
                    <label style="font-size:11px; color:#666; font-weight:bold;">Logo</label>
                    <div style="flex:1; width:100%; display:flex; align-items:center; justify-content:center; border:1px solid #ddd; border-radius:6px; background:#f9f9f9; padding:6px; min-height:80px;">
                        <img id="brandLogoPreview" src="${logoPreviewSrc()}"
                            style="max-width:100%; max-height:120px; object-fit:contain;">
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button id="brandLogoUpload" style="padding:5px 12px; border:1px solid #ccc; background:#fff; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                            <i class="fas fa-upload" style="margin-right:3px;"></i> Upload
                        </button>
                        <button id="brandLogoClear" style="padding:5px 8px; border:1px solid #d93025; color:#d93025; background:#fff; border-radius:4px; cursor:pointer; font-size:11px; ${bo.logoDataUrl ? '' : 'display:none;'}" title="Revert to company default">
                            <i class="fas fa-undo"></i> Revert
                        </button>
                        <input id="brandLogoFile" type="file" accept="image/*" style="display:none;">
                    </div>
                </div>

            </div>
        </details>
        `;
    }

    // --- Quick Submit button (branding mode only) ---
    let quickSubmitHtml = '';
    if (showBranding) {
        quickSubmitHtml = `
        <div style="margin-top:12px; padding-top:12px; border-top:2px dashed #ddd; display:flex; align-items:center; gap:12px;">
            <button id="btnQuickSubmit" style="
                padding:12px 24px; border:none; border-radius:8px;
                background:#d93025; color:#fff; font-size:14px; font-weight:800;
                cursor:pointer; display:flex; align-items:center; gap:8px;
                box-shadow:0 2px 8px rgba(217,48,37,0.3); transition:background 0.2s;
            " onmouseenter="this.style.background='#b71c1c'" onmouseleave="this.style.background='#d93025'">
                <i class="fas fa-bolt"></i> Quick Submit PDF
            </button>
            <span style="font-size:11px; color:#888; flex:1;">
                Bypasses the finalize checklist — generates and downloads the report immediately.
            </span>
        </div>
        `;
    }

    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Project Overview</h2>

        ${quadWarningHtml}

        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #eee;">
            <div>
                <label style="font-size:11px; color:#666; font-weight:bold;">Customer Name</label>
                <input id="residentNameInput" type="text" value="${escapeHtml(state.report.resident.name || '')}"
                    style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px; font-size:12px; box-sizing:border-box;">
            </div>
            <div>
                <label style="font-size:11px; color:#666; font-weight:bold;">Customer Email</label>
                <input id="residentEmailInput" type="text" value="${escapeHtml(state.report.resident.email || '')}"
                    style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px; font-size:12px; box-sizing:border-box;">
            </div>
            <div>
                <label style="font-size:11px; color:#666; font-weight:bold;">Customer Phone</label>
                <input id="residentPhoneInput" type="text" value="${escapeHtml(state.report.resident.phone || '')}"
                    style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px; font-size:12px; box-sizing:border-box;">
            </div>
        </div>

        ${brandingHtml}

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:12px;">
            <div>
                <label style="font-size:12px; color:#666;">Project Address (Editable)</label>
                <input id="cfgAddress" type="text" value="${escapeHtml(state.address || '')}"
                    style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box;">
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                <div>
                    <label style="font-size:12px; color:#666;">Sugg. Waste %</label>
                    <input id="cfgWaste" type="number" step="1" min="0" max="60" value="${Number(state.manualWastePct || 10)}"
                        style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:12px; color:#666;">Total Facets</label>
                    <input id="cfgFacets" type="number" step="1" min="0" max="999" value="${Number(state.manualTotalFacets || 0)}"
                        style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box;">
                </div>
            </div>
        </div>

        <div style="font-size:11px; color:#666; margin:6px 0 10px 0;">
            Cover uses raw outline diagram (no pitch/area labels).
        </div>

        <div style="flex:1; display:flex; align-items:center; justify-content:center; border:1px solid #ddd; border-radius:10px; background:#fafafa; overflow:hidden;">
            <img src="${outlineImg}" style="max-width:100%; max-height:100%; display:block;">
        </div>

        ${quickSubmitHtml}
    `;

    // --- Wire standard fields ---
    const addr = container.querySelector('#cfgAddress');
    const waste = container.querySelector('#cfgWaste');
    const facets = container.querySelector('#cfgFacets');
    const rName = container.querySelector('#residentNameInput');
    const rEmail = container.querySelector('#residentEmailInput');
    const rPhone = container.querySelector('#residentPhoneInput');
    const calculateCurrentSuggestedWaste = () => {
        const hipsFt = (typeof window.calculateReportHipLengthFt === 'function')
            ? window.calculateReportHipLengthFt(state.report)
            : 0;
        return (typeof window.calculateSuggestedWasteFromFacetCount === 'function')
            ? window.calculateSuggestedWasteFromFacetCount(state.manualTotalFacets, hipsFt)
            : state.manualWastePct;
    };
    let wasteEditedManually = false;

    if (rName) rName.oninput = () => { state.report.resident.name = rName.value; };
    if (rEmail) rEmail.oninput = () => { state.report.resident.email = rEmail.value; };
    if (rPhone) rPhone.oninput = () => { state.report.resident.phone = rPhone.value; };

    if (addr) addr.onchange = () => { state.address = addr.value || state.address; };
    if (waste) waste.oninput = () => {
        wasteEditedManually = true;
        const v = clampNumber(parseFloat(waste.value), 0, 60, state.manualWastePct || 10);
        state.manualWastePct = v; waste.value = v;
    };
    if (facets) facets.oninput = () => {
        const v = clampNumber(parseInt(facets.value, 10), 0, 999, state.manualTotalFacets || 0);
        state.manualTotalFacets = v; facets.value = v;
        if (!wasteEditedManually && waste) {
            const suggestedWaste = calculateCurrentSuggestedWaste();
            state.manualWastePct = suggestedWaste;
            waste.value = suggestedWaste;
        }
    };

    // --- Wire Quick Submit button ---
    const btnQuickSubmit = container.querySelector('#btnQuickSubmit');
    if (btnQuickSubmit) {
        btnQuickSubmit.onclick = () => quickSubmitReport();
    }

    // --- Wire branding fields (only present when ?branding=1) ---
    if (showBranding) {
        const bPrimary      = container.querySelector('#brandPrimary');
        const bPrimaryHex   = container.querySelector('#brandPrimaryHex');
        const bSecondary    = container.querySelector('#brandSecondary');
        const bSecondaryHex = container.querySelector('#brandSecondaryHex');
        const bLogoPreview  = container.querySelector('#brandLogoPreview');
        const bLogoUpload   = container.querySelector('#brandLogoUpload');
        const bLogoClear    = container.querySelector('#brandLogoClear');
        const bLogoFile     = container.querySelector('#brandLogoFile');

        const syncColor = (picker, hex, key) => {
            picker.oninput = () => { hex.value = picker.value; bo[key] = picker.value; };
            hex.oninput = () => {
                let v = hex.value.trim();
                if (v && !v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) { picker.value = v; bo[key] = v; }
            };
            hex.onchange = () => {
                let v = hex.value.trim();
                if (v && !v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) { picker.value = v; hex.value = v; bo[key] = v; }
                else { hex.value = picker.value; }
            };
        };
        if (bPrimary && bPrimaryHex) syncColor(bPrimary, bPrimaryHex, 'primaryColor');
        if (bSecondary && bSecondaryHex) syncColor(bSecondary, bSecondaryHex, 'secondaryColor');

        if (bLogoUpload && bLogoFile) {
            bLogoUpload.onclick = () => bLogoFile.click();
            bLogoFile.onchange = () => {
                const file = bLogoFile.files[0];
                if (!file || !file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    bo.logoDataUrl = ev.target.result;
                    if (bLogoPreview) bLogoPreview.src = bo.logoDataUrl;
                    if (bLogoClear) bLogoClear.style.display = '';
                };
                reader.readAsDataURL(file);
                bLogoFile.value = '';
            };
        }
        if (bLogoClear) {
            bLogoClear.onclick = () => {
                bo.logoDataUrl = null;
                if (bLogoPreview) bLogoPreview.src = logoPreviewSrc();
                bLogoClear.style.display = 'none';
            };
        }
    }
}


// -----------------------------
// LABELS PAGE: zoomable editor + bottom toggle Editor / Pitch / Area
// -----------------------------

// -----------------------------
// LABELS PAGE: zoomable editor + bottom toggle Editor / Pitch / Area
// + Diagram label size slider (controls window.PDF_DIAGRAM_FONT_SCALE) in the zoom bar
// -----------------------------
async function renderLabelsPitchPage(container) {
  const state = reportConfigState;
  if (!state) return;

  applyReportFacetOverlapGuards(state);
  syncReportDiagramLabels(state);
  if (!state._labelsViewMode) state._labelsViewMode = 'editor';
  if (typeof state.editorCropPadding !== 'number') state.editorCropPadding = 0;
  normalizeAutoLabelPadding(
    state,
    (state.customLabels || []).filter(label => label && label.lined && !label.excluded).length
  );

  // Init diagram font scale (session-persisted)
  if (typeof state.diagramFontScale !== 'number') {
    const wv = Number(window.PDF_DIAGRAM_FONT_SCALE);
    state.diagramFontScale = (Number.isFinite(wv) && wv > 0) ? wv : 1.0;
  }
  window.PDF_DIAGRAM_FONT_SCALE = state.diagramFontScale;

  const baseCanvas = await createFacetCanvasFromState(state, 'BASE');
  const baseImg = baseCanvas.toDataURL('image/png');

  const initialCalc = window.recalculateReportMaterials(state);
  const initialArea = Math.round(initialCalc.totalSquares * 100).toLocaleString();
  const totalFacetCount = countRealFacets(state);
  state.manualTotalFacets = totalFacetCount;
  const overlapWarnings = Array.isArray(state.facetOverlapWarnings) ? state.facetOverlapWarnings : [];
  const overlapBannerHtml = overlapWarnings.length ? `
    <div style="
      background:#fff7e6;
      border:1px solid #f2c46d;
      border-left:4px solid #d9822b;
      border-radius:6px;
      color:#5f3b00;
      font-size:12px;
      font-weight:700;
      line-height:1.35;
      margin:0 0 8px 0;
      padding:8px 10px;
    ">
      <div>Facet overlap check found ${overlapWarnings.length} issue${overlapWarnings.length === 1 ? '' : 's'}.</div>
      <div style="font-weight:600; margin-top:3px;">
        ${overlapWarnings.slice(0, 3).map((warning) => escapeHtml(warning.message)).join('<br>')}
        ${overlapWarnings.length > 3 ? `<br>${overlapWarnings.length - 3} more possible overlaps found.` : ''}
      </div>
    </div>
  ` : '';

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:2px solid #d93025; margin:0 0 8px 0; padding-bottom:4px;">
      <h2 style="color:#d93025; margin:0;">Diagram Labels</h2>
      <div style="
        flex:0 0 auto;
        display:flex;
        align-items:center;
        gap:8px;
        background:#f6f7f9;
        border:1px solid #d8dee6;
        border-radius:6px;
        padding:6px 10px;
        color:#394150;
        font-size:12px;
        font-weight:700;
      ">
        <span>Total Facets</span>
        <span style="color:#111; font-size:16px; line-height:1;">${totalFacetCount}</span>
      </div>
    </div>

    ${overlapBannerHtml}

    <div class="labels-toolbar">
      <div class="mini">
        <b>Scroll</b> to zoom, <b>Alt+Drag</b> or <b>Middle-click drag</b> to pan. Toggle leader lines on each label; conflicting faces can also be excluded.
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="primary" id="btnAutoRegen">Re-run Auto</button>
        <button class="danger" id="btnResetLabels">Reset</button>
      </div>
    </div>
    <div style="display:none; gap:8px; align-items:center; margin:-4px 0 8px 0; padding:6px 8px; border:1px solid #e0e4ec; border-radius:6px; background:#f8f9fb; font-size:11px; color:#555;">
      <span style="font-weight:800; color:#394150;">Auto placement test</span>
      <button id="btnAutoFirstPass" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:5px; padding:4px 8px; cursor:pointer; font-weight:800; font-size:11px;">First pass</button>
      <button id="btnAutoSecondPass" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:5px; padding:4px 8px; cursor:pointer; font-weight:800; font-size:11px;">Second pass</button>
      <button id="btnAutoThirdPass" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:5px; padding:4px 8px; cursor:pointer; font-weight:800; font-size:11px;">Third pass</button>
      <button id="btnAutoFourthPass" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:5px; padding:4px 8px; cursor:pointer; font-weight:800; font-size:11px;">Fourth pass</button>
      <span style="color:#777;">Compare individual auto placement passes.</span>
    </div>

    <!-- EDITOR WRAP: fills available vertical space -->
    <div class="labels-editor-wrap">
      <div class="labels-editor-stage" id="labelsStage">
        <div id="labelsViewport" style="
          position:absolute;
          background:#fff;
          border-radius:4px;
          overflow:hidden;
        ">
          <img class="labels-editor-img" id="labelsBaseImg" src="${baseImg}"
               style="position:absolute; inset:0; width:100%; height:100%; object-fit:fill;" />
          <img class="labels-editor-img" id="labelsPreviewImg" src=""
               style="display:none; position:absolute; inset:0; width:100%; height:100%; object-fit:fill;" />
          <svg class="labels-editor-svg" id="labelsSvg"
               style="position:absolute; inset:0; width:100%; height:100%; pointer-events:none;"></svg>
          <div class="labels-overlay" id="labelsOverlay"
               style="position:absolute; inset:0; pointer-events:none;"></div>
        </div>
      </div>

      <!-- ZOOM BAR at bottom of editor -->
      <div class="labels-zoom-bar">
        <div class="zoom-controls">
          <button class="zoom-btn" id="zoomOutBtn" title="Zoom Out">−</button>
          <span class="zoom-badge" id="zoomBadge">100%</span>
          <button class="zoom-btn" id="zoomInBtn" title="Zoom In">+</button>
          <button class="zoom-btn" id="zoomResetBtn" title="Reset View" style="font-size:11px; width:auto; border-radius:4px; padding:0 8px;">Fit</button>
        </div>

        <!-- NEW: low-profile font size control (left of edge padding) -->
        <div class="pad-control">
          <label>Label Size:</label>
          <input type="range" id="diagFontScaleSlider" min="0.6" max="1.8" step="0.05" value="${state.diagramFontScale}">
          <span id="diagFontScaleVal">${Math.round(state.diagramFontScale * 100)}%</span>
        </div>

        <div class="pad-control">
          <label>Edge Padding:</label>
          <input type="range" id="cropPadSlider" min="0" max="150" step="5" value="${state.editorCropPadding}">
          <span id="cropPadVal">${state.editorCropPadding}px</span>
        </div>
      </div>
    </div>

    <!-- TOTAL AREA -->
    <div id="editorTotalArea" style="
      margin-top:10px;
      display:inline-block;
      background:#111;
      color:#fff;
      padding:6px 12px;
      border-radius:999px;
      font-size:12px;
      font-weight:800;
      box-shadow:0 2px 6px rgba(0,0,0,0.25);
    ">
      Total Area: ${initialArea} sq ft
    </div>

    <div class="bottom-toggle" style="margin-top:12px;">
      <button id="modeEditor">Editor</button>
      <button id="modePitch">Pitch Preview</button>
      <button id="modeArea">Area Preview</button>
    </div>
  `;

  const btnAuto = container.querySelector('#btnAutoRegen');
  const btnReset = container.querySelector('#btnResetLabels');
  const btnAutoFirstPass = container.querySelector('#btnAutoFirstPass');
  const btnAutoSecondPass = container.querySelector('#btnAutoSecondPass');
  const btnAutoThirdPass = container.querySelector('#btnAutoThirdPass');
  const btnAutoFourthPass = container.querySelector('#btnAutoFourthPass');

  const stage = container.querySelector('#labelsStage');
  const viewport = container.querySelector('#labelsViewport');
  const overlay = container.querySelector('#labelsOverlay');
  const svg = container.querySelector('#labelsSvg');
  const baseImgEl = container.querySelector('#labelsBaseImg');
  const previewImgEl = container.querySelector('#labelsPreviewImg');

  const modeEditor = container.querySelector('#modeEditor');
  const modePitch = container.querySelector('#modePitch');
  const modeArea = container.querySelector('#modeArea');

  const areaDisplay = container.querySelector('#editorTotalArea');

  // Zoom controls
  const zoomOutBtn = container.querySelector('#zoomOutBtn');
  const zoomInBtn = container.querySelector('#zoomInBtn');
  const zoomResetBtn = container.querySelector('#zoomResetBtn');
  const zoomBadge = container.querySelector('#zoomBadge');

  // Label size slider
  const diagFontScaleSlider = container.querySelector('#diagFontScaleSlider');
  const diagFontScaleVal = container.querySelector('#diagFontScaleVal');

  // Crop padding
  const cropPadSlider = container.querySelector('#cropPadSlider');
  const cropPadVal = container.querySelector('#cropPadVal');

  const updateRealTimeStats = () => {
    if (!areaDisplay) return;
    const res = window.recalculateReportMaterials(state);
    areaDisplay.innerHTML = `Total Area: ${Math.round(res.totalSquares * 100).toLocaleString()} sq ft`;
  };

  // Shared zoom state for the editor
  let _editorZoomRef = { zoom: 1, panX: 0, panY: 0 };
  const updateZoomBadge = () => {
    if (zoomBadge) zoomBadge.textContent = Math.round(_editorZoomRef.zoom * 100) + '%';
  };

  // Preview refresh helper (debounced)
  let _previewRerenderTimer = null;
  const schedulePreviewRerender = () => {
    if (!state || !previewImgEl) return;
    if (!(state._labelsViewMode === 'pitch' || state._labelsViewMode === 'area')) return;

    if (_previewRerenderTimer) clearTimeout(_previewRerenderTimer);
    _previewRerenderTimer = setTimeout(async () => {
      const renderMode = (state._labelsViewMode === 'area') ? 'AREA' : 'PITCH';
      // Ensure areaText on labels is current before rendering
      if (typeof window.recalculateReportMaterials === 'function') {
        window.recalculateReportMaterials(state);
      }
      try {
        previewImgEl.style.opacity = '0.6';
        const cvs = await createFacetCanvasFromState(state, renderMode);
        previewImgEl.src = cvs.toDataURL('image/png');
      } finally {
        previewImgEl.style.opacity = '1';
      }
      updateRealTimeStats();
    }, 120);
  };

  async function setMode(mode) {
    state._labelsViewMode = mode;

    modeEditor.classList.toggle('active', mode === 'editor');
    modePitch.classList.toggle('active', mode === 'pitch');
    modeArea.classList.toggle('active', mode === 'area');

    if (_labelsOverlayCleanup) {
      try { _labelsOverlayCleanup(); } catch (e) {}
      _labelsOverlayCleanup = null;
    }

    const showEditorLayers = (on) => {
      baseImgEl.style.display = on ? 'block' : 'none';
      svg.style.display       = on ? 'block' : 'none';
      overlay.style.display   = on ? 'block' : 'none';
    };
    const showPreviewLayer = (on) => {
      previewImgEl.style.display = on ? 'block' : 'none';
    };

    if (mode === 'editor') {
      showPreviewLayer(false);
      showEditorLayers(true);

      const mount = () => {
        const cleanup = mountLabelsEditor({
          state,
          stageEl: stage,
          viewportEl: viewport,
          overlayEl: overlay,
          svgEl: svg,
          onStatsChanged: updateRealTimeStats,
          zoomRef: _editorZoomRef,
          onZoomChanged: updateZoomBadge
        });
        _labelsOverlayCleanup = cleanup;
        updateRealTimeStats();
        updateZoomBadge();
      };

      if (baseImgEl.complete && baseImgEl.naturalWidth > 0) {
        requestAnimationFrame(mount);
      } else {
        baseImgEl.onload = () => requestAnimationFrame(mount);
      }
      return;
    }

    // Preview Mode — recalculate first so label areaText values are current
    if (typeof window.recalculateReportMaterials === 'function') {
      window.recalculateReportMaterials(state);
    }

    showEditorLayers(false);
    showPreviewLayer(true);
    previewImgEl.style.opacity = '0.6';
    previewImgEl.src = "";

    // Reset viewport transform for preview — use effective crop (includes padding)
    viewport.style.transform = '';
    viewport.style.transformOrigin = '';
    const sr = stage.getBoundingClientRect();
    const effCrop = getEffectiveCrop(state);
    const aspect = effCrop.width / effCrop.height;
    let vw = sr.width, vh = vw / aspect;
    if (vh > sr.height) { vh = sr.height; vw = vh * aspect; }
    viewport.style.left = ((sr.width - vw) / 2) + 'px';
    viewport.style.top = ((sr.height - vh) / 2) + 'px';
    viewport.style.width = vw + 'px';
    viewport.style.height = vh + 'px';

    previewImgEl.style.position = 'absolute';
    previewImgEl.style.objectFit = 'fill';
    previewImgEl.style.inset = '0';
    previewImgEl.style.left = '';
    previewImgEl.style.top = '';
    previewImgEl.style.width = '100%';
    previewImgEl.style.height = '100%';

    const renderMode = (mode === 'area') ? 'AREA' : 'PITCH';

    try {
      const cvs = await createFacetCanvasFromState(state, renderMode);
      previewImgEl.src = cvs.toDataURL('image/png');
    } finally {
      previewImgEl.style.opacity = '1';
    }

    updateRealTimeStats();
  }

  // Wire label size slider
  const setFontScale = (val) => {
    const v = clampNumber(parseFloat(val), 0.6, 1.8, 1.0);
    state.diagramFontScale = v;
    window.PDF_DIAGRAM_FONT_SCALE = v;
    if (diagFontScaleVal) diagFontScaleVal.textContent = Math.round(v * 100) + '%';
    schedulePreviewRerender();
  };

  if (diagFontScaleSlider) {
    diagFontScaleSlider.oninput = () => setFontScale(diagFontScaleSlider.value);
    // ensure display matches initial
    if (diagFontScaleVal) diagFontScaleVal.textContent = Math.round(state.diagramFontScale * 100) + '%';
  }

  modeEditor.onclick = () => setMode('editor');
  modePitch.onclick = () => setMode('pitch');
  modeArea.onclick = () => setMode('area');

  const refreshLabelsViewAfterAuto = () => {
    const mode = state._labelsViewMode || 'editor';
    if (mode === 'editor') {
      renderConfigPage();
    } else {
      setMode(mode);
      updateRealTimeStats();
    }
  };

  if (btnAuto) btnAuto.onclick = () => {
    state.customLabels = buildDefaultDiagramLabels(state);
    markReportLabelsAutoGenerated(state);
    refreshLabelsViewAfterAuto();
  };

  if (btnAutoFirstPass) btnAutoFirstPass.onclick = () => {
    state.customLabels = buildDefaultDiagramLabels(state, { secondPass: false, thirdPass: false, fourthPass: false });
    markReportLabelsAutoGenerated(state);
    refreshLabelsViewAfterAuto();
  };

  if (btnAutoSecondPass) btnAutoSecondPass.onclick = () => {
    state.customLabels = buildDefaultDiagramLabels(state, { secondPass: true, thirdPass: false, fourthPass: false });
    markReportLabelsAutoGenerated(state);
    refreshLabelsViewAfterAuto();
  };

  if (btnAutoThirdPass) btnAutoThirdPass.onclick = () => {
    state.customLabels = buildDefaultDiagramLabels(state, { secondPass: true, thirdPass: true, fourthPass: false });
    markReportLabelsAutoGenerated(state);
    refreshLabelsViewAfterAuto();
  };

  if (btnAutoFourthPass) btnAutoFourthPass.onclick = () => {
    state.customLabels = buildDefaultDiagramLabels(state, { secondPass: true, thirdPass: true, fourthPass: true });
    markReportLabelsAutoGenerated(state);
    refreshLabelsViewAfterAuto();
  };

  if (btnReset) btnReset.onclick = () => {
    if (confirm("Reset all labels to default positions?")) {
      state.customLabels = buildDefaultDiagramLabels(state);
      markReportLabelsAutoGenerated(state);
      refreshLabelsViewAfterAuto();
    }
  };

  // Zoom button handlers
  const triggerZoom = (factor) => {
    if (_labelsOverlayCleanup && _labelsOverlayCleanup._doZoom) {
      _labelsOverlayCleanup._doZoom(factor);
    }
  };

  if (zoomInBtn) zoomInBtn.onclick = () => triggerZoom(1.25);
  if (zoomOutBtn) zoomOutBtn.onclick = () => triggerZoom(0.8);
  if (zoomResetBtn) zoomResetBtn.onclick = () => {
    if (_labelsOverlayCleanup && _labelsOverlayCleanup._resetView) {
      _labelsOverlayCleanup._resetView();
    }
  };

  // Crop padding slider
  if (cropPadSlider) {
    cropPadSlider.oninput = () => {
      state.editorCropPadding = parseInt(cropPadSlider.value);
      state._editorCropPaddingManual = true;
      state._editorCropPaddingAuto = false;
      if (cropPadVal) cropPadVal.textContent = cropPadSlider.value + 'px';

      // Clamp all existing labels into the new effective bounds
      const newPad = state.editorCropPadding;
      const TEXT_EDGE_MARGIN = 6;
      const crop = state.cropRegion;
      const minX = -newPad + TEXT_EDGE_MARGIN;
      const maxX = crop.width + newPad - TEXT_EDGE_MARGIN;
      const minY = -newPad + TEXT_EDGE_MARGIN;
      const maxY = crop.height + newPad - TEXT_EDGE_MARGIN;
      (state.customLabels || []).forEach(lbl => {
        lbl.x = clamp(lbl.x, minX, maxX);
        lbl.y = clamp(lbl.y, minY, maxY);
      });

      // Re-mount editor with new bounds
      setMode(state._labelsViewMode);

      // Refresh preview if in preview mode
      schedulePreviewRerender();
    };
  }

  setMode(state._labelsViewMode);
}


// =============================================================================
// LABELS EDITOR: Zoomable, Pannable, Constant-Size Labels
// =============================================================================

function mountLabelsEditor({ state, stageEl, viewportEl, overlayEl, svgEl, onStatsChanged, zoomRef, onZoomChanged }) {
  overlayEl.innerHTML = '';
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  // Original crop — label coordinates always live in this space
  const crop = state.cropRegion;
  const extraPad = state.editorCropPadding || 0;

  // Effective display area (crop + padding). Only affects viewport sizing.
  const effW = crop.width + extraPad * 2;
  const effH = crop.height + extraPad * 2;

  // Facet canvases already include editorCropPadding, so the image and label
  // overlay both fill the same effective viewport.
  const baseImgEl = viewportEl.querySelector('#labelsBaseImg');
  if (baseImgEl) {
    baseImgEl.style.inset = '0';
    baseImgEl.style.left = '';
    baseImgEl.style.top = '';
    baseImgEl.style.width = '100%';
    baseImgEl.style.height = '100%';
    baseImgEl.style.objectFit = 'fill';
  }

  // ---- Zoom / Pan State ----
  let zoom = zoomRef ? zoomRef.zoom : 1.0;
  let panX = zoomRef ? zoomRef.panX : 0;
  let panY = zoomRef ? zoomRef.panY : 0;

  // Viewport natural (unscaled) dimensions
  let vpW = 100, vpH = 100, vpBaseLeft = 0, vpBaseTop = 0;

  function layoutViewport() {
    const sr = stageEl.getBoundingClientRect();
    const stageW = sr.width;
    const stageH = sr.height;
    if (stageW < 10 || stageH < 10) return;

    // Viewport sized to the EFFECTIVE area (crop + padding)
    const aspect = effW / effH;

    let w = stageW;
    let h = w / aspect;
    if (h > stageH) { h = stageH; w = h * aspect; }

    vpBaseLeft = (stageW - w) / 2;
    vpBaseTop = (stageH - h) / 2;
    vpW = w;
    vpH = h;

    applyTransform();
  }

  function applyTransform() {
    viewportEl.style.position = 'absolute';
    viewportEl.style.width = vpW + 'px';
    viewportEl.style.height = vpH + 'px';
    viewportEl.style.transformOrigin = '0 0';
    viewportEl.style.left = (vpBaseLeft + panX) + 'px';
    viewportEl.style.top = (vpBaseTop + panY) + 'px';
    viewportEl.style.transform = `scale(${zoom})`;

    if (zoomRef) { zoomRef.zoom = zoom; zoomRef.panX = panX; zoomRef.panY = panY; }
    if (onZoomChanged) onZoomChanged();
  }

  layoutViewport();

  // SVG viewBox covers the effective area.
  // Label coords are in original crop space (0..crop.width, 0..crop.height),
  // so the SVG origin is at -extraPad so that crop coord (0,0) maps to pixel offset extraPad.
  svgEl.setAttribute('viewBox', `${-extraPad} ${-extraPad} ${effW} ${effH}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // ---- Coordinate Conversions ----
  // Convert original-crop-space coords to viewport-local pixel position.
  // cropX=0 should map to the start of the image area = extraPad fraction of viewport width.
  const toViewportLocal = (cx, cy) => ({
    sx: ((cx + extraPad) / effW) * vpW,
    sy: ((cy + extraPad) / effH) * vpH
  });

  // Convert stage-relative mouse position to original-crop-space coordinates.
  const stageToCrop = (stageX, stageY) => {
    const vpLocalX = (stageX - vpBaseLeft - panX) / zoom;
    const vpLocalY = (stageY - vpBaseTop - panY) / zoom;
    return {
      cx: (vpLocalX / vpW) * effW - extraPad,
      cy: (vpLocalY / vpH) * effH - extraPad
    };
  };

  const autoExcludedFaceIndexes = (typeof getReportAutoExcludedFaceIndexSet === 'function')
    ? getReportAutoExcludedFaceIndexSet(state)
    : new Set();

  // ---- Face Lookup ----
  const getFaceBySig = (sig) => {
    if (!sig) return null;
    return (state.facesData || []).find((f, idx) => {
      if (autoExcludedFaceIndexes.has(idx)) return false;
      try { return getLocalFaceSignatureReport(f.points) === sig; } catch (e) { return false; }
    }) || null;
  };
  const getFaceForLabel = (label) => {
    const faceIndex = getReportLabelFaceIndex(label);
    if (faceIndex !== null && !autoExcludedFaceIndexes.has(faceIndex)) {
      const face = (state.facesData || [])[faceIndex];
      if (face && Array.isArray(face.points)) return face;
    }
    return getFaceBySig(label.faceSignature);
  };

  function computeBestOnFace(lbl) {
    const face = getFaceForLabel(lbl);
    if (!face || !Array.isArray(face.points) || face.points.length < 3) return null;

    let placementHoles = [...(face.holes || [])];
    const currentLayer = face.layer || 1;

    try {
      (state.facesData || []).forEach((other, otherIdx) => {
        if (other === face) return;
        if (autoExcludedFaceIndexes.has(otherIdx)) return;
        const otherLayer = other.layer || 1;
        const isHigherLayer = otherLayer > currentLayer;

        let intersects = false;
        if (isHigherLayer && polygonsIntersectRough(face.points, other.points)) intersects = true;
        const isContained = isPolygonContained(other.points, face.points);
        if (isContained || intersects) placementHoles.push(other.points);
      });
    } catch (e) {}

    let pole = null;
    try {
      pole = getPoleOfInaccessibility(face.points, placementHoles, 1.0);
    } catch (e) {}

    const cent = getPolygonCentroid(face.points);

    const px = pole && Number.isFinite(pole.x) ? pole.x : cent.x;
    const py = pole && Number.isFinite(pole.y) ? pole.y : cent.y;

    const x = clamp(px - crop.minX, 0, crop.width);
    const y = clamp(py - crop.minY, 0, crop.height);

    const ax = clamp(cent.x - crop.minX, 0, crop.width);
    const ay = clamp(cent.y - crop.minY, 0, crop.height);

    return { x, y, anchorX: ax, anchorY: ay };
  }

  // ---- Build SVG leader lines ----
  const lineEls = new Map();
  const nodeEls = new Map();
  const anchorEls = new Map();
  const isAutoExcludedLabel = (label) => {
    const faceIndex = getReportLabelFaceIndex(label);
    return faceIndex !== null && autoExcludedFaceIndexes.has(faceIndex);
  };
  const visibleLabels = (state.customLabels || []).filter((label) => !isAutoExcludedLabel(label));

  visibleLabels.forEach(lbl => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute('stroke', '#555');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-linecap', 'round');
    line.style.opacity = '0.85';
    svgEl.appendChild(line);
    lineEls.set(lbl.id, line);
  });

  // Extra styles
  if (!document.getElementById('lbl-styles-extra')) {
    const s = document.createElement('style');
    s.id = 'lbl-styles-extra';
    s.innerHTML = `
      .lbl-restore { width:18px; height:18px; border-radius:4px; border:1px solid #34a853; background:rgba(255,255,255,.96); color:#34a853; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; line-height:1; user-select:none; margin-left:2px; }
      .lbl-restore:hover { background:#34a853; color:#fff; }
      .lbl-delete { width:18px; height:18px; border-radius:4px; border:1px solid #d93025; background:rgba(255,255,255,.96); color:#d93025; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; line-height:1; user-select:none; margin-left:2px; }
      .lbl-delete:hover { background:#d93025; color:#fff; }
      .lbl-card.overlap-warning { background:#fff3df !important; border-color:#f59e0b !important; box-shadow:0 0 0 2px rgba(245,158,11,.22), 0 2px 8px rgba(0,0,0,.12) !important; }
      .lbl-card.overlap-warning .lbl-input { background:#fff8ed; border-color:#f4b04f; }
    `;
    document.head.appendChild(s);
  }

  const overlapWarningFaceIndexes = new Set();
  (Array.isArray(state.facetOverlapWarnings) ? state.facetOverlapWarnings : []).forEach((warning) => {
    if (!warning || !Array.isArray(warning.faceIndexes)) return;
    if (warning.type !== 'overlap' || warning.severity !== 'warning') return;
    warning.faceIndexes.forEach((faceIndex) => {
      const idx = Number(faceIndex);
      if (Number.isInteger(idx) && idx >= 0 && !autoExcludedFaceIndexes.has(idx)) {
        overlapWarningFaceIndexes.add(idx);
      }
    });
  });

  // ---- Build Label DOM Nodes ----
  visibleLabels.forEach(lbl => {
    const node = document.createElement('div');
    node.className = 'lbl-node';
    node.dataset.id = lbl.id;
    node.style.pointerEvents = 'auto';

    const isExcluded = window.reportExcludedSignatures && window.reportExcludedSignatures.has(lbl.faceSignature);
    lbl.excluded = isExcluded;

    const toggleIcon = lbl.lined ? 'fa-link' : 'fa-unlink';
    const actionIcon = isExcluded ? 'fa-undo' : 'fa-trash';
    const actionTitle = isExcluded ? 'Restore Face' : 'Exclude Face';
    const actionClass = isExcluded ? 'lbl-restore' : 'lbl-delete';
    const cardOpacity = isExcluded ? '0.5' : '1.0';
    const faceIndex = getReportLabelFaceIndex(lbl);
    const isOverlapWarning = faceIndex !== null && overlapWarningFaceIndexes.has(faceIndex);
    const canToggleExclude = isExcluded || isOverlapWarning;
    const excludeButtonHtml = canToggleExclude
      ? `
        <button class="${actionClass}" data-action="exclude" title="${actionTitle}">
          <i class="fas ${actionIcon}"></i>
        </button>
      `
      : '';

    node.innerHTML = `
      <div class="lbl-card ${isOverlapWarning ? 'overlap-warning' : ''}" style="opacity:${cardOpacity};">
        <input class="lbl-input" data-action="pitch" value="${escapeHtml(lbl.pitchText ?? lbl.text ?? '')}" ${isExcluded ? 'disabled' : ''} />
        <span class="lbl-exact">${escapeHtml(lbl.pitchExactText || '')}</span>
        <button class="lbl-toggle ${lbl.lined ? 'active' : ''}" data-action="toggle" title="Toggle leader">
          <i class="fas ${toggleIcon}"></i>
        </button>
        ${excludeButtonHtml}
      </div>
    `;
    overlayEl.appendChild(node);
    nodeEls.set(lbl.id, node);

    const anchor = document.createElement('div');
    anchor.className = 'lbl-anchor';
    anchor.dataset.id = lbl.id;
    anchor.style.display = isExcluded ? 'none' : 'block';
    overlayEl.appendChild(anchor);
    anchorEls.set(lbl.id, anchor);

    // Pitch input
    const inp = node.querySelector('[data-action="pitch"]');
    if (inp) {
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
      inp.addEventListener('input', () => {
        const v = sanitizePitchNumber(inp.value);
        lbl.pitchText = v; lbl.text = v;
        markReportLabelsManual(state);
      });
      inp.addEventListener('change', () => {
        const v = sanitizePitchNumber(inp.value);
        lbl.pitchText = v; lbl.text = v; inp.value = v;
        markReportLabelsManual(state);
        redraw();
        if (onStatsChanged) onStatsChanged();
      });
    }

    // Toggle leader
    const btnToggle = node.querySelector('[data-action="toggle"]');
    if (btnToggle) {
      btnToggle.addEventListener('pointerdown', (e) => e.stopPropagation());
      btnToggle.addEventListener('click', (e) => {
        e.stopPropagation();

        const wasLined = !!lbl.lined;
        lbl.lined = !lbl.lined;
        markReportLabelsManual(state);

        if (lbl.lined) {
          if (!lbl.leader) lbl.leader = { startX: (lbl.anchorX ?? lbl.x), startY: (lbl.anchorY ?? lbl.y) };
          if (!Number.isFinite(lbl.leader.startX) || !Number.isFinite(lbl.leader.startY)) {
            lbl.leader.startX = (lbl.anchorX ?? lbl.x);
            lbl.leader.startY = (lbl.anchorY ?? lbl.y);
          }
        } else {
          lbl.leader = null;
          if (wasLined && !lbl.excluded) {
            const best = computeBestOnFace(lbl);
            if (best) {
              lbl.x = best.x;
              lbl.y = best.y;
              lbl.anchorX = best.anchorX;
              lbl.anchorY = best.anchorY;
            }
          }
        }

        btnToggle.classList.toggle('active', lbl.lined);
        const icon = btnToggle.querySelector('i');
        if (icon) { icon.classList.toggle('fa-link', lbl.lined); icon.classList.toggle('fa-unlink', !lbl.lined); }

        redraw();
      });
    }

    // Exclude / restore
    const btnExclude = node.querySelector('[data-action="exclude"]');
    if (btnExclude) {
      btnExclude.addEventListener('pointerdown', (e) => e.stopPropagation());
      btnExclude.addEventListener('click', (e) => {
        e.stopPropagation();

        if (lbl.faceSignature) {
          const isCurrentlyExcluded = window.reportExcludedSignatures.has(lbl.faceSignature);

          if (isCurrentlyExcluded) {
            window.reportExcludedSignatures.delete(lbl.faceSignature);
            lbl.excluded = false;
            btnExclude.className = 'lbl-delete';
            btnExclude.title = 'Exclude Face';
            btnExclude.innerHTML = '<i class="fas fa-trash"></i>';
            node.querySelector('.lbl-card').style.opacity = '1.0';
            if (inp) inp.disabled = false;
            anchor.style.display = 'block';
          } else {
            window.reportExcludedSignatures.add(lbl.faceSignature);
            lbl.excluded = true;
            btnExclude.className = 'lbl-restore';
            btnExclude.title = 'Restore Face';
            btnExclude.innerHTML = '<i class="fas fa-undo"></i>';
            node.querySelector('.lbl-card').style.opacity = '0.5';
            if (inp) inp.disabled = true;
            anchor.style.display = 'none';
          }

          state.excludedSignatures = Array.from(window.reportExcludedSignatures);
          markReportLabelsManual(state);
          redraw();
          if (onStatsChanged) onStatsChanged();
        }
      });
    }
  });

  // ---- Redraw: positions labels + anchors with counter-scaling ----
  const redrawLeaders = () => {
    visibleLabels.forEach(lbl => {
      const line = lineEls.get(lbl.id);
      if (!line) return;

      if (lbl.lined && lbl.leader && !lbl.excluded) {
        line.style.display = 'block';
        line.setAttribute('x1', clamp(lbl.leader.startX, 0, crop.width));
        line.setAttribute('y1', clamp(lbl.leader.startY, 0, crop.height));
        line.setAttribute('x2', clamp(lbl.x, -extraPad, crop.width + extraPad));
        line.setAttribute('y2', clamp(lbl.y, -extraPad, crop.height + extraPad));
      } else {
        line.style.display = 'none';
      }
    });
  };

  const redraw = () => {
    const counterScale = 1 / zoom;

    visibleLabels.forEach(lbl => {
      const node = nodeEls.get(lbl.id);
      if (node) {
        const p = toViewportLocal(lbl.x, lbl.y);
        node.style.left = p.sx + 'px';
        node.style.top = p.sy + 'px';
        // Counter-scale so labels stay constant screen size
        node.style.transform = `translate(-50%,-50%) scale(${counterScale})`;
      }

      const a = anchorEls.get(lbl.id);
      if (a) {
        if (lbl.lined && lbl.leader && !lbl.excluded) {
          const ap = toViewportLocal(lbl.leader.startX, lbl.leader.startY);
          a.style.left = ap.sx + 'px';
          a.style.top = ap.sy + 'px';
          a.style.display = 'block';
          a.style.transform = `translate(-50%,-50%) scale(${counterScale})`;
        } else {
          a.style.display = 'none';
        }
      }
    });

    redrawLeaders();
    if (onStatsChanged) onStatsChanged();
  };

  // ---- ZOOM: wheel handler ----
  function doZoom(factor, pivotStageX, pivotStageY) {
    // Default pivot: center of stage
    if (pivotStageX == null) {
      const sr = stageEl.getBoundingClientRect();
      pivotStageX = sr.width / 2;
      pivotStageY = sr.height / 2;
    }

    const newZoom = Math.max(0.3, Math.min(20, zoom * factor));

    // Zoom toward pivot: keep the crop-space point under the pivot stationary
    const beforeVpX = (pivotStageX - vpBaseLeft - panX) / zoom;
    const beforeVpY = (pivotStageY - vpBaseTop - panY) / zoom;

    zoom = newZoom;

    // After zoom, the same vpLocal point should map back to the same stage position
    panX = pivotStageX - vpBaseLeft - beforeVpX * zoom;
    panY = pivotStageY - vpBaseTop - beforeVpY * zoom;

    applyTransform();
    redraw();
  }

  function resetView() {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    applyTransform();
    redraw();
  }

  const handleWheel = (e) => {
    e.preventDefault();
    const sr = stageEl.getBoundingClientRect();
    const mouseX = e.clientX - sr.left;
    const mouseY = e.clientY - sr.top;
    const factor = e.deltaY > 0 ? 0.88 : 1.14;
    doZoom(factor, mouseX, mouseY);
  };

  stageEl.addEventListener('wheel', handleWheel, { passive: false });

  // ---- PAN: Alt+drag or middle-mouse drag ----
  let isPanning = false;
  let panStartMouseX, panStartMouseY, panStartPanX, panStartPanY;

  const startPan = (e) => {
    isPanning = true;
    panStartMouseX = e.clientX;
    panStartMouseY = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    stageEl.classList.add('panning');
  };

  const onPanMove = (e) => {
    if (!isPanning) return;
    panX = panStartPanX + (e.clientX - panStartMouseX);
    panY = panStartPanY + (e.clientY - panStartMouseY);
    applyTransform();
    redraw();
  };

  const onPanEnd = () => {
    if (isPanning) {
      isPanning = false;
      stageEl.classList.remove('panning');
    }
  };

  // Middle mouse pan
  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { e.preventDefault(); startPan(e); }
  });
  // Alt+left-click pan
  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && e.altKey) { e.preventDefault(); startPan(e); }
  });
  document.addEventListener('pointermove', onPanMove, true);
  document.addEventListener('pointerup', onPanEnd, true);

  // ---- LABEL DRAGGING (accounting for zoom/pan) ----
  let dragging = null;
  let dragMoved = false;

  const onDragMove = (e) => {
    if (!dragging || isPanning) return;
    const sr = stageEl.getBoundingClientRect();
    const stageX = e.clientX - sr.left;
    const stageY = e.clientY - sr.top;

    const { cx, cy } = stageToCrop(stageX, stageY);
    const lbl = state.customLabels.find(x => x.id === dragging.id);
    if (!lbl) return;

    if (dragging.type === 'label') {
      // Labels can go into padding area but not past a fixed margin from the outer edge
      const TEXT_EDGE_MARGIN = 6;
      lbl.x = clamp(cx, -extraPad + TEXT_EDGE_MARGIN, crop.width + extraPad - TEXT_EDGE_MARGIN);
      lbl.y = clamp(cy, -extraPad + TEXT_EDGE_MARGIN, crop.height + extraPad - TEXT_EDGE_MARGIN);
      dragMoved = true;
      redraw();
    } else {
      if (!lbl.leader) lbl.leader = { startX: lbl.anchorX ?? lbl.x, startY: lbl.anchorY ?? lbl.y };
      lbl.leader.startX = clamp(cx, 0, crop.width);
      lbl.leader.startY = clamp(cy, 0, crop.height);
      dragMoved = true;
      redraw();
    }
  };

  const onDragEnd = () => {
    if (!dragging) return;
    if (dragMoved) markReportLabelsManual(state);
    dragging = null;
    dragMoved = false;
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragEnd, true);
  };

  nodeEls.forEach((node, id) => {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.altKey) return; // Alt is for panning
      const t = e.target;
      if (t && (t.matches('input') || t.closest('button'))) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = { type: 'label', id };
      dragMoved = false;
      document.addEventListener('pointermove', onDragMove, true);
      document.addEventListener('pointerup', onDragEnd, true);
    });
  });

  anchorEls.forEach((node, id) => {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = { type: 'anchor', id };
      dragMoved = false;
      document.addEventListener('pointermove', onDragMove, true);
      document.addEventListener('pointerup', onDragEnd, true);
    });
  });

  // ---- ResizeObserver ----
  const ro = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      layoutViewport();
      redraw();
    });
  });
  ro.observe(stageEl);

  // Hide overlay until first layout to prevent flicker
  overlayEl.style.visibility = 'hidden';
  svgEl.style.visibility = 'hidden';

  // Initial draw
  requestAnimationFrame(() => {
    layoutViewport();
    redraw();
    overlayEl.style.visibility = '';
    svgEl.style.visibility = '';
  });

  // ---- Cleanup function (returned) ----
  const cleanup = () => {
    ro.disconnect();
    stageEl.removeEventListener('wheel', handleWheel);
    document.removeEventListener('pointermove', onPanMove, true);
    document.removeEventListener('pointerup', onPanEnd, true);
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragEnd, true);
    dragging = null;
    isPanning = false;
  };

  // Attach zoom helpers for external buttons
  cleanup._doZoom = (factor) => doZoom(factor);
  cleanup._resetView = () => resetView();

  return cleanup;
}


// -----------------------------
// LAYER PAGE
// -----------------------------
async function renderLayerPage(container, layerNum) {
    const state = reportConfigState;
    if (!state) return;

    if (!state.manualLayerFacets) state.manualLayerFacets = {};

    const layerLinesCanvas = await createLayerCanvasFromState(state, layerNum, true, false);
    const layerLinesImg = layerLinesCanvas.toDataURL('image/png');

    const autoCount = countRealFacets(state, layerNum);
    const currentVal = (typeof state.manualLayerFacets[layerNum] === 'number') ? state.manualLayerFacets[layerNum] : autoCount;

    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">
            Layer ${layerNum} Preview
        </h2>

        <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:10px;">
            <div style="font-size:11px; color:#666;">
                Auto facets detected: <b>${autoCount}</b><br>
                Override facets if needed.
            </div>

            <div style="display:flex; gap:8px; align-items:center;">
                <label style="font-size:12px; color:#666;">Facets</label>
                <input id="layerFacetInput" type="number" min="0" max="999" step="1" value="${Number(currentVal)}"
                    style="width:100px; padding:8px; border:1px solid #ccc; border-radius:6px;">
                <button id="layerFacetClear" style="border:1px solid #ccc; background:#fff; border-radius:6px; padding:8px 10px; cursor:pointer;">
                    Clear
                </button>
            </div>
        </div>

        <div style="flex:1; display:flex; align-items:center; justify-content:center; border:1px solid #ddd; border-radius:10px; background:#fafafa; overflow:hidden;">
            <img id="layerPreviewImg" src="${layerLinesImg}" style="max-width:100%; max-height:100%; display:block;">
        </div>
    `;

    const inp = container.querySelector('#layerFacetInput');
    const clearBtn = container.querySelector('#layerFacetClear');
    if (inp) {
        inp.oninput = () => {
            const v = clampNumber(parseInt(inp.value, 10), 0, 999, currentVal);
            state.manualLayerFacets[layerNum] = v;
            inp.value = v;
        };
    }
    if (clearBtn) {
        clearBtn.onclick = () => { delete state.manualLayerFacets[layerNum]; renderConfigPage(); };
    }
}

// -----------------------------
// ELEVATIONS / VENT
// -----------------------------
async function renderElevationsPage(container) {
    const state = reportConfigState;
    if (areReportQuadViewsDisabled()) {
        if (state) {
            state.quadImage = null;
            state.elevationSettings = { ...((state.elevationSettings && typeof state.elevationSettings === 'object') ? state.elevationSettings : {}), include: false };
        }
        container.innerHTML = '';
        return;
    }
    if (!state.elevationSettings || typeof state.elevationSettings !== 'object') {
        state.elevationSettings = {};
    }
    if (typeof state.elevationSettings.include !== 'boolean') {
        state.elevationSettings.include = true;
    }

    const hasQuadImage = typeof state.quadImage === 'string' && state.quadImage.trim() !== '';
    const includeElev = hasQuadImage && state.elevationSettings.include !== false;
    const imgSrc = state.quadImage ? state.quadImage : await getPlaceholderImage("No Quad View Captured");
    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Quad View / 3D Elevations</h2>

        <div style="margin-bottom:12px; padding:8px 10px; background:#fff; border:1px solid #ddd; border-radius:6px;">
            <label style="font-weight:bold; color:${hasQuadImage ? '#333' : '#777'}; display:flex; align-items:center; cursor:${hasQuadImage ? 'pointer' : 'default'};">
                <input type="checkbox" id="chkIncludeElev" ${includeElev ? 'checked' : ''} ${hasQuadImage ? '' : 'disabled'} style="margin-right:8px;">
                Include Quad View Elevations Page in Report
            </label>
        </div>

        <div id="elevContentWrapper" style="${includeElev ? '' : 'opacity:0.4; pointer-events:none;'}">
            <div style="flex:1; display:flex; align-items:center; justify-content:center; background:#000; border-radius:10px; overflow:hidden;">
                <img src="${imgSrc}" style="max-width:100%; max-height:100%; display:block;">
            </div>
        </div>
    `;

    const chk = container.querySelector('#chkIncludeElev');
    const wrapper = container.querySelector('#elevContentWrapper');
    chk.onchange = () => {
        if (!hasQuadImage) {
            chk.checked = false;
            return;
        }
        state.elevationSettings.include = chk.checked;
        wrapper.style.opacity = chk.checked ? '' : '0.4';
        wrapper.style.pointerEvents = chk.checked ? '' : 'none';
    };
}

async function renderVentPage(container) {
    const RIDGE_VENT_RATING = 18;
    const BOX_VENT_RATING   = 50;
    const SOFFIT_FACTOR     = 0.98;

    const state = reportConfigState;
    if (!state) return;

    // --- LOCK RATIO TO COMPANY DEFAULT ---
    const orgRatio = Number(window.projectOrganization?.report_settings?.general?.nfva_ratio) || 300;
    
    if (!state.ventSettings) state.ventSettings = { include: true, excludedRidges: [], selectedRatio: orgRatio };
    if (!Array.isArray(state.ventSettings.excludedRidges)) state.ventSettings.excludedRidges = [];
    normalizeReportVentManualOverride(state);
    // Force the state to match the organization setting every time the page renders
    state.ventSettings.selectedRatio = orgRatio;

    if (!state.imageSettings) state.imageSettings = { mainViewId: 'solar', ventViewId: 'solar', cropPadding: 50 };
    syncVentilationViewToTopView(state.imageSettings);

    container.innerHTML = `
        <h2 style="color:#d93025; border-bottom:2px solid #d93025; margin:0 0 10px 0;">Ventilation Configuration</h2>

        <div style="margin-bottom:12px; padding:8px 10px; background:#fff; border:1px solid #ddd; border-radius:6px;">
            <label style="font-weight:bold; color:#333; display:flex; align-items:center; cursor:pointer;">
                <input type="checkbox" id="chkIncludeVent" ${state.ventSettings.include ? 'checked' : ''} style="margin-right:8px;">
                Include Ventilation Page in Report
            </label>
        </div>

        <div id="ventContentWrapper" style="${state.ventSettings.include ? '' : 'display:none;'}">
            <div style="display:flex; gap:12px;">

                <div style="flex:1; display:flex; flex-direction:column; gap:10px;">

                    <div style="background:#f9f9f9; padding:8px; border:1px solid #eee; border-radius:6px;">
                        <div style="font-size:11px; font-weight:bold; margin-bottom:5px; color:#555;">Background Image Source:</div>
                        <div id="ventImageSourceLabel" style="font-size:12px; color:#333; font-weight:700;"></div>
                    </div>

                    <div id="ventAtticBox" style="background:#fff; padding:10px; border:1px solid #ddd; border-radius:6px;">
                        Loading...
                    </div>

                    <div id="ventNfvaGrid" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"></div>

                    <div id="ventExhaustGrid" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"></div>

                    <div style="flex:1; min-height:120px; border:1px solid #ddd; border-radius:6px; overflow:hidden; background:#fafafa; display:flex; align-items:center; justify-content:center;">
                        <img id="ventPreviewImg" style="max-width:100%; max-height:100%;">
                    </div>
                </div>

                <div style="width:200px; display:flex; flex-direction:column; border:1px solid #ddd; border-radius:6px; background:#fff;">
                    <div style="padding:8px; background:#f0f0f0; border-bottom:1px solid #ddd; font-weight:bold; font-size:12px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
                        <span>Active Ridges</span>
                        <button type="button" id="ventRerollBtn" style="border:1px solid #c8d2dc; background:#fff; color:#1a73e8; border-radius:6px; padding:4px 7px; font-size:11px; font-weight:800; cursor:pointer;">
                            Re-roll
                        </button>
                    </div>
                    <div id="ridgeList" style="flex:1; overflow-y:auto; padding:5px;"></div>
                </div>
            </div>
        </div>
    `;

    const chkInclude   = container.querySelector('#chkIncludeVent');
    const wrapper      = container.querySelector('#ventContentWrapper');
    const atticBox     = container.querySelector('#ventAtticBox');
    const nfvaGrid     = container.querySelector('#ventNfvaGrid');
    const exhaustGrid  = container.querySelector('#ventExhaustGrid');
    const imgEl        = container.querySelector('#ventPreviewImg');
    const listEl       = container.querySelector('#ridgeList');
    const sourceLabelEl = container.querySelector('#ventImageSourceLabel');
    const rerollBtn    = container.querySelector('#ventRerollBtn');

    // Shared compute helper — ridge recommended ONLY when capacity fully covers exhaust
    const computeForRatio = (atticArea, totalRidgeFt, ratio) => {
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

    const getVentMetersPerPx = () => {
        const explicit = Number(state?.imageMetersPerPx);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const dimsW = Number(state?.dims?.w || state?.dims?.width || 0);
        const radiusMeters = Number(state?.radiusMeters || window.RADIUS_METERS || 20);
        if (Number.isFinite(dimsW) && dimsW > 0 && Number.isFinite(radiusMeters) && radiusMeters > 0) {
            return (radiusMeters * 2) / dimsW;
        }
        if (typeof window.getMetersPerPx === 'function') {
            const liveValue = Number(window.getMetersPerPx());
            if (Number.isFinite(liveValue) && liveValue > 0) return liveValue;
        }
        return 0.04;
    };

    const isPointInPolyForVent = (x, y, poly) => {
        if (!Array.isArray(poly) || poly.length < 3) return false;
        if (typeof isPointInPolyMeasurement === 'function') {
            return isPointInPolyMeasurement(x, y, poly);
        }
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = Number(poly[i].x), yi = Number(poly[i].y);
            const xj = Number(poly[j].x), yj = Number(poly[j].y);
            const intersects = ((yi > y) !== (yj > y)) &&
                (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
            if (intersects) inside = !inside;
        }
        return inside;
    };

    const findVentFaceAtPoint = (x, y) => {
        const faces = Array.isArray(state.facesData) ? state.facesData : [];
        for (let idx = 0; idx < faces.length; idx++) {
            const face = faces[idx];
            if (!face || !Array.isArray(face.points) || face.points.length < 3) continue;
            if (!isPointInPolyForVent(x, y, face.points)) continue;
            const holes = Array.isArray(face.holes) ? face.holes : [];
            let inHole = false;
            for (const hole of holes) {
                if (isPointInPolyForVent(x, y, hole)) {
                    inHole = true;
                    break;
                }
            }
            if (!inHole) return { face, faceIndex: idx };
        }
        return null;
    };

    const isPointInsideVentFace = (x, y, face) => {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
        if (!isPointInPolyForVent(x, y, face.points)) return false;
        const holes = Array.isArray(face.holes) ? face.holes : [];
        return !holes.some(hole => isPointInPolyForVent(x, y, hole));
    };

    const getVentPointKey = (point) => {
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return `${Math.round(x * 10)}:${Math.round(y * 10)}`;
    };

    const getVentXYKey = (x, y) => `${Math.round(Number(x) * 10)}:${Math.round(Number(y) * 10)}`;

    const doVentPointsMatch = (a, b) => {
        if (!a || !b) return false;
        const dx = Number(a.x) - Number(b.x);
        const dy = Number(a.y) - Number(b.y);
        return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 1;
    };

    const normalizeVentVector = (x, y) => {
        const len = Math.hypot(x, y);
        if (!Number.isFinite(len) || len <= 1e-9) return null;
        return { x: x / len, y: y / len };
    };

    const centerOutSlotIndexes = (count) => {
        const indexes = Array.from({ length: count }, (_, i) => i);
        return indexes.sort((a, b) => {
            const center = (count - 1) / 2;
            return Math.abs(a - center) - Math.abs(b - center) || a - b;
        });
    };

    const allocateVentSlotsAcrossRidges = (ridges, totalSlots) => {
        if (!ridges.length || totalSlots <= 0) return new Map();
        const totalLength = ridges.reduce((sum, item) => sum + item.length, 0);
        const allocations = ridges.map((item) => {
            const exact = totalLength > 0 ? (item.length / totalLength) * totalSlots : (totalSlots / ridges.length);
            const base = Math.floor(exact);
            return { item, count: base, remainder: exact - base };
        });
        let assigned = allocations.reduce((sum, allocation) => sum + allocation.count, 0);
        allocations
            .slice()
            .sort((a, b) => (b.remainder - a.remainder) || (b.item.length - a.item.length) || (a.item.idx - b.item.idx))
            .forEach((allocation) => {
                if (assigned >= totalSlots) return;
                allocation.count += 1;
                assigned += 1;
            });
        while (assigned > totalSlots) {
            const donor = allocations
                .filter(allocation => allocation.count > 0)
                .sort((a, b) => (a.remainder - b.remainder) || (a.item.length - b.item.length))[0];
            if (!donor) break;
            donor.count -= 1;
            assigned -= 1;
        }
        return new Map(allocations.filter(allocation => allocation.count > 0).map(allocation => [allocation.item.idx, allocation.count]));
    };

    const findRooftopPeakVentPlacements = (reportLines, neededCount) => {
        if (!Array.isArray(reportLines) || neededCount <= 0) {
            return { vents: [], validCandidates: 0, peakCount: 0 };
        }

        const incident = new Map();
        reportLines.forEach((line, lineIndex) => {
            if (!line || !Array.isArray(line.points) || line.points.length < 2) return;
            line.points.slice(0, 2).forEach((point, endpointIndex) => {
                const key = getVentPointKey(point);
                if (!key) return;
                if (!incident.has(key)) incident.set(key, []);
                incident.get(key).push({ line, lineIndex, point, endpointIndex });
            });
        });

        const oneFootPx = 0.3048 / getVentMetersPerPx();
        const faces = Array.isArray(state.facesData) ? state.facesData : [];
        const vents = [];
        const seen = new Set();
        let validCandidates = 0;
        let peakCount = 0;

        incident.forEach((items, peakKey) => {
            if (vents.length >= neededCount) return;
            if (!items || items.length < 2) return;
            if (!items.every(item => item.line?.type === 'hip')) return;

            const peakPoint = items[0].point;
            const peakHeights = items
                .map(item => Number(item?.point?.z))
                .filter(value => Number.isFinite(value));
            if (!peakHeights.length) return;
            const peakZ = Math.max(...peakHeights);

            const slopesDown = items.every((item) => {
                const other = item.line.points[item.endpointIndex === 0 ? 1 : 0];
                const otherZ = Number(other?.z);
                return Number.isFinite(otherZ) && otherZ < peakZ - 0.03;
            });
            if (!slopesDown) return;

            peakCount += 1;
            faces.forEach((face, faceIndex) => {
                if (vents.length >= neededCount) return;
                const points = Array.isArray(face?.points) ? face.points : [];
                const peakFaceIndex = points.findIndex(point => doVentPointsMatch(point, peakPoint));
                if (peakFaceIndex < 0 || points.length < 3) return;

                const prevPoint = points[(peakFaceIndex - 1 + points.length) % points.length];
                const nextPoint = points[(peakFaceIndex + 1) % points.length];
                const hasPrevHip = items.some(item => doVentPointsMatch(item.line.points[item.endpointIndex === 0 ? 1 : 0], prevPoint));
                const hasNextHip = items.some(item => doVentPointsMatch(item.line.points[item.endpointIndex === 0 ? 1 : 0], nextPoint));
                if (!hasPrevHip || !hasNextHip) return;

                const prevVector = normalizeVentVector(Number(prevPoint.x) - Number(peakPoint.x), Number(prevPoint.y) - Number(peakPoint.y));
                const nextVector = normalizeVentVector(Number(nextPoint.x) - Number(peakPoint.x), Number(nextPoint.y) - Number(peakPoint.y));
                if (!prevVector || !nextVector) return;

                let inward = normalizeVentVector(prevVector.x + nextVector.x, prevVector.y + nextVector.y);
                if (!inward) {
                    const centroid = points.reduce((sum, point) => ({
                        x: sum.x + (Number(point.x) || 0),
                        y: sum.y + (Number(point.y) || 0)
                    }), { x: 0, y: 0 });
                    inward = normalizeVentVector(
                        (centroid.x / points.length) - Number(peakPoint.x),
                        (centroid.y / points.length) - Number(peakPoint.y)
                    );
                }
                if (!inward) return;

                const x = Number(peakPoint.x) + inward.x * oneFootPx;
                const y = Number(peakPoint.y) + inward.y * oneFootPx;
                if (!isPointInsideVentFace(x, y, face)) return;

                const key = getVentXYKey(x, y);
                if (seen.has(key)) return;
                seen.add(key);
                validCandidates += 1;
                vents.push({
                    x,
                    y,
                    peakKey,
                    faceIndex,
                    offsetFt: 1,
                    source: 'auto_rooftop_peak_box_vent'
                });
            });
        });

        return { vents, validCandidates, peakCount };
    };

    const generateRidgeBoxVentPlacements = (ridgeItems, neededCount, existingKeys = new Set()) => {
        if (!Array.isArray(ridgeItems) || !ridgeItems.length || neededCount <= 0) {
            return { vents: [], needed: Math.max(0, neededCount || 0), validCandidates: 0 };
        }

        const metersPerPx = getVentMetersPerPx();
        const oneFootPx = 0.3048 / metersPerPx;
        const longestRidgeFt = ridgeItems.reduce((max, item) => Math.max(max, item.length || 0), 0);
        const maxSlots = Math.max(
            Math.ceil(neededCount / 2),
            Math.ceil(longestRidgeFt * 2),
            ridgeItems.length * 2,
            neededCount * 4
        );

        let bestCandidates = [];
        for (let totalSlots = Math.max(1, Math.ceil(neededCount / 2)); totalSlots <= maxSlots; totalSlots++) {
            const slotAllocations = allocateVentSlotsAcrossRidges(ridgeItems, totalSlots);
            const candidates = [];
            const seen = new Set(existingKeys);

            ridgeItems.forEach((item) => {
                const count = slotAllocations.get(item.idx) || 0;
                if (!count) return;
                const points = item.line.points || [];
                const p1 = points[0];
                const p2 = points[1];
                if (!p1 || !p2) return;

                const dx = Number(p2.x) - Number(p1.x);
                const dy = Number(p2.y) - Number(p1.y);
                const lenPx = Math.hypot(dx, dy);
                if (!Number.isFinite(lenPx) || lenPx <= 0) return;

                const normalX = -dy / lenPx;
                const normalY = dx / lenPx;
                const slotIndexes = centerOutSlotIndexes(count);

                slotIndexes.forEach((slotIndex) => {
                    const t = (slotIndex + 1) / (count + 1);
                    const baseX = Number(p1.x) + dx * t;
                    const baseY = Number(p1.y) + dy * t;
                    [
                        { side: 'left', sign: 1 },
                        { side: 'right', sign: -1 }
                    ].forEach(({ side, sign }) => {
                        const x = baseX + normalX * oneFootPx * sign;
                        const y = baseY + normalY * oneFootPx * sign;
                        const match = findVentFaceAtPoint(x, y);
                        if (!match) return;
                        const key = getVentXYKey(x, y);
                        if (seen.has(key)) return;
                        seen.add(key);
                        candidates.push({
                            x,
                            y,
                            ridgeIndex: item.idx,
                            side,
                            faceIndex: match.faceIndex,
                            offsetFt: 1,
                            alongRatio: Number(t.toFixed(4)),
                            source: 'auto_box_vent'
                        });
                    });
                });
            });

            bestCandidates = candidates;
            if (candidates.length >= neededCount) break;
        }

        return {
            vents: bestCandidates.slice(0, neededCount),
            needed: neededCount,
            validCandidates: bestCandidates.length
        };
    };

    const generateBoxVentPlacements = (reportLines, ridgeItems, neededCount) => {
        const needed = Math.max(0, Number(neededCount) || 0);
        const peakPlacement = findRooftopPeakVentPlacements(reportLines, needed);
        const peakVents = peakPlacement.vents.slice(0, needed);
        const existingKeys = new Set(peakVents.map(vent => getVentXYKey(vent.x, vent.y)));
        const ridgePlacement = generateRidgeBoxVentPlacements(
            ridgeItems,
            Math.max(0, needed - peakVents.length),
            existingKeys
        );
        const vents = peakVents.concat(ridgePlacement.vents).slice(0, needed);
        return {
            vents,
            needed,
            validCandidates: peakPlacement.validCandidates + ridgePlacement.validCandidates,
            peakCount: peakPlacement.peakCount,
            peakVentsPlaced: peakVents.length,
            ridgeVentsPlaced: ridgePlacement.vents.length
        };
    };

    const setVentPageIncluded = (include, autoDisabled = false) => {
        state.ventSettings.include = !!include;
        state.ventSettings.autoDisabled = !!autoDisabled;
        if (chkInclude) chkInclude.checked = !!include;
        if (wrapper) wrapper.style.display = include ? 'block' : 'none';
    };

    const restoreAutoDisabledVentPage = () => {
        if (state.ventSettings.autoDisabled) {
            setVentPageIncluded(true, false);
        }
    };

    const runVentilationAutomation = (options = {}) => {
        const force = !!options.force;
        const notify = !!options.notify;
        if (!force && state.ventSettings.shortRidgesAutoExcluded) {
            return { changed: false, needsBoxVents: state.ventSettings.mode === 'box' };
        }
        const calcRes = window.recalculateReportMaterials(state);
        const tempReport = calcRes.updatedReport;
        const selectedRatio = state.ventSettings.selectedRatio || 300;
        const roofSurfaceSqFt = (tempReport.materials.totalSquares || 0) * 100;
        const footprintSqFt = tempReport.materials.totalFootprintSqFt || roofSurfaceSqFt;
        const atticArea = tempReport.materials.atticAreaSqFt || (footprintSqFt * SOFFIT_FACTOR);
        const excludedSet = new Set();
        const allRidgeLines = tempReport.lines
            .map((line, idx) => ({ line, idx, length: Number(line.length) || 0 }))
            .filter(item => item.line.type === 'ridge' && item.length > 0);

        const allRidgeFt = allRidgeLines.reduce((sum, item) => sum + item.length, 0);
        const allRidgeResult = computeForRatio(atticArea, allRidgeFt, selectedRatio);

        state.ventSettings.shortRidgesAutoExcluded = true;

        if (!allRidgeResult.recommendRidge) {
            const boxPlacement = generateBoxVentPlacements(tempReport.lines, allRidgeLines, allRidgeResult.boxOnlyCount);
            const hasVentStructure = allRidgeLines.length > 0 || boxPlacement.peakCount > 0;
            const hasEnoughBoxVentSpace = boxPlacement.vents.length >= allRidgeResult.boxOnlyCount;

            if (!hasVentStructure || !hasEnoughBoxVentSpace) {
                state.ventSettings.excludedRidges = [];
                state.ventSettings.mode = 'off';
                state.ventSettings.boxVents = [];
                setVentPageIncluded(false, true);
                state.ventSettings.automationResult = {
                    at: new Date().toISOString(),
                    mode: 'off',
                    reason: hasVentStructure ? 'insufficient_box_vent_space' : 'no_ridge_or_rooftop_peaks',
                    availableRidgeFt: allRidgeFt,
                    ridgeNeededFt: allRidgeResult.ridgeNeededFt,
                    boxVentsNeeded: allRidgeResult.boxOnlyCount,
                    boxVentsPlaced: boxPlacement.vents.length,
                    validBoxVentCandidates: boxPlacement.validCandidates,
                    rooftopPeaksFound: boxPlacement.peakCount,
                    rooftopPeakBoxVentsPlaced: boxPlacement.peakVentsPlaced,
                    ridgeBoxVentsPlaced: boxPlacement.ridgeVentsPlaced
                };
                if (notify) {
                    const message = hasVentStructure
                        ? `Ventilation page turned off. The automation found ${boxPlacement.vents.length} valid box vent placement${boxPlacement.vents.length === 1 ? '' : 's'}, but ${allRidgeResult.boxOnlyCount} are needed.`
                        : 'Ventilation page turned off. No ridge or valid rooftop peak points were found for automatic ventilation.';
                    alert(message);
                }
                return { changed: true, needsBoxVents: true, disabledVentPage: true, result: allRidgeResult, boxPlacement };
            }

            restoreAutoDisabledVentPage();
            state.ventSettings.excludedRidges = [];
            state.ventSettings.mode = 'box';
            state.ventSettings.boxVents = boxPlacement.vents;
            state.ventSettings.automationResult = {
                at: new Date().toISOString(),
                mode: 'box',
                reason: 'insufficient_ridge',
                availableRidgeFt: allRidgeFt,
                ridgeNeededFt: allRidgeResult.ridgeNeededFt,
                boxVentsNeeded: allRidgeResult.boxOnlyCount,
                boxVentsPlaced: boxPlacement.vents.length,
                validBoxVentCandidates: boxPlacement.validCandidates,
                rooftopPeaksFound: boxPlacement.peakCount,
                rooftopPeakBoxVentsPlaced: boxPlacement.peakVentsPlaced,
                ridgeBoxVentsPlaced: boxPlacement.ridgeVentsPlaced
            };
            if (notify) {
                if (boxPlacement.vents.length >= allRidgeResult.boxOnlyCount) {
                    alert(`Box vents are required for this project. Placed ${boxPlacement.vents.length} box vent${boxPlacement.vents.length === 1 ? '' : 's'} automatically.`);
                } else {
                    alert(`Box vents are required for this project. Placed ${boxPlacement.vents.length} of ${allRidgeResult.boxOnlyCount}; the remaining vents need manual placement because no valid roof face was found.`);
                }
            }
            return { changed: true, needsBoxVents: true, result: allRidgeResult, boxPlacement };
        }

        restoreAutoDisabledVentPage();
        const candidates = tempReport.lines
            .map((line, idx) => ({ line, idx, length: Number(line.length) || 0 }))
            .filter(item => item.line.type === 'ridge' && item.length > 0 && item.length < 5)
            .sort((a, b) => (a.length - b.length) || (a.idx - b.idx));

        const getActiveRidgeFt = () => tempReport.lines.reduce((sum, line, idx) => {
            if (line.type !== 'ridge' || excludedSet.has(idx)) return sum;
            return sum + (Number(line.length) || 0);
        }, 0);

        for (const item of candidates) {
            excludedSet.add(item.idx);
            const remainingRidgeFt = getActiveRidgeFt();
            const result = computeForRatio(atticArea, remainingRidgeFt, selectedRatio);
            if (!result.recommendRidge) {
                excludedSet.delete(item.idx);
                break;
            }
        }

        state.ventSettings.excludedRidges = Array.from(excludedSet);
        state.ventSettings.mode = 'ridge';
        state.ventSettings.boxVents = [];
        state.ventSettings.shortRidgesAutoExcluded = true;
        state.ventSettings.automationResult = {
            at: new Date().toISOString(),
            mode: 'ridge',
            reason: 'ridge_sufficient',
            excludedShortRidgeIndexes: state.ventSettings.excludedRidges.slice()
        };
        return { changed: true, needsBoxVents: false, result: allRidgeResult };
    };

    const getViewLabel = (viewId) => {
        if (viewId === 'apple') return 'Apple';
        if (viewId === 'google') return 'Google';
        if (viewId === 'azure') return 'Bing';
        return 'Solar';
    };

    const updateVentSourceLabel = () => {
        if (!sourceLabelEl) return;
        const mainViewId = state.imageSettings?.mainViewId || 'solar';
        const ventViewId = syncVentilationViewToTopView(state.imageSettings);
        sourceLabelEl.textContent = `${getViewLabel(ventViewId)} image, based on Top View: ${getViewLabel(mainViewId)}`;
    };

    const getVentViewCanvas = (viewId) => {
        if (window.ensureProviderCanvasIsUsable) {
            return window.ensureProviderCanvasIsUsable(viewId);
        }
        if (window.viewCanvases && window.viewCanvases[viewId]) return window.viewCanvases[viewId];
        if (window.ensureViewCanvas) return window.ensureViewCanvas(viewId);
        return null;
    };

    const ensureVentViewLoaded = async (viewId) => {
        if (getVentViewCanvas(viewId)) return true;
        try {
            if (viewId === 'apple' && window.handleAppleLayerFetch) {
                await window.handleAppleLayerFetch();
            }
        } catch (e) {
            console.warn('[Ventilation] Failed to load derived image source:', viewId, e);
        }
        return !!getVentViewCanvas(viewId);
    };

    const updateUI = async () => {
        const ventViewId = syncVentilationViewToTopView(state.imageSettings);
        updateVentSourceLabel();
        await ensureVentViewLoaded(ventViewId);

        const calcRes = window.recalculateReportMaterials(state);
        const tempReport = calcRes.updatedReport;
        const excludedRidges = state.ventSettings.excludedRidges;
        const selectedRatio = state.ventSettings.selectedRatio || 300;

        const roofSurfaceSqFt = (tempReport.materials.totalSquares || 0) * 100;
        const footprintSqFt   = tempReport.materials.totalFootprintSqFt || roofSurfaceSqFt;
        const atticArea        = tempReport.materials.atticAreaSqFt || (footprintSqFt * SOFFIT_FACTOR);

        const activeRidgeLines = tempReport.lines.filter((l, i) => l.type === 'ridge' && !excludedRidges.includes(i));
        const totalRidgeFt = activeRidgeLines.reduce((acc, l) => acc + (l.length || 0), 0);

        const data300 = computeForRatio(atticArea, totalRidgeFt, 300);
        const data150 = computeForRatio(atticArea, totalRidgeFt, 150);
        
        // Match selection to whichever box the company setting is (defaulting to 300)
        const selected = (selectedRatio === 150) ? data150 : data300;

        // ── Attic Area Box ──
        atticBox.innerHTML = `
            <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:4px;">
                <span style="font-size:13px; font-weight:bold; color:#333;">Estimated Attic Area:</span>
                <span style="font-size:18px; font-weight:900; color:#1a73e8;">${Math.round(atticArea).toLocaleString()} sq ft</span>
            </div>
            <div style="font-size:10px; color:#888; display:flex; gap:12px; flex-wrap:wrap;">
                <span>Roof Surface: ${Math.round(roofSurfaceSqFt).toLocaleString()} sq ft</span>
                <span>Footprint: ${Math.round(footprintSqFt).toLocaleString()} sq ft</span>
                <span>Soffit Reduction: 2%</span>
            </div>
        `;

        // ── NFVA Comparison Cards ──
        const nfvaCard = (d, isSelected) => {
            const border = isSelected ? '2px solid #1a73e8' : '1px solid #ddd';
            const bg = isSelected ? 'rgba(26,115,232,.04)' : '#fff';
            const badge = isSelected ? `<span style="background:#1a73e8; color:#fff; font-size:9px; font-weight:800; padding:1px 6px; border-radius:99px; margin-left:6px;">SELECTED</span>` : '';
            return `
                <div style="border:${border}; border-radius:6px; padding:8px 10px; background:${bg};">
                    <div style="font-weight:bold; font-size:12px; color:#333; margin-bottom:6px;">
                        1 / ${d.ratio} Ratio ${badge}
                    </div>
                    <div style="font-size:11px; color:#555; display:flex; flex-direction:column; gap:3px;">
                        <div>Total NFVA: <b>${Math.round(d.totalNfvaSqIn)} sq in</b></div>
                        <div>Req. Exhaust: <b>${Math.round(d.reqExhaust)} sq in</b></div>
                        <div>Req. Intake: <b>${Math.round(d.reqIntake)} sq in</b></div>
                    </div>
                </div>
            `;
        };
        nfvaGrid.innerHTML = nfvaCard(data300, selectedRatio === 300) + nfvaCard(data150, selectedRatio === 150);

        // ── Exhaust Options Cards ──
        const ridgeBadge = selected.recommendRidge
            ? `<span style="background:#34a853; color:#fff; font-size:9px; font-weight:800; padding:1px 6px; border-radius:99px; margin-left:4px;">\u2605 REC</span>`
            : '';
        const boxBadge = !selected.recommendRidge
            ? `<span style="background:#34a853; color:#fff; font-size:9px; font-weight:800; padding:1px 6px; border-radius:99px; margin-left:4px;">\u2605 REC</span>`
            : '';

        let ridgeDetailHtml = '';
        if (selected.recommendRidge) {
            ridgeDetailHtml = `<div style="color:#34a853;">Ridge capacity sufficient</div>`;
        } else if (totalRidgeFt < 4) {
            ridgeDetailHtml = `<div style="color:#d93025;">Insufficient ridge length</div>`;
        } else {
            ridgeDetailHtml = `
                <div style="color:#d93025;">Deficit: ${Math.round(selected.ridgeDeficit)} sq in</div>
                <div>Supplement needed: <b>${selected.supplementBoxVents} box vent${selected.supplementBoxVents > 1 ? 's' : ''}</b></div>
            `;
        }

        exhaustGrid.innerHTML = `
            <div style="border:${selected.recommendRidge ? '2px solid #34a853' : '1px solid #ddd'}; border-radius:6px; padding:8px 10px; background:${selected.recommendRidge ? 'rgba(52,168,83,.04)' : '#fff'};">
                <div style="font-weight:bold; font-size:12px; color:#333; margin-bottom:6px;">
                    Ridge Vent ${ridgeBadge}
                </div>
                <div style="font-size:11px; color:#555; display:flex; flex-direction:column; gap:3px;">
                    <div>Ridge Needed: <b>${Math.round(selected.ridgeNeededFt)}'</b></div>
                    <div>Available: <b>${Math.round(totalRidgeFt)}'</b></div>
                    <div>Capacity: <b>${Math.round(selected.ridgeCapacity)} sq in</b></div>
                    ${ridgeDetailHtml}
                </div>
            </div>
            <div style="border:${!selected.recommendRidge ? '2px solid #34a853' : '1px solid #ddd'}; border-radius:6px; padding:8px 10px; background:${!selected.recommendRidge ? 'rgba(52,168,83,.04)' : '#fff'};">
                <div style="font-weight:bold; font-size:12px; color:#333; margin-bottom:6px;">
                    Box Vents Only ${boxBadge}
                </div>
                <div style="font-size:11px; color:#555; display:flex; flex-direction:column; gap:3px;">
                    <div>Total Needed: <b>${selected.boxOnlyCount} vent${selected.boxOnlyCount > 1 ? 's' : ''}</b></div>
                    <div>Rating: ${BOX_VENT_RATING} sq in NFA each</div>
                    <div>Total Capacity: <b>${selected.boxOnlyCount * BOX_VENT_RATING} sq in</b></div>
                </div>
            </div>
        `;

        if (imgEl) {
            const ventMode = state.ventSettings.mode || (selected.recommendRidge ? 'ridge' : 'box');
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

            const cvs = await createVentCanvas(
                tempReport,
                state.cropRegion,
                ventData,
                state,
                state.ventSettings.excludedRidges
            );
            imgEl.src = cvs.toDataURL('image/png');
        }
    };

    // ── Image source toggles ──
    const refreshVentImageFromTopView = async () => {
        updateVentSourceLabel();
        if (!state.ventSettings.include) return;
        if (imgEl) imgEl.style.opacity = '0.5';
        try {
            await updateUI();
        } finally {
            if (imgEl) imgEl.style.opacity = '1';
        }
    };

    // ── Ridge list ──
    const renderList = () => {
        listEl.innerHTML = '';
        let ridgesFound = false;
        state.report.lines.forEach((line, idx) => {
            if (line.type !== 'ridge') return;
            ridgesFound = true;
            const isExcluded = state.ventSettings.excludedRidges.includes(idx);
            const div = document.createElement('div');
            div.style.cssText = 'padding:6px; border-bottom:1px solid #eee; font-size:12px; display:flex; align-items:center;';
            div.innerHTML = `
                <label style="flex:1; cursor:pointer; display:flex; align-items:center;">
                    <input type="checkbox" ${!isExcluded ? 'checked' : ''} style="margin-right:8px;">
                    Ridge ${Math.round(line.length)}'
                </label>
            `;
            const chk = div.querySelector('input');
            chk.onchange = () => {
                state.ventSettings.manualOverride = true;
                if (chk.checked) {
                    state.ventSettings.excludedRidges = state.ventSettings.excludedRidges.filter(i => i !== idx);
                } else {
                    if (!state.ventSettings.excludedRidges.includes(idx)) state.ventSettings.excludedRidges.push(idx);
                }
                updateUI();
            };
            listEl.appendChild(div);
        });
        if (!ridgesFound) {
            listEl.innerHTML = '<div style="padding:10px; color:#999; font-style:italic; text-align:center;">No ridges detected.</div>';
        }
    };

    runVentilationAutomation();
    updateVentSourceLabel();
    renderList();

    if (window.__reportVentTopViewChangeHandler) {
        window.removeEventListener('firstmeasure:topViewChanged', window.__reportVentTopViewChangeHandler);
    }
    window.__reportVentTopViewChangeHandler = refreshVentImageFromTopView;
    window.addEventListener('firstmeasure:topViewChanged', window.__reportVentTopViewChangeHandler);

    chkInclude.onchange = () => {
        state.ventSettings.include = chkInclude.checked;
        state.ventSettings.autoDisabled = false;
        state.ventSettings.manualOverride = true;
        wrapper.style.display = chkInclude.checked ? 'block' : 'none';
        if (chkInclude.checked) updateUI();
    };

    if (rerollBtn) {
        rerollBtn.onclick = async () => {
            rerollBtn.disabled = true;
            const originalText = rerollBtn.textContent;
            rerollBtn.textContent = 'Running...';
            try {
                state.ventSettings.manualOverride = false;
                runVentilationAutomation({ force: true, notify: true });
                renderList();
                if (state.ventSettings.include) await updateUI();
            } finally {
                rerollBtn.disabled = false;
                rerollBtn.textContent = originalText || 'Re-roll';
            }
        };
    }

    if (state.ventSettings.include) updateUI();
}



// =============================================================================
// DEFAULT LABEL BUILDER
// =============================================================================

function buildDefaultDiagramLabels(state, options = {}) {
  const placementOptions = {
    secondPass: true,
    thirdPass: true,
    fourthPass: true,
    ...(options || {})
  };
  const crop = state.cropRegion;
  const extraPad = Math.max(0, Number(state.editorCropPadding) || 0);
  const TEXT_EDGE_MARGIN = 6;
  const LABEL_CLEARANCE = 3;
  const MODEL_OUTSIDE_GAP = 14;
  const LINE_CROSS_PUSH = 5;

  const tmp = document.createElement('canvas');
  tmp.width = Math.max(10, crop.width * 2);
  tmp.height = Math.max(10, crop.height * 2);
  const ctx = tmp.getContext('2d');

  const effW = Math.max(1, crop.width + extraPad * 2);
  const effH = Math.max(1, crop.height + extraPad * 2);
  const targetWidth = 2000;
  const canvasScale = targetWidth / effW;
  const labelRelativeScale = Math.max(1, Math.max(targetWidth, effH * canvasScale) / targetWidth);
  const diagramScale = Number.isFinite(Number(state.diagramFontScale)) && Number(state.diagramFontScale) > 0
    ? Number(state.diagramFontScale)
    : (Number.isFinite(Number(window.PDF_DIAGRAM_FONT_SCALE)) && Number(window.PDF_DIAGRAM_FONT_SCALE) > 0 ? Number(window.PDF_DIAGRAM_FONT_SCALE) : 1);
  const fontSize = (40 * labelRelativeScale * diagramScale) / canvasScale;
  ctx.font = `bold ${fontSize}px Arial`;
  const STRUCTURE_LABEL_CLEARANCE = Math.max(4, Math.min(10, fontSize * 0.28));

  const labelsToDraw = [];

  const metersPerPx = (typeof getPdfMetersPerPx === 'function')
    ? getPdfMetersPerPx(state)
    : ((20 * 2) / state.dims.w);
  const autoExcluded = (typeof getReportAutoExcludedFaceIndexSet === 'function')
    ? getReportAutoExcludedFaceIndexSet(state)
    : new Set();

  const isObstacleFaceForLabels = (face) => {
    if (!face || !Array.isArray(face.points) || !face.points.length) return true;
    if (typeof isObstacleFace === 'function') return isObstacleFace(face, state.report);
    const key = (point) => `${Number(point?.x).toFixed(4)},${Number(point?.y).toFixed(4)}`;
    const obstaclePointKeys = new Set();
    (state.report?.lines || []).forEach((line) => {
      const type = String(line?.type || '').toLowerCase();
      if (!(type === 'skylight' || type === 'chimney_edge' || type === 'chimney_back' || type === 'chimney_front')) return;
      if (line.points?.[0]) obstaclePointKeys.add(key(line.points[0]));
      if (line.points?.[1]) obstaclePointKeys.add(key(line.points[1]));
    });
    return face.points.every((point) => obstaclePointKeys.has(key(point)));
  };

  const activeFaces = (state.facesData || []).filter((face, idx) => !autoExcluded.has(idx) && !isObstacleFaceForLabels(face));
  const modelBounds = activeFaces.reduce((bounds, face) => {
    (face.points || []).forEach((point) => {
      const x = Number(point.x) - crop.minX;
      const y = Number(point.y) - crop.minY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    });
    return bounds;
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  if (!Number.isFinite(modelBounds.minX)) {
    modelBounds.minX = 0;
    modelBounds.minY = 0;
    modelBounds.maxX = crop.width;
    modelBounds.maxY = crop.height;
  }
  const modelCenter = {
    x: (modelBounds.minX + modelBounds.maxX) / 2,
    y: (modelBounds.minY + modelBounds.maxY) / 2
  };

  const getRise12 = (face) => {
    if (typeof getFacePitchRise12 === 'function') {
      return getFacePitchRise12(face, metersPerPx);
    }
    const n = face?.planeNormal;
    if (n && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z) && Math.abs(n.z) > 1e-9) {
      const a = -n.x / n.z, b = -n.y / n.z;
      const rawSlope = Math.sqrt(a*a + b*b);
      const realSlope = rawSlope * (1 / metersPerPx);
      return realSlope * 12;
    }
    const plane = localFitPlane(face.points);
    const rawSlope = Math.sqrt(plane.a * plane.a + plane.b * plane.b);
    const realSlope = rawSlope * (1 / metersPerPx);
    return realSlope * 12;
  };

  const getLabelRect = (lbl, pad = 0) => ({
    l: lbl.x - lbl.w / 2 - pad,
    r: lbl.x + lbl.w / 2 + pad,
    t: lbl.y - lbl.h / 2 - pad,
    b: lbl.y + lbl.h / 2 + pad
  });

  const rectsOverlap = (a, b, pad = LABEL_CLEARANCE) => {
    const ar = getLabelRect(a, pad);
    const br = getLabelRect(b, pad);
    return !(ar.r < br.l || ar.l > br.r || ar.b < br.t || ar.t > br.b);
  };

  const pointInLabelRect = (point, label, pad = 1) => {
    const rect = getLabelRect(label, pad);
    return point.x >= rect.l && point.x <= rect.r && point.y >= rect.t && point.y <= rect.b;
  };

  const segmentIntersectsLabelRect = (a, b, label, pad = 1) => {
    const rect = getLabelRect(label, pad);
    if ((a.x < rect.l && b.x < rect.l) || (a.x > rect.r && b.x > rect.r) ||
        (a.y < rect.t && b.y < rect.t) || (a.y > rect.b && b.y > rect.b)) {
      return false;
    }
    if (pointInLabelRect(a, label, pad) || pointInLabelRect(b, label, pad)) return true;
    const corners = [
      { x: rect.l, y: rect.t },
      { x: rect.r, y: rect.t },
      { x: rect.r, y: rect.b },
      { x: rect.l, y: rect.b }
    ];
    for (let i = 0; i < corners.length; i++) {
      if (segmentCrosses(a, b, corners[i], corners[(i + 1) % corners.length])) return true;
    }
    return false;
  };

  const clampLabelToBounds = (lbl) => {
    const minX = -extraPad + TEXT_EDGE_MARGIN + lbl.w / 2;
    const maxX = crop.width + extraPad - TEXT_EDGE_MARGIN - lbl.w / 2;
    const minY = -extraPad + TEXT_EDGE_MARGIN + lbl.h / 2;
    const maxY = crop.height + extraPad - TEXT_EDGE_MARGIN - lbl.h / 2;
    lbl.x = clamp(lbl.x, Math.min(minX, maxX), Math.max(minX, maxX));
    lbl.y = clamp(lbl.y, Math.min(minY, maxY), Math.max(minY, maxY));
  };

  const canPlaceLabelOnFace = (face, holes, localX, localY, w, h, placedLabels = []) => {
    const pad = 0;
    const absX = crop.minX + localX;
    const absY = crop.minY + localY;
    const halfW = w / 2 + pad;
    const halfH = h / 2 + pad;
    const samples = [
      [0, 0],
      [-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH],
      [0, -halfH], [halfW, 0], [0, halfH], [-halfW, 0]
    ];
    if (!samples.every(([dx, dy]) => getPointToPolygonDistWithHoles(absX + dx, absY + dy, face.points, holes) >= 0)) {
      return false;
    }

    const candidate = { x: localX, y: localY, w, h };
    return !placedLabels.some((label) => !label.excluded && rectsOverlap(candidate, label, 1));
  };

  const findBestOnFacePlacement = (face, holes, pole, centroid, w, h) => {
    const bounds = getReportFaceBounds(face);
    const candidateMap = new Map();
    const addCandidate = (x, y) => {
      const localX = x - crop.minX;
      const localY = y - crop.minY;
      if (!Number.isFinite(localX) || !Number.isFinite(localY)) return;
      const key = `${Math.round(localX * 10)}:${Math.round(localY * 10)}`;
      if (!candidateMap.has(key)) candidateMap.set(key, { x: localX, y: localY });
    };

    addCandidate(pole.x, pole.y);
    addCandidate(centroid.x, centroid.y);
    addCandidate((pole.x + centroid.x) / 2, (pole.y + centroid.y) / 2);

    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const grid = 7;
      for (let gy = 0; gy < grid; gy++) {
        for (let gx = 0; gx < grid; gx++) {
          const x = bounds.minX + ((gx + 0.5) / grid) * width;
          const y = bounds.minY + ((gy + 0.5) / grid) * height;
          addCandidate(x, y);
        }
      }
    }

    return Array.from(candidateMap.values())
      .filter((candidate) => canPlaceLabelOnFace(face, holes, candidate.x, candidate.y, w, h, labelsToDraw))
      .map((candidate) => {
        const absX = crop.minX + candidate.x;
        const absY = crop.minY + candidate.y;
        const distToPole = Math.hypot(absX - pole.x, absY - pole.y);
        const distToCentroid = Math.hypot(absX - centroid.x, absY - centroid.y);
        const clearance = getPointToPolygonDistWithHoles(absX, absY, face.points, holes);
        return {
          ...candidate,
          score: distToPole * 0.65 + distToCentroid * 0.25 - clearance * 0.35
        };
      })
      .sort((a, b) => a.score - b.score)[0] || null;
  };

  const isPointCoveredByHigherFace = (face, x, y) => {
    const ownHeight = getReportFaceHeightAtPoint(face, x, y);
    if (!Number.isFinite(ownHeight)) return false;
    return activeFaces.some((other) => {
      if (other === face) return false;
      if ((other.layer || 1) < (face.layer || 1)) return false;
      if (!isPointInsideRoofFaceAtPoint(x, y, other)) return false;
      const otherHeight = getReportFaceHeightAtPoint(other, x, y);
      return Number.isFinite(otherHeight) && otherHeight > ownHeight + 0.1;
    });
  };

  const getRouteLabelCrossingPenalty = (start, end, ownLabel = null) => {
    return labelsToDraw.reduce((penalty, label) => {
      if (!label || label.excluded || label === ownLabel) return penalty;
      return penalty + (segmentIntersectsLabelRect(start, end, label, 2) ? 1 : 0);
    }, 0);
  };

  const getLeaderStart = (face, holes, pole, targetLocal) => {
    const bounds = getReportFaceBounds(face);
    const centroid = getPolygonCentroid(face.points);
    const candidateMap = new Map();
    const addCandidate = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const key = `${Math.round(x * 10)}:${Math.round(y * 10)}`;
      if (!candidateMap.has(key)) candidateMap.set(key, { x, y });
    };

    addCandidate(pole.x, pole.y);
    addCandidate(centroid.x, centroid.y);
    addCandidate((pole.x + centroid.x) / 2, (pole.y + centroid.y) / 2);

    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const grid = 7;
      for (let gy = 0; gy < grid; gy++) {
        for (let gx = 0; gx < grid; gx++) {
          addCandidate(
            bounds.minX + ((gx + 0.5) / grid) * width,
            bounds.minY + ((gy + 0.5) / grid) * height
          );
        }
      }
    }

    const targetAbs = targetLocal
      ? { x: crop.minX + targetLocal.x, y: crop.minY + targetLocal.y }
      : { x: pole.x, y: pole.y };

    const candidates = Array.from(candidateMap.values())
      .map((candidate) => {
        const clearance = getPointToPolygonDistWithHoles(candidate.x, candidate.y, face.points, holes);
        if (clearance < 0) return null;
        const local = { x: candidate.x - crop.minX, y: candidate.y - crop.minY };
        const covered = isPointCoveredByHigherFace(face, candidate.x, candidate.y);
        const routePenalty = getRouteLabelCrossingPenalty(local, targetLocal || local);
        const edgePenalty = clearance < Math.max(2, fontSize * 0.18) ? 90 : 0;
        return {
          x: local.x,
          y: local.y,
          score:
            Math.hypot(candidate.x - pole.x, candidate.y - pole.y) * 0.35 +
            Math.hypot(candidate.x - targetAbs.x, candidate.y - targetAbs.y) * 0.12 -
            clearance * 2.2 +
            (covered ? 140 : 0) +
            routePenalty * 120 +
            edgePenalty
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    return candidates[0] || { x: pole.x - crop.minX, y: pole.y - crop.minY };
  };

  const classifyWhitespaceEdge = (start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'top' : 'bottom';
  };

  const isPointInAnyActiveFace = (localX, localY, excludedFace = null) => {
    const absX = crop.minX + localX;
    const absY = crop.minY + localY;
    return activeFaces.some((face) => face !== excludedFace && isPointInsideRoofFaceAtPoint(absX, absY, face));
  };

  const roofLineSegments = (state.report?.lines || [])
    .filter((line) => Array.isArray(line?.points) && line.points.length >= 2)
    .map((line) => ({
      a: { x: Number(line.points[0]?.x), y: Number(line.points[0]?.y) },
      b: { x: Number(line.points[1]?.x), y: Number(line.points[1]?.y) }
    }))
    .filter((seg) => Number.isFinite(seg.a.x) && Number.isFinite(seg.a.y) && Number.isFinite(seg.b.x) && Number.isFinite(seg.b.y));

  const pointInRect = (point, rect) => (
    point.x >= rect.l && point.x <= rect.r &&
    point.y >= rect.t && point.y <= rect.b
  );

  const rectCorners = (rect) => [
    { x: rect.l, y: rect.t },
    { x: rect.r, y: rect.t },
    { x: rect.r, y: rect.b },
    { x: rect.l, y: rect.b }
  ];

  const rectIntersectsSegment = (rect, a, b) => {
    if ((a.x < rect.l && b.x < rect.l) || (a.x > rect.r && b.x > rect.r) ||
        (a.y < rect.t && b.y < rect.t) || (a.y > rect.b && b.y > rect.b)) {
      return false;
    }
    if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
    const corners = rectCorners(rect);
    for (let i = 0; i < corners.length; i++) {
      if (segmentCrosses(a, b, corners[i], corners[(i + 1) % corners.length])) return true;
    }
    return false;
  };

  const rectOverlapsFace = (rect, face) => {
    const corners = rectCorners(rect);
    if (corners.some((point) => isPointInsideRoofFaceAtPoint(point.x, point.y, face))) return true;

    const loops = [face.points || []].concat(Array.isArray(face.holes) ? face.holes : []);
    for (const loop of loops) {
      const points = Array.isArray(loop) ? loop : [];
      if (points.some((point) => pointInRect({ x: Number(point?.x), y: Number(point?.y) }, rect))) return true;
      for (let i = 0; i < points.length; i++) {
        const a = { x: Number(points[i]?.x), y: Number(points[i]?.y) };
        const b = { x: Number(points[(i + 1) % points.length]?.x), y: Number(points[(i + 1) % points.length]?.y) };
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        if (rectIntersectsSegment(rect, a, b)) return true;
      }
    }

    return false;
  };

  const labelRectFitsWhitespace = (x, y, w, h, clearance = STRUCTURE_LABEL_CLEARANCE) => {
    const expandedW = w + clearance * 2;
    const expandedH = h + clearance * 2;
    const rect = {
      l: crop.minX + x - expandedW / 2,
      r: crop.minX + x + expandedW / 2,
      t: crop.minY + y - expandedH / 2,
      b: crop.minY + y + expandedH / 2
    };
    if (activeFaces.some((face) => rectOverlapsFace(rect, face))) return false;
    if (roofLineSegments.some((seg) => rectIntersectsSegment(rect, seg.a, seg.b))) return false;
    return true;
  };

  const getRouteStructurePenalty = (start, end, sourceFace) => {
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(6, Math.min(32, Math.ceil(dist / 10)));
    let penalty = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      const absX = crop.minX + x;
      const absY = crop.minY + y;
      activeFaces.forEach((face) => {
        if (face === sourceFace) return;
        if (isPointInsideRoofFaceAtPoint(absX, absY, face)) penalty += face === sourceFace ? 0.35 : 1;
      });
    }
    return penalty;
  };

  const findWhitespaceCandidates = (leaderLocal, w, h, sourceFace = null, options = {}) => {
    const minX = -extraPad + TEXT_EDGE_MARGIN + w / 2;
    const maxX = crop.width + extraPad - TEXT_EDGE_MARGIN - w / 2;
    const minY = -extraPad + TEXT_EDGE_MARGIN + h / 2;
    const maxY = crop.height + extraPad - TEXT_EDGE_MARGIN - h / 2;
    const loX = Math.min(minX, maxX);
    const hiX = Math.max(minX, maxX);
    const loY = Math.min(minY, maxY);
    const hiY = Math.max(minY, maxY);
    const targetGap = Math.max(6, Math.min(14, STRUCTURE_LABEL_CLEARANCE + fontSize * 0.18));
    const step = Math.max(3, Math.min(7, Math.max(w, h) * 0.18));
    const maxRadius = Math.hypot(crop.width + extraPad * 2, crop.height + extraPad * 2);
    const angleCount = 72;
    const candidates = [];
    const addCandidate = (rawX, rawY, kind = 'local', clearance = STRUCTURE_LABEL_CLEARANCE) => {
      const x = clamp(rawX, loX, hiX);
      const y = clamp(rawY, loY, hiY);
      if (Math.abs(x - rawX) > 0.5 || Math.abs(y - rawY) > 0.5) return;
      if (!labelRectFitsWhitespace(x, y, w, h, clearance)) return;
      const distance = Math.hypot(x - leaderLocal.x, y - leaderLocal.y);
      if (distance < Math.max(w, h) * 0.5) return;
      candidates.push({
        edge: classifyWhitespaceEdge(leaderLocal, { x, y }),
        freeform: kind === 'local',
        x,
        y,
        preferredX: x,
        preferredY: y,
        distance,
        score:
          distance * 12 +
          (kind === 'page-edge' ? 120 : 0)
      });
    };

    const baseRadius = Math.max(w, h) * 0.5 + targetGap;
    const searchWithClearance = (clearance) => {
      const before = candidates.length;
      for (let radius = baseRadius; radius <= maxRadius; radius += step) {
        for (let i = 0; i < angleCount; i++) {
          const angle = (Math.PI * 2 * i) / angleCount;
          addCandidate(
            leaderLocal.x + Math.cos(angle) * radius,
            leaderLocal.y + Math.sin(angle) * radius,
            'local',
            clearance
          );
        }
        const newCandidates = candidates.slice(before).filter((candidate) => candidate.distance <= radius + 0.5);
        if (newCandidates.length >= 3) return true;
      }
      return false;
    };

    searchWithClearance(STRUCTURE_LABEL_CLEARANCE) || searchWithClearance(Math.max(2, STRUCTURE_LABEL_CLEARANCE * 0.45));

    const sideGap = Math.max(MODEL_OUTSIDE_GAP, Math.min(28, fontSize * 0.9));
    addCandidate(modelBounds.minX - sideGap - w / 2, leaderLocal.y, 'page-edge');
    addCandidate(modelBounds.maxX + sideGap + w / 2, leaderLocal.y, 'page-edge');
    addCandidate(leaderLocal.x, modelBounds.minY - sideGap - h / 2, 'page-edge');
    addCandidate(leaderLocal.x, modelBounds.maxY + sideGap + h / 2, 'page-edge');

    return { candidates, step, bounds: { loX, hiX, loY, hiY } };
  };

  const pickOutsidePlacement = (leaderLocal, w, h, sourceFace = null) => {
    const { candidates, step, bounds } = findWhitespaceCandidates(leaderLocal, w, h, sourceFace);
    const nearestDistance = candidates.reduce((min, candidate) => Math.min(min, candidate.distance || Infinity), Infinity);
    const localBand = candidates.filter((candidate) => (candidate.distance || Infinity) <= nearestDistance + Math.max(8, step * 2));
    const best = (localBand.length ? localBand : candidates).sort((a, b) => a.score - b.score)[0];
    if (best) return best;

    const fallbackTargets = [
      { x: bounds.loX, y: clamp(leaderLocal.y, bounds.loY, bounds.hiY) },
      { x: bounds.hiX, y: clamp(leaderLocal.y, bounds.loY, bounds.hiY) },
      { x: clamp(leaderLocal.x, bounds.loX, bounds.hiX), y: bounds.loY },
      { x: clamp(leaderLocal.x, bounds.loX, bounds.hiX), y: bounds.hiY }
    ].sort((a, b) => Math.hypot(a.x - leaderLocal.x, a.y - leaderLocal.y) - Math.hypot(b.x - leaderLocal.x, b.y - leaderLocal.y))[0];
    return {
      edge: classifyWhitespaceEdge(leaderLocal, fallbackTargets),
      freeform: false,
      x: fallbackTargets.x,
      y: fallbackTargets.y,
      preferredX: fallbackTargets.x,
      preferredY: fallbackTargets.y,
      score: Infinity
    };
  };

  const orientation = (a, b, c) => ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  const segmentCrosses = (a, b, c, d) => {
    const shareEndpoint = Math.hypot(a.x - c.x, a.y - c.y) < 0.5 || Math.hypot(a.x - d.x, a.y - d.y) < 0.5 ||
      Math.hypot(b.x - c.x, b.y - c.y) < 0.5 || Math.hypot(b.x - d.x, b.y - d.y) < 0.5;
    if (shareEndpoint) return false;
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return (o1 * o2 < 0) && (o3 * o4 < 0);
  };

  const distributeSideLabels = (sideLabels) => {
    ['left', 'right', 'top', 'bottom'].forEach((side) => {
      const group = sideLabels.filter(lbl => lbl.edge === side && !lbl.freeform && !lbl.excluded);
      if (group.length < 2) return;
      const vertical = side === 'left' || side === 'right';
      const minCoord = vertical
        ? -extraPad + TEXT_EDGE_MARGIN + Math.max(...group.map(lbl => lbl.h / 2))
        : -extraPad + TEXT_EDGE_MARGIN + Math.max(...group.map(lbl => lbl.w / 2));
      const maxCoord = vertical
        ? crop.height + extraPad - TEXT_EDGE_MARGIN - Math.max(...group.map(lbl => lbl.h / 2))
        : crop.width + extraPad - TEXT_EDGE_MARGIN - Math.max(...group.map(lbl => lbl.w / 2));
      group.sort((a, b) => {
        const av = vertical ? a.leader.startY : a.leader.startX;
        const bv = vertical ? b.leader.startY : b.leader.startX;
        return av - bv;
      });

      group.forEach((lbl) => {
        const preferred = vertical ? lbl.preferredY : lbl.preferredX;
        lbl._axisCoord = clamp(preferred, Math.min(minCoord, maxCoord), Math.max(minCoord, maxCoord));
      });

      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const curr = group[i];
        const sep = vertical ? (prev.h + curr.h) / 2 + LABEL_CLEARANCE : (prev.w + curr.w) / 2 + LABEL_CLEARANCE;
        curr._axisCoord = Math.max(curr._axisCoord, prev._axisCoord + sep);
      }
      for (let i = group.length - 2; i >= 0; i--) {
        const next = group[i + 1];
        const curr = group[i];
        const sep = vertical ? (next.h + curr.h) / 2 + LABEL_CLEARANCE : (next.w + curr.w) / 2 + LABEL_CLEARANCE;
        curr._axisCoord = Math.min(curr._axisCoord, next._axisCoord - sep);
      }

      const overflowLow = minCoord - group[0]._axisCoord;
      const overflowHigh = group[group.length - 1]._axisCoord - maxCoord;
      const shift = overflowLow > 0 ? overflowLow : (overflowHigh > 0 ? -overflowHigh : 0);
      group.forEach((lbl) => {
        const coord = clamp(lbl._axisCoord + shift, Math.min(minCoord, maxCoord), Math.max(minCoord, maxCoord));
        if (vertical) lbl.y = coord;
        else lbl.x = coord;
      });
    });
  };

  const findOverlappingLabelFor = (label, excludeLabel = null) => {
    return labelsToDraw.find((other) => other !== label && other !== excludeLabel && !other.excluded && rectsOverlap(label, other, LABEL_CLEARANCE));
  };

  const findLocalWhitespaceRelocation = (label) => {
    const current = { x: label.x, y: label.y };
    const anchor = label.leader
      ? { x: label.leader.startX, y: label.leader.startY }
      : current;
    const minX = -extraPad + TEXT_EDGE_MARGIN + label.w / 2;
    const maxX = crop.width + extraPad - TEXT_EDGE_MARGIN - label.w / 2;
    const minY = -extraPad + TEXT_EDGE_MARGIN + label.h / 2;
    const maxY = crop.height + extraPad - TEXT_EDGE_MARGIN - label.h / 2;
    const loX = Math.min(minX, maxX);
    const hiX = Math.max(minX, maxX);
    const loY = Math.min(minY, maxY);
    const hiY = Math.max(minY, maxY);
    const step = Math.max(3, Math.min(7, Math.max(label.w, label.h) * 0.18));
    const maxRadius = Math.hypot(crop.width + extraPad * 2, crop.height + extraPad * 2);
    const angleCount = 72;
    const candidates = [];

    const addCandidate = (rawX, rawY, clearance = STRUCTURE_LABEL_CLEARANCE) => {
      const x = clamp(rawX, loX, hiX);
      const y = clamp(rawY, loY, hiY);
      if (Math.abs(x - rawX) > 0.5 || Math.abs(y - rawY) > 0.5) return;
      if (!labelRectFitsWhitespace(x, y, label.w, label.h, clearance)) return;
      const probe = { ...label, x, y };
      if (findOverlappingLabelFor(probe, label)) return;
      candidates.push({
        x,
        y,
        edge: classifyWhitespaceEdge(anchor, { x, y }),
        freeform: true,
        preferredX: x,
        preferredY: y,
        score:
          Math.hypot(x - current.x, y - current.y) * 12 +
          Math.max(0, Math.hypot(x - anchor.x, y - anchor.y) - Math.hypot(current.x - anchor.x, current.y - anchor.y)) * 1.5
      });
    };

    for (const clearance of [STRUCTURE_LABEL_CLEARANCE, Math.max(2, STRUCTURE_LABEL_CLEARANCE * 0.45)]) {
      for (let radius = step; radius <= maxRadius; radius += step) {
        for (let i = 0; i < angleCount; i++) {
          const angle = (Math.PI * 2 * i) / angleCount;
          addCandidate(
            current.x + Math.cos(angle) * radius,
            current.y + Math.sin(angle) * radius,
            clearance
          );
        }
        if (candidates.length) return candidates.sort((a, b) => a.score - b.score)[0];
      }
    }

    return null;
  };

  const applySecondPassLabelCorrection = () => {
    const movable = labelsToDraw.filter((label) => label.edge !== null && label.leader && !label.excluded);
    for (let pass = 0; pass < 4; pass++) {
      let movedAny = false;
      for (const label of movable) {
        if (!findOverlappingLabelFor(label)) continue;
        const next = findLocalWhitespaceRelocation(label);
        if (!next) continue;
        label.x = next.x;
        label.y = next.y;
        label.edge = next.edge;
        label.freeform = next.freeform;
        label.preferredX = next.preferredX;
        label.preferredY = next.preferredY;
        movedAny = true;
      }
      if (!movedAny) break;
    }
  };

  const getPlacementSnapshot = (label) => ({
    x: label.x,
    y: label.y,
    edge: label.edge,
    freeform: label.freeform,
    preferredX: label.preferredX,
    preferredY: label.preferredY
  });

  const setPlacementSnapshot = (label, placement) => {
    label.x = placement.x;
    label.y = placement.y;
    label.edge = placement.edge;
    label.freeform = placement.freeform;
    label.preferredX = Number.isFinite(placement.preferredX) ? placement.preferredX : placement.x;
    label.preferredY = Number.isFinite(placement.preferredY) ? placement.preferredY : placement.y;
  };

  const getLeaderStartPoint = (label) => {
    if (!label || !label.leader || label.excluded) return null;
    return { x: label.leader.startX, y: label.leader.startY };
  };

  const doLeaderLinesCross = (a, b) => {
    const aStart = getLeaderStartPoint(a);
    const bStart = getLeaderStartPoint(b);
    if (!aStart || !bStart) return false;
    return segmentCrosses(aStart, { x: a.x, y: a.y }, bStart, { x: b.x, y: b.y });
  };

  const countLeaderLineCrossings = (labels) => {
    let count = 0;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        if (doLeaderLinesCross(labels[i], labels[j])) count++;
      }
    }
    return count;
  };

  const canSwapLabelPlacements = (a, b) => {
    const aPlacement = getPlacementSnapshot(a);
    const bPlacement = getPlacementSnapshot(b);
    if (!labelRectFitsWhitespace(bPlacement.x, bPlacement.y, a.w, a.h, STRUCTURE_LABEL_CLEARANCE)) return false;
    if (!labelRectFitsWhitespace(aPlacement.x, aPlacement.y, b.w, b.h, STRUCTURE_LABEL_CLEARANCE)) return false;

    setPlacementSnapshot(a, bPlacement);
    setPlacementSnapshot(b, aPlacement);
    const overlaps = findOverlappingLabelFor(a) || findOverlappingLabelFor(b);
    setPlacementSnapshot(a, aPlacement);
    setPlacementSnapshot(b, bPlacement);
    return !overlaps;
  };

  const applyThirdPassLineSwapCorrection = () => {
    const movable = labelsToDraw.filter((label) => label.edge !== null && label.leader && !label.excluded);
    if (movable.length < 2) return;

    const nearLimit = Math.max(70, Math.min(220, Math.max(crop.width, crop.height) * 0.24));
    for (let pass = 0; pass < 8; pass++) {
      let swappedAny = false;
      for (let i = 0; i < movable.length; i++) {
        for (let j = i + 1; j < movable.length; j++) {
          const a = movable[i];
          const b = movable[j];
          if (!doLeaderLinesCross(a, b)) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) > nearLimit) continue;
          if (!canSwapLabelPlacements(a, b)) continue;

          const before = countLeaderLineCrossings(movable);
          const aPlacement = getPlacementSnapshot(a);
          const bPlacement = getPlacementSnapshot(b);
          setPlacementSnapshot(a, bPlacement);
          setPlacementSnapshot(b, aPlacement);
          const after = countLeaderLineCrossings(movable);

          if (after < before) {
            swappedAny = true;
          } else {
            setPlacementSnapshot(a, aPlacement);
            setPlacementSnapshot(b, bPlacement);
          }
        }
      }
      if (!swappedAny) break;
    }
  };

  const getLeaderSegment = (label) => {
    const start = getLeaderStartPoint(label);
    if (!start) return null;
    return { start, end: { x: label.x, y: label.y } };
  };

  const pointToSegmentDistance = (point, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-6) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1);
    return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
  };

  const getLabelLineConflictScore = (label, x = label.x, y = label.y) => {
    const probe = { ...label, x, y };
    const center = { x, y };
    return labelsToDraw.reduce((score, other) => {
      if (!other || other === label || other.excluded) return score;
      const segment = getLeaderSegment(other);
      if (!segment) return score;
      const intersects = segmentIntersectsLabelRect(segment.start, segment.end, probe, 0.75);
      const distance = pointToSegmentDistance(center, segment.start, segment.end);
      return score + (intersects ? 10000 : 0) + Math.max(0, 18 - distance);
    }, 0);
  };

  const findSmallLineAvoidanceNudge = (label) => {
    const currentScore = getLabelLineConflictScore(label);
    if (currentScore <= 0) return null;

    const minX = -extraPad + TEXT_EDGE_MARGIN + label.w / 2;
    const maxX = crop.width + extraPad - TEXT_EDGE_MARGIN - label.w / 2;
    const minY = -extraPad + TEXT_EDGE_MARGIN + label.h / 2;
    const maxY = crop.height + extraPad - TEXT_EDGE_MARGIN - label.h / 2;
    const loX = Math.min(minX, maxX);
    const hiX = Math.max(minX, maxX);
    const loY = Math.min(minY, maxY);
    const hiY = Math.max(minY, maxY);
    const relaxedClearance = Math.max(2, STRUCTURE_LABEL_CLEARANCE * 0.45);
    const step = Math.max(2, Math.min(4, fontSize * 0.16));
    const maxRadius = Math.max(12, Math.min(32, fontSize * 1.4));
    const angleCount = 24;
    let best = null;

    const tryCandidate = (rawX, rawY) => {
      const x = clamp(rawX, loX, hiX);
      const y = clamp(rawY, loY, hiY);
      if (Math.abs(x - rawX) > 0.5 || Math.abs(y - rawY) > 0.5) return;
      if (!labelRectFitsWhitespace(x, y, label.w, label.h, relaxedClearance)) return;
      const probe = { ...label, x, y };
      if (findOverlappingLabelFor(probe, label)) return;

      const conflictScore = getLabelLineConflictScore(label, x, y);
      if (conflictScore > currentScore - 0.1) return;
      const moveDistance = Math.hypot(x - label.x, y - label.y);
      const score = conflictScore * 100 + moveDistance;
      if (!best || score < best.score) {
        best = {
          x,
          y,
          edge: classifyWhitespaceEdge(getLeaderStartPoint(label) || label, { x, y }),
          freeform: true,
          preferredX: x,
          preferredY: y,
          score
        };
      }
    };

    for (let radius = step; radius <= maxRadius; radius += step) {
      for (let i = 0; i < angleCount; i++) {
        const angle = (Math.PI * 2 * i) / angleCount;
        tryCandidate(
          label.x + Math.cos(angle) * radius,
          label.y + Math.sin(angle) * radius
        );
      }
      if (best && best.score < currentScore * 100) return best;
    }

    return best;
  };

  const applyFourthPassLineAvoidanceCorrection = () => {
    const movable = labelsToDraw.filter((label) => label.edge !== null && label.leader && !label.excluded);
    for (let pass = 0; pass < 5; pass++) {
      let movedAny = false;
      for (const label of movable) {
        const next = findSmallLineAvoidanceNudge(label);
        if (!next) continue;
        setPlacementSnapshot(label, next);
        movedAny = true;
      }
      if (!movedAny) break;
    }
  };

  (state.facesData || []).forEach((face, idx) => {
    if (autoExcluded.has(idx)) return;
    if (isObstacleFaceForLabels(face)) return;

    const faceSig = getLocalFaceSignatureReport(face.points);
    const isExcluded = (typeof window.reportExcludedSignatures !== 'undefined' && window.reportExcludedSignatures.has(faceSig));

    const areaPx = Math.abs(getSignedArea(face.points));
    const areaM2 = areaPx * (metersPerPx * metersPerPx);

    const riseExact = getRise12(face);
    const riseExactSafe = Number.isFinite(riseExact) ? riseExact : 0;

    const pitchExactText = `${(Math.round(riseExactSafe * 10) / 10).toFixed(1)}`;
    const pitchText = `${Math.round(riseExactSafe)}`;

    const pitchDeg = Math.atan((Math.abs(riseExactSafe) / 12)) * (180 / Math.PI);
    const areaText = `${Math.round((areaM2 / Math.cos(pitchDeg * (Math.PI / 180))) * 10.7639)}`;

    let placementHoles = [...(face.holes || [])];
    const currentLayer = face.layer || 1;

    (state.facesData || []).forEach((other, otherIdx) => {
        if (other === face) return;
        if (autoExcluded.has(otherIdx)) return;
        const otherLayer = other.layer || 1;

        const overlapRatio = estimateReportFacetOverlapRatio(face, other);
        const blocksByOverlap = (otherLayer >= currentLayer) && overlapRatio > 0.01;
        const blocksByContain = isPolygonContained(other.points, face.points);

        if (blocksByContain || blocksByOverlap) placementHoles.push(other.points);
    });

    const pole = getPoleOfInaccessibility(face.points, placementHoles, 1.0);

    const textWidth = Math.max(ctx.measureText(pitchText).width, ctx.measureText(areaText).width) + fontSize * 0.3;
    const textHeight = fontSize * 0.75;

    let lx = pole.x - crop.minX;
    let ly = pole.y - crop.minY;

    let lined = false;
    let leader = null;
    let edge = null;
    let freeform = false;
    let preferredX = lx;
    let preferredY = ly;

    const centroid = getPolygonCentroid(face.points);
    const onFacePlacement = findBestOnFacePlacement(face, placementHoles, pole, centroid, textWidth, textHeight);

    if (onFacePlacement) {
      lx = onFacePlacement.x;
      ly = onFacePlacement.y;
    } else {
      lined = true;

      let leaderLocal = getLeaderStart(face, placementHoles, pole, null);
      let placement = pickOutsidePlacement(leaderLocal, textWidth, textHeight, face);
      leaderLocal = getLeaderStart(face, placementHoles, pole, { x: placement.x, y: placement.y });
      placement = pickOutsidePlacement(leaderLocal, textWidth, textHeight, face);
      lx = placement.x;
      ly = placement.y;
      edge = placement.edge;
      freeform = !!placement.freeform;
      leader = { startX: leaderLocal.x, startY: leaderLocal.y };
      preferredX = placement.preferredX;
      preferredY = placement.preferredY;
    }

    const id = `f_${currentLayer}_${idx}_${Math.floor(Math.random() * 1e9)}`;

    labelsToDraw.push({
      id,
      layer: currentLayer,
      faceSignature: faceSig,
      excluded: isExcluded,

      pitchExact: riseExactSafe,
      pitchExactText,

      pitchText,
      areaText,
      text: pitchText,

      x: lx,
      y: ly,

      anchorX: clamp(getPolygonCentroid(face.points).x - crop.minX, 0, crop.width),
      anchorY: clamp(getPolygonCentroid(face.points).y - crop.minY, 0, crop.height),

      lined,
      leader,
      edge,
      freeform,
      preferredX: Number.isFinite(preferredX) ? preferredX : lx,
      preferredY: Number.isFinite(preferredY) ? preferredY : ly,
      w: textWidth,
      h: textHeight
    });
  });

  const routedLabels = labelsToDraw.filter(l => l.edge !== null && !l.excluded);
  if (routedLabels.length > 0) {
    const requestedPad = Math.max(0, Number(state.editorCropPadding) || 0);
    const targetPad = getRecommendedAutoLabelPadding(state, routedLabels.length);
    if (state._editorCropPaddingManual !== true && requestedPad !== targetPad) {
      state.editorCropPadding = targetPad;
      state._editorCropPaddingAuto = true;
      return buildDefaultDiagramLabels(state, placementOptions);
    }
  }

  const edgeLabels = routedLabels.filter(label => !label.freeform);
  distributeSideLabels(edgeLabels);
  if (placementOptions.secondPass) {
    applySecondPassLabelCorrection();
  }

  for (let pass = 0; pass < 90; pass++) {
    let totalMotion = 0;

    for (let i = 0; i < edgeLabels.length; i++) {
      for (let j = i + 1; j < edgeLabels.length; j++) {
        const a = edgeLabels[i];
        const b = edgeLabels[j];
        if (!rectsOverlap(a, b, LABEL_CLEARANCE)) continue;

        const ar = getLabelRect(a, LABEL_CLEARANCE);
        const br = getLabelRect(b, LABEL_CLEARANCE);
        const overlapX = Math.min(ar.r, br.r) - Math.max(ar.l, br.l);
        const overlapY = Math.min(ar.b, br.b) - Math.max(ar.t, br.t);
        const sameVerticalSide = (a.edge === b.edge) && (a.edge === 'left' || a.edge === 'right');
        const sameHorizontalSide = (a.edge === b.edge) && (a.edge === 'top' || a.edge === 'bottom');

        if (sameVerticalSide || (!sameHorizontalSide && overlapY <= overlapX)) {
          const sign = (a.y <= b.y) ? -1 : 1;
          const move = Math.max(0.5, overlapY / 2);
          a.y += sign * move;
          b.y -= sign * move;
          totalMotion += move * 2;
        } else {
          const sign = (a.x <= b.x) ? -1 : 1;
          const move = Math.max(0.5, overlapX / 2);
          a.x += sign * move;
          b.x -= sign * move;
          totalMotion += move * 2;
        }
      }
    }

    edgeLabels.forEach((lbl) => {
      if (lbl.edge === 'left' || lbl.edge === 'right') {
        lbl.x += (lbl.preferredX - lbl.x) * 0.12;
      } else {
        lbl.y += (lbl.preferredY - lbl.y) * 0.12;
      }
      clampLabelToBounds(lbl);
    });

    distributeSideLabels(edgeLabels);
    if (totalMotion < 0.1) break;
  }

  if (placementOptions.thirdPass) {
    applyThirdPassLineSwapCorrection();
  }
  if (placementOptions.fourthPass) {
    applyFourthPassLineAvoidanceCorrection();
  }

  labelsToDraw.forEach(lbl => {
    clampLabelToBounds(lbl);
    delete lbl._axisCoord;
  });

  return labelsToDraw;
}
window.buildDefaultDiagramLabels = buildDefaultDiagramLabels;



// -----------------------------
// PDF TRIGGER
// -----------------------------


function getMissingRequiredGutterStories(state) {
    if (!state) return [];
    if (!shouldIncludeGutters(state)) return [];
    try {
        const metrics = buildGutterMetrics(state);
        return Array.isArray(metrics?.missingStories) ? metrics.missingStories : [];
    } catch (e) {
        console.warn('[Gutters] Failed to evaluate required stories:', e);
        return [];
    }
}

async function renderLegacyFinalizeChecklistPage(container) {
    const state = reportConfigState;
    if (!state) return;

    if (!state.finalizeChecklist) state.finalizeChecklist = {};
    if (!state.finalizeSources) state.finalizeSources = { images: [], notes: '' };
    if (typeof state.finalizeSourcesConfirmed !== 'boolean') state.finalizeSourcesConfirmed = false;
    const qaPdfReviewMode = isQaPortalPdfReviewMode();

    // ── Category cards ──
    let gridHtml = '';
    FINALIZE_CATEGORIES.forEach((cat, idx) => {
        const checked = !!state.finalizeChecklist[cat.key];
        let itemsHtml = cat.items.map(item => {
            const txt = typeof item === 'string' ? item : item.text;
            const tip = typeof item === 'string' ? '' : (item.tooltip || '');
            return `<div class="fin-card-item" ${tip ? `data-tip="${escapeHtml(tip)}"` : ''}>${escapeHtml(txt)}</div>`;
        }).join('');

        gridHtml += `
            <div class="fin-card ${checked ? 'checked' : ''}" data-cat="${cat.key}">
                <div class="fin-card-body">
                    <div class="fin-card-title">
                        <span class="fin-card-num">${idx + 1}</span>
                        ${escapeHtml(cat.title)}
                    </div>
                    <div class="fin-card-items">${itemsHtml}</div>
                </div>
                <div class="fin-card-check">
                    <div class="fin-card-check-icon"><i class="fas fa-check"></i></div>
                </div>
            </div>
        `;
    });

    // Progress dots
    let dotsHtml = '';
    FINALIZE_CATEGORIES.forEach(cat => {
        dotsHtml += `<div class="fin-dot ${state.finalizeChecklist[cat.key] ? 'done' : ''}" data-dot="${cat.key}"></div>`;
    });
    if (!qaPdfReviewMode) {
        dotsHtml += `<div class="fin-dot ${state.finalizeSourcesConfirmed ? 'done' : ''}" data-dot="sources"></div>`;
    }

    // Source thumbnails
    let thumbsHtml = '';
    (state.finalizeSources.images || []).forEach((img, idx) => {
        thumbsHtml += `
            <div class="fin-src-thumb" style="background-image:url(${img.dataUrl});">
                <div class="fin-src-thumb-rm" data-rm-idx="${idx}" title="Remove">×</div>
            </div>`;
    });

    const guttersRequired = shouldIncludeGutters(state);
    const missingGutterStories = getMissingRequiredGutterStories(state);
    const storiesReady = !guttersRequired || missingGutterStories.length === 0;
    const srcChecked = qaPdfReviewMode ? true : state.finalizeSourcesConfirmed;
    const allDone = FINALIZE_CATEGORIES.every(c => !!state.finalizeChecklist[c.key]) && srcChecked && storiesReady;
    const storiesHint = storiesReady
        ? 'All gutter stories are filled in.'
        : `Set stories for ${missingGutterStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} before submission.`;

    container.innerHTML = `
        <div class="fin-wrap">
            <div class="fin-head">
                <h2>Pre-Submission Checklist</h2>
                <div class="fin-dots">${dotsHtml}</div>
            </div>

            <div class="fin-grid">${gridHtml}</div>

            ${qaPdfReviewMode ? '' : `<div class="fin-src ${srcChecked ? 'checked' : ''}" id="finSrcCard">
                <div class="fin-src-body">
                    <div class="fin-src-label">
                        <i class="fas fa-paperclip"></i>
                        Sources & Notes
                        <span class="fin-src-hint">— upload all references and describe methodology</span>
                    </div>
                    <div class="fin-src-row">
                        <div class="fin-src-upload" id="srcUploadArea">
                            <i class="fas fa-cloud-upload-alt"></i>
                            <span>Images</span>
                        </div>
                        <input type="file" id="srcFileInput" multiple accept="image/*" style="display:none;">
                        <textarea class="fin-src-notes" id="srcNotesArea"
                            placeholder="e.g. Pitch verified via Street View, chimney dims from site photos…"
                        >${escapeHtml(state.finalizeSources.notes || '')}</textarea>
                    </div>
                    <div class="fin-src-thumbs" id="srcThumbs">${thumbsHtml}</div>
                </div>
                <div class="fin-src-check" id="srcCheckZone">
                    <div class="fin-src-check-icon"><i class="fas fa-check"></i></div>
                </div>
            </div>`}

            ${guttersRequired ? `
                <div id="finGutterStoriesReq" style="margin:0 0 8px 0; padding:10px 12px; border:1px solid ${storiesReady ? '#c5d8c9' : '#f2c6c2'}; background:${storiesReady ? '#f7fbf8' : '#fff5f5'}; border-radius:10px; font-size:12px; color:${storiesReady ? '#188038' : '#b3261e'}; font-weight:700;">
                    Gutter stories requirement: ${storiesHint}
                </div>
            ` : ''}

            <div class="fin-submit-area">
                <button class="fin-submit-btn ${allDone ? 'enabled' : 'disabled'}" id="finalSubmitBtn" ${allDone ? '' : 'disabled'}>
                    <i class="fas fa-file-pdf"></i> Submit PDF
                </button>
                <div class="fin-submit-hint">${allDone ? 'All checks passed — ready to submit!' : 'Complete all items to enable submission.'}</div>
            </div>
        </div>
    `;

    // ── Behavior ──

    const refreshUI = () => {
        const currentGuttersRequired = shouldIncludeGutters(state);
        const currentMissingStories = getMissingRequiredGutterStories(state);
        const currentStoriesReady = !currentGuttersRequired || currentMissingStories.length === 0;
        const done = FINALIZE_CATEGORIES.every(c => !!state.finalizeChecklist[c.key]) && (qaPdfReviewMode || state.finalizeSourcesConfirmed) && currentStoriesReady;
        const btn = container.querySelector('#finalSubmitBtn');
        const hint = container.querySelector('.fin-submit-hint');
        const reqBox = container.querySelector('#finGutterStoriesReq');
        if (btn) {
            btn.disabled = !done;
            btn.className = 'fin-submit-btn ' + (done ? 'enabled' : 'disabled');
        }
        if (hint) hint.textContent = done ? 'All checks passed — ready to submit!' : 'Complete all items to enable submission.';

        if (hint) {
            hint.textContent = done
                ? 'All checks passed â€” ready to submit!'
                : (currentStoriesReady ? 'Complete all items to enable submission.' : 'Fill in all gutter stories to enable submission.');
        }
        if (hint && done) {
            hint.textContent = 'All checks passed - ready to submit!';
        }
        if (reqBox && currentGuttersRequired) {
            reqBox.style.borderColor = currentStoriesReady ? '#c5d8c9' : '#f2c6c2';
            reqBox.style.background = currentStoriesReady ? '#f7fbf8' : '#fff5f5';
            reqBox.style.color = currentStoriesReady ? '#188038' : '#b3261e';
            reqBox.textContent = currentStoriesReady
                ? 'Gutter stories requirement: All gutter stories are filled in.'
                : `Gutter stories requirement: Set stories for ${currentMissingStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} before submission.`;
        }

        // Dots
        FINALIZE_CATEGORIES.forEach(cat => {
            const dot = container.querySelector(`[data-dot="${cat.key}"]`);
            if (dot) dot.classList.toggle('done', !!state.finalizeChecklist[cat.key]);
        });
        const srcDot = container.querySelector('[data-dot="sources"]');
        if (srcDot) srcDot.classList.toggle('done', state.finalizeSourcesConfirmed);
    };

    // Category card clicks
    container.querySelectorAll('.fin-card[data-cat]').forEach(card => {
        card.addEventListener('click', (e) => {
            // Don't toggle if clicking inside an interactive child (shouldn't have any, but safety)
            if (e.target.closest('input, textarea, button, a')) return;
            const key = card.getAttribute('data-cat');
            state.finalizeChecklist[key] = !state.finalizeChecklist[key];
            card.classList.toggle('checked', state.finalizeChecklist[key]);
            refreshUI();
        });
    });

    // Source check zone (the right-side checkmark area)
    const srcCheckZone = container.querySelector('#srcCheckZone');
    const finSrcCard = container.querySelector('#finSrcCard');
    if (srcCheckZone) {
        srcCheckZone.addEventListener('click', (e) => {
            e.stopPropagation();
            state.finalizeSourcesConfirmed = !state.finalizeSourcesConfirmed;
            if (finSrcCard) finSrcCard.classList.toggle('checked', state.finalizeSourcesConfirmed);
            refreshUI();
        });
    }

    // Notes
    const notesArea = container.querySelector('#srcNotesArea');
    if (notesArea) {
        notesArea.addEventListener('input', () => { state.finalizeSources.notes = notesArea.value; });
        // Prevent card toggle when interacting with textarea
        notesArea.addEventListener('click', (e) => e.stopPropagation());
    }

    // Image upload
    const uploadArea = container.querySelector('#srcUploadArea');
    const fileInput = container.querySelector('#srcFileInput');
    const thumbsContainer = container.querySelector('#srcThumbs');

    const rebuildThumbs = () => {
        if (!thumbsContainer) return;
        thumbsContainer.innerHTML = '';
        (state.finalizeSources.images || []).forEach((img, idx) => {
            const t = document.createElement('div');
            t.className = 'fin-src-thumb';
            t.style.backgroundImage = `url(${img.dataUrl})`;
            t.innerHTML = `<div class="fin-src-thumb-rm" title="Remove">×</div>`;
            t.querySelector('.fin-src-thumb-rm').addEventListener('click', (e) => {
                e.stopPropagation();
                state.finalizeSources.images.splice(idx, 1);
                rebuildThumbs();
            });
            thumbsContainer.appendChild(t);
        });
    };

    const processFiles = (files) => {
        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                state.finalizeSources.images.push({ dataUrl: ev.target.result, name: file.name, size: file.size });
                rebuildThumbs();
            };
            reader.readAsDataURL(file);
        });
    };

    if (uploadArea && fileInput) {
        uploadArea.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#1a73e8'; uploadArea.style.background = '#f5f9ff'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; uploadArea.style.background = ''; });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault(); uploadArea.style.borderColor = ''; uploadArea.style.background = '';
            if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', () => { if (fileInput.files.length) processFiles(fileInput.files); fileInput.value = ''; });
    }

    // Existing thumb remove buttons
    container.querySelectorAll('.fin-src-thumb-rm[data-rm-idx]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.finalizeSources.images.splice(parseInt(btn.getAttribute('data-rm-idx')), 1);
            rebuildThumbs();
        });
    });

    // Submit
    const submitBtn = container.querySelector('#finalSubmitBtn');
    if (submitBtn) submitBtn.addEventListener('click', () => { if (!submitBtn.disabled) submitFinalReport(); });
    refreshUI();
}

const QA_PDF_REVIEW_ITEMS = [
    { key: 'roof_shapes', label: 'Roof Shapes' },
    { key: 'correct_pitches', label: 'Correct Pitches' },
    { key: 'line_types', label: 'Line types' },
    { key: 'diagram_labels', label: 'Diagram Labels' }
];

function isQaPortalPdfReviewMode() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        return params.has('qa_embed') || params.has('qa_feedback_editor');
    } catch (e) {
        return false;
    }
}

function isQaFixOnlyMode() {
    if (typeof window.FIRSTMEASURE_QA_FIX_ONLY_MODE !== 'undefined') {
        return !!window.FIRSTMEASURE_QA_FIX_ONLY_MODE;
    }
    try {
        const params = new URLSearchParams(window.location.search || '');
        const raw = params.get('qa_fix_only') || params.get('fix_only') || '';
        window.FIRSTMEASURE_QA_FIX_ONLY_MODE = raw === '1' || raw === 'true' || raw === 'yes';
        return window.FIRSTMEASURE_QA_FIX_ONLY_MODE;
    } catch (e) {
        window.FIRSTMEASURE_QA_FIX_ONLY_MODE = false;
        return false;
    }
}

function ensureQaPdfReviewState(state) {
    if (!state.qaPdfReview || typeof state.qaPdfReview !== 'object') state.qaPdfReview = {};
    QA_PDF_REVIEW_ITEMS.forEach((item) => {
        if (!state.qaPdfReview[item.key] || typeof state.qaPdfReview[item.key] !== 'object') {
            state.qaPdfReview[item.key] = { status: '', comment: '' };
        }
        if (typeof state.qaPdfReview[item.key].comment !== 'string') state.qaPdfReview[item.key].comment = '';
        if (!['pass', 'fail'].includes(state.qaPdfReview[item.key].status)) state.qaPdfReview[item.key].status = '';
    });
    return state.qaPdfReview;
}

function renderQaPdfReviewHtml(state) {
    const review = ensureQaPdfReviewState(state);
    const itemsHtml = QA_PDF_REVIEW_ITEMS.map((item) => {
        const value = review[item.key] || {};
        const status = value.status || '';
        return `
            <div class="qa-pdf-check ${status}" data-qa-review="${item.key}">
                <div class="qa-pdf-check-label">${escapeHtml(item.label)}</div>
                <div class="qa-pdf-check-actions">
                    <button type="button" class="qa-pdf-mark pass ${status === 'pass' ? 'active' : ''}" data-value="pass" title="Pass">
                        <i class="fas fa-check"></i>
                    </button>
                    <button type="button" class="qa-pdf-mark fail ${status === 'fail' ? 'active' : ''}" data-value="fail" title="Fail">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <textarea class="qa-pdf-comment" placeholder="Required comment for this issue...">${escapeHtml(value.comment || '')}</textarea>
            </div>
        `;
    }).join('');

    return `
        <div class="qa-pdf-review-panel" id="qaPdfReviewPanel">
            <div class="qa-pdf-review-grid">${itemsHtml}</div>
            <div class="qa-pdf-review-actions">
                <button class="fin-submit-btn qa-sendback disabled" id="qaPdfSendBackBtn" disabled>
                    <i class="fas fa-undo"></i> Request Tech Correction
                </button>
                <button class="fin-submit-btn qa-correct disabled" id="qaPdfCorrectApproveBtn" disabled>
                    <i class="fas fa-tools"></i> Correct and Approve
                </button>
                <button class="fin-submit-btn qa-approve disabled" id="qaPdfApproveBtn" disabled>
                    <i class="fas fa-check"></i> Approve Without Changes
                </button>
            </div>
        </div>
    `;
}

function resolveQaSubmissionSourceUrl(rawUrl, state) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return '';
    if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
    if (raw.startsWith('/')) {
        try { return new URL(raw, window.location.origin).href; } catch (e) { return raw; }
    }
    const folderId = String(state?.folderId || window.currentProjectId || '').trim();
    if (folderId && typeof window.firstMeasureBuildUrl === 'function') {
        return window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(folderId)}/artifacts/${encodeURIComponent(raw)}`);
    }
    return raw;
}

function normalizeQaSubmissionSourcesForReview(state) {
    const candidates = [
        window.currentProjectLoadedAppMetadata?.submission_sources,
        window.currentProjectManifest?.submission_sources,
        state?.submission_sources,
        state?.finalizeSources,
        window.currentProjectLoadedAppMetadata?.pdfConfig?.finalizeSources
    ];
    const source = candidates.find((item) => item && typeof item === 'object') || {};
    const notes = String(source.notes || '').trim();
    const images = Array.isArray(source.images) ? source.images.map((entry, index) => {
        const image = entry && typeof entry === 'object' ? entry : { url: entry };
        const rawUrl = String(image.url || image.file_name || image.name || image.filename || image.dataUrl || '').trim();
        const url = resolveQaSubmissionSourceUrl(rawUrl, state);
        if (!url) return null;
        return {
            url,
            title: String(image.original_name || image.name || image.file_name || image.filename || `Reference ${index + 1}`),
            notes
        };
    }).filter(Boolean) : [];
    return {
        notes,
        images,
        submitted_at: String(source.submitted_at || ''),
        submitted_by: String(source.submitted_by || '')
    };
}

function renderQaSubmissionSourcesReviewHtml(state) {
    const sources = normalizeQaSubmissionSourcesForReview(state);
    const hasNotes = !!sources.notes;
    const hasImages = sources.images.length > 0;
    const meta = sources.submitted_at
        ? `Submitted ${sources.submitted_at}${sources.submitted_by ? ` by ${sources.submitted_by}` : ''}`
        : (sources.submitted_by ? `Submitted by ${sources.submitted_by}` : (hasImages ? `${sources.images.length} image${sources.images.length === 1 ? '' : 's'}` : ''));

    return `
        <div class="qa-src-review" id="qaSrcReviewCard">
            <div class="qa-src-review-head">
                <div class="qa-src-review-title"><i class="fas fa-paperclip"></i> Technician References</div>
                ${meta ? `<div class="qa-src-review-meta">${escapeHtml(meta)}</div>` : ''}
            </div>
            ${(!hasNotes && !hasImages) ? '<div class="qa-src-review-empty">No technician notes or reference images were provided.</div>' : `
                <div class="qa-src-review-body">
                    ${hasNotes ? `<button type="button" class="qa-src-review-notes-btn" data-qa-src-notes><i class="fas fa-note-sticky"></i><span>Notes</span></button>` : ''}
                    ${hasImages ? `<div class="qa-src-review-thumbs">${sources.images.map((img, idx) => `
                        <button type="button" class="qa-src-review-thumb" data-qa-src-index="${idx}" title="${escapeHtml(img.title)}">
                            <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.title)}">
                            <span>${idx + 1}</span>
                        </button>
                    `).join('')}</div>` : '<div class="qa-src-review-empty">Technician notes attached.</div>'}
                </div>
            `}
            <div class="qa-src-modal" id="qaSrcReviewModal" aria-hidden="true">
                <button type="button" class="qa-src-modal-close" data-qa-src-close title="Close"><i class="fas fa-times"></i></button>
                <div class="qa-src-modal-shell">
                    <div class="qa-src-modal-main">
                        <div class="qa-src-modal-stage">
                            <button type="button" class="qa-src-modal-nav prev" data-qa-src-prev title="Previous"><i class="fas fa-chevron-left"></i></button>
                            <img class="qa-src-modal-img" alt="Reference image">
                            <button type="button" class="qa-src-modal-nav next" data-qa-src-next title="Next"><i class="fas fa-chevron-right"></i></button>
                        </div>
                        <div class="qa-src-modal-rail"></div>
                    </div>
                    <div class="qa-src-modal-info">
                        <div class="qa-src-modal-title"><span data-qa-src-title>Technician Reference</span><span class="qa-src-modal-count" data-qa-src-count></span></div>
                        <div class="qa-src-modal-notes" data-qa-src-modal-notes></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function wireQaSubmissionSourcesReview(container, state) {
    const card = container.querySelector('#qaSrcReviewCard');
    if (!card) return;
    const sources = normalizeQaSubmissionSourcesForReview(state);
    const items = sources.images.length ? sources.images : (sources.notes ? [{ url: '', title: 'Technician Notes', notes: sources.notes }] : []);
    const modal = card.querySelector('#qaSrcReviewModal');
    if (!modal || !items.length) return;
    document.body.querySelectorAll(':scope > #qaSrcReviewModal').forEach((staleModal) => {
        if (staleModal !== modal) staleModal.remove();
    });
    let index = 0;
    const render = () => {
        const item = items[index] || {};
        const image = modal.querySelector('.qa-src-modal-img');
        const title = modal.querySelector('[data-qa-src-title]');
        const count = modal.querySelector('[data-qa-src-count]');
        const notes = modal.querySelector('[data-qa-src-modal-notes]');
        const rail = modal.querySelector('.qa-src-modal-rail');
        if (image) {
            image.src = item.url || '';
            image.classList.toggle('empty', !item.url);
        }
        if (title) title.textContent = item.title || 'Technician Reference';
        if (count) count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
        if (notes) {
            const noteText = String(item.notes || sources.notes || '').trim();
            notes.textContent = noteText || 'No notes provided.';
            notes.classList.toggle('empty', !noteText);
        }
        modal.querySelectorAll('.qa-src-modal-nav').forEach((btn) => { btn.disabled = items.length <= 1; });
        if (rail) {
            rail.innerHTML = items.length > 1 ? items.map((entry, idx) => `
                <button type="button" class="qa-src-modal-thumb ${idx === index ? 'active' : ''}" data-qa-src-modal-index="${idx}" title="${escapeHtml(entry.title || '')}">
                    <img src="${escapeHtml(entry.url || '')}" alt="">
                </button>
            `).join('') : '';
            rail.querySelectorAll('[data-qa-src-modal-index]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    index = Number(btn.getAttribute('data-qa-src-modal-index') || 0);
                    render();
                });
            });
        }
    };
    const open = (nextIndex) => {
        index = Math.max(0, Math.min(items.length - 1, Number(nextIndex) || 0));
        render();
        if (modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
    };
    const close = () => {
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
    };
    const step = (delta) => {
        if (items.length <= 1) return;
        index = (index + delta + items.length) % items.length;
        render();
    };
    card.querySelectorAll('[data-qa-src-index]').forEach((btn) => {
        btn.addEventListener('click', () => open(Number(btn.getAttribute('data-qa-src-index') || 0)));
    });
    card.querySelector('[data-qa-src-notes]')?.addEventListener('click', () => open(0));
    modal.querySelector('[data-qa-src-close]')?.addEventListener('click', close);
    modal.querySelector('[data-qa-src-prev]')?.addEventListener('click', () => step(-1));
    modal.querySelector('[data-qa-src-next]')?.addEventListener('click', () => step(1));
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    window.addEventListener('keydown', (event) => {
        if (!modal.classList.contains('show')) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    });
}

function postQaPdfDecision(status, threads) {
    if (window.parent === window) return;
    const decisionType = getQaPdfDecisionType(status);
    const reviewedSync = window.__lastFirstMeasureReviewedPdfSync || window.__lastFirstMeasurePdfSync || {};
    window.parent.postMessage({
        type: 'firstmeasure:qa_decision_request',
        status,
        qa_decision_type: decisionType,
        decision_type: decisionType,
        corrected_by_qa: status === 'corrected_approved',
        correction_requested_from_technician: status === 'rejected',
        approved_without_changes: status === 'approved',
        folder: window.currentProjectId || reportConfigState?.folderId || '',
        pdf_sync_job_id: reviewedSync.jobId || reviewedSync.job_id || '',
        pdf_sync_revision: reviewedSync.revision || '',
        threads: Array.isArray(threads) ? threads : (window.DrafterQA?.getThreads ? window.DrafterQA.getThreads() : [])
    }, window.location.origin);
}

function getQaPdfDecisionType(status) {
    if (status === 'corrected_approved') return 'qa_corrected_and_approved';
    if (status === 'rejected') return 'technician_correction_requested';
    return 'approved_without_changes';
}

function blockUnrealisticReportGeometryForSubmission(state) {
    if (!state || typeof blockUnrealisticPdfGeometryIfNeeded !== 'function') return false;
    return blockUnrealisticPdfGeometryIfNeeded(state.report, state.facesData);
}

function getActiveReportFacetOverlapWarnings(state) {
    if (!state) return [];
    applyReportFacetOverlapGuards(state);
    return (Array.isArray(state.facetOverlapWarnings) ? state.facetOverlapWarnings : [])
        .filter((warning) => warning && warning.type === 'overlap' && warning.severity === 'warning');
}

function blockReportFacetOverlapsForSubmission(state) {
    const activeWarnings = getActiveReportFacetOverlapWarnings(state);
    if (!activeWarnings.length) return false;

    const examples = activeWarnings
        .slice(0, 3)
        .map((warning) => Array.isArray(warning.faceIndexes)
            ? warning.faceIndexes.map((idx) => Number(idx) + 1).join(' and ')
            : '')
        .filter(Boolean);

    const detail = examples.length
        ? `\n\nConflicting facets: ${examples.join(', ')}${activeWarnings.length > 3 ? ', ...' : ''}`
        : '';
    alert(`The system detected multiple conflicting faces that need to be corrected before the PDF can be submitted.${detail}\n\nIf one of the faces should not count, toggle it off on the Labels page and try again.`);
    return true;
}

async function refreshReportStateForFinalAction(existingState) {
    let state = existingState || reportConfigState;
    if (!state) {
        state = await captureFreshPdfStateForSubmission(window.loadedPdfConfig || null);
    } else {
        state = await captureFreshPdfStateForSubmission(state);
    }
    if (state) {
        reportConfigState = state;
        window.reportConfigState = state;
    }
    return state;
}

async function addQaPdfReviewFailuresToThreads(state, options = {}) {
    const review = ensureQaPdfReviewState(state);
    const failed = QA_PDF_REVIEW_ITEMS.filter((item) => review[item.key]?.status === 'fail');
    let threads = window.DrafterQA?.getThreads ? window.DrafterQA.getThreads() : [];
    if (!window.DrafterQA || typeof window.DrafterQA.addFeedback !== 'function') return threads;
    const resolveImmediately = !!options.resolve;
    for (const item of failed) {
        const comment = String(review[item.key]?.comment || '').trim();
        if (!comment) continue;
        const result = await window.DrafterQA.addFeedback({
            label: item.label,
            text: comment,
            resolved: resolveImmediately,
            corrected: resolveImmediately,
            resolveText: resolveImmediately ? 'Corrected by QA before approval.' : ''
        });
        if (result && Array.isArray(result.threads)) threads = result.threads;
    }
    return threads;
}

function setupQaPdfReviewControls(container, state, storiesReady) {
    const review = ensureQaPdfReviewState(state);
    const fixOnlyMode = isQaFixOnlyMode();
    const sendBackBtn = container.querySelector('#qaPdfSendBackBtn');
    const approveBtn = container.querySelector('#qaPdfApproveBtn');
    const correctApproveBtn = container.querySelector('#qaPdfCorrectApproveBtn');

    const refresh = () => {
        const values = QA_PDF_REVIEW_ITEMS.map((item) => review[item.key] || {});
        const allReviewed = values.every((item) => item.status === 'pass' || item.status === 'fail');
        const allPass = allReviewed && values.every((item) => item.status === 'pass');
        const failed = values.filter((item) => item.status === 'fail');
        const failedWithComments = failed.length > 0 && failed.every((item) => String(item.comment || '').trim().length > 0);
        const canApprove = storiesReady && allPass;
        const canCorrectApprove = storiesReady && failedWithComments;
        const canSendBack = failedWithComments && !fixOnlyMode;

        if (approveBtn) {
            approveBtn.disabled = !canApprove;
            approveBtn.className = `fin-submit-btn qa-approve ${canApprove ? 'enabled' : 'disabled'}`;
        }
        if (correctApproveBtn) {
            correctApproveBtn.disabled = !canCorrectApprove;
            correctApproveBtn.className = `fin-submit-btn qa-correct ${canCorrectApprove ? 'enabled' : 'disabled'}`;
        }
        if (sendBackBtn) {
            sendBackBtn.disabled = !canSendBack;
            sendBackBtn.title = fixOnlyMode ? 'Fix-only QA mode is enabled. Requesting technician correction is disabled.' : '';
            sendBackBtn.className = `fin-submit-btn qa-sendback ${canSendBack ? 'enabled' : 'disabled'}`;
        }
    };

    container.querySelectorAll('.qa-pdf-check').forEach((card) => {
        const key = card.getAttribute('data-qa-review');
        card.querySelectorAll('.qa-pdf-mark').forEach((btn) => {
            btn.addEventListener('click', () => {
                const value = btn.getAttribute('data-value') || '';
                review[key].status = value;
                card.classList.remove('pass', 'fail');
                if (value) card.classList.add(value);
                card.querySelectorAll('.qa-pdf-mark').forEach((mark) => {
                    mark.classList.toggle('active', mark === btn);
                });
                refresh();
            });
        });
        const comment = card.querySelector('.qa-pdf-comment');
        if (comment) {
            comment.addEventListener('input', () => {
                review[key].comment = comment.value;
                refresh();
            });
        }
    });

    if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
            if (approveBtn.disabled) return;
            const original = approveBtn.innerHTML;
            approveBtn.disabled = true;
            approveBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Submitting...';
            try {
                if (blockReportFacetOverlapsForSubmission(state)) return;
                if (!state || blockUnrealisticReportGeometryForSubmission(state)) return;
                postQaPdfDecision('approved');
            } finally {
                approveBtn.innerHTML = original;
                refresh();
            }
        });
    }
    if (correctApproveBtn) {
        correctApproveBtn.addEventListener('click', async () => {
            if (correctApproveBtn.disabled) return;
            const original = correctApproveBtn.innerHTML;
            correctApproveBtn.disabled = true;
            correctApproveBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Submitting...';
            try {
                if (blockReportFacetOverlapsForSubmission(state)) return;
                if (!state || blockUnrealisticReportGeometryForSubmission(state)) return;
                correctApproveBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...';
                const threads = await addQaPdfReviewFailuresToThreads(state, { resolve: true });
                postQaPdfDecision('corrected_approved', threads);
            } finally {
                correctApproveBtn.innerHTML = original;
                refresh();
            }
        });
    }
    if (sendBackBtn) {
        sendBackBtn.addEventListener('click', async () => {
            if (sendBackBtn.disabled) return;
            sendBackBtn.disabled = true;
            const original = sendBackBtn.innerHTML;
            sendBackBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving feedback...';
            try {
                const threads = await addQaPdfReviewFailuresToThreads(state);
                postQaPdfDecision('rejected', threads);
            } finally {
                sendBackBtn.innerHTML = original;
                refresh();
            }
        });
    }

    refresh();
}

async function renderFinalizePage(container) {
    let state = reportConfigState;
    if (!state) return;

    if (!state.finalizeSources) state.finalizeSources = { images: [], notes: '' };
    if (!Array.isArray(state.finalizeSources.images)) state.finalizeSources.images = [];
    if (typeof state.finalizeSources.notes !== 'string') state.finalizeSources.notes = '';

    const buildThumbsHtml = () => (state.finalizeSources.images || []).map((img, idx) => `
        <div class="fin-src-thumb" style="background-image:url(${img.dataUrl});">
            <div class="fin-src-thumb-rm" data-rm-idx="${idx}" title="Remove">x</div>
        </div>
    `).join('');

    const guttersRequired = shouldIncludeGutters(state);
    const missingGutterStories = getMissingRequiredGutterStories(state);
    const storiesReady = !guttersRequired || missingGutterStories.length === 0;
    const storiesHint = storiesReady
        ? 'All gutter stories are filled in.'
        : `Set stories for ${missingGutterStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} before submission.`;
    const qaPdfReviewMode = isQaPortalPdfReviewMode();

    container.innerHTML = `
        <div class="fin-wrap pdf-preview-shell">
            <div class="pdf-preview-card">
                <div class="pdf-preview-toolbar">
                    <div class="pdf-preview-title"><i class="fas fa-file-pdf"></i> Report PDF</div>
                    <div class="pdf-preview-status" id="pdfPreviewStatus">Preparing preview...</div>
                    <button type="button" class="pdf-preview-refresh" id="pdfPreviewRefresh">
                        <i class="fas fa-sync-alt"></i> Regenerate
                    </button>
                </div>
                <div class="pdf-preview-frame-wrap">
                    <div class="pdf-preview-placeholder" id="pdfPreviewPlaceholder">
                        <i class="fas fa-circle-notch fa-spin"></i>
                        <div>Generating PDF preview...</div>
                    </div>
                    <iframe class="pdf-preview-frame" id="pdfPreviewFrame" title="PDF Preview" style="display:none;"></iframe>
                </div>
            </div>

            ${qaPdfReviewMode ? renderQaSubmissionSourcesReviewHtml(state) : `<div class="fin-src" id="finSrcCard">
                <div class="fin-src-body">
                    <div class="fin-src-label">
                        <i class="fas fa-paperclip"></i>
                        Sources & Notes
                        <span class="fin-src-hint">- upload all references and describe methodology</span>
                    </div>
                    <div class="fin-src-row">
                        <div class="fin-src-upload" id="srcUploadArea">
                            <i class="fas fa-cloud-upload-alt"></i>
                            <span>Images</span>
                        </div>
                        <input type="file" id="srcFileInput" multiple accept="image/*" style="display:none;">
                        <textarea class="fin-src-notes" id="srcNotesArea"
                            placeholder="e.g. Pitch verified via Street View, chimney dims from site photos..."
                        >${escapeHtml(state.finalizeSources.notes || '')}</textarea>
                    </div>
                    <div class="fin-src-thumbs" id="srcThumbs">${buildThumbsHtml()}</div>
                </div>
            </div>`}

            ${guttersRequired ? `
                <div id="finGutterStoriesReq" style="margin:0; padding:10px 12px; border:1px solid ${storiesReady ? '#c5d8c9' : '#f2c6c2'}; background:${storiesReady ? '#f7fbf8' : '#fff5f5'}; border-radius:10px; font-size:12px; color:${storiesReady ? '#188038' : '#b3261e'}; font-weight:700;">
                    Gutter stories requirement: ${storiesHint}
                </div>
            ` : ''}

            ${qaPdfReviewMode ? renderQaPdfReviewHtml(state) : `
                <div class="fin-submit-area">
                    <button class="fin-submit-btn ${storiesReady ? 'enabled' : 'disabled'}" id="finalSubmitBtn" ${storiesReady ? '' : 'disabled'}>
                        <i class="fas fa-file-pdf"></i> Submit PDF
                    </button>
                    <div class="fin-submit-hint">${storiesReady ? 'Ready to submit after reviewing the preview.' : 'Fill in all gutter stories to enable submission.'}</div>
                </div>
            `}
        </div>
    `;

    const statusEl = container.querySelector('#pdfPreviewStatus');
    const previewFrame = container.querySelector('#pdfPreviewFrame');
    const placeholder = container.querySelector('#pdfPreviewPlaceholder');
    const refreshBtn = container.querySelector('#pdfPreviewRefresh');
    let previewSyncReady = false;
    if (qaPdfReviewMode) wireQaSubmissionSourcesReview(container, state);

    const setPreviewStatus = (text, isError = false) => {
        if (statusEl) {
            statusEl.textContent = text || '';
            statusEl.style.color = isError ? '#b3261e' : '#667085';
        }
    };

    const showPreviewError = (message) => {
        if (!placeholder) return;
        placeholder.innerHTML = `
            <div class="pdf-preview-error">
                <i class="fas fa-exclamation-triangle" style="margin-right:6px;"></i>
                ${escapeHtml(message || 'Unable to generate PDF preview.')}
            </div>
        `;
        placeholder.style.display = 'flex';
        if (previewFrame) {
            previewFrame.style.display = 'none';
            previewFrame.removeAttribute('src');
        }
    };

    const generatePreview = async () => {
        if (!previewFrame || !placeholder) return;
        if (typeof window.generatePDFFromState !== 'function') {
            showPreviewError('PDF renderer is not loaded.');
            return;
        }

        previewSyncReady = false;
        const existingReviewedSync = window.__lastFirstMeasureReviewedPdfSync;
        if (existingReviewedSync && String(existingReviewedSync.folderId || '') === String(state.folderId || window.currentProjectId || '')) {
            window.__lastFirstMeasureReviewedPdfSync = null;
        }
        if (typeof refreshSubmitState === 'function') refreshSubmitState();
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Generating';
        }
        clearReportPdfPreviewUrl();
        previewFrame.style.display = 'none';
        previewFrame.removeAttribute('src');
        placeholder.style.display = 'flex';
        placeholder.innerHTML = `
            <i class="fas fa-circle-notch fa-spin"></i>
            <div>Generating PDF preview...</div>
        `;
        setPreviewStatus('Refreshing report data...');

        try {
            let previewState = await captureFreshPdfStateForSubmission(state);
            if (!previewState) previewState = state;
            state = previewState;
            reportConfigState = state;
            window.reportConfigState = state;

            setPreviewStatus('Rendering images...');
            if (typeof window.updateStateImages === 'function') {
                await window.updateStateImages(state);
            }

            setPreviewStatus('Generating PDF locally...');
            if (!window.FirstMatePDFStandalone) {
                throw new Error('The shared local PDF synchronization runtime is unavailable.');
            }
            const folderId = state.folderId || window.currentProjectId;
            const isTutorialPreview = !!(
                window.FIRSTMEASURE_TUTORIAL?.enabled
                && typeof window.firstMeasureIsTutorialProjectId === 'function'
                && window.firstMeasureIsTutorialProjectId(folderId)
            );
            const snapshot = typeof window.createStandalonePdfSnapshot === 'function'
                ? window.createStandalonePdfSnapshot(state)
                : state;
            const outputs = buildSubmissionPdfOutputs(state).map((output) => ({
                ...output,
                update_status: false,
                persist: true
            }));
            const runtimeContext = {
                folderId,
                manifest: window.currentProjectManifest || null,
                organization: window.projectOrganization || null
            };
            let generated;
            if (isTutorialPreview) {
                if (typeof window.FirstMatePDFStandalone.generateProjectPdfsLocally !== 'function') {
                    throw new Error('The shared local PDF runtime is unavailable.');
                }
                generated = await window.FirstMatePDFStandalone.generateProjectPdfsLocally(
                    snapshot,
                    runtimeContext,
                    {
                        outputs: outputs.map((output) => ({
                            ...output,
                            update_status: false,
                            persist: false
                        })),
                        persistFiles: false,
                        updateStatus: false,
                        onStatus: ({ message }) => {
                            if (message) setPreviewStatus(message);
                        }
                    }
                );
            } else {
                if (typeof window.FirstMatePDFStandalone.generateProjectPdfsWithBackgroundSync !== 'function') {
                    throw new Error('The shared local PDF synchronization runtime is unavailable.');
                }
                generated = await window.FirstMatePDFStandalone.generateProjectPdfsWithBackgroundSync(
                    folderId,
                    snapshot,
                    runtimeContext,
                    {
                        outputs,
                        localOutputs: outputs,
                        onStatus: ({ message }) => {
                            if (message) setPreviewStatus(message);
                        },
                        onOutput: async (output) => {
                            if (!output || output.mode !== 'full' || !output.result?.blob) return;
                            clearReportPdfPreviewUrl();
                            _pdfPreviewUrl = URL.createObjectURL(output.result.blob);
                            previewFrame.src = `${_pdfPreviewUrl}#toolbar=1&navpanes=0&view=FitH`;
                            previewFrame.style.display = 'block';
                            placeholder.style.display = 'none';
                            setPreviewStatus('Main report ready; verifying summary...');
                        }
                    }
                );
            }
            const mainOutput = Array.isArray(generated.outputs)
                ? generated.outputs.find((output) => output && output.mode === 'full')
                : null;
            const result = mainOutput ? { blob: mainOutput.blob } : null;

            if (!result || !result.blob) {
                throw new Error('PDF renderer did not return a preview blob.');
            }

            if (isTutorialPreview) {
                previewSyncReady = true;
            } else {
                const reviewedSync = {
                    folderId,
                    revision: String(generated.revision || ''),
                    jobId: String(generated.sync?.job_id || ''),
                    localChecksums: { ...(window.__lastFirstMeasurePdfSync?.localChecksums || {}) },
                    localRenderChecksums: { ...(window.__lastFirstMeasurePdfSync?.localRenderChecksums || {}) },
                    outputs: Array.isArray(generated.outputs) ? generated.outputs : [],
                    reviewedAt: new Date().toISOString()
                };
                if (!reviewedSync.revision || !reviewedSync.jobId) {
                    throw new Error('The server did not accept the reviewed PDF revision.');
                }
                window.__lastFirstMeasureReviewedPdfSync = reviewedSync;
                previewSyncReady = true;
                console.info('[PDF SUBMIT] Reviewed PDF revision is ready for instant submission.', {
                    folderId: reviewedSync.folderId,
                    revision: reviewedSync.revision,
                    jobId: reviewedSync.jobId
                });
            }
            window.__lastPdfLocalGenerationResult = generated;

            clearReportPdfPreviewUrl();
            _pdfPreviewUrl = URL.createObjectURL(result.blob);
            previewFrame.src = `${_pdfPreviewUrl}#toolbar=1&navpanes=0&view=FitH`;
            previewFrame.style.display = 'block';
            placeholder.style.display = 'none';
            setPreviewStatus(`Preview generated (${Math.round(result.blob.size / 1024).toLocaleString()} KB)`);
        } catch (e) {
            console.error('[PDF Preview] Failed to generate preview:', e);
            showPreviewError(e && e.message ? e.message : 'Unable to generate PDF preview.');
            setPreviewStatus('Preview failed', true);
        } finally {
            if (typeof refreshSubmitState === 'function') refreshSubmitState();
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Regenerate';
            }
        }
    };

    if (refreshBtn) refreshBtn.addEventListener('click', generatePreview);

    const refreshSubmitState = () => {
        const missingStories = getMissingRequiredGutterStories(state);
        const ok = missingStories.length === 0 && (qaPdfReviewMode || previewSyncReady);
        const btn = container.querySelector('#finalSubmitBtn');
        const hint = qaPdfReviewMode ? null : container.querySelector('.fin-submit-hint');
        const reqBox = container.querySelector('#finGutterStoriesReq');
        if (btn) {
            btn.disabled = !ok;
            btn.className = 'fin-submit-btn ' + (ok ? 'enabled' : 'disabled');
        }
        if (hint) hint.textContent = ok
            ? 'Ready to submit the reviewed PDF.'
            : (missingStories.length ? 'Fill in all gutter stories to enable submission.' : 'Waiting for the reviewed PDF revision to be accepted...');
        if (reqBox) {
            reqBox.style.borderColor = ok ? '#c5d8c9' : '#f2c6c2';
            reqBox.style.background = ok ? '#f7fbf8' : '#fff5f5';
            reqBox.style.color = ok ? '#188038' : '#b3261e';
            reqBox.textContent = ok
                ? 'Gutter stories requirement: All gutter stories are filled in.'
                : `Gutter stories requirement: Set stories for ${missingStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} before submission.`;
        }
    };

    const notesArea = container.querySelector('#srcNotesArea');
    if (notesArea) {
        notesArea.addEventListener('input', () => {
            state.finalizeSources.notes = notesArea.value;
        });
        notesArea.addEventListener('click', (e) => e.stopPropagation());
    }

    const thumbsContainer = container.querySelector('#srcThumbs');
    const rebuildThumbs = () => {
        if (!thumbsContainer) return;
        thumbsContainer.innerHTML = '';
        (state.finalizeSources.images || []).forEach((img, idx) => {
            const t = document.createElement('div');
            t.className = 'fin-src-thumb';
            t.style.backgroundImage = `url(${img.dataUrl})`;
            t.innerHTML = '<div class="fin-src-thumb-rm" title="Remove">x</div>';
            t.querySelector('.fin-src-thumb-rm').addEventListener('click', (e) => {
                e.stopPropagation();
                state.finalizeSources.images.splice(idx, 1);
                rebuildThumbs();
            });
            thumbsContainer.appendChild(t);
        });
    };

    const processFiles = (files) => {
        Array.from(files || []).forEach(file => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                state.finalizeSources.images.push({ dataUrl: ev.target.result, name: file.name, size: file.size });
                rebuildThumbs();
            };
            reader.readAsDataURL(file);
        });
    };

    const uploadArea = container.querySelector('#srcUploadArea');
    const fileInput = container.querySelector('#srcFileInput');
    if (uploadArea && fileInput) {
        uploadArea.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#1a73e8'; uploadArea.style.background = '#f5f9ff'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; uploadArea.style.background = ''; });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = '';
            uploadArea.style.background = '';
            if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) processFiles(fileInput.files);
            fileInput.value = '';
        });
    }

    container.querySelectorAll('.fin-src-thumb-rm[data-rm-idx]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.finalizeSources.images.splice(parseInt(btn.getAttribute('data-rm-idx'), 10), 1);
            rebuildThumbs();
        });
    });

    const submitBtn = container.querySelector('#finalSubmitBtn');
    if (submitBtn) submitBtn.addEventListener('click', () => { if (!submitBtn.disabled) submitFinalReport(); });
    if (qaPdfReviewMode) setupQaPdfReviewControls(container, state, storiesReady);
    refreshSubmitState();
    setTimeout(generatePreview, 0);
}




// ─────────────────────────────────────────────────────────────────────────────
// 6. REPLACE: submitFinalReport  (adds source image/note upload step)
// ─────────────────────────────────────────────────────────────────────────────

const FIRSTMEASURE_SERVER_ONLY_PDF_MODE = false;
const FIRSTMEASURE_KEEP_PAGE_OPEN_AFTER_PDF = false;
const FIRSTMEASURE_PDF_SUBMIT_DEBUG = (() => {
    try {
        const params = new URLSearchParams(window.location.search || '');
        return window.FIRSTMEASURE_PDF_SUBMIT_DEBUG === true ||
            params.has('pdf_debug') ||
            params.has('debug') ||
            params.has('qa_embed') ||
            params.has('qa_feedback_editor');
    } catch (e) {
        return window.FIRSTMEASURE_PDF_SUBMIT_DEBUG === true;
    }
})();

function extractFirstMeasureDebugTrace(error) {
    return error?.debugTrace ||
        error?.details?._debug?.trace_id ||
        error?.details?._debug?.traceId ||
        error?.details?.debug?.trace_id ||
        error?.details?.trace_id ||
        null;
}

function logPdfSubmissionError(error, stage, state = null) {
    const details = error?.details || error?.data || null;
    const debugError = details?.debug_error || details?._debug?.error || null;
    console.group('[PDF SUBMIT ERROR]');
    console.error(error);
    console.log('stage:', stage || 'unknown');
    console.log('message:', error?.message || String(error));
    if (error?.endpoint) console.log('endpoint:', error.endpoint);
    if (error?.status) console.log('status:', error.status);
    if (extractFirstMeasureDebugTrace(error)) console.log('firstMeasureDebugTrace:', extractFirstMeasureDebugTrace(error));
    if (debugError) console.log('server debug_error:', debugError);
    if (details) console.log('server response:', details);
    if (error?.responseText) console.log('raw response text:', error.responseText);
    if (state) console.log('state summary:', summarizePdfStateForDebug(state));
    if (Array.isArray(window.__lastPdfApiGenerationDebug)) console.log('last api debug tail:', window.__lastPdfApiGenerationDebug.slice(-12));
    if (Array.isArray(window.__pdfDebugHistory)) console.log('local pdf debug tail:', window.__pdfDebugHistory.slice(-12));
    console.groupEnd();
}

function summarizePdfStateForDebug(state) {
    const materials = (state && state.report && state.report.materials) ? state.report.materials : {};
    const squares = (materials && materials.squares && typeof materials.squares === 'object') ? materials.squares : {};
    return {
        folderId: state?.folderId || null,
        radiusMeters: state?.radiusMeters ?? null,
        dims: state?.dims || null,
        manualWastePct: state?.manualWastePct ?? null,
        manualTotalFacets: state?.manualTotalFacets ?? null,
        totalSquares: typeof materials.totalSquares === 'number' ? materials.totalSquares : null,
        pitchBreakdown: Object.keys(squares).sort().map((pitch) => ({
            pitch,
            squares: squares[pitch],
            sq_ft: typeof squares[pitch] === 'number' ? Math.round(squares[pitch] * 100 * 100) / 100 : null
        }))
    };
}

function summarizePdfBrandingForDebug(state, runtimeContext = null, outputs = null) {
    const orgBranding = runtimeContext?.organization?.branding || window.projectOrganization?.branding || null;
    const liveOverrides = (state && state.brandingOverrides && typeof state.brandingOverrides === 'object')
        ? state.brandingOverrides
        : null;
    return {
        folderId: state?.folderId || runtimeContext?.folderId || null,
        orgBrandingPresent: !!orgBranding,
        orgPrimary: orgBranding?.colors?.primary || null,
        orgSecondary: orgBranding?.colors?.secondary || null,
        orgLogo: orgBranding?.logo || null,
        orgLogoNodeUrl: orgBranding?.logo_node_url || null,
        orgLogoUrl: orgBranding?.logo_url || null,
        resolvedOrgLogo: firstReportLogoValue(orgBranding) || null,
        liveOverridePrimary: liveOverrides?.primaryColor || null,
        liveOverrideSecondary: liveOverrides?.secondaryColor || null,
        liveOverrideLogo: liveOverrides?.logoDataUrl
            ? (String(liveOverrides.logoDataUrl).startsWith('data:') ? '[data-url]' : liveOverrides.logoDataUrl)
            : null,
        outputs: Array.isArray(outputs)
            ? outputs.map((output) => ({
                mode: output?.mode || null,
                useProjectOrganizationBranding: !!(output?.useProjectOrganizationBranding || output?.use_project_organization_branding),
                clearBrandingOverrides: !!(output?.clearBrandingOverrides || output?.clear_branding_overrides),
                disableOrganizationBranding: !!(output?.disableOrganizationBranding || output?.disable_organization_branding),
                brandingOverridePrimary: output?.brandingOverrides?.primaryColor || null,
                brandingOverrideSecondary: output?.brandingOverrides?.secondaryColor || null,
                brandingOverrideLogo: output?.brandingOverrides?.logoDataUrl
                    ? (String(output.brandingOverrides.logoDataUrl).startsWith('data:') ? '[data-url]' : output.brandingOverrides.logoDataUrl)
                    : null
            }))
            : null
    };
}

function logPdfSubmissionDebug(label, state, runtimeContext = null, outputs = null, generatedOutputs = null) {
    if (!FIRSTMEASURE_PDF_SUBMIT_DEBUG) return;
    console.groupCollapsed(`[PDF SUBMIT DEBUG] ${label}`);
    console.log('state', summarizePdfStateForDebug(state));
    console.log('branding', summarizePdfBrandingForDebug(state, runtimeContext, outputs));
    if (generatedOutputs) console.log('generatedOutputs', generatedOutputs);
    if (Array.isArray(window.__pdfDebugHistory)) {
        console.log('pdfDebugHistoryTail', window.__pdfDebugHistory.slice(-12));
    }
    console.groupEnd();
}

function logPdfApiDebugTrace(apiResult, state) {
    if (!FIRSTMEASURE_PDF_SUBMIT_DEBUG) return;
    const debugEntries = Array.isArray(apiResult?.debug) ? apiResult.debug : [];
    window.__lastPdfApiGenerationResult = apiResult || null;
    window.__lastPdfApiGenerationDebug = debugEntries;

    console.groupCollapsed('[PDF API] Submit summary');
    console.log(summarizePdfStateForDebug(state));
    console.groupEnd();

    if (!debugEntries.length) {
        console.info('[PDF API] No runtime debug entries were returned by the server renderer.');
        return;
    }

    console.groupCollapsed(`[PDF API] Runtime debug trace (${debugEntries.length} entries)`);
    debugEntries.forEach((entry, index) => {
        const text = typeof entry?.text === 'string' ? entry.text : '';
        if (text.startsWith('[PDF DEBUG] ')) {
            try {
                console.log(`#${index + 1}`, JSON.parse(text.slice('[PDF DEBUG] '.length)));
                return;
            } catch (e) {}
        }
        console.log(`#${index + 1}`, entry);
    });
    console.groupEnd();
}

function buildPdfDownloadName(fileName, output) {
    const base = String(fileName || 'report.pdf');
    const dotIndex = base.lastIndexOf('.');
    const ext = dotIndex >= 0 ? base.slice(dotIndex) : '.pdf';
    const title = String(output?.slot || '').toLowerCase() === 'summary' ? 'Summary' : 'Report';
    const state = window.__lastPdfApiSubmittedSnapshot || window.reportConfigState || {};
    const rawAddress = String(state.address || window.currentProjectManifest?.address || '').trim();
    const safeAddress = rawAddress
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (safeAddress) {
        return `${title} - ${safeAddress}${ext}`;
    }

    return `${title}${ext}`;
}

function cloneSubmissionSourcesValue(value, fallback = null) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

function getSubmissionSourceActorLabel() {
    const actor = (window.FIRSTMEASURE_ACTOR && typeof window.FIRSTMEASURE_ACTOR === 'object')
        ? window.FIRSTMEASURE_ACTOR
        : {};
    const name = String(actor.name || '').trim();
    if (name) return name;
    const email = String(actor.email || actor.user_email || '').trim();
    if (email) return email;
    return 'Technician';
}

function getSubmissionSourceMetadataBase() {
    const current = (window.currentProjectLoadedAppMetadata && typeof window.currentProjectLoadedAppMetadata === 'object')
        ? window.currentProjectLoadedAppMetadata
        : {};
    return cloneSubmissionSourcesValue(current, {}) || {};
}

async function persistSubmissionSourceMetadata(folderId, payload) {
    if (!folderId || typeof window.firstMeasureFetchJson !== 'function') {
        throw new Error('Unable to save submission note metadata for this project.');
    }

    const nextMeta = getSubmissionSourceMetadataBase();
    nextMeta.submission_sources = payload && typeof payload === 'object'
        ? cloneSubmissionSourcesValue(payload, {})
        : {};

    await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(folderId)}/editor/save`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ metadata: nextMeta })
    });

    window.currentProjectLoadedAppMetadata = cloneSubmissionSourcesValue(nextMeta, {});
    if (window.currentProjectManifest && typeof window.currentProjectManifest === 'object') {
        window.currentProjectManifest.submission_sources = cloneSubmissionSourcesValue(nextMeta.submission_sources, {});
    }
    return nextMeta.submission_sources;
}

async function uploadSubmissionSourcesAndPersist(state, setOverlay) {
    if (isQaPortalPdfReviewMode()) {
        return cloneSubmissionSourcesValue(
            window.currentProjectManifest?.submission_sources ||
            window.currentProjectLoadedAppMetadata?.submission_sources ||
            {},
            {}
        );
    }
    const sources = (state && state.finalizeSources && typeof state.finalizeSources === 'object')
        ? state.finalizeSources
        : null;
    const notes = String(sources && typeof sources.notes === 'string' ? sources.notes : '');
    const images = Array.isArray(sources && sources.images) ? sources.images : [];
    const hasNotes = notes.trim().length > 0;
    const hasImages = images.length > 0;

    if (!hasNotes && !hasImages) {
        await persistSubmissionSourceMetadata(state.folderId, {});
        return {};
    }

    setOverlay(true, "Uploading Submission Notes...");
    await window.firstMeasureUploadTextArtifact(state.folderId, 'sources_notes.txt', notes);

    const uploadedImages = [];
    for (let i = 0; i < images.length; i++) {
        const img = images[i] || {};
        const rawImageSource = String(img.dataUrl || img.url || img.file_name || '').trim();
        if (!rawImageSource) continue;
        const fetchUrl = (/^[a-z]+:\/\//i.test(rawImageSource) || rawImageSource.startsWith('data:') || rawImageSource.startsWith('/'))
            ? rawImageSource
            : window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(state.folderId)}/artifacts/${encodeURIComponent(rawImageSource)}`);
        const response = await fetch(fetchUrl);
        if (!response.ok) {
            throw new Error(`Failed to prepare submission image ${i + 1} for upload.`);
        }
        const blob = await response.blob();
        const originalName = String(img.name || `source_${i + 1}.jpg`);
        const extMatch = originalName.match(/\.([a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
        const safeBase = originalName
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-z0-9_-]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48) || `source_${i + 1}`;
        const uploadName = `source_${i + 1}_${Date.now()}_${safeBase}.${ext}`;
        const uploadResult = await window.firstMeasureUploadArtifact(state.folderId, blob, uploadName);
        const savedName = String(
            (uploadResult && uploadResult.artifact && uploadResult.artifact.name) ||
            uploadName
        ).trim();

        uploadedImages.push({
            file_name: savedName,
            url: savedName,
            original_name: originalName
        });
    }

    const payload = {
        notes,
        images: uploadedImages,
        submitted_at: new Date().toISOString(),
        submitted_by: getSubmissionSourceActorLabel()
    };

    await persistSubmissionSourceMetadata(state.folderId, payload);
    return payload;
}

function buildSubmissionPdfOutputs(state = null) {
    const orgBranding = (
        window.projectOrganization &&
        window.projectOrganization.branding &&
        typeof window.projectOrganization.branding === 'object'
    ) ? window.projectOrganization.branding : null;
    const liveOverrides = (state && state.brandingOverrides && typeof state.brandingOverrides === 'object')
        ? state.brandingOverrides
        : {};
    const orgPrimary = String(orgBranding?.colors?.primary || '').trim().toLowerCase();
    const orgSecondary = String(orgBranding?.colors?.secondary || '').trim().toLowerCase();
    const orgLogo = firstReportLogoValue(orgBranding);
    const livePrimary = String(liveOverrides.primaryColor || '').trim().toLowerCase();
    const liveSecondary = String(liveOverrides.secondaryColor || '').trim().toLowerCase();
    const liveLogo = String(liveOverrides.logoDataUrl || '').trim();
    const hasOrgBranding = !!(orgBranding && (orgPrimary || orgSecondary || orgLogo));

    const hasCustomBranding = !!(
        liveLogo && liveLogo !== orgLogo ||
        livePrimary && livePrimary !== orgPrimary ||
        liveSecondary && liveSecondary !== orgSecondary ||
        (!hasOrgBranding && (liveLogo || livePrimary || liveSecondary))
    );

    const fullOutput = {
        mode: 'full',
        persist: true,
        update_status: true,
        clearBrandingOverrides: true,
        clear_branding_overrides: true,
        disableOrganizationBranding: true,
        disable_organization_branding: true,
        applyBrandingToFull: false,
        apply_branding_to_full: false
    };

    const summaryOutput = {
        mode: 'summary',
        persist: true,
        update_status: false
    };

    if (hasOrgBranding) {
        summaryOutput.useProjectOrganizationBranding = true;
        summaryOutput.clearBrandingOverrides = true;
        summaryOutput.use_project_organization_branding = true;
        summaryOutput.clear_branding_overrides = true;
    }

    if (hasCustomBranding) {
        summaryOutput.brandingOverrides = {
            primaryColor: liveOverrides.primaryColor || '',
            secondaryColor: liveOverrides.secondaryColor || '',
            logoDataUrl: liveOverrides.logoDataUrl || null
        };
        if (!hasOrgBranding) {
            summaryOutput.clearBrandingOverrides = true;
            summaryOutput.clear_branding_overrides = true;
        }
    }

    return [fullOutput, summaryOutput];
}

async function tryApiPdfGenerationWithConfirmation(state, setOverlay) {
    if (!window.FirstMatePDFStandalone || typeof window.FirstMatePDFStandalone.generateProjectPdfsViaApi !== 'function') {
        throw new Error('Server PDF API runtime is unavailable in this editor build.');
    }

    try {
        const snapshot = (typeof window.createStandalonePdfSnapshot === 'function')
            ? window.createStandalonePdfSnapshot(state)
            : state;
        if (!snapshot) {
            throw new Error('Unable to create the PDF snapshot for API generation.');
        }

        const submissionOutputs = buildSubmissionPdfOutputs(state);
        const requiresPerOutputBrandingParity = submissionOutputs.some((output) => (
            output &&
            (
                output.disableOrganizationBranding ||
                output.disable_organization_branding ||
                output.useProjectOrganizationBranding ||
                output.use_project_organization_branding ||
                output.clearBrandingOverrides ||
                output.clear_branding_overrides
            )
        ));

        if (requiresPerOutputBrandingParity && !FIRSTMEASURE_SERVER_ONLY_PDF_MODE) {
            return null;
        }

        window.__lastPdfApiSubmittedSnapshot = snapshot;

        const payloadEstimate = (typeof window.FirstMatePDFStandalone.estimateProjectPdfsApiPayload === 'function')
            ? window.FirstMatePDFStandalone.estimateProjectPdfsApiPayload(state.folderId, snapshot, {
                persistFiles: true,
                updateStatus: true,
                outputs: submissionOutputs
            })
            : null;
        if (payloadEstimate && !payloadEstimate.withinLimit) {
            console.warn('[PDF API] Skipping API generation because the inline payload exceeds the safe size limit.', payloadEstimate);
            return null;
        }

        setOverlay(true, "Generating Reports via API...");
        const apiResult = await window.FirstMatePDFStandalone.generateProjectPdfsViaApi(state.folderId, snapshot, {
            persistFiles: true,
            updateStatus: true,
            outputs: submissionOutputs,
            debug: FIRSTMEASURE_PDF_SUBMIT_DEBUG
        });
        logPdfApiDebugTrace(apiResult, snapshot);
        return Array.isArray(apiResult.outputs) ? apiResult.outputs : [];
    } catch (apiErr) {
        window.__lastPdfApiGenerationError = apiErr;
        const isPayloadTooLarge = apiErr && (
            apiErr.status === 413 ||
            apiErr.code === 'CLIENT_PDF_API_BODY_TOO_LARGE_PRECHECK' ||
            apiErr.details?.error === 'FST_ERR_CTP_BODY_TOO_LARGE'
        );
        console.group(isPayloadTooLarge ? '[PDF API] Payload too large, using local fallback' : '[PDF API] Generation failed');
        if (isPayloadTooLarge) {
            console.warn(apiErr?.message || 'PDF API payload is too large.');
        } else {
            console.error(apiErr);
        }
        if (apiErr && apiErr.details) console.log('details:', apiErr.details);
        if (apiErr && apiErr.responseText) console.log('raw response text:', apiErr.responseText);
        if (extractFirstMeasureDebugTrace(apiErr)) console.log('firstMeasureDebugTrace:', extractFirstMeasureDebugTrace(apiErr));
        if (apiErr && apiErr.details?.debug_error) console.log('server debug_error:', apiErr.details.debug_error);
        if (apiErr && apiErr.endpoint) console.log('endpoint:', apiErr.endpoint);
        if (apiErr && apiErr.status) console.log('status:', apiErr.status);
        console.groupEnd();

        setOverlay(false);
        if (FIRSTMEASURE_SERVER_ONLY_PDF_MODE) {
            alert(
                "API PDF generation failed.\n\n" +
                "Local PDF fallback is temporarily disabled in this editor build.\n" +
                "Inspect the console error log under [PDF API]."
            );
            throw apiErr;
        }

        console.warn('[PDF API] Falling back to the shared local PDF runtime.');
        return null;
    }
}

async function runSharedLocalPdfGeneration(state, setOverlay) {
    if (FIRSTMEASURE_SERVER_ONLY_PDF_MODE) {
        throw new Error('Shared local PDF runtime is temporarily disabled. Use the server PDF API path.');
    }

    if (!window.FirstMatePDFStandalone || typeof window.FirstMatePDFStandalone.generateProjectPdfsWithBackgroundSync !== 'function') {
        throw new Error('Shared local PDF runtime is unavailable.');
    }

    const folderId = state.folderId || window.currentProjectId || null;
    let runtimeContext = {
        folderId,
        manifest: window.currentProjectManifest || null,
        organization: window.projectOrganization || null
    };

    if (folderId && typeof window.FirstMatePDFStandalone.loadProjectBundle === 'function') {
        try {
            const bundle = await window.FirstMatePDFStandalone.loadProjectBundle(folderId);
            runtimeContext = {
                folderId: bundle.folderId || folderId,
                manifest: bundle.manifest || runtimeContext.manifest,
                organization: bundle.organization || runtimeContext.organization
            };
            if (runtimeContext.manifest) window.currentProjectManifest = runtimeContext.manifest;
            if (runtimeContext.organization) window.projectOrganization = runtimeContext.organization;
        } catch (bundleErr) {
            console.warn('[PDF Local Shared Runtime] Failed to refresh project bundle before generation; using current editor globals.', bundleErr);
        }
    }

    const overlayText = document.getElementById('loadingText');
    const outputs = buildSubmissionPdfOutputs(state);
    logPdfSubmissionDebug('pre-local-generate', state, runtimeContext, outputs);
    const snapshot = (typeof window.createStandalonePdfSnapshot === 'function')
        ? window.createStandalonePdfSnapshot(state)
        : state;
    setOverlay(true, "Generating Reports Locally...");
    const localResult = await window.FirstMatePDFStandalone.generateProjectPdfsWithBackgroundSync(
        folderId,
        snapshot,
        runtimeContext,
        {
            persistFiles: true,
            updateStatus: true,
            outputs,
            onStatus: ({ mode, message }) => {
                if (!message || message === 'Done') return;
                if (mode === 'summary') {
                    if (overlayText) overlayText.innerText = `Summary: ${message}`;
                    return;
                }
                if (overlayText) overlayText.innerText = message;
            }
        }
    );

    logPdfSubmissionDebug('post-local-generate', state, runtimeContext, outputs, localResult?.outputs || null);
    window.__lastPdfLocalRuntimeContext = runtimeContext;
    window.__lastPdfLocalOutputsSpec = outputs;
    window.__lastPdfLocalGenerationResult = localResult;
    return Array.isArray(localResult.outputs) ? localResult.outputs : [];
}

async function downloadGeneratedPdfOutputs(outputs) {
    if (!Array.isArray(outputs)) return;
    for (const output of outputs) {
        if (!output) continue;
        if (output.pdf_url) {
            const pdfResp = await fetch(output.pdf_url, {
                cache: 'no-store',
                headers: {
                    'Accept': 'application/pdf'
                }
            });
            if (!pdfResp.ok) continue;
            const pdfBlob = await pdfResp.blob();
            await triggerBlobDownload(pdfBlob, buildPdfDownloadName(output.file_name || 'report.pdf', output));
            continue;
        }
        if (output.blob) {
            await triggerBlobDownload(output.blob, buildPdfDownloadName(output.file_name || 'report.pdf', output));
        }
    }
}

function getPostSubmitDashboardUrl() {
    return './';
}

function firstMeasureBuildFinalSubmissionSummary(state = null, overrides = {}) {
    const manifest = (window.currentProjectManifest && typeof window.currentProjectManifest === 'object')
        ? window.currentProjectManifest
        : {};
    const timerState = window.firstMeasureClaimTimerState || {};
    const startMs = typeof window.firstMeasureFindClaimStartedAt === 'function'
        ? window.firstMeasureFindClaimStartedAt(manifest)
        : null;
    const timing = timerState.timing || (
        typeof window.firstMeasureBuildClaimTiming === 'function'
            ? window.firstMeasureBuildClaimTiming(manifest, startMs)
            : null
    );
    const elapsedMsFromTimer = timing && typeof window.firstMeasureGetActiveElapsedMs === 'function'
        ? window.firstMeasureGetActiveElapsedMs(timing)
        : 0;
    const elapsedMs = Number.isFinite(Number(overrides.elapsedMs))
        ? Math.max(0, Number(overrides.elapsedMs))
        : Math.max(0, elapsedMsFromTimer);
    const points = Number.isFinite(Number(overrides.points))
        ? Number(overrides.points)
        : (
            typeof window.firstMeasureResolveProjectPoints === 'function'
                ? window.firstMeasureResolveProjectPoints(manifest)
                : null
        );
    const timeline = typeof window.firstMeasureBuildTimeline === 'function'
        ? window.firstMeasureBuildTimeline(points)
        : null;
    const rates = Array.isArray(window.FIRSTMEASURE_TIMELINE_PESO_RATES)
        ? window.FIRSTMEASURE_TIMELINE_PESO_RATES
        : [19, 16, 13, 10];
    let sectionIndex = 3;
    if (timeline && Array.isArray(timeline.boundariesMs)) {
        sectionIndex = timeline.boundariesMs.findIndex((boundary) => elapsedMs <= boundary);
        if (sectionIndex < 0) sectionIndex = 3;
    }
    const rate = Number.isFinite(Number(overrides.rate))
        ? Number(overrides.rate)
        : (Number(rates[sectionIndex]) || 10);
    const earned = Number.isFinite(Number(overrides.earned))
        ? Number(overrides.earned)
        : (Number.isFinite(Number(points)) ? Number(points) * rate : 0);

    return {
        elapsedMs,
        elapsedText: typeof window.firstMeasureFormatElapsed === 'function'
            ? window.firstMeasureFormatElapsed(elapsedMs)
            : `${Math.round(elapsedMs / 60000)} min`,
        points: Number.isFinite(Number(points)) ? Number(points) : null,
        rate,
        earned: Math.round(earned),
        folderId: state?.folderId || window.currentProjectId || null
    };
}

function firstMeasureSetSubmittedUrl(summary) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('submitted', '1');
        if (summary?.folderId) url.searchParams.set('folder', summary.folderId);
        if (Number.isFinite(Number(summary?.elapsedMs))) url.searchParams.set('final_elapsed_ms', String(Math.round(Number(summary.elapsedMs))));
        if (Number.isFinite(Number(summary?.earned))) url.searchParams.set('final_earned', String(Math.round(Number(summary.earned))));
        if (Number.isFinite(Number(summary?.rate))) url.searchParams.set('final_rate', String(Math.round(Number(summary.rate))));
        if (Number.isFinite(Number(summary?.points))) url.searchParams.set('final_points', String(Number(summary.points)));
        window.history.replaceState({}, '', url.toString());
    } catch (e) {}
}

function firstMeasureReadSubmittedSummaryFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (!params.has('submitted')) return null;
        const elapsedMs = Number(params.get('final_elapsed_ms'));
        const earned = Number(params.get('final_earned'));
        const rate = Number(params.get('final_rate'));
        const points = Number(params.get('final_points'));
        return firstMeasureBuildFinalSubmissionSummary(null, {
            elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : undefined,
            earned: Number.isFinite(earned) ? earned : undefined,
            rate: Number.isFinite(rate) ? rate : undefined,
            points: Number.isFinite(points) ? points : undefined
        });
    } catch (e) {
        return null;
    }
}

function firstMeasureEnsurePostSubmitModalStyles() {
    if (document.getElementById('firstMeasurePostSubmitStyles')) return;
    const style = document.createElement('style');
    style.id = 'firstMeasurePostSubmitStyles';
    style.textContent = `
        .fm-submit-modal-backdrop {
            position:fixed; inset:0; z-index:1000002; display:flex; align-items:center; justify-content:center;
            background:rgba(16,24,40,.72); backdrop-filter:blur(4px); padding:24px;
        }
        .fm-submit-modal {
            width:min(460px, 100%); background:#fff; border-radius:14px; box-shadow:0 22px 70px rgba(0,0,0,.34);
            border:1px solid rgba(255,255,255,.55); overflow:hidden; text-align:center;
        }
        .fm-submit-modal-head { padding:22px 24px 14px; }
        .fm-submit-modal-head h2 { margin:0; font-size:22px; color:#202124; }
        .fm-submit-modal-head p { margin:7px 0 0; font-size:12px; font-weight:700; color:#667085; }
        .fm-submit-stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:0 22px 18px; }
        .fm-submit-stat { border:1px solid #e6e9ef; border-radius:10px; padding:13px 12px; background:#f8fafc; }
        .fm-submit-stat .label { font-size:10px; font-weight:900; color:#667085; text-transform:uppercase; letter-spacing:.05em; }
        .fm-submit-stat .value { margin-top:5px; font-size:23px; font-weight:900; color:#111827; }
        .fm-submit-earned .value { color:#137333; }
        .fm-submit-actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:16px 22px 22px; border-top:1px solid #edf0f5; }
        .fm-submit-actions button {
            border:none; border-radius:10px; padding:12px 13px; color:#fff; font-weight:900; cursor:pointer;
            display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px;
        }
        .fm-submit-back { background:#d93025; }
        .fm-submit-next { background:#188038; }
        .fm-submit-actions button:disabled { opacity:.7; cursor:wait; }
        .fm-submit-countdown { padding:0 22px 18px; font-size:11px; font-weight:700; color:#7a8494; }
    `;
    document.head.appendChild(style);
}

function firstMeasureShowPostSubmitModal(summary = null) {
    if (document.getElementById('firstMeasurePostSubmitModal')) return;
    const finalSummary = summary || firstMeasureBuildFinalSubmissionSummary();
    firstMeasureSetSubmittedUrl(finalSummary);
    window.FIRSTMEASURE_SUBMITTED_STATE = true;
    if (typeof window.firstMeasureStopClaimTimer === 'function') window.firstMeasureStopClaimTimer();
    if (typeof window.firstMeasureStopEditorMonitors === 'function') window.firstMeasureStopEditorMonitors();
    firstMeasureEnsurePostSubmitModalStyles();

    const earnedText = `&#8369;${Math.round(Number(finalSummary.earned) || 0).toLocaleString()}`;
    const pointsText = Number.isFinite(Number(finalSummary.points))
        ? `${Number(finalSummary.points).toLocaleString()} pts at &#8369;${Number(finalSummary.rate || 0).toLocaleString()}/pt`
        : `&#8369;${Number(finalSummary.rate || 0).toLocaleString()}/pt`;
    const backdrop = document.createElement('div');
    backdrop.className = 'fm-submit-modal-backdrop';
    backdrop.id = 'firstMeasurePostSubmitModal';
    backdrop.innerHTML = `
        <div class="fm-submit-modal" role="dialog" aria-modal="true" aria-labelledby="fmSubmitTitle">
            <div class="fm-submit-modal-head">
                <h2 id="fmSubmitTitle">PDF Submitted</h2>
                <p>The project is now waiting for QA.</p>
            </div>
            <div class="fm-submit-stats">
                <div class="fm-submit-stat">
                    <div class="label">Final Time</div>
                    <div class="value">${escapeHtml(finalSummary.elapsedText || '')}</div>
                </div>
                <div class="fm-submit-stat fm-submit-earned">
                    <div class="label">Earned</div>
                    <div class="value">${earnedText}</div>
                </div>
            </div>
            <div class="fm-submit-countdown">
                ${pointsText}<br>
                Returning to dashboard in <span id="fmSubmitCountdown">5:00</span>.
            </div>
            <div class="fm-submit-actions">
                <button type="button" class="fm-submit-back" id="fmSubmitBack"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>
                <button type="button" class="fm-submit-next" id="fmSubmitNext"><i class="fas fa-clock"></i> Start Next Project</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const goDashboard = () => { window.location.href = getPostSubmitDashboardUrl(); };
    let remaining = 5 * 60;
    const countdownEl = backdrop.querySelector('#fmSubmitCountdown');
    const timer = setInterval(() => {
        remaining -= 1;
        if (countdownEl) {
            const mins = Math.floor(Math.max(0, remaining) / 60);
            const secs = Math.max(0, remaining) % 60;
            countdownEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        }
        if (remaining <= 0) {
            clearInterval(timer);
            goDashboard();
        }
    }, 1000);

    backdrop.querySelector('#fmSubmitBack')?.addEventListener('click', () => {
        clearInterval(timer);
        goDashboard();
    });
    backdrop.querySelector('#fmSubmitNext')?.addEventListener('click', async (event) => {
        clearInterval(timer);
        const btn = event.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Finding Project';
        try {
            const data = typeof window.firstMeasureClaimNextCompat === 'function'
                ? await window.firstMeasureClaimNextCompat({
                    // Do not reopen the report that was just submitted if its
                    // awaiting-review status is still propagating through the index.
                    exclude_project_id: String(window.currentProjectId || '')
                })
                : null;
            const folder = data && (data.folder || data.id || data.project_id || data.project?.id);
            if (folder) {
                window.location.href = `editor.php?folder=${encodeURIComponent(folder)}`;
                return;
            }
            alert(data?.error || data?.message || 'No project available.');
            goDashboard();
        } catch (e) {
            console.error('[Submit Modal] Failed to start next project:', e);
            alert(e?.message || 'Failed to start the next project.');
            goDashboard();
        }
    });
}
window.firstMeasureShowPostSubmitModal = firstMeasureShowPostSubmitModal;

function firstMeasureInitSubmittedStateFromUrl() {
    const hasSubmittedParam = (() => {
        try { return new URLSearchParams(window.location.search || '').has('submitted'); }
        catch (e) { return false; }
    })();
    if (!hasSubmittedParam) return;
    window.FIRSTMEASURE_SUBMITTED_STATE = true;

    let tries = 0;
    const showWhenReady = () => {
        tries += 1;
        const summary = firstMeasureReadSubmittedSummaryFromUrl();
        if (summary || tries > 30) {
            firstMeasureShowPostSubmitModal(summary || firstMeasureBuildFinalSubmissionSummary());
            return;
        }
        setTimeout(showWhenReady, 500);
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showWhenReady);
    } else {
        showWhenReady();
    }
}
firstMeasureInitSubmittedStateFromUrl();

async function submitFinalReportLegacyRegenerate() {
    const btn = document.querySelector('#finalSubmitBtn');
    if (!btn) return;

    if (window.DrafterQA && window.DrafterQA.hasNotes()) {
        if (!window.DrafterQA.checkAllHandled()) {
            alert("⚠️ Submission Blocked\n\nYou have pending QA items. Please open the QA Feedback tab, mark items as 'Fixed' or 'Disputed', and try again.");
            window.DrafterQA.show();
            return;
        }
    }

    const missingGutterStories = getMissingRequiredGutterStories(reportConfigState);
    if (missingGutterStories.length) {
        alert(`Submission blocked.\n\nSet stories for ${missingGutterStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} on the Gutters page before submitting.`);
        return;
    }

    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const setOverlay = (on, text) => {
        if (!overlay || !loadingText) return;
        overlay.style.display = on ? 'flex' : 'none';
        if (text) loadingText.innerText = text;
    };

    btn.innerText = "Generating...";
    btn.disabled = true;
    btn.className = 'fin-submit-btn disabled';

    let submitStage = 'start';
    try {
        submitStage = 'save-project-data';
        setOverlay(true, "Saving Project Data...");

        if (typeof window.saveProjectData === 'function') {
            await window.saveProjectData(true, true);
        }

        let state = reportConfigState;
        if (!state) {
            submitStage = 'capture-pdf-state';
            setOverlay(true, "Refreshing Report Data...");
            state = await captureFreshPdfStateForSubmission(window.loadedPdfConfig || null);
        } else {
            submitStage = 'capture-pdf-state';
            setOverlay(true, "Refreshing Report Data...");
            state = await captureFreshPdfStateForSubmission(state);
            reportConfigState = state;
            window.reportConfigState = state;
        }

        if (!state || blockReportFacetOverlapsForSubmission(state) || blockUnrealisticReportGeometryForSubmission(state)) {
            setOverlay(false);
            btn.innerHTML = '<i class="fas fa-file-pdf"></i> Submit PDF';
            btn.disabled = false;
            btn.className = 'fin-submit-btn enabled';
            return;
        }

        submitStage = 'render-views';
        setOverlay(true, "Rendering Views...");
        if (typeof window.updateStateImages === 'function') {
            await window.updateStateImages(state);
        }

        submitStage = 'save-pdf-snapshot';
        if (typeof window.saveStandalonePdfState === 'function') {
            try {
                await window.saveStandalonePdfState(state, { refreshImages: false });
            } catch (snapshotErr) {
                console.warn('[PDF Snapshot] Final submit save skipped:', snapshotErr);
            }
        }

        submitStage = 'generate-pdfs-local-background-sync';
        const generatedOutputs = await runSharedLocalPdfGeneration(state, setOverlay);

        submitStage = 'generate-xml';
        setOverlay(true, "Generating 3D Model XML...");
        if (typeof generateRoofXML === 'function') {
            const xmlString = generateRoofXML(state);
            if (xmlString) {
                const safeAddress = String(state.address || "Project").replace(/[^a-zA-Z0-9]/g, '');
                const xmlBlob = new Blob([xmlString], { type: "text/xml" });
                await window.firstMeasureUploadArtifact(state.folderId, xmlBlob, 'model_data.xml');
            }
        }

        // ── NEW: Upload source images and notes ──
        submitStage = 'upload-submission-sources';
        await uploadSubmissionSourcesAndPersist(state, setOverlay);
        const postSubmitSummary = firstMeasureBuildFinalSubmissionSummary(state);


        if (window.DrafterQA && window.DrafterQA.hasNotes()) {
            submitStage = 'sync-qa-notes';
            setOverlay(true, "Syncing QA Notes...");
            const qaResult = await window.DrafterQA.submitSilent();
            if (!qaResult || !qaResult.success) {
                throw new Error("Failed to sync QA responses. Please try again.");
            }
            if (qaResult.next_status) {
                await window.firstMeasureSetProjectStatus(state.folderId, qaResult.next_status);
                if (window.currentProjectManifest) window.currentProjectManifest.status = qaResult.next_status;
            }
        } else {
            submitStage = 'set-status-awaiting-review';
            await window.firstMeasureSetProjectStatus(state.folderId, 'awaiting_review');
            if (window.currentProjectManifest) window.currentProjectManifest.status = 'awaiting_review';
        }

        submitStage = 'download-generated-pdfs';
        setOverlay(true, "Downloading Reports...");
        await downloadGeneratedPdfOutputs(generatedOutputs);
        setOverlay(false);
        logPdfSubmissionDebug('submit-final-after-download', state, window.__lastPdfLocalRuntimeContext || null, window.__lastPdfLocalOutputsSpec || null, generatedOutputs);

        if (FIRSTMEASURE_KEEP_PAGE_OPEN_AFTER_PDF) {
            btn.innerHTML = '<i class="fas fa-check"></i> Done! PDF Downloaded';
            btn.disabled = false;
            btn.className = 'fin-submit-btn enabled';
            console.info('[PDF DEBUG] Staying on the editor page after PDF generation so the runtime debug log remains visible.');
            return;
        }

        closeReportConfig();
        firstMeasureShowPostSubmitModal(postSubmitSummary);

    } catch (e) {
        logPdfSubmissionError(e, submitStage, reportConfigState || window.reportConfigState || null);
        alert("Error: " + e.message);
        setOverlay(false);
        btn.innerHTML = '<i class="fas fa-file-pdf"></i> Submit PDF';
        btn.disabled = false;
        btn.className = 'fin-submit-btn enabled';
    }
}

function getReviewedPdfSyncForSubmission(state = null) {
    const folderId = String(state?.folderId || window.currentProjectId || '').trim();
    const reviewed = window.__lastFirstMeasureReviewedPdfSync || null;
    if (!reviewed || String(reviewed.folderId || '').trim() !== folderId) return null;
    const jobId = String(reviewed.jobId || reviewed.job_id || '').trim();
    const revision = String(reviewed.revision || '').trim();
    if (!jobId || !revision) return null;
    return { ...reviewed, folderId, jobId, revision };
}

function startSubmissionArtifactFinalization(state, reviewedSync) {
    const folderId = String(state?.folderId || '').trim();
    const revision = String(reviewedSync?.revision || '').trim();
    if (!folderId || !revision) return null;
    const active = window.__firstMeasureSubmissionArtifactSync;
    if (active && active.folderId === folderId && active.revision === revision) return active.promise;

    const promise = (async () => {
        console.info('[PDF SUBMIT] Optional submission artifacts are finalizing in the background.', { folderId, revision });
        if (typeof generateRoofXML === 'function' && typeof window.firstMeasureUploadArtifact === 'function') {
            const xmlString = generateRoofXML(state);
            if (xmlString) {
                const xmlBlob = new Blob([xmlString], { type: 'text/xml' });
                await window.firstMeasureUploadArtifact(folderId, xmlBlob, 'model_data.xml');
            }
        }
        await uploadSubmissionSourcesAndPersist(state, () => {});
        console.info('[PDF SUBMIT] Optional submission artifacts finished.', { folderId, revision });
    })().catch((error) => {
        console.warn('[PDF SUBMIT] The project was submitted, but optional artifact finalization failed.', {
            folderId,
            revision,
            error: error && error.message ? error.message : String(error)
        });
        return null;
    });
    window.__firstMeasureSubmissionArtifactSync = { folderId, revision, promise };
    return promise;
}

async function submitFinalReport() {
    const btn = document.querySelector('#finalSubmitBtn');
    if (!btn) return;

    if (window.DrafterQA && window.DrafterQA.hasNotes() && !window.DrafterQA.checkAllHandled()) {
        alert("Submission Blocked\n\nYou have pending QA items. Please open the QA Feedback tab, mark items as 'Fixed' or 'Disputed', and try again.");
        window.DrafterQA.show();
        return;
    }

    const state = reportConfigState || window.reportConfigState || null;
    const missingGutterStories = getMissingRequiredGutterStories(state);
    if (missingGutterStories.length) {
        alert(`Submission blocked.\n\nSet stories for ${missingGutterStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} on the Gutters page before submitting.`);
        return;
    }
    if (!state || blockReportFacetOverlapsForSubmission(state) || blockUnrealisticReportGeometryForSubmission(state)) return;

    const reviewedSync = getReviewedPdfSyncForSubmission(state);
    if (!reviewedSync) {
        alert('The reviewed PDF revision is not ready yet. Wait for the preview to finish, or click Regenerate, before submitting.');
        return;
    }

    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const setOverlay = (on, text) => {
        if (!overlay || !loadingText) return;
        overlay.style.display = on ? 'flex' : 'none';
        if (text) loadingText.innerText = text;
    };
    const syncFields = {
        pdf_sync_job_id: reviewedSync.jobId,
        pdf_sync_revision: reviewedSync.revision
    };

    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Submitting...';
    btn.disabled = true;
    btn.className = 'fin-submit-btn disabled';
    setOverlay(true, 'Submitting reviewed report...');

    let submitStage = 'submit-reviewed-revision';
    try {
        submitStage = 'save-project-data';
        setOverlay(true, 'Saving latest project changes...');
        if (typeof window.saveProjectData !== 'function') {
            throw new Error('The project save function is unavailable. The project was not submitted.');
        }
        const projectSaved = await window.saveProjectData(true, true);
        if (projectSaved !== true) {
            throw new Error('The latest project changes could not be saved. The project was not submitted.');
        }

        submitStage = 'submit-reviewed-revision';
        setOverlay(true, 'Submitting reviewed report...');
        const postSubmitSummary = firstMeasureBuildFinalSubmissionSummary(state);
        startSubmissionArtifactFinalization(state, reviewedSync);

        let response = null;
        if (window.DrafterQA && window.DrafterQA.hasNotes()) {
            submitStage = 'submit-correction-reviewed-revision';
            response = await window.DrafterQA.submitSilent(syncFields);
            if (!response || !response.success) throw new Error('Failed to submit QA responses. Please try again.');
            if (response.next_status && window.currentProjectManifest) {
                window.currentProjectManifest.status = response.next_status;
            }
        } else {
            response = await window.firstMeasureSetProjectStatus(state.folderId, 'awaiting_review', syncFields);
        }

        console.info('[PDF SUBMIT] Server accepted the reviewed PDF revision; client submission is complete.', {
            folderId: state.folderId,
            revision: reviewedSync.revision,
            jobId: reviewedSync.jobId,
            accepted: response?.accepted !== false
        });
        setOverlay(false);
        btn.innerHTML = '<i class="fas fa-check"></i> Submitted';
        closeReportConfig();
        firstMeasureShowPostSubmitModal(postSubmitSummary);
    } catch (e) {
        logPdfSubmissionError(e, submitStage, state);
        alert('Error: ' + e.message);
        setOverlay(false);
        btn.innerHTML = '<i class="fas fa-file-pdf"></i> Submit PDF';
        btn.disabled = false;
        btn.className = 'fin-submit-btn enabled';
    }
}
window.firstMeasureSubmitProject = window.firstMeasureSubmitProject || submitFinalReport;
window.submitFinalReport = function() {
    return window.firstMeasureSubmitProject.apply(this, arguments);
};


// ─────────────────────────────────────────────────────────────────────────────
// QUICK SUBMIT: Bypasses finalize checklist, generates + downloads PDF directly
// ─────────────────────────────────────────────────────────────────────────────

async function quickSubmitReportLegacyRegenerate() {
//     if (!confirm("Quick Submit will generate and download the PDF immediately, skipping the finalize checklist.\n\nContinue?")) return;
    if (window.FIRSTMEASURE_TUTORIAL && window.FIRSTMEASURE_TUTORIAL.enabled && typeof window.firstMeasureSubmitProject === 'function') {
        return window.firstMeasureSubmitProject();
    }

    const missingGutterStories = getMissingRequiredGutterStories(reportConfigState);
    if (missingGutterStories.length) {
        alert(`Quick submit blocked.\n\nSet stories for ${missingGutterStories.map((dir) => GUTTER_DIRECTION_LABELS[dir]).join(', ')} on the Gutters page before generating the PDF.`);
        return;
    }

    const btnQS = document.getElementById('btnQuickSubmit');
    const originalBtnHtml = btnQS ? btnQS.innerHTML : '';

    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const setOverlay = (on, text) => {
        if (!overlay || !loadingText) return;
        overlay.style.display = on ? 'flex' : 'none';
        if (text) loadingText.innerText = text;
    };

    if (btnQS) {
        btnQS.disabled = true;
        btnQS.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
    }

    try {
        setOverlay(true, "Saving Project Data...");

        if (typeof window.saveProjectData === 'function') {
            await window.saveProjectData(true, true);
        }

        let state = reportConfigState;
        if (!state) {
            setOverlay(true, "Refreshing Report Data...");
            state = await captureFreshPdfStateForSubmission(window.loadedPdfConfig || null);
        } else {
            setOverlay(true, "Refreshing Report Data...");
            state = await captureFreshPdfStateForSubmission(state);
            reportConfigState = state;
            window.reportConfigState = state;
        }

        if (!state || blockReportFacetOverlapsForSubmission(state) || blockUnrealisticReportGeometryForSubmission(state)) {
            setOverlay(false);
            if (btnQS) {
                btnQS.disabled = false;
                btnQS.innerHTML = originalBtnHtml;
            }
            return;
        }

        setOverlay(true, "Rendering Views...");
        if (typeof window.updateStateImages === 'function') {
            await window.updateStateImages(state);
        }

        if (typeof window.saveStandalonePdfState === 'function') {
            try {
                await window.saveStandalonePdfState(state, { refreshImages: false });
            } catch (snapshotErr) {
                console.warn('[PDF Snapshot] Quick submit save skipped:', snapshotErr);
            }
        }

        const generatedOutputs = await runSharedLocalPdfGeneration(state, setOverlay);

        setOverlay(true, "Generating 3D Model XML...");
        if (typeof generateRoofXML === 'function') {
            const xmlString = generateRoofXML(state);
            if (xmlString) {
                const safeAddress = String(state.address || "Project").replace(/[^a-zA-Z0-9]/g, '');
                const xmlBlob = new Blob([xmlString], { type: "text/xml" });
                await window.firstMeasureUploadArtifact(state.folderId, xmlBlob, 'model_data.xml');
            }
        }

        // Upload source notes if any exist
        await uploadSubmissionSourcesAndPersist(state, setOverlay);

        await window.firstMeasureSetProjectStatus(state.folderId, 'awaiting_review');

        setOverlay(true, "Downloading Reports...");
        await downloadGeneratedPdfOutputs(generatedOutputs);

        setOverlay(false);

        logPdfSubmissionDebug('quick-submit-after-download', state, window.__lastPdfLocalRuntimeContext || null, window.__lastPdfLocalOutputsSpec || null, generatedOutputs);

        if (FIRSTMEASURE_KEEP_PAGE_OPEN_AFTER_PDF) {
            if (btnQS) {
                btnQS.innerHTML = '<i class="fas fa-check"></i> Done! PDF Downloaded';
                btnQS.disabled = false;
            }
            console.info('[PDF DEBUG] Staying on the editor page after quick submit so the runtime debug log remains visible.');
            return;
        }

        closeReportConfig();
        window.location.href = './';

    } catch (e) {
        console.error(e);
        alert("Error: " + e.message);
        setOverlay(false);
        if (btnQS) {
            btnQS.innerHTML = originalBtnHtml;
            btnQS.style.background = '#d93025';
            btnQS.disabled = false;
        }
    }
}

async function quickSubmitReport() {
    console.info('[PDF SUBMIT] Quick submit now opens the local preview so submission can reuse an accepted server revision.');
    if (!reportConfigState) await openReportConfiguration();
    goToFinalizePage();
}
window.quickSubmitReport = quickSubmitReport;

// -----------------------------
// UTILS
// -----------------------------
function clampNumber(v, min, max, fallback) { if (Number.isNaN(v) || v == null) return fallback; return Math.max(min, Math.min(max, v)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function escapeHtml(str) { return String(str || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

function sanitizePitchNumber(s) {
    let t = String(s || '').trim();
    if (!t) return '';
    t = t.replace(/[^0-9.]/g, '');
    const parts = t.split('.');
    if (parts.length > 2) t = parts[0] + '.' + parts.slice(1).join('');
    if (t.startsWith('.')) t = '0' + t;
    if (t.length > 5) t = t.slice(0, 5);
    if (t === '.') t = '0.';
    return t;
}

async function getPlaceholderImage(text) {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 450;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#555'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(text, c.width / 2, c.height / 2);
    return c.toDataURL();
}

function countRealFacets(state, layerNum = null) {
  const excluded = (typeof getReportExcludedSignatureSet === 'function')
    ? getReportExcludedSignatureSet(state)
    : new Set();
  const autoExcluded = (typeof getReportAutoExcludedFaceIndexSet === 'function')
    ? getReportAutoExcludedFaceIndexSet(state)
    : new Set();
  const faces = (state.facesData || []).filter((f, idx) => {
    if (!f || !Array.isArray(f.points)) return false;
    if (autoExcluded.has(idx)) return false;
    if (isObstacleFace(f, state.report)) return false;
    const sig = (typeof getLocalFaceSignatureReport === 'function')
      ? getLocalFaceSignatureReport(f.points)
      : null;
    return !sig || !excluded.has(sig);
  });
  const filtered = layerNum ? faces.filter(f => (f.layer || 1) === layerNum) : faces;
  return filtered.length;
}
