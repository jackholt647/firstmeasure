<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QA 3D Viewer</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <script src="https://cdn.jsdelivr.net/npm/geotiff"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js"></script>
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #202124;
            font-family: "Segoe UI", Roboto, sans-serif;
        }
        #qa3dViewerRoot {
            position: relative;
            width: 100%;
            height: 100%;
            background: radial-gradient(circle at top, #2b2d31 0%, #18191c 78%);
        }
        #qa3dCanvasWrap {
            position: absolute;
            inset: 0;
        }
        #qa3dCanvasWrap canvas {
            display: block;
            width: 100%;
            height: 100%;
        }
        .qa3d-controls {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 20;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            padding: 8px;
            max-width: min(92vw, 520px);
            background: rgba(17, 17, 17, 0.52);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 10px;
        }
        .qa3d-btn {
            border: 1px solid rgba(255, 255, 255, 0.24);
            background: rgba(0, 0, 0, 0.34);
            color: #fff;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            padding: 7px 10px;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }
        .qa3d-btn:hover {
            background: rgba(255, 255, 255, 0.12);
            border-color: rgba(255, 255, 255, 0.4);
        }
        .qa3d-btn.active {
            background: rgba(26, 115, 232, 0.26);
            color: #8ab4f8;
            border-color: rgba(138, 180, 248, 0.6);
        }
        .qa3d-status {
            position: absolute;
            left: 12px;
            bottom: 12px;
            z-index: 20;
            max-width: min(70%, 420px);
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(17, 17, 17, 0.56);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: rgba(255, 255, 255, 0.9);
            font-size: 11px;
            font-weight: 600;
            line-height: 1.4;
            backdrop-filter: blur(8px);
        }
        .qa3d-legend {
            position: absolute;
            right: 12px;
            bottom: 12px;
            z-index: 20;
            min-width: 148px;
            max-width: min(42%, 260px);
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(17, 17, 17, 0.62);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: rgba(255, 255, 255, 0.92);
            font-size: 11px;
            line-height: 1.35;
            backdrop-filter: blur(8px);
        }
        .qa3d-legend.hidden {
            display: none;
        }
        .qa3d-legend-title {
            font-size: 11px;
            font-weight: 900;
            letter-spacing: 0.2px;
            margin-bottom: 6px;
        }
        .qa3d-legend-list {
            display: grid;
            gap: 4px;
        }
        .qa3d-legend-item {
            display: flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
        }
        .qa3d-legend-swatch {
            width: 14px;
            height: 3px;
            border-radius: 999px;
            flex: 0 0 auto;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16);
        }
        .qa3d-legend-label {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .qa3d-overlay {
            position: absolute;
            inset: 0;
            z-index: 15;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.9);
            background: rgba(20, 20, 20, 0.34);
            backdrop-filter: blur(4px);
        }
        .qa3d-overlay.hidden {
            display: none;
        }
        .qa3d-overlay-card {
            max-width: 360px;
        }
        .qa3d-overlay-card i {
            font-size: 22px;
            margin-bottom: 10px;
            opacity: 0.86;
        }
        .qa3d-overlay-card .title {
            font-size: 15px;
            font-weight: 800;
            margin-bottom: 6px;
        }
        .qa3d-overlay-card .copy {
            font-size: 12px;
            line-height: 1.45;
            opacity: 0.82;
        }
    </style>
</head>
<body>
    <div id="qa3dViewerRoot">
        <div class="qa3d-controls">
            <button id="qa3dSurfaceBtn" class="qa3d-btn">SURF: DSM</button>
            <button id="qa3dFacesBtn" class="qa3d-btn active">FACES</button>
            <button id="qa3dTypesBtn" class="qa3d-btn active">TYPES</button>
            <button id="qa3dMeasuresBtn" class="qa3d-btn active">MEAS</button>
            <button id="qa3dRotateBtn" class="qa3d-btn active">ROTATE</button>
        </div>
        <div id="qa3dCanvasWrap"></div>
        <div id="qa3dOverlay" class="qa3d-overlay">
            <div class="qa3d-overlay-card">
                <i class="fas fa-cube"></i>
                <div class="title">Loading 3D Viewer</div>
                <div class="copy">Preparing the DSM surface, wireframe, and any saved Google 3D tiles for this project.</div>
            </div>
        </div>
        <div id="qa3dStatus" class="qa3d-status">Waiting for project data...</div>
        <div id="qa3dLegend" class="qa3d-legend hidden"></div>
    </div>
    <script src="../portal_scripts/qa_3d_viewer.js?v=9"></script>
</body>
</html>

