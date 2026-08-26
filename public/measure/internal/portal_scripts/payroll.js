/* portal_scripts/payroll.js
 * Team Payroll plugin (self-contained):
 * - injects nav item via Portal.registerPlugin
 * - injects view markup + CSS
 * - computes technician payroll from FirstMeasure projects/list
 * - matches the Statistics tab technician payout rules
 * - adds payment tracking: mark individual / mark-all as paid
 * - persists payment records in localStorage (portal_payroll_history_v1)
 *
 * Calculation rules:
 * - Point pay uses complexity points multiplied by speed-band rate.
 * - Rush bonus is 25% for eligible first-pass rush projects.
 * - Technician base pay is rank-based and requires 20+ completed points/day.
 *
 * Timezone toggle: PHT (UTC+8) vs PST (UTC-8, fixed, no DST)
 * Pay period: Semi-monthly
 *   1st – 15th  → paid on the 20th of the same month
 *   16th – last → paid on the 5th of the following month
 *
 * Data sources:
 * - list_projects (filter=all)   → all completed projects
 * - queue_live_trained_users     → employee roster
 *
 * NOTE: Payment records are stored in localStorage. To migrate to
 * server-side storage, replace loadHistory/saveHistory/recordPayment/
 * removePayment with server API calls.
 */
