/*
 * Setup (FM-571): a checklist of every setup this organization has been through. Questions are setup steps
 * (docs/architecture/setup-steps.md): answered once, by whichever setup asks first; each says where it was answered,
 * asked or skipped. Guided setups and tours are guided experiences with their progress; app setups are the app
 * catalog's setup workflows (libraries/app-setup-workflows), read from the page. Hover (or tap) a row for where and
 * when. GET /v1/signup-sandbox/development/console/setup; reads only.
 */
export function mount(root, { api, T, esc }) {
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

  function row(kind, id, title, status, { short, lines }) {
    const [icon, tone, label] = STATUS[status] || STATUS.not_started;
    const key = `${kind}:${id}`, expanded = open.has(key);
    return `<li class="fm-dc-row fm-dc-setup-row" data-dc-setup-row="${esc(key)}" title="${esc(lines.join('\n'))}" aria-expanded="${expanded}" tabindex="0">
      <i class="fas ${icon} fm-dc-setup-icon ${tone}" aria-hidden="true"></i>
      <span><strong>${esc(title)}</strong>${short ? `<small>${esc(short)}</small>` : ''}${expanded ? `<small class="fm-dc-setup-more">${lines.map(esc).join('<br>')}</small>` : ''}</span>
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
      ${group(T('dc_setup_questions', 'Questions asked once'), data.steps, (step) => row('step', step.id, step.title, step.status, stepLines(step)), T('dc_setup_questions_note', 'Setup steps: whichever setup asks first saves the answer; the others skip it.'))}
      ${group(T('dc_setup_guided', 'Guided setups'), setups, (guide) => row('guide', guide.id, guide.title, guide.status, guideLines(guide)))}
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
    const rowEl = event.target.closest('[data-dc-setup-row]');
    if (rowEl) toggle(rowEl);
  });
  root.addEventListener('keydown', (event) => {
    const rowEl = event.target.closest?.('[data-dc-setup-row]');
    if (rowEl && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(rowEl); }
  });
  root.addEventListener('toggle', (event) => { if (event.target.matches?.('.fm-dc-setup-tours')) event.target.open ? open.add('tours') : open.delete('tours'); }, true);
  load();
  return { shown: load };
}
