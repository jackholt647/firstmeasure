// dev_tools.js (FULL DROP-IN REPLACEMENT — preserves manual facet centers + includes them in Faces list
// + auto-enables center-placement mode on PASS 1
//
// UPDATE (today):
// - Bumps MAX_PASS to 8 (new PASS 8: straightening optimizer)
// - Adds PASS 8 dot button + recompute support
// - Adds PASS 8 knobs to UI (pass8* options)
// - Adds PASS 8 outer-edge 90° rule knobs:
//     pass8OuterShortMinLenPx, pass8OuterEdgeProbePx
//
// Keeps:
// - PASS 6 point→line snapping knobs:
//     lineSnapRadiusM, lineSnapGridCells, lineSnapPasses, lineSnapAcrossLayers
// - PASS 6A.5 collinear-align knobs:
//     collinearAlignEnabled, collinearAlignDeg, collinearAlignMinLenM
// - Manual facet center persistence across reinject / refresh / goto.
//
// Assumes geometry_core exports:
//   roofFacesReset(opts?)
//   roofFacesNext(), roofFacesGoto(n), roofFacesStatus(), roofFacesPrev(), roofFacesClear()
//   roofFacesCenterMode(bool)
// And that pipeline is stored at window.__ROOF_FACET_FACE_PIPELINE__ with state.manualCenters.

