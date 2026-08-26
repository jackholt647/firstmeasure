/* portal_scripts/earnings.js
 * Employee Earnings plugin (self-contained):
 * - injects nav item
 * - injects view markup + CSS
 * - computes earnings from FirstMeasure projects/list (completed_at + points + collection speed)
 *
 * Complexity scale: 1–5
 *   1 = Very Simple    15 PHP
 *   2 = Simple          30 PHP
 *   3 = Standard        45 PHP   (legacy 'complex' maps here)
 *   4 = Complex         90 PHP
 *   5 = Very Complex   175 PHP   (legacy 'simple' maps to 1)
 *
 * QA Bonus: +10% on report rate if passes QA with zero corrections
 * Shift Pay: 940 PHP per completed shift (each day with ≥1 completion)
 *
 * Timezone toggle: PHT (UTC+8) vs PST (UTC-8, fixed, no DST)
 * Pay period: Semi-monthly
 *   1st – 15th  → paid on the 20th of the same month
 *   16th – last → paid on the 5th of the following month
 */
(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal.cfg;
  const trainingComplete =
    !!(cfg()?.user?.training_complete) ||
    !!(cfg()?.user?.trainingComplete) ||
    cfg()?.user?.training_complete === 'true';

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

  if (!trainingComplete) return;

  // ------------------------------------------------
  // Contract rates
  // ------------------------------------------------
  const SHIFT_PAY_DEFAULT = 940;
  const QA_BONUS_PCT = 0.10;
  const RUSH_BONUS_PERCENT = 25;

  function getShiftRate() {
      const u = cfg()?.user;
      if (u && typeof u.shift_rate === 'number' && u.shift_rate >= 0) return u.shift_rate;
      if (u && typeof u.shift_rate === 'string') {
          const n = parseInt(u.shift_rate, 10);
          if (!isNaN(n) && n >= 0) return n;
      }
      return SHIFT_PAY_DEFAULT;
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
   * Matches the PHP normalizeComplexity() function for consistency.
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
    if (!project || !project.rush_bonus_eligible || !project.rush_bonus_tag) return 0;
    const percent = Number(project.rush_bonus_percent ?? project.rush_bonus_amount ?? RUSH_BONUS_PERCENT);
    const safePercent = Number.isFinite(percent) && percent > 0 ? percent : RUSH_BONUS_PERCENT;
    return Math.round(Number(baseRate || 0) * (safePercent / 100));
  }

  function structureLabel(count) {
    return `${count} structure${count === 1 ? '' : 's'}`;
  }

  function projectTypeLabel(type) {
    if (type === 'multifamily') return 'Multi-Family';
    if (type === 'commercial') return 'Commercial';
    return 'Residential';
  }

  /**
   * Did this project pass QA on the first attempt (zero corrections)?
   * Checks multiple data sources for robustness.
   */
  function passedQaFirstTime(p) {
    // Explicit reject count if the backend provides it
    if (typeof p.qa_reject_count === 'number') return p.qa_reject_count === 0;
    // qa_history is an array of rejection events
    const hist = p.qa_history;
    if (Array.isArray(hist) && hist.length > 0) return false;
    // work_history fallback — look for any qa_rejected event
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

  const STORE_KEY = 'portal_earnings_v1';

  function loadState(){
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const s = raw ? JSON.parse(raw) : {};
      return {
        tz: (s.tz === 'PST' ? 'PST' : 'PHT'),
        mode: (s.mode === 'monthly' || s.mode === 'daily') ? s.mode : 'weekly',
        anchorMs: (typeof s.anchorMs === 'number' ? s.anchorMs : Date.now())
      };
    } catch(e){
      return { tz:'PHT', mode:'weekly', anchorMs: Date.now() };
    }
  }
  function saveState(st){
    try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch(e){}
  }

  function ensureCss(){
    if (document.getElementById('earnings-css')) return;
    const css = document.createElement('style');
    css.id = 'earnings-css';
    css.textContent = `
      /* Earnings plugin */
      .earn-wrap{ max-width:1100px; }
      .earn-top{ display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
      .earn-title{ display:flex; align-items:baseline; gap:10px; }
      .earn-title h1{ margin:0; font-size:22px; }
      .earn-sub{ color:#777; font-size:12px; font-weight:700; }
      .earn-chiprow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

      .earn-seg{
        display:inline-flex; gap:0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:#fff;
        box-shadow:0 2px 4px rgba(0,0,0,0.04);
      }
      .earn-seg button{
        border:none; background:transparent; padding:9px 12px; font-weight:900; font-size:12px; color:#666;
        cursor:pointer; display:flex; align-items:center; gap:8px;
      }
      .earn-seg button.active{ background: var(--primary-light); color: var(--primary); }
      .earn-seg button:not(.active):hover{ background:#f8f9fa; }

      .earn-tz{
        display:flex; align-items:center; gap:8px;
        background:#fff; border:1px solid var(--border); border-radius:10px; padding:8px 10px;
        box-shadow:0 2px 4px rgba(0,0,0,0.04);
      }
      .earn-tz .lbl{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.3px; }
      .earn-tz .tog{ display:flex; gap:6px; }
      .earn-tz .tog button{
        border:1px solid var(--border); background:#fff; padding:7px 10px; border-radius:10px;
        font-weight:900; font-size:12px; cursor:pointer; color:#555;
      }
      .earn-tz .tog button.active{
        border-color: var(--primary);
        color:#fff;
        background: var(--primary);
        box-shadow:0 2px 8px rgba(217,48,37,0.15);
      }

      .earn-cardgrid{ display:grid; grid-template-columns: 1.2fr 0.8fr; gap:14px; margin-bottom:14px; }
      @media (max-width: 980px){ .earn-cardgrid{ grid-template-columns: 1fr; } }

      .earn-card{
        background:#fff; border:1px solid var(--border); border-radius:12px;
        box-shadow:0 2px 6px rgba(0,0,0,0.05);
        overflow:hidden;
      }
      .earn-card .hd{
        padding:14px 16px;
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        border-bottom:1px solid #eee;
        background: linear-gradient(180deg, #fff, #fbfbfb);
      }
      .earn-card .hd .left{ display:flex; flex-direction:column; gap:4px; }
      .earn-kicker{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.4px; }
      .earn-big{ font-size:18px; font-weight:1000; color:#202124; }
      .earn-card .bd{ padding:14px 16px; }

      .earn-nav{
        display:flex; align-items:center; gap:8px;
      }
      .earn-nav button{
        border:1px solid var(--border); background:#fff; border-radius:10px; width:38px; height:34px;
        cursor:pointer; font-weight:900; color:#444;
      }
      .earn-nav button:hover{ background:#f8f9fa; }
      .earn-range{
        font-weight:1000; font-size:12px; color:#555;
        background:#f8f9fa; border:1px solid #eee; padding:7px 10px; border-radius:999px;
        white-space:nowrap;
      }

      .earn-metrics{
        display:grid; grid-template-columns: repeat(2, 1fr); gap:10px;
      }
      .earn-metric{
        border:1px solid #eee; border-radius:12px; padding:10px 12px; background:#fff;
        display:flex; flex-direction:column; gap:4px;
      }
      .earn-metric.wide{ grid-column: 1 / -1; }
      .earn-metric .k{ font-size:11px; font-weight:900; color:#777; text-transform:uppercase; letter-spacing:0.35px; }
      .earn-metric .v{ font-size:18px; font-weight:1000; color:#202124; }
      .earn-metric .s{ font-size:11px; font-weight:800; color:#666; }

      .earn-breakdown{
        display:grid; grid-template-columns: 1fr auto; gap:2px 12px;
        font-size:12px; line-height:1.7;
      }
      .earn-breakdown .lbl{ font-weight:800; color:#555; }
      .earn-breakdown .val{ font-weight:900; color:#202124; text-align:right; }
      .earn-breakdown .sep{
        grid-column:1/-1;
        border-top:1px solid #eee;
        margin:3px 0;
      }

      .earn-table{
        width:100%; border-collapse:collapse; overflow:hidden;
        border:1px solid #eee; border-radius:12px;
      }
      .earn-table th{
        background:#f8f9fa; font-size:11px; font-weight:900; color:#666; text-transform:uppercase; letter-spacing:0.4px;
        padding:10px 12px; border-bottom:1px solid #eee;
      }
      .earn-table td{
        padding:10px 12px; border-bottom:1px solid #f0f0f0; font-size:13px;
      }
      .earn-table tr:hover td{ background:#fafafa; }
      .earn-right{ text-align:right; }
      .earn-muted{ color:#777; font-weight:700; font-size:12px; }

      .earn-pill{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px; border-radius:999px;
        border:1px solid #eee; background:#fff;
        font-weight:900; font-size:12px; color:#555;
      }
      .earn-dot{ width:9px; height:9px; border-radius:50%; flex-shrink:0; }
      .earn-bonus-badge{
        display:inline-flex; align-items:center; gap:4px;
        padding:2px 7px; border-radius:999px;
        background:#e6f4ea; color:#137333; font-weight:900; font-size:10px;
        border:1px solid #ceead6;
      }
      .earn-footnote{ margin-top:10px; font-size:12px; color:#777; line-height:1.45; }

      .earn-empty{
        padding:18px; border:1px dashed #ddd; border-radius:12px; background:#fff;
        color:#777; font-weight:800;
      }

      .earn-rate-legend{
        display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;
      }
    `;
    document.head.appendChild(css);
  }

  /** Build a small colored pill for a complexity rating */
  function complexityPill(rating, small) {
    const tier = tierFor(rating);
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="earn-pill" style="${pad}"><span class="earn-dot" style="background:${tier.color}"></span> ${tier.label}</span>`;
  }


  function structurePill(count, type, small) {
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="earn-pill" style="${pad}"><i class="fas fa-building" style="color:#1a73e8"></i> ${structureLabel(count)}${type ? ` - ${projectTypeLabel(type)}` : ''}</span>`;
  }

  function payoutBasisHtml(item) {
    if (item.isStructurePaid) return structurePill(item.structureCount, item.projectType, true);
    return complexityPill(item.rating, true);
  }

  /** Build the rate legend for the footnote */
  function rateLegendHtml() {
    const bandPills = SPEED_RATE_BANDS.map((t) =>
      `<span class="earn-pill" style="padding:3px 8px;"><span class="earn-dot" style="background:${t.color}"></span> ${t.label}: <b>${t.rate} PHP/pt</b></span>`
    ).join(' ');
    return bandPills
      + ` <span class="earn-pill" style="padding:3px 8px;"><i class="fas fa-stopwatch" style="color:#1a73e8"></i> Faster collection time earns a higher per-point rate</span>`;
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host) return;

    if (document.getElementById('view-earnings')) return;

    const wrap = document.createElement('div');
    wrap.id = 'view-earnings';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="earn-wrap">
        <div class="earn-top">
          <div class="earn-title">
            <h1>Earnings</h1>
            <div class="earn-sub" id="earnSub">Based on QA-approved completions</div>
          </div>

          <div class="earn-chiprow">
            <div class="earn-seg" role="tablist" aria-label="Earnings view mode">
              <button id="earnModeWeekly"  type="button"><i class="fas fa-calendar-week"></i> Pay Period</button>
              <button id="earnModeMonthly" type="button"><i class="fas fa-calendar-alt"></i> Monthly</button>
              <button id="earnModeDaily"   type="button"><i class="fas fa-calendar-day"></i> Daily</button>
            </div>

            <div class="earn-tz">
              <div class="lbl">Timezone</div>
              <div class="tog">
                <button id="earnTzPHT" type="button">PHT</button>
                <button id="earnTzPST" type="button">PST</button>
              </div>
            </div>

            <button class="btn-secondary" id="earnRefreshBtn" type="button"><i class="fas fa-sync"></i> Refresh</button>
          </div>
        </div>

        <div class="earn-cardgrid">
          <div class="earn-card">
            <div class="hd">
              <div class="left">
                <div class="earn-kicker" id="earnPeriodKicker">This pay period</div>
                <div class="earn-big" id="earnPeriodTitle">—</div>
              </div>
              <div class="earn-nav">
                <button id="earnPrevBtn" type="button" title="Previous"><i class="fas fa-chevron-left"></i></button>
                <div class="earn-range" id="earnRangePill">—</div>
                <button id="earnNextBtn" type="button" title="Next"><i class="fas fa-chevron-right"></i></button>
              </div>
            </div>
            <div class="bd">
              <div id="earnMain"></div>
            </div>
          </div>

          <div class="earn-card">
            <div class="hd">
              <div class="left">
                <div class="earn-kicker">Summary</div>
                <div class="earn-big" id="earnSummaryTitle">—</div>
              </div>
              <div class="earn-pill" title="Payout date for this pay period">
                <span class="earn-dot" style="background:#34a853"></span>
                <span>Paid: <span id="earnPaidOn">—</span></span>
              </div>
            </div>
            <div class="bd">
              <div class="earn-metrics">
                <div class="earn-metric">
                  <div class="k">Project Pay</div>
                  <div class="v" id="earnReportPay">—</div>
                  <div class="s" id="earnCounts">—</div>
                </div>
                <div class="earn-metric">
                  <div class="k">Points</div>
                  <div class="v" id="earnBonusPay">—</div>
                  <div class="s" id="earnBonusCounts">—</div>
                </div>
                <div class="earn-metric">
                  <div class="k">Avg Collection</div>
                  <div class="v" id="earnShiftPay">—</div>
                  <div class="s" id="earnShiftDays">—</div>
                </div>
                <div class="earn-metric">
                  <div class="k">Total Earnings</div>
                  <div class="v" id="earnTotal">—</div>
                  <div class="s" id="earnAvgPerDay">—</div>
                </div>
              </div>

              <div style="margin-top:12px;" id="earnBreakdownHost"></div>

              <div class="earn-footnote">
                <div>Legend</div>
                <div class="earn-rate-legend" id="earnRateLegend"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="earn-card">
          <div class="hd">
            <div class="left">
              <div class="earn-kicker">Recent QA-approved items (in this period)</div>
              <div class="earn-big">Completions</div>
            </div>
            <div class="earn-muted" id="earnListMeta">—</div>
          </div>
          <div class="bd" id="earnListHost"></div>
        </div>
      </div>
    `;
    host.appendChild(wrap);
  }

  // ---------- Time helpers (fixed offsets; avoid browser timezone) ----------

  function parseSqlAsUtcMs(s){
    if (!s || typeof s !== 'string') return 0;
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : 0;
    }
    const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5], ss = +m[6];
    return Date.UTC(y, mo-1, d, hh, mm, ss);
  }

  function toLocalViewMs(utcMs, offsetHours){
    return utcMs + offsetHours * 3600 * 1000;
  }

  function ymdFromLocalViewMs(localMs){
    const dt = new Date(localMs);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  function niceDateFromLocalViewMs(localMs){
    const dt = new Date(localMs);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
    return `${mo} ${d}, ${y}`;
  }

  function localMidnightMs(localMs){
    const dt = new Date(localMs);
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0,0,0);
  }

  function startOfMonth(localMs){
    const dt = new Date(localMs);
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1, 0,0,0);
  }

  function addDays(ms, days){ return ms + days * 86400000; }

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
      // First-half period → paid on 20th of same month
      return Date.UTC(y, m, 20, 0, 0, 0);
    } else {
      // Second-half period → paid on 5th of following month
      return Date.UTC(y, m + 1, 5, 0, 0, 0);
    }
  }

  function fmtPhp(n){
    const x = Math.round(n || 0);
    return `${x.toLocaleString()} PHP`;
  }
    // ---------- Shift-role helpers (resolve schedule client-side) ----------

  let cachedSchedule = null;
  let cachedScheduleAt = 0;

  async function fetchMyShiftSchedule() {
    try {
      const res = await Portal.apiPost(cfg().endpoints.server, {
        action: 'shift_get_my_schedule'
      });
      return (res && res.success) ? (res.schedule || {}) : {};
    } catch (e) {
      console.warn('Failed to fetch shift schedule', e);
      return {};
    }
  }

  /**
   * Resolve shift blocks for a given YYYY-MM-DD, mirroring the PHP
   * shiftResolveBlocksInline() logic.
   */
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

  /**
   * Scan every day in the period and collect non-technician shift roles.
   * Returns a Set of role strings (e.g. {'qa','manager'}).
   */
  function periodNonTechShiftRoles(schedule, per) {
    const roles = new Set();
    const days = Math.max(1, Math.round((per.end - per.start) / 86400000));
    for (let i = 0; i < days; i++) {
      const ymd = ymdFromLocalViewMs(addDays(per.start, i));
      const blocks = resolveShiftBlocksForDate(schedule, ymd);
      for (const b of blocks) {
        const role = (b.role || 'technician').toLowerCase();
        if (role !== 'technician') roles.add(role);
      }
    }
    return roles;
  }

  /**
   * Build the contextual note about non-tech shift pay.
   * Returns empty string when there are no non-tech shifts in the period.
   */
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

  // ---------- Data + compute ----------

  /**
   * Fetch ALL of the current user's projects.
   *
   * We pass limit:0 explicitly so the backend skips pagination and returns
   * every project.  Without this, earnings totals could silently under-count.
   */
  async function fetchMyProjects(){
    const res = await fmPost('projects/list', { filter: 'mine', limit: 0, include_history: true });
    return Array.isArray(res.projects) ? res.projects : [];
  }

  function isEarnable(p){
    if (!p) return false;
    if ((String(p.status || '')).toLowerCase() !== 'completed') return false;
    if (!p.completed_at) return false;

    const me = String((cfg().user && cfg().user.email) || '').trim().toLowerCase();

    const payTech = projectPayTechnician(p);
    if (payTech.email) return payTech.email === me;

    const qaEmails = new Set([
      p.qa_claimed_by_email, p.qa_approved_by_email, p.qa_approved_by,
      p.qa_reviewed_by_email, p.qa_reviewed_by, p.workflow?.qa_claim?.email
    ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean));
    const assigned = String(p.assigned_to_email || '').trim().toLowerCase();
    const owner = String(p.owner || '').trim().toLowerCase();
    if (assigned && qaEmails.has(assigned)) return false;
    if (owner && qaEmails.has(owner)) return false;
    return (assigned && assigned === me) || (!assigned && owner === me) || (owner === me);
  }

  function buildEarnedItems(projects, tzKey){
    const tz = (tzKey === 'PST') ? TZ.PST : TZ.PHT;
    const out = [];
    for (const p of projects){
      if (!isEarnable(p)) continue;
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

      out.push({
        id: p.id,
        address: p.address || '',
        points,
        elapsedMs,
        band,
        bandIndex,
        baseRate,
        rushBonus,
        earnedPhp: baseRate + rushBonus,
        payTechnicianName: payTech.name || payTech.email || '',
        payTechnicianEmail: payTech.email || '',
        payBasis: payTech.basis || '',
        hasTiming: Number.isFinite(elapsedMs) && elapsedMs > 0,
        utcMs,
        localMs,
        ymd: ymdFromLocalViewMs(localMs),
        niceDate: niceDateFromLocalViewMs(localMs)
      });
    }
    out.sort((a,b) => b.localMs - a.localMs);
    return out;
  }

  /**
   * Determine the period boundaries for a given anchor and mode.
   *
   * 'weekly' mode → semi-monthly pay period:
   *    1st–15th  or  16th–last day of the month
   * 'monthly' mode → full calendar month
   * 'daily' mode   → single day
   */
  function periodForMode(anchorLocalMs, mode){
    if (mode === 'monthly') {
      const start = startOfMonth(anchorLocalMs);
      const dt = new Date(start);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth();
      const end = Date.UTC(y, m+1, 1, 0,0,0);
      return { start, end, label:'This month' };
    }
    if (mode === 'daily') {
      const start = localMidnightMs(anchorLocalMs);
      const end = addDays(start, 1);
      return { start, end, label:'Today' };
    }
    // 'weekly' mode → semi-monthly pay period
    const dt = new Date(anchorLocalMs);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    if (d <= 15) {
      const start = Date.UTC(y, m, 1, 0, 0, 0);
      const end   = Date.UTC(y, m, 16, 0, 0, 0); // exclusive: 16th 00:00
      return { start, end, label:'This pay period' };
    } else {
      const start = Date.UTC(y, m, 16, 0, 0, 0);
      const end   = Date.UTC(y, m + 1, 1, 0, 0, 0); // exclusive: 1st of next month
      return { start, end, label:'This pay period' };
    }
  }

  /**
   * Shift the anchor to the previous or next period.
   * For semi-monthly pay periods, alternate between 1st-half and 2nd-half.
   */
  function shiftAnchor(state, dir){
    const tz = (state.tz === 'PST') ? TZ.PST : TZ.PHT;
    const anchorLocal = toLocalViewMs(state.anchorMs, tz.offsetHours);
    const per = periodForMode(anchorLocal, state.mode);

    if (state.mode === 'weekly') {
      // Semi-monthly navigation
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
      state.anchorMs = newLocalMid - tz.offsetHours * 3600 * 1000;
    } else {
      // Monthly / daily: shift by span
      const span = per.end - per.start;
      const newStart = per.start + dir * span;
      const mid = newStart + Math.floor(span / 2);
      state.anchorMs = mid - tz.offsetHours * 3600 * 1000;
    }
  }

  function within(ms, start, end){ return ms >= start && ms < end; }

  function summarize(itemsInPeriod, per, shiftSchedule) {
    let projectPay = 0;
    let totalPoints = 0;
    let totalElapsedMs = 0;
    let timedCount = 0;
    let rushBonusPay = 0;
    let rushBonusCount = 0;
    const bandCounts = SPEED_RATE_BANDS.map(() => 0);
    const bandPoints = SPEED_RATE_BANDS.map(() => 0);
    const bandPay = SPEED_RATE_BANDS.map(() => 0);
    const dayMap = new Map();

    for (const it of itemsInPeriod){
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

      const k = it.ymd;
      const cur = dayMap.get(k) || {
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
      dayMap.set(k, cur);
    }

    const days = Math.max(1, Math.round((per.end - per.start) / 86400000));

    let workedDays = 0;
    for (const [ymd, v] of dayMap.entries()) {
      if (v.projectPay > 0) {
        workedDays++;
      }
    }

    // Scan the full period for non-technician shift roles (for the note)
    const nonTechRoles = periodNonTechShiftRoles(shiftSchedule, per);

    const totalCount = itemsInPeriod.length;
    const grandTotal = projectPay + rushBonusPay;
    const avgElapsedMs = timedCount ? totalElapsedMs / timedCount : null;

    return {
      projectPay, rushBonusPay, rushBonusCount, totalPoints, totalElapsedMs, timedCount, avgElapsedMs,
      bandCounts, bandPoints, bandPay, dayMap, days, workedDays,
      nonTechRoles,
      totalCount, grandTotal
    };
  }


  function tierCountsSummaryClean(tierCounts) {
    return Object.entries(tierCounts)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => {
        const tier = COMPLEXITY_TIERS[r];
        return `${n} ${tier ? tier.label : 'L'+r}`;
      })
      .join(' | ');
  }

  function payoutCountsSummaryClean(sum) {
    const parts = [];
    const tierSummary = tierCountsSummaryClean(sum.tierCounts || {});
    if (tierSummary) parts.push(tierSummary);
    if (sum.structureUnitCount > 0) {
      const projText = `${sum.structureProjectCount} project${sum.structureProjectCount === 1 ? '' : 's'}`;
      parts.push(`${structureLabel(sum.structureUnitCount)} across ${projText}`);
    }
    return parts.join(' | ');
  }

  function tierTableHeaders() {
    return Object.entries(COMPLEXITY_TIERS).map(([r, t]) =>
      `<th class="earn-right" title="${t.label} (${t.rate} PHP)" style="color:${t.color}; font-weight:1000;">L${r}</th>`
    ).join('');
  }

  function tierTableCells(tierCounts) {
    return Object.keys(COMPLEXITY_TIERS).map(r => {
      const n = tierCounts[r] || 0;
      return `<td class="earn-right">${n || '<span style="color:#ddd">\u2013</span>'}</td>`;
    }).join('');
  }

  function weekdayNameFromYmd(ymd){
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(Date.UTC(y, mo-1, d, 0,0,0));
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()];
  }

  // ---------- Renderers ----------

  /**
   * Render the semi-monthly pay period table (replaces old weekly renderer).
   * Iterates every day in the period (up to 16 days).
   */
  function renderWeeklyMain(per, sum, shiftSchedule){
    const shiftRate = sum.shiftRate || getShiftRate();
    const numDays = Math.round((per.end - per.start) / 86400000);
    const rows = [];
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(per.start, i);
      const ymd = ymdFromLocalViewMs(dayMs);
      const nice = niceDateFromLocalViewMs(dayMs);
      const w = weekdayNameFromYmd(ymd);
      const v = sum.dayMap.get(ymd) || {
        reportPay:0, bonusPay:0, bonusCount:0,
        structurePay:0, structureProjectCount:0, structureUnitCount:0,
        tierCounts:{ 1:0, 2:0, 3:0, 4:0, 5:0 }
      };
      const hasWork = v.reportPay > 0;
      const isTechDay = hasWork && dayHasTechnicianShift(shiftSchedule, ymd);
      const dayShiftPay = isTechDay ? shiftRate : 0;
      const dayTotal = v.reportPay + v.bonusPay + dayShiftPay;
      rows.push({ ymd, w, nice, dayTotal, hasWork, isTechDay, dayShiftPay, ...v });
    }

    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Date</th>
            <th class="earn-right">Total</th>
            ${tierTableHeaders()}
            <th class="earn-right" title="Structure-paid work">Structures</th>
            <th class="earn-right" title="QA first-pass bonus">Bonus</th>
            <th class="earn-right" title="Technician shift pay (${shiftRate} PHP)">Shift</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><b>${r.w}</b></td>
              <td>${r.nice}</td>
              <td class="earn-right"><b>${fmtPhp(r.dayTotal)}</b></td>
              ${tierTableCells(r.tierCounts)}
              <td class="earn-right">${r.structureUnitCount > 0 ? `<b>${r.structureUnitCount}</b>` : '<span style="color:#ddd">\u2013</span>'}</td>
              <td class="earn-right">${r.bonusPay > 0 ? `<span class="earn-bonus-badge">+${fmtPhp(r.bonusPay)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>
              <td class="earn-right">${r.isTechDay ? fmtPhp(shiftRate) : '<span style="color:#ddd">\u2013</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderMonthlyMain(per, sum, shiftSchedule){
    const shiftRate = sum.shiftRate || getShiftRate();
    const days = Array.from(sum.dayMap.entries())
      .map(([ymd,v]) => {
        const hasWork = v.reportPay > 0;
        const isTechDay = hasWork && dayHasTechnicianShift(shiftSchedule, ymd);
        const dayShiftPay = isTechDay ? shiftRate : 0;
        return {
          ymd,
          nice: niceDateFromLocalViewMs(Date.UTC(+ymd.slice(0,4), +ymd.slice(5,7)-1, +ymd.slice(8,10))),
          dayTotal: v.reportPay + v.bonusPay + dayShiftPay,
          isTechDay,
          dayShiftPay,
          ...v
        };
      })
      .sort((a,b) => a.ymd.localeCompare(b.ymd));

    if (!days.length){
      return `<div class="earn-empty">No QA-approved completions in this month.</div>`
        + nonTechPayNote(sum.nonTechRoles);
    }

    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="earn-right">Total</th>
            ${tierTableHeaders()}
            <th class="earn-right">Structures</th>
            <th class="earn-right">Bonus</th>
            <th class="earn-right">Shift</th>
          </tr>
        </thead>
        <tbody>
          ${days.map(d => `
            <tr>
              <td><b>${d.nice}</b></td>
              <td class="earn-right"><b>${fmtPhp(d.dayTotal)}</b></td>
              ${tierTableCells(d.tierCounts)}
              <td class="earn-right">${d.structureUnitCount > 0 ? `<b>${d.structureUnitCount}</b>` : '<span style="color:#ddd">\u2013</span>'}</td>
              <td class="earn-right">${d.bonusPay > 0 ? `<span class="earn-bonus-badge">+${fmtPhp(d.bonusPay)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>
              <td class="earn-right">${d.isTechDay ? fmtPhp(shiftRate) : '<span style="color:#ddd">\u2013</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderDailyMain(per, sum, shiftSchedule){
    const shiftRate = sum.shiftRate || getShiftRate();
    if (sum.totalCount <= 0){
      return `<div class="earn-empty">No QA-approved completions on this day.</div>`
        + nonTechPayNote(sum.nonTechRoles);
    }
    const pills = Object.entries(sum.tierCounts)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => {
        const t = COMPLEXITY_TIERS[r];
        return `<span class="earn-pill"><span class="earn-dot" style="background:${t.color}"></span> ${t.label}: <b>${n}</b></span>`;
      })
      .join(' ');
    const structurePills = sum.structureUnitCount > 0
      ? structurePill(sum.structureUnitCount, null, false)
      : '';

    return `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
        ${pills}
        ${structurePills}
      </div>
      <div class="earn-breakdown" style="max-width:280px;">
        <span class="lbl">Report pay</span><span class="val">${fmtPhp(sum.reportPay)}</span>
        ${sum.bonusPay > 0 ? `<span class="lbl">QA bonus (${sum.bonusCount} first-pass)</span><span class="val"><span class="earn-bonus-badge">+${fmtPhp(sum.bonusPay)}</span></span>` : ''}
        ${sum.shiftPay > 0 ? `<span class="lbl">Technician shift pay</span><span class="val">${fmtPhp(sum.shiftPay)}</span>` : ''}
        <div class="sep"></div>
        <span class="lbl"><b>Day total</b></span><span class="val"><b>${fmtPhp(sum.grandTotal)}</b></span>
      </div>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderList(items){
    if (!items.length){
      return `<div class="earn-empty">Nothing in this period.</div>`;
    }
    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Project</th>
            <th>Payout Basis</th>
            <th class="earn-right">Base</th>
            <th class="earn-right">QA Bonus</th>
            <th class="earn-right">Total</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td><b>${it.niceDate}</b></td>
              <td>${Portal.escapeHtml(it.address || it.id)}</td>
              <td>${payoutBasisHtml(it)}</td>
              <td class="earn-right">${fmtPhp(it.baseRate)}</td>
              <td class="earn-right">${it.bonus > 0 ? `<span class="earn-bonus-badge">+${fmtPhp(it.bonus)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>
              <td class="earn-right"><b>${fmtPhp(it.earnedPhp)}</b></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderBreakdown(sum) {
    const shiftRate = sum.shiftRate || getShiftRate();
    const tierLines = Object.entries(COMPLEXITY_TIERS)
      .filter(([r]) => (sum.tierCounts[r] || 0) > 0)
      .map(([r, t]) => {
        const n = sum.tierCounts[r];
        return `<span class="lbl">${n} \u00d7 ${t.label} (${t.rate} PHP)</span><span class="val">${fmtPhp(n * t.rate)}</span>`;
      }).join('');
    const structureLine = sum.structureUnitCount > 0
      ? `<span class="lbl">${structureLabel(sum.structureUnitCount)} across ${sum.structureProjectCount} multi-structure project(s)</span><span class="val">${fmtPhp(sum.structurePay)}</span>`
      : '';

    return `
      <div class="earn-breakdown">
        ${tierLines}
        ${structureLine}
        ${sum.bonusPay > 0 ? `<span class="lbl">QA bonus (${sum.bonusCount} \u00d7 10%)</span><span class="val"><span class="earn-bonus-badge">+${fmtPhp(sum.bonusPay)}</span></span>` : ''}
        ${sum.techShiftDays > 0 ? `<span class="lbl">${sum.techShiftDays} technician shift(s) \u00d7 ${shiftRate} PHP</span><span class="val">${fmtPhp(sum.shiftPay)}</span>` : ''}
        <div class="sep"></div>
        <span class="lbl"><b>Grand total</b></span><span class="val"><b>${fmtPhp(sum.grandTotal)}</b></span>
      </div>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function speedBandPill(band, small) {
    const pad = small ? 'padding:3px 8px;' : '';
    return `<span class="earn-pill" style="${pad}"><span class="earn-dot" style="background:${band.color}"></span> ${band.label}</span>`;
  }

  function bandTableHeaders() {
    return SPEED_RATE_BANDS.map(b =>
      `<th class="earn-right" title="${b.label} (${b.rate} PHP/pt)" style="color:${b.color}; font-weight:1000;">${b.rate}/pt</th>`
    ).join('');
  }

  function bandTableCells(bandCounts) {
    return SPEED_RATE_BANDS.map((b, idx) => {
      const n = (bandCounts && bandCounts[idx]) || 0;
      return `<td class="earn-right">${n || '<span style="color:#ddd">-</span>'}</td>`;
    }).join('');
  }

  function payoutCountsSummaryClean(sum) {
    if (!sum || !sum.totalCount) return 'No completions';
    return `${sum.totalCount} project(s) | ${fmtPoints(sum.totalPoints)} pts`;
  }

  function speedCountsSummary(sum) {
    const parts = SPEED_RATE_BANDS
      .map((b, idx) => ((sum.bandCounts && sum.bandCounts[idx]) || 0) > 0 ? `${sum.bandCounts[idx]} ${b.label}` : '')
      .filter(Boolean);
    return parts.join(' | ') || 'No timed projects';
  }

  function renderWeeklyMain(per, sum, shiftSchedule){
    const numDays = Math.round((per.end - per.start) / 86400000);
    const rows = [];
    for (let i = 0; i < numDays; i++){
      const dayMs = addDays(per.start, i);
      const ymd = ymdFromLocalViewMs(dayMs);
      const nice = niceDateFromLocalViewMs(dayMs);
      const w = weekdayNameFromYmd(ymd);
      const v = sum.dayMap.get(ymd) || {
        projectPay:0, totalPoints:0, totalElapsedMs:0, timedCount:0,
        bandCounts:SPEED_RATE_BANDS.map(() => 0)
      };
      rows.push({
        ymd, w, nice,
        dayTotal: v.projectPay,
        avgElapsedMs: v.timedCount ? v.totalElapsedMs / v.timedCount : null,
        ...v
      });
    }

    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Date</th>
            <th class="earn-right">Total</th>
            <th class="earn-right">Projects</th>
            <th class="earn-right">Points</th>
            <th class="earn-right">Avg Time</th>
            ${bandTableHeaders()}
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><b>${r.w}</b></td>
              <td>${r.nice}</td>
              <td class="earn-right"><b>${fmtPhp(r.dayTotal)}</b></td>
              <td class="earn-right">${r.projectPay > 0 ? r.bandCounts.reduce((s,n) => s + n, 0) : '<span style="color:#ddd">-</span>'}</td>
              <td class="earn-right">${r.totalPoints > 0 ? fmtPoints(r.totalPoints) : '<span style="color:#ddd">-</span>'}</td>
              <td class="earn-right">${r.avgElapsedMs ? fmtDuration(r.avgElapsedMs) : '<span style="color:#ddd">-</span>'}</td>
              ${bandTableCells(r.bandCounts)}
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderMonthlyMain(per, sum, shiftSchedule){
    const days = Array.from(sum.dayMap.entries())
      .map(([ymd,v]) => ({
        ymd,
        nice: niceDateFromLocalViewMs(Date.UTC(+ymd.slice(0,4), +ymd.slice(5,7)-1, +ymd.slice(8,10))),
        dayTotal: v.projectPay,
        avgElapsedMs: v.timedCount ? v.totalElapsedMs / v.timedCount : null,
        ...v
      }))
      .sort((a,b) => a.ymd.localeCompare(b.ymd));

    if (!days.length){
      return `<div class="earn-empty">No completed project payouts in this month.</div>` + nonTechPayNote(sum.nonTechRoles);
    }

    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="earn-right">Total</th>
            <th class="earn-right">Projects</th>
            <th class="earn-right">Points</th>
            <th class="earn-right">Avg Time</th>
            ${bandTableHeaders()}
          </tr>
        </thead>
        <tbody>
          ${days.map(d => `
            <tr>
              <td><b>${d.nice}</b></td>
              <td class="earn-right"><b>${fmtPhp(d.dayTotal)}</b></td>
              <td class="earn-right">${d.bandCounts.reduce((s,n) => s + n, 0)}</td>
              <td class="earn-right">${fmtPoints(d.totalPoints)}</td>
              <td class="earn-right">${d.avgElapsedMs ? fmtDuration(d.avgElapsedMs) : '<span style="color:#ddd">-</span>'}</td>
              ${bandTableCells(d.bandCounts)}
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderDailyMain(per, sum, shiftSchedule){
    if (sum.totalCount <= 0){
      return `<div class="earn-empty">No completed project payouts on this day.</div>` + nonTechPayNote(sum.nonTechRoles);
    }
    const pills = SPEED_RATE_BANDS
      .map((b, idx) => (sum.bandCounts[idx] || 0) > 0 ? `<span class="earn-pill"><span class="earn-dot" style="background:${b.color}"></span> ${b.label}: <b>${sum.bandCounts[idx]}</b></span>` : '')
      .join(' ');

    return `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">${pills}</div>
      <div class="earn-breakdown" style="max-width:320px;">
        <span class="lbl">Project pay</span><span class="val">${fmtPhp(sum.projectPay)}</span>
        <span class="lbl">Points</span><span class="val">${fmtPoints(sum.totalPoints)}</span>
        <span class="lbl">Avg collection</span><span class="val">${sum.avgElapsedMs ? fmtDuration(sum.avgElapsedMs) : '--'}</span>
        <div class="sep"></div>
        <span class="lbl"><b>Day total</b></span><span class="val"><b>${fmtPhp(sum.grandTotal)}</b></span>
      </div>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function renderList(items){
    if (!items.length){
      return `<div class="earn-empty">Nothing in this period.</div>`;
    }
    const showRush = items.some(it => Number(it.rushBonus || 0) > 0);
    return `
      <table class="earn-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Project</th>
            <th>Speed</th>
            <th class="earn-right">Points</th>
            <th class="earn-right">Time</th>
            <th class="earn-right">Rate</th>
            ${showRush ? '<th class="earn-right">Rush</th>' : ''}
            <th class="earn-right">Total</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td><b>${it.niceDate}</b></td>
              <td>
                <div>${Portal.escapeHtml(it.address || it.id)}</div>
                ${it.payTechnicianName ? `<div class="earn-muted">Technician pay: ${Portal.escapeHtml(it.payTechnicianName)}${it.payBasis ? ` (${Portal.escapeHtml(String(it.payBasis).replace(/_/g, ' '))})` : ''}</div>` : ''}
              </td>
              <td>${speedBandPill(it.band, true)}</td>
              <td class="earn-right">${it.points ? fmtPoints(it.points) : '<span style="color:#d93025">Missing</span>'}</td>
              <td class="earn-right">${it.hasTiming ? fmtDuration(it.elapsedMs) : '<span style="color:#777">No timer</span>'}</td>
              <td class="earn-right">${it.band.rate} PHP/pt</td>
              ${showRush ? `<td class="earn-right">${it.rushBonus > 0 ? `<span class="earn-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(it.rushBonus)}</span>` : '<span style="color:#ddd">\u2013</span>'}</td>` : ''}
              <td class="earn-right"><b>${fmtPhp(it.earnedPhp)}</b></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderBreakdown(sum) {
    const bandLines = SPEED_RATE_BANDS.map((b, idx) => {
      const count = (sum.bandCounts && sum.bandCounts[idx]) || 0;
      if (!count) return '';
      const points = (sum.bandPoints && sum.bandPoints[idx]) || 0;
      const pay = (sum.bandPay && sum.bandPay[idx]) || 0;
      return `<span class="lbl">${count} ${b.label} project(s) | ${fmtPoints(points)} pts @ ${b.rate}/pt</span><span class="val">${fmtPhp(pay)}</span>`;
    }).join('');

    return `
      <div class="earn-breakdown">
        ${bandLines}
        ${sum.rushBonusPay > 0 ? `<span class="lbl" style="color:#9a3412;">Rush Mode Bonus (${sum.rushBonusCount} project${sum.rushBonusCount === 1 ? '' : 's'})</span><span class="val"><span class="earn-bonus-badge" style="background:#ffedd5;color:#9a3412;border-color:#fdba74;">+${fmtPhp(sum.rushBonusPay)}</span></span>` : ''}
        <div class="sep"></div>
        <span class="lbl"><b>Grand total</b></span><span class="val"><b>${fmtPhp(sum.grandTotal)}</b></span>
      </div>
      ${nonTechPayNote(sum.nonTechRoles)}
    `;
  }

  function setActive(el, yes){ if (el) el.classList.toggle('active', !!yes); }

  function updateModeButtons(state){
    setActive(document.getElementById('earnModeWeekly'), state.mode === 'weekly');
    setActive(document.getElementById('earnModeMonthly'), state.mode === 'monthly');
    setActive(document.getElementById('earnModeDaily'), state.mode === 'daily');
  }

  function updateTzButtons(state){
    setActive(document.getElementById('earnTzPHT'), state.tz === 'PHT');
    setActive(document.getElementById('earnTzPST'), state.tz === 'PST');
  }

  function periodTitles(per, mode){
    if (mode === 'weekly'){
      const startNice = niceDateFromLocalViewMs(per.start);
      const endNice = niceDateFromLocalViewMs(addDays(per.end, -1));
      return {
        kicker: 'Pay period (semi-monthly)',
        title: `${startNice} \u2013 ${endNice}`,
        pill: `${startNice} \u2192 ${endNice}`
      };
    }
    if (mode === 'monthly'){
      const dt = new Date(per.start);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth();
      const mo = ['January','February','March','April','May','June','July','August','September','October','November','December'][m];
      return { kicker: 'Month view', title: `${mo} ${y}`, pill: `${mo} ${y}` };
    }
    const nice = niceDateFromLocalViewMs(per.start);
    return { kicker: 'Day view', title: nice, pill: nice };
  }

  // ---------- Main controller ----------

  let cachedProjects = null;
  let cachedAt = 0;

  async function render(state, forceFetch=false){
    ensureCss();
    ensureMarkup();

    updateModeButtons(state);
    updateTzButtons(state);

    const tz = (state.tz === 'PST') ? TZ.PST : TZ.PHT;
    const anchorLocalMs = toLocalViewMs(state.anchorMs, tz.offsetHours);
    const per = periodForMode(anchorLocalMs, state.mode);

    const now = Date.now();
    if (forceFetch || !cachedProjects || (now - cachedAt) > 30000){
      cachedProjects = await fetchMyProjects();
      cachedAt = now;
    }
    if (forceFetch || !cachedSchedule || (now - cachedScheduleAt) > 30000){
      cachedSchedule = await fetchMyShiftSchedule();
      cachedScheduleAt = now;
    }

    const earned = buildEarnedItems(cachedProjects, state.tz);
    const inPeriod = earned.filter(it => within(it.localMs, per.start, per.end));
    inPeriod.sort((a,b) => b.localMs - a.localMs);

    const sum = summarize(inPeriod, per, cachedSchedule);
    const titles = periodTitles(per, state.mode);

    const kickerEl = document.getElementById('earnPeriodKicker');
    const titleEl  = document.getElementById('earnPeriodTitle');
    const pillEl   = document.getElementById('earnRangePill');
    if (kickerEl) kickerEl.textContent = titles.kicker;
    if (titleEl)  titleEl.textContent  = titles.title;
    if (pillEl)   pillEl.textContent   = titles.pill;

    // Payout date — compute from the current period start
    const payoutMs = payoutDateForPeriod(per.start);
    const paidEl = document.getElementById('earnPaidOn');
    if (paidEl) paidEl.textContent = niceDateFromLocalViewMs(payoutMs);

    const sumTitle = document.getElementById('earnSummaryTitle');
    if (sumTitle) sumTitle.textContent = (state.mode === 'weekly') ? 'This paycheck' : 'At a glance';

    // Summary metrics
    const el = id => document.getElementById(id);

    const reportPayEl = el('earnReportPay');
    const countsEl    = el('earnCounts');
    const bonusPayEl  = el('earnBonusPay');
    const bonusCntEl  = el('earnBonusCounts');
    const shiftPayEl  = el('earnShiftPay');
    const shiftDaysEl = el('earnShiftDays');
    const totalEl     = el('earnTotal');
    const avgEl       = el('earnAvgPerDay');

    if (reportPayEl) reportPayEl.textContent = fmtPhp(sum.projectPay);
    if (countsEl)    countsEl.textContent    = payoutCountsSummaryClean(sum) || 'No completions';
    if (bonusPayEl)  bonusPayEl.textContent  = fmtPoints(sum.totalPoints);
    if (bonusCntEl)  bonusCntEl.textContent  = sum.totalCount > 0 ? `Avg ${fmtPoints(sum.totalPoints / sum.totalCount)} pts / project` : 'No points';
    if (shiftPayEl)  shiftPayEl.textContent  = sum.avgElapsedMs ? fmtDuration(sum.avgElapsedMs) : '--';
    if (shiftDaysEl) shiftDaysEl.textContent = speedCountsSummary(sum);
    if (totalEl)     totalEl.textContent     = fmtPhp(sum.grandTotal);

    const avgPerProject = sum.totalCount ? (sum.grandTotal / sum.totalCount) : 0;
    if (avgEl) avgEl.textContent = `Avg ${fmtPhp(avgPerProject)} / project`;

    // Earnings breakdown
    const brkHost = el('earnBreakdownHost');
    if (brkHost) brkHost.innerHTML = renderBreakdown(sum);

    // Rate legend
    const legendEl = el('earnRateLegend');
    if (legendEl) legendEl.innerHTML = rateLegendHtml();

    // Main table
    const main = el('earnMain');
    if (main){
      if (state.mode === 'weekly') main.innerHTML = renderWeeklyMain(per, sum, cachedSchedule);
      else if (state.mode === 'monthly') main.innerHTML = renderMonthlyMain(per, sum, cachedSchedule);
      else main.innerHTML = renderDailyMain(per, sum, cachedSchedule);
    }

    // Completions list
    const listHost = el('earnListHost');
    const listMeta = el('earnListMeta');
    if (listMeta) listMeta.textContent = `${inPeriod.length} item(s)`;
    if (listHost) listHost.innerHTML = renderList(inPeriod);

    // Subtitle
    const sub = el('earnSub');
    if (sub) sub.textContent = `Based on completed technician projects \u2022 ${tz.label} (${tz.sub})`;
  }

  function wireUi(state){
    const w = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    w('earnModeWeekly',  async () => { state.mode='weekly';  saveState(state); await render(state); });
    w('earnModeMonthly', async () => { state.mode='monthly'; saveState(state); await render(state); });
    w('earnModeDaily',   async () => { state.mode='daily';   saveState(state); await render(state); });

    w('earnTzPHT', async () => { state.tz='PHT'; saveState(state); await render(state); });
    w('earnTzPST', async () => { state.tz='PST'; saveState(state); await render(state); });

    w('earnPrevBtn', async () => { shiftAnchor(state, -1); saveState(state); await render(state); });
    w('earnNextBtn', async () => { shiftAnchor(state, +1); saveState(state); await render(state); });

    w('earnRefreshBtn', async () => { await render(state, true); });
  }

  // Plugin registration + lazy init
  const plugin = {
    id: 'earnings',
    title: 'Earnings',
    iconClass: 'fas fa-wallet'
  };

  let inited = false;

  Portal.registerPlugin(plugin);

  const origSwitch = Portal.switchView.bind(Portal);
  Portal.switchView = async function(id, btn){
    await origSwitch(id, btn);
    if (id === 'earnings') {
      ensureCss();
      ensureMarkup();
      const state = loadState();
      if (!inited){ wireUi(state); inited = true; }
      await render(state, false);
    }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    ensureCss();
    ensureMarkup();
    const state = loadState();
    if (!inited){ wireUi(state); inited = true; }
    await render(state, false);
  });

})();
