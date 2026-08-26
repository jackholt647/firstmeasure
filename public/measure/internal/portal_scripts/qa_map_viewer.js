(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search || "");
  const folderId = String(params.get("folder") || "").trim();
  const apiBase = String(params.get("api") || `${window.location.origin}/v1/firstmeasure`).replace(/\/+$/, "");
  const mapsSrcParam = String(params.get("maps_src") || "").trim();
  const initialMode = String(params.get("mode") || "quad").trim().toLowerCase() === "map" ? "map" : "quad";

  const HEADINGS = [
    { id: "qaMapNorth", label: "North", heading: 0 },
    { id: "qaMapEast", label: "East", heading: 90 },
    { id: "qaMapSouth", label: "South", heading: 180 },
    { id: "qaMapWest", label: "West", heading: 270 }
  ];

  const state = {
    google: null,
    manifest: null,
    center: null,
    address: "",
    mode: "quad",
    singleMap: null,
    quadMaps: [],
    syncPaused: false
  };

  let googleLoaderPromise = null;

  function $(id) {
    return document.getElementById(id);
  }

  function editorBundleCacheKey() {
    return `qa_editor_bundle:v1:${apiBase}:${folderId}`;
  }

  function readEditorBundleCache(maxAgeMs = 120000) {
    if (!folderId || !window.sessionStorage) return null;
    try {
      const raw = sessionStorage.getItem(editorBundleCacheKey());
      if (!raw) return null;
      const wrapped = JSON.parse(raw);
      const savedAt = Number(wrapped && wrapped.savedAt);
      if (!savedAt || Date.now() - savedAt > maxAgeMs) return null;
      return wrapped.data && typeof wrapped.data === "object" ? wrapped.data : null;
    } catch (error) {
      return null;
    }
  }

  function writeEditorBundleCache(data) {
    if (!folderId || !data || typeof data !== "object" || !window.sessionStorage) return;
    try {
      sessionStorage.setItem(editorBundleCacheKey(), JSON.stringify({
        savedAt: Date.now(),
        data
      }));
    } catch (error) {}
  }

  function setStatus(text) {
    const el = $("qaMapStatus");
    if (el) el.textContent = text;
  }

  function setOverlay(title, copy, iconClass) {
    const overlay = $("qaMapOverlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    const titleEl = overlay.querySelector(".title");
    const copyEl = overlay.querySelector(".copy");
    const iconEl = overlay.querySelector("i");
    if (titleEl) titleEl.textContent = title || "Loading Map Viewer";
    if (copyEl) copyEl.textContent = copy || "";
    if (iconEl) iconEl.className = iconClass || "fas fa-map-marked-alt";
  }

  function hideOverlay() {
    const overlay = $("qaMapOverlay");
    if (overlay) overlay.classList.add("hidden");
  }

  function updateParentHint(mode) {
    const text = String(mode || "quad").toUpperCase();
    try {
      const hint = window.parent && window.parent.document
        ? window.parent.document.getElementById("qaTopViewHint")
        : null;
      if (hint) hint.textContent = text;
    } catch (e) {}
  }

  function sanitizeMapsScriptSrc(src) {
    if (!src) return "";
    try {
      const url = new URL(src, window.location.href);
      url.searchParams.delete("callback");
      return url.toString();
    } catch (e) {
      return "";
    }
  }

  function getGoogleNamespace() {
    if (window.google && window.google.maps) return window.google;
    try {
      if (window.parent && window.parent.google && window.parent.google.maps) {
        window.google = window.parent.google;
        return window.google;
      }
    } catch (e) {}
    return null;
  }

  async function ensureGoogleMaps() {
    const ready = getGoogleNamespace();
    if (ready) return ready;
    if (googleLoaderPromise) return googleLoaderPromise;

    const cleanSrc = sanitizeMapsScriptSrc(mapsSrcParam);
    if (!cleanSrc) {
      throw new Error("Google Maps script is unavailable.");
    }

    googleLoaderPromise = new Promise((resolve, reject) => {
      const callbackName = "__qaMapViewerGoogleLoaded";
      const script = document.createElement("script");
      const url = new URL(cleanSrc);
      url.searchParams.set("callback", callbackName);

      window[callbackName] = () => {
        delete window[callbackName];
        const namespace = getGoogleNamespace();
        if (namespace) resolve(namespace);
        else reject(new Error("Google Maps finished loading but the API was unavailable."));
      };

      script.src = url.toString();
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        delete window[callbackName];
        reject(new Error("Failed to load Google Maps."));
      };
      document.head.appendChild(script);
    });

    return googleLoaderPromise;
  }

  async function fetchEditorBundle() {
    if (!folderId) {
      throw new Error("Missing project id.");
    }
    const cached = readEditorBundleCache();
    if (cached) return cached;
    const response = await window.fetch(`${apiBase}/projects/${encodeURIComponent(folderId)}/editor`, {
      credentials: "include"
    });
    if (!response.ok) {
      throw new Error(`Project bundle failed to load (${response.status}).`);
    }
    const data = await response.json();
    writeEditorBundleCache(data);
    return data;
  }

  function extractProjectCenter(bundle) {
    const manifest = bundle && bundle.manifest ? bundle.manifest : {};
    const lat = Number(manifest.lat);
    const lng = Number(manifest.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return { lat, lng };
  }

  function toLatLngLiteral(value) {
    if (!value) return null;
    if (typeof value.lat === "function" && typeof value.lng === "function") {
      return { lat: value.lat(), lng: value.lng() };
    }
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  function getSharedCenter() {
    if (state.mode === "quad" && state.quadMaps.length > 0) {
      return toLatLngLiteral(state.quadMaps[0].getCenter());
    }
    if (state.singleMap) {
      return toLatLngLiteral(state.singleMap.getCenter());
    }
    return state.center;
  }

  function getSharedZoom() {
    if (state.mode === "quad" && state.quadMaps.length > 0) {
      return Number(state.quadMaps[0].getZoom()) || 20;
    }
    if (state.singleMap) {
      return Number(state.singleMap.getZoom()) || 20;
    }
    return 20;
  }

  function syncFromSingleMap() {
    if (state.syncPaused || !state.singleMap || state.quadMaps.length === 0) return;
    const center = toLatLngLiteral(state.singleMap.getCenter());
    const zoom = Number(state.singleMap.getZoom()) || 20;
    state.syncPaused = true;
    state.quadMaps.forEach((map, index) => {
      if (center) map.setCenter(center);
      map.setZoom(zoom);
      map.setTilt(45);
      map.setHeading(HEADINGS[index].heading);
    });
    state.syncPaused = false;
  }

  function syncFromQuadMap(sourceIndex) {
    if (state.syncPaused || state.quadMaps.length === 0) return;
    const source = state.quadMaps[sourceIndex];
    if (!source) return;
    const center = toLatLngLiteral(source.getCenter());
    const zoom = Number(source.getZoom()) || 20;
    state.syncPaused = true;
    state.quadMaps.forEach((map, index) => {
      if (index === sourceIndex) return;
      if (center) map.setCenter(center);
      map.setZoom(zoom);
      map.setTilt(45);
      map.setHeading(HEADINGS[index].heading);
    });
    if (state.singleMap) {
      if (center) state.singleMap.setCenter(center);
      state.singleMap.setZoom(zoom);
    }
    state.syncPaused = false;
  }

  function initSingleMap(center) {
    if (state.singleMap) return;
    const g = state.google;
    state.singleMap = new g.maps.Map($("qaMapSingle"), {
      center,
      zoom: 20,
      mapTypeId: "satellite",
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true,
      rotateControl: true,
      tilt: 45,
      heading: 0,
      gestureHandling: "greedy"
    });
    state.singleMap.addListener("center_changed", syncFromSingleMap);
    state.singleMap.addListener("zoom_changed", syncFromSingleMap);
  }

  function initQuadMaps(center) {
    if (state.quadMaps.length > 0) return;
    const g = state.google;
    state.quadMaps = HEADINGS.map((item, index) => {
      const map = new g.maps.Map($(item.id), {
        center,
        zoom: 20,
        mapTypeId: "satellite",
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: false,
        rotateControl: false,
        tilt: 45,
        heading: item.heading,
        gestureHandling: "greedy"
      });
      map.addListener("center_changed", () => syncFromQuadMap(index));
      map.addListener("zoom_changed", () => syncFromQuadMap(index));
      return map;
    });
  }

  function updateModeButtons() {
    const quadBtn = $("qaMapQuadBtn");
    const mapBtn = $("qaMapSingleBtn");
    if (quadBtn) quadBtn.classList.toggle("active", state.mode === "quad");
    if (mapBtn) mapBtn.classList.toggle("active", state.mode === "map");
    updateParentHint(state.mode);
  }

  function resizeAllMaps() {
    const g = state.google;
    if (!g || !g.maps || !g.maps.event) return;
    const center = getSharedCenter() || state.center;
    const zoom = getSharedZoom();

    if (state.singleMap) {
      g.maps.event.trigger(state.singleMap, "resize");
      if (center) state.singleMap.setCenter(center);
      state.singleMap.setZoom(zoom);
    }

    state.quadMaps.forEach((map, index) => {
      g.maps.event.trigger(map, "resize");
      if (center) map.setCenter(center);
      map.setZoom(zoom);
      map.setTilt(45);
      map.setHeading(HEADINGS[index].heading);
    });
  }

  function setMode(nextMode) {
    const mode = nextMode === "map" ? "map" : "quad";
    state.mode = mode;
    const singlePane = $("qaMapSinglePane");
    const quadPane = $("qaMapQuadGrid");
    if (singlePane) singlePane.classList.toggle("hidden", mode !== "map");
    if (quadPane) quadPane.classList.toggle("hidden", mode !== "quad");
    updateModeButtons();
    resizeAllMaps();
    if (mode === "quad") {
      setStatus(state.address
        ? `Quad view loaded for ${state.address}`
        : "Quad view loaded.");
    } else {
      setStatus(state.address
        ? `Single map loaded for ${state.address}`
        : "Single map loaded.");
    }
  }

  async function init() {
    try {
      setOverlay("Loading Map Viewer", "Loading the live Google Maps views for this project.", "fas fa-map-marked-alt");
      setStatus("Loading project location...");

      const [bundle, googleNamespace] = await Promise.all([
        fetchEditorBundle(),
        ensureGoogleMaps()
      ]);

      state.google = googleNamespace;
      state.manifest = bundle && bundle.manifest ? bundle.manifest : null;
      state.center = extractProjectCenter(bundle);
      state.address = String((state.manifest && state.manifest.address) || "").trim();

      if (!state.center) {
        throw new Error("This project does not have map coordinates yet.");
      }

      initSingleMap(state.center);
      initQuadMaps(state.center);
      setMode(initialMode);
      hideOverlay();
    } catch (error) {
      console.error("[QA Map Viewer] Error:", error);
      setOverlay(
        "Map viewer unavailable",
        error && error.message ? error.message : "The live Google Maps view could not be loaded for this project.",
        "fas fa-exclamation-triangle"
      );
      setStatus(error && error.message ? error.message : "Map viewer unavailable.");
    }
  }

  const quadBtn = $("qaMapQuadBtn");
  if (quadBtn) quadBtn.addEventListener("click", () => setMode("quad"));
  const singleBtn = $("qaMapSingleBtn");
  if (singleBtn) singleBtn.addEventListener("click", () => setMode("map"));

  window.addEventListener("message", (event) => {
    const data = event && event.data ? event.data : null;
    if (!data || typeof data !== "object") return;
    if (data.type !== "qa-map-mode") return;
    setMode(String(data.mode || "quad").toLowerCase() === "map" ? "map" : "quad");
  });

  window.addEventListener("resize", () => {
    window.requestAnimationFrame(() => resizeAllMaps());
  });

  init();
})();
