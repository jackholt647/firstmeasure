/* measurements.js - Roof Quantification & Classification Logic */

// --- 1. GLOBALS & TYPES ---

const LINE_TYPES = {
  RIDGE:        { id: 'ridge',          color: '#FF0000', label: 'Ridge' },                // Red
  HIP:          { id: 'hip',            color: '#E67300', label: 'Hip' },                  // Darker Orange

  VALLEY:       { id: 'valley',         color: '#800080', label: 'Valley' },               // Purple

  RAKE:         { id: 'rake',           color: '#006400', label: 'Rake' },                 // Dark Green
  EAVE:         { id: 'eave',           color: '#FFD400', label: 'Eave' },                 // Yellow

  // Flashing
  HEAD_WALL:    { id: 'head_wall',      color: '#A0522D', label: 'Headwall Flashing' },  // Lighter Brown
  SIDE_WALL:    { id: 'side_wall',      color: '#FF00FF', label: 'Sidewall Flashing' },  // Pink

  TRANSITION:   { id: 'trans',          color: '#808080', label: 'Transition' },           // Gray

  PARAPET:      { id: 'parapet',        color: '#5C2E0C', label: 'Parapet Wall' },        // Darker Brown
  PROTRUSION:   { id: 'protrusion',     color: '#589BA6', label: 'Protrusion' },          // Unchanged

  CHIMNEY_BACK: { id: 'chimney_back',   color: '#00008B', label: 'Chimney Back Pan' },        // Dark Blue
  CHIMNEY_EDGE: { id: 'chimney_edge',   color: '#007bff', label: 'Chimney Step' },        // Medium Blue
  CHIMNEY_FRONT:{ id: 'chimney_front',  color: '#ADD8E6', label: 'Chimney Apron' },       // Light Blue

  SKYLIGHT:     { id: 'skylight',       color: '#00FFFF', label: 'Skylight' },            // Cyan
  UNKNOWN:      { id: 'unknown',        color: '#000000', label: 'Unknown' }               // Black
};

const STICKY_REGEN_LINE_TYPES = new Set([
  LINE_TYPES.PROTRUSION.id,
  LINE_TYPES.CHIMNEY_BACK.id,
  LINE_TYPES.CHIMNEY_EDGE.id,
  LINE_TYPES.CHIMNEY_FRONT.id
]);

function isStickyRegenLineType(typeId) {
  return STICKY_REGEN_LINE_TYPES.has(typeId);
}

function resetLineTypesForRegeneration(options = {}) {
  const { preserveManual = true, preserveSticky = true } = options || {};
  if (!activeGeometry || !Array.isArray(activeGeometry.connections)) return;
  activeGeometry.connections.forEach(conn => {
    if (!conn) return;
    if (typeof window.isItemInActiveStructure === 'function' && !window.isItemInActiveStructure(conn)) return;
    if (preserveManual && conn.manualType) return;
    if (!preserveManual) conn.manualType = false;
    if (preserveSticky && isStickyRegenLineType(conn.type)) return;
    conn.type = null;
    conn.manualType = false;
  });
}




// Global to store report data
let lastRoofReport = null;

// Global state for measurement mode UI
let isMeasurementMode = false;

// Constants for Calc
const NFVA_RATIO = 300; // 1:300 rule
const RIDGE_NFVA_PER_FT = 18;
const BOX_VENT_NFVA = 50;

// --- 2. MAIN EXECUTION ---

/* measurements.js - Logic using lastResolvedFacesCache */

/* measurements.js - Fixed Ghost Faces & Occlusion Logic */

const OCCLUSION_SETTINGS = {
    SAMPLE_COUNT: 20,       
    BUFFER_PERCENT: 0.1,    
    Z_TOLERANCE: 0.05,      // 5cm buffer
    ON_FACE_Z_TOLERANCE: 0.025,
    COVERAGE_THRESHOLD: 0.75 
};

function handleGenerateMeasurements(options = {}) {
    try {
        const scopedOptions = options || {};
        if (!scopedOptions.__structureScoped && typeof window.withStructureModeScope === 'function' && !window.__structureScopeApplying && !window.__structureModeForceAll) {
            return window.withStructureModeScope(() => handleGenerateMeasurements({
                ...scopedOptions,
                __structureScoped: true
            }));
        }
        const {
            preserveManual = false,
            preserveSticky = true
        } = scopedOptions;

        if (!activeGeometry || !activeGeometry.connections.length) {
            alert("No geometry defined. Please generate geometry first.");
            return;
        }

        if (typeof invalidateFaceCache === 'function') {
            invalidateFaceCache();
        }

        // Force 3D solver to ensure fresh, robust data
        if (typeof window.renderFinalPass === 'function') {
            window.renderFinalPass(false);
        } else {
            console.error("renderFinalPass missing. Calculations may be inaccurate.");
        }

        // Reset line types before classification. The toolbar recalc is a true
        // reset, while background generation can opt into preserving manual edits.
        resetLineTypesForRegeneration({ preserveManual, preserveSticky });

        lastRoofReport = null;
        recalculateMeasurementData();

        if (typeof switchTab === 'function') switchTab('view2d');
        enterMeasurementMode();
        if (typeof updateMeasurementUI === 'function') updateMeasurementUI();
        if (typeof renderGeometry2D === 'function') renderGeometry2D();
        if (typeof renderGeometry3D === 'function') renderGeometry3D();
        if (typeof triggerLiveUpdate === 'function') triggerLiveUpdate();
    } catch (err) {
        console.error('[LineTypes] Regenerate failed:', err);
    }
}
window.handleGenerateMeasurements = handleGenerateMeasurements;



/* measurements.js - Updated functions */

function recalculateMeasurementData() {
    if (!activeGeometry) return;

    // 1. Identify Skylights, Chimney Edges, and Chimney Backs
    const { 
        skylightConnections, 
        chimneyEdgeConnections, 
        chimneyBackConnections,
        chimneyFrontConnections
    } = detectSkylightsAndChimneys();

    // 2. Prepare Source of Truth Faces (Clean Data)
    let allFaces = [];
    
    // Step 2a: Gather Raw Faces
    if (window.lastResolvedFacesCache && Array.isArray(window.lastResolvedFacesCache)) {
        allFaces = window.lastResolvedFacesCache.map(face => ({
            ...face,
            plane: getRobustPlane(face.points) 
        }));
    } else if (typeof facesGroup !== 'undefined' && facesGroup) {
        facesGroup.children.forEach(mesh => {
            if (mesh.userData && mesh.userData.faceDef) {
                const f = mesh.userData.faceDef;
                f.plane = getRobustPlane(f.points);
                allFaces.push(f);
            }
        });
    }

    // STRICTLY FILTER DEGENERATE FACES
    allFaces = allFaces.filter(f => {
        if (!f.points || f.points.length < 3) return false;
        // Ensure area is significant (avoids 0 area ghosts)
        const area = Math.abs(getPolygonArea(f.points));
        return area > 0.1; 
    });

    // 3. Map Connections to Faces
    const mapLineToFaces = mapConnectionsToFaces(allFaces);

    // 4. Classify Lines (Pass all sets)
    const classification = classifyLines(
        mapLineToFaces, 
        skylightConnections, 
        chimneyEdgeConnections, 
        chimneyBackConnections,
        chimneyFrontConnections,
        allFaces
    );

    // 5. Materials & Ventilation
    // --- CHANGE: Pass allFaces explicitly so calculation uses the filtered list ---
    const materialReport = calculateMaterials(classification, allFaces);
    
    const ventCalc = calculateVentilationNeeds(materialReport, classification);
    materialReport.ventilation = ventCalc;

    lastRoofReport = { lines: classification, materials: materialReport };
    window.__lastRoofReportGeoStamp = window.__geoMutStamp || 0;
    window.__lastRoofReportPointCount = activeGeometry.points ? activeGeometry.points.length : 0;
    window.__lastRoofReportConnectionCount = activeGeometry.connections ? activeGeometry.connections.length : 0;
    window.__lastRoofReportFaceCount = Array.isArray(window.lastResolvedFacesCache)
        ? window.lastResolvedFacesCache.length
        : allFaces.length;
    window.__lastRoofReportImageWidth = Number(imageWidth) || 0;
    window.__lastRoofReportImageHeight = Number(imageHeight) || 0;
    window.__lastRoofReportMetersPerPx = (typeof window.getMetersPerPx === 'function')
        ? Number(window.getMetersPerPx())
        : null;

    // 6. Sync Visuals
    classification.forEach(item => {
        item.conn.type = item.type;
    });
}

