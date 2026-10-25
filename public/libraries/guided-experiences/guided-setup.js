/* public/libraries/guided-experiences/guided-setup.js
 * The setup players for guided experiences (docs/architecture/guided-experiences.md):
 *
 * - `modal`: the steps in a sheet in front of a dimmed page.
 * - `agentic`: the same sheet with the agent beside it. The widget for each step is on the left and rises into
 *   place as the steps change; the conversation is on the right. The agent's lines for the known steps are
 *   programmatic (the definition's `say`), written into the person's own project conversation. If the person types,
 *   the real assistant answers in that conversation knowing the step and the choices so far, then the scripted steps
 *   carry on. When it finishes, the sheet closes and the conversation flies to the right to become the project's
 *   agent tray, which holds the same conversation.
 *
 * Step widgets are registered by id (`registerWidget`) and are given the step's options (data from the server) and
 * the selections so far; they report a selection patch, whether it is complete, and a plain summary of it.
 */
(function(root){
  'use strict';
  const document = root.document;
  const G = () => root.FirstMateGuides;
  const clean = (value) => String(value ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const L = (copy, fallback) => G()?.L ? G().L(copy, fallback) : (copy?.text ?? fallback);
  /** Visible copy: escaped, and editable in place for a development editor (guided-experiences.js `copyHtml`). */
  const H = (copy, fallback) => G()?.copyHtml ? G().copyHtml(copy, fallback) : esc(L(copy, fallback));
  const reduced = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced() ? 0 : ms));
  const money = (value) => { try { return new Intl.NumberFormat(undefined, { style:'currency', currency:'USD' }).format(Number(value) || 0); } catch (_) { return '$' + (Number(value) || 0).toFixed(2); } };
  const widgets = new Map();

  const css = `
    .gxs,.gxs *,.gxs *::before,.gxs *::after{box-sizing:border-box}
    .gxs [hidden]{display:none!important}
    .gxs-settled .gxs-card,.gxs-settled .gxs-rule{animation:none}
    .gxs{position:fixed;inset:0;z-index:2147483250;display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828}
    .gxs-scrim{position:absolute;inset:0;background:rgba(16,24,40,.55);backdrop-filter:blur(3px);animation:gxsFade .35s ease both}
    .gxs-sheet{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 360px;width:min(1120px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));background:#fff;border-radius:20px;box-shadow:0 40px 100px rgba(16,24,40,.45);overflow:hidden;animation:gxsRise .5s cubic-bezier(.22,1,.36,1) both}
    .gxs[data-kind=modal] .gxs-sheet{grid-template-columns:minmax(0,1fr);width:min(820px,calc(100vw - 32px))}
    .gxs[data-kind=modal] .gxs-chat{display:none}
    @keyframes gxsFade{from{opacity:0}to{opacity:1}}
    @keyframes gxsRise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
    .gxs-widget{display:flex;flex-direction:column;min-width:0;min-height:0;background:linear-gradient(180deg,#fcfcfd,#fff 180px)}
    .gxs-head{display:flex;align-items:center;gap:12px;padding:16px 20px 8px}
    .gxs-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.08);border-radius:999px;padding:5px 11px;white-space:nowrap}
    .gxs-progress{display:flex;gap:6px;margin:0 auto 0 4px;padding:0;list-style:none;flex:1;max-width:320px}
    .gxs-progress li{flex:1;height:4px;border-radius:2px;background:#eaecf0;overflow:hidden}
    .gxs-progress li i{display:block;height:100%;width:0;background:var(--primary,#d93025);transition:width .5s cubic-bezier(.22,1,.36,1)}
    .gxs-progress li.done i,.gxs-progress li.on i{width:100%}
    .gxs-progress li.on i{opacity:.55}
    .gxs-icon{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:#667085;cursor:pointer;font-size:18px;display:inline-grid;place-items:center}
    .gxs-icon:hover{background:#f2f4f7;color:#101828}
    .gxs-stage{position:relative;flex:1;min-height:0;overflow:hidden}
    .gxs-step{position:absolute;inset:0;overflow:auto;padding:8px 28px 24px;transition:transform .55s cubic-bezier(.22,1,.36,1),opacity .4s ease}
    .gxs-step.gxs-below{transform:translateY(48px);opacity:0}
    .gxs-step.gxs-above{transform:translateY(-48px);opacity:0;pointer-events:none}
    .gxs-step h2{margin:10px 0 4px;font-size:clamp(20px,2.4vw,26px);line-height:1.2;letter-spacing:-.02em;font-weight:780}
    .gxs-step>p.gxs-sub{margin:0 0 18px;color:#667085;max-width:60ch}
    .gxs-foot{display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid #f2f4f7;background:#fff}
    .gxs-foot .gxs-status{margin-right:auto;color:#667085;font-size:12.5px;min-height:18px}
    .gxs-foot .gxs-status.err{color:#b42318}
    .gxs-btn{height:40px;padding:0 16px;border-radius:11px;border:1px solid #d0d5dd;background:#fff;color:#344054;font:inherit;font-weight:650;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:transform .12s,background .15s,opacity .2s}
    .gxs-btn:hover{background:#f9fafb}.gxs-btn:active{transform:scale(.98)}
    .gxs-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff;box-shadow:0 6px 16px rgba(var(--primary-rgb,217,48,37),.25)}
    .gxs-btn.primary:hover{filter:brightness(1.05)}
    .gxs-btn.ghost{border-color:transparent;color:#667085}
    .gxs-btn:disabled{opacity:.45;cursor:default;transform:none}
    .gxs-btn:focus-visible,.gxs-icon:focus-visible,.gxs-card:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gxs-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:gxsSpin .7s linear infinite}
    @keyframes gxsSpin{to{transform:rotate(360deg)}}
    .gxs-confirm{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;font-size:13px;color:#344054}
    .gxs-confirm>span{flex:1 1 auto;min-width:0;line-height:1.4}
    .gxs-confirm .gxs-btn{flex:none;white-space:nowrap}
    @media(max-width:640px){.gxs-confirm{flex-wrap:wrap;row-gap:8px}.gxs-confirm>span{flex-basis:100%}.gxs-confirm>span+.gxs-btn{margin-left:auto}}
    /* Chat */
    .gxs-chat{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;background:#fff;border-left:1px solid #eaecf0}
    .gxs-assistant{flex:1;min-height:0;display:flex;flex-direction:column}
    .gxs-assistant>.fma-drawer{flex:1;min-height:0}
    .gxs-chat .fma-head{padding-right:52px}
    .gxs-chat-handle{display:none}
    .gxs-close{position:absolute;top:10px;right:10px;z-index:5;width:36px;height:36px;border:0;border-radius:10px;background:rgba(255,255,255,.9);color:#475467;cursor:pointer;display:inline-grid;place-items:center;font-size:18px;transition:background .15s,color .15s}
    .gxs-close:hover{background:#f2f4f7;color:#101828}
    .gxs-close:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gxs-close .gxs-x{font-size:24px;line-height:1;font-weight:400}
    @keyframes gxsMsg{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    /* Widgets */
    .gxs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));grid-auto-rows:1fr;gap:14px}
    .gxs-grid .gxs-card{display:flex;flex-direction:column;align-items:stretch;min-height:150px}
    .gxs-logo{display:flex;align-items:center;height:64px;padding-right:28px}
    .gxs-logo img{display:block;max-width:100%;max-height:48px;width:auto;height:auto;object-fit:contain}
    .gxs-card .gxs-meta{margin-top:auto}
    .gxs-card{position:relative;text-align:left;border:1.5px solid #eaecf0;border-radius:16px;background:#fff;padding:18px;cursor:pointer;font:inherit;color:inherit;transition:border-color .2s,box-shadow .2s,transform .2s;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(16,24,40,.08)}
    .gxs-card[aria-pressed=true]{border-color:var(--brand,var(--primary,#d93025));box-shadow:0 0 0 3px color-mix(in srgb,var(--brand,#d93025) 18%,transparent)}
    .gxs-wordmark{display:flex;align-items:center;min-height:64px;font-weight:900;font-size:clamp(20px,2.2vw,27px);line-height:1.05;letter-spacing:-.03em;color:var(--brand,#101828);padding-right:26px}
    .gxs-card small{display:block;color:#667085;font-size:12.5px}
    .gxs-tick{position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;color:#fff;font-size:12px;transition:background .2s,border-color .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}
    .gxs-card[aria-pressed=true] .gxs-tick,.gxs-row[aria-checked=true] .gxs-tick{background:var(--brand,var(--primary,#d93025));border-color:var(--brand,var(--primary,#d93025));transform:scale(1.08)}
    .gxs-allbar{display:flex;align-items:center;gap:10px;margin:0 0 14px}
    .gxs-chip{height:30px;padding:0 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;font:inherit;font-size:12.5px;font-weight:650;color:#344054;cursor:pointer}
    .gxs-chip[aria-pressed=true]{background:#101828;border-color:#101828;color:#fff}
    .gxs-brand{margin:0 0 18px}
    .gxs-brand h3{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:15px}
    .gxs-brand h3 b{color:var(--brand);font-weight:900;letter-spacing:-.02em}
    .gxs-brand h3 .gxs-chip{margin-left:auto}
    .gxs-row{position:relative;display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1.5px solid #eaecf0;border-radius:12px;background:#fff;padding:10px 44px 10px 12px;margin:0 0 8px;font:inherit;color:inherit;cursor:pointer;transition:border-color .2s,background .2s}
    .gxs-row[aria-checked=true]{border-color:var(--brand,var(--primary,#d93025));background:color-mix(in srgb,var(--brand,#d93025) 4%,#fff)}
    .gxs-row .gxs-tick{top:50%;margin-top:-12px}
    .gxs-row strong{font-weight:650}.gxs-row em{font-style:normal;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#667085;background:#f2f4f7;border-radius:6px;padding:2px 6px}
    .gxs-row .gxs-price{margin-left:auto;color:#475467;font-variant-numeric:tabular-nums}
    .gxs-star{border:0;background:transparent;color:#d0d5dd;font-size:16px;cursor:pointer;padding:2px}
    .gxs-star[aria-pressed=true]{color:#f59e0b}
    .gxs-rule{border:1px solid #eaecf0;border-radius:14px;background:#fff;margin:0 0 10px;overflow:hidden;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-rule>button{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;padding:14px 16px;font:inherit;text-align:left;cursor:pointer;color:inherit}
    .gxs-rule>button strong{flex:1}
    .gxs-rule .gxs-qty{font-variant-numeric:tabular-nums;font-weight:700;color:#101828}
    .gxs-rule .gxs-caret{transition:transform .3s;color:#98a2b3}
    .gxs-rule[open-rule=true] .gxs-caret{transform:rotate(90deg)}
    .gxs-rule-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.22,1,.36,1)}
    .gxs-rule[open-rule=true] .gxs-rule-body{grid-template-rows:1fr}
    .gxs-rule-body>div{overflow:hidden;padding:0 16px}
    .gxs-rule[open-rule=true] .gxs-rule-body>div{padding:0 16px 16px}
    .gxs-eq{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0}
    .gxs-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#eef4ff;color:#3538cd;font-size:12.5px;font-weight:650}
    .gxs-pill b{font-variant-numeric:tabular-nums;color:#101828}
    .gxs-op{color:#98a2b3;font-weight:700}
    .gxs-seg{display:inline-flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .gxs-manual{font-size:11px;font-weight:700;color:#b54708;background:#fffaeb;border-radius:6px;padding:2px 7px}
    .gxs-table{width:100%;border-collapse:collapse;font-size:13px}
    .gxs-table th{text-align:left;color:#667085;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:14px 6px 6px}
    .gxs-table td{padding:7px 6px;border-top:1px solid #f2f4f7}
    .gxs-table td:last-child{text-align:right}
    .gxs-table input{width:96px;height:32px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;text-align:right;font:inherit;font-variant-numeric:tabular-nums}
    .gxs-table input:focus{outline:none;border-color:var(--primary,#d93025)}
    .gxs-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
    .gxs-inline input[type=number]{width:72px;height:32px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;font:inherit}
    .gxs-done{display:grid;place-items:center;text-align:center;padding:40px 10px;gap:10px}
    .gxs-done svg{width:84px;height:84px}
    .gxs-done circle{stroke:var(--primary,#d93025);stroke-width:4;fill:none;stroke-dasharray:240;stroke-dashoffset:240;animation:gxsDraw .7s ease forwards}
    .gxs-done path{stroke:var(--primary,#d93025);stroke-width:5;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:gxsDraw .45s .55s ease forwards}
    @keyframes gxsDraw{to{stroke-dashoffset:0}}
    .gxs-flying{position:fixed!important;z-index:2147483260;transition:left .6s cubic-bezier(.22,1,.36,1),top .6s cubic-bezier(.22,1,.36,1),width .6s cubic-bezier(.22,1,.36,1),height .6s cubic-bezier(.22,1,.36,1),border-radius .6s,opacity .25s;border-radius:20px;box-shadow:0 30px 80px rgba(16,24,40,.35);overflow:hidden}
    .gxs.gxs-leaving .gxs-scrim{opacity:0;transition:opacity .45s}
    .gxs.gxs-leaving .gxs-widget{opacity:0;transform:translateX(-30px);transition:opacity .35s,transform .45s}
    .gxs.gxs-leaving[data-kind=modal] .gxs-sheet{opacity:0;transform:scale(.97);transition:opacity .3s,transform .3s}
    @media(max-width:760px){
      .gxs-sheet{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;width:100vw;height:100dvh;border-radius:0}
      .gxs-chat{border-left:0;border-top:1px solid #eaecf0;max-height:48px;overflow:hidden;transition:max-height .35s cubic-bezier(.22,1,.36,1)}
      .gxs-chat[data-open=true]{max-height:58dvh}
      .gxs-chat-handle{display:flex;align-items:center;gap:8px;flex:none;height:48px;padding:0 16px;border:0;background:#fff;font:inherit;font-weight:700;color:#101828;cursor:pointer;text-align:left}
      .gxs-chat-handle .gxs-chevron{margin-left:auto;transition:transform .3s}
      .gxs-chat[data-open=true] .gxs-chat-handle .gxs-chevron{transform:rotate(180deg)}
      .gxs-close{top:6px;right:6px}
      .gxs-step{padding:6px 16px 20px}
      .gxs-head{padding:12px 12px 6px}
      .gxs-badge span{display:none}
      .gxs-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .gxs-card{padding:12px}.gxs-grid .gxs-card{min-height:124px}.gxs-wordmark{min-height:46px;font-size:19px}.gxs-logo{height:48px}.gxs-logo img{max-height:36px}
      .gxs-foot{padding:10px 12px}
    }
    @media(prefers-reduced-motion:reduce){.gxs *,.gxs{animation:none!important;transition:none!important}}
  `;

  function injectCss(){ G()?.injectCss ? G().injectCss('gx-setup-css', css) : null; }

  // ── The player ─────────────────────────────────────────────────────────
  function player(kind){
    return (ctx) => new Promise((resolve) => {
      injectCss();
      const { experience, track } = ctx;
      const here = ctx.where();
      const steps = array(experience.steps);
      const orgId = clean(root.__APP?.userOrgId);
      // The agent is the platform assistant itself, in the person's own project conversation (the one the tray shows).
      let agentic = kind === 'agentic' && !!here.projectId && !!orgId && !!root.AssistantAPI && typeof root.PlatformAssistant?.mountProject === 'function';
      const selections = { ...object(experience.progress?.data) };
      const summaries = {};
      let index = Math.max(0, steps.findIndex((step) => step.id === experience.progress?.step_id));
      if (index >= steps.length) index = 0;
      let mounted = null, busy = false, closed = false, assistant = null;

      const host = document.createElement('div');
      host.className = 'gxs'; host.dataset.kind = agentic ? 'agentic' : 'modal'; host.setAttribute('data-fmr-ignore', ''); host.setAttribute('data-gx-setup', experience.id);
      host.innerHTML = `<div class="gxs-scrim"></div>
        <section class="gxs-sheet" role="dialog" aria-modal="true" aria-label="${esc(L(experience.title))}">
          <button type="button" class="gxs-close" data-gxs="close" aria-label="${esc(L('gx_ui_close_setup', 'Close setup'))}" title="${esc(L('gx_ui_close_setup', 'Close setup'))}"><span class="gxs-x" aria-hidden="true">&times;</span></button>
          <div class="gxs-widget">
            <header class="gxs-head"><span class="gxs-badge"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>${H(experience.title)}</span></span>
              <ol class="gxs-progress" aria-hidden="true">${steps.map(() => '<li><i></i></li>').join('')}</ol></header>
            <div class="gxs-stage"></div>
            <footer class="gxs-foot"><span class="gxs-status" role="status"></span>
              <button type="button" class="gxs-btn ghost" data-gxs="back">${H('gx_ui_back', 'Back')}</button>
              <button type="button" class="gxs-btn ghost" data-gxs="skip">${H('gx_ui_skip_step', 'Skip step')}</button>
              <button type="button" class="gxs-btn primary" data-gxs="next"></button></footer>
          </div>
          <aside class="gxs-chat" aria-label="${esc(L('gx_ui_agent', 'Agent'))}">
            <button type="button" class="gxs-chat-handle" data-gxs="toggleChat" aria-expanded="false"><i class="fas fa-sparkles" aria-hidden="true"></i>${H('gx_ui_agent', 'Agent')}<i class="fas fa-chevron-up gxs-chevron" aria-hidden="true"></i></button>
            <div class="gxs-assistant"></div>
          </aside>
        </section>`;
      document.body.appendChild(host);
      const $ = (selector) => host.querySelector(selector);
      const stage = $('.gxs-stage'), status = $('.gxs-status'), chat = $('.gxs-chat');
      const previousFocus = document.activeElement;

      // The agent: a platform assistant instance running this setup as a preprogrammed workflow.
      if (agentic) {
        try {
          assistant = root.PlatformAssistant.mountProject($('.gxs-assistant'), {
            orgId, projectId: here.projectId,
            getContext: () => ({ surface: 'project', projectId: here.projectId, tab: here.tab, tray: 'guided_setup' }),
            workflow: {
              // Typing hands this turn to the real assistant, which is told the step and choices (guidedConversationContext).
              onUserMessage: (text) => { track('question', { step_id: steps[index]?.id, properties: { length: String(text).length } }); return false; },
              onReply: () => { if (!closed) say([L('gx_ui_back_to_step', 'Whenever you’re ready, carry on with the step on the left.')], '', ''); },
              onChoice: (id) => { if (id === 'continue' && !closed) next(false); }
            }
          });
        } catch (error) {
          console.warn('The setup could not open the assistant; it continues without it.', error);
          agentic = false; host.dataset.kind = 'modal'; assistant = null;
        }
      }
      /** The agent's scripted lines, shown in the assistant as it would type them. */
      /** `at` is the step (or 'done') whose lines these are: their keys match the ones the server stores. */
      function say(lines, choice, at){
        if (!assistant || closed) return Promise.resolve();
        if (choice) assistant.post({ role: 'user', content: choice, data: { source: 'guided_experience' } });
        const keys = at === 'done' ? array(experience.completion?.say) : array(steps.find((entry) => entry.id === at)?.say);
        return assistant.say(lines.map((content, i) => ({ content, data: { source: 'guided_experience', ...(at ? { line_key: `${experience.id}:${at}:say:${i}` } : {}), ...(keys[i]?.key ? { copy_key: keys[i].key } : {}) } })));
      }
      /** The scripted turn, written into the project conversation so a reload and the agent tray hold it too. */
      function persist(body){
        if (!agentic) return Promise.resolve();
        return ctx.api.conversation(experience.id, { project_id: here.projectId, tab: here.tab, ...body }).catch((error) => console.warn('Setup conversation not saved.', error));
      }
      $('[data-gxs=toggleChat]').addEventListener('click', () => { const open = chat.dataset.open !== 'true'; chat.dataset.open = String(open); $('[data-gxs=toggleChat]').setAttribute('aria-expanded', String(open)); });

      // Steps
      function progress(){ host.querySelectorAll('.gxs-progress li').forEach((li, i) => { li.classList.toggle('done', i < index); li.classList.toggle('on', i === index); }); }
      function footer(){
        const step = steps[index];
        const last = index === steps.length - 1;
        $('[data-gxs=back]').hidden = index === 0;
        $('[data-gxs=skip]').hidden = step.required !== false || last;
        const next = $('[data-gxs=next]');
        next.innerHTML = busy ? `<span class="gxs-spin" aria-hidden="true"></span>${H('gx_ui_building', 'Building…')}` : (last ? H('gx_ui_finish', 'Build my price book') : H('gx_ui_continue', 'Continue'));
        next.disabled = busy || (step.required !== false && mounted?.valid?.() === false);
      }
      function show(to, direction = 1){
        const step = steps[to];
        const old = stage.querySelector('.gxs-step:not(.gxs-above)');
        mounted?.destroy?.();
        const el = document.createElement('div');
        el.className = 'gxs-step' + (old && !reduced() ? (direction > 0 ? ' gxs-below' : ' gxs-above') : ''); el.dataset.gxStep = step.id;
        el.innerHTML = `<h2>${H(step.title)}</h2>${step.subtitle ? `<p class="gxs-sub">${H(step.subtitle)}</p>` : ''}<div class="gxs-body"></div>`;
        stage.appendChild(el);
        index = to;
        const widget = widgets.get(step.widget);
        mounted = widget ? widget.render(el.querySelector('.gxs-body'), { step, options: object(step.options), selections, L, esc, money, change(patch, summary){ Object.assign(selections, patch); if (summary !== undefined) summaries[step.id] = summary; status.textContent = ''; footer(); } }) : null;
        if (!widget) el.querySelector('.gxs-body').textContent = L('gx_ui_widget_missing', 'This step cannot be shown here.');
        if (old) {
          old.classList.add(direction > 0 ? 'gxs-above' : 'gxs-below');
          requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('gxs-below', 'gxs-above')));
          setTimeout(() => old.remove(), reduced() ? 0 : 560);
        }
        progress(); footer();
        setTimeout(() => el.querySelector('button,input')?.focus?.({ preventScroll: true }), reduced() ? 0 : 450);
        track('step_view', { step_id: step.id, selections });
      }
      async function enter(to, direction, choice){
        show(to, direction);
        if (direction > 0) {
          const lines = array(steps[to].say).map((copy) => L(copy));
          persist({ step_id: steps[to].id, choice: choice || '' });
          if (lines.length || choice) say(lines, choice, steps[to].id);
        }
      }
      /**
       * Moves on at once; the event goes to the server in the background. Only a step whose next step depends on the
       * choices (branches, decided on the server) waits for the answer. A burst of presses counts once.
       */
      let movingUntil = 0;
      // Working in the step between two presses makes the second one deliberate.
      ['input', 'change', 'pointerdown'].forEach((name) => stage.addEventListener(name, () => { movingUntil = 0; }, true));
      async function next(skip = false){
        if (busy || closed || Date.now() < movingUntil) return;
        // A second press within a moment of the first is the same press: a burst never skips a step.
        movingUntil = Date.now() + 250;
        const step = steps[index];
        if (!skip && step.required !== false && mounted?.valid?.() === false) return;
        const choice = skip ? '' : clean(summaries[step.id] || mounted?.summary?.() || '');
        const sent = track(skip ? 'step_skip' : 'step_done', { step_id: step.id, selections });
        if (index === steps.length - 1) return finish(choice);
        let to = index + 1;
        if (step.next && typeof step.next === 'object') {
          busy = true; footer();
          const target = clean((await sent)?.next_step);
          busy = false;
          const found = steps.findIndex((entry) => entry.id === target);
          if (found > index) to = found;
        }
        if (!closed) enter(to, 1, choice);
      }
      async function finish(choice){
        busy = true; footer(); status.textContent = ''; status.classList.remove('err');
        try {
          const result = await ctx.api.complete(experience.id, { selections, tab: here.tab, project_id: here.projectId, idempotency_key: `${experience.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
          const value = object(result.result);
          stage.querySelectorAll('.gxs-step').forEach((el) => el.remove());
          mounted?.destroy?.(); mounted = null;
          const done = document.createElement('div'); done.className = 'gxs-step';
          done.innerHTML = `<div class="gxs-done"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="38"/><path d="M26 43l11 11 21-23"/></svg><h2>${H('gx_ui_done_title', 'Your price book is ready')}</h2><p class="gxs-sub">${esc(value.items ? L('gx_ui_done_items', 'Products added') + ': ' + value.items : '')}</p></div>`;
          stage.appendChild(done);
          host.querySelectorAll('.gxs-progress li').forEach((li) => { li.classList.add('done'); li.classList.remove('on'); });
          $('.gxs-foot').style.visibility = 'hidden';
          const lines = array(experience.completion?.say).map((copy) => L(copy));
          persist({ phase: 'done', choice: choice || '' });
          await say(lines, choice, 'done');
          await wait(900);
          const handoff = agentic && array(experience.completion?.then).some((entry) => entry.handoff === 'assistant_tray');
          await close(handoff ? 'handoff' : 'plain');
          resolve({ status: 'completed', result: value });
        } catch (error) {
          busy = false; footer();
          status.classList.add('err');
          status.textContent = clean(error?.message) || L('gx_ui_finish_failed', 'That didn’t save. Try again.');
        }
      }
      function confirmSkip(){
        const foot = $('.gxs-foot');
        if (busy || foot.querySelector('.gxs-confirm')) return;
        const bar = document.createElement('div'); bar.className = 'gxs-confirm';
        bar.innerHTML = `<span>${H('gx_ui_skip_setup_q', 'Skip the setup? Materials will use typical products until you set up your price book.')}</span><button type="button" class="gxs-btn" data-gxs="keep">${H('gx_ui_keep_going', 'Keep going')}</button><button type="button" class="gxs-btn primary" data-gxs="dismiss">${H('gx_ui_skip_setup', 'Skip setup')}</button>`;
        [...foot.children].forEach((child) => { child.dataset.gxsHidden = String(child.hidden); child.hidden = true; });
        foot.prepend(bar);
        bar.querySelector('[data-gxs=keep]').focus();
      }
      function keepGoing(){
        const foot = $('.gxs-foot');
        foot.querySelector('.gxs-confirm')?.remove();
        [...foot.children].forEach((child) => { child.hidden = child.dataset.gxsHidden === 'true'; delete child.dataset.gxsHidden; });
        footer();
      }
      host.addEventListener('click', (event) => {
        const action = event.target.closest?.('[data-gxs]')?.dataset.gxs;
        if (action === 'next') next(false);
        else if (action === 'skip') next(true);
        else if (action === 'back' && index > 0) { track('back', { step_id: steps[index].id }); show(index - 1, -1); }
        else if (action === 'close') confirmSkip();
        else if (action === 'keep') keepGoing();
        else if (action === 'dismiss') { (async () => { await track('dismiss', { step_id: steps[index]?.id, selections }); await close('plain'); resolve({ status: 'dismissed' }); })(); }
      });
      const onKey = (event) => { if (event.key === 'Escape' && !closed) { event.preventDefault(); event.stopPropagation(); confirmSkip(); } };
      document.addEventListener('keydown', onKey, true);

      /** Closes the sheet. `handoff` flies the conversation to the project's agent tray, which opens with it. */
      async function close(mode){
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        mounted?.destroy?.();
        if (mode === 'handoff') await flyToTray();
        else if (!reduced()) { host.classList.add('gxs-leaving'); await wait(320); }
        // The tray has its own instance on the same conversation; this one goes with the sheet.
        try { assistant?.destroy?.(); } catch (_) {}
        assistant = null;
        host.remove();
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
      }
      async function flyToTray(){
        const from = chat.getBoundingClientRect();
        const content = document.querySelector('#rOverlay .fm-project-content') || document.querySelector('.fm-project-content');
        const box = content?.getBoundingClientRect();
        const width = box ? Math.min(380, root.innerWidth <= 700 ? box.width : box.width * 0.45) : Math.min(380, root.innerWidth);
        const to = box ? { left: box.right - width, top: box.top, width, height: box.height } : { left: root.innerWidth - width, top: 0, width, height: root.innerHeight };
        // Open the real tray underneath; it loads the same project conversation.
        const tab = document.querySelector('#rOverlay .fm-project-tray-tabs [data-tray="agent"]') || document.querySelector('.fm-project-tray-tabs [data-tray="agent"]');
        if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
        host.dataset.handoff = 'true';
        if (reduced()) return;
        host.classList.add('gxs-leaving');
        const flying = chat;
        Object.assign(flying.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, maxHeight: 'none' });
        flying.classList.add('gxs-flying');
        document.body.appendChild(flying);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        Object.assign(flying.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: '0px' });
        await wait(640);
        flying.style.opacity = '0';
        await wait(260);
        flying.remove();
      }

      enter(index, 1, '');
      // The very first time, the scripted greeting already ran in enter(); a resumed setup says where it left off.
    });
  }

  // ── Widgets ────────────────────────────────────────────────────────────
  function registerWidget(id, widget){ widgets.set(id, widget); }

  // Big logo-style manufacturer cards, multi-select, with "Use all".
  registerWidget('brand-cards', {
    render(el, { options, selections, change, L }){
      const brands = array(options.brands);
      const picked = new Set(array(selections.brands).filter((id) => brands.some((brand) => brand.id === id)));
      const draw = () => {
        el.innerHTML = `${options.allow_all !== false ? `<div class="gxs-allbar"><button type="button" class="gxs-chip" data-all aria-pressed="${picked.size === brands.length}">${H('gx_ui_use_all', 'Use all')}</button><span style="color:#667085;font-size:12.5px">${H('gx_ui_selected', 'Selected')}: ${picked.size}</span></div>` : ''}
          <div class="gxs-grid">${brands.map((brand, i) => `<button type="button" class="gxs-card" style="--brand:${esc(brand.color)};animation-delay:${i * 60}ms" aria-pressed="${picked.has(brand.id)}" data-brand="${esc(brand.id)}"><span class="gxs-tick"><i class="fas fa-check" aria-hidden="true"></i></span>${brand.logo ? `<span class="gxs-logo"><img src="${esc(brand.logo)}" alt="${esc(brand.name)}" loading="lazy" decoding="async" data-gxs-logo></span>` : `<span class="gxs-wordmark">${esc(brand.name)}</span>`}<span class="gxs-meta"><small>${esc(brand.tagline || '')}</small><small>${esc(array(brand.lines).length + ' ' + L('gx_ui_lines', 'shingle lines'))}</small></span></button>`).join('')}</div>`;
        // A logo that does not load gives way to the wordmark.
        el.querySelectorAll('img[data-gxs-logo]').forEach((img) => img.addEventListener('error', () => { const mark = document.createElement('span'); mark.className = 'gxs-wordmark'; mark.textContent = img.alt; img.closest('.gxs-logo').replaceWith(mark); }, { once: true }));
        report();
      };
      const report = () => change({ brands: brands.filter((brand) => picked.has(brand.id)).map((brand) => brand.id), region: clean(options.region?.id) }, picked.size === brands.length ? L('gx_ui_all_brands', 'All of them') : brands.filter((brand) => picked.has(brand.id)).map((brand) => brand.name).join(', '));
      el.addEventListener('click', (event) => {
        if (event.target.closest('[data-all]')) { if (picked.size === brands.length) picked.clear(); else brands.forEach((brand) => picked.add(brand.id)); draw(); return; }
        const id = event.target.closest('[data-brand]')?.dataset.brand;
        if (!id) return;
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        const card = event.target.closest('[data-brand]'); card.setAttribute('aria-pressed', String(picked.has(id)));
        const all = el.querySelector('[data-all]'); if (all) all.setAttribute('aria-pressed', String(picked.size === brands.length));
        const count = el.querySelector('.gxs-allbar span'); if (count) count.textContent = `${L('gx_ui_selected', 'Selected')}: ${picked.size}`;
        report();
      });
      draw(); setTimeout(() => el.classList.add('gxs-settled'), 900);
      return { valid: () => picked.size > 0, summary: () => picked.size === brands.length ? L('gx_ui_all_brands', 'All of them') : brands.filter((brand) => picked.has(brand.id)).map((brand) => brand.name).join(', ') };
    }
  });

  const TIER = { '3_tab': ['gx_tier_3tab', '3-tab'], architectural: ['gx_tier_arch', 'Architectural'], premium_architectural: ['gx_tier_premium', 'Premium'], impact_rated: ['gx_tier_impact', 'Impact rated'], designer: ['gx_tier_designer', 'Designer'] };
  // Product lines per chosen brand, include-all, and a star for the default.
  registerWidget('product-lines', {
    render(el, { options, selections, change, L }){
      const brands = array(options.brands).filter((brand) => array(selections.brands).includes(brand.id));
      const all = brands.flatMap((brand) => array(brand.lines));
      const known = new Set(all.map((line) => line.id));
      const chosen = new Set(array(selections.lines).filter((id) => known.has(id)));
      if (!chosen.size) all.filter((line) => line.popular).forEach((line) => chosen.add(line.id));
      if (!chosen.size && all[0]) chosen.add(all[0].id);
      let star = known.has(selections.default_line) && chosen.has(selections.default_line) ? selections.default_line : [...chosen][0] || '';
      const summary = () => all.filter((line) => chosen.has(line.id)).map((line) => line.name + (line.id === star ? ' ★' : '')).join(', ');
      const report = () => { if (!chosen.has(star)) star = [...chosen][0] || ''; change({ lines: all.filter((line) => chosen.has(line.id)).map((line) => line.id), default_line: star }, summary()); };
      const draw = () => {
        el.innerHTML = `<div class="gxs-allbar"><button type="button" class="gxs-chip" data-all aria-pressed="${chosen.size === all.length}">${H('gx_ui_include_all', 'Include all')}</button></div>` + brands.map((brand) => `<section class="gxs-brand" style="--brand:${esc(brand.color)}"><h3><b>${esc(brand.name)}</b><button type="button" class="gxs-chip" data-brand-all="${esc(brand.id)}" aria-pressed="${array(brand.lines).every((line) => chosen.has(line.id))}">${H('gx_ui_include_all', 'Include all')}</button></h3>${array(brand.lines).map((line) => `<div class="gxs-row" role="checkbox" tabindex="0" aria-checked="${chosen.has(line.id)}" data-line="${esc(line.id)}"><button type="button" class="gxs-star" data-star="${esc(line.id)}" aria-pressed="${line.id === star}" aria-label="${esc(L('gx_ui_make_default', 'Use first on new lists'))}" title="${esc(L('gx_ui_make_default', 'Use first on new lists'))}"><i class="fas fa-star" aria-hidden="true"></i></button><strong>${esc(line.name.replace(brand.name + ' ', ''))}</strong>${TIER[line.tier] ? `<em>${H(TIER[line.tier][0], TIER[line.tier][1])}</em>` : ''}<span class="gxs-price">${esc(money(line.price))} / ${esc(line.unit)}</span><span class="gxs-tick"><i class="fas fa-check" aria-hidden="true"></i></span></div>`).join('')}</section>`).join('');
        report();
      };
      const toggle = (id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); draw(); };
      el.addEventListener('click', (event) => {
        const starred = event.target.closest('[data-star]');
        if (starred) { event.stopPropagation(); star = starred.dataset.star; chosen.add(star); draw(); return; }
        if (event.target.closest('[data-all]')) { if (chosen.size === all.length) chosen.clear(); else all.forEach((line) => chosen.add(line.id)); draw(); return; }
        const brandAll = event.target.closest('[data-brand-all]')?.dataset.brandAll;
        if (brandAll) { const lines = array(brands.find((brand) => brand.id === brandAll)?.lines); const every = lines.every((line) => chosen.has(line.id)); lines.forEach((line) => every ? chosen.delete(line.id) : chosen.add(line.id)); draw(); return; }
        const row = event.target.closest('[data-line]'); if (row) toggle(row.dataset.line);
      });
      el.addEventListener('keydown', (event) => { const row = event.target.closest('[data-line]'); if (row && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); toggle(row.dataset.line); el.querySelector(`[data-line="${CSS.escape(row.dataset.line)}"]`)?.focus(); } });
      draw(); setTimeout(() => el.classList.add('gxs-settled'), 900);
      return { valid: () => chosen.size > 0, summary };
    }
  });

  /** Evaluates a price book formula over the sample roof, for the worked example. Display only. */
  function sampleValue(formula, sample){
    const tokens = String(formula || '').match(/[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?|[-+*/()]/g) || [];
    let i = 0;
    const factor = () => { const t = tokens[i++]; if (t === '(') { const v = expr(); i++; return v; } if (t === '-') return -factor(); if (/^\d/.test(t || '')) return Number(t); return Number(sample[t]) || 0; };
    const term = () => { let v = factor(); while (tokens[i] === '*' || tokens[i] === '/') { const op = tokens[i++], r = factor(); v = op === '*' ? v * r : (r ? v / r : 0); } return v; };
    const expr = () => { let v = term(); while (tokens[i] === '+' || tokens[i] === '-') { const op = tokens[i++], r = term(); v = op === '+' ? v + r : v - r; } return v; };
    try { return Math.max(0, expr()); } catch (_) { return 0; }
  }
  // How a roof's measurements become a materials list: plain cards, a worked example, waste and ice & water width.
  registerWidget('measurement-rules', {
    render(el, { options, selections, change, L }){
      const sample = object(options.sample), rules = array(options.rules);
      let waste = selections.waste ?? object(options.waste).default ?? 'roof';
      let width = selections.ice_eave_width ?? object(options.ice_eave_width).default ?? 6;
      const open = new Set([rules[0]?.id]);
      const unitWord = { sq: L('gx_unit_sq', 'squares'), lf: L('gx_unit_lf', 'ft'), ea: L('gx_unit_ea', 'each'), sheet: L('gx_unit_sheet', 'sheets'), job: L('gx_unit_job', 'per job'), '%': '%' };
      const formulaFor = (rule) => rule.id === 'ice_water' && rule.formula ? rule.formula.replace(/eavesLf\s*\*\s*\d+(\.\d+)?/, `eavesLf * ${width}`) : rule.formula;
      const quantity = (rule) => {
        if (rule.manual || !rule.formula) return '';
        if (rule.id === 'waste') return waste === 'roof' ? L('gx_ui_waste_auto_short', 'auto') : waste + '%';
        let value = sampleValue(formulaFor(rule), sample);
        if (rule.include_waste) value *= 1 + (waste === 'roof' ? 12 : Number(waste)) / 100;
        return `${Math.round(value * 10) / 10} ${unitWord[rule.unit] || rule.unit}`;
      };
      const eq = (rule) => {
        const measured = array(rule.measurements);
        if (!measured.length) return '';
        return `<div class="gxs-eq">${measured.map((m, i) => `${i ? `<span class="gxs-op">${new RegExp('-\\s*' + m.key + '\\b').test(rule.formula || '') ? '−' : '+'}</span>` : ''}<span class="gxs-pill">${esc(m.label)} <b>${esc(sample[m.key] ?? 0)}</b></span>`).join('')}</div>`;
      };
      const controls = (rule) => {
        if (rule.id === 'waste' || rule.id === 'field_shingles') return `<div class="gxs-inline"><span>${H('gx_ui_waste_label', 'Waste for cutting')}</span></div><div class="gxs-seg">${['roof', ...array(object(options.waste).options)].map((value) => `<button type="button" class="gxs-chip" data-waste="${esc(value)}" aria-pressed="${String(value) === String(waste)}">${esc(value === 'roof' ? L('gx_ui_waste_auto', 'Work it out from each roof') : value + '%')}</button>`).join('')}</div>`;
        if (rule.id === 'ice_water') return `<div class="gxs-inline"><span>${H('gx_ui_ice_label', 'How far up from the eaves')}</span></div><div class="gxs-seg">${array(object(options.ice_eave_width).options).map((value) => `<button type="button" class="gxs-chip" data-width="${esc(value)}" aria-pressed="${Number(value) === Number(width)}">${esc(Number(value) === 6 ? L('gx_ui_ice_6', '6 ft (two rows)') : Number(value) === 3 ? L('gx_ui_ice_3', '3 ft (one row)') : L('gx_ui_ice_0', 'None'))}</button>`).join('')}</div>`;
        return '';
      };
      const draw = () => {
        el.innerHTML = `<p style="margin:0 0 12px;color:#475467">${H('gx_ui_sample_intro', 'Worked out on a sample roof of')} <b>${esc(sample.roofSquares || 0)} ${esc(unitWord.sq)}</b>.</p>` + rules.map((rule, i) => `<div class="gxs-rule" open-rule="${open.has(rule.id)}" style="animation-delay:${i * 40}ms"><button type="button" data-rule="${esc(rule.id)}" aria-expanded="${open.has(rule.id)}"><i class="fas fa-chevron-right gxs-caret" aria-hidden="true"></i><strong>${esc(rule.label)}</strong>${rule.manual ? `<span class="gxs-manual">${H('gx_ui_by_hand', 'Counted by hand')}</span>` : `<span class="gxs-qty">${esc(quantity(rule))}</span>`}</button><div class="gxs-rule-body"><div><p style="margin:0;color:#475467">${esc(rule.explanation)}</p>${eq(rule)}${controls(rule)}</div></div></div>`).join('');
      };
      const report = () => change({ waste, ice_eave_width: Number(width) }, `${L('gx_ui_waste_label', 'Waste for cutting')}: ${waste === 'roof' ? L('gx_ui_waste_auto', 'Work it out from each roof') : waste + '%'}; ${L('gx_ui_ice_label', 'How far up from the eaves')}: ${width} ft`);
      el.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-rule]');
        if (toggle) { const id = toggle.dataset.rule; if (open.has(id)) open.delete(id); else open.add(id); const card = toggle.closest('.gxs-rule'); card.setAttribute('open-rule', String(open.has(id))); toggle.setAttribute('aria-expanded', String(open.has(id))); return; }
        const w = event.target.closest('[data-waste]'); if (w) { waste = w.dataset.waste === 'roof' ? 'roof' : Number(w.dataset.waste); draw(); report(); return; }
        const iw = event.target.closest('[data-width]'); if (iw) { width = Number(iw.dataset.width); draw(); report(); }
      });
      draw(); report(); setTimeout(() => el.classList.add('gxs-settled'), 900);
      return { valid: () => true };
    }
  });

  // What will be written, at the region's prices, every price editable; materials markup; labor on or off.
  registerWidget('price-review', {
    render(el, { options, selections, change, L }){
      const brands = array(options.brands).filter((brand) => array(selections.brands).includes(brand.id));
      const lines = brands.flatMap((brand) => array(brand.lines)).filter((line) => array(selections.lines).includes(line.id));
      const star = selections.default_line && lines.some((line) => line.id === selections.default_line) ? selections.default_line : lines[0]?.id;
      const primary = brands.find((brand) => array(brand.lines).some((line) => line.id === star)) || brands[0];
      const accessory = (role) => array(primary?.accessories).find((entry) => entry.role === role) || brands.flatMap((brand) => array(brand.accessories)).find((entry) => entry.role === role);
      const accessories = ['starter', 'hip_ridge', 'underlayment', 'ice_water', 'ridge_vent'].map(accessory).filter(Boolean);
      const seen = new Set(); const generic = array(options.generic).filter((entry) => { if (seen.has(entry.rule)) return false; seen.add(entry.rule); return true; });
      const baseMarkup = Number(options.markup) || 35;
      let markup = selections.markup ?? baseMarkup;
      let labor = selections.include_labor !== false;
      const prices = { ...object(selections.prices) };
      const priceOf = (item) => prices[item.id] ?? Math.round(item.price * (item.kind === 'labor' ? 1 : (1 + markup / 100) / (1 + baseMarkup / 100)) * 100) / 100;
      const groups = [[L('gx_ui_group_shingles', 'Shingles'), lines], [L('gx_ui_group_accessories', 'Accessories') + (primary ? ` (${primary.name})` : ''), accessories], [L('gx_ui_group_common', 'Common items'), generic], ...(labor ? [[L('gx_ui_group_labor', 'Labor and services'), array(options.labor)]] : [])];
      const draw = () => {
        el.innerHTML = `<div class="gxs-inline"><span>${H('gx_ui_region', 'Prices for')} <b>${esc(options.region?.label || '')}</b></span><label class="gxs-inline" style="margin:0 0 0 auto">${H('gx_ui_markup', 'Markup on materials')} <input type="number" min="0" max="300" step="1" data-markup value="${esc(markup)}">%</label><button type="button" class="gxs-chip" data-labor aria-pressed="${labor}">${H('gx_ui_include_labor', 'Include labor')}</button></div>
          <table class="gxs-table"><tbody>${(labor ? groups : groups.slice(0, 3)).map(([title, items]) => items.length ? `<tr><th colspan="2">${esc(title)}</th></tr>` + items.map((item) => `<tr><td>${esc(item.name)} <span style="color:#98a2b3">/ ${esc(item.unit)}</span></td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-price="${esc(item.id)}" value="${esc(priceOf(item))}" aria-label="${esc(item.name)}"></td></tr>`).join('') : '').join('')}</tbody></table>`;
      };
      const count = () => lines.length + accessories.length + generic.length + (labor ? array(options.labor).length : 0);
      const report = () => change({ prices, markup: Number(markup), include_labor: labor }, `${count()} ${L('gx_ui_products', 'products')}`);
      el.addEventListener('change', (event) => {
        const price = event.target.closest('[data-price]');
        if (price) { const value = Number(price.value); if (Number.isFinite(value) && value >= 0) prices[price.dataset.price] = value; report(); return; }
        if (event.target.closest('[data-markup]')) { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0 && value <= 300) { markup = value; draw(); } report(); }
      });
      el.addEventListener('click', (event) => { if (event.target.closest('[data-labor]')) { labor = !labor; groups.length = 3; if (labor) groups.push([L('gx_ui_group_labor', 'Labor and services'), array(options.labor)]); draw(); report(); } });
      draw(); report();
      return { valid: () => true };
    }
  });

  function register(){
    if (!G()?.registerKind) return false;
    G().registerKind('modal', player('modal'));
    G().registerKind('agentic', player('agentic'));
    return true;
  }
  if (!register()) root.addEventListener?.('DOMContentLoaded', register, { once: true });
  root.FirstMateGuidedSetup = { registerWidget, widgets: () => [...widgets.keys()], sampleValue };
})(window);
