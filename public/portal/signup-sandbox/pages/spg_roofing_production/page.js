(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const JOB_TYPE_META = {
    retail_replacement: { title: 'Full replacements (retail)', icon: 'fa-arrows-rotate' },
    insurance_restoration: { title: 'Insurance restoration', icon: 'fa-shield-halved' },
    repair: { title: 'Repairs', icon: 'fa-screwdriver-wrench' },
    maintenance: { title: 'Maintenance plans', icon: 'fa-calendar-check' }
  };

  const DEFAULT_TEMPLATES = {
    retail_replacement: ['Pre-job site check & measurements', 'Order materials', 'Schedule the crew', 'Pull the permit', 'Material delivery', 'Install day(s)', 'Final inspection & walkthrough', 'Punch list', 'Collect final payment', 'Request a review'],
    insurance_restoration: ['Adjuster meeting', 'Claim approved — review scope', 'File supplements', 'Order materials', 'Schedule the crew', 'Install day(s)', 'Final inspection & walkthrough', 'Invoice depreciation', 'Collect final payment', 'Request a review'],
    repair: ['Dispatch the technician', 'Complete the repair', 'Photo documentation', 'Collect payment on site', 'Request a review'],
    maintenance: ['Schedule the visit window', 'Run the inspection checklist', 'Send the photo report', 'Flag repairs found', 'Bill the visit']
  };

  function addStylesheet() {
    if (document.getElementById('roofing-production-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-production-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_production/page.css?v=20260810c';
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
    } catch (error) { /* fall through */ }
    return ['retail_replacement', 'repair'];
  }

  window.SignupSandboxPages.spg_roofing_production = {
    render(container, ctx) {
      addStylesheet();
      container.innerHTML = '<main class="rpr-page"><p class="rpr-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading your job types…</p></main>';

      loadJobTypes(ctx).then((jobTypes) => {
        const templates = {};
        jobTypes.forEach((id) => { templates[id] = [...(DEFAULT_TEMPLATES[id] || [])]; });
        let openSection = jobTypes[0];
        let crewModel = 'subs';
        let payBasis = 'per_square';
        let activeStep = 0;
        let maxSeen = 0;

        const PAY_OPTIONS = {
          subs: [
            { id: 'per_square', title: 'Per square' },
            { id: 'percent_of_job', title: '% of the job' },
            { id: 'bid_per_job', title: 'Bid per job' }
          ],
          employees: [
            { id: 'hourly', title: 'Hourly' },
            { id: 'piece_rate', title: 'Piece rate' },
            { id: 'salary', title: 'Salary' }
          ]
        };

        function stepsHtml(jobType) {
          const steps = templates[jobType];
          return `<div class="rpr-editor">${steps.map((step, index) => `
            <div class="rpr-row" data-row>
              <span class="rpr-row-num">${index + 1}</span>
              <input class="rpr-input" type="text" value="${esc(step)}" data-step-input="${jobType}:${index}">
              <span class="rpr-move">
                <button class="rpr-icon-btn" type="button" data-step-up="${jobType}:${index}" title="Move up" ${index === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                <button class="rpr-icon-btn" type="button" data-step-down="${jobType}:${index}" title="Move down" ${index === steps.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
              </span>
              <button class="rpr-icon-btn" type="button" data-step-remove="${jobType}:${index}" title="Remove step"><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('')}
            <button class="rpr-add" type="button" data-step-add="${jobType}"><i class="fa-solid fa-plus"></i> Add a step</button>
          </div>`;
        }

        function render() {
          const totalSteps = jobTypes.length + 2;
          const labels = [...jobTypes.map((id) => JOB_TYPE_META[id].title), 'Installation crews', 'Crew payment'];
          const stepLinks = labels.map((label, index) => `<button class="rpr-step-link${index === activeStep ? ' is-active' : index <= maxSeen ? ' is-complete' : ''}" type="button" data-progress-edit="${index}"${index > maxSeen ? ' hidden' : ''}><span class="rpr-step-marker">${index !== activeStep && index <= maxSeen ? '<i class="fa-solid fa-check"></i>' : index + 1}</span><span><strong>${label}</strong><small>${index === activeStep ? 'Current step' : 'Completed'}</small></span></button>`).join('');
          let activeContent = '';
          if (activeStep < jobTypes.length) {
            const id = jobTypes[activeStep];
            const meta = JOB_TYPE_META[id];
            activeContent = `<div class="rpr-step-count">Production · ${activeStep + 1} of ${totalSteps}</div><h2 class="rpr-q">What steps does a ${meta.title.toLowerCase()} job follow?</h2>${stepsHtml(id)}<div class="rpr-step-nav"><button class="rpr-back" type="button" data-progress-back>Back</button><span><button class="rpr-skip" type="button" data-progress-next>Use this default</button><button class="rpr-continue" type="button" data-progress-next>Next <i class="fa-solid fa-arrow-right"></i></button></span></div>`;
          } else if (activeStep === jobTypes.length) {
            activeContent = `<div class="rpr-step-count">Production · ${activeStep + 1} of ${totalSteps}</div><h2 class="rpr-q">Who does the installation work?</h2><div class="rpr-pills" id="rprCrewModel"><button class="rpr-pill${crewModel === 'subs' ? ' selected' : ''}" type="button" data-crew-model="subs">Subcontractor crews</button><button class="rpr-pill${crewModel === 'employees' ? ' selected' : ''}" type="button" data-crew-model="employees">Employee crews</button><button class="rpr-pill${crewModel === 'both' ? ' selected' : ''}" type="button" data-crew-model="both">Both</button></div><div class="rpr-step-nav"><button class="rpr-back" type="button" data-progress-back>Back</button><button class="rpr-continue" type="button" data-progress-next>Next <i class="fa-solid fa-arrow-right"></i></button></div>`;
          } else {
            activeContent = `<div class="rpr-step-count">Production · ${activeStep + 1} of ${totalSteps}</div><h2 class="rpr-q">How do you pay ${crewModel === 'employees' ? 'your crews' : 'your subs'}?</h2><div class="rpr-pills" id="rprPayBasis">${(PAY_OPTIONS[crewModel === 'employees' ? 'employees' : 'subs']).map((o) => `<button class="rpr-pill${payBasis === o.id ? ' selected' : ''}" type="button" data-pay-basis="${o.id}">${o.title}</button>`).join('')}</div><div class="rpr-summary">Crew payments run through FirstMate — pay stubs, per-job costs, and job costing come from this.</div><div class="rpr-step-nav"><button class="rpr-back" type="button" data-progress-back>Back</button><button class="rpr-continue" id="rprContinue" type="button">Continue <i class="fa-solid fa-arrow-right"></i></button></div>`;
          }
          container.innerHTML = `
            <main class="rpr-page">
              <div class="rpr-kicker">Production</div>
              <h1>How does a job get done?</h1>
              <p class="rpr-lead">We prefilled a production to-do list for each job type from what works for other roofing companies. Edit them to match your process — every new job starts with its list.</p>
              <div class="rpr-flow"><nav class="rpr-step-list" aria-label="Production setup steps">${stepLinks}</nav><section class="rpr-question-stage"><div class="rpr-progress-body">${activeContent}</div></section></div>
            </main>`;
          wire();
        }

        function wire() {
          container.querySelector('.rpr-page').addEventListener('click', (event) => {
            const edit = event.target.closest('[data-progress-edit]');
            if (edit) { activeStep=Number(edit.dataset.progressEdit);openSection=jobTypes[activeStep]||null;render();return; }
            if(event.target.closest('[data-progress-back]')){if(activeStep===0)ctx.back();else{activeStep--;openSection=jobTypes[activeStep]||null;render()}return}
            if(event.target.closest('[data-progress-next]')){activeStep++;maxSeen=Math.max(maxSeen,activeStep);openSection=jobTypes[activeStep]||null;render();return}
            if(event.target.closest('#rprContinue')){ctx.complete({settings:{'roofing_setup.production':{templates,crews:{model:crewModel,pay_basis:payBasis}}}});return}
            const add = event.target.closest('[data-step-add]');
            if (add) { templates[add.dataset.stepAdd].push('New step'); render(); return; }
            const remove = event.target.closest('[data-step-remove]');
            if (remove) {
              const [jobType, index] = remove.dataset.stepRemove.split(':');
              templates[jobType].splice(Number(index), 1);
              render();
              return;
            }
            const up = event.target.closest('[data-step-up]');
            if (up) {
              const [jobType, indexRaw] = up.dataset.stepUp.split(':');
              const i = Number(indexRaw);
              if (i > 0) { const [step] = templates[jobType].splice(i, 1); templates[jobType].splice(i - 1, 0, step); render(); }
              return;
            }
            const down = event.target.closest('[data-step-down]');
            if (down) {
              const [jobType, indexRaw] = down.dataset.stepDown.split(':');
              const i = Number(indexRaw);
              if (i < templates[jobType].length - 1) { const [step] = templates[jobType].splice(i, 1); templates[jobType].splice(i + 1, 0, step); render(); }
              return;
            }
            const model = event.target.closest('[data-crew-model]');
            if (model) {
              crewModel = model.dataset.crewModel;
              payBasis = (crewModel === 'employees' ? 'hourly' : 'per_square');
              render();
              return;
            }
            const basis = event.target.closest('[data-pay-basis]');
            if (basis) { payBasis = basis.dataset.payBasis; render(); }
          });

          container.querySelector('.rpr-page').addEventListener('change', (event) => {
            if (event.target.matches('[data-step-input]')) {
              const [jobType, index] = event.target.dataset.stepInput.split(':');
              templates[jobType][Number(index)] = event.target.value;
            }
          });

        }

        render();
      });
    }
  };
})();
