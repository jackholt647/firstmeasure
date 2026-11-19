/*
 * What drives setup (GP-16): the Setup section's full-screen diagram. Left to right: the questions asked once (setup
 * steps, each after what it requires), the company facts their answers set (company type, industry, the catalog's
 * industry sets, services) and the other facts conditions read, the guided setups with their variants and pages, and
 * what each plays next. A line is why: a question asked before a setup or one of its pages, a fact a setup's or a
 * variant's condition reads (solid when it holds for the company shown, dashed when not), a follow-up. Hover or tap
 * anything for the detail. A setup's pages are folded under its title until opened (GP-30); a folded page's lines are
 * drawn to the title. "Show for" plays it as another kind of company (only the company facts change; apps and
 * permissions stay this organization's); "By company type" is every kind at once: which setups and variants each gets.
 * GET /v1/signup-sandbox/development/console/setup/drivers?company_type=… (development/setup-drivers.ts). Reads only.
 */
const FIELDS = {
  'organization.company_type': ['dc_setup_map_f_company_type', 'Company type', 'fa-building'],
  'organization.industry': ['dc_setup_map_f_industry', 'Industry', 'fa-industry'],
  'organization.industry_sets': ['dc_setup_map_f_industry_sets', 'Industry sets', 'fa-layer-group'],
  'organization.services': ['dc_setup_map_f_services', 'Kinds of work', 'fa-screwdriver-wrench'],
  'organization.flags.assistant': ['dc_setup_map_f_assistant', 'Assistant on', 'fa-wand-magic-sparkles'],
  'organization.capabilities.assistant': ['dc_setup_map_f_assistant', 'Assistant on', 'fa-wand-magic-sparkles'],
  'organization.flags.materials': ['dc_setup_map_f_materials', 'Operations on', 'fa-boxes-stacked'],
  'surface.tab': ['dc_setup_map_f_surface', 'Opened from', 'fa-window-maximize'],
  'organization.finished': ['dc_setup_map_f_finished', 'Setups finished', 'fa-flag-checkered'],
  'person.eligible': ['dc_setup_map_f_eligible', 'Setups they may play', 'fa-user-check'],
  'organization.region': ['dc_setup_map_f_region', 'Region', 'fa-map'],
  'organization.size.tier': ['dc_setup_map_f_size', 'Company size', 'fa-users']
};
const OPS = { equals: ['dc_setup_map_op_is', 'is'], not_equals: ['dc_setup_map_op_is_not', 'is not'], in: ['dc_setup_map_op_in', 'is one of'], not_in: ['dc_setup_map_op_not_in', 'is not one of'],
  contains: ['dc_setup_map_op_contains', 'includes'], not_contains: ['dc_setup_map_op_not_contains', 'does not include'], is_missing: ['dc_setup_map_op_missing', 'is empty'], is_present: ['dc_setup_map_op_present', 'is set'] };
const TRIGGERS = { tab_opened: ['dc_setup_map_t_tab', 'Opens with the tab', 'fa-table-columns'], before_action: ['dc_setup_map_t_action', 'Before the button', 'fa-hand-pointer'],
  after_experience: ['dc_setup_map_t_after', 'After', 'fa-forward-step'], app_loaded: ['dc_setup_map_t_app', 'When the app loads', 'fa-bolt'], workflow_opened: ['dc_setup_map_t_workflow', 'When a document workflow opens', 'fa-file-lines'],
  panel_opened: ['dc_setup_map_t_panel', 'When a panel opens', 'fa-table-cells'], panel_closed: ['dc_setup_map_t_panel_closed', 'When a panel closes', 'fa-table-cells'], manual: ['dc_setup_map_t_manual', 'Started by a button', 'fa-play'] };
let shown = 'actual', view = 'diagram';
/** Setups whose pages are open; every other one is folded (GP-30). Kept while the page is open. */
const unfolded = new Set();

