/*
 * Setup (FM-571): a checklist of every setup this organization has been through. Questions are setup steps
 * (docs/architecture/setup-steps.md): answered once, by whichever setup asks first; each says where it was answered,
 * asked or skipped. Guided setups and tours are guided experiences with their progress; app setups are the app
 * catalog's setup workflows (libraries/app-setup-workflows), read from the page. Hover (or tap) a row for where and
 * when. GET /v1/signup-sandbox/development/console/setup.
 *
 * Each question can be tested: Test opens it in an overlay (../setup-test.html in a frame, played by the real setup
 * player even when answered, saved for real). On a desktop the overlay switches the frame between desktop, tablet and
 * phone widths; on a phone it is the phone. Roll back puts back every value its tests changed, its progress and events
 * (development/setup-tests.ts).
 *
 * Each guided setup can be played again (FM-589): Run again plays it on the page (in the open project window when there
 * is one) as a replay when it allows one, like the app's own "Set up" buttons (its progress shows where the replay
 * got); one that does not is reset first and plays as new. Reset puts its progress back to never shown, so its triggers
 * play it again (POST …/dev/reset, guided-experiences dev.ts).
 */
const DEVICES = { desktop: ['fa-desktop', ['dc_setup_desktop', 'Desktop']], tablet: ['fa-tablet-screen-button', ['dc_setup_tablet', 'Tablet']], phone: ['fa-mobile-screen-button', ['dc_setup_phone', 'Phone']] };
let device = 'desktop';

