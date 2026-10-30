/* Holiday Lights: the measured roof with string lights along the edges an installer lights, matching the report's
   Holiday Lights page (measure/internal/editor_scripts/pdf.js drawHolidayLightsPage). Read-only and free. Everything
   comes from the report's model_data.xml (parsed by FirstMeasureRoofViewer): nobody enters anything in the editor.
   Eaves and rakes are lit; ridges and hips can be added. Each separate run has its own colour and number, bulbs
   alternate red and green, and bulbs and clips are counted at common spacings. Nothing is saved. */
(function(){
  const t = (key, fallback, values) => globalThis.PlatformLanguage?.text('measurements', key, fallback, values) ?? fallback;
  // Edges an installer may light, in panel order. Eaves and rakes are the roofline; ridges and hips outline the peaks.
  const EDGES = [
    { type: 'EAVE', key: 'hl_edge_eaves', label: 'Eaves', hint: 'hl_edge_eaves_where', hintText: 'Bottom edge, where gutters hang', on: true },
    { type: 'RAKE', key: 'hl_edge_rakes', label: 'Rakes', hint: 'hl_edge_rakes_where', hintText: 'Sloped edge of a gable', on: true },
    { type: 'RIDGE', key: 'hl_edge_ridges', label: 'Ridges', hint: 'hl_edge_ridges_optional', hintText: 'Optional: outlines the peaks', on: false },
    { type: 'HIP', key: 'hl_edge_hips', label: 'Hips', hint: 'hl_edge_hips_optional', hintText: 'Optional: sloped corners of hip roofs', on: false }
  ];
  // Same spacings, bulb colours and run colours as the report page.
  const SPACINGS = [6, 8, 12, 15, 18];
  const STANDARD_SPACING = 12;
  const BULB_RED = '#d93025', BULB_GREEN = '#188038';
  const RUN_COLORS = ['#1a73e8', '#f29900', '#9334e6', '#12b5cb', '#e52592', '#795548', '#3949ab', '#5f6368'];
  const LIFT_FT = 0.2;

  let libraries;
  function script(src){
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { el.remove(); reject(new Error(t('hl_library_error', 'The 3D viewer library could not load.'))); };
      document.head.append(el);
    });
  }
  // Same builds as roof-viewer.js, so a page that opened the Model tab first loads nothing again.
  function loadLibraries(){
    return libraries ||= (async () => {
      if (!window.THREE) await script('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
      if (!window.THREE.OrbitControls) await script('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
    })().catch((error) => { libraries = null; throw error; });
  }

  function injectStyle(){
    if (document.getElementById('fm-holiday-lights-style-v2')) return;
    document.getElementById('fm-holiday-lights-style')?.remove();
    const el = document.createElement('style');
    el.id = 'fm-holiday-lights-style-v2';
    el.textContent = `
      .fm-hl-host{height:100%;container-type:inline-size}
      .fm-hl{height:100%;min-height:420px;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;padding:12px;box-sizing:border-box;background:#f5f6f8}
      .fm-hl *{box-sizing:border-box}.fm-hl [hidden]{display:none!important}
      .fm-hl-stage{position:relative;min-width:0;min-height:320px;border-radius:12px;overflow:hidden;background:#fff;border:1px solid #e4e7ec}
      .fm-hl-canvas{position:absolute;inset:0}.fm-hl-canvas canvas{width:100%;height:100%;display:block;touch-action:none}
      .fm-hl-tools{position:absolute;left:12px;top:12px;display:flex;gap:6px;z-index:2}
      .fm-hl-tools button{font:inherit;font-size:12px;height:32px;padding:0 12px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#344054;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .fm-hl-tools button:hover{background:#f2f4f7}
      .fm-hl-legend{position:absolute;right:12px;top:12px;display:flex;gap:6px;align-items:center;font-size:11px;color:#475467;background:rgba(255,255,255,.92);border:1px solid #e4e7ec;border-radius:8px;padding:6px 10px;z-index:2}
      .fm-hl-legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
      .fm-hl-hint{position:absolute;left:12px;bottom:10px;font-size:11px;color:#667085;pointer-events:none}
      .fm-hl-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:13px;color:#475467}
      .fm-hl-panel{min-width:0;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px;overflow:auto;display:flex;flex-direction:column;gap:16px;color:#101828}
      .fm-hl-panel h3{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
      .fm-hl-panel h3 i{color:#d93025}
      .fm-hl-total{display:flex;flex-direction:column;gap:2px;padding:14px;border-radius:10px;background:#f8fafc;border:1px solid #e4e7ec}
      .fm-hl-total strong{font-size:28px;line-height:1.1;font-weight:700;font-variant-numeric:tabular-nums}
      .fm-hl-total span{font-size:12px;color:#475467}
      .fm-hl-section{display:flex;flex-direction:column;gap:6px}
      .fm-hl-section h4{margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .fm-hl-edge{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e4e7ec;border-radius:8px;cursor:pointer;font-size:13px}
      .fm-hl-edge:has(input:checked){border-color:#98a2b3;background:#f9fafb}
      .fm-hl-edge input{margin:0;width:16px;height:16px;accent-color:#344054}
      .fm-hl-edge small{display:block;font-size:11px;color:#667085;margin-top:1px}
      .fm-hl-edge b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
      .fm-hl-edge.is-empty{opacity:.55;cursor:default}
      .fm-hl-run{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;font-size:13px;padding:3px 2px}
      .fm-hl-run i{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-style:normal;font-size:11px;font-weight:700}
      .fm-hl-run b{font-weight:600;font-variant-numeric:tabular-nums}
      .fm-hl-empty{font-size:12px;color:#667085}
      .fm-hl-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
      .fm-hl-table th{font-size:11px;font-weight:600;color:#667085;text-align:right;padding:4px 6px;border-bottom:1px solid #e4e7ec}
      .fm-hl-table th:first-child,.fm-hl-table td:first-child{text-align:left}
      .fm-hl-table td{text-align:right;padding:6px;border-bottom:1px solid #f2f4f7}
      .fm-hl-table tr.is-standard td{font-weight:700;color:#b42318}
      .fm-hl-note{margin:0;font-size:11px;line-height:1.45;color:#667085}
      @container (max-width:760px){.fm-hl{grid-template-columns:1fr;grid-template-rows:minmax(320px,56vh) auto;height:auto}.fm-hl-panel{overflow:visible}}
    `;
    document.head.append(el);
  }

  const feet = (value) => t('hl_feet', `${Math.round(value).toLocaleString()} ft`, { value: Math.round(value) });
  const bulbsOn = (length, inches) => Math.max(1, Math.round(length * 12 / inches));

  function mount(root, { xmlUrl } = {}){
    injectStyle();
    let disposed = false, renderer, scene, camera, controls, observer, runGroup, scale = 1, point = null, discMap = null;
    const enabled = Object.fromEntries(EDGES.map((edge) => [edge.type, edge.on]));
    const controller = new AbortController();
    const owned = [];
    const own = (object) => { owned.push(object); return object; };
    // Edges by type, in feet: [{a:[x,y,z], b:[x,y,z], length, keys:[pointKey, pointKey]}]
    const edges = Object.fromEntries(EDGES.map((edge) => [edge.type, []]));

    root.innerHTML = `<div class="fm-hl-host">
      <div class="fm-hl">
        <div class="fm-hl-stage">
          <div class="fm-hl-canvas"></div>
          <div class="fm-hl-tools"><button type="button" data-hl-reset></button></div>
          <div class="fm-hl-legend"><i style="background:${BULB_RED}"></i><i style="background:${BULB_GREEN}"></i><span data-hl-legend></span></div>
          <div class="fm-hl-hint"></div>
          <div class="fm-hl-message" role="status"></div>
        </div>
        <aside class="fm-hl-panel">
          <h3><i class="fa-solid fa-lightbulb" aria-hidden="true"></i><span></span></h3>
          <div class="fm-hl-total"><strong data-hl-total>—</strong><span data-hl-total-label></span></div>
          <div class="fm-hl-section" data-hl-edges><h4></h4></div>
          <div class="fm-hl-section"><h4 data-hl-runs-title></h4><div data-hl-runs></div></div>
          <div class="fm-hl-section"><h4 data-hl-spacing-title></h4><table class="fm-hl-table"><thead><tr><th></th><th></th><th></th></tr></thead><tbody data-hl-spacing></tbody></table></div>
          <p class="fm-hl-note"></p>
        </aside>
      </div></div>`;
    const canvasHost = root.querySelector('.fm-hl-canvas');
    const message = root.querySelector('.fm-hl-message');
    const resetButton = root.querySelector('[data-hl-reset]');
    root.querySelector('.fm-hl-panel').setAttribute('aria-label', t('hl_panel_label', 'Holiday lights'));
    root.querySelector('.fm-hl-panel h3 span').textContent = t('hl_title', 'Holiday Lights');
    root.querySelector('[data-hl-legend]').textContent = t('hl_legend_runs', 'Bulbs · each coloured line is one run');
    root.querySelector('[data-hl-edges] h4').textContent = t('hl_edges_title', 'Edges to light');
    root.querySelector('[data-hl-runs-title]').textContent = t('hl_runs_title', 'Separate runs');
    root.querySelector('[data-hl-spacing-title]').textContent = t('hl_spacing_table_title', 'Bulbs and clips by spacing');
    const heads = root.querySelectorAll('.fm-hl-table th');
    heads[0].textContent = t('hl_col_spacing', 'Spacing');
    heads[1].textContent = t('hl_col_bulbs', 'Bulbs');
    heads[2].textContent = t('hl_col_clips', 'Clips');
    root.querySelector('.fm-hl-note').textContent = t('hl_note_runs', 'Lengths are measured along each roof edge from the report. A run is one unbroken string, and each needs its own power. Clips: one per bulb.');
    const touch = matchMedia?.('(hover: none)').matches;
    root.querySelector('.fm-hl-hint').textContent = touch ? t('hl_hint_touch', 'Drag to orbit · Pinch to zoom') : t('hl_hint', 'Drag to orbit · Scroll to zoom · Right-drag to pan');
    resetButton.innerHTML = `<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>${t('hl_reset', 'Reset view')}`;
    message.textContent = t('hl_loading', 'Loading the roof…');

    function lengthOf(type){ return edges[type].reduce((sum, edge) => sum + edge.length, 0); }
    function litEdges(){ return EDGES.filter((edge) => enabled[edge.type]).flatMap((edge) => edges[edge.type]); }
    // Runs: connected stretches of lit edges, each one continuous string, longest first, coloured like the report.
    function buildRuns(){
      const list = litEdges();
      const parent = new Map();
      const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
      for (const edge of list) for (const key of edge.keys) if (!parent.has(key)) parent.set(key, key);
      for (const edge of list) parent.set(find(edge.keys[0]), find(edge.keys[1]));
      const groups = new Map();
      for (const edge of list) { const key = find(edge.keys[0]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(edge); }
      return [...groups.values()]
        .map((group) => ({ edges: group, length: group.reduce((sum, edge) => sum + edge.length, 0) }))
        .sort((p, q) => q.length - p.length)
        .map((run, index) => ({ ...run, number: index + 1, color: RUN_COLORS[index % RUN_COLORS.length] }));
    }

    function renderPanel(runs){
      const host = root.querySelector('[data-hl-edges]');
      host.querySelectorAll('.fm-hl-edge').forEach((row) => row.remove());
      for (const edge of EDGES) {
        const length = lengthOf(edge.type);
        const row = document.createElement('label');
        row.className = 'fm-hl-edge' + (length ? '' : ' is-empty');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!enabled[edge.type] && length > 0;
        input.disabled = !length;
        input.onchange = () => { enabled[edge.type] = input.checked; update(); };
        const text = document.createElement('span');
        text.textContent = t(edge.key, edge.label);
        const small = document.createElement('small');
        small.textContent = length ? t(edge.hint, edge.hintText) : t('hl_edge_none', 'None on this roof');
        text.append(small);
        const value = document.createElement('b');
        value.textContent = length ? feet(length) : '—';
        row.append(input, text, value);
        host.append(row);
      }
      const total = runs.reduce((sum, run) => sum + run.length, 0);
      root.querySelector('[data-hl-total]').textContent = feet(total);
      root.querySelector('[data-hl-total-label]').textContent = runs.length === 1
        ? t('hl_total_one_run', 'of lights in 1 run')
        : t('hl_total_runs', `of lights in ${runs.length} separate runs`, { count: runs.length });
      const runRows = runs.map((run) => {
        const row = document.createElement('div');
        row.className = 'fm-hl-run';
        const badge = document.createElement('i');
        badge.style.background = run.color;
        badge.textContent = String(run.number);
        const name = document.createElement('span');
        name.textContent = t('hl_run_name', `Run ${run.number}`, { number: run.number });
        const value = document.createElement('b');
        value.textContent = feet(run.length);
        row.append(badge, name, value);
        return row;
      });
      if (!runRows.length) {
        const empty = document.createElement('div');
        empty.className = 'fm-hl-empty';
        empty.textContent = t('hl_runs_none', 'No edges are lit.');
        runRows.push(empty);
      }
      root.querySelector('[data-hl-runs]').replaceChildren(...runRows);
      const lit = runs.flatMap((run) => run.edges);
      root.querySelector('[data-hl-spacing]').replaceChildren(...SPACINGS.map((inches) => {
        const bulbs = lit.reduce((sum, edge) => sum + bulbsOn(edge.length, inches), 0);
        const row = document.createElement('tr');
        if (inches === STANDARD_SPACING) row.className = 'is-standard';
        for (const text of [t('hl_spacing_inches', `${inches} in`, { inches }), bulbs.toLocaleString(), bulbs.toLocaleString()]) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        return row;
      }));
    }

    function draw(){ if (!disposed && renderer) renderer.render(scene, camera); }
    function reset(){
      if (!camera) return;
      const aspect = canvasHost.clientWidth && canvasHost.clientHeight ? canvasHost.clientWidth / canvasHost.clientHeight : 1;
      camera.position.set(1, 0.8, 1.3).normalize().multiplyScalar(140 * Math.max(1, 1 / aspect));
      controls.target.set(0, 0, 0);
      controls.update();
      draw();
    }
    function resize(){
      if (!renderer) return;
      const width = canvasHost.clientWidth || 1, height = canvasHost.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    }

    function discTexture(T){
      const size = 64, c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); ctx.fill();
      return own(new T.CanvasTexture(c));
    }
    function badgeTexture(T, color, number){
      const size = 96, c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '700 46px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(number), size / 2, size / 2 + 2);
      return new T.CanvasTexture(c);
    }
    function disposeRuns(){
      if (!runGroup) return;
      scene.remove(runGroup);
      runGroup.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) { if (o.material.map && o.material.map !== discMap) o.material.map.dispose(); o.material.dispose(); }
      });
      runGroup = null;
    }
    // Each run is a tube in its colour with red and green bulbs at the standard spacing and its number above it.
    function buildRunScene(runs){
      const T = window.THREE;
      disposeRuns();
      runGroup = new T.Group();
      scene.add(runGroup);
      const red = new T.Color(BULB_RED), green = new T.Color(BULB_GREEN);
      const positions = [], colors = [];
      let n = 0;
      for (const run of runs) {
        const material = new T.MeshBasicMaterial({ color: run.color });
        for (const edge of run.edges) {
          const a = point(edge.a), b = point(edge.b);
          a.y += LIFT_FT * scale; b.y += LIFT_FT * scale;
          runGroup.add(new T.Mesh(new T.TubeGeometry(new T.LineCurve3(a, b), 1, 0.16 * scale, 6, false), material));
          const count = bulbsOn(edge.length, STANDARD_SPACING);
          for (let i = 0; i < count; i++) {
            const p = a.clone().lerp(b, (i + 0.5) / count);
            positions.push(p.x, p.y + 0.45 * scale, p.z);
            const color = n++ % 2 ? green : red;
            colors.push(color.r, color.g, color.b);
          }
        }
        const longest = run.edges.reduce((best, edge) => (!best || edge.length > best.length ? edge : best), null);
        const badge = new T.Sprite(new T.SpriteMaterial({ map: badgeTexture(T, run.color, run.number), depthTest: false }));
        const mid = point(longest.a).lerp(point(longest.b), 0.5);
        badge.position.set(mid.x, mid.y + 2.2 * scale, mid.z);
        badge.scale.setScalar(3.2 * scale);
        badge.renderOrder = 5;
        runGroup.add(badge);
      }
      if (positions.length) {
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        geo.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
        runGroup.add(new T.Points(geo, new T.PointsMaterial({ size: 1.15 * scale, sizeAttenuation: true, vertexColors: true, map: discMap, transparent: true, alphaTest: 0.5 })));
      }
      draw();
    }
    function update(){ const runs = buildRuns(); renderPanel(runs); if (scene) buildRunScene(runs); }

    resetButton.onclick = reset;

    (async () => {
      if (!xmlUrl) throw new Error(t('hl_no_model', 'This report has no saved roof geometry yet.'));
      const viewer = window.FirstMeasureRoofViewer;
      if (!viewer?.parseModel) throw new Error(t('hl_library_error', 'The 3D viewer library could not load.'));
      const [response] = await Promise.all([fetch(xmlUrl, { credentials: 'same-origin', signal: controller.signal }), loadLibraries()]);
      if (!response.ok) throw new Error(t('hl_model_error', 'The roof model could not be loaded.'));
      const roofs = viewer.parseModel(await response.text());
      if (disposed) return;
      const T = window.THREE;
      // A line shared by two structures is counted once.
      const seen = new Set();
      for (const [r, roof] of roofs.entries()) {
        for (const line of roof.lines.values()) {
          if (!edges[line.type]) continue;
          const [a, b] = line.ids.map((id) => roof.points.get(id));
          const key = [a, b].map((p) => p.map((v) => v.toFixed(2)).join(',')).sort().join('|');
          const length = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (seen.has(key) || !(length > 0.01)) continue;
          seen.add(key);
          edges[line.type].push({ a, b, length, keys: line.ids.map((id) => `${r}:${id}`) });
        }
      }
      const all = roofs.flatMap((roof) => [...roof.points.values()]);
      const min = [0, 1, 2].map((i) => Math.min(...all.map((p) => p[i])));
      const max = [0, 1, 2].map((i) => Math.max(...all.map((p) => p[i])));
      scale = 100 / Math.max(...max.map((v, i) => v - min[i]), 1);
      // XML feet (x east, y north, z up) to scene units (y up), centred, the same frame as roof-viewer.js.
      point = (p) => new T.Vector3((p[0] - (min[0] + max[0]) / 2) * scale, (p[2] - (min[2] + max[2]) / 2) * scale, -(p[1] - (min[1] + max[1]) / 2) * scale);

      scene = new T.Scene();
      scene.background = new T.Color('#f8fafc');
      camera = new T.PerspectiveCamera(40, 1, 1, 3000);
      renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      canvasHost.append(renderer.domElement);
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.minDistance = 4;
      controls.addEventListener('change', draw);
      const sun = new T.DirectionalLight(0xffffff, 0.3);
      sun.position.set(30, 80, 40);
      scene.add(new T.HemisphereLight(0xffffff, 0x8a93a3, 0.55), sun);
      discMap = discTexture(T);

      const roofMaterial = own(new T.MeshStandardMaterial({ color: '#c9cfd8', side: T.DoubleSide, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      const roofGroup = new T.Group();
      for (const roof of roofs) {
        for (const face of roof.faces) {
          const flat = [face.points, ...face.holes].flat();
          const project = (ring) => ring.map((p) => new T.Vector2(p[0], p[1]));
          const triangles = T.ShapeUtils.triangulateShape(project(face.points), face.holes.map(project));
          const positions = [];
          for (const tri of triangles) for (const i of tri) positions.push(...point(flat[i]).toArray());
          const geo = own(new T.BufferGeometry());
          geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
          geo.computeVertexNormals();
          roofGroup.add(new T.Mesh(geo, roofMaterial));
        }
        // Every roof edge as a thin line so unlit edges still read.
        const outline = [];
        for (const line of roof.lines.values()) outline.push(...line.ids.map((id) => point(roof.points.get(id))));
        roofGroup.add(new T.LineSegments(own(new T.BufferGeometry().setFromPoints(outline)), own(new T.LineBasicMaterial({ color: '#98a2b3' }))));
      }
      scene.add(roofGroup);

      // Eaves and rakes are on by default; a roof without one starts with what it has.
      if (!lengthOf('EAVE') && !lengthOf('RAKE')) for (const edge of EDGES) enabled[edge.type] = lengthOf(edge.type) > 0;
      message.hidden = true;
      observer = new ResizeObserver(resize);
      observer.observe(canvasHost);
      resize();
      reset();
      update();
    })().catch((error) => {
      if (disposed || error?.name === 'AbortError') return;
      message.hidden = false;
      message.textContent = error?.message || t('hl_model_error', 'The roof model could not be loaded.');
      renderPanel([]);
    });
    renderPanel([]);

    return {
      destroy(){
        disposed = true;
        controller.abort();
        observer?.disconnect();
        controls?.dispose();
        if (scene) disposeRuns();
        scene?.traverse((o) => { o.geometry?.dispose?.(); });
        owned.forEach((object) => object.dispose?.());
        renderer?.dispose();
        renderer?.domElement?.remove();
        root.innerHTML = '';
      }
    };
  }

  window.FirstMeasureHolidayLights = { mount };
})();
