/* Holiday Lights: the measured roof at night with string lights along the edges an installer lights.
   Read-only and free. Everything comes from the report's model_data.xml (parsed by FirstMeasureRoofViewer):
   nobody enters anything in the editor. Which edges are lit, bulb spacing and colour are viewer choices with
   industry defaults (eaves and rakes, 12 in C9 spacing, warm white); nothing is saved. */
(function(){
  const t = (key, fallback, values) => globalThis.PlatformLanguage?.text('measurements', key, fallback, values) ?? fallback;
  // Edges an installer may light, in panel order. Eaves and rakes are the roofline; ridges and hips outline the peaks.
  const EDGES = [
    { type: 'EAVE', key: 'hl_edge_eaves', label: 'Eaves', hint: 'hl_edge_eaves_hint', hintText: 'Gutter line along the bottom of the roof', on: true },
    { type: 'RAKE', key: 'hl_edge_rakes', label: 'Rakes', hint: 'hl_edge_rakes_hint', hintText: 'Sloped gable edges', on: true },
    { type: 'RIDGE', key: 'hl_edge_ridges', label: 'Ridges', hint: 'hl_edge_ridges_hint', hintText: 'Peak lines along the top', on: false },
    { type: 'HIP', key: 'hl_edge_hips', label: 'Hips', hint: 'hl_edge_hips_hint', hintText: 'Sloped outside corners of hip roofs', on: false }
  ];
  const SPACINGS = [6, 8, 12, 15];
  const COLORS = [
    { id: 'warm', key: 'hl_color_warm', label: 'Warm white', bulbs: ['#ffd27a'] },
    { id: 'cool', key: 'hl_color_cool', label: 'Cool white', bulbs: ['#e6f1ff'] },
    { id: 'multi', key: 'hl_color_multi', label: 'Multicolor', bulbs: ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#ff9500'] },
    { id: 'redgreen', key: 'hl_color_redgreen', label: 'Red and green', bulbs: ['#ff3b30', '#30d158'] }
  ];
  const BULB_LIFT_FT = 0.25;

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
    if (document.getElementById('fm-holiday-lights-style')) return;
    const el = document.createElement('style');
    el.id = 'fm-holiday-lights-style';
    el.textContent = `
      .fm-hl-host{height:100%;container-type:inline-size}
      .fm-hl{height:100%;min-height:420px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;padding:12px;box-sizing:border-box;background:#f5f6f8}
      .fm-hl *{box-sizing:border-box}.fm-hl [hidden]{display:none!important}
      .fm-hl-stage{position:relative;min-width:0;min-height:320px;border-radius:12px;overflow:hidden;background:#0b1426;border:1px solid #1d2a44}
      .fm-hl.is-day .fm-hl-stage{background:#eef1f5;border-color:#e4e7ec}
      .fm-hl-canvas{position:absolute;inset:0}.fm-hl-canvas canvas{width:100%;height:100%;display:block;touch-action:none}
      .fm-hl-tools{position:absolute;left:12px;top:12px;display:flex;gap:6px;z-index:2}
      .fm-hl-tools button{font:inherit;font-size:12px;height:32px;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .fm-hl.is-day .fm-hl-tools button{background:#fff;border-color:#cbd5e1;color:#344054}
      .fm-hl-tools button:hover{background:rgba(255,255,255,.18)}.fm-hl.is-day .fm-hl-tools button:hover{background:#f2f4f7}
      .fm-hl-hint{position:absolute;left:12px;bottom:10px;font-size:11px;color:rgba(255,255,255,.62);pointer-events:none}
      .fm-hl.is-day .fm-hl-hint{color:#667085}
      .fm-hl-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:13px;color:rgba(255,255,255,.8)}
      .fm-hl.is-day .fm-hl-message{color:#475467}
      .fm-hl-panel{min-width:0;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px;overflow:auto;display:flex;flex-direction:column;gap:16px;color:#101828}
      .fm-hl-panel h3{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
      .fm-hl-panel h3 i{color:#d4a017}
      .fm-hl-total{display:flex;flex-direction:column;gap:2px;padding:14px;border-radius:10px;background:#fff8e6;border:1px solid #f5e1a4}
      .fm-hl-total strong{font-size:28px;line-height:1.1;font-weight:700;font-variant-numeric:tabular-nums}
      .fm-hl-total span{font-size:12px;color:#7a5b00}
      .fm-hl-section{display:flex;flex-direction:column;gap:6px}
      .fm-hl-section h4{margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .fm-hl-edge{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e4e7ec;border-radius:8px;cursor:pointer;font-size:13px}
      .fm-hl-edge:has(input:checked){border-color:#e3c35a;background:#fffbf0}
      .fm-hl-edge input{margin:0;width:16px;height:16px;accent-color:#b7860b}
      .fm-hl-edge small{display:block;font-size:11px;color:#667085;margin-top:1px}
      .fm-hl-edge b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
      .fm-hl-edge.is-empty{opacity:.55;cursor:default}
      .fm-hl-chips{display:flex;flex-wrap:wrap;gap:6px}
      .fm-hl-chips button{font:inherit;font-size:12px;height:30px;padding:0 10px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;color:#344054;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .fm-hl-chips button[aria-pressed=true]{background:#101828;border-color:#101828;color:#fff}
      .fm-hl-swatch{display:inline-flex;gap:2px}.fm-hl-swatch i{width:8px;height:8px;border-radius:50%;display:block;box-shadow:0 0 0 1px rgba(0,0,0,.12)}
      .fm-hl-counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
      .fm-hl-counts div{border:1px solid #e4e7ec;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
      .fm-hl-counts strong{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
      .fm-hl-counts span{font-size:11px;color:#667085}
      .fm-hl-note{margin:0;font-size:11px;line-height:1.45;color:#667085}
      @container (max-width:760px){.fm-hl{grid-template-columns:1fr;grid-template-rows:minmax(320px,56vh) auto;height:auto}.fm-hl-panel{overflow:visible}}
    `;
    document.head.append(el);
  }

  const feet = (value) => `${Math.round(value).toLocaleString()} ft`;
  const count = (value) => Math.round(value).toLocaleString();

  function mount(root, { xmlUrl } = {}){
    injectStyle();
    let disposed = false, renderer, scene, camera, controls, observer, hemi, sun, roofMaterial, bulbGroup;
    let night = true, spacingIn = 12, colorId = 'warm';
    const enabled = Object.fromEntries(EDGES.map((edge) => [edge.type, edge.on]));
    const controller = new AbortController();
    const owned = [];
    const own = (object) => { owned.push(object); return object; };
    // Edges by type in feet: [{a:[x,y,z], b:[x,y,z], length, ids:[pointKey, pointKey]}]
    const edges = Object.fromEntries(EDGES.map((edge) => [edge.type, []]));
    let point = null;

    root.innerHTML = `<div class="fm-hl-host">
      <div class="fm-hl">
        <div class="fm-hl-stage">
          <div class="fm-hl-canvas"></div>
          <div class="fm-hl-tools">
            <button type="button" data-hl-night aria-pressed="true"></button>
            <button type="button" data-hl-reset></button>
          </div>
          <div class="fm-hl-hint"></div>
          <div class="fm-hl-message" role="status"></div>
        </div>
        <aside class="fm-hl-panel" aria-label="${t('hl_panel_label', 'Holiday lights')}">
          <h3><i class="fa-solid fa-lightbulb" aria-hidden="true"></i><span></span></h3>
          <div class="fm-hl-total"><strong data-hl-total>—</strong><span data-hl-total-label></span></div>
          <div class="fm-hl-section" data-hl-edges><h4></h4></div>
          <div class="fm-hl-section"><h4 data-hl-counts-title></h4><div class="fm-hl-counts" data-hl-counts></div></div>
          <div class="fm-hl-section"><h4 data-hl-spacing-title></h4><div class="fm-hl-chips" data-hl-spacing></div></div>
          <div class="fm-hl-section"><h4 data-hl-color-title></h4><div class="fm-hl-chips" data-hl-colors></div></div>
          <p class="fm-hl-note"></p>
        </aside>
      </div></div>`;
    const shell = root.querySelector('.fm-hl');
    const canvasHost = root.querySelector('.fm-hl-canvas');
    const message = root.querySelector('.fm-hl-message');
    const nightButton = root.querySelector('[data-hl-night]');
    const resetButton = root.querySelector('[data-hl-reset]');
    root.querySelector('.fm-hl-panel h3 span').textContent = t('hl_title', 'Holiday Lights');
    root.querySelector('[data-hl-total-label]').textContent = t('hl_total_label', 'of lights along the lit edges');
    root.querySelector('[data-hl-edges] h4').textContent = t('hl_edges_title', 'Edges to light');
    root.querySelector('[data-hl-counts-title]').textContent = t('hl_counts_title', 'Estimate');
    root.querySelector('[data-hl-spacing-title]').textContent = t('hl_spacing_title', 'Bulb spacing');
    root.querySelector('[data-hl-color-title]').textContent = t('hl_color_title', 'Light color');
    root.querySelector('.fm-hl-note').textContent = t('hl_note', 'Lengths are measured along each roof edge from the report. Add cord to reach power; clips assume one per bulb.');
    const touch = matchMedia?.('(hover: none)').matches;
    root.querySelector('.fm-hl-hint').textContent = touch ? t('hl_hint_touch', 'Drag to orbit · Pinch to zoom') : t('hl_hint', 'Drag to orbit · Scroll to zoom · Right-drag to pan');
    resetButton.innerHTML = `<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>${t('hl_reset', 'Reset view')}`;
    function renderNightButton(){
      nightButton.innerHTML = night
        ? `<i class="fa-solid fa-sun" aria-hidden="true"></i>${t('hl_day', 'Day view')}`
        : `<i class="fa-solid fa-moon" aria-hidden="true"></i>${t('hl_night', 'Night view')}`;
      nightButton.setAttribute('aria-pressed', String(night));
      shell.classList.toggle('is-day', !night);
    }
    renderNightButton();
    message.textContent = t('hl_loading', 'Loading the roof…');

    function lengthOf(type){ return edges[type].reduce((sum, edge) => sum + edge.length, 0); }
    function litEdges(){ return EDGES.filter((edge) => enabled[edge.type]).flatMap((edge) => edges[edge.type]); }
    // Connected stretches of lit edges: each is one continuous string an installer runs.
    function runCount(list){
      const parent = new Map();
      const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
      for (const edge of list) for (const key of edge.ids) if (!parent.has(key)) parent.set(key, key);
      for (const edge of list) parent.set(find(edge.ids[0]), find(edge.ids[1]));
      return new Set(list.map((edge) => find(edge.ids[0]))).size;
    }
    // Bulbs sit mid-spacing along each edge, so edges that meet at a corner never stack two bulbs there.
    function bulbsOn(edge){ return Math.max(1, Math.round(edge.length * 12 / spacingIn)); }

    function renderPanel(){
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
      const spacingHost = root.querySelector('[data-hl-spacing]');
      spacingHost.replaceChildren(...SPACINGS.map((inches) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = t('hl_spacing_inches', `${inches} in`, { inches });
        button.setAttribute('aria-pressed', String(inches === spacingIn));
        button.onclick = () => { spacingIn = inches; update(); };
        return button;
      }));
      const colorHost = root.querySelector('[data-hl-colors]');
      colorHost.replaceChildren(...COLORS.map((color) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(color.id === colorId));
        const swatch = document.createElement('span');
        swatch.className = 'fm-hl-swatch';
        for (const hex of color.bulbs.slice(0, 3)) { const dot = document.createElement('i'); dot.style.background = hex; swatch.append(dot); }
        button.append(swatch, document.createTextNode(t(color.key, color.label)));
        button.onclick = () => { colorId = color.id; update(); };
        return button;
      }));
    }

    function renderTotals(){
      const list = litEdges();
      const total = list.reduce((sum, edge) => sum + edge.length, 0);
      const bulbs = list.reduce((sum, edge) => sum + bulbsOn(edge), 0);
      root.querySelector('[data-hl-total]').textContent = feet(total);
      const counts = [
        [count(bulbs), t('hl_bulbs', 'Bulbs')],
        [count(bulbs), t('hl_clips', 'Clips')],
        [count(runCount(list)), t('hl_runs', 'Runs')]
      ];
      root.querySelector('[data-hl-counts]').replaceChildren(...counts.map(([value, label]) => {
        const cell = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = list.length ? value : '0';
        const span = document.createElement('span');
        span.textContent = label;
        cell.append(strong, span);
        return cell;
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

    function glowTexture(T){
      const size = 64, c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d'), g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(255,255,255,.75)');
      g.addColorStop(0.45, 'rgba(255,255,255,.18)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return own(new T.CanvasTexture(c));
    }
    // A solid round bulb for the cores: the glow gradient alone leaves only a few pixels above the alpha test.
    function discTexture(T){
      const size = 64, c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      return own(new T.CanvasTexture(c));
    }
    let glowMap = null, discMap = null;
    function buildBulbs(){
      const T = window.THREE;
      if (bulbGroup) { scene.remove(bulbGroup); bulbGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
      bulbGroup = new T.Group();
      scene.add(bulbGroup);
      const palette = COLORS.find((color) => color.id === colorId).bulbs.map((hex) => new T.Color(hex));
      const positions = [], colors = [], wire = [];
      let n = 0;
      for (const edge of litEdges()) {
        const a = point(edge.a), b = point(edge.b);
        a.y += BULB_LIFT_FT * scale; b.y += BULB_LIFT_FT * scale;
        wire.push(a, b);
        const bulbs = bulbsOn(edge);
        for (let i = 0; i < bulbs; i++) {
          const along = (i + 0.5) / bulbs;
          const p = a.clone().lerp(b, along);
          positions.push(p.x, p.y, p.z);
          const color = palette[n++ % palette.length];
          colors.push(color.r, color.g, color.b);
        }
      }
      if (!positions.length) { draw(); return; }
      const wireGeo = new T.BufferGeometry().setFromPoints(wire);
      bulbGroup.add(new T.LineSegments(wireGeo, new T.LineBasicMaterial({ color: night ? '#1f3d2a' : '#2f4f3a' })));
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
      // Bulb cores: small, bright, depth-tested so the far side of the roof hides them.
      bulbGroup.add(new T.Points(geo, new T.PointsMaterial({ size: (night ? 0.7 : 1) * scale, sizeAttenuation: true, vertexColors: true, map: discMap, transparent: true, alphaTest: 0.5 })));
      // Glow halo: additive, only at night.
      if (night) {
        const halo = new T.Points(geo.clone(), new T.PointsMaterial({ size: 4.2 * scale, sizeAttenuation: true, vertexColors: true, map: glowMap, transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending }));
        bulbGroup.add(halo);
      }
      draw();
    }
    function applyLighting(){
      if (!scene) return;
      scene.background = new window.THREE.Color(night ? '#0b1426' : '#eef1f5');
      hemi.intensity = night ? 0.5 : 0.85;
      hemi.color.set(night ? '#8fa6d6' : '#ffffff');
      sun.intensity = night ? 0.22 : 0.5;
      roofMaterial.color.set(night ? '#6a6d78' : '#77756f');
    }
    function update(){ renderPanel(); renderTotals(); if (scene) { applyLighting(); buildBulbs(); } }

    nightButton.onclick = () => { night = !night; renderNightButton(); update(); };
    resetButton.onclick = reset;

    let scale = 1;
    (async () => {
      if (!xmlUrl) throw new Error(t('hl_no_model', 'This report has no saved roof geometry yet.'));
      const viewer = window.FirstMeasureRoofViewer;
      if (!viewer?.parseModel) throw new Error(t('hl_library_error', 'The 3D viewer library could not load.'));
      const [response] = await Promise.all([fetch(xmlUrl, { credentials: 'same-origin', signal: controller.signal }), loadLibraries()]);
      if (!response.ok) throw new Error(t('hl_model_error', 'The roof model could not be loaded.'));
      const roofs = viewer.parseModel(await response.text());
      if (disposed) return;
      const T = window.THREE;
      for (const [r, roof] of roofs.entries()) {
        for (const line of roof.lines.values()) {
          if (!edges[line.type]) continue;
          const [a, b] = line.ids.map((id) => roof.points.get(id));
          const length = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (length > 0.01) edges[line.type].push({ a, b, length, ids: line.ids.map((id) => `${r}:${id}`) });
        }
      }
      const all = roofs.flatMap((roof) => [...roof.points.values()]);
      const min = [0, 1, 2].map((i) => Math.min(...all.map((p) => p[i])));
      const max = [0, 1, 2].map((i) => Math.max(...all.map((p) => p[i])));
      scale = 100 / Math.max(...max.map((v, i) => v - min[i]), 1);
      // XML feet (x east, y north, z up) to scene units (y up), centred, the same frame as roof-viewer.js.
      point = (p) => new T.Vector3((p[0] - (min[0] + max[0]) / 2) * scale, (p[2] - (min[2] + max[2]) / 2) * scale, -(p[1] - (min[1] + max[1]) / 2) * scale);

      scene = new T.Scene();
      camera = new T.PerspectiveCamera(40, 1, 1, 3000);
      renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      canvasHost.append(renderer.domElement);
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.minDistance = 4;
      controls.addEventListener('change', draw);
      hemi = new T.HemisphereLight(0xffffff, 0x283044, 0.8);
      sun = new T.DirectionalLight(0xffffff, 0.5);
      sun.position.set(30, 80, 40);
      scene.add(hemi, sun);
      glowMap = glowTexture(T);
      discMap = discTexture(T);

      roofMaterial = own(new T.MeshStandardMaterial({ color: '#5d5f66', side: T.DoubleSide, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      const roofGroup = new T.Group();
      for (const roof of roofs) {
        for (const face of roof.faces) {
          const rings = [face.points, ...face.holes], flat = rings.flat();
          const project = (ring) => ring.map((p) => new T.Vector2(p[0], p[1]));
          const triangles = T.ShapeUtils.triangulateShape(project(face.points), face.holes.map(project));
          const positions = [];
          for (const tri of triangles) for (const i of tri) positions.push(...point(flat[i]).toArray());
          const geo = own(new T.BufferGeometry());
          geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
          geo.computeVertexNormals();
          roofGroup.add(new T.Mesh(geo, roofMaterial));
        }
        // Every roof edge as a faint line so unlit edges still read.
        const outline = [];
        for (const line of roof.lines.values()) outline.push(...line.ids.map((id) => point(roof.points.get(id))));
        const outlineGeo = own(new T.BufferGeometry().setFromPoints(outline));
        roofGroup.add(new T.LineSegments(outlineGeo, own(new T.LineBasicMaterial({ color: '#9aa4b2', transparent: true, opacity: 0.35 }))));
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
      renderPanel();
      renderTotals();
    });
    renderPanel();
    renderTotals();

    return {
      destroy(){
        disposed = true;
        controller.abort();
        observer?.disconnect();
        controls?.dispose();
        if (bulbGroup) bulbGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
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
