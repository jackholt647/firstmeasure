(function () {
  'use strict';

  window.SignupSandboxPages = window.SignupSandboxPages || {};

  const TEMPLATES = [
    { id: 'classic', title: 'Classic roofing proposal', description: 'Scope of work, materials, price, terms, signature. Clean and direct.', icon: 'fa-file-lines' },
    { id: 'good_better_best', title: 'Good / Better / Best', description: 'Three shingle-and-warranty tiers side by side. Great for retail closers.', icon: 'fa-table-columns' },
    { id: 'insurance_packet', title: 'Insurance restoration packet', description: 'Contingency agreement, claim scope, supplement-ready line items.', icon: 'fa-shield-halved' }
  ];

  function addStylesheet() {
    if (document.getElementById('roofing-proposal-doc-styles')) return;
    const link = document.createElement('link');
    link.id = 'roofing-proposal-doc-styles';
    link.rel = 'stylesheet';
    link.href = '/portal/signup-sandbox/pages/spg_roofing_proposal_doc/page.css?v=20260810';
    document.head.appendChild(link);
  }

  function previewHtml(templateId) {
    if (templateId === 'classic') {
      return `<div class="rpd-doc">
        <div class="rpd-doc-head"><span class="rpd-doc-logo"><i class="fa-solid fa-house-chimney"></i></span><div class="rpd-doc-headlines"><span class="rpd-bar w55 dark"></span><span class="rpd-bar w35"></span></div></div>
        <div class="rpd-doc-label">Scope of work</div>
        <span class="rpd-bar w90"></span><span class="rpd-bar w75"></span><span class="rpd-bar w85"></span><span class="rpd-bar w60"></span>
        <div class="rpd-doc-label">Materials</div>
        <div class="rpd-doc-table"><div class="rpd-doc-tr"><span class="rpd-bar w40"></span><span class="rpd-bar w15"></span></div><div class="rpd-doc-tr"><span class="rpd-bar w50"></span><span class="rpd-bar w15"></span></div><div class="rpd-doc-tr"><span class="rpd-bar w35"></span><span class="rpd-bar w15"></span></div></div>
        <div class="rpd-doc-total"><span>Total</span><span class="rpd-bar w25 dark"></span></div>
        <div class="rpd-doc-sign"><span class="rpd-doc-sign-line"></span><small>Customer signature</small></div>
      </div>`;
    }
    if (templateId === 'good_better_best') {
      return `<div class="rpd-doc">
        <div class="rpd-doc-head"><span class="rpd-doc-logo"><i class="fa-solid fa-house-chimney"></i></span><div class="rpd-doc-headlines"><span class="rpd-bar w55 dark"></span><span class="rpd-bar w35"></span></div></div>
        <div class="rpd-tiers">
          ${['Good', 'Better', 'Best'].map((tier, index) => `<div class="rpd-tier${index === 1 ? ' featured' : ''}">
            <strong>${tier}</strong>
            <span class="rpd-bar w70 dark"></span>
            <span class="rpd-bar w90"></span><span class="rpd-bar w80"></span><span class="rpd-bar w85"></span>
            <div class="rpd-tier-btn">Choose</div>
          </div>`).join('')}
        </div>
        <div class="rpd-doc-sign"><span class="rpd-doc-sign-line"></span><small>Customer signature</small></div>
      </div>`;
    }
    return `<div class="rpd-doc">
      <div class="rpd-doc-head"><span class="rpd-doc-logo"><i class="fa-solid fa-shield-halved"></i></span><div class="rpd-doc-headlines"><span class="rpd-bar w60 dark"></span><span class="rpd-bar w40"></span></div></div>
      <div class="rpd-doc-badge"><i class="fa-solid fa-shield-halved"></i> Contingency agreement</div>
      <span class="rpd-bar w90"></span><span class="rpd-bar w85"></span><span class="rpd-bar w70"></span>
      <div class="rpd-doc-label">Claim scope</div>
      <div class="rpd-doc-table"><div class="rpd-doc-tr"><span class="rpd-bar w45"></span><span class="rpd-bar w15"></span></div><div class="rpd-doc-tr"><span class="rpd-bar w55"></span><span class="rpd-bar w15"></span></div><div class="rpd-doc-tr"><span class="rpd-bar w40"></span><span class="rpd-bar w15"></span></div></div>
      <div class="rpd-doc-rows"><div class="rpd-doc-kv"><small>Deductible</small><span class="rpd-bar w20"></span></div><div class="rpd-doc-kv"><small>ACV</small><span class="rpd-bar w20"></span></div><div class="rpd-doc-kv"><small>Supplements</small><span class="rpd-bar w20"></span></div></div>
      <div class="rpd-doc-sign"><span class="rpd-doc-sign-line"></span><small>Customer signature</small></div>
    </div>`;
  }

  window.SignupSandboxPages.spg_roofing_proposal_doc = {
    render(container, ctx) {
      addStylesheet();
      if (container.parentElement) container.parentElement.style.width = 'min(1000px,100%)';
      let mode = null; // 'upload' | 'template'
      let uploadName = null;
      let template = 'classic';
      let templateChosen = false;
      let contractMode = 'file'; // 'file' | 'text'
      let contractName = null;
      let contractText = '';
      let activeStep = 0;

      container.innerHTML = `
        <main class="rpd-page">
          <div class="rpd-kicker">Documents</div>
          <h1>Set up your proposal</h1>
          <p class="rpd-lead">This is the document your customers sign. Bring yours and we'll rebuild it in FirstMate — pricing, e-signature, and payments included — or start from one of ours.</p>

          <div class="rpd-modes">
            <button class="rpd-mode" type="button" data-mode="upload">
              <span class="rpd-mode-icon"><i class="fa-solid fa-cloud-arrow-up"></i></span>
              <strong>Upload your current proposal</strong>
              <small>PDF or Word. The AI agent rebuilds it as a live FirstMate document and shows you the result for approval.</small>
            </button>
            <button class="rpd-mode" type="button" data-mode="template">
              <span class="rpd-mode-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
              <strong>Use one of our templates</strong>
              <small>Proven roofing proposals, already branded with your logo and colors from the earlier step.</small>
            </button>
          </div>

          <div class="rpd-detail" id="rpdDetail"></div>

          <h2 class="rpd-section">Contract terms <span class="rpd-optional">optional</span></h2>
          <p class="rpd-hint">Standard terms & conditions attached to every proposal. Attach them in any format, or just type them in.</p>
          <div class="rpd-seg" id="rpdContractSeg">
            <button class="rpd-seg-btn" type="button" data-contract-mode="file"><i class="fa-solid fa-paperclip"></i> Attach a file</button>
            <button class="rpd-seg-btn" type="button" data-contract-mode="text"><i class="fa-solid fa-keyboard"></i> Type them in</button>
          </div>
          <div id="rpdContractDetail"></div>

          <div class="rpd-summary" id="rpdSummary" aria-live="polite">Choose how you want to start to continue.</div>
          <div class="rpd-actions"><button class="rpd-continue" id="rpdContinue" type="button" disabled>Continue <i class="fa-solid fa-arrow-right"></i></button></div>
        </main>`;

      const detailEl = container.querySelector('#rpdDetail');
      const contractDetailEl = container.querySelector('#rpdContractDetail');
      const summaryEl = container.querySelector('#rpdSummary');
      const continueBtn = container.querySelector('#rpdContinue');
      const page = container.querySelector('.rpd-page');
      const modes = page.querySelector('.rpd-modes');
      const contractHeading = page.querySelector('.rpd-section');
      const contractHint = page.querySelector('.rpd-hint');
      const contractSeg = page.querySelector('#rpdContractSeg');
      const originalActions = page.querySelector('.rpd-actions');
      const flow = document.createElement('div'); flow.className = 'rpd-flow'; modes.before(flow);
      const first = document.createElement('section'); first.className = 'rpd-step'; first.innerHTML = '<div class="rpd-step-body"><div class="rpd-step-count">Proposal · 1 of 2</div><h2>How would you like to create your proposal?</h2></div>';
      first.querySelector('.rpd-step-body').append(modes, detailEl);
      first.querySelector('.rpd-step-body').insertAdjacentHTML('beforeend','<div class="rpd-step-nav"><button class="rpd-back" type="button" data-step-back>Back</button><button class="rpd-continue" type="button" data-step-next disabled>Next <i class="fa-solid fa-arrow-right"></i></button></div>');
      const second = document.createElement('section'); second.className = 'rpd-step'; second.innerHTML = '<button class="rpd-collapsed" type="button" data-edit-step="0"><i class="fa-solid fa-check"></i><span>Proposal document</span><strong>Ready</strong><i class="fa-solid fa-pen"></i></button><div class="rpd-step-body"><div class="rpd-step-count">Proposal · 2 of 2 · optional</div></div>';
      second.querySelector('.rpd-step-body').append(contractHeading, contractHint, contractSeg, contractDetailEl, summaryEl, originalActions);
      originalActions.insertAdjacentHTML('afterbegin','<button class="rpd-back" type="button" data-step-back>Back</button><button class="rpd-skip" type="button" data-finish>Skip terms</button>');
      flow.append(first, second);

      function renderContract() {
        container.querySelectorAll('[data-contract-mode]').forEach((button) => {
          button.classList.toggle('selected', button.dataset.contractMode === contractMode);
        });
        if (contractMode === 'file') {
          contractDetailEl.innerHTML = `
            <label class="rpd-file${contractName ? ' on' : ''}">
              <i class="fa-solid ${contractName ? 'fa-file-circle-check' : 'fa-paperclip'}"></i>
              <span>${contractName ? `<strong>${contractName}</strong> — attached to every proposal.` : 'Attach your contract terms — any format works'}</span>
              <input type="file" id="rpdContractInput" hidden>
            </label>`;
          const input = contractDetailEl.querySelector('#rpdContractInput');
          input.addEventListener('change', () => {
            contractName = input.files.length ? input.files[0].name : null;
            renderContract();
            refreshSummary();
          });
        } else {
          contractDetailEl.innerHTML = `<textarea class="rpd-textarea" id="rpdContractText" rows="6" placeholder="Paste or type your terms & conditions…"></textarea>`;
          const textarea = contractDetailEl.querySelector('#rpdContractText');
          textarea.value = contractText;
          textarea.addEventListener('input', () => { contractText = textarea.value; refreshSummary(); });
        }
      }

      function renderDetail() {
        container.querySelectorAll('[data-mode]').forEach((button) => {
          button.classList.toggle('selected', button.dataset.mode === mode);
        });
        if (mode === 'upload') {
          detailEl.innerHTML = `
            <label class="rpd-file rpd-file-lg${uploadName ? ' on' : ''}">
              <i class="fa-solid ${uploadName ? 'fa-file-circle-check' : 'fa-file-arrow-up'}"></i>
              <span>${uploadName ? `<strong>${uploadName}</strong> — ready. The agent will rebuild this after setup.` : 'Choose your proposal file (PDF or Word)'}</span>
              <input type="file" id="rpdUploadInput" accept=".pdf,.doc,.docx" hidden>
            </label>`;
          const input = detailEl.querySelector('#rpdUploadInput');
          input.addEventListener('change', () => {
            uploadName = input.files.length ? input.files[0].name : null;
            renderDetail();
            refreshSummary();
          });
        } else if (mode === 'template') {
          const active = TEMPLATES.find((t) => t.id === template) || TEMPLATES[0];
          detailEl.innerHTML = `<div class="rpd-studio">
            <div class="rpd-templates">${TEMPLATES.map((t) => `
              <button class="rpd-template${template === t.id && templateChosen ? ' selected' : ''}" type="button" data-template="${t.id}">
                <span class="rpd-template-icon"><i class="fa-solid ${t.icon}"></i></span>
                <span class="rpd-template-copy"><strong>${t.title}</strong><small>${t.description}</small></span>
                <span class="rpd-check"><i class="fa-solid fa-check"></i></span>
              </button>`).join('')}</div>
            <div class="rpd-preview">
              <div class="rpd-preview-frame">${previewHtml(active.id)}</div>
              <div class="rpd-preview-caption"><strong>${active.title}</strong> — ${templateChosen ? 'selected. It gets your logo and colors automatically.' : 'click to select it.'}</div>
            </div>
          </div>`;
        } else {
          detailEl.innerHTML = '';
        }
      }

      function refreshSummary() {
        const ready = mode === 'upload' ? Boolean(uploadName) : mode === 'template' ? templateChosen : false;
        summaryEl.textContent = ready
          ? (mode === 'upload' ? 'We’ll rebuild your proposal and show it to you before anything goes out.' : 'Your template will be branded with your logo and colors.')
          : mode === 'upload' ? 'Choose your proposal file to continue.'
          : mode === 'template' ? 'Pick a template to continue.'
          : 'Choose how you want to start to continue.';
        continueBtn.disabled = !ready;
        first.querySelector('[data-step-next]').disabled = !ready;
        [first,second].forEach((step,index)=>{step.classList.toggle('is-active',index===activeStep);step.classList.toggle('is-complete',index<activeStep);step.classList.toggle('is-future',index>activeStep)});
      }

      container.addEventListener('click', (event) => {
        const modeBtn = event.target.closest('[data-mode]');
        if (modeBtn) { mode = modeBtn.dataset.mode; renderDetail(); refreshSummary(); return; }
        const templateBtn = event.target.closest('[data-template]');
        if (templateBtn) { template = templateBtn.dataset.template; templateChosen = true; renderDetail(); refreshSummary(); return; }
        const segBtn = event.target.closest('[data-contract-mode]');
        if (segBtn) { contractMode = segBtn.dataset.contractMode; renderContract(); return; }
        if(event.target.closest('[data-edit-step]')){activeStep=0;refreshSummary();return}
        if(event.target.closest('[data-step-back]')){if(activeStep===0)ctx.back();else{activeStep--;refreshSummary()}return}
        if(event.target.closest('[data-step-next]')){activeStep=1;refreshSummary();return}
        if(event.target.closest('[data-finish]')){finish();}
      });

      function finish() {
        ctx.complete({
          settings: {
            'roofing_setup.proposal_document': {
              mode,
              uploaded_file: mode === 'upload' ? uploadName : null,
              template: mode === 'template' ? template : null,
              contract_file: contractMode === 'file' ? contractName : null,
              contract_text: contractMode === 'text' && contractText.trim() ? contractText.trim() : null
            }
          }
        });
      }
      continueBtn.addEventListener('click', finish);

      renderDetail();
      renderContract();
      refreshSummary();
    }
  };
})();
