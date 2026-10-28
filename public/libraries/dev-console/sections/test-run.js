/*
 * Test run (docs/signup-sandbox-spec.md): the sandbox workflow this test organization is running, one row per stage.
 * Opening a stage goes to its real surface; portal/signup-sandbox/devbar.js runs the stages (window.SignupSandboxRun).
 */
export function mount(root, { T, esc }) {
  let timer = 0, lastActive = null;
  const render = () => {
    const run = window.SignupSandboxRun;
    if (!run) { root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_run_none', 'This organization is not running a sandbox workflow.'))}</p>`; return; }
    const instance = run.instance();
    const active = run.activeStageIndex();
    lastActive = active;
    const org = instance.test_org || {};
    root.innerHTML = `<p class="fm-dc-intro"><strong>${esc(instance.workflow?.title || '')}</strong><span class="fm-dc-sub">${esc(org.org_name || '')} · ${esc(org.email || '')} / ${esc(org.password || '')}</span></p>
      ${run.running ? '' : `<p class="fm-dc-note fm-dc-warn">${esc(T('dc_run_quiet', 'This workflow runs as a customer would see it: stages do not advance on their own here.'))}</p>`}
      <h3 class="fm-dc-h">${esc(T('dc_run_stages', 'Stages'))}</h3>
      <ol class="fm-dc-list">${(instance.stages || []).map((stage, index) => {
        const page = stage.page || {};
        const done = run.stageDone(stage), entry = run.isEntryStage(stage);
        return `<li class="fm-dc-row"${index === active ? ' style="background:#f4f3ff"' : ''}><span><strong>${index + 1} · ${esc(page.title || stage.page_id)}</strong><small>${esc(page.role || '')}${entry ? ' · ' + esc(T('dc_run_entry', 'entry step, already satisfied')) : ''}</small></span>${done ? `<span class="fm-dc-badge fm-dc-ok"><i class="fas fa-check" aria-hidden="true"></i> ${esc(T('dc_run_done', 'Done'))}</span>` : ''}${index === active ? `<span class="fm-dc-badge">${esc(T('dc_run_showing', 'Showing'))}</span>` : `<button type="button" class="fm-dc-btn" data-dc-stage="${index}">${esc(T('dc_run_open', 'Open'))}</button>`}</li>`;
      }).join('')}</ol>
      <div class="fm-dc-actions"><a class="fm-dc-btn" href="/portal/signup-sandbox/"><i class="fas fa-diagram-project" aria-hidden="true"></i> ${esc(T('dc_run_builder', 'Workflow builder'))}</a></div>`;
  };
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-dc-stage]');
    if (button) window.SignupSandboxRun?.openStage(Number(button.dataset.dcStage));
  });
  window.addEventListener('fm:sandbox-run:ready', render);
  // The showing stage follows the wizard and the overlay; redraw only when it moves.
  const watch = () => { clearInterval(timer); timer = setInterval(() => { if (root.isConnected && !root.hidden && window.SignupSandboxRun && window.SignupSandboxRun.activeStageIndex() !== lastActive) render(); }, 700); };
  render(); watch();
  return { shown: render };
}