function calculateMaterials(lines, facesSource) {
  const report = { linear: {}, squares: {}, totalSquares: 0, ventilationSquares: 0 };

  // 1. Linear Totals
  lines.forEach(item => {
    if (!report.linear[item.type]) report.linear[item.type] = 0;
    report.linear[item.type] += item.length;
  });

  // 2. Determine Faces Source
  // Use passed filtered source if available, otherwise fallback
  let faces = facesSource;
  if (!faces) {
      if (window.lastResolvedFacesCache && Array.isArray(window.lastResolvedFacesCache)) {
          faces = window.lastResolvedFacesCache;
      } else if (typeof facesGroup !== 'undefined' && facesGroup) {
          faces = facesGroup.children
              .filter(m => m.userData && m.userData.faceDef)
              .map(m => m.userData.faceDef);
      } else {
          faces = [];
      }
  }

  // 3. Calculate Squares from Faces
  if (faces && faces.length > 0) {
    const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
      (((window.getRadiusMeters ? window.getRadiusMeters() :
        (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imageWidth));

    faces.forEach(face => {
      let areaPx = 0;
      const pts = face.points;

      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        areaPx += (p1.x * p2.y - p2.x * p1.y);
      }

      if (face.holes && Array.isArray(face.holes)) {
        face.holes.forEach(hole => {
          for (let i = 0; i < hole.length; i++) {
            const p1 = hole[i];
            const p2 = hole[(i + 1) % hole.length];
            areaPx -= (p1.x * p2.y - p2.x * p1.y);
          }
        });
      }

      areaPx = Math.abs(areaPx * 0.5);
      
      // SKIP if area is effectively zero
      if (areaPx < 1.0) return;

      const areaM2_Flat = areaPx * (metersPerPx * metersPerPx);

      const plane = fitPlaneLinearInternal(face.points);
      const rawSlope = Math.sqrt(plane.a * plane.a + plane.b * plane.b);

      const pixelsPerMeter = 1 / metersPerPx;
      const realSlope = rawSlope * pixelsPerMeter;

      const pitchDeg = Math.atan(realSlope) * (180 / Math.PI);
      const rise = Math.tan(pitchDeg * (Math.PI / 180)) * 12;
      const riseRounded = Math.round(rise);
      const pitchLabel = `${riseRounded}/12`;

      const areaM2_Sloped = areaM2_Flat / Math.cos(pitchDeg * (Math.PI / 180));
      const areaSqFt = areaM2_Sloped * 10.7639;
      const squares = areaSqFt / 100;

      if (!report.squares[pitchLabel]) report.squares[pitchLabel] = 0;
      report.squares[pitchLabel] += squares;
      report.totalSquares += squares;

      if (riseRounded >= 2) report.ventilationSquares += squares;
    });
  }

  return report;
}





/**
 * Maps lines to faces with strict deduplication to prevent "Ghost Faces".
 * FIX: also maps HOLE boundary edges (face.holes) as belonging to the parent face.
 */
function mapConnectionsToFaces(allFaces) {
    const lineMap = new Map();
    activeGeometry.connections.forEach(conn => lineMap.set(conn, []));

    if (!allFaces || allFaces.length === 0) return lineMap;

    // Face ID based on centroid + point count (same as your current logic)
    const getFaceId = (face) => {
        let cx = 0, cy = 0;
        (face.points || []).forEach(p => { cx += p.x; cy += p.y; });
        return `${cx.toFixed(1)}_${cy.toFixed(1)}_${(face.points || []).length}`;
    };

    // Fast connection lookup by edge endpoints (XY key)
    const ptKey = (p) => `${p.x.toFixed(3)}_${p.y.toFixed(3)}`;
    const edgeKey = (a, b) => {
        const ka = ptKey(a), kb = ptKey(b);
        return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    };

    const connByEdge = new Map();
    activeGeometry.connections.forEach(c => {
        connByEdge.set(edgeKey(c.start, c.end), c);
    });

    // Rare fallback if rounding/key misses (keeps compatibility with pointer-equality graphs)
    const eqPt = (a, b) => a === b || (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);

    const getConnForEdge = (a, b) => {
        const k = edgeKey(a, b);
        const hit = connByEdge.get(k);
        if (hit) return hit;

        // fallback scan
        return activeGeometry.connections.find(c =>
            (eqPt(c.start, a) && eqPt(c.end, b)) || (eqPt(c.start, b) && eqPt(c.end, a))
        ) || null;
    };

    const addFaceToConn = (conn, face, faceId) => {
        const currentList = lineMap.get(conn);
        if (!currentList) return;

        const alreadyHas = currentList.some(f => getFaceId(f) === faceId);
        if (!alreadyHas) currentList.push(face);
    };

    allFaces.forEach(face => {
        const faceId = getFaceId(face);

        // Collect rings: outer boundary + any hole boundaries
        const rings = [];
        if (face.points && face.points.length >= 2) rings.push(face.points);

        if (Array.isArray(face.holes)) {
            face.holes.forEach(h => {
                if (h && h.length >= 2) rings.push(h); // <-- FIX: include hole edges
            });
        }

        // Map every ring edge to a connection
        rings.forEach(ring => {
            for (let i = 0; i < ring.length; i++) {
                const p1 = ring[i];
                const p2 = ring[(i + 1) % ring.length];

                const conn = getConnForEdge(p1, p2);
                if (conn) addFaceToConn(conn, face, faceId);
            }
        });
    });

    return lineMap;
}


function getRobustPlane(points) {
    const validPts = points.filter(p => p.z !== null && p.z !== undefined);
    if (typeof window.fitPlaneRANSAC === 'function' && validPts.length >= 5) {
        return window.fitPlaneRANSAC(validPts, 100, 0.2); 
    }
    return fitPlaneLinearInternal(validPts);
}

function classifyLines(lineMap, skylightSet, chimneyEdgeSet, chimneyBackSet, chimneyFrontSet, allFaces) {
    const results = [];
    const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
        (((window.getRadiusMeters ? window.getRadiusMeters() :
            (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imageWidth));

    const FLAT_THRESHOLD_DEG = 10;
    const getFaceCentroid2D = (face) => {
        const pts = face && Array.isArray(face.points) ? face.points : [];
        if (!pts.length) return null;
        const sum = pts.reduce((acc, p) => ({ x: acc.x + (p.x || 0), y: acc.y + (p.y || 0) }), { x: 0, y: 0 });
        return { x: sum.x / pts.length, y: sum.y / pts.length };
    };
    const classifyChimneyByLocalFace = (conn, faces, isFlat, fallbackType) => {
        if (!isFlat) return LINE_TYPES.CHIMNEY_EDGE.id;
        const face = (faces || []).find(f => f && (f.plane || (Array.isArray(f.points) && f.points.length >= 3)));
        if (!face) return fallbackType || LINE_TYPES.CHIMNEY_EDGE.id;
        const plane = face.plane || fitPlaneLinearInternal(face.points || []);
        const slope = plane ? Math.hypot(plane.a || 0, plane.b || 0) : 0;
        if (!(slope > 1e-8)) return fallbackType || LINE_TYPES.CHIMNEY_EDGE.id;
        const roofUp = { x: (plane.a || 0) / slope, y: (plane.b || 0) / slope };
        const centroid = getFaceCentroid2D(face);
        if (!centroid) return fallbackType || LINE_TYPES.CHIMNEY_EDGE.id;
        const mid = {
            x: ((conn.start.x || 0) + (conn.end.x || 0)) / 2,
            y: ((conn.start.y || 0) + (conn.end.y || 0)) / 2
        };
        const faceDir = { x: centroid.x - mid.x, y: centroid.y - mid.y };
        const openingDir = { x: -faceDir.x, y: -faceDir.y };
        const openingIsUpslope = (openingDir.x * roofUp.x + openingDir.y * roofUp.y) > 0;
        return openingIsUpslope ? LINE_TYPES.CHIMNEY_FRONT.id : LINE_TYPES.CHIMNEY_BACK.id;
    };

    lineMap.forEach((faces, conn) => {
        const p1 = conn.start;
        const p2 = conn.end;

        const z1 = (p1.z !== null) ? p1.z : 0;
        const z2 = (p2.z !== null) ? p2.z : 0;

        const dx = (p2.x - p1.x) * metersPerPx;
        const dy = (p2.y - p1.y) * metersPerPx;
        const dz = z1 - z2;
        
        const lenXY = Math.sqrt(dx * dx + dy * dy);
        const len3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const lengthFeet = len3D * 3.28084;
        
        const lineAngleRad = Math.atan2(Math.abs(dz), lenXY);
        const lineAngleDeg = lineAngleRad * (180 / Math.PI);
        const isFlat = lineAngleDeg < FLAT_THRESHOLD_DEG;

        let type = LINE_TYPES.UNKNOWN.id;

        // Detected chimney geometry wins over saved chimney sticker types so
        // recalculation can repair older projects with stale edge labels.
        if (conn.manualType && conn.type && conn.type !== LINE_TYPES.UNKNOWN.id) {
            type = conn.type;
        }
        else if (chimneyBackSet && chimneyBackSet.has(conn)) {
            type = classifyChimneyByLocalFace(conn, faces, isFlat, LINE_TYPES.CHIMNEY_BACK.id);
        }
        else if (chimneyEdgeSet && chimneyEdgeSet.has(conn)) {
            type = classifyChimneyByLocalFace(conn, faces, isFlat, LINE_TYPES.CHIMNEY_EDGE.id);
        }
        else if (chimneyFrontSet && chimneyFrontSet.has(conn)) {
            type = classifyChimneyByLocalFace(conn, faces, isFlat, LINE_TYPES.CHIMNEY_FRONT.id);
        }
        else if (conn.type && conn.type !== LINE_TYPES.UNKNOWN.id) {
            const stickyChimney = conn.type === LINE_TYPES.CHIMNEY_BACK.id ||
                conn.type === LINE_TYPES.CHIMNEY_EDGE.id ||
                conn.type === LINE_TYPES.CHIMNEY_FRONT.id;
            type = stickyChimney ? classifyChimneyByLocalFace(conn, faces, isFlat, conn.type) : conn.type;
        }
        else if (skylightSet && skylightSet.has(conn)) {
            type = LINE_TYPES.SKYLIGHT.id;
        } else {
            // PRIORITY 1: Check Occlusion BEFORE Shared checks.
            const isOccluded = checkLineOcclusion(p1, p2, faces, allFaces);
            const isOnNonOwnerFace = !isOccluded && checkLineOnNonOwnerFace(p1, p2, faces, allFaces);

            if (isOccluded || isOnNonOwnerFace) {
                // Occluded lines sit underneath a higher face.
                // Horizontal → Head Wall Flashing, Sloped → Side Wall Flashing
                type = isFlat ? LINE_TYPES.HEAD_WALL.id : LINE_TYPES.SIDE_WALL.id;
            }
            // PRIORITY 2: Shared Lines (Ridges/Hips/Transitions)
            else if (faces.length >= 2) {
                if (isFlat) {
                    // A true ridge is the peak of both faces — no face surface goes higher.
                    // If either face rises above the line, it's a pitch transition.
                    const lineZ = ((p1.z || 0) + (p2.z || 0)) / 2;
                    const eitherFaceRises = faces.some(face => {
                        return doesFaceRiseAboveLine(p1, p2, lineZ, face, metersPerPx);
                    });
                    type = eitherFaceRises ? LINE_TYPES.TRANSITION.id : LINE_TYPES.RIDGE.id;
                }
                else type = checkIsValley(p1, p2, faces[0], faces[1], metersPerPx) ? LINE_TYPES.VALLEY.id : LINE_TYPES.HIP.id;
            } 
            // PRIORITY 3: Perimeter Lines (Eave/Rake)
            else if (faces.length === 1) {
                const face = faces[0];
                if (isFlat) {
                    type = LINE_TYPES.EAVE.id; 
                } else {
                    type = LINE_TYPES.RAKE.id;
                }
            }
        }

        results.push({ conn: conn, type: type, length: lengthFeet, points: [p1, p2] });
    });

    return results;
}

/**
 * Checks whether a face's surface rises above the line height when stepping
 * perpendicular to the line into the face. Used to distinguish true ridges
 * (both faces slope DOWN from line) from pitch transitions (at least one
 * face continues UP past the line).
 *
 * Strategy: sample several points along the line. At each, step a short
 * distance perpendicular-into-the-face and compare the face plane's Z
 * to the line's Z at that position. This captures the LOCAL slope right
 * next to the line, which is what matters even on large irregular faces.
 */
function doesFaceRiseAboveLine(p1, p2, avgLineZ, face, metersPerPx) {
    const SAMPLE_COUNT = 7;           // points along the line to test
    const STEP_DISTANCES_PX = [5, 12, 20]; // multiple step depths into face (pixels)
    const Z_RISE_TOLERANCE = 0.03;    // meters — face must be this much higher to count

    const plane = face.plane || fitPlaneLinearInternal(face.points);

    // Line direction in pixel space
    const ldx = p2.x - p1.x;
    const ldy = p2.y - p1.y;
    const lineLen = Math.sqrt(ldx * ldx + ldy * ldy);
    if (lineLen < 1e-6) return false;

    // Unit perpendicular (two candidates)
    const perpX = -ldy / lineLen;
    const perpY =  ldx / lineLen;

    // Determine which perpendicular direction points INTO this face
    const faceCentroid = getFaceCentroid(face);
    const lineMidX = (p1.x + p2.x) / 2;
    const lineMidY = (p1.y + p2.y) / 2;
    const toFaceDot = (faceCentroid.x - lineMidX) * perpX + (faceCentroid.y - lineMidY) * perpY;

    const intoX = toFaceDot >= 0 ? perpX : -perpX;
    const intoY = toFaceDot >= 0 ? perpY : -perpY;

    let risingSamples = 0;
    let validSamples = 0;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
        // Walk 10%-90% along the line to avoid endpoint noise
        const t = 0.1 + (i / (SAMPLE_COUNT - 1)) * 0.8;

        const lx = p1.x + ldx * t;
        const ly = p1.y + ldy * t;
        const lz = (p1.z || 0) + ((p2.z || 0) - (p1.z || 0)) * t;

        // Try multiple step distances — use the first one that lands inside the face
        for (const stepPx of STEP_DISTANCES_PX) {
            const sx = lx + intoX * stepPx;
            const sy = ly + intoY * stepPx;

            if (!isPointInPolyMeasurement(sx, sy, face.points)) continue;

            // Check we're not inside a hole
            let inHole = false;
            if (face.holes && face.holes.length > 0) {
                for (const h of face.holes) {
                    if (isPointInPolyMeasurement(sx, sy, h)) { inHole = true; break; }
                }
            }
            if (inHole) continue;

            // Evaluate face plane height at the sample point
            const faceZ = plane.a * sx + plane.b * sy + plane.c;

            validSamples++;
            if (faceZ > lz + Z_RISE_TOLERANCE) {
                risingSamples++;
            }
            break; // found a valid step distance for this line sample, move on
        }
    }

    // If more than a third of valid samples show the face going UP, it rises
    if (validSamples === 0) return false;
    return (risingSamples / validSamples) > 0.33;
}

/**
 * Robust Occlusion Checker
 * Checks samples along line against ALL other faces (excluding owners).
 */
function checkLineOcclusion(p1, p2, ownerFaces, allFaces) {
    const { SAMPLE_COUNT, BUFFER_PERCENT, Z_TOLERANCE, COVERAGE_THRESHOLD } = OCCLUSION_SETTINGS;

    let coveredSamples = 0;
    
    for (let i = 0; i <= SAMPLE_COUNT; i++) {
        const rawT = i / SAMPLE_COUNT; 
        const t = BUFFER_PERCENT + (rawT * (1 - (BUFFER_PERCENT * 2)));

        const sx = p1.x + (p2.x - p1.x) * t;
        const sy = p1.y + (p2.y - p1.y) * t;
        const sz = (p1.z || 0) + ((p2.z || 0) - (p1.z || 0)) * t;

        let isSampleCovered = false;

        for (const candidate of allFaces) {
            // Owner Check: Is this candidate actually one of the line's owners?
            // Use Centroid check for robustness against object duplicates
            const isOwner = ownerFaces.some(owner => {
                if (owner === candidate) return true;
                
                let cx1=0, cy1=0, cx2=0, cy2=0;
                owner.points.forEach(p=>{cx1+=p.x; cy1+=p.y});
                candidate.points.forEach(p=>{cx2+=p.x; cy2+=p.y});
                // If centroids match closely, it's the same face
                return Math.abs(cx1-cx2)<0.1 && Math.abs(cy1-cy2)<0.1;
            });
            
            if (isOwner) continue;

            // 2D Inclusion
            if (isPointInPolyMeasurement(sx, sy, candidate.points)) {
                // Hole Check
                let inHole = false;
                if (candidate.holes && candidate.holes.length > 0) {
                    for (let h of candidate.holes) {
                        if (isPointInPolyMeasurement(sx, sy, h)) {
                            inHole = true;
                            break;
                        }
                    }
                }
                if (inHole) continue;

                // 3D Height Check
                let candidateZ = -Infinity;
                if (candidate.plane) {
                    candidateZ = candidate.plane.a * sx + candidate.plane.b * sy + candidate.plane.c;
                } else {
                    const p = fitPlaneLinearInternal(candidate.points);
                    candidateZ = p.a * sx + p.b * sy + p.c;
                }

                // Is candidate higher?
                if (candidateZ > (sz + Z_TOLERANCE)) {
                    isSampleCovered = true;
                    break;
                }
            }
        }

        if (isSampleCovered) {
            coveredSamples++;
        }
    }

    const coverageRatio = coveredSamples / (SAMPLE_COUNT + 1);
    return coverageRatio >= COVERAGE_THRESHOLD;
}

function isMeasurementOwnerFace(ownerFaces, candidate) {
    return (ownerFaces || []).some(owner => {
        if (owner === candidate) return true;
        if (!owner || !candidate || !Array.isArray(owner.points) || !Array.isArray(candidate.points)) return false;
        let cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0;
        owner.points.forEach(p => { cx1 += p.x; cy1 += p.y; });
        candidate.points.forEach(p => { cx2 += p.x; cy2 += p.y; });
        return Math.abs(cx1 - cx2) < 0.1 && Math.abs(cy1 - cy2) < 0.1;
    });
}

function isPointInsideOrOnMeasurementFace(x, y, face, eps = 0.75) {
    if (!face || !Array.isArray(face.points) || face.points.length < 3) return false;
    const insideOuter = isPointInPolyMeasurement(x, y, face.points) || getMinDistToPolySquared(x, y, face.points) <= eps * eps;
    if (!insideOuter) return false;
    if (face.holes && face.holes.length > 0) {
        for (const h of face.holes) {
            if (isPointInPolyMeasurement(x, y, h)) return false;
        }
    }
    return true;
}

function checkLineOnNonOwnerFace(p1, p2, ownerFaces, allFaces) {
    const { SAMPLE_COUNT, BUFFER_PERCENT, ON_FACE_Z_TOLERANCE, COVERAGE_THRESHOLD } = OCCLUSION_SETTINGS;
    if (!Array.isArray(allFaces) || !allFaces.length) return false;

    for (const candidate of allFaces) {
        if (isMeasurementOwnerFace(ownerFaces, candidate)) continue;
        if (!candidate || !Array.isArray(candidate.points) || candidate.points.length < 3) continue;

        const plane = candidate.plane || fitPlaneLinearInternal(candidate.points);
        if (!plane) continue;

        let onFaceSamples = 0;
        for (let i = 0; i <= SAMPLE_COUNT; i++) {
            const rawT = i / SAMPLE_COUNT;
            const t = BUFFER_PERCENT + (rawT * (1 - (BUFFER_PERCENT * 2)));
            const sx = p1.x + (p2.x - p1.x) * t;
            const sy = p1.y + (p2.y - p1.y) * t;
            if (!isPointInsideOrOnMeasurementFace(sx, sy, candidate)) continue;

            const lineZ = (p1.z || 0) + ((p2.z || 0) - (p1.z || 0)) * t;
            const candidateZ = plane.a * sx + plane.b * sy + plane.c;
            if (Math.abs(candidateZ - lineZ) <= ON_FACE_Z_TOLERANCE) {
                onFaceSamples++;
            }
        }

        if ((onFaceSamples / (SAMPLE_COUNT + 1)) >= COVERAGE_THRESHOLD) return true;
    }

    return false;
}




// --- Helper for the Distance Check (Add to measurements.js if not present) ---
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


















function calculateVentilationNeeds(materialReport, lines) {
    // 1. Determine NFVA Ratio (Default 300)
    let ratio = (typeof NFVA_RATIO !== 'undefined') ? NFVA_RATIO : 300;
    
    // Check for Organization Override
    if (typeof window.projectOrganization !== 'undefined' && 
        window.projectOrganization && 
        window.projectOrganization.report_settings && 
        window.projectOrganization.report_settings.nfva_ratio) {
        
        const orgRatio = parseInt(window.projectOrganization.report_settings.nfva_ratio);
        if (Number.isFinite(orgRatio) && orgRatio > 0) {
            ratio = orgRatio;
        }
    }

    // 2. Basic Area Math
    // Use ventilationSquares (>= 2/12 pitch) instead of totalSquares if available
    const applicableSquares = (typeof materialReport.ventilationSquares !== 'undefined') 
        ? materialReport.ventilationSquares 
        : materialReport.totalSquares;

    const atticArea = applicableSquares * 100;
    const reqVentSqFt = atticArea / ratio; // Use dynamic ratio
    const reqVentSqIn = reqVentSqFt * 144;
    
    // Balanced System (50/50)
    const reqExhaust = reqVentSqIn / 2;
    
    // 3. Check Ridge Capacity
    const ridgeLines = lines.filter(l => l.type === 'ridge');
    const totalRidgeLen = ridgeLines.reduce((sum, l) => sum + l.length, 0);
    const ridgeCapacity = totalRidgeLen * RIDGE_NFVA_PER_FT;

    let systemType = "Ridge Vent System";
    let boxVentsNeeded = 0;
    let deficit = 0;

    if (ridgeCapacity >= reqExhaust) {
        // Ridge is sufficient
        systemType = "Ridge Vent System (Sufficient)";
        deficit = 0;
        boxVentsNeeded = 0;
    } else {
        // Ridge is NOT sufficient
        systemType = "Box Vents Only (Ridge Insufficient)";
        deficit = reqExhaust; 
        boxVentsNeeded = Math.ceil(reqExhaust / BOX_VENT_NFVA);
    }

    return {
        reqExhaust,
        ridgeCapacity,
        totalRidgeLen,
        deficitSqIn: Math.round(deficit),
        boxVentsNeeded,
        systemType,
        applicableSquares,
        ratioUsed: ratio // Return the ratio used for UI/PDF display
    };
}

// --- 3. UI & INTERACTION FUNCTIONS ---

function enterMeasurementMode(count) { 
    isMeasurementMode = true;
    showLineTypes = true; 
    selectionMode = 'LINE'; 
    
    const btn = document.getElementById('btnToggleTypes');
    if(btn) {
        btn.classList.add('active');
        btn.style.background = '#e8f0fe';
        btn.style.color = '#1a73e8';
        btn.style.borderColor = '#1a73e8';
    }

    let panel = document.getElementById('measurement-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'measurement-panel';
        panel.style.cssText = `
            position: absolute; top: 60px; left: 10px; width: 170px;
            background: rgba(255,255,255,0.95); padding: 10px; border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2); z-index: 2000; font-family: sans-serif;
            max-height: 80vh; overflow-y: auto; border: 1px solid #ccc;
        `;
        document.getElementById('viewport').appendChild(panel);

        ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown'].forEach(evt => {
            panel.addEventListener(evt, (e) => e.stopPropagation());
        });
    }
    
    if (typeof count !== 'undefined' && count > 0) {
        ventPlacementCount = count;
        interactState = 'PLACING_VENTS';
        selectionMode = 'POINT';
    }

    updateMeasurementUI();
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
}

