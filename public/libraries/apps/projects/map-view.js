/* public/libraries/apps/projects/map-view.js
 * My Projects > Map. Draws the projects the viewer has already filtered (board,
 * search, sharing, drafts) on the portal's Google map, coloured by stage (or by
 * board when every board is shown), with a collapsible tray listing all of them.
 *
 * The viewer owns filtering and opening a project; this file only draws what it
 * is given. Locations come from the project record (pins or lat/lng); a project
 * without one is geocoded in this browser and cached in localStorage (see
 * docs/optimization-backlog.md, "Projects map geocodes addresses in the browser").
 */
(function(){
  if (window.FirstMateProjectsMap) return;

  const GEOCODE_STORAGE_KEY = 'fm_projects_map_geocode_v1';
  const TRAY_STORAGE_KEY = 'fm_projects_map_tray_v1';
  const MAP_TYPE_STORAGE_KEY = 'fm_projects_map_type_v1';
  const GEOCODE_CACHE_LIMIT = 2000;
  const GEOCODE_FAILURE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
  const GEOCODE_SESSION_LIMIT = 250;
  const GEOCODE_GAP_MS = 140;
  const CLUSTER_CELL_PX = 54;
  const CLUSTER_MAX_ZOOM = 14;
  const FOCUS_ZOOM = 16;
  const DEFAULT_CENTER = { lat: 39.8283, lng: -98.5795 };
  const FALLBACK_COLOR = '#667085';

  const escapeHtml = window.Portal?.util?.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])));
  const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; } };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const safeColor = (value) => /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$|^hsla?\([\d\s.,%deg]+\)$/i.test(String(value || '').trim()) ? String(value).trim() : FALLBACK_COLOR;

  function readStorage(key, fallback){
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
    catch (error) { return fallback; }
  }
  function writeStorage(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {}
  }

  const STYLES = `
    .pm-root{--pm-tray-w:340px;position:relative;height:100%;min-height:320px;box-sizing:border-box;border:1px solid #eaecf0;border-radius:13px;overflow:hidden;background:#e9edf1;box-shadow:0 1px 2px rgba(16,24,40,.04);container:pm/inline-size;isolation:isolate}
    .pm-canvas{position:absolute;inset:0}
    .pm-canvas .gm-style{font-family:inherit}
    .pm-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1}
    .pm-status[hidden]{display:none}
    .pm-status-card{max-width:300px;margin:0 16px;padding:14px 16px;border-radius:12px;background:rgba(255,255,255,.94);box-shadow:0 12px 30px rgba(15,23,42,.14);color:#475467;font-size:12px;font-weight:900;line-height:1.4;text-align:center}
    .pm-status-card i{display:block;margin-bottom:8px;color:#98a2b3;font-size:18px}

    .pm-layer{position:absolute;left:0;top:0;width:0;height:0}
    .pm-marker{position:absolute;left:0;top:0;width:0;height:0;z-index:1}
    .pm-marker.is-hot,.pm-marker.is-selected{z-index:5}
    .pm-pin{position:absolute;left:-14px;top:-36px;width:28px;height:36px;padding:0;margin:0;border:0;background:transparent;cursor:pointer;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.2,.9,.3,1.3),opacity .22s ease,filter .2s ease;outline:none}
    .pm-pin::before{content:'';position:absolute;left:2px;top:2px;width:24px;height:24px;box-sizing:border-box;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--pin-color,${FALLBACK_COLOR});border:2.5px solid #fff;box-shadow:0 3px 8px rgba(15,23,42,.32)}
    .pm-pin::after{content:'';position:absolute;left:10px;top:10px;width:8px;height:8px;border-radius:50%;background:#fff;opacity:.95}
    .pm-pulse{position:absolute;left:-14px;top:-8px;width:28px;height:16px;border-radius:50%;background:var(--pin-color,${FALLBACK_COLOR});opacity:0;transform:scale(.4);pointer-events:none}
    .pm-marker:hover .pm-pin,.pm-marker.is-hot .pm-pin{transform:scale(1.18);filter:drop-shadow(0 6px 10px rgba(15,23,42,.22))}
    .pm-marker.is-selected .pm-pin{transform:scale(1.32)}
    .pm-marker.is-selected .pm-pulse,.pm-marker.is-hot .pm-pulse{animation:pm-pulse 1.6s ease-out infinite}
    .pm-pin:focus-visible::before{box-shadow:0 0 0 4px color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 35%,transparent),0 3px 8px rgba(15,23,42,.32)}
    .pm-marker.is-entering .pm-pin{opacity:0;transform:translateY(-14px) scale(.5)}
    .pm-marker.is-leaving .pm-pin,.pm-marker.is-clustered .pm-pin{opacity:0;transform:scale(.35);pointer-events:none}
    .pm-marker.is-clustered .pm-pulse{animation:none}
    @keyframes pm-pulse{0%{opacity:.5;transform:scale(.4)}100%{opacity:0;transform:scale(2.6)}}

    .pm-cluster{position:absolute;left:0;top:0;width:0;height:0;z-index:2}
    .pm-cluster-btn{position:absolute;left:calc(var(--size) / -2);top:calc(var(--size) / -2);width:var(--size);height:var(--size);padding:3px;box-sizing:border-box;border:0;border-radius:50%;background:var(--ring);box-shadow:0 4px 14px rgba(15,23,42,.28);cursor:pointer;transition:transform .24s cubic-bezier(.2,.9,.3,1.3),opacity .2s ease;outline:none}
    .pm-cluster-btn span{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:#fff;color:#17212b;font:1000 12px/1 inherit;letter-spacing:-.2px}
    .pm-cluster-btn:hover,.pm-cluster.is-hot .pm-cluster-btn{transform:scale(1.12)}
    .pm-cluster-btn:focus-visible{box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.28),0 4px 14px rgba(15,23,42,.28)}
    .pm-cluster.is-entering .pm-cluster-btn,.pm-cluster.is-leaving .pm-cluster-btn{opacity:0;transform:scale(.4)}

    .pm-preview{position:absolute;left:0;top:0;width:0;height:0;z-index:10}
    .pm-preview-card{position:absolute;left:-130px;bottom:52px;width:260px;box-sizing:border-box;border-radius:14px;background:#fff;box-shadow:0 18px 44px rgba(15,23,42,.24),0 0 0 1px rgba(15,23,42,.06);overflow:hidden;transform-origin:50% 100%;animation:pm-pop .24s cubic-bezier(.2,.9,.3,1.2);cursor:default}
    .pm-preview-card::after{content:'';position:absolute;left:50%;bottom:-6px;width:12px;height:12px;margin-left:-6px;background:#fff;transform:rotate(45deg);box-shadow:3px 3px 6px rgba(15,23,42,.06)}
    .pm-preview-stripe{height:4px;background:var(--pin-color,${FALLBACK_COLOR})}
    .pm-preview-body{position:relative;z-index:1;padding:11px 12px 12px;background:#fff}
    .pm-preview-close{position:absolute;right:6px;top:7px;width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#98a2b3;cursor:pointer;font-size:12px}
    .pm-preview-close:hover{background:#f2f4f7;color:#344054}
    .pm-preview-title{padding-right:26px;color:#18222d;font-size:14px;font-weight:1000;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pm-preview-addr{margin-top:3px;color:#425466;font-size:12px;font-weight:900;line-height:1.3}
    .pm-preview-addr span{display:block;color:#768293;font-size:11px;font-weight:850}
    .pm-preview-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
    .pm-stage-pill{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:60%;padding:4px 9px;border-radius:999px;background:color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 11%,#fff);border:1px solid color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 28%,#e3e7ec);color:color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 78%,#17212b);font-size:10px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pm-open{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:0;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:900 12px/1 inherit;cursor:pointer;white-space:nowrap;transition:transform .16s ease,box-shadow .16s ease}
    .pm-open:hover{transform:translateY(-1px);box-shadow:0 8px 18px rgba(var(--primary-rgb,217,48,37),.28)}
    @keyframes pm-pop{from{opacity:0;transform:translateY(8px) scale(.92)}to{opacity:1;transform:none}}

    .pm-controls{position:absolute;right:12px;top:12px;z-index:3;display:flex;flex-direction:column;gap:8px}
    .pm-ctl-group{display:flex;flex-direction:column;border-radius:10px;background:#fff;box-shadow:0 6px 18px rgba(15,23,42,.16),0 0 0 1px rgba(15,23,42,.06);overflow:hidden}
    .pm-ctl{width:38px;height:38px;border:0;background:#fff;color:#475467;font-size:13px;cursor:pointer;transition:background .16s ease,color .16s ease}
    .pm-ctl+.pm-ctl{border-top:1px solid #eaecf0}
    .pm-ctl:hover{background:#f8fafc;color:var(--primary-readable,var(--primary,#d93025))}
    .pm-ctl[aria-pressed="true"]{color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.08)}
    .pm-ctl:focus-visible{outline:2px solid rgba(var(--primary-rgb,217,48,37),.45);outline-offset:-2px}

    .pm-tray{position:absolute;left:12px;top:12px;bottom:12px;z-index:4;width:var(--pm-tray-w);max-width:calc(100% - 90px);box-sizing:border-box;display:flex;flex-direction:column;border-radius:14px;background:rgba(255,255,255,.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 18px 44px rgba(15,23,42,.18),0 0 0 1px rgba(15,23,42,.06);overflow:hidden;transition:transform .34s cubic-bezier(.2,.8,.2,1),opacity .26s ease}
    .pm-root:not(.is-tray-open) .pm-tray{transform:translateX(calc(-100% - 20px));opacity:0;pointer-events:none}
    .pm-tray-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 10px 10px 14px;border-bottom:1px solid rgba(15,23,42,.07);cursor:default}
    .pm-tray-grip{display:none}
    .pm-tray-title{flex:1 1 auto;min-width:0}
    .pm-tray-title strong{display:block;color:#101828;font-size:14px;font-weight:1000;line-height:1.2}
    .pm-tray-sub{display:flex;align-items:center;gap:6px;margin-top:2px;color:#667085;font-size:11px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pm-tray-sub i{font-size:10px}
    .pm-tray-toggle{flex:0 0 auto;width:32px;height:32px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;color:#667085;cursor:pointer;transition:background .16s ease,color .16s ease,transform .3s ease}
    .pm-tray-toggle:hover{background:#f8fafc;color:#344054}
    .pm-legend{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.07);max-height:96px;overflow-y:auto}
    .pm-legend[hidden]{display:none}
    .pm-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:5px 9px 5px 7px;border:1px solid color-mix(in srgb,var(--chip-color,${FALLBACK_COLOR}) 30%,#e3e7ec);border-radius:999px;background:color-mix(in srgb,var(--chip-color,${FALLBACK_COLOR}) 9%,#fff);color:color-mix(in srgb,var(--chip-color,${FALLBACK_COLOR}) 75%,#17212b);font:900 11px/1.1 inherit;cursor:pointer;transition:background .18s ease,opacity .18s ease,border-color .18s ease,transform .16s ease}
    .pm-chip:hover{transform:translateY(-1px)}
    .pm-chip-dot{width:9px;height:9px;flex:0 0 auto;border-radius:50%;background:var(--chip-color,${FALLBACK_COLOR});box-shadow:0 0 0 2px color-mix(in srgb,var(--chip-color,${FALLBACK_COLOR}) 18%,transparent);transition:transform .18s ease,background .18s ease}
    .pm-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pm-chip-count{padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.85);font-size:10px}
    .pm-chip[aria-pressed="false"]{background:#fff;border-color:#e4e7ec;color:#98a2b3}
    .pm-chip[aria-pressed="false"] .pm-chip-dot{background:#d0d5dd;box-shadow:none;transform:scale(.8)}
    .pm-chip-reset{border-style:dashed;--chip-color:#667085}
    .pm-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
    .pm-section{position:sticky;top:-6px;z-index:1;margin:6px 2px 4px;padding:6px 8px;border-radius:8px;background:rgba(242,244,247,.96);color:#667085;font-size:10px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase}
    .pm-row{position:relative;width:100%;display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:9px;background:transparent;text-align:left;font-family:inherit;cursor:pointer;transition:background .18s ease,box-shadow .18s ease}
    .pm-row+.pm-row{margin-top:2px}
    .pm-row::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--pin-color,${FALLBACK_COLOR});opacity:0;transform:scaleY(.3);transition:opacity .2s ease,transform .2s ease}
    .pm-row:hover,.pm-row.is-hot{background:color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 8%,#fff)}
    .pm-row.is-selected{background:color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 13%,#fff);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 30%,transparent)}
    .pm-row.is-hot::before,.pm-row.is-selected::before{opacity:1;transform:none}
    .pm-row:focus-visible{outline:2px solid rgba(var(--primary-rgb,217,48,37),.45);outline-offset:-2px}
    .pm-row-dot{width:10px;height:10px;border-radius:50%;background:var(--pin-color,${FALLBACK_COLOR});box-shadow:0 0 0 3px color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 16%,transparent)}
    .pm-row.is-unlocated .pm-row-dot{background:#fff;border:2px dashed color-mix(in srgb,var(--pin-color,${FALLBACK_COLOR}) 60%,#98a2b3);box-shadow:none;width:6px;height:6px}
    .pm-row-main{min-width:0}
    .pm-row-title{color:#18222d;font-size:12px;font-weight:1000;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pm-row-addr{margin-top:2px;color:#768293;font-size:11px;font-weight:850;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pm-row-side{display:flex;align-items:center;gap:6px;color:#98a2b3;font-size:10px;font-weight:950;white-space:nowrap}
    .pm-row-flag{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;background:#f2f4f7;color:#667085}
    .pm-row-open{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;color:#98a2b3;opacity:0;transform:translateX(-4px);transition:opacity .16s ease,transform .16s ease,background .16s ease,color .16s ease}
    .pm-row:hover .pm-row-open,.pm-row.is-selected .pm-row-open,.pm-row:focus-visible .pm-row-open{opacity:1;transform:none}
    .pm-row-open:hover{background:#fff;color:var(--primary-readable,var(--primary,#d93025))}
    .pm-row.is-new{animation:pm-row-in .32s ease both}
    @keyframes pm-row-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .pm-empty{padding:26px 14px;color:#98a2b3;font-size:12px;font-weight:900;text-align:center;line-height:1.4}
    .pm-empty i{display:block;margin-bottom:8px;color:#c7ced8;font-size:18px}

    .pm-reopen{position:absolute;left:12px;top:12px;z-index:3;display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 13px;border:0;border-radius:10px;background:#fff;box-shadow:0 6px 18px rgba(15,23,42,.16),0 0 0 1px rgba(15,23,42,.06);color:#344054;font:900 12px/1 inherit;cursor:pointer;transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .24s ease}
    .pm-reopen:hover{color:var(--primary-readable,var(--primary,#d93025))}
    .pm-reopen-count{padding:3px 7px;border-radius:999px;background:#eef1f4;color:#667085;font-size:10px}
    .pm-root.is-tray-open .pm-reopen{opacity:0;transform:translateX(-12px);pointer-events:none}

    @container pm (max-width: 700px){
      .pm-tray{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-width:none;height:min(56%,440px);border-radius:16px;transform:none}
      .pm-root:not(.is-tray-open) .pm-tray{transform:translateY(calc(100% - 62px));opacity:1;pointer-events:auto}
      .pm-root:not(.is-tray-open) .pm-legend,.pm-root:not(.is-tray-open) .pm-list{visibility:hidden;transition:visibility 0s linear .34s}
      .pm-tray-head{position:relative;padding-top:16px;cursor:pointer;touch-action:none}
      .pm-tray-grip{display:block;position:absolute;left:50%;top:6px;width:36px;height:4px;margin-left:-18px;border-radius:4px;background:#d0d5dd}
      .pm-tray-toggle{transform:rotate(-90deg)}
      .pm-root:not(.is-tray-open) .pm-tray-toggle{transform:rotate(90deg)}
      .pm-reopen{display:none}
      .pm-controls{right:8px;top:8px}
      .pm-preview-card{width:230px;left:-115px}
    }
    @media (prefers-reduced-motion: reduce){
      .pm-root *,.pm-root *::before,.pm-root *::after{animation:none!important;transition:none!important}
    }
  `;

  const state = {
    root: null,
    map: null,
    layer: null,
    LayerClass: null,
    mapsFailed: false,
    mapsPromise: null,
    model: null,
    items: new Map(),
    order: [],
    hiddenGroups: new Set(),
    scopeKey: null,
    selectedId: '',
    hotId: '',
    // null until the person opens or closes it: open beside the map, a peeking sheet on a phone.
    trayOpen: (() => { const stored = readStorage(TRAY_STORAGE_KEY, null); return typeof stored === 'boolean' ? stored : null; })(),
    mapType: readStorage(MAP_TYPE_STORAGE_KEY, 'roadmap') === 'hybrid' ? 'hybrid' : 'roadmap',
    markers: new Map(),
    clusters: new Map(),
    previewEl: null,
    fitSignature: '',
    userMovedSinceFit: false,
    programmaticMove: 0,
    flightToken: 0,
    seenRowIds: new Set(),
    geocodeCache: null,
    geocodeQueue: [],
    geocodePending: new Set(),
    geocodeRunning: false,
    geocodeCount: 0,
    geocoder: null,
    refreshTimer: 0
  };

  /* ---------- Google Maps ---------- */
  function mapsReady(){ return !!(window.google?.maps?.Map && window.google?.maps?.OverlayView && window.google?.maps?.LatLngBounds); }
  function ensureMaps(){
    if (mapsReady()) return Promise.resolve(true);
    if (state.mapsPromise) return state.mapsPromise;
    state.mapsPromise = (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (mapsReady()) return true;
        if (typeof window.google?.maps?.importLibrary === 'function') {
          try {
            await window.google.maps.importLibrary('maps');
            await window.google.maps.importLibrary('geocoding').catch(() => null);
            if (mapsReady()) return true;
          } catch (error) {}
        }
        await wait(250);
      }
      return mapsReady();
    })().finally(() => { state.mapsPromise = null; });
    return state.mapsPromise;
  }

  const MAP_STYLES = [
    { featureType:'poi', stylers:[{ visibility:'off' }] },
    { featureType:'transit', stylers:[{ visibility:'off' }] },
    { featureType:'road', elementType:'labels.icon', stylers:[{ visibility:'off' }] },
    { featureType:'landscape', stylers:[{ saturation:-60 }, { lightness:12 }] },
    { featureType:'road', stylers:[{ saturation:-80 }] },
    { featureType:'road.highway', elementType:'geometry', stylers:[{ lightness:28 }] },
    { featureType:'water', stylers:[{ saturation:-35 }, { lightness:8 }] },
    { featureType:'administrative', elementType:'labels.text.fill', stylers:[{ color:'#5b6573' }] }
  ];

  function createLayerClass(){
    return class ProjectPinLayer extends window.google.maps.OverlayView {
      constructor(){
        super();
        this.div = document.createElement('div');
        this.div.className = 'pm-layer';
      }
      onAdd(){
        this.getPanes().overlayMouseTarget.appendChild(this.div);
        // Pins and the preview are DOM; keep their clicks off the map.
        window.google.maps.OverlayView.preventMapHitsAndGesturesFrom?.(this.div);
      }
      onRemove(){ this.div.remove(); }
      draw(){ layoutMarkers(); }
    };
  }

  function buildMap(){
    const canvas = state.root.querySelector('.pm-canvas');
    state.map = new window.google.maps.Map(canvas, {
      center: DEFAULT_CENTER,
      zoom: 4,
      minZoom: 3,
      maxZoom: 20,
      mapTypeId: state.mapType,
      disableDefaultUI: true,
      zoomControl: !isSheet(),
      zoomControlOptions: { position: window.google.maps.ControlPosition?.RIGHT_BOTTOM },
      clickableIcons: false,
      gestureHandling: 'greedy',
      keyboardShortcuts: true,
      styles: MAP_STYLES,
      backgroundColor: '#e9edf1'
    });
    state.LayerClass = state.LayerClass || createLayerClass();
    state.layer = new state.LayerClass();
    state.layer.setMap(state.map);
    state.map.addListener('click', () => select('', { pan:false }));
    const markMoved = () => { if (!state.programmaticMove) state.userMovedSinceFit = true; };
    state.map.addListener('dragstart', markMoved);
    state.map.addListener('zoom_changed', markMoved);
    syncMapTypeButton();
  }

  /* ---------- Locations ---------- */
  function finite(value){ const n = Number(value); return Number.isFinite(n) ? n : null; }
  function validPoint(point){
    if (!point) return null;
    const lat = finite(point.lat), lng = finite(point.lng);
    if (lat == null || lng == null || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  function addressKey(address){ return String(address || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function geocodeCache(){
    if (!state.geocodeCache) {
      const stored = readStorage(GEOCODE_STORAGE_KEY, {});
      state.geocodeCache = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }
    return state.geocodeCache;
  }
  function cachedPoint(address){
    const entry = geocodeCache()[addressKey(address)];
    if (Array.isArray(entry)) return validPoint({ lat:entry[0], lng:entry[1] });
    return null;
  }
  function cachedFailure(address){
    const entry = geocodeCache()[addressKey(address)];
    return !!(entry && !Array.isArray(entry) && Number(entry.failed_at) > Date.now() - GEOCODE_FAILURE_RETRY_MS);
  }
  function rememberGeocode(address, point){
    const cache = geocodeCache();
    const key = addressKey(address);
    delete cache[key];
    cache[key] = point ? [Math.round(point.lat * 1e6) / 1e6, Math.round(point.lng * 1e6) / 1e6] : { failed_at: Date.now() };
    const keys = Object.keys(cache);
    for (let i = 0; i < keys.length - GEOCODE_CACHE_LIMIT; i++) delete cache[keys[i]];
    writeStorage(GEOCODE_STORAGE_KEY, cache);
  }
  function enqueueGeocoding(){
    for (const id of state.order) {
      const item = state.items.get(id);
      if (!item || item.point || !item.address) continue;
      const key = addressKey(item.address);
      if (state.geocodePending.has(key) || cachedFailure(item.address)) continue;
      state.geocodePending.add(key);
      state.geocodeQueue.push(item.address);
    }
    runGeocoder();
  }
  async function runGeocoder(){
    if (state.geocodeRunning || !state.geocodeQueue.length) return;
    if (!window.google?.maps?.Geocoder) return;
    state.geocodeRunning = true;
    renderTrayHead();
    state.geocoder = state.geocoder || new window.google.maps.Geocoder();
    try {
      while (state.geocodeQueue.length && state.geocodeCount < GEOCODE_SESSION_LIMIT && state.root?.isConnected) {
        const address = state.geocodeQueue.shift();
        state.geocodeCount += 1;
        let point = null;
        let retry = false;
        try {
          const response = await state.geocoder.geocode({ address });
          const location = response?.results?.[0]?.geometry?.location;
          point = location ? validPoint({ lat:location.lat(), lng:location.lng() }) : null;
        } catch (error) {
          const code = String(error?.code || error?.message || '');
          retry = /OVER_QUERY_LIMIT|UNKNOWN_ERROR/i.test(code);
        }
        if (retry) { state.geocodeQueue.push(address); await wait(2000); continue; }
        rememberGeocode(address, point);
        state.geocodePending.delete(addressKey(address));
        if (point) applyGeocode(address, point);
        else scheduleRefresh();
        await wait(GEOCODE_GAP_MS);
      }
    } finally {
      state.geocodeRunning = false;
      if (!state.geocodeQueue.length || state.geocodeCount >= GEOCODE_SESSION_LIMIT) {
        state.geocodeQueue.forEach((address) => state.geocodePending.delete(addressKey(address)));
        state.geocodeQueue = [];
      }
      scheduleRefresh();
    }
  }
  function applyGeocode(address, point){
    const key = addressKey(address);
    for (const item of state.items.values()) {
      if (!item.point && addressKey(item.address) === key) { item.point = point; item.geocoded = true; }
    }
    scheduleRefresh();
  }
  // Throttled, so pins appear steadily while addresses are located; the camera
  // follows them until the person moves the map themselves.
  function scheduleRefresh(){
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = 0;
      if (!state.root?.isConnected) return;
      renderTray();
      syncMarkers();
      if (!state.userMovedSinceFit) fitAll({ animate:true });
    }, 400);
  }

  /* ---------- Model ---------- */
  function visibleItems(){
    return state.order.map((id) => state.items.get(id)).filter((item) => item && !state.hiddenGroups.has(item.groupId));
  }
  function locatedItems(){ return visibleItems().filter((item) => item.point); }

  function update(container, model){
    if (!container) return;
    window.Portal?.util?.injectCSS?.('projects_map_view', STYLES);
    if (!window.Portal?.util?.injectCSS && !document.getElementById('projects-map-view-css')) {
      const style = document.createElement('style'); style.id = 'projects-map-view-css'; style.textContent = STYLES; document.head.appendChild(style);
    }
    if (!state.root) createRoot();
    if (state.root.parentNode !== container) {
      container.innerHTML = '';
      container.appendChild(state.root);
      // Re-attached after another view: the map needs its size again.
      if (state.map) setTimeout(() => { window.google?.maps?.event?.trigger?.(state.map, 'resize'); state.layer?.draw?.(); }, 0);
    }
    if (state.trayOpen == null) setTrayOpen(!isSheet(), { remember:false });
    state.model = model || {};
    const scopeKey = String(model?.scopeKey || '');
    if (scopeKey !== state.scopeKey) { state.scopeKey = scopeKey; state.hiddenGroups.clear(); }
    const previous = state.items;
    state.items = new Map();
    state.order = [];
    for (const raw of Array.isArray(model?.items) ? model.items : []) {
      const id = String(raw?.id || '');
      if (!id || state.items.has(id)) continue;
      const known = validPoint(raw.point);
      const prior = previous.get(id);
      const point = known || (raw.address ? cachedPoint(raw.address) : null) || (prior?.geocoded && addressKey(prior.address) === addressKey(raw.address) ? prior.point : null);
      state.items.set(id, { ...raw, id, color: safeColor(raw.color), point, geocoded: !known && !!point });
      state.order.push(id);
    }
    const groupIds = new Set((model?.groups || []).map((group) => String(group.id)));
    for (const id of [...state.hiddenGroups]) if (!groupIds.has(id)) state.hiddenGroups.delete(id);
    if (state.selectedId && !state.items.has(state.selectedId)) state.selectedId = '';
    if (state.hotId && !state.items.has(state.hotId)) state.hotId = '';
    renderTray();
    ensureMaps().then((ok) => {
      if (!state.root?.isConnected) return;
      if (!ok) { state.mapsFailed = true; renderStatus(); return; }
      state.mapsFailed = false;
      if (!state.map) buildMap();
      syncMarkers();
      maybeFit();
      enqueueGeocoding();
    });
  }

  function maybeFit(){
    const signature = [state.scopeKey, [...state.hiddenGroups].sort().join(','), visibleItems().map((item) => item.id).sort().join(',')].join('|');
    if (signature === state.fitSignature) return;
    const first = !state.fitSignature;
    state.fitSignature = signature;
    fitAll({ animate: !first });
  }

  /* ---------- DOM ---------- */
  function createRoot(){
    const root = document.createElement('div');
    root.className = 'pm-root' + (state.trayOpen ? ' is-tray-open' : '');
    root.innerHTML = `
      <div class="pm-canvas" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_ac497e7c719b1a","Projects map") ?? "Projects map")}"></div>
      <div class="pm-status" hidden><div class="pm-status-card"></div></div>
      <button type="button" class="pm-reopen" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_3beab267cf4dfb","Show project list") ?? "Show project list")}"><i class="fas fa-list-ul" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("projects","m_19156e80fc8a6e","Projects") ?? "Projects")}</span><span class="pm-reopen-count">0</span></button>
      <div class="pm-controls">
        <div class="pm-ctl-group">
          <button type="button" class="pm-ctl" data-pm-fit aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_3afa35f5e4fa87","Show all projects") ?? "Show all projects")}" title="${(globalThis.PlatformLanguage?.htmlText("projects","m_3afa35f5e4fa87","Show all projects") ?? "Show all projects")}"><i class="fas fa-expand" aria-hidden="true"></i></button>
          <button type="button" class="pm-ctl" data-pm-satellite aria-pressed="false" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_ec6e882a073b75","Satellite view") ?? "Satellite view")}" title="${(globalThis.PlatformLanguage?.htmlText("projects","m_ec6e882a073b75","Satellite view") ?? "Satellite view")}"><i class="fas fa-satellite" aria-hidden="true"></i></button>
        </div>
      </div>
      <section class="pm-tray" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_860325016c9c17","Projects on the map") ?? "Projects on the map")}">
        <div class="pm-tray-head">
          <span class="pm-tray-grip" aria-hidden="true"></span>
          <div class="pm-tray-title"><strong></strong><div class="pm-tray-sub"></div></div>
          <button type="button" class="pm-tray-toggle" aria-expanded="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_fd21d140e2f496","Hide project list") ?? "Hide project list")}"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        </div>
        <div class="pm-legend" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_2805c66abd68dd","Filter the map by stage") ?? "Filter the map by stage")}"></div>
        <div class="pm-list"></div>
      </section>`;
    state.root = root;
    root.querySelector('.pm-reopen').addEventListener('click', () => setTrayOpen(true));
    root.querySelector('.pm-tray-toggle').addEventListener('click', (event) => { event.stopPropagation(); setTrayOpen(!state.trayOpen); });
    root.querySelector('.pm-tray-head').addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      if (isSheet()) setTrayOpen(!state.trayOpen);
    });
    bindSheetDrag(root.querySelector('.pm-tray-head'));
    root.querySelector('[data-pm-fit]').addEventListener('click', () => { state.userMovedSinceFit = false; fitAll({ animate:true }); });
    root.querySelector('[data-pm-satellite]').addEventListener('click', () => {
      state.mapType = state.mapType === 'hybrid' ? 'roadmap' : 'hybrid';
      writeStorage(MAP_TYPE_STORAGE_KEY, state.mapType);
      state.map?.setMapTypeId(state.mapType);
      syncMapTypeButton();
    });
    root.querySelector('.pm-legend').addEventListener('click', (event) => {
      const chip = event.target.closest('.pm-chip');
      if (!chip) return;
      if (chip.dataset.reset != null) state.hiddenGroups.clear();
      else {
        const id = chip.dataset.group;
        const groups = (state.model?.groups || []).map((group) => String(group.id));
        // First click isolates a stage; later clicks add or remove stages.
        if (!state.hiddenGroups.size) groups.forEach((groupId) => { if (groupId !== id) state.hiddenGroups.add(groupId); });
        else if (state.hiddenGroups.has(id)) state.hiddenGroups.delete(id);
        else state.hiddenGroups.add(id);
        if (state.hiddenGroups.size >= groups.length) state.hiddenGroups.clear();
      }
      const selected = state.items.get(state.selectedId);
      if (selected && state.hiddenGroups.has(selected.groupId)) state.selectedId = '';
      state.userMovedSinceFit = false;
      renderTray();
      syncMarkers();
      maybeFit();
    });
    const list = root.querySelector('.pm-list');
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.pm-row');
      if (!row) return;
      const item = state.items.get(row.dataset.id);
      if (!item) return;
      if (event.target.closest('.pm-row-open') || !item.point) { openItem(item); return; }
      select(item.id, { pan:true, from:'list' });
    });
    list.addEventListener('mouseover', (event) => {
      const row = event.target.closest('.pm-row');
      if (row) setHot(row.dataset.id, 'list');
    });
    list.addEventListener('mouseleave', () => setHot('', 'list'));
    list.addEventListener('focusin', (event) => {
      const row = event.target.closest('.pm-row');
      if (row) setHot(row.dataset.id, 'list');
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.selectedId) { select('', { pan:false }); event.stopPropagation(); }
    });
  }

  function isSheet(){ return !!state.root && state.root.getBoundingClientRect().width <= 700; }
  function setTrayOpen(open, options = {}){
    const changed = state.trayOpen != null && state.trayOpen !== !!open;
    state.trayOpen = !!open;
    if (options.remember !== false && changed) writeStorage(TRAY_STORAGE_KEY, state.trayOpen);
    state.root?.classList.toggle('is-tray-open', state.trayOpen);
    const toggle = state.root?.querySelector('.pm-tray-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(state.trayOpen));
      if (state.trayOpen) toggle.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("projects","m_fd21d140e2f496","Hide project list") ?? "Hide project list"));
      else toggle.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("projects","m_3beab267cf4dfb","Show project list") ?? "Show project list"));
    }
  }
  function bindSheetDrag(handle){
    let startY = null;
    handle.addEventListener('pointerdown', (event) => { if (isSheet() && !event.target.closest('button')) startY = event.clientY; });
    window.addEventListener('pointerup', (event) => {
      if (startY == null) return;
      const delta = event.clientY - startY;
      startY = null;
      if (delta > 30 && state.trayOpen) setTrayOpen(false);
      else if (delta < -30 && !state.trayOpen) setTrayOpen(true);
    });
  }
  function syncMapTypeButton(){
    const button = state.root?.querySelector('[data-pm-satellite]');
    if (button) button.setAttribute('aria-pressed', String(state.mapType === 'hybrid'));
  }

  function renderStatus(){
    const status = state.root?.querySelector('.pm-status');
    if (!status) return;
    const card = status.querySelector('.pm-status-card');
    const visible = visibleItems();
    if (state.mapsFailed) {
      status.hidden = false;
      card.innerHTML = `<i class="fas fa-map" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("projects","m_af2632c7a0ecb8","The map could not be loaded. The list still shows every project.") ?? "The map could not be loaded. The list still shows every project.")}</span>`;
      return;
    }
    if (visible.length && !visible.some((item) => item.point) && !state.geocodeRunning && !state.geocodeQueue.length) {
      status.hidden = false;
      card.innerHTML = `<i class="fas fa-location-crosshairs" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("projects","m_637e00d5e1780c","None of these projects has a location yet.") ?? "None of these projects has a location yet.")}</span>`;
      return;
    }
    status.hidden = true;
  }

  function renderTrayHead(){
    if (!state.root) return;
    const visible = visibleItems();
    const located = visible.filter((item) => item.point).length;
    const missing = visible.length - located;
    const title = state.root.querySelector('.pm-tray-title strong');
    const sub = state.root.querySelector('.pm-tray-sub');
    if (visible.length === 1) title.textContent = (globalThis.PlatformLanguage?.text("projects","m_a5aed43e7f4a23","1 project") ?? "1 project");
    else title.textContent = ((v0) => globalThis.PlatformLanguage?.text("projects","m_79e82d0b1623d6",`${v0} projects`,{v0}) ?? `${v0} projects`)(visible.length);
    const locating = state.geocodeRunning || state.geocodeQueue.length;
    sub.innerHTML = `${locating ? '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>' : ''}<span></span>`;
    const subText = sub.querySelector('span');
    if (locating) subText.textContent = ((v0) => globalThis.PlatformLanguage?.text("projects","m_657063d3eb6d4c",`Locating ${v0} addresses…`,{v0}) ?? `Locating ${v0} addresses…`)(state.geocodeQueue.length + 1);
    else if (missing) subText.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("projects","m_bb6033be5beecd",`${v0} on the map · ${v1} without a location`,{v0,v1}) ?? `${v0} on the map · ${v1} without a location`)(located,missing);
    else subText.textContent = (globalThis.PlatformLanguage?.text("projects","m_fd6f1fb0ffdb94","All on the map") ?? "All on the map");
    state.root.querySelector('.pm-reopen-count').textContent = String(visible.length);
  }

  function renderLegend(){
    const legend = state.root.querySelector('.pm-legend');
    const groups = Array.isArray(state.model?.groups) ? state.model.groups : [];
    const counts = new Map();
    for (const id of state.order) { const item = state.items.get(id); counts.set(item.groupId, (counts.get(item.groupId) || 0) + 1); }
    const shown = groups.filter((group) => counts.get(String(group.id)));
    legend.hidden = shown.length < 2;
    if (legend.hidden) return;
    if (state.model?.groupLabel === 'board') legend.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("projects","m_38e7f48aabdeae","Filter the map by board") ?? "Filter the map by board"));
    else legend.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("projects","m_2805c66abd68dd","Filter the map by stage") ?? "Filter the map by stage"));
    const chips = shown.map((group) => {
      const id = String(group.id);
      const on = !state.hiddenGroups.has(id);
      return `<button type="button" class="pm-chip" data-group="${escapeHtml(id)}" aria-pressed="${on}" style="--chip-color:${safeColor(group.color)}"><span class="pm-chip-dot" aria-hidden="true"></span><span class="pm-chip-label">${escapeHtml(group.title || '')}</span><span class="pm-chip-count">${counts.get(id) || 0}</span></button>`;
    }).join('');
    const reset = state.hiddenGroups.size ? `<button type="button" class="pm-chip pm-chip-reset" data-reset aria-pressed="true"><i class="fas fa-rotate-left" aria-hidden="true"></i><span class="pm-chip-label">${(globalThis.PlatformLanguage?.htmlText("projects","m_8cc2f1209a70dc","Show all") ?? "Show all")}</span></button>` : '';
    legend.innerHTML = chips + reset;
  }

  function rowHtml(item, isNew){
    const classes = ['pm-row'];
    if (!item.point) classes.push('is-unlocated');
    if (item.id === state.selectedId) classes.push('is-selected');
    if (item.id === state.hotId) classes.push('is-hot');
    if (isNew) classes.push('is-new');
    const locating = !item.point && item.address && state.geocodePending.has(addressKey(item.address));
    const flag = item.point ? '' : (locating
      ? `<span class="pm-row-flag"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("projects","m_68601f4e03fe5a","Locating") ?? "Locating")}</span>`
      : `<span class="pm-row-flag" title="${(globalThis.PlatformLanguage?.htmlText("projects","m_44a65246c745c8","This project has no location to show on the map") ?? "This project has no location to show on the map")}"><i class="fas fa-location-crosshairs" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("projects","m_dd869d1ad0872f","No location") ?? "No location")}</span>`);
    const addr = [item.line1, item.line2].filter(Boolean).join(', ');
    return `<button type="button" class="${classes.join(' ')}" data-id="${escapeHtml(item.id)}" style="--pin-color:${item.color}"><span class="pm-row-dot" aria-hidden="true"></span><span class="pm-row-main"><span class="pm-row-title" style="display:block">${escapeHtml(item.title || item.line1 || '')}</span><span class="pm-row-addr" style="display:block">${escapeHtml(addr || item.groupTitle || '')}</span></span><span class="pm-row-side">${flag}<span class="pm-row-open" title="${(globalThis.PlatformLanguage?.htmlText("projects","m_27136d1254783a","Open project") ?? "Open project")}"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></span></span></button>`;
  }

  function renderList(){
    const list = state.root.querySelector('.pm-list');
    const visible = visibleItems();
    if (!visible.length) {
      list.innerHTML = `<div class="pm-empty"><i class="fas fa-map-location-dot" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("projects","m_eebd895a6b0138","No projects match this view.") ?? "No projects match this view.")}</div>`;
      return;
    }
    const scroll = list.scrollTop;
    const located = visible.filter((item) => item.point);
    const unlocated = visible.filter((item) => !item.point);
    const seen = state.seenRowIds;
    const firstRender = !seen.size;
    let html = located.map((item) => rowHtml(item, !firstRender && !seen.has(item.id))).join('');
    if (unlocated.length) html += `<div class="pm-section">${((v0) => globalThis.PlatformLanguage?.htmlText("projects","m_74da0dce613dc4",`No location · ${v0}`,{v0}) ?? `No location · ${v0}`)(unlocated.length)}</div>` + unlocated.map((item) => rowHtml(item, !firstRender && !seen.has(item.id))).join('');
    list.innerHTML = html;
    list.scrollTop = scroll;
    state.seenRowIds = new Set(visible.map((item) => item.id));
  }

  function renderTray(){
    if (!state.root) return;
    renderTrayHead();
    renderLegend();
    renderList();
    renderStatus();
    setTrayOpen(state.trayOpen, { remember:false });
  }

  /* ---------- Markers ---------- */
  function markerFor(item){
    let entry = state.markers.get(item.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'pm-marker is-entering';
      el.dataset.id = item.id;
      el.innerHTML = `<span class="pm-pulse" aria-hidden="true"></span><button type="button" class="pm-pin"></button>`;
      const pin = el.querySelector('.pm-pin');
      pin.addEventListener('mouseenter', () => setHot(item.id, 'pin'));
      pin.addEventListener('mouseleave', () => setHot('', 'pin'));
      pin.addEventListener('focus', () => setHot(item.id, 'pin'));
      pin.addEventListener('blur', () => setHot('', 'pin'));
      pin.addEventListener('click', (event) => { event.stopPropagation(); select(item.id, { pan:true, from:'pin' }); });
      entry = { el, item };
      state.markers.set(item.id, entry);
      state.layer.div.appendChild(el);
      const delay = reducedMotion() ? 0 : Math.min(320, state.markers.size * 8);
      setTimeout(() => requestAnimationFrame(() => el.classList.remove('is-entering')), delay);
    }
    entry.item = item;
    entry.el.style.setProperty('--pin-color', item.color);
    entry.el.querySelector('.pm-pin').setAttribute('aria-label', [item.title, item.line1, item.groupTitle].filter(Boolean).join(', '));
    entry.el.classList.remove('is-leaving');
    entry.el.classList.toggle('is-selected', item.id === state.selectedId);
    entry.el.classList.toggle('is-hot', item.id === state.hotId);
    return entry;
  }

  function removeLater(el){
    el.classList.add('is-leaving');
    setTimeout(() => { if (el.classList.contains('is-leaving')) el.remove(); }, reducedMotion() ? 0 : 260);
  }

  function syncMarkers(){
    if (!state.map || !state.layer?.div) return;
    const wanted = new Set();
    for (const item of locatedItems()) { wanted.add(item.id); markerFor(item); }
    for (const [id, entry] of state.markers) {
      if (wanted.has(id)) continue;
      state.markers.delete(id);
      removeLater(entry.el);
    }
    renderStatus();
    layoutMarkers();
  }

  function layoutMarkers(){
    const projection = state.layer?.getProjection?.();
    const mapProjection = state.map?.getProjection?.();
    if (!projection || !state.map) return;
    const zoom = state.map.getZoom() || 4;
    const scale = Math.pow(2, zoom);
    const cells = new Map();
    const positions = new Map();
    for (const [id, entry] of state.markers) {
      const latLng = new window.google.maps.LatLng(entry.item.point.lat, entry.item.point.lng);
      const px = projection.fromLatLngToDivPixel(latLng);
      if (!px) continue;
      positions.set(id, px);
      entry.el.style.transform = `translate(${px.x}px, ${px.y}px)`;
      if (zoom > CLUSTER_MAX_ZOOM || !mapProjection) continue;
      const world = mapProjection.fromLatLngToPoint(latLng);
      const key = `${Math.floor(world.x * scale / CLUSTER_CELL_PX)}:${Math.floor(world.y * scale / CLUSTER_CELL_PX)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(id);
    }
    const clustered = new Set();
    const nextClusters = new Map();
    for (const [key, ids] of cells) {
      if (ids.length < 2) continue;
      ids.forEach((id) => clustered.add(id));
      nextClusters.set(`${zoom}:${key}`, ids);
    }
    for (const [id, entry] of state.markers) entry.el.classList.toggle('is-clustered', clustered.has(id));
    for (const [key, cluster] of state.clusters) {
      if (nextClusters.has(key)) continue;
      state.clusters.delete(key);
      removeLater(cluster.el);
    }
    for (const [key, ids] of nextClusters) {
      let cluster = state.clusters.get(key);
      if (!cluster) {
        const el = document.createElement('div');
        el.className = 'pm-cluster is-entering';
        el.innerHTML = '<button type="button" class="pm-cluster-btn"><span></span></button>';
        el.querySelector('button').addEventListener('click', (event) => { event.stopPropagation(); zoomToIds(state.clusters.get(key)?.ids || []); });
        state.layer.div.appendChild(el);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
        cluster = { el, ids };
        state.clusters.set(key, cluster);
      }
      cluster.ids = ids;
      let x = 0, y = 0;
      const colors = new Map();
      for (const id of ids) {
        const px = positions.get(id); x += px.x; y += px.y;
        const color = state.markers.get(id)?.item.color || FALLBACK_COLOR;
        colors.set(color, (colors.get(color) || 0) + 1);
      }
      x /= ids.length; y /= ids.length;
      let angle = 0;
      const stops = [...colors].map(([color, count]) => { const from = angle; angle += count / ids.length * 360; return `${color} ${from}deg ${angle}deg`; });
      const size = Math.round(Math.min(58, 34 + Math.log2(ids.length) * 5));
      cluster.el.style.transform = `translate(${x}px, ${y}px)`;
      cluster.el.style.setProperty('--size', `${size}px`);
      cluster.el.style.setProperty('--ring', `conic-gradient(${stops.join(',')})`);
      cluster.el.querySelector('span').textContent = String(ids.length);
      cluster.el.querySelector('button').setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("projects","m_93d53b62f82de9",`${v0} projects here. Zoom in.`,{v0}) ?? `${v0} projects here. Zoom in.`)(ids.length));
      cluster.el.classList.toggle('is-hot', ids.includes(state.hotId) || ids.includes(state.selectedId));
    }
    positionPreview(positions);
  }

  function clusterContaining(id){
    for (const cluster of state.clusters.values()) if (cluster.ids.includes(id)) return cluster;
    return null;
  }

  /* ---------- Highlight and selection ---------- */
  function setHot(id, from){
    id = String(id || '');
    if (state.hotId === id) return;
    const previous = state.hotId;
    state.hotId = id;
    for (const target of [previous, id]) {
      if (!target) continue;
      state.markers.get(target)?.el.classList.toggle('is-hot', target === id);
      state.root?.querySelector(`.pm-row[data-id="${CSS.escape(target)}"]`)?.classList.toggle('is-hot', target === id);
    }
    for (const cluster of state.clusters.values()) cluster.el.classList.toggle('is-hot', cluster.ids.includes(id) || cluster.ids.includes(state.selectedId));
    if (id && from === 'pin') revealRow(id);
  }
  function revealRow(id){
    if (!state.trayOpen) return;
    const row = state.root?.querySelector(`.pm-row[data-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block:'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function select(id, options = {}){
    id = String(id || '');
    const previous = state.selectedId;
    state.selectedId = id;
    for (const target of [previous, id]) {
      if (!target) continue;
      state.markers.get(target)?.el.classList.toggle('is-selected', target === id);
      state.root?.querySelector(`.pm-row[data-id="${CSS.escape(target)}"]`)?.classList.toggle('is-selected', target === id);
    }
    renderPreview();
    if (!id) { layoutMarkers(); return; }
    const item = state.items.get(id);
    if (options.from === 'pin') revealRow(id);
    if (item?.point && options.pan) {
      const needsZoom = !!clusterContaining(id) || (state.map?.getZoom() || 0) < (options.from === 'list' ? FOCUS_ZOOM : 0);
      flyTo(item.point, needsZoom ? Math.max(FOCUS_ZOOM, (state.map?.getZoom() || 0)) : (state.map?.getZoom() || FOCUS_ZOOM));
      if (isSheet() && options.from === 'list') setTrayOpen(false);
    }
    layoutMarkers();
  }

  function renderPreview(){
    state.previewEl?.remove();
    state.previewEl = null;
    const item = state.items.get(state.selectedId);
    if (!item?.point || !state.layer?.div) return;
    const el = document.createElement('div');
    el.className = 'pm-preview';
    el.style.setProperty('--pin-color', item.color);
    el.innerHTML = `<div class="pm-preview-card" role="dialog" aria-label="${escapeHtml(item.title || item.line1 || '')}"><div class="pm-preview-stripe"></div><div class="pm-preview-body"><button type="button" class="pm-preview-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("projects","m_20f1b0df4fe241","Close preview") ?? "Close preview")}"><i class="fas fa-xmark" aria-hidden="true"></i></button><div class="pm-preview-title">${escapeHtml(item.title || item.line1 || '')}</div><div class="pm-preview-addr">${escapeHtml(item.line1 || '')}${item.line2 ? `<span>${escapeHtml(item.line2)}</span>` : ''}</div><div class="pm-preview-foot"><span class="pm-stage-pill">${escapeHtml(item.groupTitle || '')}</span><button type="button" class="pm-open">${(globalThis.PlatformLanguage?.htmlText("projects","m_27136d1254783a","Open project") ?? "Open project")}<i class="fas fa-arrow-right" aria-hidden="true"></i></button></div></div></div>`;
    el.querySelector('.pm-preview-close').addEventListener('click', (event) => { event.stopPropagation(); select('', { pan:false }); });
    el.querySelector('.pm-open').addEventListener('click', (event) => { event.stopPropagation(); openItem(item); });
    el.addEventListener('click', (event) => event.stopPropagation());
    state.layer.div.appendChild(el);
    state.previewEl = el;
  }
  function positionPreview(positions){
    if (!state.previewEl) return;
    const px = positions.get(state.selectedId);
    if (!px || clusterContaining(state.selectedId)) { state.previewEl.style.visibility = 'hidden'; return; }
    state.previewEl.style.visibility = '';
    state.previewEl.style.transform = `translate(${px.x}px, ${px.y}px)`;
  }

  function openItem(item){
    try { state.model?.open?.(item.project, item); } catch (error) { console.warn('Project could not be opened from the map', error); }
  }

  /* ---------- Camera ---------- */
  function trayInsets(){
    const insets = { top:56, right:64, bottom:56, left:56 };
    if (!state.trayOpen || !state.root) return insets;
    const tray = state.root.querySelector('.pm-tray');
    const rootRect = state.root.getBoundingClientRect();
    const rect = tray?.getBoundingClientRect();
    if (!rect || !rect.width) return insets;
    if (isSheet()) insets.bottom = Math.min(rootRect.height * 0.6, rect.height + 24);
    else insets.left = Math.min(rootRect.width * 0.6, rect.width + 36);
    return insets;
  }

  function withProgrammaticMove(fn){
    state.programmaticMove += 1;
    try { fn(); } finally { setTimeout(() => { state.programmaticMove = Math.max(0, state.programmaticMove - 1); }, 700); }
  }

  function fitAll(options = {}){
    if (!state.map) return;
    const located = locatedItems();
    state.userMovedSinceFit = false;
    if (!located.length) return;
    const insets = trayInsets();
    withProgrammaticMove(() => {
      if (located.length === 1) {
        flyTo(located[0].point, 15, { instant: !options.animate });
        return;
      }
      const bounds = new window.google.maps.LatLngBounds();
      located.forEach((item) => bounds.extend(item.point));
      state.map.fitBounds(bounds, insets);
    });
  }

  function zoomToIds(ids){
    const points = ids.map((id) => state.items.get(id)?.point).filter(Boolean);
    if (!points.length || !state.map) return;
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point));
    const target = Math.min(CLUSTER_MAX_ZOOM + 2, (state.map.getZoom() || 4) + 3);
    const span = bounds.toSpan();
    if (span.lat() < 1e-5 && span.lng() < 1e-5) { flyTo(points[0], Math.max(target, 18)); return; }
    withProgrammaticMove(() => state.map.fitBounds(bounds, trayInsets()));
  }

  // Smooth camera: zoom out until the target is in view, glide to it, then zoom in a step at a time.
  async function flyTo(point, zoom, options = {}){
    if (!state.map || !point) return;
    const token = ++state.flightToken;
    const map = state.map;
    const latLng = new window.google.maps.LatLng(point.lat, point.lng);
    const offset = () => {
      const insets = trayInsets();
      return { x: (insets.left - insets.right) / 2, y: (insets.bottom - insets.top) / 2 };
    };
    state.programmaticMove += 1;
    try {
      if (options.instant || reducedMotion()) {
        map.setZoom(zoom);
        map.setCenter(latLng);
        const o = offset();
        if (o.x || o.y) map.panBy(-o.x, o.y);
        return;
      }
      let current = map.getZoom() || 4;
      let guard = 0;
      while (map.getBounds() && !map.getBounds().contains(latLng) && current > 5 && guard++ < 6) {
        current -= 1;
        map.setZoom(current);
        await wait(200);
        if (token !== state.flightToken) return;
      }
      map.panTo(latLng);
      await wait(420);
      if (token !== state.flightToken) return;
      while (current < zoom) {
        current = Math.min(zoom, current + (zoom - current > 4 ? 2 : 1));
        map.setZoom(current);
        await wait(190);
        if (token !== state.flightToken) return;
      }
      if (current > zoom) { map.setZoom(zoom); await wait(190); }
      const o = offset();
      if (o.x || o.y) map.panBy(-o.x, o.y);
    } finally {
      setTimeout(() => { state.programmaticMove = Math.max(0, state.programmaticMove - 1); }, 600);
    }
  }

  window.FirstMateProjectsMap = {
    update,
    available: () => true
  };
})();
