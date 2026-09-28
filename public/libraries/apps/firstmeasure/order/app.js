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
    const expanded = Portal?.capabilities?.value?.('platform.expanded_access', false) === true;
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
      <div class="r-title-wrap"><div class="r-title">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_0747045bf3d919","New Project") ?? "New Project")}</div></div>
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

${String(expanded ? `    <section class="r-step is-open" id="rStepCustomer" data-status="active">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body">
        <div class="r-group">
          <div class="r-contact-list" id="rContactList"></div>
          <button type="button" class="r-contact-add" id="rAddContact"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_50904398019722"," Add contact") ?? " Add contact")}</button>
        </div>
        <div class="r-step is-open r-project-address-step" id="rStepAddress" data-status="active">
          <div class="r-project-address-row">
            <input class="r-inp" id="rAddress" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_908c0715a481b7","Property address") ?? "Property address")}" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_908c0715a481b7","Property address") ?? "Property address")}" autocomplete="off" required>
          </div>
        </div>
        <div class="r-project-custom-fields" id="rProjectCustomFields"></div>
        <section class="r-step is-hidden" id="rStepType" data-status="locked">
          <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body"><div class="r-group"><label id="rStepTypeLabel">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_c9a026ebb1be8c","Property Type") ?? "Property Type")}</label><div class="r-choice-row" id="rTypeGroup">${buildTypeButtons()}</div><div class="r-type-pill-row" id="rTypePill"></div></div></div></div></div>
        </section>
        <div class="r-customer-portal-link" id="rCustomerPortalLinkMount"></div>
      </div></div></div>
    </section>
    <div class="r-inline-notes-mount" id="rInlineNotesMount"></div>

` : `    <section class="r-step is-open" id="rStepCustomer" data-status="active">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body">
        <div class="r-group">
          <div class="r-contact-list" id="rContactList"></div>
          <button type="button" class="r-contact-add" id="rAddContact"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_50904398019722"," Add contact") ?? " Add contact")}</button>
        </div>
      </div></div></div>
    </section>
    <div class="r-inline-notes-mount" id="rInlineNotesMount"></div>
    <div class="r-customer-portal-link" id="rCustomerPortalLinkMount"></div>

    <section class="r-step is-open" id="rStepAddress" data-status="active">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body"><div class="r-group"><label>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_1f6129f59f143b","Property Address") ?? "Property Address")}</label><input class="r-inp" id="rAddress" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_417e1dad6a313e","Start typing an address or click the map...") ?? "Start typing an address or click the map...")}" autocomplete="off" required></div></div></div></div>
    </section>

    <section class="r-step is-hidden" id="rStepType" data-status="locked">
      <div class="r-step-shell"><div class="r-step-inner"><div class="r-step-body"><div class="r-group"><label id="rStepTypeLabel">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_29f3cc51016963","Project Type") ?? "Project Type")}</label><div class="r-choice-row" id="rTypeGroup">${buildTypeButtons()}</div><div class="r-type-pill-row" id="rTypePill"></div></div></div></div></div>
    </section>

`)}
    <section class="r-workflow-dock" id="rWorkflowDock">
      <div class="r-workflow-empty" id="rWorkflowEmpty">
        <div class="r-workflow-empty-title">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_dc7e7fb5fb7d6f","Project To-dos") ?? "Project To-dos")}</div>
        <div class="r-workflow-todos" id="rProjectTodoList"></div>
      </div>
    </section>

    <section class="r-step is-hidden" id="rStepReport" data-status="locked">
      <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body" style="padding-top:2px"><div class="r-inline-label">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_6067958dea3386","Actions") ?? "Actions")}</div><div class="r-choice-row r-report-choice-row">
        <button type="button" class="r-toggle-btn" data-report-choice="roof"><div class="r-toggle-icon"><i class="fas fa-file-lines"></i></div><div class="r-toggle-label">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_337907c426ef7c","Order a Report") ?? "Order a Report")}</div><div class="r-toggle-sub" id="rRoofOnlySub">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_c4478c7a101b86","Choose a project type first") ?? "Choose a project type first")}</div></button>
        ${String(proposalsEnabled() ? `<button type="button" class="r-toggle-btn" data-report-choice="proposal"><div class="r-toggle-icon"><i class="fas fa-file-signature"></i></div><div class="r-toggle-label">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_5c6d435494fefd","Build a Proposal") ?? "Build a Proposal")}</div><div class="r-toggle-sub"></div></button>` : '')}
        ${String(schedulingEnabled() ? `<button type="button" class="r-toggle-btn" data-report-choice="schedule"><div class="r-toggle-icon"><i class="fas fa-calendar-plus"></i></div><div class="r-toggle-label">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_e5aee059bf2f35","Schedule Appointment") ?? "Schedule Appointment")}</div><div class="r-toggle-sub"></div></button>` : '')}
      </div>
      <div class="r-report-order-group" id="rReportOptionGroup">
        <div class="r-addon-list" id="rReportAddons"></div>
        <div id="rRoofReportFields">
          <div class="r-pin-info" id="rPinInfo"><span class="r-pin-count">0</span><span class="r-pin-text">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_307aacf37bc753","Click the map to place pins on each structure you want included.") ?? "Click the map to place pins on each structure you want included.")}</span><button type="button" class="r-pin-clear" id="rPinClear">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_d51957ef2a677f","Clear All") ?? "Clear All")}</button></div>
          <div class="r-pricing-note" id="rPricingNote"></div>
          <div class="r-referral-discount" id="rReferralDiscount"></div>
          <div id="rMobilePinStage"><div class="r-confirm" id="rConfirm"><div class="ic" id="rConfirmIc"><i class="far fa-square"></i></div><div class="tx" id="rConfirmTx">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_93a548f13a353b","I have placed a pin on every structure to be included in this report") ?? "I have placed a pin on every structure to be included in this report")}</div></div><button type="button" id="rMobilePinNext" hidden>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_dc6a60d7bb3581","Next ") ?? "Next ")}<i class="fas fa-arrow-right" aria-hidden="true"></i></button></div>
          <div class="r-mobile-pin-count" id="rMobilePinCount">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_01da28763ca647","No pins placed") ?? "No pins placed")}</div>
          <div class="r-group"><label>${((v3) => globalThis.PlatformLanguage?.htmlText("firstmeasure","m_ea717c27aecafc",`Notes for Technician ${v3}`,{v3}) ?? `Notes for Technician ${v3}`)(infoTip('Any special instructions or details about the property that the technician should be aware of - e.g. detached garage, multiple buildings, steep slope, etc.'))}</label><textarea class="r-inp" id="rTechNotes" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_1ac4cec881f322","Anything the technician should know about this property...") ?? "Anything the technician should know about this property...")}" rows="3" style="resize:vertical;min-height:72px;font-family:inherit;font-size:13px;line-height:1.45"></textarea></div>
          <div class="r-group"><label>${((v4) => globalThis.PlatformLanguage?.htmlText("firstmeasure","m_88f39d3061e014",`CC for Reports ${v4}`,{v4}) ?? `CC for Reports ${v4}`)(infoTip('Additional email addresses that should receive the completed report.'))}</label><div class="r-cc-list" id="rCcList"></div><button type="button" class="r-cc-add" id="rCcAdd"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_9adb5b7e4e80ed"," Add CC") ?? " Add CC")}</button></div>
          <div class="r-mobile-internal-notes-mount" id="rMobileInternalNotesMount"></div>
          <button type="button" class="r-addon-toggle r-addon-inline r-gutter-inline" data-report-addon="gutters" data-addon-info="gutters">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-water"></i>${((v5) => globalThis.PlatformLanguage?.htmlText("firstmeasure","m_265b3dbdedd86c",` Gutters ${v5}`,{v5}) ?? ` Gutters ${v5}`)(addonInfoIcon('gutters'))}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="gutters">+${String(window.PlatformCommerce.credit(GUTTER_REPORT_ADDON))}</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="r-addon-toggle r-addon-inline r-weather-inline" data-report-addon="weather" data-addon-info="weather">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-cloud-showers-heavy"></i>${((v7) => globalThis.PlatformLanguage?.htmlText("firstmeasure","m_b318a6c0bce8d9",` Historical Weather ${v7}`,{v7}) ?? ` Historical Weather ${v7}`)(addonInfoIcon('weather'))}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="weather">+${String(window.PlatformCommerce.credit(WEATHER_REPORT_ADDON))}</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="button" class="r-addon-toggle r-addon-inline r-instant-inline" data-report-addon="inspection" data-addon-info="inspection">
            <span class="r-addon-copy"><span class="r-addon-title"><i class="fas fa-bolt"></i>${((v9) => globalThis.PlatformLanguage?.htmlText("firstmeasure","m_bd0257416e7c2e",` Instant Report ${v9}`,{v9}) ?? ` Instant Report ${v9}`)(addonInfoIcon('inspection'))}</span></span>
            <span class="r-addon-side"><span class="r-addon-price" data-addon-price="inspection">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_0e5addb4bc1dfe","Choose type") ?? "Choose type")}</span><span class="r-switch" aria-hidden="true"></span></span>
          </button>
          <button type="submit" class="r-btn primary r-report-submit" id="rSubmit" disabled>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_c6b8fe87ff163f","Order Roof Report") ?? "Order Roof Report")}</button>
        </div>
        <div class="r-expedite-panel" id="rExpeditePanel">
          <div class="r-expedite-wait" id="rExpediteWait"></div>
          <div class="r-expedite-options" id="rExpediteOptions"></div>
          <div class="r-expedite-coupon" id="rExpediteCouponNotice"></div>
          <button type="submit" class="r-btn primary r-report-submit r-expedite-submit" id="rExpediteSubmit" disabled>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_c6b8fe87ff163f","Order Roof Report") ?? "Order Roof Report")}</button>
        </div>
        <div class="r-schedule-choice-card" id="rScheduleChoiceCard"><i class="fas fa-calendar-week"></i><div><strong>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_a0fb70645df93b","Schedule appointment") ?? "Schedule appointment")}</strong>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_23a51577d40b7b","Use the Schedule tab to choose an appointment time for this project.") ?? "Use the Schedule tab to choose an appointment time for this project.")}</div></div>
        <div id="rRoofSkipSummary" class="r-photo-note" style="display:none"></div>
      </div></div></div></div>
    </section>
    <section class="r-step is-open r-proposal-section" id="rProposalSection">
      <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
        <label id="rProposalLabel">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_1d8655e967c464","Proposal") ?? "Proposal")}</label>
        <div class="r-proposal-listing" id="rProposalList"></div>
      </div></div></div>
    </section>
  </div>
  <div class="r-left-bottom">
    ${String(proposalAgentEnabled() ? `
      <div class="r-group r-proposal-agent collapsed" id="rProposalAgent">
        <div class="r-proposal-agent-head">
          <div class="r-proposal-agent-title">
            <span>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_bd6349111bdda5","Proposal Agent") ?? "Proposal Agent")}</span>
            <span class="customer-report-tip">${infoTip('The model can use this prompt, project details, and photos uploaded to this project. Tell it what you want included in the proposal, what to emphasize, and any customer-specific details it should know.')}</span>
          </div>
          <button type="button" class="r-proposal-agent-toggle" id="rProposalAgentToggle" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_7ceca87ce420be","Toggle Proposal Agent") ?? "Toggle Proposal Agent")}" aria-expanded="false"><i class="fas fa-chevron-up"></i></button>
        </div>
        <div class="r-proposal-agent-body">
          <div class="r-proposal-agent-textwrap">
            <textarea class="r-inp" id="rProposalAgentPrompt" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_84f47d747cfe44","Tell the Proposal Agent what to include in this proposal...") ?? "Tell the Proposal Agent what to include in this proposal...")}" rows="5"></textarea>
            <button type="button" class="r-proposal-agent-dictate" id="rProposalAgentDictate" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_18fc56365bd838","Dictate prompt") ?? "Dictate prompt")}" data-fm-tooltip="Dictate"><i class="fas fa-microphone"></i></button>
          </div>
          <button type="button" class="r-proposal-agent-submit" id="rProposalAgentSubmit" disabled>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_a2d8046f355c56","Generate Proposal Draft") ?? "Generate Proposal Draft")}</button>
          <div class="r-proposal-agent-progress" id="rProposalAgentProgress"><span></span></div>
          <div class="r-proposal-agent-note">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_289b2e5bec972c","Use the prompt to describe the scope, tone, included photos, and anything the customer should see.") ?? "Use the prompt to describe the scope, tone, included photos, and anything the customer should see.")}</div>
        </div>
      </div>
    ` : '')}
    <button type="button" class="r-proposal-bottom-send" id="rProposalBottomSend"><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_186c285e35a2bf"," Send Proposal") ?? " Send Proposal")}</button>
