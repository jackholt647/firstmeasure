/* public/libraries/apps/training/studio.js
 * Training Studio — the desktop curriculum builder. Each course owns its
 * lessons, flashcard decks, and practice quizzes, edited through a tabbed
 * workspace with a live mobile preview.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!runtime || !Portal) return;

  const clean = (value) => String(value ?? '').trim();
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => runtime.escapeHtml ? runtime.escapeHtml(value) : clean(value).replace(/[&<>"']/g, '');
  const orgId = (context = {}) => clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const showToast = (title, message, ok = true) => Portal.ui?.showToast?.(title, message, ok);
  const statusError = (error, fallback) => clean(error?.data?.message || error?.message || fallback || 'Something went wrong.');
  let idCounter = 0;
  const localId = (prefix) => `${prefix}_local_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

  const STEP_LIBRARY = [
    { kind: 'content', label: (globalThis.PlatformLanguage?.text("training","m_12873470ed5050","Content page") ?? "Content page"), icon: 'fa-file-lines', hint: 'Text, images, galleries, video, documents' },
    { kind: 'quiz', label: (globalThis.PlatformLanguage?.text("training","m_aeef2847f8a286","Quiz") ?? "Quiz"), icon: 'fa-circle-question', hint: 'Multiple choice and typed answers' },
    { kind: 'flashcards', label: (globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards"), icon: 'fa-layer-group', hint: 'One of this course\'s decks, as practice or a test' }
  ];
  const ICON_CHOICES = ['fa-book-open','fa-graduation-cap','fa-helmet-safety','fa-toolbox','fa-hammer','fa-layer-group','fa-house-chimney','fa-clipboard-check','fa-handshake','fa-brain','fa-door-open','fa-comments','fa-file-signature','fa-flag-checkered','fa-bolt','fa-bullseye','fa-star','fa-truck','fa-screwdriver-wrench','fa-people-group'];
  const COLOR_CHOICES = ['#3b6ef6','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316','#64748b','#16a34a'];

  const css = `
    .sty-shell{--sty-ink:#16213a;--sty-muted:#69718a;--sty-line:#e4e7f0;--sty-bg:#f5f6fa;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--sty-bg);color:var(--sty-ink);font-family:inherit;overflow:hidden}
    .sty-top{flex:none;display:flex;align-items:center;gap:12px;padding:12px clamp(14px,2vw,26px);border-bottom:1px solid var(--sty-line);background:#fff;flex-wrap:wrap}
    .sty-top h1{margin:0;font-size:16px;font-weight:1000;display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:nowrap}
    .sty-top h1 span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-crumb{color:var(--sty-muted);font-weight:900;cursor:pointer;flex:none}
    .sty-crumb:hover{color:var(--primary,#3b6ef6)}
    .sty-top-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .sty-subtabs{flex:none;display:flex;gap:4px;padding:10px clamp(14px,2vw,26px) 0;background:#fff;border-bottom:1px solid var(--sty-line)}
    .sty-subtab{border:0;border-bottom:3px solid transparent;background:transparent;color:var(--sty-muted);padding:9px 14px 12px;font:inherit;font-size:12.5px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
    .sty-subtab:hover{color:var(--sty-ink)}
    .sty-subtab.active{color:var(--primary,#3b6ef6);border-bottom-color:var(--primary,#3b6ef6)}
    .sty-subtab .sty-count{min-width:20px;height:20px;border-radius:99px;background:#eef0f6;color:#5a6382;display:inline-grid;place-items:center;font-size:10px;padding:0 6px}
    .sty-subtab.active .sty-count{background:color-mix(in srgb,var(--primary,#3b6ef6) 14%,#fff);color:var(--primary,#3b6ef6)}
    .sty-body{flex:1;min-height:0;overflow:auto;padding:clamp(14px,2vw,24px);box-sizing:border-box}
    .sty-btn{min-height:38px;border:1px solid var(--sty-line);border-radius:11px;background:#fff;color:#3a4260;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;box-sizing:border-box;transition:border-color .12s,color .12s;white-space:nowrap}
    .sty-btn:hover{border-color:var(--primary,#3b6ef6);color:var(--primary,#3b6ef6)}
    .sty-btn.primary{background:var(--primary,#3b6ef6);border-color:transparent;color:#fff}
    .sty-btn.primary:hover{filter:brightness(1.06);color:#fff}
    .sty-btn.danger{color:#b42318}.sty-btn.danger:hover{border-color:#e5484d;color:#e5484d}
    .sty-btn:disabled{opacity:.5;cursor:not-allowed}
    .sty-icon-btn{width:30px;height:30px;border:1px solid var(--sty-line);border-radius:9px;background:#fff;color:#69718a;display:inline-grid;place-items:center;cursor:pointer;font-size:11px;flex:none}
    .sty-icon-btn:hover{border-color:var(--primary,#3b6ef6);color:var(--primary,#3b6ef6)}
    .sty-icon-btn.danger:hover{border-color:#e5484d;color:#e5484d}
    .sty-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
    .sty-card{border:1px solid var(--sty-line);border-radius:18px;background:#fff;padding:17px;display:grid;gap:11px;text-align:left;font:inherit;color:inherit;cursor:pointer;box-shadow:0 6px 18px rgba(22,33,58,.05);transition:transform .13s,box-shadow .13s;min-width:0}
    .sty-card:hover{transform:translateY(-2px);box-shadow:0 14px 28px rgba(22,33,58,.1)}
    .sty-card-head{display:flex;align-items:center;gap:12px;min-width:0}
    .sty-card-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-size:19px;color:#fff;background:var(--primary,#3b6ef6);flex:none}
    .sty-card-head strong{font-size:14.5px;font-weight:1000}
    .sty-card-head small{display:block;margin-top:2px;color:var(--sty-muted);font-size:11px;font-weight:850}
    .sty-card p{margin:0;color:#4a5372;font-size:12px;font-weight:750;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px}
    .sty-card-foot{display:flex;gap:6px;flex-wrap:wrap}
    .sty-pill{display:inline-flex;align-items:center;gap:5px;border-radius:99px;background:#f0f2f9;color:#4a5372;padding:5px 10px;font-size:10px;font-weight:1000;white-space:nowrap}
    .sty-pill.green{background:#e3f8ec;color:#137a45}.sty-pill.gray{background:#eef0f5;color:#7a8299}.sty-pill.gold{background:#fdf3d7;color:#8a6400}
    .sty-new-card{border:2px dashed #cdd4e4;border-radius:18px;background:transparent;display:grid;place-items:center;min-height:150px;color:var(--sty-muted);font:inherit;font-size:13px;font-weight:1000;cursor:pointer;gap:8px}
    .sty-new-card:hover{border-color:var(--primary,#3b6ef6);color:var(--primary,#3b6ef6)}
    .sty-state{min-height:160px;display:grid;place-items:center;color:var(--sty-muted);text-align:center;font-size:13px;font-weight:850;padding:20px}
    .sty-spinner{width:26px;height:26px;border:3px solid #e2e6f2;border-top-color:var(--primary,#3b6ef6);border-radius:999px;animation:sty-spin .75s linear infinite;margin:0 auto 10px}
    @keyframes sty-spin{to{transform:rotate(360deg)}}

    /* Workspace layouts */
    .sty-lessons-layout{display:grid;grid-template-columns:248px minmax(0,1fr) 352px;gap:16px;align-items:start}
    .sty-lessons-layout>*{min-width:0}
    .sty-lessons-col{position:sticky;top:0;max-height:calc(100dvh - 205px);overflow:auto;min-width:0}
    @media(max-width:1400px){.sty-lessons-layout{grid-template-columns:236px minmax(0,1fr)}.sty-lessons-layout .sty-preview-col{display:none}}
    @media(max-width:940px){.sty-lessons-layout{grid-template-columns:1fr}.sty-lessons-col{position:static;max-height:none}}
    .sty-two-col{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;align-items:start}
    .sty-two-col>*{min-width:0}
    @media(max-width:1000px){.sty-two-col{grid-template-columns:1fr}}
    .sty-settings-wrap{width:min(660px,100%);margin:0 auto}
    .sty-panel{border:1px solid var(--sty-line);border-radius:16px;background:#fff;box-shadow:0 6px 18px rgba(22,33,58,.05);min-width:0}
    .sty-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid #eef0f6}
    .sty-panel-head h3{margin:0;font-size:12px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#4a5372;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-panel-body{padding:14px 15px;display:grid;gap:12px;min-width:0}
    .sty-lesson-item{display:flex;align-items:center;gap:8px;border:1px solid var(--sty-line);border-radius:12px;background:#fff;padding:9px 10px;cursor:pointer;font:inherit;text-align:left;color:inherit;width:100%;box-sizing:border-box;min-width:0}
    .sty-lesson-item.active{border-color:var(--primary,#3b6ef6);background:color-mix(in srgb,var(--primary,#3b6ef6) 6%,#fff)}
    .sty-lesson-item .sty-lesson-title{flex:1;min-width:0;font-size:12px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-lesson-item small{color:var(--sty-muted);font-size:9.5px;font-weight:900;white-space:nowrap}
    .sty-list-row{display:flex;align-items:center;gap:10px;border:1px solid var(--sty-line);border-radius:13px;background:#fff;padding:11px 12px;cursor:pointer;font:inherit;text-align:left;color:inherit;width:100%;box-sizing:border-box;min-width:0}
    .sty-list-row.active{border-color:var(--primary,#3b6ef6);background:color-mix(in srgb,var(--primary,#3b6ef6) 6%,#fff)}
    .sty-list-row .sty-list-icon{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-size:14px;color:#fff;background:var(--primary,#3b6ef6);flex:none}
    .sty-list-row .sty-list-copy{flex:1;min-width:0}
    .sty-list-row strong{display:block;font-size:12.5px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-list-row span{display:block;margin-top:2px;color:var(--sty-muted);font-size:10.5px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-field{display:grid;gap:5px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:var(--sty-muted);min-width:0}
    .sty-field input,.sty-field select,.sty-field textarea{width:100%;box-sizing:border-box;border:1px solid #d4d9e6;border-radius:10px;background:#fff;color:var(--sty-ink);padding:9px 11px;font:inherit;font-size:12.5px;font-weight:800;text-transform:none;letter-spacing:0;outline:none;min-width:0}
    .sty-field textarea{min-height:70px;resize:vertical;line-height:1.5}
    .sty-field input:focus,.sty-field select:focus,.sty-field textarea:focus{border-color:var(--primary,#3b6ef6);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary,#3b6ef6) 12%,transparent)}
    .sty-field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;min-width:0}
    .sty-check{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:900;color:#3a4260;text-transform:none;letter-spacing:0;cursor:pointer}
    .sty-check input{width:16px;height:16px;accent-color:var(--primary,#3b6ef6);flex:none}
    .sty-swatches{display:flex;gap:6px;flex-wrap:wrap}
    .sty-swatch{width:26px;height:26px;border-radius:9px;border:2px solid transparent;cursor:pointer;padding:0}
    .sty-swatch.active{border-color:#16213a;box-shadow:0 0 0 2px #fff inset}
    .sty-icon-choices{display:flex;gap:5px;flex-wrap:wrap}
    .sty-icon-choice{width:30px;height:30px;border:1px solid var(--sty-line);border-radius:9px;background:#fff;color:#5a6382;display:grid;place-items:center;cursor:pointer;font-size:12px}
    .sty-icon-choice.active{border-color:var(--primary,#3b6ef6);color:var(--primary,#3b6ef6);background:color-mix(in srgb,var(--primary,#3b6ef6) 8%,#fff)}
    .sty-step-card{border:1px solid var(--sty-line);border-radius:14px;background:#fbfcfe;min-width:0}
    .sty-step-head{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;min-width:0}
    .sty-step-head i.kind{width:32px;height:32px;border-radius:10px;background:#fff;border:1px solid var(--sty-line);color:var(--primary,#3b6ef6);display:grid;place-items:center;font-size:13px;flex:none}
    .sty-step-head strong{flex:1;min-width:0;font-size:12.5px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sty-step-head .sty-step-tools{display:flex;gap:5px;flex:none}
    .sty-step-body{border-top:1px solid #eef0f6;padding:13px;display:grid;gap:12px;min-width:0}
    .sty-block-card{border:1px solid var(--sty-line);border-radius:12px;background:#fff;padding:11px;display:grid;gap:9px;min-width:0}
    .sty-block-bar{display:flex;align-items:center;gap:8px}
    .sty-block-bar select{border:1px solid #d4d9e6;border-radius:8px;padding:6px 8px;font:inherit;font-size:11px;font-weight:900;background:#fff}
    .sty-block-bar .sty-block-tools{margin-left:auto;display:flex;gap:5px}
    .sty-q-card{border:1px solid var(--sty-line);border-radius:12px;background:#fff;padding:12px;display:grid;gap:10px;min-width:0}
    .sty-q-num{font-size:10px;font-weight:1000;color:var(--sty-muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
    .sty-hint{font-size:10.5px;font-weight:800;color:#8a92ab;text-transform:none;letter-spacing:0;line-height:1.45}
    .sty-add-row{display:flex;gap:8px;flex-wrap:wrap}

    /* Phone preview */
    .sty-preview-col{position:sticky;top:0;display:grid;justify-items:center;min-width:0}
    .sty-phone{width:min(336px,var(--sty-phone-width,336px),100%);height:auto;min-height:0;aspect-ratio:14/29;border-radius:36px;background:#0d1220;padding:10px;box-shadow:0 24px 60px rgba(13,18,32,.35);position:relative;box-sizing:border-box}
    .sty-phone:before{content:'';position:absolute;top:19px;left:50%;transform:translateX(-50%);width:96px;height:18px;border-radius:99px;background:#0d1220;z-index:3}
    .sty-phone-screen{width:100%;height:100%;border-radius:27px;background:#fff;overflow:hidden;display:flex;flex-direction:column}
    .sty-phone-screen .sty-phone-head{flex:none;padding:30px 16px 8px;display:flex;align-items:center;gap:10px;min-width:0}
    .sty-phone-screen .sty-phone-body{flex:1;min-height:0;overflow:auto}
    .sty-url-row{display:flex;gap:6px;min-width:0}
    .sty-url-row input,.sty-url-row textarea{flex:1;min-width:0}
    .sty-upload-btn{min-height:0;padding:0 11px;flex:none;align-self:stretch}

    /* Dialog */
    .sty-modal-back{position:fixed;inset:0;z-index:2147483520;background:rgba(16,22,42,.5);backdrop-filter:blur(5px);display:grid;place-items:center;padding:20px}
    .sty-modal{width:min(760px,100%);max-height:min(85dvh,780px);overflow:auto;border-radius:20px;background:#fff;padding:22px;box-sizing:border-box;display:grid;gap:16px;position:relative;box-shadow:0 30px 80px rgba(13,18,32,.35)}
    .sty-modal h2{margin:0;font-size:19px;font-weight:1000;padding-right:40px}
    .sty-modal-close{position:absolute;right:14px;top:14px;width:34px;height:34px;border:0;border-radius:11px;background:#f0f2f8;color:#5a6382;display:grid;place-items:center;cursor:pointer}
    .sty-table{width:100%;border-collapse:collapse;font-size:12px}
    .sty-table th{padding:8px 9px;text-align:left;color:var(--sty-muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--sty-line);white-space:nowrap}
    .sty-table td{padding:9px;border-bottom:1px solid #f0f2f7;font-weight:850;vertical-align:middle}
    .sty-progress-cell{width:26px;height:26px;border-radius:9px;display:inline-grid;place-items:center;font-size:11px}
    .sty-progress-cell.done{background:#e3f8ec;color:#137a45}
    .sty-progress-cell.open{background:#eef0f5;color:#aab2c8}
    .sty-progress-cell.unlockable{background:#fdf3d7;color:#8a6400;cursor:pointer;border:0;font:inherit}
    .sty-dirty-dot{width:9px;height:9px;border-radius:99px;background:#f59e0b;display:inline-block;margin-left:6px;vertical-align:middle;flex:none}
  `;
  Portal.util?.injectCSS?.('training_studio', css);

  const stateHtml = (message = 'Loading', spinner = true) => `<div class="sty-state"><div>${spinner ? '<div class="sty-spinner"></div>' : ''}${esc(message)}</div></div>`;

  function modal(contentHtml, options = {}){
    const back = document.createElement('div');
    back.className = 'sty-modal-back';
    back.innerHTML = `<div class="sty-modal" role="dialog" aria-modal="true">${String(contentHtml)}<button type="button" class="sty-modal-close" aria-label="${(globalThis.PlatformLanguage?.text("training","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); options.onClose?.(); };
    back.querySelector('.sty-modal-close').addEventListener('click', close);
    back.addEventListener('click', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    return { el: back, close };
  }

  const confirmAction = async (message) => {
    if (Portal.ui?.confirm) return Portal.ui.confirm(message);
    return window.confirm(message);
  };

  /* Choice text helpers: textarea, one per line, "*" prefix = correct. */
  const choicesToText = (question) => arr(question.choices).map((choice) => `${arr(question.correct_choice_ids).includes(clean(choice.id)) ? '*' : ''}${clean(choice.text)}`).join('\n');
  const textToChoices = (text, seed) => {
    const lines = clean(text).split('\n').map((line) => line.trim()).filter(Boolean);
    const choices = [];
    const correct = [];
    lines.forEach((line, index) => {
      const isCorrect = line.startsWith('*');
      const id = `${seed}_c${index + 1}`;
      choices.push({ id, text: isCorrect ? line.slice(1).trim() : line, image: '' });
      if (isCorrect) correct.push(id);
    });
    return { choices, correct_choice_ids: correct };
  };

  /* ============================================================ STUDIO */
  function mountStudio(root, context = {}){
    let destroyed = false;
    let view = { name: 'library' };
    let courseTab = 'lessons';
    let courses = null;
    let assignmentsCache = null;
    let usersCache = null;
    let rolesCache = null;
    let draft = null;             // course being edited (deep copy)
    let draftDirty = false;
    let selectedLessonIndex = 0;
    let selectedStepIndex = 0;
    let courseDecks = null;       // decks belonging to the open course
    let courseQuizzes = null;
    let deckDraft = null;         // deck being edited within the course
    let deckDirty = false;
    let quizDraft = null;
    let quizDirty = false;

    root.innerHTML = `<div class="sty-shell"><div class="sty-top" data-studio-top></div><div data-studio-subtabs></div><div class="sty-body" data-studio-body></div></div>`;
    const topEl = root.querySelector('[data-studio-top]');
    const subtabsEl = root.querySelector('[data-studio-subtabs]');
    const bodyEl = root.querySelector('[data-studio-body]');

    /* Size the complete phone (including its frame padding) from the editor's
     * real scroll viewport. Keeping width as the only variable lets the aspect
     * ratio scale the device without the old independent height constraint. */
    let previewResizeFrame = 0;
    const syncPreviewSize = () => {
      cancelAnimationFrame(previewResizeFrame);
      previewResizeFrame = requestAnimationFrame(() => {
        if (destroyed) return;
        const bodyStyle = getComputedStyle(bodyEl);
        const verticalPadding = (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0);
        const availableHeight = Math.max(0, bodyEl.clientHeight - verticalPadding);
        const phoneWidth = Math.min(336, availableHeight * 14 / 29);
        bodyEl.style.setProperty('--sty-phone-width', `${phoneWidth}px`);
      });
    };
    const previewResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(syncPreviewSize) : null;
    previewResizeObserver?.observe(bodyEl);
    window.addEventListener('resize', syncPreviewSize);
    syncPreviewSize();

    const api = () => window.TrainingAPI;
    const anyDirty = () => draftDirty || deckDirty || quizDirty;

    async function loadUsersAndRoles(){
      if (usersCache && rolesCache) return;
      try {
        const [usersResult, rolesResult] = await Promise.all([
          window.CrewAPI?.request?.(`/organizations/${encodeURIComponent(orgId(context))}/users`) || Promise.resolve({}),
          window.CrewAPI?.access?.roles?.(orgId(context)) || Promise.resolve({})
        ]);
        usersCache = arr(usersResult.users || usersResult.profiles).map((user) => ({
          id: clean(obj(user).id || obj(user).user_id),
          name: clean(obj(user).name || obj(user).display_name || obj(user).full_name || obj(user).email || 'Team member')
        })).filter((user) => user.id);
        rolesCache = arr(rolesResult.roles).map((role) => ({ id: clean(obj(role).id), name: clean(obj(role).name || obj(role).title || obj(role).id) })).filter((role) => role.id);
      } catch (_) {
        usersCache = usersCache || [];
        rolesCache = rolesCache || [];
      }
    }
    const userName = (userId) => (usersCache || []).find((user) => user.id === clean(userId))?.name || clean(userId) || 'Unknown user';
    const roleName = (roleId) => (rolesCache || []).find((role) => role.id === clean(roleId))?.name || clean(roleId);

    /* ------------------------------------------------------------- top bar */
    const renderTop = () => {
      if (view.name === 'library') {
        topEl.innerHTML = `<h1><i class="fas fa-chalkboard-user" style="color:var(--primary,#3b6ef6)"></i><span>${(globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio")}</span></h1>
          <div class="sty-top-actions"><span class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_76bd8af197b721","Every course carries its own lessons, flashcard decks, and quizzes. Learners see them in the Training tab.") ?? "Every course carries its own lessons, flashcard decks, and quizzes. Learners see them in the Training tab.")}</span></div>`;
        subtabsEl.innerHTML = '';
        return;
      }
      const editingItem = courseTab === 'flashcards' && deckDraft ? deckDraft : (courseTab === 'quizzes' && quizDraft ? quizDraft : null);
      topEl.innerHTML = `<h1>
          <span class="sty-crumb" data-studio-back><i class="fas fa-arrow-left" style="margin-right:8px"></i>${(globalThis.PlatformLanguage?.text("training","m_38bf96aa90f8b3","Courses") ?? "Courses")}</span>
          <i class="fas fa-chevron-right" style="font-size:10px;color:#c2c8da"></i>
          ${String(editingItem ? `<span class="sty-crumb" data-item-back>${esc(clean(draft?.title) || 'Untitled')}</span><i class="fas fa-chevron-right" style="font-size:10px;color:#c2c8da"></i><span>${esc(clean(editingItem.title) || 'Untitled')}</span>` : `<span>${esc(clean(draft?.title) || 'Untitled course')}</span>`)}
          ${String(anyDirty() ? '<span class="sty-dirty-dot" title="Unsaved changes"></span>' : '')}
        </h1>
        <div class="sty-top-actions">
          <button type="button" class="sty-btn" data-course-assign><i class="fas fa-user-plus"></i>${(globalThis.PlatformLanguage?.text("training","m_7be9325277c249"," Assignments") ?? " Assignments")}</button>
          <button type="button" class="sty-btn" data-course-progress><i class="fas fa-chart-simple"></i>${(globalThis.PlatformLanguage?.text("training","m_d0a5993c14f476"," Progress") ?? " Progress")}</button>
          <button type="button" class="sty-btn" data-course-preview><i class="fas fa-mobile-screen"></i>${(globalThis.PlatformLanguage?.text("training","m_b132d62f39f2bd"," Preview lesson") ?? " Preview lesson")}</button>
          <button type="button" class="sty-btn primary" data-studio-save><i class="fas fa-floppy-disk"></i>${((v2) => globalThis.PlatformLanguage?.text("training","m_d674f42f813a84",` Save${v2}`,{v2}) ?? ` Save${v2}`)(anyDirty() ? ' changes' : 'd')}</button>
        </div>`;
      const tabButton = (id, label, icon, count) => `<button type="button" class="sty-subtab ${courseTab === id ? 'active' : ''}" data-course-tab="${id}"><i class="fas ${icon}"></i>${label}${count != null ? `<span class="sty-count">${count}</span>` : ''}</button>`;
      subtabsEl.innerHTML = `<div class="sty-subtabs">
        ${tabButton('lessons', 'Lessons', 'fa-map', arr(draft?.lessons).length)}
        ${tabButton('flashcards', 'Flashcard decks', 'fa-layer-group', courseDecks ? courseDecks.length : null)}
        ${tabButton('quizzes', 'Practice quizzes', 'fa-bolt', courseQuizzes ? courseQuizzes.length : null)}
        ${tabButton('settings', 'Course settings', 'fa-sliders', null)}
      </div>`;
      subtabsEl.querySelectorAll('[data-course-tab]').forEach((button) => button.addEventListener('click', () => {
        if (courseTab === button.dataset.courseTab) return;
        courseTab = button.dataset.courseTab;
        render();
      }));
      topEl.querySelector('[data-studio-back]').addEventListener('click', async () => {
        if (anyDirty() && !(await confirmAction('Discard unsaved changes?'))) return;
        view = { name: 'library' };
        draft = deckDraft = quizDraft = null;
        courseDecks = courseQuizzes = null;
        draftDirty = deckDirty = quizDirty = false;
        courseTab = 'lessons';
        render();
      });
      topEl.querySelector('[data-item-back]')?.addEventListener('click', async () => {
        const dirty = courseTab === 'flashcards' ? deckDirty : quizDirty;
        if (dirty && !(await confirmAction('Discard unsaved changes to this item?'))) return;
        if (courseTab === 'flashcards') { deckDraft = null; deckDirty = false; }
        else { quizDraft = null; quizDirty = false; }
        render();
      });
      topEl.querySelector('[data-studio-save]').addEventListener('click', () => void saveCurrent());
      topEl.querySelector('[data-course-assign]').addEventListener('click', () => void openAssignments());
      topEl.querySelector('[data-course-progress]').addEventListener('click', () => void openProgress());
      topEl.querySelector('[data-course-preview]').addEventListener('click', () => {
        const lesson = obj(arr(draft?.lessons)[selectedLessonIndex]);
        if (window.TrainingViewer?.previewLesson) window.TrainingViewer.previewLesson(context, draft, lesson);
        else showToast((globalThis.PlatformLanguage?.text("training","m_afff48796c3165","Preview") ?? "Preview"), (globalThis.PlatformLanguage?.text("training","m_8cbe5607fb902e","The Training viewer bundle is not loaded.") ?? "The Training viewer bundle is not loaded."), false);
      });
    };

    const markDirty = (what = 'course') => {
      if (what === 'course') draftDirty = true;
      if (what === 'deck') deckDirty = true;
      if (what === 'quiz') quizDirty = true;
      renderTop();
    };

    async function saveCurrent(){
      try {
        if (draft && draftDirty) {
          const isNew = !clean(draft.id);
          const result = isNew
            ? await api().manage.createCourse(orgId(context), { ...draft, id: '' })
            : await api().manage.saveCourse(orgId(context), clean(draft.id), { ...draft, expected_revision: Number(draft.revision || 0) });
          draft = JSON.parse(JSON.stringify(obj(result.course)));
          draftDirty = false;
          courses = null;
        }
        if (deckDraft && deckDirty) {
          const payload = { ...deckDraft, course_id: clean(draft?.id), expected_revision: Number(deckDraft.revision || 0) };
          const result = clean(deckDraft.id)
            ? await api().manage.saveDeck(orgId(context), clean(deckDraft.id), payload)
            : await api().manage.createDeck(orgId(context), { ...payload, id: '' });
          deckDraft = JSON.parse(JSON.stringify(obj(result.deck)));
          deckDirty = false;
          courseDecks = null;
        }
        if (quizDraft && quizDirty) {
          const payload = { ...quizDraft, course_id: clean(draft?.id), expected_revision: Number(quizDraft.revision || 0) };
          const result = clean(quizDraft.id)
            ? await api().manage.saveQuiz(orgId(context), clean(quizDraft.id), payload)
            : await api().manage.createQuiz(orgId(context), { ...payload, id: '' });
          quizDraft = JSON.parse(JSON.stringify(obj(result.quiz)));
          quizDirty = false;
          courseQuizzes = null;
        }
        showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), (globalThis.PlatformLanguage?.text("training","m_47bbabb50774cf","Saved.") ?? "Saved."), true);
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error, 'Save failed.'), false);
      }
    }

    /* ------------------------------------------------------------- library */
    const assignmentSummary = (subjectId) => {
      const rows = arr(assignmentsCache).filter((assignment) => clean(assignment.subject_kind) === 'course' && clean(assignment.subject_id) === clean(subjectId));
      if (!rows.length) return `<span class="sty-pill gray"><i class="fas fa-user-slash"></i>${(globalThis.PlatformLanguage?.text("training","m_10001d8bbe16e5"," Not assigned") ?? " Not assigned")}</span>`;
      const parts = rows.map((assignment) => {
        const kind = clean(assignment.target_kind);
        if (kind === 'everyone') return 'Everyone';
        if (kind === 'role') return `Role: ${roleName(assignment.target_id)}`;
        return userName(assignment.target_id);
      });
      return `<span class="sty-pill green"><i class="fas fa-user-check"></i> ${esc(parts.slice(0, 2).join(', '))}${parts.length > 2 ? ` +${parts.length - 2}` : ''}</span>`;
    };

    const renderLibrary = async () => {
      bodyEl.innerHTML = stateHtml('Loading your courses');
      try {
        await loadUsersAndRoles();
        if (!assignmentsCache) assignmentsCache = arr((await api().manage.assignments(orgId(context))).assignments);
        if (!courses) courses = arr((await api().manage.courses(orgId(context))).courses);
      } catch (error) {
        bodyEl.innerHTML = `<div class="sty-state">${esc(statusError(error, 'Could not load the training library.'))}</div>`;
        return;
      }
      if (destroyed || view.name !== 'library') return;
      const statusPill = (status) => status === 'published' ? `<span class="sty-pill green">${(globalThis.PlatformLanguage?.text("training","m_fcef580bdd8824","Published") ?? "Published")}</span>` : status === 'draft' ? `<span class="sty-pill gold">${(globalThis.PlatformLanguage?.text("training","m_9ce407c87de615","Draft") ?? "Draft")}</span>` : `<span class="sty-pill gray">${(globalThis.PlatformLanguage?.text("training","m_26b28a86126a93","Archived") ?? "Archived")}</span>`;
      bodyEl.innerHTML = `<div class="sty-grid">
        ${String(arr(courses).map((course) => `<button type="button" class="sty-card" data-open-course="${esc(course.id)}">
          <div class="sty-card-head"><span class="sty-card-icon" style="background:${esc(clean(course.color) || '#3b6ef6')}"><i class="fas ${esc(clean(course.icon) || 'fa-book')}"></i></span><span style="min-width:0"><strong>${esc(course.title)}</strong><small>${arr(course.lessons).length} lesson${arr(course.lessons).length === 1 ? '' : 's'}</small></span></div>
          <p>${esc(course.description)}</p>
          <div class="sty-card-foot">${statusPill(clean(course.status))}${assignmentSummary(course.id)}</div>
        </button>`).join(''))}
        <button type="button" class="sty-new-card" data-new-course><span><i class="fas fa-plus" style="font-size:20px;display:block;margin-bottom:8px"></i>${(globalThis.PlatformLanguage?.text("training","m_78d67f5c90a184","New course") ?? "New course")}</span></button>
      </div>`;
      bodyEl.querySelectorAll('[data-open-course]').forEach((button) => button.addEventListener('click', () => void openCourseEditor(button.dataset.openCourse)));
      bodyEl.querySelector('[data-new-course]').addEventListener('click', () => {
        draft = { id: '', title: (globalThis.PlatformLanguage?.text("training","m_78d67f5c90a184","New course") ?? "New course"), description: '', icon: 'fa-book-open', color: '#3b6ef6', status: 'draft', settings: { progression: 'sequential' }, lessons: [newLesson()], sort_order: arr(courses).length };
        draftDirty = true;
        selectedLessonIndex = 0;
        selectedStepIndex = 0;
        courseDecks = [];
        courseQuizzes = [];
        courseTab = 'lessons';
        view = { name: 'course' };
        render();
      });
    };

    /* -------------------------------------------------------- course open */
    function newLesson(){
      return { id: localId('lesson'), title: (globalThis.PlatformLanguage?.text("training","m_3dfce5ead1789c","New lesson") ?? "New lesson"), summary: '', icon: 'fa-book-open', minutes: 5, unlock: { mode: 'previous', available_on: '' }, steps: [newStep('content')], reward_deck_ids: [], reward_quiz_ids: [] };
    }
    function newStep(kind){
      if (kind === 'quiz') return { id: localId('step'), kind: 'quiz', title: (globalThis.PlatformLanguage?.text("training","m_401af29c6ae14c","Knowledge check") ?? "Knowledge check"), config: { required: false, pass_percent: 70, allow_practice: true, questions: [] } };
      if (kind === 'flashcards') return { id: localId('step'), kind: 'flashcards', title: (globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards"), config: { deck_id: '', mode: 'practice', required: false, pass_percent: 60 } };
      return { id: localId('step'), kind: 'content', title: (globalThis.PlatformLanguage?.text("training","m_a1e9c77dd07683","New page") ?? "New page"), config: { blocks: [{ type: 'heading', body: 'New page' }, { type: 'text', body: 'Write something great.' }] } };
    }

    async function loadCourseMaterials(){
      if (!clean(draft?.id)) { courseDecks = courseDecks || []; courseQuizzes = courseQuizzes || []; return; }
      try {
        const [deckResult, quizResult] = await Promise.all([
          api().manage.decks(orgId(context), { courseId: clean(draft.id) }),
          api().manage.quizzes(orgId(context), { courseId: clean(draft.id) })
        ]);
        courseDecks = arr(deckResult.decks);
        courseQuizzes = arr(quizResult.quizzes);
      } catch (_) {
        courseDecks = courseDecks || [];
        courseQuizzes = courseQuizzes || [];
      }
    }

    async function openCourseEditor(courseId){
      bodyEl.innerHTML = stateHtml('Opening the course');
      try {
        const result = await api().manage.course(orgId(context), courseId);
        draft = JSON.parse(JSON.stringify(obj(result.course)));
        if (!arr(draft.lessons).length) draft.lessons = [newLesson()];
        draftDirty = false;
        deckDraft = quizDraft = null;
        deckDirty = quizDirty = false;
        selectedLessonIndex = 0;
        selectedStepIndex = 0;
        courseTab = 'lessons';
        courseDecks = null;
        courseQuizzes = null;
        view = { name: 'course' };
        await loadCourseMaterials();
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error, 'Could not open the course.'), false);
        view = { name: 'library' };
        render();
      }
    }

    const bindField = (element, apply, what = 'course') => {
      element?.addEventListener('input', (event) => { apply(event.target); markDirty(what); schedulePreview(); });
      element?.addEventListener('change', (event) => { apply(event.target); markDirty(what); schedulePreview(); });
    };

    let previewTimer = null;
    const schedulePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 350);
    };

    const renderPreview = () => {
      const phoneBody = bodyEl.querySelector('[data-phone-body]');
      if (!phoneBody || view.name !== 'course' || courseTab !== 'lessons' || !draft) return;
      const lesson = obj(arr(draft.lessons)[selectedLessonIndex]);
      const step = obj(arr(lesson.steps)[selectedStepIndex]);
      const head = bodyEl.querySelector('[data-phone-head]');
      if (head) head.innerHTML = `<div style="width:34px;height:34px;border-radius:11px;background:${String(esc(clean(draft.color) || '#3b6ef6'))};color:#fff;display:grid;place-items:center;font-size:14px;flex:none"><i class="fas ${String(esc(clean(lesson.icon) || 'fa-book-open'))}"></i></div><div style="min-width:0"><div style="font-size:12.5px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(esc(lesson.title))}</div><div style="font-size:9.5px;font-weight:900;color:#8a92ab">${((v3,v4) => globalThis.PlatformLanguage?.text("training","m_1c153eb41064d3",`Page ${v3} of ${v4} &middot; live preview`,{v3,v4}) ?? `Page ${v3} of ${v4} &middot; live preview`)(selectedStepIndex + 1,arr(lesson.steps).length)}</div></div>`;
      phoneBody.innerHTML = '';
      const stepHolder = document.createElement('div');
      stepHolder.className = 'trn-step';
      stepHolder.style.setProperty('--trn-accent', clean(draft.color) || '#3b6ef6');
      phoneBody.appendChild(stepHolder);
      const registry = window.TrainingViewer?.stepKinds;
      const renderer = registry?.[clean(step.kind)];
      if (!renderer) {
        stepHolder.innerHTML = `<div class="sty-state">${(globalThis.PlatformLanguage?.text("training","m_77520ac5703511","Load the Training app bundle to preview this step.") ?? "Load the Training app bundle to preview this step.")}</div>`;
        return;
      }
      try {
        renderer.render(stepHolder, { step, context, course: draft, lesson, practice: true, controls: { setContinueEnabled(){}, setResult(){} } });
      } catch (_) {
        stepHolder.innerHTML = `<div class="sty-state">${(globalThis.PlatformLanguage?.text("training","m_27be586f944244","Preview unavailable for this step.") ?? "Preview unavailable for this step.")}</div>`;
      }
    };

    /* Media uploads go through the shared org media library, so files count
     * toward the organization's storage totals like any other upload. */
    async function uploadMediaFile(file){
      const PlatformAPI = window.PlatformAPI;
      if (!PlatformAPI?.media?.upload) throw new Error('The media library is unavailable.');
      const result = await PlatformAPI.media.upload(orgId(context), file, {
        collection: 'training',
        metadata: { source: 'training_studio', course_id: clean(draft?.id) }
      });
      const mediaId = clean(obj(result.media).id || obj(result.media).media_id);
      if (!mediaId) throw new Error('The upload did not return a media id.');
      return PlatformAPI.media.fileUrl(orgId(context), mediaId);
    }

    /* URL input + upload button. Uploading fills the field (or appends a line
     * for multi-URL textareas) and fires its input binding. */
    const urlFieldHtml = (label, attrs, value, accept, options = {}) => `
      <label class="sty-field">${String(esc(label))}<span class="sty-url-row">
        ${String(options.textarea ? `<textarea ${attrs} placeholder="${esc(options.placeholder || 'https://...')}">${esc(value)}</textarea>` : `<input ${attrs} value="${esc(value)}" placeholder="${esc(options.placeholder || 'https://...')}">`)}
        <button type="button" class="sty-btn sty-upload-btn" data-upload data-accept="${String(esc(accept))}" ${String(options.multiple ? 'data-multiple="1"' : '')} title="${(globalThis.PlatformLanguage?.text("training","m_0fd24c5d559419","Upload from your computer") ?? "Upload from your computer")}"><i class="fas fa-upload"></i></button>
      </span></label>`;

    const bindUploadButtons = (scope) => {
      scope.querySelectorAll('[data-upload]').forEach((button) => button.addEventListener('click', () => {
        const target = button.closest('.sty-url-row')?.querySelector('input,textarea');
        if (!target) return;
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = button.dataset.accept || '';
        picker.multiple = button.dataset.multiple === '1';
        picker.addEventListener('change', async () => {
          const files = [...(picker.files || [])];
          if (!files.length) return;
          const original = button.innerHTML;
          button.disabled = true;
          button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
          try {
            for (const file of files) {
              const url = await uploadMediaFile(file);
              if (target.tagName === 'TEXTAREA') target.value = `${clean(target.value) ? `${clean(target.value)}\n` : ''}${url}`;
              else target.value = url;
              target.dispatchEvent(new Event('input', { bubbles: true }));
            }
            showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), ((v0,v1) => globalThis.PlatformLanguage?.text("training","m_16bf9333ad7d78",`${v0} file${v1} uploaded to your media library.`,{v0,v1}) ?? `${v0} file${v1} uploaded to your media library.`)(files.length,files.length === 1 ? '' : 's'), true);
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("training","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), statusError(error, 'Could not upload the file.'), false);
          }
          button.disabled = false;
          button.innerHTML = original;
        });
        picker.click();
      }));
    };

    const moveItem = (list, index, delta) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return false;
      const [item] = list.splice(index, 1);
      list.splice(target, 0, item);
      return true;
    };

    /* --------------------------------------------------------- lessons tab */
    const blockEditorHtml = (block, blockIndex) => {
      const type = clean(block.type || 'text');
      const field = (label, name, value, placeholder = '') => `<label class="sty-field">${esc(label)}<input data-block-field="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`;
      const area = (label, name, value, placeholder = '') => `<label class="sty-field">${esc(label)}<textarea data-block-field="${esc(name)}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
      let fields = '';
      if (type === 'heading' || type === 'text' || type === 'callout') fields = area(type === 'heading' ? 'Heading' : type === 'callout' ? 'Callout text' : 'Paragraph', 'body', clean(block.body));
      else if (type === 'image') fields = urlFieldHtml('Image — paste a URL or upload', 'data-block-field="url"', clean(block.url), 'image/*') + field('Caption', 'caption', clean(block.caption));
      else if (type === 'gallery') fields = urlFieldHtml('Images — one URL per line, or upload several', 'data-block-field="urls"', arr(block.urls).join('\n'), 'image/*', { textarea: true, multiple: true }) + field('Caption', 'caption', clean(block.caption));
      else if (type === 'video') fields = urlFieldHtml('Video — mp4/YouTube/Vimeo URL, or upload a file', 'data-block-field="url"', clean(block.url), 'video/*') + field('Caption', 'caption', clean(block.caption));
      else if (type === 'document') fields = urlFieldHtml('File — paste a URL or upload', 'data-block-field="url"', clean(block.url), '') + field('File name', 'name', clean(block.name)) + field('Description', 'description', clean(block.description));
      return `<div class="sty-block-card" data-block-index="${String(blockIndex)}">
        <div class="sty-block-bar">
          <select data-block-type>${String(['text','heading','callout','image','gallery','video','document'].map((option) => `<option value="${option}" ${option === type ? 'selected' : ''}>${option[0].toUpperCase()}${option.slice(1)}</option>`).join(''))}</select>
          <div class="sty-block-tools">
            <button type="button" class="sty-icon-btn" data-block-up title="${(globalThis.PlatformLanguage?.text("training","m_f51d0d563b4d76","Move up") ?? "Move up")}"><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="sty-icon-btn" data-block-down title="${(globalThis.PlatformLanguage?.text("training","m_8dda6677ff0f34","Move down") ?? "Move down")}"><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="sty-icon-btn danger" data-block-remove title="${(globalThis.PlatformLanguage?.text("training","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        ${String(fields)}
      </div>`;
    };

    const questionEditorHtml = (question, questionIndex, options = {}) => {
      const kind = clean(question.kind || 'multiple_choice');
      return `<div class="sty-q-card" data-q-index="${String(questionIndex)}">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="sty-q-num">${String(esc(options.noun || 'Question'))} ${String(questionIndex + 1)}</span>
          <select data-q-kind style="border:1px solid #d4d9e6;border-radius:8px;padding:5px 8px;font:inherit;font-size:11px;font-weight:900">
            <option value="multiple_choice" ${String(kind === 'multiple_choice' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_1ce8dae577783a","Multiple choice") ?? "Multiple choice")}</option>
            <option value="text_input" ${String(kind === 'text_input' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_97a7a748922ee8","Typed answer") ?? "Typed answer")}</option>
          </select>
          <div style="margin-left:auto;display:flex;gap:5px">
            <button type="button" class="sty-icon-btn" data-q-up><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="sty-icon-btn" data-q-down><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="sty-icon-btn danger" data-q-remove><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_3e34020d84068e","Prompt") ?? "Prompt")}<textarea data-q-field="prompt">${String(esc(question.prompt))}</textarea></label>
        ${String(kind === 'multiple_choice'
          ? `<label class="sty-field">Choices — one per line, mark correct with *<textarea data-q-choices placeholder="*Correct answer\nWrong answer\nAnother wrong answer">${esc(choicesToText(question))}</textarea></label>`
          : `<label class="sty-field">Accepted answers — one per line<textarea data-q-answers placeholder="answer\nalternate answer">${esc(arr(question.answers).join('\n'))}</textarea></label>
             <label class="sty-check"><input type="checkbox" data-q-case ${question.case_sensitive === true ? 'checked' : ''}>Case sensitive</label>`)}
        <div class="sty-field-row">
          ${String(urlFieldHtml('Image (optional)', 'data-q-field="image"', clean(question.image), 'image/*'))}
          <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_3639ce572473fc","Explanation after answering (optional)") ?? "Explanation after answering (optional)")}<input data-q-field="explanation" value="${String(esc(question.explanation))}"></label>
        </div>
      </div>`;
    };

    const bindQuestionEditors = (container, questions, onChange) => {
      container.querySelectorAll('[data-q-index]').forEach((card) => {
        const index = Number(card.dataset.qIndex);
        const question = questions[index];
        card.querySelector('[data-q-kind]').addEventListener('change', (event) => { question.kind = event.target.value; onChange(true); });
        card.querySelectorAll('[data-q-field]').forEach((input) => input.addEventListener('input', () => { question[input.dataset.qField] = input.value; onChange(false); }));
        card.querySelector('[data-q-choices]')?.addEventListener('input', (event) => {
          const parsed = textToChoices(event.target.value, clean(question.id) || `q${index}`);
          question.choices = parsed.choices;
          question.correct_choice_ids = parsed.correct_choice_ids;
          onChange(false);
        });
        card.querySelector('[data-q-answers]')?.addEventListener('input', (event) => {
          question.answers = clean(event.target.value).split('\n').map((line) => line.trim()).filter(Boolean);
          onChange(false);
        });
        card.querySelector('[data-q-case]')?.addEventListener('change', (event) => { question.case_sensitive = event.target.checked; onChange(false); });
        card.querySelector('[data-q-up]').addEventListener('click', () => { if (moveItem(questions, index, -1)) onChange(true); });
        card.querySelector('[data-q-down]').addEventListener('click', () => { if (moveItem(questions, index, 1)) onChange(true); });
        card.querySelector('[data-q-remove]').addEventListener('click', () => { questions.splice(index, 1); onChange(true); });
      });
    };

    const stepEditorHtml = (step, stepIndex) => {
      const kindInfo = STEP_LIBRARY.find((item) => item.kind === clean(step.kind)) || { icon: 'fa-puzzle-piece', label: clean(step.kind) };
      const open = stepIndex === selectedStepIndex;
      const config = obj(step.config);
      let body = '';
      if (open && clean(step.kind) === 'content') {
        body = `<div data-blocks-holder style="display:grid;gap:9px">${String(arr(config.blocks).map((block, blockIndex) => blockEditorHtml(obj(block), blockIndex)).join(''))}</div>
          <button type="button" class="sty-btn" data-block-add style="justify-self:start"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("training","m_d2da9449c9549c"," Add block") ?? " Add block")}</button>`;
      } else if (open && clean(step.kind) === 'quiz') {
        body = `<div class="sty-field-row">
            <label class="sty-check" style="align-self:end"><input type="checkbox" data-quiz-required ${String(config.required === true ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("training","m_59471f0f13d1ab","Must pass to finish lesson") ?? "Must pass to finish lesson")}</label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_6d829b6d46b0fa","Pass mark %") ?? "Pass mark %")}<input type="number" min="0" max="100" data-quiz-pass value="${String(Number(config.pass_percent || 0))}"></label>
          </div>
          <div data-questions-holder style="display:grid;gap:9px">${String(arr(config.questions).map((question, questionIndex) => questionEditorHtml(obj(question), questionIndex)).join(''))}</div>
          <button type="button" class="sty-btn" data-question-add style="justify-self:start"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("training","m_01ad66ccfe3263"," Add question") ?? " Add question")}</button>`;
      } else if (open && clean(step.kind) === 'flashcards') {
        body = `<div class="sty-field-row">
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_0be814cbeea592","Deck from this course") ?? "Deck from this course")}<select data-fc-deck><option value="">${(globalThis.PlatformLanguage?.text("training","m_5dc6431d529fdb","Choose a deck...") ?? "Choose a deck...")}</option>${String(arr(courseDecks).map((deck) => `<option value="${esc(deck.id)}" ${clean(config.deck_id) === clean(deck.id) ? 'selected' : ''}>${esc(deck.title)}</option>`).join(''))}</select></label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_669e1e42b35fa1","Mode") ?? "Mode")}<select data-fc-mode><option value="practice" ${String(clean(config.mode) !== 'test' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_364ab255aa7530","Practice (relaxed)") ?? "Practice (relaxed)")}</option><option value="test" ${String(clean(config.mode) === 'test' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_5dc495c0944648","Test (scored)") ?? "Test (scored)")}</option></select></label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_6d829b6d46b0fa","Pass mark %") ?? "Pass mark %")}<input type="number" min="0" max="100" data-fc-pass value="${String(Number(config.pass_percent || 0))}"></label>
          </div>
          <label class="sty-check"><input type="checkbox" data-fc-required ${String(config.required === true ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("training","m_e175c78934a195","Must pass to finish lesson (test mode only)") ?? "Must pass to finish lesson (test mode only)")}</label>
          <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_aefb9e4e13c65f","Build decks in this course's Flashcard decks tab. The learner plays the deck without leaving the lesson.") ?? "Build decks in this course's Flashcard decks tab. The learner plays the deck without leaving the lesson.")}</p>`;
      }
      return `<div class="sty-step-card" data-step-index="${String(stepIndex)}">
        <div class="sty-step-head" data-step-select>
          <i class="fas ${String(esc(kindInfo.icon))} kind"></i>
          <strong>${String(esc(clean(step.title) || kindInfo.label))}</strong>
          <span class="sty-pill">${String(esc(kindInfo.label))}</span>
          <span class="sty-step-tools">
            <button type="button" class="sty-icon-btn" data-step-up title="${(globalThis.PlatformLanguage?.text("training","m_f51d0d563b4d76","Move up") ?? "Move up")}"><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="sty-icon-btn" data-step-down title="${(globalThis.PlatformLanguage?.text("training","m_8dda6677ff0f34","Move down") ?? "Move down")}"><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="sty-icon-btn danger" data-step-remove title="${(globalThis.PlatformLanguage?.text("training","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-trash"></i></button>
          </span>
        </div>
        ${String(open ? `<div class="sty-step-body">
          <label class="sty-field">Page title<input data-step-title value="${esc(step.title)}"></label>
          ${body}
        </div>` : '')}
      </div>`;
    };

    const renderLessonsTab = () => {
      const lessons = arr(draft.lessons);
      selectedLessonIndex = Math.max(0, Math.min(selectedLessonIndex, lessons.length - 1));
      const lesson = obj(lessons[selectedLessonIndex]);
      const steps = arr(lesson.steps);
      selectedStepIndex = Math.max(0, Math.min(selectedStepIndex, Math.max(0, steps.length - 1)));
      const unlock = obj(lesson.unlock);
      bodyEl.innerHTML = `<div class="sty-lessons-layout">
        <div class="sty-lessons-col"><div class="sty-panel">
          <div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_8dc5830045ba90","Lessons") ?? "Lessons")}</h3><button type="button" class="sty-icon-btn" data-lesson-add title="${(globalThis.PlatformLanguage?.text("training","m_3e2b9d1f4abefd","Add lesson") ?? "Add lesson")}"><i class="fas fa-plus"></i></button></div>
          <div class="sty-panel-body" style="gap:7px">
            ${String(lessons.map((item, index) => `<div class="sty-lesson-item ${index === selectedLessonIndex ? 'active' : ''}" data-lesson-select="${index}">
              <span class="sty-lesson-title">${index + 1}. ${esc(item.title)}</span>
              <small>${arr(item.steps).length}p</small>
              <button type="button" class="sty-icon-btn" data-lesson-up="${index}" title="Move up"><i class="fas fa-arrow-up"></i></button>
              <button type="button" class="sty-icon-btn danger" data-lesson-remove="${index}" title="Remove"><i class="fas fa-trash"></i></button>
            </div>`).join(''))}
          </div>
        </div></div>

        <div style="display:grid;gap:14px;min-width:0">
          <div class="sty-panel">
            <div class="sty-panel-head"><h3>${((v1) => globalThis.PlatformLanguage?.text("training","m_ae924771d2bc8f",`Lesson ${v1} &middot; details`,{v1}) ?? `Lesson ${v1} &middot; details`)(selectedLessonIndex + 1)}</h3></div>
            <div class="sty-panel-body">
              <div class="sty-field-row">
                <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_035b1f46f2dc8c","Lesson title") ?? "Lesson title")}<input data-lesson-field="title" value="${String(esc(lesson.title))}"></label>
                <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_1c13527c2c1332","Estimated minutes") ?? "Estimated minutes")}<input type="number" min="0" data-lesson-minutes value="${String(Number(lesson.minutes || 0))}"></label>
              </div>
              <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_88548238c17e23","Summary — shown in the lesson bubble popup") ?? "Summary — shown in the lesson bubble popup")}<textarea data-lesson-field="summary">${String(esc(lesson.summary))}</textarea></label>
              <div class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_debbc06ad0a4cb","Bubble icon") ?? "Bubble icon")}<div class="sty-icon-choices">${String(ICON_CHOICES.map((icon) => `<button type="button" class="sty-icon-choice ${clean(lesson.icon) === icon ? 'active' : ''}" data-lesson-icon="${icon}"><i class="fas ${icon}"></i></button>`).join(''))}</div></div>
              <div class="sty-field-row">
                <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_28a0726422d859","Unlocks") ?? "Unlocks")}<select data-lesson-unlock-mode>
                  <option value="previous" ${String(clean(unlock.mode) === 'previous' || !clean(unlock.mode) ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_8ff05b1dc09ea9","When previous lesson is done") ?? "When previous lesson is done")}</option>
                  <option value="date" ${String(clean(unlock.mode) === 'date' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_d75e5c42beeaa1","On a set date") ?? "On a set date")}</option>
                  <option value="manual" ${String(clean(unlock.mode) === 'manual' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_bfb2060d586c10","When I unlock it manually") ?? "When I unlock it manually")}</option>
                </select></label>
                ${String(clean(unlock.mode) === 'date' ? `<label class="sty-field">Available on<input type="date" data-lesson-unlock-date value="${esc(unlock.available_on)}"></label>` : '')}
              </div>
              ${String(clean(unlock.mode) === 'date' ? '<p class="sty-hint">You can override this date per person or crew from Assignments.</p>' : '')}
              ${String(clean(unlock.mode) === 'manual' ? '<p class="sty-hint">Use the Progress panel to unlock this lesson per person when they are ready.</p>' : '')}
            </div>
          </div>
          <div class="sty-panel">
            <div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_a6c13e38e7e96e","Pages") ?? "Pages")}</h3></div>
            <div class="sty-panel-body">
              <div style="display:grid;gap:9px" data-steps-holder>${String(steps.map((step, stepIndex) => stepEditorHtml(obj(step), stepIndex)).join(''))}</div>
              <div class="sty-add-row">${String(STEP_LIBRARY.map((item) => `<button type="button" class="sty-btn" data-step-add="${item.kind}" title="${esc(item.hint)}"><i class="fas ${item.icon}"></i> ${esc(item.label)}</button>`).join(''))}</div>
            </div>
          </div>
        </div>

        <div class="sty-preview-col">
          <div class="sty-phone"><div class="sty-phone-screen">
            <div class="sty-phone-head" data-phone-head></div>
            <div class="sty-phone-body" data-phone-body></div>
          </div></div>
        </div>
      </div>`;

      /* lesson list */
      bodyEl.querySelector('[data-lesson-add]').addEventListener('click', () => { draft.lessons.push(newLesson()); selectedLessonIndex = draft.lessons.length - 1; selectedStepIndex = 0; markDirty(); render(); });
      bodyEl.querySelectorAll('[data-lesson-select]').forEach((row) => row.addEventListener('click', (event) => {
        if (event.target.closest('[data-lesson-up],[data-lesson-remove]')) return;
        selectedLessonIndex = Number(row.dataset.lessonSelect);
        selectedStepIndex = 0;
        render();
      }));
      bodyEl.querySelectorAll('[data-lesson-up]').forEach((button) => button.addEventListener('click', () => {
        const index = Number(button.dataset.lessonUp);
        if (moveItem(draft.lessons, index, -1)) { selectedLessonIndex = Math.max(0, index - 1); markDirty(); render(); }
      }));
      bodyEl.querySelectorAll('[data-lesson-remove]').forEach((button) => button.addEventListener('click', async () => {
        const index = Number(button.dataset.lessonRemove);
        if (draft.lessons.length <= 1) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), (globalThis.PlatformLanguage?.text("training","m_40a0317d2764ca","A course needs at least one lesson.") ?? "A course needs at least one lesson."), false); return; }
        if (!(await confirmAction(`Remove lesson "${clean(obj(draft.lessons[index]).title)}"?`))) return;
        draft.lessons.splice(index, 1);
        selectedLessonIndex = Math.min(selectedLessonIndex, draft.lessons.length - 1);
        markDirty();
        render();
      }));

      /* lesson fields */
      bodyEl.querySelectorAll('[data-lesson-field]').forEach((input) => bindField(input, (element) => { lesson[element.dataset.lessonField] = element.value; }));
      bindField(bodyEl.querySelector('[data-lesson-minutes]'), (element) => { lesson.minutes = Math.max(0, Number(element.value) || 0); });
      bodyEl.querySelectorAll('[data-lesson-icon]').forEach((button) => button.addEventListener('click', () => { lesson.icon = button.dataset.lessonIcon; markDirty(); render(); }));
      bodyEl.querySelector('[data-lesson-unlock-mode]').addEventListener('change', (event) => { lesson.unlock = { ...obj(lesson.unlock), mode: event.target.value }; markDirty(); render(); });
      bindField(bodyEl.querySelector('[data-lesson-unlock-date]'), (element) => { lesson.unlock = { ...obj(lesson.unlock), available_on: element.value }; });

      /* steps */
      bodyEl.querySelectorAll('[data-step-add]').forEach((button) => button.addEventListener('click', () => {
        lesson.steps = arr(lesson.steps);
        lesson.steps.push(newStep(button.dataset.stepAdd));
        selectedStepIndex = lesson.steps.length - 1;
        markDirty();
        render();
      }));
      bodyEl.querySelectorAll('[data-step-index]').forEach((card) => {
        const stepIndex = Number(card.dataset.stepIndex);
        const step = obj(steps[stepIndex]);
        const config = obj(step.config);
        step.config = config;
        card.querySelector('[data-step-select]').addEventListener('click', (event) => {
          if (event.target.closest('[data-step-up],[data-step-down],[data-step-remove]')) return;
          if (selectedStepIndex !== stepIndex) { selectedStepIndex = stepIndex; render(); }
        });
        card.querySelector('[data-step-up]').addEventListener('click', () => { if (moveItem(steps, stepIndex, -1)) { selectedStepIndex = stepIndex - 1; markDirty(); render(); } });
        card.querySelector('[data-step-down]').addEventListener('click', () => { if (moveItem(steps, stepIndex, 1)) { selectedStepIndex = stepIndex + 1; markDirty(); render(); } });
        card.querySelector('[data-step-remove]').addEventListener('click', async () => {
          if (!(await confirmAction('Remove this page?'))) return;
          steps.splice(stepIndex, 1);
          selectedStepIndex = Math.max(0, Math.min(selectedStepIndex, steps.length - 1));
          markDirty();
          render();
        });
        bindField(card.querySelector('[data-step-title]'), (element) => { step.title = element.value; });

        card.querySelector('[data-block-add]')?.addEventListener('click', () => { config.blocks = arr(config.blocks); config.blocks.push({ type: 'text', body: '' }); markDirty(); render(); });
        card.querySelectorAll('[data-block-index]').forEach((blockCard) => {
          const blockIndex = Number(blockCard.dataset.blockIndex);
          const blocks = arr(config.blocks);
          const block = obj(blocks[blockIndex]);
          blocks[blockIndex] = block;
          blockCard.querySelector('[data-block-type]').addEventListener('change', (event) => { block.type = event.target.value; markDirty(); render(); });
          blockCard.querySelectorAll('[data-block-field]').forEach((input) => bindField(input, (element) => {
            const name = element.dataset.blockField;
            if (name === 'urls') block.urls = clean(element.value).split('\n').map((line) => line.trim()).filter(Boolean);
            else block[name] = element.value;
          }));
          blockCard.querySelector('[data-block-up]').addEventListener('click', () => { if (moveItem(blocks, blockIndex, -1)) { markDirty(); render(); } });
          blockCard.querySelector('[data-block-down]').addEventListener('click', () => { if (moveItem(blocks, blockIndex, 1)) { markDirty(); render(); } });
          blockCard.querySelector('[data-block-remove]').addEventListener('click', () => { blocks.splice(blockIndex, 1); markDirty(); render(); });
        });

        card.querySelector('[data-quiz-required]')?.addEventListener('change', (event) => { config.required = event.target.checked; markDirty(); });
        bindField(card.querySelector('[data-quiz-pass]'), (element) => { config.pass_percent = Math.max(0, Math.min(100, Number(element.value) || 0)); });
        card.querySelector('[data-question-add]')?.addEventListener('click', () => {
          config.questions = arr(config.questions);
          config.questions.push({ id: localId('q'), kind: 'multiple_choice', prompt: '', image: '', explanation: '', choices: [], correct_choice_ids: [], answers: [], case_sensitive: false });
          markDirty();
          render();
        });
        const questionsHolder = card.querySelector('[data-questions-holder]');
        if (questionsHolder) bindQuestionEditors(questionsHolder, arr(config.questions), (structural) => { markDirty(); schedulePreview(); if (structural) render(); });

        card.querySelector('[data-fc-deck]')?.addEventListener('change', (event) => { config.deck_id = event.target.value; markDirty(); schedulePreview(); });
        card.querySelector('[data-fc-mode]')?.addEventListener('change', (event) => { config.mode = event.target.value; markDirty(); });
        bindField(card.querySelector('[data-fc-pass]'), (element) => { config.pass_percent = Math.max(0, Math.min(100, Number(element.value) || 0)); });
        card.querySelector('[data-fc-required]')?.addEventListener('change', (event) => { config.required = event.target.checked; markDirty(); });
      });

      bindUploadButtons(bodyEl);
      renderPreview();
    };

    /* ------------------------------------------------------- settings tab */
    const renderSettingsTab = () => {
      bodyEl.innerHTML = `<div class="sty-settings-wrap"><div class="sty-panel">
        <div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_54d42ca6fdd71a","Course settings") ?? "Course settings")}</h3></div>
        <div class="sty-panel-body" style="gap:14px">
          <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_29dbd3d8b69f55","Title") ?? "Title")}<input data-course-field="title" value="${String(esc(draft.title))}"></label>
          <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_800b99f7e9df59","Description — shown on the learner's course card") ?? "Description — shown on the learner's course card")}<textarea data-course-field="description">${String(esc(draft.description))}</textarea></label>
          <div class="sty-field-row">
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_1352cafa75b8da","Status") ?? "Status")}<select data-course-field="status">${String(['draft','published','archived'].map((status) => `<option value="${status}" ${clean(draft.status) === status ? 'selected' : ''}>${status[0].toUpperCase()}${status.slice(1)}</option>`).join(''))}</select></label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_d9bd00a9b123cc","Progression") ?? "Progression")}<select data-course-progression><option value="sequential" ${String(clean(obj(draft.settings).progression) !== 'free' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_85efb7487b4a9b","Lessons in order") ?? "Lessons in order")}</option><option value="free" ${String(clean(obj(draft.settings).progression) === 'free' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_868d735d29bde8","Any order") ?? "Any order")}</option></select></label>
          </div>
          <div class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_161a14d638c05f","Course color") ?? "Course color")}<div class="sty-swatches">${String(COLOR_CHOICES.map((color) => `<button type="button" class="sty-swatch ${clean(draft.color) === color ? 'active' : ''}" style="background:${color}" data-course-color="${color}"></button>`).join(''))}</div></div>
          <div class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_3384b5593b13c1","Course icon") ?? "Course icon")}<div class="sty-icon-choices">${String(ICON_CHOICES.map((icon) => `<button type="button" class="sty-icon-choice ${clean(draft.icon) === icon ? 'active' : ''}" data-course-icon="${icon}"><i class="fas ${icon}"></i></button>`).join(''))}</div></div>
          <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_bcd2f02abf608d","Draft courses are invisible to learners until published. \"Lessons in order\" is the classic path; \"Any order\" lets learners jump around (date and manual locks still apply).") ?? "Draft courses are invisible to learners until published. \"Lessons in order\" is the classic path; \"Any order\" lets learners jump around (date and manual locks still apply).")}</p>
        </div>
      </div></div>`;
      bodyEl.querySelectorAll('[data-course-field]').forEach((input) => bindField(input, (element) => { draft[element.dataset.courseField] = element.value; }));
      bindField(bodyEl.querySelector('[data-course-progression]'), (element) => { draft.settings = { ...obj(draft.settings), progression: element.value }; });
      bodyEl.querySelectorAll('[data-course-color]').forEach((button) => button.addEventListener('click', () => { draft.color = button.dataset.courseColor; markDirty(); render(); }));
      bodyEl.querySelectorAll('[data-course-icon]').forEach((button) => button.addEventListener('click', () => { draft.icon = button.dataset.courseIcon; markDirty(); render(); }));
    };

    /* ------------------------------------------------- decks / quizzes tabs */
    const unlockLabel = (item) => {
      const lessonId = clean(item.unlock_lesson_id);
      if (!lessonId) return 'Available immediately';
      const lesson = arr(draft?.lessons).find((entry) => clean(entry.id) === lessonId);
      return lesson ? `Unlocks after "${clean(lesson.title)}"` : 'Unlocks after a lesson';
    };

    const unlockSelectHtml = (item, attr) => `
      <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_0ea1c466df3e1d","Learners can practice it") ?? "Learners can practice it")}<select ${String(attr)}>
        <option value="" ${String(!clean(item.unlock_lesson_id) ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_cf28bae3ec2d31","Immediately (with the course)") ?? "Immediately (with the course)")}</option>
        ${String(arr(draft?.lessons).map((lesson, index) => `<option value="${esc(lesson.id)}" ${clean(item.unlock_lesson_id) === clean(lesson.id) ? 'selected' : ''}>After lesson ${index + 1}: ${esc(lesson.title)}</option>`).join(''))}
      </select></label>`;

    const renderMaterialList = (kind) => {
      const isDeck = kind === 'deck';
      const items = isDeck ? courseDecks : courseQuizzes;
      const unit = isDeck ? 'card' : 'question';
      if (!clean(draft.id)) {
        bodyEl.innerHTML = `<div class="sty-state"><div><i class="fas fa-floppy-disk" style="font-size:22px;display:block;margin-bottom:10px;color:#aab2c8"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_a91b3837cb3a3d",`Save the course first, then add ${v0} to it.`,{v0}) ?? `Save the course first, then add ${v0} to it.`)(isDeck ? 'flashcard decks' : 'practice quizzes')}</div></div>`;
        return;
      }
      bodyEl.innerHTML = `<div class="sty-settings-wrap" style="width:min(760px,100%)"><div class="sty-panel">
        <div class="sty-panel-head"><h3>${((v0) => globalThis.PlatformLanguage?.text("training","m_486a3e91c48da8",`${v0} in this course`,{v0}) ?? `${v0} in this course`)(isDeck ? 'Flashcard decks' : 'Practice quizzes')}</h3><button type="button" class="sty-btn" data-item-new><i class="fas fa-plus"></i>${((v1) => globalThis.PlatformLanguage?.text("training","m_00f53955e385f7",` New ${v1}`,{v1}) ?? ` New ${v1}`)(isDeck ? 'deck' : 'quiz')}</button></div>
        <div class="sty-panel-body" style="gap:9px">
          ${String(arr(items).length ? arr(items).map((item) => {
            const count = arr(isDeck ? item.cards : item.questions).length;
            return `<button type="button" class="sty-list-row" data-item-open="${esc(item.id)}">
              <span class="sty-list-icon" style="background:${esc(clean(item.color) || '#3b6ef6')}"><i class="fas ${esc(clean(item.icon) || (isDeck ? 'fa-layer-group' : 'fa-bolt'))}"></i></span>
              <span class="sty-list-copy"><strong>${esc(item.title)}</strong><span>${count} ${unit}${count === 1 ? '' : 's'} &middot; ${esc(unlockLabel(item))}${!isDeck ? ` &middot; pass ${Number(item.pass_percent || 0)}%` : ''}</span></span>
              ${clean(item.status) !== 'published' ? `<span class="sty-pill ${clean(item.status) === 'draft' ? 'gold' : 'gray'}">${esc(item.status)}</span>` : ''}
              <i class="fas fa-chevron-right" style="color:#c2c8da;font-size:12px"></i>
            </button>`;
          }).join('') : `<div class="sty-state" style="min-height:110px">No ${isDeck ? 'decks' : 'quizzes'} yet. Learners see them in the ${isDeck ? 'Flashcards' : 'Quizzes'} tab, grouped under this course.</div>`)}
          <p class="sty-hint">${((v3,v4) => globalThis.PlatformLanguage?.text("training","m_b3bae27161850d",`Each ${v3} is available with the course immediately, or unlocks when a lesson you pick is completed. ${v4}`,{v3,v4}) ?? `Each ${v3} is available with the course immediately, or unlocks when a lesson you pick is completed. ${v4}`)(isDeck ? 'deck' : 'quiz',isDeck ? 'Decks can also be played inside lessons via a Flashcards page.' : 'Learners always get a free practice mode; scored runs are tracked.')}</p>
        </div>
      </div></div>`;
      bodyEl.querySelector('[data-item-new]').addEventListener('click', () => {
        if (isDeck) {
          deckDraft = { id: '', course_id: clean(draft.id), unlock_lesson_id: '', title: (globalThis.PlatformLanguage?.text("training","m_c58bb6854a97ab","New deck") ?? "New deck"), description: '', icon: 'fa-layer-group', color: clean(draft.color) || '#8b5cf6', status: 'published', shuffle: true, cards: [] };
          deckDirty = true;
        } else {
          quizDraft = { id: '', course_id: clean(draft.id), unlock_lesson_id: '', title: (globalThis.PlatformLanguage?.text("training","m_f786edc7393e5a","New quiz") ?? "New quiz"), description: '', icon: 'fa-bolt', color: clean(draft.color) || '#10b981', status: 'published', shuffle: true, pass_percent: 70, questions: [] };
          quizDirty = true;
        }
        render();
      });
      bodyEl.querySelectorAll('[data-item-open]').forEach((button) => button.addEventListener('click', async () => {
        try {
          if (isDeck) {
            const result = await api().manage.deck(orgId(context), button.dataset.itemOpen);
            deckDraft = JSON.parse(JSON.stringify(obj(result.deck)));
            deckDirty = false;
          } else {
            const result = await api().manage.quiz(orgId(context), button.dataset.itemOpen);
            quizDraft = JSON.parse(JSON.stringify(obj(result.quiz)));
            quizDirty = false;
          }
          render();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error), false);
        }
      }));
    };

    const cardEditorHtml = (card, cardIndex) => {
      const kind = clean(card.kind || 'flip');
      return `<div class="sty-q-card" data-card-index="${String(cardIndex)}">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="sty-q-num">${((v1) => globalThis.PlatformLanguage?.text("training","m_774cc8ee5713f2",`Card ${v1}`,{v1}) ?? `Card ${v1}`)(cardIndex + 1)}</span>
          <select data-card-kind style="border:1px solid #d4d9e6;border-radius:8px;padding:5px 8px;font:inherit;font-size:11px;font-weight:900">
            <option value="flip" ${String(kind === 'flip' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_f7a30ffd0f39dd","Flip card") ?? "Flip card")}</option>
            <option value="multiple_choice" ${String(kind === 'multiple_choice' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_1ce8dae577783a","Multiple choice") ?? "Multiple choice")}</option>
            <option value="text_input" ${String(kind === 'text_input' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("training","m_97a7a748922ee8","Typed answer") ?? "Typed answer")}</option>
          </select>
          <div style="margin-left:auto;display:flex;gap:5px"><button type="button" class="sty-icon-btn danger" data-card-remove><i class="fas fa-trash"></i></button></div>
        </div>
        <div class="sty-field-row">
          <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_a722e74eac8e97","Front text") ?? "Front text")}<textarea data-card-field="front_text">${String(esc(card.front_text))}</textarea></label>
          ${String(urlFieldHtml('Front image (optional)', 'data-card-field="front_image"', clean(card.front_image), 'image/*'))}
        </div>
        ${String(kind === 'flip' ? `<div class="sty-field-row">
            <label class="sty-field">Back text<textarea data-card-field="back_text">${esc(card.back_text)}</textarea></label>
            ${urlFieldHtml('Back image (optional)', 'data-card-field="back_image"', clean(card.back_image), 'image/*')}
          </div>` : '')}
        ${String(kind === 'multiple_choice' ? `<label class="sty-field">Choices — one per line, mark correct with *<textarea data-card-choices>${esc(choicesToText(card))}</textarea></label>` : '')}
        ${String(kind === 'text_input' ? `<label class="sty-field">Accepted answers — one per line<textarea data-card-answers>${esc(arr(card.answers).join('\n'))}</textarea></label>
          <label class="sty-check"><input type="checkbox" data-card-case ${card.case_sensitive === true ? 'checked' : ''}>Case sensitive</label>` : '')}
      </div>`;
    };

    const renderDeckEditor = () => {
      const cards = arr(deckDraft.cards);
      deckDraft.cards = cards;
      bodyEl.innerHTML = `<div class="sty-two-col">
        <div class="sty-panel">
          <div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_fdd11a4ce45617","Deck") ?? "Deck")}</h3><button type="button" class="sty-btn" data-item-list><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("training","m_2748b1c5b52172"," All decks") ?? " All decks")}</button></div>
          <div class="sty-panel-body">
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_29dbd3d8b69f55","Title") ?? "Title")}<input data-item-field="title" value="${String(esc(deckDraft.title))}"></label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_aa136ecb65672f","Description") ?? "Description")}<textarea data-item-field="description">${String(esc(deckDraft.description))}</textarea></label>
            ${String(unlockSelectHtml(deckDraft, 'data-item-unlock'))}
            <div class="sty-field-row">
              <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_1352cafa75b8da","Status") ?? "Status")}<select data-item-field="status">${String(['draft','published','archived'].map((status) => `<option value="${status}" ${clean(deckDraft.status) === status ? 'selected' : ''}>${status[0].toUpperCase()}${status.slice(1)}</option>`).join(''))}</select></label>
              <label class="sty-check" style="align-self:end"><input type="checkbox" data-deck-shuffle ${String(deckDraft.shuffle !== false ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("training","m_982dfa819fddc9","Shuffle each run") ?? "Shuffle each run")}</label>
            </div>
            <div class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_db7002926d9977","Color") ?? "Color")}<div class="sty-swatches">${String(COLOR_CHOICES.map((color) => `<button type="button" class="sty-swatch ${clean(deckDraft.color) === color ? 'active' : ''}" style="background:${color}" data-item-color="${color}"></button>`).join(''))}</div></div>
            <button type="button" class="sty-btn" data-deck-import><i class="fas fa-file-import"></i>${(globalThis.PlatformLanguage?.text("training","m_63e8110d87c398"," Bulk import cards") ?? " Bulk import cards")}</button>
            <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_1a9e7ad2c04417","No limit on deck size — import hundreds of cards at once if you like.") ?? "No limit on deck size — import hundreds of cards at once if you like.")}</p>
          </div>
        </div>
        <div class="sty-panel">
          <div class="sty-panel-head"><h3>${((v6,v7) => globalThis.PlatformLanguage?.text("training","m_2701620d090407",`${v6} card${v7}`,{v6,v7}) ?? `${v6} card${v7}`)(cards.length,cards.length === 1 ? '' : 's')}</h3><button type="button" class="sty-icon-btn" data-card-add title="${(globalThis.PlatformLanguage?.text("training","m_4fcae81d15d3ac","Add card") ?? "Add card")}"><i class="fas fa-plus"></i></button></div>
          <div class="sty-panel-body">${String(cards.map((card, cardIndex) => cardEditorHtml(obj(card), cardIndex)).join('') || '<div class="sty-state" style="min-height:100px">No cards yet — add one or bulk import.</div>')}</div>
        </div>
      </div>`;
      bodyEl.querySelector('[data-item-list]').addEventListener('click', async () => {
        if (deckDirty && !(await confirmAction('Discard unsaved changes to this deck?'))) return;
        deckDraft = null;
        deckDirty = false;
        await loadCourseMaterials();
        render();
      });
      bodyEl.querySelectorAll('[data-item-field]').forEach((input) => bindField(input, (element) => { deckDraft[element.dataset.itemField] = element.value; }, 'deck'));
      bodyEl.querySelector('[data-item-unlock]').addEventListener('change', (event) => { deckDraft.unlock_lesson_id = event.target.value; markDirty('deck'); });
      bodyEl.querySelector('[data-deck-shuffle]').addEventListener('change', (event) => { deckDraft.shuffle = event.target.checked; markDirty('deck'); });
      bodyEl.querySelectorAll('[data-item-color]').forEach((button) => button.addEventListener('click', () => { deckDraft.color = button.dataset.itemColor; markDirty('deck'); render(); }));
      bodyEl.querySelector('[data-card-add]').addEventListener('click', () => { cards.push({ id: localId('card'), kind: 'flip', front_text: '', front_image: '', back_text: '', back_image: '', choices: [], correct_choice_ids: [], answers: [], case_sensitive: false }); markDirty('deck'); render(); });
      bodyEl.querySelector('[data-deck-import]').addEventListener('click', () => {
        const dialog = modal(`<h2>${(globalThis.PlatformLanguage?.text("training","m_1e5f51be1ab015","Bulk import cards") ?? "Bulk import cards")}</h2>
          <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_cd7b3c7c697d7f","One card per line. Separate front and back with a pipe. A back with several answers separated by ; becomes a typed-answer card.") ?? "One card per line. Separate front and back with a pipe. A back with several answers separated by ; becomes a typed-answer card.")}<br><br><b>${(globalThis.PlatformLanguage?.text("training","m_83a89e35422029","What is a square? | 100 square feet") ?? "What is a square? | 100 square feet")}</b>${(globalThis.PlatformLanguage?.text("training","m_4e0e7ea31562a7"," → flip card") ?? " → flip card")}<br><b>${(globalThis.PlatformLanguage?.text("training","m_751e1ffd494cc1","Pitch of 6 rise per 12 run? | 6/12 ; six twelve") ?? "Pitch of 6 rise per 12 run? | 6/12 ; six twelve")}</b>${(globalThis.PlatformLanguage?.text("training","m_c843936e4fde47"," → typed answer") ?? " → typed answer")}</p>
          <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_e3c621800e2eda","Cards") ?? "Cards")}<textarea data-import-text style="min-height:220px" placeholder="${(globalThis.PlatformLanguage?.text("training","m_77ba4903989f42","Front | Back") ?? "Front | Back")}"></textarea></label>
          <button type="button" class="sty-btn primary" data-import-go><i class="fas fa-file-import"></i>${(globalThis.PlatformLanguage?.text("training","m_edab924c40c4ae"," Import") ?? " Import")}</button>`);
        dialog.el.querySelector('[data-import-go]').addEventListener('click', () => {
          const lines = clean(dialog.el.querySelector('[data-import-text]').value).split('\n').map((line) => line.trim()).filter((line) => line.includes('|'));
          lines.forEach((line) => {
            const [front, back = ''] = line.split('|').map((part) => part.trim());
            const answers = back.split(';').map((part) => part.trim()).filter(Boolean);
            if (answers.length > 1) cards.push({ id: localId('card'), kind: 'text_input', front_text: front, front_image: '', back_text: answers[0], back_image: '', choices: [], correct_choice_ids: [], answers, case_sensitive: false });
            else cards.push({ id: localId('card'), kind: 'flip', front_text: front, front_image: '', back_text: back, back_image: '', choices: [], correct_choice_ids: [], answers: [], case_sensitive: false });
          });
          dialog.close();
          if (lines.length) { markDirty('deck'); render(); showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), ((v0,v1) => globalThis.PlatformLanguage?.text("training","m_e20f70c56bfb4c",`${v0} card${v1} imported.`,{v0,v1}) ?? `${v0} card${v1} imported.`)(lines.length,lines.length === 1 ? '' : 's'), true); }
        });
      });
      bodyEl.querySelectorAll('[data-card-index]').forEach((cardEl) => {
        const cardIndex = Number(cardEl.dataset.cardIndex);
        const card = obj(cards[cardIndex]);
        cards[cardIndex] = card;
        cardEl.querySelector('[data-card-kind]').addEventListener('change', (event) => { card.kind = event.target.value; markDirty('deck'); render(); });
        cardEl.querySelectorAll('[data-card-field]').forEach((input) => bindField(input, (element) => { card[element.dataset.cardField] = element.value; }, 'deck'));
        cardEl.querySelector('[data-card-choices]')?.addEventListener('input', (event) => {
          const parsed = textToChoices(event.target.value, clean(card.id) || `card${cardIndex}`);
          card.choices = parsed.choices;
          card.correct_choice_ids = parsed.correct_choice_ids;
          markDirty('deck');
        });
        cardEl.querySelector('[data-card-answers]')?.addEventListener('input', (event) => { card.answers = clean(event.target.value).split('\n').map((line) => line.trim()).filter(Boolean); markDirty('deck'); });
        cardEl.querySelector('[data-card-case]')?.addEventListener('change', (event) => { card.case_sensitive = event.target.checked; markDirty('deck'); });
        cardEl.querySelector('[data-card-remove]').addEventListener('click', () => { cards.splice(cardIndex, 1); markDirty('deck'); render(); });
      });
      bindUploadButtons(bodyEl);
    };

    const renderQuizEditor = () => {
      const questions = arr(quizDraft.questions);
      quizDraft.questions = questions;
      bodyEl.innerHTML = `<div class="sty-two-col">
        <div class="sty-panel">
          <div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_aeef2847f8a286","Quiz") ?? "Quiz")}</h3><button type="button" class="sty-btn" data-item-list><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("training","m_bd23557c384869"," All quizzes") ?? " All quizzes")}</button></div>
          <div class="sty-panel-body">
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_29dbd3d8b69f55","Title") ?? "Title")}<input data-item-field="title" value="${String(esc(quizDraft.title))}"></label>
            <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_aa136ecb65672f","Description") ?? "Description")}<textarea data-item-field="description">${String(esc(quizDraft.description))}</textarea></label>
            ${String(unlockSelectHtml(quizDraft, 'data-item-unlock'))}
            <div class="sty-field-row">
              <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_1352cafa75b8da","Status") ?? "Status")}<select data-item-field="status">${String(['draft','published','archived'].map((status) => `<option value="${status}" ${clean(quizDraft.status) === status ? 'selected' : ''}>${status[0].toUpperCase()}${status.slice(1)}</option>`).join(''))}</select></label>
              <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_6d829b6d46b0fa","Pass mark %") ?? "Pass mark %")}<input type="number" min="0" max="100" data-quiz-pass-percent value="${String(Number(quizDraft.pass_percent || 0))}"></label>
            </div>
            <label class="sty-check"><input type="checkbox" data-quiz-shuffle ${String(quizDraft.shuffle !== false ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("training","m_f685d6e71edcf9","Shuffle question order") ?? "Shuffle question order")}</label>
            <div class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_db7002926d9977","Color") ?? "Color")}<div class="sty-swatches">${String(COLOR_CHOICES.map((color) => `<button type="button" class="sty-swatch ${clean(quizDraft.color) === color ? 'active' : ''}" style="background:${color}" data-item-color="${color}"></button>`).join(''))}</div></div>
            <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_9ace388ac0d2c0","Learners always get a free practice mode — scored runs are tracked toward their best.") ?? "Learners always get a free practice mode — scored runs are tracked toward their best.")}</p>
          </div>
        </div>
        <div class="sty-panel">
          <div class="sty-panel-head"><h3>${((v7,v8) => globalThis.PlatformLanguage?.text("training","m_71ddddba568046",`${v7} question${v8}`,{v7,v8}) ?? `${v7} question${v8}`)(questions.length,questions.length === 1 ? '' : 's')}</h3><button type="button" class="sty-icon-btn" data-question-add title="${(globalThis.PlatformLanguage?.text("training","m_4eff0bb666e3cc","Add question") ?? "Add question")}"><i class="fas fa-plus"></i></button></div>
          <div class="sty-panel-body" data-questions-holder>${String(questions.map((question, questionIndex) => questionEditorHtml(obj(question), questionIndex)).join('') || '<div class="sty-state" style="min-height:100px">No questions yet.</div>')}</div>
        </div>
      </div>`;
      bodyEl.querySelector('[data-item-list]').addEventListener('click', async () => {
        if (quizDirty && !(await confirmAction('Discard unsaved changes to this quiz?'))) return;
        quizDraft = null;
        quizDirty = false;
        await loadCourseMaterials();
        render();
      });
      bodyEl.querySelectorAll('[data-item-field]').forEach((input) => bindField(input, (element) => { quizDraft[element.dataset.itemField] = element.value; }, 'quiz'));
      bodyEl.querySelector('[data-item-unlock]').addEventListener('change', (event) => { quizDraft.unlock_lesson_id = event.target.value; markDirty('quiz'); });
      bindField(bodyEl.querySelector('[data-quiz-pass-percent]'), (element) => { quizDraft.pass_percent = Math.max(0, Math.min(100, Number(element.value) || 0)); }, 'quiz');
      bodyEl.querySelector('[data-quiz-shuffle]').addEventListener('change', (event) => { quizDraft.shuffle = event.target.checked; markDirty('quiz'); });
      bodyEl.querySelectorAll('[data-item-color]').forEach((button) => button.addEventListener('click', () => { quizDraft.color = button.dataset.itemColor; markDirty('quiz'); render(); }));
      bodyEl.querySelector('[data-question-add]').addEventListener('click', () => {
        questions.push({ id: localId('q'), kind: 'multiple_choice', prompt: '', image: '', explanation: '', choices: [], correct_choice_ids: [], answers: [], case_sensitive: false });
        markDirty('quiz');
        render();
      });
      bindQuestionEditors(bodyEl.querySelector('[data-questions-holder]'), questions, (structural) => { markDirty('quiz'); if (structural) render(); });
      bindUploadButtons(bodyEl);
    };

    /* ------------------------------------------------------- assignments */
    async function openAssignments(){
      const subjectId = clean(draft?.id);
      if (!subjectId) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), (globalThis.PlatformLanguage?.text("training","m_5098eead37a634","Save the course first, then assign it.") ?? "Save the course first, then assign it."), false); return; }
      await loadUsersAndRoles();
      const dialog = modal(`<h2>${((v0) => globalThis.PlatformLanguage?.text("training","m_4234df11d3b9ed",`Who gets "${v0}"?`,{v0}) ?? `Who gets "${v0}"?`)(esc(clean(draft.title)))}</h2><div data-assign-body>${String(stateHtml('Loading assignments'))}</div>`);
      const body = dialog.el.querySelector('[data-assign-body]');
      const renderAssignments = async () => {
        let rows = [];
        try { rows = arr((await api().manage.assignments(orgId(context), { subjectKind: 'course', subjectId })).assignments); }
        catch (error) { body.innerHTML = `<div class="sty-state">${esc(statusError(error))}</div>`; return; }
        assignmentsCache = null;
        const targetLabel = (assignment) => {
          const kind = clean(assignment.target_kind);
          if (kind === 'everyone') return '<i class="fas fa-globe" style="margin-right:7px;color:#3b6ef6"></i>Everyone in the company';
          if (kind === 'role') return `<i class="fas fa-people-group" style="margin-right:7px;color:#8b5cf6"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_45f6cdc49194fd",`Role: ${v0} `,{v0}) ?? `Role: ${v0} `)(esc(roleName(assignment.target_id)))}<span class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_d3a96e8fe9e955","(auto-assigns new people with this role)") ?? "(auto-assigns new people with this role)")}</span>`;
          return `<i class="fas fa-user" style="margin-right:7px;color:#10b981"></i>${esc(userName(assignment.target_id))}`;
        };
        body.innerHTML = `
          <div style="display:grid;gap:8px">${String(rows.length ? rows.map((assignment) => `<div style="display:flex;align-items:center;gap:10px;border:1px solid var(--sty-line);border-radius:12px;padding:11px 13px;font-size:12.5px;font-weight:900"><span style="flex:1;min-width:0">${targetLabel(assignment)}</span><button type="button" class="sty-icon-btn danger" data-assign-remove="${esc(assignment.id)}" title="Remove"><i class="fas fa-trash"></i></button></div>`).join('') : '<div class="sty-state" style="min-height:70px">Nobody is assigned this course yet.</div>')}</div>
          <div class="sty-panel" style="margin-top:14px"><div class="sty-panel-head"><h3>${(globalThis.PlatformLanguage?.text("training","m_0c4f1a53222382","Add assignment") ?? "Add assignment")}</h3></div><div class="sty-panel-body">
            <div class="sty-field-row">
              <label class="sty-field">${(globalThis.PlatformLanguage?.text("training","m_2fc446609c007c","Assign to") ?? "Assign to")}<select data-assign-kind>
                <option value="everyone">${(globalThis.PlatformLanguage?.text("training","m_ba4c0181dbbab5","Everyone") ?? "Everyone")}</option>
                <option value="role">${(globalThis.PlatformLanguage?.text("training","m_664f4fcb2d98d2","A role (auto-assigns new hires)") ?? "A role (auto-assigns new hires)")}</option>
                <option value="user">${(globalThis.PlatformLanguage?.text("training","m_1a0c18366790ea","A specific person") ?? "A specific person")}</option>
              </select></label>
              <label class="sty-field" data-assign-target-wrap hidden>${(globalThis.PlatformLanguage?.text("training","m_1d72d3bf6c7947","Target") ?? "Target")}<select data-assign-target></select></label>
            </div>
            <button type="button" class="sty-btn primary" data-assign-add style="justify-self:start"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("training","m_2f703b36cfa00f"," Assign course") ?? " Assign course")}</button>
            <p class="sty-hint">${(globalThis.PlatformLanguage?.text("training","m_7f8059c12d5f41","Role assignments make a course automatic — e.g. a safety course for every crew member, or Sales 101 for every salesperson. New hires with the role get it with zero setup. The course's decks and quizzes ride along automatically.") ?? "Role assignments make a course automatic — e.g. a safety course for every crew member, or Sales 101 for every salesperson. New hires with the role get it with zero setup. The course's decks and quizzes ride along automatically.")}</p>
          </div></div>`;
        const kindSelect = body.querySelector('[data-assign-kind]');
        const targetWrap = body.querySelector('[data-assign-target-wrap]');
        const targetSelect = body.querySelector('[data-assign-target]');
        const refreshTargets = () => {
          const kind = kindSelect.value;
          targetWrap.hidden = kind === 'everyone';
          if (kind === 'role') targetSelect.innerHTML = (rolesCache || []).map((role) => `<option value="${esc(role.id)}">${esc(role.name)}</option>`).join('') || `<option value="">${(globalThis.PlatformLanguage?.text("training","m_78d09dc3043e9f","No roles found") ?? "No roles found")}</option>`;
          if (kind === 'user') targetSelect.innerHTML = (usersCache || []).map((user) => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('') || `<option value="">${(globalThis.PlatformLanguage?.text("training","m_01f6ba3a9805ec","No people found") ?? "No people found")}</option>`;
        };
        kindSelect.addEventListener('change', refreshTargets);
        refreshTargets();
        body.querySelector('[data-assign-add]').addEventListener('click', async (event) => {
          event.currentTarget.disabled = true;
          try {
            await api().manage.createAssignment(orgId(context), {
              subject_kind: 'course',
              subject_id: subjectId,
              target_kind: kindSelect.value,
              target_id: kindSelect.value === 'everyone' ? '' : clean(targetSelect.value),
              schedule: {}
            });
            await renderAssignments();
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error, 'Could not create the assignment.'), false);
            event.currentTarget.disabled = false;
          }
        });
        body.querySelectorAll('[data-assign-remove]').forEach((button) => button.addEventListener('click', async () => {
          if (!(await confirmAction('Remove this assignment?'))) return;
          try { await api().manage.deleteAssignment(orgId(context), button.dataset.assignRemove); await renderAssignments(); }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error), false); }
        }));
      };
      await renderAssignments();
    }

    /* --------------------------------------------------------- progress */
    async function openProgress(){
      if (!clean(draft?.id)) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), (globalThis.PlatformLanguage?.text("training","m_03ac091b427199","Save the course first.") ?? "Save the course first."), false); return; }
      await loadUsersAndRoles();
      const dialog = modal(`<h2>${((v0) => globalThis.PlatformLanguage?.text("training","m_39c98dee119336",`Progress — ${v0}`,{v0}) ?? `Progress — ${v0}`)(esc(clean(draft.title)))}</h2><div data-progress-body>${String(stateHtml('Crunching the numbers'))}</div>`);
      const body = dialog.el.querySelector('[data-progress-body]');
      const renderReport = async () => {
        let report;
        try { report = obj((await api().manage.progress(orgId(context), clean(draft.id))).report); }
        catch (error) { body.innerHTML = `<div class="sty-state">${esc(statusError(error))}</div>`; return; }
        const lessons = arr(report.lessons);
        const reportUsers = arr(report.users);
        const knownUsers = (usersCache || []).map((user) => {
          const row = reportUsers.find((item) => clean(obj(item).user_id) === user.id);
          return { ...user, row: obj(row) };
        });
        const extraUsers = reportUsers.filter((row) => !(usersCache || []).some((user) => user.id === clean(obj(row).user_id)))
          .map((row) => ({ id: clean(obj(row).user_id), name: userName(obj(row).user_id), row: obj(row) }));
        const everyone = [...knownUsers, ...extraUsers];
        body.innerHTML = `
          <div style="overflow-x:auto"><table class="sty-table"><thead><tr><th>${(globalThis.PlatformLanguage?.text("training","m_23d5e0c82a8304","Person") ?? "Person")}</th>${String(lessons.map((lesson, index) => `<th title="${esc(lesson.title)}">${index + 1}${clean(obj(lesson.unlock).mode) === 'manual' ? ' <i class="fas fa-key" style="color:#c9a227"></i>' : ''}</th>`).join(''))}<th>${(globalThis.PlatformLanguage?.text("training","m_8cb6b086a0e69c","Done") ?? "Done")}</th></tr></thead>
          <tbody>${String(everyone.map((user) => {
            const completed = arr(user.row.completed_lesson_ids).map(clean);
            const manual = arr(user.row.manual_unlock_lesson_ids).map(clean);
            return `<tr><td style="white-space:nowrap">${esc(user.name)}</td>${lessons.map((lesson) => {
              const lessonId = clean(lesson.id);
              if (completed.includes(lessonId)) return '<td><span class="sty-progress-cell done" title="Completed"><i class="fas fa-check"></i></span></td>';
              if (clean(obj(lesson.unlock).mode) === 'manual') {
                return manual.includes(lessonId)
                  ? `<td><button type="button" class="sty-progress-cell unlockable" data-relock="${esc(lessonId)}" data-user="${esc(user.id)}" title="Unlocked — click to re-lock"><i class="fas fa-lock-open"></i></button></td>`
                  : `<td><button type="button" class="sty-progress-cell unlockable" data-unlock="${esc(lessonId)}" data-user="${esc(user.id)}" title="Locked — click to unlock for ${esc(user.name)}"><i class="fas fa-lock"></i></button></td>`;
              }
              return '<td><span class="sty-progress-cell open" title="Not completed"><i class="fas fa-minus"></i></span></td>';
            }).join('')}<td style="font-weight:1000">${Number(user.row.percent_complete || 0)}%</td></tr>`;
          }).join(''))}</tbody></table></div>
          <p class="sty-hint" style="margin-top:10px"><i class="fas fa-key" style="color:#c9a227"></i>${(globalThis.PlatformLanguage?.text("training","m_01b92ff235d614"," marks manual-unlock lessons — click a padlock to unlock or re-lock that lesson for that person.") ?? " marks manual-unlock lessons — click a padlock to unlock or re-lock that lesson for that person.")}</p>`;
        body.querySelectorAll('[data-unlock]').forEach((button) => button.addEventListener('click', async () => {
          try { await api().manage.unlockLesson(orgId(context), clean(draft.id), button.dataset.unlock, button.dataset.user); await renderReport(); }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error), false); }
        }));
        body.querySelectorAll('[data-relock]').forEach((button) => button.addEventListener('click', async () => {
          try { await api().manage.relockLesson(orgId(context), clean(draft.id), button.dataset.relock, button.dataset.user); await renderReport(); }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"), statusError(error), false); }
        }));
      };
      await renderReport();
    }

    /* --------------------------------------------------------------- root */
    const render = () => {
      if (destroyed) return;
      renderTop();
      if (view.name === 'library') { void renderLibrary(); return; }
      if (courseTab === 'lessons') { renderLessonsTab(); return; }
      if (courseTab === 'settings') { renderSettingsTab(); return; }
      if (courseTab === 'flashcards') { deckDraft ? renderDeckEditor() : renderMaterialList('deck'); return; }
      if (courseTab === 'quizzes') { quizDraft ? renderQuizEditor() : renderMaterialList('quiz'); return; }
    };
    render();

    return {
      destroy(){
        destroyed = true;
        clearTimeout(previewTimer);
        cancelAnimationFrame(previewResizeFrame);
        previewResizeObserver?.disconnect();
        window.removeEventListener('resize', syncPreviewSize);
        root.innerHTML = '';
      }
    };
  }

  Portal.apps?.registerPortalApp?.({
    id: 'portal.training_studio',
    tabId: 'training_studio',
    title: (globalThis.PlatformLanguage?.text("training","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"),
    icon: 'fa-chalkboard-user',
    order: 59,
    fullBleed: true,
    access: { applicationsAny: ['management'] },
    mount: mountStudio
  });
})();
