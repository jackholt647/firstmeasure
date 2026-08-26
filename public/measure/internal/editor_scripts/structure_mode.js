(function () {
    const state = {
        active: 'all',
        memberships: new WeakMap(),
        components: [],
        statuses: new Map(),
        globalContext: null,
        localContext: null,
        structuresArtifact: null,
        supplemental: new Map(),
        imageryStatuses: new Map(),
        loadingPromises: new Map(),
        preloadStartedForProject: null,
        preloadCancelled: 0,
        loading: null
    };

    function getPins() {
        const pins = window.currentProjectManifest && Array.isArray(window.currentProjectManifest.pins)
            ? window.currentProjectManifest.pins
            : [];
        return pins;
    }

    function hasMultiplePins() {
        return getPins().length > 1;
    }

    function getManifestGlobalProjectionContext() {
        const manifest = window.currentProjectManifest || {};
        const meta = window.currentProjectLoadedAppMetadata || {};
        const centerLat = Number(manifest.lat ?? manifest.source_lat ?? meta.lat ?? meta.source_lat);
        const centerLng = Number(manifest.lng ?? manifest.source_lng ?? meta.lng ?? meta.source_lng);
        const radius = Number(manifest.radius_meters ?? meta.radius_meters ?? (window.getRadiusMeters ? window.getRadiusMeters() : window.RADIUS_METERS));
        const preferDisplayedAllImage = state.active === 'all' && !window.__structureLocalImageryActive;
        const width = Number(preferDisplayedAllImage ? (imageWidth || meta.imageWidth) : (meta.imageWidth || imageWidth));
        const height = Number(preferDisplayedAllImage ? (imageHeight || meta.imageHeight) : (meta.imageHeight || imageHeight));
        const metersPerPx = Number(
            preferDisplayedAllImage && window.getMetersPerPx
                ? window.getMetersPerPx()
                : (meta.imageMetersPerPx || (window.getSolarPixelSizeMeters ? window.getSolarPixelSizeMeters(radius) : 0))
        );
        const ctx = { centerLat, centerLng, radius, width, height, metersPerPx };
        return isValidContext(ctx) ? ctx : null;
    }

    function getPinProjectionContext(options = {}) {
        const forceGlobal = options.context === 'global';
        const activeIsGlobal = state.active === 'all' || !window.__structureLocalImageryActive;
        if (forceGlobal || activeIsGlobal) {
            if (isValidContext(state.globalContext)) return state.globalContext;
            const manifestCtx = getManifestGlobalProjectionContext();
            if (manifestCtx) return manifestCtx;
        }
        return getCurrentImageContext();
    }

    function projectPin(pin, options = {}) {
        if (!pin || !Number.isFinite(Number(pin.lat)) || !Number.isFinite(Number(pin.lng))) return null;
        const ctx = getPinProjectionContext(options);
        if (!isValidContext(ctx)) return null;

        const centerLat = Number(ctx.centerLat);
        const centerLng = Number(ctx.centerLng);
        const mLat = 111132;
        const mLng = 111132 * Math.cos(centerLat * (Math.PI / 180));
        const metersPerPx = getContextMetersPerPx(ctx);
        if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;

        const dLat = (Number(pin.lat) - centerLat) * mLat;
        const dLng = (Number(pin.lng) - centerLng) * mLng;
        return {
            rawX: (Number(ctx.width) / 2) + (dLng / metersPerPx),
            rawY: (Number(ctx.height) / 2) - (dLat / metersPerPx)
        };
    }

    function getCurrentImageContext() {
        return {
            centerLat: Number(mapCenterLat),
            centerLng: Number(mapCenterLng),
            radius: window.getRadiusMeters ? Number(window.getRadiusMeters()) : Number(window.RADIUS_METERS || 20),
            width: Number(imageWidth),
            height: Number(imageHeight),
            metersPerPx: window.getMetersPerPx ? Number(window.getMetersPerPx()) : getContextMetersPerPx({ radius: window.RADIUS_METERS || 20, width: imageWidth }),
            layerData,
            roofMaskData,
            viewCanvases,
            adjustedViewCanvases,
            maskedViewCanvases
        };
    }

    function isValidContext(ctx) {
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

    function getContextMetersPerPx(ctx) {
        const explicit = Number(ctx && ctx.metersPerPx);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const radius = Number(ctx && ctx.radius);
        const width = Number(ctx && ctx.width);
        return (Number.isFinite(radius) && radius > 0 && Number.isFinite(width) && width > 0)
            ? (radius * 2) / width
            : 0;
    }

    function imagePointToLatLng(pt, ctx) {
        if (!pt || !isValidContext(ctx)) return null;
        const mLat = 111132;
        const mLng = 111132 * Math.cos(ctx.centerLat * Math.PI / 180);
        const metersPerPx = getContextMetersPerPx(ctx);
        return {
            lat: ctx.centerLat + (((ctx.height / 2) - Number(pt.y || 0)) * metersPerPx / mLat),
            lng: ctx.centerLng + ((Number(pt.x || 0) - (ctx.width / 2)) * metersPerPx / mLng)
        };
    }

    function latLngToImagePoint(latLng, ctx) {
        if (!latLng || !isValidContext(ctx)) return null;
        const mLat = 111132;
        const mLng = 111132 * Math.cos(ctx.centerLat * Math.PI / 180);
        const metersPerPx = getContextMetersPerPx(ctx);
        return {
            x: (ctx.width / 2) + (((Number(latLng.lng) - ctx.centerLng) * mLng) / metersPerPx),
            y: (ctx.height / 2) - (((Number(latLng.lat) - ctx.centerLat) * mLat) / metersPerPx)
        };
    }

    function reprojectGeometry(fromCtx, toCtx) {
        if (!activeGeometry || !isValidContext(fromCtx) || !isValidContext(toCtx)) return;
        const items = [
            ...(Array.isArray(activeGeometry.points) ? activeGeometry.points : []),
            ...(Array.isArray(activeGeometry.vents) ? activeGeometry.vents : [])
        ];
        items.forEach(item => {
            const ll = imagePointToLatLng(item, fromCtx);
            const next = latLngToImagePoint(ll, toCtx);
            if (!next) return;
            item.x = next.x;
            item.y = next.y;
        });
        window.__geoMutStamp = (window.__geoMutStamp || 0) + 1;
    }

    function projectItemToContext(item, fromCtx, toCtx) {
        const ll = imagePointToLatLng(item, fromCtx);
        const next = latLngToImagePoint(ll, toCtx);
        return next || {
            x: item ? item.x : undefined,
            y: item ? item.y : undefined
        };
    }

    function serializeGeometryForGlobalSave(resolvedFacesSource) {
        if (!window.__structureLocalImageryActive || !state.globalContext || !activeGeometry || !Array.isArray(activeGeometry.points)) {
            return null;
        }
        const localCtx = getCurrentImageContext();
        const globalCtx = state.globalContext;
        if (!isValidContext(localCtx) || !isValidContext(globalCtx)) return null;

        const geoPoints = activeGeometry.points || [];
        const geoConnections = Array.isArray(activeGeometry.connections) ? activeGeometry.connections : [];
        const pointIndex = new Map();
        const serializedPoints = geoPoints.map((p, idx) => {
            pointIndex.set(p, idx);
            const projected = projectItemToContext(p, localCtx, globalCtx);
            return {
                x: projected.x,
                y: projected.y,
                z: p.z,
                layer: (p.layer || 1),
                zLocked: p.zLocked
            };
        });

        const serializeFace = (face) => ({
            layer: face.layer || 1,
            pointIndices: (face.points || []).map(pt => pointIndex.get(pt)).filter(idx => idx >= 0),
            holeIndices: (face.holes || []).map(holePoly =>
                holePoly.map(pt => pointIndex.get(pt)).filter(idx => idx >= 0)
            )
        });

        return {
            imageWidth: globalCtx.width,
            imageHeight: globalCtx.height,
            imageMetersPerPx: getContextMetersPerPx(globalCtx),
            geometry: {
                points: serializedPoints,
                connections: geoConnections.map(c => ({
                    startIdx: pointIndex.get(c.start),
                    endIdx: pointIndex.get(c.end),
                    type: c.type,
                    manualType: !!c.manualType
                })).filter(c => c.startIdx >= 0 && c.endIdx >= 0),
                vents: (activeGeometry.vents || []).map(v => {
                    const projected = projectItemToContext(v, localCtx, globalCtx);
                    return { ...v, x: projected.x, y: projected.y };
                }),
                manualFaces: (activeGeometry.manualFaces || [])
                    .map(serializeFace)
                    .filter(face => Array.isArray(face.pointIndices) && face.pointIndices.length >= 3),
                resolvedFaces: (Array.isArray(resolvedFacesSource) ? resolvedFacesSource : [])
                    .map(serializeFace)
                    .filter(face => Array.isArray(face.pointIndices) && face.pointIndices.length >= 3),
                deletedFaceSignatures: (typeof deletedFaceSignatures !== 'undefined')
                    ? Array.from(deletedFaceSignatures)
                    : []
            }
        };
    }

    function applyImageContext(ctx, options = {}) {
        const shouldRender = options.render !== false;
        mapCenterLat = ctx.centerLat;
        mapCenterLng = ctx.centerLng;
        if (window.setRadiusMeters) window.setRadiusMeters(ctx.radius, { persist: state.active === 'all' });
        else window.RADIUS_METERS = ctx.radius;
        if (window.setImageMetersPerPx) window.setImageMetersPerPx(getContextMetersPerPx(ctx));
        else window.IMAGE_METERS_PER_PX = getContextMetersPerPx(ctx);
        imageWidth = ctx.width;
        imageHeight = ctx.height;
        layerData = ctx.layerData;
        roofMaskData = ctx.roofMaskData || null;
        viewCanvases = ctx.viewCanvases || {};
        adjustedViewCanvases = ctx.adjustedViewCanvases || {};
        maskedViewCanvases = ctx.maskedViewCanvases || {};
        if (!shouldRender) return;
        if (typeof setupView === 'function') setupView();
        if (typeof rebuildViewConfigs === 'function') rebuildViewConfigs();
        if (typeof buildThumbGrid === 'function') buildThumbGrid();
        if (typeof redrawThumbs === 'function') redrawThumbs();
        if (typeof redrawCanvas === 'function') redrawCanvas();
        if (layerData.rgb && layerData.dsm && typeof init3D === 'function') init3D();
    }

    function unionBoundsFromStructure(structure, fallbackPin) {
        const boxes = [];
        const segments = structure && structure.insights && structure.insights.solarPotential
            ? structure.insights.solarPotential.roofSegmentStats
            : [];
        (Array.isArray(segments) ? segments : []).forEach(seg => {
            const box = seg && seg.boundingBox;
            if (!box || !box.sw || !box.ne) return;
            boxes.push({
                sw: { lat: Number(box.sw.latitude), lng: Number(box.sw.longitude) },
                ne: { lat: Number(box.ne.latitude), lng: Number(box.ne.longitude) }
            });
        });
        if (!boxes.length && fallbackPin) {
            const lat = Number(fallbackPin.lat);
            const lng = Number(fallbackPin.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                const dLat = 20 / 111132;
                const dLng = 20 / (111132 * Math.cos(lat * Math.PI / 180));
                boxes.push({ sw: { lat: lat - dLat, lng: lng - dLng }, ne: { lat: lat + dLat, lng: lng + dLng } });
            }
        }
        if (!boxes.length) return null;
        return boxes.reduce((acc, box) => ({
            sw: { lat: Math.min(acc.sw.lat, box.sw.lat), lng: Math.min(acc.sw.lng, box.sw.lng) },
            ne: { lat: Math.max(acc.ne.lat, box.ne.lat), lng: Math.max(acc.ne.lng, box.ne.lng) }
        }));
    }

    function captureFromBounds(bounds) {
        const centerLat = (bounds.sw.lat + bounds.ne.lat) / 2;
        const centerLng = (bounds.sw.lng + bounds.ne.lng) / 2;
        const mLat = 111132;
        const mLng = 111132 * Math.cos(centerLat * Math.PI / 180);
        const corners = [
            bounds.sw,
            bounds.ne,
            { lat: bounds.sw.lat, lng: bounds.ne.lng },
            { lat: bounds.ne.lat, lng: bounds.sw.lng }
        ];
        const radius = Math.max(20, Math.min(100, Math.ceil(Math.max(...corners.map(c => Math.hypot((c.lat - centerLat) * mLat, (c.lng - centerLng) * mLng))) + 12)));
        return { centerLat, centerLng, radius };
    }

    async function loadStructuresArtifact() {
        if (state.structuresArtifact) return state.structuresArtifact;
        const assets = window.currentProjectAssets || {};
        const url = assets['instant-structures'];
        if (!url) return null;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Unable to load structure metadata (${res.status})`);
        state.structuresArtifact = await res.json();
        return state.structuresArtifact;
    }

    async function fetchTiffRastersAndBlob(url, centerLat = mapCenterLat) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`TIFF fetch failed (${response.status})`);
        const buffer = await response.arrayBuffer();
        const tiff = await GeoTIFF.fromArrayBuffer(buffer);
        const image = await tiff.getImage();
        return {
            width: image.getWidth(),
            height: image.getHeight(),
            metersPerPx: resolveTiffMetersPerPx(image, centerLat),
            rasters: await image.readRasters(),
            blob: new Blob([buffer], { type: 'image/tiff' })
        };
    }

    async function fetchTiffRastersOnly(url, centerLat = mapCenterLat) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`TIFF fetch failed (${response.status})`);
        const buffer = await response.arrayBuffer();
        const tiff = await GeoTIFF.fromArrayBuffer(buffer);
        const image = await tiff.getImage();
        return {
            width: image.getWidth(),
            height: image.getHeight(),
            metersPerPx: resolveTiffMetersPerPx(image, centerLat),
            rasters: await image.readRasters()
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

    function setImageryStatus(index, status) {
        state.imageryStatuses.set(index, status);
        renderBar();
    }

    function getSupplementalAssetUrls(index) {
        const assets = window.currentProjectAssets || {};
        return {
            rgb: assets[`structure-${index}-rgb`] || null,
            dsm: assets[`structure-${index}-dsm`] || null,
            mask: assets[`structure-${index}-mask`] || null,
            apple: assets[`structure-${index}-apple`] || null
        };
    }

    function buildSupplementalContext(index, capture, rgb, dsm, mask) {
        return {
            centerLat: capture.centerLat,
            centerLng: capture.centerLng,
            radius: capture.radius,
            width: rgb.width,
            height: rgb.height,
            metersPerPx: rgb.metersPerPx || 0.1,
            layerData: { rgb: rgb.rasters, dsm: dsm.rasters, mask: mask ? mask.rasters : null, google: null, azure: null, apple: null },
            roofMaskData: mask && mask.rasters ? mask.rasters[0] : null,
            viewCanvases: {},
            adjustedViewCanvases: {},
            maskedViewCanvases: {}
        };
    }

    function resolveCaptureForStructure(index, artifact) {
        const pins = getPins();
        const structure = artifact && Array.isArray(artifact.structures)
            ? artifact.structures.find(s => Number(s.pin_index) === index - 1) || artifact.structures[index - 1]
            : null;
        const bounds = unionBoundsFromStructure(structure, pins[index - 1]);
        return bounds ? captureFromBounds(bounds) : null;
    }

    async function fetchSupplementalSolar(index) {
        const cached = state.supplemental.get(index);
        if (cached) return cached;
        if (state.loadingPromises.has(index)) return state.loadingPromises.get(index);

        const promise = (async () => {
        setImageryStatus(index, 'loading');
        const pins = getPins();
        const artifact = await loadStructuresArtifact();
        const capture = resolveCaptureForStructure(index, artifact);
        if (!capture) throw new Error(`Unable to determine bounds for structure ${index}.`);

        const saved = getSupplementalAssetUrls(index);
        if (saved.rgb && saved.dsm) {
            const [rgb, dsm, mask] = await Promise.all([
                fetchTiffRastersOnly(saved.rgb, capture.centerLat),
                fetchTiffRastersOnly(saved.dsm, capture.centerLat),
                saved.mask ? fetchTiffRastersOnly(saved.mask, capture.centerLat) : Promise.resolve(null)
            ]);
            const supplemental = { index, capture, context: buildSupplementalContext(index, capture, rgb, dsm, mask), source: 'artifact' };
            state.supplemental.set(index, supplemental);
            setImageryStatus(index, 'ready');
            return supplemental;
        }

        const url = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${capture.centerLat}&location.longitude=${capture.centerLng}&radius_meters=${capture.radius}&view=FULL_LAYERS&requiredQuality=LOW&pixelSizeMeters=0.1&key=${GOOGLE_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.rgbUrl || !data.dsmUrl) throw new Error(`Solar layers missing for structure ${index}.`);
        const [rgb, dsm, mask] = await Promise.all([
            fetchTiffRastersAndBlob(data.rgbUrl + `&key=${GOOGLE_API_KEY}`, capture.centerLat),
            fetchTiffRastersAndBlob(data.dsmUrl + `&key=${GOOGLE_API_KEY}`, capture.centerLat),
            data.maskUrl ? fetchTiffRastersAndBlob(data.maskUrl + `&key=${GOOGLE_API_KEY}`, capture.centerLat) : Promise.resolve(null)
        ]);
        const supplemental = { index, capture, context: buildSupplementalContext(index, capture, rgb, dsm, mask), source: 'solar' };
        state.supplemental.set(index, supplemental);

        if (typeof window.saveProjectArtifactBlob === 'function') {
            window.saveProjectArtifactBlob(`structure-${index}-rgb.tif`, rgb.blob).catch(err => console.warn('[Structures] Supplemental RGB upload failed:', err));
            window.saveProjectArtifactBlob(`structure-${index}-dsm.tif`, dsm.blob).catch(err => console.warn('[Structures] Supplemental DSM upload failed:', err));
            if (mask) window.saveProjectArtifactBlob(`structure-${index}-mask.tif`, mask.blob).catch(err => console.warn('[Structures] Supplemental mask upload failed:', err));
        }
        setImageryStatus(index, 'ready');
        return supplemental;
        })().catch(error => {
            setImageryStatus(index, 'error');
            throw error;
        }).finally(() => {
            state.loadingPromises.delete(index);
        });
        state.loadingPromises.set(index, promise);
        return promise;
    }

    async function switchToStructureContext(index) {
        const current = getCurrentImageContext();
        if (!state.globalContext || !state.localContext) {
            state.globalContext = current;
        }
        const supplemental = await fetchSupplementalSolar(index);
        const nextCtx = supplemental.context;
        reprojectGeometry(current, nextCtx);
        state.localContext = nextCtx;
        window.__structureLocalImageryActive = true;
        window.__activeStructureSupplementalIndex = index;
        applyImageContext(nextCtx);
    }

    function switchToGlobalContext() {
        if (!state.globalContext || !state.localContext) return;
        const current = getCurrentImageContext();
        reprojectGeometry(current, state.globalContext);
        state.localContext = null;
        window.__structureLocalImageryActive = false;
        window.__activeStructureSupplementalIndex = null;
        applyImageContext(state.globalContext);
    }

    async function withGlobalImageContext(callback) {
        if (!window.__structureLocalImageryActive || !state.globalContext || !state.localContext) {
            return await callback();
        }

        const previousLocalContext = state.localContext;
        const current = getCurrentImageContext();
        reprojectGeometry(current, state.globalContext);
        window.__structureLocalImageryActive = false;
        window.__activeStructureSupplementalIndex = null;
        applyImageContext(state.globalContext, { render: false });

        try {
            return await callback();
        } finally {
            const globalNow = getCurrentImageContext();
            reprojectGeometry(globalNow, previousLocalContext);
            state.localContext = previousLocalContext;
            window.__structureLocalImageryActive = true;
            window.__activeStructureSupplementalIndex = getActiveIndex();
            applyImageContext(previousLocalContext, { render: true });
            if (typeof renderGeometry2D === 'function') renderGeometry2D();
            if (typeof renderGeometry3D === 'function') renderGeometry3D();
            if (typeof renderFinalPass === 'function') renderFinalPass(false);
            setTimeout(() => {
                if (typeof recenterMap === 'function') recenterMap();
            }, 80);
        }
    }

    function rebuildMemberships() {
        state.memberships = new WeakMap();
        state.components = [];
        const pins = getPins();
        if (!activeGeometry || !Array.isArray(activeGeometry.points) || !Array.isArray(activeGeometry.connections) || pins.length <= 1) {
            return;
        }

        const pinPts = pins.map(projectPin);
        const adj = new Map();
        activeGeometry.points.forEach(p => adj.set(p, []));
        activeGeometry.connections.forEach(conn => {
            if (!conn || !conn.start || !conn.end) return;
            if (!adj.has(conn.start)) adj.set(conn.start, []);
            if (!adj.has(conn.end)) adj.set(conn.end, []);
            adj.get(conn.start).push(conn.end);
            adj.get(conn.end).push(conn.start);
        });

        const seen = new Set();
        activeGeometry.points.forEach(start => {
            if (seen.has(start)) return;
            const stack = [start];
            const points = [];
            seen.add(start);
            while (stack.length) {
                const p = stack.pop();
                points.push(p);
                (adj.get(p) || []).forEach(next => {
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                });
            }
            if (!points.length) return;
            const center = points.reduce((acc, p) => ({ x: acc.x + (p.x || 0), y: acc.y + (p.y || 0) }), { x: 0, y: 0 });
            center.x /= points.length;
            center.y /= points.length;
            let bestIdx = 0;
            let bestD = Infinity;
            pinPts.forEach((pinPt, idx) => {
                if (!pinPt) return;
                const d = Math.hypot(center.x - pinPt.rawX, center.y - pinPt.rawY);
                if (d < bestD) {
                    bestD = d;
                    bestIdx = idx;
                }
            });
            points.forEach(p => state.memberships.set(p, bestIdx + 1));
            state.components.push({ index: bestIdx + 1, points });
        });

        if (Array.isArray(activeGeometry.vents)) {
            activeGeometry.vents.forEach(v => {
                let bestIdx = 0;
                let bestD = Infinity;
                pinPts.forEach((pinPt, idx) => {
                    if (!pinPt) return;
                    const d = Math.hypot((v.x || 0) - pinPt.rawX, (v.y || 0) - pinPt.rawY);
                    if (d < bestD) {
                        bestD = d;
                        bestIdx = idx;
                    }
                });
                state.memberships.set(v, bestIdx + 1);
            });
        }
    }

    function getActiveIndex() {
        return Number.isInteger(state.active) ? state.active : null;
    }

    function pointInActiveStructure(pt) {
        const idx = getActiveIndex();
        if (!idx || !hasMultiplePins()) return true;
        if (!pt || typeof pt !== 'object') return false;
        if (!state.memberships.has(pt)) rebuildMemberships();
        return state.memberships.get(pt) === idx;
    }

    function connectionInActiveStructure(conn) {
        if (!conn) return false;
        return pointInActiveStructure(conn.start) && pointInActiveStructure(conn.end);
    }

    function faceInActiveStructure(face) {
        if (!face || !Array.isArray(face.points) || !face.points.length) return false;
        return face.points.some(pointInActiveStructure);
    }

    function getScopedGeometry() {
        const idx = getActiveIndex();
        if (!idx || !hasMultiplePins() || !activeGeometry) return null;
        rebuildMemberships();
        const points = (activeGeometry.points || []).filter(pointInActiveStructure);
        const pointSet = new Set(points);
        const connections = (activeGeometry.connections || []).filter(conn => pointSet.has(conn.start) && pointSet.has(conn.end));
        const vents = (activeGeometry.vents || []).filter(v => state.memberships.get(v) === idx);
        const manualFaces = (activeGeometry.manualFaces || []).filter(face => (face.points || []).every(p => pointSet.has(p)));
        return { points, connections, vents, manualFaces };
    }

    function withScope(callback) {
        if (window.__structureModeForceAll || window.__structureScopeApplying) return callback();
        const scoped = getScopedGeometry();
        if (!scoped) return callback();
        const original = activeGeometry;
        window.__structureScopeApplying = true;
        activeGeometry = scoped;
        try {
            return callback();
        } finally {
            activeGeometry = original;
            window.__structureScopeApplying = false;
        }
    }

    function withAll(callback) {
        const previous = window.__structureModeForceAll;
        window.__structureModeForceAll = true;
        let deferred = false;
        try {
            const result = callback();
            if (result && typeof result.then === 'function') {
                deferred = true;
                return result.finally(() => {
                    window.__structureModeForceAll = previous;
                });
            }
            window.__structureModeForceAll = previous;
            return result;
        } finally {
            if (!deferred && window.__structureModeForceAll === true && previous !== true) {
                window.__structureModeForceAll = previous;
            }
        }
    }

    function getFilteredFaces(faces) {
        if (!Array.isArray(faces)) return faces;
        const idx = getActiveIndex();
        if (!idx || !hasMultiplePins() || window.__structureModeForceAll) return faces;
        return faces.filter(faceInActiveStructure);
    }

    function refreshStatusesFromFaces(faces) {
        const pins = getPins();
        if (pins.length <= 1) return;
        const activeIdx = getActiveIndex();
        const facesList = Array.isArray(faces) ? faces : [];
        const indexes = activeIdx ? [activeIdx] : pins.map((_, idx) => idx + 1);
        indexes.forEach(idx => {
            const pinPt = projectPin(pins[idx - 1]);
            if (!pinPt) {
                state.statuses.set(idx, false);
                return;
            }
            const hasFace = facesList.some(face => {
                if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
                if (activeIdx && !faceInActiveStructure(face)) return false;
                if (typeof isPointInPoly === 'function') return isPointInPoly(pinPt.rawX, pinPt.rawY, face.points);
                return false;
            });
            state.statuses.set(idx, hasFace);
        });
        renderBar();
    }

    async function selectStructure(value) {
        const next = value === 'all' ? 'all' : parseInt(value, 10);
        const previous = state.active;
        state.active = value === 'all' ? 'all' : parseInt(value, 10);
        if (typeof selectedPoints !== 'undefined') selectedPoints.clear();
        if (typeof selectedLines !== 'undefined') selectedLines.clear();
        if (typeof selectedVents !== 'undefined') selectedVents.clear();
        if (typeof selectedFaceSignatures !== 'undefined') selectedFaceSignatures.clear();
        if (typeof window.invalidateFaceCache === 'function') window.invalidateFaceCache();
        renderBar();
        try {
            state.loading = next;
            if (next === 'all') {
                switchToGlobalContext();
            } else if (Number.isInteger(next) && hasMultiplePins()) {
                await switchToStructureContext(next);
            }
        } catch (err) {
            console.error('[Structures] Failed to switch structure imagery:', err);
            state.active = previous;
            renderBar();
            alert(err.message || 'Failed to load structure imagery.');
        } finally {
            state.loading = null;
        }
        rebuildMemberships();
        if (typeof renderGeometry2D === 'function') renderGeometry2D();
        if (typeof renderGeometry3D === 'function') renderGeometry3D();
        if (typeof renderFinalPass === 'function') renderFinalPass(false);
        setTimeout(() => {
            if (typeof recenterMap === 'function') recenterMap();
            if (typeof window.syncQuadMaps === 'function') window.syncQuadMaps();
        }, 80);
    }

    function renderBar() {
        const bar = document.getElementById('structure-mode-bar');
        if (!bar) return;
        const pins = getPins();
        if (pins.length <= 1) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'flex';
        bar.innerHTML = '';
        const label = document.createElement('span');
        label.className = 'structure-mode-label';
        label.textContent = 'Structures';
        bar.appendChild(label);

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = 'structure-mode-btn' + (state.active === 'all' ? ' active' : '');
        allBtn.textContent = 'All';
        allBtn.onclick = () => selectStructure('all');
        bar.appendChild(allBtn);

        pins.forEach((pin, idx) => {
            const num = idx + 1;
            const btn = document.createElement('button');
            btn.type = 'button';
            const known = state.statuses.has(num) ? state.statuses.get(num) : false;
            const imageryStatus = state.imageryStatuses.get(num) || 'queued';
            btn.className = 'structure-mode-btn structure-status-' + (known ? 'done' : 'missing')
                + ' structure-imagery-' + imageryStatus
                + (state.active === num ? ' active' : '');
            btn.textContent = (state.loading === num || imageryStatus === 'loading') ? `${num}...` : String(num);
            const drawText = known ? 'Structure has a face under its pin' : 'No face confirmed under this structure pin yet';
            const imageryText = imageryStatus === 'ready'
                ? 'high-resolution imagery loaded'
                : imageryStatus === 'loading'
                    ? 'high-resolution imagery loading'
                    : imageryStatus === 'error'
                        ? 'high-resolution imagery failed to load'
                        : 'high-resolution imagery queued';
            btn.title = `${drawText}; ${imageryText}`;
            btn.onclick = () => selectStructure(num);
            bar.appendChild(btn);
        });
    }

    async function preloadSupplementalImagerySequentially() {
        const pins = getPins();
        if (pins.length <= 1 || !window.currentProjectId) return;
        const projectId = window.currentProjectId;
        if (state.preloadStartedForProject === projectId) return;
        state.preloadStartedForProject = projectId;
        const token = ++state.preloadCancelled;
        pins.forEach((_, idx) => {
            if (!state.imageryStatuses.has(idx + 1)) state.imageryStatuses.set(idx + 1, 'queued');
        });
        renderBar();

        for (let i = 1; i <= pins.length; i++) {
            if (token !== state.preloadCancelled || window.currentProjectId !== projectId) return;
            if (state.supplemental.has(i)) {
                setImageryStatus(i, 'ready');
                continue;
            }
            try {
                await fetchSupplementalSolar(i);
            } catch (err) {
                console.warn(`[Structures] Supplemental imagery preload failed for structure ${i}:`, err);
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }

    window.structureModeState = state;
    window.refreshStructureMode = function () {
        const pins = getPins();
        if (Number.isInteger(state.active) && (state.active < 1 || state.active > pins.length)) state.active = 'all';
        if (window.currentProjectId !== state.preloadStartedForProject) {
            state.supplemental.clear();
            state.loadingPromises.clear();
            state.imageryStatuses.clear();
            state.structuresArtifact = null;
            state.globalContext = null;
            state.localContext = null;
            window.__structureLocalImageryActive = false;
            window.__activeStructureSupplementalIndex = null;
            state.preloadCancelled += 1;
        }
        if (state.active === 'all' && !window.__structureLocalImageryActive) {
            const ctx = getManifestGlobalProjectionContext() || getCurrentImageContext();
            if (isValidContext(ctx)) state.globalContext = ctx;
        }
        rebuildMemberships();
        renderBar();
    };
    window.projectStructurePinToImage = projectPin;
    window.projectStructurePinToGlobalImage = function (pin) {
        return projectPin(pin, { context: 'global' });
    };
    window.isItemInActiveStructure = function (item) {
        if (!item) return false;
        if (item.start && item.end) return connectionInActiveStructure(item);
        if (Array.isArray(item.points)) return faceInActiveStructure(item);
        return pointInActiveStructure(item);
    };
    window.getStructureScopedGeometry = getScopedGeometry;
    window.withStructureModeScope = withScope;
    window.withAllStructuresEnabled = withAll;
    window.withGlobalImageContextForProjectSave = withGlobalImageContext;
    window.serializeStructureModeGeometryForSave = serializeGeometryForGlobalSave;
    window.getStructureModeGlobalCenter = function () {
        const ctx = state.globalContext;
        if (ctx && Number.isFinite(Number(ctx.centerLat)) && Number.isFinite(Number(ctx.centerLng))) {
            return { lat: Number(ctx.centerLat), lng: Number(ctx.centerLng) };
        }
        if (Number.isFinite(Number(mapCenterLat)) && Number.isFinite(Number(mapCenterLng))) {
            return { lat: Number(mapCenterLat), lng: Number(mapCenterLng) };
        }
        return null;
    };
    window.getStructureFilteredFaces = getFilteredFaces;
    window.refreshStructureStatusesFromFaces = refreshStatusesFromFaces;
    window.selectStructureMode = selectStructure;
    window.scheduleStructureSupplementalPreload = preloadSupplementalImagerySequentially;
})();