function exitMeasurementMode() {
    isMeasurementMode = false;
    showLineTypes = false;
    interactState = 'IDLE';
    
    const btn = document.getElementById('btnToggleTypes');
    if(btn) {
        btn.classList.remove('active');
        btn.style.background = '#fff';
        btn.style.color = '#5f6368';
        btn.style.borderColor = '#ccc';
    }

    const panel = document.getElementById('measurement-panel');
    if (panel) panel.remove();
    
    selectionMode = 'POINT';
    
    const lbl = document.getElementById('modeLabel');
    if(lbl) {
        lbl.textContent = 'POINT MODE';
        lbl.style.backgroundColor = "";
        lbl.style.color = "";
    }

    if (typeof renderGeometry2D === 'function') renderGeometry2D();
}

function updateMeasurementUI() {
    const panel = document.getElementById('measurement-panel');
    if (!panel) return;

    const report = lastRoofReport;
    if (!report) return;

    let html = `<h4 style="margin:0 0 10px 0; font-size:12px; border-bottom:1px solid #ccc; padding-bottom:5px; color:#333;">LINE TYPES</h4>`;
    
    Object.values(LINE_TYPES).forEach(t => {
        html += `
            <div onclick="setSelectionType('${t.id}')" style="
                display:flex; align-items:center; gap:8px; cursor:pointer; padding:5px; 
                font-size:11px; margin-bottom:2px; border-radius:4px;
                background: #f8f9fa; border: 1px solid #eee; transition: background 0.2s;
            " onmouseover="this.style.background='#e0e0e0'" onmouseout="this.style.background='#f8f9fa'">
                <div style="width:12px; height:12px; background:${t.color}; border-radius:2px; border:1px solid rgba(0,0,0,0.1);"></div>
                <span style="font-weight:500; color:#444;">${t.label}</span>
            </div>
        `;
    });

    const ventData = report.materials.ventilation;
    const existingCount = (activeGeometry.vents || []).length;
    const needed = ventData.boxVentsNeeded;
    const remaining = needed - existingCount;
    
    let badgeColor = '#4caf50'; 
    if (remaining > 0) badgeColor = '#d93025'; 
    else if (remaining < 0) badgeColor = '#f9ab00';

    const isPlacing = (typeof interactState !== 'undefined' && interactState === 'PLACING_VENTS');
    const btnBg = isPlacing ? '#e8f0fe' : '#fff';
    const btnBorder = isPlacing ? '#1a73e8' : '#ccc';

    html += `
        <div style="margin-top:15px; border-top:1px solid #ccc; padding-top:10px;">
            <h4 style="margin:0 0 5px 0; font-size:12px; color:#333;">VENTILATION</h4>
            <div style="font-size:10px; color:#666; margin-bottom:8px; line-height:1.2;">${ventData.systemType}</div>
            
            <div onclick="toggleVentPlacement(${remaining})" style="
                border:1px solid ${btnBorder}; background:${btnBg}; padding:8px; border-radius:4px; cursor:pointer; 
                text-align:center; transition:0.2s;
            ">
                <div style="font-weight:bold; font-size:12px; color:#1a73e8; margin-bottom:2px;">
                    <span style="font-size:16px;">?</span> Box Vents
                </div>
                <div style="font-size:10px; color:#555;">Required: ${needed}</div>
                <div style="font-size:10px; color:#555;">Placed: ${existingCount}</div>
                <div style="
                    margin-top:4px; font-weight:bold; font-size:11px; color:${badgeColor};
                    background:rgba(0,0,0,0.05); padding:2px 4px; border-radius:3px; display:inline-block;
                ">Remaining: ${remaining}</div>
            </div>
            <div style="font-size:9px; color:#888; margin-top:5px; text-align:center;">
                ${isPlacing ? 'Click map to place.' : 'Click box to add.'}
            </div>
        </div>
    `;

    panel.innerHTML = html;
}

