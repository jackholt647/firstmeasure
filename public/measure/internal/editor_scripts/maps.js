/* maps.js */

const DEFAULT_APPLE_MAPS_TILE_VERSION = 10401;
let appleMapsTileVersion = DEFAULT_APPLE_MAPS_TILE_VERSION;

function setAppleMapsTileVersion(value) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
        appleMapsTileVersion = parsed;
    }
    return appleMapsTileVersion;
}

if (typeof window !== 'undefined') {
    setAppleMapsTileVersion(window.APPLE_MAPS_TILE_VERSION);
    window.setAppleMapsTileVersion = setAppleMapsTileVersion;
}

async function fetchStitchedAppleTile(lat, lon, radius = 1, zoom = 20, accessKey) {
    console.log(`[AppleMaps] Starting fetch. Lat: ${lat}, Lon: ${lon}, Radius: ${radius}, Zoom: ${zoom}`);
    
    const TILE_SIZE = 256; 
    
    // 1. Calculate Center Tile and Grid Bounds
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    
    // Calculate exact global pixel coordinates
    const globalX = ((lon + 180) / 360) * n * TILE_SIZE;
    const globalY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;

    // Calculate the tile index (integer)
    const centerX = Math.floor(globalX / TILE_SIZE);
    const centerY = Math.floor(globalY / TILE_SIZE);

    // Calculate the pixel offset within the center tile
    // This tells us how far off-center the specific lat/lon is from the middle of the tile
    const pixelInTileX = globalX - (centerX * TILE_SIZE);
    const pixelInTileY = globalY - (centerY * TILE_SIZE);

    // The canvas center is (TILE_SIZE / 2). We need the offset from that center.
    const calculatedOffsetX = pixelInTileX - (TILE_SIZE / 2);
    const calculatedOffsetY = pixelInTileY - (TILE_SIZE / 2);

    console.log(`[AppleMaps] Calculated Alignment Offset: X=${calculatedOffsetX.toFixed(2)}, Y=${calculatedOffsetY.toFixed(2)}`);

    const minX = centerX - radius;
    const maxX = centerX + radius;
    const minY = centerY - radius;
    const maxY = centerY + radius;

    // Calculate total canvas dimensions
    const tilesAcross = (radius * 2) + 1;
    const totalWidth = tilesAcross * TILE_SIZE;
    const totalHeight = tilesAcross * TILE_SIZE;

    // 2. Create the Canvas
    const canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    // 3. Create a list of download tasks
    const tasks = [];

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            tasks.push(async () => {
                const url = `https://sat-cdn.apple-mapkit.com/tile?style=7&size=1&scale=1&z=${zoom}&x=${x}&y=${y}&v=${appleMapsTileVersion}&accessKey=${accessKey}`;

                try {
                    const res = await fetch(url);
                    
                    if (res.status === 401 || res.status === 403) {
                        throw new Error("ACCESS_DENIED");
                    }
                    
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    
                    const blob = await res.blob();
                    const imgBitmap = await createImageBitmap(blob);
                    
                    return { img: imgBitmap, x: x, y: y };
                } catch (err) {
                    if (err.message === "ACCESS_DENIED") throw err;
                    console.warn(`[AppleMaps] Failed tile x=${x} y=${y}`, err);
                    return null; 
                }
            });
        }
    }

    console.log("[AppleMaps] Fetching tiles in parallel...");
    
    try {
        const results = await Promise.all(tasks.map(task => task()));

        // 4. Draw images to canvas
        results.forEach(item => {
            if (item) {
                const drawX = (item.x - minX) * TILE_SIZE;
                const drawY = (item.y - minY) * TILE_SIZE;
                ctx.drawImage(item.img, drawX, drawY);
            }
        });

        console.log("[AppleMaps] Stitching complete.");
        
        // Return object containing the canvas AND the calculated offsets
        return {
            canvas: canvas,
            offX: calculatedOffsetX,
            offY: calculatedOffsetY
        };

    } catch (error) {
        if (error.message === "ACCESS_DENIED") {
            console.error("[AppleMaps] Access Key Invalid or Expired.");
            throw error;
        }
        console.error("[AppleMaps] General Error:", error);
        return null;
    }
}



