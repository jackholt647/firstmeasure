(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const PRIMARY_SERVICES = [
    { id: 'roofing', label: 'Roofing', icon: 'fa-house-chimney' },
    { id: 'gutters', label: 'Gutters', icon: 'fa-water' },
    { id: 'siding', label: 'Siding', icon: 'fa-border-all' },
    { id: 'windows', label: 'Windows', icon: 'fa-window-maximize' },
    { id: 'doors', label: 'Doors', icon: 'fa-door-open' }
  ];
  const OTHER_SERVICES = [
    'Additions', 'Basement finishing', 'Bathroom remodeling', 'Cabinetry',
    'Carpentry', 'Concrete', 'Decks and porches', 'Demolition', 'Drywall',
    'Electrical', 'Exterior painting', 'Fencing', 'Flooring', 'Foundation repair',
    'Garage doors', 'General remodeling', 'HVAC', 'Insulation', 'Interior painting',
    'Kitchen remodeling', 'Landscaping', 'Masonry', 'Patios and hardscaping',
    'Plumbing', 'Pressure washing', 'Restoration', 'Skylights', 'Solar',
    'Tile', 'Tree services', 'Waterproofing'
  ].map((label) => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label }));

  function addStylesheet() {
    if (document.getElementById('home-improvement-services-styles')) return;
    const link = document.createElement('link');
    link.id = 'home-improvement-services-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_home_improvement_services/page.css';
    document.head.appendChild(link);
  }

  window.SignupSandboxPages.spg_home_improvement_services = {
    render(container, ctx) {
      addStylesheet();
      const selected = new Set();
      let catalogOpen = false;
      let query = '';

      container.innerHTML = `
        <main class="his-page">
          <div class="his-kicker">About your company</div>
          <h1>What services do you provide?</h1>
          <p class="his-lead">Choose everything your company offers. You can change this later as your business grows.</p>
          <div class="his-primary" id="hisPrimary"></div>
          <button class="his-other-trigger" id="hisOtherTrigger" type="button" aria-expanded="false">
            <span><i class="fa-solid fa-table-cells-large"></i><strong>Add other services</strong><small>Search remodeling, trades, exterior work, and more</small></span>
            <i class="fa-solid fa-chevron-down his-chevron"></i>
          </button>
          <section class="his-catalog" id="hisCatalog" hidden>
            <label class="his-search"><i class="fa-solid fa-magnifying-glass"></i><input id="hisSearch" type="search" placeholder="Search other services" autocomplete="off"></label>
            <div class="his-results" id="hisResults"></div>
            <p class="his-empty" id="hisEmpty" hidden>No matching services. You can refine this list later in company settings.</p>
          </section>
          <div class="his-summary" id="hisSummary" aria-live="polite">Select at least one service to continue.</div>
          <div class="his-actions"><button class="his-continue" id="hisContinue" type="button" disabled>Continue <i class="fa-solid fa-arrow-right"></i></button></div>
        </main>`;

      const primary = container.querySelector('#hisPrimary');
      const results = container.querySelector('#hisResults');
      const summary = container.querySelector('#hisSummary');
      const continueButton = container.querySelector('#hisContinue');
      const trigger = container.querySelector('#hisOtherTrigger');
      const catalog = container.querySelector('#hisCatalog');
      const search = container.querySelector('#hisSearch');
      const empty = container.querySelector('#hisEmpty');

      function buttonMarkup(service, compact) {
        const active = selected.has(service.id);
        const icon = service.icon ? `<i class="fa-solid ${service.icon}"></i>` : '<i class="fa-solid fa-hammer"></i>';
        return `<button class="his-service${compact ? ' compact' : ''}${active ? ' selected' : ''}" type="button" data-service="${service.id}" aria-pressed="${active}">${icon}<span>${service.label}</span>${active ? '<i class="fa-solid fa-check his-check"></i>' : ''}</button>`;
      }

      function refresh() {
        primary.innerHTML = PRIMARY_SERVICES.map((service) => buttonMarkup(service, false)).join('');
        const filtered = OTHER_SERVICES.filter((service) => service.label.toLowerCase().includes(query));
        results.innerHTML = filtered.map((service) => buttonMarkup(service, true)).join('');
        empty.hidden = filtered.length !== 0;
        const count = selected.size;
        summary.textContent = count ? `${count} service${count === 1 ? '' : 's'} selected` : 'Select at least one service to continue.';
        continueButton.disabled = count === 0;
      }

      function toggle(event) {
        const button = event.target.closest('[data-service]');
        if (!button) return;
        const id = button.dataset.service;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        refresh();
      }

      primary.addEventListener('click', toggle);
      results.addEventListener('click', toggle);
      trigger.addEventListener('click', () => {
        catalogOpen = !catalogOpen;
        catalog.hidden = !catalogOpen;
        trigger.setAttribute('aria-expanded', String(catalogOpen));
        trigger.classList.toggle('open', catalogOpen);
        if (catalogOpen) search.focus();
      });
      search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); refresh(); });
      continueButton.addEventListener('click', () => {
        const all = [...PRIMARY_SERVICES, ...OTHER_SERVICES];
        const services = all.filter((service) => selected.has(service.id)).map((service) => ({ id: service.id, label: service.label }));
        ctx.complete({ settings: { 'home_improvement_setup.services': services } });
      });
      refresh();
    }
  };
})();