function setSelectionType(typeId) {
    if (interactState === 'PLACING_VENTS') toggleVentPlacement(0); 

    if (selectedLines.size === 0) return;
    
    if (typeof save2DState === 'function') save2DState();
    selectedLines.forEach(conn => {
        conn.type = typeId;
        conn.manualType = true;
    });

    // Recalculate everything (including Vents) based on new types
    recalculateMeasurementData();

    updateMeasurementUI();
    if (typeof renderGeometry2D === 'function') renderGeometry2D();
}

function toggleVentPlacement(remaining) {
    if (interactState === 'PLACING_VENTS') {
        interactState = 'IDLE';
        if (typeof selectionMode !== 'undefined') selectionMode = 'LINE'; 
    } else {
        const count = remaining > 0 ? remaining : 99;
        if (typeof enterVentPlacementMode === 'function') {
            enterVentPlacementMode(count);
        }
    }
    updateMeasurementUI();
}

// --- 4. CLASSIFICATION & MATH HELPERS ---

function precalculateOcclusionPolys() {
    const layerPolys = {}; 
    for (let i = 2; i <= 6; i++) {
        if (typeof findAtomicCycles === 'function') {
            layerPolys[i] = findAtomicCycles(i);
        } else {
            layerPolys[i] = [];
        }
    }
    return layerPolys;
}

