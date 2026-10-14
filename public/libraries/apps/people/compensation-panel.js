/* public/libraries/apps/people/compensation-panel.js
 *
 * Fills the People 'compensation' slot: how one entity is paid (docs/architecture/pay-rules.md).
 *
 * A payee (a user, a group of users, an outside company) shows the pay rules in effect with the layer each came from,
 * and edits only its own layer: follow what is inherited, change a rule's parameters, take a rule out, add a rule or a
 * plan. A default (a role, a type of group, a type of outside company) edits the layer everyone it covers starts from.
 * Both also say which pay schedule pays, and, where pay can be divided among members, how.
 *
 * Every change is made from the day in "From" (today unless changed): what was in effect is ended the day before
 * rather than rewritten. Nothing is saved without a preview of what it would change first: the panel has no Save of
 * its own, and when the modal's Save runs before a preview, save() shows the preview and rejects with an Error whose
 * `code` is 'preview_required'; the next Save saves.
 *
 * It talks to payroll only through PayrollAPI.pay.* and PayrollAPI.schedules.list, and opens no connection of its own.
 * The entity is a payee when its kind is one of the three assignee kinds, and a default when its kind is
 * access_role / resource_group_kind / organization_connection_type (or it carries `home: { kind, id }` with kind
 * role | group_type | company_type). Whether pay can be divided is a trait, never the kind: `entity.traits.has_members`
 * when the caller gives it, otherwise what payroll itself answers for the payee.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.compensationPanel) return;
  const kit = People.kit || {};
  const esc = kit.esc || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match])));
  const t = kit.t || ((_key, fallback) => fallback);
  const tip = kit.tip || ((value) => (value ? ` title="${esc(value)}"` : ''));
  const pill = kit.pill || ((item) => `<span class="pp-pill"${tip(item.tooltip)}>${esc(item.label)}</span>`);

  const PAYEE_KINDS = ['organization_user', 'resource_group', 'organization_connection'];
  const DEFAULT_KINDS = { access_role:'role', role:'role', resource_group_kind:'group_type', group_type:'group_type', organization_connection_type:'company_type', company_type:'company_type' };
  const EARNING_KINDS = [['*', 'All earnings'], ['hourly', 'Hourly'], ['salary', 'Salary'], ['piece_rate', 'Piece rate'], ['commission', 'Commission'], ['reimbursement', 'Reimbursements'], ['adjustment', 'Adjustments'], ['clawback', 'Clawbacks']];
  const ENTRY_FIELDS = ['kind', 'plan_id', 'rule_id', 'params', 'replacement_rule_id', 'effective_from', 'effective_through', 'note'];
  const CHOICE_FIELDS = ['effective_from', 'effective_through', 'earning_kind', 'schedule_id', 'timing_basis', 'clawback_cap_percent', 'note'];
  const DISTRIBUTION_FIELDS = ['effective_from', 'mode', 'method', 'shares', 'split_rule_id', 'params'];

  const text = (...values) => { for (const value of values) { const found = String(value ?? '').trim(); if (found) return found; } return ''; };
  const arr = (value) => (Array.isArray(value) ? value : []);
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const pick = (value, keys) => { const out = {}; keys.forEach((key) => { if (value?.[key] !== undefined && value[key] !== null && value[key] !== '') out[key] = value[key]; }); return out; };
  const todayKey = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
  const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
  const inSpan = (entry, day) => text(entry.effective_from) <= day && (!text(entry.effective_through) || day <= text(entry.effective_through));
  const covers = (layer, day) => (!text(layer.covered_from) || text(layer.covered_from) <= day) && (!text(layer.covered_through) || day <= text(layer.covered_through));
  const versionOn = (versions, day) => arr(versions).filter((version) => text(version.effective_from) <= day).sort((a, b) => text(a.effective_from).localeCompare(text(b.effective_from))).pop() || arr(versions)[0] || null;
  const money = (cents) => (Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 });
  const signed = (cents) => `${Number(cents) < 0 ? '-' : '+'}${money(Math.abs(Number(cents) || 0))}`;

  /* Ends what is in effect on a day and drops what would start on or after it, for the entries a test picks out. */
  function endFrom(list, matches, day){
    return list.filter((entry) => !(matches(entry) && text(entry.effective_from) >= day))
      .map((entry) => (matches(entry) && inSpan(entry, day) ? { ...entry, effective_through:dayBefore(day) } : entry));
  }
  const typeOf = (declared, value) => {
    if (['number', 'boolean', 'text', 'cents', 'basis_points'].includes(declared?.type)) return declared.type;
    const sample = declared?.default !== undefined ? declared.default : value;
    return typeof sample === 'boolean' ? 'boolean' : typeof sample === 'string' ? 'text' : 'number';
  };
  /* Money is shown and typed in whole units and a percentage as a percentage; payroll keeps cents and basis points. */
  const paramText = (type, value) => (value === undefined || value === null || value === '' ? '' : type === 'cents' ? money(value) : type === 'basis_points' ? `${Number(value) / 100}%` : type === 'boolean' ? (value ? t('yes', 'Yes') : t('no', 'No')) : String(value));
  const paramParse = (type, raw) => {
    const value = String(raw ?? '').trim();
    if (value === '') return undefined;
    if (type === 'boolean') return value === 'true';
    if (type === 'text') return value;
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return type === 'cents' || type === 'basis_points' ? Math.round(number * 100) : number;
  };

  function ensureStyles(){
    if (document.getElementById('pp_comp_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_comp_css';
    style.textContent = `
      .pp-comp{display:flex;flex-direction:column;gap:10px;min-height:0;font-size:12.5px;container-type:inline-size}
      .pp-comp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .pp-comp-bar>strong{font-size:12px;font-weight:700;color:var(--pp-strong,#344054);text-transform:uppercase;letter-spacing:.04em}
      .pp-comp-bar .grow{flex:1}
      .pp-comp-bar label{display:inline-flex;align-items:center;gap:6px;color:var(--pp-muted,#667085);font-weight:600}
      .pp-comp .pp-input{height:30px;font-size:12px;min-width:0}
      .pp-comp .pp-btn{height:30px;font-size:12px}
      /* A compact button that opens the platform's own picker: the select lies over it, unseen, and keeps the keyboard and the phone's native list. */
      .pp-comp-pick{position:relative;flex:none}
      .pp-comp-pick>select{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;font-size:16px}
      .pp-comp-pick:focus-within{outline:2px solid var(--pp-accent,#d93025);outline-offset:2px}
      .pp-comp-date{display:inline-flex;align-items:center;gap:6px}
      .pp-comp-date .pp-input{width:auto}
      .pp-comp-rows{display:grid;gap:4px}
      .pp-comp-row{display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(0,1.4fr) auto auto;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--pp-line,#e4e7ec);border-radius:9px;background:#fff}
      .pp-comp-row.off .pp-comp-name,.pp-comp-row.off .pp-comp-params{text-decoration:line-through;color:var(--pp-faint,#98a2b3)}
      .pp-comp-name{font-weight:650;color:var(--pp-text,#101828);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pp-comp-params{color:var(--pp-muted,#667085);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pp-comp-edit{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px}
      .pp-comp-edit label{display:grid;gap:3px;font-size:10.5px;font-weight:700;color:var(--pp-muted,#667085)}
      .pp-comp-edit .pp-input{width:120px}
      .pp-comp-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:8px;overflow:hidden}
      .pp-comp-seg button{appearance:none;border:0;border-left:1px solid #d0d5dd;background:#fff;color:var(--pp-muted,#667085);height:26px;padding:0 9px;font-size:11px;font-weight:650;cursor:pointer}
      .pp-comp-seg button:first-child{border-left:0}
      .pp-comp-seg button[aria-pressed="true"]{background:var(--pp-role-bg,#eef4ff);color:var(--pp-role,#3538cd)}
      .pp-comp-seg button:disabled{opacity:.5;cursor:default}
      .pp-comp-line{display:grid;grid-template-columns:minmax(110px,.8fr) minmax(0,1.4fr) auto;align-items:center;gap:8px;padding:4px 8px}
      .pp-comp-line.add{display:flex}
      .pp-comp-warn{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--pp-warn-line,#fedf89);border-radius:9px;background:var(--pp-warn-bg,#fffaeb);color:var(--pp-warn,#b54708);font-weight:650}
      .pp-comp-warn a{color:inherit;text-decoration:underline;cursor:pointer}
      .pp-comp-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--pp-line,#e4e7ec);padding-top:10px}
      .pp-comp-foot .status{color:var(--pp-muted,#667085);font-weight:600;min-width:0}
      .pp-comp-foot .status.bad{color:var(--pp-danger,#b42318)}
      .pp-comp-preview{display:grid;gap:3px;padding:8px 10px;border:1px solid var(--pp-line,#e4e7ec);border-radius:9px;background:var(--pp-soft,#f8fafc)}
      .pp-comp-preview>div{display:flex;justify-content:space-between;gap:12px}
      .pp-comp-preview b{white-space:nowrap}
      @container (max-width:600px){
        .pp-comp-row{grid-template-columns:minmax(0,1fr) auto;row-gap:6px}
        .pp-comp-row>.pp-comp-name{grid-column:1;grid-row:1;white-space:normal}
        .pp-comp-row>.pp-pill{grid-column:2;grid-row:1}
        .pp-comp-row>.pp-comp-params{grid-column:1/-1;grid-row:2;white-space:normal;overflow:visible}
        .pp-comp-row>.pp-comp-seg,.pp-comp-row>.pp-select{grid-column:1/-1;justify-self:start}
        .pp-comp-row>.pp-select{justify-self:stretch}
        .pp-comp-row>span:empty{display:none}
        .pp-comp-line{grid-template-columns:minmax(0,1fr) auto;row-gap:5px}
        .pp-comp-line>.pp-select{grid-column:1/-1;grid-row:2}
        .pp-comp-edit label{flex:1 1 130px}
        .pp-comp-bar .grow{display:none}
        .pp-comp-bar>.pp-comp-date{margin-left:auto}
        .pp-comp-bar>.pp-comp-pick{flex:1 1 40%}
        .pp-comp-edit .pp-input{width:100%}
      }
    `;
    document.head.appendChild(style);
  }

  function target(entity){
    const home = obj(entity?.home);
    if (['role', 'group_type', 'company_type'].includes(home.kind) && text(home.id)) return { mode:'default', subject:{ type:home.kind, id:text(home.id) } };
    if (DEFAULT_KINDS[entity?.kind]) return { mode:'default', subject:{ type:DEFAULT_KINDS[entity.kind], id:text(entity.id) } };
    if (PAYEE_KINDS.includes(entity?.kind)) return { mode:'payee', payee:{ type:entity.kind, id:text(entity.id) } };
    return null;
  }

  function mount(container, context = {}){
    ensureStyles();
    const pay = window.PayrollAPI?.pay;
    const orgId = text(context.orgId);
    const entity = obj(context.entity);
    const who = target(entity);
    const readOnly = context.readOnly === true;
    let destroyed = false;
    const state = { loading:true, error:'', base:null, rules:[], plans:[], splitRules:[], schedules:[], unresolved:[], draft:null, baseline:'', date:todayKey(), preview:null, previewKey:'', status:'', statusBad:false, busy:false, extraKinds:[] };

    const own = () => state.draft;
    const draftKey = () => JSON.stringify(state.draft);
    const dirty = () => !!state.draft && draftKey() !== state.baseline;
    const ruleOf = (id) => state.rules.find((rule) => rule.id === id) || null;
    const ruleName = (id) => text(ruleOf(id)?.name, id);
    const declaredOf = (id) => obj(obj(versionOn(ruleOf(id)?.versions, state.date)?.definition).parameters);
    const scheduleName = (id) => text(state.schedules.find((schedule) => schedule.id === id)?.name, t('schedule_gone', 'A schedule that no longer exists'));
    const divides = () => (who.mode === 'default' ? who.subject.type === 'group_type' : entity.traits && typeof entity.traits.has_members === 'boolean' ? entity.traits.has_members : !!state.base?.distribution_today);
    /* The layers as they would be with the draft: what is inherited, read from payroll, under this entity's own entries. */
    const layers = () => [...(who.mode === 'payee' ? arr(state.base?.layers).filter((layer) => layer?.source) : []), { source:null, entries:own().entries, schedules:own().schedules, distribution:own().distribution }];

    function originLabel(source){
      if (!source) return who.mode === 'default' ? t('this_default', 'This default') : t('own', 'Own');
      const name = text(source.name, source.id);
      return ({ organization:t('organization', 'Organization'), assignee_kind:name, worker_classification:name, role:`${t('role', 'Role')} ${name}`, group_type:`${t('group_type', 'Group type')} ${name}`, company_type:`${t('company_type', 'Company type')} ${name}` })[source.type] || name;
    }

    /* The rules in effect on the chosen day, each with the layer that first brought it, and what this entity's own layer does to it. */
    function slots(){
      const day = state.date;
      const found = new Map();
      const removedHere = [];
      layers().filter((layer) => covers(layer, day)).forEach((layer) => {
        const isOwn = !layer.source;
        const active = arr(layer.entries).filter((entry) => inSpan(entry, day)).sort((a, b) => text(a.effective_from).localeCompare(text(b.effective_from)));
        // Only a rule this entity added itself is its own to edit in place; one its own plan brings is changed or removed like an inherited one.
        const bring = (ruleId, params, added = false) => found.set(ruleId, { rule_id:ruleId, params:{ ...obj(params) }, origin:found.has(ruleId) ? found.get(ruleId).origin : layer.source, ownAdd:isOwn && added, changed:false });
        active.filter((entry) => entry.kind === 'plan').forEach((entry) => arr(versionOn(state.plans.find((plan) => plan.id === entry.plan_id)?.versions, day)?.rules).forEach((ref) => bring(text(ref.rule_id), ref.params)));
        active.filter((entry) => entry.kind === 'add').forEach((entry) => bring(text(entry.rule_id), entry.params, true));
        active.filter((entry) => entry.kind === 'override').forEach((entry) => { const slot = found.get(text(entry.rule_id)); if (slot) { slot.params = { ...slot.params, ...obj(entry.params) }; if (isOwn) slot.changed = true; } });
        active.filter((entry) => entry.kind === 'remove').forEach((entry) => { const slot = found.get(text(entry.rule_id)); if (slot) { found.delete(slot.rule_id); if (isOwn) removedHere.push({ ...slot, removed:true }); } });
      });
      return [...found.values(), ...removedHere];
    }
    const ownPlans = () => own().entries.filter((entry) => entry.kind === 'plan' && inSpan(entry, state.date));

    // ---- Changes to this entity's own layer, each from the chosen day ----
    const forRule = (ruleId, kinds) => (entry) => kinds.includes(entry.kind) && text(entry.rule_id) === ruleId;
    function setMode(ruleId, mode){
      const slot = slots().find((entry) => entry.rule_id === ruleId);
      let entries = endFrom(own().entries, forRule(ruleId, ['override', 'remove']), state.date);
      if (slot?.ownAdd && !slot.removed && mode === 'remove') entries = endFrom(entries, forRule(ruleId, ['add']), state.date);
      else if (mode === 'remove') entries.push({ kind:'remove', rule_id:ruleId, effective_from:state.date });
      else if (mode === 'override') {
        // An override has to say something: it starts from what is in effect, for the person to change.
        const declared = declaredOf(ruleId);
        const params = {};
        Object.keys(declared).forEach((key) => { const value = slot?.params?.[key] ?? declared[key]?.default; if (value !== undefined) params[key] = value; });
        entries.push({ kind:'override', rule_id:ruleId, params, effective_from:state.date });
      }
      own().entries = entries;
    }
    function setParams(ruleId, params){
      const slot = slots().find((entry) => entry.rule_id === ruleId);
      const kind = slot?.ownAdd ? 'add' : 'override';
      own().entries = [...endFrom(own().entries, forRule(ruleId, [kind]), state.date), { kind, rule_id:ruleId, ...(Object.keys(params).length ? { params } : {}), effective_from:state.date }];
    }
    function setSchedule(kind, scheduleId){
      const of = (choice) => text(choice.earning_kind, '*') === kind;
      const current = own().schedules.filter((choice) => of(choice) && inSpan(choice, state.date)).pop();
      if (text(current?.schedule_id) === text(scheduleId)) return;
      own().schedules = endFrom(own().schedules, of, state.date);
      if (text(scheduleId)) own().schedules.push({ effective_from:state.date, earning_kind:kind, schedule_id:text(scheduleId) });
    }
    function setDistribution(value, extra = {}){
      // A distribution setting has no end: the latest to start applies. Following the default means having none of one's own.
      if (value === '') { own().distribution = []; return; }
      const next = own().distribution.filter((entry) => text(entry.effective_from) < state.date);
      next.push(value === 'as_one' ? { effective_from:state.date, mode:'as_one' } : { effective_from:state.date, mode:'split', method:value, ...extra });
      own().distribution = next;
    }
    const distributionOn = () => own().distribution.filter((entry) => text(entry.effective_from) <= state.date).sort((a, b) => text(a.effective_from).localeCompare(text(b.effective_from))).pop() || null;
    /* What the layers below say about one kind of earning, for the "inherit" choice. */
    function inheritedSchedule(kind){
      const below = layers().slice(0, -1).filter((layer) => covers(layer, state.date));
      for (let index = below.length - 1; index >= 0; index -= 1) {
        const active = arr(below[index].schedules).filter((choice) => inSpan(choice, state.date));
        const found = active.filter((choice) => text(choice.earning_kind, '*') === kind).pop() || active.filter((choice) => text(choice.earning_kind, '*') === '*').pop();
        if (found) return { schedule_id:found.schedule_id, source:below[index].source };
      }
      return null;
    }

    // ---- Markup ----
    const disabled = readOnly ? 'disabled' : '';
    const selectBox = (attrs, options) => `<span class="pp-select"><select class="pp-input" ${attrs}>${options}</select><i class="fas fa-chevron-down" aria-hidden="true"></i></span>`;
    const pickButton = (attr, label, options) => `<span class="pp-btn pp-comp-pick"><i class="fas fa-plus" aria-hidden="true"></i>${esc(label)}<select ${attr} aria-label="${esc(label)}"><option value="">${esc(label)}</option>${options}</select></span>`;
    function paramInputs(ruleId, values){
      const declared = declaredOf(ruleId);
      return Object.keys(declared).map((key) => {
        const type = typeOf(declared[key], values?.[key]);
        const value = values?.[key];
        const label = `<span${tip(type === 'cents' ? t('money_tip', 'Money, in whole units') : type === 'basis_points' ? t('percent_tip', 'A percentage') : '')}>${esc(text(declared[key]?.label, key))}</span>`;
        const attrs = `data-comp-param="${esc(key)}" data-comp-type="${type}" ${disabled}`;
        const control = type === 'boolean'
          ? `<select class="pp-input" ${attrs}><option value=""></option><option value="true" ${value === true ? 'selected' : ''}>${esc(t('yes', 'Yes'))}</option><option value="false" ${value === false ? 'selected' : ''}>${esc(t('no', 'No'))}</option></select>`
          : `<input class="pp-input" ${type === 'text' ? '' : 'type="number" step="any"'} ${attrs} value="${esc(value === undefined ? '' : (type === 'cents' || type === 'basis_points') ? Number(value) / 100 : value)}">`;
        return `<label>${label}${control}</label>`;
      }).join('');
    }
    function ruleRow(slot){
      const declared = declaredOf(slot.rule_id);
      const summary = Object.keys({ ...declared, ...slot.params }).map((key) => { const value = slot.params[key] ?? declared[key]?.default; return value === undefined ? '' : `${text(declared[key]?.label, key)}: ${paramText(typeOf(declared[key], value), value)}`; }).filter(Boolean).join(' · ');
      const mode = slot.removed ? 'remove' : slot.changed ? 'override' : 'inherit';
      const button = (id, label, pressed, off = false, hint = '') => `<button type="button" data-comp-mode="${id}" aria-pressed="${pressed}" ${readOnly || off ? 'disabled' : ''}${tip(hint)}>${esc(label)}</button>`;
      const controls = slot.ownAdd && !slot.removed
        ? button('remove', t('remove', 'Remove'), false)
        : `${button('inherit', t('inherit', 'Inherit'), mode === 'inherit')}${button('override', t('override', 'Override'), mode === 'override', !Object.keys(declared).length, Object.keys(declared).length ? '' : t('no_params', 'This rule has nothing to set'))}${button('remove', t('remove', 'Remove'), mode === 'remove')}`;
      const editing = !slot.removed && (slot.ownAdd || slot.changed) && Object.keys(declared).length;
      return `<div class="pp-comp-row ${slot.removed ? 'off' : ''}" data-comp-rule="${esc(slot.rule_id)}" data-comp-state="${slot.ownAdd && !slot.removed ? 'own' : mode}">
        <span class="pp-comp-name"${tip(text(ruleOf(slot.rule_id)?.description))}>${esc(ruleName(slot.rule_id))}</span>
        <span class="pp-comp-params">${esc(summary)}</span>
        ${pill({ label:originLabel(slot.ownAdd && !slot.removed ? null : slot.origin), tone:slot.origin && !(slot.ownAdd && !slot.removed) ? 'role' : 'ok' })}
        <span class="pp-comp-seg" role="group">${controls}</span>
        ${editing ? `<div class="pp-comp-edit">${paramInputs(slot.rule_id, slot.params)}</div>` : ''}
      </div>`;
    }
    function scheduleRows(){
      const mine = (kind) => own().schedules.filter((choice) => text(choice.earning_kind, '*') === kind && inSpan(choice, state.date)).pop() || null;
      const kinds = EARNING_KINDS.filter(([kind]) => kind === '*' || mine(kind) || state.extraKinds.includes(kind));
      const rows = kinds.map(([kind, label]) => {
        const chosen = mine(kind);
        const inherited = inheritedSchedule(kind);
        const none = who.mode === 'default' ? t('not_set', 'Not set') : inherited ? `${t('inherit', 'Inherit')} (${scheduleName(inherited.schedule_id)})` : t('inherit_none', 'Inherit (none chosen)');
        const options = [['', none], ...state.schedules.filter((schedule) => schedule.status !== 'archived' || schedule.id === chosen?.schedule_id).map((schedule) => [schedule.id, schedule.name])];
        const source = chosen ? null : inherited?.source;
        return `<div class="pp-comp-line" data-comp-schedule="${esc(kind)}"><span class="pp-comp-name">${esc(label)}</span>${selectBox(`data-comp-schedule-pick ${disabled} aria-label="${esc(label)}"`, options.map(([value, name]) => `<option value="${esc(value)}" ${value === text(chosen?.schedule_id) ? 'selected' : ''}>${esc(name)}</option>`).join(''))}${chosen || inherited ? pill({ label:originLabel(source), tone:chosen ? 'ok' : 'role' }) : '<span></span>'}</div>`;
      }).join('');
      const more = EARNING_KINDS.filter(([kind]) => !kinds.some(([shown]) => shown === kind));
      return `${rows}${more.length && !readOnly ? `<div class="pp-comp-line add">${pickButton('data-comp-add-kind', t('add_kind_pick', 'Another kind of earning'), more.map(([kind, label]) => `<option value="${esc(kind)}">${esc(label)}</option>`).join(''))}</div>` : ''}`;
    }
    function distributionMarkup(){
      const current = distributionOn();
      const value = !current ? '' : current.mode === 'as_one' ? 'as_one' : text(current.method, 'equal');
      const options = [['', who.mode === 'default' ? t('not_set', 'Not set') : t('follow_default', 'Follow the default')], ['as_one', t('as_one', 'Paid as one')], ['equal', t('split_equal', 'Split equally')], ['shares', t('split_shares', 'Split by shares')], ['rule', t('split_rule', 'Split by a rule')]];
      let extra = '';
      if (value === 'rule') {
        const rule = state.splitRules.find((entry) => entry.id === current.split_rule_id);
        const declared = obj(obj(versionOn(rule?.versions, state.date)?.definition).parameters);
        extra = `<div class="pp-comp-edit"><label><span>${esc(t('split_rule_pick', 'Split rule'))}</span><select class="pp-input" data-comp-split-rule ${disabled}><option value=""></option>${state.splitRules.filter((entry) => entry.status !== 'archived' || entry.id === current.split_rule_id).map((entry) => `<option value="${esc(entry.id)}" ${entry.id === current.split_rule_id ? 'selected' : ''}${tip(entry.description)}>${esc(text(entry.name, entry.id))}</option>`).join('')}</select></label>${Object.keys(declared).map((key) => `<label><span>${esc(text(declared[key]?.label, key))}</span><input class="pp-input" type="number" step="any" data-comp-split-param="${esc(key)}" ${disabled} value="${esc(obj(current.params)[key] ?? '')}" placeholder="${esc(declared[key]?.default ?? '')}"></label>`).join('')}</div>`;
      }
      if (value === 'shares') {
        const members = arr(entity.members).length ? arr(entity.members).map((member) => ({ id:text(member.id, member.user_id), name:text(member.name, member.id, member.user_id) })) : Object.keys(obj(current.shares)).map((id) => ({ id, name:id }));
        extra = `<div class="pp-comp-edit">${members.map((member) => `<label><span>${esc(member.name)}</span><input class="pp-input" type="number" min="0" step="any" data-comp-share="${esc(member.id)}" ${disabled} value="${esc(obj(current.shares)[member.id] ?? '')}"></label>`).join('') || `<span class="pp-comp-params">${esc(t('no_members', 'No members to share among'))}</span>`}</div>`;
      }
      return `<div class="pp-comp-bar"><strong${tip(t('divided_tip', 'How what the group earns reaches its members'))}>${esc(t('divided', 'Divided'))}</strong></div>
        <div class="pp-comp-row" data-comp-distribution><span class="pp-comp-name">${esc(t('pay_reaches', 'Pay reaches'))}</span>${selectBox(`data-comp-dist ${disabled} aria-label="${esc(t('pay_reaches', 'Pay reaches'))}"`, options.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}<span></span><span></span>${extra}</div>`;
    }
    function previewMarkup(){
      const preview = state.preview;
      if (!preview) return '';
      const result = obj(preview.result);
      // A payee preview lists every earning that would post; a default preview lists, per payee, what the change itself moves.
      const lines = who.mode === 'payee'
        ? arr(result.differences).map((difference) => ({ label:`${ruleName(difference.rule_id)} · ${text(difference.unit)}`, from:difference.posted_cents, to:difference.target_cents, delta:difference.delta_cents, held:difference.handling === 'hold' }))
        : arr(result.payees).flatMap((payee) => arr(payee.differences).map((difference) => ({ label:`${text(payee.payee_name, payee.payee?.id)} · ${ruleName(difference.rule_id)} · ${text(difference.unit)}`, from:difference.without_change_cents, to:difference.target_cents, delta:difference.change_cents, held:difference.handling === 'hold' })));
      const unresolved = who.mode === 'payee' ? arr(result.unresolved) : arr(result.payees).flatMap((payee) => arr(payee.unresolved));
      const total = who.mode === 'payee' ? result.total_delta_cents : result.change_cents;
      return `<div class="pp-comp-preview" data-comp-preview>
        <div><strong>${esc(lines.length ? t('preview_changes', '{count} earnings would change', { count:lines.length }).replace('{count}', lines.length) : t('preview_none', 'No earnings would change'))}</strong>${lines.length ? `<b>${esc(signed(total))}</b>` : ''}</div>
        ${lines.slice(0, 12).map((line) => `<div data-comp-difference><span>${esc(line.label)}: ${esc(money(line.from))} → ${esc(money(line.to))}${line.held ? ` (${esc(t('held', 'held for review'))})` : ''}</span><b>${esc(signed(line.delta))}</b></div>`).join('')}
        ${lines.length > 12 ? `<div><span>${esc(`+${lines.length - 12}`)}</span></div>` : ''}
        ${unresolved.slice(0, 3).map((entry) => `<div data-comp-preview-unresolved><span>${esc(t('not_worked_out', 'Could not be worked out'))}: ${esc(text(entry.reason))}</span></div>`).join('')}
      </div>`;
    }
    function render(){
      if (destroyed) return;
      if (!who) { container.innerHTML = `<div class="pp-state"><strong>${esc(t('comp_none', 'Nothing is paid here'))}</strong></div>`; return; }
      if (state.loading) { container.innerHTML = `<div class="pp pp-comp"><div class="pp-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i></div></div>`; return; }
      if (state.error) { container.innerHTML = `<div class="pp pp-comp"><div class="pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(state.error)}</strong></div></div>`; return; }
      const rows = slots();
      const present = new Set(rows.filter((slot) => !slot.removed).map((slot) => slot.rule_id));
      const plans = ownPlans();
      const addable = state.rules.filter((rule) => rule.status !== 'archived' && !present.has(rule.id));
      const addablePlans = state.plans.filter((plan) => plan.status !== 'archived' && !plans.some((entry) => entry.plan_id === plan.id));
      // Never an amount for something that could not be worked out: a count, the first reason, and where to look.
      const warning = state.unresolved.length ? `<div class="pp-comp-warn" data-comp-unresolved><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span${tip(text(state.unresolved[0].reason))}>${esc(state.unresolved.length === 1 ? t('unresolved_one', '1 earning could not be worked out') : `${state.unresolved.length} ${t('unresolved_many', 'earnings could not be worked out')}`)}</span><a data-comp-why role="link" tabindex="0">${esc(t('why', 'Why'))}</a></div>` : '';
      container.innerHTML = `<div class="pp pp-comp" data-comp="${who.mode}">
        ${warning}
        <div class="pp-comp-bar"><strong${tip(t('paid_by_tip', 'The pay rules in effect on the day chosen'))}>${esc(t('paid_by', 'Paid by'))}</strong>
          ${who.mode === 'default' ? `<span data-comp-covers>${pill({ label:`${Number(state.base?.covers_count || 0)} ${t('covered', 'covered')}`, tone:'role', tooltip:arr(state.base?.covers).slice(0, 12).map((payee) => text(payee.name, payee.id)).join(', ') })}</span>` : ''}
          <span class="grow"></span>
          <label class="pp-comp-date"${tip(t('from_tip', 'Changes made here start on this day. What was in effect before ends the day before.'))}>${esc(t('from', 'From'))}<input class="pp-input" type="date" data-comp-date value="${esc(state.date)}" ${disabled}></label>
          ${readOnly ? '' : `${pickButton('data-comp-add-rule', t('add_rule', 'Add rule'), addable.map((rule) => `<option value="${esc(rule.id)}">${esc(text(rule.name, rule.id))}</option>`).join(''))}${pickButton('data-comp-add-plan', t('add_plan', 'Add plan'), addablePlans.map((plan) => `<option value="${esc(plan.id)}">${esc(text(plan.name, plan.id))}</option>`).join(''))}`}
        </div>
        ${plans.length ? `<div class="pp-comp-bar" data-comp-plans>${plans.map((entry) => `<span class="pp-pill role" data-comp-plan="${esc(entry.plan_id)}"><i class="fas fa-layer-group" aria-hidden="true"></i>${esc(text(state.plans.find((plan) => plan.id === entry.plan_id)?.name, entry.plan_id))}${readOnly ? '' : ` <a data-comp-remove-plan role="button" tabindex="0" aria-label="${esc(t('remove', 'Remove'))}" style="cursor:pointer">×</a>`}</span>`).join('')}</div>` : ''}
        <div class="pp-comp-rows" data-comp-rules>${rows.map(ruleRow).join('') || `<div class="pp-comp-line"><span class="pp-comp-params">${esc(t('no_rules', 'No pay rules'))}</span></div>`}</div>
        <div class="pp-comp-bar"><strong${tip(t('paid_on_tip', 'The pay schedule that decides when earnings are paid'))}>${esc(t('paid_on', 'Paid on'))}</strong></div>
        <div data-comp-schedules>${scheduleRows()}</div>
        ${divides() ? distributionMarkup() : ''}
        ${readOnly ? '' : `<div class="pp-comp-foot"><button type="button" class="pp-btn" data-comp-preview-run ${dirty() && !state.busy ? '' : 'disabled'}${tip(t('preview_tip', 'Works out what this would change. Nothing is saved.'))}><i class="fas fa-magnifying-glass-chart" aria-hidden="true"></i>${esc(t('preview_changes_button', 'Preview changes'))}</button><span class="status ${state.statusBad ? 'bad' : ''}" data-comp-status>${esc(state.status)}</span></div>`}
        ${previewMarkup()}
      </div>`;
    }

    // ---- Loading, previewing and saving ----
    function payload(){
      const draft = own();
      const live = distributionOn();
      if (live?.method === 'rule' && !text(live.split_rule_id)) throw new Error(t('need_split_rule', 'Choose the split rule'));
      if (live?.method === 'shares' && !Object.keys(obj(live.shares)).length) throw new Error(t('need_shares', 'Give at least one member a share'));
      const empty = draft.entries.find((entry) => entry.kind === 'override' && !Object.keys(obj(entry.params)).length && inSpan(entry, state.date));
      if (empty) throw new Error(`${ruleName(empty.rule_id)}: ${t('need_override', 'set a value, or go back to inheriting')}`);
      return {
        ...(who.mode === 'payee' ? { payee:who.payee } : { subject:who.subject }),
        entries:draft.entries.map((entry) => pick(entry, ENTRY_FIELDS)),
        ...(draft.distribution.length ? { distribution:draft.distribution.map((entry) => pick(entry, DISTRIBUTION_FIELDS)) } : {}),
        schedules:draft.schedules.map((choice) => pick(choice, CHOICE_FIELDS)),
        expected_revision:Number(state.base?.revision || 0)
      };
    }
    function changed(){ state.preview = null; state.previewKey = ''; state.status = ''; state.statusBad = false; try { context.onDirty?.(dirty()); } catch (_) {} render(); }
    async function load(){
      state.loading = true; state.error = ''; render();
      try {
        if (!pay) throw new Error(t('comp_unavailable', 'Pay is not available here'));
        const [base, rules, plans, schedules, unresolved] = await Promise.all([
          who.mode === 'payee' ? pay.setup(orgId, who.payee) : pay.default(orgId, who.subject), pay.rules(orgId), pay.plans(orgId),
          window.PayrollAPI.schedules.list(orgId, { includeArchived:true }).catch(() => ({ schedules:[] })),
          who.mode === 'payee' && typeof pay.unresolved === 'function' ? pay.unresolved(orgId).catch(() => []) : Promise.resolve([])
        ]);
        if (destroyed) return;
        Object.assign(state, { base:obj(base), rules:arr(rules), plans:arr(plans), schedules:arr(schedules?.schedules || schedules) });
        state.unresolved = arr(unresolved).filter((entry) => entry?.payee?.type === who.payee?.type && text(entry?.payee?.id) === who.payee?.id);
        state.draft = { entries:arr(state.base.entries).map((entry) => pick(entry, ENTRY_FIELDS)), schedules:arr(state.base.schedules).map((choice) => ({ ...pick(choice, CHOICE_FIELDS), earning_kind:text(choice.earning_kind, '*') })), distribution:arr(state.base.distribution).map((entry) => pick(entry, DISTRIBUTION_FIELDS)) };
        state.baseline = draftKey();
        if (divides() && typeof pay.splitRules === 'function') state.splitRules = arr(await pay.splitRules(orgId).catch(() => []));
        state.loading = false;
      } catch (error) { state.loading = false; state.error = error?.message || t('load_failed', 'Could not load'); }
      render();
    }
    async function preview(){
      let body;
      try { body = payload(); } catch (error) { state.status = error.message; state.statusBad = true; render(); return false; }
      state.busy = true; state.status = t('previewing', 'Working out what this changes'); state.statusBad = false; render();
      try {
        state.preview = { result:await (who.mode === 'payee' ? pay.previewSetup(orgId, body) : pay.previewDefault(orgId, body)) };
        state.previewKey = draftKey();
        state.status = t('nothing_saved', 'Nothing is saved yet');
      } catch (error) { state.preview = null; state.status = error?.message || t('preview_failed', 'The preview could not be worked out'); state.statusBad = true; }
      state.busy = false; render();
      return !!state.preview;
    }
    async function save(){
      if (!dirty() || readOnly) return;
      // Nothing is saved unseen: the first save shows what would change, the second saves it.
      // The refusal is a notice, not a failure: `code` tells the modal to stay open and say so plainly.
      if (state.previewKey !== draftKey()) {
        const shown = await preview();
        throw Object.assign(new Error(shown ? t('check_preview', 'Check what this changes, then save again') : state.status), { code:shown ? 'preview_required' : 'preview_failed' });
      }
      state.busy = true; state.status = t('saving', 'Saving'); state.statusBad = false; render();
      try {
        await (who.mode === 'payee' ? pay.saveSetup(orgId, payload()) : pay.saveDefault(orgId, payload()));
        state.busy = false; state.preview = null; state.previewKey = '';
        await load();
        state.status = t('saved', 'Saved'); render();
        try { context.onDirty?.(false); context.onSaved?.(); } catch (_) {}
      } catch (error) { state.busy = false; state.status = error?.message || t('save_failed', 'Could not save'); state.statusBad = true; render(); throw error; }
    }

    // ---- Events ----
    const rowParams = (row) => { const params = {}; row.querySelectorAll('[data-comp-param]').forEach((input) => { const value = paramParse(input.dataset.compType, input.value); if (value !== undefined) params[input.dataset.compParam] = value; }); return params; };
    function onClick(event){
      const element = event.target.closest('[data-comp-mode],[data-comp-preview-run],[data-comp-why],[data-comp-remove-plan]');
      if (!element || !container.contains(element)) return;
      if (element.dataset.compMode) { setMode(element.closest('[data-comp-rule]').dataset.compRule, element.dataset.compMode); changed(); }
      else if (element.dataset.compPreviewRun !== undefined) preview();
      else if (element.dataset.compRemovePlan !== undefined) { const planId = element.closest('[data-comp-plan]').dataset.compPlan; own().entries = endFrom(own().entries, (entry) => entry.kind === 'plan' && entry.plan_id === planId, state.date); changed(); }
      else if (element.dataset.compWhy !== undefined) { event.preventDefault(); try { window.Portal?.navigation?.push?.({ tab:'payroll', payrollView:'upcoming' }, { source:'people-compensation' }); } catch (_) {} }
    }
    function onChange(event){
      const control = event.target;
      const data = control.dataset || {};
      if (data.compDate !== undefined) { if (/^\d{4}-\d{2}-\d{2}$/.test(control.value)) state.date = control.value; state.preview = null; state.previewKey = ''; render(); return; }
      if (data.compAddRule !== undefined && control.value) own().entries.push({ kind:'add', rule_id:control.value, effective_from:state.date });
      else if (data.compAddPlan !== undefined && control.value) own().entries.push({ kind:'plan', plan_id:control.value, effective_from:state.date });
      else if (data.compParam !== undefined) { const row = control.closest('[data-comp-rule]'); setParams(row.dataset.compRule, rowParams(row)); }
      else if (data.compSchedulePick !== undefined) setSchedule(control.closest('[data-comp-schedule]').dataset.compSchedule, control.value);
      else if (data.compAddKind !== undefined && control.value) { state.extraKinds.push(control.value); render(); return; }
      else if (data.compDist !== undefined) setDistribution(control.value);
      else if (data.compSplitRule !== undefined || data.compSplitParam !== undefined || data.compShare !== undefined) {
        const row = control.closest('[data-comp-distribution]');
        const method = row.querySelector('[data-comp-dist]').value;
        if (method === 'rule') {
          const params = {};
          row.querySelectorAll('[data-comp-split-param]').forEach((input) => { if (input.value !== '' && Number.isFinite(Number(input.value))) params[input.dataset.compSplitParam] = Number(input.value); });
          setDistribution('rule', { split_rule_id:row.querySelector('[data-comp-split-rule]').value, ...(data.compSplitRule === undefined && Object.keys(params).length ? { params } : {}) });
        } else {
          const shares = {};
          row.querySelectorAll('[data-comp-share]').forEach((input) => { if (Number(input.value) > 0) shares[input.dataset.compShare] = Number(input.value); });
          setDistribution('shares', { shares });
        }
      } else return;
      changed();
    }
    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    if (who) load(); else render();
    return {
      save,
      destroy(){ destroyed = true; container.removeEventListener('click', onClick); container.removeEventListener('change', onChange); container.replaceChildren(); }
    };
  }

  People.compensationPanel = { mount };
  if (People.slots?.register) People.slots.register('compensation', { kinds:[...PAYEE_KINDS, ...Object.keys(DEFAULT_KINDS)], mount });
})();