(function () {
  function injectDevControls() {
    const ID = "facet-dev-controls";
    const existing = document.getElementById(ID);
    if (existing) existing.remove();

    const PIPE_KEY = "__ROOF_FACET_FACE_PIPELINE__";
    const DBG_GROUP_NAME = "__FACET_PIPELINE_DEBUG_FACES__";
    const RENDER_VIS_KEY = "__FACET_DEV_RENDER_VIS__"; // per-face id -> bool
    const DISABLED_KEY = "__FACET_DEV_DISABLED_IDS__"; // face id -> bool (algorithmic exclusion)
    const LAST_OPTS_KEY = "__FACET_DEV_LAST_OPTS__";
    const MANUAL_CENTERS_KEY = "__FACET_DEV_MANUAL_CENTERS__"; // persistent manual centers for pipeline

    const MAX_PASS = 8;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const isNum = (v) => typeof v === "number" && isFinite(v);
    const fmt = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : v);

    if (!window[RENDER_VIS_KEY]) window[RENDER_VIS_KEY] = {};
    if (!window[DISABLED_KEY]) window[DISABLED_KEY] = {};
    if (!window[LAST_OPTS_KEY]) window[LAST_OPTS_KEY] = null;
    if (!window[MANUAL_CENTERS_KEY]) window[MANUAL_CENTERS_KEY] = [];

    const renderVis = window[RENDER_VIS_KEY];
    const disabled = window[DISABLED_KEY];

    const hasGaplessPass5 =
      typeof window.buildOwnerMapFromMasks === "function" ||
      typeof buildOwnerMapFromMasks === "function";

    const help = {
      thresholdM:
        "Meters tolerance for overlap scoring (passes 2/3). Bigger = easier match; smaller = stricter.",
      thresholdEdgeM:
        "Meters tolerance for edge-grow flood fill (pass 4). Bigger grows larger regions.",

      circleRadiusPx:
        "Local scoring radius around facet center (px). Bigger = more stable, but can mix facets.",
      circleSampleStepPx:
        "Sampling stride within the circle (px). Smaller = more accurate, slower.",
      coarsePitchMinDeg: "Pass 2: minimum pitch searched (deg).",
      coarsePitchMaxDeg: "Pass 2: maximum pitch searched (deg).",
      coarsePitchStepDeg:
        "Pass 2: pitch step (deg). Smaller = slower but more accurate.",
      coarseAzStepDeg:
        "Pass 2: azimuth step (deg). Smaller = slower but more accurate.",
      refinePitchWindowDeg: "Pass 3: ± pitch window around coarse (deg).",
      refineAzWindowDeg: "Pass 3: ± azimuth window around coarse (deg).",
      refinePitchStepDeg:
        "Pass 3: pitch refinement step (deg). Smaller = more precise, slower.",
      refineAzStepDeg:
        "Pass 3: azimuth refinement step (deg). Smaller = more precise, slower.",
      localWeight: "Pass 3: 1.0 = local-only, 0.0 = global-only.",
      globalSamples: "Pass 3: number of DSM samples for global score.",

      edgeMaxPixelsPerFace:
        "Pass 4: max pixels to flood-fill per face (safety cap).",
      edgeContourMaxSteps: "Pass 4: max contour trace steps (safety cap).",
      edgeSimplifyEpsPx:
        "Pass 4: contour simplification epsilon (px). Bigger = fewer points.",
      edgeMaxVertices: "Pass 4: max vertices in edge polygon (downsample cap).",
      edgeFallbackToDiscIfFail:
        "Pass 4: if grow fails, use a disc around center as boundary.",

      planeMergeEnabled:
        "Pass 4: merge nearly-identical planes after edge-grow (true/false).",
      planeMergeOverlapPct:
        "Pass 4: required overlap fraction of the SMALLER face (0..1).",
      planeMergeAngleDeg:
        "Pass 4: max pitch AND azimuth delta (deg) to consider planes identical.",
      planeMergeHeightTolM:
        "Pass 4: mean |planeA-planeB| over overlap pixels must be <= this (meters).",
      planeMergeSampleStridePx:
        "Pass 4: overlap height sampling stride (px). Bigger = faster, less accurate.",

      overlapCheckRadiusPx:
        "Pass 5: larger circle used to judge DSM fit (winner selection).",
      overlapDebugMaxDots: "Pass 5: cap overlap debug dots in 2D.",

      stage5SimplifyEpsPx:
        "Pass 5: RDP simplify epsilon (px) applied AFTER seam-safe polygonize.",
      stage5MaxVertices:
        "Pass 5: optional max vertices after RDP (downsample cap).",

      minFaceAreaPx2: "Minimum final face area (px²).",

      publishLayer: "Pass 6: layer assigned to published faces/points.",
      publishAddConnections:
        "Pass 6: add perimeter connections between published points.",

      mergeRadius3dM:
        "Pass 6: weld points within this 3D radius (meters). 0 disables.",
      mergeGridCells:
        "Pass 6: neighbor cell search radius (1 => 3x3x3 cells).",
      mergeAcrossLayers:
        "Pass 6: allow welding across different layers (defaults true).",

      collinearAlignEnabled:
        "Pass 6: rotate shorter edges to align with longer nearly-collinear edges (true/false).",
      collinearAlignDeg:
        "Pass 6: max angle delta (deg) to treat two incident edges as collinear for alignment.",
      collinearAlignMinLenM:
        "Pass 6: ignore edges shorter than this length (meters) for collinear alignment.",

      lineSnapRadiusM:
        "Pass 6: snap points onto nearby line segments within this XY radius (meters). 0 disables. Snaps (no averaging).",
      lineSnapGridCells:
        "Pass 6: neighbor cell search radius for segment lookup (1 => 3x3 cells).",
      lineSnapPasses:
        "Pass 6: how many times to repeat snap+split/collapse (>=1).",
      lineSnapAcrossLayers:
        "Pass 6: allow snapping across different layers (defaults true).",

      pass7CleanupCollinearDeg:
        "Pass 7: cleanup — collapse degree-2 points that are nearly collinear (deg tolerance).",
      pass7CleanupMaxIters:
        "Pass 7: cleanup — iterations of collapse/dedupe until stable (safety cap).",

      // PASS 8 straightener
      pass8Enabled:
        "Pass 8: master toggle for straightening optimizer (true/false).",
      pass8AngleSnapDegTol:
        "Pass 8: tolerance window (deg) for snap targets. Smaller = stricter.",
      pass8Epochs: "Pass 8: hill-climb sweeps over points (epochs).",
      pass8StepPx:
        "Pass 8: candidate step size in pixels for deterministic tweaks.",
      pass8MaxMoveRadiusPx:
        "Pass 8: hard max distance from original point (px).",
      pass8UseAutoFacetOnly:
        "Pass 8: only move __autoFacet points (recommended).",
      pass8PreserveZ:
        "Pass 8: keep Z unchanged while moving XY (recommended).",
      pass8RandomEpochs:
        "Pass 8: number of random-wiggle epochs (accept-if-better).",
      pass8RandomWiggleAmpPx:
        "Pass 8: random wiggle amplitude per proposal (px).",
      pass8RandomTriesPerPoint:
        "Pass 8: random proposals per point per epoch.",
      pass8SkipDegreeLT2:
        "Pass 8: skip moving points with degree < 2.",
      pass8MaskPaddingPx:
        "Pass 8: optional padding from roof mask edge (px). 0 allows boundary.",
      pass8Verbose: "Pass 8: extra console logs (true/false).",

      // PASS 8 outer-edge 90° rule
      pass8OuterShortMinLenPx:
        "Pass 8: if BOTH incident edges are outer roof edges AND one is shorter than this (px), snap that corner to 90° multiples instead of 45°.",
      pass8OuterEdgeProbePx:
        "Pass 8: roofMask probe radius (px) around edge midpoint to classify an edge as 'outer'.",
    };

    const keysAll = [
      "thresholdM",
      "thresholdEdgeM",

      "circleRadiusPx",
      "circleSampleStepPx",
      "coarsePitchMinDeg",
      "coarsePitchMaxDeg",
      "coarsePitchStepDeg",
      "coarseAzStepDeg",
      "refinePitchWindowDeg",
      "refineAzWindowDeg",
      "refinePitchStepDeg",
      "refineAzStepDeg",
      "localWeight",
      "globalSamples",

      "edgeMaxPixelsPerFace",
      "edgeContourMaxSteps",
      "edgeSimplifyEpsPx",
      "edgeMaxVertices",
      "edgeFallbackToDiscIfFail",

      "planeMergeEnabled",
      "planeMergeOverlapPct",
      "planeMergeAngleDeg",
      "planeMergeHeightTolM",
      "planeMergeSampleStridePx",

      "overlapCheckRadiusPx",
      "overlapDebugMaxDots",
      "stage5SimplifyEpsPx",
      "stage5MaxVertices",

      "overlapCutRadiusPx",
      "overlapMaxIters",
      "tendrilMinCircleRadiusPx",
      "tendrilCoreErodeStepPx",

      "minFaceAreaPx2",

      "publishLayer",
      "publishAddConnections",
      "mergeRadius3dM",
      "mergeGridCells",
      "mergeAcrossLayers",

      "collinearAlignEnabled",
      "collinearAlignDeg",
      "collinearAlignMinLenM",

      "lineSnapRadiusM",
      "lineSnapGridCells",
      "lineSnapPasses",
      "lineSnapAcrossLayers",

      "pass7CleanupCollinearDeg",
      "pass7CleanupMaxIters",

      // PASS 8
      "pass8Enabled",
      "pass8AngleSnapDegTol",
      "pass8Epochs",
      "pass8StepPx",
      "pass8MaxMoveRadiusPx",
      "pass8UseAutoFacetOnly",
      "pass8PreserveZ",
      "pass8RandomEpochs",
      "pass8RandomWiggleAmpPx",
      "pass8RandomTriesPerPoint",
      "pass8SkipDegreeLT2",
      "pass8MaskPaddingPx",
      "pass8Verbose",

      // PASS 8 outer-edge 90° rule
      "pass8OuterShortMinLenPx",
      "pass8OuterEdgeProbePx",
    ];

    const keys = hasGaplessPass5
      ? keysAll.filter(
          (k) =>
            ![
              "overlapCutRadiusPx",
              "overlapMaxIters",
              "tendrilMinCircleRadiusPx",
              "tendrilCoreErodeStepPx",
            ].includes(k)
        )
      : keysAll;

    const BOOL_KEYS = new Set([
      "publishAddConnections",
      "edgeFallbackToDiscIfFail",
      "mergeAcrossLayers",
      "planeMergeEnabled",
      "collinearAlignEnabled",
      "lineSnapAcrossLayers",

      // pass 8 bools
      "pass8Enabled",
      "pass8UseAutoFacetOnly",
      "pass8PreserveZ",
      "pass8SkipDegreeLT2",
      "pass8Verbose",
    ]);

    const deepClone = (obj) => {
      try {
        return structuredClone(obj);
      } catch (e) {}
      return JSON.parse(JSON.stringify(obj));
    };

    const getPipeline = () => window[PIPE_KEY] || null;

    // ---- manual center persistence helpers ----
    function readManualCentersFromPipelineOrStore() {
      const p = getPipeline();
      const fromPipe =
        p && p.state && Array.isArray(p.state.manualCenters)
          ? p.state.manualCenters
          : null;

      const fromStore = Array.isArray(window[MANUAL_CENTERS_KEY])
        ? window[MANUAL_CENTERS_KEY]
        : [];

      const arr = (fromPipe && fromPipe.length ? fromPipe : fromStore) || [];

      const out = arr
        .map((c) => {
          if (!c) return null;
          const x = Number(c.x);
          const y = Number(c.y);
          const z0 = Number(c.z0);
          if (!isFinite(x) || !isFinite(y) || !isFinite(z0)) return null;
          return {
            x,
            y,
            z0,
            pitchGuessDeg:
              typeof c.pitchGuessDeg === "number" && isFinite(c.pitchGuessDeg)
                ? c.pitchGuessDeg
                : null,
            azGuessDeg:
              typeof c.azGuessDeg === "number" && isFinite(c.azGuessDeg)
                ? c.azGuessDeg
                : null,
          };
        })
        .filter(Boolean);

      window[MANUAL_CENTERS_KEY] = deepClone(out);
      return out;
    }

    function writeManualCentersToPipeline(pipeline, centers) {
      if (!pipeline) return;
      if (!pipeline.state) pipeline.state = {};
      pipeline.state.manualCenters = deepClone(centers || []);
      window[MANUAL_CENTERS_KEY] = deepClone(centers || []);

      if (typeof window.publishDebugCentersFor2D === "function") {
        try {
          window.publishDebugCentersFor2D(pipeline);
        } catch (e) {}
      } else {
        if (typeof renderGeometry2D === "function") renderGeometry2D();
        if (typeof triggerLiveUpdate === "function") triggerLiveUpdate();
      }
    }

    function ensurePipeline() {
      if (typeof roofFacesReset === "function" && !getPipeline()) {
        roofFacesReset(window[LAST_OPTS_KEY] || undefined);
      }

      const p = getPipeline();
      if (p) {
        if (!p.state) p.state = {};
        if (
          !Array.isArray(p.state.manualCenters) ||
          !p.state.manualCenters.length
        ) {
          const restored = readManualCentersFromPipelineOrStore();
          if (restored.length) writeManualCentersToPipeline(p, restored);
        } else {
          window[MANUAL_CENTERS_KEY] = deepClone(p.state.manualCenters);
        }
      }
      return p;
    }

    const getDbgGroup = () => {
      try {
        if (typeof scene === "undefined" || !scene) return null;
        return scene.getObjectByName(DBG_GROUP_NAME);
      } catch (e) {
        return null;
      }
    };

    const get2DDebugPathsAndLabels = () => {
      const svg = document.getElementById("geoSvg");
      if (!svg) return { paths: [], labels: [] };
      const g = document.getElementById("geo-rotation-group") || svg;
      const paths = Array.from(g.querySelectorAll("path.facet-pipeline-face"));
      const labels = Array.from(g.querySelectorAll("text.facet-pipeline-face"));
      return { paths, labels };
    };

    // === Face ID universe must include manual centers ===
    function getSolarFacetCount() {
      if (typeof segmentStats !== "undefined" && Array.isArray(segmentStats)) {
        return segmentStats.length | 0;
      }
      const p = getPipeline();
      if (
        p &&
        p.state &&
        Array.isArray(p.state.centers) &&
        p.state.centers.length
      ) {
        return p.state.centers.length;
      }
      return 0;
    }

    function getManualCenterCount() {
      const p = getPipeline();
      const a =
        p && p.state && Array.isArray(p.state.manualCenters)
          ? p.state.manualCenters
          : null;
      if (a) return a.length | 0;
      const s = Array.isArray(window[MANUAL_CENTERS_KEY])
        ? window[MANUAL_CENTERS_KEY]
        : [];
      return s.length | 0;
    }

    function getExpectedCenterIdList() {
      const solarN = getSolarFacetCount();
      const manualN = getManualCenterCount();
      const total = (solarN + manualN) | 0;
      if (total <= 0) return [];
      const ids = new Array(total);
      for (let i = 0; i < total; i++) ids[i] = i + 1;
      return ids;
    }

    const getCurrentFaceIdList = () => {
      const p = getPipeline();
      if (!p) return [];

      if (p.state && Array.isArray(p.state.planes) && p.state.planes.length) {
        return p.state.planes.map((x) => x.id);
      }

      if (p.state && Array.isArray(p.state.centers) && p.state.centers.length) {
        return p.state.centers.map((x) => x.id);
      }

      return getExpectedCenterIdList();
    };

    const applyRenderVisibilityNow = () => {
      const ids = getCurrentFaceIdList();
      const g3 = getDbgGroup();
      const { paths, labels } = get2DDebugPathsAndLabels();

      // 3D (plane order)
      if (g3 && g3.children && g3.children.length) {
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const on = renderVis[id] === undefined ? true : !!renderVis[id];
          if (g3.children[i]) g3.children[i].visible = on;
        }
      }

      // 2D overlay (only safe when count matches)
      if (paths.length && ids.length && paths.length === ids.length) {
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const on = renderVis[id] === undefined ? true : !!renderVis[id];
          if (paths[i]) paths[i].style.display = on ? "block" : "none";
          if (labels[i]) labels[i].style.display = on ? "block" : "none";
        }
      } else if (paths.length && ids.length && paths.length !== ids.length) {
        console.warn(
          "[DevControls] 2D overlay count doesn't match face count; per-face 2D toggles are ambiguous at this stage.",
          { faceIds: ids.length, overlayPaths: paths.length }
        );
      }
    };

    // === algorithmic exclusion ===
    function applyDisabledToPipelinePass1(pipeline) {
      if (!pipeline || !pipeline.state) return;
      if (!Array.isArray(pipeline.state.centers)) return;

      const before = pipeline.state.centers.length;
      const keep = pipeline.state.centers.filter((c) => !disabled[c.id]);
      pipeline.state.centers = keep;

      if (Array.isArray(pipeline.state.planes) && pipeline.state.planes.length) {
        pipeline.state.planes = pipeline.state.planes.filter(
          (pl) => !disabled[pl.id]
        );
      }

      pipeline.state.edgeMasks = [];
      pipeline.state.edgePolys = [];
      pipeline.state.polys = [];

      if (pipeline.snapshots) {
        pipeline.snapshots[1] = deepClone({
          pass: 1,
          opts: pipeline.opts,
          state: pipeline.state,
        });
      }

      console.log(
        "%c[DevControls] Algorithmic filter applied",
        "color:#00e8e8;font-weight:bold;"
      );
      console.log(
        "Disabled IDs:",
        Object.keys(disabled)
          .filter((k) => disabled[k])
          .map(Number)
      );
      console.log(`Centers: ${before} -> ${keep.length}`);
    }

    // === IMPORTANT: recompute must preserve manual centers ===
    function recomputeToPass(targetPass, opts) {
      if (
        typeof roofFacesReset !== "function" ||
        typeof roofFacesNext !== "function" ||
        typeof roofFacesGoto !== "function"
      ) {
        console.warn("[DevControls] Missing roofFacesReset/Next/Goto.");
        return;
      }

      const pass = Math.max(0, Math.min(MAX_PASS, targetPass | 0));

      // capture manual centers BEFORE reset
      const manualCenters = readManualCentersFromPipelineOrStore();

      console.log(
        "%c[DevControls] Recompute",
        "color:#ffd166;font-weight:bold;",
        {
          pass,
          opts,
          gaplessPass5: hasGaplessPass5,
          manualCenters: manualCenters.length,
        }
      );

      roofFacesReset(opts);

      const p0 = getPipeline();
      if (p0) writeManualCentersToPipeline(p0, manualCenters);

      if (pass === 0) return;

      roofFacesNext(); // pass 1
      const p = getPipeline();
      applyDisabledToPipelinePass1(p);

      if (pass > 1) roofFacesGoto(pass);
    }

    // ---------- build UI ----------
    const panel = document.createElement("div");
    panel.id = ID;
    panel.style.cssText = `
      position: fixed; top: 10px; left: 10px;
      width: 520px;
      max-height: calc(100vh - 20px);
      overflow: hidden;
      z-index: 999999;
      background: rgba(20,20,24,0.95);
      color: #f2f2f4;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
      display:flex; align-items:center; justify-content:space-between;
      padding: 10px 10px 8px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
    `;

    const title = document.createElement("div");
    title.textContent = "Facet Dev Controls";
    title.style.cssText = `font-weight: 900; font-size: 13px; letter-spacing: 0.2px;`;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.style.cssText = `
      appearance:none;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.08);
      color: #fff;
      border-radius: 8px;
      width: 28px; height: 28px;
      cursor: pointer;
      font-weight: 900;
    `;
    closeBtn.onmouseenter = () =>
      (closeBtn.style.background = "rgba(255,255,255,0.14)");
    closeBtn.onmouseleave = () =>
      (closeBtn.style.background = "rgba(255,255,255,0.08)");
    closeBtn.onclick = () => {
      if (typeof roofFacesCenterMode === "function") {
        try {
          roofFacesCenterMode(false);
        } catch (e) {}
      }
      panel.remove();
    };

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.style.cssText = `
      padding: 10px 10px 0 10px;
      overflow: auto;
      max-height: calc(100vh - 20px - 54px);
    `;

    const note = document.createElement("div");
    note.style.cssText = `font-size: 11px; opacity: 0.85; line-height: 1.35; margin-bottom: 10px;`;
    note.innerHTML = `
      <div><b>Click face</b> = toggle render. <b>Ctrl+Click</b> = exclude/include algorithm.</div>
      <div><b>Shift+Click</b> = solo render. <b>Alt+Click</b> = invert render.</div>
      <div style="opacity:0.8;margin-top:6px;">
        Manual facet centers are persisted across recompute.
        ${
          hasGaplessPass5
            ? "<span style='color:#9dff33;font-weight:900;'>Gapless PASS 5 detected</span> (old cut/tendril knobs hidden)."
            : ""
        }
      </div>
      <div style="opacity:0.85;margin-top:6px;">
        <b>PASS 1</b>: center placement mode forced ON.
      </div>
      <div style="opacity:0.85;margin-top:6px;">
        <b>PASS 8</b>: straightening; outer-short corners can prefer 90°.
      </div>
    `;

    // Face controls
    const faceBox = document.createElement("div");
    faceBox.style.cssText = `
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
    `;

    const faceHdr = document.createElement("div");
    faceHdr.style.cssText = `display:flex; align-items:center; justify-content:space-between; margin-bottom: 8px;`;

    const faceTitle = document.createElement("div");
    faceTitle.textContent = "Faces";
    faceTitle.title =
      "Includes manual centers. Ctrl+Click excludes that face from the algorithm (applied at PASS 1).";
    faceTitle.style.cssText = `font-size: 12px; font-weight: 900; cursor: help;`;

    const faceCountLabel = document.createElement("div");
    faceCountLabel.style.cssText = `font-size: 11px; opacity: 0.75;`;
    faceCountLabel.textContent = "Faces: —";

    faceHdr.appendChild(faceTitle);
    faceHdr.appendChild(faceCountLabel);

    const faceActions = document.createElement("div");
    faceActions.style.cssText = `display:flex; gap: 2px; margin-bottom: 8px;`;

    const mkBtn = (txt, tip) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = txt;
      b.title = tip || "";
      b.style.cssText = `
        flex: 1;
        appearance:none;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.08);
        color: #fff;
        border-radius: 10px;
        padding: 8px 8px;
        cursor: pointer;
        font-weight: 900;
        font-size: 11px;
      `;
      b.onmouseenter = () =>
        (b.style.background = "rgba(255,255,255,0.14)");
      b.onmouseleave = () =>
        (b.style.background = "rgba(255,255,255,0.08)");
      return b;
    };

    const btnShowAll = mkBtn("Show All", "Render ON for all.");
    const btnHideAll = mkBtn("Hide All", "Render OFF for all.");
    const btnEnableAllAlgo = mkBtn("Enable All Algo", "Include all faces in algorithm.");
    const btnDisableAllAlgo = mkBtn("Disable All Algo", "Exclude all faces from algorithm.");

    faceActions.appendChild(btnShowAll);
    faceActions.appendChild(btnHideAll);

    const faceActions2 = document.createElement("div");
    faceActions2.style.cssText = `display:flex; gap: 2px; margin-bottom: 8px;`;
    faceActions2.appendChild(btnEnableAllAlgo);
    faceActions2.appendChild(btnDisableAllAlgo);

    const faceGrid = document.createElement("div");
    faceGrid.style.cssText = `display:grid; grid-template-columns: repeat(15, 1fr); gap: 6px;`;

    const faceHint = document.createElement("div");
    faceHint.style.cssText = `font-size: 10px; opacity: 0.75; margin-top: 8px; line-height: 1.3;`;
    faceHint.innerHTML = `
      <span style="opacity:0.9;">Green</span>=render on,
      <span style="opacity:0.9;">Gray</span>=render off,
      <span style="opacity:0.9;color:#ff6b6b;">Red border</span>=excluded from algorithm.
    `;

    faceBox.appendChild(faceHdr);
    faceBox.appendChild(faceActions);
    faceBox.appendChild(faceActions2);
    faceBox.appendChild(faceGrid);
    faceBox.appendChild(faceHint);

    // PASS 8 quick action row
    const pass8Actions = document.createElement("div");
    pass8Actions.style.cssText = `display:flex; gap: 6px; margin: 8px 0 0 0;`;

    const btnP8Reset = mkBtn(
      "Reset PASS 8 Points",
      "Calls roofFacesPass8ResetPoints() if available."
    );
    btnP8Reset.style.flex = "1";
    btnP8Reset.onclick = () => {
      if (typeof window.roofFacesPass8ResetPoints === "function") {
        try {
          window.roofFacesPass8ResetPoints();
        } catch (e) {
          console.warn("[DevControls] roofFacesPass8ResetPoints failed:", e);
        }
      } else {
        console.warn("[DevControls] roofFacesPass8ResetPoints not found.");
      }
      applyRenderVisibilityNow();
    };

    pass8Actions.appendChild(btnP8Reset);
    faceBox.appendChild(pass8Actions);

    // Fields
    const fieldsWrap = document.createElement("div");
    fieldsWrap.style.cssText = `display:flex; flex-direction:column; gap: 2px; padding-bottom: 10px; max-height: calc(100vh - 520px); overflow-y: scroll;`;

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 10px;
      border-top: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
    `;

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "Refresh (Apply + Recompute Current Pass)";
    refreshBtn.style.cssText = `
      width: 100%;
      appearance:none;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(0, 180, 255, 0.18);
      color: #eaf7ff;
      border-radius: 10px;
      padding: 10px 10px;
      cursor: pointer;
      font-weight: 900;
      font-size: 12px;
    `;
    refreshBtn.onmouseenter = () =>
      (refreshBtn.style.background = "rgba(0, 180, 255, 0.28)");
    refreshBtn.onmouseleave = () =>
      (refreshBtn.style.background = "rgba(0, 180, 255, 0.18)");

    const dotsBar = document.createElement("div");
    dotsBar.style.cssText = `display:flex; justify-content:space-between; gap: 2px; margin-top: 10px; padding: 8px 4px 2px 4px;`;

    const dotBtns = [];
    const makeDot = (n) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = `Go to Pass ${n} (recompute with current params + exclusions)`;
      btn.style.cssText = `
        flex: 1; height: 28px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.08);
        cursor: pointer;
        position: relative;
      `;
      const inner = document.createElement("div");
      inner.textContent = String(n);
      inner.style.cssText = `
        position:absolute; inset: 0;
        display:flex; align-items:center; justify-content:center;
        font-weight: 900; font-size: 12px;
        color: rgba(255,255,255,0.9);
        pointer-events:none;
      `;
      btn.appendChild(inner);

      btn.onclick = () => {
        const opts = readOptsFromUI();
        recomputeToPass(n, opts);
        updateDots();
        rebuildFaceButtons();
        applyRenderVisibilityNow();
        enforcePlacementModeForPass();
      };

      dotBtns.push(btn);
      return btn;
    };

    [1, 2, 3, 4, 5, 6, 7, 8].forEach((n) => dotsBar.appendChild(makeDot(n)));

    footer.appendChild(refreshBtn);
    footer.appendChild(dotsBar);

    panel.appendChild(header);

    // Stop events from leaking to the canvas
    [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "pointerdown",
      "pointerup",
      "wheel",
    ].forEach((evt) => {
      panel.addEventListener(
        evt,
        (e) => {
          e.stopPropagation();
          if (evt === "wheel") e.preventDefault();
        },
        { passive: false }
      );
    });

    // ----- fields logic -----
    const inputs = new Map();

    function readCurrentOptsFromPipelineOrDefaults() {
      const p = ensurePipeline();
      if (p && p.opts) return { ...p.opts };

      return {
        thresholdM: 0.05,
        thresholdEdgeM: 0.2,

        circleRadiusPx: 18,
        circleSampleStepPx: 2,
        coarsePitchMinDeg: 0,
        coarsePitchMaxDeg: 80,
        coarsePitchStepDeg: 6,
        coarseAzStepDeg: 12,

        refinePitchWindowDeg: 10,
        refineAzWindowDeg: 20,
        refinePitchStepDeg: 1,
        refineAzStepDeg: 2,
        localWeight: 0.72,
        globalSamples: 1200,

        edgeMaxPixelsPerFace: 220000,
        edgeContourMaxSteps: 250000,
        edgeSimplifyEpsPx: 2.0,
        edgeMaxVertices: 600,
        edgeFallbackToDiscIfFail: true,

        planeMergeEnabled: true,
        planeMergeOverlapPct: 0.7,
        planeMergeAngleDeg: 4.0,
        planeMergeHeightTolM: 0.05,
        planeMergeSampleStridePx: 2,

        overlapCheckRadiusPx: 5,
        overlapDebugMaxDots: 6000,

        stage5SimplifyEpsPx: 2.0,
        stage5MaxVertices: 600,

        overlapCutRadiusPx: 1,
        overlapMaxIters: 6,
        tendrilMinCircleRadiusPx: 5,
        tendrilCoreErodeStepPx: 1,

        minFaceAreaPx2: 50,

        publishLayer: 1,
        publishAddConnections: false,

        mergeRadius3dM: 0.0,
        mergeGridCells: 1,
        mergeAcrossLayers: true,

        collinearAlignEnabled: true,
        collinearAlignDeg: 5.0,
        collinearAlignMinLenM: 0.15,

        lineSnapRadiusM: 0.0,
        lineSnapGridCells: 1,
        lineSnapPasses: 1,
        lineSnapAcrossLayers: true,

        pass7CleanupCollinearDeg: 3.0,
        pass7CleanupMaxIters: 6,

        // PASS 8 defaults
        pass8Enabled: true,
        pass8AngleSnapDegTol: 10.0,
        pass8Epochs: 140,
        pass8StepPx: 0.9,
        pass8MaxMoveRadiusPx: 10.0,
        pass8UseAutoFacetOnly: true,
        pass8PreserveZ: true,
        pass8RandomEpochs: 60,
        pass8RandomWiggleAmpPx: 1.6,
        pass8RandomTriesPerPoint: 1,
        pass8SkipDegreeLT2: true,
        pass8MaskPaddingPx: 0,
        pass8Verbose: false,

        // NEW: PASS 8 outer-edge 90° rule
        pass8OuterShortMinLenPx: 20,
        pass8OuterEdgeProbePx: 1,
      };
    }

    function parseBool(raw, fallback = false) {
      const s = String(raw).trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(s)) return true;
      if (["0", "false", "no", "n", "off"].includes(s)) return false;
      return fallback;
    }

    function coerceValue(key, raw) {
      if (BOOL_KEYS.has(key)) return parseBool(raw, false);
      const n = Number(raw);
      return isFinite(n) ? n : raw;
    }

    function normalizeOpts(opts) {
      const out = { ...opts };

      if (isNum(out.localWeight)) out.localWeight = clamp(out.localWeight, 0, 1);

      if (isNum(out.coarsePitchMinDeg)) out.coarsePitchMinDeg = clamp(out.coarsePitchMinDeg, 0, 85);
      if (isNum(out.coarsePitchMaxDeg)) out.coarsePitchMaxDeg = clamp(out.coarsePitchMaxDeg, 0, 85);

      if (isNum(out.thresholdM)) out.thresholdM = Math.max(0, out.thresholdM);

      if (!isNum(out.thresholdEdgeM)) out.thresholdEdgeM = out.thresholdM;
      if (isNum(out.thresholdEdgeM)) out.thresholdEdgeM = Math.max(0, out.thresholdEdgeM);

      if (isNum(out.globalSamples)) out.globalSamples = Math.max(0, Math.floor(out.globalSamples));

      if (isNum(out.publishLayer)) out.publishLayer = clamp(Math.round(out.publishLayer), 1, 6);

      if (isNum(out.edgeMaxPixelsPerFace)) out.edgeMaxPixelsPerFace = Math.max(1000, Math.floor(out.edgeMaxPixelsPerFace));
      if (isNum(out.edgeContourMaxSteps)) out.edgeContourMaxSteps = Math.max(1000, Math.floor(out.edgeContourMaxSteps));
      if (isNum(out.edgeSimplifyEpsPx)) out.edgeSimplifyEpsPx = Math.max(0, out.edgeSimplifyEpsPx);
      if (isNum(out.edgeMaxVertices)) out.edgeMaxVertices = Math.max(30, Math.floor(out.edgeMaxVertices));

      out.planeMergeEnabled = !!out.planeMergeEnabled;
      if (isNum(out.planeMergeOverlapPct)) out.planeMergeOverlapPct = clamp(out.planeMergeOverlapPct, 0, 0.999);
      else out.planeMergeOverlapPct = 0.7;

      if (isNum(out.planeMergeAngleDeg)) out.planeMergeAngleDeg = Math.max(0, out.planeMergeAngleDeg);
      else out.planeMergeAngleDeg = 4.0;

      if (isNum(out.planeMergeHeightTolM)) out.planeMergeHeightTolM = Math.max(0, out.planeMergeHeightTolM);
      else out.planeMergeHeightTolM = 0.05;

      if (isNum(out.planeMergeSampleStridePx)) out.planeMergeSampleStridePx = Math.max(1, Math.floor(out.planeMergeSampleStridePx));
      else out.planeMergeSampleStridePx = 2;

      if (isNum(out.overlapCheckRadiusPx)) out.overlapCheckRadiusPx = Math.max(1, Math.floor(out.overlapCheckRadiusPx));
      if (isNum(out.overlapDebugMaxDots)) out.overlapDebugMaxDots = Math.max(0, Math.floor(out.overlapDebugMaxDots));

      if (isNum(out.stage5SimplifyEpsPx)) out.stage5SimplifyEpsPx = Math.max(0, out.stage5SimplifyEpsPx);
      if (isNum(out.stage5MaxVertices)) out.stage5MaxVertices = Math.max(0, Math.floor(out.stage5MaxVertices));

      if (isNum(out.overlapCutRadiusPx)) out.overlapCutRadiusPx = Math.max(1, Math.floor(out.overlapCutRadiusPx));
      if (isNum(out.overlapMaxIters)) out.overlapMaxIters = Math.max(1, Math.floor(out.overlapMaxIters));
      if (isNum(out.tendrilMinCircleRadiusPx)) out.tendrilMinCircleRadiusPx = Math.max(1, Math.floor(out.tendrilMinCircleRadiusPx));
      if (isNum(out.tendrilCoreErodeStepPx)) out.tendrilCoreErodeStepPx = Math.max(1, Math.floor(out.tendrilCoreErodeStepPx));

      if (isNum(out.minFaceAreaPx2)) out.minFaceAreaPx2 = Math.max(0, out.minFaceAreaPx2);

      if (!isNum(out.mergeRadius3dM)) out.mergeRadius3dM = 0.0;
      out.mergeRadius3dM = Math.max(0, out.mergeRadius3dM);

      if (!isNum(out.mergeGridCells)) out.mergeGridCells = 1;
      out.mergeGridCells = Math.max(1, Math.floor(out.mergeGridCells));

      out.mergeAcrossLayers = !!out.mergeAcrossLayers;
      out.publishAddConnections = !!out.publishAddConnections;
      out.edgeFallbackToDiscIfFail = !!out.edgeFallbackToDiscIfFail;

      out.collinearAlignEnabled = !!out.collinearAlignEnabled;
      if (!isNum(out.collinearAlignDeg)) out.collinearAlignDeg = 5.0;
      out.collinearAlignDeg = Math.max(0, out.collinearAlignDeg);

      if (!isNum(out.collinearAlignMinLenM)) out.collinearAlignMinLenM = 0.15;
      out.collinearAlignMinLenM = Math.max(0, out.collinearAlignMinLenM);

      if (!isNum(out.lineSnapRadiusM)) out.lineSnapRadiusM = 0.0;
      out.lineSnapRadiusM = Math.max(0, out.lineSnapRadiusM);

      if (!isNum(out.lineSnapGridCells)) out.lineSnapGridCells = 1;
      out.lineSnapGridCells = Math.max(1, Math.floor(out.lineSnapGridCells));

      if (!isNum(out.lineSnapPasses)) out.lineSnapPasses = 1;
      out.lineSnapPasses = Math.max(1, Math.floor(out.lineSnapPasses));

      out.lineSnapAcrossLayers = !!out.lineSnapAcrossLayers;

      if (!isNum(out.pass7CleanupCollinearDeg)) out.pass7CleanupCollinearDeg = 3.0;
      out.pass7CleanupCollinearDeg = Math.max(0, out.pass7CleanupCollinearDeg);

      if (!isNum(out.pass7CleanupMaxIters)) out.pass7CleanupMaxIters = 6;
      out.pass7CleanupMaxIters = Math.max(1, Math.floor(out.pass7CleanupMaxIters));

      // PASS 8 normalize
      out.pass8Enabled = !!out.pass8Enabled;
      out.pass8UseAutoFacetOnly = !!out.pass8UseAutoFacetOnly;
      out.pass8PreserveZ = !!out.pass8PreserveZ;
      out.pass8SkipDegreeLT2 = !!out.pass8SkipDegreeLT2;
      out.pass8Verbose = !!out.pass8Verbose;

      if (!isNum(out.pass8AngleSnapDegTol)) out.pass8AngleSnapDegTol = 10.0;
      out.pass8AngleSnapDegTol = Math.max(0.1, out.pass8AngleSnapDegTol);

      if (!isNum(out.pass8Epochs)) out.pass8Epochs = 140;
      out.pass8Epochs = Math.max(0, Math.floor(out.pass8Epochs));

      if (!isNum(out.pass8StepPx)) out.pass8StepPx = 0.9;
      out.pass8StepPx = Math.max(0.05, out.pass8StepPx);

      if (!isNum(out.pass8MaxMoveRadiusPx)) out.pass8MaxMoveRadiusPx = 10.0;
      out.pass8MaxMoveRadiusPx = Math.max(0, out.pass8MaxMoveRadiusPx);

      if (!isNum(out.pass8RandomEpochs)) out.pass8RandomEpochs = 60;
      out.pass8RandomEpochs = Math.max(0, Math.floor(out.pass8RandomEpochs));

      if (!isNum(out.pass8RandomWiggleAmpPx)) out.pass8RandomWiggleAmpPx = 1.6;
      out.pass8RandomWiggleAmpPx = Math.max(0, out.pass8RandomWiggleAmpPx);

      if (!isNum(out.pass8RandomTriesPerPoint)) out.pass8RandomTriesPerPoint = 1;
      out.pass8RandomTriesPerPoint = Math.max(1, Math.floor(out.pass8RandomTriesPerPoint));

      if (!isNum(out.pass8MaskPaddingPx)) out.pass8MaskPaddingPx = 0;
      out.pass8MaskPaddingPx = Math.max(0, Math.floor(out.pass8MaskPaddingPx));

      // NEW: outer-edge 90° rule knobs
      if (!isNum(out.pass8OuterShortMinLenPx)) out.pass8OuterShortMinLenPx = 20;
      out.pass8OuterShortMinLenPx = Math.max(0, out.pass8OuterShortMinLenPx);

      if (!isNum(out.pass8OuterEdgeProbePx)) out.pass8OuterEdgeProbePx = 1;
      out.pass8OuterEdgeProbePx = Math.max(1, Math.floor(out.pass8OuterEdgeProbePx));

      return out;
    }

    function readOptsFromUI() {
      const opts = {};
      for (const [k, el] of inputs.entries()) opts[k] = coerceValue(k, el.value);
      const normalized = normalizeOpts(opts);
      window[LAST_OPTS_KEY] = normalized;
      return normalized;
    }

    function syncUIFromOpts(opts) {
      for (const [k, el] of inputs.entries()) {
        if (BOOL_KEYS.has(k)) el.value = String(!!opts[k]);
        else el.value = String(fmt(opts[k]));
      }
    }

    function makeRow(key, value) {
      const row = document.createElement("div");
      row.style.cssText = `
        display:flex; align-items:center; gap: 10px;
        padding: 2px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
      `;

      const label = document.createElement("div");
      label.textContent = key;
      label.title = help[key] || "";
      label.style.cssText = `
        flex: 1;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.2px;
        color: rgba(255,255,255,0.90);
        cursor: ${help[key] ? "help" : "default"};
        user-select:none;
      `;

      const input = document.createElement("input");
      input.value = BOOL_KEYS.has(key) ? String(!!value) : String(fmt(value));
      input.title = help[key] || "";
      input.style.cssText = `
        width: 190px;
        padding: 3px 5px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.35);
        color: rgba(255,255,255,0.95);
        outline:none;
        font-size: 12px;
        font-weight: 900;
      `;

      input.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

        if (BOOL_KEYS.has(key)) {
          e.preventDefault();
          const cur = parseBool(input.value, false);
          input.value = String(!cur);
          return;
        }

        let step = 1;

        if (
          [
            "thresholdM",
            "thresholdEdgeM",
            "localWeight",
            "refinePitchStepDeg",
            "refineAzStepDeg",
            "edgeSimplifyEpsPx",
            "stage5SimplifyEpsPx",
            "mergeRadius3dM",
            "planeMergeOverlapPct",
            "planeMergeAngleDeg",
            "planeMergeHeightTolM",
            "collinearAlignDeg",
            "collinearAlignMinLenM",
            "lineSnapRadiusM",
            "pass7CleanupCollinearDeg",
            "pass8AngleSnapDegTol",
            "pass8StepPx",
            "pass8MaxMoveRadiusPx",
            "pass8RandomWiggleAmpPx",
          ].includes(key)
        )
          step = 0.01;

        if (
          [
            "circleSampleStepPx",
            "coarsePitchStepDeg",
            "coarseAzStepDeg",
            "refinePitchWindowDeg",
            "refineAzWindowDeg",
            "circleRadiusPx",
            "edgeMaxVertices",
            "stage5MaxVertices",
            "overlapCheckRadiusPx",
            "overlapCutRadiusPx",
            "overlapMaxIters",
            "tendrilMinCircleRadiusPx",
            "tendrilCoreErodeStepPx",
            "mergeGridCells",
            "planeMergeSampleStridePx",
            "lineSnapGridCells",
            "lineSnapPasses",
            "pass7CleanupMaxIters",
            "pass8Epochs",
            "pass8RandomEpochs",
            "pass8RandomTriesPerPoint",
            "pass8MaskPaddingPx",
            "pass8OuterShortMinLenPx",
            "pass8OuterEdgeProbePx",
          ].includes(key)
        )
          step = 1;

        if (
          [
            "globalSamples",
            "minFaceAreaPx2",
            "edgeMaxPixelsPerFace",
            "edgeContourMaxSteps",
            "overlapDebugMaxDots",
          ].includes(key)
        )
          step = 50;

        if (["publishLayer"].includes(key)) step = 1;

        if (e.shiftKey) step *= 10;
        if (e.altKey) step *= 0.1;

        const n = Number(input.value);
        if (!isFinite(n)) return;

        e.preventDefault();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        input.value = String(fmt(n + dir * step));
      });

      inputs.set(key, input);
      row.appendChild(label);
      row.appendChild(input);
      return row;
    }

    function buildFields() {
      fieldsWrap.innerHTML = "";
      inputs.clear();
      const base = window[LAST_OPTS_KEY] || readCurrentOptsFromPipelineOrDefaults();
      const opts = normalizeOpts(base);
      keys.forEach((k) => fieldsWrap.appendChild(makeRow(k, opts[k])));
      syncUIFromOpts(opts);
    }

    // ----- dots styling + PASS1 placement mode enforcement -----
    function enforcePlacementModeForPass() {
      const p = ensurePipeline();
      const pass = p ? p.pass || 0 : 0;

      if (typeof roofFacesCenterMode === "function") {
        try {
          roofFacesCenterMode(pass === 1);
        } catch (e) {}
      }
    }

    function updateDots() {
      const p = ensurePipeline();
      const pass = p ? p.pass || 0 : 0;

      dotBtns.forEach((b, idx) => {
        const n = idx + 1;
        const isActive = pass === n;
        const isDone = pass > n;
        b.style.background = isActive
          ? "rgba(255, 79, 216, 0.22)"
          : isDone
          ? "rgba(0, 255, 180, 0.16)"
          : "rgba(255,255,255,0.08)";
        b.style.borderColor = isActive
          ? "rgba(255, 79, 216, 0.55)"
          : isDone
          ? "rgba(0, 255, 180, 0.35)"
          : "rgba(255,255,255,0.18)";
      });

      enforcePlacementModeForPass();
    }

    // ----- face button grid -----
    function styleFaceBtn(btn, id) {
      const rOn = renderVis[id] === undefined ? true : !!renderVis[id];
      const algOff = !!disabled[id];

      btn.style.background = rOn ? "rgba(0,255,180,0.16)" : "rgba(255,255,255,0.06)";
      btn.style.border = `1px solid ${algOff ? "rgba(255, 107, 107, 0.85)" : "rgba(255,255,255,0.14)"}`;
      btn.style.color = rOn ? "rgba(230,255,248,0.95)" : "rgba(255,255,255,0.85)";
    }

    function getUniverseFaceIds() {
      const ids = getCurrentFaceIdList();
      return ids && ids.length ? ids : [];
    }

    function rebuildFaceButtons() {
      faceGrid.innerHTML = "";

      const ids = getUniverseFaceIds();
      faceCountLabel.textContent = `Faces: ${ids.length || 0} (manual:${getManualCenterCount()})`;

      if (!ids.length) {
        const empty = document.createElement("div");
        empty.style.cssText =
          "grid-column: 1 / -1; font-size: 11px; opacity: 0.75; padding: 6px 2px;";
        empty.textContent =
          "No face ids found yet (need segmentStats and/or manual centers).";
        faceGrid.appendChild(empty);
        return;
      }

      for (let idx = 0; idx < ids.length; idx++) {
        const id = ids[idx];

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = String(id);
        btn.title =
          "Click: toggle RENDER\n" +
          "Ctrl+Click: toggle ALGORITHM include/exclude\n" +
          "Shift+Click: solo render\n" +
          "Alt+Click: invert render";

        btn.style.cssText = `
          height: 28px;
          border-radius: 10px;
          cursor: pointer;
          font-weight: 900;
          font-size: 11px;
        `;
        styleFaceBtn(btn, id);

        btn.onclick = (e) => {
          if (e.ctrlKey || e.metaKey) {
            disabled[id] = !disabled[id];
            styleFaceBtn(btn, id);

            const p = ensurePipeline();
            const currentPass = p ? p.pass || 0 : 0;
            const opts = readOptsFromUI();

            console.log(
              "[DevControls] Toggle algo face id",
              id,
              "=>",
              disabled[id] ? "EXCLUDED" : "INCLUDED"
            );
            recomputeToPass(currentPass, opts);

            updateDots();
            rebuildFaceButtons();
            applyRenderVisibilityNow();
            return;
          }

          if (e.altKey) {
            for (const fid of getUniverseFaceIds()) {
              const cur = renderVis[fid] === undefined ? true : !!renderVis[fid];
              renderVis[fid] = !cur;
            }
            rebuildFaceButtons();
            applyRenderVisibilityNow();
            return;
          }

          if (e.shiftKey) {
            for (const fid of getUniverseFaceIds()) renderVis[fid] = false;
            renderVis[id] = true;
            rebuildFaceButtons();
            applyRenderVisibilityNow();
            return;
          }

          const cur = renderVis[id] === undefined ? true : !!renderVis[id];
          renderVis[id] = !cur;
          styleFaceBtn(btn, id);
          applyRenderVisibilityNow();
        };

        faceGrid.appendChild(btn);
      }

      applyRenderVisibilityNow();
    }

    btnShowAll.onclick = () => {
      for (const id of getUniverseFaceIds()) renderVis[id] = true;
      rebuildFaceButtons();
      applyRenderVisibilityNow();
    };

    btnHideAll.onclick = () => {
      for (const id of getUniverseFaceIds()) renderVis[id] = false;
      rebuildFaceButtons();
      applyRenderVisibilityNow();
    };

    btnEnableAllAlgo.onclick = () => {
      for (const id of getUniverseFaceIds()) disabled[id] = false;
      const p = ensurePipeline();
      const currentPass = p ? p.pass || 0 : 0;
      const opts = readOptsFromUI();
      recomputeToPass(currentPass, opts);
      updateDots();
      rebuildFaceButtons();
      applyRenderVisibilityNow();
    };

    btnDisableAllAlgo.onclick = () => {
      for (const id of getUniverseFaceIds()) disabled[id] = true;
      const p = ensurePipeline();
      const currentPass = p ? p.pass || 0 : 0;
      const opts = readOptsFromUI();
      recomputeToPass(currentPass, opts);
      updateDots();
      rebuildFaceButtons();
      applyRenderVisibilityNow();
    };

    refreshBtn.onclick = () => {
      const p = ensurePipeline();
      const currentPass = p ? p.pass || 0 : 0;
      const opts = readOptsFromUI();

      console.log("[DevControls] Refresh recompute pass", currentPass, {
        opts,
        disabled: Object.keys(disabled).filter((k) => disabled[k]).map(Number),
        manualCenters: getManualCenterCount(),
      });

      recomputeToPass(currentPass, opts);
      updateDots();
      rebuildFaceButtons();
      applyRenderVisibilityNow();

      const p2 = getPipeline();
      console.log("[DevControls] Pipeline opts now:", p2?.opts);
    };

    body.appendChild(note);
    body.appendChild(faceBox);
    body.appendChild(fieldsWrap);

    panel.appendChild(body);
    panel.appendChild(footer);

    document.body.appendChild(panel);

    const p = ensurePipeline();

    readManualCentersFromPipelineOrStore();
    if (p) {
      const mc = readManualCentersFromPipelineOrStore();
      writeManualCentersToPipeline(p, mc);
    }

    buildFields();
    updateDots();
    rebuildFaceButtons();
    enforcePlacementModeForPass();

    console.log(
      "%c[DevControls] Injected. Manual centers persist. PASS 1 forces center-placement mode ON. MAX_PASS=8.",
      "color:#00e8e8;font-weight:bold;"
    );
  }

  window.injectDevControls = injectDevControls;

  try {
    // injectDevControls();
  } catch (e) {
    console.warn("[DevControls] inject failed:", e);
  }
})();
