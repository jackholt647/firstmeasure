/* editor_scripts/xml_generator.js */

const XML_POINT_MATCH_TOLERANCE_PX = 0.35;
const XML_BASE_ELEVATION_FT = 2000;

function generateRoofXML(pdfState) {
    if (!pdfState || !pdfState.geometry || !pdfState.report) return null;

    const geometry = pdfState.geometry;
    const report = pdfState.report || {};
    const metersPerPx = resolveXmlMetersPerPx(pdfState);
    const feetPerPx = metersPerPx * 3.28084;
    const feetPerMeter = 3.28084;
    const sourcePoints = Array.isArray(geometry.points) ? geometry.points : [];

    if (!sourcePoints.length || !Number.isFinite(metersPerPx) || metersPerPx <= 0) {
        console.warn("[XML] Missing points or scale; cannot generate model_data.xml.");
        return null;
    }

    const isObstacle = (typeof isObstacleFace === "function") ? isObstacleFace : (() => false);
    const excludedFaceSignatures = getXmlExcludedFaceSignatureSet(pdfState);
    const validFaces = (Array.isArray(pdfState.facesData) ? pdfState.facesData : [])
        .filter((face) => Array.isArray(face?.points) && face.points.length >= 3)
        .filter((face) => !isObstacle(face, report))
        .filter((face) => !excludedFaceSignatures.has(getXmlReportFaceSignature(face.points)));

    if (!validFaces.length) {
        console.warn("[XML] No valid roof faces found; cannot generate model_data.xml.");
        return null;
    }

    const registry = buildXmlPointRegistry(sourcePoints, validFaces, report, geometry);
    const bounds = getXmlBounds(registry.points);
    const minZMeters = registry.points.reduce((min, point) => Math.min(min, toFiniteNumber(point.z, 0)), Infinity);

    const pointsXML = registry.points.map((point, index) => {
        const id = `C${index + 1}`;
        point.__xmlId = id;
        const xFt = (point.x - bounds.centerX) * feetPerPx;
        const yFt = -(point.y - bounds.centerY) * feetPerPx;
        const zFt = ((toFiniteNumber(point.z, 0) - minZMeters) * feetPerMeter) + XML_BASE_ELEVATION_FT;
        return `<POINT data="${formatXmlNumber(xFt)},${formatXmlNumber(yFt)},${formatXmlNumber(zFt)}" id="${id}"/>`;
    });

    const lineRegistry = buildXmlLineRegistry(registry, report, geometry);
    const labelMap = buildXmlFaceLabelMap(pdfState);
    const structures = buildXmlStructures(pdfState, validFaces, registry);
    const roofXML = structures.map((structure, structureIndex) => {
        const facesXML = [];
        const lineIdsForStructure = new Set();
        let nextFaceNumber = 1;
        let nextPolygonNumber = 1;

        structure.faces.forEach((face) => {
            const lineRefs = [];
            const points = Array.isArray(face.points) ? face.points : [];
            const faceId = `F${nextFaceNumber++}`;
            const polygonId = `P${nextPolygonNumber++}`;
            const childFaceIds = [];

            for (let i = 0; i < points.length; i++) {
                const pointA = registry.getPoint(points[i]);
                const pointB = registry.getPoint(points[(i + 1) % points.length]);
                if (!pointA || !pointB || pointA === pointB) continue;
                lineRefs.push(lineRegistry.ensureLine(pointA, pointB, lineRegistry.getKnownType(pointA, pointB) || "EAVE"));
            }

            if (lineRefs.length < 3) return;

            const holeXML = [];
            (Array.isArray(face.holes) ? face.holes : []).forEach((hole, holeIndex) => {
                const holeRefs = buildXmlRingLineRefs(hole, registry, lineRegistry, "EAVE");
                if (holeRefs.length < 3) return;
                holeRefs.forEach((lineId) => lineIdsForStructure.add(lineId));
                const childFaceId = `F${nextFaceNumber++}`;
                const childPolygonId = `P${nextPolygonNumber++}`;
                childFaceIds.push(childFaceId);
                holeXML.push(`<FACE id="${childFaceId}" type="WALLPENETRATION"><POLYGON id="${childPolygonId}" path="${holeRefs.join(",")}" pitch="Infinity"/></FACE>`);
            });

            lineRefs.forEach((lineId) => lineIdsForStructure.add(lineId));
            const pitchRise12 = resolveXmlFacePitchRise12(face, metersPerPx, labelMap);
            const pitch = Math.max(0, Math.round(Math.abs(pitchRise12)));
            const areaSqFt = calculateXmlFaceAreaSqFt(face, feetPerPx, pitchRise12);
            const childrenAttr = childFaceIds.length ? ` children="${childFaceIds.join(",")}"` : "";
            facesXML.push(
                `<FACE id="${faceId}" type="ROOF"${childrenAttr}><POLYGON id="${polygonId}" path="${lineRefs.join(",")}" pitch="${pitch}" size="${Math.round(areaSqFt)}"/></FACE>${holeXML.join("")}`
            );
        });

        const linesXML = lineRegistry.lines
            .filter((line) => lineIdsForStructure.has(line.id) || structure.lineKeys.has(line.key))
            .map((line) => `<LINE height="12" id="${line.id}" path="${line.start.__xmlId},${line.end.__xmlId}" type="${line.type}" width="6"/>`);

        return `        <ROOF id="ROOF${structureIndex + 1}">
            <FACES>${facesXML.join("")}</FACES>
            <LINES>${linesXML.join("")}</LINES>
            <POINTS>${pointsXML.join("")}</POINTS>
        </ROOF>`;
    }).filter(Boolean);

    if (!roofXML.length) {
        console.warn("[XML] No serializable roofs found; cannot generate model_data.xml.");
        return null;
    }

    const location = parseXmlLocation(pdfState);

    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<DATA_EXPORT>
    <LOCATION address="${escapeXml(location.address)}" city="${escapeXml(location.city)}" lat="${escapeXml(location.lat)}" long="${escapeXml(location.lng)}" postal="${escapeXml(location.postal)}" state="${escapeXml(location.state)}"/>
    <STRUCTURES>
${roofXML.join("\n")}
    </STRUCTURES>
</DATA_EXPORT>`;
}

function resolveXmlMetersPerPx(pdfState) {
    if (window.getPdfMetersPerPx) {
        const value = Number(window.getPdfMetersPerPx(pdfState));
        if (Number.isFinite(value) && value > 0) return value;
    }
    const radius = Number(
        pdfState.radiusMeters
        || (window.getRadiusMeters ? window.getRadiusMeters() : null)
        || window.RADIUS_METERS
        || 20
    );
    const width = Number(pdfState?.dims?.w || window.imageWidth || 0);
    if (Number.isFinite(radius) && radius > 0 && Number.isFinite(width) && width > 0) {
        return (radius * 2) / width;
    }
    if (window.getMetersPerPx) {
        const value = Number(window.getMetersPerPx());
        if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
}

function buildXmlPointRegistry(sourcePoints, faces, report, geometry) {
    const points = [];

    const findExisting = (candidate) => {
        if (!candidate) return null;
        let bestPoint = null;
        let bestDistance = Infinity;
        for (const point of points) {
            const dx = Number(point.x) - Number(candidate.x);
            const dy = Number(point.y) - Number(candidate.y);
            const distance = Math.sqrt((dx * dx) + (dy * dy));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestPoint = point;
            }
        }
        return bestDistance <= XML_POINT_MATCH_TOLERANCE_PX ? bestPoint : null;
    };

    const addPoint = (candidate) => {
        if (!isXmlPoint(candidate)) return null;
        const existing = findExisting(candidate);
        if (existing) return existing;
        const point = {
            x: Number(candidate.x),
            y: Number(candidate.y),
            z: toFiniteNumber(candidate.z, 0),
            layer: candidate.layer || 1
        };
        points.push(point);
        return point;
    };

    sourcePoints.forEach(addPoint);
    faces.forEach((face) => {
        (face.points || []).forEach(addPoint);
        (face.holes || []).forEach((hole) => (hole || []).forEach(addPoint));
    });
    getXmlSourceLines(report, geometry).forEach((line) => {
        const endpoints = getXmlLineEndpoints(line);
        addPoint(endpoints[0]);
        addPoint(endpoints[1]);
    });

    return {
        points,
        getPoint: (candidate) => findExisting(candidate) || addPoint(candidate)
    };
}

function buildXmlLineRegistry(pointRegistry, report, geometry) {
    const lines = [];
    const byKey = new Map();
    const knownTypes = new Map();

    const ensureLine = (start, end, type) => {
        const key = getXmlEdgeKey(start, end);
        const normalizedType = normalizeXmlLineType(type);
        if (byKey.has(key)) {
            const line = byKey.get(key);
            if (line.type === "EAVE" && normalizedType !== "EAVE") line.type = normalizedType;
            return line.id;
        }

        const line = {
            id: `L${lines.length + 1}`,
            key,
            start,
            end,
            type: normalizedType
        };
        lines.push(line);
        byKey.set(key, line);
        return line.id;
    };

    getXmlSourceLines(report, geometry).forEach((sourceLine) => {
        const endpoints = getXmlLineEndpoints(sourceLine);
        const start = pointRegistry.getPoint(endpoints[0]);
        const end = pointRegistry.getPoint(endpoints[1]);
        if (!start || !end || start === end) return;
        const type = normalizeXmlLineType(sourceLine.type);
        const key = getXmlEdgeKey(start, end);
        knownTypes.set(key, type);
        ensureLine(start, end, type);
    });

    return {
        lines,
        ensureLine,
        getKnownType: (start, end) => knownTypes.get(getXmlEdgeKey(start, end))
    };
}

function getXmlSourceLines(report, geometry) {
    if (Array.isArray(report?.lines) && report.lines.length) return report.lines;
    return (Array.isArray(geometry?.connections) ? geometry.connections : []).map((conn) => ({
        points: [conn.start, conn.end],
        type: conn.type || "EAVE"
    }));
}

function getXmlLineEndpoints(line) {
    if (Array.isArray(line?.points) && line.points.length >= 2) return [line.points[0], line.points[1]];
    return [line?.start, line?.end];
}

function buildXmlStructures(pdfState, validFaces, pointRegistry) {
    const faceBySignature = new Map(validFaces.map((face) => [getXmlFaceSignature(face.points), face]));
    const structures = [];

    if (Array.isArray(pdfState.structures) && pdfState.structures.length) {
        pdfState.structures.forEach((structure) => {
            const faces = (Array.isArray(structure.faces) ? structure.faces : [])
                .map((face) => faceBySignature.get(getXmlFaceSignature(face.points)))
                .filter(Boolean);
            if (!faces.length) return;
            structures.push({
                faces,
                lineKeys: buildXmlStructureLineKeys(structure.lines, pointRegistry)
            });
        });
    }

    if (!structures.length) {
        structures.push({
            faces: validFaces,
            lineKeys: new Set()
        });
    }

    const seen = new Set();
    return structures.map((structure) => {
        const uniqueFaces = structure.faces.filter((face) => {
            const signature = getXmlFaceSignature(face.points);
            if (seen.has(signature)) return false;
            seen.add(signature);
            return true;
        });
        return { ...structure, faces: uniqueFaces };
    }).filter((structure) => structure.faces.length);
}

function buildXmlStructureLineKeys(lines, pointRegistry) {
    const keys = new Set();
    (Array.isArray(lines) ? lines : []).forEach((line) => {
        const endpoints = getXmlLineEndpoints(line);
        const start = pointRegistry.getPoint(endpoints[0]);
        const end = pointRegistry.getPoint(endpoints[1]);
        if (!start || !end || start === end) return;
        keys.add(getXmlEdgeKey(start, end));
    });
    return keys;
}

function buildXmlRingLineRefs(points, pointRegistry, lineRegistry, fallbackType) {
    const refs = [];
    const ring = Array.isArray(points) ? points : [];
    for (let i = 0; i < ring.length; i++) {
        const pointA = pointRegistry.getPoint(ring[i]);
        const pointB = pointRegistry.getPoint(ring[(i + 1) % ring.length]);
        if (!pointA || !pointB || pointA === pointB) continue;
        refs.push(lineRegistry.ensureLine(
            pointA,
            pointB,
            lineRegistry.getKnownType(pointA, pointB) || fallbackType || "EAVE"
        ));
    }
    return refs;
}

function getXmlExcludedFaceSignatureSet(pdfState) {
    if (typeof getReportExcludedSignatureSet === "function") {
        return getReportExcludedSignatureSet(pdfState);
    }

    const signatures = [];
    if (Array.isArray(pdfState?.excludedSignatures)) signatures.push(...pdfState.excludedSignatures);
    if (typeof window !== "undefined" && window.reportExcludedSignatures instanceof Set) {
        signatures.push(...Array.from(window.reportExcludedSignatures));
    }
    return new Set(signatures.filter((signature) => typeof signature === "string" && signature.trim() !== ""));
}

function buildXmlFaceLabelMap(pdfState) {
    const labels = new Map();
    (Array.isArray(pdfState?.customLabels) ? pdfState.customLabels : []).forEach((label) => {
        if (label && label.faceSignature) labels.set(label.faceSignature, label);
    });
    return labels;
}

function getXmlReportFaceSignature(points) {
    if (typeof getLocalFaceSignatureReport === "function") {
        return getLocalFaceSignatureReport(points);
    }
    if (typeof window !== "undefined" && typeof window.getLocalFaceSignatureReport === "function") {
        return window.getLocalFaceSignatureReport(points);
    }
    return getXmlFaceSignature(points);
}

function resolveXmlFacePitchRise12(face, metersPerPx, labelMap) {
    const label = labelMap?.get(getXmlReportFaceSignature(face?.points));
    const labelPitch = parseXmlLabelPitchRise12(label);
    if (Number.isFinite(labelPitch)) return Math.abs(labelPitch);

    if (typeof getFacePitchRise12 === "function") {
        const reportPitch = getFacePitchRise12(face, metersPerPx);
        if (Number.isFinite(reportPitch)) return Math.abs(reportPitch);
    }

    return calculateXmlPitchRise12(face?.points, metersPerPx);
}

function parseXmlLabelPitchRise12(label) {
    if (typeof getPdfLabelRise12 === "function") {
        const value = getPdfLabelRise12(label);
        if (Number.isFinite(value)) return value;
    }
    if (!label || typeof label !== "object") return null;

    const candidates = [label.pitchText, label.text, label.pitchExactText];
    for (let i = 0; i < candidates.length; i++) {
        const candidate = String(candidates[i] || "").replace(/\/12$/, "").trim();
        if (!candidate) continue;
        const parsed = parseFloat(candidate);
        if (Number.isFinite(parsed)) return parsed;
    }

    const exactNumeric = Number(label.pitchExact);
    if (Number.isFinite(exactNumeric)) return exactNumeric;

    return null;
}

function calculateXmlPitch(points, metersPerPx) {
    return Math.max(0, Math.round(calculateXmlPitchRise12(points, metersPerPx)));
}

function calculateXmlPitchRise12(points, metersPerPx) {
    const plane = fitXmlPlaneLeastSquares(points);
    const rawSlope = Math.sqrt((plane.a * plane.a) + (plane.b * plane.b));
    const trueSlope = rawSlope / metersPerPx;
    return Number.isFinite(trueSlope) ? Math.abs(trueSlope * 12) : 0;
}

function calculateXmlFaceAreaSqFt(face, feetPerPx, pitchRise12) {
    const outerArea = calculateXmlPolygonArea(face.points || []);
    const holeArea = (Array.isArray(face.holes) ? face.holes : [])
        .reduce((sum, hole) => sum + calculateXmlPolygonArea(hole || []), 0);
    const flatArea = Math.max(0, outerArea - holeArea) * feetPerPx * feetPerPx;
    const slope = Math.abs(toFiniteNumber(pitchRise12, 0)) / 12;
    return flatArea * Math.sqrt(1 + (slope * slope));
}

function fitXmlPlaneLeastSquares(points) {
    const valid = (Array.isArray(points) ? points : []).filter(isXmlPoint);
    if (valid.length < 3) return { a: 0, b: 0, c: 0 };

    let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
    valid.forEach((point) => {
        const x = Number(point.x);
        const y = Number(point.y);
        const z = toFiniteNumber(point.z, 0);
        sx += x; sy += y; sz += z;
        sxx += x * x; syy += y * y; sxy += x * y;
        sxz += x * z; syz += y * z;
    });

    const solved = solveXml3x3([
        [sxx, sxy, sx, sxz],
        [sxy, syy, sy, syz],
        [sx, sy, valid.length, sz]
    ]);

    return solved ? { a: solved[0], b: solved[1], c: solved[2] } : { a: 0, b: 0, c: 0 };
}

function solveXml3x3(matrix) {
    const m = matrix.map((row) => row.slice());
    for (let col = 0; col < 3; col++) {
        let pivot = col;
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        }
        if (Math.abs(m[pivot][col]) < 1e-9) return null;
        if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];

        const divisor = m[col][col];
        for (let c = col; c < 4; c++) m[col][c] /= divisor;

        for (let row = 0; row < 3; row++) {
            if (row === col) continue;
            const factor = m[row][col];
            for (let c = col; c < 4; c++) m[row][c] -= factor * m[col][c];
        }
    }
    return [m[0][3], m[1][3], m[2][3]];
}

function normalizeXmlLineType(type) {
    const value = String(type || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (value === "eave") return "EAVE";
    if (value === "rake") return "RAKE";
    if (value === "ridge") return "RIDGE";
    if (value === "hip") return "HIP";
    if (value === "valley") return "VALLEY";
    if (value === "head_wall" || value === "headwall") return "HEAD_WALL";
    if (value === "side_wall" || value === "sidewall") return "SIDE_WALL";
    if (value.includes("step") || value.includes("chimney_edge")) return "STEPFLASH";
    if (value.includes("wall")) return "STEPFLASH";
    if (value.includes("flash") || value.includes("transition") || value === "trans") return "FLASHING";
    if (value.includes("skylight")) return "SKYLIGHT";
    if (value.includes("chimney")) return "FLASHING";
    if (value.includes("parapet")) return "PARAPET";
    return "EAVE";
}

function parseXmlLocation(pdfState) {
    const addressText = String(pdfState.address || "");
    const parts = addressText.split(",").map((part) => part.trim()).filter(Boolean);
    const street = parts[0] || addressText.trim();
    let city = parts.length >= 2 ? parts[1] : "";
    let region = parts.length >= 3 ? parts[2] : "";

    if (parts.length >= 4 && /^[A-Z]{2}\b/i.test(parts[parts.length - 2])) {
        city = parts[parts.length - 3] || city;
        region = parts[parts.length - 2] || region;
    }

    const regionMatch = /([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(region);
    return {
        address: street,
        city,
        state: regionMatch ? regionMatch[1].toUpperCase() : (region.split(/\s+/)[0] || ""),
        postal: regionMatch ? regionMatch[2] : (region.split(/\s+/)[1] || ""),
        lat: formatLocationNumber(pdfState?.center?.lat),
        lng: formatLocationNumber(pdfState?.center?.lng)
    };
}

function getXmlBounds(points) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach((point) => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
    });
    return {
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2
    };
}

function getXmlEdgeKey(pointA, pointB) {
    const ids = [pointA.__xmlId || getXmlPointKey(pointA), pointB.__xmlId || getXmlPointKey(pointB)].sort();
    return `${ids[0]}|${ids[1]}`;
}

function getXmlPointKey(point) {
    return `${Number(point.x).toFixed(3)}_${Number(point.y).toFixed(3)}`;
}

function getXmlFaceSignature(points) {
    return (Array.isArray(points) ? points : [])
        .map((point) => getXmlPointKey(point))
        .sort()
        .join("|");
}

function calculateXmlPolygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        area += (Number(p1.x) * Number(p2.y)) - (Number(p2.x) * Number(p1.y));
    }
    return Math.abs(area / 2);
}

function isXmlPoint(point) {
    return point
        && Number.isFinite(Number(point.x))
        && Number.isFinite(Number(point.y));
}

function toFiniteNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function formatXmlNumber(value) {
    return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

function formatLocationNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : "";
}

function escapeXml(unsafe) {
    return String(unsafe || "").replace(/[<>&'"]/g, (char) => {
        switch (char) {
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "&": return "&amp;";
            case "'": return "&apos;";
            case "\"": return "&quot;";
            default: return char;
        }
    });
}