export function mount(root, { api, T, esc, toast, phone, close, orgId, VERSION }) {
  let token = 0, data = null, apps = [];
  const open = new Set();
  const STATUS = {
    done: ['fa-circle-check', 'fm-dc-ok', ['dc_setup_done', 'Done']],
    started: ['fa-circle-half-stroke', 'fm-dc-changed', ['dc_setup_started', 'Started']],
    skipped: ['fa-forward', 'fm-dc-skipped', ['dc_setup_skipped', 'Skipped']],
    not_started: ['fa-circle', 'fm-dc-todo', ['dc_setup_not_started', 'Not started']]
  };
  const when = (at) => { const date = at ? new Date(at) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const by = (name) => name ? ` ${T('dc_setup_by', 'by')} ${name}` : '';
  const place = (where) => where.on_its_own ? T('dc_setup_on_its_own', 'on its own') : `${T('dc_setup_in', 'in')} ${where.experience_title}`;

  /** A question: its short line (where) and the full hint. */
  function stepLines(step) {
    const lines = [];
    let short = '';
    if (step.status === 'done') {
      short = step.answered_in ? `${T('dc_setup_answered', 'Answered')} ${place(step.answered_in)}` : T('dc_setup_answered_outside', 'Answered outside a guided setup');
      lines.push(step.answered_in
        ? `${T('dc_setup_answered', 'Answered')} ${place(step.answered_in)}${by(step.answered_in.by)}, ${when(step.answered_in.at)}`
        : T('dc_setup_answered_outside_hint', 'No guided setup saved this answer: it came from Settings, signup, an agent or an import.'));
    } else if (step.last) {
      short = `${step.status === 'skipped' ? T('dc_setup_skipped_in', 'Skipped') : T('dc_setup_asked', 'Asked, not answered')} ${place(step.last)}`;
      lines.push(`${short}${by(step.last.by)}, ${when(step.last.at)}`);
      if (step.answered_in) lines.push(`${T('dc_setup_answered_before', 'Answered before')} ${place(step.answered_in)}, ${when(step.answered_in.at)}; ${T('dc_setup_no_answer_now', 'no answer is saved now')}`);
    } else short = T('dc_setup_never_asked', 'Never asked');
    if (step.asked_by.length) lines.push(`${T('dc_setup_asked_by', 'Asked by')}: ${step.asked_by.join(', ')}`);
    if (step.requires.length) lines.push(`${T('dc_setup_requires', 'Asked after')}: ${step.requires.map((id) => data.steps.find((other) => other.id === id)?.title || id).join(', ')}`);
    if (step.test) lines.push(`${T('dc_setup_tested', 'Tested')} ×${step.test.tests} ${T('dc_setup_since', 'since')} ${when(step.test.first_started_at)}. ${restores(step.test)}`);
    lines.push(`${step.id}${step.scope === 'person' ? ` · ${T('dc_setup_per_person', 'each person answers')}` : ''}`);
    return { short, lines };
  }
  /** A guided setup or tour. */
  function guideLines(guide) {
    const lines = [];
    let short = '';
    if (guide.status === 'done') short = `${T('dc_setup_finished', 'Finished')}${by(guide.finished_by)}, ${when(guide.finished_at)}`;
    else if (guide.status === 'skipped') short = `${T('dc_setup_skipped_at', 'Skipped')}${guide.step ? ` ${T('dc_setup_at', 'at')} ${guide.step.title}` : ''}${by(guide.finished_by)}, ${when(guide.finished_at)}`;
    else if (guide.status === 'started') short = guide.step ? `${T('dc_setup_stopped_at', 'Last at')} ${guide.step.title}, ${when(guide.updated_at)}` : `${T('dc_setup_shown', 'Shown, not started')}, ${when(guide.updated_at)}`;
    lines.push(short || T('dc_setup_never_shown', 'Never shown'));
    if (guide.started_at && guide.status !== 'not_started') lines.push(`${T('dc_setup_first_shown', 'First shown')} ${when(guide.started_at)}`);
    if (guide.asks.length) lines.push(`${T('dc_setup_asks', 'Asks first')}: ${guide.asks.join(', ')}`);
    lines.push(`${guide.id} · ${guide.scope === 'person' ? T('dc_setup_yours', 'your progress') : T('dc_setup_org', 'the organization’s progress')}`);
    return { short, lines };
  }
  /** An app catalog setup workflow, as FirstMateAppSetupWorkflows has it on this page. */
  function appLines(app) {
    const record = app.record || {};
    const short = app.status === 'done' ? `${T('dc_setup_finished', 'Finished')} ${when(record.completed_at || record.updated_at)}`
      : app.status === 'started' ? `${T('dc_setup_stopped_at', 'Last at')} ${record.active_step || '—'}, ${when(record.updated_at)}` : '';
    const lines = [short || T('dc_setup_never_opened', 'Never opened')];
    if (record.started_at) lines.push(`${T('dc_setup_first_opened', 'First opened')} ${when(record.started_at)}`);
    lines.push(`${app.key} · ${app.mode === 'required' ? T('dc_setup_app_required', 'required for the app') : T('dc_setup_app_optional', 'optional')}${app.external ? ` · ${T('dc_setup_app_external', 'its own workflow')}` : ''}`);
    return { short, lines };
  }

  /** What roll back puts back, from the test's changes (module.key). */
  function restores(test) {
    if (!test.changes.length) return T('dc_setup_restores_nothing', 'Nothing it saved yet; roll back only forgets the test.');
    const byModule = new Map();
    for (const change of test.changes) byModule.set(change.module, [...(byModule.get(change.module) || []), change.key]);
    return `${T('dc_setup_restores', 'Roll back restores')} ${[...byModule].map(([module, keys]) => `${module} (${keys.join(', ')})`).join('; ')}.`;
  }
  /** Test and Roll back under a question. */
  const stepActions = (step) => confirming === step.id && step.test
    ? `<span class="fm-dc-setup-confirm"><small>${esc(confirmText(step))}</small><span class="fm-dc-setup-acts"><button type="button" class="fm-dc-btn fm-dc-danger" data-dc-setup-rollback-now="${esc(step.id)}"><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_setup_rollback_now', 'Roll back now'))}</button><button type="button" class="fm-dc-btn" data-dc-setup-rollback-cancel>${esc(T('dc_setup_cancel', 'Cancel'))}</button></span></span>`
    : `<span class="fm-dc-setup-acts"><button type="button" class="fm-dc-btn" data-dc-setup-test="${esc(step.id)}"><i class="fas fa-play" aria-hidden="true"></i> ${esc(T('dc_setup_test', 'Test'))}</button>${step.test ? `<button type="button" class="fm-dc-btn" data-dc-setup-rollback="${esc(step.id)}"><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_setup_rollback', 'Roll back'))}</button>` : ''}</span>`;

  /** Run again (Start, Continue) and Reset under a guided setup. */
  const PLAY = { not_started: ['dc_setup_start', 'Start'], started: ['dc_setup_continue', 'Continue'] };
  const guideActions = (guide) => `<span class="fm-dc-setup-acts"><button type="button" class="fm-dc-btn" data-dc-setup-play="${esc(guide.id)}"${busy ? ' disabled' : ''}><i class="fas fa-play" aria-hidden="true"></i> ${esc(T(...(PLAY[guide.status] || ['dc_setup_run_again', 'Run again'])))}</button>${guide.status !== 'not_started' ? `<button type="button" class="fm-dc-btn" data-dc-setup-reset="${esc(guide.id)}"${busy ? ' disabled' : ''}><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_setup_reset', 'Reset'))}</button>` : ''}</span>`;

  function row(kind, id, title, status, { short, lines }, actions = '') {
    const [icon, tone, label] = STATUS[status] || STATUS.not_started;
    const key = `${kind}:${id}`, expanded = open.has(key);
    return `<li class="fm-dc-row fm-dc-setup-row" data-dc-setup-row="${esc(key)}" title="${esc(lines.join('\n'))}" aria-expanded="${expanded}" tabindex="0">
      <i class="fas ${icon} fm-dc-setup-icon ${tone}" aria-hidden="true"></i>
      <span><strong>${esc(title)}</strong>${short ? `<small>${esc(short)}</small>` : ''}${expanded ? `<small class="fm-dc-setup-more">${lines.map(esc).join('<br>')}</small>` : ''}${actions}</span>
      <span class="fm-dc-badge ${tone}">${esc(T(...label))}</span></li>`;
  }
  const count = (list) => `${list.filter((entry) => entry.status === 'done').length}/${list.length}`;
  const group = (heading, list, html, note = '') => list.length ? `<h3 class="fm-dc-h">${esc(heading)} · ${count(list)}</h3>${note ? `<p class="fm-dc-sub">${esc(note)}</p>` : ''}<ul class="fm-dc-list">${list.map(html).join('')}</ul>` : '';
  const ORDER = { started: 0, skipped: 1, not_started: 2, done: 3 };
  const byState = (a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);

  function render() {
    if (!data) return;
    const setups = data.guides.filter((guide) => guide.group === 'setup').sort(byState);
    const tours = data.guides.filter((guide) => guide.group === 'tour').sort(byState);
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_setup_intro', 'Every setup this organization has been through. Hover or tap a row for where and when it was done.'))}</p>
      <div class="fm-dc-actions"><button type="button" class="fm-dc-btn" data-dc-setup-reload><i class="fas fa-arrows-rotate" aria-hidden="true"></i> ${esc(T('dc_setup_reload', 'Refresh'))}</button></div>
      ${group(T('dc_setup_questions', 'Questions asked once'), data.steps, (step) => row('step', step.id, step.title, step.status, stepLines(step), stepActions(step)), T('dc_setup_questions_note', 'Setup steps: whichever setup asks first saves the answer; the others skip it. Test asks one again and saves it for real; Roll back undoes its tests.'))}
      ${group(T('dc_setup_guided', 'Guided setups'), setups, (guide) => row('guide', guide.id, guide.title, guide.status, guideLines(guide), guideActions(guide)), T('dc_setup_guided_note', 'Run again plays a setup here again, saving for real; Reset makes it never shown, so it plays when its trigger comes.'))}
      ${group(T('dc_setup_apps', 'App setups'), apps, (app) => row('app', app.key, app.label, app.status, appLines(app)))}
      ${tours.length ? `<details class="fm-dc-setup-tours"${open.has('tours') ? ' open' : ''}><summary class="fm-dc-h">${esc(T('dc_setup_tours', 'Tours'))} · ${count(tours)}</summary><ul class="fm-dc-list">${tours.map((guide) => row('guide', guide.id, guide.title, guide.status, guideLines(guide))).join('')}</ul></details>` : ''}`;
  }

  async function readApps() {
    const workflows = window.FirstMateAppSetupWorkflows;
    if (!workflows?.inventory) return [];
    const statuses = new Map((await workflows.refresh?.().catch(() => null) || []).map((entry) => [entry.key, entry.status]));
    return workflows.inventory().filter((app) => app.mode !== 'none').map((app) => {
      const raw = String(statuses.get(app.key) || workflows.status?.(app.key) || 'not_started');
      return { ...app, record: workflows.record?.(app.key) || {}, status: raw === 'complete' ? 'done' : raw === 'not_started' ? 'not_started' : 'started' };
    }).sort(byState);
  }
  async function load() {
    const mine = ++token;
    if (!data) root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_setup_loading', 'Reading setup state…'))}</p>`;
    try {
      const [answer, appRows] = await Promise.all([api('/v1/signup-sandbox/development/console/setup'), readApps().catch(() => [])]);
      if (mine !== token) return;
      data = answer; apps = appRows; render();
    } catch (error) {
      if (mine !== token) return;
      root.innerHTML = error.status === 404 && /^Route /.test(String(error.body?.message || ''))
        ? `<p class="fm-dc-note">${esc(T('dc_setup_later', 'The setup checklist is not on dev yet.'))}</p>`
        : `<p class="fm-dc-note fm-dc-warn">${esc(error.message)}</p>`;
    }
  }
  const toggle = (rowEl) => {
    const key = rowEl.dataset.dcSetupRow, focused = rowEl === document.activeElement;
    open.has(key) ? open.delete(key) : open.add(key);
    render();
    if (focused) [...root.querySelectorAll('[data-dc-setup-row]')].find((el) => el.dataset.dcSetupRow === key)?.focus();
  };
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-dc-setup-reload]')) { load(); return; }
    const test = event.target.closest('[data-dc-setup-test]');
    if (test) { openTest(test.dataset.dcSetupTest); return; }
    const back = event.target.closest('[data-dc-setup-rollback]');
    if (back) { arm(back.dataset.dcSetupRollback); return; }
    const now = event.target.closest('[data-dc-setup-rollback-now]');
    if (now) { rollback(now.dataset.dcSetupRollbackNow); return; }
    const play = event.target.closest('[data-dc-setup-play]');
    if (play) { runGuide(play.dataset.dcSetupPlay); return; }
    const reset = event.target.closest('[data-dc-setup-reset]');
    if (reset) { resetGuide(reset.dataset.dcSetupReset); return; }
    if (event.target.closest('[data-dc-setup-rollback-cancel]')) { confirming = ''; render(); return; }
    const rowEl = event.target.closest('[data-dc-setup-row]');
    if (rowEl) toggle(rowEl);
  });
  root.addEventListener('keydown', (event) => {
    const rowEl = event.target.closest?.('[data-dc-setup-row]');
    if (rowEl && event.target === rowEl && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(rowEl); }
  });
  const stepOf = (id) => data?.steps.find((step) => step.id === id) || null;
  const base = (id) => `/v1/signup-sandbox/development/console/setup/steps/${encodeURIComponent(id)}`;

  /**
   * Rolls a tested step back. The portal draws window.confirm as its own dialog, which an overlay can cover, so the
   * console asks in place: the first press says what it restores, the second within a few seconds does it.
   */
  let confirming = '', confirmTimer = 0;
  const confirmText = (step) => `${restores(step.test)} ${T('dc_setup_rollback_events', 'Its progress and the events its tests recorded go too.')}`;
  function arm(id) { confirming = id; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { confirming = ''; render(); }, 8000); render(); }
  async function rollback(id) {
    confirming = ''; clearTimeout(confirmTimer);
    try {
      const result = await api(`${base(id)}/rollback`, { method: 'POST', body: {} });
      toast(result.restored?.length ? T('dc_setup_rolled_back', 'Rolled back. Reload the page to see it everywhere.') : T('dc_setup_rolled_back_nothing', 'Rolled back; the test had saved nothing.'));
      return true;
    } catch (error) { toast(error.message); return false; }
    finally { await load(); }
  }

  /** Guided setups (FM-589): reset one's progress, or play it again where the page plays guides. */
  let busy = false;
  const guideOf = (id) => data?.guides.find((guide) => guide.id === id) || null;
  const resetProgress = (id) => api(`/v1/guided-experiences/organizations/${encodeURIComponent(orgId())}/dev/reset`, { method: 'POST', body: { experience_id: id, scope: 'me' } });
  /**
   * The guided library that plays it: the open project window's, as the Guided experiences section does, else the
   * page's. The portal keeps a spare project window ready, laid out but hidden: a setup played there is never seen.
   */
  function guidesHere() {
    for (const frame of document.querySelectorAll('iframe')) {
      try { const guides = frame.contentWindow?.FirstMateGuides; if (guides?.play && guides !== window.FirstMateGuides && frame.getClientRects().length && getComputedStyle(frame).visibility === 'visible') return guides; } catch (_) { /* another origin */ }
    }
    return window.FirstMateGuides?.play ? window.FirstMateGuides : null;
  }
  async function resetGuide(id) {
    if (busy) return;
    busy = true; render();
    try {
      await resetProgress(id);
      await guidesHere()?.refresh?.();
      toast(T('dc_setup_reset_done', 'Reset: it plays as new the next time it is opened.'));
    } catch (error) { toast(error.message); }
    finally { busy = false; await load(); }
  }
  async function runGuide(id) {
    const guide = guideOf(id), guides = guidesHere();
    if (!guide || busy) return;
    if (!guides) { toast(T('dc_setup_play_unavailable', 'Guided setups cannot play on this page.')); return; }
    if (guides.isPlaying?.()) { toast(T('dc_setup_play_busy', 'Another guided experience is playing; close it first.')); return; }
    busy = true; render();
    let outcome = null;
    try {
      await guides.refresh();
      // A finished setup that allows no replay is not offered again: reset it so it plays as new.
      let fresh = guide.status === 'not_started' || guide.status === 'started';
      if (!guides.experience(id) && !fresh) { await resetProgress(id); await guides.refresh(); fresh = true; }
      // On a phone the console covers the page the setup plays on.
      if (phone()) close?.();
      busy = false; render();
      outcome = await guides.play(id, { replay: !fresh, force: true });
    } catch (error) { toast(error.message); }
    finally { busy = false; }
    const status = String(outcome?.status || '');
    if (status === 'unavailable') toast(T('dc_setup_play_not_offered', 'It is not offered to you here: its app is off or you lack its permission.'));
    else if (status === 'satisfied') toast(T('dc_setup_play_satisfied', 'Nothing to ask: every question it asks is answered. Test a question above to ask it again.'));
    else if (status === 'busy') toast(T('dc_setup_play_busy', 'Another guided experience is playing; close it first.'));
    await load();
  }

  /**
   * The test overlay: the step in a frame (../setup-test.html). On a desktop it covers the page beside the console and
   * switches the frame's width; on a phone it covers everything and is the phone.
   */
  function openTest(id) {
    const step = stepOf(id);
    if (!step) return;
    document.querySelector('.fm-dc-test')?.dispatchEvent(new Event('fm-dc-test-close'));
    const small = phone();
    const shell = document.createElement('div');
    shell.className = `fm-dc-test${small ? ' fm-dc-test-phone' : ''}`;
    shell.setAttribute('data-fmr-ignore', ''); shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', `${T('dc_setup_test', 'Test')}: ${step.title}`);
    const src = () => `/libraries/dev-console/setup-test.html?step=${encodeURIComponent(id)}&v=${encodeURIComponent(VERSION)}&t=${Date.now()}`;
    shell.innerHTML = `<header class="fm-dc-test-bar">
        <span class="fm-dc-test-title"><strong>${esc(step.title)}</strong><small data-test-state>${esc(T('dc_setup_test_loading', 'Loading…'))}</small></span>
        ${small ? '' : `<span class="fm-dc-test-devices" role="group" aria-label="${esc(T('dc_setup_device', 'Device'))}">${Object.entries(DEVICES).map(([key, [icon, label]]) => `<button type="button" data-test-device="${key}" aria-pressed="${key === device}" title="${esc(T(...label))}"><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(T(...label))}</span></button>`).join('')}</span>`}
        <span class="fm-dc-test-acts"><button type="button" class="fm-dc-btn" data-test-again hidden><i class="fas fa-play" aria-hidden="true"></i> ${esc(T('dc_setup_test_again', 'Test again'))}</button><button type="button" class="fm-dc-btn" data-test-rollback hidden><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_setup_rollback', 'Roll back'))}</button><button type="button" class="fm-dc-btn" data-test-close aria-label="${esc(T('dc_setup_test_close', 'Close'))}" title="${esc(T('dc_setup_test_close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>
      </header>
      <div class="fm-dc-test-stage" data-device="${small ? 'native' : device}"><iframe title="${esc(step.title)}" src="${esc(src())}"></iframe></div>`;
    // Over the page beside the console on a desktop (the docked body holds fixed layers); over everything on a phone.
    (small ? document.documentElement : document.body).append(shell);
    const frame = shell.querySelector('iframe'), stateEl = shell.querySelector('[data-test-state]');
    let playing = false;
    // Roll back waits until the step is closed: a save after it would not be undone.
    const tested = () => { shell.querySelector('[data-test-rollback]').hidden = playing || !stepOf(id)?.test; };
    const onMessage = (event) => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'fm-dc-setup-test' || event.data.step !== id) return;
      const { state, outcome, message } = event.data;
      playing = state === 'playing';
      stateEl.textContent = state === 'playing' ? T('dc_setup_test_playing', 'Testing: answers are saved for real.')
        : state === 'failed' ? message || T('dc_setup_test_failed', 'The test could not start.')
        : outcome?.status === 'completed' ? T('dc_setup_test_answered', 'Answered.') : T('dc_setup_test_closed', 'Closed without finishing.');
      shell.querySelector('[data-test-again]').hidden = state === 'playing';
      load().then(tested);
    };
    window.addEventListener('message', onMessage);
    const close = () => {
      window.removeEventListener('message', onMessage); document.removeEventListener('keydown', onKey, true);
      // A test closed while it plays is ended here: its frame is gone before it can say so.
      if (playing) api(`${base(id)}/test/end`, { method: 'POST', body: {} }).catch(() => null).finally(load);
      shell.remove();
    };
    const onKey = (event) => { if (event.key === 'Escape' && !playing) { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    shell.addEventListener('fm-dc-test-close', close);
    shell.addEventListener('click', (event) => {
      const pick = event.target.closest('[data-test-device]');
      if (pick) {
        device = pick.dataset.testDevice;
        shell.querySelector('.fm-dc-test-stage').dataset.device = device;
        shell.querySelectorAll('[data-test-device]').forEach((button) => button.setAttribute('aria-pressed', String(button === pick)));
      }
      if (event.target.closest('[data-test-close]')) close();
      if (event.target.closest('[data-test-again]')) { playing = false; stateEl.textContent = T('dc_setup_test_loading', 'Loading…'); frame.src = src(); }
      const back = event.target.closest('[data-test-rollback]');
      if (back && back.dataset.armed !== '1') {
        const step = stepOf(id);
        if (!step?.test) return;
        back.dataset.armed = '1'; back.classList.add('fm-dc-danger');
        back.lastChild.textContent = ` ${T('dc_setup_rollback_confirm_now', 'Press again to roll back')}`;
        stateEl.textContent = confirmText(step);
        setTimeout(() => { if (back.isConnected && back.dataset.armed === '1') { back.dataset.armed = ''; back.classList.remove('fm-dc-danger'); back.lastChild.textContent = ` ${T('dc_setup_rollback', 'Roll back')}`; } }, 8000);
      } else if (back) {
        back.dataset.armed = ''; back.classList.remove('fm-dc-danger'); back.lastChild.textContent = ` ${T('dc_setup_rollback', 'Roll back')}`;
        rollback(id).then((ok) => { tested(); if (ok) stateEl.textContent = T('dc_setup_test_rolled_back', 'Rolled back: as before the first test.'); });
      }
    });
    tested();
  }

  root.addEventListener('toggle', (event) => { if (event.target.matches?.('.fm-dc-setup-tours')) event.target.open ? open.add('tours') : open.delete('tours'); }, true);
  load();
  return { shown: load };
}
