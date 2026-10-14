/* public/libraries/apps/people/people-home.js
 *
 * People > Overview: the four parts of People as cards with live counts.
 * A card opens its sub-page.
 *
 *   FirstMatePeople.views.register('home', mount)   (done at the end of this file)
 *   mount(host, { go(viewId) }) -> { refresh(), destroy() }
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.peopleHome) return;
  const kit = People.kit;
  const data = People.data;
  const { esc, t } = kit;

  function ensureStyles(){
    if (document.getElementById('pp_home_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_home_css';
    style.textContent = `
      .pp-home{display:grid;gap:14px;container-type:inline-size}
      .pp-home-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .pp-card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:14px 12px;padding:16px;border:1px solid var(--pp-line);border-radius:14px;background:var(--pp-panel);color:var(--pp-text);font:inherit;text-align:left;cursor:pointer;transition:border-color .14s ease,box-shadow .14s ease,transform .14s ease}
      .pp-card:hover{border-color:rgba(var(--pp-accent-rgb),.45);box-shadow:0 8px 22px rgba(16,24,40,.08);transform:translateY(-1px)}
      .pp-card>i.pp-card-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--pp-soft);border:1px solid var(--pp-line);color:var(--pp-muted);font-size:14px}
      .pp-card>strong{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-card-count{grid-column:1/-1;display:flex;align-items:baseline;gap:9px;min-width:0}
      .pp-card-count>b{font-size:30px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
      .pp-card-count>span{min-width:0;color:var(--pp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-card>.pp-card-go{position:absolute;right:14px;top:18px;color:var(--pp-faint);font-size:11px;transition:transform .14s ease,color .14s ease}
      .pp-card:hover>.pp-card-go{color:var(--pp-accent);transform:translateX(2px)}
      .pp-attention{display:grid;gap:2px;margin-top:6px}
      .pp-attention>h3{margin:0 0 4px 2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-attention-row{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 10px;border:0;border-radius:9px;background:var(--pp-soft);color:var(--pp-strong);font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background .12s ease}
      .pp-attention-row:hover{background:var(--pp-hover)}
      .pp-attention-row>i:first-child{width:16px;text-align:center;color:var(--pp-warn);font-size:12px}
      .pp-attention-row>b{min-width:18px;font-weight:700;font-variant-numeric:tabular-nums}
      .pp-attention-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-attention-go{color:var(--pp-faint);font-size:10px}
      .pp-card.loading .pp-card-count>b{color:transparent;border-radius:6px;background:var(--pp-hover);min-width:44px}
      @container (max-width:860px){.pp-home-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container (max-width:420px){.pp-home-cards{grid-template-columns:minmax(0,1fr)}.pp-card{grid-template-rows:auto;grid-template-columns:auto minmax(0,1fr) auto;gap:12px}.pp-card-count{grid-column:auto;justify-content:flex-end}.pp-card-count>b{font-size:20px}.pp-card-count>span{display:none}.pp-card>.pp-card-go{display:none}}
      @media (prefers-reduced-motion:reduce){.pp-card,.pp-card>.pp-card-go{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function mount(host, context = {}){
    ensureStyles();
    People.listPage.ensureStyles();
    let destroyed = false;
    let attention = [];
    let unresolvedPay = 0;
    const labels = () => data.state.groupLabels;
    function draw(){
      if (destroyed) return;
      const loaded = data.state.loaded;
      const counts = loaded ? data.counts() : {};
      const online = loaded ? data.state.users.filter((user) => kit.presence.status(user.id)).length : 0;
      /* One line per thing worth a look, from what is already loaded; pay is asked of payroll only when it is there. */
      const names = { users:[t('user_one', 'user'), t('user_many', 'users')], groups:[(labels().singular || t('group', 'Group')).toLowerCase(), (labels().plural || t('groups', 'Groups')).toLowerCase()], subcontractors:[(labels().connectionSingular || t('subcontractor', 'Subcontractor')).toLowerCase(), (labels().connectionPlural || t('subcontractors', 'Subcontractors')).toLowerCase()] };
      attention = loaded ? [...data.attention().map((item) => ({ ...item, text:`${Number(item.count) === 1 ? names[item.view][0] : names[item.view][1]} ${item.label}` })), ...(unresolvedPay ? [{ id:'pay', icon:kit.ICONS.compensation, view:'payroll', count:unresolvedPay, text:t('attention_pay', 'earnings that could not be worked out') }] : [])] : [];
      const cards = [
        { id:'users', icon:kit.ICONS.users, title:t('users', 'Users'), count:counts.users, note:[online ? `${online} ${t('online_count', 'online')}` : '', counts.neverSignedIn ? `${counts.neverSignedIn} ${t('never_signed_in_count', 'never signed in')}` : ''].filter(Boolean).join(', ') },
        { id:'groups', icon:kit.ICONS.group, title:(loaded && labels().plural) || kit.term('workforce.resource_group_plural', t('groups', 'Groups')), count:counts.groups, note:counts.groupTypes ? kit.countPhrase([[counts.groupTypes, t('type_one', 'type'), t('type_many', 'types')]]) : '' },
        { id:'departments', icon:kit.ICONS.department, title:(loaded && labels().departmentPlural) || t('departments', 'Departments'), count:counts.departments, note:'' },
        { id:'subcontractors', icon:kit.ICONS.company, title:(loaded && labels().connectionPlural) || kit.term('workforce.organization_connection_plural', t('subcontractors', 'Subcontractors')), count:counts.companies, note:counts.linked ? `${counts.linked} ${t('linked_count', 'linked')}` : '' }
      ];
      host.innerHTML = `<div class="pp pp-home" data-settings-autosave="off">
        <header class="pp-list-head" style="position:static"><div class="pp-list-heading"><i class="fas ${kit.ICONS.group}" aria-hidden="true"></i><div><h2>${esc(t('people', 'People'))}</h2><p class="pp-list-sub">${loaded ? esc(kit.countPhrase([[counts.users, t('user_one', 'user'), t('user_many', 'users')]])) : ''}</p></div></div>${loaded && data.can.settings ? `<div class="pp-list-tools"><button type="button" class="pp-btn" data-home-wording${kit.tip(t('wording_tip', 'What your organization calls a group, its members, an outside company and a department'))}><i class="fas fa-spell-check" aria-hidden="true"></i><span class="pp-btn-label">${esc(t('wording', 'Wording'))}</span></button></div>` : ''}</header>
        <div class="pp-home-cards">${cards.map((card) => `<button type="button" class="pp-card${loaded ? '' : ' loading'}" data-home-card="${card.id}"><i class="fas ${card.icon} pp-card-icon" aria-hidden="true"></i><strong>${esc(card.title)}</strong><span class="pp-card-count"><b>${loaded ? Number(card.count || 0).toLocaleString() : '0'}</b><span>${esc(card.note)}</span></span><i class="fas fa-arrow-right pp-card-go" aria-hidden="true"></i></button>`).join('')}</div>
        ${attention.length ? `<section class="pp-attention" aria-label="${esc(t('needs_attention', 'Needs attention'))}"><h3>${esc(t('needs_attention', 'Needs attention'))}</h3>${attention.map((item) => `<button type="button" class="pp-attention-row" data-home-attention="${esc(item.id)}"><i class="fas ${esc(item.icon)}" aria-hidden="true"></i><b>${esc(Number(item.count).toLocaleString())}</b><span>${esc(item.text)}</span><i class="fas fa-chevron-right pp-attention-go" aria-hidden="true"></i></button>`).join('')}</section>` : ''}
      </div>`;
    }
    const onClick = (event) => {
      const card = event.target.closest('[data-home-card]');
      if (card) { context.go?.(card.dataset.homeCard); return; }
      const wording = event.target.closest('[data-home-wording]');
      if (wording) { People.lists.wording(wording); return; }
      const row = event.target.closest('[data-home-attention]');
      const item = row ? attention.find((entry) => entry.id === row.dataset.homeAttention) : null;
      if (!item) return;
      if (item.view === 'payroll') window.Portal?.navigation?.navigate?.({ tab:'payroll' }, { source:'people-home', ownedKeys:['tab'] });
      else context.go?.(item.view, '', item.filter);
    };
    host.addEventListener('click', onClick);
    const unsubscribe = data.subscribe(draw);
    const stopPresence = kit.presence.watch(data.orgId());
    const offPresence = kit.presence.onChange(draw);
    draw();
    /* Unresolved pay is a number payroll already reports; nothing is asked for when payroll is off or refuses. */
    const payroll = window.PayrollAPI?.pay?.unresolved || window.PayrollAPI?.pay?.listUnresolved;
    if (typeof payroll === 'function') Promise.resolve().then(() => payroll.call(window.PayrollAPI.pay, data.orgId())).then((result) => { const list = Array.isArray(result) ? result : result?.unresolved || result?.items || result?.earnings || []; unresolvedPay = Number(result?.count ?? list.length) || 0; draw(); }).catch(() => {});
    data.load().then(draw).catch((error) => { if (!destroyed && !data.state.loaded) host.innerHTML = `<div class="pp pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`; });
    return {
      refresh(){ data.load({ refresh:true }).then(draw).catch(() => {}); },
      destroy(){ destroyed = true; host.removeEventListener('click', onClick); unsubscribe(); offPresence(); stopPresence(); }
    };
  }

  People.peopleHome = { mount };
  People.views.register('home', mount);
})();
