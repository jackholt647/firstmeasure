<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QA Map Viewer</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #202124;
            font-family: "Segoe UI", Roboto, sans-serif;
        }
        #qaMapViewerRoot {
            position: relative;
            width: 100%;
            height: 100%;
            background: #202124;
        }
        #qaMapCanvasWrap {
            position: absolute;
            inset: 0;
        }
        .qa-map-pane {
            position: absolute;
            inset: 0;
        }
        .qa-map-pane.hidden {
            display: none;
        }
        #qaMapSinglePane.hidden,
        #qaMapQuadGrid.hidden {
            display: none !important;
        }
        #qaMapQuadGrid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 2px;
            background: #1f1f1f;
            padding: 2px;
            box-sizing: border-box;
        }
        .qa-map-cell {
            position: relative;
            overflow: hidden;
            background: #161616;
        }
        #qaMapSingle,
        .qa-map-cell .map {
            position: absolute;
            inset: 0;
        }
        .qa-map-overlay {
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
        .qa-map-overlay.hidden {
            display: none;
        }
        .qa-map-overlay-card {
            max-width: 360px;
        }
        .qa-map-overlay-card i {
            font-size: 22px;
            margin-bottom: 10px;
            opacity: 0.86;
        }
        .qa-map-overlay-card .title {
            font-size: 15px;
            font-weight: 800;
            margin-bottom: 6px;
        }
        .qa-map-overlay-card .copy {
            font-size: 12px;
            line-height: 1.45;
            opacity: 0.82;
        }
    </style>
</head>
<body>
    <div id="qaMapViewerRoot">
        <div id="qaMapCanvasWrap">
            <div id="qaMapSinglePane" class="qa-map-pane hidden">
                <div id="qaMapSingle" class="map"></div>
            </div>
            <div id="qaMapQuadGrid" class="qa-map-pane">
                <div class="qa-map-cell"><div id="qaMapNorth" class="map"></div></div>
                <div class="qa-map-cell"><div id="qaMapEast" class="map"></div></div>
                <div class="qa-map-cell"><div id="qaMapSouth" class="map"></div></div>
                <div class="qa-map-cell"><div id="qaMapWest" class="map"></div></div>
            </div>
        </div>
        <div id="qaMapOverlay" class="qa-map-overlay">
            <div class="qa-map-overlay-card">
                <i class="fas fa-map-marked-alt"></i>
                <div class="title">Loading Map Viewer</div>
                <div class="copy">Preparing the live Google Maps quad view and single-map controls for this project.</div>
            </div>
        </div>
    </div>
    <script src="../portal_scripts/qa_map_viewer.js?v=2"></script>
</body>
</html>
