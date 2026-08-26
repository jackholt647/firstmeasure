/* portal_scripts/shifts.js
 * Shift module – LOCAL-TIMEZONE EDITION
 *
 * All times are stored on the server in UTC.
 * The frontend converts every displayed time to the user's browser
 * timezone, including day-boundary shifts (e.g. a server-Monday block
 * that becomes local-Tuesday for a user 8 h ahead).
 *
 * The active-production dashboard is driven by actual queue and shift data,
 * showing who is working, current assignments, and compact daily totals.
 *
 * Registers itself as a Portal plugin.
 */
(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;

  function fmActor(){
    const c = cfg() || {};
    const u = c.user || {};
    const actor = {};
    if (u.id) actor.id = u.id;
    if (u.email) actor.email = u.email;
    if (u.name) actor.name = u.name;
    if (u.team_id) actor.team_id = u.team_id;
    if (u.organization_id) actor.organization_id = u.organization_id;
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

  const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const DAY_SHORT = { monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat', sunday:'Sun' };
  const DAY_FULL  = { monday:'Monday', tuesday:'Tuesday', wednesday:'Wednesday', thursday:'Thursday', friday:'Friday', saturday:'Saturday', sunday:'Sunday' };
  const ROLES = ['technician','qa','manager'];
  const ROLE_LABELS = { technician:'Technician', qa:'QA', manager:'Manager' };
  const ROLE_LABELS_SHORT = { technician:'Tech', qa:'QA', manager:'Mgr' };
  const ROLE_COLORS = { technician:'#1a73e8', qa:'#e37400', manager:'#d93025' };
  const ROLE_ICONS  = { technician:'fa-drafting-compass', qa:'fa-clipboard-check', manager:'fa-user-shield' };

  function completedProjectPoints(project){
    const p = project || {};
    for (const key of ['point_value', 'project_points', 'points_value', 'points']) {
      const value = Number(p[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    const normalized = String(p.complexity || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const byComplexity = {
      '1':2, '2':3, '3':4, '4':6, '5':10,
      very_simple:2, very_simple_project:2, simple:3, simple_project:3,
      standard:4, standard_project:4, complex:6, complex_project:6,
      very_complex:10, very_complex_project:10
    };
    return Number(byComplexity[normalized] || 1);
  }

  function formatCompletedPoints(value){
    const rounded = Math.round(Number(value || 0) * 100) / 100;
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Day view time grid: 0–24 (full day, since TZ shifts can push blocks anywhere)
  const DAY_START_HOUR = 0;
  const DAY_END_HOUR = 24;
  const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

  // Quick-add shift presets (shown in LOCAL time)
  const SHIFT_PRESETS = [
    { label:'Early (5a–1p)', start:'05:00', end:'13:00' },
    { label:'Late (1p–9p)',  start:'13:00', end:'21:00' },
  ];

  // AFK detection: if no recent activity within this threshold, consider worker AFK
  const AFK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  // ---- date helpers (all LOCAL) ----
  function ymdLocal(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function dateFromYMD(ymd){
    const [y,m,d] = ymd.split('-').map(Number);
    return new Date(y, m-1, d);
  }

  function todayYMD(){ return ymdLocal(new Date()); }

  function padTime(h,m){
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  function addDaysYMD(ymd, n){
    const d = dateFromYMD(ymd);
    d.setDate(d.getDate()+n);
    return ymdLocal(d);
  }

  // ---- Shift object ----
  const Shifts = {
    // state
    weekOffset: 0,
    dayOffset: 0,
    schedules: [],
    viewLevel: 'none',
    editLevel: 'none',
    statusTimer: null,
    statsTimer: null,
    schedTimer: null,
    tickTimer: null,
    activeDataTimer: null,
    editModal: { open:false, email:null, name:null },
    viewMode: 'week',
    showUnscheduled: false,
    showInactiveByRole: { technician:true, qa:true },
    sortMode: 'role',

    // Cached queue overview data (drives Active Production)
    _overviewData: null,
    _drafterRankByEmail: {},
    _drafterRankLoadedAt: 0,

    // ---- TIMEZONE STATE ----
    // Server always stores times in UTC (offset = 0).
    serverTzOffsetSec: 0,

    /** Minutes east of UTC for the browser. Positive = east. */
    get localOffsetMin(){ return -new Date().getTimezoneOffset(); },

    /** Server is UTC → always 0. */
    get serverOffsetMin(){ return 0; },

    /** Signed delta in minutes: local minus server (UTC). */
    get tzDelta(){ return this.localOffsetMin; },

    // ================================================================
    //  TIMEZONE CONVERSION
    // ================================================================

    /**
     * Convert a server-timezone date+time to the browser's local date+time.
     * @param {string} sDate  "YYYY-MM-DD" in server TZ
     * @param {string} sTime  "HH:MM" in server TZ
     * @returns {{date:string, time:string}}
     */
    serverToLocal(sDate, sTime){
      const [y,mo,d] = sDate.split('-').map(Number);
      const [h,mi]   = sTime.split(':').map(Number);
      // Server wall-clock → UTC:  subtract server offset
      const utcMs = Date.UTC(y, mo-1, d, h, mi) - this.serverTzOffsetSec * 1000;
      // UTC → local: JS Date auto-converts
      const loc = new Date(utcMs);
      return { date: ymdLocal(loc), time: padTime(loc.getHours(), loc.getMinutes()) };
    },

    /**
     * Convert a browser-local date+time to the server's timezone.
     * @param {string} lDate  "YYYY-MM-DD" local
     * @param {string} lTime  "HH:MM" local
     * @returns {{date:string, time:string}}
     */
    localToServer(lDate, lTime){
      const [y,mo,d] = lDate.split('-').map(Number);
      const [h,mi]   = lTime.split(':').map(Number);
      // Local wall-clock → UTC ms (JS does this internally)
      const utcMs = new Date(y, mo-1, d, h, mi).getTime();
      // UTC → server wall-clock:  add server offset, read as UTC digits
      const sv = new Date(utcMs + this.serverTzOffsetSec * 1000);
      return {
        date: `${sv.getUTCFullYear()}-${String(sv.getUTCMonth()+1).padStart(2,'0')}-${String(sv.getUTCDate()).padStart(2,'0')}`,
        time: padTime(sv.getUTCHours(), sv.getUTCMinutes()),
      };
    },

    /**
     * Convert an array of blocks (start/end/role) from server TZ to local TZ.
     * Each block gets _serverDate tracking.  Handles overnight blocks (end < start).
     * @param {Array} blocks       [{start,end,role}, …]
     * @param {string} serverDate  "YYYY-MM-DD" the blocks sit on in server TZ
     * @param {boolean} isOverride whether this server-day was an override
     * @returns {Array}  [{start,end,role,_serverDate,_isOverride, localDate}, …]
     */
    convertBlocksToLocal(blocks, serverDate, isOverride){
      if (!blocks || !blocks.length) return [];
      const out = [];
      blocks.forEach(b => {
        const ls = this.serverToLocal(serverDate, b.start);
        // Overnight detection: end < start in server time → end is next server day
        let endServerDate = serverDate;
        if (b.end < b.start) endServerDate = addDaysYMD(serverDate, 1);
        const le = this.serverToLocal(endServerDate, b.end);
        out.push({
          start: ls.time,
          end: le.time,
          role: b.role,
          localDate: ls.date,
          _serverDate: serverDate,
          _isOverride: !!isOverride,
        });
      });
      return out;
    },

    /**
     * Convert a complete user schedule's week data from server TZ to local TZ,
     * re-keying blocks by LOCAL day of week.
     * Operates on the _allBlocksByServerDate map built during the merge step.
     */
    convertUserScheduleToLocal(sched){
      const delta = this.tzDelta;

      // Build local blocks from _allBlocksByServerDate (populated by merge step)
      const byServerDate = sched._allBlocksByServerDate || {};
      const localBuckets = {}; // localDateStr → [block, …]

      Object.entries(byServerDate).forEach(([serverDateStr, dayData]) => {
        const blocks = dayData.blocks || [];
        const isOvr  = !!dayData.is_override;
        this.convertBlocksToLocal(blocks, serverDateStr, isOvr).forEach(lb => {
          const ld = lb.localDate;
          if (!localBuckets[ld]) localBuckets[ld] = [];
          localBuckets[ld].push(lb);
        });
      });

      // Build new .week keyed by LOCAL day name for the LOCAL week being viewed
      const localMonday = (this.viewMode === 'day')
        ? this.getWeekMondayForDate(this.getDay(this.dayOffset))
        : this.getWeekMonday(this.weekOffset);

      const newWeek = {};
      let hasBlocks = false;

      for (let di = 0; di < 7; di++){
        const localDateStr = addDaysYMD(localMonday, di);
        const dayName = DAYS[di];
        const dayBlocks = localBuckets[localDateStr] || [];
        if (dayBlocks.length) hasBlocks = true;

        newWeek[dayName] = {
          date: localDateStr,
          blocks: dayBlocks.map(b => ({start:b.start, end:b.end, role:b.role})),
          is_override: dayBlocks.some(b => b._isOverride),
          _serverDates: [...new Set(dayBlocks.map(b => b._serverDate))],
        };
      }

      // Convert recurring for the recurring-editor display
      const localRecurring = (delta !== 0 && sched.recurring)
        ? this.convertRecurringToLocal(sched.recurring)
        : sched.recurring;

      return {
        ...sched,
        week: newWeek,
        has_blocks: hasBlocks,
        _localRecurring: localRecurring,
        _allBlocksByServerDate: undefined, // clean up
      };
    },

    /**
     * Convert a recurring schedule (server day→blocks) to local day→blocks.
     * Uses the current real-world week as a concrete reference for the conversion.
     */
    convertRecurringToLocal(recurring){
      if (!recurring) return {};
      const delta = this.tzDelta;
      if (delta === 0) return recurring;

      const local = {};
      DAYS.forEach(d => { local[d] = []; });

      // Reference: the server Monday of the current real week
      const serverMonday = this.localToServer(this.getWeekMonday(0), '12:00').date;
      const smDate = dateFromYMD(serverMonday);
      // Align to Monday
      const smDow = smDate.getDay();
      const smOff = smDow === 0 ? -6 : 1 - smDow;
      smDate.setDate(smDate.getDate() + smOff);

      DAYS.forEach((serverDay, si) => {
        const blocks = recurring[serverDay] || [];
        const sd = new Date(smDate);
        sd.setDate(sd.getDate() + si);
        const serverDateStr = ymdLocal(sd);

        blocks.forEach(b => {
          const ls = this.serverToLocal(serverDateStr, b.start);
          let endSD = serverDateStr;
          if (b.end < b.start) endSD = addDaysYMD(serverDateStr, 1);
          const le = this.serverToLocal(endSD, b.end);
          const localDay = this.getDayName(ls.date);
          local[localDay].push({ start:ls.time, end:le.time, role:b.role });
        });
      });
      return local;
    },

    /**
     * Convert local-timezone recurring blocks back to server-timezone recurring.
     */
    convertRecurringToServer(localRecurring){
      if (!localRecurring) return {};
      const delta = this.tzDelta;
      if (delta === 0) return localRecurring;

      const server = {};
      DAYS.forEach(d => { server[d] = []; });

      const localMonday = this.getWeekMonday(0);

      DAYS.forEach((localDay, li) => {
        const blocks = localRecurring[localDay] || [];
        const ld = addDaysYMD(localMonday, li);

        blocks.forEach(b => {
          const ss = this.localToServer(ld, b.start);
          let endLD = ld;
          if (b.end < b.start) endLD = addDaysYMD(ld, 1);
          const se = this.localToServer(endLD, b.end);
          const serverDay = this.getDayName(ss.date);
          server[serverDay].push({ start:ss.time, end:se.time, role:b.role });
        });
      });
      return server;
    },

    /**
     * Convert block times entered in local TZ by the user back to server TZ for a
     * specific local date.  Returns an array grouped by server date (a single local
     * day can map to 1–2 server dates when TZ delta crosses midnight).
     * @returns {Object}  { "YYYY-MM-DD": [{start,end,role}], … }
     */
    localBlocksToServerByDate(localDate, blocks){
      const grouped = {};
      blocks.forEach(b => {
        const ss = this.localToServer(localDate, b.start);
        let endLD = localDate;
        if (b.end <= b.start && b.end !== '00:00') endLD = addDaysYMD(localDate, 1);
        const se = this.localToServer(endLD, b.end);
        const sd = ss.date;
        if (!grouped[sd]) grouped[sd] = [];
        grouped[sd].push({ start:ss.time, end:se.time, role:b.role });
      });
      return grouped;
    },

    // ================================================================
    //  MULTI-WEEK FETCH + MERGE  (handles TZ-induced day spillover)
    // ================================================================

    /**
     * Return the server week-of Monday(s) we need to fetch in order to
     * fully cover the LOCAL week (or day) being viewed.
     */
    getServerWeeksNeeded(){
      // Determine the local date range we need to cover
      let localStart, localEnd;
      if (this.viewMode === 'day'){
        localStart = this.getDay(this.dayOffset);
        localEnd   = localStart;
      } else {
        localStart = this.getWeekMonday(this.weekOffset);
        localEnd   = addDaysYMD(localStart, 6);
      }

      // Convert local boundaries to server dates
      const sStart = this.localToServer(localStart, '00:00').date;
      const sEnd   = this.localToServer(localEnd,   '23:59').date;

      // Find the server Monday for each boundary
      const monA = this.serverMondayOf(sStart);
      const monB = this.serverMondayOf(sEnd);

      const weeks = [monA];
      if (monB !== monA) weeks.push(monB);
      return weeks;
    },

    /** Return the Monday (YYYY-MM-DD) of the ISO week containing `dateStr`. */
    serverMondayOf(dateStr){
      const d = dateFromYMD(dateStr);
      const dow = d.getDay(); // 0=Sun
      const off = dow === 0 ? -6 : 1 - dow;
      d.setDate(d.getDate() + off);
      return ymdLocal(d);
    },

    /**
     * Merge 1–2 server week responses into a single schedule list.
     * Each user gets an _allBlocksByServerDate map covering all fetched dates.
     */
    mergeResponses(fetches){
      const userMap = {};
      let viewLevel = 'none', editLevel = 'none';

      fetches.forEach(({data, weekOf}) => {
        if (!data?.success) return;
        viewLevel = data.view_level || viewLevel;
        editLevel = data.edit_level || editLevel;
        (data.schedules || []).forEach(s => {
          if (!userMap[s.email]){
            userMap[s.email] = {
              email: s.email,
              name: s.name,
              team_id: s.team_id,
              role: s.role,
              drafter_rank: s.drafter_rank,
              recurring: s.recurring || {},
              overrides: {},
              _allBlocksByServerDate: {},
            };
          }
          const u = userMap[s.email];
          // Merge recurring (should be identical across weeks)
          if (s.recurring) u.recurring = s.recurring;
          // Merge overrides
          if (s.overrides) Object.assign(u.overrides, s.overrides);
          // Index week blocks by server date
          const monDate = dateFromYMD(weekOf);
          DAYS.forEach((dayName, di) => {
            const d = new Date(monDate);
            d.setDate(d.getDate() + di);
            const sDateStr = ymdLocal(d);
            const dayData = s.week?.[dayName];
            if (dayData) u._allBlocksByServerDate[sDateStr] = dayData;
          });
        });
      });

      return {
        schedules: Object.values(userMap),
        viewLevel,
        editLevel,
      };
    },

    // ================================================================
    //  INIT
    // ================================================================
    init(){
      this.injectStyles();
      this.removeSessionStatsUI();

      const host = document.getElementById('portalPluginViews');
      if (host && !document.getElementById('view-shifts')){
        const div = document.createElement('div');
        div.id = 'view-shifts';
        div.style.display = 'none';
        div.innerHTML = this.buildViewHtml();
        host.appendChild(div);
      }

      if (window.Portal && Portal.registerPlugin){
        Portal.registerPlugin({ id:'shifts', title:'Shifts', iconClass:'fas fa-calendar-alt' });
      }

      const origSwitch = Portal.switchView.bind(Portal);
      Portal.switchView = async (id, btn) => {
        await origSwitch(id, btn);
        if (id === 'shifts') await this.onShow();
        if (id === 'dashboard') await this.onShowDashboard();
      };
    },

    async onShow(){
      this.removeSessionStatsUI();
      await this.refreshSchedules(true);
      if (!this.schedTimer)      this.schedTimer      = setInterval(() => this.refreshSchedules(false), 60000);
      if (!this.tickTimer)       this.tickTimer        = setInterval(() => this.tickElapsed(), 1000);
    },

    async onShowDashboard(){
      this.removeSessionStatsUI();
      if (!document.getElementById('shiftStatusBody')) return;
      if (!this.schedules.length) await this.refreshSchedules(true);
      await this.refreshActiveData(false);
      if (!this.activeDataTimer) this.activeDataTimer = setInterval(() => this.refreshActiveData(false), 15000);
      if (!this.tickTimer)       this.tickTimer        = setInterval(() => this.tickElapsed(), 1000);
    },

    removeSessionStatsUI(){
      ['shiftStatsBody', 'shiftStatsBodyLegacy'].forEach(id => {
        const body = document.getElementById(id);
        if (body) (body.closest('.sh-section') || body).remove();
      });
      document.querySelectorAll('.sh-section-title').forEach(title => {
        if (String(title.textContent || '').trim() === 'Session Stats') {
          (title.closest('.sh-section') || title).remove();
        }
      });
    },

    stopTimers(){
      [this.activeDataTimer, this.schedTimer, this.tickTimer].forEach(t => { if (t) clearInterval(t); });
      this.activeDataTimer = this.schedTimer = this.tickTimer = null;
    },

    // ---- VIEW MODE ----
    setViewMode(mode){
      this.viewMode = mode;
      document.querySelectorAll('.sh-view-btn').forEach(b => b.classList.toggle('sh-view-active', b.dataset.mode === mode));
      const dayNav = document.getElementById('shiftDayNav');
      const weekNav = document.getElementById('shiftWeekNav');
      if (dayNav) dayNav.style.display = mode === 'day' ? 'flex' : 'none';
      if (weekNav) weekNav.style.display = mode === 'week' ? 'flex' : 'none';
      this.refreshSchedules(true);
    },

    toggleUnscheduled(){
      this.showUnscheduled = !this.showUnscheduled;
      const btn = document.getElementById('shiftToggleUnsched');
      if (btn){
        btn.classList.toggle('sh-toggle-active', this.showUnscheduled);
        btn.title = this.showUnscheduled ? 'Hide unscheduled users' : 'Show unscheduled users';
      }
      this.renderSchedule();
    },

    toggleInactive(role){
      const key = String(role || '').toLowerCase();
      if (!['technician', 'qa'].includes(key)) return;
      this.showInactiveByRole[key] = this.showInactiveByRole[key] === false;
      if (this._overviewData) this.renderCurrentWorkers(this._overviewData);
    },

    // ================================================================
    //  ACCOUNT ROLE → DEFAULT SHIFT ROLE MAPPING
    //
    //  The user's account role (set in the Users tab via presets:
    //  admin, manager, qa, technician, trainee) determines what shift
    //  role is pre-selected when adding new shift blocks.
    //  The role can still be changed per-block in the editor.
    // ================================================================

    /**
     * Map a user's account role to the default shift-block role.
     * @param {string} accountRole  The user's `role` field (e.g. 'technician', 'qa')
     * @returns {string}  A valid shift block role from ROLES
     */
    userDefaultShiftRole(accountRole){
      const map = {
        'admin':      'manager',
        'manager':    'manager',
        'qa':         'qa',
        'technician': 'technician',
        'trainee':    'technician',
        'lead':       'manager',      // legacy: map old lead → manager
        'user':       'technician',   // legacy fallback
      };
      return map[(accountRole || '').toLowerCase()] || 'technician';
    },

    normalizeDrafterRank(value){
      const rank = String(value || '').trim().toLowerCase();
      const aliases = {
        '1':'junior', 'level 1':'junior', 'junior technician':'junior',
        '2':'standard', 'level 2':'standard', 'standard technician':'standard',
        '3':'senior', 'level 3':'senior', 'senior technician':'senior',
      };
      const normalized = aliases[rank] || rank;
      return ['junior', 'standard', 'senior'].includes(normalized) ? normalized : '';
    },

    drafterRankLabel(value){
      const rank = this.normalizeDrafterRank(value);
      return rank.charAt(0).toUpperCase() + rank.slice(1);
    },

    drafterRankPillHtml(value, show=true){
      if (!show) return '';
      const rank = this.normalizeDrafterRank(value);
      if (!rank) return '';
      const icon = { junior:'fa-seedling', standard:'fa-medal', senior:'fa-crown' }[rank];
      const level = { junior:1, standard:2, senior:3 }[rank];
      const label = this.drafterRankLabel(rank);
      return `<span class="sh-rank-pill sh-rank-${rank}" title="${Portal.escapeHtml(label)} technician — level ${level}" aria-label="${Portal.escapeHtml(label)} technician level ${level}"><i class="fas ${icon}"></i><span>${level}</span></span>`;
    },

    scheduleLooksTechnician(s){
      const role = String(s?.role || '').trim().toLowerCase();
      if (['technician', 'trainee', 'user'].includes(role)) return true;
      for (const day of DAYS) {
        const blocks = s?.week?.[day]?.blocks || [];
        if (blocks.some(b => String(b.role || '').toLowerCase() === 'technician')) return true;
      }
      return false;
    },

    rankForEmail(email){
      const target = String(email || '').trim().toLowerCase();
      if (!target) return '';
      const user = this.schedules.find(s => String(s.email || '').trim().toLowerCase() === target);
      return this.normalizeDrafterRank(user?.drafter_rank || this._drafterRankByEmail[target] || '');
    },

    async refreshDrafterRankLookup(force=false){
      const now = Date.now();
      if (!force && this._drafterRankLoadedAt && (now - this._drafterRankLoadedAt) < 5 * 60 * 1000) return;
      const weekOf = this.getServerWeeksNeeded()[0] || todayYMD();
      const data = await Portal.apiPost(cfg().endpoints.server, {
        action: 'shift_get_schedules',
        week_of: weekOf,
        team: String(window.Projects?.dashboardTeam || 'all'),
      });
      if (!data?.success) return;
      const rows = Array.isArray(data.schedules) ? data.schedules : (Array.isArray(data.users) ? data.users : []);
      const lookup = {};
      rows.forEach(user => {
        const email = String(user?.email || '').trim().toLowerCase();
        const rank = this.normalizeDrafterRank(user?.drafter_rank || user?.technician_rank || user?.measurement_technician_rank || '');
        if (email && rank) lookup[email] = rank;
      });
      this._drafterRankByEmail = lookup;
      this._drafterRankLoadedAt = now;
    },

    async fetchDashboardRoster(team='all'){
      const base = String(cfg()?.endpoints?.internal || '').replace(/\/+$/, '');
      if (!base) return [];
      const selectedTeam = String(team || 'all').trim() || 'all';
      const query = selectedTeam === 'all' ? '' : `?team_id=${encodeURIComponent(selectedTeam)}`;
      const response = await fetch(`${base}/users${query}`, {
        credentials:'include',
        cache:'no-store',
        headers:{ Accept:'application/json' }
      });
      if (!response.ok) throw new Error(`Dashboard roster request failed (${response.status})`);
      const data = await response.json();
      return Array.isArray(data?.users) ? data.users : [];
    },

    filterDashboardProductionByRoster(data, currentStatus, productionStats, roster, team){
      const selectedTeam = String(team || 'all').trim() || 'all';
      if (selectedTeam === 'all') return { data, currentStatus, productionStats };
      const emails = new Set((Array.isArray(roster) ? roster : [])
        .map(user => String(user?.email || '').trim().toLowerCase())
        .filter(Boolean));
      const activeManagerProjectIds = new Set((Array.isArray(roster) ? roster : [])
        .map(user => String(user?.qa_heartbeat_current_folder || '').trim())
        .filter(Boolean));
      const hasEmail = value => emails.has(String(value || '').trim().toLowerCase());
      const filteredData = {
        ...data,
        in_progress: (Array.isArray(data?.in_progress) ? data.in_progress : [])
          .filter(project => hasEmail(project?.assigned_to_email)),
        qa: (Array.isArray(data?.qa) ? data.qa : [])
          .filter(project => hasEmail(project?.qa_claimed_by_email) || activeManagerProjectIds.has(String(project?.id || '').trim())),
        completed_today: (Array.isArray(data?.completed_today) ? data.completed_today : [])
          .filter(project => hasEmail(project?.assigned_to_email) || hasEmail(project?.qa_approved_by_email || project?.qa_approved_by)),
      };
      const filteredStatus = currentStatus && typeof currentStatus === 'object' ? {
        ...currentStatus,
        on_shift: (Array.isArray(currentStatus.on_shift) ? currentStatus.on_shift : [])
          .filter(person => hasEmail(person?.email))
      } : currentStatus;
      const filteredStats = productionStats && typeof productionStats === 'object' ? {
        ...productionStats,
        technicians: (Array.isArray(productionStats.technicians) ? productionStats.technicians : [])
          .filter(row => hasEmail(row?.email)),
        leaderboard: (Array.isArray(productionStats.leaderboard) ? productionStats.leaderboard : [])
          .filter(row => hasEmail(row?.email)),
        qa_stats: (Array.isArray(productionStats.qa_stats) ? productionStats.qa_stats : [])
          .filter(row => hasEmail(row?.email))
      } : productionStats;
      return { data: filteredData, currentStatus: filteredStatus, productionStats: filteredStats };
    },

    // ---- SORTING ----
    setSortMode(mode){
      this.sortMode = mode;
      document.querySelectorAll('.sh-sort-btn').forEach(b => b.classList.toggle('sh-sort-active', b.dataset.sort === mode));
      this.renderSchedule();
    },

    sortSchedules(list){
      const mode = this.sortMode;
      const sorted = list.slice();
      if (mode === 'name'){
        sorted.sort((a,b) => (a.name||'').localeCompare(b.name||''));
      } else if (mode === 'role'){
        const roleOrder = { manager:0, qa:1, technician:2 };
        const getPrimaryRole = s => {
          for (const day of DAYS){
            const blocks = s.week?.[day]?.blocks || [];
            if (blocks.length) return blocks[0].role || 'technician';
          }
          return 'technician';
        };
        sorted.sort((a,b) => {
          const ra = roleOrder[getPrimaryRole(a)] ?? 99;
          const rb = roleOrder[getPrimaryRole(b)] ?? 99;
          if (ra !== rb) return ra - rb;
          return (a.name||'').localeCompare(b.name||'');
        });
      } else if (mode === 'time'){
        const getEarliestStart = s => {
          let earliest = 9999;
          for (const day of DAYS){
            (s.week?.[day]?.blocks || []).forEach(b => {
              const min = Shifts.timeToMinutes(b.start);
              if (min < earliest) earliest = min;
            });
          }
          return earliest;
        };
        sorted.sort((a,b) => {
          const ta = getEarliestStart(a); const tb = getEarliestStart(b);
          if (ta !== tb) return ta - tb;
          return (a.name||'').localeCompare(b.name||'');
        });
      }
      return sorted;
    },

    // ---- WEEK NAV (all LOCAL) ----
    getWeekMonday(offset=0){
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1) + (offset * 7);
      d.setDate(diff);
      return ymdLocal(d);
    },

    /** Return the LOCAL Monday of the ISO week containing the given local dateStr. */
    getWeekMondayForDate(dateStr){
      const d = dateFromYMD(dateStr);
      const dow = d.getDay();
      const off = dow === 0 ? -6 : 1 - dow;
      d.setDate(d.getDate() + off);
      return ymdLocal(d);
    },

    fmtWeekLabel(mondayStr){
      const d = dateFromYMD(mondayStr);
      const sun = new Date(d); sun.setDate(sun.getDate()+6);
      const opts = { month:'short', day:'numeric' };
      return `${d.toLocaleDateString(undefined,opts)} – ${sun.toLocaleDateString(undefined,opts)}, ${sun.getFullYear()}`;
    },

    prevWeek(){ this.weekOffset--; this.refreshSchedules(true); },
    nextWeek(){ this.weekOffset++; this.refreshSchedules(true); },
    thisWeek(){ this.weekOffset=0; this.refreshSchedules(true); },

    // ---- DAY NAV (all LOCAL) ----
    getDay(offset=0){
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate()+offset);
      return ymdLocal(d);
    },

    fmtDayLabel(dateStr){
      const d = dateFromYMD(dateStr);
      return d.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric', year:'numeric' });
    },

    getDayName(dateStr){
      const d = dateFromYMD(dateStr);
      const dayIdx = d.getDay();
      return DAYS[dayIdx === 0 ? 6 : dayIdx-1];
    },

    prevDay(){ this.dayOffset--; this.refreshSchedules(true); },
    nextDay(){ this.dayOffset++; this.refreshSchedules(true); },
    today(){ this.dayOffset=0; this.refreshSchedules(true); },

    // ================================================================
    //  DATA FETCH  (with multi-week + TZ conversion)
    // ================================================================
    async refreshSchedules(force=false){
      const statusEl = document.getElementById('shiftSchedStatus');
      if (statusEl && force) statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

      try {
        // 1) Determine which server weeks to request
        const serverWeeks = this.getServerWeeksNeeded();

        // 2) Fetch them (parallel)
        const responses = await Promise.all(serverWeeks.map(weekOf =>
          Portal.apiPost(cfg().endpoints.server, {
            action: 'shift_get_schedules',
            week_of: weekOf,
          }).then(data => ({data, weekOf}))
        ));

        // 4) Merge responses
        const merged = this.mergeResponses(responses);

        // 5) Convert every user schedule to local time
        this.schedules = merged.schedules.map(s => this.convertUserScheduleToLocal(s));
        this.viewLevel = merged.viewLevel;
        this.editLevel = merged.editLevel;

        this.renderSchedule();
        if (statusEl) statusEl.textContent = '';
      } catch(e){
        console.error('refreshSchedules error', e);
        if (statusEl) statusEl.textContent = 'Error loading';
      }
    },

    // ================================================================
    //  ACTIVE DATA FETCH  (drives Active Production)
    //
    //  Uses queue_admin_overview which returns REAL project assignments:
    //    - in_progress: who is actively working and on what
    //    - qa: projects awaiting QA review
    //    - completed_today: what was finished today
    //    - completed_any: recent completions (last 48h)
    // ================================================================
    async refreshActiveData(force=false){
      const statusEl  = document.getElementById('shiftStatusBody');

      if (force) {
        if (statusEl) statusEl.innerHTML = '<div class="sh-empty"><i class="fas fa-circle-notch fa-spin"></i> Loading…</div>';
      }

      try {
        const dashboardTeam = String(window.Projects?.dashboardTeam || cfg()?.user?.team_id || 'all').trim() || 'all';
        // Dashboard team selection follows the worker's current roster team.
        // Projects retain the team they were created under, so querying by the
        // project's team would hide active work immediately after a reassignment.
        const overviewRequest = fmPost('queue/admin/overview/compat', {
          view: 'card',
          team: 'all',
          include: ['in_progress', 'qa', 'completed_today'],
          bucket_limit: 250
        });
        const currentStatusRequest = Portal.apiPost(cfg().endpoints.server, {
          action: 'shift_current_status',
          team: 'all',
        }).catch(() => null);
        const rankLookupRequest = this.refreshDrafterRankLookup(force).catch(() => null);
        const productionStatsRequest = Portal.apiPost(cfg().endpoints.server, {
          action: 'technician_leaderboard',
          team: 'all',
          force: force ? 1 : 0,
        }).catch(() => null);
        const rosterRequest = this.fetchDashboardRoster(dashboardTeam).catch(() => []);
        let [data, currentStatus, , productionStats, roster] = await Promise.all([
          overviewRequest,
          currentStatusRequest,
          rankLookupRequest,
          productionStatsRequest,
          rosterRequest
        ]);
        if (!data || !data.success) {
          // Fallback: try the old schedule-based endpoints
          await this._fallbackRefreshStatus();
          return;
        }
        ({ data, currentStatus, productionStats } = this.filterDashboardProductionByRoster(
          data,
          currentStatus,
          productionStats,
          roster,
          dashboardTeam
        ));
        const dashboardData = {
          ...data,
          on_shift_workers: currentStatus?.success && Array.isArray(currentStatus.on_shift)
            ? currentStatus.on_shift
            : [],
          shift_status_today: currentStatus?.success ? (currentStatus.today || '') : '',
          production_stats: productionStats?.success ? productionStats : null,
          dashboard_roster: Array.isArray(roster) ? roster : [],
        };
        this._overviewData = dashboardData;
        this.renderCurrentWorkers(dashboardData);
      } catch(e) {
        console.error('refreshActiveData error', e);
        // Fallback to schedule-based endpoints on failure (e.g. permissions)
        await this._fallbackRefreshStatus();
      }
    },

    /** Fallback: old schedule-based current status */
    async _fallbackRefreshStatus(){
      const el = document.getElementById('shiftStatusBody');
      if (!el) return;
      try {
        const data = await Portal.apiPost(cfg().endpoints.server, {
          action: 'shift_current_status',
          team: String(window.Projects?.dashboardTeam || 'all')
        });
        if (!data || !data.success) return;
        this._renderLegacyCurrentStatus(data);
      } catch{}
    },

    /** Fallback: old schedule-based session stats */
    async _fallbackRefreshSessionStats(){
      const el = document.getElementById('shiftStatsBody');
      if (!el) return;
      try {
        const data = await Portal.apiPost(cfg().endpoints.server, {
          action: 'shift_session_stats',
          team: String(window.Projects?.dashboardTeam || 'all')
        });
        if (!data || !data.success) return;
        this._renderLegacySessionStats(data);
      } catch{}
    },

    // ---- RENDER ROUTER ----
    renderSchedule(){
      const localMonday = (this.viewMode === 'day')
        ? this.getWeekMondayForDate(this.getDay(this.dayOffset))
        : this.getWeekMonday(this.weekOffset);

      const weekLabel = document.getElementById('shiftWeekLabel');
      if (weekLabel) weekLabel.textContent = this.fmtWeekLabel(localMonday);

      const dayDate = this.getDay(this.dayOffset);
      const dayLabel = document.getElementById('shiftDayLabel');
      if (dayLabel) dayLabel.textContent = this.fmtDayLabel(dayDate);

      this.updateUnschedCount();

      if (this.viewMode === 'day'){
        this.renderDayView(dayDate);
      } else {
        this.renderWeekGrid(localMonday);
      }
      this.renderRecurringButtons();
    },

    // ---- FILTER HELPERS ----
    getFilteredSchedules(checkDay){
      let list = this.showUnscheduled ? this.schedules : this.schedules.filter(checkDay);
      return this.sortSchedules(list);
    },

    getVisibleScheduleRows(){
      if (this.viewMode === 'day'){
        const dayName = this.getDayName(this.getDay(this.dayOffset));
        return this.getFilteredSchedules(s => this.userHasBlocksForDay(s, dayName));
      }
      return this.getFilteredSchedules(s => this.userHasBlocksForWeek(s));
    },

    userHasBlocksForWeek(s){
      if (s.has_blocks) return true;
      for (const day of DAYS) if (this.isOverrideOff(s,day)) return true;
      return false;
    },

    userHasBlocksForDay(s, dayName){
      const dayData = s.week?.[dayName];
      if (dayData?.blocks?.length > 0) return true;
      return this.isOverrideOff(s, dayName);
    },

    isOverrideOff(s, dayName){
      const dayData = s.week?.[dayName];
      if (!dayData?.is_override) return false;
      if (dayData.blocks?.length > 0) return false;
      const recurringBlocks = (s._localRecurring || s.recurring)?.[dayName] || [];
      return recurringBlocks.length > 0;
    },

    updateUnschedCount(){
      const badge = document.getElementById('shiftUnschedCount');
      if (!badge) return;
      const total = this.schedules.length;
      let scheduled;
      if (this.viewMode === 'day'){
        const dayName = this.getDayName(this.getDay(this.dayOffset));
        scheduled = this.schedules.filter(s => this.userHasBlocksForDay(s, dayName)).length;
      } else {
        scheduled = this.schedules.filter(s => this.userHasBlocksForWeek(s)).length;
      }
      const unsched = total - scheduled;
      badge.textContent = unsched > 0 ? unsched : '';
      badge.style.display = unsched > 0 ? 'inline-flex' : 'none';
    },

    // ================================================================
    //  RENDER: WEEK GRID  (all data is already in local TZ)
    // ================================================================
    renderWeekGrid(localMonday){
      const grid = document.getElementById('shiftSchedGrid');
      if (!grid) return;

      const canEdit = this.editLevel !== 'none';
      const filtered = this.getFilteredSchedules(s => this.userHasBlocksForWeek(s));

      if (!filtered.length){
        grid.innerHTML = `<div class="sh-empty">${this.schedules.length > 0 && !this.showUnscheduled ? 'No users scheduled this week. Toggle "Show Unscheduled" to see all.' : 'No schedules to display.'}</div>`;
        return;
      }

      let html = '<table class="sh-table"><thead><tr><th class="sh-name-col">Name</th>';
      const dates = [];
      for (let i = 0; i < 7; i++){
        const ds = addDaysYMD(localMonday, i);
        dates.push(ds);
        const dayName = DAYS[i];
        const isToday = ds === todayYMD();
        const dateNum = dateFromYMD(ds).getDate();
        html += `<th class="sh-day-col${isToday ? ' sh-today' : ''}">${DAY_SHORT[dayName]}<br><span class="sh-date-num">${dateNum}</span></th>`;
      }
      html += '</tr></thead><tbody>';

      filtered.forEach(s => {
        const hasAny = s.has_blocks;
        const rowCls = hasAny ? '' : ' class="sh-row-unsched"';
        html += `<tr${rowCls}>`;
        html += `<td class="sh-name-cell"><div class="sh-name-text">${Portal.escapeHtml(s.name)}</div><div class="sh-name-meta"><span class="sh-team-text">${Portal.escapeHtml(s.team_id||'default')}</span>${this.drafterRankPillHtml(s.drafter_rank, this.scheduleLooksTechnician(s))}</div></td>`;

        DAYS.forEach((dayName, di) => {
          const dateStr = dates[di];
          const dayData = s.week?.[dayName];
          const blocks = dayData?.blocks || [];
          const isOverride = !!dayData?.is_override;
          const isToday = dateStr === todayYMD();

          let cellCls = 'sh-cell';
          if (isToday) cellCls += ' sh-today';
          if (isOverride) cellCls += ' sh-override';

          html += `<td class="${cellCls}">`;
          if (blocks.length === 0){
            const overrideOff = isOverride && this.isOverrideOff(s, dayName);
            if (overrideOff){
              html += `<div class="sh-override-off">`;
              html += `<span class="sh-override-off-label"><i class="fas fa-ban"></i> OFF</span>`;
              if (canEdit && this.canEditUser(s.email)){
                html += `<button class="sh-revert-day-btn" data-email="${Portal.escapeHtml(s.email)}" data-local-date="${dateStr}" title="Revert to recurring schedule"><i class="fas fa-undo"></i></button>`;
              }
              html += `</div>`;
            } else {
              html += `<div class="sh-off">OFF</div>`;
            }
          } else {
            blocks.forEach(b => {
              const color = ROLE_COLORS[b.role] || '#5f6368';
              const blockCls = isOverride ? 'sh-block sh-block-manual' : 'sh-block';
              html += `<div class="${blockCls}" style="border-left:3px solid ${color};">`;
              html += `<span class="sh-block-time">${b.start}–${b.end}</span>`;
              html += `<span class="sh-block-role" style="color:${color};">${ROLE_LABELS_SHORT[b.role]||b.role}</span>`;
              html += `</div>`;
            });
          }
          if (canEdit && this.canEditUser(s.email)){
            html += `<button class="sh-edit-day-btn" data-email="${Portal.escapeHtml(s.email)}" data-local-date="${dateStr}" data-name="${Portal.escapeHtml(s.name)}" title="Edit this day"><i class="fas fa-pen" style="font-size:9px;"></i></button>`;
          }
          html += `</td>`;
        });
        html += `</tr>`;
      });

      html += '</tbody></table>';
      grid.innerHTML = html;

      grid.querySelectorAll('.sh-edit-day-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.openDayEditor(btn.dataset.email, btn.dataset.name, btn.dataset.localDate);
        });
      });
      grid.querySelectorAll('.sh-revert-day-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.revertDayQuick(btn.dataset.email, btn.dataset.localDate);
        });
      });
    },

    // ================================================================
    //  RENDER: DAY VIEW  (all data is already in local TZ)
    // ================================================================
    renderDayView(dateStr){
      const grid = document.getElementById('shiftSchedGrid');
      if (!grid) return;

      const canEdit = this.editLevel !== 'none';
      const dayName = this.getDayName(dateStr);
      const filtered = this.getFilteredSchedules(s => this.userHasBlocksForDay(s, dayName));
      const isToday = dateStr === todayYMD();

      if (!filtered.length){
        grid.innerHTML = `<div class="sh-empty">${this.schedules.length > 0 && !this.showUnscheduled ? 'No users scheduled this day. Toggle "Show Unscheduled" to see all.' : 'No schedules to display.'}</div>`;
        return;
      }

      const now = new Date();
      const nowMinutes = now.getHours()*60 + now.getMinutes();
      const gridStartMin = DAY_START_HOUR*60;
      const gridEndMin = DAY_END_HOUR*60;
      const gridTotalMin = gridEndMin - gridStartMin;
      const nowPct = isToday ? Math.max(0, Math.min(100, ((nowMinutes - gridStartMin)/gridTotalMin)*100)) : -1;

      let html = '<div class="sh-day-grid">';

      // Time axis
      html += '<div class="sh-day-time-axis">';
      html += '<div class="sh-day-name-spacer"></div>';
      html += '<div class="sh-day-hours-track">';
      for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h += 2){
        const leftPct = ((h - DAY_START_HOUR)/TOTAL_HOURS)*100;
        const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h-12}p`;
        html += `<div class="sh-day-hour-mark" style="left:${leftPct}%;">${label}</div>`;
      }
      if (nowPct >= 0){
        html += `<div class="sh-day-now-line" style="left:${nowPct}%;"></div>`;
      }
      html += '</div></div>';

      // Rows
      filtered.forEach(s => {
        const dayData = s.week?.[dayName];
        const blocks = dayData?.blocks || [];
        const hasBlocks = blocks.length > 0;
        const isOverride = !!dayData?.is_override;
        const overrideOff = !hasBlocks && this.isOverrideOff(s, dayName);

        let rowCls = 'sh-day-row';
        if (!hasBlocks && !overrideOff) rowCls += ' sh-day-row-unsched';
        if (overrideOff) rowCls += ' sh-day-row-override-off';

        html += `<div class="${rowCls}">`;
        html += `<div class="sh-day-name-cell">`;
        html += `<div class="sh-name-text">${Portal.escapeHtml(s.name)}</div>`;
        html += `<div class="sh-name-meta"><span class="sh-team-text">${Portal.escapeHtml(s.team_id||'default')}</span>${this.drafterRankPillHtml(s.drafter_rank, this.scheduleLooksTechnician(s))}</div>`;
        if (isOverride && hasBlocks) html += `<div class="sh-manual-indicator"><i class="fas fa-pen-fancy"></i> Manual</div>`;
        if (overrideOff) html += `<div class="sh-manual-indicator sh-override-off-indicator"><i class="fas fa-ban"></i> Override OFF</div>`;
        html += `</div>`;
        html += `<div class="sh-day-track">`;

        for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++){
          const leftPct = ((h-DAY_START_HOUR)/TOTAL_HOURS)*100;
          html += `<div class="sh-day-grid-line" style="left:${leftPct}%;"></div>`;
        }
        if (nowPct >= 0) html += `<div class="sh-day-now-line" style="left:${nowPct}%;"></div>`;

        if (hasBlocks){
          blocks.forEach(b => {
            let startMin = this.timeToMinutes(b.start);
            let endMin = this.timeToMinutes(b.end);
            // Handle overnight local blocks (end wraps next day)
            if (endMin <= startMin) endMin = gridEndMin;
            const leftPct = Math.max(0, ((startMin-gridStartMin)/gridTotalMin)*100);
            const widthPct = Math.min(100-leftPct, ((endMin-startMin)/gridTotalMin)*100);
            const color = ROLE_COLORS[b.role]||'#5f6368';
            const roleLabel = ROLE_LABELS[b.role]||b.role;
            const roleLabelShort = ROLE_LABELS_SHORT[b.role]||b.role;
            const manualCls = isOverride ? ' sh-day-block-manual' : '';

            html += `<div class="sh-day-block${manualCls}" style="left:${leftPct}%; width:${widthPct}%; background:${isOverride ? color+'25' : color+'18'}; border:1px solid ${color}55; border-left:3px solid ${color};${isOverride ? ' border-style:dashed; border-left-style:solid;':''}" title="${Portal.escapeHtml(s.name)}: ${b.start}–${b.end} (${roleLabel})${isOverride?' [Manual Override]':''}">`;
            html += `<span class="sh-day-block-time">${b.start}–${b.end}</span>`;
            html += `<span class="sh-day-block-role" style="color:${color};">${roleLabelShort}</span>`;
            html += `</div>`;
          });
        } else if (overrideOff){
          html += `<div class="sh-day-override-off-label"><i class="fas fa-ban"></i> OFF</div>`;
          if (canEdit && this.canEditUser(s.email)){
            html += `<button class="sh-day-revert-btn" data-email="${Portal.escapeHtml(s.email)}" data-local-date="${dateStr}" title="Revert to recurring schedule"><i class="fas fa-undo"></i></button>`;
          }
        } else {
          html += `<div class="sh-day-off-label">OFF</div>`;
        }

        if (canEdit && this.canEditUser(s.email)){
          html += `<button class="sh-day-edit-btn" data-email="${Portal.escapeHtml(s.email)}" data-local-date="${dateStr}" data-name="${Portal.escapeHtml(s.name)}" title="Edit"><i class="fas fa-pen" style="font-size:9px;"></i></button>`;
        }
        html += `</div></div>`;
      });

      html += '</div>';
      grid.innerHTML = html;

      grid.querySelectorAll('.sh-day-edit-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.openDayEditor(btn.dataset.email, btn.dataset.name, btn.dataset.localDate);
        });
      });
      grid.querySelectorAll('.sh-day-revert-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.revertDayQuick(btn.dataset.email, btn.dataset.localDate);
        });
      });
    },

    timeToMinutes(timeStr){
      const [h,m] = timeStr.split(':').map(Number);
      return h*60 + (m||0);
    },

    // ================================================================
    //  REVERT  (converts local date → server date(s))
    // ================================================================
    async revertDayQuick(email, localDateStr){
      if (!confirm('Revert this day back to the recurring schedule?')) return;
      try {
        // Find which server date(s) had overrides for this local day
        const user = this.schedules.find(s => s.email === email);
        const dayName = this.getDayName(localDateStr);
        const serverDates = user?.week?.[dayName]?._serverDates || [];

        // Fallback: convert local noon to server date
        if (!serverDates.length){
          serverDates.push(this.localToServer(localDateStr, '12:00').date);
        }

        for (const sd of serverDates){
          const res = await Portal.apiPost(cfg().endpoints.server, {
            action: 'shift_remove_day_override',
            target_email: email,
            date: sd,
          });
          if (!res?.success){ alert(res?.error||'Revert failed'); return; }
        }
        await this.refreshSchedules(true);
      } catch(e){ alert('Revert failed'); }
    },

    // ---- RENDER: RECURRING BUTTONS ----
    renderRecurringButtons(){
      const canEdit = this.editLevel !== 'none';
      const editAllEl = document.getElementById('shiftEditRecurringWrap');
      if (!editAllEl) return;
      editAllEl.innerHTML = '';
      if (!canEdit) return;
      this.getVisibleScheduleRows().forEach(s => {
        if (!this.canEditUser(s.email)) return;
        const btn = document.createElement('button');
        btn.className = 'sh-btn sh-btn-sm';
        btn.innerHTML = `<i class="fas fa-calendar-week"></i> ${Portal.escapeHtml(s.name)}`;
        btn.title = `Edit recurring schedule for ${s.name}`;
        btn.onclick = () => this.openRecurringEditor(s.email, s.name, s._localRecurring || s.recurring || {});
        editAllEl.appendChild(btn);
      });
    },

    canEditUser(targetEmail){
      const me = (cfg().user?.email||'').toLowerCase().trim();
      const level = this.editLevel;
      if (level === 'all') return true;
      if (level === 'none') return false;
      if (level === 'self') return me === targetEmail;
      if (level === 'team') return true;
      return false;
    },

    // ================================================================
    //  AFK DETECTION
    // ================================================================

    /**
     * Detect AFK status for a list of workers based on their activity timestamps.
     * Mutates each worker object to add `is_afk` (bool) and `idle_since` (ms timestamp).
     */
    detectAfkWorkers(workers){
      const now = Date.now();
      workers.forEach(w => {
        w.is_afk = false;
        w.idle_since = 0;

        let latestActivity = 0;

        // Check in-progress project start times
        w.projects.forEach(p => {
          if (p.started_at) {
            const t = new Date(p.started_at).getTime();
            if (t > latestActivity) latestActivity = t;
          }
        });

        // Check QA claim times
        w.qa_items.forEach(q => {
          if (q.qa_claimed_at) {
            const t = new Date(q.qa_claimed_at).getTime();
            if (t > latestActivity) latestActivity = t;
          }
        });

        // Worker is AFK if they have assigned work but nothing recent
        const hasWork = w.projects.length > 0 || w.qa_items.length > 0;
        if (hasWork && latestActivity > 0 && (now - latestActivity) > AFK_THRESHOLD_MS) {
          w.is_afk = true;
          w.idle_since = latestActivity;
        }
      });
    },

    /** Format an idle duration in a human-friendly way (e.g. "1h 23m") */
    fmtIdleDuration(ms){
      if (!ms || ms < 0) return '';
      const totalMin = Math.floor(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    },

    // ================================================================
    //  RENDER: CURRENT WORKERS  (from queue_admin_overview)
    // ================================================================
    renderCurrentWorkers(data){
      const el = document.getElementById('shiftStatusBody');
      if (!el) return;

      const inProgress = data.in_progress || [];
      const qaItems    = data.qa || [];
      const completedToday = data.completed_today || [];
      const onShiftWorkers = data.on_shift_workers || [];
      const dashboardRoster = data.dashboard_roster || [];
      const productionStats = data.production_stats && typeof data.production_stats === 'object' ? data.production_stats : null;

      // Start with everyone currently on shift so workers between assignments
      // remain visible even when the project queue has no row for them.
      const workerMap = {};
      onShiftWorkers.forEach(person => {
        const email = String(person.email || '').toLowerCase().trim();
        if (!email) return;
        const role = String(person.shift_role || person.role || 'technician').toLowerCase();
        workerMap[email] = {
          email,
          name: person.name || email,
          role: ROLE_LABELS[role] ? role : 'technician',
          projects: [],
          qa_items: [],
          drafter_rank: person.drafter_rank || person.technician_rank || person.measurement_technician_rank || '',
          on_break: !!person.on_break,
          break_started_at: person.break_started_at || null,
          is_on_shift: true,
          shift_blocks: Array.isArray(person.shift_blocks) ? person.shift_blocks : [],
          shift_status_today: data.shift_status_today || '',
          last_activity_at: person.last_activity_at || '',
        };
      });

      // Group in-progress projects by assigned worker

      inProgress.forEach(p => {
        const email = (p.assigned_to_email || '').toLowerCase().trim();
        if (!email) return;
        if (!workerMap[email]) {
          workerMap[email] = {
            email,
            name: p.assigned_to_name || email,
            role: 'technician',
            projects: [],
            qa_items: [],
            drafter_rank: p.drafter_rank || p.technician_rank || p.measurement_technician_rank || '',
            on_break: false,
            break_started_at: null,
          };
        }
        workerMap[email].projects.push(p);
      });

      // Add QA reviewers who have claimed items
      qaItems.forEach(q => {
        // A technician's work ends when it is submitted into QA, not when QA
        // eventually approves it. These projects are absent from
        // completed_today, so use the QA bucket itself to keep the
        // between-assignments baseline current.
        const technicianCandidates = [
          [q.assigned_to_email, q.assigned_to_name],
          [q.display_technician_email, q.display_technician_name],
          [q.latest_technician_email, q.latest_technician_name],
          [q.original_technician_email, q.original_technician_name],
          [q.qa_paid_to_email, q.qa_paid_to_name],
          [q.drafter_email, q.drafter_name],
          [q.technician_email, q.technician_name]
        ];
        const technician = technicianCandidates.find(([email]) => String(email || '').trim());
        const technicianEmail = String(technician?.[0] || '').toLowerCase().trim();
        const technicianName = String(technician?.[1] || technicianEmail).trim() || technicianEmail;
        const submissionHistory = Array.isArray(q.work_history)
          ? q.work_history
          : (Array.isArray(q.workflow?.work_history)
              ? q.workflow.work_history
              : (Array.isArray(q.workflow?.history) ? q.workflow.history : []));
        let submittedAt = q.uploaded_at || q.timestamps?.uploaded_at || q.submitted_at || '';
        if (!submittedAt) {
          for (let index = submissionHistory.length - 1; index >= 0; index--) {
            const event = submissionHistory[index] || {};
            if (!['submitted_for_qa', 'correction_submitted'].includes(String(event.event || event.type || '').toLowerCase())) continue;
            submittedAt = event.ts || event.date || event.created_at || '';
            if (submittedAt) break;
          }
        }
        if (technicianEmail && !workerMap[technicianEmail]) {
          workerMap[technicianEmail] = {
            email: technicianEmail,
            name: technicianName,
            role: 'technician',
            projects: [],
            qa_items: [],
            drafter_rank: q.drafter_rank || q.technician_rank || q.measurement_technician_rank || '',
            on_break: false,
            break_started_at: null,
          };
        }
        if (technicianEmail && submittedAt) {
          const worker = workerMap[technicianEmail];
          const submittedMs = this.timerTimestampMs(submittedAt);
          const terminalMs = this.timerTimestampMs(worker.last_terminal_completion_at);
          if (submittedMs && (!terminalMs || submittedMs > terminalMs)) {
            worker.last_terminal_completion_at = new Date(submittedMs).toISOString();
          }
        }

        const qaClaimer = (q.qa_claimed_by_email || '').toLowerCase().trim();
        if (!qaClaimer) return;
        if (!workerMap[qaClaimer]) {
          workerMap[qaClaimer] = {
            email: qaClaimer,
            name: q.qa_claimed_by_name || qaClaimer,
            role: 'qa',
            projects: [],
            qa_items: [],
            drafter_rank: q.drafter_rank || q.technician_rank || q.measurement_technician_rank || '',
            on_break: false,
            break_started_at: null,
          };
        }
        workerMap[qaClaimer].role = 'qa';
        workerMap[qaClaimer].qa_items.push(q);
      });

      // Manager sign-off intentionally has no exclusive QA claim. Correlate a
      // reviewer's fresh QA heartbeat with the manager-review project they
      // currently have open so active sign-off work still appears here.
      const managerReviewById = new Map(qaItems
        .filter(item => String(item?.status || '').trim().toLowerCase() === 'awaiting_manager_review')
        .map(item => [String(item?.id || '').trim(), item])
        .filter(([id]) => id));
      const managerPresenceWindowMs = 5 * 60 * 1000;
      dashboardRoster.forEach(person => {
        const email = String(person?.email || '').toLowerCase().trim();
        const projectId = String(person?.qa_heartbeat_current_folder || '').trim();
        const project = managerReviewById.get(projectId);
        const heartbeatAt = person?.last_qa_heartbeat_at || person?.last_qa_activity_at || '';
        const heartbeatMs = this.timerTimestampMs(heartbeatAt);
        const heartbeatAge = Date.now() - heartbeatMs;
        if (!email || !project || !heartbeatMs || heartbeatAge < -60000 || heartbeatAge > managerPresenceWindowMs) return;

        if (!workerMap[email]) {
          const rawRole = String(person?.role || '').toLowerCase().trim();
          const role = ROLE_LABELS[rawRole] ? rawRole : 'qa';
          workerMap[email] = {
            email,
            name: person.name || email,
            role,
            projects: [],
            qa_items: [],
            drafter_rank: '',
            on_break: !!person.on_break,
            break_started_at: person.break_started_at || null,
            last_activity_at: person.last_activity_at || heartbeatAt,
          };
        }
        const worker = workerMap[email];
        if (!worker.qa_items.some(item => String(item?.id || '') === projectId)) {
          worker.qa_items.push({
            ...project,
            dashboard_activity_kind: 'manager_signoff',
          });
        }
      });

      // Fold the useful session totals into the active worker header so the
      // dashboard does not need a separate, repetitive stats panel.
      completedToday.forEach(p => {
        const techEmail = String(p.assigned_to_email || '').toLowerCase().trim();
        const completedAt = p.completed_at || p.qa_approved_at || p.uploaded_at || p.updated_at || '';
        if (techEmail && !workerMap[techEmail]) {
          workerMap[techEmail] = {
            email: techEmail,
            name: p.assigned_to_name || techEmail,
            role: 'technician',
            projects: [],
            qa_items: [],
            drafter_rank: p.drafter_rank || p.technician_rank || p.measurement_technician_rank || '',
            on_break: false,
            break_started_at: null,
          };
        }
        if (techEmail) {
          const worker = workerMap[techEmail];
          if (!productionStats) {
            worker.completed_today = Number(worker.completed_today || 0) + 1;
            worker.points_completed_today = Number(worker.points_completed_today || 0) + completedProjectPoints(p);
          }
          if (completedAt) {
            const completedMs = this.timerTimestampMs(completedAt);
            const terminalMs = this.timerTimestampMs(worker.last_terminal_completion_at);
            if (completedMs && (!terminalMs || completedMs > terminalMs)) {
              worker.last_terminal_completion_at = new Date(completedMs).toISOString();
            }
            if (!productionStats) {
              const firstMs = this.timerTimestampMs(worker.first_completion_at);
              const lastMs = this.timerTimestampMs(worker.last_completion_at);
              if (completedMs && (!firstMs || completedMs < firstMs)) worker.first_completion_at = new Date(completedMs).toISOString();
              if (completedMs && (!lastMs || completedMs > lastMs)) worker.last_completion_at = new Date(completedMs).toISOString();
            }
          }
        }

        const qaEmail = String(p.qa_approved_by_email || p.qa_approved_by || '').toLowerCase().trim();
        if (qaEmail && !workerMap[qaEmail]) {
          workerMap[qaEmail] = {
            email: qaEmail,
            name: p.qa_approved_by_name || p.qa_reviewer_name || qaEmail,
            role: 'qa',
            projects: [],
            qa_items: [],
            drafter_rank: '',
            on_break: false,
            break_started_at: null,
          };
        }
        if (!productionStats && qaEmail) {
          const qaWorker = workerMap[qaEmail];
          qaWorker.role = 'qa';
          qaWorker.qa_approved_today = Number(qaWorker.qa_approved_today || 0) + 1;
          qaWorker.points_completed_today = Number(qaWorker.points_completed_today || 0) + completedProjectPoints(p);
          const approvedAt = p.qa_approved_at || p.qa_reviewed_at || p.completed_at || p.updated_at || '';
          const approvedMs = this.timerTimestampMs(approvedAt);
          const lastApprovedMs = this.timerTimestampMs(qaWorker.last_qa_approval_at);
          if (approvedMs && (!lastApprovedMs || approvedMs > lastApprovedMs)) {
            qaWorker.last_qa_approval_at = new Date(approvedMs).toISOString();
          }
        }
      });

      if (productionStats) {
        const technicianRows = Array.isArray(productionStats.technicians)
          ? productionStats.technicians
          : (Array.isArray(productionStats.leaderboard) ? productionStats.leaderboard : []);
        technicianRows.forEach(row => {
          const email = String(row?.email || '').toLowerCase().trim();
          if (!email) return;
          if (!workerMap[email]) {
            workerMap[email] = {
              email,
              name: row.name || email,
              role: 'technician',
              projects: [],
              qa_items: [],
              drafter_rank: this.rankForEmail(email),
              on_break: false,
              break_started_at: null,
            };
          }
          const worker = workerMap[email];
          worker.completed_today = Number(row.completed_count || 0);
          const rowPoints = Number(row.points);
          worker.points_completed_today = Number.isFinite(rowPoints) && rowPoints > 0
            ? rowPoints
            : completedToday.reduce((sum, project) => {
                const projectEmail = String(project?.assigned_to_email || '').toLowerCase().trim();
                return projectEmail === email ? sum + completedProjectPoints(project) : sum;
              }, 0);
          worker.first_completion_at = row.first_submission_at || '';
          worker.last_completion_at = row.last_submission_at || '';
        });

        (Array.isArray(productionStats.qa_stats) ? productionStats.qa_stats : []).forEach(row => {
          const email = String(row?.email || '').toLowerCase().trim();
          if (!email) return;
          if (!workerMap[email]) {
            workerMap[email] = {
              email,
              name: row.name || email,
              role: 'qa',
              projects: [],
              qa_items: [],
              drafter_rank: '',
              on_break: false,
              break_started_at: null,
            };
          }
          const worker = workerMap[email];
          worker.role = 'qa';
          worker.qa_approved_today = Number(row.approved_count || 0);
          const rowPoints = Number(row.points);
          worker.points_completed_today = Number.isFinite(rowPoints) && rowPoints > 0
            ? rowPoints
            : completedToday.reduce((sum, project) => {
                const projectEmail = String(project?.qa_approved_by_email || project?.qa_approved_by || '').toLowerCase().trim();
                return projectEmail === email ? sum + completedProjectPoints(project) : sum;
              }, 0);
          worker.last_qa_approval_at = row.shift_end_at || row.last_approval_at || '';
          worker.qa_shift_start_at = row.shift_start_at || '';
          worker.qa_shift_date = row.shifts?.[0]?.date || productionStats.qa_shift_date || '';
        });
      }

      // Cross-reference with schedule data for break status
      this.schedules.forEach(s => {
        const email = (s.email || '').toLowerCase().trim();
        if (workerMap[email]) {
          workerMap[email].drafter_rank = s.drafter_rank || workerMap[email].drafter_rank || '';
          // If we have schedule data, we can look up break status from the last
          // active data call — but break status comes from user data, not schedules.
        }
      });

      // The active dashboard can load without the Shifts schedule view ever
      // being opened. Apply the separately fetched user roster so a missing
      // rank on queue/status records never gets presented as level 1.
      Object.values(workerMap).forEach(worker => {
        const rosterRank = this.rankForEmail(worker.email);
        if (rosterRank) worker.drafter_rank = rosterRank;
      });

      const workers = Object.values(workerMap);

      // ---- AFK DETECTION ----
      this.detectAfkWorkers(workers);

      const visibleWorkers = workers;

      if (visibleWorkers.length === 0) {
        el.innerHTML = '<div class="sh-empty">No one is currently working on projects.</div>';
        return;
      }

      // Group by role
      const byRole = {};
      visibleWorkers.forEach(w => {
        const role = w.role || 'technician';
        if (!byRole[role]) byRole[role] = [];
        byRole[role].push(w);
      });

      // Sort within each role: active first, then AFK
      Object.values(byRole).forEach(arr => {
        arr.sort((a, b) => {
          if (a.is_afk !== b.is_afk) return a.is_afk ? 1 : -1;
          return (b.projects.length + b.qa_items.length) - (a.projects.length + a.qa_items.length);
        });
      });

      let html = '';
      const roleOrder = ['manager','qa','technician'];
      const now = Date.now();

      roleOrder.forEach(role => {
        const allPeople = byRole[role] || [];
        if (!allPeople.length) return;
        const supportsInactiveToggle = ['technician', 'qa'].includes(role);
        const showInactive = !supportsInactiveToggle || this.showInactiveByRole[role] !== false;
        const people = showInactive
          ? allPeople
          : allPeople.filter(w => w.projects.length > 0 || w.qa_items.length > 0);
        const color = ROLE_COLORS[role] || '#5f6368';
        const icon  = ROLE_ICONS[role] || 'fa-user';
        const label = ROLE_LABELS[role] || role;
        const afkCount = allPeople.filter(w => w.is_afk).length;
        const inactiveCount = allPeople.filter(w => w.projects.length === 0 && w.qa_items.length === 0).length;

        html += `<div class="sh-role-group">`;
        html += `<div class="sh-role-header">`;
        html += `<div class="sh-role-heading" style="color:${color};"><i class="fas ${icon}"></i> ${label} <span class="sh-role-count">(${allPeople.length}${afkCount > 0 ? `, ${afkCount} AFK` : ''})</span></div>`;
        if (supportsInactiveToggle) {
          html += `<button type="button" class="sh-inactive-toggle${showInactive ? ' is-on' : ''}" onclick="Shifts.toggleInactive('${role}')" aria-pressed="${showInactive ? 'true' : 'false'}" title="${showInactive ? 'Hide' : 'Show'} ${inactiveCount} inactive ${label.toLowerCase()}${inactiveCount === 1 ? '' : 's'}"><span>Show inactive</span><span class="sh-switch-track" aria-hidden="true"><span class="sh-switch-knob"></span></span></button>`;
        }
        html += `</div>`;
        html += `<div class="sh-role-people">`;

        people.forEach(w => {
          const cardCls = w.is_afk ? 'sh-person-card sh-person-afk' : 'sh-person-card sh-person-active';
          html += `<div class="${cardCls}">`;
          html += `<div class="sh-person-title">`;
          html += `<div class="sh-person-name-row"><div class="sh-person-name">${Portal.escapeHtml(w.name)}</div><span class="sh-presence-dot ${w.is_afk ? 'is-afk' : 'is-active'}" title="${w.is_afk ? 'AFK' : 'Active'}" aria-label="${w.is_afk ? 'AFK' : 'Active'}"></span></div>`;
          html += `<div class="sh-person-title-meta">${this.drafterRankPillHtml(w.drafter_rank, w.role === 'technician')}${this.workerStatsPillsHtml(w, now)}</div>`;
          html += `</div>`;

          html += `<div class="sh-person-work-grid">`;

          if (w.projects.length > 0) {
            w.projects.forEach(p => {
              const addr = p.address || p.id || 'Unknown';
              const startedAt = this.activeProjectStartedAt(p, 'in_progress');
              const startedDate = startedAt ? new Date(startedAt) : null;
              const elapsed = startedDate && !Number.isNaN(startedDate.getTime()) ? (now - startedDate.getTime()) : 0;
              html += this.activeProjectTileHtml(p, {
                kind: 'in_progress',
                color,
                elapsed,
                elapsedWarn: w.is_afk,
                startedAt,
                address: addr,
              });
            });
          }

          if (w.qa_items.length > 0) {
            w.qa_items.forEach(p => {
              const activityKind = p.dashboard_activity_kind === 'manager_signoff' ? 'manager_signoff' : 'qa_active';
              const claimedAt = this.activeProjectStartedAt(p, activityKind);
              const claimedDate = claimedAt ? new Date(claimedAt) : null;
              const elapsed = claimedDate ? (now - claimedDate.getTime()) : 0;
              html += this.activeProjectTileHtml(p, {
                kind: activityKind,
                color: activityKind === 'manager_signoff' ? (ROLE_COLORS[w.role] || ROLE_COLORS.qa) : ROLE_COLORS.qa,
                elapsed,
                elapsedWarn: w.is_afk,
                startedAt: claimedAt,
                address: p.address || p.id || 'Unknown',
              });
            });
          }

          if (w.projects.length === 0 && w.qa_items.length === 0) {
            const betweenSince = ['technician','qa'].includes(w.role) ? this.workerBetweenAssignmentsSince(w) : '';
            const betweenDate = betweenSince ? new Date(betweenSince) : null;
            const betweenElapsed = betweenDate && !Number.isNaN(betweenDate.getTime()) ? Math.max(0, now - betweenDate.getTime()) : 0;
            html += `
              <div class="sh-work-tile sh-work-tile-empty" aria-label="${Portal.escapeHtml(w.name)} has no active project">
                <i class="fas fa-mug-hot"></i>
                <div class="sh-work-empty-copy">
                  <div class="sh-work-empty-title">No active project</div>
                  <div class="sh-work-empty-sub">Between assignments</div>
                </div>
                ${betweenSince ? `<div class="sh-work-empty-timer" title="Time between assignments"><span class="sh-tick" data-started="${Portal.escapeHtml(betweenSince)}">${this.fmtElapsed(betweenElapsed)}</span></div>` : ''}
              </div>
            `;
          }

          html += `</div>`;

          html += `</div>`;
        });

        if (!people.length && inactiveCount > 0) {
          html += `<div class="sh-role-filter-empty">Inactive ${Portal.escapeHtml(label.toLowerCase())}s are hidden.</div>`;
        }

        html += `</div></div>`;
      });

      el.innerHTML = html;
      el.querySelectorAll('[data-sh-project-id]').forEach(tile => {
        tile.addEventListener('click', () => {
          const id = tile.getAttribute('data-sh-project-id') || '';
          const project = inProgress.concat(qaItems).find(item => String(item?.id || '') === id);
          this.openProjectDetails(id, project || null);
        });
      });
    },

    workerStatsPillsHtml(worker, now = Date.now()){
      const w = worker || {};
      if (w.role === 'qa') {
        const points = Number(w.points_completed_today || 0);
        const display = formatCompletedPoints(points);
        const shiftLabel = w.qa_shift_date ? `shift starting ${w.qa_shift_date}` : 'current shift';
        return `<span class="sh-worker-stat-pill qa" title="${display} points completed in the ${shiftLabel}" aria-label="${display} points completed in the ${shiftLabel}"><i class="fas fa-clipboard-check"></i>${display} pts</span>`;
      }

      const points = Number(w.points_completed_today || 0);
      const pointsDisplay = formatCompletedPoints(points);
      const pills = [];
      if (w.first_completion_at) {
        const first = new Date(w.first_completion_at);
        if (!Number.isNaN(first.getTime())) {
          const elapsedHours = Math.max((now - first.getTime()) / 3600000, 0.1);
          const rate = (points / elapsedHours).toFixed(1);
          pills.push(`<span class="sh-worker-stat-pill rate" title="Point completion rate: ${rate} points per hour" aria-label="Point completion rate ${rate} points per hour"><i class="fas fa-gauge-high"></i>${rate} pts/h</span>`);
        }
      }
      pills.push(`<span class="sh-worker-stat-pill total" title="${pointsDisplay} points completed today" aria-label="${pointsDisplay} points completed today"><i class="fas fa-check"></i>${pointsDisplay} pts</span>`);
      return pills.join('');
    },

    workerBetweenAssignmentsSince(worker){
      const w = worker || {};
      const now = Date.now();
      const lastWorkMs = w.role === 'qa'
        ? this.timerTimestampMs(w.last_qa_approval_at)
        : Math.max(
            this.timerTimestampMs(w.last_completion_at),
            this.timerTimestampMs(w.last_terminal_completion_at)
          );
      if (lastWorkMs && lastWorkMs <= now + 60000) return new Date(lastWorkMs).toISOString();

      const blocks = Array.isArray(w.shift_blocks) ? w.shift_blocks : [];
      const serverToday = String(w.shift_status_today || '').trim();
      const starts = blocks.map(block => String(block?.start || '').trim()).filter(Boolean).sort();
      if (serverToday && starts.length) {
        const localStart = this.serverToLocal(serverToday, starts[0]);
        if (localStart?.date && localStart?.time) {
          const shiftStart = `${localStart.date}T${localStart.time}:00`;
          const shiftStartMs = this.timerTimestampMs(shiftStart, false);
          if (shiftStartMs && shiftStartMs <= now + 60000) return new Date(shiftStartMs).toISOString();
        }
      }

      const lastActivityMs = this.timerTimestampMs(w.last_activity_at);
      return lastActivityMs && lastActivityMs <= now + 60000 ? new Date(lastActivityMs).toISOString() : '';
    },

    timerTimestampMs(value, assumeUtc=true){
      if (!value) return 0;
      if (assumeUtc && window.Projects && typeof window.Projects.safeParseTs === 'function') {
        return window.Projects.safeParseTs(value) || 0;
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
      let raw = String(value || '').trim();
      if (!raw) return 0;
      if (assumeUtc && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
        raw = raw.replace(' ', 'T') + 'Z';
      }
      const parsed = new Date(raw).getTime();
      return Number.isNaN(parsed) ? 0 : parsed;
    },

    activeProjectStartedAt(project, kind = 'in_progress'){
      const p = project || {};
      if (kind === 'manager_signoff') {
        return p.manager_review_started_at || '';
      }
      if (kind === 'qa_active') {
        return p.qa_claimed_at || p.qa_claim_at || p.qa_in_progress_at || p.qa_at || p.awaiting_review_at || '';
      }
      if (window.Projects && typeof window.Projects.getInProgressStageEnteredTs === 'function') {
        const resolved = window.Projects.getInProgressStageEnteredTs(p);
        if (resolved) return new Date(resolved).toISOString();
      }
      const direct = p.started_at || p.startedAt || p.in_progress_at || p.inProgressAt || p.working_at || p.claimed_at || p.claimedAt || p.assigned_at || p.assignedAt || '';
      if (direct) return direct;
      const history = Array.isArray(p.work_history)
        ? p.work_history
        : (Array.isArray(p.workflow?.history) ? p.workflow.history : []);
      for (let index = history.length - 1; index >= 0; index--) {
        const event = history[index] || {};
        if (['claimed_new','claimed_correction'].includes(String(event.event || ''))) {
          return event.ts || event.date || event.created_at || '';
        }
      }
      return p.created_at || '';
    },

    activeProjectPriority(project){
      if (window.Projects && typeof window.Projects.reportExpeditePriorityLevel === 'function') {
        return window.Projects.reportExpeditePriorityLevel(project);
      }
      const p = project || {};
      const raw = parseInt(p.priority_level || p.queue_priority_level || '', 10);
      if ([1,2,3].includes(raw)) return raw;
      if (p.qa_priority || p.manual_priority || p.prioritized) return 1;
      const option = String(p.report_expedite_option || '').toLowerCase();
      if (option.includes('under_1') || option === 'rush_1_2' || option === 'rush_1_1_5') return 1;
      if (p.is_expedited || option.includes('1_3') || option === 'rush_2_3') return 2;
      return p.is_vip ? 2 : 3;
    },

    activeProjectComplexity(project){
      const raw = project?.complexity;
      if (typeof raw === 'number') return Math.max(1, Math.min(5, Math.round(raw)));
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) return Math.max(1, Math.min(5, parsed));
      if (String(raw || '').toLowerCase() === 'simple') return 1;
      return 3;
    },

    activeProjectPoints(project){
      const p = project || {};
      const direct = Number(p.point_value ?? p.project_points ?? p.points_value ?? p.points);
      if (Number.isFinite(direct) && direct > 0) return direct;

      const raw = String(p.complexity ?? '').trim().toLowerCase();
      if (!raw) return null;
      const normalized = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const numeric = Number(raw);
      const key = Number.isFinite(numeric) ? numeric : normalized;
      const complexityPoints = {
        1:2, 2:3, 3:4, 4:6, 5:10,
        very_simple:2, very_simple_project:2,
        simple:3, simple_project:3,
        standard:4, standard_project:4,
        complex:6, complex_project:6,
        very_complex:10, very_complex_project:10,
      };
      const points = complexityPoints[key];
      return Number.isFinite(points) && points > 0 ? points : null;
    },

    technicianSpeedBand(project, elapsedMs){
      return this.projectSpeedBand(project, elapsedMs, 1);
    },

    qaSpeedBand(project, elapsedMs){
      // QA is expected to take one-third of the point-based drafting time.
      return this.projectSpeedBand(project, elapsedMs, 1 / 3);
    },

    projectSpeedBand(project, elapsedMs, timeScale = 1){
      const points = this.activeProjectPoints(project);
      const elapsed = Number(elapsedMs);
      const scale = Number(timeScale);
      if (!Number.isFinite(points) || points <= 0 || !Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(scale) || scale <= 0) return null;
      // Keep these boundaries aligned with the editor payout timeline:
      // drafting uses 6, 9, 12, and 18 cumulative minutes per point;
      // QA applies the same bands and colors at one-third of those times.
      const boundaries = [6, 9, 12, 18].map(minutesPerPoint => minutesPerPoint * scale * points * 60000);
      const bands = [
        { key:'very-fast', label:'Very Fast' },
        { key:'fast', label:'Fast' },
        { key:'medium', label:'Medium' },
        { key:'slow', label:'Slow' },
      ];
      for (let index = 0; index < boundaries.length; index++) {
        if (elapsed <= boundaries[index]) return { ...bands[index], points };
      }
      return { key:'very-slow', label:'Very Slow', points };
    },

    activeProjectTagsHtml(project, kind){
      const p = project || {};
      const priority = this.activeProjectPriority(p);
      const complexity = this.activeProjectComplexity(p);
      const type = String(p.project_type || 'residential').toLowerCase();
      const typeLabel = { residential:'RES', commercial:'COM', multifamily:'MF' }[type] || type.toUpperCase();
      const tags = [
        `<span class="sh-work-tag priority p${priority}">P${priority}</span>`,
        `<span class="sh-work-tag complexity">${'●'.repeat(complexity)}${'○'.repeat(5-complexity)} ${complexity}</span>`,
        `<span class="sh-work-tag type">${Portal.escapeHtml(typeLabel)}</span>`,
      ];
      if (p.qa_priority || p.manual_priority || p.prioritized) tags.push('<span class="sh-work-tag urgent">PRIORITY</span>');
      if (p.is_vip) tags.push('<span class="sh-work-tag vip">⭐ VIP</span>');
      if (p.is_filler) tags.push('<span class="sh-work-tag filler">FILLER</span>');
      if (p.is_rework || p.rework || p.correction_requested_at || String(p.status || '').toLowerCase() === 'requeue') tags.push('<span class="sh-work-tag rework"><i class="fas fa-rotate-left"></i> REWORK</span>');
      const pins = Array.isArray(p.pins) ? p.pins.length : 0;
      const cc = Array.isArray(p.cc_emails) ? p.cc_emails.length : 0;
      if (pins > 1) tags.push(`<span class="sh-work-tag neutral">${pins} PINS</span>`);
      if (cc) tags.push(`<span class="sh-work-tag neutral">CC:${cc}</span>`);
      return tags.join('');
    },

    activeProjectTileHtml(project, options = {}){
      const p = project || {};
      const id = String(p.id || '');
      const address = options.address || p.address || id || 'Unknown project';
      const elapsed = Number(options.elapsed || 0);
      const elapsedCls = options.elapsedWarn ? 'sh-project-elapsed sh-elapsed-warn' : 'sh-project-elapsed';
      const timeLabel = options.kind === 'manager_signoff'
        ? 'Manager sign-off'
        : (options.kind === 'qa_active' ? 'Reviewing' : 'Working');
      const speedBand = options.kind === 'in_progress'
        ? this.technicianSpeedBand(p, elapsed)
        : (options.kind === 'qa_active' ? this.qaSpeedBand(p, elapsed) : null);
      const speedClass = speedBand && ['medium','slow','very-slow'].includes(speedBand.key) ? ` sh-speed-${speedBand.key}` : '';
      const paceOwner = options.kind === 'qa_active' ? 'QA' : 'Technician';
      const tileTitle = speedBand
        ? `Open project details — ${paceOwner} ${speedBand.label.toLowerCase()} pace (${speedBand.points} points)`
        : 'Open project details';
      return `
        <button type="button" class="sh-work-tile${speedClass}" data-sh-project-id="${Portal.escapeHtml(id)}" title="${Portal.escapeHtml(tileTitle)}">
          <div class="sh-work-tags">${this.activeProjectTagsHtml(p, options.kind)}</div>
          <div class="sh-work-address"><span title="${Portal.escapeHtml(address)}">${Portal.escapeHtml(address)}</span></div>
          <div class="sh-work-meta"><span>${timeLabel}</span>${elapsed > 0 ? `<span class="${elapsedCls}"><span class="sh-tick" data-started="${Portal.escapeHtml(options.startedAt || '')}">${this.fmtElapsed(elapsed)}</span></span>` : ''}</div>
        </button>
      `;
    },

    openProjectDetails(id, project){
      if (!id) return;
      if (window.Projects && typeof window.Projects.openProjectModal === 'function') {
        window.Projects.openProjectModal(id, { project: project || undefined }).catch(() => {});
      }
    },

    /** Truncate a long address for display in the compact card */
    _truncateAddr(addr) {
      if (!addr) return 'Unknown';
      if (addr.length <= 35) return addr;
      return addr.substring(0, 32) + '…';
    },

    // ================================================================
    //  RENDER: SESSION STATS  (from queue_admin_overview)
    // ================================================================
    renderSessionStats(data){
      const el = document.getElementById('shiftStatsBody');
      if (!el) return;

      const inProgress     = data.in_progress || [];
      const qaItems        = data.qa || [];
      const completedToday = data.completed_today || [];
      const completedAny   = data.completed_any || [];

      const statsMap = {};

      const ensureWorker = (email, name, role) => {
        email = (email || '').toLowerCase().trim();
        if (!email) return null;
        if (!statsMap[email]) {
          statsMap[email] = {
            email,
            name: name || email,
            role: role || 'technician',
            completed_today: 0,
            completed_any: 0,
            qa_approved_today: 0,
            current_projects: [],
            qa_reviewing: [],
            first_completion_at: null,
            last_completion_at: null,
          };
        }
        if (name && name !== email) statsMap[email].name = name;
        return statsMap[email];
      };

      completedToday.forEach(p => {
        const w = ensureWorker(p.assigned_to_email, p.assigned_to_name, 'technician');
        if (!w) return;
        w.completed_today++;
        const cAt = p.completed_at ? new Date(p.completed_at) : null;
        if (cAt) {
          if (!w.first_completion_at || cAt < new Date(w.first_completion_at)) w.first_completion_at = p.completed_at;
          if (!w.last_completion_at  || cAt > new Date(w.last_completion_at))  w.last_completion_at  = p.completed_at;
        }

        const qaBy = (p.qa_approved_by || '').toLowerCase().trim();
        if (qaBy) {
          const qaW = ensureWorker(qaBy, p.qa_approved_by_name, 'qa');
          if (qaW) {
            qaW.qa_approved_today++;
            qaW.role = 'qa';
          }
        }
      });

      inProgress.forEach(p => {
        const w = ensureWorker(p.assigned_to_email, p.assigned_to_name, 'technician');
        if (w) w.current_projects.push(p);
      });

      qaItems.forEach(q => {
        const email = (q.qa_claimed_by_email || '').toLowerCase().trim();
        if (!email) return;
        const w = ensureWorker(email, q.qa_claimed_by_name, 'qa');
        if (w) { w.qa_reviewing.push(q); w.role = 'qa'; }
      });

      const workers = Object.values(statsMap);

      const active = workers.filter(w =>
        w.completed_today > 0 ||
        w.qa_approved_today > 0 ||
        w.current_projects.length > 0 ||
        w.qa_reviewing.length > 0
      );

      if (active.length === 0) {
        el.innerHTML = '<div class="sh-empty">No active workers today.</div>';
        return;
      }

      active.sort((a, b) => {
        const totalA = a.completed_today + a.qa_approved_today;
        const totalB = b.completed_today + b.qa_approved_today;
        if (totalB !== totalA) return totalB - totalA;
        return (a.name || '').localeCompare(b.name || '');
      });

      let html = '<div class="sh-stat-cards-wrap">';
      active.forEach(w => {
        const role = w.role || 'technician';
        const color = ROLE_COLORS[role] || '#5f6368';
        const icon  = ROLE_ICONS[role] || 'fa-user';
        const totalDone = w.completed_today + w.qa_approved_today;

        html += `<div class="sh-stat-card">`;
        html += `<div class="sh-stat-header">`;
        html += `<div class="sh-stat-name"><i class="fas ${icon}" style="color:${color};"></i> ${Portal.escapeHtml(w.name)}</div>`;
        html += `<div class="sh-stat-role" style="color:${color};">${ROLE_LABELS[role] || role}</div>`;
        html += `</div>`;

        html += `<div class="sh-stat-cats">`;
        if (w.completed_today > 0) {
          html += `<div class="sh-stat-cat"><span class="sh-stat-cat-dot" style="background:${ROLE_COLORS.technician};"></span> Completed: <b>${w.completed_today}</b></div>`;
        }
        if (w.qa_approved_today > 0) {
          html += `<div class="sh-stat-cat"><span class="sh-stat-cat-dot" style="background:${ROLE_COLORS.qa};"></span> QA Approved: <b>${w.qa_approved_today}</b></div>`;
        }
        html += `</div>`;

        if (w.first_completion_at) {
          const firstT = new Date(w.first_completion_at);
          const elapsed = (Date.now() - firstT.getTime()) / 3600000;
          const rate = elapsed > 0.1 ? (totalDone / elapsed).toFixed(1) : '—';
          html += `<div class="sh-stat-rate">${rate}/hr &middot; ${totalDone} total today</div>`;
          html += `<div class="sh-stat-meta">First completion: ${firstT.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}</div>`;
        } else if (totalDone === 0) {
          html += `<div class="sh-stat-none">No completions yet today</div>`;
        }

        if (w.current_projects.length > 0) {
          w.current_projects.forEach(p => {
            const addr = p.address || p.id || '';
            const startedAt = p.started_at ? new Date(p.started_at) : null;
            const elapsed = startedAt ? (Date.now() - startedAt.getTime()) : 0;
            html += `<div class="sh-stat-current"><i class="fas fa-drafting-compass"></i> Working: ${Portal.escapeHtml(this._truncateAddr(addr))}`;
            if (elapsed > 0) html += ` (<span class="sh-tick" data-started="${Portal.escapeHtml(p.started_at || '')}">${this.fmtElapsed(elapsed)}</span>)`;
            html += `</div>`;
          });
        }

        if (w.qa_reviewing.length > 0) {
          html += `<div class="sh-stat-current" style="color:${ROLE_COLORS.qa};"><i class="fas fa-clipboard-check"></i> Reviewing ${w.qa_reviewing.length} item${w.qa_reviewing.length > 1 ? 's' : ''}</div>`;
        }

        html += `</div>`;
      });

      html += '</div>';
      el.innerHTML = html;
    },

    // ================================================================
    //  LEGACY RENDERERS (fallback when queue_admin_overview unavailable)
    // ================================================================

    /** Legacy: render from shift_current_status data */
    _renderLegacyCurrentStatus(data){
      const el = document.getElementById('shiftStatusBody');
      if (!el) return;

      const byRole = data.by_role || {};
      const allOnShift = data.on_shift || [];
      const serverToday = data.today || '';

      if (allOnShift.length === 0){
        el.innerHTML = '<div class="sh-empty">No one currently on shift.</div>';
        return;
      }

      let html = '';
      const roleOrder = ['manager','qa','technician'];
      roleOrder.forEach(role => {
        const people = byRole[role] || [];
        if (!people.length) return;
        const color = ROLE_COLORS[role]||'#5f6368';
        const icon  = ROLE_ICONS[role]||'fa-user';
        const label = ROLE_LABELS[role]||role;

        html += `<div class="sh-role-group">`;
        html += `<div class="sh-role-header" style="color:${color};"><i class="fas ${icon}"></i> ${label} <span class="sh-role-count">(${people.length})</span></div>`;
        html += `<div class="sh-role-people">`;
        people.forEach(p => {
          const onBreak = p.on_break;
          const statusCls = onBreak ? 'sh-person-break' : 'sh-person-active';
          const localBlocks = (p.shift_blocks||[]).map(b => {
            const ls = this.serverToLocal(serverToday, b.start);
            let endD = serverToday;
            if (b.end < b.start) endD = addDaysYMD(serverToday, 1);
            const le = this.serverToLocal(endD, b.end);
            return `${ls.time}–${le.time}`;
          });
          const blockLabel = localBlocks.join(', ');
          const pRank = p.drafter_rank || p.technician_rank || this.rankForEmail(p.email);

          html += `<div class="sh-person-card ${statusCls}">`;
          html += `<div class="sh-person-title"><div class="sh-person-name">${Portal.escapeHtml(p.name)}</div>${this.drafterRankPillHtml(pRank, role === 'technician')}</div>`;
          html += `<div class="sh-person-time">${blockLabel}</div>`;
          if (onBreak){
            const breakMs = p.break_started_at ? (Date.now() - new Date(p.break_started_at).getTime()) : 0;
            html += `<div class="sh-person-status break"><i class="fas fa-mug-hot"></i> On break <span class="sh-tick" data-started="${Portal.escapeHtml(p.break_started_at||'')}">${this.fmtElapsed(breakMs)}</span></div>`;
          } else {
            html += `<div class="sh-person-status active"><i class="fas fa-circle" style="font-size:7px;"></i> Active</div>`;
          }
          html += `</div>`;
        });
        html += `</div></div>`;
      });
      el.innerHTML = html;
    },

    /** Legacy: render from shift_session_stats data */
    _renderLegacySessionStats(data){
      const el = document.getElementById('shiftStatsBody');
      if (!el) return;
      const stats = data.stats || [];
      if (!stats.length){
        el.innerHTML = '<div class="sh-empty">No active workers.</div>';
        return;
      }
      stats.sort((a,b) => (b.total_done||0) - (a.total_done||0));
      let html = '<div class="sh-stat-cards-wrap">';
      stats.forEach(s => {
        const role = s.shift_role||'technician';
        const color = ROLE_COLORS[role]||'#5f6368';
        const icon  = ROLE_ICONS[role]||'fa-user';
        const cats = s.categories||{};
        const totalDone = s.total_done||0;
        const rate = s.rate_per_hour||0;
        const onBreak = !!s.on_break;

        html += `<div class="sh-stat-card">`;
        html += `<div class="sh-stat-header">`;
        html += `<div class="sh-stat-name"><i class="fas ${icon}" style="color:${color};"></i> ${Portal.escapeHtml(s.name||s.email)}</div>`;
        html += `<div class="sh-stat-role" style="color:${color};">${ROLE_LABELS[role]||role}</div>`;
        html += `</div>`;
        if (onBreak){
          const breakMs = s.break_started_at ? (Date.now() - new Date(s.break_started_at).getTime()) : 0;
          html += `<div class="sh-stat-break"><i class="fas fa-mug-hot"></i> On break: <span class="sh-tick" data-started="${Portal.escapeHtml(s.break_started_at||'')}">${this.fmtElapsed(breakMs)}</span></div>`;
        }
        if (totalDone > 0){
          html += `<div class="sh-stat-cats">`;
          Object.entries(cats).forEach(([cat,count]) => {
            const catColor = ROLE_COLORS[cat]||'#333';
            const catLabel = ROLE_LABELS[cat]||cat;
            html += `<div class="sh-stat-cat"><span class="sh-stat-cat-dot" style="background:${catColor};"></span> ${catLabel}: <b>${count}</b></div>`;
          });
          html += `</div>`;
          html += `<div class="sh-stat-rate">${rate.toFixed(1)}/hr &middot; ${totalDone} total</div>`;
        } else {
          html += `<div class="sh-stat-none">No projects completed yet</div>`;
        }
        if (s.first_project_at){
          const firstT = new Date(s.first_project_at);
          html += `<div class="sh-stat-meta">Started first project: ${firstT.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</div>`;
        }
        if (s.current_project){
          const curStarted = s.current_project_started_at ? new Date(s.current_project_started_at) : null;
          const elapsed = curStarted ? (Date.now()-curStarted.getTime()) : 0;
          html += `<div class="sh-stat-current"><i class="fas fa-drafting-compass"></i> Working on project`;
          if (elapsed > 0) html += ` (<span class="sh-tick" data-started="${Portal.escapeHtml(s.current_project_started_at||'')}">${this.fmtElapsed(elapsed)}</span>)`;
          html += `</div>`;
        }
        html += `</div>`;
      });
      html += '</div>';
      el.innerHTML = html;
    },

    // ================================================================
    //  DAY EDITOR MODAL  (user edits in LOCAL time, saved in server TZ)
    //  Now passes the user's account role so new blocks default to the
    //  correct shift role.
    // ================================================================
    openDayEditor(email, name, localDateStr){
      const user = this.schedules.find(s => s.email === email);
      const dayName = this.getDayName(localDateStr);
      const dayData = user?.week?.[dayName];
      const blocks = dayData?.blocks || [];

      this.showBlockEditorModal({
        title: `${name} — ${dateFromYMD(localDateStr).toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'})}`,
        blocks: JSON.parse(JSON.stringify(blocks)),           // LOCAL times
        defaultRole: this.userDefaultShiftRole(user?.role),   // ← NEW: from account role
        onSave: async (newBlocks) => {
          // Convert local blocks → grouped by server date
          const grouped = this.localBlocksToServerByDate(localDateStr, newBlocks);

          // If the user set no blocks (day off), we still need to save an empty
          // override on the primary server date
          if (Object.keys(grouped).length === 0){
            const sd = this.localToServer(localDateStr, '12:00').date;
            grouped[sd] = [];
          }

          for (const [sd, sBlocks] of Object.entries(grouped)){
            const res = await Portal.apiPost(cfg().endpoints.server, {
              action: 'shift_save_day_override',
              target_email: email,
              date: sd,
              blocks: JSON.stringify(sBlocks),
            });
            if (!res?.success){ alert(res?.error||'Save failed'); return false; }
          }
          await this.refreshSchedules(true);
          return true;
        },
        onRevert: async () => {
          // Revert all server dates that contributed to this local day
          const serverDates = dayData?._serverDates || [];
          if (!serverDates.length) serverDates.push(this.localToServer(localDateStr,'12:00').date);
          for (const sd of serverDates){
            const res = await Portal.apiPost(cfg().endpoints.server, {
              action: 'shift_remove_day_override',
              target_email: email,
              date: sd,
            });
            if (!res?.success){ alert(res?.error||'Revert failed'); return false; }
          }
          await this.refreshSchedules(true);
          return true;
        },
        isOverride: !!dayData?.is_override,
      });
    },

    // ================================================================
    //  RECURRING EDITOR MODAL  (user edits LOCAL, saved as server TZ)
    //  Now passes the user's account role so new blocks default to the
    //  correct shift role.
    // ================================================================
    openRecurringEditor(email, name, localRecurring){
      const user = this.schedules.find(s => s.email === email);

      this.showRecurringEditorModal({
        title: `Recurring Schedule — ${name}`,
        recurring: JSON.parse(JSON.stringify(localRecurring)),   // LOCAL times
        defaultRole: this.userDefaultShiftRole(user?.role),      // ← NEW: from account role
        onSave: async (newLocalRecurring) => {
          // Convert local recurring → server recurring
          const serverRecurring = this.convertRecurringToServer(newLocalRecurring);
          const userSched = this.schedules.find(s => s.email === email);
          const overrides = userSched?.overrides || {};
          const res = await Portal.apiPost(cfg().endpoints.server, {
            action: 'shift_save_schedule',
            target_email: email,
            recurring: JSON.stringify(serverRecurring),
            overrides: JSON.stringify(overrides),
          });
          if (!res?.success){ alert(res?.error||'Save failed'); return false; }
          await this.refreshSchedules(true);
          return true;
        }
      });
    },

    // ---- GENERIC BLOCK EDITOR MODAL ----
    // `defaultRole` is the shift role to pre-select for new blocks,
    // derived from the user's account role. Existing blocks keep their
    // current role; only newly-added blocks use this default.
    showBlockEditorModal({ title, blocks, onSave, onRevert, isOverride, defaultRole }){
      let overlay = document.getElementById('shiftBlockEditorOverlay');
      if (!overlay){
        overlay = document.createElement('div');
        overlay.id = 'shiftBlockEditorOverlay';
        overlay.className = 'sh-modal-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.style.display = 'none'; });
      }

      const defRole = defaultRole || 'technician';
      let localBlocks = blocks.slice();

      const render = () => {
        let blocksHtml = '';
        localBlocks.forEach((b,i) => {
          blocksHtml += `
            <div class="sh-block-edit-row" data-idx="${i}">
              <input type="time" class="sh-input" value="${b.start}" data-field="start">
              <span>to</span>
              <input type="time" class="sh-input" value="${b.end}" data-field="end">
              <select class="sh-input sh-role-select" data-field="role">
                ${ROLES.map(r => `<option value="${r}" ${r===b.role?'selected':''}>${ROLE_LABELS[r]||r}</option>`).join('')}
              </select>
              <button class="sh-btn sh-btn-sm sh-btn-danger" data-remove="${i}" title="Remove"><i class="fas fa-trash"></i></button>
            </div>`;
        });

        let presetHtml = SHIFT_PRESETS.map((p,i) =>
          `<button class="sh-btn sh-btn-sm sh-preset-btn" data-pidx="${i}" title="Add ${p.label}"><i class="fas fa-bolt"></i> ${p.label}</button>`
        ).join('');

        overlay.innerHTML = `
          <div class="sh-modal-card">
            <div class="sh-modal-header">
              <div class="sh-modal-title">${title}</div>
              <button class="sh-modal-close" id="shBlockEdClose"><i class="fas fa-times"></i></button>
            </div>
            <div class="sh-modal-body">
              <div class="sh-tz-note"><i class="fas fa-globe"></i> Times shown in your local timezone</div>
              <div class="sh-preset-bar">
                <span class="sh-preset-label">Quick add:</span>
                ${presetHtml}
              </div>
              <div id="shBlockList">${blocksHtml || '<div class="sh-empty" style="padding:10px 0;">No shifts — day off</div>'}</div>
              <button class="sh-btn sh-btn-sm" id="shBlockAdd" style="margin-top:10px;"><i class="fas fa-plus"></i> Add Custom Block</button>
            </div>
            <div class="sh-modal-footer">
              ${isOverride ? '<button class="sh-btn sh-btn-sm" id="shBlockRevert" title="Revert to recurring schedule"><i class="fas fa-undo"></i> Revert to Recurring</button>' : '<div></div>'}
              <div style="display:flex; gap:8px;">
                <button class="sh-btn sh-btn-sm" id="shBlockCancel">Cancel</button>
                <button class="sh-btn sh-btn-sm sh-btn-primary" id="shBlockSave"><i class="fas fa-save"></i> Save</button>
              </div>
            </div>
          </div>`;
        overlay.style.display = 'flex';

        overlay.querySelector('#shBlockEdClose')?.addEventListener('click', () => overlay.style.display='none');
        overlay.querySelector('#shBlockCancel')?.addEventListener('click', () => overlay.style.display='none');

        overlay.querySelectorAll('.sh-preset-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const preset = SHIFT_PRESETS[parseInt(btn.dataset.pidx)];
            if (preset) { localBlocks.push({start:preset.start, end:preset.end, role:defRole}); render(); }
          });
        });

        overlay.querySelector('#shBlockAdd')?.addEventListener('click', () => {
          localBlocks.push({start:'09:00', end:'17:00', role:defRole});
          render();
        });

        overlay.querySelectorAll('[data-remove]').forEach(btn => {
          btn.addEventListener('click', () => { localBlocks.splice(parseInt(btn.dataset.remove),1); render(); });
        });

        overlay.querySelectorAll('.sh-block-edit-row').forEach(row => {
          const idx = parseInt(row.dataset.idx);
          row.querySelectorAll('.sh-input').forEach(inp => {
            inp.addEventListener('change', () => { localBlocks[idx][inp.dataset.field] = inp.value; });
          });
        });

        overlay.querySelector('#shBlockSave')?.addEventListener('click', async () => {
          const saveBtn = overlay.querySelector('#shBlockSave');
          if (saveBtn){ saveBtn.disabled=true; saveBtn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }
          const ok = await onSave(localBlocks);
          if (ok !== false) overlay.style.display = 'none';
          if (saveBtn){ saveBtn.disabled=false; saveBtn.innerHTML='<i class="fas fa-save"></i> Save'; }
        });

        overlay.querySelector('#shBlockRevert')?.addEventListener('click', async () => {
          if (!confirm('Revert this day to the recurring schedule?')) return;
          const ok = await onRevert();
          if (ok !== false) overlay.style.display = 'none';
        });
      };
      render();
    },

    // ---- RECURRING EDITOR MODAL ----
    // `defaultRole` is the shift role to pre-select for new blocks.
    showRecurringEditorModal({ title, recurring, onSave, defaultRole }){
      let overlay = document.getElementById('shiftRecurringEditorOverlay');
      if (!overlay){
        overlay = document.createElement('div');
        overlay.id = 'shiftRecurringEditorOverlay';
        overlay.className = 'sh-modal-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.style.display='none'; });
      }

      const defRole = defaultRole || 'technician';
      let local = {};
      DAYS.forEach(d => { local[d] = (recurring[d]||[]).map(b => ({...b})); });

      const render = () => {
        let html = `
          <div class="sh-modal-card" style="max-width:800px;">
            <div class="sh-modal-header">
              <div class="sh-modal-title">${title}</div>
              <button class="sh-modal-close" id="shRecClose"><i class="fas fa-times"></i></button>
            </div>
            <div class="sh-modal-body" style="max-height:70vh; overflow-y:auto;">
              <div class="sh-tz-note"><i class="fas fa-globe"></i> Times shown in your local timezone</div>`;

        DAYS.forEach(day => {
          const blocks = local[day]||[];
          html += `<div class="sh-rec-day"><div class="sh-rec-day-label">${DAY_SHORT[day]}</div><div class="sh-rec-day-blocks" data-day="${day}">`;
          blocks.forEach((b,i) => {
            html += `
              <div class="sh-block-edit-row sh-rec-row" data-day="${day}" data-idx="${i}">
                <input type="time" class="sh-input" value="${b.start}" data-field="start">
                <span>–</span>
                <input type="time" class="sh-input" value="${b.end}" data-field="end">
                <select class="sh-input sh-role-select" data-field="role">
                  ${ROLES.map(r => `<option value="${r}" ${r===b.role?'selected':''}>${ROLE_LABELS[r]||r}</option>`).join('')}
                </select>
                <button class="sh-btn sh-btn-sm sh-btn-danger" data-rremove="${day}:${i}"><i class="fas fa-trash"></i></button>
              </div>`;
          });
          if (!blocks.length) html += `<span class="sh-off-sm">OFF</span>`;
          html += `<div class="sh-rec-day-actions">`;
          html += `<button class="sh-btn sh-btn-sm sh-btn-xs" data-radd="${day}"><i class="fas fa-plus"></i></button>`;
          SHIFT_PRESETS.forEach((p,pi) => {
            html += `<button class="sh-btn sh-btn-sm sh-btn-xs sh-preset-btn-inline" data-rpadd="${day}:${pi}" title="${p.label}"><i class="fas fa-bolt"></i> ${p.label}</button>`;
          });
          html += `</div></div></div>`;
        });

        html += `
            </div>
            <div class="sh-modal-footer">
              <div></div>
              <div style="display:flex; gap:8px;">
                <button class="sh-btn sh-btn-sm" id="shRecCancel">Cancel</button>
                <button class="sh-btn sh-btn-sm sh-btn-primary" id="shRecSave"><i class="fas fa-save"></i> Save Recurring</button>
              </div>
            </div>
          </div>`;
        overlay.innerHTML = html;
        overlay.style.display = 'flex';

        overlay.querySelector('#shRecClose')?.addEventListener('click', () => overlay.style.display='none');
        overlay.querySelector('#shRecCancel')?.addEventListener('click', () => overlay.style.display='none');

        overlay.querySelectorAll('[data-radd]').forEach(btn => {
          btn.addEventListener('click', () => {
            const day = btn.dataset.radd;
            if (!local[day]) local[day] = [];
            local[day].push({start:'09:00', end:'17:00', role:defRole});
            render();
          });
        });

        overlay.querySelectorAll('[data-rpadd]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [day, pidxStr] = btn.dataset.rpadd.split(':');
            const preset = SHIFT_PRESETS[parseInt(pidxStr)];
            if (preset){ if (!local[day]) local[day]=[]; local[day].push({start:preset.start, end:preset.end, role:defRole}); render(); }
          });
        });

        overlay.querySelectorAll('[data-rremove]').forEach(btn => {
          btn.addEventListener('click', () => { const [day,idx] = btn.dataset.rremove.split(':'); local[day].splice(parseInt(idx),1); render(); });
        });

        overlay.querySelectorAll('.sh-rec-row').forEach(row => {
          const day = row.dataset.day; const idx = parseInt(row.dataset.idx);
          row.querySelectorAll('.sh-input').forEach(inp => {
            inp.addEventListener('change', () => { local[day][idx][inp.dataset.field] = inp.value; });
          });
        });

        overlay.querySelector('#shRecSave')?.addEventListener('click', async () => {
          const btn = overlay.querySelector('#shRecSave');
          if (btn){ btn.disabled=true; btn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> Saving…'; }
          const ok = await onSave(local);
          if (ok !== false) overlay.style.display = 'none';
          if (btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-save"></i> Save Recurring'; }
        });
      };
      render();
    },

    // ---- HELPERS ----
    fmtElapsed(ms){
      if (!ms || ms < 0) ms = 0;
      const totalSec = Math.floor(ms/1000);
      const h = Math.floor(totalSec/3600);
      const m = Math.floor((totalSec%3600)/60);
      const s = totalSec%60;
      const pad = n => String(n).padStart(2,'0');
      if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
      return `${m}:${pad(s)}`;
    },

    tickElapsed(){
      const spans = document.querySelectorAll('.sh-tick[data-started]');
      const now = Date.now();
      spans.forEach(span => {
        const started = span.dataset.started;
        if (!started) return;
        const ms = now - new Date(started).getTime();
        if (ms >= 0) span.textContent = this.fmtElapsed(ms);
      });
    },

    // ---- BUILD HTML ----
    buildViewHtml(){
      return `
        <div class="header-bar">
          <h1><i class="fas fa-calendar-alt" style="color:#1a73e8;"></i> Shifts</h1>
          <div style="display:flex; gap:10px; align-items:center;">
            <span class="sh-tz-label" id="shiftTzLabel"></span>
            <button class="btn-secondary" onclick="Shifts.refreshSchedules(true);"><i class="fas fa-sync"></i> Refresh</button>
          </div>
        </div>

        <!-- CURRENT WORKERS (driven by actual project assignments) -->
        <div class="sh-section sh-section-dashboard-only">
          <div class="sh-section-header">
            <div class="sh-section-title"><i class="fas fa-broadcast-tower" style="color:#34a853;"></i> Active Workers</div>
          </div>
          <div id="shiftStatusBodyLegacy" class="sh-section-body">
            <div class="sh-empty">Loading…</div>
          </div>
        </div>

        <!-- SCHEDULE GRID -->
        <div class="sh-section">
          <div class="sh-section-header" style="flex-wrap:wrap; gap:10px;">
            <div class="sh-section-title"><i class="fas fa-calendar-week" style="color:#1a73e8;"></i> Scheduled Shifts</div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span id="shiftSchedStatus" style="font-size:12px; color:#888;"></span>

              <!-- View mode toggle -->
              <div class="sh-view-toggle">
                <button class="sh-view-btn sh-view-active" data-mode="week" onclick="Shifts.setViewMode('week')" title="Weekly view"><i class="fas fa-calendar-week"></i></button>
                <button class="sh-view-btn" data-mode="day" onclick="Shifts.setViewMode('day')" title="Daily view"><i class="fas fa-calendar-day"></i></button>
              </div>

              <div class="sh-nav-divider"></div>

              <!-- Sort controls -->
              <div class="sh-sort-group">
                <span class="sh-sort-label">Sort:</span>
                <button class="sh-btn sh-btn-sm sh-sort-btn" data-sort="name" onclick="Shifts.setSortMode('name')" title="Sort by name"><i class="fas fa-sort-alpha-down"></i> Name</button>
                <button class="sh-btn sh-btn-sm sh-sort-btn sh-sort-active" data-sort="role" onclick="Shifts.setSortMode('role')" title="Sort by role"><i class="fas fa-user-tag"></i> Role</button>
                <button class="sh-btn sh-btn-sm sh-sort-btn" data-sort="time" onclick="Shifts.setSortMode('time')" title="Sort by shift start time"><i class="fas fa-clock"></i> Time</button>
              </div>

              <div class="sh-nav-divider"></div>

              <!-- Week nav -->
              <div id="shiftWeekNav" style="display:flex; align-items:center; gap:8px;">
                <button class="sh-btn sh-btn-sm" onclick="Shifts.prevWeek()"><i class="fas fa-chevron-left"></i></button>
                <span id="shiftWeekLabel" class="sh-week-label">…</span>
                <button class="sh-btn sh-btn-sm" onclick="Shifts.nextWeek()"><i class="fas fa-chevron-right"></i></button>
                <button class="sh-btn sh-btn-sm" onclick="Shifts.thisWeek()">This Week</button>
              </div>

              <!-- Day nav (hidden by default) -->
              <div id="shiftDayNav" style="display:none; align-items:center; gap:8px;">
                <button class="sh-btn sh-btn-sm" onclick="Shifts.prevDay()"><i class="fas fa-chevron-left"></i></button>
                <span id="shiftDayLabel" class="sh-week-label">…</span>
                <button class="sh-btn sh-btn-sm" onclick="Shifts.nextDay()"><i class="fas fa-chevron-right"></i></button>
                <button class="sh-btn sh-btn-sm" onclick="Shifts.today()">Today</button>
              </div>

              <div class="sh-nav-divider"></div>

              <!-- Unscheduled toggle -->
              <button class="sh-btn sh-btn-sm sh-toggle-btn" id="shiftToggleUnsched" onclick="Shifts.toggleUnscheduled()" title="Show unscheduled users">
                <i class="fas fa-user-plus"></i> Unscheduled
                <span id="shiftUnschedCount" class="sh-unsched-badge" style="display:none;"></span>
              </button>
            </div>
          </div>
          <div id="shiftSchedGrid" class="sh-section-body">
            <div class="sh-empty">Loading…</div>
          </div>
          <div id="shiftEditRecurringWrap" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;"></div>
        </div>
      `;
    },

    // ---- STYLES ----
    injectStyles(){
      if (document.getElementById('shiftStyles')) return;
      const s = document.createElement('style');
      s.id = 'shiftStyles';
      s.textContent = `
        /* Sections */
        .sh-section{ background:#fff; border:1px solid #dadce0; border-radius:12px; padding:18px; box-shadow:0 2px 5px rgba(0,0,0,0.05); }
        .sh-section-dashboard-only{ display:none; }
        .dashboard-shift-section{ border-radius:12px; box-shadow:0 8px 24px rgba(15,23,42,.06); padding:22px; }
        .dashboard-shift-section .sh-section-header{ margin-bottom:18px; }
        .sh-dashboard-title{ font-size:20px !important; color:#111827 !important; letter-spacing:-.02em; }
        .sh-section-header{ display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
        .sh-section-title{ font-weight:950; font-size:14px; color:#333; display:flex; align-items:center; gap:8px; }
        .sh-section-body{ }
        .sh-empty{ color:#9aa0a6; font-style:italic; padding:12px 2px; font-size:13px; }
        .sh-week-label{ font-weight:900; font-size:13px; color:#333; min-width:180px; text-align:center; white-space:nowrap; }

        /* TZ label */
        .sh-tz-label{ font-size:11px; font-weight:800; color:#888; background:#f0f0f0; padding:3px 8px; border-radius:6px; white-space:nowrap; }
        .sh-tz-note{ font-size:11px; font-weight:700; color:#1a73e8; background:#e8f0fe; padding:6px 10px; border-radius:6px; margin-bottom:12px; display:flex; align-items:center; gap:6px; }

        /* Buttons */
        .sh-btn{ display:inline-flex; align-items:center; gap:6px; border-radius:8px; padding:8px 12px; font-weight:800; font-size:12px; border:1px solid #dadce0; background:#fff; color:#333; cursor:pointer; user-select:none; transition:.15s; }
        .sh-btn:hover{ border-color:#bbb; background:#f8f9fa; }
        .sh-btn:disabled{ opacity:.5; cursor:not-allowed; }
        .sh-btn-sm{ padding:6px 10px; font-size:11px; }
        .sh-btn-xs{ padding:3px 8px; font-size:10px; }
        .sh-btn-primary{ background:#1a73e8; border-color:#1a73e8; color:#fff; }
        .sh-btn-primary:hover{ background:#1558b0; }
        .sh-btn-danger{ background:#fce8e6; border-color:#f4b4ae; color:#b0261e; }
        .sh-btn-danger:hover{ border-color:#d93025; }

        /* View mode toggle */
        .sh-view-toggle{ display:inline-flex; border:1px solid #dadce0; border-radius:8px; overflow:hidden; }
        .sh-view-btn{ padding:6px 10px; font-size:12px; border:none; background:#fff; color:#666; cursor:pointer; transition:.15s; display:flex; align-items:center; }
        .sh-view-btn:hover{ background:#f0f0f0; }
        .sh-view-btn.sh-view-active{ background:#1a73e8; color:#fff; }
        .sh-nav-divider{ width:1px; height:20px; background:#dadce0; }

        /* Sort controls */
        .sh-sort-group{ display:inline-flex; align-items:center; gap:4px; }
        .sh-sort-label{ font-size:11px; font-weight:800; color:#888; margin-right:2px; }
        .sh-sort-btn{ padding:4px 8px; font-size:10px; }
        .sh-sort-btn.sh-sort-active{ background:#e8f0fe; border-color:#1a73e8; color:#1a73e8; }

        /* Unscheduled toggle */
        .sh-toggle-btn{ position:relative; }
        .sh-toggle-btn.sh-toggle-active{ background:#e8f0fe; border-color:#1a73e8; color:#1a73e8; }
        .sh-unsched-badge{ display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; border-radius:8px; background:#d93025; color:#fff; font-size:9px; font-weight:900; padding:0 4px; margin-left:2px; }
        .sh-afk-badge{ display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; border-radius:8px; background:#9aa0a6; color:#fff; font-size:9px; font-weight:900; padding:0 4px; margin-left:2px; }

        /* Schedule table (week view) */
        .sh-table{ width:100%; border-collapse:collapse; font-size:12px; }
        .sh-table th{ background:#f8f9fa; padding:8px 6px; text-align:center; font-size:11px; color:#555; text-transform:uppercase; border-bottom:1px solid #eee; font-weight:900; }
        .sh-table td{ padding:6px; border-bottom:1px solid #f0f0f0; vertical-align:top; position:relative; }
        .sh-name-col{ text-align:left; min-width:140px; }
        .sh-day-col{ min-width:100px; }
        .sh-name-cell{ padding:8px 6px; }
        .sh-name-text{ font-weight:900; font-size:12px; color:#111; }
        .sh-name-meta{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:2px; }
        .sh-team-text{ font-size:10px; color:#888; font-weight:800; }
        .sh-rank-pill{ display:inline-flex; align-items:center; justify-content:center; gap:3px; min-width:30px; height:20px; padding:0 6px; box-sizing:border-box; border-radius:999px; border:1px solid #d4dae6; background:#f8fafc; color:#475569; font-size:9px; line-height:1; font-weight:950; white-space:nowrap; }
        .sh-rank-pill i{ font-size:8px; }
        .sh-rank-standard{ border-color:#93c5fd; background:#eff6ff; color:#1d4ed8; }
        .sh-rank-senior{ border-color:#f7c76d; background:#fffbeb; color:#a15c05; }
        .sh-rank-junior{ border-color:#86d3a2; background:#f0fdf4; color:#15803d; }
        .sh-cell{ min-height:40px; }
        .sh-cell.sh-today{ background:#e8f0fe22; }
        .sh-cell.sh-override{ background:#fef3f2; }
        .sh-today{ background:#e8f0fe33; }
        .sh-date-num{ font-size:12px; font-weight:900; color:#333; }
        .sh-off{ color:#ccc; font-size:10px; font-weight:900; text-align:center; padding:4px 0; }
        .sh-off-sm{ color:#ccc; font-size:10px; font-weight:800; }

        /* Override-off state */
        .sh-override-off{ display:flex; align-items:center; justify-content:center; gap:6px; padding:4px 0; }
        .sh-override-off-label{ font-size:10px; font-weight:950; color:#b0261e; display:inline-flex; align-items:center; gap:3px; }
        .sh-revert-day-btn{ display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:4px; border:1px solid #1a73e844; background:#e8f0fe; color:#1a73e8; font-size:9px; cursor:pointer; transition:.15s; flex-shrink:0; }
        .sh-revert-day-btn:hover{ background:#1a73e8; color:#fff; border-color:#1a73e8; }
        .sh-block{ padding:3px 6px; margin:2px 0; border-radius:6px; background:#f8f9fa; }
        .sh-block-manual{ background:#fff8e1; border:1px dashed #f9a82588; }
        .sh-block-time{ font-weight:800; font-size:11px; color:#333; }
        .sh-block-role{ font-size:10px; font-weight:900; margin-left:4px; }
        .sh-edit-day-btn{ position:absolute; bottom:2px; right:2px; width:20px; height:20px; border-radius:4px; border:1px solid #eee; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:.15s; color:#888; }
        .sh-cell:hover .sh-edit-day-btn{ opacity:1; }
        .sh-edit-day-btn:hover{ border-color:#1a73e8; color:#1a73e8; }
        .sh-row-unsched td{ opacity:0.5; }
        .sh-row-unsched:hover td{ opacity:0.85; }

        .sh-manual-indicator{ font-size:9px; font-weight:900; color:#e65100; display:flex; align-items:center; gap:3px; margin-top:2px; }

        /* Day view */
        .sh-day-grid{ display:flex; flex-direction:column; gap:0; }
        .sh-day-time-axis{ display:flex; align-items:flex-end; height:28px; margin-bottom:2px; }
        .sh-day-name-spacer{ min-width:140px; flex-shrink:0; }
        .sh-day-hours-track{ flex:1; position:relative; height:28px; border-bottom:1px solid #eee; }
        .sh-day-hour-mark{ position:absolute; bottom:2px; font-size:9px; font-weight:800; color:#999; transform:translateX(-50%); }
        .sh-day-row{ display:flex; align-items:stretch; min-height:44px; border-bottom:1px solid #f4f4f4; }
        .sh-day-row:hover{ background:#fafbfc; }
        .sh-day-row-unsched{ opacity:0.45; }
        .sh-day-row-unsched:hover{ opacity:0.8; }
        .sh-day-name-cell{ min-width:140px; flex-shrink:0; padding:8px 8px 8px 4px; display:flex; flex-direction:column; justify-content:center; }
        .sh-day-track{ flex:1; position:relative; min-height:40px; }
        .sh-day-grid-line{ position:absolute; top:0; bottom:0; width:1px; background:#f0f0f0; }
        .sh-day-now-line{ position:absolute; top:0; bottom:0; width:2px; background:#d93025; z-index:5; opacity:0.7; }
        .sh-day-now-line::after{ content:''; position:absolute; top:-3px; left:-3px; width:8px; height:8px; border-radius:50%; background:#d93025; }
        .sh-day-block{ position:absolute; top:4px; bottom:4px; border-radius:6px; display:flex; align-items:center; gap:6px; padding:0 8px; overflow:hidden; white-space:nowrap; font-size:11px; z-index:2; min-width:40px; }
        .sh-day-block-manual{ border-style:dashed !important; border-left-style:solid !important; }
        .sh-day-block-time{ font-weight:800; font-size:10px; color:#333; }
        .sh-day-block-role{ font-size:10px; font-weight:900; }
        .sh-day-off-label{ position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#ccc; font-size:10px; font-weight:900; }

        .sh-day-row-override-off{ background:#fef3f244; }
        .sh-day-row-override-off:hover{ background:#fef3f2; }
        .sh-override-off-indicator{ color:#b0261e !important; }
        .sh-day-override-off-label{ position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:10px; font-weight:950; color:#b0261e; display:flex; align-items:center; gap:3px; }
        .sh-day-revert-btn{ position:absolute; top:50%; right:4px; transform:translateY(-50%); width:22px; height:22px; border-radius:5px; border:1px solid #1a73e844; background:#e8f0fe; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#1a73e8; font-size:10px; z-index:10; transition:.15s; }
        .sh-day-revert-btn:hover{ background:#1a73e8; color:#fff; border-color:#1a73e8; }
        .sh-day-edit-btn{ position:absolute; top:50%; right:4px; transform:translateY(-50%); width:22px; height:22px; border-radius:4px; border:1px solid #eee; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:.15s; color:#888; z-index:10; }
        .sh-day-row:hover .sh-day-edit-btn{ opacity:1; }
        .sh-day-edit-btn:hover{ border-color:#1a73e8; color:#1a73e8; }

        /* Current status — active workers */
        .sh-role-group{ margin-bottom:20px; }
        .sh-role-group:last-child{ margin-bottom:0; }
        .sh-role-header{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:12px; padding:0 0 9px; border-bottom:1px solid #e2e8f0; }
        .sh-role-heading{ min-width:0; font-weight:950; font-size:13px; display:flex; align-items:center; gap:8px; text-transform:uppercase; letter-spacing:.04em; }
        .sh-role-count{ font-weight:800; font-size:12px; opacity:0.7; }
        .sh-inactive-toggle{ appearance:none; display:inline-flex; align-items:center; gap:8px; flex:0 0 auto; padding:0; border:0; background:transparent; color:#64748b; font:inherit; font-size:10px; font-weight:900; cursor:pointer; }
        .sh-inactive-toggle:hover{ color:#334155; }
        .sh-inactive-toggle:focus-visible{ outline:2px solid rgba(26,115,232,.28); outline-offset:3px; border-radius:999px; }
        .sh-switch-track{ position:relative; width:30px; height:17px; flex:0 0 30px; border-radius:999px; background:#cbd5e1; box-shadow:inset 0 0 0 1px rgba(15,23,42,.08); transition:background .15s ease; }
        .sh-switch-knob{ position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(15,23,42,.28); transition:transform .15s ease; }
        .sh-inactive-toggle.is-on .sh-switch-track{ background:#1a73e8; }
        .sh-inactive-toggle.is-on .sh-switch-knob{ transform:translateX(13px); }
        .sh-role-filter-empty{ width:100%; padding:14px 2px; color:#94a3b8; font-size:11px; font-weight:800; }
        .sh-role-people{ display:flex; align-items:flex-start; gap:24px; flex-wrap:wrap; }
        .sh-person-card{ flex:0 0 320px; width:320px; min-width:0; max-width:320px; padding:0; background:transparent; }
        .sh-person-card.sh-person-afk{ opacity:0.55; }
        .sh-person-card.sh-person-afk:hover{ opacity:0.75; }
        .sh-person-title{ display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; margin-bottom:7px; padding:0 2px; }
        .sh-person-title-meta{ display:flex; flex:0 0 auto; align-items:center; justify-content:flex-end; gap:6px; flex-wrap:nowrap; }
        .sh-person-name-row{ display:flex; flex:1 1 auto; align-items:center; gap:8px; min-width:0; overflow:hidden; }
        .sh-person-name{ flex:0 1 auto; min-width:0; overflow:hidden; color:#111827; font-size:14px; font-weight:950; line-height:1.2; text-overflow:ellipsis; white-space:nowrap; }
        .sh-presence-dot{ position:relative; display:inline-block; width:8px; height:8px; flex:0 0 8px; border-radius:50%; }
        .sh-presence-dot.is-active{ background:#22a447; box-shadow:0 0 0 0 rgba(34,164,71,.42); animation:shPresencePulse 2s ease-out infinite; }
        .sh-presence-dot.is-afk{ background:#9aa0a6; }
        @keyframes shPresencePulse{ 0%{box-shadow:0 0 0 0 rgba(34,164,71,.42)} 65%{box-shadow:0 0 0 5px rgba(34,164,71,0)} 100%{box-shadow:0 0 0 0 rgba(34,164,71,0)} }
        .sh-worker-stat-pill{ display:inline-flex; align-items:center; gap:4px; height:20px; padding:0 6px; border:1px solid #d8dee8; border-radius:999px; background:#fff; color:#475569; font-size:9px; line-height:1; font-weight:950; white-space:nowrap; }
        .sh-worker-stat-pill i{ font-size:8px; }
        .sh-worker-stat-pill.rate{ border-color:#bfdbfe; background:#eff6ff; color:#1d4ed8; }
        .sh-worker-stat-pill.total{ border-color:#bbdfc5; background:#eef9f1; color:#137333; }
        .sh-worker-stat-pill.qa{ border-color:#fed7aa; background:#fff7ed; color:#c2410c; }
        .sh-person-time{ font-size:11px; color:#888; font-weight:800; margin-top:2px; }
        .sh-person-status{ font-size:11px; font-weight:900; margin-top:4px; display:flex; align-items:center; gap:6px; }
        .sh-person-status.active{ color:#137333; }
        .sh-person-status.break{ color:#b0261e; }
        .sh-person-status.afk{ color:#999; }
        .sh-afk-duration{ font-weight:700; font-size:10px; color:#aaa; }
        .sh-person-project{ font-size:11px; font-weight:800; color:#555; margin-top:4px; display:flex; align-items:center; gap:5px; }
        .sh-project-addr{ color:#333; }
        .sh-project-elapsed{ color:#888; font-weight:700; font-size:10px; }
        .sh-project-elapsed.sh-elapsed-warn{ color:#999; font-weight:800; }
        .sh-person-qa-count{ font-size:11px; font-weight:800; color:${ROLE_COLORS.qa}; margin-top:4px; display:flex; align-items:center; gap:5px; }
        .sh-person-work-grid{ display:grid; grid-template-columns:minmax(0,1fr); gap:12px; width:100%; min-width:0; }
        .sh-work-tile{ box-sizing:border-box; appearance:none; width:100%; max-width:100%; min-width:0; height:100px; padding:12px; overflow:hidden; border:1px solid #dce2ea; border-radius:10px; background:#fff; color:#1f2937; text-align:left; font:inherit; cursor:pointer; box-shadow:0 1px 2px rgba(15,23,42,.04); transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease; }
        .sh-work-tile:hover{ transform:translateY(-1px); border-color:#8ab4f8; box-shadow:0 5px 14px rgba(26,115,232,.12); }
        .sh-work-tile:focus-visible{ outline:3px solid rgba(26,115,232,.22); outline-offset:2px; border-color:#1a73e8; }
        .sh-work-tile.sh-speed-medium{ background:#fffbeb; border-color:#f4cf67; box-shadow:0 1px 3px rgba(180,125,0,.10); }
        .sh-work-tile.sh-speed-medium:hover{ border-color:#e4b83e; box-shadow:0 5px 14px rgba(180,125,0,.16); }
        .sh-work-tile.sh-speed-slow{ background:#fff7ed; border-color:#fdba74; box-shadow:0 1px 3px rgba(194,91,0,.10); }
        .sh-work-tile.sh-speed-slow:hover{ border-color:#f59e42; box-shadow:0 5px 14px rgba(194,91,0,.16); }
        .sh-work-tile.sh-speed-very-slow{ background:#fef2f2; border-color:#fca5a5; box-shadow:0 1px 3px rgba(185,28,28,.10); }
        .sh-work-tile.sh-speed-very-slow:hover{ border-color:#ef7f7f; box-shadow:0 5px 14px rgba(185,28,28,.16); }
        .sh-work-tile-empty{ display:flex; align-items:center; gap:10px; height:100px; border-style:dashed; background:#f8fafc; color:#94a3b8; cursor:default; box-shadow:none; }
        .sh-work-tile-empty:hover{ transform:none; border-color:#dce2ea; box-shadow:none; }
        .sh-work-tile-empty > i{ width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 26px; border-radius:50%; background:#eef2f6; color:#7c8796; font-size:11px; }
        .sh-work-empty-copy{ min-width:0; }
        .sh-work-empty-title{ color:#64748b; font-size:12px; font-weight:950; }
        .sh-work-empty-sub{ margin-top:2px; color:#94a3b8; font-size:9px; font-weight:850; text-transform:uppercase; letter-spacing:.045em; }
        .sh-work-empty-timer{ margin-left:auto; padding-left:8px; color:#475569; font-size:18px; line-height:1; font-weight:950; letter-spacing:-.025em; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .sh-work-tags{ display:flex; flex-wrap:wrap; gap:4px; margin-bottom:9px; }
        .sh-work-tag{ display:inline-flex; align-items:center; gap:3px; min-height:18px; padding:2px 6px; border:1px solid #d7dce3; border-radius:999px; background:#f8fafc; color:#475569; font-size:8px; line-height:1; font-weight:950; letter-spacing:.035em; white-space:nowrap; }
        .sh-work-tag.priority.p1,.sh-work-tag.urgent{ background:#d93025; border-color:#d93025; color:#fff; }
        .sh-work-tag.priority.p2{ background:#e37400; border-color:#e37400; color:#fff; }
        .sh-work-tag.priority.p3{ background:#5f6368; border-color:#5f6368; color:#fff; }
        .sh-work-tag.complexity{ background:#fff8e1; border-color:#f6cf65; color:#9a6700; letter-spacing:.08em; }
        .sh-work-tag.type{ background:#1a73e8; border-color:#1a73e8; color:#fff; }
        .sh-work-tag.vip{ background:#f9ab00; border-color:#e37400; color:#fff; }
        .sh-work-tag.filler{ background:#4b5563; border-color:#374151; color:#fff; }
        .sh-work-tag.rework{ background:#fff3e0; border-color:#ffcc80; color:#e65100; }
        .sh-work-address{ display:flex; color:#111827; font-size:13px; font-weight:950; line-height:1.35; }
        .sh-work-address > span{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .sh-work-meta{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; color:#667085; font-size:10px; font-weight:850; text-transform:uppercase; letter-spacing:.035em; }
        @media (max-width:720px){ .sh-person-card{ flex-basis:100%; width:100%; max-width:100%; } .dashboard-shift-section{ padding:16px; } }
        @media (prefers-reduced-motion:reduce){ .sh-presence-dot.is-active{ animation:none; } }

        /* Session stats */
        .sh-stat-card{ border:1px solid #eee; border-radius:10px; padding:12px 14px; background:#fff; min-width:200px; max-width:320px; flex:1 1 260px; }
        .sh-stat-cards-wrap{ display:flex; gap:10px; flex-wrap:wrap; }
        .sh-stat-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
        .sh-stat-name{ font-weight:950; font-size:13px; display:flex; align-items:center; gap:8px; }
        .sh-stat-role{ font-size:11px; font-weight:900; }
        .sh-stat-break{ font-size:12px; font-weight:900; color:#b0261e; margin-bottom:6px; display:flex; align-items:center; gap:6px; }
        .sh-stat-cats{ display:flex; gap:14px; flex-wrap:wrap; margin:6px 0; }
        .sh-stat-cat{ font-size:12px; font-weight:800; color:#333; display:flex; align-items:center; gap:5px; }
        .sh-stat-cat-dot{ width:8px; height:8px; border-radius:50%; display:inline-block; }
        .sh-stat-rate{ font-size:12px; font-weight:900; color:#1a73e8; }
        .sh-stat-none{ font-size:12px; color:#999; font-style:italic; }
        .sh-stat-meta{ font-size:11px; color:#888; font-weight:800; margin-top:4px; }
        .sh-stat-current{ font-size:11px; font-weight:900; color:#e37400; margin-top:4px; display:flex; align-items:center; gap:6px; }

        /* Modals */
        .sh-modal-overlay{ position:fixed; inset:0; background:rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; z-index:99999; backdrop-filter:blur(3px); }
        .sh-modal-card{ width:560px; max-width:94vw; background:#fff; border-radius:14px; box-shadow:0 24px 70px rgba(0,0,0,0.45); overflow:hidden; }
        .sh-modal-header{ padding:16px 18px; border-bottom:1px solid #eee; display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .sh-modal-title{ font-weight:950; font-size:14px; color:#111; }
        .sh-modal-close{ width:36px; height:36px; border-radius:10px; border:1px solid #eee; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .sh-modal-body{ padding:16px 18px; }
        .sh-modal-footer{ padding:14px 18px; border-top:1px solid #eee; background:#fafafa; display:flex; justify-content:space-between; gap:10px; }

        .sh-preset-bar{ display:flex; align-items:center; gap:8px; margin-bottom:14px; padding:10px 12px; background:#f0f7ff; border:1px solid #d2e3fc; border-radius:8px; }
        .sh-preset-label{ font-size:11px; font-weight:900; color:#1a73e8; white-space:nowrap; }
        .sh-preset-btn{ background:#fff; border-color:#1a73e8; color:#1a73e8; }
        .sh-preset-btn:hover{ background:#e8f0fe; }
        .sh-preset-btn-inline{ background:#f8f9fa; border-color:#dadce0; color:#555; font-size:9px !important; padding:2px 6px !important; }
        .sh-preset-btn-inline:hover{ background:#e8f0fe; border-color:#1a73e8; color:#1a73e8; }

        .sh-block-edit-row{ display:flex; gap:8px; align-items:center; margin-bottom:8px; }
        .sh-input{ padding:6px 8px; border:1px solid #ddd; border-radius:6px; font-size:12px; font-weight:700; }
        .sh-role-select{ min-width:100px; }

        .sh-rec-day{ display:flex; gap:10px; align-items:flex-start; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #f0f0f0; }
        .sh-rec-day-label{ min-width:40px; font-weight:950; font-size:12px; color:#555; padding-top:8px; }
        .sh-rec-day-blocks{ flex:1; display:flex; flex-direction:column; gap:6px; }
        .sh-rec-row{ margin-bottom:0; }
        .sh-rec-day-actions{ display:flex; gap:4px; align-items:center; flex-wrap:wrap; margin-top:2px; }
      `;
      document.head.appendChild(s);
    },
  };

  window.Shifts = Shifts;
  document.addEventListener('DOMContentLoaded', () => { if (Shifts.init) Shifts.init(); });
})();
