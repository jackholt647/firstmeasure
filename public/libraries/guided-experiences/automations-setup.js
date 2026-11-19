// The Automations Hub setup's own pages (guided experience `automations.setup`, GP-110,
// docs/architecture/automations-hub.md). The hub plays it embedded in its right-hand panel, so the flowchart stays in
// view: a setup and a tutorial at once. Each answer is drawn on the chart before it is saved (the hub's `preview`), and
// each page points at the part of the chart it talks about (`spotlight`). It requires the setup step `company.type`
// (asked first, only while unanswered), which picks the suggested board. One step that keeps its own pages:
//   entry    where new leads go: a board (scope template), the one suggested for the kind of company first.
//   shape    is that board the whole job (it spans the Sales and Production lanes) or the sales part, with production
//            after it? Roofing and exteriors companies start with one board. Continue saves both answers with the
//            published action automations.setup.apply (intake routing default + the board's lanes), run as the person.
//   split    how to split new leads (by source, arrival time, place): shown on the chart, nothing to save.
//   connect  how to connect boards and move one between lanes; Done finishes the setup.
// Without the hub around it (played elsewhere) it still works: the boards are read from the scopes routes and nothing
// is previewed.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxa{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 0 8px;color:#101828;font-size:13px}
.gxa p{margin:0;color:#475467;line-height:1.5;font-weight:600}
.gxa h3{margin:0;font-size:15px;font-weight:950;letter-spacing:-.01em}
.gxa-boards{display:grid;gap:8px}
.gxa-board{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;width:100%;padding:10px 12px;border:1.5px solid #eaecf0;border-radius:12px;background:#fff;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.gxa-board:hover{border-color:#d0d5dd}
.gxa-board[aria-pressed="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxa-board>i{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:color-mix(in srgb,var(--c,#667085) 14%,#fff);color:var(--c,#667085)}
.gxa-board strong{display:block;font-size:13px;font-weight:900}
.gxa-board small{display:block;color:#667085;font-size:11px;font-weight:700;margin-top:1px}
.gxa-tag{padding:2px 8px;border-radius:999px;background:#ecfdf3;color:#067647;font-size:10px;font-weight:900;white-space:nowrap}
.gxa-more{justify-self:start;border:0;background:none;color:var(--primary-readable,var(--primary,#d93025));font:inherit;font-weight:850;cursor:pointer;padding:4px 0}
.gxa-choices{display:grid;gap:10px}
.gxa-choice{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start;width:100%;padding:13px 14px;border:1.5px solid #eaecf0;border-radius:14px;background:#fff;font:inherit;text-align:left;cursor:pointer}
.gxa-choice[aria-pressed="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxa-choice>i{grid-row:span 2;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#475467;font-size:15px}
.gxa-choice strong{font-size:13.5px;font-weight:950}
.gxa-choice span{color:#667085;font-size:12px;font-weight:650;line-height:1.45}
.gxa-tips{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.gxa-tips li{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;line-height:1.45;font-weight:700;color:#344054}
.gxa-tips i{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025)}
.gxa-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:4px;flex-wrap:wrap}
.gxa-foot .gxa-err{flex:1;color:#b42318;font-weight:750;font-size:12px}
.gxa-btn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-weight:850;cursor:pointer}
.gxa-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
.gxa-btn[disabled]{opacity:.5;cursor:default}
`;

function installStyle(){
  if (document.getElementById('gxa-automations-setup-css')) return;
  const style = document.createElement('style');
  style.id = 'gxa-automations-setup-css';
  style.textContent = css;
  document.head.appendChild(style);
}

/** Industries whose default is one board for the whole job (a roofer's leads go straight onto the roofing board). */
const ONE_BOARD_INDUSTRIES = /roof|exterior/;

/**
 * The boards in the order the setup suggests them: those whose name matches what the company does first, then (for a
 * one-board industry) production boards before sales boards, else sales boards first; then the current default.
 */
export function suggestBoards(boards, profile, currentDefault){
  const p = object(profile);
  const words = [p.industry, p.company_type, p.company_type_label, ...array(p.services).map((service) => object(service).label), ...array(p.work_kinds)]
    .map(clean).join(' ').toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 4).map((word) => word.slice(0, 4));
  const oneBoard = ONE_BOARD_INDUSTRIES.test(clean(p.industry).toLowerCase());
  const score = (board) => {
    const text = `${board.name} ${board.id}`.toLowerCase();
    const match = [...new Set(words)].filter((word) => text.includes(word)).length;
    const sales = array(board.categories).includes('sales');
    return [match, oneBoard ? (sales ? 0 : 1) : (sales ? 1 : 0), board.id === currentDefault ? 1 : 0, board.id === 'manual' ? -1 : 0];
  };
  return [...array(boards)].map((board) => ({ board, score:score(board) }))
    .sort((a, b) => { for (let i = 0; i < 4; i += 1) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i]; return 0; })
    .map((entry) => ({ ...entry.board, suggested:entry.score[0] > 0 }));
}

export function mount(el, ctx){
  installStyle();
  const L = ctx.L, esc = ctx.esc;
  const T = (key, fallback) => esc(L(`gx_aus_${key}`, fallback));
  const hub = () => window.FirstMateAutomationsHub?.active || null;
  const orgId = clean(window.__APP?.userOrgId || window.__APP?.orgId || hub()?.orgId?.());
  const pages = ['entry', 'shape', 'split', 'connect'];
  let alive = true, page = 0, boards = [], profile = null, currentDefault = '', entry = '', oneBoard = null, saving = false, error = '', showAll = false;

  async function loadBoards(){
    const view = hub()?.view?.();
    if (view) return view.boards.map((board) => ({ id:board.id, name:board.name, color:board.color, icon:board.icon, categories:board.categories, stages:board.stages.length }));
    const model = window.FirstMateAutomationsHub?.model;
    const result = await window.PlatformAPI?.scopes?.list?.(orgId, 'default');
    const lanes = model ? model.lanesOf([{ id:'sales', label:'Sales' }, { id:'production', label:'Production' }]) : [];
    return model ? model.boardsOf(array(result?.templates), lanes).map((board) => ({ id:board.id, name:board.name, color:board.color, icon:board.icon, categories:board.categories, stages:board.stages.length })) : [];
  }

  el.innerHTML = '<div class="gxs-module-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';
  Promise.all([Promise.resolve(hub()?.ready?.()).then(loadBoards), ctx.read('company-profile', 'profile').catch(() => null)]).then(([list, read]) => {
    if (!alive) return;
    profile = object(read);
    currentDefault = clean(hub()?.view?.()?.routing?.default_template_id);
    boards = suggestBoards(list, profile, currentDefault);
    entry = boards[0]?.id || '';
    oneBoard = ONE_BOARD_INDUSTRIES.test(clean(profile.industry).toLowerCase()) || array(boards[0]?.categories).includes('production');
    render();
  }).catch((failure) => { if (alive) el.innerHTML = `<p class="gxs-module-error" role="alert">${esc(clean(failure?.message) || L('gx_ui_step_load_failed', 'This step didn’t load. Close the setup and try again.'))}</p>`; });

  const boardById = (id) => boards.find((board) => board.id === id);
  function show(){
    const h = hub();
    if (!h) return;
    const name = pages[page];
    if (name === 'entry') { h.preview({ entry }); h.spotlight(`[data-lead="default"], [data-board="${CSS.escape(entry)}"]`); }
    else if (name === 'shape') { h.preview({ entry, one_board:oneBoard }); h.spotlight(`[data-board="${CSS.escape(entry)}"], [data-lane-label]`); }
    else if (name === 'split') { h.preview(null); h.spotlight('[data-lead="default"]'); }
    else { h.preview(null); h.spotlight(`[data-board="${CSS.escape(entry)}"] .fmah-port, [data-lane-label]`); }
  }

  function render(){
    if (!alive) return;
    const name = pages[page];
    const foot = (next, options = {}) => `<div class="gxa-foot">${error ? `<span class="gxa-err" role="alert">${esc(error)}</span>` : ''}${page > 0 || ctx.canBack?.() ? `<button type="button" class="gxa-btn" data-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>` : ''}<button type="button" class="gxa-btn primary" data-next ${options.disabled ? 'disabled' : ''}>${esc(next)}</button></div>`;
    if (name === 'entry') {
      const list = showAll ? boards : boards.slice(0, 5);
      el.innerHTML = `<div class="gxa"><h3>${T('entry_title', 'Where do new leads go?')}</h3>
        <p>${T('entry_body', 'Every new lead starts at the top of the chart and goes onto a board. Pick the board most of yours should start on. You can split them up later.')}</p>
        <div class="gxa-boards">${list.map((board) => `<button type="button" class="gxa-board" data-board-pick="${esc(board.id)}" aria-pressed="${board.id === entry}" style="--c:${esc(board.color)}"><i class="fas ${esc(board.icon)}" aria-hidden="true"></i><span><strong>${esc(board.name)}</strong><small>${esc(board.stages === 1 ? L('gx_aus_one_stage', '1 stage') : L({ key:'gx_aus_stage_count', text:`${board.stages} stages` }, `${board.stages} stages`))}</small></span>${board.suggested && board === boards[0] ? `<span class="gxa-tag">${T('suggested', 'Suggested')}</span>` : ''}</button>`).join('')}</div>
        ${!showAll && boards.length > 5 ? `<button type="button" class="gxa-more" data-all>${T('all_boards', 'Show every board')}</button>` : ''}
        ${foot(L('gx_ui_continue', 'Continue'), { disabled:!entry })}</div>`;
    } else if (name === 'shape') {
      const board = boardById(entry);
      el.innerHTML = `<div class="gxa"><h3>${T('shape_title', 'Is that board the whole job?')}</h3>
        <p>${esc(L({ key:'gx_aus_shape_body', text:`Watch ${board?.name || 'the board'} on the chart: its lanes show whether it is selling the job, doing it, or both.` }, `Watch ${board?.name || 'the board'} on the chart: its lanes show whether it is selling the job, doing it, or both.`))}</p>
        <div class="gxa-choices">
          <button type="button" class="gxa-choice" data-shape="one" aria-pressed="${oneBoard === true}"><i class="fas fa-arrows-up-down" aria-hidden="true"></i><strong>${T('shape_one', 'Yes, one board from lead to finished job')}</strong><span>${T('shape_one_hint', 'It spans Sales and Production. Most roofers work this way.')}</span></button>
          <button type="button" class="gxa-choice" data-shape="two" aria-pressed="${oneBoard === false}"><i class="fas fa-arrow-down" aria-hidden="true"></i><strong>${T('shape_two', 'No, it is the sales part')}</strong><span>${T('shape_two_hint', 'It sits in Sales. When a sale is made, the project moves onto a production board.')}</span></button>
        </div>${foot(saving ? L('gx_aus_saving', 'Saving…') : L('gx_ui_continue', 'Continue'), { disabled:saving || oneBoard === null })}</div>`;
    } else if (name === 'split') {
      el.innerHTML = `<div class="gxa"><h3>${T('split_title', 'Different leads, different boards')}</h3>
        <ul class="gxa-tips">
          <li><i class="fas fa-inbox" aria-hidden="true"></i><span>${T('split_tip', 'Click “Any new lead” at the top of the chart to split new leads up.')}</span></li>
          <li><i class="fas fa-signs-post" aria-hidden="true"></i><span>${T('split_source', 'By where they come from: missed calls can wait for a call back while website forms go straight to a board.')}</span></li>
          <li><i class="fas fa-clock" aria-hidden="true"></i><span>${T('split_time', 'By when they come in: after hours and weekends, on your company’s clock.')}</span></li>
          <li><i class="fas fa-location-dot" aria-hidden="true"></i><span>${T('split_place', 'By where the job is, or by anything else the lead says.')}</span></li>
        </ul>${foot(L('gx_ui_continue', 'Continue'))}</div>`;
    } else {
      el.innerHTML = `<div class="gxa"><h3>${T('connect_title', 'Connect your boards')}</h3>
        <ul class="gxa-tips">
          <li><i class="fas fa-circle-dot" aria-hidden="true"></i><span>${T('connect_drag', 'Drag from the dot under a board onto another board. When the last stage is done, the project starts there.')}</span></li>
          <li><i class="fas fa-hand-pointer" aria-hidden="true"></i><span>${T('connect_click', 'Or click the dot, then click the board.')}</span></li>
          <li><i class="fas fa-up-down" aria-hidden="true"></i><span>${T('connect_lanes', 'Drag a board by its title into another lane. On the line between two lanes, it is in both.')}</span></li>
          <li><i class="fas fa-plus" aria-hidden="true"></i><span>${T('connect_add', 'Add, rename or remove lanes on the left. Sales is always there: a project on a Sales board is an open opportunity.')}</span></li>
        </ul>${foot(L('gx_aus_done', 'Done'))}</div>`;
    }
    show();
    ctx.change({}, '');
    ctx.syncBack?.();
  }

  async function save(){
    if (saving) return;
    saving = true; error = ''; render();
    try {
      if (!orgId || !window.PlatformAPI?.publication?.invoke) throw new Error(L('gx_ui_save_unavailable', 'This can’t be saved here. Reload the page and try again.'));
      await window.PlatformAPI.publication.invoke(orgId, 'automations.setup.apply', { scope:'organization', organizationId:orgId }, { entry_template_id:entry, one_board:oneBoard === true },
        { idempotencyKey:`automations.setup:${orgId}:${crypto.randomUUID()}` });
      saving = false;
      await hub()?.reload?.();
      page += 1; render();
    } catch (failure) {
      saving = false; error = clean(failure?.message) || L('gx_wfs_error', 'That didn’t work. Try again.'); render();
    }
  }

  el.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-board-pick]');
    if (pick) { entry = pick.dataset.boardPick; error = ''; return render(); }
    if (event.target.closest('[data-all]')) { showAll = true; return render(); }
    const shape = event.target.closest('[data-shape]');
    if (shape) { oneBoard = shape.dataset.shape === 'one'; error = ''; return render(); }
    if (event.target.closest('[data-back]')) { if (!back()) ctx.back?.(); return; }
    if (event.target.closest('[data-next]')) {
      const name = pages[page];
      if (name === 'shape') return save();
      if (name === 'connect') { hub()?.spotlight?.(null); return ctx.advance(); }
      page += 1; error = ''; render();
    }
  });

  function back(){ if (page === 0) return false; page -= 1; error = ''; render(); return true; }

  return {
    handlesNavigation:true,
    valid:() => true,
    summary:() => '',
    back,
    backDepth:() => page,
    escape:() => false,
    destroy(){ alive = false; hub()?.preview?.(null); hub()?.spotlight?.(null); }
  };
}