function detectSkylightsAndChimneys() {
    const skylightConns = new Set();
    const chimneyEdgeConns = new Set();
    const chimneyBackConns = new Set();  // Highest edge
    const chimneyFrontConns = new Set(); // Lowest edge
    
    const adj = new Map();

    // --- CONFIGURATION ---
    const CHIMNEY_HEIGHT_THRESHOLD = 0.5; // Meters above edge avg

    activeGeometry.points.forEach(p => adj.set(p, []));
    activeGeometry.connections.forEach(c => {
        adj.get(c.start).push(c.end);
        adj.get(c.end).push(c.start);
    });

    const visited = new Set();
    const components = [];

    // 1. Find Connected Components
    activeGeometry.points.forEach(startPt => {
        if (visited.has(startPt)) return;
        const componentPoints = [];
        const componentConns = [];
        const queue = [startPt];
        visited.add(startPt);

        while(queue.length > 0) {
            const u = queue.pop();
            componentPoints.push(u);
            const neighbors = adj.get(u);
            neighbors.forEach(v => {
                const conn = activeGeometry.connections.find(c => 
                    (c.start === u && c.end === v) || (c.start === v && c.end === u)
                );
                if (conn && !componentConns.includes(conn)) componentConns.push(conn);
                if (!visited.has(v)) {
                    visited.add(v);
                    queue.push(v);
                }
            });
        }
        components.push({ points: componentPoints, conns: componentConns });
    });

    // 2. Analyze Components
    const dsm = (typeof layerData !== 'undefined' && layerData.dsm) ? layerData.dsm[0] : null;
    const w = (typeof imageWidth !== 'undefined') ? imageWidth : 0;

    // Helper to get Z for a point (from point data or DSM)
    const getZ = (p) => {
        if (p.z !== null && p.z !== undefined) return p.z;
        if (dsm && w > 0) {
            const ix = Math.floor(p.x);
            const iy = Math.floor(p.y);
            if (ix >= 0 && ix < w && iy >= 0) {
                const val = dsm[iy * w + ix];
                if (val > -9000) return val;
            }
        }
        return 0; // fallback
    };
    const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
        (((window.getRadiusMeters ? window.getRadiusMeters() :
            (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imageWidth));
    const lineAngleDeg = (conn) => {
        const dx = ((conn.end.x || 0) - (conn.start.x || 0)) * metersPerPx;
        const dy = ((conn.end.y || 0) - (conn.start.y || 0)) * metersPerPx;
        const dz = getZ(conn.end) - getZ(conn.start);
        const lenXY = Math.hypot(dx, dy);
        return Math.atan2(Math.abs(dz), lenXY || 1e-9) * (180 / Math.PI);
    };
    const classifyChimneyLoopConn = (conn, compPoints) => {
        if (lineAngleDeg(conn) >= 10) return LINE_TYPES.CHIMNEY_EDGE.id;
        const ptsWithZ = compPoints.map(p => ({ ...p, z: getZ(p) }));
        const plane = fitPlaneLinearInternal(ptsWithZ);
        const slopeLen = plane ? Math.hypot(plane.a || 0, plane.b || 0) : 0;
        if (!(slopeLen > 1e-8)) return LINE_TYPES.CHIMNEY_EDGE.id;
        const roofUp = { x: plane.a / slopeLen, y: plane.b / slopeLen };
        const center = compPoints.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
        center.x /= compPoints.length;
        center.y /= compPoints.length;
        const mid = {
            x: ((conn.start.x || 0) + (conn.end.x || 0)) / 2,
            y: ((conn.start.y || 0) + (conn.end.y || 0)) / 2
        };
        const openingDir = { x: center.x - mid.x, y: center.y - mid.y };
        const openingIsUpslope = (openingDir.x * roofUp.x + openingDir.y * roofUp.y) > 0;
        return openingIsUpslope ? LINE_TYPES.CHIMNEY_FRONT.id : LINE_TYPES.CHIMNEY_BACK.id;
    };

    components.forEach(comp => {
        // Topology Check: Must be exactly 4 points and 4 connections (Simple Quad Loop)
        if (comp.points.length === 4 && comp.conns.length === 4) {
            const validTopology = comp.points.every(p => {
                const myConns = comp.conns.filter(c => c.start === p || c.end === p);
                return myConns.length === 2;
            });

            if (validTopology) {
                let isChimney = false;

                // Height Analysis
                if (dsm && w > 0) {
                    // A. Calculate Edge Average Z
                    let sumEdgeZ = 0;
                    comp.points.forEach(p => { sumEdgeZ += getZ(p); });
                    const avgEdgeZ = sumEdgeZ / 4;

                    // B. Calculate Interior Average Z
                    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
                    comp.points.forEach(p => { 
                        minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); 
                        minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); 
                    });

                    let sumIntZ = 0;
                    let countInt = 0;
                    const stride = 2; 

                    for(let y = Math.floor(minY); y <= Math.ceil(maxY); y += stride) {
                        for(let x = Math.floor(minX); x <= Math.ceil(maxX); x += stride) {
                            if (isPointInPolyMeasurement(x, y, comp.points)) {
                                const val = dsm[y * w + x];
                                if (val > -9000) {
                                    sumIntZ += val;
                                    countInt++;
                                }
                            }
                        }
                    }

                    if (countInt > 0) {
                        const avgIntZ = sumIntZ / countInt;
                        // C. Compare
                        if ((avgIntZ - avgEdgeZ) > CHIMNEY_HEIGHT_THRESHOLD) {
                            isChimney = true;
                        }
                    }
                }

                if (isChimney) {
                    comp.conns.forEach(c => {
                        const type = classifyChimneyLoopConn(c, comp.points);
                        if (type === LINE_TYPES.CHIMNEY_BACK.id) chimneyBackConns.add(c);
                        else if (type === LINE_TYPES.CHIMNEY_FRONT.id) chimneyFrontConns.add(c);
                        else chimneyEdgeConns.add(c);
                    });
                } else {
                    // It's a Skylight
                    comp.conns.forEach(c => skylightConns.add(c));
                }
            }
        }
    });

    return { 
        skylightConnections: skylightConns, 
        chimneyEdgeConnections: chimneyEdgeConns,
        chimneyBackConnections: chimneyBackConns,
        chimneyFrontConnections: chimneyFrontConns
    };
}

