(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};
  const OPTIONS = [
    { id: 'full_replacements', title: 'Full replacements', description: 'Complete tear-offs, replacements, and major installations.', icon: 'fa-arrows-rotate' },
    { id: 'repairs', title: 'Repairs', description: 'Targeted fixes, troubleshooting, and smaller service jobs.', icon: 'fa-screwdriver-wrench' },
    { id: 'ongoing_maintenance', title: 'Ongoing maintenance', description: 'Recurring inspections, upkeep, and service plans.', icon: 'fa-calendar-check' }
  ];

  function addStylesheet() {
    if (document.getElementById('home-improvement-work-types-styles')) return;
    const link = document.createElement('link');
    link.id = 'home-improvement-work-types-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_home_improvement_work_types/page.css';
    document.head.appendChild(link);
  }

  window.SignupSandboxPages.spg_home_improvement_work_types = {
    render(container, ctx) {
      addStylesheet();
      const selected = new Set();
      container.innerHTML = `
        <main class="hiw-page">
          <div class="hiw-kicker">How you work</div>
          <h1>What kind of work do you primarily do?</h1>
          <p class="hiw-lead">Select every type that applies. This helps shape the rest of your setup around how your company actually operates.</p>
          <div class="hiw-options" id="hiwOptions"></div>
          <div class="hiw-summary" id="hiwSummary" aria-live="polite">Choose at least one to continue.</div>
          <div class="hiw-actions"><button class="hiw-continue" id="hiwContinue" type="button" disabled>Continue <i class="fa-solid fa-arrow-right"></i></button></div>
        </main>`;
      const options = container.querySelector('#hiwOptions');
      const summary = container.querySelector('#hiwSummary');
      const continueButton = container.querySelector('#hiwContinue');

      function refresh() {
        options.innerHTML = OPTIONS.map((option) => {
          const active = selected.has(option.id);
          return `<button class="hiw-option${active ? ' selected' : ''}" type="button" data-work-type="${option.id}" aria-pressed="${active}"><span class="hiw-icon"><i class="fa-solid ${option.icon}"></i></span><span class="hiw-copy"><strong>${option.title}</strong><small>${option.description}</small></span><span class="hiw-toggle"><i class="fa-solid fa-check"></i></span></button>`;
        }).join('');
        const count = selected.size;
        summary.textContent = count ? `${count} work type${count === 1 ? '' : 's'} selected` : 'Choose at least one to continue.';
        continueButton.disabled = count === 0;
      }

      options.addEventListener('click', (event) => {
        const button = event.target.closest('[data-work-type]');
        if (!button) return;
        const id = button.dataset.workType;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        refresh();
      });
      continueButton.addEventListener('click', () => {
        const workTypes = OPTIONS.filter((option) => selected.has(option.id)).map((option) => option.id);
        ctx.complete({ settings: { 'home_improvement_setup.work_types': workTypes } });
      });
      refresh();
    }
  };
})();
