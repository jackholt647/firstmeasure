/* portal_scripts/stats.js
 * Statistics module:
 * - Reports completed per day (total, filler, real, test)
 * - Dollar value of completed reports per day (uses actual amount_charged per project)
 * - Payout calculation using technician points, speed bands, and rank-based base pay (PHP -> USD)
 * - Shift costs: Technician rank base pay, QA (2300 PHP), Manager (2700 PHP)
 * - Complexity distribution breakdown
 * - Average time in each pipeline stage
 * - Organization breakdown
 * - Technician performance metrics
 * - Daily / Weekly / Monthly / Rolling 7-Day views
 * - Trends over time
 * - Multi-series pipeline flow chart with two dimension modes:
 *     • Category mode: Real / Filler / Test
 *     • Service type mode: Residential / Commercial / Multi-Family
 *
 * Requires: admin or manage_queue permission
 * Self-contained: All UI, styles, and logic in one file.
 */
(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;
  const apiServer = () => (cfg().endpoints && cfg().endpoints.server) ? cfg().endpoints.server : window.Portal.internalLegacyEndpoint();

  // =========================================================================
  //  COST & REVENUE CONSTANTS  (mirrors the legacy pricing module)
  // =========================================================================

  // Per-type base prices (USD) — commercial & multifamily multiply by structure count
  const PRICE_PER_TYPE = {
    residential: 7,
    commercial:  12,
    multifamily: 12,
  };
  const PRICE_DEFAULT = 7; // fallback for unknown types
  const GUTTER_ADDON_USD = 3;

  // PHP → USD conversion (≈56 PHP per $1 USD)
  const PHP_TO_USD = 1 / 56;

  // Complexity point values for production payout and distribution.
  const COMPLEXITY_TIERS = {
    1: { points: 2,  label: 'Very Simple',  color: '#34a853' },
    2: { points: 3,  label: 'Simple',       color: '#4ecdc4' },
    3: { points: 4,  label: 'Standard',     color: '#f4b400' },
    4: { points: 6,  label: 'Complex',      color: '#e67700' },
    5: { points: 10, label: 'Very Complex', color: '#d93025' },
  };
  const COMPLEXITY_POINTS = {
    1: 2, 2: 3, 3: 4, 4: 6, 5: 10,
    very_simple: 2, very_simple_project: 2,
    simple: 3, simple_project: 3,
    standard: 4, standard_project: 4,
    complex: 6, complex_project: 6,
    very_complex: 10, very_complex_project: 10
  };
  const SPEED_RATE_BANDS = [
    { key:'green',  label:'Very Fast', rate:19, color:'#34a853' },
    { key:'yellow', label:'Fast',      rate:16, color:'#f4b400' },
    { key:'orange', label:'Medium',    rate:13, color:'#e67700' },
    { key:'red',    label:'Slow',      rate:10, color:'#d93025' },
    { key:'expired', label:'Very Slow', rate:5, color:'#7f1d1d' },
  ];
  const SPEED_NO_TIMING_BAND_INDEX = 3;
  const RUSH_BONUS_PERCENT = 25;
  const TECH_BASE_PAY_BY_RANK = { junior: 450, standard: 600, senior: 750 };
  const TECH_BASE_MIN_POINTS_PER_DAY = 20;

  // Shift pay rates (PHP per shift day)
  const QA_SHIFT_PHP   = 2300;
  const MGR_SHIFT_PHP  = 2700;
  const TURNAROUND_TIMEZONE = 'America/Los_Angeles';
  const WORK_SHIFT_START_HOUR = 5;
  const CUSTOMER_INTAKE_END_HOUR = 20;
  const WORK_SHIFT_END_HOUR = 22;

  // =========================================================================
  //  SERVICE TYPE CONFIG (Residential / Commercial / Multi-Family)
  // =========================================================================
  const ALL_SERVICE_TYPES = ['residential', 'commercial', 'multifamily'];
  const SERVICE_LABELS = { residential: 'Residential', commercial: 'Commercial', multifamily: 'Multi-Family' };
  const SERVICE_ICONS  = { residential: 'fa-home', commercial: 'fa-building', multifamily: 'fa-city' };
  const SERVICE_COLORS = {
    requested: { residential: '#1a73e8', commercial: '#e37400', multifamily: '#8430ce' },
    drawn:      { residential: '#4285f4', commercial: '#fbbc04', multifamily: '#ce93d8' },
    completed:  { residential: '#137333', commercial: '#d93025', multifamily: '#4b0082' },
    rejected:   { residential: '#c5221f', commercial: '#a14200', multifamily: '#6f1d8f' },
  };
  const SERVICE_SUMMARY_COLORS = { residential: '#1a73e8', commercial: '#e37400', multifamily: '#8430ce' };

  // =========================================================================
  //  CATEGORY (Real / Filler / Test) CONFIG  — unchanged from original
  // =========================================================================
  const SERIES_COLORS = {
    requested: { real: '#1a73e8', filler: '#4fc3f7', test: '#78909c' },
    drawn:      { real: '#8430ce', filler: '#ce93d8', test: '#9e9e9e' },
    completed:  { real: '#137333', filler: '#fbbc04', test: '#bdbdbd' },
    rejected:   { real: '#c5221f', filler: '#e37400', test: '#5f6368' },
  };
  const ALL_TYPES   = ['real','filler','test'];
  const TYPE_LABELS = { real: 'Real', filler: 'Filler', test: 'Test' };
  const TYPE_ICONS  = { real: 'fa-file-alt', filler: 'fa-layer-group', test: 'fa-flask' };

  const EVENT_ORDER = ['requested', 'drawn', 'completed', 'rejected'];
  const EVENT_LABELS = { requested: 'Requested', drawn: 'Drawn', completed: 'Completed', rejected: 'Rejected' };
  const EVENT_ICONS  = { requested: 'fa-shopping-cart', drawn: 'fa-pencil-ruler', completed: 'fa-check-circle', rejected: 'fa-ban' };

  // =========================================================================
  //  CHART DIMENSION MODE  ('category' | 'service')
  // =========================================================================
  let chartDimensionMode = 'category'; // 'category' = real/filler/test | 'service' = res/com/mfh
  let pipelineChartViewMode = 'timeline'; // 'timeline' | 'timeofday'
  let pipelineDistributionMetric = 'count'; // 'count' | 'share'

  // Event-series visibility (shared across both dimension modes)
  let chartVisibleSeries = { requested: true, drawn: true, completed: true, rejected: true };

  // ---- Type groups for CATEGORY mode ----
  function _saveTypeGroups() {
    try { localStorage.setItem('stats_type_groups', JSON.stringify(typeGroups)); } catch(e) {}
  }
  function _loadTypeGroups() {
    try {
      const raw = localStorage.getItem('stats_type_groups');
      if (raw) {
        const parsed = JSON.parse(raw);
        const all = parsed.flatMap(g => g.types || []);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            all.every(t => ALL_TYPES.includes(t)) &&
            ALL_TYPES.every(t => all.includes(t))) {
          return parsed.map(g => ({ types: g.types, visible: g.visible !== false }));
        }
      }
    } catch(e) {}
    return ALL_TYPES.map(t => ({ types: [t], visible: true }));
  }
  let typeGroups = _loadTypeGroups();

  // ---- Service type groups for SERVICE mode ----
  function _saveSvcGroups() {
    try { localStorage.setItem('stats_svc_groups', JSON.stringify(svcGroups)); } catch(e) {}
  }
  function _loadSvcGroups() {
    try {
      const raw = localStorage.getItem('stats_svc_groups');
      if (raw) {
        const parsed = JSON.parse(raw);
        const all = parsed.flatMap(g => g.types || []);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            all.every(t => ALL_SERVICE_TYPES.includes(t)) &&
            ALL_SERVICE_TYPES.every(t => all.includes(t))) {
          return parsed.map(g => ({ types: g.types, visible: g.visible !== false }));
        }
      }
    } catch(e) {}
    return ALL_SERVICE_TYPES.map(t => ({ types: [t], visible: true }));
  }
  let svcGroups = _loadSvcGroups();

  // Drag state
  let _pipelineToggleHandler = null;
  let _pipelineDragHandler   = null;
  let _dragState = null;

  // =========================================================================
  //  HELPERS
  // =========================================================================

  /** Normalize complexity to integer 1–5 */
  function normalizeComplexity(val) {
    if (typeof val === 'number' && val >= 1 && val <= 5) return Math.round(val);
    if (typeof val === 'string') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) return n;
      const lower = val.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (lower === 'very_simple' || lower === 'very_simple_project') return 1;
      if (lower === 'simple' || lower === 'simple_project') return 2;
      if (lower === 'standard' || lower === 'standard_project') return 3;
      if (lower === 'complex' || lower === 'complex_project') return 4;
      if (lower === 'very_complex' || lower === 'very_complex_project') return 5;
    }
    return 3;
  }

  function tierFor(rating) {
    const r = normalizeComplexity(rating);
    return COMPLEXITY_TIERS[r] || COMPLEXITY_TIERS[3];
  }

  /** Did this project pass QA on the first attempt? */
  function passedQaFirstTime(p) {
    if (typeof p.qa_reject_count === 'number') return p.qa_reject_count === 0;
    const hist = p.qa_history;
    if (Array.isArray(hist) && hist.length > 0) return false;
    const wh = p.work_history;
    if (Array.isArray(wh)) {
      for (const ev of wh) {
        if (ev && ev.event === 'qa_rejected') return false;
      }
    }
    return true;
  }

  function resolveProjectPoints(project) {
    if (!project || typeof project !== 'object') return null;
    const direct = Number(project.point_value ?? project.project_points ?? project.points_value ?? project.points);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const raw = String(project.complexity ?? '').trim().toLowerCase();
    if (!raw) return null;
    const normalized = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const numeric = Number(raw);
    const key = Number.isFinite(numeric) ? numeric : normalized;
    const mapped = COMPLEXITY_POINTS[key];
    return Number.isFinite(mapped) && mapped > 0 ? mapped : null;
  }

  function buildSpeedTimeline(points) {
    if (!Number.isFinite(points) || points <= 0) return null;
    const sectionMinutes = [6 * points, 3 * points, 3 * points, 6 * points];
    const boundariesMs = [];
    let runningMs = 0;
    for (const minutes of sectionMinutes) {
      runningMs += minutes * 60000;
      boundariesMs.push(runningMs);
    }
    return { totalMs: runningMs, boundariesMs, sectionMinutes };
  }

  function parseProjectTimestamp(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 100000000000 ? raw : raw * 1000;
    const text = String(raw).trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) {
      const value = Number(text);
      return Number.isFinite(value) ? (value > 100000000000 ? value : value * 1000) : null;
    }
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
    const hasSqlTimestamp = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(text);
    const normalized = hasSqlTimestamp ? text.replace(' ', 'T') : text;
    const parsed = Date.parse(hasSqlTimestamp && !hasTimezone ? `${normalized}Z` : normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeHistory(project) {
    const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
    const sources = [project?.work_history, project?.technician_history, workflow.work_history, workflow.history];
    const seen = new Set();
    const output = [];
    for (const source of sources) {
      if (!Array.isArray(source)) continue;
      for (const entry of source) {
        if (!entry || typeof entry !== 'object') continue;
        const event = String(entry.event || entry.type || '').trim().toLowerCase();
        const ms = parseProjectTimestamp(entry.ts || entry.at || entry.created_at || entry.assigned_at || entry.claimed_at || entry.submitted_at);
        if (!event || ms === null) continue;
        const key = `${event}:${ms}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({ event, ms });
      }
    }
    output.sort((a, b) => a.ms - b.ms);
    return output;
  }

  function rawWorkHistory(project) {
    const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
    const sources = [project?.work_history, workflow.work_history, workflow.history, project?.technician_history];
    const out = [];
    for (const source of sources) {
      if (!Array.isArray(source)) continue;
      for (const entry of source) {
        if (entry && typeof entry === 'object') out.push(entry);
      }
    }
    return out;
  }

  function projectPayTechnician(project) {
    const p = project && typeof project === 'object' ? project : {};
    const qaEmails = new Set([
      p.qa_claimed_by_email, p.qa_approved_by_email, p.qa_approved_by,
      p.qa_reviewed_by_email, p.qa_reviewed_by, p.workflow?.qa_claim?.email
    ].map(v => normalizeEmail(v)).filter(Boolean));
    const techEvents = new Set(['correction_submitted', 'submitted_for_qa', 'claimed_correction', 'claimed_new', 'reopened_project_claimed', 'assigned_current', 'correction_target']);
    const events = rawWorkHistory(p)
      .map((ev, idx) => ({
        ev,
        idx,
        event: String(ev.event || ev.type || '').toLowerCase().trim(),
        ms: parseProjectTimestamp(ev.ts || ev.at || ev.created_at || ev.assigned_at || ev.claimed_at || ev.submitted_at) ?? idx
      }))
      .filter(row => techEvents.has(row.event))
      .sort((a, b) => (a.ms - b.ms) || (a.idx - b.idx));
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i].ev;
      const email = normalizeEmail(ev.worker_email || ev.assigned_to_email || ev.email);
      const name = String(ev.worker_name || ev.assigned_to_name || ev.name || email || '').trim();
      if (email && qaEmails.has(email)) continue;
      if (email || name) return { email, name: name || email, basis: events[i].event };
    }
    const history = Array.isArray(p.technician_history) ? p.technician_history.slice().reverse() : [];
    for (const entry of history) {
      const email = normalizeEmail(entry?.email);
      const name = String(entry?.name || '').trim();
      if (email && qaEmails.has(email)) continue;
      if (email || name) return { email, name: name || email, basis: entry?.last_event || 'technician_history' };
    }
    const candidates = [
      { email: p.latest_technician_email, name: p.latest_technician_name, basis: 'latest_technician' },
      { email: p.display_technician_email, name: p.display_technician_name, basis: 'display_technician' },
      { email: p.assigned_to_email, name: p.assigned_to_name, basis: 'assigned_to' },
      { email: p.technician_email, name: p.technician_name, basis: 'technician' },
      { email: p.drafter_email, name: p.drafter_name, basis: 'drafter' },
      { email: p.qa_paid_to_email, name: p.qa_paid_to_name, basis: 'stored_payee' }
    ];
    for (const candidate of candidates) {
      const email = normalizeEmail(candidate.email);
      const name = String(candidate.name || '').trim();
      if (email && qaEmails.has(email)) continue;
      if (email || name) return { email, name: name || email, basis: candidate.basis };
    }
    return { email: '', name: '', basis: '' };
  }

  function latestReopenMs(project) {
    const events = normalizeHistory(project);
    let latest = parseProjectTimestamp(project?.resubmitted_at || project?.last_resubmission_at || null);
    for (const item of (Array.isArray(project?.resubmissions) ? project.resubmissions : [])) {
      const ms = parseProjectTimestamp(item?.reopened_at || item?.resubmitted_at || null);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
    for (const ev of events) {
      if (ev.event === 'project_reopened_for_edits' && (latest === null || ev.ms > latest)) latest = ev.ms;
    }
    return latest;
  }

  function findClaimStartedAt(project) {
    const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
    const assignedTo = workflow.assigned_to && typeof workflow.assigned_to === 'object' ? workflow.assigned_to : {};
    const reopenMs = latestReopenMs(project);
    const candidates = [
      project?.assigned_at, project?.claimed_at, project?.technician_claimed_at,
      workflow.assigned_at, workflow.claimed_at, assignedTo.assigned_at, assignedTo.claimed_at,
      project?.started_at, workflow.started_at
    ];
    for (const ev of normalizeHistory(project)) {
      if (ev.event.includes('claim') || ev.event.includes('assign')) candidates.push(ev.ms);
    }
    let startMs = null;
    for (const raw of candidates) {
      const ms = typeof raw === 'number' ? raw : parseProjectTimestamp(raw);
      if (ms !== null && (reopenMs === null || ms >= reopenMs) && (startMs === null || ms < startMs)) startMs = ms;
    }
    return startMs;
  }

  function terminalSubmittedMs(project, startMs) {
    const timestamps = project && typeof project.timestamps === 'object' ? project.timestamps : {};
    const candidates = [
      project?.uploaded_at, timestamps.uploaded_at,
      project?.qa_submitted_at, project?.submitted_at, timestamps.submitted_at,
      project?.completed_at, project?.qa_completed_at, project?.qa_approved_at
    ].map(parseProjectTimestamp).filter(ms => ms !== null && (startMs === null || ms >= startMs));
    return candidates.length ? Math.min(...candidates) : null;
  }

  function collectionElapsedMs(project) {
    const startMs = findClaimStartedAt(project);
    if (startMs === null) return null;
    const pauseEvents = new Set(['submitted_for_qa', 'correction_submitted']);
    const resumeEvents = new Set(['qa_sent_back_to_tech', 'manager_sent_back_to_tech']);
    const events = normalizeHistory(project)
      .filter(entry => entry.ms >= startMs)
      .map(entry => pauseEvents.has(entry.event) ? { type:'pause', ms:entry.ms } : (resumeEvents.has(entry.event) ? { type:'resume', ms:entry.ms } : null))
      .filter(Boolean);
    const submittedMs = terminalSubmittedMs(project, startMs);
    if (submittedMs !== null) events.push({ type:'pause', ms: submittedMs });
    events.sort((a, b) => a.ms - b.ms);

    let activeStart = startMs;
    let paused = false;
    let totalMs = 0;
    for (const entry of events) {
      if (entry.type === 'pause' && !paused) {
        totalMs += Math.max(0, entry.ms - activeStart);
        paused = true;
      } else if (entry.type === 'resume' && paused) {
        activeStart = entry.ms;
        paused = false;
      }
    }
    if (!paused) {
      const timestamps = project && typeof project.timestamps === 'object' ? project.timestamps : {};
      const endCandidates = [
        project?.uploaded_at, timestamps.uploaded_at,
        project?.qa_submitted_at, project?.submitted_at, timestamps.submitted_at,
        project?.completed_at, project?.qa_completed_at, project?.qa_approved_at
      ].map(parseProjectTimestamp).filter(ms => ms !== null && ms >= activeStart);
      const endMs = endCandidates.length ? Math.max(...endCandidates) : null;
      if (endMs !== null && endMs >= activeStart) totalMs += Math.max(0, endMs - activeStart);
    }
    return totalMs > 0 ? totalMs : null;
  }

  function speedBandForElapsed(elapsedMs, timeline) {
    if (!timeline || !Array.isArray(timeline.boundariesMs) || !Number.isFinite(elapsedMs)) return SPEED_RATE_BANDS[SPEED_NO_TIMING_BAND_INDEX];
    for (let i = 0; i < timeline.boundariesMs.length; i++) {
      if (elapsedMs <= timeline.boundariesMs[i]) return SPEED_RATE_BANDS[i];
    }
    return SPEED_RATE_BANDS[SPEED_RATE_BANDS.length - 1];
  }

  function rushBonusForProject(project, baseRate) {
    if (!project || !project.rush_bonus_eligible || !project.rush_bonus_tag || !passedQaFirstTime(project)) return 0;
    const percent = Number(project.rush_bonus_percent ?? project.rush_bonus_amount ?? RUSH_BONUS_PERCENT);
    const safePercent = Number.isFinite(percent) && percent > 0 ? percent : RUSH_BONUS_PERCENT;
    return Math.round(Number(baseRate || 0) * (safePercent / 100));
  }

  function projectPayoutInfo(project) {
    const points = resolveProjectPoints(project);
    const timeline = buildSpeedTimeline(points);
    const elapsedMs = collectionElapsedMs(project);
    const band = speedBandForElapsed(elapsedMs, timeline);
    const baseRate = Number.isFinite(points) && points > 0 ? Math.round(points * band.rate) : 0;
    const rushBonus = rushBonusForProject(project, baseRate);
    return {
      points: Number.isFinite(points) && points > 0 ? points : 0,
      elapsedMs,
      band,
      baseRate,
      rushBonus,
      total: baseRate + rushBonus,
    };
  }

  function technicianRankForEmail(email, fallbackRank = '') {
    const normalized = normalizeEmail(email);
    const user = allUsers.find(u => normalizeEmail(u.email) === normalized);
    const rank = String(user?.drafter_rank || user?.technician_rank || user?.measurement_technician_rank || fallbackRank || 'junior').trim().toLowerCase();
    return ['junior', 'standard', 'senior'].includes(rank) ? rank : 'junior';
  }

  function technicianBasePayForRank(rank) {
    return TECH_BASE_PAY_BY_RANK[rank] || TECH_BASE_PAY_BY_RANK.junior;
  }

  function phpToUsd(php) { return (php || 0) * PHP_TO_USD; }

  /**
   * Returns true if this project belongs to a test organization.
   */
  function isTestProject(p) {
    if (typeof p.is_test_org === 'boolean') return p.is_test_org;
    const orgId = p.organization_id;
    if (!orgId) return false;
    const org = allOrganizations.find(o => String(o.id) === String(orgId));
    return !!(org && org.is_test);
  }

  /**
   * Returns 'test' | 'filler' | 'real' (category dimension).
   */
  function projectType(p) {
    if (isTestProject(p)) return 'test';
    if (p.is_filler) return 'filler';
    return 'real';
  }

  /**
   * Returns 'residential' | 'commercial' | 'multifamily' (service dimension).
   * Filler/test projects also get their service type for pipeline charting.
   */
  function projectServiceType(p) {
    const t = (p.project_type || 'residential').toLowerCase();
    if (t === 'commercial') return 'commercial';
    if (t === 'multifamily') return 'multifamily';
    return 'residential';
  }

  function projectStructureCount(p) {
    return Math.max(1, typeof p.pin_count === 'number' ? Math.round(p.pin_count) : 1);
  }

  function projectRegularListRevenue(p) {
    const type = projectServiceType(p);
    const basePrice = PRICE_PER_TYPE[type] || PRICE_DEFAULT;
    if (type === 'commercial' || type === 'multifamily') {
      return basePrice * projectStructureCount(p);
    }
    return basePrice;
  }

  function coerceBool(value) {
    if (value === true) return true;
    if (value === false || value === null || typeof value === 'undefined' || value === '') return false;
    if (typeof value === 'number') return value > 0;
    const text = String(value).trim().toLowerCase();
    if (['0', 'false', 'no', 'n', 'off', 'exclude', 'excluded', 'none'].includes(text)) return false;
    return ['1', 'true', 'yes', 'y', 'on', 'include', 'included', 'gutters', 'gutter', 'weather', 'storm'].includes(text);
  }

  function firstPositiveNumber(...values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function projectIncludesGutters(p) {
    return coerceBool(
      p.include_gutter_measurements ?? p.include_gutters ?? p.gutter_measurements ?? p.gutters ??
      p.metadata?.include_gutter_measurements ?? p.metadata?.include_gutters ??
      p.order?.include_gutter_measurements ?? p.order?.include_gutters
    );
  }

  function projectExpediteLevel(p) {
    const rawOption = String(p.report_expedite_option || p.expedite_option || p.rush_option || '').trim().toLowerCase();
    const option = rawOption === 'rush_1_2' || rawOption === 'rush_1_1_5'
      ? 'rush_under_1'
      : (rawOption === 'rush_2_3' ? 'rush_1_3' : rawOption);
    if (option === 'rush_under_1' || option === 'level_1' || option === 'level1') return 1;
    if (option === 'rush_1_3' || option === 'level_2' || option === 'level2') return 2;
    const explicitLevel = Number(p.expedite_level ?? p.report_expedite_level ?? p.rush_level);
    if (Number.isFinite(explicitLevel) && explicitLevel > 0) return explicitLevel >= 2 ? 2 : 1;
    return p.is_expedited ? 2 : 0;
  }

  function projectHasStormWeatherReport(p) {
    const textFields = [
      p.report_type, p.product_type, p.order_type, p.report_kind, p.service_type,
      p.weather_report_type, p.storm_report_type, p.addon_type
    ].map(v => String(v || '').toLowerCase()).join(' ');
    return coerceBool(
      p.include_storm_weather_report ?? p.include_weather_report ?? p.storm_weather_report ??
      p.weather_report ?? p.weather_reports ?? p.metadata?.include_storm_weather_report ??
      p.metadata?.include_weather_report ?? p.order?.include_storm_weather_report ??
      p.order?.include_weather_report
    ) || /\b(storm|weather|hail|wind)\b/.test(textFields);
  }

  function projectBaseReportRevenue(p) {
    return projectOrderMode(p) === 'instant_only' ? 0 : projectRegularListRevenue(p);
  }

  function projectAddonRevenueBreakdown(p, totalRevenue = null) {
    const total = Number.isFinite(Number(totalRevenue)) ? Number(totalRevenue) : projectRevenue(p);
    const base = Math.max(0, projectBaseReportRevenue(p));
    const extraTotal = Math.max(0, total - base);
    const explicitGutter = firstPositiveNumber(
      p.gutter_amount, p.gutter_fee, p.gutter_revenue, p.gutter_addon_amount, p.gutter_measurements_amount,
      p.addons?.gutters, p.addons?.gutter, p.metadata?.gutter_amount, p.order?.gutter_amount
    );
    const explicitExpedite = firstPositiveNumber(
      p.expedite_amount, p.expedite_fee, p.rush_amount, p.rush_fee, p.report_expedite_amount, p.report_expedite_fee,
      p.addons?.expedite, p.addons?.rush, p.metadata?.expedite_amount, p.order?.expedite_amount
    );
    const explicitWeather = firstPositiveNumber(
      p.weather_amount, p.weather_fee, p.weather_report_amount, p.weather_report_fee,
      p.storm_weather_amount, p.storm_weather_fee, p.storm_report_amount, p.storm_report_fee,
      p.addons?.weather, p.addons?.storm_weather, p.metadata?.weather_amount, p.order?.weather_amount
    );
    const hasGutters = projectIncludesGutters(p);
    const expediteLevel = projectExpediteLevel(p);
    const hasStormWeather = projectHasStormWeatherReport(p);

    let gutter = explicitGutter;
    if (gutter <= 0 && hasGutters) gutter = GUTTER_ADDON_USD;

    let expedite = explicitExpedite;
    let weather = explicitWeather;
    const known = gutter + expedite + weather;
    if (extraTotal > 0 && known > extraTotal) {
      const scale = extraTotal / known;
      gutter *= scale;
      expedite *= scale;
      weather *= scale;
    }

    const unattributed = Math.max(0, extraTotal - gutter - expedite - weather);
    return {
      base,
      extraTotal,
      gutter,
      expedite,
      expediteLevel,
      expediteLevel1: expediteLevel === 1 ? expedite : 0,
      expediteLevel2: expediteLevel === 2 ? expedite : 0,
      weather,
      unattributed,
      hasGutters,
      hasExpedite: expediteLevel > 0,
      hasStormWeather,
    };
  }

  function projectOrderMode(p) {
    const reportMode = String(p.report_mode || '').trim().toLowerCase();
    const instantOnly = p.instant_only === true || reportMode === 'instant';
    if (instantOnly) return 'instant_only';
    if (reportMode === 'both' || (p.instant_enabled === true && reportMode !== 'full')) return 'both';
    return 'regular_only';
  }

  function projectHasRegularReport(p) {
    const mode = projectOrderMode(p);
    return mode === 'regular_only' || mode === 'both';
  }

  function projectHasInstantReport(p) {
    const mode = projectOrderMode(p);
    return mode === 'instant_only' || mode === 'both';
  }

  function projectReportPayPhp(p) {
    return projectPayoutInfo(p).baseRate;
  }

  /**
   * Revenue for a single real (non-filler, non-test) project.
   * Uses amount_charged when stored, otherwise derives from type + pin_count.
   */
  function projectRevenue(p) {
    // Best: use the exact amount charged at order time
    const charged = Number(p.amount_charged);
    if (Number.isFinite(charged) && charged > 0) return charged;
    // Fallback: derive from type + structure count and known add-ons.
    const base = projectBaseReportRevenue(p);
    const gutter = projectIncludesGutters(p) ? GUTTER_ADDON_USD : 0;
    return base + gutter;
  }

  function projectRevenueSplit(p) {
    const total = projectRevenue(p);
    const mode = projectOrderMode(p);
    if (mode === 'instant_only') return { regular: 0, instant: total, total };
    if (mode === 'both') {
      const regular = Math.max(0, Math.min(total, projectRegularListRevenue(p)));
      return { regular, instant: Math.max(0, total - regular), total };
    }
    return { regular: total, instant: 0, total };
  }

  let allOrganizations  = [];
  let allShiftSchedules = [];
  let statsRenderSeq = 0;
  const statsHydratedLedgerOrgIds = new Set();
  const statsActualRevenueByRange = new Map();

  // Date mode for summary stats
  let chartDateMode = 'completed';

  function canViewStats() {
    return cfg().flags?.can_view_stats === true;
  }

  function getLocalDateKey(date) {
    if (!date) return null;
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function localDateFromKey(key) {
    if (!key) return null;
    const parts = key.split('-');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0);
  }

  // =========================================================================
  //  SHIFT SCHEDULE HELPERS
  // =========================================================================
  function getDayNameFromYMD(ymd) {
    const d = localDateFromKey(ymd);
    if (!d) return 'monday';
    const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    return names[d.getDay()];
  }

  function resolveShiftBlocksForDate(schedule, ymd) {
    if (!schedule) return [];
    const overrides = schedule.overrides || {};
    if (overrides.hasOwnProperty(ymd)) {
      const raw = overrides[ymd];
      return Array.isArray(raw) ? raw : [];
    }
    const dayName = getDayNameFromYMD(ymd);
    const recurring = schedule.recurring || {};
    return Array.isArray(recurring[dayName]) ? recurring[dayName] : [];
  }

  function countShiftDaysByRole(schedules, startDate, endDate) {
    const counts = { technician: 0, qa: 0, manager: 0 };
    if (!schedules || !schedules.length) return counts;
    const seen = { technician: new Set(), qa: new Set(), manager: new Set() };
    let cur = new Date(startDate);
    while (cur < endDate) {
      const ymd = getLocalDateKey(cur);
      schedules.forEach(s => {
        const blocks = resolveShiftBlocksForDate(s, ymd);
        blocks.forEach(b => {
          const role = (b.role || 'technician').toLowerCase();
          if (seen[role]) seen[role].add(`${s.email}:${ymd}`);
        });
      });
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0, 0);
    }
    counts.technician = seen.technician.size;
    counts.qa = seen.qa.size;
    counts.manager = seen.manager.size;
    return counts;
  }

  // =========================================================================
  //  STYLES
  // =========================================================================
  function ensureStyles() {
    if (document.getElementById('statsPluginStyles')) return;
    const css = `
      .stats-container { display:flex; flex-direction:column; height:100%; overflow:hidden; }
      .stats-scroll { flex:1; overflow-y:auto; padding:20px; }

      .stats-period-tabs {
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        flex-wrap:wrap; padding:15px 20px;
        background:#fff; border-bottom:1px solid #e0e0e0;
      }
      .stats-period-group {
        display:flex; gap:4px; flex-wrap:wrap;
      }
      .period-tab {
        padding:10px 24px; border:none; background:#f1f3f4;
        border-radius:8px; cursor:pointer; font-weight:700;
        font-size:13px; color:#5f6368; transition:all 0.2s;
      }
      .period-tab:hover { background:#e8eaed; color:#202124; }
      .period-tab.active {
        background:var(--primary, #db0000); color:#fff;
        box-shadow:0 2px 6px rgba(219,0,0,0.25);
      }

      .stats-date-nav {
        display:flex; align-items:center; justify-content:flex-end;
        gap:10px; flex-wrap:wrap;
      }
      .date-nav-btn {
        width:36px; height:36px; border:1px solid #ddd;
        background:#fff; border-radius:8px; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        transition:all 0.15s;
      }
      .date-nav-btn:hover { background:#f1f3f4; border-color:#ccc; }
      .date-nav-btn:disabled { opacity:0.4; cursor:not-allowed; }
      .date-nav-label {
        font-size:15px; font-weight:800; color:#202124;
        min-width:200px; text-align:center;
      }
      .active-company-card {
        display:flex; align-items:center; justify-content:space-between; gap:16px;
      }
      .active-company-card h4 {
        margin:0; font-size:13px; font-weight:800; color:#202124;
        text-transform:uppercase; letter-spacing:0.3px;
      }
      .active-company-inline-value {
        font-size:34px; font-weight:900; color:#1a73e8; line-height:1;
        white-space:nowrap;
      }

      .stats-summary {
        display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
        gap:15px; margin-bottom:25px;
      }
      .summary-card {
        background:#fff; border:1px solid #e0e0e0;
        border-radius:12px; padding:18px;
        box-shadow:0 1px 4px rgba(0,0,0,0.04);
        transition:transform 0.15s, box-shadow 0.15s;
      }
      .summary-card:hover { transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,0.08); }
      .summary-card .label { font-size:10px; font-weight:800; color:#777; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
      .summary-card .value { font-size:28px; font-weight:900; color:#202124; line-height:1; }
      .summary-card .value.green  { color:#137333; }
      .summary-card .value.blue   { color:#1a73e8; }
      .summary-card .value.orange { color:#e37400; }
      .summary-card .value.purple { color:#8430ce; }
      .summary-card .value.red    { color:#c5221f; }
      .summary-card .sub { font-size:11px; color:#666; margin-top:6px; font-weight:600; }
      .summary-card .trend {
        display:inline-flex; align-items:center; gap:4px;
        font-size:11px; font-weight:700; margin-top:6px;
        padding:3px 8px; border-radius:4px;
      }
      .summary-card .trend.up      { background:#e6f4ea; color:#137333; }
      .summary-card .trend.down    { background:#fce8e6; color:#c5221f; }
      .summary-card .trend.neutral { background:#f1f3f4; color:#5f6368; }

      /* Service type breakdown mini bar */
      .svc-bar-wrap { margin-top:8px; }
      .svc-bar-row { display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:10px; font-weight:700; }
      .svc-bar-label { width:72px; color:#555; text-transform:uppercase; font-size:9px; letter-spacing:0.3px; flex-shrink:0; }
      .svc-bar-track { flex:1; background:#f0f0f0; border-radius:3px; height:7px; overflow:hidden; }
      .svc-bar-fill  { height:7px; border-radius:3px; transition:width 0.4s ease; }
      .svc-bar-count { width:28px; text-align:right; color:#444; flex-shrink:0; }
      .svc-bar-rev   { width:48px; text-align:right; color:#137333; flex-shrink:0; }

      .stats-overview-grid {
        display:grid; grid-template-columns:repeat(2, minmax(0, 1fr));
        gap:20px; margin-bottom:20px;
      }
      .stats-overview-col {
        display:flex; flex-direction:column; gap:16px; min-width:0;
      }
      .overview-panel {
        background:#fff; border:1px solid #e0e0e0; border-radius:12px;
        padding:18px; box-shadow:0 1px 4px rgba(0,0,0,0.04);
      }
      .overview-panel h4 {
        margin:0 0 4px 0; font-size:13px; font-weight:800; color:#202124;
        text-transform:uppercase; letter-spacing:0.3px;
      }
      .overview-panel .panel-subtitle {
        font-size:11px; color:#666; font-weight:600; margin-bottom:14px;
      }
      .stats-table-wrap { overflow-x:auto; }
      .overview-table, .stage-type-table {
        width:100%; border-collapse:collapse; min-width:520px;
      }
      .overview-table th, .overview-table td,
      .stage-type-table th, .stage-type-table td {
        padding:11px 12px; border-bottom:1px solid #f0f0f0; vertical-align:middle;
      }
      .overview-table th, .stage-type-table th {
        background:#f8f9fa; color:#555; font-size:10px; font-weight:800;
        text-transform:uppercase; letter-spacing:0.3px; text-align:left;
      }
      .overview-table tr:last-child td,
      .stage-type-table tr:last-child td { border-bottom:none; }
      .overview-table .metric {
        font-size:13px; font-weight:700; color:#202124;
      }
      .metric-label {
        display:inline-flex; align-items:center; gap:8px;
      }
      .metric-help {
        display:inline-flex; align-items:center; justify-content:center;
        width:16px; height:16px; border-radius:50%;
        border:1px solid #c7cdd3; color:#6b7280; background:#f8f9fa;
        font-size:10px; font-weight:900; line-height:1; cursor:help;
        flex-shrink:0;
      }
      .overview-table .value {
        text-align:right; font-size:20px; font-weight:900; color:#202124;
        white-space:nowrap;
      }
      .overview-table .value.green  { color:#137333; }
      .overview-table .value.blue   { color:#1a73e8; }
      .overview-table .value.orange { color:#e37400; }
      .overview-table .value.purple { color:#8430ce; }
      .overview-table .value.red    { color:#c5221f; }
      .overview-table .detail {
        text-align:right; font-size:12px; font-weight:700; color:#5f6368;
      }
      .overview-table .detail.left { text-align:left; }
      .overview-table .highlight td { background:#fcfcfd; }
      .overview-table .trend { margin-top:0; }
      .mix-cell { min-width:170px; }
      .mix-line {
        display:flex; align-items:center; justify-content:flex-end; gap:10px;
      }
      .mix-pct {
        min-width:48px; text-align:right; font-size:12px; font-weight:800; color:#202124;
      }
      .mix-bar {
        width:92px; height:8px; border-radius:999px; background:#edf1f4; overflow:hidden;
      }
      .mix-bar-fill { height:100%; border-radius:999px; }
      .active-company-value {
        font-size:32px; font-weight:900; color:#1a73e8; line-height:1; margin-bottom:12px;
      }
      .active-company-note {
        font-size:12px; font-weight:700; color:#5f6368; margin-bottom:14px;
      }
      .stage-type-table .type-cell { min-width:170px; }
      .stage-type-label {
        display:flex; align-items:center; gap:8px; font-size:13px; font-weight:800; color:#202124;
      }
      .stage-type-dot {
        width:10px; height:10px; border-radius:50%; flex-shrink:0;
      }
      .stage-type-table .stage-head-sub {
        display:block; margin-top:3px; font-size:9px; font-weight:700; color:#888;
        text-transform:none; letter-spacing:0;
      }
      .stage-type-table .stage-cell { min-width:120px; }
      .stage-type-table .stage-main {
        font-size:15px; font-weight:900; color:#202124; white-space:nowrap;
      }
      .stage-type-table .stage-sub {
        margin-top:3px; font-size:10px; font-weight:700; color:#888;
      }
      .stage-type-table .total-col { background:#f4fbf6; }
      .daily-vip-table { min-width:640px; }
      .daily-vip-table .day-cell { min-width:110px; font-size:13px; font-weight:800; color:#202124; }
      .daily-vip-table .comparison-cell { min-width:150px; text-align:right; }
      .daily-vip-table .comparison-main {
        font-size:15px; font-weight:900; color:#202124; white-space:nowrap;
      }
      .daily-vip-table .comparison-main.vip { color:#f29900; }
      .daily-vip-table .comparison-main.default { color:#137333; }
      .daily-vip-table .comparison-sub {
        margin-top:3px; font-size:10px; font-weight:700; color:#888;
      }
      .daily-vip-table .comparison-diff {
        display:inline-flex; justify-content:flex-end; align-items:center;
        padding:4px 8px; border-radius:999px; font-size:11px; font-weight:800;
        background:#f1f3f4; color:#5f6368; white-space:nowrap;
      }
      .daily-vip-table .comparison-diff.faster { background:#e6f4ea; color:#137333; }
      .daily-vip-table .comparison-diff.slower { background:#fce8e6; color:#c5221f; }
      .timing-profile-grid {
        display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; margin-top:12px;
      }
      .turnaround-graph-note {
        margin:14px 0 10px; font-size:11px; font-weight:700; color:#5f6368;
      }
      .turnaround-graph-card {
        background:#fff; border:1px solid #e0e0e0; border-radius:12px;
        padding:16px; box-shadow:0 1px 4px rgba(0,0,0,0.04);
      }
      .turnaround-graph-head h5 {
        margin:0; font-size:13px; font-weight:800; color:#202124; text-transform:uppercase; letter-spacing:0.3px;
      }
      .turnaround-graph-subtitle {
        margin-top:4px; font-size:11px; font-weight:600; color:#666;
      }
      .turnaround-graph-meta {
        display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;
      }
      .turnaround-graph-meta span {
        display:inline-flex; align-items:center; gap:4px; padding:6px 10px;
        border-radius:999px; background:#f8f9fa; border:1px solid #eef1f4;
        font-size:11px; font-weight:700; color:#5f6368;
      }
      .turnaround-graph-frame {
        margin-top:12px; padding:10px 10px 4px; border-radius:12px;
        background:linear-gradient(180deg, #fbfcfd 0%, #f7f9fb 100%);
        border:1px solid #eef1f4;
      }
      .turnaround-graph-svg {
        display:block; width:100%; height:auto; overflow:visible;
      }
      .turnaround-graph-empty {
        margin-top:12px; font-size:12px; font-weight:700; color:#888;
      }
      .stats-filter-note {
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        flex-wrap:wrap; font-size:11px; color:#999; font-weight:600;
        margin:-8px 0 20px;
      }
      .stats-filter-note .note-text { font-style:italic; }

      .stats-section-title {
        font-size:14px; font-weight:800; color:#202124;
        text-transform:uppercase; letter-spacing:0.5px;
        margin:25px 0 15px 0; padding-bottom:8px;
        border-bottom:2px solid var(--primary, #db0000);
        display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      }
      .stats-section-title i { color:var(--primary, #db0000); }

      .stats-chart-row { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:25px; }
      @media (max-width:900px) { .stats-chart-row { grid-template-columns:1fr; } }
      .chart-card { background:#fff; border:1px solid #e0e0e0; border-radius:12px; padding:20px; box-shadow:0 1px 4px rgba(0,0,0,0.04); }
      .chart-card h4 { margin:0 0 15px 0; font-size:13px; font-weight:800; color:#202124; text-transform:uppercase; letter-spacing:0.3px; }

      /* ── MULTI-SERIES PIPELINE FLOW CHART ── */
      .ms-toggle-bar {
        display:flex; align-items:center; gap:6px;
        flex-wrap:wrap; padding:12px 16px;
        background:#f8f9fa; border-radius:10px 10px 0 0;
        border:1px solid #e8eaed; border-bottom:none;
      }
      .ms-toggle-divider { width:1px; height:22px; background:#ddd; margin:0 4px; flex-shrink:0; }
      .ms-toggle-label { font-size:9px; font-weight:800; color:#999; text-transform:uppercase; letter-spacing:0.5px; margin-right:2px; }
      .ms-toggle-btn {
        display:inline-flex; align-items:center; gap:5px;
        padding:5px 11px; border-radius:20px;
        border:2px solid transparent; cursor:pointer;
        font-size:11px; font-weight:800;
        transition:all 0.15s; user-select:none; white-space:nowrap;
      }
      .ms-toggle-btn i { font-size:9px; }
      .ms-toggle-btn.active { color:#fff; border-color:transparent; box-shadow:0 2px 6px rgba(0,0,0,0.18); }
      .ms-toggle-btn.inactive { background:#f1f3f4 !important; color:#aaa !important; border-color:#e0e0e0 !important; box-shadow:none; }

      /* Dimension mode toggle */
      .dim-mode-wrap { display:inline-flex; background:#e8eaed; border-radius:8px; padding:2px; gap:2px; }
      .dim-mode-btn {
        padding:5px 12px; border:none; border-radius:6px; cursor:pointer;
        font-size:10px; font-weight:800; color:#5f6368;
        background:transparent; transition:all 0.15s; display:flex; align-items:center; gap:5px;
      }
      .dim-mode-btn.active { background:#fff; color:#202124; box-shadow:0 1px 3px rgba(0,0,0,0.12); }
      .dim-mode-btn:hover:not(.active) { background:rgba(0,0,0,0.06); }
      .pipeline-control-wrap { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }

      /* Chart area */
      .ms-chart-wrap {
        background:#fff; border:1px solid #e8eaed;
        border-radius:0 0 10px 10px;
        overflow-x:auto; padding:16px 16px 10px;
      }
      .ms-chart-subtitle { font-size:10px; color:#999; font-weight:600; font-style:italic; margin-bottom:12px; padding-left:2px; }
      .ms-chart-highlights { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin:0 0 14px; }
      .ms-highlight-card { background:#f8f9fa; border:1px solid #e8eaed; border-radius:10px; padding:10px 12px; }
      .ms-highlight-label { font-size:9px; font-weight:800; color:#777; text-transform:uppercase; letter-spacing:0.4px; }
      .ms-highlight-value { font-size:16px; font-weight:900; color:#202124; line-height:1.2; margin-top:6px; }
      .ms-highlight-sub { font-size:10px; font-weight:700; color:#666; margin-top:4px; }
      .ms-chart { display:flex; align-items:flex-end; gap:0; min-height:180px; padding-bottom:4px; min-width:max-content; }
      .ms-bucket { display:flex; flex-direction:column; align-items:center; min-width:0; flex:1; min-width:26px; }
      .ms-groups { display:flex; align-items:flex-end; gap:1px; height:150px; justify-content:center; width:100%; padding:0 2px; }
      .ms-bar-group { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:150px; min-width:6px; flex:1; max-width:18px; position:relative; }
      .ms-bar-segment { width:100%; border-radius:2px 2px 0 0; transition:height 0.3s ease; position:relative; }
      .ms-bar-segment + .ms-bar-segment { border-radius:0; margin-top:1px; }
      .ms-bar-segment:last-child { border-radius:2px 2px 0 0; }
      .ms-bar-group-dot { width:100%; height:3px; border-radius:2px; opacity:0.18; }
      .ms-bucket-label { font-size:8px; font-weight:700; color:#777; text-transform:uppercase; text-align:center; margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; padding:0 1px; }
      .ms-chart.hourly .ms-bucket { min-width:32px; }
      .ms-chart.hourly .ms-bar-group { max-width:20px; }
      .ms-chart.hourly .ms-bucket-label { font-size:9px; }
      .ms-legend { display:flex; flex-wrap:wrap; gap:8px 20px; padding:12px 16px; border-top:1px solid #f0f0f0; margin-top:4px; }
      .ms-legend-item { display:flex; align-items:center; gap:3px; font-size:10px; font-weight:600; color:#666; }
      .ms-legend-swatch { display:inline-block; width:10px; height:10px; border-radius:2px; flex-shrink:0; }
      .ms-empty { display:flex; align-items:center; justify-content:center; height:100px; font-size:13px; color:#bbb; font-style:italic; }

      /* Type grouping drag UI */
      .type-groups-area { display:inline-flex; align-items:center; gap:2px; flex-wrap:wrap; }
      .type-group-pill { display:inline-flex; align-items:center; gap:3px; border-radius:22px; border:2px solid transparent; padding:2px 3px; transition:border-color 0.15s, background 0.15s; cursor:pointer; }
      .type-group-pill.multi { border-color:#d0d7de; background:#f0f2f5; padding:3px 7px 3px 4px; gap:4px; }
      .type-group-pill.drag-over { border-color:#4285f4 !important; background:rgba(66,133,244,0.1) !important; }
      .type-chip { display:inline-flex; align-items:center; gap:4px; padding:5px 11px; border-radius:20px; font-size:11px; font-weight:800; cursor:grab; user-select:none; transition:all 0.15s; white-space:nowrap; border:2px solid transparent; pointer-events:auto; }
      .type-chip i { font-size:9px; }
      .type-chip.active { color:#fff; box-shadow:0 2px 6px rgba(0,0,0,0.18); }
      .type-chip.inactive { background:#f1f3f4 !important; color:#aaa !important; border-color:#e0e0e0 !important; box-shadow:none; }
      .type-chip.dragging { opacity:0.35; }
      .type-chip:active { cursor:grabbing; }
      .type-split-btn { background:none; border:none; cursor:pointer; font-size:11px; color:rgba(255,255,255,0.65); padding:0; margin-left:2px; line-height:1; font-weight:900; transition:color 0.1s; display:inline-block; pointer-events:auto; }
      .type-split-btn:hover { color:#fff; }
      .type-drop-zone { width:10px; min-height:32px; border-radius:6px; flex-shrink:0; border:2px dashed transparent; transition:all 0.12s; display:flex; align-items:center; justify-content:center; }
      .type-drop-zone.drag-active { border-color:#bbb; width:14px; }
      .type-drop-zone.drag-over { border-color:#4285f4; background:rgba(66,133,244,0.12); width:20px; }

      /* Bar Chart (legacy) */
      .bar-chart { display:flex; align-items:flex-end; height:220px; gap:6px; padding-top:10px; }
      .bar-group { flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; min-width:0; }
      .bar-stack { width:100%; display:flex; flex-direction:column; align-items:center; height:160px; justify-content:flex-end; }
      .bar { width:100%; max-width:44px; border-radius:4px 4px 0 0; transition:height 0.3s ease; position:relative; display:flex; align-items:center; justify-content:center; }
      .bar.real   { background:linear-gradient(to top, #137333, #34a853); }
      .bar.filler { background:linear-gradient(to top, #e37400, #fbbc04); margin-top:1px; border-radius:0; }
      .bar-label { font-size:9px; font-weight:700; color:#666; text-transform:uppercase; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
      .bar-value { font-size:11px; font-weight:800; color:#202124; margin-bottom:2px; }

      /* Organization Table */
      .org-table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; margin-bottom:20px; }
      .org-table th { background:#f8f9fa; padding:12px 15px; text-align:left; font-size:10px; color:#555; text-transform:uppercase; font-weight:800; border-bottom:1px solid #e0e0e0; letter-spacing:0.3px; }
      .org-sort-btn { border:0; background:transparent; color:inherit; font:inherit; text-transform:inherit; letter-spacing:inherit; font-weight:inherit; padding:0; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
      .org-sort-btn:hover { color:#202124; }
      .org-sort-btn i { font-size:9px; opacity:0.75; }
      .org-table td { padding:12px 15px; border-bottom:1px solid #f0f0f0; font-size:13px; vertical-align:middle; }
      .org-table tr:hover td { background:#fafbfc; }
      .org-table .org-name { font-weight:700; color:#202124; display:flex; align-items:center; gap:8px; }
      .org-table .org-name .org-dot {
        width:8px; height:8px; border-radius:50%; background:var(--primary, #db0000);
        display:inline-block; flex-shrink:0;
      }
      .org-table .num { font-weight:700; text-align:right; }
      .org-table .num.green  { color:#137333; }
      .org-table .num.orange { color:#e37400; }
      .org-table .num.purple { color:#8430ce; }
      .org-table .num.blue   { color:#1a73e8; }

      /* Technician Cards */
      .tech-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:15px; }
      .tech-card { background:#fff; border:1px solid #e0e0e0; border-radius:12px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.04); transition:transform 0.15s, box-shadow 0.15s; }
      .tech-card:hover { transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,0.08); }
      .tech-card-header { padding:15px 18px; background:linear-gradient(135deg, #667eea 0%, #764ba2 100%); color:#fff; }
      .tech-card-header h4 { margin:0; font-size:15px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .tech-card-header .email { font-size:11px; opacity:0.9; margin-top:2px; font-weight:600; }
      .tech-card-body { padding:15px 18px; }
      .tech-stats-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:12px; }
      .tech-stat { text-align:center; padding:10px 8px; background:#f8f9fa; border-radius:8px; }
      .tech-stat .val { font-size:20px; font-weight:900; color:#202124; line-height:1; }
      .tech-stat .val.green  { color:#137333; }
      .tech-stat .val.orange { color:#e37400; }
      .tech-stat .val.blue   { color:#1a73e8; }
      .tech-stat .val.purple { color:#8430ce; }
      .tech-stat .lbl { font-size:9px; font-weight:700; color:#666; text-transform:uppercase; margin-top:4px; letter-spacing:0.3px; }
      .tech-trend-chart { display:flex; align-items:flex-end; height:50px; gap:3px; margin-top:10px; padding:8px; background:#f8f9fa; border-radius:8px; }
      .tech-trend-bar { flex:1; background:linear-gradient(to top, #1a73e8, #4285f4); border-radius:2px 2px 0 0; min-height:2px; transition:height 0.3s; }
      .tech-payout { display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding:10px 12px; background:#e8f5e9; border-radius:8px; }
      .tech-payout .label { font-size:10px; font-weight:700; color:#137333; text-transform:uppercase; }
      .tech-payout .amount { font-size:18px; font-weight:900; color:#137333; }

      /* Complexity Distribution */
      .complexity-grid { display:grid; grid-template-columns:repeat(5, 1fr); gap:10px; margin-bottom:15px; }
      @media (max-width:700px) { .complexity-grid { grid-template-columns:repeat(3, 1fr); } }
      .complexity-card { background:#fff; border:1px solid #e0e0e0; border-radius:10px; padding:14px 12px; text-align:center; position:relative; overflow:hidden; }
      .complexity-card .c-count { font-size:26px; font-weight:900; color:#202124; line-height:1; margin-bottom:4px; }
      .complexity-card .c-pct   { font-size:12px; font-weight:800; color:#666; margin-bottom:6px; }
      .complexity-card .c-label { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:0.3px; }
      .complexity-card .c-rate  { font-size:10px; font-weight:700; color:#888; margin-top:3px; }

      /* Stage Timing */
      .stage-timing-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:15px; }
      .stage-card { background:#fff; border:1px solid #e0e0e0; border-radius:10px; padding:14px; text-align:center; }
      .stage-card .s-val { font-size:22px; font-weight:900; color:#202124; line-height:1; margin-bottom:4px; }
      .stage-card .s-lbl { font-size:10px; font-weight:800; color:#666; text-transform:uppercase; letter-spacing:0.3px; }
      .stage-card .s-sub { font-size:10px; font-weight:700; color:#888; margin-top:4px; }

      /* Cost Breakdown Table */
      .cost-breakdown { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; margin-bottom:15px; }
      .cost-breakdown th { background:#f8f9fa; padding:10px 14px; text-align:left; font-size:10px; color:#555; text-transform:uppercase; font-weight:800; border-bottom:1px solid #e0e0e0; }
      .cost-breakdown td { padding:10px 14px; border-bottom:1px solid #f0f0f0; font-size:13px; }
      .cost-breakdown tr:hover td { background:#fafbfc; }
      .cost-breakdown .cat-label { font-weight:700; color:#202124; display:flex; align-items:center; gap:8px; }
      .cost-breakdown .cat-label i { font-size:12px; }
      .cost-breakdown .r { text-align:right; font-weight:700; }
      .cost-breakdown .r.green  { color:#137333; }
      .cost-breakdown .r.orange { color:#e37400; }
      .cost-breakdown .r.blue   { color:#1a73e8; }
      .cost-breakdown .r.red    { color:#c5221f; }
      .cost-breakdown .totals td { font-weight:900; border-top:2px solid #e0e0e0; background:#f8f9fa; }

      /* QA Stats */
      .qa-stats-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:15px; }
      .qa-stat-box { background:#f8f9fa; border:1px solid #e0e0e0; border-radius:10px; padding:14px; text-align:center; }
      .qa-stat-box .val { font-size:24px; font-weight:900; color:#202124; }
      .qa-stat-box .val.success { color:#137333; }
      .qa-stat-box .val.warning { color:#e37400; }
      .qa-stat-box .lbl { font-size:10px; font-weight:700; color:#666; text-transform:uppercase; margin-top:4px; }

      /* Loading & Empty */
      .stats-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; color:#666; }
      .stats-loading i { font-size:40px; margin-bottom:15px; opacity:0.4; }
      .stats-loading p { font-size:14px; font-weight:600; }
      .stats-empty { text-align:center; padding:40px 20px; color:#999; }
      .stats-empty i { font-size:48px; margin-bottom:12px; opacity:0.3; }
      .stats-empty p { font-size:14px; }

      @media (max-width:600px) {
        .stats-summary { grid-template-columns:repeat(2, 1fr); }
        .summary-card .value { font-size:22px; }
        .tech-stats-grid { grid-template-columns:repeat(2, 1fr); }
        .stats-overview-grid { grid-template-columns:1fr; }
        .timing-profile-grid { grid-template-columns:1fr; }
        .stats-filter-note { align-items:flex-start; }
        .date-mode-toggle { margin-left:0; }
        .stats-date-nav { justify-content:flex-start; }
        .date-nav-label { min-width:auto; text-align:left; }
        .active-company-card { align-items:flex-start; flex-direction:column; }
      }

      /* Date mode toggle */
      .date-mode-toggle { display:inline-flex; gap:4px; margin-left:15px; background:#f1f3f4; padding:3px; border-radius:8px; }
      .date-mode-btn { padding:6px 12px; border:none; background:transparent; border-radius:6px; cursor:pointer; font-size:11px; font-weight:700; color:#5f6368; display:flex; align-items:center; gap:5px; transition:all 0.15s; }
      .date-mode-btn:hover { background:#e8eaed; color:#202124; }
      .date-mode-btn.active { background:#fff; color:var(--primary, #db0000); box-shadow:0 1px 3px rgba(0,0,0,0.1); }
      .date-mode-btn i { font-size:10px; }

      /* Revenue by type table */
      .rev-by-type { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:10px; margin-bottom:20px; }
      .rev-type-card { background:#fff; border:1px solid #e0e0e0; border-radius:10px; padding:14px; text-align:center; }
      .rev-type-card .rv-count { font-size:22px; font-weight:900; line-height:1; }
      .rev-type-card .rv-label { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:0.3px; margin:4px 0 2px; }
      .rev-type-card .rv-price { font-size:11px; font-weight:700; color:#666; }
      .rev-type-card .rv-rev   { font-size:14px; font-weight:800; color:#137333; margin-top:4px; }
    `;
    const style = document.createElement('style');
    style.id = 'statsPluginStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureMarkup() {
    const host = document.getElementById('portalPluginViews');
    if (!host) return;
    if (document.getElementById('view-stats')) return;
    const wrap = document.createElement('div');
    wrap.id = 'view-stats';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="stats-container">
        <div class="header-bar">
          <h1><i class="fas fa-chart-bar" style="margin-right:10px;"></i>Statistics</h1>
          <div style="display:flex; gap:10px;">
            <button class="btn-secondary" id="statsRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
            <button class="btn-secondary" id="statsExportBtn"><i class="fas fa-download"></i> Export</button>
          </div>
        </div>
        <div class="stats-period-tabs">
          <div class="stats-period-group">
            <button class="period-tab" data-period="daily">Daily</button>
            <button class="period-tab active" data-period="weekly">Weekly</button>
            <button class="period-tab" data-period="monthly">Monthly</button>
            <button class="period-tab" data-period="rolling7">Rolling 7 Days</button>
          </div>
          <div class="stats-date-nav">
            <button class="date-nav-btn" id="statsPrevBtn"><i class="fas fa-chevron-left"></i></button>
            <div class="date-nav-label" id="statsDateLabel">Loading...</div>
            <button class="date-nav-btn" id="statsNextBtn"><i class="fas fa-chevron-right"></i></button>
            <button class="date-nav-btn" id="statsTodayBtn" style="width:auto; padding:0 12px; font-size:12px; font-weight:700;">Today</button>
          </div>
        </div>
        <div class="stats-scroll" id="statsContent">
          <div class="stats-loading"><i class="fas fa-spinner fa-spin"></i><p>Loading statistics...</p></div>
        </div>
      </div>
    `;
    host.appendChild(wrap);
  }

  // =========================================================================
  //  STATE
  // =========================================================================
  let allProjects   = [];
  let allUsers      = [];
  let currentPeriod = 'weekly';
  let currentDate   = new Date();
  let orgSortState  = { key: 'total', dir: 'desc' };
  let statsDataLoadedAt = 0;
  const STATS_DATA_CACHE_MS = 5 * 60 * 1000;
  const STATS_PROJECT_PAGE_LIMIT = 150;
  const STATS_PROJECT_BATCH_SIZE = 10;
  const STATS_LEDGER_BATCH_SIZE = 6;
  const STATS_LEDGER_MAX_PAGES_PER_ORG = 20;
  const STATS_LEDGER_MAX_ORGS_PER_EXPORT = 24;
  const STATS_API_TIMEOUT_MS = 30000;
  const STATS_PROJECTS_TIMEOUT_MS = 45000;
  const STATS_LEDGER_DETAIL_TIMEOUT_MS = 12000;

  // =========================================================================
  //  UTILITY FUNCTIONS
  // =========================================================================
  function withTimeout(promise, ms, label){
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || 'Request timed out')), Math.max(1000, Number(ms || 0) || 1000));
    });
    return Promise.race([
      Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
      timeout
    ]);
  }

  function nextFrame(){
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function fmtCurrency(n) {
    const num = parseFloat(n) || 0;
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function fmtCurrencyShort(n) {
    const num = parseFloat(n) || 0;
    if (num >= 1000) return '$' + (num/1000).toFixed(1) + 'k';
    return '$' + num.toFixed(0);
  }

  function parseDate(d) {
    if (!d) return null;
    try {
      let str = String(d).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str + 'T12:00:00Z');
      str = str.replace(' ', 'T');
      const hasTz = str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str) || /[+-]\d{4}$/.test(str);
      if (!hasTz) str += 'Z';
      const parsed = new Date(str);
      if (isNaN(parsed.getTime())) return null;
      return parsed;
    } catch(e) { return null; }
  }

  function getProjectDateForMode(p) {
    if (chartDateMode === 'drawn')     return parseDate(p.uploaded_at || p.started_at);
    if (chartDateMode === 'completed') return parseDate(p.completed_at || p.qa_approved_at || p.qa_completed_at);
    return parseDate(p.created_at || p.submitted_at);
  }

  function getRequestedDate(p) {
    return parseDate(p.created_at || p.submitted_at);
  }

  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TURNAROUND_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  function getPacificParts(date) {
    const parts = {};
    pacificFormatter.formatToParts(date).forEach(part => {
      if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
    });
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour || 0,
      minute: parts.minute || 0,
      second: parts.second || 0,
    };
  }

  function getPacificOffsetMs(date) {
    const p = getPacificParts(date);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - date.getTime();
  }

  function makePacificDate(year, month, day, hour = 0, minute = 0, second = 0) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    let result = new Date(utcGuess - getPacificOffsetMs(new Date(utcGuess)));
    result = new Date(utcGuess - getPacificOffsetMs(result));
    return result;
  }

  function pacificDayStart(parts, hour) {
    return makePacificDate(parts.year, parts.month, parts.day, hour, 0, 0);
  }

  function pacificNextDayStart(parts, hour) {
    return makePacificDate(parts.year, parts.month, parts.day + 1, hour, 0, 0);
  }

  function samePacificDay(a, b) {
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  function getPacificHourValue(parts) {
    return parts.hour + (parts.minute / 60) + (parts.second / 3600);
  }

  function countPacificWorkMs(start, end) {
    if (!start || !end || end <= start) return 0;
    let total = 0;
    let cursor = new Date(start);
    let guard = 0;
    while (cursor < end && guard < 3700) {
      guard++;
      const parts = getPacificParts(cursor);
      const dayWorkStart = pacificDayStart(parts, WORK_SHIFT_START_HOUR);
      const dayWorkEnd = pacificDayStart(parts, WORK_SHIFT_END_HOUR);
      const intervalStart = new Date(Math.max(cursor.getTime(), dayWorkStart.getTime()));
      const intervalEnd = new Date(Math.min(end.getTime(), dayWorkEnd.getTime()));
      if (intervalEnd > intervalStart) total += intervalEnd - intervalStart;
      const nextWorkStart = pacificNextDayStart(parts, WORK_SHIFT_START_HOUR);
      if (nextWorkStart <= cursor) break;
      cursor = nextWorkStart;
    }
    return total;
  }

  function getShiftTurnaroundInfo(requested, finished) {
    if (!requested || !finished || finished <= requested) return null;
    const requestParts = getPacificParts(requested);
    const finishParts = getPacificParts(finished);
    const requestHour = getPacificHourValue(requestParts);
    const requestShiftEnd = pacificDayStart(requestParts, WORK_SHIFT_END_HOUR);
    const finishedSameShift = samePacificDay(requestParts, finishParts) && finished <= requestShiftEnd;

    let effectiveStart = requested;
    if (requestHour < WORK_SHIFT_START_HOUR) {
      effectiveStart = pacificDayStart(requestParts, WORK_SHIFT_START_HOUR);
    } else if (requestHour >= CUSTOMER_INTAKE_END_HOUR && !finishedSameShift) {
      effectiveStart = pacificNextDayStart(requestParts, WORK_SHIFT_START_HOUR);
    }

    const effectiveParts = getPacificParts(effectiveStart);
    const shiftDeadline = pacificDayStart(effectiveParts, WORK_SHIFT_END_HOUR);
    const workMs = countPacificWorkMs(effectiveStart, finished);
    return {
      workMs,
      missedShift: finished > shiftDeadline,
    };
  }

  function getCompletedTurnaroundInfo(p) {
    const requested = getRequestedDate(p);
    const completed = parseDate(p.completed_at || p.qa_approved_at || p.qa_completed_at);
    return getShiftTurnaroundInfo(requested, completed);
  }

  function getRejectionTurnaroundInfo(p) {
    return getShiftTurnaroundInfo(getRequestedDate(p), getRejectedDate(p));
  }

  function getStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  function getRolling7Anchor(date) {
    const selectedDay = getStartOfDay(new Date(date));
    return new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate() - 1, 0, 0, 0, 0);
  }

  function fmtPercent(value, digits = 0) {
    const num = Number.isFinite(value) ? value : 0;
    return `${num.toFixed(digits)}%`;
  }

  function fmtMetricNumber(value, digits = 1) {
    const num = Number(value) || 0;
    if (Math.abs(num - Math.round(num)) < 0.0001) return Math.round(num).toLocaleString('en-US');
    return num.toLocaleString('en-US', { minimumFractionDigits:digits, maximumFractionDigits:digits });
  }

  function fmtShortDate(date, includeYear = false) {
    return new Date(date).toLocaleDateString('en-US', includeYear
      ? { month:'short', day:'numeric', year:'numeric' }
      : { month:'short', day:'numeric' });
  }

  function getSummaryDateBasisLabel() {
    if (chartDateMode === 'requested') return 'date requested';
    if (chartDateMode === 'drawn') return 'date drawn';
    return 'date completed';
  }

  function getTimingProjectType(p) {
    if (isTestProject(p)) return 'test';
    if (p.is_filler) return 'filler';
    if (p.is_vip) return 'vip';
    return 'real';
  }

  function isRejectedProject(p) {
    const status = String(p?.status || '').toLowerCase();
    return status === 'rejected' || status === 'rejected_no_coverage';
  }

  function getRejectedDate(p) {
    const direct = parseDate(p.rejected_at);
    if (direct) return direct;
    const history = Array.isArray(p.work_history) ? p.work_history : [];
    for (let i = history.length - 1; i >= 0; i--) {
      const event = history[i];
      const eventName = String(event?.event || '').toLowerCase();
      if (eventName === 'rejected_no_coverage' || eventName === 'rejected') {
        const ts = parseDate(event.ts);
        if (ts) return ts;
      }
    }
    return null;
  }

  function getRangeDayCount(range) {
    return Math.max(1, Math.round((range.end - range.start) / 86400000));
  }

  function emptyStageAccumulator() {
    return { queue:[], work:[], qa:[], total:[] };
  }

  function addProjectStageTimes(acc, p) {
    const created    = getRequestedDate(p);
    const assigned   = parseDate(p.assigned_at || p.started_at);
    const started    = parseDate(p.started_at);
    const completed  = parseDate(p.completed_at);
    const uploaded   = parseDate(p.uploaded_at);
    const qaClaimed  = parseDate(p.qa_claimed_at || p.qa_started_at);
    const qaApproved = parseDate(p.qa_approved_at || p.qa_completed_at);
    const workStart = assigned || started;
    if (created && workStart && workStart > created) acc.queue.push(workStart - created);
    const workEnd = uploaded || completed;
    if (workStart && workEnd && workEnd > workStart) acc.work.push(workEnd - workStart);
    else if (started && workEnd && workEnd > started) acc.work.push(workEnd - started);
    const qaStart = uploaded || completed;
    const qaEnd   = qaApproved || completed;
    if (qaStart && qaEnd && qaEnd > qaStart) acc.qa.push(qaEnd - qaStart);
    else if (qaClaimed && qaApproved && qaApproved > qaClaimed) acc.qa.push(qaApproved - qaClaimed);
    const finalEnd = completed || qaApproved;
    if (created && finalEnd && finalEnd > created) acc.total.push(finalEnd - created);
  }

  function summarizeStageTimes(acc) {
    const avg = arr => arr.length > 0 ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
    return {
      queue: { avg:avg(acc.queue), count:acc.queue.length },
      work:  { avg:avg(acc.work),  count:acc.work.length  },
      qa:    { avg:avg(acc.qa),    count:acc.qa.length    },
      total: { avg:avg(acc.total), count:acc.total.length },
    };
  }

  function getPercentile(sortedValues, percentile) {
    if (!sortedValues.length) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const pos = (sortedValues.length - 1) * percentile;
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    if (lower === upper) return sortedValues[lower];
    const weight = pos - lower;
    return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * weight);
  }

  function fmtDurationAxisLabel(ms) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    if (totalMinutes === 0) return '';
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const totalHours = totalMinutes / 60;
    if (totalHours < 24) {
      const roundedHours = Math.round(totalHours * 10) / 10;
      return Number.isInteger(roundedHours) ? `${roundedHours}h` : `${roundedHours.toFixed(1)}h`;
    }
    const totalDays = totalHours / 24;
    const roundedDays = Math.round(totalDays * 10) / 10;
    return Number.isInteger(roundedDays) ? `${roundedDays}d` : `${roundedDays.toFixed(1)}d`;
  }

  function getNiceDurationAxis(maxMs) {
    const steps = [
      15 * 60000,
      30 * 60000,
      60 * 60000,
      2 * 60 * 60000,
      3 * 60 * 60000,
      4 * 60 * 60000,
      6 * 60 * 60000,
      8 * 60 * 60000,
      12 * 60 * 60000,
      24 * 60 * 60000,
      2 * 24 * 60 * 60000,
      3 * 24 * 60 * 60000,
      7 * 24 * 60 * 60000,
    ];
    const targetTicks = 5;
    let bestStep = steps[0];
    let bestScore = Infinity;

    steps.forEach(step => {
      const tickCount = Math.max(1, Math.ceil(maxMs / step));
      const score = Math.abs(tickCount - targetTicks) + (tickCount > 7 ? 4 : 0) + (tickCount < 3 ? 2 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestStep = step;
      }
    });

    const axisMax = Math.max(bestStep, Math.ceil(maxMs / bestStep) * bestStep);
    return { step: bestStep, max: axisMax };
  }

  function summarizeDurationProfile(values) {
    const samples = (values || []).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!samples.length) {
      return {
        count: 0,
        median: 0,
        p25: 0,
        p75: 0,
        p90: 0,
        max: 0,
        outlierThreshold: 0,
        outlierCount: 0,
      };
    }
    const p25 = getPercentile(samples, 0.25);
    const median = getPercentile(samples, 0.5);
    const p75 = getPercentile(samples, 0.75);
    const p90 = getPercentile(samples, 0.9);
    const max = samples[samples.length - 1];
    const iqr = Math.max(0, p75 - p25);
    const outlierThreshold = iqr > 0 ? p75 + (1.5 * iqr) : p90;
    const outlierCount = samples.filter(v => v > outlierThreshold).length;
    return {
      count: samples.length,
      median,
      p25,
      p75,
      p90,
      max,
      outlierThreshold,
      outlierCount,
    };
  }

  function summarizeShiftTurnaroundInfos(infos) {
    const validInfos = (infos || []).filter(info => info && Number.isFinite(info.workMs) && info.workMs > 0);
    const profile = summarizeDurationProfile(validInfos.map(info => info.workMs));
    profile.missedShiftCount = validInfos.filter(info => info.missedShift).length;
    profile.missedShiftPct = profile.count > 0 ? (profile.missedShiftCount / profile.count) * 100 : 0;
    return profile;
  }

  function buildDailyVipCompletionComparison(projects, range) {
    const rowsByDay = new Map();
    let cursor = getStartOfDay(range.start);
    while (cursor < range.end) {
      const key = getLocalDateKey(cursor);
      rowsByDay.set(key, {
        key,
        label: fmtShortDate(cursor, range.end.getFullYear() !== range.start.getFullYear()),
        vip: [],
        default: [],
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
    }

    projects.forEach(p => {
      if (isRejectedProject(p) || isTestProject(p) || p.is_filler) return;
      const completed = parseDate(p.completed_at || p.qa_approved_at || p.qa_completed_at);
      if (!completed || completed < range.start || completed >= range.end) return;
      const dayKey = getLocalDateKey(completed);
      const row = rowsByDay.get(dayKey);
      if (!row) return;
      const info = getCompletedTurnaroundInfo(p);
      if (!info || !Number.isFinite(info.workMs) || info.workMs <= 0) return;
      if (p.is_vip) row.vip.push(info.workMs);
      else row.default.push(info.workMs);
    });

    const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return Array.from(rowsByDay.values()).map(row => {
      const vipAvg = avg(row.vip);
      const defaultAvg = avg(row.default);
      const deltaMs = (vipAvg > 0 && defaultAvg > 0) ? (defaultAvg - vipAvg) : 0;
      const pctFaster = (vipAvg > 0 && defaultAvg > 0)
        ? (deltaMs / defaultAvg) * 100
        : null;
      return {
        key: row.key,
        label: row.label,
        vipAvg,
        vipCount: row.vip.length,
        defaultAvg,
        defaultCount: row.default.length,
        deltaMs,
        pctFaster,
      };
    });
  }

  function getCompanyKey(p) {
    const orgId = p.organization_id;
    const raw = orgId !== null && orgId !== undefined ? String(orgId).trim() : '';
    if (raw !== '' && raw.toLowerCase() !== 'unknown') {
      return `org:${orgId}`;
    }
    return null;
  }

  function getOrgCompanyKey(org) {
    const raw = org && org.id !== null && org.id !== undefined ? String(org.id).trim() : '';
    if (raw === '') return null;
    return `org:${raw}`;
  }

  function collectOrderedCompanyKeys(projects, start, end) {
    const companies = new Set();
    projects.forEach(p => {
      if (isTestProject(p)) return;
      const requested = getRequestedDate(p);
      const key = getCompanyKey(p);
      if (!requested || !key) return;
      if (requested >= start && requested < end) companies.add(key);
    });
    return companies;
  }

  function collectSignedUpCompanyKeys(orgs, start, end) {
    const companies = new Set();
    (orgs || []).forEach(org => {
      if (!org || org.is_test) return;
      const created = parseDate(org.created_at);
      const key = getOrgCompanyKey(org);
      if (!created || !key) return;
      if (created >= start && created < end) companies.add(key);
    });
    return companies;
  }

  function setIntersectionSize(a, b) {
    let total = 0;
    const smaller = a.size <= b.size ? a : b;
    const larger = a.size <= b.size ? b : a;
    smaller.forEach(value => {
      if (larger.has(value)) total++;
    });
    return total;
  }

  function countActiveCompaniesInRange(projects, start, end) {
    return collectOrderedCompanyKeys(projects, start, end).size;
  }

  function calculateWeeklyActiveCompanyStats(projects, range, period) {
    if (period === 'daily') {
      const anchor = getStartOfDay(range.start);
      const windowStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6, 0, 0, 0, 0);
      const windowEnd   = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1, 0, 0, 0, 0);
      const value = countActiveCompaniesInRange(projects, windowStart, windowEnd);
      return {
        label: 'Weekly Active Companies',
        value,
        displayValue: fmtMetricNumber(value, 0),
        note: `Trailing 7-day window ending ${fmtShortDate(anchor, true)}`,
        basis: 'Requested date',
      };
    }

    if (period === 'monthly') {
      const today = new Date();
      const todayStart = getStartOfDay(today);
      const sampleEnd = range.end > today
        ? new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 1, 0, 0, 0, 0)
        : range.end;
      const dailyCounts = [];
      let cursor = new Date(range.start);
      while (cursor < sampleEnd) {
        const dayStart = getStartOfDay(cursor);
        const windowStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - 6, 0, 0, 0, 0);
        const windowEnd   = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1, 0, 0, 0, 0);
        dailyCounts.push(countActiveCompaniesInRange(projects, windowStart, windowEnd));
        cursor = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1, 0, 0, 0, 0);
      }
      const value = dailyCounts.length
        ? (dailyCounts.reduce((sum, count) => sum + count, 0) / dailyCounts.length)
        : 0;
      return {
        label: 'Avg Weekly Active Companies',
        value,
        displayValue: fmtMetricNumber(value, 1),
        note: `Average trailing 7-day active companies across ${dailyCounts.length || 0} day${dailyCounts.length === 1 ? '' : 's'}`,
        basis: 'Requested date',
      };
    }

    const value = countActiveCompaniesInRange(projects, range.start, range.end);
    return {
      label: 'Weekly Active Companies',
      value,
      displayValue: fmtMetricNumber(value, 0),
      note: period === 'rolling7'
        ? `Rolling 7-day window: ${range.label}`
        : 'Companies with at least one order in the selected period',
      basis: 'Requested date',
    };
  }

  function calculateCompanyMetrics(projects, orgs, range, period) {
    const orderedCompanies = collectOrderedCompanyKeys(projects, range.start, range.end);
    const signedUpCompanies = collectSignedUpCompanyKeys(orgs, range.start, range.end);
    const weeklyActiveCompanies = calculateWeeklyActiveCompanyStats(projects, range, period);

    return {
      weeklyActiveCompanies,
      companiesOrdered: {
        label: 'Companies Ordered',
        value: orderedCompanies.size,
        displayValue: fmtMetricNumber(orderedCompanies.size, 0),
        note: 'Companies with at least one report order in the selected period',
      },
      companySignups: {
        label: 'Company Sign-Ups',
        value: signedUpCompanies.size,
        displayValue: fmtMetricNumber(signedUpCompanies.size, 0),
        note: 'Companies created during the selected period',
      },
      activeCompanySignups: {
        label: 'Active Company Sign-Ups',
        value: setIntersectionSize(orderedCompanies, signedUpCompanies),
        displayValue: fmtMetricNumber(setIntersectionSize(orderedCompanies, signedUpCompanies), 0),
        note: 'Companies created during the selected period that also ordered in the same period',
      },
    };
  }

  function getDateRange(date, period) {
    const d = new Date(date);
    let start, end, label;
    if (period === 'daily') {
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      end   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
      label = d.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    } else if (period === 'weekly') {
      const day = d.getDay();
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0);
      end   = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, 0);
      const endDisplay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
      label = start.toLocaleDateString('en-US', { month:'short', day:'numeric' }) +
              ' – ' + endDisplay.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    } else if (period === 'rolling7') {
      const anchor = getRolling7Anchor(d);
      start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6, 0, 0, 0, 0);
      end   = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1, 0, 0, 0, 0);
      label = fmtShortDate(start) + ' - ' + fmtShortDate(anchor, true);
    } else {
      start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
      end   = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
      label = d.toLocaleDateString('en-US', { month:'long', year:'numeric' });
    }
    return { start, end, label };
  }

  function canNavigateForward(date, period) {
    if (period === 'rolling7') {
      const selectedDay = getStartOfDay(new Date(date));
      return selectedDay < getStartOfDay(new Date());
    }
    return getDateRange(date, period).end <= new Date();
  }

  function navigateDate(direction) {
    const d = new Date(currentDate);
    if (currentPeriod === 'daily')        d.setDate(d.getDate() + direction);
    else if (currentPeriod === 'weekly')  d.setDate(d.getDate() + (direction * 7));
    else if (currentPeriod === 'monthly') d.setMonth(d.getMonth() + direction);
    else if (currentPeriod === 'rolling7') d.setDate(d.getDate() + direction);
    currentDate = d;
    renderStats();
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    const days = Math.floor(h / 24);
    const rh = h % 24;
    if (days >= 1 && rh === 0) return `${days}d`;
    return `${days}d ${rh}h`;
  }

  function getLedgerEntryDate(entry) {
    if (!entry) return null;
    const raw = entry.ts ?? entry.created_at ?? entry.createdAt ?? entry.timestamp ?? entry.date;
    if (raw == null || raw === '') return null;
    const numeric = Number(raw);
    const parsed = Number.isFinite(numeric) && String(raw).trim() !== ''
      ? new Date(numeric > 100000000000 ? numeric : numeric * 1000)
      : new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function statsRevenueRangeKey(range) {
    const startMs = range?.start instanceof Date ? range.start.getTime() : 0;
    const endMs = range?.end instanceof Date ? range.end.getTime() : 0;
    return `${startMs}:${endMs}`;
  }

  function getActualRevenueAmount(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    const delta = Number(entry.delta ?? entry.amount ?? entry.credit_delta ?? entry.value ?? 0);
    if (!(delta > 0)) return 0;

    const reason = String(entry.reason || entry.type || entry.event || '').toLowerCase();
    const meta = (entry.meta && typeof entry.meta === 'object') ? entry.meta : {};

    const isStripeCheckout = [
      'stripe_checkout_paid',
      'stripe_checkout_completed',
      'stripe_payment_succeeded',
      'stripe_manual_fulfill',
      'credit_purchase',
      'credits_purchase',
      'credits_loaded',
    ].includes(reason) || (reason.includes('checkout') && reason.includes('paid'));
    const isStripeAutoTopup = reason === 'stripe_auto_topup' || reason === 'stripe_autotopup' || reason.includes('auto_topup') || reason.includes('autotopup');

    if (isStripeCheckout) {
      const paidDollars = firstPositiveNumber(
        meta.paid_dollars,
        meta.paidDollars,
        meta.amount_paid_dollars,
        meta.charged_dollars,
        meta.amount_dollars,
        entry.paid_dollars,
        entry.amount_paid_dollars,
        entry.charged_dollars,
        entry.amount_dollars
      );
      if (paidDollars > 0) return paidDollars;

      const bonusDollars = Number(meta.bonus_dollars || 0);
      if (bonusDollars > 0) return Math.max(0, delta - bonusDollars);

      const amountTotal = firstPositiveNumber(meta.amount_total, meta.amountTotal, entry.amount_total, entry.amountTotal);
      if (amountTotal > 0) return amountTotal / 100;

      return delta;
    }

    if (isStripeAutoTopup) {
      const topupDollars = firstPositiveNumber(
        meta.topup_dollars,
        meta.topupDollars,
        meta.paid_dollars,
        meta.amount_dollars,
        entry.topup_dollars,
        entry.amount_dollars
      );
      if (topupDollars > 0) return topupDollars;

      const amountCents = firstPositiveNumber(meta.amount_cents, meta.amountCents, meta.amount_total, entry.amount_cents, entry.amountCents, entry.amount_total);
      if (amountCents > 0) return amountCents / 100;
      return delta;
    }

    return 0;
  }

  function calculateActualRevenue(orgs, range) {
    const override = statsActualRevenueByRange.get(statsRevenueRangeKey(range));
    if (Number.isFinite(override)) return override;

    const { start, end } = range;
    return (orgs || []).reduce((sum, org) => {
      if (!org || org.is_test || org.is_test_org) return sum;
      const ledger = Array.isArray(org.credits_ledger) ? org.credits_ledger : [];
      return sum + ledger.reduce((orgSum, entry) => {
        const ts = getLedgerEntryDate(entry);
        if (!ts || ts < start || ts >= end) return orgSum;
        return orgSum + getActualRevenueAmount(entry);
      }, 0);
    }, 0);
  }

  function getPreviousStatsRange(range) {
    const { start, end } = range;
    let prevStart, prevEnd;
    if (currentPeriod === 'daily') {
      prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()-1, 0,0,0,0);
      prevEnd   = new Date(end.getFullYear(),   end.getMonth(),   end.getDate()-1,   0,0,0,0);
    } else if (currentPeriod === 'weekly') {
      prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()-7, 0,0,0,0);
      prevEnd   = new Date(end.getFullYear(),   end.getMonth(),   end.getDate()-7,   0,0,0,0);
    } else if (currentPeriod === 'rolling7') {
      prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()-7, 0,0,0,0);
      prevEnd   = new Date(end.getFullYear(),   end.getMonth(),   end.getDate()-7,   0,0,0,0);
    } else {
      prevStart = new Date(start.getFullYear(), start.getMonth()-1, 1, 0,0,0,0);
      prevEnd   = new Date(end.getFullYear(),   end.getMonth(),     1, 0,0,0,0);
    }
    return { start: prevStart, end: prevEnd };
  }

  function orgLedgerActivityDate(org) {
    if (!org || typeof org !== 'object') return null;
    const latest = org.latest_credit_entry && typeof org.latest_credit_entry === 'object'
      ? org.latest_credit_entry
      : null;
    return getLedgerEntryDate(latest)
      || parseDate(org.latest_credit_at || org.latest_credit_ts || org.last_credit_at || org.updated_at || org.created_at);
  }

  function mergeLedgerRows(existingRows, newRows) {
    const rows = [];
    const seen = new Set();
    const addRow = row => {
      if (!row || typeof row !== 'object') return;
      const key = [
        row.id || '',
        row.ts || row.created_at || row.createdAt || row.timestamp || row.date || '',
        row.reason || row.type || row.event || '',
        row.delta ?? row.amount ?? row.credit_delta ?? row.value ?? '',
        JSON.stringify(row.meta || {})
      ].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };
    (Array.isArray(existingRows) ? existingRows : []).forEach(addRow);
    (Array.isArray(newRows) ? newRows : []).forEach(addRow);
    rows.sort((a, b) => {
      const ad = getLedgerEntryDate(a);
      const bd = getLedgerEntryDate(b);
      return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
    });
    return rows;
  }

  async function fetchStatsOrgDetail(orgId, ledgerPage = 1) {
    const payload = {
      action: 'customer_org_detail',
      org_id: orgId,
      orders_page: '1',
      ledger_page: String(ledgerPage)
    };
    const data = (window.Portal && typeof window.Portal.apiPost === 'function')
      ? await withTimeout(window.Portal.apiPost(apiServer(), payload), STATS_LEDGER_DETAIL_TIMEOUT_MS, `customer_org_detail ${orgId} page ${ledgerPage} timed out`)
      : await withTimeout(fetch(apiServer(), { method:'POST', body:new URLSearchParams(payload) }), STATS_LEDGER_DETAIL_TIMEOUT_MS, `customer_org_detail ${orgId} page ${ledgerPage} timed out`).then(res => res.json());
    if (!data?.success || !data.organization) throw new Error(data?.error || `Failed to fetch organization detail for ${orgId}`);
    return data.organization;
  }

  async function hydrateOrgLedgerForStats(org, minStart) {
    const orgId = String(org?.id || '').trim();
    if (!orgId || statsHydratedLedgerOrgIds.has(orgId)) return false;
    let mergedRows = Array.isArray(org.credits_ledger) ? org.credits_ledger : [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= STATS_LEDGER_MAX_PAGES_PER_ORG) {
      const detail = await fetchStatsOrgDetail(orgId, page);
      const detailRows = Array.isArray(detail.credits_ledger) ? detail.credits_ledger : [];
      mergedRows = mergeLedgerRows(mergedRows, detailRows);

      const idx = allOrganizations.findIndex(o => String(o.id) === orgId);
      if (idx >= 0) {
        allOrganizations[idx] = {
          ...allOrganizations[idx],
          ...detail,
          credits_ledger: mergedRows,
          stats_ledger_hydrated_at: new Date().toISOString(),
        };
      }

      const pagination = detail.credits_pagination && typeof detail.credits_pagination === 'object'
        ? detail.credits_pagination
        : {};
      const reportedTotalPages = Number(pagination.total_pages || 0);
      if (reportedTotalPages > 0) totalPages = reportedTotalPages;

      const datedRows = detailRows
        .map(getLedgerEntryDate)
        .filter(Boolean)
        .sort((a, b) => a.getTime() - b.getTime());
      const oldestOnPage = datedRows[0] || null;
      if (!detailRows.length || (oldestOnPage && oldestOnPage < minStart)) break;
      if (!(reportedTotalPages > 0)) break;
      page++;
    }
    statsHydratedLedgerOrgIds.add(orgId);
    return true;
  }

  async function ensureRevenueLedgersForRange(range, prevRange, renderSeq, options = {}) {
    const maxOrgs = Math.max(0, Number(options.maxOrgs || 0) || 0);
    const minStartMs = Math.min(range.start.getTime(), prevRange.start.getTime());
    const minStart = new Date(minStartMs);
    let candidates = (allOrganizations || [])
      .filter(org => {
        if (!org || org.is_test || org.is_test_org) return false;
        const orgId = String(org.id || '').trim();
        if (!orgId || statsHydratedLedgerOrgIds.has(orgId)) return false;
        const count = Number(org.credits_ledger_count ?? org.credit_count ?? 0);
        const latest = orgLedgerActivityDate(org);
        const hasLedgerSignal = count > 0 || !!org.latest_credit_entry || (Array.isArray(org.credits_ledger) && org.credits_ledger.length > 0);
        return hasLedgerSignal && latest && latest >= minStart;
      })
      .sort((a, b) => {
        const ad = orgLedgerActivityDate(a);
        const bd = orgLedgerActivityDate(b);
        return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
      });
    if (maxOrgs > 0) candidates = candidates.slice(0, maxOrgs);

    let hydrated = 0;
    for (let i = 0; i < candidates.length; i += STATS_LEDGER_BATCH_SIZE) {
      if (renderSeq !== statsRenderSeq) return hydrated;
      const batch = candidates.slice(i, i + STATS_LEDGER_BATCH_SIZE);
      const results = await Promise.all(batch.map(org =>
        hydrateOrgLedgerForStats(org, minStart).catch(e => {
          console.warn('Could not hydrate organization credit ledger for stats', org?.id, e);
          return false;
        })
      ));
      hydrated += results.filter(Boolean).length;
    }
    return hydrated;
  }

  // =========================================================================
  //  DATA FETCHING
  // =========================================================================
  function sortStatsProjects(projects) {
    return (projects || []).sort((a, b) => {
      const aDate = parseDate(a?.completed_at || a?.qa_approved_at || a?.qa_completed_at || a?.created_at || '');
      const bDate = parseDate(b?.completed_at || b?.qa_approved_at || b?.qa_completed_at || b?.created_at || '');
      return (bDate ? bDate.getTime() : 0) - (aDate ? aDate.getTime() : 0);
    });
  }

  function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function firstNonBlank(...values) {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text !== '') return text;
    }
    return '';
  }

  function numericOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeStatsProject(project) {
    const raw = asRecord(project);
    const manifest = asRecord(raw.manifest);
    const m = Object.keys(manifest).length ? { ...manifest, ...raw } : raw;
    const timestamps = asRecord(m.timestamps);
    const workflow = asRecord(m.workflow);
    const metadata = asRecord(m.metadata);
    const order = asRecord(m.order);
    const addons = asRecord(m.addons);
    const assigned = asRecord(workflow.assigned_to);
    const qaClaim = asRecord(workflow.qa_claim);
    const orgRef = asRecord(m.organization_ref);
    const audit = asRecord(m.audit);
    const pins = Array.isArray(m.pins) ? m.pins : [];
    const qaHistory = Array.isArray(m.qa_history) ? m.qa_history : [];
    const technicianHistory = Array.isArray(m.technician_history) ? m.technician_history : [];
    const workHistory = Array.isArray(m.work_history)
      ? m.work_history
      : (Array.isArray(workflow.work_history)
        ? workflow.work_history
        : (Array.isArray(workflow.history) ? workflow.history : []));
    const completedAt = firstNonBlank(
      m.completed_at,
      timestamps.completed_at,
      m.delivered_at,
      timestamps.delivered_at,
      m.qa_approved_at,
      m.qa_completed_at,
      asRecord(m.delivery).completed_at
    );
    const qaApprovedAt = firstNonBlank(
      m.qa_approved_at,
      m.qa_completed_at,
      timestamps.qa_approved_at,
      timestamps.qa_completed_at,
      m.qa_reviewed_at,
      m.qa_reviewed_at_utc
    );
    const amountCharged = numericOrNull(m.amount_charged ?? m.price ?? m.report_price ?? m.total_price);
    const pinCount = numericOrNull(m.pin_count ?? m.structure_count ?? m.building_count);
    return {
      id: firstNonBlank(m.id, m.folder, m.project_id),
      address: firstNonBlank(m.address, m.property_address),
      status: firstNonBlank(m.status, m.st, completedAt ? 'completed' : 'queued'),
      created_at: firstNonBlank(m.created_at, timestamps.created_at, m.submitted_at, m.ordered_at, m.ca),
      completed_at: completedAt || null,
      rejected_at: firstNonBlank(m.rejected_at, timestamps.rejected_at),
      started_at: firstNonBlank(m.started_at, timestamps.started_at, workflow.started_at),
      uploaded_at: firstNonBlank(m.uploaded_at, timestamps.uploaded_at, m.drawn_at, timestamps.drawn_at),
      assigned_at: firstNonBlank(m.assigned_at, workflow.assigned_at, assigned.assigned_at),
      claimed_at: firstNonBlank(m.claimed_at, m.technician_claimed_at, workflow.claimed_at, assigned.claimed_at),
      technician_claimed_at: firstNonBlank(m.technician_claimed_at, m.claimed_at, workflow.claimed_at, assigned.claimed_at),
      queued_at: firstNonBlank(m.queued_at, timestamps.queued_at),
      updated_at: firstNonBlank(m.updated_at, timestamps.updated_at),
      submitted_at: firstNonBlank(m.submitted_at, timestamps.submitted_at, workflow.submitted_at),
      qa_submitted_at: firstNonBlank(m.qa_submitted_at, timestamps.qa_submitted_at),
      resubmitted_at: firstNonBlank(m.resubmitted_at, timestamps.resubmitted_at),
      last_resubmission_at: firstNonBlank(m.last_resubmission_at, timestamps.last_resubmission_at),
      qa_claimed_at: firstNonBlank(m.qa_claimed_at, qaClaim.claimed_at, timestamps.qa_claimed_at),
      qa_started_at: firstNonBlank(m.qa_started_at, timestamps.qa_started_at),
      qa_approved_at: qaApprovedAt || null,
      qa_completed_at: firstNonBlank(m.qa_completed_at, qaApprovedAt),
      assigned_to_email: normalizeEmail(firstNonBlank(m.assigned_to_email, assigned.email, m.technician_email, m.owner)),
      assigned_to_name: firstNonBlank(m.assigned_to_name, assigned.name, m.technician_name),
      latest_technician_email: normalizeEmail(firstNonBlank(m.latest_technician_email, asRecord(m.latest_technician).email)),
      latest_technician_name: firstNonBlank(m.latest_technician_name, asRecord(m.latest_technician).name),
      display_technician_email: normalizeEmail(firstNonBlank(m.display_technician_email, asRecord(m.display_technician).email)),
      display_technician_name: firstNonBlank(m.display_technician_name, asRecord(m.display_technician).name),
      technician_email: normalizeEmail(firstNonBlank(m.technician_email, asRecord(m.technician).email)),
      technician_name: firstNonBlank(m.technician_name, asRecord(m.technician).name),
      drafter_email: normalizeEmail(firstNonBlank(m.drafter_email, asRecord(m.drafter).email)),
      drafter_name: firstNonBlank(m.drafter_name, asRecord(m.drafter).name),
      drafter_rank: firstNonBlank(m.drafter_rank, asRecord(m.drafter).rank, asRecord(m.assigned_to).drafter_rank),
      technician_rank: firstNonBlank(m.technician_rank, asRecord(m.technician).rank),
      measurement_technician_rank: firstNonBlank(m.measurement_technician_rank),
      qa_paid_to_email: normalizeEmail(firstNonBlank(m.qa_paid_to_email, asRecord(m.qa_paid_to).email)),
      qa_paid_to_name: firstNonBlank(m.qa_paid_to_name, asRecord(m.qa_paid_to).name),
      qa_claimed_by_email: normalizeEmail(firstNonBlank(m.qa_claimed_by_email, qaClaim.email)),
      qa_approved_by_email: normalizeEmail(firstNonBlank(m.qa_approved_by_email, m.qa_approved_by, asRecord(m.qa_approved_by_user).email)),
      qa_approved_by: firstNonBlank(m.qa_approved_by, asRecord(m.qa_approved_by_user).email),
      qa_reviewed_by_email: normalizeEmail(firstNonBlank(m.qa_reviewed_by_email, m.qa_reviewed_by, asRecord(m.qa_reviewed_by_user).email)),
      qa_reviewed_by: firstNonBlank(m.qa_reviewed_by, asRecord(m.qa_reviewed_by_user).email),
      is_filler: !!m.is_filler,
      is_test_org: !!m.is_test_org,
      is_vip: !!m.is_vip,
      is_expedited: !!m.is_expedited,
      project_type: firstNonBlank(m.project_type, m.service_type, 'residential'),
      amount_charged: amountCharged,
      metadata,
      order,
      addons,
      include_gutter_measurements: m.include_gutter_measurements ?? m.include_gutters ?? metadata.include_gutter_measurements ?? order.include_gutter_measurements ?? null,
      include_gutters: m.include_gutters ?? metadata.include_gutters ?? order.include_gutters ?? null,
      gutter_measurements: m.gutter_measurements ?? null,
      gutters: m.gutters ?? null,
      gutter_amount: numericOrNull(m.gutter_amount ?? m.gutter_fee ?? m.gutter_revenue ?? m.gutter_addon_amount ?? addons.gutters ?? addons.gutter ?? metadata.gutter_amount ?? order.gutter_amount),
      report_expedite_option: firstNonBlank(m.report_expedite_option, m.expedite_option, m.rush_option, metadata.report_expedite_option, order.report_expedite_option),
      expedite_option: firstNonBlank(m.expedite_option, m.report_expedite_option, metadata.expedite_option, order.expedite_option),
      expedite_level: numericOrNull(m.expedite_level ?? m.report_expedite_level ?? m.rush_level ?? metadata.expedite_level ?? order.expedite_level),
      expedite_amount: numericOrNull(m.expedite_amount ?? m.expedite_fee ?? m.rush_amount ?? m.rush_fee ?? m.report_expedite_amount ?? m.report_expedite_fee ?? addons.expedite ?? addons.rush ?? metadata.expedite_amount ?? order.expedite_amount),
      include_storm_weather_report: m.include_storm_weather_report ?? m.include_weather_report ?? metadata.include_storm_weather_report ?? order.include_storm_weather_report ?? null,
      include_weather_report: m.include_weather_report ?? metadata.include_weather_report ?? order.include_weather_report ?? null,
      storm_weather_report: m.storm_weather_report ?? null,
      weather_report: m.weather_report ?? null,
      weather_amount: numericOrNull(m.weather_amount ?? m.weather_fee ?? m.weather_report_amount ?? m.weather_report_fee ?? m.storm_weather_amount ?? m.storm_weather_fee ?? m.storm_report_amount ?? m.storm_report_fee ?? addons.weather ?? addons.storm_weather ?? metadata.weather_amount ?? order.weather_amount),
      report_type: firstNonBlank(m.report_type, metadata.report_type, order.report_type),
      product_type: firstNonBlank(m.product_type, metadata.product_type, order.product_type),
      order_type: firstNonBlank(m.order_type, metadata.order_type, order.order_type),
      instant_enabled: !!m.instant_enabled,
      instant_only: !!m.instant_only,
      report_mode: m.report_mode ?? null,
      refund_amount: numericOrNull(m.refund_amount) || 0,
      refund_issued: !!m.refund_issued,
      refund_pending: !!m.refund_pending,
      pin_count: Math.max(1, Math.round(pinCount || pins.length || 1)),
      team_id: firstNonBlank(m.team_id, asRecord(m.team_ref).id, 'default'),
      organization_id: firstNonBlank(m.organization_id, m.org_id, orgRef.id) || null,
      complexity: m.complexity ?? 'complex',
      point_value: numericOrNull(m.point_value ?? m.project_points ?? m.points_value ?? m.points),
      project_points: numericOrNull(m.project_points ?? m.point_value ?? m.points_value ?? m.points),
      rush_bonus_eligible: !!m.rush_bonus_eligible,
      rush_bonus_tag: firstNonBlank(m.rush_bonus_tag, m.rush_bonus_reason),
      rush_bonus_percent: numericOrNull(m.rush_bonus_percent),
      rush_bonus_amount: numericOrNull(m.rush_bonus_amount),
      qa_reject_count: numericOrNull(m.qa_reject_count) ?? qaHistory.length,
      manager_audit_status: m.manager_audit_status ?? audit.manager_audit_status ?? null,
      manager_audit_note: m.manager_audit_note ?? audit.manager_audit_note ?? null,
      timestamps,
      workflow,
      qa_history: qaHistory,
      work_history: workHistory,
      technician_history: technicianHistory,
      resubmissions: Array.isArray(m.resubmissions) ? m.resubmissions : [],
    };
  }

  function hasUsableStatsDates(projects) {
    return (Array.isArray(projects) ? projects : []).some(project =>
      parseDate(project?.created_at || project?.submitted_at) ||
      parseDate(project?.completed_at || project?.qa_approved_at || project?.qa_completed_at) ||
      parseDate(project?.uploaded_at || project?.started_at) ||
      getRejectedDate(project)
    );
  }

  async function parseStatsJsonResponse(res, label) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      const excerpt = text.slice(0, 180).replace(/\s+/g, ' ').trim();
      throw new Error(`${label} returned invalid JSON${excerpt ? `: ${excerpt}` : ''}`);
    }
  }

  async function fetchStatsProjects() {
    if (window.Portal && typeof window.Portal.fmPost === 'function') {
      return await fetchStatsProjectsFromFirstMeasure();
    }

    const projectsById = new Map();
    const addProjects = pageProjects => {
      let added = 0;
      (Array.isArray(pageProjects) ? pageProjects : []).forEach(project => {
        const normalized = normalizeStatsProject(project);
        const id = String(normalized?.id || '').trim();
        if (!id || projectsById.has(id)) return;
        projectsById.set(id, normalized);
        added++;
      });
      return added;
    };

    const fetchPage = async page => {
      const payload = {
        action: 'stats_data',
        include_active: '1',
        include_history: '1',
        page: String(page),
        limit: String(STATS_PROJECT_PAGE_LIMIT),
      };
      const data = (window.Portal && typeof window.Portal.apiPost === 'function')
        ? await withTimeout(window.Portal.apiPost(apiServer(), payload), STATS_API_TIMEOUT_MS, `stats_data page ${page} timed out`)
        : await withTimeout(fetch(apiServer(), { method:'POST', body: new URLSearchParams(payload) }), STATS_API_TIMEOUT_MS, `stats_data page ${page} timed out`)
            .then(res => parseStatsJsonResponse(res, `stats_data page ${page}`).then(data => {
              if (!res.ok || !data.success) throw new Error(data.error || `Failed to fetch stats_data page ${page}`);
              return data;
            }));
      if (!data.success) throw new Error(data.error || `Failed to fetch stats_data page ${page}`);
      return data;
    };

    let firstPage;
    try {
      firstPage = await fetchPage(1);
    } catch (e) {
      console.warn('stats_data failed, falling back to FirstMeasure projects/list', e);
      return await fetchStatsProjectsFromFirstMeasure();
    }
    addProjects(firstPage.projects);

    const firstPagination = firstPage.pagination || {};
    let totalPages = Number(firstPagination.total_pages || 0);
    if (!(totalPages > 0)) {
      const totalCount = Number(firstPagination.total_count || 0);
      totalPages = totalCount > 0 ? Math.ceil(totalCount / STATS_PROJECT_PAGE_LIMIT) : (firstPage.has_more ? 2 : 1);
    }

    let nextPage = 2;
    while (nextPage <= totalPages && nextPage <= 500) {
      const pages = [];
      for (let i = 0; i < STATS_PROJECT_BATCH_SIZE && nextPage <= totalPages && nextPage <= 500; i++, nextPage++) {
        pages.push(nextPage);
      }

      const batchResults = await Promise.all(pages.map(page =>
        fetchPage(page).catch(e => {
          console.warn(`stats_data page ${page} failed`, e);
          return { projects: [], pagination: {} };
        })
      ));
      let batchAdded = 0;
      batchResults.forEach(data => {
        batchAdded += addProjects(data.projects);
        const pagination = data.pagination || {};
        const reportedTotalPages = Number(pagination.total_pages || 0);
        if (reportedTotalPages > totalPages) totalPages = reportedTotalPages;
      });

      if (batchAdded === 0) break;
    }

    const projects = sortStatsProjects(Array.from(projectsById.values()));
    if (projects.length > 0 && hasUsableStatsDates(projects)) return projects;
    return await fetchStatsProjectsFromFirstMeasure();
  }

  async function fetchStatsProjectsFromFirstMeasure() {
    if (!window.Portal || typeof window.Portal.fmPost !== 'function') return [];
    const payload = {
      filter: 'all',
      status_filter: 'all',
      include_all: true,
      include_history: true,
      include_instant_only: true,
      view: 'stats',
      limit: 200,
    };

    const rows = [];
    const fetchPage = page => withTimeout(
        window.Portal.fmPost('projects/list', { ...payload, page }),
        STATS_PROJECTS_TIMEOUT_MS,
        `projects/list stats page ${page} timed out`
      );

    const firstPage = await fetchPage(1);
    rows.push(...(Array.isArray(firstPage?.projects) ? firstPage.projects : []));
    const firstPagination = firstPage && typeof firstPage.pagination === 'object' ? firstPage.pagination : {};
    let totalPages = Number(firstPagination.total_pages || 0);
    if (!(totalPages > 0)) {
      const totalCount = Number(firstPagination.total_count || 0);
      totalPages = totalCount > 0 ? Math.ceil(totalCount / payload.limit) : 1;
    }
    totalPages = Math.min(totalPages, 500);

    let nextPage = 2;
    while (nextPage <= totalPages) {
      const pages = [];
      for (let i = 0; i < STATS_PROJECT_BATCH_SIZE && nextPage <= totalPages; i++, nextPage++) {
        pages.push(nextPage);
      }
      const pageResults = await Promise.all(pages.map(page =>
        fetchPage(page).catch(e => {
          console.warn(`projects/list stats page ${page} failed`, e);
          return { projects: [], pagination: {} };
        })
      ));
      let added = 0;
      pageResults.forEach(pageData => {
      const batch = Array.isArray(pageData?.projects) ? pageData.projects : [];
      rows.push(...batch);
        added += batch.length;
        const pagination = pageData && typeof pageData.pagination === 'object' ? pageData.pagination : {};
        const reportedTotalPages = Number(pagination.total_pages || 0);
        if (reportedTotalPages > totalPages) totalPages = Math.min(reportedTotalPages, 500);
      });
      if (added === 0) break;
    }
    return sortStatsProjects(rows.map(normalizeStatsProject));
  }

  async function fetchStatsOrganizations() {
    const payload = { action: 'customer_org_dashboard_data' };
    const data = (window.Portal && typeof window.Portal.apiPost === 'function')
      ? await withTimeout(window.Portal.apiPost(apiServer(), payload), STATS_API_TIMEOUT_MS, 'customer_org_dashboard_data timed out')
      : await withTimeout(fetch(apiServer(), { method:'POST', body:new URLSearchParams(payload) }), STATS_API_TIMEOUT_MS, 'customer_org_dashboard_data timed out').then(res => res.json());
    if (!data?.success) throw new Error(data?.error || 'Failed to fetch organizations for stats');
    return Array.isArray(data.organizations)
      ? data.organizations
      : (Array.isArray(data.orgs) ? data.orgs : []);
  }

  async function fetchStatsCreditRevenue(range, prevRange, renderSeq) {
    const payload = {
      action: 'stats_credit_revenue',
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      prev_start: prevRange.start.toISOString(),
      prev_end: prevRange.end.toISOString(),
    };
    try {
      const data = (window.Portal && typeof window.Portal.apiPost === 'function')
        ? await withTimeout(window.Portal.apiPost(apiServer(), payload), STATS_API_TIMEOUT_MS, 'stats_credit_revenue timed out')
        : await withTimeout(fetch(apiServer(), { method:'POST', body:new URLSearchParams(payload) }), STATS_API_TIMEOUT_MS, 'stats_credit_revenue timed out').then(res => res.json());
      if (renderSeq !== statsRenderSeq) return false;
      if (!data?.success) throw new Error(data?.error || 'Failed to fetch stats credit revenue');
      const actual = Number(data.actual_revenue ?? data.actualRevenue ?? 0);
      const previous = Number(data.prev_actual_revenue ?? data.prevActualRevenue ?? 0);
      if (Number.isFinite(actual)) statsActualRevenueByRange.set(statsRevenueRangeKey(range), actual);
      if (Number.isFinite(previous)) statsActualRevenueByRange.set(statsRevenueRangeKey(prevRange), previous);
      return true;
    } catch (e) {
      console.warn('Could not fetch aggregate credit revenue for stats; using already-loaded organization ledger data only.', e);
      return false;
    }
  }

  async function fetchAllData() {
    try {
      const [projects, usersData, orgsData] = await Promise.all([
        fetchStatsProjects(),
        (window.Portal && typeof window.Portal.apiPost === 'function')
          ? withTimeout(window.Portal.apiPost(apiServer(), { action:'fetch_all_users_with_orders' }), STATS_API_TIMEOUT_MS, 'fetch_all_users_with_orders timed out')
          : withTimeout(fetch(apiServer(), { method:'POST', body:new URLSearchParams({ action:'fetch_all_users_with_orders' }) }), STATS_API_TIMEOUT_MS, 'fetch_all_users_with_orders timed out').then(res => res.json()),
        fetchStatsOrganizations(),
      ]);
      allProjects      = projects;
      allUsers         = usersData.users || [];
      allOrganizations = orgsData || [];
      statsHydratedLedgerOrgIds.clear();

      try {
        const schedData = (window.Portal && typeof window.Portal.apiPost === 'function')
          ? await withTimeout(window.Portal.apiPost(apiServer(), { action:'shift_get_schedules' }), STATS_API_TIMEOUT_MS, 'shift_get_schedules timed out')
          : await withTimeout(fetch(apiServer(), { method:'POST', body:new URLSearchParams({ action:'shift_get_schedules' }) }), STATS_API_TIMEOUT_MS, 'shift_get_schedules timed out').then(res => res.json());
        allShiftSchedules = (schedData.success && schedData.schedules) ? schedData.schedules : [];
      } catch(e) {
        console.warn('Could not fetch shift schedules:', e);
        allShiftSchedules = [];
      }
      statsDataLoadedAt = Date.now();
      return true;
    } catch(e) {
      console.error('Error fetching stats data:', e);
      return false;
    }
  }

  // =========================================================================
  //  CALCULATE STATISTICS
  // =========================================================================
  function calculateStats(projects, range) {
    const { start, end } = range;
    const completedProjects = projects.filter(p => !isRejectedProject(p));

    const inRange = completedProjects.filter(p => {
      const dateToUse = getProjectDateForMode(p);
      if (!dateToUse) return false;
      return dateToUse >= start && dateToUse < end;
    });
    const rejectedInRange = projects.filter(p => {
      if (!isRejectedProject(p)) return false;
      const rejectedAt = getRejectedDate(p);
      if (!rejectedAt) return false;
      return rejectedAt >= start && rejectedAt < end;
    });
    const periodDayCount = getRangeDayCount(range);

    const totalCompleted  = inRange.length;
    const fillerCompleted = inRange.filter(p => p.is_filler && !isTestProject(p)).length;
    const testCompleted   = inRange.filter(p => isTestProject(p)).length;
    const realCompleted   = totalCompleted - fillerCompleted - testCompleted;
    const totalRejected   = rejectedInRange.length;
    const rejectedPerDay  = totalRejected / periodDayCount;
    const rejectionByServiceType = {};
    ALL_SERVICE_TYPES.forEach(svc => {
      rejectionByServiceType[svc] = {
        requested: 0,
        rejectedFromRequests: 0,
        rejectedInPeriod: 0,
        rejectionRate: 0,
        shareOfRejected: 0,
      };
    });
    const requestedRealInRange = projects.filter(p => {
      if (projectType(p) !== 'real') return false;
      const requested = getRequestedDate(p);
      return requested && requested >= start && requested < end;
    });
    requestedRealInRange.forEach(p => {
      const svc = projectServiceType(p);
      rejectionByServiceType[svc].requested++;
      if (isRejectedProject(p)) rejectionByServiceType[svc].rejectedFromRequests++;
    });
    const realRejectedInRange = rejectedInRange.filter(p => projectType(p) === 'real');
    realRejectedInRange.forEach(p => {
      rejectionByServiceType[projectServiceType(p)].rejectedInPeriod++;
    });
    const realRejectedTotal = realRejectedInRange.length;
    ALL_SERVICE_TYPES.forEach(svc => {
      const row = rejectionByServiceType[svc];
      row.rejectionRate = row.requested > 0 ? (row.rejectedFromRequests / row.requested) * 100 : 0;
      row.shareOfRejected = realRejectedTotal > 0 ? (row.rejectedInPeriod / realRejectedTotal) * 100 : 0;
    });

    // --- Revenue by service type (real projects only) ---
    const revByType = { residential: 0, commercial: 0, multifamily: 0 };
    const countByType = { residential: 0, commercial: 0, multifamily: 0 };
    const productMix = {
      regular_only: { orders: 0, revenue: 0, regularReports: 0, instantReports: 0, regularRevenue: 0, instantRevenue: 0 },
      instant_only: { orders: 0, revenue: 0, regularReports: 0, instantReports: 0, regularRevenue: 0, instantRevenue: 0 },
      both: { orders: 0, revenue: 0, regularReports: 0, instantReports: 0, regularRevenue: 0, instantRevenue: 0 },
    };
    const productTotals = { orders: 0, regularReports: 0, instantReports: 0, reportUnits: 0, regularRevenue: 0, instantRevenue: 0 };
    const addonStats = {
      orders: 0,
      baseRevenue: 0,
      addonRevenue: 0,
      gutterOrders: 0,
      gutterRevenue: 0,
      expediteOrders: 0,
      expediteRevenue: 0,
      expediteLevel1Orders: 0,
      expediteLevel1Revenue: 0,
      expediteLevel2Orders: 0,
      expediteLevel2Revenue: 0,
      stormWeatherOrders: 0,
      stormWeatherRevenue: 0,
      unattributedAddonRevenue: 0,
    };
    let totalRevenue = 0;

    let totalReportPayPhp = 0;
    let totalRushBonusPhp = 0;
    let totalTechnicianPoints = 0;
    const speedBandCounts = SPEED_RATE_BANDS.map(() => 0);
    const speedBandPoints = SPEED_RATE_BANDS.map(() => 0);
    const speedBandPay = SPEED_RATE_BANDS.map(() => 0);
    const techDayPoints = new Map();
    const complexityCounts = { 1:0, 2:0, 3:0, 4:0, 5:0 };

    inRange.forEach(p => {
      const rating = normalizeComplexity(p.complexity);
      complexityCounts[rating] = (complexityCounts[rating] || 0) + 1;

      const pt = projectType(p);
      if (pt === 'real') {
        const svc = projectServiceType(p);
        const rev = projectRevenue(p);
        const mode = projectOrderMode(p);
        const split = projectRevenueSplit(p);
        const hasRegular = projectHasRegularReport(p);
        const hasInstant = projectHasInstantReport(p);

        if (!productMix[mode]) productMix[mode] = { orders: 0, revenue: 0, regularReports: 0, instantReports: 0, regularRevenue: 0, instantRevenue: 0 };
        productMix[mode].orders++;
        productMix[mode].revenue += rev;
        productMix[mode].regularReports += hasRegular ? 1 : 0;
        productMix[mode].instantReports += hasInstant ? 1 : 0;
        productMix[mode].regularRevenue += split.regular;
        productMix[mode].instantRevenue += split.instant;
        productTotals.orders++;
        productTotals.regularReports += hasRegular ? 1 : 0;
        productTotals.instantReports += hasInstant ? 1 : 0;
        productTotals.regularRevenue += split.regular;
        productTotals.instantRevenue += split.instant;

        revByType[svc]   = (revByType[svc]   || 0) + rev;
        countByType[svc] = (countByType[svc] || 0) + 1;
        totalRevenue += rev;

        const addons = projectAddonRevenueBreakdown(p, rev);
        addonStats.orders++;
        addonStats.baseRevenue += addons.base;
        addonStats.addonRevenue += addons.extraTotal;
        addonStats.gutterRevenue += addons.gutter;
        addonStats.expediteRevenue += addons.expedite;
        addonStats.expediteLevel1Revenue += addons.expediteLevel1;
        addonStats.expediteLevel2Revenue += addons.expediteLevel2;
        addonStats.stormWeatherRevenue += addons.weather;
        addonStats.unattributedAddonRevenue += addons.unattributed;
        if (addons.hasGutters) addonStats.gutterOrders++;
        if (addons.hasExpedite) {
          addonStats.expediteOrders++;
          if (addons.expediteLevel === 1) addonStats.expediteLevel1Orders++;
          else if (addons.expediteLevel === 2) addonStats.expediteLevel2Orders++;
        }
        if (addons.hasStormWeather) addonStats.stormWeatherOrders++;

        const payout = projectPayoutInfo(p);
        const bandIndex = Math.max(0, SPEED_RATE_BANDS.findIndex(b => b.key === payout.band.key));
        totalReportPayPhp += payout.baseRate;
        totalRushBonusPhp += payout.rushBonus;
        totalTechnicianPoints += payout.points;
        speedBandCounts[bandIndex]++;
        speedBandPoints[bandIndex] += payout.points;
        speedBandPay[bandIndex] += payout.baseRate;

        const payee = projectPayTechnician(p);
        const email = normalizeEmail(payee.email || p.assigned_to_email);
        const dayKey = getLocalDateKey(getProjectDateForMode(p));
        if (email && dayKey) {
          const key = `${email}:${dayKey}`;
          if (!techDayPoints.has(key)) {
            techDayPoints.set(key, {
              email,
              dayKey,
              rank: technicianRankForEmail(email, p.drafter_rank || p.technician_rank || p.measurement_technician_rank),
              points:0,
              projectPayPhp:0,
              rushBonusPhp:0,
              projects:0
            });
          }
          const day = techDayPoints.get(key);
          day.points += payout.points;
          day.projectPayPhp += payout.baseRate;
          day.rushBonusPhp += payout.rushBonus;
          day.projects++;
        }
      }
    });

    const shiftCounts = countShiftDaysByRole(allShiftSchedules, start, end);
    let qaShiftDays   = shiftCounts.qa;
    let mgrShiftDays  = shiftCounts.manager;

    const techScheduleMap = new Map(allShiftSchedules.map(s => [normalizeEmail(s.email), s]));
    const technicianHasShiftOnDay = (email, dayKey) => {
      const schedule = techScheduleMap.get(normalizeEmail(email));
      if (!schedule) return true;
      const blocks = resolveShiftBlocksForDate(schedule, dayKey);
      return blocks.some(b => String(b.role || 'technician').toLowerCase() === 'technician');
    };
    const techBaseDayMap = new Map();
    techDayPoints.forEach(day => {
      if (day.points < TECH_BASE_MIN_POINTS_PER_DAY) return;
      if (!technicianHasShiftOnDay(day.email, day.dayKey)) return;
      const rank = technicianRankForEmail(day.email, day.rank);
      const basePayPhp = technicianBasePayForRank(rank);
      techBaseDayMap.set(`${day.email}:${day.dayKey}`, { ...day, rank, basePayPhp });
    });

    const techShiftDays = techBaseDayMap.size;
    const techShiftCostPhp  = Array.from(techBaseDayMap.values()).reduce((sum, day) => sum + day.basePayPhp, 0);
    const qaShiftCostPhp    = qaShiftDays   * QA_SHIFT_PHP;
    const mgrShiftCostPhp   = mgrShiftDays  * MGR_SHIFT_PHP;
    const totalShiftCostPhp = techShiftCostPhp + qaShiftCostPhp + mgrShiftCostPhp;

    const reportPayUsd      = phpToUsd(totalReportPayPhp);
    const rushBonusUsd      = phpToUsd(totalRushBonusPhp);
    const techShiftUsd      = phpToUsd(techShiftCostPhp);
    const qaShiftUsd        = phpToUsd(qaShiftCostPhp);
    const mgrShiftUsd       = phpToUsd(mgrShiftCostPhp);
    const totalPayoutUsd    = reportPayUsd + rushBonusUsd + techShiftUsd + qaShiftUsd + mgrShiftUsd;
    const actualRevenue     = calculateActualRevenue(allOrganizations, range);
    const netCreditIncome   = totalRevenue - totalPayoutUsd;
    const netProfit         = actualRevenue - totalPayoutUsd;

    const complexityDist = Object.entries(COMPLEXITY_TIERS).map(([rating, tier]) => {
      const count = complexityCounts[rating] || 0;
      const pct = totalCompleted > 0 ? ((count / totalCompleted) * 100) : 0;
      return { rating:parseInt(rating), ...tier, count, pct };
    });

    // Stage times
    const stageTimes = emptyStageAccumulator();
    const stageTimesByProjectType = {
      real:   emptyStageAccumulator(),
      test:   emptyStageAccumulator(),
      vip:    emptyStageAccumulator(),
      filler: emptyStageAccumulator(),
    };
    inRange.forEach(p => {
      addProjectStageTimes(stageTimes, p);
      const timingType = getTimingProjectType(p);
      if (stageTimesByProjectType[timingType]) addProjectStageTimes(stageTimesByProjectType[timingType], p);
    });
    const avgStageTimes = summarizeStageTimes(stageTimes);
    const avgStageTimesByProjectType = Object.fromEntries(
      Object.entries(stageTimesByProjectType).map(([key, acc]) => [key, summarizeStageTimes(acc)])
    );
    const completedTurnaroundInfos = inRange.map(getCompletedTurnaroundInfo).filter(Boolean);
    const rejectionTurnaroundInfos = rejectedInRange.map(getRejectionTurnaroundInfo).filter(Boolean);
    const completedTurnaroundValues = completedTurnaroundInfos
      .map(info => info.workMs)
      .filter(v => Number.isFinite(v) && v > 0);
    const rejectionTurnaroundValues = rejectionTurnaroundInfos
      .map(info => info.workMs)
      .filter(v => Number.isFinite(v) && v > 0);
    const completedTurnaroundProfile = summarizeShiftTurnaroundInfos(completedTurnaroundInfos);
    const rejectionTurnaroundProfile = summarizeShiftTurnaroundInfos(rejectionTurnaroundInfos);
    const dailyVipCompletionComparison = buildDailyVipCompletionComparison(completedProjects, range);

    // Org breakdown
    const orgMap = new Map();
    inRange.forEach(p => {
      const orgId = p.organization_id || 'unknown';
      if (!orgMap.has(orgId)) {
        let orgName = orgId;
        if (orgId === 'unknown') orgName = 'No Organization';
        else {
          const orgData = allOrganizations.find(o => o.id === orgId);
          if (orgData && orgData.name) orgName = orgData.name;
        }
        orgMap.set(orgId, { id:orgId, name:orgName, total:0, real:0, filler:0, test:0,
          residential:0, commercial:0, multifamily:0, value:0 });
      }
      const org = orgMap.get(orgId);
      org.total++;
      const pt = projectType(p);
      org[pt]++;
      if (pt === 'real') {
        const svc = projectServiceType(p);
        org[svc]++;
        org.value += projectRevenue(p);
      }
    });
    const orgBreakdown = Array.from(orgMap.values()).sort((a,b) => b.total - a.total);

    // Technician breakdown
    const techMap = new Map();
    inRange.forEach(p => {
      const payee = projectPayTechnician(p);
      const email = normalizeEmail(payee.email || p.assigned_to_email);
      if (!email) return;
      if (!techMap.has(email)) {
        const user = allUsers.find(u => normalizeEmail(u.email) === email);
        const rank = technicianRankForEmail(email, p.drafter_rank || p.technician_rank || p.measurement_technician_rank);
        techMap.set(email, {
          email, name:payee.name || user?.name || email.split('@')[0],
          rank,
          completed:0, completedFiller:0, completedTest:0,
          points:0, reportPayPhp:0, rushBonusPhp:0,
          speedBandCounts:SPEED_RATE_BANDS.map(() => 0),
          complexityCounts:{ 1:0, 2:0, 3:0, 4:0, 5:0 },
          workedDays:new Set(), dailyTrend:{}
        });
      }
      const tech = techMap.get(email);
      if (!tech.name && payee.name) tech.name = payee.name;
      tech.completed++;
      const rating = normalizeComplexity(p.complexity);
      tech.complexityCounts[rating] = (tech.complexityCounts[rating] || 0) + 1;
      const pt = projectType(p);
      if (pt === 'filler') tech.completedFiller++;
      else if (pt === 'test') tech.completedTest++;
      else {
        const payout = projectPayoutInfo(p);
        const bandIndex = Math.max(0, SPEED_RATE_BANDS.findIndex(b => b.key === payout.band.key));
        tech.points += payout.points;
        tech.reportPayPhp += payout.baseRate;
        tech.rushBonusPhp += payout.rushBonus;
        tech.speedBandCounts[bandIndex]++;
      }
      const trendDate = getProjectDateForMode(p);
      const dayKey = getLocalDateKey(trendDate);
      if (dayKey) {
        tech.dailyTrend[dayKey] = (tech.dailyTrend[dayKey] || 0) + 1;
        tech.workedDays.add(dayKey);
      }
    });

    const techBreakdown = Array.from(techMap.values()).map(tech => {
      const eligibleDays = Array.from(techBaseDayMap.values()).filter(day => day.email === tech.email);
      const shiftPayPhp = eligibleDays.reduce((sum, day) => sum + day.basePayPhp, 0);
      const totalPayPhp = tech.reportPayPhp + tech.rushBonusPhp + shiftPayPhp;
      return {
        ...tech,
        shiftDays:eligibleDays.length,
        basePayRatePhp:technicianBasePayForRank(tech.rank),
        shiftPayPhp,
        totalPayPhp,
        totalPayUsd:phpToUsd(totalPayPhp),
        workedDays:tech.workedDays.size,
        pointQualifiedDays:eligibleDays.length,
      };
    }).sort((a,b) => b.completed - a.completed);

    // Previous period for trends
    const prevRange = getPreviousStatsRange(range);
    const { start: prevStart, end: prevEnd } = prevRange;
    const prevInRange = completedProjects.filter(p => {
      const d = getProjectDateForMode(p);
      if (!d) return false;
      return d >= prevStart && d < prevEnd;
    });
    const prevTotal        = prevInRange.length;
    const prevReal         = prevInRange.filter(p => projectType(p) === 'real').length;
    const prevRevenue      = prevInRange.filter(p => projectType(p) === 'real').reduce((s,p) => s + projectRevenue(p), 0);
    const prevActualRevenue = calculateActualRevenue(allOrganizations, { start: prevStart, end: prevEnd });

    const companyMetrics = calculateCompanyMetrics(projects, allOrganizations, range, currentPeriod);
    productTotals.reportUnits = productTotals.regularReports + productTotals.instantReports;

    return {
      totalCompleted, fillerCompleted, realCompleted, testCompleted,
      actualRevenue, totalRevenue, totalPayoutUsd, netCreditIncome, netProfit,
      reportPayUsd, rushBonusUsd,
      techShiftUsd, qaShiftUsd, mgrShiftUsd,
      techShiftDays, qaShiftDays, mgrShiftDays,
      totalReportPayPhp, totalRushBonusPhp, totalShiftCostPhp,
      totalTechnicianPoints, speedBandCounts, speedBandPoints, speedBandPay,
      productMix, productTotals, addonStats,
      revByType, countByType,
      rejectionByServiceType,
      complexityDist, complexityCounts,
      avgStageTimes, avgStageTimesByProjectType,
      totalRejected, rejectedPerDay,
      completedTurnaroundValues, rejectionTurnaroundValues,
      rejectedTurnaroundProfile: rejectionTurnaroundProfile, completedTurnaroundProfile,
      dailyVipCompletionComparison,
      weeklyActiveCompanies: companyMetrics.weeklyActiveCompanies,
      companyMetrics,
      orgBreakdown, techBreakdown,
      prevTotal, prevReal, prevRevenue, prevActualRevenue,
    };
  }

  // =========================================================================
  //  MULTI-SERIES PIPELINE BUCKETS
  // =========================================================================
  function buildMultiSeriesBuckets(projects, range) {
    const { start, end } = range;
    const isHourly = currentPeriod === 'daily';

    const buckets = new Map();
    const emptyTally  = () => ({ real:0, filler:0, test:0, residential:0, commercial:0, multifamily:0 });
    const emptyBucket = (label, shortLabel) => ({
      label, shortLabel,
      requested: emptyTally(),
      drawn:     emptyTally(),
      completed: emptyTally(),
      rejected:  emptyTally(),
    });

    if (isHourly) {
      for (let h = 0; h < 24; h++) {
        const key     = String(h).padStart(2, '0');
        const isPm    = h >= 12;
        const display = h === 0 ? '12a' : h === 12 ? '12p' : isPm ? `${h-12}p` : `${h}a`;
        buckets.set(key, emptyBucket(display, display));
      }
    } else {
      let cur = new Date(start);
      while (cur < end) {
        const key        = getLocalDateKey(cur);
        const label      = cur.toLocaleDateString('en-US', { weekday:'short', day:'numeric' });
        const shortLabel = String(cur.getDate());
        buckets.set(key, emptyBucket(label, shortLabel));
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0,0,0,0);
      }
    }

    const getKey = (date) => {
      if (!date) return null;
      if (isHourly) {
        if (date < start || date >= end) return null;
        return String(date.getHours()).padStart(2, '0');
      }
      if (date < start || date >= end) return null;
      return getLocalDateKey(date);
    };

    projects.forEach(p => {
      const cat = projectType(p);         // real/filler/test
      const svc = projectServiceType(p);  // residential/commercial/multifamily
      const reqKey       = getKey(parseDate(p.created_at || p.submitted_at));
      const drawnKey     = getKey(parseDate(p.uploaded_at || p.started_at));
      const completedKey = getKey(parseDate(p.completed_at));
      const rejectedKey  = getKey(getRejectedDate(p));

      EVENT_ORDER.forEach((evType, idx) => {
        const key = [reqKey, drawnKey, completedKey, rejectedKey][idx];
        if (key && buckets.has(key)) {
          buckets.get(key)[evType][cat]++;
          buckets.get(key)[evType][svc]++;
        }
      });
    });

    return Array.from(buckets.values());
  }

  function buildTimeOfDayBuckets(projects, range) {
    const { start, end } = range;
    const emptyTally  = () => ({ real:0, filler:0, test:0, residential:0, commercial:0, multifamily:0 });
    const buckets = Array.from({ length:24 }, (_, hour) => ({
      hour,
      label: formatHourBucketLabel(hour, true),
      shortLabel: formatHourBucketLabel(hour, false),
      requested: emptyTally(),
      drawn: emptyTally(),
      completed: emptyTally(),
      rejected: emptyTally(),
    }));

    const incrementBucket = (bucket, eventName, category, serviceType) => {
      if (!bucket || !bucket[eventName]) return;
      bucket[eventName][category]++;
      bucket[eventName][serviceType]++;
    };

    const inRange = date => date && date >= start && date < end;

    projects.forEach(p => {
      const category = projectType(p);
      const serviceType = projectServiceType(p);
      const requestedAt = parseDate(p.created_at || p.submitted_at);
      const drawnAt = parseDate(p.uploaded_at || p.started_at);
      const completedAt = parseDate(p.completed_at);
      const rejectedAt = getRejectedDate(p);

      if (inRange(requestedAt)) incrementBucket(buckets[requestedAt.getHours()], 'requested', category, serviceType);
      if (inRange(drawnAt)) incrementBucket(buckets[drawnAt.getHours()], 'drawn', category, serviceType);
      if (inRange(completedAt)) incrementBucket(buckets[completedAt.getHours()], 'completed', category, serviceType);
      if (inRange(rejectedAt)) incrementBucket(buckets[rejectedAt.getHours()], 'rejected', category, serviceType);
    });

    return buckets;
  }

  // =========================================================================
  //  PIPELINE TOGGLE BAR
  // =========================================================================
  function _currentGroups() {
    return chartDimensionMode === 'service' ? svcGroups : typeGroups;
  }
  function _currentAllTypes() {
    return chartDimensionMode === 'service' ? ALL_SERVICE_TYPES : ALL_TYPES;
  }
  function _currentLabels() {
    return chartDimensionMode === 'service' ? SERVICE_LABELS : TYPE_LABELS;
  }
  function _currentIcons() {
    return chartDimensionMode === 'service' ? SERVICE_ICONS : TYPE_ICONS;
  }
  function _currentColors(ev) {
    return chartDimensionMode === 'service' ? SERVICE_COLORS[ev] : SERIES_COLORS[ev];
  }
  function _saveCurrentGroups() {
    if (chartDimensionMode === 'service') _saveSvcGroups();
    else _saveTypeGroups();
  }

  function getPipelineSectionTitle() {
    return pipelineChartViewMode === 'timeofday'
      ? 'Pipeline Flow - Time of Day Distribution'
      : `Pipeline Flow - Reports by ${currentPeriod === 'daily' ? 'Hour' : 'Day'}`;
  }

  function formatHourBucketLabel(hour, verbose) {
    const safeHour = Math.max(0, Math.min(23, Number(hour) || 0));
    const suffix = safeHour >= 12 ? 'PM' : 'AM';
    const twelveHour = safeHour % 12 === 0 ? 12 : safeHour % 12;
    if (verbose) return `${twelveHour}:00 ${suffix}`;
    if (safeHour === 0) return '12a';
    if (safeHour === 12) return '12p';
    return safeHour > 12 ? `${safeHour - 12}p` : `${safeHour}a`;
  }

  function getPipelineSeries(buckets) {
    const activeEvents = EVENT_ORDER.filter(e => chartVisibleSeries[e]);
    const activeGroups = _currentGroups().filter(g => g.visible);
    const labels = _currentLabels();
    const groupLabel = g => g.types.length === _currentAllTypes().length ? 'All'
      : g.types.length === 1 ? labels[g.types[0]]
      : g.types.map(t => labels[t]).join('+');

    const groupColor = (ev, g) => _currentColors(ev)[g.types[0]];

    const series = [];
    activeEvents.forEach(ev => {
      activeGroups.forEach(group => {
        const rawValues = buckets.map(b => group.types.reduce((sum, t) => sum + (b[ev][t] || 0), 0));
        const rawTotal = rawValues.reduce((sum, value) => sum + value, 0);
        const values = pipelineDistributionMetric === 'share'
          ? rawValues.map(value => rawTotal > 0 ? (value / rawTotal) * 100 : 0)
          : rawValues.slice();
        series.push({
          event: ev,
          group,
          color: groupColor(ev, group),
          label: `${EVENT_LABELS[ev]} · ${groupLabel(group)}`,
          rawValues,
          rawTotal,
          values,
        });
      });
    });

    return series;
  }

  function renderPipelineLegend(series) {
    return series.map(s => `
      <span class="ms-legend-item">
        <span style="background:${s.color};border-radius:50%;width:7px;height:7px;display:inline-block;margin-right:3px;flex-shrink:0;"></span>
        ${s.label}
      </span>`).join('');
  }

  function renderTimeOfDayHighlights(series, buckets) {
    const totalsByHour = buckets.map((bucket, idx) => ({
      idx,
      total: series.reduce((sum, item) => sum + (item.rawValues[idx] || 0), 0),
    }));
    const peak = totalsByHour.reduce((best, row) => row.total > best.total ? row : best, { idx:0, total:0 });

    let bestWindow = { start:0, total:0 };
    for (let startHour = 0; startHour < 24; startHour++) {
      let total = 0;
      for (let offset = 0; offset < 4; offset++) {
        total += totalsByHour[(startHour + offset) % 24]?.total || 0;
      }
      if (total > bestWindow.total) bestWindow = { start:startHour, total };
    }

    const totalVisibleEvents = totalsByHour.reduce((sum, row) => sum + row.total, 0);
    const peakShare = totalVisibleEvents > 0 ? (peak.total / totalVisibleEvents) * 100 : 0;
    const windowEnd = (bestWindow.start + 4) % 24;

    return `
      <div class="ms-chart-highlights">
        <div class="ms-highlight-card">
          <div class="ms-highlight-label">Peak Hour</div>
          <div class="ms-highlight-value">${buckets[peak.idx]?.label || '12:00 AM'}</div>
          <div class="ms-highlight-sub">${peak.total.toLocaleString('en-US')} visible events${peak.total > 0 ? ` • ${fmtPercent(peakShare, 1)} of selected flow` : ''}</div>
        </div>
        <div class="ms-highlight-card">
          <div class="ms-highlight-label">Busiest 4-Hour Window</div>
          <div class="ms-highlight-value">${formatHourBucketLabel(bestWindow.start, true)}-${formatHourBucketLabel(windowEnd, true)}</div>
          <div class="ms-highlight-sub">${bestWindow.total.toLocaleString('en-US')} visible events across the rolling window</div>
        </div>
        <div class="ms-highlight-card">
          <div class="ms-highlight-label">Visible Flow</div>
          <div class="ms-highlight-value">${totalVisibleEvents.toLocaleString('en-US')}</div>
          <div class="ms-highlight-sub">Pipeline events matching the current filters</div>
        </div>
      </div>
    `;
  }

  function renderPipelineToggleBar() {
    const vs     = chartVisibleSeries;
    const groups = _currentGroups();
    const labels = _currentLabels();
    const icons  = _currentIcons();

    const viewToggle = `
      <div class="pipeline-control-wrap">
        <span class="ms-toggle-label">View</span>
        <div class="dim-mode-wrap">
          <button class="dim-mode-btn ${pipelineChartViewMode==='timeline'?'active':''}" data-pipeline-view="timeline">
            <i class="fas fa-chart-line"></i> Timeline
          </button>
          <button class="dim-mode-btn ${pipelineChartViewMode==='timeofday'?'active':''}" data-pipeline-view="timeofday">
            <i class="fas fa-clock"></i> Time of Day
          </button>
        </div>
      </div>
    `;

    const metricToggle = pipelineChartViewMode === 'timeofday' ? `
      <div class="pipeline-control-wrap">
        <span class="ms-toggle-label">Metric</span>
        <div class="dim-mode-wrap">
          <button class="dim-mode-btn ${pipelineDistributionMetric==='count'?'active':''}" data-pipeline-metric="count">
            <i class="fas fa-hashtag"></i> Count
          </button>
          <button class="dim-mode-btn ${pipelineDistributionMetric==='share'?'active':''}" data-pipeline-metric="share">
            <i class="fas fa-percent"></i> Share
          </button>
        </div>
      </div>
    ` : '';

    const dimToggle = `
      <div class="pipeline-control-wrap">
        <span class="ms-toggle-label">Breakdown</span>
        <div class="dim-mode-wrap">
          <button class="dim-mode-btn ${chartDimensionMode==='category'?'active':''}" data-dim-mode="category">
            <i class="fas fa-layer-group"></i> Category
          </button>
          <button class="dim-mode-btn ${chartDimensionMode==='service'?'active':''}" data-dim-mode="service">
            <i class="fas fa-building"></i> Service Type
          </button>
        </div>
      </div>
    `;

    // Event toggle buttons
    const eventBtns = EVENT_ORDER.map(ev => {
      const active = vs[ev];
      const color  = _currentColors(ev)[_currentGroups()[0]?.types[0] || 'real'];
      return `<button class="ms-toggle-btn ${active ? 'active' : 'inactive'}"
        data-toggle-event="${ev}"
        style="${active ? `background:${color};` : ''}"
      ><i class="fas ${EVENT_ICONS[ev]}"></i> ${EVENT_LABELS[ev]}</button>`;
    }).join('');

    // Type/service chips with drag grouping
    const TYPE_COLORS_CAT = { real:'#202124', filler:'#e37400', test:'#8430ce' };
    const TYPE_COLORS_SVC = { residential:'#1a73e8', commercial:'#e37400', multifamily:'#8430ce' };
    const chipColors = chartDimensionMode === 'service' ? TYPE_COLORS_SVC : TYPE_COLORS_CAT;

    const typeGroupHtml = groups.map((group, gi) => {
      const isMulti = group.types.length > 1;
      const chips = group.types.map(type => {
        const color = chipColors[type] || '#333';
        const splitBtn = isMulti
          ? `<button class="type-split-btn" data-split-type="${type}" data-split-group="${gi}" title="Separate">✕</button>`
          : '';
        return `<span class="type-chip ${group.visible ? 'active' : 'inactive'}"
          draggable="true" data-type="${type}" data-group-idx="${gi}"
          style="${group.visible ? `background:${color};` : ''}"
        ><i class="fas ${icons[type]}"></i> ${labels[type]}${splitBtn}</span>`;
      }).join('');
      const pillClass = `type-group-pill${isMulti ? ' multi' : ''}`;
      return `<div class="type-drop-zone" data-drop-before="${gi}"></div>` +
             `<div class="${pillClass}" data-group-idx="${gi}" data-toggle-group="${gi}">${chips}</div>`;
    }).join('') + `<div class="type-drop-zone" data-drop-before="${groups.length}"></div>`;

    return `
      <div class="ms-toggle-bar" id="pipelineToggleBar">
        ${viewToggle}
        ${metricToggle}
        <div class="ms-toggle-divider"></div>
        ${dimToggle}
        <div class="ms-toggle-divider"></div>
        <span class="ms-toggle-label">Show</span>
        ${eventBtns}
        <div class="ms-toggle-divider"></div>
        <span class="ms-toggle-label">${chartDimensionMode === 'service' ? 'Service' : 'Type'}</span>
        <div class="type-groups-area" id="typeGroupsArea">${typeGroupHtml}</div>
      </div>
    `;
  }

  // =========================================================================
  //  RENDER PIPELINE CHART
  // =========================================================================
  function renderPipelineChart(buckets) {
    const activeEvents = EVENT_ORDER.filter(e => chartVisibleSeries[e]);
    const groups       = _currentGroups();
    const activeGroups = groups.filter(g => g.visible);
    const labels       = _currentLabels();
    const activeSeries = getPipelineSeries(buckets);

    if (activeSeries.length === 0) {
      return `<div class="ms-chart-wrap" id="pipelineChartWrap">
        <div class="ms-empty"><i class="fas fa-eye-slash" style="margin-right:8px;opacity:0.4;"></i>No series selected.</div>
      </div>`;
    }

    const groupLabel = g => g.types.length === _currentAllTypes().length ? 'All'
      : g.types.length === 1 ? labels[g.types[0]]
      : g.types.map(t => labels[t]).join('+');

    const groupColor = (ev, g) => _currentColors(ev)[g.types[0]];

    const series = [];
    activeEvents.forEach(ev => {
      activeGroups.forEach(group => {
        series.push({
          color:  groupColor(ev, group),
          label:  `${EVENT_LABELS[ev]} · ${groupLabel(group)}`,
          values: buckets.map(b => group.types.reduce((sum,t) => sum+(b[ev][t]||0), 0)),
        });
      });
    });

    const legendItems = series.map(s => `
      <span class="ms-legend-item">
        <span style="background:${s.color};border-radius:50%;width:7px;height:7px;display:inline-block;margin-right:3px;flex-shrink:0;"></span>
        ${s.label}
      </span>`).join('');

    // ── DAILY: SVG line chart ──
    if (currentPeriod === 'daily' && pipelineChartViewMode !== 'timeofday') {
      let maxVal = 1;
      series.forEach(s => s.values.forEach(v => { if (v > maxVal) maxVal = v; }));
      const W=800, H=160, PL=28, PR=12, PT=10, PB=28;
      const CW=W-PL-PR, CH=H-PT-PB, n=buckets.length;
      const xPos = i => PL + (n<=1 ? CW/2 : (i/(n-1))*CW);
      const yPos = v  => PT + CH - (v/maxVal)*CH;
      let grid='', yLbls='';
      for (let i=0; i<=3; i++) {
        const val = Math.round((maxVal/3)*i);
        const y   = yPos(val);
        grid  += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="${i===0?'#ccc':'#eee'}" stroke-width="${i===0?1:0.5}"/>`;
        yLbls += `<text x="${PL-3}" y="${y+3}" text-anchor="end" font-size="7" fill="#bbb" font-family="sans-serif">${val}</text>`;
      }
      let xLbls='';
      buckets.forEach((b, i) => {
        if (i % 2 !== 0 && i !== n-1) return;
        xLbls += `<text x="${xPos(i).toFixed(1)}" y="${H-PB+10}" text-anchor="middle" font-size="7" fill="#bbb" font-family="sans-serif">${b.label}</text>`;
      });
      let paths='', dotEls='';
      series.forEach(s => {
        const pts   = s.values.map((v,i)=>`${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ');
        const baseY = yPos(0).toFixed(1);
        paths += `<polygon points="${xPos(0).toFixed(1)},${baseY} ${pts} ${xPos(n-1).toFixed(1)},${baseY}" fill="${s.color}" fill-opacity="0.06" stroke="none"/>`;
        paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        s.values.forEach((v,i) => {
          if (v===0) return;
          dotEls += `<circle cx="${xPos(i).toFixed(1)}" cy="${yPos(v).toFixed(1)}" r="2.5" fill="${s.color}" stroke="#fff" stroke-width="1"><title>${s.label}: ${v} @ ${buckets[i].label}</title></circle>`;
        });
      });
      return `
        <div class="ms-chart-wrap" id="pipelineChartWrap" style="padding:12px 12px 4px;">
          <div class="ms-chart-subtitle">Hourly — gap between lines shows pipeline lag</div>
          <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible;">
            ${grid}${yLbls}${xLbls}${paths}${dotEls}
          </svg>
        </div>
        <div class="ms-legend" style="padding:6px 12px 12px;">${legendItems}</div>`;
    }

    // ── WEEKLY/MONTHLY: bar chart ──
    if (pipelineChartViewMode === 'timeofday') {
      let maxVal = pipelineDistributionMetric === 'share' ? 100 : 1;
      activeSeries.forEach(s => s.values.forEach(v => { if (v > maxVal) maxVal = v; }));
      const W=900, H=210, PL=34, PR=14, PT=12, PB=30;
      const CW=W-PL-PR, CH=H-PT-PB, n=buckets.length;
      const xPos = i => PL + (n<=1 ? CW/2 : (i/(n-1))*CW);
      const yPos = v  => PT + CH - (Math.max(0, v)/maxVal)*CH;
      const formatYAxis = value => pipelineDistributionMetric === 'share'
        ? `${Math.round(value)}%`
        : Math.round(value).toLocaleString('en-US');

      let grid='', yLbls='';
      for (let i = 0; i <= 4; i++) {
        const val = (maxVal / 4) * i;
        const y   = yPos(val);
        grid  += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="${i===0?'#ccc':'#eee'}" stroke-width="${i===0?1:0.5}"/>`;
        yLbls += `<text x="${PL-4}" y="${y+3}" text-anchor="end" font-size="7" fill="#bbb" font-family="sans-serif">${formatYAxis(val)}</text>`;
      }
      let xLbls='';
      buckets.forEach((b, i) => {
        if (i % 2 !== 0 && i !== n-1) return;
        xLbls += `<text x="${xPos(i).toFixed(1)}" y="${H-PB+11}" text-anchor="middle" font-size="7" fill="#bbb" font-family="sans-serif">${b.shortLabel}</text>`;
      });
      let paths='', dotEls='';
      activeSeries.forEach(s => {
        const pts   = s.values.map((v,i)=>`${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ');
        const baseY = yPos(0).toFixed(1);
        paths += `<polygon points="${xPos(0).toFixed(1)},${baseY} ${pts} ${xPos(n-1).toFixed(1)},${baseY}" fill="${s.color}" fill-opacity="0.05" stroke="none"/>`;
        paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
        s.values.forEach((v,i) => {
          if (v===0) return;
          const raw = s.rawValues[i] || 0;
          const metricValue = pipelineDistributionMetric === 'share'
            ? `${v.toFixed(v >= 10 ? 0 : 1)}%`
            : raw.toLocaleString('en-US');
          const tooltip = pipelineDistributionMetric === 'share'
            ? `${s.label}: ${metricValue} (${raw.toLocaleString('en-US')} events) at ${buckets[i].label}`
            : `${s.label}: ${metricValue} at ${buckets[i].label}`;
          dotEls += `<circle cx="${xPos(i).toFixed(1)}" cy="${yPos(v).toFixed(1)}" r="2.6" fill="${s.color}" stroke="#fff" stroke-width="1"><title>${tooltip}</title></circle>`;
        });
      });
      const subtitle = pipelineDistributionMetric === 'share'
        ? 'Each line shows what share of that visible series lands in each hour across the selected range.'
        : 'Counts are aggregated into local hour buckets across the selected range so you can spot staffing peaks.';
      return `
        <div class="ms-chart-wrap" id="pipelineChartWrap" style="padding:12px 12px 4px;">
          <div class="ms-chart-subtitle">${subtitle}</div>
          ${renderTimeOfDayHighlights(activeSeries, buckets)}
          <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible;">
            ${grid}${yLbls}${xLbls}${paths}${dotEls}
          </svg>
        </div>
        <div class="ms-legend" style="padding:6px 12px 12px;">${renderPipelineLegend(activeSeries)}</div>`;
    }

    const BAR_HEIGHT = 100;
    let maxVal = 1;
    buckets.forEach(b => {
      activeEvents.forEach(ev => {
        activeGroups.forEach(group => {
          const total = group.types.reduce((s,t) => s+(b[ev][t]||0), 0);
          if (total > maxVal) maxVal = total;
        });
      });
    });

    const bars = buckets.map(b => {
      const evGroups = activeEvents.map(ev => {
        return activeGroups.map(group => {
          const total = group.types.reduce((s,t) => s+(b[ev][t]||0), 0);
          if (total === 0) return `<div class="ms-bar-group"><div class="ms-bar-group-dot" style="background:${groupColor(ev,group)};"></div></div>`;
          const h = Math.max(3, Math.round((total/maxVal)*BAR_HEIGHT));
          const segs = group.types.length === 1
            ? `<div class="ms-bar-segment" style="height:${h}px;background:${groupColor(ev,group)};" title="${EVENT_LABELS[ev]} · ${labels[group.types[0]]}: ${total}"></div>`
            : group.types.map(t => {
                const c = b[ev][t]||0; if (!c) return '';
                const sh = Math.max(2, Math.round((c/maxVal)*BAR_HEIGHT));
                return `<div class="ms-bar-segment" style="height:${sh}px;background:${_currentColors(ev)[t]};" title="${EVENT_LABELS[ev]} · ${labels[t]}: ${c}"></div>`;
              }).join('');
          return `<div class="ms-bar-group">${segs}</div>`;
        }).join('');
      }).join('');
      const label = currentPeriod==='monthly' ? b.shortLabel : b.label;
      return `<div class="ms-bucket"><div class="ms-groups">${evGroups}</div><div class="ms-bucket-label">${label}</div></div>`;
    }).join('');

    return `
      <div class="ms-chart-wrap" id="pipelineChartWrap">
        <div class="ms-chart-subtitle">Daily — offset between bar groups shows pipeline lag</div>
        <div class="ms-chart">${bars}</div>
      </div>
      <div class="ms-legend" style="padding:6px 12px 12px;">${legendItems}</div>`;
  }

  // =========================================================================
  //  RENDER STATS (main)
  // =========================================================================
  async function renderStats() {
    const content = document.getElementById('statsContent');
    if (!content) return;

    const renderSeq = ++statsRenderSeq;
    const range   = getDateRange(currentDate, currentPeriod);
    document.getElementById('statsDateLabel').textContent = range.label;
    document.getElementById('statsNextBtn').disabled = !canNavigateForward(currentDate, currentPeriod);
    content.innerHTML = '<div class="stats-loading"><i class="fas fa-spinner fa-spin"></i><p>Calculating statistics...</p></div>';
    await nextFrame();
    if (renderSeq !== statsRenderSeq) return;

    const prevRange = getPreviousStatsRange(range);
    await fetchStatsCreditRevenue(range, prevRange, renderSeq);
    if (renderSeq !== statsRenderSeq) return;

    const stats   = calculateStats(allProjects, range);
    const buckets = pipelineChartViewMode === 'timeofday'
      ? buildTimeOfDayBuckets(allProjects, range)
      : buildMultiSeriesBuckets(allProjects, range);

    const totalTrend   = stats.prevTotal   > 0 ? ((stats.totalCompleted - stats.prevTotal) / stats.prevTotal * 100) : 0;
    const revenueTrend = stats.prevRevenue > 0 ? ((stats.totalRevenue - stats.prevRevenue) / stats.prevRevenue * 100) : 0;
    const trendClass = v => v > 0 ? 'up' : v < 0 ? 'down' : 'neutral';
    const trendIcon  = v => v > 0 ? '<i class="fas fa-arrow-up"></i>' : v < 0 ? '<i class="fas fa-arrow-down"></i>' : '<i class="fas fa-minus"></i>';

    const dateModeToggle = `
      <div class="date-mode-toggle">
        <button class="date-mode-btn ${chartDateMode==='requested'?'active':''}" data-mode="requested"><i class="fas fa-shopping-cart"></i> Requested</button>
        <button class="date-mode-btn ${chartDateMode==='drawn'?'active':''}" data-mode="drawn"><i class="fas fa-pencil-ruler"></i> Drawn</button>
        <button class="date-mode-btn ${chartDateMode==='completed'?'active':''}" data-mode="completed"><i class="fas fa-check-circle"></i> Completed</button>
      </div>
    `;

    const reportRows = [
      {
        label: 'Total Reports',
        value: stats.totalCompleted,
        valueClass: '',
        detailHtml: `<span class="trend ${trendClass(totalTrend)}">${trendIcon(totalTrend)} ${fmtPercent(Math.abs(totalTrend), 0)} vs prev</span>`,
      },
      {
        label: 'Real Reports',
        value: stats.realCompleted,
        valueClass: 'green',
        detail: fmtPercent(stats.totalCompleted > 0 ? (stats.realCompleted / stats.totalCompleted) * 100 : 0, 0),
      },
      {
        label: 'Filler Reports',
        value: stats.fillerCompleted,
        valueClass: 'orange',
        detail: fmtPercent(stats.totalCompleted > 0 ? (stats.fillerCompleted / stats.totalCompleted) * 100 : 0, 0),
      },
      {
        label: 'Test Reports',
        value: stats.testCompleted,
        valueClass: 'purple',
        detail: fmtPercent(stats.totalCompleted > 0 ? (stats.testCompleted / stats.totalCompleted) * 100 : 0, 0),
      },
      {
        label: 'Rejected / Day',
        note: 'Average terminally rejected reports per day in the selected period, using rejection date. The detail shows the total number rejected in that period.',
        value: stats.rejectedPerDay,
        valueDigits: currentPeriod === 'daily' ? 0 : 1,
        valueClass: 'red',
        detail: `${fmtMetricNumber(stats.totalRejected, 0)} total rejected`,
      },
    ];

    const reportStatsPanel = `
      <div class="overview-panel">
        <h4>Report Stats</h4>
        <div class="panel-subtitle">Top-level report counts using ${getSummaryDateBasisLabel()}.</div>
        <div class="stats-table-wrap">
          <table class="overview-table">
            <thead>
              <tr><th>Metric</th><th style="text-align:right;">Count</th><th style="text-align:right;">Share / Trend</th></tr>
            </thead>
            <tbody>
              ${reportRows.map((row, idx) => `
                <tr class="${idx === 0 ? 'highlight' : ''}">
                  <td class="metric">
                    <span class="metric-label">
                      <span>${row.label}</span>
                      ${row.note ? `<span class="metric-help" title="${Portal.escapeHtml(row.note)}">?</span>` : ''}
                    </span>
                  </td>
                  <td class="value ${row.valueClass}">${fmtMetricNumber(row.value, row.valueDigits ?? 0)}</td>
                  <td class="detail">${row.detailHtml || row.detail || '&mdash;'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const grossRevenueTrend = stats.prevActualRevenue > 0 ? ((stats.actualRevenue - stats.prevActualRevenue) / stats.prevActualRevenue) * 100 : 0;
    const payoutPctOfGross = stats.actualRevenue > 0 ? (stats.totalPayoutUsd / stats.actualRevenue) * 100 : 0;
    const creditMargin = stats.totalRevenue > 0 ? (stats.netCreditIncome / stats.totalRevenue) * 100 : 0;
    const profitMargin = stats.actualRevenue > 0 ? (stats.netProfit / stats.actualRevenue) * 100 : 0;
    const financialRows = [
      {
        label: 'Gross Revenue',
        note: 'Actual cash revenue received during the selected period. Stripe checkouts use paid dollars only, auto top-ups use the charged amount, and signup-match bonus credit, coupons, and manual free credits are excluded.',
        value: fmtCurrency(stats.actualRevenue),
        valueClass: 'green',
        detailHtml: `<span class="trend ${trendClass(grossRevenueTrend)}">${trendIcon(grossRevenueTrend)} ${fmtPercent(Math.abs(grossRevenueTrend), 0)} vs prev</span>`,
      },
      {
        label: 'Report Credit Usage',
        note: 'Completed report value from real reports in the selected period. Uses stored amount_charged when available, otherwise base report pricing plus known add-on fallbacks such as gutters.',
        value: fmtCurrency(stats.totalRevenue),
        valueClass: 'green',
        detailHtml: `<span class="trend ${trendClass(revenueTrend)}">${trendIcon(revenueTrend)} ${fmtPercent(Math.abs(revenueTrend), 0)} vs prev</span>`,
      },
      {
        label: 'Total Payouts',
        note: 'Total payouts for the selected period, including technician point pay, rush bonuses, rank-based technician base pay, QA shifts, and manager shifts.',
        value: fmtCurrency(stats.totalPayoutUsd),
        valueClass: 'orange',
        detail: stats.actualRevenue > 0 ? fmtPercent(payoutPctOfGross, 0) + ' of gross revenue' : 'No gross revenue',
      },
      {
        label: 'Net Credit Income',
        note: 'Report credit usage minus total payouts. This is the theoretical income based on report value rather than when cash was collected.',
        value: fmtCurrency(stats.netCreditIncome),
        valueClass: stats.netCreditIncome >= 0 ? 'blue' : 'red',
        detail: fmtPercent(creditMargin, 0) + ' credit margin',
      },
      {
        label: 'Net Profit',
        note: 'Actual gross revenue minus total payouts. This uses cash collected only, not bonus credits, coupons, or other free credits.',
        value: fmtCurrency(stats.netProfit),
        valueClass: stats.netProfit >= 0 ? 'blue' : 'red',
        detail: fmtPercent(profitMargin, 0) + ' profit margin',
      },
    ];

    const financialStatsPanel = `
      <div class="overview-panel">
        <h4>Financial Stats</h4>
        <div class="panel-subtitle">Actual cash revenue, report credit usage, payouts, and profit for the selected period.</div>
        <div class="stats-table-wrap">
          <table class="overview-table">
            <thead>
              <tr><th>Metric</th><th style="text-align:right;">Value</th><th style="text-align:right;">Detail</th></tr>
            </thead>
            <tbody>
              ${financialRows.map((row, idx) => `
                <tr class="${idx === 0 ? 'highlight' : ''}">
                  <td class="metric">
                    <span class="metric-label">
                      <span>${row.label}</span>
                      <span class="metric-help" title="${Portal.escapeHtml(row.note)}">?</span>
                    </span>
                  </td>
                  <td class="value ${row.valueClass}">${row.value}</td>
                  <td class="detail">${row.detailHtml || row.detail || '&mdash;'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const companyMetricRows = [
      stats.companyMetrics.weeklyActiveCompanies,
      stats.companyMetrics.companiesOrdered,
      stats.companyMetrics.companySignups,
      stats.companyMetrics.activeCompanySignups,
    ];

    const weeklyActivePanel = `
      <div class="overview-panel">
        <div class="stats-table-wrap">
          <table class="overview-table">
            <tbody>
              ${companyMetricRows.map((row, idx) => `
                <tr class="${idx === 0 ? 'highlight' : ''}">
                  <td class="metric">
                    <span class="metric-label">
                      <span>${row.label}</span>
                      <span class="metric-help" title="${Portal.escapeHtml(row.note)}">?</span>
                    </span>
                  </td>
                  <td class="value blue">${row.displayValue}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const revenueBreakdownPanel = `
      <div class="overview-panel">
        <h4>Revenue Breakdown by Service Type</h4>
        <div class="panel-subtitle">Counts and revenue share for real projects in the selected period.</div>
        <div class="stats-table-wrap">
          <table class="overview-table">
            <thead>
              <tr><th>Service Type</th><th style="text-align:right;">Reports</th><th style="text-align:right;">Revenue</th><th style="text-align:right;">% of Revenue</th></tr>
            </thead>
            <tbody>
              ${ALL_SERVICE_TYPES.map(svc => {
                const count = stats.countByType[svc] || 0;
                const revenue = stats.revByType[svc] || 0;
                const pct = stats.totalRevenue > 0 ? (revenue / stats.totalRevenue) * 100 : 0;
                return `
                  <tr class="${revenue > 0 ? 'highlight' : ''}">
                    <td class="metric">${SERVICE_LABELS[svc]}</td>
                    <td class="value">${fmtMetricNumber(count, 0)}</td>
                    <td class="value green">${fmtCurrency(revenue)}</td>
                    <td class="mix-cell">
                      <div class="mix-line">
                        <span class="mix-pct">${fmtPercent(pct, 1)}</span>
                        <span class="mix-bar"><span class="mix-bar-fill" style="width:${Math.max(0, Math.min(100, pct))}%;background:${SERVICE_SUMMARY_COLORS[svc]};"></span></span>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const rejectionBreakdownPanel = renderRejectionBreakdownByService(stats);

    const addons = stats.addonStats || {};
    const addOnRows = [
      {
        label: 'Included Gutters',
        count: addons.gutterOrders || 0,
        share: (addons.orders || 0) > 0 ? ((addons.gutterOrders || 0) / addons.orders) * 100 : 0,
        revenue: addons.gutterRevenue || 0,
        detail: `${fmtPercent((addons.orders || 0) > 0 ? ((addons.gutterOrders || 0) / addons.orders) * 100 : 0, 1)} of real reports`,
        color: '#1a73e8',
      },
      {
        label: 'Under 1 Hour Expedite',
        count: addons.expediteLevel1Orders || 0,
        share: (addons.orders || 0) > 0 ? ((addons.expediteLevel1Orders || 0) / addons.orders) * 100 : 0,
        revenue: addons.expediteLevel1Revenue || 0,
        detail: 'Extra expedite revenue',
        color: '#e37400',
      },
      {
        label: '1-3 Hour Expedite',
        count: addons.expediteLevel2Orders || 0,
        share: (addons.orders || 0) > 0 ? ((addons.expediteLevel2Orders || 0) / addons.orders) * 100 : 0,
        revenue: addons.expediteLevel2Revenue || 0,
        detail: 'Extra expedite revenue',
        color: '#d93025',
      },
      {
        label: 'Storm Weather Reports',
        count: addons.stormWeatherOrders || 0,
        share: (addons.orders || 0) > 0 ? ((addons.stormWeatherOrders || 0) / addons.orders) * 100 : 0,
        revenue: addons.stormWeatherRevenue || 0,
        detail: 'Extra weather report revenue',
        color: '#8430ce',
      },
    ];
    const addonsPanel = `
      <div class="overview-panel">
        <h4>Add-ons</h4>
        <div class="panel-subtitle">Real completed reports only. Add-on dollars use stored charge fields when present and known pricing fallbacks where available.</div>
        <div class="stats-table-wrap">
          <table class="overview-table">
            <thead>
              <tr>
                <th>Add-on</th>
                <th style="text-align:right;">Orders</th>
                <th style="text-align:right;">Share</th>
                <th style="text-align:right;">Extra Revenue</th>
                <th style="text-align:right;">Detail</th>
              </tr>
            </thead>
            <tbody>
              ${addOnRows.map(row => `
                  <tr class="${row.count > 0 ? 'highlight' : ''}">
                    <td class="metric">${row.label}</td>
                    <td class="value">${fmtMetricNumber(row.count, 0)}</td>
                    <td class="mix-cell">
                      <div class="mix-line">
                        <span class="mix-pct">${fmtPercent(row.share, 1)}</span>
                        <span class="mix-bar"><span class="mix-bar-fill" style="width:${Math.max(0, Math.min(100, row.share))}%;background:${row.color};"></span></span>
                      </div>
                    </td>
                    <td class="value green">${fmtCurrency(row.revenue)}</td>
                    <td class="detail">${row.detail}</td>
                  </tr>
              `).join('')}
              <tr class="totals">
                <td><b>Base vs Add-on Revenue</b></td>
                <td class="value"><b>${fmtMetricNumber(addons.orders || 0, 0)}</b></td>
                <td class="detail">${stats.totalRevenue > 0 ? fmtPercent(((addons.addonRevenue || 0) / stats.totalRevenue) * 100, 1) + ' add-on revenue' : '&mdash;'}</td>
                <td class="value green"><b>${fmtCurrency(addons.addonRevenue || 0)}</b></td>
                <td class="detail">Base: ${fmtCurrency(addons.baseRevenue || 0)}${(addons.unattributedAddonRevenue || 0) > 0 ? ` | Unattributed extra: ${fmtCurrency(addons.unattributedAddonRevenue || 0)}` : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const svcBars = '';

    content.innerHTML = `
      <!-- Summary Cards -->
      <div class="stats-summary">
        <div class="summary-card">
          <div class="label">Total Reports</div>
          <div class="value">${stats.totalCompleted}</div>
          <div class="trend ${trendClass(totalTrend)}">${trendIcon(totalTrend)} ${Math.abs(totalTrend)}% vs prev</div>
        </div>
        <div class="summary-card">
          <div class="label">Real Reports</div>
          <div class="value green">${stats.realCompleted}</div>
          <div class="sub">${stats.totalCompleted>0?((stats.realCompleted/stats.totalCompleted)*100).toFixed(0):0}% of total</div>
        </div>
        <div class="summary-card">
          <div class="label">Filler Reports</div>
          <div class="value orange">${stats.fillerCompleted}</div>
          <div class="sub">${stats.totalCompleted>0?((stats.fillerCompleted/stats.totalCompleted)*100).toFixed(0):0}% of total</div>
        </div>
        <div class="summary-card">
          <div class="label">Test Reports</div>
          <div class="value" style="color:#8430ce;">${stats.testCompleted}</div>
          <div class="sub">${stats.totalCompleted>0?((stats.testCompleted/stats.totalCompleted)*100).toFixed(0):0}% of total</div>
        </div>
        <div class="summary-card">
          <div class="label">Gross Revenue</div>
          <div class="value green">${fmtCurrency(stats.actualRevenue)}</div>
          <div class="trend ${trendClass(grossRevenueTrend)}">${trendIcon(grossRevenueTrend)} ${Math.abs(grossRevenueTrend)}% vs prev</div>
          ${svcBars ? `<div class="svc-bar-wrap">${svcBars}</div>` : ''}
        </div>
        <div class="summary-card">
          <div class="label">Total Payouts</div>
          <div class="value orange">${fmtCurrency(stats.totalPayoutUsd)}</div>
          <div class="sub">All costs (PHP → USD)</div>
        </div>
        <div class="summary-card">
          <div class="label">Net Profit</div>
          <div class="value ${stats.netProfit>=0?'blue':'red'}">${fmtCurrency(stats.netProfit)}</div>
          <div class="sub">${fmtPercent(profitMargin, 0)} margin</div>
        </div>
      </div>

      <!-- Summary date mode note -->
      <div style="font-size:11px;color:#999;font-weight:600;margin:-15px 0 20px;font-style:italic;">
        Summary counts use:
        <span id="summaryDateModeLabel" style="color:#5f6368;font-weight:700;">
          ${chartDateMode === 'requested' ? 'date requested' : chartDateMode === 'drawn' ? 'date drawn' : 'date completed'}
        </span>
        ${dateModeToggle}
      </div>

      <!-- Revenue by Service Type -->
      <div class="stats-section-title"><i class="fas fa-tags"></i> Revenue by Service Type</div>
      ${renderRevenueByType(stats)}

      <!-- Cost Breakdown -->
      <div class="stats-section-title"><i class="fas fa-file-invoice-dollar"></i> Cost Breakdown (PHP → USD)</div>
      ${renderCostBreakdown(stats)}

      <!-- Complexity Distribution -->
      <div class="stats-section-title"><i class="fas fa-layer-group"></i> Complexity Distribution</div>
      ${renderComplexityDist(stats.complexityDist, stats.totalCompleted)}

      <!-- Turnaround Times -->
      <div class="stats-section-title"><i class="fas fa-stopwatch"></i> Turnaround Times</div>
      ${renderStageTimes(stats.avgStageTimes)}

      <!-- Pipeline Flow Chart -->
      <div class="stats-section-title" id="pipelineSectionTitle" style="margin-bottom:0;">
        <i class="fas fa-stream"></i> Pipeline Flow — Reports by ${currentPeriod === 'daily' ? 'Hour' : 'Day'}
      </div>
      ${renderPipelineToggleBar()}
      ${renderPipelineChart(buckets)}

      <!-- Organization Breakdown -->
      <div class="stats-section-title"><i class="fas fa-building"></i> Breakdown by Organization</div>
      ${renderOrgTable(stats.orgBreakdown)}

      <!-- Technician Performance -->
      <div class="stats-section-title"><i class="fas fa-users"></i> Technician Performance</div>
      ${renderTechGrid(stats.techBreakdown, range)}
    `;

    const topLayoutHtml = `
      <div class="stats-filter-note">
        <div class="note-text">
          Summary counts use <span id="summaryDateModeLabel" style="color:#5f6368;font-weight:700;">${getSummaryDateBasisLabel()}</span>.
        </div>
        ${dateModeToggle}
      </div>
      <div class="stats-overview-grid">
        <div class="stats-overview-col">
          ${reportStatsPanel}
          ${rejectionBreakdownPanel}
          ${weeklyActivePanel}
        </div>
        <div class="stats-overview-col">
          ${financialStatsPanel}
          ${addonsPanel}
          ${revenueBreakdownPanel}
        </div>
      </div>
    `;

    const legacySummaryCards = content.querySelector('.stats-summary');
    const legacySummaryNote = legacySummaryCards ? legacySummaryCards.nextElementSibling : null;
    const legacyRevenueTitle = legacySummaryNote ? legacySummaryNote.nextElementSibling : null;
    const legacyRevenueBody = legacyRevenueTitle ? legacyRevenueTitle.nextElementSibling : null;

    if (legacySummaryCards) {
      const wrap = document.createElement('div');
      wrap.innerHTML = topLayoutHtml;
      legacySummaryCards.replaceWith(...Array.from(wrap.childNodes));
    }
    [legacySummaryNote, legacyRevenueTitle, legacyRevenueBody].forEach(el => {
      if (el && el.parentNode) el.remove();
    });

    const stageTitleEl = Array.from(content.querySelectorAll('.stats-section-title'))
      .find(el => el.textContent.includes('Turnaround Times'));
    const legacyStageBody = stageTitleEl ? stageTitleEl.nextElementSibling : null;
    if (legacyStageBody) legacyStageBody.outerHTML = renderStageTimesByProjectType(stats);

    const pipelineTitleEl = document.getElementById('pipelineSectionTitle');
    if (pipelineTitleEl) {
      pipelineTitleEl.innerHTML = `<i class="fas fa-stream"></i> ${getPipelineSectionTitle()}`;
    }

    // Wire date mode toggle
    content.querySelectorAll('.date-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode !== chartDateMode) { chartDateMode = btn.dataset.mode; renderStats(); }
      });
    });

    // ── Pipeline wiring ──
    function _refreshPipelineUI() {
      const pipelineTitle = document.getElementById('pipelineSectionTitle');
      if (pipelineTitle) {
        pipelineTitle.innerHTML = `<i class="fas fa-stream"></i> ${getPipelineSectionTitle()}`;
      }
      const toggleBarEl = document.getElementById('pipelineToggleBar');
      if (toggleBarEl) {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderPipelineToggleBar();
        toggleBarEl.replaceWith(tmp.firstElementChild);
      }
      const newBar = document.getElementById('pipelineToggleBar');
      if (newBar) {
        let next = newBar.nextElementSibling;
        while (next && !next.classList.contains('stats-section-title')) {
          const rem = next; next = next.nextElementSibling; rem.remove();
        }
        const nextBuckets = pipelineChartViewMode === 'timeofday'
          ? buildTimeOfDayBuckets(allProjects, range)
          : buildMultiSeriesBuckets(allProjects, range);
        newBar.insertAdjacentHTML('afterend',
          renderPipelineChart(nextBuckets));
      }
    }

    if (_pipelineToggleHandler) content.removeEventListener('click', _pipelineToggleHandler);
    _pipelineToggleHandler = function(e) {
      const orgSortBtn = e.target.closest('[data-org-sort]');
      if (orgSortBtn) {
        const key = orgSortBtn.dataset.orgSort;
        if (orgSortState.key === key) {
          orgSortState.dir = orgSortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          orgSortState = { key, dir: key === 'name' ? 'asc' : 'desc' };
        }
        renderStats();
        return;
      }

      // Dimension mode switch
      const dimBtn = e.target.closest('[data-dim-mode]');
      if (dimBtn) {
        const mode = dimBtn.dataset.dimMode;
        if (mode !== chartDimensionMode) { chartDimensionMode = mode; _refreshPipelineUI(); }
        return;
      }

      const pipelineViewBtn = e.target.closest('[data-pipeline-view]');
      if (pipelineViewBtn) {
        const mode = pipelineViewBtn.dataset.pipelineView;
        if (mode !== pipelineChartViewMode) {
          pipelineChartViewMode = mode;
          if (mode === 'timeline') pipelineDistributionMetric = 'count';
          _refreshPipelineUI();
        }
        return;
      }

      const pipelineMetricBtn = e.target.closest('[data-pipeline-metric]');
      if (pipelineMetricBtn) {
        const metric = pipelineMetricBtn.dataset.pipelineMetric;
        if (metric !== pipelineDistributionMetric) {
          pipelineDistributionMetric = metric;
          _refreshPipelineUI();
        }
        return;
      }

      // Split button
      const splitBtn = e.target.closest('[data-split-type]');
      if (splitBtn) {
        e.stopPropagation();
        const type = splitBtn.dataset.splitType;
        const gi   = parseInt(splitBtn.dataset.splitGroup, 10);
        const groups = _currentGroups();
        const wasVisible = groups[gi].visible;
        groups[gi].types = groups[gi].types.filter(t => t !== type);
        if (groups[gi].types.length === 0) groups.splice(gi, 1);
        const insertAt = Math.min(gi + 1, groups.length);
        groups.splice(insertAt, 0, { types: [type], visible: wasVisible });
        _saveCurrentGroups();
        _refreshPipelineUI();
        return;
      }

      // Event toggle
      const evBtn = e.target.closest('[data-toggle-event]');
      if (evBtn) {
        chartVisibleSeries[evBtn.dataset.toggleEvent] = !chartVisibleSeries[evBtn.dataset.toggleEvent];
        _refreshPipelineUI();
        return;
      }

      // Group visibility toggle via pill
      const groupPill = e.target.closest('[data-toggle-group]');
      if (groupPill && !e.target.closest('.type-chip[draggable]')) {
        const gi = parseInt(groupPill.dataset.toggleGroup, 10);
        const groups = _currentGroups();
        if (groups[gi]) { groups[gi].visible = !groups[gi].visible; _saveCurrentGroups(); _refreshPipelineUI(); }
        return;
      }

      // Chip click toggles group
      const chip = e.target.closest('.type-chip[data-group-idx]');
      if (chip && !e.target.closest('[data-split-type]')) {
        const gi = parseInt(chip.dataset.groupIdx, 10);
        const groups = _currentGroups();
        if (groups[gi]) { groups[gi].visible = !groups[gi].visible; _saveCurrentGroups(); _refreshPipelineUI(); }
      }
    };
    content.addEventListener('click', _pipelineToggleHandler);

    // Drag-and-drop
    if (_pipelineDragHandler) {
      ['dragstart','dragover','dragleave','drop'].forEach(t => content.removeEventListener(t, _pipelineDragHandler));
    }
    _pipelineDragHandler = function(e) {
      if (e.type === 'dragstart') {
        const chip = e.target.closest('.type-chip[draggable]');
        if (!chip) return;
        _dragState = { type: chip.dataset.type, srcGi: parseInt(chip.dataset.groupIdx, 10) };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', chip.dataset.type);
        setTimeout(() => chip.classList.add('dragging'), 0);
        content.querySelectorAll('.type-drop-zone').forEach(z => z.classList.add('drag-active'));
        return;
      }
      if (e.type === 'dragend') {
        content.querySelectorAll('.type-chip').forEach(c => c.classList.remove('dragging'));
        content.querySelectorAll('.type-drop-zone').forEach(z => z.classList.remove('drag-active','drag-over'));
        content.querySelectorAll('.type-group-pill').forEach(p => p.classList.remove('drag-over'));
        _dragState = null;
        return;
      }
      if (e.type === 'dragover') {
        if (!_dragState) return;
        const zone = e.target.closest('.type-drop-zone');
        const pill = e.target.closest('.type-group-pill');
        if (!zone && !pill) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        content.querySelectorAll('.type-drop-zone').forEach(z => z.classList.remove('drag-over'));
        content.querySelectorAll('.type-group-pill').forEach(p => p.classList.remove('drag-over'));
        if (zone) zone.classList.add('drag-over');
        else if (pill) pill.classList.add('drag-over');
        return;
      }
      if (e.type === 'dragleave') {
        const bar = document.getElementById('pipelineToggleBar');
        if (bar && !bar.contains(e.relatedTarget)) {
          content.querySelectorAll('.type-drop-zone').forEach(z => z.classList.remove('drag-over'));
          content.querySelectorAll('.type-group-pill').forEach(p => p.classList.remove('drag-over'));
        }
        return;
      }
      if (e.type === 'drop') {
        e.preventDefault();
        if (!_dragState) return;
        const { type, srcGi } = _dragState;
        _dragState = null;
        const groups = _currentGroups();
        content.querySelectorAll('.type-chip').forEach(c => c.classList.remove('dragging'));
        content.querySelectorAll('.type-drop-zone').forEach(z => z.classList.remove('drag-active','drag-over'));
        content.querySelectorAll('.type-group-pill').forEach(p => p.classList.remove('drag-over'));
        const zone = e.target.closest('.type-drop-zone');
        const pill = e.target.closest('.type-group-pill');
        if (zone) {
          let insertBefore = parseInt(zone.dataset.dropBefore, 10);
          const isAlreadyAlone =
            groups[srcGi] && groups[srcGi].types.length === 1 && groups[srcGi].types[0] === type &&
            (insertBefore === srcGi || insertBefore === srcGi + 1);
          if (isAlreadyAlone) return;
          const wasVisible = groups[srcGi] ? groups[srcGi].visible : true;
          if (groups[srcGi]) {
            groups[srcGi].types = groups[srcGi].types.filter(t => t !== type);
            if (groups[srcGi].types.length === 0) { groups.splice(srcGi, 1); if (insertBefore > srcGi) insertBefore--; }
          }
          groups.splice(insertBefore, 0, { types: [type], visible: wasVisible });
        } else if (pill) {
          const anchorEl = pill.querySelector('[data-type]');
          if (!anchorEl) return;
          const anchorType = anchorEl.dataset.type;
          if (anchorType === type) return;
          const wasVisible = groups[srcGi] ? groups[srcGi].visible : true;
          if (groups[srcGi]) {
            groups[srcGi].types = groups[srcGi].types.filter(t => t !== type);
            if (groups[srcGi].types.length === 0) groups.splice(srcGi, 1);
          }
          const tgtGi = groups.findIndex(g => g.types.includes(anchorType));
          if (tgtGi >= 0 && !groups[tgtGi].types.includes(type)) groups[tgtGi].types.push(type);
        } else { return; }
        _saveCurrentGroups();
        _refreshPipelineUI();
      }
    };
    ['dragstart','dragend','dragover','dragleave','drop'].forEach(t => content.addEventListener(t, _pipelineDragHandler));
  }

  // =========================================================================
  //  REJECTION BREAKDOWN
  // =========================================================================
  function renderRejectionBreakdownByService(stats) {
    const rows = ALL_SERVICE_TYPES.map(svc => {
      const row = stats.rejectionByServiceType?.[svc] || {};
      const requested = row.requested || 0;
      const rejectedFromRequests = row.rejectedFromRequests || 0;
      const rejectedInPeriod = row.rejectedInPeriod || 0;
      const rejectionRate = row.rejectionRate || 0;
      const shareOfRejected = row.shareOfRejected || 0;
      return `
        <tr class="${rejectedFromRequests > 0 || rejectedInPeriod > 0 ? 'highlight' : ''}">
          <td class="metric">
            <span class="metric-label">
              <i class="fas ${SERVICE_ICONS[svc]}" style="color:${SERVICE_SUMMARY_COLORS[svc]};"></i>
              <span>${SERVICE_LABELS[svc]}</span>
            </span>
          </td>
          <td class="value">${fmtMetricNumber(requested, 0)}</td>
          <td class="value red">${fmtMetricNumber(rejectedFromRequests, 0)}</td>
          <td class="mix-cell">
            <div class="mix-line">
              <span class="mix-pct">${fmtPercent(rejectionRate, 1)}</span>
              <span class="mix-bar"><span class="mix-bar-fill" style="width:${Math.max(0, Math.min(100, rejectionRate))}%;background:#c5221f;"></span></span>
            </div>
          </td>
          <td class="detail">${fmtMetricNumber(rejectedInPeriod, 0)} (${fmtPercent(shareOfRejected, 1)})</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="overview-panel">
        <h4>Rejection Breakdown by Service Type</h4>
        <div class="panel-subtitle">Real reports only. The rate is rejected reports from this requested-date cohort divided by requested reports, so residential volume does not overwhelm the smaller categories.</div>
        <div class="stats-table-wrap">
          <table class="overview-table">
            <thead>
              <tr>
                <th>Service Type</th>
                <th style="text-align:right;">Requested</th>
                <th style="text-align:right;">Rejected</th>
                <th style="text-align:right;">Reject Rate</th>
                <th style="text-align:right;">Rejected This Period</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // =========================================================================
  //  REVENUE BY SERVICE TYPE
  // =========================================================================
  function renderRevenueByType(stats) {
    const typeConfigs = [
      { key:'residential', label:'Residential', icon:'fa-home', color:'#1a73e8',
        desc:`$${PRICE_PER_TYPE.residential}/report` },
      { key:'commercial',  label:'Commercial',  icon:'fa-building', color:'#e37400',
        desc:`$${PRICE_PER_TYPE.commercial} × structures` },
      { key:'multifamily', label:'Multi-Family', icon:'fa-city', color:'#8430ce',
        desc:`$${PRICE_PER_TYPE.multifamily} × structures` },
    ];

    const cards = typeConfigs.map(tc => {
      const count = stats.countByType[tc.key] || 0;
      const rev   = stats.revByType[tc.key] || 0;
      return `<div class="rev-type-card" style="border-top:4px solid ${tc.color};">
        <div class="rv-count" style="color:${tc.color};">${count}</div>
        <div class="rv-label" style="color:${tc.color};"><i class="fas ${tc.icon}" style="margin-right:4px;"></i>${tc.label}</div>
        <div class="rv-price">${tc.desc}</div>
        <div class="rv-rev">${fmtCurrency(rev)}</div>
      </div>`;
    }).join('');

    const avgRevPerReal = stats.realCompleted > 0 ? (stats.totalRevenue / stats.realCompleted) : 0;
    return `
      <div class="rev-by-type">${cards}
        <div class="rev-type-card" style="border-top:4px solid #137333;">
          <div class="rv-count" style="color:#137333;">${stats.realCompleted}</div>
          <div class="rv-label" style="color:#137333;"><i class="fas fa-sigma" style="margin-right:4px;"></i>Total Real</div>
          <div class="rv-price">avg ${fmtCurrency(avgRevPerReal)}/report</div>
          <div class="rv-rev">${fmtCurrency(stats.totalRevenue)}</div>
        </div>
      </div>`;
  }

  // =========================================================================
  //  COST BREAKDOWN TABLE
  // =========================================================================
  function renderCostBreakdown(stats) {
    const reportPayDetails = `${fmtMetricNumber(stats.totalTechnicianPoints || 0, 0)} pts across ${stats.realCompleted} real reports`;
    const speedDetails = SPEED_RATE_BANDS
      .map((band, idx) => {
        const count = stats.speedBandCounts?.[idx] || 0;
        if (!count) return '';
        const points = stats.speedBandPoints?.[idx] || 0;
        return `${band.label}: ${count} / ${fmtMetricNumber(points, 0)} pts`;
      })
      .filter(Boolean)
      .join(' | ');
    return `
      <table class="cost-breakdown">
        <thead>
          <tr><th>Category</th><th style="text-align:right;">PHP</th><th style="text-align:right;">USD</th><th style="text-align:right;">Details</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><div class="cat-label"><i class="fas fa-file-alt" style="color:#1a73e8;"></i> Technician Point Pay</div></td>
            <td class="r">${Math.round(stats.totalReportPayPhp).toLocaleString()} PHP</td>
            <td class="r blue">${fmtCurrency(stats.reportPayUsd)}</td>
            <td class="r">${speedDetails || reportPayDetails}</td>
          </tr>
          <tr>
            <td><div class="cat-label"><i class="fas fa-bolt" style="color:#f4b400;"></i> Rush Bonus</div></td>
            <td class="r">${Math.round(stats.totalRushBonusPhp).toLocaleString()} PHP</td>
            <td class="r orange">${fmtCurrency(stats.rushBonusUsd)}</td>
            <td class="r">25% on eligible first-pass rush projects</td>
          </tr>
          <tr>
            <td><div class="cat-label"><i class="fas fa-drafting-compass" style="color:#1a73e8;"></i> Technician Base Pay</div></td>
            <td class="r">${Math.round(stats.techShiftUsd / PHP_TO_USD).toLocaleString()} PHP</td>
            <td class="r blue">${fmtCurrency(stats.techShiftUsd)}</td>
            <td class="r">${stats.techShiftDays} eligible days; ${TECH_BASE_MIN_POINTS_PER_DAY}+ pts/day required</td>
          </tr>
          <tr>
            <td><div class="cat-label"><i class="fas fa-clipboard-check" style="color:#e37400;"></i> QA Shifts (${QA_SHIFT_PHP.toLocaleString()} PHP/day)</div></td>
            <td class="r">${(stats.qaShiftDays * QA_SHIFT_PHP).toLocaleString()} PHP</td>
            <td class="r orange">${fmtCurrency(stats.qaShiftUsd)}</td>
            <td class="r">${stats.qaShiftDays} shift-days</td>
          </tr>
          <tr>
            <td><div class="cat-label"><i class="fas fa-user-shield" style="color:#d93025;"></i> Manager Shifts (${MGR_SHIFT_PHP.toLocaleString()} PHP/day)</div></td>
            <td class="r">${(stats.mgrShiftDays * MGR_SHIFT_PHP).toLocaleString()} PHP</td>
            <td class="r red">${fmtCurrency(stats.mgrShiftUsd)}</td>
            <td class="r">${stats.mgrShiftDays} shift-days</td>
          </tr>
          <tr class="totals"><td><b>Total Payouts</b></td><td class="r">${Math.round(stats.totalReportPayPhp + stats.totalRushBonusPhp + stats.totalShiftCostPhp).toLocaleString()} PHP</td><td class="r orange"><b>${fmtCurrency(stats.totalPayoutUsd)}</b></td><td></td></tr>
          <tr class="totals"><td><b>Gross Revenue</b></td><td class="r"></td><td class="r green"><b>${fmtCurrency(stats.actualRevenue)}</b></td><td class="r">actual cash collected</td></tr>
          <tr class="totals"><td><b>Report Credit Usage</b></td><td class="r"></td><td class="r green"><b>${fmtCurrency(stats.totalRevenue)}</b></td><td class="r">completed report value, including known add-ons</td></tr>
          <tr class="totals"><td><b>Net Credit Income</b></td><td class="r"></td><td class="r ${stats.netCreditIncome>=0?'blue':'red'}"><b>${fmtCurrency(stats.netCreditIncome)}</b></td><td class="r">${stats.totalRevenue>0?((stats.netCreditIncome/stats.totalRevenue)*100).toFixed(0):0}% credit margin</td></tr>
          <tr class="totals"><td><b>Net Profit</b></td><td class="r"></td><td class="r ${stats.netProfit>=0?'blue':'red'}"><b>${fmtCurrency(stats.netProfit)}</b></td><td class="r">${stats.actualRevenue>0?((stats.netProfit/stats.actualRevenue)*100).toFixed(0):0}% profit margin</td></tr>
        </tbody>
      </table>
      ${allShiftSchedules.length===0?`<div style="font-size:11px;color:#999;font-style:italic;margin-top:-10px;margin-bottom:15px;"><i class="fas fa-info-circle"></i> Shift schedule data unavailable - technician base pay is estimated from ${TECH_BASE_MIN_POINTS_PER_DAY}+ point completion days.</div>`:''}
    `;
  }

  // =========================================================================
  //  COMPLEXITY DISTRIBUTION
  // =========================================================================
  function renderComplexityDist(dist, total) {
    if (total === 0) return '<div class="stats-empty"><p>No data for this period</p></div>';
    return `<div class="complexity-grid">${dist.map(cd => `
      <div class="complexity-card" style="border-top:4px solid ${cd.color};">
        <div class="c-count">${cd.count}</div>
        <div class="c-pct">${cd.pct.toFixed(1)}%</div>
        <div class="c-label" style="color:${cd.color};">${cd.label}</div>
        <div class="c-rate">${cd.points} pts/project</div>
      </div>`).join('')}</div>`;
  }

  // =========================================================================
  //  STAGE TIMES
  // =========================================================================
  function renderStageTimes(avgTimes) {
    const stages = [
      { key:'queue', label:'Queue Wait',       icon:'fa-hourglass-half',  color:'#e37400', sub:'Requested → Assigned' },
      { key:'work',  label:'Drawing Time',     icon:'fa-pencil-ruler',    color:'#1a73e8', sub:'Assigned → Drawn'      },
      { key:'qa',    label:'QA Review',        icon:'fa-clipboard-check', color:'#d93025', sub:'Drawn → Completed'     },
      { key:'total', label:'Total Turnaround', icon:'fa-flag-checkered',  color:'#137333', sub:'Requested → Completed' },
    ];
    return `<div class="stage-timing-grid">${stages.map(s => {
      const data = avgTimes[s.key];
      const hasData = data && data.count > 0;
      return `<div class="stage-card">
        <div style="margin-bottom:8px;"><i class="fas ${s.icon}" style="color:${s.color};font-size:16px;"></i></div>
        <div class="s-val" style="color:${s.color};">${hasData?fmtDuration(data.avg):'—'}</div>
        <div class="s-lbl">${s.label}</div>
        <div class="s-sub">${hasData?`${data.count} samples · ${s.sub}`:'No data'}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function renderTurnaroundClusterGraph(title, subtitle, values, profile, accent) {
    const samples = (values || []).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!samples.length) {
      return `
        <div class="turnaround-graph-card">
          <div class="turnaround-graph-head">
            <h5>${title}</h5>
            <div class="turnaround-graph-subtitle">${subtitle}</div>
          </div>
          <div class="turnaround-graph-empty">No samples in this period.</div>
        </div>
      `;
    }

    const maxValue = Math.max(samples[samples.length - 1], 1);
    const focusLimit = Math.max(
      1,
      Math.min(
        maxValue,
        Math.max(
          getPercentile(samples, 0.95),
          profile?.outlierThreshold || 0,
          profile?.p75 || 0
        )
      )
    );
    const focusAxis = getNiceDurationAxis(focusLimit);
    const focusMax = focusAxis.max;
    const mainSamples = samples.filter(v => v <= focusMax);
    const tailSamples = samples.filter(v => v > focusMax);
    const hasTail = tailSamples.length > 0;

    const W = 640;
    const H = 220;
    const PL = 40;
    const PR = 18;
    const PT = 24;
    const PB = 40;
    const plotW = W - PL - PR;
    const plotH = H - PT - PB;
    const yBase = H - PB;
    const tailZoneW = hasTail ? 58 : 0;
    const tailGap = hasTail ? 18 : 0;
    const mainPlotW = plotW - tailZoneW - tailGap;
    const binCount = Math.max(10, Math.min(22, Math.round(Math.sqrt(mainSamples.length || 1) * 2.2)));
    const bins = Array.from({ length: binCount }, () => ({ count:0, min:null, max:null }));

    mainSamples.forEach(value => {
      const ratio = focusMax > 0 ? Math.max(0, Math.min(0.999999, value / focusMax)) : 0;
      const idx = Math.min(binCount - 1, Math.floor(ratio * binCount));
      const bucket = bins[idx];
      bucket.count++;
      bucket.min = bucket.min === null ? value : Math.min(bucket.min, value);
      bucket.max = bucket.max === null ? value : Math.max(bucket.max, value);
    });

    const maxCount = Math.max(...bins.map(bucket => bucket.count), tailSamples.length, 1);
    const barGap = 3;
    const barW = (mainPlotW - ((binCount - 1) * barGap)) / binCount;
    const xForMain = value => PL + ((Math.max(0, Math.min(focusMax, value)) / focusMax) * mainPlotW);
    const yForCount = count => yBase - ((count / maxCount) * plotH);

    const yGrid = Array.from({ length: 4 }, (_, i) => {
      const value = Math.round((maxCount * (i + 1)) / 4);
      const y = yForCount(value);
      return `
        <line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>
        <text x="${PL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#7a8087" font-family="sans-serif">${value}</text>
      `;
    }).join('');

    const tickCount = Math.max(1, Math.round(focusMax / focusAxis.step));
    const xGrid = Array.from({ length: tickCount + 1 }, (_, i) => {
      const value = i * focusAxis.step;
      const x = PL + ((value / focusMax) * mainPlotW);
      return `
        <line x1="${x.toFixed(1)}" y1="${PT}" x2="${x.toFixed(1)}" y2="${yBase}" stroke="#f3f5f7" stroke-width="1"/>
        <text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="${i === tickCount && !hasTail ? 'end' : i === 0 ? 'start' : 'middle'}" font-size="10" fill="#7a8087" font-family="sans-serif">${fmtDurationAxisLabel(value)}</text>
      `;
    }).join('');

    const bars = bins.map((bucket, idx) => {
      const x = PL + (idx * (barW + barGap));
      const h = bucket.count > 0 ? ((bucket.count / maxCount) * plotH) : 1.5;
      const y = yBase - h;
      const tip = bucket.count > 0
        ? `${bucket.count} reports${bucket.min !== null ? ` between ${fmtDuration(bucket.min)} and ${fmtDuration(bucket.max)}` : ''}`
        : '0 reports';
      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${accent}" fill-opacity="${bucket.count > 0 ? 0.82 : 0.14}">
          <title>${tip}</title>
        </rect>
      `;
    }).join('');

    const clusterBand = profile && profile.count > 0
      ? `<rect x="${xForMain(profile.p25).toFixed(1)}" y="${PT}" width="${Math.max(2, xForMain(profile.p75) - xForMain(profile.p25)).toFixed(1)}" height="${plotH}" fill="${accent}" fill-opacity="0.10" rx="8"/>`
      : '';

    const markers = [
      { label:'Median', value: profile?.median || 0, color:'#1a73e8' },
      { label:'90th', value: Math.min(profile?.p90 || 0, focusMax), color:'#e37400' },
    ].map(marker => {
      if (!(marker.value > 0)) return '';
      const x = xForMain(marker.value);
      return `
        <line x1="${x.toFixed(1)}" y1="${PT}" x2="${x.toFixed(1)}" y2="${yBase}" stroke="${marker.color}" stroke-width="1.4" stroke-dasharray="4 3"/>
        <text x="${x.toFixed(1)}" y="14" text-anchor="middle" font-size="10" fill="${marker.color}" font-family="sans-serif">${marker.label}</text>
      `;
    }).join('');

    const tailX = PL + mainPlotW + tailGap;
    const tailBar = hasTail ? `
      <line x1="${(tailX - 9).toFixed(1)}" y1="${PT}" x2="${(tailX - 9).toFixed(1)}" y2="${yBase}" stroke="#d7dde3" stroke-width="1" stroke-dasharray="3 4"/>
      <rect x="${tailX.toFixed(1)}" y="${yForCount(tailSamples.length).toFixed(1)}" width="${tailZoneW.toFixed(1)}" height="${(yBase - yForCount(tailSamples.length)).toFixed(1)}" rx="4" fill="#c5221f" fill-opacity="0.78">
        <title>${tailSamples.length} reports slower than ${fmtDuration(focusMax)}. Longest was ${fmtDuration(maxValue)}.</title>
      </rect>
      <text x="${(tailX + (tailZoneW / 2)).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#7a8087" font-family="sans-serif">Tail</text>
      <text x="${(tailX + (tailZoneW / 2)).toFixed(1)}" y="${Math.max(PT + 12, yForCount(tailSamples.length) - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#c5221f" font-family="sans-serif">${tailSamples.length}</text>
    ` : '';

    const tailLabel = hasTail
      ? `${tailSamples.length} beyond ${fmtDurationAxisLabel(focusMax)}`
      : `All samples within ${fmtDurationAxisLabel(focusMax)}`;

    return `
      <div class="turnaround-graph-card">
        <div class="turnaround-graph-head">
          <h5>${title}</h5>
          <div class="turnaround-graph-subtitle">${subtitle}</div>
        </div>
        <div class="turnaround-graph-meta">
          <span><b>${fmtMetricNumber(profile.count, 0)}</b> samples</span>
          <span><b>${fmtDuration(profile.median)}</b> median</span>
          <span><b>${fmtDuration(profile.p25)} - ${fmtDuration(profile.p75)}</b> middle 50%</span>
          <span><b>${fmtDurationAxisLabel(focusMax)}</b> zoom range</span>
          <span><b>${fmtDuration(profile.max)}</b> longest</span>
          <span><b>${fmtMetricNumber(profile.missedShiftCount || 0, 0)}</b> missed shift${profile.count > 0 ? ` (${fmtPercent(profile.missedShiftPct || 0, 1)})` : ''}</span>
          <span>${tailLabel}</span>
        </div>
        <div class="turnaround-graph-frame">
          <svg viewBox="0 0 ${W} ${H}" width="100%" class="turnaround-graph-svg" aria-label="${Portal.escapeHtml(title)} distribution">
            <line x1="${PL}" y1="${yBase}" x2="${W - PR}" y2="${yBase}" stroke="#cfd6dd" stroke-width="1.2"/>
            ${yGrid}
            ${xGrid}
            ${clusterBand}
            ${markers}
            ${bars}
            ${tailBar}
          </svg>
        </div>
      </div>
    `;
  }

  function renderDailyVipCompletionComparison(rows) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const rowsWithSamples = safeRows.filter(row => (row.vipCount || 0) > 0 || (row.defaultCount || 0) > 0);
    if (!rowsWithSamples.length) {
      return '<div class="stats-empty"><p>No VIP or default completion samples in this period.</p></div>';
    }

    const diffHtml = row => {
      if (!(row.vipAvg > 0) || !(row.defaultAvg > 0)) {
        return '<span class="comparison-diff">Need both</span>';
      }
      const faster = row.deltaMs > 0;
      const slower = row.deltaMs < 0;
      const cls = faster ? 'faster' : slower ? 'slower' : '';
      const direction = faster ? 'VIP faster' : slower ? 'VIP slower' : 'Same';
      const pct = row.pctFaster === null ? '' : ` (${fmtPercent(Math.abs(row.pctFaster), 1)})`;
      return `<span class="comparison-diff ${cls}">${direction}${row.deltaMs !== 0 ? ` by ${fmtDuration(Math.abs(row.deltaMs))}${pct}` : ''}</span>`;
    };

    return `
      <div class="overview-panel" style="margin-top:14px;">
        <h4>Daily VIP vs Default Completion Time</h4>
        <div class="panel-subtitle">Average completed turnaround by completion date. Default excludes VIP, filler, and test projects.</div>
        <div class="stats-table-wrap">
          <table class="stage-type-table daily-vip-table">
            <thead>
              <tr>
                <th>Day</th>
                <th style="text-align:right;">VIP Average</th>
                <th style="text-align:right;">Default Average</th>
                <th style="text-align:right;">Difference</th>
              </tr>
            </thead>
            <tbody>
              ${rowsWithSamples.map(row => `
                <tr>
                  <td class="day-cell">${Portal.escapeHtml(row.label)}</td>
                  <td class="comparison-cell">
                    <div class="comparison-main vip">${row.vipCount > 0 ? fmtDuration(row.vipAvg) : '&mdash;'}</div>
                    <div class="comparison-sub">${row.vipCount > 0 ? `${row.vipCount} sample${row.vipCount === 1 ? '' : 's'}` : 'No VIP samples'}</div>
                  </td>
                  <td class="comparison-cell">
                    <div class="comparison-main default">${row.defaultCount > 0 ? fmtDuration(row.defaultAvg) : '&mdash;'}</div>
                    <div class="comparison-sub">${row.defaultCount > 0 ? `${row.defaultCount} sample${row.defaultCount === 1 ? '' : 's'}` : 'No default samples'}</div>
                  </td>
                  <td class="comparison-cell">${diffHtml(row)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderStageTimesByProjectType(stats) {
    const avgTimesByProjectType = stats.avgStageTimesByProjectType || {};
    const stages = [
      { key:'queue', label:'Queue Wait',       sub:'Requested -> Assigned' },
      { key:'work',  label:'Drawing Time',     sub:'Assigned -> Drawn' },
      { key:'qa',    label:'QA Review',        sub:'Drawn -> Completed' },
      { key:'total', label:'Total Turnaround', sub:'Requested -> Completed' },
    ];
    const projectTypes = [
      { key:'vip',    label:'VIP Project',      color:'#f9ab00' },
      { key:'real',   label:'Non-VIP Project',  color:'#137333' },
      { key:'test',   label:'Test Project',     color:'#8430ce' },
      { key:'filler', label:'Filler Project',   color:'#e37400' },
    ];

    return `
      <div class="overview-panel" style="padding:0;border:none;box-shadow:none;background:transparent;">
        <div class="panel-subtitle" style="margin:0 0 10px 0;">Non-VIP projects exclude VIP projects in this table.</div>
        <div class="stats-table-wrap">
          <table class="stage-type-table">
            <thead>
              <tr>
                <th>Project Type</th>
                ${stages.map(stage => `
                  <th class="${stage.key === 'total' ? 'total-col' : ''}">
                    ${stage.label}
                    <span class="stage-head-sub">${stage.sub}</span>
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${projectTypes.map(type => `
                <tr>
                  <td class="type-cell">
                    <div class="stage-type-label">
                      <span class="stage-type-dot" style="background:${type.color};"></span>
                      ${type.label}
                    </div>
                  </td>
                  ${stages.map(stage => {
                    const data = avgTimesByProjectType[type.key]?.[stage.key];
                    const hasData = data && data.count > 0;
                    return `
                      <td class="stage-cell ${stage.key === 'total' ? 'total-col' : ''}">
                        <div class="stage-main">${hasData ? fmtDuration(data.avg) : '&mdash;'}</div>
                        <div class="stage-sub">${hasData ? `${data.count} samples` : 'No data'}</div>
                      </td>
                    `;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${renderDailyVipCompletionComparison(stats.dailyVipCompletionComparison)}
        <div class="turnaround-graph-note">
          Completed and rejected turnaround profiles count Pacific work-window time only: 5:00 AM-10:00 PM. Requests before 5:00 AM start at 5:00 AM, and requests after 8:00 PM start the next 5:00 AM unless they finish before 10:00 PM the same day. Missed shift means the finish happened after the 10:00 PM deadline for that effective start day.
        </div>
        <div class="timing-profile-grid">
          ${renderTurnaroundClusterGraph(
            'Completed Turnaround',
            'Effective request start -> completed, counted in Pacific work hours.',
            stats.completedTurnaroundValues,
            stats.completedTurnaroundProfile,
            '#137333'
          )}
          ${renderTurnaroundClusterGraph(
            'Rejection Turnaround',
            'Effective request start -> rejected, counted in Pacific work hours.',
            stats.rejectionTurnaroundValues,
            stats.rejectedTurnaroundProfile,
            '#c5221f'
          )}
        </div>
      </div>
    `;
  }

  // =========================================================================
  //  ORGANIZATION TABLE
  // =========================================================================
  function renderOrgTable(orgBreakdown) {
    if (!orgBreakdown || orgBreakdown.length === 0)
      return '<div class="stats-empty"><i class="fas fa-building"></i><p>No organization data</p></div>';
    const sortableKeys = new Set(['name', 'total', 'real', 'filler', 'test', 'residential', 'commercial', 'multifamily', 'value']);
    const sortKey = sortableKeys.has(orgSortState.key) ? orgSortState.key : 'total';
    const sortDir = orgSortState.dir === 'asc' ? 'asc' : 'desc';
    const sorted = orgBreakdown.slice().sort((a, b) => {
      if (sortKey === 'name') return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
      return Number(a[sortKey] || 0) - Number(b[sortKey] || 0);
    });
    if (sortDir === 'desc') sorted.reverse();
    const sortIcon = key => sortKey === key ? (sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down') : 'fa-sort';
    const head = (key, label, right = false) => `
      <th style="${right ? 'text-align:right;' : ''}">
        <button type="button" class="org-sort-btn" data-org-sort="${key}" style="${right ? 'margin-left:auto;' : ''}">
          <span>${label}</span><i class="fas ${sortIcon(key)}"></i>
        </button>
      </th>`;
    const rows = sorted.map(org => `
      <tr>
        <td><div class="org-name"><span class="org-dot"></span>${Portal.escapeHtml(org.name.substring(0,28))}${org.name.length>28?'…':''}</div></td>
        <td class="num">${org.total}</td>
        <td class="num green">${org.real}</td>
        <td class="num orange">${org.filler}</td>
        <td class="num purple">${org.test}</td>
        <td class="num blue">${org.residential||0}</td>
        <td class="num orange">${org.commercial||0}</td>
        <td class="num purple">${org.multifamily||0}</td>
        <td class="num green">${fmtCurrency(org.value)}</td>
      </tr>`).join('');
    return `
      <table class="org-table">
        <thead><tr>
          ${head('name', 'Organization')}
          ${head('total', 'Total', true)}
          ${head('real', 'Real', true)}
          ${head('filler', 'Filler', true)}
          ${head('test', 'Test', true)}
          ${head('residential', '<i class="fas fa-home"></i> Res.', true)}
          ${head('commercial', '<i class="fas fa-building"></i> Com.', true)}
          ${head('multifamily', '<i class="fas fa-city"></i> MFH', true)}
          ${head('value', 'Revenue', true)}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // =========================================================================
  //  TECHNICIAN PERFORMANCE GRID
  // =========================================================================
  function renderTechGrid(techBreakdown, range) {
    if (!techBreakdown || techBreakdown.length === 0)
      return '<div class="stats-empty"><i class="fas fa-users"></i><p>No technician data</p></div>';

    const cards = techBreakdown.map(tech => {
      const trendDays = [];
      const endDate = new Date(range.end);
      for (let i = 6; i >= 0; i--) {
        const d = new Date(endDate);
        d.setDate(d.getDate() - i - 1);
        trendDays.push(tech.dailyTrend[getLocalDateKey(d)] || 0);
      }
      const maxTrend = Math.max(...trendDays, 1);
      const trendBars = trendDays.map(v =>
        `<div class="tech-trend-bar" style="height:${(v/maxTrend)*100}%;"></div>`
      ).join('');
      const realCompleted = tech.completed - tech.completedFiller - tech.completedTest;
      const compSummary = Object.entries(COMPLEXITY_TIERS)
        .filter(([r]) => (tech.complexityCounts[r] || 0) > 0)
        .map(([r,t]) => `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:10px;font-weight:800;"><span style="width:8px;height:8px;border-radius:50%;background:${t.color};display:inline-block;"></span>${tech.complexityCounts[r]}</span>`)
        .join('');
      return `
        <div class="tech-card">
          <div class="tech-card-header">
            <h4>${Portal.escapeHtml(tech.name)}</h4>
            <div class="email">${Portal.escapeHtml(tech.email)}</div>
          </div>
          <div class="tech-card-body">
            <div class="tech-stats-grid">
              <div class="tech-stat"><div class="val">${tech.completed}</div><div class="lbl">Total</div></div>
              <div class="tech-stat"><div class="val green">${realCompleted}</div><div class="lbl">Real</div></div>
              <div class="tech-stat"><div class="val orange">${tech.completedFiller}</div><div class="lbl">Filler</div></div>
            </div>
            <div class="qa-stats-row">
              <div class="qa-stat-box"><div class="val success">${fmtMetricNumber(tech.points || 0, 0)}</div><div class="lbl">Points</div></div>
              <div class="qa-stat-box"><div class="val">${tech.shiftDays}</div><div class="lbl">Base Days</div></div>
              <div class="qa-stat-box"><div class="val" style="color:#1a73e8;">${(tech.rank || 'junior').replace(/^./, c => c.toUpperCase())}</div><div class="lbl">Rank</div></div>
              ${tech.completedTest > 0 ? `<div class="qa-stat-box"><div class="val" style="color:#8430ce;">${tech.completedTest}</div><div class="lbl">Test</div></div>` : ''}
            </div>
            <div style="margin:8px 0 4px;font-size:10px;font-weight:700;color:#666;text-transform:uppercase;">Complexity</div>
            <div style="margin-bottom:8px;">${compSummary||'<span style="font-size:10px;color:#ccc;">None</span>'}</div>
            <div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;margin-bottom:4px;">7-Day Trend</div>
            <div class="tech-trend-chart">${trendBars}</div>
            <div class="tech-payout">
              <div>
                <div class="label">Total Payout</div>
                <div style="font-size:9px;color:#388e3c;font-weight:700;margin-top:2px;">
                  Points: ${Math.round(tech.reportPayPhp).toLocaleString()} + Rush: ${Math.round(tech.rushBonusPhp).toLocaleString()} + Base: ${Math.round(tech.shiftPayPhp).toLocaleString()} PHP
                </div>
                <div style="font-size:9px;color:#1a73e8;font-weight:700;margin-top:2px;">Base pay requires ${TECH_BASE_MIN_POINTS_PER_DAY}+ points/day.</div>
              </div>
              <div class="amount">${fmtCurrency(tech.totalPayUsd)}</div>
            </div>
          </div>
        </div>`;
    }).join('');

    return `<div class="tech-grid">${cards}</div>`;
  }

  // =========================================================================
  //  EXPORT
  // =========================================================================
  async function exportStats() {
    const range   = getDateRange(currentDate, currentPeriod);
    const prevRange = getPreviousStatsRange(range);
    const exportSeq = ++statsRenderSeq;
    await fetchStatsCreditRevenue(range, prevRange, exportSeq);
    if (exportSeq !== statsRenderSeq) return;
    const stats   = calculateStats(allProjects, range);
    const buckets = buildMultiSeriesBuckets(allProjects, range);
    const timeOfDayBuckets = buildTimeOfDayBuckets(allProjects, range);

    let csv = 'Statistics Export - ' + range.label + '\n\n';
    csv += 'SUMMARY\n';
    csv += 'Metric,Value\n';
    csv += `Total Reports Completed,${stats.totalCompleted}\n`;
    csv += `Real Reports,${stats.realCompleted}\n`;
    csv += `Filler Reports,${stats.fillerCompleted}\n`;
    csv += `Test Reports,${stats.testCompleted}\n`;
    csv += `Rejected Reports,${stats.totalRejected}\n`;
    csv += `Rejected Reports Per Day,${stats.rejectedPerDay.toFixed(currentPeriod === 'daily' ? 0 : 1)}\n`;
    csv += `Gross Revenue,$${stats.actualRevenue.toFixed(2)}\n`;
    csv += `Report Credit Usage,$${stats.totalRevenue.toFixed(2)}\n`;
    csv += `Total Payouts,$${stats.totalPayoutUsd.toFixed(2)}\n`;
    csv += `Net Credit Income,$${stats.netCreditIncome.toFixed(2)}\n`;
    csv += `Net Profit,$${stats.netProfit.toFixed(2)}\n`;
    csv += `${stats.companyMetrics.weeklyActiveCompanies.label},${stats.companyMetrics.weeklyActiveCompanies.displayValue}\n`;
    csv += `${stats.companyMetrics.companiesOrdered.label},${stats.companyMetrics.companiesOrdered.displayValue}\n`;
    csv += `${stats.companyMetrics.companySignups.label},${stats.companyMetrics.companySignups.displayValue}\n`;
    csv += `${stats.companyMetrics.activeCompanySignups.label},${stats.companyMetrics.activeCompanySignups.displayValue}\n\n`;

    const addons = stats.addonStats || {};
    csv += 'ADD-ONS\n';
    csv += 'Add-on,Orders,Order Percent,Extra Revenue,Details\n';
    [
      ['Included Gutters', addons.gutterOrders || 0, addons.gutterRevenue || 0, 'Known fallback: $3 per gutter order when no explicit amount is stored'],
      ['Under 1 Hour Expedite', addons.expediteLevel1Orders || 0, addons.expediteLevel1Revenue || 0, 'Uses explicit stored expedite amounts when available'],
      ['1-3 Hour Expedite', addons.expediteLevel2Orders || 0, addons.expediteLevel2Revenue || 0, 'Uses explicit stored expedite amounts when available'],
      ['Storm Weather Reports', addons.stormWeatherOrders || 0, addons.stormWeatherRevenue || 0, 'Uses explicit stored weather/storm report amounts when available'],
    ].forEach(([label, count, revenue, detail]) => {
      const pct = (addons.orders || 0) > 0 ? (Number(count || 0) / addons.orders) * 100 : 0;
      csv += `${label},${count},${pct.toFixed(1)}%,$${Number(revenue || 0).toFixed(2)},${detail}\n`;
    });
    const addonPct = stats.totalRevenue > 0 ? ((addons.addonRevenue || 0) / stats.totalRevenue) * 100 : 0;
    csv += `Base Report Revenue,${addons.orders || 0},,$${Number(addons.baseRevenue || 0).toFixed(2)},Base list-price portion of completed real reports\n`;
    csv += `Total Add-on Revenue,${addons.orders || 0},${addonPct.toFixed(1)}%,$${Number(addons.addonRevenue || 0).toFixed(2)},All extra revenue above base report revenue\n`;
    csv += `Unattributed Add-on Revenue,${addons.orders || 0},,$${Number(addons.unattributedAddonRevenue || 0).toFixed(2)},Extra charge not matched to a known add-on amount field\n\n`;

    csv += 'REVENUE BY SERVICE TYPE\n';
    csv += 'Type,Count,Revenue,Percent of Revenue\n';
    ALL_SERVICE_TYPES.forEach(svc => {
      const revenue = stats.revByType[svc] || 0;
      const pct = stats.totalRevenue > 0 ? (revenue / stats.totalRevenue) * 100 : 0;
      csv += `${SERVICE_LABELS[svc]},${stats.countByType[svc]||0},$${revenue.toFixed(2)},${pct.toFixed(1)}%\n`;
    });
    csv += '\n';

    csv += 'REJECTION BREAKDOWN BY SERVICE TYPE\n';
    csv += 'Type,Requested,Rejected From Requested Cohort,Reject Rate,Rejected This Period,Percent of Rejected This Period\n';
    ALL_SERVICE_TYPES.forEach(svc => {
      const row = stats.rejectionByServiceType?.[svc] || {};
      csv += `${SERVICE_LABELS[svc]},${row.requested||0},${row.rejectedFromRequests||0},${(row.rejectionRate||0).toFixed(1)}%,${row.rejectedInPeriod||0},${(row.shareOfRejected||0).toFixed(1)}%\n`;
    });
    csv += '\n';

    csv += 'COST BREAKDOWN\n';
    csv += 'Category,PHP,USD,Details\n';
    csv += `Technician Point Pay,${Math.round(stats.totalReportPayPhp)},${stats.reportPayUsd.toFixed(2)},${fmtMetricNumber(stats.totalTechnicianPoints || 0, 0)} points across ${stats.realCompleted} real reports\n`;
    csv += `Rush Bonus,${Math.round(stats.totalRushBonusPhp)},${stats.rushBonusUsd.toFixed(2)},Eligible first-pass rush projects\n`;
    csv += `Technician Base Pay,${Math.round(stats.techShiftUsd / PHP_TO_USD)},${stats.techShiftUsd.toFixed(2)},${stats.techShiftDays} eligible days at ${TECH_BASE_MIN_POINTS_PER_DAY}+ points/day\n`;
    csv += `QA Shifts,${stats.qaShiftDays*QA_SHIFT_PHP},${stats.qaShiftUsd.toFixed(2)},${stats.qaShiftDays} days\n`;
    csv += `Manager Shifts,${stats.mgrShiftDays*MGR_SHIFT_PHP},${stats.mgrShiftUsd.toFixed(2)},${stats.mgrShiftDays} days\n\n`;

    csv += 'COMPLEXITY DISTRIBUTION\n';
    csv += 'Level,Label,Count,Percentage,Points\n';
    stats.complexityDist.forEach(cd => {
      csv += `${cd.rating},"${cd.label}",${cd.count},${cd.pct.toFixed(1)}%,${cd.points}\n`;
    });
    csv += '\n';

    csv += 'AVERAGE STAGE TIMES BY PROJECT TYPE\n';
    csv += 'Project Type,Queue Wait,Queue Samples,Drawing Time,Drawing Samples,QA Review,QA Samples,Total Turnaround,Total Samples\n';
    [
      ['vip', 'VIP Project'],
      ['real', 'Non-VIP Project'],
      ['test', 'Test Project'],
      ['filler', 'Filler Project'],
    ].forEach(([key, label]) => {
      const row = stats.avgStageTimesByProjectType[key] || {};
      csv += `${label},${fmtDuration(row.queue?.avg)},${row.queue?.count||0},${fmtDuration(row.work?.avg)},${row.work?.count||0},${fmtDuration(row.qa?.avg)},${row.qa?.count||0},${fmtDuration(row.total?.avg)},${row.total?.count||0}\n`;
    });
    csv += '\n';

    csv += 'DAILY VIP VS DEFAULT COMPLETION TIME\n';
    csv += 'Day,VIP Average,VIP Samples,Default Average,Default Samples,VIP Faster By,VIP Faster Percent\n';
    (stats.dailyVipCompletionComparison || [])
      .filter(row => (row.vipCount || 0) > 0 || (row.defaultCount || 0) > 0)
      .forEach(row => {
        const hasBoth = row.vipAvg > 0 && row.defaultAvg > 0;
        const signedDelta = hasBoth
          ? (row.deltaMs === 0 ? '0m' : `${row.deltaMs > 0 ? '' : '-'}${fmtDuration(Math.abs(row.deltaMs))}`)
          : '';
        csv += `${row.label},${fmtDuration(row.vipAvg)},${row.vipCount||0},${fmtDuration(row.defaultAvg)},${row.defaultCount||0},${signedDelta},${hasBoth && row.pctFaster !== null ? row.pctFaster.toFixed(1) + '%' : ''}\n`;
      });
    csv += '\n';

    csv += 'TURNAROUND PROFILES\n';
    csv += 'Profile,Samples,Median,Middle 50% Start,Middle 50% End,90th Percentile,Outlier Threshold,Outliers,Longest,Missed Shift,Missed Shift Percent\n';
    [
      ['Completed Turnaround', stats.completedTurnaroundProfile],
      ['Rejection Turnaround', stats.rejectedTurnaroundProfile],
    ].forEach(([label, profile]) => {
      csv += `${label},${profile.count||0},${fmtDuration(profile.median)},${fmtDuration(profile.p25)},${fmtDuration(profile.p75)},${fmtDuration(profile.p90)},${fmtDuration(profile.outlierThreshold)},${profile.outlierCount||0},${fmtDuration(profile.max)},${profile.missedShiftCount||0},${(profile.missedShiftPct||0).toFixed(1)}%\n`;
    });
    csv += '\n';

    csv += 'ORGANIZATION BREAKDOWN\n';
    csv += 'Organization,Total,Real,Filler,Test,Residential,Commercial,Multi-Family,Revenue\n';
    stats.orgBreakdown.forEach(org => {
      csv += `"${org.name}",${org.total},${org.real},${org.filler},${org.test||0},${org.residential||0},${org.commercial||0},${org.multifamily||0},$${org.value.toFixed(2)}\n`;
    });
    csv += '\n';

    csv += 'TECHNICIAN PERFORMANCE\n';
    csv += 'Name,Email,Rank,Completed,Real,Filler,Test,Points,Base Days,Point Pay PHP,Rush Bonus PHP,Base Pay PHP,Total Payout USD\n';
    stats.techBreakdown.forEach(tech => {
      const real = tech.completed - tech.completedFiller - (tech.completedTest||0);
      csv += `"${tech.name}","${tech.email}",${tech.rank || 'junior'},${tech.completed},${real},${tech.completedFiller},${tech.completedTest||0},${fmtMetricNumber(tech.points || 0, 0)},${tech.shiftDays},${Math.round(tech.reportPayPhp)},${Math.round(tech.rushBonusPhp)},${Math.round(tech.shiftPayPhp)},$${tech.totalPayUsd.toFixed(2)}\n`;
    });
    csv += '\n';

    csv += 'PIPELINE FLOW CHART DATA\n';
    csv += `Period,${currentPeriod === 'daily' ? 'Hour' : 'Date'},Event,Real,Filler,Test,Residential,Commercial,Multifamily,Total\n`;
    buckets.forEach(b => {
      EVENT_ORDER.forEach(ev => {
        const row = b[ev];
        const total = (row.real||0) + (row.filler||0) + (row.test||0);
        if (total > 0) {
          csv += `${b.label},${ev},${row.real||0},${row.filler||0},${row.test||0},${row.residential||0},${row.commercial||0},${row.multifamily||0},${total}\n`;
        }
      });
    });
    csv += '\n';

    csv += 'PIPELINE TIME OF DAY DISTRIBUTION\n';
    csv += 'Hour,Event,Real,Filler,Test,Residential,Commercial,Multifamily,Total\n';
    timeOfDayBuckets.forEach(b => {
      EVENT_ORDER.forEach(ev => {
        const row = b[ev];
        const total = (row.real||0) + (row.filler||0) + (row.test||0);
        if (total > 0) {
          csv += `${b.label},${ev},${row.real||0},${row.filler||0},${row.test||0},${row.residential||0},${row.commercial||0},${row.multifamily||0},${total}\n`;
        }
      });
    });

    const blob = new Blob([csv], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `stats_${currentPeriod}_${range.label.replace(/[^a-zA-Z0-9]/g,'_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  //  WIRE UI
  // =========================================================================
  function wireUI() {
    const refreshBtn = document.getElementById('statsRefreshBtn');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        const content = document.getElementById('statsContent');
        if (content) content.innerHTML = '<div class="stats-loading"><i class="fas fa-spinner fa-spin"></i><p>Refreshing...</p></div>';
        await loadStats({ force:true });
      };
    }
    const exportBtn = document.getElementById('statsExportBtn');
    if (exportBtn) exportBtn.onclick = () => exportStats();

    document.querySelectorAll('.period-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentPeriod = tab.dataset.period;
        currentDate   = new Date();
        renderStats();
      };
    });

    const prevBtn = document.getElementById('statsPrevBtn');
    if (prevBtn) prevBtn.onclick = () => navigateDate(-1);
    const nextBtn = document.getElementById('statsNextBtn');
    if (nextBtn) nextBtn.onclick = () => navigateDate(1);
    const todayBtn = document.getElementById('statsTodayBtn');
    if (todayBtn) todayBtn.onclick = () => { currentDate = new Date(); renderStats(); };
  }

  // =========================================================================
  //  MAIN LOAD
  // =========================================================================
  async function loadStats(options = {}) {
    const force = !!options.force;
    const content = document.getElementById('statsContent');
    const hasCache = statsDataLoadedAt > 0 && Array.isArray(allProjects) && allProjects.length > 0;
    const cacheFresh = hasCache && (Date.now() - statsDataLoadedAt) < STATS_DATA_CACHE_MS;

    if (!force && cacheFresh) {
      await renderStats();
      return;
    }

    if (content) content.innerHTML = '<div class="stats-loading"><i class="fas fa-spinner fa-spin"></i><p>Loading statistics...</p></div>';
    const success = await fetchAllData();
    if (success) {
      try {
        await renderStats();
      } catch (e) {
        console.error('Error rendering stats', e);
        if (content) content.innerHTML = `<div class="stats-empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to render statistics: ${Portal.escapeHtml(e?.message || String(e))}</p></div>`;
      }
    }
    else if (content) content.innerHTML = '<div class="stats-empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to load statistics. Please try again.</p></div>';
  }

  // =========================================================================
  //  PUBLIC API
  // =========================================================================
  const Stats = {
    init() {
      if (!canViewStats()) return;
      ensureStyles();
      ensureMarkup();
      Portal.registerPlugin({ id:'stats', title:'Statistics', iconClass:'fas fa-chart-bar' });
      wireUI();
      window.Stats = this;
    },
    async onShow() { await loadStats(); }
  };

  const origSwitch = Portal.switchView ? Portal.switchView.bind(Portal) : null;
  if (origSwitch) {
    Portal.switchView = async function(id, btn) {
      await origSwitch(id, btn);
      if (id === 'stats') await Stats.onShow();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Stats.init());
  } else {
    Stats.init();
  }

  window.Stats = Stats;
})();
