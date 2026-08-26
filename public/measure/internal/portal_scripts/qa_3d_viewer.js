(function () {
    const params = new URLSearchParams(window.location.search);
    const projectId = (params.get('folder') || params.get('project') || '').trim();
    const apiBase = resolveApiBase(params.get('api'));
    const ELEVATION_OFFSET = 0.1;
    const GOOGLE_TILE_RENDER_PIXEL_RATIO = 2;
    const MAX_TILE_PROJECT_DISTANCE_METERS = 250;
    const MEASURE_LABEL_FONT_PX = 14;
    const MEASURE_LABEL_HEIGHT_PX = 17;
    const MEASURE_LABEL_PAD_X_PX = 6;
    const MEASURE_LABEL_PAD_Y_PX = 2;
    const LAYER_STYLES = {
        1: { line: '#00FF00', dot: '#FFFF00', fill: 'rgba(0,255,0,0.22)' },
        2: { line: '#FFA500', dot: '#FF0000', fill: 'rgba(255,165,0,0.22)' },
        3: { line: '#0000FF', dot: '#800080', fill: 'rgba(0,102,255,0.22)' },
        4: { line: '#9C27B0', dot: '#FFC0CB', fill: 'rgba(156,39,176,0.22)' },
        5: { line: '#006400', dot: '#DAA520', fill: 'rgba(0,100,0,0.22)' },
        6: { line: '#000080', dot: '#FF00FF', fill: 'rgba(0,0,128,0.22)' }
    };
    const LINE_TYPES = {
        ridge: { color: '#FF0000', label: 'Ridge' },
        hip: { color: '#E67300', label: 'Hip' },
        valley: { color: '#800080', label: 'Valley' },
        rake: { color: '#006400', label: 'Rake' },
        eave: { color: '#FFD400', label: 'Eave' },
        head_wall: { color: '#A0522D', label: 'Headwall Flashing' },
        side_wall: { color: '#FF00FF', label: 'Sidewall Flashing' },
        trans: { color: '#808080', label: 'Transition' },
        parapet: { color: '#5C2E0C', label: 'Parapet Wall' },
        protrusion: { color: '#589BA6', label: 'Protrusion' },
        chimney_back: { color: '#00008B', label: 'Chimney Back Pan' },
        chimney_edge: { color: '#007bff', label: 'Chimney Step' },
        chimney_front: { color: '#ADD8E6', label: 'Chimney Apron' },
        skylight: { color: '#00FFFF', label: 'Skylight' },
        unknown: { color: '#000000', label: 'Unknown' }
    };
    const state = {
        bundle: null,
        manifest: null,
        assets: {},
        appMetadata: {},
        pdfState: null,
        layerConfig: {},
        imageWidth: 0,
        imageHeight: 0,
        dsm: null,
        dsmMin: 0,
        dsmMax: 0,
        radiusMeters: 20,
        surfaceMode: 'height',
        autoRotate: true,
        showFaces: true,
        showTypeColors: true,
        showMeasurements: true,
        showLegend: true,
        tileManifestUrl: '',
        tileManifest: null,
        tileReady: false,
        tileLoading: false,
        tileLoadPromise: null,
        tileCapturePromise: null,
        tileError: '',
        tileManualYOffset: 0
    };

    let scene = null;
    let camera = null;
    let renderer = null;
    let controls = null;
    let surfaceMesh = null;
    let wireframeGroup = null;
    let pointMarkerGroup = null;
    let faceGroup = null;
    let measurementGroup = null;
    let tileGeospatialRoot = null;
    let tileCalibrationRoot = null;
    let tileContentGroup = null;
    let tileLoader = null;
    let dracoLoader = null;
    let animationFrameId = 0;

    const overlayEl = document.getElementById('qa3dOverlay');
    const statusEl = document.getElementById('qa3dStatus');
    const surfaceBtn = document.getElementById('qa3dSurfaceBtn');
    const facesBtn = document.getElementById('qa3dFacesBtn');
    const typesBtn = document.getElementById('qa3dTypesBtn');
    const measuresBtn = document.getElementById('qa3dMeasuresBtn');
    const rotateBtn = document.getElementById('qa3dRotateBtn');
    const canvasWrap = document.getElementById('qa3dCanvasWrap');

    surfaceBtn?.addEventListener('click', async () => {
        if (state.surfaceMode === 'height') {
            state.surfaceMode = 'tiles';
            syncUi();
            try {
                await ensureTilesLoaded();
            } catch (error) {
                state.surfaceMode = 'height';
                setStatus(error && error.message ? error.message : 'Unable to load Google tiles.');
            }
        } else {
            state.surfaceMode = 'height';
        }
        applySurfaceMode();
        syncUi();
    });

    rotateBtn?.addEventListener('click', () => {
        state.autoRotate = !state.autoRotate;
        if (controls) controls.autoRotate = state.autoRotate;
        syncUi();
    });
    facesBtn?.addEventListener('click', () => {
        state.showFaces = !state.showFaces;
        applyGeometryOverlayVisibility();
        syncUi();
    });
    typesBtn?.addEventListener('click', () => {
        state.showTypeColors = !state.showTypeColors;
        state.showLegend = state.showTypeColors;
        buildWireframe();
        syncUi();
    });
    measuresBtn?.addEventListener('click', () => {
        state.showMeasurements = !state.showMeasurements;
        applyGeometryOverlayVisibility();
        syncUi();
    });
    window.addEventListener('resize', () => resizeRenderer());

    init().catch((error) => {
        console.error('[QA 3D Viewer] Failed to initialize', error);
        showOverlay('3D viewer unavailable', error && error.message ? error.message : 'The QA surface viewer could not be loaded for this project.');
        setStatus(error && error.message ? error.message : 'Viewer failed to initialize.');
    });

    async function init() {
        if (!projectId) throw new Error('Missing project id.');
        setStatus('Loading project bundle...');
        buildScene();
        showOverlay('Loading 3D Viewer', 'Preparing the DSM surface, saved wireframe, and any available Google 3D tiles for this project.');
        await loadProjectBundle();
        await buildHeightSurface();
        buildWireframe();
        frameScene();
        hideOverlay();
        applySurfaceMode();
        syncUi();
        setStatus('DSM surface ready. Use SURF to load Google 3D tiles when needed.');
        startAnimationLoop();
    }

    function resolveApiBase(input) {
        const raw = String(input || '').trim();
        if (raw) return raw.replace(/\/+$/, '');
        const host = (window.location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:3111/v1/firstmeasure';
        return `${window.location.origin.replace(/\/+$/, '')}/v1/firstmeasure`;
    }

    function apiUrl(path) {
        return `${apiBase}/${String(path || '').replace(/^\/+/, '')}`;
    }

    async function apiJson(path) {
        const response = await fetch(apiUrl(path), { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'include' });
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new Error(`Unexpected API response (${response.status}).`);
        }
        if (!response.ok) {
            throw new Error(data && (data.error || data.message) ? (data.error || data.message) : `Request failed (${response.status}).`);
        }
        return data;
    }

    function editorBundleCacheKey() {
        return `qa_editor_bundle:v1:${apiBase}:${projectId}`;
    }

    function readEditorBundleCache(maxAgeMs = 120000) {
        if (!projectId || !window.sessionStorage) return null;
        try {
            const raw = sessionStorage.getItem(editorBundleCacheKey());
            if (!raw) return null;
            const wrapped = JSON.parse(raw);
            const savedAt = Number(wrapped && wrapped.savedAt);
            if (!savedAt || Date.now() - savedAt > maxAgeMs) return null;
            return wrapped.data && typeof wrapped.data === 'object' ? wrapped.data : null;
        } catch (error) {
            return null;
        }
    }

    function writeEditorBundleCache(data) {
        if (!projectId || !data || typeof data !== 'object' || !window.sessionStorage) return;
        try {
            sessionStorage.setItem(editorBundleCacheKey(), JSON.stringify({
                savedAt: Date.now(),
                data
            }));
        } catch (error) {}
    }

    async function apiJsonRequest(path, options) {
        const init = { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'include', ...(options || {}) };
        const response = await fetch(apiUrl(path), init);
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new Error(`Unexpected API response (${response.status}).`);
        }
        if (!response.ok) {
            throw new Error(data && (data.error || data.message) ? (data.error || data.message) : `Request failed (${response.status}).`);
        }
        return data;
    }

    function resolveApiAssetUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
        const normalizedBase = `${apiBase.replace(/\/+$/, '')}/`;
        if (raw.startsWith('/v1/firstmeasure/')) {
            return new URL(raw.replace(/^\/+/, ''), `${window.location.origin}/`).href
                .replace(`${window.location.origin}/v1/firstmeasure/`, normalizedBase);
        }
        if (raw.startsWith('/')) {
            const root = new URL(apiBase);
            return `${root.protocol}//${root.host}${raw}`;
        }
        return new URL(raw, normalizedBase).href;
    }

    async function loadProjectBundle() {
        const data = readEditorBundleCache() || await apiJson(`projects/${encodeURIComponent(projectId)}/editor`);
        writeEditorBundleCache(data);
        const manifest = data && typeof data === 'object' ? data.manifest : null;
        if (!manifest || typeof manifest !== 'object') throw new Error('Project manifest was not returned.');
        state.bundle = data;
        state.manifest = manifest;
        state.assets = data.assets || {};
        state.appMetadata = data.app_metadata || manifest.app_metadata || {};
        state.pdfState = data.pdf_state && typeof data.pdf_state === 'object' ? data.pdf_state : null;
        state.layerConfig = state.appMetadata.layer_config || {};
        state.radiusMeters = getRadiusMeters();
        state.tileManifestUrl = resolveApiAssetUrl(
            (state.appMetadata.google3dTiles && state.appMetadata.google3dTiles.manifestUrl) ||
            state.assets.google_3d_manifest ||
            ''
        );
    }

    function getRadiusMeters() {
        const metaRadius = Number(state.manifest && state.manifest.radius_meters);
        if (Number.isFinite(metaRadius) && metaRadius > 0) return metaRadius;
        const cfgRadius = Number(state.layerConfig && state.layerConfig.__radius && state.layerConfig.__radius.scale);
        if (Number.isFinite(cfgRadius) && cfgRadius > 0) return cfgRadius;
        return 20;
    }

    async function ensureTileManifestUrl() {
        if (state.tileManifestUrl) return state.tileManifestUrl;
        if (state.tileCapturePromise) return state.tileCapturePromise;
        const projectLat = Number(state.manifest && state.manifest.lat);
        const projectLng = Number(state.manifest && state.manifest.lng);
        if (!Number.isFinite(projectLat) || !Number.isFinite(projectLng)) {
            throw new Error('This project does not have project coordinates for Google 3D tiles.');
        }
        state.tileCapturePromise = (async () => {
            setStatus('Preparing Google 3D tiles for this project...');
            const payload = await apiJsonRequest(`projects/${encodeURIComponent(projectId)}/google-3d/capture`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    lat: projectLat,
                    lng: projectLng,
                    address: String(state.manifest && state.manifest.address || '').trim(),
                    radius_meters: Number.isFinite(state.radiusMeters) ? state.radiusMeters : 60
                })
            });
            if (!payload || !payload.success || !payload.manifest_url) {
                throw new Error(payload && payload.error ? payload.error : 'Google 3D tile capture request failed.');
            }
            state.tileManifestUrl = resolveApiAssetUrl(payload.manifest_url);
            if (!state.appMetadata || typeof state.appMetadata !== 'object') state.appMetadata = {};
            state.appMetadata.google3dTiles = {
                ...(state.appMetadata.google3dTiles || {}),
                manifestUrl: payload.manifest_url
            };
            return state.tileManifestUrl;
        })().finally(() => {
            state.tileCapturePromise = null;
        });
        return state.tileCapturePromise;
    }

    function buildScene() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x202124);
        camera = new THREE.PerspectiveCamera(46, 1, 0.1, 8000);
        camera.position.set(65, 54, 62);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(canvasWrap.clientWidth || 1, canvasWrap.clientHeight || 1, false);
        if ('outputEncoding' in renderer && typeof THREE.LinearEncoding !== 'undefined') renderer.outputEncoding = THREE.LinearEncoding;
        if ('toneMapping' in renderer && typeof THREE.NoToneMapping !== 'undefined') renderer.toneMapping = THREE.NoToneMapping;
        canvasWrap.appendChild(renderer.domElement);

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.42;
        controls.enablePan = true;
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.ROTATE,
          RIGHT: THREE.MOUSE.PAN
        };
        controls.minDistance = 6;
        controls.maxDistance = 220;
        controls.maxPolarAngle = Math.PI * 0.495;
        controls.target.set(0, 0, 0);
        controls.addEventListener('start', () => {
            if (!state.autoRotate) return;
            state.autoRotate = false;
            controls.autoRotate = false;
            syncUi();
        });

        scene.add(new THREE.HemisphereLight(0xffffff, 0x5c6570, 0.95));
        scene.add(new THREE.AmbientLight(0xffffff, 0.32));
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(90, 130, 75);
        scene.add(dir);

        wireframeGroup = new THREE.Group();
        scene.add(wireframeGroup);
        pointMarkerGroup = new THREE.Group();
        scene.add(pointMarkerGroup);
        faceGroup = new THREE.Group();
        scene.add(faceGroup);
        measurementGroup = new THREE.Group();
        scene.add(measurementGroup);
        ensureTileRoots();
        resizeRenderer();
    }

    async function buildHeightSurface() {
        if (!state.assets.dsm) throw new Error('This project is missing its DSM surface.');
        setStatus('Loading DSM and aerial texture...');
        const [dsmTiff, textureSource] = await Promise.all([loadTiff(state.assets.dsm), loadSurfaceTextureSource()]);
        const dsmRaster = dsmTiff.rasters && dsmTiff.rasters[0];
        if (!dsmRaster || !dsmTiff.width || !dsmTiff.height) throw new Error('DSM raster is invalid.');

        state.dsm = dsmRaster;
        state.imageWidth = dsmTiff.width;
        state.imageHeight = dsmTiff.height;

        let minHeight = Infinity;
        let maxHeight = -Infinity;
        const step = Math.max(1, Math.floor(dsmRaster.length / 250000));
        for (let i = 0; i < dsmRaster.length; i += step) {
            const value = dsmRaster[i];
            if (Number.isFinite(value) && value > -9000) {
                if (value < minHeight) minHeight = value;
                if (value > maxHeight) maxHeight = value;
            }
        }
        state.dsmMin = Number.isFinite(minHeight) ? minHeight : 0;
        state.dsmMax = Number.isFinite(maxHeight) ? maxHeight : 0;

        if (surfaceMesh) {
            scene.remove(surfaceMesh);
            disposeObject3D(surfaceMesh);
            surfaceMesh = null;
        }

        const texture = textureSource ? new THREE.CanvasTexture(textureSource) : null;
        if (texture) {
            markTextureSRGB(texture);
            texture.needsUpdate = true;
        }

        const sampleStep = Math.max(1, Math.ceil(Math.max(state.imageWidth, state.imageHeight) / 220));
        const xSamples = buildSampleAxis(state.imageWidth, sampleStep);
        const ySamples = buildSampleAxis(state.imageHeight, sampleStep);
        const gridW = xSamples.length;
        const gridH = ySamples.length;
        const positions = new Float32Array(gridW * gridH * 3);
        const uvs = new Float32Array(gridW * gridH * 2);
        const indices = [];
        let positionCursor = 0;
        let uvCursor = 0;
        for (let row = 0; row < gridH; row += 1) {
            const iy = ySamples[row];
            for (let col = 0; col < gridW; col += 1) {
                const ix = xSamples[col];
                const world = imagePixelToWorld(ix, iy, getDsmValue(ix, iy));
                positions[positionCursor++] = world.x;
                positions[positionCursor++] = world.y;
                positions[positionCursor++] = world.z;
                uvs[uvCursor++] = ix / Math.max(1, state.imageWidth - 1);
                uvs[uvCursor++] = 1 - (iy / Math.max(1, state.imageHeight - 1));
            }
        }
        for (let row = 0; row < gridH - 1; row += 1) {
            for (let col = 0; col < gridW - 1; col += 1) {
                const a = row * gridW + col;
                const b = a + 1;
                const c = a + gridW;
                const d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
            map: texture,
            color: texture ? 0xffffff : 0x4b5158,
            roughness: 1,
            metalness: 0,
            side: THREE.DoubleSide
        });
        surfaceMesh = new THREE.Mesh(geometry, material);
        surfaceMesh.receiveShadow = true;
        surfaceMesh.castShadow = false;
        scene.add(surfaceMesh);
    }

    function buildSampleAxis(size, step) {
        const values = [];
        for (let i = 0; i < size; i += step) values.push(i);
        if (!values.length || values[values.length - 1] !== size - 1) values.push(size - 1);
        return values;
    }

    async function loadSurfaceTextureSource() {
        if (state.assets.rgb) {
            try {
                const tiff = await loadTiff(state.assets.rgb);
                if (tiff.rasters && tiff.width && tiff.height) return rastersToCanvas(tiff.rasters, tiff.width, tiff.height);
            } catch (error) {
                try {
                    return await loadImageToCanvas(state.assets.rgb);
                } catch (imageError) {}
            }
        }
        const fallbackUrl = state.assets.google || state.assets.solar || '';
        if (!fallbackUrl) return null;
        return await loadImageToCanvas(fallbackUrl);
    }

    async function loadTiff(url) {
        const response = await fetch(resolveApiAssetUrl(url), { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to load TIFF (${response.status}).`);
        const buffer = await response.arrayBuffer();
        const tiff = await GeoTIFF.fromArrayBuffer(buffer);
        const image = await tiff.getImage();
        return { rasters: await image.readRasters(), width: image.getWidth(), height: image.getHeight() };
    }

    function rastersToCanvas(rasters, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        const bands = Array.isArray(rasters) ? rasters : [rasters];
        const rBand = bands[0];
        const gBand = bands[1] || bands[0];
        const bBand = bands[2] || bands[0];
        const aBand = bands[3] || null;
        for (let i = 0; i < width * height; i += 1) {
            const base = i * 4;
            data[base] = normalizeByte(rBand[i]);
            data[base + 1] = normalizeByte(gBand[i]);
            data[base + 2] = normalizeByte(bBand[i]);
            data[base + 3] = aBand ? normalizeByte(aBand[i]) : 255;
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function normalizeByte(value) {
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    function loadImageToCanvas(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas);
            };
            img.onerror = () => reject(new Error('Fallback texture failed to load.'));
            img.src = resolveApiAssetUrl(url);
        });
    }

    function buildWireframe() {
        clearGroup(wireframeGroup);
        clearGroup(pointMarkerGroup);
        clearGroup(faceGroup);
        clearGroup(measurementGroup);
        const geometry = getNormalizedGeometry();
        const points = geometry.points;
        const connections = geometry.connections;
        if (!points.length || !connections.length) {
            setStatus('DSM ready. No saved wireframe geometry was found for this project.');
            return;
        }
        for (const connection of connections) {
            const start = points[connection.startIdx];
            const end = points[connection.endIdx];
            if (!start || !end) continue;
            const a = imagePixelToWorld(start.x, start.y, Number.isFinite(start.z) ? start.z : getDsmValue(start.x, start.y));
            const b = imagePixelToWorld(end.x, end.y, Number.isFinite(end.z) ? end.z : getDsmValue(end.x, end.y));
            const key = getConnectionDisplayColor(connection, start.layer || end.layer || 1);
            const lineMesh = createConnectionMesh(a, b, key);
            if (lineMesh) wireframeGroup.add(lineMesh);
            if (state.showMeasurements) {
                const label = createMeasurementSprite(connection, start, end);
                if (label) measurementGroup.add(label);
            }
        }

        for (const point of points) {
            const pos = imagePixelToWorld(point.x, point.y, Number.isFinite(point.z) ? point.z : getDsmValue(point.x, point.y));
            const style = LAYER_STYLES[Number(point.layer) || 1] || LAYER_STYLES[1];
            const marker = createPointMarkerSprite(pos, style.dot || '#ffffff');
            if (marker) pointMarkerGroup.add(marker);
        }
        buildFaces(points, geometry.resolvedFaces, geometry.manualFaces);
        applyGeometryOverlayVisibility();
    }

    function buildFaces(points, resolvedFaces, manualFaces) {
        if (!faceGroup) return;
        const faceDefs = Array.isArray(resolvedFaces) && resolvedFaces.length
            ? resolvedFaces.map((face) => hydrateManualFace(face, points)).filter(Boolean)
            : (Array.isArray(manualFaces) && manualFaces.length
                ? manualFaces.map((face) => hydrateManualFace(face, points)).filter(Boolean)
                : []);
        faceDefs.forEach((face, idx) => {
            if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
            const mesh = createFaceMesh(face, idx);
            if (mesh) faceGroup.add(mesh);
        });
    }

    function createFaceMesh(face, idx) {
        const start = getFaceVertex(face.points[0]);
        if (!start) return null;
        const shape = new THREE.Shape();
        shape.moveTo(start.x, -start.z);
        for (let i = 1; i < face.points.length; i += 1) {
            const next = getFaceVertex(face.points[i]);
            if (!next) continue;
            shape.lineTo(next.x, -next.z);
        }
        const geometry = new THREE.ShapeGeometry(shape);
        const posAttr = geometry.attributes.position;
        for (let i = 0; i < posAttr.count; i += 1) {
            const lx = posAttr.getX(i);
            const ly = posAttr.getY(i);
            const imgX = (lx / 100 + 0.5) * state.imageWidth;
            const imgY = (-ly / 100 + 0.5) * state.imageHeight;
            const height = sampleFaceHeight(face.points, imgX, imgY);
            posAttr.setZ(i, height);
        }
        geometry.computeVertexNormals();
        const layerNum = face.layer || 1;
        const style = LAYER_STYLES[layerNum] || LAYER_STYLES[1];
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(style.line),
            emissive: new THREE.Color(style.line).multiplyScalar(0.22),
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.34,
            roughness: 0.6,
            metalness: 0
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 22 + (idx % 8);
        return mesh;
    }

    function createConnectionMesh(a, b, color) {
        if (!a || !b) return null;
        const dir = new THREE.Vector3().subVectors(b, a);
        const length = dir.length();
        if (!(length > 0.001)) return null;
        const radius = 0.13;
        const geometry = new THREE.CylinderGeometry(radius, radius, length, 10);
        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            transparent: true,
            opacity: 0.98,
            depthTest: false
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        mesh.userData.viewportLineBaseRadius = radius;
        mesh.userData.viewportLinePx = 3.4;
        mesh.renderOrder = 40;
        return mesh;
    }

    function createPointMarkerSprite(position, color) {
        if (!position) return null;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: getPointMarkerTexture(color),
            transparent: true,
            depthTest: false,
            depthWrite: false
        }));
        sprite.position.copy(position);
        sprite.renderOrder = 42;
        sprite.userData.markerPxSize = 15;
        return sprite;
    }

    const pointTextureCache = new Map();
    function getPointMarkerTexture(color) {
        const key = String(color || '#ffffff').toLowerCase();
        const cached = pointTextureCache.get(key);
        if (cached) return cached;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const r = 18;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = key;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.stroke();
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        pointTextureCache.set(key, texture);
        return texture;
    }

    function getFaceVertex(point) {
        if (!point) return null;
        return imagePixelToWorld(point.x, point.y, Number.isFinite(point.z) ? point.z : getDsmValue(point.x, point.y));
    }

    function sampleFaceHeight(facePoints, imgX, imgY) {
        let best = null;
        let bestDist = Infinity;
        facePoints.forEach((point) => {
            const dx = Number(point.x) - imgX;
            const dy = Number(point.y) - imgY;
            const dist = Math.hypot(dx, dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = point;
            }
        });
        const rawHeight = best && Number.isFinite(best.z) ? Number(best.z) : getDsmValue(imgX, imgY);
        return ((rawHeight - state.dsmMin) * getZScale()) + ELEVATION_OFFSET + 0.05;
    }

    function getConnectionDisplayColor(connection, layerNum) {
        if (state.showTypeColors && connection && connection.type && LINE_TYPES[connection.type]) return LINE_TYPES[connection.type].color;
        const style = LAYER_STYLES[layerNum] || LAYER_STYLES[1];
        return style.line;
    }

    function getLegendItems() {
        const geometry = getNormalizedGeometry();
        if (!geometry || !Array.isArray(geometry.connections)) return [];
        const found = new Set();
        geometry.connections.forEach((conn) => {
            const type = String(conn && conn.type || '').trim().toLowerCase();
            if (type && LINE_TYPES[type]) found.add(type);
        });
        return Object.keys(LINE_TYPES)
            .filter((type) => found.has(type))
            .map((type) => ({ type, color: LINE_TYPES[type].color, label: LINE_TYPES[type].label }));
    }

    function updateLegend() {
        const legend = document.getElementById('qa3dLegend');
        if (!legend) return;
        const items = getLegendItems();
        const show = !!state.showLegend && items.length > 0;
        legend.classList.toggle('hidden', !show);
        if (!show) {
            legend.innerHTML = '';
            return;
        }
        legend.innerHTML = `
            <div class="qa3d-legend-title">Line Types</div>
            <div class="qa3d-legend-list">
                ${items.map((item) => `
                    <div class="qa3d-legend-item">
                        <span class="qa3d-legend-swatch" style="background:${item.color};"></span>
                        <span class="qa3d-legend-label">${item.label}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function createMeasurementSprite(connection, start, end) {
        if (!connection || !start || !end) return null;
        const labelText = getConnectionLengthFeet(start, end).toFixed(1) + "'";
        const metricsCanvas = document.createElement('canvas');
        const metricsCtx = metricsCanvas.getContext('2d');
        if (!metricsCtx) return null;
        metricsCtx.font = `700 ${MEASURE_LABEL_FONT_PX}px Arial`;
        const textWidth = Math.ceil(metricsCtx.measureText(labelText).width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(32, textWidth + (MEASURE_LABEL_PAD_X_PX * 2));
        canvas.height = Math.max(18, MEASURE_LABEL_HEIGHT_PX + (MEASURE_LABEL_PAD_Y_PX * 2));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.font = `700 ${MEASURE_LABEL_FONT_PX}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
        roundRect(ctx, 0, 0, canvas.width, canvas.height, Math.min(6, canvas.height / 2));
        ctx.fill();
        ctx.fillStyle = '#111111';
        ctx.fillText(labelText, canvas.width / 2, (canvas.height / 2) + 0.5);
        const texture = new THREE.CanvasTexture(canvas);
        markTextureSRGB(texture);
        const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
        const sprite = new THREE.Sprite(material);
        const a = imagePixelToWorld(start.x, start.y, Number.isFinite(start.z) ? start.z : getDsmValue(start.x, start.y));
        const b = imagePixelToWorld(end.x, end.y, Number.isFinite(end.z) ? end.z : getDsmValue(end.x, end.y));
        sprite.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.12, (a.z + b.z) / 2);
        sprite.scale.set(1, 1, 1);
        sprite.userData.labelPxWidth = canvas.width;
        sprite.userData.labelPxHeight = canvas.height;
        sprite.renderOrder = 60;
        return sprite;
    }

    function roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + width, y, x + width, y + height, radius);
        ctx.arcTo(x + width, y + height, x, y + height, radius);
        ctx.arcTo(x, y + height, x, y, radius);
        ctx.arcTo(x, y, x + width, y, radius);
        ctx.closePath();
    }

    function getConnectionLengthFeet(start, end) {
        const metersPerPx = state.imageWidth > 0 ? ((state.radiusMeters * 2) / state.imageWidth) : 0;
        const dx = Number(end.x) - Number(start.x);
        const dy = Number(end.y) - Number(start.y);
        const dist2dMeters = Math.hypot(dx, dy) * metersPerPx;
        if (Number.isFinite(start.z) && Number.isFinite(end.z)) {
            const dz = Number(start.z) - Number(end.z);
            return Math.sqrt(dist2dMeters * dist2dMeters + dz * dz) * 3.28084;
        }
        return dist2dMeters * 3.28084;
    }

    function applyGeometryOverlayVisibility() {
        if (faceGroup) faceGroup.visible = !!state.showFaces;
        if (measurementGroup) measurementGroup.visible = !!state.showMeasurements;
    }

    function hydrateManualFace(face, points) {
        if (!face || !Array.isArray(face.pointIndices) || face.pointIndices.length < 3) return null;
        const facePoints = face.pointIndices.map((idx) => points[idx]).filter(Boolean);
        if (facePoints.length < 3) return null;
        return {
            layer: Number(face.layer) || Number(facePoints[0].layer) || 1,
            points: facePoints
        };
    }

    function getNormalizedGeometry() {
        const raw = (state.appMetadata && state.appMetadata.geometry) || (state.pdfState && state.pdfState.geometry) || {};
        const rawPoints = Array.isArray(raw.points) ? raw.points : [];
        const points = rawPoints.map((point, idx) => ({
            idx,
            x: Number(point && point.x),
            y: Number(point && point.y),
            z: Number(point && point.z),
            layer: Number(point && point.layer) || 1
        })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        const pointIndexByKey = new Map();
        points.forEach((point, idx) => {
            pointIndexByKey.set(pointKey(point.x, point.y, point.layer), idx);
        });
        const connections = [];
        (Array.isArray(raw.connections) ? raw.connections : []).forEach((connection) => {
            let startIdx = Number.isInteger(connection && connection.startIdx) ? connection.startIdx : -1;
            let endIdx = Number.isInteger(connection && connection.endIdx) ? connection.endIdx : -1;
            if (!(startIdx >= 0) && connection && connection.start) {
                startIdx = pointIndexByKey.get(pointKey(connection.start.x, connection.start.y, connection.start.layer || 1));
            }
            if (!(endIdx >= 0) && connection && connection.end) {
                endIdx = pointIndexByKey.get(pointKey(connection.end.x, connection.end.y, connection.end.layer || 1));
            }
            if (!(startIdx >= 0) || !(endIdx >= 0) || startIdx === endIdx) return;
            connections.push({
                startIdx,
                endIdx,
                type: String(connection && connection.type || '').trim().toLowerCase()
            });
        });
        return {
            points,
            connections,
            resolvedFaces: Array.isArray(raw.resolvedFaces) ? raw.resolvedFaces : [],
            manualFaces: Array.isArray(raw.manualFaces) ? raw.manualFaces : []
        };
    }

    function pointKey(x, y, layer) {
        return `${Math.round(Number(x) * 10)}|${Math.round(Number(y) * 10)}|${Number(layer) || 1}`;
    }

    function imagePixelToWorld(ix, iy, heightValue) {
        const x = ((Number(ix) / Math.max(1, state.imageWidth)) - 0.5) * 100;
        const z = ((Number(iy) / Math.max(1, state.imageHeight)) - 0.5) * 100;
        const safeHeight = Number.isFinite(heightValue) ? heightValue : state.dsmMin;
        const y = ((safeHeight - state.dsmMin) * getZScale()) + ELEVATION_OFFSET;
        return new THREE.Vector3(x, y, z);
    }

    function getDsmValue(ix, iy) {
        if (!state.dsm || !state.imageWidth || !state.imageHeight) return state.dsmMin;
        const x = clamp(Math.round(Number(ix)), 0, state.imageWidth - 1);
        const y = clamp(Math.round(Number(iy)), 0, state.imageHeight - 1);
        const value = state.dsm[y * state.imageWidth + x];
        if (!Number.isFinite(value) || value <= -9000) return state.dsmMin;
        return value;
    }

    function getDsmSceneHeightAtPixel(ix, iy) {
        const value = getDsmValue(ix, iy);
        if (!Number.isFinite(value) || Math.abs(value) < 1e-6) return null;
        return ((value - state.dsmMin) * getZScale()) + ELEVATION_OFFSET;
    }

    function getZScale() {
        const radius = Number.isFinite(state.radiusMeters) && state.radiusMeters > 0 ? state.radiusMeters : 20;
        return 2.0 * (20 / radius);
    }

    function getHorizontalSceneUnitsPerMeter() {
        const radius = Number.isFinite(state.radiusMeters) && state.radiusMeters > 0 ? state.radiusMeters : 20;
        return 50 / radius;
    }

    function geometryPointsForFocus() {
        const metaGeometry = state.appMetadata && state.appMetadata.geometry;
        if (metaGeometry && Array.isArray(metaGeometry.points) && metaGeometry.points.length) return metaGeometry.points;
        const pdfGeometry = state.pdfState && state.pdfState.geometry;
        if (pdfGeometry && Array.isArray(pdfGeometry.points) && pdfGeometry.points.length) return pdfGeometry.points;
        return [];
    }

    function boxFromImageCrop(crop) {
        if (!crop || !state.imageWidth || !state.imageHeight) return null;
        const minX = Number(crop.minX);
        const minY = Number(crop.minY);
        const width = Number(crop.width);
        const height = Number(crop.height);
        if (![minX, minY, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null;
        const sampleHeightAt = (ix, iy) => getDsmValue(ix, iy);
        const corners = [
            imagePixelToWorld(minX, minY, sampleHeightAt(minX, minY)),
            imagePixelToWorld(minX + width, minY, sampleHeightAt(minX + width, minY)),
            imagePixelToWorld(minX, minY + height, sampleHeightAt(minX, minY + height)),
            imagePixelToWorld(minX + width, minY + height, sampleHeightAt(minX + width, minY + height))
        ];
        const box = new THREE.Box3();
        corners.forEach((pt) => box.expandByPoint(new THREE.Vector3(pt.x, pt.y, pt.z)));
        return box;
    }

    function getFocusBounds() {
        const geometryPoints = geometryPointsForFocus();
        if (geometryPoints.length) {
            const box = new THREE.Box3();
            geometryPoints.forEach((point) => {
                const world = imagePixelToWorld(
                    point.x,
                    point.y,
                    Number.isFinite(point.z) ? point.z : getDsmValue(point.x, point.y)
                );
                box.expandByPoint(new THREE.Vector3(world.x, world.y, world.z));
            });
            if (!box.isEmpty()) {
                const padX = Math.max(2, box.getSize(new THREE.Vector3()).x * 0.18);
                const padY = Math.max(1.5, box.getSize(new THREE.Vector3()).y * 0.22);
                const padZ = Math.max(2, box.getSize(new THREE.Vector3()).z * 0.18);
                box.expandByVector(new THREE.Vector3(padX, padY, padZ));
                return box;
            }
        }
        const pdfCrop = state.pdfState && (state.pdfState.displayCrop || state.pdfState.cropRegion);
        const cropBox = boxFromImageCrop(pdfCrop);
        if (cropBox && !cropBox.isEmpty()) {
            const size = cropBox.getSize(new THREE.Vector3());
            cropBox.expandByVector(new THREE.Vector3(Math.max(2, size.x * 0.08), Math.max(1.5, size.y * 0.18), Math.max(2, size.z * 0.08)));
            return cropBox;
        }
        return null;
    }

    function frameScene() {
        const focusBounds = getFocusBounds();
        const bounds = new THREE.Box3();
        let hasBounds = false;
        if (focusBounds && !focusBounds.isEmpty()) {
            bounds.copy(focusBounds);
            hasBounds = true;
        } else {
            [surfaceMesh, wireframeGroup].forEach((obj) => {
                if (!obj) return;
                const box = new THREE.Box3().setFromObject(obj);
                if (box.isEmpty()) return;
                if (!hasBounds) {
                    bounds.copy(box);
                    hasBounds = true;
                } else {
                    bounds.union(box);
                }
            });
        }
        const center = hasBounds ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
        const size = hasBounds ? bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(100, 24, 100);
        const radius = Math.max(size.x * 0.86, size.z * 0.86, size.y * 1.7, 10);
        controls.target.copy(center);
        camera.position.set(center.x + radius * 0.7, center.y + radius * 0.56, center.z + radius * 0.76);
        controls.minDistance = Math.max(4, radius * 0.16);
        controls.maxDistance = Math.max(controls.minDistance + 8, radius * 4.1);
        controls.update();
    }

    function ensureTileRoots() {
        if (!scene || tileGeospatialRoot) return;
        tileGeospatialRoot = new THREE.Group();
        tileGeospatialRoot.matrixAutoUpdate = false;
        tileGeospatialRoot.visible = false;
        scene.add(tileGeospatialRoot);
        tileCalibrationRoot = new THREE.Group();
        tileCalibrationRoot.rotation.x = Math.PI / 2;
        tileGeospatialRoot.add(tileCalibrationRoot);
        tileContentGroup = new THREE.Group();
        tileCalibrationRoot.add(tileContentGroup);
    }

    function clearTileSurface() {
        if (!tileContentGroup) return;
        tileContentGroup.position.set(0, 0, 0);
        while (tileContentGroup.children.length > 0) {
            const child = tileContentGroup.children[0];
            tileContentGroup.remove(child);
            disposeObject3D(child);
        }
        state.tileReady = false;
    }

    function ensureTileLoader() {
        if (tileLoader) return tileLoader;
        if (!THREE.GLTFLoader || !THREE.DRACOLoader) throw new Error('GLTF loader scripts are not available for Google 3D tile loading.');
        dracoLoader = new THREE.DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
        tileLoader = new THREE.GLTFLoader();
        tileLoader.setDRACOLoader(dracoLoader);
        return tileLoader;
    }

    function getMaxAnisotropy() {
        if (!renderer || !renderer.capabilities || typeof renderer.capabilities.getMaxAnisotropy !== 'function') return 1;
        try {
            return Math.max(1, renderer.capabilities.getMaxAnisotropy() || 1);
        } catch (error) {
            return 1;
        }
    }

    function canGenerateMipmaps(texture) {
        if (!texture || !texture.image) return false;
        const width = Number(texture.image.width || texture.image.videoWidth || 0);
        const height = Number(texture.image.height || texture.image.videoHeight || 0);
        if (!(width > 0 && height > 0)) return false;
        if (renderer && renderer.capabilities && renderer.capabilities.isWebGL2) return true;
        return THREE.MathUtils && typeof THREE.MathUtils.isPowerOfTwo === 'function'
            ? (THREE.MathUtils.isPowerOfTwo(width) && THREE.MathUtils.isPowerOfTwo(height))
            : false;
    }

    function markTextureSRGB(texture) {
        if (!texture) return texture;
        if (typeof THREE.sRGBEncoding !== 'undefined' && 'encoding' in texture) texture.encoding = THREE.sRGBEncoding;
        if (typeof THREE.SRGBColorSpace !== 'undefined' && 'colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
        if ('anisotropy' in texture) texture.anisotropy = getMaxAnisotropy();
        if ('magFilter' in texture && typeof THREE.LinearFilter !== 'undefined') texture.magFilter = THREE.LinearFilter;
        if ('minFilter' in texture) {
            const allowMipmaps = canGenerateMipmaps(texture);
            if ('generateMipmaps' in texture) texture.generateMipmaps = allowMipmaps;
            if (allowMipmaps && typeof THREE.LinearMipmapLinearFilter !== 'undefined') texture.minFilter = THREE.LinearMipmapLinearFilter;
            else if (typeof THREE.LinearFilter !== 'undefined') texture.minFilter = THREE.LinearFilter;
        }
        texture.needsUpdate = true;
        return texture;
    }

    function createTileDisplayMaterial(material) {
        if (!material) return material;
        const displayMaterial = new THREE.MeshBasicMaterial({
            color: material.color ? material.color.clone().multiplyScalar(1.12) : new THREE.Color(0xffffff),
            map: material.map ? markTextureSRGB(material.map) : null,
            transparent: !!material.transparent,
            opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
            alphaTest: Number.isFinite(material.alphaTest) ? material.alphaTest : 0,
            side: material.side,
            depthWrite: material.depthWrite !== false,
            fog: false
        });
        displayMaterial.polygonOffset = true;
        displayMaterial.polygonOffsetFactor = 1;
        displayMaterial.polygonOffsetUnits = 1;
        return displayMaterial;
    }

    async function ensureTilesLoaded() {
        ensureTileRoots();
        if (state.tileReady) {
            updateTileTransform(state.tileManifest);
            return true;
        }
        if (state.tileLoadPromise) return state.tileLoadPromise;
        await ensureTileManifestUrl();

        state.tileLoading = true;
        state.tileError = '';
        syncUi();

        state.tileLoadPromise = (async () => {
            const loader = ensureTileLoader();
            const manifest = await getGoogleTileManifest();
            validateTileManifest(manifest);
            updateTileTransform(manifest);
            clearTileSurface();

            const manifestUrl = new URL(state.tileManifestUrl, window.location.href);
            const tileBaseUrl = new URL('./tiles/', manifestUrl).href;
            const tiles = Array.isArray(manifest.tiles) ? manifest.tiles.slice() : [];
            let nextIndex = 0;
            const workers = Array.from({ length: Math.min(4, Math.max(tiles.length, 1)) }, async () => {
                while (nextIndex < tiles.length) {
                    const tile = tiles[nextIndex++];
                    const gltf = await loadGltfScene(tileBaseUrl + tile.file, loader);
                    gltf.scene.traverse((obj) => {
                        if (!obj.isMesh) return;
                        obj.castShadow = false;
                        obj.receiveShadow = true;
                        obj.material = Array.isArray(obj.material)
                            ? obj.material.map((mat) => createTileDisplayMaterial(mat))
                            : createTileDisplayMaterial(obj.material);
                    });
                    tileContentGroup.add(gltf.scene);
                }
            });
            await Promise.all(workers);
            state.tileReady = true;
            state.tileManifest = manifest;
            const solvedOffset = computeTileYOffsetByRaycast();
            if (Number.isFinite(solvedOffset)) {
                state.tileManualYOffset += solvedOffset;
                updateTileTransform(manifest);
            }
            if (state.surfaceMode === 'tiles') frameScene();
            setStatus(`Loaded ${tiles.length} saved Google tiles for this QA view.`);
            return true;
        })().catch((error) => {
            state.tileError = error && error.message ? error.message : 'Unknown Google 3D tile error.';
            clearTileSurface();
            throw error;
        }).finally(() => {
            state.tileLoading = false;
            state.tileLoadPromise = null;
            applySurfaceMode();
            syncUi();
        });
        return state.tileLoadPromise;
    }

    function preloadTiles() {
        ensureTilesLoaded().catch((error) => {
            console.warn('[QA 3D Viewer] Tile preload failed', error);
            setStatus(error && error.message ? error.message : 'Google 3D tiles are unavailable for this project.');
            syncUi();
        });
    }

    async function getGoogleTileManifest(forceReload) {
        await ensureTileManifestUrl();
        if (!forceReload && state.tileManifest) return state.tileManifest;
        const response = await fetch(state.tileManifestUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`3D tile manifest failed to load (${response.status}).`);
        state.tileManifest = await response.json();
        return state.tileManifest;
    }

    function validateTileManifest(manifest) {
        if (!manifest || !manifest.anchor) throw new Error('3D tile manifest is missing its anchor definition.');
        const projectLat = Number(state.manifest && state.manifest.lat);
        const projectLng = Number(state.manifest && state.manifest.lng);
        if (!Number.isFinite(projectLat) || !Number.isFinite(projectLng)) return true;
        const distance = haversineMeters(projectLat, projectLng, manifest.anchor.lat, manifest.anchor.lon);
        const allowance = Math.max(MAX_TILE_PROJECT_DISTANCE_METERS, (manifest.anchor.radiusMeters || 100) * 2);
        if (distance > allowance) throw new Error('The saved Google 3D tile capture does not match this project.');
        return true;
    }

    function updateTileTransform(manifest) {
        ensureTileRoots();
        if (!tileGeospatialRoot || !manifest || !manifest.anchor) return;
        const lat = Number.isFinite(Number(state.manifest && state.manifest.lat)) ? Number(state.manifest.lat) : manifest.anchor.lat;
        const lon = Number.isFinite(Number(state.manifest && state.manifest.lng)) ? Number(state.manifest.lng) : manifest.anchor.lon;
        const anchorECEF = geodeticToECEF(lat, lon, 0);
        const ecefToLocal = makeECEFToEUSMatrix(lat, lon, anchorECEF);
        const scaleMatrix = new THREE.Matrix4().makeScale(getHorizontalSceneUnitsPerMeter(), getZScale(), getHorizontalSceneUnitsPerMeter());
        const translateMatrix = new THREE.Matrix4().makeTranslation(0, (-state.dsmMin * getZScale()) + ELEVATION_OFFSET + state.tileManualYOffset, 0);
        const scaledMatrix = new THREE.Matrix4().multiplyMatrices(scaleMatrix, ecefToLocal);
        const finalMatrix = new THREE.Matrix4().multiplyMatrices(translateMatrix, scaledMatrix);
        tileGeospatialRoot.matrix.copy(finalMatrix);
        tileGeospatialRoot.matrixWorldNeedsUpdate = true;
        tileContentGroup.position.set(0, 0, 0);
        tileCalibrationRoot.position.set(0, 0, 0);
    }

    function geodeticToECEF(latDeg, lonDeg, heightMeters) {
        const a = 6378137.0;
        const e2 = 6.69437999014e-3;
        const lat = THREE.MathUtils.degToRad(latDeg);
        const lon = THREE.MathUtils.degToRad(lonDeg);
        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        const sinLon = Math.sin(lon);
        const cosLon = Math.cos(lon);
        const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        return new THREE.Vector3((n + heightMeters) * cosLat * cosLon, (n + heightMeters) * cosLat * sinLon, (n * (1 - e2) + heightMeters) * sinLat);
    }

    function makeECEFToEUSMatrix(latDeg, lonDeg, anchorECEF) {
        const lat = THREE.MathUtils.degToRad(latDeg);
        const lon = THREE.MathUtils.degToRad(lonDeg);
        const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
        const up = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
        const south = new THREE.Vector3(Math.sin(lat) * Math.cos(lon), Math.sin(lat) * Math.sin(lon), -Math.cos(lat));
        return new THREE.Matrix4().set(
            east.x, east.y, east.z, -east.dot(anchorECEF),
            up.x, up.y, up.z, -up.dot(anchorECEF),
            south.x, south.y, south.z, -south.dot(anchorECEF),
            0, 0, 0, 1
        );
    }

    function haversineMeters(lat1, lon1, lat2, lon2) {
        const toRad = (deg) => deg * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function buildRoofSamplePoints(maxSamples, maxAttempts) {
        if (!state.imageWidth || !state.imageHeight || !state.dsm) return [];
        const sampleLimit = Number.isFinite(maxSamples) ? maxSamples : 60;
        const attemptLimit = Number.isFinite(maxAttempts) ? maxAttempts : 5000;
        const samples = [];
        const seen = new Set();
        const margin = Math.max(3, Math.floor(Math.min(state.imageWidth, state.imageHeight) / 100));
        let attempts = 0;
        while (samples.length < sampleLimit && attempts < attemptLimit) {
            attempts += 1;
            const x = Math.floor(margin + Math.random() * Math.max(1, state.imageWidth - margin * 2));
            const y = Math.floor(margin + Math.random() * Math.max(1, state.imageHeight - margin * 2));
            const key = `${x},${y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const rawHeight = getDsmValue(x, y);
            if (!Number.isFinite(rawHeight) || Math.abs(rawHeight) < 1e-6 || rawHeight <= -9000) continue;
            const dsmSceneHeight = getDsmSceneHeightAtPixel(x, y);
            if (!Number.isFinite(dsmSceneHeight)) continue;
            samples.push({ sceneX: ((x / Math.max(1, state.imageWidth)) - 0.5) * 100, sceneZ: ((y / Math.max(1, state.imageHeight)) - 0.5) * 100 });
        }
        return samples;
    }

    function computeTileYOffsetByRaycast() {
        if (!scene || !surfaceMesh || !tileContentGroup || !state.tileManifest) return null;
        const roofSamples = buildRoofSamplePoints(60, 5000);
        if (!roofSamples.length) return null;
        const sceneBox = new THREE.Box3().setFromObject(surfaceMesh);
        const tileBox = new THREE.Box3().setFromObject(tileContentGroup);
        if (sceneBox.isEmpty() || tileBox.isEmpty()) return null;
        const sourceY = Math.max(sceneBox.max.y, tileBox.max.y) + 20;
        const minY = Math.min(sceneBox.min.y, tileBox.min.y) - 20;
        const rayLength = Math.max(50, sourceY - minY + 10);
        const raycaster = new THREE.Raycaster();
        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3(0, -1, 0);
        const deltas = [];
        const oldHeightVisible = surfaceMesh.visible;
        const oldTileVisible = tileGeospatialRoot.visible;
        surfaceMesh.visible = true;
        tileGeospatialRoot.visible = true;
        scene.updateMatrixWorld(true);
        for (const sample of roofSamples) {
            origin.set(sample.sceneX, sourceY, sample.sceneZ);
            raycaster.set(origin, direction);
            raycaster.far = rayLength;
            const tileHits = raycaster.intersectObject(tileContentGroup, true);
            if (!tileHits.length) continue;
            const heightHits = raycaster.intersectObject(surfaceMesh, true);
            if (!heightHits.length) continue;
            const tileY = tileHits[0].point.y;
            const heightY = heightHits[0].point.y;
            if (Number.isFinite(tileY) && Number.isFinite(heightY)) deltas.push(heightY - tileY);
        }
        surfaceMesh.visible = oldHeightVisible;
        tileGeospatialRoot.visible = oldTileVisible;
        if (deltas.length < 12) return null;
        const low = getQuantile(deltas, 0.2);
        const high = getQuantile(deltas, 0.8);
        const trimmed = deltas.filter((value) => value >= low && value <= high);
        const average = trimmed.length ? (trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length) : getQuantile(deltas, 0.5);
        return Number.isFinite(average) ? average : null;
    }

    function getQuantile(values, q) {
        if (!values || !values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
        return sorted[idx];
    }

    function applySurfaceMode() {
        const showTiles = state.surfaceMode === 'tiles' && state.tileReady;
        const showHeight = !showTiles;
        if (surfaceMesh) surfaceMesh.visible = showHeight;
        if (tileGeospatialRoot) tileGeospatialRoot.visible = showTiles;
        scene.background = new THREE.Color(showTiles ? 0x17181b : 0x202124);
        if (renderer) {
            const targetPixelRatio = showTiles ? Math.max(window.devicePixelRatio || 1, GOOGLE_TILE_RENDER_PIXEL_RATIO) : (window.devicePixelRatio || 1);
            if (typeof renderer.getPixelRatio === 'function' && Math.abs(renderer.getPixelRatio() - targetPixelRatio) > 0.01) {
                renderer.setPixelRatio(targetPixelRatio);
                renderer.setSize(canvasWrap.clientWidth || 1, canvasWrap.clientHeight || 1, false);
            }
            if ('outputEncoding' in renderer) {
                if (showTiles && typeof THREE.sRGBEncoding !== 'undefined') renderer.outputEncoding = THREE.sRGBEncoding;
                if (!showTiles && typeof THREE.LinearEncoding !== 'undefined') renderer.outputEncoding = THREE.LinearEncoding;
            }
            if ('toneMapping' in renderer && typeof THREE.NoToneMapping !== 'undefined') renderer.toneMapping = THREE.NoToneMapping;
        }
    }

    function syncUi() {
        if (surfaceBtn) {
            const showingTiles = state.surfaceMode === 'tiles';
            surfaceBtn.textContent = state.tileLoading ? `SURF: ${showingTiles ? 'TILES' : 'DSM'}...` : `SURF: ${showingTiles ? 'TILES' : 'DSM'}`;
            surfaceBtn.classList.toggle('active', showingTiles);
            surfaceBtn.title = showingTiles ? 'Switch back to the DSM surface.' : 'Switch from the DSM surface to the saved Google 3D tiles.';
        }
        if (rotateBtn) {
            rotateBtn.classList.toggle('active', state.autoRotate);
            rotateBtn.textContent = state.autoRotate ? 'ROTATE' : 'ROTATE OFF';
            rotateBtn.title = state.autoRotate ? 'Auto orbit is on. Click to stop it.' : 'Auto orbit is off. Click to restart the slow hover orbit.';
        }
        if (facesBtn) {
            facesBtn.classList.toggle('active', state.showFaces);
            facesBtn.textContent = state.showFaces ? 'FACES' : 'FACES OFF';
        }
        if (typesBtn) {
            typesBtn.classList.toggle('active', state.showTypeColors);
            typesBtn.textContent = state.showTypeColors ? 'TYPES' : 'TYPES OFF';
        }
        if (measuresBtn) {
            measuresBtn.classList.toggle('active', state.showMeasurements);
            measuresBtn.textContent = state.showMeasurements ? 'MEAS' : 'MEAS OFF';
        }
        updateLegend();
        if (state.tileError && state.surfaceMode !== 'tiles') setStatus(state.tileError);
    }

    function resizeRenderer() {
        if (!renderer || !camera || !canvasWrap) return;
        const width = Math.max(1, canvasWrap.clientWidth || 1);
        const height = Math.max(1, canvasWrap.clientHeight || 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    function startAnimationLoop() {
        if (animationFrameId) return;
        const loop = () => {
            animationFrameId = window.requestAnimationFrame(loop);
            if (!renderer || !scene || !camera) return;
            if (controls) {
                controls.autoRotate = !!state.autoRotate;
            controls.update();
        }
        updateViewportScaledLines();
        updatePointMarkersForViewport();
        updateMeasurementSpritesForViewport();
        renderer.render(scene, camera);
        };
        loop();
    }

    function updateViewportScaledLines() {
        if (!wireframeGroup || !camera || !renderer) return;
        const viewportHeight = Math.max(1, renderer.domElement.clientHeight || 1);
        const fovRad = THREE.MathUtils.degToRad(camera.fov || 50);
        wireframeGroup.children.forEach((child) => {
            const baseRadius = Number(child && child.userData && child.userData.viewportLineBaseRadius);
            const desiredPx = Number(child && child.userData && child.userData.viewportLinePx);
            if (!child || !child.isMesh || !(baseRadius > 0) || !(desiredPx > 0)) return;
            const distance = Math.max(0.1, camera.position.distanceTo(child.position));
            const worldPerPixel = (2 * distance * Math.tan(fovRad * 0.5)) / viewportHeight;
            const targetRadius = Math.max(0.01, worldPerPixel * desiredPx * 0.5);
            const scale = targetRadius / baseRadius;
            child.scale.set(scale, 1, scale);
        });
    }

    function updateMeasurementSpritesForViewport() {
        if (!measurementGroup || !camera || !renderer || !measurementGroup.visible) return;
        const viewportHeight = Math.max(1, renderer.domElement.clientHeight || 1);
        const fovRad = THREE.MathUtils.degToRad(camera.fov || 50);
        measurementGroup.children.forEach((sprite) => {
            if (!sprite || !sprite.isSprite) return;
            const distance = Math.max(0.1, camera.position.distanceTo(sprite.position));
            const worldPerPixel = (2 * distance * Math.tan(fovRad * 0.5)) / viewportHeight;
            const widthPx = Math.max(24, Number(sprite.userData.labelPxWidth) || 36);
            const heightPx = Math.max(14, Number(sprite.userData.labelPxHeight) || 18);
            sprite.scale.set(widthPx * worldPerPixel, heightPx * worldPerPixel, 1);
        });
    }

    function updatePointMarkersForViewport() {
        if (!pointMarkerGroup || !camera || !renderer) return;
        const viewportHeight = Math.max(1, renderer.domElement.clientHeight || 1);
        const fovRad = THREE.MathUtils.degToRad(camera.fov || 50);
        pointMarkerGroup.children.forEach((sprite) => {
            if (!sprite || !sprite.isSprite) return;
            const distance = Math.max(0.1, camera.position.distanceTo(sprite.position));
            const worldPerPixel = (2 * distance * Math.tan(fovRad * 0.5)) / viewportHeight;
            const sizePx = Math.max(4, Number(sprite.userData.markerPxSize) || 8);
            const size = sizePx * worldPerPixel;
            sprite.scale.set(size, size, 1);
        });
    }

    function loadGltfScene(url, loader) {
        return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    }

    function clearGroup(group) {
        if (!group) return;
        while (group.children.length > 0) {
            const child = group.children[0];
            group.remove(child);
            disposeObject3D(child);
        }
    }

    function disposeObject3D(object) {
        if (!object) return;
        object.traverse((child) => {
            if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
            if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach((material) => {
                    if (!material) return;
                    ['map', 'alphaMap', 'emissiveMap', 'aoMap', 'lightMap', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach((key) => {
                        if (material[key] && typeof material[key].dispose === 'function') material[key].dispose();
                    });
                    if (typeof material.dispose === 'function') material.dispose();
                });
            }
        });
    }

    function showOverlay(title, copy) {
        if (!overlayEl) return;
        overlayEl.classList.remove('hidden');
        overlayEl.innerHTML = `
            <div class="qa3d-overlay-card">
                <i class="fas fa-cube"></i>
                <div class="title">${escapeHtml(title || 'Loading')}</div>
                <div class="copy">${escapeHtml(copy || '')}</div>
            </div>
        `;
    }

    function hideOverlay() {
        if (!overlayEl) return;
        overlayEl.classList.add('hidden');
    }

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text || '';
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
