/* portal_scripts/projects.js
 * Projects module:
 * - Project browser tiles + filters
 * - Project details modal
 * - Next-in-Queue sidebar button (auto-refresh + ding on new queue items)
 * - Queue admin view
 * - Apple key panel
 *
 * NEW (Queue tab):
 * - "Re-Queue" section shown BEFORE Queued/In Progress/QA
 *   - Holds projects that need manual routing back into production
 *   - Used for QA kickbacks, manager change requests, and AFK/time-out ejections
 *   - Admin can either send them back to the shared queue or reserve them from the project modal
 *
 * NEW (Sidebar Next-in-Queue):
 * - Refreshes every few seconds so the button always knows when queue changes
 * - Plays a ding (audio/ding.mp3) when it was empty+disabled and then becomes available
 * - Filler jobs do NOT steal priority: if you only have unfinished filler and queue has work, clicking claims next queue item
 *async refreshQueueAdmin
 * NEW (Break/Idle):
 * - Replaces "Ongoing: X • Queue: Y" with idle timer + break button (visible to everyone)
 * - Break status persisted server-side; queue claims blocked while on break
 */
(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;
  const MANAGEMENT_TIME_ZONE = 'America/Los_Angeles';
  const managementDateTimeParts = (date) => new Intl.DateTimeFormat('en-US', {
    timeZone: MANAGEMENT_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
  const managementTimezoneOffsetMs = (date) => {
    const p = managementDateTimeParts(date);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return represented - Math.trunc(date.getTime() / 1000) * 1000;
  };
  const managementMidnightUtcMs = (parts) => {
    const naive = Date.UTC(parts.year, parts.month - 1, parts.day);
    let resolved = naive - managementTimezoneOffsetMs(new Date(naive));
    resolved = naive - managementTimezoneOffsetMs(new Date(resolved));
    return resolved;
  };
  const managementDayBounds = (date = '') => {
    const match = String(date || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const p = match
      ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
      : managementDateTimeParts(new Date());
    const nextDate = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    const dateKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    return {
      date: dateKey,
      start: new Date(managementMidnightUtcMs(p)),
      endExclusive: new Date(managementMidnightUtcMs({
        year: nextDate.getUTCFullYear(),
        month: nextDate.getUTCMonth() + 1,
        day: nextDate.getUTCDate()
      }))
    };
  };
  const DEFAULT_REJECTION_REASONS = [
    { id: 'no_height_map', label: 'No height map', icon: 'fas fa-mountain' },
    { id: 'no_satellite_image', label: 'No satellite image', icon: 'fas fa-satellite' },
    { id: 'obscured_visibility', label: 'Obscured visibility', icon: 'fas fa-cloud' },
    { id: 'invalid_pin_placement', label: 'Invalid pin placement', icon: 'fas fa-map-pin' },
    { id: 'incorrect_structure_type', label: 'Incorrect Structure Type', icon: 'fas fa-building' }
  ];
  const COVERAGE_REJECTION_DISCLAIMER =
`We do not currently have coverage for this address. We currently cover 95% of all buildings in the United States and we are actively working on increasing our area to cover more of the remaining buildings. We've logged your interest in structures like this and will prioritize being able to cover these in the near future.
Note: Our coverage is based on individual structure, not area - so we may have coverage for other properties in this same neighborhood.`;

  function ensureQueueOverviewStore(){
    if (window.PortalQueueOverviewStore) return window.PortalQueueOverviewStore;

    const cache = new Map();
    const inflight = new Map();
    const defaultTtlMs = 5000;
    const queueGroups = ['rework_requested', 'needs_structure_pins', 'waiting', 'requeue', 'queued', 'in_progress', 'qa_waiting', 'qa_claimed', 'release_holding', 'completed', 'rejected', 'cancelled'];

    const normalizeKey = (payload) => {
      const p = payload || {};
      return JSON.stringify({
        team: String(p.team ?? p.team_id ?? 'all').trim() || 'all',
        view: String(p.view ?? p.row_view ?? p.fields ?? 'card').trim() || 'card',
        include: p.include ?? null,
        limit: Math.max(1, Math.min(250, parseInt(p.bucketLimit ?? p.limit ?? 50, 10) || 50)),
        offsets: p.offsets || {}
      });
    };

    const fmBase = () => String(cfg()?.endpoints?.firstmeasure || '').replace(/\/+$/, '');
    const fmPost = (path, body) => {
      if (window.Portal && typeof window.Portal.fmPost === 'function') return window.Portal.fmPost(path, body);
      return fetch(fmBase() + '/' + String(path || '').replace(/^\/+/, ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(r => r.json());
    };
    const localDayWindow = () => {
      const bounds = managementDayBounds();
      return { activity_start: bounds.start.toISOString(), activity_end: new Date().toISOString() };
    };
    const pagePayload = (base, group, limit, offsets) => {
      const body = {
        view: base.view || 'card',
        group,
        limit,
        offset: Math.max(0, parseInt((offsets || {})[group], 10) || 0)
      };
      if (!['completed', 'rejected', 'cancelled'].includes(group)) body.include_all = true;
      const team = String(base.team ?? base.team_id ?? 'all').trim();
      if (team && team !== 'all') body.team_id = team;
      if (['completed', 'rejected', 'cancelled'].includes(group)) {
        Object.assign(body, localDayWindow());
        if (group === 'rejected') body.activity_fields = ['rejected'];
        else if (group === 'cancelled') body.activity_fields = ['cancelled'];
        else body.activity_fields = ['completed'];
      }
      return body;
    };
    const emptyBucket = (group, limit, offset) => ({
      success: true,
      group,
      projects: [],
      pagination: { limit, offset, count: 0, total_count: 0, has_more: false }
    });
    const normalizeBucket = (group, res, limit, offset) => {
      if (!res || res.success === false || res.ok === false) return emptyBucket(group, limit, offset);
      const pagination = res.pagination && typeof res.pagination === 'object' ? res.pagination : {};
      return {
        ...res,
        group,
        projects: Array.isArray(res.projects) ? res.projects : [],
        pagination: {
          limit,
          offset,
          count: Array.isArray(res.projects) ? res.projects.length : 0,
          total_count: Number.isFinite(Number(pagination.total_count))
            ? Number(pagination.total_count)
            : (Number.isFinite(Number(res.count)) ? Number(res.count) : (Array.isArray(res.projects) ? res.projects.length : 0)),
          has_more: !!pagination.has_more
        }
      };
    };
    const buildOverview = async (body) => {
      const limit = Math.max(1, Math.min(250, parseInt(body.bucketLimit ?? body.limit ?? 50, 10) || 50));
      const offsets = body.offsets || {};
      const countsPayload = { view: body.view || 'card', include_all: true };
      const team = String(body.team ?? body.team_id ?? 'all').trim();
      if (team && team !== 'all') countsPayload.team_id = team;
      const [countsRes, ...bucketResponses] = await Promise.all([
        fmPost('queue/counts', countsPayload).catch(() => null),
        ...queueGroups.map(group => {
          const payload = pagePayload(body, group, limit, offsets);
          return fmPost('queue/bucket', payload)
            .then(res => normalizeBucket(group, res, limit, payload.offset))
            .catch(() => emptyBucket(group, limit, payload.offset));
        })
      ]);
      const buckets = {};
      queueGroups.forEach((group, index) => { buckets[group] = bucketResponses[index] || emptyBucket(group, limit, 0); });
      const counts = (countsRes && countsRes.success !== false && countsRes.counts && typeof countsRes.counts === 'object') ? countsRes.counts : {};
      const qa = [...buckets.qa_waiting.projects, ...buckets.qa_claimed.projects];
      return {
        success: true,
        source: 'queue_index',
        rework_requested: buckets.rework_requested.projects,
        needs_structure_pins: buckets.needs_structure_pins.projects,
        waiting: buckets.waiting.projects,
        requeue: buckets.requeue.projects,
        queued: buckets.queued.projects,
        in_progress: buckets.in_progress.projects,
        qa,
        qa_waiting: buckets.qa_waiting.projects,
        qa_in_progress: buckets.qa_claimed.projects,
        release_holding: buckets.release_holding.projects,
        rejected: buckets.rejected.projects,
        cancelled: buckets.cancelled.projects,
        completed_today: buckets.completed.projects,
        completed_any: buckets.completed.projects,
        queue_meta: {
          counts,
          total_count: Number(countsRes?.total_count || 0),
          version: countsRes?.version || 0,
          bucket_limit: limit,
          buckets: Object.fromEntries(queueGroups.map(group => [group, buckets[group].pagination]))
        }
      };
    };

    const store = {
      get(payload = {}, options = {}){
        const body = { view: 'card', ...(payload || {}) };
        const key = normalizeKey(body);
      const now = Date.now();
        const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(0, Number(options.ttlMs)) : defaultTtlMs;
        const cached = cache.get(key);

        if (!options.forceNetwork && cached && (now - cached.at) < ttlMs) {
          return Promise.resolve({ ...cached.data, _cache: { hit: true, key, at: cached.at } });
        }

        if (!options.forceNetwork && inflight.has(key)) return inflight.get(key);

        const req = buildOverview(body).then((data) => {
          cache.set(key, { at: Date.now(), data });
          return { ...data, _cache: { hit: false, key, at: Date.now() } };
        }).finally(() => {
          inflight.delete(key);
        });

        inflight.set(key, req);
        return req;
      },

      invalidate(payload = null){
        if (!payload) {
          cache.clear();
          return;
        }
        cache.delete(normalizeKey({ view: 'card', ...(payload || {}) }));
      },

      peek(payload = {}){
        const entry = cache.get(normalizeKey({ view: 'card', ...(payload || {}) }));
        return entry ? entry.data : null;
      }
    };

    window.PortalQueueOverviewStore = store;
    return store;
  }

  const queueOverviewStore = ensureQueueOverviewStore();

  const Projects = {
    // -----------------------
    // state
    // -----------------------
    currentPage: 1,
    itemsPerPage: 35,
    currentFilter: 'mine',
    browserFilterInitialized: false,
    myProjectList: [],
    queueHasNext: false,
    queueCount: null,
    queuePollTimer: null,     // sidebar poll timer (kept running)
    queueBusy: false,
    queueAdminTimer: null,
    queueAdminHasLoaded: false,
    queueAdminTeam: 'all',
    queueAdminLastTeam: 'all',
    queueAdminTeams: [],
    queueAdminBucketLimit: 50,
    queueAdminBucketOffsets: {},
    completedTodayItems: [],
    completedTodayPriorityFilter: '',
    projectModalNavContext: null,
    queueAssignableUsers: null,
    queueAssignableUsersAt: 0,
    techLeaderboardRange: 'day',
    techLeaderboardDailyCache: new Map(),
    dashboardTeam: String(cfg()?.user?.team_id || '').trim() || 'all',
    dashboardTeams: [],
    dashboardTeamsPromise: null,
    appleKeyTimer: null,
    appleKeyPollTimer: null,
    appleKeyInfo: { key: null, updated_at_utc: null, tile_version: 10401 },
    // reject modal state
    rejectState: { folder:null, address:null, reason:null, correctType:null, busy:false },
    reopenProjectState: { folder:null, address:null, busy:false, images:[] },
    cancelProjectState: { folder:null, address:null, refundMode:null, busy:false },
    // coverage review state (NEW)
    normalizeReportExpediteOption(option){
      const normalized = String(option || '').trim().toLowerCase();
      if (normalized === 'rush_1_2' || normalized === 'rush_1_1_5') return 'rush_under_1';
      if (normalized === 'rush_2_3') return 'rush_1_3';
      if (normalized === 'rush_3_4' || normalized === 'no_rush') return 'standard_3_6';
      return normalized;
    },
    reportExpeditePriorityLevel(project){
      const p = project || {};
      const rawLevel = parseInt(p.priority_level || p.queue_priority_level || '', 10);
      if ([1,2,3].includes(rawLevel)) return rawLevel;
      if (p.qa_priority || p.manual_priority || p.prioritized) return 1;
      const opt = this.normalizeReportExpediteOption(p.report_expedite_option);
      let level = 3;
      if (opt === 'rush_under_1') level = 1;
      else if (opt === 'rush_1_3' || p.is_expedited) level = 2;
      if (p.is_vip) level = Math.min(level, 2);
      return level;
    },
    normalizeCompletedTodayPriorityFilter(value){
      const normalized = String(value || '').trim().toLowerCase();
      return ['1','2','3'].includes(normalized) ? normalized : 'all';
    },
    getCompletedTodayPriorityFilter(){
      if (this.completedTodayPriorityFilter) return this.normalizeCompletedTodayPriorityFilter(this.completedTodayPriorityFilter);
      try {
        return this.normalizeCompletedTodayPriorityFilter(localStorage.getItem('completed_today_priority_filter'));
      } catch {
        return 'all';
      }
    },
    setCompletedTodayPriorityFilter(value){
      this.completedTodayPriorityFilter = this.normalizeCompletedTodayPriorityFilter(value);
      try { localStorage.setItem('completed_today_priority_filter', this.completedTodayPriorityFilter); } catch {}
    },
    applyCompletedTodayPriorityFilter(items){
      const filter = this.getCompletedTodayPriorityFilter();
      const list = Array.isArray(items) ? items.slice() : [];
      if (filter === 'all') return list;
      const target = parseInt(filter, 10);
      return list.filter(item => this.reportExpeditePriorityLevel(item) === target);
    },
    syncCompletedTodayPriorityFilterUI(){
      const select = document.getElementById('completedTodayPriorityFilter');
      if (!select) return;
      const filter = this.getCompletedTodayPriorityFilter();
      if (select.value !== filter) select.value = filter;
      if (!select.dataset.bound) {
        select.dataset.bound = '1';
        select.addEventListener('change', (e) => {
          this.setCompletedTodayPriorityFilter(e.target?.value || 'all');
          const visibleCount = this.renderCompletedToday(this.completedTodayItems || []);
          this.setQueueSectionCount('qCompletedGrid', visibleCount);
        });
      }
    },
    reportExpediteOptionLabel(option){
      const normalized = this.normalizeReportExpediteOption(option);
      if (normalized === 'rush_under_1') return 'Less than 1 hr';
      if (normalized === 'rush_1_3') return '1-3 hrs';
      if (normalized === 'standard_3_6') return '4-7 hrs';
      return String(option || '').replace(/^rush_/, '').replace(/_/g, '-');
    },
    hasExpeditedDeadline(project){
      const p = project || {};
      const opt = this.normalizeReportExpediteOption(p.report_expedite_option);
      return opt === 'rush_under_1' || opt === 'rush_1_3' || !!p.is_expedited;
    },
    reportProductionDeadlineAt(project){
      const p = project || {};
      return this.hasExpeditedDeadline(p) ? (p.report_production_deadline_at || p.deadline_at || p.report_due_window_start || '') : '';
    },
    coverageState: {
      // folder -> { ok:boolean, checkedAt:number, dsmExists:boolean|null, maskExists:boolean|null }
      fileCheckCache: new Map(),
      // folder -> { busy:boolean }
      pushBusy: new Map(),
      // throttle scans
      lastScanAt: 0,
      scanIntervalMs: 60000,
      // max queued items to probe per refresh
      maxProbe: 30
    },
    // -----------------------
    // sidebar live refresh + ding (NEW)
    // -----------------------
    queuePollIntervalMs: 30000,
    dingAudio: null,
    lastSidebarHadWork: null,
    lastSidebarBtnDisabled: null,
    mineCache: { at: 0, projects: null },   // small cache to reduce load
    activeMineCache: { at: 0, projects: null },
    mineCacheTtlMs: 8000,
    browserWindowDaysByFilter: { all: 60, team: 60, mine: 120 },
    mineWindowDays: 120,
    // Break / idle state (NEW)
    breakState: {
      onBreak: false,
      breakStartedAt: null,     // ms timestamp
      lastSubmittedAt: null,    // ms timestamp
      idleTimeLoaded: false,    // true after first server fetch; skip subsequent polls
    },
    breakTickTimer: null,
    breakBusy: false,
    // -----------------------
    // Complexity helpers (1-5 scale)
    // -----------------------
    normalizeComplexity(val){
      if (val === null || val === undefined || val === '') return 3;
      if (typeof val === 'number') return Math.max(1, Math.min(5, Math.round(val)));
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) return n;
      const s = String(val).toLowerCase().trim();
      if (s === 'simple') return 1;
      if (s === 'complex') return 3;
      return 3;
    },
    complexityColor(level){
      const colors = { 1:'#34a853', 2:'#8bc34a', 3:'#f9ab00', 4:'#e37400', 5:'#d93025' };
      return colors[level] || '#f9ab00';
    },
    complexityBgColor(level){
      const bgs = { 1:'#e6f4ea', 2:'#f1f8e9', 3:'#fff8e1', 4:'#fff3e0', 5:'#fce8e6' };
      return bgs[level] || '#fff8e1';
    },
    complexityBadgeHtml(rawVal, style='tag'){
      const level = this.normalizeComplexity(rawVal);
      const color = this.complexityColor(level);
      const bg = this.complexityBgColor(level);
      const dots = '●'.repeat(level) + '○'.repeat(5 - level);
      if (style === 'badge') {
        return `<div class="badge-complexity" style="background:${color};">${level}/5</div>`;
      }
      return `<span class="qtag" style="background:${bg}; color:${color}; border-color:${color}44; font-size:9px; font-weight:950; letter-spacing:.5px;" title="Complexity ${level}/5">${dots} ${level}</span>`;
    },
    complexityPointValue(rawVal){
      const keyRaw = String(rawVal ?? '').trim().toLowerCase();
      if (!keyRaw) return null;
      const numeric = Number(keyRaw);
      const key = Number.isFinite(numeric)
        ? String(Math.trunc(numeric))
        : keyRaw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const map = {
        1: 2, 2: 3, 3: 4, 4: 6, 5: 10,
        very_simple: 2, very_simple_project: 2,
        simple: 3, simple_project: 3,
        standard: 4, standard_project: 4,
        complex: 6, complex_project: 6,
        very_complex: 10, very_complex_project: 10
      };
      const points = map[key];
      return Number.isFinite(Number(points)) ? Number(points) : null;
    },
    resolveProjectPoints(manifest){
      const direct = Number(
        manifest?.point_value
        ?? manifest?.project_points
        ?? manifest?.points_value
        ?? manifest?.points
      );
      if (Number.isFinite(direct) && direct > 0) return direct;
      return this.complexityPointValue(manifest?.complexity);
    },
    formatProjectPoints(points){
      const n = Number(points);
      if (!Number.isFinite(n) || n <= 0) return 'Points pending';
      const rounded = Math.round(n * 100) / 100;
      return `${rounded} point${Math.abs(rounded - 1) < 0.001 ? '' : 's'}`;
    },
    projectTimerRates(){
      return [
        { key:'green', label:'Very Fast', rate:19, color:'#34a853' },
        { key:'yellow', label:'Fast', rate:16, color:'#f4b400' },
        { key:'orange', label:'Standard', rate:13, color:'#e67700' },
        { key:'red', label:'Slow', rate:10, color:'#d93025' }
      ];
    },
    buildProjectTimerTimeline(points){
      const n = Number(points);
      if (!Number.isFinite(n) || n <= 0) return null;
      const sectionMinutes = [6 * n, 3 * n, 3 * n, 6 * n];
      const boundariesMs = [];
      let runningMs = 0;
      sectionMinutes.forEach(minutes => {
        runningMs += minutes * 60000;
        boundariesMs.push(runningMs);
      });
      return { totalMs: runningMs, boundariesMs, sectionMinutes };
    },
    projectTimerParseTs(raw){
      return this.safeParseTs(raw);
    },
    normalizeProjectTimerHistory(project){
      const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
      const sources = [project?.work_history, project?.technician_history, workflow.work_history, workflow.history];
      const seen = new Set();
      const output = [];
      for (const source of sources) {
        if (!Array.isArray(source)) continue;
        for (const entry of source) {
          if (!entry || typeof entry !== 'object') continue;
          const event = String(entry.event || entry.type || '').trim().toLowerCase();
          const ms = this.projectTimerParseTs(entry.ts || entry.at || entry.created_at || entry.assigned_at || entry.claimed_at || entry.submitted_at);
          if (!event || ms === null) continue;
          const key = `${event}:${ms}`;
          if (seen.has(key)) continue;
          seen.add(key);
          output.push({ event, ms });
        }
      }
      output.sort((a, b) => a.ms - b.ms);
      return output;
    },
    latestProjectTimerReopenMs(project){
      const events = this.normalizeProjectTimerHistory(project);
      let latest = this.projectTimerParseTs(project?.resubmitted_at || project?.last_resubmission_at || null);
      const resubmissions = Array.isArray(project?.resubmissions) ? project.resubmissions : [];
      for (const item of resubmissions) {
        const ms = this.projectTimerParseTs(item?.reopened_at || item?.resubmitted_at || null);
        if (ms !== null && (latest === null || ms > latest)) latest = ms;
      }
      for (const ev of events) {
        if (ev.event === 'project_reopened_for_edits' && (latest === null || ev.ms > latest)) latest = ev.ms;
      }
      return latest;
    },
    findProjectTimerStartMs(project){
      const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
      const assignedTo = workflow.assigned_to && typeof workflow.assigned_to === 'object' ? workflow.assigned_to : {};
      const reopenMs = this.latestProjectTimerReopenMs(project);
      const candidates = [
        project?.assigned_at, project?.claimed_at, project?.technician_claimed_at,
        workflow.assigned_at, workflow.claimed_at, assignedTo.assigned_at, assignedTo.claimed_at,
        project?.started_at, workflow.started_at
      ];
      for (const ev of this.normalizeProjectTimerHistory(project)) {
        if (ev.event.includes('claim') || ev.event.includes('assign')) candidates.push(ev.ms);
      }
      let startMs = null;
      for (const raw of candidates) {
        const ms = typeof raw === 'number' ? raw : this.projectTimerParseTs(raw);
        if (ms !== null && (reopenMs === null || ms >= reopenMs) && (startMs === null || ms < startMs)) {
          startMs = ms;
        }
      }
      return startMs;
    },
    terminalProjectTimerMs(project, startMs){
      const timestamps = project && typeof project.timestamps === 'object' ? project.timestamps : {};
      const candidates = [
        project?.uploaded_at, timestamps.uploaded_at,
        project?.qa_submitted_at, project?.submitted_at, timestamps.submitted_at,
        project?.completed_at, project?.qa_completed_at, project?.qa_approved_at
      ].map(ts => this.projectTimerParseTs(ts)).filter(ms => ms !== null && (startMs === null || ms >= startMs));
      return candidates.length ? Math.min(...candidates) : null;
    },
    projectTimerElapsed(project, useNowIfOpen=false){
      const startMs = this.findProjectTimerStartMs(project);
      if (startMs === null) return null;
      const pauseEvents = new Set([
        'submitted_for_qa', 'correction_submitted',
        'qa_rejected', 'qa_sent_back_to_tech',
        'manager_rejected', 'manager_sent_back_to_tech',
        'force_requeued', 'forced_requeue', 'project_force_requeued', 'sent_to_requeue', 'moved_to_requeue', 'requeued'
      ]);
      const resumeEvents = new Set(['claimed_correction', 'claimed_new', 'reopened_project_claimed']);
      const events = this.normalizeProjectTimerHistory(project)
        .filter(entry => entry.ms >= startMs)
        .map(entry => pauseEvents.has(entry.event) ? { type:'pause', ms:entry.ms } : (resumeEvents.has(entry.event) ? { type:'resume', ms:entry.ms } : null))
        .filter(Boolean);
      const submittedMs = this.terminalProjectTimerMs(project, startMs);
      if (submittedMs !== null) events.push({ type:'pause', ms:submittedMs });
      events.sort((a, b) => a.ms - b.ms);

      let activeStart = startMs;
      let paused = false;
      let totalMs = 0;
      let finalEventMs = null;
      for (const entry of events) {
        finalEventMs = entry.ms;
        if (entry.type === 'pause' && !paused) {
          totalMs += Math.max(0, entry.ms - activeStart);
          paused = true;
        } else if (entry.type === 'resume' && paused) {
          activeStart = entry.ms;
          paused = false;
        }
      }
      if (!paused) {
        const endMs = submittedMs !== null ? submittedMs : (useNowIfOpen ? Date.now() : null);
        if (endMs !== null && endMs >= activeStart) {
          totalMs += Math.max(0, endMs - activeStart);
          finalEventMs = endMs;
        }
      }
      return {
        startMs,
        endMs: finalEventMs,
        elapsedMs: Math.max(0, totalMs),
        isOpen: submittedMs === null && !paused
      };
    },
    projectTimerBandForElapsed(elapsedMs, timeline){
      const rates = this.projectTimerRates();
      if (!timeline || !Array.isArray(timeline.boundariesMs) || !Number.isFinite(elapsedMs)) return rates[rates.length - 1];
      for (let i = 0; i < timeline.boundariesMs.length; i++) {
        if (elapsedMs <= timeline.boundariesMs[i]) return rates[i];
      }
      return { ...rates[rates.length - 1], key:'overtime', label:'Over Time' };
    },
    formatProjectTimerDuration(ms, empty='--'){
      if (!Number.isFinite(ms) || ms < 0) return empty;
      const totalMinutes = Math.round(ms / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
    },
    fmtProjectTimerDateMs(ms){
      return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '\u2014';
    },
    buildProjectTimingSummary(project, useNowIfOpen=false){
      const points = this.resolveProjectPoints(project);
      const timeline = this.buildProjectTimerTimeline(points);
      if (!timeline) return null;
      const elapsed = this.projectTimerElapsed(project, useNowIfOpen);
      const rates = this.projectTimerRates();
      const bands = rates.map((band, idx) => ({
        ...band,
        boundaryMs: timeline.boundariesMs[idx] || timeline.totalMs,
        credit: Math.round(points * band.rate)
      }));
      const activeBand = elapsed ? this.projectTimerBandForElapsed(elapsed.elapsedMs, timeline) : null;
      const baseCredit = activeBand ? Math.round(points * activeBand.rate) : null;
      const rushEligible = !!(project?.rush_bonus_eligible && project?.rush_bonus_tag);
      const rushPercentRaw = Number(project?.rush_bonus_percent ?? project?.rush_bonus_amount ?? 25);
      const rushPercent = rushEligible ? (Number.isFinite(rushPercentRaw) && rushPercentRaw > 0 ? rushPercentRaw : 25) : 0;
      const rushBonus = baseCredit !== null && rushPercent > 0 ? Math.round(baseCredit * (rushPercent / 100)) : 0;
      return {
        points,
        timeline,
        bands,
        elapsed,
        activeBand,
        baseCredit,
        rushBonus,
        totalCredit: baseCredit !== null ? baseCredit + rushBonus : null,
        rushPercent
      };
    },
    canManageProjectComplexity(){
      const perms = cfg().perms || {};
      const flags = cfg().flags || {};
      const user = cfg().user || {};
      return !!user.is_admin
        || user.role === 'admin'
        || user.role === 'manager'
        || !!flags.is_manager_role
        || !!perms.manage_queue;
    },
    fmtLocalDateTime(ts){
      const t = this.safeParseTs(ts);
      if (!t) return (ts || '—');
      return new Date(t).toLocaleString();
    },
    fmtLocalDate(ts){
      const t = this.safeParseTs(ts);
      if (!t) return (ts || '—');
      return new Date(t).toLocaleDateString();
    },
    buildActivityWindow(days, fields){
      const safeDays = Math.max(1, parseInt(days, 10) || 1);
      const end = new Date();
      const start = new Date(end.getTime() - (safeDays * 24 * 60 * 60 * 1000));
      return {
        activity_start: start.toISOString(),
        activity_end: end.toISOString(),
        activity_fields: Array.isArray(fields) && fields.length ? fields.slice() : ['uploaded', 'started', 'completed']
      };
    },
    buildBrowserActivityParams(){
      const map = this.browserWindowDaysByFilter || {};
      const days = map[this.currentFilter] || map.mine || 90;
      return this.buildActivityWindow(days, ['uploaded', 'started', 'completed']);
    },
    buildMineActivityParams(){
      return this.buildActivityWindow(this.mineWindowDays || 120, ['uploaded', 'started', 'completed']);
    },
    getSearchFilter(){
      const perms = cfg().perms || {};
      if (perms.view_all_projects) return 'all';
      if (perms.view_team_projects) {
        return this.currentFilter === 'mine' ? 'mine' : 'team';
      }
      return 'mine';
    },
    buildClientPagination(totalCount, page, limit){
      const safeLimit = Math.max(1, parseInt(limit, 10) || this.itemsPerPage || 35);
      const safeTotal = Math.max(0, parseInt(totalCount, 10) || 0);
      const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
      const currentPage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
      return {
        current_page: currentPage,
        page: currentPage,
        limit: safeLimit,
        total_count: safeTotal,
        total_pages: totalPages
      };
    },
    fmtLocalTime(ts){
      const t = this.safeParseTs(ts);
      if (!t) return (ts || '—');
      return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    fmtLocalShort(ts){
      const t = this.safeParseTs(ts);
      if (!t) return (ts || '—');
      const d = new Date(t);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) return 'Today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    releaseHoldInfo(project){
      const delivery = (project && project.delivery && typeof project.delivery === 'object') ? project.delivery : {};
      const hold = (project && project.delivery_release_hold && typeof project.delivery_release_hold === 'object')
        ? project.delivery_release_hold
        : ((delivery.release_hold && typeof delivery.release_hold === 'object') ? delivery.release_hold : {});
      return {
        status: String(project?.delivery_hold_status || hold.status || '').trim().toLowerCase(),
        reason: String(project?.delivery_hold_reason || hold.reason || '').trim(),
        scheduled_release_at: project?.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '',
        promised_delivery_at: project?.delivery_hold_promised_delivery_at || hold.promised_delivery_at || '',
        expedite_option: project?.report_expedite_option || hold.expedite_option || ''
      };
    },
    releaseHoldIsActive(project){
      const hold = this.releaseHoldInfo(project);
      const ts = this.safeParseTs(hold.scheduled_release_at);
      return hold.status === 'holding' && !!ts && ts > Date.now();
    },
    startOfLocalDayMs(d=new Date()){
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    },
    isSameLocalDay(ts, dayStartMs){
      const t = this.safeParseTs(ts);
      if (!t) return false;
      return t >= dayStartMs && t < (dayStartMs + 24*60*60*1000);
    },
    init(){
      this.currentPage = 1;
      this.ensurePageSpacingStyle();
      this.initFilters();
      const lightweightTechnician = this.isDraftingTechnician();
      if (!lightweightTechnician) {
        this.fetchProjects();
      }
      this.ensurePrioritySectionStyle();
      this.ensurePaginationStyle();
      // Always refresh queue sidebar once
      if (lightweightTechnician) {
        this.refreshQueueButton(true).finally(() => this.refreshTechnicianDashboard(false).catch(()=>{}));
      } else {
        this.refreshQueueButton(true);
      }
      // NEW: always poll sidebar state every few seconds
      if (!this.queuePollTimer) {
        this.queuePollTimer = setInterval(() => {
          // button is always visible; keep it live regardless of view
          this.refreshQueueButton(false);
        }, this.queuePollIntervalMs);
      }
      // Preload ding audio (best-effort)
      this.ensureDingAudio();
      // Break/idle panel (NEW)
      this.ensureBreakStyle();
      if (!this.breakTickTimer) {
        this.breakTickTimer = setInterval(() => this.tickBreakIdle(), 1000);
      }
      if (cfg().flags.is_queue_admin) {
        this.initQueueAdminTeams().catch(()=>{});
        this.ensureQueueRejectUI();
        this.ensureQueueCancelledUI();
        this.ensureQueueRequeueUI();
        this.ensureQueueWaitingUI();
        this.ensureQueueQASplitUI();
        this.ensureCollapsibleStyle();
      } else if (cfg().flags.is_manager_role) {
        this.ensureQueueRejectUI();
      }
      // expose globals used by inline onclick attrs
      window.openProjectModal = (id) => this.openProjectModal(id);
      window.directOpen = (id) => this.directOpen(id);
      window.handleNextInQueueClick = () => this.handleNextInQueueClick();
      window.refreshQueueAdmin = (force) => this.refreshQueueAdmin(!!force);
      window.refreshAppleKey = (force) => this.refreshAppleKey(!!force);
      window.saveAppleKey = () => this.saveAppleKey();
      window.saveAppleTileVersion = () => this.saveAppleTileVersion();
      window.copyAppleKey = () => this.copyAppleKey();
      window.testAppleKey = () => this.testAppleKey();
      window.Projects = this; // ensure toggleBreak accessible via Projects.toggleBreak()
    },
    ensurePageSpacingStyle(){
      if (document.getElementById('portalPageSpacingStyles')) return;
      const style = document.createElement('style');
      style.id = 'portalPageSpacingStyles';
      style.textContent = `
        .main-content > [id^="view-"] {
          box-sizing: border-box;
          padding: 30px;
        }
        #portalPluginViews {
          box-sizing: border-box;
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
          width: 100%;
        }
        #portalPluginViews > [id^="view-"] {
          box-sizing: border-box;
          padding: 30px;
        }
        body.qa-editor-fullscreen .main-content > [id^="view-"],
        body.qa-editor-fullscreen #portalPluginViews,
        body.qa-editor-fullscreen #portalPluginViews > [id^="view-"],
        body.qa-editor-fullscreen #view-qa {
          padding: 0 !important;
        }
        @media (max-width: 820px) {
          .main-content > [id^="view-"],
          #portalPluginViews > [id^="view-"] {
            padding: 18px;
          }
          body.qa-editor-fullscreen .main-content > [id^="view-"],
          body.qa-editor-fullscreen #portalPluginViews,
          body.qa-editor-fullscreen #portalPluginViews > [id^="view-"],
          body.qa-editor-fullscreen #view-qa {
            padding: 0 !important;
          }
        }
      `;
      document.head.appendChild(style);
    },
    isDraftingTechnician(){
      return !!cfg().flags?.is_drafting_technician;
    },
    canViewTechnicianDashboard(){
      return !!cfg().flags?.can_view_technician_dashboard || this.isDraftingTechnician();
    },
    fmActor(){
      const u = (cfg().user || {});
      const actor = {};
      if (u.id) actor.id = u.id;
      if (u.email) actor.email = u.email;
      if (u.name) actor.name = u.name;
      if (u.role) actor.role = u.role;
      if (u.drafter_rank) actor.drafter_rank = u.drafter_rank;
      const teamId = String(u.team_id || '').trim();
      if (teamId && teamId.toLowerCase() !== 'default' && teamId.toLowerCase() !== 'all') actor.team_id = teamId;
      if (u.organization_id) actor.organization_id = u.organization_id;
      const roles = [];
      if (u.is_admin) roles.push('admin');
      if (cfg().flags?.is_queue_admin) roles.push('queue_admin');
      if (cfg().flags?.is_manager_role) roles.push('manager');
      if (roles.length) actor.roles = roles;
      return actor;
    },
    fmUrl(path){
      const base = String(cfg().endpoints.firstmeasure || '').replace(/\/+$/, '');
      const suffix = String(path || '').replace(/^\/+/, '');
      return `${base}/${suffix}`;
    },
    fmThumbnailUrl(projectId, source='google.png', width=320){
      const id = encodeURIComponent(String(projectId || '').trim());
      const src = encodeURIComponent(String(source || 'google.png').trim() || 'google.png');
      const w = Math.max(80, Math.min(960, parseInt(width, 10) || 320));
      return this.fmUrl(`projects/${id}/thumbnail?w=${w}&source=${src}`);
    },
    getQueueMode(){
      return String(cfg().user?.queue_mode || 'disabled').trim() || 'disabled';
    },
    async fmPost(path, payload={}, opts={}){
      const body = { ...(payload || {}) };
      if (opts.includeActor !== false && !body.actor) body.actor = this.fmActor();
      const res = await fetch(this.fmUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
      return await res.json();
    },
    async fmUploadArtifact(projectId, file, fileName, fieldName='file'){
      const fd = new FormData();
      fd.append(fieldName, file, fileName);
      const res = await fetch(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts`), {
        method: 'POST',
        body: fd
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`FirstMeasure returned invalid JSON (${res.status}).`);
      }
      if (!res.ok || (data && data.success === false)) {
        throw new Error(data.message || data.error || `FirstMeasure upload failed (${res.status}).`);
      }
      return data;
    },
    async fmGet(path){
      const res = await fetch(this.fmUrl(path), {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return await res.json();
    },
    getWorkHistory(source){
      const data = (source && typeof source === 'object') ? source : {};
      const workflow = (data.workflow && typeof data.workflow === 'object') ? data.workflow : {};
      if (Array.isArray(data.work_history)) return data.work_history;
      if (Array.isArray(workflow.history)) return workflow.history;
      return [];
    },
    getLatestWorkEventTs(source, eventNames){
      const eventSet = new Set((Array.isArray(eventNames) ? eventNames : []).map(name => String(name || '').trim()).filter(Boolean));
      if (!eventSet.size) return null;
      const history = this.getWorkHistory(source);
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (!ev || typeof ev !== 'object') continue;
        const evType = String(ev.event || '').trim();
        if (!eventSet.has(evType)) continue;
        const ts = this.safeParseTs(ev.ts || ev.date || ev.created_at || ev.updated_at || '');
        if (ts) return ts;
      }
      return null;
    },
    getLatestProjectTs(source, keys){
      let latest = null;
      (Array.isArray(keys) ? keys : []).forEach((key) => {
        const ts = this.safeParseTs(source?.[key]);
        if (ts && (!latest || ts > latest)) latest = ts;
      });
      return latest;
    },
    getInProgressStageEnteredTs(source){
      return this.getLatestWorkEventTs(source, ['claimed_correction', 'claimed_new'])
        || this.getLatestProjectTs(source, ['assigned_at', 'assignedAt', 'started_at', 'startedAt', 'in_progress_at', 'inProgressAt', 'working_at', 'claimed_at', 'claimedAt'])
        || this.safeParseTs(source?.created_at || source?.createdAt || source?.created);
    },
    getProjectCreatedTs(source){
      return this.safeParseTs(source?.created_at || source?.createdAt || source?.created)
        || this.safeParseTs(source?.queued_at || source?.uploaded_at || source?.date || source?.updated_at);
    },
    queueAgeClass(source, kind = '', now = Date.now()){
      const status = String(source?.status || '').toLowerCase().trim().replace(/\s+/g, '_');
      const terminalStatuses = new Set(['completed', 'rejected', 'rejected_no_coverage', 'cancelled', 'canceled']);
      const terminalKinds = new Set(['completed', 'rejected', 'cancelled', 'canceled']);
      if (terminalStatuses.has(status) || terminalKinds.has(String(kind || '').toLowerCase())) return '';

      const createdTs = this.getProjectCreatedTs(source);
      if (!createdTs) return '';

      const ageMs = Math.max(0, now - createdTs);
      if (ageMs >= 4 * 60 * 60 * 1000) return 'qcard--age-critical';
      if (ageMs >= 3 * 60 * 60 * 1000) return 'qcard--age-warning';
      return '';
    },
    buildTechnicianHistory(source){
      const data = (source && typeof source === 'object') ? source : {};
      const asRecord = (value) => (value && typeof value === 'object') ? value : {};
      const workHistory = this.getWorkHistory(data);
      const entries = new Map();
      const touch = (emailRaw, nameRaw, meta = {}) => {
        const email = String(emailRaw || '').trim();
        const name = String(nameRaw || '').trim();
        if (!email && !name) return;
        const key = email ? `email:${email.toLowerCase()}` : `name:${name.toLowerCase()}`;
        const ts = meta.ts ? String(meta.ts) : '';
        const tsValue = this.safeParseTs(ts);
        const current = entries.get(key) || {
          email: email || '',
          name: name || '',
          first_ts: '',
          last_ts: '',
          first_event: '',
          last_event: '',
          claim_count: 0,
          correction_count: 0,
          sent_back_count: 0,
          events: [],
          is_current_assignee: false,
          is_correction_target: false
        };
        if (!current.email && email) current.email = email;
        if (!current.name && name) current.name = name;
        const firstValue = this.safeParseTs(current.first_ts);
        const lastValue = this.safeParseTs(current.last_ts);
        if (ts) {
          if (!firstValue || (tsValue && tsValue < firstValue)) {
            current.first_ts = ts;
            current.first_event = meta.event || current.first_event || '';
          }
          if (!lastValue || (tsValue && tsValue >= lastValue) || (!tsValue && !current.last_ts)) {
            current.last_ts = ts;
            current.last_event = meta.event || current.last_event || '';
          }
        }
        if (meta.event) {
          current.events.push(meta.event);
          if (['claimed_new','claimed_correction','submitted_for_qa','correction_submitted'].includes(meta.event)) current.claim_count += 1;
          if (['claimed_correction','correction_submitted'].includes(meta.event)) current.correction_count += 1;
          if (['qa_rejected','qa_sent_back_to_tech','manager_sent_back_to_tech'].includes(meta.event)) current.sent_back_count += 1;
        }
        if (meta.isCurrentAssignee) current.is_current_assignee = true;
        if (meta.isCorrectionTarget) current.is_correction_target = true;
        entries.set(key, current);
      };

      workHistory.forEach((ev) => {
        if (!ev || typeof ev !== 'object') return;
        touch(ev.worker_email || ev.assigned_to_email, ev.worker_name || ev.assigned_to_name, {
          event: String(ev.event || '').trim(),
          ts: ev.ts || ev.date || ''
        });
      });

      touch(data.assigned_to_email, data.assigned_to_name, {
        event: 'assigned_current',
        ts: data.assigned_at || data.started_at || data.updated_at || '',
        isCurrentAssignee: !!(data.assigned_to_email || data.assigned_to_name)
      });
      touch(data.correction_to_email, data.correction_to_name, {
        event: 'correction_target',
        ts: data.correction_requested_at || data.updated_at || '',
        isCorrectionTarget: !!(data.correction_to_email || data.correction_to_name)
      });

      return Array.from(entries.values())
        .map((entry) => ({
          ...entry,
          events: Array.from(new Set((Array.isArray(entry.events) ? entry.events : []).filter(Boolean)))
        }))
        .sort((a, b) => {
          const aFirst = this.safeParseTs(a.first_ts) || Number.MAX_SAFE_INTEGER;
          const bFirst = this.safeParseTs(b.first_ts) || Number.MAX_SAFE_INTEGER;
          if (aFirst !== bFirst) return aFirst - bFirst;
          const aLast = this.safeParseTs(a.last_ts) || 0;
          const bLast = this.safeParseTs(b.last_ts) || 0;
          if (aLast !== bLast) return aLast - bLast;
          return String(a.email || a.name || '').localeCompare(String(b.email || b.name || ''));
        });
    },
    getProjectTechnicianContext(source){
      const history = this.buildTechnicianHistory(source);
      const status = String((source && source.status) || '').toLowerCase().trim();
      const original = history[0] || null;
      const latest = history.length ? history[history.length - 1] : null;
      const currentAssigned = (source && (source.assigned_to_email || source.assigned_to_name))
        ? { email: String(source.assigned_to_email || '').trim(), name: String(source.assigned_to_name || '').trim() }
        : null;
      const correctionTarget = (source && (source.correction_to_email || source.correction_to_name))
        ? { email: String(source.correction_to_email || '').trim(), name: String(source.correction_to_name || '').trim() }
        : ((status === 'correction_needed' || status === 'requeue') ? latest : null);
      const display = currentAssigned || latest || original || null;
      return { history, original, latest, currentAssigned, correctionTarget, display };
    },
    getDisplayTechnician(source){
      const tech = this.getProjectTechnicianContext(source).display;
      if (!tech) return { name: '', email: '' };
      return {
        name: String(tech.name || '').trim(),
        email: String(tech.email || '').trim()
      };
    },
    getPayTechnician(source){
      const data = (source && typeof source === 'object') ? source : {};
      const techEvents = new Set(['correction_submitted', 'submitted_for_qa', 'claimed_correction', 'claimed_new', 'reopened_project_claimed', 'assigned_current', 'correction_target']);
      const qaEmails = new Set([
        data.qa_claimed_by_email,
        data.qa_approved_by_email,
        data.qa_approved_by,
        data.qa_reviewed_by_email,
        data.qa_reviewed_by,
        data.workflow?.qa_claim?.email
      ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean));

      const history = this.getWorkHistory(data);
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (!ev || typeof ev !== 'object') continue;
        const eventName = String(ev.event || ev.type || '').toLowerCase().trim();
        if (!techEvents.has(eventName)) continue;
        const email = String(ev.worker_email || ev.assigned_to_email || ev.email || '').toLowerCase().trim();
        const name = String(ev.worker_name || ev.assigned_to_name || ev.name || email || '').trim();
        if (email && qaEmails.has(email)) continue;
        if (email || name) return { email, name: name || email, basis: eventName, at: ev.ts || ev.at || ev.date || '' };
      }

      const techCtx = this.getProjectTechnicianContext(data);
      const entries = Array.isArray(techCtx.history) ? techCtx.history.slice().reverse() : [];
      for (const entry of entries) {
        const email = String(entry?.email || '').toLowerCase().trim();
        const name = String(entry?.name || '').trim();
        if (email && qaEmails.has(email)) continue;
        if (email || name) return { email, name: name || email, basis: entry?.last_event || 'technician_history', at: entry?.last_ts || '' };
      }

      const candidates = [
        { email: data.latest_technician_email, name: data.latest_technician_name, basis: 'latest_technician' },
        { email: data.display_technician_email, name: data.display_technician_name, basis: 'display_technician' },
        { email: data.assigned_to_email, name: data.assigned_to_name, basis: 'assigned_to' },
        { email: data.technician_email, name: data.technician_name, basis: 'technician' },
        { email: data.drafter_email, name: data.drafter_name, basis: 'drafter' }
      ];
      for (const candidate of candidates) {
        const email = String(candidate.email || '').toLowerCase().trim();
        const name = String(candidate.name || '').trim();
        if (email && qaEmails.has(email)) continue;
        if (email || name) return { email, name: name || email, basis: candidate.basis, at: '' };
      }
      return { email: '', name: '', basis: '', at: '' };
    },
    getLeaderboardTechnician(source){
      const data = (source && typeof source === 'object') ? source : {};
      const techEvents = new Set(['submitted_for_qa', 'correction_submitted', 'claimed_new', 'claimed_correction', 'reopened_project_claimed']);
      const qaEmails = new Set([
        data.qa_claimed_by_email,
        data.qa_approved_by_email,
        data.qa_approved_by,
        data.qa_reviewed_by_email,
        data.qa_reviewed_by,
        data.workflow?.qa_claim?.email
      ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean));
      const history = this.getWorkHistory(data);
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (!ev || typeof ev !== 'object') continue;
        const eventName = String(ev.event || ev.type || '').toLowerCase().trim();
        if (!techEvents.has(eventName)) continue;
        const email = String(ev.worker_email || ev.assigned_to_email || '').toLowerCase().trim();
        const name = String(ev.worker_name || ev.assigned_to_name || email || '').trim();
        if (email || name) return { email, name };
      }

      const candidates = [
        { email: data.display_technician_email, name: data.display_technician_name },
        { email: data.latest_technician_email, name: data.latest_technician_name },
        { email: data.original_technician_email, name: data.original_technician_name },
        { email: data.assigned_to_email, name: data.assigned_to_name },
        { email: data.technician_email, name: data.technician_name },
        { email: data.drafter_email, name: data.drafter_name }
      ];
      for (const candidate of candidates) {
        const email = String(candidate.email || '').toLowerCase().trim();
        const name = String(candidate.name || '').trim();
        if (!email && !name) continue;
        if (email && qaEmails.has(email)) continue;
        return { email, name: name || email };
      }
      return { email: '', name: '' };
    },
    getProjectQaActorEmail(source){
      const data = (source && typeof source === 'object') ? source : {};
      const candidates = [
        data.qa_claimed_by_email,
        data.qa_approved_by_email,
        data.qa_approved_by,
        data.qa_reviewed_by_email,
        data.qa_reviewed_by,
        data.workflow?.qa_claim?.email
      ];
      for (const candidate of candidates) {
        const email = String(candidate || '').toLowerCase().trim();
        if (email) return email;
      }
      const history = this.getWorkHistory(data);
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (!ev || typeof ev !== 'object') continue;
        const eventName = String(ev.event || ev.type || '').toLowerCase().trim();
        if (!['qa_approved', 'qa_approved_pending_manager', 'qa_reviewed', 'qa_claimed'].includes(eventName)) continue;
        const email = String(ev.qa_email || ev.qa_reviewer_email || ev.by_email || ev.user_email || '').toLowerCase().trim();
        if (email) return email;
      }
      return '';
    },
    getProjectQaActivityTs(source){
      const data = (source && typeof source === 'object') ? source : {};
      const direct = this.safeParseTs(data.qa_approved_at || data.qa_reviewed_at || data.qa_completed_at || data.completed_at || data.date || '');
      if (direct) return direct;
      const history = this.getWorkHistory(data);
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (!ev || typeof ev !== 'object') continue;
        const eventName = String(ev.event || ev.type || '').toLowerCase().trim();
        if (!['qa_approved', 'qa_approved_pending_manager', 'qa_reviewed', 'qa_claimed'].includes(eventName)) continue;
        const ts = this.safeParseTs(ev.ts || ev.at || ev.date || ev.created_at || '');
        if (ts) return ts;
      }
      return null;
    },
    async collectActiveQaEmailsForLeaderboard(){
      const emails = new Set();
      try {
        const data = await queueOverviewStore.get({
          team: this.dashboardTeam || 'all',
          include: 'qa,pending_rejection',
          view: 'card'
        }, { ttlMs: 10000 });
        const qaItems = [
          ...(Array.isArray(data?.qa) ? data.qa : []),
          ...(Array.isArray(data?.qa_waiting) ? data.qa_waiting : []),
          ...(Array.isArray(data?.qa_in_progress) ? data.qa_in_progress : []),
          ...(Array.isArray(data?.pending_rejection) ? data.pending_rejection : [])
        ];
        qaItems.forEach((item) => {
          const email = String(item?.qa_claimed_by_email || item?.workflow?.qa_claim?.email || '').toLowerCase().trim();
          if (email) emails.add(email);
        });
      } catch {}
      return emails;
    },
    getCorrectionTargetTechnician(source){
      const tech = this.getProjectTechnicianContext(source).correctionTarget;
      if (!tech) return { name: '', email: '' };
      return {
        name: String(tech.name || '').trim(),
        email: String(tech.email || '').trim()
      };
    },
    normalizeProjectManifest(manifest){
      const m = (manifest && typeof manifest === 'object') ? { ...manifest } : {};
      const asRecord = (value) => (value && typeof value === 'object') ? value : {};
      const timestamps = asRecord(m.timestamps);
      const workflow = asRecord(m.workflow);
      const ownerRef = asRecord(m.owner_ref);
      const orgRef = asRecord(m.organization_ref);
      const teamRef = asRecord(m.team_ref);
      const audit = asRecord(m.audit);
      const delivery = asRecord(m.delivery);
      const assigned = asRecord(workflow.assigned_to);
      const reserved = asRecord(workflow.reserved_to);
      const correction = asRecord(workflow.correction_to);
      const qaClaim = asRecord(workflow.qa_claim);
      const artifacts = asRecord(m.artifacts);
      const hasOwn = (key) => Object.prototype.hasOwnProperty.call(m, key);
      const firstNonBlank = (...values) => {
        for (const value of values) {
          if (value === null || typeof value === 'undefined') continue;
          const text = String(value).trim();
          if (text) return text;
        }
        return '';
      };
      const pickTop = (key, fallback = '') => hasOwn(key) ? firstNonBlank(m[key], fallback) : firstNonBlank(fallback);
      const normalized = {
        ...m,
        owner_email: m.owner_email || ownerRef.email || '',
        owner_name: m.owner_name || ownerRef.name || '',
        organization_id: m.organization_id || orgRef.id || '',
        team_id: m.team_id || teamRef.id || '',
        created_at: pickTop('created_at', timestamps.created_at || ''),
        queued_at: pickTop('queued_at', timestamps.queued_at || ''),
        processed_at: pickTop('processed_at', timestamps.processed_at || ''),
        started_at: pickTop('started_at', timestamps.started_at || ''),
        uploaded_at: pickTop('uploaded_at', timestamps.uploaded_at || ''),
        completed_at: pickTop('completed_at', timestamps.completed_at || ''),
        rejected_at: pickTop('rejected_at', timestamps.rejected_at || ''),
        cancelled_at: pickTop('cancelled_at', timestamps.cancelled_at || ''),
        updated_at: pickTop('updated_at', timestamps.updated_at || ''),
        assigned_to_email: pickTop('assigned_to_email', assigned.email || ''),
        assigned_to_name: pickTop('assigned_to_name', assigned.name || ''),
        assigned_at: pickTop('assigned_at', workflow.assigned_at || null),
        reserved_to_email: pickTop('reserved_to_email', reserved.email || ''),
        reserved_to_name: pickTop('reserved_to_name', reserved.name || ''),
        reserved_at: pickTop('reserved_at', workflow.reserved_at || null),
        correction_to_email: pickTop('correction_to_email', correction.email || ''),
        correction_to_name: pickTop('correction_to_name', correction.name || ''),
        qa_claimed_by_email: pickTop('qa_claimed_by_email', qaClaim.email || ''),
        qa_claimed_by_name: pickTop('qa_claimed_by_name', qaClaim.name || ''),
        qa_claimed_at: pickTop('qa_claimed_at', qaClaim.claimed_at || null),
        qa_history: Array.isArray(m.qa_history) ? m.qa_history : (Array.isArray(workflow.qa_history) ? workflow.qa_history : []),
        work_history: Array.isArray(m.work_history) ? m.work_history : (Array.isArray(workflow.history) ? workflow.history : []),
        manager_audit_status: m.manager_audit_status ?? audit.manager_audit_status ?? null,
        manager_audit_note: m.manager_audit_note ?? audit.manager_audit_note ?? null,
        manager_audit_annotations: m.manager_audit_annotations ?? audit.manager_audit_annotations ?? null,
        report_sent_at: m.report_sent_at || delivery.report_sent_at || null,
        email_state: m.email_state || delivery.email_state || {},
        email_events: Array.isArray(m.email_events) ? m.email_events : (Array.isArray(delivery.email_events) ? delivery.email_events : []),
        has_report_pdf: m.has_report_pdf ?? !!artifacts.has_report_pdf,
        has_summary_pdf: m.has_summary_pdf ?? !!artifacts.has_summary_pdf
      };
      const techCtx = this.getProjectTechnicianContext(normalized);
      const payTech = this.getPayTechnician({ ...normalized, technician_history: techCtx.history });
      return {
        ...normalized,
        technician_history: techCtx.history,
        original_technician_email: techCtx.original?.email || '',
        original_technician_name: techCtx.original?.name || '',
        latest_technician_email: techCtx.latest?.email || '',
        latest_technician_name: techCtx.latest?.name || '',
        display_technician_email: techCtx.display?.email || '',
        display_technician_name: techCtx.display?.name || '',
        qa_paid_to_email: payTech.email || normalized.qa_paid_to_email || '',
        qa_paid_to_name: payTech.name || normalized.qa_paid_to_name || '',
        technician_pay_to_email: payTech.email || normalized.technician_pay_to_email || '',
        technician_pay_to_name: payTech.name || normalized.technician_pay_to_name || '',
        technician_pay_basis: payTech.basis || normalized.technician_pay_basis || '',
        technician_pay_basis_at: payTech.at || normalized.technician_pay_basis_at || '',
        effective_correction_to_email: techCtx.correctionTarget?.email || '',
        effective_correction_to_name: techCtx.correctionTarget?.name || ''
      };
    },
    projectIncludesGutters(project){
      const data = (project && typeof project === 'object') ? project : {};
      const metadata = (data.metadata && typeof data.metadata === 'object') ? data.metadata : {};
      const order = (data.order && typeof data.order === 'object') ? data.order : {};
      const candidates = [
        data.include_gutter_measurements,
        data.include_gutters,
        data.gutter_measurements,
        data.gutters,
        metadata.include_gutter_measurements,
        metadata.include_gutters,
        order.include_gutter_measurements,
        order.include_gutters
      ];
      for (const value of candidates) {
        if (value === null || typeof value === 'undefined' || value === '') continue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value > 0;
        const text = String(value).trim().toLowerCase();
        if (['0', 'false', 'no', 'n', 'off', 'exclude', 'excluded'].includes(text)) return false;
        if (['1', 'true', 'yes', 'y', 'on', 'include', 'included', 'gutters'].includes(text)) return true;
      }
      return false;
    },
    buildProjectModalData(projectId, project){
      const detail = (project && typeof project === 'object') ? project : {};
      const manifest = this.normalizeProjectManifest(detail.manifest || {});
      const files = Array.isArray(detail.files) ? detail.files : [];
      const images = files
        .map((file) => String(file && file.name ? file.name : '').trim())
        .filter((name) => {
          const ext = name.split('.').pop()?.toLowerCase() || '';
          return ['png', 'jpg', 'jpeg'].includes(ext);
        })
        .map((name) => ({
          name,
          url: this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(name)}`),
          thumbnail_url: this.fmThumbnailUrl(projectId, name, 320)
        }));
      return {
        success: true,
        manifest,
        images,
        pdf_url: this.fmUrl(`projects/${encodeURIComponent(projectId)}/pdf?slot=main`)
      };
    },
    getThumbnailCandidateMeta(value){
      const raw = String(value || '').trim();
      if (!raw) {
        return { raw: '', lower: '', ext: '', score: -1000, suspicious: false };
      }
      const lower = raw.toLowerCase();
      const extMatch = lower.match(/\.([a-z0-9]+)(?:\?|#|$)/);
      const ext = extMatch ? extMatch[1] : '';
      let score = 0;

      if (/(^|[\/_-])solar([\/_. -]|$)/.test(lower)) score += 140;
      if (/top[ _-]?down|topdown/.test(lower)) score += 130;
      if (/(^|[\/_-])overview([\/_. -]|$)|aerial/.test(lower)) score += 45;
      if (/browser_thumbnail|cover_thumbnail/.test(lower)) score += 80;
      if (/google\.png(?:$|[?#])/.test(lower)) score += 100;
      if (/azure\.png(?:$|[?#])/.test(lower)) score += 85;
      if (/apple\.png(?:$|[?#])/.test(lower)) score += 80;
      if (/rgb_preview|rgb_png|rgb_jpg|rgb\.png|rgb\.jpg|rgb\.jpeg/.test(lower)) score += 78;
      if (/rgb\.tif|rgb\.tiff/.test(lower)) score += 38;
      if (/\.(png|jpg|jpeg|webp)(?:$|[?#])/.test(lower)) score += 28;
      if (/source_/.test(lower)) score -= 18;
      if (/quad|quad_crop|north|south|east|west|street|elev/.test(lower)) score -= 220;
      if (/qa-|qa_|qa_note_thread|thread|annotation|markup|gutter/.test(lower)) score -= 200;
      if (/report|summary|manifest|pdf_state|model_data|insights|mask|dsm|sources_notes/.test(lower)) score -= 240;
      if (/\.(json|pdf|xml|txt)(?:$|[?#])/.test(lower)) score -= 260;

      return {
        raw,
        lower,
        ext,
        score,
        suspicious: /quad|quad_crop|north|south|east|west|street|elev|qa-|qa_|qa_note_thread|thread|annotation|markup|gutter|source_/.test(lower)
      };
    },
    isSuspiciousThumbnailUrl(value){
      return this.getThumbnailCandidateMeta(value).suspicious;
    },
    pickBestThumbnailCandidate(candidates){
      let best = null;
      let bestMeta = null;
      (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
        const meta = this.getThumbnailCandidateMeta(candidate);
        if (!meta.raw) return;
        if (meta.suspicious) return;
        if (!bestMeta || meta.score > bestMeta.score) {
          best = meta.raw;
          bestMeta = meta;
        }
      });
      return { url: best, meta: bestMeta };
    },
    buildProjectThumbnailCandidates(project){
      const flat = this.normalizeProjectManifest(project);
      const projectId = String(flat.id || flat.folder || flat.project_id || '').trim();
      const assets = (flat.assets && typeof flat.assets === 'object') ? flat.assets : {};
      const artifacts = (flat.artifacts && typeof flat.artifacts === 'object') ? flat.artifacts : {};
      const rawThumbnail = String(flat.thumbnail || '').trim();
      const candidates = [];
      const addCandidate = (value) => {
        const url = String(value || '').trim();
        if (!url || candidates.includes(url)) return;
        candidates.push(url);
      };
      const addThumbnailCandidate = (source) => {
        if (!projectId) return;
        addCandidate(this.fmThumbnailUrl(projectId, source, 320));
      };
      const rawThumbnailIsSuspicious = this.isSuspiciousThumbnailUrl(rawThumbnail);

      if (projectId) {
        if (artifacts.has_google_image || assets.google) addThumbnailCandidate('google.png');
        if (artifacts.has_azure_image || assets.azure) addThumbnailCandidate('azure.png');
        if (artifacts.has_apple_image || assets.apple) addThumbnailCandidate('apple.png');
      }

      // Browser cards should prefer top-down project imagery over ad-hoc uploads.
      [
        flat.top_down_thumbnail,
        flat.topdown_thumbnail,
        flat.top_view_thumbnail,
        flat.top_view_image,
        flat.cover_thumbnail,
        flat.browser_thumbnail,
        assets.solarImg,
        assets.solarimg,
        assets.solar_img,
        assets.solar,
        assets.top_down,
        assets.topdown,
        assets.top_view,
        assets.topview,
        assets.top_view_image,
        assets.topView,
        assets.topViewImage,
        assets.rgb_preview,
        assets.rgb_png,
        assets.rgb_jpg,
        assets.google
      ].forEach(addCandidate);

      if (projectId && !assets.google && artifacts.has_google_image) {
        addCandidate(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/google.png`));
      }
      if (projectId && !assets.azure && artifacts.has_azure_image) {
        addCandidate(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/azure.png`));
      }
      if (projectId && !assets.apple && artifacts.has_apple_image) {
        addCandidate(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/apple.png`));
      }

      if (projectId && rawThumbnailIsSuspicious) {
        addCandidate(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/google.png`));
      }

      if (rawThumbnail && !rawThumbnailIsSuspicious) addCandidate(rawThumbnail);
      if (assets.azure) addCandidate(assets.azure);
      if (assets.apple) addCandidate(assets.apple);
      if (!candidates.length && projectId) {
        addCandidate(this.fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/google.png`));
      }

      return candidates.filter((candidate) => !this.isSuspiciousThumbnailUrl(candidate));
    },
    pickProjectThumbnail(project){
      const candidates = this.buildProjectThumbnailCandidates(project);
      return this.pickBestThumbnailCandidate(candidates).url || candidates[0] || null;
    },
    bindThumbnailFallback(img, candidates){
      if (!img) return;
      const urls = (Array.isArray(candidates) ? candidates : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      if (!urls.length) {
        img.removeAttribute('src');
        img.style.display = 'none';
        return;
      }
      let index = Math.max(0, urls.findIndex((value) => value === String(img.getAttribute('src') || '').trim()));
      const showCandidate = (targetIndex) => {
        const nextUrl = String(urls[targetIndex] || '').trim();
        if (!nextUrl) {
          img.style.display = 'none';
          return false;
        }
        img.style.display = '';
        img.src = nextUrl;
        return true;
      };
      img.onerror = () => {
        index += 1;
        if (!showCandidate(index)) {
          img.style.display = 'none';
        }
      };
    },
    wrapTileBadgeStack(position, badges){
      const items = (Array.isArray(badges) ? badges : [])
        .map((badge) => String(badge || '').trim())
        .filter(Boolean);
      if (!items.length) return '';
      return `<div class="tile-badge-stack ${position}">${items.join('')}</div>`;
    },
    toProjectBrowserRows(projects){
      return (Array.isArray(projects) ? projects : []).map((project) => {
        const flat = this.normalizeProjectManifest(project);
        const projectId = String(flat.id || flat.folder || flat.project_id || '').trim();
        const thumbnailCandidates = this.buildProjectThumbnailCandidates(flat);
        return {
          ...flat,
          id: projectId,
          owner: flat.owner || flat.owner_name || flat.owner_email || flat.issuer?.name || flat.issuer?.email || 'Unknown',
          thumbnail_candidates: thumbnailCandidates,
          thumbnail: this.pickBestThumbnailCandidate(thumbnailCandidates).url || thumbnailCandidates[0] || null
        };
      });
    },
    searchProjectMatches(project, queryLower){
      const flat = this.normalizeProjectManifest(project);
      const address = String(flat.address || '').toLowerCase();
      const projectId = String(flat.id || flat.folder || flat.project_id || '').toLowerCase();
      return address.includes(queryLower) || projectId.includes(queryLower);
    },
    async fetchSearchProjectsFallback(query){
      const queryLower = String(query || '').trim().toLowerCase();
      const targetPage = Math.max(1, parseInt(this.currentPage, 10) || 1);
      const displayLimit = Math.max(1, parseInt(this.itemsPerPage, 10) || 35);
      const pageSize = 200;
      const neededMatches = targetPage * displayLimit;
      const matches = [];
      let page = 1;
      let totalPages = 1;
      let exhausted = false;

      while (page <= totalPages) {
        const res = await this.fmGet(`projects?include_all=1&page=${page}&limit=${pageSize}&view=card`);
        if (!res || res.ok === false) {
          throw new Error(res?.message || res?.error || 'Unable to load search fallback projects.');
        }
        const batch = Array.isArray(res.projects) ? res.projects : [];
        const count = Math.max(0, parseInt(res.count, 10) || 0);
        totalPages = Math.max(1, Math.ceil((count || batch.length) / pageSize));

        batch.forEach((project) => {
          if (!this.searchProjectMatches(project, queryLower)) return;
          const normalized = this.toProjectBrowserRows([project])[0];
          if (normalized && normalized.id) matches.push(normalized);
        });

        if (!batch.length || page >= totalPages) {
          exhausted = true;
          break;
        }
        if (matches.length >= neededMatches) {
          break;
        }
        page += 1;
      }

      const pagination = exhausted
        ? this.buildClientPagination(matches.length, targetPage, displayLimit)
        : {
            ...this.buildClientPagination(Math.max(matches.length + 1, neededMatches + 1), targetPage, displayLimit),
            partial: true
          };
      const start = (pagination.current_page - 1) * pagination.limit;
      const end = start + pagination.limit;

      return {
        ok: true,
        success: true,
        projects: matches.slice(start, end),
        pagination
      };
    },
    async fetchSearchProjects(){
      const query = String(this.searchQuery || '').trim();
      if (!query) {
        return {
          ok: true,
          success: true,
          projects: [],
          pagination: this.buildClientPagination(0, 1, this.itemsPerPage)
        };
      }
      const page = Math.max(1, parseInt(this.currentPage, 10) || 1);
      const limit = Math.max(1, parseInt(this.itemsPerPage, 10) || 35);
      const serverResult = await this.fmPost('projects/list', {
        filter: this.getSearchFilter(),
        page,
        limit,
        search: query,
        view: 'card'
      });
      if (serverResult && serverResult.ok !== false && serverResult.success !== false) {
        return {
          ...serverResult,
          projects: this.toProjectBrowserRows(serverResult.projects)
        };
      }
      return await this.fetchSearchProjectsFallback(query);
    },
    ensureQueueRejectedUI(){
      if (!cfg().flags.is_queue_admin) return;
      if (document.getElementById('qRowRejected')) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const completedGrid = document.getElementById('qCompletedGrid');
      const completedSection = completedGrid ? completedGrid.closest('.queue-section') : null;
      const section = document.createElement('div');
      section.className = 'queue-section';
      section.innerHTML = `
        <h3>
          <i class="fas fa-ban" style="color:#b0261e;"></i>
          Rejected
        </h3>
        <div class="hscroll" id="qRowRejected"></div>
      `;
      if (completedSection && completedSection.parentNode) completedSection.insertAdjacentElement('afterend', section);
      else panel.appendChild(section);
    },
    ensureQueueCancelledUI(){
      if (!cfg().flags.is_queue_admin) return;
      if (document.getElementById('qRowCancelled')) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const rejectedRow = document.getElementById('qRowRejected');
      const rejectedSection = rejectedRow ? rejectedRow.closest('.queue-section') : null;
      const completedGrid = document.getElementById('qCompletedGrid');
      const completedSection = completedGrid ? completedGrid.closest('.queue-section') : null;
      const section = document.createElement('div');
      section.className = 'queue-section';
      section.innerHTML = `
        <h3>
          <i class="fas fa-circle-xmark" style="color:#5f6368;"></i>
          Cancelled
        </h3>
        <div class="hscroll" id="qRowCancelled"></div>
      `;
      if (rejectedSection) rejectedSection.insertAdjacentElement('afterend', section);
      else if (completedSection) completedSection.insertAdjacentElement('afterend', section);
      else panel.appendChild(section);
    },
    canSeeReleaseHoldingQueue(){
      const user = cfg().user || {};
      return !!user.is_admin || user.role === 'admin';
    },
    ensureQueueReleaseHoldingUI(){
      const existing = document.getElementById('qRowReleaseHolding');
      if (!cfg().flags.is_queue_admin || !this.canSeeReleaseHoldingQueue()) {
        const section = existing ? existing.closest('.queue-section') : null;
        if (section) section.remove();
        return;
      }
      if (existing) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const completedGrid = document.getElementById('qCompletedGrid');
      const completedSection = completedGrid ? completedGrid.closest('.queue-section') : null;
      const section = document.createElement('div');
      section.className = 'queue-section';
      section.innerHTML = `
        <h3>
          <i class="fas fa-hourglass-half" style="color:#e37400;"></i>
          Projects Holding for Release
        </h3>
        <div class="hscroll" id="qRowReleaseHolding"></div>
      `;
      if (completedSection && completedSection.parentNode) completedSection.parentNode.insertBefore(section, completedSection);
      else panel.appendChild(section);
    },
    isBouncedForMe(p){
      const me = (cfg().user.email || '').toLowerCase().trim();
      const wh = Array.isArray(p.work_history) ? p.work_history : [];
      for (const ev of wh){
        if (!ev || typeof ev !== 'object') continue;
        if (ev.event !== 'qa_rejected' && ev.event !== 'qa_sent_back_to_tech') continue;
        const w = String(ev.worker_email || '').toLowerCase().trim();
        if (w && w === me) return true;
      }
      return false;
    },
    /**
     * Detect if a project is a correction/rework (kicked back from QA).
     * Checks qa_reject_count first, then falls back to work_history.
     */
    isRework(p){
      if (p.qa_reject_count && parseInt(p.qa_reject_count, 10) > 0) return true;
      const wh = Array.isArray(p.work_history) ? p.work_history : [];
      for (let i = wh.length - 1; i >= 0; i--) {
        const ev = wh[i];
        if (!ev || typeof ev !== 'object') continue;
        const evType = String(ev.event || '');
        if (evType === 'claimed_correction' || evType === 'qa_rejected' || evType === 'qa_sent_back_to_tech' || evType === 'manager_sent_back_to_tech') return true;
        if (evType === 'claimed_new') return false;
      }
      return false;
    },
    stopTimers(){
      // NOTE: sidebar poll stays alive (do NOT clear queuePollTimer)
      // if (this.breakTickTimer) { clearInterval(this.breakTickTimer); this.breakTickTimer = null; }
      if (this.queueAdminTimer) { clearInterval(this.queueAdminTimer); this.queueAdminTimer = null; }
      if (this.appleKeyTimer) { clearInterval(this.appleKeyTimer); this.appleKeyTimer = null; }
      if (this.appleKeyPollTimer) { clearInterval(this.appleKeyPollTimer); this.appleKeyPollTimer = null; }
    },
    async onShowProjects(){
      this.fetchProjects();
    },
    async onShowDashboard(){
      await this.initDashboardTeams(true);
      await this.refreshTechnicianDashboard(false);
    },

    dashboardTeamStorageKey(){
      return `fm-dashboard-team:${String(cfg()?.user?.email || 'user').toLowerCase()}`;
    },

    async initDashboardTeams(force=false){
      const select = document.getElementById('dashboardTeamSelect');
      if (!select) return;
      if (force) this.dashboardTeamsPromise = null;
      if (!this.dashboardTeamsPromise) {
        const base = String(cfg()?.endpoints?.internal || '').replace(/\/+$/, '');
        this.dashboardTeamsPromise = fetch(`${base}/teams`, { credentials:'include', cache:'no-store', headers:{ Accept:'application/json' } })
          .then(response => response.ok ? response.json() : Promise.reject(new Error(`Teams request failed (${response.status})`)))
          .then(data => Array.isArray(data?.teams) ? data.teams : [])
          .catch(error => {
            console.warn('Dashboard team list could not load', error);
            this.dashboardTeamsPromise = null;
            return [];
          });
      }
      this.dashboardTeams = await this.dashboardTeamsPromise;
      const available = new Set(this.dashboardTeams.map(team => String(team.id || '')));
      let preferred = '';
      try { preferred = String(localStorage.getItem(this.dashboardTeamStorageKey()) || ''); } catch {}
      const actorTeam = String(cfg()?.user?.team_id || '').trim();
      const candidate = preferred || this.dashboardTeam || actorTeam || 'all';
      this.dashboardTeam = candidate === 'all' || available.has(candidate) ? candidate : (available.has(actorTeam) ? actorTeam : 'all');
      select.innerHTML = [
        '<option value="all">All Teams</option>',
        ...this.dashboardTeams.map(team => `<option value="${Portal.escapeHtml(team.id || '')}">${Portal.escapeHtml(team.name || team.id || 'Team')}</option>`)
      ].join('');
      select.value = this.dashboardTeam;
      if (!select.dataset.bound) {
        select.dataset.bound = '1';
        select.addEventListener('change', () => this.setDashboardTeam(select.value));
      }
    },

    async setDashboardTeam(teamId){
      const next = String(teamId || 'all').trim() || 'all';
      if (next === this.dashboardTeam) return;
      this.dashboardTeam = next;
      try { localStorage.setItem(this.dashboardTeamStorageKey(), next); } catch {}
      const active = document.getElementById('shiftStatusBody');
      const leaderboard = document.getElementById('technicianDashboardLeaderboardMount');
      if (active) active.innerHTML = '<div class="sh-empty"><i class="fas fa-circle-notch fa-spin"></i> Loading…</div>';
      if (leaderboard) leaderboard.innerHTML = '<div class="technician-dashboard-loading"><i class="fas fa-circle-notch fa-spin"></i> Loading leaderboard...</div>';
      await Promise.all([
        this.refreshTechnicianLeaderboard(false),
        window.Shifts?.refreshActiveData ? Shifts.refreshActiveData(false) : Promise.resolve()
      ]);
    },
    async onShowQueue(){
      if (!cfg().flags.is_queue_admin) return;
      this.ensureQueueRejectUI();
      this.ensureQueueCancelledUI();
      this.ensureQueueRequeueUI();
      this.ensureQueueWaitingUI();
      this.ensureQueueQASplitUI();
      this.ensureQueueReleaseHoldingUI();
      this.ensureCollapsibleStyle();
      await this.initQueueAdminTeams();
      await this.refreshQueueAdmin(true);
      this.queueAdminTimer = setInterval(() => this.refreshQueueAdmin(false), 5000);
    },
    async onShowAppleKey(){
      if (!cfg().flags.is_apple_key_admin) return;
      // one-time inject UI
      this.ensureAppleTestUI();
      // always fetch once when tab opens
      await this.refreshAppleKey(true);
      // keep the "age" display feeling live
      this.appleKeyTimer = setInterval(() => {
        this.renderAppleKeyInfo(this.appleKeyInfo);
      }, 5000);
      // poll server every 30s to see if key changed
      this.appleKeyPollTimer = setInterval(() => {
        const view = document.getElementById('view-apple-key');
        if (!view || view.style.display === 'none') return;
        this.refreshAppleKey(false);
      }, 30000);
    },
    // -----------------------
    // Ding helpers (NEW)
    // -----------------------
    ensureDingAudio(){
      if (this.dingAudio) return;
      try {
        const a = new Audio('audio/ding.mp3');
        a.preload = 'auto';
        a.volume = 0.85;
        this.dingAudio = a;
      } catch {
        this.dingAudio = null;
      }
    },
    async playDing(){
      this.ensureDingAudio();
      if (!this.dingAudio) return;
      try {
        this.dingAudio.currentTime = 0;
        await this.dingAudio.play();
      } catch {
        // autoplay may be blocked until user interacts; ignore
      }
    },
    // -----------------------
    // Collapsible queue sections
    // -----------------------
    ensureCollapsibleStyle(){
      if (document.getElementById('qCollapsibleStyle')) return;
      const style = document.createElement('style');
      style.id = 'qCollapsibleStyle';
      style.textContent = `
        .queue-section > h3 {
          cursor: pointer;
          user-select: none;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .queue-section > h3 .q-collapse-chevron {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px; height: 20px;
          font-size: 11px;
          color: #999;
          transition: transform .2s ease;
          margin-right: 2px;
          flex-shrink: 0;
        }
        .queue-section.collapsed > h3 .q-collapse-chevron {
          transform: rotate(-90deg);
        }
        .queue-section > h3 .q-priority-filter {
          height: 28px;
          border: 1px solid #dadce0;
          border-radius: 8px;
          background: #fff;
          color: #333;
          font-size: 12px;
          font-weight: 800;
          padding: 0 8px;
          cursor: pointer;
        }
        .queue-section > .q-collapse-body {
          transition: max-height .25s ease, opacity .2s ease;
        }
        .queue-section.collapsed > .q-collapse-body {
          max-height: 0 !important;
          opacity: 0;
          overflow: hidden;
        }
        /* Filler toggle switch */
        .q-filler-switch {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 10px;
          font-weight: 900;
          color: #888;
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
          margin-left: auto;
          padding: 2px 0;
        }
        .q-filler-switch .q-switch-track {
          position: relative;
          width: 30px; height: 16px;
          border-radius: 999px;
          background: #dadce0;
          transition: background .15s ease;
          flex-shrink: 0;
        }
        .q-filler-switch .q-switch-track .q-switch-thumb {
          position: absolute;
          top: 2px; left: 2px;
          width: 12px; height: 12px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,.18);
          transition: left .15s ease;
        }
        .q-filler-switch.active .q-switch-track {
          background: #1a73e8;
        }
        .q-filler-switch.active .q-switch-track .q-switch-thumb {
          left: 16px;
        }
        .queue-section--requeue {
          background: #f3f4f6;
          border: 1px solid #e1e5ea;
          border-radius: 14px;
          padding: 14px 14px 12px;
        }
        .queue-section--requeue > h3 {
          margin-bottom: 10px;
        }
        .queue-section--requeue .qcard {
          background: #fafbfc;
          border-color: #d9dee5;
        }
        .queue-section--requeue .qempty {
          padding-left: 4px;
        }
        .queue-section--structure-pins{
          background:linear-gradient(135deg,#fff8f7 0%,#ffffff 100%);
          border:1px solid #f1b7b2;
          border-radius:14px;
          padding:14px 14px 12px;
          box-shadow:0 10px 24px rgba(217,48,37,.08);
        }
        .queue-section--structure-pins > h3{
          color:#a50e0e;
          margin-bottom:10px;
        }
        .queue-section--structure-pins .qcard{
          border-color:#e9a5a0;
          background:#fffdfc;
        }
        .queue-section--structure-pins .qempty{
          padding-left:4px;
        }
      `;
      document.head.appendChild(style);
    },
    getCollapsedSections(){
      try {
        const raw = localStorage.getItem('queue_collapsed_sections');
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    },
    setCollapsedSection(key, collapsed){
      try {
        const state = this.getCollapsedSections();
        if (collapsed) state[key] = true;
        else delete state[key];
        localStorage.setItem('queue_collapsed_sections', JSON.stringify(state));
      } catch {}
    },
    /**
     * Walk all .queue-section elements inside the queue view and wire up
     * collapse/expand toggle on their <h3>. Idempotent — skips sections
     * that are already wired.
     */
    applyCollapsibleSections(){
      const view = document.getElementById('view-queue');
      if (!view) return;
      const savedState = this.getCollapsedSections();
      view.querySelectorAll('.queue-section').forEach(section => {
        const h3 = section.querySelector('h3');
        if (!h3) return;
        // Determine a stable key from the body container's id
        const bodyChild = section.querySelector('.hscroll, .completed-grid, [id^="qCompletedGrid"]')
          || section.querySelector('[id]:not(h3):not(.q-collapse-body)');
        const sectionKey = bodyChild ? bodyChild.id : null;
        if (!sectionKey) return;

        // Wrap body content in a .q-collapse-body div if not already done
        if (!section.querySelector('.q-collapse-body')) {
          const wrapper = document.createElement('div');
          wrapper.className = 'q-collapse-body';
          const children = Array.from(section.children).filter(c => c !== h3);
          children.forEach(c => wrapper.appendChild(c));
          section.appendChild(wrapper);
        }

        // Inject chevron if not already present
        if (!h3.querySelector('.q-collapse-chevron')) {
          const chevron = document.createElement('span');
          chevron.className = 'q-collapse-chevron';
          chevron.innerHTML = '<i class="fas fa-chevron-down"></i>';
          h3.insertBefore(chevron, h3.firstChild);
        }

        // Inject per-section filler toggle switch if not already present
        if (!h3.querySelector('.q-filler-switch')) {
          const hideFiller = this.getSectionHideFiller(sectionKey);
          const sw = document.createElement('span');
          sw.className = 'q-filler-switch' + (hideFiller ? ' active' : '');
          sw.dataset.sectionKey = sectionKey;
          sw.title = 'Hide filler jobs in this section';
          sw.innerHTML = `<span class="q-switch-track"><span class="q-switch-thumb"></span></span><span class="q-switch-label">Hide filler</span>`;
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = sw.classList.toggle('active');
            this.setSectionHideFiller(sectionKey, isActive);
            this.refreshQueueAdmin(true);
          });
          h3.appendChild(sw);
        } else {
          // Sync switch state with localStorage (in case it changed)
          const sw = h3.querySelector('.q-filler-switch');
          const hideFiller = this.getSectionHideFiller(sectionKey);
          sw.classList.toggle('active', hideFiller);
        }

        // Apply saved collapsed state
        if (savedState[sectionKey]) {
          section.classList.add('collapsed');
        }
        // Wire click (only once)
        if (!h3.dataset.collapseBound) {
          h3.dataset.collapseBound = '1';
          h3.addEventListener('click', (e) => {
            // Don't toggle if clicking an interactive child
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'label') return;
            if (e.target.closest('input, button, select, label, .q-filler-switch')) return;
            const isCollapsed = section.classList.toggle('collapsed');
            this.setCollapsedSection(sectionKey, isCollapsed);
          });
        }
      });
    },
    // -----------------------
    // Break / idle feature (NEW)
    // -----------------------
    ensureBreakStyle(){
      if (document.getElementById('breakIdleStyle')) return;
      const style = document.createElement('style');
      style.id = 'breakIdleStyle';
      style.textContent = `
        .break-panel{
          display:flex; align-items:center; gap:8px;
          white-space:nowrap;
        }
        .break-panel .bp-text{
          font-size:12px; font-weight:800; color:#555;
          display:inline-flex; align-items:center; gap:5px;
        }
        .break-panel .bp-text .bp-time{
          color:#1a73e8; font-variant-numeric:tabular-nums;
        }
        .break-panel.on-break .bp-text{
          color:#b0261e;
        }
        .break-panel.on-break .bp-text .bp-time{
          color:#b0261e;
        }
        .break-toggle-btn{
          display:inline-flex; align-items:center; gap:5px;
          border-radius:999px; padding:4px 10px;
          font-size:10px; font-weight:900;
          border:1px solid #e0e0e0; background:#fafafa; color:#555;
          cursor:pointer; user-select:none;
          transition: all .15s ease;
        }
        .break-toggle-btn:hover{
          border-color:#bbb; background:#f0f0f0;
        }
        .break-toggle-btn:disabled{
          opacity:.5; cursor:not-allowed;
        }
        .break-toggle-btn.return-btn{
          border-color:#c8e6c9; background:#e6f4ea; color:#137333;
        }
        .break-toggle-btn.return-btn:hover{
          border-color:#137333;
        }
      `;
      document.head.appendChild(style);
    },
    renderBreakIdlePanel(containerEl){
      if (!containerEl) return;
      const { onBreak, breakStartedAt, lastSubmittedAt } = this.breakState;
      const now = Date.now();
      let html = '';
      if (onBreak) {
        const elapsed = breakStartedAt ? (now - breakStartedAt) : 0;
        html = `
          <div class="break-panel on-break">
            <span class="bp-text">
              On a break &middot; <span class="bp-time" id="breakElapsed">${this.fmtElapsed(elapsed)}</span>
            </span>
            <button class="break-toggle-btn return-btn" id="breakToggleBtn"
                    onclick="Projects.toggleBreak(false)" title="End break and return to your shift">
              <i class="fas fa-rotate-left"></i> Return
            </button>
          </div>
        `;
      } else {
        const idle = lastSubmittedAt ? (now - lastSubmittedAt) : 0;
        const idleText = lastSubmittedAt
          ? `Idle: <span class="bp-time" id="breakElapsed">${this.fmtElapsed(idle)}</span>`
          : `<span class="bp-time" id="breakElapsed">&mdash;</span>`;
        html = `
          <div class="break-panel">
            <span class="bp-text">${idleText}</span>
            <button class="break-toggle-btn" id="breakToggleBtn"
                    onclick="Projects.toggleBreak(true)" title="Take a break">
              <i class="fas fa-mug-hot"></i> Break
            </button>
          </div>
        `;
      }
      containerEl.innerHTML = html;
    },
    tickBreakIdle(){
      const el = document.getElementById('breakElapsed');
      if (!el) return;
      const { onBreak, breakStartedAt, lastSubmittedAt } = this.breakState;
      const now = Date.now();
      if (onBreak) {
        el.textContent = breakStartedAt ? this.fmtElapsed(now - breakStartedAt) : '\u2014';
      } else {
        el.textContent = lastSubmittedAt ? this.fmtElapsed(now - lastSubmittedAt) : '\u2014';
      }
    },
    fmtElapsed(ms){
      if (!ms || ms < 0) ms = 0;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
      return `${m}:${pad(s)}`;
    },
    async toggleBreak(goOnBreak){
      if (this.breakBusy) return;
      this.breakBusy = true;
      const btn = document.getElementById('breakToggleBtn');
      if (btn) { btn.disabled = true; }
      try {
        const res = await Portal.apiPost(cfg().endpoints.server, {
          action: 'set_break_status',
          actor: this.fmActor(),
          on_break: goOnBreak ? '1' : '0'
        });
        if (!res || !res.success) {
          alert(res?.error || 'Failed to update break status.');
          return;
        }
        this.breakState.onBreak = !!res.on_break;
        if (res.on_break && res.break_started_at) {
          this.breakState.breakStartedAt = this.safeParseTs(res.break_started_at);
        } else {
          this.breakState.breakStartedAt = null;
          // Reset idle timer to now when returning from break
          this.breakState.lastSubmittedAt = Date.now();
        }
        // Re-render sidebar to reflect new state
        await this.refreshQueueButton(true);
      } catch (e) {
        alert('Failed to update break status (network).');
      } finally {
        this.breakBusy = false;
        if (btn) btn.disabled = false;
      }
    },
    // -----------------------
    // Queue rejection UI (existing)
    // -----------------------
    ensureQueueRejectUI(){
      if (!cfg().flags.is_queue_admin && !cfg().flags.is_manager_role) return;
      if (document.getElementById('qRejectOverlay')) return;
      const style = document.createElement('style');
      style.id = 'qRejectStyle';
      style.textContent = `
        .qact-row{ margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
        .qbtn{
          display:inline-flex; align-items:center; gap:7px;
          border-radius:999px; padding:6px 10px;
          font-size:11px; font-weight:900;
          border:1px solid #eee; background:#fff; color:#333;
          cursor:pointer; user-select:none;
        }
        .qbtn:hover{ transform: translateY(-1px); border-color:#dadce0; }
        .qbtn.danger{ border-color:#f4b4ae; background:#fce8e6; color:#b0261e; }
        .qbtn.danger:hover{ border-color:#d93025; }
        .qbtn.primary{ border-color:#d2e3fc; background:#e8f0fe; color:#1a73e8; }
        .qbtn.primary:hover{ border-color:#1a73e8; }
        .qbtn:disabled{ opacity:.6; cursor:not-allowed; transform:none; }
        .qrej-overlay{
          position:fixed; inset:0; background:rgba(0,0,0,0.6);
          display:none; align-items:center; justify-content:center;
          z-index: 99999; backdrop-filter: blur(3px);
        }
        .qrej-card{
          width: 640px; max-width: 94vw;
          background:#fff; border-radius:14px;
          box-shadow:0 24px 70px rgba(0,0,0,0.45);
          overflow:hidden;
        }
        .qrej-head{
          padding:16px 18px; border-bottom:1px solid #eee;
          display:flex; align-items:center; justify-content:space-between; gap:12px;
        }
        .qrej-title{ font-weight:950; font-size:14px; color:#111; display:flex; align-items:center; gap:10px; }
        .qrej-x{
          width:36px; height:36px; border-radius:10px;
          border:1px solid #eee; background:#fff; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        }
        .qrej-body{ padding:16px 18px; }
        .qrej-addr{
          font-weight:950; color:#111; font-size:13px; line-height:1.3;
          margin-bottom: 12px;
        }
        .qrej-disc{
          border:1px solid #f4b4ae; background:#fce8e6;
          border-radius:12px; padding:12px 12px;
          color:#7a1b18; font-weight:800; font-size:12px; line-height:1.35;
          white-space: pre-wrap;
        }
        .qrej-reasons{
          margin-top:12px; display:flex; flex-direction:column; gap:8px;
        }
        .qrej-reasons-label{
          display:block; font-size:11px; font-weight:900; color:#777;
          text-transform:uppercase; letter-spacing:.4px;
        }
        .qrej-structure-type{
          display:none; margin-top:4px; padding:12px;
          border:1px solid #ffcc80; border-radius:10px;
          background:#fff8e1;
        }
        .qrej-structure-type.active{ display:block; }
        .qrej-type-options{ display:flex; gap:8px; flex-wrap:wrap; }
        .qrej-type-btn{
          border:1px solid #ddd; background:#fff; color:#333;
          border-radius:8px; padding:9px 12px; font-size:12px;
          font-weight:900; cursor:pointer; display:inline-flex;
          align-items:center; gap:7px;
        }
        .qrej-type-btn.active{
          border-color:#d93025; background:#fff5f5; color:#d93025;
        }
        .qrej-reason-btn{
          border:2px solid #ddd; border-radius:10px; background:#fff;
          padding:10px 12px; cursor:pointer; text-align:left;
          display:flex; align-items:center; gap:9px;
          color:#333; font-size:13px; font-weight:900;
        }
        .qrej-reason-btn:hover{ border-color:#aaa; }
        .qrej-reason-btn.active{
          border-color:#d93025; background:#fff5f5; color:#d93025;
        }
        .qrej-reason-btn i{ width:18px; color:#888; }
        .qrej-reason-btn.active i{ color:#d93025; }
        .qrej-note{
          margin-top:12px;
        }
        .qrej-note label{
          display:block; font-size:11px; font-weight:900; color:#777;
          text-transform:uppercase; letter-spacing:.4px;
          margin-bottom:6px;
        }
        .qrej-note textarea{
          width:100%; min-height: 90px;
          border-radius:10px; border:1px solid #ddd;
          padding:10px; font-size:13px; box-sizing:border-box;
          resize: vertical;
        }
        .qrej-foot{
          padding:14px 18px; border-top:1px solid #eee;
          background:#fafafa;
          display:flex; justify-content:flex-end; gap:10px;
        }
        .qrej-btn{
          border-radius:10px; padding:10px 14px;
          font-weight:900; cursor:pointer;
          border:1px solid #ddd; background:#fff; color:#333;
          display:inline-flex; align-items:center; gap:8px;
        }
        .qrej-btn.primary{
          border-color:#d93025; background:#d93025; color:#fff;
        }
        .qrej-btn.primary:disabled{
          background:#f1f3f4; border-color:#dadce0; color:#9aa0a6; cursor:not-allowed;
        }
      `;
      document.head.appendChild(style);
      const cfgReasons = Array.isArray(cfg().rejection_reasons)
        ? cfg().rejection_reasons.filter(reason => reason && reason.id && reason.label)
        : [];
      const rejectionReasons = cfgReasons.length ? cfgReasons : DEFAULT_REJECTION_REASONS;
      const reasonsHtml = rejectionReasons.map((reason) => {
        const id = Portal.escapeHtml(reason.id);
        const label = Portal.escapeHtml(reason.label);
        const icon = Portal.escapeHtml(reason.icon || 'fas fa-circle-exclamation');
        return `<button type="button" class="qrej-reason-btn" data-reason="${id}" data-label="${label}"><i class="${icon}"></i><span>${label}</span></button>`;
      }).join('');
      const overlay = document.createElement('div');
      overlay.id = 'qRejectOverlay';
      overlay.className = 'qrej-overlay';
      overlay.innerHTML = `
        <div class="qrej-card" role="dialog" aria-modal="true">
          <div class="qrej-head">
            <div class="qrej-title">
              <i class="fas fa-circle-exclamation" style="color:#d93025;"></i>
              Reject (No Coverage)
            </div>
            <button class="qrej-x" id="qRejectCloseBtn" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="qrej-body">
            <div class="qrej-addr" id="qRejectAddr">—</div>
            <div class="qrej-disc" id="qRejectDisc"></div>
            <div class="qrej-reasons">
              <span class="qrej-reasons-label">Rejection reason</span>
              ${reasonsHtml || '<div style="font-size:12px; color:#b0261e; font-weight:800;">Rejection reasons are unavailable. Reload and try again.</div>'}
              <div class="qrej-structure-type" id="qRejectStructureType">
                <span class="qrej-reasons-label">Correct structure type</span>
                <div class="qrej-type-options">
                  <button type="button" class="qrej-type-btn" data-correct-type="commercial"><i class="fas fa-building"></i> Commercial</button>
                  <button type="button" class="qrej-type-btn" data-correct-type="multifamily"><i class="fas fa-house-chimney-window"></i> Multi-family</button>
                </div>
              </div>
            </div>
            <div class="qrej-note">
              <label>Internal note (optional)</label>
              <textarea id="qRejectNote" placeholder="Visible to staff only (optional)…"></textarea>
            </div>
          </div>
          <div class="qrej-foot">
            <button class="qrej-btn" id="qRejectCancelBtn"><i class="fas fa-ban"></i> Cancel</button>
            <button class="qrej-btn primary" id="qRejectConfirmBtn"><i class="fas fa-paper-plane"></i> Reject & Email</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => this.closeRejectModal();
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      document.getElementById('qRejectCloseBtn')?.addEventListener('click', close);
      document.getElementById('qRejectCancelBtn')?.addEventListener('click', close);
      document.getElementById('qRejectConfirmBtn')?.addEventListener('click', () => this.submitRejectNoCoverage());
      const syncRejectConfirm = () => {
        const confirmBtn = document.getElementById('qRejectConfirmBtn');
        if (!confirmBtn || this.rejectState.busy) return;
        const needsType = this.rejectState.reason === 'incorrect_structure_type';
        confirmBtn.disabled = !this.rejectState.reason || (needsType && !this.rejectState.correctType);
      };
      overlay.querySelectorAll('.qrej-reason-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.rejectState.reason = btn.dataset.reason || null;
          if (this.rejectState.reason !== 'incorrect_structure_type') this.rejectState.correctType = null;
          overlay.querySelectorAll('.qrej-reason-btn').forEach((item) => item.classList.remove('active'));
          btn.classList.add('active');
          const typeBox = document.getElementById('qRejectStructureType');
          if (typeBox) typeBox.classList.toggle('active', this.rejectState.reason === 'incorrect_structure_type');
          overlay.querySelectorAll('.qrej-type-btn').forEach((item) => item.classList.remove('active'));
          syncRejectConfirm();
        });
      });
      overlay.querySelectorAll('.qrej-type-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.rejectState.correctType = btn.dataset.correctType || null;
          overlay.querySelectorAll('.qrej-type-btn').forEach((item) => item.classList.remove('active'));
          btn.classList.add('active');
          syncRejectConfirm();
        });
      });
    },
    openRejectModal(folder, address){
      if (!cfg().flags.is_queue_admin && !cfg().flags.is_manager_role) return;
      this.rejectState = { folder, address, reason:null, correctType:null, busy:false };
      const ov = document.getElementById('qRejectOverlay');
      const addrEl = document.getElementById('qRejectAddr');
      const discEl = document.getElementById('qRejectDisc');
      const noteEl = document.getElementById('qRejectNote');
      const btn = document.getElementById('qRejectConfirmBtn');
      if (addrEl) addrEl.textContent = address || folder || '—';
      if (discEl) discEl.textContent = COVERAGE_REJECTION_DISCLAIMER;
      if (noteEl) noteEl.value = '';
      if (ov) ov.querySelectorAll('.qrej-reason-btn').forEach((item) => item.classList.remove('active'));
      if (ov) ov.querySelectorAll('.qrej-type-btn').forEach((item) => item.classList.remove('active'));
      const typeBox = document.getElementById('qRejectStructureType');
      if (typeBox) typeBox.classList.remove('active');
      if (btn) btn.disabled = true;
      if (ov) ov.style.display = 'flex';
    },
    closeRejectModal(){
      const ov = document.getElementById('qRejectOverlay');
      if (ov) ov.style.display = 'none';
      this.rejectState = { folder:null, address:null, reason:null, correctType:null, busy:false };
    },
    ensureReopenProjectUI(){
      if (!cfg().user?.is_admin) return;
      if (document.getElementById('qReopenProjectOverlay')) return;
      const style = document.createElement('style');
      style.id = 'qReopenProjectStyle';
      style.textContent = `
        .qreopen-overlay{
          position:fixed; inset:0; background:rgba(0,0,0,0.6);
          display:none; align-items:center; justify-content:center;
          z-index:99999; backdrop-filter: blur(3px);
        }
        .qreopen-card{
          width: 640px; max-width: 94vw;
          background:#fff; border-radius:14px;
          box-shadow:0 24px 70px rgba(0,0,0,0.45);
          overflow:hidden;
        }
        .qreopen-head{
          padding:16px 18px; border-bottom:1px solid #eee;
          display:flex; align-items:center; justify-content:space-between; gap:12px;
        }
        .qreopen-title{ font-weight:950; font-size:14px; color:#111; display:flex; align-items:center; gap:10px; }
        .qreopen-x{
          width:36px; height:36px; border-radius:10px;
          border:1px solid #eee; background:#fff; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        }
        .qreopen-body{ padding:16px 18px; }
        .qreopen-addr{
          font-weight:950; color:#111; font-size:13px; line-height:1.3;
          margin-bottom:12px;
        }
        .qreopen-disc{
          border:1px solid #ffcc80; background:#fff8e1;
          border-radius:12px; padding:12px;
          color:#7a4b00; font-weight:800; font-size:12px; line-height:1.45;
        }
        .qreopen-note{ margin-top:12px; }
        .qreopen-note label{
          display:block; font-size:11px; font-weight:900; color:#777;
          text-transform:uppercase; letter-spacing:.4px;
          margin-bottom:6px;
        }
        .qreopen-note textarea{
          width:100%; min-height:120px;
          border-radius:10px; border:1px solid #ddd;
          padding:10px; font-size:13px; box-sizing:border-box;
          resize:vertical;
        }
        .qreopen-note textarea:focus{
          outline:none; border-color:#e37400;
          box-shadow:0 0 0 3px rgba(227,116,0,.12);
        }
        .qreopen-status{
          min-height:16px; margin-top:8px;
          font-size:11px; font-weight:800; color:#b0261e;
        }
        .qreopen-upload-row{
          margin-top:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
        }
        .qreopen-upload-btn{
          border:1px solid #dadce0; background:#fff; color:#333;
          border-radius:10px; padding:9px 12px; font-weight:900;
          display:inline-flex; align-items:center; gap:8px; cursor:pointer;
          font-size:12px;
        }
        .qreopen-upload-btn:hover{ border-color:#e37400; color:#e37400; background:#fff8e1; }
        .qreopen-upload-hint{ font-size:11px; color:#777; font-weight:800; }
        .qreopen-preview{
          margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;
        }
        .qreopen-preview-item{
          position:relative; width:82px; height:82px; border-radius:10px;
          overflow:hidden; border:1px solid #ddd; background:#f8f9fa;
        }
        .qreopen-preview-item img{ width:100%; height:100%; object-fit:cover; display:block; }
        .qreopen-preview-remove{
          position:absolute; top:4px; right:4px; width:22px; height:22px;
          border-radius:999px; background:rgba(0,0,0,.72); color:#fff;
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; font-size:11px;
        }
        .qreopen-foot{
          padding:14px 18px; border-top:1px solid #eee;
          background:#fafafa;
          display:flex; justify-content:flex-end; gap:10px;
        }
        .qreopen-btn{
          border-radius:10px; padding:10px 14px;
          font-weight:900; cursor:pointer;
          border:1px solid #ddd; background:#fff; color:#333;
          display:inline-flex; align-items:center; gap:8px;
        }
        .qreopen-btn.primary{
          border-color:#e37400; background:#e37400; color:#fff;
        }
        .qreopen-btn.primary:disabled{
          background:#f1f3f4; border-color:#dadce0; color:#9aa0a6; cursor:not-allowed;
        }
      `;
      document.head.appendChild(style);
      const overlay = document.createElement('div');
      overlay.id = 'qReopenProjectOverlay';
      overlay.className = 'qreopen-overlay';
      overlay.innerHTML = `
        <div class="qreopen-card" role="dialog" aria-modal="true">
          <div class="qreopen-head">
            <div class="qreopen-title">
              <i class="fas fa-rotate-left" style="color:#e37400;"></i>
              Reopen Completed Project
            </div>
            <button class="qreopen-x" id="qReopenProjectCloseBtn" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="qreopen-body">
            <div class="qreopen-addr" id="qReopenProjectAddr">-</div>
            <div class="qreopen-disc">
              This will put the completed project back into the unassigned production queue, clear its current technician and QA completion state, reset the work timer, and require normal QA/customer delivery after the edits are completed.
            </div>
            <div class="qreopen-note">
              <label>Reason for reopening</label>
              <textarea id="qReopenProjectNotes" placeholder="Explain what needs to be corrected and why this completed project is being reopened..." maxlength="4000"></textarea>
              <div class="qreopen-upload-row">
                <label class="qreopen-upload-btn">
                  <i class="fas fa-image"></i> Add Images
                  <input type="file" id="qReopenProjectImages" accept="image/*" multiple style="display:none;">
                </label>
                <div class="qreopen-upload-hint">Optional, visible to the next technician.</div>
              </div>
              <div class="qreopen-preview" id="qReopenProjectPreview"></div>
              <div class="qreopen-status" id="qReopenProjectStatus"></div>
            </div>
          </div>
          <div class="qreopen-foot">
            <button class="qreopen-btn" id="qReopenProjectCancelBtn"><i class="fas fa-ban"></i> Cancel</button>
            <button class="qreopen-btn primary" id="qReopenProjectConfirmBtn" disabled><i class="fas fa-rotate-left"></i> Reopen for Edits</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => this.closeReopenProjectModal();
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      document.getElementById('qReopenProjectCloseBtn')?.addEventListener('click', close);
      document.getElementById('qReopenProjectCancelBtn')?.addEventListener('click', close);
      document.getElementById('qReopenProjectConfirmBtn')?.addEventListener('click', () => this.submitReopenCompletedProject());
      document.getElementById('qReopenProjectNotes')?.addEventListener('input', () => this.updateReopenProjectUI());
      document.getElementById('qReopenProjectImages')?.addEventListener('change', (e) => this.handleReopenProjectImages(e));
    },
    updateReopenProjectUI(){
      const btn = document.getElementById('qReopenProjectConfirmBtn');
      const notesEl = document.getElementById('qReopenProjectNotes');
      const statusEl = document.getElementById('qReopenProjectStatus');
      const notes = String(notesEl?.value || '').trim();
      if (statusEl && !this.reopenProjectState.busy) statusEl.textContent = notes ? '' : 'Notes are required before reopening.';
      if (!btn) return;
      if (this.reopenProjectState.busy) {
        btn.disabled = true;
        return;
      }
      btn.disabled = notes.length === 0;
      btn.innerHTML = `<i class="fas fa-rotate-left"></i> Reopen for Edits`;
    },
    handleReopenProjectImages(e){
      const input = e?.target;
      const files = Array.from(input?.files || []).filter(file => file && String(file.type || '').startsWith('image/'));
      if (!Array.isArray(this.reopenProjectState.images)) this.reopenProjectState.images = [];
      const remainingSlots = Math.max(0, 6 - this.reopenProjectState.images.length);
      this.reopenProjectState.images.push(...files.slice(0, remainingSlots));
      if (input) input.value = '';
      this.renderReopenProjectImagePreview();
    },
    renderReopenProjectImagePreview(){
      const preview = document.getElementById('qReopenProjectPreview');
      if (!preview) return;
      const files = Array.isArray(this.reopenProjectState.images) ? this.reopenProjectState.images : [];
      preview.innerHTML = '';
      files.forEach((file, idx) => {
        const item = document.createElement('div');
        item.className = 'qreopen-preview-item';
        item.innerHTML = `<div class="qreopen-preview-remove" title="Remove image"><i class="fas fa-times"></i></div>`;
        const img = document.createElement('img');
        item.insertBefore(img, item.firstChild);
        const reader = new FileReader();
        reader.onload = (event) => { img.src = event.target?.result || ''; };
        reader.readAsDataURL(file);
        item.querySelector('.qreopen-preview-remove')?.addEventListener('click', () => {
          this.reopenProjectState.images.splice(idx, 1);
          this.renderReopenProjectImagePreview();
        });
        preview.appendChild(item);
      });
    },
    async uploadReopenProjectImages(folderId){
      const files = Array.isArray(this.reopenProjectState.images) ? this.reopenProjectState.images : [];
      const uploaded = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const originalName = String(file?.name || '').trim();
        const ext = (originalName.split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
        const safeName = `resubmission_${Date.now()}_${i}.${ext}`;
        const data = await this.fmUploadArtifact(folderId, file, safeName);
        const savedName = data?.artifact?.name || data?.name || safeName;
        uploaded.push({
          name: savedName,
          url: this.fmUrl(`projects/${encodeURIComponent(folderId)}/artifacts/${encodeURIComponent(savedName)}`),
          original_name: originalName || savedName,
          content_type: file?.type || 'image/*',
          uploaded_at: new Date().toISOString()
        });
      }
      return uploaded;
    },
    openReopenProjectModal(folder, address){
      if (!cfg().user?.is_admin) return;
      this.ensureReopenProjectUI();
      this.reopenProjectState = { folder, address, busy:false, images:[] };
      const ov = document.getElementById('qReopenProjectOverlay');
      const addrEl = document.getElementById('qReopenProjectAddr');
      const notesEl = document.getElementById('qReopenProjectNotes');
      const statusEl = document.getElementById('qReopenProjectStatus');
      const imageInput = document.getElementById('qReopenProjectImages');
      if (addrEl) addrEl.textContent = address || folder || '-';
      if (notesEl) notesEl.value = '';
      if (imageInput) imageInput.value = '';
      if (statusEl) statusEl.textContent = 'Notes are required before reopening.';
      this.renderReopenProjectImagePreview();
      this.updateReopenProjectUI();
      if (ov) ov.style.display = 'flex';
      setTimeout(() => { try { notesEl?.focus(); } catch {} }, 0);
    },
    closeReopenProjectModal(){
      const ov = document.getElementById('qReopenProjectOverlay');
      if (ov) ov.style.display = 'none';
      this.reopenProjectState = { folder:null, address:null, busy:false, images:[] };
    },
    async submitReopenCompletedProject(){
      if (!cfg().user?.is_admin) return;
      if (!this.reopenProjectState.folder || this.reopenProjectState.busy) return;
      const notesEl = document.getElementById('qReopenProjectNotes');
      const statusEl = document.getElementById('qReopenProjectStatus');
      const btn = document.getElementById('qReopenProjectConfirmBtn');
      const notes = String(notesEl?.value || '').trim();
      if (!notes) {
        if (statusEl) statusEl.textContent = 'Notes are required before reopening.';
        this.updateReopenProjectUI();
        return;
      }
      this.reopenProjectState.busy = true;
      if (statusEl) statusEl.textContent = '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Reopening...`;
      }
      try {
        const folderId = this.reopenProjectState.folder;
        if (statusEl && this.reopenProjectState.images?.length) statusEl.textContent = 'Uploading images...';
        const uploadedImages = await this.uploadReopenProjectImages(folderId);
        if (statusEl) statusEl.textContent = 'Reopening project...';
        const res = await Portal.apiPost(cfg().endpoints.portal || 'index.php', {
          action: 'reopen_completed_project',
          folder: folderId,
          notes,
          images_json: JSON.stringify(uploadedImages)
        });
        if (!res || !res.success) {
          if (statusEl) statusEl.textContent = res?.error || 'Failed to reopen project.';
          return;
        }
        this.closeReopenProjectModal();
        this.mineCache = { at: 0, projects: null };
        this.activeMineCache = { at: 0, projects: null };
        try { queueOverviewStore.invalidate(); } catch {}
        try { await this.refreshQueueAdmin(true); } catch {}
        try { await this.refreshQueueButton(true); } catch {}
        try { await this.fetchProjects(); } catch {}
        this.openProjectModal(folderId).catch(() => {});
      } catch (err) {
        if (statusEl) statusEl.textContent = err?.message || 'Failed to reopen project (network).';
      } finally {
        this.reopenProjectState.busy = false;
        this.updateReopenProjectUI();
      }
    },
    ensureCancelProjectConfirmUI(){
      if (document.getElementById('qCancelProjectOverlay')) return;
      const style = document.createElement('style');
      style.id = 'qCancelProjectStyle';
      style.textContent = `
        .qcancel-overlay{
          position:fixed; inset:0; background:rgba(0,0,0,0.6);
          display:none; align-items:center; justify-content:center;
          z-index:99999; backdrop-filter: blur(3px);
        }
        .qcancel-card{
          width: 640px; max-width: 94vw;
          background:#fff; border-radius:14px;
          box-shadow:0 24px 70px rgba(0,0,0,0.45);
          overflow:hidden;
        }
        .qcancel-head{
          padding:16px 18px; border-bottom:1px solid #eee;
          display:flex; align-items:center; justify-content:space-between; gap:12px;
        }
        .qcancel-title{ font-weight:950; font-size:14px; color:#111; display:flex; align-items:center; gap:10px; }
        .qcancel-x{
          width:36px; height:36px; border-radius:10px;
          border:1px solid #eee; background:#fff; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        }
        .qcancel-body{ padding:16px 18px; }
        .qcancel-addr{
          font-weight:950; color:#111; font-size:13px; line-height:1.3;
          margin-bottom: 12px;
        }
        .qcancel-warn{
          border:1px solid #f4b4ae; background:#fce8e6;
          border-radius:12px; padding:12px 12px;
          color:#7a1b18; font-weight:800; font-size:12px; line-height:1.45;
        }
        .qcancel-choices{
          display:grid; grid-template-columns:1fr 1fr; gap:10px;
          margin-top:12px;
        }
        .qcancel-choice{
          border:1px solid #dadce0; border-radius:12px; background:#fff;
          padding:12px; display:flex; gap:10px; align-items:flex-start;
          cursor:pointer;
        }
        .qcancel-choice input{ margin-top:2px; }
        .qcancel-choice strong{
          display:block; font-size:12px; color:#111; margin-bottom:4px;
        }
        .qcancel-choice span{
          display:block; font-size:11px; line-height:1.45; color:#5f6368;
          font-weight:700;
        }
        .qcancel-choice.refund{ border-color:#c8e6c9; background:#f1f8f4; }
        .qcancel-choice.no-refund{ border-color:#f4b4ae; background:#fff7f7; }
        .qcancel-choice.active{
          box-shadow:0 0 0 2px rgba(26,115,232,0.14) inset;
          border-color:#1a73e8;
        }
        .qcancel-choice.active strong,
        .qcancel-choice.active span{ color:#174ea6; }
        .qcancel-foot{
          padding:14px 18px; border-top:1px solid #eee;
          background:#fafafa;
          display:flex; justify-content:flex-end; gap:10px;
        }
        .qcancel-btn{
          border-radius:10px; padding:10px 14px;
          font-weight:900; cursor:pointer;
          border:1px solid #ddd; background:#fff; color:#333;
          display:inline-flex; align-items:center; gap:8px;
        }
        .qcancel-btn.danger{
          border-color:#d93025; background:#d93025; color:#fff;
        }
        .qcancel-btn.danger:disabled{
          background:#f1f3f4; border-color:#dadce0; color:#9aa0a6; cursor:not-allowed;
        }
      `;
      document.head.appendChild(style);
      const overlay = document.createElement('div');
      overlay.id = 'qCancelProjectOverlay';
      overlay.className = 'qcancel-overlay';
      overlay.innerHTML = `
        <div class="qcancel-card" role="dialog" aria-modal="true">
          <div class="qcancel-head">
            <div class="qcancel-title">
              <i class="fas fa-triangle-exclamation" style="color:#d93025;"></i>
              Cancel Project
            </div>
            <button class="qcancel-x" id="qCancelProjectCloseBtn" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="qcancel-body">
            <div class="qcancel-addr" id="qCancelProjectAddr">—</div>
            <div class="qcancel-warn">
              This will not automatically refund the customer for the project.<br><br>
              You must manually issue the refund first, and then cancel the project.<br><br>
              By continuing, you are confirming that you understand cancellation does not perform any refund automatically.
            </div>
          </div>
          <div class="qcancel-foot">
            <button class="qcancel-btn" id="qCancelProjectDismissBtn"><i class="fas fa-arrow-left"></i> Go Back</button>
            <button class="qcancel-btn danger" id="qCancelProjectConfirmBtn"><i class="fas fa-ban"></i> I Understand, Cancel Project</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => this.closeCancelProjectModal();
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      document.getElementById('qCancelProjectCloseBtn')?.addEventListener('click', close);
      document.getElementById('qCancelProjectDismissBtn')?.addEventListener('click', close);
      document.getElementById('qCancelProjectConfirmBtn')?.addEventListener('click', () => this.submitCancelProject());
    },
    openCancelProjectModal(folder, address){
      if (!(cfg().perms && cfg().perms.cancel_projects)) return;
      this.ensureCancelProjectConfirmUI();
      this.cancelProjectState = { folder, address, busy:false };
      const ov = document.getElementById('qCancelProjectOverlay');
      const addrEl = document.getElementById('qCancelProjectAddr');
      const btn = document.getElementById('qCancelProjectConfirmBtn');
      if (addrEl) addrEl.textContent = address || folder || '—';
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-ban"></i> I Understand, Cancel Project`;
      }
      if (ov) ov.style.display = 'flex';
    },
    closeCancelProjectModal(){
      const ov = document.getElementById('qCancelProjectOverlay');
      if (ov) ov.style.display = 'none';
      this.cancelProjectState = { folder:null, address:null, busy:false };
    },
    async submitCancelProject(){
      if (!(cfg().perms && cfg().perms.cancel_projects)) return;
      if (!this.cancelProjectState.folder || this.cancelProjectState.busy) return;
      const btn = document.getElementById('qCancelProjectConfirmBtn');
      this.cancelProjectState.busy = true;
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Cancelling…`;
      }
      try {
        const res = await Portal.apiPost(cfg().endpoints.portal, { action: 'cancel_project', folder: this.cancelProjectState.folder });
        if (!res || !res.success) {
          alert(res?.error || 'Cancel failed.');
          return;
        }
        const reopenId = this.cancelProjectState.folder;
        this.closeCancelProjectModal();
        try { await this.refreshQueueAdmin(true); } catch {}
        try { await this.refreshQueueButton(true); } catch {}
        try { await this.fetchProjects(); } catch {}
        this.openProjectModal(reopenId).catch(() => {});
      } catch (err) {
        alert(err?.message || 'Cancel failed (network).');
      } finally {
        this.cancelProjectState.busy = false;
        const btnNow = document.getElementById('qCancelProjectConfirmBtn');
        if (btnNow) {
          btnNow.disabled = false;
          btnNow.innerHTML = `<i class="fas fa-ban"></i> I Understand, Cancel Project`;
        }
      }
    },
    ensureCancelProjectConfirmUI(){
      if (document.getElementById('qCancelProjectOverlay')) return;
      const style = document.createElement('style');
      style.id = 'qCancelProjectStyle';
      style.textContent = `
        .qcancel-overlay{
          position:fixed; inset:0; background:rgba(0,0,0,0.6);
          display:none; align-items:center; justify-content:center;
          z-index:99999; backdrop-filter: blur(3px);
        }
        .qcancel-card{
          width: 640px; max-width: 94vw;
          background:#fff; border-radius:14px;
          box-shadow:0 24px 70px rgba(0,0,0,0.45);
          overflow:hidden;
        }
        .qcancel-head{
          padding:16px 18px; border-bottom:1px solid #eee;
          display:flex; align-items:center; justify-content:space-between; gap:12px;
        }
        .qcancel-title{ font-weight:950; font-size:14px; color:#111; display:flex; align-items:center; gap:10px; }
        .qcancel-x{
          width:36px; height:36px; border-radius:10px;
          border:1px solid #eee; background:#fff; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        }
        .qcancel-body{ padding:16px 18px; }
        .qcancel-addr{
          font-weight:950; color:#111; font-size:13px; line-height:1.3;
          margin-bottom: 12px;
        }
        .qcancel-warn{
          border:1px solid #f4b4ae; background:#fce8e6;
          border-radius:12px; padding:12px 12px;
          color:#7a1b18; font-weight:800; font-size:12px; line-height:1.45;
        }
        .qcancel-choices{
          display:grid; grid-template-columns:1fr 1fr; gap:10px;
          margin-top:12px;
        }
        .qcancel-choice{
          border:1px solid #dadce0; border-radius:12px; background:#fff;
          padding:12px; display:flex; gap:10px; align-items:flex-start;
          cursor:pointer;
        }
        .qcancel-choice input{ margin-top:2px; }
        .qcancel-choice strong{
          display:block; font-size:12px; color:#111; margin-bottom:4px;
        }
        .qcancel-choice span{
          display:block; font-size:11px; line-height:1.45; color:#5f6368;
          font-weight:700;
        }
        .qcancel-choice.refund{ border-color:#c8e6c9; background:#f1f8f4; }
        .qcancel-choice.no-refund{ border-color:#f4b4ae; background:#fff7f7; }
        .qcancel-choice.active{
          box-shadow:0 0 0 2px rgba(26,115,232,0.14) inset;
          border-color:#1a73e8;
        }
        .qcancel-choice.active strong,
        .qcancel-choice.active span{ color:#174ea6; }
        .qcancel-foot{
          padding:14px 18px; border-top:1px solid #eee;
          background:#fafafa;
          display:flex; justify-content:flex-end; gap:10px;
        }
        .qcancel-btn{
          border-radius:10px; padding:10px 14px;
          font-weight:900; cursor:pointer;
          border:1px solid #ddd; background:#fff; color:#333;
          display:inline-flex; align-items:center; gap:8px;
        }
        .qcancel-btn.danger{
          border-color:#d93025; background:#d93025; color:#fff;
        }
        .qcancel-btn.danger:disabled{
          background:#f1f3f4; border-color:#dadce0; color:#9aa0a6; cursor:not-allowed;
        }
      `;
      document.head.appendChild(style);
      const overlay = document.createElement('div');
      overlay.id = 'qCancelProjectOverlay';
      overlay.className = 'qcancel-overlay';
      overlay.innerHTML = `
        <div class="qcancel-card" role="dialog" aria-modal="true">
          <div class="qcancel-head">
            <div class="qcancel-title">
              <i class="fas fa-triangle-exclamation" style="color:#d93025;"></i>
              Cancel Project
            </div>
            <button class="qcancel-x" id="qCancelProjectCloseBtn" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="qcancel-body">
            <div class="qcancel-addr" id="qCancelProjectAddr">-</div>
            <div class="qcancel-warn">
              Choose what should happen to the customer's credits when this project is cancelled.<br><br>
              Refunding credits will add a cancellation refund entry to transaction history. Choosing not to refund will still record that the project was cancelled, when it was cancelled, and that no refund was issued during this step.
            </div>
            <div class="qcancel-choices" id="qCancelProjectChoices">
              <label class="qcancel-choice refund" id="qCancelChoiceRefund">
                <input type="radio" name="qCancelRefundMode" value="refund">
                <div>
                  <strong>Refund Credits</strong>
                  <span>Give the charged credits back now and record a cancellation refund in transaction history.</span>
                </div>
              </label>
              <label class="qcancel-choice no-refund" id="qCancelChoiceNoRefund">
                <input type="radio" name="qCancelRefundMode" value="no_refund">
                <div>
                  <strong>Do Not Refund Credits</strong>
                  <span>Cancel the project only. No new transaction will be added, and the project will record that no refund was issued here.</span>
                </div>
              </label>
            </div>
          </div>
          <div class="qcancel-foot">
            <button class="qcancel-btn" id="qCancelProjectDismissBtn"><i class="fas fa-arrow-left"></i> Go Back</button>
            <button class="qcancel-btn danger" id="qCancelProjectConfirmBtn" disabled><i class="fas fa-ban"></i> Choose Refund Option</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => this.closeCancelProjectModal();
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      document.getElementById('qCancelProjectCloseBtn')?.addEventListener('click', close);
      document.getElementById('qCancelProjectDismissBtn')?.addEventListener('click', close);
      document.getElementById('qCancelProjectConfirmBtn')?.addEventListener('click', () => this.submitCancelProject());
      document.querySelectorAll('input[name="qCancelRefundMode"]').forEach((input) => {
        input.addEventListener('change', () => {
          if (input.checked) this.cancelProjectState.refundMode = input.value;
          this.updateCancelProjectConfirmUI();
        });
      });
    },
    updateCancelProjectConfirmUI(){
      const selected = this.cancelProjectState.refundMode;
      const btn = document.getElementById('qCancelProjectConfirmBtn');
      const refundChoice = document.getElementById('qCancelChoiceRefund');
      const noRefundChoice = document.getElementById('qCancelChoiceNoRefund');
      if (refundChoice) refundChoice.classList.toggle('active', selected === 'refund');
      if (noRefundChoice) noRefundChoice.classList.toggle('active', selected === 'no_refund');
      if (!btn) return;
      if (this.cancelProjectState.busy) {
        btn.disabled = true;
        return;
      }
      if (selected === 'refund') {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-receipt"></i> Refund & Cancel Project`;
        return;
      }
      if (selected === 'no_refund') {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-ban"></i> Cancel Without Refund`;
        return;
      }
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-ban"></i> Choose Refund Option`;
    },
    openCancelProjectModal(folder, address){
      if (!(cfg().perms && cfg().perms.cancel_projects)) return;
      this.ensureCancelProjectConfirmUI();
      this.cancelProjectState = { folder, address, refundMode:null, busy:false };
      const ov = document.getElementById('qCancelProjectOverlay');
      const addrEl = document.getElementById('qCancelProjectAddr');
      document.querySelectorAll('input[name="qCancelRefundMode"]').forEach((input) => {
        input.checked = false;
      });
      if (addrEl) addrEl.textContent = address || folder || '-';
      this.updateCancelProjectConfirmUI();
      if (ov) ov.style.display = 'flex';
    },
    closeCancelProjectModal(){
      const ov = document.getElementById('qCancelProjectOverlay');
      if (ov) ov.style.display = 'none';
      this.cancelProjectState = { folder:null, address:null, refundMode:null, busy:false };
    },
    async submitCancelProject(){
      if (!(cfg().perms && cfg().perms.cancel_projects)) return;
      if (!this.cancelProjectState.folder || this.cancelProjectState.busy) return;
      if (!['refund', 'no_refund'].includes(this.cancelProjectState.refundMode || '')) {
        alert('Please choose whether to refund credits before cancelling.');
        return;
      }
      const btn = document.getElementById('qCancelProjectConfirmBtn');
      this.cancelProjectState.busy = true;
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving...`;
      }
      try {
        const res = await Portal.apiPost(cfg().endpoints.portal, {
          action: 'cancel_project',
          folder: this.cancelProjectState.folder,
          refund_mode: this.cancelProjectState.refundMode
        });
        if (!res || !res.success) {
          alert(res?.error || 'Cancel failed.');
          return;
        }
        const reopenId = this.cancelProjectState.folder;
        this.closeCancelProjectModal();
        try { await this.refreshQueueAdmin(true); } catch {}
        try { await this.refreshQueueButton(true); } catch {}
        try { await this.fetchProjects(); } catch {}
        this.openProjectModal(reopenId).catch(() => {});
      } catch (err) {
        alert(err?.message || 'Cancel failed (network).');
      } finally {
        this.cancelProjectState.busy = false;
        this.updateCancelProjectConfirmUI();
      }
    },
    async submitRejectNoCoverage(){
      if (!cfg().flags.is_queue_admin && !cfg().flags.is_manager_role) return;
      if (!this.rejectState.folder || this.rejectState.busy) return;
      if (!this.rejectState.reason) {
        alert('Choose a rejection reason first.');
        return;
      }
      if (this.rejectState.reason === 'incorrect_structure_type' && !this.rejectState.correctType) {
        alert('Choose whether this should be reordered as commercial or multi-family.');
        return;
      }
      const btn = document.getElementById('qRejectConfirmBtn');
      const noteEl = document.getElementById('qRejectNote');
      this.rejectState.busy = true;
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Rejecting…`;
      }
      try {
        const note = (noteEl?.value || '').trim();
        const res = await Portal.apiPost(cfg().endpoints.portal || 'index.php', {
          action: 'reject_no_coverage',
          folder: this.rejectState.folder,
          rejection_reason: this.rejectState.reason,
          correct_project_type: this.rejectState.correctType || '',
          note
        });
        if (!res || !res.success) {
          alert((res && res.error) ? res.error : 'Reject failed.');
          return;
        }
        this.closeRejectModal();
        await this.refreshQueueAdmin(true);
        await this.fetchProjects();
      } catch (e) {
        alert('Reject failed (network).');
      } finally {
        this.rejectState.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fas fa-paper-plane"></i> Reject & Email`;
        }
      }
    },
    // -----------------------
    // Queue coverage review UI (NEW)
    // -----------------------
    ensureQueueRequeueUI(){
      if (!cfg().flags.is_queue_admin) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      if (document.getElementById('qRowRequeue')) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const firstSection = panel.querySelector('.queue-section');
      const section = document.createElement('div');
      section.className = 'queue-section queue-section--requeue';
      section.innerHTML = `
        <h3>
          <i class="fas fa-rotate-left" style="color:#e37400;"></i>
          Re-Queue
          <span style="margin-left:auto; font-size:11px; color:#888; font-weight:800;">
            Needs manual routing back into production
          </span>
        </h3>
        <div class="hscroll" id="qRowRequeue"></div>
      `;
      if (firstSection && firstSection.parentNode) firstSection.parentNode.insertBefore(section, firstSection);
      else panel.appendChild(section);
    },
    ensureQueueStructurePinsUI(){
      if (!cfg().flags.is_queue_admin) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      if (document.getElementById('qRowStructurePins')) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const firstSection = panel.querySelector('.queue-section');
      const section = document.createElement('div');
      section.className = 'queue-section queue-section--structure-pins';
      section.innerHTML = `
        <h3>
          <i class="fas fa-location-dot" style="color:#d93025;"></i>
          Needs Structure Pins
          <span style="margin-left:auto; font-size:11px; color:#888; font-weight:800;">
            Place pins before production
          </span>
        </h3>
        <div class="hscroll" id="qRowStructurePins"></div>
      `;
      if (firstSection && firstSection.parentNode) firstSection.parentNode.insertBefore(section, firstSection);
      else panel.appendChild(section);
    },
    ensureQueueReworkRequestsUI(){
      if (!cfg().flags.is_queue_admin) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      if (document.getElementById('qRowReworkRequests')) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const pinsRow = document.getElementById('qRowStructurePins');
      const pinsSection = pinsRow ? pinsRow.closest('.queue-section') : null;
      const firstSection = panel.querySelector('.queue-section');
      const section = document.createElement('div');
      section.className = 'queue-section queue-section--rework-requests';
      section.innerHTML = `
        <h3>
          <i class="fas fa-screwdriver-wrench" style="color:#7b1fa2;"></i>
          Customer Rework Requests
          <span style="margin-left:auto; font-size:11px; color:#888; font-weight:800;">
            Review requested changes before production
          </span>
        </h3>
        <div class="hscroll" id="qRowReworkRequests"></div>
      `;
      if (pinsSection && pinsSection.parentNode) pinsSection.parentNode.insertBefore(section, pinsSection);
      else if (firstSection && firstSection.parentNode) firstSection.parentNode.insertBefore(section, firstSection);
      else panel.appendChild(section);
    },
    ensureQueueWaitingUI(){
      if (!cfg().flags.is_queue_admin) return;
      if (document.getElementById('qRowWaiting')) return;
      const queuedRow = document.getElementById('qRowQueued');
      const queuedSection = queuedRow ? queuedRow.closest('.queue-section') : null;
      const panel = document.querySelector('#view-queue .queue-panel');
      if (!queuedSection && !panel) return;
      const section = document.createElement('div');
      section.className = 'queue-section';
      section.innerHTML = `
        <h3>
          <i class="fas fa-hourglass-start" style="color:#f9ab00;"></i>
          Awaiting Review
        </h3>
        <div class="hscroll" id="qRowWaiting"></div>
      `;
      if (queuedSection && queuedSection.parentNode) queuedSection.parentNode.insertBefore(section, queuedSection);
      else panel.appendChild(section);
    },
    // -----------------------
    // Queue QA split UI (NEW)
    // -----------------------
    ensureQueueQASplitUI(){
      if (!cfg().flags.is_queue_admin) return;
      if (document.getElementById('qRowQAWaiting')) return;
      const view = document.getElementById('view-queue');
      if (!view) return;
      const panel = view.querySelector('.queue-panel');
      if (!panel) return;
      const existingQARow = document.getElementById('qRowQA');
      if (existingQARow) {
        const existingSection = existingQARow.closest('.queue-section');
        if (existingSection) existingSection.style.display = 'none';
      }
      const completedGrid = document.getElementById('qCompletedGrid');
      const completedSection = completedGrid ? completedGrid.closest('.queue-section') : null;
      const waitingSection = document.createElement('div');
      waitingSection.className = 'queue-section';
      waitingSection.innerHTML = `
        <h3>
          <i class="fas fa-clock" style="color:#f9ab00;"></i>
          Waiting for QA
        </h3>
        <div class="hscroll" id="qRowQAWaiting"></div>
      `;
      const inProgressSection = document.createElement('div');
      inProgressSection.className = 'queue-section';
      inProgressSection.innerHTML = `
        <h3>
          <i class="fas fa-user-check" style="color:#1a73e8;"></i>
          QA In Progress
        </h3>
        <div class="hscroll" id="qRowQAInProgress"></div>
      `;
      if (completedSection) {
        completedSection.parentNode.insertBefore(waitingSection, completedSection);
        completedSection.parentNode.insertBefore(inProgressSection, completedSection);
      } else {
        panel.appendChild(waitingSection);
        panel.appendChild(inProgressSection);
      }
      if (!document.getElementById('qTimestampStyle')) {
        const style = document.createElement('style');
        style.id = 'qTimestampStyle';
        style.textContent = `
          .qcard-times{
            margin-top:6px; display:flex; flex-direction:column; gap:3px;
            font-size:10px; font-weight:800; color:#777;
          }
          .qcard-times .qt-row{
            display:flex; align-items:center; gap:6px;
          }
          .qcard-times .qt-label{
            color:#999; text-transform:uppercase; letter-spacing:.3px;
            min-width:70px;
          }
          .qcard-times .qt-value{
            color:#444;
          }
          .qcard-times .qt-age{
            color:#1a73e8; font-weight:900;
          }
          .qcard .qclaimer{
            margin-top:4px; font-size:10px; font-weight:900;
            color:#1a73e8; display:flex; align-items:center; gap:5px;
          }
          .qcard.qcard--reserved-kickback{
            background:linear-gradient(135deg, #fff4ef 0%, #fffaf7 100%);
            border-color:#f2a49c;
            box-shadow:0 12px 24px rgba(217, 48, 37, 0.10);
          }
          .qcard.qcard--age-warning{
            background:#fff3e0;
            border-color:#e37400;
            box-shadow:0 8px 18px rgba(227, 116, 0, 0.16);
          }
          .qcard.qcard--age-critical{
            background:#fce8e6;
            border-color:#d93025;
            box-shadow:0 8px 18px rgba(217, 48, 37, 0.18);
          }
          .qcard.qcard--age-warning .qline2,
          .qcard.qcard--age-warning .qt-age,
          .qcard.qcard--age-warning .qstage-age{ color:#9b6700 !important; }
          .qcard.qcard--age-critical .qline2,
          .qcard.qcard--age-critical .qt-age,
          .qcard.qcard--age-critical .qstage-age{ color:#a50e0e !important; }
          .qcard .qreserved{
            margin-top:6px; font-size:10px; font-weight:900;
            color:#174ea6; display:flex; align-items:center; gap:5px;
          }
          .qcard .qpin-btn{
            border:1px solid #d93025; background:#d93025; color:#fff;
            border-radius:8px; padding:7px 10px; font-size:11px; font-weight:950;
            display:inline-flex; align-items:center; gap:7px; cursor:pointer;
          }
          .qcard .qpin-btn:hover{ background:#b3261e; border-color:#b3261e; }
          .qcard .qpin-btn:disabled{ background:#9aa0a6; border-color:#9aa0a6; cursor:not-allowed; }
          .qcard.qcard--structure-generating{
            opacity:.68;
            background:#f6f7f8 !important;
            border-color:#cfd4dc !important;
            cursor:default;
            position:relative;
          }
          .qcard.qcard--structure-generating:before{
            content:"";
            position:absolute;
            inset:0;
            border-radius:10px;
            background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.58),rgba(255,255,255,0));
            animation:qpin-shimmer 1.2s linear infinite;
            pointer-events:none;
          }
          .qcard.qcard--structure-failed{
            border-color:#d93025 !important;
            background:#fff8f7 !important;
          }
          .qpin-state{
            margin-top:8px;
            padding:8px 10px;
            border-radius:8px;
            font-size:11px;
            font-weight:900;
            display:flex;
            align-items:center;
            gap:8px;
            background:#f1f3f4;
            color:#3c4043;
          }
          .qpin-state.error{ background:#fce8e6; color:#a50e0e; }
          @keyframes qpin-shimmer{0%{transform:translateX(-100%);}100%{transform:translateX(100%);}}
        `;
        document.head.appendChild(style);
      }
    },
    async deriveCoverageCandidates({ data, queued, force=false }){
      const serverList =
        data?.possible_rejections ||
        data?.coverage_review ||
        data?.coverage_candidates ||
        data?.no_heightmap ||
        data?.no_heightmap_candidates;
      if (Array.isArray(serverList)) {
        return {
          candidates: serverList,
          remainingQueued: Array.isArray(queued) ? queued : []
        };
      }
      const HOLD_STATUSES = new Set([
        'needs_coverage_review','coverage_review','coverage_hold',
        'no_heightmap','no_coverage_candidate','coverage_failed'
      ]);
      if (Array.isArray(queued) && queued.some(p => HOLD_STATUSES.has(String(p.status || '').toLowerCase()))) {
        const candidates = [];
        const remainingQueued = [];
        for (const p of queued) {
          const st = String(p.status || '').toLowerCase();
          if (HOLD_STATUSES.has(st)) candidates.push(p);
          else remainingQueued.push(p);
        }
        return { candidates, remainingQueued };
      }
      const now = Date.now();
      const shouldScan = force || (now - (this.coverageState.lastScanAt || 0) > this.coverageState.scanIntervalMs);
      if (!shouldScan) {
        const candidates = [];
        const remainingQueued = [];
        for (const p of (queued || [])) {
          const id = String(p.id || '');
          const cached = this.coverageState.fileCheckCache.get(id);
          if (cached && cached.checkedAt && (now - cached.checkedAt) < 10 * 60 * 1000) {
            if (cached.dsmExists === false) candidates.push(p);
            else remainingQueued.push(p);
          } else {
            remainingQueued.push(p);
          }
        }
        return { candidates, remainingQueued };
      }
      this.coverageState.lastScanAt = now;
      const list = Array.isArray(queued) ? queued.slice() : [];
      const probeTargets = list
        .filter(p => !!(p && p.id))
        .filter(p => !!p.processed_at)
        .filter(p => {
          const st = String(p.status || '').toLowerCase();
          return (st === 'queued' || st === 'ready');
        })
        .slice(0, this.coverageState.maxProbe);
      const poolN = 4;
      let idx = 0;
      const worker = async () => {
        while (idx < probeTargets.length) {
          const i = idx++;
          const p = probeTargets[i];
          const id = String(p.id || '');
          try {
            const dsmExists = await this.staticFileExists(`${cfg().endpoints.firstmeasure}/projects/${encodeURIComponent(id)}/artifacts/dsm.tif`);
            this.coverageState.fileCheckCache.set(id, { ok:true, checkedAt:Date.now(), dsmExists:!!dsmExists, maskExists:null });
          } catch {
            this.coverageState.fileCheckCache.set(id, { ok:false, checkedAt:Date.now(), dsmExists:true, maskExists:null });
          }
        }
      };
      const runners = [];
      for (let i=0;i<poolN;i++) runners.push(worker());
      await Promise.all(runners);
      const candidates = [];
      const remainingQueued = [];
      for (const p of list) {
        const id = String(p.id || '');
        const cached = this.coverageState.fileCheckCache.get(id);
        if (cached && cached.checkedAt && cached.dsmExists === false) candidates.push(p);
        else remainingQueued.push(p);
      }
      return { candidates, remainingQueued };
    },
    async staticFileExists(url){
      try {
        const r = await fetch(url, { method:'HEAD', cache:'no-store' });
        if (r.status === 200 || r.status === 206) return true;
        if (r.status === 404) return false;
      } catch {}
      try {
        const r2 = await fetch(url, { method:'GET', cache:'no-store', headers: { 'Range': 'bytes=0-0' } });
        if (r2.status === 200 || r2.status === 206) return true;
        if (r2.status === 404) return false;
      } catch {}
      return true;
    },
    async pushForwardNoCoverage(folder){
      if (!cfg().flags.is_queue_admin) return;
      const id = String(folder || '').trim();
      if (!id) return;
      const busyKey = id;
      if (this.coverageState.pushBusy.get(busyKey)) return;
      this.coverageState.pushBusy.set(busyKey, true);
      const btn = document.querySelector(`[data-qpush="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Pushing…`; }
      try {
        const res = await this.fmPost(`projects/${encodeURIComponent(id)}/coverage/push-forward`, {});
        if (!res || !res.success) { alert((res && res.error) ? res.error : 'Push forward failed.'); return; }
        const cached = this.coverageState.fileCheckCache.get(id) || {};
        this.coverageState.fileCheckCache.set(id, { ...cached, checkedAt:Date.now(), dsmExists:true, ok:true });
        await this.refreshQueueAdmin(true);
      } catch (e) { alert('Push forward failed (network).'); }
      finally {
        this.coverageState.pushBusy.set(busyKey, false);
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-forward"></i> Push Forward`; }
      }
    },
    async sendRequeueToQueue(folder){
      if (!cfg().flags.is_queue_admin) return;
      const id = String(folder || '').trim();
      if (!id) return;
      const btn = document.querySelector(`[data-requeue-send="${CSS.escape(id)}"]`);
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Sending…`;
      }
      try {
        const res = await this.fmPost(`projects/${encodeURIComponent(id)}/requeue/send-to-queue`, {});
        if (!res || !res.success) {
          alert((res && res.error) ? res.error : 'Failed to send project back to queue.');
          return;
        }
        await this.refreshQueueAdmin(true);
      } catch (e) {
        alert('Failed to send project back to queue.');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fas fa-forward"></i> Send to Queue`;
        }
      }
    },
    renderRequeueRow(items){
      const el = document.getElementById('qRowRequeue');
      if (!el) return;
      el.innerHTML = '';
      const hideFiller = this.getSectionHideFiller('qRowRequeue');
      let list = Array.isArray(items) ? items.slice() : [];
      if (hideFiller) list = list.filter(p => !p?.is_filler);
      if (!list || list.length === 0) { el.innerHTML = `<div class="qempty">Nothing flagged.</div>`; return; }
      const safeT = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T')); return isNaN(t) ? 0 : t; };
      const resolvePriorityLevel = (project) => this.reportExpeditePriorityLevel(project);
      list = list.sort((a,b) => {
        const pa = resolvePriorityLevel(a);
        const pb = resolvePriorityLevel(b);
        if (pa !== pb) return pa - pb;
        const ta = safeT(a.correction_requested_at || a.updated_at || a.uploaded_at || a.created_at);
        const tb = safeT(b.correction_requested_at || b.updated_at || b.uploaded_at || b.created_at);
        return ta - tb;
      });
      const queueNav = { kind: 'requeue', label: this.queueNavKindLabel('requeue'), items: list };
      const now = Date.now();
      list.forEach(p => {
        const id = String(p.id || '');
        const team = p.team_id || 'default';
        const created = this.safeParseTs(p.created_at);
        const requeueAt = this.safeParseTs(p.updated_at) ?? this.safeParseTs(p.uploaded_at) ?? created;
        const ageMs = requeueAt ? (now - requeueAt) : 0;
        const complexityTag = this.complexityBadgeHtml(p.complexity, 'tag');
        const vipTag = p.is_vip ? `<span class="qtag" style="background:#f9ab00; color:#fff; border-color:#e37400; font-size:9px; font-weight:950;">VIP</span>` : '';
        const priorityLevel = resolvePriorityLevel(p);
        const priorityColor = priorityLevel === 1 ? '#d93025' : (priorityLevel === 2 ? '#e37400' : '#5f6368');
        const priorityTag = `<span class="qtag" style="background:${priorityColor}; color:#fff; border-color:${priorityColor}; font-size:9px; font-weight:950;">P${priorityLevel}</span>`;
        const manualPriorityTag = p.qa_priority ? `<span class="qtag" style="background:#d93025; color:#fff; border-color:#d93025; font-size:9px; font-weight:950;">PRIORITY</span>` : '';
        const qPType = (p.project_type || 'residential').toLowerCase();
        const qTypeColors = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#7b1fa2' };
        const qTypeLabels = { residential:'RES', commercial:'COM', multifamily:'MF' };
        const qTypeTag = `<span class="qtag" style="background:${qTypeColors[qPType]||'#1a73e8'}; color:#fff; border-color:${qTypeColors[qPType]||'#1a73e8'}; font-size:9px;">${qTypeLabels[qPType]||qPType.toUpperCase()}</span>`;
        const correctionTarget = this.getCorrectionTargetTechnician(p);
        const target = correctionTarget.name || correctionTarget.email || '';
        const reservedFor = p.reserved_to_name || p.reserved_to_email || '';
        const targetTag = target
          ? `<span class="qtag" style="background:#fff3e0; color:#e37400; border-color:#ffcc80; font-size:9px;">FOR ${Portal.escapeHtml(target)}</span>`
          : '';
        const ageClass = this.queueAgeClass(p, 'requeue', now);
        const div = document.createElement('div');
        div.className = `qcard ${reservedFor ? 'qcard--reserved-kickback' : ''} ${ageClass}`.trim();
        div.innerHTML = `
          <div class="qline1">${Portal.escapeHtml(p.address || '(no address)')}</div>
          <div class="qline2">
            <span><b>Waiting:</b> ${this.fmtAge(ageMs)}</span>
          </div>
          <div class="qmeta">
            ${vipTag}
            ${manualPriorityTag}
            ${priorityTag}
            ${complexityTag}
            ${qTypeTag}
          </div>
          ${reservedFor ? `<div class="qreserved"><i class="fas fa-bookmark"></i> Waiting for ${Portal.escapeHtml(reservedFor)}</div>` : ''}
          <div class="qcard-times">
            <div class="qt-row">
              <span class="qt-label">Submitted</span>
              <span class="qt-value">${this.fmtLocalShort(p.created_at)}</span>
            </div>
            <div class="qt-row">
              <span class="qt-label">Needs action</span>
              <span class="qt-value">${this.fmtLocalShort(p.updated_at || p.uploaded_at || p.created_at)}</span>
            </div>
          </div>
          <div class="qact-row">
            <button class="qbtn primary" data-requeue-send="${Portal.escapeHtml(id)}" title="Put this project back into the active queue">
              <i class="fas fa-forward"></i> Send to Queue
            </button>
          </div>
        `;
        div.onclick = () => this.openProjectModal(p.id, { project: p, queueNav: { ...queueNav, currentId: p.id } });
        const sendBtn = div.querySelector('[data-requeue-send]');
        if (sendBtn) { sendBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.sendRequeueToQueue(id); }); }
        el.appendChild(div);
      });
    },
    // -----------------------
    // Apple key UI (unchanged)
    // -----------------------
    ensureAppleTestUI(){
      const panel = document.querySelector('#view-apple-key .panel-card');
      if (!panel) return;
      if (document.getElementById('btnAppleTest')) return;
      const row = document.createElement('div');
      row.className = 'apple-row';
      row.style.marginTop = '10px';
      row.innerHTML = `
        <button id="btnAppleTest" class="btn-inline" type="button">
          <i class="fas fa-vial"></i> Test Key
        </button>
        <div id="appleTestStatus" style="font-size:12px; color:#666; font-weight:800;">
          Not tested yet.
        </div>
      `;
      const saveRow = panel.querySelector('.apple-row');
      if (saveRow && saveRow.parentNode) saveRow.parentNode.insertBefore(row, saveRow.nextSibling);
      else panel.appendChild(row);
      const btn = document.getElementById('btnAppleTest');
      if (btn) btn.onclick = () => this.testAppleKey();
    },
    async testAppleKey(){
      if (!cfg().flags.is_apple_key_admin) return;
      const btn = document.getElementById('btnAppleTest');
      const st  = document.getElementById('appleTestStatus');
      const setStatus = (html, ok=null) => { if (!st) return; st.innerHTML = html; if (ok === true) st.style.color = '#137333'; else if (ok === false) st.style.color = '#b0261e'; else st.style.color = '#666'; };
      if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Testing…`; }
      setStatus('Refreshing key…');
      try {
        await this.refreshAppleKey(true);
        const key = (this.appleKeyInfo && this.appleKeyInfo.key) ? String(this.appleKeyInfo.key).trim() : '';
        if (!key) { setStatus('No key set on server.', false); return; }
        setStatus('Testing key…');
        const lat = 47.6062; const lon = -122.3321; const zoom = 20; const TILE = 256;
        const latRad = (lat * Math.PI) / 180;
        const n = Math.pow(2, zoom);
        const globalX = ((lon + 180) / 360) * n * TILE;
        const globalY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE;
        const x = Math.floor(globalX / TILE);
        const y = Math.floor(globalY / TILE);
        const tileVersion = Number.isInteger(Number(this.appleKeyInfo?.tile_version))
          ? Number(this.appleKeyInfo.tile_version)
          : 10401;
        const url = `https://sat-cdn.apple-mapkit.com/tile?style=7&size=1&scale=1&z=${zoom}&x=${x}&y=${y}&v=${tileVersion}&accessKey=${key}&_=${Date.now()}`;
        const res = await fetch(url, { method:'GET', cache:'no-store' });
        if (res.status === 401 || res.status === 403) { setStatus(`Denied (HTTP ${res.status}).`, false); return; }
        if (!res.ok) { setStatus(`Test fetch failed (HTTP ${res.status}).`, false); return; }
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const blob = await res.blob();
        const looksLikeImage = ct.includes('image') || (blob.type || '').startsWith('image/');
        const bigEnough = blob.size > 2000;
        if (!looksLikeImage || !bigEnough) { setStatus(`Got a response but it doesn't look like a tile (type=${Portal.escapeHtml(ct || blob.type || 'unknown')}, size=${blob.size}).`, false); return; }
        setStatus(`Key looks valid ✅ (HTTP ${res.status}, ${blob.size} bytes).`, true);
      } catch (e) { setStatus('Test errored (network/browser).', false); }
      finally { if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-vial"></i> Test Key`; } }
    },
    // -----------------------
    // Projects grid
    // -----------------------
    ensurePrioritySectionStyle(){
      if (document.getElementById('projectsPriorityStyle')) return;
      const style = document.createElement('style');
      style.id = 'projectsPriorityStyle';
      style.textContent = `
        .projects-priority-wrap{
          margin: 0 0 18px;
          padding: 18px 18px 16px;
          border-radius: 18px;
          border: 2px solid #f0c36d;
          background:
            linear-gradient(135deg, #fff7e8 0%, #fffdf8 62%, #ffffff 100%);
          box-shadow: 0 14px 34px rgba(196, 138, 32, 0.10);
        }
        .projects-priority-head{
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:14px;
          margin-bottom:14px;
        }
        .projects-priority-title{
          margin:0;
          font-size:24px;
          font-weight:900;
          letter-spacing:-.03em;
          color:#202124;
        }
        .projects-priority-sub{
          margin:0;
          color:#6b5b3d;
          font-size:13px;
          font-weight:700;
          line-height:1.45;
        }
        .projects-priority-count{
          display:inline-flex;
          align-items:center;
          gap:8px;
          padding:8px 12px;
          border-radius:999px;
          background:#fff;
          border:1px solid #efd8a6;
          color:#8a4b00;
          font-size:12px;
          font-weight:900;
          white-space:nowrap;
        }
        .projects-priority-grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));
          gap:12px;
        }
        .projects-priority-card{
          position:relative;
          border-radius:16px;
          border:1px solid #f1dfb8;
          background:#fffdfa;
          padding:14px 14px 13px;
          box-shadow: 0 10px 24px rgba(32, 33, 36, 0.06);
          cursor:pointer;
          transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
        }
        .projects-priority-card:hover{
          transform:translateY(-2px);
          box-shadow: 0 14px 28px rgba(32, 33, 36, 0.12);
          border-color:#dfb866;
        }
        .projects-priority-tags{
          display:flex;
          flex-wrap:wrap;
          gap:6px;
          margin-bottom:10px;
        }
        .projects-priority-tag{
          display:inline-flex;
          align-items:center;
          gap:5px;
          padding:5px 8px;
          border-radius:999px;
          border:1px solid transparent;
          font-size:10px;
          font-weight:900;
          letter-spacing:.05em;
          text-transform:uppercase;
        }
        .projects-priority-tag.attention{
          background:#fff1dc;
          border-color:#ffc978;
          color:#9a5600;
        }
        .projects-priority-tag.kickback{
          background:#fce8e6;
          border-color:#f2a49c;
          color:#b3261e;
        }
        .projects-priority-tag.reserved{
          background:#e8f0fe;
          border-color:#aecbfa;
          color:#174ea6;
        }
        .projects-priority-tag.status{
          background:#eef3fd;
          border-color:#c7dafb;
          color:#174ea6;
        }
        .projects-priority-card.reserved-kickback{
          border-color:#f2a49c;
          background:linear-gradient(135deg, #fff7f2 0%, #fffdfa 100%);
          box-shadow: 0 14px 28px rgba(217, 48, 37, 0.10);
        }
        .projects-priority-address{
          font-size:15px;
          font-weight:900;
          color:#202124;
          line-height:1.35;
          margin-bottom:8px;
        }
        .projects-priority-meta{
          display:grid;
          gap:6px;
          color:#5f6368;
          font-size:12px;
          font-weight:700;
        }
        .projects-priority-empty{
          padding:14px 16px;
          border-radius:14px;
          border:1px dashed #e4d2aa;
          background:rgba(255,255,255,.72);
          color:#6b5b3d;
          font-size:13px;
          font-weight:700;
        }
        .projects-priority-actions{
          margin-top:12px;
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }
        .projects-priority-cta{
          display:inline-flex;
          align-items:center;
          gap:8px;
          padding:10px 14px;
          border:none;
          border-radius:12px;
          background:#db4437;
          color:#fff;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
          box-shadow:0 10px 20px rgba(219,68,55,.24);
          transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
        }
        .projects-priority-cta:hover{
          transform:translateY(-1px);
          box-shadow:0 14px 26px rgba(219,68,55,.28);
          background:#b3261e;
        }
      `;
      document.head.appendChild(style);
    },
    isTechnicianView(){
      const user = cfg().user || {};
      const perms = cfg().perms || {};
      const flags = cfg().flags || {};
      const isManager = !!user.is_admin || user.role === 'admin' || !!flags.is_manager_role || !!perms.manage_queue;
      const isQa = !isManager && (!!flags.is_qa_role || !!perms.manage_qa || !!perms.manage_qa_queue);
      return !isManager && !isQa;
    },
    priorityStatusLabel(status){
      const key = String(status || '').toLowerCase().trim().replace(/\s+/g, '_');
      const labels = {
        queued: 'Queued',
        ready: 'Ready',
        in_progress: 'In Progress',
        processing: 'In Progress',
        correction_needed: 'Correction Needed',
        requeue: 'Re-Queue',
        awaiting_review: 'Awaiting QA',
        rework_requested: 'Rework Requested',
        reworking: 'Reworking',
        customer_rework_requested: 'Rework Requested',
      };
      return labels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Assigned';
    },
    productionPriorityTs(project, keys){
      const item = (project && typeof project === 'object') ? project : {};
      for (const key of (Array.isArray(keys) ? keys : [])) {
        const ts = this.safeParseTs(item[key]);
        if (ts) return ts;
      }
      return 0;
    },
    productionPriorityGroup(project){
      const item = (project && typeof project === 'object') ? project : {};
      if (item.qa_priority) return 0;
      if (item.is_filler) return 5;
      const hasPriorityFlag = !!item.is_vip || !!item.is_expedited;
      const createdTs = this.productionPriorityTs(item, ['created_at','queued_at','uploaded_at','date','updated_at']);
      const olderThanTwoHours = createdTs > 0 ? ((Date.now() - createdTs) >= (2 * 60 * 60 * 1000)) : false;
      if (hasPriorityFlag && olderThanTwoHours) return 1;
      if (!hasPriorityFlag && olderThanTwoHours) return 2;
      if (hasPriorityFlag) return 3;
      return 4;
    },
    compareProductionPriority(a, b){
      const groupA = this.productionPriorityGroup(a);
      const groupB = this.productionPriorityGroup(b);
      if (groupA !== groupB) return groupA - groupB;
      const createdA = this.productionPriorityTs(a, ['created_at','queued_at','uploaded_at','date','updated_at','assigned_at','reserved_at','started_at']);
      const createdB = this.productionPriorityTs(b, ['created_at','queued_at','uploaded_at','date','updated_at','assigned_at','reserved_at','started_at']);
      const sortA = createdA || Number.MAX_SAFE_INTEGER;
      const sortB = createdB || Number.MAX_SAFE_INTEGER;
      if (sortA !== sortB) return sortA - sortB;
      const enteredA = this.productionPriorityTs(a, ['updated_at','uploaded_at','assigned_at','reserved_at','started_at']);
      const enteredB = this.productionPriorityTs(b, ['updated_at','uploaded_at','assigned_at','reserved_at','started_at']);
      const enteredSortA = enteredA || Number.MAX_SAFE_INTEGER;
      const enteredSortB = enteredB || Number.MAX_SAFE_INTEGER;
      if (enteredSortA !== enteredSortB) return enteredSortA - enteredSortB;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    },
    getPriorityProjects(projects){
      const me = String(cfg().user?.email || '').toLowerCase().trim();
      const activeStatuses = new Set(['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue']);
      const list = Array.isArray(projects) ? projects : [];
      return list.filter((project) => {
        if (!project || !project.id) return false;
        const status = String(project.status || '').toLowerCase().trim();
        if (!activeStatuses.has(status)) return false;
        const assigned = String(project.assigned_to_email || '').toLowerCase().trim();
        const correction = String(project.correction_to_email || '').toLowerCase().trim();
        const reserved = String(project.reserved_to_email || '').toLowerCase().trim();
        return assigned === me || correction === me || reserved === me;
      }).sort((a, b) => this.compareProductionPriority(a, b));
    },
    ensureTechnicianDashboardStyle(){
      if (document.getElementById('technicianDashboardStyle')) return;
      const style = document.createElement('style');
      style.id = 'technicianDashboardStyle';
      style.textContent = `
        #view-dashboard{min-height:0;padding-bottom:64px}
        #technicianDashboardActiveMount:not(:empty){margin-bottom:14px}
        #technicianDashboardLeaderboardMount:not(:empty){margin-top:14px}
        .technician-dashboard-loading{
          padding:18px;
          border:1px solid #d4dae6;
          border-radius:8px;
          background:#fff;
          color:#6b7280;
          font-size:13px;
          font-weight:800;
          text-align:center;
        }
        .technician-dashboard-error{
          padding:18px;
          border:1px solid #f1b7b2;
          border-radius:8px;
          background:#fce8e6;
          color:#b3261e;
          font-size:13px;
          font-weight:800;
        }
        .tech-leaderboard{
          border:1px solid #d4dae6;
          border-radius:8px;
          background:#fff;
          overflow:hidden;
        }
        body.tech-leaderboard-window-open{
          overflow:hidden;
        }
        .tech-leaderboard.window-mode{
          position:fixed;
          inset:0;
          z-index:100000;
          width:100vw;
          height:100vh;
          border:0;
          border-radius:0;
          display:flex;
          flex-direction:column;
          box-shadow:none;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-head{
          padding:18px 24px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-title{
          font-size:18px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-grid{
          flex:1;
          overflow:auto;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-row{
          grid-template-columns:48px minmax(0,1fr) auto;
          gap:12px;
          padding:14px 20px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-rank{
          width:38px;
          height:38px;
          font-size:16px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-name{
          font-size:18px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-meta{
          font-size:13px;
        }
        .tech-leaderboard.window-mode .tech-leaderboard-points{
          font-size:20px;
        }
        .tech-leaderboard-head{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          padding:10px 14px;
          background:#f6f8fb;
          border-bottom:1px solid #edf0f5;
        }
        .tech-leaderboard-title{
          margin:0;
          font-size:12px;
          line-height:1.2;
          font-weight:950;
          letter-spacing:.04em;
          text-transform:uppercase;
          color:#1f2937;
          display:flex;
          align-items:center;
          gap:8px;
        }
        .tech-leaderboard-sub{
          color:#6b7280;
          font-size:11px;
          font-weight:800;
          white-space:nowrap;
        }
        .tech-leaderboard-head-actions{
          display:flex;
          align-items:center;
          gap:10px;
          flex:0 0 auto;
        }
        .tech-leaderboard-range{
          display:inline-flex;
          overflow:hidden;
          border:1px solid #d4dae6;
          border-radius:8px;
          background:#fff;
        }
        .tech-leaderboard-range button{
          border:0;
          border-left:1px solid #edf0f5;
          background:#fff;
          color:#4b5563;
          cursor:pointer;
          font-size:11px;
          font-weight:950;
          padding:8px 10px;
        }
        .tech-leaderboard-range button:first-child{border-left:0}
        .tech-leaderboard-range button.active{
          background:#1f2937;
          color:#fff;
        }
        .tech-leaderboard-fullscreen{
          width:32px;
          height:32px;
          border:1px solid #d4dae6;
          border-radius:8px;
          background:#fff;
          color:#1f2937;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
          font-size:13px;
        }
        .tech-leaderboard-fullscreen:hover{
          background:#eef2f7;
          border-color:#cbd5e1;
        }
        .tech-leaderboard-grid{
          display:grid;
          gap:0;
        }
        .tech-leaderboard-col{
          min-width:0;
          border-left:1px solid #edf0f5;
        }
        .tech-leaderboard-col:first-child{border-left:0}
        .tech-leaderboard-row{
          min-width:0;
          display:grid;
          grid-template-columns:34px minmax(0,1fr) auto;
          align-items:center;
          gap:8px;
          padding:8px 12px;
          border-bottom:1px solid #edf0f5;
          background:#fff;
        }
        .tech-leaderboard-col .tech-leaderboard-row:last-child{border-bottom:0}
        .tech-leaderboard-row.rank-1{
          background:#fffbeb;
          box-shadow:inset 3px 0 0 #d97706;
        }
        .tech-leaderboard-row.rank-2{box-shadow:inset 3px 0 0 #94a3b8}
        .tech-leaderboard-row.rank-3{box-shadow:inset 3px 0 0 #b45309}
        .tech-leaderboard-rank{
          width:26px;
          height:26px;
          border-radius:999px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          background:#eef2f7;
          color:#1f2937;
          font-size:12px;
          font-weight:950;
          flex:0 0 auto;
        }
        .tech-leaderboard-row.rank-1 .tech-leaderboard-rank{background:#f59e0b;color:#fff}
        .tech-leaderboard-row.rank-2 .tech-leaderboard-rank{background:#94a3b8;color:#fff}
        .tech-leaderboard-row.rank-3 .tech-leaderboard-rank{background:#b45309;color:#fff}
        .tech-leaderboard-row.me{
          position:relative;
          background:#fff7ed;
          outline:2px solid #f59e0b;
          outline-offset:-2px;
          box-shadow:inset 5px 0 0 #f59e0b, 0 1px 0 rgba(245,158,11,.18);
        }
        .tech-leaderboard-row.me .tech-leaderboard-rank{
          background:#d97706;
          color:#fff;
        }
        .tech-leaderboard-person{min-width:0}
        .tech-leaderboard-name{
          font-size:12px;
          font-weight:950;
          color:#111827;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .tech-leaderboard-meta{
          margin-top:1px;
          color:#6b7280;
          font-size:10px;
          font-weight:800;
        }
        .tech-leaderboard-points{
          font-size:13px;
          font-weight:950;
          color:#111827;
          white-space:nowrap;
        }
        .tech-leaderboard-score{
          text-align:right;
          white-space:nowrap;
        }
        .tech-leaderboard-score .count{
          color:#0b8043;
          font-size:11px;
          font-weight:950;
        }
        .tech-leaderboard-score .points{
          color:#111827;
          font-size:13px;
          font-weight:950;
          margin-top:1px;
        }
        .tech-leaderboard-you{
          display:inline-flex;
          margin-left:6px;
          padding:2px 6px;
          border-radius:999px;
          background:#d97706;
          color:#fff;
          font-size:10px;
          font-weight:950;
          vertical-align:2px;
          text-transform:uppercase;
          letter-spacing:.03em;
        }
        .tech-leaderboard-empty{
          padding:16px;
          color:#6b7280;
          font-size:12px;
          font-weight:800;
          text-align:center;
        }
        @media (max-width: 960px){
          .tech-leaderboard-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
        }
        @media (max-width: 640px){
          .tech-leaderboard-head{align-items:flex-start;flex-direction:column}
          .tech-leaderboard-sub{white-space:normal}
          .tech-leaderboard-grid{grid-template-columns:1fr}
          .tech-leaderboard-col{border-left:0;border-top:1px solid #edf0f5}
          .tech-leaderboard-col:first-child{border-top:0}
        }
      `;
      document.head.appendChild(style);
    },
    async refreshTechnicianDashboard(force=false){
      if (!this.canViewTechnicianDashboard()) return;
      const mount = document.getElementById('technicianDashboardActiveMount');
      this.ensureTechnicianDashboardStyle();
      const visible = document.getElementById('view-dashboard')?.style.display !== 'none';
      if (mount && this.isDraftingTechnician() && visible) {
        mount.innerHTML = '<div class="technician-dashboard-loading"><i class="fas fa-circle-notch fa-spin"></i> Loading active work...</div>';
      }
      try {
        if (mount && this.isDraftingTechnician()) {
          const projects = await this.getAssignedActiveProjectsFresh(!!force);
          const me = String(cfg().user?.email || '').trim();
          this.myProjectList = this.toProjectBrowserRows(projects).map((project) => {
            const hasOwner = !!String(project.assigned_to_email || project.correction_to_email || project.reserved_to_email || '').trim();
            return (!hasOwner && me) ? { ...project, assigned_to_email: me } : project;
          });
          this.renderPrioritySection(this.myProjectList, {
            mountId: 'technicianDashboardActiveMount',
            nextButtonId: 'technicianDashboardNextBtn',
            title: 'Your Active Work',
            kicker: 'Dashboard',
            emptyCopy: 'No active or QA-kickback projects are assigned to you right now.',
            actionLabel: 'Get Next in Queue'
          });
        }
        await this.refreshTechnicianLeaderboard(!!force);
        const refreshBtn = document.getElementById('technicianDashboardRefreshBtn');
        if (refreshBtn && !refreshBtn.dataset.bound) {
          refreshBtn.dataset.bound = '1';
          refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Refreshing';
            try {
              this.activeMineCache = { at: 0, projects: null };
              await this.refreshTechnicianDashboard(true);
              if (window.Shifts && typeof Shifts.refreshActiveData === 'function') {
                await Shifts.refreshActiveData(true);
              }
              await this.refreshQueueButton(true);
            } finally {
              refreshBtn.disabled = false;
              refreshBtn.innerHTML = '<i class="fas fa-sync"></i> Refresh';
            }
          });
        }
      } catch (err) {
        if (mount && this.isDraftingTechnician()) {
          mount.innerHTML = `<div class="technician-dashboard-error">Unable to load active work right now.</div>`;
        }
        const lbMount = document.getElementById('technicianDashboardLeaderboardMount');
        if (lbMount) lbMount.innerHTML = `<div class="technician-dashboard-error">Unable to load the technician leaderboard right now.</div>`;
      }
    },
    getPacificDayUtcBounds(date){
      const bounds = managementDayBounds(date);
      return { start: bounds.start, end: new Date(bounds.endExclusive.getTime() - 1), date: bounds.date };
    },
    async getDashboardRosterEmails(){
      const team = String(this.dashboardTeam || 'all').trim() || 'all';
      if (team === 'all') return null;
      const base = String(cfg()?.endpoints?.internal || '').replace(/\/+$/, '');
      if (!base) throw new Error('Internal roster endpoint is unavailable');
      const response = await fetch(`${base}/users?team_id=${encodeURIComponent(team)}`, {
        credentials:'include', cache:'no-store', headers:{ Accept:'application/json' }
      });
      if (!response.ok) throw new Error(`Team roster request failed (${response.status})`);
      const data = await response.json();
      return new Set((Array.isArray(data?.users) ? data.users : [])
        .map(user => String(user?.email || '').toLowerCase().trim())
        .filter(Boolean));
    },
    async buildTechnicianLeaderboardFromCompletedProjects(date){
      const bounds = this.getPacificDayUtcBounds(date);
      const now = Date.now();
      const startMs = bounds.start.getTime();
      const endMs = Math.min(bounds.end.getTime(), now);
      const [data, rosterEmails] = await Promise.all([this.fmPost('projects/query', {
        activity_start: bounds.start.toISOString(),
        activity_end: new Date(endMs).toISOString(),
        activity_fields: ['uploaded', 'completed'],
        include_all: true,
        limit: 500
      }), this.getDashboardRosterEmails()]);
      const rowsByEmail = new Map();
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const qaTodayEmails = new Set();
      if (bounds.date === this.getCurrentPacificWeekDates().slice(-1)[0]) {
        const activeQaEmails = await this.collectActiveQaEmailsForLeaderboard();
        activeQaEmails.forEach(email => qaTodayEmails.add(email));
      }
      for (const project of projects) {
        const m = this.normalizeProjectManifest(project);
        if (!m || m.is_filler || m.is_tutorial_instance) continue;
        const qaEmail = this.getProjectQaActorEmail(m);
        if (!qaEmail) continue;
        const qaTs = this.getProjectQaActivityTs(m);
        if (qaTs && qaTs >= startMs && qaTs <= endMs) qaTodayEmails.add(qaEmail);
      }
      for (const project of projects) {
        const m = this.normalizeProjectManifest(project);
        if (!m) continue;
        if (m.is_filler || m.is_tutorial_instance) continue;
        const completedTs = this.safeParseTs(
          m.uploaded_at || m.timestamps?.uploaded_at || m.completed_at || m.timestamps?.completed_at || ''
        );
        if (!completedTs || completedTs < startMs || completedTs > endMs) continue;

        const tech = this.getLeaderboardTechnician(m);
        const email = String(tech.email || '').toLowerCase().trim();
        if (!email) continue;
        if (rosterEmails && !rosterEmails.has(email)) continue;
        if (qaTodayEmails.has(email)) continue;
        const name = String(tech.name || email).trim();
        const points = this.resolveProjectPoints(m) || 1;
        if (!rowsByEmail.has(email)) {
          rowsByEmail.set(email, {
            email,
            name,
            completed_count: 0,
            points: 0
          });
        }
        const row = rowsByEmail.get(email);
        row.completed_count += 1;
        row.points += points;
        if (!row.name || row.name === row.email) row.name = name || email;
      }

      const list = Array.from(rowsByEmail.values()).sort((a, b) => {
        if (Number(a.points) !== Number(b.points)) return Number(b.points) - Number(a.points);
        if (Number(a.completed_count) !== Number(b.completed_count)) return Number(b.completed_count) - Number(a.completed_count);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      let rank = 0;
      let lastPoints = null;
      let lastCount = null;
      list.forEach((row, idx) => {
        row.points = Math.round(Number(row.points || 0) * 100) / 100;
        row.completed_count = Number(row.completed_count || 0);
        if (lastPoints === null || row.points !== lastPoints || row.completed_count !== lastCount) rank = idx + 1;
        row.rank = rank;
        lastPoints = row.points;
        lastCount = row.completed_count;
      });
      return {
        success: true,
        leaderboard: list,
        team: this.dashboardTeam || 'all',
        date: bounds.date,
        timezone: MANAGEMENT_TIME_ZONE,
        source: 'projects_query_fallback'
      };
    },
    getPacificDateParts(date = new Date()){
      const parts = managementDateTimeParts(date);
      return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day)
      };
    },
    formatDateOnlyFromUtcDate(date){
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    },
    getCurrentPacificWeekDates(){
      const p = this.getPacificDateParts(new Date());
      const todayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day));
      const day = todayUtc.getUTCDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const dates = [];
      for (let offset = mondayOffset; offset <= 0; offset++) {
        const d = new Date(todayUtc.getTime() + offset * 86400000);
        dates.push(this.formatDateOnlyFromUtcDate(d));
      }
      return dates;
    },
    rankTechnicianLeaderboardRows(rows){
      const list = Array.from(rows || []).sort((a, b) => {
        if (Number(a.points) !== Number(b.points)) return Number(b.points) - Number(a.points);
        if (Number(a.completed_count) !== Number(b.completed_count)) return Number(b.completed_count) - Number(a.completed_count);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      let rank = 0;
      let lastPoints = null;
      let lastCount = null;
      list.forEach((row, idx) => {
        row.points = Math.round(Number(row.points || 0) * 100) / 100;
        row.completed_count = Number(row.completed_count || 0);
        if (lastPoints === null || row.points !== lastPoints || row.completed_count !== lastCount) rank = idx + 1;
        row.rank = rank;
        lastPoints = row.points;
        lastCount = row.completed_count;
      });
      return list;
    },
    async fetchTechnicianLeaderboardDay(date, force=false){
      const team = this.dashboardTeam || 'all';
      const key = `${team}|${String(date || '')}`;
      if (!force && this.techLeaderboardDailyCache.has(key)) return this.techLeaderboardDailyCache.get(key);
      let res = null;
      try {
        res = await Portal.apiPost(cfg().endpoints.server, {
          action: 'technician_leaderboard',
          team,
          date: String(date || ''),
          force: force ? 1 : 0
        });
      } catch (e) {
        res = null;
      }
      if (!res || res.success === false || !Array.isArray(res.leaderboard)) {
        res = await this.buildTechnicianLeaderboardFromCompletedProjects(date);
      }
      if (!res || res.success === false) throw new Error(res?.error || 'Leaderboard failed');
      this.techLeaderboardDailyCache.set(key, res);
      return res;
    },
    async fetchTechnicianLeaderboardWeek(force=false){
      const dates = this.getCurrentPacificWeekDates();
      const days = await Promise.all(dates.map((date) => this.fetchTechnicianLeaderboardDay(date, force)));
      const byEmail = new Map();
      days.forEach((day) => {
        (Array.isArray(day?.leaderboard) ? day.leaderboard : []).forEach((row) => {
          const email = String(row.email || '').toLowerCase().trim();
          if (!email) return;
          if (!byEmail.has(email)) {
            byEmail.set(email, {
              email,
              name: String(row.name || email).trim(),
              completed_count: 0,
              points: 0
            });
          }
          const target = byEmail.get(email);
          target.completed_count += Number(row.completed_count || 0);
          target.points += Number(row.points || 0);
          if (!target.name || target.name === target.email) target.name = String(row.name || email).trim();
        });
      });
      return {
        success: true,
        leaderboard: this.rankTechnicianLeaderboardRows(byEmail.values()),
        range: 'week',
        dates,
        timezone: MANAGEMENT_TIME_ZONE,
        cached: days.every((day) => !!day?.cached)
      };
    },
    async refreshTechnicianLeaderboard(force=false){
      const mount = document.getElementById('technicianDashboardLeaderboardMount');
      if (!mount) return;
      this.ensureTechnicianDashboardStyle();
      if (force || !mount.innerHTML.trim()) {
        mount.innerHTML = '<div class="technician-dashboard-loading"><i class="fas fa-circle-notch fa-spin"></i> Loading leaderboard...</div>';
      }
      let res = null;
      if (this.techLeaderboardRange === 'week') {
        res = await this.fetchTechnicianLeaderboardWeek(!!force).catch(() => null);
      } else {
        const today = this.getCurrentPacificWeekDates().slice(-1)[0];
        res = await this.fetchTechnicianLeaderboardDay(today, !!force).catch(() => null);
      }
      if ((!res || res.success === false) && this.techLeaderboardRange === 'day') {
        res = await this.buildTechnicianLeaderboardFromCompletedProjects().catch(() => null);
      }
      if (!res || res.success === false) throw new Error(res?.error || 'Leaderboard failed');
      this.renderTechnicianLeaderboard(Array.isArray(res.leaderboard) ? res.leaderboard : [], res);
    },
    renderTechnicianLeaderboard(rows, meta = {}){
      const mount = document.getElementById('technicianDashboardLeaderboardMount');
      if (!mount) return;
      const me = String(cfg().user?.email || '').toLowerCase().trim();
      const list = (Array.isArray(rows) ? rows : []).map((row, idx) => {
        const email = String(row.email || '').toLowerCase().trim();
        return {
          ...row,
          rank: Number(row.rank || idx + 1),
          points: Number(row.points || 0),
          completed_count: Number(row.completed_count || 0),
          is_me: email && email === me
        };
      });
      const pointLabel = (points) => {
        const rounded = Math.round(Number(points || 0) * 100) / 100;
        return `${rounded.toLocaleString()} pt${Math.abs(rounded - 1) < 0.001 ? '' : 's'}`;
      };
      const renderRow = (row) => {
        const rank = Number(row.rank || 0);
        const topClass = rank <= 3 ? ` rank-${rank}` : '';
        const icon = rank === 1 ? '<i class="fas fa-crown"></i>' : (rank === 2 ? '<i class="fas fa-medal"></i>' : (rank === 3 ? '<i class="fas fa-award"></i>' : String(rank)));
        const name = row.name || row.email || 'Technician';
        return `
          <div class="tech-leaderboard-row${topClass}${row.is_me ? ' me' : ''}">
            <span class="tech-leaderboard-rank">${icon}</span>
            <div class="tech-leaderboard-person">
              <div class="tech-leaderboard-name" title="${Portal.escapeHtml(name)}">${Portal.escapeHtml(name)}${row.is_me ? '<span class="tech-leaderboard-you">You</span>' : ''}</div>
            </div>
            <div class="tech-leaderboard-score">
              <div class="points">${Portal.escapeHtml(pointLabel(row.points))} completed</div>
            </div>
          </div>
        `;
      };
      const columnSize = 10;
      const columns = [];
      for (let i = 0; i < list.length; i += columnSize) {
        columns.push(list.slice(i, i + columnSize));
      }
      const columnCount = Math.max(1, columns.length);
      const rowsHtml = columns.map((column) => `
        <div class="tech-leaderboard-col">
          ${column.map((row) => renderRow(row)).join('')}
        </div>
      `).join('');
      document.body.classList.remove('tech-leaderboard-window-open');
      const isWeek = this.techLeaderboardRange === 'week';
      mount.innerHTML = `
        <section class="tech-leaderboard">
          <div class="tech-leaderboard-head">
            <h2 class="tech-leaderboard-title"><i class="fas fa-trophy" style="color:#d97706;"></i> Technician Leaderboard</h2>
            <div class="tech-leaderboard-head-actions">
              <div class="tech-leaderboard-range" aria-label="Technician leaderboard range">
                <button type="button" class="${!isWeek ? 'active' : ''}" data-tech-leaderboard-range="day">Daily</button>
                <button type="button" class="${isWeek ? 'active' : ''}" data-tech-leaderboard-range="week">Weekly</button>
              </div>
              <button type="button" class="tech-leaderboard-fullscreen" data-tech-leaderboard-fullscreen title="Fill window" aria-label="Fill window">
                <i class="fas fa-expand"></i>
              </button>
            </div>
          </div>
          ${rowsHtml ? `<div class="tech-leaderboard-grid" style="grid-template-columns:repeat(${columnCount},minmax(0,1fr));">${rowsHtml}</div>` : `<div class="tech-leaderboard-empty">No technician points completed ${isWeek ? 'this week' : 'today'} yet.</div>`}
        </section>
      `;
      mount.querySelectorAll('[data-tech-leaderboard-range]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const next = btn.getAttribute('data-tech-leaderboard-range') === 'week' ? 'week' : 'day';
          if (this.techLeaderboardRange === next) return;
          this.techLeaderboardRange = next;
          await this.refreshTechnicianLeaderboard(false);
        });
      });
      const fullBtn = mount.querySelector('[data-tech-leaderboard-fullscreen]');
      if (fullBtn) {
        fullBtn.addEventListener('click', () => this.toggleTechnicianLeaderboardFullscreen());
      }
    },
    async toggleTechnicianLeaderboardFullscreen(){
      const panel = document.querySelector('#technicianDashboardLeaderboardMount .tech-leaderboard');
      if (!panel) return;
      const nextOpen = !panel.classList.contains('window-mode');
      panel.classList.toggle('window-mode', nextOpen);
      document.body.classList.toggle('tech-leaderboard-window-open', nextOpen);
      const btn = panel.querySelector('[data-tech-leaderboard-fullscreen]');
      if (btn) {
        btn.title = nextOpen ? 'Exit window view' : 'Fill window';
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML = `<i class="fas ${nextOpen ? 'fa-compress' : 'fa-expand'}"></i>`;
      }
    },
    renderPrioritySection(projects, options = {}){
      const opts = (options && typeof options === 'object') ? options : {};
      const mount = document.getElementById(opts.mountId || 'projectsPriorityMount');
      if (!mount) return;
      this.ensurePrioritySectionStyle();
      const items = this.getPriorityProjects(projects);
      const title = opts.title || 'Your Active Work';
      const kicker = opts.kicker || 'Personal Queue';
      const emptyCopy = opts.emptyCopy || 'No active or QA-kickback projects are assigned to you right now.';
      const actionLabel = opts.actionLabel || 'Get Next in Queue';
      const nextButtonId = opts.nextButtonId || 'projectsPriorityNextBtn';
      if (!items.length) {
        mount.innerHTML = `
          <div class="projects-priority-wrap">
            <div class="projects-priority-head">
              <div>
                <span class="projects-priority-kicker"><i class="fas fa-user-clock"></i> ${Portal.escapeHtml(kicker)}</span>
                <div class="projects-priority-title">${Portal.escapeHtml(title)}</div>
              </div>
            </div>
            <div class="projects-priority-empty">
              ${Portal.escapeHtml(emptyCopy)}
              ${this.isTechnicianView() && cfg().user?.training_complete ? `
                <div class="projects-priority-actions">
                  <button type="button" class="projects-priority-cta" id="${Portal.escapeHtml(nextButtonId)}">
                    <i class="fas fa-forward"></i> ${Portal.escapeHtml(actionLabel)}
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
        `;
        const nextBtn = document.getElementById(nextButtonId);
        if (nextBtn) nextBtn.addEventListener('click', () => this.handleNextInQueueClick());
        return;
      }
      mount.innerHTML = `
        <div class="projects-priority-wrap">
          <div class="projects-priority-head">
            <div class="projects-priority-title">${Portal.escapeHtml(title)}</div>
            <div class="projects-priority-count"><i class="fas fa-layer-group"></i> ${items.length} active</div>
          </div>
          <div class="projects-priority-grid">
            ${items.map((project) => {
              const status = String(project.status || '').toLowerCase().trim();
              const isKickback = status === 'correction_needed' || status === 'requeue';
              const reservedFor = project.reserved_to_name || project.reserved_to_email || '';
              const isReserved = !!reservedFor;
              const started = this.fmtLocalShort(project.started_at || project.reserved_at || project.assigned_at || project.created_at || '');
              const updated = this.fmtLocalShort(project.updated_at || project.uploaded_at || project.created_at || '');
              return `
                <div class="projects-priority-card ${isKickback && isReserved ? 'reserved-kickback' : ''}" data-priority-open="${Portal.escapeHtml(project.id)}">
                  <div class="projects-priority-tags">
                    <span class="projects-priority-tag ${isKickback ? 'kickback' : 'attention'}">
                      <i class="fas ${isKickback ? 'fa-rotate-left' : 'fa-bolt'}"></i>
                      ${isKickback ? 'QA Kickback' : 'Active'}
                    </span>
                    <span class="projects-priority-tag status">${Portal.escapeHtml(this.priorityStatusLabel(project.status))}</span>
                    ${isReserved ? '<span class="projects-priority-tag reserved"><i class="fas fa-bookmark"></i> Reserved</span>' : ''}
                    ${project.is_vip ? '<span class="projects-priority-tag status">VIP</span>' : ''}
                    ${project.is_expedited ? '<span class="projects-priority-tag status">Expedited</span>' : ''}
                    ${project.is_filler ? '<span class="projects-priority-tag status">Filler</span>' : ''}
                  </div>
                  <div class="projects-priority-address">${Portal.escapeHtml(project.address || '(No address)')}</div>
                  <div class="projects-priority-meta">
                    <div><strong>${isReserved ? 'Reserved' : 'Started'}:</strong> ${Portal.escapeHtml(started)}</div>
                    ${isReserved ? `<div><strong>Waiting for:</strong> ${Portal.escapeHtml(reservedFor)}</div>` : ''}
                    <div><strong>Latest activity:</strong> ${Portal.escapeHtml(updated)}</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
      mount.querySelectorAll('[data-priority-open]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.getAttribute('data-priority-open') || '';
          if (!id) return;
          const project = items.find((entry) => String(entry.id) === id);
          this.openProjectModal(id, { bounced: this.isBouncedForMe(project || {}), project });
        });
      });
    },
    initFilters(){
      this.ensureSearchStyle();
      this.ensureEnhancedModalStyle();
      const c = document.getElementById('filterContainer');
      if (!c) return;
      const perms = cfg().perms || {};
      if (!this.browserFilterInitialized) {
        if (perms.view_all_projects) this.currentFilter = 'all';
        else if (perms.view_team_projects) this.currentFilter = 'team';
        else this.currentFilter = 'mine';
        this.browserFilterInitialized = true;
      }
      c.innerHTML = '';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; width: 350px; align-items:center;';
      const add = (id, lbl) => {
        const b = document.createElement('button');
        b.className = 'filter-btn ' + (this.currentFilter===id ? 'active' : '');
        b.innerText = lbl;
        b.onclick = () => {
          this.currentFilter = id; this.currentPage = 1;
          this.searchQuery = ''; this.searchActive = false;
          const si = document.getElementById('projectSearchInput');
          if (si) si.value = '';
          const ss = document.getElementById('projectSearchStatus');
          if (ss) { ss.textContent = ''; ss.classList.remove('active'); }
          const cb = document.getElementById('projectSearchClear');
          if (cb) cb.classList.remove('visible');
          this.initFilters(); this.fetchProjects();
        };
        btnRow.appendChild(b);
      };
      if (perms.view_all_projects) { add('all','All'); add('team','Team'); add('mine','Mine'); }
      else if (perms.view_team_projects) { add('team','Team'); add('mine','Mine'); }
      else { add('mine','My Projects'); }
      c.appendChild(btnRow);
      // Search bar
      let searchBar = document.getElementById('projectSearchBar');
      if (!searchBar) {
        searchBar = document.createElement('div');
        searchBar.id = 'projectSearchBar';
        searchBar.className = 'project-search-bar';
        searchBar.innerHTML = `
          <div class="search-input-wrap">
            <i class="fas fa-magnifying-glass search-icon"></i>
            <input type="text" id="projectSearchInput"
                   placeholder="Search all projects by address…"
                   autocomplete="off" spellcheck="false">
            <button class="search-clear-btn" id="projectSearchClear" title="Clear search">
              <i class="fas fa-xmark"></i>
            </button>
          </div>
          <span class="search-status" id="projectSearchStatus"></span>
        `;
        c.appendChild(searchBar);
        const input = document.getElementById('projectSearchInput');
        const clearBtn = document.getElementById('projectSearchClear');
        const statusEl = document.getElementById('projectSearchStatus');
        if (input) {
          input.addEventListener('input', () => {
            const val = input.value.trim();
            if (clearBtn) clearBtn.classList.toggle('visible', val.length > 0);
            if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
            if (val.length === 0) {
              this.searchQuery = ''; this.searchActive = false; this.currentPage = 1;
              if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('active'); }
              this.fetchProjects(); return;
            }
            if (val.length < 2) return;
            this.searchDebounceTimer = setTimeout(() => {
              this.searchQuery = val; this.searchActive = true; this.currentPage = 1;
              this.fetchProjects();
            }, 350);
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              input.value = ''; this.searchQuery = ''; this.searchActive = false; this.currentPage = 1;
              if (clearBtn) clearBtn.classList.remove('visible');
              if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('active'); }
              this.fetchProjects();
            }
          });
        }
        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            if (input) input.value = '';
            this.searchQuery = ''; this.searchActive = false; this.currentPage = 1;
            clearBtn.classList.remove('visible');
            if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('active'); }
            this.fetchProjects(); if (input) input.focus();
          });
        }
      } else { c.appendChild(searchBar); }
      const si = document.getElementById('projectSearchInput');
      if (si && this.searchQuery) {
        si.value = this.searchQuery;
        const cb = document.getElementById('projectSearchClear');
        if (cb) cb.classList.toggle('visible', this.searchQuery.length > 0);
      }
    },
    async fetchProjects(){
      const grid = document.getElementById('projectsGrid');
      if (grid && document.getElementById('view-projects')?.style.display !== 'none') {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#999;padding:40px;">Loading...</div>';
      }
      const statusEl = document.getElementById('projectSearchStatus');
      try {
        const isSearching = !!(this.searchActive && this.searchQuery && this.searchQuery.trim().length >= 2);
        const params = {
          filter: this.currentFilter,
          page: this.currentPage,
          limit: this.itemsPerPage,
          view: 'card'
        };
        if (!isSearching) {
          Object.assign(params, this.buildBrowserActivityParams());
        }
        const data = isSearching ? await this.fetchSearchProjects() : await this.fmPost('projects/list', params);
        if (!data || data.ok === false || data.success === false) {
          throw new Error(data?.message || data?.error || 'Unable to load projects.');
        }
        const browserProjects = this.toProjectBrowserRows(data.projects);
        this.myProjectList = browserProjects;
        if (statusEl && this.searchActive && this.searchQuery) {
          const total = data.pagination ? data.pagination.total_count : browserProjects.length;
          const totalLabel = data.pagination && data.pagination.partial ? `${total}+` : `${total}`;
          statusEl.textContent = `${totalLabel} result${total !== 1 ? 's' : ''} for "${this.searchQuery}"`;
          statusEl.classList.add('active');
        } else if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('active'); }
        if (!grid || document.getElementById('view-projects')?.style.display === 'none') return;
        grid.innerHTML = '';
        const browseProjects = browserProjects;
        if (!browseProjects.length) {
          const msg = this.searchActive
            ? 'No projects match your search.'
            : 'No projects.';
          grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#ccc;padding:40px;">${msg}</div>`;
          this.renderPagination(null); return;
        }
        browseProjects.forEach(p => {
        const bounced = this.isBouncedForMe(p);
        const displayStatus = bounced ? 'qa_bounced' : (p.status || '');
        let cls='bg-queued';
        if (displayStatus==='qa_bounced') cls='bg-review';
        else if (displayStatus==='completed') cls='bg-ready';
        else if (displayStatus==='cancelled') cls='bg-cancelled';
        else if (displayStatus==='processing' || displayStatus==='in_progress') cls='bg-processing';
        else if (displayStatus==='awaiting_review' || displayStatus==='requeue') cls='bg-review';
        let ownerDisplay = p.owner;
        if (p.assigned_to_email && p.assigned_to_email === cfg().user.email) ownerDisplay = "Me";
        if (p.owner === cfg().user.email) ownerDisplay = "Me";
        if (!ownerDisplay || ownerDisplay === 'Unknown') ownerDisplay = "Me";
        const displayTech = this.getDisplayTechnician(p);
        const payTech = this.getPayTechnician(p);
        const reservedFor = p.reserved_to_name || p.reserved_to_email || '';
        let tutorialHtml = ''; let titlePrefix = '';
        if (p.is_tutorial_instance) {
          tutorialHtml = `<div class="badge bg-tutorial">TUTORIAL</div>`;
          titlePrefix = `<i class="fas fa-graduation-cap" style="color:#673ab7; margin-right:5px;"></i>`;
        }
        const complexityBadge = this.complexityBadgeHtml(p.complexity, 'badge');
        const createdLbl = p.created_at ? this.fmtLocalDate(p.created_at) : '';
        const drafter = payTech.name || payTech.email || p.qa_paid_to_name || p.qa_paid_to_email || displayTech.name || displayTech.email || ownerDisplay || '-';
        const qa = p.qa_approved_by_name || p.qa_approved_by || '-';
        const pType = (p.project_type || 'residential').toLowerCase();
        const typeColors = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#7b1fa2' };
        const typeLabels = { residential:'RES', commercial:'COM', multifamily:'MF' };
        const typeBadgeHtml = pType !== 'residential'
          ? `<div class="badge" style="background:${typeColors[pType] || '#1a73e8'}; border-color:${typeColors[pType] || '#1a73e8'}; color:#fff; font-size:9px; font-weight:950;">${typeLabels[pType] || pType.toUpperCase()}</div>`
          : '';
        const ccArr = Array.isArray(p.cc_emails) ? p.cc_emails : [];
        const ccHint = ccArr.length ? ` &bull; CC: ${ccArr.length}` : '';
        const pinsArr = Array.isArray(p.pins) ? p.pins : [];
        const pinsHint = pinsArr.length > 1 ? ` &bull; ${pinsArr.length} pins` : '';
        const metaHtml = (displayStatus === 'completed')
          ? `${Portal.escapeHtml(drafter)} &bull; QA: ${Portal.escapeHtml(qa)}${createdLbl ? ` &bull; ${createdLbl}` : ''}`
          : `${Portal.escapeHtml(ownerDisplay || '')} &bull; ${createdLbl}${reservedFor ? ` &bull; Reserved: ${Portal.escapeHtml(reservedFor)}` : ''}${ccHint}${pinsHint}`;
        const div = document.createElement('div');
        div.className = 'tile';
        const vipBadgeHtml = p.is_vip
          ? `<div class="badge" style="top:10px; left:10px; background:#f9ab00; width: 31px; border-color:#e37400; color:#fff; font-size:9px; font-weight:950;">⭐ VIP</div>`
          : '';
        const expeditedBadgeHtml = p.is_expedited
          ? `<div class="badge" style="top:10px; left:10px; background:#0f766e; border-color:#0f766e; color:#fff; font-size:9px; font-weight:950;">EXP</div>`
          : '';
        const statusBadgeHtml = `<div class="badge ${cls}">${Portal.escapeHtml(displayStatus==='qa_bounced' ? 'QA Bounced' : (p.status || ''))}</div>`;
        const reservedBadgeHtml = reservedFor
          ? `<div class="badge" style="background:#1a73e8; border-color:#174ea6; color:#fff; font-size:9px; font-weight:950; max-width:120px;">RESERVED</div>`
          : '';
        div.innerHTML = `
          <div class="tile-thumb">
            <img src="${p.thumbnail || ''}" onerror="this.style.display='none'">
            ${this.wrapTileBadgeStack('top-left', [tutorialHtml, vipBadgeHtml, expeditedBadgeHtml])}
            ${this.wrapTileBadgeStack('top-right', [statusBadgeHtml, typeBadgeHtml])}
            ${this.wrapTileBadgeStack('bottom-left', [reservedBadgeHtml])}
            ${this.wrapTileBadgeStack('bottom-right', [complexityBadge])}
          </div>
          <div class="tile-content">
            <div class="tile-addr">${titlePrefix}${Portal.escapeHtml(p.address || '')}</div>
            <div class="tile-meta">${metaHtml}</div>
          </div>
        `;
        this.bindThumbnailFallback(div.querySelector('.tile-thumb img'), p.thumbnail_candidates);
        div.onclick = () => this.openProjectModal(p.id, { bounced, project: p });
        grid.appendChild(div);
        });
        this.renderPagination(data.pagination);
        this.refreshQueueButton(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err || 'Unable to load projects.');
        this.myProjectList = [];
        if (statusEl) {
          statusEl.textContent = this.searchActive
            ? `Search failed: ${message}`
            : `Project load failed: ${message}`;
          statusEl.classList.add('active');
        }
        if (grid && document.getElementById('view-projects')?.style.display !== 'none') {
          grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#b3261e;padding:40px;">${Portal.escapeHtml(message)}</div>`;
        }
        this.renderPagination(null);
      }
    },

    directOpen(id){
      const evt = (typeof event !== 'undefined' && event) ? event : (window.event || null);
      const openNewTab = !!evt && (evt.ctrlKey || evt.metaKey || evt.button === 1);
      const p = (this.myProjectList || []).find(x => x && x.id === id);
      if (p && this.isBouncedForMe(p)) { alert("This job was QA-bounced and reassigned. You no longer have edit access."); return; }
      if (p && String(p.status || '').toLowerCase() === 'cancelled') { alert("This project was cancelled and can no longer be opened in the editor."); return; }
      const url = 'editor.php?folder=' + encodeURIComponent(id);
      if (openNewTab) { try { evt.preventDefault(); } catch(e) {} try { evt.stopPropagation(); } catch(e) {} window.open(url, '_blank', 'noopener'); return; }
      window.location.href = url;
    },
    renderPagination(pg) {
      let pContainer = document.getElementById('projectsPagination');
      if (!pContainer) {
        pContainer = document.createElement('div');
        pContainer.id = 'projectsPagination';
        pContainer.className = 'pagination-bar';
        const grid = document.getElementById('projectsGrid');
        grid.parentNode.insertBefore(pContainer, grid.nextSibling);
      }
      if (!pg || pg.total_pages <= 1) { pContainer.innerHTML = ''; return; }
      const currentPage = Number(pg.current_page || pg.page || 1);
      const totalPages = Number(pg.total_pages || 1);
      const totalCount = Number(pg.total_count || this.myProjectList.length || 0);
      pContainer.innerHTML = `
        <div class="pg-info">Showing ${this.myProjectList.length} of ${totalCount} projects</div>
        <div class="pg-controls">
          <button class="pg-btn" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">
            <i class="fas fa-chevron-left"></i> Previous
          </button>
          <span class="pg-text">Page ${currentPage} of ${totalPages}</span>
          <button class="pg-btn" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">
            Next <i class="fas fa-chevron-right"></i>
          </button>
        </div>
      `;
      pContainer.querySelectorAll('.pg-btn').forEach(btn => {
        btn.onclick = () => { this.currentPage = parseInt(btn.dataset.page); this.fetchProjects(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      });
    },
    async openProjectModal(id, opts={}){
      this.ensureEnhancedModalStyle();
      this.ensureProjectModalEscapeClose();
      const requestToken = (this._projectModalRequestToken || 0) + 1;
      this._projectModalRequestToken = requestToken;
      this._projectModalActiveId = String(id || '').trim();
      if (opts && opts.queueNav) this.setProjectModalNavContext(opts.queueNav, id);
      else this.clearProjectModalNavContext();
      this.renderProjectModalLoading(id, opts);
      Portal.openModal('projModal');
      this.renderProjectModalNavigation();
      const bounced = !!opts.bounced;
      const data = await this.fmGet(`projects/${encodeURIComponent(id)}`)
        .then((res) => this.buildProjectModalData(id, res && res.project ? res.project : null))
        .catch(()=>({}));
      if (!this.isProjectModalRequestCurrent(id, requestToken)) return;
      if (!data.success) {
        this.renderProjectModalLoadError(id, opts, data.error || "Could not load details");
        return;
      }
      const m = data.manifest || {};
      const address = (m.address || '').trim();
      let addrDisplay = address || '-';
      const pmAddress = document.getElementById('pmAddress');
      if (m.is_tutorial_instance) {
        addrDisplay = `TRAINING: ${addrDisplay}`;
        if (pmAddress) { pmAddress.style.color = "#673ab7"; pmAddress.style.fontWeight = "bold"; }
      } else { if (pmAddress) { pmAddress.style.color = "#333"; pmAddress.style.fontWeight = "normal"; } }
      if (pmAddress) pmAddress.innerText = addrDisplay;
      const pmStatus = document.getElementById('pmStatus');
      const pmOwner  = document.getElementById('pmOwner');
      const pmDate   = document.getElementById('pmDate');
      if (pmStatus) pmStatus.innerText = m.status || '-';
      if (pmOwner)  pmOwner.innerText  = (m.issuer ? m.issuer.name : '') || m.owner_email || '-';
      if (pmDate)   pmDate.innerText   = m.created_at || '-';
      // ★ ENHANCED: comprehensive modal instead of basic fields
      this.renderProjectModalAdminMeta(m, { loading: false });
      this.renderProjectModalComprehensive(m, id, data);
      const pdfBtn = document.getElementById('pmPdfBtn');
      if (pdfBtn) { if (data.pdf_url) { pdfBtn.href = data.pdf_url; pdfBtn.style.display='flex'; } else pdfBtn.style.display='none'; }
      const editBtn = document.getElementById('pmEditBtn');
      if (editBtn) {
        const isCancelled = String(m.status || '').toLowerCase() === 'cancelled';
        if (bounced || isCancelled) { editBtn.style.display = 'none'; }
        else { editBtn.style.display = ''; editBtn.onclick = () => this.directOpen(id); }
      }
      const gal = document.getElementById('pmGallery');
      if (gal) {
        gal.classList.remove('pm-gallery-loading');
        gal.innerHTML = '';
        (data.images || []).forEach(img => {
          const d = document.createElement('div');
          d.className = 'gal-item';
          const thumbUrl = img.thumbnail_url || img.url || '';
          const fullUrl = img.url || thumbUrl;
          d.innerHTML = `<a href="${Portal.escapeHtml(fullUrl)}" target="_blank" rel="noopener" title="${Portal.escapeHtml(img.name || '')}"><img src="${Portal.escapeHtml(thumbUrl)}" loading="lazy" alt="${Portal.escapeHtml(img.name || 'Project image')}"></a>`;
          gal.appendChild(d);
        });
      }
      const canManageQueueTools = !!cfg().flags?.is_queue_admin || !!(cfg().perms && (cfg().perms.manage_queue || cfg().perms.assign_teams));
      const canManageQaPriority = !!cfg().user?.is_admin || !!cfg().flags?.is_queue_admin || !!(cfg().perms && cfg().perms.manage_qa_queue);
      const canCancelProjects = !!(cfg().perms && cfg().perms.cancel_projects);
      const canRejectNoCoverage = !!cfg().flags?.is_manager_role || !!cfg().flags?.is_queue_admin || !!(cfg().perms && cfg().perms.manage_queue);
      const canReopenCompletedProject = !!cfg().user?.is_admin && String(m.status || '').toLowerCase() === 'completed';
      if (canManageQueueTools || canCancelProjects || canRejectNoCoverage || canReopenCompletedProject) {
        this.renderProjectModalQueueTools({
          folderId: id,
          address: address || id,
          reservedToEmail: m.reserved_to_email || '',
          reservedToName: m.reserved_to_name || '',
          status: m.status || '',
          canManageQueue: canManageQueueTools,
          canCancelProjects,
          canRejectNoCoverage,
          canReopenCompletedProject
        });
        if (canManageQueueTools) this.ensureQueueAssignableUsersLoaded().catch(()=>{});
      } else { const box = document.getElementById('pmQueueToolsBox'); if (box && box.parentNode) box.parentNode.removeChild(box); }
      const canSeeEmailTools = !!cfg().flags?.is_queue_admin || !!cfg().flags?.is_qa_admin || !!(cfg().perms && (cfg().perms.manage_qa || cfg().perms.manage_queue));
      if (canSeeEmailTools) {
        this.renderProjectModalEmailSection({ folderId: id, address: address || id, emailSummary: null, loading: true });
        this.refreshProjectModalEmail(id, address || id, { requestToken }).catch(()=>{});
      } else { const box = document.getElementById('pmEmailBox'); if (box && box.parentNode) box.parentNode.removeChild(box); }
      this.renderProjectModalNavigation();
    },
    ensureProjectModalEscapeClose(){
      if (this._projectModalEscapeBound) return;
      document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('projModal');
        if (!modal || window.getComputedStyle(modal).display === 'none') return;
        if (e.key === 'Escape') {
          Portal.closeModal('projModal');
          return;
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const target = e.target;
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
        if (target && (target.isContentEditable || ['input', 'textarea', 'select'].includes(tag))) return;
        if (!this.projectModalNavContext) return;
        e.preventDefault();
        this.navigateProjectModal(e.key === 'ArrowLeft' ? -1 : 1);
      });
      this._projectModalEscapeBound = true;
    },
    normalizeProjectModalNavItems(items){
      const out = [];
      const seen = new Set();
      (Array.isArray(items) ? items : []).forEach((project) => {
        const id = String(project?.id || project?.folder || project?.project_id || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({
          id,
          label: String(project?.address || project?.name || id).trim() || id,
          project
        });
      });
      return out;
    },
    queueNavKindLabel(kind){
      const labels = {
        rework_requested: 'rework requests',
        requeue: 're-queue',
        waiting: 'waiting',
        queued: 'queued',
        in_progress: 'in progress',
        qa_waiting: 'waiting for QA',
        qa_active: 'QA in progress',
        qa: 'QA',
        release_holding: 'release holding',
        rejected: 'rejected',
        cancelled: 'cancelled',
        completed: 'completed'
      };
      return labels[kind] || String(kind || 'status').replace(/_/g, ' ');
    },
    setProjectModalNavContext(nav, currentId){
      const items = this.normalizeProjectModalNavItems(nav?.items);
      const current = String(currentId || nav?.currentId || '').trim();
      if (items.length <= 1 || !current || !items.some(item => item.id === current)) {
        this.projectModalNavContext = null;
        return;
      }
      this.projectModalNavContext = {
        kind: String(nav?.kind || 'status'),
        label: String(nav?.label || this.queueNavKindLabel(nav?.kind || '')).trim(),
        items,
        currentId: current
      };
    },
    clearProjectModalNavContext(){
      this.projectModalNavContext = null;
      this.renderProjectModalNavigation();
    },
    projectModalNavSnapshot(){
      const ctx = this.projectModalNavContext;
      if (!ctx || !Array.isArray(ctx.items) || ctx.items.length <= 1) return null;
      const currentId = String(this._projectModalActiveId || ctx.currentId || '').trim();
      const index = ctx.items.findIndex(item => item.id === currentId);
      if (index < 0) return null;
      return {
        ctx,
        index,
        prev: index > 0 ? ctx.items[index - 1] : null,
        next: index < ctx.items.length - 1 ? ctx.items[index + 1] : null
      };
    },
    renderProjectModalNavigation(){
      const modal = document.getElementById('projModal');
      if (!modal) return;
      let prevBtn = document.getElementById('pmProjectPrevBtn');
      let nextBtn = document.getElementById('pmProjectNextBtn');
      const snap = this.projectModalNavSnapshot();
      if (!snap) {
        if (prevBtn) prevBtn.remove();
        if (nextBtn) nextBtn.remove();
        return;
      }
      const makeBtn = (id, dir, icon) => {
        let btn = document.getElementById(id);
        if (!btn) {
          btn = document.createElement('button');
          btn.id = id;
          btn.type = 'button';
          btn.className = `pm-project-nav pm-project-nav-${dir < 0 ? 'prev' : 'next'}`;
          btn.innerHTML = `<i class="fas ${icon}"></i>`;
          modal.appendChild(btn);
        }
        btn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.navigateProjectModal(dir);
        };
        return btn;
      };
      prevBtn = makeBtn('pmProjectPrevBtn', -1, 'fa-chevron-left');
      nextBtn = makeBtn('pmProjectNextBtn', 1, 'fa-chevron-right');
      const statusLabel = snap.ctx.label || this.queueNavKindLabel(snap.ctx.kind);
      const setButton = (btn, target, directionLabel) => {
        const disabled = !target;
        btn.disabled = disabled;
        btn.classList.toggle('disabled', disabled);
        btn.title = disabled ? `No ${directionLabel.toLowerCase()} project in ${statusLabel}` : `${directionLabel}: ${target.label}`;
        btn.setAttribute('aria-label', disabled ? `No ${directionLabel.toLowerCase()} project in ${statusLabel}` : `${directionLabel} project in ${statusLabel}: ${target.label}`);
      };
      setButton(prevBtn, snap.prev, 'Previous');
      setButton(nextBtn, snap.next, 'Next');
    },
    navigateProjectModal(direction){
      const snap = this.projectModalNavSnapshot();
      if (!snap) return;
      const target = direction < 0 ? snap.prev : snap.next;
      if (!target) return;
      const nav = {
        kind: snap.ctx.kind,
        label: snap.ctx.label,
        items: snap.ctx.items.map(item => item.project || { id: item.id, address: item.label }),
        currentId: target.id
      };
      this.openProjectModal(target.id, { project: target.project, queueNav: nav }).catch(()=>{});
    },
    canViewProjectAdminMeta(){
      const perms = cfg().perms || {};
      return !!cfg().user?.is_admin || !!perms.assign_teams;
    },
    formatProjectOrgLabel(project){
      const orgRef = (project && project.organization_ref && typeof project.organization_ref === 'object') ? project.organization_ref : {};
      const orgName = String(project?.organization_name || orgRef.name || '').trim();
      const orgId = String(project?.organization_id || orgRef.id || '').trim();
      if (orgName && orgId) return `${orgName} (${orgId})`;
      return orgName || orgId || '-';
    },
    renderProjectModalAdminMeta(project={}, opts={}){
      const metaCol = document.querySelector('#projModal .proj-meta');
      const anchor = document.getElementById('pmDate')?.closest('.meta-group');
      const existing = document.getElementById('pmAdminMetaBox');
      if (!this.canViewProjectAdminMeta()) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }
      if (!metaCol) return;
      const loading = !!opts.loading;
      const customerEmail = String(project?.owner_email || project?.issuer?.email || '').trim() || (loading ? 'Loading...' : '-');
      const companyName = String(project?.issuer?.company || project?.owner_company || '').trim() || (loading ? 'Loading...' : '-');
      const orgRaw = this.formatProjectOrgLabel(project);
      const orgLabel = (loading && orgRaw === '-') ? 'Loading...' : orgRaw;
      const box = existing || document.createElement('div');
      box.id = 'pmAdminMetaBox';
      box.innerHTML = `
        <div class="meta-group">
          <div class="meta-label">Customer Email</div>
          <div class="meta-val">${Portal.escapeHtml(customerEmail)}</div>
        </div>
        <div class="meta-group">
          <div class="meta-label">Company</div>
          <div class="meta-val">${Portal.escapeHtml(companyName)}</div>
        </div>
        <div class="meta-group">
          <div class="meta-label">Org</div>
          <div class="meta-val">${Portal.escapeHtml(orgLabel)}</div>
        </div>
      `;
      if (!existing) {
        if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', box);
        else metaCol.appendChild(box);
      }
    },
    isProjectModalRequestCurrent(folderId, requestToken){
      const activeId = String(this._projectModalActiveId || '').trim();
      const targetId = String(folderId || '').trim();
      if (!activeId || !targetId || activeId !== targetId) return false;
      return !requestToken || this._projectModalRequestToken === requestToken;
    },
    clearProjectModalDynamicSections(){
      ['pmNewFieldsBox', 'pmComprehensiveBox', 'pmQueueToolsBox', 'pmEmailBox'].forEach((sectionId) => {
        const el = document.getElementById(sectionId);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    },
    setProjectModalMetaFields({ address, status, owner, date, isTutorial=false }){
      const pmAddress = document.getElementById('pmAddress');
      const pmStatus = document.getElementById('pmStatus');
      const pmOwner  = document.getElementById('pmOwner');
      const pmDate   = document.getElementById('pmDate');
      const addrDisplay = String(address || '').trim() || '-';
      if (pmAddress) {
        pmAddress.innerText = isTutorial ? `TRAINING: ${addrDisplay}` : addrDisplay;
        pmAddress.style.color = isTutorial ? '#673ab7' : '#333';
        pmAddress.style.fontWeight = isTutorial ? 'bold' : 'normal';
      }
      if (pmStatus) pmStatus.innerText = status || '-';
      if (pmOwner) pmOwner.innerText = owner || '-';
      if (pmDate) pmDate.innerText = date || '-';
    },
    renderProjectModalLoading(id, opts={}){
      const modal = document.getElementById('projModal');
      if (!modal) return;
      const seed = opts.project ? this.normalizeProjectManifest(opts.project) : {};
      this.clearProjectModalDynamicSections();
      this.setProjectModalMetaFields({
        address: seed.address || `Project ${id}`,
        status: seed.status || 'Loading details...',
        owner: seed.owner || seed.owner_name || seed.owner_email || seed.issuer?.name || seed.issuer?.email || 'Loading...',
        date: seed.created_at || 'Loading...',
        isTutorial: !!seed.is_tutorial_instance
      });
      this.renderProjectModalAdminMeta(seed, { loading: true });
      const pdfBtn = document.getElementById('pmPdfBtn');
      if (pdfBtn) {
        pdfBtn.removeAttribute('href');
        pdfBtn.style.display = 'none';
      }
      const editBtn = document.getElementById('pmEditBtn');
      if (editBtn) {
        editBtn.style.display = 'none';
        editBtn.onclick = null;
      }
      const gal = document.getElementById('pmGallery');
      if (gal) {
        gal.classList.add('pm-gallery-loading');
        gal.innerHTML = `
          <div class="pm-loading-panel">
            <div class="pm-loading-head">
              <i class="fas fa-circle-notch fa-spin"></i> Loading project details...
            </div>
            <div class="pm-loading-skeletons">
              <div class="pm-skeleton-card"></div>
              <div class="pm-skeleton-card"></div>
              <div class="pm-skeleton-card"></div>
            </div>
          </div>
        `;
      }
    },
    renderProjectModalLoadError(id, opts={}, message='Could not load details'){
      const seed = opts.project ? this.normalizeProjectManifest(opts.project) : {};
      this.clearProjectModalDynamicSections();
      this.setProjectModalMetaFields({
        address: seed.address || `Project ${id}`,
        status: 'Load failed',
        owner: seed.owner || seed.owner_name || seed.owner_email || seed.issuer?.name || seed.issuer?.email || '-',
        date: seed.created_at || '-',
        isTutorial: !!seed.is_tutorial_instance
      });
      this.renderProjectModalAdminMeta(seed, { loading: false });
      const gal = document.getElementById('pmGallery');
      if (gal) {
        gal.classList.add('pm-gallery-loading');
        gal.innerHTML = `<div class="pm-loading-panel pm-loading-error"><div class="pm-loading-head"><i class="fas fa-triangle-exclamation"></i> Could not load project details</div><div class="pm-loading-copy">${Portal.escapeHtml(message)}</div></div>`;
      }
    },

    // -----------------------
    // Next in Queue (sidebar)
    // -----------------------
    setQueueButtonState({ hasNext, count, hint, busy=false }){
      this.queueHasNext = !!hasNext;
      if (typeof count === 'number') this.queueCount = count;
      const btn = document.getElementById('btnNextQueue');
      const dot = document.getElementById('queueDot');
      const cTxt = document.getElementById('queueCountText');
      const hTxt = document.getElementById('queueHint');
      // Break panel is rendered by renderBreakIdlePanel(); always render it.
      if (cTxt) this.renderBreakIdlePanel(cTxt);
      // Hide dot and hint — sidebar is now break-bar only
      if (dot) dot.style.display = 'none';
      if (hTxt) hTxt.style.display = 'none';
      const trainingOk = !!cfg().user.training_complete;
      const ready = trainingOk && this.queueHasNext;
      if (btn) {
        btn.disabled = busy || !ready;
        btn.classList.toggle('disabled', btn.disabled);
        if (!trainingOk) {
          btn.innerHTML = busy ? `<i class="fas fa-circle-notch fa-spin"></i> Assigning…` : `<i class="fas fa-lock"></i> Next in Queue`;
        } else {
          btn.innerHTML = busy ? `<i class="fas fa-circle-notch fa-spin"></i> Assigning…` : `<i class="fas fa-forward"></i> Next in Queue`;
        }
      }
    },
    async getMineProjectsFresh(){
      const now = Date.now();
      if (this.mineCache.projects && (now - (this.mineCache.at || 0)) < this.mineCacheTtlMs) return this.mineCache.projects;
      const [mine, active] = await Promise.all([
        this.fmPost('projects/list', {
          filter:'mine',
          page: 1,
          limit: 150,
          view: 'card',
          ...this.buildMineActivityParams()
        }).catch(()=>({})),
        this.getAssignedActiveProjectsFresh().catch(() => [])
      ]);
      const merged = new Map();
      (Array.isArray(mine.projects) ? mine.projects : []).forEach((project) => {
        if (project && project.id) merged.set(String(project.id), project);
      });
      (Array.isArray(active) ? active : []).forEach((project) => {
        if (project && project.id) merged.set(String(project.id), project);
      });
      const projects = this.toProjectBrowserRows(Array.from(merged.values()));
      this.mineCache = { at: now, projects };
      return projects;
    },
    async getAssignedActiveProjectsFresh(force=false){
      const now = Date.now();
      if (!force && this.activeMineCache.projects && (now - (this.activeMineCache.at || 0)) < this.mineCacheTtlMs) {
        return this.activeMineCache.projects;
      }
      const res = await Portal.apiPost(cfg().endpoints.server, {
        action:'my_active_projects',
        actor:this.fmActor(),
        queue_mode:this.getQueueMode()
      }).catch(()=>({}));
      let projects = Array.isArray(res.projects) ? res.projects : [];
      projects = this.toProjectBrowserRows(projects);
      this.activeMineCache = { at: now, projects };
      return projects;
    },
    async refreshQueueButton(force=false){
      try {
        const trainingOk = !!cfg().user.training_complete;
        const q = await this.fmPost('queue/status/compat', {
          queue_mode: this.getQueueMode(),
          include_active_projects: true
        }).catch(()=>({}));
        const qHasNext = !!q.has_next;
        const qCount = (typeof q.queue_count === 'number') ? q.queue_count : null;
        // Break state from server
        const serverOnBreak = !!q.on_break;
        this.breakState.onBreak = serverOnBreak;
        if (q.break_started_at) {
          this.breakState.breakStartedAt = this.safeParseTs(q.break_started_at);
        } else {
          this.breakState.breakStartedAt = null;
        }
        // Idle time: only seed from server on first load; after that let the local 1s ticker handle it
        if (q.last_submitted_at && !this.breakState.idleTimeLoaded) {
          this.breakState.lastSubmittedAt = this.safeParseTs(q.last_submitted_at);
          this.breakState.idleTimeLoaded = true;
        }
        // ✅ NEW: wait_for_feedback mode blocking
        const queueBlocked = !!q.queue_blocked;
        const queueBlockedReason = q.queue_blocked_reason || null;
        const queueMode = q.queue_mode || 'disabled';
        const me = (cfg().user.email || '').toLowerCase().trim();
        const UNFINISHED = new Set(['queued','ready','processing','in_progress','correction_needed','requeue']);
        let myBacklogReal = 0;
        let myBacklogFiller = 0;
        const mineProjects = Array.isArray(q.active_projects)
          ? this.toProjectBrowserRows(q.active_projects)
          : await this.getAssignedActiveProjectsFresh(force);
        if (Array.isArray(q.active_projects)) {
          this.activeMineCache = { at: Date.now(), projects: mineProjects };
        }
        if (Array.isArray(mineProjects)) {
          for (const p of mineProjects) {
            const assigned = (p.assigned_to_email || '').toLowerCase().trim();
            const correction = (p.correction_to_email || '').toLowerCase().trim();
            const reserved = (p.reserved_to_email || '').toLowerCase().trim();
            const hasOwner = !!(assigned || correction || reserved);
            if (hasOwner && assigned !== me && correction !== me && reserved !== me) continue;
            const st = String(p.status || '').toLowerCase();
            if (!UNFINISHED.has(st)) continue;
            const isFiller = !!p.is_filler;
            if (isFiller) myBacklogFiller++;
            else myBacklogReal++;
          }
        }
        const hasWork = (myBacklogReal > 0) || qHasNext || (myBacklogFiller > 0);
        this.queueHasNext = hasWork;
        this.queueCount = qCount;
        const btn = document.getElementById('btnNextQueue');
        const dot = document.getElementById('queueDot');
        const cTxt = document.getElementById('queueCountText');
        const hTxt = document.getElementById('queueHint');
        // Render break/idle panel (visible to ALL users)
        this.renderBreakIdlePanel(cTxt);
        // Hide dot and hint — sidebar is now break-bar only
        if (dot) dot.style.display = 'none';
        if (hTxt) hTxt.style.display = 'none';
        // ✅ NEW: Block if in wait_for_feedback mode with pending QA, or on break
        const ready = trainingOk && hasWork && !queueBlocked && !serverOnBreak;
        const showContinue = (myBacklogReal > 0) || (myBacklogFiller > 0);
        // -----------------------
        // 🔔 DING: disabled -> enabled transition
        // -----------------------
        const wasDisabled = (this.lastSidebarBtnDisabled === null || typeof this.lastSidebarBtnDisabled === 'undefined') ? null : !!this.lastSidebarBtnDisabled;
        const isDisabledNow = !ready;
        if (wasDisabled === null) { this.lastSidebarBtnDisabled = isDisabledNow; }
        else { if (wasDisabled === true && isDisabledNow === false) { this.playDing(); } this.lastSidebarBtnDisabled = isDisabledNow; }
        if (btn) {
          btn.disabled = !ready;
          btn.classList.toggle('disabled', btn.disabled);
          // ✅ NEW: Show break/awaiting QA/etc button text
          if (serverOnBreak) {
            btn.innerHTML = `<i class="fas fa-mug-hot"></i> On a Break`;
          } else if (queueBlocked) {
            btn.innerHTML = `<i class="fas fa-clock"></i> Awaiting QA`;
          } else if (btn.disabled) {
            btn.innerHTML = trainingOk ? `<i class="fas fa-forward"></i> Next in Queue` : `<i class="fas fa-lock"></i> Next in Queue`;
          } else {
            btn.innerHTML = showContinue ? `<i class="fas fa-rotate-left"></i> Continue Work` : `<i class="fas fa-forward"></i> Next in Queue`;
          }
        }
      } catch (e) {
        this.setQueueButtonState({ hasNext:false, count:this.queueCount, hint:'Error' });
      }
    },
    async handleNextInQueueClick(){
      if (!cfg().user.training_complete) return;
      if (this.breakState.onBreak) {
        alert('You are currently on a break. Return from your break to continue working.');
        return;
      }
      if (this.queueBusy) return;
      this.queueBusy = true;

      // Resume assigned work before applying role-specific queue-claim behavior.
      // Admins and managers can also perform technician work, so tying this check
      // to isDraftingTechnician() can strand their in-progress projects.
      this.setQueueButtonState({ hasNext:this.queueHasNext, count:this.queueCount, hint:'Checking...', busy:true });
      try {
        const me = String(cfg().user.email || '').toLowerCase().trim();
        const resumableStatuses = new Set(['queued','ready','processing','in_progress','correction_needed','requeue']);
        const queueStatus = await this.fmPost('queue/status/compat', {
          queue_mode:this.getQueueMode(),
          include_active_projects:true
        }).catch(()=>({}));
        const activeProjects = Array.isArray(queueStatus.active_projects)
          ? this.toProjectBrowserRows(queueStatus.active_projects)
          : [];
        this.activeMineCache = { at: Date.now(), projects: activeProjects };
        const resumableProjects = activeProjects.filter((project) => {
          if (!project || !project.id) return false;
          const status = String(project.status || '').toLowerCase().trim().replace(/\s+/g, '_');
          const assigned = String(project.assigned_to_email || '').toLowerCase().trim();
          const correction = String(project.correction_to_email || '').toLowerCase().trim();
          return resumableStatuses.has(status) && (assigned === me || correction === me);
        });
        resumableProjects.sort((a, b) => this.compareProductionPriority(a, b));
        if (resumableProjects[0]?.id) {
          window.location.href = 'editor.php?folder=' + encodeURIComponent(resumableProjects[0].id);
          return;
        }
      } catch (e) {
        // Continue to the legacy/server fallback below if the indexed lookup fails.
      }

      if (this.isDraftingTechnician()) {
        try {
          this.setQueueButtonState({ hasNext:this.queueHasNext, count:this.queueCount, hint:'Assigning...', busy:true });
          const data = await Portal.apiPost(cfg().endpoints.server, {
            action:'claim_next_for_me',
            actor:this.fmActor(),
            queue_mode:this.getQueueMode()
          }).catch(()=>({}));
          if (data && data.success && data.folder) {
            this.mineCache = { at: 0, projects: null };
            this.activeMineCache = { at: 0, projects: null };
            window.location.href = 'editor.php?folder=' + encodeURIComponent(data.folder);
            return;
          }
          this.queueBusy = false;
          await this.refreshQueueButton(true);
          alert(data?.error || 'No project available.');
        } catch (e) {
          this.queueBusy = false;
          await this.refreshQueueButton(true);
          alert("Failed to claim next project.");
        }
        return;
      }
      this.setQueueButtonState({ hasNext:this.queueHasNext, count:this.queueCount, hint:'Checking…', busy:true });
      const me = (cfg().user.email || '').toLowerCase().trim();
      const normStatus = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
      const HARD_NOT_RESUMABLE = new Set(['awaiting_review','completed','rejected_no_coverage','rejected','cancelled']);
      const ALWAYS_RESUMABLE = new Set(['queued','ready','processing','in_progress','correction_needed','requeue']);
      const pickResumeId = (projects, { allowFiller=false } = {}) => {
        if (!Array.isArray(projects)) return null;
        const candidates = [];
        for (const p of projects) {
          if (!p || !p.id) continue;
          const st = normStatus(p.status);
          if (HARD_NOT_RESUMABLE.has(st)) continue;
          const isFiller = !!p.is_filler;
          if (!allowFiller && isFiller) continue;
          const assigned = (p.assigned_to_email || '').toLowerCase().trim();
          const correction = (p.correction_to_email || '').toLowerCase().trim();
          const startedAt = p.started_at ? Date.parse(String(p.started_at).replace(' ', 'T')) : 0;
          const reservedAt = p.reserved_at ? Date.parse(String(p.reserved_at).replace(' ', 'T')) : 0;
          const assignedAt = p.assigned_at ? Date.parse(String(p.assigned_at).replace(' ', 'T')) : 0;
          const createdAt  = p.created_at  ? Date.parse(String(p.created_at).replace(' ', 'T'))  : 0;
          let ok = ((assigned === me || correction === me) && ALWAYS_RESUMABLE.has(st));
          if (!ok) ok = (assigned === me && !!startedAt);
          if (!ok) ok = (correction === me && (st === 'correction_needed' || st === 'requeue'));
          if (!ok) continue;
          candidates.push({
            ...p,
            id: p.id,
            _resume_sort_ts: startedAt || reservedAt || assignedAt || createdAt || 0
          });
        }
        candidates.sort((a, b) => this.compareProductionPriority(a, b));
        return candidates.length ? candidates[0].id : null;
      };
      try {
        const activeProjects = await this.getAssignedActiveProjectsFresh(true);
        const mineProjects = await this.getMineProjectsFresh();
        const resumeActive = pickResumeId(activeProjects, { allowFiller:true });
        if (resumeActive) { window.location.href = 'editor.php?folder=' + encodeURIComponent(resumeActive); return; }
        const resumeReal = pickResumeId(mineProjects, { allowFiller:false });
        if (resumeReal) { window.location.href = 'editor.php?folder=' + encodeURIComponent(resumeReal); return; }
        let data = null;
        if (data === null) {
          this.setQueueButtonState({ hasNext:this.queueHasNext, count:this.queueCount, hint:'Assigning…', busy:true });
          data = await Portal.apiPost(cfg().endpoints.server, {
            action:'claim_next_for_me',
            actor:this.fmActor(),
            queue_mode:this.getQueueMode()
          }).catch(()=>({}));
          if (!data || !data.success) { this.queueBusy = false; await this.refreshQueueButton(true); alert(data?.error || 'No project available.'); return; }
          this.mineCache = { at: 0, projects: null };
          this.activeMineCache = { at: 0, projects: null };
          window.location.href = 'editor.php?folder=' + encodeURIComponent(data.folder);
          return;
        }
        const resumeFiller = pickResumeId(mineProjects, { allowFiller:true });
        if (resumeFiller) { window.location.href = 'editor.php?folder=' + encodeURIComponent(resumeFiller); return; }
        this.queueBusy = false;
        await this.refreshQueueButton(true);
        alert(data?.error || 'No project available.');
      } catch (e) { this.queueBusy = false; await this.refreshQueueButton(true); alert("Failed to claim next project."); }
    },
      
    // -----------------------
    // Project type / CC / Pins / Folder ID display in modal
    // -----------------------
    getCustomerReworkRequests(project){
      const pools = [
        project?.report_change_requests,
        project?.latest_report_change_request ? [project.latest_report_change_request] : null,
        project?.manifest?.report_change_requests,
        project?.manifest?.latest_report_change_request ? [project.manifest.latest_report_change_request] : null,
        project?.workflow?.report_change_requests
      ];
      const out = [];
      const seen = new Set();
      pools.forEach((pool) => {
        if (!Array.isArray(pool)) return;
        pool.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          const id = String(entry.id || entry.request_id || `${entry.created_at || ''}|${entry.type || ''}|${entry.notes || ''}`).trim();
          if (id && seen.has(id)) return;
          if (id) seen.add(id);
          out.push(entry);
        });
      });
      return out.sort((a, b) => {
        const at = Date.parse(String(a?.created_at || a?.requested_at || '')) || 0;
        const bt = Date.parse(String(b?.created_at || b?.requested_at || '')) || 0;
        return bt - at;
      });
    },
    customerReworkLabel(type){
      const key = String(type || '').toLowerCase();
      if (key === 'additional_structure') return 'Additional Structure';
      if (key === 'report_issue') return 'Reported Issue';
      if (key === 'change_correction') return 'Change / Correction';
      return key ? key.replace(/_/g, ' ') : 'Customer Request';
    },
    customerReworkIcon(type){
      const key = String(type || '').toLowerCase();
      if (key === 'additional_structure') return 'fa-location-dot';
      if (key === 'report_issue') return 'fa-circle-exclamation';
      return 'fa-pen-to-square';
    },
    customerReworkStatusLabel(status){
      const key = String(status || '').toLowerCase();
      const labels = {
        pending_review: 'Pending Review',
        sent_to_support: 'Sent to Support',
        accepted: 'Accepted',
        rejected: 'Rejected',
        completed: 'Completed',
        submission_failed: 'Submission Failed',
        reworking: 'Reworking'
      };
      return labels[key] || (key ? key.replace(/_/g, ' ') : 'Pending');
    },
    renderCustomerReworkSection(project, folderId, esc, fmtd){
      const requests = this.getCustomerReworkRequests(project);
      if (!requests.length) return '';
      const renderPhotos = (request) => {
        const photos = Array.isArray(request.photos) ? request.photos : [];
        const valid = photos.filter((photo) => photo && (photo.data_url || photo.dataUrl || photo.url || photo.src));
        if (!valid.length) return '';
        return `<div class="pm-rework-images">${valid.map((photo, idx) => {
          const src = photo.data_url || photo.dataUrl || photo.url || photo.src || '';
          const name = photo.name || `Customer image ${idx + 1}`;
          return `<a href="${esc(src)}" target="_blank" rel="noopener" title="${esc(name)}"><img src="${esc(src)}" alt="${esc(name)}"></a>`;
        }).join('')}</div>`;
      };
      const renderPins = (request) => {
        const pins = Array.isArray(request.pins) ? request.pins : [];
        const valid = pins.filter((pin) => Number.isFinite(Number(pin?.lat ?? pin?.latitude)) && Number.isFinite(Number(pin?.lng ?? pin?.longitude)));
        if (!valid.length) return '';
        return `<div class="pm-rework-pins">${valid.map((pin, idx) => {
          const lat = Number(pin.lat ?? pin.latitude);
          const lng = Number(pin.lng ?? pin.longitude);
          return `<span class="pm-rework-pin"><i class="fas fa-location-dot"></i> Structure ${idx + 1}: ${esc(lat.toFixed(6))}, ${esc(lng.toFixed(6))}</span>`;
        }).join('')}</div>`;
      };
      const renderRequest = (request, isLatest) => {
        const type = String(request.type || request.request_type || '').toLowerCase();
        const label = this.customerReworkLabel(type);
        const icon = this.customerReworkIcon(type);
        const status = this.customerReworkStatusLabel(request.status);
        const createdBy = request.created_by_name || request.created_by_email || request.requested_by_name || request.requested_by_email || '';
        const createdAt = request.created_at || request.requested_at || '';
        const notes = request.notes || request.description || request.message || '';
        const charged = Number(request.charged_amount || 0);
        const gross = Number(request.gross_amount || 0);
        const rush = !!request.rush_requested;
        const expedite = this.reportExpediteOptionLabel(request.report_expedite_option);
        const meta = [];
        if (createdAt) meta.push(fmtd(createdAt));
        if (createdBy) meta.push(createdBy);
        meta.push(status);
        if (charged > 0 || gross > 0) meta.push(`Charged $${(charged || gross).toFixed(2)}`);
        if (request.free_expedite_applied) meta.push('Free expedite applied');
        if (rush) meta.push(`Rush ${expedite}`);
        const lead = type === 'additional_structure'
          ? 'Customer requested this additional structure be drawn.'
          : (type === 'report_issue' ? 'Customer reported an issue for support visibility.' : 'Customer requested a report change or correction.');
        return `<div class="pm-rework-card ${isLatest ? 'latest' : ''}">
          <div class="pm-rework-card-head">
            <div class="pm-rework-title"><i class="fas ${esc(icon)}"></i> ${esc(label)}</div>
            <div class="pm-rework-date">${esc(meta.join(' - '))}</div>
          </div>
          <div class="pm-rework-lead">${esc(lead)}</div>
          ${notes ? `<div class="pm-rework-notes">${esc(notes)}</div>` : ''}
          ${renderPins(request)}
          ${renderPhotos(request)}
        </div>`;
      };
      return `<div class="pm-section pm-customer-rework-section">
        <div class="pm-section-head">
          <i class="fas fa-screwdriver-wrench" style="color:#7b1fa2;"></i> Customer Rework Request
          <span class="pm-rework-count">${requests.length} request${requests.length === 1 ? '' : 's'}</span>
        </div>
        ${requests.map((request, idx) => renderRequest(request, idx === 0)).join('')}
      </div>`;
    },
    rejectionProjectTypeLabel(value){
      const key = String(value || '').toLowerCase().replace(/[_\s]+/g, '-');
      if (key === 'multi-family' || key === 'multifamily') return 'multi-family';
      if (key === 'commercial') return 'commercial';
      return 'residential';
    },
    customerRejectionMessageForReason(project, reason, refundText){
      const reorder = (project?.rejection_reorder && typeof project.rejection_reorder === 'object') ? project.rejection_reorder : {};
      const correctType = String(project?.correct_project_type || project?.rejection_correct_project_type || reorder.project_type || '').toLowerCase();
      const orderedType = this.rejectionProjectTypeLabel(project?.project_type || 'residential');
      const correctLabel = this.rejectionProjectTypeLabel(correctType);
      if (reason === 'incorrect_structure_type') {
        return `This was ordered as ${orderedType}, but it appears to require a ${correctLabel} report. ${refundText} The reorder link opens the previous settings with ${correctLabel} selected.`;
      }
      if (reason === 'obscured_visibility') {
        return 'We were not able to complete this report because the structure is too obscured in the available imagery. This can happen when trees, shadows, image quality, or other visual obstructions prevent us from confidently identifying and measuring the roof.';
      }
      if (reason === 'invalid_pin_placement') {
        return 'We were not able to complete this report because the selected pin does not appear to be placed on a structure we can measure. This can happen if the pin is on a yard, driveway, nearby object, or a structure that does not have enough usable imagery for accurate measurement.';
      }
      if (reason === 'api_insufficient_credits') {
        return String(project?.rejection_message || '').trim()
          || 'We were not able to complete this API report because the organization did not have enough credits for the additional structures on the parcel, and Auto Top-Up was not able to complete.';
      }
      return 'We do not currently have coverage for this address. Our coverage is based on individual structures, not just area, so we may have coverage for other properties in the same neighborhood.';
    },
    renderCustomerRejectionNotice(project, esc){
      const status = String(project?.status || '').toLowerCase();
      if (!['rejected', 'rejected_no_coverage'].includes(status)) return '';
      const reason = String(project?.rejection_reason || '').toLowerCase();
      const reorder = (project?.rejection_reorder && typeof project.rejection_reorder === 'object') ? project.rejection_reorder : {};
      const correctType = String(project?.correct_project_type || project?.rejection_correct_project_type || reorder.project_type || '').toLowerCase();
      const reorderUrl = String(project?.reorder_url || reorder.url || '').trim();
      const correctLabel = this.rejectionProjectTypeLabel(correctType);
      const refundAmount = Number(project?.refund_amount || 0);
      const refundText = project?.refund_issued
        ? `We have reimbursed the customer${refundAmount > 0 ? ` $${refundAmount.toFixed(2)}` : ''} for this report.`
        : 'The customer message says reimbursement is being returned for this report.';
      const title = project?.customer_rejection_title || (reason === 'incorrect_structure_type' ? 'Incorrect structure type' : 'Project rejected');
      const message = project?.customer_rejection_message || this.customerRejectionMessageForReason(project, reason, refundText);
      const action = (reason === 'incorrect_structure_type' && reorderUrl)
        ? `<a class="pm-rejection-action" href="${esc(reorderUrl)}" target="_blank" rel="noopener"><i class="fas fa-cart-plus"></i> Reorder as ${esc(correctLabel.charAt(0).toUpperCase() + correctLabel.slice(1))}</a>`
        : '';
      return `<div class="pm-section pm-rejection-notice">
        <div class="pm-section-head"><i class="fas fa-circle-exclamation" style="color:#d93025;"></i> Customer Rejection Message</div>
        <div class="pm-rejection-title">${esc(title)}</div>
        <div class="pm-rejection-copy">${esc(message)}</div>
        <div class="pm-rejection-refund"><i class="fas fa-credit-card"></i> ${esc(refundText)}</div>
        ${action}
      </div>`;
    },
    renderProjectModalComprehensive(manifest, folderId, fullData){
        const modal = document.getElementById('projModal');
        if (!modal) return;
        const gal = document.getElementById('pmGallery');
        const host = (gal && gal.parentElement) ? gal.parentElement : modal;
        let oldBox = document.getElementById('pmNewFieldsBox');
        if (oldBox) oldBox.remove();
        let box = document.getElementById('pmComprehensiveBox');
        if (box) box.remove();
        box = document.createElement('div');
        box.id = 'pmComprehensiveBox';
        const m = manifest;
        const esc = (s) => Portal.escapeHtml(s || '');
        const status = m.status || 'unknown';
        const statusLabels = {
          queued:'Queued', ready:'Ready', processing:'In Progress', in_progress:'In Progress',
        awaiting_review:'Awaiting QA', correction_needed:'Correction Needed', requeue:'Re-Queue', rework_requested:'Rework Requested', reworking:'Reworking',
          completed:'Completed', submission_failed:'Submission Failed', rejected_no_coverage:'Rejected (No Coverage)',
          rejected:'Rejected', cancelled:'Cancelled', pending_rejection:'Pending Rejection', generating_filler:'Generating'
        };
        const submissionStatus = String(m.submission_status || '').trim().toLowerCase();
        const statusLabel = status === 'completed' && submissionStatus === 'submitting'
          ? 'Submitting'
          : (statusLabels[status] || status);
        const statusPillClass = status === 'completed' && submissionStatus === 'submitting' ? 'submitting' : status;
        const pType = (m.project_type || 'residential').toLowerCase();
        const typeColors = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#7b1fa2' };
        const typeLabels = { residential:'Residential', commercial:'Commercial', multifamily:'Multifamily' };
        const cxLevel = this.normalizeComplexity(m.complexity);
        const cxColor = this.complexityColor(cxLevel);
        const cxBg = this.complexityBgColor(cxLevel);
        const cxDots = '\u25CF'.repeat(cxLevel) + '\u25CB'.repeat(5 - cxLevel);
        const cxPoints = this.resolveProjectPoints(m);
        const canManageComplexity = this.canManageProjectComplexity();
        const issuerName = m.issuer?.name || '-';
        const issuerCompany = m.issuer?.company || m.owner_company || '';
        const techCtx = this.getProjectTechnicianContext(m);
        const displayTech = techCtx.display || {};
        const originalTech = techCtx.original || null;
        const latestTech = techCtx.latest || null;
        const correctionTarget = techCtx.correctionTarget || null;
        const techName = displayTech.name || displayTech.email || '-';
        const techEmail = displayTech.email || '';
        const payTech = this.getPayTechnician(m);
        const payTechName = payTech.name || payTech.email || m.qa_paid_to_name || m.qa_paid_to_email || '-';
        const payTechEmail = payTech.email || m.qa_paid_to_email || '';
        const payBasisLabel = String(payTech.basis || m.technician_pay_basis || '').replace(/_/g, ' ');
        const qaName = m.qa_approved_by_name || m.qa_approved_by || '-';
        const qaEmail = m.qa_approved_by || '';
        const resName = m.resident?.name || '-';
        const resEmail = m.resident?.email || '';
        const resPhone = m.resident?.phone || '';
        const qaRejectCount = parseInt(m.qa_reject_count || '0', 10);
        const qaHistory = Array.isArray(m.qa_history) ? m.qa_history : [];
        const workHistory = Array.isArray(m.work_history) ? m.work_history : [];
        const delivery = (m.delivery && typeof m.delivery === 'object') ? m.delivery : {};
        const submissionFailure = (m.submission_failure && typeof m.submission_failure === 'object') ? m.submission_failure : {};
        const submissionEmailEvents = Array.isArray(m.email_events)
          ? m.email_events
          : (Array.isArray(delivery.email_events) ? delivery.email_events : []);
        const submissionFailureEvents = workHistory.filter((event) => {
          const eventName = String(event?.event || '').trim().toLowerCase();
          return eventName === 'submission_delivery_failed'
            || eventName === 'submission_delivery_enqueue_failed'
            || eventName === 'submission_delivery_retried_by_qa';
        });
        const timingSummary = this.buildProjectTimingSummary(m, true);
        const fmts = (ts) => ts ? this.fmtLocalShort(ts) : '\u2014';
        const fmtd = (ts) => ts ? this.fmtLocalDateTime(ts) : '\u2014';
        const ccArr = Array.isArray(m.cc_emails) ? m.cc_emails : [];
        const pinsArr = Array.isArray(m.pins) ? m.pins : [];
        const isFiller = !!m.is_filler;
        const isVip = !!m.is_vip;
        const isExpedited = !!m.is_expedited;
        const hasGutters = this.projectIncludesGutters(m);
        const resolvePriorityLevel = (project) => this.reportExpeditePriorityLevel(project);
        const priorityLevel = resolvePriorityLevel(m);
        const hardDeadlineAt = this.reportProductionDeadlineAt(m);
        const isTutorial = !!m.is_tutorial_instance;
        const cancellationInfo = (m.cancellation && typeof m.cancellation === 'object') ? m.cancellation : {};
        const cancellationRefundDecision = String(m.cancellation_refund_decision || cancellationInfo.refund_decision || '').toLowerCase();
        const cancellationRefundIssued = cancellationRefundDecision === 'refunded' || !!m.cancellation_refunded;
        const cancellationRefundAmount = m.cancellation_refund_amount ?? cancellationInfo.refund_amount ?? null;
        const cancellationRefundAt = m.cancellation_refund_at || cancellationInfo.refund_at || null;
        const cancellationRefundBy = m.cancellation_refund_by_name || cancellationInfo.refund_by_name || m.cancellation_refund_by_email || cancellationInfo.refund_by_email || '';
        const cancelledBy = m.cancelled_by_name || cancellationInfo.cancelled_by_name || m.cancelled_by_email || cancellationInfo.cancelled_by_email || '';
        const resubmissions = Array.isArray(m.resubmissions) ? m.resubmissions.filter(r => r && typeof r === 'object') : [];
        const refundIssued = status === 'cancelled' ? cancellationRefundIssued : !!m.refund_issued;
        const refundAmount = status === 'cancelled' ? cancellationRefundAmount : (m.refund_amount || null);
        const refundAt = status === 'cancelled' ? cancellationRefundAt : (m.refund_at || null);
        const techNotes = m.tech_notes || '';
        const canTogglePriorityFlag = !!cfg().flags?.is_queue_admin || !!(cfg().perms && cfg().perms.manage_queue);
        const canTogglePriority = !!cfg().user?.is_admin || !!cfg().flags?.is_queue_admin || !!(cfg().perms && cfg().perms.manage_qa_queue);
        const isManualPriority = !!m.qa_priority;
        const canSeeRefundDetails = !!(cfg().perms && cfg().perms.cancel_projects);
        let html = '';
        html += this.renderCustomerReworkSection(m, folderId, esc, fmtd);
        html += this.renderCustomerRejectionNotice(m, esc);

        // ── Overview ──
        const vipBadgeHtml = isVip
          ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#f9ab00;color:#fff;font-size:9px;font-weight:950;">⭐ VIP</span>'
          : '';
        const expeditedBadgeHtml = isExpedited
          ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#0f766e;color:#fff;font-size:9px;font-weight:950;">EXPEDITED</span>'
          : '';
        const queuePriorityBadgeHtml = `<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:${priorityLevel===1?'#d93025':(priorityLevel===2?'#e37400':'#5f6368')};color:#fff;font-size:9px;font-weight:950;">P${priorityLevel}</span>`;
        const guttersBadgeHtml = hasGutters
          ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#0f766e;color:#fff;font-size:9px;font-weight:950;"><i class="fas fa-water"></i> GUTTERS</span>'
          : '';
        const priorityBadgeHtml = isManualPriority
          ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#d93025;color:#fff;font-size:9px;font-weight:950;">📌 PRIORITY</span>'
          : '';
        const priorityFlagToggleHtml = canTogglePriorityFlag
          ? `<span class="pm-priority-flag-toggle" data-folder="${esc(folderId)}" aria-label="Project priority flag">
               <button type="button" class="${(!isVip && !isExpedited) ? 'active' : ''}" data-priority-flag="none">None</button>
               <button type="button" class="${isExpedited ? 'active expedited' : ''}" data-priority-flag="expedited"><i class="fas fa-bolt"></i> Expedited</button>
               <button type="button" class="${isVip ? 'active vip' : ''}" data-priority-flag="vip"><i class="fas fa-star"></i> VIP</button>
             </span>`
          : '';
        const priorityToggleHtml = canTogglePriority
          ? `<button id="pmPriorityToggleBtn" class="pm-vip-toggle ${isManualPriority ? 'active' : ''}" data-folder="${esc(folderId)}" data-priority="${isManualPriority ? '1' : '0'}" title="${isManualPriority ? 'Remove manual priority' : 'Mark as prioritized'}">
               <i class="fas ${isManualPriority ? 'fa-thumbtack' : 'fa-thumbtack'}"></i> ${isManualPriority ? 'Unprioritize' : 'Prioritize'}
             </button>`
          : '';
        const hasSubmissionFailure = status === 'submission_failed' || submissionStatus === 'submission_failed';
        const submissionFailureHtml = (() => {
          if (!hasSubmissionFailure) return '';
          const reason = submissionFailure.error || delivery.report_job_error || 'No detailed failure reason was recorded.';
          const failedAt = submissionFailure.failed_at || delivery.report_job_completed_at || '';
          const jobId = submissionFailure.delivery_job_id || delivery.report_job_id || '';
          const attempts = submissionFailure.attempts ?? delivery.report_job_attempt ?? null;
          const maxAttempts = delivery.report_job_max_attempts ?? null;
          const attemptLabel = attempts === null
            ? '\u2014'
            : `${attempts}${maxAttempts !== null ? ` of ${maxAttempts}` : ''}`;
          const recentEmailAttempts = submissionEmailEvents
            .filter((event) => event && typeof event === 'object' && String(event.type || '').toLowerCase() === 'report_email')
            .slice(-10)
            .reverse();
          const recentFailureEvents = submissionFailureEvents.slice(-10).reverse();
          const renderAttempt = (event) => {
            const eventError = event.error || event.message || event.postmark?.Message || (event.ok === true ? 'Sent successfully' : 'No provider response recorded');
            const http = event.http ?? event.status ?? event.postmark?.ErrorCode ?? null;
            const recipient = event.to || '';
            return `<div class="pm-submission-failure-event">
              <div class="pm-submission-failure-event-head">
                <span>${esc(fmtd(event.ts_utc || event.ts || event.at))}</span>
                <span class="${event.ok === true ? 'ok' : 'bad'}">${event.ok === true ? 'Succeeded' : 'Failed'}${http !== null ? ` \u00b7 ${esc(String(http))}` : ''}</span>
              </div>
              <div class="pm-submission-failure-event-error">${esc(eventError)}</div>
              ${recipient ? `<div class="pm-submission-failure-event-meta">Recipient: ${esc(recipient)}</div>` : ''}
            </div>`;
          };
          const renderHistoryEvent = (event) => {
            const label = String(event.event || '').replace(/_/g, ' ');
            const actor = event.qa_name || event.qa_email || '';
            const eventError = event.error || '';
            return `<div class="pm-submission-failure-history-row">
              <span>${esc(fmtd(event.ts || event.at))}</span>
              <strong>${esc(label)}</strong>
              ${actor ? `<span>${esc(actor)}</span>` : ''}
              ${eventError ? `<span class="bad">${esc(eventError)}</span>` : ''}
            </div>`;
          };
          return `<details class="pm-submission-failure">
            <summary>
              <span><i class="fas fa-triangle-exclamation"></i> Submission failure details</span>
              <span class="pm-submission-failure-summary-reason">${esc(reason)}</span>
            </summary>
            <div class="pm-submission-failure-body">
              <div class="pm-submission-failure-reason"><strong>Reason</strong><span>${esc(reason)}</span></div>
              <div class="pm-kv-grid three-col pm-submission-failure-meta">
                <div class="pm-kv-k">Failed At</div><div class="pm-kv-v">${esc(fmtd(failedAt))}</div>
                <div class="pm-kv-k">Attempts</div><div class="pm-kv-v">${esc(attemptLabel)}</div>
                <div class="pm-kv-k">Delivery Job</div><div class="pm-kv-v pm-monospace">${esc(jobId || '\u2014')}</div>
                <div class="pm-kv-k">Job Status</div><div class="pm-kv-v">${esc(delivery.report_job_status || submissionStatus || '\u2014')}</div>
              </div>
              ${recentEmailAttempts.length ? `<div class="pm-submission-failure-subhead">Recent delivery attempts</div>${recentEmailAttempts.map(renderAttempt).join('')}` : '<div class="pm-submission-failure-empty">No individual email attempts were recorded.</div>'}
              ${recentFailureEvents.length ? `<div class="pm-submission-failure-subhead">Submission history</div><div class="pm-submission-failure-history">${recentFailureEvents.map(renderHistoryEvent).join('')}</div>` : ''}
            </div>
          </details>`;
        })();
        html += `<div class="pm-section">
          <div class="pm-section-head">
            <i class="fas fa-circle-info" style="color:#1a73e8;"></i> Project Overview
            <span style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">${priorityToggleHtml}${priorityFlagToggleHtml}</span>
          </div>
          <div class="pm-kv-grid three-col">
            <div class="pm-kv-k">Status</div>
            <div class="pm-kv-v"><span class="pm-status-pill ${esc(statusPillClass)}">${esc(statusLabel)}</span>
              ${priorityBadgeHtml}
              ${vipBadgeHtml}
              ${expeditedBadgeHtml}
              ${guttersBadgeHtml}
              ${queuePriorityBadgeHtml}
              ${isFiller ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#555;color:#fff;font-size:9px;font-weight:950;">FILLER</span>' : ''}
              ${isTutorial ? '<span style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#673ab7;color:#fff;font-size:9px;font-weight:950;">TUTORIAL</span>' : ''}
            </div>
            <div class="pm-kv-k">Type</div>
            <div class="pm-kv-v">
              <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:6px;background:${typeColors[pType]||'#1a73e8'}14;border:1px solid ${typeColors[pType]||'#1a73e8'}44;font-weight:950;font-size:11px;color:${typeColors[pType]||'#1a73e8'};">${esc(typeLabels[pType]||pType)}</span>
            </div>
            <div class="pm-kv-k">Complexity</div>
            <div class="pm-kv-v">
              <div class="pm-complexity-line">
                <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:6px;background:${cxBg};border:1px solid ${cxColor}44;font-weight:950;font-size:11px;color:${cxColor};">${cxDots} ${cxLevel}/5</span>
                <span class="pm-complexity-points">${esc(this.formatProjectPoints(cxPoints))}</span>
                ${canManageComplexity ? `<button type="button" id="pmComplexityEditBtn" class="pm-icon-chip" title="Edit complexity"><i class="fas fa-pen"></i></button>` : ''}
              </div>
              ${canManageComplexity ? `
                <div id="pmComplexityEditor" class="pm-complexity-editor" hidden>
                  <div class="pm-complexity-controls">
                    <label>
                      <span>Level</span>
                      <select id="pmComplexitySelect">
                        ${[1,2,3,4,5].map(level => `<option value="${level}" ${level === cxLevel ? 'selected' : ''}>${level}/5 - ${esc(this.formatProjectPoints(this.complexityPointValue(level)))}</option>`).join('')}
                      </select>
                    </label>
                    <label>
                      <span>Reason</span>
                      <textarea id="pmComplexityReason" rows="3" placeholder="Required"></textarea>
                    </label>
                  </div>
                  <div class="pm-complexity-actions">
                    <button type="button" class="pm-small-btn" id="pmComplexityCancelBtn">Cancel</button>
                    <button type="button" class="pm-small-btn primary" id="pmComplexitySaveBtn"><i class="fas fa-check"></i> Save</button>
                  </div>
                </div>
              ` : ''}
            </div>
            <div class="pm-kv-k">QA Bounces</div>
            <div class="pm-kv-v"><span style="font-weight:950;color:${qaRejectCount>0?'#e65100':'#137333'};">${qaRejectCount}</span>${qaRejectCount>0?' <span style="font-size:10px;color:#999;">time'+(qaRejectCount>1?'s':'')+'</span>':''}</div>
            <div class="pm-kv-k">Team</div>
            <div class="pm-kv-v">${esc(m.team_id||'default')}</div>
            <div class="pm-kv-k">Folder ID</div>
            <div class="pm-kv-v"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:#f1f3f4;padding:2px 6px;border-radius:4px;user-select:all;">${esc(folderId||m.id)}</span></div>
          </div>
          ${submissionFailureHtml}
        </div>`;

        // ── Timeline ──
        html += `<div class="pm-section">
          <div class="pm-section-head"><i class="fas fa-clock" style="color:#f9ab00;"></i> Timeline</div>
          <div class="pm-kv-grid three-col">
            <div class="pm-kv-k">Created</div><div class="pm-kv-v">${esc(fmtd(m.created_at))}</div>
            <div class="pm-kv-k">Queued</div><div class="pm-kv-v">${esc(fmtd(m.queued_at||m.created_at))}</div>
            <div class="pm-kv-k">API Processed</div><div class="pm-kv-v">${esc(fmtd(m.processed_at))}</div>
            <div class="pm-kv-k">Work Started</div><div class="pm-kv-v">${esc(fmtd(m.started_at))}</div>
            <div class="pm-kv-k">Submitted for QA</div><div class="pm-kv-v">${esc(fmtd(m.uploaded_at))}</div>
            <div class="pm-kv-k">Completed</div><div class="pm-kv-v">${esc(fmtd(m.completed_at))}</div>
            ${hardDeadlineAt?`<div class="pm-kv-k">Hard Deadline</div><div class="pm-kv-v"><span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;background:#fef7e0;color:#b06000;border:1px solid #fdd663;font-weight:950;"><i class="fas fa-bolt"></i> ${esc(fmtd(hardDeadlineAt))}</span></div>`:''}
            ${m.rejected_at?`<div class="pm-kv-k">Rejected</div><div class="pm-kv-v">${esc(fmtd(m.rejected_at))}</div>`:''}
            ${m.cancelled_at?`<div class="pm-kv-k">Cancelled</div><div class="pm-kv-v">${esc(fmtd(m.cancelled_at))}</div>`:''}
          </div>
        </div>`;

        if (timingSummary) {
          const elapsed = timingSummary.elapsed;
          const band = timingSummary.activeBand;
          const bandRows = timingSummary.bands.map((b) => {
            const label = this.formatProjectTimerDuration(b.boundaryMs);
            return `<span class="qtag" style="background:${b.color}18;color:${b.color};border-color:${b.color}55;font-size:10px;font-weight:950;">${esc(label)} - &#8369;${esc(String(b.credit))}</span>`;
          }).join(' ');
          const creditDetail = timingSummary.baseCredit !== null
            ? `&#8369;${esc(String(timingSummary.baseCredit))}${timingSummary.rushBonus > 0 ? ` + &#8369;${esc(String(timingSummary.rushBonus))} rush (${esc(String(timingSummary.rushPercent))}%) = <strong>&#8369;${esc(String(timingSummary.totalCredit))}</strong>` : ''}`
            : '\u2014';
          const timerEndLabel = elapsed?.isOpen ? 'Timer Through' : 'Submitted / Stopped';
          html += `<div class="pm-section">
            <div class="pm-section-head"><i class="fas fa-stopwatch" style="color:#137333;"></i> Production Timing</div>
            <div class="pm-kv-grid three-col">
              <div class="pm-kv-k">Project Points</div><div class="pm-kv-v">${esc(this.formatProjectPoints(timingSummary.points))}</div>
              <div class="pm-kv-k">Allotted Time</div><div class="pm-kv-v">${esc(this.formatProjectTimerDuration(timingSummary.timeline.totalMs))}</div>
              <div class="pm-kv-k">Claimed / Started</div><div class="pm-kv-v">${esc(this.fmtProjectTimerDateMs(elapsed?.startMs))}</div>
              <div class="pm-kv-k">${esc(timerEndLabel)}</div><div class="pm-kv-v">${esc(this.fmtProjectTimerDateMs(elapsed?.endMs))}</div>
              <div class="pm-kv-k">Active Work Time</div><div class="pm-kv-v">${elapsed ? esc(this.formatProjectTimerDuration(elapsed.elapsedMs)) : '\u2014'}${elapsed?.isOpen ? ' <span style="color:#777;font-size:10px;font-weight:800;">so far</span>' : ''}</div>
              <div class="pm-kv-k">Credited Speed Tier</div><div class="pm-kv-v">${band ? `<span style="font-weight:950;color:${band.color};">${esc(band.label)} (${esc(String(band.rate))}/pt)</span>` : '\u2014'}</div>
              <div class="pm-kv-k">Speed Credit</div><div class="pm-kv-v">${creditDetail}</div>
              <div class="pm-kv-k">Allotted Bands</div><div class="pm-kv-v">${bandRows}</div>
            </div>
          </div>`;
        }

        // ── People ──
        if (resubmissions.length > 0) {
          html += `<div class="pm-section" style="border-color:#ffcc80;"><div class="pm-section-head"><i class="fas fa-rotate-left" style="color:#e37400;"></i> Reopened for Edits <span style="margin-left:auto;font-size:11px;color:#e37400;font-weight:900;">${resubmissions.length} time${resubmissions.length === 1 ? '' : 's'}</span></div>`;
          resubmissions.slice().reverse().forEach((entry, idx) => {
            const round = entry.round || (resubmissions.length - idx);
            const by = entry.reopened_by_name || entry.reopened_by_email || '-';
            const previousTech = entry.previous_assigned_to_name || entry.previous_assigned_to_email || '';
            const previousWorkSeconds = Number(entry.previous_work_seconds || 0);
            const images = Array.isArray(entry.images) ? entry.images.filter(img => img && (img.url || img.name)) : [];
            const entryClaims = Array.isArray(entry.claims) ? entry.claims : [];
            const topLevelClaims = Array.isArray(m.resubmission_claims) ? m.resubmission_claims.filter(claim => claim && String(claim.round || '') === String(round)) : [];
            const claims = (entryClaims.length ? entryClaims : topLevelClaims).filter(claim => claim && (claim.claimed_by_email || claim.claimed_by_name));
            const claimsHtml = claims.length
              ? `<div class="pm-qa-issue"><strong>Reclaimed By</strong><div style="display:grid;gap:4px;margin-top:6px;">${claims.map(claim => {
                  const claimName = claim.claimed_by_name || claim.claimed_by_email || '-';
                  const claimEmail = claim.claimed_by_email && claim.claimed_by_email !== claimName ? ` <span style="color:#5f6368;">${esc(claim.claimed_by_email)}</span>` : '';
                  const claimAt = claim.claimed_at ? ` <span style="color:#5f6368;">- ${esc(fmtd(claim.claimed_at))}</span>` : '';
                  return `<div>${esc(claimName)}${claimEmail}${claimAt}</div>`;
                }).join('')}</div></div>`
              : '';
            const imagesHtml = images.length
              ? `<div class="pm-qa-issue"><strong>Images</strong><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">${images.map(img => {
                  const src = img.url || this.fmUrl(`projects/${encodeURIComponent(folderId || m.id || '')}/artifacts/${encodeURIComponent(img.name || '')}`);
                  return `<a href="${esc(src)}" target="_blank" rel="noopener" style="display:block;width:86px;height:86px;border-radius:8px;overflow:hidden;border:1px solid #ffcc80;background:#fff;"><img src="${esc(src)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;"></a>`;
                }).join('')}</div></div>`
              : '';
            html += `<div class="pm-qa-bounce" style="border-color:#ffcc80;background:#fff8e1;">
              <div class="pm-qa-bounce-head">
                <div class="pm-qa-bounce-title" style="color:#e65100;"><i class="fas fa-rotate-left"></i> Resubmission #${esc(round)}</div>
                <div class="pm-qa-bounce-date">${esc(fmtd(entry.reopened_at))}</div>
              </div>
              <div class="pm-qa-issue"><strong>Completed Before Reopen</strong> - ${esc(fmtd(entry.completed_at))}</div>
              ${previousTech ? `<div class="pm-qa-issue"><strong>Previous Technician</strong> - ${esc(previousTech)}</div>` : ''}
              ${previousWorkSeconds > 0 ? `<div class="pm-qa-issue"><strong>Previous Work Timer</strong> - ${esc(this.fmtElapsed(previousWorkSeconds * 1000))}</div>` : ''}
              <div class="pm-qa-issue"><strong>Reopened By</strong> - ${esc(by)}</div>
              ${claimsHtml}
              ${entry.notes ? `<div class="pm-qa-issue"><strong>Notes</strong> - ${esc(entry.notes)}</div>` : ''}
              ${imagesHtml}
            </div>`;
          });
          html += `</div>`;
        }

        html += `<div class="pm-section">
          <div class="pm-section-head"><i class="fas fa-users" style="color:#7b1fa2;"></i> People</div>
          <div class="pm-people-row">
            <div class="pm-person-card"><div class="pm-person-role">Issuer / Customer</div><div class="pm-person-name">${esc(issuerName)}</div></div>
            <div class="pm-person-card"><div class="pm-person-role">Technician / Drafter</div><div class="pm-person-name">${esc(techName)}</div>${techEmail?`<div class="pm-person-email">${esc(techEmail)}</div>`:''}</div>
            <div class="pm-person-card"><div class="pm-person-role">Technician Pay To</div><div class="pm-person-name">${esc(payTechName)}</div>${payTechEmail?`<div class="pm-person-email">${esc(payTechEmail)}</div>`:''}${payBasisLabel?`<div class="pm-person-email" style="color:#5f6368;">Last touch: ${esc(payBasisLabel)}</div>`:''}</div>
            ${originalTech && (originalTech.email || originalTech.name) ? `<div class="pm-person-card"><div class="pm-person-role">Original Technician</div><div class="pm-person-name">${esc(originalTech.name || originalTech.email || '-')}</div>${originalTech.email ? `<div class="pm-person-email">${esc(originalTech.email)}</div>` : ''}</div>` : ''}
            ${correctionTarget && (correctionTarget.email || correctionTarget.name) && ((correctionTarget.email || '') !== (displayTech.email || '') || (correctionTarget.name || '') !== (displayTech.name || '')) ? `<div class="pm-person-card"><div class="pm-person-role">Correction Target</div><div class="pm-person-name">${esc(correctionTarget.name || correctionTarget.email || '-')}</div>${correctionTarget.email ? `<div class="pm-person-email">${esc(correctionTarget.email)}</div>` : ''}</div>` : ''}
            <div class="pm-person-card"><div class="pm-person-role">QA Reviewer</div><div class="pm-person-name">${esc(qaName)}</div>${qaEmail?`<div class="pm-person-email">${esc(qaEmail)}</div>`:''}</div>
            ${(resName&&resName!=='-')?`<div class="pm-person-card"><div class="pm-person-role">Resident</div><div class="pm-person-name">${esc(resName)}</div></div>`:''}
          </div>
        </div>`;

        if (techCtx.history.length > 0) {
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-user-clock" style="color:#1a73e8;"></i> Technician History <span style="margin-left:auto;font-size:11px;color:#666;font-weight:800;">${techCtx.history.length} tech${techCtx.history.length>1?'s':''}</span></div>`;
          techCtx.history.slice().reverse().forEach((entry, idx) => {
            const label = entry.name || entry.email || `Technician ${idx + 1}`;
            const badges = [];
            if (latestTech && (entry.email || entry.name) && (entry.email || entry.name) === (latestTech.email || latestTech.name)) badges.push('Most Recent');
            if (originalTech && (entry.email || entry.name) && (entry.email || entry.name) === (originalTech.email || originalTech.name)) badges.push('Original');
            if (entry.is_current_assignee) badges.push('Current Assignee');
            if (entry.is_correction_target) badges.push('Correction Target');
            const metrics = [];
            if (entry.claim_count) metrics.push(`${entry.claim_count} claim${entry.claim_count === 1 ? '' : 's'}`);
            if (entry.correction_count) metrics.push(`${entry.correction_count} correction${entry.correction_count === 1 ? '' : 's'}`);
            if (entry.sent_back_count) metrics.push(`${entry.sent_back_count} send-back${entry.sent_back_count === 1 ? '' : 's'}`);
            html += `<div class="pm-qa-bounce"><div class="pm-qa-bounce-head"><div class="pm-qa-bounce-title"><i class="fas fa-user-pen"></i> ${esc(label)}</div><div class="pm-qa-bounce-date">${esc(this.fmtLocalShort(entry.last_ts || entry.first_ts || ''))}</div></div>`;
            if (entry.email) html += `<div class="pm-qa-issue"><strong>Email</strong> — ${esc(entry.email)}</div>`;
            if (badges.length) html += `<div class="pm-qa-issue"><strong>Role</strong> — ${esc(badges.join(' • '))}</div>`;
            if (entry.first_ts) html += `<div class="pm-qa-issue"><strong>First Touch</strong> — ${esc(this.fmtLocalShort(entry.first_ts))}${entry.first_event ? ` (${esc(entry.first_event.replace(/_/g, ' '))})` : ''}</div>`;
            if (entry.last_ts) html += `<div class="pm-qa-issue"><strong>Last Touch</strong> — ${esc(this.fmtLocalShort(entry.last_ts))}${entry.last_event ? ` (${esc(entry.last_event.replace(/_/g, ' '))})` : ''}</div>`;
            if (metrics.length) html += `<div class="pm-qa-issue"><strong>Summary</strong> — ${esc(metrics.join(' • '))}</div>`;
            html += `</div>`;
          });
          html += `</div>`;
        }

        // ── Pins ──
        if (pinsArr.length > 1) {
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-share-nodes" style="color:#1a73e8;"></i> Pins</div><div class="pm-kv-grid">`;
          html += `<div class="pm-kv-k">Pins (${pinsArr.length})</div><div class="pm-kv-v" style="display:flex;flex-wrap:wrap;gap:4px;">`;
            pinsArr.forEach((pin, i) => { html += `<span style="padding:3px 8px;border-radius:6px;background:#e8f0fe;font-size:10px;font-weight:800;color:#1a73e8;">#${i+1}: ${Number(pin.lat||0).toFixed(5)}, ${Number(pin.lng||0).toFixed(5)}</span>`; });
            html += `</div>`;
          html += `</div></div>`;
        }

        // ── Tech Notes ──
        if (techNotes) {
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-sticky-note" style="color:#f9ab00;"></i> Tech Notes</div><div class="pm-tech-notes">${esc(techNotes)}</div></div>`;
        }

        // ── Refund ──
        if (canSeeRefundDetails && (m.refund_issued !== undefined || status === 'rejected_no_coverage' || status === 'rejected' || status === 'cancelled')) {
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-credit-card" style="color:#137333;"></i> Refund</div><div class="pm-kv-grid">
            <div class="pm-kv-k">Status</div><div class="pm-kv-v">${refundIssued?`<span class="pm-refund-badge refunded"><i class="fas fa-circle-check"></i> Refunded</span>`:`<span class="pm-refund-badge not-refunded"><i class="fas fa-circle-xmark"></i> Not refunded</span>`}</div>
            ${refundAmount ? `<div class="pm-kv-k">Amount</div><div class="pm-kv-v">$${esc(String(refundAmount))}</div>` : ''}
            ${refundAt ? `<div class="pm-kv-k">At</div><div class="pm-kv-v">${esc(fmtd(refundAt))}</div>` : ''}
            ${(status === 'cancelled' && cancellationRefundBy) ? `<div class="pm-kv-k">Handled By</div><div class="pm-kv-v">${esc(cancellationRefundBy)}</div>` : ''}
          </div></div>`;
        }

        if (status === 'cancelled') {
          html += `<div class="pm-section" style="border-color:#dadce0;"><div class="pm-section-head"><i class="fas fa-circle-xmark" style="color:#5f6368;"></i> Cancelled</div><div class="pm-kv-grid">
            ${cancelledBy ? `<div class="pm-kv-k">Cancelled By</div><div class="pm-kv-v">${esc(cancelledBy)}</div>` : ''}
            ${canSeeRefundDetails ? `<div class="pm-kv-k">Credit Decision</div><div class="pm-kv-v">${refundIssued ? 'Refunded during cancellation' : 'Cancelled without refund'}</div>` : ''}
          </div><div class="pm-tech-notes" style="background:#f1f3f4; border-color:#dadce0; color:#3c4043; margin-top:10px;">This project has been cancelled and is treated as a completed terminal state. It is read-only in the portal and cannot be opened in the editor.</div></div>`;
        }

        // ── QA Bounce History ──
        if (qaRejectCount > 0 && qaHistory.length > 0) {
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-rotate-left" style="color:#e65100;"></i> QA Bounce History <span style="margin-left:auto;font-size:11px;color:#e65100;font-weight:900;">${qaRejectCount} bounce${qaRejectCount>1?'s':''}</span></div>`;
          qaHistory.forEach((h, idx) => {
            const hDate = h.date ? this.fmtLocalShort(h.date) : '\u2014';
            const hInspector = h.inspector_name || h.inspector || '-';
            const failures = Array.isArray(h.failures) ? h.failures : [];
            html += `<div class="pm-qa-bounce"><div class="pm-qa-bounce-head"><div class="pm-qa-bounce-title"><i class="fas fa-rotate-left"></i> Bounce #${idx+1} by ${esc(hInspector)}</div><div class="pm-qa-bounce-date">${esc(hDate)}</div></div>`;
            if (failures.length > 0) {
              failures.forEach(f => { html += `<div class="pm-qa-issue"><strong>${esc(f.item||'Issue')}</strong>${f.notes?` — ${esc(f.notes)}`:''}${f.status?` <span style="color:#999;">(${esc(f.status)})</span>`:''}</div>`; });
            } else { html += `<div class="pm-qa-issue" style="color:#999;">No specific issues recorded</div>`; }
            html += `</div>`;
          });
          html += `</div>`;
        }

        // ── Rejection Request ──
        if (m.rejection_request && typeof m.rejection_request === 'object') {
          const rr = m.rejection_request;
          html += `<div class="pm-section" style="border-color:#f4b4ae;"><div class="pm-section-head"><i class="fas fa-circle-exclamation" style="color:#d93025;"></i> Rejection Request</div><div class="pm-kv-grid">
            <div class="pm-kv-k">By</div><div class="pm-kv-v">${esc(rr.requested_by_name||rr.requested_by||'-')}</div>
            <div class="pm-kv-k">At</div><div class="pm-kv-v">${esc(fmtd(rr.requested_at))}</div>
            <div class="pm-kv-k">Reasons</div><div class="pm-kv-v">${Array.isArray(rr.reasons)?rr.reasons.map(r=>esc(r)).join(', '):'\u2014'}</div>
            ${rr.notes?`<div class="pm-kv-k">Notes</div><div class="pm-kv-v">${esc(rr.notes)}</div>`:''}
            ${rr.reviewed?`<div class="pm-kv-k">Decision</div><div class="pm-kv-v"><span style="font-weight:950;color:${rr.review_decision==='confirmed'?'#b0261e':'#137333'};">${esc(rr.review_decision||'-')}</span></div>
            <div class="pm-kv-k">Reviewed By</div><div class="pm-kv-v">${esc(rr.reviewed_by_name||rr.reviewed_by||'-')}</div>
            ${rr.review_notes?`<div class="pm-kv-k">Review Notes</div><div class="pm-kv-v">${esc(rr.review_notes)}</div>`:''}`:''}
          </div></div>`;
        }

        // ── Work History Timeline ──
        if (workHistory.length > 0) {
          const eventLabels = {
            claimed_new:'Claimed from queue', claimed_correction:'Claimed correction',
            submitted_for_qa:'Submitted for QA', qa_claimed:'QA claimed',
            qa_claim_released:'QA claim released', qa_approved:'QA approved',
            qa_rejected:'QA rejected', qa_sent_back_to_tech:'QA sent back to tech',
            manager_sent_back_to_tech:'Manager sent back to tech', correction_submitted:'Correction submitted',
            rejected_no_coverage:'Rejected (no coverage)', rejection_requested:'Rejection requested',
            rejection_reviewed:'Rejection reviewed', credit_refunded:'Credit refunded',
            cancelled_project:'Project cancelled',
            project_reopened_for_edits:'Reopened for edits',
            complexity_changed:'Complexity changed',
            credit_refund_failed:'Refund failed', reserved_for_user:'Reserved',
            reservation_cleared:'Reservation cleared',
            marked_vip:'Marked VIP', unmarked_vip:'Removed VIP'
          };
          const RELEASE_WINDOW_MS = 120000;
          const hideIndices = new Set();
          const approvalTimestamps = [];
          for (let i = 0; i < workHistory.length; i++) {
            const ev = workHistory[i];
            if (!ev || typeof ev !== 'object') continue;
            if (String(ev.event || '') === 'qa_approved') {
              const t = this.safeParseTs(ev.ts);
              if (t) approvalTimestamps.push(t);
            }
          }
          if (approvalTimestamps.length > 0) {
            for (let i = 0; i < workHistory.length; i++) {
              const ev = workHistory[i];
              if (!ev || typeof ev !== 'object') continue;
              if (String(ev.event || '') !== 'qa_claim_released') continue;
              const t = this.safeParseTs(ev.ts);
              if (!t) continue;
              for (const at of approvalTimestamps) {
                if (t <= at && (at - t) <= RELEASE_WINDOW_MS) {
                  hideIndices.add(i);
                  break;
                }
              }
            }
          }
          const filteredHistory = workHistory.filter((ev, idx) => {
            if (hideIndices.has(idx)) return false;
            const evType = String(ev?.event || '');
            if (!canSeeRefundDetails && (evType === 'credit_refunded' || evType === 'credit_refund_failed')) return false;
            return true;
          });
          const stageBarHtml = this.buildStageBarHtml(m);
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-timeline" style="color:#555;"></i> Work History <span style="margin-left:auto;font-size:11px;color:#888;font-weight:800;">${filteredHistory.length} event${filteredHistory.length>1?'s':''}</span></div>`;
          html += stageBarHtml;
          html += `<div class="pm-timeline">`;
          filteredHistory.slice().reverse().forEach(ev => {
            if (!ev || typeof ev !== 'object') return;
            const evType = ev.event || 'unknown';
            const evLabel = eventLabels[evType] || evType.replace(/_/g, ' ');
            const evTs = ev.ts ? this.fmtLocalShort(ev.ts) : '\u2014';
            let detail = '';
            if (ev.worker_name||ev.worker_email) detail += (ev.worker_name||ev.worker_email)+' ';
            if (ev.qa_name||ev.qa_email) detail += (ev.qa_name||ev.qa_email)+' ';
            if (ev.by_name||ev.by_email) detail += (ev.by_name||ev.by_email)+' ';
            if (ev.via) detail += `(via ${ev.via}) `;
            if (ev.note && evType !== 'complexity_changed' && (canSeeRefundDetails || !['credit_refunded','credit_refund_failed','cancelled_project'].includes(evType))) detail += `\u2014 ${ev.note} `;
            if (ev.decision) detail += `Decision: ${ev.decision} `;
            if (ev.reject_count) detail += `(reject #${ev.reject_count}) `;
            if (ev.resubmission_round) detail += `(resubmission #${ev.resubmission_round}) `;
            if (evType === 'complexity_changed') {
              const beforeCx = ev.previous_complexity ?? ev.original_complexity ?? '-';
              const afterCx = ev.new_complexity ?? ev.complexity ?? '-';
              const beforePoints = ev.previous_point_value ?? ev.original_point_value ?? null;
              const afterPoints = ev.new_point_value ?? ev.point_value ?? null;
              detail += `Complexity ${beforeCx} -> ${afterCx}`;
              if (beforePoints !== null || afterPoints !== null) detail += `, points ${beforePoints ?? '-'} -> ${afterPoints ?? '-'}`;
              if (ev.reason) detail += ` Reason: ${ev.reason}`;
              detail += ' ';
            }
            if (ev.active_issues) detail += `${ev.active_issues} issues `;
            if (ev.delivery_mode === 'reserved_queue') detail += `(queued + reserved) `;
            if (ev.delivery_mode === 'manual_requeue') detail += `(manual requeue) `;
            if (ev.reserved_to_name||ev.reserved_to_email) detail += `\u2192 ${ev.reserved_to_name||ev.reserved_to_email} `;
            html += `<div class="pm-timeline-item ev-${esc(evType)}"><div class="pm-timeline-ts">${esc(evTs)}</div><div class="pm-timeline-event">${esc(evLabel)}</div>${detail.trim()?`<div class="pm-timeline-detail">${esc(detail.trim())}</div>`:''}</div>`;
          });
          html += `</div></div>`;
        }

        // ── Submission Sources ──
        const submissionSources = (fullData && fullData.app_metadata && Object.prototype.hasOwnProperty.call(fullData.app_metadata, 'submission_sources'))
          ? fullData.app_metadata.submission_sources
          : m.submission_sources;
        if (submissionSources && typeof submissionSources === 'object' && (
          submissionSources.notes ||
          (Array.isArray(submissionSources.images) && submissionSources.images.length > 0) ||
          submissionSources.submitted_at ||
          submissionSources.submitted_by
        )) {
          const ss = submissionSources;
          html += `<div class="pm-section"><div class="pm-section-head"><i class="fas fa-images" style="color:#1a73e8;"></i> Submission Sources</div><div class="pm-kv-grid">
            <div class="pm-kv-k">By</div><div class="pm-kv-v">${esc(ss.submitted_by||'-')}</div>
            <div class="pm-kv-k">At</div><div class="pm-kv-v">${esc(fmtd(ss.submitted_at))}</div>
            ${ss.notes?`<div class="pm-kv-k">Notes</div><div class="pm-kv-v">${esc(ss.notes)}</div>`:''}
            <div class="pm-kv-k">Images</div><div class="pm-kv-v">${Array.isArray(ss.images)?ss.images.length:0} attached</div>
          </div></div>`;
        }

        box.innerHTML = html;
        const qtools = document.getElementById('pmQueueToolsBox');
        const emailBox = document.getElementById('pmEmailBox');
        const insertBefore = qtools || emailBox || null;
        if (insertBefore) host.insertBefore(box, insertBefore);
        else host.appendChild(box);

        this.bindProjectComplexityControls(m, folderId, fullData);

        // Wire up project priority flag controls
        const vipBtn = null;
        const priorityBtn = document.getElementById('pmPriorityToggleBtn');
        document.querySelectorAll('.pm-priority-flag-toggle [data-priority-flag]').forEach((flagBtn) => {
          flagBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const nextFlag = flagBtn.dataset.priorityFlag || 'none';
            if (nextFlag === priorityFlag) return;
            const group = flagBtn.closest('.pm-priority-flag-toggle');
            const buttons = group ? Array.from(group.querySelectorAll('button')) : [flagBtn];
            buttons.forEach((btn) => { btn.disabled = true; });
            const origHtml = flagBtn.innerHTML;
            flagBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i>`;
            try {
              const res = await this.fmPost(`projects/${encodeURIComponent(folderId || '')}/priority-flag`, {
                priority_flag: nextFlag
              });
              if (!res || !res.success) {
                alert(res?.error || 'Failed to update priority flag.');
                return;
              }
              const updatedManifest = res.manifest || {};
              m.is_vip = !!updatedManifest.is_vip;
              m.is_expedited = !!updatedManifest.is_expedited;
              queueOverviewStore.invalidate();
              this.renderProjectModalComprehensive(m, folderId, fullData);
              try { await this.refreshQueueAdmin(true); } catch {}
              try { await this.fetchProjects(); } catch {}
            } catch {
              alert('Failed to update priority flag (network).');
            } finally {
              const freshGroup = document.querySelector('.pm-priority-flag-toggle');
              if (freshGroup) freshGroup.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
              if (document.body.contains(flagBtn)) flagBtn.innerHTML = origHtml;
            }
          });
        });
        if (vipBtn) {
          vipBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const currentVip = vipBtn.dataset.vip === '1';
            const newVip = !currentVip;
            vipBtn.disabled = true;
            const origHtml = vipBtn.innerHTML;
            vipBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving…`;
            try {
            const res = await this.fmPost(`projects/${encodeURIComponent(vipBtn.dataset.folder || '')}/vip`, {
              is_vip: newVip
            });
              if (!res || !res.success) {
                alert(res?.error || 'Failed to update VIP status.');
                return;
              }
              // Update local manifest state and re-render the modal section
              m.is_vip = newVip;
              this.renderProjectModalComprehensive(m, folderId, fullData);
              // Refresh queue view if open
              try { await this.refreshQueueAdmin(true); } catch {}
            } catch {
              alert('Failed to update VIP status (network).');
            } finally {
              // Button may be gone after re-render, guard
              const b = document.getElementById('pmVipToggleBtn');
              if (b) { b.disabled = false; b.innerHTML = origHtml; }
            }
          });
        }
        if (priorityBtn) {
          priorityBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            const currentPriority = priorityBtn.dataset.priority === '1';
            priorityBtn.disabled = true;
            const origHtml = priorityBtn.innerHTML;
            priorityBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving…`;
            try {
              const res = await this.fmPost(`projects/${encodeURIComponent(folderId || '')}/qa/priority`, {
                prioritized: !currentPriority
              });
              if (!res || !res.success) {
                alert(res?.error || 'Failed to update project priority.');
                return;
              }
              const updatedManifest = res.manifest || {};
              m.qa_priority = !!updatedManifest.qa_priority;
              m.qa_priority_at = updatedManifest.qa_priority_at || null;
              m.qa_priority_by_email = updatedManifest.qa_priority_by_email || '';
              m.qa_priority_by_name = updatedManifest.qa_priority_by_name || '';
              queueOverviewStore.invalidate();
              this.renderProjectModalComprehensive(m, folderId, fullData);
              try { await this.refreshQueueAdmin(true); } catch {}
              try { await this.fetchProjects(); } catch {}
            } catch {
              alert('Failed to update project priority (network).');
            } finally {
              const b = document.getElementById('pmPriorityToggleBtn');
              if (b) { b.disabled = false; b.innerHTML = origHtml; }
            }
          });
        }
    },

    bindProjectComplexityControls(manifest, folderId, fullData){
      const editBtn = document.getElementById('pmComplexityEditBtn');
      const editor = document.getElementById('pmComplexityEditor');
      const cancelBtn = document.getElementById('pmComplexityCancelBtn');
      const saveBtn = document.getElementById('pmComplexitySaveBtn');
      const select = document.getElementById('pmComplexitySelect');
      const reason = document.getElementById('pmComplexityReason');
      if (!editBtn || !editor || !saveBtn || !select || !reason) return;

      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        editor.hidden = !editor.hidden;
        if (!editor.hidden) reason.focus();
      });

      if (cancelBtn) {
        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          editor.hidden = true;
          reason.value = '';
          select.value = String(this.normalizeComplexity(manifest?.complexity));
          reason.classList.remove('invalid');
        });
      }

      saveBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextComplexity = parseInt(select.value, 10);
        const note = String(reason.value || '').trim();
        if (!note) {
          reason.focus();
          reason.classList.add('invalid');
          return;
        }
        reason.classList.remove('invalid');
        saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        editBtn.disabled = true;
        const originalHtml = saveBtn.innerHTML;
        saveBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving`;
        try {
          const res = await Portal.apiPost(cfg().endpoints.server || Portal.internalLegacyEndpoint(), {
            action: 'manager_complexity_override',
            actor: this.fmActor(),
            folder: folderId,
            complexity: String(nextComplexity),
            reason: note,
            notes: note
          }).catch(() => null);
          if (!res || !res.success) {
            alert(res?.error || 'Failed to update complexity.');
            return;
          }
          const updated = this.normalizeProjectManifest(res.manifest || res.project || {});
          Object.assign(manifest, updated);
          queueOverviewStore.invalidate();
          this.mineCache = { at: 0, projects: null };
          this.activeMineCache = { at: 0, projects: null };
          this.renderProjectModalComprehensive(manifest, folderId, fullData);
          try { await this.refreshQueueAdmin(true); } catch {}
          try { await this.fetchProjects(); } catch {}
        } catch {
          alert('Failed to update complexity (network).');
        } finally {
          const currentSave = document.getElementById('pmComplexitySaveBtn');
          const currentCancel = document.getElementById('pmComplexityCancelBtn');
          const currentEdit = document.getElementById('pmComplexityEditBtn');
          if (currentSave) { currentSave.disabled = false; currentSave.innerHTML = originalHtml; }
          if (currentCancel) currentCancel.disabled = false;
          if (currentEdit) currentEdit.disabled = false;
        }
      });
    },


    // -----------------------
    // Queue tools in Project Modal (NEW)
    // -----------------------
    ensureProjectModalQueueToolsUI(){
      if (document.getElementById('pmQueueToolsStyle')) return;
      const style = document.createElement('style');
      style.id = 'pmQueueToolsStyle';
      style.textContent = `.pm-qtools-card{margin-top:14px;border:1px solid #eee;border-radius:12px;padding:12px;background:#fff;}.pm-qtools-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}.pm-qtools-title{font-weight:950;font-size:12px;color:#444;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.3px;}.pm-qtools-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}.pm-qtools-btn{border-radius:10px;padding:9px 12px;font-weight:900;cursor:pointer;border:1px solid #ddd;background:#fff;color:#333;display:inline-flex;align-items:center;gap:8px;user-select:none;}.pm-qtools-btn.primary{border-color:#1a73e8;background:#1a73e8;color:#fff;}.pm-qtools-btn.danger{border-color:#f4b4ae;background:#fce8e6;color:#b0261e;}.pm-qtools-btn:disabled{opacity:.55;cursor:not-allowed;}.pm-qtools-select{min-width:260px;border:1px solid #ddd;border-radius:10px;padding:9px 10px;font-weight:800;background:#fff;color:#111;}.pm-qtools-small{margin-top:8px;font-size:11px;color:#777;font-weight:800;}.pm-qtools-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:950;border:1px solid #eee;background:#fafafa;color:#333;white-space:nowrap;}`;
      document.head.appendChild(style);
    },
    renderProjectModalQueueTools({ folderId, address, reservedToEmail, reservedToName, status, canManageQueue, canCancelProjects, canRejectNoCoverage, canReopenCompletedProject }){
      this.ensureProjectModalQueueToolsUI();
      const modal = document.getElementById('projModal');
      if (!modal) return;
      const gal = document.getElementById('pmGallery');
      const host = (gal && gal.parentElement) ? gal.parentElement : modal;
      let box = document.getElementById('pmQueueToolsBox');
      if (!box) { box = document.createElement('div'); box.id = 'pmQueueToolsBox'; box.className = 'pm-qtools-card'; host.appendChild(box); }
      const reservedDisplay = reservedToName || reservedToEmail || '';
      const reservedLabel = reservedDisplay ? `Reserved for ${Portal.escapeHtml(reservedDisplay)}` : `No reservation`;
      const normalizedStatus = String(status || '').toLowerCase();
      const isReservedKickback = !!reservedToEmail && ['correction_needed', 'requeue'].includes(normalizedStatus);
      const canForceRequeue = !!canManageQueue && !['completed','rejected','rejected_no_coverage','cancelled'].includes(normalizedStatus);
      const canCancelProject = !!canCancelProjects && !['completed','rejected','rejected_no_coverage','cancelled'].includes(normalizedStatus);
      const canRejectProject = !!canRejectNoCoverage && !['completed','rejected','rejected_no_coverage','cancelled','pending_rejection'].includes(normalizedStatus);
      const canReopenProject = !!canReopenCompletedProject && normalizedStatus === 'completed';
      box.innerHTML = `
        <div class="pm-qtools-head">
          <div class="pm-qtools-title"><i class="fas fa-screwdriver-wrench" style="color:#1a73e8;"></i> Project Actions</div>
          <span class="pm-qtools-pill" id="pmReservePill">${reservedLabel}</span>
        </div>
        ${isReservedKickback ? `<div class="pm-qtools-small" style="margin-bottom:10px;color:#174ea6;">This QA kickback is currently waiting for <strong>${Portal.escapeHtml(reservedDisplay)}</strong>. Clearing the reservation will send it back to manual routing.</div>` : ''}
        <div class="pm-qtools-row" id="pmQueueActionsRow">
          <select class="pm-qtools-select" id="pmReserveSelect" title="Reserve this project for a trained user"><option value="">Clear reservation</option><option value="_loading">Loading users…</option></select>
          <button class="pm-qtools-btn primary" id="pmReserveSaveBtn"><i class="fas fa-bookmark"></i> Save Reservation</button>
          <button class="pm-qtools-btn" id="pmForceRequeueBtn" ${canForceRequeue ? '' : 'disabled'}><i class="fas fa-rotate-left"></i> Force Re-Queue</button>
        </div>
        <div class="pm-qtools-small" id="pmQueueToolsNote">${canForceRequeue ? "Reserved jobs jump to the front for that user and are hidden from everyone else's queue. Force Re-Queue moves the project into re-queue and boots any active editor." : 'Completed, rejected, and cancelled jobs cannot be force re-queued.'}</div>
      `;
      const sel = document.getElementById('pmReserveSelect');
      const saveBtn = document.getElementById('pmReserveSaveBtn');
      const forceBtn = document.getElementById('pmForceRequeueBtn');
      const reservePill = document.getElementById('pmReservePill');
      const queueRow = document.getElementById('pmQueueActionsRow');
      const queueNote = document.getElementById('pmQueueToolsNote');
      if (!canManageQueue) {
        if (queueRow) queueRow.remove();
        if (queueNote) queueNote.remove();
        if (reservePill) reservePill.style.display = 'none';
      } else {
        this.populateReserveSelect(sel, reservedToEmail, reservedToName);
      }
      if (canCancelProjects) {
        box.insertAdjacentHTML('beforeend', `
          <div class="pm-qtools-row" ${canManageQueue ? 'style="margin-top:12px;"' : ''}>
            <button class="pm-qtools-btn danger" id="pmCancelProjectBtn" ${canCancelProject ? '' : 'disabled'}><i class="fas fa-ban"></i> Cancel Project</button>
          </div>
        `);
      }
      if (canRejectNoCoverage) {
        box.insertAdjacentHTML('beforeend', `
          <div class="pm-qtools-title" ${(canManageQueue || canCancelProjects) ? 'style="margin-top:14px;"' : ''}><i class="fas fa-circle-exclamation" style="color:#d93025;"></i> Coverage Rejection</div>
          <div class="pm-qtools-row" style="margin-top:8px;">
            <button class="pm-qtools-btn danger" id="pmRejectCoverageBtn" ${canRejectProject ? '' : 'disabled'}><i class="fas fa-circle-exclamation"></i> Reject (No Coverage)</button>
          </div>
        `);
      }
      if (canReopenCompletedProject) {
        box.insertAdjacentHTML('beforeend', `
          <div class="pm-qtools-title" ${(canManageQueue || canCancelProjects || canRejectNoCoverage) ? 'style="margin-top:14px;"' : ''}><i class="fas fa-pen-to-square" style="color:#e37400;"></i> Completed Project</div>
          <div class="pm-qtools-row" style="margin-top:8px;">
            <button class="pm-qtools-btn" id="pmReopenProjectBtn" ${canReopenProject ? '' : 'disabled'}><i class="fas fa-rotate-left"></i> Reopen for Edits</button>
          </div>
          <div class="pm-qtools-small">Requires admin notes. This sends the project back to the unassigned queue and resets the work/payment timer for the next technician.</div>
        `);
      }
      const cancelBtn = document.getElementById('pmCancelProjectBtn');
      const rejectCoverageBtn = document.getElementById('pmRejectCoverageBtn');
      const reopenBtn = document.getElementById('pmReopenProjectBtn');
      if (saveBtn) {
        saveBtn.onclick = async () => {
          const v = (sel && sel.value) ? String(sel.value) : '';
          if (v === '_loading') return;
          saveBtn.disabled = true; const orig = saveBtn.innerHTML; saveBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Saving…`;
          try {
            const res = v
              ? await this.fmPost(`projects/${encodeURIComponent(folderId)}/queue/reserve`, { reserved_for: { email: v } })
              : await this.fmPost(`projects/${encodeURIComponent(folderId)}/queue/release-reservation`, {});
            if (!res || !res.success) { alert(res?.error || 'Reservation failed.'); return; }
            const pill = document.getElementById('pmReservePill');
            const newEmail = res.reserved_to_email || ''; const newName = res.reserved_to_name || '';
            if (pill) pill.textContent = newEmail ? `Reserved for ${newName || newEmail}` : `No reservation`;
            if (sel) sel.value = newEmail;
            try { await this.refreshQueueAdmin(true); } catch {} try { await this.refreshQueueButton(true); } catch {}
          } catch { alert('Reservation failed (network).'); }
          finally { saveBtn.disabled = false; saveBtn.innerHTML = orig; }
        };
      }
      if (forceBtn && canForceRequeue) {
        forceBtn.onclick = async () => {
          if (!confirm('Force this project into re-queue? Any active editor on it will be booted out.')) return;
          forceBtn.disabled = true;
          const orig = forceBtn.innerHTML;
          forceBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Re-Queueingâ€¦`;
          try {
            const res = await this.fmPost(`projects/${encodeURIComponent(folderId)}/requeue/force`, {});
            if (!res || !res.success) { alert(res?.error || 'Force re-queue failed.'); return; }
            const pill = document.getElementById('pmReservePill');
            if (pill) pill.textContent = 'No reservation';
            if (sel) sel.value = '';
            try { await this.refreshQueueAdmin(true); } catch {}
            try { await this.refreshQueueButton(true); } catch {}
            if (res?.message) alert(res.message);
            this.openProjectModal(folderId).catch(() => {});
          } catch { alert('Force re-queue failed (network).'); }
          finally { forceBtn.disabled = false; forceBtn.innerHTML = orig; }
        };
      }
      if (cancelBtn && canCancelProject) {
        cancelBtn.onclick = async () => {
          this.openCancelProjectModal(folderId, address || folderId);
        };
      }
      if (rejectCoverageBtn && canRejectProject) {
        rejectCoverageBtn.onclick = () => {
          this.openRejectModal(folderId, address || folderId);
        };
      }
      if (reopenBtn && canReopenProject) {
        reopenBtn.onclick = () => this.openReopenProjectModal(folderId, address || folderId);
      }
    },
    populateReserveSelect(selectEl, reservedToEmail, reservedToName=''){
      if (!selectEl) return;
      const users = Array.isArray(this.queueAssignableUsers) ? this.queueAssignableUsers : null;
      const currentEmail = (reservedToEmail || '').toLowerCase().trim();
      const currentName = String(reservedToName || '').trim();
      if (!users) { selectEl.innerHTML = `<option value="">Clear reservation</option><option value="_loading">Loading users…</option>`; selectEl.value = '_loading'; return; }
      const opts = [`<option value="">Clear reservation</option>`];
      const seen = new Set();
      users.forEach(u => {
        const email = String(u.email || '').toLowerCase().trim();
        if (!email) return;
        seen.add(email);
        const name = String(u.name || '').trim();
        const label = name ? `${name} (${email})` : email;
        opts.push(`<option value="${Portal.escapeHtml(email)}">${Portal.escapeHtml(label)}</option>`);
      });
      if (currentEmail && !seen.has(currentEmail)) {
        const currentLabel = currentName ? `${currentName} (${currentEmail})` : currentEmail;
        opts.splice(1, 0, `<option value="${Portal.escapeHtml(currentEmail)}">${Portal.escapeHtml(currentLabel)}</option>`);
      }
      selectEl.innerHTML = opts.join('');
      selectEl.value = currentEmail;
    },
    ensureSearchStyle(){
      if (document.getElementById('projectSearchStyle')) return;
      const style = document.createElement('style');
      style.id = 'projectSearchStyle';
      style.textContent = `
        .project-search-bar {
          display: flex; align-items: center; gap: 10px;
          margin: 12px 0 6px; width: 100%;
        }
        .project-search-bar .search-input-wrap {
          position: relative; flex: 1; max-width: 420px;
        }
        .project-search-bar .search-input-wrap i.search-icon {
          position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
          color: #999; font-size: 13px; pointer-events: none;
        }
        .project-search-bar input[type="text"] {
          width: 100%; padding: 9px 12px 9px 36px;
          border: 1px solid #dadce0; border-radius: 10px;
          font-size: 13px; font-weight: 700; color: #333; background: #fff;
          outline: none; transition: border-color .15s ease, box-shadow .15s ease;
          box-sizing: border-box;
        }
        .project-search-bar input[type="text"]:focus {
          border-color: #1a73e8; box-shadow: 0 0 0 3px rgba(26,115,232,.12);
        }
        .project-search-bar input[type="text"]::placeholder { color: #aaa; font-weight: 600; }
        .project-search-bar .search-clear-btn {
          position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
          border: none; background: none; color: #999; cursor: pointer;
          padding: 4px; font-size: 12px; display: none;
        }
        .project-search-bar .search-clear-btn.visible { display: block; }
        .project-search-bar .search-status {
          font-size: 11px; font-weight: 800; color: #888; white-space: nowrap;
        }
        .project-search-bar .search-status.active { color: #1a73e8; }
      `;
      document.head.appendChild(style);
    },
    async ensureQueueAssignableUsersLoaded(){
      const now = Date.now();
      if (this.queueAssignableUsers && (now - (this.queueAssignableUsersAt || 0)) < 30000) return;
      const res = await Portal.apiPost(cfg().endpoints.server, { action: 'queue_live_trained_users' }).catch(()=>null);
      if (!res || !res.success) { this.queueAssignableUsers = []; this.queueAssignableUsersAt = now; return; }
      this.queueAssignableUsers = Array.isArray(res.users) ? res.users : [];
      this.queueAssignableUsersAt = now;
      const sel = document.getElementById('pmReserveSelect');
      if (sel) { const current = sel.value && sel.value !== '_loading' ? sel.value : ''; this.populateReserveSelect(sel, current); }
    },
    ensureEnhancedModalStyle(){
      if (document.getElementById('enhancedModalStyle')) return;
      const style = document.createElement('style');
      style.id = 'enhancedModalStyle';
      style.textContent = `
      .pm-vip-toggle {
          display: inline-flex; align-items: center; gap: 5px;
          border-radius: 999px; padding: 5px 12px;
          font-size: 10px; font-weight: 950;
          border: 1px solid #e0e0e0; background: #fafafa; color: #777;
          cursor: pointer; user-select: none; transition: all .15s ease;
        }
        .pm-vip-toggle:hover { border-color: #f9ab00; color: #e37400; background: #fff8e1; }
        .pm-vip-toggle.active { border-color: #f9ab00; background: #f9ab00; color: #fff; }
        .pm-vip-toggle.active:hover { background: #e37400; border-color: #e37400; }
        .pm-vip-toggle:disabled { opacity: .5; cursor: not-allowed; }
        .pm-priority-flag-toggle { display:inline-flex; align-items:center; border:1px solid #e0e0e0; border-radius:999px; overflow:hidden; background:#fafafa; }
        .pm-priority-flag-toggle button { border:0; border-right:1px solid #e6e6e6; background:#fafafa; color:#666; padding:5px 10px; font-size:10px; font-weight:950; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
        .pm-priority-flag-toggle button:last-child { border-right:0; }
        .pm-priority-flag-toggle button:hover { background:#f1f3f4; color:#333; }
        .pm-priority-flag-toggle button.active { background:#444; color:#fff; }
        .pm-priority-flag-toggle button.active.expedited { background:#0f766e; }
        .pm-priority-flag-toggle button.active.vip { background:#f9ab00; }
        .pm-priority-flag-toggle button:disabled { opacity:.55; cursor:not-allowed; }
        .pm-timeline-item.ev-marked_vip::before { background: #f9ab00; }
        .pm-timeline-item.ev-unmarked_vip::before { background: #9aa0a6; }
        #projModal .modal-body { height: 100%; min-height: 0; }
        #projModal .proj-layout { height: 100%; min-height: 0; }
        #projModal .proj-gallery { display: flex; flex-direction: column; min-height: 0; }
        #projModal .gallery-grid { flex: 1; align-content: start; }
        #projModal .gallery-grid.pm-gallery-loading { display: block; min-height: 100%; }
        #projModal .modal-box, #projModal .modal-content,
        #projModal > div, .modal-content {
          width: 90vw !important;
        }
        #projModal .pm-project-nav {
          position: fixed;
          top: 50%;
          transform: translateY(-50%);
          z-index: 100000;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 1px solid rgba(60,64,67,.18);
          background: rgba(255,255,255,.96);
          color: #202124;
          box-shadow: 0 10px 30px rgba(60,64,67,.18);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform .14s ease, box-shadow .14s ease, background .14s ease, opacity .14s ease;
        }
        #projModal .pm-project-nav:hover:not(:disabled) {
          transform: translateY(-50%) scale(1.04);
          background: #fff;
          box-shadow: 0 14px 36px rgba(60,64,67,.22);
        }
        #projModal .pm-project-nav:focus-visible {
          outline: 3px solid rgba(26,115,232,.28);
          outline-offset: 3px;
        }
        #projModal .pm-project-nav:disabled,
        #projModal .pm-project-nav.disabled {
          opacity: .32;
          cursor: default;
          box-shadow: none;
        }
        #projModal .pm-project-nav-prev { left: clamp(10px, 3vw, 44px); }
        #projModal .pm-project-nav-next { right: clamp(10px, 3vw, 44px); }
        #projModal .pm-project-nav i { font-size: 18px; line-height: 1; }
        @media (max-width: 760px) {
          #projModal .pm-project-nav {
            width: 40px;
            height: 40px;
            top: auto;
            bottom: 18px;
            transform: none;
          }
          #projModal .pm-project-nav:hover:not(:disabled) { transform: scale(1.03); }
          #projModal .pm-project-nav-prev { left: 16px; }
          #projModal .pm-project-nav-next { right: 16px; }
        }
        .pm-section {
          margin-top: 16px; border: 1px solid #eee;
          border-radius: 12px; padding: 14px; background: #fff;
        }
        .pm-customer-rework-section {
          border-color: #d7b7ff;
          background: #fbf7ff;
          box-shadow: 0 8px 24px rgba(123,31,162,0.08);
        }
        .pm-rejection-notice {
          border-color: #f4b4ae;
          background: #fff7f6;
          box-shadow: 0 8px 24px rgba(217,48,37,0.08);
        }
        .pm-rejection-title {
          color: #7a1b18;
          font-size: 13px;
          font-weight: 950;
          margin-bottom: 7px;
        }
        .pm-rejection-copy {
          color: #202124;
          font-size: 12px;
          font-weight: 750;
          line-height: 1.45;
        }
        .pm-rejection-refund {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          margin-top: 10px;
          border: 1px solid #c8e6c9;
          background: #e6f4ea;
          color: #137333;
          border-radius: 8px;
          padding: 7px 10px;
          font-size: 11px;
          font-weight: 950;
        }
        .pm-rejection-action {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 12px;
          border-radius: 9px;
          padding: 9px 12px;
          background: #d93025;
          color: #fff;
          font-size: 12px;
          font-weight: 950;
          text-decoration: none;
        }
        .pm-rework-count {
          margin-left: auto;
          font-size: 11px;
          color: #7b1fa2;
          font-weight: 950;
        }
        .pm-rework-card {
          border: 1px solid #e9d7ff;
          border-radius: 10px;
          padding: 12px;
          background: #fff;
          margin-top: 10px;
        }
        .pm-rework-card.latest {
          border-color: #7b1fa2;
          box-shadow: inset 4px 0 0 #7b1fa2;
        }
        .pm-rework-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 8px;
        }
        .pm-rework-title {
          display: flex;
          align-items: center;
          gap: 7px;
          color: #5e1681;
          font-size: 13px;
          font-weight: 950;
        }
        .pm-rework-date {
          color: #5f6368;
          font-size: 10px;
          font-weight: 800;
          text-align: right;
          line-height: 1.35;
        }
        .pm-rework-lead {
          color: #3c4043;
          font-size: 12px;
          font-weight: 950;
          margin-bottom: 8px;
        }
        .pm-rework-notes {
          white-space: pre-wrap;
          color: #202124;
          background: #f8f3ff;
          border: 1px solid #eadcff;
          border-radius: 8px;
          padding: 10px;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.45;
        }
        .pm-rework-pins {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 10px;
        }
        .pm-rework-pin {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #d7b7ff;
          background: #f3e8ff;
          color: #5e1681;
          border-radius: 999px;
          padding: 5px 9px;
          font-size: 10px;
          font-weight: 950;
        }
        .pm-rework-images {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 10px;
        }
        .pm-rework-images a {
          width: 92px;
          height: 92px;
          display: block;
          overflow: hidden;
          border-radius: 8px;
          border: 1px solid #d7b7ff;
          background: #fff;
        }
        .pm-rework-images img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .pm-section-head {
          display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
          font-weight: 950; font-size: 12px; color: #444;
          text-transform: uppercase; letter-spacing: .3px;
        }
        .pm-section-head i { font-size: 13px; }
        .pm-kv-grid {
          display: grid; grid-template-columns: 140px 1fr;
          gap: 7px 14px; font-size: 12px;
        }
        .pm-kv-grid.three-col { grid-template-columns: 140px 1fr 140px 1fr; }
        @media (max-width: 700px) {
          .pm-kv-grid.three-col { grid-template-columns: 140px 1fr; }
        }
        .pm-kv-k {
          color: #777; font-weight: 900; text-transform: uppercase;
          letter-spacing: .3px; font-size: 10px; padding-top: 2px;
        }
        .pm-kv-v { color: #111; font-weight: 700; word-break: break-word; }
        .pm-monospace { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
        .pm-submission-failure {
          margin-top: 14px; border: 1px solid #f4b4ae; border-radius: 10px;
          background: #fff8f7; overflow: hidden;
        }
        .pm-submission-failure > summary {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 11px 13px; color: #b3261e; cursor: pointer; font-size: 11px;
          font-weight: 950; list-style-position: inside;
        }
        .pm-submission-failure > summary:hover { background: #fce8e6; }
        .pm-submission-failure > summary > span:first-child { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
        .pm-submission-failure-summary-reason { color: #7f1d1d; font-weight: 800; text-align: right; overflow-wrap: anywhere; }
        .pm-submission-failure-body { border-top: 1px solid #f4b4ae; padding: 13px; }
        .pm-submission-failure-reason {
          display: grid; grid-template-columns: 90px 1fr; gap: 10px; margin-bottom: 13px;
          padding: 10px; border-radius: 8px; background: #fce8e6; color: #7f1d1d;
          font-size: 12px; overflow-wrap: anywhere;
        }
        .pm-submission-failure-meta { margin-bottom: 14px; }
        .pm-submission-failure-subhead {
          margin: 14px 0 7px; color: #5f6368; font-size: 10px; font-weight: 950;
          letter-spacing: .3px; text-transform: uppercase;
        }
        .pm-submission-failure-event {
          padding: 9px 10px; margin-top: 6px; border: 1px solid #ead1ce;
          border-radius: 8px; background: #fff; font-size: 11px;
        }
        .pm-submission-failure-event-head { display: flex; justify-content: space-between; gap: 10px; color: #5f6368; font-weight: 800; }
        .pm-submission-failure-event-error { margin-top: 4px; color: #202124; font-weight: 900; overflow-wrap: anywhere; }
        .pm-submission-failure-event-meta { margin-top: 3px; color: #777; overflow-wrap: anywhere; }
        .pm-submission-failure .bad { color: #b3261e; }
        .pm-submission-failure .ok { color: #137333; }
        .pm-submission-failure-history { display: grid; gap: 5px; }
        .pm-submission-failure-history-row {
          display: grid; grid-template-columns: minmax(135px, auto) minmax(180px, 1fr) minmax(0, 1fr);
          gap: 8px; padding: 7px 9px; border-radius: 7px; background: #fff; font-size: 10px;
          overflow-wrap: anywhere;
        }
        .pm-submission-failure-empty { color: #777; font-size: 11px; font-style: italic; }
        @media (max-width: 700px) {
          .pm-submission-failure > summary { align-items: flex-start; flex-direction: column; }
          .pm-submission-failure-summary-reason { text-align: left; }
          .pm-submission-failure-history-row { grid-template-columns: 1fr; }
        }
        .pm-status-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 10px; border-radius: 999px;
          font-size: 11px; font-weight: 950; border: 1px solid;
        }
        .pm-status-pill.completed { background:#e6f4ea; color:#137333; border-color:#c8e6c9; }
        .pm-status-pill.submitting { background:#e8f0fe; color:#1a73e8; border-color:#d2e3fc; }
        .pm-status-pill.processing, .pm-status-pill.in_progress { background:#e8f0fe; color:#1a73e8; border-color:#d2e3fc; }
        .pm-status-pill.awaiting_review { background:#fff8e1; color:#e37400; border-color:#ffe0b2; }
        .pm-status-pill.queued, .pm-status-pill.ready { background:#fce8e6; color:#d93025; border-color:#f4b4ae; }
    .pm-status-pill.correction_needed, .pm-status-pill.requeue { background:#fff3e0; color:#e65100; border-color:#ffcc80; }
        .pm-status-pill.submission_failed { background:#b3261e; color:#fff; border-color:#7f1d1d; }
        .pm-status-pill.rejected_no_coverage, .pm-status-pill.rejected { background:#fce8e6; color:#b0261e; border-color:#f4b4ae; }
        .pm-status-pill.cancelled { background:#f1f3f4; color:#3c4043; border-color:#dadce0; }
        .pm-status-pill.pending_rejection { background:#fce8e6; color:#b0261e; border-color:#f4b4ae; }
        .pm-people-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .pm-person-card {
          flex: 1; min-width: 180px; border: 1px solid #eee;
          border-radius: 10px; padding: 10px 12px; background: #fafafa;
        }
        .pm-person-role {
          font-size: 10px; font-weight: 900; color: #999;
          text-transform: uppercase; letter-spacing: .4px; margin-bottom: 4px;
        }
        .pm-person-name { font-size: 13px; font-weight: 900; color: #111; }
        .pm-person-email { font-size: 11px; font-weight: 700; color: #1a73e8; word-break: break-all; }
        .pm-qa-bounce {
          border: 1px solid #ffcc80; border-radius: 10px;
          padding: 10px 12px; background: #fff8e1; margin-bottom: 8px;
        }
        .pm-qa-bounce-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px; margin-bottom: 6px;
        }
        .pm-qa-bounce-title {
          font-size: 12px; font-weight: 950; color: #e65100;
          display: flex; align-items: center; gap: 6px;
        }
        .pm-qa-bounce-date { font-size: 10px; font-weight: 800; color: #999; }
        .pm-qa-issue {
          font-size: 11px; font-weight: 700; color: #333;
          padding: 4px 0; border-bottom: 1px solid #ffe0b2;
        }
        .pm-qa-issue:last-child { border-bottom: none; }
        .pm-timeline { position: relative; padding-left: 20px; }
        .pm-timeline::before {
          content: ''; position: absolute; left: 6px; top: 4px; bottom: 4px;
          width: 2px; background: #e0e0e0; border-radius: 2px;
        }
        .pm-timeline-item { position: relative; padding: 6px 0 6px 16px; font-size: 11px; }
        .pm-timeline-item::before {
          content: ''; position: absolute; left: -17px; top: 10px;
          width: 8px; height: 8px; border-radius: 50%;
          background: #dadce0; border: 2px solid #fff;
        }
        .pm-timeline-item.ev-claimed_new::before,
        .pm-timeline-item.ev-claimed_correction::before { background: #1a73e8; }
        .pm-timeline-item.ev-submitted_for_qa::before { background: #f9ab00; }
        .pm-timeline-item.ev-qa_approved::before { background: #34a853; }
        .pm-timeline-item.ev-qa_rejected::before,
        .pm-timeline-item.ev-qa_sent_back_to_tech::before,
        .pm-timeline-item.ev-manager_sent_back_to_tech::before { background: #d93025; }
        .pm-timeline-item.ev-correction_submitted::before { background: #e37400; }
        .pm-timeline-item.ev-qa_claimed::before { background: #7b1fa2; }
        .pm-timeline-item.ev-rejected_no_coverage::before { background: #b0261e; }
        .pm-timeline-item.ev-credit_refunded::before { background: #137333; }
        .pm-timeline-item.ev-complexity_changed::before { background: #e37400; }
        .pm-timeline-ts { font-weight: 800; color: #999; font-size: 10px; }
        .pm-timeline-event { font-weight: 900; color: #333; }
        .pm-timeline-detail { font-weight: 700; color: #666; font-size: 10px; }
        .pm-complexity-line { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .pm-complexity-points {
          display:inline-flex; align-items:center; padding:3px 8px;
          border-radius:999px; border:1px solid #e8eaed; background:#f8f9fa;
          color:#5f6368; font-size:10px; font-weight:950;
        }
        .pm-icon-chip {
          width:24px; height:24px; border-radius:999px; border:1px solid #dadce0;
          display:inline-flex; align-items:center; justify-content:center;
          background:#fff; color:#5f6368; cursor:pointer; font-size:10px;
        }
        .pm-icon-chip:hover { border-color:#1a73e8; color:#1a73e8; background:#e8f0fe; }
        .pm-icon-chip:disabled { opacity:.55; cursor:not-allowed; }
        .pm-complexity-editor {
          margin-top:10px; padding:10px; border:1px solid #ffcc80;
          border-radius:10px; background:#fff8e1;
        }
        .pm-complexity-controls { display:grid; gap:8px; }
        .pm-complexity-controls label { display:grid; gap:4px; }
        .pm-complexity-controls label span {
          font-size:10px; font-weight:950; color:#8a4b00;
          text-transform:uppercase; letter-spacing:.3px;
        }
        .pm-complexity-controls select,
        .pm-complexity-controls textarea {
          width:100%; box-sizing:border-box; border:1px solid #e0b96f;
          border-radius:8px; padding:8px 9px; font:inherit; font-size:12px;
          background:#fff; color:#111;
        }
        .pm-complexity-controls textarea.invalid { border-color:#d93025; background:#fce8e6; }
        .pm-complexity-actions {
          display:flex; justify-content:flex-end; gap:8px; margin-top:8px;
        }
        .pm-small-btn {
          display:inline-flex; align-items:center; gap:6px; border:1px solid #dadce0;
          border-radius:8px; background:#fff; color:#333; padding:7px 10px;
          font-size:11px; font-weight:950; cursor:pointer;
        }
        .pm-small-btn.primary { background:#1a73e8; border-color:#1a73e8; color:#fff; }
        .pm-small-btn:disabled { opacity:.55; cursor:not-allowed; }
        .pm-tech-notes {
          background: #f8f9fa; border: 1px solid #eee; border-radius: 8px;
          padding: 10px; font-size: 12px; font-weight: 700; color: #333;
          white-space: pre-wrap; line-height: 1.45; max-height: 200px; overflow-y: auto;
        }
        .pm-refund-badge {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 5px 10px; border-radius: 8px; font-size: 11px; font-weight: 900;
        }
        .pm-refund-badge.refunded { background:#e6f4ea; color:#137333; border:1px solid #c8e6c9; }
        .pm-refund-badge.not-refunded { background:#fce8e6; color:#b0261e; border:1px solid #f4b4ae; }
        .pm-loading-panel {
          border: 1px solid #e8eaed; border-radius: 14px; background: #fafbff;
          padding: 18px; display: flex; flex-direction: column; gap: 12px;
          min-height: 100%; height: 100%; width: 100%; box-sizing: border-box; justify-content: center;
        }
        .pm-loading-error {
          background: #fce8e6; border-color: #f1b7b2;
        }
        .pm-loading-head {
          display: flex; align-items: center; gap: 10px;
          color: #1a73e8; font-size: 14px; font-weight: 900;
        }
        .pm-loading-error .pm-loading-head { color: #b3261e; }
        .pm-loading-copy {
          color: #5f6368; font-size: 12px; font-weight: 700; line-height: 1.4;
        }
        .pm-loading-skeletons {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px;
        }
        .pm-skeleton-card {
          height: 110px; border-radius: 12px; border: 1px solid #e3e7ef;
          background: linear-gradient(90deg, #eef2f7 0%, #f8faff 50%, #eef2f7 100%);
          background-size: 200% 100%;
          animation: pmSkeletonPulse 1.25s ease-in-out infinite;
        }
        @keyframes pmSkeletonPulse {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `;
      document.head.appendChild(style);
    },
      
    ensureStageBarStyle(){
        if (document.getElementById('stageBarStyle')) return;
        const style = document.createElement('style');
        style.id = 'stageBarStyle';
        style.textContent = `
            .pm-stagebar {
              display: flex; align-items: stretch;
              border-radius: 10px; overflow: hidden;
              border: 1px solid #e0e0e0;
              margin-bottom: 14px;
              min-height: 48px;
            }
            .pm-stage {
              flex: 1; display: flex; flex-direction: column;
              align-items: center; justify-content: center;
              padding: 7px 6px; position: relative;
              transition: background .2s ease;
              min-width: 0;
            }
            .pm-stage + .pm-stage { border-left: 1px solid rgba(0,0,0,.08); }
            .pm-stage.done    { background: #e6f4ea; }
            .pm-stage.current { background: #fff8e1; }
            .pm-stage.future  { background: #f5f5f5; }
            .pm-stage-name {
              font-size: 9px; font-weight: 950; text-transform: uppercase;
              letter-spacing: .4px; line-height: 1;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              max-width: 100%;
            }
            .pm-stage.done    .pm-stage-name { color: #137333; }
            .pm-stage.current .pm-stage-name { color: #e37400; }
            .pm-stage.future  .pm-stage-name { color: #9aa0a6; }
            .pm-stage-time {
              font-size: 11px; font-weight: 900;
              font-variant-numeric: tabular-nums;
              margin-top: 2px; line-height: 1;
            }
            .pm-stage.done    .pm-stage-time { color: #137333; }
            .pm-stage.current .pm-stage-time { color: #e37400; }
            .pm-stage.future  .pm-stage-time { color: #bdbdbd; }
            .pm-stage-icon {
              font-size: 9px; margin-bottom: 1px;
            }
            .pm-stage.done .pm-stage-icon { color: #34a853; }
            .pm-stage.current .pm-stage-icon { color: #f9ab00; }
            .pm-stage.future .pm-stage-icon { color: #dadce0; }
          `;
        document.head.appendChild(style);
    },

    buildStageBarHtml(m){
      this.ensureStageBarStyle();
      // Stop any previous ticker
      if (this.stageBarTimer) { clearInterval(this.stageBarTimer); this.stageBarTimer = null; }
      this.stageBarManifest = m;

      const ts = (k) => this.safeParseTs(m[k]);
      const now = Date.now();

      // Define pipeline stages with their start/end timestamp keys
      const stages = [
        { key: 'processing', label: 'Processing',  icon: 'fa-microchip',     startKey: 'created_at',   endKey: 'processed_at' },
        { key: 'queued',     label: 'Queued',       icon: 'fa-clock',         startKey: 'processed_at', endKey: 'started_at'   },
        { key: 'inprogress', label: 'In Progress',  icon: 'fa-pencil',        startKey: 'started_at',   endKey: 'uploaded_at'  },
        { key: 'qa',         label: 'QA Review',    icon: 'fa-user-check',    startKey: 'uploaded_at',  endKey: 'completed_at' },
        { key: 'completed',  label: 'Completed',    icon: 'fa-circle-check',  startKey: 'completed_at', endKey: null           },
      ];

      // Fallback: if processed_at is missing, treat queued_at or created_at as the
      // boundary between Processing and Queued
      const processedAt = ts('processed_at') || ts('queued_at');

      // Resolve timestamps for each boundary
      const resolve = (key) => {
        if (key === 'processed_at') return processedAt;
        return ts(key);
      };

      // Determine state of each stage
      let currentFound = false;
      const stageData = stages.map((s, idx) => {
        const start = resolve(s.startKey);
        const end   = s.endKey ? resolve(s.endKey) : null;

        // "Completed" stage is special: it's done if completed_at exists
        if (s.key === 'completed') {
          if (start) return { ...s, state: 'done', elapsed: 0 };
          if (!currentFound) return { ...s, state: 'future', elapsed: 0 };
          return { ...s, state: 'future', elapsed: 0 };
        }

        if (start && end) {
          // Both boundaries exist → this stage is done
          return { ...s, state: 'done', elapsed: Math.max(0, end - start) };
        }
        if (start && !end && !currentFound) {
          // Started but not ended → this is the current stage
          currentFound = true;
          return { ...s, state: 'current', elapsed: Math.max(0, now - start), startMs: start };
        }
        // Future or skipped
        return { ...s, state: currentFound ? 'future' : 'future', elapsed: 0 };
      });

      const fmtDur = (ms) => {
        if (!ms || ms <= 0) return '—';
        const totalSec = Math.floor(ms / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const min = Math.floor((totalSec % 3600) / 60);
        const sec = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        if (d > 0) return `${d}d ${h}h ${pad(min)}m`;
        if (h > 0) return `${h}:${pad(min)}:${pad(sec)}`;
        return `${min}:${pad(sec)}`;
      };

      let html = '<div class="pm-stagebar">';
      stageData.forEach(s => {
        const timeId = (s.state === 'current') ? 'pmStageBarCurrentTime' : '';
        const timeDisplay = (s.state === 'future' || (s.state === 'done' && s.key === 'completed'))
          ? (s.state === 'done' ? '<i class="fas fa-check"></i>' : '—')
          : fmtDur(s.elapsed);
        html += `
          <div class="pm-stage ${s.state}" data-stage-key="${s.key}">
            <span class="pm-stage-icon"><i class="fas ${s.icon}"></i></span>
            <span class="pm-stage-name">${s.label}</span>
            <span class="pm-stage-time" ${timeId ? `id="${timeId}"` : ''}>${timeDisplay}</span>
          </div>`;
      });
      html += '</div>';

      // Start live ticker if there's a current stage
      const currentStage = stageData.find(s => s.state === 'current');
      if (currentStage && currentStage.startMs) {
        this.stageBarTimer = setInterval(() => this.tickStageBar(), 1000);
      }

      return html;
    },
      
    tickStageBar(){
      const el = document.getElementById('pmStageBarCurrentTime');
      if (!el) { if (this.stageBarTimer) { clearInterval(this.stageBarTimer); this.stageBarTimer = null; } return; }
      const m = this.stageBarManifest;
      if (!m) return;

      // Determine which stage is current and its start time
      const ts = (k) => this.safeParseTs(m[k]);
      const processedAt = ts('processed_at') || ts('queued_at');
      const pipelineBoundaries = [
        { endKey: 'processed_at', startKey: 'created_at' },
        { endKey: 'started_at',   startKey: 'processed_at' },
        { endKey: 'uploaded_at',  startKey: 'started_at' },
        { endKey: 'completed_at', startKey: 'uploaded_at' },
      ];
      let currentStart = null;
      for (const b of pipelineBoundaries) {
        const start = (b.startKey === 'processed_at') ? processedAt : ts(b.startKey);
        const end   = (b.endKey === 'processed_at')   ? processedAt : ts(b.endKey);
        if (start && !end) { currentStart = start; break; }
      }
      if (!currentStart) { if (this.stageBarTimer) { clearInterval(this.stageBarTimer); this.stageBarTimer = null; } return; }

      const now = Date.now();
      const elapsed = Math.max(0, now - currentStart);
      const totalSec = Math.floor(elapsed / 1000);
      const d = Math.floor(totalSec / 86400);
      const h = Math.floor((totalSec % 86400) / 3600);
      const min = Math.floor((totalSec % 3600) / 60);
      const sec = totalSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      if (d > 0) el.textContent = `${d}d ${h}h ${pad(min)}m`;
      else if (h > 0) el.textContent = `${h}:${pad(min)}:${pad(sec)}`;
      else el.textContent = `${min}:${pad(sec)}`;
    },
      
    // -----------------------
    // Queue admin tab
    // -----------------------
    fmtAge(ms){
      if (ms < 0) ms = 0;
      const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60); const d = Math.floor(h / 24);
      if (d > 0) return `${d}d ${h%24}h`; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m`; return `${s}s`;
    },
    safeParseTs(v){
      if (v === null || typeof v === 'undefined') return null;
      if (typeof v === 'number' && isFinite(v)) { if (v > 1e12) return v; if (v > 1e9) return v * 1000; return null; }
      let s = String(v).trim(); if (!s) return null;
      if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); if (!isFinite(n)) return null; if (n > 1e12) return n; if (n > 1e9) return n * 1000; return null; }
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/);
      if (m) {
        const Y = +m[1], Mo = +m[2]-1, D = +m[3]; const H = +(m[4] || 0), Mi = +(m[5] || 0), Se = +(m[6] || 0); const Ms = m[7] ? +String(m[7]).padEnd(3,'0') : 0;
        const tz = m[8] || null;
        if (tz && tz !== '') { let t = Date.UTC(Y, Mo, D, H, Mi, Se, Ms); if (tz !== 'Z') { const sign = tz[0] === '-' ? -1 : 1; const hh = +tz.slice(1,3); const mm = +tz.slice(4,6); const offsetMin = sign * (hh*60 + mm); t -= offsetMin * 60000; } return t; }
        const t = Date.UTC(Y, Mo, D, H, Mi, Se, Ms); return isNaN(t) ? null : t;
      }
      let fallback = s.replace(' ', 'T');
      if (!/[Zz]$/.test(fallback) && !/[+-]\d{2}:\d{2}$/.test(fallback)) fallback += 'Z';
      const t = Date.parse(fallback); return isNaN(t) ? null : t;
    },
    async initQueueAdminTeams(){
      if (!cfg().flags.is_queue_admin) return;
      if (this.queueAdminTeams && this.queueAdminTeams.length) return;
      try { const data = await Portal.apiPost(cfg().endpoints.server, { action:'queue_admin_teams' }); this.queueAdminTeams = data.teams || []; } catch { this.queueAdminTeams = []; }
      const sel = document.getElementById('queueTeamSelect');
      if (!sel) return;
      sel.innerHTML = '';
      const optAll = document.createElement('option'); optAll.value = 'all'; optAll.textContent = 'All'; sel.appendChild(optAll);
      this.queueAdminTeams.forEach(t => {
        const team = (t && typeof t === 'object') ? t : { id: t, label: t };
        const id = String(team.id || '').trim();
        if (!id || id === 'all') return;
        const o = document.createElement('option');
        o.value = id;
        o.textContent = String(team.label || id);
        sel.appendChild(o);
      });
      sel.value = this.queueAdminTeam || 'all';
    },
    setQueueSectionCount(containerId, count){
      const container = document.getElementById(containerId); if (!container) return;
      const section = container.closest('.queue-section'); if (!section) return;
      const h3 = section.querySelector('h3'); if (!h3) return;
      let countSpan = h3.querySelector('.qcount');
      if (!countSpan) { countSpan = document.createElement('span'); countSpan.className = 'qcount'; countSpan.style.fontSize = '12px'; countSpan.style.fontWeight = '900'; countSpan.style.color = '#666'; countSpan.style.marginLeft = '8px'; h3.appendChild(countSpan); }
      countSpan.textContent = `(${count})`;
    },
    resetQueueBucketOffsets(){
      this.queueAdminBucketOffsets = {};
    },
    queueBucketOffset(group){
      const offsets = this.queueAdminBucketOffsets || {};
      return Math.max(0, parseInt(offsets[group], 10) || 0);
    },
    setQueueBucketOffset(group, offset){
      this.queueAdminBucketOffsets = {
        ...(this.queueAdminBucketOffsets || {}),
        [group]: Math.max(0, parseInt(offset, 10) || 0)
      };
    },
    ensureQueuePagerStyle(){
      if (document.getElementById('qPagerStyle')) return;
      const style = document.createElement('style');
      style.id = 'qPagerStyle';
      style.textContent = `
        .qpager{display:flex;align-items:center;gap:8px;margin:8px 0 6px;font-size:11px;font-weight:900;color:#777;}
        .qpager-info{min-width:150px;}
        .qpager-btn{border:1px solid #dadce0;background:#fff;color:#444;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;gap:5px;}
        .qpager-btn:hover:not(:disabled){border-color:#1a73e8;color:#1a73e8;background:#e8f0fe;}
        .qpager-btn:disabled{opacity:.45;cursor:not-allowed;}
      `;
      document.head.appendChild(style);
    },
    renderQueuePager(containerId, group, pagination){
      this.ensureQueuePagerStyle();
      const container = document.getElementById(containerId); if (!container) return;
      const section = container.closest('.queue-section'); if (!section) return;
      let pager = section.querySelector(`.qpager[data-group="${group}"]`);
      if (!pager) {
        pager = document.createElement('div');
        pager.className = 'qpager';
        pager.dataset.group = group;
        container.insertAdjacentElement('beforebegin', pager);
      }
      const limit = Math.max(1, parseInt(pagination?.limit, 10) || this.queueAdminBucketLimit || 50);
      const offset = Math.max(0, parseInt(pagination?.offset, 10) || 0);
      const total = Math.max(0, parseInt(pagination?.total_count, 10) || 0);
      const shown = Math.max(0, parseInt(pagination?.count, 10) || 0);
      const needsPager = total > limit || offset > 0;
      if (!needsPager) {
        pager.remove();
        return;
      }
      const start = total > 0 ? offset + 1 : 0;
      const end = total > 0 ? Math.min(offset + shown, total) : 0;
      const hasPrev = offset > 0;
      const hasNext = !!pagination?.has_more || (offset + shown < total);
      pager.innerHTML = `
        <span class="qpager-info">Showing ${start}-${end} of ${total}</span>
        <button class="qpager-btn" data-dir="prev" ${hasPrev ? '' : 'disabled'}><i class="fas fa-chevron-left"></i> Prev</button>
        <button class="qpager-btn" data-dir="next" ${hasNext ? '' : 'disabled'}>Next <i class="fas fa-chevron-right"></i></button>
      `;
      pager.querySelectorAll('button').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const dir = btn.dataset.dir;
          this.setQueueBucketOffset(group, dir === 'prev' ? Math.max(0, offset - limit) : offset + limit);
          queueOverviewStore.invalidate();
          await this.refreshQueueAdmin(true);
        };
      });
    },
    renderQueueRow(containerId, items, kind){
        const el = document.getElementById(containerId); if (!el) return; el.innerHTML = '';
        const hideFiller = this.getSectionHideFiller(containerId);
        let list = Array.isArray(items) ? items.slice() : [];
        if (hideFiller) list = list.filter(p => !p?.is_filler);
        if (!list || list.length === 0) { el.innerHTML = `<div class="qempty">Nothing here.</div>`; return; }
        const now = Date.now();
        const pickTs = (p, keys) => { for (const k of keys) { const t = this.safeParseTs(p?.[k]); if (t) return t; } return null; };
        const resolvePriorityLevel = (project) => this.reportExpeditePriorityLevel(project);
        if (!['rejected', 'cancelled'].includes(kind)) {
          const sortTime = (p) => pickTs(p, ['created_at','createdAt','created','queued_at','enqueued_at','queue_at','assigned_at','assignedAt','claimed_at','claimedAt','ready_at','updated_at']) || 0;
          list.sort((a, b) => {
            const pa = resolvePriorityLevel(a);
            const pb = resolvePriorityLevel(b);
            if (pa !== pb) return pa - pb;
            const ta = sortTime(a);
            const tb = sortTime(b);
            if (ta !== tb) return ta - tb;
            return String(a?.id || '').localeCompare(String(b?.id || ''));
          });
        }
        const queueNav = { kind, label: this.queueNavKindLabel(kind), items: list };
        list.forEach(p => {
          const createdT = pickTs(p, ['created_at','createdAt','created']);
          const queuedT = pickTs(p, ['queued_at','enqueued_at','queue_at','assigned_at','assignedAt','claimed_at','claimedAt','ready_at']) ?? createdT;
          const startedT = pickTs(p, ['started_at','startedAt','in_progress_at','inProgressAt','working_at','claimed_at','assigned_at']) ?? createdT;
          const inProgressEnteredT = this.getInProgressStageEnteredTs(p) ?? startedT;
          const qaT = pickTs(p, ['qa_at','awaiting_review_at','submitted_to_qa_at','review_at','reviewAt','qa_started_at']) ?? createdT;
          const qaClaimedT = pickTs(p, ['qa_claimed_at','qa_claim_at','qa_in_progress_at']);
          const completedT = pickTs(p, ['completed_at','updated_at']);
          const rejectedT = pickTs(p, ['rejected_at','updated_at']);
          const cancelledT = pickTs(p, ['cancelled_at','updated_at']);
          let stageTs = null; let ageMs = 0, ageLabel = 'Age';
          if (kind === 'rework_requested') { stageTs = pickTs(p, ['rework_requested_at','updated_at','created_at']) ?? queuedT; ageMs = stageTs ? (now - stageTs) : 0; ageLabel = 'Rework'; }
          else if (kind === 'structure_pins') { stageTs = queuedT; ageMs = queuedT ? (now - queuedT) : 0; ageLabel = 'Needs pins'; }
          else if (kind === 'waiting') { stageTs = queuedT; ageMs = queuedT ? (now - queuedT) : 0; ageLabel = 'Waiting'; }
          else if (kind === 'queued') { stageTs = queuedT; ageMs = queuedT ? (now - queuedT) : 0; ageLabel = 'In queue'; }
          else if (kind === 'in_progress') { stageTs = inProgressEnteredT; ageMs = inProgressEnteredT ? (now - inProgressEnteredT) : 0; ageLabel = 'Working'; }
          else if (kind === 'qa') { stageTs = qaT; ageMs = qaT ? (now - qaT) : 0; ageLabel = 'In QA'; }
          else if (kind === 'qa_waiting') { stageTs = qaT; ageMs = qaT ? (now - qaT) : 0; ageLabel = 'Waiting'; }
          else if (kind === 'qa_active') { stageTs = qaClaimedT ?? qaT; ageMs = stageTs ? (now - stageTs) : 0; ageLabel = 'Reviewing'; }
          else if (kind === 'release_holding') { stageTs = completedT ?? createdT; ageMs = stageTs ? (now - stageTs) : 0; ageLabel = 'Holding'; }
          else if (kind === 'rejected') { stageTs = rejectedT ?? createdT; ageMs = stageTs ? (now - stageTs) : 0; ageLabel = 'Rejected'; }
          else if (kind === 'cancelled') { stageTs = cancelledT ?? createdT; ageMs = stageTs ? (now - stageTs) : 0; ageLabel = 'Cancelled'; }
          const displayTech = this.getDisplayTechnician(p);
          const assigned = displayTech.name || displayTech.email || '—';
          const reservedFor = p.reserved_to_name || p.reserved_to_email || '';
          const team = p.team_id || 'default';
          const structurePinStatus = String(p.structure_pin_status || '').trim().toLowerCase();
          const structurePinsGenerating = kind === 'structure_pins' && ['generating', 'processing', 'started', 'submitted'].includes(structurePinStatus);
          const structurePinsFailed = kind === 'structure_pins' && ['failed', 'error'].includes(structurePinStatus);
          let tagCls, tagText;
          if (kind === 'rework_requested') { tagCls = 'yellow'; tagText = 'REWORK REQUEST'; }
          else if (kind === 'structure_pins' && structurePinsGenerating) { tagCls = 'gray'; tagText = 'GENERATING'; }
          else if (kind === 'structure_pins' && structurePinsFailed) { tagCls = 'red'; tagText = 'PIN GENERATION FAILED'; }
          else if (kind === 'structure_pins') { tagCls = 'red'; tagText = 'NEEDS PINS'; }
          else if (kind === 'waiting') { tagCls = 'yellow'; tagText = 'WAITING'; }
          else if (kind === 'queued') { tagCls = 'red'; tagText = 'QUEUED'; }
          else if (kind === 'in_progress') { tagCls = 'blue'; tagText = 'IN PROGRESS'; }
          else if (kind === 'qa_waiting') { tagCls = 'yellow'; tagText = 'WAITING FOR QA'; }
          else if (kind === 'qa_active') { tagCls = 'green'; tagText = 'QA IN PROGRESS'; }
          else if (kind === 'release_holding') { tagCls = 'yellow'; tagText = 'WAITING RELEASE'; }
          else if (kind === 'rejected') { tagCls = 'red'; tagText = (p.status === 'rejected_no_coverage') ? 'NO COVERAGE' : 'REJECTED'; }
          else if (kind === 'cancelled') { tagCls = 'gray'; tagText = 'CANCELLED'; }
          else { tagCls = 'green'; tagText = 'QA'; }
          const fillerTag = p.is_filler ? `<span class="qtag" style="background:#555; color:#fff; border-color:#333;">FILLER</span>` : '';
          const vipTag = p.is_vip ? `<span class="qtag" style="background:#f9ab00; color:#fff; border-color:#e37400; font-size:9px; font-weight:950;">⭐ VIP</span>` : '';
          const expeditedTag = p.is_expedited ? `<span class="qtag" style="background:#0f766e; color:#fff; border-color:#0f766e; font-size:9px; font-weight:950;">EXPEDITED</span>` : '';
          const priorityLevel = resolvePriorityLevel(p);
          const priorityColor = priorityLevel === 1 ? '#d93025' : (priorityLevel === 2 ? '#e37400' : '#5f6368');
          const priorityTag = `<span class="qtag" style="background:${priorityColor}; color:#fff; border-color:${priorityColor}; font-size:9px; font-weight:950;">P${priorityLevel}</span>`;
          const manualPriorityTag = p.qa_priority ? `<span class="qtag" style="background:#d93025; color:#fff; border-color:#d93025; font-size:9px; font-weight:950;">PRIORITY</span>` : '';
          const submissionFailureTag = p.status === 'submission_failed'
            ? `<span class="qtag" style="background:#b3261e;color:#fff;border-color:#7f1d1d;font-size:9px;font-weight:950;"><i class="fas fa-triangle-exclamation"></i> SUBMISSION FAILED</span>`
            : '';
          const complexityTag = this.complexityBadgeHtml(p.complexity, 'tag');
          const qPType = (p.project_type || 'residential').toLowerCase();
          const qTypeColors = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#7b1fa2' };
          const qTypeLabels = { residential:'RES', commercial:'COM', multifamily:'MF' };
          const typeTag = `<span class="qtag" style="background:${qTypeColors[qPType]||'#1a73e8'}; color:#fff; border-color:${qTypeColors[qPType]||'#1a73e8'}; font-size:9px;">${qTypeLabels[qPType]||qPType.toUpperCase()}</span>`;
          const qCcArr = Array.isArray(p.cc_emails) ? p.cc_emails : [];
          const qPinsArr = Array.isArray(p.pins) ? p.pins : [];
          const ccTag = qCcArr.length ? `<span class="qtag" style="font-size:9px;">CC:${qCcArr.length}</span>` : '';
          const pinsTag = kind === 'structure_pins'
            ? `<span class="qtag" style="font-size:9px;">${qPinsArr.length} pins</span>`
            : (qPinsArr.length > 1 ? `<span class="qtag" style="font-size:9px;">${qPinsArr.length} pins</span>` : '');
          const qaClaimerName = p.qa_claimed_by_name || p.qa_claimed_by_email || '';
          const claimerHtml = (kind === 'qa_active' && qaClaimerName) ? `<div class="qclaimer"><i class="fas fa-user-check"></i> ${Portal.escapeHtml(qaClaimerName)}</div>` : '';
          const submittedLabel = this.fmtLocalShort(p.created_at);
          const stageEnteredLabel = stageTs ? this.fmtLocalShort(stageTs) : '—';
          let stageEnteredName = 'Stage entered';
          if (kind === 'rework_requested') stageEnteredName = 'Requested at';
          else if (kind === 'structure_pins') stageEnteredName = 'Requested at';
          else if (kind === 'waiting') stageEnteredName = 'Waiting since';
          else if (kind === 'queued') stageEnteredName = 'Queued at';
          else if (kind === 'in_progress') stageEnteredName = 'Entered In Progress';
          else if (kind === 'qa_waiting') stageEnteredName = 'Entered QA';
          else if (kind === 'qa_active') stageEnteredName = 'Claimed at';
          else if (kind === 'qa') stageEnteredName = 'Entered QA';
          else if (kind === 'release_holding') stageEnteredName = 'Completed at';
          else if (kind === 'rejected') stageEnteredName = 'Rejected at';
          else if (kind === 'cancelled') stageEnteredName = 'Cancelled at';
          const originalStartedLabel = startedT ? this.fmtLocalShort(startedT) : '—';
          const showOriginalStartedRow = kind === 'in_progress'
            && startedT
            && stageTs
            && Math.abs(stageTs - startedT) > 60000;
          const stageTimeRows = [
            `<div class="qt-row"><span class="qt-label">Submitted</span><span class="qt-value">${Portal.escapeHtml(submittedLabel)}</span><span class="qt-age">(${this.fmtAge(createdT ? (now - createdT) : 0)} ago)</span></div>`
          ];
          if (showOriginalStartedRow) {
            stageTimeRows.push(`<div class="qt-row"><span class="qt-label">Started at</span><span class="qt-value">${Portal.escapeHtml(originalStartedLabel)}</span></div>`);
          }
          stageTimeRows.push(`<div class="qt-row"><span class="qt-label">${Portal.escapeHtml(stageEnteredName)}</span><span class="qt-value">${Portal.escapeHtml(stageEnteredLabel)}</span></div>`);
          const releaseHold = this.releaseHoldInfo(p);
          if (kind === 'release_holding') {
            const releaseAt = releaseHold.scheduled_release_at ? this.fmtLocalShort(releaseHold.scheduled_release_at) : '—';
            const promisedAt = releaseHold.promised_delivery_at ? this.fmtLocalShort(releaseHold.promised_delivery_at) : '—';
            const releaseMs = this.safeParseTs(releaseHold.scheduled_release_at);
            const releaseEta = releaseMs ? this.fmtAge(releaseMs - now) : '';
            stageTimeRows.push(`<div class="qt-row"><span class="qt-label">Release at</span><span class="qt-value">${Portal.escapeHtml(releaseAt)}</span>${releaseEta ? `<span class="qt-age">${Portal.escapeHtml(releaseEta)}</span>` : ''}</div>`);
            stageTimeRows.push(`<div class="qt-row"><span class="qt-label">Customer ETA</span><span class="qt-value">${Portal.escapeHtml(promisedAt)}</span></div>`);
          }
          const hardDeadlineAt = this.reportProductionDeadlineAt(p);
          if (hardDeadlineAt) {
            stageTimeRows.push(`<div class="qt-row"><span class="qt-label">Hard deadline</span><span class="qt-value"><i class="fas fa-bolt" style="color:#e37400;"></i> ${Portal.escapeHtml(this.fmtLocalShort(hardDeadlineAt))}</span></div>`);
          }
          const cardTimingSummary = this.buildProjectTimingSummary(p, kind === 'in_progress');
          if (cardTimingSummary?.elapsed && cardTimingSummary.baseCredit !== null) {
            const cardBand = cardTimingSummary.activeBand;
            const elapsedLabel = this.formatProjectTimerDuration(cardTimingSummary.elapsed.elapsedMs);
            const allotLabel = this.formatProjectTimerDuration(cardTimingSummary.timeline.totalMs);
            const creditLabel = `&#8369;${Portal.escapeHtml(String(cardTimingSummary.totalCredit))}`;
            const tierLabel = cardBand ? `${cardBand.label} ${cardBand.rate}/pt` : 'Speed tier';
            stageTimeRows.push(`<div class="qt-row"><span class="qt-label">Production timer</span><span class="qt-value">${Portal.escapeHtml(elapsedLabel)} / ${Portal.escapeHtml(allotLabel)}</span><span class="qt-age" title="${Portal.escapeHtml(tierLabel)}">${creditLabel}</span></div>`);
          }
          const rework = this.isRework(p);
          const reworkTag = (kind === 'in_progress' && rework)
            ? `<span class="qtag" style="background:#fff3e0; color:#e65100; border-color:#ffcc80; font-size:9px; font-weight:950;"><i class="fas fa-rotate-left" style="font-size:8px;"></i> REWORK</span>`
            : '';
          const rejReasonHtml = (kind === 'rejected' && (p.rejection_reason || p.rejection_note))
            ? `<div style="margin-top:4px; font-size:10px; font-weight:800; color:#b0261e; display:flex; align-items:center; gap:5px;"><i class="fas fa-circle-info"></i> ${Portal.escapeHtml(p.rejection_note || p.rejection_reason || '')}</div>`
            : '';
          const pinStateHtml = structurePinsGenerating
            ? `<div class="qpin-state"><i class="fas fa-circle-notch fa-spin"></i> Generating structure imagery from ${qPinsArr.length || 'saved'} pin${qPinsArr.length === 1 ? '' : 's'}</div>`
            : (structurePinsFailed
              ? `<div class="qpin-state error"><i class="fas fa-triangle-exclamation"></i> ${Portal.escapeHtml(p.structure_pin_error || 'Initial pin generation failed. Place pins again to retry.')}</div>`
              : '');
          const pinButtonHtml = structurePinsGenerating
            ? `<button class="qpin-btn" type="button" disabled><i class="fas fa-circle-notch fa-spin"></i> Generating</button>`
            : `<button class="qpin-btn" type="button" data-place-structure-pins="${Portal.escapeHtml(p.id || '')}"><i class="fas fa-location-dot"></i> ${structurePinsFailed ? 'Retry Pins' : 'Place Pins'}</button>`;
          const releaseButtonHtml = kind === 'release_holding'
            ? `<button class="qpin-btn" type="button" data-force-release="${Portal.escapeHtml(p.id || '')}" style="background:#1a73e8;border-color:#1a73e8;"><i class="fas fa-paper-plane"></i> Release Now</button>`
            : '';
          const div = document.createElement('div');
          div.className = `qcard ${this.queueAgeClass(p, kind, now)} ${structurePinsGenerating ? 'qcard--structure-generating' : ''} ${structurePinsFailed ? 'qcard--structure-failed' : ''}`.trim();
          div.innerHTML = `
            <div class="qline1">${Portal.escapeHtml(p.address || '(no address)')}</div>
            <div class="qline2">
              <span><b>${ageLabel}:</b> <span class="qstage-age" style="color:#1a73e8; font-weight:900;">${this.fmtAge(ageMs)}</span></span>
            </div>
            <div class="qmeta">
              ${submissionFailureTag} ${vipTag} ${manualPriorityTag} ${priorityTag} ${complexityTag} ${typeTag}
            </div>
            ${reservedFor ? `<div class="qreserved"><i class="fas fa-bookmark"></i> Reserved for ${Portal.escapeHtml(reservedFor)}</div>` : ''}
            ${claimerHtml}
            ${rejReasonHtml}
            ${pinStateHtml}
            ${kind === 'structure_pins' ? `<div style="margin-top:8px;">${pinButtonHtml}</div>` : ''}
            ${releaseButtonHtml ? `<div style="margin-top:8px;">${releaseButtonHtml}</div>` : ''}
            <div class="qcard-times">
              ${stageTimeRows.join('')}
            </div>
          `;
          if (kind === 'structure_pins') {
            div.onclick = structurePinsGenerating ? null : (() => this.openStructurePinModal(p));
            const pinBtn = div.querySelector('[data-place-structure-pins]');
            if (pinBtn) {
              pinBtn.onclick = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (structurePinsGenerating) return;
                this.openStructurePinModal(p);
              };
            }
          } else {
            div.onclick = () => this.openProjectModal(p.id, { project: p, queueNav: { ...queueNav, currentId: p.id } });
            const releaseBtn = div.querySelector('[data-force-release]');
            if (releaseBtn) {
              releaseBtn.onclick = async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                await this.forceReleaseHeldProject(p.id);
              };
            }
          }
          el.appendChild(div);
        });
    },
    openStructurePinModal(project){
      if (!window.StructurePinModal || typeof window.StructurePinModal.open !== 'function') {
        alert('Structure pin modal is not available.');
        return;
      }
      window.StructurePinModal.open({
        project,
        onSubmitted: async () => {
          queueOverviewStore.invalidate();
          await this.refreshQueueAdmin(true);
          await this.refreshQueueButton(true).catch(()=>{});
        }
      });
    },
    renderProjectModalEmailSection({ folderId, address, emailSummary, loading=false }){
      this.ensureProjectModalEmailUI();
      const modal = document.getElementById('projModal'); if (!modal) return;
      const gal = document.getElementById('pmGallery');
      const host = (gal && gal.parentElement) ? gal.parentElement : modal;
      let box = document.getElementById('pmEmailBox');
      if (!box) { box = document.createElement('div'); box.id = 'pmEmailBox'; box.className = 'pm-email-card'; host.appendChild(box); }
      const sum = (emailSummary && emailSummary.report_email) ? emailSummary.report_email : {};
      const sentOk = !!sum.sent_ok;
      const pill = loading ? `<span class="pm-email-pill"><i class="fas fa-circle-notch fa-spin"></i> Loading…</span>` : (sentOk ? `<span class="pm-email-pill ok"><i class="fas fa-circle-check"></i> Sent</span>` : `<span class="pm-email-pill bad"><i class="fas fa-circle-xmark"></i> Not sent</span>`);
      const kv = (k,v) => `<div class="pm-email-k">${Portal.escapeHtml(k)}</div><div class="pm-email-v">${Portal.escapeHtml(v ?? '—')}</div>`;
      box.innerHTML = `
        <div class="pm-email-head"><div class="pm-email-title"><i class="fas fa-envelope" style="color:#1a73e8;"></i> Email</div>${pill}</div>
        <div class="pm-email-grid">
          ${kv('Type', 'Report PDF')} ${kv('Address', address || '—')} ${kv('Attempts', loading ? '—' : String(sum.attempts ?? 0))}
          ${kv('Sent at (UTC)', loading ? '—' : (sum.sent_at_utc || '—'))} ${kv('Last attempt (UTC)', loading ? '—' : (sum.last_attempt_utc || '—'))}
          ${kv('Last HTTP', loading ? '—' : ((sum.last_http === null || typeof sum.last_http === 'undefined') ? '—' : String(sum.last_http)))}
          ${kv('Message ID', loading ? '—' : (sum.message_id || '—'))}
        </div>
        <div class="pm-email-actions">
          <button class="pm-email-btn" id="pmEmailRefreshBtn" ${loading ? 'disabled' : ''}><i class="fas fa-rotate"></i> Refresh</button>
          <button class="pm-email-btn primary" id="pmEmailResendBtn" ${loading ? 'disabled' : ''}><i class="fas fa-paper-plane"></i> Re-send PDF Email</button>
        </div>
        <div class="pm-email-small">Tip: this logs every send attempt into the project manifest so we can diagnose edge-cases.</div>
      `;
      const refreshBtn = document.getElementById('pmEmailRefreshBtn');
      const resendBtn = document.getElementById('pmEmailResendBtn');
      if (refreshBtn) refreshBtn.onclick = async () => { await this.refreshProjectModalEmail(folderId, address); };
      if (resendBtn) resendBtn.onclick = async () => { await this.resendProjectModalReportEmail(folderId, address); };
    },
    projectHasDeliveredReportEmail(project){
      const delivery = (project && project.delivery && typeof project.delivery === 'object') ? project.delivery : {};
      const emailState = (project && project.email_state && typeof project.email_state === 'object') ? project.email_state : {};
      const reportEmail = (emailState.report_email && typeof emailState.report_email === 'object') ? emailState.report_email : emailState;
      const reopenedAt = this.safeParseTs(project?.resubmitted_at || project?.last_reopened_at || project?.last_resubmission_at || '');
      const isAfterReopen = (value) => {
        if (!reopenedAt) return true;
        const ts = this.safeParseTs(value);
        return !!ts && ts >= reopenedAt;
      };
      if ((reportEmail.sent_ok === true || reportEmail.last_ok === true) && isAfterReopen(reportEmail.sent_at_utc || reportEmail.last_attempt_utc)) return true;
      if ((reportEmail.sent_at_utc || reportEmail.message_id) && isAfterReopen(reportEmail.sent_at_utc || reportEmail.last_attempt_utc)) return true;
      if ((project?.report_sent_at || delivery.report_sent_at) && isAfterReopen(project?.report_sent_at || delivery.report_sent_at)) return true;
      const events = Array.isArray(project?.email_events) ? project.email_events : [];
      return events.some((ev) => {
        if (!ev || typeof ev !== 'object') return false;
        return String(ev.type || '').toLowerCase() === 'report_email' && ev.ok === true && isAfterReopen(ev.ts || ev.sent_at_utc || ev.at);
      });
    },
    async refreshProjectModalEmail(folderId, address, opts={}){
      if (!folderId) return;
      const requestToken = opts.requestToken ?? this._projectModalRequestToken;
      if (!this.isProjectModalRequestCurrent(folderId, requestToken)) return;
      this.renderProjectModalEmailSection({ folderId, address, emailSummary: null, loading: true });
      const data = await this.fmGet(`projects/${encodeURIComponent(folderId)}/email/status`).catch(()=>null);
      if (!this.isProjectModalRequestCurrent(folderId, requestToken)) return;
      if (!data || !data.success) { this.renderProjectModalEmailSection({ folderId, address, emailSummary: { report_email: { sent_ok:false, attempts:0 } }, loading: false }); alert(data?.error || 'Failed to load email status.'); return; }
      this.renderProjectModalEmailSection({ folderId, address, emailSummary: data.email_summary || null, loading: false });
    },
    async resendProjectModalReportEmail(folderId, address){
      if (!folderId) return;
      const resendBtn = document.getElementById('pmEmailResendBtn');
      const refreshBtn = document.getElementById('pmEmailRefreshBtn');
      const origResend = resendBtn ? resendBtn.innerHTML : '';
      if (resendBtn) { resendBtn.disabled = true; resendBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Sending…`; }
      if (refreshBtn) refreshBtn.disabled = true;
      const res = await this.fmPost(`projects/${encodeURIComponent(folderId)}/email/send-report`, { force: true }).catch(()=>null);
      if (!res || !res.success) {
        const postmarkMsg = res?.result?.postmark?.Message;
        const backendMsg = res?.result?.error || res?.error;
        alert(postmarkMsg || backendMsg || 'Send failed.');
      }
      await this.refreshProjectModalEmail(folderId, address);
      if (resendBtn) { resendBtn.disabled = false; resendBtn.innerHTML = origResend || `<i class="fas fa-paper-plane"></i> Re-send PDF Email`; }
      if (refreshBtn) refreshBtn.disabled = false;
      try { await this.refreshQueueAdmin(true); } catch {}
    },
    async forceReleaseHeldProject(folderId){
      if (!folderId || !this.canSeeReleaseHoldingQueue()) return;
      const btn = Array.from(document.querySelectorAll('[data-force-release]'))
        .find((node) => String(node.getAttribute('data-force-release') || '') === String(folderId));
      const original = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Releasing...`;
      }
      const res = await this.fmPost(`projects/${encodeURIComponent(folderId)}/release/force`, {}).catch(() => null);
      if (!res || !res.success) {
        alert(res?.result?.error || res?.error || 'Release failed.');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = original || `<i class="fas fa-paper-plane"></i> Release Now`;
        }
        return;
      }
      queueOverviewStore.invalidate();
      await this.refreshQueueAdmin(true);
    },
    ensureProjectModalEmailUI(){
      if (document.getElementById('pmEmailStyle')) return;
      const style = document.createElement('style');
      style.id = 'pmEmailStyle';
      style.textContent = `.pm-email-card{margin-top:14px;border:1px solid #eee;border-radius:12px;padding:12px;background:#fafafa;}.pm-email-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}.pm-email-title{font-weight:950;font-size:12px;color:#444;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.3px;}.pm-email-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:950;border:1px solid #eee;background:#fff;color:#333;white-space:nowrap;}.pm-email-pill.ok{border-color:#c8e6c9;background:#e6f4ea;color:#137333;}.pm-email-pill.bad{border-color:#f1b7b2;background:#fce8e6;color:#b0261e;}.pm-email-grid{display:grid;grid-template-columns:150px 1fr;gap:6px 10px;font-size:12px;line-height:1.35;}.pm-email-k{color:#777;font-weight:900;text-transform:uppercase;letter-spacing:.3px;font-size:10px;}.pm-email-v{color:#111;font-weight:800;word-break:break-word;}.pm-email-actions{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;}.pm-email-btn{border-radius:10px;padding:9px 12px;font-weight:900;cursor:pointer;border:1px solid #ddd;background:#fff;color:#333;display:inline-flex;align-items:center;gap:8px;user-select:none;}.pm-email-btn.primary{border-color:#1a73e8;background:#1a73e8;color:#fff;}.pm-email-btn:disabled{opacity:.55;cursor:not-allowed;}.pm-email-small{margin-top:8px;font-size:11px;color:#777;font-weight:800;}`;
      document.head.appendChild(style);
    },
    renderCompletedToday(items){
      const grid = document.getElementById('qCompletedGrid'); if (!grid) return; grid.innerHTML = '';
      this.syncCompletedTodayPriorityFilterUI();
      const hideFiller = this.getSectionHideFiller('qCompletedGrid');
      this.completedTodayItems = Array.isArray(items) ? items.slice() : [];
      let list = this.applyCompletedTodayPriorityFilter(this.completedTodayItems);
      if (hideFiller) list = list.filter(p => !p?.is_filler);
      if (!list || list.length === 0) {
        const filter = this.getCompletedTodayPriorityFilter();
        const label = filter === 'all' ? '' : ` for P${filter}`;
        grid.innerHTML = `<div style="grid-column:1/-1; color:#9aa0a6; font-style:italic; padding:12px 2px;">Nothing completed today${Portal.escapeHtml(label)}.</div>`;
        return 0;
      }
      const queueNav = { kind: 'completed', label: this.queueNavKindLabel('completed'), items: list };
      const fmtLocalTime = (ts) => { const t = this.safeParseTs(ts); if (!t) return ''; return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
      list.forEach(p => {
        const displayTech = this.getDisplayTechnician(p);
        const payTech = this.getPayTechnician(p);
        const drafter = payTech.name || payTech.email || p.qa_paid_to_name || p.qa_paid_to_email || displayTech.name || displayTech.email || p.owner || '-';
        const qa = p.qa_approved_by_name || p.qa_approved_by || '-';
        const fillerBadge = p.is_filler ? `<div class="badge" style="background:#0000db; border-color:#333; color:#fff; width:35px;">FILLER</div>` : '';
        const dPType = (p.project_type || 'residential').toLowerCase();
        const dTypeColors = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#7b1fa2' };
        const dTypeLabels = { residential:'RES', commercial:'COM', multifamily:'MF' };
        const typeBadge = dPType !== 'residential' ? `<div class="badge" style="background:${dTypeColors[dPType]||'#1a73e8'}; border-color:${dTypeColors[dPType]||'#1a73e8'}; color:#fff; font-size:9px; font-weight:950;">${dTypeLabels[dPType]||dPType.toUpperCase()}</div>` : '';
        const dCcArr = Array.isArray(p.cc_emails) ? p.cc_emails : [];
        const dCcHint = dCcArr.length ? ` &bull; CC: ${dCcArr.length}` : '';
        const completedTime = p.completed_at ? fmtLocalTime(p.completed_at) : '';
        const createdTime = p.created_at ? this.fmtLocalShort(p.created_at) : '';
        const complexityBadge = this.complexityBadgeHtml(p.complexity, 'badge');
        const emailWarning = !p.is_filler && !!p.completed_at && !this.projectHasDeliveredReportEmail(p);
        const emailWarningBadge = emailWarning
          ? `<div style="margin-top:8px; display:inline-flex; align-items:center; gap:6px; padding:6px 9px; border-radius:999px; background:#fce8e6; border:1px solid #f1b7b2; color:#b3261e; font-size:11px; font-weight:900;"><i class="fas fa-envelope"></i> Report email not sent</div>`
          : '';
        const div = document.createElement('div');
        div.className = 'tile';
        const completedStatusBadge = `<div class="badge bg-ready">completed</div>`;
        div.innerHTML = `
          <div class="tile-thumb" style="height:140px;">
            <img src="${p.thumbnail || ''}" onerror="this.style.display='none'">
            ${this.wrapTileBadgeStack('top-left', [fillerBadge])}
            ${this.wrapTileBadgeStack('top-right', [completedStatusBadge, typeBadge])}
            ${this.wrapTileBadgeStack('bottom-right', [complexityBadge])}
          </div>
          <div class="tile-content" style="padding:12px;">
            <div class="tile-addr" style="font-size:13px;">${Portal.escapeHtml(p.address || '-')}</div>
            <div class="tile-meta" style="margin:0; color:#777;">${Portal.escapeHtml(drafter)} &bull; QA: ${Portal.escapeHtml(qa)}${completedTime ? ` &bull; ${Portal.escapeHtml(completedTime)}` : ''}${dCcHint}</div>
            ${createdTime ? `<div class="tile-meta" style="margin:0; color:#999; font-size:11px;">Submitted: ${Portal.escapeHtml(createdTime)}</div>` : ''}
            ${emailWarningBadge}
          </div>
        `;
        this.bindThumbnailFallback(div.querySelector('.tile-thumb img'), p.thumbnail_candidates);
        div.onclick = () => this.openProjectModal(p.id, { project: p, queueNav: { ...queueNav, currentId: p.id } });
        grid.appendChild(div);
      });
      return list.length;
    },
    getQueueHideFiller(){ try { const v = localStorage.getItem('queue_hide_filler'); if (v === null) return false; return v === '1'; } catch { return false; } },
    setQueueHideFiller(on){ try { localStorage.setItem('queue_hide_filler', on ? '1' : '0'); } catch {} },
    getSectionHideFiller(sectionKey){
      try {
        const raw = localStorage.getItem('queue_section_hide_filler');
        if (!raw) return false;
        const map = JSON.parse(raw);
        return !!map[sectionKey];
      } catch { return false; }
    },
    setSectionHideFiller(sectionKey, on){
      try {
        const raw = localStorage.getItem('queue_section_hide_filler');
        const map = raw ? JSON.parse(raw) : {};
        if (on) map[sectionKey] = true;
        else delete map[sectionKey];
        localStorage.setItem('queue_section_hide_filler', JSON.stringify(map));
      } catch {}
    },
    ensureQueueFillerToggleUI(){
      // Replaced by per-section filler switches in applyCollapsibleSections()
    },
    async refreshPortalStatusBar(){
      try {
        if (window.PortalStatusBar && typeof window.PortalStatusBar.refresh === 'function') {
          await window.PortalStatusBar.refresh(false);
        }
      } catch {}
    },
    toQueueFallbackRows(projects){
      return this.toProjectBrowserRows(projects);
    },
    async refreshQueueAdmin(force=false){
      if (!cfg().flags.is_queue_admin) return;
      const view = document.getElementById('view-queue');
      if (!view || view.style.display === 'none') return;
      this.ensureCollapsibleStyle(); this.ensureQueueStructurePinsUI(); this.ensureQueueReworkRequestsUI(); this.ensureQueueRequeueUI(); this.ensureQueueWaitingUI(); this.ensureQueueQASplitUI(); this.ensureQueueReleaseHoldingUI(); this.ensureQueueFillerToggleUI(); this.ensureQueueRejectedUI(); this.ensureQueueCancelledUI();
      const sel = document.getElementById('queueTeamSelect');
      if (sel) this.queueAdminTeam = sel.value || 'all';
      if (this.queueAdminTeam !== this.queueAdminLastTeam) {
        this.queueAdminLastTeam = this.queueAdminTeam;
        this.resetQueueBucketOffsets();
        queueOverviewStore.invalidate();
      }
      const statusEl = document.getElementById('queueAdminStatus');
      if (statusEl && force) statusEl.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Refreshing…`;
      try {
        const data = await queueOverviewStore.get({
          team: this.queueAdminTeam,
          view: 'card',
          bucketLimit: this.queueAdminBucketLimit,
          offsets: this.queueAdminBucketOffsets || {}
        }, {
          forceNetwork: !!force
        });
        if (!data || !data.success) throw new Error('bad');
        const reworkRequests = Array.isArray(data.rework_requested) ? data.rework_requested : [];
        const structurePins = Array.isArray(data.needs_structure_pins) ? data.needs_structure_pins : [];
        const waiting = data.waiting || [];
        let queued = data.queued || [];
        const requeue = data.requeue || [];
        const inProg = data.in_progress || [];
        const qaWaiting = Array.isArray(data.qa_waiting) ? data.qa_waiting : [];
        const qaInProgress = Array.isArray(data.qa_in_progress) ? data.qa_in_progress : [];
        const qa = Array.isArray(data.qa) ? data.qa : qaWaiting.concat(qaInProgress);
        const releaseHolding = this.canSeeReleaseHoldingQueue() && Array.isArray(data.release_holding) ? data.release_holding : [];
        const rejectedToday = Array.isArray(data.rejected) ? data.rejected : [];
        const cancelledToday = Array.isArray(data.cancelled) ? data.cancelled : [];
        const doneLocal = Array.isArray(data.completed_today) ? data.completed_today : [];
        const meta = data.queue_meta || {};
        const counts = meta.counts || {};
        const buckets = meta.buckets || {};
        this.renderQueueRow('qRowReworkRequests', reworkRequests, 'rework_requested');
        this.renderQueueRow('qRowStructurePins', structurePins, 'structure_pins');
        this.renderRequeueRow(requeue);
        this.renderQueueRow('qRowWaiting', waiting, 'waiting');
        this.renderQueueRow('qRowQueued', queued, 'queued');
        this.renderQueueRow('qRowInProgress', inProg, 'in_progress');
        this.renderQueueRow('qRowQAWaiting', qaWaiting, 'qa_waiting');
        this.renderQueueRow('qRowQAInProgress', qaInProgress, 'qa_active');
        this.renderQueueRow('qRowQA', qa, 'qa');
        if (this.canSeeReleaseHoldingQueue()) this.renderQueueRow('qRowReleaseHolding', releaseHolding, 'release_holding');
        this.renderQueueRow('qRowRejected', rejectedToday, 'rejected');
        this.renderQueueRow('qRowCancelled', cancelledToday, 'cancelled');
        const completedVisibleCount = this.renderCompletedToday(doneLocal);
        this.setQueueSectionCount('qRowReworkRequests', counts.rework_requested ?? reworkRequests.length);
        this.setQueueSectionCount('qRowStructurePins', counts.needs_structure_pins ?? structurePins.length);
        this.setQueueSectionCount('qRowRequeue', counts.requeue ?? requeue.length);
        this.setQueueSectionCount('qRowWaiting', counts.waiting ?? waiting.length);
        this.setQueueSectionCount('qRowQueued', counts.queued ?? queued.length);
        this.setQueueSectionCount('qRowInProgress', counts.in_progress ?? inProg.length);
        this.setQueueSectionCount('qRowQAWaiting', counts.qa_waiting ?? qaWaiting.length);
        this.setQueueSectionCount('qRowQAInProgress', counts.qa_claimed ?? qaInProgress.length);
        this.setQueueSectionCount('qRowQA', (counts.qa_waiting ?? qaWaiting.length) + (counts.qa_claimed ?? qaInProgress.length));
        if (this.canSeeReleaseHoldingQueue()) this.setQueueSectionCount('qRowReleaseHolding', buckets.release_holding?.total_count ?? releaseHolding.length);
        this.setQueueSectionCount('qRowRejected', buckets.rejected?.total_count ?? rejectedToday.length);
        this.setQueueSectionCount('qRowCancelled', buckets.cancelled?.total_count ?? cancelledToday.length);
        this.setQueueSectionCount('qCompletedGrid', completedVisibleCount ?? doneLocal.length);
        this.renderQueuePager('qRowReworkRequests', 'rework_requested', buckets.rework_requested);
        this.renderQueuePager('qRowStructurePins', 'needs_structure_pins', buckets.needs_structure_pins);
        this.renderQueuePager('qRowRequeue', 'requeue', buckets.requeue);
        this.renderQueuePager('qRowWaiting', 'waiting', buckets.waiting);
        this.renderQueuePager('qRowQueued', 'queued', buckets.queued);
        this.renderQueuePager('qRowInProgress', 'in_progress', buckets.in_progress);
        this.renderQueuePager('qRowQAWaiting', 'qa_waiting', buckets.qa_waiting);
        this.renderQueuePager('qRowQAInProgress', 'qa_claimed', buckets.qa_claimed);
        if (this.canSeeReleaseHoldingQueue()) this.renderQueuePager('qRowReleaseHolding', 'release_holding', buckets.release_holding);
        this.renderQueuePager('qRowRejected', 'rejected', buckets.rejected);
        this.renderQueuePager('qRowCancelled', 'cancelled', buckets.cancelled);
        this.renderQueuePager('qCompletedGrid', 'completed', buckets.completed);
        if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()} · indexed`;
        // Apply collapsible behavior after all sections are rendered
        this.applyCollapsibleSections();
        this.queueAdminHasLoaded = true;
        if (force) await this.refreshPortalStatusBar();
      } catch (e) { if (statusEl) statusEl.textContent = 'Refresh failed'; }
    },
    ensurePaginationStyle(){
      if (document.getElementById('paginationStyle')) return;
      const style = document.createElement('style');
      style.id = 'paginationStyle';
      style.textContent = `
        .pagination-bar{
          display:flex; align-items:center; justify-content:space-between;
          padding:16px 4px 8px; gap:12px; flex-wrap:wrap;
        }
        .pg-info{
          font-size:12px; font-weight:800; color:#888;
        }
        .pg-controls{
          display:flex; align-items:center; gap:10px;
        }
        .pg-text{
          font-size:12px; font-weight:900; color:#555;
          min-width:100px; text-align:center;
        }
        .pg-btn{
          display:inline-flex; align-items:center; gap:6px;
          border-radius:10px; padding:8px 14px;
          font-size:12px; font-weight:900;
          border:1px solid #dadce0; background:#fff; color:#333;
          cursor:pointer; user-select:none;
          transition: all .15s ease;
        }
        .pg-btn:hover:not(:disabled){
          border-color:#1a73e8; color:#1a73e8; background:#e8f0fe;
        }
        .pg-btn:disabled{
          opacity:.45; cursor:not-allowed;
        }
      `;
      document.head.appendChild(style);
    },
    // -----------------------
    // Apple key panel
    // -----------------------
    maskKey(k){ if (!k) return '—'; const s = String(k); if (s.length <= 12) return '************'; return s.slice(0,6) + '…' + s.slice(-6); },
    parseUtcIso(ts){ if (!ts) return null; const t = Date.parse(ts); return isNaN(t) ? null : t; },
    fmtAgeMs(ms){ if (ms < 0) ms = 0; const s = Math.floor(ms/1000); const m = Math.floor(s/60); const h = Math.floor(m/60); const remS = s % 60; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m ${remS}s`; return `${s}s`; },
    renderAppleKeyInfo(info){
      const statusEl = document.getElementById('appleStatusText');
      const utcEl = document.getElementById('appleUpdatedUtc');
      const ageEl = document.getElementById('appleAge');
      const maskedEl = document.getElementById('appleKeyMasked');
      const tileVersionEl = document.getElementById('appleTileVersionCurrent');
      const tileVersionInput = document.getElementById('appleTileVersionInput');
      const warnEl = document.getElementById('appleWarn');
      const okEl = document.getElementById('appleOk');
      const copyBtn = document.getElementById('btnAppleCopy');
      const hasKey = !!(info && info.key);
      const t = this.parseUtcIso(info && info.updated_at_utc ? info.updated_at_utc : null);
      const now = Date.now();
      const ageMs = (t ? (now - t) : null);
      const ageMin = (ageMs !== null) ? (ageMs / 60000) : null;
      const tileVersion = Number.isInteger(Number(info && info.tile_version)) ? Number(info.tile_version) : 10401;
      if (tileVersionEl) tileVersionEl.textContent = String(tileVersion);
      if (tileVersionInput && document.activeElement !== tileVersionInput) tileVersionInput.value = String(tileVersion);
      if (maskedEl) maskedEl.textContent = info && info.key ? String(info.key) : 'â€”';
      if (copyBtn) copyBtn.disabled = !hasKey;
      if (utcEl) utcEl.textContent = info && info.updated_at_utc ? info.updated_at_utc : '—';
      if (!hasKey) { if (statusEl) statusEl.textContent = 'No key set'; if (ageEl) ageEl.textContent = '—'; if (warnEl) warnEl.classList.add('show'); if (okEl) okEl.classList.remove('show'); return; }
      if (!t) { if (statusEl) statusEl.textContent = 'Key set (timestamp missing)'; if (ageEl) ageEl.textContent = '—'; if (warnEl) warnEl.classList.add('show'); if (okEl) okEl.classList.remove('show'); return; }
      if (statusEl) statusEl.textContent = 'Key present';
      if (ageEl) ageEl.textContent = this.fmtAgeMs(ageMs);
      const isWarn = (ageMin !== null && ageMin > 25);
      if (warnEl) warnEl.classList.toggle('show', isWarn);
      if (okEl) okEl.classList.toggle('show', !isWarn);
    },
    async refreshAppleKey(force=false){
      if (!cfg().flags.is_apple_key_admin) return;
      try {
        const data = await Portal.apiPost(cfg().endpoints.portal, { action:'get_apple_key_info' });
        if (!data || !data.success) throw new Error(data && data.error ? data.error : 'Fetch failed');
        this.appleKeyInfo = {
          key: data.key || null,
          updated_at_utc: data.updated_at_utc || null,
          tile_version: Number(data.tile_version) || 10401
        };
        this.renderAppleKeyInfo(this.appleKeyInfo);
      } catch (e) { this.appleKeyInfo = { key:null, updated_at_utc:null, tile_version:10401 }; this.renderAppleKeyInfo(this.appleKeyInfo); alert("Apple key fetch failed."); }
    },
    async saveAppleKey(){
      if (!cfg().flags.is_apple_key_admin) return;
      const inp = document.getElementById('appleKeyInput');
      const btn = document.getElementById('btnAppleSave');
      const key = inp ? inp.value.trim() : '';
      if (!key) { alert("Paste a key first."); return; }
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }
      try { const data = await Portal.apiPost(cfg().endpoints.portal, { action:'set_apple_key', key }); if (!data || !data.success) throw new Error(data && data.error ? data.error : 'Save failed'); if (inp) inp.value = ''; await this.refreshAppleKey(true); }
      catch (e) { alert("Apple key save failed."); }
      finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Key'; } }
    },
    async saveAppleTileVersion(){
      if (!cfg().flags.is_apple_key_admin) return;
      const inp = document.getElementById('appleTileVersionInput');
      const btn = document.getElementById('btnAppleTileVersionSave');
      const tileVersion = Number(inp ? inp.value : '');
      if (!Number.isInteger(tileVersion) || tileVersion <= 0 || tileVersion > 999999999) {
        alert('Tile version must be a positive whole number.');
        return;
      }
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }
      try {
        const data = await Portal.apiPost(cfg().endpoints.portal, {
          action:'set_apple_key',
          tile_version:tileVersion
        });
        if (!data || !data.success) throw new Error(data && data.error ? data.error : 'Save failed');
        await this.refreshAppleKey(true);
      } catch (e) { alert('Apple Maps tile version save failed.'); }
      finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Tile Version'; } }
    },
    async copyAppleKey(){
      if (!cfg().flags.is_apple_key_admin) return;
      const key = this.appleKeyInfo && this.appleKeyInfo.key ? String(this.appleKeyInfo.key) : '';
      const btn = document.getElementById('btnAppleCopy');
      if (!key) { alert("No Apple key to copy."); return; }
      const originalHtml = btn ? btn.innerHTML : '';

      const setButtonState = (html, disabled = true) => {
        if (!btn) return;
        btn.disabled = disabled;
        btn.innerHTML = html;
      };

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(key);
        } else {
          const ta = document.createElement('textarea');
          ta.value = key;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setButtonState('<i class="fas fa-check"></i> Copied');
        setTimeout(() => setButtonState(originalHtml || '<i class="fas fa-copy"></i> Copy', false), 1200);
      } catch (e) {
        setButtonState('<i class="fas fa-triangle-exclamation"></i> Copy Failed');
        setTimeout(() => setButtonState(originalHtml || '<i class="fas fa-copy"></i> Copy', false), 1600);
      }
    }
  };
  window.Projects = Projects;
})();
