(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const JOB_TYPES = [
    { id: 'retail_replacement', title: 'Replacement' },
    { id: 'insurance_restoration', title: 'Insurance' },
    { id: 'repair', title: 'Repair' },
    { id: 'maintenance', title: 'Maintenance' }
  ];
  const STAGES = [
    { id: 'lead', title: 'New lead' },
    { id: 'appointment', title: 'Appointment set' },
    { id: 'bid_sent', title: 'Bid out' },
    { id: 'sold', title: 'Sold — in production' },
    { id: 'completed', title: 'Completed' }
  ];

  function addStylesheet() {
    if (document.getElementById('roofing-import-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-import-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_import/page.css?v=20260810c';
    document.head.appendChild(link);
  }

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function countCsvRows(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
    return Math.max(0, lines.length - 1);
  }

  window.SignupSandboxPages.spg_roofing_import = {
    render(container, ctx) {
      addStylesheet();
      let contactsFile = null;
      let contactCount = 0;
      const jobs = [];
      let activeStep = 0;
      let maxSeen = 0;

      function jobsHtml() {
        return jobs.map((job, index) => `<div class="rim-row">
          <input class="rim-input" type="text" placeholder="Customer name" value="${esc(job.customer)}" data-job="${index}:customer">
          <select class="rim-select" data-job="${index}:job_type">${JOB_TYPES.map((t) => `<option value="${t.id}"${job.job_type === t.id ? ' selected' : ''}>${t.title}</option>`).join('')}</select>
          <select class="rim-select" data-job="${index}:stage">${STAGES.map((s) => `<option value="${s.id}"${job.stage === s.id ? ' selected' : ''}>${s.title}</option>`).join('')}</select>
          <button class="rim-icon-btn" type="button" data-job-remove="${index}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
      }

      function render() {
        container.innerHTML = `
          <main class="rim-page">
            <div class="rim-kicker">One more thing</div>
            <h1>Bring your customers with you</h1>
            <p class="rim-lead">You're set up. Import what you already have and your pipeline is full on day one — this is the fastest way to make FirstMate feel like home.</p>

            <div class="rim-flow"><nav class="rim-step-list" aria-label="Import steps"><button class="rim-step-link${activeStep===0?' is-active':' is-complete'}" type="button" data-edit-step="0"><span class="rim-step-marker">${activeStep===0?'1':'<i class="fa-solid fa-check"></i>'}</span><span><strong>Import contacts</strong><small>${activeStep===0?'Current step':contactCount?`${contactCount} ready`:'Skipped'}</small></span></button><button class="rim-step-link${activeStep===1?' is-active':''}" type="button" data-edit-step="1"${maxSeen<1?' hidden':''}><span class="rim-step-marker">2</span><span><strong>Active jobs</strong><small>${activeStep===1?'Current step':jobs.length?`${jobs.length} added`:'Optional'}</small></span></button></nav><div class="rim-question-stage"><section class="rim-step${activeStep===0?' is-active':' is-future'}"><div class="rim-step-body"><div class="rim-step-count">Import · 1 of 2 · optional</div><h2 class="rim-section">Import your contacts</h2>
            <label class="rim-file${contactsFile ? ' on' : ''}">
              <i class="fa-solid ${contactsFile ? 'fa-file-circle-check' : 'fa-file-csv'}"></i>
              <span>${contactsFile ? `<strong>${esc(contactsFile)}</strong> — ${contactCount} contact${contactCount === 1 ? '' : 's'} ready to import.` : 'Choose a CSV export from your old CRM or spreadsheet'}</span>
              <input type="file" id="rimCsv" accept=".csv,.vcf" hidden>
            </label>
            <p class="rim-hint">Exports from JobNimbus, AccuLynx, Google Contacts, or any spreadsheet work. Contacts import with tags so you can find them.</p><div class="rim-step-nav"><button class="rim-back" type="button" data-step-back>Back</button><span><button class="rim-skip" type="button" data-step-next>Skip</button><button class="rim-continue" type="button" data-step-next>Next <i class="fa-solid fa-arrow-right"></i></button></span></div></div></section>

            <section class="rim-step${activeStep===1?' is-active':' is-future'}"><div class="rim-step-body"><div class="rim-step-count">Import · 2 of 2 · optional</div><h2 class="rim-section">Add your active jobs</h2>
            <p class="rim-hint">List the jobs you're working right now and we'll place each one at the right spot in your new pipeline.</p>
            <div class="rim-rows">${jobsHtml()}<button class="rim-add" type="button" id="rimAddJob"><i class="fa-solid fa-plus"></i> Add an active job</button></div>

            <div class="rim-summary" aria-live="polite">${contactCount || jobs.length ? `Importing ${[contactCount ? `${contactCount} contact${contactCount === 1 ? '' : 's'}` : '', jobs.length ? `${jobs.length} active job${jobs.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}.` : 'You can import any time later from Settings.'}</div>
            <div class="rim-actions"><button class="rim-back" type="button" data-step-back>Back</button>
              <button class="rim-skip" id="rimSkip" type="button">Skip for now</button>
              <button class="rim-continue" id="rimContinue" type="button">Finish <i class="fa-solid fa-flag-checkered"></i></button>
            </div></div></section></div></div>
          </main>`;
        wire();
      }

      function complete(skipped) {
        ctx.complete({
          settings: {
            'roofing_setup.import': skipped
              ? { skipped: true }
              : {
                  skipped: false,
                  contacts_file: contactsFile,
                  contact_count: contactCount,
                  active_jobs: jobs.filter((job) => job.customer.trim())
                }
          }
        });
      }

      function wire() {
        const csvInput = container.querySelector('#rimCsv');
        csvInput.addEventListener('change', () => {
          if (!csvInput.files.length) return;
          const file = csvInput.files[0];
          contactsFile = file.name;
          file.text().then((text) => {
            contactCount = /\.vcf$/i.test(file.name) ? (text.match(/BEGIN:VCARD/gi) || []).length : countCsvRows(text);
            render();
          }).catch(() => { contactCount = 0; render(); });
        });
        container.querySelector('#rimAddJob').addEventListener('click', () => {
          jobs.push({ customer: '', job_type: JOB_TYPES[0].id, stage: 'sold' });
          render();
        });
        container.querySelector('.rim-page').addEventListener('click', (event) => {
          const remove = event.target.closest('[data-job-remove]');
          if (remove) { jobs.splice(Number(remove.dataset.jobRemove), 1); render(); return; }
          const edit=event.target.closest('[data-edit-step]');if(edit){activeStep=Number(edit.dataset.editStep);render();return}
          if(event.target.closest('[data-step-back]')){if(activeStep===0)ctx.back();else{activeStep--;render()}return}
          if(event.target.closest('[data-step-next]')){activeStep=1;maxSeen=1;render()}
        });
        container.querySelector('.rim-page').addEventListener('change', (event) => {
          if (!event.target.matches('[data-job]')) return;
          const [index, field] = event.target.dataset.job.split(':');
          jobs[Number(index)][field] = event.target.value;
        });
        container.querySelector('#rimSkip').addEventListener('click', () => complete(true));
        container.querySelector('#rimContinue').addEventListener('click', () => complete(false));
      }

      render();
    }
  };
})();
