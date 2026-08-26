/* geometry_core.js
 *
 * - Keeps your existing geometry extraction (blue dots + red connections).
 * - Adds console-driven roof-face solver using Solar facet centers + DSM overlap scoring.
 *
 * UPDATE (your request):
 *   Inserts a new step BETWEEN old step 3 and 4:
 *     PASS 4/6 — edge-grow flood fill (height-map indicative region) per face
 *       - Starts at center, flood-fills outward on DSM where |DSM - planeZ| <= thresholdEdgeM
 *       - Produces a “messy” border polygon (contour) per face
 *     PASS 5/6 — overlap resolve (pixel fight → cut losers) + tendril cleanup
 *     PASS 6/6 — publish
 *
 * UPDATE (your request TODAY):
 *   PASS 6 now merges (welds) points that are close in 3D (XY in meters + Z),
 *   INCLUDING across different faces.
 *
 * Console API:
 *   roofFacesReset(opts?)
 *   roofFacesNext()
 *   roofFacesPrev()
 *   roofFacesGoto(n)
 *   roofFacesStatus()
 *   roofFacesClear()
 */

/* =========================================================
   EXISTING IMAGE->POINTS/LINES PIPELINE (unchanged)
   ========================================================= */

function processGeometryImage(img, targetW, targetH, params) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const w = canvas.width;
    const h = canvas.height;

    const blueSensitivity = params ? params.blue : 20;
    const erosionPasses = params ? params.erode : 0;
    const redThreshold = params ? params.red : 20;

    let binaryMap = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
        if (b > 60 && b > r + blueSensitivity && b > g + blueSensitivity) {
            binaryMap[i / 4] = 1;
        }
    }

    for (let p = 0; p < erosionPasses; p++) binaryMap = erode(binaryMap, w, h);
    const originalDots = findBlobs(binaryMap, w, h);
    const primaryConnections = findRedConnections(
        originalDots,
        data,
        w,
        h,
        redThreshold
    );

    let allConnections = [...primaryConnections];
    let allPoints = [...originalDots];

    if (targetW && targetH && (w !== targetW || h !== targetH)) {
        const scaleX = targetW / w;
        const scaleY = targetH / h;

        const weldedPoints = [];
        const pointMap = new Map();

        const getWelded = (x, y) => {
            const sx = x * scaleX;
            const sy = y * scaleY;
            const key = `${sx.toFixed(1)},${sy.toFixed(1)}`;
            if (pointMap.has(key)) return pointMap.get(key);

            const pt = { x: sx, y: sy, z: 0, layer: 1 };

            pointMap.set(key, pt);
            weldedPoints.push(pt);
            return pt;
        };

        allConnections = allConnections.map((conn) => ({
            start: getWelded(conn.start.x, conn.start.y),
            end: getWelded(conn.end.x, conn.end.y),
        }));

        allPoints = weldedPoints;
    } else {
        allPoints.forEach((p) => {
            p.layer = 1;
            p.z = 0;
        });
    }

    return { connections: allConnections, points: allPoints };
}

function findRedConnections(dots, pixelData, w, h, threshold) {
    const connections = [];
    for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
            if (checkConnection(dots[i], dots[j], pixelData, w, h, threshold)) {
                connections.push({ start: dots[i], end: dots[j] });
            }
        }
    }
    return connections;
}

function checkConnection(p1, p2, pixelData, w, h, threshold, stepSize = 10) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) return false;

    const sampleCount = Math.max(1, Math.floor(dist / stepSize));

    for (let k = 1; k <= sampleCount; k++) {
        const t = k / (sampleCount + 1);
        const sampleX = Math.floor(p1.x + (p2.x - p1.x) * t);
        const sampleY = Math.floor(p1.y + (p2.y - p1.y) * t);
        if (!isClusterRed(sampleX, sampleY, pixelData, w, h, threshold))
            return false;
    }
    return true;
}

function isClusterRed(x, y, data, w, h, threshold) {
    let rSum = 0,
        gSum = 0,
        bSum = 0,
        count = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx,
                py = y + dy;
            if (px >= 0 && px < w && py >= 0 && py < h) {
                const i = (py * w + px) * 4;
                rSum += data[i];
                gSum += data[i + 1];
                bSum += data[i + 2];
                count++;
            }
        }
    }
    if (count === 0) return false;
    const r = rSum / count,
        g = gSum / count,
        b = bSum / count;
    return r > 60 && r > g + threshold && r > b + threshold;
}

function erode(inputMap, width, height) {
    const outputMap = new Uint8Array(inputMap.length);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (inputMap[i] === 1) {
                const up = inputMap[i - width],
                    down = inputMap[i + width],
                    left = inputMap[i - 1],
                    right = inputMap[i + 1];
                if (up && down && left && right) outputMap[i] = 1;
                else outputMap[i] = 0;
            }
        }
    }
    return outputMap;
}

function findBlobs(binaryMap, width, height) {
    const visited = new Uint8Array(width * height);
    const blobs = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (binaryMap[idx] === 1 && visited[idx] === 0) {
                const blob = floodFill(x, y, width, height, binaryMap, visited);
                if (blob.count > 3) blobs.push(blob);
            }
        }
    }
    return blobs;
}

function floodFill(startX, startY, w, h, map, visited) {
    let queue = [startX, startY];
    let sumX = 0,
        sumY = 0,
        count = 0;
    visited[startY * w + startX] = 1;
    let qIdx = 0;
    while (qIdx < queue.length) {
        const cx = queue[qIdx++];
        const cy = queue[qIdx++];
        sumX += cx;
        sumY += cy;
        count++;

        const neighbors = [
            [cx + 1, cy],
            [cx - 1, cy],
            [cx, cy + 1],
            [cx, cy - 1],
        ];
        for (let n of neighbors) {
            const nx = n[0],
                ny = n[1];
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                const nIdx = ny * w + nx;
                if (map[nIdx] === 1 && visited[nIdx] === 0) {
                    visited[nIdx] = 1;
                    queue.push(nx, ny);
                }
            }
        }
    }
    return { x: sumX / count, y: sumY / count, count: count };
}

function optimizeElevationFromGeomery(geometryObj, dsm, w, h) {
    if (!geometryObj || !geometryObj.points) return;

    if (!dsm) {
        geometryObj.points.forEach((p) => {
            if (p.z === null || p.z === undefined) p.z = 0.1;
            p.zVotes = [];
        });
        return;
    }

    geometryObj.points.forEach((p) => {
        p.zVotes = [];
        p.z = null;
    });

    (geometryObj.connections || []).forEach((conn) => {
        const samples = sampleLineOnDSM(conn.start, conn.end, dsm, w, h);
        const validSamples = samples.filter((s) => s.z > -9000);

        if (validSamples.length > 5) {
            const { slope, intercept } = linearRegression(validSamples);
            const len = Math.hypot(
                conn.end.x - conn.start.x,
                conn.end.y - conn.start.y
            );
            const zStart = intercept;
            const zEnd = slope * len + intercept;

            conn.start.zVotes.push(zStart);
            conn.end.zVotes.push(zEnd);
        } else {
            const z1 = getZAtXY(conn.start.x, conn.start.y, dsm, w, h);
            const z2 = getZAtXY(conn.end.x, conn.end.y, dsm, w, h);
            if (z1 > -9000) conn.start.zVotes.push(z1);
            if (z2 > -9000) conn.end.zVotes.push(z2);
        }
    });

    geometryObj.points.forEach((p) => {
        if (p.zLocked) return;
        if (p.zVotes.length > 0) {
            const sum = p.zVotes.reduce((a, b) => a + b, 0);
            p.z = sum / p.zVotes.length;
        } else {
            const rawZ = getZAtXY(p.x, p.y, dsm, w, h);
            const fallback = typeof dsmMin !== "undefined" ? dsmMin : 0.1;
            p.z = rawZ > -9000 ? rawZ : fallback;
        }
    });
}

function getZAtXY(x, y, dsm, w, h) {
    const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
    return dsm[iy * w + ix];
}

function sampleLineOnDSM(p1, p2, dsm, w, h) {
    const samples = [];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(dist);

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = p1.x + dx * t;
        const py = p1.y + dy * t;
        const z = getZAtXY(px, py, dsm, w, h);
        samples.push({ d: t * dist, z: z });
    }
    return samples;
}

function linearRegression(data) {
    let sumX = 0,
        sumY = 0,
        sumXY = 0,
        sumXX = 0;
    const n = data.length;
    for (let i = 0; i < n; i++) {
        sumX += data[i].d;
        sumY += data[i].z;
        sumXY += data[i].d * data[i].z;
        sumXX += data[i].d * data[i].d;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

/* =========================================================
   STRUCTURE DETECTION (unchanged)
   ========================================================= */

function detectStructures(points, connections, faces) {
    if (!points || !connections) return [];

    const adj = new Map();
    const ptToId = (p) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
    const idToPt = new Map();

    points.forEach((p) => {
        const id = ptToId(p);
        idToPt.set(id, p);
        adj.set(id, []);
    });

    connections.forEach((conn) => {
        const id1 = ptToId(conn.start);
        const id2 = ptToId(conn.end);
        if (adj.has(id1)) adj.get(id1).push(id2);
        if (adj.has(id2)) adj.get(id2).push(id1);
    });

    const clusters = [];
    const visited = new Set();

    points.forEach((p) => {
        const startId = ptToId(p);
        if (visited.has(startId)) return;

        const clusterPts = new Set();
        const queue = [startId];
        visited.add(startId);

        while (queue.length > 0) {
            const currId = queue.pop();
            clusterPts.add(currId);
            const neighbors = adj.get(currId) || [];
            neighbors.forEach((nId) => {
                if (!visited.has(nId)) {
                    visited.add(nId);
                    queue.push(nId);
                }
            });
        }
        clusters.push(clusterPts);
    });

    let structures = clusters
        .map((cSet) => {
            const cPoints = Array.from(cSet).map((id) => idToPt.get(id));
            const cLines = connections.filter(
                (conn) =>
                    cSet.has(ptToId(conn.start)) || cSet.has(ptToId(conn.end))
            );
            const cFaces = (faces || []).filter((f) =>
                f.points.every((p) => cSet.has(ptToId(p)))
            );
            return {
                points: cPoints,
                lines: cLines,
                faces: cFaces,
                bounds: getBounds(cPoints),
            };
        })
        .filter((s) => s.lines.length > 0);

    if (structures.length > 1) {
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < structures.length; i++) {
                for (let j = i + 1; j < structures.length; j++) {
                    const s1 = structures[i];
                    const s2 = structures[j];
                    if (!boundsOverlap(s1.bounds, s2.bounds)) continue;

                    let overlap = false;
                    for (const f1 of s1.faces) {
                        for (const f2 of s2.faces) {
                            if (polygonsIntersect(f1.points, f2.points)) {
                                overlap = true;
                                break;
                            }
                        }
                        if (overlap) break;
                    }

                    if (overlap) {
                        s1.points = [...s1.points, ...s2.points];
                        s1.lines = [...s1.lines, ...s2.lines];
                        s1.faces = [...s1.faces, ...s2.faces];
                        s1.bounds = getBounds(s1.points);
                        structures.splice(j, 1);
                        changed = true;
                        break;
                    }
                }
                if (changed) break;
            }
        }
    }

    return structures
        .filter((s) => s.faces.length > 0 || s.lines.length > 4)
        .map((s, i) => ({ ...s, id: i + 1 }));
}

