(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};

  const STATUS_BAR_CONFIG = Object.freeze({
    refreshMs: 10000,
    averageLookbackHours: 1,
    averageGoodMs: 60 * 60 * 1000,
    averageWarnMs: 2 * 60 * 60 * 1000,
    warningAgeHours: 3,
    criticalWarningAgeHours: 4,
    excludeTestProjects: true,
    excludeTutorialProjects: true,
  });

  const StatusBar = {
    state: {
      timer: null,
      rushTimer: null,
      loading: false,
      snapshot: null,
      rush: null,
      visibilityBound: false,
    },

    init(){
      if (!document.getElementById('portalStatusBarMount')) return;
      if (this.shouldHideBar()) {
        this.hideMount();
        return;
      }

      this.ensureStyles();
      this.showMount();
      this.renderLoading();
      this.refresh(true);

      if (!this.state.timer) {
        this.state.timer = setInterval(() => this.refresh(false), STATUS_BAR_CONFIG.refreshMs);
      }

      if (!this.state.visibilityBound) {
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) this.refresh(false);
        });
        this.state.visibilityBound = true;
      }

      window.PortalStatusBar = this;
    },

    shouldHideBar(){
      if (cfg().flags?.is_drafting_technician) return true;
      return !cfg().user?.training_complete && !cfg().user?.is_admin;
    },

    isManagerView(){
      const user = cfg().user || {};
      const perms = cfg().perms || {};
      const flags = cfg().flags || {};
      return !!user.is_admin || user.role === 'admin' || !!flags.is_manager_role || !!perms.manage_queue;
    },

    isQaView(){
      if (this.isManagerView()) return false;
      const perms = cfg().perms || {};
      const flags = cfg().flags || {};
      return !!flags.is_qa_role || !!perms.manage_qa || !!perms.manage_qa_queue;
    },

    viewMode(){
      if (this.isManagerView()) return 'manager';
      if (this.isQaView()) return 'qa';
      return 'technician';
    },

    getMount(){
      return document.getElementById('portalStatusBarMount');
    },

    hideMount(){
      const mount = this.getMount();
      if (!mount) return;
      mount.innerHTML = '';
      mount.style.display = 'none';
    },

    showMount(){
      const mount = this.getMount();
      if (!mount) return;
      mount.style.display = '';
    },

    ensureStyles(){
      if (document.getElementById('portalStatusBarStyles')) return;
      const style = document.createElement('style');
      style.id = 'portalStatusBarStyles';
      style.textContent = `
        #portalStatusBarMount {
          position: sticky;
          top: 0;
          z-index: 40;
          width: 100%;
          margin: 0 0 24px;
        }
        body.qa-editor-fullscreen #portalStatusBarMount {
          display: none !important;
          position: static !important;
          width: 0 !important;
          height: 0 !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
        }
        .portal-status-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 6px 12px;
          min-height: 38px;
          border-bottom: 1px solid rgba(218, 220, 224, 0.95);
          background: rgba(255, 255, 255, 0.93);
          box-shadow: none;
          backdrop-filter: blur(12px);
        }
        .portal-status-bar--personal {
          border-bottom-color: rgba(219, 161, 41, 0.35);
          background:
            linear-gradient(90deg, rgba(255, 247, 230, 0.96) 0%, rgba(255, 255, 255, 0.96) 55%),
            rgba(255, 255, 255, 0.96);
        }
        .portal-status-bar--qa {
          border-bottom-color: rgba(112, 82, 190, 0.30);
          background:
            linear-gradient(90deg, rgba(242, 237, 255, 0.96) 0%, rgba(255, 255, 255, 0.96) 58%),
            rgba(255, 255, 255, 0.96);
        }
        .portal-status-bar--rush {
          border-bottom-color: rgba(234, 88, 12, 0.85);
          background:
            linear-gradient(90deg, rgba(255, 126, 36, 0.92) 0%, rgba(255, 150, 57, 0.88) 42%, rgba(255, 247, 237, 0.96) 100%),
            #fff7ed;
        }
        .portal-status-left,
        .portal-status-right {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
        }
        .portal-status-left {
          flex: 1 1 auto;
          min-width: 0;
        }
        .portal-status-right {
          flex: 0 0 auto;
          justify-content: flex-end;
        }
        .portal-status-chip {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 26px;
          padding: 4px 9px;
          border-radius: 999px;
          border: 1px solid #e7eaee;
          background: #fff;
          color: #374151;
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
          white-space: nowrap;
        }
        button.portal-status-chip {
          appearance: none;
          cursor: pointer;
          font-family: inherit;
        }
        .portal-status-chip.is-dim {
          background: #f8f9fa;
          color: #9aa0a6;
        }
        .portal-status-chip--metric {
          gap: 8px;
          font-weight: 800;
        }
        .portal-status-chip--good {
          background: #eef8f1;
          border-color: #cce5d2;
          color: #1d6f3a;
        }
        .portal-status-chip--warn {
          background: #fff7e0;
          border-color: #ffe09a;
          color: #9b6700;
        }
        .portal-status-chip--bad {
          background: #fce8e6;
          border-color: #f28b82;
          color: #a50e0e;
        }
        .portal-status-chip--alert {
          background: #fce8e6;
          border-color: #ea4335;
          color: #b3261e;
        }
        .portal-status-chip--action {
          transition: transform 0.18s ease, background-color 0.18s ease, border-color 0.18s ease;
        }
        .portal-status-chip--action:hover {
          transform: translateY(-1px);
        }
        .portal-status-chip--urgent {
          animation: portalStatusAlertPulse 1.4s ease-in-out infinite;
        }
        .portal-status-chip--notice {
          background: #fff7e0;
          border-color: #fbbc04;
          color: #9b6700;
        }
        .portal-status-chip--focus {
          background: #fff3cd;
          border-color: #f6c453;
          color: #8a4b00;
        }
        .portal-status-chip--qa {
          background: #f0ebff;
          border-color: #c9bcff;
          color: #5a3fc0;
        }
        .portal-status-chip--rush {
          background: #9a3412;
          border-color: rgba(255,255,255,0.55);
          color: #fff;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          box-shadow: 0 2px 10px rgba(154, 52, 18, 0.24);
        }
        .portal-status-chip--rush .portal-status-value {
          color: #fff7ed;
          letter-spacing: 0;
        }
        .portal-status-value {
          font-size: 12px;
          font-weight: 900;
          letter-spacing: -0.02em;
        }
        .portal-status-label {
          white-space: nowrap;
        }
        .portal-status-icon {
          font-size: 12px;
        }
        .portal-status-help {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 1px solid currentColor;
          font-size: 10px;
          font-weight: 900;
          opacity: 0.78;
          cursor: help;
          flex: 0 0 auto;
        }
        .portal-status-help:focus {
          outline: 2px solid rgba(26, 115, 232, 0.2);
          outline-offset: 2px;
        }
        .portal-status-help-text {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: min(280px, 70vw);
          padding: 10px 11px;
          border-radius: 10px;
          background: #202124;
          color: #fff;
          font-size: 11px;
          font-weight: 600;
          line-height: 1.45;
          white-space: normal;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24);
          opacity: 0;
          pointer-events: none;
          transform: translateY(-4px);
          transition: opacity 0.16s ease, transform 0.16s ease;
          z-index: 5;
        }
        .portal-status-help:hover .portal-status-help-text,
        .portal-status-help:focus .portal-status-help-text {
          opacity: 1;
          transform: translateY(0);
        }
        .portal-status-skeleton {
          min-width: 86px;
          color: transparent;
          background:
            linear-gradient(90deg, rgba(241,243,244,0.95) 0%, rgba(255,255,255,0.95) 50%, rgba(241,243,244,0.95) 100%);
          background-size: 200% 100%;
          animation: portalStatusPulse 1.35s ease-in-out infinite;
        }
        .portal-status-inline-note {
          color: #80868b;
          font-size: 11px;
          font-weight: 700;
        }
        .portal-status-role {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 5px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          background: #fff8e1;
          border: 1px solid #f6c453;
          color: #8a4b00;
        }
        .portal-status-role.qa {
          background: #f2edff;
          border-color: #c9bcff;
          color: #5a3fc0;
        }
        @keyframes portalStatusAlertPulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(217, 48, 37, 0.16);
          }
          50% {
            transform: scale(1.035);
            box-shadow: 0 0 0 5px rgba(217, 48, 37, 0);
          }
        }
        @keyframes portalStatusPulse {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (max-width: 1100px) {
          .portal-status-bar {
            align-items: flex-start;
            flex-direction: column;
          }
          .portal-status-right {
            width: 100%;
            justify-content: flex-start;
          }
          .portal-status-help-text {
            left: 0;
            right: auto;
          }
        }
      `;
      document.head.appendChild(style);
    },

    renderLoading(){
      const mount = this.getMount();
      if (!mount) return;
      const mode = this.viewMode();
      const label = mode === 'qa' ? 'QA' : (mode === 'manager' ? 'Average' : 'Shift');
      mount.innerHTML = `
        <div class="portal-status-bar ${mode === 'qa' ? 'portal-status-bar--personal portal-status-bar--qa' : (mode === 'technician' ? 'portal-status-bar--personal' : '')}">
          <div class="portal-status-left">
            <span class="portal-status-chip portal-status-skeleton">${label}</span>
            <span class="portal-status-chip portal-status-skeleton">Projects</span>
          </div>
          <div class="portal-status-right">
            <span class="portal-status-chip portal-status-skeleton">Loading</span>
          </div>
        </div>
      `;
    },

    renderError(){
      const mount = this.getMount();
      if (!mount) return;
      mount.innerHTML = `
        <div class="portal-status-bar">
          <div class="portal-status-left">
            <span class="portal-status-chip is-dim">Status unavailable</span>
          </div>
        </div>
      `;
    },

    async fetchManagerSnapshot(){
      const payload = {
        average_lookback_hours: String(STATUS_BAR_CONFIG.averageLookbackHours),
        warning_age_hours: String(STATUS_BAR_CONFIG.warningAgeHours),
        critical_warning_age_hours: String(STATUS_BAR_CONFIG.criticalWarningAgeHours),
        exclude_test_projects: STATUS_BAR_CONFIG.excludeTestProjects ? '1' : '0',
        exclude_tutorial_projects: STATUS_BAR_CONFIG.excludeTutorialProjects ? '1' : '0',
      };
      return await window.Portal.fmPost('status/snapshot', payload);
    },

    async fetchPersonalSnapshot(){
      const endpoint = (cfg().endpoints && cfg().endpoints.server) ? cfg().endpoints.server : window.Portal.internalLegacyEndpoint();
      return await window.Portal.apiPost(endpoint, { action: 'shift_personal_snapshot' });
    },

    async fetchRushMode(){
      if (this.isQaView()) return { active: false, rush_mode: null };
      const endpoint = (cfg().endpoints && cfg().endpoints.server) ? cfg().endpoints.server : window.Portal.internalLegacyEndpoint();
      return await window.Portal.apiPost(endpoint, { action: 'rush_mode_current' });
    },

    async refresh(showLoading){
      if (this.shouldHideBar()) {
        this.hideMount();
        return;
      }
      this.showMount();
      if (this.state.loading) return;
      this.state.loading = true;
      if (showLoading && !this.state.snapshot) this.renderLoading();

      try {
        const [data, rush] = await Promise.all([
          this.isManagerView()
            ? this.fetchManagerSnapshot()
            : this.fetchPersonalSnapshot(),
          this.fetchRushMode().catch(() => ({ active: false, rush_mode: null }))
        ]);
        if (!data || data.success === false) throw new Error(data?.error || 'Status fetch failed.');
        data.rush_mode = rush && rush.active ? rush.rush_mode : null;
        this.state.snapshot = data;
        this.state.rush = data.rush_mode;
        this.render(data);
      } catch (err) {
        console.error('Portal status bar failed to refresh:', err);
        this.renderError();
      } finally {
        this.state.loading = false;
      }
    },

    render(data){
      if (this.isManagerView()) {
        this.renderManagerBar(data);
        return;
      }
      if (this.isQaView()) {
        this.renderQaBar(data);
        return;
      }
      this.renderTechnicianBar(data);
    },

    renderManagerBar(data){
      const mount = this.getMount();
      if (!mount) return;

      const counts = Array.isArray(data.status_counts) ? data.status_counts : [];
      const countChips = counts.map((item) => this.renderCountChip(item)).join('');

      const averageMs = Number.isFinite(Number(data.average_completion_ms))
        ? Number(data.average_completion_ms)
        : null;
      const averageCount = Number(data.average_completion_count || 0);
      const averageTone = this.averageToneClass(averageMs);
      const averageText = averageMs === null ? '--' : this.formatDuration(averageMs);
      const averageHelp = this.escapeHtml(
        `Average completion time for ${averageCount} non-filler production project${averageCount === 1 ? '' : 's'} completed in the last ${this.formatLookback(STATUS_BAR_CONFIG.averageLookbackHours)}. Green is under ${this.formatDuration(STATUS_BAR_CONFIG.averageGoodMs)}, yellow is under ${this.formatDuration(STATUS_BAR_CONFIG.averageWarnMs)}, and red is ${this.formatDuration(STATUS_BAR_CONFIG.averageWarnMs)} or higher.`
      );

      const warningCount = Number(data.warning_count || 0);
      const criticalWarningCount = Number(data.critical_warning_count || 0);
      const warningHelp = this.escapeHtml(
        `The warning turns on once any active non-filler production project is older than ${this.formatHours(STATUS_BAR_CONFIG.warningAgeHours)} from submission. The number shown is how many are older than ${this.formatHours(STATUS_BAR_CONFIG.criticalWarningAgeHours)}. Right now: ${warningCount} over ${this.formatHours(STATUS_BAR_CONFIG.warningAgeHours)}, ${criticalWarningCount} over ${this.formatHours(STATUS_BAR_CONFIG.criticalWarningAgeHours)}.`
      );

      const warningHtml = warningCount > 0
        ? `
          <div class="portal-status-chip portal-status-chip--metric portal-status-chip--alert">
            <i class="fas fa-triangle-exclamation portal-status-icon" aria-hidden="true"></i>
            <span class="portal-status-label">Warning</span>
            <span class="portal-status-value">${this.escapeHtml(String(criticalWarningCount))}</span>
            ${this.renderHelp(warningHelp)}
          </div>
        `
        : '';

      const rushHtml = this.renderRushChip(data.rush_mode);
      mount.innerHTML = `
        <div class="portal-status-bar ${data.rush_mode ? 'portal-status-bar--rush' : ''}">
          <div class="portal-status-left">
            ${countChips}
          </div>
          <div class="portal-status-right">
            ${rushHtml}
            <div class="portal-status-chip portal-status-chip--metric ${averageTone}">
              <span class="portal-status-label">Avg</span>
              <span class="portal-status-value">${this.escapeHtml(averageText)}</span>
              ${this.renderHelp(averageHelp)}
            </div>
            ${warningHtml}
          </div>
        </div>
      `;
      this.startRushCountdown(data.rush_mode);

      mount.querySelectorAll('[data-portal-status-action="queue"]').forEach((chip) => {
        chip.addEventListener('click', () => this.switchToQueueView(chip.getAttribute('data-portal-status-target') || ''));
      });
    },

    renderTechnicianBar(data){
      const mount = this.getMount();
      if (!mount) return;
      const tech = data?.stats?.technician || {};
      const shift = data?.shift || {};
      const avgMs = Number.isFinite(Number(tech.average_work_ms)) ? Number(tech.average_work_ms) : null;
      const avgText = avgMs === null ? '--' : this.formatDuration(avgMs);
      const avgHelp = this.escapeHtml(
        `Average working time for projects you submitted to QA during this shift. This includes the initial work segment plus any correction rounds you completed during the same shift window.`
      );
      const shiftLabel = this.escapeHtml(this.formatShiftLabel(shift));
      const rushHtml = this.renderRushChip(data.rush_mode);
      mount.innerHTML = `
        <div class="portal-status-bar portal-status-bar--personal ${data.rush_mode ? 'portal-status-bar--rush' : ''}">
          <div class="portal-status-left">
            <span class="portal-status-role"><i class="fas fa-screwdriver-wrench"></i> Technician Shift</span>
            <span class="portal-status-chip portal-status-chip--focus">
              <span class="portal-status-label">${shiftLabel}</span>
            </span>
          </div>
          <div class="portal-status-right">
            ${rushHtml}
            ${this.renderMetricChip('Avg Work', avgText, avgMs === null ? '' : this.averageToneClass(avgMs), avgHelp)}
            ${this.renderMetricChip('Kickbacks / Project', this.formatDecimal(tech.kickbacks_per_project), '', 'Average number of QA kickbacks attached to the projects you submitted during this shift.')}
            ${this.renderMetricChip('Completed Today', String(Number(tech.completed_projects || 0)), '', 'Unique projects you submitted to QA during this shift.')}
            ${this.renderMetricChip('Projects / Hr', this.formatDecimal(tech.projects_per_hour), '', 'Submitted projects divided by elapsed shift hours.')}
          </div>
        </div>
      `;
      this.startRushCountdown(data.rush_mode);
    },

    renderQaBar(data){
      const mount = this.getMount();
      if (!mount) return;
      const qa = data?.stats?.qa || {};
      const shift = data?.shift || {};
      const avgMs = Number.isFinite(Number(qa.average_decision_ms)) ? Number(qa.average_decision_ms) : null;
      const avgText = avgMs === null ? '--' : this.formatDuration(avgMs);
      const shiftLabel = this.escapeHtml(this.formatShiftLabel(shift));
      mount.innerHTML = `
        <div class="portal-status-bar portal-status-bar--personal portal-status-bar--qa">
          <div class="portal-status-left">
            <span class="portal-status-role qa"><i class="fas fa-shield-check"></i> QA Shift</span>
            <span class="portal-status-chip portal-status-chip--qa">
              <span class="portal-status-label">${shiftLabel}</span>
            </span>
          </div>
          <div class="portal-status-right">
            ${this.renderMetricChip('Avg Decision', avgText, avgMs === null ? '' : 'portal-status-chip--qa', 'Average time from claiming a QA project to approving or kicking it back during this shift.')}
            ${this.renderMetricChip('QA Submitted Today', String(Number(qa.submitted_projects || 0)), 'portal-status-chip--qa', 'Projects you decided during this shift.')}
            ${this.renderMetricChip('Approved', String(Number(qa.approved_projects || 0)), '', 'Projects approved by you during this shift.')}
            ${this.renderMetricChip('Kick Backs', String(Number(qa.kickback_projects || 0)), '', 'Projects sent back by you during this shift.')}
          </div>
        </div>
      `;
      this.startRushCountdown(null);
    },

    renderRushChip(rushMode){
      if (!rushMode || this.isQaView()) return '';
      const endAt = Date.parse(String(rushMode.end_at || ''));
      const remaining = Number.isFinite(endAt) ? Math.max(0, Math.ceil((endAt - Date.now()) / 1000)) : Number(rushMode.remaining_seconds || 0);
      const bonus = Number(rushMode.bonus_percent || rushMode.bonus_amount || 25);
      const help = this.escapeHtml(`Projects completed during the rush period earn a ${bonus}% bonus.`);
      return `
        <div class="portal-status-chip portal-status-chip--metric portal-status-chip--rush">
          <i class="fas fa-bolt portal-status-icon" aria-hidden="true"></i>
          <span class="portal-status-label">RUSH MODE</span>
          <span class="portal-status-value" data-rush-countdown>${this.escapeHtml(this.formatCountdown(remaining))}</span>
          ${this.renderHelp(help)}
        </div>
      `;
    },

    startRushCountdown(rushMode){
      if (this.state.rushTimer) {
        clearInterval(this.state.rushTimer);
        this.state.rushTimer = null;
      }
      if (!rushMode) return;
      const endAt = Date.parse(String(rushMode.end_at || ''));
      if (!Number.isFinite(endAt)) return;
      const tick = () => {
        const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        document.querySelectorAll('[data-rush-countdown]').forEach((el) => {
          el.textContent = this.formatCountdown(remaining);
        });
        if (remaining <= 0 && this.state.rushTimer) {
          clearInterval(this.state.rushTimer);
          this.state.rushTimer = null;
          this.refresh(false);
        }
      };
      tick();
      this.state.rushTimer = setInterval(tick, 1000);
    },

    renderMetricChip(label, value, extraClass = '', helpText = ''){
      return `
        <div class="portal-status-chip portal-status-chip--metric ${extraClass}">
          <span class="portal-status-label">${this.escapeHtml(label)}</span>
          <span class="portal-status-value">${this.escapeHtml(value)}</span>
          ${helpText ? this.renderHelp(this.escapeHtml(helpText)) : ''}
        </div>
      `;
    },

    renderCountChip(item){
      const count = Number(item?.count || 0);
      const key = String(item?.key || '');
      const label = key === 'needs_structure_pins' ? 'Needs Pins' : String(item?.label || key || 'Status');
      const isNeedsPins = key === 'needs_structure_pins';
      const isRequeue = key === 'requeue';
      const canSwitchToQueue = (isNeedsPins || isRequeue) && !!document.getElementById('navQueueBtn');
      const classes = [
        'portal-status-chip',
        count === 0 ? 'is-dim' : '',
        canSwitchToQueue ? 'portal-status-chip--action' : '',
        (isNeedsPins && count > 0) ? 'portal-status-chip--alert portal-status-chip--urgent' : '',
        (isRequeue && count > 0) ? 'portal-status-chip--notice portal-status-chip--urgent' : '',
      ].filter(Boolean).join(' ');
      const iconHtml = (count > 0 && (isNeedsPins || isRequeue))
        ? `<i class="fas ${isNeedsPins ? 'fa-location-dot' : 'fa-triangle-exclamation'} portal-status-icon" aria-hidden="true"></i>`
        : '';

      if (canSwitchToQueue) {
        return `
          <button type="button" class="${classes}" data-portal-status-action="queue" data-portal-status-target="${this.escapeHtml(isNeedsPins ? 'qRowStructurePins' : 'qRowRequeue')}" title="${this.escapeHtml(isNeedsPins ? 'Open Queue to place structure pins' : 'Open Queue to manually re-queue these projects')}">
            ${iconHtml}
            <span class="portal-status-value">${this.escapeHtml(String(count))}</span>
            <span class="portal-status-label">${this.escapeHtml(label)}</span>
          </button>
        `;
      }

      return `
        <div class="${classes}">
          ${iconHtml}
          <span class="portal-status-value">${this.escapeHtml(String(count))}</span>
          <span class="portal-status-label">${this.escapeHtml(label)}</span>
        </div>
      `;
    },

    renderHelp(text){
      return `
        <span class="portal-status-help" tabindex="0" aria-label="More info">
          ?
          <span class="portal-status-help-text">${text}</span>
        </span>
      `;
    },

    averageToneClass(ms){
      if (!Number.isFinite(ms) || ms === null) return '';
      if (ms < STATUS_BAR_CONFIG.averageGoodMs) return 'portal-status-chip--good';
      if (ms < STATUS_BAR_CONFIG.averageWarnMs) return 'portal-status-chip--warn';
      return 'portal-status-chip--bad portal-status-chip--urgent';
    },

    switchToQueueView(targetId = ''){
      const navBtn = document.getElementById('navQueueBtn');
      if (!navBtn || !window.Portal?.switchView) return;
      Promise.resolve(window.Portal.switchView('queue', navBtn)).then(() => {
        if (!targetId) return;
        setTimeout(() => {
          const target = document.getElementById(targetId);
          const section = target ? target.closest('.queue-section') : null;
          if (!section) return;
          section.classList.remove('collapsed');
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      });
    },

    formatShiftLabel(shift){
      const blocks = Array.isArray(shift?.blocks) ? shift.blocks : [];
      const shiftDate = String(shift?.date || '').trim();
      if (shiftDate && blocks.length && window.Shifts && typeof window.Shifts.serverToLocal === 'function') {
        let earliest = null;
        let latest = null;
        blocks.forEach((block) => {
          if (!block || !block.start || !block.end) return;
          const startLocal = window.Shifts.serverToLocal(shiftDate, block.start);
          const endServerDate = String(block.end) < String(block.start)
            ? this.addDaysYmd(shiftDate, 1)
            : shiftDate;
          const endLocal = window.Shifts.serverToLocal(endServerDate, block.end);
          if (startLocal?.time && (!earliest || startLocal.time < earliest)) earliest = startLocal.time;
          if (endLocal?.time && (!latest || endLocal.time > latest)) latest = endLocal.time;
        });
        if (earliest && latest) {
          return `${this.labelTime(earliest)} - ${this.labelTime(latest)}`;
        }
      }
      const start = shift?.start ? new Date(shift.start) : null;
      const end = shift?.end ? new Date(shift.end) : null;
      if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) {
        return 'Today';
      }
      return `${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    },

    formatDecimal(value){
      const num = Number(value || 0);
      if (!Number.isFinite(num)) return '0';
      return num.toFixed(num >= 10 || Math.abs(num % 1) < 0.001 ? 0 : 2).replace(/\.00$/, '');
    },

    labelTime(hhmm){
      const [hourRaw, minuteRaw] = String(hhmm || '').split(':');
      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return String(hhmm || '');
      const d = new Date();
      d.setHours(hour, minute, 0, 0);
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },

    addDaysYmd(ymd, days){
      const [year, month, day] = String(ymd || '').split('-').map(Number);
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return String(ymd || '');
      const dt = new Date(Date.UTC(year, month - 1, day));
      dt.setUTCDate(dt.getUTCDate() + days);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    },

    formatDuration(ms){
      const totalMinutes = Math.max(0, Math.round(ms / 60000));
      if (totalMinutes < 60) return `${totalMinutes}m`;
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
    },

    formatCountdown(seconds){
      const safe = Math.max(0, Math.floor(Number(seconds) || 0));
      const hours = Math.floor(safe / 3600);
      const minutes = Math.floor((safe % 3600) / 60);
      const secs = safe % 60;
      return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`;
    },

    formatLookback(hours){
      if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
      const days = hours / 24;
      if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
      return `${hours} hours`;
    },

    formatHours(hours){
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    },

    escapeHtml(value){
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => StatusBar.init(), { once: true });
  } else {
    StatusBar.init();
  }
})();
