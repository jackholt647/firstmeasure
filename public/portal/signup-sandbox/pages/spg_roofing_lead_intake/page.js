(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const SOURCES = [
    { id: 'phone', title: 'Phone calls', icon: 'fa-phone' },
    { id: 'website', title: 'Our website', icon: 'fa-globe' },
    { id: 'email', title: 'Email', icon: 'fa-envelope' },
    { id: 'canvassing', title: 'Canvassing', icon: 'fa-person-walking' },
    { id: 'referrals', title: 'Referrals', icon: 'fa-people-arrows' },
    { id: 'storm', title: 'Storm / insurance', icon: 'fa-cloud-bolt' },
    { id: 'home_shows', title: 'Home shows', icon: 'fa-store' },
    { id: 'other', title: 'Other', icon: 'fa-ellipsis' }
  ];
  const CONTACT_METHODS = [
    { id: 'phone', title: 'Call them', description: 'A person picks up the phone and dials the new lead.', icon: 'fa-phone' },
    { id: 'sms', title: 'Text them', description: 'Send a quick text first, then call.', icon: 'fa-comment-sms', sms: true },
    { id: 'email', title: 'Email them', description: 'Send an intro email with a booking link.', icon: 'fa-envelope-open-text' }
  ];
  const WEB_FORMS = [
    { id: 'contact_form', title: 'Contact form', description: 'A simple name, contact information, and message form.', icon: 'fa-address-card', preview: ['Name', 'Phone or email', 'How can we help?'] },
    { id: 'appointment_form', title: 'Book an estimate', description: 'Let homeowners request an available estimate appointment.', icon: 'fa-calendar-check', preview: ['Project address', 'Service needed', 'Preferred time'] },
    { id: 'instant_estimate', title: 'Instant estimator', description: 'Collect project details and show a preliminary price range.', icon: 'fa-calculator', preview: ['Project type', 'Approximate size', 'Your estimate'] }
  ];

  function addStylesheet() {
    if (document.getElementById('roofing-lead-intake-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-lead-intake-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_lead_intake/page.css?v=20260810c';
    document.head.appendChild(link);
  }

  function addressSlug(name) {
    return String(name || 'yourcompany').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'yourcompany';
  }

  window.SignupSandboxPages.spg_roofing_lead_intake = {
    render(container, ctx) {
      addStylesheet();
      const sources = new Set(['phone', 'website', 'referrals']);
      let firstContact = 'phone';
      let websiteForm = null;
      let importEmail = 'leads-yourcompany@firstmatemail.com';
      let activeStep = 0;
      let maxSeen = 0;

      container.innerHTML = `
        <main class="rl-page">
          <header><div class="rl-kicker">Leads <span id="rlProgress">1 of 4</span></div><h1>Set up your lead intake</h1><p class="rl-lead">We’ll handle one part at a time so every new lead reaches the right place.</p></header>
          <div class="rl-flow">
            <nav class="rl-step-list" aria-label="Lead intake steps"><button class="rl-step-link" type="button" data-edit-step="0"><span class="rl-step-marker">1</span><span><strong>Lead sources</strong><small id="rlSourceSummary">Current step</small></span></button><button class="rl-step-link" type="button" data-edit-step="1"><span class="rl-step-marker">2</span><span><strong>First response</strong><small id="rlContactSummary">Not answered</small></span></button><button class="rl-step-link" type="button" data-edit-step="2"><span class="rl-step-marker">3</span><span><strong>Lead import email</strong><small>Ready</small></span></button><button class="rl-step-link" type="button" data-edit-step="3"><span class="rl-step-marker">4</span><span><strong>Website lead form</strong><small>Optional</small></span></button></nav>
            <div class="rl-question-stage">
            <section class="rl-step" data-step="0"><div class="rl-step-body"><div class="rl-step-count">Leads · 1 of 4</div><h2 class="rl-section">Where do your leads come from?</h2><p class="rl-question-help">Choose every source you use today.</p><div class="rl-chips" id="rlSources"></div><div class="rl-step-nav"><button class="rl-back" type="button" data-step-back>Back</button><button class="rl-continue" type="button" data-step-next>Next <i class="fa-solid fa-arrow-right"></i></button></div></div></section>
            <section class="rl-step" data-step="1"><div class="rl-step-body"><div class="rl-step-count">Leads · 2 of 4</div><h2 class="rl-section">How do you first reach out to a new lead?</h2><div class="rl-options" id="rlContact"></div><div class="rl-step-nav"><button class="rl-back" type="button" data-step-back>Back</button><button class="rl-continue" type="button" data-step-next>Next <i class="fa-solid fa-arrow-right"></i></button></div></div></section>
            <section class="rl-step" data-step="2"><div class="rl-step-body"><div class="rl-step-count">Leads · 3 of 4</div><h2 class="rl-section">Here’s your lead import email</h2><p class="rl-question-help">Forward lead emails here—or give this address directly to a lead provider—and FirstMate will automatically create the lead for you.</p><div class="rl-inbox-card"><span class="rl-inbox-icon"><i class="fa-solid fa-inbox"></i></span><div><small>Your private lead inbox</small><strong id="rlImportEmail">${importEmail}</strong></div><button type="button" data-copy-email title="Copy email address"><i class="fa-regular fa-copy"></i><span>Copy</span></button></div><p class="rl-setting-note"><i class="fa-solid fa-circle-info"></i> This inbox is already active. There’s nothing to turn on.</p><div class="rl-step-nav"><button class="rl-back" type="button" data-step-back>Back</button><button class="rl-continue" type="button" data-step-next>Next <i class="fa-solid fa-arrow-right"></i></button></div></div></section>
            <section class="rl-step" data-step="3"><div class="rl-step-body"><div class="rl-step-count">Leads · 4 of 4 · optional</div><h2 class="rl-section">Would you like a lead form for your website?</h2><p class="rl-question-help">Choose one to prepare its embed code. Submissions will flow directly into FirstMate.</p><div class="rl-form-grid" id="rlWebsiteForms"></div><aside class="rl-web-upsell"><i class="fa-solid fa-wand-magic-sparkles"></i><div><strong>Want it integrated automatically?</strong><small>Build your website with FirstMate and we’ll connect your forms, branding, and lead tracking for you.</small></div><span>FirstMate Websites</span></aside><p class="rl-setting-note"><i class="fa-solid fa-gear"></i> You can always find every form and embed link later in Settings.</p><div class="rl-step-nav"><button class="rl-back" type="button" data-step-back>Back</button><span><button class="rl-skip" type="button" data-step-skip>Skip for now</button><button class="rl-continue" type="button" data-finish disabled>Use this form <i class="fa-solid fa-arrow-right"></i></button></span></div></div></section>
            </div>
          </div>
        </main>`;

      const sourcesEl = container.querySelector('#rlSources');
      const contactEl = container.querySelector('#rlContact');
      const formsEl = container.querySelector('#rlWebsiteForms');
      const finishButton = container.querySelector('[data-finish]');

      function refresh() {
        sourcesEl.innerHTML = SOURCES.map((item) => `<button class="rl-chip${sources.has(item.id) ? ' selected' : ''}" type="button" data-source="${item.id}" aria-pressed="${sources.has(item.id)}"><i class="fa-solid ${item.icon}"></i>${item.title}</button>`).join('');
        contactEl.innerHTML = CONTACT_METHODS.map((item) => `<button class="rl-option${firstContact === item.id ? ' selected' : ''}" type="button" data-contact="${item.id}" aria-pressed="${firstContact === item.id}"><span class="rl-icon"><i class="fa-solid ${item.icon}"></i></span><span class="rl-copy"><strong>${item.title}${item.sms ? '<span class="rl-addon" data-tip="Requires SMS add-on"><i class="fa-solid fa-comment-sms"></i> SMS add-on</span>' : ''}</strong><small>${item.description}</small></span><span class="rl-radio"></span></button>`).join('');
        formsEl.innerHTML = WEB_FORMS.map((item) => `<button class="rl-form-card${websiteForm === item.id ? ' selected' : ''}" type="button" data-website-form="${item.id}" aria-pressed="${websiteForm === item.id}"><span class="rl-form-icon"><i class="fa-solid ${item.icon}"></i></span><strong>${item.title}</strong><small>${item.description}</small><span class="rl-mini-form">${item.preview.map((field) => `<i>${field}</i>`).join('')}</span><span class="rl-form-check"><i class="fa-solid fa-check"></i></span></button>`).join('');
        container.querySelector('#rlProgress').textContent = `${activeStep + 1} of 4`;
        container.querySelector('#rlSourceSummary').textContent = activeStep === 0 ? 'Current step' : `${sources.size} selected`;
        container.querySelector('#rlContactSummary').textContent = activeStep === 1 ? 'Current step' : (CONTACT_METHODS.find((item) => item.id === firstContact) || {}).title || '';
        finishButton.disabled = !websiteForm;
        container.querySelectorAll('.rl-step-link').forEach((link, index) => { link.hidden = index > maxSeen; link.classList.toggle('is-active', index === activeStep); link.classList.toggle('is-complete', index !== activeStep && index <= maxSeen); link.querySelector('.rl-step-marker').innerHTML = index < activeStep || (index < maxSeen && index !== activeStep) ? '<i class="fa-solid fa-check"></i>' : String(index + 1); });
        container.querySelectorAll('.rl-step').forEach((step, index) => { step.classList.toggle('is-active', index === activeStep); step.classList.toggle('is-future', index !== activeStep); });
      }

      function complete() {
        ctx.complete({ settings: { 'roofing_setup.lead_intake': {
          sources: SOURCES.filter((item) => sources.has(item.id)).map((item) => item.id),
          first_contact: firstContact,
          lead_inbox: true,
          lead_import_email: importEmail,
          web_form: Boolean(websiteForm),
          website_form_type: websiteForm,
          website_forms: websiteForm ? [websiteForm] : []
        } } });
      }

      container.addEventListener('click', (event) => {
        const source = event.target.closest('[data-source]'); if (source) { sources.has(source.dataset.source) ? sources.delete(source.dataset.source) : sources.add(source.dataset.source); refresh(); return; }
        const contact = event.target.closest('[data-contact]'); if (contact) { firstContact = contact.dataset.contact; refresh(); return; }
        const form = event.target.closest('[data-website-form]'); if (form) { websiteForm = form.dataset.websiteForm; refresh(); return; }
        const edit = event.target.closest('[data-edit-step]'); if (edit) { activeStep = Number(edit.dataset.editStep); refresh(); return; }
        if (event.target.closest('[data-step-back]')) { if (activeStep === 0) ctx.back(); else { activeStep--; refresh(); } return; }
        if (event.target.closest('[data-step-next]')) { if (activeStep < 3) { activeStep++; maxSeen = Math.max(maxSeen, activeStep); refresh(); } return; }
        if (event.target.closest('[data-step-skip]')) { websiteForm = null; complete(); return; }
        if (event.target.closest('[data-finish]')) { complete(); return; }
        const copy = event.target.closest('[data-copy-email]'); if (copy) { navigator.clipboard?.writeText(importEmail); copy.innerHTML = '<i class="fa-solid fa-check"></i><span>Copied</span>'; }
      });

      fetch(`${ctx.apiBaseUrl}/test-orgs/${encodeURIComponent(ctx.instanceId)}/run-state`, { credentials: 'include' }).then((response) => response.json()).then((payload) => {
        const org = ((payload.instance || payload).test_org || {});
        importEmail = `leads-${addressSlug(org.org_name)}@firstmatemail.com`;
        const emailEl = container.querySelector('#rlImportEmail'); if (emailEl) emailEl.textContent = importEmail;
      }).catch(() => {});

      refresh();
    }
  };
})();
