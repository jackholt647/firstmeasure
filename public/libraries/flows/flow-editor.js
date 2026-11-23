/* libraries/flows/flow-editor.js
 * The flow editor (docs/architecture/flows.md, "The editor"): one component for call scripts and workflows, embedded in
 * CRM settings › Flows, Communications › Call scripts, setups and the automations hub. It draws the WHOLE flow as a map:
 * steps in columns by how far they are from the start, a line from every way out of a step (a choice's options, a
 * branch, "then") to the step or outcome it leads to, and the outcomes at the end. Clicking a step opens it in place,
 * where its blocks are edited. Read-only is the same map with nothing to edit.
 *
 *   FirstMateFlowEditor.mount(el, { flowId | definition, readOnly, onSave, onChange })  → { save, destroy, definition, dirty }
 *   FirstMateFlowEditor.open(flowId, { readOnly, definition, onSave, onClose })          → { close }
 *
 * Saving sends the whole definition (`PUT /v1/flows/organizations/:orgId/flows/:id` with `expected_version`, or `POST`
 * for a new flow); the server's validation issues carry a path (`steps.2.blocks.1.options.0.to`) and are drawn next to
 * the field they name. The play button plays the unsaved definition in `FirstMateFlows.preview`.
 */
(function(){
  const root = window;
  if (root.FirstMateFlowEditor) return;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const L = (key, fallback, values) => root.PlatformLanguage?.text?.('flows', key, fallback, values) ?? String(fallback).replace(/\{(\w+)\}/g, (_m, name) => values?.[name] ?? '');
  const orgId = () => clean(root.__APP?.userOrgId || root.__APP?.orgId);
  const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
  const toast = (message, kind = 'success') => root.Portal?.ui?.showToast?.(message, kind);
  /** `/v1/flows`, beside the platform API's base (`/v1/platform`), absolute so PlatformAPI does not prefix it. */
  const flowsBase = () => new URL((clean(root.PlatformAPI?.baseUrl?.()) || `${location.origin}/v1/platform`).replace(/\/platform\/?$/, '/flows'), location.href).href.replace(/\/$/, '');
  const api = (path, options = {}) => {
    if (!root.PlatformAPI?.request) return Promise.reject(new Error(L('unavailable', 'Flows are not available here.')));
    return root.PlatformAPI.request(`${flowsBase()}/organizations/${encodeURIComponent(orgId())}${path}`, options);
  };

  // What the contract allows (public/v1/flows/contracts.ts). Kept here as the editor's choices.
  const ASK_INPUTS = ['text', 'paragraph', 'number', 'money', 'select', 'multi', 'yes_no', 'date', 'phone', 'email', 'address'];
  const BUTTONS = ['open_project', 'open_contact', 'go_to', 'restart', 'start_flow', 'close'];
  const SAVES_TO = ['contact.name', 'contact.first_name', 'contact.last_name', 'contact.email', 'contact.phone', 'contact.address', 'project.address', 'project.title', 'project.summary', 'project.notes'];
  const BLOCK_KINDS = ['say', 'note', 'ask', 'choice', 'contact', 'project', 'action', 'outcome', 'buttons'];
  const BLOCK_ICONS = { say: 'fa-comment', note: 'fa-circle-info', ask: 'fa-circle-question', choice: 'fa-code-branch', contact: 'fa-address-book', project: 'fa-folder-plus', action: 'fa-bolt', outcome: 'fa-flag-checkered', buttons: 'fa-hand-pointer' };
  const ACTION_ICONS = { 'communications.sendSms.v1': 'fa-comment-sms', 'communications.sendEmail.v1': 'fa-envelope', 'work.createTodo.v1': 'fa-list-check', 'scopes.activateTemplate.v1': 'fa-table-columns', 'sales.markLost.v1': 'fa-circle-xmark' };
  const OUTCOME_COLORS = ['#16a34a', '#2563eb', '#f59e0b', '#667085', '#dc2626', '#7a271a', '#7c3aed'];
  const TEMPLATE_FIELDS = ['contact.first_name', 'contact.name', 'contact.phone', 'user.first_name', 'organization.name'];
  const blockName = (kind, flowKind) => ({
    say: flowKind === 'call' ? L('block_say', 'Say') : L('block_show', 'Show'), note: L('block_note', 'Note'), ask: L('block_ask', 'Question'),
    choice: L('block_choice', 'Choice'), contact: L('block_contact', 'Contact'), project: L('block_project', 'Lead or project'), action: L('block_action', 'Action'),
    outcome: L('block_outcome', 'End with an outcome'), buttons: L('block_buttons', 'End buttons')
  }[kind] || kind);
  const inputName = (input) => ({ text: L('in_text', 'Short answer'), paragraph: L('in_paragraph', 'Paragraph'), number: L('in_number', 'Number'), money: L('in_money', 'Money'), select: L('in_select', 'Pick one'),
    multi: L('in_multi', 'Pick any'), yes_no: L('in_yes_no', 'Yes or no'), date: L('in_date', 'Date'), phone: L('in_phone', 'Phone'), email: L('in_email', 'Email'), address: L('in_address', 'Address') }[input] || input);
  const buttonName = (kind) => ({ open_project: L('btn_open_project', 'Open the project'), open_contact: L('btn_open_contact', 'Open the contact'), go_to: L('btn_go_to', 'Go to a page'),
    restart: L('btn_restart', 'Start again'), start_flow: L('btn_start_flow', 'Start another flow'), close: L('btn_close', 'Close') }[kind] || kind);

  const css = `
.fme{container-type:inline-size;display:flex;flex-direction:column;min-height:0;height:100%;color:#101828;font-size:13px;background:#f8fafc;border-radius:14px;overflow:hidden}
.fme *{box-sizing:border-box}
.fme-top{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border-bottom:1px solid #eaecf0;flex-wrap:wrap}
.fme-top .fme-icon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex:none;color:#fff}
.fme-name{flex:1 1 200px;min-width:0;font:inherit;font-size:16px;font-weight:850;border:1px solid transparent;border-radius:8px;padding:6px 8px;background:transparent;color:#101828}
.fme-name:hover,.fme-name:focus{border-color:#d0d5dd;background:#fff;outline:none}
.fme-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:10px;overflow:hidden;flex:none}
.fme-seg button{border:0;background:#fff;padding:7px 11px;font:inherit;font-weight:750;color:#475467;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.fme-seg button+button{border-left:1px solid #d0d5dd}
.fme-seg button[aria-pressed="true"]{background:rgba(var(--primary-rgb,37,99,235),.1);color:var(--primary,#2563eb)}
.fme-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-weight:800;cursor:pointer;white-space:nowrap}
.fme-btn.primary{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff}
.fme-btn.ghost{border-color:transparent;background:transparent}
.fme-btn.small{height:28px;padding:0 9px;font-size:12px}
.fme-btn.icon{width:28px;height:28px;padding:0;justify-content:center}
.fme-btn[disabled]{opacity:.5;cursor:default}
.fme-btn:not([disabled]):hover{filter:brightness(.97)}
.fme-status{color:#667085;font-weight:700;font-size:12px;white-space:nowrap}
.fme-status.dirty{color:#b54708}
.fme-banner{margin:10px 12px 0;padding:9px 12px;border-radius:10px;background:#fef3f2;border:1px solid #fecdca;color:#b42318;font-weight:700;display:flex;gap:10px;align-items:center}
.fme-banner ul{margin:4px 0 0;padding-left:18px;font-weight:600}
.fme-body{flex:1;min-height:0;display:flex;flex-direction:column}
.fme-settings{background:#fff;border-bottom:1px solid #eaecf0;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.fme-settings[hidden]{display:none}
.fme-map{position:relative;flex:1;min-height:320px;overflow:auto}
.fme-cols{position:relative;display:flex;align-items:flex-start;gap:56px;padding:18px 18px 28px;min-width:max-content;z-index:1}
.fme-col{display:flex;flex-direction:column;gap:18px;width:280px;flex:none}
.fme-col.wide{width:440px}
.fme-col-head{font-size:11px;font-weight:850;text-transform:uppercase;letter-spacing:.06em;color:#98a2b3;padding-left:2px}
.fme-wires{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
.fme-wires path{fill:none;stroke:#98a2b3;stroke-width:1.6}
.fme-wires path.back{stroke-dasharray:5 4}
.fme-wires path.outcome{stroke-width:2}
.fme-card{background:#fff;border:1.5px solid #e4e7ec;border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.05);cursor:pointer;position:relative}
.fme-card:hover{border-color:#c7d7fe}
.fme-card[aria-current="true"]{border-color:var(--primary,#2563eb);box-shadow:0 0 0 3px rgba(var(--primary-rgb,37,99,235),.14);cursor:default}
.fme-card.has-error{border-color:#f04438}
.fme-card-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.fme-card-head .fme-step-n{width:22px;height:22px;border-radius:7px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:11px;font-weight:850;flex:none}
.fme-card-head strong{flex:1;min-width:0;font-size:13.5px;font-weight:850;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fme-start{font-size:10.5px;font-weight:850;color:#027a48;background:#ecfdf3;border-radius:999px;padding:2px 7px;flex:none}
.fme-err-dot{color:#d92d20;flex:none}
.fme-sum{list-style:none;margin:0;padding:0 12px 8px;display:flex;flex-direction:column;gap:4px}
.fme-sum li{display:flex;gap:7px;align-items:baseline;color:#475467;line-height:1.35;min-width:0}
.fme-sum li i{color:#98a2b3;width:13px;text-align:center;flex:none;font-size:11px}
.fme-sum li span{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.fme-exits{border-top:1px solid #f2f4f7;padding:6px 0 6px;display:flex;flex-direction:column}
.fme-exit{display:flex;align-items:center;gap:6px;padding:3px 12px;font-size:12px;font-weight:700;color:#344054;min-width:0}
.fme-exit .fme-exit-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#667085}
.fme-exit .fme-exit-to{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:1px 8px;background:#f2f4f7}
.fme-exit .fme-exit-to.outcome{color:#fff}
.fme-exit .fme-exit-to.end{background:transparent;color:#98a2b3}
.fme-exit button.fme-exit-to{border:0;font:inherit;font-weight:750;cursor:pointer}
.fme-detail{padding:4px 12px 12px;display:flex;flex-direction:column;gap:10px;cursor:auto}
.fme-block{border:1px solid #eaecf0;border-radius:11px;background:#fcfcfd;padding:9px 10px;display:flex;flex-direction:column;gap:8px}
.fme-block.has-error{border-color:#f04438;background:#fffbfa}
.fme-block-head{display:flex;align-items:center;gap:6px}
.fme-block-head i.k{color:var(--primary,#2563eb);width:16px;text-align:center}
.fme-block-head strong{flex:1;font-size:12px;font-weight:850;text-transform:uppercase;letter-spacing:.04em;color:#475467}
.fme-f{display:flex;flex-direction:column;gap:4px;min-width:0}
.fme-f>span{font-size:11.5px;font-weight:800;color:#667085}
.fme-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.fme-row>.fme-f{flex:1 1 120px}
.fme input[type=text],.fme input[type=number],.fme textarea,.fme select{font:inherit;font-size:13px;border:1px solid #d0d5dd;border-radius:8px;padding:6px 8px;color:#101828;background:#fff;min-width:0;width:100%}
.fme textarea{resize:vertical;min-height:58px;max-height:320px;line-height:1.45;field-sizing:content}

.fme textarea.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.fme input:focus,.fme textarea:focus,.fme select:focus{outline:none;border-color:var(--primary,#2563eb);box-shadow:0 0 0 3px rgba(var(--primary-rgb,37,99,235),.12)}
.fme input[type=color]{width:34px;height:30px;padding:2px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;flex:none}
.fme-check{display:inline-flex;gap:6px;align-items:center;font-weight:700;color:#344054;cursor:pointer}
.fme-chips{display:flex;flex-wrap:wrap;gap:4px}
.fme-chip{border:1px dashed #c7d7fe;background:#f5f8ff;color:#3538cd;border-radius:999px;padding:1px 8px;font:inherit;font-size:11px;font-weight:750;cursor:pointer}
.fme-opt{display:grid;grid-template-columns:1fr minmax(0,1fr) auto;gap:6px;align-items:center}
.fme-opt.two{grid-template-columns:1fr auto}
.fme-issue{color:#b42318;font-weight:750;font-size:11.5px}
.fme-add{display:flex;flex-wrap:wrap;gap:4px}
.fme-sub{font-size:11px;font-weight:850;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;margin-top:2px}
.fme-outcome-card .fme-card-head strong{color:#fff}
.fme-outcome-card .fme-card-head{border-radius:12px 12px 0 0;padding:8px 12px}
.fme-empty-col{color:#98a2b3;font-weight:700;padding:8px}
.fme-loading{display:grid;place-items:center;min-height:200px;color:#98a2b3;font-size:18px}
.fme[data-readonly] [data-edit-only]{display:none!important}
.fme[data-readonly] textarea{min-height:0}
.fme[data-readonly] input,.fme[data-readonly] textarea,.fme[data-readonly] select{border-color:transparent;background:transparent;color:#101828;opacity:1;-webkit-text-fill-color:#101828;resize:none;padding-left:0;appearance:none}
.fme-play{position:fixed;inset:0;z-index:2147483320;display:grid;place-items:center;background:rgba(16,24,40,.45);padding:16px}
.fme-play-shell{width:min(560px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#fff;border-radius:16px;padding:14px 20px 20px;box-shadow:0 24px 60px rgba(16,24,40,.3)}
.fme-play-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-weight:850;color:#475467}
.fm-flow-editor-modal{position:fixed;inset:0;z-index:2147483300;display:grid;place-items:center;background:rgba(16,24,40,.45);padding:16px}
.fm-flow-editor-shell{width:min(1280px,100%);height:min(860px,calc(100dvh - 32px));display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(16,24,40,.3);overflow:hidden}
.fm-flow-editor-shell>.fme-mount{flex:1;min-height:0}
@container (max-width:760px){
  .fme-cols{flex-direction:column;min-width:0;gap:14px;padding:12px}
  .fme-col,.fme-col.wide{width:100%}
  .fme-wires{display:none}
  .fme-top .fme-status{order:9;width:100%}
}
@media (max-width:560px){.fm-flow-editor-modal{padding:0}.fm-flow-editor-shell{height:100dvh;border-radius:0}}
`;
  function ensureStyles(){
    if (document.getElementById('fm-flow-editor-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-flow-editor-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── The model ───────────────────────────────────────────────────────────────

  function blankFlow(kind = 'workflow'){
    return { name: kind === 'call' ? L('new_call_script', 'New call script') : L('new_flow', 'New flow'), description: '', icon: kind === 'call' ? 'fa-phone-volume' : 'fa-diagram-project', color: '#2563eb',
      kind, audience: 'staff', start: 'step_1', steps: [{ id: 'step_1', title: L('first_step', 'First step'), blocks: [{ id: 'say_1', kind: 'say', label: '', text: '' }], next: null }],
      outcomes: [], entry: {}, metadata: {} };
  }
  /** Fills what the contract defaults, so every field the editor draws has a value. */
  function normalize(value){
    const flow = { ...blankFlow(), ...clone(value || {}) };
    flow.steps = Array.isArray(flow.steps) && flow.steps.length ? flow.steps : blankFlow().steps;
    flow.outcomes = Array.isArray(flow.outcomes) ? flow.outcomes : [];
    flow.entry = flow.entry && typeof flow.entry === 'object' ? flow.entry : {};
    flow.metadata = flow.metadata && typeof flow.metadata === 'object' ? flow.metadata : {};
    for (const step of flow.steps) {
      step.title ??= ''; step.blocks = Array.isArray(step.blocks) ? step.blocks : []; if (step.next === undefined) step.next = null;
      for (const block of step.blocks) {
        block.label ??= '';
        if (block.kind === 'ask') { block.input ||= 'text'; block.options ||= []; block.required = !!block.required; block.placeholder ??= ''; }
        if (block.kind === 'choice') { block.options ||= []; if (block.required === undefined) block.required = true; }
        if (block.kind === 'contact' || block.kind === 'project') block.from ||= {};
        if (block.kind === 'action') { block.input ||= {}; block.preview ??= ''; block.explainer ??= ''; }
        if (block.kind === 'buttons') block.buttons ||= [];
      }
    }
    for (const outcome of flow.outcomes) { outcome.effects ||= []; outcome.color ||= '#667085'; }
    return flow;
  }
  const uniqueId = (base, taken) => { let n = 1; while (taken.has(`${base}_${n}`)) n += 1; return `${base}_${n}`; };
  const slug = (value, fallback) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || fallback;
  function allBlockIds(step){ return new Set(step.blocks.map((block) => block.id)); }
  function allKeys(flow){ return new Set(flow.steps.flatMap((step) => step.blocks.filter((block) => block.kind === 'ask' || block.kind === 'choice').map((block) => block.key))); }

  function newBlock(kind, step, flow){
    const id = uniqueId(kind, allBlockIds(step));
    const key = () => uniqueId(kind === 'choice' ? 'choice' : 'answer', allKeys(flow));
    switch (kind) {
      case 'say': case 'note': return { id, kind, label: '', text: '' };
      case 'ask': return { id, kind, label: L('new_question', 'New question'), key: key(), input: 'text', options: [], required: false, placeholder: '' };
      case 'choice': return { id, kind, label: L('new_choice', 'What happened?'), key: key(), required: true, options: [{ id: 'option_1', label: L('option_n', 'Option {n}', { n: 1 }) }, { id: 'option_2', label: L('option_n', 'Option {n}', { n: 2 }) }] };
      case 'contact': return { id, kind, label: '', mode: 'find_or_create', from: { name: 'answers.name', phone: 'answers.phone', email: 'answers.email' } };
      case 'project': return { id, kind, label: '', mode: 'create_lead', from: { address: 'answers.address' } };
      case 'action': return { id, kind, label: L('text_them', 'Text them'), automation: 'communications.sendSms.v1', input: { to: '{{project.contacts.0.phone}}', text: '' }, preview: '', explainer: '' };
      case 'outcome': return { id, kind, label: '', outcome: flow.outcomes[0]?.id || '' };
      case 'buttons': return { id, kind, label: '', buttons: [{ kind: 'close', label: L('btn_close', 'Close'), target: '' }] };
      default: return { id, kind, label: '', text: '' };
    }
  }

  /** Every way out of a step, in the order the map draws them: [{ label, to: 'step:<id>' | 'outcome:<id>' | 'end' | 'buttons', back }] */
  function exitsOf(step){
    const exits = [];
    for (const block of step.blocks) {
      if (block.kind === 'choice') for (const option of block.options) exits.push({ label: option.label || option.id, to: option.to ? `step:${option.to}` : option.outcome ? `outcome:${option.outcome}` : 'next', block: block.id });
      if (block.kind === 'outcome') exits.push({ label: L('ends', 'Ends'), to: block.outcome ? `outcome:${block.outcome}` : 'end', block: block.id });
      if (block.kind === 'buttons') exits.push({ label: (block.buttons || []).map((button) => button.label || buttonName(button.kind)).join(' · '), to: 'buttons', block: block.id });
    }
    const next = step.next;
    const then = (to) => (to ? `step:${to}` : 'end');
    // Options with no destination follow `next`; draw that once, labeled by them.
    const following = exits.filter((exit) => exit.to === 'next');
    const rest = exits.filter((exit) => exit.to !== 'next');
    const hasEnd = rest.some((exit) => exit.to.startsWith('outcome:') || exit.to === 'buttons');
    if (next && typeof next === 'object') {
      (next.branches || []).forEach((branch, index) => rest.push({ label: L('if_n', 'If {n}', { n: index + 1 }), to: then(branch.to), branch: index }));
      rest.push({ label: L('otherwise', 'Otherwise'), to: then(next.otherwise), branch: 'otherwise' });
    } else if (following.length || !hasEnd || next) {
      rest.push({ label: following.length ? following.map((exit) => exit.label).join(', ') : L('then', 'Then'), to: then(next), then: true });
    }
    return rest;
  }

  /** Columns: steps by their shortest distance from the start; steps nothing reaches come last. */
  function layout(flow){
    const depth = new Map([[flow.start, 0]]), queue = [flow.start];
    const ids = new Set(flow.steps.map((step) => step.id));
    while (queue.length) {
      const id = queue.shift(); const step = flow.steps.find((entry) => entry.id === id); if (!step) continue;
      for (const exit of exitsOf(step)) {
        const to = exit.to.startsWith('step:') ? exit.to.slice(5) : '';
        if (to && ids.has(to) && !depth.has(to)) { depth.set(to, depth.get(id) + 1); queue.push(to); }
      }
    }
    const columns = [];
    for (const step of flow.steps) { if (!depth.has(step.id)) continue; (columns[depth.get(step.id)] ||= []).push(step); }
    const unreached = flow.steps.filter((step) => !depth.has(step.id));
    return { columns: columns.filter(Boolean), unreached, depth };
  }

  /** Where an issue path points: the nearest field drawn with that path, or its step's card. */
  function issueList(error){
    const raw = error?.data?.details?.issues || error?.data?.issues || [];
    return raw.map((issue) => ({ path: Array.isArray(issue.path) ? issue.path.join('.') : clean(issue.path), message: clean(issue.message) })).filter((issue) => issue.message);
  }

  // ── The component ───────────────────────────────────────────────────────────

  let shared = { org: '', at: 0, pending: null, data: null };
  /** The organization's flows, templates and the actions blocks may name (one request, shared by every editor). */
  function library(fresh = false){
    const org = orgId();
    if (!fresh && shared.org === org && shared.data && Date.now() - shared.at < 60_000) return Promise.resolve(shared.data);
    if (!fresh && shared.org === org && shared.pending) return shared.pending;
    shared = { org, at: 0, data: null, pending: api('/flows').then((data) => { shared = { org, at: Date.now(), pending: null, data }; return data; }).catch((error) => { shared = { org, at: 0, pending: null, data: null }; throw error; }) };
    return shared.pending;
  }

  function mount(el, options = {}){
    ensureStyles();
    const readOnly = !!options.readOnly;
    let flowId = clean(options.flowId), version = 0, flow = null, saved = '', selected = '', settingsOpen = false;
    let issues = [], banner = '', busy = false, alive = true, actions = [], flows = [], conflict = false;
    let resizeObserver = null, frame = 0;
    el.innerHTML = '<div class="fme-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i></div>';

    const dirty = () => !!flow && JSON.stringify(flow) !== saved;
    const changed = () => { options.onChange?.(flow); updateStatus(); };
    const stepIndex = (id) => flow.steps.findIndex((step) => step.id === id);
    const outcomeOf = (id) => flow.outcomes.find((outcome) => outcome.id === id);
    const stepOf = (id) => flow.steps.find((step) => step.id === id);
    const stepLabel = (id) => { const step = stepOf(id); return step ? (step.title || step.id) : id; };
    const issueAt = (path) => issues.filter((issue) => issue.path === path);
    const issuesUnder = (prefix) => issues.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
    const issueHtml = (path) => issueAt(path).map((issue) => `<span class="fme-issue" role="alert" data-issue="${esc(path)}">${esc(issue.message)}</span>`).join('');
    const dis = readOnly ? 'disabled' : '';

    async function load(){
      try {
        if (!readOnly) library().then((data) => { actions = Array.isArray(data?.actions) ? data.actions : []; flows = Array.isArray(data?.flows) ? data.flows : []; if (flow && alive) render(); }).catch(() => {});
        if (flowId) {
          let result;
          try { result = await api(`/flows/${encodeURIComponent(flowId)}${readOnly ? '' : '?latest=1'}`); }
          catch (error) { if (readOnly && error?.data?.error === 'flow_not_published') result = await api(`/flows/${encodeURIComponent(flowId)}?latest=1`); else throw error; }
          flow = normalize(result.flow.definition); version = Number(result.flow.latest_version || result.flow.version || 0);
        } else flow = normalize(options.definition || blankFlow(options.kind));
        saved = flowId ? JSON.stringify(flow) : '';
        selected = readOnly ? '' : flow.start;
        render();
      } catch (error) {
        if (alive) el.innerHTML = `<p class="fme-issue" role="alert" style="padding:16px">${esc(error?.message || L('load_failed', 'This flow could not be loaded.'))}</p>`;
      }
    }

    // ── Drawing ──
    function render(){
      if (!alive || !flow) return;
      const { columns, unreached } = layout(flow);
      const scroll = el.querySelector('.fme-map'), keep = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
      const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.path : '';
      el.innerHTML = `<div class="fme" data-kind="${esc(flow.kind)}" ${readOnly ? 'data-readonly' : ''}>
        <div class="fme-top">
          <i class="fas ${esc(flow.icon || 'fa-diagram-project')} fme-icon" style="background:${esc(flow.color || '#2563eb')}" aria-hidden="true"></i>
          <input class="fme-name" type="text" data-path="name" value="${esc(flow.name)}" aria-label="${esc(L('flow_name', 'Flow name'))}" ${dis}>
          <div class="fme-seg" role="group" aria-label="${esc(L('kind', 'What it is'))}">
            ${[['call', 'fa-phone', L('kind_call', 'Call script')], ['workflow', 'fa-list-check', L('kind_workflow', 'Workflow')]].map(([kind, icon, label]) => `<button type="button" data-kind-set="${kind}" aria-pressed="${flow.kind === kind}" ${dis}><i class="fas ${icon}" aria-hidden="true"></i>${esc(label)}</button>`).join('')}
          </div>
          <button type="button" class="fme-btn" data-settings aria-expanded="${settingsOpen}"><i class="fas fa-sliders" aria-hidden="true"></i>${esc(L('flow_settings', 'Settings'))}</button>
          <button type="button" class="fme-btn" data-play><i class="fas fa-play" aria-hidden="true"></i>${esc(L('play', 'Play'))}</button>
          ${readOnly ? '' : `<span class="fme-status" data-status></span><button type="button" class="fme-btn primary" data-save ${busy ? 'disabled' : ''}><i class="fas fa-floppy-disk" aria-hidden="true"></i>${esc(busy ? L('saving', 'Saving…') : L('save', 'Save'))}</button>`}
          ${options.onClose ? `<button type="button" class="fme-btn ghost icon" data-close aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}
        </div>
        <div data-banner></div>
        <div class="fme-body">
          <div class="fme-settings" ${settingsOpen ? '' : 'hidden'}>${settingsHtml()}</div>
          <div class="fme-map">
            <svg class="fme-wires" aria-hidden="true"></svg>
            <div class="fme-cols">
              ${columns.map((steps, index) => `<div class="fme-col ${steps.some((step) => step.id === selected) ? 'wide' : ''}"><div class="fme-col-head">${esc(index === 0 ? L('col_start', 'Start') : L('col_n', 'Then {n}', { n: index }))}</div>${steps.map(stepCard).join('')}</div>`).join('')}
              ${unreached.length ? `<div class="fme-col ${unreached.some((step) => step.id === selected) ? 'wide' : ''}"><div class="fme-col-head">${esc(L('col_unreached', 'Not reached yet'))}</div>${unreached.map(stepCard).join('')}</div>` : ''}
              <div class="fme-col" data-outcomes><div class="fme-col-head">${esc(L('col_outcomes', 'Outcomes'))}</div>${flow.outcomes.map(outcomeCard).join('') || `<p class="fme-empty-col">${esc(L('no_outcomes', 'No outcomes. A run just ends.'))}</p>`}
                <button type="button" class="fme-btn small" data-add-outcome data-edit-only><i class="fas fa-plus" aria-hidden="true"></i>${esc(L('add_outcome', 'Add an outcome'))}</button></div>
            </div>
          </div>
        </div>
      </div>`;
      const map = el.querySelector('.fme-map');
      if (keep) { map.scrollLeft = keep[0]; map.scrollTop = keep[1]; }
      if (focus) { const again = el.querySelector(`[data-path="${CSS.escape(focus)}"]`); again?.focus?.({ preventScroll: true }); }
      placeIssues();
      updateStatus();
      wires();
      resizeObserver?.disconnect();
      if (root.ResizeObserver) { resizeObserver = new ResizeObserver(() => wires()); resizeObserver.observe(el.querySelector('.fme-cols')); }
    }
    /**
     * Puts every issue the drawing did not already show next to the nearest thing its path names (a field, a block,
     * a step or outcome card); what names nothing drawn goes in the banner at the top.
     */
    function placeIssues(){
      const loose = [];
      for (const issue of issues) {
        if (el.querySelector(`[data-issue="${CSS.escape(issue.path)}"]`)) continue;
        const parts = issue.path ? issue.path.split('.') : [];
        let host = null;
        for (let n = parts.length; n > 0 && !host; n -= 1) {
          const prefix = parts.slice(0, n).join('.');
          const field = el.querySelector(`[data-path="${CSS.escape(prefix)}"],[data-target="${CSS.escape(prefix)}"],[data-option-target="${CSS.escape(prefix)}"]`);
          if (field) { host = field.closest('.fme-f') || field.parentElement; break; }
          let match = prefix.match(/^steps\.(\d+)\.blocks\.(\d+)$/);
          if (match) { host = el.querySelector(`[data-card="step:${CSS.escape(flow.steps[Number(match[1])]?.id || '')}"] [data-block-index="${match[2]}"]`); if (host) break; }
          match = prefix.match(/^steps\.(\d+)$/);
          if (match) { host = el.querySelector(`[data-card="step:${CSS.escape(flow.steps[Number(match[1])]?.id || '')}"] .fme-card-head`)?.parentElement || null; if (host) break; }
          match = prefix.match(/^outcomes\.(\d+)$/);
          if (match) { host = el.querySelector(`[data-outcome="${match[1]}"]`); if (host) break; }
        }
        const card = host?.closest?.('[data-card]');
        // A closed card only shows its red mark; the issue goes in the banner too so it can be read.
        if (!host || (card && card.getAttribute('aria-current') !== 'true')) { loose.push(issue); continue; }
        const note = document.createElement('span');
        note.className = 'fme-issue'; note.setAttribute('role', 'alert'); note.dataset.issue = issue.path; note.textContent = issue.message;
        if (host.matches('.fme-card')) host.querySelector('.fme-card-head').after(note); else host.appendChild(note);
      }
      const slot = el.querySelector('[data-banner]'); if (!slot) return;
      if (!banner && !issues.length) { slot.innerHTML = ''; return; }
      slot.innerHTML = `<div class="fme-banner" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><div>${esc(banner || L('not_saved', 'Not saved. Fix what is marked.'))}${loose.length ? `<ul>${loose.map((issue) => `<li>${esc(issue.message)}</li>`).join('')}</ul>` : ''}</div>${conflict ? `<button type="button" class="fme-btn small" data-reload>${esc(L('reload', 'Reload'))}</button>` : ''}</div>`;
    }

    function updateStatus(){
      const status = el.querySelector('[data-status]'); if (!status) return;
      const changedNow = dirty() || !flowId;
      status.className = `fme-status ${changedNow ? 'dirty' : ''}`;
      status.textContent = !flowId ? L('not_saved_yet', 'Not saved yet') : changedNow ? L('unsaved', 'Unsaved changes') : L('saved_version', 'Saved · version {n}', { n: version });
    }

    function settingsHtml(){
      const menu = flow.entry.new_menu || {};
      return `<label class="fme-f"><span>${esc(L('description', 'Description'))}</span><textarea data-path="description" rows="2" ${dis}>${esc(flow.description)}</textarea>${issueHtml('description')}</label>
        <div class="fme-f"><span>${esc(L('look', 'Icon and color'))}</span><div class="fme-row"><input type="text" data-path="icon" value="${esc(flow.icon)}" placeholder="fa-diagram-project" aria-label="${esc(L('icon', 'Icon'))}" ${dis}><input type="color" data-path="color" value="${esc(flow.color || '#2563eb')}" aria-label="${esc(L('color', 'Color'))}" ${dis}></div></div>
        <div class="fme-f"><span>${esc(L('new_menu', 'New menu'))}</span>
          <label class="fme-check"><input type="checkbox" data-path="entry.new_menu.enabled" data-type="bool" ${menu.enabled ? 'checked' : ''} ${dis}>${esc(L('in_new_menu', 'Show it in the New menu'))}</label>
          <div class="fme-row"><label class="fme-f"><span>${esc(L('menu_label', 'Label'))}</span><input type="text" data-path="entry.new_menu.label" value="${esc(menu.label || '')}" placeholder="${esc(flow.name)}" ${dis}></label>
          <label class="fme-f"><span>${esc(L('menu_icon', 'Icon'))}</span><input type="text" data-path="entry.new_menu.icon" value="${esc(menu.icon || '')}" placeholder="${esc(flow.icon)}" ${dis}></label>
          <label class="fme-f" style="flex:0 0 80px"><span>${esc(L('menu_order', 'Order'))}</span><input type="number" data-path="entry.new_menu.sort_order" data-type="int" value="${esc(menu.sort_order ?? 0)}" ${dis}></label></div>
          ${issueHtml('entry.new_menu')}</div>
        <label class="fme-f"><span>${esc(L('starts_at', 'Starts at'))}</span><select data-path="start" ${dis}>${flow.steps.map((step) => `<option value="${esc(step.id)}" ${step.id === flow.start ? 'selected' : ''}>${esc(step.title || step.id)}</option>`).join('')}</select>${issueHtml('start')}</label>`;
    }

    function summaryLine(block){
      const icon = block.kind === 'action' ? ACTION_ICONS[block.automation] || BLOCK_ICONS.action : BLOCK_ICONS[block.kind];
      const text = block.kind === 'say' || block.kind === 'note' ? block.text
        : block.kind === 'ask' ? `${block.label || block.key}${block.required ? ' *' : ''}`
        : block.kind === 'choice' ? block.label || block.key
        : block.kind === 'action' ? `${block.label || actionTitle(block.automation)}${block.preview ? `: ${block.preview}` : ''}`
        : block.kind === 'contact' ? L('sum_contact', 'Finds or makes the contact')
        : block.kind === 'project' ? (block.mode === 'create_project' ? L('sum_project', 'Makes the project') : block.mode === 'find' ? L('sum_find_project', 'Finds the project') : L('sum_lead', 'Makes the lead'))
        : block.kind === 'outcome' ? L('sum_outcome', 'Ends: {name}', { name: outcomeOf(block.outcome)?.label || block.outcome })
        : block.kind === 'buttons' ? L('sum_buttons', 'Buttons at the end') : '';
      return `<li><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(text || '…')}</span></li>`;
    }

    function exitHtml(step, exit){
      const id = exit.to.startsWith('step:') ? exit.to.slice(5) : '', outcomeId = exit.to.startsWith('outcome:') ? exit.to.slice(8) : '';
      const outcome = outcomeId ? outcomeOf(outcomeId) : null;
      const target = id ? `<button type="button" class="fme-exit-to" data-jump="${esc(id)}">${esc(stepOf(id) ? stepLabel(id) : L('missing_step', 'Missing step'))}</button>`
        : outcomeId ? `<span class="fme-exit-to outcome" style="background:${esc(outcome?.color || '#d92d20')}">${esc(outcome?.label || L('missing_outcome', 'Missing outcome'))}</span>`
        : exit.to === 'buttons' ? `<span class="fme-exit-to end"><i class="fas fa-hand-pointer" aria-hidden="true"></i></span>`
        : `<span class="fme-exit-to end">${esc(L('end', 'End'))}</span>`;
      return `<div class="fme-exit" data-exit-to="${esc(id ? `step:${id}` : outcomeId ? `outcome:${outcomeId}` : '')}" data-from="${esc(step.id)}"><span class="fme-exit-label">${esc(exit.label)}</span>${target}</div>`;
    }

    function stepCard(step){
      const index = stepIndex(step.id), open = selected === step.id;
      const errors = issuesUnder(`steps.${index}`);
      return `<section class="fme-card ${errors.length ? 'has-error' : ''}" data-card="step:${esc(step.id)}" data-step="${esc(step.id)}" aria-current="${open}" ${open ? '' : `tabindex="0" role="button" aria-label="${esc(L('open_step', 'Open {name}', { name: step.title || step.id }))}"`}>
        <div class="fme-card-head"><span class="fme-step-n">${index + 1}</span>
          ${open && !readOnly ? `<input type="text" data-path="steps.${index}.title" value="${esc(step.title)}" placeholder="${esc(L('step_title', 'Step title'))}" aria-label="${esc(L('step_title', 'Step title'))}">` : `<strong>${esc(step.title || step.id)}</strong>`}
          ${flow.start === step.id ? `<span class="fme-start">${esc(L('start', 'Start'))}</span>` : ''}
          ${errors.length && !open ? `<i class="fas fa-circle-exclamation fme-err-dot" title="${esc(errors[0].message)}" aria-label="${esc(errors[0].message)}"></i>` : ''}
          ${open && !readOnly ? `<button type="button" class="fme-btn ghost icon" data-step-move="-1" title="${esc(L('move_up', 'Move up'))}" aria-label="${esc(L('move_up', 'Move up'))}" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button><button type="button" class="fme-btn ghost icon" data-step-move="1" title="${esc(L('move_down', 'Move down'))}" aria-label="${esc(L('move_down', 'Move down'))}" ${index === flow.steps.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button><button type="button" class="fme-btn ghost icon" data-step-remove title="${esc(L('remove_step', 'Remove step'))}" aria-label="${esc(L('remove_step', 'Remove step'))}" ${flow.steps.length < 2 ? 'disabled' : ''}><i class="fas fa-trash-can"></i></button><button type="button" class="fme-btn ghost icon" data-deselect title="${esc(L('collapse', 'Collapse'))}" aria-label="${esc(L('collapse', 'Collapse'))}"><i class="fas fa-compress"></i></button>` : ''}
        </div>
        ${issueHtml(`steps.${index}.id`)}${issueHtml(`steps.${index}.title`)}
        ${open ? `<div class="fme-detail">${step.blocks.map((block, b) => blockEditor(step, index, block, b)).join('')}
            <div class="fme-add" data-edit-only><span class="fme-sub" style="width:100%">${esc(L('add_block', 'Add'))}</span>${BLOCK_KINDS.map((kind) => `<button type="button" class="fme-btn small" data-add-block="${kind}"><i class="fas ${BLOCK_ICONS[kind]}" aria-hidden="true"></i>${esc(blockName(kind, flow.kind))}</button>`).join('')}</div>
            ${nextEditor(step, index)}
            ${flow.start !== step.id ? `<button type="button" class="fme-btn small ghost" data-make-start data-edit-only style="align-self:flex-start"><i class="fas fa-flag" aria-hidden="true"></i>${esc(L('make_start', 'Start the flow here'))}</button>` : ''}
          </div>`
          : `<ul class="fme-sum">${step.blocks.map(summaryLine).join('') || `<li><i class="fas fa-ellipsis"></i><span>${esc(L('empty_step', 'Nothing on this step yet'))}</span></li>`}</ul>`}
        <div class="fme-exits">${exitsOf(step).map((exit) => exitHtml(step, exit)).join('')}</div>
      </section>`;
    }

    /** "Goes to" choices: a step, an outcome, or (for options) whatever comes after the step. */
    function targetOptions(current, { allowNext = false, allowOutcomes = false, endLabel } = {}){
      return `${allowNext ? `<option value="" ${!current ? 'selected' : ''}>${esc(L('goes_next', 'Carry on (after this step)'))}</option>` : `<option value="" ${!current ? 'selected' : ''}>${esc(endLabel || L('ends_here', 'End here'))}</option>`}
        <optgroup label="${esc(L('steps', 'Steps'))}">${flow.steps.map((step) => `<option value="step:${esc(step.id)}" ${current === `step:${step.id}` ? 'selected' : ''}>${esc(step.title || step.id)}</option>`).join('')}<option value="new-step">${esc(L('new_step_option', '+ A new step'))}</option></optgroup>
        ${allowOutcomes ? `<optgroup label="${esc(L('outcomes', 'Outcomes'))}">${flow.outcomes.map((outcome) => `<option value="outcome:${esc(outcome.id)}" ${current === `outcome:${outcome.id}` ? 'selected' : ''}>${esc(outcome.label || outcome.id)}</option>`).join('')}<option value="new-outcome">${esc(L('new_outcome_option', '+ A new outcome'))}</option></optgroup>` : ''}`;
    }

    function nextEditor(step, index){
      const next = step.next, at = `steps.${index}.next`;
      if (next && typeof next === 'object') {
        return `<div class="fme-f"><span>${esc(L('after_step', 'After this step'))}</span>
          ${(next.branches || []).map((branch, b) => `<div class="fme-block"><div class="fme-row"><label class="fme-f"><span>${esc(L('when_json', 'When (conditions)'))}</span><textarea class="code" rows="2" data-path="${at}.branches.${b}.when" data-type="json" ${dis}>${esc(JSON.stringify(branch.when ?? {}, null, 1))}</textarea>${issueHtml(`${at}.branches.${b}.when`)}</label></div>
            <div class="fme-row"><label class="fme-f"><span>${esc(L('goes_to', 'Goes to'))}</span><select data-target="${at}.branches.${b}.to" ${dis}>${targetOptions(branch.to ? `step:${branch.to}` : '')}</select>${issueHtml(`${at}.branches.${b}.to`)}</label><button type="button" class="fme-btn icon ghost" data-branch-remove="${b}" data-edit-only aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div></div>`).join('')}
          <label class="fme-f"><span>${esc(L('otherwise', 'Otherwise'))}</span><select data-target="${at}.otherwise" ${dis}>${targetOptions(next.otherwise ? `step:${next.otherwise}` : '')}</select>${issueHtml(`${at}.otherwise`)}</label>
          <div class="fme-row" data-edit-only><button type="button" class="fme-btn small" data-branch-add><i class="fas fa-plus"></i>${esc(L('add_branch', 'Add a branch'))}</button><button type="button" class="fme-btn small ghost" data-branches-off>${esc(L('no_branches', 'No branches'))}</button></div></div>`;
      }
      return `<div class="fme-row"><label class="fme-f"><span>${esc(L('after_step', 'After this step'))}</span><select data-target="${at}" ${dis}>${targetOptions(next ? `step:${next}` : '')}</select>${issueHtml(at)}</label>
        <button type="button" class="fme-btn small ghost" data-branches-on data-edit-only title="${esc(L('branches_hint', 'Go to different steps depending on the answers'))}"><i class="fas fa-code-branch"></i>${esc(L('branches', 'Branches'))}</button></div>`;
    }

    function templateChips(path){
      if (readOnly) return '';
      const keys = [...allKeys(flow)].map((key) => `answers.${key}`);
      return `<div class="fme-chips" data-edit-only>${[...keys, ...TEMPLATE_FIELDS].map((field) => `<button type="button" class="fme-chip" data-insert="{{${esc(field)}}}" data-into="${esc(path)}">${esc(field)}</button>`).join('')}</div>`;
    }

    const actionTitle = (id) => actions.find((action) => action.id === id)?.title || id;
    function actionSelect(path, current){
      const known = actions.some((action) => action.id === current);
      const groups = {};
      for (const action of actions) (groups[action.category || 'other'] ||= []).push(action);
      return `<select data-path="${path}" data-action-pick ${dis}>${!current ? `<option value="">${esc(L('pick_action', 'Pick an action'))}</option>` : ''}${known || !current ? '' : `<option value="${esc(current)}" selected>${esc(current)}</option>`}
        ${Object.entries(groups).map(([group, list]) => `<optgroup label="${esc(group)}">${list.map((action) => `<option value="${esc(action.id)}" ${action.id === current ? 'selected' : ''}>${esc(action.title)}</option>`).join('')}</optgroup>`).join('')}</select>`;
    }
    /** An action's input as fields from its schema: texts and emails show their copy; anything structured is JSON. */
    function inputFields(path, automation, input){
      const schema = actions.find((action) => action.id === automation)?.input_schema;
      const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : null;
      const names = props ? Object.keys(props).filter((name) => !['recipients'].includes(name) || input[name] !== undefined) : Object.keys(input);
      for (const name of Object.keys(input)) if (!names.includes(name)) names.push(name);
      if (!names.length) return `<p class="fme-sub" style="text-transform:none">${esc(L('no_input', 'Nothing to fill in.'))}</p>`;
      return names.map((name) => {
        const prop = props?.[name] || {}, value = input[name], at = `${path}.${name}`;
        const title = prop.title || name, structured = (value && typeof value === 'object') || ['object', 'array'].includes(Array.isArray(prop.type) ? '' : prop.type);
        if (structured) return `<label class="fme-f"><span>${esc(title)}</span><textarea class="code" rows="2" data-path="${at}" data-type="json" ${dis}>${esc(value === undefined ? '' : JSON.stringify(value))}</textarea>${issueHtml(at)}</label>`;
        if (Array.isArray(prop.enum)) return `<label class="fme-f"><span>${esc(title)}</span><select data-path="${at}" ${dis}><option value=""></option>${prop.enum.map((option) => `<option ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></label>`;
        const long = prop['x-control'] === 'template_long_text' || name === 'text' || name === 'message' || name === 'body';
        return `<label class="fme-f"><span>${esc(title)}</span>${long ? `<textarea rows="3" data-path="${at}" data-copy ${dis}>${esc(value ?? '')}</textarea>${templateChips(at)}` : `<input type="text" data-path="${at}" value="${esc(value ?? '')}" ${dis}>`}${issueHtml(at)}</label>`;
      }).join('');
    }

    function optionsEditor(step, index, block, b, withTargets){
      const at = `steps.${index}.blocks.${b}.options`;
      return `<div class="fme-f"><span>${esc(withTargets ? L('options_go', 'Options, and where each goes') : L('options', 'Options'))}</span>
        ${block.options.map((option, o) => `<div class="fme-opt ${withTargets ? '' : 'two'}"><input type="text" data-path="${at}.${o}.label" value="${esc(option.label)}" aria-label="${esc(L('option_label', 'Option'))}" ${dis}>
          ${withTargets ? `<select data-option-target="${at}.${o}" aria-label="${esc(L('goes_to', 'Goes to'))}" ${dis}>${targetOptions(option.to ? `step:${option.to}` : option.outcome ? `outcome:${option.outcome}` : '', { allowNext: true, allowOutcomes: true })}</select>` : ''}
          <button type="button" class="fme-btn icon ghost" data-option-remove="${o}" data-edit-only aria-label="${esc(L('remove_option', 'Remove option'))}" ${withTargets && block.options.length < 2 ? 'disabled' : ''}><i class="fas fa-xmark"></i></button></div>${issueHtml(`${at}.${o}.to`)}${issueHtml(`${at}.${o}.outcome`)}${issueHtml(`${at}.${o}.label`)}`).join('')}
        <button type="button" class="fme-btn small" data-option-add data-edit-only style="align-self:flex-start"><i class="fas fa-plus"></i>${esc(L('add_option', 'Add an option'))}</button>${issueHtml(at)}</div>`;
    }

    function fromEditor(at, block, fields){
      const names = [...new Set([...fields, ...Object.keys(block.from || {})])];
      return `<div class="fme-f"><span>${esc(L('takes_from', 'Takes'))}</span>${names.map((name) => `<div class="fme-row"><label class="fme-f"><span>${esc(name)}</span><input type="text" data-path="${at}.from.${name}" value="${esc(block.from?.[name] ?? '')}" placeholder="answers.${esc(name)}" ${dis}></label></div>`).join('')}</div>`;
    }

    function blockEditor(step, index, block, b){
      const at = `steps.${index}.blocks.${b}`;
      const errors = issuesUnder(at);
      const head = `<div class="fme-block-head"><i class="fas ${block.kind === 'action' ? ACTION_ICONS[block.automation] || BLOCK_ICONS.action : BLOCK_ICONS[block.kind]} k" aria-hidden="true"></i><strong>${esc(blockName(block.kind, flow.kind))}</strong>
        <span data-edit-only style="display:contents"><button type="button" class="fme-btn ghost icon" data-block-move="-1" aria-label="${esc(L('move_up', 'Move up'))}" ${b === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button><button type="button" class="fme-btn ghost icon" data-block-move="1" aria-label="${esc(L('move_down', 'Move down'))}" ${b === step.blocks.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button><button type="button" class="fme-btn ghost icon" data-block-remove aria-label="${esc(L('remove_block', 'Remove'))}"><i class="fas fa-trash-can"></i></button></span></div>${issueHtml(`${at}.id`)}`;
      let body = '';
      switch (block.kind) {
        case 'say': case 'note':
          body = `<textarea rows="3" data-path="${at}.text" aria-label="${esc(blockName(block.kind, flow.kind))}" placeholder="${esc(block.kind === 'say' ? (flow.kind === 'call' ? L('say_hint', 'What to say, e.g. Hi {{contact.first_name}}…') : L('show_hint', 'What to show')) : L('note_hint', 'A tip for whoever plays it; never said to the customer'))}" ${dis}>${esc(block.text)}</textarea>${templateChips(`${at}.text`)}${issueHtml(`${at}.text`)}`;
          break;
        case 'ask': {
          const custom = block.saves_to && !SAVES_TO.includes(block.saves_to);
          body = `<label class="fme-f"><span>${esc(L('question', 'Question'))}</span><input type="text" data-path="${at}.label" value="${esc(block.label)}" ${dis}>${issueHtml(`${at}.label`)}</label>
            <div class="fme-row"><label class="fme-f"><span>${esc(L('answer_kind', 'Answer'))}</span><select data-path="${at}.input" data-rerender ${dis}>${ASK_INPUTS.map((input) => `<option value="${input}" ${block.input === input ? 'selected' : ''}>${esc(inputName(input))}</option>`).join('')}</select></label>
              <label class="fme-f"><span>${esc(L('answer_key', 'Saved as'))}</span><input type="text" data-path="${at}.key" value="${esc(block.key)}" ${dis}>${issueHtml(`${at}.key`)}</label></div>
            ${['select', 'multi'].includes(block.input) ? optionsEditor(step, index, block, b, false) : ''}
            ${['select', 'multi', 'yes_no'].includes(block.input) ? '' : `<label class="fme-f"><span>${esc(L('placeholder', 'Hint inside the box'))}</span><input type="text" data-path="${at}.placeholder" value="${esc(block.placeholder || '')}" ${dis}></label>`}
            <div class="fme-row"><label class="fme-f"><span>${esc(L('saves_to', 'Also write it to'))}</span><select data-saves-to="${at}" ${dis}><option value="">${esc(L('saves_nowhere', 'Only keep it on the run'))}</option>${SAVES_TO.map((field) => `<option value="${field}" ${block.saves_to === field ? 'selected' : ''}>${esc(field)}</option>`).join('')}<option value="custom" ${custom ? 'selected' : ''}>${esc(L('saves_custom', 'A custom field…'))}</option></select></label>
              ${custom ? `<label class="fme-f"><span>${esc(L('custom_field', 'Custom field'))}</span><input type="text" data-path="${at}.saves_to" value="${esc(block.saves_to)}" placeholder="project.cf.roof_age" ${dis}></label>` : ''}
              <label class="fme-check"><input type="checkbox" data-path="${at}.required" data-type="bool" ${block.required ? 'checked' : ''} ${dis}>${esc(L('required', 'Required'))}</label></div>${issueHtml(`${at}.saves_to`)}`;
          break;
        }
        case 'choice':
          body = `<div class="fme-row"><label class="fme-f"><span>${esc(L('question', 'Question'))}</span><input type="text" data-path="${at}.label" value="${esc(block.label)}" ${dis}></label><label class="fme-f" style="flex:0 1 130px"><span>${esc(L('answer_key', 'Saved as'))}</span><input type="text" data-path="${at}.key" value="${esc(block.key)}" ${dis}>${issueHtml(`${at}.key`)}</label></div>
            ${optionsEditor(step, index, block, b, true)}
            <label class="fme-check"><input type="checkbox" data-path="${at}.required" data-type="bool" ${block.required ? 'checked' : ''} ${dis}>${esc(L('required', 'Required'))}</label>`;
          break;
        case 'contact':
          body = `<label class="fme-f"><span>${esc(L('contact_mode', 'The contact'))}</span><select data-path="${at}.mode" ${dis}>${[['find_or_create', L('find_or_create', 'Find it, or make it')], ['find', L('find', 'Find it')], ['create', L('create', 'Make a new one')]].map(([value, label]) => `<option value="${value}" ${block.mode === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>${fromEditor(at, block, ['name', 'phone', 'email', 'address'])}`;
          break;
        case 'project':
          body = `<label class="fme-f"><span>${esc(L('project_mode', 'The lead or project'))}</span><select data-path="${at}.mode" ${dis}>${[['create_lead', L('create_lead', 'Make a lead')], ['find_or_create_lead', L('find_or_create_lead', 'Find the lead, or make one')], ['create_project', L('create_project', 'Make a project')], ['find', L('find_project', 'Find the project')]].map(([value, label]) => `<option value="${value}" ${block.mode === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
            ${fromEditor(at, block, ['address', 'title'])}<label class="fme-f"><span>${esc(L('template_id', 'Board or template (optional)'))}</span><input type="text" data-path="${at}.template_id" value="${esc(block.template_id || '')}" ${dis}></label>`;
          break;
        case 'action':
          body = `<div class="fme-row"><label class="fme-f"><span>${esc(L('does', 'Does'))}</span>${actionSelect(`${at}.automation`, block.automation)}${issueHtml(`${at}.automation`)}</label><label class="fme-f"><span>${esc(L('action_label', 'Shown as'))}</span><input type="text" data-path="${at}.label" value="${esc(block.label)}" ${dis}></label></div>
            ${inputFields(`${at}.input`, block.automation, block.input || {})}
            <label class="fme-f"><span>${esc(L('preview_copy', 'What the person sees before it runs'))}</span><textarea rows="2" data-path="${at}.preview" ${dis}>${esc(block.preview)}</textarea></label>
            <label class="fme-f"><span>${esc(L('explainer', 'Small print'))}</span><input type="text" data-path="${at}.explainer" value="${esc(block.explainer)}" ${dis}></label>
            <details><summary class="fme-sub" style="cursor:pointer">${esc(L('only_when', 'Only when (conditions)'))}</summary><textarea class="code" rows="2" data-path="${at}.when" data-type="json" ${dis}>${esc(block.when ? JSON.stringify(block.when) : '')}</textarea>${issueHtml(`${at}.when`)}</details>`;
          break;
        case 'outcome':
          body = `<label class="fme-f"><span>${esc(L('ends_with', 'Ends the run with'))}</span><select data-option-target="${at}" data-outcome-only ${dis}><option value="">${esc(L('pick_outcome', 'Pick an outcome'))}</option>${flow.outcomes.map((outcome) => `<option value="outcome:${esc(outcome.id)}" ${block.outcome === outcome.id ? 'selected' : ''}>${esc(outcome.label || outcome.id)}</option>`).join('')}<option value="new-outcome">${esc(L('new_outcome_option', '+ A new outcome'))}</option></select>${issueHtml(`${at}.outcome`)}</label>`;
          break;
        case 'buttons':
          body = `${block.buttons.map((button, n) => `<div class="fme-row"><label class="fme-f"><span>${esc(L('button_does', 'Button'))}</span><select data-path="${at}.buttons.${n}.kind" data-rerender ${dis}>${BUTTONS.map((kind) => `<option value="${kind}" ${button.kind === kind ? 'selected' : ''}>${esc(buttonName(kind))}</option>`).join('')}</select></label>
              <label class="fme-f"><span>${esc(L('button_label', 'Label'))}</span><input type="text" data-path="${at}.buttons.${n}.label" value="${esc(button.label)}" placeholder="${esc(buttonName(button.kind))}" ${dis}></label>
              ${button.kind === 'start_flow' ? `<label class="fme-f"><span>${esc(L('which_flow', 'Flow'))}</span><select data-path="${at}.buttons.${n}.target" ${dis}><option value=""></option>${flows.filter((entry) => entry.id !== flowId).map((entry) => `<option value="${esc(entry.id)}" ${button.target === entry.id ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}${button.target && !flows.some((entry) => entry.id === button.target) ? `<option selected>${esc(button.target)}</option>` : ''}</select></label>`
                : button.kind === 'go_to' ? `<label class="fme-f"><span>${esc(L('go_to_target', 'Page or link'))}</span><input type="text" data-path="${at}.buttons.${n}.target" value="${esc(button.target || '')}" placeholder="crm" ${dis}></label>` : ''}
              <button type="button" class="fme-btn icon ghost" data-button-remove="${n}" data-edit-only aria-label="${esc(L('remove', 'Remove'))}" ${block.buttons.length < 2 ? 'disabled' : ''}><i class="fas fa-xmark"></i></button></div>`).join('')}
            <div class="fme-row"><button type="button" class="fme-btn small" data-button-add data-edit-only ${block.buttons.length >= 6 ? 'disabled' : ''}><i class="fas fa-plus"></i>${esc(L('add_button', 'Add a button'))}</button>
              <label class="fme-f"><span>${esc(L('auto', 'Do without asking'))}</span><select data-path="${at}.auto" ${dis}><option value="">${esc(L('auto_none', 'Nothing; wait for a click'))}</option>${block.buttons.map((button) => `<option value="${button.kind}" ${block.auto === button.kind ? 'selected' : ''}>${esc(button.label || buttonName(button.kind))}</option>`).join('')}</select></label></div>${issueHtml(`${at}.buttons`)}`;
          break;
        default: body = '';
      }
      return `<div class="fme-block ${errors.length ? 'has-error' : ''}" data-block-index="${b}" data-block-kind="${esc(block.kind)}">${head}${body}</div>`;
    }

    function outcomeCard(outcome, o){
      const at = `outcomes.${o}`, errors = issuesUnder(at), open = selected === `outcome:${outcome.id}`;
      return `<section class="fme-card fme-outcome-card ${errors.length ? 'has-error' : ''}" data-card="outcome:${esc(outcome.id)}" data-outcome="${o}" aria-current="${open}" ${open ? '' : 'tabindex="0" role="button"'}>
        <div class="fme-card-head" style="background:${esc(outcome.color)}"><i class="fas fa-flag-checkered" style="color:#fff" aria-hidden="true"></i><strong>${esc(outcome.label || outcome.id)}</strong>
          ${open && !readOnly ? `<button type="button" class="fme-btn ghost icon" data-outcome-remove style="color:#fff" aria-label="${esc(L('remove_outcome', 'Remove outcome'))}"><i class="fas fa-trash-can"></i></button><button type="button" class="fme-btn ghost icon" data-deselect style="color:#fff" aria-label="${esc(L('collapse', 'Collapse'))}"><i class="fas fa-compress"></i></button>` : ''}</div>
        ${issueHtml(`${at}.id`)}
        ${open ? `<div class="fme-detail"><div class="fme-row"><label class="fme-f"><span>${esc(L('outcome_label', 'Outcome'))}</span><input type="text" data-path="${at}.label" value="${esc(outcome.label)}" ${dis}></label><input type="color" data-path="${at}.color" value="${esc(outcome.color)}" aria-label="${esc(L('color', 'Color'))}" ${dis}></div>
            <span class="fme-sub">${esc(L('then_runs', 'Then'))}</span>
            ${outcome.effects.map((effect, e) => `<div class="fme-block"><div class="fme-row"><label class="fme-f"><span>${esc(L('does', 'Does'))}</span>${actionSelect(`${at}.effects.${e}.automation`, effect.automation)}</label><button type="button" class="fme-btn icon ghost" data-effect-remove="${e}" data-edit-only aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>${inputFields(`${at}.effects.${e}.input`, effect.automation, effect.input || {})}<label class="fme-f"><span>${esc(L('explainer', 'Small print'))}</span><input type="text" data-path="${at}.effects.${e}.explainer" value="${esc(effect.explainer || '')}" ${dis}></label>${issueHtml(`${at}.effects.${e}.automation`)}</div>`).join('') || `<p class="fme-sub" style="text-transform:none">${esc(L('no_effects', 'Nothing else happens.'))}</p>`}
            <button type="button" class="fme-btn small" data-effect-add data-edit-only style="align-self:flex-start"><i class="fas fa-plus"></i>${esc(L('add_effect', 'Add what happens'))}</button></div>`
          : `<ul class="fme-sum" style="padding-top:8px">${outcome.effects.map((effect) => `<li><i class="fas ${ACTION_ICONS[effect.automation] || 'fa-bolt'}" aria-hidden="true"></i><span>${esc(effect.explainer || actionTitle(effect.automation))}</span></li>`).join('') || `<li><i class="fas fa-minus"></i><span>${esc(L('no_effects', 'Nothing else happens.'))}</span></li>`}</ul>`}
      </section>`;
    }

    /** The lines from each way out of a step to the card it leads to. Skipped when the map is stacked (narrow). */
    function wires(){
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const svg = el.querySelector('.fme-wires'), cols = el.querySelector('.fme-cols');
        if (!svg || !cols) return;
        if (getComputedStyle(svg).display === 'none') { svg.innerHTML = ''; return; }
        const base = cols.getBoundingClientRect();
        svg.setAttribute('width', String(cols.scrollWidth)); svg.setAttribute('height', String(cols.scrollHeight));
        const cards = new Map([...el.querySelectorAll('[data-card]')].map((card) => [card.dataset.card, card.getBoundingClientRect()]));
        const paths = [];
        for (const exit of el.querySelectorAll('.fme-exit[data-exit-to]')) {
          const to = cards.get(exit.dataset.exitTo); if (!to) continue;
          const from = exit.getBoundingClientRect();
          const x1 = from.right - base.left, y1 = from.top + from.height / 2 - base.top;
          const x2 = to.left - base.left, y2 = to.top + 20 - base.top;
          const back = x2 <= x1;
          const reach = back ? 60 : Math.max(24, (x2 - x1) / 2);
          const d = back ? `M${x1},${y1} C${x1 + reach},${y1} ${x2 - reach},${y2 - 30} ${x2},${y2}` : `M${x1},${y1} C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}`;
          const outcome = exit.dataset.exitTo.startsWith('outcome:') ? outcomeOf(exit.dataset.exitTo.slice(8)) : null;
          paths.push(`<path d="${d}" class="${back ? 'back' : ''} ${outcome ? 'outcome' : ''}" ${outcome ? `style="stroke:${esc(outcome.color)}"` : ''} data-wire="${esc(exit.dataset.from)}>${esc(exit.dataset.exitTo)}"></path><circle cx="${x2}" cy="${y2}" r="3" fill="${outcome ? esc(outcome.color) : '#98a2b3'}"></circle>`);
        }
        svg.innerHTML = paths.join('');
      });
    }

    // ── Editing ──
    function setPath(path, value){
      const keys = path.split('.');
      let target = flow;
      for (let i = 0; i < keys.length - 1; i += 1) {
        const key = /^\d+$/.test(keys[i]) ? Number(keys[i]) : keys[i];
        if (target[key] === undefined || target[key] === null) target[key] = {};
        target = target[key];
      }
      const last = keys[keys.length - 1];
      if (value === undefined) delete target[last]; else target[last] = value;
    }
    function getPath(path){ return path.split('.').reduce((value, key) => value?.[/^\d+$/.test(key) ? Number(key) : key], flow); }
    function readField(field){
      const type = field.dataset.type;
      if (type === 'bool') return field.checked;
      if (type === 'int') return Math.round(Number(field.value || 0));
      if (type === 'json') { const raw = clean(field.value); if (!raw) return undefined; try { return JSON.parse(raw); } catch { return Symbol.for('invalid'); } }
      if (field.tagName === 'SELECT' && field.value === '' && /\.(auto|template_id|saves_to)$/.test(field.dataset.path)) return undefined;
      return field.value;
    }

    function addStep(after){
      const taken = new Set(flow.steps.map((step) => step.id));
      const step = { id: uniqueId('step', taken), title: L('new_step', 'New step'), blocks: [], next: null };
      const index = after ? stepIndex(after) + 1 : flow.steps.length;
      flow.steps.splice(index || flow.steps.length, 0, step);
      return step;
    }
    function addOutcome(){
      const taken = new Set(flow.outcomes.map((outcome) => outcome.id));
      const outcome = { id: uniqueId('outcome', taken), label: L('new_outcome', 'New outcome'), color: OUTCOME_COLORS[flow.outcomes.length % OUTCOME_COLORS.length], effects: [] };
      flow.outcomes.push(outcome);
      return outcome;
    }
    /** A destination picked from a select; "+ A new step/outcome" makes one first. Returns { step } or { outcome } or {}. */
    function pickTarget(value, fromStep){
      if (value === 'new-step') { const step = addStep(fromStep); return { step: step.id }; }
      if (value === 'new-outcome') { const outcome = addOutcome(); return { outcome: outcome.id }; }
      if (value.startsWith('step:')) return { step: value.slice(5) };
      if (value.startsWith('outcome:')) return { outcome: value.slice(8) };
      return {};
    }
    function removeStep(id){
      if (flow.steps.length < 2) return;
      flow.steps.splice(stepIndex(id), 1);
      for (const step of flow.steps) {
        if (step.next === id) step.next = null;
        if (step.next && typeof step.next === 'object') { step.next.branches = step.next.branches.filter((branch) => branch.to !== id); if (step.next.otherwise === id) step.next.otherwise = null; }
        for (const block of step.blocks) if (block.kind === 'choice') for (const option of block.options) if (option.to === id) delete option.to;
      }
      if (flow.start === id) flow.start = flow.steps[0].id;
    }
    function removeOutcome(index){
      const [gone] = flow.outcomes.splice(index, 1);
      for (const step of flow.steps) {
        step.blocks = step.blocks.filter((block) => !(block.kind === 'outcome' && block.outcome === gone.id));
        for (const block of step.blocks) if (block.kind === 'choice') for (const option of block.options) if (option.outcome === gone.id) delete option.outcome;
      }
    }
    const move = (list, index, by) => { const to = index + by; if (to < 0 || to >= list.length) return; const [item] = list.splice(index, 1); list.splice(to, 0, item); };
    function clearIssues(path){ if (!issues.length) return; const before = issues.length; issues = issues.filter((issue) => !(issue.path === path || issue.path.startsWith(`${path}.`))); if (before !== issues.length) el.querySelectorAll(`[data-issue="${CSS.escape(path)}"]`).forEach((node) => node.remove()); }

    function onInput(event){
      const field = event.target.closest('[data-path]');
      if (!field || readOnly || field.matches('select') || field.type === 'checkbox') return;
      const path = field.dataset.path, value = readField(field);
      if (value === Symbol.for('invalid')) { field.setCustomValidity(L('bad_json', 'This is not valid JSON.')); return; }
      field.setCustomValidity?.('');
      const before = getPath(path);
      setPath(path, value);
      // A text's or email's copy is also what the person sees, until the preview is written separately.
      if (field.hasAttribute('data-copy')) { const blockPath = path.replace(/\.input\.[^.]+$/, ''); const block = getPath(blockPath); if (block?.kind === 'action' && (!block.preview || block.preview === before)) { block.preview = value; const preview = el.querySelector(`[data-path="${CSS.escape(`${blockPath}.preview`)}"]`); if (preview) preview.value = value; } }
      clearIssues(path);
      if (path === 'name' || path === 'color' || path === 'icon') { const icon = el.querySelector('.fme-icon'); if (icon) { icon.style.background = flow.color; icon.className = `fas ${flow.icon || 'fa-diagram-project'} fme-icon`; } }
      if (/^outcomes\.\d+\.(label|color)$/.test(path) || /\.options\.\d+\.label$/.test(path)) { clearTimeout(onInput.timer); onInput.timer = setTimeout(() => { const card = el.querySelector('[aria-current="true"]'); if (card) refreshExits(); }, 250); }
      changed();
    }
    /** Redraws the exits and outcome heads of the open card without touching its inputs. */
    function refreshExits(){
      for (const card of el.querySelectorAll('[data-card^="step:"]')) { const step = stepOf(card.dataset.step); const exits = card.querySelector('.fme-exits'); if (step && exits) exits.innerHTML = exitsOf(step).map((exit) => exitHtml(step, exit)).join(''); }
      for (const card of el.querySelectorAll('[data-outcome]')) { const outcome = flow.outcomes[Number(card.dataset.outcome)]; const head = card.querySelector('.fme-card-head'); if (outcome && head) { head.style.background = outcome.color; head.querySelector('strong').textContent = outcome.label || outcome.id; } }
      wires();
    }

    function onChange(event){
      const field = event.target;
      if (readOnly) return;
      if (field.dataset.target) {
        const picked = pickTarget(field.value, field.dataset.target.split('.')[1] && flow.steps[Number(field.dataset.target.split('.')[1])]?.id);
        setPath(field.dataset.target, picked.step || null);
        clearIssues(field.dataset.target); render(); return changed();
      }
      if (field.dataset.optionTarget) {
        const at = field.dataset.optionTarget, stepId = flow.steps[Number(at.split('.')[1])]?.id;
        const picked = pickTarget(field.value, stepId), option = getPath(at);
        if (field.hasAttribute('data-outcome-only')) option.outcome = picked.outcome || '';
        else { delete option.to; delete option.outcome; if (picked.step) option.to = picked.step; if (picked.outcome) option.outcome = picked.outcome; }
        clearIssues(at); render(); return changed();
      }
      if (field.dataset.savesTo) {
        const block = getPath(field.dataset.savesTo);
        if (field.value === 'custom') block.saves_to = block.saves_to && !SAVES_TO.includes(block.saves_to) ? block.saves_to : `project.cf.${slug(block.key, 'answer')}`;
        else if (field.value) block.saves_to = field.value; else delete block.saves_to;
        clearIssues(`${field.dataset.savesTo}.saves_to`); render(); return changed();
      }
      const path = field.dataset.path;
      if (!path) return;
      if (field.matches('select') || field.type === 'checkbox' || field.type === 'color') {
        const value = readField(field);
        setPath(path, value === '' && /\.(auto)$/.test(path) ? undefined : value);
        if (field.hasAttribute('data-action-pick')) {
          // A different action keeps only the input it understands; a text or an email starts with its usual recipient.
          const owner = getPath(path.replace(/\.automation$/, ''));
          const schema = actions.find((action) => action.id === value)?.input_schema?.properties || {};
          const input = Object.fromEntries(Object.entries(owner.input || {}).filter(([key]) => key in schema));
          if (value === 'communications.sendSms.v1') input.to ||= '{{project.contacts.0.phone}}';
          if (value === 'communications.sendEmail.v1') input.to ||= '{{project.contacts.0.email}}';
          owner.input = input;
          if (owner.kind === 'action' && (!owner.label || actions.some((action) => action.title === owner.label))) owner.label = actions.find((action) => action.id === value)?.title || owner.label;
        }
        if (path === 'entry.new_menu.enabled' && value && !flow.entry.new_menu.label) Object.assign(flow.entry.new_menu, { label: flow.name, icon: flow.entry.new_menu.icon || flow.icon, role_ids: flow.entry.new_menu.role_ids || [], sort_order: flow.entry.new_menu.sort_order || 0 });
        clearIssues(path);
        if (field.matches('select') || path === 'entry.new_menu.enabled' || /\.color$/.test(path)) render();
        return changed();
      }
    }

    function onClick(event){
      const target = event.target;
      const chip = target.closest('[data-insert]');
      if (chip) {
        const field = el.querySelector(`[data-path="${CSS.escape(chip.dataset.into)}"]`); if (!field) return;
        const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? field.value.length;
        field.value = `${field.value.slice(0, start)}${chip.dataset.insert}${field.value.slice(end)}`;
        field.focus(); field.selectionStart = field.selectionEnd = start + chip.dataset.insert.length;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const jump = target.closest('[data-jump]');
      if (jump) { selected = jump.dataset.jump; render(); scrollToCard(`step:${selected}`); return; }
      if (target.closest('[data-kind-set]')) { if (readOnly) return; flow.kind = target.closest('[data-kind-set]').dataset.kindSet; if (flow.kind === 'call' && flow.icon === 'fa-diagram-project') flow.icon = 'fa-phone-volume'; render(); return changed(); }
      if (target.closest('[data-settings]')) { settingsOpen = !settingsOpen; render(); return; }
      if (target.closest('[data-play]')) return play();
      if (target.closest('[data-save]')) return save();
      if (target.closest('[data-reload]')) { conflict = false; banner = ''; issues = []; el.innerHTML = '<div class="fme-loading"><i class="fas fa-circle-notch fa-spin"></i></div>'; return load(); }
      if (target.closest('[data-close]')) return options.onClose?.();
      if (target.closest('[data-add-outcome]')) { const outcome = addOutcome(); selected = `outcome:${outcome.id}`; render(); return changed(); }
      if (target.closest('[data-deselect]')) { selected = ''; render(); return; }
      const card = target.closest('[data-card]');
      if (!card) return;
      if (card.getAttribute('aria-current') !== 'true') { if (target.closest('input,select,textarea,button')) return; selected = card.dataset.card.startsWith('step:') ? card.dataset.step : card.dataset.card; render(); return; }
      if (readOnly) return;
      const button = target.closest('button'); if (!button) return;
      if (card.dataset.outcome !== undefined) {
        const index = Number(card.dataset.outcome), outcome = flow.outcomes[index];
        if (button.hasAttribute('data-outcome-remove')) { removeOutcome(index); selected = ''; }
        else if (button.hasAttribute('data-effect-add')) outcome.effects.push({ automation: '', input: {}, explainer: '' });
        else if (button.dataset.effectRemove !== undefined) outcome.effects.splice(Number(button.dataset.effectRemove), 1);
        else return;
        render(); return changed();
      }
      const step = stepOf(card.dataset.step); if (!step) return;
      const blockEl = button.closest('[data-block-index]'), b = blockEl ? Number(blockEl.dataset.blockIndex) : -1, block = step.blocks[b];
      if (button.dataset.addBlock) { const added = newBlock(button.dataset.addBlock, step, flow); if (added.kind === 'outcome' && !added.outcome) added.outcome = addOutcome().id; step.blocks.push(added); }
      else if (button.dataset.stepMove) move(flow.steps, stepIndex(step.id), Number(button.dataset.stepMove));
      else if (button.hasAttribute('data-step-remove')) { if (!root.confirm || root.confirm(L('remove_step_confirm', 'Remove the step "{name}"?', { name: step.title || step.id }))) { removeStep(step.id); selected = ''; } else return; }
      else if (button.hasAttribute('data-make-start')) flow.start = step.id;
      else if (button.dataset.blockMove) move(step.blocks, b, Number(button.dataset.blockMove));
      else if (button.hasAttribute('data-block-remove')) step.blocks.splice(b, 1);
      else if (button.hasAttribute('data-option-add')) { const ids = new Set(block.options.map((option) => option.id)); const n = block.options.length + 1; block.options.push({ id: uniqueId('option', ids), label: L('option_n', 'Option {n}', { n }) }); }
      else if (button.dataset.optionRemove !== undefined) block.options.splice(Number(button.dataset.optionRemove), 1);
      else if (button.hasAttribute('data-button-add')) block.buttons.push({ kind: 'close', label: '', target: '' });
      else if (button.dataset.buttonRemove !== undefined) { const [gone] = block.buttons.splice(Number(button.dataset.buttonRemove), 1); if (block.auto === gone.kind && !block.buttons.some((entry) => entry.kind === gone.kind)) delete block.auto; }
      else if (button.hasAttribute('data-branches-on')) step.next = { branches: [{ when: { match: 'all', rules: [] }, to: typeof step.next === 'string' ? step.next : flow.steps.find((entry) => entry.id !== step.id)?.id || step.id }], otherwise: typeof step.next === 'string' ? step.next : null };
      else if (button.hasAttribute('data-branches-off')) step.next = step.next?.otherwise || null;
      else if (button.hasAttribute('data-branch-add')) step.next.branches.push({ when: { match: 'all', rules: [] }, to: step.next.otherwise || step.id });
      else if (button.dataset.branchRemove !== undefined) step.next.branches.splice(Number(button.dataset.branchRemove), 1);
      else return;
      render(); changed();
    }
    function onKey(event){
      const card = event.target.closest?.('[data-card]');
      if (card && event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !readOnly) { event.preventDefault(); save(); }
    }
    function scrollToCard(id){ requestAnimationFrame(() => el.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })); }

    function showIssues(error){
      issues = issueList(error);
      conflict = error?.status === 409;
      banner = conflict ? L('conflict', 'Someone else saved this flow since you opened it. Reload it to see their version; your changes here are not saved.') : issues.length ? '' : clean(error?.message) || L('save_failed', 'Not saved.');
      // Open the first step or outcome an issue names, so its message is next to the field.
      if (issues.some((issue) => /^(description|start|icon|color|entry)/.test(issue.path))) settingsOpen = true;
      const first = issues.map((issue) => issue.path.match(/^(steps|outcomes)\.(\d+)/)).find(Boolean);
      if (first) selected = first[1] === 'steps' ? flow.steps[Number(first[2])]?.id || selected : `outcome:${flow.outcomes[Number(first[2])]?.id}`;
      render();
      requestAnimationFrame(() => (el.querySelector('.fme-card .fme-issue') || el.querySelector('.fme-banner'))?.scrollIntoView?.({ block: 'center', inline: 'nearest' }));
    }

    async function save(){
      if (readOnly || busy) return null;
      busy = true; issues = []; banner = ''; conflict = false; render();
      let result = null;
      try {
        const body = { definition: flow, ...(flowId ? { expected_version: version } : {}) };
        const response = flowId ? await api(`/flows/${encodeURIComponent(flowId)}`, { method: 'PUT', body }) : await api('/flows', { method: 'POST', body });
        result = response.flow;
        flowId = result.id; version = Number(result.latest_version || result.version || version + 1);
        flow = normalize(result.definition); saved = JSON.stringify(flow);
        shared.at = 0;
        root.dispatchEvent(new CustomEvent('fm:flows:changed', { detail: { flow_id: flowId } }));
        toast(L('saved', 'Saved'));
        busy = false; render();
        options.onSave?.(result);
      } catch (error) { busy = false; showIssues(error); }
      return result;
    }

    function play(){
      if (!root.FirstMateFlows?.preview) { toast(L('player_missing', 'The flow player is not loaded on this page.'), 'error'); return; }
      const layer = document.createElement('div');
      layer.className = 'fme-play';
      layer.innerHTML = `<div class="fme-play-shell" role="dialog" aria-modal="true" aria-label="${esc(L('play', 'Play'))}"><div class="fme-play-top"><span>${esc(flow.name)}</span><button type="button" class="fme-btn ghost icon" data-play-close aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button></div><div data-play-mount></div></div>`;
      document.body.appendChild(layer);
      const player = root.FirstMateFlows.preview(layer.querySelector('[data-play-mount]'), clone(flow), { onClose: () => close() });
      const close = () => { player?.destroy?.(); layer.remove(); document.removeEventListener('keydown', escape, true); };
      const escape = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
      layer.addEventListener('click', (event) => { if (event.target === layer || event.target.closest('[data-play-close]')) close(); });
      document.addEventListener('keydown', escape, true);
    }

    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    load();
    return {
      get definition(){ return clone(flow); },
      get flowId(){ return flowId; },
      dirty,
      save,
      destroy(){
        alive = false; resizeObserver?.disconnect(); cancelAnimationFrame(frame);
        el.removeEventListener('input', onInput); el.removeEventListener('change', onChange); el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey);
      }
    };
  }

  /** The editor in its own window. Closing with unsaved changes asks first. */
  function open(flowId, options = {}){
    ensureStyles();
    const modal = document.createElement('div');
    modal.className = 'fm-flow-editor-modal';
    modal.innerHTML = `<div class="fm-flow-editor-shell" role="dialog" aria-modal="true" aria-label="${esc(options.label || L('flow_editor', 'Flow'))}"><div class="fme-mount"></div></div>`;
    document.body.appendChild(modal);
    let editor = null;
    const remove = () => { editor?.destroy?.(); modal.remove(); options.onClose?.(); };
    const handle = root.Portal?.modals?.register?.(modal, { id: `flow-editor-${flowId || 'new'}`, closeOnBackdrop: false, onClose: remove });
    const close = (force = false) => {
      if (!force && editor?.dirty?.() && root.confirm && !root.confirm(L('discard', 'Close without saving your changes?'))) return;
      if (handle?.close) handle.close('close'); else remove();
    };
    if (!handle) modal.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) close(); });
    editor = mount(modal.querySelector('.fme-mount'), { ...options, flowId, onClose: () => close() });
    return { close, modal, get editor(){ return editor; } };
  }

  root.FirstMateFlowEditor = { mount, open, blankFlow, library };
})();
