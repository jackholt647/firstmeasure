(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const SERVICES = [
    { id: 'roofing', title: 'Roofing', icon: 'fa-house-chimney' },
    { id: 'siding', title: 'Siding', icon: 'fa-layer-group' },
    { id: 'gutters', title: 'Gutters', icon: 'fa-water' },
    { id: 'windows', title: 'Windows', icon: 'fa-window-restore' },
    { id: 'other_exterior', title: 'Other exterior', icon: 'fa-house-circle-check' }
  ];
  const JOB_TYPES = [
    { id: 'retail_replacement', title: 'Full replacements', description: 'Estimate, bid, contract, and install retail projects.', icon: 'fa-arrows-rotate' },
    { id: 'insurance_restoration', title: 'Insurance restoration', description: 'Storm claims, adjusters, supplements, and deductibles.', icon: 'fa-shield-halved' },
    { id: 'repair', title: 'Repairs', description: 'Smaller jobs a technician can finish quickly.', icon: 'fa-screwdriver-wrench' },
    { id: 'maintenance', title: 'Maintenance plans', description: 'Recurring inspections, tune-ups, and service agreements.', icon: 'fa-calendar-check' }
  ];
  const TEAM_SIZES = [
    { id: 'solo', title: 'Just me', detail: 'Owner-operator' },
    { id: '2_5', title: '2–5', detail: 'Small team' },
    { id: '6_15', title: '6–15', detail: 'Growing team' },
    { id: '16_50', title: '16–50', detail: 'Established team' },
    { id: '50_plus', title: '50+', detail: 'Large operation' }
  ];

  function addStylesheet() {
    if (document.getElementById('roofing-profile-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-profile-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_profile/page.css?v=20260810c';
    document.head.appendChild(link);
  }

  window.SignupSandboxPages.spg_roofing_profile = {
    render(container, ctx) {
      addStylesheet();
      const services = new Set();
      const jobTypes = new Set();
      let teamSize = null;
      let activeStep = 0;
      let maxSeen = 0;

      container.innerHTML = `
        <main class="rp-page">
          <header class="rp-header">
            <div class="rp-kicker">Your company <span id="rpProgress">1 of 3</span></div>
            <h1>Tell us how your company works</h1>
            <p>We’ll ask one thing at a time and use your answers to personalize the rest of setup.</p>
          </header>
          <div class="rp-flow">
            <nav class="rp-step-list" aria-label="Company setup steps">
              <button class="rp-step-link" type="button" data-edit-step="0"><span class="rp-step-marker">1</span><span><strong>Services</strong><small id="rpServiceSummary">Current step</small></span></button>
              <button class="rp-step-link" type="button" data-edit-step="1"><span class="rp-step-marker">2</span><span><strong>Job types</strong><small id="rpJobSummary">Not answered</small></span></button>
              <button class="rp-step-link" type="button" data-edit-step="2"><span class="rp-step-marker">3</span><span><strong>Team size</strong><small id="rpTeamSummary">Not answered</small></span></button>
            </nav>
            <div class="rp-question-stage">
            <section class="rp-step" data-step="0">
              <div class="rp-active">
                <div class="rp-step-label">First, tell us what you do</div>
                <h2>What do you install and service?</h2>
                <p>Choose everything your company handles.</p>
                <div class="rp-service-grid" id="rpServices"></div>
                <div class="rp-step-actions"><button class="rp-back" type="button" data-back>Back</button><button class="rp-next" type="button" data-next disabled>Next <i class="fa-solid fa-arrow-right"></i></button></div>
              </div>
            </section>
            <section class="rp-step" data-step="1">
              <div class="rp-active">
                <div class="rp-step-label">Great — now the work itself</div>
                <h2>What kinds of jobs do you run?</h2>
                <p>Pick every type that applies. Each will get its own streamlined setup.</p>
                <div class="rp-job-grid" id="rpJobTypes"></div>
                <div class="rp-step-actions"><button class="rp-back" type="button" data-back>Back</button><button class="rp-next" type="button" data-next disabled>Next <i class="fa-solid fa-arrow-right"></i></button></div>
              </div>
            </section>
            <section class="rp-step" data-step="2">
              <div class="rp-active">
                <div class="rp-step-label">One last thing</div>
                <h2>How big is your team?</h2>
                <p>Include salespeople, office staff, and technicians. Don’t count installation crews.</p>
                <div class="rp-team-grid" id="rpTeamSize"></div>
                <div class="rp-step-actions"><button class="rp-back" type="button" data-back>Back</button><button class="rp-next" id="rpContinue" type="button" data-next disabled>Continue <i class="fa-solid fa-arrow-right"></i></button></div>
              </div>
            </section>
            </div>
          </div>
        </main>`;

      const servicesEl = container.querySelector('#rpServices');
      const jobTypesEl = container.querySelector('#rpJobTypes');
      const teamSizeEl = container.querySelector('#rpTeamSize');

      function titles(items, selected) {
        return items.filter((item) => selected.has(item.id)).map((item) => item.title).join(', ');
      }

      function refresh() {
        servicesEl.innerHTML = SERVICES.map((item) => `<button class="rp-choice${services.has(item.id) ? ' selected' : ''}" type="button" data-service="${item.id}" aria-pressed="${services.has(item.id)}"><i class="fa-solid ${item.icon}"></i><strong>${item.title}</strong><span class="rp-check"><i class="fa-solid fa-check"></i></span></button>`).join('');
        jobTypesEl.innerHTML = JOB_TYPES.map((item) => `<button class="rp-choice rp-choice-wide${jobTypes.has(item.id) ? ' selected' : ''}" type="button" data-job-type="${item.id}" aria-pressed="${jobTypes.has(item.id)}"><i class="fa-solid ${item.icon}"></i><span><strong>${item.title}</strong><small>${item.description}</small></span><span class="rp-check"><i class="fa-solid fa-check"></i></span></button>`).join('');
        teamSizeEl.innerHTML = TEAM_SIZES.map((item) => `<button class="rp-choice rp-team-choice${teamSize === item.id ? ' selected' : ''}" type="button" data-team-size="${item.id}" aria-pressed="${teamSize === item.id}"><strong>${item.title}</strong><small>${item.detail}</small><span class="rp-check"><i class="fa-solid fa-check"></i></span></button>`).join('');
        container.querySelector('#rpServiceSummary').textContent = activeStep === 0 ? 'Current step' : titles(SERVICES, services) || 'Not answered';
        container.querySelector('#rpJobSummary').textContent = activeStep === 1 ? 'Current step' : titles(JOB_TYPES, jobTypes) || 'Not answered';
        container.querySelector('#rpTeamSummary').textContent = activeStep === 2 ? 'Current step' : (TEAM_SIZES.find((item) => item.id === teamSize) || {}).title || 'Not answered';
        container.querySelector('#rpProgress').textContent = `${activeStep + 1} of 3`;
        container.querySelectorAll('.rp-step-link').forEach((link, index) => {
          link.hidden = index > maxSeen;
          link.classList.toggle('is-active', index === activeStep);
          link.classList.toggle('is-complete', index !== activeStep && index <= maxSeen);
          link.querySelector('.rp-step-marker').innerHTML = index < activeStep || (index < maxSeen && index !== activeStep) ? '<i class="fa-solid fa-check"></i>' : String(index + 1);
        });
        container.querySelectorAll('.rp-step').forEach((step, index) => {
          step.classList.toggle('is-active', index === activeStep);
          step.classList.toggle('is-future', index !== activeStep);
          const next = step.querySelector('[data-next]');
          if (next) next.disabled = index === 0 ? !services.size : index === 1 ? !jobTypes.size : !teamSize;
        });
      }

      function go(step, reveal = false) {
        activeStep = Math.max(0, Math.min(2, step));
        if (reveal) maxSeen = Math.max(maxSeen, activeStep);
        refresh();
      }

      container.addEventListener('click', (event) => {
        const service = event.target.closest('[data-service]');
        if (service) { services.has(service.dataset.service) ? services.delete(service.dataset.service) : services.add(service.dataset.service); refresh(); return; }
        const job = event.target.closest('[data-job-type]');
        if (job) { jobTypes.has(job.dataset.jobType) ? jobTypes.delete(job.dataset.jobType) : jobTypes.add(job.dataset.jobType); refresh(); return; }
        const size = event.target.closest('[data-team-size]');
        if (size) { teamSize = size.dataset.teamSize; refresh(); setTimeout(() => go(2), 120); return; }
        const edit = event.target.closest('[data-edit-step]');
        if (edit) { go(Number(edit.dataset.editStep)); return; }
        if (event.target.closest('[data-back]')) {
          if (activeStep === 0) ctx.back(); else go(activeStep - 1);
          return;
        }
        if (event.target.closest('[data-next]')) {
          if (activeStep < 2) { go(activeStep + 1, true); return; }
          ctx.complete({ settings: {
            'roofing_setup.services': SERVICES.filter((item) => services.has(item.id)).map((item) => item.id),
            'roofing_setup.job_types': JOB_TYPES.filter((item) => jobTypes.has(item.id)).map((item) => item.id),
            'roofing_setup.team_size': teamSize
          } });
        }
      });
      refresh();
    }
  };
})();