export function openDrivers({ api, T, esc, phone }) {
  document.querySelector('.fm-dc-map')?.dispatchEvent(new Event('fm-dc-map-close'));
  const small = phone();
  const shell = document.createElement('div');
  shell.className = `fm-dc-map${small ? ' fm-dc-map-phone' : ''}`;
  shell.setAttribute('data-fmr-ignore', ''); shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', T('dc_setup_map_title', 'What drives setup'));
  shell.innerHTML = `<header class="fm-dc-map-bar">
      <span class="fm-dc-map-title"><strong>${esc(T('dc_setup_map_title', 'What drives setup'))}</strong><small data-map-state>${esc(T('dc_setup_map_loading', 'Reading…'))}</small></span>
      <label class="fm-dc-map-pick"><span>${esc(T('dc_setup_map_show_for', 'Show for'))}</span><select data-map-company></select></label>
      <button type="button" class="fm-dc-btn fm-dc-map-fold-all" data-map-fold-all aria-pressed="false"><i class="fas fa-angles-down" aria-hidden="true"></i><span>${esc(T('dc_setup_map_expand_all', 'Open all'))}</span></button>
      <span class="fm-dc-map-views" role="group">${[['diagram', 'fa-diagram-project', T('dc_setup_map_view_diagram', 'Diagram')], ['matrix', 'fa-table-cells', T('dc_setup_map_view_matrix', 'By company type')]].map(([key, icon, label]) => `<button type="button" data-map-view="${key}" aria-pressed="${key === view}" title="${esc(label)}"><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(label)}</span></button>`).join('')}</span>
      <button type="button" class="fm-dc-btn" data-map-close aria-label="${esc(T('dc_setup_test_close', 'Close'))}" title="${esc(T('dc_setup_test_close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
    </header>
    <div class="fm-dc-map-stage" data-map-stage></div>
    <div class="fm-dc-map-tip" role="tooltip" hidden></div>`;
  (small ? document.documentElement : document.body).append(shell);
  const stage = shell.querySelector('[data-map-stage]'), tip = shell.querySelector('.fm-dc-map-tip'), stateEl = shell.querySelector('[data-map-state]'), select = shell.querySelector('[data-map-company]');
  let data = null, token = 0, pinned = '', observer = null;

  const fieldLabel = (field) => FIELDS[field] ? T(FIELDS[field][0], FIELDS[field][1]) : field.startsWith('selections.') ? `${T('dc_setup_map_f_answer', 'Answer')} “${field.slice(11)}”` : field;
  const fieldIcon = (field) => FIELDS[field]?.[2] || (field.startsWith('selections.') ? 'fa-reply' : 'fa-circle-info');
  const typeLabel = (id) => data?.company.types.find((type) => type.id === id)?.label || (id === 'other' ? T('dc_setup_map_other', 'Other') : id);
  const setLabel = (id) => data?.company.sets.find((set) => set.id === id)?.label || id;
  const setupTitle = (id) => data?.setups.find((setup) => setup.id === id)?.title || id;
  /** The launchers that start this setup from somewhere else (GP-59). Played inside them, its `then` does not follow. */
  const launchers = (id) => (data?.setups || []).filter((setup) => setup.launcher && setup.opens?.includes(id));
  const questionTitle = (id) => data?.questions.find((question) => question.id === id)?.title || id;
  /** A value as people read it: a set, company type or service by its label. */
  function valueText(field, value) {
    const list = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
    if (!list.length) return T('dc_setup_map_empty', 'nothing');
    const one = field === 'organization.industry_sets' ? setLabel : field === 'organization.company_type' ? typeLabel : (entry) => String(entry);
    return list.map(one).join(', ');
  }
  const ruleText = (rule) => `${fieldLabel(rule.field)} ${T(...(OPS[rule.operator] || [`dc_setup_map_op_${rule.operator}`, rule.operator]))}${['is_missing', 'is_present'].includes(rule.operator) ? '' : ` ${valueText(rule.field, rule.expected)}`}`;
  const ruleLines = (trace, simulated = true) => !trace ? [] : [
    ...(trace.rules.length > 1 ? [trace.match === 'any' ? T('dc_setup_map_any', 'When any of:') : T('dc_setup_map_all', 'When all of:')] : []),
    ...trace.rules.map((rule) => `${simulated ? (rule.matched ? '✓ ' : '✗ ') : '· '}${ruleText(rule)}`)
  ];

  // ---------------------------------------------------------------- the graph: nodes by column, and the lines between them
  function graph() {
    const nodes = new Map(), edges = [];
    const facts = new Set(data.company.facts);
    const readBy = (trace) => (trace?.rules || []).map((rule) => rule.field).filter((field) => !field.startsWith('selections.'));
    for (const setup of data.setups) {
      for (const field of readBy(setup.when)) facts.add(field);
      for (const variant of setup.variants) for (const field of readBy(variant.when)) facts.add(field);
    }
    // A launcher (its pages only open another setup: the Equipment Setup tag on a project's Operations tab) is not a
    // setup of its own; it is told on the setup it opens (GP-59).
    const setups = data.setups.filter((setup) => setup.group === 'setup' && !setup.launcher);
    const ids = new Set(setups.map((setup) => setup.id));
    // Follow-ups: what a setup plays when it finishes, and what starts after one.
    const after = new Map();
    for (const setup of data.setups) {
      for (const id of setup.then) if (ids.has(setup.id)) after.set(id, [...(after.get(id) || []), setup.id]);
      for (const trigger of setup.triggers) if (trigger.kind === 'after_experience' && ids.has(trigger.on)) after.set(setup.id, [...(after.get(setup.id) || []), trigger.on]);
    }
    // A tour whose own condition reads a fact is part of the picture too.
    const nexts = data.setups.filter((setup) => !ids.has(setup.id) && !setup.launcher && (after.has(setup.id) || setup.when || setup.variants.some((variant) => variant.when && readBy(variant.when).length)));
    for (const question of data.questions) {
      nodes.set(`q:${question.id}`, { column: `q${question.depth}`, kind: 'question', item: question });
      for (const before of question.requires) edges.push({ from: `q:${before}`, to: `q:${question.id}`, kind: 'requires' });
      for (const field of question.sets) edges.push({ from: `q:${question.id}`, to: `f:${field}`, kind: 'sets' });
    }
    for (const field of facts) nodes.set(`f:${field}`, { column: 'facts', kind: 'fact', field });
    for (const setup of [...setups, ...nexts]) {
      const column = ids.has(setup.id) ? 'setups' : 'next';
      nodes.set(`s:${setup.id}`, { column, kind: 'setup', item: setup });
      for (const id of setup.requires) edges.push({ from: `q:${id}`, to: `s:${setup.id}`, kind: 'asks' });
      for (const field of new Set(readBy(setup.when))) edges.push({ from: `f:${field}`, to: `s:${setup.id}`, kind: 'when', on: !!setup.when?.matched });
      for (const variant of setup.variants) {
        nodes.set(`v:${setup.id}:${variant.id}`, { parent: `s:${setup.id}`, kind: 'variant', item: variant, setup });
        for (const field of new Set(readBy(variant.when))) edges.push({ from: `f:${field}`, to: `v:${setup.id}:${variant.id}`, kind: 'when', on: variant.chosen });
      }
      for (const page of setup.pages) {
        nodes.set(`p:${setup.id}:${page.id}`, { parent: `s:${setup.id}`, kind: 'page', item: page, setup });
        for (const id of page.requires) edges.push({ from: `q:${id}`, to: `p:${setup.id}:${page.id}`, kind: 'asks' });
      }
    }
    for (const [id, from] of after) for (const source of from) if (nodes.has(`s:${id}`)) edges.push({ from: `s:${source}`, to: `s:${id}`, kind: 'then' });
    return { nodes, edges: edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)) };
  }

  /** Pages the chosen variant plays (all of them when several variants share the choice). */
  const played = (setup) => new Set(setup.variants.filter((variant) => variant.chosen).flatMap((variant) => variant.steps));
  const setupState = (setup) => !setup.apps_on ? 'off' : setup.offered ? 'on' : 'not';

  function questionHtml(question) {
    return `<button type="button" class="fm-dc-map-node fm-dc-map-q" data-map-node="q:${esc(question.id)}">
      <i class="fas ${question.answered ? 'fa-circle-check' : 'fa-circle-question'}" aria-hidden="true"></i><span>${esc(question.title)}</span></button>`;
  }
  function factHtml(field) {
    const value = data.company.facts.includes(field) ? data.company.as_shown[field.split('.').pop()] : field === 'organization.flags.assistant' || field === 'organization.capabilities.assistant' ? data.context.assistant : null;
    const shownValue = value === null || value === undefined ? '' : typeof value === 'boolean' ? (value ? T('dc_setup_map_yes', 'yes') : T('dc_setup_map_no', 'no'))
      : field === 'organization.services' ? `${value.length}` : valueText(field, value);
    return `<button type="button" class="fm-dc-map-node fm-dc-map-f" data-map-node="f:${esc(field)}"><i class="fas ${fieldIcon(field)}" aria-hidden="true"></i><span>${esc(fieldLabel(field))}${shownValue ? `<b>${esc(shownValue)}</b>` : ''}</span></button>`;
  }
  const foldable = (setup) => setup.group === 'setup' && setup.pages.length > 0;
  function setupHtml(setup) {
    const state = setupState(setup), plays = played(setup), fold = foldable(setup), open = unfolded.has(setup.id);
    const icon = state === 'off' ? 'fa-lock' : state === 'not' ? 'fa-ban' : setup.group === 'setup' ? 'fa-wand-magic' : 'fa-route';
    const foldLabel = `${open ? T('dc_setup_map_fold', 'Hide its pages') : T('dc_setup_map_unfold', 'Show its pages')} (${setup.pages.length})`;
    return `<div class="fm-dc-map-card" data-state="${state}"${fold ? ` data-open="${open}"` : ''}>
      <div class="fm-dc-map-head"><button type="button" class="fm-dc-map-node fm-dc-map-s" data-map-node="s:${esc(setup.id)}"><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(setup.title)}</span>
        <span class="fm-dc-map-trig">${setup.triggers.map((trigger) => `<i class="fas ${(TRIGGERS[trigger.kind] || TRIGGERS.manual)[2]}" aria-hidden="true"></i>`).join('')}</span></button>
        ${fold ? `<button type="button" class="fm-dc-map-fold" data-map-fold="${esc(setup.id)}" aria-expanded="${open}" aria-label="${esc(foldLabel)}" title="${esc(foldLabel)}"><small>${setup.pages.length}</small><i class="fas fa-chevron-down" aria-hidden="true"></i></button>` : ''}</div>
      ${setup.variants.length > 1 ? `<span class="fm-dc-map-variants">${setup.variants.map((variant) => `<button type="button" class="fm-dc-map-node fm-dc-map-v" data-map-node="v:${esc(setup.id)}:${esc(variant.id)}" data-chosen="${variant.chosen}">${esc(variant.id)}${variant.chosen && variant.share < 1 ? ` <small>${Math.round(variant.share * 100)}%</small>` : ''}</button>`).join('')}</span>` : ''}
      ${fold ? `<ol class="fm-dc-map-pages"${open ? '' : ' hidden'}>${setup.pages.map((page) => `<li><button type="button" class="fm-dc-map-node fm-dc-map-p" data-map-node="p:${esc(setup.id)}:${esc(page.id)}" data-played="${plays.has(page.id) && page.apps_on}">${page.branches.length ? '<i class="fas fa-code-branch" aria-hidden="true"></i>' : ''}${page.apps_on ? '' : '<i class="fas fa-lock" aria-hidden="true"></i>'}<span>${esc(page.title)}</span></button></li>`).join('')}</ol>` : ''}
    </div>`;
  }

  function renderDiagram() {
    const { nodes, edges } = graph();
    const depths = [...new Set(data.questions.map((question) => question.depth))].sort((a, b) => a - b);
    const column = (key, heading, html) => html ? `<section class="fm-dc-map-col" data-col="${key}">${heading ? `<h4>${esc(heading)}</h4>` : ''}${html}</section>` : '';
    const of = (key) => [...nodes.entries()].filter(([, node]) => node.column === key);
    stage.innerHTML = `<div class="fm-dc-map-canvas" data-map-canvas><svg class="fm-dc-map-edges" aria-hidden="true"></svg>
      ${depths.map((depth, index) => column(`q${depth}`, index === 0 ? T('dc_setup_map_questions', 'Questions asked once') : '', of(`q${depth}`).map(([, node]) => questionHtml(node.item)).join(''))).join('')}
      ${column('facts', T('dc_setup_map_facts', 'What they said, as facts'), of('facts').map(([, node]) => factHtml(node.field)).join(''))}
      ${column('setups', T('dc_setup_map_setups', 'Guided setups'), of('setups').map(([, node]) => setupHtml(node.item)).join(''))}
      ${column('next', T('dc_setup_map_next', 'Then'), of('next').map(([, node]) => setupHtml(node.item)).join(''))}
    </div>
    <ul class="fm-dc-map-legend">
      <li data-edge="asks">${esc(T('dc_setup_map_legend_asks', 'asked first'))}</li><li data-edge="sets">${esc(T('dc_setup_map_legend_sets', 'answer sets'))}</li>
      <li data-edge="when" data-on="true">${esc(T('dc_setup_map_legend_on', 'condition holds'))}</li><li data-edge="when" data-on="false">${esc(T('dc_setup_map_legend_off', 'condition does not hold'))}</li>
      <li data-edge="then">${esc(T('dc_setup_map_legend_then', 'plays next'))}</li></ul>`;
    stage._graph = { nodes, edges };
    drawEdges();
    observer?.disconnect();
    observer = new ResizeObserver(() => drawEdges());
    observer.observe(stage.querySelector('[data-map-canvas]'));
  }
  /** Where a line ends: the node itself, or for a page folded away its setup's title. */
  const anchorOf = (key) => {
    const el = stage.querySelector(`[data-map-node="${CSS.escape(key)}"]`);
    if (el?.getClientRects().length) return el;
    const parent = stage._graph.nodes.get(key)?.parent;
    return parent ? anchorOf(parent) : null;
  };
  function drawEdges() {
    const canvas = stage.querySelector('[data-map-canvas]'), svg = canvas?.querySelector('svg');
    if (!svg || !stage._graph) return;
    const box = canvas.getBoundingClientRect();
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    const paths = [], drawn = new Set();
    for (const [index, edge] of stage._graph.edges.entries()) {
      const a = anchorOf(edge.from), b = anchorOf(edge.to);
      if (!a || !b) continue;
      // Several pages of a folded setup asked after one question are one line to its title.
      const same = `${a.dataset.mapNode}>${b.dataset.mapNode}:${edge.kind}:${edge.on ?? ''}`;
      if (drawn.has(same)) continue;
      drawn.add(same);
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - box.left, y1 = ra.top + ra.height / 2 - box.top, x2 = rb.left - box.left, y2 = rb.top + rb.height / 2 - box.top;
      const bend = Math.max(30, Math.abs(x2 - x1) / 2);
      paths.push(`<path data-edge="${edge.kind}" data-on="${edge.on ?? ''}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" data-i="${index}" d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}"/>`);
    }
    svg.innerHTML = `<defs><marker id="fm-dc-map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${paths.join('')}`;
    if (pinned) focusNode(pinned);
  }

  // ---------------------------------------------------------------- hover and tap: light up what it touches, say why
  function linked(key) {
    const keys = new Set([key]);
    const parent = stage._graph.nodes.get(key)?.parent;
    const own = (edge) => edge.from === key || edge.to === key;
    for (const edge of stage._graph.edges) if (own(edge)) { keys.add(edge.from); keys.add(edge.to); }
    // A card lights up with its variants and pages; a variant or page with its card.
    if (parent) keys.add(parent);
    for (const [other, node] of stage._graph.nodes) if (node.parent === key) {
      keys.add(other);
      for (const edge of stage._graph.edges) if (edge.to === other) keys.add(edge.from);
    }
    return keys;
  }
  function focusNode(key) {
    const canvas = stage.querySelector('[data-map-canvas]');
    if (!canvas || !stage._graph?.nodes.has(key)) return;
    const keys = linked(key);
    // A card's lines are its own and its variants' and pages'; a variant's or page's are only its own.
    const ends = new Set([key, ...[...stage._graph.nodes].filter(([, node]) => node.parent === key).map(([other]) => other)]);
    canvas.dataset.focus = 'true';
    canvas.querySelectorAll('[data-map-node]').forEach((el) => { el.dataset.lit = String(keys.has(el.dataset.mapNode)); });
    canvas.querySelectorAll('path[data-from]').forEach((path) => { path.dataset.lit = String(ends.has(path.dataset.from) || ends.has(path.dataset.to)); });
  }
  function blur() {
    const canvas = stage.querySelector('[data-map-canvas]');
    if (!canvas) return;
    delete canvas.dataset.focus;
    canvas.querySelectorAll('[data-lit]').forEach((el) => { delete el.dataset.lit; });
  }

  function tipLines(key) {
    const node = stage._graph?.nodes.get(key);
    if (!node) return null;
    const { edges } = stage._graph;
    const into = (kind) => edges.filter((edge) => edge.to === key && (!kind || edge.kind === kind));
    const out = (kind) => edges.filter((edge) => edge.from === key && (!kind || edge.kind === kind));
    const titleOf = (target) => target.startsWith('q:') ? questionTitle(target.slice(2)) : target.startsWith('f:') ? fieldLabel(target.slice(2))
      : target.startsWith('s:') ? setupTitle(target.slice(2)) : (() => { const other = stage._graph.nodes.get(target); return other ? `${other.setup.title} › ${other.item.title || other.item.id}` : target; })();
    if (node.kind === 'question') {
      const q = node.item;
      return { title: q.title, icon: 'fa-circle-question', lines: [
        q.answered ? `✓ ${T('dc_setup_map_answered', 'Answered for this organization')}` : T('dc_setup_map_unanswered', 'Not answered: asked by the first setup that needs it'),
        ...(q.requires.length ? [`${T('dc_setup_requires', 'Asked after')}: ${q.requires.map(questionTitle).join(', ')}`] : []),
        ...(out('asks').length ? [`${T('dc_setup_map_asked_before', 'Asked before')}: ${out('asks').map((edge) => titleOf(edge.to)).join('; ')}`] : []),
        ...(q.sets.length ? [`${T('dc_setup_map_sets', 'Its answer sets')}: ${q.sets.map(fieldLabel).join(', ')}`] : []),
        ...(q.may_answer ? [] : [T('dc_setup_map_may_not', 'You may not answer it: setups play without it for you.')]),
        `${q.id}${q.scope === 'person' ? ` · ${T('dc_setup_per_person', 'each person answers')}` : ''}`] };
    }
    if (node.kind === 'fact') {
      const field = node.field, company = data.company.facts.includes(field);
      const value = company ? data.company.as_shown[field.split('.').pop()] : field.endsWith('.assistant') ? data.context.assistant : undefined;
      return { title: fieldLabel(field), icon: fieldIcon(field), lines: [
        ...(value !== undefined ? [`${T('dc_setup_map_value', 'For the company shown')}: ${typeof value === 'boolean' ? (value ? T('dc_setup_map_yes', 'yes') : T('dc_setup_map_no', 'no')) : valueText(field, value)}`] : []),
        ...(field === 'organization.industry_sets' ? data.company.sets.map((set) => `${set.label}: ${set.industries.join(', ')}`) : []),
        ...(into('sets').length ? [`${T('dc_setup_map_from', 'From the answer to')}: ${into('sets').map((edge) => titleOf(edge.from)).join(', ')}`] : []),
        ...(out('when').length ? [`${T('dc_setup_map_read_by', 'Decides')}: ${out('when').map((edge) => `${edge.on ? '✓' : '✗'} ${titleOf(edge.to)}`).join('; ')}`] : []),
        field] };
    }
    if (node.kind === 'setup') {
      const s = node.item, state = setupState(s);
      return { title: s.title, icon: 'fa-wand-magic', lines: [
        state === 'off' ? `🔒 ${T('dc_setup_map_apps_off', 'Not offered here: an app it needs is off, or you lack its permission')} (${[...s.apps.capabilities, ...s.apps.permissions].join(', ')})`
          : state === 'not' ? `✗ ${T('dc_setup_map_not_offered', 'Not offered to this kind of company')}` : `✓ ${T('dc_setup_map_offered', 'Offered to this company')}`,
        ...(state === 'off' && s.when ? [s.fits ? `✓ ${T('dc_setup_map_fits', 'This kind of company would get it')}` : `✗ ${T('dc_setup_map_not_offered', 'Not offered to this kind of company')}`] : []),
        ...ruleLines(s.when),
        ...s.triggers.map((trigger) => `${T(...(TRIGGERS[trigger.kind] || TRIGGERS.manual).slice(0, 2))}${trigger.on ? `: ${trigger.kind === 'after_experience' ? setupTitle(trigger.on) : trigger.on}` : ''}${trigger.when ? ` (${ruleLines(trigger.when, false).join(' ').replace(/^· /, '')})` : ''}`),
        ...(s.requires.length ? [`${T('dc_setup_map_asks_first', 'Asks first')}: ${s.requires.map(questionTitle).join(', ')}`] : []),
        ...(s.variants.length > 1 ? [`${T('dc_setup_map_variants', 'Variants')}: ${s.variants.map((variant) => `${variant.chosen ? '●' : '○'} ${variant.id}`).join('  ')}`] : []),
        ...(s.then.length ? [`${T('dc_setup_map_then', 'Then plays')}: ${s.then.map(setupTitle).join(', ')}`] : []),
        ...(s.opens?.length ? [`${T('dc_setup_map_opens', 'Opens')}: ${s.opens.map(setupTitle).join(', ')}`] : []),
        ...launchers(s.id).map((launcher) => `${T('dc_setup_map_launched', 'Also started from')}: ${launcher.title} (${launcher.id})${s.then.length ? `, ${T('dc_setup_map_launched_then', 'without what it then plays')}` : ''}`),
        s.id] };
    }
    if (node.kind === 'variant') {
      const v = node.item, setup = node.setup;
      return { title: `${setup.title} › ${v.id}`, icon: 'fa-code-fork', lines: [
        v.chosen ? `● ${T('dc_setup_map_chosen', 'Chosen for this company')}${v.share < 1 ? ` (${Math.round(v.share * 100)}% ${T('dc_setup_map_split', 'of a split')})` : ''}` : v.weight === 0 ? T('dc_setup_map_weight_zero', 'Weight 0: defined, never chosen') : `○ ${T('dc_setup_map_not_chosen', 'Not chosen for this company')}`,
        ...(v.when ? ruleLines(v.when) : [T('dc_setup_map_no_condition', 'No condition: anyone may get it')]),
        `${T('dc_setup_map_pages', 'Pages')}: ${v.steps.map((id) => setup.pages.find((page) => page.id === id)?.title || id).join(' → ') || '—'}`,
        ...(v.content.length ? [`${T('dc_setup_map_content', 'Own content for')}: ${v.content.join(', ')}`] : [])] };
    }
    const p = node.item, setup = node.setup, plays = played(setup).has(p.id);
    const goes = (branch) => `→ ${setup.pages.find((page) => page.id === branch.to)?.title || branch.to}${branch.when ? ` ${T('dc_setup_map_when', 'when')} ${ruleLines(branch.when, false).map((line) => line.replace(/^· /, '')).join(' ')}` : ` ${T('dc_setup_map_otherwise', 'otherwise')}`}`;
    return { title: `${setup.title} › ${p.title}`, icon: 'fa-file', lines: [
      !p.apps_on ? `🔒 ${T('dc_setup_map_page_off', 'Skipped here: needs')} ${p.apps.join(', ')}` : plays ? `✓ ${T('dc_setup_map_page_on', 'Shown to this company')}` : `✗ ${T('dc_setup_map_page_not', 'Not in the variant this company gets')}`,
      ...(p.requires.length ? [`${T('dc_setup_map_asks_first', 'Asks first')}: ${p.requires.map(questionTitle).join(', ')}`] : []),
      ...p.branches.map(goes), ...(p.next ? [`→ ${setup.pages.find((page) => page.id === p.next)?.title || p.next}`] : []),
      p.id] };
  }
  function showTip(key, el) {
    const content = tipLines(key);
    if (!content) { tip.hidden = true; return; }
    tip.innerHTML = `<strong><i class="fas ${content.icon}" aria-hidden="true"></i> ${esc(content.title)}</strong>${content.lines.map((line) => `<span>${esc(line)}</span>`).join('')}`;
    tip.hidden = false;
    const r = el.getBoundingClientRect(), host = shell.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let left = r.right + 10 - host.left, top = r.top - host.top;
    if (left + w > host.width - 8) left = Math.max(8, r.left - host.left - w - 10);
    if (top + h > host.height - 8) top = Math.max(56, host.height - h - 8);
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------------------------------------------------------------- every company type at once
  function renderMatrix() {
    const { columns, rows } = data.matrix;
    const byId = new Map(data.setups.map((setup) => [setup.id, setup]));
    // What the kind of company decides (`fits`); an app that is off here is the row's lock, the same in every column.
    const key = (cell) => cell.fits ? cell.variants.join('+') || '·' : '—';
    const varies = (row) => new Set(row.cells.map(key)).size > 1;
    const list = rows.filter((row) => byId.has(row.id) && !byId.get(row.id).launcher);
    const changing = list.filter(varies), same = list.filter((row) => !varies(row));
    const palette = new Map();
    const tone = (setupId, variant) => { const k = `${setupId}:${variant}`; if (!palette.has(k)) palette.set(k, byId.get(setupId).variants.findIndex((entry) => entry.id === variant) % 6); return palette.get(k); };
    const cellHtml = (row, cell, index) => {
      const column = columns[index], setup = byId.get(row.id);
      const why = !cell.fits ? T('dc_setup_map_not_offered', 'Not offered to this kind of company') : `${cell.variants.length ? `${T('dc_setup_map_gets', 'Gets')} ${cell.variants.join(' / ')}` : T('dc_setup_map_offered_short', 'Offered')}${setup.apps_on ? '' : ` (${T('dc_setup_map_app_off_here', 'its app is off here')})`}`;
      const title = `${setup.title} · ${column.label}: ${why}`;
      return `<td data-col="${esc(column.key)}" data-shown="${column.key === shown}" data-app-off="${!setup.apps_on}" title="${esc(title)}">${!cell.fits ? `<i class="fas fa-minus fm-dc-map-off" aria-label="${esc(why)}"></i>`
        : setup.variants.length > 1 ? cell.variants.map((variant) => `<span class="fm-dc-map-pill" data-tone="${tone(row.id, variant)}">${esc(variant)}</span>`).join('') : '<i class="fas fa-circle-check fm-dc-map-yes" aria-hidden="true"></i>'}</td>`;
    };
    const rowHtml = (row) => `<tr><th scope="row" title="${esc(row.id)}">${byId.get(row.id).apps_on ? '' : `<i class="fas fa-lock fm-dc-map-off" title="${esc(`${T('dc_setup_map_apps_off', 'Not offered here: an app it needs is off, or you lack its permission')} (${[...byId.get(row.id).apps.capabilities, ...byId.get(row.id).apps.permissions].join(', ')})`)}"></i> `}${esc(byId.get(row.id).title)}<small>${esc(byId.get(row.id).group === 'setup' ? T('dc_setup_map_setup', 'setup') : T('dc_setup_map_tour', 'tour'))}</small></th>${row.cells.map((cell, index) => cellHtml(row, cell, index)).join('')}</tr>`;
    const header = `<tr><th></th>${columns.map((column) => `<th scope="col" data-shown="${column.key === shown}"><button type="button" data-map-show="${esc(column.key)}" title="${esc(`${column.label}${column.industry ? ` · ${column.industry}` : ''}${column.industry_sets.length ? ` · ${column.industry_sets.map(setLabel).join(', ')}` : ''}`)}"><span>${esc(column.label)}</span></button></th>`).join('')}</tr>`;
    stage.innerHTML = `<div class="fm-dc-map-matrix">
      <p class="fm-dc-map-note">${esc(T('dc_setup_map_matrix_note', 'Each column is a kind of company; each cell is what that company gets. A name heading a column opens the diagram for it.'))}</p>
      ${changing.length ? `<h4>${esc(T('dc_setup_map_varies', 'Different by kind of company'))} · ${changing.length}</h4><div class="fm-dc-map-scroll"><table>${header}${changing.map(rowHtml).join('')}</table></div>`
        : `<p class="fm-dc-note">${esc(T('dc_setup_map_none_vary', 'Every setup is the same for every kind of company.'))}</p>`}
      ${same.length ? `<details${changing.length ? '' : ' open'}><summary><h4>${esc(T('dc_setup_map_same', 'The same for every kind of company'))} · ${same.length}</h4></summary><div class="fm-dc-map-scroll"><table>${header}${same.map(rowHtml).join('')}</table></div></details>` : ''}
    </div>`;
  }

  function syncFoldAll() {
    const all = data && view === 'diagram' && data.setups.filter(foldable).every((setup) => unfolded.has(setup.id));
    const button = shell.querySelector('[data-map-fold-all]'), label = all ? T('dc_setup_map_collapse_all', 'Fold all') : T('dc_setup_map_expand_all', 'Open all');
    button.setAttribute('aria-pressed', String(!!all)); button.title = label;
    button.querySelector('span').textContent = label;
    button.querySelector('i').className = `fas ${all ? 'fa-angles-up' : 'fa-angles-down'}`;
  }
  /** Open or fold setups' pages in place; the lines follow. */
  function setFold(ids, open) {
    for (const id of ids) {
      open ? unfolded.add(id) : unfolded.delete(id);
      const card = stage.querySelector(`[data-map-fold="${CSS.escape(id)}"]`)?.closest('.fm-dc-map-card');
      if (!card) continue;
      const setup = data.setups.find((entry) => entry.id === id), label = `${open ? T('dc_setup_map_fold', 'Hide its pages') : T('dc_setup_map_unfold', 'Show its pages')} (${setup.pages.length})`;
      const button = card.querySelector('[data-map-fold]');
      card.dataset.open = String(open); button.setAttribute('aria-expanded', String(open)); button.title = label; button.setAttribute('aria-label', label);
      card.querySelector('.fm-dc-map-pages').hidden = !open;
    }
    // A pinned page that folded away lets go; the rest stays lit.
    if (pinned && !stage.querySelector(`[data-map-node="${CSS.escape(pinned)}"]`)?.getClientRects().length) { pinned = ''; blur(); }
    hideTip(); drawEdges(); syncFoldAll();
  }

  function render() {
    if (!data) return;
    hideTip(); pinned = '';
    observer?.disconnect(); observer = null;
    const actual = data.company.actual;
    select.innerHTML = [
      `<option value="actual">${esc(T('dc_setup_map_this_org', 'This organization'))}${actual.label ? ` (${esc(actual.label)})` : ''}</option>`,
      ...data.company.types.map((type) => `<option value="${esc(type.id)}">${esc(type.label)}</option>`),
      `<option value="other">${esc(T('dc_setup_map_other', 'Other'))}</option>`,
      `<option value="none">${esc(T('dc_setup_map_not_answered', 'Not answered yet'))}</option>`
    ].join('');
    select.value = data.company.shown;
    const as = data.company.as_shown;
    stateEl.textContent = as.company_type ? `${typeLabel(as.company_type)}${as.industry ? ` · ${as.industry}` : ''}${as.industry_sets.length ? ` · ${as.industry_sets.map(setLabel).join(', ')}` : ''}` : T('dc_setup_map_no_type', 'No company type yet');
    shell.querySelectorAll('[data-map-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mapView === view)));
    shell.dataset.view = view;
    view === 'matrix' ? renderMatrix() : renderDiagram();
    syncFoldAll();
  }
  async function load() {
    const mine = ++token;
    try {
      const answer = await api(`/v1/signup-sandbox/development/console/setup/drivers?company_type=${encodeURIComponent(shown)}`);
      if (mine !== token || !shell.isConnected) return;
      data = answer; render();
    } catch (error) {
      if (mine !== token) return;
      stateEl.textContent = error.status === 404 ? T('dc_setup_map_later', 'The diagram is not on dev yet.') : error.message;
    }
  }

  const close = () => { observer?.disconnect(); document.removeEventListener('keydown', onKey, true); shell.remove(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); if (pinned) { pinned = ''; blur(); hideTip(); } else close(); } };
  document.addEventListener('keydown', onKey, true);
  shell.addEventListener('fm-dc-map-close', close);
  select.addEventListener('change', () => { shown = select.value; stateEl.textContent = T('dc_setup_map_loading', 'Reading…'); load(); });
  shell.addEventListener('click', (event) => {
    if (event.target.closest('[data-map-close]')) { close(); return; }
    const pick = event.target.closest('[data-map-view]');
    if (pick) { view = pick.dataset.mapView; render(); return; }
    const fold = event.target.closest('[data-map-fold]');
    if (fold) { setFold([fold.dataset.mapFold], !unfolded.has(fold.dataset.mapFold)); return; }
    if (event.target.closest('[data-map-fold-all]')) { if (!data) return; const ids = data.setups.filter(foldable).map((setup) => setup.id); setFold(ids, !ids.every((id) => unfolded.has(id))); return; }
    const show = event.target.closest('[data-map-show]');
    if (show) { shown = show.dataset.mapShow; view = 'diagram'; load(); return; }
    const node = event.target.closest('[data-map-node]');
    // A tap pins a node (phones have no hover); a tap on it again, or on the background, lets go.
    if (node) { const key = node.dataset.mapNode; if (pinned === key) { pinned = ''; blur(); hideTip(); } else { pinned = key; focusNode(key); showTip(key, node); } return; }
    if (pinned && event.target.closest('[data-map-stage]')) { pinned = ''; blur(); hideTip(); }
  });
  const hover = (event) => {
    if (pinned) return;
    const node = event.target.closest?.('[data-map-node]');
    if (node) { focusNode(node.dataset.mapNode); showTip(node.dataset.mapNode, node); } else { blur(); hideTip(); }
  };
  stage.addEventListener('pointerover', (event) => { if (event.pointerType !== 'touch') hover(event); });
  stage.addEventListener('focusin', hover);
  stage.addEventListener('pointerleave', () => { if (!pinned) { blur(); hideTip(); } });
  stage.addEventListener('scroll', () => { if (!tip.hidden) { const key = pinned || stage.querySelector('[data-lit="true"]')?.dataset.mapNode; const el = key && stage.querySelector(`[data-map-node="${CSS.escape(key)}"]`); el ? showTip(key, el) : hideTip(); } }, { passive: true });
  load();
  return { close };
}
