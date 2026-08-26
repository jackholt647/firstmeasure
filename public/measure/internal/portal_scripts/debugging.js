(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;

  const Debugging = {
    initialized: false,
    activeTab: 'projects',
    running: false,
    lastRun: null,
    results: [],
    issues: [],
    logs: [],
    toolState: {
      loading: false,
      rebuilding: false,
      indexStatus: null,
      runtime: null,
      lastLoadedAt: null,
      banner: null,
      logs: [],
      autoLoadAttempted: false,
      endpointUnavailable: false
    },

    init(){
      if (this.initialized) return;
      this.initialized = true;

      const runBtn = document.getElementById('dbgRunBtn');
      if (runBtn && !runBtn.dataset.wired) {
        runBtn.dataset.wired = 'true';
        runBtn.addEventListener('click', () => this.runFullDiagnostics());
      }

      const refreshIndexBtn = document.getElementById('dbgRefreshIndexStatusBtn');
      if (refreshIndexBtn && !refreshIndexBtn.dataset.wired) {
        refreshIndexBtn.dataset.wired = 'true';
        refreshIndexBtn.addEventListener('click', () => this.refreshToolsStatus());
      }

      const rebuildIndexBtn = document.getElementById('dbgRebuildIndexBtn');
      if (rebuildIndexBtn && !rebuildIndexBtn.dataset.wired) {
        rebuildIndexBtn.dataset.wired = 'true';
        rebuildIndexBtn.addEventListener('click', () => this.rebuildFirstMeasureIndex());
      }

      Portal.qsa('[data-debug-tab]').forEach(btn => {
        if (btn.dataset.wired === 'true') return;
        btn.dataset.wired = 'true';
        btn.addEventListener('click', () => this.setActiveTab(btn.getAttribute('data-debug-tab') || 'projects'));
      });

      this.render();
    },

    async onShowDebugging(){
      this.init();
      this.ensureToolsStatusLoaded();
      this.render();
    },

    actor(){
      const user = cfg().user || {};
      const flags = cfg().flags || {};
      const roles = [];
      if (String(user.role || '').toLowerCase() === 'admin') roles.push('admin');
      if (flags.is_queue_admin) roles.push('queue_admin');
      if (flags.can_debug_firstmeasure) roles.push('firstmeasure_debugger');
      return {
        email: user.email || '',
        name: user.name || '',
        roles
      };
    },

    options(){
      return {
        useServerDebug: !!document.getElementById('dbgUseServerDebug')?.checked,
        includeBinaryChecks: !!document.getElementById('dbgIncludeBinaryChecks')?.checked
      };
    },

    setActiveTab(tab){
      this.activeTab = tab || 'projects';
      Portal.qsa('[data-debug-tab]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-debug-tab') === this.activeTab));
      const show = (id, visible) => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? 'block' : 'none';
      };
      const runBtn = document.getElementById('dbgRunBtn');
      if (runBtn) runBtn.style.display = this.activeTab === 'projects' ? 'inline-flex' : 'none';
      show('dbgPanelProjects', this.activeTab === 'projects');
      show('dbgProjectsWorkspace', this.activeTab === 'projects');
      show('dbgPanelUsers', this.activeTab === 'users');
      show('dbgPanelOrganizations', this.activeTab === 'organizations');
      show('dbgPanelTools', this.activeTab === 'tools');
      this.ensureToolsStatusLoaded();
    },

    fmtTs(ts){
      if (!ts) return 'Never';
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    },

    fmtMs(ms){
      const n = Number(ms || 0);
      if (!Number.isFinite(n)) return '-';
      return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
    },

    fmtBytes(bytes){
      const n = Number(bytes || 0);
      if (!Number.isFinite(n)) return '-';
      if (n < 1024) return `${n} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1048576).toFixed(2)} MB`;
    },

    fmtRuntimeStamp(runtime){
      if (!runtime || typeof runtime !== 'object') return 'Runtime unavailable';
      const started = runtime.process_started_at ? this.fmtTs(runtime.process_started_at) : 'Unknown restart';
      const code = runtime.api_module_updated_at ? this.fmtTs(runtime.api_module_updated_at) : 'Unknown code stamp';
      return `${started} | code ${code}`;
    },

    extractApiFailure({ response, data }){
      if (response?.ok && !(data && typeof data === 'object' && data.ok === false)) return null;
      if (data?.debug_error?.message) return String(data.debug_error.message);
      if (data?.message) return String(data.message);
      if (data?.error) return String(data.error);
      if (response?.status) return `HTTP ${response.status}`;
      return 'Request failed';
    },

    label(status){
      return status === 'fail' ? 'Fail' : status === 'skip' ? 'Skipped' : status === 'warn' ? 'Warning' : 'Pass';
    },

    banner(message){
      const el = document.getElementById('dbgStatusBanner');
      if (!el) return;
      if (!message) {
        el.className = 'debug-status-banner';
        el.innerHTML = '';
        return;
      }
      el.className = 'debug-status-banner show';
      el.innerHTML = `<i class="fas fa-wave-square"></i><span>${Portal.escapeHtml(message)}</span>`;
    },

    setToolsBanner(type, message){
      this.toolState.banner = message ? { type: type || 'info', message } : null;
    },

    summarize(){
      if (!this.lastRun) return 'Waiting for first run';
      const s = this.lastRun.summary;
      return `${s.total} checks | ${s.pass} pass | ${s.warn} warn | ${s.fail} fail | ${s.skip} skipped`;
    },

    metricCards(){
      const s = this.lastRun?.summary || { total: 0, pass: 0, warn: 0, fail: 0, skip: 0, durationMs: 0 };
      const projectId = this.lastRun?.sampleProject?.id || 'Not selected';
      const apiBase = String(cfg()?.endpoints?.firstmeasure || '').replace(/\/+$/, '') || 'Unavailable';
      return [
        { label: 'Checks Run', value: s.total || 0, meta: this.summarize() },
        { label: 'Pass Rate', value: s.total ? `${Math.round((s.pass / s.total) * 100)}%` : '0%', meta: `${s.pass || 0} successful checks` },
        { label: 'Issues', value: (s.fail || 0) + (s.warn || 0), meta: `${s.fail || 0} fail, ${s.warn || 0} warn` },
        { label: 'Elapsed', value: this.fmtMs(s.durationMs || 0), meta: `Last run ${this.fmtTs(this.lastRun?.startedAt || null)}` },
        { label: 'Sample Project', value: projectId === 'Not selected' ? '-' : projectId.slice(0, 10), meta: projectId },
        { label: 'API Base', value: apiBase.includes('://') ? new URL(apiBase).host : apiBase, meta: apiBase }
      ];
    },

    toolMetricCards(){
      const status = this.toolState.indexStatus;
      const runtime = this.toolState.runtime;
      if (!status) {
        const apiBase = String(cfg()?.endpoints?.firstmeasure || '').replace(/\/+$/, '') || 'Unavailable';
        if (this.toolState.endpointUnavailable) {
          return [
            { label: 'Indexed Projects', value: '-', meta: 'This FirstMeasure host does not expose the admin tools endpoints yet.' },
            { label: 'Backfill', value: '-', meta: 'Status is unavailable until the v1 host is updated.' },
            { label: 'Last Rebuild', value: '-', meta: 'Use the button again after the backend deployment reaches this environment.' },
            { label: 'API Restart', value: '-', meta: 'Refresh after the v1 process restarts onto the latest code.' },
            { label: 'API Base', value: apiBase.includes('://') ? new URL(apiBase).host : apiBase, meta: apiBase }
          ];
        }
        return [
          { label: 'Indexed Projects', value: '-', meta: 'Refresh status to inspect the current SQLite index.' },
          { label: 'Backfill', value: '-', meta: 'No index metadata has been loaded yet.' },
          { label: 'Last Rebuild', value: '-', meta: 'No rebuild information loaded yet.' },
          { label: 'API Restart', value: runtime?.process_started_at ? this.fmtTs(runtime.process_started_at) : '-', meta: runtime?.api_module_updated_at ? `Code ${this.fmtTs(runtime.api_module_updated_at)}` : 'No runtime metadata loaded yet' },
          { label: 'Storage', value: '-', meta: 'The database path will appear after a refresh.' }
        ];
      }
      return [
        { label: 'Indexed Projects', value: Number(status.indexedProjects || 0).toLocaleString(), meta: `Schema v${status.schemaVersion || '-'}` },
        { label: 'Backfill', value: status.backfillComplete ? 'Ready' : 'Pending', meta: status.ftsEnabled ? 'FTS search enabled' : 'FTS search disabled' },
        { label: 'Last Rebuild', value: status.lastRebuildCount != null ? Number(status.lastRebuildCount).toLocaleString() : '-', meta: status.lastRebuildFinishedAt ? this.fmtTs(status.lastRebuildFinishedAt) : 'No rebuild finish timestamp' },
        { label: 'API Restart', value: runtime?.process_started_at ? this.fmtTs(runtime.process_started_at) : '-', meta: runtime?.package_version ? `v${runtime.package_version} | PID ${runtime.pid || '-'}` : `PID ${runtime?.pid || '-'}` },
        { label: 'Code Stamp', value: runtime?.api_module_updated_at ? this.fmtTs(runtime.api_module_updated_at) : '-', meta: runtime?.api_module_path || 'No module path reported' },
        { label: 'Storage', value: this.toolState.lastLoadedAt ? this.fmtTs(this.toolState.lastLoadedAt) : 'Unknown', meta: String(status.dbPath || 'No DB path reported') }
      ];
    },

    toolSummary(){
      if (this.toolState.rebuilding) return 'Rebuilding the SQLite index now';
      if (this.toolState.loading) return 'Loading current index status';
      if (this.toolState.endpointUnavailable) return 'This FirstMeasure environment does not support the manual tools endpoints yet';
      if (!this.toolState.indexStatus) return 'Index status has not been loaded yet';
      const status = this.toolState.indexStatus;
      const runtime = this.toolState.runtime;
      return `${Number(status.indexedProjects || 0).toLocaleString()} indexed | schema v${status.schemaVersion || '-'} | ${status.backfillComplete ? 'backfill complete' : 'backfill pending'}${runtime?.process_started_at ? ` | restarted ${this.fmtTs(runtime.process_started_at)}` : ''}`;
    },

    ensureToolsStatusLoaded(){
      if (this.activeTab !== 'tools') return;
      if (this.toolState.autoLoadAttempted) return;
      if (this.toolState.loading || this.toolState.rebuilding) return;
      if (this.toolState.indexStatus || this.toolState.endpointUnavailable) return;
      this.toolState.autoLoadAttempted = true;
      void this.refreshToolsStatus(true);
    },

    pushToolLog(entry){
      this.toolState.logs = [entry, ...this.toolState.logs].slice(0, 12);
    },

    render(){
      this.setActiveTab(this.activeTab);
      const runBtn = document.getElementById('dbgRunBtn');
      if (runBtn) {
        runBtn.disabled = !!this.running;
        runBtn.innerHTML = this.running
          ? '<i class="fas fa-spinner fa-spin"></i> Running Diagnostics'
          : '<i class="fas fa-play"></i> Run Full Diagnostics';
      }

      const lastRunLabel = document.getElementById('dbgLastRunLabel');
      if (lastRunLabel) lastRunLabel.textContent = this.lastRun ? `Last run ${this.fmtTs(this.lastRun.startedAt)}` : 'No diagnostics run yet';
      const sweepMeta = document.getElementById('dbgSweepMeta');
      if (sweepMeta) sweepMeta.textContent = this.summarize();

      const metrics = document.getElementById('dbgMetrics');
      if (metrics) {
        metrics.innerHTML = this.metricCards().map(metric => `
          <div class="debug-metric">
            <div class="label">${Portal.escapeHtml(metric.label)}</div>
            <div class="value">${Portal.escapeHtml(String(metric.value))}</div>
            <div class="meta">${Portal.escapeHtml(metric.meta)}</div>
          </div>
        `).join('');
      }

      const table = document.getElementById('dbgResultsTable');
      if (table) {
        table.innerHTML = this.results.length
          ? this.results.map(result => `
              <tr>
                <td>
                  <div class="debug-endpoint">
                    <strong>${Portal.escapeHtml(result.section)}</strong>
                    <code>${Portal.escapeHtml(`${result.method} ${result.pathLabel}`)}</code>
                    <small>${Portal.escapeHtml(result.note || 'Read-only diagnostic request')}</small>
                  </div>
                </td>
                <td><span class="debug-pill ${Portal.escapeHtml(result.status)}">${Portal.escapeHtml(this.label(result.status))}</span></td>
                <td>${Portal.escapeHtml(result.httpStatus ? String(result.httpStatus) : '-')}</td>
                <td>${Portal.escapeHtml(this.fmtMs(result.durationMs))}</td>
                <td>${Portal.escapeHtml(result.highlight || result.message || '-')}</td>
              </tr>
            `).join('')
          : `<tr><td colspan="5"><div class="debug-empty">Run the diagnostics to test the live FirstMeasure read-only endpoints.</div></td></tr>`;
      }

      const issuesMeta = document.getElementById('dbgIssuesMeta');
      if (issuesMeta) issuesMeta.textContent = this.issues.length ? `${this.issues.length} item(s)` : 'Nothing to review yet';
      const issues = document.getElementById('dbgIssuesList');
      if (issues) {
        issues.innerHTML = this.issues.length
          ? this.issues.map(issue => `
              <div class="debug-issue ${Portal.escapeHtml(issue.status)}">
                <div class="debug-issue-head">
                  <strong>${Portal.escapeHtml(issue.title)}</strong>
                  <span class="debug-pill ${Portal.escapeHtml(issue.status)}">${Portal.escapeHtml(this.label(issue.status))}</span>
                </div>
                <div class="debug-issue-body">${Portal.escapeHtml(issue.body)}</div>
              </div>
            `).join('')
          : '<div class="debug-empty">No failures or warnings were found in the last run.</div>';
      }

      const logMeta = document.getElementById('dbgLogMeta');
      if (logMeta) logMeta.textContent = this.logs.length ? `${this.logs.length} request trace(s)` : 'No request traces yet';
      const logs = document.getElementById('dbgLogList');
      if (logs) {
        logs.innerHTML = this.logs.length
          ? this.logs.map(log => `
              <div class="debug-log-item">
                <div class="debug-log-head">
                  <strong>${Portal.escapeHtml(log.title)}</strong>
                  <span class="debug-muted">${Portal.escapeHtml(log.meta)}</span>
                </div>
                <div class="debug-log-body">${Portal.escapeHtml(log.body)}</div>
              </div>
            `).join('')
          : '<div class="debug-empty">Each diagnostic request will leave a concise trace here.</div>';
      }

      const toolsMeta = document.getElementById('dbgToolsMeta');
      if (toolsMeta) toolsMeta.textContent = this.toolSummary();

      const toolsBanner = document.getElementById('dbgToolsBanner');
      if (toolsBanner) {
        const banner = this.toolState.banner;
        if (!banner) {
          toolsBanner.className = 'debug-status-banner';
          toolsBanner.innerHTML = '';
        } else {
          toolsBanner.className = `debug-status-banner ${Portal.escapeHtml(banner.type)}`;
          toolsBanner.innerHTML = `<i class="fas fa-screwdriver-wrench"></i><span>${Portal.escapeHtml(banner.message)}</span>`;
        }
      }

      const toolMetrics = document.getElementById('dbgToolsMetrics');
      if (toolMetrics) {
        toolMetrics.innerHTML = this.toolMetricCards().map(metric => `
          <div class="debug-metric">
            <div class="label">${Portal.escapeHtml(metric.label)}</div>
            <div class="value">${Portal.escapeHtml(String(metric.value))}</div>
            <div class="meta">${Portal.escapeHtml(metric.meta)}</div>
          </div>
        `).join('');
      }

      const refreshIndexBtn = document.getElementById('dbgRefreshIndexStatusBtn');
      if (refreshIndexBtn) {
        refreshIndexBtn.disabled = !!this.toolState.loading || !!this.toolState.rebuilding;
        refreshIndexBtn.innerHTML = this.toolState.loading
          ? '<i class="fas fa-spinner fa-spin"></i> Refreshing'
          : '<i class="fas fa-rotate"></i> Refresh Status';
      }

      const rebuildIndexBtn = document.getElementById('dbgRebuildIndexBtn');
      if (rebuildIndexBtn) {
        rebuildIndexBtn.disabled = !!this.toolState.rebuilding || !!this.toolState.loading;
        rebuildIndexBtn.innerHTML = this.toolState.rebuilding
          ? '<i class="fas fa-spinner fa-spin"></i> Rebuilding Index'
          : '<i class="fas fa-arrows-rotate"></i> Rebuild Index';
      }

      const toolLogMeta = document.getElementById('dbgToolLogMeta');
      if (toolLogMeta) toolLogMeta.textContent = this.toolState.logs.length ? `${this.toolState.logs.length} tool event(s)` : 'No tool activity yet';
      const toolLogList = document.getElementById('dbgToolLogList');
      if (toolLogList) {
        toolLogList.innerHTML = this.toolState.logs.length
          ? this.toolState.logs.map(log => `
              <div class="debug-log-item">
                <div class="debug-log-head">
                  <strong>${Portal.escapeHtml(log.title)}</strong>
                  <span class="debug-muted">${Portal.escapeHtml(log.meta)}</span>
                </div>
                <div class="debug-log-body">${Portal.escapeHtml(log.body)}</div>
              </div>
            `).join('')
          : '<div class="debug-empty">Refresh the index status or run a rebuild to leave an operator trace here.</div>';
      }
    },

    async refreshToolsStatus(silent = false){
      if (this.toolState.loading || this.toolState.rebuilding) return;
      this.toolState.loading = true;
      this.toolState.endpointUnavailable = false;
      if (!silent) this.setToolsBanner('info', 'Loading the current FirstMeasure SQLite index status...');
      this.render();

      try {
        const data = await Portal.fmPost('admin/index-status', { actor: this.actor() });
        this.toolState.indexStatus = data?.firstmeasure || null;
        this.toolState.runtime = data?.runtime || null;
        this.toolState.lastLoadedAt = Date.now();
        this.toolState.endpointUnavailable = false;
        this.setToolsBanner('success', 'FirstMeasure index status refreshed.');
        this.pushToolLog({
          title: 'Index status refreshed',
          meta: `${this.fmtTs(this.toolState.lastLoadedAt)} | ${Number(data?.firstmeasure?.indexedProjects || 0).toLocaleString()} indexed`,
          body: [
            `DB: ${String(data?.firstmeasure?.dbPath || 'Unknown')}`,
            `Schema: ${String(data?.firstmeasure?.schemaVersion ?? '-')}`,
            `Backfill complete: ${data?.firstmeasure?.backfillComplete ? 'yes' : 'no'}`,
            `API restart: ${data?.runtime?.process_started_at ? this.fmtTs(data.runtime.process_started_at) : 'Unknown'}`,
            `Code stamp: ${data?.runtime?.api_module_updated_at ? this.fmtTs(data.runtime.api_module_updated_at) : 'Unknown'}`
          ].join('\n')
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = /not found|request failed \(404\)|route post:/i.test(message);
        this.toolState.endpointUnavailable = unavailable;
        this.setToolsBanner(
          'error',
          unavailable
            ? 'This FirstMeasure environment is still missing the admin tools endpoints. The backend host needs the latest v1 deployment before index tools can run here.'
            : `Unable to load index status: ${message}`
        );
        this.pushToolLog({
          title: 'Index status refresh failed',
          meta: this.fmtTs(Date.now()),
          body: message
        });
      } finally {
        this.toolState.loading = false;
        this.render();
      }
    },

    async rebuildFirstMeasureIndex(){
      if (this.toolState.rebuilding || this.toolState.loading) return;
      this.toolState.rebuilding = true;
      this.toolState.endpointUnavailable = false;
      this.setToolsBanner('info', 'Rebuilding the FirstMeasure SQLite index from disk manifests...');
      this.render();

      try {
        const data = await Portal.fmPost('admin/reindex', { actor: this.actor() });
        this.toolState.indexStatus = data?.firstmeasure || null;
        this.toolState.runtime = data?.runtime || null;
        this.toolState.lastLoadedAt = Date.now();
        this.toolState.endpointUnavailable = false;
        this.setToolsBanner('success', `Index rebuild complete. ${Number(data?.result?.indexedProjects || 0).toLocaleString()} project(s) indexed.`);
        this.pushToolLog({
          title: 'Index rebuild complete',
          meta: [
            this.fmtTs(Date.now()),
            `${Number(data?.result?.indexedProjects || 0).toLocaleString()} indexed`
          ].join(' | '),
          body: [
            `Started: ${this.fmtTs(data?.result?.startedAt || null)}`,
            `Finished: ${this.fmtTs(data?.result?.finishedAt || null)}`,
            `DB: ${String(data?.result?.dbPath || data?.firstmeasure?.dbPath || 'Unknown')}`,
            `API restart: ${data?.runtime?.process_started_at ? this.fmtTs(data.runtime.process_started_at) : 'Unknown'}`,
            `Code stamp: ${data?.runtime?.api_module_updated_at ? this.fmtTs(data.runtime.api_module_updated_at) : 'Unknown'}`
          ].join('\n')
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = /not found|request failed \(404\)|route post:/i.test(message);
        this.toolState.endpointUnavailable = unavailable;
        this.setToolsBanner(
          'error',
          unavailable
            ? 'This FirstMeasure environment is still missing the admin rebuild endpoint. Deploy the latest v1 host here before using the Tools tab.'
            : `Index rebuild failed: ${message}`
        );
        this.pushToolLog({
          title: 'Index rebuild failed',
          meta: this.fmtTs(Date.now()),
          body: message
        });
      } finally {
        this.toolState.rebuilding = false;
        this.render();
      }
    },

    buildUrl(path, useServerDebug){
      const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(Portal.fmUrl(path), window.location.href);
      if (useServerDebug) {
        url.searchParams.set('debug', '1');
        url.searchParams.set('debug_source', 'internal_portal');
      }
      return url;
    },

    async runSpec(spec, options){
      const url = this.buildUrl(spec.path, options.useServerDebug);
      const headers = Object.assign({}, spec.headers || {});
      if (!headers['Accept']) headers['Accept'] = spec.expect === 'binary' ? '*/*' : 'application/json';

      let body = spec.body;
      if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof FormData) && !spec.rawBody) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = JSON.stringify(body);
      }

      const startedAt = Date.now();
      const startPerf = performance.now();
      try {
        const response = await fetch(url.toString(), {
          method: spec.method || 'GET',
          headers,
          body: body === undefined ? undefined : body
        });
        const durationMs = performance.now() - startPerf;
        const contentType = response.headers.get('content-type') || '';
        const traceId = response.headers.get('x-firstmeasure-debug-trace') || null;

        let data = null;
        let text = '';
        let responseBytes = null;
        if (spec.expect === 'binary' || (!/application\/json/i.test(contentType) && spec.expect !== 'json')) {
          const buffer = await response.arrayBuffer();
          responseBytes = buffer.byteLength;
          if (/application\/json/i.test(contentType)) {
            text = new TextDecoder().decode(buffer);
            data = text ? JSON.parse(text) : null;
          }
        } else {
          text = await response.text();
          responseBytes = text.length;
          data = text ? JSON.parse(text) : null;
        }

        const debugMeta = data && typeof data === 'object' ? data._debug || null : null;
        const result = {
          section: spec.section,
          name: spec.name,
          method: spec.method || 'GET',
          pathLabel: spec.pathLabel || spec.path,
          note: spec.note || '',
          status: 'pass',
          message: '',
          highlight: '',
          durationMs,
          httpStatus: response.status,
          traceId: traceId || (debugMeta && debugMeta.trace_id) || null,
          responseBytes,
          responseData: data,
          startedAt
        };

        if (!response.ok) {
          result.status = 'fail';
          result.message = `HTTP ${response.status}`;
        }
        if (data && typeof data === 'object' && data.ok === false) {
          result.status = 'fail';
          result.message = String(data.message || data.error || result.message || 'API responded with ok=false');
        }
        if (typeof spec.validate === 'function') {
          const verdict = spec.validate({ response, data, text, responseBytes, debugMeta, options }) || {};
          if (verdict.status) result.status = verdict.status;
          if (verdict.message) result.message = verdict.message;
          if (verdict.highlight) result.highlight = verdict.highlight;
        }
        if (options.useServerDebug && !result.traceId) {
          result.status = result.status === 'pass' ? 'warn' : result.status;
          result.message = result.message || 'Debug metadata requested but no trace id was returned.';
        }
        result.highlight = result.highlight || result.message || 'Request completed normally';
        return result;
      } catch (error) {
        return {
          section: spec.section,
          name: spec.name,
          method: spec.method || 'GET',
          pathLabel: spec.pathLabel || spec.path,
          note: spec.note || '',
          status: 'fail',
          message: error instanceof Error ? error.message : String(error),
          highlight: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - startPerf,
          httpStatus: null,
          traceId: null,
          responseBytes: null,
          responseData: null,
          startedAt
        };
      }
    },

    pushSynthetic(result, results){
      results.push(result);
      this.results = [...results];
      this.issues = this.results.filter(item => item.status !== 'pass').map(item => ({
        status: item.status === 'skip' ? 'warn' : item.status,
        title: `${item.section}: ${item.name}`,
        body: [item.message, item.highlight, item.traceId ? `trace_id=${item.traceId}` : ''].filter(Boolean).join('\n')
      }));
      this.logs = this.results.map(item => ({
        title: `${item.section}: ${item.name}`,
        meta: [item.httpStatus ? `HTTP ${item.httpStatus}` : 'No HTTP status', this.fmtMs(item.durationMs), item.traceId ? `trace ${item.traceId}` : ''].filter(Boolean).join(' | '),
        body: [ `${item.method} ${item.pathLabel}`, item.highlight || item.message || 'Request completed.' ].join('\n')
      }));
      this.render();
    },

    async addSpec(spec, results, options){
      const result = await this.runSpec(spec, options);
      this.pushSynthetic(result, results);
      return result;
    },

    async runFullDiagnostics(){
      if (this.running) return;
      this.running = true;
      this.lastRun = null;
      this.results = [];
      this.issues = [];
      this.logs = [];
      this.banner('Running read-only diagnostics against the live FirstMeasure API...');
      this.render();

      const options = this.options();
      const actor = this.actor();
      const queueMode = cfg().user?.queue_mode || 'disabled';
      const startedAt = Date.now();
      const results = [];
      let sampleProject = null;
      let sampleDetail = null;
      let sampleEditor = null;
      let sampleFiles = [];

      const specs = [
        { section: 'Core', name: 'API Root', path: '', note: 'Confirms the API is mounted.', validate: ({ data }) => ({ status: data?.api === 'firstmeasure' ? 'pass' : 'fail', highlight: data?.api === 'firstmeasure' ? 'Mounted and responding' : 'Unexpected root payload' }) },
        { section: 'Core', name: 'Ping', path: 'ping?source=internal_portal', note: 'Quick JSON liveness check.', validate: ({ data }) => ({ status: data?.route === '/ping' ? 'pass' : 'fail', highlight: data?.receivedAt || 'Missing ping timestamp' }) },
        { section: 'Core', name: 'Runtime Stamp', path: 'ping?source=internal_portal_runtime', note: 'Shows when the live v1 process restarted and when the loaded API module was last updated.', validate: ({ data }) => ({ status: data?.runtime?.process_started_at ? 'pass' : 'fail', highlight: data?.runtime?.process_started_at ? `restart ${this.fmtTs(data.runtime.process_started_at)} | code ${this.fmtTs(data.runtime.api_module_updated_at)}` : 'Missing runtime metadata' }) },
        { section: 'Core', name: 'Echo', method: 'POST', path: 'echo', body: { source: 'internal_portal_debugging', read_only: true, actor }, note: 'Round-trips a harmless payload.', validate: ({ data }) => ({ status: data?.body?.read_only === true ? 'pass' : 'fail', highlight: data?.method ? `${data.method} round-trip ok` : 'Echo did not round-trip' }) },
        { section: 'Projects', name: 'Indexed Projects', path: 'projects?limit=5&include_all=1', note: 'Reads the indexed project list.', validate: ({ data }) => ({ status: Array.isArray(data?.projects) ? 'pass' : 'fail', highlight: Array.isArray(data?.projects) ? `${data.projects.length} project(s)` : 'Missing projects array' }) },
        { section: 'Projects', name: 'Legacy Project List', method: 'POST', path: 'projects/list', body: { filter: 'all', page: 1, limit: 5, actor }, note: 'Checks the legacy browser compatibility response.', validate: ({ data }) => ({ status: Array.isArray(data?.projects) ? 'pass' : 'fail', highlight: Array.isArray(data?.projects) ? `${data.projects.length} row(s)` : 'Missing legacy projects array' }) },
        { section: 'Projects', name: 'Projects Query', method: 'POST', path: 'projects/query', body: { include_all: true, limit: 5 }, note: 'Exercises the indexed query surface.', validate: ({ data }) => ({ status: Array.isArray(data?.projects) ? 'pass' : 'fail', highlight: Array.isArray(data?.projects) ? `count ${data.count ?? data.projects.length}` : 'Missing query payload' }) },
        { section: 'Core', name: 'Apple Key Read', path: 'apple-key', note: 'Read-only Apple key storage check.', validate: ({ data }) => ({ status: data && Object.prototype.hasOwnProperty.call(data, 'value') ? 'pass' : 'fail', highlight: data?.value?.updated_at_utc || 'No stored key timestamp' }) },
        { section: 'Queue', name: 'Queue Status', method: 'POST', path: 'queue/status', body: { actor, queue_mode: queueMode }, note: 'Reads queue status for the current actor.', validate: ({ data }) => ({ status: typeof data?.queue_count === 'number' ? 'pass' : 'fail', highlight: typeof data?.queue_count === 'number' ? `queue_count=${data.queue_count}` : 'Missing queue_count' }) },
        { section: 'Queue', name: 'Queue Status Compat', method: 'POST', path: 'queue/status/compat', body: { actor, user_email: actor.email, queue_mode: queueMode }, note: 'Validates the compatibility adapter.', validate: ({ data }) => ({ status: typeof data?.queue_count === 'number' && Object.prototype.hasOwnProperty.call(data || {}, 'has_next') ? 'pass' : 'fail', highlight: typeof data?.queue_count === 'number' ? `compat queue_count=${data.queue_count}` : 'Missing compat payload' }) },
        { section: 'Runtime', name: 'PDF Runtime Manifest', path: 'pdf-runtime/manifest', note: 'Confirms the shared PDF runtime surface.', validate: ({ data }) => ({ status: data?.runtime?.base_url ? 'pass' : 'fail', highlight: data?.runtime?.base_url || 'Missing runtime base_url' }) },
        { section: 'Runtime', name: 'PDF Runtime Blank', path: 'pdf-runtime/blank', expect: 'binary', note: 'Fetches the blank runtime shell.', validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? this.fmtBytes(responseBytes || 0) : 'Blank runtime fetch failed' }) },
        { section: 'Runtime', name: 'PDF Runtime Asset', path: 'pdf-runtime/assets/jspdf', expect: 'binary', note: 'Fetches a shared runtime asset.', validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? this.fmtBytes(responseBytes || 0) : 'Runtime asset fetch failed' }) }
      ];

      for (const spec of specs) {
        const result = await this.addSpec(spec, results, options);
        if (spec.name === 'Indexed Projects' && Array.isArray(result.responseData?.projects) && result.responseData.projects.length) sampleProject = result.responseData.projects[0];
      }

      if (sampleProject?.id && sampleProject?.address) {
        const searchText = String(sampleProject.address)
          .split(',')
          .shift()
          .trim()
          .split(/\s+/)
          .slice(0, 3)
          .join(' ');
        if (searchText) {
          await this.addSpec({
            section: 'Projects',
            name: 'Indexed Search',
            path: `projects?include_all=1&page=1&limit=35&search=${encodeURIComponent(searchText)}`,
            note: 'Searches for a project from the live indexed result set.',
            validate: ({ response, data }) => {
              const failure = this.extractApiFailure({ response, data });
              if (failure) return { status: 'fail', highlight: failure };
              const projects = Array.isArray(data?.projects) ? data.projects : [];
              const match = projects.find(project => String(project?.id || '') === String(sampleProject.id));
              return { status: match ? 'pass' : 'fail', highlight: match ? `matched ${sampleProject.id}` : `No indexed search match for ${searchText}` };
            }
          }, results, options);
          await this.addSpec({
            section: 'Projects',
            name: 'Legacy Search',
            method: 'POST',
            path: 'projects/list',
            body: { filter: 'all', page: 1, limit: 35, search: searchText, actor },
            note: 'Checks search through the browser compatibility route using live data.',
            validate: ({ response, data }) => {
              const failure = this.extractApiFailure({ response, data });
              if (failure) return { status: 'fail', highlight: failure };
              const projects = Array.isArray(data?.projects) ? data.projects : [];
              const match = projects.find(project => String(project?.folder || project?.id || '') === String(sampleProject.id));
              return { status: match ? 'pass' : 'fail', highlight: match ? `matched ${sampleProject.id}` : `No legacy search match for ${searchText}` };
            }
          }, results, options);
        }
      }

      if (cfg().flags?.is_queue_admin) {
        await this.addSpec({ section: 'Queue', name: 'Queue Overview', method: 'POST', path: 'queue/admin/overview', body: { include_completed: true, team_id: 'all' }, note: 'Reads the admin queue overview.', validate: ({ data }) => ({ status: data && typeof data === 'object' ? 'pass' : 'fail', highlight: data ? 'Admin overview responded' : 'Missing admin overview payload' }) }, results, options);
        await this.addSpec({ section: 'Queue', name: 'Queue Overview Compat', method: 'POST', path: 'queue/admin/overview/compat', body: { team: 'all' }, note: 'Checks the legacy admin overview adapter.', validate: ({ data }) => ({ status: data && typeof data === 'object' ? 'pass' : 'fail', highlight: data ? 'Compat overview responded' : 'Missing compat overview payload' }) }, results, options);
      }

      if (sampleProject?.id) {
        await this.addSpec({ section: 'Projects', name: 'Find Project By Address', method: 'POST', path: 'projects/find-by-address', body: { address: sampleProject.address || '' }, note: 'Checks indexed address lookup.', validate: ({ data }) => ({ status: Object.prototype.hasOwnProperty.call(data || {}, 'exists') ? 'pass' : 'fail', highlight: data?.exists ? `matched ${data.folder || sampleProject.id}` : 'Lookup returned no match' }) }, results, options);

        const projectId = encodeURIComponent(sampleProject.id);
        const detail = await this.addSpec({ section: 'Project Detail', name: 'Project Detail', path: `projects/${projectId}`, note: 'Loads the canonical project detail bundle.', validate: ({ data }) => ({ status: data?.project?.manifest?.id ? 'pass' : 'fail', highlight: data?.project?.manifest?.status ? `status=${data.project.manifest.status}` : 'Missing manifest' }) }, results, options);
        const editor = await this.addSpec({ section: 'Project Detail', name: 'Editor Bundle', path: `projects/${projectId}/editor`, note: 'Loads the editor bootstrap bundle.', validate: ({ data }) => ({ status: data?.manifest?.id ? 'pass' : 'fail', highlight: Array.isArray(data?.files) ? `${data.files.length} file(s)` : 'Missing editor file list' }) }, results, options);
        await this.addSpec({ section: 'Project Detail', name: 'Editor PDF State', path: `projects/${projectId}/editor/pdf-state`, note: 'Reads the editor PDF state asset.', validate: ({ response }) => ({ status: response.ok ? 'pass' : 'fail', highlight: 'Editor PDF state responded' }) }, results, options);
        await this.addSpec({ section: 'Project Detail', name: 'App Metadata', path: `projects/${projectId}/app-metadata`, note: 'Reads stored app metadata.', validate: ({ data }) => ({ status: data && Object.prototype.hasOwnProperty.call(data, 'value') ? 'pass' : 'fail', highlight: 'App metadata responded' }) }, results, options);
        await this.addSpec({ section: 'Project Detail', name: 'PDF State', path: `projects/${projectId}/pdf-state`, note: 'Reads the saved PDF state.', validate: ({ data }) => ({ status: data && Object.prototype.hasOwnProperty.call(data, 'value') ? 'pass' : 'fail', highlight: 'PDF state responded' }) }, results, options);
        await this.addSpec({ section: 'Project Detail', name: 'Branding Defaults', path: `projects/${projectId}/branding-defaults`, note: 'Reads stored branding defaults.', validate: ({ data }) => ({ status: data && Object.prototype.hasOwnProperty.call(data, 'value') ? 'pass' : 'fail', highlight: 'Branding defaults responded' }) }, results, options);
        const artifacts = await this.addSpec({ section: 'Project Detail', name: 'Artifacts List', path: `projects/${projectId}/artifacts`, note: 'Lists persisted artifacts for the sample project.', validate: ({ data }) => ({ status: Array.isArray(data?.files) ? 'pass' : 'fail', highlight: Array.isArray(data?.files) ? `${data.files.length} artifact(s)` : 'Missing artifacts list' }) }, results, options);
        await this.addSpec({
          section: 'Project Detail',
          name: 'PDF Runtime Bootstrap',
          path: `projects/${projectId}/pdfs/runtime`,
          note: 'Loads the project-specific PDF runtime bootstrap.',
          validate: ({ data }) => {
            if (data?.runtime?.base_url) {
              return { status: 'pass', highlight: 'Project runtime manifest ready' };
            }
            if (data?.error === 'missing_pdf_snapshot' || /saved PDF snapshot yet/i.test(String(data?.message || ''))) {
              return {
                status: 'skip',
                message: 'This project does not have a saved PDF snapshot yet.',
                highlight: 'Skipped because the sample project has no saved PDF snapshot'
              };
            }
            return { status: 'fail', highlight: 'Missing project runtime manifest' };
          }
        }, results, options);

        sampleDetail = detail.responseData?.project || null;
        sampleEditor = editor.responseData || null;
        sampleFiles = Array.isArray(artifacts.responseData?.files) ? artifacts.responseData.files : [];

        if (sampleEditor?.assets?.google_3d_manifest) {
          await this.addSpec({ section: 'Project Detail', name: 'Google 3D Manifest', path: sampleEditor.assets.google_3d_manifest, pathLabel: '/projects/:id/google-3d/manifest.json', note: 'Checks the generated Google 3D manifest when present.', validate: ({ response }) => ({ status: response.ok ? 'pass' : 'fail', highlight: 'Google 3D manifest responded' }) }, results, options);
        } else {
          this.pushSynthetic({ section: 'Project Detail', name: 'Google 3D Manifest', method: 'GET', pathLabel: '/projects/:id/google-3d/manifest.json', note: 'Checks the generated Google 3D manifest when present.', status: 'skip', message: 'Sample project has no Google 3D manifest.', highlight: 'No Google 3D manifest on sample project', durationMs: 0, httpStatus: null, traceId: null }, results);
        }

        if (options.includeBinaryChecks) {
          const fileNames = sampleFiles.map(file => String(file?.name || ''));
          const hasReport = !!sampleDetail?.manifest?.artifacts?.has_report_pdf;
          const hasSummary = !!sampleDetail?.manifest?.artifacts?.has_summary_pdf;
          const hasXml = fileNames.some(name => /\.xml$/i.test(name));
          const artifactCandidate = fileNames.find(name => /\.(json|png|jpg|jpeg|webp|tif|tiff|pdf|xml)$/i.test(name));

          if (hasReport) {
            await this.addSpec({ section: 'Binary', name: 'Main PDF Fetch', path: `projects/${projectId}/pdf?slot=main`, expect: 'binary', note: 'Fetches the stored main PDF.', validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? this.fmtBytes(responseBytes || 0) : 'Main PDF fetch failed' }) }, results, options);
          } else {
            this.pushSynthetic({ section: 'Binary', name: 'Main PDF Fetch', method: 'GET', pathLabel: '/projects/:id/pdf?slot=main', note: 'Fetches the stored main PDF.', status: 'skip', message: 'Sample project has no stored main PDF.', highlight: 'No stored main PDF', durationMs: 0, httpStatus: null, traceId: null }, results);
          }

          if (hasSummary) {
            await this.addSpec({ section: 'Binary', name: 'Summary PDF Fetch', path: `projects/${projectId}/pdf?slot=summary`, expect: 'binary', note: 'Fetches the stored summary PDF.', validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? this.fmtBytes(responseBytes || 0) : 'Summary PDF fetch failed' }) }, results, options);
          } else {
            this.pushSynthetic({ section: 'Binary', name: 'Summary PDF Fetch', method: 'GET', pathLabel: '/projects/:id/pdf?slot=summary', note: 'Fetches the stored summary PDF.', status: 'skip', message: 'Sample project has no stored summary PDF.', highlight: 'No stored summary PDF', durationMs: 0, httpStatus: null, traceId: null }, results);
          }

          if (hasXml) {
            await this.addSpec({ section: 'Binary', name: 'XML Export', path: `projects/${projectId}/xml?source=stored`, expect: 'binary', note: 'Fetches the stored XML export.', validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? this.fmtBytes(responseBytes || 0) : 'XML export fetch failed' }) }, results, options);
          } else {
            this.pushSynthetic({ section: 'Binary', name: 'XML Export', method: 'GET', pathLabel: '/projects/:id/xml', note: 'Fetches the stored XML export.', status: 'skip', message: 'Sample project has no XML artifact.', highlight: 'No XML artifact detected', durationMs: 0, httpStatus: null, traceId: null }, results);
          }

          if (artifactCandidate) {
            await this.addSpec({ section: 'Binary', name: 'Artifact Fetch', path: `projects/${projectId}/artifacts/${encodeURIComponent(artifactCandidate)}`, expect: 'binary', note: `Fetches a real stored artifact (${artifactCandidate}).`, validate: ({ response, responseBytes }) => ({ status: response.ok && (responseBytes || 0) > 0 ? 'pass' : 'fail', highlight: response.ok ? `${artifactCandidate} | ${this.fmtBytes(responseBytes || 0)}` : 'Artifact fetch failed' }) }, results, options);
          } else {
            this.pushSynthetic({ section: 'Binary', name: 'Artifact Fetch', method: 'GET', pathLabel: '/projects/:id/artifacts/:name', note: 'Fetches a real stored artifact.', status: 'skip', message: 'Sample project had no fetchable artifact candidates.', highlight: 'No artifact candidate found', durationMs: 0, httpStatus: null, traceId: null }, results);
          }
        }
      } else {
        this.pushSynthetic({ section: 'Projects', name: 'Sample Project Selection', method: 'GET', pathLabel: '/projects', note: 'Picks a project for deeper inspection.', status: 'warn', message: 'No sample project was available, so detail-level checks were skipped.', highlight: 'No sample project available', durationMs: 0, httpStatus: null, traceId: null }, results);
      }

      const summary = results.reduce((acc, item) => {
        acc.total += 1;
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, { total: 0, pass: 0, warn: 0, fail: 0, skip: 0 });
      summary.durationMs = Date.now() - startedAt;

      this.running = false;
      this.lastRun = {
        startedAt,
        summary,
        sampleProject: sampleProject?.id ? { id: sampleProject.id, address: sampleProject.address || '' } : null
      };
      const message = summary.fail > 0
        ? `Diagnostics finished with ${summary.fail} failure(s) and ${summary.warn} warning(s).`
        : summary.warn > 0
          ? 'Diagnostics finished with warnings but no hard failures.'
          : 'Diagnostics finished cleanly with no failures or warnings.';
      this.banner(message);
      this.render();
    }
  };

  window.Debugging = Debugging;
})();
