/* quad_view.js - Quad View with Clear UI and Auto-Crop */

/**
 * Helper to animate the main UI button upon success.
 * Turns the button green, pulses it, and adds a checkmark.
 */
function setQuadButtonSuccess() {
    // Try to find the button by ID (added in editor.php)
    let btn = document.getElementById('btnQuadView');
    
    // Fallback: Try to find by onclick attribute if ID is missing
    if (!btn) {
        btn = document.querySelector('button[onclick="launchQuadView()"]');
    }

    if (!btn) return;

    // Apply Transition Styles
    btn.style.transition = 'all 0.4s ease';
    btn.style.backgroundColor = '#4CAF50'; // Green
    btn.style.borderColor = '#4CAF50';
    btn.style.color = 'white';
    
    // Change Icon/Text
    btn.innerHTML = '<i class="fas fa-check-circle"></i> Quad Saved';

    // Pulse Animation
    btn.style.transform = 'scale(1.15)';
    
    // Settle back to normal size
    setTimeout(() => {
        btn.style.transform = 'scale(1)';
    }, 300);
}

/**
 * Main Trigger Function
 * Call this function to open the Quad View overlay.
 */
window.launchQuadView = function() {
    if (typeof window.firstMeasureAreQuadViewsDisabled === 'function' && window.firstMeasureAreQuadViewsDisabled()) {
        return;
    }
    if (window.__quadTiltAvailable !== true) {
        const msg = window.__quadTiltAvailable === false
            ? "Quad view is unavailable for this property because Google did not return all four oblique angles."
            : "Quad view availability is still being checked. Try again in a moment.";
        alert(msg);
        return;
    }

    // 1. Check for Google Maps API
    if (typeof google === 'undefined' || typeof google.maps === 'undefined') {
        console.error("QuadView Error: Google Maps API is not loaded.");
        alert("Google Maps API not ready.");
        return;
    }

    let lat = 0;
    let lng = 0;

    // --- COORDINATE STRATEGIES ---
    try {
        if (window.__structureLocalImageryActive && typeof window.getStructureModeGlobalCenter === 'function') {
            const globalCenter = window.getStructureModeGlobalCenter();
            if (globalCenter) {
                lat = Number(globalCenter.lat);
                lng = Number(globalCenter.lng);
            }
        }
    } catch (e) {}

    try {
        if ((!lat || !lng) && typeof googleJsMap !== 'undefined' && googleJsMap && typeof googleJsMap.getCenter === 'function') {
            const c = googleJsMap.getCenter();
            lat = c.lat();
            lng = c.lng();
        }
    } catch (e) {}

    if (!lat || !lng) {
        try {
            if (typeof mapCenterLat !== 'undefined') { lat = parseFloat(mapCenterLat); lng = parseFloat(mapCenterLng); }
        } catch (e) {}
    }

    if (!lat || !lng && window.mapCenterLat) {
        lat = parseFloat(window.mapCenterLat);
        lng = parseFloat(window.mapCenterLng);
    }

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
        alert("No valid coordinates found.");
        return;
    }

    // --- PRIMARY COLOR: Use org branding if available, fallback to default red ---
    const primaryColor = '#666666';

    // 2. Inject @font-face for Montserrat if not already present
    if (!document.getElementById('montserrat-font')) {
        const fontStyle = document.createElement('style');
        fontStyle.id = 'montserrat-font';
        fontStyle.textContent = `
            @font-face {
                font-family: 'Montserrat-Regular';
                src: url('/fonts/Montserrat-Regular.ttf') format('truetype');
                font-weight: normal;
                font-style: normal;
            }
        `;
        document.head.appendChild(fontStyle);
    }

    // 3. Create DOM Structure
    const overlayId = 'quad-view-overlay';
    const existing = document.getElementById(overlayId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = overlayId;
    
    Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        backgroundColor: '#1a1a1a', zIndex: '10000', display: 'flex',
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        fontFamily: 'sans-serif'
    });

    // --- LAYOUT CONSTANTS ---
    const pad = 4.5;          // vh - grid padding
    const gapSize = 4.5;      // vh - grid gap
    const headerH = 3.94;     // vh - header height (25% thinner)
    const borderW = 0.24;     // vh - grey border width
    const borderColor = '#bbb';
    const shadowColor = '#d5d5d5';
    const borderRad = '1.2vh';
    const shadowOffset = 0.6; // vh - shadow offset distance
    const gridW = 89;          // vh - grid width

    // Cell width from grid
    const cellW = (gridW - 2 * pad - gapSize) / 2;
    // Cell height = square map area + header on top
    const cellH = cellW + headerH;
    // Total grid height
    const gridH = 2 * cellH + gapSize + 2 * pad;

    // 3. Grid Container
    const gridContainer = document.createElement('div');
    Object.assign(gridContainer.style, {
        width: gridW + 'vh',
        height: gridH + 'vh',
        boxSizing: 'border-box',
        padding: pad + 'vh',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: gapSize + 'vh',
        backgroundColor: 'white',
        flexShrink: '0'
    });

    // 4. Sidebar
    const sidebar = document.createElement('div');
    Object.assign(sidebar.style, {
        width: '200px', height: '100vh', backgroundColor: '#222',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '20px', gap: '15px', borderLeft: '1px solid #444',
        position: 'absolute', right: '0', top: '0', boxSizing: 'border-box'
    });

    const title = document.createElement('h3');
    title.innerText = "Quad View";
    title.style.color = '#fff';
    title.style.margin = '0 0 10px 0';
    title.style.fontSize = '18px';
    sidebar.appendChild(title);

    const statusText = document.createElement('div');
    statusText.innerText = "Waiting for upload...";
    Object.assign(statusText.style, {
        color: '#aaa', fontSize: '12px', textAlign: 'center',
        marginBottom: '10px', width: '100%'
    });

    // --- IMAGE PROCESSING ---

    function cropImageFromCanvas(sourceCanvas) {
        const ctx = sourceCanvas.getContext('2d');
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const pix = ctx.getImageData(0, 0, w, h).data;
        const isWhite = (r, g, b) => r > 240 && g > 240 && b > 240;

        let top = 0, bottom = h, left = 0, right = w;

        for (let y = 0; y < h; y++) {
            let rowHasColor = false;
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (!isWhite(pix[i], pix[i+1], pix[i+2])) { rowHasColor = true; break; }
            }
            if (rowHasColor) { top = y; break; }
        }
        for (let y = h - 1; y >= 0; y--) {
            let rowHasColor = false;
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (!isWhite(pix[i], pix[i+1], pix[i+2])) { rowHasColor = true; break; }
            }
            if (rowHasColor) { bottom = y + 1; break; }
        }
        for (let x = 0; x < w; x++) {
            let colHasColor = false;
            for (let y = top; y < bottom; y++) {
                const i = (y * w + x) * 4;
                if (!isWhite(pix[i], pix[i+1], pix[i+2])) { colHasColor = true; break; }
            }
            if (colHasColor) { left = x; break; }
        }
        for (let x = w - 1; x >= 0; x--) {
            let colHasColor = false;
            for (let y = top; y < bottom; y++) {
                const i = (y * w + x) * 4;
                if (!isWhite(pix[i], pix[i+1], pix[i+2])) { colHasColor = true; break; }
            }
            if (colHasColor) { right = x + 1; break; }
        }

        const cropW = right - left;
        const cropH = bottom - top;
        if (cropW <= 0 || cropH <= 0) return null;

        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = cropW;
        croppedCanvas.height = cropH;
        croppedCanvas.getContext('2d').drawImage(sourceCanvas, left, top, cropW, cropH, 0, 0, cropW, cropH);
        return croppedCanvas;
    }

    // --- CONTROLS ---

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    const btnUpload = createPanelButton('📤 Upload Image', '#2196F3', () => fileInput.click());

    let processedCanvas = null;
    const btnDownload = createPanelButton('💾 Save Cropped', '#4CAF50', () => {
        if (!processedCanvas) return;
        const link = document.createElement('a');
        link.download = 'quad_view_cropped.png';
        link.href = processedCanvas.toDataURL();
        link.click();
        statusText.innerText = "Image Saved!";
    });
    btnDownload.style.opacity = '0.4';
    btnDownload.style.cursor = 'not-allowed';

    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        statusText.innerText = "Processing...";
        statusText.style.color = '#FFEB3B';

        const reader = new FileReader();
        reader.onload = (evt) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const result = cropImageFromCanvas(canvas);
                
                if (result) {
                    processedCanvas = result;
                    window.quadViewCroppedImage = result.toDataURL('image/png');
                    
                    const step4 = document.getElementById('step4');
                    if(step4) step4.classList.add('done');

                    statusText.innerText = "Success! Closing...";
                    statusText.style.color = '#4CAF50';
                    btnDownload.style.opacity = '1';
                    btnDownload.style.cursor = 'pointer';

                    setQuadButtonSuccess();

                    setTimeout(() => {
                        if (overlay) overlay.remove();
                    }, 800);

                } else {
                    statusText.innerText = "Error: Image was all white.";
                    statusText.style.color = '#f44336';
                }
            };
            img.src = evt.target.result;
        };
        reader.readAsDataURL(file);
    };

    const btnClose = createPanelButton('✕ Close View', '#d32f2f', () => overlay.remove());
    btnClose.style.marginTop = 'auto';

    sidebar.appendChild(btnUpload);
    sidebar.appendChild(statusText);
    sidebar.appendChild(btnDownload);
    sidebar.appendChild(btnClose);
    sidebar.appendChild(fileInput);

    // 5. Initialize Maps
    const views = [
        { label: 'North View', heading: 180 },  { label: 'South View', heading: 0 },
        { label: 'East View', heading: 270 },   { label: 'West View', heading: 90 }
    ];

    views.forEach(view => {
        // --- STRUCTURE ---
        // mapWrapper: outer shell, no border, carries the offset shadow for the whole panel
        //   ├── headerBar: colored, rounded top corners, no grey border
        //   └── mapContainer: grey border on left/right/bottom, overflow:hidden, holds map

        const mapWrapper = document.createElement('div');
        Object.assign(mapWrapper.style, {
            position: 'relative',
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'visible',
            borderRadius: borderRad,
            border: 'none',
            boxShadow: shadowOffset + 'vh ' + shadowOffset + 'vh 0 0 ' + shadowColor,
            boxSizing: 'border-box',
            backgroundColor: 'transparent'
        });

        // Colored header bar - no grey border, just the color
        const headerBar = document.createElement('div');
        Object.assign(headerBar.style, {
            width: '100%',
            height: headerH + 'vh',
            minHeight: headerH + 'vh',
            flexShrink: '0',
            backgroundColor: primaryColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: borderRad + ' ' + borderRad + ' 0 0',
            boxSizing: 'border-box'
        });

        const labelText = document.createElement('span');
        labelText.innerText = view.label;
        Object.assign(labelText.style, {
            color: 'white',
            fontSize: '1.6vh',
            fontFamily: "'Montserrat-Regular', sans-serif",
            fontWeight: 'bold',
            letterSpacing: '0.1vh',
            pointerEvents: 'none'
        });
        headerBar.appendChild(labelText);

        // Map container - grey border on left/right/bottom only, clips the map
        const mapContainer = document.createElement('div');
        Object.assign(mapContainer.style, {
            flex: '1',
            width: '100%',
            minHeight: '0',
            position: 'relative',
            overflow: 'hidden',
            borderLeft: borderW + 'vh solid ' + borderColor,
            borderRight: borderW + 'vh solid ' + borderColor,
            borderBottom: borderW + 'vh solid ' + borderColor,
            borderTop: 'none',
            borderRadius: '0 0 ' + borderRad + ' ' + borderRad,
            boxSizing: 'border-box'
        });

        // The actual map element inside the container
        const mapEl = document.createElement('div');
        Object.assign(mapEl.style, {
            position: 'absolute',
            top: '0', left: '0',
            width: '100%', height: '100%'
        });

        mapContainer.appendChild(mapEl);
        mapWrapper.appendChild(headerBar);
        mapWrapper.appendChild(mapContainer);
        gridContainer.appendChild(mapWrapper);

        setTimeout(() => {
            new google.maps.Map(mapEl, {
                center: { lat: lat, lng: lng }, zoom: 22, mapTypeId: 'satellite',
                heading: view.heading, tilt: 45, disableDefaultUI: true, gestureHandling: 'cooperative'
            });
        }, 100);
    });

    overlay.appendChild(gridContainer);
    overlay.appendChild(sidebar);
    document.body.appendChild(overlay);
};

// Helper: Rectangular Control Button
function createPanelButton(text, bgColor, onClick) {
    const btn = document.createElement('button');
    btn.innerText = text;
    Object.assign(btn.style, {
        width: '100%', padding: '12px 10px', borderRadius: '4px', border: 'none',
        backgroundColor: bgColor, color: 'white', fontSize: '14px', fontWeight: 'bold',
        cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', transition: 'all 0.1s'
    });
    btn.onmousedown = () => btn.style.transform = 'scale(0.98)';
    btn.onmouseup = () => btn.style.transform = 'scale(1)';
    if(onClick) btn.onclick = onClick;
    return btn;
}