function toggleMeasurementMode() {
    if (isMeasurementMode) {
        exitMeasurementMode();
    } else {
        if (lastRoofReport) {
            enterMeasurementMode();
        } 
        else {
            handleGenerateMeasurements();
        }
    }
}



function checkIsValley(p1, p2, faceA, faceB, metersPerPx) {
    const localType = classifyHipValleyByLocalSlope(p1, p2, faceA, faceB, metersPerPx);
    if (localType) return localType === LINE_TYPES.VALLEY.id;

    const zTol = getHipValleyZTolerance(metersPerPx);
    const areaA = getPolygonArea(faceA.points);
    const areaB = getPolygonArea(faceB.points);
    let isDisproportionate = false;
    let bigFace, smallFace;

    if (areaA > areaB * 3.0) { isDisproportionate = true; bigFace = faceA; smallFace = faceB; } 
    else if (areaB > areaA * 3.0) { isDisproportionate = true; bigFace = faceB; smallFace = faceA; }

    if (isDisproportionate) {
        const bigPlane = fitPlaneLinearInternal(bigFace.points);
        const smallCentroid = getFaceCentroid(smallFace);
        const predZ = bigPlane.a * smallCentroid.x + bigPlane.b * smallCentroid.y + bigPlane.c;
        const diff = smallCentroid.z - predZ;
        return diff > zTol;
    } else {
        const planeA = fitPlaneLinearInternal(faceA.points);
        const planeB = fitPlaneLinearInternal(faceB.points);
        const cA = getFaceCentroid(faceA);
        const cB = getFaceCentroid(faceB);
        const predZ_onA = planeA.a * cB.x + planeA.b * cB.y + planeA.c;
        const diffB = cB.z - predZ_onA; 
        const predZ_onB = planeB.a * cA.x + planeB.b * cA.y + planeB.c;
        const diffA = cA.z - predZ_onB; 
        return (diffA + diffB) > (zTol * 2);
    }
}

