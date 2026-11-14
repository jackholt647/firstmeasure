/* Holiday Lights: the measured roof with string lights along the edges an installer lights, matching the report's
   Holiday Lights page (measure/internal/editor_scripts/pdf.js drawHolidayLightsPage). Read-only and free. Everything
   comes from the report's model_data.xml (parsed by FirstMeasureRoofViewer): nobody enters anything in the editor.
   Eaves and rakes are lit; ridges and hips can be added. Lights are counted by side of the house and, on a side with
   more than one roofline, by roofline (lower, middle, upper): each side has its own colour, on the roof and in the
   list, and each unbroken stretch on the roof shows its length. A side can be switched off like an edge kind. Bulbs alternate red and green and bulbs and clips are
   counted at common spacings. Nothing is saved. */
(function(){
  const t = (key, fallback, values) => globalThis.PlatformLanguage?.text('measurements', key, fallback, values) ?? fallback;
  // Edges an installer may light, in panel order. Eaves and rakes are the roofline; ridges and hips outline the peaks.
  const EDGES = [
    { type: 'EAVE', key: 'hl_edge_eaves', label: 'Eaves', hint: 'hl_edge_eaves_where', hintText: 'Bottom edge, where gutters hang', on: true },
    { type: 'RAKE', key: 'hl_edge_rakes', label: 'Rakes', hint: 'hl_edge_rakes_where', hintText: 'Sloped edge of a gable', on: true },
    { type: 'RIDGE', key: 'hl_edge_ridges', label: 'Ridges', hint: 'hl_edge_ridges_optional', hintText: 'Optional: outlines the peaks', on: false },
    { type: 'HIP', key: 'hl_edge_hips', label: 'Hips', hint: 'hl_edge_hips_optional', hintText: 'Optional: sloped corners of hip roofs', on: false }
  ];
  // Same spacings, bulb colours and side colours as the report page.
  const SPACINGS = [6, 8, 12, 15, 18];
  const STANDARD_SPACING = 12;
  const BULB_RED = '#d93025', BULB_GREEN = '#188038';
  // One colour per side, as on the report; they avoid the bulbs' red and green.
  const SIDE_COLORS = { north: '#1a73e8', east: '#f29900', south: '#9334e6', west: '#12b5cb', peak: '#e52592' };
  const SIDE_NAMES = {
    north: ['hl_side_north', 'North'], east: ['hl_side_east', 'East'], south: ['hl_side_south', 'South'], west: ['hl_side_west', 'West'],
    peak: ['hl_side_peak', 'Ridges and hips']
  };
  const LEVEL_NAMES = { lower: ['hl_level_lower', 'Lower'], middle: ['hl_level_middle', 'Middle'], upper: ['hl_level_upper', 'Upper'] };
  const LIFT_FT = 0.2;

  // Lights by side and roofline (FM-375). Each lit edge is on one side of the house (the compass side it faces, squared
  // to the house's own walls) and one roofline (eave heights in bands at least a story apart: lower, middle, upper, or
  // numbered above three). Edges: [{type, roof, a:[x,y,z], b:[x,y,z], length, keys}] in feet (x east, y north, z up),
  // all four kinds whether lit or not, so a side or roofline never changes when an edge kind is switched on or off.
  // faces: [{roof, ring:[[x,y,z], ...]}]. The same function is in holiday-lights.js and pdf.js; keep them identical.
  function groupHolidayLights(edges, faces, lit){
    const SIDES = ['north', 'east', 'south', 'west', 'peak'];
    const PEAK = { RIDGE: 1, HIP: 1 };
    const near = (p, q) => Math.abs(p[0] - q[0]) < 0.02 && Math.abs(p[1] - q[1]) < 0.02 && Math.abs(p[2] - q[2]) < 0.02;
    const inside = ([x, y], ring) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const facesOf = (edge) => faces.filter((face) => face.roof === edge.roof && face.ring.some((p, i) => {
      const q = face.ring[(i + 1) % face.ring.length];
      return (near(p, edge.a) && near(q, edge.b)) || (near(p, edge.b) && near(q, edge.a));
    }));
    // The house's axes: the plan direction most eaves and rakes run in, folded to a quarter turn.
    let c = 0, s = 0;
    for (const edge of edges) {
      if (PEAK[edge.type]) continue;
      const dx = edge.b[0] - edge.a[0], dy = edge.b[1] - edge.a[1], run = Math.hypot(dx, dy);
      if (!run) continue;
      const angle = Math.atan2(dy, dx) * 4;
      c += run * Math.cos(angle); s += run * Math.sin(angle);
    }
    const axis = c || s ? Math.atan2(s, c) / 4 : 0;
    // Rooflines: eave heights, sorted, split where they jump more than 3.5 ft, then bands closer than a story (7 ft)
    // merged, nearest first. A sloping lot or a porch a few feet down stays on the same roofline.
    const bands = [];
    edges.filter((edge) => edge.type === 'EAVE')
      .map((edge) => ({ z: (edge.a[2] + edge.b[2]) / 2, w: edge.length }))
      .sort((p, q) => p.z - q.z)
      .forEach(({ z, w }) => {
        const last = bands[bands.length - 1];
        if (last && z - last.hi < 3.5) { last.hi = z; last.sum += z * w; last.w += w; }
        else bands.push({ lo: z, hi: z, sum: z * w, w });
      });
    for (;;) {
      let best = -1, gap = 7;
      for (let i = 0; i + 1 < bands.length; i++) {
        const d = bands[i + 1].sum / bands[i + 1].w - bands[i].sum / bands[i].w;
        if (d < gap) { gap = d; best = i; }
      }
      if (best < 0) break;
      const [p, q] = bands.splice(best, 2);
      bands.splice(best, 0, { lo: p.lo, hi: q.hi, sum: p.sum + q.sum, w: p.w + q.w });
    }
    const levelAt = (z) => {
      let level = 0, best = Infinity;
      bands.forEach((band, i) => { const d = z < band.lo ? band.lo - z : z > band.hi ? z - band.hi : 0; if (d < best) { best = d; level = i; } });
      return level;
    };
    const groups = new Map();
    for (const edge of edges) {
      if (!lit[edge.type]) continue;
      const own = facesOf(edge);
      let side = 'peak', z = Math.min(edge.a[2], edge.b[2]);
      if (PEAK[edge.type]) {
        // A ridge sits above its roofs' eaves: it takes the roofline of the lowest corner of the faces beside it.
        const corners = own.flatMap((face) => face.ring.map((p) => p[2]));
        if (corners.length) z = Math.min(...corners);
      } else {
        // Outward: square to the edge in plan, away from the face it bounds.
        const dx = edge.b[0] - edge.a[0], dy = edge.b[1] - edge.a[1], run = Math.hypot(dx, dy) || 1;
        let nx = dy / run, ny = -dx / run;
        const mid = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
        const face = own[0];
        const ahead = !!face && inside([mid[0] + nx * 0.25, mid[1] + ny * 0.25], face.ring);
        const behind = !!face && inside([mid[0] - nx * 0.25, mid[1] - ny * 0.25], face.ring);
        if (ahead && !behind) { nx = -nx; ny = -ny; }
        else if (ahead === behind) {
          // No face, or one too thin to tell: away from the middle of the face, else of the whole roof.
          const ring = face ? face.ring : edges.filter((other) => other.roof === edge.roof).flatMap((other) => [other.a, other.b]);
          const centre = [0, 1].map((i) => ring.reduce((sum, p) => sum + p[i], 0) / ring.length);
          if ((centre[0] - mid[0]) * nx + (centre[1] - mid[1]) * ny > 0) { nx = -nx; ny = -ny; }
        }
        const u = nx * Math.cos(axis) + ny * Math.sin(axis), v = -nx * Math.sin(axis) + ny * Math.cos(axis);
        side = Math.abs(u) > Math.abs(v) ? (u > 0 ? 'east' : 'west') : (v > 0 ? 'north' : 'south');
      }
      const level = levelAt(z);
      const id = `${side}:${level}`;
      if (!groups.has(id)) groups.set(id, { id, side, level, edges: [], length: 0, lengths: {} });
      const group = groups.get(id);
      group.edges.push(edge);
      group.length += edge.length;
      group.lengths[edge.type] = (group.lengths[edge.type] || 0) + edge.length;
    }
    // Pieces: the unbroken stretches of a group (each its own string), longest first.
    for (const group of groups.values()) {
      const parent = new Map();
      const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
      for (const edge of group.edges) for (const key of edge.keys) if (!parent.has(key)) parent.set(key, key);
      for (const edge of group.edges) parent.set(find(edge.keys[0]), find(edge.keys[1]));
      const pieces = new Map();
      for (const edge of group.edges) {
        const root = find(edge.keys[0]);
        if (!pieces.has(root)) pieces.set(root, { edges: [], length: 0 });
        pieces.get(root).edges.push(edge);
        pieces.get(root).length += edge.length;
      }
      group.pieces = [...pieces.values()].sort((p, q) => q.length - p.length);
    }
    const count = Math.max(1, bands.length);
    const levelKey = (level) => count === 1 ? '' : count === 2 ? ['lower', 'upper'][level] : count === 3 ? ['lower', 'middle', 'upper'][level] : String(level + 1);
    const list = [...groups.values()]
      .sort((p, q) => SIDES.indexOf(p.side) - SIDES.indexOf(q.side) || p.level - q.level)
      .map((group) => ({ ...group, levelKey: levelKey(group.level) }));
    const sides = SIDES.map((side) => ({ side, groups: list.filter((group) => group.side === side) }))
      .filter((side) => side.groups.length)
      .map((side) => ({ ...side, length: side.groups.reduce((sum, group) => sum + group.length, 0) }));
    return { levels: count, groups: list, sides, length: list.reduce((sum, group) => sum + group.length, 0) };
  }

  // Names and colours for a grouping: "North", "Upper"; one roofline leaves the level unnamed.
  function nameGroups(layout){
    const sideName = (side) => t(...SIDE_NAMES[side]);
    const levelName = (key) => LEVEL_NAMES[key] ? t(...LEVEL_NAMES[key]) : t('hl_level_number', `Roofline ${key}`, { number: key });
    return layout.groups.map((group) => ({
      ...group, sideName: sideName(group.side), levelName: group.levelKey ? levelName(group.levelKey) : '', color: SIDE_COLORS[group.side]
    }));
  }

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
    if (document.getElementById('fm-holiday-lights-style-v3')) return;
    document.getElementById('fm-holiday-lights-style')?.remove();
    document.getElementById('fm-holiday-lights-style-v2')?.remove();
    const el = document.createElement('style');
    el.id = 'fm-holiday-lights-style-v3';
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
      .fm-hl-side{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:1px solid #f2f4f7}
      .fm-hl-side:first-child{border-top:0;padding-top:0}
      .fm-hl-side-head,.fm-hl-group{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;font-size:13px;padding:3px 2px}
      .fm-hl-side-head{grid-template-columns:auto auto 1fr auto;font-weight:650;cursor:pointer}
      .fm-hl-side-head input{margin:0;width:16px;height:16px;accent-color:#344054}
      .fm-hl-group{margin-left:26px}
      .fm-hl-side.is-off .fm-hl-side-head>:not(input),.fm-hl-side.is-off .fm-hl-group{opacity:.45}
      .fm-hl-group small,.fm-hl-side-head small{display:block;font-size:11px;color:#667085;font-weight:400}
      .fm-hl-swatch{width:12px;height:12px;border-radius:3px;display:inline-block}
      .fm-hl-side-head b,.fm-hl-group b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
      .fm-hl-empty{font-size:12px;color:#667085}
      .fm-hl-spacing{display:flex;flex-direction:column;gap:4px;font-variant-numeric:tabular-nums}
      .fm-hl-spacing-head,.fm-hl-spacing button{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;gap:6px;padding:7px 10px}
      .fm-hl-spacing-head{font-size:11px;font-weight:600;color:#667085;padding-top:0;padding-bottom:2px}
      .fm-hl-spacing-head span+span,.fm-hl-spacing button span+span{text-align:right}
      .fm-hl-spacing button{font:inherit;font-size:13px;color:#344054;background:#fff;border:1px solid #e4e7ec;border-radius:8px;cursor:pointer;text-align:left}
      .fm-hl-spacing button:hover{background:#f9fafb;border-color:#d0d5dd}
      .fm-hl-spacing button[aria-pressed=true]{border:1.5px solid #344054;background:#f2f4f7;font-weight:700;color:#101828}
      .fm-hl-spacing button:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}
      .fm-hl-info{position:relative;margin-left:auto;display:inline-flex}
      .fm-hl-info>button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid #d0d5dd;border-radius:50%;background:#fff;color:#667085;cursor:help}
      .fm-hl-info>button svg{width:14px;height:14px;display:block}
      .fm-hl-info>button:hover,.fm-hl-info.is-open>button{color:#101828;border-color:#98a2b3}
      .fm-hl-info>button:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
      .fm-hl-tip{position:absolute;right:0;top:calc(100% + 6px);z-index:6;width:max-content;max-width:min(280px,80vw);background:#101828eb;color:#fff;font-size:11px;font-weight:400;line-height:1.45;padding:7px 9px;border-radius:6px;box-shadow:0 4px 12px #1018282e;opacity:0;visibility:hidden;transform:translateY(-2px);transition:opacity .12s,transform .12s,visibility .12s;pointer-events:none;text-transform:none;letter-spacing:0}
      .fm-hl-info:hover .fm-hl-tip,.fm-hl-info>button:focus-visible+.fm-hl-tip,.fm-hl-info.is-open .fm-hl-tip{opacity:1;visibility:visible;transform:none}
      @media(prefers-reduced-motion:reduce){.fm-hl-tip{transition:none}}
      @container (max-width:760px){.fm-hl{grid-template-columns:1fr;grid-template-rows:minmax(320px,56vh) auto;height:auto}.fm-hl-panel{overflow:visible}}
    `;
    document.head.append(el);
  }

  const feet = (value) => t('hl_feet', `${Math.round(value).toLocaleString()} ft`, { value: Math.round(value) });
  const bulbsOn = (length, inches) => Math.max(1, Math.round(length * 12 / inches));

  // onUpdate({ total }): told the lit length in feet whenever it changes, for a host that shows only the roof.
  function mount(root, { xmlUrl, onUpdate } = {}){
    injectStyle();
    let disposed = false, renderer, scene, camera, controls, observer, runGroup, scale = 1, point = null, spacingIn = STANDARD_SPACING, fitRadius = 60, fitCorners = [], moved = false;
    const enabled = Object.fromEntries(EDGES.map((edge) => [edge.type, edge.on]));
    // Sides switched off (north, east, south, west, peak: false); every side starts on.
    const sideOn = {};
    const controller = new AbortController();
    const owned = [];
    const own = (object) => { owned.push(object); return object; };
    // Edges by type, in feet: [{type, roof, a:[x,y,z], b:[x,y,z], length, keys:[pointKey, pointKey]}], and the roof faces
    // they bound ({roof, ring}), which tell an edge's outside.
    const edges = Object.fromEntries(EDGES.map((edge) => [edge.type, []]));
    const faces = [];

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
          <h3><i class="fa-solid fa-lightbulb" aria-hidden="true"></i><span></span><span class="fm-hl-info"><button type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/></svg></button><span class="fm-hl-tip" role="tooltip"></span></span></h3>
          <div class="fm-hl-total"><strong data-hl-total>—</strong><span data-hl-total-label></span></div>
          <div class="fm-hl-section" data-hl-edges><h4></h4></div>
          <div class="fm-hl-section"><h4 data-hl-runs-title></h4><div data-hl-runs></div></div>
          <div class="fm-hl-section"><h4 data-hl-spacing-title></h4><div class="fm-hl-spacing"><div class="fm-hl-spacing-head"><span></span><span></span><span></span></div><div class="fm-hl-spacing" data-hl-spacing role="group"></div></div></div>
        </aside>
      </div></div>`;
    const canvasHost = root.querySelector('.fm-hl-canvas');
    // The counts panel may be moved out of root (the roof viewer's left column), so later lookups go through it.
    const panel = root.querySelector('.fm-hl-panel');
    const message = root.querySelector('.fm-hl-message');
    const resetButton = root.querySelector('[data-hl-reset]');
    root.querySelector('.fm-hl-panel').setAttribute('aria-label', t('hl_panel_label', 'Holiday lights'));
    root.querySelector('.fm-hl-panel h3>span').textContent = t('hl_title', 'Holiday Lights');
    root.querySelector('[data-hl-legend]').textContent = t('hl_legend_sides', 'Bulbs · one colour per side of the house');
    root.querySelector('[data-hl-edges] h4').textContent = t('hl_edges_title', 'Edges to light');
    root.querySelector('[data-hl-runs-title]').textContent = t('hl_sides_toggle_title', 'Sides to light');
    root.querySelector('[data-hl-spacing-title]').textContent = t('hl_spacing_table_title', 'Bulbs and clips by spacing');
    const heads = root.querySelectorAll('.fm-hl-spacing-head span');
    root.querySelector('[data-hl-spacing]').setAttribute('aria-label', t('hl_spacing_choose', 'Bulb spacing shown on the roof'));
    heads[0].textContent = t('hl_col_spacing', 'Spacing');
    heads[1].textContent = t('hl_col_bulbs', 'Bulbs');
    heads[2].textContent = t('hl_col_clips', 'Clips');
    // How the lengths are measured: a tooltip on the info button by the title (hover, focus or tap), also its name.
    const info = panel.querySelector('.fm-hl-info'), infoButton = info.querySelector('button'), tipId = 'fm-hl-tip-' + Math.random().toString(36).slice(2);
    const note = t('hl_note_sides_off', 'Lengths are measured along each roof edge from the report. Each side faces its compass direction and has its own colour; a side with eaves at more than one height is split into rooflines. Switch off a side the customer is not lighting. Each stretch on the roof shows its length. Clips: one per bulb.');
    info.querySelector('.fm-hl-tip').textContent = note;
    info.querySelector('.fm-hl-tip').id = tipId;
    infoButton.setAttribute('aria-label', t('hl_note_label', 'How lights are measured'));
    infoButton.setAttribute('aria-describedby', tipId);
    infoButton.onclick = () => info.classList.toggle('is-open');
    infoButton.onblur = () => info.classList.remove('is-open');
    infoButton.onkeydown = (event) => { if (event.key === 'Escape' && info.classList.contains('is-open')) { event.stopPropagation(); info.classList.remove('is-open'); } };
    const touch = matchMedia?.('(hover: none)').matches;
    root.querySelector('.fm-hl-hint').textContent = touch ? t('hl_hint_touch', 'Drag to orbit · Pinch to zoom') : t('hl_hint', 'Drag to orbit · Scroll to zoom · Right-drag to pan');
    resetButton.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.5 9M3 4v6h6"/></svg><span>${t('hl_reset', 'Reset view')}</span>`;
    resetButton.title = t('hl_reset', 'Reset view');
    message.textContent = t('hl_loading', 'Loading the roof…');

    function lengthOf(type){ return edges[type].reduce((sum, edge) => sum + edge.length, 0); }
    // Groups: the lit edges by side and roofline (groupHolidayLights), named and coloured, in list order.
    function buildGroups(){
      const all = EDGES.flatMap((edge) => edges[edge.type]);
      return nameGroups(groupHolidayLights(all, faces, enabled));
    }

    // groups: every lit edge kind's groups; shown: those on sides that are switched on.
    function renderPanel(groups, shown = groups){
      const host = panel.querySelector('[data-hl-edges]');
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
      const total = shown.reduce((sum, group) => sum + group.length, 0);
      panel.querySelector('[data-hl-total]').textContent = feet(total);
      panel.querySelector('[data-hl-total-label]').textContent = t('hl_total_all', 'of lights in total');
      const swatch = (group) => {
        const el = document.createElement('i');
        el.className = 'fm-hl-swatch';
        el.style.background = group.color;
        return el;
      };
      const kinds = (group) => EDGES.filter((edge) => group.lengths[edge.type])
        .map((edge) => `${t(edge.key, edge.label)} ${feet(group.lengths[edge.type])}`).join(' · ');
      const sideRows = [];
      for (const side of [...new Set(groups.map((group) => group.side))]) {
        const list = groups.filter((group) => group.side === side);
        const block = document.createElement('div');
        block.className = 'fm-hl-side' + (sideOn[side] === false ? ' is-off' : '');
        block.dataset.hlSide = side;
        // Each side switches on and off like an edge kind; one that is off keeps its length, greyed, and lights nothing.
        const head = document.createElement('label');
        head.className = 'fm-hl-side-head';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = sideOn[side] !== false;
        input.onchange = () => { sideOn[side] = input.checked; update(); };
        head.append(input);
        const name = document.createElement('span');
        const length = document.createElement('b');
        length.textContent = feet(list.reduce((sum, group) => sum + group.length, 0));
        // One roofline: the side is its own row.
        if (list.length === 1 && !list[0].levelKey) {
          name.textContent = list[0].sideName;
          const small = document.createElement('small');
          small.textContent = kinds(list[0]);
          name.append(small);
          head.append(swatch(list[0]), name, length);
          block.append(head);
        } else {
          name.textContent = list[0].sideName;
          head.append(swatch(list[0]), name, length);
          block.append(head);
          for (const group of list) {
            const row = document.createElement('div');
            row.className = 'fm-hl-group';
            row.dataset.hlGroup = group.id;
            const label = document.createElement('span');
            label.textContent = group.levelName;
            const small = document.createElement('small');
            small.textContent = kinds(group);
            label.append(small);
            const value = document.createElement('b');
            value.textContent = feet(group.length);
            row.append(swatch(group), label, value);
            block.append(row);
          }
        }
        sideRows.push(block);
      }
      if (!sideRows.length) {
        const empty = document.createElement('div');
        empty.className = 'fm-hl-empty';
        empty.textContent = t('hl_runs_none', 'No edges are lit.');
        sideRows.push(empty);
      }
      panel.querySelector('[data-hl-runs]').replaceChildren(...sideRows);
      const lit = shown.flatMap((group) => group.edges);
      // Each spacing is a choice: the selected one is what the roof shows.
      panel.querySelector('[data-hl-spacing]').replaceChildren(...SPACINGS.map((inches) => {
        const bulbs = lit.reduce((sum, edge) => sum + bulbsOn(edge.length, inches), 0);
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('aria-pressed', String(inches === spacingIn));
        for (const text of [t('hl_spacing_inches', `${inches} in`, { inches }), bulbs.toLocaleString(), bulbs.toLocaleString()]) {
          const cell = document.createElement('span');
          cell.textContent = text;
          row.append(cell);
        }
        row.onclick = () => { if (spacingIn !== inches) { spacingIn = inches; update(); } };
        return row;
      }));
    }

    function draw(){ if (!disposed && renderer) renderer.render(scene, camera); }
    // The whole roof fills the stage at any size: start where its bounding sphere fits, then move in until its corners
    // reach 80% of the way to the nearer edge of the view.
    function reset(){
      if (!camera) return;
      const aspect = canvasHost.clientWidth && canvasHost.clientHeight ? canvasHost.clientWidth / canvasHost.clientHeight : 1;
      const half = (camera.fov * Math.PI / 180) / 2, narrow = Math.min(half, Math.atan(Math.tan(half) * aspect));
      const direction = camera.position.clone().set(1, 0.8, 1.3).normalize();
      let distance = Math.max(20, fitRadius / Math.sin(narrow));
      for (let pass = 0; pass < 3 && fitCorners.length; pass++) {
        camera.position.copy(direction).multiplyScalar(distance);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        const reach = Math.max(...fitCorners.map((corner) => { const p = corner.clone().project(camera); return Math.max(Math.abs(p.x), Math.abs(p.y)); }));
        if (!(reach > 0.05)) break;
        distance = Math.max(controls.minDistance * 2, distance * reach / 0.8);
      }
      camera.position.copy(direction).multiplyScalar(distance);
      controls.target.set(0, 0, 0);
      controls.update();
      moved = false;
      draw();
    }
    function resize(){
      if (!renderer) return;
      const width = canvasHost.clientWidth || 1, height = canvasHost.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Until someone moves the camera, a new stage size (expand, shrink, a narrow window) refits the roof.
      if (!moved) reset(); else draw();
    }

    // A rounded label in the side's colour with a stretch's length.
    function labelTexture(T, color, text){
      const height = 96, c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.font = '700 50px Arial';
      const width = Math.max(height, Math.ceil(ctx.measureText(text).width) + 52);
      c.width = width; c.height = height;
      const r = height / 2 - 6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(6 + r, 6); ctx.lineTo(width - 6 - r, 6); ctx.arc(width - 6 - r, height / 2, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(6 + r, height - 6); ctx.arc(6 + r, height / 2, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '700 50px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, width / 2, height / 2 + 3);
      return { map: new T.CanvasTexture(c), aspect: width / height };
    }
    function disposeRuns(){
      if (!runGroup) return;
      scene.remove(runGroup);
      runGroup.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
      });
      runGroup = null;
    }
    // Each side is a tube in its colour with red and green bulbs on it at the selected spacing. Every unbroken stretch
    // of 3 ft or more shows its length above its longest edge (shorter ones are corner returns, still counted).
    function buildRunScene(groups){
      const T = window.THREE;
      disposeRuns();
      runGroup = new T.Group();
      scene.add(runGroup);
      const red = new T.Color(BULB_RED), green = new T.Color(BULB_GREEN);
      const bulbs = [];
      let n = 0;
      for (const group of groups) {
        const material = new T.MeshBasicMaterial({ color: group.color });
        for (const edge of group.edges) {
          const a = point(edge.a), b = point(edge.b);
          a.y += LIFT_FT * scale; b.y += LIFT_FT * scale;
          runGroup.add(new T.Mesh(new T.TubeGeometry(new T.LineCurve3(a, b), 1, 0.1 * scale, 6, false), material));
          const count = bulbsOn(edge.length, spacingIn);
          for (let i = 0; i < count; i++) bulbs.push({ at: a.clone().lerp(b, (i + 0.5) / count), color: n++ % 2 ? green : red });
        }
        for (const piece of group.pieces) {
          if (piece.length < 3) continue;
          const text = feet(piece.length);
          const { map, aspect } = labelTexture(T, group.color, text);
          const longest = piece.edges.reduce((best, edge) => (!best || edge.length > best.length ? edge : best), null);
          // One size on screen at any zoom, so near labels don't cover the roof and far ones stay legible.
          const badge = new T.Sprite(new T.SpriteMaterial({ map, depthTest: false, sizeAttenuation: false }));
          const mid = point(longest.a).lerp(point(longest.b), 0.5);
          badge.position.set(mid.x, mid.y + 0.6 * scale, mid.z);
          badge.scale.set(0.03 * aspect, 0.03, 1);
          badge.renderOrder = 5;
          badge.userData = { label: text, color: group.color };
          runGroup.add(badge);
        }
      }
      if (bulbs.length) {
        // Small spheres centred on the line: one size at every spacing, always wider than the line.
        const radius = 0.24 * scale;
        const mesh = new T.InstancedMesh(new T.SphereGeometry(radius, 10, 8), new T.MeshStandardMaterial({ roughness: 0.5 }), bulbs.length);
        const matrix = new T.Matrix4();
        bulbs.forEach((bulb, i) => { mesh.setMatrixAt(i, matrix.makeTranslation(bulb.at.x, bulb.at.y, bulb.at.z)); mesh.setColorAt(i, bulb.color); });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        runGroup.add(mesh);
      }
      draw();
    }
    function update(){
      const groups = buildGroups(), shown = groups.filter((group) => sideOn[group.side] !== false);
      renderPanel(groups, shown);
      if (scene) buildRunScene(shown);
      const total = shown.reduce((sum, group) => sum + group.length, 0);
      onUpdate?.({ total, text: feet(total) });
    }

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
          edges[line.type].push({ type: line.type, roof: r, a, b, length, keys: line.ids.map((id) => `${r}:${id}`) });
        }
        for (const face of roof.faces) faces.push({ roof: r, ring: face.points });
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
      controls.addEventListener('start', () => { moved = true; });
      const sun = new T.DirectionalLight(0xffffff, 0.3);
      sun.position.set(30, 80, 40);
      scene.add(new T.HemisphereLight(0xffffff, 0x8a93a3, 0.55), sun);

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
      const box = new T.Box3().setFromObject(roofGroup);
      fitRadius = box.getBoundingSphere(new T.Sphere()).radius || fitRadius;
      fitCorners = all.map(point);
      // Compass letters on the ground beyond each side, so the sides in the list read against the house.
      const centre = point(min.map((v, i) => (v + max[i]) / 2));
      const ground = (min[2] - (min[2] + max[2]) / 2) * scale;
      for (const [side, dx, dy] of [['north', 0, 1], ['east', 1, 0], ['south', 0, -1], ['west', -1, 0]]) {
        const c = document.createElement('canvas');
        c.width = c.height = 96;
        const ctx = c.getContext('2d');
        ctx.font = '700 64px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 10; ctx.strokeStyle = '#ffffff'; ctx.strokeText(t(...SIDE_NAMES[side]).charAt(0).toUpperCase(), 48, 52);
        ctx.fillStyle = '#98a2b3'; ctx.fillText(t(...SIDE_NAMES[side]).charAt(0).toUpperCase(), 48, 52);
        const letter = new T.Sprite(own(new T.SpriteMaterial({ map: own(new T.CanvasTexture(c)), depthTest: false })));
        const reach = (dx ? max[0] - min[0] : max[1] - min[1]) / 2 + Math.max(10, (max[0] - min[0] + max[1] - min[1]) * 0.12);
        letter.position.set(centre.x + dx * reach * scale, ground, centre.z - dy * reach * scale);
        letter.scale.set(3.4 * scale, 3.4 * scale, 1);
        scene.add(letter);
      }

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

  window.FirstMeasureHolidayLights = { mount, groupHolidayLights };
})();
