/* public/libraries/apps/training/app.js
 * Training — the learner experience. Mobile-first Duolingo-style course paths,
 * a fullscreen lesson player with a fungible step-renderer registry, plus
 * flashcard decks and practice quizzes.
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
  const shuffled = (list) => {
    const copy = [...arr(list)];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const normalizeAnswer = (value, caseSensitive) => {
    const text = clean(value).replace(/\s+/g, ' ');
    return caseSensitive ? text : text.toLowerCase();
  };

  /* ------------------------------------------------------------------ CSS */
  const css = `
    .trn-shell,.trn-sheet-back,.trn-player,.trn-celebrate,.trn-lightbox,.sty-phone-screen{--trn-ink:#16213a;--trn-muted:#69718a;--trn-line:#e5e8f0;--trn-bg:#f4f6fb;--trn-green:#22b567;--trn-gold:#f7b917;--trn-accent:var(--primary,#3b6ef6)}
    .trn-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:radial-gradient(1200px 500px at 50% -260px,#e8edfb 0,#f4f6fb 60%);color:var(--trn-ink);font-family:inherit;overflow:hidden}
    .trn-scroll{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:clamp(14px,2.6vw,30px);padding-bottom:calc(96px + env(safe-area-inset-bottom));box-sizing:border-box}
    .trn-page{width:min(680px,100%);margin:0 auto;display:grid;gap:16px}
    .trn-eyebrow{font-size:10px;font-weight:1000;letter-spacing:.12em;text-transform:uppercase;color:var(--trn-accent)}
    .trn-h1{margin:2px 0 0;font-size:clamp(24px,5vw,32px);font-weight:1000;line-height:1.05}
    .trn-sub{margin:6px 0 0;color:var(--trn-muted);font-size:13px;font-weight:750;line-height:1.45}
    .trn-btn{min-height:44px;border:0;border-radius:14px;background:#fff;color:#394260;border:1px solid var(--trn-line);padding:0 18px;display:inline-flex;align-items:center;justify-content:center;gap:9px;font:inherit;font-size:13px;font-weight:1000;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    .trn-btn:active{transform:scale(.97)}
    .trn-btn.primary{background:var(--trn-accent);border-color:transparent;color:#fff;box-shadow:0 8px 0 -3px color-mix(in srgb,var(--trn-accent) 72%,#000 14%),0 14px 26px color-mix(in srgb,var(--trn-accent) 34%,transparent)}
    .trn-btn.primary:active{box-shadow:0 3px 0 -2px color-mix(in srgb,var(--trn-accent) 72%,#000 14%);transform:translateY(3px)}
    .trn-btn.green{background:var(--trn-green);border-color:transparent;color:#fff;box-shadow:0 8px 0 -3px #158c4d,0 14px 26px rgba(34,181,103,.32)}
    .trn-btn.green:active{box-shadow:0 3px 0 -2px #158c4d;transform:translateY(3px)}
    .trn-btn.ghost{background:transparent;border-color:transparent;color:var(--trn-muted)}
    .trn-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;transform:none}
    .trn-state{min-height:200px;display:grid;place-items:center;text-align:center;color:var(--trn-muted);padding:26px}
    .trn-state>div{display:grid;justify-items:center;gap:10px}.trn-state i{font-size:30px;color:#aab2c8}.trn-state strong{color:#3c445f;font-size:14px}
    .trn-spinner{width:28px;height:28px;border:3.4px solid #e2e6f2;border-top-color:var(--trn-accent);border-radius:999px;animation:trn-spin .75s linear infinite}
    @keyframes trn-spin{to{transform:rotate(360deg)}}
    @keyframes trn-pop{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}
    @keyframes trn-rise{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}
    @keyframes trn-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--trn-accent) 42%,transparent)}70%{box-shadow:0 0 0 16px transparent}100%{box-shadow:0 0 0 0 transparent}}
    @keyframes trn-wiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-7deg)}75%{transform:rotate(7deg)}}
    @keyframes trn-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}

    /* Home: course cards */
    .trn-course-card{position:relative;border:1px solid var(--trn-line);border-radius:22px;background:#fff;padding:18px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:15px;align-items:center;cursor:pointer;text-align:left;font:inherit;color:inherit;box-shadow:0 10px 26px rgba(22,33,58,.06);transition:transform .14s ease,box-shadow .14s ease;animation:trn-rise .3s ease both}
    .trn-course-card:hover{transform:translateY(-2px);box-shadow:0 16px 34px rgba(22,33,58,.11)}
    .trn-course-icon{width:58px;height:58px;border-radius:19px;display:grid;place-items:center;font-size:24px;color:#fff;background:var(--trn-accent);box-shadow:inset 0 -4px 0 rgba(0,0,0,.14)}
    .trn-course-copy{min-width:0;display:grid;gap:5px}
    .trn-course-copy strong{font-size:16px;font-weight:1000}
    .trn-course-copy span{color:var(--trn-muted);font-size:12px;font-weight:800;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .trn-course-bar{height:9px;border-radius:99px;background:#edf0f7;overflow:hidden;margin-top:3px}
    .trn-course-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--trn-green),#4ed88f);transition:width .6s cubic-bezier(.22,1,.36,1)}
    .trn-ring{position:relative;width:56px;height:56px;display:grid;place-items:center}
    .trn-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
    .trn-ring b{font-size:12px;font-weight:1000}
    .trn-hero{border-radius:24px;padding:20px;background:linear-gradient(130deg,#1d2b53,#324b8f 60%,#3b6ef6);color:#fff;display:flex;align-items:center;gap:16px;box-shadow:0 18px 38px rgba(29,43,83,.28);animation:trn-rise .28s ease both}
    .trn-hero i{font-size:34px;opacity:.95;animation:trn-wiggle 3.2s ease-in-out infinite}
    .trn-hero strong{display:block;font-size:17px;font-weight:1000}
    .trn-hero span{display:block;margin-top:4px;font-size:12px;font-weight:800;color:#cdd8f7}

    /* Bottom tab bar */
    .trn-tabbar{position:absolute;left:0;right:0;bottom:0;z-index:30;display:flex;justify-content:center;pointer-events:none;padding:0 12px calc(12px + env(safe-area-inset-bottom))}
    .trn-tabbar-inner{pointer-events:auto;display:flex;gap:4px;background:rgba(255,255,255,.92);backdrop-filter:blur(16px);border:1px solid rgba(22,33,58,.09);border-radius:22px;padding:7px;box-shadow:0 18px 44px rgba(22,33,58,.18)}
    .trn-tab{min-width:86px;border:0;border-radius:16px;background:transparent;color:#8a92ab;padding:9px 12px;display:grid;justify-items:center;gap:3px;font:inherit;font-size:10px;font-weight:1000;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .15s ease,color .15s ease}
    .trn-tab i{font-size:17px}
    .trn-tab.active{background:color-mix(in srgb,var(--trn-accent) 12%,#fff);color:var(--trn-accent)}
    .trn-tab.active i{animation:trn-pop .3s ease}

    /* Course path */
    .trn-path-head{display:flex;align-items:center;gap:12px;animation:trn-rise .25s ease both}
    .trn-back{width:42px;height:42px;border:1px solid var(--trn-line);border-radius:14px;background:#fff;color:#4a5372;display:grid;place-items:center;cursor:pointer;font-size:15px;flex:none}
    .trn-path-title{min-width:0;flex:1}
    .trn-path-title h2{margin:0;font-size:19px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .trn-path-title span{display:block;margin-top:2px;color:var(--trn-muted);font-size:11px;font-weight:850}
    .trn-path{position:relative;padding:26px 0 60px}
    .trn-path svg.trn-trail{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    .trn-node-row{position:relative;display:flex;margin:0 0 78px;z-index:2}
    .trn-node-row:last-child{margin-bottom:0}
    .trn-node{position:relative;width:150px;display:grid;justify-items:center;gap:9px;border:0;background:transparent;font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;animation:trn-rise .35s ease both}
    .trn-bubble{position:relative;width:82px;height:82px;border-radius:999px;display:grid;place-items:center;font-size:29px;transition:transform .15s ease}
    .trn-node:active .trn-bubble{transform:scale(.94)}
    .trn-bubble .trn-bubble-face{position:absolute;inset:0;border-radius:999px;display:grid;place-items:center}
    .trn-node.completed .trn-bubble{background:var(--trn-green);color:#fff;box-shadow:inset 0 -6px 0 rgba(0,0,0,.16),0 10px 22px rgba(34,181,103,.35)}
    .trn-node.current .trn-bubble{background:var(--trn-accent);color:#fff;box-shadow:inset 0 -6px 0 rgba(0,0,0,.16),0 12px 26px color-mix(in srgb,var(--trn-accent) 42%,transparent);animation:trn-pulse 2s ease-out infinite}
    .trn-node.unlocked .trn-bubble{background:#fff;color:var(--trn-accent);border:3.5px solid var(--trn-accent);box-shadow:0 10px 22px rgba(22,33,58,.12)}
    .trn-node.locked .trn-bubble{background:#e3e7f0;color:#a2aac2;box-shadow:inset 0 -6px 0 rgba(0,0,0,.06)}
    .trn-node-label{max-width:150px;text-align:center;font-size:12px;font-weight:1000;line-height:1.25;color:#3c445f}
    .trn-node.locked .trn-node-label{color:#9aa2ba}
    .trn-node-check{position:absolute;right:-3px;bottom:-3px;width:28px;height:28px;border-radius:999px;background:var(--trn-gold);color:#7a5800;display:grid;place-items:center;font-size:12px;border:3px solid #f4f6fb;animation:trn-pop .35s ease both}
    .trn-start-flag{position:absolute;top:50%;left:calc(100% + 15px);transform:translateY(-50%);background:#fff;color:var(--trn-accent);border:2px solid var(--trn-accent);border-radius:12px;padding:6px 13px;font-size:11px;font-weight:1000;letter-spacing:.08em;white-space:nowrap;animation:trn-bob 1.6s ease-in-out infinite;z-index:3}
    .trn-start-flag:after{content:'';position:absolute;left:-7px;top:50%;transform:translateY(-50%) rotate(45deg);width:10px;height:10px;background:#fff;border-left:2px solid var(--trn-accent);border-bottom:2px solid var(--trn-accent)}
    .trn-node.flag-left .trn-start-flag{left:auto;right:calc(100% + 15px);animation-name:trn-bob-left}
    .trn-node.flag-left .trn-start-flag:after{left:auto;right:-7px;border-left:0;border-bottom:0;border-right:2px solid var(--trn-accent);border-top:2px solid var(--trn-accent)}
    @keyframes trn-bob{0%,100%{transform:translateY(-50%) translateX(0)}50%{transform:translateY(-50%) translateX(-5px)}}
    @keyframes trn-bob-left{0%,100%{transform:translateY(-50%) translateX(0)}50%{transform:translateY(-50%) translateX(5px)}}
    .trn-node .trn-score-pill{position:absolute;top:-10px;left:50%;transform:translateX(-50%);z-index:4;background:var(--trn-gold);color:#6c4d00;border-radius:99px;padding:3px 9px;font-size:10px;font-weight:1000;white-space:nowrap;box-shadow:0 4px 10px rgba(247,185,23,.4)}
    .trn-trophy-row{display:grid;justify-items:center;gap:8px;margin-top:8px;z-index:2;position:relative}
    .trn-trophy{width:74px;height:74px;border-radius:999px;display:grid;place-items:center;font-size:28px;background:#e3e7f0;color:#a2aac2;box-shadow:inset 0 -6px 0 rgba(0,0,0,.06)}
    .trn-trophy.earned{background:linear-gradient(140deg,#ffd34d,#f7a916);color:#7a5800;box-shadow:inset 0 -6px 0 rgba(0,0,0,.14),0 14px 30px rgba(247,169,22,.45);animation:trn-pop .5s ease both}
    .trn-trophy-label{font-size:11px;font-weight:1000;color:#8a92ab}

    /* Sheets & overlays */
    .trn-sheet-back{position:fixed;inset:0;z-index:2147483500;background:rgba(16,22,42,.55);backdrop-filter:blur(6px);display:grid;place-items:end center;animation:trn-fade .18s ease both}
    @keyframes trn-fade{from{opacity:0}to{opacity:1}}
    .trn-sheet{width:min(520px,100%);max-height:min(84dvh,720px);overflow:auto;background:#fff;border-radius:26px 26px 0 0;padding:22px 20px calc(22px + env(safe-area-inset-bottom));box-sizing:border-box;animation:trn-sheet-up .28s cubic-bezier(.22,1,.36,1) both}
    @keyframes trn-sheet-up{from{transform:translateY(60px);opacity:.4}to{transform:translateY(0);opacity:1}}
    @media(min-width:721px){.trn-sheet-back{place-items:center}.trn-sheet{border-radius:26px;animation:trn-pop .22s ease both}}
    .trn-sheet-grip{width:44px;height:5px;border-radius:99px;background:#e2e6f0;margin:0 auto 16px}
    .trn-sheet-head{display:flex;align-items:center;gap:14px}
    .trn-sheet-icon{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;font-size:23px;color:#fff;background:var(--trn-accent);box-shadow:inset 0 -4px 0 rgba(0,0,0,.14);flex:none}
    .trn-sheet-head h3{margin:0;font-size:19px;font-weight:1000}
    .trn-sheet-head p{margin:3px 0 0;color:var(--trn-muted);font-size:12px;font-weight:800}
    .trn-sheet-body{margin-top:14px;color:#454e6d;font-size:13.5px;font-weight:700;line-height:1.55}
    .trn-meta-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
    .trn-meta-pill{display:inline-flex;align-items:center;gap:6px;border-radius:99px;background:#f0f3fa;color:#4a5372;padding:7px 12px;font-size:11px;font-weight:1000}
    .trn-meta-pill.gold{background:#fdf3d7;color:#8a6400}
    .trn-meta-pill.green{background:#e3f8ec;color:#137a45}
    .trn-sheet-actions{display:grid;gap:9px;margin-top:20px}

    .trn-player{position:fixed;inset:0;z-index:2147483540;background:#fff;display:flex;flex-direction:column;animation:trn-player-in .3s cubic-bezier(.22,1,.36,1) both}
    @keyframes trn-player-in{from{transform:translateY(6%) scale(.98);opacity:0}to{transform:none;opacity:1}}
    .trn-player-top{flex:none;display:flex;align-items:center;gap:13px;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;box-sizing:border-box}
    .trn-player-close{width:40px;height:40px;border:0;border-radius:13px;background:#f0f2f8;color:#5a6382;display:grid;place-items:center;cursor:pointer;font-size:16px;flex:none}
    .trn-player-progress{flex:1;display:flex;gap:5px}
    .trn-player-progress i{flex:1;height:8px;border-radius:99px;background:#e8ebf3;overflow:hidden;position:relative}
    .trn-player-progress i:after{content:'';position:absolute;inset:0;border-radius:99px;background:var(--trn-green);transform:scaleX(0);transform-origin:left;transition:transform .4s cubic-bezier(.22,1,.36,1)}
    .trn-player-progress i.done:after{transform:scaleX(1)}
    .trn-player-body{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
    .trn-step{width:min(660px,100%);margin:0 auto;padding:10px 18px 30px;box-sizing:border-box;animation:trn-rise .3s ease both}
    .trn-player-foot{flex:none;padding:12px 18px calc(14px + env(safe-area-inset-bottom));box-sizing:border-box;display:grid;border-top:1px solid #eef0f6;background:#fff}
    .trn-player-foot .trn-btn{min-height:52px;font-size:15px;border-radius:16px}
    .trn-player-meta{display:none}

    /* Desktop lesson player: rail on the left (title, progress, controls),
     * content on the right. Mobile keeps the stacked layout. */
    @media(min-width:980px){
      .trn-player{display:grid;grid-template-columns:330px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}
      .trn-player:before{content:'';grid-area:1/1/4/2;background:linear-gradient(180deg,#f8fafc,#f2f5fa);border-right:1px solid #e8ebf3}
      .trn-player-top{grid-area:1/1/2/2;z-index:1;flex-direction:column;align-items:stretch;gap:22px;padding:30px 26px 0}
      .trn-player-top>div:not(.trn-player-progress){min-width:0}
      .trn-player-close{align-self:flex-start}
      .trn-player-meta{display:grid;gap:12px;z-index:1}
      .trn-player-meta .trn-player-meta-icon{width:60px;height:60px;border-radius:19px;display:grid;place-items:center;font-size:25px;color:#fff;background:var(--trn-accent,var(--primary,#3b6ef6));box-shadow:inset 0 -4px 0 rgba(0,0,0,.14)}
      .trn-player-meta h2{margin:0;font-size:22px;font-weight:1000;line-height:1.2}
      .trn-player-meta .trn-player-meta-step{color:var(--trn-muted);font-size:12px;font-weight:900}
      .trn-player-body{grid-area:1/2/4/3}
      .trn-player-body .trn-step{padding:36px 40px 44px}
      .trn-player-foot{grid-area:3/1/4/2;z-index:1;border-top:0;background:transparent;padding:0 26px 30px}
    }

    /* Content blocks */
    .trn-blocks{display:grid;gap:18px}
    .trn-block-heading{margin:6px 0 -6px;font-size:clamp(21px,4.4vw,27px);font-weight:1000;line-height:1.12}
    .trn-block-text{margin:0;font-size:15.5px;font-weight:650;line-height:1.65;color:#333c5c}
    .trn-block-callout{display:flex;gap:12px;border-radius:18px;background:#fdf6df;border:1px solid #f3e3ae;color:#6e5406;padding:15px;font-size:13.5px;font-weight:800;line-height:1.5}
    .trn-block-callout i{flex:none;margin-top:2px;font-size:17px}
    .trn-block-figure{margin:0;display:grid;gap:8px}
    .trn-block-figure img{width:100%;border-radius:18px;display:block;background:#eef0f6;min-height:120px;object-fit:cover}
    .trn-block-figure figcaption{color:var(--trn-muted);font-size:12px;font-weight:800;text-align:center}
    .trn-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
    .trn-gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;background:#eef0f6;cursor:zoom-in;transition:transform .15s ease}
    .trn-gallery img:active{transform:scale(.97)}
    .trn-block-video{position:relative;border-radius:18px;overflow:hidden;background:#0d1220}
    .trn-block-video video,.trn-block-video iframe{width:100%;aspect-ratio:16/9;display:block;border:0}
    .trn-block-doc{display:flex;align-items:center;gap:13px;border:1px solid var(--trn-line);border-radius:18px;background:#fff;padding:14px;text-decoration:none;color:inherit;box-shadow:0 6px 16px rgba(22,33,58,.05)}
    .trn-block-doc i{width:44px;height:44px;border-radius:13px;background:#feeceb;color:#d9382c;display:grid;place-items:center;font-size:18px;flex:none}
    .trn-block-doc strong{display:block;font-size:13.5px;font-weight:1000}
    .trn-block-doc span{display:block;margin-top:2px;color:var(--trn-muted);font-size:11px;font-weight:800}
    .trn-block-doc .fa-download{width:auto;height:auto;background:transparent;color:#8a92ab;margin-left:auto;font-size:15px}
    .trn-lightbox{position:fixed;inset:0;z-index:2147483560;background:rgba(8,12,26,.92);display:grid;place-items:center;cursor:zoom-out;animation:trn-fade .15s ease both}
    .trn-lightbox img{max-width:94vw;max-height:88dvh;border-radius:12px}

    /* Quiz runner */
    .trn-quiz{display:grid;gap:18px}
    .trn-quiz-count{color:var(--trn-muted);font-size:11px;font-weight:1000;letter-spacing:.1em;text-transform:uppercase}
    .trn-quiz-prompt{margin:0;font-size:clamp(19px,4.2vw,24px);font-weight:1000;line-height:1.25}
    .trn-quiz-image{width:100%;max-height:280px;object-fit:cover;border-radius:18px;background:#eef0f6}
    .trn-choices{display:grid;gap:10px}
    .trn-choice{position:relative;border:2px solid var(--trn-line);border-radius:17px;background:#fff;padding:15px 16px 15px 54px;text-align:left;font:inherit;font-size:14.5px;font-weight:850;color:#333c5c;cursor:pointer;transition:border-color .12s ease,background .12s ease,transform .12s ease;-webkit-tap-highlight-color:transparent}
    .trn-choice:active{transform:scale(.985)}
    .trn-choice .trn-choice-key{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:30px;height:30px;border-radius:10px;background:#f0f3fa;color:#69718a;display:grid;place-items:center;font-size:12px;font-weight:1000}
    .trn-choice.selected{border-color:var(--trn-accent);background:color-mix(in srgb,var(--trn-accent) 7%,#fff)}
    .trn-choice.correct{border-color:var(--trn-green);background:#e9faf1;color:#116b3d}
    .trn-choice.correct .trn-choice-key{background:var(--trn-green);color:#fff}
    .trn-choice.wrong{border-color:#e5484d;background:#fdf0f0;color:#9d2226;animation:trn-shake .4s ease}
    .trn-choice.wrong .trn-choice-key{background:#e5484d;color:#fff}
    .trn-choice:disabled{cursor:default}
    .trn-quiz-input{display:grid;gap:10px}
    .trn-quiz-input input{width:100%;box-sizing:border-box;border:2px solid var(--trn-line);border-radius:16px;background:#fff;padding:15px;font:inherit;font-size:16px;font-weight:850;outline:none}
    .trn-quiz-input input:focus{border-color:var(--trn-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--trn-accent) 12%,transparent)}
    .trn-quiz-input input.correct{border-color:var(--trn-green);background:#e9faf1}
    .trn-quiz-input input.wrong{border-color:#e5484d;background:#fdf0f0;animation:trn-shake .4s ease}
    .trn-feedback{border-radius:17px;padding:14px 15px;font-size:13px;font-weight:850;line-height:1.5;display:flex;gap:11px;animation:trn-rise .25s ease both}
    .trn-feedback i{flex:none;margin-top:1px;font-size:16px}
    .trn-feedback.good{background:#e3f8ec;color:#0f6b3c}
    .trn-feedback.bad{background:#fdeceb;color:#9d2226}
    .trn-quiz-actions{display:grid;gap:9px}

    /* Flashcards */
    .trn-card-stage{perspective:1200px;display:grid}
    .trn-flip-card{position:relative;min-height:280px;border-radius:24px;cursor:pointer;transform-style:preserve-3d;transition:transform .5s cubic-bezier(.3,1.2,.4,1);-webkit-tap-highlight-color:transparent}
    .trn-flip-card.flipped{transform:rotateY(180deg)}
    .trn-card-face{position:absolute;inset:0;border-radius:24px;backface-visibility:hidden;-webkit-backface-visibility:hidden;display:grid;place-items:center;padding:26px;box-sizing:border-box;text-align:center}
    .trn-card-face.front{background:#fff;border:2px solid var(--trn-line);box-shadow:0 16px 38px rgba(22,33,58,.11)}
    .trn-card-face.back{background:linear-gradient(150deg,#1d2b53,#33509b);color:#fff;transform:rotateY(180deg);box-shadow:0 16px 38px rgba(29,43,83,.3)}
    .trn-card-face>div{display:grid;gap:14px;justify-items:center}
    .trn-card-face img{max-width:100%;max-height:170px;border-radius:14px;object-fit:cover}
    .trn-card-face p{margin:0;font-size:clamp(16px,4vw,21px);font-weight:1000;line-height:1.35}
    .trn-card-face .trn-card-hint{font-size:11px;font-weight:1000;letter-spacing:.1em;text-transform:uppercase;opacity:.55}
    .trn-card-grade{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
    .trn-deck-remaining{text-align:center;color:var(--trn-muted);font-size:11px;font-weight:1000;letter-spacing:.08em;text-transform:uppercase}

    /* Results */
    .trn-result{display:grid;justify-items:center;gap:16px;text-align:center;padding:24px 0}
    .trn-result-ring{position:relative;width:150px;height:150px;display:grid;place-items:center}
    .trn-result-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
    .trn-result-ring circle.meter{transition:stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)}
    .trn-result-ring b{font-size:34px;font-weight:1000}
    .trn-result h3{margin:0;font-size:24px;font-weight:1000}
    .trn-result p{margin:0;color:var(--trn-muted);font-size:13px;font-weight:800}
    .trn-result-badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}

    /* Rows (decks/quizzes) */
    .trn-row-card{border:1px solid var(--trn-line);border-radius:20px;background:#fff;padding:16px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;cursor:pointer;text-align:left;font:inherit;color:inherit;box-shadow:0 8px 20px rgba(22,33,58,.05);transition:transform .13s ease,box-shadow .13s ease;animation:trn-rise .3s ease both}
    .trn-row-card:hover{transform:translateY(-2px);box-shadow:0 14px 28px rgba(22,33,58,.1)}
    .trn-row-icon{width:50px;height:50px;border-radius:16px;display:grid;place-items:center;font-size:20px;color:#fff;background:var(--trn-accent);box-shadow:inset 0 -4px 0 rgba(0,0,0,.14)}
    .trn-row-copy{min-width:0;display:grid;gap:4px}
    .trn-row-copy strong{font-size:14.5px;font-weight:1000}
    .trn-row-copy span{color:var(--trn-muted);font-size:11.5px;font-weight:800}
    .trn-row-side{display:grid;justify-items:end;gap:5px}
    .trn-chevron{color:#c2c8da;font-size:14px}
    .trn-new-pill{display:inline-flex;border-radius:99px;background:#e3f8ec;color:#137a45;padding:4px 10px;font-size:9.5px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase}
    .trn-row-card.locked{cursor:default;opacity:.68;background:#f6f8fc;box-shadow:none}
    .trn-row-card.locked:hover{transform:none;box-shadow:none}
    .trn-row-card.locked .trn-row-icon{background:#d6dbe8;box-shadow:inset 0 -4px 0 rgba(0,0,0,.07)}
    .trn-group-head{display:flex;align-items:center;gap:9px;margin:10px 0 2px}
    .trn-group-head:first-child{margin-top:0}
    .trn-group-head i{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-size:13px;color:#fff;background:var(--trn-accent)}
    .trn-group-head strong{font-size:13px;font-weight:1000}
    .trn-group-head span{margin-left:auto;color:var(--trn-muted);font-size:10.5px;font-weight:900}

    /* Celebration */
    .trn-celebrate{position:fixed;inset:0;z-index:2147483550;background:rgba(13,18,36,.9);backdrop-filter:blur(10px);display:grid;place-items:center;padding:22px;animation:trn-fade .2s ease both}
    .trn-celebrate-card{width:min(440px,100%);border-radius:28px;background:#fff;padding:30px 24px calc(24px + env(safe-area-inset-bottom));display:grid;justify-items:center;gap:14px;text-align:center;animation:trn-pop .4s cubic-bezier(.22,1.4,.36,1) both}
    .trn-celebrate-icon{width:92px;height:92px;border-radius:999px;display:grid;place-items:center;font-size:40px;background:linear-gradient(140deg,#ffd34d,#f7a916);color:#7a5800;box-shadow:0 18px 40px rgba(247,169,22,.45);animation:trn-wiggle 2s ease-in-out infinite}
    .trn-celebrate-card h3{margin:0;font-size:25px;font-weight:1000}
    .trn-celebrate-card p{margin:0;color:var(--trn-muted);font-size:13px;font-weight:800;line-height:1.5}
    .trn-unlock-list{display:grid;gap:8px;width:100%}
    .trn-unlock-item{display:flex;align-items:center;gap:11px;border:1px solid #f0e3b8;border-radius:15px;background:#fdf8e7;padding:11px 13px;text-align:left}
    .trn-unlock-item i{width:36px;height:36px;border-radius:11px;background:var(--trn-gold);color:#6c4d00;display:grid;place-items:center;font-size:14px;flex:none}
    .trn-unlock-item strong{font-size:12.5px;font-weight:1000}
    .trn-unlock-item span{display:block;color:#8a6400;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}
    canvas.trn-confetti{position:fixed;inset:0;z-index:2147483555;pointer-events:none}

    @media(max-width:720px){
      .trn-scroll{padding:12px 12px calc(100px + env(safe-area-inset-bottom))}
      .trn-node{width:132px}.trn-bubble{width:74px;height:74px;font-size:26px}
      .trn-course-card{padding:15px;border-radius:19px}
      .trn-gallery{grid-template-columns:1fr 1fr}
    }
  `;
  Portal.util?.injectCSS?.('training_app', css);

  function stateHtml(kind = 'loading', message = '', icon = ''){
    if (kind === 'loading') return `<div class="trn-state"><div><span class="trn-spinner"></span><strong>${esc(message || 'Loading')}</strong></div></div>`;
    const faIcon = icon || (kind === 'error' ? 'fa-triangle-exclamation' : 'fa-seedling');
    return `<div class="trn-state"><div><i class="fas ${faIcon}"></i><strong>${esc(message || 'Nothing here yet.')}</strong></div></div>`;
  }

  function ringHtml(percent, size = 56, stroke = 6, color = 'var(--trn-green)'){
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
    return `<span class="trn-ring" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="#edf0f7" stroke-width="${stroke}"/><circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/></svg>
      <b>${Math.round(percent)}%</b></span>`;
  }

  /* ------------------------------------------------------------ confetti */
  function fireConfetti(duration = 1800){
    const canvas = document.createElement('canvas');
    canvas.className = 'trn-confetti';
    document.body.appendChild(canvas);
    const context = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    const colors = ['#f7b917', '#22b567', '#3b6ef6', '#e5484d', '#8b5cf6', '#f97316'];
    const pieces = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 7,
      h: 8 + Math.random() * 8,
      vy: 2.4 + Math.random() * 3.4,
      vx: -1.6 + Math.random() * 3.2,
      rot: Math.random() * Math.PI,
      vr: -0.14 + Math.random() * 0.28,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));
    const startedAt = Date.now();
    let frame = 0;
    const tick = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((piece) => {
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.rot += piece.vr;
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.rot);
        context.fillStyle = piece.color;
        context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
        context.restore();
      });
      if (Date.now() - startedAt < duration + 1400) frame = requestAnimationFrame(tick);
      else canvas.remove();
    };
    frame = requestAnimationFrame(tick);
    setTimeout(() => { cancelAnimationFrame(frame); canvas.remove(); }, duration + 2600);
  }

  /* --------------------------------------------------------------- sheets */
  function openSheet(contentHtml, options = {}){
    const back = document.createElement('div');
    back.className = 'trn-sheet-back';
    back.innerHTML = `<div class="trn-sheet" role="dialog" aria-modal="true"><div class="trn-sheet-grip"></div>${contentHtml}</div>`;
    const close = () => { back.remove(); options.onClose?.(); };
    back.addEventListener('click', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    return { el: back, close };
  }

  function openLightbox(url){
    const box = document.createElement('div');
    box.className = 'trn-lightbox';
    box.innerHTML = `<img src="${esc(url)}" alt="">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  /* ------------------------------------------------------- quiz + cards */
  function questionIsCorrect(question, answer){
    if (clean(question.kind) === 'text_input') {
      const caseSensitive = question.case_sensitive === true;
      const given = normalizeAnswer(answer, caseSensitive);
      return arr(question.answers).some((expected) => normalizeAnswer(expected, caseSensitive) === given && given !== '');
    }
    return arr(question.correct_choice_ids).map(clean).includes(clean(answer));
  }

  function resultScreenHtml(result, options = {}){
    const percent = Math.round(result.score_percent || 0);
    const passInfo = options.passPercent > 0
      ? (result.passed
        ? `<span class="trn-meta-pill green"><i class="fas fa-circle-check"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_487e417b132c3c",` Passed &middot; needed ${v0}%`,{v0}) ?? ` Passed &middot; needed ${v0}%`)(esc(options.passPercent))}</span>`
        : `<span class="trn-meta-pill" style="background:#fdeceb;color:#9d2226"><i class="fas fa-rotate-left"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_be1bbd5e1c1995",` Needed ${v0}% — try again`,{v0}) ?? ` Needed ${v0}% — try again`)(esc(options.passPercent))}</span>`)
      : '';
    const size = 150, stroke = 12, radius = (size - stroke) / 2, circumference = 2 * Math.PI * radius;
    const color = options.passPercent > 0 && !result.passed ? '#e5484d' : 'var(--trn-green)';
    return `<div class="trn-result">
      <div class="trn-result-ring"><svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="#edf0f7" stroke-width="${stroke}"/><circle class="meter" cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}" data-target-offset="${circumference * (1 - percent / 100)}"/></svg><b>${percent}%</b></div>
      <h3>${esc(options.title || (result.passed ? 'Nice work!' : 'Keep practicing'))}</h3>
      <p>${esc(`${result.correct_count} of ${result.total_count} correct`)}${options.practice ? ' &middot; practice round' : ''}</p>
      <div class="trn-result-badges">${passInfo}${options.practice ? `<span class="trn-meta-pill"><i class="fas fa-dumbbell"></i>${(globalThis.PlatformLanguage?.text("training","m_99b6e147158a16"," Practice — nothing recorded against you") ?? " Practice — nothing recorded against you")}</span>` : ''}</div>
    </div>`;
  }

  /* requestAnimationFrame stalls in hidden/backgrounded tabs, so always pair
   * it with a timeout fallback for anything that must eventually render. */
  function afterPaint(callback){
    let done = false;
    const run = () => { if (!done) { done = true; callback(); } };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 90);
  }

  function animateResultRing(mount){
    const meter = mount.querySelector('.trn-result-ring circle.meter');
    if (meter) afterPaint(() => { meter.style.strokeDashoffset = meter.dataset.targetOffset; });
  }

  /* One question at a time with instant feedback. onFinish(result). */
  function renderQuizRunner(mount, options = {}){
    const questions = (options.shuffle === false ? arr(options.questions) : shuffled(options.questions)).filter((question) => clean(question.prompt));
    const passPercent = Number(options.passPercent || 0);
    let index = 0;
    let correct = 0;
    let finished = false;
    if (!questions.length) {
      mount.innerHTML = stateHtml('empty', 'This quiz has no questions yet.');
      options.onFinish?.({ score_percent: 100, correct_count: 0, total_count: 0, passed: true });
      return;
    }
    const finish = () => {
      if (finished) return;
      finished = true;
      const total = questions.length;
      const percent = Math.round((correct / total) * 100);
      const result = { score_percent: percent, correct_count: correct, total_count: total, passed: passPercent > 0 ? percent >= passPercent : true };
      mount.innerHTML = resultScreenHtml(result, { passPercent, practice: options.practice, title: options.resultTitle });
      animateResultRing(mount);
      options.onFinish?.(result);
    };
    const renderQuestion = () => {
      const question = obj(questions[index]);
      const isText = clean(question.kind) === 'text_input';
      mount.innerHTML = `<div class="trn-quiz">
        <div class="trn-quiz-count">${((v0,v1) => globalThis.PlatformLanguage?.text("training","m_e065fbf8c22410",`Question ${v0} of ${v1}`,{v0,v1}) ?? `Question ${v0} of ${v1}`)(index + 1,questions.length)}</div>
        <h3 class="trn-quiz-prompt">${String(esc(question.prompt))}</h3>
        ${String(clean(question.image) ? `<img class="trn-quiz-image" src="${esc(question.image)}" alt="">` : '')}
        ${String(isText
          ? `<div class="trn-quiz-input"><input type="text" placeholder="Type your answer" autocomplete="off" autocapitalize="off" data-quiz-input><button class="trn-btn primary" type="button" data-quiz-submit>Check</button></div>`
          : `<div class="trn-choices">${arr(question.choices).map((choice, choiceIndex) => `<button type="button" class="trn-choice" data-choice="${esc(choice.id)}"><span class="trn-choice-key">${String.fromCharCode(65 + choiceIndex)}</span>${clean(choice.image) ? `<img src="${esc(choice.image)}" alt="" style="display:block;max-height:120px;border-radius:10px;margin-bottom:8px">` : ''}${esc(choice.text)}</button>`).join('')}</div>`)}
        <div data-quiz-feedback></div>
        <div class="trn-quiz-actions" data-quiz-actions></div>
      </div>`;
      const feedback = mount.querySelector('[data-quiz-feedback]');
      const actions = mount.querySelector('[data-quiz-actions]');
      const showFeedback = (good, question) => {
        const correctText = clean(question.kind) === 'text_input'
          ? arr(question.answers)[0]
          : arr(question.choices).filter((choice) => arr(question.correct_choice_ids).includes(clean(choice.id))).map((choice) => choice.text).join(', ');
        feedback.innerHTML = `<div class="trn-feedback ${good ? 'good' : 'bad'}"><i class="fas ${good ? 'fa-circle-check' : 'fa-circle-xmark'}"></i><span><strong>${good ? 'Correct!' : 'Not quite.'}</strong>${!good && clean(correctText) ? ` The answer is <strong>${esc(correctText)}</strong>.` : ''}${clean(question.explanation) ? `<br>${esc(question.explanation)}` : ''}</span></div>`;
        actions.innerHTML = `<button class="trn-btn ${good ? 'green' : 'primary'}" type="button" data-quiz-next>${index + 1 >= questions.length ? 'See results' : 'Continue'}</button>`;
        actions.querySelector('[data-quiz-next]').addEventListener('click', () => {
          index += 1;
          if (index >= questions.length) finish();
          else renderQuestion();
        });
      };
      if (isText) {
        const input = mount.querySelector('[data-quiz-input]');
        const submit = mount.querySelector('[data-quiz-submit]');
        const check = () => {
          if (!clean(input.value)) return;
          const good = questionIsCorrect(question, input.value);
          if (good) correct += 1;
          input.classList.add(good ? 'correct' : 'wrong');
          input.disabled = true;
          submit.remove();
          showFeedback(good, question);
        };
        submit.addEventListener('click', check);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') check(); });
        setTimeout(() => input.focus(), 120);
      } else {
        mount.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', () => {
          const good = questionIsCorrect(question, button.dataset.choice);
          if (good) correct += 1;
          mount.querySelectorAll('[data-choice]').forEach((item) => {
            item.disabled = true;
            if (arr(question.correct_choice_ids).includes(clean(item.dataset.choice))) item.classList.add('correct');
          });
          if (!good) button.classList.add('wrong');
          showFeedback(good, question);
        }));
      }
    };
    renderQuestion();
  }

  /* Flashcards: flip cards self-grade ("Again" re-queues); MC/text graded. */
  function renderFlashcardsRunner(mount, options = {}){
    const sourceCards = arr(options.cards).filter((card) => clean(card.front_text) || clean(card.front_image));
    const queue = options.shuffle === false ? [...sourceCards] : shuffled(sourceCards);
    const passPercent = Number(options.passPercent || 0);
    const total = queue.length;
    let firstTryCorrect = 0;
    let seen = new Set();
    let finished = false;
    if (!total) {
      mount.innerHTML = stateHtml('empty', 'This deck has no cards yet.');
      options.onFinish?.({ score_percent: 100, correct_count: 0, total_count: 0, passed: true });
      return;
    }
    const finish = () => {
      if (finished) return;
      finished = true;
      const percent = Math.round((firstTryCorrect / total) * 100);
      const result = { score_percent: percent, correct_count: firstTryCorrect, total_count: total, passed: passPercent > 0 ? percent >= passPercent : true };
      mount.innerHTML = resultScreenHtml(result, { passPercent, practice: options.practice, title: options.resultTitle || (result.passed ? 'Deck complete!' : 'Almost there') });
      animateResultRing(mount);
      options.onFinish?.(result);
    };
    const grade = (card, good) => {
      const cardKey = clean(card.id) || JSON.stringify(card);
      const firstTry = !seen.has(cardKey);
      seen.add(cardKey);
      if (good && firstTry) firstTryCorrect += 1;
      if (!good && options.requeueMisses !== false) queue.push(card);
      if (!queue.length) finish();
      else renderCard();
    };
    const renderCard = () => {
      const card = obj(queue.shift());
      const kind = clean(card.kind || 'flip');
      const remaining = queue.length + 1;
      const face = (text, image, hint) => `<div>${clean(image) ? `<img src="${esc(image)}" alt="">` : ''}<p>${esc(text)}</p><span class="trn-card-hint">${esc(hint)}</span></div>`;
      if (kind === 'flip') {
        mount.innerHTML = `<div class="trn-quiz">
          <div class="trn-deck-remaining">${((v0,v1) => globalThis.PlatformLanguage?.text("training","m_64fac91f4c0325",`${v0} card${v1} to go`,{v0,v1}) ?? `${v0} card${v1} to go`)(remaining,remaining === 1 ? '' : 's')}</div>
          <div class="trn-card-stage"><div class="trn-flip-card" data-flip>
            <div class="trn-card-face front">${String(face(card.front_text, card.front_image, 'Tap to flip'))}</div>
            <div class="trn-card-face back">${String(face(card.back_text, card.back_image, 'How did you do?'))}</div>
          </div></div>
          <div class="trn-card-grade" data-grade hidden>
            <button class="trn-btn" type="button" data-again><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("training","m_d3a50bdb7cb63b"," Again") ?? " Again")}</button>
            <button class="trn-btn green" type="button" data-got><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("training","m_5f1fb193fdd3ee"," Got it") ?? " Got it")}</button>
          </div>`;
        const flipCard = mount.querySelector('[data-flip]');
        flipCard.addEventListener('click', () => {
          flipCard.classList.add('flipped');
          mount.querySelector('[data-grade]').hidden = false;
        });
        mount.querySelector('[data-again]').addEventListener('click', () => grade(card, false));
        mount.querySelector('[data-got]').addEventListener('click', () => grade(card, true));
        return;
      }
      /* Graded card — reuse the quiz runner for a single question. */
      const question = {
        id: card.id,
        kind: kind === 'text_input' ? 'text_input' : 'multiple_choice',
        prompt: card.front_text,
        image: card.front_image,
        choices: card.choices,
        correct_choice_ids: card.correct_choice_ids,
        answers: card.answers,
        case_sensitive: card.case_sensitive === true,
        explanation: card.back_text
      };
      const holder = document.createElement('div');
      mount.innerHTML = `<div class="trn-deck-remaining" style="margin-bottom:14px">${((v0,v1) => globalThis.PlatformLanguage?.text("training","m_64fac91f4c0325",`${v0} card${v1} to go`,{v0,v1}) ?? `${v0} card${v1} to go`)(remaining,remaining === 1 ? '' : 's')}</div>`;
      mount.appendChild(holder);
      let graded = false;
      renderQuizRunner(holder, {
        questions: [question],
        shuffle: false,
        passPercent: 0,
        practice: options.practice,
        onFinish(result){
          if (graded) return;
          graded = true;
          grade(card, result.correct_count > 0);
        }
      });
    };
    renderCard();
  }

  /* --------------------------------------------- step renderer registry */
  const stepKinds = {};
  function registerStepKind(kind, definition){
    if (clean(kind) && definition && typeof definition.render === 'function') stepKinds[clean(kind)] = definition;
  }
  window.TrainingStepKinds = window.TrainingStepKinds || {
    register: registerStepKind,
    get: (kind) => stepKinds[clean(kind)] || null,
    list: () => Object.keys(stepKinds)
  };

  function videoEmbedHtml(url, caption){
    const raw = clean(url);
    const youtube = raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
    const vimeo = raw.match(/vimeo\.com\/(\d+)/i);
    let media;
    if (youtube) media = `<iframe src="https://www.youtube.com/embed/${esc(youtube[1])}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    else if (vimeo) media = `<iframe src="https://player.vimeo.com/video/${esc(vimeo[1])}" allow="autoplay;fullscreen;picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    else media = `<video src="${esc(raw)}" controls playsinline preload="metadata"></video>`;
    return `<figure class="trn-block-figure"><div class="trn-block-video">${media}</div>${clean(caption) ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
  }

  function contentBlockHtml(blockValue){
    const block = obj(blockValue);
    const type = clean(block.type || 'text');
    if (type === 'heading') return `<h3 class="trn-block-heading">${esc(block.body || block.text)}</h3>`;
    if (type === 'callout') return `<div class="trn-block-callout"><i class="fas ${esc(clean(block.icon) || 'fa-lightbulb')}"></i><span>${esc(block.body || block.text)}</span></div>`;
    if (type === 'image') return `<figure class="trn-block-figure"><img src="${esc(block.url)}" alt="${esc(block.caption)}" loading="lazy" data-lightbox="${esc(block.url)}">${clean(block.caption) ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
    if (type === 'gallery') return `<figure class="trn-block-figure"><div class="trn-gallery">${arr(block.urls).map((url) => `<img src="${esc(url)}" alt="" loading="lazy" data-lightbox="${esc(url)}">`).join('')}</div>${clean(block.caption) ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
    if (type === 'video') return videoEmbedHtml(block.url, block.caption);
    if (type === 'document') return `<a class="trn-block-doc" href="${esc(block.url)}" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i><span style="min-width:0"><strong>${esc(clean(block.name) || 'Document')}</strong>${clean(block.description) ? `<span>${esc(block.description)}</span>` : ''}</span><i class="fas fa-download"></i></a>`;
    return `<p class="trn-block-text">${esc(block.body || block.text)}</p>`;
  }

  registerStepKind('content', {
    label: (globalThis.PlatformLanguage?.text("training","m_12873470ed5050","Content page") ?? "Content page"),
    render(mountEl, { step }){
      mountEl.innerHTML = `<div class="trn-blocks">${arr(obj(step.config).blocks).map(contentBlockHtml).join('')}</div>`;
      mountEl.querySelectorAll('[data-lightbox]').forEach((img) => img.addEventListener('click', () => openLightbox(img.dataset.lightbox)));
      return { complete: true };
    }
  });

  registerStepKind('quiz', {
    label: (globalThis.PlatformLanguage?.text("training","m_aeef2847f8a286","Quiz") ?? "Quiz"),
    render(mountEl, { step, controls, practice }){
      const config = obj(step.config);
      controls.setContinueEnabled(false);
      renderQuizRunner(mountEl, {
        questions: config.questions,
        shuffle: config.shuffle !== false,
        passPercent: Number(config.pass_percent || 0),
        practice,
        onFinish(result){
          controls.setResult({ ...result, kind: 'quiz' });
          if (config.required === true && !result.passed && !practice) {
            const retry = document.createElement('button');
            retry.className = 'trn-btn primary';
            retry.type = 'button';
            retry.style.marginTop = '14px';
            retry.innerHTML = '<i class="fas fa-rotate-left"></i> Try again';
            retry.addEventListener('click', () => stepKinds.quiz.render(mountEl, { step, controls, practice }));
            mountEl.querySelector('.trn-result')?.appendChild(retry);
            controls.setContinueEnabled(false);
          } else {
            controls.setContinueEnabled(true);
          }
        }
      });
      return {};
    }
  });

  registerStepKind('flashcards', {
    label: (globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards"),
    render(mountEl, { step, controls, practice, context }){
      const config = obj(step.config);
      controls.setContinueEnabled(false);
      const run = (cards) => renderFlashcardsRunner(mountEl, {
        cards,
        shuffle: true,
        passPercent: clean(config.mode) === 'test' ? Number(config.pass_percent || 0) : 0,
        practice: practice || clean(config.mode) !== 'test',
        onFinish(result){
          controls.setResult({ ...result, kind: 'flashcards' });
          if (config.required === true && clean(config.mode) === 'test' && !result.passed && !practice) {
            const retry = document.createElement('button');
            retry.className = 'trn-btn primary';
            retry.type = 'button';
            retry.style.marginTop = '14px';
            retry.innerHTML = '<i class="fas fa-rotate-left"></i> Run it back';
            retry.addEventListener('click', () => run(cards));
            mountEl.querySelector('.trn-result')?.appendChild(retry);
            controls.setContinueEnabled(false);
          } else {
            controls.setContinueEnabled(true);
          }
        }
      });
      const inlineCards = arr(config.cards);
      if (inlineCards.length) { run(inlineCards); return {}; }
      const deckId = clean(config.deck_id);
      if (!deckId) { mountEl.innerHTML = stateHtml('empty', 'No flashcards are attached to this step yet.'); controls.setContinueEnabled(true); return {}; }
      mountEl.innerHTML = stateHtml('loading', 'Shuffling the deck');
      window.TrainingAPI.me.deck(orgId(context), deckId)
        .then((result) => run(arr(obj(result.deck).cards)))
        .catch((error) => { mountEl.innerHTML = stateHtml('error', statusError(error, 'Could not load the flashcard deck.')); controls.setContinueEnabled(true); });
      return {};
    }
  });

  /* ------------------------------------------------------- lesson player */
  function openLessonPlayer(context, course, lesson, options = {}){
    const steps = arr(lesson.steps);
    const results = new Map();
    let index = 0;
    const player = document.createElement('div');
    player.className = 'trn-player';
    player.style.setProperty('--trn-accent', clean(course.color) || 'var(--primary,#3b6ef6)');
    player.innerHTML = `
      <div class="trn-player-top">
        <button type="button" class="trn-player-close" aria-label="${(globalThis.PlatformLanguage?.text("training","m_c0b4a73ed3bd7b","Close lesson") ?? "Close lesson")}"><i class="fas fa-xmark"></i></button>
        <div class="trn-player-meta">
          <span class="trn-player-meta-icon"><i class="fas ${String(esc(clean(lesson.icon) || 'fa-book-open'))}"></i></span>
          <h2>${String(esc(clean(lesson.title) || 'Lesson'))}</h2>
          <span class="trn-player-meta-step" data-player-meta-step></span>
        </div>
        <div class="trn-player-progress">${String(steps.map(() => '<i></i>').join('') || '<i></i>')}</div>
      </div>
      <div class="trn-player-body"><div class="trn-step" data-step-mount></div></div>
      <div class="trn-player-foot" style="display:flex;gap:9px">
        <button type="button" class="trn-btn" data-player-back aria-label="${(globalThis.PlatformLanguage?.text("training","m_7906020f77eea6","Previous page") ?? "Previous page")}" style="min-height:52px;border-radius:16px;padding:0 17px" hidden><i class="fas fa-arrow-left"></i></button>
        <button type="button" class="trn-btn green" data-player-continue disabled style="flex:1">${(globalThis.PlatformLanguage?.text("training","m_55ff00ed9ff361","Continue") ?? "Continue")}</button>
      </div>`;
    document.body.appendChild(player);
    const stepMount = player.querySelector('[data-step-mount]');
    const continueButton = player.querySelector('[data-player-continue]');
    const backButton = player.querySelector('[data-player-back]');
    const segments = player.querySelectorAll('.trn-player-progress i');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      player.remove();
      options.onClose?.();
    };
    player.querySelector('.trn-player-close').addEventListener('click', close);

    const submit = async () => {
      continueButton.disabled = true;
      continueButton.innerHTML = '<span class="trn-spinner" style="width:20px;height:20px;border-width:3px"></span>';
      try {
        const payload = { results: [...results.entries()].map(([stepId, result]) => ({ step_id: stepId, ...result })) };
        const response = await window.TrainingAPI.me.completeLesson(orgId(context), clean(course.id), clean(lesson.id), payload);
        close();
        options.onCompleted?.(response);
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("training","m_de9da7671834b2","Training") ?? "Training"), statusError(error, 'Could not save your progress.'), false);
        continueButton.disabled = false;
        continueButton.textContent = (globalThis.PlatformLanguage?.text("training","m_9383ab05e5224d","Finish lesson") ?? "Finish lesson");
      }
    };

    const renderStep = () => {
      const step = obj(steps[index]);
      segments.forEach((segment, segmentIndex) => segment.classList.toggle('done', segmentIndex < index));
      player.querySelector('.trn-player-body').scrollTop = 0;
      stepMount.innerHTML = '';
      const last = index >= steps.length - 1;
      continueButton.textContent = last ? (options.review ? 'Done' : 'Finish lesson') : 'Continue';
      continueButton.disabled = false;
      backButton.hidden = index === 0;
      const metaStep = player.querySelector('[data-player-meta-step]');
      if (metaStep) metaStep.textContent = ((v0,v1,v2) => globalThis.PlatformLanguage?.text("training","m_7d5da5b65b7d4e",`${v0}Page ${v1} of ${v2}`,{v0,v1,v2}) ?? `${v0}Page ${v1} of ${v2}`)(clean(step.title) ? `${clean(step.title)} · ` : '',index + 1,steps.length);
      const controls = {
        setContinueEnabled(enabled){
          /* A step already passed earlier in this session stays passable when
           * the learner navigates back to it. */
          continueButton.disabled = !enabled && !results.has(clean(step.id));
        },
        setResult(result){ if (clean(step.id)) results.set(clean(step.id), result); }
      };
      const renderer = stepKinds[clean(step.kind)] || {
        render(mountEl){
          mountEl.innerHTML = `<div class="trn-state"><div><i class="fas fa-puzzle-piece"></i><strong>${String(esc(clean(step.title) || 'New activity'))}</strong><span class="trn-sub">${((v1) => globalThis.PlatformLanguage?.text("training","m_aecca59403d41e",`This activity type ("${v1}") needs a newer version of the app. You can continue past it.`,{v1}) ?? `This activity type ("${v1}") needs a newer version of the app. You can continue past it.`)(esc(step.kind))}</span></div></div>`;
          return { complete: true };
        }
      };
      const holder = document.createElement('div');
      stepMount.appendChild(holder);
      renderer.render(holder, { step, context, controls, course, lesson, practice: options.review === true });
    };

    backButton.addEventListener('click', () => {
      if (index <= 0) return;
      index -= 1;
      renderStep();
    });
    continueButton.addEventListener('click', () => {
      if (index >= steps.length - 1) {
        if (options.review) close();
        else void submit();
        return;
      }
      index += 1;
      renderStep();
    });

    if (!steps.length) {
      stepMount.innerHTML = stateHtml('empty', 'This lesson has no pages yet.');
      continueButton.disabled = false;
      continueButton.textContent = options.review ? 'Done' : 'Finish lesson';
    } else {
      renderStep();
    }
    return { close };
  }

  function celebrationHtml(title, message, unlocks){
    return `<div class="trn-celebrate-card">
      <div class="trn-celebrate-icon"><i class="fas fa-medal"></i></div>
      <h3>${String(esc(title))}</h3>
      <p>${String(esc(message))}</p>
      ${String(unlocks.length ? `<div class="trn-unlock-list">${unlocks.map((item) => `<div class="trn-unlock-item"><i class="fas ${esc(item.icon)}"></i><span style="min-width:0"><span>${esc(item.kindLabel)} unlocked</span><strong>${esc(item.title)}</strong></span></div>`).join('')}</div>` : '')}
      <button class="trn-btn green" type="button" data-celebrate-done style="width:100%">${(globalThis.PlatformLanguage?.text("training","m_5b2199f496854c","Keep going") ?? "Keep going")}</button>
    </div>`;
  }

  /* --------------------------------------------------------- main mount */
  function mountTraining(root, context = {}){
    let destroyed = false;
    let tab = 'home';
    let courses = null;
    let decks = null;
    let quizzes = null;
    let openCourseId = '';
    let courseDetail = null;
    let activePlayer = null;
    let pathResizeObserver = null;

    root.innerHTML = `<div class="trn-shell" style="position:relative">
      <div class="trn-scroll"><div class="trn-page" data-training-page>${String(stateHtml('loading', 'Loading your training'))}</div></div>
      <div class="trn-tabbar"><div class="trn-tabbar-inner">
        <button type="button" class="trn-tab active" data-training-tab="home"><i class="fas fa-graduation-cap"></i>${(globalThis.PlatformLanguage?.text("training","m_578ca6f89c2534","Learn") ?? "Learn")}</button>
        <button type="button" class="trn-tab" data-training-tab="decks"><i class="fas fa-layer-group"></i>${(globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards")}</button>
        <button type="button" class="trn-tab" data-training-tab="quizzes"><i class="fas fa-bolt"></i>${(globalThis.PlatformLanguage?.text("training","m_67dfa219a28355","Quizzes") ?? "Quizzes")}</button>
      </div></div>
    </div>`;
    const page = root.querySelector('[data-training-page]');

    const writeRoute = (method, patch, options) => {
      if (Portal.navigation?.applying) return;
      Portal.navigation?.[method]?.(patch, options);
    };

    const setTabButtons = () => {
      root.querySelectorAll('[data-training-tab]').forEach((button) => button.classList.toggle('active', button.dataset.trainingTab === tab && !openCourseId));
    };

    /* ---- Home: course list */
    const renderHome = () => {
      if (!courses) { page.innerHTML = stateHtml('loading', 'Loading your training'); return; }
      if (!courses.length) { page.innerHTML = stateHtml('empty', 'No courses have been assigned to you yet.', 'fa-graduation-cap'); return; }
      page.innerHTML = `
        <div><div class="trn-eyebrow">${(globalThis.PlatformLanguage?.text("training","m_de9da7671834b2","Training") ?? "Training")}</div><h1 class="trn-h1">${(globalThis.PlatformLanguage?.text("training","m_4849926632a60b","Your courses") ?? "Your courses")}</h1><p class="trn-sub">${(globalThis.PlatformLanguage?.text("training","m_70293e4d7a8b07","Pick up where you left off — progress saves as you go.") ?? "Pick up where you left off — progress saves as you go.")}</p></div>
        <div style="display:grid;gap:12px">${String(courses.map((course, courseIndex) => `
          <button type="button" class="trn-course-card" data-open-course="${esc(course.id)}" style="--trn-accent:${esc(clean(course.color) || 'var(--primary,#3b6ef6)')};animation-delay:${courseIndex * 60}ms">
            <span class="trn-course-icon"><i class="fas ${esc(clean(course.icon) || 'fa-book')}"></i></span>
            <span class="trn-course-copy"><strong>${esc(course.title)}</strong><span>${esc(course.description)}</span>
              <span class="trn-course-bar"><i style="width:${Number(course.percent_complete || 0)}%"></i></span>
              <span style="color:var(--trn-muted);font-size:10.5px;font-weight:900">${Number(course.completed_count || 0)}/${Number(course.lesson_count || 0)} lessons${Number(course.percent_complete) >= 100 ? ' &middot; Completed 🎉' : (clean(course.next_lesson_title) ? ` &middot; Next: ${esc(course.next_lesson_title)}` : '')}</span>
            </span>
            ${ringHtml(Number(course.percent_complete || 0))}
          </button>`).join(''))}</div>`;
      page.querySelectorAll('[data-open-course]').forEach((button) => button.addEventListener('click', () => {
        openCourse(button.dataset.openCourse, { push: true });
      }));
    };

    /* ---- Course path */
    const drawTrail = (pathEl) => {
      const svg = pathEl.querySelector('svg.trn-trail');
      const bubbles = [...pathEl.querySelectorAll('.trn-bubble, .trn-trophy')];
      if (!svg || bubbles.length < 2) return;
      const box = pathEl.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      /* Each segment leaves a gap: it exits below a node's label and enters a
       * little above the next icon, so the dots never cross text or bubbles. */
      const anchors = bubbles.map((bubble) => {
        const rect = bubble.getBoundingClientRect();
        const node = bubble.closest('.trn-node') || bubble.closest('.trn-trophy-row') || bubble;
        const nodeRect = node.getBoundingClientRect();
        return {
          x: rect.left - box.left + rect.width / 2,
          enterY: rect.top - box.top - 26,
          exitY: nodeRect.bottom - box.top + 12
        };
      });
      const segments = [];
      for (let i = 1; i < anchors.length; i++) {
        const from = anchors[i - 1];
        const to = anchors[i];
        if (to.enterY - from.exitY < 18) continue;
        const midY = (from.exitY + to.enterY) / 2;
        segments.push(`M ${from.x} ${from.exitY} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.enterY}`);
      }
      svg.innerHTML = `<path d="${segments.join(' ')}" fill="none" stroke="#d9dfec" stroke-width="9" stroke-linecap="round" stroke-dasharray="1 20"/>`;
    };

    const lessonSheet = (lesson) => {
      const course = courseDetail;
      const state = clean(lesson.state);
      const accent = clean(course.color) || 'var(--primary,#3b6ef6)';
      const locked = state === 'locked';
      const meta = [
        `<span class="trn-meta-pill"><i class="fas fa-file-lines"></i>${((v0,v1) => globalThis.PlatformLanguage?.text("training","m_01f08ac1f4370c",` ${v0} page${v1}`,{v0,v1}) ?? ` ${v0} page${v1}`)(Number(lesson.step_count || 0),Number(lesson.step_count) === 1 ? '' : 's')}</span>`,
        Number(lesson.minutes) ? `<span class="trn-meta-pill"><i class="fas fa-clock"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_7a03154fed7e16",` ~${v0} min`,{v0}) ?? ` ~${v0} min`)(Number(lesson.minutes))}</span>` : '',
        lesson.has_required_test ? `<span class="trn-meta-pill gold"><i class="fas fa-star"></i>${(globalThis.PlatformLanguage?.text("training","m_66f1bbd2870d45"," Test to pass") ?? " Test to pass")}</span>` : '',
        state === 'completed' ? `<span class="trn-meta-pill green"><i class="fas fa-circle-check"></i>${((v0) => globalThis.PlatformLanguage?.text("training","m_8ee56142bdac6a",` Completed${v0}`,{v0}) ?? ` Completed${v0}`)(lesson.score_percent != null ? ` &middot; ${Math.round(lesson.score_percent)}%` : '')}</span>` : ''
      ].filter(Boolean).join('');
      const sheet = openSheet(`
        <div class="trn-sheet-head" style="--trn-accent:${esc(accent)}">
          <span class="trn-sheet-icon"><i class="fas ${esc(clean(lesson.icon) || 'fa-book-open')}"></i></span>
          <div style="min-width:0"><h3>${esc(lesson.title)}</h3><p>${esc(course.title)}</p></div>
        </div>
        <div class="trn-sheet-body">${esc(clean(lesson.summary) || 'Jump in when you are ready.')}</div>
        <div class="trn-meta-row">${meta}</div>
        <div class="trn-sheet-actions" style="--trn-accent:${esc(accent)}">
          ${locked
            ? `<button class="trn-btn" type="button" disabled><i class="fas fa-lock"></i> ${esc(clean(lesson.lock_reason) || 'Locked')}</button>`
            : state === 'completed'
              ? `<button class="trn-btn primary" type="button" data-lesson-review><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.text("training","m_94c37343f1a77c"," Review lesson") ?? " Review lesson")}</button>`
              : `<button class="trn-btn green" type="button" data-lesson-start><i class="fas fa-play"></i> ${state === 'current' ? 'Start lesson' : 'Jump in'}</button>`}
        </div>`);
      sheet.el.querySelector('[data-lesson-start]')?.addEventListener('click', () => { sheet.close(); startLesson(lesson, { review: false }); });
      sheet.el.querySelector('[data-lesson-review]')?.addEventListener('click', () => { sheet.close(); startLesson(lesson, { review: true }); });
    };

    const startLesson = (lessonState, options = {}) => {
      const full = arr(courseDetail.lessons).find((lesson) => clean(lesson.id) === clean(lessonState.id));
      if (!full || !Array.isArray(full.steps)) { showToast((globalThis.PlatformLanguage?.text("training","m_de9da7671834b2","Training") ?? "Training"), (globalThis.PlatformLanguage?.text("training","m_ae4878f57bdd1b","This lesson is not available yet.") ?? "This lesson is not available yet."), false); return; }
      writeRoute('push', { lesson: clean(full.id) }, { source: 'training-lesson', ownedKeys: ['lesson'] });
      activePlayer = openLessonPlayer(context, courseDetail, full, {
        review: options.review === true,
        onClose(){
          activePlayer = null;
          if (!Portal.navigation?.applying) Portal.navigation?.backOrClose?.({ lesson: '' }, { source: 'training-lesson' });
        },
        onCompleted(response){
          activePlayer = null;
          if (!Portal.navigation?.applying) Portal.navigation?.backOrClose?.({ lesson: '' }, { source: 'training-lesson' });
          courseDetail = obj(response.course);
          courses = null;
          decks = null;
          quizzes = null;
          renderCoursePath();
          void loadCourses();
          fireConfetti();
          const unlocks = [];
          arr(response.unlocked_deck_ids).forEach(() => unlocks.push({ icon: 'fa-layer-group', kindLabel: 'Flashcard deck', title: (globalThis.PlatformLanguage?.text("training","m_e33c3b334c8422","Check the Flashcards tab") ?? "Check the Flashcards tab") }));
          arr(response.unlocked_quiz_ids).forEach(() => unlocks.push({ icon: 'fa-bolt', kindLabel: 'Practice quiz', title: (globalThis.PlatformLanguage?.text("training","m_3b4d32318f1e9c","Check the Quizzes tab") ?? "Check the Quizzes tab") }));
          const overlay = document.createElement('div');
          overlay.className = 'trn-celebrate';
          overlay.innerHTML = celebrationHtml(
            response.course_completed ? 'Course complete!' : 'Lesson complete!',
            response.course_completed
              ? `You finished ${clean(courseDetail.title)} — every lesson, done. Legend.`
              : `${Number(courseDetail.completed_count)} of ${Number(courseDetail.lesson_count)} lessons down in ${clean(courseDetail.title)}.`,
            unlocks
          );
          overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
          overlay.querySelector('[data-celebrate-done]').addEventListener('click', () => overlay.remove());
          document.body.appendChild(overlay);
        }
      });
    };

    const renderCoursePath = () => {
      const course = courseDetail;
      if (!course) { page.innerHTML = stateHtml('loading', 'Charting your course'); return; }
      const accent = clean(course.color) || 'var(--primary,#3b6ef6)';
      const lessons = arr(course.lessons);
      const complete = Number(course.percent_complete) >= 100;
      page.innerHTML = `<div style="--trn-accent:${String(esc(accent))};display:grid;gap:4px">
        <div class="trn-path-head">
          <button type="button" class="trn-back" data-course-back aria-label="${(globalThis.PlatformLanguage?.text("training","m_54b57ecb8a52cc","Back to courses") ?? "Back to courses")}"><i class="fas fa-arrow-left"></i></button>
          <div class="trn-path-title"><h2>${String(esc(course.title))}</h2><span>${((v2,v3,v4) => globalThis.PlatformLanguage?.text("training","m_7054f5e19d6e7d",`${v2}/${v3} lessons &middot; ${v4}% complete`,{v2,v3,v4}) ?? `${v2}/${v3} lessons &middot; ${v4}% complete`)(Number(course.completed_count),Number(course.lesson_count),Number(course.percent_complete))}</span></div>
          ${String(ringHtml(Number(course.percent_complete || 0), 46, 5))}
        </div>
        <div class="trn-path" data-path>
          <svg class="trn-trail"></svg>
          ${String(lessons.map((lesson, lessonIndex) => {
            const align = lessonIndex % 2 === 0 ? 'flex-start' : 'flex-end';
            const pad = lessonIndex % 2 === 0 ? 'margin-left:8%' : 'margin-right:8%';
            const state = clean(lesson.state);
            return `<div class="trn-node-row" style="justify-content:${align}">
              <button type="button" class="trn-node ${esc(state)} ${lessonIndex % 2 === 1 ? 'flag-left' : ''}" data-lesson-node="${esc(lesson.id)}" style="${pad};animation-delay:${lessonIndex * 70}ms">
                ${state === 'completed' && lesson.score_percent != null && lesson.has_required_test ? `<span class="trn-score-pill">${Math.round(lesson.score_percent)}%</span>` : ''}
                <span class="trn-bubble"><span class="trn-bubble-face"><i class="fas ${esc(state === 'locked' ? 'fa-lock' : (clean(lesson.icon) || 'fa-book-open'))}"></i></span>
                ${state === 'current' ? '<span class="trn-start-flag">START</span>' : ''}
                ${state === 'completed' ? '<span class="trn-node-check"><i class="fas fa-check"></i></span>' : ''}</span>
                <span class="trn-node-label">${esc(lesson.title)}</span>
              </button>
            </div>`;
          }).join(''))}
          <div class="trn-trophy-row"><span class="trn-trophy ${String(complete ? 'earned' : '')}"><i class="fas fa-trophy"></i></span><span class="trn-trophy-label">${String(complete ? 'Course complete!' : 'Finish every lesson')}</span></div>
        </div>
      </div>`;
      page.querySelector('[data-course-back]').addEventListener('click', () => closeCourse({ back: true }));
      page.querySelectorAll('[data-lesson-node]').forEach((button) => button.addEventListener('click', () => {
        const lesson = lessons.find((item) => clean(item.id) === button.dataset.lessonNode);
        if (lesson) lessonSheet(lesson);
      }));
      const pathEl = page.querySelector('[data-path]');
      afterPaint(() => drawTrail(pathEl));
      pathResizeObserver?.disconnect();
      if (window.ResizeObserver) {
        pathResizeObserver = new ResizeObserver(() => drawTrail(pathEl));
        pathResizeObserver.observe(pathEl);
      }
    };

    /* ---- Decks & quizzes tabs */
    const rowCard = (item, kind, index) => {
      const locked = item.locked === true;
      const accent = clean(item.color) || 'var(--primary,#3b6ef6)';
      const count = kind === 'deck' ? arr(item.cards).length : arr(item.questions).length;
      const unit = kind === 'deck' ? 'card' : 'question';
      const best = item.best_score_percent;
      const detail = locked
        ? clean(item.unlock_hint) || 'Locked for now'
        : `${count} ${unit}${count === 1 ? '' : 's'}${best != null ? ` · Best ${best}%` : ''}${Number(item.attempt_count) ? ` · ${Number(item.attempt_count)} run${Number(item.attempt_count) === 1 ? '' : 's'}` : ''}`;
      return `<button type="button" class="trn-row-card ${locked ? 'locked' : ''}" data-open-${kind}="${esc(item.id)}" data-row-locked="${locked ? '1' : ''}" style="--trn-accent:${esc(accent)};animation-delay:${index * 50}ms">
        <span class="trn-row-icon"><i class="fas ${esc(locked ? 'fa-lock' : (clean(item.icon) || (kind === 'deck' ? 'fa-layer-group' : 'fa-bolt')))}"></i></span>
        <span class="trn-row-copy"><strong>${esc(item.title)}</strong><span>${locked ? `<i class="fas fa-lock" style="font-size:9px"></i> ${esc(detail)}` : esc(detail)}</span></span>
        <span class="trn-row-side">${!locked && clean(item.source) !== 'assigned' && !Number(item.attempt_count) ? `<span class="trn-new-pill">${(globalThis.PlatformLanguage?.text("training","m_758468686ac8bc","Unlocked") ?? "Unlocked")}</span>` : ''}${locked ? '' : '<i class="fas fa-chevron-right trn-chevron"></i>'}</span>
      </button>`;
    };

    const groupedRows = (items, kind) => {
      const groups = new Map();
      arr(items).forEach((item) => {
        const key = clean(item.course_title) || 'General practice';
        if (!groups.has(key)) groups.set(key, { color: clean(item.color), items: [] });
        groups.get(key).items.push(item);
      });
      let index = 0;
      return [...groups.entries()].map(([title, group]) => {
        const unlockedCount = group.items.filter((item) => item.locked !== true).length;
        return `<div class="trn-group-head" style="--trn-accent:${String(esc(group.color || 'var(--primary,#3b6ef6)'))}"><i class="fas fa-graduation-cap"></i><strong>${String(esc(title))}</strong><span>${((v2,v3) => globalThis.PlatformLanguage?.text("training","m_b06b6cdb53b923",`${v2}/${v3} unlocked`,{v2,v3}) ?? `${v2}/${v3} unlocked`)(unlockedCount,group.items.length)}</span></div>
          ${String(group.items.map((item) => rowCard(item, kind, index++)).join(''))}`;
      }).join('');
    };

    const runFullscreen = (title, accent, renderBody) => {
      const player = document.createElement('div');
      player.className = 'trn-player';
      player.style.setProperty('--trn-accent', accent);
      player.innerHTML = `
        <div class="trn-player-top">
          <button type="button" class="trn-player-close" aria-label="${(globalThis.PlatformLanguage?.text("training","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
          <div style="flex:1;font-size:14px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(esc(title))}</div>
        </div>
        <div class="trn-player-body"><div class="trn-step" data-run-mount></div></div>`;
      document.body.appendChild(player);
      const close = () => player.remove();
      player.querySelector('.trn-player-close').addEventListener('click', close);
      renderBody(player.querySelector('[data-run-mount]'), close);
      return { close };
    };

    const openDeck = async (deckId) => {
      try {
        const result = await window.TrainingAPI.me.deck(orgId(context), deckId);
        const deck = obj(result.deck);
        const accent = clean(deck.color) || 'var(--primary,#3b6ef6)';
        const sheet = openSheet(`
          <div class="trn-sheet-head" style="--trn-accent:${String(esc(accent))}">
            <span class="trn-sheet-icon"><i class="fas ${String(esc(clean(deck.icon) || 'fa-layer-group'))}"></i></span>
            <div style="min-width:0"><h3>${String(esc(deck.title))}</h3><p>${((v3) => globalThis.PlatformLanguage?.text("training","m_cd2aec337b5bb8",`${v3} cards &middot; shuffled each run`,{v3}) ?? `${v3} cards &middot; shuffled each run`)(arr(deck.cards).length)}</p></div>
          </div>
          <div class="trn-sheet-body">${String(esc(clean(deck.description) || 'Practice at your own pace — misses come back around until you get them.'))}</div>
          <div class="trn-meta-row">${String(deck.best_score_percent != null ? `<span class="trn-meta-pill green"><i class="fas fa-ranking-star"></i> Best ${deck.best_score_percent}%</span>` : '')}${String(Number(deck.attempt_count) ? `<span class="trn-meta-pill"><i class="fas fa-clock-rotate-left"></i> ${Number(deck.attempt_count)} previous run${Number(deck.attempt_count) === 1 ? '' : 's'}</span>` : '')}</div>
          <div class="trn-sheet-actions" style="--trn-accent:${String(esc(accent))}"><button class="trn-btn green" type="button" data-deck-play><i class="fas fa-play"></i>${(globalThis.PlatformLanguage?.text("training","m_e1d292e23ae73a"," Practice deck") ?? " Practice deck")}</button></div>`);
        sheet.el.querySelector('[data-deck-play]').addEventListener('click', () => {
          sheet.close();
          runFullscreen(deck.title, accent, (mountEl) => {
            renderFlashcardsRunner(mountEl, {
              cards: deck.cards,
              shuffle: deck.shuffle !== false,
              passPercent: 0,
              practice: true,
              onFinish(resultValue){
                window.TrainingAPI.me.recordAttempt(orgId(context), { subject_kind: 'deck', subject_id: deckId, practice: true, ...resultValue }).then(() => { decks = null; if (tab === 'decks' && !openCourseId) void loadTab(); }).catch(() => null);
              }
            });
          });
        });
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards"), statusError(error, 'Could not open the deck.'), false);
      }
    };

    const openQuiz = async (quizId) => {
      try {
        const result = await window.TrainingAPI.me.quiz(orgId(context), quizId);
        const quiz = obj(result.quiz);
        const accent = clean(quiz.color) || 'var(--primary,#3b6ef6)';
        const sheet = openSheet(`
          <div class="trn-sheet-head" style="--trn-accent:${String(esc(accent))}">
            <span class="trn-sheet-icon"><i class="fas ${String(esc(clean(quiz.icon) || 'fa-bolt'))}"></i></span>
            <div style="min-width:0"><h3>${String(esc(quiz.title))}</h3><p>${((v3,v4) => globalThis.PlatformLanguage?.text("training","m_e9d27ca2e8fe90",`${v3} questions &middot; pass at ${v4}%`,{v3,v4}) ?? `${v3} questions &middot; pass at ${v4}%`)(arr(quiz.questions).length,Number(quiz.pass_percent || 0))}</p></div>
          </div>
          <div class="trn-sheet-body">${String(esc(clean(quiz.description) || 'Take a scored run, or warm up with practice mode first.'))}</div>
          <div class="trn-meta-row">${String(quiz.best_score_percent != null ? `<span class="trn-meta-pill green"><i class="fas fa-ranking-star"></i> Best ${quiz.best_score_percent}%</span>` : '')}${String(Number(quiz.attempt_count) ? `<span class="trn-meta-pill"><i class="fas fa-clock-rotate-left"></i> ${Number(quiz.attempt_count)} attempt${Number(quiz.attempt_count) === 1 ? '' : 's'}</span>` : '')}</div>
          <div class="trn-sheet-actions" style="--trn-accent:${String(esc(accent))}">
            <button class="trn-btn green" type="button" data-quiz-take><i class="fas fa-bolt"></i>${(globalThis.PlatformLanguage?.text("training","m_39fc7a77092cc6"," Take the quiz") ?? " Take the quiz")}</button>
            <button class="trn-btn" type="button" data-quiz-practice><i class="fas fa-dumbbell"></i>${(globalThis.PlatformLanguage?.text("training","m_71c0ec946a8844"," Practice run") ?? " Practice run")}</button>
          </div>`);
        const run = (practice) => {
          sheet.close();
          runFullscreen(`${quiz.title}${practice ? ' — practice' : ''}`, accent, (mountEl) => {
            renderQuizRunner(mountEl, {
              questions: quiz.questions,
              shuffle: quiz.shuffle !== false,
              passPercent: practice ? 0 : Number(quiz.pass_percent || 0),
              practice,
              onFinish(resultValue){
                window.TrainingAPI.me.recordAttempt(orgId(context), { subject_kind: 'quiz', subject_id: quizId, practice, ...resultValue }).then(() => { quizzes = null; if (tab === 'quizzes' && !openCourseId) void loadTab(); }).catch(() => null);
                if (!practice && resultValue.passed) fireConfetti(1200);
              }
            });
          });
        };
        sheet.el.querySelector('[data-quiz-take]').addEventListener('click', () => run(false));
        sheet.el.querySelector('[data-quiz-practice]').addEventListener('click', () => run(true));
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("training","m_67dfa219a28355","Quizzes") ?? "Quizzes"), statusError(error, 'Could not open the quiz.'), false);
      }
    };

    const bindRowClicks = (kind, open) => {
      page.querySelectorAll(`[data-open-${kind}]`).forEach((button) => button.addEventListener('click', () => {
        if (button.dataset.rowLocked === '1') {
          const hint = button.querySelector('.trn-row-copy span')?.textContent || (globalThis.PlatformLanguage?.text("training","m_a3cbf13063611d","Keep going in the course to unlock this.") ?? "Keep going in the course to unlock this.");
          showToast((globalThis.PlatformLanguage?.text("training","m_79049afed663af","Locked") ?? "Locked"), clean(hint), false);
          return;
        }
        void open(button.dataset[kind === 'deck' ? 'openDeck' : 'openQuiz']);
      }));
    };

    const renderDecks = () => {
      if (!decks) { page.innerHTML = stateHtml('loading', 'Fetching your decks'); return; }
      page.innerHTML = `<div><div class="trn-eyebrow">${(globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards")}</div><h1 class="trn-h1">${(globalThis.PlatformLanguage?.text("training","m_1be9f9bb2ecd9e","Your decks") ?? "Your decks")}</h1><p class="trn-sub">${(globalThis.PlatformLanguage?.text("training","m_0182ef9e2d918e","Each course brings its own decks — some open right away, others unlock as you finish lessons.") ?? "Each course brings its own decks — some open right away, others unlock as you finish lessons.")}</p></div>
        ${String(decks.length ? `<div style="display:grid;gap:11px">${groupedRows(decks, 'deck')}</div>` : stateHtml('empty', 'Your courses have no flashcard decks yet.', 'fa-layer-group'))}`;
      bindRowClicks('deck', openDeck);
    };

    const renderQuizzes = () => {
      if (!quizzes) { page.innerHTML = stateHtml('loading', 'Sharpening the questions'); return; }
      page.innerHTML = `<div><div class="trn-eyebrow">${(globalThis.PlatformLanguage?.text("training","m_4a5dfd551fdb16","Practice quizzes") ?? "Practice quizzes")}</div><h1 class="trn-h1">${(globalThis.PlatformLanguage?.text("training","m_75aac77885b038","Your quizzes") ?? "Your quizzes")}</h1><p class="trn-sub">${(globalThis.PlatformLanguage?.text("training","m_64dec87d865ea3","Scored runs count toward your best. Practice runs are just for you.") ?? "Scored runs count toward your best. Practice runs are just for you.")}</p></div>
        ${String(quizzes.length ? `<div style="display:grid;gap:11px">${groupedRows(quizzes, 'quiz')}</div>` : stateHtml('empty', 'Your courses have no practice quizzes yet.', 'fa-bolt'))}`;
      bindRowClicks('quiz', openQuiz);
    };

    /* ---- data + routing */
    const render = () => {
      if (destroyed) return;
      setTabButtons();
      if (openCourseId) { renderCoursePath(); return; }
      if (tab === 'decks') renderDecks();
      else if (tab === 'quizzes') renderQuizzes();
      else renderHome();
    };

    const loadCourses = async () => {
      try {
        const result = await window.TrainingAPI.me.courses(orgId(context));
        courses = arr(result.courses);
        if (!destroyed && !openCourseId && tab === 'home') render();
      } catch (error) {
        courses = [];
        if (!destroyed && !openCourseId && tab === 'home') page.innerHTML = stateHtml('error', statusError(error, 'Could not load your training.'));
      }
    };

    const loadTab = async () => {
      if (tab === 'decks' && !decks) {
        render();
        try { decks = arr((await window.TrainingAPI.me.decks(orgId(context))).decks); } catch (error) { decks = []; showToast((globalThis.PlatformLanguage?.text("training","m_a912b2f761593a","Flashcards") ?? "Flashcards"), statusError(error), false); }
        render();
      } else if (tab === 'quizzes' && !quizzes) {
        render();
        try { quizzes = arr((await window.TrainingAPI.me.quizzes(orgId(context))).quizzes); } catch (error) { quizzes = []; showToast((globalThis.PlatformLanguage?.text("training","m_67dfa219a28355","Quizzes") ?? "Quizzes"), statusError(error), false); }
        render();
      } else if (tab === 'home' && !courses) {
        render();
        await loadCourses();
      } else {
        render();
      }
    };

    const openCourse = (courseId, options = {}) => {
      openCourseId = clean(courseId);
      courseDetail = null;
      if (options.push) writeRoute('push', { course: openCourseId }, { source: 'training-course', ownedKeys: ['course'] });
      render();
      window.TrainingAPI.me.course(orgId(context), openCourseId).then((result) => {
        if (destroyed || openCourseId !== clean(courseId)) return;
        courseDetail = obj(result.course);
        render();
        if (options.lessonId) {
          const lesson = arr(courseDetail.lessons).find((item) => clean(item.id) === clean(options.lessonId));
          if (lesson && clean(lesson.state) !== 'locked') startLesson(lesson, { review: clean(lesson.state) === 'completed' });
        }
      }).catch((error) => {
        if (destroyed) return;
        openCourseId = '';
        render();
        showToast((globalThis.PlatformLanguage?.text("training","m_de9da7671834b2","Training") ?? "Training"), statusError(error, 'Could not open the course.'), false);
      });
    };

    const closeCourse = (options = {}) => {
      openCourseId = '';
      courseDetail = null;
      courses = null;
      if (options.back && !Portal.navigation?.applying) Portal.navigation?.backOrClose?.({ course: '', lesson: '' }, { source: 'training-course' });
      void loadTab();
    };

    root.querySelectorAll('[data-training-tab]').forEach((button) => button.addEventListener('click', () => {
      const nextTab = button.dataset.trainingTab;
      if (openCourseId) { openCourseId = ''; courseDetail = null; }
      if (tab === nextTab && !openCourseId) return;
      tab = nextTab;
      writeRoute('push', { trainingTab: tab, course: '', lesson: '' }, { source: 'training-tab', ownedKeys: ['trainingTab', 'course', 'lesson'] });
      void loadTab();
    }));

    const handle = {
      applyRoute(route = {}){
        if (destroyed || route.tab !== 'training') return;
        const nextTab = ['home', 'decks', 'quizzes'].includes(clean(route.trainingTab)) ? clean(route.trainingTab) : 'home';
        const nextCourse = clean(route.course);
        if (activePlayer && !clean(route.lesson)) { activePlayer.close(); activePlayer = null; }
        if (nextCourse && nextCourse !== openCourseId) { tab = nextTab; openCourse(nextCourse, { lessonId: clean(route.lesson) }); return; }
        if (!nextCourse && openCourseId) { tab = nextTab; closeCourse(); return; }
        if (nextTab !== tab) { tab = nextTab; void loadTab(); }
      },
      destroy(){
        destroyed = true;
        pathResizeObserver?.disconnect();
        activePlayer?.close?.();
        if (activeTrainingHandle === handle) activeTrainingHandle = null;
        root.innerHTML = '';
      }
    };
    activeTrainingHandle = handle;
    const initialRoute = Portal.navigation?.read?.() || {};
    if (initialRoute.tab === 'training' && (clean(initialRoute.trainingTab) || clean(initialRoute.course))) {
      handle.applyRoute(initialRoute);
      /* A routed `trainingTab=home` already matches the local default, so the
       * route handler has no state transition to trigger. Start the initial
       * request explicitly instead of leaving the loading screen waiting for
       * a later navigation event. */
      if (!openCourseId && tab === 'home' && !courses) void loadTab();
    } else void loadTab();
    return handle;
  }

  let activeTrainingHandle = null;
  Portal.navigation?.registerHandler?.('training-route', {
    priority: 420,
    immediate: true,
    apply(route){ activeTrainingHandle?.applyRoute?.(route); }
  });

  /* Shared with the Training Studio: live previews reuse the exact learner
   * renderers, so what editors see is what crews get. */
  window.TrainingViewer = {
    stepKinds,
    contentBlockHtml,
    renderQuizRunner,
    renderFlashcardsRunner,
    previewLesson(context, course, lesson){
      return openLessonPlayer(context, obj(course), obj(lesson), { review: true });
    }
  };

  Portal.apps?.registerPortalApp?.({
    id: 'portal.training',
    tabId: 'training',
    title: (globalThis.PlatformLanguage?.text("training","m_de9da7671834b2","Training") ?? "Training"),
    icon: 'fa-graduation-cap',
    order: 58,
    fullBleed: true,
    access: { applicationsAny: ['management', 'field'] },
    mount: mountTraining
  });
})();
