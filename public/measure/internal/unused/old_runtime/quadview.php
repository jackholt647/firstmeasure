<?php
require_once __DIR__ . '/_storage.php';
// Simulated backend for random addresses if addresses.json is missing
// In a real scenario, this would read your actual addresses.json file.
$addresses_json_url = storagePublicRelativePath('data/addresses.json'); 
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quad-View Property Inspector</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        :root {
            --primary: #d93025;
            --bg: #f0f2f5;
            --card-bg: #ffffff;
            --text: #202124;
        }

        body {
            margin: 0; padding: 0;
            background: var(--bg);
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* --- HEADER / CONTROLS --- */
        .controls-bar {
            background: var(--card-bg);
            padding: 15px 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 15px;
            z-index: 10;
        }
        
        h1 { margin: 0 20px 0 0; font-size: 20px; color: var(--primary); display:flex; align-items:center; gap:10px; }

        .input-group {
            display: flex;
            flex: 1;
            max-width: 800px;
            position: relative;
        }

        input {
            flex: 1;
            padding: 12px 15px;
            border: 1px solid #dadce0;
            border-right: none;
            border-radius: 8px 0 0 8px;
            font-size: 16px;
            outline: none;
        }
        input:focus { border-color: var(--primary); }

        .btn {
            padding: 0 20px;
            border: 1px solid #dadce0;
            background: #f8f9fa;
            cursor: pointer;
            font-weight: 600;
            color: #5f6368;
            transition: 0.2s;
            display: flex; align-items: center; gap: 8px;
        }
        .btn:hover { background: #e8eaed; color: #202124; }
        
        .btn-random { border-radius: 0; border-left: 1px solid #dadce0; }
        .btn-go { 
            border-radius: 0 8px 8px 0; 
            background: var(--primary); 
            color: white; 
            border-color: var(--primary);
        }
        .btn-go:hover { background: #b0261e; }

        /* --- GRID LAYOUT --- */
        .grid-container {
            flex: 1;
            padding: 20px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 20px;
            overflow: hidden;
        }

        .map-card {
            background: var(--card-bg);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
            display: flex;
            flex-direction: column;
            position: relative;
        }

        .map-header {
            padding: 10px 15px;
            font-size: 12px;
            font-weight: 700;
            color: #777;
            text-transform: uppercase;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .map-canvas {
            flex: 1;
            background: #e8eaed;
            position: relative;
        }

        /* Compass Label Overlay */
        .compass-label {
            position: absolute;
            top: 15px; left: 15px;
            background: rgba(255,255,255,0.9);
            padding: 5px 10px;
            border-radius: 4px;
            font-weight: 800;
            font-size: 14px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            z-index: 5;
            color: var(--primary);
        }

        /* Download Button specific */
        .btn-download {
            font-size: 11px;
            padding: 4px 8px;
            border-radius: 4px;
            text-decoration: none;
            background: #f1f3f4;
            color: #333;
            border: 1px solid #ccc;
        }
        .btn-download:hover { background: #fff; border-color: var(--primary); color: var(--primary); }

        .loading-overlay {
            position: absolute; top:0; left:0; width:100%; height:100%;
            background: rgba(255,255,255,0.8);
            display: none; align-items: center; justify-content: center;
            z-index: 20; font-weight: 600; color: #555;
        }

        /* Mobile Adjust */
        @media (max-width: 768px) {
            .grid-container { grid-template-columns: 1fr; overflow-y: auto; height: auto; }
            .map-card { height: 300px; }
            .controls-bar { flex-direction: column; height: auto; }
            .input-group { width: 100%; }
        }
    </style>
</head>
<body>

    <div class="controls-bar">
        <h1><i class="fas fa-cube"></i> Quad-View</h1>
        
        <div class="input-group">
            <input type="text" id="addressInput" placeholder="Enter property address..." autocomplete="off">
            <button class="btn btn-random" onclick="fetchRandomAddress()" title="Random Address">
                <i class="fas fa-dice"></i>
            </button>
            <button class="btn btn-go" onclick="processAddress()">
                <span>Inspect</span>
            </button>
        </div>
    </div>

    <div class="grid-container" id="gridArea">
        <!-- North -->
        <div class="map-card">
            <div class="map-header">
                <span><i class="fas fa-arrow-up"></i> North Facing</span>
                <a href="#" id="dl-N" class="btn-download" target="_blank" download="north.png"><i class="fas fa-download"></i> Save Image</a>
            </div>
            <div class="map-canvas" id="mapN"></div>
            <div class="compass-label">N</div>
            <div class="loading-overlay" id="loadN">Loading View...</div>
        </div>

        <!-- East -->
        <div class="map-card">
            <div class="map-header">
                <span><i class="fas fa-arrow-right"></i> East Facing</span>
                <a href="#" id="dl-E" class="btn-download" target="_blank" download="east.png"><i class="fas fa-download"></i> Save Image</a>
            </div>
            <div class="map-canvas" id="mapE"></div>
            <div class="compass-label">E</div>
            <div class="loading-overlay" id="loadE">Loading View...</div>
        </div>

        <!-- South -->
        <div class="map-card">
            <div class="map-header">
                <span><i class="fas fa-arrow-down"></i> South Facing</span>
                <a href="#" id="dl-S" class="btn-download" target="_blank" download="south.png"><i class="fas fa-download"></i> Save Image</a>
            </div>
            <div class="map-canvas" id="mapS"></div>
            <div class="compass-label">S</div>
            <div class="loading-overlay" id="loadS">Loading View...</div>
        </div>

        <!-- West -->
        <div class="map-card">
            <div class="map-header">
                <span><i class="fas fa-arrow-left"></i> West Facing</span>
                <a href="#" id="dl-W" class="btn-download" target="_blank" download="west.png"><i class="fas fa-download"></i> Save Image</a>
            </div>
            <div class="map-canvas" id="mapW"></div>
            <div class="compass-label">W</div>
            <div class="loading-overlay" id="loadW">Loading View...</div>
        </div>
    </div>

    <!-- API KEY FROM CONTEXT -->
    <script src="https://maps.googleapis.com/maps/api/js?key=REMOVED_CREDENTIAL&v=3.64&libraries=places&callback=initApp" async defer></script>

    <script>
        let maps = {}; 
        let geocoder;
        // Key is needed for Static Map generation links
        const API_KEY = "REMOVED_CREDENTIAL"; 

        function initApp() {
            geocoder = new google.maps.Geocoder();
            
            // Initialize Autocomplete
            const input = document.getElementById("addressInput");
            const autocomplete = new google.maps.places.Autocomplete(input);
            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (place.geometry) {
                    updateQuadView(place.geometry.location);
                }
            });

            // Initialize the 4 empty maps
            initQuadMaps();

            // Allow "Enter" key
            input.addEventListener("keypress", function(event) {
                if (event.key === "Enter") processAddress();
            });
        }

        function initQuadMaps() {
            const config = {
                zoom: 20, // High zoom required for 45 deg imagery
                mapTypeId: 'satellite',
                tilt: 45,
                disableDefaultUI: true, // Clean "photo" look
                draggable: true, 
                scrollwheel: true
            };

            // Create 4 independent map instances
            maps.N = new google.maps.Map(document.getElementById('mapN'), { ...config, heading: 0 });
            maps.E = new google.maps.Map(document.getElementById('mapE'), { ...config, heading: 90 });
            maps.S = new google.maps.Map(document.getElementById('mapS'), { ...config, heading: 180 });
            maps.W = new google.maps.Map(document.getElementById('mapW'), { ...config, heading: 270 });
            
            // Set a default center (Center of US) so it's not grey
            const startLoc = { lat: 39.8283, lng: -98.5795 };
            Object.values(maps).forEach(m => { m.setCenter(startLoc); m.setZoom(4); m.setTilt(0); });
        }

        function processAddress() {
            const address = document.getElementById('addressInput').value;
            if(!address) return;

            geocoder.geocode({ 'address': address }, function(results, status) {
                if (status === 'OK') {
                    updateQuadView(results[0].geometry.location);
                } else {
                    alert('Geocode was not successful: ' + status);
                }
            });
        }

        function updateQuadView(location) {
            const lat = location.lat();
            const lng = location.lng();

            // Show loading overlays
            ['N','E','S','W'].forEach(d => document.getElementById(`load${d}`).style.display = 'flex');

            // Update Maps
            updateSingleMap(maps.N, location, 0, 'N');
            updateSingleMap(maps.E, location, 90, 'E');
            updateSingleMap(maps.S, location, 180, 'S');
            updateSingleMap(maps.W, location, 270, 'W');

            // Generate Static Map Download Links
            // Note: fov=45 is implied in satellite mode usually, but Static API uses simple rotation
            updateDownloadLink('dl-N', lat, lng, 0);
            updateDownloadLink('dl-E', lat, lng, 90);
            updateDownloadLink('dl-S', lat, lng, 180);
            updateDownloadLink('dl-W', lat, lng, 270);
        }

        function updateSingleMap(mapInstance, location, heading, id) {
            mapInstance.setCenter(location);
            mapInstance.setZoom(20); 
            mapInstance.setHeading(heading);
            mapInstance.setTilt(45);
            
            // Slight delay to hide loader after tiles render (simulated)
            setTimeout(() => {
                document.getElementById(`load${id}`).style.display = 'none';
            }, 1000);
        }

        function updateDownloadLink(elementId, lat, lng, heading) {
            // Construct Google Static Maps URL
            // scale=2 for high res
            const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=600x400&maptype=satellite&heading=${heading}&scale=2&key=${API_KEY}`;
            document.getElementById(elementId).href = url;
        }

        async function fetchRandomAddress() {
            try {
                // Tries to fetch from addresses.json, falls back to a hardcoded list if file is missing
                let addrList = [];
                try {
                    const res = await fetch('storage/data/addresses.json');
                    if(res.ok) addrList = await res.json();
                } catch(e) { console.log("JSON load failed, using fallback"); }

                // Fallback list if JSON is missing
                if(addrList.length === 0) {
                    addrList = [
                        "1600 Pennsylvania Avenue NW, Washington, DC",
                        "350 Fifth Avenue, New York, NY",
                        "405 Lexington Ave, New York, NY",
                        "600 E Grand Ave, Chicago, IL",
                        "400 Broad St, Seattle, WA"
                    ];
                }

                const randomAddr = addrList[Math.floor(Math.random() * addrList.length)];
                document.getElementById('addressInput').value = randomAddr;
                processAddress();

            } catch(e) {
                alert("Could not load random address");
            }
        }
    </script>
</body>
</html>
