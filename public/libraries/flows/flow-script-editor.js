/* libraries/flows/flow-script-editor.js
 * The script editor (docs/architecture/flows.md, "Editing as a script"; a prototype beside the map editor in
 * flow-editor.js until Jack picks one). A flow is edited the way it is read: one step at a time, as a script.
 *
 *   left    the steps as a thin tree (branches indented, a step reached twice is listed once and linked); click to
 *           go there, hover to light up every step that can come before it; ⚠ marks a button with no label
 *   middle  the path: the step you are on, the bottom of the one before fading in at the top, the top of the next
 *           one at the bottom (when the next is known: one way on, or a button already chosen). Wheel, arrow keys
 *           or a click on a peeking step move along it, animated. Edit mode (the default) edits in place: the words,
 *           inputs (+ Input), buttons (+ beside them adds a parallel step), + between two steps inserts one
 *   floating a small box to the right of what is selected, centered on it (like a doc comment): its variable, label,
 *           kind, range or options, where a button goes
 *   right   the assistant, in a private conversation about this flow (when the flow is saved)
 *
 *   FirstMateFlowScriptEditor.mount(el, { flowId | definition, embedded, onChange, onSwitchToMap, orgId })
 *   FirstMateFlowScriptEditor.open(flowId, { onSave, onSwitchToMap })   // full-width window
 */
