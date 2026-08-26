/* portal_scripts/tutorials.js
 * Tutorials module:
 * - Curriculum chapter view + gating
 * - Hidden / user-restricted chapters (numbering skips what you can't see)
 * - Per-chapter toggles to hide Videos / Guides columns entirely
 * - Student progress view + modal
 * - Curriculum editor modal (admin/lead)
 *
 * UI FIX: injects scoped CSS to override the portal's global input styles
 * (which were blowing up checkboxes + breaking layout).
 *
 * Chapter fields added (back-compat safe):
 * - hidden: boolean (default false)
 * - visible_to: string[] (emails allowed to see when hidden)
 * - show_videos: boolean (default true)
 * - show_pdfs: boolean (default true)
 */

(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG;
  const tutorialCfg = () => (cfg().tutorials || {});
  const tutorialCourseId = () => String(tutorialCfg().course_id || 'default');
  const tutorialCourseOptions = () => Array.isArray(tutorialCfg().course_options) && tutorialCfg().course_options.length
    ? tutorialCfg().course_options
    : [{ id: 'default', label: 'New Hire Training' }];
  const tutorialCourseLabel = (courseId = tutorialCourseId()) => {
    const found = tutorialCourseOptions().find(c => String(c.id || '') === String(courseId || ''));
    return found ? String(found.label || found.id || courseId) : String(courseId || 'default');
  };
  const tutorialProjectsEnabled = () => tutorialCfg().projects_enabled !== false;
  const tutorialApiPayload = (payload={}) => Object.assign({}, payload, { course_id: tutorialCourseId() });
  const tutorialApiPayloadForCourse = (courseId, payload={}) => Object.assign({}, payload, { course_id: String(courseId || 'default') });
  const tutorialMasterAssetBase = () => tutorialCourseId() === 'default'
    ? 'tutorials/master'
    : `tutorials/courses/${encodeURIComponent(tutorialCourseId())}/master`;

  const fmActor = () => {
    const c = cfg() || {};
    const u = c.user || {};
    const actor = {};
    if (u.id) actor.id = u.id;
    if (u.email) actor.email = u.email;
    if (u.name) actor.name = u.name;
    if (u.team_id) actor.team_id = u.team_id;
    if (u.organization_id) actor.organization_id = u.organization_id;
    return actor;
  };

  const fmUrl = (path) => {
    const base = String(cfg()?.endpoints?.firstmeasure || '').replace(/\/+$/, '');
    const suffix = String(path || '').replace(/^\/+/, '');
    return `${base}/${suffix}`;
  };

  const fmPost = async (path, payload = {}) => {
    const res = await fetch(fmUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ actor: fmActor(), ...(payload || {}) })
    });
    return await res.json();
  };

  const normEmail = (s) => String(s || '').trim().toLowerCase();
  const uniqEmails = (arr) => {
    const out = [];
    const seen = new Set();
    (arr || []).forEach(e => {
      const x = normEmail(e);
      if (!x) return;
      if (seen.has(x)) return;
      seen.add(x);
      out.push(x);
    });
    return out;
  };

  const Tutorials = {
    curriculum: { chapters: [] },
    progress: { completed_videos: [], completed_projects: [], current_chapter: 1 },

    // view mapping (what *this* user can see)
    viewChapters: [], // [{ origIdx, chap }]
    currentChapOrigIdx: 0,
    currentChapViewIdx: 0,

    currentEditorPage: 0,

    myTutorialProjectList: [],

    // roster (for editor allowlist)
    studentRoster: [],
    _rosterLoaded: false,
    _autoSkipInFlight: false,
    resourceDrafts: {},
    _skipDraftStashOnce: false,
    projectSearchResults: [],
    projectSearchLoading: false,
    projectSearchQuery: '',
    projectSearchComplexity: 'all',
    projectSearchStatus: 'completed',
    projectSearchTarget: 'practice',
    projectSearchPage: 1,
    projectSearchTotalPages: 1,
    projectSearchTotalCount: 0,
    projectSearchLimit: 24,
    curriculumManager: {
      courses: [],
      curricula: {},
      dragging: null,
      loading: false,
      saving: false,
      status: ''
    },

    init(){
      this.ensureEditorCss();

      // Expose globals used by inline onclick attrs
      window.openStudentProgress = () => this.openStudentProgress();
      window.fetchStudentList = () => this.fetchStudentList();
      window.openStudentDetails = (email, name) => this.openStudentDetails(email, name);
      window.openTutorialProjectAudit = (email, tutorialId) => this.openProjectGradingAudit(email, tutorialId);
      window.openTutorialExamGrades = () => this.openExamGrades();

      window.openEditor = () => this.openEditor();
      window.openCurriculumManager = () => this.openCurriculumManager();
      window.closeCurriculumManager = () => this.closeCurriculumManager();
      window.renderCurriculumManager = () => this.renderCurriculumManager();
      window.tutCurriculumDragStart = (ev, courseId, chapterIdx) => this.curriculumManagerDragStart(ev, courseId, chapterIdx);
      window.tutCurriculumDragEnd = (ev) => this.curriculumManagerDragEnd(ev);
      window.tutCurriculumDragOver = (ev) => this.curriculumManagerDragOver(ev);
      window.tutCurriculumDrop = (ev, courseId, chapterIdx) => this.curriculumManagerDrop(ev, courseId, chapterIdx);
      window.tutCurriculumPointerDown = (ev, courseId, chapterIdx) => this.curriculumManagerPointerDown(ev, courseId, chapterIdx);
      window.duplicateCurriculumManagerChapter = (courseId, chapterIdx) => this.duplicateCurriculumManagerChapter(courseId, chapterIdx);
      window.addEditorChapter = () => this.addEditorChapter();
      window.saveCurriculum = (silent) => this.saveCurriculum(!!silent);

      window.completeChapter = () => this.completeChapter();
      window.showChapterGrid = () => this.showChapterGrid();
      window.markVideo = (url) => this.markVideo(url);
      window.startTutorialProject = (id) => this.startTutorialProject(id);
      window.startTutorialTestAttempt = (chapterId, testId) => this.startTutorialTestAttempt(chapterId, testId);
      window.startTutorialDraftRejectRound = (chapterId, roundId) => this.startTutorialDraftRejectRound(chapterId, roundId);
      window.viewTutorialAttemptRubric = (attemptId) => this.showAttemptRubricModal(attemptId);
      window.setTutorialCourse = (courseId) => this.setCourse(courseId);

      // Editor helpers referenced from generated HTML
      window.renderEditor = () => this.renderEditor();
      window.addResource = (type) => this.addResource(type);
      window.uploadTutorialPdfFile = () => this.uploadPdfFile();
      window.removeResource = (type, chapIdx, itemIdx) => this.removeResource(type, chapIdx, itemIdx);
      window.updateResource = (type, chapIdx, itemIdx, field, val) => this.updateResource(type, chapIdx, itemIdx, field, val);

      window.addProjectToChapter = (target) => this.addProjectToChapter(target || 'practice');
      window.openTutorialProjectSearch = (target) => this.openProjectSearchModal(target || 'practice');
      window.closeTutorialProjectSearch = () => this.closeProjectSearchModal();
      window.searchTutorialProjects = () => this.searchCompletedProjects();
      window.setTutorialProjectComplexityFilter = (value) => this.setProjectSearchComplexity(value);
      window.setTutorialProjectStatusFilter = (value) => this.setProjectSearchStatus(value);
      window.tutorialProjectSearchPage = (direction) => this.changeProjectSearchPage(direction);
      window.selectTutorialSourceProject = (projectId) => this.selectTutorialSourceProject(projectId);
      window.openTutorialSourceEditor = (projectId) => this.openSourceProjectEditor(projectId);
      window.updateProject = (chapIdx, itemIdx, field, val, target) => this.updateProject(chapIdx, itemIdx, field, val, target || 'practice');
      window.removeProject = (chapIdx, itemIdx, target) => this.removeProject(chapIdx, itemIdx, target || 'practice');
      window.generatePendingProjects = (chapIdx, target) => this.generatePendingProjects(chapIdx, target || 'practice');
      window.updateTestProject = (chapIdx, itemIdx, field, val) => this.updateProject(chapIdx, itemIdx, field, val, 'test');
      window.removeTestProject = (chapIdx, itemIdx) => this.removeProject(chapIdx, itemIdx, 'test');
      window.generatePendingTestProjects = (chapIdx) => this.generatePendingProjects(chapIdx, 'test');

      window.removeEditorChapter = (idx) => this.removeEditorChapter(idx);
      window.attachAutocomplete = () => this.attachAutocomplete();
      window.renderResourceList = (type, chapIdx) => this.renderResourceList(type, chapIdx);
      window.renderProjectList = (chapIdx) => this.renderProjectList(chapIdx);

      // visibility + toggles (editor)
      window.tutSetChapHidden = (chapIdx, checked) => this.setChapHidden(chapIdx, !!checked);
      window.tutSetTestEnabled = (chapIdx, checked) => this.setTestEnabled(chapIdx, !!checked);
      window.tutUpdateTestSetting = (chapIdx, key, value) => this.updateTestSetting(chapIdx, key, value);
      window.addTestSection = (chapIdx) => this.addTestSection(chapIdx);
      window.removeTestSection = (chapIdx, testIdx) => this.removeTestSection(chapIdx, testIdx);
      window.updateTestSection = (chapIdx, testIdx, key, value) => this.updateTestSection(chapIdx, testIdx, key, value);
      window.addDraftRejectRound = (chapIdx) => this.addDraftRejectRound(chapIdx);
      window.removeDraftRejectRound = (chapIdx, roundIdx) => this.removeDraftRejectRound(chapIdx, roundIdx);
      window.updateDraftRejectRound = (chapIdx, roundIdx, key, value) => this.updateDraftRejectRound(chapIdx, roundIdx, key, value);
      window.updateDraftRejectProject = (chapIdx, roundIdx, itemIdx, key, value) => this.updateDraftRejectProject(chapIdx, roundIdx, itemIdx, key, value);
      window.removeDraftRejectProject = (chapIdx, roundIdx, itemIdx) => this.removeDraftRejectProject(chapIdx, roundIdx, itemIdx);
      window.addDraftRejectBulkIds = (chapIdx, roundIdx) => this.addDraftRejectBulkIds(chapIdx, roundIdx);
      window.tutToggleChapFlag = (chapIdx, key, checked) => this.setChapFlag(chapIdx, key, !!checked);
      window.tutToggleAllowedUser = (chapIdx, email, checked) => this.toggleAllowedUser(chapIdx, email, !!checked);
      window.tutRemoveAllowedUser = (chapIdx, email) => this.removeAllowedUser(chapIdx, email);
      window.tutAddAllowedUserFromInput = (chapIdx) => this.addAllowedUserFromInput(chapIdx);
      window.tutRenderAllowPicker = () => this.renderAllowUserPicker();
      window.tutRefreshRoster = () => this.loadStudentRoster(true);

      this.installExamGradesButton();

    },

    stopTimers(){ /* none */ },

    // ------------------------------
    // CSS injection (scoped)
    // ------------------------------
    ensureEditorCss(){
      const ID = 'tut-editor-css-v3';
      if (document.getElementById(ID)) return;

      const css = `
/* Scope everything to the editor modal so portal-wide styles remain untouched */
#editorModal .tut-editor * { box-sizing: border-box; }

/* Kill the portal's global "input { width:100%; padding:10px }" effect on checkboxes */
#editorModal .tut-editor input[type="checkbox"]{
  width: 16px !important;
  height: 16px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  background: transparent !important;
  accent-color: var(--primary);
}

/* Make our inline labels NOT inherit .form-row label uppercase/block styling */
#editorModal .tut-editor .tut-inline-label{
  display: inline-flex !important;
  align-items: center !important;
  gap: 10px !important;
  margin: 0 !important;
  text-transform: none !important;
  font-weight: 900 !important;
  color: #333 !important;
  line-height: 1.1 !important;
  white-space: nowrap !important;
}

/* Visibility card */
#editorModal .tut-editor .tut-vis-card{
  background: #fff;
  border: 1px solid #eee;
  border-radius: 12px;
  padding: 12px;
}
#editorModal .tut-editor .tut-vis-top{
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
#editorModal .tut-editor .tut-vis-hint{
  font-size: 12px;
  color: #666;
  font-weight: 700;
}
#editorModal .tut-editor .tut-icon-btn{
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid #e6e6e6;
  background: #fff;
  cursor: pointer;
}
#editorModal .tut-editor .tut-icon-btn:hover{ background:#f8f9fa; }

/* Allowlist controls */
#editorModal .tut-editor .tut-allow-controls{
  display: grid;
  grid-template-columns: 1fr 240px auto;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
@media (max-width: 900px){
  #editorModal .tut-editor .tut-allow-controls{ grid-template-columns: 1fr; }
}
#editorModal .tut-editor .tut-allow-chips{
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}
#editorModal .tut-editor .tut-chip{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 999px;
  padding: 6px 10px;
  border: 1px solid #d2e3fc;
  background: #e8f0fe;
  color: #1a73e8;
  font-weight: 900;
  font-size: 11px;
  text-transform: none;
  max-width: 100%;
}
#editorModal .tut-editor .tut-chip .tut-chip-email{
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#editorModal .tut-editor .tut-chip button{
  border: none;
  background: transparent;
  cursor: pointer;
  color: #1a73e8;
  font-weight: 900;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

/* Allowlist list */
#editorModal .tut-editor .tut-allow-list{
  border: 1px solid #eee;
  background: #fff;
  border-radius: 12px;
  padding: 6px;
  max-height: 240px;
  overflow: auto;
}
#editorModal .tut-editor .tut-allow-row{
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 10px;
  align-items: center;
  padding: 10px 10px;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  text-transform: none !important;
}
#editorModal .tut-editor .tut-allow-row:hover{ background:#f8f9fa; }
#editorModal .tut-editor .tut-allow-meta{
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#editorModal .tut-editor .tut-allow-name{
  font-weight: 900;
  font-size: 12px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#editorModal .tut-editor .tut-allow-email{
  font-size: 11px;
  color: #777;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Section headers with right-side toggles (videos/pdfs) */
#editorModal .tut-editor .tut-sec-head{
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
#editorModal .tut-editor .tut-sec-title{
  font-weight: 900;
  font-size: 11px;
  color: #777;
  letter-spacing: .3px;
  text-transform: uppercase;
}
#editorModal .tut-editor .tut-toggle{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 900;
  font-size: 12px;
  color: #333;
  text-transform: none !important;
  white-space: nowrap;
}
#editorModal .tut-editor .tut-grade-switch{
  display:inline-flex;
  align-items:center;
  gap:8px;
  min-width:126px;
  margin:0;
  cursor:pointer;
  user-select:none;
  text-transform:none;
  font-size:11px;
  font-weight:900;
  color:#344054;
}
#editorModal .tut-editor .tut-grade-switch input{
  position:absolute !important;
  opacity:0 !important;
  width:1px !important;
  height:1px !important;
  pointer-events:none;
}
#editorModal .tut-editor .tut-grade-switch-track{
  position:relative;
  width:38px;
  height:22px;
  flex:0 0 38px;
  border-radius:999px;
  background:#b8c0cc;
  transition:background .16s ease;
}
#editorModal .tut-editor .tut-grade-switch-track::after{
  content:'';
  position:absolute;
  top:3px;
  left:3px;
  width:16px;
  height:16px;
  border-radius:50%;
  background:#fff;
  box-shadow:0 1px 3px rgba(16,24,40,.28);
  transition:transform .16s ease;
}
#editorModal .tut-editor .tut-grade-switch input:checked + .tut-grade-switch-track{
  background:var(--primary);
}
#editorModal .tut-editor .tut-grade-switch input:checked + .tut-grade-switch-track::after{
  transform:translateX(16px);
}
#editorModal .tut-editor .tut-grade-switch input:focus-visible + .tut-grade-switch-track{
  outline:3px solid rgba(26,115,232,.22);
  outline-offset:2px;
}

/* Make the little + buttons in resource rows not look cramped next to long inputs */
#editorModal .tut-editor .resource-row button.btn-secondary.btn-sm,
#editorModal .tut-editor .resource-row button.btn-danger.btn-sm{
  min-width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
}
#editorModal .tut-editor .resource-row.resource-row-saved{
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid #e7edf4;
  border-radius: 12px;
  background: #fafcff;
}
#editorModal .tut-editor .resource-row .tut-resource-state{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 62px;
  height: 34px;
  padding: 0 10px;
  border-radius: 999px;
  background: #e8f5ec;
  color: #1f7a45;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#editorModal .tut-editor .resource-row .tut-save-resource-btn{
  min-width: 78px !important;
  padding: 0 14px !important;
  gap: 6px;
}
.tut-project-search-backdrop{
  position: fixed;
  inset: 0;
  z-index: 1000002;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(16,24,40,.66);
  padding: 22px;
}
.tut-project-search-backdrop.show{ display:flex; }
.tut-project-search-modal{
  width: min(1040px, 100%);
  max-height: min(780px, calc(100vh - 44px));
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0,0,0,.34);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tut-project-search-head{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid #edf0f5;
}
.tut-project-search-head h3{
  margin: 0;
  font-size: 18px;
  color: #202124;
}
.tut-project-search-close{
  width: 34px;
  height: 34px;
  border: 1px solid #e6e9ef;
  background: #fff;
  border-radius: 8px;
  cursor: pointer;
}
.tut-project-search-controls{
  display: grid;
  grid-template-columns: minmax(0,1fr) 170px auto;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid #edf0f5;
}
.tut-project-search-controls input,
.tut-project-search-controls select{
  width: 100%;
  min-width: 0;
}
.tut-project-search-status{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid #edf0f5;
  font-size: 12px;
  font-weight: 800;
  color: #667085;
}
.tut-project-pager{
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tut-project-pager button{
  border: 1px solid #e6e9ef;
  background: #fff;
  border-radius: 8px;
  width: 34px;
  height: 30px;
  cursor: pointer;
}
.tut-project-pager button:disabled{
  opacity: .45;
  cursor: default;
}
.tut-project-search-body{
  padding: 16px 18px 18px;
  overflow: auto;
}
.tut-project-search-grid{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}
.tut-project-card{
  border: 1px solid #e6e9ef;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
}
.tut-project-card:hover{
  border-color: #1a73e8;
  box-shadow: 0 10px 24px rgba(26,115,232,.14);
  transform: translateY(-1px);
}
.tut-project-thumb{
  position: relative;
  height: 126px;
  background: #eef1f5;
}
.tut-project-thumb img{
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tut-project-cx{
  position: absolute;
  right: 8px;
  bottom: 8px;
  border-radius: 999px;
  padding: 4px 8px;
  background: rgba(32,33,36,.86);
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}
.tut-project-meta{
  padding: 10px 11px 12px;
  display: grid;
  gap: 6px;
}
.tut-project-address{
  font-size: 12px;
  font-weight: 900;
  color: #202124;
  line-height: 1.28;
  min-height: 31px;
}
.tut-project-sub{
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.tut-project-pill{
  border-radius: 999px;
  padding: 4px 7px;
  background: #f1f3f4;
  color: #5f6368;
  font-size: 10px;
  font-weight: 900;
}
.tut-project-actions{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 4px;
}
.tut-project-actions button{
  border: none;
  border-radius: 8px;
  height: 32px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
}
.tut-project-add{ background: #188038; color: #fff; }
.tut-project-open{ background: #e8f0fe; color: #1a73e8; }
.tut-project-empty{
  padding: 32px 14px;
  text-align: center;
  color: #777;
  font-weight: 800;
}
.tut-curriculum-manager-backdrop{
  position: fixed;
  inset: 0;
  z-index: 1000003;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(16,24,40,.66);
  padding: 22px;
}
.tut-curriculum-manager-backdrop.show{ display:flex; }
.tut-curriculum-manager-modal{
  width: min(1280px, 100%);
  max-height: min(840px, calc(100vh - 44px));
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0,0,0,.34);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tut-curriculum-manager-modal *{ box-sizing: border-box; }
.tut-curriculum-manager-head{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid #edf0f5;
}
.tut-curriculum-manager-head h3{
  margin: 0;
  font-size: 18px;
  color: #202124;
}
.tut-curriculum-manager-close{
  width: 34px;
  height: 34px;
  border: 1px solid #e6e9ef;
  background: #fff;
  border-radius: 8px;
  cursor: pointer;
}
.tut-curriculum-manager-body{
  padding: 16px 18px 18px;
  overflow: auto;
  background: #f6f8fb;
}
.tut-curriculum-board{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
.tut-curriculum-column{
  background: #fff;
  border: 1px solid #e6e9ef;
  border-radius: 8px;
  overflow: hidden;
  min-height: 220px;
  min-width: 0;
}
.tut-curriculum-column.drag-over{
  border-color: #1a73e8;
  box-shadow: 0 0 0 2px rgba(26,115,232,.12);
}
.tut-curriculum-column-head{
  padding: 12px 13px;
  border-bottom: 1px solid #edf0f5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.tut-curriculum-column-title{
  font-size: 13px;
  font-weight: 900;
  color: #202124;
  line-height: 1.25;
}
.tut-curriculum-count{
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 4px 8px;
  background: #f1f3f4;
  color: #5f6368;
  font-size: 10px;
  font-weight: 900;
}
.tut-curriculum-list{
  padding: 8px;
  display: grid;
  gap: 8px;
  min-height: 120px;
}
.tut-curriculum-chapter{
  width: auto;
  max-width: 100%;
  border: 1px solid #e6e9ef;
  background: #fff;
  border-radius: 8px;
  padding: 10px;
  text-align: left;
  cursor: grab;
  user-select: none;
  overflow: hidden;
}
.tut-curriculum-chapter:hover{
  border-color: #1a73e8;
  box-shadow: 0 8px 18px rgba(26,115,232,.10);
}
.tut-curriculum-chapter.dragging{
  opacity: .5;
  cursor: grabbing;
}
.tut-curriculum-chapter-title{
  font-size: 12px;
  font-weight: 900;
  color: #202124;
  line-height: 1.25;
}
.tut-curriculum-chapter-desc{
  margin-top: 5px;
  font-size: 11px;
  color: #667085;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tut-curriculum-chapter-actions{
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}
.tut-curriculum-copy-btn{
  border: none;
  border-radius: 8px;
  min-height: 32px;
  padding: 0 10px;
  background: #e8f0fe;
  color: #1a73e8;
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.tut-curriculum-copy-btn:hover{ background:#dbeafe; }
.tut-curriculum-copy-btn:disabled{
  opacity: .45;
  cursor: default;
}
.tut-curriculum-empty{
  padding: 20px 10px;
  color: #777;
  text-align: center;
  font-weight: 800;
  font-size: 12px;
}
.tut-curriculum-manager-foot{
  display: block;
  align-items: center;
  padding: 14px 18px;
  border-top: 1px solid #edf0f5;
  background: #fff;
}
.tut-curriculum-status{
  min-height: 18px;
  font-size: 12px;
  color: #667085;
  font-weight: 800;
}
.tut-curriculum-target-hint{
  color: #667085;
  font-size: 12px;
  font-weight: 800;
}
@media (max-width: 700px){
  .tut-project-search-controls{ grid-template-columns: 1fr; }
  .tut-project-search-grid{ grid-template-columns: 1fr; }
  .tut-curriculum-manager-foot{ grid-template-columns: 1fr; }
}
      `.trim();

      const style = document.createElement('style');
      style.id = ID;
      style.textContent = css;
      document.head.appendChild(style);
    },

    // ---- Permissions / identity ----
    canManageTutorials(){
      const p = cfg().perms || {};
      const role = (cfg().user && cfg().user.role) || '';
      return !!p.manage_tutorials || role === 'admin';
    },

    installExamGradesButton(){
      if (!this.canManageTutorials() || document.getElementById('tutorialExamGradesButton')) return;
      const studentProgressButton = Array.from(document.querySelectorAll('#view-tutorials .header-bar button'))
        .find(button => String(button.textContent || '').includes('Student Progress'));
      if (!studentProgressButton) return;
      const button = document.createElement('button');
      button.id = 'tutorialExamGradesButton';
      button.className = 'btn-secondary';
      button.innerHTML = '<i class="fas fa-clipboard-check"></i> Exam Grades';
      button.addEventListener('click', () => this.openExamGrades());
      studentProgressButton.insertAdjacentElement('afterend', button);
    },

    async openExamGrades(){
      if (!this.canManageTutorials()) return;
      document.getElementById('tutorialExamGradesModal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'tutorialExamGradesModal';
      modal.style.cssText = 'position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; background:rgba(16,24,40,.64); padding:20px;';
      modal.innerHTML = `
        <div role="dialog" aria-modal="true" style="width:90vw; max-width:none; max-height:92vh; display:flex; flex-direction:column; background:#fff; border-radius:12px; box-shadow:0 24px 70px rgba(0,0,0,.32); overflow:hidden;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:20px 22px; border-bottom:1px solid #edf0f5;">
            <div><div style="font-size:20px; font-weight:900; color:#202124;">Exam Grades</div><div style="margin-top:5px; font-size:12px; color:#667085;">Admin-only scores for ${Portal.escapeHtml(tutorialCourseLabel())}</div></div>
            <button type="button" data-close class="btn-secondary"><i class="fas fa-times"></i></button>
          </div>
          <div data-body style="padding:22px; overflow:auto;"><div style="padding:40px; text-align:center; color:#667085;"><i class="fas fa-spinner fa-spin"></i> Loading exam attempts...</div></div>
        </div>`;
      modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-close]')) modal.remove(); });
      document.body.appendChild(modal);
      const data = await Portal.apiPost(cfg().endpoints.portal, tutorialApiPayload({ action:'fetch_tutorial_exam_grades' }))
        .catch(error => ({ success:false, error:error?.message || 'Could not load exam grades.' }));
      if (!modal.isConnected) return;
      const body = modal.querySelector('[data-body]');
      if (!data.success) {
        body.innerHTML = `<div style="padding:30px; text-align:center; color:#a50e0e;">${Portal.escapeHtml(data.error || 'Could not load exam grades.')}</div>`;
        return;
      }
      const attempts = Array.isArray(data.attempts) ? data.attempts : [];
      const categoryKeys = ['line_types', 'facet_count', 'area', 'pitch_areas'];
      const hasCategoryScores = project => {
        const scores = project && project.category_scores && typeof project.category_scores === 'object' ? project.category_scores : {};
        return categoryKeys.some(key => scores[key] !== null && scores[key] !== undefined && scores[key] !== '' && Number.isFinite(Number(scores[key])));
      };
      const missingProjects = [];
      const projectLookup = new Map();
      attempts.forEach(attempt => {
        (Array.isArray(attempt.projects) ? attempt.projects : []).forEach(project => {
          const hasProjectScore = project.score !== null && project.score !== undefined && project.score !== '' && Number.isFinite(Number(project.score));
          if ((!project.submitted && !hasProjectScore) || hasCategoryScores(project)) return;
          const email = String(attempt.student_email || '').trim().toLowerCase();
          const tutorialId = String(project.tutorial_id || '').trim();
          if (!email || !tutorialId) return;
          const key = `${email}|${tutorialId}`;
          if (!projectLookup.has(key)) missingProjects.push({ email, tutorial_id: tutorialId });
          projectLookup.set(key, project);
        });
      });
      if (missingProjects.length) {
        for (let offset = 0; offset < missingProjects.length; offset += 4) {
          const batch = await Portal.apiPost(window.location.pathname || 'index.php', {
            action:'fetch_tutorial_exam_grade_categories',
            course_id: data.course_id || tutorialCourseId(),
            projects: JSON.stringify(missingProjects.slice(offset, offset + 4))
          }).catch(() => null);
          if (!batch || !batch.success || !batch.projects || typeof batch.projects !== 'object') continue;
          Object.entries(batch.projects).forEach(([key, result]) => {
              const project = projectLookup.get(key);
              if (!project || !result || result.success === false || !result.categories || typeof result.categories !== 'object') return;
              project.category_scores = Object.fromEntries(categoryKeys.map(categoryKey => {
                const raw = result.categories?.[categoryKey]?.score;
                const value = Number(raw);
                return [categoryKey, raw !== null && raw !== undefined && raw !== '' && Number.isFinite(value) ? value : null];
              }));
            });
        }
      }
      attempts.forEach(attempt => {
        const scoredProjects = (Array.isArray(attempt.projects) ? attempt.projects : []).filter(project =>
          project.score !== null && project.score !== undefined && project.score !== '' && Number.isFinite(Number(project.score))
        );
        attempt.category_scores = Object.fromEntries(categoryKeys.map(key => {
          const available = scoredProjects.filter(project => {
            const raw = project?.category_scores?.[key];
            return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw));
          });
          const totalWeight = available.reduce((sum, project) => sum + Math.max(0, Number(project.weight) || 1), 0);
          const score = totalWeight > 0
            ? available.reduce((sum, project) => sum + Number(project.category_scores[key]) * Math.max(0, Number(project.weight) || 1), 0) / totalWeight
            : null;
          return [key, score === null ? null : Math.round(score * 100) / 100];
        }));
      });
      if (!attempts.length) {
        body.innerHTML = '<div style="padding:40px; text-align:center; color:#667085;">No exam attempts have been recorded for this curriculum.</div>';
        return;
      }
      const renderAttempts = (tab = 'pending') => {
        const pendingCount = attempts.filter(attempt => !attempt.reviewed_at).length;
        const historyCount = attempts.length - pendingCount;
        const visible = attempts.filter(attempt => tab === 'history' ? !!attempt.reviewed_at : !attempt.reviewed_at);
        body.innerHTML = `
          <div style="display:flex; gap:8px; margin-bottom:14px; border-bottom:1px solid #e6e8ef;">
            <button type="button" data-grade-tab="pending" style="border:0; border-bottom:3px solid ${tab === 'pending' ? '#1a73e8' : 'transparent'}; background:transparent; padding:9px 12px; font-weight:900; color:${tab === 'pending' ? '#1a73e8' : '#667085'}; cursor:pointer;">Needs Review (${pendingCount})</button>
            <button type="button" data-grade-tab="history" style="border:0; border-bottom:3px solid ${tab === 'history' ? '#1a73e8' : 'transparent'}; background:transparent; padding:9px 12px; font-weight:900; color:${tab === 'history' ? '#1a73e8' : '#667085'}; cursor:pointer;">History (${historyCount})</button>
          </div>
          ${visible.length ? `<div style="overflow:auto; border:1px solid #e6e8ef; border-radius:10px;">
            <table style="width:100%; min-width:1460px; border-collapse:collapse;">
              <thead><tr><th>Trainee</th><th>Exam</th><th>Submitted</th><th>Time</th><th>Total Score</th><th>Line Types</th><th>Facets</th><th>Area</th><th>Pitch Areas</th><th>Audit</th><th></th></tr></thead>
              <tbody>${visible.map(attempt => {
              const hasScore = attempt.score !== null && attempt.score !== undefined && attempt.score !== '' && Number.isFinite(Number(attempt.score));
              const score = hasScore ? Number(attempt.score) : null;
              const status = String(attempt.status || '').toLowerCase();
              const isInProgress = status === 'in_progress';
              const scoredProjectCount = Math.max(0, Number(attempt.scored_project_count || 0));
              const totalProjectCount = Math.max(0, Number(attempt.total_project_count || 0));
              const hasProvisionalScore = scoredProjectCount > 0 && attempt.provisional_score !== null && attempt.provisional_score !== undefined && Number.isFinite(Number(attempt.provisional_score));
              const provisionalScore = hasProvisionalScore ? Number(attempt.provisional_score) : null;
              const completed = attempt.completed_at ? new Date(attempt.completed_at).toLocaleString() : (isInProgress ? 'In progress' : 'Not submitted');
              const duration = Number.isFinite(Number(attempt.duration_ms)) ? this.formatRelativeMs(Number(attempt.duration_ms)) : 'Not finished';
              const scoreStatus = hasScore
                ? `${Math.round(score)}%`
                : (hasProvisionalScore
                  ? `${Math.round(provisionalScore)}%`
                : (isInProgress
                  ? 'In progress'
                  : (status === 'calculating' || String(attempt.score_status || '').toLowerCase() === 'calculating'
                    ? 'Grading pending'
                    : 'No recorded grade')));
              const scoreTitle = hasScore
                ? ''
                : (hasProvisionalScore
                  ? `${scoredProjectCount} of ${totalProjectCount} projects scored. This is not the final exam grade.`
                : (isInProgress
                  ? 'This exam has not been completed.'
                  : 'This completed attempt has no numeric grade. Older attempts may predate the current grader, or grading may not have completed.'));
              const categoryScores = attempt.category_scores && typeof attempt.category_scores === 'object' ? attempt.category_scores : {};
              const categoryCell = key => {
                const raw = categoryScores[key];
                const value = Number(raw);
                if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value)) {
                  return '<span style="color:#98a2b3;">—</span>';
                }
                const rounded = Math.round(value * 10) / 10;
                return `<span style="font-weight:900; color:${this.scoreColor(value * 4)}; white-space:nowrap;">${Portal.escapeHtml(rounded)}/25</span>`;
              };
              const reviewedMeta = tab === 'history' && attempt.reviewed_at
                ? `<div style="font-size:10px; color:#667085; margin-top:5px; white-space:nowrap;">${Portal.escapeHtml(new Date(attempt.reviewed_at).toLocaleString())}${attempt.reviewed_by_name || attempt.reviewed_by_email ? ` · ${Portal.escapeHtml(attempt.reviewed_by_name || attempt.reviewed_by_email)}` : ''}</div>`
                : '';
              const projects = Array.isArray(attempt.projects) ? attempt.projects : [];
              const incompleteExam = totalProjectCount > 0 && scoredProjectCount < totalProjectCount;
              const incompleteBadge = incompleteExam
                ? `<div style="display:inline-flex; flex-direction:column; gap:2px; margin-bottom:7px; padding:6px 8px; border:1px solid #fda29b; border-radius:7px; background:#fef3f2; color:#b42318; font-size:10px; font-weight:900; text-transform:uppercase; white-space:nowrap;">Uncompleted Exam<span style="font-size:9px; font-weight:800; text-transform:none;">${scoredProjectCount} of ${totalProjectCount} projects scored</span></div>`
                : '';
              const auditLinks = projects.map((project, index) => {
                const url = `tutorial_audit.php?email=${encodeURIComponent(attempt.student_email || '')}&tutorial_id=${encodeURIComponent(project.tutorial_id || '')}&course_id=${encodeURIComponent(data.course_id || tutorialCourseId())}`;
                const hasProjectScore = project.score !== null && project.score !== undefined && project.score !== '' && Number.isFinite(Number(project.score));
                const projectState = hasProjectScore ? `${Math.round(Number(project.score))}%` : (project.submitted ? 'Grading' : 'In progress');
                const label = projects.length === 1 ? `Open Auditor · ${projectState}` : `Project ${project.sequence || index + 1} · ${projectState}`;
                return `<a class="btn-secondary" style="display:inline-block; font-size:10px; padding:5px 8px; text-decoration:none; margin:2px;" href="${Portal.escapeHtml(url)}" target="_blank" rel="noopener">${Portal.escapeHtml(label)}</a>`;
              }).join('');
              return `<tr>
                <td><b>${Portal.escapeHtml(attempt.student_name || '')}</b><div style="font-size:11px; color:#667085; margin-top:2px;">${Portal.escapeHtml(attempt.student_email || '')}</div></td>
                <td><b>${Portal.escapeHtml(attempt.exam_title || 'Exam')}</b><div style="font-size:11px; color:#667085; margin-top:2px;">Chapter ${Portal.escapeHtml(attempt.chapter_id ?? '')}</div></td>
                <td>${Portal.escapeHtml(completed)}</td>
                <td>${Portal.escapeHtml(duration)}</td>
                <td title="${Portal.escapeHtml(scoreTitle)}" style="font-weight:900; color:${hasScore ? this.scoreColor(score) : (hasProvisionalScore ? this.scoreColor(provisionalScore) : (isInProgress ? '#667085' : '#b06000'))};">${Portal.escapeHtml(scoreStatus)}</td>
                <td>${categoryCell('line_types')}</td>
                <td>${categoryCell('facet_count')}</td>
                <td>${categoryCell('area')}</td>
                <td>${categoryCell('pitch_areas')}</td>
                <td>${incompleteBadge}<div>${auditLinks || '<span style="color:#98a2b3;">Unavailable</span>'}</div></td>
                <td style="text-align:right;"><button type="button" class="btn-secondary" data-review-attempt="${encodeURIComponent(attempt.attempt_id || '')}" data-review-key="${encodeURIComponent(attempt.attempt_key || attempt.attempt_id || '')}" data-review-email="${encodeURIComponent(attempt.student_email || '')}" data-reviewed="${tab === 'history' ? 'false' : 'true'}" style="font-size:10px; white-space:nowrap;">${tab === 'history' ? 'Restore' : 'Mark Done'}</button>${reviewedMeta}</td>
              </tr>`;
              }).join('')}</tbody>
            </table>
          </div>` : `<div style="padding:42px; text-align:center; color:#667085; border:1px dashed #d0d5dd; border-radius:10px;">${tab === 'history' ? 'No reviewed exam attempts yet.' : 'All exam attempts have been reviewed.'}</div>`}`;

        body.querySelectorAll('[data-grade-tab]').forEach(button => button.addEventListener('click', () => renderAttempts(button.dataset.gradeTab)));
        body.querySelectorAll('[data-review-attempt]').forEach(button => button.addEventListener('click', async () => {
          button.disabled = true;
          const reviewed = button.dataset.reviewed === 'true';
          const attemptId = decodeURIComponent(button.dataset.reviewAttempt || '');
          const attemptKey = decodeURIComponent(button.dataset.reviewKey || '');
          const studentEmail = decodeURIComponent(button.dataset.reviewEmail || '');
          const result = await Portal.apiPost(cfg().endpoints.portal, tutorialApiPayload({
            action:'set_tutorial_exam_reviewed',
            attempt_id: attemptId,
            attempt_key: attemptKey,
            email: studentEmail,
            reviewed
          })).catch(error => ({ success:false, error:error?.message || 'Could not update this attempt.' }));
          if (!result.success) {
            button.disabled = false;
            alert(result.error || 'Could not update this attempt.');
            return;
          }
          const attempt = attempts.find(item => String(item.attempt_key || item.attempt_id || '') === attemptKey && normEmail(item.student_email) === normEmail(studentEmail));
          if (attempt) {
            attempt.reviewed_at = result.reviewed_at || null;
            attempt.reviewed_by_email = result.reviewed_by_email || null;
            attempt.reviewed_by_name = result.reviewed_by_name || null;
          }
          renderAttempts(tab);
        }));
      };
      renderAttempts('pending');
    },

    meEmail(){
      return normEmail(cfg().user && cfg().user.email);
    },

    // ---- Visibility rules ----
    chapterVisibleToMe(chap){
      if (!chap || typeof chap !== 'object') return false;
      if (!chap.hidden) return true;
      if (this.canManageTutorials()) return true;
      const allow = uniqEmails(chap.visible_to || chap.visibleTo || chap.allowed_users || chap.allowedUsers || []);
      return allow.includes(this.meEmail());
    },

    rebuildViewChapters(){
      const out = [];
      (this.curriculum.chapters || []).forEach((chap, origIdx) => {
        if (this.chapterVisibleToMe(chap)) out.push({ origIdx, chap });
      });
      this.viewChapters = out;
    },

    // If user's progress is pointing at an invisible chapter, auto-advance over it.
    async ensureProgressNotStuck(){
      if (this._autoSkipInFlight) return;
      if (this.canManageTutorials()) return;
      this._autoSkipInFlight = true;

      try {
        const chapters = this.curriculum.chapters || [];
        let cur = parseInt(this.progress.current_chapter || 1, 10);
        if (!cur || cur < 1) cur = 1;

        let safety = 0;
        while (cur <= chapters.length) {
          const idx0 = cur - 1;
          const chap = chapters[idx0];
          if (!chap) break;

          if (this.chapterVisibleToMe(chap)) break;

          await Portal.apiPost(cfg().endpoints.server, {
            action: 'update_progress',
            type: 'chapter_complete',
            id: cur,
            course_id: tutorialCourseId()
          }).catch(()=>{});

          cur += 1;
          safety += 1;
          if (safety > 200) break;
        }

        if (cur > (this.progress.current_chapter || 1)) {
          this.progress.current_chapter = cur;
        }
      } finally {
        this._autoSkipInFlight = false;
      }
    },

    // ---- Lifecycle ----
    async onShowTutorials(){
      this.syncCourseControls();
      await this.fetchTutorialProjectsMine();
      await this.fetchTutorials();
    },

    async onShowStudentProgress(){
      await this.fetchStudentList();
    },

    openStudentProgress(){
      Portal.switchView('student-progress');
      this.fetchStudentList();
    },

    syncCourseControls(){
      const title = document.getElementById('tutorialCourseTitle');
      if (title) title.textContent = `Training Curriculum: ${tutorialCourseLabel()}`;
      const editorTitle = document.getElementById('editorCourseTitle');
      if (editorTitle) editorTitle.textContent = `Curriculum Editor: ${tutorialCourseLabel()}`;
      const sel = document.getElementById('tutorialCourseSelect');
      if (sel) sel.value = tutorialCourseId();
    },

    async setCourse(courseId){
      const options = tutorialCourseOptions().map(c => String(c.id || ''));
      const normalized = options.includes(String(courseId || '')) ? String(courseId || '') : 'default';
      if (!cfg().tutorials) cfg().tutorials = {};
      if (tutorialCourseId() === normalized) {
        this.syncCourseControls();
        return;
      }
      cfg().tutorials.course_id = normalized;
      this.curriculum = { chapters: [] };
      this.progress = { completed_videos: [], completed_projects: [], current_chapter: 1 };
      this.myTutorialProjectList = [];
      this.syncCourseControls();
      await this.fetchTutorialProjectsMine();
      await this.fetchTutorials();
      const progressView = document.getElementById('view-student-progress');
      if (progressView && progressView.style.display !== 'none') {
        await this.fetchStudentList();
      }
    },

    // ---- Tutorial projects (mine) ----
    async fetchTutorialProjectsMine(){
      if (!tutorialProjectsEnabled()) {
        this.myTutorialProjectList = [];
        return;
      }
      try {
        const data = await Portal.apiPost(cfg().endpoints.server, tutorialApiPayload({ action:'list_tutorial_projects' }));
        this.myTutorialProjectList = data.projects || [];
      } catch {
        this.myTutorialProjectList = [];
      }
    },

    // ---- Normalization ----
    newCurriculumProjectId(){
      return `practice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },

    normalizeCurriculumProject(project){
      const p = Object.assign({}, project || {});
      const sourceId = String(p.source_project_id || p.project_id || p.id || '').trim();
      if (p.curriculum_project_id) p.curriculum_project_id = String(p.curriculum_project_id).replace(/[^a-zA-Z0-9_-]/g, '');
      p.source_project_id = sourceId;
      p.project_id = sourceId;
      if (!p.name) p.name = p.address || sourceId;
      p.grading_enabled = p.grading_enabled !== false;
      return p;
    },

    normalizeTestSection(raw, idx){
      const t = Object.assign({}, raw || {});
      const id = String(t.id || `test_${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '') || `test_${idx + 1}`;
      const projects = Array.isArray(t.projects || t.test_projects || t.test_pool)
        ? (t.projects || t.test_projects || t.test_pool)
        : [];
      return {
        id,
        title: String(t.title || `Test ${idx + 1}`).trim() || `Test ${idx + 1}`,
        projects: tutorialProjectsEnabled() ? projects.map(p => this.normalizeCurriculumProject(p)) : [],
        sample_count: Math.max(1, parseInt(t.sample_count || 5, 10) || 5),
        time_limit_minutes: Math.max(0, parseInt(t.time_limit_minutes || 120, 10) || 0),
        passing_score_percent: Math.max(0, Math.min(100, parseInt(t.passing_score_percent || 80, 10) || 80)),
        required: t.required === true,
        retakeable: t.retakeable !== false,
        retake_wait_hours: Math.max(0, parseInt(t.retake_wait_hours || 24, 10) || 0)
      };
    },

    normalizeDecision(value){
      const raw = String(value || '').trim().toLowerCase();
      if (['reject', 'rejected', 'deny', 'denied'].includes(raw)) return 'reject';
      return 'draft';
    },

    normalizeDraftRejectRound(raw, idx){
      const r = Object.assign({}, raw || {});
      const projects = Array.isArray(r.projects || r.project_pool) ? (r.projects || r.project_pool) : [];
      return {
        id: String(r.id || `draft_reject_${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '') || `draft_reject_${idx + 1}`,
        title: String(r.title || `Draft or Reject ${idx + 1}`).trim() || `Draft or Reject ${idx + 1}`,
        mode: r.mode === 'test' ? 'test' : 'practice',
        projects: tutorialProjectsEnabled() ? projects.map(p => {
          const out = this.normalizeCurriculumProject(p);
          out.correct_decision = this.normalizeDecision(out.correct_decision || out.answer || out.expected_decision || 'draft');
          return out;
        }) : [],
        sample_count: Math.max(1, parseInt(r.sample_count || 5, 10) || 5),
        passing_score_percent: Math.max(0, Math.min(100, parseInt(r.passing_score_percent || 80, 10) || 80)),
        required: r.required === true,
        retake_wait_hours: Math.max(0, parseInt(r.retake_wait_hours || 24, 10) || 0)
      };
    },

    normalizeCurriculumAndProgress(){
      if (!this.curriculum || typeof this.curriculum !== 'object') this.curriculum = { chapters: [] };
      if (!Array.isArray(this.curriculum.chapters)) this.curriculum.chapters = [];

      this.curriculum.chapters = this.curriculum.chapters.map(ch => {
        const out = Object.assign({}, ch || {});
        out.title = (typeof out.title === 'string' && out.title.trim() !== '') ? out.title : 'Untitled';
        out.description = (typeof out.description === 'string') ? out.description : '';
        out.videos = Array.isArray(out.videos) ? out.videos : [];
        out.pdfs = Array.isArray(out.pdfs) ? out.pdfs : [];
        out.projects = tutorialProjectsEnabled() && Array.isArray(out.projects) ? out.projects.map(p => this.normalizeCurriculumProject(p)) : [];
        out.test_projects = tutorialProjectsEnabled() && Array.isArray(out.test_projects || out.test_pool)
          ? (out.test_projects || out.test_pool)
          : [];
        const rawTests = Array.isArray(out.tests) ? out.tests : [];
        out.tests = rawTests.map((t, idx) => this.normalizeTestSection(t, idx));
        out.draft_reject_rounds = Array.isArray(out.draft_reject_rounds)
          ? out.draft_reject_rounds.map((r, idx) => this.normalizeDraftRejectRound(r, idx))
          : [];
        const legacyTestEnabled = !!(out.test_enabled || out.has_test || out.is_test || String(out.mode || out.chapter_type || '').toLowerCase() === 'test' || out.test_projects.length);
        if (!out.tests.length && legacyTestEnabled) {
          const legacy = Object.assign({}, out.test || {}, {
            id: 'test_1',
            title: out.test_title || 'Test',
            projects: out.test_projects,
            sample_count: out.test?.sample_count || out.sample_count || 5,
            time_limit_minutes: out.test?.time_limit_minutes || out.time_limit_minutes || 120,
            passing_score_percent: out.test?.passing_score_percent || out.passing_score_percent || 80,
            required: out.test?.required ?? out.test_required ?? false,
            retakeable: out.test?.retakeable ?? out.retakeable ?? true,
            retake_wait_hours: out.test?.retake_wait_hours || out.retake_wait_hours || 24
          });
          out.tests.push(this.normalizeTestSection(legacy, 0));
        }
        out.test_enabled = out.tests.length > 0;

        out.hidden = !!out.hidden;
        out.visible_to = uniqEmails(out.visible_to || out.visibleTo || out.allowed_users || out.allowedUsers || []);

        if (out.show_videos !== false && out.show_videos !== true) out.show_videos = true;
        if (out.show_pdfs !== false && out.show_pdfs !== true) out.show_pdfs = true;

        return out;
      });

      if (!this.progress || typeof this.progress !== 'object') this.progress = {};
      if (!Array.isArray(this.progress.completed_videos)) this.progress.completed_videos = [];
      if (!Array.isArray(this.progress.completed_projects)) this.progress.completed_projects = [];
      if (!this.progress.test_attempts || typeof this.progress.test_attempts !== 'object' || Array.isArray(this.progress.test_attempts)) this.progress.test_attempts = {};
      this.progress.current_chapter = parseInt(this.progress.current_chapter || 1, 10);
      if (!this.progress.current_chapter || this.progress.current_chapter < 1) this.progress.current_chapter = 1;
    },

    // ---- Gating helpers ----
    isVideoOpened(url){
      return (this.progress.completed_videos || []).some(v => (typeof v === 'string' ? v === url : (v && v.url === url)));
    },

    startedMasterIdSet(){
      const s = new Set();
      (this.myTutorialProjectList || []).forEach(p => {
        if (!p || !p.is_tutorial_instance) return;
        const itemId = p.curriculum_project_id || p.practice_project_id;
        const sourceId = p.source_project_id || p.original_master_id;
        if (itemId) s.add(`item:${itemId}`);
        else if (sourceId) s.add(`source:${sourceId}`);
      });
      return s;
    },

    testAttemptForChapter(origIdx, status=null, testId=null){
      const attempts = this.progress && this.progress.test_attempts && typeof this.progress.test_attempts === 'object'
        ? Object.values(this.progress.test_attempts)
        : [];
      return attempts
        .filter(a => a && String(a.type || '') !== 'draft_reject')
        .filter(a => String(a.chapter_id || '') === String((origIdx || 0) + 1))
        .filter(a => !testId || String(a.test_id || 'test_1') === String(testId))
        .filter(a => !status || String(a.status || '') === status)
        .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0] || null;
    },

    testAttemptsForChapter(origIdx, testId=null){
      const attempts = this.progress && this.progress.test_attempts && typeof this.progress.test_attempts === 'object'
        ? Object.values(this.progress.test_attempts)
        : [];
      return attempts
        .filter(a => a && String(a.type || '') !== 'draft_reject')
        .filter(a => String(a.chapter_id || '') === String((origIdx || 0) + 1))
        .filter(a => !testId || String(a.test_id || 'test_1') === String(testId))
        .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    },

    testAttemptPassed(attempt, test=null){
      if (!attempt) return false;
      if (attempt.passed === true) return true;
      const score = Number(attempt.final_score);
      const passing = Math.max(0, Math.min(100, Number(attempt.passing_score_percent ?? test?.passing_score_percent ?? 80) || 80));
      return Number.isFinite(score) && score >= passing;
    },

    requiredTestPassed(origIdx, test){
      return this.testAttemptsForChapter(origIdx, test?.id)
        .some(attempt => this.testAttemptPassed(attempt, test));
    },

    chapterHasTest(chap){
      return !!(chap && tutorialProjectsEnabled() && Array.isArray(chap.tests) && chap.tests.length > 0);
    },

    chapterHasDraftReject(chap){
      return !!(chap && tutorialProjectsEnabled() && Array.isArray(chap.draft_reject_rounds) && chap.draft_reject_rounds.length > 0);
    },

    draftRejectAttemptsForChapter(origIdx, roundId=null){
      const attempts = this.progress && this.progress.test_attempts && typeof this.progress.test_attempts === 'object'
        ? Object.values(this.progress.test_attempts)
        : [];
      return attempts
        .filter(a => a && String(a.type || '') === 'draft_reject')
        .filter(a => String(a.chapter_id || '') === String((origIdx || 0) + 1))
        .filter(a => !roundId || String(a.round_id || '') === String(roundId))
        .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    },

    draftRejectAttemptForChapter(origIdx, status=null, roundId=null){
      return this.draftRejectAttemptsForChapter(origIdx, roundId)
        .filter(a => !status || String(a.status || '') === status)[0] || null;
    },

    requiredDraftRejectPassed(origIdx, round){
      if (!round || round.mode !== 'test') return true;
      return this.draftRejectAttemptsForChapter(origIdx, round.id)
        .some(attempt => this.testAttemptPassed(attempt, { passing_score_percent: round.passing_score_percent }));
    },

    formatRelativeMs(ms){
      const totalMinutes = Math.max(0, Math.ceil(Number(ms || 0) / 60000));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const parts = [];
      if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
      if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
      if (!days && minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
      return parts.length ? parts.join(' ') : 'now';
    },

    formatAttemptDuration(attempt){
      const startMs = Date.parse(attempt?.started_at || '');
      const endMs = Date.parse(attempt?.completed_at || attempt?.updated_at || '');
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 'Not finished';
      return this.formatRelativeMs(endMs - startMs);
    },

    scoreColor(value){
      if (value === null || value === undefined || value === '') return '#b06000';
      const score = Number(value);
      if (!Number.isFinite(score)) return '#b06000';
      if (score < 60) return '#a50e0e';
      if (score < 75) return '#d97706';
      if (score < 90) return '#b58900';
      return '#188038';
    },

    renderAttemptProjectScoreBreakdown(attempt){
      const scores = attempt && attempt.project_scores && typeof attempt.project_scores === 'object'
        ? Object.values(attempt.project_scores)
        : [];
      if (!scores.length) return '';
      return `
        <div style="margin-top:14px; border:1px solid #edf0f5; border-radius:10px; overflow:hidden;">
          <div style="padding:9px 12px; background:#f8f9fb; border-bottom:1px solid #edf0f5; font-size:12px; font-weight:900; color:#344054;">Rubric breakdown</div>
          ${scores.map((entry, idx) => {
            const score = Number(entry?.score);
            const categories = entry && entry.categories && typeof entry.categories === 'object' ? Object.values(entry.categories) : [];
            return `
              <div style="padding:11px 12px; border-top:${idx ? '1px solid #edf0f5' : 'none'};">
                <div style="display:flex; justify-content:space-between; gap:12px; font-size:12px; font-weight:900; color:#202124;">
                  <span>Project ${idx + 1}</span>
                  <span style="color:${this.scoreColor(score)};">${Number.isFinite(score) ? `${Math.round(score)}%` : 'Calculating'}</span>
                </div>
                ${categories.length ? `<div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:6px; margin-top:8px;">
                  ${categories.map(cat => {
                    const catScore = Number(cat.score);
                    const max = Number(cat.max_score);
                    const catPct = Number.isFinite(catScore) && Number.isFinite(max) && max > 0 ? (catScore / max) * 100 : null;
                    const status = String(cat.status || '').toLowerCase();
                    const statusColor = Number.isFinite(catPct) ? this.scoreColor(catPct) : (status === 'correct' ? '#188038' : (status === 'partial' ? '#d97706' : '#a50e0e'));
                    const statusText = status === 'correct' ? 'Correct' : (status === 'partial' ? 'Partial' : (status === 'missed' ? 'Missed' : 'Review'));
                    const diff = Number(cat.diff_percent);
                    return `<div style="background:#f8f9fb; border:1px solid #edf0f5; border-radius:7px; padding:6px; font-size:11px; color:#667085;">
                      <div style="display:flex; justify-content:space-between; gap:8px;">
                        <b style="color:#344054;">${Portal.escapeHtml(cat.label || cat.key || 'Metric')}</b>
                        <span style="color:${statusColor}; font-weight:900;">${Number.isFinite(catScore) && Number.isFinite(max) ? `${Math.round(catScore)}/${Math.round(max)}` : statusText}</span>
                      </div>
                      <div style="margin-top:4px; color:${statusColor}; font-weight:800;">${Portal.escapeHtml(statusText)}${Number.isFinite(diff) ? ` - ${Portal.escapeHtml(diff)}% off` : ''}</div>
                    </div>`;
                  }).join('')}
                </div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    },

    findTutorialAttempt(attemptId){
      const id = String(attemptId || '');
      const attempts = this.progress && this.progress.test_attempts && typeof this.progress.test_attempts === 'object'
        ? Object.values(this.progress.test_attempts)
        : [];
      return attempts.find(a => a && String(a.id || '') === id) || null;
    },

    showAttemptRubricModal(attemptOrId){
      const attempt = typeof attemptOrId === 'object' && attemptOrId
        ? attemptOrId
        : this.findTutorialAttempt(attemptOrId);
      if (!attempt) return;
      const breakdown = this.renderAttemptProjectScoreBreakdown(attempt);
      if (!breakdown) return;
      document.getElementById('tutorialRubricModal')?.remove();
      const score = Number(attempt.final_score);
      const scoreText = Number.isFinite(score) ? `${Math.round(score)}%` : 'Calculating';
      const modal = document.createElement('div');
      modal.id = 'tutorialRubricModal';
      modal.style.cssText = 'position:fixed; inset:0; z-index:100001; display:flex; align-items:center; justify-content:center; background:rgba(16,24,40,.64); padding:24px;';
      modal.innerHTML = `
        <div role="dialog" aria-modal="true" style="width:min(620px, 100%); max-height:min(760px, 92vh); overflow:auto; background:#fff; border-radius:12px; box-shadow:0 24px 70px rgba(0,0,0,.32);">
          <div style="padding:20px 22px 12px; border-bottom:1px solid #edf0f5;">
            <div style="display:flex; justify-content:space-between; gap:14px; align-items:flex-start;">
              <div>
                <div style="font-size:20px; font-weight:900; color:#202124;">Rubric Breakdown</div>
                <div style="margin-top:6px; font-size:12px; color:#667085;">Subprojects are hidden, but their scoring details are shown here.</div>
              </div>
              <div style="font-size:20px; font-weight:900; color:${this.scoreColor(score)};">${Portal.escapeHtml(scoreText)}</div>
            </div>
          </div>
          <div style="padding:0 22px 20px;">${breakdown}</div>
          <div style="display:flex; justify-content:flex-end; padding:14px 22px 20px; border-top:1px solid #edf0f5;">
            <button type="button" id="tutorialRubricClose" class="btn-secondary">Close</button>
          </div>
        </div>
      `;
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) modal.remove();
      });
      document.body.appendChild(modal);
      modal.querySelector('#tutorialRubricClose')?.addEventListener('click', () => modal.remove());
    },

    jsArg(value){
      return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
    },

    formatScoreText(value){
      if (value === null || value === undefined || value === '') return 'Not scored';
      const score = Number(value);
      return Number.isFinite(score) ? `${Math.round(score * 100) / 100}%` : 'Not scored';
    },

    auditValueHtml(value){
      if (value === null || value === undefined || value === '') return '<span style="color:#98a2b3;">null</span>';
      if (typeof value === 'number') return Portal.escapeHtml(Math.round(value * 100) / 100);
      if (typeof value === 'boolean') return value ? '<b style="color:#188038;">true</b>' : '<b style="color:#a50e0e;">false</b>';
      if (typeof value === 'object') {
        return `<pre style="margin:0; max-height:180px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.45; color:#344054; background:#f8fafc; border:1px solid #e5e8ef; border-radius:7px; padding:8px;">${Portal.escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
      }
      return Portal.escapeHtml(String(value));
    },

    auditMetaRow(label, value){
      return `
        <div style="border:1px solid #e6e8ef; border-radius:8px; padding:10px; background:#fff;">
          <div style="font-size:10px; font-weight:900; text-transform:uppercase; color:#667085;">${Portal.escapeHtml(label)}</div>
          <div style="margin-top:5px; font-size:13px; font-weight:900; color:#202124; word-break:break-word;">${this.auditValueHtml(value)}</div>
        </div>
      `;
    },

    auditLinkButton(label, url, primary = false){
      const href = String(url || '').trim();
      if (!href) return '';
      const style = primary
        ? 'background:#202124; border-color:#202124; color:#fff;'
        : 'background:#fff; border-color:#d0d5dd; color:#344054;';
      return `<a href="${Portal.escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-flex; align-items:center; justify-content:center; min-height:34px; padding:8px 11px; border:1px solid; border-radius:7px; text-decoration:none; font-size:12px; font-weight:900; ${style}">${Portal.escapeHtml(label)}</a>`;
    },

    renderProjectAuditModal(audit){
      document.getElementById('tutorialProjectAuditModal')?.remove();
      const stored = audit?.stored_score || {};
      const current = audit?.current_score || {};
      const project = audit?.project || {};
      const answerKey = audit?.answer_key || {};
      const links = audit?.links || {};
      const sourceProjectId = String(audit?.source_project_id || answerKey.source_project_id || '').trim();
      const projectAddress = String(project.source_address || project.address || '').trim();
      const studentEmail = String(audit?.student_email || '').trim();
      const studentProjectUrl = String(links.student_project_editor_url || (audit?.tutorial_id ? `editor.php?tutorial=1&folder=${encodeURIComponent(audit.tutorial_id)}&course_id=${encodeURIComponent(audit?.course_id || tutorialCourseId())}${studentEmail ? `&student_email=${encodeURIComponent(studentEmail)}` : ''}` : '')).trim();
      const sourceProjectUrl = String(links.source_project_editor_url || (sourceProjectId ? `editor.php?folder=${encodeURIComponent(sourceProjectId)}` : '')).trim();
      const mapSearchUrl = String(links.map_search_url || (projectAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(projectAddress)}` : '')).trim();
      const mapEmbedUrl = String(links.map_embed_url || (projectAddress ? `https://maps.google.com/maps?q=${encodeURIComponent(projectAddress)}&output=embed` : '')).trim();
      const categories = audit?.categories && typeof audit.categories === 'object' ? Object.values(audit.categories) : [];
      const rawJson = JSON.stringify({
        project: audit?.project || null,
        stored_score: stored,
        current_score: current,
        answer_key: answerKey,
        links,
        submitted_metrics: audit?.submitted_metrics || null,
        expected_metrics: audit?.expected_metrics || null,
        categories: audit?.categories || null,
        raw_details: audit?.raw_details || null
      }, null, 2);
      const currentScore = Number(current.score);
      const storedScore = Number(stored.score);
      const modal = document.createElement('div');
      modal.id = 'tutorialProjectAuditModal';
      modal.style.cssText = 'position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center; background:rgba(16,24,40,.68); padding:22px;';
      modal.innerHTML = `
        <div role="dialog" aria-modal="true" style="width:min(1040px, 100%); max-height:min(860px, 94vh); overflow:auto; background:#fff; border-radius:10px; box-shadow:0 24px 70px rgba(0,0,0,.32);">
          <div style="position:sticky; top:0; z-index:1; background:#fff; border-bottom:1px solid #edf0f5; padding:18px 20px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:14px;">
              <div>
                <div style="font-size:20px; font-weight:900; color:#202124;">Grading Audit</div>
                <div style="margin-top:5px; font-size:12px; color:#667085;">${Portal.escapeHtml(audit?.student_email || '')} · ${Portal.escapeHtml(audit?.tutorial_id || '')}</div>
              </div>
              <button type="button" id="tutorialProjectAuditCloseTop" class="btn-secondary"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div style="padding:18px 20px 22px; display:grid; gap:16px;">
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px;">
              ${this.auditMetaRow('Stored Grade', this.formatScoreText(stored.score))}
              ${this.auditMetaRow('Recomputed Grade', this.formatScoreText(current.score))}
              ${this.auditMetaRow('Score Status', current.score_status || stored.score_status || 'calculating')}
              ${this.auditMetaRow('Grading Version', current.grading_version || stored.grading_version || '')}
              ${this.auditMetaRow('Answer Key Version', answerKey.version ?? '')}
              ${this.auditMetaRow('Source Project', sourceProjectId)}
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
              <div style="border:1px solid #e6e8ef; border-radius:8px; overflow:hidden; background:#fff;">
                <div style="padding:10px 12px; background:#f8fafc; border-bottom:1px solid #e6e8ef; font-weight:900; color:#344054;">Project Links</div>
                <div style="padding:12px;">
                  <div style="font-size:10px; font-weight:900; text-transform:uppercase; color:#667085;">Student Project</div>
                  <div style="margin-top:5px; font-size:13px; font-weight:900; color:#202124; word-break:break-word;">${Portal.escapeHtml(audit?.tutorial_id || '')}</div>
                  <div style="font-size:10px; font-weight:900; text-transform:uppercase; color:#667085; margin-top:12px;">Source Project</div>
                  <div style="margin-top:5px; font-size:13px; font-weight:900; color:#202124; word-break:break-word;">${Portal.escapeHtml(sourceProjectId)}</div>
                  <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:11px;">
                    ${this.auditLinkButton('Open Student Project', studentProjectUrl, true)}
                    ${this.auditLinkButton('Open Source Project', sourceProjectUrl)}
                  </div>
                </div>
              </div>
              <div style="border:1px solid #e6e8ef; border-radius:8px; overflow:hidden; background:#fff;">
                <div style="padding:10px 12px; background:#f8fafc; border-bottom:1px solid #e6e8ef; font-weight:900; color:#344054;">Address</div>
                <div style="padding:12px;">
                  <div style="font-size:13px; font-weight:900; color:#202124; word-break:break-word;">${Portal.escapeHtml(projectAddress || 'No address recorded')}</div>
                  <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:11px;">
                    ${this.auditLinkButton('Open Google Maps', mapSearchUrl, true)}
                  </div>
                </div>
                ${mapEmbedUrl ? `<iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${Portal.escapeHtml(mapEmbedUrl)}" style="display:block; width:100%; height:230px; border:0; background:#eef2f7;"></iframe>` : ''}
              </div>
            </div>
            ${Number.isFinite(storedScore) && Number.isFinite(currentScore) && Math.abs(storedScore - currentScore) > 0.01 ? `
              <div style="border:1px solid #fed7aa; background:#fffbeb; color:#92400e; border-radius:8px; padding:10px 12px; font-size:12px; font-weight:800;">
                Stored and recomputed grades differ. The current grader reports ${Portal.escapeHtml(this.formatScoreText(current.score))}; the stored record shows ${Portal.escapeHtml(this.formatScoreText(stored.score))}.
              </div>
            ` : ''}
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
              ${this.auditMetaRow('Project Status', project.status || '')}
              ${this.auditMetaRow('Project Type', project.tutorial_kind || '')}
              ${this.auditMetaRow('Chapter', project.chapter_id ?? '')}
              ${this.auditMetaRow('Test Attempt', project.test_attempt_id || '')}
              ${this.auditMetaRow('Sequence', project.sequence_total ? `${project.sequence_index || '?'} / ${project.sequence_total}` : '')}
              ${this.auditMetaRow('Scored At', current.scored_at || stored.scored_at || '')}
            </div>
            <div style="border:1px solid #e6e8ef; border-radius:8px; overflow:hidden;">
              <div style="padding:10px 12px; background:#f8fafc; border-bottom:1px solid #e6e8ef; font-weight:900; color:#344054;">Category Math</div>
              <div style="overflow:auto;">
                <table style="width:100%; border-collapse:collapse; min-width:920px;">
                  <thead>
                    <tr style="background:#fff;">
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Category</th>
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Points</th>
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Diff</th>
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Credit Band</th>
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Expected</th>
                      <th style="text-align:left; padding:9px 10px; border-bottom:1px solid #edf0f5; font-size:11px; color:#667085;">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${categories.length ? categories.map(cat => {
                      const score = Number(cat.score);
                      const max = Number(cat.max_score);
                      const diff = Number(cat.diff_percent);
                      const pct = Number.isFinite(score) && Number.isFinite(max) && max > 0 ? (score / max) * 100 : null;
                      const color = pct !== null ? this.scoreColor(pct) : '#667085';
                      const band = `${cat.full_credit_at_diff_percent ?? '?'}% full / ${cat.zero_credit_at_diff_percent ?? '?'}% zero`;
                      return `
                        <tr>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5;">
                            <div style="font-weight:900; color:#202124;">${Portal.escapeHtml(cat.label || cat.key || '')}</div>
                            <div style="font-size:11px; color:#667085; margin-top:3px;">${Portal.escapeHtml(cat.metric_key || '')}</div>
                            ${cat.message ? `<div style="font-size:11px; color:#667085; margin-top:5px;">${Portal.escapeHtml(cat.message)}</div>` : ''}
                          </td>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5; font-weight:900; color:${color};">${Number.isFinite(score) && Number.isFinite(max) ? `${score} / ${max}` : Portal.escapeHtml(cat.status || '')}</td>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5;">${Number.isFinite(diff) ? `${diff}%` : '-'}</td>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5;">${Portal.escapeHtml(band)}</td>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5;">${this.auditValueHtml(cat.expected_value)}</td>
                          <td style="vertical-align:top; padding:10px; border-bottom:1px solid #edf0f5;">${this.auditValueHtml(cat.submitted_value)}</td>
                        </tr>
                      `;
                    }).join('') : `
                      <tr><td colspan="6" style="padding:18px; color:#667085; text-align:center;">No category details are available yet.</td></tr>
                    `}
                  </tbody>
                </table>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
              <div>
                <div style="font-weight:900; color:#344054; margin-bottom:6px;">Expected Metrics</div>
                ${this.auditValueHtml(audit?.expected_metrics || {})}
              </div>
              <div>
                <div style="font-weight:900; color:#344054; margin-bottom:6px;">Submitted Metrics</div>
                ${this.auditValueHtml(audit?.submitted_metrics || {})}
              </div>
            </div>
            <details style="border:1px solid #e6e8ef; border-radius:8px; padding:10px 12px;">
              <summary style="cursor:pointer; font-weight:900; color:#344054;">Raw Grader Payload</summary>
              <pre style="margin:10px 0 0; max-height:320px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.45; color:#344054;">${Portal.escapeHtml(rawJson)}</pre>
            </details>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:10px; padding:14px 20px 18px; border-top:1px solid #edf0f5;">
            <button type="button" id="tutorialProjectAuditClose" class="btn-secondary">Close</button>
          </div>
        </div>
      `;
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) modal.remove();
      });
      document.body.appendChild(modal);
      modal.querySelector('#tutorialProjectAuditClose')?.addEventListener('click', () => modal.remove());
      modal.querySelector('#tutorialProjectAuditCloseTop')?.addEventListener('click', () => modal.remove());
    },

    async openProjectGradingAudit(email, tutorialId){
      const studentEmail = String(email || '').trim();
      const id = String(tutorialId || '').trim();
      if (!studentEmail || !id) return;
      const data = await Portal.apiPost(window.location.pathname || 'index.php', {
        action:'fetch_tutorial_project_audit',
        email: studentEmail,
        tutorial_id: id,
        course_id: tutorialCourseId()
      }).catch((err) => ({ success:false, error: err?.message || 'Could not load grading audit.' }));
      if (!data.success) {
        alert(data.error || 'Could not load grading audit.');
        return;
      }
      this.renderProjectAuditModal(data);
    },

    testStartState(chap, origIdx, test=null){
      test = test || (Array.isArray(chap?.tests) ? chap.tests[0] : null) || {};
      const sampleCount = Math.max(1, parseInt(test.sample_count || 5, 10) || 5);
      const poolCount = Array.isArray(test.projects) ? test.projects.length : 0;
      if (poolCount <= 0) {
        return {
          canStart: false,
          buttonText: 'Unavailable',
          statusText: 'No test projects configured',
          detailText: 'Ask an admin to add projects to this test.'
        };
      }
      const assignedCount = Math.min(
        Math.max(1, poolCount || sampleCount),
        sampleCount
      );
      const minutes = Math.max(0, parseInt(test.time_limit_minutes || 0, 10) || 0);
      const attempts = this.testAttemptsForChapter(origIdx, test.id);
      const active = attempts.find(a => String(a.status || '') === 'in_progress');
      if (active) {
        return {
          canStart: true,
          buttonText: 'Resume Test',
          statusText: `${active.completed_count || 0}/${active.sample_count || assignedCount} submitted`,
          detailText: `${assignedCount} project${assignedCount === 1 ? '' : 's'}${minutes ? `, ${minutes}-minute limit` : ''}`
        };
      }

      const latest = attempts[0] || null;
      const retakeable = test.retakeable !== false;
      const waitHours = Math.max(0, parseInt(test.retake_wait_hours || 0, 10) || 0);
      if (latest) {
        const score = Number(latest.final_score);
        const scoreText = Number.isFinite(score)
          ? `Score: ${Math.round(score)}%`
          : (latest.status === 'calculating' ? 'Score calculating' : 'Submitted');

        if (!retakeable) {
          return {
            canStart: false,
            buttonText: 'Retake Locked',
            statusText: scoreText,
            detailText: 'This test cannot be retaken.'
          };
        }

        const completedMs = Date.parse(latest.completed_at || latest.updated_at || latest.started_at || '');
        const readyMs = Number.isFinite(completedMs) ? completedMs + (waitHours * 3600000) : Date.now();
        const waitMs = readyMs - Date.now();
        if (waitMs > 0) {
          return {
            canStart: false,
            buttonText: 'Retake Locked',
            statusText: scoreText,
            detailText: `Retakeable in ${this.formatRelativeMs(waitMs)}.`
          };
        }

        return {
          canStart: true,
          buttonText: 'Start Retake',
          statusText: scoreText,
          detailText: `${assignedCount} project${assignedCount === 1 ? '' : 's'}${minutes ? `, ${minutes}-minute limit` : ''}`
        };
      }

      return {
        canStart: true,
        buttonText: 'Start Test',
        statusText: `${assignedCount} project${assignedCount === 1 ? '' : 's'} test`,
        detailText: `${assignedCount} project${assignedCount === 1 ? '' : 's'}${minutes ? `, ${minutes}-minute limit` : ''}`
      };
    },

    draftRejectStartState(chap, origIdx, round=null){
      round = round || (Array.isArray(chap?.draft_reject_rounds) ? chap.draft_reject_rounds[0] : null) || {};
      const sampleCount = Math.max(1, parseInt(round.sample_count || 5, 10) || 5);
      const poolCount = Array.isArray(round.projects) ? round.projects.length : 0;
      if (poolCount <= 0) {
        return { canStart: false, buttonText: 'Unavailable', statusText: 'No project pool configured', detailText: 'Ask an admin to add projects.' };
      }
      const assignedCount = Math.min(sampleCount, poolCount);
      const attempts = this.draftRejectAttemptsForChapter(origIdx, round.id);
      const active = attempts.find(a => String(a.status || '') === 'in_progress');
      if (active) {
        return {
          canStart: true,
          buttonText: 'Resume Round',
          statusText: `${active.completed_count || 0}/${active.sample_count || assignedCount} answered`,
          detailText: `${assignedCount} project${assignedCount === 1 ? '' : 's'}`
        };
      }
      const latest = attempts[0] || null;
      if (latest && round.mode === 'test') {
        const score = Number(latest.final_score);
        const scoreText = Number.isFinite(score) ? `Score: ${Math.round(score)}%` : 'Submitted';
        const waitHours = Math.max(0, parseInt(round.retake_wait_hours || 0, 10) || 0);
        const completedMs = Date.parse(latest.completed_at || latest.updated_at || latest.started_at || '');
        const readyMs = Number.isFinite(completedMs) ? completedMs + (waitHours * 3600000) : Date.now();
        const waitMs = readyMs - Date.now();
        if (waitMs > 0) {
          return { canStart: false, buttonText: 'Retake Locked', statusText: scoreText, detailText: `Retakeable in ${this.formatRelativeMs(waitMs)}.` };
        }
        return { canStart: true, buttonText: 'Start Retake', statusText: scoreText, detailText: `${assignedCount} project${assignedCount === 1 ? '' : 's'}` };
      }
      return {
        canStart: true,
        buttonText: latest ? 'Practice Again' : (round.mode === 'test' ? 'Start Round' : 'Start Practice'),
        statusText: round.mode === 'test' ? `${assignedCount} project${assignedCount === 1 ? '' : 's'} test` : `${assignedCount} project${assignedCount === 1 ? '' : 's'} practice`,
        detailText: `Accept or reject each project`
      };
    },

    chapterGateReport(chap){
      const missing = [];
      let openedCount = 0;
      let totalCount = 0;

      const started = this.startedMasterIdSet();
      const vids = (chap?.show_videos === false) ? [] : (chap?.videos || []);
      const projs = tutorialProjectsEnabled() ? (chap?.projects || []) : [];

      vids.forEach(v => {
        if (!v || !v.url) return;
        totalCount++;
        if (this.isVideoOpened(v.url)) openedCount++;
        else missing.push(`Video: ${v.title || v.url}`);
      });

      projs.forEach(p => {
        const sourceProjectId = p && (p.project_id || p.source_project_id || p.id);
        if (!sourceProjectId) return;
        totalCount++;
        const itemId = p.curriculum_project_id || p.practice_project_id;
        if ((itemId && started.has(`item:${itemId}`)) || (!itemId && started.has(`source:${sourceProjectId}`))) openedCount++;
        else missing.push(`Project: ${p.name || sourceProjectId}`);
      });

      if (this.chapterHasTest(chap)) {
        const origIdx = this.curriculum.chapters.indexOf(chap);
        (chap.tests || []).forEach(test => {
          if (!test.required) return;
          totalCount++;
          if (this.requiredTestPassed(origIdx, test)) openedCount++;
          else {
            const latest = this.testAttemptForChapter(origIdx, null, test.id);
            if (latest && String(latest.status || '') === 'calculating') missing.push(`Required test still scoring: ${test.title || 'Untitled'}`);
            else if (latest && Number.isFinite(Number(latest.final_score))) missing.push(`Required test not passed: ${test.title || 'Untitled'}`);
            else missing.push(`Required test: ${test.title || 'Untitled'}`);
          }
        });
      }

      if (this.chapterHasDraftReject(chap)) {
        const origIdx = this.curriculum.chapters.indexOf(chap);
        (chap.draft_reject_rounds || []).forEach(round => {
          if (!round.required || round.mode !== 'test') return;
          totalCount++;
          if (this.requiredDraftRejectPassed(origIdx, round)) openedCount++;
          else {
            const latest = this.draftRejectAttemptForChapter(origIdx, null, round.id);
            if (latest && Number.isFinite(Number(latest.final_score))) missing.push(`Required draft/reject round not passed: ${round.title || 'Untitled'}`);
            else missing.push(`Required draft/reject round: ${round.title || 'Untitled'}`);
          }
        });
      }

      return { missing, openedCount, totalCount };
    },

    renderChapterProgressPill(chap){
      const pill = document.getElementById('chapProgress');
      if (!pill) return;

      const rep = this.chapterGateReport(chap);
      if (rep.totalCount <= 0) {
        pill.textContent = 'Ready';
        pill.style.background = '#e6f4ea';
        pill.style.color = '#137333';
        return;
      }

      const pct = Math.round((rep.openedCount / rep.totalCount) * 100);
      pill.textContent = `${pct}% Opened (${rep.openedCount}/${rep.totalCount})`;

      if (pct >= 100) {
        pill.style.background = '#e6f4ea';
        pill.style.color = '#137333';
      } else {
        pill.style.background = '#e8f0fe';
        pill.style.color = '#1a73e8';
      }
    },

    renderTestAttemptHistory(chap, origIdx, test=null){
      if (!this.chapterHasTest(chap)) return '';
      test = test || (chap.tests || [])[0] || {};
      const attempts = this.testAttemptsForChapter(origIdx, test.id);
      if (!attempts.length) return '';
      const rows = attempts.map((attempt, idx) => {
        const score = Number(attempt.final_score);
        const passScore = Math.max(0, Math.min(100, Number(attempt.passing_score_percent ?? test.passing_score_percent ?? 80) || 80));
        const scoreText = Number.isFinite(score)
          ? `${Math.round(score)}% ${score >= passScore ? 'Pass' : 'Did not pass'}`
          : (attempt.grade_hidden ? 'Submitted' : (attempt.status === 'calculating' ? 'Calculating' : 'Not scored'));
        const when = attempt.completed_at || attempt.updated_at || attempt.started_at || '';
        const duration = this.formatAttemptDuration(attempt);
        const attemptId = String(attempt.id || '').replace(/'/g, "\\'");
        const hasRubric = attempt.project_scores && typeof attempt.project_scores === 'object' && Object.keys(attempt.project_scores).length > 0;
        return `
            <div style="border:1px solid #e6e8ec; border-radius:10px; padding:12px; background:#fff; margin-top:10px;">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <div style="font-weight:900;">Attempt ${attempts.length - idx}</div>
                <div style="font-weight:900; color:${Number.isFinite(score) ? this.scoreColor(score) : '#b06000'};">${Portal.escapeHtml(scoreText)}</div>
              </div>
              ${when ? `<div style="font-size:12px; color:#667085; margin-top:6px;">${Portal.escapeHtml(new Date(when).toLocaleString())}</div>` : ''}
              <div style="font-size:12px; color:#667085; margin-top:4px;">Duration: ${Portal.escapeHtml(duration)}</div>
              ${hasRubric ? `<button type="button" class="btn-secondary" style="font-size:11px; padding:6px 9px; margin-top:10px;" onclick="viewTutorialAttemptRubric('${attemptId}')">View Rubric</button>` : ''}
            </div>
          `;
      }).join('');
      return `
        <div style="margin-top:14px;">
          <div style="font-weight:900; color:#344054;">Past Attempts</div>
          ${rows}
        </div>
      `;
    },

    renderDraftRejectAttemptHistory(chap, origIdx, round=null){
      if (!this.chapterHasDraftReject(chap)) return '';
      round = round || (chap.draft_reject_rounds || [])[0] || {};
      const attempts = this.draftRejectAttemptsForChapter(origIdx, round.id);
      if (!attempts.length) return '';
      const rows = attempts.map((attempt, idx) => {
        const score = Number(attempt.final_score);
        const passScore = Math.max(0, Math.min(100, Number(attempt.passing_score_percent ?? round.passing_score_percent ?? 80) || 80));
        const scoreText = Number.isFinite(score)
          ? `${Math.round(score)}% ${score >= passScore ? 'Pass' : 'Did not pass'}`
          : (attempt.status === 'calculating' ? 'Calculating' : 'Submitted');
        const when = attempt.completed_at || attempt.updated_at || attempt.started_at || '';
        const duration = this.formatAttemptDuration(attempt);
        return `
            <div style="border:1px solid #e6e8ec; border-radius:10px; padding:12px; background:#fff; margin-top:10px;">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <div style="font-weight:900;">${Portal.escapeHtml(round.mode === 'test' ? 'Attempt' : 'Practice')} ${attempts.length - idx}</div>
                <div style="font-weight:900; color:${Number.isFinite(score) ? this.scoreColor(score) : '#b06000'};">${Portal.escapeHtml(scoreText)}</div>
              </div>
              ${when ? `<div style="font-size:12px; color:#667085; margin-top:6px;">${Portal.escapeHtml(new Date(when).toLocaleString())}</div>` : ''}
              <div style="font-size:12px; color:#667085; margin-top:4px;">Duration: ${Portal.escapeHtml(duration)}</div>
            </div>
          `;
      }).join('');
      return `
        <div style="margin-top:14px;">
          <div style="font-weight:900; color:#344054;">Past Draft/Reject Rounds</div>
          ${rows}
        </div>
      `;
    },

    showTestAttemptResultModal(attempt, chap, origIdx){
      if (!attempt || !chap) return;
      const test = (chap.tests || []).find(t => String(t.id) === String(attempt.test_id || 'test_1')) || (chap.tests || [])[0] || {};
      document.getElementById('tutorialTestResultModal')?.remove();
      const score = Number(attempt.final_score);
      const passScore = Math.max(0, Math.min(100, Number(attempt.passing_score_percent ?? test.passing_score_percent ?? 80) || 80));
      const hasScore = Number.isFinite(score);
      const passed = hasScore && score >= passScore;
      const startState = this.testStartState(chap, origIdx, test);
      const scoreLine = hasScore
        ? (passed ? `You passed with a score of ${Math.round(score)}%.` : `You did not pass. Your score was ${Math.round(score)}%.`)
        : (attempt.grade_hidden ? 'Your exam was submitted. Your score is available to administrators.' : 'Your score is still calculating.');
      const retakeLine = startState.canStart
        ? (startState.buttonText === 'Start Retake' ? 'You can retake this test now.' : '')
        : startState.detailText;
      const when = attempt.completed_at || attempt.updated_at || attempt.started_at || '';
      const duration = this.formatAttemptDuration(attempt);
      const hasRubric = attempt.project_scores && typeof attempt.project_scores === 'object' && Object.keys(attempt.project_scores).length > 0;
      const modal = document.createElement('div');
      modal.id = 'tutorialTestResultModal';
      modal.style.cssText = 'position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; background:rgba(16,24,40,.64); padding:24px;';
      modal.innerHTML = `
        <div role="dialog" aria-modal="true" style="width:min(460px, 100%); background:#fff; border-radius:12px; box-shadow:0 24px 70px rgba(0,0,0,.32); overflow:hidden;">
          <div style="padding:22px 24px 10px;">
            <div style="font-size:20px; font-weight:900; color:#202124;">Test Result</div>
            <div style="margin-top:8px; font-size:13px; font-weight:800; color:${hasScore ? this.scoreColor(score) : '#b06000'};">${Portal.escapeHtml(scoreLine)}</div>
            ${attempt.grade_hidden ? '' : `<div style="margin-top:8px; font-size:12px; color:#667085;">Passing score: ${Portal.escapeHtml(Math.round(passScore))}%</div>`}
            ${when ? `<div style="margin-top:6px; font-size:12px; color:#667085;">Submitted: ${Portal.escapeHtml(new Date(when).toLocaleString())}</div>` : ''}
            <div style="margin-top:6px; font-size:12px; color:#667085;">Duration: ${Portal.escapeHtml(duration)}</div>
            ${retakeLine ? `<div style="margin-top:10px; font-size:13px; font-weight:800; color:#344054;">${Portal.escapeHtml(retakeLine)}</div>` : ''}
          </div>
          <div style="display:flex; justify-content:flex-end; gap:10px; padding:16px 24px 22px; border-top:1px solid #edf0f5;">
            ${hasRubric ? `<button type="button" id="tutorialTestResultRubric" class="btn-secondary">View Rubric</button>` : ''}
            <button type="button" id="tutorialTestResultClose" class="btn-secondary">Close</button>
            ${startState.canStart && startState.buttonText === 'Start Retake' ? `<button type="button" id="tutorialTestResultRetake" class="btn-primary">Retake</button>` : ''}
          </div>
        </div>
      `;
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) modal.remove();
      });
      document.body.appendChild(modal);
      modal.querySelector('#tutorialTestResultClose')?.addEventListener('click', () => modal.remove());
      modal.querySelector('#tutorialTestResultRubric')?.addEventListener('click', () => this.showAttemptRubricModal(attempt));
      modal.querySelector('#tutorialTestResultRetake')?.addEventListener('click', () => this.startTutorialTestAttempt(origIdx + 1, test.id));
    },

    // ---- Fetch curriculum/progress ----
    async fetchTutorials(){
      const data = await Portal.apiPost(cfg().endpoints.server, tutorialApiPayload({ action:'fetch_curriculum' })).catch(()=>({}));
      this.curriculum = data.curriculum || { chapters: [] };
      this.progress = data.progress || { completed_videos:[], completed_projects:[], current_chapter:1 };

      this.normalizeCurriculumAndProgress();
      await this.ensureProgressNotStuck();
      this.rebuildViewChapters();
      this.syncCourseControls();
      this.renderChapters();

      const params = new URLSearchParams(window.location.search || '');
      const attemptId = String(params.get('test_attempt') || '').trim();
      if (attemptId) {
        const attempt = this.progress?.test_attempts?.[attemptId] || null;
        if (attempt && attempt.chapter_id) {
          const viewIdx = this.viewChapters.findIndex(e => (e.origIdx + 1) === Number(attempt.chapter_id));
          if (viewIdx >= 0) {
            await this.openChapter(viewIdx);
            const entry = this.viewChapters[viewIdx];
            setTimeout(() => this.showTestAttemptResultModal(attempt, entry?.chap, entry?.origIdx), 0);
          }
        }
      }
    },

    // ---- Chapter grid ----
    renderChapters(){
      const grid = document.getElementById('chapterGrid');
      if (!grid) return;

      grid.innerHTML = '';
      this.showChapterGrid();

      if (!this.viewChapters || this.viewChapters.length === 0) {
        grid.innerHTML = `
          <div style="grid-column:1/-1; background:#fff; border:1px solid var(--border); border-radius:12px; padding:24px; color:#666;">
            <b>No chapters available</b>
            <div style="margin-top:6px; color:#888; font-size:12px;">(Nothing is visible for your user.)</div>
          </div>
        `;
        return;
      }

      this.viewChapters.forEach((entry, viewIdx) => {
        const chap = entry.chap;
        const origIdx = entry.origIdx;

        const displayNum = viewIdx + 1; // skips hidden/invisible chapters
        const origNum = origIdx + 1;    // gating vs progress.current_chapter

        const adminUnlocked = this.canManageTutorials() && origNum > this.progress.current_chapter;
        const locked = !this.canManageTutorials() && origNum > this.progress.current_chapter;

        const icon = locked ? '<i class="fas fa-lock"></i>' : '<i class="fas fa-book-open"></i>';
        let status = locked ? 'Locked' : (adminUnlocked ? 'Unlocked for Admin' : (origNum < this.progress.current_chapter ? 'Completed' : 'In Progress'));
        let statusColor = locked ? '#999' : (adminUnlocked ? '#7c3aed' : (origNum < this.progress.current_chapter ? '#34a853' : '#1a73e8'));
        if (!locked && this.chapterHasTest(chap)) {
          const attempt = this.testAttemptForChapter(origIdx);
          if (attempt && attempt.status === 'calculating') {
            status = 'Score Calculating';
            statusColor = '#b06000';
          } else if (attempt && attempt.grade_hidden) {
            status = 'Exam Submitted';
            statusColor = '#1a73e8';
          } else if (attempt && Number.isFinite(Number(attempt.final_score))) {
            const finalScore = Number(attempt.final_score);
            status = `Score: ${Math.round(finalScore)}%`;
            statusColor = this.scoreColor(finalScore);
          } else if (attempt && attempt.status === 'in_progress') {
            status = 'Test In Progress';
          }
        }

        const desc = (chap.description || '').trim();
        const isHiddenBadge = chap.hidden ? `<span class="user-pill" style="background:#f1f3f4; color:#5f6368; margin-left:8px;">Hidden</span>` : '';

        const div = document.createElement('div');
        div.className = 'tile';
        div.style.opacity = locked ? '0.6' : '1';
        div.style.pointerEvents = locked ? 'none' : 'auto';

        div.innerHTML = `
          <div class="tile-thumb" style="display:flex; align-items:center; justify-content:center; background:#f8f9fa; color:#ccc; font-size:40px;">
            ${icon}
          </div>
          <div class="tile-content">
            <div class="tile-addr">
              Chapter ${displayNum}: ${Portal.escapeHtml(chap.title || '')}
              ${isHiddenBadge}
            </div>
            <div class="tile-meta">
              ${desc ? `<div class="chap-desc">${Portal.escapeHtml(desc)}</div>` : `<div class="chap-desc" style="color:#aaa; font-style:italic;">No description</div>`}
              <span style="color:${statusColor}; font-weight:bold;">${status}</span>
            </div>
          </div>
        `;

        if (!locked) div.onclick = () => this.openChapter(viewIdx);
        grid.appendChild(div);
      });
    },

    // ---- Chapter detail ----
    async openChapter(viewIdx){
      this.currentChapViewIdx = viewIdx;

      const entry = (this.viewChapters || [])[viewIdx];
      if (!entry) return;

      this.currentChapOrigIdx = entry.origIdx;
      const chap = this.curriculum.chapters[this.currentChapOrigIdx];

      const gridEl = document.getElementById('chapterGrid');
      if (gridEl) gridEl.style.display = 'none';

      const detail = document.getElementById('chapterDetail');
      if (detail) detail.style.display = 'block';

      const chapTitle = document.getElementById('chapTitle');
      if (chapTitle) chapTitle.innerText = `Chapter ${viewIdx+1}: ${chap.title}`;

      const descCard = document.getElementById('chapDescCard');
      const d = (chap.description || '').trim();
      if (descCard) {
        if (d) { descCard.style.display = 'block'; descCard.textContent = d; }
        else { descCard.style.display = 'none'; descCard.textContent = ''; }
      }

      this.applyColumnToggles(chap);

      // VIDEOS
      const resList = document.getElementById('resList');
      if (resList) {
        resList.innerHTML = '';
        if (chap.show_videos !== false) {
          const vids = chap.videos || [];
          if (vids.length === 0) {
            resList.innerHTML = '<div style="color:#999; font-style:italic;">No videos.</div>';
          } else {
            vids.forEach(vid => {
              if (!vid || !vid.url) return;

              const a = document.createElement('a');
              a.href = vid.url;
              a.target = '_blank';
              a.className = 'res-item';
              a.setAttribute('data-video-url', vid.url);

              const done = this.isVideoOpened(vid.url);

              a.innerHTML = `
                <div class="res-icon"><i class="fas fa-play-circle"></i></div>
                <div style="flex:1;">
                  <strong>${Portal.escapeHtml(vid.title || vid.url)}</strong><br>
                  <span style="font-size:11px; color:#777;">Video Guide</span>
                </div>
                <i class="fas fa-check-circle check-icon" style="${done ? '' : 'display:none;'}"></i>
              `;

              a.addEventListener('click', () => this.markVideo(vid.url));
              resList.appendChild(a);
            });
          }
        }
      }

      // GUIDES
      const guideList = document.getElementById('guideList');
      if (guideList) {
        guideList.innerHTML = '';
        if (chap.show_pdfs !== false) {
          const pdfs = chap.pdfs || [];
          if (pdfs.length === 0) {
            guideList.innerHTML = '<div style="color:#999; font-style:italic;">No guides.</div>';
          } else {
            pdfs.forEach(pdf => {
              if (!pdf || !pdf.url) return;

              const a = document.createElement('a');
              a.href = pdf.url;
              a.target = '_blank';
              a.className = 'res-item';

              a.innerHTML = `
                <div class="res-icon"><i class="fas fa-file-pdf"></i></div>
                <div style="flex:1;">
                  <strong>${Portal.escapeHtml(pdf.title || pdf.url)}</strong><br>
                  <span style="font-size:11px; color:#777;">Reference Guide</span>
                </div>
              `;

              guideList.appendChild(a);
            });
          }
        }
      }

      // PROJECTS
      const projList = document.getElementById('projList');
      if (projList) {
        projList.innerHTML = '';
        const items = tutorialProjectsEnabled() ? (chap.projects || []) : [];
        const hasTest = this.chapterHasTest(chap);

        if (!tutorialProjectsEnabled()) {
          projList.innerHTML = '<div style="color:#999; font-style:italic;">This course does not use hands-on projects.</div>';
        } else {
          if (items.length === 0) {
            projList.innerHTML = '<div style="color:#999; font-style:italic;">No practice projects.</div>';
          } else {
            items.forEach(p => {
              if (!p) return;

              const sourceProjectId = p.project_id || p.source_project_id || p.id;
              const gradingEnabled = p.grading_enabled !== false;
              const itemId = p.curriculum_project_id || p.practice_project_id || '';
              const existingInstance = (this.myTutorialProjectList || []).find(proj => {
                const projectItemId = proj.curriculum_project_id || proj.practice_project_id || '';
                const projectSourceId = proj.source_project_id || proj.original_master_id || '';
                if (itemId) return String(projectItemId) === String(itemId);
                return !projectItemId && String(projectSourceId) === String(sourceProjectId);
              });

              let btnText = 'Start Project';
              let statusText = 'Click to Open Workspace';
              let btnClass = 'btn-secondary';
              let statusStyle = '#777';
              let clickHandler = () => this.startTutorialProject(sourceProjectId, p);

              if (existingInstance) {
                btnText = 'Resume Work';
                statusText = 'Saved Progress Available';
                btnClass = 'btn-primary';
                statusStyle = '#34a853';
                clickHandler = () => { window.location.href = `editor.php?tutorial=1&folder=${encodeURIComponent(existingInstance.id)}&course_id=${encodeURIComponent(tutorialCourseId())}`; };
              }

              const wrap = document.createElement('div');
              wrap.className = 'tile';
              wrap.style.display = 'flex';
              wrap.style.flexDirection = 'row';
              wrap.style.alignItems = 'center';

              wrap.innerHTML = `
                <div style="width:100px; height:100px; background:#eee; position:relative;">
                  <img src="${fmUrl(`projects/${encodeURIComponent(sourceProjectId)}/thumbnail?w=180`)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'">
                </div>
                <div class="tile-content" style="padding:15px;">
                  <div class="tile-addr">${Portal.escapeHtml(p.name || '')}${gradingEnabled ? '' : ' <span class="user-pill" style="background:#eef2f6; color:#475467; margin-left:6px;">Practice only · no score</span>'}</div>
                  <div class="tile-meta" style="color:${statusStyle}; font-weight:bold;">${Portal.escapeHtml(statusText)}</div>
                  <button class="${btnClass}" style="font-size:11px; padding:4px 8px; margin-top:5px;">${Portal.escapeHtml(btnText)}</button>
                </div>
              `;

              const btn = wrap.querySelector('button');
              if (btn) {
                btn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  clickHandler();
                });
              }

              wrap.addEventListener('click', () => clickHandler());
              projList.appendChild(wrap);
            });
          }

          if (hasTest) {
            (chap.tests || []).forEach((test) => {
              const testState = this.testStartState(chap, this.currentChapOrigIdx, test);
              const requiredBadge = test.required ? '<span class="user-pill" style="background:#fff4e5; color:#9a5b00; margin-left:8px;">Required</span>' : '';
              projList.insertAdjacentHTML('beforeend', `
            <div class="tile" style="display:flex; flex-direction:row; align-items:center;">
              <div style="width:100px; height:100px; background:#e8f0fe; color:#1a73e8; display:flex; align-items:center; justify-content:center; font-size:34px;">
                <i class="fas fa-clipboard-check"></i>
              </div>
              <div class="tile-content" style="padding:15px;">
                <div class="tile-addr">${Portal.escapeHtml(test.title || 'Test')}${requiredBadge}</div>
                <div class="tile-meta" style="color:#1a73e8; font-weight:bold;">${Portal.escapeHtml(testState.statusText)}</div>
                <div class="tile-meta">${Portal.escapeHtml(testState.detailText)}</div>
                <button class="${testState.canStart ? 'btn-primary' : 'btn-secondary'}" ${testState.canStart ? '' : 'disabled'} style="font-size:11px; padding:4px 8px; margin-top:5px;" onclick="startTutorialTestAttempt(${this.currentChapOrigIdx + 1}, '${String(test.id || '').replace(/'/g, "\\'")}')">${Portal.escapeHtml(testState.buttonText)}</button>
              </div>
            </div>
          `);
              projList.insertAdjacentHTML('beforeend', this.renderTestAttemptHistory(chap, this.currentChapOrigIdx, test));
            });
          }

          if (this.chapterHasDraftReject(chap)) {
            (chap.draft_reject_rounds || []).forEach((round) => {
              const roundState = this.draftRejectStartState(chap, this.currentChapOrigIdx, round);
              const requiredBadge = round.required && round.mode === 'test' ? '<span class="user-pill" style="background:#fff4e5; color:#9a5b00; margin-left:8px;">Required</span>' : '';
              const modeBadge = round.mode === 'test' ? 'Test' : 'Practice';
              projList.insertAdjacentHTML('beforeend', `
            <div class="tile" style="display:flex; flex-direction:row; align-items:center;">
              <div style="width:100px; height:100px; background:#e6f4ea; color:#137333; display:flex; align-items:center; justify-content:center; font-size:34px;">
                <i class="fas fa-bolt"></i>
              </div>
              <div class="tile-content" style="padding:15px;">
                <div class="tile-addr">${Portal.escapeHtml(round.title || 'Draft or Reject')}${requiredBadge}</div>
                <div class="tile-meta" style="color:#137333; font-weight:bold;">${Portal.escapeHtml(modeBadge)} - ${Portal.escapeHtml(roundState.statusText)}</div>
                <div class="tile-meta">${Portal.escapeHtml(roundState.detailText)}</div>
                <button class="${roundState.canStart ? 'btn-primary' : 'btn-secondary'}" ${roundState.canStart ? '' : 'disabled'} style="font-size:11px; padding:4px 8px; margin-top:5px;" onclick="startTutorialDraftRejectRound(${this.currentChapOrigIdx + 1}, '${String(round.id || '').replace(/'/g, "\\'")}')">${Portal.escapeHtml(roundState.buttonText)}</button>
              </div>
            </div>
          `);
              projList.insertAdjacentHTML('beforeend', this.renderDraftRejectAttemptHistory(chap, this.currentChapOrigIdx, round));
            });
          }
        }
      }

      const btnNext = document.getElementById('btnNextChapter');
      if (btnNext) {
        if (this.currentChapOrigIdx === this.curriculum.chapters.length - 1) btnNext.innerHTML = 'Finish Course <i class="fas fa-flag-checkered"></i>';
        else btnNext.innerHTML = 'Next Chapter <i class="fas fa-arrow-right"></i>';
      }

      this.renderChapterProgressPill(chap);
    },

    applyColumnToggles(chap){
      const layout = document.querySelector('#chapterDetail .col-3-layout');
      if (!layout || !layout.children || layout.children.length < 3) return;

      const colVideos = layout.children[0];
      const colPdfs   = layout.children[1];
      const colProjs  = layout.children[2];

      const showVideos = (chap.show_videos !== false);
      const showPdfs   = (chap.show_pdfs !== false);

      if (colVideos) colVideos.style.display = showVideos ? 'flex' : 'none';
      if (colPdfs)   colPdfs.style.display   = showPdfs   ? 'flex' : 'none';
      if (colProjs)  colProjs.style.display  = tutorialProjectsEnabled() ? 'flex' : 'none';
    },

    showChapterGrid(){
      const g = document.getElementById('chapterGrid');
      const d = document.getElementById('chapterDetail');
      if (g) g.style.display = 'grid';
      if (d) d.style.display = 'none';
    },

    // ---- Progress updates ----
    markVideo(url){
      if (!url) return;

      if (!this.isVideoOpened(url)) this.progress.completed_videos.push({ url, date: new Date().toISOString() });

      document.querySelectorAll('#resList [data-video-url]').forEach(a => {
        const u = a.getAttribute('data-video-url');
        const done = this.isVideoOpened(u);
        const icon = a.querySelector('.check-icon');
        if (icon) icon.style.display = done ? '' : 'none';
      });

      const chap = this.curriculum.chapters[this.currentChapOrigIdx];
      this.renderChapterProgressPill(chap);

      Portal.apiPost(cfg().endpoints.server, {
        action:'update_progress',
        type:'video',
        id:url,
        course_id:tutorialCourseId()
      }).catch(()=>{});
    },

    async completeChapter(){
      if (this.canManageTutorials()) {
        const nextViewIdx = this.currentChapViewIdx + 1;
        if (nextViewIdx < this.viewChapters.length) await this.openChapter(nextViewIdx);
        else this.showChapterGrid();
        return;
      }
      const chap = this.curriculum.chapters[this.currentChapOrigIdx];
      const rep = this.chapterGateReport(chap);

      if (rep.missing.length > 0) {
        alert(`You need to complete ${rep.missing.join(', ')} first.`);
        return;
      }

      const completedOrigNum = this.currentChapOrigIdx + 1;

      const saved = await Portal.apiPost(cfg().endpoints.server, {
        action:'update_progress',
        type:'chapter_complete',
        id: completedOrigNum,
        course_id:tutorialCourseId()
      }).catch(()=>{});
      if (saved && saved.success === false) {
        alert(saved.error || 'This chapter cannot be completed yet.');
        return;
      }

      this.progress.current_chapter = Math.max(this.progress.current_chapter, completedOrigNum + 1);
      await this.ensureProgressNotStuck();

      this.rebuildViewChapters();
      this.renderChapters();

      const nextEntry = this.viewChapters.find(e => (e.origIdx + 1) >= this.progress.current_chapter) || null;
      if (nextEntry) {
        const nextViewIdx = this.viewChapters.indexOf(nextEntry);
        if (nextViewIdx >= 0) await this.openChapter(nextViewIdx);
      } else {
        this.showChapterGrid();
      }
    },

    async startTutorialProject(sourceProjectId, projectEntry=null){
      if (!tutorialProjectsEnabled()) {
        alert("This course does not use tutorial projects.");
        return;
      }
      const curriculumProjectId = String(projectEntry?.curriculum_project_id || projectEntry?.practice_project_id || '').trim();
      const data = await Portal.apiPost(cfg().endpoints.server, {
        action:'start_tutorial_project',
        project_id: sourceProjectId,
        master_id: sourceProjectId,
        chapter_id: this.currentChapOrigIdx + 1,
        curriculum_project_id: curriculumProjectId,
        practice_project_name: projectEntry?.name || '',
        course_id: tutorialCourseId()
      }).catch(()=>({}));

      if (data.success) {
        if (data.editor_url) {
          window.location.href = data.editor_url;
        } else if (/^tutorial_[a-f0-9]{16,64}$/i.test(String(data.folder || ''))) {
          window.location.href = `editor.php?tutorial=1&folder=${encodeURIComponent(data.folder)}&course_id=${encodeURIComponent(tutorialCourseId())}`;
        } else {
          localStorage.setItem('autoLoadProject', data.folder);
          window.location.href = 'editor.php';
        }
      } else {
        alert("Error creating project instance: " + (data.error || 'Unknown'));
      }
    },

    async startTutorialTestAttempt(chapterId, testId=null){
      if (!tutorialProjectsEnabled()) {
        alert("This course does not use tutorial projects.");
        return;
      }
      let resumeAttempt = false;
      const chap = this.curriculum.chapters[(Number(chapterId) || 1) - 1];
      if (chap) {
        const test = (chap.tests || []).find(t => String(t.id) === String(testId || '')) || (chap.tests || [])[0] || null;
        const state = this.testStartState(chap, (Number(chapterId) || 1) - 1, test);
        if (!state.canStart) return;
        resumeAttempt = state.buttonText === 'Resume Test';
      }
      const data = await Portal.apiPost(cfg().endpoints.server, {
        action:'start_tutorial_test_attempt',
        chapter_id: chapterId,
        test_id: testId || '',
        resume_attempt: resumeAttempt,
        course_id: tutorialCourseId()
      }).catch(()=>({}));

      if (data.success && data.editor_url) {
        window.location.href = data.editor_url;
      } else if (data.success && data.folder) {
        window.location.href = `editor.php?tutorial=1&folder=${encodeURIComponent(data.folder)}&course_id=${encodeURIComponent(tutorialCourseId())}`;
      } else {
        alert("Error starting test: " + (data.error || 'Unknown'));
      }
    },

    async startTutorialDraftRejectRound(chapterId, roundId=null){
      if (!tutorialProjectsEnabled()) {
        alert("This course does not use tutorial projects.");
        return;
      }
      const chap = this.curriculum.chapters[(Number(chapterId) || 1) - 1];
      if (chap) {
        const round = (chap.draft_reject_rounds || []).find(r => String(r.id) === String(roundId || '')) || (chap.draft_reject_rounds || [])[0] || null;
        const state = this.draftRejectStartState(chap, (Number(chapterId) || 1) - 1, round);
        if (!state.canStart) return;
      }
      const data = await Portal.apiPost(cfg().endpoints.server, {
        action:'start_tutorial_draft_reject_round',
        chapter_id: chapterId,
        round_id: roundId || '',
        course_id: tutorialCourseId()
      }).catch(()=>({}));

      if (data.success && data.editor_url) {
        window.location.href = data.editor_url;
      } else if (data.success && data.folder) {
        window.location.href = `editor.php?tutorial=1&folder=${encodeURIComponent(data.folder)}&course_id=${encodeURIComponent(tutorialCourseId())}`;
      } else {
        alert("Error starting draft/reject round: " + (data.error || 'Unknown'));
      }
    },

    // ----------------------
    // Student progress
    // ----------------------
    async fetchStudentList(){
      const tbody = document.getElementById('studentTable');
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px;">Loading...</td></tr>';
      if (!tbody) return;
      let data = {};
      try {
        data = await Portal.apiPost(cfg().endpoints.portal, tutorialApiPayload({ action:'fetch_student_list' }));
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#a50e0e; padding:24px;">Could not load student progress: ${Portal.escapeHtml(err?.message || 'Unknown error')}</td></tr>`;
        const summary = document.getElementById('studentProgressSummary');
        if (summary) summary.textContent = '';
        return;
      }
      if (!data.success) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#a50e0e; padding:24px;">Could not load student progress: ${Portal.escapeHtml(data.error || 'Unknown error')}</td></tr>`;
        const summary = document.getElementById('studentProgressSummary');
        if (summary) summary.textContent = '';
        return;
      }
      tbody.innerHTML = '';
      const summary = document.getElementById('studentProgressSummary');
      const showUnstarted = !!document.getElementById('tutorialShowUnstartedStudents')?.checked;
      
      // Only employees:
      // - Prefer explicit account_type === 'employee' if present
      // - Fallback: treat admins/leads/users as employees unless explicitly 'customer'
      const isEmployee = (u) => {
        const acct = String(u?.account_type || '').trim().toLowerCase();
        if (acct) return acct === 'employee';
        const role = String(u?.role || '').trim().toLowerCase();
        if (role === 'customer') return false;
        return true; // back-compat default
      };
      
      const allStudents = (data.students || []).filter(isEmployee);
      const activeStudents = allStudents.filter(s => !!s.has_activity);
      const students = showUnstarted ? allStudents : activeStudents;
      const hiddenCount = Math.max(0, allStudents.length - activeStudents.length);
      if (summary) {
        summary.textContent = showUnstarted
          ? `Showing ${students.length} employee${students.length === 1 ? '' : 's'} including ${hiddenCount} who have not started.`
          : `Showing ${students.length} employee${students.length === 1 ? '' : 's'} with tutorial activity. ${hiddenCount} not-started user${hiddenCount === 1 ? '' : 's'} hidden.`;
      }
      
      if (students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">${showUnstarted ? 'No students found.' : 'No students with tutorial activity yet.'}</td></tr>`;
        return;
      }
      students.forEach(s => {
        const counts = s.activity_counts || {};
        const projectCount = Number(counts.tutorial_projects || 0);
        const testCount = Number(counts.test_attempts || 0);
        const videoCount = Number(counts.completed_videos || 0);
        const activityBits = [];
        if (projectCount) activityBits.push(`${projectCount} project${projectCount === 1 ? '' : 's'}`);
        if (testCount) activityBits.push(`${testCount} attempt${testCount === 1 ? '' : 's'}`);
        if (videoCount) activityBits.push(`${videoCount} video${videoCount === 1 ? '' : 's'}`);
        const normalizedStatus = String(s.activity_label || '').trim().toLowerCase();
        if (s.training_complete && normalizedStatus !== 'training complete') activityBits.push('training complete');
        if (!s.has_activity && s.seen_tutorial) activityBits.push('opened tutorial');
        const chapterLabel = s.activity_label
          ? Portal.escapeHtml(s.activity_label)
          : s.has_activity
          ? `Chapter ${Portal.escapeHtml(s.current_chapter || 1)}`
          : 'Not started';
        const activityLabel = activityBits.length ? `<div style="font-size:11px; color:#667085; margin-top:2px;">${Portal.escapeHtml(activityBits.join(' · '))}</div>` : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${Portal.escapeHtml(s.name||'')}</b></td>
          <td>${Portal.escapeHtml(s.email||'')}</td>
          <td>${chapterLabel}${activityLabel}</td>
          <td style="text-align:right">
            <button class="btn-secondary btn-sm" onclick="openStudentDetails('${String(s.email).replace(/'/g,"\\'")}', '${String(s.name).replace(/'/g,"\\'")}')">View Progress</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    },


    async openStudentDetails(email, name){
      const title = document.getElementById('stModalTitle');
      if (title) title.innerText = `Details for ${name}`;

      const data = await Portal.apiPost(cfg().endpoints.portal, {
        action:'fetch_student_details',
        email,
        course_id: tutorialCourseId()
      }).catch(()=>({}));

      if (!data.success) return alert("Could not fetch details");

      const chapEl = document.getElementById('stCurrentChap');
      if (chapEl) chapEl.innerText = `Chapter ${data.progress.current_chapter}`;

      const vidList = document.getElementById('stVideoList');
      if (vidList) {
        vidList.innerHTML = '';
        const vids = data.progress.completed_videos || [];
        if (vids.length === 0) {
          vidList.innerHTML = '<div style="color:#999; font-style:italic;">No videos watched yet.</div>';
        } else {
          vids.forEach(item => {
            let url = '', dateDisplay = '';
            if (typeof item === 'string') url = item;
            else {
              url = item.url;
              if (item.date) dateDisplay = `<span style="font-size:10px; color:#888; display:block; margin-top:2px;">Watched: ${new Date(item.date).toLocaleString()}</span>`;
            }

            const row = document.createElement('div');
            row.className = 'res-item';
            row.innerHTML = `
              <div class="res-icon"><i class="fas fa-play-circle"></i></div>
              <div style="flex:1; overflow:hidden; text-overflow:ellipsis; font-size:12px;">
                ${Portal.escapeHtml(url)}
                ${dateDisplay}
              </div>
              <i class="fas fa-check-circle check-icon"></i>
            `;
            vidList.appendChild(row);
          });
        }
      }

      const projGrid = document.getElementById('stProjectGrid');
      if (projGrid) {
        projGrid.innerHTML = '';
        const projs = tutorialProjectsEnabled() ? (data.projects || []) : [];
        if (!tutorialProjectsEnabled()) {
          projGrid.innerHTML = '<div style="grid-column:1/-1; color:#999; font-style:italic; padding:20px;">This course does not include project work.</div>';
        } else if (projs.length === 0) {
          projGrid.innerHTML = '<div style="grid-column:1/-1; color:#999; font-style:italic; padding:20px;">No projects started.</div>';
        } else {
          projs.forEach(p => {
            let statusColor = '#fbbc04';
            if (p.status === 'completed' || p.status === 'tutorial_completed') statusColor = '#34a853';
            const openUrl = `editor.php?tutorial=1&folder=${encodeURIComponent(p.id)}&course_id=${encodeURIComponent(tutorialCourseId())}`;
            const rawScore = p.score;
            const score = Number(rawScore);
            const hasScore = rawScore !== null && rawScore !== undefined && rawScore !== '' && Number.isFinite(score);
            const scoreLabel = hasScore ? `${Math.round(score)}%` : (p.score_status === 'calculating' ? 'Calculating' : 'No grade');
            const kindLabel = String(p.tutorial_kind || 'practice').replace(/_/g, ' ');
            const sequenceLabel = p.sequence_total ? `Project ${p.sequence_index || '?'} of ${p.sequence_total}` : '';
            const auditEmail = Portal.escapeHtml(email);
            const auditId = Portal.escapeHtml(p.id);
            const auditUrl = `tutorial_audit.php?email=${encodeURIComponent(email)}&tutorial_id=${encodeURIComponent(p.id)}&course_id=${encodeURIComponent(p.tutorial_course_id || tutorialCourseId())}`;

            const div = document.createElement('div');
            div.className = 'tile';
            div.innerHTML = `
              <div class="tile-thumb" style="height:120px;">
                <img src="${p.thumbnail}" onerror="this.style.display='none'">
                <div class="badge" style="background:${statusColor}">${Portal.escapeHtml(p.status||'')}</div>
              </div>
              <div class="tile-content" style="padding:10px;">
                <div class="tile-addr" style="font-size:12px;">${Portal.escapeHtml(p.address || p.source_address || p.source_project_id || '')}</div>
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:8px;">
                  <span style="font-size:11px; font-weight:900; color:${this.scoreColor(score)}; background:#f8fafc; border:1px solid #e6e8ef; border-radius:999px; padding:3px 7px;">${Portal.escapeHtml(scoreLabel)}</span>
                  <span style="font-size:10px; font-weight:800; color:#667085; background:#f8fafc; border:1px solid #e6e8ef; border-radius:999px; padding:3px 7px; text-transform:capitalize;">${Portal.escapeHtml(kindLabel)}</span>
                  ${sequenceLabel ? `<span style="font-size:10px; font-weight:800; color:#667085;">${Portal.escapeHtml(sequenceLabel)}</span>` : ''}
                </div>
                <div style="display:flex; gap:5px; margin-top:10px;">
                  <button class="btn-primary" style="font-size:10px; flex:1;" onclick="window.location.href='${openUrl}'">Open</button>
                  <a class="btn-secondary" style="font-size:10px; flex:1; text-align:center; text-decoration:none;" data-tutorial-audit-email="${auditEmail}" data-tutorial-audit-id="${auditId}" href="${Portal.escapeHtml(auditUrl)}" target="_blank" rel="noopener">Audit</a>
                  <button class="btn-secondary" style="font-size:10px;" onclick="openProjectModal('${p.id}')"><i class="fas fa-info-circle"></i></button>
                </div>
              </div>
            `;
            projGrid.appendChild(div);
          });
        }
      }

      Portal.openModal('studentModal');
    },

    // ----------------------
    // Curriculum editor
    // ----------------------
    async loadStudentRoster(force=false){
      if (this._rosterLoaded && !force) return;

      const data = await Portal.apiPost(cfg().endpoints.portal, tutorialApiPayload({ action:'fetch_student_list' })).catch(()=>({}));

      // Only employees:
      // - Prefer explicit account_type === 'employee' if present
      // - Fallback: treat admins/leads/users as employees unless explicitly 'customer'
      const isEmployee = (u) => {
        const acct = String(u?.account_type || '').trim().toLowerCase();
        if (acct) return acct === 'employee';
        const role = String(u?.role || '').trim().toLowerCase();
        if (role === 'customer') return false;
        return true; // back-compat default
      };

      const list = (data.students || [])
        .filter(isEmployee)
        .map(s => ({
          email: normEmail(s.email),
          name: String(s.name || '').trim() || normEmail(s.email)
        }))
        .filter(x => !!x.email);

      list.sort((a,b) => (a.name.localeCompare(b.name) || a.email.localeCompare(b.email)));

      this.studentRoster = list;
      this._rosterLoaded = true;
    },


    openEditor(){
      this.currentEditorPage = 0;
      this.syncCourseControls();
      const title = document.getElementById('editorCourseTitle');
      if (title) title.textContent = `Curriculum Editor: ${tutorialCourseLabel()}`;
      Portal.openModal('editorModal');
      this.renderEditor();
    },

    draftKey(chapIdx, type){
      return `${chapIdx}:${type}`;
    },

    readResourceDraft(type){
      const titleId = type === 'videos' ? 'newVidTitle' : 'newPdfTitle';
      const urlId   = type === 'videos' ? 'newVidUrl'   : 'newPdfUrl';
      return {
        title: String(document.getElementById(titleId)?.value || ''),
        url: String(document.getElementById(urlId)?.value || '')
      };
    },

    stashResourceDrafts(){
      if (typeof this.currentEditorPage !== 'number' || this.currentEditorPage < 0) return;
      this.resourceDrafts[this.draftKey(this.currentEditorPage, 'videos')] = this.readResourceDraft('videos');
      this.resourceDrafts[this.draftKey(this.currentEditorPage, 'pdfs')] = this.readResourceDraft('pdfs');
    },

    restoreResourceDrafts(chapIdx){
      ['videos', 'pdfs'].forEach(type => {
        const draft = this.resourceDrafts[this.draftKey(chapIdx, type)] || { title:'', url:'' };
        const titleId = type === 'videos' ? 'newVidTitle' : 'newPdfTitle';
        const urlId   = type === 'videos' ? 'newVidUrl'   : 'newPdfUrl';
        const titleEl = document.getElementById(titleId);
        const urlEl = document.getElementById(urlId);
        if (titleEl) titleEl.value = draft.title || '';
        if (urlEl) urlEl.value = draft.url || '';
      });
    },

    flushPendingResourceDrafts(chapIdx){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      ['videos', 'pdfs'].forEach(type => {
        const draft = this.resourceDrafts[this.draftKey(chapIdx, type)] || { title:'', url:'' };
        const title = String(draft.title || '').trim();
        const url = String(draft.url || '').trim();
        if (!title || !url) return;
        if (!Array.isArray(chap[type])) chap[type] = [];
        chap[type].push({ title, url });
        this.resourceDrafts[this.draftKey(chapIdx, type)] = { title:'', url:'' };
      });
    },

    async uploadPdfFile(){
      try {
        await this.uploadPdfDraft();
      } catch (err) {
        alert(err.message || "Could not upload file.");
      }
    },

    async uploadPdfDraft(){
      const input = document.getElementById('newPdfFile');
      const titleEl = document.getElementById('newPdfTitle');
      const urlEl = document.getElementById('newPdfUrl');
      const btn = document.getElementById('btnUploadPdf');
      const file = input?.files?.[0];

      if (!file) throw new Error("Choose a file first.");

      const fd = new FormData();
      fd.append('action', 'upload_tutorial_file');
      fd.append('course_id', tutorialCourseId());
      fd.append('file', file);

      const originalLabel = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading';
      }

      try {
        const res = await fetch(cfg().endpoints.server, { method:'POST', body: fd });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');

        if (urlEl) urlEl.value = data.url || '';
        if (titleEl && !String(titleEl.value || '').trim()) {
          titleEl.value = data.title || String(file.name || '').replace(/\.pdf$/i, '');
        }

        this.resourceDrafts[this.draftKey(this.currentEditorPage, 'pdfs')] = {
          title: String(titleEl?.value || ''),
          url: String(urlEl?.value || '')
        };
        return this.resourceDrafts[this.draftKey(this.currentEditorPage, 'pdfs')];
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalLabel;
        }
        if (input) input.value = '';
      }
    },

    renderEditor(){
      this.ensureEditorCss();
      if (this._skipDraftStashOnce) this._skipDraftStashOnce = false;
      else this.stashResourceDrafts();

      const container = document.getElementById('editorContent');
      const pagination = document.getElementById('paginationCtr');
      if (!container || !pagination) return;

      container.innerHTML = '';
      pagination.innerHTML = '';

      if (this.curriculum.chapters.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px; color:#999;">No chapters yet. Click "New Chapter".</div>';
        return;
      }

      const total = this.curriculum.chapters.length;
      if (this.currentEditorPage >= total) this.currentEditorPage = total - 1;

      let pHtml = `<div class="page-btn" onclick="if(Tutorials.currentEditorPage>0){Tutorials.currentEditorPage--; Tutorials.renderEditor();}"><i class="fas fa-chevron-left"></i></div>`;
      for (let i=0;i<total;i++){
        pHtml += `<div class="page-btn ${i===this.currentEditorPage?'active':''}" onclick="Tutorials.currentEditorPage=${i}; Tutorials.renderEditor();">${i+1}</div>`;
      }
      pHtml += `<div class="page-btn" onclick="if(Tutorials.currentEditorPage<${total-1}){Tutorials.currentEditorPage++; Tutorials.renderEditor();}"><i class="fas fa-chevron-right"></i></div>`;
      pagination.innerHTML = pHtml;

      const chap = this.curriculum.chapters[this.currentEditorPage];
      if (typeof chap.description !== 'string') chap.description = '';
      if (!Array.isArray(chap.videos)) chap.videos = [];
      if (!Array.isArray(chap.pdfs)) chap.pdfs = [];
      if (!Array.isArray(chap.projects)) chap.projects = [];
      if (!Array.isArray(chap.test_projects)) chap.test_projects = [];
        if (!tutorialProjectsEnabled()) chap.projects = [];
        if (!tutorialProjectsEnabled()) chap.test_projects = [];
        if (!tutorialProjectsEnabled()) chap.draft_reject_rounds = [];
      if (!Array.isArray(chap.tests)) chap.tests = [];
      chap.tests = chap.tests.map((t, idx) => this.normalizeTestSection(t, idx));
      if (!chap.tests.length && (chap.test_enabled || chap.test_projects.length)) {
        chap.tests.push(this.normalizeTestSection(Object.assign({}, chap.test || {}, {
          id: 'test_1',
          title: chap.test_title || 'Test',
          projects: chap.test_projects
        }), 0));
      }
      chap.test_enabled = chap.tests.length > 0;
      chap.hidden = !!chap.hidden;
      chap.visible_to = uniqEmails(chap.visible_to || []);
      if (chap.show_videos !== false && chap.show_videos !== true) chap.show_videos = true;
      if (chap.show_pdfs !== false && chap.show_pdfs !== true) chap.show_pdfs = true;

      const hiddenChecked = chap.hidden ? 'checked' : '';
      const showVideosChecked = (chap.show_videos !== false) ? 'checked' : '';
      const showPdfsChecked = (chap.show_pdfs !== false) ? 'checked' : '';

      container.innerHTML = `
        <div class="tut-editor">
          <div class="chapter-editor-item">
            <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
              <strong>Chapter ${this.currentEditorPage+1} of ${total}</strong>
              <button class="btn-danger btn-sm" onclick="removeEditorChapter(${this.currentEditorPage})">Delete Chapter</button>
            </div>

            <div class="form-row">
              <label>Chapter Title</label>
              <input value="${Portal.escapeHtml(chap.title)}" oninput="Tutorials.curriculum.chapters[${this.currentEditorPage}].title = this.value" onchange="Tutorials.curriculum.chapters[${this.currentEditorPage}].title = this.value">
            </div>

            <div class="form-row">
              <label>Chapter Description <span style="font-weight:normal; font-size:10px;">(Optional)</span></label>
              <textarea rows="3" oninput="Tutorials.curriculum.chapters[${this.currentEditorPage}].description = this.value" onchange="Tutorials.curriculum.chapters[${this.currentEditorPage}].description = this.value">${Portal.escapeHtml(chap.description || '')}</textarea>
            </div>

            <div class="form-row" style="margin-top:14px;">
              <label>Visibility</label>

              <div class="tut-vis-card">
                <div class="tut-vis-top">
                  <label class="tut-inline-label">
                    <input type="checkbox" ${hiddenChecked} onchange="tutSetChapHidden(${this.currentEditorPage}, this.checked)">
                    <span>Hidden chapter</span>
                  </label>

                  <div class="tut-vis-hint">If hidden, only allowlisted users can see it.</div>

                  <button class="tut-icon-btn" onclick="tutRefreshRoster()" title="Refresh user list">
                    <i class="fas fa-sync"></i>
                  </button>
                </div>

                <div id="allowWrap" style="display:${chap.hidden ? 'block' : 'none'};">
                  <div class="tut-allow-controls">
                    <input id="allowSearch" placeholder="Search users…" oninput="tutRenderAllowPicker()">
                    <input id="allowAddEmail" placeholder="Add email (manual)…">
                    <button class="btn-secondary btn-sm" onclick="tutAddAllowedUserFromInput(${this.currentEditorPage})"><i class="fas fa-plus"></i> Add</button>
                  </div>

                  <div id="allowChips" class="tut-allow-chips"></div>

                  <div id="allowList" class="tut-allow-list"></div>

                  <div style="font-size:11px; color:#777; margin-top:8px;">
                    Tip: leave empty to hide from everyone except editors.
                  </div>
                </div>
              </div>
            </div>

            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

            <div class="form-row">
              <div class="tut-sec-head">
                <div class="tut-sec-title">Tests</div>
                <button class="btn-secondary btn-sm" onclick="addTestSection(${this.currentEditorPage})"><i class="fas fa-plus"></i> Add Test</button>
              </div>
              <div id="testSectionList"></div>
            </div>

            <div class="form-row">
              <div class="tut-sec-head">
                <div class="tut-sec-title">Draft / Reject Rounds</div>
                <button class="btn-secondary btn-sm" onclick="addDraftRejectRound(${this.currentEditorPage})"><i class="fas fa-plus"></i> Add Round</button>
              </div>
              <div id="draftRejectRoundList"></div>
            </div>

            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

            <div class="form-row">
              <div class="tut-sec-head">
                <div class="tut-sec-title">Videos</div>
                <label class="tut-toggle">
                  <input type="checkbox" ${showVideosChecked} onchange="tutToggleChapFlag(${this.currentEditorPage}, 'show_videos', this.checked)">
                  <span>Show Videos column</span>
                </label>
              </div>

              <div id="videoBlock" style="${(chap.show_videos===false)?'display:none;':''}">
                <div id="videoList"></div>
                <div class="resource-row">
                  <input id="newVidTitle" placeholder="Video Title">
                  <input id="newVidUrl" placeholder="Video URL (Vimeo/YouTube)">
                  <button class="btn-secondary btn-sm tut-save-resource-btn" onclick="addResource('videos')"><i class="fas fa-check"></i> Save</button>
                </div>
              </div>

              <div id="videoOffHint" style="font-size:11px; color:#777; margin-top:6px; ${(chap.show_videos===false)?'':'display:none;'}">
                Videos column is disabled for this chapter.
              </div>
            </div>

            <div class="form-row">
              <div class="tut-sec-head">
                <div class="tut-sec-title">Guides / Files</div>
                <label class="tut-toggle">
                  <input type="checkbox" ${showPdfsChecked} onchange="tutToggleChapFlag(${this.currentEditorPage}, 'show_pdfs', this.checked)">
                  <span>Show Guides column</span>
                </label>
              </div>

              <div id="pdfBlock" style="${(chap.show_pdfs===false)?'display:none;':''}">
                <div id="pdfList"></div>
                <div class="resource-row">
                  <input id="newPdfTitle" placeholder="File Title">
                  <input id="newPdfUrl" placeholder="File URL or upload below">
                  <button class="btn-secondary btn-sm tut-save-resource-btn" onclick="addResource('pdfs')"><i class="fas fa-check"></i> Save</button>
                </div>
                <div class="resource-row">
                  <input id="newPdfFile" type="file">
                  <button id="btnUploadPdf" class="btn-secondary btn-sm" onclick="uploadTutorialPdfFile()"><i class="fas fa-upload"></i> Upload File</button>
                  <div style="font-size:11px; color:#777;">Uploaded files are stored in this course&apos;s tutorial assets folder.</div>
                </div>
              </div>

              <div id="pdfOffHint" style="font-size:11px; color:#777; margin-top:6px; ${(chap.show_pdfs===false)?'':'display:none;'}">
                Guides column is disabled for this chapter.
              </div>
            </div>

            ${tutorialProjectsEnabled() ? `
            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

            <div class="form-row">
              <label>Practice Projects (Source Project IDs)</label>
              <div id="projEditorList"></div>
              <div style="margin:10px 0; display:flex; justify-content:flex-end;">
                <button class="btn-primary btn-sm" onclick="openTutorialProjectSearch('practice')">
                  <i class="fas fa-search"></i> Search Completed Projects
                </button>
              </div>
              <div class="resource-row">
                <input id="newProjTitle" placeholder="Project Name">
                <input id="newProjAddr" placeholder="Real FirstMeasure Project ID">
                <button class="btn-secondary btn-sm" onclick="addProjectToChapter()"><i class="fas fa-plus"></i> Add</button>
              </div>
              <div style="margin-top:10px; text-align:right;">
                <button id="btnGenerateBatch" class="btn-secondary btn-sm" onclick="generatePendingProjects(${this.currentEditorPage})">
                  <i class="fas fa-check"></i> Add and Validate Project IDs
                </button>
              </div>
            </div>` : `
            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

            <div class="form-row">
              <label>Projects</label>
              <div style="font-size:12px; color:#777;">This course is configured without project work.</div>
            </div>`}

          </div>
        </div>
      `;

      this.renderResourceList('videos', this.currentEditorPage);
      this.renderResourceList('pdfs', this.currentEditorPage);
      this.renderTestSectionList(this.currentEditorPage);
      this.renderDraftRejectRoundList(this.currentEditorPage);
      if (tutorialProjectsEnabled()) this.renderProjectList(this.currentEditorPage);
      this.restoreResourceDrafts(this.currentEditorPage);
      this.attachAutocomplete();

      this.loadStudentRoster(false).then(() => this.renderAllowUserPicker()).catch(()=>{});
    },

    // ---- Editor: visibility controls ----
    setChapHidden(chapIdx, val){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      chap.hidden = !!val;
      chap.visible_to = uniqEmails(chap.visible_to || []);
      this.renderEditor();
    },

    setTestEnabled(chapIdx, enabled){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      if (!!enabled && (!Array.isArray(chap.tests) || !chap.tests.length)) this.addTestSection(chapIdx);
      if (!enabled) chap.tests = [];
      this.renderEditor();
    },

    updateTestSetting(chapIdx, key, value){
      return this.updateTestSection(chapIdx, 0, key, value);
    },

    addTestSection(chapIdx){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      if (!Array.isArray(chap.tests)) chap.tests = [];
      chap.tests.push(this.normalizeTestSection({
        id: `test_${Date.now().toString(36)}`,
        title: `Test ${chap.tests.length + 1}`,
        projects: []
      }, chap.tests.length));
      this.renderEditor();
    },

    removeTestSection(chapIdx, testIdx){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap || !Array.isArray(chap.tests)) return;
      if (!confirm("Delete this test section?")) return;
      chap.tests.splice(testIdx, 1);
      this.renderEditor();
    },

    updateTestSection(chapIdx, testIdx, key, value){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap || !Array.isArray(chap.tests) || !chap.tests[testIdx]) return;
      const test = chap.tests[testIdx];
      if (key === 'title') test.title = String(value || '').trim() || `Test ${testIdx + 1}`;
      if (key === 'required') test.required = !!value;
      if (key === 'retakeable') test.retakeable = !!value;
      if (key === 'sample_count') test.sample_count = Math.max(1, parseInt(value || 1, 10) || 1);
      if (key === 'time_limit_minutes') test.time_limit_minutes = Math.max(0, parseInt(value || 0, 10) || 0);
      if (key === 'passing_score_percent') test.passing_score_percent = Math.max(0, Math.min(100, parseInt(value || 0, 10) || 0));
      if (key === 'retake_wait_hours') test.retake_wait_hours = Math.max(0, parseInt(value || 0, 10) || 0);
    },

    addDraftRejectRound(chapIdx){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      if (!Array.isArray(chap.draft_reject_rounds)) chap.draft_reject_rounds = [];
      chap.draft_reject_rounds.push(this.normalizeDraftRejectRound({
        id: `draft_reject_${Date.now().toString(36)}`,
        title: `Draft or Reject ${chap.draft_reject_rounds.length + 1}`,
        mode: 'practice',
        projects: []
      }, chap.draft_reject_rounds.length));
      this.renderEditor();
    },

    removeDraftRejectRound(chapIdx, roundIdx){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap || !Array.isArray(chap.draft_reject_rounds)) return;
      if (!confirm("Delete this draft/reject round?")) return;
      chap.draft_reject_rounds.splice(roundIdx, 1);
      this.renderEditor();
    },

    updateDraftRejectRound(chapIdx, roundIdx, key, value){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap || !Array.isArray(chap.draft_reject_rounds) || !chap.draft_reject_rounds[roundIdx]) return;
      const round = chap.draft_reject_rounds[roundIdx];
      if (key === 'title') round.title = String(value || '').trim() || `Draft or Reject ${roundIdx + 1}`;
      if (key === 'mode') round.mode = value === 'test' ? 'test' : 'practice';
      if (key === 'required') round.required = !!value;
      if (key === 'sample_count') round.sample_count = Math.max(1, parseInt(value || 1, 10) || 1);
      if (key === 'passing_score_percent') round.passing_score_percent = Math.max(0, Math.min(100, parseInt(value || 0, 10) || 0));
      if (key === 'retake_wait_hours') round.retake_wait_hours = Math.max(0, parseInt(value || 0, 10) || 0);
      this.renderDraftRejectRoundList(chapIdx);
    },

    projectListForChapter(chap, target='practice'){
      if (!chap) return [];
      if (String(target).startsWith('test')) {
        const idx = Math.max(0, parseInt(String(target).split(':')[1] || '0', 10) || 0);
        if (!Array.isArray(chap.tests)) chap.tests = [];
        if (!chap.tests[idx]) chap.tests[idx] = this.normalizeTestSection({}, idx);
        if (!Array.isArray(chap.tests[idx].projects)) chap.tests[idx].projects = [];
        return chap.tests[idx].projects;
      }
      if (!Array.isArray(chap.projects)) chap.projects = [];
      return chap.projects;
    },

    setChapFlag(chapIdx, key, val){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      if (key === 'show_videos') chap.show_videos = !!val;
      if (key === 'show_pdfs') chap.show_pdfs = !!val;
      this.renderEditor();
    },

    toggleAllowedUser(chapIdx, email, checked){
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      const e = normEmail(email);
      chap.visible_to = uniqEmails(chap.visible_to || []);
      const set = new Set(chap.visible_to);

      if (checked) set.add(e);
      else set.delete(e);

      chap.visible_to = Array.from(set).sort();
      this.renderAllowUserPicker();
    },

    removeAllowedUser(chapIdx, email){
      this.toggleAllowedUser(chapIdx, email, false);
    },

    addAllowedUserFromInput(chapIdx){
      const input = document.getElementById('allowAddEmail');
      if (!input) return;
      const email = normEmail(input.value);
      if (!email) return;
      input.value = '';
      this.toggleAllowedUser(chapIdx, email, true);
    },

    renderAllowUserPicker(){
      const chapIdx = this.currentEditorPage;
      const chap = this.curriculum.chapters[chapIdx];

      const wrap = document.getElementById('allowWrap');
      const chips = document.getElementById('allowChips');
      const list = document.getElementById('allowList');
      if (!chap || !wrap || !chips || !list) return;

      wrap.style.display = chap.hidden ? 'block' : 'none';
      if (!chap.hidden) return;

      chap.visible_to = uniqEmails(chap.visible_to || []);

      // chips
      chips.innerHTML = '';
      if (chap.visible_to.length === 0) {
        chips.innerHTML = `<div style="color:#999; font-style:italic; font-size:12px;">No allowlisted users.</div>`;
      } else {
        chap.visible_to.forEach(e => {
          const pill = document.createElement('span');
          pill.className = 'tut-chip';
          pill.innerHTML = `
            <span class="tut-chip-email">${Portal.escapeHtml(e)}</span>
            <button title="Remove" onclick="tutRemoveAllowedUser(${chapIdx}, '${String(e).replace(/'/g,"\\'")}')">&times;</button>
          `;
          chips.appendChild(pill);
        });
      }

      // list
      const qRaw = String(document.getElementById('allowSearch')?.value || '').trim().toLowerCase();
      const allowSet = new Set(chap.visible_to);

      const roster = (this.studentRoster || []).filter(u => {
        if (!u || !u.email) return false;
        if (!qRaw) return true;
        const hay = `${u.name || ''} ${u.email}`.toLowerCase();
        return hay.includes(qRaw);
      });

      list.innerHTML = '';
      if (roster.length === 0) {
        list.innerHTML = `<div style="color:#999; font-style:italic; font-size:12px; padding:10px;">No matches.</div>`;
        return;
      }

      roster.forEach(u => {
        const row = document.createElement('label');
        row.className = 'tut-allow-row';

        const checked = allowSet.has(u.email);

        row.innerHTML = `
          <input type="checkbox" ${checked ? 'checked' : ''}>
          <div class="tut-allow-meta">
            <div class="tut-allow-name">${Portal.escapeHtml(u.name || u.email)}</div>
            <div class="tut-allow-email">${Portal.escapeHtml(u.email)}</div>
          </div>
        `;

        const cb = row.querySelector('input');
        if (cb) cb.onchange = () => this.toggleAllowedUser(chapIdx, u.email, cb.checked);

        list.appendChild(row);
      });
    },

    // ---- Editor: resources/projects ----
    attachAutocomplete(){
      if (!window.google || !google.maps || !google.maps.places) return;

      const inputs = document.querySelectorAll('.maps-autocomplete');
      inputs.forEach(input => {
        if (input.getAttribute('data-init') === 'true') return;
        input.setAttribute('data-init', 'true');

        const autocomplete = new google.maps.places.Autocomplete(input);
        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (place.formatted_address) {
            input.value = place.formatted_address;
            input.dispatchEvent(new Event('change'));
          }
        });
      });
    },

    renderResourceList(type, chapIdx){
      const container = document.getElementById(type === 'videos' ? 'videoList' : 'pdfList');
      if (!container) return;

      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;

      if (type === 'videos' && chap.show_videos === false) { container.innerHTML = ''; return; }
      if (type === 'pdfs' && chap.show_pdfs === false) { container.innerHTML = ''; return; }

      container.innerHTML = '';
      const items = chap[type] || [];
      items.forEach((item, idx) => {
        container.innerHTML += `
          <div class="resource-row resource-row-saved">
            <input value="${Portal.escapeHtml(item.title||'')}" onchange="updateResource('${type}', ${chapIdx}, ${idx}, 'title', this.value)">
            <input value="${Portal.escapeHtml(item.url||'')}" onchange="updateResource('${type}', ${chapIdx}, ${idx}, 'url', this.value)">
            <span class="tut-resource-state">Saved</span>
            <button class="btn-danger btn-sm" onclick="removeResource('${type}', ${chapIdx}, ${idx})"><i class="fas fa-trash"></i></button>
          </div>`;
      });
    },

    normalizeTutorialProjectSearchRow(project){
      const p = project && typeof project === 'object' ? project : {};
      const manifest = p.manifest && typeof p.manifest === 'object' ? p.manifest : {};
      const id = String(p.id || p.folder || p.project_id || manifest.id || manifest.folder || '').trim();
      const address = String(p.address || manifest.address || '').trim();
      const complexity = p.complexity ?? manifest.complexity ?? null;
      const pointValue = p.point_value ?? manifest.point_value ?? this.pointValueForComplexity(complexity);
      const status = String(p.status || manifest.status || '').trim();
      const projectType = String(p.project_type || manifest.project_type || '').trim();
      return {
        raw: p,
        id,
        address,
        name: address || id,
        complexity,
        point_value: pointValue,
        status,
        project_type: projectType,
        thumbnail: String(p.thumbnail || '').trim() || (id ? fmUrl(`projects/${encodeURIComponent(id)}/thumbnail?w=320`) : '')
      };
    },

    pointValueForComplexity(value){
      const n = parseInt(value, 10);
      if (n === 1) return 0.5;
      if (n === 2) return 1;
      if (n === 3) return 2;
      if (n === 4) return 3;
      if (n === 5) return 5;
      return null;
    },

    formatProjectComplexity(value){
      const n = parseInt(value, 10);
      return Number.isFinite(n) && n > 0 ? `${n}/5` : 'No cx';
    },

    formatPointValue(value){
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return '';
      return `${n} pt${n === 1 ? '' : 's'}`;
    },

    ensureProjectSearchModal(){
      this.ensureEditorCss();
      let modal = document.getElementById('tutorialProjectSearchModal');
      if (modal) return modal;

      modal = document.createElement('div');
      modal.id = 'tutorialProjectSearchModal';
      modal.className = 'tut-project-search-backdrop';
      modal.innerHTML = `
        <div class="tut-project-search-modal" role="dialog" aria-modal="true" aria-labelledby="tutorialProjectSearchTitle">
          <div class="tut-project-search-head">
            <h3 id="tutorialProjectSearchTitle">Add Completed Project</h3>
            <button class="tut-project-search-close" onclick="closeTutorialProjectSearch()" title="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="tut-project-search-controls">
            <input id="tutorialProjectSearchInput" placeholder="Search completed projects by address or project ID">
            <select id="tutorialProjectComplexityFilter" onchange="setTutorialProjectComplexityFilter(this.value)" title="Filter by complexity">
              <option value="all">All complexity</option>
              <option value="1">Complexity 1</option>
              <option value="2">Complexity 2</option>
              <option value="3">Complexity 3</option>
              <option value="4">Complexity 4</option>
              <option value="5">Complexity 5</option>
            </select>
            <select id="tutorialProjectStatusFilter" onchange="setTutorialProjectStatusFilter(this.value)" title="Filter by status">
              <option value="completed">Completed</option>
              <option value="rejected">Rejected</option>
              <option value="pending_rejection">Pending rejection</option>
              <option value="all">All statuses</option>
            </select>
            <button class="btn-primary" id="tutorialProjectSearchBtn" onclick="searchTutorialProjects()">
              <i class="fas fa-search"></i> Search
            </button>
          </div>
          <div class="tut-project-search-status">
            <span id="tutorialProjectSearchSummary">Most recent completed projects</span>
            <span class="tut-project-pager">
              <button type="button" id="tutorialProjectPrevBtn" onclick="tutorialProjectSearchPage(-1)" title="Previous page"><i class="fas fa-chevron-left"></i></button>
              <span id="tutorialProjectPageLabel">Page 1</span>
              <button type="button" id="tutorialProjectNextBtn" onclick="tutorialProjectSearchPage(1)" title="Next page"><i class="fas fa-chevron-right"></i></button>
            </span>
          </div>
          <div class="tut-project-search-body">
            <div id="tutorialProjectSearchResults" class="tut-project-empty">Search for a completed project to add it to this chapter.</div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) this.closeProjectSearchModal();
      });
      const input = modal.querySelector('#tutorialProjectSearchInput');
      if (input) {
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') this.searchCompletedProjects();
          if (ev.key === 'Escape') this.closeProjectSearchModal();
        });
      }
      return modal;
    },

    openProjectSearchModal(target='practice'){
      if (!tutorialProjectsEnabled()) return;
      target = String(target || 'practice');
      this.projectSearchTarget = (target.startsWith('test') || target.startsWith('draftreject')) ? target : 'practice';
      const modal = this.ensureProjectSearchModal();
      modal.classList.add('show');
      const input = modal.querySelector('#tutorialProjectSearchInput');
      if (input) {
        input.value = this.projectSearchQuery || '';
        setTimeout(() => input.focus(), 0);
      }
      const complexity = modal.querySelector('#tutorialProjectComplexityFilter');
      if (complexity) complexity.value = this.projectSearchComplexity || 'all';
      const status = modal.querySelector('#tutorialProjectStatusFilter');
      if (status) status.value = this.projectSearchStatus || 'completed';
      this.renderProjectSearchResults();
      if (!this.projectSearchResults.length) {
        this.searchCompletedProjects(false);
      }
    },

    closeProjectSearchModal(){
      const modal = document.getElementById('tutorialProjectSearchModal');
      if (modal) modal.classList.remove('show');
    },

    async searchCompletedProjects(){
      return this.loadCompletedProjectBrowser(1);
    },

    setProjectSearchComplexity(value){
      this.projectSearchComplexity = String(value || 'all').trim() || 'all';
      this.loadCompletedProjectBrowser(1);
    },

    setProjectSearchStatus(value){
      this.projectSearchStatus = String(value || 'completed').trim() || 'completed';
      this.loadCompletedProjectBrowser(1, { status: this.projectSearchStatus });
    },

    changeProjectSearchPage(direction){
      const next = Math.max(1, Math.min(this.projectSearchTotalPages || 1, (this.projectSearchPage || 1) + Number(direction || 0)));
      if (next === this.projectSearchPage) return;
      this.loadCompletedProjectBrowser(next);
    },

    async loadCompletedProjectBrowser(page = 1, overrides = {}){
      const modal = this.ensureProjectSearchModal();
      const input = modal.querySelector('#tutorialProjectSearchInput');
      const query = String(input?.value || '').trim();
      const complexity = String(modal.querySelector('#tutorialProjectComplexityFilter')?.value || this.projectSearchComplexity || 'all').trim() || 'all';
      const status = String(overrides.status || this.projectSearchStatus || modal.querySelector('#tutorialProjectStatusFilter')?.value || 'completed').trim() || 'completed';
      const statusEl = modal.querySelector('#tutorialProjectStatusFilter');
      if (statusEl && statusEl.value !== status) statusEl.value = status;
      this.projectSearchQuery = query;
      this.projectSearchComplexity = complexity;
      this.projectSearchStatus = status;
      this.projectSearchPage = Math.max(1, parseInt(page, 10) || 1);
      this.projectSearchLoading = true;
      this.renderProjectSearchResults();

      try {
        const data = await this.fetchTutorialProjectPickerRows({
          query,
          complexity,
          status,
          page: this.projectSearchPage
        });
        const rows = Array.isArray(data.projects) ? data.projects : [];
        this.projectSearchResults = rows
          .map(p => this.normalizeTutorialProjectSearchRow(p))
          .filter(p => this.tutorialStatusMatches(p.raw || p, status))
          .filter(p => p.id);
        const pagination = data.pagination || {};
        this.projectSearchTotalPages = Math.max(1, parseInt(pagination.total_pages, 10) || 1);
        this.projectSearchTotalCount = Math.max(0, parseInt(pagination.total_count, 10) || this.projectSearchResults.length);
        this.projectSearchPage = Math.max(1, Math.min(this.projectSearchPage, this.projectSearchTotalPages));
      } catch (err) {
        console.error('[Tutorials] Completed project search failed:', err);
        this.projectSearchResults = [];
        this.projectSearchTotalPages = 1;
        this.projectSearchTotalCount = 0;
        alert(err.message || 'Project search failed.');
      } finally {
        this.projectSearchLoading = false;
        this.renderProjectSearchResults();
      }
    },

    tutorialStatusMatches(project, status){
      const wanted = String(status || 'completed').trim().toLowerCase();
      if (wanted === 'all') return true;
      const manifest = project?.manifest && typeof project.manifest === 'object' ? project.manifest : {};
      const actual = String(project?.status || manifest.status || '').trim().toLowerCase();
      if (wanted === 'rejected') return actual === 'rejected' || actual === 'rejected_no_coverage';
      return actual === wanted;
    },

    async fetchTutorialProjectPickerRows({ query='', complexity='all', status='completed', page=1 } = {}){
      const wanted = String(status || 'completed').trim().toLowerCase() || 'completed';
      const limit = this.projectSearchLimit;
      if (wanted === 'completed' || wanted === 'all') {
        return await fmPost('projects/list', {
          filter: 'all',
          search: query,
          status_filter: wanted,
          complexity_filter: complexity,
          include_all: true,
          view: 'card',
          page,
          limit,
          cache_bust: Date.now()
        });
      }

      const statuses = wanted === 'rejected'
        ? ['rejected', 'rejected_no_coverage']
        : [wanted];
      const queried = await fmPost('projects/query', {
        statuses,
        search: query,
        complexity_filter: complexity,
        include_all: true,
        view: 'card',
        limit: 1000,
        cache_bust: Date.now()
      }).catch(() => null);
      if (queried && Array.isArray(queried.projects)) {
        const filtered = queried.projects.filter((row) => this.tutorialStatusMatches(row, wanted));
        const currentPage = Math.max(1, parseInt(page, 10) || 1);
        const totalCount = filtered.length;
        const totalClientPages = Math.max(1, Math.ceil(totalCount / limit));
        const safePage = Math.min(currentPage, totalClientPages);
        const start = (safePage - 1) * limit;
        return {
          projects: filtered.slice(start, start + limit),
          pagination: {
            page: safePage,
            current_page: safePage,
            limit,
            total_count: totalCount,
            total_pages: totalClientPages
          }
        };
      }

      const collected = [];
      let apiPage = 1;
      let totalPages = 1;
      const apiLimit = 200;
      const maxPages = 25;
      while (apiPage <= totalPages && apiPage <= maxPages) {
        const data = await fmPost('projects/list', {
          filter: 'all',
          search: query,
          status_filter: 'all',
          complexity_filter: complexity,
          include_all: true,
          view: 'card',
          page: apiPage,
          limit: apiLimit,
          cache_bust: Date.now()
        });
        const rows = Array.isArray(data.projects) ? data.projects : [];
        rows.forEach((row) => {
          if (this.tutorialStatusMatches(row, wanted)) collected.push(row);
        });
        const pagination = data.pagination || {};
        totalPages = Math.max(1, parseInt(pagination.total_pages, 10) || totalPages || 1);
        if (!rows.length || apiPage >= totalPages) break;
        apiPage++;
      }
      const currentPage = Math.max(1, parseInt(page, 10) || 1);
      const totalCount = collected.length;
      const totalClientPages = Math.max(1, Math.ceil(totalCount / limit));
      const safePage = Math.min(currentPage, totalClientPages);
      const start = (safePage - 1) * limit;
      return {
        projects: collected.slice(start, start + limit),
        pagination: {
          page: safePage,
          current_page: safePage,
          limit,
          total_count: totalCount,
          total_pages: totalClientPages
        }
      };
    },

    renderProjectSearchResults(){
      const target = document.getElementById('tutorialProjectSearchResults');
      if (!target) return;
      const summary = document.getElementById('tutorialProjectSearchSummary');
      const pageLabel = document.getElementById('tutorialProjectPageLabel');
      const prevBtn = document.getElementById('tutorialProjectPrevBtn');
      const nextBtn = document.getElementById('tutorialProjectNextBtn');
      const totalPages = Math.max(1, this.projectSearchTotalPages || 1);
      const currentPage = Math.max(1, Math.min(this.projectSearchPage || 1, totalPages));
      if (summary) {
        const bits = [];
        const label = this.projectSearchStatus === 'rejected'
          ? 'rejected'
          : (this.projectSearchStatus === 'pending_rejection' ? 'pending rejection' : (this.projectSearchStatus === 'all' ? 'total' : 'completed'));
        bits.push(`${this.projectSearchTotalCount || 0} ${label} project${(this.projectSearchTotalCount || 0) === 1 ? '' : 's'}`);
        if (this.projectSearchQuery) bits.push(`matching "${this.projectSearchQuery}"`);
        if (this.projectSearchComplexity && this.projectSearchComplexity !== 'all') bits.push(`complexity ${this.projectSearchComplexity}`);
        if (this.projectSearchStatus && this.projectSearchStatus !== 'completed') bits.push(`status ${this.projectSearchStatus.replace(/_/g, ' ')}`);
        summary.textContent = bits.join(' · ');
      }
      if (pageLabel) pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
      if (prevBtn) prevBtn.disabled = currentPage <= 1 || this.projectSearchLoading;
      if (nextBtn) nextBtn.disabled = currentPage >= totalPages || this.projectSearchLoading;
      if (this.projectSearchLoading) {
        target.className = 'tut-project-empty';
        target.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Searching completed projects...';
        return;
      }
      const rows = Array.isArray(this.projectSearchResults) ? this.projectSearchResults : [];
      if (!rows.length) {
        target.className = 'tut-project-empty';
        target.textContent = this.projectSearchQuery || (this.projectSearchComplexity && this.projectSearchComplexity !== 'all')
          ? 'No completed projects found for these filters.'
          : 'No completed projects found.';
        return;
      }
      target.className = 'tut-project-search-grid';
      target.innerHTML = rows.map((p) => {
        const cx = this.formatProjectComplexity(p.complexity);
        const points = this.formatPointValue(p.point_value);
        const type = p.project_type ? p.project_type.replace(/_/g, ' ') : '';
        const safeId = String(p.id).replace(/'/g, "\\'");
        return `
          <div class="tut-project-card">
            <div class="tut-project-thumb">
              <img src="${Portal.escapeHtml(p.thumbnail)}" onerror="this.style.display='none'">
              <div class="tut-project-cx">${Portal.escapeHtml(cx)}</div>
            </div>
            <div class="tut-project-meta">
              <div class="tut-project-address">${Portal.escapeHtml(p.address || p.id)}</div>
              <div class="tut-project-sub">
                <span class="tut-project-pill">${Portal.escapeHtml(p.id)}</span>
                ${points ? `<span class="tut-project-pill">${Portal.escapeHtml(points)}</span>` : ''}
                ${type ? `<span class="tut-project-pill">${Portal.escapeHtml(type)}</span>` : ''}
              </div>
              <div class="tut-project-actions">
                <button type="button" class="tut-project-add" onclick="selectTutorialSourceProject('${safeId}')">
                  <i class="fas fa-plus"></i> Add
                </button>
                <button type="button" class="tut-project-open" onclick="openTutorialSourceEditor('${safeId}')">
                  <i class="fas fa-up-right-from-square"></i> Editor
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    },

    selectTutorialSourceProject(projectId){
      const project = (this.projectSearchResults || []).find(p => String(p.id) === String(projectId));
      if (!project) return;
      const chap = this.curriculum.chapters[this.currentEditorPage];
      if (!chap) return;
      if (String(this.projectSearchTarget || '').startsWith('test')) chap.test_enabled = true;
      if (String(this.projectSearchTarget || '').startsWith('draftreject')) {
        const roundIdx = Math.max(0, parseInt(String(this.projectSearchTarget).split(':')[1] || '0', 10) || 0);
        if (!Array.isArray(chap.draft_reject_rounds)) chap.draft_reject_rounds = [];
        if (!chap.draft_reject_rounds[roundIdx]) chap.draft_reject_rounds[roundIdx] = this.normalizeDraftRejectRound({}, roundIdx);
        const list = chap.draft_reject_rounds[roundIdx].projects || (chap.draft_reject_rounds[roundIdx].projects = []);
        const exists = list.some(p => String(p.project_id || p.source_project_id || p.id || '') === String(project.id));
        if (exists) {
          alert('That project is already in this draft/reject round.');
          return;
        }
        list.push({
          curriculum_project_id: this.newCurriculumProjectId(),
          name: project.address || project.id,
          id: project.id,
          project_id: project.id,
          source_project_id: project.id,
          address: project.address || '',
          complexity: project.complexity ?? null,
          point_value: project.point_value ?? null,
          correct_decision: 'draft'
        });
        this.closeProjectSearchModal();
        this.renderEditor();
        return;
      }
      const list = this.projectListForChapter(chap, this.projectSearchTarget);
      const exists = list.some(p => String(p.project_id || p.source_project_id || p.id || '') === String(project.id));
      if (exists) {
        alert('That project is already in this chapter.');
        return;
      }
      list.push({
        curriculum_project_id: this.newCurriculumProjectId(),
        name: project.address || project.id,
        id: project.id,
        project_id: project.id,
        source_project_id: project.id,
        address: project.address || '',
        complexity: project.complexity ?? null,
        point_value: project.point_value ?? null
      });
      this.closeProjectSearchModal();
      this.renderEditor();
    },

    openSourceProjectEditor(projectId){
      const id = String(projectId || '').trim();
      if (!id) return;
      window.open(`editor.php?folder=${encodeURIComponent(id)}`, '_blank', 'noopener');
    },

    renderProjectList(chapIdx){
      const container = document.getElementById('projEditorList');
      if (!container) return;
      container.innerHTML = '';
      if (!tutorialProjectsEnabled()) return;

      const chap = this.curriculum.chapters[chapIdx];
      const items = this.projectListForChapter(chap, 'practice');
      items.forEach((p, idx) => {
        const sourceProjectId = p.project_id || p.source_project_id || p.id || '';
        const statusColor = sourceProjectId ? '#34a853' : '#fbbc04';
        const statusText = sourceProjectId ? 'Ready' : 'Missing ID';
        const gradingEnabled = p.grading_enabled !== false;

        container.innerHTML += `
          <div class="resource-row" id="proj-row-${idx}">
            <input value="${Portal.escapeHtml(p.name||'')}" onchange="updateProject(${chapIdx}, ${idx}, 'name', this.value)" style="flex:1;">
            <input value="${Portal.escapeHtml(sourceProjectId)}" onchange="updateProject(${chapIdx}, ${idx}, 'id', this.value)" style="flex:2;" placeholder="Real Project ID">
            <label class="tut-grade-switch" title="When off, submitting this practice project completes it without calculating or displaying a score.">
              <input type="checkbox" ${gradingEnabled ? 'checked' : ''} onchange="updateProject(${chapIdx}, ${idx}, 'grading_enabled', this.checked); this.parentElement.querySelector('.tut-grade-switch-text').textContent = this.checked ? 'Grading on' : 'Grading off';">
              <span class="tut-grade-switch-track" aria-hidden="true"></span>
              <span class="tut-grade-switch-text">${gradingEnabled ? 'Grading on' : 'Grading off'}</span>
            </label>
            <div class="status" style="color:${statusColor}; font-weight:bold;">${statusText}</div>
            <button class="btn-danger btn-sm" onclick="removeProject(${chapIdx}, ${idx})"><i class="fas fa-trash"></i></button>
          </div>`;
      });
    },

    renderTestSectionList(chapIdx){
      const container = document.getElementById('testSectionList');
      if (!container) return;
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap || !Array.isArray(chap.tests) || !chap.tests.length) {
        container.innerHTML = '<div style="font-size:12px; color:#777;">No tests in this chapter.</div>';
        return;
      }
      container.innerHTML = chap.tests.map((test, testIdx) => {
        const retakeChecked = test.retakeable !== false ? 'checked' : '';
        const requiredChecked = test.required === true ? 'checked' : '';
        return `
          <div style="border:1px solid #eee; border-radius:10px; padding:12px; margin-top:10px; background:#fff;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
              <input value="${Portal.escapeHtml(test.title || '')}" onchange="updateTestSection(${chapIdx}, ${testIdx}, 'title', this.value)" style="font-weight:900;">
              <button class="btn-danger btn-sm" onclick="removeTestSection(${chapIdx}, ${testIdx})"><i class="fas fa-trash"></i></button>
            </div>
            <div class="resource-row">
              <input type="number" min="1" value="${Portal.escapeHtml(test.sample_count)}" onchange="updateTestSection(${chapIdx}, ${testIdx}, 'sample_count', this.value)" placeholder="Projects to assign">
              <input type="number" min="0" value="${Portal.escapeHtml(test.time_limit_minutes)}" onchange="updateTestSection(${chapIdx}, ${testIdx}, 'time_limit_minutes', this.value)" placeholder="Time limit minutes">
              <input type="number" min="0" max="100" value="${Portal.escapeHtml(test.passing_score_percent)}" onchange="updateTestSection(${chapIdx}, ${testIdx}, 'passing_score_percent', this.value)" placeholder="Passing score %">
            </div>
            <div class="resource-row">
              <label class="tut-inline-label">
                <input type="checkbox" ${requiredChecked} onchange="updateTestSection(${chapIdx}, ${testIdx}, 'required', this.checked)">
                <span>Required to advance</span>
              </label>
              <label class="tut-inline-label">
                <input type="checkbox" ${retakeChecked} onchange="updateTestSection(${chapIdx}, ${testIdx}, 'retakeable', this.checked)">
                <span>Retakeable</span>
              </label>
            </div>
            <div class="resource-row">
              <input type="number" min="0" value="${Portal.escapeHtml(test.retake_wait_hours)}" onchange="updateTestSection(${chapIdx}, ${testIdx}, 'retake_wait_hours', this.value)" placeholder="Retake wait hours">
              <div style="font-size:11px; color:#777;">The time limit applies across this test attempt.</div>
            </div>
            <label style="margin-top:12px;">Project Pool</label>
            <div id="testProjEditorList-${testIdx}"></div>
            <div style="margin:10px 0; display:flex; justify-content:flex-end;">
              <button class="btn-primary btn-sm" onclick="openTutorialProjectSearch('test:${testIdx}')">
                <i class="fas fa-search"></i> Search Completed Projects
              </button>
            </div>
            <div class="resource-row">
              <input id="newTestProjTitle-${testIdx}" placeholder="Project Name">
              <input id="newTestProjAddr-${testIdx}" placeholder="Real FirstMeasure Project ID">
              <button class="btn-secondary btn-sm" onclick="addProjectToChapter('test:${testIdx}')"><i class="fas fa-plus"></i> Add</button>
            </div>
            <div style="margin-top:10px; text-align:right;">
              <button id="btnGenerateTestBatch-${testIdx}" class="btn-secondary btn-sm" onclick="generatePendingProjects(${chapIdx}, 'test:${testIdx}')">
                <i class="fas fa-check"></i> Add and Validate Test Pool
              </button>
            </div>
          </div>
        `;
      }).join('');
      chap.tests.forEach((test, testIdx) => this.renderTestProjectList(chapIdx, testIdx));
    },

    renderTestProjectList(chapIdx, testIdx=0){
      const container = document.getElementById(`testProjEditorList-${testIdx}`) || document.getElementById('testProjEditorList');
      if (!container) return;
      container.innerHTML = '';
      if (!tutorialProjectsEnabled()) return;

      const chap = this.curriculum.chapters[chapIdx];
      const items = this.projectListForChapter(chap, `test:${testIdx}`);
      if (!items.length) {
        container.innerHTML = '<div style="font-size:12px; color:#777;">No test pool projects yet.</div>';
        return;
      }
      items.forEach((p, idx) => {
        const sourceProjectId = p.project_id || p.source_project_id || p.id || '';
        const statusColor = sourceProjectId ? '#34a853' : '#fbbc04';
        const statusText = sourceProjectId ? 'Ready' : 'Missing ID';

        container.innerHTML += `
          <div class="resource-row" id="test-proj-row-${idx}">
            <input value="${Portal.escapeHtml(p.name||'')}" onchange="updateProject(${chapIdx}, ${idx}, 'name', this.value, 'test:${testIdx}')" style="flex:1;">
            <input value="${Portal.escapeHtml(sourceProjectId)}" onchange="updateProject(${chapIdx}, ${idx}, 'id', this.value, 'test:${testIdx}')" style="flex:2;" placeholder="Real Project ID">
            <div class="status" style="color:${statusColor}; font-weight:bold;">${statusText}</div>
            <button class="btn-danger btn-sm" onclick="removeProject(${chapIdx}, ${idx}, 'test:${testIdx}')"><i class="fas fa-trash"></i></button>
          </div>`;
      });
    },

    renderDraftRejectRoundList(chapIdx){
      const container = document.getElementById('draftRejectRoundList');
      if (!container) return;
      const chap = this.curriculum.chapters[chapIdx];
      if (!chap) return;
      if (!Array.isArray(chap.draft_reject_rounds)) chap.draft_reject_rounds = [];
      if (!chap.draft_reject_rounds.length) {
        container.innerHTML = '<div style="font-size:12px; color:#777;">No draft/reject rounds in this chapter.</div>';
        return;
      }
      container.innerHTML = chap.draft_reject_rounds.map((round, roundIdx) => {
        const requiredChecked = round.required === true ? 'checked' : '';
        return `
          <div style="border:1px solid #eee; border-radius:10px; padding:12px; margin-top:10px; background:#fff;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
              <input value="${Portal.escapeHtml(round.title || '')}" onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'title', this.value)" style="font-weight:900;">
              <button class="btn-danger btn-sm" onclick="removeDraftRejectRound(${chapIdx}, ${roundIdx})"><i class="fas fa-trash"></i></button>
            </div>
            <div class="resource-row">
              <select onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'mode', this.value)">
                <option value="practice" ${round.mode === 'test' ? '' : 'selected'}>Practice</option>
                <option value="test" ${round.mode === 'test' ? 'selected' : ''}>Test</option>
              </select>
              <input type="number" min="1" value="${Portal.escapeHtml(round.sample_count)}" onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'sample_count', this.value)" placeholder="Projects to sample">
              <input type="number" min="0" max="100" value="${Portal.escapeHtml(round.passing_score_percent)}" onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'passing_score_percent', this.value)" placeholder="Passing score %">
            </div>
            <div class="resource-row">
              <label class="tut-inline-label">
                <input type="checkbox" ${requiredChecked} onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'required', this.checked)">
                <span>Required to advance</span>
              </label>
              <input type="number" min="0" value="${Portal.escapeHtml(round.retake_wait_hours)}" onchange="updateDraftRejectRound(${chapIdx}, ${roundIdx}, 'retake_wait_hours', this.value)" placeholder="Retake wait hours">
              <div style="font-size:11px; color:#777;">Retake wait applies to test rounds.</div>
            </div>
            <label style="margin-top:12px;">Project Pool</label>
            <div id="draftRejectProjectList-${roundIdx}"></div>
            <div style="margin:10px 0; display:flex; justify-content:flex-end;">
              <button class="btn-primary btn-sm" onclick="openTutorialProjectSearch('draftreject:${roundIdx}')">
                <i class="fas fa-search"></i> Search Projects
              </button>
            </div>
            <div style="margin-top:10px; border:1px solid #edf0f5; border-radius:8px; padding:10px; background:#f8f9fb;">
              <label style="font-size:11px; font-weight:900; color:#344054;">Paste Project IDs</label>
              <textarea id="draftRejectBulkIds-${roundIdx}" rows="4" placeholder="One project ID per line" style="margin-top:6px; width:100%; resize:vertical;"></textarea>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:8px;">
                <div style="font-size:11px; color:#777;">New pasted IDs are added as Reject.</div>
                <button class="btn-secondary btn-sm" onclick="addDraftRejectBulkIds(${chapIdx}, ${roundIdx})">
                  <i class="fas fa-plus"></i> Add IDs
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
      chap.draft_reject_rounds.forEach((round, roundIdx) => this.renderDraftRejectProjectList(chapIdx, roundIdx));
    },

    renderDraftRejectProjectList(chapIdx, roundIdx){
      const container = document.getElementById(`draftRejectProjectList-${roundIdx}`);
      if (!container) return;
      const chap = this.curriculum.chapters[chapIdx];
      const round = chap?.draft_reject_rounds?.[roundIdx];
      if (!round) return;
      if (!Array.isArray(round.projects)) round.projects = [];
      if (!round.projects.length) {
        container.innerHTML = '<div style="font-size:12px; color:#777;">No project pool items yet.</div>';
        return;
      }
      container.innerHTML = round.projects.map((p, idx) => {
        const sourceProjectId = p.project_id || p.source_project_id || p.id || '';
        const decision = this.normalizeDecision(p.correct_decision || 'draft');
        return `
          <div class="resource-row" id="draft-reject-proj-row-${roundIdx}-${idx}">
            <input value="${Portal.escapeHtml(p.name||'')}" onchange="updateDraftRejectProject(${chapIdx}, ${roundIdx}, ${idx}, 'name', this.value)" style="flex:1;">
            <input value="${Portal.escapeHtml(sourceProjectId)}" onchange="updateDraftRejectProject(${chapIdx}, ${roundIdx}, ${idx}, 'id', this.value)" style="flex:1.5;" placeholder="Real Project ID">
            <select onchange="updateDraftRejectProject(${chapIdx}, ${roundIdx}, ${idx}, 'correct_decision', this.value)">
              <option value="draft" ${decision === 'draft' ? 'selected' : ''}>Draft</option>
              <option value="reject" ${decision === 'reject' ? 'selected' : ''}>Reject</option>
            </select>
            <button class="btn-secondary btn-sm" onclick="openTutorialSourceEditor('${String(sourceProjectId).replace(/'/g, "\\'")}')" title="Open in editor"><i class="fas fa-up-right-from-square"></i></button>
            <button class="btn-danger btn-sm" onclick="removeDraftRejectProject(${chapIdx}, ${roundIdx}, ${idx})"><i class="fas fa-trash"></i></button>
          </div>`;
      }).join('');
    },

    updateDraftRejectProject(chapIdx, roundIdx, itemIdx, key, value){
      const item = this.curriculum.chapters?.[chapIdx]?.draft_reject_rounds?.[roundIdx]?.projects?.[itemIdx];
      if (!item) return;
      if (key === 'id') {
        item.id = String(value || '').trim();
        item.project_id = item.id;
        item.source_project_id = item.id;
        return;
      }
      if (key === 'correct_decision') item.correct_decision = this.normalizeDecision(value);
      else item[key] = value;
    },

    removeDraftRejectProject(chapIdx, roundIdx, itemIdx){
      const projects = this.curriculum.chapters?.[chapIdx]?.draft_reject_rounds?.[roundIdx]?.projects;
      if (!Array.isArray(projects)) return;
      projects.splice(itemIdx, 1);
      this.renderDraftRejectRoundList(chapIdx);
    },

    parseProjectIdsBlock(value){
      const seen = new Set();
      return String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const token = line.split(/[\s,;]+/).find(Boolean) || '';
          return token.replace(/[^a-zA-Z0-9_-]/g, '');
        })
        .filter(id => {
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
    },

    addDraftRejectBulkIds(chapIdx, roundIdx){
      const chap = this.curriculum.chapters?.[chapIdx];
      const round = chap?.draft_reject_rounds?.[roundIdx];
      if (!round) return;
      if (!Array.isArray(round.projects)) round.projects = [];
      const textarea = document.getElementById(`draftRejectBulkIds-${roundIdx}`);
      const ids = this.parseProjectIdsBlock(textarea?.value || '');
      if (!ids.length) {
        alert('Paste at least one project ID.');
        return;
      }
      const existing = new Set(round.projects.map(p => String(p.project_id || p.source_project_id || p.id || '').trim()).filter(Boolean));
      let added = 0;
      ids.forEach(id => {
        if (existing.has(id)) return;
        existing.add(id);
        round.projects.push({
          curriculum_project_id: this.newCurriculumProjectId(),
          name: id,
          id,
          project_id: id,
          source_project_id: id,
          correct_decision: 'reject'
        });
        added++;
      });
      if (textarea) textarea.value = '';
      this.renderDraftRejectRoundList(chapIdx);
      if (!added) alert('All pasted project IDs were already in this pool.');
    },

    async addResource(type){
      const chap = this.curriculum.chapters[this.currentEditorPage];
      if (!chap) return;

      if (type === 'videos' && chap.show_videos === false) return alert("Videos column is disabled for this chapter.");
      if (type === 'pdfs' && chap.show_pdfs === false) return alert("Guides column is disabled for this chapter.");

      const titleId = type === 'videos' ? 'newVidTitle' : 'newPdfTitle';
      const urlId   = type === 'videos' ? 'newVidUrl'   : 'newPdfUrl';
      let title = document.getElementById(titleId)?.value || '';
      let url   = document.getElementById(urlId)?.value || '';

      if (type === 'pdfs') {
        const file = document.getElementById('newPdfFile')?.files?.[0];
        if (file && !String(url).trim()) {
          try {
            const uploaded = await this.uploadPdfDraft();
            title = uploaded?.title || title;
            url = uploaded?.url || url;
          } catch (err) {
            return alert(err.message || "Could not upload file.");
          }
        }
      }

      if (!title || !url) {
        return alert(type === 'pdfs'
          ? "Enter a title and either upload a file or provide a URL."
          : "Enter both title and URL");
      }

      if (!chap[type]) chap[type] = [];
      chap[type].push({ title, url });
      this.resourceDrafts[this.draftKey(this.currentEditorPage, type)] = { title:'', url:'' };
      this._skipDraftStashOnce = true;
      this.renderEditor();
    },

    removeResource(type, chapIdx, itemIdx){
      this.curriculum.chapters[chapIdx][type].splice(itemIdx, 1);
      this.renderEditor();
    },

    updateResource(type, chapIdx, itemIdx, field, val){
      this.curriculum.chapters[chapIdx][type][itemIdx][field] = val;
    },

    projectDraftInputIds(target='practice'){
      const raw = String(target || 'practice');
      if (raw.startsWith('test')) {
        const idx = Math.max(0, parseInt(raw.split(':')[1] || '0', 10) || 0);
        return {
          titleId: `newTestProjTitle-${idx}`,
          sourceId: `newTestProjAddr-${idx}`
        };
      }
      return {
        titleId: 'newProjTitle',
        sourceId: 'newProjAddr'
      };
    },

    flushProjectDraft(chapIdx, target='practice', options={}){
      if (!tutorialProjectsEnabled()) return;
      const ids = this.projectDraftInputIds(target);
      const titleInput = document.getElementById(ids.titleId);
      const sourceInput = document.getElementById(ids.sourceId);
      const name = String(titleInput?.value || '').trim();
      const sourceProjectId = String(sourceInput?.value || '').trim();
      if (!name && !sourceProjectId) return false;
      if (!sourceProjectId) {
        if (!options.silent) alert("Enter a real FirstMeasure Project ID");
        return null;
      }
      const list = this.projectListForChapter(this.curriculum.chapters[chapIdx], target);
      const exists = list.some(p => String(p.project_id || p.source_project_id || p.id || '').trim() === sourceProjectId);
      if (!exists) {
        list.push({
          curriculum_project_id: this.newCurriculumProjectId(),
          name: name || sourceProjectId,
          id: sourceProjectId,
          project_id: sourceProjectId,
          source_project_id: sourceProjectId
        });
      }
      if (titleInput) titleInput.value = '';
      if (sourceInput) sourceInput.value = '';
      return true;
    },

    addProjectToChapter(target='practice'){
      if (!tutorialProjectsEnabled()) return;
      if (this.flushProjectDraft(this.currentEditorPage, target) === null) return;
      this.renderEditor();
    },

    updateProject(chapIdx, itemIdx, field, val, target='practice'){
      if (!tutorialProjectsEnabled()) return;
      const item = this.projectListForChapter(this.curriculum.chapters[chapIdx], target)[itemIdx];
      if (item) item[field] = val;
    },

    removeProject(chapIdx, itemIdx, target='practice'){
      if (!tutorialProjectsEnabled()) return;
      this.projectListForChapter(this.curriculum.chapters[chapIdx], target).splice(itemIdx, 1);
      this.renderEditor();
    },

    async generatePendingProjects(chapIdx, target='practice'){
      if (!tutorialProjectsEnabled()) return;
      if (this.flushProjectDraft(chapIdx, target, { silent: false }) === null) return;
      const projects = this.projectListForChapter(this.curriculum.chapters[chapIdx], target);
      const missing = [];
      projects.forEach((p, idx) => {
        const sourceProjectId = String(p.project_id || p.source_project_id || p.id || '').trim();
        if (!sourceProjectId) missing.push(idx + 1);
        p.id = sourceProjectId;
        p.project_id = sourceProjectId;
        p.source_project_id = sourceProjectId;
        if (!p.curriculum_project_id) p.curriculum_project_id = this.newCurriculumProjectId();
      });
      if (missing.length) return alert(`Missing Project ID for row(s): ${missing.join(', ')}`);
      const testIdx = String(target).startsWith('test') ? (String(target).split(':')[1] || '0') : null;
      const btn = document.getElementById(testIdx !== null ? `btnGenerateTestBatch-${testIdx}` : 'btnGenerateBatch');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...'; }
      await this.saveCurriculum(true);
      if (btn) { btn.disabled = false; btn.innerHTML = testIdx !== null ? '<i class="fas fa-check"></i> Add and Validate Test Pool' : '<i class="fas fa-check"></i> Add and Validate Project IDs'; }
      alert("Project IDs saved.");
      this.renderEditor();
    },

    curriculumManagerCourses(){
      const seen = new Set();
      const out = [];
      tutorialCourseOptions().forEach((course) => {
        const id = String(course?.id || '').trim() || 'default';
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ id, label: String(course?.label || id) });
      });
      if (!seen.has('default')) out.unshift({ id:'default', label:'New Hire Training' });
      return out;
    },

    cloneCurriculumChapter(chap){
      return JSON.parse(JSON.stringify(chap || {}));
    },

    managerCurriculum(courseId){
      const id = String(courseId || 'default');
      const curr = this.curriculumManager.curricula[id];
      if (curr && Array.isArray(curr.chapters)) return curr;
      return { chapters: [] };
    },

    setCurriculumManagerStatus(message, tone=''){
      const text = String(message || '');
      this.curriculumManager.status = text;
      const el = document.getElementById('tutorialCurriculumManagerStatus');
      if (!el) return;
      el.textContent = text;
      el.style.color = tone === 'error' ? '#b42318' : (tone === 'success' ? '#188038' : '#667085');
    },

    async loadCurriculumManagerData(){
      const state = this.curriculumManager;
      state.loading = true;
      state.status = 'Loading curricula...';
      state.courses = this.curriculumManagerCourses();
      state.curricula = {};
      state.dragging = null;
      this.renderCurriculumManager();

      const loaded = await Promise.all(state.courses.map(async (course) => {
        const data = await Portal.apiPost(cfg().endpoints.server, tutorialApiPayloadForCourse(course.id, { action:'fetch_curriculum' })).catch((err) => ({ error: err?.message || 'Load failed' }));
        return { course, data };
      }));

      loaded.forEach(({ course, data }) => {
        const curr = data && data.curriculum && Array.isArray(data.curriculum.chapters)
          ? data.curriculum
          : { chapters: [] };
        state.curricula[course.id] = this.normalizeCurriculumForManager(curr);
      });

      state.loading = false;
      state.status = '';
      this.renderCurriculumManager();
    },

    normalizeCurriculumForManager(curr){
      const out = JSON.parse(JSON.stringify(curr || { chapters: [] }));
      if (!Array.isArray(out.chapters)) out.chapters = [];
      out.chapters = out.chapters.map((chap) => {
        const c = Object.assign({}, chap || {});
        if (typeof c.title !== 'string') c.title = '';
        if (typeof c.description !== 'string') c.description = '';
        if (!Array.isArray(c.videos)) c.videos = [];
        if (!Array.isArray(c.pdfs)) c.pdfs = [];
        if (!Array.isArray(c.projects)) c.projects = [];
        if (!Array.isArray(c.test_projects)) c.test_projects = [];
        if (!Array.isArray(c.tests)) c.tests = [];
        if (!Array.isArray(c.draft_reject_rounds)) c.draft_reject_rounds = [];
        if (!Array.isArray(c.visible_to)) c.visible_to = [];
        if (c.show_videos !== false && c.show_videos !== true) c.show_videos = true;
        if (c.show_pdfs !== false && c.show_pdfs !== true) c.show_pdfs = true;
        c.hidden = !!c.hidden;
        return c;
      });
      return out;
    },

    openCurriculumManager(){
      if (!this.canManageTutorials()) return;
      this.ensureEditorCss();
      let modal = document.getElementById('tutorialCurriculumManagerModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'tutorialCurriculumManagerModal';
        modal.className = 'tut-curriculum-manager-backdrop';
        modal.innerHTML = `
          <div class="tut-curriculum-manager-modal" role="dialog" aria-modal="true" aria-labelledby="tutorialCurriculumManagerTitle">
            <div class="tut-curriculum-manager-head">
              <h3 id="tutorialCurriculumManagerTitle">Curriculum Manager</h3>
              <button type="button" class="tut-curriculum-manager-close" onclick="closeCurriculumManager()" title="Close"><i class="fas fa-times"></i></button>
            </div>
            <div id="tutorialCurriculumManagerBody" class="tut-curriculum-manager-body"></div>
            <div class="tut-curriculum-manager-foot">
              <div id="tutorialCurriculumManagerStatus" class="tut-curriculum-status"></div>
              <div class="tut-curriculum-target-hint">Drag chapters to reorder or move them between curricula. Use Duplicate to copy a chapter first.</div>
            </div>
          </div>
        `;
        modal.addEventListener('click', (ev) => {
          if (ev.target === modal) this.closeCurriculumManager();
        });
        document.body.appendChild(modal);
      }
      modal.classList.add('show');
      this.loadCurriculumManagerData();
    },

    closeCurriculumManager(){
      document.getElementById('tutorialCurriculumManagerModal')?.classList.remove('show');
    },

    renderCurriculumManager(){
      const state = this.curriculumManager;
      const body = document.getElementById('tutorialCurriculumManagerBody');
      if (!body) return;

      if (state.loading && !(state.courses || []).length) {
        body.innerHTML = '<div class="tut-curriculum-empty">Loading curricula...</div>';
        return;
      }

      const busy = !!state.loading || !!state.saving;

      body.innerHTML = `
        <div class="tut-curriculum-board">
          ${(state.courses || []).map((course) => {
            const curr = this.managerCurriculum(course.id);
            const chapters = Array.isArray(curr.chapters) ? curr.chapters : [];
            return `
              <div class="tut-curriculum-column" data-course-id="${Portal.escapeHtml(course.id)}">
                <div class="tut-curriculum-column-head">
                  <div class="tut-curriculum-column-title">${Portal.escapeHtml(course.label)}</div>
                  <div class="tut-curriculum-count">${chapters.length} chapter${chapters.length === 1 ? '' : 's'}</div>
                </div>
                <div class="tut-curriculum-list" ondragover="tutCurriculumDragOver(event)" ondrop="tutCurriculumDrop(event, '${Portal.escapeHtml(course.id)}', null)">
                  ${chapters.length ? chapters.map((chap, idx) => {
                    const title = String(chap.title || `Chapter ${idx + 1}`);
                    const desc = String(chap.description || '').trim();
                    return `
                      <div class="tut-curriculum-chapter" draggable="${busy ? 'false' : 'true'}" data-course-id="${Portal.escapeHtml(course.id)}" data-chapter-idx="${idx}" onpointerdown="tutCurriculumPointerDown(event, '${Portal.escapeHtml(course.id)}', ${idx})" ondragstart="tutCurriculumDragStart(event, '${Portal.escapeHtml(course.id)}', ${idx})" ondragend="tutCurriculumDragEnd(event)" ondragover="tutCurriculumDragOver(event)" ondrop="tutCurriculumDrop(event, '${Portal.escapeHtml(course.id)}', ${idx})">
                        <div class="tut-curriculum-chapter-title"><i class="fas fa-grip-vertical" style="color:#98a2b3; margin-right:6px;"></i>${idx + 1}. ${Portal.escapeHtml(title)}</div>
                        <div class="tut-curriculum-chapter-desc">${desc ? Portal.escapeHtml(desc) : 'No description'}</div>
                        <div class="tut-curriculum-chapter-actions">
                          <button type="button" class="tut-curriculum-copy-btn" ${busy ? 'disabled' : ''} onpointerdown="event.stopPropagation()" onclick="duplicateCurriculumManagerChapter('${Portal.escapeHtml(course.id)}', ${idx})">
                            <i class="fas fa-copy"></i> Duplicate
                          </button>
                        </div>
                      </div>
                    `;
                  }).join('') : '<div class="tut-curriculum-empty">Drop chapters here</div>'}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
      this.setCurriculumManagerStatus(state.status || '');
    },

    curriculumManagerCourseLabel(courseId){
      const found = (this.curriculumManager.courses || []).find(c => c.id === courseId);
      return found?.label || courseId || 'curriculum';
    },

    async saveCurriculumManagerCourse(courseId){
      const curr = this.managerCurriculum(courseId);
      const result = await Portal.apiPost(cfg().endpoints.server, tutorialApiPayloadForCourse(courseId, {
        action:'save_curriculum',
        curriculum: JSON.stringify(curr, null, 2)
      }));
      if (result && result.error) throw new Error(result.error);
    },

    syncVisibleCourseFromManager(courseId){
      if (String(courseId || '') !== tutorialCourseId()) return;
      this.curriculum = this.normalizeCurriculumForManager(this.managerCurriculum(courseId));
      this.normalizeCurriculumAndProgress();
      this.rebuildViewChapters();
      this.renderChapters();
      if (document.getElementById('editorModal')?.style.display === 'flex') this.renderEditor();
    },

    async duplicateCurriculumManagerChapter(courseId, chapterIdx){
      const state = this.curriculumManager;
      if (state.loading || state.saving) return;
      const id = String(courseId || 'default');
      const curr = this.managerCurriculum(id);
      const idx = Math.max(0, Number(chapterIdx) || 0);
      const chap = curr.chapters[idx];
      if (!chap) return this.setCurriculumManagerStatus('That chapter is no longer available.', 'error');
      curr.chapters.splice(idx + 1, 0, this.cloneCurriculumChapter(chap));
      state.curricula[id] = curr;
      state.saving = true;
      this.setCurriculumManagerStatus(`Duplicating in ${this.curriculumManagerCourseLabel(id)}...`);
      this.renderCurriculumManager();
      try {
        await this.saveCurriculumManagerCourse(id);
        this.syncVisibleCourseFromManager(id);
        this.setCurriculumManagerStatus(`Duplicated "${chap.title || 'Untitled Chapter'}".`, 'success');
      } catch (err) {
        curr.chapters.splice(idx + 1, 1);
        this.setCurriculumManagerStatus(err?.message || 'Duplicate failed.', 'error');
      } finally {
        state.saving = false;
        this.renderCurriculumManager();
      }
    },

    curriculumManagerDragStart(ev, courseId, chapterIdx){
      const state = this.curriculumManager;
      if (state.loading || state.saving) {
        ev.preventDefault();
        return;
      }
      const payload = { courseId: String(courseId || 'default'), chapterIdx: Math.max(0, Number(chapterIdx) || 0) };
      state.dragging = payload;
      ev.currentTarget?.classList?.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', JSON.stringify(payload));
    },

    curriculumManagerDragEnd(ev){
      ev.currentTarget?.classList?.remove('dragging');
      document.querySelectorAll('.tut-curriculum-column.drag-over').forEach(el => el.classList.remove('drag-over'));
    },

    curriculumManagerDragOver(ev){
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const col = ev.currentTarget?.closest?.('.tut-curriculum-column');
      if (col) col.classList.add('drag-over');
    },

    async curriculumManagerDrop(ev, targetCourseId, targetChapterIdx=null){
      ev.preventDefault();
      ev.stopPropagation();
      document.querySelectorAll('.tut-curriculum-column.drag-over').forEach(el => el.classList.remove('drag-over'));
      const state = this.curriculumManager;
      if (state.loading || state.saving) return;

      let payload = state.dragging;
      try {
        payload = JSON.parse(ev.dataTransfer.getData('text/plain') || '{}') || payload;
      } catch {}
      const sourceCourseId = String(payload?.courseId || '');
      const sourceIdx = Number(payload?.chapterIdx);
      const targetId = String(targetCourseId || 'default');
      if (!sourceCourseId || !Number.isFinite(sourceIdx)) return;
      let insertIdx = targetChapterIdx === null || targetChapterIdx === undefined
        ? null
        : Math.max(0, Number(targetChapterIdx) || 0);
      const targetCard = ev.currentTarget?.closest?.('.tut-curriculum-chapter');
      if (targetCard && insertIdx !== null) {
        const rect = targetCard.getBoundingClientRect();
        if (ev.clientY > rect.top + rect.height / 2) insertIdx += 1;
      }
      await this.moveCurriculumManagerChapter(sourceCourseId, sourceIdx, targetId, insertIdx);
    },

    curriculumManagerPointerDown(ev, courseId, chapterIdx){
      const state = this.curriculumManager;
      if (state.loading || state.saving || ev.button !== 0) return;
      if (ev.target?.closest?.('button')) return;
      const card = ev.currentTarget;
      const sourceCourseId = String(courseId || 'default');
      const sourceIdx = Math.max(0, Number(chapterIdx) || 0);
      const startX = ev.clientX;
      const startY = ev.clientY;
      let moved = false;

      const onMove = (moveEv) => {
        if (!moved && Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY) > 5) {
          moved = true;
          card.classList.add('dragging');
          document.body.style.cursor = 'grabbing';
        }
      };

      const onUp = (upEv) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        card.classList.remove('dragging');
        document.body.style.cursor = '';
        if (!moved) return;

        const el = document.elementFromPoint(upEv.clientX, upEv.clientY);
        const targetCard = el?.closest?.('.tut-curriculum-chapter');
        const targetList = el?.closest?.('.tut-curriculum-list');
        const targetColumn = el?.closest?.('.tut-curriculum-column');
        const targetCourseId = targetCard?.dataset?.courseId || targetColumn?.dataset?.courseId || targetList?.closest?.('.tut-curriculum-column')?.dataset?.courseId || '';
        if (!targetCourseId) return;

        let insertIdx = null;
        if (targetCard) {
          insertIdx = Math.max(0, Number(targetCard.dataset.chapterIdx) || 0);
          const rect = targetCard.getBoundingClientRect();
          if (upEv.clientY > rect.top + rect.height / 2) insertIdx += 1;
        }
        this.moveCurriculumManagerChapter(sourceCourseId, sourceIdx, targetCourseId, insertIdx);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },

    async moveCurriculumManagerChapter(sourceCourseId, sourceIdx, targetId, targetChapterIdx=null){
      const state = this.curriculumManager;
      if (state.loading || state.saving) return;
      const sourceCurr = this.managerCurriculum(sourceCourseId);
      const targetCurr = this.managerCurriculum(targetId);
      const moving = sourceCurr.chapters[sourceIdx];
      if (!moving) return;

      let insertIdx = targetChapterIdx === null || targetChapterIdx === undefined
        ? targetCurr.chapters.length
        : Math.max(0, Number(targetChapterIdx) || 0);
      if (sourceCourseId === targetId && insertIdx === sourceIdx) return;

      const [removed] = sourceCurr.chapters.splice(sourceIdx, 1);
      if (sourceCourseId === targetId && insertIdx > sourceIdx) insertIdx -= 1;
      targetCurr.chapters.splice(Math.min(insertIdx, targetCurr.chapters.length), 0, removed);
      state.curricula[sourceCourseId] = sourceCurr;
      state.curricula[targetId] = targetCurr;

      state.dragging = null;
      state.saving = true;
      this.setCurriculumManagerStatus(`Saving chapter move...`);
      this.renderCurriculumManager();
      try {
        if (sourceCourseId === targetId) {
          await this.saveCurriculumManagerCourse(targetId);
        } else {
          await Promise.all([this.saveCurriculumManagerCourse(sourceCourseId), this.saveCurriculumManagerCourse(targetId)]);
        }
        this.syncVisibleCourseFromManager(sourceCourseId);
        this.syncVisibleCourseFromManager(targetId);
        this.setCurriculumManagerStatus(`Moved "${removed.title || 'Untitled Chapter'}".`, 'success');
      } catch (err) {
        await this.loadCurriculumManagerData();
        this.setCurriculumManagerStatus(err?.message || 'Move failed.', 'error');
        return;
      } finally {
        state.saving = false;
        this.renderCurriculumManager();
      }
    },

    addEditorChapter(){
      this.curriculum.chapters.push({
        title:"New Chapter",
        description:"",
        videos:[],
        projects:tutorialProjectsEnabled() ? [] : [],
        tests:[],
        draft_reject_rounds:[],
        pdfs:[],
        hidden:false,
        visible_to:[],
        show_videos:true,
        show_pdfs:true
      });
      this.currentEditorPage = this.curriculum.chapters.length - 1;
      this.renderEditor();
    },

    removeEditorChapter(idx){
      if (!confirm("Delete this chapter?")) return;
      this.curriculum.chapters.splice(idx, 1);
      this.currentEditorPage = Math.max(0, this.currentEditorPage - 1);
      this.renderEditor();
    },

    async saveCurriculum(silent=false){
      this.stashResourceDrafts();
      this.flushPendingResourceDrafts(this.currentEditorPage);
      await Portal.apiPost(cfg().endpoints.server, {
        action:'save_curriculum',
        curriculum: JSON.stringify(this.curriculum, null, 2),
        course_id: tutorialCourseId()
      }).catch(()=>{});

      if (!silent) {
        alert("Curriculum Saved");
        Portal.closeModal('editorModal');
        this.fetchTutorials();
      }
    }
  };

  window.Tutorials = Tutorials;
  window.openTutorialProjectAudit = (email, tutorialId) => Tutorials.openProjectGradingAudit(email, tutorialId);
})();