${String(expanded ? `    <div class="r-group r-bottom-notes">
      <div class="r-note-history-deck" id="rProjectNoteHistoryDeck" aria-hidden="true">
        <div class="r-note-history-tools" id="rProjectNoteHistoryTools">
          <input type="search" id="rProjectNoteSearch" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_6643d210319486","Filter notes") ?? "Filter notes")}">
          <select id="rProjectNoteSort" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_5bfaf42a1f7ef2","Sort notes") ?? "Sort notes")}"><option value="newest">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_09ee09a435f087","Newest") ?? "Newest")}</option><option value="oldest">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_5a704a0a365cf0","Oldest") ?? "Oldest")}</option></select>
        </div>
        <div class="r-note-history" id="rProjectNoteHistory"></div>
      </div>
      <div class="r-note-composer-shell">
        <div class="r-bottom-notes-head">
          <label>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_971bee4a6a3550","Add Note ") ?? "Add Note ")}<span class="customer-report-tip">${infoTip(projectNotesTip)}</span></label>
          <span class="r-note-visibility-control"><span class="r-note-visibility-disclaimer">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_5e715bf9880366","Who can see it?") ?? "Who can see it?")}</span><span class="r-note-visibility-choice" id="rProjectNoteVisibility" role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_81cd5cfdb71ce1","Choose who can see this note") ?? "Choose who can see this note")}" aria-expanded="false" data-fm-tooltip="Visibility"><strong id="rProjectNoteVisibilityLabel">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_d068fb68fb07d2","Everybody") ?? "Everybody")}</strong><i class="fas fa-eye"></i></span></span>
        </div>
        <div class="r-note-visibility-menu" id="rProjectNoteVisibilityMenu" hidden></div>
        <div class="r-note-input-wrap">
          <div class="r-note-input-highlights" id="rProjectNoteHighlights" aria-hidden="true"></div>
          <textarea class="r-inp" id="rProjectNotes" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_3bad1b1f1d93ba","Add an internal note… Use @name or @email to tag someone.") ?? "Add an internal note… Use @name or @email to tag someone.")}" rows="2"></textarea>
        </div>
        <div id="rProjectAudioPending"></div>
        <div class="r-note-compose-actions">
          <span class="r-note-history-toggle" id="rProjectNotesToggle" role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_14d6270ea986dc","View note history") ?? "View note history")}" aria-expanded="false"><i class="fas fa-clock-rotate-left"></i><span>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_3fe33cd11f8a29","History") ?? "History")}</span><i class="fas fa-chevron-up r-note-history-chevron"></i></span>
          <span class="r-note-compose-right"><input type="file" id="rProjectNoteUploadInput" accept="image/*,video/*,audio/*,.pdf,.doc,.docx" hidden><button type="button" class="r-note-audio" id="rProjectNoteUpload" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_d3fd8350167dd9","Upload media to note") ?? "Upload media to note")}" data-fm-tooltip="Upload media"><i class="fas fa-paperclip"></i></button><button type="button" class="r-note-audio" id="rProjectAudioNote" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_dd978d5c5b3bd9","Record audio note") ?? "Record audio note")}" data-fm-tooltip="Record audio note"><i class="fas fa-microphone"></i></button><button type="button" id="rProjectNoteAdd"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_fa1d10be2766ee"," Add note") ?? " Add note")}</button></span>
        </div>
      </div>
    </div>` : `    <div class="r-group r-bottom-notes r-firstmeasure-notes">
      <div class="r-bottom-notes-head">
        <label for="rProjectNotes">${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_5bbba2df4ff973","Internal Notes ") ?? "Internal Notes ")}<span class="customer-report-tip">${infoTip(projectNotesTip)}</span></label>
        <button type="button" class="r-bottom-notes-toggle" id="rProjectNotesToggle" aria-label="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_2b31fcca2dfee1","Expand internal notes") ?? "Expand internal notes")}" aria-controls="rProjectNotes" aria-expanded="false"><i class="fas fa-chevron-up"></i></button>
      </div>
      <textarea class="r-inp" id="rProjectNotes" placeholder="${(globalThis.PlatformLanguage?.htmlText("firstmeasure","m_69afca2b27d860","Internal notes for your own reference...") ?? "Internal notes for your own reference...")}" rows="3"></textarea>
    </div>
`)}
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
    title: (globalThis.PlatformLanguage?.text("firstmeasure","m_83a10fdb954ac4","FirstMeasure Order Workflow") ?? "FirstMeasure Order Workflow"),
    label: (globalThis.PlatformLanguage?.text("firstmeasure","m_ff3aa02a7ffc8f","Order Workflow") ?? "Order Workflow"),
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