(function(){
  const root = window;
  if (root.FirstMateFlowScriptEditor) return;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const L = (key, fallback) => root.PlatformLanguage?.text?.('flows', `se_${key}`, fallback) ?? fallback;
  const orgOf = (options) => clean(options.orgId || root.__APP?.userOrgId || root.__APP?.orgId);
  const toast = (message, kind = 'success') => root.Portal?.ui?.showToast?.(message, kind);
  const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  const slug = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  // What a person reads and types in place of templates: [first name] stands for {{contact.first_name}}.
  const TOKENS = [['{{contact.first_name}}', 'first name'], ['{{contact.name}}', 'name'], ['{{contact.phone}}', 'phone'], ['{{contact.email}}', 'email'], ['{{user.first_name}}', 'your name'], ['{{organization.name}}', 'company name']];
  const friendly = (value) => TOKENS.reduce((out, [template, word]) => out.split(template).join(`[${word}]`), String(value ?? '')).replace(/\{\{\s*answers\.([a-z0-9_]+)\s*\}\}/g, '[$1]');
  const templated = (value, keys) => {
    let out = TOKENS.reduce((text, [template, word]) => text.split(`[${word}]`).join(template), String(value ?? ''));
    for (const key of keys) out = out.split(`[${key}]`).join(`{{answers.${key}}}`);
    return out;
  };
  const INPUTS = [['text', 'Short text'], ['paragraph', 'Long text'], ['number', 'Number'], ['money', 'Money'], ['select', 'Pick one'], ['multi', 'Pick several'], ['yes_no', 'Yes / no'], ['date', 'Date'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address']];
  const SAVES = [['', 'Only on this run'], ['contact.name', 'Contact name'], ['contact.email', 'Contact email'], ['contact.phone', 'Contact phone'], ['project.address', 'Project address'], ['project.title', 'Project title'], ['project.summary', 'Project summary'], ['project.notes', 'Project notes']];

  const css = `
.fse{position:relative;display:grid;grid-template-columns:220px minmax(0,1fr) var(--fse-chat,340px);grid-template-rows:auto minmax(0,1fr);height:100%;min-height:560px;background:#f6f7f9;color:#101828;font-size:14px;overflow:hidden}
.fse[data-chat="off"]{--fse-chat:0px}
.fse-top{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:10px 14px;background:#fff;border-bottom:1px solid #eaecf0;min-width:0}
.fse-name{flex:1;min-width:120px;max-width:420px;font:inherit;font-weight:850;font-size:15px;border:1px solid transparent;border-radius:9px;padding:6px 9px;background:transparent}
.fse-name:hover,.fse-name:focus{border-color:#d0d5dd;background:#fff;outline:none}
.fse-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:10px;overflow:hidden}
.fse-seg button{border:0;background:#fff;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:800;color:#475467;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.fse-seg button[aria-pressed="true"]{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary,#d93025)}
.fse-tb{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 11px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;font:inherit;font-size:12.5px;font-weight:800;color:#344054;cursor:pointer;white-space:nowrap}
.fse-tb.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
.fse-tb[disabled]{opacity:.5;cursor:default}
.fse-state{color:#667085;font-size:12px;font-weight:700;white-space:nowrap}
.fse-state.err{color:#b42318}
.fse-spacer{flex:1}
.fse-tree{overflow:auto;padding:12px 8px 24px 12px;border-right:1px solid #eaecf0;background:#fff}
.fse-tree h4{margin:2px 4px 8px;font-size:11px;font-weight:900;color:#98a2b3;text-transform:uppercase;letter-spacing:.06em}
.fse-node{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;padding:4px 6px;border-radius:7px;font:inherit;font-size:12.5px;font-weight:700;color:#344054;cursor:pointer;text-align:left;position:relative;min-width:0}
.fse-node span.fse-node-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.fse-node:hover{background:#f2f4f7}
.fse-node[data-current="true"]{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary,#d93025)}
.fse-node[data-onpath="true"]::before{content:"";position:absolute;left:-6px;top:8px;width:4px;height:12px;border-radius:2px;background:var(--primary,#d93025);opacity:.55}
.fse-node[data-lit="true"]{background:#fef6ee;color:#b54708}
.fse-node[data-lit="target"]{background:#fdead7;color:#93370d}
.fse-node .fse-branch{color:#98a2b3;font-size:10px}
.fse-node .fse-warn{color:#dc6803;font-size:11px}
.fse-node .fse-stop{color:#7a5af8;font-size:10px}
.fse-node.fse-ref{color:#98a2b3;font-weight:650;font-style:italic}
.fse-node.fse-end{color:#98a2b3;font-weight:650}
.fse-main{position:relative;overflow:hidden;outline:none}
.fse-viewport{position:absolute;inset:0;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 120px,#000 calc(100% - 110px),transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 120px,#000 calc(100% - 110px),transparent 100%)}
.fse-track{position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column;align-items:center;gap:0;transition:transform .42s cubic-bezier(.2,.8,.2,1);padding:0 24px}
.fse-gap{height:34px;width:min(640px,100%);display:flex;align-items:center;justify-content:center;position:relative}
.fse-gap::before{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:2px dashed #d0d5dd}
.fse-gap button{position:relative;z-index:1;width:24px;height:24px;border-radius:50%;border:1px solid #d0d5dd;background:#fff;color:#475467;cursor:pointer;opacity:0;transition:opacity .15s}
.fse-gap:hover button,.fse-gap button:focus{opacity:1}
.fse[data-mode="view"] .fse-gap button{display:none}
.fse-card{width:min(640px,100%);background:#fff;border:1px solid #e4e7ec;border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.06);padding:16px 18px;display:flex;flex-direction:column;gap:10px;transition:opacity .35s,box-shadow .2s;cursor:default}
.fse-card[data-dist="1"]{opacity:.6;cursor:pointer}
.fse-card[data-dist="far"]{opacity:0;pointer-events:none}
.fse-card[data-dist="0"]{box-shadow:0 10px 30px rgba(16,24,40,.1);border-color:#d0d5dd}
.fse-card-head{display:flex;align-items:center;gap:8px}
.fse-num{font-size:11px;font-weight:900;color:#98a2b3}
.fse-title{flex:1;font-weight:900;font-size:15px;border-radius:6px;padding:1px 4px;margin:-1px -4px;outline:none;min-width:0}
.fse[data-mode="edit"] .fse-title:hover,.fse-title:focus{background:#f9fafb}
.fse-say,.fse-note{white-space:pre-wrap;line-height:1.55;border-radius:8px;padding:2px 6px;margin:0 -6px;outline:none}
.fse-say{font-size:16px;font-weight:600;color:#101828}
.fse[data-kind="call"] .fse-say{font-size:17px}
.fse-note{font-size:13px;color:#667085;font-weight:650;display:flex;gap:6px}
.fse-note i{margin-top:4px;color:#98a2b3}
.fse[data-mode="edit"] .fse-say:hover,.fse[data-mode="edit"] .fse-note:hover{background:#f9fafb}
.fse-say:focus,.fse-note:focus,.fse-say[data-selected="true"],.fse-note[data-selected="true"]{background:#f5f8ff;box-shadow:inset 0 0 0 1px #c7d7fe}
.fse-input{display:flex;flex-direction:column;gap:5px;border-radius:10px;padding:6px 8px;margin:0 -8px;cursor:pointer}
.fse[data-mode="edit"] .fse-input:hover{background:#f9fafb}
.fse-input[data-selected="true"]{background:#f5f8ff;box-shadow:inset 0 0 0 1px #c7d7fe}
.fse-input label{font-size:13px;font-weight:800;color:#344054;display:flex;gap:6px;align-items:center;cursor:inherit}
.fse-var{font-size:11px;font-weight:800;color:#3538cd;background:#eef4ff;border-radius:6px;padding:1px 6px}
.fse-input input,.fse-input textarea,.fse-input select{font:inherit;font-size:13.5px;border:1px solid #d0d5dd;border-radius:9px;padding:7px 10px;background:#fff;min-width:0}
.fse[data-mode="edit"] .fse-input input,.fse[data-mode="edit"] .fse-input textarea,.fse[data-mode="edit"] .fse-input select{pointer-events:none;background:#fcfcfd;color:#98a2b3}
.fse-pills{display:flex;flex-wrap:wrap;gap:6px}
.fse-pill{border:1px solid #e4e7ec;border-radius:999px;padding:5px 11px;font:inherit;font-size:12.5px;font-weight:750;background:#fff;color:#344054;cursor:pointer}
.fse-pill[aria-pressed="true"]{border-color:var(--primary,#d93025);color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
.fse-action{display:grid;grid-template-columns:auto 1fr;gap:3px 9px;padding:9px 11px;border:1px dashed #c7d7fe;border-radius:11px;background:#f8faff;cursor:pointer}
.fse-action[data-selected="true"]{box-shadow:inset 0 0 0 1px #6172f3}
.fse-action i{color:#3538cd;margin-top:2px}
.fse-action strong{font-size:12.5px}
.fse-action .fse-copy{grid-column:2;white-space:pre-wrap;font-size:13px;line-height:1.45;color:#344054;outline:none;border-radius:6px;padding:2px 4px;margin:0 -4px}
.fse-action .fse-copy:focus{background:#fff;box-shadow:inset 0 0 0 1px #c7d7fe}
.fse-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:750;color:#667085}
.fse-add{display:flex;gap:6px;flex-wrap:wrap}
.fse-add button{border:1px dashed #d0d5dd;background:transparent;border-radius:8px;padding:4px 9px;font:inherit;font-size:12px;font-weight:750;color:#667085;cursor:pointer}
.fse-add button:hover{border-color:#98a2b3;color:#344054}
.fse[data-mode="view"] .fse-add,.fse[data-mode="view"] .fse-plus{display:none}
.fse-buttons{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:4px;border-top:1px solid #f2f4f7;margin-top:2px}
.fse-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border:1.5px solid #d0d5dd;border-radius:10px;background:#fff;font:inherit;font-weight:800;font-size:13px;color:#344054;cursor:pointer}
.fse-btn[data-chosen="true"]{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.fse-btn[data-selected="true"]{box-shadow:0 0 0 3px rgba(97,114,243,.35)}
.fse-btn .fse-warn{color:#dc6803}
.fse-btn[data-chosen="true"] .fse-warn{color:#fff}
.fse-btn small{font-weight:700;opacity:.7}
.fse-end{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:850;color:#fff}
.fse-plus{width:34px;height:34px;border-radius:10px;border:1.5px dashed #d0d5dd;background:#fff;color:#667085;cursor:pointer}
.fse-plus:hover{border-color:#98a2b3;color:#344054}
.fse-hint{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);font-size:12px;font-weight:750;color:#667085;background:#fff;border:1px solid #eaecf0;border-radius:999px;padding:5px 12px;box-shadow:0 2px 8px rgba(16,24,40,.06);pointer-events:none;white-space:nowrap}
.fse-box{position:absolute;width:248px;background:#fff;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 10px 30px rgba(16,24,40,.14);padding:12px;display:flex;flex-direction:column;gap:9px;z-index:5;transition:top .25s,left .25s;font-size:12.5px}
.fse-box h5{margin:0;font-size:11px;font-weight:900;color:#98a2b3;text-transform:uppercase;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center}
.fse-box h5 button{border:0;background:transparent;color:#98a2b3;cursor:pointer;font-size:13px}
.fse-box label{display:flex;flex-direction:column;gap:4px;font-weight:800;color:#475467}
.fse-box input,.fse-box select,.fse-box textarea{font:inherit;font-size:12.5px;border:1px solid #d0d5dd;border-radius:8px;padding:6px 8px;font-weight:600;color:#101828;min-width:0}
.fse-box .fse-row{display:flex;gap:6px}
.fse-box .fse-row>*{flex:1;min-width:0}
.fse-box .fse-check{flex-direction:row;align-items:center;gap:6px}
.fse-box .fse-danger{border:0;background:transparent;color:#b42318;font:inherit;font-weight:800;font-size:12px;cursor:pointer;align-self:flex-start;padding:0}
.fse-box .fse-opts{display:flex;flex-direction:column;gap:5px}
.fse-box .fse-opts div{display:flex;gap:5px}
.fse-box .fse-opts input{flex:1}
.fse-box .fse-tokens{display:flex;flex-wrap:wrap;gap:4px}
.fse-box .fse-tokens button{border:1px solid #e4e7ec;background:#f9fafb;border-radius:6px;padding:2px 6px;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}
.fse-chat{border-left:1px solid #eaecf0;background:#fff;min-width:0;overflow:hidden;display:flex;flex-direction:column}
.fse[data-chat="off"] .fse-chat{display:none}
.fse-chat-body{flex:1;min-height:0;display:flex;flex-direction:column}
.fse-chat-off{padding:16px;color:#667085;font-size:12.5px;font-weight:650;line-height:1.5}
.fse-loading{display:grid;place-items:center;height:100%;color:#98a2b3}
.fse-modal{position:fixed;inset:0;z-index:2147483300;background:rgba(16,24,40,.45);display:flex;padding:12px}
.fse-modal-shell{flex:1;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(16,24,40,.3);display:flex;flex-direction:column}
.fse-modal-shell>.fse{flex:1}
@media(max-width:1100px){.fse{--fse-chat:0px}.fse .fse-chat{display:none}}
@media(max-width:760px){.fse{grid-template-columns:minmax(0,1fr)}.fse-tree{display:none}.fse-box{position:fixed;left:8px!important;right:8px;bottom:8px;top:auto!important;width:auto}}
`;
  function ensureStyles(){
    if (document.getElementById('fm-flow-script-editor-css')) return;
    const style = document.createElement('style'); style.id = 'fm-flow-script-editor-css'; style.textContent = css; document.head.appendChild(style);
  }

  // ── The flow as a graph ────────────────────────────────────────────────
  const stepOf = (def, id) => array(def.steps).find((step) => step.id === id) || null;
  const choiceOf = (step) => array(step?.blocks).find((block) => block.kind === 'choice') || null;
  const outcomeBlock = (step) => array(step?.blocks).find((block) => block.kind === 'outcome') || null;
  /** Where a step can go, in order: its buttons, else its next (or each branch). */
  function edges(step){
    const choice = choiceOf(step);
    if (choice) return array(choice.options).map((option) => ({ option, to: clean(option.to), outcome: clean(option.outcome) }));
    const next = step?.next;
    if (typeof next === 'string' && next) return [{ to: next }];
    if (next && typeof next === 'object') return [...array(next.branches).map((branch) => ({ to: clean(branch.to), branch })), ...(next.otherwise ? [{ to: clean(next.otherwise) }] : [])];
    return [];
  }
  const unlabeled = (step) => array(choiceOf(step)?.options).some((option) => !clean(option.label));
  /** Every step that can come before `id` (all branches into it, merged ones included). */
  function ancestors(def, id){
    const into = new Map();
    for (const step of array(def.steps)) for (const edge of edges(step)) if (edge.to) { if (!into.has(edge.to)) into.set(edge.to, new Set()); into.get(edge.to).add(step.id); }
    const seen = new Set(), queue = [id];
    while (queue.length) for (const from of into.get(queue.shift()) || []) if (!seen.has(from)) { seen.add(from); queue.push(from); }
    return seen;
  }
  /** One way from the start to `id`, as steps and the button taken at each (breadth first: the shortest). */
  function routeTo(def, id){
    const parent = new Map([[def.start, null]]), queue = [def.start];
    while (queue.length) {
      const at = queue.shift();
      if (at === id) break;
      for (const edge of edges(stepOf(def, at))) if (edge.to && !parent.has(edge.to) && stepOf(def, edge.to)) { parent.set(edge.to, { from: at, option: edge.option }); queue.push(edge.to); }
    }
    if (!parent.has(id)) return null;
    const route = [];
    for (let at = id; at; at = parent.get(at)?.from) route.unshift({ id: at, via: parent.get(at) });
    return route;
  }

  function mount(el, options = {}){
    ensureStyles();
    let def = options.definition ? clone(options.definition) : null;
    let flowId = clean(options.flowId), version = 0, dirty = false, saving = false, error = '', alive = true;
    let mode = options.readOnly ? 'view' : 'edit';
    const choices = new Map();           // step id -> the button last chosen there (kept when going back)
    let index = 0, selected = null, lit = null, answers = {}, assistant = null, wheelLock = 0, wasPending = false;
    const org = orgOf(options);
    const api = (path, init) => root.FirstMateFlows?.api ? root.FirstMateFlows.api(path, init) : Promise.reject(new Error(L('unavailable', 'Flows are not available here.')));

    el.innerHTML = '<div class="fse-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i></div>';

    /** The path: from the start, following one-way steps and the buttons already chosen, until a choice not yet made. */
    function path(){
      const out = [], seen = new Set();
      let at = def.start;
      while (at && stepOf(def, at) && !seen.has(at)) {
        out.push(at); seen.add(at);
        const step = stepOf(def, at), choice = choiceOf(step);
        if (choice) { const picked = array(choice.options).find((option) => option.id === choices.get(at)); at = picked && picked.to ? picked.to : null; }
        else { const list = edges(step); at = list.length === 1 ? list[0].to : null; }
      }
      return out;
    }
    const keys = () => array(def.steps).flatMap((step) => array(step.blocks)).filter((block) => block.kind === 'ask' || block.kind === 'choice').map((block) => block.key);
    const change = () => { dirty = true; error = ''; options.onChange?.(clone(def)); drawTop(); };

    // ── Drawing ──────────────────────────────────────────────────────────
    function frame(){
      const chat = !options.embedded && !!flowId && !!root.PlatformAssistant?.mountSurface;
      el.innerHTML = `<div class="fse" data-mode="${mode}" data-kind="${esc(def.kind || 'workflow')}" data-chat="${chat ? 'on' : 'off'}">
        <div class="fse-top" data-top></div>
        <nav class="fse-tree" data-tree aria-label="${esc(L('steps', 'Steps'))}"></nav>
        <div class="fse-main" data-main tabindex="0"><div class="fse-viewport"><div class="fse-track" data-track></div></div><div class="fse-hint" data-hint hidden></div></div>
        <aside class="fse-chat"><div class="fse-chat-body" data-chat-host></div></aside>
      </div>`;
      bind();
      if (chat) mountChat();
      draw();
    }
    const $ = (selector) => el.querySelector(selector);
    /** The top bar. While someone types (the name, a line) only its state and Save change; `full` draws it all. */
    function drawTop(full = false){
      const top = $('[data-top]'); if (!top) return;
      const state = saving ? L('saving', 'Saving…') : error ? error : dirty ? L('unsaved', 'Unsaved changes') : version ? `${L('saved', 'Saved')} · v${version}` : '';
      if (!full && top.firstElementChild) {
        const node = top.querySelector('.fse-state'); if (node) { node.textContent = state; node.classList.toggle('err', !!error); }
        const button = top.querySelector('[data-save]'); if (button) button.disabled = !dirty || saving;
        return;
      }
      top.innerHTML = `<input class="fse-name" data-name value="${esc(def.name)}" aria-label="${esc(L('name', 'Name'))}" ${mode === 'view' ? 'readonly' : ''}>
        <div class="fse-seg" role="group" aria-label="${esc(L('kind', 'Kind'))}"><button type="button" data-kind="call" aria-pressed="${def.kind === 'call'}"><i class="fas fa-phone"></i>${esc(L('call', 'Call script'))}</button><button type="button" data-kind="workflow" aria-pressed="${def.kind !== 'call'}"><i class="fas fa-list-check"></i>${esc(L('workflow', 'Workflow'))}</button></div>
        <div class="fse-seg" role="group" aria-label="${esc(L('mode', 'Mode'))}"><button type="button" data-mode="edit" aria-pressed="${mode === 'edit'}" ${options.readOnly ? 'disabled' : ''}><i class="fas fa-pen"></i>${esc(L('edit', 'Edit'))}</button><button type="button" data-mode="view" aria-pressed="${mode === 'view'}"><i class="fas fa-eye"></i>${esc(L('view', 'View'))}</button></div>
        <span class="fse-spacer"></span>
        <span class="fse-state ${error ? 'err' : ''}" role="status">${esc(state)}</span>
        ${options.onSwitchToMap ? `<button type="button" class="fse-tb" data-map title="${esc(L('map_tip', 'The flowchart editor'))}"><i class="fas fa-diagram-project"></i>${esc(L('map', 'Map view'))}</button>` : ''}
        ${!options.embedded && flowId ? `<button type="button" class="fse-tb" data-chat-toggle title="${esc(L('chat_tip', 'Edit by asking the assistant'))}"><i class="fas fa-wand-magic-sparkles"></i></button>` : ''}
        ${!options.embedded ? `<button type="button" class="fse-tb primary" data-save ${!dirty || saving ? 'disabled' : ''}><i class="fas fa-floppy-disk"></i>${esc(L('save', 'Save'))}</button>` : ''}
        ${options.onClose ? `<button type="button" class="fse-tb" data-close aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button>` : ''}`;
    }

    function drawTree(){
      const tree = $('[data-tree]'); if (!tree) return;
      const p = path(), current = p[index], shown = new Set(), rows = [];
      const ups = lit ? ancestors(def, lit) : null;
      const walk = (id, depth) => {
        const step = stepOf(def, id);
        if (!step) return;
        if (shown.has(id)) { rows.push(`<button type="button" class="fse-node fse-ref" data-go="${esc(id)}" style="padding-left:${6 + depth * 12}px"><i class="fas fa-arrow-turn-up fa-rotate-90" aria-hidden="true"></i><span class="fse-node-name">${esc(step.title || id)}</span></button>`); return; }
        shown.add(id);
        const list = edges(step), choice = choiceOf(step);
        const stop = choice && p.includes(id) && !choices.get(id);
        rows.push(`<button type="button" class="fse-node" data-go="${esc(id)}" data-current="${id === current}" data-onpath="${p.includes(id)}" data-lit="${lit === id ? 'target' : ups?.has(id) ? 'true' : 'false'}" style="padding-left:${6 + depth * 12}px" title="${esc(step.title || id)}">
          ${choice ? '<i class="fas fa-code-branch fse-branch" aria-hidden="true"></i>' : ''}<span class="fse-node-name">${esc(step.title || L('untitled', 'Untitled step'))}</span>${unlabeled(step) ? `<i class="fas fa-triangle-exclamation fse-warn" title="${esc(L('unlabeled', 'A button has no label'))}"></i>` : ''}${stop ? `<i class="fas fa-circle-question fse-stop" title="${esc(L('stop', 'Choose a button to go on'))}"></i>` : ''}</button>`);
        const branching = list.length > 1;
        for (const edge of list) {
          if (edge.to) walk(edge.to, depth + (branching ? 1 : 0));
          else if (edge.outcome) { const out = array(def.outcomes).find((entry) => entry.id === edge.outcome); rows.push(`<div class="fse-node fse-end" style="padding-left:${6 + (depth + 1) * 12}px"><i class="fas fa-flag-checkered" aria-hidden="true"></i><span class="fse-node-name">${esc(out?.label || edge.outcome)}</span></div>`); }
        }
      };
      walk(def.start, 0);
      const orphans = array(def.steps).filter((step) => !shown.has(step.id));
      tree.innerHTML = `<h4>${esc(L('steps', 'Steps'))}</h4>${rows.join('')}${orphans.length ? `<h4 style="margin-top:14px">${esc(L('unreached', 'Not reached'))}</h4>${orphans.map((step) => `<button type="button" class="fse-node" data-go="${esc(step.id)}">${esc(step.title || step.id)}</button>`).join('')}` : ''}`;
    }

    function blockHtml(step, block){
      const sel = (part) => selected && selected.step === step.id && selected.block === block.id && (!part || selected.part === part) ? 'true' : 'false';
      const edit = mode === 'edit';
      switch (block.kind) {
        case 'say': return `<div class="fse-say" data-block="${esc(block.id)}" data-text ${edit ? 'contenteditable="plaintext-only" spellcheck="true"' : ''} data-selected="${sel()}">${esc(friendly(block.text))}</div>`;
        case 'note': return `<div class="fse-note" data-block="${esc(block.id)}" data-selected="${sel()}"><i class="fas fa-circle-info" aria-hidden="true"></i><span data-text ${edit ? 'contenteditable="plaintext-only"' : ''}>${esc(friendly(block.text))}</span></div>`;
        case 'ask': return `<div class="fse-input" data-block="${esc(block.id)}" data-selected="${sel()}"><label>${esc(block.label || L('no_label', 'Untitled input'))}${block.required ? ' <span style="color:#b42318">*</span>' : ''}${edit ? ` <span class="fse-var">${esc(block.key)}</span>` : ''}</label>${inputHtml(block)}</div>`;
        case 'action': {
          const copy = object(block.input).text;
          return `<div class="fse-action" data-block="${esc(block.id)}" data-selected="${sel()}"><i class="fas ${block.automation === 'communications.sendSms.v1' ? 'fa-comment-sms' : block.automation === 'communications.sendEmail.v1' ? 'fa-envelope' : 'fa-bolt'}" aria-hidden="true"></i><strong>${esc(block.label || block.automation)}</strong>${copy !== undefined ? `<div class="fse-copy" data-copy ${edit ? 'contenteditable="plaintext-only"' : ''}>${esc(friendly(copy))}</div>` : block.preview ? `<div class="fse-copy">${esc(block.preview)}</div>` : ''}</div>`;
        }
        case 'contact': return `<span class="fse-chip" data-block="${esc(block.id)}"><i class="fas fa-address-book"></i>${esc(L('finds_contact', 'Finds or makes the contact'))}</span>`;
        case 'project': return `<span class="fse-chip" data-block="${esc(block.id)}"><i class="fas fa-folder-plus"></i>${esc(block.mode === 'create_project' ? L('makes_project', 'Makes the project') : L('makes_lead', 'Makes the lead'))}</span>`;
        default: return '';
      }
    }
    function inputHtml(block){
      const value = answers[block.key];
      if (['select', 'multi', 'yes_no'].includes(block.input)) {
        const opts = block.input === 'yes_no' ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] : array(block.options);
        return `<div class="fse-pills">${opts.map((option) => `<button type="button" class="fse-pill" data-answer="${esc(block.key)}" data-value="${esc(option.id)}" aria-pressed="${Array.isArray(value) ? value.includes(option.id) : value === option.id}">${esc(option.label || '…')}</button>`).join('') || `<span class="fse-chip">${esc(L('no_options', 'No options yet'))}</span>`}</div>`;
      }
      if (block.input === 'paragraph' || block.input === 'address') return `<textarea rows="2" data-answer="${esc(block.key)}" placeholder="${esc(block.placeholder || '')}">${esc(value ?? '')}</textarea>`;
      const type = { number: 'number', money: 'number', date: 'date', phone: 'tel', email: 'email' }[block.input] || 'text';
      return `<input type="${type}" data-answer="${esc(block.key)}" value="${esc(value ?? '')}" placeholder="${esc(block.placeholder || '')}" ${block.min !== undefined ? `min="${block.min}"` : ''} ${block.max !== undefined ? `max="${block.max}"` : ''}>`;
    }
    function buttonsHtml(step){
      const choice = choiceOf(step), edit = mode === 'edit';
      const plus = edit ? `<button type="button" class="fse-plus" data-add-option="${esc(step.id)}" title="${esc(L('add_option', 'Add a button: a new step beside the next one'))}"><i class="fas fa-plus"></i></button>` : '';
      if (choice) {
        return `<div class="fse-buttons">${array(choice.options).map((option) => {
          const out = option.outcome ? array(def.outcomes).find((entry) => entry.id === option.outcome) : null;
          const isSel = selected && selected.step === step.id && selected.option === option.id;
          return `<button type="button" class="fse-btn" data-option="${esc(option.id)}" data-step="${esc(step.id)}" data-chosen="${choices.get(step.id) === option.id}" data-selected="${!!isSel}">${clean(option.label) ? esc(option.label) : `<i class="fas fa-triangle-exclamation fse-warn" aria-hidden="true"></i><small>${esc(L('unlabeled_short', 'No label'))}</small>`}${out ? ` <small>→ ${esc(out.label)}</small>` : ''}</button>`;
        }).join('')}${plus}</div>`;
      }
      const list = edges(step), out = outcomeBlock(step);
      const end = out ? array(def.outcomes).find((entry) => entry.id === out.outcome) : null;
      const finish = array(step.blocks).find((block) => block.kind === 'buttons');
      if (finish) return `<div class="fse-buttons">${array(finish.buttons).map((button) => `<span class="fse-btn" style="cursor:default">${esc(button.label || button.kind)}</span>`).join('')}</div>`;
      if (list.length) return `<div class="fse-buttons"><button type="button" class="fse-btn" data-next-step="${esc(step.id)}">${esc(L('next', 'Next'))} <i class="fas fa-arrow-down" aria-hidden="true"></i></button>${plus}</div>`;
      return `<div class="fse-buttons">${end ? `<span class="fse-end" style="background:${esc(end.color || '#667085')}"><i class="fas fa-flag-checkered"></i>${esc(end.label)}</span>` : `<span class="fse-chip"><i class="fas fa-flag-checkered"></i>${esc(L('ends', 'The flow ends here'))}</span>`}${plus}</div>`;
    }
    function cardHtml(id, dist){
      const step = stepOf(def, id), edit = mode === 'edit';
      const number = array(def.steps).indexOf(step) + 1;
      return `<section class="fse-card" data-card="${esc(id)}" data-dist="${dist === 0 ? '0' : Math.abs(dist) === 1 ? '1' : 'far'}">
        <div class="fse-card-head"><span class="fse-num">${number}</span><div class="fse-title" data-title ${edit ? 'contenteditable="plaintext-only"' : ''}>${esc(step.title)}</div></div>
        ${array(step.blocks).filter((block) => !['choice', 'outcome', 'buttons'].includes(block.kind)).map((block) => blockHtml(step, block)).join('')}
        ${edit ? `<div class="fse-add"><button type="button" data-add="say">${esc(L('add_say', '+ Line'))}</button><button type="button" data-add="note">${esc(L('add_note', '+ Note'))}</button><button type="button" data-add="ask">${esc(L('add_input', '+ Input'))}</button><button type="button" data-add="text">${esc(L('add_text', '+ Send a text'))}</button></div>` : ''}
        ${buttonsHtml(step)}
      </section>`;
    }

    function draw(){
      if (!alive || !def) return;
      const p = path();
      index = Math.max(0, Math.min(index, p.length - 1));
      const track = $('[data-track]');
      el.querySelector('.fse').dataset.mode = mode;
      el.querySelector('.fse').dataset.kind = def.kind || 'workflow';
      track.innerHTML = p.map((id, i) => `${i ? `<div class="fse-gap"><button type="button" data-insert="${esc(p[i - 1])}" title="${esc(L('insert', 'Add a step here'))}"><i class="fas fa-plus"></i></button></div>` : ''}${cardHtml(id, i - index)}`).join('');
      drawTop(true); drawTree(); place(); hint(); drawBox();
    }
    /** Moves the track so the current step sits a little below the top: the step before peeks above it. */
    function place(){
      const track = $('[data-track]'), card = track?.querySelector(`[data-card="${CSS.escape(path()[index] || '')}"]`);
      if (!card) return;
      track.style.transform = `translateY(${Math.round(130 - card.offsetTop)}px)`;
    }
    function hint(){
      const node = $('[data-hint]'), p = path(), step = stepOf(def, p[index]);
      if (!node || !step) return;
      const choice = choiceOf(step);
      node.hidden = !(index === p.length - 1 && choice && !choices.get(step.id));
      node.textContent = L('hint_choose', 'Choose a button to see where it goes');
    }
    function go(to){
      const p = path();
      if (to < 0 || to >= p.length || to === index) return;
      index = to;
      el.querySelectorAll('[data-card]').forEach((card, i) => { const d = i - index; card.dataset.dist = d === 0 ? '0' : Math.abs(d) === 1 ? '1' : 'far'; });
      place(); drawTree(); hint();
      selected = null; drawBox();
    }
    /** Jump to any step: the shortest way there, its buttons chosen along it. */
    function jump(id){
      const route = routeTo(def, id);
      if (!route) { toast(L('unreachable', 'Nothing leads to that step yet.'), 'error'); return; }
      for (const { via } of route) if (via?.option) choices.set(via.from, via.option.id);
      draw();
      go(path().indexOf(id));
    }

    // ── The floating box ────────────────────────────────────────────────
    function drawBox(){
      el.querySelector('.fse-box')?.remove();
      if (!selected || mode !== 'edit') return;
      const step = stepOf(def, selected.step); if (!step) return;
      const block = array(step.blocks).find((entry) => entry.id === selected.block);
      const option = selected.option ? array(choiceOf(step)?.options).find((entry) => entry.id === selected.option) : null;
      const box = document.createElement('div');
      box.className = 'fse-box';
      const del = (label) => `<button type="button" class="fse-danger" data-box="delete">${esc(label)}</button>`;
      const head = (title) => `<h5>${esc(title)}<button type="button" data-box="close" aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button></h5>`;
      const stepsOptions = (value) => `${array(def.steps).filter((entry) => entry.id !== step.id).map((entry) => `<option value="step:${esc(entry.id)}" ${value === `step:${entry.id}` ? 'selected' : ''}>${esc(entry.title || entry.id)}</option>`).join('')}<option value="new" ${value === 'new' ? 'selected' : ''}>${esc(L('new_step', '+ A new step'))}</option>${array(def.outcomes).map((out) => `<option value="out:${esc(out.id)}" ${value === `out:${out.id}` ? 'selected' : ''}>${esc(L('ends_with', 'Ends:'))} ${esc(out.label)}</option>`).join('')}<option value="end" ${value === 'end' ? 'selected' : ''}>${esc(L('just_ends', 'Ends here'))}</option>`;
      if (option) {
        const value = option.outcome ? `out:${option.outcome}` : option.to ? `step:${option.to}` : 'end';
        box.innerHTML = `${head(L('button', 'Button'))}<label>${esc(L('label', 'Label'))}<input data-f="label" value="${esc(option.label)}" placeholder="${esc(L('label_ph', 'What the person clicks'))}"></label>
          <label>${esc(L('goes_to', 'Goes to'))}<select data-f="goes">${stepsOptions(value)}</select></label>${del(L('delete_button', 'Remove this button'))}`;
      } else if (block?.kind === 'ask') {
        const range = block.input === 'number' || block.input === 'money', listy = block.input === 'select' || block.input === 'multi';
        box.innerHTML = `${head(L('input', 'Input'))}<label>${esc(L('label', 'Label'))}<input data-f="label" value="${esc(block.label)}" placeholder="${esc(L('question_ph', 'The question'))}"></label>
          <div class="fse-row"><label>${esc(L('variable', 'Variable'))}<input data-f="key" value="${esc(block.key)}"></label><label>${esc(L('type', 'Type'))}<select data-f="input">${INPUTS.map(([id, name]) => `<option value="${id}" ${block.input === id ? 'selected' : ''}>${esc(L(`in_${id}`, name))}</option>`).join('')}</select></label></div>
          ${range ? `<div class="fse-row"><label>${esc(L('min', 'From'))}<input type="number" data-f="min" value="${block.min ?? ''}"></label><label>${esc(L('max', 'To'))}<input type="number" data-f="max" value="${block.max ?? ''}"></label></div>` : ''}
          ${listy ? `<div class="fse-opts">${array(block.options).map((entry, i) => `<div><input data-opt="${i}" value="${esc(entry.label)}"><button type="button" class="fse-tb" data-opt-del="${i}" aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>`).join('')}<button type="button" class="fse-tb" data-opt-add>${esc(L('add_choice', '+ Choice'))}</button></div>` : ''}
          <label>${esc(L('saves_to', 'Also save to'))}<select data-f="saves_to">${SAVES.map(([id, name]) => `<option value="${id}" ${clean(block.saves_to) === id ? 'selected' : ''}>${esc(L(`sv_${id || 'run'}`, name))}</option>`).join('')}</select></label>
          <label class="fse-check"><input type="checkbox" data-f="required" ${block.required ? 'checked' : ''}>${esc(L('required', 'Required'))}</label>${del(L('delete_input', 'Remove this input'))}`;
      } else if (block?.kind === 'say' || block?.kind === 'note') {
        box.innerHTML = `${head(block.kind === 'say' ? L('line', 'A line to say') : L('note', 'A note for you'))}
          <div class="fse-seg"><button type="button" data-f="kind" data-v="say" aria-pressed="${block.kind === 'say'}">${esc(L('said', 'Said'))}</button><button type="button" data-f="kind" data-v="note" aria-pressed="${block.kind === 'note'}">${esc(L('not_said', 'Not said'))}</button></div>
          <label>${esc(L('insert_word', 'Insert'))}<span class="fse-tokens">${[...TOKENS.map(([, word]) => word), ...keys()].map((word) => `<button type="button" data-token="${esc(word)}">[${esc(word)}]</button>`).join('')}</span></label>${del(L('delete_line', 'Remove this line'))}`;
      } else if (block?.kind === 'action') {
        box.innerHTML = `${head(L('action', 'Happens when they continue'))}<label>${esc(L('label', 'Label'))}<input data-f="label" value="${esc(block.label)}"></label><span class="fse-chip">${esc(block.automation)}</span>${del(L('delete_action', 'Remove this'))}`;
      } else if (selected.part === 'title') {
        const list = edges(step), value = choiceOf(step) ? 'choice' : list[0]?.to ? `step:${list[0].to}` : outcomeBlock(step) ? `out:${outcomeBlock(step).outcome}` : 'end';
        box.innerHTML = `${head(L('step', 'Step'))}${choiceOf(step) ? `<span class="fse-chip">${esc(L('by_buttons', 'Its buttons decide what comes next.'))}</span>` : `<label>${esc(L('after', 'After this step'))}<select data-f="after">${stepsOptions(value)}</select></label>`}${def.start === step.id ? '' : del(L('delete_step', 'Remove this step'))}`;
      } else return;
      const main = $('[data-main]'), card = el.querySelector(`[data-card="${CSS.escape(step.id)}"]`);
      const target = option ? card?.querySelector(`[data-option="${CSS.escape(option.id)}"]`) : selected.part === 'title' ? card?.querySelector('[data-title]') : card?.querySelector(`[data-block="${CSS.escape(selected.block)}"]`);
      main.appendChild(box);
      if (target && card) {
        const mainRect = main.getBoundingClientRect(), cardRect = card.getBoundingClientRect(), rect = target.getBoundingClientRect();
        const left = Math.min(cardRect.right - mainRect.left + 14, mainRect.width - box.offsetWidth - 8);
        const top = Math.max(8, Math.min(rect.top + rect.height / 2 - mainRect.top - box.offsetHeight / 2, mainRect.height - box.offsetHeight - 8));
        box.style.left = `${Math.max(8, left)}px`; box.style.top = `${top}px`;
      }
      box.addEventListener('input', onBoxInput);
      box.addEventListener('change', onBoxChange);
      box.addEventListener('click', onBoxClick);
    }
    const current = () => { const step = stepOf(def, selected?.step); return { step, block: array(step?.blocks).find((entry) => entry.id === selected?.block), option: selected?.option ? array(choiceOf(step)?.options).find((entry) => entry.id === selected.option) : null }; };
    function onBoxInput(event){
      const { step, block, option } = current(), f = event.target.dataset.f;
      if (option && f === 'label') { option.label = event.target.value; refreshCard(step.id); }
      else if (block && f === 'label') { block.label = event.target.value; refreshCard(step.id); }
      else if (block && f === 'key') { const next = slug(event.target.value); if (next && !keys().filter((key) => key !== block.key).includes(next)) block.key = next; }
      else if (block && (f === 'min' || f === 'max')) { const n = event.target.value === '' ? undefined : Number(event.target.value); if (n === undefined) delete block[f]; else if (Number.isFinite(n)) block[f] = n; }
      else if (block && event.target.dataset.opt !== undefined) { const entry = block.options[Number(event.target.dataset.opt)]; entry.label = event.target.value; if (!entry.id || entry.id.startsWith('opt_')) entry.id = slug(event.target.value) || entry.id; refreshCard(step.id); }
      else return;
      change(); drawTree();
    }
    function onBoxChange(event){
      const { step, block, option } = current(), f = event.target.dataset.f;
      if (option && f === 'goes') { linkOption(step, option, event.target.value); }
      else if (block && f === 'input') { block.input = event.target.value; if (!['select', 'multi'].includes(block.input)) block.options = []; if (!['number', 'money'].includes(block.input)) { delete block.min; delete block.max; } }
      else if (block && f === 'saves_to') { if (event.target.value) block.saves_to = event.target.value; else delete block.saves_to; }
      else if (block && f === 'required') block.required = event.target.checked;
      else if (f === 'after') { const value = event.target.value; const out = outcomeBlock(step); if (out) step.blocks = step.blocks.filter((entry) => entry !== out);
        if (value === 'new') { const fresh = newStep(); step.next = fresh.id; } else if (value.startsWith('step:')) step.next = value.slice(5); else { step.next = null; if (value.startsWith('out:')) step.blocks.push({ id: uid('end'), kind: 'outcome', label: '', outcome: value.slice(4) }); } }
      else return;
      change(); draw();
    }
    function onBoxClick(event){
      const { step, block, option } = current(), button = event.target.closest('button'); if (!button) return;
      if (button.dataset.box === 'close') { selected = null; drawBox(); draw(); return; }
      if (button.dataset.box === 'delete') {
        if (option) { const choice = choiceOf(step); choice.options = choice.options.filter((entry) => entry !== option); if (!choice.options.length) step.blocks = step.blocks.filter((entry) => entry !== choice); choices.delete(step.id); }
        else if (block) step.blocks = step.blocks.filter((entry) => entry !== block);
        else if (selected.part === 'title') removeStep(step);
        selected = null; change(); draw(); return;
      }
      if (button.dataset.f === 'kind' && block) { block.kind = button.dataset.v; change(); draw(); return; }
      if (button.dataset.token && block) { block.text = `${block.text}${block.text && !/\s$/.test(block.text) ? ' ' : ''}${templated(`[${button.dataset.token}]`, keys())}`; change(); refreshCard(step.id); return; }
      if (button.dataset.optAdd !== undefined && block) { block.options = [...array(block.options), { id: uid('opt'), label: '' }]; change(); drawBox(); refreshCard(step.id); return; }
      if (button.dataset.optDel !== undefined && block) { block.options.splice(Number(button.dataset.optDel), 1); change(); drawBox(); refreshCard(step.id); }
    }
    function refreshCard(id){
      const card = el.querySelector(`[data-card="${CSS.escape(id)}"]`); if (!card) return;
      const dist = card.dataset.dist;
      const holder = document.createElement('div'); holder.innerHTML = cardHtml(id, 0); const fresh = holder.firstElementChild; fresh.dataset.dist = dist;
      card.replaceWith(fresh);
    }

    // ── Changing the shape ──────────────────────────────────────────────
    function newStep(title = ''){
      const step = { id: uid('step'), title: title || L('new_step_title', 'New step'), blocks: [{ id: uid('say'), kind: 'say', label: '', text: '' }], next: null };
      def.steps.push(step);
      return step;
    }
    function linkOption(step, option, value){
      delete option.to; delete option.outcome;
      if (value === 'new') option.to = newStep(option.label).id;
      else if (value.startsWith('step:')) option.to = value.slice(5);
      else if (value.startsWith('out:')) option.outcome = value.slice(4);
    }
    /** + beside a step's buttons: a new parallel step, with a button for it. A step that went one way gets buttons. */
    function addOption(step){
      let choice = choiceOf(step);
      if (!choice) {
        const list = edges(step), out = outcomeBlock(step);
        choice = { id: uid('choice'), kind: 'choice', key: uniqueKey(slug(step.title) || 'choice'), label: '', required: true, options: [] };
        if (list[0]?.to) choice.options.push({ id: uid('opt'), label: '', to: list[0].to });
        else if (out) { choice.options.push({ id: uid('opt'), label: '', outcome: out.outcome }); step.blocks = step.blocks.filter((entry) => entry !== out); }
        step.next = null;
        step.blocks.push(choice);
      }
      const fresh = newStep();
      const option = { id: uid('opt'), label: '', to: fresh.id };
      choice.options.push(option);
      choices.set(step.id, option.id);
      selected = { step: step.id, option: option.id };
      change(); draw();
      requestAnimationFrame(() => { go(path().indexOf(step.id)); selected = { step: step.id, option: option.id }; drawBox(); $('.fse-box input')?.focus(); });
    }
    /** + between two steps: a new step in between; whatever led to the second now leads to it. */
    function insertAfter(id){
      const step = stepOf(def, id), p = path(), nextId = p[p.indexOf(id) + 1];
      const fresh = newStep();
      fresh.next = nextId || null;
      const choice = choiceOf(step);
      if (choice) { const picked = choice.options.find((entry) => entry.id === choices.get(id)); if (picked) picked.to = fresh.id; }
      else if (typeof step.next === 'string' || !step.next) step.next = fresh.id;
      else { const branch = array(step.next.branches).find((entry) => entry.to === nextId); if (branch) branch.to = fresh.id; else step.next.otherwise = fresh.id; }
      change(); draw(); go(path().indexOf(fresh.id));
      requestAnimationFrame(() => { selected = { step: fresh.id, part: 'title' }; drawBox(); el.querySelector(`[data-card="${CSS.escape(fresh.id)}"] [data-title]`)?.focus(); });
    }
    function removeStep(step){
      const after = edges(step).length === 1 ? edges(step)[0].to : null;
      for (const other of def.steps) {
        if (other === step) continue;
        if (other.next === step.id) other.next = after;
        if (other.next && typeof other.next === 'object') { other.next.branches = array(other.next.branches).filter((branch) => branch.to !== step.id); if (other.next.otherwise === step.id) other.next.otherwise = after; }
        for (const option of array(choiceOf(other)?.options)) if (option.to === step.id) { if (after) option.to = after; else delete option.to; }
      }
      def.steps = def.steps.filter((entry) => entry !== step);
      choices.delete(step.id);
    }
    function uniqueKey(base){ let key = slug(base) || 'field', n = 1; const taken = new Set(keys()); while (taken.has(key)) key = `${slug(base) || 'field'}_${++n}`; return key; }
    function addBlock(step, kind){
      let block;
      if (kind === 'say' || kind === 'note') block = { id: uid(kind), kind, label: '', text: '' };
      else if (kind === 'ask') block = { id: uid('ask'), kind: 'ask', key: uniqueKey('field'), label: '', input: 'text', options: [], required: false, placeholder: '' };
      else if (kind === 'text') { const words = 'Hi [first name], this is [your name] with [company name].'; block = { id: uid('text'), kind: 'action', label: L('text_them', 'Text them'), automation: 'communications.sendSms.v1', input: { to: '{{project.contacts.0.phone}}', text: templated(words, []) }, preview: templated(words, []), explainer: '' }; }
      // New things go above the buttons, after what is already there.
      const at = step.blocks.findIndex((entry) => ['choice', 'outcome', 'buttons'].includes(entry.kind));
      if (at < 0) step.blocks.push(block); else step.blocks.splice(at, 0, block);
      selected = { step: step.id, block: block.id };
      change(); draw();
      requestAnimationFrame(() => { const node = el.querySelector(`[data-card="${CSS.escape(step.id)}"] [data-block="${CSS.escape(block.id)}"]`); (node?.matches('[data-text]') ? node : node?.querySelector('[data-text],[data-copy]'))?.focus(); if (kind === 'ask') $('.fse-box input')?.focus(); });
    }

    // ── Events ──────────────────────────────────────────────────────────
    function bind(){
      const root_ = el.querySelector('.fse');
      root_.addEventListener('click', onClick);
      root_.addEventListener('input', onInput);
      root_.addEventListener('focusin', onFocus);
      root_.addEventListener('mouseover', (event) => { const node = event.target.closest('.fse-node[data-go]'); const next = node ? node.dataset.go : null; if (next !== lit) { lit = next; drawTree(); } });
      root_.addEventListener('mouseleave', () => { if (lit) { lit = null; drawTree(); } });
      $('[data-main]').addEventListener('wheel', onWheel, { passive: false });
      root_.addEventListener('keydown', onKey);
    }
    const editing = (node) => !!node?.closest?.('[contenteditable], input, textarea, select');
    function onFocus(event){
      const card = event.target.closest('[data-card]'); if (!card || mode !== 'edit') return;
      const blockNode = event.target.closest('[data-block]');
      const id = card.dataset.card;
      if (event.target.matches('[data-title]')) selected = { step: id, part: 'title' };
      else if (blockNode) selected = { step: id, block: blockNode.dataset.block };
      else return;
      const p = path(); if (p.indexOf(id) !== index) go(p.indexOf(id));
      drawBox();
    }
    function onInput(event){
      if (event.target.matches('[data-name]')) { def.name = event.target.value; change(); return; }
      const card = event.target.closest('[data-card]'); if (!card) return;
      const step = stepOf(def, card.dataset.card);
      if (event.target.matches('[data-title]')) { step.title = event.target.textContent.replace(/\s+/g, ' ').trim(); change(); drawTree(); return; }
      const blockNode = event.target.closest('[data-block]'), block = array(step.blocks).find((entry) => entry.id === blockNode?.dataset.block);
      if (block && event.target.matches('[data-text]')) { block.text = templated(event.target.innerText.replace(/\n$/, ''), keys()); change(); return; }
      if (block && event.target.matches('[data-copy]')) { const text = templated(event.target.innerText.replace(/\n$/, ''), keys()); block.input = { ...object(block.input), text }; block.preview = text; change(); return; }
      if (event.target.dataset.answer) answers[event.target.dataset.answer] = event.target.value;
    }
    function onClick(event){
      const t = event.target;
      const top = t.closest('[data-top] button, [data-top] input'); if (top) return onTop(top);
      const node = t.closest('[data-go]'); if (node) return jump(node.dataset.go);
      const card = t.closest('[data-card]');
      if (card && card.dataset.dist !== '0') { go(path().indexOf(card.dataset.card)); return; }
      const insert = t.closest('[data-insert]'); if (insert) return insertAfter(insert.dataset.insert);
      if (!card) { if (selected && !t.closest('.fse-box')) { selected = null; drawBox(); } return; }
      const step = stepOf(def, card.dataset.card);
      const option = t.closest('[data-option]');
      if (option) {
        choices.set(step.id, option.dataset.option);
        if (mode === 'edit') selected = { step: step.id, option: option.dataset.option };
        draw();
        if (mode === 'view') { const p = path(); if (p.indexOf(step.id) < p.length - 1) go(p.indexOf(step.id) + 1); }
        return;
      }
      if (t.closest('[data-next-step]')) { const p = path(); go(Math.min(p.length - 1, p.indexOf(step.id) + 1)); return; }
      const addOpt = t.closest('[data-add-option]'); if (addOpt) return addOption(step);
      const add = t.closest('[data-add]'); if (add) return addBlock(step, add.dataset.add);
      const pill = t.closest('[data-answer][data-value]');
      if (pill && mode === 'view') { const block = array(step.blocks).find((entry) => entry.key === pill.dataset.answer); if (block?.input === 'multi') { const list = new Set(array(answers[block.key])); list.has(pill.dataset.value) ? list.delete(pill.dataset.value) : list.add(pill.dataset.value); answers[block.key] = [...list]; } else answers[pill.dataset.answer] = pill.dataset.value; refreshCard(step.id); return; }
      const blockNode = t.closest('[data-block]');
      if (blockNode && mode === 'edit' && !editing(t)) { selected = { step: step.id, block: blockNode.dataset.block }; el.querySelectorAll('[data-selected="true"]').forEach((n) => n.dataset.selected = 'false'); blockNode.dataset.selected = 'true'; drawBox(); }
    }
    function onTop(button){
      if (button.matches('[data-name]')) return;
      if (button.dataset.kind) { def.kind = button.dataset.kind; change(); draw(); return; }
      if (button.dataset.mode) { mode = button.dataset.mode; selected = null; draw(); return; }
      if (button.matches('[data-map]')) return options.onSwitchToMap?.(clone(def), { flowId, dirty });
      if (button.matches('[data-chat-toggle]')) { const host = el.querySelector('.fse'); host.dataset.chat = host.dataset.chat === 'on' ? 'off' : 'on'; if (host.dataset.chat === 'on' && !assistant) mountChat(); return; }
      if (button.matches('[data-save]')) return save();
      if (button.matches('[data-close]')) return options.onClose?.({ dirty });
    }
    function onWheel(event){
      if (editing(event.target) && event.target.scrollHeight > event.target.clientHeight) return;
      event.preventDefault();
      const now = Date.now();
      if (now < wheelLock || Math.abs(event.deltaY) < 18) return;
      wheelLock = now + 480;
      go(index + (event.deltaY > 0 ? 1 : -1));
    }
    function onKey(event){
      if (editing(event.target)) { if (event.key === 'Escape') { event.target.blur(); selected = null; drawBox(); } return; }
      if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); go(index + 1); }
      else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(index - 1); }
      else if (event.key === 'Escape' && selected) { selected = null; draw(); }
    }

    // ── Saving and the assistant ────────────────────────────────────────
    async function save(){
      if (saving || !dirty) return;
      saving = true; error = ''; drawTop();
      try {
        const body = { definition: def, ...(version ? { expected_version: version } : {}) };
        const result = flowId ? await api(`/flows/${encodeURIComponent(flowId)}`, { method: 'PUT', body }) : await api('/flows', { method: 'POST', body });
        flowId = result.flow.id; version = result.flow.version; def = clone(result.flow.definition); dirty = false;
        root.dispatchEvent(new CustomEvent('fm:flows:changed'));
        options.onSave?.(result.flow);
        toast(L('saved_toast', 'Saved.'));
      } catch (failure) { error = clean(failure?.data?.message || failure?.message) || L('save_failed', 'That didn’t save.'); }
      saving = false; drawTop();
    }
    async function reload(){
      if (!flowId || dirty) return;
      const result = await api(`/flows/${encodeURIComponent(flowId)}?latest=1`);
      def = clone(result.flow.definition); version = result.flow.version; draw();
    }
    function mountChat(){
      const host = $('[data-chat-host]'); if (!host || assistant) return;
      if (!root.PlatformAssistant?.mountSurface || !flowId) { host.innerHTML = `<p class="fse-chat-off">${esc(L('chat_off', 'Save the flow to edit it with the assistant.'))}</p>`; return; }
      assistant = root.PlatformAssistant.mountSurface(host, {
        orgId: org,
        welcome: L('chat_welcome', 'Tell me what to change: a question to add, words to reword, a branch for when they say no.'),
        suggestions: [L('chat_s1', 'Add a question asking how old the roof is.'), L('chat_s2', 'Make the opening friendlier and shorter.'), L('chat_s3', 'If they say they are just shopping around, offer to email a price instead.')],
        getContext: () => ({ surface: 'flows', flowId, flowName: def.name }),
        loadContext: async () => { const { thread } = await api(`/flows/${encodeURIComponent(flowId)}/conversation`, { method: 'POST', body: {} }); return { main_thread: thread, threads: [thread], agents: [], dashboard: [] }; },
        onState: ({ pending }) => { if (wasPending && !pending) void reload(); wasPending = !!pending; }
      });
      assistant?.ready?.catch?.((failure) => { if (host.isConnected) host.innerHTML = `<p class="fse-chat-off">${esc(failure?.message || L('chat_unavailable', 'The assistant is unavailable.'))}</p>`; });
    }

    (async () => {
      try {
        if (!def && flowId) { const result = await api(`/flows/${encodeURIComponent(flowId)}?latest=1`); def = clone(result.flow.definition); version = result.flow.version; }
        if (!def) throw new Error(L('no_flow', 'There is no flow to edit.'));
        def.steps = array(def.steps); def.outcomes = array(def.outcomes);
        if (!alive) return;
        frame();
        // The first choice on the way is open: show the path as far as it goes.
        $('[data-main]')?.focus({ preventScroll: true });
      } catch (failure) { if (alive) el.innerHTML = `<p class="fse-chat-off" role="alert">${esc(failure?.message || L('load_failed', 'This flow could not be loaded.'))}</p>`; }
    })();

    return {
      get definition(){ return def ? clone(def) : null; },
      get dirty(){ return dirty; },
      save,
      destroy(){ alive = false; assistant?.destroy?.(); el.innerHTML = ''; }
    };
  }

  /** The editor in a window as wide as the screen: a flow is wide. */
  function open(flowId, options = {}){
    ensureStyles();
    const modal = document.createElement('div');
    modal.className = 'fse-modal';
    modal.innerHTML = '<div class="fse-modal-shell" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(modal);
    let editor = null;
    const remove = () => { editor?.destroy(); modal.remove(); };
    const handle = root.Portal?.modals?.register?.(modal, { id: `flow-script-${flowId || 'new'}`, closeOnBackdrop: false, onClose: remove });
    const close = () => (handle?.close ? handle.close('close') : remove());
    editor = mount(modal.firstElementChild, { ...options, flowId, definition: options.definition, onClose: ({ dirty } = {}) => { if (dirty && !root.confirm(L('discard', 'Close without saving your changes?'))) return; close(); },
      onSwitchToMap: options.onSwitchToMap === false ? undefined : (definition, state) => {
        if (state?.dirty && !root.confirm(L('discard_map', 'Open the map view without saving your changes?'))) return;
        close();
        if (typeof options.onSwitchToMap === 'function') options.onSwitchToMap(definition, state);
        else root.FirstMateFlowEditor?.open?.(state?.flowId || flowId, { onSave: options.onSave });
      } });
    return { close, editor };
  }

  root.FirstMateFlowScriptEditor = { mount, open, friendly, templated };
})();
