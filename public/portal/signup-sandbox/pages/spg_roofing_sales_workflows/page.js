(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const SMS_TIP = 'Requires SMS add-on';
  const SMS_BADGE = `<span class="rsw-addon" data-tip="${SMS_TIP}"><i class="fa-solid fa-comment-sms"></i> SMS add-on</span>`;

  const JOB_TYPE_META = {
    retail_replacement: { title: 'Replacements', long: 'full replacement', processTitle: 'roof replacement', icon: 'fa-arrows-rotate' },
    insurance_restoration: { title: 'Insurance', long: 'insurance restoration', processTitle: 'insurance restoration', icon: 'fa-shield-halved' },
    repair: { title: 'Repairs', long: 'repair', processTitle: 'repair', icon: 'fa-screwdriver-wrench' },
    maintenance: { title: 'Maintenance', long: 'maintenance', processTitle: 'maintenance', icon: 'fa-calendar-check' }
  };

  const ACTION_OPTIONS = {
    default: [
      { id: 'phone_estimate', title: 'Give an estimate over the phone', icon: 'fa-phone' },
      { id: 'estimator_appointment', title: 'Schedule an appointment for an estimator', icon: 'fa-calendar-plus' },
      { id: 'technician_visit', title: 'Send a technician out', icon: 'fa-truck-pickup' }
    ],
    maintenance: [
      { id: 'book_service', title: 'Book the service directly', icon: 'fa-calendar-plus' },
      { id: 'phone_estimate', title: 'Quote the plan over the phone first', icon: 'fa-phone' },
      { id: 'technician_visit', title: 'Send a technician for a first inspection', icon: 'fa-truck-pickup' }
    ]
  };

  const BID_OPTIONS = {
    default: [
      { id: 'initial', title: 'On the initial appointment' },
      { id: 'after', title: 'After the appointment (send it over)' },
      { id: 'follow_up_appointment', title: 'At a follow-up appointment' }
    ],
    insurance_restoration: [
      { id: 'after_approval', title: 'After the claim is approved' },
      { id: 'initial', title: 'On the initial inspection' },
      { id: 'follow_up_appointment', title: 'At a follow-up appointment' }
    ]
  };

  const PROPOSAL_TEMPLATES = {
    retail_replacement: [
      { id: 'good_better_best', title: 'Good, Better, Best', description: 'Three roof-system options with scope, warranty, signatures, and payments.', icon: 'fa-file-signature', recommended: true },
      { id: 'replacement_standard', title: 'Standard replacement agreement', description: 'One selected roof system in a concise contract.', icon: 'fa-house' },
      { id: 'replacement_financing', title: 'Financing-ready proposal', description: 'Replacement scope with payment and financing selections.', icon: 'fa-credit-card' }
    ],
    insurance_restoration: [
      { id: 'insurance_packet', title: 'Insurance restoration packet', description: 'Claim scope, supplements, deductible, and signatures.', icon: 'fa-shield-halved', recommended: true },
      { id: 'contingency_authorization', title: 'Contingency & authorization', description: 'A focused agreement for the claim-approval stage.', icon: 'fa-file-circle-check' },
      { id: 'insurance_scope', title: 'Insurance scope agreement', description: 'Carrier scope, supplements, upgrades, and customer approval.', icon: 'fa-list-check' }
    ],
    repair: [
      { id: 'repair_proposal', title: 'Roof repair authorization', description: 'Repair scope, photos, exclusions, price, and approval.', icon: 'fa-screwdriver-wrench', recommended: true },
      { id: 'repair_time_materials', title: 'Time & materials repair', description: 'Labor, materials, limits, and change authorization.', icon: 'fa-clock' },
      { id: 'repair_warranty', title: 'Repair with warranty', description: 'A repair agreement with explicit warranty coverage.', icon: 'fa-certificate' }
    ],
    maintenance: [
      { id: 'maintenance_agreement', title: 'Roof maintenance agreement', description: 'Visit frequency, included services, renewal terms, and approval.', icon: 'fa-calendar-check', recommended: true },
      { id: 'inspection_service', title: 'Inspection & service plan', description: 'Recurring inspections with defined minor service work.', icon: 'fa-clipboard-check' },
      { id: 'commercial_maintenance', title: 'Commercial maintenance plan', description: 'Scheduled service, reporting, and renewal terms.', icon: 'fa-building' }
    ]
  };

  const FOLLOW_UP_METHODS = [
    { id: 'call', title: 'Call', sms: false },
    { id: 'sms', title: 'Text', sms: true },
    { id: 'voicemail', title: 'Voicemail drop', sms: false },
    { id: 'email', title: 'Email', sms: false }
  ];

  const WAITS = [
    { id: '0d', title: 'Same day' },
    { id: '1d', title: '+1 day' },
    { id: '2d', title: '+2 days' },
    { id: '3d', title: '+3 days' },
    { id: '7d', title: '+1 week' },
    { id: '14d', title: '+2 weeks' }
  ];

  const TRIGGERS = [
    { id: 'on_signed', title: 'When the contract is signed' },
    { id: 'on_start', title: 'When work starts' },
    { id: 'on_delivery', title: 'On material delivery' },
    { id: 'on_completion', title: 'On completion' },
    { id: 'as_approved', title: 'As approved (supplements)' },
    { id: 'net_30', title: 'Net 30 invoice' }
  ];

  function defaultConfig(jobType) {
    const base = {
      first_contact_action: 'estimator_appointment',
      follow_up: [
        { method: 'call', wait: '0d' },
        { method: 'sms', wait: '0d' },
        { method: 'call', wait: '1d' },
        { method: 'email', wait: '2d' },
        { method: 'call', wait: '7d' }
      ],
      bid_timing: 'initial',
      checklist: [],
      payment_terms: { rows: [] },
      proposal: { mode: null, template: null, uploaded_file: null }
    };
    if (jobType === 'retail_replacement') {
      base.checklist = ['En route — send "on my way" text', 'Arrive & introduction', 'Roof inspection + photos', 'Discovery — what the homeowner wants', 'Company story', 'Build & present the bid', 'Ask for the business', 'Close, or schedule the follow-up', 'Finish — log disposition'];
      base.payment_terms.rows = [
        { label: 'Deposit', trigger: 'on_signed', type: 'percent', value: 10 },
        { label: 'Progress payment', trigger: 'on_delivery', type: 'percent', value: 40 },
        { label: 'Final payment', trigger: 'on_completion', type: 'remainder', value: null }
      ];
    } else if (jobType === 'insurance_restoration') {
      base.bid_timing = 'after_approval';
      base.contingency_agreement = true;
      base.checklist = ['En route — send "on my way" text', 'Arrive & introduction', 'Document storm damage — photos', 'Walk the homeowner through the claim process', 'Sign contingency agreement', 'Help file the claim / schedule adjuster meeting', 'Finish — log disposition'];
      base.payment_terms.rows = [
        { label: 'Deductible', trigger: 'on_signed', type: 'amount', value: null },
        { label: 'ACV check', trigger: 'on_start', type: 'remainder', value: null },
        { label: 'Supplements', trigger: 'as_approved', type: 'remainder', value: null },
        { label: 'Depreciation / final', trigger: 'on_completion', type: 'remainder', value: null }
      ];
    } else if (jobType === 'repair') {
      base.first_contact_action = 'technician_visit';
      base.checklist = ['En route — send "on my way" text', 'Arrive & introduction', 'Diagnose the issue', 'Quote on the spot', 'Complete the repair if approved', 'Collect payment', 'Finish — log disposition'];
      base.payment_terms.rows = [
        { label: 'Paid in full', trigger: 'on_completion', type: 'remainder', value: null }
      ];
    } else if (jobType === 'maintenance') {
      base.first_contact_action = 'book_service';
      base.billing = 'per_visit';
      base.checklist = ['En route — send "on my way" text', 'Arrive', 'Run the inspection checklist', 'Photo report for the customer', 'Flag any issues found', 'Finish — log visit'];
      base.payment_terms.rows = [];
    }
    return base;
  }

  function addStylesheet() {
    if (document.getElementById('roofing-sales-workflows-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-sales-workflows-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_sales_workflows/page.css?v=20260810c';
    document.head.appendChild(link);
  }

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function loadJobTypes(ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/test-orgs/${encodeURIComponent(ctx.instanceId)}/run-state`, { credentials: 'include' });
      const payload = await res.json();
      const inputs = ((payload.instance || payload).test_org || {}).stage_inputs || {};
      for (const input of Object.values(inputs)) {
        const settings = (input || {}).settings || {};
        const picked = settings['roofing_setup.job_types'];
        if (Array.isArray(picked) && picked.length) return picked.filter((id) => JOB_TYPE_META[id]);
      }
    } catch (error) { /* fall through to defaults */ }
    return ['retail_replacement', 'repair'];
  }

  window.SignupSandboxPages.spg_roofing_sales_workflows = {
    render(container, ctx) {
      addStylesheet();
      container.innerHTML = '<main class="rsw-page"><p class="rsw-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading your job types…</p></main>';

      loadJobTypes(ctx).then((jobTypes) => {
        const configs = {};
        const visited = new Set();
        const jobSteps = {};
        jobTypes.forEach((id) => { configs[id] = defaultConfig(id); jobSteps[id] = { active: 0, maxSeen: 0 }; });
        let activeTab = jobTypes[0];
        let micOpen = false;
        let guided = false;

        function workflowQuestionCount(jobType) {
          if (jobType === 'insurance_restoration') return 7;
          if (jobType === 'maintenance') return 5;
          return 6;
        }

        function radioCards(name, options, current) {
          return `<div class="rsw-cards">${options.map((o) => `<button class="rsw-card${current === o.id ? ' selected' : ''}" type="button" data-radio="${name}" data-value="${o.id}">${o.icon ? `<i class="fa-solid ${o.icon}"></i>` : ''}<span>${o.title}</span><span class="rsw-radio"></span></button>`).join('')}</div>`;
        }

        function pills(name, options, current) {
          return `<div class="rsw-pills">${options.map((o) => `<button class="rsw-pill${current === o.id ? ' selected' : ''}" type="button" data-radio="${name}" data-value="${o.id}">${o.title}</button>`).join('')}</div>`;
        }

        function followUpHtml(config) {
          const rows = config.follow_up.map((step, index) => {
            const method = FOLLOW_UP_METHODS.find((m) => m.id === step.method) || FOLLOW_UP_METHODS[0];
            return `<div class="rsw-row" data-fu-row="${index}">
              <span class="rsw-row-num">${index + 1}</span>
              <select class="rsw-select" data-fu-method="${index}">${FOLLOW_UP_METHODS.map((m) => `<option value="${m.id}"${m.id === step.method ? ' selected' : ''}>${m.title}</option>`).join('')}</select>
              <select class="rsw-select" data-fu-wait="${index}">${WAITS.map((w) => `<option value="${w.id}"${w.id === step.wait ? ' selected' : ''}>${w.title}</option>`).join('')}</select>
              ${method.sms ? SMS_BADGE : '<span></span>'}
              <button class="rsw-icon-btn" type="button" data-fu-remove="${index}" title="Remove step"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
          }).join('');
          return `<div class="rsw-editor">${rows}<button class="rsw-add" type="button" data-fu-add><i class="fa-solid fa-plus"></i> Add a follow-up step</button></div>`;
        }

        function checklistHtml(config) {
          const rows = config.checklist.map((step, index) => {
            const isSms = /text|sms/i.test(step);
            return `<div class="rsw-row rsw-check-row" data-cl-row="${index}">
              <span class="rsw-row-num">${index + 1}</span>
              <input class="rsw-input" type="text" value="${esc(step)}" data-cl-input="${index}">
              ${isSms ? SMS_BADGE : '<span></span>'}
              <span class="rsw-move">
                <button class="rsw-icon-btn" type="button" data-cl-up="${index}" title="Move up" ${index === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                <button class="rsw-icon-btn" type="button" data-cl-down="${index}" title="Move down" ${index === config.checklist.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
              </span>
              <button class="rsw-icon-btn" type="button" data-cl-remove="${index}" title="Remove step"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
          }).join('');
          return `<div class="rsw-editor">${rows}<button class="rsw-add" type="button" data-cl-add><i class="fa-solid fa-plus"></i> Add a checklist step</button></div>`;
        }

        function paymentHtml(jobType, config) {
          if (jobType === 'maintenance') {
            return pills('billing', [
              { id: 'per_visit', title: 'Bill per visit' },
              { id: 'monthly', title: 'Monthly plan' },
              { id: 'annual', title: 'Annual plan' }
            ], config.billing);
          }
          const rows = config.payment_terms.rows.map((row, index) => `<div class="rsw-row rsw-pay-row" data-pt-row="${index}">
            <input class="rsw-input" type="text" value="${esc(row.label)}" data-pt-label="${index}" placeholder="Payment name">
            <select class="rsw-select" data-pt-trigger="${index}">${TRIGGERS.map((t) => `<option value="${t.id}"${t.id === row.trigger ? ' selected' : ''}>${t.title}</option>`).join('')}</select>
            <select class="rsw-select rsw-select-sm" data-pt-type="${index}">
              <option value="percent"${row.type === 'percent' ? ' selected' : ''}>%</option>
              <option value="amount"${row.type === 'amount' ? ' selected' : ''}>$</option>
              <option value="remainder"${row.type === 'remainder' ? ' selected' : ''}>Balance</option>
            </select>
            <input class="rsw-input rsw-input-sm" type="number" min="0" value="${row.type === 'remainder' || row.value === null ? '' : row.value}" data-pt-value="${index}" ${row.type === 'remainder' ? 'disabled placeholder="—"' : ''}>
            <button class="rsw-icon-btn" type="button" data-pt-remove="${index}" title="Remove payment"><i class="fa-solid fa-xmark"></i></button>
          </div>`).join('');
          return `<div class="rsw-editor">${rows}<button class="rsw-add" type="button" data-pt-add><i class="fa-solid fa-plus"></i> Add a payment</button></div>`;
        }

        function proposalHtml(jobType, config) {
          const templates = PROPOSAL_TEMPLATES[jobType];
          const proposal = config.proposal || (config.proposal = { mode: null, template: null, uploaded_file: null });
          const templatePicker = proposal.mode === 'template' ? `<div class="rsw-template-picker"><div class="rsw-template-heading"><strong>Choose a template</strong><small>Start here and customize it later.</small></div><div class="rsw-template-grid">${templates.map((template) => `<button class="rsw-template-card${proposal.template === template.id ? ' selected' : ''}" type="button" data-proposal-template="${template.id}"><span class="rsw-template-icon"><i class="fa-solid ${template.icon}"></i></span><span><strong>${template.title}${template.recommended ? '<em>Recommended</em>' : ''}</strong><small>${template.description}</small></span><span class="rsw-radio"></span></button>`).join('')}</div></div>` : '';
          return `<div class="rsw-proposal-options">
            <button class="rsw-proposal-card${proposal.mode === 'template' ? ' selected' : ''}" type="button" data-proposal-mode="template"><span class="rsw-proposal-icon"><i class="fa-solid fa-file-signature"></i></span><span><strong>Use a template</strong><small>Choose from templates for this job type.</small></span><span class="rsw-radio"></span></button>
            <button class="rsw-proposal-card${proposal.mode === 'upload' ? ' selected' : ''}" type="button" data-proposal-mode="upload"><span class="rsw-proposal-icon"><i class="fa-solid fa-cloud-arrow-up"></i></span><span><strong>Upload your proposal</strong><small>${proposal.uploaded_file || 'PDF or Word document'}</small></span><span class="rsw-radio"></span></button>
            <button class="rsw-proposal-card${proposal.mode === 'none' ? ' selected' : ''}" type="button" data-proposal-mode="none"><span class="rsw-proposal-icon"><i class="fa-solid fa-ban"></i></span><span><strong>No contract</strong><small>Nothing is signed before work begins.</small></span><span class="rsw-radio"></span></button>
          </div>${templatePicker}${proposal.mode === 'upload' ? `<label class="rsw-proposal-upload"><i class="fa-solid fa-paperclip"></i><span>${proposal.uploaded_file ? `<strong>${esc(proposal.uploaded_file)}</strong> is ready to rebuild.` : 'Choose the proposal or contract you currently use'}</span><input type="file" accept=".pdf,.doc,.docx" data-proposal-file hidden></label>` : ''}`;
        }

        function tabBodyHtml(jobType) {
          const meta = JOB_TYPE_META[jobType];
          const config = configs[jobType];
          const actionOptions = ACTION_OPTIONS[jobType] || ACTION_OPTIONS.default;
          const bidOptions = BID_OPTIONS[jobType] || BID_OPTIONS.default;
          const blocks = [];
          blocks.push({ title: 'New lead', html: `<section class="rsw-block"><h2 class="rsw-q">When a new ${meta.long} lead comes in, what do you try to do?</h2>${radioCards('first_contact_action', actionOptions, config.first_contact_action)}</section>` });
          if (jobType === 'maintenance') {
            blocks.push({ title: 'Plan billing', html: `<section class="rsw-block"><h2 class="rsw-q">How do you bill maintenance plans?</h2>${paymentHtml(jobType, config)}</section>` });
          } else {
            blocks.push({ title: 'Bid presentation', html: `<section class="rsw-block"><h2 class="rsw-q">When do you present your bid?</h2>${pills('bid_timing', bidOptions, config.bid_timing)}</section>` });
          }
          if (jobType === 'insurance_restoration') {
            blocks.push({ title: 'Contingency agreement', html: `<section class="rsw-block"><h2 class="rsw-q">Do you sign a contingency agreement up front?</h2><p class="rsw-hint">The customer commits to using you if the claim is approved. The full contract comes later, after approval.</p>${pills('contingency_agreement', [{ id: 'yes', title: 'Yes — on the first appointment' }, { id: 'no', title: 'No' }], config.contingency_agreement ? 'yes' : 'no')}</section>` });
          }
          blocks.push({ title: 'No-answer follow-up', html: `<section class="rsw-block rsw-block-wide"><h2 class="rsw-q">If you can't reach them on the first call, what happens next?</h2><p class="rsw-hint">This becomes your automatic follow-up cycle. Steps run in order, spaced by the wait you set.</p>${followUpHtml(config)}</section>` });
          blocks.push({ title: jobType === 'maintenance' ? 'Service visit' : 'Appointment steps', html: `<section class="rsw-block rsw-block-wide"><h2 class="rsw-q">What steps do you follow on the ${jobType === 'maintenance' ? 'service visit' : 'initial appointment'}?</h2><p class="rsw-hint">We prefilled a sample — edit it to match how your team actually runs ${jobType === 'insurance_restoration' ? 'an inspection' : 'an appointment'}.</p>${checklistHtml(config)}</section>` });
          if (jobType !== 'maintenance') {
            blocks.push({ title: 'Payment schedule', html: `<section class="rsw-block rsw-block-wide"><h2 class="rsw-q">How do you get paid?</h2><p class="rsw-hint">Your payment schedule — each payment fires automatically at its trigger point.</p>${paymentHtml(jobType, config)}</section>` });
          }
          blocks.push({ title: 'Contract & proposal', required: true, html: `<section class="rsw-block rsw-block-wide"><h2 class="rsw-q">Do your customers sign a contract before work begins?</h2><p class="rsw-hint">Choose the document path for ${meta.long} jobs. We’ve recommended the template that best fits this kind of work.</p>${proposalHtml(jobType, config)}</section>` });
          const state = jobSteps[jobType];
          const activeBlock = blocks[state.active];
          const proposal = config.proposal || {};
          const canContinue = !activeBlock.required || (proposal.mode === 'upload' ? Boolean(proposal.uploaded_file) : proposal.mode === 'template' ? Boolean(proposal.template) : proposal.mode === 'none');
          return `<div class="rsw-guided-layout" data-question-count="${blocks.length}"><nav class="rsw-question-list" aria-label="Sales workflow steps">${blocks.slice(0, state.maxSeen + 1).map((block, index) => `<button class="rsw-step-link${index === state.active ? ' is-active' : ' is-complete'}" type="button" data-question-edit="${index}"${index === state.active ? ' aria-current="step"' : ''}><span class="rsw-step-marker">${index === state.active ? index + 1 : '<i class="fa-solid fa-check"></i>'}</span><span><strong>${block.title}</strong><small>${index === state.active ? 'Current step' : 'Completed'}</small></span></button>`).join('')}</nav><section class="rsw-question-stage"><div class="rsw-question-count">${JOB_TYPE_META[jobType].title} · ${state.active + 1} of ${blocks.length}</div>${activeBlock.html}<div class="rsw-question-actions"><button class="rsw-back" type="button" data-question-back>Back</button><span>${activeBlock.required ? '' : '<button class="rsw-skip" type="button" data-question-next>Skip</button>'}<button class="rsw-continue" type="button" data-question-next${canContinue ? '' : ' disabled'}>${state.active === blocks.length - 1 ? 'Finish this job type' : 'Next'} <i class="fa-solid fa-arrow-right"></i></button></span></div></section></div>`;
        }

        function render() {
          if (container.parentElement) container.parentElement.style.width = 'min(940px,100%)';
          const currentIndex = jobTypes.indexOf(activeTab);
          const doneCount = jobTypes.filter((id) => visited.has(id)).length;
          const copyOptions = jobTypes.filter((id) => visited.has(id) && id !== activeTab).map((id) => `<button class="rsw-method-card" type="button" data-copy-job="${id}"><i class="fa-solid fa-copy"></i><span><strong>Same as ${JOB_TYPE_META[id].title}</strong><small>Copy that completed process.</small></span></button>`).join('');
          const methodChoice = `<section class="rsw-method rsw-method-simple"><div class="rsw-method-grid${copyOptions ? ' has-copy' : ''}"><button class="rsw-method-card" type="button" data-guided><i class="fa-solid fa-list-check"></i><span><strong>Walk me through it</strong><small>Answer one focused question at a time.</small></span></button><button class="rsw-method-card rsw-method-card-primary" type="button" data-verbal><i class="fa-solid fa-microphone"></i><span><strong>Describe my process</strong><small>Talk naturally and let the setup agent structure it.</small></span></button>${copyOptions}</div><div class="rsw-question-actions"><button class="rsw-back" type="button" data-workflow-back>Back</button></div></section>`;
          const verbalChoice = `<section class="rsw-method"><div class="rsw-question-count">${JOB_TYPE_META[activeTab].title} · describe it your way</div><h2>Talk us through your sales process</h2><p>Start with the new lead and finish with payment. We’ll ask only about anything you leave out.</p><button class="rsw-record" type="button"><i class="fa-solid fa-microphone"></i><strong>Start recording</strong><small>Or type below</small></button><textarea class="rsw-description" placeholder="For a new ${JOB_TYPE_META[activeTab].long} lead, we first…"></textarea><div class="rsw-question-actions"><button class="rsw-back" type="button" data-method-back>Back</button><button class="rsw-continue" type="button" data-job-finish>Use this process <i class="fa-solid fa-arrow-right"></i></button></div></section>`;
          container.innerHTML = `
            <main class="rsw-page">
              <div class="rsw-kicker">Sales process · ${currentIndex + 1} of ${jobTypes.length}</div>
              <h1>Let’s figure out your ${JOB_TYPE_META[activeTab].processTitle} sales process.</h1>
              <p class="rsw-lead">${!guided && !micOpen ? 'Choose the easiest way to explain it.' : 'We’ll keep this focused and work through one step at a time.'}</p>
              <div class="rsw-body" id="rswBody">${guided ? tabBodyHtml(activeTab) : micOpen ? verbalChoice : methodChoice}</div>
              <div class="rsw-summary">${doneCount ? `${doneCount} of ${jobTypes.length} job types completed.` : ''}</div>
            </main>`;
          wire();
        }

        function rerenderBody() {
          container.querySelector('#rswBody').innerHTML = tabBodyHtml(activeTab);
        }

        function finishJob() {
          visited.add(activeTab);
          const next = jobTypes.find((id) => !visited.has(id));
          if (next) { activeTab = next; guided = false; micOpen = false; render(); return; }
          ctx.complete({ settings: { 'roofing_setup.sales_workflows': configs } });
        }

        function wire() {
          const page = container.querySelector('.rsw-page');
          page.addEventListener('click', (event) => {
            if (event.target.closest('[data-guided]')) { guided = true; micOpen = false; render(); return; }
            if (event.target.closest('[data-verbal]')) { micOpen = true; guided = false; render(); return; }
            if (event.target.closest('[data-method-back]')) { micOpen = false; render(); return; }
            if (event.target.closest('[data-job-finish]')) { finishJob(); return; }
            if (event.target.closest('[data-workflow-back]')) { const index = jobTypes.indexOf(activeTab); if (index === 0) ctx.back(); else { activeTab = jobTypes[index - 1]; guided = false; micOpen = false; render(); } return; }
            const copyJob = event.target.closest('[data-copy-job]');
            if (copyJob) {
              configs[activeTab] = JSON.parse(JSON.stringify(configs[copyJob.dataset.copyJob]));
              configs[activeTab].proposal = { mode: null, template: null, uploaded_file: null };
              const count = workflowQuestionCount(activeTab);
              jobSteps[activeTab] = { active: count - 1, maxSeen: count - 1 };
              guided = true;
              micOpen = false;
              render();
              return;
            }
            const questionEdit = event.target.closest('[data-question-edit]');
            if (questionEdit) { jobSteps[activeTab].active = Number(questionEdit.dataset.questionEdit); rerenderBody(); return; }
            if (event.target.closest('[data-question-back]')) { if (jobSteps[activeTab].active === 0) { guided = false; render(); } else { jobSteps[activeTab].active--; rerenderBody(); } return; }
            if (event.target.closest('[data-question-next]')) { const count = Number(container.querySelector('.rsw-guided-layout').dataset.questionCount); const state = jobSteps[activeTab]; if (state.active < count - 1) { state.active++; state.maxSeen = Math.max(state.maxSeen, state.active); rerenderBody(); } else finishJob(); return; }

            const config = configs[activeTab];
            const proposalMode = event.target.closest('[data-proposal-mode]');
            if (proposalMode) {
              const mode = proposalMode.dataset.proposalMode;
              config.proposal = config.proposal || { mode: null, template: null, uploaded_file: null };
              config.proposal.mode = mode;
              if (mode !== 'template') config.proposal.template = null;
              if (mode !== 'upload') config.proposal.uploaded_file = null;
              rerenderBody();
              return;
            }
            const proposalTemplate = event.target.closest('[data-proposal-template]');
            if (proposalTemplate) {
              config.proposal.template = proposalTemplate.dataset.proposalTemplate;
              rerenderBody();
              return;
            }
            const radio = event.target.closest('[data-radio]');
            if (radio) {
              const name = radio.dataset.radio;
              const value = radio.dataset.value;
              if (name === 'contingency_agreement') config.contingency_agreement = value === 'yes';
              else config[name] = value;
              rerenderBody();
              return;
            }
            if (event.target.closest('[data-fu-add]')) { config.follow_up.push({ method: 'call', wait: '2d' }); rerenderBody(); return; }
            const fuRemove = event.target.closest('[data-fu-remove]');
            if (fuRemove) { config.follow_up.splice(Number(fuRemove.dataset.fuRemove), 1); rerenderBody(); return; }
            if (event.target.closest('[data-cl-add]')) { config.checklist.push('New step'); rerenderBody(); return; }
            const clRemove = event.target.closest('[data-cl-remove]');
            if (clRemove) { config.checklist.splice(Number(clRemove.dataset.clRemove), 1); rerenderBody(); return; }
            const clUp = event.target.closest('[data-cl-up]');
            if (clUp) {
              const i = Number(clUp.dataset.clUp);
              if (i > 0) { const [step] = config.checklist.splice(i, 1); config.checklist.splice(i - 1, 0, step); rerenderBody(); }
              return;
            }
            const clDown = event.target.closest('[data-cl-down]');
            if (clDown) {
              const i = Number(clDown.dataset.clDown);
              if (i < config.checklist.length - 1) { const [step] = config.checklist.splice(i, 1); config.checklist.splice(i + 1, 0, step); rerenderBody(); }
              return;
            }
            if (event.target.closest('[data-pt-add]')) { config.payment_terms.rows.push({ label: 'Payment', trigger: 'on_completion', type: 'percent', value: 0 }); rerenderBody(); return; }
            const ptRemove = event.target.closest('[data-pt-remove]');
            if (ptRemove) { config.payment_terms.rows.splice(Number(ptRemove.dataset.ptRemove), 1); rerenderBody(); return; }
          });

          page.addEventListener('change', (event) => {
            const config = configs[activeTab];
            const target = event.target;
            if (target.matches('.rsw-description')) { config.verbal_description = target.value.trim(); return; }
            if (target.matches('[data-proposal-file]')) { config.proposal.uploaded_file = target.files.length ? target.files[0].name : null; rerenderBody(); return; }
            if (target.matches('[data-fu-method]')) { config.follow_up[Number(target.dataset.fuMethod)].method = target.value; rerenderBody(); return; }
            if (target.matches('[data-fu-wait]')) { config.follow_up[Number(target.dataset.fuWait)].wait = target.value; return; }
            if (target.matches('[data-pt-trigger]')) { config.payment_terms.rows[Number(target.dataset.ptTrigger)].trigger = target.value; return; }
            if (target.matches('[data-pt-type]')) {
              const row = config.payment_terms.rows[Number(target.dataset.ptType)];
              row.type = target.value;
              if (row.type === 'remainder') row.value = null;
              rerenderBody();
              return;
            }
            if (target.matches('[data-pt-value]')) { config.payment_terms.rows[Number(target.dataset.ptValue)].value = target.value === '' ? null : Number(target.value); return; }
            if (target.matches('[data-pt-label]')) { config.payment_terms.rows[Number(target.dataset.ptLabel)].label = target.value; return; }
            if (target.matches('[data-cl-input]')) { config.checklist[Number(target.dataset.clInput)] = target.value; return; }
          });

        }

        render();
      });
    }
  };
})();