async function downloadStitchedAppleTile(lat, lon, radius = 1, zoom = 22, accessKey) {
    const TILE_SIZE = 256; // Standard Web Mercator tile size
    
    // 1. Calculate Center Tile and Grid Bounds
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const centerX = Math.floor(((lon + 180) / 360) * n);
    const centerY = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    );

    const minX = centerX - radius;
    const maxX = centerX + radius;
    const minY = centerY - radius;
    const maxY = centerY + radius;

    // Calculate total canvas dimensions
    const tilesAcross = (radius * 2) + 1;
    const totalWidth = tilesAcross * TILE_SIZE;
    const totalHeight = tilesAcross * TILE_SIZE;

    console.log(`Grid: ${tilesAcross}x${tilesAcross} tiles`);
    console.log(`Resolution: ${totalWidth}x${totalHeight} pixels`);

    // 2. Create the Canvas
    const canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    // 3. Create a list of download tasks
    const tasks = [];

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            tasks.push(async () => {
                // Access key (Note: This key expires and must be updated regularly)
                const url = `https://sat-cdn.apple-mapkit.com/tile?style=7&size=1&scale=1&z=${zoom}&x=${x}&y=${y}&v=${appleMapsTileVersion}&accessKey=${accessKey}`;

                try {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const blob = await res.blob();
                    
                    // Convert Blob to ImageBitmap for drawing
                    const imgBitmap = await createImageBitmap(blob);
                    
                    return {
                        img: imgBitmap,
                        x: x,
                        y: y
                    };
                } catch (err) {
                    console.error(`Failed tile x=${x} y=${y}`, err);
                    return null; // Return null on failure so we can skip it
                }
            });
        }
    }

    console.log("Downloading tiles...");
    
    // Execute all downloads in parallel
    const results = await Promise.all(tasks.map(task => task()));

    // 4. Draw images to canvas
    results.forEach(item => {
        if (item) {
            // Calculate pixel position on canvas
            // (x - minX) normalizes the coordinate to start at 0
            const drawX = (item.x - minX) * TILE_SIZE;
            const drawY = (item.y - minY) * TILE_SIZE;
            
            ctx.drawImage(item.img, drawX, drawY);
        }
    });

    // 5. Export Canvas to File
    canvas.toBlob((blob) => {
        if (!blob) {
            console.error("Canvas to Blob failed");
            return;
        }
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `stitched_sat_lat${lat}_lon${lon}_z${zoom}_r${radius}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
        console.log("Stitched image downloaded!");
    }, 'image/jpeg', 0.9); // Quality 0.9
}



// --- NEW: meters-per-pixel for WebMercator at given zoom/lat ---
function webMercatorMetersPerPixel(lat, zoom) {
  // Equator resolution (m/px) at z=0 for 256px tiles:
  // 2*pi*R / 256  where R=6378137 => ~156543.03392804097
  const R0 = 156543.03392804097;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return (R0 * cosLat) / Math.pow(2, zoom);
}

// --- NEW: current Solar ground-truth meters-per-pixel ---
function getSolarMetersPerPixel() {
  const rad = (Number.isFinite(window.RADIUS_METERS) ? window.RADIUS_METERS : (typeof RADIUS_METERS !== 'undefined' ? RADIUS_METERS : 20));
  const w = (typeof imageWidth !== 'undefined' && imageWidth > 0) ? imageWidth : 1;
  return (rad * 2) / w;
}

// --- NEW: set a layer's base scale so it matches Solar's meters/px (fineScale remains "user tweak") ---
function setLayerScaleToMatchSolar(layerId, providerZoom) {
  const cfg = ensureLayerCfg(layerId);
  if (!Number.isFinite(providerZoom)) return cfg;

  cfg.__zoom = providerZoom; // remember for later re-scaling after regenerate

  const solarMpp = getSolarMetersPerPixel();
  const provMpp = webMercatorMetersPerPixel(mapCenterLat, providerZoom);

  // drawScaledImage: effScale = scale * fineScale
  // To match ground area: effScale ~= provMpp / solarMpp
  const desiredEffScale = provMpp / solarMpp;

  // Keep fineScale as user tweak; set base scale to the computed "truth"
  const fine = Number.isFinite(cfg.fineScale) ? cfg.fineScale : 1.0;
  cfg.scale = desiredEffScale / fine;

  return cfg;
}

// --- NEW: recompute all known layer scales after Solar radius/width changes ---
function rescaleAllProviderLayersToSolar() {
  ['google', 'azure', 'apple'].forEach(id => {
    const cfg = ensureLayerCfg(id);
    const z = cfg.__zoom;
    if (Number.isFinite(z)) setLayerScaleToMatchSolar(id, z);
  });
}


// --- Shared WebMercator helpers ---
function wmGlobalPixel(lat, lon, zoom, tileSize = 256) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const globalX = ((lon + 180) / 360) * n * tileSize;
  const globalY =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * tileSize;
  return { globalX, globalY, n };
}

async function stitchTiles({ lat, lon, radius, zoom, tileSize, fetchTile }) {
  const { globalX, globalY } = wmGlobalPixel(lat, lon, zoom, tileSize);

  const centerX = Math.floor(globalX / tileSize);
  const centerY = Math.floor(globalY / tileSize);

  const pixelInTileX = globalX - centerX * tileSize;
  const pixelInTileY = globalY - centerY * tileSize;

  const offX = pixelInTileX - tileSize / 2;
  const offY = pixelInTileY - tileSize / 2;

  const minX = centerX - radius;
  const maxX = centerX + radius;
  const minY = centerY - radius;
  const maxY = centerY + radius;

  const tilesAcross = radius * 2 + 1;
  const canvas = document.createElement("canvas");
  canvas.width = tilesAcross * tileSize;
  canvas.height = tilesAcross * tileSize;
  const ctx = canvas.getContext("2d");

  const tasks = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tasks.push(
        (async () => {
          const img = await fetchTile(x, y, zoom);
          if (!img) return null;
          return { img, x, y };
        })()
      );
    }
  }

  const results = await Promise.all(tasks);
  results.forEach((item) => {
    if (!item) return;
    const drawX = (item.x - minX) * tileSize;
    const drawY = (item.y - minY) * tileSize;
    ctx.drawImage(item.img, drawX, drawY);
  });

  return { canvas, offX, offY };
}

// --- GOOGLE TILE STITCHER (XYZ tiles) ---
async function fetchStitchedGoogleTile(lat, lon, radius = 1, zoom = 20, apiKey) {
  const TILE_SIZE = 256;
  let googleSuccessCount = 0;

  const fetchTile = async (x, y, z) => {
    // NOTE: this endpoint is commonly used; if it 403s in your project,
    // switch to another Google tile endpoint or use a Maps tile service you have enabled.
    const url = `https://mt1.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      googleSuccessCount += 1;
      return await createImageBitmap(blob);
    } catch (e) {
      console.warn("[GoogleTiles] tile fail", x, y, z, e);
      return null;
    }
  };

  const stitched = await stitchTiles({
    lat,
    lon,
    radius,
    zoom,
    tileSize: TILE_SIZE,
    fetchTile
  });

  if (googleSuccessCount === 0) {
    throw new Error(`Google tile fetch failed at zoom ${zoom}. No imagery tiles were returned.`);
  }

  stitched.zoom = zoom;
  return stitched;
}

