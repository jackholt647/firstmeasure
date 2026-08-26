

function processGeometryImage(img, targetW, targetH, params) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
        const r = data[i], g = data[i+1], b = data[i+2];
        if (b > 60 && b > (r + blueSensitivity) && b > (g + blueSensitivity)) {
            binaryMap[i / 4] = 1;
        }
    }

    for (let p = 0; p < erosionPasses; p++) binaryMap = erode(binaryMap, w, h);
    const originalDots = findBlobs(binaryMap, w, h);
    const primaryConnections = findRedConnections(originalDots, data, w, h, redThreshold);

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

        allConnections = allConnections.map(conn => ({
            start: getWelded(conn.start.x, conn.start.y),
            end:   getWelded(conn.end.x, conn.end.y)
        }));
        
        allPoints = weldedPoints;
    } else {
        allPoints.forEach(p => {
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
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    if (dist < 5) return false; 
    
    const sampleCount = Math.max(1, Math.floor(dist / stepSize));

    for (let k = 1; k <= sampleCount; k++) {
        const t = k / (sampleCount + 1);
        const sampleX = Math.floor(p1.x + (p2.x - p1.x) * t);
        const sampleY = Math.floor(p1.y + (p2.y - p1.y) * t);
        if (!isClusterRed(sampleX, sampleY, pixelData, w, h, threshold)) return false; 
    }
    return true; 
}

function isClusterRed(x, y, data, w, h, threshold) {
    let rSum=0, gSum=0, bSum=0, count=0;
    for(let dy=-1; dy<=1; dy++){
        for(let dx=-1; dx<=1; dx++){
            const px = x+dx, py = y+dy;
            if(px>=0 && px<w && py>=0 && py<h){
                const i = (py*w+px)*4;
                rSum+=data[i]; gSum+=data[i+1]; bSum+=data[i+2];
                count++;
            }
        }
    }
    if(count===0) return false;
    const r=rSum/count, g=gSum/count, b=bSum/count;
    return (r > 60 && r > (g + threshold) && r > (b + threshold));
}

function erode(inputMap, width, height) {
    const outputMap = new Uint8Array(inputMap.length);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (inputMap[i] === 1) {
                const up=inputMap[i-width], down=inputMap[i+width], left=inputMap[i-1], right=inputMap[i+1];
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
    let sumX = 0, sumY = 0, count = 0;
    visited[startY * w + startX] = 1;
    let qIdx = 0;
    while(qIdx < queue.length) {
        const cx = queue[qIdx++];
        const cy = queue[qIdx++];
        sumX += cx; sumY += cy; count++;
        
        const neighbors = [[cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]];
        for(let n of neighbors) {
            const nx = n[0], ny = n[1];
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
    // CHECK: If DSM is missing (should be handled by fake DSM, but double check)
    if (!dsm) {
        geometryObj.points.forEach(p => {
            // Use 0.1 to sit slightly above the image plane
            if (p.z === null || p.z === undefined) p.z = 0.1;
            p.zVotes = [];
        });
        return;
    }

    geometryObj.points.forEach(p => {
        p.zVotes = []; 
        p.z = null;
    });

    geometryObj.connections.forEach(conn => {
        const samples = sampleLineOnDSM(conn.start, conn.end, dsm, w, h);
        const validSamples = samples.filter(s => s.z > -9000);
        
        if (validSamples.length > 5) {
            const { slope, intercept } = linearRegression(validSamples);
            const len = Math.hypot(conn.end.x - conn.start.x, conn.end.y - conn.start.y);
            const zStart = intercept;
            const zEnd = (slope * len) + intercept;

            conn.start.zVotes.push(zStart);
            conn.end.zVotes.push(zEnd);
        } else {
            const z1 = getZAtXY(conn.start.x, conn.start.y, dsm, w, h);
            const z2 = getZAtXY(conn.end.x, conn.end.y, dsm, w, h);
            if (z1 > -9000) conn.start.zVotes.push(z1);
            if (z2 > -9000) conn.end.zVotes.push(z2);
        }
    });

    geometryObj.points.forEach(p => {
        if (p.zLocked) return;
        if (p.zVotes.length > 0) {
            const sum = p.zVotes.reduce((a, b) => a + b, 0);
            p.z = sum / p.zVotes.length;
        } else {
            const rawZ = getZAtXY(p.x, p.y, dsm, w, h);
            const fallback = (typeof dsmMin !== 'undefined') ? dsmMin : 0.1;
            // Use 0.1 if rawZ is invalid (-9000)
            p.z = (rawZ > -9000) ? rawZ : fallback;
        }
    });
}


function getZAtXY(x, y, dsm, w, h) {
    const ix = Math.max(0, Math.min(w-1, Math.round(x)));
    const iy = Math.max(0, Math.min(h-1, Math.round(y)));
    return dsm[iy * w + ix];
}

function sampleLineOnDSM(p1, p2, dsm, w, h) {
    const samples = [];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
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
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = data.length;
    for (let i = 0; i < n; i++) {
        sumX += data[i].d;
        sumY += data[i].z;
        sumXY += (data[i].d * data[i].z);
        sumXX += (data[i].d * data[i].d);
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}


function detectStructures(points, connections, faces) {
    if (!points || !connections) return [];

    const adj = new Map();
    const ptToId = (p) => `${Math.round(p.x*10)},${Math.round(p.y*10)}`;
    const idToPt = new Map();

    // 1. Build Adjacency Graph based on connecting points (Touching)
    points.forEach(p => {
        const id = ptToId(p);
        idToPt.set(id, p);
        adj.set(id, []);
    });

    connections.forEach(conn => {
        const id1 = ptToId(conn.start);
        const id2 = ptToId(conn.end);
        if (adj.has(id1)) adj.get(id1).push(id2);
        if (adj.has(id2)) adj.get(id2).push(id1);
    });

    // 2. Find Connected Components
    const clusters = [];
    const visited = new Set();

    points.forEach(p => {
        const startId = ptToId(p);
        if (visited.has(startId)) return;

        const clusterPts = new Set();
        const queue = [startId];
        visited.add(startId);

        while (queue.length > 0) {
            const currId = queue.pop();
            clusterPts.add(currId);
            const neighbors = adj.get(currId) || [];
            neighbors.forEach(nId => {
                if (!visited.has(nId)) {
                    visited.add(nId);
                    queue.push(nId);
                }
            });
        }
        clusters.push(clusterPts);
    });

    // 3. Map Clusters to Objects
    let structures = clusters.map(cSet => {
        const cPoints = Array.from(cSet).map(id => idToPt.get(id));
        
        // Find lines in this cluster
        const cLines = connections.filter(conn => 
            cSet.has(ptToId(conn.start)) || cSet.has(ptToId(conn.end))
        );

        // Find faces in this cluster (if all points of face are in cluster)
        const cFaces = (faces || []).filter(f => 
            f.points.every(p => cSet.has(ptToId(p)))
        );

        return {
            points: cPoints,
            lines: cLines,
            faces: cFaces,
            bounds: getBounds(cPoints)
        };
    }).filter(s => s.lines.length > 0);

    // 4. Merge Overlapping Structures (2D Overlap without touching)
    if (structures.length > 1) {
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < structures.length; i++) {
                for (let j = i + 1; j < structures.length; j++) {
                    const s1 = structures[i];
                    const s2 = structures[j];

                    // Check bounds overlap first
                    if (!boundsOverlap(s1.bounds, s2.bounds)) continue;

                    // Check Polygon Intersection
                    let overlap = false;
                    for (const f1 of s1.faces) {
                        for (const f2 of s2.faces) {
                            if (polygonsIntersect(f1.points, f2.points)) {
                                overlap = true; break;
                            }
                        }
                        if (overlap) break;
                    }

                    if (overlap) {
                        // Merge s2 into s1
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

    // 5. Assign IDs and filter small noise
    return structures
        .filter(s => s.faces.length > 0 || s.lines.length > 4) // Filter stray lines
        .map((s, i) => ({ ...s, id: i + 1 }));
}

function getBounds(points) {
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    points.forEach(p => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    return { minX, maxX, minY, maxY, width: maxX-minX, height: maxY-minY };
}

function boundsOverlap(b1, b2) {
    return !(b1.maxX < b2.minX || b1.minX > b2.maxX || b1.maxY < b2.minY || b1.minY > b2.maxY);
}

function polygonsIntersect(polyA, polyB) {
    // 1. Point in Poly (A in B)
    for (let p of polyA) { if (isPointInPolyStruct(p.x, p.y, polyB)) return true; }
    // 2. Point in Poly (B in A)
    for (let p of polyB) { if (isPointInPolyStruct(p.x, p.y, polyA)) return true; }
    // 3. Edge Intersection
    for(let i=0; i<polyA.length; i++) {
        const a1 = polyA[i], a2 = polyA[(i+1)%polyA.length];
        for(let j=0; j<polyB.length; j++) {
            const b1 = polyB[j], b2 = polyB[(j+1)%polyB.length];
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

function isPointInPolyStruct(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function segmentsIntersect(a, b, c, d) {
    const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return (ccw(a, c, d) !== ccw(b, c, d)) && (ccw(a, b, c) !== ccw(a, b, d));
}


function getEffectiveStructures(rawStructures, settings) {
    // If no settings exist yet, return raw list (clone it to be safe)
    if (!settings) {
        return rawStructures.map(s => ({
            ...s,
            points: [...s.points],
            lines: [...s.lines],
            faces: [...s.faces],
            bounds: {...s.bounds},
            originalIds: [s.id]
        }));
    }

    // 1. Create a map of deep clones
    let map = new Map();
    rawStructures.forEach(s => {
        map.set(s.id, {
            ...s,
            points: [...s.points],
            lines: [...s.lines],
            faces: [...s.faces],
            bounds: {...s.bounds},
            originalIds: [s.id]
        });
    });

    const toRemove = new Set();

    // 2. Process Merges
    // Iterate raw structures to see if they move into another
    rawStructures.forEach(s => {
        const conf = settings[s.id];
        if (conf && conf.mergeTarget) {
            const targetId = parseInt(conf.mergeTarget);
            // Prevent self-merge or circular logic simply by checking existence
            if (targetId !== s.id && map.has(targetId)) {
                const target = map.get(targetId);
                const source = map.get(s.id);
                
                // Merge source geometry into target
                target.points.push(...source.points);
                target.lines.push(...source.lines);
                target.faces.push(...source.faces);
                target.originalIds.push(...source.originalIds);

                // Update Bounds
                target.bounds.minX = Math.min(target.bounds.minX, source.bounds.minX);
                target.bounds.minY = Math.min(target.bounds.minY, source.bounds.minY);
                target.bounds.maxX = Math.max(target.bounds.maxX, source.bounds.maxX);
                target.bounds.maxY = Math.max(target.bounds.maxY, source.bounds.maxY);
                target.bounds.width = target.bounds.maxX - target.bounds.minX;
                target.bounds.height = target.bounds.maxY - target.bounds.minY;

                toRemove.add(s.id);
            }
        }
    });

    // 3. Filter Hidden & Removed
    let result = [];
    map.forEach((s, id) => {
        if (toRemove.has(id)) return; // Was merged into someone else
        const conf = settings[id];
        if (conf && conf.hidden) return; // Explicitly hidden
        result.push(s);
    });

    // Sort by ID for consistent order
    result.sort((a,b) => a.id - b.id);
    return result;
}


/**
 * GEOMETRY CORE - DRAPE & MERGE ALGORITHM
 */

const ROOF_ENGINE_CONFIG = {
    GRID_RESOLUTION: 4,         // Pixels between grid points (Lower = more detail, Higher = faster)
    ANGLE_TOLERANCE: 0.995,      // Cosine similarity (approx 11°). Higher = stricter merging.
    MIN_CLUSTER_SIZE: 10,       // Minimum number of triangles to form a face
    COLLINEAR_EPSILON: 0.15,    // Max distance for a point to be considered on a line
};

/**
 * Reconstructs a roof face by draping a triangle mesh over the DSM,
 * clustering similar triangles, and merging them into simplified polygons.
 */
function reconstructConnectedRoof(startX, startY, dsm, w, h) {
    const step = ROOF_ENGINE_CONFIG.GRID_RESOLUTION;
    
    // --- STEP 1 & 2: DRAPE GRID & ASSIGN HEIGHTS ---
    // We create a grid of vertices corresponding to the DSM
    const vertices = [];
    const gridW = Math.ceil(w / step);
    const gridH = Math.ceil(h / step);

    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const px = Math.min(gx * step, w - 1);
            const py = Math.min(gy * step, h - 1);
            const pz = dsm[py * w + px];
            vertices.push({ x: px, y: py, z: pz });
        }
    }

    // --- STEP 3: GENERATE TRIANGLES & NORMALS ---
    const triangles = [];
    for (let gy = 0; gy < gridH - 1; gy++) {
        for (let gx = 0; gx < gridW - 1; gx++) {
            const i0 = gy * gridW + gx;
            const i1 = gy * gridW + (gx + 1);
            const i2 = (gy + 1) * gridW + gx;
            const i3 = (gy + 1) * gridW + (gx + 1);

            // Triangle 1
            const t1 = createTriangle(vertices[i0], vertices[i1], vertices[i2]);
            if (t1) triangles.push(t1);

            // Triangle 2
            const t2 = createTriangle(vertices[i1], vertices[i3], vertices[i2]);
            if (t2) triangles.push(t2);
        }
    }

    // --- STEP 4: CLUSTERING ---
    // Find the triangle containing the start coordinates to seed the cluster
    const seedIdx = triangles.findIndex(t => isPointInTriangle2D({ x: startX, y: startY }, t.v1, t.v2, t.v3));
    if (seedIdx === -1) return [];

    const visited = new Uint8Array(triangles.length);
    const cluster = [];
    const queue = [seedIdx];
    visited[seedIdx] = 1;

    const seedNormal = triangles[seedIdx].normal;

    while (queue.length > 0) {
        const currIdx = queue.shift();
        const curr = triangles[currIdx];
        cluster.push(curr);

        // Find neighbors (triangles sharing at least 2 vertices)
        for (let i = 0; i < triangles.length; i++) {
            if (visited[i]) continue;
            const other = triangles[i];

            // Check if normals are similar
            const dot = curr.normal.x * other.normal.x + curr.normal.y * other.normal.y + curr.normal.z * other.normal.z;
            
            if (dot > ROOF_ENGINE_CONFIG.ANGLE_TOLERANCE) {
                // Check if they touch
                if (countSharedVertices(curr, other) >= 2) {
                    visited[i] = 1;
                    queue.push(i);
                }
            }
        }
    }

    if (cluster.length < ROOF_ENGINE_CONFIG.MIN_CLUSTER_SIZE) return [];

    // --- STEP 5: MERGE INTO POLYGON & EXTRACT BOUNDARY ---
    // Extract edges that are only used once (the boundary)
    const edgeCounts = new Map();
    cluster.forEach(t => {
        const edges = [
            sortEdge(t.v1, t.v2),
            sortEdge(t.v2, t.v3),
            sortEdge(t.v3, t.v1)
        ];
        edges.forEach(e => {
            edgeCounts.set(e, (edgeCounts.get(e) || 0) + 1);
        });
    });

    const boundaryEdges = [];
    edgeCounts.forEach((count, key) => {
        if (count === 1) {
            const parts = key.split('|').map(p => p.split(',').map(Number));
            boundaryEdges.push({ a: { x: parts[0][0], y: parts[0][1] }, b: { x: parts[1][0], y: parts[1][1] } });
        }
    });

    // Sort edges into a connected loop
    let orderedPoints = orderBoundary(boundaryEdges);

    // --- STEP 6: CLEANUP COLLINEAR POINTS ---
    // If three points form a straight line, remove the middle one
    orderedPoints = simplifyCollinear(orderedPoints, ROOF_ENGINE_CONFIG.COLLINEAR_EPSILON);

    // Calculate plane for the resulting face
    const finalPlane = fitPlaneLinear(cluster.map(t => ({ x: t.v1.x, y: t.v1.y, z: t.v1.z })));

    return [{
        points: orderedPoints,
        plane: finalPlane,
        layer: 1
    }];
}

/** 
 * HELPER FUNCTIONS
 */

function createTriangle(v1, v2, v3) {
    if (v1.z < -9000 || v2.z < -9000 || v3.z < -9000) return null;

    // Calculate Normal
    const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
    const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
    
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    
    const mag = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (mag === 0) return null;

    return { v1, v2, v3, normal: { x: nx/mag, y: ny/mag, z: nz/mag } };
}

function sortEdge(p1, p2) {
    const s1 = `${p1.x},${p1.y}`, s2 = `${p2.x},${p2.y}`;
    return s1 < s2 ? `${s1}|${s2}` : `${s2}|${s1}`;
}

function countSharedVertices(t1, t2) {
    let count = 0;
    const pts1 = [t1.v1, t1.v2, t1.v3];
    const pts2 = [t2.v1, t2.v2, t2.v3];
    pts1.forEach(p1 => {
        if (pts2.some(p2 => p1.x === p2.x && p1.y === p2.y)) count++;
    });
    return count;
}

function orderBoundary(edges) {
    if (edges.length === 0) return [];
    const points = [];
    let curr = edges[0].a;
    points.push(curr);
    
    const usedIndices = new Set([0]);
    
    for (let i = 0; i < edges.length; i++) {
        let found = false;
        for (let j = 0; j < edges.length; j++) {
            if (usedIndices.has(j)) continue;
            const e = edges[j];
            if (e.a.x === curr.x && e.a.y === curr.y) {
                curr = e.b; found = true;
            } else if (e.b.x === curr.x && e.b.y === curr.y) {
                curr = e.a; found = true;
            }
            if (found) {
                points.push(curr);
                usedIndices.add(j);
                break;
            }
        }
        if (!found) break;
    }
    return points;
}

function simplifyCollinear(points, epsilon) {
    if (points.length < 3) return points;
    const result = [points[0]];
    
    for (let i = 1; i < points.length; i++) {
        const prev = result[result.length - 1];
        const next = points[(i + 1) % points.length];
        const curr = points[i];

        // Vector Area / Cross Product method to check for straight line
        const area = Math.abs(prev.x * (curr.y - next.y) + curr.x * (next.y - prev.y) + next.x * (prev.y - curr.y));
        
        if (area > epsilon * 10) { // If not a straight line, keep the point
            result.push(curr);
        }
    }
    return result;
}

function isPointInTriangle2D(p, a, b, c) {
    const area = 0.5 * (-b.y * c.x + a.y * (-b.x + c.x) + a.x * (b.y - c.y) + b.x * c.y);
    const s = 1 / (2 * area) * (a.y * c.x - a.x * c.y + (c.y - a.y) * p.x + (a.x - c.x) * p.y);
    const t = 1 / (2 * area) * (a.x * b.y - a.y * b.x + (a.y - b.y) * p.x + (b.x - a.x) * p.y);
    return s > 0 && t > 0 && (1 - s - t) > 0;
}