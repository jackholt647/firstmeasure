(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const JOBS = {
    retail_replacement: { title: 'Replacements', singular: 'replacement', icon: 'fa-arrows-rotate' },
    insurance_restoration: { title: 'Insurance', singular: 'insurance restoration', icon: 'fa-shield-halved' },
    repair: { title: 'Repairs', singular: 'repair', icon: 'fa-screwdriver-wrench' },
    maintenance: { title: 'Maintenance', singular: 'maintenance', icon: 'fa-calendar-check' }
  };
  const METHODS = [
    { id: 'percent_contract', title: 'Percentage of contract', detail: 'A percentage of the final sold price.', icon: 'fa-percent' },
    { id: 'percent_profit', title: 'Percentage of gross profit', detail: 'A percentage after job costs are deducted.', icon: 'fa-chart-line' },
    { id: 'flat_job', title: 'Flat amount per job', detail: 'One fixed commission for this job type.', icon: 'fa-money-bill' },
    { id: 'custom_items', title: 'Custom line items', detail: 'Pay different amounts for specific products or parts of the sale.', icon: 'fa-list-check' }
  ];

  function addStylesheet() {
    if (document.getElementById('roofing-commissions-styles')) return;
    const link = document.createElement('link'); link.id = 'roofing-commissions-styles'; link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_commissions/page.css?v=20260810a'; document.head.appendChild(link);
  }
  function esc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  async function loadJobTypes(ctx) {
    try {
      const response = await fetch(`${ctx.apiBaseUrl}/test-orgs/${encodeURIComponent(ctx.instanceId)}/run-state`, { credentials: 'include' });
      const payload = await response.json(); const inputs = ((payload.instance || payload).test_org || {}).stage_inputs || {};
      for (const input of Object.values(inputs)) { const picked = ((input || {}).settings || {})['roofing_setup.job_types']; if (Array.isArray(picked) && picked.length) return picked.filter((id) => JOBS[id]); }
    } catch (error) { /* use a representative fallback */ }
    return ['retail_replacement', 'repair'];
  }

  function defaultConfig() { return { method: 'percent_contract', rate: 10, line_items: [{ name: 'Base commission', basis: 'percent', amount: 10 }], self_gen_enabled: false, self_gen_rate: 12 }; }

  window.SignupSandboxPages.spg_roofing_commissions = {
    render(container, ctx) {
      addStylesheet(); container.innerHTML = '<main class="rcm-page"><p class="rcm-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading your job types…</p></main>';
      loadJobTypes(ctx).then((jobTypes) => {
        const configs = Object.fromEntries(jobTypes.map((id) => [id, defaultConfig()]));
        const states = Object.fromEntries(jobTypes.map((id) => [id, { active: 0, maxSeen: 0 }]));
        const completed = new Set(); let activeJob = jobTypes[0]; let choosing = false;

        function amountHtml(config) {
          if (config.method === 'custom_items') return `<p class="rcm-help">Add the products, upgrades, or sale components that earn their own commission.</p><div class="rcm-line-items">${config.line_items.map((item, index) => `<div class="rcm-line-row"><input value="${esc(item.name)}" placeholder="Line-item name" data-line="${index}:name"><select data-line="${index}:basis"><option value="percent"${item.basis === 'percent' ? ' selected' : ''}>Percentage</option><option value="flat"${item.basis === 'flat' ? ' selected' : ''}>Flat amount</option></select><span>${item.basis === 'percent' ? '%' : '$'}</span><input type="number" min="0" value="${item.amount}" data-line="${index}:amount"><button type="button" data-line-remove="${index}" aria-label="Remove line item"><i class="fa-solid fa-xmark"></i></button></div>`).join('')}<button class="rcm-add" type="button" data-line-add><i class="fa-solid fa-plus"></i> Add commission line item</button></div>`;
          const percent = config.method !== 'flat_job';
          return `<p class="rcm-help">Set the default ${percent ? 'rate' : 'amount'} for ${JOBS[activeJob].singular} jobs.</p><label class="rcm-amount"><span>${percent ? 'Commission rate' : 'Commission amount'}</span><span class="rcm-input-prefix"><i>${percent ? '%' : '$'}</i><input type="number" min="0" step="0.25" value="${config.rate}" data-rate></span></label>`;
        }

        function guidedHtml() {
          const config = configs[activeJob]; const state = states[activeJob];
          const labels = ['Commission method', config.method === 'custom_items' ? 'Commission line items' : 'Rate or amount', 'Advanced'];
          const rail = labels.map((label, index) => `<button class="rcm-step-link${index === state.active ? ' is-active' : index <= state.maxSeen ? ' is-complete' : ''}" type="button" data-edit-step="${index}"${index > state.maxSeen ? ' hidden' : ''}><span class="rcm-step-marker">${index !== state.active && index <= state.maxSeen ? '<i class="fa-solid fa-check"></i>' : index + 1}</span><span><strong>${label}</strong><small>${index === state.active ? 'Current step' : 'Completed'}</small></span></button>`).join('');
          let body = '';
          if (state.active === 0) body = `<div class="rcm-step-count">${JOBS[activeJob].title} · 1 of 3</div><h2>How do you calculate commission for ${JOBS[activeJob].singular} jobs?</h2><p class="rcm-help">Choose the base structure. You can add exceptions afterward.</p><div class="rcm-method-grid">${METHODS.map((method) => `<button class="rcm-method${config.method === method.id ? ' selected' : ''}" type="button" data-method="${method.id}"><span><i class="fa-solid ${method.icon}"></i></span><strong>${method.title}</strong><small>${method.detail}</small><i class="rcm-radio"></i></button>`).join('')}</div>`;
          if (state.active === 1) body = `<div class="rcm-step-count">${JOBS[activeJob].title} · 2 of 3</div><h2>${config.method === 'custom_items' ? 'Which line items earn commission?' : 'What rate or amount do you pay?'}</h2>${amountHtml(config)}`;
          if (state.active === 2) body = `<div class="rcm-step-count">${JOBS[activeJob].title} · 3 of 3 · optional</div><h2>Any advanced commission rules?</h2><p class="rcm-help">Keep the base plan simple unless this job type needs an exception.</p><button class="rcm-toggle${config.self_gen_enabled ? ' on' : ''}" type="button" data-self-gen><span><strong>Higher commission for self-generated leads</strong><small>Use a different rate when the salesperson brought in the lead.</small></span><i></i></button>${config.self_gen_enabled ? `<label class="rcm-amount"><span>Self-generated ${config.method === 'flat_job' ? 'amount' : 'rate'}</span><span class="rcm-input-prefix"><i>${config.method === 'flat_job' ? '$' : '%'}</i><input type="number" min="0" step="0.25" value="${config.self_gen_rate}" data-self-rate></span></label>` : ''}`;
          const last = state.active === 2;
          body += `<div class="rcm-step-nav"><button class="rcm-back" type="button" data-back>Back</button><span>${last ? '<button class="rcm-skip" type="button" data-finish-job>Skip advanced</button>' : ''}<button class="rcm-continue" type="button" ${last ? 'data-finish-job' : 'data-next'}>${last ? 'Finish this job type' : 'Next'} <i class="fa-solid fa-arrow-right"></i></button></span></div>`;
          return `<div class="rcm-flow"><nav class="rcm-step-list" aria-label="Commission setup steps">${rail}</nav><section class="rcm-question-stage">${body}</section></div>`;
        }

        function chooserHtml() {
          const copies = jobTypes.filter((id) => completed.has(id) && id !== activeJob).map((id) => `<button class="rcm-choice" type="button" data-copy="${id}"><i class="fa-solid fa-copy"></i><span><strong>Same as ${JOBS[id].title}</strong><small>Copy that plan, then review Advanced.</small></span></button>`).join('');
          return `<div class="rcm-chooser"><button class="rcm-choice rcm-choice-primary" type="button" data-start><i class="fa-solid fa-sliders"></i><span><strong>Set up ${JOBS[activeJob].title.toLowerCase()}</strong><small>Choose the method, amount, and any advanced rules.</small></span></button>${copies}</div><div class="rcm-chooser-nav"><button class="rcm-back" type="button" data-workflow-back>Back</button></div>`;
        }

        function render() {
          const index = jobTypes.indexOf(activeJob);
          container.innerHTML = `<main class="rcm-page"><div class="rcm-kicker">Commissions · ${index + 1} of ${jobTypes.length}</div><h1>How do you pay commissions for ${JOBS[activeJob].singular} jobs?</h1><p class="rcm-lead">Set this job type on its own, or copy a completed commission plan.</p>${choosing ? chooserHtml() : guidedHtml()}${completed.size ? `<p class="rcm-progress">${completed.size} of ${jobTypes.length} job types completed.</p>` : ''}</main>`;
          wire();
        }

        function finishJob() {
          completed.add(activeJob); const next = jobTypes.find((id) => !completed.has(id));
          if (next) { activeJob = next; choosing = true; render(); return; }
          ctx.complete({ settings: { 'roofing_setup.commissions': configs } });
        }

        function wire() {
          const page = container.querySelector('.rcm-page');
          page.addEventListener('click', (event) => {
            if (event.target.closest('[data-start]')) { choosing = false; render(); return; }
            const copy = event.target.closest('[data-copy]'); if (copy) { configs[activeJob] = JSON.parse(JSON.stringify(configs[copy.dataset.copy])); states[activeJob] = { active: 2, maxSeen: 2 }; choosing = false; render(); return; }
            const method = event.target.closest('[data-method]'); if (method) { configs[activeJob].method = method.dataset.method; render(); return; }
            const edit = event.target.closest('[data-edit-step]'); if (edit) { states[activeJob].active = Number(edit.dataset.editStep); render(); return; }
            if (event.target.closest('[data-back]')) { const state = states[activeJob]; if (state.active === 0) { choosing = completed.size > 0; if (choosing) render(); else ctx.back(); } else { state.active--; render(); } return; }
            if (event.target.closest('[data-workflow-back]')) { const index = jobTypes.indexOf(activeJob); if (index === 0) ctx.back(); else { activeJob = jobTypes[index - 1]; choosing = false; render(); } return; }
            if (event.target.closest('[data-next]')) { const state = states[activeJob]; state.active++; state.maxSeen = Math.max(state.maxSeen, state.active); render(); return; }
            if (event.target.closest('[data-finish-job]')) { finishJob(); return; }
            if (event.target.closest('[data-self-gen]')) { configs[activeJob].self_gen_enabled = !configs[activeJob].self_gen_enabled; render(); return; }
            if (event.target.closest('[data-line-add]')) { configs[activeJob].line_items.push({ name: '', basis: 'percent', amount: 0 }); render(); return; }
            const remove = event.target.closest('[data-line-remove]'); if (remove) { configs[activeJob].line_items.splice(Number(remove.dataset.lineRemove), 1); render(); }
          });
          page.addEventListener('change', (event) => {
            const target = event.target; const config = configs[activeJob];
            if (target.matches('[data-rate]')) { config.rate = Number(target.value) || 0; return; }
            if (target.matches('[data-self-rate]')) { config.self_gen_rate = Number(target.value) || 0; return; }
            if (target.matches('[data-line]')) { const [index, field] = target.dataset.line.split(':'); config.line_items[Number(index)][field] = field === 'amount' ? Number(target.value) || 0 : target.value; if (field === 'basis') render(); }
          });
        }

        render();
      });
    }
  };
})();
