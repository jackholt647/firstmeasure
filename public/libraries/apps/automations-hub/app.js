/* public/libraries/apps/automations-hub/app.js
 * The Automations Hub (portal.automations_hub, GP-72, GP-110; docs/architecture/automations-hub.md): a flowchart of
 * how projects move through the organization's boards. New leads come in along the top row (intake routing: any new
 * lead, or split by source, arrival time, location or any other condition), go onto a board (a scope template, drawn
 * with its stages) and from board to board (a stage's `scopes.activateTemplate.v1` binding). The lanes down the left
 * are the scope categories (Sales and Production by default); a board sits in the lanes of its categories, so one
 * dragged onto the line between two lanes is in both. Everything drawn is the real configuration and every change is
 * saved through the routes Settings > Project Scopes uses. The setup (`automations.setup`, a guided experience) plays
 * in the panel on the right, embedded, so the flowchart stays in view while it asks its questions.
 * It is in More apps and not pinned by default; Checklist settings' "See Advanced Controls" (apps/checklists/app.js)
 * brings people here from a project window.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  const NS = 'automations-hub';
  const SALES = 'sales', INTAKE = 'intake';
  const SETUP_ID = 'automations.setup';
  const clean = (value) => String(value ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[c]);
  /** Copy in the automations-hub catalog (English is the fallback); `{name}` placeholders are ICU entries. */
  const t = (key, text, values) => globalThis.PlatformLanguage?.text
    ? globalThis.PlatformLanguage.text(NS, key, text, values)
    : (values ? text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match) : text);

  // ── The model: pure functions over the scope templates, categories and intake routing (tested in node) ──────────

  /** The lanes down the left: the organization's enabled scope categories, except intake (never on a board). */
  function lanesOf(categories){
    return array(categories).filter((category) => category && category.enabled !== false && category.id !== INTAKE)
      .map((category) => ({ id:clean(category.id), label:clean(category.label) || clean(category.id), builtin:category.builtin === true }));
  }

  function categoryIdsOf(definition){
    const value = object(definition);
    if (Array.isArray(value.category_ids)) return [...new Set(value.category_ids.map(clean).filter(Boolean))];
    const kind = clean(value.kind);
    return kind === 'pipeline' || kind === 'sales' ? [SALES] : kind === 'production' ? ['production'] : [];
  }

  /** A board's stages: the groups under its top phase (a plan with no groups is one stage per top node). */
  function stagesOf(definition){
    const roots = array(object(object(definition).work_plan).root_nodes).map(object);
    const stages = [];
    const todos = (node) => array(node.children).map(object).reduce((sum, child) => sum + (child.actionable === true ? 1 : 0) + todos(child), 0);
    for (const root of roots) {
      const groups = array(root.children).map(object).filter((child) => child.actionable !== true);
      for (const node of groups.length ? groups : [root]) stages.push({ id:clean(node.id), title:clean(node.title) || clean(node.id), todos:todos(node) });
    }
    return stages;
  }

  const LINK_ACTIONS = new Set(['scopes.activateTemplate.v1', 'scopes.activateFromProposal.v1']);
  /**
   * Board to board: every binding that starts another scope, with the stage it is in and the step that fires it.
   * `scopes.activateFromProposal.v1` starts the boards for the work sold, so its target is `proposal`.
   */
  function linksOf(template){
    const definition = object(template.definition), from = clean(template.id), links = [];
    const stageIds = new Set(stagesOf(definition).map((stage) => stage.id));
    const walk = (node, stage) => {
      const here = stageIds.has(clean(node.id)) ? node : stage;
      for (const [hook, entries] of Object.entries(object(node.automation_bindings))) {
        for (const binding of array(entries).map(object)) {
          if (!LINK_ACTIONS.has(clean(binding.automation))) continue;
          const proposal = clean(binding.automation) === 'scopes.activateFromProposal.v1';
          const to = proposal ? 'proposal' : clean(object(binding.input).template_id);
          if (!to) continue;
          links.push({ id:`${from}:${clean(node.id)}:${hook}:${clean(binding.id)}`, from, to, proposal, hook, binding_id:clean(binding.id), node_id:clean(node.id), node_title:clean(node.title),
            stage_id:clean(here?.id), stage_title:clean(here?.title), conditional:!!(binding.conditions && Object.keys(object(binding.conditions)).length) || Array.isArray(binding.conditions) });
        }
      }
      for (const child of array(node.children).map(object)) walk(child, here);
    };
    const plan = object(definition.work_plan);
    walk({ id:'', title:'', automation_bindings:plan.automation_bindings }, null);
    for (const root of array(plan.root_nodes).map(object)) walk(root, null);
    return links;
  }

  /** The boards on the chart: templates that are on, not intake, with their lanes (indexes into `lanes`) and stages. */
  function boardsOf(templates, lanes){
    const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
    return array(templates).map(object).filter((template) => clean(template.id) && template.enabled !== false && clean(template.status) !== 'archived')
      .map((template) => {
        const definition = object(template.definition);
        const categories = categoryIdsOf(definition);
        if (categories.includes(INTAKE)) return null;
        const rows = categories.map((id) => laneIndex.get(id)).filter((index) => index !== undefined).sort((a, b) => a - b);
        return { id:clean(template.id), name:clean(template.name || definition.name) || clean(template.id), color:clean(template.color || definition.color) || '#667085',
          icon:clean(template.icon || definition.icon) || 'fa-diagram-project', categories, rows, stages:stagesOf(definition), version:Number(template.version || template.current_version || 0), template };
      }).filter(Boolean);
  }

  /** The categories a board gets when dropped on lanes `rows`: its lane categories are replaced, others stay. */
  function dropCategories(categories, lanes, rows){
    const laneIds = new Set(lanes.map((lane) => lane.id));
    const chosen = [...new Set(rows)].sort((a, b) => a - b).map((index) => lanes[index]?.id).filter(Boolean);
    return [...chosen, ...array(categories).filter((id) => !laneIds.has(id))];
  }

  /** Where a dragged board lands: on a lane, or within `edge` px of the line between two lanes (then it is in both). */
  function dropRows(y, laneBoxes, edge = 18){
    for (let index = 0; index < laneBoxes.length - 1; index += 1) {
      const line = laneBoxes[index].bottom;
      if (Math.abs(y - line) <= edge) return [index, index + 1];
    }
    const found = laneBoxes.findIndex((box) => y >= box.top && y < box.bottom);
    if (found >= 0) return [found];
    if (!laneBoxes.length) return [];
    return y < laneBoxes[0].top ? [0] : [laneBoxes.length - 1];
  }

  /**
   * Columns: each board gets the first column, from left to right, where every lane it spans is free. Boards new leads
   * go to come first, then the boards they lead to (beside their source where there is room), then the rest.
   */
  function placeBoards(boards, links, entryIds){
    const byId = new Map(boards.map((board) => [board.id, board]));
    const order = [], seen = new Set();
    const visit = (id) => {
      if (seen.has(id) || !byId.has(id)) return;
      seen.add(id); order.push(id);
      for (const link of links) if (link.from === id && !link.proposal) visit(link.to);
    };
    for (const id of entryIds) visit(id);
    for (const board of boards) visit(board.id);
    const taken = new Map();
    const free = (column, rows) => rows.every((row) => !taken.get(`${column}:${row}`));
    const place = {};
    for (const id of order) {
      const board = byId.get(id);
      if (!board.rows.length) continue;
      const rows = [];
      for (let row = board.rows[0]; row <= board.rows[board.rows.length - 1]; row += 1) rows.push(row);
      const source = links.find((link) => link.to === id && place[link.from] !== undefined);
      let column = source ? place[source.from] : 0;
      if (!free(column, rows)) { column = 0; while (!free(column, rows)) column += 1; }
      rows.forEach((row) => taken.set(`${column}:${row}`, true));
      place[id] = column;
    }
    return place;
  }

  /** Where kinds of lead come from (`lead_source.kind`, leads/receive.ts callers). */
  const SOURCE_KINDS = [
    ['web_form', 'm_0fce7127f5f836', 'Website forms', 'fa-globe'],
    ['missed_call', 'm_791580ee953bf4', 'Missed calls', 'fa-phone-slash'],
    ['manual_lead', 'm_54f108ae053fef', 'Entered by your team', 'fa-user-pen'],
    ['live_chat', 'm_442d5d44daa2cb', 'Website chat', 'fa-comments'],
    ['email_lead', 'm_5d2b9327181e33', 'Email', 'fa-envelope'],
    ['connection_lead', 'm_ec5962a416a218', 'Connected lead services', 'fa-plug'],
    ['canvassing', 'm_88f66f0b968bb2', 'Canvassing', 'fa-person-walking'],
    ['publication', 'm_430b5a44f7d5a9', 'Other apps and agents', 'fa-robot']
  ];
  const sourceLabel = (kind) => { const found = SOURCE_KINDS.find((entry) => entry[0] === kind); return found ? t(found[1], found[2]) : kind; };

  /** The fields a lead can be split on (any other dot path into the project works too). */
  const FIELDS = [
    ['lead_source.kind', 'm_d2999be4da1802', 'Where it came from'],
    ['lead_source.received_local.hour', 'm_b74c25d8bc2317', 'Hour it arrived (0–23)'],
    ['lead_source.received_local.weekday', 'm_ac23bacf7db4bc', 'Day it arrived (sun–sat)'],
    ['address', 'm_53d803cdbe9ab1', 'Address'],
    ['lead_source.source_path', 'm_5124b34ca2a769', 'Lead source (CRM)'],
    ['title', 'm_422f30a4a4cff1', 'Project name'],
    ['summary', 'm_afb78593912273', 'What they asked for']
  ];
  /** The one condition contract's operators (work/conditions.ts CONDITION_OPERATORS) that make sense for a lead. */
  const OPERATORS = [
    ['equals', 'm_918e35dac47366', 'is'], ['not_equals', 'm_5bd25dcbb42b43', 'is not'],
    ['in', 'm_091b32167f1bcf', 'is any of'], ['not_in', 'm_6c964f6cfe96bf', 'is none of'],
    ['contains', 'm_4a9c0e1329c050', 'contains'], ['starts_with', 'm_0b2b4b8270e3a7', 'starts with'],
    ['greater_or_equal', 'm_a33f097ea3be4e', 'is at least'], ['less_than', 'm_c1cfca2b5dc47a', 'is less than'],
    ['is_present', 'm_b854a7302d3df8', 'has a value'], ['is_missing', 'm_10a77fd4f86de2', 'is empty']
  ];
  const fieldLabel = (field) => { const found = FIELDS.find((entry) => entry[0] === field); return found ? t(found[1], found[2]) : field; };
  const operatorLabel = (operator) => { const found = OPERATORS.find((entry) => entry[0] === operator); return found ? t(found[1], found[2]) : operator; };

  /** One line for a rule's conditions: "Where it came from is any of Website forms". */
  function conditionSummary(rule){
    const formula = object(rule.formula);
    const parts = array(formula.conditions).map(object).filter((condition) => clean(condition.field)).map((condition) => {
      const field = clean(condition.field), operator = clean(condition.operator) || 'equals';
      const raw = Array.isArray(condition.value) ? condition.value.join(', ') : clean(condition.value);
      const value = field === 'lead_source.kind' ? raw.split(',').map((kind) => sourceLabel(clean(kind))).join(', ') : raw;
      return ['is_present', 'is_missing'].includes(operator) ? `${fieldLabel(field)} ${operatorLabel(operator)}` : `${fieldLabel(field)} ${operatorLabel(operator)} ${value}`;
    });
    if (!parts.length) {
      const map = Object.entries(object(rule.conditions));
      return map.map(([path, value]) => `${fieldLabel(path)} ${operatorLabel('equals')} ${Array.isArray(value) ? value.join(', ') : clean(value)}`).join(' · ');
    }
    return parts.join(formula.match === 'any' ? ` ${t('m_14f4d6d87a2cf8', 'or')} ` : ` ${t('m_c438dec029be30', 'and')} `);
  }

  /** The lead row: each routing rule in order (first match wins), then everything else (the default). */
  function leadsOf(routing){
    if (!routing) return [];
    const rules = routing.routing_mode === 'default' ? [] : array(routing.rules).map(object);
    const entry = (rule) => clean(rule.entry) === 'unscoped' ? '' : clean(rule.template_id);
    return [
      ...rules.map((rule, index) => ({ id:`rule:${clean(rule.id) || index}`, rule_id:clean(rule.id), index, title:clean(rule.title), summary:conditionSummary(rule), to:entry(rule), off:rule.enabled === false, rule })),
      { id:'default', rule_id:'', index:-1, title:'', summary:'', to:clean(routing.default_entry) === 'unscoped' ? '' : clean(routing.default_template_id), off:false, rule:null, fallback:true, split:rules.length > 0 }
    ];
  }

  /** A rule from the split menu. */
  function splitRule(kind, options = {}){
    const id = `flow_${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const base = { id, enabled:true, conditions:{}, entry:options.to ? 'scope' : 'unscoped', template_id:options.to || '' };
    if (kind === 'source') return { ...base, title:sourceLabel(options.source), formula:{ match:'all', conditions:[{ id:'condition_1', field:'lead_source.kind', operator:'in', value:options.source }] } };
    if (kind === 'time') return { ...base, title:t('m_b514364b2b6af4', 'After hours'), formula:{ match:'any', conditions:[
      { id:'condition_1', field:'lead_source.received_local.hour', operator:'less_than', value:8 },
      { id:'condition_2', field:'lead_source.received_local.hour', operator:'greater_or_equal', value:17 },
      { id:'condition_3', field:'lead_source.received_local.weekday', operator:'in', value:'sat,sun' }] } };
    if (kind === 'location') return { ...base, title:t('m_2a8eb3dbd980fb', 'In an area'), formula:{ match:'all', conditions:[{ id:'condition_1', field:'address', operator:'contains', value:clean(options.value) }] } };
    return { ...base, title:t('m_6fb3b59b9b8aa2', 'Some leads'), formula:{ match:'all', conditions:[{ id:'condition_1', field:'title', operator:'contains', value:'' }] } };
  }

  /** A binding that starts board `to` when stage `stageId` of a board is done, added in the hub. */
  function withLink(definition, stageId, to){
    const next = JSON.parse(JSON.stringify(object(definition)));
    const add = (node) => {
      if (clean(node.id) === stageId) {
        const bindings = node.automation_bindings = object(node.automation_bindings);
        const list = bindings.onCompleted = array(bindings.onCompleted);
        if (!list.some((binding) => clean(binding.automation) === 'scopes.activateTemplate.v1' && clean(object(binding.input).template_id) === to)) {
          list.push({ id:`start_${to}`.slice(0, 120), automation:'scopes.activateTemplate.v1', input:{ template_id:to, instance_key:`flow_${clean(definition.id)}` },
            explainer:'Added in the Automations Hub: when this stage is done, the project starts on the next board.' });
        }
        return true;
      }
      return array(node.children).some(add);
    };
    return array(object(next.work_plan).root_nodes).some(add) ? next : null;
  }

  /** The definition without one board-to-board binding. */
  function withoutLink(definition, link){
    const next = JSON.parse(JSON.stringify(object(definition)));
    const strip = (node) => {
      if (clean(node.id) === link.node_id && Array.isArray(object(node.automation_bindings)[link.hook])) {
        node.automation_bindings[link.hook] = node.automation_bindings[link.hook].filter((binding) => !(clean(binding.id) === link.binding_id && LINK_ACTIONS.has(clean(binding.automation))));
      }
      array(node.children).forEach(strip);
    };
    const plan = object(next.work_plan);
    if (!link.node_id) strip({ id:'', automation_bindings:plan.automation_bindings, children:[] });
    array(plan.root_nodes).forEach(strip);
    return next;
  }

  const model = { lanesOf, categoryIdsOf, stagesOf, linksOf, boardsOf, dropCategories, dropRows, placeBoards, leadsOf, conditionSummary, splitRule, withLink, withoutLink, SOURCE_KINDS };
  window.FirstMateAutomationsHub = Object.assign(window.FirstMateAutomationsHub || {}, { model });
  if (!runtime?.registerApp) return;

  // ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────

  const css = `
    .fmah{height:100%;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) var(--fmah-panel,380px);background:#f5f7fa;color:#101828;box-sizing:border-box;font-size:13px}
    .fmah.fmah-panel-off{--fmah-panel:0px}
    .fmah *{box-sizing:border-box}
    .fmah-main{min-width:0;min-height:0;display:flex;flex-direction:column}
    .fmah-top{display:flex;align-items:center;gap:12px;padding:14px 20px 12px;border-bottom:1px solid #eaecf0;background:#fff}
    .fmah-top h1{margin:0;font-size:17px;font-weight:900;letter-spacing:-.01em;display:flex;align-items:center;gap:9px}
    .fmah-top h1 i{color:var(--primary-readable,var(--primary,#d93025))}
    .fmah-status{margin-left:auto;color:#667085;font-size:12px;font-weight:700;min-height:16px}
    .fmah-status.err{color:#b42318}
    .fmah-btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-weight:800;cursor:pointer;white-space:nowrap}
    .fmah-btn:hover{background:#f9fafb}
    .fmah-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
    .fmah-btn.ghost{border-color:transparent;background:transparent}
    .fmah-btn[disabled]{opacity:.5;cursor:default}
    .fmah-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
    .fmah-canvas{position:relative;min-width:max-content;padding:18px 28px 40px 0}
    .fmah-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:1}
    .fmah-wires path{fill:none;stroke:#98a2b3;stroke-width:2}
    .fmah-wires path.lead{stroke:var(--primary,#d93025);stroke-opacity:.55}
    .fmah-wires path.fan{stroke-dasharray:4 5;opacity:0;transition:opacity .15s}
    .fmah-wires path.fan.hot{opacity:1}
    .fmah-wires path.off{stroke-dasharray:4 5;stroke-opacity:.35}
    .fmah-wires path.hot{stroke:var(--primary,#d93025);stroke-width:2.5;stroke-opacity:.8}
    .fmah-wires path.draft{stroke:var(--primary,#d93025);stroke-dasharray:6 5;stroke-width:2.5}
    .fmah-wires path.preview{stroke:var(--primary,#d93025);stroke-dasharray:7 6;stroke-opacity:.9;animation:fmahDash 1s linear infinite}
    @keyframes fmahDash{to{stroke-dashoffset:-26}}
    .fmah-row{display:grid;grid-template-columns:var(--fmah-gutter,150px) auto;align-items:start}
    .fmah-gutter{position:sticky;left:0;z-index:4;display:flex;flex-direction:column;gap:3px;padding:10px 12px 10px 20px;background:inherit}
    .fmah-gutter strong{font-size:12px;font-weight:950;text-transform:uppercase;letter-spacing:.05em;color:#344054}
    .fmah-gutter small{color:#667085;font-size:11px;font-weight:650;line-height:1.35}
    .fmah-leads{background:#f5f7fa}
    .fmah-lead-list{display:flex;align-items:stretch;gap:12px;flex-wrap:nowrap;padding:4px 0 28px}
    .fmah-lead{position:relative;z-index:2;min-width:170px;max-width:240px;display:grid;grid-template-columns:auto 1fr;gap:3px 9px;align-items:center;padding:11px 13px 15px;border:1.5px solid rgba(var(--primary-rgb,217,48,37),.35);border-radius:14px;background:#fff;box-shadow:0 6px 16px rgba(15,23,42,.06);cursor:pointer;user-select:none;touch-action:none}
    .fmah-lead:hover{border-color:var(--primary,#d93025)}
    .fmah-lead>i{grid-row:span 2;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
    .fmah-lead strong{font-size:13px;font-weight:900;line-height:1.2}
    .fmah-lead small{color:#667085;font-size:11px;font-weight:700;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .fmah-lead.off{opacity:.55;border-style:dashed}
    .fmah-sink{position:relative;z-index:2;min-width:150px;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:10px 13px;border:1.5px dashed #d0d5dd;border-radius:14px;color:#667085;background:rgba(255,255,255,.6)}
    .fmah-sink strong{font-size:12px;font-weight:900;color:#475467}
    .fmah-sink small{font-size:11px;font-weight:650}
    .fmah-port{position:absolute;left:0;right:0;bottom:0;height:12px;display:flex;justify-content:center;align-items:flex-end;cursor:crosshair;touch-action:none}
    .fmah-port::after{content:'';width:12px;height:12px;margin-bottom:-6px;border-radius:50%;background:#fff;border:2px solid var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12);transition:transform .15s}
    .fmah-lead:hover .fmah-port::after,.fmah-board:hover .fmah-port::after,.fmah-port:hover::after{transform:scale(1.25)}
    .fmah-grid{position:relative;display:grid;grid-auto-rows:minmax(170px,auto);align-items:stretch}
    .fmah-lane{grid-column:1/-1;border-top:1px solid #e4e7ec;background:var(--lane-bg,#fff)}
    .fmah-lane:nth-of-type(even){--lane-bg:#fbfcfd}
    .fmah-lane-label{grid-column:1;position:sticky;left:0;z-index:4;display:flex;flex-direction:column;gap:6px;padding:14px 12px 14px 20px;border-top:1px solid #e4e7ec;background:var(--lane-bg,#fff);border-right:1px solid #eaecf0}
    .fmah-lane-label strong{font-size:12px;font-weight:950;text-transform:uppercase;letter-spacing:.05em;color:#344054;cursor:text;border-radius:6px;padding:2px 4px;margin:-2px -4px;outline:none}
    .fmah-lane-label strong:hover{background:#f2f4f7}
    .fmah-lane-label input{font:inherit;font-size:12px;font-weight:900;width:100%;height:28px;border:1px solid #d0d5dd;border-radius:7px;padding:0 7px}
    .fmah-lane-label .fmah-lane-tools{display:flex;gap:4px}
    .fmah-lane-label .fmah-icon{width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:#98a2b3;cursor:pointer}
    .fmah-lane-label .fmah-icon:hover{background:#f2f4f7;color:#475467}
    .fmah-lane-label small{color:#98a2b3;font-size:10.5px;font-weight:700;line-height:1.35}
    .fmah-lane.drop{background:rgba(var(--primary-rgb,217,48,37),.07)}
    .fmah-edge-drop{position:absolute;left:var(--fmah-gutter,150px);right:0;height:0;border-top:3px dashed var(--primary,#d93025);z-index:2;pointer-events:none}
    .fmah-edge-drop span{position:absolute;left:12px;top:-12px;padding:2px 9px;border-radius:999px;background:var(--primary,#d93025);color:#fff;font-size:10.5px;font-weight:900;white-space:nowrap}
    .fmah-cell{position:relative;z-index:2;padding:16px 14px;display:flex;align-items:stretch}
    .fmah-board{position:relative;width:258px;display:flex;flex-direction:column;border:1px solid #e4e7ec;border-top:4px solid var(--c,#667085);border-radius:14px;background:#fff;box-shadow:0 10px 24px rgba(15,23,42,.07);transition:box-shadow .2s,transform .2s}
    .fmah-board.span{border-left:4px solid var(--c,#667085)}
    .fmah-board.entry{box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.35),0 10px 24px rgba(15,23,42,.07)}
    .fmah-board.target{box-shadow:0 0 0 3px var(--primary,#d93025),0 12px 28px rgba(15,23,42,.12)}
    .fmah-board.moving{z-index:20;box-shadow:0 22px 44px rgba(15,23,42,.22);opacity:.96;transition:none}
    .fmah-board-head{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;padding:11px 10px 9px 12px;cursor:grab;touch-action:none;user-select:none}
    .fmah-board-head>i{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:color-mix(in srgb,var(--c,#667085) 14%,#fff);color:var(--c,#667085);font-size:13px}
    .fmah-board-head strong{display:block;font-size:13.5px;font-weight:950;line-height:1.2}
    .fmah-board-head small{display:block;color:#667085;font-size:11px;font-weight:750;margin-top:1px}
    .fmah-board-head button{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}
    .fmah-board-head button:hover{background:#f2f4f7}
    .fmah-stages{list-style:none;margin:0;padding:2px 12px 18px;display:grid;gap:6px;flex:1;align-content:start}
    .fmah-stage{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:7px 9px;border-radius:9px;background:#f9fafb;font-size:12px;font-weight:800;color:#344054}
    .fmah-stage::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--c,#667085)}
    .fmah-stage small{color:#98a2b3;font-size:10.5px;font-weight:750}
    .fmah-board.collapsed .fmah-stages{display:none}
    .fmah-board.collapsed{min-height:0}
    .fmah-label{position:absolute;z-index:5;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:6px;max-width:220px;padding:4px 10px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#475467;font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-shadow:0 2px 6px rgba(15,23,42,.06)}
    .fmah-label:hover{border-color:var(--primary,#d93025);color:#101828}
    .fmah-label.logic{border-radius:8px;border-color:#fedf89;background:#fffaeb;color:#93370d}
    .fmah-label.logic i{color:#dc6803}
    .fmah-other{margin:22px 0 0;padding:0 0 0 20px}
    .fmah-other h2{margin:0 0 8px;font-size:11px;font-weight:950;text-transform:uppercase;letter-spacing:.05em;color:#667085}
    .fmah-other-list{display:flex;gap:10px;flex-wrap:wrap}
    .fmah-other .fmah-board{width:220px}
    .fmah-add-lane{margin:10px 0 0 20px}
    .fmah-arming .fmah-board,.fmah-arming .fmah-sink{cursor:copy}
    .fmah-arming .fmah-board:hover{box-shadow:0 0 0 3px var(--primary,#d93025)}
    .fmah-hint{position:sticky;left:0;display:flex;align-items:center;gap:8px;margin:0 0 6px 20px;padding:8px 12px;border-radius:10px;background:#101828;color:#fff;font-size:12px;font-weight:750;width:max-content;max-width:calc(100% - 40px);z-index:6}
    .fmah-spot{animation:fmahSpot 1.4s ease-in-out infinite;position:relative;z-index:6}
    @keyframes fmahSpot{0%,100%{box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.45),0 0 0 9px rgba(var(--primary-rgb,217,48,37),.12)}50%{box-shadow:0 0 0 5px rgba(var(--primary-rgb,217,48,37),.6),0 0 0 15px rgba(var(--primary-rgb,217,48,37),.05)}}
    .fmah-pop{position:fixed;z-index:2147483400;width:min(420px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 24px));overflow:auto;padding:14px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 22px 50px rgba(15,23,42,.22);display:grid;gap:11px;font-size:12.5px}
    .fmah-pop h3{margin:0;font-size:14px;font-weight:950}
    .fmah-pop p{margin:0;color:#475467;font-weight:650;line-height:1.45}
    .fmah-pop label{display:grid;gap:4px;font-size:11px;font-weight:850;color:#475467}
    .fmah-pop input,.fmah-pop select{font:inherit;font-size:12.5px;height:32px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;background:#fff;color:#101828;min-width:0}
    .fmah-cond{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:6px;align-items:center}
    .fmah-cond button{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#98a2b3;cursor:pointer}
    .fmah-pop-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .fmah-pop-row .grow{flex:1}
    .fmah-menu{display:grid;gap:6px}
    .fmah-menu button{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center;text-align:left;padding:9px 11px;border:1px solid #eaecf0;border-radius:10px;background:#fff;font:inherit;cursor:pointer}
    .fmah-menu button:hover{border-color:var(--primary,#d93025);background:#fff7f6}
    .fmah-menu button i{grid-row:span 2;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#f2f4f7;color:#475467}
    .fmah-menu button strong{font-size:12.5px;font-weight:900}
    .fmah-menu button small{color:#667085;font-size:11px;font-weight:650}
    .fmah-checks{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .fmah-checks label{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:750;color:#344054;padding:6px 8px;border:1px solid #eaecf0;border-radius:8px;cursor:pointer}
    .fmah-checks input{height:auto}
    .fmah-panel{position:relative;min-width:0;min-height:0;border-left:1px solid #eaecf0;background:#fff;display:flex;flex-direction:column;overflow:hidden}
    .fmah-panel-off .fmah-panel{display:none}
    .fmah-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eaecf0}
    .fmah-panel-head strong{font-size:13px;font-weight:950;flex:1}
    .fmah-panel-body{position:relative;flex:1;min-height:0;overflow:auto}
    .fmah-panel-rest{padding:18px;display:grid;gap:14px}
    .fmah-panel-rest h2{margin:0;font-size:16px;font-weight:950}
    .fmah-panel-rest p{margin:0;color:#475467;font-weight:650;line-height:1.5}
    .fmah-tips{list-style:none;margin:0;padding:0;display:grid;gap:10px}
    .fmah-tips li{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;color:#344054;font-weight:700;line-height:1.45}
    .fmah-tips i{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#f2f4f7;color:#475467}
    .fmah-empty{padding:40px 24px;color:#667085;font-weight:700}
    @media(max-width:980px){.fmah{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}.fmah-panel{border-left:0;border-top:1px solid #eaecf0;max-height:55vh;min-height:320px}}
    @media(prefers-reduced-motion:reduce){.fmah *{animation:none!important;transition:none!important}}
  `;

  const hasPerm = (key) => window.Portal?.util?.hasPerm?.(key) === true;
  const toast = (title, message, ok = true) => window.Portal?.ui?.showToast?.(title, message, ok);

  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return {};
    (window.Portal?.util?.injectCSS || ((id, text) => {
      let style = document.getElementById(`css_${id}`);
      if (!style) { style = document.createElement('style'); style.id = `css_${id}`; document.head.appendChild(style); }
      style.textContent = text;
    }))('automations_hub', css);
    const orgId = clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
    const branchId = 'default';
    const api = () => window.PlatformAPI?.scopes;
    const canEdit = hasPerm('manage_company_settings');

    const host = document.createElement('div');
    host.className = 'fmah';
    host.setAttribute('data-fm-automations-hub', '');
    host.innerHTML = `<div class="fmah-main">
        <header class="fmah-top"><h1><i class="fas fa-diagram-project" aria-hidden="true"></i><span>${esc(t('m_a677e3388e9b31', 'Automations Hub'))}</span></h1>
          <span class="fmah-status" role="status" data-status></span>
          <button type="button" class="fmah-btn" data-setup-toggle><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${esc(t('m_b06faf127e1505', 'Setup'))}</button></header>
        <div class="fmah-scroll" data-scroll><div class="fmah-empty">${esc(t('m_a8841443021c0d', 'Loading your boards…'))}</div></div>
      </div>
      <aside class="fmah-panel" aria-label="${esc(t('m_c98a3515471060', 'Set up your flow'))}">
        <div class="fmah-panel-head"><strong>${esc(t('m_c98a3515471060', 'Set up your flow'))}</strong><button type="button" class="fmah-btn ghost" data-panel-close aria-label="${esc(t('m_840bbfd34de91e', 'Hide the setup'))}"><i class="fas fa-angles-right" aria-hidden="true"></i></button></div>
        <div class="fmah-panel-body" data-panel></div>
      </aside>`;
    root.appendChild(host);
    const scroll = host.querySelector('[data-scroll]');
    const panel = host.querySelector('[data-panel]');
    const status = host.querySelector('[data-status]');

    let destroyed = false, state = null, preview = null, spot = null, playing = null, armed = null, pop = null, gesture = null;
    const collapsed = new Set();
    const say = (text, error = false) => { status.textContent = text || ''; status.classList.toggle('err', !!error); };

    async function load(){
      if (!orgId || !api()) { scroll.innerHTML = `<div class="fmah-empty">${esc(t('m_8867a579ddf10d', 'Sign in to an organization to see its boards.'))}</div>`; return; }
      const [templates, categories, routing] = await Promise.all([
        api().list(orgId, branchId),
        api().categories(orgId).catch(() => null),
        canEdit ? api().routing(orgId, branchId).catch(() => null) : Promise.resolve(null)
      ]);
      if (destroyed) return;
      state = {
        templates:array(templates?.templates),
        categories:array(categories?.categories).length ? array(categories.categories) : [{ id:SALES, label:'Sales', enabled:true, builtin:true }, { id:'production', label:'Production', enabled:true }],
        routing:routing?.routing || null
      };
      draw();
    }

    /** What is drawn: the saved state, with the setup's answers on top while it plays (nothing saved until it does). */
    function view(){
      const lanes = lanesOf(state.categories);
      let templates = state.templates, routing = state.routing;
      if (preview?.entry) {
        routing = { ...(routing || {}), default_entry:'scope', default_template_id:preview.entry };
        if (typeof preview.one_board === 'boolean') templates = templates.map((template) => template.id !== preview.entry ? template : { ...template, definition:{ ...object(template.definition), category_ids:[SALES, ...(preview.one_board ? ['production'] : []), ...categoryIdsOf(template.definition).filter((id) => ![SALES, 'production', INTAKE].includes(id))] } });
      }
      const boards = boardsOf(templates, lanes);
      const links = boards.flatMap((board) => linksOf(board.template)).filter((link) => link.proposal || boards.some((board) => board.id === link.to));
      const leads = leadsOf(routing);
      const place = placeBoards(boards, links, leads.map((lead) => lead.to).filter(Boolean));
      return { lanes, boards, links, leads, place, routing };
    }

    let drawLater = false;
    function draw(){
      if (!state || destroyed) return;
      // A save that finishes while something is being dragged redraws once the drag ends, not under the pointer.
      if (gesture?.moved) { drawLater = true; return; }
      drawLater = false;
      closePop();
      const v = view();
      const columns = Math.max(1, ...Object.values(v.place).map((column) => column + 1));
      const entryIds = new Set(v.leads.map((lead) => lead.to).filter(Boolean));
      const boardHtml = (board, small = false) => {
        const lanesText = board.rows.map((row) => v.lanes[row]?.label).filter(Boolean).join(' · ') || t('m_3419ed73cdd5ed', 'Not in a lane');
        const isCollapsed = collapsed.has(board.id) || small;
        return `<article class="fmah-board${board.rows.length > 1 ? ' span' : ''}${entryIds.has(board.id) ? ' entry' : ''}${isCollapsed ? ' collapsed' : ''}" data-board="${esc(board.id)}" style="--c:${esc(board.color)}">
          <header class="fmah-board-head" data-board-head="${esc(board.id)}" title="${esc(canEdit ? t('m_7053e084c953ae', 'Drag up or down to change its lane; onto the line between two lanes to put it in both.') : '')}">
            <i class="fas ${esc(board.icon)}" aria-hidden="true"></i><span><strong>${esc(board.name)}</strong><small>${esc(lanesText)} · ${esc(t('m_5476ca7e95af4a', '{count, plural, one {# stage} other {# stages}}', { count:board.stages.length }))}</small></span>
            <button type="button" data-collapse="${esc(board.id)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${esc(isCollapsed ? t('m_c4d6e1ee3d05cd', 'Show stages') : t('m_8f23e6a8012b9b', 'Hide stages'))}"><i class="fas fa-chevron-${isCollapsed ? 'down' : 'up'}" aria-hidden="true"></i></button>
          </header>
          <ol class="fmah-stages">${board.stages.map((stage) => `<li class="fmah-stage" data-stage="${esc(stage.id)}"><span>${esc(stage.title)}</span><small>${stage.todos ? esc(t('m_efed369268350f', '{count, plural, one {# to-do} other {# to-dos}}', { count:stage.todos })) : ''}</small></li>`).join('')}</ol>
          ${canEdit ? `<div class="fmah-port" data-port="board:${esc(board.id)}" title="${esc(t('m_d662abe07525e4', 'Drag to another board to connect, or click here and then click the board.'))}"></div>` : ''}
        </article>`;
      };
      const leadHtml = (lead) => {
        const icon = lead.fallback ? 'fa-inbox' : lead.rule && clean(object(array(object(lead.rule.formula).conditions)[0]).field) === 'lead_source.kind' ? (SOURCE_KINDS.find((entry) => entry[0] === clean(object(array(lead.rule.formula.conditions)[0]).value).split(',')[0])?.[3] || 'fa-filter') : 'fa-filter';
        const title = lead.fallback ? (lead.split ? t('m_4f43c5a5ac49ee', 'Every other new lead') : t('m_fd1d0520a6a1af', 'Any new lead')) : (lead.title || t('m_6fb3b59b9b8aa2', 'Some leads'));
        const summary = lead.fallback ? (canEdit ? t('m_5bdf13d84119e4', 'Click to split by source, time or place') : '') : lead.summary;
        return `<div class="fmah-lead${lead.off ? ' off' : ''}" data-lead="${esc(lead.id)}" role="button" tabindex="0" aria-label="${esc(title)}"><i class="fas ${esc(icon)}" aria-hidden="true"></i><strong>${esc(title)}</strong><small>${esc(summary)}</small>${canEdit ? `<div class="fmah-port" data-port="lead:${esc(lead.id)}"></div>` : ''}</div>`;
      };
      const placed = v.boards.filter((board) => v.place[board.id] !== undefined);
      const other = v.boards.filter((board) => v.place[board.id] === undefined);
      const routingNote = !canEdit ? t('m_a50323b27b6a50', 'Only people who manage company settings can see and change where new leads go.')
        : !v.routing ? t('m_36861042095732', 'Where new leads go could not be read.') : '';
      const ignored = v.routing && v.routing.routing_mode === 'default' && array(v.routing.rules).length;
      scroll.innerHTML = `<div class="fmah-canvas${armed ? ' fmah-arming' : ''}" data-canvas style="--fmah-gutter:150px">
        <svg class="fmah-wires" data-wires aria-hidden="true"></svg>
        ${armed ? `<div class="fmah-hint" data-hint><i class="fas fa-link" aria-hidden="true"></i>${esc(t('m_84763d916c71bc', 'Now click the board it goes to. Esc cancels.'))}</div>` : ''}
        <div class="fmah-row fmah-leads" data-leads-row><div class="fmah-gutter"><strong>${esc(t('m_b71569e0651789', 'New leads'))}</strong><small>${esc(routingNote || t('m_780f3723687c0f', 'Where each new lead goes first. The first box that matches wins.'))}</small>${ignored ? `<button type="button" class="fmah-btn" data-use-rules>${esc(t('m_055dc73aca32e9', 'Use the saved rules'))}</button>` : ''}</div>
          <div class="fmah-lead-list">${v.leads.map(leadHtml).join('')}${v.routing ? `<div class="fmah-sink" data-sink="unscoped"><strong>${esc(t('m_e7ee25698227ac', 'No board yet'))}</strong><small>${esc(t('m_e68aec92ca9c47', 'Stays a new lead until someone picks a board'))}</small></div>` : ''}</div></div>
        <div class="fmah-grid" data-grid style="grid-template-columns:var(--fmah-gutter) repeat(${columns}, auto)">
          ${v.lanes.map((lane, index) => `<div class="fmah-lane" data-lane="${index}" style="grid-row:${index + 1}"></div>
            <div class="fmah-lane-label" data-lane-label="${index}" style="grid-row:${index + 1}"><strong ${canEdit ? `data-rename="${esc(lane.id)}" tabindex="0" role="button" title="${esc(t('m_e32e6dab52dcf9', 'Rename'))}"` : ''}>${esc(lane.label)}</strong>
              ${lane.id === SALES ? `<small>${esc(t('m_cad3474c3275e4', 'A project on a Sales board is an open opportunity.'))}</small>` : ''}
              ${canEdit && !lane.builtin ? `<span class="fmah-lane-tools"><button type="button" class="fmah-icon" data-lane-remove="${esc(lane.id)}" aria-label="${esc(t('m_bd4f3c88abfbb0', 'Remove this lane'))}" title="${esc(t('m_bd4f3c88abfbb0', 'Remove this lane'))}"><i class="fas fa-trash" aria-hidden="true"></i></button></span>` : ''}</div>`).join('')}
          ${placed.map((board) => `<div class="fmah-cell" style="grid-column:${v.place[board.id] + 2};grid-row:${board.rows[0] + 1} / ${board.rows[board.rows.length - 1] + 2}">${boardHtml(board)}</div>`).join('')}
        </div>
        ${canEdit ? `<button type="button" class="fmah-btn fmah-add-lane" data-lane-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('m_6b0dff9065d7dd', 'Add a lane'))}</button>` : ''}
        ${other.length ? `<section class="fmah-other"><h2>${esc(t('m_17b6ae289ec631', 'Boards not in a lane'))}</h2><div class="fmah-other-list">${other.map((board) => boardHtml(board, true)).join('')}</div></section>` : ''}
      </div>`;
      wire(v);
      applySpot();
    }

    // ── Wires ──────────────────────────────────────────────────────────────────────────────────────────────────────
    let lastView = null;
    function wire(v = lastView){
      lastView = v;
      const canvas = scroll.querySelector('[data-canvas]'), svg = scroll.querySelector('[data-wires]');
      if (!canvas || !svg || !v) return;
      canvas.querySelectorAll('.fmah-label').forEach((label) => label.remove());
      const base = canvas.getBoundingClientRect();
      const box = (el) => { const r = el.getBoundingClientRect(); return { x:r.left - base.left, y:r.top - base.top, w:r.width, h:r.height }; };
      const boardEl = (id) => canvas.querySelector(`[data-board="${CSS.escape(id)}"]`);
      const paths = [];
      const curve = (a, b) => {
        if (b.y > a.y + 8) { const dy = Math.max(30, (b.y - a.y) / 2); return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`; }
        const dx = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y + 60} ${b.x - dx},${b.y - 60} ${b.x},${b.y}`;
      };
      const label = (html, at, attrs, logic) => {
        const el = document.createElement('button');
        el.type = 'button'; el.className = `fmah-label${logic ? ' logic' : ''}`; el.innerHTML = html;
        Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
        el.style.left = `${at.x}px`; el.style.top = `${at.y}px`;
        canvas.appendChild(el);
      };
      for (const lead of v.leads) {
        const el = canvas.querySelector(`[data-lead="${CSS.escape(lead.id)}"]`);
        const target = lead.to ? boardEl(lead.to) : canvas.querySelector('[data-sink]');
        if (!el || !target) continue;
        const a = box(el), b = box(target);
        const previewing = preview?.entry && lead.fallback;
        const start = { x:a.x + a.w / 2, y:a.y + a.h };
        // To "No board yet", beside it in the same row: a loop under both boxes.
        const d = lead.to ? curve(start, { x:b.x + b.w / 2, y:b.y }) : `M${start.x},${start.y} C${start.x},${start.y + 34} ${b.x + b.w / 2},${b.y + b.h + 34} ${b.x + b.w / 2},${b.y + b.h}`;
        paths.push(`<path class="lead${previewing ? ' preview' : ''}${lead.off ? ' off' : ''}" d="${d}"/>`);
      }
      for (const link of v.links) {
        const from = boardEl(link.from);
        if (!from) continue;
        const a = box(from);
        const start = { x:a.x + a.w / 2, y:a.y + a.h };
        const when = link.stage_title || link.node_title;
        if (link.proposal) {
          const at = { x:start.x, y:start.y + 26 };
          label(`<i class="fas fa-code-branch" aria-hidden="true"></i>${esc(t('m_3db34e2013f887', 'Starts the boards for the work sold'))}`, at, { 'data-link':link.id, title:when ? t('m_6fb1959f81939c', 'When {step} is done', { step:when }) : '' }, true);
          for (const board of v.boards) {
            if (board.id === link.from || !board.categories.includes('production')) continue;
            const target = boardEl(board.id); if (!target) continue;
            const b = box(target);
            paths.push(`<path class="fan" data-fan="${esc(link.from)}" d="${curve({ x:at.x, y:at.y + 10 }, { x:b.x + b.w / 2, y:b.y })}"/>`);
          }
          continue;
        }
        const target = boardEl(link.to);
        if (!target) continue;
        const b = box(target);
        const end = { x:b.x + b.w / 2, y:b.y };
        const back = end.y <= start.y + 8;
        const a2 = back ? { x:a.x + a.w, y:a.y + a.h / 2 } : start, b2 = back ? { x:b.x, y:b.y + b.h / 2 } : end;
        paths.push(`<path data-wire="${esc(link.id)}" d="${curve(a2, b2)}"/>`);
        const mid = { x:(a2.x + b2.x) / 2, y:(a2.y + b2.y) / 2 };
        label(`${link.conditional ? '<i class="fas fa-code-branch" aria-hidden="true"></i>' : ''}${esc(when ? t('m_6fb1959f81939c', 'When {step} is done', { step:when }) : t('m_520bc1518069a5', 'Then'))}`, mid, { 'data-link':link.id }, link.conditional);
      }
      if (gesture?.draft) paths.push(`<path class="draft" d="${curve(gesture.draft.from, gesture.draft.to)}"/>`);
      svg.innerHTML = paths.join('');
    }

    // ── Spotlight (the setup points at parts of the chart) ──────────────────────────────────────────────────────────
    function applySpot(){
      scroll.querySelectorAll('.fmah-spot').forEach((el) => el.classList.remove('fmah-spot'));
      if (!spot) return;
      const targets = [...scroll.querySelectorAll(spot)];
      targets.forEach((el) => el.classList.add('fmah-spot'));
      targets[0]?.scrollIntoView?.({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }

    // ── Saving ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function saving(work, done = t('m_4bb4688766e904', 'Saved')){
      say(t('m_ea600c018fb36c', 'Saving…'));
      try { await work(); say(done); setTimeout(() => { if (status.textContent === done) say(''); }, 2400); }
      catch (error) {
        say(clean(error?.message) || t('m_5dd328c8b4a02e', 'That didn’t save. Try again.'), true);
        if (error?.status === 409 || /revision|version/i.test(clean(error?.message))) await load().catch(() => null);
      }
    }

    async function saveRouting(next){
      const { revision, updated_at:_updated, ...data } = state.routing;
      const rules = array(next.rules ?? data.rules);
      const body = { ...data, ...next, rules, routing_mode:rules.some((rule) => rule.enabled !== false) ? 'formula' : (next.routing_mode || data.routing_mode) };
      await saving(async () => {
        const result = await api().saveRouting(orgId, branchId, { expected_revision:revision, data:body });
        state.routing = result?.routing || state.routing;
        draw();
      });
    }

    async function saveTemplate(board, definition, done){
      const template = board.template;
      await saving(async () => {
        const result = await api().save(orgId, branchId, board.id, { ...object(template.definition), ...definition, id:board.id, name:board.name,
          description:template.description || object(template.definition).description || '', color:template.color || '', icon:template.icon || '', status:template.status || 'active',
          sort_order:Number(template.sort_order || 0), expected_version:Number(template.version || template.current_version || 1) });
        const saved = result?.template;
        state.templates = state.templates.map((item) => item.id === board.id ? (saved || { ...item, definition:{ ...object(item.definition), ...definition } }) : item);
        draw();
      }, done);
    }

    async function saveCategories(categories){
      await saving(async () => {
        const result = await api().saveCategories(orgId, { categories:categories.map((category) => ({ id:category.id, label:category.label, enabled:category.enabled !== false })) });
        state.categories = array(result?.categories).length ? result.categories : categories;
        draw();
      });
    }

    /** Connects a lead box or a board to a board (or a lead box to "No board yet"). */
    function connect(source, targetId){
      if (!state || !canEdit) return;
      const v = view();
      if (source.startsWith('lead:')) {
        const lead = v.leads.find((item) => item.id === source.slice(5));
        if (!lead || !v.routing) return;
        const entry = targetId === 'unscoped' ? { entry:'unscoped', template_id:'' } : { entry:'scope', template_id:targetId };
        if (lead.fallback) return saveRouting({ default_entry:entry.entry, default_template_id:entry.template_id || clean(v.routing.default_template_id) });
        return saveRouting({ rules:array(v.routing.rules).map((rule) => clean(rule.id) === lead.rule_id ? { ...rule, ...entry } : rule) });
      }
      if (source.startsWith('board:') && targetId !== 'unscoped') {
        const board = v.boards.find((item) => item.id === source.slice(6));
        const target = v.boards.find((item) => item.id === targetId);
        if (!board || !target || board.id === target.id) return;
        const last = board.stages[board.stages.length - 1];
        const next = last && withLink(board.template.definition, last.id, target.id);
        if (!next) return say(t('m_ad118a43fd7419', 'That board has no stages to connect from.'), true);
        return saveTemplate(board, { work_plan:next.work_plan }, t('m_a8fcdc166c62d6', 'Connected: when {stage} is done, {board} starts', { stage:last.title, board:target.name }));
      }
    }

    // ── Popovers: a lead box's conditions and destination, the split menu, a board link ──────────────────────────────
    function closePop(){ pop?.remove(); pop = null; }
    function openPop(anchor, html, bind){
      closePop();
      pop = document.createElement('div');
      pop.className = 'fmah-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('data-fmr-ignore', '');
      pop.innerHTML = html;
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
      const left = Math.min(Math.max(12, r.left), window.innerWidth - p.width - 12);
      const top = r.bottom + 8 + p.height < window.innerHeight ? r.bottom + 8 : Math.max(12, r.top - p.height - 8);
      pop.style.left = `${left}px`; pop.style.top = `${top}px`;
      bind(pop);
      pop.querySelector('input,select,button')?.focus?.({ preventScroll:true });
    }

    const destinationOptions = (v, selected) => `<option value="unscoped" ${!selected ? 'selected' : ''}>${esc(t('m_e7ee25698227ac', 'No board yet'))}</option>${v.boards.map((board) => `<option value="${esc(board.id)}" ${board.id === selected ? 'selected' : ''}>${esc(board.name)}</option>`).join('')}`;

    function openLead(anchor, leadId){
      const v = view();
      const lead = v.leads.find((item) => item.id === leadId);
      if (!lead || !canEdit || !v.routing) return;
      if (lead.fallback) return openSplit(anchor, v, lead);
      const rule = JSON.parse(JSON.stringify(lead.rule));
      rule.formula = { match:object(rule.formula).match === 'any' ? 'any' : 'all', conditions:array(object(rule.formula).conditions).map(object) };
      if (!rule.formula.conditions.length) rule.formula.conditions = Object.entries(object(rule.conditions)).map(([field, value], index) => ({ id:`condition_${index + 1}`, field, operator:Array.isArray(value) ? 'in' : 'equals', value:Array.isArray(value) ? value.join(',') : value }));
      const rules = array(v.routing.rules);
      const at = rules.findIndex((item) => clean(item.id) === lead.rule_id);
      const condRow = (condition, index) => `<div class="fmah-cond" data-cond="${index}">
          <select data-f="field" aria-label="${esc(t('m_a20b1dbdbc6449', 'Field'))}">${[...FIELDS, ...(FIELDS.some((entry) => entry[0] === condition.field) || !condition.field ? [] : [[condition.field, '', condition.field]])].map((entry) => `<option value="${esc(entry[0])}" ${entry[0] === condition.field ? 'selected' : ''}>${esc(entry[1] ? t(entry[1], entry[2]) : entry[2])}</option>`).join('')}</select>
          <select data-f="operator" aria-label="${esc(t('m_8c307f4979037b', 'Comparison'))}">${OPERATORS.map((entry) => `<option value="${entry[0]}" ${entry[0] === (condition.operator || 'equals') ? 'selected' : ''}>${esc(t(entry[1], entry[2]))}</option>`).join('')}</select>
          ${condition.field === 'lead_source.kind' ? `<select data-f="value" aria-label="${esc(t('m_ec6b76d100b0ec', 'Value'))}">${SOURCE_KINDS.map((entry) => `<option value="${entry[0]}" ${clean(condition.value).split(',')[0] === entry[0] ? 'selected' : ''}>${esc(t(entry[1], entry[2]))}</option>`).join('')}</select>`
            : `<input data-f="value" value="${esc(Array.isArray(condition.value) ? condition.value.join(',') : condition.value ?? '')}" aria-label="${esc(t('m_ec6b76d100b0ec', 'Value'))}">`}
          <button type="button" data-cond-remove="${index}" aria-label="${esc(t('m_8261c51a7fc95c', 'Remove condition'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>`;
      const render = () => `<h3>${esc(t('m_cab1ae3fa6e4e6', 'Which leads go here'))}</h3>
        <label>${esc(t('m_8cf345002184e5', 'Name'))}<input data-title value="${esc(rule.title)}"></label>
        ${rule.formula.conditions.length > 1 ? `<label>${esc(t('m_e3fbd46ed1ed15', 'Match'))}<select data-match><option value="all" ${rule.formula.match === 'all' ? 'selected' : ''}>${esc(t('m_4cbaec6698244d', 'All of these'))}</option><option value="any" ${rule.formula.match === 'any' ? 'selected' : ''}>${esc(t('m_4ccb6b05e0b7dc', 'Any of these'))}</option></select></label>` : ''}
        <div class="fmah-menu" data-conds>${rule.formula.conditions.map(condRow).join('')}</div>
        <div class="fmah-pop-row"><button type="button" class="fmah-btn" data-cond-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('m_13cb87692824d3', 'Add a condition'))}</button></div>
        <label>${esc(t('m_cfce4ed8c79cdc', 'They go to'))}<select data-to>${destinationOptions(v, rule.entry === 'unscoped' ? '' : clean(rule.template_id))}</select></label>
        <div class="fmah-pop-row">
          <button type="button" class="fmah-btn" data-move="-1" ${at <= 0 ? 'disabled' : ''} aria-label="${esc(t('m_f346776cce6af6', 'Check this one earlier'))}" title="${esc(t('m_f346776cce6af6', 'Check this one earlier'))}"><i class="fas fa-arrow-left" aria-hidden="true"></i></button>
          <button type="button" class="fmah-btn" data-move="1" ${at >= rules.length - 1 ? 'disabled' : ''} aria-label="${esc(t('m_d66f7787a6abac', 'Check this one later'))}" title="${esc(t('m_d66f7787a6abac', 'Check this one later'))}"><i class="fas fa-arrow-right" aria-hidden="true"></i></button>
          <button type="button" class="fmah-btn" data-toggle>${esc(rule.enabled === false ? t('m_73cc286eb8aa7b', 'Turn on') : t('m_9174f0f0b06dda', 'Turn off'))}</button>
          <button type="button" class="fmah-btn" data-delete><i class="fas fa-trash" aria-hidden="true"></i>${esc(t('m_4fc60207629a44', 'Delete'))}</button>
          <span class="grow"></span>
          <button type="button" class="fmah-btn primary" data-done>${esc(t('m_5bab3e72de1ebf', 'Save'))}</button></div>`;
      const read = (root) => {
        rule.title = clean(root.querySelector('[data-title]')?.value) || rule.title;
        const match = root.querySelector('[data-match]'); if (match) rule.formula.match = match.value;
        root.querySelectorAll('[data-cond]').forEach((row) => {
          const condition = rule.formula.conditions[Number(row.dataset.cond)]; if (!condition) return;
          const field = row.querySelector('[data-f=field]').value;
          if (field !== condition.field) { condition.field = field; condition.value = field === 'lead_source.kind' ? 'web_form' : ''; }
          else condition.value = row.querySelector('[data-f=value]')?.value ?? '';
          condition.operator = row.querySelector('[data-f=operator]').value;
        });
        const to = root.querySelector('[data-to]').value;
        Object.assign(rule, to === 'unscoped' ? { entry:'unscoped', template_id:'' } : { entry:'scope', template_id:to });
      };
      const bind = (root) => {
        const redraw = () => { root.innerHTML = render(); bind(root); };
        root.onchange = (event) => { if (event.target.matches('[data-f=field],[data-match]')) { read(root); redraw(); } };
        root.querySelector('[data-cond-add]').onclick = () => { read(root); rule.formula.conditions.push({ id:`condition_${Date.now().toString(36)}`, field:'lead_source.kind', operator:'in', value:'web_form' }); redraw(); };
        root.querySelectorAll('[data-cond-remove]').forEach((button) => { button.onclick = () => { read(root); rule.formula.conditions.splice(Number(button.dataset.condRemove), 1); redraw(); }; });
        root.querySelectorAll('[data-move]').forEach((button) => { button.onclick = () => {
          read(root); const to = at + Number(button.dataset.move); const next = [...rules];
          next.splice(at, 1); next.splice(to, 0, rule); closePop(); saveRouting({ rules:next });
        }; });
        root.querySelector('[data-toggle]').onclick = () => { read(root); rule.enabled = rule.enabled === false; closePop(); saveRouting({ rules:rules.map((item, index) => index === at ? rule : item) }); };
        root.querySelector('[data-delete]').onclick = () => { closePop(); saveRouting({ rules:rules.filter((_, index) => index !== at) }); };
        root.querySelector('[data-done]').onclick = () => {
          read(root);
          if (!rule.formula.conditions.some((condition) => clean(condition.field))) return say(t('m_de9bbc3b5e9f9a', 'A box needs at least one condition. Delete it instead.'), true);
          closePop(); saveRouting({ rules:rules.map((item, index) => index === at ? { ...rule, conditions:{} } : item) });
        };
      };
      openPop(anchor, render(), bind);
    }

    function openSplit(anchor, v, lead){
      const rules = array(v.routing.rules);
      const to = lead.to;
      const covered = new Set(rules.flatMap((rule) => array(object(rule.formula).conditions).filter((condition) => condition.field === 'lead_source.kind').flatMap((condition) => clean(condition.value).split(',').map(clean))));
      const menu = `<h3>${esc(t('m_e39fe0ad94ac7f', 'Split new leads'))}</h3><p>${esc(t('m_883ff826501d22', 'Each part gets its own box here. Drag from its dot to the board those leads go to.'))}</p>
        <div class="fmah-menu">
          <button type="button" data-split="source"><i class="fas fa-signs-post" aria-hidden="true"></i><strong>${esc(t('m_fcf12015af01a0', 'By where they come from'))}</strong><small>${esc(t('m_65c91bbc53c721', 'Website forms, missed calls, chat, email…'))}</small></button>
          <button type="button" data-split="time"><i class="fas fa-clock" aria-hidden="true"></i><strong>${esc(t('m_a3300c3d936b9a', 'By when they come in'))}</strong><small>${esc(t('m_992eb71c34d9be', 'After hours and weekends, on your company’s clock'))}</small></button>
          <button type="button" data-split="location"><i class="fas fa-location-dot" aria-hidden="true"></i><strong>${esc(t('m_f4776005684888', 'By where the job is'))}</strong><small>${esc(t('m_c44d33fde4271d', 'A city, state or ZIP code in the address'))}</small></button>
          <button type="button" data-split="other"><i class="fas fa-code-branch" aria-hidden="true"></i><strong>${esc(t('m_c5bb7fb9adb4c4', 'By something else'))}</strong><small>${esc(t('m_2fff95a0afa843', 'Any condition on the lead'))}</small></button>
        </div>`;
      const sources = `<h3>${esc(t('m_fcf12015af01a0', 'By where they come from'))}</h3><p>${esc(t('m_7e2529ec845fd9', 'Pick the ones that should be handled differently. The rest stay in “Every other new lead”.'))}</p>
        <div class="fmah-checks">${SOURCE_KINDS.map((entry) => `<label><input type="checkbox" value="${entry[0]}" ${covered.has(entry[0]) ? 'checked disabled' : ''}><i class="fas ${entry[3]}" aria-hidden="true"></i>${esc(t(entry[1], entry[2]))}</label>`).join('')}</div>
        <div class="fmah-pop-row"><span class="grow"></span><button type="button" class="fmah-btn primary" data-apply>${esc(t('m_1e01f468d4866e', 'Split'))}</button></div>`;
      const place = `<h3>${esc(t('m_f4776005684888', 'By where the job is'))}</h3><label>${esc(t('m_bf1620df25cb91', 'The address contains'))}<input data-place placeholder="${esc(t('m_188499728402cb', 'For example Austin, TX or 78701'))}"></label>
        <div class="fmah-pop-row"><span class="grow"></span><button type="button" class="fmah-btn primary" data-apply>${esc(t('m_1e01f468d4866e', 'Split'))}</button></div>`;
      const bind = (root) => {
        root.querySelectorAll('[data-split]').forEach((button) => { button.onclick = () => {
          const kind = button.dataset.split;
          if (kind === 'source') { root.innerHTML = sources; return bindApply(root, () => [...root.querySelectorAll('input:checked:not([disabled])')].map((input) => splitRule('source', { source:input.value, to }))); }
          if (kind === 'location') { root.innerHTML = place; root.querySelector('[data-place]').focus(); return bindApply(root, () => { const value = clean(root.querySelector('[data-place]').value); return value ? [{ ...splitRule('location', { value, to }), title:value }] : []; }); }
          closePop();
          const rule = splitRule(kind, { to });
          saveRouting({ rules:[...rules, rule] }).then(() => { if (kind === 'other') { const el = scroll.querySelector(`[data-lead="rule:${CSS.escape(rule.id)}"]`); if (el) openLead(el, `rule:${rule.id}`); } });
        }; });
      };
      const bindApply = (root, make) => { root.querySelector('[data-apply]').onclick = () => { const added = make(); closePop(); if (added.length) saveRouting({ rules:[...rules, ...added] }); }; };
      openPop(anchor, menu, bind);
    }

    function openLink(anchor, linkId){
      const v = view();
      const link = v.links.find((item) => item.id === linkId);
      if (!link) return;
      const board = v.boards.find((item) => item.id === link.from);
      const target = v.boards.find((item) => item.id === link.to);
      const when = link.stage_title || link.node_title || board?.name;
      const html = `<h3>${esc(link.proposal ? t('m_3db34e2013f887', 'Starts the boards for the work sold') : t('m_bf5b104b2af65b', '{from} → {to}', { from:board?.name || link.from, to:target?.name || link.to }))}</h3>
        <p>${esc(link.proposal ? t('m_258cf7166c430c', 'When {step} is done on {board}, the project goes onto the production board of each kind of work on the signed proposal.', { step:link.node_title || when, board:board?.name || '' })
          : t('m_803ea21fb1b2ff', 'When {step} is done on {board}, the project starts on {target}.', { step:link.node_title && link.node_title !== when ? `${when} › ${link.node_title}` : when, board:board?.name || '', target:target?.name || link.to }))}</p>
        ${link.conditional ? `<p>${esc(t('m_d1617beb039c47', 'It only happens when its conditions match. Change them in Settings › Project Scopes.'))}</p>` : ''}
        <div class="fmah-pop-row"><span class="grow"></span>${canEdit && board ? `<button type="button" class="fmah-btn" data-unlink><i class="fas fa-link-slash" aria-hidden="true"></i>${esc(t('m_3a295e44f886fb', 'Remove this connection'))}</button>` : ''}<button type="button" class="fmah-btn primary" data-close>${esc(t('m_8cb6b086a0e69c', 'Done'))}</button></div>`;
      openPop(anchor, html, (root) => {
        root.querySelector('[data-close]').onclick = closePop;
        const unlink = root.querySelector('[data-unlink]');
        if (unlink) unlink.onclick = () => { closePop(); saveTemplate(board, { work_plan:withoutLink(board.template.definition, link).work_plan }, t('m_604919893d69cd', 'Connection removed')); };
      });
    }

    // ── Lanes ──────────────────────────────────────────────────────────────────────────────────────────────────────
    function renameLane(el){
      const id = el.dataset.rename;
      const category = state.categories.find((item) => item.id === id);
      if (!category) return;
      const input = document.createElement('input');
      input.value = category.label; input.setAttribute('aria-label', t('m_e32e6dab52dcf9', 'Rename'));
      el.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = (keep) => {
        if (done) return; done = true;
        const label = clean(input.value);
        if (!keep || !label || label === category.label) return draw();
        saveCategories(state.categories.map((item) => item.id === id ? { ...item, label } : item));
      };
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
    }
    function addLane(button){
      openPop(button, `<h3>${esc(t('m_6b0dff9065d7dd', 'Add a lane'))}</h3><p>${esc(t('m_5d55db057bbea9', 'A lane is a kind of board, such as Service or Warranty. Boards can sit in more than one.'))}</p>
        <label>${esc(t('m_8cf345002184e5', 'Name'))}<input data-lane-name></label><div class="fmah-pop-row"><span class="grow"></span><button type="button" class="fmah-btn primary" data-apply>${esc(t('m_c807a71e1c06f5', 'Add'))}</button></div>`, (root) => {
        const apply = () => {
          const label = clean(root.querySelector('[data-lane-name]').value);
          if (!label) return;
          const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'lane';
          let id = base, n = 2;
          while (state.categories.some((item) => item.id === id && item.enabled !== false)) id = `${base}_${n++}`;
          closePop();
          const existing = state.categories.find((item) => item.id === id);
          saveCategories(existing ? state.categories.map((item) => item.id === id ? { ...item, label, enabled:true } : item) : [...state.categories, { id, label, enabled:true }]);
        };
        root.querySelector('[data-apply]').onclick = apply;
        root.querySelector('[data-lane-name]').addEventListener('keydown', (event) => { if (event.key === 'Enter') apply(); });
      });
    }
    function removeLane(id){
      const lane = state.categories.find((item) => item.id === id);
      if (!lane) return;
      const using = boardsOf(state.templates, lanesOf(state.categories)).filter((board) => board.categories.includes(id));
      const go = () => saveCategories(state.categories.map((item) => item.id === id ? { ...item, enabled:false } : item));
      if (!using.length) return go();
      const confirmed = window.Portal?.ui?.confirm
        ? window.Portal.ui.confirm(t('m_116cf4a37f36f7', 'Remove the {lane} lane? Its boards stay, under “Boards not in a lane” if they are in no other.', { lane:lane.label }))
        : Promise.resolve(window.confirm(t('m_116cf4a37f36f7', 'Remove the {lane} lane? Its boards stay, under “Boards not in a lane” if they are in no other.', { lane:lane.label })));
      Promise.resolve(confirmed).then((ok) => { if (ok) go(); });
    }

    // ── Pointer: drag a board between lanes, drag or click-click a connection ─────────────────────────────────────
    const point = (event) => { const base = scroll.querySelector('[data-canvas]').getBoundingClientRect(); return { x:event.clientX - base.left, y:event.clientY - base.top }; };
    const targetAt = (event) => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const board = el?.closest?.('[data-board]'); if (board && scroll.contains(board)) return { id:board.dataset.board, el:board };
      const sink = el?.closest?.('[data-sink]'); if (sink && scroll.contains(sink)) return { id:'unscoped', el:sink };
      return null;
    };
    function onDown(event){
      if (event.button !== 0 || !state || !canEdit) return;
      const port = event.target.closest('[data-port]');
      const lead = event.target.closest('[data-lead]');
      const head = event.target.closest('[data-board-head]');
      if (event.target.closest('button,[data-rename],input,select')) return;
      if (port || lead) {
        const source = port ? port.dataset.port : `lead:${lead.dataset.lead}`;
        const from = port || lead;
        const r = from.getBoundingClientRect(), base = scroll.querySelector('[data-canvas]').getBoundingClientRect();
        gesture = { kind:'wire', source, start:{ x:event.clientX, y:event.clientY }, from:{ x:r.left + r.width / 2 - base.left, y:r.bottom - base.top }, moved:false, port:!!port, lead };
      } else if (head) {
        const board = head.closest('[data-board]');
        gesture = { kind:'board', id:head.dataset.boardHead, el:board, start:{ x:event.clientX, y:event.clientY }, moved:false };
      } else return;
      event.preventDefault();
      scroll.setPointerCapture?.(event.pointerId);
    }
    let dropEdge = null;
    function laneBoxes(){
      const base = scroll.querySelector('[data-canvas]').getBoundingClientRect();
      return [...scroll.querySelectorAll('[data-lane]')].map((el) => { const r = el.getBoundingClientRect(); return { el, top:r.top - base.top, bottom:r.bottom - base.top }; });
    }
    function onMove(event){
      if (!gesture) return;
      const dx = event.clientX - gesture.start.x, dy = event.clientY - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      closePop();
      scroll.querySelectorAll('.fmah-board.target').forEach((el) => el.classList.remove('target'));
      if (gesture.kind === 'wire') {
        gesture.draft = { from:gesture.from, to:point(event) };
        const target = targetAt(event);
        if (target?.el?.classList.contains('fmah-board')) target.el.classList.add('target');
        wire();
        return;
      }
      gesture.el.classList.add('moving');
      gesture.el.style.transform = `translate(${dx}px, ${dy}px)`;
      const boxes = laneBoxes();
      const rows = dropRows(point(event).y, boxes);
      boxes.forEach((box, index) => box.el.classList.toggle('drop', rows.length === 1 && rows[0] === index));
      dropEdge?.remove(); dropEdge = null;
      if (rows.length === 2) {
        const v = view();
        dropEdge = document.createElement('div');
        dropEdge.className = 'fmah-edge-drop';
        dropEdge.style.top = `${boxes[rows[0]].bottom}px`;
        dropEdge.innerHTML = `<span>${esc(t('m_712bc0ebe4a76a', 'In both: {a} and {b}', { a:v.lanes[rows[0]]?.label || '', b:v.lanes[rows[1]]?.label || '' }))}</span>`;
        scroll.querySelector('[data-canvas]').appendChild(dropEdge);
      }
      gesture.rows = rows;
    }
    function onUp(event){
      const g = gesture; gesture = null;
      if (!g) return;
      if (drawLater) draw();
      dropEdge?.remove(); dropEdge = null;
      scroll.querySelectorAll('.fmah-lane.drop').forEach((el) => el.classList.remove('drop'));
      scroll.querySelectorAll('.fmah-board.target').forEach((el) => el.classList.remove('target'));
      if (g.kind === 'wire') {
        if (!g.moved) {
          if (!g.port && g.lead) return openLead(g.lead, g.lead.dataset.lead);
          armed = g.source; draw(); return;
        }
        wire();
        const target = targetAt(event);
        if (target) connect(g.source, target.id);
        return;
      }
      if (!g.moved) return;
      g.el.classList.remove('moving'); g.el.style.transform = '';
      const v = view();
      const board = v.boards.find((item) => item.id === g.id);
      if (!board || !g.rows?.length) return;
      const categories = dropCategories(board.categories, v.lanes, g.rows);
      if (JSON.stringify(categories) === JSON.stringify(dropCategories(board.categories, v.lanes, board.rows))) return;
      const names = g.rows.map((row) => v.lanes[row]?.label).join(' · ');
      saveTemplate(board, { category_ids:categories }, t('m_0c06b0c67d9efa', '{board} is now in {lanes}', { board:board.name, lanes:names }));
    }
    function onClick(event){
      const collapse = event.target.closest('[data-collapse]');
      if (collapse) { const id = collapse.dataset.collapse; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); draw(); return; }
      if (armed) {
        const target = targetAt(event);
        const source = armed; armed = null;
        if (target) connect(source, target.id); else draw();
        return;
      }
      const link = event.target.closest('[data-link]');
      if (link) return openLink(link, link.dataset.link);
      const rename = event.target.closest('[data-rename]');
      if (rename) return renameLane(rename);
      const remove = event.target.closest('[data-lane-remove]');
      if (remove) return removeLane(remove.dataset.laneRemove);
      if (event.target.closest('[data-lane-add]')) return addLane(event.target.closest('[data-lane-add]'));
      if (event.target.closest('[data-use-rules]')) return saveRouting({ routing_mode:'formula' });
    }
    function onKey(event){
      if (event.key === 'Escape' && (armed || pop)) { event.stopPropagation(); closePop(); if (armed) { armed = null; draw(); } return; }
      const lead = event.target.closest?.('[data-lead]');
      if (lead && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openLead(lead, lead.dataset.lead); }
      const rename = event.target.closest?.('[data-rename]');
      if (rename && event.key === 'Enter') { event.preventDefault(); renameLane(rename); }
    }
    const onOutside = (event) => { if (pop && !pop.contains(event.target) && !event.target.closest?.('[data-lead],[data-link],[data-lane-add]')) closePop(); };
    scroll.addEventListener('pointerdown', onDown);
    scroll.addEventListener('pointermove', onMove);
    scroll.addEventListener('pointerup', onUp);
    scroll.addEventListener('pointercancel', () => { gesture = null; draw(); });
    scroll.addEventListener('click', onClick);
    scroll.addEventListener('keydown', onKey, true);
    scroll.addEventListener('mouseover', (event) => { const board = event.target.closest?.('[data-board]'); scroll.querySelectorAll('[data-fan]').forEach((path) => path.classList.toggle('hot', !!board && path.dataset.fan === board.dataset.board)); });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    const resize = new ResizeObserver(() => wire());
    resize.observe(scroll);

    // ── The setup panel ────────────────────────────────────────────────────────────────────────────────────────────
    /** The setup's handle on the chart: it previews answers before they are saved and points at what it talks about. */
    const handle = {
      view:() => state ? view() : null,
      ready:() => readyOnce,
      preview(next){ preview = next && typeof next === 'object' ? { ...next } : null; draw(); },
      spotlight(selector){ spot = selector || null; applySpot(); },
      reload:() => load(),
      orgId:() => orgId
    };
    let readyResolve; const readyOnce = new Promise((resolve) => { readyResolve = resolve; });
    window.FirstMateAutomationsHub.active = handle;

    function setPanel(open){ host.classList.toggle('fmah-panel-off', !open); requestAnimationFrame(() => wire()); }
    function rest(){
      panel.innerHTML = `<div class="fmah-panel-rest"><h2>${esc(t('m_516ec8f47ace74', 'How your projects flow'))}</h2>
        <p>${esc(t('m_71533116756a6c', 'New leads come in at the top and go onto a board. Boards are grouped in lanes, and one board can start another.'))}</p>
        <ul class="fmah-tips">
          <li><i class="fas fa-inbox" aria-hidden="true"></i><span>${esc(t('m_28663755a3e1c1', 'Click a new lead box to split leads by where they come from, when they arrive or where the job is.'))}</span></li>
          <li><i class="fas fa-circle-dot" aria-hidden="true"></i><span>${esc(t('m_5001f84bf22aac', 'Drag from the dot under a box onto a board to connect them. Or click the dot, then click the board.'))}</span></li>
          <li><i class="fas fa-up-down" aria-hidden="true"></i><span>${esc(t('m_8f64893f392b49', 'Drag a board by its title to another lane. Drop it on the line between two lanes to put it in both.'))}</span></li>
          <li><i class="fas fa-pen" aria-hidden="true"></i><span>${esc(t('m_9cbbc889b4d87b', 'Click a lane’s name to rename it. Click a connection to see or remove it.'))}</span></li>
        </ul>
        ${canEdit ? `<button type="button" class="fmah-btn primary" data-setup-run><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${esc(t('m_4ceb80e729b2d6', 'Run the setup'))}</button>` : ''}</div>`;
      panel.querySelector('[data-setup-run]')?.addEventListener('click', () => runSetup());
    }
    async function runSetup(){
      const guides = window.FirstMateGuides;
      if (playing || !canEdit || !guides?.play) { rest(); return; }
      setPanel(true);
      panel.innerHTML = '';
      playing = new AbortController();
      let outcome = null;
      try { outcome = await guides.play(SETUP_ID, { replay:true, force:true, container:panel, signal:playing.signal }); }
      catch (error) { console.warn('The automations setup did not play.', error); }
      finally {
        playing = null;
        preview = null; spot = null;
        if (!destroyed) { rest(); await load().catch(() => null); }
      }
      if (outcome?.status === 'unavailable') say(t('m_2332b2087a779e', 'The setup is not available here yet.'), true);
    }
    host.querySelector('[data-setup-toggle]').addEventListener('click', () => {
      const open = host.classList.contains('fmah-panel-off');
      setPanel(open);
      if (open && !playing) rest();
    });
    host.querySelector('[data-panel-close]').addEventListener('click', () => setPanel(false));

    rest();
    load().then(() => {
      readyResolve();
      // Not set up yet (where new leads go was never saved): the setup starts by itself, beside the chart.
      if (!destroyed && canEdit && state?.routing && !Number(state.routing.revision)) runSetup();
    }).catch((error) => { scroll.innerHTML = `<div class="fmah-empty">${esc(clean(error?.message) || t('m_1a8bcb847b9f37', 'Your boards could not be loaded.'))}</div>`; });

    return { destroy(){
      destroyed = true; playing?.abort(); closePop(); resize.disconnect();
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      if (window.FirstMateAutomationsHub.active === handle) window.FirstMateAutomationsHub.active = null;
      host.remove();
    } };
  }

  runtime.registerApp({
    id:'portal.automations_hub', package:'automations-hub', kind:'portal_tab',
    title:t('m_a677e3388e9b31', 'Automations Hub'), label:t('m_a677e3388e9b31', 'Automations Hub'), icon:'fa-diagram-project', order:62,
    surfaces:['portal_tab'], regions:['main'], visible:true, fullBleed:true,
    access:{ capability:'apps.projects' },
    mount
  });
})();
