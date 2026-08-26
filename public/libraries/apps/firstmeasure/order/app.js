/* public/libraries/apps/firstmeasure/order/app.js
 * FirstMeasure order workflow for the project-modal left region.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const fallbackEscapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match]));
  const escapeHtml = util.escapeHtml || runtime?.escapeHtml || fallbackEscapeHtml;

  function workspace(context = {}){
    return context.projectWorkspace || context.host?.projectWorkspace || context.host || {};
  }

  function service(context = {}){
    return context.services?.firstMeasureOrder || {};
  }

  function call(context, name, fallback, ...args){
    const svc = service(context);
    const host = workspace(context);
    const fn = typeof svc[name] === 'function' ? svc[name] : (typeof host[name] === 'function' ? host[name] : null);
    if (!fn) return typeof fallback === 'function' ? fallback(...args) : fallback;
    return fn(...args);
  }

  function panelHtml(context = {}){
    const projectNotesTip = 'For your own reference only.';
    const buildTypeButtons = () => call(context, 'buildTypeButtons', '');
    const proposalsEnabled = () => !!call(context, 'proposalsEnabled', false);
    const schedulingEnabled = () => !!call(context, 'schedulingEnabled', false);
    const proposalAgentEnabled = () => !!call(context, 'proposalAgentEnabled', false);
    const infoTip = (text) => call(context, 'infoTip', () => '<span class="r-info-tip"><i class="fas fa-info"></i><span class="r-tip-bubble">' + escapeHtml(text) + '</span></span>', text);
    const addonInfoIcon = (name) => call(context, 'addonInfoIcon', '', name);
    const fmtMoney = (value) => call(context, 'fmtMoney', String(value ?? '0'), value);
    const GUTTER_REPORT_ADDON = call(context, 'gutterReportAddon', 0);
    const WEATHER_REPORT_ADDON = call(context, 'weatherReportAddon', 0);
    return `<div class="r-left">
  <div class="r-top">
    <div>
      <div class="r-title-wrap"><div class="r-title">New Project</div></div>
      <div class="r-sub"></div>
    </div>
  </div>
  <div class="r-stagebar" id="rProjectStageBar" hidden></div>
  <form id="rForm" class="r-form">
  <div class="r-scroll">
    <input type="hidden" id="rLat">
    <input type="hidden" id="rLng">
    <input type="hidden" id="rCustom" value="0">
    <input type="hidden" id="rComps" value="{}">

    <div class="r-after-hours" id="rAfterHours"><i class="fas fa-clock"></i><span id="rAfterHoursMsg"></span></div>
    <div class="r-projection-card" id="rProjectionCard"></div>
    <div class="r-viewer-summary" id="rViewerSummary"></div>

    <section class="r-step is-open" id="rStepCustomer" data-status="active">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body">
        <div class="r-group">
          <div class="r-contact-list" id="rContactList"></div>
          <button type="button" class="r-contact-add" id="rAddContact"><i class="fas fa-plus"></i> Add contact</button>
        </div>
      </div></div></div>
    </section>
    <div class="r-inline-notes-mount" id="rInlineNotesMount"></div>
    <div class="r-customer-portal-link" id="rCustomerPortalLinkMount"></div>

    <section class="r-step is-open" id="rStepAddress" data-status="active">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body"><div class="r-group"><label>Property Address</label><input class="r-inp" id="rAddress" placeholder="Start typing an address or click the map..." autocomplete="off" required></div></div></div></div>
    </section>

    <section class="r-step is-hidden" id="rStepType" data-status="locked">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body"><div class="r-group"><label id="rStepTypeLabel">Project Type</label><div class="r-choice-row" id="rTypeGroup">${buildTypeButtons()}</div><div class="r-type-pill-row" id="rTypePill"></div></div></div></div></div>
    </section>

    <section class="r-workflow-dock" id="rWorkflowDock">
      <div class="r-workflow-empty" id="rWorkflowEmpty">
        <div class="r-workflow-empty-title">Project To-dos</div>
        <div class="r-workflow-todos" id="rProjectTodoList"></div>
      </div>
    </section>

    <section class="r-step is-hidden" id="rStepReport" data-status="locked">
      <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body" style="padding-top:2px"><div class="r-inline-label">Actions</div><div class="r-choice-row r-report-choice-row">
        <button type="button" class="r-toggle-btn" data-report-choice="roof"><div class="r-toggle-icon"><i class="fas fa-file-lines"></i></div><div class="r-toggle-label">Order a Report</div><div class="r-toggle-sub" id="rRoofOnlySub">Choose a project type first</div></button>
        ${proposalsEnabled() ? '<button type="button" class="r-toggle-btn" data-report-choice="proposal"><div class="r-toggle-icon"><i class="fas fa-file-signature"></i></div><div class="r-toggle-label">Build a Proposal</div><div class="r-toggle-sub"></div></button>' : ''}
        ${schedulingEnabled() ? '<button type="button" class="r-toggle-btn" data-report-choice="schedule"><div class="r-toggle-icon"><i class="fas fa-calendar-plus"></i></div><div class="r-toggle-label">Schedule Appointment</div><div class="r-toggle-sub"></div></button>' : ''}
      </div>
      <div class="r-report-order-group" id="rReportOptionGroup">
        <div class="r-addon-list" id="rReportAddons"></div>
        <div id="rRoofReportFields">
          <div class="r-pin-info" id="rPinInfo"><span class="r-pin-count">0</span><span class="r-pin-text">Click the map to place pins on each structure you want included.</span><button type="button" class="r-pin-clear" id="rPinClear">Clear All</button></div>
          <div class="r-pricing-note" id="rPricingNote"></div>
          <div class="r-referral-discount" id="rReferralDiscount"></div>
          <div class="r-confirm" id="rConfirm"><div class="ic" id="rConfirmIc"><i class="far fa-square"></i></div><div class="tx" id="rConfirmTx">I have placed a pin on every structure to be included in this report</div></div>
          <div class="r-mobile-pin-count" id="rMobilePinCount">No pins placed</div>
          <div class="r-group"><label>Notes for Technician ${infoTip('Any special instructions or details about the property that the technician should be aware of - e.g. detached garage, multiple buildings, steep slope, etc.')}</label><textarea class="r-inp" id="rTechNotes" placeholder="Anything the technician should know about this property..." rows="3" style="resize:vertical;min-height:72px;font-family:inherit;font-size:13px;line-height:1.45"></textarea></div>
          <div class="r-group"><label>CC for Roof Reports ${infoTip('Additional email addresses that should receive the completed roof report.')}</label><div class="r-cc-list" id="rCcList"></div><button type="button" class="r-cc-add" id="rCcAdd"><i class="fas fa-plus"></i> Add CC</button></div>
          <div class="r-mobile-internal-notes-mount" id="rMobileInternalNotesMount"></div>
          <button type="button" class="r-addon-toggle r-addon-inline r-gutter-inline" data-report-addon="gutters" data-addon-info="gutters">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-water"></i> Gutters ${addonInfoIcon('gutters')}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="gutters">+$${fmtMoney(GUTTER_REPORT_ADDON)}</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="r-addon-toggle r-addon-inline r-weather-inline" data-report-addon="weather" data-addon-info="weather">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-cloud-showers-heavy"></i> Historical Weather ${addonInfoIcon('weather')}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="weather">+$${fmtMoney(WEATHER_REPORT_ADDON)}</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="r-addon-toggle r-addon-inline r-instant-inline" data-report-addon="inspection" data-addon-info="inspection">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-bolt"></i> Instant Report ${addonInfoIcon('inspection')}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="inspection">Choose type</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="submit" class="r-btn primary r-report-submit" id="rSubmit" disabled>Order Roof Report</button>
        </div>
        <div class="r-expedite-panel" id="rExpeditePanel">
          <div class="r-expedite-wait" id="rExpediteWait"></div>
          <div class="r-expedite-options" id="rExpediteOptions"></div>
          <div class="r-expedite-coupon" id="rExpediteCouponNotice"></div>
          <button type="submit" class="r-btn primary r-report-submit r-expedite-submit" id="rExpediteSubmit" disabled>Order Roof Report</button>
        </div>
        <div class="r-schedule-choice-card" id="rScheduleChoiceCard"><i class="fas fa-calendar-week"></i><div><strong>Schedule appointment</strong>Use the Schedule tab to choose an appointment time for this project.</div></div>
        <div id="rRoofSkipSummary" class="r-photo-note" style="display:none"></div>
      </div></div></div></div>
    </section>
    <section class="r-step is-open r-proposal-section" id="rProposalSection">
      <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
        <label id="rProposalLabel">Proposal</label>
        <div class="r-proposal-listing" id="rProposalList"></div>
      </div></div></div>
    </section>
  </div>
  <div class="r-left-bottom">
    ${proposalAgentEnabled() ? `
      <div class="r-group r-proposal-agent collapsed" id="rProposalAgent">
        <div class="r-proposal-agent-head">
          <div class="r-proposal-agent-title">
            <i class="fas fa-wand-magic-sparkles"></i>
            <span>Proposal Agent</span>
            <span class="customer-report-tip">${infoTip('The model can use this prompt, project details, and photos uploaded to this project. Tell it what you want included in the proposal, what to emphasize, and any customer-specific details it should know.')}</span>
          </div>
          <button type="button" class="r-proposal-agent-toggle" id="rProposalAgentToggle" aria-label="Toggle Proposal Agent" aria-expanded="false"><i class="fas fa-chevron-up"></i></button>
        </div>
        <div class="r-proposal-agent-body">
          <div class="r-proposal-agent-textwrap">
            <textarea class="r-inp" id="rProposalAgentPrompt" placeholder="Tell the Proposal Agent what to include in this proposal..." rows="5"></textarea>
            <button type="button" class="r-proposal-agent-dictate" id="rProposalAgentDictate" aria-label="Dictate prompt" data-fm-tooltip="Dictate"><i class="fas fa-microphone"></i></button>
          </div>
          <button type="button" class="r-proposal-agent-submit" id="rProposalAgentSubmit" disabled>Generate Proposal Draft</button>
          <div class="r-proposal-agent-progress" id="rProposalAgentProgress"><span></span></div>
          <div class="r-proposal-agent-note">Use the prompt to describe the scope, tone, included photos, and anything the customer should see.</div>
        </div>
      </div>
    ` : ''}
    <div class="r-group r-bottom-notes">
      <div class="r-bottom-notes-head">
        <label>Internal Notes <span class="customer-report-tip">${infoTip(projectNotesTip)}</span></label>
        <button type="button" class="r-bottom-notes-toggle" id="rProjectNotesToggle" aria-label="Toggle project notes" aria-expanded="false"><i class="fas fa-chevron-up"></i></button>
      </div>
      <textarea class="r-inp" id="rProjectNotes" placeholder="Internal notes for your own reference..." rows="3" style="resize:vertical;font-family:inherit;font-size:13px;line-height:1.45"></textarea>
    </div>
    <button type="button" class="r-proposal-bottom-send" id="rProposalBottomSend"><i class="fas fa-paper-plane"></i> Send Proposal</button>
  </div>
  </form>
</div>`;
  }

  function mount(context = {}){
    const root = context.roots?.main || context.leftRoot || context.root || null;
    root?.setAttribute?.('data-firstmeasure-order-mounted', 'true');
    return {
      setActive(active){ root?.classList?.toggle('is-active-region-app', active !== false); },
      update(){},
      destroy(){ root?.removeAttribute?.('data-firstmeasure-order-mounted'); }
    };
  }

  const definition = {
    id: 'firstmeasure.order',
    package: 'firstmeasure/order',
    kind: 'project_modal_region_app',
    title: 'FirstMeasure Order Workflow',
    label: 'Order Workflow',
    icon: 'fa-file-lines',
    order: 5,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['left'],
    panelHtml,
    mount
  };

  runtime?.registerApp?.(definition);
  Portal.modules = Portal.modules || {};
  Portal.modules.firstMeasureOrder = { panelHtml, mount };
})();
