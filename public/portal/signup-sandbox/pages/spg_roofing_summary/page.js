(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const JOB_TITLES = {
    retail_replacement: 'Full replacements (retail)',
    insurance_restoration: 'Insurance restoration',
    repair: 'Repairs',
    maintenance: 'Maintenance plans'
  };

  function addStylesheet() {
    if (document.getElementById('roofing-summary-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-summary-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_summary/page.css';
    document.head.appendChild(link);
  }

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mergedSettings(stageInputs) {
    const merged = {};
    for (const input of Object.values(stageInputs || {})) {
      Object.assign(merged, (input || {}).settings || {});
    }
    return merged;
  }

  function slugify(name) {
    return String(name || 'yourcompany').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'yourcompany';
  }

  window.SignupSandboxPages.spg_roofing_summary = {
    render(container, ctx) {
      addStylesheet();
      container.innerHTML = '<main class="rsum-page"><p class="rsum-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Pulling your setup together…</p></main>';

      fetch(`${ctx.apiBaseUrl}/test-orgs/${encodeURIComponent(ctx.instanceId)}/run-state`, { credentials: 'include' })
        .then((res) => res.json())
        .then((payload) => {
          const testOrg = (payload.instance || payload).test_org || {};
          const settings = mergedSettings(testOrg.stage_inputs);
          const orgName = testOrg.org_name || 'Your company';
          const emailAddress = `${slugify(orgName)}@firstmatemail.com`;

          const jobTypes = settings['roofing_setup.job_types'] || [];
          const salesWorkflows = settings['roofing_setup.sales_workflows'] || {};
          const leadIntake = settings['roofing_setup.lead_intake'] || {};
          const proposalDoc = settings['roofing_setup.proposal_document'] || {};
          const commissions = settings['roofing_setup.commissions'] || {};
          const team = settings['roofing_setup.team'] || {};

          let smsCount = 0;
          if (leadIntake.first_contact === 'sms') smsCount += 1;
          for (const config of Object.values(salesWorkflows)) {
            smsCount += ((config || {}).follow_up || []).filter((step) => step.method === 'sms').length;
            smsCount += ((config || {}).checklist || []).filter((step) => /text|sms/i.test(step)).length;
          }

          const teamCount = Object.values((team.members || {})).reduce((n, rows) => n + (rows || []).length, 0);
          const jobProposals = Object.values(salesWorkflows).map((workflow) => (workflow || {}).proposal).filter((proposal) => proposal && proposal.mode);
          const contractCount = jobProposals.filter((proposal) => proposal.mode === 'template' || proposal.mode === 'upload').length;
          const noContractCount = jobProposals.filter((proposal) => proposal.mode === 'none').length;
          const proposalDetail = jobProposals.length
            ? `${contractCount ? `${contractCount} job type${contractCount === 1 ? '' : 's'} with a contract` : ''}${contractCount && noContractCount ? '; ' : ''}${noContractCount ? `${noContractCount} without one` : ''}.`
            : proposalDoc.mode === 'upload' ? `We're rebuilding “${esc(proposalDoc.uploaded_file || 'your proposal')}” — you'll approve it before it's used.`
            : proposalDoc.template ? 'Built from a FirstMate template with your branding.'
            : 'Using job-specific FirstMate defaults.';
          const commissionPlans = Object.values(commissions).filter((plan) => plan && plan.method);

          const rows = [];
          rows.push({ icon: 'fa-briefcase', title: 'Job types', detail: jobTypes.length ? jobTypes.map((id) => JOB_TITLES[id] || id).join(', ') : 'Set up on the earlier steps.' });
          rows.push({ icon: 'fa-route', title: 'Sales workflows', detail: Object.keys(salesWorkflows).length ? `${Object.keys(salesWorkflows).length} workflow${Object.keys(salesWorkflows).length === 1 ? '' : 's'} configured — pipeline, follow-up cycles, checklists, and payment schedules are live.` : 'Using FirstMate roofing defaults.' });
          rows.push({ icon: 'fa-file-signature', title: 'Contracts & proposals', detail: proposalDetail });
          rows.push({ icon: 'fa-hand-holding-dollar', title: 'Commissions', detail: commissionPlans.length ? `${commissionPlans.length} job-type plan${commissionPlans.length === 1 ? '' : 's'} configured — commission statements generate from each plan.` : commissions.structure ? 'Configured — commission statements generate automatically on sold jobs.' : 'Not configured yet.' });
          rows.push({ icon: 'fa-users', title: 'Team', detail: team.solo ? 'Just you for now — invite people any time from Settings.' : teamCount ? `${teamCount} invite${teamCount === 1 ? '' : 's'} sending when you finish.` : 'No invites queued.' });

          container.innerHTML = `
            <main class="rsum-page">
              <div class="rsum-kicker">Almost done</div>
              <h1>${esc(orgName)} is ready to run</h1>
              <p class="rsum-lead">Here's everything we set up. You can change any of it later in Settings.</p>

              <div class="rsum-rows">${rows.map((row) => `
                <div class="rsum-row">
                  <span class="rsum-icon"><i class="fa-solid ${row.icon}"></i></span>
                  <div class="rsum-copy"><strong>${row.title}</strong><small>${row.detail}</small></div>
                  <i class="fa-solid fa-circle-check rsum-check"></i>
                </div>`).join('')}
              </div>

              <div class="rsum-callout">
                <span class="rsum-callout-icon"><i class="fa-solid fa-envelope-circle-check"></i></span>
                <div><strong>Your email is ready to send</strong>
                <small>Proposals, follow-ups, and notifications send from <code>${emailAddress}</code> — already set up, nothing to configure. You can connect your own domain later.</small></div>
              </div>

              ${smsCount > 0 ? `<div class="rsum-callout rsum-callout-warn">
                <span class="rsum-callout-icon"><i class="fa-solid fa-comment-sms"></i></span>
                <div><strong>${smsCount} of your steps use text messaging</strong>
                <small>Texting requires the SMS add-on. Until you enable it, those steps automatically send by email instead — nothing breaks, nothing gets skipped.</small></div>
              </div>` : ''}

              <div class="rsum-actions"><button class="rsum-back" id="rsumBack" type="button">Back</button><button class="rsum-continue" id="rsumContinue" type="button">Finish setup <i class="fa-solid fa-arrow-right"></i></button></div>
            </main>`;

          container.querySelector('#rsumBack').addEventListener('click', () => ctx.back());
          container.querySelector('#rsumContinue').addEventListener('click', () => {
            ctx.complete({ settings: { 'roofing_setup.completed': true } });
          });
        })
        .catch(() => {
          container.innerHTML = '<main class="rsum-page"><p class="rsum-loading">Could not load your setup summary.</p><div class="rsum-actions"><button class="rsum-back" id="rsumBack" type="button">Back</button><button class="rsum-continue" id="rsumContinue" type="button">Finish setup</button></div></main>';
          container.querySelector('#rsumBack').addEventListener('click', () => ctx.back());
          container.querySelector('#rsumContinue').addEventListener('click', () => {
            ctx.complete({ settings: { 'roofing_setup.completed': true } });
          });
        });
    }
  };
})();