(function(){
  if (!window.Portal) return;
  const cfg = () => window.Portal.cfg;

    /* ---- Permission gate ---- */
    const c = cfg();
    const _u = c?.user;
    if (!_u) return;

    // FIX: Read from global 'perms', not user.permissions
    const _prm = c.perms || {}; 
    const _isAdm = (_u.role === 'admin'); 

    // Check for the new manage_payroll permission
    const _canPayroll = _isAdm || !!_prm['*'] || !!_prm.manage_queue || !!_prm.manage_payroll;
    
    if (!_canPayroll) return;

  /* ============================================================
     CONSTANTS  (mirrored from earnings.js)
     ============================================================ */
  const RUSH_BONUS_PERCENT = 25;
  const TECH_BASE_PAY_BY_RANK = { junior: 450, standard: 600, senior: 750 };
  const TECH_BASE_MIN_POINTS_PER_DAY = 20;

  function getShiftRate() {
      return TECH_BASE_PAY_BY_RANK.standard;
  }

  const COMPLEXITY_TIERS = {
    1: { rate: 15,  label: 'Very Simple',   color: '#34a853' },
    2: { rate: 30,  label: 'Simple',        color: '#4ecdc4' },
    3: { rate: 45,  label: 'Standard',      color: '#f4b400' },
    4: { rate: 90,  label: 'Complex',       color: '#e67700' },
    5: { rate: 175, label: 'Very Complex',  color: '#d93025' },
  };
  const STRUCTURE_PAYOUT_TYPES = new Set(['commercial', 'multifamily']);
  const STRUCTURE_PAYOUT_RATE = COMPLEXITY_TIERS[2].rate;

  /**
   * Normalize any complexity value (legacy string or numeric) to integer 1–5.
   * Matches the PHP normalizeComplexity() function and earnings.js for consistency.
   */
  function normalizeComplexity(val) {
    if (typeof val === 'number' && val >= 1 && val <= 5) return Math.round(val);
    if (typeof val === 'string') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) return n;
      const lower = val.trim().toLowerCase();
      if (lower === 'simple') return 1;
      if (lower === 'complex') return 3;
    }
    return 3;
  }

  function tierFor(rating) {
    const r = normalizeComplexity(rating);
    return COMPLEXITY_TIERS[r] || COMPLEXITY_TIERS[3];
  }

  function normalizedProjectType(project) {
    const raw = String(project?.project_type || 'residential').trim().toLowerCase();
    return STRUCTURE_PAYOUT_TYPES.has(raw) ? raw : 'residential';
  }

  function projectStructureCount(project) {
    const direct = Number(project?.pin_count);
    if (Number.isFinite(direct) && direct > 0) return Math.max(1, Math.round(direct));
    if (Array.isArray(project?.pins) && project.pins.length > 0) return project.pins.length;
    return 1;
  }

  function isStructurePaidProject(project) {
    return STRUCTURE_PAYOUT_TYPES.has(normalizedProjectType(project)) && projectStructureCount(project) > 1;
  }

  function rushBonusForProject(project, baseRate) {
    if (!project || !project.rush_bonus_eligible || !project.rush_bonus_tag || !passedQaFirstTime(project)) return 0;
    const percent = Number(project.rush_bonus_percent ?? project.rush_bonus_amount ?? RUSH_BONUS_PERCENT);
    const safePercent = Number.isFinite(percent) && percent > 0 ? percent : RUSH_BONUS_PERCENT;
    return Math.round(Number(baseRate || 0) * (safePercent / 100));
  }

  function technicianRankFromValue(value) {
    const rank = String(value || '').trim().toLowerCase();
    return ['junior', 'standard', 'senior'].includes(rank) ? rank : '';
  }

  function technicianRankForEmployee(emp, fallbackRank = '') {
    return technicianRankFromValue(
      emp?.drafter_rank || emp?.technician_rank || emp?.measurement_technician_rank || fallbackRank
    ) || 'junior';
  }

  function technicianBasePayForRank(rank) {
    return TECH_BASE_PAY_BY_RANK[technicianRankFromValue(rank) || 'junior'] || TECH_BASE_PAY_BY_RANK.junior;
  }

  function projectIsPaidTechnicianProject(project) {
    if (!project || typeof project !== 'object') return false;
    if (project.is_filler || project.is_test_org) return false;
    return true;
  }

  function structureLabel(count) {
    return `${count} structure${count === 1 ? '' : 's'}`;
  }

  /**
   * Did this project pass QA on the first attempt (zero corrections)?
   * Checks multiple data sources for robustness.
   * Identical to earnings.js implementation.
   */
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
    { key:'expired', label:'Very Slow', rate:5,  color:'#7f1d1d' },
  ];
  const SPEED_NO_TIMING_BAND_INDEX = 3;

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
    ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean));
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
      const email = String(ev.worker_email || ev.assigned_to_email || ev.email || '').toLowerCase().trim();
      const name = String(ev.worker_name || ev.assigned_to_name || ev.name || email || '').trim();
      if (email && qaEmails.has(email)) continue;
      if (email || name) return { email, name: name || email, basis: events[i].event };
    }
    const history = Array.isArray(p.technician_history) ? p.technician_history.slice().reverse() : [];
    for (const entry of history) {
      const email = String(entry?.email || '').toLowerCase().trim();
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
      const email = String(candidate.email || '').toLowerCase().trim();
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

  function fmtPoints(n) {
    const x = Number(n || 0);
    return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '--';
    const totalMinutes = Math.round(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
  }

  const TZ = {
    PHT: { key:'PHT', label:'Philippine Time', sub:'UTC+8', offsetHours:+8 },
    PST: { key:'PST', label:'Pacific Time',     sub:'UTC-8', offsetHours:-8 }
  };
  const STATE_KEY   = 'portal_payroll_state_v1';
  const HISTORY_KEY = 'portal_payroll_history_v1';

  /* ============================================================
     STATE MANAGEMENT
     ============================================================ */
  function loadState(){
    try {
      const raw = localStorage.getItem(STATE_KEY);
      const s = raw ? JSON.parse(raw) : {};
      return {
        tz: (s.tz === 'PST' ? 'PST' : 'PHT'),
        anchorMs: (typeof s.anchorMs === 'number' ? s.anchorMs : Date.now())
      };
    } catch(e){
      return { tz:'PHT', anchorMs: Date.now() };
    }
  }
  function saveState(st){
    try { localStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch(e){}
  }

  /* ============================================================
     PAYROLL HISTORY (localStorage)
     ============================================================ */
  function loadHistory(){
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const h = raw ? JSON.parse(raw) : {};
      if (!Array.isArray(h.payments)) h.payments = [];
      return h;
    } catch(e){
      return { payments:[] };
    }
  }
  function saveHistory(h){
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch(e){}
  }
  function findPayment(email, periodStartMs, tzKey){
    const h = loadHistory();
    email = (email||'').toLowerCase().trim();
    return h.payments.find(p =>
      p.employee_email === email &&
      p.period_start_ms === periodStartMs &&
      p.tz_key === tzKey
    ) || null;
  }
  function recordPayment(rec){
    const h = loadHistory();
    const dup = h.payments.find(p =>
      p.employee_email === rec.employee_email &&
      p.period_start_ms === rec.period_start_ms &&
      p.tz_key === rec.tz_key
    );
    if (dup) return false;
    h.payments.push(rec);
    saveHistory(h);
    return true;
  }
  function removePayment(email, periodStartMs, tzKey){
    const h = loadHistory();
    email = (email||'').toLowerCase().trim();
    h.payments = h.payments.filter(p =>
      !(p.employee_email === email &&
        p.period_start_ms === periodStartMs &&
        p.tz_key === tzKey)
    );
    saveHistory(h);
  }
  function genId(){
    return 'pr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
  }

  /* ============================================================
     TIME HELPERS  (identical to earnings.js)
     ============================================================ */
  function parseSqlAsUtcMs(s){
    if (!s || typeof s !== 'string') return 0;
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m){ const t = Date.parse(s); return Number.isFinite(t) ? t : 0; }
    return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  }
  function toLocalViewMs(utcMs, offsetHours){
    return utcMs + offsetHours * 3600000;
  }
  function ymdFromLocalViewMs(ms){
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  function niceDateFromLocalViewMs(ms){
    const d = new Date(ms);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    return `${mo} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  function localMidnightMs(ms){
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  }
  function addDays(ms, n){ return ms + n * 86400000; }

  /**
   * Compute the payout date for a given semi-monthly pay period.
   *   1st–15th  → 20th of the same month
   *   16th–last → 5th of the following month
   */
  function payoutDateForPeriod(periodStartMs){
    const dt = new Date(periodStartMs);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    if (d <= 15) {
      return Date.UTC(y, m, 20, 0, 0, 0);
    } else {
      return Date.UTC(y, m + 1, 5, 0, 0, 0);
    }
  }

  /**
   * Determine the semi-monthly pay period for a given anchor timestamp.
   *   1st–15th  or  16th–last day of the month
   */
  function periodForAnchor(anchorLocalMs){
    const dt = new Date(anchorLocalMs);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    if (d <= 15) {
      const start = Date.UTC(y, m, 1, 0, 0, 0);
      const end   = Date.UTC(y, m, 16, 0, 0, 0);
      return { start, end };
    } else {
      const start = Date.UTC(y, m, 16, 0, 0, 0);
      const end   = Date.UTC(y, m + 1, 1, 0, 0, 0);
      return { start, end };
    }
  }

  function fmtPhp(n){
    const x = Math.round(n || 0);
    return `${x.toLocaleString()} PHP`;
  }
  function weekdayFromYmd(ymd){
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    const d = new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  }

  /* ============================================================
     ESCAPE HELPER
     ============================================================ */
  function esc(s){
    if (Portal.escapeHtml) return Portal.escapeHtml(String(s));
    const el = document.createElement('div');
    el.textContent = String(s);
    return el.innerHTML;
  }
    
    
  /* ============================================================
     SHIFT-ROLE HELPERS (mirrors earnings.js)
     ============================================================ */
  let cachedSchedules   = null;  // Map<email, schedule>
  let cachedSchedulesAt = 0;

  async function fetchAllShiftSchedules(state) {
    try {
      const tz = state.tz === 'PST' ? TZ.PST : TZ.PHT;
      const anchorLocal = toLocalViewMs(state.anchorMs, tz.offsetHours);
      const per = periodForAnchor(anchorLocal);
      const res = await Portal.apiPost(cfg().endpoints.server, {
        action: 'shift_get_schedules',
        week_of: ymdFromLocalViewMs(per.start),
        team: 'all'
      });
      const map = new Map();
      if (res && res.success && Array.isArray(res.schedules)) {
        for (const s of res.schedules) {
          const em = (s.email || '').toLowerCase().trim();
          if (em) {
            map.set(em, {
              recurring: s.recurring || {},
              overrides: s.overrides || {}
            });
          }
        }
      }
      return map;
    } catch (e) {
      console.warn('Failed to fetch shift schedules for payroll', e);
      return new Map();
    }
  }

  function resolveShiftBlocksForDate(schedule, ymd) {
    if (!schedule) return [];
    const overrides = schedule.overrides || {};
    if (overrides.hasOwnProperty(ymd)) {
      const raw = overrides[ymd];
      return Array.isArray(raw) ? raw : [];
    }
    const ts = Date.UTC(+ymd.slice(0,4), +ymd.slice(5,7)-1, +ymd.slice(8,10));
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayName = dayNames[new Date(ts).getUTCDay()];
    const recurring = schedule.recurring || {};
    return Array.isArray(recurring[dayName]) ? recurring[dayName] : [];
  }

  function dayHasTechnicianShift(schedule, ymd) {
    const blocks = resolveShiftBlocksForDate(schedule, ymd);
    return blocks.some(b => (b.role || 'technician') === 'technician');
  }

  function technicianBasePayEligibleDay(schedule, ymd) {
    if (!schedule) return true;
    return dayHasTechnicianShift(schedule, ymd);
  }

  function employeePeriodNonTechRoles(schedule, periodStart, periodEnd) {
    const roles = new Set();
    const days = Math.max(1, Math.round((periodEnd - periodStart) / 86400000));
    for (let i = 0; i < days; i++) {
      const ymd = ymdFromLocalViewMs(addDays(periodStart, i));
      const blocks = resolveShiftBlocksForDate(schedule, ymd);
      for (const b of blocks) {
        const role = (b.role || 'technician').toLowerCase();
        if (role !== 'technician') roles.add(role);
      }
    }
    return roles;
  }

  function allPeriodNonTechRoles(schedulesMap, periodStart, periodEnd) {
    const roles = new Set();
    for (const sched of schedulesMap.values()) {
      for (const r of employeePeriodNonTechRoles(sched, periodStart, periodEnd)) {
        roles.add(r);
      }
    }
    return roles;
  }

  function nonTechPayNote(nonTechRoles) {
    if (!nonTechRoles || nonTechRoles.size === 0) return '';
    const names = [];
    if (nonTechRoles.has('qa'))      names.push('QA');
    if (nonTechRoles.has('manager')) names.push('manager');
    if (nonTechRoles.has('lead'))    names.push('lead');
    if (nonTechRoles.has('other'))   names.push('other');
    if (names.length === 0) return '';
    const rolesStr = names.join(' and ');
    return `<div style="margin-top:10px; background:#fff8e1; border:1px solid #ffe082; border-radius:10px; padding:10px 14px; font-size:12px; font-weight:700; color:#795548; display:flex; align-items:center; gap:8px;">
      <i class="fas fa-info-circle" style="color:#f9a825; font-size:14px;"></i>
      <span>${rolesStr.charAt(0).toUpperCase() + rolesStr.slice(1)} shift compensation is managed outside of this system.</span>
    </div>`;
  }

  /* ============================================================
     DATA FETCHING
     ============================================================ */
  let cachedProjects  = null;
  let cachedEmployees = null;
  let cachedAt        = 0;

  function fmActor(){
    const c = cfg() || {};
    const u = c.user || {};
    const perms = c.perms || {};
    const actor = {};
    if (u.id) actor.id = u.id;
    if (u.email) actor.email = u.email;
    if (u.name) actor.name = u.name;
    if (u.team_id) actor.team_id = u.team_id;
    if (u.organization_id) actor.organization_id = u.organization_id;
    const roles = new Set();
    if (u.role) roles.add(String(u.role).trim().toLowerCase());
    if (perms['*']) roles.add('admin');
    if (perms.manage_queue || perms.manage_payroll) roles.add('manager');
    if (roles.size) actor.roles = Array.from(roles);
    return actor;
  }

  function fmUrl(path){
    const base = String(cfg()?.endpoints?.firstmeasure || '').replace(/\/+$/, '');
    const suffix = String(path || '').replace(/^\/+/, '');
    return `${base}/${suffix}`;
  }

  async function fmPost(path, payload = {}){
    const res = await fetch(fmUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ actor: fmActor(), ...(payload || {}) })
    });
    return await res.json();
  }

  async function fetchAllProjects(){
    const res = await fmPost('projects/list', { filter:'all', limit: 0, include_history: true });
    return Array.isArray(res.projects) ? res.projects : [];
  }
  async function fetchEmployees(){
    try {
      const res = await Portal.apiPost(cfg().endpoints.server, { action:'queue_live_trained_users' });
      return Array.isArray(res.users) ? res.users : [];
    } catch(e){ return []; }
  }

  /* ============================================================
     DAILY PAYROLL EXPORT
     ============================================================ */
  const EXPORT_PROJECT_LIMIT = 500;

  function exportDayBounds(ymd, tzKey){
    const match = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const tz = tzKey === 'PST' ? TZ.PST : TZ.PHT;
    const localMidnightMs = Date.UTC(+match[1], +match[2] - 1, +match[3], 0, 0, 0, 0);
    const startMs = localMidnightMs - (tz.offsetHours * 3600000);
    return { startMs, endMs:startMs + 86400000 };
  }

  function defaultExportYmd(){
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return [
      yesterday.getFullYear(),
      String(yesterday.getMonth() + 1).padStart(2, '0'),
      String(yesterday.getDate()).padStart(2, '0')
    ].join('-');
  }

  function projectTimestamp(project, ...keys){
    const timestamps = project && typeof project.timestamps === 'object' ? project.timestamps : {};
    for (const key of keys) {
      const ms = parseProjectTimestamp(project?.[key] ?? timestamps?.[key]);
      if (ms !== null) return ms;
    }
    return null;
  }

  function isoTimestamp(ms){
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }

  function projectQaReviewer(project){
    const workflow = project && typeof project.workflow === 'object' ? project.workflow : {};
    const direct = [
      project?.qa_approved_by_email, project?.qa_approved_by,
      project?.qa_reviewed_by_email, project?.qa_reviewed_by,
      project?.qa_claimed_by_email, workflow?.qa_claim?.email
    ].map(value => String(value || '').trim()).find(Boolean);
    if (direct) return direct;
    const acceptedEvents = new Set(['qa_approved', 'qa_approved_pending_manager', 'qa_reviewed', 'qa_claimed']);
    const history = rawWorkHistory(project);
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      const event = String(entry.event || entry.type || '').trim().toLowerCase();
      if (!acceptedEvents.has(event)) continue;
      const email = String(entry.qa_email || entry.qa_reviewer_email || entry.by_email || entry.user_email || '').trim();
      if (email) return email;
    }
    return '';
  }

  function projectQaKickbacks(project){
    const direct = Number(project?.qa_reject_count);
    if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
    if (Array.isArray(project?.qa_history)) {
      const rejected = project.qa_history.filter(entry =>
        String(entry?.decision || entry?.event || '').trim().toLowerCase() === 'rejected'
      ).length;
      if (rejected > 0) return rejected;
    }
    return rawWorkHistory(project).filter(entry => {
      const event = String(entry?.event || entry?.type || '').trim().toLowerCase();
      return event === 'qa_rejected' || event === 'qa_sent_back_to_tech';
    }).length;
  }

  function heightQualityPoints(project){
    const storedRaw =
      project?.height_quality_points
      ?? project?.qa_rank?.height_quality_points;
    if (storedRaw !== null && storedRaw !== undefined && storedRaw !== '') {
      const stored = Number(storedRaw);
      if (Number.isFinite(stored)) {
        return Math.round(Math.max(0, Math.min(10, stored)) * 100) / 100;
      }
    }
    const qualityKeys = [
      'solar_imagery_quality', 'height_map_quality', 'heightmap_quality',
      'dsm_quality', 'height_quality', 'height_map_quality_score', 'heightmap_quality_score'
    ];
    let raw = null;
    for (const key of qualityKeys) {
      if (project?.[key] !== null && project?.[key] !== undefined && project?.[key] !== '') {
        raw = project[key];
        break;
      }
    }
    if (raw === null) return 5;
    if (typeof raw === 'number' || /^-?\d+(\.\d+)?$/.test(String(raw))) {
      const value = Number(raw);
      if (!Number.isFinite(value)) return 5;
      let points = 5;
      if (value >= 0 && value <= 1) points = (1 - value) * 10;
      else if (value >= 1 && value <= 5) points = ((value - 1) / 4) * 10;
      else if (value >= 0 && value <= 10) points = value;
      else if (value >= 0 && value <= 100) points = 10 - (value / 10);
      return Math.round(Math.max(0, Math.min(10, points)) * 100) / 100;
    }
    const label = String(raw).trim().toLowerCase();
    if (['excellent', 'best', 'high', 'highest', 'good'].includes(label)) return 0;
    if (['base', 'poor', 'low', 'lowest', 'bad'].includes(label)) return 10;
    return 5;
  }

  function employeeRankMap(employees){
    const ranks = new Map();
    for (const employee of (Array.isArray(employees) ? employees : [])) {
      const email = String(employee?.email || '').trim().toLowerCase();
      if (email) ranks.set(email, technicianRankForEmployee(employee));
    }
    return ranks;
  }

  function projectQaScore(project, ranks){
    const stored = Number(
      project?.qa_error_score
      ?? project?.qa_priority_rank_score
      ?? project?.qa_rank?.error_score
    );
    if (Number.isFinite(stored)) return stored;
    const points = Number(resolveProjectPoints(project) || 0);
    const technician = projectPayTechnician(project);
    const rank = ranks.get(String(technician.email || '').trim().toLowerCase()) || 'junior';
    const rankPoints = rank === 'senior' ? 0 : (rank === 'standard' ? 5 : 10);
    return Math.round((points + rankPoints + heightQualityPoints(project)) * 100) / 100;
  }

  function projectExpeditedLevel(project){
    const key = String(project?.report_expedite_option || '').trim().toLowerCase();
    if (['rush_under_1', 'rush_1_2', 'rush_1_1_5'].includes(key)) return 1;
    if (['rush_1_3', 'rush_2_3'].includes(key)) return 2;
    return project?.is_expedited ? 2 : 3;
  }

  function projectComplexityLevel(project){
    const raw = String(project?.complexity ?? '').trim().toLowerCase();
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) return Math.round(numeric);
    const key = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return {
      very_simple:1, very_simple_project:1,
      simple:2, simple_project:2,
      standard:3, standard_project:3,
      complex:4, complex_project:4,
      very_complex:5, very_complex_project:5
    }[key] || '';
  }

  function tsvCell(value){
    if (value === null || value === undefined) return '';
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
  }

  function buildPayrollExportTsv(projects, employees){
    const ranks = employeeRankMap(employees);
    const headers = [
      'project_id', 'address', 'technician_user', 'qa_user', 'speed_tier',
      'points', 'complexity_level', 'submission_timestamp', 'started_drafting_timestamp',
      'completion_timestamp', 'qa_kickbacks', 'qa_score', 'height_map_quality_points', 'organization_id',
      'expedited_level', 'amount_charged'
    ];
    const rows = projects.map(project => {
      const technician = projectPayTechnician(project);
      const points = resolveProjectPoints(project);
      const elapsedMs = collectionElapsedMs(project);
      const band = speedBandForElapsed(elapsedMs, buildSpeedTimeline(points));
      const submissionMs = projectTimestamp(project, 'queued_at', 'created_at', 'processed_at');
      const startedMs = findClaimStartedAt(project);
      const completedMs = projectTimestamp(project, 'completed_at');
      return [
        project?.id || '', project?.address || '', technician.email || technician.name || '',
        projectQaReviewer(project), band?.label || '', points ?? '',
        projectComplexityLevel(project), isoTimestamp(submissionMs), isoTimestamp(startedMs),
        isoTimestamp(completedMs), projectQaKickbacks(project), projectQaScore(project, ranks),
        heightQualityPoints(project),
        project?.organization_id || project?.organization_ref?.id || '',
        projectExpeditedLevel(project), Number(project?.amount_charged ?? 0)
      ];
    });
    return [headers, ...rows].map(row => row.map(tsvCell).join('\t')).join('\r\n');
  }

  async function fetchExportProjectWindow(startMs, endMs){
    const res = await fmPost('projects/query', {
      statuses:['completed'],
      limit:EXPORT_PROJECT_LIMIT,
      activity_start:new Date(startMs).toISOString(),
      activity_end:new Date(endMs).toISOString(),
      activity_fields:['completed']
    });
    if (!res?.ok) throw new Error(res?.error || res?.message || 'Project export query failed.');
    const total = Number(res.count || 0);
    const projects = Array.isArray(res.projects) ? res.projects : [];

    if (total <= projects.length) return projects;
    if (startMs >= endMs) {
      throw new Error(`More than ${EXPORT_PROJECT_LIMIT} projects share the same completion millisecond. The export endpoint cannot page that timestamp.`);
    }

    const midpoint = Math.floor((startMs + endMs) / 2);
    const [firstHalf, secondHalf] = await Promise.all([
      fetchExportProjectWindow(startMs, midpoint),
      fetchExportProjectWindow(midpoint + 1, endMs)
    ]);
    return firstHalf.concat(secondHalf);
  }

  async function fetchProjectsForExportDay(ymd, tzKey){
    const bounds = exportDayBounds(ymd, tzKey);
    if (!bounds) throw new Error('Choose a valid export date.');
    const fetched = await fetchExportProjectWindow(bounds.startMs, bounds.endMs - 1);
    const unique = new Map();
    for (const project of fetched) {
      const key = String(project?.id || `${projectTimestamp(project, 'completed_at')}:${project?.address || ''}`);
      unique.set(key, project);
    }
    return [...unique.values()].filter(project => {
      const completedMs = projectTimestamp(project, 'completed_at');
      return completedMs !== null && completedMs >= bounds.startMs && completedMs < bounds.endMs;
    }).sort((a, b) =>
      (projectTimestamp(a, 'completed_at') || 0) - (projectTimestamp(b, 'completed_at') || 0)
    );
  }

  function downloadTextFile(contents, filename){
    const blob = new Blob([`\ufeff${contents}`], { type:'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function setExportStatus(message, isError){
    const status = document.getElementById('prExportStatus');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', Boolean(isError));
  }

  function openExportModal(state){
    const modal = document.getElementById('prExportModal');
    const dateInput = document.getElementById('prExportDate');
    const tz = state.tz === 'PST' ? TZ.PST : TZ.PHT;
    if (!modal || !dateInput) return;
    dateInput.value = defaultExportYmd();
    const timezone = document.getElementById('prExportTimezone');
    if (timezone) timezone.textContent = `${tz.label} (${tz.sub})`;
    setExportStatus('', false);
    modal.hidden = false;
    dateInput.focus();
  }

  function closeExportModal(){
    const modal = document.getElementById('prExportModal');
    if (modal) modal.hidden = true;
    setExportStatus('', false);
  }

  async function runPayrollExport(state){
    const dateInput = document.getElementById('prExportDate');
    const submit = document.getElementById('prExportSubmit');
    const ymd = String(dateInput?.value || '');
    if (!exportDayBounds(ymd, state.tz)) {
      setExportStatus('Choose a valid date.', true);
      return;
    }
    if (submit) submit.disabled = true;
    setExportStatus('Loading completed projects…', false);
    try {
      const employeesPromise = cachedEmployees ? Promise.resolve(cachedEmployees) : fetchEmployees();
      const [projects, employees] = await Promise.all([
        fetchProjectsForExportDay(ymd, state.tz),
        employeesPromise
      ]);
      cachedEmployees = employees;
      const tsv = buildPayrollExportTsv(projects, employees);
      downloadTextFile(tsv, `firstmeasure-payroll-${ymd}-${state.tz}.tsv`);
      closeExportModal();
    } catch (error) {
      setExportStatus(String(error?.message || error), true);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  /* ============================================================
     PAYROLL COMPUTATION  (matches statistics technician payout rules)
     ============================================================ */
  /** Return the email of the person who earns credit for project p. */
  function getEarnerEmail(p){
    if (!p) return null;
    if (String(p.status||'').toLowerCase() !== 'completed') return null;
    if (!p.completed_at) return null;
    const payTech = projectPayTechnician(p);
    if (payTech.email) return payTech.email;
    const qaEmails = new Set([
      p.qa_claimed_by_email, p.qa_approved_by_email, p.qa_approved_by,
      p.qa_reviewed_by_email, p.qa_reviewed_by, p.workflow?.qa_claim?.email
    ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean));
    const assigned = String(p.assigned_to_email||'').trim().toLowerCase();
    if (assigned && qaEmails.has(assigned)) return null;
    if (assigned) return assigned;
    const owner = String(p.owner||'').trim().toLowerCase();
    if (owner && qaEmails.has(owner)) return null;
    return owner || null;
  }

  /**
   * Build a unified dataset of earned items tagged with earner email,
   * plus a map of all known employees.
   * Uses point/speed technician pay, first-pass rush bonus, and rank-based base pay.
   */
  function buildPayrollData(projects, employees, tzKey){
    const tz = tzKey === 'PST' ? TZ.PST : TZ.PHT;
    const items = [];
    for (const p of projects){
      if (!projectIsPaidTechnicianProject(p)) continue;
      const earner = getEarnerEmail(p);
      if (!earner) continue;
      const utcMs = parseSqlAsUtcMs(p.completed_at);
      if (!utcMs) continue;
      const localMs = toLocalViewMs(utcMs, tz.offsetHours);
      const points = resolveProjectPoints(p);
      const timeline = buildSpeedTimeline(points);
      const elapsedMs = collectionElapsedMs(p);
      const band = speedBandForElapsed(elapsedMs, timeline);
      const bandIndex = Math.max(0, SPEED_RATE_BANDS.findIndex(b => b.key === band.key));
      const baseRate = Number.isFinite(points) && points > 0 ? Math.round(points * band.rate) : 0;
      const rushBonus = rushBonusForProject(p, baseRate);
      const payTech = projectPayTechnician(p);

      items.push({
        earnerEmail: earner,
        earnerName:  String(payTech.name || p.qa_paid_to_name || p.assigned_to_name || earner),
        payBasis:    String(payTech.basis || ''),
        id:          p.id,
        address:     p.address || '',
        points,
        elapsedMs,
        band,
        bandIndex,
        baseRate,
        rushBonus,
        earnedPhp:   baseRate + rushBonus,
        rank: technicianRankFromValue(p.drafter_rank || p.technician_rank || p.measurement_technician_rank),
        hasTiming: Number.isFinite(elapsedMs) && elapsedMs > 0,
        utcMs, localMs,
        ymd:      ymdFromLocalViewMs(localMs),
        niceDate: niceDateFromLocalViewMs(localMs)
      });
    }
    // Employee map — known roster ONLY (do not add project owners/customers)
    const empMap = new Map();
    for (const e of employees){
      const em = (e.email||'').toLowerCase().trim();
      if (em) empMap.set(em, {
        email:em,
        name: e.name || em,
        rank: technicianRankFromValue(e.drafter_rank || e.technician_rank || e.measurement_technician_rank),
        raw: e
      });
    }
    // Filter out any items whose earner is not a known employee
    const filtered = items.filter(it => empMap.has(it.earnerEmail));
    return { items: filtered, empMap };
  }

function getPayrollForPeriod(items, empMap, periodStart, periodEnd, tzKey, schedulesMap){
    const periodItems = items.filter(it => it.localMs >= periodStart && it.localMs < periodEnd);
    const byEmp = new Map();
    for (const it of periodItems){
      if (!byEmp.has(it.earnerEmail)) byEmp.set(it.earnerEmail, []);
      byEmp.get(it.earnerEmail).push(it);
    }
    const rows = [];
    for (const [email, emp] of empMap){
      const empItems = byEmp.get(email) || [];
      const projectRankFallback = empItems.map(it => it.rank).find(Boolean) || '';
      const empRank = technicianRankForEmployee(emp.raw || emp, projectRankFallback);
      let projectPay = 0, totalPoints = 0, totalElapsedMs = 0, timedCount = 0;
      let rushBonusPay = 0, rushBonusCount = 0;
      const bandCounts = SPEED_RATE_BANDS.map(() => 0);
      const bandPoints = SPEED_RATE_BANDS.map(() => 0);
      const bandPay = SPEED_RATE_BANDS.map(() => 0);
      const dayMap = new Map();
      for (const it of empItems){
        const points = Number(it.points || 0);
        const idx = Math.max(0, it.bandIndex || 0);
        projectPay += it.baseRate;
        rushBonusPay += Number(it.rushBonus || 0);
        if (Number(it.rushBonus || 0) > 0) rushBonusCount++;
        totalPoints += points;
        bandCounts[idx] = (bandCounts[idx] || 0) + 1;
        bandPoints[idx] = (bandPoints[idx] || 0) + points;
        bandPay[idx] = (bandPay[idx] || 0) + it.baseRate;
        if (Number.isFinite(it.elapsedMs) && it.elapsedMs > 0) {
          totalElapsedMs += it.elapsedMs;
          timedCount++;
        }

        const cur = dayMap.get(it.ymd) || {
          projectPay:0, totalPoints:0, totalElapsedMs:0, timedCount:0,
          bandCounts:SPEED_RATE_BANDS.map(() => 0),
          bandPoints:SPEED_RATE_BANDS.map(() => 0),
          bandPay:SPEED_RATE_BANDS.map(() => 0),
          rushBonusPay:0,
          rushBonusCount:0
        };
        cur.projectPay += it.baseRate;
        cur.rushBonusPay += Number(it.rushBonus || 0);
        if (Number(it.rushBonus || 0) > 0) cur.rushBonusCount++;
        cur.totalPoints += points;
        cur.bandCounts[idx] = (cur.bandCounts[idx] || 0) + 1;
        cur.bandPoints[idx] = (cur.bandPoints[idx] || 0) + points;
        cur.bandPay[idx] = (cur.bandPay[idx] || 0) + it.baseRate;
        if (Number.isFinite(it.elapsedMs) && it.elapsedMs > 0) {
          cur.totalElapsedMs += it.elapsedMs;
          cur.timedCount++;
        }
        dayMap.set(it.ymd, cur);
      }

      const empSched = schedulesMap ? (schedulesMap.get(email) || null) : null;
      const basePayRatePhp = technicianBasePayForRank(empRank);
      let workedDays = 0;
      let techShiftDays = 0;
      let shiftPay = 0;
      for (const [ymd, v] of dayMap.entries()) {
        if (v.projectPay > 0) workedDays++;
        if (v.totalPoints >= TECH_BASE_MIN_POINTS_PER_DAY && technicianBasePayEligibleDay(empSched, ymd)) {
          techShiftDays++;
          v.basePayPhp = basePayRatePhp;
          v.basePayEligible = true;
          shiftPay += basePayRatePhp;
        } else {
          v.basePayPhp = 0;
          v.basePayEligible = false;
        }
      }
      const nonTechRoles = employeePeriodNonTechRoles(empSched, periodStart, periodEnd);
      const totalEarned = projectPay + rushBonusPay + shiftPay;
      const payment     = findPayment(email, periodStart, tzKey);
      const paidAmount  = payment ? payment.amount_php : 0;
      const balance     = totalEarned - paidAmount;

      rows.push({
        email, name: emp.name,
        projectPay, reportPay: projectPay, bonusPay: 0, rushBonusPay, rushBonusCount, totalPoints, totalElapsedMs, timedCount,
        avgElapsedMs: timedCount ? totalElapsedMs / timedCount : null,
        bandCounts, bandPoints, bandPay, workedDays,
        rank: empRank,
        basePayRatePhp,
        techShiftDays,
        shiftPay,
        nonTechRoles,
        totalCount: empItems.length,
        totalEarned,
        paidAmount, balance,
        isPaid: payment !== null,
        payment,
        items: empItems,
        dayMap
      });
    }
    rows.sort((a,b) => {
      if (a.totalEarned > 0 && b.totalEarned === 0) return -1;
      if (a.totalEarned === 0 && b.totalEarned > 0) return 1;
      if (!a.isPaid && b.isPaid) return -1;
      if (a.isPaid && !b.isPaid) return 1;
      return b.totalEarned - a.totalEarned;
    });
    return rows;
  }

  /* ============================================================
     CSS
     ============================================================ */
  function ensureCss(){
    if (document.getElementById('payroll-css')) return;
    const css = document.createElement('style');
    css.id = 'payroll-css';
    css.textContent = `
      /* Payroll plugin — mirrors earnings design language */
      .pr-wrap{ max-width:1200px; }
      .pr-top{ display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
      .pr-title{ display:flex; align-items:baseline; gap:10px; }
      .pr-title h1{ margin:0; font-size:22px; }
      .pr-sub{ color:#777; font-size:12px; font-weight:700; }
      .pr-chiprow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .pr-tz{
        display:flex; align-items:center; gap:8px;
        background:#fff; border:1px solid var(--border); border-radius:10px; padding:8px 10px;
        box-shadow:0 2px 4px rgba(0,0,0,0.04);
      }
      .pr-tz .lbl{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.3px; }
      .pr-tz .tog{ display:flex; gap:6px; }
      .pr-tz .tog button{
        border:1px solid var(--border); background:#fff; padding:7px 10px; border-radius:10px;
        font-weight:900; font-size:12px; cursor:pointer; color:#555;
      }
      .pr-tz .tog button.active{
        border-color: var(--primary); color:#fff; background: var(--primary);
        box-shadow:0 2px 8px rgba(217,48,37,0.15);
      }
      .pr-card{
        background:#fff; border:1px solid var(--border); border-radius:12px;
        box-shadow:0 2px 6px rgba(0,0,0,0.05);
        overflow:hidden; margin-bottom:14px;
      }
      .pr-card .hd{
        padding:14px 16px;
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        border-bottom:1px solid #eee;
        background: linear-gradient(180deg, #fff, #fbfbfb);
        flex-wrap:wrap;
      }
      .pr-card .hd .left{ display:flex; flex-direction:column; gap:4px; }
      .pr-kicker{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.4px; }
      .pr-big{ font-size:18px; font-weight:1000; color:#202124; }
      .pr-card .bd{ padding:14px 16px; }
      .pr-nav{ display:flex; align-items:center; gap:8px; }
      .pr-nav button{
        border:1px solid var(--border); background:#fff; border-radius:10px; width:38px; height:34px;
        cursor:pointer; font-weight:900; color:#444;
      }
      .pr-nav button:hover{ background:#f8f9fa; }
      .pr-range{
        font-weight:1000; font-size:12px; color:#555;
        background:#f8f9fa; border:1px solid #eee; padding:7px 10px; border-radius:999px;
        white-space:nowrap;
      }
      .pr-metrics{ display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; }
      @media (max-width: 820px){ .pr-metrics{ grid-template-columns: repeat(2, 1fr); } }
      .pr-metric{
        border:1px solid #eee; border-radius:12px; padding:10px 12px; background:#fff;
        display:flex; flex-direction:column; gap:4px;
      }
      .pr-metric .k{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.35px; }
      .pr-metric .v{ font-size:18px; font-weight:1000; color:#202124; }
      .pr-metric .s{ font-size:11px; font-weight:800; color:#666; }
      .pr-table{
        width:100%; border-collapse:collapse; overflow:hidden;
        border:1px solid #eee; border-radius:12px;
      }
      .pr-table th{
        background:#f8f9fa; font-size:11px; font-weight:900; color:#666; text-transform:uppercase; letter-spacing:0.4px;
        padding:10px 12px; border-bottom:1px solid #eee; white-space:nowrap;
      }
      .pr-table td{
        padding:10px 12px; border-bottom:1px solid #f0f0f0; font-size:13px;
      }
      .pr-table tr:hover td{ background:#fafafa; }
      .pr-table tfoot td{
        background:#f8f9fa; border-top:2px solid #eee; font-size:13px;
      }
      .pr-right{ text-align:right; }
      .pr-muted{ color:#777; font-weight:700; font-size:12px; }
      .pr-empty{
        padding:18px; border:1px dashed #ddd; border-radius:12px; background:#fff;
        color:#777; font-weight:800; text-align:center;
      }
      .pr-pill{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px; border-radius:999px;
        border:1px solid #eee; background:#fff;
        font-weight:900; font-size:12px; color:#555;
      }
      .pr-dot{ width:9px; height:9px; border-radius:50%; flex-shrink:0; }
      .pr-bonus-badge{
        display:inline-flex; align-items:center; gap:4px;
        padding:2px 7px; border-radius:999px;
        background:#e6f4ea; color:#137333; font-weight:900; font-size:10px;
        border:1px solid #ceead6;
      }
      .pr-status-paid{
        display:inline-flex; align-items:center; gap:6px;
        color:#34a853; font-weight:900; font-size:12px;
      }
      .pr-status-unpaid{
        display:inline-flex; align-items:center; gap:6px;
        color:#ea8600; font-weight:900; font-size:12px;
      }
      .pr-status-none{ color:#bbb; font-weight:700; font-size:12px; }
      .pr-btn-pay{
        border:1px solid var(--primary); background:#fff; color: var(--primary);
        padding:6px 12px; border-radius:10px; font-weight:900; font-size:12px;
        cursor:pointer; display:inline-flex; align-items:center; gap:6px;
        transition: all 0.15s;
      }
      .pr-btn-pay:hover{
        background: var(--primary); color:#fff;
        box-shadow:0 2px 8px rgba(217,48,37,0.18);
      }
      .pr-btn-undo{
        border:1px solid #ddd; background:#fff; color:#777;
        padding:6px 10px; border-radius:10px; font-weight:900; font-size:11px;
        cursor:pointer; display:inline-flex; align-items:center; gap:5px;
      }
      .pr-btn-undo:hover{ background:#f8f9fa; color:#444; border-color:#bbb; }
      .pr-mark-all-btn{
        border:1px solid var(--primary); background: var(--primary); color:#fff;
        padding:8px 16px; border-radius:10px; font-weight:900; font-size:12px;
        cursor:pointer; display:inline-flex; align-items:center; gap:8px;
        box-shadow:0 2px 8px rgba(217,48,37,0.15);
        transition: all 0.15s;
      }
      .pr-mark-all-btn:hover{
        box-shadow:0 4px 14px rgba(217,48,37,0.25);
        transform: translateY(-1px);
      }
      .pr-row-paid td{ background:#f9fdf9 !important; }
      .pr-footnote{ margin-top:10px; font-size:12px; color:#777; line-height:1.45; }
      .pr-rate-legend{ display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
      .pr-emp-detail{
        display:flex; flex-direction:column; gap:2px;
      }
      .pr-emp-detail .name{ font-weight:800; color:#202124; }
      .pr-emp-detail .email{ font-size:11px; color:#888; font-weight:600; }
      .pr-export-btn{
        border:1px solid #1a73e8; background:#fff; color:#1a73e8;
        padding:8px 14px; border-radius:10px; font-weight:900; font-size:12px;
        cursor:pointer; display:inline-flex; align-items:center; gap:7px;
      }
      .pr-export-btn:hover{ background:#e8f0fe; }
      .pr-export-modal[hidden]{ display:none; }
      .pr-export-modal{
        position:fixed; inset:0; z-index:10050; background:rgba(32,33,36,.48);
        display:flex; align-items:center; justify-content:center; padding:20px;
      }
      .pr-export-dialog{
        width:min(430px, 100%); background:#fff; border-radius:14px;
        box-shadow:0 18px 55px rgba(0,0,0,.28); overflow:hidden;
      }
      .pr-export-dialog .head{
        padding:16px 18px; border-bottom:1px solid #eee;
        display:flex; align-items:center; justify-content:space-between; gap:12px;
      }
      .pr-export-dialog h2{ margin:0; font-size:18px; }
      .pr-export-close{
        border:0; background:transparent; color:#666; cursor:pointer; font-size:18px;
        width:32px; height:32px; border-radius:50%;
      }
      .pr-export-close:hover{ background:#f1f3f4; }
      .pr-export-body{ padding:18px; }
      .pr-export-body label{ display:block; font-size:12px; font-weight:900; color:#555; margin-bottom:7px; }
      .pr-export-body input{
        width:100%; box-sizing:border-box; border:1px solid #dadce0; border-radius:10px;
        padding:10px 12px; font:inherit;
      }
      .pr-export-help{ margin-top:9px; color:#777; font-size:12px; line-height:1.45; }
      .pr-export-status{ min-height:18px; margin-top:12px; color:#555; font-size:12px; font-weight:800; }
      .pr-export-status.error{ color:#d93025; }
      .pr-export-actions{
        padding:13px 18px; border-top:1px solid #eee; display:flex;
        justify-content:flex-end; gap:9px; background:#fafafa;
      }
      .pr-export-actions button:disabled{ opacity:.6; cursor:wait; }
    `;
    document.head.appendChild(css);
  }

  /* ============================================================
     UI HELPERS (complexity pills, legends — mirrors earnings.js)
     ============================================================ */

  /** Build a small colored pill for a complexity rating */
  function complexityPill(rating, small) {
    const tier = tierFor(rating);
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="pr-pill" style="${pad}"><span class="pr-dot" style="background:${tier.color}"></span> ${tier.label}</span>`;
  }

  function structurePill(count, small) {
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="pr-pill" style="${pad}"><i class="fas fa-building" style="color:#1a73e8"></i> ${structureLabel(count)}</span>`;
  }

  /** Build the rate legend for the footnote */
  function rateLegendHtml() {
    const shiftRate = getShiftRate();
    const tierPills = Object.entries(COMPLEXITY_TIERS).map(([, t]) =>
      `<span class="pr-pill" style="padding:3px 8px;"><span class="pr-dot" style="background:${t.color}"></span> ${t.label}: <b>${t.rate} PHP</b></span>`
    ).join(' ');
    return tierPills
      + ` <span class="pr-pill" style="padding:3px 8px;"><i class="fas fa-building" style="color:#1a73e8"></i> Multi-structure jobs are shown by structure count</span>`
      + ` <span class="pr-pill" style="padding:3px 8px;"><i class="fas fa-calendar-check" style="color:#1a73e8"></i> Shift: <b>${shiftRate} PHP</b></span>`
      + ` <span class="pr-bonus-badge" style="padding:3px 8px; font-size:11px;"><i class="fas fa-star"></i> First-pass QA: <b>+10%</b></span>`;
  }

  /** Tier table headers for day-by-day tables */
  function tierTableHeaders() {
    return Object.entries(COMPLEXITY_TIERS).map(([r, t]) =>
      `<th class="pr-right" title="${t.label} (${t.rate} PHP)" style="color:${t.color}; font-weight:1000;">L${r}</th>`
    ).join('');
  }

  function tierTableCells(tierCounts) {
    return Object.keys(COMPLEXITY_TIERS).map(r => {
      const n = tierCounts[r] || 0;
      return `<td class="pr-right">${n || '<span style="color:#ddd">\u2013</span>'}</td>`;
    }).join('');
  }

  /** Compact summary: "2 Very Simple · 5 Standard · 1 Very Complex" */
  function tierCountsSummary(tierCounts) {
    return Object.entries(tierCounts)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => {
        const tier = COMPLEXITY_TIERS[r];
        return `${n} ${tier ? tier.label : 'L'+r}`;
      })
      .join(' \u00b7 ');
  }

  function payoutCountsSummary(row) {
    const parts = [];
    const tierSummary = tierCountsSummary(row.tierCounts || {});
    if (tierSummary) parts.push(tierSummary);
    if (row.structureUnitCount > 0) {
      const projText = `${row.structureProjectCount} project${row.structureProjectCount === 1 ? '' : 's'}`;
      parts.push(`${structureLabel(row.structureUnitCount)} across ${projText}`);
    }
    return parts.join(' \u00b7 ');
  }

  /* ============================================================
     MARKUP
     ============================================================ */
  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host) return;
    if (document.getElementById('view-payroll')) return;
    const wrap = document.createElement('div');
    wrap.id = 'view-payroll';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="pr-wrap">
        <!-- ---- Top bar ---- -->
        <div class="pr-top">
          <div class="pr-title">
            <h1>Payroll</h1>
            <div class="pr-sub" id="prSub">Team payroll management</div>
          </div>
          <div class="pr-chiprow">
            <div class="pr-tz">
              <div class="lbl">Timezone</div>
              <div class="tog">
                <button id="prTzPHT" type="button">PHT</button>
                <button id="prTzPST" type="button">PST</button>
              </div>
            </div>
            <button class="pr-export-btn" id="prExportBtn" type="button"><i class="fas fa-file-export"></i> Export Projects</button>
            <button class="btn-secondary" id="prRefreshBtn" type="button"><i class="fas fa-sync"></i> Refresh</button>
          </div>
        </div>

        <!-- ---- Period card (nav + summary) ---- -->
        <div class="pr-card">
          <div class="hd">
            <div class="left">
              <div class="pr-kicker">Pay period (semi-monthly)</div>
              <div class="pr-big" id="prPeriodTitle">\u2014</div>
            </div>
            <div class="pr-nav">
              <button id="prPrevBtn" type="button" title="Previous period"><i class="fas fa-chevron-left"></i></button>
              <div class="pr-range" id="prRangePill">\u2014</div>
              <button id="prNextBtn" type="button" title="Next period"><i class="fas fa-chevron-right"></i></button>
            </div>
          </div>
          <div class="bd">
            <div class="pr-metrics">
              <div class="pr-metric">
                <div class="k">Total Payroll</div>
                <div class="v" id="prTotalPayroll">\u2014</div>
                <div class="s" id="prTotalCounts">\u2014</div>
              </div>
              <div class="pr-metric">
                <div class="k">Employees</div>
                <div class="v" id="prEmpCount">\u2014</div>
                <div class="s" id="prPaidRatio">\u2014</div>
              </div>
              <div class="pr-metric">
                <div class="k">Payout Date</div>
                <div class="v" id="prPayoutDate">\u2014</div>
                <div class="s" id="prPayoutSub">\u2014</div>
              </div>
              <div class="pr-metric">
                <div class="k">Unpaid Balance</div>
                <div class="v" id="prUnpaidBal">\u2014</div>
                <div class="s" id="prUnpaidCount">\u2014</div>
              </div>
            </div>
            <div class="pr-footnote">
              <div>Legend</div>
              <div class="pr-rate-legend" id="prRateLegend"></div>
              <div style="margin-top:6px;">Payment records stored locally in this browser.</div>
            </div>
          </div>
        </div>

        <!-- ---- Payroll table ---- -->
        <div class="pr-card">
          <div class="hd">
            <div class="left">
              <div class="pr-kicker">Project payout breakdown for this period</div>
              <div class="pr-big">Employee Project Pay</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
              <div class="pr-muted" id="prTableMeta">\u2014</div>
              <button class="pr-mark-all-btn" id="prMarkAllBtn" type="button">
                <i class="fas fa-check-double"></i> Mark All as Paid
              </button>
            </div>
          </div>
          <div class="bd" id="prTableHost"></div>
        </div>

        <!-- ---- Daily breakdown for selected period ---- -->
        <div class="pr-card">
          <div class="hd">
            <div class="left">
              <div class="pr-kicker">Day-by-day project payouts</div>
              <div class="pr-big">Daily Breakdown</div>
            </div>
          </div>
          <div class="bd" id="prDailyHost"></div>
        </div>

        <!-- ---- Payroll history ---- -->
        <div class="pr-card">
          <div class="hd">
            <div class="left">
              <div class="pr-kicker">Payment records</div>
              <div class="pr-big">Payroll History</div>
            </div>
            <div class="pr-muted" id="prHistMeta">\u2014</div>
          </div>
          <div class="bd" id="prHistHost"></div>
        </div>
      </div>
      <div class="pr-export-modal" id="prExportModal" role="dialog" aria-modal="true" aria-labelledby="prExportTitle" hidden>
        <div class="pr-export-dialog">
          <div class="head">
            <h2 id="prExportTitle">Export payroll projects</h2>
            <button class="pr-export-close" id="prExportClose" type="button" aria-label="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="pr-export-body">
            <label for="prExportDate">Completion date</label>
            <input id="prExportDate" type="date">
            <div class="pr-export-help">Exports completed projects for this day in <b id="prExportTimezone"></b> as a tab-separated file.</div>
            <div class="pr-export-status" id="prExportStatus" aria-live="polite"></div>
          </div>
          <div class="pr-export-actions">
            <button class="btn-secondary" id="prExportCancel" type="button">Cancel</button>
            <button class="pr-mark-all-btn" id="prExportSubmit" type="button"><i class="fas fa-download"></i> Export TSV</button>
          </div>
        </div>
      </div>
    `;
    host.appendChild(wrap);
  }

  /* ============================================================
     RENDERING
     ============================================================ */

  function renderPayrollTable(rows, periodNonTechRoles){
    const shiftRate = getShiftRate();
    const active = rows.filter(r => r.totalEarned > 0 || r.isPaid);
    if (!active.length){
      return `<div class="pr-empty">No employee earnings in this pay period.</div>`
        + nonTechPayNote(periodNonTechRoles);
    }
    const totReport  = active.reduce((s,r) => s + r.reportPay, 0);
    const totBonus   = active.reduce((s,r) => s + r.bonusPay, 0);
    const totRush    = active.reduce((s,r) => s + Number(r.rushBonusPay || 0), 0);
    const totShift   = active.reduce((s,r) => s + r.shiftPay, 0);
    const totEarned  = active.reduce((s,r) => s + r.totalEarned, 0);
    const totPaid    = active.reduce((s,r) => s + r.paidAmount, 0);
    const totBalance = active.reduce((s,r) => s + Math.max(0, r.balance), 0);
    const totCount   = active.reduce((s,r) => s + r.totalCount, 0);
    return `
      <table class="pr-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th class="pr-right">Projects</th>
            <th class="pr-right">Report Pay</th>
            <th class="pr-right">QA Bonus</th>
            ${totRush > 0 ? '<th class="pr-right">Rush Bonus</th>' : ''}
            <th class="pr-right">Tech Shifts</th>
            <th class="pr-right">Shift Pay</th>
            <th class="pr-right">Total Earned</th>
            <th class="pr-right">Paid</th>
            <th class="pr-right">Balance</th>
            <th>Status</th>
            <th style="text-align:center;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${active.map(r => {
            const rowClass = r.isPaid ? 'pr-row-paid' : '';
            let statusHtml, actionHtml;
            if (r.isPaid){
              statusHtml = `<span class="pr-status-paid"><i class="fas fa-check-circle"></i> Paid</span>`;
              actionHtml = `<button class="pr-btn-undo" data-email="${esc(r.email)}" title="Remove payment record"><i class="fas fa-undo"></i> Undo</button>`;
            } else if (r.totalEarned > 0){
              statusHtml = `<span class="pr-status-unpaid"><i class="fas fa-clock"></i> Unpaid</span>`;
              actionHtml = `<button class="pr-btn-pay" data-email="${esc(r.email)}" data-amount="${r.totalEarned}" title="Mark as paid"><i class="fas fa-paper-plane"></i> Mark Paid</button>`;
            } else {
              statusHtml = `<span class="pr-status-none">\u2014</span>`;
              actionHtml = '';
            }
            const shiftLabel = r.techShiftDays > 0
              ? String(r.techShiftDays)
              : '<span style="color:#ddd">\u2013</span>';
            return `
              <tr class="${rowClass}">
                <td>
                  <div class="pr-emp-detail">
                    <span class="name">${esc(r.name)}</span>
                    <span class="email">${esc(r.email)}</span>
                  </div>
                </td>
                <td class="pr-right">
                  <div><b>${r.totalCount}</b></div>
                  ${r.structureUnitCount > 0 ? `<div class="pr-muted">${esc(structureLabel(r.structureUnitCount))}</div>` : ''}
                </td>
                <td class="pr-right">
                  <div><b>${fmtPhp(r.reportPay)}</b></div>
                  ${r.structureUnitCount > 0 ? `<div class="pr-muted">${esc(payoutCountsSummary(r))}</div>` : ''}
                </td>
                <td class="pr-right">${r.bonusPay > 0 ? `<span class="pr-bonus-badge">+${fmtPhp(r.bonusPay)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>
                ${totRush > 0 ? `<td class="pr-right">${r.rushBonusPay > 0 ? `<span class="pr-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(r.rushBonusPay)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>` : ''}
                <td class="pr-right">${shiftLabel}</td>
                <td class="pr-right">${r.shiftPay > 0 ? fmtPhp(r.shiftPay) : '<span style="color:#ddd">\u2013</span>'}</td>
                <td class="pr-right"><b>${fmtPhp(r.totalEarned)}</b></td>
                <td class="pr-right">${r.isPaid ? fmtPhp(r.paidAmount) : '\u2014'}</td>
                <td class="pr-right"><b>${fmtPhp(Math.max(0, r.balance))}</b></td>
                <td>${statusHtml}</td>
                <td style="text-align:center;">${actionHtml}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td><b>Totals (${active.length} employee${active.length !== 1 ? 's' : ''})</b></td>
            <td class="pr-right"><b>${totCount}</b></td>
            <td class="pr-right"><b>${fmtPhp(totReport)}</b></td>
            <td class="pr-right"><b>${totBonus > 0 ? `<span class="pr-bonus-badge">+${fmtPhp(totBonus)}</span>` : '\u2013'}</b></td>
            ${totRush > 0 ? `<td class="pr-right"><b><span class="pr-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(totRush)}</span></b></td>` : ''}
            <td class="pr-right"><b>${active.reduce((s,r) => s + r.techShiftDays, 0)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totShift)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totEarned)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totPaid)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totBalance)}</b></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
      ${nonTechPayNote(periodNonTechRoles)}
    `;
  }

  function renderDailyBreakdown(rows, periodStart, periodEnd, schedulesMap){
    const shiftRate = getShiftRate();
    const active = rows.filter(r => r.totalEarned > 0 || r.isPaid);
    const numDays = Math.max(1, Math.round((periodEnd - periodStart) / 86400000));
    if (!active.length){
      const ntr = allPeriodNonTechRoles(schedulesMap || new Map(), periodStart, periodEnd);
      return `<div class="pr-empty">No activity this period.</div>` + nonTechPayNote(ntr);
    }
    const dayTotals = new Map();
    const dayEmployees = new Map();
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(periodStart, i);
      const ymd = ymdFromLocalViewMs(dayMs);
      dayTotals.set(ymd, { reportPay:0, bonusPay:0, bonusCount:0, structurePay:0, structureProjectCount:0, structureUnitCount:0, tierCounts:{ 1:0, 2:0, 3:0, 4:0, 5:0 } });
      dayEmployees.set(ymd, []);
    }
    for (const r of active){
      for (const [ymd, v] of r.dayMap){
      const dt = dayTotals.get(ymd);
      if (dt){
        dt.reportPay += v.reportPay;
        dt.bonusPay  += v.bonusPay;
        dt.bonusCount += v.bonusCount;
        dt.structurePay += (v.structurePay || 0);
        dt.structureProjectCount += (v.structureProjectCount || 0);
        dt.structureUnitCount += (v.structureUnitCount || 0);
        for (const k of Object.keys(dt.tierCounts)){
          dt.tierCounts[k] += (v.tierCounts[k] || 0);
        }
      }
        const de = dayEmployees.get(ymd);
        if (de){
          de.push({
            email: r.email, name: r.name,
            reportPay: v.reportPay, bonusPay: v.bonusPay,
            total: v.reportPay + v.bonusPay
          });
        }
      }
    }
    const dayRows = [];
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(periodStart, i);
      const ymd   = ymdFromLocalViewMs(dayMs);
      const nice  = niceDateFromLocalViewMs(dayMs);
      const w     = weekdayFromYmd(ymd);
      const v     = dayTotals.get(ymd) || { reportPay:0, bonusPay:0, bonusCount:0, structurePay:0, structureProjectCount:0, structureUnitCount:0, tierCounts:{ 1:0, 2:0, 3:0, 4:0, 5:0 } };
      const emps  = dayEmployees.get(ymd) || [];

      // Only count workers who have a technician shift that day
      let techWorkers = 0;
      for (const e of emps) {
        const empSched = schedulesMap ? (schedulesMap.get(e.email) || null) : null;
        if (dayHasTechnicianShift(empSched, ymd)) techWorkers++;
      }
      const dayShiftPay = techWorkers * shiftRate;
      const dayTotal = v.reportPay + v.bonusPay + dayShiftPay;
      dayRows.push({ ymd, w, nice, dayTotal, dayShiftPay, techWorkers, uniqueWorkers: emps.length, ...v, emps });
    }
    const ntr = allPeriodNonTechRoles(schedulesMap || new Map(), periodStart, periodEnd);
    return `
      <table class="pr-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Date</th>
            <th class="pr-right">Total</th>
            ${tierTableHeaders()}
            <th class="pr-right" title="Structure-paid work">Structures</th>
            <th class="pr-right" title="QA first-pass bonus">Bonus</th>
            <th class="pr-right" title="Technician shift pay (${shiftRate} PHP per worker)">Tech Shifts</th>
            <th>Contributors</th>
          </tr>
        </thead>
        <tbody>
          ${dayRows.map(d => {
            const contribs = d.emps.length > 0
              ? d.emps.map(e => `<span class="pr-pill" style="padding:3px 8px; margin:2px;">${esc(e.name.split(' ')[0] || e.email.split('@')[0])}: ${fmtPhp(e.total)}</span>`).join(' ')
              : '<span class="pr-muted">\u2014</span>';
            return `
              <tr>
                <td><b>${d.w}</b></td>
                <td>${d.nice}</td>
                <td class="pr-right"><b>${fmtPhp(d.dayTotal)}</b></td>
                ${tierTableCells(d.tierCounts)}
                <td class="pr-right">${d.structureUnitCount > 0 ? `<b>${d.structureUnitCount}</b>` : '<span style="color:#ddd">\u2013</span>'}</td>
                <td class="pr-right">${d.bonusPay > 0 ? `<span class="pr-bonus-badge">+${fmtPhp(d.bonusPay)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>
                <td class="pr-right">${d.techWorkers > 0 ? `${d.techWorkers} \u00d7 ${shiftRate}` : '<span style="color:#ddd">\u2013</span>'}</td>
                <td>${contribs}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(ntr)}
    `;
  }

  /** Payment history from localStorage */
  function renderHistory(){
    const host = document.getElementById('prHistHost');
    const meta = document.getElementById('prHistMeta');
    if (!host) return;
    const h = loadHistory();
    const payments = (h.payments || []).slice().sort((a,b) =>
      (b.paid_at || '').localeCompare(a.paid_at || '')
    );
    if (meta) meta.textContent = `${payments.length} record(s)`;
    if (!payments.length){
      host.innerHTML = `<div class="pr-empty">No payment records yet. Mark employees as paid to create records.</div>`;
      return;
    }
    const shown = payments.slice(0, 100);
    host.innerHTML = `
      <table class="pr-table">
        <thead>
          <tr>
            <th>Date Paid</th>
            <th>Employee</th>
            <th>Pay Period</th>
            <th class="pr-right">Amount</th>
            <th>Timezone</th>
            <th>Marked By</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(p => {
            let paidDate = '\u2014';
            if (p.paid_at){
              try { paidDate = new Date(p.paid_at).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e){ paidDate = p.paid_at; }
            }
            return `
              <tr>
                <td>${esc(paidDate)}</td>
                <td>
                  <div class="pr-emp-detail">
                    <span class="name">${esc(p.employee_name || p.employee_email)}</span>
                    <span class="email">${esc(p.employee_email)}</span>
                  </div>
                </td>
                <td>${esc(p.period_label || '\u2014')}</td>
                <td class="pr-right"><b>${fmtPhp(p.amount_php || 0)}</b></td>
                <td>${esc(p.tz_key || '\u2014')}</td>
                <td class="pr-muted">${esc(p.paid_by_name || p.paid_by_email || '\u2014')}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function speedBandPill(band, small) {
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="pr-pill" style="${pad}"><span class="pr-dot" style="background:${band.color}"></span> ${band.label}</span>`;
  }

  function bandTableHeaders() {
    return SPEED_RATE_BANDS.map(b =>
      `<th class="pr-right" title="${b.label} (${b.rate} PHP/pt)" style="color:${b.color}; font-weight:1000;">${b.rate}/pt</th>`
    ).join('');
  }

  function bandTableCells(bandCounts) {
    return SPEED_RATE_BANDS.map((b, idx) => {
      const n = (bandCounts && bandCounts[idx]) || 0;
      return `<td class="pr-right">${n || '<span style="color:#ddd">-</span>'}</td>`;
    }).join('');
  }

  function rateLegendHtml() {
    const bandPills = SPEED_RATE_BANDS.map((t) =>
      `<span class="pr-pill" style="padding:3px 8px;"><span class="pr-dot" style="background:${t.color}"></span> ${t.label}: <b>${t.rate} PHP/pt</b></span>`
    ).join(' ');
    return bandPills
      + ` <span class="pr-pill" style="padding:3px 8px;"><i class="fas fa-stopwatch" style="color:#1a73e8"></i> Point pay = project points × speed-band rate</span>`
      + ` <span class="pr-pill" style="padding:3px 8px;"><i class="fas fa-calendar-check" style="color:#137333"></i> Base pay requires ${TECH_BASE_MIN_POINTS_PER_DAY}+ pts/day</span>`;
  }

  function payoutCountsSummary(row) {
    if (!row || !row.totalCount) return 'No completions';
    return `${row.totalCount} project(s) | ${fmtPoints(row.totalPoints)} pts | ${row.techShiftDays || 0} base day(s)`;
  }

  function speedCountsSummary(row) {
    const parts = SPEED_RATE_BANDS
      .map((b, idx) => ((row.bandCounts && row.bandCounts[idx]) || 0) > 0 ? `${row.bandCounts[idx]} ${b.label}` : '')
      .filter(Boolean);
    return parts.join(' | ') || 'No timed projects';
  }

  function renderPayrollTable(rows, periodNonTechRoles){
    const active = rows.filter(r => r.totalEarned > 0 || r.isPaid);
    if (!active.length){
      return `<div class="pr-empty">No employee earnings in this pay period.</div>`
        + nonTechPayNote(periodNonTechRoles);
    }
    const totProject = active.reduce((s,r) => s + r.projectPay, 0);
    const totRush    = active.reduce((s,r) => s + Number(r.rushBonusPay || 0), 0);
    const totBase    = active.reduce((s,r) => s + Number(r.shiftPay || 0), 0);
    const totEarned  = active.reduce((s,r) => s + r.totalEarned, 0);
    const totPaid    = active.reduce((s,r) => s + r.paidAmount, 0);
    const totBalance = active.reduce((s,r) => s + Math.max(0, r.balance), 0);
    const totCount   = active.reduce((s,r) => s + r.totalCount, 0);
    const totPoints  = active.reduce((s,r) => s + r.totalPoints, 0);
    return `
      <table class="pr-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th class="pr-right">Projects</th>
            <th class="pr-right">Points</th>
            <th class="pr-right">Avg Time</th>
            <th>Speed Mix</th>
            <th class="pr-right">Point Pay</th>
            <th class="pr-right">Rush</th>
            <th class="pr-right">Base Days</th>
            <th class="pr-right">Base Pay</th>
            <th class="pr-right">Total Earned</th>
            <th class="pr-right">Paid</th>
            <th class="pr-right">Balance</th>
            <th>Status</th>
            <th style="text-align:center;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${active.map(r => {
            const rowClass = r.isPaid ? 'pr-row-paid' : '';
            let statusHtml, actionHtml;
            if (r.isPaid){
              statusHtml = `<span class="pr-status-paid"><i class="fas fa-check-circle"></i> Paid</span>`;
              actionHtml = `<button class="pr-btn-undo" data-email="${esc(r.email)}" title="Remove payment record"><i class="fas fa-undo"></i> Undo</button>`;
            } else if (r.totalEarned > 0){
              statusHtml = `<span class="pr-status-unpaid"><i class="fas fa-clock"></i> Unpaid</span>`;
              actionHtml = `<button class="pr-btn-pay" data-email="${esc(r.email)}" data-amount="${r.totalEarned}" title="Mark as paid"><i class="fas fa-paper-plane"></i> Mark Paid</button>`;
            } else {
              statusHtml = `<span class="pr-status-none">-</span>`;
              actionHtml = '';
            }
            return `
              <tr class="${rowClass}">
                <td>
                  <div class="pr-emp-detail">
                    <span class="name">${esc(r.name)}</span>
                    <span class="email">${esc(r.email)}</span>
                  </div>
                </td>
                <td class="pr-right"><b>${r.totalCount}</b></td>
                <td class="pr-right">${fmtPoints(r.totalPoints)}</td>
                <td class="pr-right">${r.avgElapsedMs ? fmtDuration(r.avgElapsedMs) : '<span style="color:#777">No timer</span>'}</td>
                <td><span class="pr-muted">${esc(speedCountsSummary(r))}</span></td>
                <td class="pr-right">
                  <div><b>${fmtPhp(r.projectPay)}</b></div>
                  <div class="pr-muted">${esc(payoutCountsSummary(r))}</div>
                </td>
                <td class="pr-right">${r.rushBonusPay > 0 ? `<span class="pr-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(r.rushBonusPay)}</span>` : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${r.techShiftDays > 0 ? `<b>${r.techShiftDays}</b><div class="pr-muted">${esc(r.rank || 'junior')} @ ${fmtPhp(r.basePayRatePhp)}</div>` : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${r.shiftPay > 0 ? fmtPhp(r.shiftPay) : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right"><b>${fmtPhp(r.totalEarned)}</b></td>
                <td class="pr-right">${r.isPaid ? fmtPhp(r.paidAmount) : '-'}</td>
                <td class="pr-right"><b>${fmtPhp(Math.max(0, r.balance))}</b></td>
                <td>${statusHtml}</td>
                <td style="text-align:center;">${actionHtml}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td><b>Totals (${active.length} employee${active.length !== 1 ? 's' : ''})</b></td>
            <td class="pr-right"><b>${totCount}</b></td>
            <td class="pr-right"><b>${fmtPoints(totPoints)}</b></td>
            <td></td>
            <td></td>
            <td class="pr-right"><b>${fmtPhp(totProject)}</b></td>
            <td class="pr-right"><b>${totRush > 0 ? `<span class="pr-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(totRush)}</span>` : '-'}</b></td>
            <td class="pr-right"><b>${active.reduce((s,r) => s + (r.techShiftDays || 0), 0)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totBase)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totEarned)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totPaid)}</b></td>
            <td class="pr-right"><b>${fmtPhp(totBalance)}</b></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
      ${nonTechPayNote(periodNonTechRoles)}
    `;
  }

  function renderDailyBreakdown(rows, periodStart, periodEnd, schedulesMap){
    const active = rows.filter(r => r.totalEarned > 0 || r.isPaid);
    const numDays = Math.max(1, Math.round((periodEnd - periodStart) / 86400000));
    if (!active.length){
      const ntr = allPeriodNonTechRoles(schedulesMap || new Map(), periodStart, periodEnd);
      return `<div class="pr-empty">No activity this period.</div>` + nonTechPayNote(ntr);
    }
    const dayTotals = new Map();
    const dayEmployees = new Map();
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(periodStart, i);
      const ymd = ymdFromLocalViewMs(dayMs);
      dayTotals.set(ymd, {
        projectPay:0, totalPoints:0, totalElapsedMs:0, timedCount:0,
        rushBonusPay:0, basePayPhp:0, basePayDays:0,
        bandCounts:SPEED_RATE_BANDS.map(() => 0)
      });
      dayEmployees.set(ymd, []);
    }
    for (const r of active){
      for (const [ymd, v] of r.dayMap){
        const dt = dayTotals.get(ymd);
        if (dt){
          dt.projectPay += v.projectPay;
          dt.totalPoints += v.totalPoints;
          dt.totalElapsedMs += v.totalElapsedMs;
          dt.timedCount += v.timedCount;
          dt.rushBonusPay += Number(v.rushBonusPay || 0);
          dt.basePayPhp += Number(v.basePayPhp || 0);
          dt.basePayDays += v.basePayEligible ? 1 : 0;
          for (let i = 0; i < SPEED_RATE_BANDS.length; i++) {
            dt.bandCounts[i] += (v.bandCounts[i] || 0);
          }
        }
        const de = dayEmployees.get(ymd);
        if (de){
          de.push({
            email: r.email, name: r.name,
            projectPay: v.projectPay,
            rushBonusPay: Number(v.rushBonusPay || 0),
            basePayPhp: Number(v.basePayPhp || 0),
            total: v.projectPay + Number(v.rushBonusPay || 0) + Number(v.basePayPhp || 0)
          });
        }
      }
    }
    const dayRows = [];
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(periodStart, i);
      const ymd   = ymdFromLocalViewMs(dayMs);
      const nice  = niceDateFromLocalViewMs(dayMs);
      const w     = weekdayFromYmd(ymd);
      const v     = dayTotals.get(ymd) || {
        projectPay:0, totalPoints:0, totalElapsedMs:0, timedCount:0,
        rushBonusPay:0, basePayPhp:0, basePayDays:0,
        bandCounts:SPEED_RATE_BANDS.map(() => 0)
      };
      const emps  = dayEmployees.get(ymd) || [];
      dayRows.push({
        ymd, w, nice,
        dayTotal: v.projectPay + Number(v.rushBonusPay || 0) + Number(v.basePayPhp || 0),
        avgElapsedMs: v.timedCount ? v.totalElapsedMs / v.timedCount : null,
        uniqueWorkers: emps.length,
        ...v,
        emps
      });
    }
    const ntr = allPeriodNonTechRoles(schedulesMap || new Map(), periodStart, periodEnd);
    return `
      <table class="pr-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Date</th>
            <th class="pr-right">Total</th>
            <th class="pr-right">Projects</th>
            <th class="pr-right">Points</th>
            <th class="pr-right">Point Pay</th>
            <th class="pr-right">Rush</th>
            <th class="pr-right">Base Pay</th>
            <th class="pr-right">Avg Time</th>
            ${bandTableHeaders()}
            <th>Contributors</th>
          </tr>
        </thead>
        <tbody>
          ${dayRows.map(d => {
            const contribs = d.emps.length > 0
              ? d.emps.map(e => `<span class="pr-pill" style="padding:3px 8px; margin:2px;">${esc(e.name.split(' ')[0] || e.email.split('@')[0])}: ${fmtPhp(e.total)}</span>`).join(' ')
              : '<span class="pr-muted">-</span>';
            return `
              <tr>
                <td><b>${d.w}</b></td>
                <td>${d.nice}</td>
                <td class="pr-right"><b>${fmtPhp(d.dayTotal)}</b></td>
                <td class="pr-right">${d.bandCounts.reduce((s,n) => s + n, 0) || '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${d.totalPoints > 0 ? fmtPoints(d.totalPoints) : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${d.projectPay > 0 ? fmtPhp(d.projectPay) : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${d.rushBonusPay > 0 ? `<span class="pr-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(d.rushBonusPay)}</span>` : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${d.basePayPhp > 0 ? `${fmtPhp(d.basePayPhp)}<div class="pr-muted">${d.basePayDays} day(s)</div>` : '<span style="color:#ddd">-</span>'}</td>
                <td class="pr-right">${d.avgElapsedMs ? fmtDuration(d.avgElapsedMs) : '<span style="color:#ddd">-</span>'}</td>
                ${bandTableCells(d.bandCounts)}
                <td>${contribs}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(ntr)}
    `;
  }

  /* ============================================================
     UI HELPERS
     ============================================================ */
  function setActive(el, yes){ if (el) el.classList.toggle('active', !!yes); }
  function updateTzButtons(st){
    setActive(document.getElementById('prTzPHT'), st.tz === 'PHT');
    setActive(document.getElementById('prTzPST'), st.tz === 'PST');
  }

  /**
   * Shift the anchor to the previous or next semi-monthly period.
   */
  function shiftAnchor(state, dir){
    const tz = state.tz === 'PST' ? TZ.PST : TZ.PHT;
    const anchorLocal = toLocalViewMs(state.anchorMs, tz.offsetHours);
    const per = periodForAnchor(anchorLocal);
    const dt = new Date(per.start);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    let newLocalMid;
    if (d === 1) {
      // Currently in 1st–15th
      if (dir === -1) {
        // Go to 16th–end of PREVIOUS month
        newLocalMid = Date.UTC(y, m - 1, 20, 0, 0, 0);
      } else {
        // Go to 16th–end of CURRENT month
        newLocalMid = Date.UTC(y, m, 20, 0, 0, 0);
      }
    } else {
      // Currently in 16th–end
      if (dir === -1) {
        // Go to 1st–15th of SAME month
        newLocalMid = Date.UTC(y, m, 8, 0, 0, 0);
      } else {
        // Go to 1st–15th of NEXT month
        newLocalMid = Date.UTC(y, m + 1, 8, 0, 0, 0);
      }
    }
    state.anchorMs = newLocalMid - tz.offsetHours * 3600000;
  }

  /* ============================================================
     MAIN RENDER
     ============================================================ */
  // Keeps track of current rows + period for button handlers
  let _currentRows = [];
  let _currentPeriodStart = 0;
  let _currentPeriodEnd   = 0;

  async function render(state, forceFetch = false){
    ensureCss();
    ensureMarkup();
    updateTzButtons(state);

    const tz = state.tz === 'PST' ? TZ.PST : TZ.PHT;
    const anchorLocal = toLocalViewMs(state.anchorMs, tz.offsetHours);
    const per = periodForAnchor(anchorLocal);
    const periodStart = per.start;
    const periodEnd   = per.end;

    // Fetch
    const now = Date.now();
    if (forceFetch || !cachedProjects || (now - cachedAt) > 30000){
      try {
        const [proj, emp] = await Promise.all([fetchAllProjects(), fetchEmployees()]);
        cachedProjects  = proj;
        cachedEmployees = emp;
        cachedAt = now;
      } catch(e){
        const host = document.getElementById('prTableHost');
        if (host) host.innerHTML = `<div class="pr-empty" style="color:#d93025;">Failed to load data. You may not have permission to view all projects.<br><br>${esc(String(e))}</div>`;
        return;
      }
    }
    if (forceFetch || !cachedSchedules || (now - cachedSchedulesAt) > 30000){
      cachedSchedules = await fetchAllShiftSchedules(state);
      cachedSchedulesAt = now;
    }

    // Compute
    const { items, empMap } = buildPayrollData(cachedProjects, cachedEmployees, state.tz);
    const rows = getPayrollForPeriod(items, empMap, periodStart, periodEnd, state.tz, cachedSchedules);
    const active = rows.filter(r => r.totalEarned > 0 || r.isPaid);

    _currentRows        = rows;
    _currentPeriodStart = periodStart;
    _currentPeriodEnd   = periodEnd;

    // Period header
    const startNice = niceDateFromLocalViewMs(periodStart);
    const endNice   = niceDateFromLocalViewMs(addDays(periodEnd, -1));
    const el = id => document.getElementById(id);

    const titleEl = el('prPeriodTitle');
    const pillEl  = el('prRangePill');
    if (titleEl) titleEl.textContent = `${startNice} \u2013 ${endNice}`;
    if (pillEl)  pillEl.textContent  = `${startNice} \u2192 ${endNice}`;

    // Summary metrics
    const totalPayroll = active.reduce((s,r) => s + r.totalEarned, 0);
    const totalCount   = active.reduce((s,r) => s + r.totalCount, 0);
    const totalPoints  = active.reduce((s,r) => s + r.totalPoints, 0);
    const empCount     = active.length;
    const paidCount    = active.filter(r => r.isPaid).length;
    const unpaidBal    = active.reduce((s,r) => s + Math.max(0, r.isPaid ? 0 : r.totalEarned), 0);
    const unpaidCount  = active.filter(r => !r.isPaid && r.totalEarned > 0).length;

    const prTotalPayroll = el('prTotalPayroll');
    const prTotalCounts  = el('prTotalCounts');
    const prEmpCount     = el('prEmpCount');
    const prPaidRatio    = el('prPaidRatio');
    const prPayoutDate   = el('prPayoutDate');
    const prPayoutSub    = el('prPayoutSub');
    const prUnpaidBal    = el('prUnpaidBal');
    const prUnpaidCount  = el('prUnpaidCount');

    if (prTotalPayroll) prTotalPayroll.textContent = fmtPhp(totalPayroll);
    if (prTotalCounts) {
      prTotalCounts.textContent = `${totalCount} project(s) | ${fmtPoints(totalPoints)} pts | point + rush + base pay`;
    }
    if (prEmpCount)     prEmpCount.textContent     = String(empCount);
    if (prPaidRatio)    prPaidRatio.textContent     = `${paidCount} paid / ${unpaidCount} unpaid`;
    if (prPayoutDate)   prPayoutDate.textContent    = niceDateFromLocalViewMs(payoutDateForPeriod(periodStart));

    // Payout subtitle: describe the schedule
    const perStartDt = new Date(periodStart);
    const perDay = perStartDt.getUTCDate();
    if (prPayoutSub) {
      if (perDay <= 15) {
        prPayoutSub.textContent = '1st\u201315th \u2192 paid on 20th';
      } else {
        prPayoutSub.textContent = '16th\u2013end \u2192 paid on 5th';
      }
    }

    if (prUnpaidBal)    prUnpaidBal.textContent     = fmtPhp(unpaidBal);
    if (prUnpaidCount)  prUnpaidCount.textContent   = `${unpaidCount} employee(s) pending`;

    // Rate legend
    const legendEl = el('prRateLegend');
    if (legendEl) legendEl.innerHTML = rateLegendHtml();

    // Table meta
    const tableMeta = el('prTableMeta');
    if (tableMeta) tableMeta.textContent = `${active.length} employee(s)`;

    // Collect all non-tech roles across the period for the note
    const periodNonTechRoles = allPeriodNonTechRoles(cachedSchedules, periodStart, periodEnd);

    // Render table
    const tableHost = el('prTableHost');
    if (tableHost) tableHost.innerHTML = renderPayrollTable(rows, periodNonTechRoles);

    // Render daily breakdown
    const dailyHost = el('prDailyHost');
    if (dailyHost) dailyHost.innerHTML = renderDailyBreakdown(rows, periodStart, periodEnd, cachedSchedules);

    // Render history
    renderHistory();

    // Sub line
    const subEl = el('prSub');
    if (subEl) subEl.textContent = `Team payroll \u2022 ${tz.label} (${tz.sub})`;

    // Mark-all button visibility
    const markAllBtn = el('prMarkAllBtn');
    if (markAllBtn){
      markAllBtn.style.display = unpaidCount > 0 ? '' : 'none';
    }
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  function wireUi(state){
    const w = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    w('prTzPHT', async () => { state.tz = 'PHT'; saveState(state); await render(state); });
    w('prTzPST', async () => { state.tz = 'PST'; saveState(state); await render(state); });
    w('prPrevBtn', async () => { shiftAnchor(state, -1); saveState(state); await render(state); });
    w('prNextBtn', async () => { shiftAnchor(state, +1); saveState(state); await render(state); });
    w('prRefreshBtn', async () => { await render(state, true); });
    w('prExportBtn', () => openExportModal(state));
    w('prExportClose', closeExportModal);
    w('prExportCancel', closeExportModal);
    w('prExportSubmit', () => runPayrollExport(state));
    const exportModal = document.getElementById('prExportModal');
    if (exportModal) {
      exportModal.addEventListener('click', event => {
        if (event.target === exportModal) closeExportModal();
      });
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !document.getElementById('prExportModal')?.hidden) closeExportModal();
    });

    // --- Mark All as Paid ---
    const markAllBtn = document.getElementById('prMarkAllBtn');
    if (markAllBtn){
      markAllBtn.onclick = async function(){
        const unpaid = _currentRows.filter(r => !r.isPaid && r.totalEarned > 0);
        if (!unpaid.length){
          alert('All employees are already marked as paid for this period.');
          return;
        }
        const total = unpaid.reduce((s,r) => s + r.totalEarned, 0);
        const periodLabel = niceDateFromLocalViewMs(_currentPeriodStart) + ' \u2013 ' + niceDateFromLocalViewMs(addDays(_currentPeriodEnd, -1));
        const ok = confirm(
          `Mark ${unpaid.length} employee(s) as paid?\n\n` +
          `Total: ${fmtPhp(total)}\n` +
          `Period: ${periodLabel}\n\n` +
          `Employees:\n` +
          unpaid.map(r => {
            return `  \u2022 ${r.name} \u2014 ${fmtPhp(r.totalEarned)} (${r.totalCount} projects, ${fmtPoints(r.totalPoints)} pts, ${r.techShiftDays || 0} base days, ${speedCountsSummary(r)})`;
          }).join('\n')
        );
        if (!ok) return;

        const me     = String(cfg()?.user?.email || '').toLowerCase();
        const meName = String(cfg()?.user?.name || me);
        const now    = new Date().toISOString();

        for (const r of unpaid){
          recordPayment({
            id:               genId(),
            employee_email:   r.email.toLowerCase(),
            employee_name:    r.name,
            period_start_ms:  _currentPeriodStart,
            period_end_ms:    _currentPeriodEnd,
            period_label:     periodLabel,
            amount_php:       r.totalEarned,
            tz_key:           state.tz,
            paid_at:          now,
            paid_by_email:    me,
            paid_by_name:     meName
          });
        }
        await render(state, false);
      };
    }

    // --- Delegate clicks inside table (Mark Paid / Undo) ---
    const tableHost = document.getElementById('prTableHost');
    if (tableHost){
      tableHost.addEventListener('click', async function(e){
        const payBtn  = e.target.closest('.pr-btn-pay');
        const undoBtn = e.target.closest('.pr-btn-undo');

        if (payBtn){
          const email  = payBtn.dataset.email;
          const amount = parseFloat(payBtn.dataset.amount || '0');
          const row    = _currentRows.find(r => r.email === email);
          if (!row) return;

          const periodLabel = niceDateFromLocalViewMs(_currentPeriodStart) + ' \u2013 ' + niceDateFromLocalViewMs(addDays(_currentPeriodEnd, -1));
          const ok = confirm(
            `Mark as paid?\n\n` +
            `Employee: ${row.name} (${email})\n` +
            `Amount: ${fmtPhp(amount)}\n` +
            `  Project pay: ${fmtPhp(row.projectPay)}\n` +
            `  Points:      ${fmtPoints(row.totalPoints)}\n` +
            `  Speed mix:   ${speedCountsSummary(row)}\n` +
            `Period: ${periodLabel}`
          );
          if (!ok) return;

          const me     = String(cfg()?.user?.email || '').toLowerCase();
          const meName = String(cfg()?.user?.name || me);

          recordPayment({
            id:               genId(),
            employee_email:   email.toLowerCase(),
            employee_name:    row.name,
            period_start_ms:  _currentPeriodStart,
            period_end_ms:    _currentPeriodEnd,
            period_label:     periodLabel,
            amount_php:       amount,
            tz_key:           state.tz,
            paid_at:          new Date().toISOString(),
            paid_by_email:    me,
            paid_by_name:     meName
          });
          await render(state, false);
        }

        if (undoBtn){
          const email = undoBtn.dataset.email;
          const row   = _currentRows.find(r => r.email === email);
          const who   = row ? row.name : email;
          const ok = confirm(`Remove payment record for ${who} in this period?`);
          if (!ok) return;
          removePayment(email, _currentPeriodStart, state.tz);
          await render(state, false);
        }
      });
    }
  }

  /* ============================================================
     PLUGIN REGISTRATION
     ============================================================ */
  const plugin = {
    id: 'payroll',
    title: 'Payroll',
    iconClass: 'fas fa-money-check-alt'
  };
  let inited = false;
  Portal.registerPlugin(plugin);

  const origSwitch = Portal.switchView.bind(Portal);
  Portal.switchView = async function(id, btn){
    await origSwitch(id, btn);
    if (id === 'payroll'){
      ensureCss();
      ensureMarkup();
      const state = loadState();
      if (!inited){
        wireUi(state);
        inited = true;
      }
      await render(state, false);
    }
  };

  // Warm up on DOMContentLoaded (same pattern as earnings.js)
  document.addEventListener('DOMContentLoaded', async () => {
    ensureCss();
    ensureMarkup();
    const state = loadState();
    if (!inited){
      wireUi(state);
      inited = true;
    }
    // Light warm-up — no forced fetch
    await render(state, false);
  });
})();