// --- AZURE/BING TILE STITCHER (quadkey tiles) ---
function tileXYToQuadKey(x, y, zoom) {
  let quadKey = "";
  for (let i = zoom; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit++;
    if ((y & mask) !== 0) digit += 2;
    quadKey += digit.toString();
  }
  return quadKey;
}

async function fetchStitchedAzureTile(lat, lon, radius = 1, zoom = 20, subscriptionKey) {
  const TILE_SIZE = 256;
  let azureSuccessCount = 0;
  let azureLastFailure = null;

  const fetchTile = async (x, y, z) => {
    const quad = tileXYToQuadKey(x, y, z);

    // Azure Maps imagery tile endpoint (roadmap differs; we want imagery)
    // Docs vary by version; this is the common imagery tile pattern.
    const url =
      `https://atlas.microsoft.com/map/tile` +
      `?api-version=2024-04-01` +
      `&tilesetId=microsoft.imagery` +
      `&zoom=${z}` +
      `&x=${x}` +
      `&y=${y}` +
      `&tileSize=256` +
      `&subscription-key=${encodeURIComponent(subscriptionKey)}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (e) {}
        azureLastFailure = {
          status: res.status,
          statusText: res.statusText || '',
          body
        };
        return null;
      }
      const blob = await res.blob();
      azureSuccessCount += 1;
      return await createImageBitmap(blob);
    } catch (e) {
      azureLastFailure = {
        status: 0,
        statusText: '',
        body: e && e.message ? e.message : String(e)
      };
      console.warn("[AzureTiles] tile fail", x, y, z, e);
      return null;
    }
  };

  const stitched = await stitchTiles({
    lat,
    lon,
    radius,
    zoom,
    tileSize: TILE_SIZE,
    fetchTile
  });

  if (azureSuccessCount === 0) {
    const status = azureLastFailure && azureLastFailure.status ? azureLastFailure.status : 'unknown';
    const detail = azureLastFailure && azureLastFailure.body
      ? String(azureLastFailure.body).replace(/\s+/g, ' ').trim().slice(0, 240)
      : 'No Azure imagery tiles were returned.';
    throw new Error(`Azure tile fetch failed (${status}). ${detail}`);
  }

  stitched.zoom = zoom;
  return stitched;
}

/* maps.js (DROP-IN REPLACEMENT) */
function setLayerScaleToMatchSolar(layerId, providerZoom, sourceW = null, targetW = null) {
  const cfg = ensureLayerCfg(layerId);
  if (!Number.isFinite(providerZoom)) return cfg;

  cfg.__zoom = providerZoom;

  const solarMpp = getSolarMetersPerPixel();
  const provMpp  = webMercatorMetersPerPixel(mapCenterLat, providerZoom);

  // Back-compat defaults: old behavior assumes sourceW == targetW
  const tW = Number.isFinite(+targetW) && +targetW > 0 ? +targetW : imageWidth;
  const sW = Number.isFinite(+sourceW) && +sourceW > 0 ? +sourceW : tW;

  // ✅ Correct for stitched mosaics: include sourceW/targetW
  // effScale = (provMpp/solarMpp) * (sourceW/targetW)
  let desiredEffScale = (provMpp / solarMpp) * (sW / tW);

  // Clamp to prevent "crop bigger than source" (causes tiny center square)
  desiredEffScale = Math.max(0.10, Math.min(20, desiredEffScale));

  const fine = Number.isFinite(cfg.fineScale) ? cfg.fineScale : 1.0;
  cfg.scale = desiredEffScale / (fine || 1.0);

  return cfg;
}





/* maps.js (DROP-IN REPLACEMENT) */
async function handleAppleLayerFetch() {
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
    '<div style="padding:50px; text-align:center; color:#1a73e8;">Fetching Apple Maps Tiles...</div>';

  // --- Apple stitch settings ---
  const tileZoom = 22;

  // ✅ Scale stitch radius with Solar radius (baseline: 20m => tileRadius 3)
  const solarRad = (window.getRadiusMeters ? window.getRadiusMeters() : (window.RADIUS_METERS || 20));
  const baseSolar = 20;
  const baseTileRadius = 3; // your known-good value at 20m
  const factor = Math.max(1, solarRad / baseSolar);
  const tileRadius = Math.max(1, Math.round(baseTileRadius * factor)); // 60m => 9

  const attemptWithKey = async (accessKey) => {
    const result = await fetchStitchedAppleTile(lat0, lng0, tileRadius, tileZoom, accessKey);
    if (!result || !result.canvas) throw new Error("Stitching returned null.");
    return result;
  };

  try {
    let accessKey = await getAppleAccessKey({ forceRefresh: true });
    if (!accessKey) {
      zoomLayer.innerHTML = originalContent;
      setupView();
      alert("Apple Maps key is not available. Check the Apple Key setting, then try Apple Maps again.");
      selectView('solar');
      return;
    }

    let result;
    try {
      result = await attemptWithKey(accessKey);
    } catch (e) {
      if (e && e.message === "ACCESS_DENIED") {
        localStorage.removeItem("apple_maps_key");
        localStorage.removeItem("apple_maps_key_updated_at_utc");
        const freshKey = await getAppleAccessKey({ forceRefresh: true });
        if (!freshKey) throw e;
        result = await attemptWithKey(freshKey);
        accessKey = freshKey;
      } else {
        throw e;
      }
    }

    const stitchedCanvas = result.canvas;
    const autoOffsetX = result.offX;
    const autoOffsetY = result.offY;

    // In structure mode, keep the full local Apple capture. For the global view,
    // cache a capped image so very large all-structure stitches do not block use.
    if (window.currentProjectId) {
      const structureIdx = Number(window.__activeStructureSupplementalIndex);
      if (window.__structureLocalImageryActive && Number.isInteger(structureIdx) && structureIdx > 0 && typeof window.saveProjectArtifactBlob === 'function') {
        const rawBlob = await new Promise((r) => stitchedCanvas.toBlob(r, "image/png"));
        await window.saveProjectArtifactBlob(`structure-${structureIdx}-apple.png`, rawBlob);
      } else if (typeof window.trySaveProjectCanvasArtifact === 'function') {
        await window.trySaveProjectCanvasArtifact('apple.png', stitchedCanvas, {
          type: 'image/jpeg',
          quality: 0.86,
          maxDimension: 4096
        });
      } else if (typeof window.saveProjectArtifactBlob === 'function') {
        const rawBlob = await new Promise((r) => stitchedCanvas.toBlob(r, "image/jpeg", 0.86));
        try {
          await window.saveProjectArtifactBlob('apple.jpg', rawBlob);
        } catch (uploadError) {
          console.warn("[AppleMaps] Skipping cached Apple upload:", uploadError);
        }
      } else {
        throw new Error("FirstMeasure artifact upload helper is unavailable.");
      }
    }

    // ✅ IMPORTANT: treat stitched image as the raw source
    // (we keep it as an Image so ensureViewCanvas('apple') can bake with drawScaledImage)
    const rawImg = new Image();
    rawImg.src = stitchedCanvas.toDataURL("image/png");
    await new Promise((r) => (rawImg.onload = r));
    layerData.apple = rawImg;

    // --- Update layer config (offsets from stitch) ---
    const cfg = ensureLayerCfg('apple');
    cfg.__zoom = tileZoom;
    cfg.x = autoOffsetX;
    cfg.y = autoOffsetY;
    cfg.rot = cfg.rot || 0;
    cfg.fineScale = cfg.fineScale || 1.0;

    // ✅ THE FIX: include stitched mosaic width when solving scale
    setLayerScaleToMatchSolar('apple', tileZoom, stitchedCanvas.width, imageWidth);

    // ✅ Bake to target
    const baked = document.createElement('canvas');
    baked.width = imageWidth;
    baked.height = imageHeight;
    const bctx = baked.getContext('2d');

    drawScaledImage(
      bctx,
      stitchedCanvas,           // IMPORTANT: use the stitched canvas as source
      imageWidth,
      imageHeight,
      cfg.scale,
      cfg.x,
      cfg.y,
      cfg.rot || 0,
      cfg.fineScale || 1.0
    );

    viewCanvases.apple = baked;


    zoomLayer.innerHTML = originalContent;
    setupView();
    selectView("apple");

    await window.saveProjectData(true, true);
  } catch (e) {
    console.error("[AppleMaps] Error:", e);
    zoomLayer.innerHTML = originalContent;
    setupView();

    if (e && e.message === "ACCESS_DENIED") {
      localStorage.removeItem("apple_maps_key");
      localStorage.removeItem("apple_maps_key_updated_at_utc");
      alert("Apple Maps Access Denied. The key may be invalid or expired.");
      selectView("solar");
    } else {
      alert("Failed to fetch Apple Maps layer. Check console.");
      selectView("solar");
    }
  }
}