function getHipValleyZTolerance(metersPerPx) {
    const pxScale = Number.isFinite(metersPerPx) && metersPerPx > 0 ? metersPerPx : 0.04;
    return Math.max(0.006, Math.min(0.025, pxScale * 0.2));
}

function getHipValleySlopeTolerance(metersPerPx) {
    return getHipValleyZTolerance(metersPerPx) / 6;
}

function classifyHipValleyByLocalSlope(p1, p2, faceA, faceB, metersPerPx) {
    const a = getLocalFaceHeightBehavior(p1, p2, faceA, metersPerPx);
    const b = getLocalFaceHeightBehavior(p1, p2, faceB, metersPerPx);
    if (!a || !b) return null;

    const slopeTol = getHipValleySlopeTolerance(metersPerPx);
    const aRises = a.meanRisePerPx > slopeTol && a.riseRatio >= 0.6;
    const bRises = b.meanRisePerPx > slopeTol && b.riseRatio >= 0.6;
    const aFalls = a.meanRisePerPx < -slopeTol && a.fallRatio >= 0.6;
    const bFalls = b.meanRisePerPx < -slopeTol && b.fallRatio >= 0.6;

    if (aRises && bRises) return LINE_TYPES.VALLEY.id;
    if (aFalls && bFalls) return LINE_TYPES.HIP.id;
    return null;
}

function getLocalFaceHeightBehavior(p1, p2, face, metersPerPx) {
    if (!face || !Array.isArray(face.points) || face.points.length < 3) return null;

    const plane = face.plane || fitPlaneLinearInternal(face.points);
    if (!plane) return null;

    const ldx = p2.x - p1.x;
    const ldy = p2.y - p1.y;
    const lineLen = Math.sqrt(ldx * ldx + ldy * ldy);
    if (lineLen < 1e-6) return null;

    const perpX = -ldy / lineLen;
    const perpY = ldx / lineLen;

    const samples = [0.2, 0.35, 0.5, 0.65, 0.8];
    const insideOffsetsPx = [0.5, 1, 2];
    const slopeTol = getHipValleySlopeTolerance(metersPerPx);
    let valid = 0;
    let rise = 0;
    let fall = 0;
    let sumRisePerPx = 0;

    const pointInsideFace = (x, y) => {
        if (!isPointInPolyMeasurement(x, y, face.points)) return false;
        if (face.holes && face.holes.length > 0) {
            for (const h of face.holes) {
                if (isPointInPolyMeasurement(x, y, h)) return false;
            }
        }
        return true;
    };

    for (const t of samples) {
        const lx = p1.x + ldx * t;
        const ly = p1.y + ldy * t;

        let inward = null;
        for (const offsetPx of insideOffsetsPx) {
            const plus = { x: lx + perpX * offsetPx, y: ly + perpY * offsetPx };
            const minus = { x: lx - perpX * offsetPx, y: ly - perpY * offsetPx };
            const plusInside = pointInsideFace(plus.x, plus.y);
            const minusInside = pointInsideFace(minus.x, minus.y);
            if (plusInside && !minusInside) {
                inward = { x: perpX, y: perpY };
                break;
            }
            if (minusInside && !plusInside) {
                inward = { x: -perpX, y: -perpY };
                break;
            }
            if (plusInside || minusInside) {
                inward = plusInside ? { x: perpX, y: perpY } : { x: -perpX, y: -perpY };
                break;
            }
        }
        if (!inward) continue;

        const risePerPx = (plane.a || 0) * inward.x + (plane.b || 0) * inward.y;
        valid++;
        sumRisePerPx += risePerPx;
        if (risePerPx > slopeTol) rise++;
        else if (risePerPx < -slopeTol) fall++;
    }

    if (!valid) return null;
    return {
        meanRisePerPx: sumRisePerPx / valid,
        riseRatio: rise / valid,
        fallRatio: fall / valid
    };
}

function getPolygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        area += (p1.x * p2.y - p2.x * p1.y);
    }
    return Math.abs(area / 2.0);
}

function fitPlaneLinearInternal(points) {
    if (typeof window.fitPlaneRANSAC === 'function') {
        const validPts = points.filter(p => p.z !== null);
        return window.fitPlaneRANSAC(validPts, 1, 99);
    }
    // Fallback logic
    let sumX=0, sumY=0, sumZ=0, sumXX=0, sumYY=0, sumXY=0, sumXZ=0, sumYZ=0;
    const validPts = points.filter(p => p.z !== null);
    const n = validPts.length;
    if(n<3) return {a:0,b:0,c:0};
    for(let i=0; i<n; i++){
        const p = validPts[i];
        sumX+=p.x; sumY+=p.y; sumZ+=p.z;
        sumXX+=p.x*p.x; sumYY+=p.y*p.y; sumXY+=p.x*p.y;
        sumXZ+=p.x*p.z; sumYZ+=p.y*p.z;
    }
    const det = n*sumXX*sumYY + 2*sumXY*sumX*sumY - sumX*sumX*sumYY - sumY*sumY*sumXX - n*sumXY*sumXY;
    if(Math.abs(det)<1e-9) return {a:0,b:0,c:0};
    const invDet = 1/det;
    const a = invDet * ((sumYY*n - sumY*sumY)*sumXZ + (sumY*sumX - sumXY*n)*sumYZ + (sumXY*sumY - sumYY*sumX)*sumZ);
    const b = invDet * ((sumY*sumX - sumXY*n)*sumXZ + (sumXX*n - sumX*sumX)*sumYZ + (sumXY*sumX - sumXX*sumY)*sumZ);
    const c = invDet * ((sumXY*sumY - sumYY*sumX)*sumXZ + (sumXY*sumX - sumXX*sumY)*sumYZ + (sumXX*sumYY - sumXY*sumXY)*sumZ);
    return {a,b,c};
}

