/**
 * fetcher.js — 3-Step Pipeline Frontend
 *
 * Step 1: Fetch Businesses — tile grid on map, nearby search only
 * Step 2: Filter Businesses — keyword/type/rating filters, save named lists
 * Step 3: Fetch Business Info — place details + hunter on filtered lists
 */

(function () {
  "use strict";
  if (!window.Portal) return;

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const MI2KM = 1.60934;
  const KM_PER_DEG_LAT = 111.32;
  const GMAPS_KEY = String(window.PORTAL_CFG?.browser_google_api_key || '').trim();
  function isManager(){
    const perms = cfg().perms || {};
    const role = String(cfg().user?.role || "").toLowerCase();
    return !!(perms.manage_users || perms.manage_sales_users || perms.create_users || role === "admin" || role === "system_admin");
  }

  // Google pricing
  const PRICE_NEARBY = 0.032;  // per call
  const PRICE_DETAIL = 0.017;  // per call
  const PRICE_HUNTER = 0.0;    // free tier or flat — user can adjust

  // ─── State ─────────────────────────────────────────────────────────────────
  let map, config = { center_lat:47.6062, center_lng:-122.3321, tile_side_miles:1, search_type:"roofing_contractor", zoom:11 };
  let legacyConfig = {};
  let mapOverlay = null;
  let tileStatus = {}, selectedTiles = {}, tileRects = {}, tileCircles = {}, legacyTileRects = {};
  let gridRows=0, gridCols=0, originLat=0, originLng=0, dLat=0, dLng=0;
  let pulling = false, currentStep = 1;
  let gmapsLoadTimer = null;
  let territoryBooted = false;
  let wheelZoomCooldown = null;
  let suppressCursorZoomOnce = false;

  // Step 2
  let rawBusinesses = [], filteredIds = new Set();
  let detailIndex = {};  // place_id -> true if detailed
  let derivedStates = []; // unique states found in data
  let savedListPlaceIds = new Set();
  let rawBusinessesLoaded = false;
  let filterListsLoaded = false;
  let s2VisibleRows = [];
  let s2RenderedCount = 0;
  let s3VisibleRows = [];
  let s3RenderedCount = 0;
  let filterState = {
    includeKeywords: "roof,roofing",
    excludeKeywords: "gutter only,solar only",
    includeMode: "any",        // any | all
    minRating: 0,
    minReviews: 0,
    onlyOperational: true,
    scoreWeights: { keyword: 50, rating: 30, reviews: 20 },
  };
  let filterLists = [];
  const S2_RENDER_BATCH = 250;
  const S3_RENDER_BATCH = 200;

  // Step 3
  let activeList = null, detailQueue = [], detailedPlaces = [];
  let s4LeadPreview = null;

  function numOr(value, fallback){
    const n = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeConfig(next){
    const base = next || {};
    config.center_lat = numOr(base.center_lat, 47.6062);
    config.center_lng = numOr(base.center_lng, -122.3321);
    config.tile_side_miles = numOr(base.tile_side_miles, 1);
    config.zoom = Math.max(2, Math.round(numOr(base.zoom, 11)));
    config.search_type = String(base.search_type || "roofing_contractor");
  }

  function sameBounds(a, b){
    if(!a || !b) return false;
    const eps = 0.000001;
    return Math.abs((a.south ?? 0) - (b.south ?? 0)) < eps &&
      Math.abs((a.north ?? 0) - (b.north ?? 0)) < eps &&
      Math.abs((a.west ?? 0) - (b.west ?? 0)) < eps &&
      Math.abs((a.east ?? 0) - (b.east ?? 0)) < eps;
  }

  function gridAnchorLat(){
    const legacyLat = numOr(legacyConfig.center_lat, null);
    if(Number.isFinite(legacyLat)) return legacyLat;
    return config.center_lat;
  }

  // ─── API ───────────────────────────────────────────────────────────────────
  async function api(action, data={}) {
    const payload = { action: `territory_${action}` };
    Object.entries(data || {}).forEach(([key, value]) => {
      payload[key] = (Array.isArray(value) || (value && typeof value === "object"))
        ? JSON.stringify(value)
        : value;
    });
    return Portal.apiPost(cfg().endpoints.server, payload);
  }
  function esc(s){ if(!s)return""; const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
  function ensureMarkup(){
    const host=document.getElementById("portalPluginViews");
    if(!host || document.getElementById("view-territory-builder")) return;
    const wrap=document.createElement("div");
    wrap.id="view-territory-builder";
    wrap.style.display="none";
    wrap.innerHTML='<div id="territoryRoot" style="width:100%;height:calc(100vh - 112px);"></div>';
    host.appendChild(wrap);
  }
  function setMapStatus(msg, isError){
    const el=document.getElementById("FmapStatus");
    if(!el) return;
    el.style.display="block";
    el.style.borderColor=isError?"#f5c2c7":"var(--c-bdr)";
    el.style.background=isError?"rgba(255,245,245,.98)":"rgba(255,255,255,.96)";
    el.style.color=isError?"#842029":"var(--c-tx2)";
    el.innerHTML=msg;
  }
  function clearMapStatus(){
    const el=document.getElementById("FmapStatus");
    if(el) el.style.display="none";
  }

  function screenPointToLatLng(x, y){
    if(!mapOverlay) return null;
    const projection = mapOverlay.getProjection?.();
    if(!projection) return null;
    return projection.fromContainerPixelToLatLng(new google.maps.Point(x, y));
  }

  // ─── Build UI ──────────────────────────────────────────────────────────────
  function build() {
    document.getElementById("territoryRoot").innerHTML = `
    <div id="F">
      <header id="Fbar">
        <div id="Flogo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Territory Fetcher</div>
        <nav id="Fsteps">
          <button class="Fstep active" data-step="1"><span class="Fstep-num">1</span> Fetch Businesses</button>
          <span class="Fstep-arrow">→</span>
          <button class="Fstep" data-step="2"><span class="Fstep-num">2</span> Filter Businesses</button>
          <span class="Fstep-arrow">→</span>
          <button class="Fstep" data-step="3"><span class="Fstep-num">3</span> Fetch Info</button>
          <span class="Fstep-arrow">→</span>
          <button class="Fstep" data-step="4"><span class="Fstep-num">4</span> Generate Lead Lists</button>
          <span class="Fstep-arrow">·</span>
          <button class="Fstep" data-step="5"><span class="Fstep-num">$</span> Costs</button>
        </nav>
        <div id="Fbar-right"><span id="Fbadge">—</span></div>
      </header>

      <div id="Fbody">
        <!-- ═══ STEP 1 ═══ -->
        <section id="step1" class="Fpane active">
          <div id="Fmap"><div id="FmapStatus">Loading Google Maps…</div></div>
          <div id="f-select-box"></div>
          <div id="S1ctrl">
            <div class="S1title">STEP 1 · Nearby Search</div>
            <div class="S1price-note">$0.032 / search call · max 3 pages per tile</div>
            <div class="S1divider"></div>

            <div class="S2group">
              <label class="S2label">Grid Center</label>
              <div class="S1center-row">
                <input type="number" id="s1CenterLat" step="0.0001" placeholder="Lat">
                <input type="number" id="s1CenterLng" step="0.0001" placeholder="Lng">
              </div>
              <button class="Fbtn Fbtn-ghost" id="s1UseMapCenter" style="width:100%;margin-top:4px">Use Current Map Center</button>
            </div>

            <label>Tile size (miles)<input type="number" id="s1TileSize" min="0.25" max="5" step="0.25" value="1.0"></label>
            <label>Search type<input type="text" id="s1Type" value="roofing_contractor"></label>
            <label>Grid extent<input type="number" id="s1Extent" min="1" max="30" step="1" value="5"></label>
            <button class="Fbtn Fbtn-accent" id="s1GenGrid">Generate Grid</button>
            <button class="Fbtn Fbtn-ghost" id="territoryMigrateBtn" style="width:100%;margin-top:6px">Migrate Legacy Territory Data</button>

            <div class="S1divider"></div>
            <div class="S1title">Selection</div>
            <div class="S1hint-box">Left-drag to box-select tiles · Middle-drag to pan map</div>
            <div id="s1SelSummary">
              <div class="S1big"><span id="s1SelCount">0</span> tiles</div>
              <div class="S1cost">Est: <strong id="s1Cost">$0.00</strong> <span class="S1sm">(<span id="s1Calls">0</span> search calls)</span></div>
            </div>
            <div class="S1btnrow">
              <button class="Fbtn Fbtn-ghost" id="s1SelAll">Select Unpulled</button>
              <button class="Fbtn Fbtn-ghost" id="s1SelSaturated">Select Saturated</button>
              <button class="Fbtn Fbtn-ghost" id="s1Clear">Clear</button>
            </div>
            <button class="Fbtn Fbtn-green" id="s1Pull" disabled>Pull Nearby Search</button>
            <button class="Fbtn Fbtn-red Fhide" id="s1DeleteSelected" style="width:100%;margin-top:8px">Delete Selected Native Tiles</button>
            <button class="Fbtn Fbtn-subdivide Fhide" id="s1Subdivide">Subdivide & Re-Pull Selected</button>
            <div id="s1Progress" class="Fhide">
              <div class="Fpbar"><div class="Fpfill" id="s1Pfill"></div></div>
              <div class="Fptxt" id="s1Ptxt"></div>
            </div>

            <div class="S1divider"></div>
            <div class="S1legend">
              <span><i style="background:#fee2e2;border-color:#d93025"></i> Unpulled</span>
              <span><i style="background:#fef08a;border-color:#ca8a04"></i> Selected</span>
              <span><i style="background:#bbf7d0;border-color:#16a34a"></i> Pulled</span>
              <span><i style="background:#fed7aa;border-color:#ea580c"></i> Saturated (60+)</span>
              <span><i style="background:#ffe4e6;border-color:#fb7185"></i> Legacy (diff size)</span>
            </div>
          </div>
        </section>

        <!-- ═══ STEP 2 ═══ -->
        <section id="step2" class="Fpane">
          <div id="S2">
            <div id="S2left">
              <div class="S2panel">
                <div class="S2title">STEP 2 · Filter & Build Lists</div>
                <div class="S1price-note">No API cost — filters run on local data</div>
                <div class="S1divider"></div>

                <div class="S2group">
                  <label class="S2label">Include keywords <span class="S2hint">(comma-separated, matched against name. Leave empty for all)</span></label>
                  <input type="text" id="s2Include" value="" placeholder="roof, roofing, shingle">
                  <div class="S2radio-row">
                    <label><input type="radio" name="s2IncMode" value="any" checked> Match ANY</label>
                    <label><input type="radio" name="s2IncMode" value="all"> Match ALL</label>
                  </div>
                </div>

                <div class="S2group">
                  <label class="S2label">Exclude keywords <span class="S2hint">(remove if name contains)</span></label>
                  <input type="text" id="s2Exclude" value="" placeholder="gutter only, solar only">
                </div>

                <div class="S2group">
                  <label class="S2label">Type filter <span class="S2hint">(Google types to require)</span></label>
                  <input type="text" id="s2Types" value="" placeholder="roofing_contractor, general_contractor">
                </div>

                <div class="S2row">
                  <div class="S2group S2half">
                    <label class="S2label">Min rating</label>
                    <input type="number" id="s2MinRating" min="0" max="5" step="0.1" value="0">
                  </div>
                  <div class="S2group S2half">
                    <label class="S2label">Min reviews</label>
                    <input type="number" id="s2MinReviews" min="0" step="1" value="0">
                  </div>
                </div>

                <div class="S2group">
                  <label class="S2label">State</label>
                  <select id="s2State"><option value="">All states</option></select>
                </div>

                <div class="S2group">
                  <label class="S2label">Zip code <span class="S2hint">(comma-separated, or leave empty)</span></label>
                  <input type="text" id="s2Zip" value="" placeholder="98101, 98102, 98103">
                </div>

                <div class="S2group">
                  <label class="S2label">Detail status</label>
                  <select id="s2DetailFilter">
                    <option value="">All</option>
                    <option value="detailed">Already detailed</option>
                    <option value="not_detailed">Not yet detailed</option>
                  </select>
                </div>

                <label class="S2check"><input type="checkbox" id="s2Operational" checked> Only operational businesses</label>
                <label class="S2check"><input type="checkbox" id="s2ExcludeSaved" checked> Exclude businesses already on saved lists</label>

                <div class="S1divider"></div>

                <div class="S2group">
                  <div class="S2label">Relevance Score Weights</div>
                  <div class="S2hint" style="margin-bottom:8px">Adjust how matches are scored (0-100)</div>
                  <div class="S2weights">
                    <label>Keyword match<input type="number" id="s2wKey" min="0" max="100" value="50"></label>
                    <label>Rating<input type="number" id="s2wRat" min="0" max="100" value="30"></label>
                    <label>Review count<input type="number" id="s2wRev" min="0" max="100" value="20"></label>
                  </div>
                </div>

                <button class="Fbtn Fbtn-accent" id="s2Apply" style="width:100%">Apply Filters</button>

                <div class="S1divider"></div>

                <div id="s2ResultSummary" class="S2result-summary"></div>

                <div class="S2group">
                  <label class="S2label">Save as list</label>
                  <div class="S2saverow">
                    <input type="text" id="s2ListName" placeholder="my-roofing-list" value="">
                    <button class="Fbtn Fbtn-accent" id="s2Save">Save</button>
                  </div>
                </div>

                <div class="S1divider"></div>
                <div class="S2label">Saved Lists</div>
                <div id="s2Lists"></div>
              </div>
            </div>

            <div id="S2right">
              <div id="s2TableBar">
                <input type="text" id="s2Search" class="Fsearch" placeholder="Search results…">
                <span id="s2Count" class="S2countBadge">0</span>
              </div>
              <div id="s2TableWrap">
                <table id="s2Table">
                  <thead>
                    <tr>
                      <th data-sort="score">Score</th>
                      <th data-sort="name">Name</th>
                      <th data-sort="vicinity">Location</th>
                      <th data-sort="state">State</th>
                      <th data-sort="rating">Rating</th>
                      <th data-sort="reviews">Reviews</th>
                      <th data-sort="photos">Photos</th>
                      <th>Hours</th>
                      <th data-sort="price">Price</th>
                      <th>Types</th>
                      <th>Status</th>
                      <th data-sort="detailed">Detailed</th>
                      <th>Tile</th>
                    </tr>
                  </thead>
                  <tbody id="s2Tbody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <!-- ═══ STEP 3 ═══ -->
        <section id="step3" class="Fpane">
          <div id="S3">
            <div id="S3top">
              <div class="S3panel">
                <div class="S2title">STEP 3 · Fetch Details &amp; Hunter</div>
                <div class="S1price-note">$0.017 / Place Detail call · Hunter: per your plan</div>
                <div class="S1divider"></div>

                <div class="S2group">
                  <label class="S2label">Select a filter list</label>
                  <select id="s3ListSelect"><option value="">— choose —</option></select>
                </div>

                <button class="Fbtn Fbtn-accent" id="s3LoadQueue" style="width:100%">Refresh Queue</button>

                <div id="s3QueueInfo" class="Fhide">
                  <div class="S1divider"></div>
                  <div class="S3qgrid">
                    <div class="S3qbox"><div class="S3qnum" id="s3Total">0</div><div class="S3qlbl">Total</div></div>
                    <div class="S3qbox"><div class="S3qnum S3green" id="s3Done">0</div><div class="S3qlbl">Detailed</div></div>
                    <div class="S3qbox"><div class="S3qnum S3yellow" id="s3Needed">0</div><div class="S3qlbl">Remaining</div></div>
                  </div>
                  <div class="S2group" style="margin-top:10px">
                    <div class="S3cost-line">Detail calls: <strong id="s3DetailCost">$0.00</strong></div>
                  </div>
                  <button class="Fbtn Fbtn-green" id="s3PullDetails" style="width:100%">Fetch Details</button>
                  <div id="s3Progress" class="Fhide" style="margin-top:8px">
                    <div class="Fpbar"><div class="Fpfill" id="s3Pfill"></div></div>
                    <div class="Fptxt" id="s3Ptxt"></div>
                  </div>
                </div>

                <div class="S1divider"></div>
                <button class="Fbtn Fbtn-ghost" id="s3LoadResults" style="width:100%">Refresh Results</button>
              </div>
            </div>

            <div id="S3bottom">
              <div id="s3TableBar">
                <input type="text" id="s3Search" class="Fsearch" placeholder="Search detailed results…">
                <span id="s3Count" class="S2countBadge">0</span>
                <button class="Fbtn Fbtn-ghost" id="s3ExportCsv" style="margin-left:auto">Export CSV</button>
              </div>
              <div id="s3TableWrap">
                <table id="s3Table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Address</th>
                      <th>Phone</th>
                      <th>Website</th>
                      <th>Rating</th>
                      <th>Reviews</th>
                      <th>Status</th>
                      <th>Hunter</th>
                    </tr>
                  </thead>
                  <tbody id="s3Tbody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <section id="step4" class="Fpane">
          <div id="S4LeadLists">
            <div class="S4lead-header">
              <div>
                <div class="S2title">STEP 4 · Generate Lead Lists</div>
                <div class="S1price-note">Create CRM-ready lead lists from saved territory lists and control the batch size here.</div>
              </div>
              <button class="Fbtn Fbtn-ghost" id="s4LeadRefresh">Refresh Territory Lists</button>
            </div>

            <div class="S4lead-grid">
              <div class="S4lead-sidebar">
                <div class="S2group">
                  <label class="S2label">Territory list</label>
                  <select id="s4LeadListSelect"><option value="">— choose a saved territory list —</option></select>
                </div>

                <div class="S2group">
                  <label class="S2label">Max leads per CRM list</label>
                  <input type="number" id="s4LeadChunk" min="1" step="1" value="250">
                </div>

                <div class="S2group">
                  <label class="S2label">State handling</label>
                  <select id="s4LeadGroupMode">
                    <option value="by_state">Keep states separate</option>
                    <option value="ignore_state">Ignore state lines</option>
                  </select>
                </div>

                <button class="Fbtn Fbtn-accent" id="s4LeadCreate" style="width:100%">Generate Lead Lists</button>

                <div id="s4LeadSummary" class="S4lead-summary">
                  <div class="S4lead-empty">Choose a saved territory list to see how it will be split into CRM lead lists.</div>
                </div>
              </div>

              <div class="S4lead-main">
                <div class="S4lead-main-header">
                  <div class="S2title" style="margin:0">Saved Territory Lists</div>
                  <div class="S2hint">Fetch business info first if you want the generated leads to include enriched details.</div>
                </div>
                <div id="s4LeadCards" class="S4lead-cards"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- ═══ STEP 5: COSTS ═══ -->
        <section id="step5" class="Fpane">
          <div id="S5">
            <div id="S4header">
              <div class="S2title">Cost Tracker</div>
              <div class="S1price-note">Actual API calls logged from all operations</div>
              <button class="Fbtn Fbtn-ghost" id="s4Refresh" style="margin-left:auto">Refresh</button>
              <button class="Fbtn Fbtn-red" id="s4Reset">Reset Ledger</button>
            </div>

            <div id="S4grid">
              <div class="S4card S4total">
                <div class="S4card-label">Total Spend</div>
                <div class="S4card-val" id="s4TotalCost">$0.00</div>
                <div class="S4card-sub" id="s4TotalCalls">0 calls</div>
              </div>
              <div class="S4card">
                <div class="S4card-label">Nearby Search</div>
                <div class="S4card-val" id="s4NearCost">$0.00</div>
                <div class="S4card-sub" id="s4NearCalls">0 calls × $0.032</div>
              </div>
              <div class="S4card">
                <div class="S4card-label">Place Details</div>
                <div class="S4card-val" id="s4DetCost">$0.00</div>
                <div class="S4card-sub" id="s4DetCalls">0 calls × $0.017</div>
              </div>
              <div class="S4card">
                <div class="S4card-label">Hunter Domain</div>
                <div class="S4card-val" id="s4HuntDomCost">$0.00</div>
                <div class="S4card-sub" id="s4HuntDomCalls">0 calls</div>
              </div>
              <div class="S4card">
                <div class="S4card-label">Hunter Leads</div>
                <div class="S4card-val" id="s4HuntLeadCost">$0.00</div>
                <div class="S4card-sub" id="s4HuntLeadCalls">0 calls</div>
              </div>
            </div>

            <div id="S4daily">
              <div class="S2title" style="margin-bottom:10px">Daily Breakdown</div>
              <div id="S4dailyTable-wrap">
                <table id="S4dailyTable">
                  <thead><tr><th>Date</th><th>Calls</th><th>Cost</th></tr></thead>
                  <tbody id="s4DailyTbody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <div id="territoryDeleteModal" class="Tmodal Fhide">
          <div class="Tmodal-card">
            <div class="Tmodal-title">Delete selected native tiles?</div>
            <div class="Tmodal-body" id="territoryDeleteModalBody">
              This will remove the selected tiles from the new Territory store only.
            </div>
            <div class="Tmodal-actions">
              <button class="Fbtn Fbtn-ghost" id="territoryDeleteCancel">Cancel</button>
              <button class="Fbtn Fbtn-red" id="territoryDeleteConfirm">Delete Tiles</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
    injectCSS();
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────
  function injectCSS() {
    const s = document.createElement("style");
    s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
    :root {
      --c-bg:#f5f5f7; --c-s1:#ffffff; --c-s2:#f0f0f3; --c-s3:#e8e8ee;
      --c-bdr:#d4d4dc; --c-bdr2:#c0c0cc;
      --c-tx:#1a1a2e; --c-tx2:#5a5a72; --c-tx3:#8a8a9e;
      --c-acc:#d93025; --c-acc2:#ef4444;
      --c-grn:#16a34a; --c-yel:#ca8a04; --c-red:#dc2626; --c-org:#ea580c;
      --ff:'Outfit',sans-serif; --fm:'IBM Plex Mono',monospace;
      --r:8px; --r2:12px;
    }
    #F{display:flex;flex-direction:column;width:100%;height:100%;font-family:var(--ff);background:var(--c-bg);color:var(--c-tx)}

    /* ── Top Bar ── */
    #Fbar{display:flex;align-items:center;height:50px;padding:0 16px;background:var(--c-s1);border-bottom:1px solid var(--c-bdr);gap:16px;flex-shrink:0;z-index:5}
    #Flogo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;color:var(--c-acc);letter-spacing:.4px;white-space:nowrap}
    #Fsteps{display:flex;align-items:center;gap:6px}
    .Fstep{display:flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;font-weight:600;background:transparent;border:1px solid transparent;color:var(--c-tx2);cursor:pointer;border-radius:8px;transition:all .15s;font-family:var(--ff)}
    .Fstep:hover{color:var(--c-tx);background:var(--c-s2)}
    .Fstep.active{color:var(--c-tx);background:var(--c-s2);border-color:var(--c-bdr)}
    .Fstep.done{color:var(--c-grn)}
    .Fstep-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--c-s3);font-size:11px;font-weight:700;font-family:var(--fm)}
    .Fstep.active .Fstep-num{background:var(--c-acc);color:#fff}
    .Fstep.done .Fstep-num{background:var(--c-grn);color:#000}
    .Fstep-arrow{color:var(--c-tx3);font-size:14px}
    #Fbar-right{margin-left:auto}
    #Fbadge{font-size:11px;font-family:var(--fm);background:var(--c-s2);border:1px solid var(--c-bdr);padding:4px 12px;border-radius:999px;color:var(--c-grn)}

    /* ── Body ── */
    #Fbody{flex:1;position:relative;overflow:hidden}
    .Fpane{position:absolute;inset:0;display:none;animation:fadeUp .18s ease-out}
    .Fpane.active{display:flex}
    @keyframes fadeUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .Tmodal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.38);backdrop-filter:blur(4px);z-index:30;padding:20px}
    .Tmodal-card{width:min(460px,100%);background:#fff;border:1px solid var(--c-bdr);border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.24);padding:20px}
    .Tmodal-title{font-size:18px;font-weight:800;color:var(--c-tx)}
    .Tmodal-body{margin-top:10px;font-size:13px;line-height:1.55;color:var(--c-tx2)}
    .Tmodal-actions{margin-top:18px;display:flex;justify-content:flex-end;gap:10px}

    /* ── Shared ── */
    .Fbtn{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;font-size:12px;font-weight:600;border:1px solid var(--c-bdr);border-radius:8px;cursor:pointer;transition:all .15s;font-family:var(--ff);background:var(--c-s2);color:var(--c-tx)}
    .Fbtn:hover{border-color:var(--c-bdr2)}.Fbtn:disabled{opacity:.35;cursor:default}
    .Fbtn-accent{background:var(--c-acc);color:#fff;border-color:var(--c-acc)}.Fbtn-accent:hover{filter:brightness(1.15)}
    .Fbtn-green{background:var(--c-grn);color:#fff;border-color:var(--c-grn);font-size:13px;padding:9px}.Fbtn-green:hover{filter:brightness(1.1)}
    .Fbtn-subdivide{background:var(--c-org);color:#fff;border:1px solid var(--c-org);font-size:12px;padding:8px;width:100%;border-radius:8px;cursor:pointer;font-weight:600;font-family:var(--ff);margin-top:4px}.Fbtn-subdivide:hover{filter:brightness(1.1)}.Fbtn-subdivide:disabled{opacity:.35;cursor:default}
    .Fbtn-ghost{background:transparent;border-color:var(--c-bdr);font-size:11px;padding:5px 10px}
    .Fbtn-red{background:var(--c-red);color:#fff;border-color:var(--c-red);font-size:10px;padding:3px 8px}    .Fhide{display:none!important}
    .Fpbar{height:6px;background:var(--c-s3);border-radius:4px;overflow:hidden;margin-bottom:6px}
    .Fpfill{height:100%;width:0%;background:linear-gradient(90deg,#16a34a,#4ade80);border-radius:4px;transition:width .3s}
    .Fptxt{font-size:11px;font-family:var(--fm);color:var(--c-tx2)}
    .Fsearch{padding:6px 10px;font-size:12px;background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;width:260px;font-family:var(--fm)}
    .Fsearch:focus{border-color:var(--c-acc)}

    /* ══ STEP 1 ══ */
    #step1{flex-direction:row}
    #Fmap{flex:1;height:100%;position:relative;user-select:none;cursor:crosshair;background:#eef2f7}
    #FmapStatus{position:absolute;inset:16px auto auto 16px;z-index:4;max-width:420px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.96);border:1px solid var(--c-bdr);box-shadow:0 10px 30px rgba(15,23,42,.08);font-size:12px;line-height:1.45;color:var(--c-tx2)}
    #S1ctrl{width:290px;padding:14px;overflow-y:auto;background:rgba(255,255,255,.97);border-left:1px solid var(--c-bdr);backdrop-filter:blur(12px);flex-shrink:0;box-shadow:-2px 0 8px rgba(0,0,0,0.04)}
    .S1title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--c-tx2);margin-bottom:6px}
    .S1price-note{font-size:10px;color:var(--c-tx3);font-family:var(--fm);margin-bottom:2px}
    .S1divider{height:1px;background:var(--c-bdr);margin:12px 0}
    #S1ctrl label{display:block;font-size:11px;color:var(--c-tx2);margin-bottom:8px}
    #S1ctrl input{display:block;width:100%;margin-top:4px;padding:6px 8px;font-size:13px;font-family:var(--fm);background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;box-sizing:border-box}
    #S1ctrl input:focus{border-color:var(--c-acc)}
    .S1big{font-size:22px;font-weight:800;font-family:var(--fm)}
    .S1big span{color:var(--c-yel)}
    .S1cost{font-size:12px;color:var(--c-tx2);margin:4px 0 10px}
    .S1cost strong{color:var(--c-yel);font-family:var(--fm)}
    .S1sm{font-size:10px}
    .S1btnrow{display:flex;gap:6px;margin-bottom:4px}
    .S1legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--c-tx2)}
    .S1legend span{display:flex;align-items:center;gap:5px}
    .S1legend i{display:block;width:14px;height:14px;border-radius:3px;border:2px solid}
    .S1center-row{display:flex;gap:6px}
    .S1center-row input{flex:1;font-size:12px;font-family:var(--fm);padding:5px 6px;background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;box-sizing:border-box}
    .S1center-row input:focus{border-color:var(--c-acc)}
    .S1hint-box{font-size:10px;color:var(--c-tx3);background:var(--c-s2);border:1px solid var(--c-bdr);border-radius:6px;padding:5px 8px;margin-bottom:8px;text-align:center}

    /* Box selection overlay */
    #f-select-box{position:absolute;border:2px dashed var(--c-acc);background:rgba(217,48,37,0.1);pointer-events:none;z-index:3;display:none}

    /* ══ STEP 2 ══ */
    #S2{display:flex;width:100%;height:100%}
    #S2left{width:340px;overflow-y:auto;border-right:1px solid var(--c-bdr);flex-shrink:0;background:var(--c-s1)}
    .S2panel{padding:14px}
    .S2title{font-size:13px;font-weight:700;margin-bottom:4px}
    .S2group{margin-bottom:10px}
    .S2label{font-size:11px;font-weight:600;color:var(--c-tx2);display:block;margin-bottom:4px}
    .S2hint{font-weight:400;color:var(--c-tx3);font-size:10px}
    #S2 input[type="text"],#S2 input[type="number"],#S2 select{display:block;width:100%;padding:6px 8px;font-size:12px;font-family:var(--fm);background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;box-sizing:border-box}
    #S2 input:focus,#S2 select:focus{border-color:var(--c-acc)}
    .S2radio-row{display:flex;gap:12px;margin-top:4px;font-size:11px;color:var(--c-tx2)}
    .S2radio-row input{width:auto;display:inline;margin-right:3px}
    .S2check{font-size:11px;color:var(--c-tx2);display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer}
    .S2check input{width:auto;display:inline}
    .S2row{display:flex;gap:10px}.S2half{flex:1}
    .S2weights{display:flex;gap:8px}.S2weights label{flex:1;font-size:10px;color:var(--c-tx3)}
    .S2weights input{margin-top:3px}
    .S2result-summary{font-size:13px;font-family:var(--fm);color:var(--c-tx);padding:8px 0}
    .S2saverow{display:flex;gap:6px}.S2saverow input{flex:1}

    #S2right{flex:1;display:flex;flex-direction:column;overflow:hidden}
    #s2TableBar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--c-s1);border-bottom:1px solid var(--c-bdr)}
    .S2countBadge{font-size:11px;font-family:var(--fm);background:var(--c-acc);color:#fff;padding:2px 10px;border-radius:999px}
    #s2TableWrap{flex:1;overflow:auto}
    #s2Table{width:100%;border-collapse:collapse;font-size:12px}
    #s2Table thead{position:sticky;top:0;z-index:1;background:var(--c-s2)}
    #s2Table th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--c-tx3);border-bottom:1px solid var(--c-bdr);cursor:pointer;user-select:none}
    #s2Table th:hover{color:var(--c-tx2)}
    #s2Table td{padding:6px 10px;border-bottom:1px solid var(--c-bdr);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}
    #s2Table tbody tr:hover{background:var(--c-s2)}
    #s2Table .score-bar{display:inline-block;height:4px;border-radius:2px;background:var(--c-acc);vertical-align:middle;margin-right:6px}

    /* List cards */
    .S2list-card{background:var(--c-s2);border:1px solid var(--c-bdr);border-radius:var(--r);padding:8px 10px;margin-bottom:6px;display:flex;align-items:center;gap:10px}
    .S2list-card:hover{border-color:var(--c-bdr2)}
    .S2list-name{font-weight:600;font-size:12px;flex:1}
    .S2list-count{font-family:var(--fm);font-size:11px;color:var(--c-acc)}
    .S2list-date{font-size:10px;color:var(--c-tx3)}

    /* ══ STEP 3 ══ */
    #S3{display:flex;flex-direction:column;width:100%;height:100%}
    #S3top{display:flex;padding:14px;gap:14px;border-bottom:1px solid var(--c-bdr);background:var(--c-s1);flex-shrink:0}
    .S3panel{width:420px}
    #S3 select{display:block;width:100%;padding:6px 8px;font-size:12px;font-family:var(--fm);background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;box-sizing:border-box}
    .S3qgrid{display:flex;gap:10px}
    .S3qbox{flex:1;background:var(--c-s2);border:1px solid var(--c-bdr);border-radius:var(--r);padding:10px;text-align:center}
    .S3qnum{font-size:22px;font-weight:800;font-family:var(--fm)}
    .S3qlbl{font-size:10px;color:var(--c-tx3);text-transform:uppercase;letter-spacing:.5px}
    .S3green{color:var(--c-grn)}.S3yellow{color:var(--c-yel)}
    .S3cost-line{font-size:12px;color:var(--c-tx2);font-family:var(--fm)}
    .S3cost-line strong{color:var(--c-yel)}

    #S3bottom{flex:1;display:flex;flex-direction:column;overflow:hidden}
    #s3TableBar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--c-s1);border-bottom:1px solid var(--c-bdr)}
    #s3TableWrap{flex:1;overflow:auto}
    #s3Table{width:100%;border-collapse:collapse;font-size:12px}
    #s3Table thead{position:sticky;top:0;z-index:1;background:var(--c-s2)}
    #s3Table th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--c-tx3);border-bottom:1px solid var(--c-bdr)}
    #s3Table td{padding:6px 10px;border-bottom:1px solid var(--c-bdr);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
    #s3Table tbody tr:hover{background:var(--c-s2)}
    #s3Table a{color:var(--c-acc);text-decoration:none}
    #s3Table a:hover{text-decoration:underline}
    .hunter-btn{font-size:10px;padding:3px 8px;border-radius:6px;border:1px solid var(--c-bdr);background:var(--c-s2);color:var(--c-org);cursor:pointer;font-family:var(--fm);font-weight:600}
    .hunter-btn:hover{background:var(--c-org);color:#fff;border-color:var(--c-org)}
    .hunter-found{color:var(--c-grn);font-size:10px;font-family:var(--fm)}

    /* ══ STEP 4 — GENERATE LEAD LISTS ══ */
    #S4LeadLists{padding:20px;overflow-y:auto;height:100%}
    .S4lead-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap}
    .S4lead-grid{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);gap:16px;align-items:start}
    .S4lead-sidebar,.S4lead-main{background:var(--c-s1);border:1px solid var(--c-bdr);border-radius:var(--r2);padding:16px}
    .S4lead-sidebar input,.S4lead-sidebar select{display:block;width:100%;margin-top:4px;padding:8px 10px;font-size:13px;font-family:var(--fm);background:var(--c-s2);color:var(--c-tx);border:1px solid var(--c-bdr);border-radius:6px;outline:none;box-sizing:border-box}
    .S4lead-sidebar input:focus,.S4lead-sidebar select:focus{border-color:var(--c-acc)}
    .S4lead-summary{margin-top:12px;padding:14px;border-radius:12px;background:var(--c-s2);border:1px solid var(--c-bdr)}
    .S4lead-empty{font-size:12px;line-height:1.5;color:var(--c-tx3)}
    .S4lead-main-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
    .S4lead-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
    .S4lead-card{background:var(--c-s2);border:1px solid var(--c-bdr);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px}
    .S4lead-card.active{border-color:var(--c-acc);box-shadow:0 0 0 1px rgba(217,48,37,.18)}
    .S4lead-card-title{font-size:15px;font-weight:700;color:var(--c-tx)}
    .S4lead-card-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .S4lead-card-meta-item{padding:8px 10px;border-radius:10px;background:#fff;border:1px solid var(--c-bdr)}
    .S4lead-card-meta-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--c-tx3);font-weight:700}
    .S4lead-card-meta-value{margin-top:4px;font-size:13px;font-family:var(--fm);color:var(--c-tx)}
    .S4lead-card-actions{display:flex;gap:8px;flex-wrap:wrap}
    .S4lead-card-actions .Fbtn{flex:1}
    .S4lead-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .S4lead-summary-item{padding:10px 12px;border-radius:10px;background:#fff;border:1px solid var(--c-bdr)}
    .S4lead-summary-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--c-tx3);font-weight:700}
    .S4lead-summary-value{margin-top:4px;font-size:14px;font-family:var(--fm);color:var(--c-tx)}
    .S4lead-summary-note{margin-top:12px;font-size:12px;line-height:1.5;color:var(--c-tx2)}

    /* ══ STEP 5 — COSTS ══ */
    #S5{padding:20px;max-width:900px;overflow-y:auto;height:100%}
    #S4header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
    #S4grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
    .S4card{background:var(--c-s2);border:1px solid var(--c-bdr);border-radius:var(--r2);padding:16px;text-align:center}
    .S4card.S4total{background:linear-gradient(135deg,#fef2f2,#fee2e2);border-color:#fca5a5}
    .S4card-label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--c-tx3);font-weight:700;margin-bottom:6px}
    .S4total .S4card-label{color:#b91c1c}
    .S4card-val{font-size:26px;font-weight:800;font-family:var(--fm);color:var(--c-tx)}
    .S4total .S4card-val{color:#991b1b}
    .S4card-sub{font-size:11px;color:var(--c-tx3);font-family:var(--fm);margin-top:4px}
    .S4total .S4card-sub{color:#ef4444}
    #S4daily{background:var(--c-s1);border:1px solid var(--c-bdr);border-radius:var(--r2);padding:16px}
    #S4dailyTable-wrap{max-height:300px;overflow-y:auto}
    #S4dailyTable{width:100%;border-collapse:collapse;font-size:12px}
    #S4dailyTable thead{position:sticky;top:0;background:var(--c-s2)}
    #S4dailyTable th{padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--c-tx3);border-bottom:1px solid var(--c-bdr)}
    #S4dailyTable td{padding:6px 12px;border-bottom:1px solid var(--c-bdr);font-family:var(--fm);font-size:12px}

    @media (max-width: 880px){
      .S4lead-grid{grid-template-columns:1fr}
    }

    ::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--c-bdr);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:var(--c-bdr2)}
    `;
    document.head.appendChild(s);
  }

  // ─── Tile math ─────────────────────────────────────────────────────────────
  function computeGrid(){
    const sKm=config.tile_side_miles*MI2KM;
    const ext=parseInt(document.getElementById("s1Extent")?.value||"5",10);
    dLat=sKm/KM_PER_DEG_LAT;
    const anchorLat = gridAnchorLat();
    dLng=sKm/(KM_PER_DEG_LAT*Math.max(Math.cos(anchorLat*Math.PI/180), 0.2));
    gridRows=ext*2+1; gridCols=ext*2+1;

    // Match the legacy fetcher exactly so historical tile keys line up.
    const centerGridRow = Math.round(config.center_lat / dLat);
    const centerGridCol = Math.round(config.center_lng / dLng);
    originLat = (centerGridRow - ext) * dLat;
    originLng = (centerGridCol - ext) * dLng;
  }
  function tk(r,c){
    const absRow = Math.round(originLat / dLat) + r;
    const absCol = Math.round(originLng / dLng) + c;
    return `${absRow}_${absCol}`;
  }
  function tBounds(r,c){const s=originLat+r*dLat,n=s+dLat,w=originLng+c*dLng,e=w+dLng;return{south:s,north:n,west:w,east:e}}
  function tCenter(r,c){const b=tBounds(r,c);return{lat:(b.south+b.north)/2,lng:(b.west+b.east)/2}}
  function tRadius(){return(config.tile_side_miles*MI2KM*Math.SQRT2/2)*1000}

  // ─── Step 1: Map ───────────────────────────────────────────────────────────
  function initMap(){
    clearTimeout(gmapsLoadTimer);
    clearMapStatus();
    map=new google.maps.Map(document.getElementById("Fmap"),{
      center:{lat:config.center_lat,lng:config.center_lng},zoom:config.zoom,mapTypeId:"roadmap",
      draggable:false,
      gestureHandling:'none', // We handle all gestures
      disableDoubleClickZoom:true,
      keyboardShortcuts:false,
      styles:[
        {featureType:"poi",elementType:"labels",stylers:[{visibility:"off"}]},
        {featureType:"transit",stylers:[{visibility:"off"}]},
      ]
    });

    mapOverlay = new google.maps.OverlayView();
    mapOverlay.onAdd = function(){};
    mapOverlay.draw = function(){};
    mapOverlay.onRemove = function(){};
    mapOverlay.setMap(map);

    // Populate center inputs
    document.getElementById("s1CenterLat").value=config.center_lat.toFixed(4);
    document.getElementById("s1CenterLng").value=config.center_lng.toFixed(4);

    // Try to geolocate if still on default center
    if(Math.abs(config.center_lat-47.6062)<0.01 && Math.abs(config.center_lng-(-122.3321))<0.01){
      if(navigator.geolocation){
        navigator.geolocation.getCurrentPosition(pos=>{
          config.center_lat=pos.coords.latitude;
          config.center_lng=pos.coords.longitude;
          map.setCenter({lat:config.center_lat,lng:config.center_lng});
          if(window._centerMarker) window._centerMarker.setPosition({lat:config.center_lat,lng:config.center_lng});
          document.getElementById("s1CenterLat").value=config.center_lat.toFixed(4);
          document.getElementById("s1CenterLng").value=config.center_lng.toFixed(4);
          api("save_config",config);
        },()=>{},{ timeout:5000 });
      }
    }

    // ── Draggable grid center marker ──
    const centerMarker = new google.maps.Marker({
      position: {lat: config.center_lat, lng: config.center_lng},
      map: map,
      draggable: true,
      title: "Grid Center — drag to move",
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: "#d93025",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 3,
      },
      zIndex: 10,
    });

    centerMarker.addListener("dragend", () => {
      const pos = centerMarker.getPosition();
      config.center_lat = pos.lat();
      config.center_lng = pos.lng();
      document.getElementById("s1CenterLat").value = pos.lat().toFixed(4);
      document.getElementById("s1CenterLng").value = pos.lng().toFixed(4);
      api("save_config", config);
    });

    // Expose so we can update it from the inputs
    window._centerMarker = centerMarker;
    const mapDiv=document.getElementById("Fmap");
    const selectBox=document.getElementById("f-select-box");
    let isDragging=false, isPanning=false;
    let dragStartX=0, dragStartY=0;
    let panStartCenter=null;

    mapDiv.addEventListener("contextmenu",e=>e.preventDefault());

    // Scroll to zoom one step at a time. We intentionally avoid queued wheel
    // momentum here because it caused free-spin mice to overshoot and drift.
    mapDiv.addEventListener("wheel",e=>{
      e.preventDefault();
      if(wheelZoomCooldown) return;

      const direction = e.deltaY < 0 ? 1 : -1;
      const z = map.getZoom();
      const newZ = Math.max(4, Math.min(18, z + direction));
      if(newZ === z) return;

      const rect = mapDiv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const bounds = map.getBounds();
      if(!suppressCursorZoomOnce && bounds && rect.width && rect.height){
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const cursorLat = ne.lat() - (my / rect.height) * (ne.lat() - sw.lat());
        const cursorLng = sw.lng() + (mx / rect.width) * (ne.lng() - sw.lng());
        const center = map.getCenter();
        const factor = direction > 0 ? 0.5 : 2;
        const newLat = cursorLat + (center.lat() - cursorLat) * factor;
        const newLng = cursorLng + (center.lng() - cursorLng) * factor;
        map.setZoom(newZ);
        map.setCenter({ lat:newLat, lng:newLng });
      } else {
        map.setZoom(newZ);
      }
      suppressCursorZoomOnce = false;

      wheelZoomCooldown = setTimeout(()=>{
        wheelZoomCooldown = null;
      }, 110);
    },{passive:false});

    // Double-click to zoom in
    mapDiv.addEventListener("dblclick",e=>{
      e.preventDefault();
      map.setZoom(map.getZoom()+1);
    });

    mapDiv.addEventListener("mousedown",e=>{
      if(e.button===0){ // Left click: box select (unless on center marker)
        // Check if click is near center marker — let marker handle its own drag
        if(window._centerMarker){
          const proj=map.getProjection();
          const bounds=map.getBounds();
          if(proj&&bounds){
            const mPos=window._centerMarker.getPosition();
            const rect=mapDiv.getBoundingClientRect();
            const ne=bounds.getNorthEast(),sw=bounds.getSouthWest();
            const mx=((mPos.lng()-sw.lng())/(ne.lng()-sw.lng()))*rect.width;
            const my=((ne.lat()-mPos.lat())/(ne.lat()-sw.lat()))*rect.height;
            const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
            if(Math.abs(cx-mx)<20 && Math.abs(cy-my)<20) return; // let marker handle it
          }
        }
        isDragging=true;
        dragStartX=e.clientX;
        dragStartY=e.clientY;
        const rect=mapDiv.getBoundingClientRect();
        selectBox.style.left=(e.clientX-rect.left)+"px";
        selectBox.style.top=(e.clientY-rect.top)+"px";
        selectBox.style.width="0px";
        selectBox.style.height="0px";
        selectBox.style.display="block";
        e.preventDefault();
      } else if(e.button===1){ // Middle click: pan
        isPanning=true;
        dragStartX=e.clientX;
        dragStartY=e.clientY;
        panStartCenter=map.getCenter();
        mapDiv.style.cursor="grabbing";
        e.preventDefault();
      }
    });

    window.addEventListener("mousemove",e=>{
      if(isDragging){
        const rect=mapDiv.getBoundingClientRect();
        const curX=e.clientX, curY=e.clientY;
        const x=Math.min(dragStartX,curX)-rect.left;
        const y=Math.min(dragStartY,curY)-rect.top;
        const w=Math.abs(curX-dragStartX);
        const h=Math.abs(curY-dragStartY);
        selectBox.style.left=x+"px";
        selectBox.style.top=y+"px";
        selectBox.style.width=w+"px";
        selectBox.style.height=h+"px";
      }
      if(isPanning && panStartCenter){
        const dx=e.clientX-dragStartX;
        const dy=e.clientY-dragStartY;
        // Use the map's projection for accurate pixel-to-latlng
        const zoom=map.getZoom();
        const scale=Math.pow(2,zoom);
        // At zoom 0, the whole world (360°) fits in 256 px
        const degreesPerPixelLng=360/(256*scale);
        const degreesPerPixelLat=360/(256*scale)*Math.cos(panStartCenter.lat()*Math.PI/180);
        // Dragging right = moving map left = decreasing lng; dragging down = moving map up = increasing lat
        map.setCenter({
          lat: panStartCenter.lat() + dy * degreesPerPixelLat,
          lng: panStartCenter.lng() - dx * degreesPerPixelLng
        });
      }
    });

    window.addEventListener("mouseup",e=>{
      if(isDragging && e.button===0){
        isDragging=false;
        selectBox.style.display="none";
        const rect=mapDiv.getBoundingClientRect();
        const x1=Math.min(dragStartX,e.clientX)-rect.left;
        const y1=Math.min(dragStartY,e.clientY)-rect.top;
        const x2=Math.max(dragStartX,e.clientX)-rect.left;
        const y2=Math.max(dragStartY,e.clientY)-rect.top;
        if(Math.abs(x2-x1)<5 && Math.abs(y2-y1)<5) return;
        const nw = screenPointToLatLng(x1, y1);
        const se = screenPointToLatLng(x2, y2);
        if(!nw || !se) return;
        const selSouth=Math.min(nw.lat(), se.lat());
        const selNorth=Math.max(nw.lat(), se.lat());
        const selWest=Math.min(nw.lng(), se.lng());
        const selEast=Math.max(nw.lng(), se.lng());
        selectTilesInBounds(selSouth,selNorth,selWest,selEast);
      }
      if(isPanning && e.button===1){
        isPanning=false;
        panStartCenter=null;
        suppressCursorZoomOnce = true;
        mapDiv.style.cursor="";
      }
    });
  }

  /** Select all tiles (grid + legacy) whose bounds intersect the given lat/lng box */
  function selectTilesInBounds(south,north,west,east){
    // Grid tiles
    for(let r=0;r<gridRows;r++) for(let c=0;c<gridCols;c++){
      const b=tBounds(r,c);
      if(b.south<=north && b.north>=south && b.west<=east && b.east>=west){
        const key=tk(r,c);
        if(!selectedTiles[key]){
          selectedTiles[key]={row:r,col:c,legacy:false};
          styleTile(key,true);
        }
      }
    }
    // Legacy tiles
    for(const [statusKey, info] of Object.entries(tileStatus)){
      if(!legacyTileRects[statusKey]) continue; // only visible legacy tiles
      const b=info.bounds;
      if(!b) continue;
      if(b.south<=north && b.north>=south && b.west<=east && b.east>=west){
        const selKey="legacy_"+statusKey;
        if(!selectedTiles[selKey]){
          selectedTiles[selKey]={legacy:true,statusKey};
          styleLegacyTile(statusKey,true);
        }
      }
    }
    updateS1UI();
  }

  function clearGrid(){
    Object.values(tileRects).forEach(r=>r.setMap(null));
    Object.values(tileCircles).forEach(c=>c.setMap(null));
    Object.values(legacyTileRects).forEach(r=>r.setMap(null));
    tileRects={}; tileCircles={}; selectedTiles={}; legacyTileRects={};
  }

  /** Map from global tile key -> {row, col} for current grid */
  let gridKeyToLocal = {};
  let gridToTileKey = {};

  function drawGrid(){
    clearGrid(); computeGrid();
    gridToTileKey = {};
    gridKeyToLocal = {};
    const cr=tRadius();

    // Precompute all grid keys
    for(let r=0;r<gridRows;r++) for(let c=0;c<gridCols;c++){
      gridKeyToLocal[tk(r,c)] = { row:r, col:c };
    }

    // Classify all saved tiles
    const currentGridMatches = {}; // gridKey -> tileStatusKey
    const legacyTiles = [];       // tileStatus entries that don't match

    for(const [statusKey, info] of Object.entries(tileStatus)){
      const sameSize = info.tile_side_miles && Math.abs(info.tile_side_miles - config.tile_side_miles) < 0.001;
      const matchedKey = sameSize && gridKeyToLocal[statusKey] ? statusKey : "";
      if(matchedKey){
        currentGridMatches[matchedKey] = statusKey;
      } else {
        legacyTiles.push({ key: statusKey, ...info });
      }
    }

    // Draw grid cells
    for(let r=0;r<gridRows;r++) for(let c=0;c<gridCols;c++){
      const key=tk(r,c), b=tBounds(r,c), cen=tCenter(r,c);
      const rect=new google.maps.Rectangle({
        bounds:{south:b.south,north:b.north,west:b.west,east:b.east},map,
        strokeColor:"#d93025",strokeOpacity:.5,strokeWeight:1,
        fillColor:"#fee2e2",fillOpacity:.15,clickable:true,zIndex:1
      });
      rect.addListener("click",()=>toggleTile(key,r,c));
      tileRects[key]=rect;

      tileCircles[key]=new google.maps.Circle({
        center:{lat:cen.lat,lng:cen.lng},radius:cr,map,
        strokeColor:"#d93025",strokeOpacity:.12,strokeWeight:1,fillOpacity:0,clickable:false,zIndex:0
      });

      // If this grid cell has a matching saved tile, link it and style
      if(currentGridMatches[key]){
        gridToTileKey[key] = currentGridMatches[key];
        styleTile(key, false);
      }
    }

    // Draw legacy tiles as clickable standalone rectangles
    legacyTiles.forEach(lt=>{
      if(!lt.bounds) return;
      const lk = lt.key; // tileStatus key
      const sat = (lt.result_count||0) >= 60;
      const rect = new google.maps.Rectangle({
        bounds: {
          south: lt.bounds.south,
          north: lt.bounds.north,
          west: lt.bounds.west,
          east: lt.bounds.east,
        },
        map,
        strokeColor: sat ? "#ea580c" : "#16a34a",
        strokeOpacity: sat ? 0.8 : 0.7,
        strokeWeight: 1,
        fillColor: sat ? "#fed7aa" : "#bbf7d0",
        fillOpacity: sat ? 0.25 : 0.2,
        clickable: true,
        zIndex: 2,
      });
      rect.addListener("click", () => toggleLegacyTile(lk));
      legacyTileRects[lk] = rect;
    });

    map.fitBounds(new google.maps.LatLngBounds(
      {lat:originLat,lng:originLng},
      {lat:originLat+gridRows*dLat,lng:originLng+gridCols*dLng}
    ));
    updateS1UI();
  }

  function toggleTile(key,r,c){
    if(pulling)return;
    if(selectedTiles[key]){delete selectedTiles[key];styleTile(key,false)}
    else{selectedTiles[key]={row:r,col:c,legacy:false};styleTile(key,true)}
    updateS1UI();
  }

  function toggleLegacyTile(statusKey){
    if(pulling)return;
    const selKey="legacy_"+statusKey;
    if(selectedTiles[selKey]){
      delete selectedTiles[selKey];
      styleLegacyTile(statusKey,false);
    } else {
      selectedTiles[selKey]={legacy:true,statusKey:statusKey};
      styleLegacyTile(statusKey,true);
    }
    updateS1UI();
  }

  function styleTile(key,sel){
    const rect=tileRects[key]; if(!rect)return;
    const statusKey = gridToTileKey[key];
    const pulled = statusKey ? tileStatus[statusKey] : null;
    const saturated=pulled&&(pulled.result_count||0)>=60;
    if(sel) rect.setOptions({strokeColor:"#ca8a04",strokeOpacity:.9,strokeWeight:2,fillColor:"#fef08a",fillOpacity:.35});
    else if(saturated) rect.setOptions({strokeColor:"#ea580c",strokeOpacity:.8,strokeWeight:2,fillColor:"#fed7aa",fillOpacity:.30});
    else if(pulled) rect.setOptions({strokeColor:"#16a34a",strokeOpacity:.8,strokeWeight:1,fillColor:"#bbf7d0",fillOpacity:.30});
    else rect.setOptions({strokeColor:"#d93025",strokeOpacity:.5,strokeWeight:1,fillColor:"#fee2e2",fillOpacity:.15});
  }

  function styleLegacyTile(statusKey,sel){
    const rect=legacyTileRects[statusKey]; if(!rect)return;
    const info=tileStatus[statusKey];
    const sat=info&&(info.result_count||0)>=60;
    if(sel) rect.setOptions({strokeColor:"#ca8a04",strokeOpacity:.9,strokeWeight:2,fillColor:"#fef08a",fillOpacity:.35});
    else if(sat) rect.setOptions({strokeColor:"#ea580c",strokeOpacity:.8,strokeWeight:1,fillColor:"#fed7aa",fillOpacity:.25});
    else rect.setOptions({strokeColor:"#16a34a",strokeOpacity:.7,strokeWeight:1,fillColor:"#bbf7d0",fillOpacity:.2});
  }

  function updateS1UI(){
    const n=Object.keys(selectedTiles).length;
    const deleteBtn=document.getElementById("s1DeleteSelected");
    document.getElementById("s1SelCount").textContent=n;
    // Each tile = 1-3 search calls depending on density
    const minCalls=n*1, maxCalls=n*3;
    const minCost=minCalls*PRICE_NEARBY, maxCost=maxCalls*PRICE_NEARBY;
    document.getElementById("s1Cost").textContent="$"+minCost.toFixed(2)+" – $"+maxCost.toFixed(2);
    document.getElementById("s1Calls").textContent=minCalls+"–"+maxCalls;
    document.getElementById("s1Pull").disabled=n===0||pulling;

    // Check if any selected tiles are saturated
    let satCount=0;
    let deletableCount=0;
    for(const [selKey, selInfo] of Object.entries(selectedTiles)){
      const tileKey = selInfo.legacy ? selInfo.statusKey : selKey;
      if(tileKey && tileStatus[tileKey]) deletableCount++;
      if(selInfo.legacy){
        const ts=tileStatus[selInfo.statusKey];
        if(ts&&(ts.result_count||0)>=60) satCount++;
      } else {
        const statusKey=gridToTileKey[selKey];
        const ts=statusKey?tileStatus[statusKey]:null;
        if(ts&&(ts.result_count||0)>=60) satCount++;
      }
    }
    const subBtn=document.getElementById("s1Subdivide");
    if(satCount>0){
      subBtn.classList.remove("Fhide");
      subBtn.textContent=`Subdivide & Re-Pull ${satCount} Saturated Tile${satCount>1?"s":""}`;
      subBtn.disabled=pulling;
    } else {
      subBtn.classList.add("Fhide");
    }
    if(deleteBtn){
      deleteBtn.classList.toggle("Fhide", deletableCount===0);
      deleteBtn.disabled = pulling || deletableCount===0;
      deleteBtn.textContent = deletableCount>0
        ? `Delete Selected Native Tiles (${deletableCount})`
        : "Delete Selected Native Tiles";
    }
  }

  function closeDeleteModal(){
    document.getElementById("territoryDeleteModal")?.classList.add("Fhide");
  }

  function openDeleteModal(tileKeys){
    const modal=document.getElementById("territoryDeleteModal");
    const body=document.getElementById("territoryDeleteModalBody");
    if(!modal || !body) return;
    body.innerHTML = `This will remove <strong>${tileKeys.length}</strong> selected native tile${tileKeys.length===1?"":"s"} from the new Territory store only. Historical legacy tiles will not be touched.`;
    modal.classList.remove("Fhide");
  }

  async function deleteSelectedNativeTiles(){
    const entries=Object.entries(selectedTiles); if(!entries.length)return;
    const tileKeys=[...new Set(entries.map(([selKey, selInfo]) => selInfo.legacy ? selInfo.statusKey : selKey).filter(key => !!key && !!tileStatus[key]))];
    if(!tileKeys.length) return;
    openDeleteModal(tileKeys);
    const confirmed = await new Promise(resolve => {
      const confirmBtn=document.getElementById("territoryDeleteConfirm");
      const cancelBtn=document.getElementById("territoryDeleteCancel");
      const modal=document.getElementById("territoryDeleteModal");
      const cleanup = () => {
        confirmBtn?.removeEventListener("click", onConfirm);
        cancelBtn?.removeEventListener("click", onCancel);
        modal?.removeEventListener("click", onBackdrop);
      };
      const onConfirm = () => { cleanup(); closeDeleteModal(); resolve(true); };
      const onCancel = () => { cleanup(); closeDeleteModal(); resolve(false); };
      const onBackdrop = (e) => {
        if(e.target === modal){
          cleanup();
          closeDeleteModal();
          resolve(false);
        }
      };
      confirmBtn?.addEventListener("click", onConfirm);
      cancelBtn?.addEventListener("click", onCancel);
      modal?.addEventListener("click", onBackdrop);
    });
    if(!confirmed) return;
    pulling=true;
    updateS1UI();
    document.getElementById("s1Progress").classList.remove("Fhide");
    let done=0;
    for(const tileKey of tileKeys){
      document.getElementById("s1Ptxt").textContent=`Deleting ${done+1}/${tileKeys.length}: ${tileKey}…`;
      document.getElementById("s1Pfill").style.width=((done/tileKeys.length)*100)+"%";
      try{
        await api("delete_tile",{tile_key:tileKey});
        delete tileStatus[tileKey];
      }catch(e){console.error(e)}
      done++;
    }
      document.getElementById("s1Pfill").style.width="100%";
      document.getElementById("s1Ptxt").textContent=`Deleted ${tileKeys.length} native tile${tileKeys.length===1?"":"s"}.`;
      selectedTiles={};
      invalidateRawBusinessCache();
      pulling=false;
      drawGrid();
      updateBadge();
    updateS1UI();
    setTimeout(()=>document.getElementById("s1Progress").classList.add("Fhide"),2500);
  }

  async function pullS1(){
    const entries=Object.entries(selectedTiles); if(!entries.length)return;
    pulling=true; document.getElementById("s1Pull").disabled=true;
    document.getElementById("s1Progress").classList.remove("Fhide");
    let done=0; const tot=entries.length; const cr=tRadius();
    for(const [selKey, selInfo] of entries){
      if(selInfo.legacy) { done++; continue; } // legacy tiles already pulled, skip
      const{row,col}=selInfo; const cen=tCenter(row,col);
      document.getElementById("s1Ptxt").textContent=`Pulling ${done+1}/${tot}: ${selKey}…`;
      document.getElementById("s1Pfill").style.width=((done/tot)*100)+"%";
        try{
          const res=await api("pull_tile",{tile_key:selKey,center_lat:cen.lat,center_lng:cen.lng,radius_meters:cr,search_type:config.search_type});
          if(res.status==="ok"&&res.result){
            if(res.result.error){
              document.getElementById("s1Ptxt").textContent=`Tile ${selKey}: ${res.result.error}`;
              console.error(res.result.error);
              alert(res.result.error);
              done++;
              continue;
            }
            tileStatus[selKey]=res.result;
            gridToTileKey[selKey]=selKey;
            styleTile(selKey,false);delete selectedTiles[selKey];
          const r=res.result;
          document.getElementById("s1Ptxt").textContent=`Tile ${selKey}: ${r.result_count} results, ${r.api_calls} API calls`;
        }
      }catch(e){console.error(e)}
      done++;
    }
      document.getElementById("s1Pfill").style.width="100%";
      document.getElementById("s1Ptxt").textContent=`Done! ${done} tiles pulled.`;
      invalidateRawBusinessCache();
      pulling=false; updateS1UI(); updateBadge();
    // Mark step 1 as done
    document.querySelector('.Fstep[data-step="1"]').classList.add("done");
    setTimeout(()=>document.getElementById("s1Progress").classList.add("Fhide"),3000);
  }

  /** Subdivide saturated tiles into 4 quadrants and re-pull */
  async function subdivideSaturated(){
    // Collect selected tiles that are saturated — both grid and legacy
    const toSubdivide=[];
    for(const [selKey, selInfo] of Object.entries(selectedTiles)){
      let statusKey, tsBounds, tsInfo;
      if(selInfo.legacy){
        statusKey=selInfo.statusKey;
        tsInfo=tileStatus[statusKey];
        tsBounds=tsInfo?.bounds;
      } else {
        statusKey=gridToTileKey[selKey];
        tsInfo=statusKey?tileStatus[statusKey]:null;
        if(tsInfo?.bounds) tsBounds=tsInfo.bounds;
        else if(selInfo.row!=null) {
          const b=tBounds(selInfo.row,selInfo.col);
          tsBounds=b;
        }
      }
      if(tsInfo&&(tsInfo.result_count||0)>=60&&tsBounds){
        toSubdivide.push({
          selKey,
          statusKey: statusKey||selKey,
          bounds: tsBounds,
          sideMiles: tsInfo.tile_side_miles||config.tile_side_miles,
          isLegacy: !!selInfo.legacy,
          gridRow: selInfo.row,
          gridCol: selInfo.col,
        });
      }
    }
    if(!toSubdivide.length) return;

    pulling=true;
    document.getElementById("s1Pull").disabled=true;
    document.getElementById("s1Subdivide").disabled=true;
    document.getElementById("s1Progress").classList.remove("Fhide");

    let done=0;
    const totalSubs=toSubdivide.length*4;

    for(const tile of toSubdivide){
      const b=tile.bounds;
      const halfSideMiles=tile.sideMiles/2;
      const halfSideKm=halfSideMiles*MI2KM;
      const subRadius=(halfSideKm*Math.SQRT2/2)*1000;
      const midLat=(b.south+b.north)/2;
      const midLng=(b.west+b.east)/2;

      const quads=[
        {lat:(b.south+midLat)/2, lng:(b.west+midLng)/2,  sfx:"_sw", bounds:{south:b.south,north:midLat,west:b.west,east:midLng}},
        {lat:(b.south+midLat)/2, lng:(midLng+b.east)/2,  sfx:"_se", bounds:{south:b.south,north:midLat,west:midLng,east:b.east}},
        {lat:(midLat+b.north)/2, lng:(b.west+midLng)/2,  sfx:"_nw", bounds:{south:midLat,north:b.north,west:b.west,east:midLng}},
        {lat:(midLat+b.north)/2, lng:(midLng+b.east)/2,  sfx:"_ne", bounds:{south:midLat,north:b.north,west:midLng,east:b.east}},
      ];

      for(const q of quads){
        const subKey=tile.statusKey+q.sfx;
        document.getElementById("s1Ptxt").textContent=`Subdividing ${tile.statusKey}: pulling ${q.sfx.slice(1).toUpperCase()} (${done+1}/${totalSubs})…`;
        document.getElementById("s1Pfill").style.width=((done/totalSubs)*100)+"%";

        try{
            const res=await api("pull_tile",{
              tile_key:subKey,
              center_lat:q.lat,
              center_lng:q.lng,
              radius_meters:subRadius,
              search_type:config.search_type,
              tile_side_miles:halfSideMiles
            });
            if(res.status==="ok"&&res.result){
              if(res.result.error){
                document.getElementById("s1Ptxt").textContent=`Sub-tile ${subKey}: ${res.result.error}`;
                console.error(res.result.error);
                alert(res.result.error);
                continue;
              }
              tileStatus[subKey]=res.result;
              const subSat=(res.result.result_count||0)>=60;
              const subRect=new google.maps.Rectangle({
              bounds:q.bounds, map,
              strokeColor:subSat?"#ea580c":"#16a34a",
              strokeOpacity:subSat?.8:.8,
              strokeWeight:1,
              fillColor:subSat?"#fed7aa":"#bbf7d0",
              fillOpacity:subSat?.3:.3,
              clickable:true, zIndex:2
            });
            subRect.addListener("click",()=>toggleLegacyTile(subKey));
            legacyTileRects[subKey]=subRect;
            document.getElementById("s1Ptxt").textContent=`${subKey}: ${res.result.result_count} results, ${res.result.api_calls} calls`;
          }
        }catch(e){console.error(e)}
        done++;
      }

      // Delete the original saturated tile from server
      try{await api("delete_tile",{tile_key:tile.statusKey})}catch(e){}
      // Remove from local state
      delete tileStatus[tile.statusKey];
      delete selectedTiles[tile.selKey];
      // Clean up visuals
      if(tile.isLegacy){
        if(legacyTileRects[tile.statusKey]){
          legacyTileRects[tile.statusKey].setMap(null);
          delete legacyTileRects[tile.statusKey];
        }
      } else {
        delete gridToTileKey[tile.selKey];
        styleTile(tile.selKey, false);
      }
    }

      document.getElementById("s1Pfill").style.width="100%";
      document.getElementById("s1Ptxt").textContent=`Done! Subdivided ${toSubdivide.length} tile${toSubdivide.length>1?"s":""} into ${totalSubs} sub-tiles.`;
      invalidateRawBusinessCache();
      pulling=false;
      updateS1UI();
      updateBadge();
    setTimeout(()=>document.getElementById("s1Progress").classList.add("Fhide"),4000);
  }

  // ─── Step 2: Filter ────────────────────────────────────────────────────────

  let s2SortField="score", s2SortDir=-1, s2Scored=[];

  /** Parse state abbreviation and zip from a vicinity/address string */
  function parseStateZip(str){
    if(!str) return {state:"",zip:""};
    // Try patterns like "City, WA 98101" or "City, Washington"
    const stateAbbrs = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
    const zipMatch = str.match(/\b(\d{5})(?:-\d{4})?\b/);
    const zip = zipMatch ? zipMatch[1] : "";
    // Look for 2-letter state abbr
    const stateMatch = str.match(/\b([A-Z]{2})\b/);
    let state = "";
    if(stateMatch && stateAbbrs.includes(stateMatch[1])) state = stateMatch[1];
    return {state, zip};
  }

  function invalidateRawBusinessCache(){
    rawBusinesses = [];
    detailIndex = {};
    derivedStates = [];
    rawBusinessesLoaded = false;
  }

  async function loadRawBusinesses(force=false){
    if(force) invalidateRawBusinessCache();
    if(rawBusinessesLoaded) return;
    const res=await api("get_raw_businesses");
    if(res.status==="ok") rawBusinesses=res.businesses||[];
    // Load detail index
    const dRes=await api("get_detail_index");
    if(dRes.status==="ok") detailIndex=dRes.index||{};
    // Derive states
    const stateSet=new Set();
    rawBusinesses.forEach(b=>{
      const vicinity=b.vicinity||"";
      const {state,zip}=parseStateZip(vicinity);
      const nameLc=(b.name||"").toLowerCase();
      const vicinityLc=vicinity.toLowerCase();
      const typesLc=(b.types||[]).map(t=>String(t).toLowerCase());
      if(state){ b._state=state; stateSet.add(state); }
      else b._state="";
      b._zip=zip;
      b._nameLc=nameLc;
      b._vicinityLc=vicinityLc;
      b._typesLc=typesLc;
      b._search=`${nameLc}\n${vicinityLc}\n${typesLc.join(",")}`;
      b._detailed = !!detailIndex[b.place_id];
    });
    derivedStates=Array.from(stateSet).sort();
    // Populate state dropdown
    const sel=document.getElementById("s2State");
    sel.innerHTML='<option value="">All states</option>';
    derivedStates.forEach(s=>{ sel.innerHTML+=`<option value="${s}">${s}</option>`; });
    if(res && res.diagnostics){
      const derivedStateCounts = rawBusinesses.reduce((acc, b) => {
        const key = b._state || '(blank)';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const sampleBlankStates = rawBusinesses.filter(b => !b._state).slice(0, 12).map(b => ({
        name: b.name || '',
        vicinity: b.vicinity || '',
        place_id: b.place_id || '',
        tile: b._tile || ''
      }));
      console.group('[Territory] Filter Businesses load diagnostics');
      console.log('backend diagnostics', res.diagnostics);
      console.log('rawBusinesses.length', rawBusinesses.length);
      console.log('derivedStates', derivedStates);
      console.log('derived state counts', derivedStateCounts);
      console.log('sample blank-state businesses', sampleBlankStates);
      console.groupEnd();
    }
    rawBusinessesLoaded = true;
  }

  function applyFilters(){
    const incRaw=document.getElementById("s2Include").value;
    const excRaw=document.getElementById("s2Exclude").value;
    const typeRaw=document.getElementById("s2Types").value;
    const incMode=document.querySelector('input[name="s2IncMode"]:checked')?.value||"any";
    const minRat=parseFloat(document.getElementById("s2MinRating").value)||0;
    const minRev=parseInt(document.getElementById("s2MinReviews").value)||0;
    const onlyOp=document.getElementById("s2Operational").checked;
    const stateFilter=document.getElementById("s2State").value;
    const zipRaw=document.getElementById("s2Zip").value;
    const detailFilter=document.getElementById("s2DetailFilter").value;
    const excludeSaved=document.getElementById("s2ExcludeSaved").checked;
    const wKey=parseInt(document.getElementById("s2wKey").value)||0;
    const wRat=parseInt(document.getElementById("s2wRat").value)||0;
    const wRev=parseInt(document.getElementById("s2wRev").value)||0;
    const wSum=wKey+wRat+wRev||1;

    const incWords=incRaw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const excWords=excRaw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const reqTypes=typeRaw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const zipCodes=zipRaw.split(",").map(s=>s.trim()).filter(Boolean);

    let maxRev=1;
    rawBusinesses.forEach(b=>{if((b.user_ratings_total||0)>maxRev)maxRev=b.user_ratings_total});

    s2Scored=[];
    rawBusinesses.forEach(b=>{
      const name=b._nameLc||"";
      const types=b._typesLc||[];
      const rating=b.rating||0;
      const reviews=b.user_ratings_total||0;
      const status=(b.business_status||"").toUpperCase();

      // Hard filters
      if(onlyOp && status && status!=="OPERATIONAL") return;
      if(minRat && rating<minRat) return;
      if(minRev && reviews<minRev) return;
      if(excludeSaved && savedListPlaceIds.has(String(b.place_id||""))) return;

      // State filter
      if(stateFilter && b._state!==stateFilter) return;

      // Zip filter
      if(zipCodes.length){
        if(!b._zip || !zipCodes.includes(b._zip)) return;
      }

      // Detail status filter
      if(detailFilter==="detailed" && !b._detailed) return;
      if(detailFilter==="not_detailed" && b._detailed) return;

      // Exclude
      for(const w of excWords) if(name.includes(w)) return;

      // Type filter
      if(reqTypes.length){
        const has=reqTypes.some(t=>types.includes(t));
        if(!has)return;
      }

      // Include keywords scoring
      let keyScore=0;
      if(incWords.length){
        const matches=incWords.filter(w=>name.includes(w));
        if(incMode==="all" && matches.length<incWords.length) return;
        if(incMode==="any" && matches.length===0) return;
        keyScore=matches.length/incWords.length;
      } else {
        keyScore=1;
      }

      // Composite score
      const ratNorm=rating/5;
      const revNorm=Math.min(reviews/maxRev,1);
      const score=((keyScore*(wKey/wSum))+(ratNorm*(wRat/wSum))+(revNorm*(wRev/wSum)))*100;

      s2Scored.push({...b,_score:Math.round(score)});
    });

    sortS2();
    renderS2Table();

    const detailedCount=s2Scored.filter(b=>b._detailed).length;
    document.getElementById("s2ResultSummary").innerHTML=
      `<strong style="color:var(--c-acc)">${s2Scored.length}</strong> match out of <strong>${rawBusinesses.length}</strong> total · <strong style="color:var(--c-grn)">${detailedCount}</strong> already detailed`;
    const excludeSavedSummary=document.getElementById("s2ExcludeSaved").checked;
    const detailedCountSummary=s2Scored.filter(b=>b._detailed).length;
    const hiddenOverlapCount=excludeSavedSummary ? (rawBusinesses.length - s2Scored.length) : 0;
    const actualSavedOverlapCount = rawBusinesses.filter(b => savedListPlaceIds.has(String(b.place_id || ""))).length;
    const actualNotOnSavedListsCount = rawBusinesses.length - actualSavedOverlapCount;
    let summaryHtml=`<strong style="color:var(--c-acc)">${s2Scored.length}</strong> match out of <strong>${rawBusinesses.length}</strong> total · <strong style="color:var(--c-grn)">${detailedCountSummary}</strong> already detailed`;
    if(excludeSavedSummary) summaryHtml+=` · <strong>${hiddenOverlapCount}</strong> overlaps hidden`;
    document.getElementById("s2ResultSummary").innerHTML=summaryHtml;
    console.group('[Territory] Filter Businesses applyFilters');
    console.log('rawBusinesses.length', rawBusinesses.length);
    console.log('s2Scored.length', s2Scored.length);
    console.log('excludeSaved', excludeSavedSummary);
    console.log('savedListPlaceIds.size', savedListPlaceIds.size);
    console.log('hiddenOverlapCount', hiddenOverlapCount);
    console.log('actualSavedOverlapCount', actualSavedOverlapCount);
    console.log('actualNotOnSavedListsCount', actualNotOnSavedListsCount);
    console.log('stateFilter', stateFilter);
    console.log('detailFilter', detailFilter);
    console.log('derivedStates', derivedStates);
    console.groupEnd();
  }

  function sortS2(){
    s2Scored.sort((a,b)=>{
      let av,bv;
      switch(s2SortField){
        case"score":av=a._score;bv=b._score;break;
        case"name":av=(a.name||"").toLowerCase();bv=(b.name||"").toLowerCase();return av<bv?-1*s2SortDir:av>bv?1*s2SortDir:0;
        case"vicinity":av=(a.vicinity||"").toLowerCase();bv=(b.vicinity||"").toLowerCase();return av<bv?-1*s2SortDir:av>bv?1*s2SortDir:0;
        case"state":av=(a._state||"").toLowerCase();bv=(b._state||"").toLowerCase();return av<bv?-1*s2SortDir:av>bv?1*s2SortDir:0;
        case"rating":av=a.rating||0;bv=b.rating||0;break;
        case"reviews":av=a.user_ratings_total||0;bv=b.user_ratings_total||0;break;
        case"photos":av=a.photo_count||0;bv=b.photo_count||0;break;
        case"price":av=a.price_level!=null?a.price_level:-1;bv=b.price_level!=null?b.price_level:-1;break;
        case"detailed":av=a._detailed?1:0;bv=b._detailed?1:0;break;
        default:return 0;
      }
      return(av-bv)*s2SortDir;
    });
  }

  function renderS2Table(){
    const tbody=document.getElementById("s2Tbody"); tbody.innerHTML="";
    const q=(document.getElementById("s2Search").value||"").toLowerCase();
    let shown=s2Scored;
    if(q) shown=shown.filter(b=>(b._search||"").includes(q));

    s2VisibleRows=shown;
    s2RenderedCount=0;
    document.getElementById("s2Count").textContent=shown.length.toLocaleString();
    shown.slice(0, S2_RENDER_BATCH).forEach(b=>{
      const tr=document.createElement("tr");
      const barW=Math.max(2,b._score);
      const openTxt=b.open_now===true?"Open":b.open_now===false?"Closed":"—";
      const openClr=b.open_now===true?"var(--c-grn)":b.open_now===false?"var(--c-red)":"var(--c-tx3)";
      const priceTxt=b.price_level!=null?"$".repeat(b.price_level||1):"—";
      const detIcon=b._detailed?'<span style="color:var(--c-grn)">✓</span>':'<span style="color:var(--c-tx3)">—</span>';
      tr.innerHTML=`
        <td><span class="score-bar" style="width:${barW}px"></span>${b._score}</td>
        <td title="${esc(b.name)}">${esc(b.name)}</td>
        <td title="${esc(b.vicinity)}">${esc(b.vicinity)}</td>
        <td style="font-family:var(--fm);font-size:11px">${esc(b._state||"")}</td>
        <td>${b.rating||""}</td>
        <td>${b.user_ratings_total||""}</td>
        <td style="font-family:var(--fm);font-size:11px;color:var(--c-tx2)">${b.photo_count||0}</td>
        <td style="font-size:11px;color:${openClr}">${openTxt}</td>
        <td style="font-size:11px;color:var(--c-yel)">${priceTxt}</td>
        <td style="font-size:10px;color:var(--c-tx3);max-width:150px;overflow:hidden;text-overflow:ellipsis">${(b.types||[]).join(", ")}</td>
        <td>${b.business_status||""}</td>
        <td style="text-align:center">${detIcon}</td>
        <td style="font-size:10px;color:var(--c-tx3)">${b._tile||""}</td>`;
      tbody.appendChild(tr);
    });
    s2RenderedCount=Math.min(s2VisibleRows.length, S2_RENDER_BATCH);
  }

  function renderMoreS2Rows(){
    if(s2RenderedCount >= s2VisibleRows.length) return;
    const tbody=document.getElementById("s2Tbody");
    const batch=s2VisibleRows.slice(s2RenderedCount, s2RenderedCount + S2_RENDER_BATCH);
    const frag=document.createDocumentFragment();
    batch.forEach(b=>{
      const tr=document.createElement("tr");
      const barW=Math.max(2,b._score);
      const openTxt=b.open_now===true?"Open":b.open_now===false?"Closed":"â€”";
      const openClr=b.open_now===true?"var(--c-grn)":b.open_now===false?"var(--c-red)":"var(--c-tx3)";
      const priceTxt=b.price_level!=null?"$".repeat(b.price_level||1):"â€”";
      const detIcon=b._detailed?'<span style="color:var(--c-grn)">âœ“</span>':'<span style="color:var(--c-tx3)">â€”</span>';
      tr.innerHTML=`
        <td><span class="score-bar" style="width:${barW}px"></span>${b._score}</td>
        <td title="${esc(b.name)}">${esc(b.name)}</td>
        <td title="${esc(b.vicinity)}">${esc(b.vicinity)}</td>
        <td style="font-family:var(--fm);font-size:11px">${esc(b._state||"")}</td>
        <td>${b.rating||""}</td>
        <td>${b.user_ratings_total||""}</td>
        <td style="font-family:var(--fm);font-size:11px;color:var(--c-tx2)">${b.photo_count||0}</td>
        <td style="font-size:11px;color:${openClr}">${openTxt}</td>
        <td style="font-size:11px;color:var(--c-yel)">${priceTxt}</td>
        <td style="font-size:10px;color:var(--c-tx3);max-width:150px;overflow:hidden;text-overflow:ellipsis">${(b.types||[]).join(", ")}</td>
        <td>${b.business_status||""}</td>
        <td style="text-align:center">${detIcon}</td>
        <td style="font-size:10px;color:var(--c-tx3)">${b._tile||""}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    s2RenderedCount+=batch.length;
  }

  async function saveFilterList(){
    const name=document.getElementById("s2ListName").value.trim();
    if(!name){alert("Enter a list name");return}
    const ids=s2Scored.map(b=>b.place_id);
    const filterCfg={
      include:document.getElementById("s2Include").value,
      exclude:document.getElementById("s2Exclude").value,
      types:document.getElementById("s2Types").value,
      minRating:document.getElementById("s2MinRating").value,
      minReviews:document.getElementById("s2MinReviews").value,
      state:document.getElementById("s2State").value,
      zip:document.getElementById("s2Zip").value,
      detailFilter:document.getElementById("s2DetailFilter").value,
    };
    await api("save_filter_list",{list_name:name,filter:filterCfg,place_ids:ids});
    filterListsLoaded = false;
    await loadFilterListsFast(true);
    document.querySelector('.Fstep[data-step="2"]').classList.add("done");
    const step4Select=document.getElementById("s4LeadListSelect");
    if(step4Select){
      step4Select.value=name;
      renderLeadListGenerator(name);
    }
    alert(`Saved ${name}. Use Step 4 to generate CRM lead lists from this territory list.`);
  }

  async function loadFilterLists(){
    const res=await api("get_filter_lists");
    filterLists=res.status==="ok"?res.lists:[];
    renderFilterLists();
    // Also populate step 3 dropdown with completion info
    const sel=document.getElementById("s3ListSelect");
    sel.innerHTML='<option value="">— choose a list —</option>';

    // Fetch detail index to show completion
    const dRes=await api("get_detail_index");
    const dIndex=dRes.status==="ok"?(dRes.index||{}):{};

    for(const l of filterLists){
      // Load full list to count detailed
      const ldRes=await api("get_filter_list_detail",{list_name:l.list_name});
      const pids=(ldRes.list?.place_ids)||[];
      const doneCount=pids.filter(id=>dIndex[id]).length;
      const pct=pids.length?Math.round((doneCount/pids.length)*100):0;
      const label=`${l.list_name} (${doneCount}/${l.count} · ${pct}%)`;
      sel.innerHTML+=`<option value="${esc(l.list_name)}">${esc(label)}</option>`;
    }
  }

  async function loadFilterListsFast(force=false){
    if(filterListsLoaded && !force){
      renderFilterLists();
      populateS3ListSelect();
      populateS4LeadListSelect();
      renderLeadListGenerator();
      return;
    }
    const res=await api("get_filter_lists");
    filterLists=res.status==="ok"?(res.lists||[]):[];
    savedListPlaceIds=new Set((res.all_place_ids||[]).map(String));
    renderFilterLists();
    populateS3ListSelect();
    populateS4LeadListSelect();
    renderLeadListGenerator();
    filterListsLoaded = true;
  }

  function populateS3ListSelect(){
    const sel=document.getElementById("s3ListSelect");
    sel.innerHTML='<option value="">— choose a list —</option>';
    for(const l of filterLists){
      const doneCount=l.done_count||0;
      const pct=l.count?Math.round((doneCount/l.count)*100):0;
      const label=`${l.list_name} (${doneCount}/${l.count} · ${pct}%)`;
      sel.innerHTML+=`<option value="${esc(l.list_name)}">${esc(label)}</option>`;
    }
  }

  function renderFilterLists(){
    const c=document.getElementById("s2Lists"); c.innerHTML="";
    if(!filterLists.length){c.innerHTML='<div style="font-size:11px;color:var(--c-tx3)">No saved lists yet</div>';return}
    filterLists.forEach(l=>{
      const d=document.createElement("div"); d.className="S2list-card";
      d.innerHTML=`<div class="S2list-name">${esc(l.list_name)}</div><div class="S2list-count">${l.count}</div><div class="S2list-date">${l.created_at?new Date(l.created_at).toLocaleDateString():""}</div><button class="Fbtn-red" data-del="${esc(l.list_name)}">×</button>`;
      d.querySelector("[data-del]").onclick=async(e)=>{
        e.stopPropagation();
        await api("delete_filter_list",{list_name:l.list_name});
        filterListsLoaded = false;
        await loadFilterListsFast(true);
        applyFilters();
      };
      c.appendChild(d);
    });
  }

  function populateS4LeadListSelect(preferredName=""){
    const sel=document.getElementById("s4LeadListSelect");
    if(!sel) return;
    const current=preferredName || sel.value || "";
    sel.innerHTML='<option value="">— choose a saved territory list —</option>';
    for(const l of filterLists){
      sel.innerHTML += `<option value="${esc(l.list_name)}">${esc(l.list_name)} (${l.count})</option>`;
    }
    if(current && filterLists.some(l=>l.list_name===current)) sel.value=current;
  }

  async function loadLeadListPreview(selectedName=""){
    const listName=selectedName || document.getElementById("s4LeadListSelect")?.value || "";
    if(!listName){
      s4LeadPreview = null;
      return null;
    }
    const chunk=Math.max(1, parseInt(document.getElementById("s4LeadChunk")?.value||"250",10) || 250);
    const groupMode=document.getElementById("s4LeadGroupMode")?.value || "by_state";
    const res=await api("preview_crm_lists",{list_name:listName,chunk_size:chunk,group_mode:groupMode});
    s4LeadPreview = res && res.success ? res : null;
    return s4LeadPreview;
  }

  function renderLeadListCards(){
    const wrap=document.getElementById("s4LeadCards");
    if(!wrap) return;
    const selectedName=document.getElementById("s4LeadListSelect")?.value || "";
    const selectedPreview=(s4LeadPreview && s4LeadPreview.list_name===selectedName) ? s4LeadPreview : null;
    wrap.innerHTML="";
    if(!filterLists.length){
      wrap.innerHTML='<div class="S4lead-empty">No saved territory lists yet. Save one from Step 2 first.</div>';
      return;
    }
    filterLists.forEach(item=>{
      const doneCount=item.done_count||0;
      const chunk=Math.max(1, parseInt(document.getElementById("s4LeadChunk")?.value||"250",10) || 250);
      const preview=(selectedName===item.list_name && selectedPreview) ? selectedPreview : null;
      const estimatedLists=preview ? Number(preview.groups||[]).reduce((sum,g)=>sum+Number(g.chunk_count||0),0) : Math.max(1, Math.ceil((item.count||0)/chunk));
      const groupLabel=preview
        ? `${Number(preview.group_count||0).toLocaleString()} bucket${Number(preview.group_count||0)===1?'':'s'}`
        : (document.getElementById("s4LeadGroupMode")?.value === "ignore_state" ? "1 bucket" : "By state");
      const card=document.createElement("div");
      card.className="S4lead-card"+(selectedName===item.list_name?" active":"");
      card.innerHTML=`
        <div class="S4lead-card-title">${esc(item.list_name)}</div>
        <div class="S4lead-card-meta">
          <div class="S4lead-card-meta-item">
            <div class="S4lead-card-meta-label">Businesses</div>
            <div class="S4lead-card-meta-value">${Number(item.count||0).toLocaleString()}</div>
          </div>
          <div class="S4lead-card-meta-item">
            <div class="S4lead-card-meta-label">Detailed</div>
            <div class="S4lead-card-meta-value">${Number(doneCount).toLocaleString()}</div>
          </div>
          <div class="S4lead-card-meta-item">
            <div class="S4lead-card-meta-label">Chunk Size</div>
            <div class="S4lead-card-meta-value">${chunk.toLocaleString()}</div>
          </div>
          <div class="S4lead-card-meta-item">
            <div class="S4lead-card-meta-label">Est. CRM Lists</div>
            <div class="S4lead-card-meta-value">${estimatedLists.toLocaleString()}</div>
          </div>
          <div class="S4lead-card-meta-item">
            <div class="S4lead-card-meta-label">Grouping</div>
            <div class="S4lead-card-meta-value">${esc(groupLabel)}</div>
          </div>
        </div>
        <div class="S4lead-card-actions">
          <button class="Fbtn Fbtn-ghost" data-s4-pick="${esc(item.list_name)}">Select</button>
          <button class="Fbtn Fbtn-accent" data-s4-create="${esc(item.list_name)}">Generate</button>
        </div>`;
      wrap.appendChild(card);
    });
    wrap.querySelectorAll("[data-s4-pick]").forEach(btn=>{
      btn.onclick=async()=>{
        const name=btn.getAttribute("data-s4-pick") || "";
        const sel=document.getElementById("s4LeadListSelect");
        if(sel) sel.value=name;
        await renderLeadListGenerator(name);
      };
    });
    wrap.querySelectorAll("[data-s4-create]").forEach(btn=>{
      btn.onclick=async()=>{
        const name=btn.getAttribute("data-s4-create") || "";
        const sel=document.getElementById("s4LeadListSelect");
        if(sel) sel.value=name;
        await renderLeadListGenerator(name);
        await createCRMListsFromSelectedTerritoryList(name);
      };
    });
  }

  async function renderLeadListGenerator(selectedName=""){
    const name=selectedName || document.getElementById("s4LeadListSelect")?.value || "";
    const summary=document.getElementById("s4LeadSummary");
    if(!summary) return;
    const item=filterLists.find(l=>l.list_name===name);
    if(!item){
      s4LeadPreview = null;
      summary.innerHTML='<div class="S4lead-empty">Choose a saved territory list to see how it will be split into CRM lead lists.</div>';
      renderLeadListCards();
      return;
    }
    const chunk=Math.max(1, parseInt(document.getElementById("s4LeadChunk")?.value||"250",10) || 250);
    const doneCount=item.done_count||0;
    const groupMode=document.getElementById("s4LeadGroupMode")?.value || "by_state";
    summary.innerHTML='<div class="S4lead-empty">Loading lead-list preview…</div>';
    const preview=await loadLeadListPreview(name);
    const groups=preview?.groups || [];
    const estimatedLists=groups.reduce((sum,g)=>sum+Number(g.chunk_count||0),0);
    const groupSummaryHtml=groups.length
      ? groups.map(group=>{
          const states=(group.state_codes||[]).filter(Boolean);
          const stateLabel=groupMode==="ignore_state"
            ? (states.length ? states.join(", ") : "Unknown")
            : group.region;
          const chunkBits=(group.chunks||[]).map(chunkInfo=>`${Number(chunkInfo.lead_count||0).toLocaleString()}`).join(" · ");
          return `
            <div class="S4lead-summary-item">
              <div class="S4lead-summary-label">${esc(stateLabel)}</div>
              <div class="S4lead-summary-value">${Number(group.lead_count||0).toLocaleString()} leads</div>
              <div class="S4lead-summary-note" style="margin-top:6px">${Number(group.chunk_count||0).toLocaleString()} list(s)${chunkBits ? ` · ${esc(chunkBits)}` : ''}</div>
            </div>`;
        }).join("")
      : '<div class="S4lead-empty">No preview data available for this list.</div>';
    summary.innerHTML=`
      <div class="S4lead-card-title">${esc(item.list_name)}</div>
      <div class="S4lead-summary-grid">
        <div class="S4lead-summary-item">
          <div class="S4lead-summary-label">Businesses</div>
          <div class="S4lead-summary-value">${Number(item.count||0).toLocaleString()}</div>
        </div>
        <div class="S4lead-summary-item">
          <div class="S4lead-summary-label">Detailed</div>
          <div class="S4lead-summary-value">${Number(doneCount).toLocaleString()}</div>
        </div>
        <div class="S4lead-summary-item">
          <div class="S4lead-summary-label">Chunk Size</div>
          <div class="S4lead-summary-value">${chunk.toLocaleString()}</div>
        </div>
        <div class="S4lead-summary-item">
          <div class="S4lead-summary-label">Estimated CRM Lists</div>
          <div class="S4lead-summary-value">${Number(estimatedLists||0).toLocaleString()}</div>
        </div>
        <div class="S4lead-summary-item">
          <div class="S4lead-summary-label">State Handling</div>
          <div class="S4lead-summary-value">${groupMode==="ignore_state" ? "Ignore State Lines" : "Keep States Separate"}</div>
        </div>
      </div>
      <div class="S4lead-summary-grid">${groupSummaryHtml}</div>
      <div class="S4lead-summary-note">Step 4 creates CRM lists from this saved territory list. If you want richer phone, website, and address data on the resulting leads, fetch details in Step 3 first.</div>`;
    renderLeadListCards();
  }

  async function createCRMListsFromSelectedTerritoryList(forcedName=""){
    const listName=forcedName || document.getElementById("s4LeadListSelect")?.value || "";
    if(!listName){alert("Choose a saved territory list first");return}
    const chunk=Math.max(1, parseInt(document.getElementById("s4LeadChunk")?.value||"250",10) || 250);
    const groupMode=document.getElementById("s4LeadGroupMode")?.value || "by_state";
    const res=await api("create_crm_lists",{list_name:listName,chunk_size:chunk,group_mode:groupMode});
    if(!res.success){
      alert(res.error||"Could not create CRM lists");
      return;
    }
    document.querySelector('.Fstep[data-step="4"]')?.classList.add("done");
    const count=(res.lists||[]).length;
    alert(`Created ${count} CRM list(s) from ${listName}.`);
  }

  // ─── Step 3: Details + Hunter ──────────────────────────────────────────────

  async function loadDetailQueue(silent=false){
    const name=document.getElementById("s3ListSelect").value;
    if(!name){if(!silent)alert("Select a list first");return}
    activeList=name;
    const res=await api("get_detail_queue",{list_name:name});
    if(res.status!=="ok")return;
    document.getElementById("s3QueueInfo").classList.remove("Fhide");
    document.getElementById("s3Total").textContent=res.total;
    document.getElementById("s3Done").textContent=res.done;
    document.getElementById("s3Needed").textContent=res.needed;
    detailQueue=res.needed_ids||[];
    const cost=res.needed*PRICE_DETAIL;
    document.getElementById("s3DetailCost").textContent="$"+cost.toFixed(2)+" ("+res.needed+" calls)";
    document.getElementById("s3PullDetails").disabled=res.needed===0;

    // Auto-load already-detailed results
    if(res.done > 0){
      if(!silent){
        document.getElementById("s3Ptxt").textContent="Loading existing details…";
        document.getElementById("s3Progress").classList.remove("Fhide");
      }
      await loadDetailedResults();
      if(!silent) document.getElementById("s3Progress").classList.add("Fhide");
    } else {
      detailedPlaces=[];
      document.getElementById("s3Count").textContent="0";
      document.getElementById("s3Tbody").innerHTML="";
    }
  }

  async function pullDetails(){
    if(!detailQueue.length)return;
    pulling=true;
    document.getElementById("s3PullDetails").disabled=true;
    document.getElementById("s3Progress").classList.remove("Fhide");
    let done=0; const tot=detailQueue.length;
    // Pull one at a time for live progress
    for(const pid of detailQueue){
      document.getElementById("s3Ptxt").textContent=`Fetching ${done+1}/${tot}…`;
      document.getElementById("s3Pfill").style.width=((done/tot)*100)+"%";
      try{await api("pull_detail",{place_id:pid})}catch(e){console.error(e)}
      done++;
    }
    document.getElementById("s3Pfill").style.width="100%";
    document.getElementById("s3Ptxt").textContent=`Done! ${done} details fetched.`;
    pulling=false;
    document.querySelector('.Fstep[data-step="3"]').classList.add("done");
    // Refresh queue counts and load all results
    await loadDetailQueue(true);
    setTimeout(()=>document.getElementById("s3Progress").classList.add("Fhide"),3000);
  }

  async function loadDetailedResults(){
    const name=activeList||document.getElementById("s3ListSelect").value||null;
    const res=await api("get_detailed_places",name?{list_name:name}:{});
    if(res.status==="ok"){
      detailedPlaces=res.places||[];
      document.getElementById("s3Count").textContent=detailedPlaces.length;
      renderS3Table(detailedPlaces);
    }
  }

  function renderS3Table(places){
    const tbody=document.getElementById("s3Tbody"); tbody.innerHTML="";
    s3VisibleRows=places;
    s3RenderedCount=0;
    places.slice(0, S3_RENDER_BATCH).forEach(p=>{
      const tr=document.createElement("tr");
      const domain=p.website?extractDomain(p.website):"";
      tr.innerHTML=`
        <td title="${esc(p.name)}">${esc(p.name)}</td>
        <td title="${esc(p.formatted_address)}">${esc(p.formatted_address)}</td>
        <td>${p.formatted_phone_number?`<a href="tel:${esc(p.formatted_phone_number)}">${esc(p.formatted_phone_number)}</a>`:""}</td>
        <td>${p.website?`<a href="${esc(p.website)}" target="_blank" rel="noopener">↗ ${esc(domain)}</a>`:""}</td>
        <td>${p.rating||""}</td>
        <td>${p.user_ratings_total||""}</td>
        <td>${esc(p.business_status)}</td>
        <td class="hunter-cell" data-pid="${esc(p.place_id)}" data-domain="${esc(domain)}">${domain?`<button class="hunter-btn" onclick="window.__hunterSearch('${esc(domain)}',this)">Hunt</button>`:""}</td>`;
      tbody.appendChild(tr);
    });
    s3RenderedCount=Math.min(s3VisibleRows.length, S3_RENDER_BATCH);
  }

  function renderMoreS3Rows(){
    if(s3RenderedCount >= s3VisibleRows.length) return;
    const tbody=document.getElementById("s3Tbody");
    const batch=s3VisibleRows.slice(s3RenderedCount, s3RenderedCount + S3_RENDER_BATCH);
    const frag=document.createDocumentFragment();
    batch.forEach(p=>{
      const tr=document.createElement("tr");
      const domain=p.website?extractDomain(p.website):"";
      tr.innerHTML=`
        <td title="${esc(p.name)}">${esc(p.name)}</td>
        <td title="${esc(p.formatted_address)}">${esc(p.formatted_address)}</td>
        <td>${p.formatted_phone_number?`<a href="tel:${esc(p.formatted_phone_number)}">${esc(p.formatted_phone_number)}</a>`:""}</td>
        <td>${p.website?`<a href="${esc(p.website)}" target="_blank" rel="noopener">â†— ${esc(domain)}</a>`:""}</td>
        <td>${p.rating||""}</td>
        <td>${p.user_ratings_total||""}</td>
        <td>${esc(p.business_status)}</td>
        <td class="hunter-cell" data-pid="${esc(p.place_id)}" data-domain="${esc(domain)}">${domain?`<button class="hunter-btn" onclick="window.__hunterSearch('${esc(domain)}',this)">Hunt</button>`:""}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    s3RenderedCount+=batch.length;
  }

  function extractDomain(url){
    try{return new URL(url).hostname.replace(/^www\./,"")}catch(e){return""}
  }

  window.__hunterSearch=async function(domain,btn){
    btn.textContent="…";btn.disabled=true;
    const res=await api("domain_search",{domain});
    if(res.found&&res.emails&&res.emails.length){
      const em=res.emails[0];
      btn.outerHTML=`<span class="hunter-found">${esc(em.value)}</span>`;
    } else {
      btn.textContent="None"; btn.disabled=true; btn.style.opacity=".4";
    }
  };

  function exportCsv(){
    if(!detailedPlaces.length)return;
    const headers=["name","formatted_address","formatted_phone_number","international_phone_number","website","rating","user_ratings_total","business_status","google_maps_url"];
    let csv=headers.join(",")+"\n";
    detailedPlaces.forEach(p=>{
      csv+=headers.map(h=>`"${(p[h]||"").toString().replace(/"/g,'""')}"`).join(",")+"\n";
    });
    const blob=new Blob([csv],{type:"text/csv"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download="detailed_places.csv"; a.click();
  }

  // ─── Step 4: Costs ──────────────────────────────────────────────────────────

  async function loadCosts(){
    const res=await api("get_costs");
    if(res.status!=="ok")return;
    const c=res.costs;
    const bt=c.by_type||{};
    const ns=bt.nearby_search||{calls:0,cost:0};
    const pd=bt.place_detail||{calls:0,cost:0};
    const hd=bt.hunter_domain||{calls:0,cost:0};
    const hl=bt.hunter_lead||{calls:0,cost:0};

    document.getElementById("s4TotalCost").textContent="$"+c.total_cost.toFixed(2);
    document.getElementById("s4TotalCalls").textContent=c.total_calls+" calls";
    document.getElementById("s4NearCost").textContent="$"+ns.cost.toFixed(3);
    document.getElementById("s4NearCalls").textContent=ns.calls+" calls × $0.032";
    document.getElementById("s4DetCost").textContent="$"+pd.cost.toFixed(3);
    document.getElementById("s4DetCalls").textContent=pd.calls+" calls × $0.017";
    document.getElementById("s4HuntDomCost").textContent="$"+hd.cost.toFixed(3);
    document.getElementById("s4HuntDomCalls").textContent=hd.calls+" calls";
    document.getElementById("s4HuntLeadCost").textContent="$"+hl.cost.toFixed(3);
    document.getElementById("s4HuntLeadCalls").textContent=hl.calls+" calls";

    // Daily breakdown
    const tbody=document.getElementById("s4DailyTbody"); tbody.innerHTML="";
    const byDate=c.by_date||{};
    const dates=Object.keys(byDate).sort().reverse();
    dates.forEach(d=>{
      const row=byDate[d];
      const tr=document.createElement("tr");
      tr.innerHTML=`<td>${d}</td><td>${row.calls}</td><td style="color:var(--c-yel)">$${row.cost.toFixed(3)}</td>`;
      tbody.appendChild(tr);
    });
  }

  // ─── Events ────────────────────────────────────────────────────────────────
  function hookAll(){
    // Step nav
    document.querySelectorAll(".Fstep").forEach(btn=>{
      btn.addEventListener("click",async()=>{
        const step=parseInt(btn.dataset.step);
        currentStep=step;
        document.querySelectorAll(".Fstep").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".Fpane").forEach(p=>p.classList.remove("active"));
        document.getElementById("step"+step).classList.add("active");

        if(step===2){
          await loadRawBusinesses(true);
          await loadFilterListsFast();
          applyFilters();
        }
        if(step===3){
          await loadFilterListsFast();
        }
        if(step===4){
          await loadFilterListsFast(true);
          renderLeadListGenerator();
        }
        if(step===5){
          await loadCosts();
        }
      });
    });

    // Step 1
    document.getElementById("s1GenGrid").addEventListener("click",()=>{
      config.tile_side_miles=parseFloat(document.getElementById("s1TileSize").value)||1;
      config.search_type=document.getElementById("s1Type").value||"roofing_contractor";
      const lat=parseFloat(document.getElementById("s1CenterLat").value);
      const lng=parseFloat(document.getElementById("s1CenterLng").value);
      if(!isNaN(lat)&&!isNaN(lng)){config.center_lat=lat;config.center_lng=lng}
      if(window._centerMarker) window._centerMarker.setPosition({lat:config.center_lat,lng:config.center_lng});
      api("save_config",config);
      drawGrid();
    });
    document.getElementById("s1UseMapCenter").addEventListener("click",()=>{
      const c=map.getCenter();
      config.center_lat=c.lat();config.center_lng=c.lng();
      document.getElementById("s1CenterLat").value=c.lat().toFixed(4);
      document.getElementById("s1CenterLng").value=c.lng().toFixed(4);
      if(window._centerMarker) window._centerMarker.setPosition(c);
      api("save_config",config);
    });
    document.getElementById("s1CenterLat").addEventListener("change",()=>{
      const v=parseFloat(document.getElementById("s1CenterLat").value);
      if(!isNaN(v)){
        config.center_lat=v;
        if(window._centerMarker) window._centerMarker.setPosition({lat:config.center_lat,lng:config.center_lng});
      }
    });
    document.getElementById("s1CenterLng").addEventListener("change",()=>{
      const v=parseFloat(document.getElementById("s1CenterLng").value);
      if(!isNaN(v)){
        config.center_lng=v;
        if(window._centerMarker) window._centerMarker.setPosition({lat:config.center_lat,lng:config.center_lng});
      }
    });
    document.getElementById("territoryMigrateBtn").addEventListener("click",async()=>{
      const res=await api("migrate_legacy_data");
      if(!res.success){alert(res.error||"Could not migrate legacy territory data");return}
      const copied=res.copied||{};
      alert(`Migrated legacy territory data.\nTiles: ${copied.tiles||0}\nLists: ${copied.filters||0}\nDetails: ${copied.details||0}`);
      await loadFilterListsFast(true);
      await loadRawBusinesses();
      drawGrid();
    });
    document.getElementById("s1SelAll").addEventListener("click",()=>{
      for(let r=0;r<gridRows;r++)for(let c=0;c<gridCols;c++){
        const key=tk(r,c);
        if(!gridToTileKey[key]&&!selectedTiles[key]){selectedTiles[key]={row:r,col:c,legacy:false};styleTile(key,true)}
      }
      updateS1UI();
    });
    document.getElementById("s1SelSaturated").addEventListener("click",()=>{
      // Grid tiles
      for(let r=0;r<gridRows;r++)for(let c=0;c<gridCols;c++){
        const key=tk(r,c);
        const statusKey=gridToTileKey[key];
        const info=statusKey?tileStatus[statusKey]:null;
        if(info&&(info.result_count||0)>=60&&!selectedTiles[key]){
          selectedTiles[key]={row:r,col:c,legacy:false};styleTile(key,true);
        }
      }
      // Legacy tiles
      for(const [statusKey, info] of Object.entries(tileStatus)){
        if((info.result_count||0)>=60 && legacyTileRects[statusKey]){
          const selKey="legacy_"+statusKey;
          if(!selectedTiles[selKey]){
            selectedTiles[selKey]={legacy:true,statusKey};
            styleLegacyTile(statusKey,true);
          }
        }
      }
      updateS1UI();
    });
    document.getElementById("s1Subdivide").addEventListener("click",subdivideSaturated);
    document.getElementById("s1Clear").addEventListener("click",()=>{
      for(const [selKey, selInfo] of Object.entries(selectedTiles)){
        if(selInfo.legacy) styleLegacyTile(selInfo.statusKey,false);
        else styleTile(selKey,false);
      }
      selectedTiles={}; updateS1UI();
    });
    document.getElementById("s1DeleteSelected").addEventListener("click",deleteSelectedNativeTiles);
    document.getElementById("s1Pull").addEventListener("click",pullS1);

    // Step 2
    document.getElementById("s2Apply").addEventListener("click",applyFilters);
    document.getElementById("s2Save").addEventListener("click",saveFilterList);
    document.getElementById("s2Search").addEventListener("input",renderS2Table);
    document.getElementById("s2TableWrap").addEventListener("scroll",e=>{
      const el=e.currentTarget;
      if(el.scrollTop + el.clientHeight >= el.scrollHeight - 200){
        renderMoreS2Rows();
      }
    });
    document.querySelectorAll("#s2Table th[data-sort]").forEach(th=>{
      th.addEventListener("click",()=>{
        const f=th.dataset.sort;
        if(s2SortField===f) s2SortDir*=-1; else{s2SortField=f;s2SortDir=-1}
        sortS2(); renderS2Table();
      });
    });

    // Step 3
    document.getElementById("s3LoadQueue").addEventListener("click",loadDetailQueue);
    document.getElementById("s3ListSelect").addEventListener("change",()=>{
      const name=document.getElementById("s3ListSelect").value;
      if(name) loadDetailQueue();
      else {
        document.getElementById("s3QueueInfo").classList.add("Fhide");
        detailedPlaces=[]; document.getElementById("s3Count").textContent="0";
        document.getElementById("s3Tbody").innerHTML="";
      }
    });
    document.getElementById("s3PullDetails").addEventListener("click",pullDetails);
    document.getElementById("s3LoadResults").addEventListener("click",loadDetailedResults);
    document.getElementById("s3TableWrap").addEventListener("scroll",e=>{
      const el=e.currentTarget;
      if(el.scrollTop + el.clientHeight >= el.scrollHeight - 200){
        renderMoreS3Rows();
      }
    });
    document.getElementById("s3Search").addEventListener("input",e=>{
      const q=e.target.value.toLowerCase();
      if(!q){renderS3Table(detailedPlaces);return}
      renderS3Table(detailedPlaces.filter(p=>(p.name||"").toLowerCase().includes(q)||(p.formatted_address||"").toLowerCase().includes(q)||(p.formatted_phone_number||"").includes(q)));
    });
    document.getElementById("s3ExportCsv").addEventListener("click",exportCsv);

    // Step 4
    document.getElementById("s4LeadRefresh").addEventListener("click",async()=>{
      await loadFilterListsFast(true);
      await renderLeadListGenerator();
    });
    document.getElementById("s4LeadListSelect").addEventListener("change",async e=>{
      await renderLeadListGenerator(e.currentTarget.value || "");
    });
    document.getElementById("s4LeadChunk").addEventListener("input",async()=>{
      await renderLeadListGenerator();
    });
    document.getElementById("s4LeadGroupMode").addEventListener("change",async()=>{
      await renderLeadListGenerator();
    });
    document.getElementById("s4LeadCreate").addEventListener("click",()=>createCRMListsFromSelectedTerritoryList());

    // Step 5
    document.getElementById("s4Refresh").addEventListener("click",loadCosts);
    document.getElementById("s4Reset").addEventListener("click",async()=>{
      if(!confirm("Reset the entire cost ledger? This cannot be undone."))return;
      await api("reset_costs");
      loadCosts();
    });
  }

  function updateBadge(){
    const n=Object.keys(tileStatus).length;
    const totalBiz=Object.values(tileStatus).reduce((a,t)=>a+(t.result_count||0),0);
    const saturated=Object.values(tileStatus).filter(t=>(t.result_count||0)>=60).length;
    let txt=`${n} tiles · ${totalBiz} businesses`;
    if(saturated) txt+=` · ⚠ ${saturated} saturated`;
    if(Object.keys(legacyTileRects).length) txt+=` · ${Object.keys(legacyTileRects).length} legacy`;
    document.getElementById("Fbadge").textContent=txt;
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  async function boot(){
    build(); hookAll();
    try{const r=await api("get_config");if(r.config){
      normalizeConfig(r.config);
      legacyConfig = r.legacy_config || {};
      }
      document.getElementById("s1TileSize").value=config.tile_side_miles;
      document.getElementById("s1Type").value=config.search_type;
      document.getElementById("s1CenterLat").value=config.center_lat.toFixed(4);
      document.getElementById("s1CenterLng").value=config.center_lng.toFixed(4);
    }catch(e){}
    try{const r=await api("get_tile_status");if(r.tiles)tileStatus=r.tiles}catch(e){}
    updateBadge();
    loadGMaps();
  }

  function loadGMaps(){
    setMapStatus("Loading Google Maps…");
    if(window.google&&window.google.maps){initMap();return}
    clearTimeout(gmapsLoadTimer);
    gmapsLoadTimer=setTimeout(()=>{
      setMapStatus(
        "Google Maps did not finish loading. This is usually a local environment issue such as a blocked/referrer-restricted API key, billing restriction, or browser console error preventing the map from initializing.",
        true
      );
    },8000);
    const s=document.createElement("script");
    s.src=`https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&libraries=places&callback=__fmapReady`;
    s.onerror=function(){
      clearTimeout(gmapsLoadTimer);
      setMapStatus("Google Maps script failed to load. Check network access and any API key or referrer restrictions for this environment.", true);
    };
    s.async=true;s.defer=true;document.head.appendChild(s);
  }
  window.__fmapReady=function(){initMap()};
  window.gm_authFailure=function(){
    clearTimeout(gmapsLoadTimer);
    setMapStatus("Google Maps authentication failed for this page. The API key is likely restricted to another host/referrer or missing required billing/services for this local environment.", true);
  };
  function refreshVisibleMap(){
    if(!map || !window.google || !window.google.maps) return;
    const center={lat:config.center_lat,lng:config.center_lng};
    window.google.maps.event.trigger(map,"resize");
    map.setCenter(center);
  }

  if(!isManager()) return;

  ensureMarkup();
  Portal.registerPlugin({ id:"territory-builder", title:"Territory", iconClass:"fas fa-map-location-dot" });

  const origSwitch = Portal.switchView ? Portal.switchView.bind(Portal) : null;
  if(origSwitch){
    Portal.switchView = async function(id, btn){
      await origSwitch(id, btn);
      if(id!=="territory-builder") return;
      if(!territoryBooted){
        territoryBooted=true;
        boot();
      } else {
        refreshVisibleMap();
      }
    };
  }
})();