function getBounds(points) {
    let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
    points.forEach((p) => {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    });
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsOverlap(b1, b2) {
    return !(
        b1.maxX < b2.minX ||
        b1.minX > b2.maxX ||
        b1.maxY < b2.minY ||
        b1.minY > b2.maxY
    );
}

function polygonsIntersect(polyA, polyB) {
    for (let p of polyA) {
        if (isPointInPolyStruct(p.x, p.y, polyB)) return true;
    }
    for (let p of polyB) {
        if (isPointInPolyStruct(p.x, p.y, polyA)) return true;
    }
    for (let i = 0; i < polyA.length; i++) {
        const a1 = polyA[i],
            a2 = polyA[(i + 1) % polyA.length];
        for (let j = 0; j < polyB.length; j++) {
            const b1 = polyB[j],
                b2 = polyB[(j + 1) % polyB.length];
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

function isPointInPolyStruct(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x,
            yi = poly[i].y;
        const xj = poly[j].x,
            yj = poly[j].y;
        const intersect =
            yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function segmentsIntersect(a, b, c, d) {
    const ccw = (p1, p2, p3) =>
        (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function getEffectiveStructures(rawStructures, settings) {
    if (!settings) {
        return rawStructures.map((s) => ({
            ...s,
            points: [...s.points],
            lines: [...s.lines],
            faces: [...s.faces],
            bounds: { ...s.bounds },
            originalIds: [s.id],
        }));
    }

    let map = new Map();
    rawStructures.forEach((s) => {
        map.set(s.id, {
            ...s,
            points: [...s.points],
            lines: [...s.lines],
            faces: [...s.faces],
            bounds: { ...s.bounds },
            originalIds: [s.id],
        });
    });

    const toRemove = new Set();

    rawStructures.forEach((s) => {
        const conf = settings[s.id];
        if (conf && conf.mergeTarget) {
            const targetId = parseInt(conf.mergeTarget);
            if (targetId !== s.id && map.has(targetId)) {
                const target = map.get(targetId);
                const source = map.get(s.id);

                target.points.push(...source.points);
                target.lines.push(...source.lines);
                target.faces.push(...source.faces);
                target.originalIds.push(...source.originalIds);

                target.bounds.minX = Math.min(
                    target.bounds.minX,
                    source.bounds.minX
                );
                target.bounds.minY = Math.min(
                    target.bounds.minY,
                    source.bounds.minY
                );
                target.bounds.maxX = Math.max(
                    target.bounds.maxX,
                    source.bounds.maxX
                );
                target.bounds.maxY = Math.max(
                    target.bounds.maxY,
                    source.bounds.maxY
                );
                target.bounds.width = target.bounds.maxX - target.bounds.minX;
                target.bounds.height = target.bounds.maxY - target.bounds.minY;

                toRemove.add(s.id);
            }
        }
    });

    let result = [];
    map.forEach((s, id) => {
        if (toRemove.has(id)) return;
        const conf = settings[id];
        if (conf && conf.hidden) return;
        result.push(s);
    });

    result.sort((a, b) => a.id - b.id);
    return result;
}

(function facetFacePipelineBootstrap() {
    const PIPE_KEY = "__ROOF_FACET_FACE_PIPELINE__";
    const DBG_GROUP_NAME = "__FACET_PIPELINE_DEBUG_FACES__";
    const MAX_PASS = 8;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const deg2rad = (d) => (d * Math.PI) / 180;

    // =========================
    // Manual center placement
    // =========================

    let __centerPlaceModeOn = false;
    let __centerPlaceHandler = null;

    function addManualCenterAtXY(x, y, extra = {}) {
        const pipeline = getPipeline();

        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;

        if (!dsm || !w || !h) {
            console.warn(
                "[RoofFaces] Can't add center: missing DSM/image dims."
            );
            return null;
        }

        const cx = clamp(x, 0, w - 1);
        const cy = clamp(y, 0, h - 1);

        const z0 = getDSMZ(dsm, w, h, cx, cy);
        if (!isValidDSMZ(z0)) {
            console.warn("[RoofFaces] Can't add center: DSM invalid at point.");
            return null;
        }

        if (!pipeline.state.manualCenters) pipeline.state.manualCenters = [];

        const center = {
            x: cx,
            y: cy,
            z0,
            pitchGuessDeg:
                typeof extra.pitchGuessDeg === "number"
                    ? extra.pitchGuessDeg
                    : null,
            azGuessDeg:
                typeof extra.azGuessDeg === "number" ? extra.azGuessDeg : null,
        };

        pipeline.state.manualCenters.push(center);

        // If we already ran pass 1+, invalidate snapshots so it recomputes cleanly
        pipeline.snapshots = [];
        pipeline.pass = 0;
        pipeline.state.centers = [];

        // draw combined centers (solar+manual) if possible
        try {
            const preview = buildCentersFromSolarFacetStats();
            let nextId = preview.length + 1;
            const merged = preview.map((c) => ({ ...c, __manual: false }));
            for (const mc of pipeline.state.manualCenters) {
                merged.push({
                    id: nextId++,
                    x: mc.x,
                    y: mc.y,
                    z0: mc.z0,
                    pitchGuessDeg: mc.pitchGuessDeg,
                    azGuessDeg: mc.azGuessDeg,
                    __manual: true,
                });
            }
            drawDebugCentersSVG(merged);
        } catch (e) {
            // ok if solar not loaded yet
        }

        if (typeof renderGeometry2D === "function") renderGeometry2D();
        publishDebugCentersFor2D(getPipeline());

        return center;
    }

    function publishDebugCentersFor2D(pipeline) {
        // Build what we want to show in 2D (solar + manual)
        let merged = [];
        try {
            const solar = buildCentersFromSolarFacetStats().map((c) => ({
                ...c,
                __manual: false,
            }));
            merged = solar;
        } catch (e) {
            // ok if solar stats not loaded yet
        }

        const man =
            pipeline.state && Array.isArray(pipeline.state.manualCenters)
                ? pipeline.state.manualCenters
                : [];
        let nextId = merged.length + 1;

        for (const mc of man) {
            if (!mc) continue;
            merged.push({
                id: nextId++,
                x: mc.x,
                y: mc.y,
                z0: mc.z0,
                pitchGuessDeg: mc.pitchGuessDeg ?? null,
                azGuessDeg: mc.azGuessDeg ?? null,
                __manual: true,
            });
        }

        window.__FACET_DEBUG_CENTERS__ = merged;

        if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();
        if (typeof renderGeometry2D === "function") renderGeometry2D();
    }

    function removeNearestManualCenter(x, y, radiusPx = 18) {
        const pipeline = getPipeline();
        const arr = pipeline.state.manualCenters || [];
        if (!arr.length) return false;

        let bestI = -1;
        let bestD = radiusPx;

        for (let i = 0; i < arr.length; i++) {
            const d = Math.hypot(arr[i].x - x, arr[i].y - y);
            if (d <= bestD) {
                bestD = d;
                bestI = i;
            }
        }

        if (bestI < 0) return false;

        arr.splice(bestI, 1);

        pipeline.snapshots = [];
        pipeline.pass = 0;
        pipeline.state.centers = [];

        // refresh overlay
        try {
            const preview = buildCentersFromSolarFacetStats();
            let nextId = preview.length + 1;
            const merged = preview.map((c) => ({ ...c, __manual: false }));
            for (const mc of arr) {
                merged.push({
                    id: nextId++,
                    x: mc.x,
                    y: mc.y,
                    z0: mc.z0,
                    pitchGuessDeg: mc.pitchGuessDeg,
                    azGuessDeg: mc.azGuessDeg,
                    __manual: true,
                });
            }
            drawDebugCentersSVG(merged);
        } catch (e) {}

        if (typeof renderGeometry2D === "function") renderGeometry2D();
        publishDebugCentersFor2D(getPipeline());

        return true;
    }

    function setCenterPlacementMode(on) {
        const viewport = document.getElementById("viewport");
        if (!viewport) {
            console.warn("[RoofFaces] viewport not found.");
            return false;
        }

        if (!!on === __centerPlaceModeOn) return __centerPlaceModeOn;

        __centerPlaceModeOn = !!on;

        if (__centerPlaceModeOn) {
            publishDebugCentersFor2D(getPipeline());
            __centerPlaceHandler = (ev) => {
                if (typeof screenToImage !== "function") return;

                // IMPORTANT: stop the normal selection/drag logic from consuming it
                ev.preventDefault();
                ev.stopPropagation();

                const p = screenToImage(ev.clientX, ev.clientY);

                // Shift = remove
                if (ev.shiftKey) {
                    const ok = removeNearestManualCenter(
                        p.x,
                        p.y,
                        22 /
                            (typeof currentZoom !== "undefined"
                                ? currentZoom
                                : 1)
                    );
                    console.log("[RoofFaces] removeNearestManualCenter:", ok);
                    publishDebugCentersFor2D(getPipeline());
                    return;
                }

                const added = addManualCenterAtXY(p.x, p.y);
                console.log("[RoofFaces] addManualCenterAtXY:", added);
                publishDebugCentersFor2D(getPipeline());
            };

            // Use pointerdown in CAPTURE
            viewport.addEventListener(
                "pointerdown",
                __centerPlaceHandler,
                true
            );
            console.log(
                "[RoofFaces] Center placement mode ON. Click to add. Shift+Click to remove."
            );
        } else {
            viewport.removeEventListener(
                "pointerdown",
                __centerPlaceHandler,
                true
            );
            __centerPlaceHandler = null;
            console.log("[RoofFaces] Center placement mode OFF.");
        }

        return __centerPlaceModeOn;
    }

    function nowMs() {
        return performance.now();
    }

    function logBanner(label, color = "#fff", bg = "#111") {
        console.log(
            `%c${label}`,
            `color:${color};background:${bg};padding:2px 6px;border-radius:4px;font-weight:bold;`
        );
    }

    function ensureActiveGeometry() {
        if (typeof activeGeometry === "undefined" || !activeGeometry) {
            activeGeometry = {
                points: [],
                connections: [],
                vents: [],
                manualFaces: [],
            };
        }
        if (!activeGeometry.manualFaces) activeGeometry.manualFaces = [];
        if (!activeGeometry.points) activeGeometry.points = [];
        if (!activeGeometry.connections) activeGeometry.connections = [];
    }

    function getMetersPerPx() {
        const rad =
            typeof RADIUS_METERS !== "undefined" && RADIUS_METERS
                ? RADIUS_METERS
                : 20;
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        return w > 0 ? (rad * 2) / w : 0;
    }

    function getDSM() {
        if (
            typeof layerData === "undefined" ||
            !layerData ||
            !layerData.dsm ||
            !layerData.dsm[0]
        )
            return null;
        return layerData.dsm[0];
    }

    function isValidDSMZ(z) {
        return typeof z === "number" && z > -9000 && isFinite(z);
    }

    function getDSMZ(dsm, w, h, x, y) {
        const ix = clamp(Math.round(x), 0, w - 1);
        const iy = clamp(Math.round(y), 0, h - 1);
        return dsm[iy * w + ix];
    }

    // Plane model: z = a*x + b*y + c (x,y in pixels, z in meters)
    function makePlaneThroughPoint(
        x0,
        y0,
        z0,
        pitchDeg,
        thetaDeg,
        metersPerPx
    ) {
        const pitch = deg2rad(pitchDeg);
        const theta = deg2rad(thetaDeg);

        const mag = Math.tan(pitch) * metersPerPx;
        const a = mag * Math.cos(theta);
        const b = mag * Math.sin(theta);
        const c = z0 - a * x0 - b * y0;

        return { a, b, c, pitchDeg, thetaDeg, x0, y0, z0 };
    }

    function planeZ(plane, x, y) {
        return plane.a * x + plane.b * y + plane.c;
    }

    function buildCircleOffsets(radiusPx, stepPx) {
        const offs = [];
        const r2 = radiusPx * radiusPx;
        const step = Math.max(1, stepPx | 0);
        for (let dy = -radiusPx; dy <= radiusPx; dy += step) {
            for (let dx = -radiusPx; dx <= radiusPx; dx += step) {
                if (dx * dx + dy * dy <= r2)
                    offs.push({ dx, dy, w: step * step });
            }
        }
        return offs;
    }

    function scorePlaneOverlapCircle(
        plane,
        center,
        dsm,
        w,
        h,
        offsets,
        thresholdM
    ) {
        let within = 0;
        let total = 0;
        for (let i = 0; i < offsets.length; i++) {
            const ox = offsets[i].dx;
            const oy = offsets[i].dy;
            const px = center.x + ox;
            const py = center.y + oy;
            if (px < 0 || py < 0 || px >= w || py >= h) continue;

            const z = getDSMZ(dsm, w, h, px, py);
            if (!isValidDSMZ(z)) continue;

            const pz = planeZ(plane, px, py);
            const wgt = offsets[i].w;
            total += wgt;
            if (Math.abs(z - pz) <= thresholdM) within += wgt;
        }
        const ratio = total > 0 ? within / total : 0;
        return { ratio, within, total };
    }

    function buildGlobalSamplesDeterministic(
        dsm,
        w,
        h,
        n,
        maskFn,
        roofMaskData
    ) {
        const samples = [];
        const want = Math.max(1, n | 0);

        // choose grid dims near-square and >= n cells
        const gx = Math.ceil(Math.sqrt(want * (w / Math.max(1, h))));
        const gy = Math.ceil(want / gx);

        // fixed offsets inside each cell (deterministic)
        const ox = 0.5;
        const oy = 0.5;

        const cellW = w / gx;
        const cellH = h / gy;

        for (let j = 0; j < gy && samples.length < want; j++) {
            for (let i = 0; i < gx && samples.length < want; i++) {
                const x = (i + ox) * cellW;
                const y = (j + oy) * cellH;

                const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
                const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
                const idx = iy * w + ix;

                // optional: roof-only
                if (roofMaskData && roofMaskData.length === w * h) {
                    if (!(roofMaskData[idx] > 0)) continue;
                }

                if (maskFn && maskFn(ix, iy)) continue;

                const z = dsm[idx];
                if (!(typeof z === "number" && z > -9000 && isFinite(z)))
                    continue;

                samples.push({ x: ix, y: iy, z });
            }
        }

        // If roof-only made it too sparse, fall back to scanning stride
        if (samples.length < Math.min(50, want)) {
            const stride = Math.max(2, Math.floor(Math.sqrt((w * h) / want)));
            for (
                let y = stride;
                y < h - stride && samples.length < want;
                y += stride
            ) {
                for (
                    let x = stride;
                    x < w - stride && samples.length < want;
                    x += stride
                ) {
                    const idx = y * w + x;

                    if (roofMaskData && roofMaskData.length === w * h) {
                        if (!(roofMaskData[idx] > 0)) continue;
                    }
                    if (maskFn && maskFn(x, y)) continue;

                    const z = dsm[idx];
                    if (!(typeof z === "number" && z > -9000 && isFinite(z)))
                        continue;

                    samples.push({ x, y, z });
                }
            }
        }

        return samples;
    }

    function scorePlaneOverlapSamples(plane, samples, thresholdM) {
        let within = 0;
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            const pz = planeZ(plane, s.x, s.y);
            if (Math.abs(s.z - pz) <= thresholdM) within++;
        }
        return samples.length ? within / samples.length : 0;
    }

    function polygonArea(poly) {
        if (!poly || poly.length < 3) return 0;
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i];
            const q = poly[(i + 1) % poly.length];
            a += p.x * q.y - q.x * p.y;
        }
        return a * 0.5;
    }

    /* =========================
     PASS 4: EDGE-GROW FLOOD FILL -> CONTOUR POLY
     ========================= */

    function dsmIndicative(dsm, w, h, x, y, plane, thresholdM) {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const z = getDSMZ(dsm, w, h, x, y);
        if (!isValidDSMZ(z)) return false;
        const pz = planeZ(plane, x, y);
        return Math.abs(z - pz) <= thresholdM;
    }

    function growRegionMaskFromCenter(
        dsm,
        w,
        h,
        center,
        plane,
        thresholdM,
        maxPixels,
        useMaskFn
    ) {
        const mask = new Uint8Array(w * h);
        const visited = new Uint8Array(w * h);

        const sx = clamp(Math.round(center.x), 0, w - 1);
        const sy = clamp(Math.round(center.y), 0, h - 1);

        const startIdx = sy * w + sx;
        const okStart =
            (!useMaskFn || !useMaskFn(sx, sy)) &&
            dsmIndicative(dsm, w, h, sx, sy, plane, thresholdM);

        if (!okStart) {
            return { mask, count: 0, bbox: null, startOk: false };
        }

        const qx = new Int32Array(Math.min(maxPixels, w * h));
        const qy = new Int32Array(Math.min(maxPixels, w * h));
        let qh = 0,
            qt = 0;

        qx[qt] = sx;
        qy[qt] = sy;
        qt++;
        visited[startIdx] = 1;
        mask[startIdx] = 1;

        let count = 1;

        let minX = sx,
            maxX = sx,
            minY = sy,
            maxY = sy;

        const push = (nx, ny) => {
            const idx = ny * w + nx;
            if (visited[idx]) return;
            visited[idx] = 1;

            if (useMaskFn && useMaskFn(nx, ny)) return;
            if (!dsmIndicative(dsm, w, h, nx, ny, plane, thresholdM)) return;

            mask[idx] = 1;
            qx[qt] = nx;
            qy[qt] = ny;
            qt++;

            count++;
            if (nx < minX) minX = nx;
            if (nx > maxX) maxX = nx;
            if (ny < minY) minY = ny;
            if (ny > maxY) maxY = ny;
        };

        while (qh < qt && count < maxPixels && qt < qx.length) {
            const cx = qx[qh];
            const cy = qy[qh];
            qh++;

            if (cx + 1 < w) push(cx + 1, cy);
            if (cx - 1 >= 0) push(cx - 1, cy);
            if (cy + 1 < h) push(cx, cy + 1);
            if (cy - 1 >= 0) push(cx, cy - 1);
        }

        return {
            mask,
            count,
            bbox: {
                minX,
                maxX,
                minY,
                maxY,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
            },
            startOk: true,
        };
    }

    function isBoundaryPixel(mask, w, h, x, y) {
        const idx = y * w + x;
        if (!mask[idx]) return false;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return true;
        if (!mask[idx - 1]) return true;
        if (!mask[idx + 1]) return true;
        if (!mask[idx - w]) return true;
        if (!mask[idx + w]) return true;
        return false;
    }

    /* =========================================================
    NEW: SOLAR FACET -> PLANES -> EDGE-GROW -> OVERLAP RESOLVE -> PUBLISH
    ========================================================= */

    function polyBBox(poly, w, h) {
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (let i = 0; i < poly.length; i++) {
            const x = poly[i].x,
                y = poly[i].y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        minX = clamp(Math.floor(minX), 0, w - 1);
        maxX = clamp(Math.ceil(maxX), 0, w - 1);
        minY = clamp(Math.floor(minY), 0, h - 1);
        maxY = clamp(Math.ceil(maxY), 0, h - 1);
        if (!isFinite(minX) || minX > maxX || minY > maxY) return null;
        return {
            minX,
            maxX,
            minY,
            maxY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
        };
    }

    // Rasterize polygon into a local bbox mask (1 = inside)
    function rasterizePolyToLocalMask(poly, w, h, bbox) {
        const mw = bbox.width,
            mh = bbox.height;
        const local = new Uint8Array(mw * mh);

        // Scanline fill (even-odd rule)
        for (let yy = bbox.minY; yy <= bbox.maxY; yy++) {
            const y = yy + 0.5;
            const xs = [];

            for (let i = 0; i < poly.length; i++) {
                const a = poly[i];
                const b = poly[(i + 1) % poly.length];

                // ignore horizontal edges
                if (a.y === b.y) continue;

                const yMin = Math.min(a.y, b.y);
                const yMax = Math.max(a.y, b.y);

                // half-open rule to avoid double counts at vertices
                if (y <= yMin || y > yMax) continue;

                const t = (y - a.y) / (b.y - a.y);
                const x = a.x + t * (b.x - a.x);
                xs.push(x);
            }

            if (xs.length < 2) continue;
            xs.sort((p, q) => p - q);

            for (let k = 0; k + 1 < xs.length; k += 2) {
                let x0 = Math.ceil(xs[k]);
                let x1 = Math.floor(xs[k + 1]);
                x0 = clamp(x0, bbox.minX, bbox.maxX);
                x1 = clamp(x1, bbox.minX, bbox.maxX);
                if (x1 < x0) continue;

                const row = (yy - bbox.minY) * mw;
                for (let xx = x0; xx <= x1; xx++) {
                    local[row + (xx - bbox.minX)] = 1;
                }
            }
        }

        return local;
    }

    // Clip poly by roofMaskData by: rasterize -> AND -> contour -> simplify -> return poly
    function enforcePolyInsideRoofMask(
        poly,
        w,
        h,
        simplifyEpsPx,
        maxVertices,
        contourMaxSteps
    ) {
        if (
            !poly ||
            poly.length < 3 ||
            typeof roofMaskData === "undefined" ||
            !roofMaskData ||
            roofMaskData.length !== w * h
        )
            return poly;

        const bbox = polyBBox(poly, w, h);
        if (!bbox) return poly;

        const local = rasterizePolyToLocalMask(poly, w, h, bbox);

        // AND with roof mask
        let kept = 0;
        for (let yy = 0; yy < bbox.height; yy++) {
            const gy = bbox.minY + yy;
            const baseG = gy * w + bbox.minX;
            const baseL = yy * bbox.width;
            for (let xx = 0; xx < bbox.width; xx++) {
                if (!local[baseL + xx]) continue;
                if (!(roofMaskData[baseG + xx] > 0)) {
                    local[baseL + xx] = 0;
                } else {
                    kept++;
                }
            }
        }
        if (kept < 20) return []; // too small after clip

        // Lift local->full mask just for tracing (within bbox only)
        const full = new Uint8Array(w * h);
        for (let yy = 0; yy < bbox.height; yy++) {
            const gy = bbox.minY + yy;
            const baseG = gy * w + bbox.minX;
            const baseL = yy * bbox.width;
            for (let xx = 0; xx < bbox.width; xx++) {
                if (local[baseL + xx]) full[baseG + xx] = 1;
            }
        }

        // Trace contour on the clipped pixels
        const contour = traceContour(
            full,
            w,
            h,
            bbox,
            Math.max(5000, contourMaxSteps | 0)
        );

        if (!contour || contour.length < 10) return [];

        // Re-simplify *after* clipping
        const out = contourToPoly(
            contour,
            Math.max(0.5, simplifyEpsPx || 2),
            Math.max(120, maxVertices | 0)
        );

        return out && out.length >= 3 ? out : [];
    }

    function traceContour(mask, w, h, bbox, maxSteps) {
        if (!bbox) return [];

        let sx = -1,
            sy = -1;
        for (let y = bbox.minY; y <= bbox.maxY; y++) {
            for (let x = bbox.minX; x <= bbox.maxX; x++) {
                if (isBoundaryPixel(mask, w, h, x, y)) {
                    sx = x;
                    sy = y;
                    break;
                }
            }
            if (sx >= 0) break;
        }
        if (sx < 0) return [];

        const dirs = [
            [1, 0],
            [1, 1],
            [0, 1],
            [-1, 1],
            [-1, 0],
            [-1, -1],
            [0, -1],
            [1, -1],
        ];

        const contour = [];
        let cx = sx,
            cy = sy;
        let prevDir = 0;
        let steps = 0;

        const nextPoint = () => {
            let start = (prevDir + 6) & 7;
            for (let k = 0; k < 8; k++) {
                const di = (start + k) & 7;
                const nx = cx + dirs[di][0];
                const ny = cy + dirs[di][1];
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                if (isBoundaryPixel(mask, w, h, nx, ny)) {
                    prevDir = di;
                    cx = nx;
                    cy = ny;
                    return true;
                }
            }
            return false;
        };

        contour.push({ x: sx, y: sy });

        while (steps < maxSteps) {
            steps++;
            if (!nextPoint()) break;
            contour.push({ x: cx, y: cy });
            if (cx === sx && cy === sy && contour.length > 12) break;
        }

        if (contour.length > 2) {
            const last = contour[contour.length - 1];
            if (last.x === sx && last.y === sy) contour.pop();
        }

        return contour;
    }

    function rdpSimplify(points, eps) {
        if (!points || points.length < 4) return points || [];
        const e2 = eps * eps;

        const dist2PointToSegment = (p, a, b) => {
            const vx = b.x - a.x;
            const vy = b.y - a.y;
            const wx = p.x - a.x;
            const wy = p.y - a.y;

            const c1 = wx * vx + wy * vy;
            if (c1 <= 0)
                return (p.x - a.x) * (p.x - a.x) + (p.y - a.y) * (p.y - a.y);

            const c2 = vx * vx + vy * vy;
            if (c2 <= c1)
                return (p.x - b.x) * (p.x - b.x) + (p.y - b.y) * (p.y - b.y);

            const t = c1 / c2;
            const px = a.x + t * vx;
            const py = a.y + t * vy;
            const dx = p.x - px;
            const dy = p.y - py;
            return dx * dx + dy * dy;
        };

        const keep = new Uint8Array(points.length);
        keep[0] = 1;
        keep[points.length - 1] = 1;

        const stack = [[0, points.length - 1]];
        while (stack.length) {
            const [i0, i1] = stack.pop();
            let bestIdx = -1;
            let bestD2 = 0;
            const a = points[i0];
            const b = points[i1];
            for (let i = i0 + 1; i < i1; i++) {
                const d2 = dist2PointToSegment(points[i], a, b);
                if (d2 > bestD2) {
                    bestD2 = d2;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0 && bestD2 > e2) {
                keep[bestIdx] = 1;
                stack.push([i0, bestIdx], [bestIdx, i1]);
            }
        }

        const out = [];
        for (let i = 0; i < points.length; i++)
            if (keep[i]) out.push(points[i]);
        return out;
    }

    function contourToPoly(contour, simplifyEpsPx, maxVertices) {
        if (!contour || contour.length < 3) return [];
        let poly = contour.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));

        poly.push({ ...poly[0] });
        poly = rdpSimplify(poly, simplifyEpsPx);
        if (poly.length > 2) poly.pop();

        if (maxVertices && poly.length > maxVertices) {
            const step = Math.ceil(poly.length / maxVertices);
            const tmp = [];
            for (let i = 0; i < poly.length; i += step) tmp.push(poly[i]);
            poly = tmp;
        }

        return poly;
    }

    /* =========================
     DEBUG RENDERING
     ========================= */

    function clearDebugFaceRenderings() {
        const svg = document.getElementById("geoSvg");
        if (svg) {
            const g = document.getElementById("geo-rotation-group") || svg;
            g.querySelectorAll(".facet-pipeline-face").forEach((n) =>
                n.remove()
            );
        }

        if (typeof scene !== "undefined" && scene) {
            const existing = scene.getObjectByName(DBG_GROUP_NAME);
            if (existing) {
                while (existing.children.length) {
                    const ch = existing.children[0];
                    if (ch.geometry) ch.geometry.dispose();
                    if (ch.material) ch.material.dispose();
                    existing.remove(ch);
                }
                scene.remove(existing);
            }
        }
    }

    function ensureDebug3DGroup() {
        if (typeof scene === "undefined" || !scene) return null;
        let g = scene.getObjectByName(DBG_GROUP_NAME);
        if (!g) {
            g = new THREE.Group();
            g.name = DBG_GROUP_NAME;
            scene.add(g);
        }
        return g;
    }

    function renderFaces2DImmediate(
        facePolys,
        color = "rgba(0,255,255,0.25)",
        stroke = "rgba(0,255,255,0.85)"
    ) {
        const svg = document.getElementById("geoSvg");
        if (!svg) return;

        const g = document.getElementById("geo-rotation-group") || svg;

        g.querySelectorAll(".facet-pipeline-face").forEach((n) => n.remove());

        const isVisible =
            typeof showFacesLayer !== "undefined" ? showFacesLayer : true;
        if (!isVisible) return;

        const invZoom =
            1 /
            (typeof currentZoom !== "undefined" && currentZoom
                ? currentZoom
                : 1);

        facePolys.forEach((poly, idx) => {
            if (!poly || poly.length < 3) return;

            let d = `M ${poly[0].x} ${poly[0].y} `;
            for (let i = 1; i < poly.length; i++)
                d += `L ${poly[i].x} ${poly[i].y} `;
            d += "Z";

            const path = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "path"
            );
            path.setAttribute("d", d);
            path.setAttribute("fill", color);
            path.setAttribute("stroke", stroke);
            path.setAttribute("stroke-width", 2 * invZoom + "px");
            path.setAttribute("class", "facet-pipeline-face");
            path.style.pointerEvents = "none";
            path.style.display = "block";

            g.appendChild(path);

            const lab = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "text"
            );
            let cx = 0,
                cy = 0;
            for (let i = 0; i < poly.length; i++) {
                cx += poly[i].x;
                cy += poly[i].y;
            }
            cx /= poly.length;
            cy /= poly.length;
            lab.setAttribute("x", cx);
            lab.setAttribute("y", cy);
            lab.setAttribute("fill", "#00ffff");
            lab.setAttribute("font-size", 12 * invZoom + "px");
            lab.setAttribute("stroke", "#000");
            lab.setAttribute("stroke-width", 3 * invZoom + "px");
            lab.setAttribute("paint-order", "stroke");
            lab.setAttribute("text-anchor", "middle");
            lab.setAttribute("class", "facet-pipeline-face");
            lab.textContent = `${idx + 1}`;
            lab.style.pointerEvents = "none";
            g.appendChild(lab);
        });
    }

    function renderFaces3DImmediate(facePolys, planesForPolys, opacity = 0.55) {
        if (typeof THREE === "undefined") return;
        if (
            typeof imageWidth === "undefined" ||
            typeof imageHeight === "undefined"
        )
            return;
        if (typeof dsmMin === "undefined") return;
        if (typeof createFaceMesh !== "function") {
            console.warn(
                "[RoofFaces] createFaceMesh not found; 3D debug faces skipped."
            );
            return;
        }

        const group = ensureDebug3DGroup();
        if (!group) return;

        while (group.children.length) {
            const ch = group.children[0];
            if (ch.geometry) ch.geometry.dispose();
            if (ch.material) ch.material.dispose();
            group.remove(ch);
        }

        const isVisible =
            typeof showFacesLayer !== "undefined" ? showFacesLayer : true;
        group.visible = isVisible;

        for (let i = 0; i < facePolys.length; i++) {
            const poly = facePolys[i];
            const pl = planesForPolys[i];
            if (!poly || poly.length < 3 || !pl) continue;

            const pts = poly.map((v) => ({
                x: v.x,
                y: v.y,
                z: planeZ(pl, v.x, v.y),
            }));
            const faceDef = { points: pts, holes: [] };
            const mesh = createFaceMesh(faceDef, pl, 1, i, []);
            mesh.material.transparent = true;
            mesh.material.opacity = opacity;

            mesh.material.color = new THREE.Color(0x00ffff);
            mesh.material.emissive = new THREE.Color(0x001111);
            mesh.material.roughness = 0.35;
            mesh.material.metalness = 0.05;

            mesh.visible = isVisible;
            group.add(mesh);
        }
    }

    function makeDiscPoly(center, radiusPx, segments = 28) {
        const poly = [];
        const seg = Math.max(10, segments | 0);
        for (let i = 0; i < seg; i++) {
            const t = (i / seg) * Math.PI * 2;
            poly.push({
                x: center.x + Math.cos(t) * radiusPx,
                y: center.y + Math.sin(t) * radiusPx,
            });
        }
        return poly;
    }

    function pipelineRenderStage(pipeline, stage) {
        if (typeof showFacesLayer !== "undefined") showFacesLayer = true;
        if (typeof facesGroup !== "undefined" && facesGroup)
            facesGroup.visible = true;

        clearDebugFaceRenderings();

        if (stage === 2) {
            const radius = pipeline.opts.circleRadiusPx * 1.2;
            const discs = [];
            const planes = [];

            (pipeline.state.planes || []).forEach((p) => {
                const disc = makeDiscPoly(p.center, radius, 30);
                discs.push(disc);
                planes.push(p.plane);
            });

            renderFaces2DImmediate(
                discs,
                "rgba(0,255,255,0.12)",
                "rgba(0,255,255,0.85)"
            );
            renderFaces3DImmediate(discs, planes, 0.35);
        } else if (stage === 3) {
            const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
            const h = typeof imageHeight !== "undefined" ? imageHeight : 0;

            const rectPoly = [
                { x: 0, y: 0 },
                { x: w, y: 0 },
                { x: w, y: h },
                { x: 0, y: h },
            ];

            renderFaces2DImmediate(
                [rectPoly],
                "rgba(255,79,216,0.04)",
                "rgba(255,79,216,0.40)"
            );

            const polys = [];
            const planes = [];
            (pipeline.state.planes || []).forEach((p) => {
                polys.push(rectPoly);
                planes.push(p.plane);
            });

            renderFaces3DImmediate(polys, planes, 0.18);
        } else if (stage === 4) {
            const polys = (pipeline.state.edgePolys || []).filter(
                (p) => p && p.length >= 3
            );
            const planesFor = [];
            let k = 0;
            for (let i = 0; i < (pipeline.state.edgePolys || []).length; i++) {
                const poly = pipeline.state.edgePolys[i];
                if (!poly || poly.length < 3) continue;
                planesFor[k++] = pipeline.state.planes[i].plane;
            }

            renderFaces2DImmediate(
                polys,
                "rgba(0,255,255,0.10)",
                "rgba(0,255,255,0.90)"
            );
            renderFaces3DImmediate(polys, planesFor, 0.32);
        } else if (stage === 5) {
            const polys = (pipeline.state.polys || []).filter(
                (p) => p && p.length >= 3
            );
            const planesFor = [];
            let k = 0;
            for (let i = 0; i < (pipeline.state.polys || []).length; i++) {
                const poly = pipeline.state.polys[i];
                if (!poly || poly.length < 3) continue;
                planesFor[k++] = pipeline.state.planes[i].plane;
            }

            renderFaces2DImmediate(
                polys,
                "rgba(255,79,216,0.10)",
                "rgba(255,79,216,0.85)"
            );
            renderFaces3DImmediate(polys, planesFor, 0.4);
        } else if (stage === 6) {
            // published polys (same as trimmed)
            const polys = (pipeline.state.polys || []).filter(
                (p) => p && p.length >= 3
            );

            // IMPORTANT: stage 6 should show the REAL published faces, not debug meshes.
            // So: draw 2D overlay (optional), but DO NOT draw debug 3D faces.
            renderFaces2DImmediate(
                polys,
                "rgba(255,209,102,0.14)",
                "rgba(255,209,102,0.95)"
            );

            // Kill any lingering debug 3D overlay explicitly (belt + suspenders)
            const g = ensureDebug3DGroup();
            if (g) g.visible = false;
        }

        if (typeof renderGeometry2D === "function") renderGeometry2D();
        if (typeof renderGeometry3D === "function") renderGeometry3D();
        if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();
    }

    /* =========================
     DEBUG CENTERS (SVG)
     ========================= */

    function drawDebugCentersSVG(centers) {
        const svg = document.getElementById("geoSvg");
        if (!svg) return;
        const g = document.getElementById("geo-rotation-group") || svg;

        g.querySelectorAll(".facet-center-debug").forEach((n) => n.remove());

        const invZoom =
            1 /
            (typeof currentZoom !== "undefined" && currentZoom
                ? currentZoom
                : 1);

        centers.forEach((c, idx) => {
            const dot = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "circle"
            );
            dot.setAttribute("cx", c.x);
            dot.setAttribute("cy", c.y);
            dot.setAttribute("r", 6 * invZoom);
            dot.setAttribute(
                "fill",
                c.__manual ? "rgba(255,140,0,0.90)" : "rgba(255,255,0,0.85)"
            );
            dot.setAttribute("stroke", "#000");
            dot.setAttribute("stroke-width", 2 * invZoom);
            dot.setAttribute(
                "class",
                c.__manual
                    ? "facet-center-debug facet-center-debug-manual"
                    : "facet-center-debug"
            );
            dot.style.pointerEvents = "none";
            g.appendChild(dot);

            const txt = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "text"
            );
            txt.setAttribute("x", c.x + 8 * invZoom);
            txt.setAttribute("y", c.y - 8 * invZoom);
            txt.setAttribute("fill", "#fff");
            txt.setAttribute("font-size", 14 * invZoom + "px");
            txt.setAttribute("stroke", "#000");
            txt.setAttribute("stroke-width", 3 * invZoom + "px");
            txt.setAttribute("paint-order", "stroke");
            txt.setAttribute("class", "facet-center-debug");
            txt.textContent = String(idx + 1);
            txt.style.pointerEvents = "none";
            g.appendChild(txt);
        });
    }

    function removeDebugSVG() {
        const svg = document.getElementById("geoSvg");
        if (!svg) return;
        const g = document.getElementById("geo-rotation-group") || svg;
        g.querySelectorAll(
            ".facet-center-debug, .facet-pipeline-face, .facet-overlap-debug"
        ).forEach((n) => n.remove());
    }

    /* =========================
     PIPELINE HELPERS
     ========================= */

    function clearPipelineGeneratedFaces(pipeline) {
        ensureActiveGeometry();
        const geo = activeGeometry;

        if (geo.manualFaces && geo.manualFaces.length) {
            geo.manualFaces = geo.manualFaces.filter((f) => !f.__autoFacet);
        }

        if (geo.points && geo.points.length) {
            geo.points = geo.points.filter((p) => !p.__autoFacet);
        }

        if (geo.connections && geo.connections.length) {
            geo.connections = geo.connections.filter((c) => !c.__autoFacet);
        }

        pipeline.generatedPointCount = 0;
        pipeline.generatedFaceCount = 0;

        clearDebugFaceRenderings();
        removeDebugSVG();

        if (typeof deleteFaceRenderings === "function") deleteFaceRenderings();

        if (typeof renderGeometry2D === "function") renderGeometry2D();
        if (typeof renderGeometry3D === "function") renderGeometry3D();
        if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();
    }

    function makeDefaultOptions() {
        return {
            thresholdM: 0.05,
            thresholdEdgeM: 0.2,

            circleRadiusPx: 18,
            circleSampleStepPx: 2,
            coarsePitchMinDeg: 0,
            coarsePitchMaxDeg: 80,
            coarsePitchStepDeg: 6,
            coarseAzStepDeg: 12,

            refinePitchWindowDeg: 10,
            refineAzWindowDeg: 20,
            refinePitchStepDeg: 1,
            refineAzStepDeg: 2,
            localWeight: 0.72,
            globalSamples: 12000,

            edgeMaxPixelsPerFace: 220000,
            edgeContourMaxSteps: 250000,
            edgeSimplifyEpsPx: 5.0,
            edgeMaxVertices: 600,
            edgeFallbackToDiscIfFail: true,

            overlapCheckRadiusPx: 5,
            overlapCutRadiusPx: 1,
            overlapMaxIters: 6,
            overlapDebugMaxDots: 6000,

            planeMergeEnabled: true,
            planeMergeOverlapPct: 0.7, // e.g. 0.70 = 70% overlap of smaller face
            planeMergeAngleDeg: 4.0, // max pitch/az delta to consider “same”
            planeMergeHeightTolM: 0.1, // default to 0.05 like thresholdM
            planeMergeSampleStridePx: 2, // overlap height sampling stride (perf)

            stage5SimplifyEpsPx: 6.0,
            stage5MaxVertices: 600,

            tendrilMinCircleRadiusPx: 5,
            tendrilCoreErodeStepPx: 1,

            minFaceAreaPx2: 50,

            // PASS 6 point welding (NEW)
            // Set to e.g. 0.10, 0.15, 0.25 meters
            mergeRadius3dM: 0.8, // 0 = off
            mergeGridCells: 1, // neighbor cell range (1 => 3x3x3)
            mergeAcrossLayers: true, // allow welding even if layer differs

            collinearAlignEnabled: true,
            collinearAlignDeg: 30.0, // pairs under this angle get aligned
            collinearAlignMinLenM: 0.15, // ignore tiny stubs

            // PASS 6 point->line snapping (2nd pass after point welding)
            // 0 = off. Typical: 0.05–0.25m depending on your data.
            lineSnapRadiusM: 0.18,
            lineSnapGridCells: 1, // neighbor cell radius for segment lookup
            lineSnapAcrossLayers: true, // usually fine to keep true

            publishLayer: 1,
            publishAddConnections: true,

            pass7CleanupCollinearDeg: 3.0,   // angle tolerance in degrees (0–5 is typical)
            pass7CleanupMaxIters: 6,         // run multiple times until stable

            // PASS 8 straightening
            pass8Enabled: true,
            pass8AngleSnapDegTol: 10.0,        // "close to a multiple of 45°" tolerance window
            pass8Epochs: 140,                  // hill-climb sweeps
            pass8StepPx: 0.9,                  // per-candidate step size
            pass8MaxMoveRadiusPx: 10.0,        // hard max from original position
            pass8UseAutoFacetOnly: true,       // only tweak __autoFacet points (recommended)
            pass8PreserveZ: true,              // keep Z fixed (no facet surface recompute)

            // random wiggle + score
            pass8RandomEpochs: 60,
            pass8RandomWiggleAmpPx: 1.6,       // random move amplitude per wiggle epoch
            pass8RandomTriesPerPoint: 1,       // how many random proposals per point per epoch

            // perf / safety
            pass8SkipDegreeLT2: true,          // only move points with degree >= 2
            pass8MaskPaddingPx: 0,             // optional: keep points away from mask edge (0 = allow boundary)
            pass8Verbose: false,

            pass8OuterShortMinLenPx: 20,   // if one of the two OUTER edges is shorter than this, snap that corner to 90° multiples
            pass8OuterEdgeProbePx: 1,      // how far around the midpoint we probe roofMask to decide "outer edge"

        };
    }

    function deepClone(obj) {
        try {
            return structuredClone(obj);
        } catch (e) {}
        return JSON.parse(JSON.stringify(obj));
    }

    function buildCentersFromSolarFacetStats() {
        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;

        if (!dsm || !w || !h) {
            throw new Error(
                "Missing DSM/image dims. Load layers first (run an analysis)."
            );
        }
        if (
            typeof segmentStats === "undefined" ||
            !Array.isArray(segmentStats) ||
            segmentStats.length === 0
        ) {
            throw new Error(
                "segmentStats missing. buildingInsights may not have loaded."
            );
        }
        if (
            typeof mapCenterLat === "undefined" ||
            typeof mapCenterLng === "undefined"
        ) {
            throw new Error("mapCenterLat/Lng missing.");
        }

        const metersPerPx = getMetersPerPx();
        if (!metersPerPx)
            throw new Error("metersPerPx is 0 (imageWidth missing?).");

        const mLat = 111132;
        const mLng = 111132 * Math.cos(mapCenterLat * (Math.PI / 180));

        const centers = [];
        segmentStats.forEach((seg, i) => {
            if (!seg || !seg.center) return;

            const dLat = (seg.center.latitude - mapCenterLat) * mLat;
            const dLng = (seg.center.longitude - mapCenterLng) * mLng;

            const x = w / 2 + dLng / metersPerPx;
            const y = h / 2 - dLat / metersPerPx;

            if (x < 0 || y < 0 || x >= w || y >= h) return;

            const z0 = getDSMZ(dsm, w, h, x, y);
            if (!isValidDSMZ(z0)) return;

            centers.push({
                id: i + 1,
                x,
                y,
                z0,
                pitchGuessDeg:
                    typeof seg.pitchDegrees === "number"
                        ? seg.pitchDegrees
                        : null,
                azGuessDeg:
                    typeof seg.azimuthDegrees === "number"
                        ? seg.azimuthDegrees
                        : null,
            });
        });

        return centers;
    }

    function clipMaskToRoofMask(maskObj, w, h) {
        // Hard-clip a grown region mask to Solar roof mask (roofMaskData),
        // independent of roofMaskEnabled toggle.
        if (
            !maskObj ||
            !maskObj.mask ||
            typeof roofMaskData === "undefined" ||
            !roofMaskData ||
            roofMaskData.length !== w * h
        ) {
            return { removed: 0, kept: maskObj?.count || 0 };
        }

        const m = maskObj.mask;
        let removed = 0;

        // Clip
        for (let i = 0; i < m.length; i++) {
            if (!m[i]) continue;
            if (!(roofMaskData[i] > 0)) {
                m[i] = 0;
                removed++;
            }
        }

        // Recompute count + bbox
        let cnt = 0;
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;

        for (let idx = 0; idx < m.length; idx++) {
            if (!m[idx]) continue;
            cnt++;
            const x = idx % w;
            const y = (idx / w) | 0;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }

        maskObj.count = cnt;
        if (cnt > 0) {
            maskObj.bbox = {
                minX,
                maxX,
                minY,
                maxY,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
            };
        } else {
            maskObj.bbox = null;
        }

        return { removed, kept: cnt };
    }

    /* =========================
     PASSES 1-4 (as you had them)
     ========================= */

    function pass1_collectCenters(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 1/6 — facet centers",
            "color:#ffd166;font-weight:bold;"
        );
        const t0 = nowMs();

        pipeline.state.centers = buildCentersFromSolarFacetStats();
        publishDebugCentersFor2D(pipeline);

        const man = Array.isArray(pipeline.state.manualCenters)
            ? pipeline.state.manualCenters
            : [];
        if (man.length) {
            // keep solar ids stable; manual ids start after
            let nextId = pipeline.state.centers.length + 1;

            for (const mc of man) {
                if (!mc) continue;
                pipeline.state.centers.push({
                    id: nextId++,
                    x: mc.x,
                    y: mc.y,
                    z0: mc.z0,
                    pitchGuessDeg:
                        typeof mc.pitchGuessDeg === "number"
                            ? mc.pitchGuessDeg
                            : null,
                    azGuessDeg:
                        typeof mc.azGuessDeg === "number"
                            ? mc.azGuessDeg
                            : null,
                    __manual: true,
                });
            }
        }

        console.log("Centers found:", pipeline.state.centers.length);
        console.table(
            pipeline.state.centers.map((c) => ({
                id: c.id,
                x: c.x.toFixed(1),
                y: c.y.toFixed(1),
                z0: c.z0.toFixed(2),
                pitchGuess: c.pitchGuessDeg?.toFixed?.(1),
                azGuess: c.azGuessDeg?.toFixed?.(0),
            }))
        );

        drawDebugCentersSVG(pipeline.state.centers);

        console.log(`PASS 1 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.log("Next:", "roofFacesNext()");
        console.groupEnd();

        clearDebugFaceRenderings();
        if (typeof renderGeometry2D === "function") renderGeometry2D();
    }

    function pass2_coarsePlanes(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 2/6 — coarse brute force (circle overlap)",
            "color:#33d6ff;font-weight:bold;"
        );
        const t0 = nowMs();

        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;
        const metersPerPx = getMetersPerPx();
        const opts = pipeline.opts;

        if (!pipeline.state.centers || pipeline.state.centers.length === 0) {
            throw new Error("No centers. Run pass 1 first.");
        }

        const offsets =
            pipeline.cache.circleOffsets ||
            (pipeline.cache.circleOffsets = buildCircleOffsets(
                opts.circleRadiusPx,
                opts.circleSampleStepPx
            ));

        pipeline.state.planes = [];

        const pitchMin = opts.coarsePitchMinDeg;
        const pitchMax = opts.coarsePitchMaxDeg;
        const pitchStep = Math.max(1, opts.coarsePitchStepDeg);
        const azStep = Math.max(1, opts.coarseAzStepDeg);

        pipeline.state.centers.forEach((center, idx) => {
            const faceLabel = `Face ${idx + 1} (center id=${center.id})`;
            console.groupCollapsed(
                `%c${faceLabel}`,
                "color:#9dff33;font-weight:bold;"
            );

            let best = null;

            for (let pitch = pitchMin; pitch <= pitchMax; pitch += pitchStep) {
                for (let az = 0; az < 360; az += azStep) {
                    const pl = makePlaneThroughPoint(
                        center.x,
                        center.y,
                        center.z0,
                        pitch,
                        az,
                        metersPerPx
                    );
                    const score = scorePlaneOverlapCircle(
                        pl,
                        center,
                        dsm,
                        w,
                        h,
                        offsets,
                        opts.thresholdM
                    );
                    if (!best || score.ratio > best.scoreLocal) {
                        best = { plane: pl, scoreLocal: score.ratio };
                    }
                }
            }

            if (!best) {
                console.warn(
                    "No valid best plane found (DSM invalid near center?)"
                );
                console.groupEnd();
                return;
            }

            pipeline.state.planes.push({
                id: center.id,
                center: { x: center.x, y: center.y, z0: center.z0 },
                plane: best.plane,
                scoreLocal: best.scoreLocal,
            });

            console.log("Best coarse:", {
                pitchDeg: best.plane.pitchDeg,
                thetaDeg: best.plane.thetaDeg,
                localOverlap: best.scoreLocal.toFixed(4),
            });

            console.groupEnd();
        });

        console.log("Coarse planes solved:", pipeline.state.planes.length);
        console.log(`PASS 2 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.groupEnd();

        pipelineRenderStage(pipeline, 2);
    }

    function pass3_refinePlanes(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 3/6 — refine (local+global weighted overlap)",
            "color:#ff4fd8;font-weight:bold;"
        );
        const t0 = nowMs();

        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;
        const metersPerPx = getMetersPerPx();
        const opts = pipeline.opts;

        if (!pipeline.state.planes || pipeline.state.planes.length === 0) {
            throw new Error("No coarse planes. Run pass 2 first.");
        }

        const offsets =
            pipeline.cache.circleOffsets ||
            (pipeline.cache.circleOffsets = buildCircleOffsets(
                opts.circleRadiusPx,
                opts.circleSampleStepPx
            ));

        const maskFn =
            typeof isMaskedPixel === "function" ? isMaskedPixel : null;

        const globalSamples =
            pipeline.cache.globalSamples ||
            (pipeline.cache.globalSamples = buildGlobalSamplesDeterministic(
                dsm,
                w,
                h,
                opts.globalSamples,
                maskFn,
                typeof roofMaskData !== "undefined" ? roofMaskData : null
            ));

        const refined = [];

        pipeline.state.planes.forEach((item, idx) => {
            const center = item.center;
            const base = item.plane;

            const faceLabel = `Face ${idx + 1} (center id=${item.id})`;
            console.groupCollapsed(
                `%c${faceLabel}`,
                "color:#9dff33;font-weight:bold;"
            );

            const pWin = opts.refinePitchWindowDeg;
            const aWin = opts.refineAzWindowDeg;
            const pStep = Math.max(0.25, opts.refinePitchStepDeg);
            const aStep = Math.max(0.5, opts.refineAzStepDeg);
            const wLocal = clamp(opts.localWeight, 0, 1);
            const wGlobal = 1 - wLocal;

            let best = null;

            for (
                let pitch = base.pitchDeg - pWin;
                pitch <= base.pitchDeg + pWin;
                pitch += pStep
            ) {
                const pClamped = clamp(pitch, 0, 85);
                for (
                    let az = base.thetaDeg - aWin;
                    az <= base.thetaDeg + aWin;
                    az += aStep
                ) {
                    let azNorm = az % 360;
                    if (azNorm < 0) azNorm += 360;

                    const pl = makePlaneThroughPoint(
                        center.x,
                        center.y,
                        center.z0,
                        pClamped,
                        azNorm,
                        metersPerPx
                    );

                    const local = scorePlaneOverlapCircle(
                        pl,
                        center,
                        dsm,
                        w,
                        h,
                        offsets,
                        opts.thresholdM
                    ).ratio;
                    const global = scorePlaneOverlapSamples(
                        pl,
                        globalSamples,
                        opts.thresholdM
                    );
                    const score = wLocal * local + wGlobal * global;

                    if (!best || score > best.score)
                        best = { plane: pl, score, local, global };
                }
            }

            if (!best) {
                console.warn("No refined plane found.");
                refined.push(item);
                console.groupEnd();
                return;
            }

            refined.push({
                id: item.id,
                center: item.center,
                plane: best.plane,
                scoreLocal: best.local,
                scoreGlobal: best.global,
                scoreCombined: best.score,
            });

            console.log("Refined:", {
                pitchDeg: best.plane.pitchDeg.toFixed(2),
                thetaDeg: best.plane.thetaDeg.toFixed(2),
                localOverlap: best.local.toFixed(4),
                globalOverlap: best.global.toFixed(4),
                combined: best.score.toFixed(4),
            });

            console.groupEnd();
        });

        pipeline.state.planes = refined;

        console.log("Refined planes:", refined.length);
        console.log(`PASS 3 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.groupEnd();

        pipelineRenderStage(pipeline, 3);
    }

    function pass4_edgeGrow(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 4/6 — edge-grow flood fill (DSM indicative region)",
            "color:#00ffff;font-weight:bold;"
        );
        const t0 = nowMs();

        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;
        const opts = pipeline.opts;

        if (!pipeline.state.planes || pipeline.state.planes.length < 1) {
            throw new Error("No planes. Run pass 2/3 first.");
        }

        const edgeTh =
            typeof opts.thresholdEdgeM === "number"
                ? opts.thresholdEdgeM
                : opts.thresholdM;

        const roofOnlyMaskFn = (x, y) => {
            if (
                typeof roofMaskData === "undefined" ||
                !roofMaskData ||
                roofMaskData.length !== w * h
            )
                return false;
            return !(roofMaskData[y * w + x] > 0);
        };

        const useMaskFn =
            typeof isMaskedPixel === "function"
                ? (x, y) => isMaskedPixel(x, y) || roofOnlyMaskFn(x, y)
                : roofOnlyMaskFn;

        const edgeMasks = [];
        const edgePolys = [];

        pipeline.state.planes.forEach((pi, i) => {
            const pl = pi.plane;
            const center = pi.center;

            console.groupCollapsed(
                `%cFace ${i + 1} — grow`,
                "color:#9dff33;font-weight:bold;"
            );
            console.log("thresholdEdgeM:", edgeTh);

            const grown = growRegionMaskFromCenter(
                dsm,
                w,
                h,
                center,
                pl,
                edgeTh,
                Math.max(2000, opts.edgeMaxPixelsPerFace | 0),
                useMaskFn
            );

            edgeMasks[i] = grown;

            // NEW STEP: hard-clip grown pixels to roofMaskData BEFORE contour/simplify
            const clipStats = clipMaskToRoofMask(grown, w, h);
            if (clipStats.removed > 0) {
                console.log("[PASS 4] roofMask clip:", clipStats);
            }

            if (!grown.startOk || grown.count < 50 || !grown.bbox) {
                console.warn("Grow failed / tiny region.", {
                    startOk: grown.startOk,
                    count: grown.count,
                });
                if (opts.edgeFallbackToDiscIfFail) {
                    const disc = makeDiscPoly(
                        center,
                        Math.max(18, opts.circleRadiusPx * 2.2),
                        44
                    );
                    edgePolys[i] = disc;
                    console.log("Fallback: disc poly.");
                } else {
                    edgePolys[i] = [];
                }
                console.groupEnd();
                return;
            }

            const contour = traceContour(
                grown.mask,
                w,
                h,
                grown.bbox,
                Math.max(5000, opts.edgeContourMaxSteps | 0)
            );

            if (!contour || contour.length < 20) {
                console.warn("Contour trace failed / tiny contour.", {
                    contourLen: contour?.length || 0,
                });
                if (opts.edgeFallbackToDiscIfFail) {
                    const disc = makeDiscPoly(
                        center,
                        Math.max(18, opts.circleRadiusPx * 2.2),
                        44
                    );
                    edgePolys[i] = disc;
                    console.log("Fallback: disc poly.");
                } else {
                    edgePolys[i] = [];
                }
                console.groupEnd();
                return;
            }

            let poly = contourToPoly(
                contour,
                Math.max(0.5, opts.edgeSimplifyEpsPx || 2),
                Math.max(120, opts.edgeMaxVertices | 0)
            );

            // NEW: prevent simplification from crossing outside the roof mask
            poly = enforcePolyInsideRoofMask(
                poly,
                w,
                h,
                opts.edgeSimplifyEpsPx,
                opts.edgeMaxVertices,
                opts.edgeContourMaxSteps
            );

            const area = Math.abs(polygonArea(poly));
            edgePolys[i] = poly;

            console.log("Grow stats:", {
                grownPixels: grown.count,
                bbox: grown.bbox,
                contourPts: contour.length,
                polyVerts: poly.length,
                polyAreaPx2: area.toFixed(0),
            });

            console.groupEnd();
        });

        // =========================
        // NEW: merge near-identical planes (PASS 4 post-process)
        // =========================
        if (opts.planeMergeEnabled !== false) {
            const mpp = getMetersPerPx();
            const overlapNeed = clamp(
                opts.planeMergeOverlapPct ?? 0.7,
                0,
                0.999
            );
            const angleTol = Math.max(0, opts.planeMergeAngleDeg ?? 4.0);
            const hTol = Math.max(0, opts.planeMergeHeightTolM ?? 0.05);
            const stride = Math.max(1, opts.planeMergeSampleStridePx ?? 2);

            const n = pipeline.state.planes.length;
            if (n > 1) {
                const uf = ufMake(n);

                for (let i = 0; i < n; i++) {
                    const mi = edgeMasks[i];
                    const pi = pipeline.state.planes[i];
                    if (!mi || !mi.mask || !mi.bbox || mi.count < 50) continue;

                    for (let j = i + 1; j < n; j++) {
                        const mj = edgeMasks[j];
                        const pj = pipeline.state.planes[j];
                        if (!mj || !mj.mask || !mj.bbox || mj.count < 50)
                            continue;

                        // angle similarity (pitch + az)
                        const dp = Math.abs(
                            (pi.plane.pitchDeg ?? 0) - (pj.plane.pitchDeg ?? 0)
                        );
                        const daz = angDiffDeg(
                            pi.plane.thetaDeg ?? 0,
                            pj.plane.thetaDeg ?? 0
                        );
                        if (dp > angleTol || daz > angleTol) continue;

                        // overlap + height consistency on overlap pixels
                        const { inter, meanAbsDz } =
                            computeMaskIntersectionAndHeightDelta(
                                mi.mask,
                                mj.mask,
                                mi.bbox,
                                mj.bbox,
                                pi.plane,
                                pj.plane,
                                w,
                                h,
                                stride
                            );
                        if (inter <= 0) continue;

                        const overlapRatio =
                            inter / Math.max(1, Math.min(mi.count, mj.count)); // “% of smaller area”
                        if (overlapRatio < overlapNeed) continue;

                        if (meanAbsDz > hTol) continue;

                        uf.union(i, j);
                    }
                }

                const groups = uf.groups().filter((g) => g.length > 1);

                if (groups.length) {
                    console.log(`[PASS 4] plane-merge groups:`, groups);

                    const newPlanes = [];
                    const newMasks = [];
                    const newPolys = [];

                    const used = new Uint8Array(n);

                    // build merged entries in stable order (by smallest original index)
                    groups.sort((a, b) => Math.min(...a) - Math.min(...b));

                    const buildMerged = (idxs) => {
                        // collect
                        const planes = idxs.map(
                            (k) => pipeline.state.planes[k].plane
                        );
                        const weights = idxs.map((k) =>
                            Math.max(1, edgeMasks[k]?.count || 1)
                        );

                        const mergedPlane = mergePlanesWeighted(
                            planes,
                            weights,
                            mpp
                        );

                        // merged mask
                        const masksToMerge = idxs
                            .map((k) => edgeMasks[k]?.mask)
                            .filter(Boolean);
                        const mergedMask = mergeMasksOR(masksToMerge, w, h);
                        const stats = recomputeMaskCountBBox(mergedMask, w, h);

                        // merged center: pick one of the original centers (NOT averaged)
                        // Prefer a center whose pixel is inside the merged mask.
                        let center = null;

                        for (let ii = 0; ii < idxs.length; ii++) {
                            const k = idxs[ii];
                            const c = pipeline.state.planes[k].center;
                            if (!c) continue;
                            const sx = clamp(Math.round(c.x), 0, w - 1);
                            const sy = clamp(Math.round(c.y), 0, h - 1);
                            const sIdx = sy * w + sx;
                            if (mergedMask[sIdx]) {
                                center = { x: c.x, y: c.y, z0: c.z0 };
                                break;
                            }
                        }

                        // Fallback: just take the first face's center
                        if (!center) {
                            const c0 = pipeline.state.planes[idxs[0]].center;
                            center = { x: c0.x, y: c0.y, z0: c0.z0 };
                        }

                        // contour -> poly
                        let poly = [];
                        if (stats.bbox && stats.count >= 50) {
                            const contour = traceContour(
                                mergedMask,
                                w,
                                h,
                                stats.bbox,
                                Math.max(5000, opts.edgeContourMaxSteps | 0)
                            );
                            if (contour && contour.length >= 20) {
                                poly = contourToPoly(
                                    contour,
                                    Math.max(0.5, opts.edgeSimplifyEpsPx || 2),
                                    Math.max(120, opts.edgeMaxVertices | 0)
                                );

                                // keep inside roof mask (same rule as individual faces)
                                poly = enforcePolyInsideRoofMask(
                                    poly,
                                    w,
                                    h,
                                    opts.edgeSimplifyEpsPx,
                                    opts.edgeMaxVertices,
                                    opts.edgeContourMaxSteps
                                );
                            }
                        }

                        if (!poly || poly.length < 3) {
                            // fallback disc if something went weird
                            poly = makeDiscPoly(
                                center,
                                Math.max(18, opts.circleRadiusPx * 2.2),
                                44
                            );
                        }

                        // mark used + emit
                        idxs.forEach((k) => (used[k] = 1));

                        newPlanes.push({
                            id: Math.min(...idxs) + 1,
                            center,
                            plane: {
                                ...mergedPlane,
                                x0: center.x,
                                y0: center.y,
                                z0: center.z0,
                            },
                            __mergedFrom: idxs.map((k) => k + 1),
                        });

                        newMasks.push({
                            mask: mergedMask,
                            count: stats.count,
                            bbox: stats.bbox,
                            startOk: true,
                        });

                        newPolys.push(poly);
                    };

                    // first: merged groups
                    for (const g of groups) buildMerged(g);

                    // then: untouched singles in original order
                    for (let i = 0; i < n; i++) {
                        if (used[i]) continue;
                        newPlanes.push(pipeline.state.planes[i]);
                        newMasks.push(edgeMasks[i]);
                        newPolys.push(edgePolys[i]);
                    }

                    pipeline.state.planes = newPlanes;
                    pipeline.state.edgeMasks = newMasks;
                    pipeline.state.edgePolys = newPolys;

                    console.log(
                        `[PASS 4] merged planes: ${n} -> ${newPlanes.length}`
                    );
                } else {
                    pipeline.state.edgeMasks = edgeMasks;
                    pipeline.state.edgePolys = edgePolys;
                }
            } else {
                pipeline.state.edgeMasks = edgeMasks;
                pipeline.state.edgePolys = edgePolys;
            }
        } else {
            pipeline.state.edgeMasks = edgeMasks;
            pipeline.state.edgePolys = edgePolys;
        }

        // =========================

        console.log(
            "Edge-grown polys:",
            (pipeline.state.edgePolys || []).filter((p) => p && p.length >= 3)
                .length,
            "/",
            (pipeline.state.edgePolys || []).length
        );
        console.log(`PASS 4 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.groupEnd();

        pipelineRenderStage(pipeline, 4);
    }

    /* =========================
    PASS 5 — GAPLESS PARTITION + SEAM-SAFE POLYGONIZE (FULL REPLACEMENT)
    ========================= */

    function renderOverlapDotsSVG(points, limit = 4000) {
        const svg = document.getElementById("geoSvg");
        if (!svg) return;
        const g = document.getElementById("geo-rotation-group") || svg;

        g.querySelectorAll(".facet-overlap-debug").forEach((n) => n.remove());

        const invZoom =
            1 /
            (typeof currentZoom !== "undefined" && currentZoom
                ? currentZoom
                : 1);
        const n = Math.min(points.length, limit);

        for (let i = 0; i < n; i++) {
            const p = points[i];
            const dot = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "circle"
            );
            dot.setAttribute("cx", p.x);
            dot.setAttribute("cy", p.y);
            dot.setAttribute("r", 2.6 * invZoom);
            dot.setAttribute("fill", "rgba(255,107,107,0.92)");
            dot.setAttribute("stroke", "rgba(0,0,0,0.85)");
            dot.setAttribute("stroke-width", 1.5 * invZoom);
            dot.setAttribute("class", "facet-overlap-debug");
            dot.style.pointerEvents = "none";
            g.appendChild(dot);
        }
    }

    function buildCircleOffsetsDense(radiusPx, stepPx = 1) {
        const offs = [];
        const r2 = radiusPx * radiusPx;
        const step = Math.max(1, stepPx | 0);
        for (let dy = -radiusPx; dy <= radiusPx; dy += step) {
            for (let dx = -radiusPx; dx <= radiusPx; dx += step) {
                if (dx * dx + dy * dy <= r2) offs.push({ dx, dy });
            }
        }
        return offs;
    }

    function meanAbsErrorOnDSMAt(dsm, w, h, plane, cx, cy, offsets, maskFn) {
        let sum = 0,
            n = 0;
        for (let k = 0; k < offsets.length; k++) {
            const x = cx + offsets[k].dx;
            const y = cy + offsets[k].dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (maskFn && maskFn(x, y)) continue;

            const z = getDSMZ(dsm, w, h, x, y);
            if (!isValidDSMZ(z)) continue;

            const pz = planeZ(plane, x, y);
            sum += Math.abs(z - pz);
            n++;
        }
        return n ? sum / n : Infinity;
    }

    // Build owner map that partitions the UNION of all masks (no deletions => no gaps)
    // owner[idx] = faceIndex, or -1 if not in union
    function buildOwnerMapFromMasks(
        masks,
        planes,
        centers,
        dsm,
        w,
        h,
        offsetsCheck,
        maskFn
    ) {
        const nFaces = masks.length;
        const owner = new Int32Array(w * h);
        owner.fill(-1);

        const counts = new Uint8Array(w * h);

        // mark union + overlaps
        for (let fi = 0; fi < nFaces; fi++) {
            const m = masks[fi];
            if (!m) continue;
            for (let idx = 0; idx < m.length; idx++) {
                if (!m[idx]) continue;
                counts[idx]++;
                if (owner[idx] === -1) owner[idx] = fi;
                else owner[idx] = -2; // overlap marker
            }
        }

        const overlaps = [];
        for (let idx = 0; idx < counts.length; idx++) {
            if (counts[idx] > 1) overlaps.push(idx);
        }

        // resolve overlaps PER PIXEL (no radius cutting)
        for (let oi = 0; oi < overlaps.length; oi++) {
            const idx = overlaps[oi];
            const x = idx % w;
            const y = (idx / w) | 0;

            let bestFace = -1;
            let bestErr = Infinity;

            for (let fi = 0; fi < nFaces; fi++) {
                const m = masks[fi];
                if (!m || !m[idx]) continue;

                const err = meanAbsErrorOnDSMAt(
                    dsm,
                    w,
                    h,
                    planes[fi],
                    x,
                    y,
                    offsetsCheck,
                    maskFn
                );
                if (err < bestErr) {
                    bestErr = err;
                    bestFace = fi;
                }
            }

            owner[idx] = bestFace >= 0 ? bestFace : -1;
        }

        // force centers to own their center pixel if it exists in union
        for (let fi = 0; fi < nFaces; fi++) {
            const c = centers[fi];
            if (!c) continue;
            const sx = clamp(Math.round(c.x), 0, w - 1);
            const sy = clamp(Math.round(c.y), 0, h - 1);
            const sIdx = sy * w + sx;
            if (counts[sIdx] > 0) owner[sIdx] = fi;
        }

        return { owner, counts, overlaps };
    }

    // Keep only center-connected region per face, BUT preserve union by relabeling leftovers
    function enforceConnectivityNoGaps(owner, unionCounts, centers, w, h) {
        const n = owner.length;
        const keep = new Uint8Array(n);
        const q = new Int32Array(n);

        // Mark center-connected component for each face label
        for (let fi = 0; fi < centers.length; fi++) {
            const c = centers[fi];
            if (!c) continue;

            const sx = clamp(Math.round(c.x), 0, w - 1);
            const sy = clamp(Math.round(c.y), 0, h - 1);
            const sIdx = sy * w + sx;

            if (unionCounts[sIdx] === 0) continue;
            if (owner[sIdx] !== fi) continue;
            if (keep[sIdx]) continue;

            let qh = 0,
                qt = 0;
            q[qt++] = sIdx;
            keep[sIdx] = 1;

            while (qh < qt) {
                const idx = q[qh++];
                const x = idx % w;

                const tryPush = (nIdx) => {
                    if (nIdx < 0 || nIdx >= n) return;
                    if (unionCounts[nIdx] === 0) return;
                    if (keep[nIdx]) return;
                    if (owner[nIdx] !== fi) return;
                    keep[nIdx] = 1;
                    q[qt++] = nIdx;
                };

                if (x > 0) tryPush(idx - 1);
                if (x < w - 1) tryPush(idx + 1);
                if (idx >= w) tryPush(idx - w);
                if (idx < n - w) tryPush(idx + w);
            }
        }

        // If no seeds, do nothing
        let anySeed = 0;
        for (let i = 0; i < keep.length; i++) {
            if (keep[i]) {
                anySeed = 1;
                break;
            }
        }
        if (!anySeed) return;

        // Unassign union pixels not connected to a center; they'll be re-filled
        for (let i = 0; i < n; i++) {
            if (unionCounts[i] > 0 && !keep[i]) owner[i] = -1;
        }

        // Multi-source fill from kept pixels to absorb unassigned union pixels
        let qh = 0,
            qt = 0;
        for (let i = 0; i < n; i++) {
            if (keep[i] && owner[i] >= 0) q[qt++] = i;
        }

        while (qh < qt) {
            const idx = q[qh++];
            const label = owner[idx];
            const x = idx % w;

            const tryFill = (nIdx) => {
                if (nIdx < 0 || nIdx >= n) return;
                if (unionCounts[nIdx] === 0) return;
                if (owner[nIdx] !== -1) return;
                owner[nIdx] = label;
                keep[nIdx] = 1;
                q[qt++] = nIdx;
            };

            if (x > 0) tryFill(idx - 1);
            if (x < w - 1) tryFill(idx + 1);
            if (idx >= w) tryFill(idx - w);
            if (idx < n - w) tryFill(idx + w);
        }

        // final safety: assign any remaining union pixels from neighbors
        for (let i = 0; i < n; i++) {
            if (unionCounts[i] === 0) continue;
            if (owner[i] !== -1) continue;

            const x = i % w;
            let v = -1;
            if (x > 0 && owner[i - 1] >= 0) v = owner[i - 1];
            else if (x < w - 1 && owner[i + 1] >= 0) v = owner[i + 1];
            else if (i >= w && owner[i - w] >= 0) v = owner[i - w];
            else if (i < n - w && owner[i + w] >= 0) v = owner[i + w];

            owner[i] = v >= 0 ? v : 0;
        }
    }

    function buildFaceBBoxes(owner, nFaces, w, h) {
        const bbox = new Array(nFaces);
        const counts = new Int32Array(nFaces);
        for (let i = 0; i < nFaces; i++) {
            bbox[i] = {
                minX: Infinity,
                minY: Infinity,
                maxX: -Infinity,
                maxY: -Infinity,
            };
        }

        for (let idx = 0; idx < owner.length; idx++) {
            const fi = owner[idx];
            if (fi < 0 || fi >= nFaces) continue;

            const x = idx % w;
            const y = (idx / w) | 0;

            counts[fi]++;
            const b = bbox[fi];
            if (x < b.minX) b.minX = x;
            if (y < b.minY) b.minY = y;
            if (x > b.maxX) b.maxX = x;
            if (y > b.maxY) b.maxY = y;
        }

        for (let i = 0; i < nFaces; i++) {
            if (!isFinite(bbox[i].minX)) bbox[i] = null;
        }

        return { bbox, counts };
    }

    function simplifyCollinearLoop(loop) {
        if (!loop || loop.length < 4) return loop || [];
        const out = [];
        const n = loop.length;

        for (let i = 0; i < n; i++) {
            const p0 = loop[(i - 1 + n) % n];
            const p1 = loop[i];
            const p2 = loop[(i + 1) % n];

            const dx1 = Math.sign(p1.x - p0.x);
            const dy1 = Math.sign(p1.y - p0.y);
            const dx2 = Math.sign(p2.x - p1.x);
            const dy2 = Math.sign(p2.y - p1.y);

            if (dx1 === dx2 && dy1 === dy2) continue;
            out.push(p1);
        }
        return out;
    }

    // Owner-map -> exact pixel-edge polygon (shared seam, no cracks)
    function buildFacePolyFromOwner(owner, fi, bbox, w, h) {
        if (!bbox) return [];
        const wv = w + 1;

        const vKey = (vx, vy) => vy * wv + vx;
        const adj = new Map();

        const addEdge = (a, b) => {
            let sa = adj.get(a);
            if (!sa) adj.set(a, (sa = new Set()));
            sa.add(b);
            let sb = adj.get(b);
            if (!sb) adj.set(b, (sb = new Set()));
            sb.add(a);
        };

        const removeEdge = (a, b) => {
            const sa = adj.get(a);
            if (sa) {
                sa.delete(b);
                if (!sa.size) adj.delete(a);
            }
            const sb = adj.get(b);
            if (sb) {
                sb.delete(a);
                if (!sb.size) adj.delete(b);
            }
        };

        const dirIndex = (dx, dy) => {
            if (dx === 1 && dy === 0) return 0;
            if (dx === 0 && dy === 1) return 1;
            if (dx === -1 && dy === 0) return 2;
            if (dx === 0 && dy === -1) return 3;
            return -1;
        };

        const pickNextRightHand = (prevK, currK, neighSet) => {
            const px = prevK % wv;
            const py = (prevK / wv) | 0;
            const cx = currK % wv;
            const cy = (currK / wv) | 0;

            const pd = dirIndex(cx - px, cy - py);
            if (pd < 0) return neighSet.values().next().value;

            const order = [(pd + 1) & 3, pd, (pd + 3) & 3, (pd + 2) & 3];
            for (let oi = 0; oi < order.length; oi++) {
                const want = order[oi];
                for (const nk of neighSet) {
                    const nx = nk % wv;
                    const ny = (nk / wv) | 0;
                    const nd = dirIndex(nx - cx, ny - cy);
                    if (nd === want) return nk;
                }
            }
            return neighSet.values().next().value;
        };

        const minX = clamp(bbox.minX | 0, 0, w - 1);
        const maxX = clamp(bbox.maxX | 0, 0, w - 1);
        const minY = clamp(bbox.minY | 0, 0, h - 1);
        const maxY = clamp(bbox.maxY | 0, 0, h - 1);

        for (let y = minY; y <= maxY; y++) {
            const row = y * w;
            for (let x = minX; x <= maxX; x++) {
                const idx = row + x;
                if (owner[idx] !== fi) continue;

                if (x === 0 || owner[idx - 1] !== fi)
                    addEdge(vKey(x, y), vKey(x, y + 1));
                if (x === w - 1 || owner[idx + 1] !== fi)
                    addEdge(vKey(x + 1, y), vKey(x + 1, y + 1));
                if (y === 0 || owner[idx - w] !== fi)
                    addEdge(vKey(x, y), vKey(x + 1, y));
                if (y === h - 1 || owner[idx + w] !== fi)
                    addEdge(vKey(x, y + 1), vKey(x + 1, y + 1));
            }
        }

        if (!adj.size) return [];

        const loops = [];

        while (adj.size) {
            let startK = -1;
            let startSet = null;
            for (const [k, s] of adj) {
                if (s && s.size) {
                    startK = k;
                    startSet = s;
                    break;
                }
            }
            if (startK < 0 || !startSet || !startSet.size) break;

            const firstN = startSet.values().next().value;

            let prevK = startK;
            let currK = firstN;
            removeEdge(prevK, currK);

            const loop = [];
            loop.push({ x: prevK % wv, y: (prevK / wv) | 0 });

            let guard = 0;
            const GUARD_MAX = 4_000_000;

            while (guard++ < GUARD_MAX) {
                loop.push({ x: currK % wv, y: (currK / wv) | 0 });
                if (currK === startK) break;

                const neigh = adj.get(currK);
                if (!neigh || !neigh.size) break;

                const nextK =
                    neigh.size === 1
                        ? neigh.values().next().value
                        : pickNextRightHand(prevK, currK, neigh);

                removeEdge(currK, nextK);
                prevK = currK;
                currK = nextK;
            }

            if (loop.length > 2) {
                const a = loop[0],
                    b = loop[loop.length - 1];
                if (a.x === b.x && a.y === b.y) loop.pop();
            }

            const simp = simplifyCollinearLoop(loop);
            if (simp.length >= 3) loops.push(simp);
        }

        if (!loops.length) return [];

        // pick largest loop
        let best = loops[0];
        let bestA = Math.abs(polygonArea(best));
        for (let i = 1; i < loops.length; i++) {
            const a = Math.abs(polygonArea(loops[i]));
            if (a > bestA) {
                bestA = a;
                best = loops[i];
            }
        }
        return best;
    }

    function pass5_intersectionsAndTrim(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 5/6 — overlap resolve (gapless partition) + seam-safe polygonize + RDP simplify",
            "color:#ffd166;font-weight:bold;"
        );
        const t0 = nowMs();

        const dsm = getDSM();
        const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
        const h = typeof imageHeight !== "undefined" ? imageHeight : 0;
        const opts = pipeline.opts;

        if (!pipeline.state.planes || pipeline.state.planes.length < 1) {
            throw new Error("No planes. Run pass 2/3 first.");
        }
        if (
            !pipeline.state.edgeMasks ||
            pipeline.state.edgeMasks.length !== pipeline.state.planes.length
        ) {
            throw new Error("Missing edgeMasks from pass 4. Run pass 4 first.");
        }

        const maskFn =
            typeof isMaskedPixel === "function" ? isMaskedPixel : null;

        const rCheck = Math.max(2, opts.overlapCheckRadiusPx | 0);
        const offsetsCheck =
            pipeline.cache.overlapOffsetsCheck ||
            (pipeline.cache.overlapOffsetsCheck = buildCircleOffsetsDense(
                rCheck,
                1
            ));

        const nFaces = pipeline.state.planes.length;
        const planes = pipeline.state.planes.map((p) => p.plane);
        const centers = pipeline.state.planes.map((p) => p.center);

        const masks = new Array(nFaces);
        for (let i = 0; i < nFaces; i++)
            masks[i] = pipeline.state.edgeMasks[i]?.mask;

        const {
            owner,
            counts: unionCounts,
            overlaps,
        } = buildOwnerMapFromMasks(
            masks,
            planes,
            centers,
            dsm,
            w,
            h,
            offsetsCheck,
            maskFn
        );

        console.log("[PASS 5] overlap pixels (pre-resolve):", overlaps.length);

        // show overlap dots sample
        {
            const cap = Math.max(200, opts.overlapDebugMaxDots | 0);
            const debugDots = [];
            const stride = Math.max(1, Math.floor(overlaps.length / cap));
            for (let k = 0; k < overlaps.length; k += stride) {
                const idx = overlaps[k];
                debugDots.push({ x: idx % w, y: (idx / w) | 0 });
            }
            renderOverlapDotsSVG(debugDots, cap);
        }

        enforceConnectivityNoGaps(owner, unionCounts, centers, w, h);

        const { bbox, counts: pxCounts } = buildFaceBBoxes(owner, nFaces, w, h);

        const polys = new Array(nFaces);
        for (let fi = 0; fi < nFaces; fi++) {
            if (!bbox[fi] || pxCounts[fi] <= 0) {
                polys[fi] = [];
                continue;
            }
            const poly = buildFacePolyFromOwner(owner, fi, bbox[fi], w, h);
            polys[fi] = poly && poly.length >= 3 ? poly : [];
        }

        // =========================================================
        // NEW: RDP simplification pass (post seam-safe polygonize)
        // =========================================================
        const eps =
            typeof opts.stage5SimplifyEpsPx === "number"
                ? opts.stage5SimplifyEpsPx
                : typeof opts.edgeSimplifyEpsPx === "number"
                ? opts.edgeSimplifyEpsPx
                : 0;

        const maxVerts =
            typeof opts.stage5MaxVertices === "number"
                ? opts.stage5MaxVertices | 0
                : typeof opts.edgeMaxVertices === "number"
                ? opts.edgeMaxVertices | 0
                : 0;

        if (eps > 0) {
            for (let i = 0; i < polys.length; i++) {
                let poly = polys[i];
                if (!poly || poly.length < 3) continue;

                // RDP expects a polyline; close it
                const work = poly.map((p) => ({ x: p.x + 0.0, y: p.y + 0.0 }));
                work.push({ ...work[0] });

                let simp = rdpSimplify(work, Math.max(0.5, eps));

                // drop closing duplicate
                if (simp.length > 2) simp.pop();

                // if simplification got too aggressive, keep original
                if (!simp || simp.length < 3) continue;

                // optional vertex cap
                if (maxVerts && simp.length > maxVerts) {
                    const step = Math.ceil(simp.length / maxVerts);
                    const tmp = [];
                    for (let k = 0; k < simp.length; k += step)
                        tmp.push(simp[k]);
                    if (tmp.length >= 3) simp = tmp;
                }

                // NEW: enforce roof mask so simplification can't cross outside
                // NOTE: uses the helper from PASS 4 patch
                const simpClipped = enforcePolyInsideRoofMask(
                    simp,
                    w,
                    h,
                    eps,
                    maxVerts,
                    opts.edgeContourMaxSteps
                );

                // If clipping nuked it, skip (or you can fall back to original poly)
                if (!simpClipped || simpClipped.length < 3) continue;

                // tiny-area safety (compare against original)
                const a0 = Math.abs(polygonArea(poly));
                const a1 = Math.abs(polygonArea(simpClipped));
                if (a1 < 10 || (a0 > 0 && a1 < a0 * 0.05)) continue;

                polys[i] = simpClipped;
            }
        }

        // =========================================================

        pipeline.state.polys = polys;

        console.log(
            "Resolved polygons:",
            polys.filter((p) => p && p.length >= 3).length,
            "/",
            polys.length,
            eps > 0 ? `(RDP reapply eps=${eps}px)` : `(no RDP reapply)`
        );

        console.log(`PASS 5 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.groupEnd();

        pipelineRenderStage(pipeline, 5);
    }

    /* =========================
     PASS 6 — PUBLISH + 3D POINT MERGE (ACROSS FACES)
     ========================= */

    // --- PASS 6A.5: COLLINEAR EDGE ALIGN (rotate shorter to match longer) ---
    function pass6_alignNearlyCollinearEdges(geo, segs, mpp, opts) {
        const enabled = opts.collinearAlignEnabled !== false;
        const degTol = Math.max(0, opts.collinearAlignDeg ?? 30.0);
        const minLen = Math.max(0, opts.collinearAlignMinLenM ?? 0.0);
        if (!enabled || degTol <= 0 || !segs || segs.length < 2 || !(mpp > 0)) {
            return 0;
        }

        const tolRad = (degTol * Math.PI) / 180;
        const cosTol = Math.cos(tolRad);

        // point -> list of incident segment indices
        const inc = new Map();
        const addInc = (p, si) => {
            let a = inc.get(p);
            if (!a) inc.set(p, (a = []));
            a.push(si);
        };

        for (let si = 0; si < segs.length; si++) {
            const s = segs[si];
            if (!s || !s.a || !s.b) continue;
            addInc(s.a, si);
            addInc(s.b, si);
        }

        const clamp01 = (t) => Math.max(0, Math.min(1, t));
        const safeUnit2 = (vx, vy) => {
            const L = Math.hypot(vx, vy);
            if (!(L > 1e-9)) return null;
            return { ux: vx / L, uy: vy / L, L };
        };

        // Deterministic: compute all proposed endpoint moves, then apply best per point.
        // endpointTarget: Map<point, {xPx,yPx,zM, scoreCos, moveM}>
        const endpointTarget = new Map();

        for (const [p, list] of inc.entries()) {
            if (!p || !list || list.length < 2) continue;

            // Build per-incident vector info from p -> other endpoint
            const arms = [];
            const pxM = p.__xM !== undefined ? p.__xM : p.x * mpp;
            const pyM = p.__yM !== undefined ? p.__yM : p.y * mpp;
            const pzM = p.z;

            for (let ii = 0; ii < list.length; ii++) {
                const si = list[ii];
                const s = segs[si];
                if (!s) continue;

                const other = s.a === p ? s.b : s.b === p ? s.a : null;
                if (!other || other === p) continue;

                const oxM =
                    other.__xM !== undefined ? other.__xM : other.x * mpp;
                const oyM =
                    other.__yM !== undefined ? other.__yM : other.y * mpp;

                const vx = oxM - pxM;
                const vy = oyM - pyM;

                const u = safeUnit2(vx, vy);
                if (!u) continue;

                if (u.L < minLen) continue;

                arms.push({
                    si,
                    other,
                    ux: u.ux,
                    uy: u.uy,
                    lenM: u.L,
                    // store for tie-break / later
                    oxM,
                    oyM,
                });
            }

            if (arms.length < 2) continue;

            // Compare all pairs of arms
            for (let i = 0; i < arms.length; i++) {
                for (let j = i + 1; j < arms.length; j++) {
                    const a1 = arms[i];
                    const a2 = arms[j];

                    // angle via dot (in XY). use abs(dot) because nearly-collinear includes opposite direction?
                    // You asked "going out from it" so treat opposite as NOT collinear; keep sign.
                    const dot = a1.ux * a2.ux + a1.uy * a2.uy;
                    if (dot < cosTol) continue; // angle >= tol

                    // choose longer/shorter by XY length
                    let long = a1,
                        short = a2;
                    if (a2.lenM > a1.lenM) {
                        long = a2;
                        short = a1;
                    }

                    // Align short's endpoint onto long's ray, preserving short length
                    const nxM = pxM + long.ux * short.lenM;
                    const nyM = pyM + long.uy * short.lenM;

                    // Z: interpolate along the LONG edge using t = (shortLen / longLen)
                    // This puts the rotated endpoint "on the longer line" in 3D sense too.
                    let nzM = short.other.z;
                    if (isFinite(pzM) && isFinite(long.other?.z)) {
                        const t = clamp01(
                            short.lenM / Math.max(1e-9, long.lenM)
                        );
                        nzM = pzM + (long.other.z - pzM) * t;
                    }

                    const xPx = nxM / mpp;
                    const yPx = nyM / mpp;

                    // tie-break: prefer highest dot (smallest angle), then smallest movement
                    const moveM = Math.hypot(short.oxM - nxM, short.oyM - nyM);
                    const scoreCos = dot;

                    const prev = endpointTarget.get(short.other);
                    if (!prev) {
                        endpointTarget.set(short.other, {
                            xPx,
                            yPx,
                            zM: nzM,
                            scoreCos,
                            moveM,
                        });
                    } else {
                        if (scoreCos > prev.scoreCos + 1e-12) {
                            endpointTarget.set(short.other, {
                                xPx,
                                yPx,
                                zM: nzM,
                                scoreCos,
                                moveM,
                            });
                        } else if (
                            Math.abs(scoreCos - prev.scoreCos) <= 1e-12 &&
                            moveM < prev.moveM
                        ) {
                            endpointTarget.set(short.other, {
                                xPx,
                                yPx,
                                zM: nzM,
                                scoreCos,
                                moveM,
                            });
                        }
                    }
                }
            }
        }

        // Apply
        let moved = 0;
        for (const [pt, t] of endpointTarget.entries()) {
            if (!pt) continue;
            pt.x = t.xPx;
            pt.y = t.yPx;
            if (isFinite(t.zM)) pt.z = t.zM;
            pt.zLocked = true;

            // keep caches consistent for later passes
            pt.__xM = pt.x * mpp;
            pt.__yM = pt.y * mpp;

            moved++;
        }

        // IMPORTANT: segs cached meter coords are now stale; refresh them
        for (let si = 0; si < segs.length; si++) {
            const s = segs[si];
            if (!s || !s.a || !s.b) continue;

            s.axM = s.a.__xM !== undefined ? s.a.__xM : s.a.x * mpp;
            s.ayM = s.a.__yM !== undefined ? s.a.__yM : s.a.y * mpp;
            s.bxM = s.b.__xM !== undefined ? s.b.__xM : s.b.x * mpp;
            s.byM = s.b.__yM !== undefined ? s.b.__yM : s.b.y * mpp;

            s.minX = Math.min(s.axM, s.bxM);
            s.maxX = Math.max(s.axM, s.bxM);
            s.minY = Math.min(s.ayM, s.byM);
            s.maxY = Math.max(s.ayM, s.byM);
        }

        return moved;
    }

    function pass6_publishFaces(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 6/6 — publish to manualFaces + render (3D point merge + point→line snap)",
            "color:#33d6ff;font-weight:bold;"
        );
        const t0 = nowMs();

        ensureActiveGeometry();
        const geo = activeGeometry;

        if (!pipeline.state.planes || !pipeline.state.polys) {
            throw new Error("Missing planes/polys. Run pass 5 first.");
        }

        clearPipelineGeneratedFaces(pipeline);

        const planes = pipeline.state.planes;
        const polys = pipeline.state.polys;
        const layer = pipeline.opts.publishLayer || 1;
        const addConns = !!pipeline.opts.publishAddConnections;

        // --- PASS 6A: GLOBAL 3D POINT WELDING (across ALL faces) ---
        const mergeR = Math.max(0, pipeline.opts.mergeRadius3dM || 0);
        const mpp = getMetersPerPx();
        const canWeld = mergeR > 0 && mpp > 0 && isFinite(mpp);

        const cellSize = canWeld ? mergeR : 1; // meters
        const grid = new Map(); // key -> array of canonical points
        const cellKey = (ix, iy, iz) => `${ix},${iy},${iz}`;

        const getCellCoordsMeters = (xPx, yPx, zM) => {
            const xM = xPx * mpp;
            const yM = yPx * mpp;
            const ix = Math.floor(xM / cellSize);
            const iy = Math.floor(yM / cellSize);
            const iz = Math.floor(zM / cellSize);
            return { ix, iy, iz, xM, yM };
        };

        const dist3Meters = (p, xM, yM, zM) => {
            const dx = (p.__xM || 0) - xM;
            const dy = (p.__yM || 0) - yM;
            const dz = (p.z || 0) - zM;
            return Math.hypot(dx, dy, dz);
        };

        let ptCount = 0;
        let faceCount = 0;

        function weldPoint3D(xPx, yPx, zM, outLayer) {
            if (!canWeld || !isFinite(zM)) {
                const p = {
                    x: xPx,
                    y: yPx,
                    z: zM,
                    zLocked: true,
                    layer: outLayer,
                    __autoFacet: true,
                };
                geo.points.push(p);
                ptCount++;
                return p;
            }

            const { ix, iy, iz, xM, yM } = getCellCoordsMeters(xPx, yPx, zM);
            const rCells = Math.max(1, pipeline.opts.mergeGridCells || 1);
            const allowAcrossLayers = pipeline.opts.mergeAcrossLayers !== false;

            let best = null;
            let bestD = mergeR;

            for (let dz = -rCells; dz <= rCells; dz++) {
                for (let dy = -rCells; dy <= rCells; dy++) {
                    for (let dx = -rCells; dx <= rCells; dx++) {
                        const key = cellKey(ix + dx, iy + dy, iz + dz);
                        const bucket = grid.get(key);
                        if (!bucket) continue;

                        for (let i = 0; i < bucket.length; i++) {
                            const cand = bucket[i];
                            if (!allowAcrossLayers && cand.layer !== outLayer)
                                continue;

                            const d = dist3Meters(cand, xM, yM, zM);
                            if (d <= bestD) {
                                bestD = d;
                                best = cand;
                            }
                        }
                    }
                }
            }

            if (best) {
                // running average (existing behavior)
                const n0 = best.__weldN || 1;
                const n1 = n0 + 1;

                best.x = (best.x * n0 + xPx) / n1;
                best.y = (best.y * n0 + yPx) / n1;
                best.z = (best.z * n0 + zM) / n1;

                // keep caches consistent
                best.__xM = best.x * mpp;
                best.__yM = best.y * mpp;

                best.__weldN = n1;
                return best;
            }

            const p = {
                x: xPx,
                y: yPx,
                z: zM,
                zLocked: true,
                layer: outLayer,
                __autoFacet: true,
            };
            p.__xM = xM;
            p.__yM = yM;

            const homeKey = cellKey(ix, iy, iz);
            let bucket = grid.get(homeKey);
            if (!bucket) grid.set(homeKey, (bucket = []));
            bucket.push(p);

            geo.points.push(p);
            ptCount++;
            return p;
        }

        // We'll collect segments even if addConns=false so the snap pass can run.
        const segs = []; // {a,b, axM,ayM,bxM,byM, minX,maxX,minY,maxY}
        function addSegment(a, b) {
            if (!a || !b || a === b) return;
            const axM = a.x * mpp,
                ayM = a.y * mpp;
            const bxM = b.x * mpp,
                byM = b.y * mpp;
            const minX = Math.min(axM, bxM),
                maxX = Math.max(axM, bxM);
            const minY = Math.min(ayM, byM),
                maxY = Math.max(ayM, byM);
            segs.push({ a, b, axM, ayM, bxM, byM, minX, maxX, minY, maxY });
        }

        // Build points (welded or unique) + segments (+ optional connections)
        for (let i = 0; i < polys.length; i++) {
            const poly = polys[i];
            if (!poly || poly.length < 3) continue;

            const pl = planes[i]?.plane;
            if (!pl) continue;

            const pts = [];
            for (let k = 0; k < poly.length; k++) {
                const vx = poly[k].x;
                const vy = poly[k].y;
                const vz = planeZ(pl, vx, vy);
                pts.push(weldPoint3D(vx, vy, vz, layer));
            }

            faceCount++;
            // segments for snapping
            for (let k = 0; k < pts.length; k++)
                addSegment(pts[k], pts[(k + 1) % pts.length]);

            if (addConns) {
                for (let k = 0; k < pts.length; k++) {
                    const p1 = pts[k];
                    const p2 = pts[(k + 1) % pts.length];
                    geo.connections.push({
                        start: p1,
                        end: p2,
                        __autoFacet: true,
                    });
                }
            }
        }

        const alignedCount = pass6_alignNearlyCollinearEdges(
            geo,
            segs,
            mpp,
            pipeline.opts
        );
        if (alignedCount) {
            console.log(
                `[PASS 6] collinear-align moved endpoints: ${alignedCount} (tol=${pipeline.opts.collinearAlignDeg}°)`
            );
        }

        // --- PASS 6B: POINT → LINE SNAP (no averaging; snap to projection) ---
        const snapR = Math.max(0, pipeline.opts.lineSnapRadiusM || 0);
        const canSnap =
            snapR > 0 && mpp > 0 && isFinite(mpp) && segs.length > 0;

        let snappedCount = 0;

        if (canSnap) {
            const cell = snapR; // meters
            const segGrid = new Map(); // "ix,iy" -> array of seg indices
            const key2 = (ix, iy) => `${ix},${iy}`;

            const put = (ix, iy, si) => {
                const k = key2(ix, iy);
                let arr = segGrid.get(k);
                if (!arr) segGrid.set(k, (arr = []));
                arr.push(si);
            };

            // Insert segments into grid by sampling along them at ~cell spacing.
            for (let si = 0; si < segs.length; si++) {
                const s = segs[si];
                const dx = s.bxM - s.axM;
                const dy = s.byM - s.ayM;
                const len = Math.hypot(dx, dy);
                if (!(len > 1e-6)) continue;

                const steps = Math.max(1, Math.ceil(len / cell));
                for (let t = 0; t <= steps; t++) {
                    const tt = t / steps;
                    const xM = s.axM + dx * tt;
                    const yM = s.ayM + dy * tt;
                    put(Math.floor(xM / cell), Math.floor(yM / cell), si);
                }
            }

            const rCells = Math.max(1, pipeline.opts.lineSnapGridCells || 1);
            const allowAcrossLayers =
                pipeline.opts.lineSnapAcrossLayers !== false;

            // Deterministic: compute all snap targets using pre-snap segment coords, then apply.
            const targets = new Map(); // point -> {xPx,yPx,zM}
            const snapHits = new Map(); // point -> { seg, t }

            const projectPointToSegXY = (pxM, pyM, s) => {
                const vx = s.bxM - s.axM;
                const vy = s.byM - s.ayM;
                const wx = pxM - s.axM;
                const wy = pyM - s.ayM;
                const denom = vx * vx + vy * vy;
                if (!(denom > 1e-9)) return null;
                let t = (wx * vx + wy * vy) / denom;
                t = Math.max(0, Math.min(1, t));
                const xM = s.axM + vx * t;
                const yM = s.ayM + vy * t;
                const d = Math.hypot(pxM - xM, pyM - yM);
                return { t, xM, yM, d };
            };

            for (let pi = 0; pi < geo.points.length; pi++) {
                const p = geo.points[pi];
                if (!p || !p.__autoFacet) continue;

                const pxM = p.__xM !== undefined ? p.__xM : p.x * mpp;
                const pyM = p.__yM !== undefined ? p.__yM : p.y * mpp;

                const ix = Math.floor(pxM / cell);
                const iy = Math.floor(pyM / cell);

                let best = null;
                let bestSeg = null;

                const seen = new Set();

                for (let gy = -rCells; gy <= rCells; gy++) {
                    for (let gx = -rCells; gx <= rCells; gx++) {
                        const arr = segGrid.get(key2(ix + gx, iy + gy));
                        if (!arr) continue;

                        for (let ii = 0; ii < arr.length; ii++) {
                            const si = arr[ii];
                            if (seen.has(si)) continue;
                            seen.add(si);

                            const s = segs[si];

                            // Avoid snapping to your own incident edges (degenerate self-snap)
                            if (s.a === p || s.b === p) continue;

                            if (!allowAcrossLayers) {
                                // if layers differ, skip
                                if (
                                    (s.a?.layer ?? layer) !==
                                        (p.layer ?? layer) ||
                                    (s.b?.layer ?? layer) !== (p.layer ?? layer)
                                )
                                    continue;
                            }

                            // quick AABB reject (+ snapR padding)
                            if (
                                pxM < s.minX - snapR ||
                                pxM > s.maxX + snapR ||
                                pyM < s.minY - snapR ||
                                pyM > s.maxY + snapR
                            )
                                continue;

                            const pr = projectPointToSegXY(pxM, pyM, s);
                            if (!pr) continue;
                            if (pr.d > snapR) continue;

                            if (!best || pr.d < best.d) {
                                best = pr;
                                bestSeg = s;
                            }
                        }
                    }
                }

                if (best && bestSeg) {
                    // Snap XY to projection; Z to segment Z by interpolation (no averaging).
                    const xPx = best.xM / mpp;
                    const yPx = best.yM / mpp;

                    let zM = p.z;
                    const za = bestSeg.a?.z;
                    const zb = bestSeg.b?.z;
                    if (isFinite(za) && isFinite(zb)) {
                        zM = za + (zb - za) * best.t;
                    }

                    targets.set(p, { xPx, yPx, zM });
                    snapHits.set(p, { seg: bestSeg, t: best.t });
                }
            }

            // Apply snaps
            for (const [p, t] of targets.entries()) {
                p.x = t.xPx;
                p.y = t.yPx;
                if (isFinite(t.zM)) p.z = t.zM;
                p.zLocked = true;
                p.__xM = p.x * mpp;
                p.__yM = p.y * mpp;
                snappedCount++;
            }

            // NEW: allow multiple snap passes (sometimes a snap creates new opportunities)
            const snapPasses = Math.max(
                1,
                (pipeline.opts.lineSnapPasses ?? 1) | 0
            );

            for (let passIdx = 0; passIdx < snapPasses; passIdx++) {
                // Rebuild seg-grid fresh each pass (segs may change after split/collapse)
                const cell = snapR; // meters
                const segGrid = new Map(); // "ix,iy" -> array of seg indices
                const key2 = (ix, iy) => `${ix},${iy}`;

                const put = (ix, iy, si) => {
                    const k = key2(ix, iy);
                    let arr = segGrid.get(k);
                    if (!arr) segGrid.set(k, (arr = []));
                    arr.push(si);
                };

                // Insert segments into grid by sampling along them at ~cell spacing.
                for (let si = 0; si < segs.length; si++) {
                    const s = segs[si];
                    if (!s || !s.a || !s.b || s.a === s.b) continue;

                    // refresh cached meters (in case prior pass moved endpoints)
                    s.axM = s.a.__xM !== undefined ? s.a.__xM : s.a.x * mpp;
                    s.ayM = s.a.__yM !== undefined ? s.a.__yM : s.a.y * mpp;
                    s.bxM = s.b.__xM !== undefined ? s.b.__xM : s.b.x * mpp;
                    s.byM = s.b.__yM !== undefined ? s.b.__yM : s.b.y * mpp;

                    s.minX = Math.min(s.axM, s.bxM);
                    s.maxX = Math.max(s.axM, s.bxM);
                    s.minY = Math.min(s.ayM, s.byM);
                    s.maxY = Math.max(s.ayM, s.byM);

                    const dx = s.bxM - s.axM;
                    const dy = s.byM - s.ayM;
                    const len = Math.hypot(dx, dy);
                    if (!(len > 1e-6)) continue;

                    const steps = Math.max(1, Math.ceil(len / cell));
                    for (let t = 0; t <= steps; t++) {
                        const tt = t / steps;
                        const xM = s.axM + dx * tt;
                        const yM = s.ayM + dy * tt;
                        put(Math.floor(xM / cell), Math.floor(yM / cell), si);
                    }
                }

                const rCells = Math.max(
                    1,
                    pipeline.opts.lineSnapGridCells || 1
                );
                const allowAcrossLayers =
                    pipeline.opts.lineSnapAcrossLayers !== false;

                // Deterministic: compute all snap targets using pre-snap segment coords, then apply.
                const targets = new Map(); // point -> {xPx,yPx,zM}
                const snapHits = new Map(); // point -> { segIndex, t, a, b }

                const projectPointToSegXY = (pxM, pyM, s) => {
                    const vx = s.bxM - s.axM;
                    const vy = s.byM - s.ayM;
                    const wx = pxM - s.axM;
                    const wy = pyM - s.ayM;
                    const denom = vx * vx + vy * vy;
                    if (!(denom > 1e-9)) return null;
                    let t = (wx * vx + wy * vy) / denom;
                    t = Math.max(0, Math.min(1, t));
                    const xM = s.axM + vx * t;
                    const yM = s.ayM + vy * t;
                    const d = Math.hypot(pxM - xM, pyM - yM);
                    return { t, xM, yM, d };
                };

                // NOTE: scan only autoFacet points (same as you already do)
                for (let pi = 0; pi < geo.points.length; pi++) {
                    const p = geo.points[pi];
                    if (!p || !p.__autoFacet) continue;

                    const pxM = p.__xM !== undefined ? p.__xM : p.x * mpp;
                    const pyM = p.__yM !== undefined ? p.__yM : p.y * mpp;

                    const ix = Math.floor(pxM / cell);
                    const iy = Math.floor(pyM / cell);

                    let best = null;
                    let bestSi = -1;

                    const seen = new Set();

                    for (let gy = -rCells; gy <= rCells; gy++) {
                        for (let gx = -rCells; gx <= rCells; gx++) {
                            const arr = segGrid.get(key2(ix + gx, iy + gy));
                            if (!arr) continue;

                            for (let ii = 0; ii < arr.length; ii++) {
                                const si = arr[ii];
                                if (seen.has(si)) continue;
                                seen.add(si);

                                const s = segs[si];
                                if (!s || !s.a || !s.b) continue;

                                // Avoid snapping to your own incident edges (degenerate self-snap)
                                if (s.a === p || s.b === p) continue;

                                if (!allowAcrossLayers) {
                                    if (
                                        (s.a?.layer ?? layer) !==
                                            (p.layer ?? layer) ||
                                        (s.b?.layer ?? layer) !==
                                            (p.layer ?? layer)
                                    )
                                        continue;
                                }

                                // quick AABB reject (+ snapR padding)
                                if (
                                    pxM < s.minX - snapR ||
                                    pxM > s.maxX + snapR ||
                                    pyM < s.minY - snapR ||
                                    pyM > s.maxY + snapR
                                )
                                    continue;

                                const pr = projectPointToSegXY(pxM, pyM, s);
                                if (!pr) continue;
                                if (pr.d > snapR) continue;

                                if (!best || pr.d < best.d) {
                                    best = pr;
                                    bestSi = si;
                                }
                            }
                        }
                    }

                    if (best && bestSi >= 0) {
                        const s = segs[bestSi];

                        const xPx = best.xM / mpp;
                        const yPx = best.yM / mpp;

                        // Z to segment Z by interpolation
                        let zM = p.z;
                        const za = s.a?.z;
                        const zb = s.b?.z;
                        if (isFinite(za) && isFinite(zb))
                            zM = za + (zb - za) * best.t;

                        targets.set(p, { xPx, yPx, zM });
                        snapHits.set(p, {
                            segIndex: bestSi,
                            t: best.t,
                            a: s.a,
                            b: s.b,
                        });
                    }
                }

                // Apply snaps
                let localSnapped = 0;
                for (const [p, t] of targets.entries()) {
                    p.x = t.xPx;
                    p.y = t.yPx;
                    if (isFinite(t.zM)) p.z = t.zM;
                    p.zLocked = true;
                    p.__xM = p.x * mpp;
                    p.__yM = p.y * mpp;
                    localSnapped++;
                }
                snappedCount += localSnapped;

                // --- PASS 6B.5: COLLAPSE OR SPLIT ---
                function collapseOrSplitSnaps(segs, snapHits, mpp) {
                    if (!segs || !segs.length || !snapHits || !snapHits.size) {
                        return {
                            newSegs: segs,
                            splitCount: 0,
                            collapsedPoints: 0,
                        };
                    }

                    // Build incident neighbor map for CURRENT segs (pre-modification)
                    const inc = new Map(); // point -> Set(neighborPoint)
                    const addN = (p, q) => {
                        let s = inc.get(p);
                        if (!s) inc.set(p, (s = new Set()));
                        s.add(q);
                    };
                    for (let i = 0; i < segs.length; i++) {
                        const s = segs[i];
                        if (!s || !s.a || !s.b || s.a === s.b) continue;
                        addN(s.a, s.b);
                        addN(s.b, s.a);
                    }

                    // Decide which snapped points should be "collapsed" instead of splitting target
                    const collapsePoint = new Set(); // points to delete
                    const removeSegKey = new Set(); // "aid|bid" segments to remove (A-P and P-B)
                    const splitByTargetSeg = new Map(); // segIndex -> [{p,t}...]

                    const pidMap = new WeakMap();
                    let pidNext = 1;
                    const pid = (p) => {
                        if (!p) return 0;
                        let id = pidMap.get(p);
                        if (!id) pidMap.set(p, (id = pidNext++));
                        return id;
                    };
                    const eKey = (a, b) => {
                        const ia = pid(a),
                            ib = pid(b);
                        return ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
                    };

                    const epsT = 1e-4;

                    for (const [p, hit] of snapHits.entries()) {
                        if (!p || !hit) continue;
                        const A = hit.a,
                            B = hit.b;
                        const t = Math.max(0, Math.min(1, hit.t ?? 0));
                        if (t <= epsT || t >= 1 - epsT) continue; // ignore snaps at endpoints

                        // Degree of the snapped point BEFORE changes
                        const neigh = inc.get(p);
                        const deg = neigh ? neigh.size : 0;

                        // Only eligible for collapse if exactly two incident edges
                        if (deg === 2 && A && B) {
                            // neighbors must be exactly {A,B}
                            const hasA = neigh.has(A);
                            const hasB = neigh.has(B);

                            if (hasA && hasB) {
                                // collapse: remove point and its two segments (A-P and P-B)
                                collapsePoint.add(p);
                                removeSegKey.add(eKey(p, A));
                                removeSegKey.add(eKey(p, B));
                                continue;
                            }
                        }

                        // otherwise: schedule a split on the target segment
                        let arr = splitByTargetSeg.get(hit.segIndex);
                        if (!arr)
                            splitByTargetSeg.set(hit.segIndex, (arr = []));
                        arr.push({ p, t });
                    }

                    // Build new segment list:
                    // - remove A-P and P-B if collapsing
                    // - split target segments where needed
                    const newSegs = [];
                    let splitCount = 0;
                    let collapsedPoints = collapsePoint.size;

                    for (let i = 0; i < segs.length; i++) {
                        const s = segs[i];
                        if (!s || !s.a || !s.b || s.a === s.b) continue;

                        // Remove segments attached to collapsed points
                        if (removeSegKey.has(eKey(s.a, s.b))) continue;

                        const splitPts = splitByTargetSeg.get(i);
                        if (!splitPts || !splitPts.length) {
                            newSegs.push(s);
                            continue;
                        }

                        // Sort split points along segment and dedup
                        const uniq = splitPts
                            .filter(
                                (x) => x && x.p && x.p !== s.a && x.p !== s.b
                            )
                            .sort((u, v) => u.t - v.t);

                        const chainPts = [];
                        for (let j = 0; j < uniq.length; j++) {
                            const cur = uniq[j];
                            const last = chainPts[chainPts.length - 1];
                            if (last && last === cur.p) continue;
                            chainPts.push(cur.p);
                        }

                        if (!chainPts.length) {
                            newSegs.push(s);
                            continue;
                        }

                        // Replace s (A-B) with A->p1->...->B
                        const chain = [s.a, ...chainPts, s.b];
                        for (let j = 0; j < chain.length - 1; j++) {
                            const a = chain[j];
                            const b = chain[j + 1];
                            if (!a || !b || a === b) continue;

                            const axM =
                                a.__xM !== undefined ? a.__xM : a.x * mpp;
                            const ayM =
                                a.__yM !== undefined ? a.__yM : a.y * mpp;
                            const bxM =
                                b.__xM !== undefined ? b.__xM : b.x * mpp;
                            const byM =
                                b.__yM !== undefined ? b.__yM : b.y * mpp;

                            newSegs.push({
                                a,
                                b,
                                axM,
                                ayM,
                                bxM,
                                byM,
                                minX: Math.min(axM, bxM),
                                maxX: Math.max(axM, bxM),
                                minY: Math.min(ayM, byM),
                                maxY: Math.max(ayM, byM),
                            });
                            splitCount++;
                        }
                    }

                    return { newSegs, splitCount, collapsedPoints };
                }

                const res = collapseOrSplitSnaps(segs, snapHits, mpp);
                if (res.splitCount || res.collapsedPoints) {
                    segs.length = 0;
                    segs.push(...res.newSegs);

                    // If we collapsed points, remove them from geo.points (autoFacet only)
                    if (res.collapsedPoints) {
                        const toKill = new Set();
                        for (const [p, hit] of snapHits.entries()) {
                            // collapseOrSplitSnaps computed collapse based on current incidence;
                            // recompute cheaply: any point that now has no incident segments gets removed.
                            // We'll do a robust pass below using incidence after rebuild.
                            // (placeholder; actual kill set computed below)
                        }

                        // Recompute incidence after seg update and delete orphan snapped points
                        const inc2 = new Map();
                        const addN2 = (p, q) => {
                            let s = inc2.get(p);
                            if (!s) inc2.set(p, (s = new Set()));
                            s.add(q);
                        };
                        for (let i = 0; i < segs.length; i++) {
                            const s = segs[i];
                            if (!s || !s.a || !s.b || s.a === s.b) continue;
                            addN2(s.a, s.b);
                            addN2(s.b, s.a);
                        }

                        for (const [p] of snapHits.entries()) {
                            if (!p || !p.__autoFacet) continue;
                            const deg = inc2.get(p)?.size || 0;
                            if (deg === 0) toKill.add(p);
                        }

                        if (toKill.size) {
                            geo.points = geo.points.filter(
                                (p) => !toKill.has(p)
                            );
                        }
                    }
                }

                // Rebuild published connections to match segs (prevents stacked lines)
                if (addConns) {
                    const pidMap = new WeakMap();
                    let pidNext = 1;
                    const pid = (p) => {
                        if (!p) return 0;
                        let id = pidMap.get(p);
                        if (!id) pidMap.set(p, (id = pidNext++));
                        return id;
                    };
                    const connKey = (a, b) => {
                        const ia = pid(a),
                            ib = pid(b);
                        return ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
                    };

                    const seen = new Set();
                    const out = [];
                    for (let i = 0; i < segs.length; i++) {
                        const s = segs[i];
                        if (!s || !s.a || !s.b || s.a === s.b) continue;
                        const k = connKey(s.a, s.b);
                        if (seen.has(k)) continue;
                        seen.add(k);
                        out.push({ start: s.a, end: s.b, __autoFacet: true });
                    }
                    geo.connections = out;
                }

                // if nothing snapped this pass, stop early
                if (!localSnapped) break;
            }
        }

        // cleanup weld caches on points
        for (let i = 0; i < geo.points.length; i++) {
            const p = geo.points[i];
            if (p && p.__autoFacet) {
                delete p.__xM;
                delete p.__yM;
            }
        }

        pipeline.generatedPointCount = ptCount;
        pipeline.generatedFaceCount = faceCount;

        console.log(
            `Published faces: ${faceCount}, unique points: ${ptCount}` +
                (canWeld
                    ? ` (3D merge ON, r=${mergeR}m, mpp=${mpp.toFixed(4)})`
                    : ` (3D merge OFF)`) +
                (canSnap ? `, snapped→line: ${snappedCount} (r=${snapR}m)` : ``)
        );

        if (typeof renderFinalPass === "function") {
            try {
                renderFinalPass(false);
            } catch (e) {
                console.warn("renderFinalPass failed:", e);
            }
        }

        pipelineRenderStage(pipeline, 6);

        console.log(`PASS 6 done in ${(nowMs() - t0).toFixed(1)}ms`);
        console.groupEnd();
    }

    /* =========================
    PASS 7 — GAP FACE ABSORB (post-pass6)
    - Detect “gap faces” (inside roof mask, but containing NO facet center)
    - For each gap face:
        pick adjacent face with max shared border length (shared edges)
        remove the shared edge connections so the space merges into that face
        remove the gap face from manualFaces (optional, but avoids rendering it)
    ========================= */

    function pass7_absorbGapFaces(pipeline) {
        console.groupCollapsed(
            "%c[RoofFaces] PASS 7/7 — absorb gap loops into neighbors (graph face-walk)",
            "color:#ffd166;font-weight:bold;"
        );
        const t0 = nowMs();

        ensureActiveGeometry();
        const geo = activeGeometry;

        const conns = Array.isArray(geo.connections) ? geo.connections : [];
        if (!conns.length) {
            console.warn("[PASS 7] No connections; skipping.");
            console.groupEnd();
            return;
        }

        // Centers define "real facets" (what you WANT to keep)
        const centers = (pipeline.state?.planes || [])
            .map((p) => p?.center)
            .filter(Boolean);

        // ---------- helpers ----------
        const pidMap = new WeakMap();
        let pidNext = 1;
        const pid = (p) => {
            if (!p) return 0;
            let id = pidMap.get(p);
            if (!id) pidMap.set(p, (id = pidNext++));
            return id;
        };

        const edgeKey = (a, b) => {
            const ia = pid(a),
                ib = pid(b);
            return ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
        };

        const segLenPx = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

        const polygonAreaSigned = (poly) => {
            if (!poly || poly.length < 3) return 0;
            let s = 0;
            for (let i = 0; i < poly.length; i++) {
                const p = poly[i];
                const q = poly[(i + 1) % poly.length];
                s += p.x * q.y - q.x * p.y;
            }
            return 0.5 * s;
        };

        const pointInPoly = (x, y, poly) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const xi = poly[i].x,
                    yi = poly[i].y;
                const xj = poly[j].x,
                    yj = poly[j].y;
                const intersect =
                    yi > y !== yj > y &&
                    x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
                if (intersect) inside = !inside;
            }
            return inside;
        };

        // ---------- 1) build half-edges ----------
        // Each undirected connection produces two directed half-edges (u->v, v->u).
        // We'll do a standard face-walk: next( e: u->v ) = "the edge leaving v that is immediately
        // clockwise from (v->u)" (i.e., keep the face on your right).
        const out = new Map(); // point -> array of halfedge indices
        const half = []; // { u, v, ang, twin, next, used }
        const byUV = new Map(); // "uId|vId" -> halfedge index (directed)

        const addOut = (p, hei) => {
            let arr = out.get(p);
            if (!arr) out.set(p, (arr = []));
            arr.push(hei);
        };

        for (let i = 0; i < conns.length; i++) {
            const c = conns[i];
            if (!c || !c.start || !c.end) continue;
            const a = c.start,
                b = c.end;
            if (a === b) continue;

            // de-dupe exact duplicate connections (same endpoints)
            // keep first instance only; the rest don't help face-walk and cause junk loops
            const k = edgeKey(a, b);
            // NOTE: we still allow same edge used by multiple faces (that’s normal), but we don’t want duplicates in conns list.
            // We'll mark dupes by seeing if we've already inserted both directions.
            const ka = `${pid(a)}|${pid(b)}`;
            const kb = `${pid(b)}|${pid(a)}`;
            if (byUV.has(ka) || byUV.has(kb)) {
                // already have this undirected edge (or its reverse) inserted
                // ignore duplicates here; PASS 7 will still remove shared boundaries by edgeKey later
                continue;
            }

            const ia = pid(a),
                ib = pid(b);
            const angAB = Math.atan2(b.y - a.y, b.x - a.x);
            const angBA = Math.atan2(a.y - b.y, a.x - b.x);

            const e0 = half.length;
            half.push({
                u: a,
                v: b,
                ang: angAB,
                twin: e0 + 1,
                next: -1,
                used: false,
            });
            half.push({
                u: b,
                v: a,
                ang: angBA,
                twin: e0 + 0,
                next: -1,
                used: false,
            });

            byUV.set(`${ia}|${ib}`, e0);
            byUV.set(`${ib}|${ia}`, e0 + 1);

            addOut(a, e0);
            addOut(b, e0 + 1);
        }

        if (half.length < 6) {
            console.warn("[PASS 7] Too few edges to form loops.");
            console.groupEnd();
            return;
        }

        // ---------- 2) sort outgoing half-edges CCW by angle ----------
        for (const [p, arr] of out.entries()) {
            arr.sort((i, j) => half[i].ang - half[j].ang);
        }

        // ---------- 3) compute next pointers (right-hand face walk) ----------
        // For edge e: u->v, look at twin: v->u.
        // At vertex v, find twin in v's outgoing list, then choose the edge just BEFORE it in CCW order (i.e. clockwise).
        for (let ei = 0; ei < half.length; ei++) {
            const e = half[ei];
            const v = e.v;
            const arr = out.get(v);
            if (!arr || arr.length === 0) continue;

            const twinIdx = e.twin;
            let pos = -1;
            for (let k = 0; k < arr.length; k++) {
                if (arr[k] === twinIdx) {
                    pos = k;
                    break;
                }
            }
            if (pos < 0) continue;

            const nextPos = (pos - 1 + arr.length) % arr.length; // clockwise neighbor
            e.next = arr[nextPos];
        }

        // ---------- 4) walk all faces (loops) ----------
        const loops = []; // each loop is array of points (the vertices), in order
        const loopEdges = []; // each loop is array of undirected edgeKeys along boundary (aligned with vertices)
        const GUARD = 2_000_000;

        for (let ei = 0; ei < half.length; ei++) {
            if (half[ei].used) continue;

            // follow next pointers until returns
            let cur = ei;
            const poly = [];
            const ekeys = [];

            let guard = 0;
            while (guard++ < GUARD) {
                const he = half[cur];
                if (!he || he.next < 0) break;

                he.used = true;

                poly.push(he.u); // vertex at start of halfedge
                ekeys.push(edgeKey(he.u, he.v)); // boundary segment

                cur = he.next;
                if (cur === ei) break;
            }

            if (poly.length >= 3) {
                // close check: last edge should end where first begins (face-walk guarantees in good graphs)
                loops.push(poly);
                loopEdges.push(ekeys);
            }
        }

        if (!loops.length) {
            console.log("[PASS 7] No loops extracted.");
            console.groupEnd();
            return;
        }

        // ---------- 5) drop the "outside" face (largest |area|) ----------
        let outsideIdx = -1;
        let outsideA = -1;
        const areas = loops.map((poly) => Math.abs(polygonAreaSigned(poly)));

        for (let i = 0; i < areas.length; i++) {
            if (areas[i] > outsideA) {
                outsideA = areas[i];
                outsideIdx = i;
            }
        }

        // keep all but outside, and ignore tiny junk loops
        const minArea = 10; // px^2 threshold; tune if needed
        const faceLoops = [];
        const faceEdges = [];
        const faceAreas = [];

        for (let i = 0; i < loops.length; i++) {
            if (i === outsideIdx) continue;
            if (areas[i] < minArea) continue;
            faceLoops.push(loops[i]);
            faceEdges.push(loopEdges[i]);
            faceAreas.push(areas[i]);
        }

        if (!faceLoops.length) {
            console.log("[PASS 7] Only outside/tiny loops found.");
            console.groupEnd();
            return;
        }

        // ---------- 6) classify loops: real vs gap ----------
        const hasCenter = new Array(faceLoops.length).fill(false);
        for (let fi = 0; fi < faceLoops.length; fi++) {
            const poly = faceLoops[fi];
            for (let ci = 0; ci < centers.length; ci++) {
                const c = centers[ci];
                if (pointInPoly(c.x, c.y, poly)) {
                    hasCenter[fi] = true;
                    break;
                }
            }
        }

        const realFaces = [];
        const gapFaces = [];
        for (let i = 0; i < hasCenter.length; i++) {
            if (hasCenter[i]) realFaces.push(i);
            else gapFaces.push(i);
        }

        if (!gapFaces.length) {
            console.log("[PASS 7] No gap loops detected.");
            console.log(
                `[PASS 7] loops: ${faceLoops.length} (real=${realFaces.length}, gap=0)`
            );
            console.groupEnd();
            return;
        }

        // ---------- 7) build shared-border lengths between loops ----------
        // edge -> { lenPx, faces: [fi...] }
        const edgeTo = new Map();
        for (let fi = 0; fi < faceLoops.length; fi++) {
            const poly = faceLoops[fi];
            for (let k = 0; k < poly.length; k++) {
                const a = poly[k];
                const b = poly[(k + 1) % poly.length];
                const ek = edgeKey(a, b);

                let rec = edgeTo.get(ek);
                if (!rec) {
                    rec = { lenPx: segLenPx(a, b), faces: [] };
                    edgeTo.set(ek, rec);
                }
                rec.faces.push(fi);
            }
        }

        // Build connection index by undirected edge so we can delete shared walls
        const connIdxByEdge = new Map();
        for (let i = 0; i < conns.length; i++) {
            const c = conns[i];
            if (!c || !c.start || !c.end) continue;
            connIdxByEdge.set(edgeKey(c.start, c.end), i);
        }

        // ---------- 8) absorb each gap loop into best adjacent REAL loop ----------
        const removeConnIdx = new Set();

        for (let gi = 0; gi < gapFaces.length; gi++) {
            const gf = gapFaces[gi];

            const shared = new Map(); // neighFi -> sharedLenPx
            const poly = faceLoops[gf];

            for (let k = 0; k < poly.length; k++) {
                const a = poly[k];
                const b = poly[(k + 1) % poly.length];
                const ek = edgeKey(a, b);
                const rec = edgeTo.get(ek);
                if (!rec || !rec.faces || rec.faces.length < 2) continue;

                for (let t = 0; t < rec.faces.length; t++) {
                    const of = rec.faces[t];
                    if (of === gf) continue;
                    if (!hasCenter[of]) continue; // ONLY absorb into a real face
                    shared.set(of, (shared.get(of) || 0) + rec.lenPx);
                }
            }

            if (!shared.size) continue;

            let bestFi = -1;
            let bestLen = -1;
            for (const [of, len] of shared.entries()) {
                if (len > bestLen) {
                    bestLen = len;
                    bestFi = of;
                }
            }
            if (bestFi < 0) continue;

            // remove all boundary edges between gf and bestFi
            for (let k = 0; k < poly.length; k++) {
                const a = poly[k];
                const b = poly[(k + 1) % poly.length];
                const ek = edgeKey(a, b);
                const rec = edgeTo.get(ek);
                if (!rec || !rec.faces) continue;

                let hasG = false,
                    hasB = false;
                for (let t = 0; t < rec.faces.length; t++) {
                    if (rec.faces[t] === gf) hasG = true;
                    if (rec.faces[t] === bestFi) hasB = true;
                }
                if (!hasG || !hasB) continue;

                const ci = connIdxByEdge.get(ek);
                if (ci !== undefined) removeConnIdx.add(ci);
            }
        }

        if (!removeConnIdx.size) {
            console.log(
                "[PASS 7] Gap loops found, but no shared boundaries to remove."
            );
            console.log(
                `[PASS 7] loops: ${faceLoops.length} (real=${realFaces.length}, gap=${gapFaces.length})`
            );
            console.groupEnd();
            return;
        }

        geo.connections = conns.filter((_, i) => !removeConnIdx.has(i));

        console.log(
            `[PASS 7] loops: ${faceLoops.length} (real=${realFaces.length}, gap=${gapFaces.length})`
        );
        console.log(
            "[PASS 7] removed shared boundary connections:",
            removeConnIdx.size
        );

        // re-render (whatever your viewer does with connections)
        if (typeof renderFinalPass === "function") {
            try {
                renderFinalPass(false);
            } catch (e) {
                console.warn("renderFinalPass failed:", e);
            }
        }
        if (typeof renderGeometry2D === "function") renderGeometry2D();
        if (typeof renderGeometry3D === "function") renderGeometry3D();
        if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();

        const clean = cleanupGraphAfterPass7(geo, pipeline.opts);
        console.log("[PASS 7] cleanup:", clean);
        console.groupEnd();
    }

    function cleanupGraphAfterPass7(geo, opts = {}) {
        const tolDeg = Math.max(0, opts.pass7CleanupCollinearDeg ?? 3.0);
        const maxIters = Math.max(1, (opts.pass7CleanupMaxIters ?? 6) | 0);

        const conns = Array.isArray(geo.connections) ? geo.connections : [];
        const pts = Array.isArray(geo.points) ? geo.points : [];

        if (!conns.length) return { removedConn: 0, removedPts: 0, collapsed: 0, deduped: 0 };

        // stable point ids for connection keys
        const pidMap = new WeakMap();
        let pidNext = 1;
        const pid = (p) => {
            if (!p) return 0;
            let id = pidMap.get(p);
            if (!id) pidMap.set(p, (id = pidNext++));
            return id;
        };
        const eKey = (a, b) => {
            const ia = pid(a), ib = pid(b);
            return ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
        };

        const dedupeConnections = () => {
            const seen = new Set();
            const out = [];
            let deduped = 0;

            for (let i = 0; i < geo.connections.length; i++) {
            const c = geo.connections[i];
            if (!c || !c.start || !c.end || c.start === c.end) { deduped++; continue; }
            const k = eKey(c.start, c.end);
            if (seen.has(k)) { deduped++; continue; }
            seen.add(k);
            out.push(c);
            }
            geo.connections = out;
            return deduped;
        };

        const buildAdj = () => {
            const adj = new Map(); // point -> Set(neigh)
            const add = (a, b) => {
            let s = adj.get(a);
            if (!s) adj.set(a, (s = new Set()));
            s.add(b);
            };
            for (const c of geo.connections) {
            if (!c || !c.start || !c.end || c.start === c.end) continue;
            add(c.start, c.end);
            add(c.end, c.start);
            }
            return adj;
        };

        const cosTol = Math.cos((tolDeg * Math.PI) / 180);

        let removedConnTotal = 0;
        let removedPtsTotal = 0;
        let collapsedTotal = 0;
        let dedupedTotal = 0;

        // Do a few passes because collapsing creates new opportunities
        for (let it = 0; it < maxIters; it++) {
            dedupedTotal += dedupeConnections();

            const adj = buildAdj();

            // ---------- (A) remove floater points (degree 0) ----------
            // Do this early; degree is based on current connections
            {
            const used = new Set();
            for (const [p, neigh] of adj.entries()) {
                if (neigh && neigh.size) used.add(p);
            }

            const before = geo.points.length;
            geo.points = geo.points.filter((p) => !p || used.has(p) || (adj.get(p)?.size ?? 0) > 0);
            removedPtsTotal += Math.max(0, before - geo.points.length);
            }

            // rebuild adj after floater removal (connections still reference valid points though)
            // (not strictly required, but keeps degree queries consistent)
            const adj2 = buildAdj();

            // ---------- (B) collapse redundant degree-2 collinear points ----------
            // We only collapse points with exactly 2 neighbors A,B and angle ~ 180°
            const toRemovePoint = new Set();
            const toRemoveEdge = new Set(); // undirected edge keys to remove
            const toAddEdge = new Map();    // key -> {a,b}

            for (const [p, neigh] of adj2.entries()) {
            if (!p || !neigh || neigh.size !== 2) continue;

            const itn = neigh.values();
            const a = itn.next().value;
            const b = itn.next().value;
            if (!a || !b || a === b) continue;

            // vectors PA and PB
            const v1x = a.x - p.x, v1y = a.y - p.y;
            const v2x = b.x - p.x, v2y = b.y - p.y;

            const n1 = Math.hypot(v1x, v1y);
            const n2 = Math.hypot(v2x, v2y);
            if (!(n1 > 1e-9 && n2 > 1e-9)) continue;

            // For straight line through P, vectors should be opposite => dot ~= -1
            const dot = (v1x * v2x + v1y * v2y) / (n1 * n2);

            if (dot <= -cosTol) {
                // collapse P
                toRemovePoint.add(p);
                toRemoveEdge.add(eKey(p, a));
                toRemoveEdge.add(eKey(p, b));

                const kab = eKey(a, b);
                if (!toAddEdge.has(kab)) toAddEdge.set(kab, { a, b });
            }
            }

            if (!toRemovePoint.size && !toRemoveEdge.size && !toAddEdge.size) {
            // Stable
            break;
            }

            // Apply edge removals
            if (toRemoveEdge.size) {
            const before = geo.connections.length;
            geo.connections = geo.connections.filter((c) => {
                if (!c || !c.start || !c.end) return false;
                return !toRemoveEdge.has(eKey(c.start, c.end));
            });
            removedConnTotal += Math.max(0, before - geo.connections.length);
            }

            // Add new edges A-B (if not present)
            if (toAddEdge.size) {
            const existing = new Set();
            for (const c of geo.connections) {
                if (!c || !c.start || !c.end) continue;
                existing.add(eKey(c.start, c.end));
            }

            for (const [k, ab] of toAddEdge.entries()) {
                if (!ab || !ab.a || !ab.b || ab.a === ab.b) continue;
                if (existing.has(k)) continue;
                geo.connections.push({ start: ab.a, end: ab.b, __autoFacet: true });
                existing.add(k);
            }
            }

            // Remove points (they should now be unused)
            if (toRemovePoint.size) {
            const before = geo.points.length;
            geo.points = geo.points.filter((p) => !toRemovePoint.has(p));
            removedPtsTotal += Math.max(0, before - geo.points.length);
            collapsedTotal += toRemovePoint.size;
            }
        }

        // final dedupe
        dedupedTotal += dedupeConnections();

        return {
            removedConn: removedConnTotal,
            removedPts: removedPtsTotal,
            collapsed: collapsedTotal,
            deduped: dedupedTotal,
        };
    }


    /* =========================
    PASS 8 — STRAIGHTEN (45° snap optimizer)
    - Nudges published points (activeGeometry.points) to make corner angles closer to multiples of 45°
    - Hard constraints:
    - never leave roofMaskData
    - never move a point more than pass8MaxMoveRadiusPx from its original position
    - Runs iterative hill-climb epochs + optional random wiggle epochs (accept-if-better)
    - Does NOT touch faces/polys; only moves point XY (Z unchanged by default)
    ========================= */



/*** 4) add PASS 8 implementation somewhere after PASS 7 ***/
function pass8_straighten(pipeline) {
  console.groupCollapsed(
    "%c[RoofFaces] PASS 8/8 — straighten (45°) + outer-short corners → 90° (masked + bounded)",
    "color:#ffd166;font-weight:bold;"
  );
  const t0 = nowMs();

  const opts = pipeline?.opts || {};
  if (opts.pass8Enabled === false) {
    console.log("[PASS 8] disabled.");
    console.groupEnd();
    return;
  }

  ensureActiveGeometry();
  const geo = activeGeometry;

  const w = typeof imageWidth !== "undefined" ? imageWidth : 0;
  const h = typeof imageHeight !== "undefined" ? imageHeight : 0;

  if (!w || !h) {
    console.warn("[PASS 8] Missing image dims.");
    console.groupEnd();
    return;
  }

  if (
    typeof roofMaskData === "undefined" ||
    !roofMaskData ||
    roofMaskData.length !== w * h
  ) {
    console.warn(
      "[PASS 8] roofMaskData missing/mismatch; refusing to move points."
    );
    console.groupEnd();
    return;
  }

  const points = Array.isArray(geo.points) ? geo.points : [];
  const conns = Array.isArray(geo.connections) ? geo.connections : [];
  if (!points.length || !conns.length) {
    console.warn("[PASS 8] No points/connections.");
    console.groupEnd();
    return;
  }

  // --------- knobs ---------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rad2deg = (r) => (r * 180) / Math.PI;

  const tolDeg = Math.max(0.5, opts.pass8AngleSnapDegTol ?? 10.0);
  const epochs = Math.max(0, (opts.pass8Epochs ?? 140) | 0);
  const stepPx = Math.max(0.15, opts.pass8StepPx ?? 0.9);
  const maxR = Math.max(0.0, opts.pass8MaxMoveRadiusPx ?? 10.0);
  const maskPad = Math.max(0, opts.pass8MaskPaddingPx ?? 0);

  const randomEpochs = Math.max(0, (opts.pass8RandomEpochs ?? 60) | 0);
  const wigAmp = Math.max(0.0, opts.pass8RandomWiggleAmpPx ?? 1.6);
  const randTries = Math.max(1, (opts.pass8RandomTriesPerPoint ?? 1) | 0);

  const useAutoOnly = opts.pass8UseAutoFacetOnly !== false;
  const skipDegLT2 = opts.pass8SkipDegreeLT2 !== false;
  const preserveZ = opts.pass8PreserveZ !== false;

  // NEW (outer-short corner -> 90°)
  const outerShortMinLenPx = Math.max(0, opts.pass8OuterShortMinLenPx ?? 20);
  const outerProbe = Math.max(1, (opts.pass8OuterEdgeProbePx ?? 1) | 0);

  const verbose = !!opts.pass8Verbose;

  // --------- mask test ---------
  const insideMask = (x, y) => {
    const ix = clamp(Math.round(x), 0, w - 1);
    const iy = clamp(Math.round(y), 0, h - 1);

    if (maskPad > 0) {
      const r = maskPad | 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = ix + dx,
            yy = iy + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false;
          if (!(roofMaskData[yy * w + xx] > 0)) return false;
        }
      }
      return true;
    }
    return roofMaskData[iy * w + ix] > 0;
  };

  // "outer edge" heuristic: midpoint is inside, but within probe neighborhood exists an outside pixel
  function isOuterRoofEdge(p, q) {
    if (!p || !q) return false;

    const mx = (p.x + q.x) * 0.5;
    const my = (p.y + q.y) * 0.5;

    const ix = clamp(Math.round(mx), 0, w - 1);
    const iy = clamp(Math.round(my), 0, h - 1);

    if (!(roofMaskData[iy * w + ix] > 0)) return false;

    for (let dy = -outerProbe; dy <= outerProbe; dy++) {
      for (let dx = -outerProbe; dx <= outerProbe; dx++) {
        const xx = ix + dx,
          yy = iy + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return true; // image edge counts as outside
        if (!(roofMaskData[yy * w + xx] > 0)) return true;
      }
    }
    return false;
  }

  // backup original positions (so we can cap radius + allow reset)
  if (!pipeline.state) pipeline.state = {};
  if (!pipeline.state.__pass8Backup) pipeline.state.__pass8Backup = new WeakMap();

  const backupMap = pipeline.state.__pass8Backup;

  for (const p of points) {
    if (!p) continue;
    if (useAutoOnly && !p.__autoFacet) continue;
    if (!backupMap.has(p)) {
      backupMap.set(p, { x: p.x, y: p.y, z: p.z });
      p.__p8ox = p.x;
      p.__p8oy = p.y;
    } else {
      // ensure we have original anchors even if re-running
      if (!isFinite(p.__p8ox)) p.__p8ox = backupMap.get(p).x;
      if (!isFinite(p.__p8oy)) p.__p8oy = backupMap.get(p).y;
    }
  }

  // adjacency
  const adj = new Map(); // point -> Set(neigh)
  const addN = (a, b) => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const c of conns) {
    if (!c || !c.start || !c.end || c.start === c.end) continue;
    addN(c.start, c.end);
    addN(c.end, c.start);
  }

  const degOf = (p) => adj.get(p)?.size || 0;

  // vertex straightness score: sum over consecutive incident edges around vertex
  function vertexScore(p) {
    const neigh = adj.get(p);
    if (!neigh || neigh.size < 2) return 0;

    const arr = Array.from(neigh);

    // sort neighbors around p by angle
    arr.sort((a, b) => {
      const aa = Math.atan2(a.y - p.y, a.x - p.x);
      const bb = Math.atan2(b.y - p.y, b.x - p.x);
      return aa - bb;
    });

    let s = 0;
    const n = arr.length;

    for (let i = 0; i < n; i++) {
      const a = arr[i];
      const b = arr[(i + 1) % n];

      const angA = Math.atan2(a.y - p.y, a.x - p.x);
      const angB = Math.atan2(b.y - p.y, b.x - p.x);

      let d = rad2deg(angB - angA);
      while (d < 0) d += 360;
      while (d >= 360) d -= 360;

      // fold to [0..180]
      if (d > 180) d = 360 - d;

      // NEW: if both edges are outer roof edges AND one is short -> snapBase=90 else 45
      const lenPA = Math.hypot(a.x - p.x, a.y - p.y);
      const lenPB = Math.hypot(b.x - p.x, b.y - p.y);

      const bothOuter = isOuterRoofEdge(p, a) && isOuterRoofEdge(p, b);
      const hasShort = Math.min(lenPA, lenPB) < outerShortMinLenPx;
      const snapBase = bothOuter && hasShort ? 90 : 45;

      // nearest multiple of snapBase in [0..180]
      const m = snapBase * Math.round(d / snapBase);
      const delta = Math.abs(d - m);

      // smooth score (1 at perfect, ~0 beyond tol)
      const t = delta / tolDeg;
      const sc = t >= 1 ? 0 : 1 - t * t;

      s += sc;
    }

    return s;
  }

  // local score around p + neighbors + 2-hop neighbors
  function localScoreAffected(p) {
    const set = new Set();
    set.add(p);
    const neigh = adj.get(p);
    if (neigh) {
      for (const q of neigh) {
        set.add(q);
        const neigh2 = adj.get(q);
        if (neigh2) for (const r of neigh2) set.add(r);
      }
    }
    let sum = 0;
    for (const v of set) sum += vertexScore(v);
    return sum;
  }

  function tryMovePoint(p, nx, ny) {
    // bound from original
    const ox = p.__p8ox ?? p.x;
    const oy = p.__p8oy ?? p.y;
    if (Math.hypot(nx - ox, ny - oy) > maxR) return false;

    // must stay inside mask
    if (!insideMask(nx, ny)) return false;

    p.x = nx;
    p.y = ny;
    if (preserveZ) {
      // keep Z as-is
    }
    return true;
  }

  // candidate points (stable)
  const candPts = points
    .filter((p) => p && (!useAutoOnly || p.__autoFacet))
    .filter((p) => !skipDegLT2 || degOf(p) >= 2);

  if (!candPts.length) {
    console.log("[PASS 8] No eligible points.");
    console.groupEnd();
    return;
  }

  // directional candidates
  const dirs = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  const scoreTotal = () => {
    let s = 0;
    for (const p of candPts) s += vertexScore(p);
    return s;
  };

  let startTotal = scoreTotal();
  let bestTotal = startTotal;

  if (verbose) {
    console.log("[PASS 8] start", {
      score: startTotal.toFixed(3),
      pts: candPts.length,
      tolDeg,
      epochs,
      stepPx,
      maxR,
      randomEpochs,
      wigAmp,
      randTries,
      outerShortMinLenPx,
      outerProbe,
    });
  }

  // ---- (A) hill-climb epochs ----
  for (let ep = 0; ep < epochs; ep++) {
    let improvedThisEpoch = 0;

    for (let i = 0; i < candPts.length; i++) {
      const p = candPts[i];

      const baseLocal = localScoreAffected(p);

      const px0 = p.x,
        py0 = p.y;

      let bestLocal = baseLocal;
      let bestX = px0,
        bestY = py0;

      for (let di = 0; di < dirs.length; di++) {
        const dx = dirs[di][0] * stepPx;
        const dy = dirs[di][1] * stepPx;

        const nx = px0 + dx;
        const ny = py0 + dy;

        // quick rejects: radius + mask
        const ox = p.__p8ox ?? px0;
        const oy = p.__p8oy ?? py0;
        if (Math.hypot(nx - ox, ny - oy) > maxR) continue;
        if (!insideMask(nx, ny)) continue;

        // temporary move
        p.x = nx;
        p.y = ny;
        const ls = localScoreAffected(p);

        if (ls > bestLocal + 1e-9) {
          bestLocal = ls;
          bestX = nx;
          bestY = ny;
        }

        // revert
        p.x = px0;
        p.y = py0;
      }

      if (bestX !== px0 || bestY !== py0) {
        if (tryMovePoint(p, bestX, bestY)) improvedThisEpoch++;
      }
    }

    const nowTotal = scoreTotal();
    if (nowTotal > bestTotal + 1e-9) bestTotal = nowTotal;

    // stop if stuck
    if (!improvedThisEpoch) break;
  }

  // ---- (B) random wiggle epochs (accept-if-better) ----
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  for (let ep = 0; ep < randomEpochs; ep++) {
    let accepted = 0;

    for (let i = 0; i < candPts.length; i++) {
      const p = candPts[i];

      const px0 = p.x,
        py0 = p.y;
      const baseLocal = localScoreAffected(p);

      let bestLocal = baseLocal;
      let bestX = px0,
        bestY = py0;

      for (let t = 0; t < randTries; t++) {
        const nx = px0 + rand(-wigAmp, wigAmp);
        const ny = py0 + rand(-wigAmp, wigAmp);

        const ox = p.__p8ox ?? px0;
        const oy = p.__p8oy ?? py0;
        if (Math.hypot(nx - ox, ny - oy) > maxR) continue;
        if (!insideMask(nx, ny)) continue;

        p.x = nx;
        p.y = ny;
        const ls = localScoreAffected(p);

        if (ls > bestLocal + 1e-9) {
          bestLocal = ls;
          bestX = nx;
          bestY = ny;
        }

        p.x = px0;
        p.y = py0;
      }

      if (bestX !== px0 || bestY !== py0) {
        if (tryMovePoint(p, bestX, bestY)) accepted++;
      }
    }

    const nowTotal = scoreTotal();
    if (nowTotal > bestTotal + 1e-9) bestTotal = nowTotal;

    if (!accepted) break;
  }

  const finalTotal = scoreTotal();

  console.log("[PASS 8] done:", {
    scoreStart: startTotal.toFixed(3),
    scoreBest: bestTotal.toFixed(3),
    scoreFinal: finalTotal.toFixed(3),
    tolDeg,
    epochs,
    randomEpochs,
    maxMoveRadiusPx: maxR,
    stepPx,
    wiggleAmpPx: wigAmp,
    outerShortMinLenPx,
    outerProbe,
  });

  if (typeof renderFinalPass === "function") {
    try {
      renderFinalPass(false);
    } catch (e) {
      console.warn("renderFinalPass failed:", e);
    }
  }
  if (typeof renderGeometry2D === "function") renderGeometry2D();
  if (typeof renderGeometry3D === "function") renderGeometry3D();
  if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();

  console.log(`PASS 8 done in ${(nowMs() - t0).toFixed(1)}ms`);
  console.groupEnd();
}


/*** 5) OPTIONAL: expose helpers to revert pass 8 (handy while tuning) ***/
window.roofFacesPass8ResetPoints = function () {
  const pipeline = window.__ROOF_FACET_FACE_PIPELINE__;
  if (!pipeline?.state?.__pass8Backup) {
    console.warn("[PASS 8] no backup found");
    return false;
  }
  ensureActiveGeometry();
  const geo = activeGeometry;

  let n = 0;
  for (const p of geo.points || []) {
    const b = pipeline.state.__pass8Backup.get(p);
    if (!b) continue;
    p.x = b.x; p.y = b.y; p.z = b.z;
    n++;
  }
  console.log("[PASS 8] restored points:", n);

  if (typeof renderFinalPass === "function") {
    try { renderFinalPass(false); } catch (e) {}
  }
  if (typeof renderGeometry2D === "function") renderGeometry2D();
  if (typeof renderGeometry3D === "function") renderGeometry3D();
  if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();

  return true;
};



    /* =========================
     PASS ENGINE / SNAPSHOTS
     ========================= */

    function makePipeline() {
        return {
            pass: 0,
            opts: makeDefaultOptions(),
            state: {
                centers: [],
                // NEW: centers you add manually before pass 1
                manualCenters: [],

                planes: [],
                edgeMasks: [],
                edgePolys: [],
                polys: [],
            },
            cache: { circleOffsets: null, globalSamples: null },
            snapshots: [],
            generatedFaceCount: 0,
            generatedPointCount: 0,
        };
    }

    function getPipeline() {
        if (!window[PIPE_KEY]) window[PIPE_KEY] = makePipeline();
        return window[PIPE_KEY];
    }

    function snapshot(pipeline, passNum) {
        pipeline.snapshots[passNum] = deepClone({
            pass: passNum,
            opts: pipeline.opts,
            state: pipeline.state,
        });
    }

    function restoreSnapshot(pipeline, passNum) {
        const snap = pipeline.snapshots[passNum];
        if (!snap) return false;

        pipeline.pass = snap.pass;
        pipeline.opts = snap.opts;
        pipeline.state = snap.state;

        removeDebugSVG();
        if (pipeline.state.centers?.length)
            drawDebugCentersSVG(pipeline.state.centers);

        if (passNum >= 2) pipelineRenderStage(pipeline, passNum);

        if (typeof renderGeometry2D === "function") renderGeometry2D();
        return true;
    }

    function runPass(pipeline, passNum) {
        if (passNum === 1) pass1_collectCenters(pipeline);
        else if (passNum === 2) pass2_coarsePlanes(pipeline);
        else if (passNum === 3) pass3_refinePlanes(pipeline);
        else if (passNum === 4) pass4_edgeGrow(pipeline);
        else if (passNum === 5) pass5_intersectionsAndTrim(pipeline);
        else if (passNum === 6) pass6_publishFaces(pipeline);
        else if (passNum === 7) pass7_absorbGapFaces(pipeline);
        else if (passNum === 8) pass8_straighten(pipeline);
        else throw new Error("Unknown pass: " + passNum);

        snapshot(pipeline, passNum);
        pipeline.pass = passNum;
    }

    function ensurePass(pipeline, targetPass) {
        for (let p = 1; p <= targetPass; p++) {
            if (pipeline.snapshots[p]) {
                restoreSnapshot(pipeline, p);
                pipeline.pass = p;
                continue;
            }
            runPass(pipeline, p);
        }
    }

    function status(pipeline) {
        const s = pipeline.state || {};
        console.groupCollapsed(
            "%c[RoofFaces] STATUS",
            "color:#fff;background:#111;padding:2px 6px;border-radius:4px;"
        );
        console.log("Pass:", pipeline.pass, `/ ${MAX_PASS}`);
        console.log("Centers:", s.centers?.length || 0);
        console.log("Planes:", s.planes?.length || 0);
        console.log(
            "EdgePolys:",
            (s.edgePolys?.filter?.((p) => p && p.length >= 3) || []).length
        );
        console.log(
            "Polys:",
            (s.polys?.filter?.((p) => p && p.length >= 3) || []).length
        );
        console.log("Published faces:", pipeline.generatedFaceCount || 0);
        console.log("Published points:", pipeline.generatedPointCount || 0);
        console.log("Options:", pipeline.opts);
        console.log("Next:", "roofFacesNext()");
        console.log("Prev:", "roofFacesPrev()");
        console.groupEnd();
    }

    /* =========================
     PUBLIC CONSOLE API
     ========================= */

    window.roofFacesAddCenter = function (x, y, extra = {}) {
        return addManualCenterAtXY(parseFloat(x), parseFloat(y), extra);
    };

    window.roofFacesClearManualCenters = function () {
        const pipeline = getPipeline();
        pipeline.state.manualCenters = [];
        pipeline.snapshots = [];
        pipeline.pass = 0;
        pipeline.state.centers = [];
        removeDebugSVG();
        clearDebugFaceRenderings();
        if (typeof renderGeometry2D === "function") renderGeometry2D();
        console.log("[RoofFaces] Cleared manual centers.");
        return pipeline;
    };

    window.roofFacesCenterMode = function (on = true) {
        return setCenterPlacementMode(!!on);
    };

    window.roofFacesReset = function (opts = {}) {
        const pipeline = getPipeline();

        ensureActiveGeometry();
        clearPipelineGeneratedFaces(pipeline);

        pipeline.pass = 0;
        pipeline.state = {
            centers: [],
            manualCenters: [], // NEW
            planes: [],
            edgeMasks: [],
            edgePolys: [],
            polys: [],
        };
        pipeline.cache = { circleOffsets: null, globalSamples: null };
        pipeline.snapshots = [];
        pipeline.generatedFaceCount = 0;
        pipeline.generatedPointCount = 0;
        window.__FACET_DEBUG_CENTERS__ = [];

        const base = makeDefaultOptions();
        const merged = { ...base, ...(opts || {}) };

        pipeline.opts = merged;

        logBanner("[RoofFaces] RESET (pass 0)", "#fff", "#673ab7");
        console.log("Run:", "roofFacesNext()");
        console.log("Options:", pipeline.opts);
        publishDebugCentersFor2D(pipeline);

        return pipeline;
    };

    window.roofFacesNext = function () {
        const pipeline = getPipeline();
        const next = pipeline.pass + 1;

        if (next > MAX_PASS) {
            console.warn(`[RoofFaces] Already at pass ${MAX_PASS}.`);
            status(pipeline);
            return pipeline;
        }

        if (pipeline.snapshots[next]) {
            restoreSnapshot(pipeline, next);
            pipeline.pass = next;

            if (next === MAX_PASS) pipelineRenderStage(pipeline, MAX_PASS);

            console.log(`[RoofFaces] Restored cached pass ${next}.`);
            status(pipeline);
            return pipeline;
        }

        runPass(pipeline, next);
        status(pipeline);
        return pipeline;
    };

    window.roofFacesPrev = function () {
        const pipeline = getPipeline();
        const prev = pipeline.pass - 1;

        if (prev < 0) {
            console.warn("[RoofFaces] Already at pass 0.");
            status(pipeline);
            return pipeline;
        }

        if (pipeline.pass === MAX_PASS && prev < MAX_PASS) {
            ensureActiveGeometry();
            clearPipelineGeneratedFaces(pipeline);
        }

        if (prev === 0) {
            pipeline.pass = 0;
            removeDebugSVG();
            clearDebugFaceRenderings();
            if (typeof renderGeometry2D === "function") renderGeometry2D();
            console.log(
                "[RoofFaces] Back to pass 0. Run roofFacesNext() to restart."
            );
            status(pipeline);
            return pipeline;
        }

        if (pipeline.snapshots[prev]) {
            restoreSnapshot(pipeline, prev);
            pipeline.pass = prev;
            console.log(`[RoofFaces] Restored pass ${prev}.`);
        } else {
            console.warn(
                `[RoofFaces] No snapshot for pass ${prev}. Replaying forward.`
            );
            pipeline.pass = 0;
            ensurePass(pipeline, prev);
        }

        status(pipeline);
        return pipeline;
    };

    window.roofFacesGoto = function (n) {
        const pipeline = getPipeline();
        const target = clamp(parseInt(n, 10) || 0, 0, MAX_PASS);

        if (target === pipeline.pass) {
            status(pipeline);
            return pipeline;
        }

        if (pipeline.pass === MAX_PASS && target < MAX_PASS)
            clearPipelineGeneratedFaces(pipeline);

        if (target === 0) {
            pipeline.pass = 0;
            removeDebugSVG();
            clearDebugFaceRenderings();
            if (typeof renderGeometry2D === "function") renderGeometry2D();
            console.log("[RoofFaces] Jumped to pass 0.");
            status(pipeline);
            return pipeline;
        }

        pipeline.pass = 0;
        ensurePass(pipeline, target);

        if (target === MAX_PASS) pipelineRenderStage(pipeline, MAX_PASS);

        console.log(`[RoofFaces] Jumped to pass ${target}.`);
        status(pipeline);
        return pipeline;
    };

    window.roofFacesStatus = function () {
        const pipeline = getPipeline();
        status(pipeline);
        return pipeline;
    };

    window.roofFacesClear = function () {
        const pipeline = getPipeline();
        clearPipelineGeneratedFaces(pipeline);
        removeDebugSVG();
        clearDebugFaceRenderings();
        pipeline.pass = 0;
        pipeline.state = {
            centers: [],
            planes: [],
            edgeMasks: [],
            edgePolys: [],
            polys: [],
        };
        pipeline.snapshots = [];
        console.log(
            "[RoofFaces] Cleared generated faces/points and reset pipeline."
        );
        window.__FACET_DEBUG_CENTERS__ = [];
        publishDebugCentersFor2D(pipeline);

        return pipeline;
    };

    if (!window[PIPE_KEY]) window.roofFacesReset();
})();

function wrapDeg(d) {
    let x = d % 360;
    if (x < 0) x += 360;
    return x;
}
function angDiffDeg(a, b) {
    const da = wrapDeg(a),
        db = wrapDeg(b);
    let d = Math.abs(da - db);
    if (d > 180) d = 360 - d;
    return d;
}

function recomputeMaskCountBBox(mask, w, h) {
    let cnt = 0;
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (let idx = 0; idx < mask.length; idx++) {
        if (!mask[idx]) continue;
        cnt++;
        const x = idx % w;
        const y = (idx / w) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    if (!cnt) return { count: 0, bbox: null };
    return {
        count: cnt,
        bbox: {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
        },
    };
}

function mergePlanesWeighted(planes, weights, metersPerPx) {
    let sw = 0,
        sa = 0,
        sb = 0,
        sc = 0,
        sx = 0,
        sy = 0,
        sz0 = 0;
    for (let i = 0; i < planes.length; i++) {
        const wgt = Math.max(1e-6, weights[i] || 1);
        const p = planes[i];
        sw += wgt;
        sa += p.a * wgt;
        sb += p.b * wgt;
        sc += p.c * wgt;
    }
    const a = sa / sw,
        b = sb / sw,
        c = sc / sw;

    // derive pitch/theta for logging/continuity
    const mag = Math.hypot(a, b); // meters/px
    const pitchDeg =
        Math.atan2(mag, Math.max(1e-9, metersPerPx)) * (180 / Math.PI);
    const thetaDeg = wrapDeg(Math.atan2(b, a) * (180 / Math.PI));

    return { a, b, c, pitchDeg, thetaDeg };
}

function mergeMasksOR(masks, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < masks.length; i++) {
        const m = masks[i];
        if (!m) continue;
        for (let k = 0; k < out.length; k++) {
            if (m[k]) out[k] = 1;
        }
    }
    return out;
}

function computeMaskIntersectionAndHeightDelta(
    maskA,
    maskB,
    bboxA,
    bboxB,
    planeA,
    planeB,
    w,
    h,
    stridePx = 2
) {
    if (!bboxA || !bboxB) return { inter: 0, meanAbsDz: Infinity, samples: 0 };

    const minX = Math.max(bboxA.minX, bboxB.minX);
    const minY = Math.max(bboxA.minY, bboxB.minY);
    const maxX = Math.min(bboxA.maxX, bboxB.maxX);
    const maxY = Math.min(bboxA.maxY, bboxB.maxY);
    if (minX > maxX || minY > maxY)
        return { inter: 0, meanAbsDz: Infinity, samples: 0 };

    // inline plane eval to avoid scope issues with planeZ()
    const zA = (x, y) => planeA.a * x + planeA.b * y + planeA.c;
    const zB = (x, y) => planeB.a * x + planeB.b * y + planeB.c;

    let inter = 0;
    let sumAbs = 0;
    let samples = 0;

    const s = Math.max(1, stridePx | 0);

    for (let y = minY; y <= maxY; y++) {
        const row = y * w;
        for (let x = minX; x <= maxX; x++) {
            const idx = row + x;
            if (!maskA[idx] || !maskB[idx]) continue;
            inter++;

            if ((x + y) % s !== 0) continue;

            sumAbs += Math.abs(zA(x, y) - zB(x, y));
            samples++;
        }
    }

    return { inter, meanAbsDz: samples ? sumAbs / samples : Infinity, samples };
}

// Union-find for grouping merges
function ufMake(n) {
    const p = new Int32Array(n);
    const r = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = (x) => {
        while (p[x] !== x) {
            p[x] = p[p[x]];
            x = p[x];
        }
        return x;
    };
    const union = (a, b) => {
        a = find(a);
        b = find(b);
        if (a === b) return;
        if (r[a] < r[b]) {
            const t = a;
            a = b;
            b = t;
        }
        p[b] = a;
        if (r[a] === r[b]) r[a]++;
    };
    const groups = () => {
        const m = new Map();
        for (let i = 0; i < n; i++) {
            const f = find(i);
            if (!m.has(f)) m.set(f, []);
            m.get(f).push(i);
        }
        return Array.from(m.values());
    };
    return { find, union, groups };
}

function shaveToCore(maskObj, w, h, offsetsCore) {
    const mask = maskObj.mask;
    const core = new Uint8Array(mask.length);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (!mask[idx]) continue;

            let ok = true;
            for (let k = 0; k < offsetsCore.length; k++) {
                const nx = x + offsetsCore[k].dx;
                const ny = y + offsetsCore[k].dy;
                if (
                    nx < 0 ||
                    ny < 0 ||
                    nx >= w ||
                    ny >= h ||
                    !mask[ny * w + nx]
                ) {
                    ok = false;
                    break;
                }
            }
            if (ok) core[idx] = 1;
        }
    }

    let anyCore = 0;
    for (let i = 0; i < core.length; i++) {
        if (core[i]) {
            anyCore = 1;
            break;
        }
    }
    if (!anyCore) {
        mask.fill(0);
        maskObj.count = 0;
        return;
    }

    const keep = new Uint8Array(mask.length);
    const q = new Int32Array(mask.length);
    let qh = 0,
        qt = 0;

    for (let i = 0; i < core.length; i++) {
        if (core[i]) {
            keep[i] = 1;
            q[qt++] = i;
        }
    }

    while (qh < qt) {
        const idx = q[qh++];
        const x = idx % w;
        const y = (idx / w) | 0;

        const tryPush = (nx, ny) => {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
            const ii = ny * w + nx;
            if (!mask[ii] || keep[ii]) return;
            keep[ii] = 1;
            q[qt++] = ii;
        };

        tryPush(x + 1, y);
        tryPush(x - 1, y);
        tryPush(x, y + 1);
        tryPush(x, y - 1);
    }

    let cnt = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] && !keep[i]) mask[i] = 0;
        if (mask[i]) cnt++;
    }
    maskObj.count = cnt;
}

/* =========================================================
   Deprecated old splat face engine (safe stub)
   ========================================================= */
function reconstructConnectedRoof() {
    console.warn(
        "[reconstructConnectedRoof] Deprecated for this test. Use roofFacesReset(); roofFacesNext();"
    );
    return [];
}