function calculateMaterials(lines, facesSource) {
  const report = { linear: {}, squares: {}, totalSquares: 0, ventilationSquares: 0 };

  // 1. Linear Totals
  lines.forEach(item => {
    if (!report.linear[item.type]) report.linear[item.type] = 0;
    report.linear[item.type] += item.length;
  });

  // 2. Determine Faces Source
  let faces = facesSource;
  if (!faces) {
      if (window.lastResolvedFacesCache && Array.isArray(window.lastResolvedFacesCache)) {
          faces = window.lastResolvedFacesCache;
      } else if (typeof facesGroup !== 'undefined' && facesGroup) {
          faces = facesGroup.children
              .filter(m => m.userData && m.userData.faceDef)
              .map(m => m.userData.faceDef);
      } else {
          faces = [];
      }
  }

  // 3. Calculate Squares from Faces
  if (faces && faces.length > 0) {
    const metersPerPx = (window.getMetersPerPx ? window.getMetersPerPx() :
      (((window.getRadiusMeters ? window.getRadiusMeters() :
        (window.RADIUS_METERS || (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20))) * 2) / imageWidth));

    faces.forEach(face => {
      let areaPx = 0;
      const pts = face.points;

      // Outer Loop Area
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        areaPx += (p1.x * p2.y - p2.x * p1.y);
      }

      // Subtract Holes
      if (face.holes && Array.isArray(face.holes)) {
        face.holes.forEach(hole => {
          for (let i = 0; i < hole.length; i++) {
            const p1 = hole[i];
            const p2 = hole[(i + 1) % hole.length];
            areaPx -= (p1.x * p2.y - p2.x * p1.y);
          }
        });
      }

      areaPx = Math.abs(areaPx * 0.5);

      const areaM2_Flat = areaPx * (metersPerPx * metersPerPx);

      const plane = fitPlaneLinearInternal(face.points);
      const rawSlope = Math.sqrt(plane.a * plane.a + plane.b * plane.b);

      const pixelsPerMeter = 1 / metersPerPx;
      const realSlope = rawSlope * pixelsPerMeter;

      const pitchDeg = Math.atan(realSlope) * (180 / Math.PI);
      const rise = Math.tan(pitchDeg * (Math.PI / 180)) * 12;
      const riseRounded = Math.round(rise);
      const pitchLabel = `${riseRounded}/12`;

      const areaM2_Sloped = areaM2_Flat / Math.cos(pitchDeg * (Math.PI / 180));
      const areaSqFt = areaM2_Sloped * 10.7639;
      const squares = areaSqFt / 100;

      if (!report.squares[pitchLabel]) report.squares[pitchLabel] = 0;
      report.squares[pitchLabel] += squares;
      report.totalSquares += squares;

      if (riseRounded >= 2) report.ventilationSquares += squares;
    });
  }

  return report;
}



function getFaceCentroid(face) {
    let sumX=0, sumY=0, sumZ=0, count=0;
    face.points.forEach(p => { 
        sumX+=p.x; sumY+=p.y; 
        if(p.z!==null){sumZ+=p.z; count++;} 
    });
    return { x: sumX/face.points.length, y: sumY/face.points.length, z: count>0?sumZ/count:0 };
}

function getFaceCentroidZ(face) {
    return getFaceCentroid(face).z;
}

function isPointInPolyMeasurement(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}


// --- REPLACEMENT TOGGLE FUNCTION ---

function toggleLineTypes() {
    // 1. If currently ON, turn OFF.
    if (typeof isMeasurementMode !== 'undefined' && isMeasurementMode) {
        if (typeof exitMeasurementMode === 'function') {
            exitMeasurementMode();
        }
        return;
    }

    // 2. If currently OFF:
    
    // A. If we already have a report, just turn ON (Visualization only).
    // This avoids the heavy 'renderFinalPass' and 'recalculateMeasurementData'.
    if (typeof lastRoofReport !== 'undefined' && lastRoofReport) {
        if (typeof enterMeasurementMode === 'function') {
            enterMeasurementMode();
        }
    } 
    // B. If we have NO data (first run), generate it.
    else {
        if (typeof handleGenerateMeasurements === 'function') {
            handleGenerateMeasurements();
        }
    }
}


// Run classification + materials in the background.
// - Sets conn.type values.
// - DOES NOT open measurement panel.
// - DOES NOT enable type coloring.
window.generateMeasurementsSilent = function generateMeasurementsSilent(opts = {}) {
  const scopedOpts = opts || {};
  if (!scopedOpts.__structureScoped && typeof window.withStructureModeScope === 'function' && !window.__structureScopeApplying && !window.__structureModeForceAll) {
    return window.withStructureModeScope(() => generateMeasurementsSilent({
      ...scopedOpts,
      __structureScoped: true
    }));
  }
  const {
    forceFullFaceSolve = true, // run renderFinalPass(false) first for freshest faces
    refresh2D = false,         // set true if you want an immediate visual refresh (still no type colors)
    refresh3D = false
  } = scopedOpts;

  if (!activeGeometry || !activeGeometry.connections || !activeGeometry.connections.length) {
    console.warn("[generateMeasurementsSilent] No geometry/connections.");
    return false;
  }

  // Ensure UI is OFF (no panel, no type coloring)
  try {
    isMeasurementMode = false;
  } catch (e) {}
  try {
    showLineTypes = false;
  } catch (e) {}

  // Remove panel if it exists
  const panel = document.getElementById("measurement-panel");
  if (panel) panel.remove();

  // Optional: also keep measurement-length labels off
  // (your lengths are controlled by showMeasurementsLayer, not measurement mode)
  // showMeasurementsLayer = false;

  // Ensure we have good faces/planes first
  if (forceFullFaceSolve && typeof window.renderFinalPass === "function") {
    window.renderFinalPass(false);
  }

  // Reset inferred types so classification is guaranteed to recompute, but
  // preserve explicit sticker/manual chimney and protrusion lines.
  resetLineTypesForRegeneration();

  // Compute: fills lastRoofReport and assigns conn.type in sync step
  if (typeof recalculateMeasurementData === "function") {
    recalculateMeasurementData();
  } else {
    console.warn("[generateMeasurementsSilent] recalculateMeasurementData missing.");
    return false;
  }

  // Optional visuals (still not type-colored)
  if (refresh3D && typeof window.renderGeometry3D === "function") window.renderGeometry3D();
  if (refresh2D && typeof window.renderGeometry2D === "function") window.renderGeometry2D();

  return true;
};
